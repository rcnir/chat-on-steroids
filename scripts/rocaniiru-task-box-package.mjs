import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import asarImport from '@electron/asar';
import plistImport from 'plist';
import { signMacOSBundle } from './macos-local-signing.mjs';

const asar = asarImport?.default ?? asarImport;
const plist = plistImport?.default ?? plistImport;
const scriptFile = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(scriptFile), '..');
const DEFAULT_APP = '/Applications/Chat On Steroids.app';
const ASAR_RELATIVE = path.join('Contents', 'Resources', 'app.asar');
const EXTENSION_RELATIVE = path.join('Contents', 'Resources', 'extension');
const PLIST_RELATIVE = path.join('Contents', 'Info.plist');
const MAIN_ENTRY = 'out/main/index.js';
const INTEGRITY_KEY = 'Resources/app.asar';

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

export function validateVersions({ sourceVersion, sourceExtensionVersion, installedVersion, installedExtensionVersion }) {
  const values = { sourceVersion, sourceExtensionVersion, installedVersion, installedExtensionVersion };
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Invalid ${name}: ${String(value)}`);
  }
  const distinct = new Set(Object.values(values));
  if (distinct.size !== 1) {
    throw new Error(
      `Refusing cross-version TASK BOX package: source=${sourceVersion}, source-extension=${sourceExtensionVersion}, ` +
      `installed=${installedVersion}, installed-extension=${installedExtensionVersion}`
    );
  }
  return sourceVersion;
}

export function assertExpectedBaselineFingerprint(actual, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error('An explicit 64-hex expected baseline fingerprint is required.');
  }
  if (actual !== expected.toLowerCase()) {
    throw new Error(`Installed app baseline mismatch: expected=${expected.toLowerCase()} actual=${actual}`);
  }
  return actual;
}

export function refuseIfInstalledAppRunning(running) {
  if (running) throw new Error('Chat On Steroids is running; refusing TASK BOX apply. Stop it manually and retry.');
}

export function assertOldClearDisabled(confirmed) {
  if (!confirmed) {
    throw new Error('Old standalone Chat On Steroids CLEAR must be explicitly confirmed disabled before apply.');
  }
}

function normalizedRelative(relative) {
  return relative.split(path.sep).join('/');
}

export function fingerprintTree(root, options = {}) {
  const excluded = new Set((options.exclude ?? []).map((entry) => normalizedRelative(entry)));
  const hash = createHash('sha256');
  if (!existsSync(root)) {
    hash.update('missing\0');
    return hash.digest('hex');
  }
  const visit = (directory, relativeDirectory = '') => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = normalizedRelative(relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name);
      if (excluded.has(relative)) continue;
      const absolute = path.join(directory, entry.name);
      const stats = lstatSync(absolute);
      const mode = (stats.mode & 0o777).toString(8);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0${mode}\0`);
        visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0${mode}\0`);
        hash.update(readFileSync(absolute));
        hash.update('\0');
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${relative}\0${mode}\0${readlinkSync(absolute)}\0`);
      } else {
        throw new Error(`Unsupported bundle entry while fingerprinting: ${relative}`);
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

export function validateSupportedAsarHeader(header) {
  const allowed = {
    directory: new Set(['files', 'unpacked']),
    file: new Set(['size', 'offset', 'integrity', 'unpacked', 'executable']),
    link: new Set(['link', 'unpacked'])
  };
  const visit = (node, label) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`Unsupported ASAR node at ${label}`);
    const kind = Object.prototype.hasOwnProperty.call(node, 'files')
      ? 'directory'
      : Object.prototype.hasOwnProperty.call(node, 'link')
        ? 'link'
        : 'file';
    for (const key of Object.keys(node)) {
      if (!allowed[kind].has(key)) throw new Error(`Unsupported ASAR metadata ${key} at ${label}`);
    }
    if ('unpacked' in node && typeof node.unpacked !== 'boolean') throw new Error(`Invalid ASAR unpacked flag at ${label}`);
    if (kind === 'directory') {
      if (!node.files || typeof node.files !== 'object' || Array.isArray(node.files)) throw new Error(`Invalid ASAR directory at ${label}`);
      for (const [name, child] of Object.entries(node.files)) visit(child, `${label}/${name}`);
      return;
    }
    if (kind === 'link') {
      if (typeof node.link !== 'string' || node.link.length === 0) throw new Error(`Invalid ASAR link at ${label}`);
      return;
    }
    if (!Number.isInteger(node.size) || node.size < 0 || (node.offset !== undefined && !/^\d+$/.test(node.offset))) {
      throw new Error(`Invalid ASAR file metadata at ${label}`);
    }
    const integrity = node.integrity;
    if (!integrity || integrity.algorithm !== 'SHA256' || typeof integrity.hash !== 'string' ||
        integrity.blockSize !== 4 * 1024 * 1024 || !Array.isArray(integrity.blocks)) {
      throw new Error(`Unsupported ASAR file integrity at ${label}`);
    }
    const integrityKeys = new Set(['algorithm', 'hash', 'blockSize', 'blocks']);
    for (const key of Object.keys(integrity)) {
      if (!integrityKeys.has(key)) throw new Error(`Unsupported ASAR integrity metadata ${key} at ${label}`);
    }
  };
  visit(header, 'root');
  return true;
}

export function asarHeaderIntegrity(archivePath) {
  const raw = asar.getRawHeader(archivePath);
  validateSupportedAsarHeader(raw.header);
  return { algorithm: 'SHA256', hash: sha256Bytes(raw.headerString) };
}

export function withUpdatedAsarIntegrity(plistObject, integrity) {
  if (!plistObject || typeof plistObject !== 'object' || Array.isArray(plistObject)) throw new Error('Invalid Info.plist object.');
  if (!integrity || integrity.algorithm !== 'SHA256' || !/^[a-f0-9]{64}$/i.test(integrity.hash)) {
    throw new Error('Invalid ASAR header integrity.');
  }
  const existing = plistObject.ElectronAsarIntegrity;
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error('Unsupported ElectronAsarIntegrity metadata.');
  }
  const target = existing?.[INTEGRITY_KEY];
  if (target !== undefined) {
    if (!target || typeof target !== 'object' || Array.isArray(target) || target.algorithm !== 'SHA256') {
      throw new Error('Unsupported existing app.asar integrity metadata.');
    }
    for (const key of Object.keys(target)) {
      if (key !== 'algorithm' && key !== 'hash') throw new Error(`Unsupported app.asar integrity field: ${key}`);
    }
  }
  return {
    ...plistObject,
    ElectronAsarIntegrity: {
      ...(existing ?? {}),
      [INTEGRITY_KEY]: { algorithm: 'SHA256', hash: integrity.hash.toLowerCase() }
    }
  };
}

function archiveRelative(entry) {
  return entry.replace(/^[/\\]+/, '').split(path.sep).join('/');
}

function asarEntryKind(entry) {
  if (entry && typeof entry === 'object' && 'files' in entry) return 'directory';
  if (entry && typeof entry === 'object' && 'link' in entry) return 'link';
  return 'file';
}

function localAsarMetadata(entry) {
  const kind = asarEntryKind(entry);
  if (kind === 'directory') return { kind, unpacked: entry.unpacked === true };
  if (kind === 'link') return { kind, unpacked: entry.unpacked === true, link: entry.link };
  return {
    kind,
    unpacked: entry.unpacked === true,
    executable: entry.executable === true,
    size: entry.size,
    integrity: entry.integrity
  };
}

function assertSameLocalAsarMetadata(before, after, relative) {
  if (JSON.stringify(localAsarMetadata(before)) !== JSON.stringify(localAsarMetadata(after))) {
    throw new Error(`Repacked unpacked ASAR metadata drifted: ${relative}`);
  }
}

function externalUnpackedPath(root, relative) {
  return path.join(root, ...relative.split('/'));
}

function assertReferencedUnpackedPayloadPreserved({ archivePath, nextArchive, currentUnpacked, nextUnpacked, listed, mainUnpacked }) {
  for (const relative of listed) {
    const before = asar.statFile(archivePath, relative, false);
    if (before.unpacked !== true) continue;
    const after = asar.statFile(nextArchive, relative, false);
    const kind = asarEntryKind(before);
    if (relative === MAIN_ENTRY && mainUnpacked) {
      if (kind !== 'file' || asarEntryKind(after) !== 'file' || after.unpacked !== true ||
          before.executable === true !== (after.executable === true)) {
        throw new Error(`Repacked unpacked main metadata is unsafe: ${relative}`);
      }
      continue;
    }
    assertSameLocalAsarMetadata(before, after, relative);
    const original = externalUnpackedPath(currentUnpacked, relative);
    const generated = externalUnpackedPath(nextUnpacked, relative);
    if (kind === 'directory') {
      if (!existsSync(original) || !lstatSync(original).isDirectory() || !existsSync(generated) || !lstatSync(generated).isDirectory()) {
        throw new Error(`Referenced unpacked directory is missing or unsafe: ${relative}`);
      }
    } else if (kind === 'link') {
      if (!existsSync(path.dirname(original)) || !lstatSync(original).isSymbolicLink() ||
          !existsSync(path.dirname(generated)) || !lstatSync(generated).isSymbolicLink() ||
          readlinkSync(original) !== readlinkSync(generated)) {
        throw new Error(`Referenced unpacked symlink drifted: ${relative}`);
      }
    } else {
      if (!existsSync(original) || !lstatSync(original).isFile() || !existsSync(generated) || !lstatSync(generated).isFile() ||
          sha256File(original) !== sha256File(generated)) {
        throw new Error(`Referenced unpacked file payload drifted: ${relative}`);
      }
    }
  }
}

export async function rebuildAsarWithMain(archivePath, sourceMainPath) {
  if (!existsSync(sourceMainPath)) throw new Error(`Built main entry not found: ${sourceMainPath}`);
  const raw = asar.getRawHeader(archivePath);
  validateSupportedAsarHeader(raw.header);
  const listed = asar.listPackage(archivePath, { isPack: false }).map(archiveRelative);
  if (!listed.includes(MAIN_ENTRY)) throw new Error(`Installed app.asar does not contain ${MAIN_ENTRY}`);

  const extractRoot = mkdtempSync(path.join(os.tmpdir(), 'cos-task-box-asar-'));
  const nextArchive = `${archivePath}.task-box-new`;
  const nextUnpacked = `${nextArchive}.unpacked`;
  const currentUnpacked = `${archivePath}.unpacked`;
  rmSync(nextArchive, { force: true });
  rmSync(nextUnpacked, { recursive: true, force: true });
  try {
    const originalMainStat = asar.statFile(archivePath, MAIN_ENTRY, false);
    const mainUnpacked = originalMainStat.unpacked === true;
    const originalUnpackedMain = externalUnpackedPath(currentUnpacked, MAIN_ENTRY);
    let originalUnpackedMainMode = null;
    if (mainUnpacked) {
      if (!existsSync(originalUnpackedMain) || !lstatSync(originalUnpackedMain).isFile()) {
        throw new Error(`Installed unpacked main entry is missing or unsafe: ${MAIN_ENTRY}`);
      }
      originalUnpackedMainMode = lstatSync(originalUnpackedMain).mode & 0o777;
    }
    asar.extractAll(archivePath, extractRoot);
    const extractedMain = path.join(extractRoot, ...MAIN_ENTRY.split('/'));
    mkdirSync(path.dirname(extractedMain), { recursive: true });
    cpSync(sourceMainPath, extractedMain, { force: true });
    if (mainUnpacked) chmodSync(extractedMain, originalUnpackedMainMode);
    else chmodSync(extractedMain, originalMainStat.executable === true ? 0o755 : 0o644);

    const streams = listed.map((relative) => {
      const stat = asar.statFile(archivePath, relative, false);
      const unpacked = stat.unpacked === true;
      if ('files' in stat) return { type: 'directory', path: relative, unpacked };
      if ('link' in stat) {
        return {
          type: 'link', path: relative, unpacked, symlink: stat.link,
          streamGenerator: () => Readable.from([]), stat: { mode: 0o777, size: 0 }
        };
      }
      const extracted = path.join(extractRoot, ...relative.split('/'));
      const diskStat = statSync(extracted);
      return {
        type: 'file', path: relative, unpacked,
        streamGenerator: () => createReadStream(extracted),
        stat: { mode: diskStat.mode, size: diskStat.size }
      };
    });
    await asar.createPackageFromStreams(nextArchive, streams);
    validateSupportedAsarHeader(asar.getRawHeader(nextArchive).header);

    assertReferencedUnpackedPayloadPreserved({
      archivePath,
      nextArchive,
      currentUnpacked,
      nextUnpacked,
      listed,
      mainUnpacked
    });

    const expectedMain = sha256File(sourceMainPath);
    const actualMain = sha256Bytes(asar.extractFile(nextArchive, MAIN_ENTRY));
    if (expectedMain !== actualMain) throw new Error('Repacked out/main/index.js does not match built source.');

    asar.uncache(archivePath);
    asar.uncache(nextArchive);
    rmSync(archivePath, { force: true });
    renameSync(nextArchive, archivePath);
    // The installed/candidate unpacked tree is authoritative. It can contain code-signature
    // sidecars, directory modes and other bundle payload that is intentionally not represented
    // by the ASAR header. Never replace that tree with the repacker's generated subset.
    if (mainUnpacked) {
      const stagedMain = `${originalUnpackedMain}.task-box-new`;
      rmSync(stagedMain, { force: true });
      writeFileSync(stagedMain, readFileSync(sourceMainPath), { mode: originalUnpackedMainMode });
      chmodSync(stagedMain, originalUnpackedMainMode);
      renameSync(stagedMain, originalUnpackedMain);
    }
    asar.uncache(archivePath);
    return { mainSha256: expectedMain, asarSha256: sha256File(archivePath), integrity: asarHeaderIntegrity(archivePath) };
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
    rmSync(nextArchive, { force: true });
    rmSync(nextUnpacked, { recursive: true, force: true });
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readPlist(file) {
  const value = plist.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid plist: ${file}`);
  return value;
}

function run(command, argv) {
  const result = spawnSync(command, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`${command} ${argv.join(' ')} failed: ${detail || result.error?.message || result.status}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function codesignCandidate(candidate) {
  signMacOSBundle(candidate);
}

function verifyCandidateSignature(candidate) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', candidate]);
}

function installedProcessCommands() {
  return run('/bin/ps', ['-axo', 'command=']).split('\n').map((line) => line.trim()).filter(Boolean);
}

export function exactInstalledProcessRunning(commands, installedAppPath) {
  const executable = path.join(installedAppPath, 'Contents', 'MacOS', 'Chat On Steroids');
  return commands.some((command) => command === executable || command.startsWith(`${executable} `));
}

function copyCompanionExtension(sourceExtension, candidate) {
  const target = path.join(candidate, EXTENSION_RELATIVE);
  rmSync(target, { recursive: true, force: true });
  cpSync(sourceExtension, target, { recursive: true, force: true });
  return fingerprintTree(target);
}

function updateCandidatePlist(candidate, integrity) {
  const target = path.join(candidate, PLIST_RELATIVE);
  const updated = withUpdatedAsarIntegrity(readPlist(target), integrity);
  writeFileSync(target, plist.build(updated), 'utf8');
  return sha256File(target);
}

export function buildDescriptor(fields) {
  return {
    protocol: 1,
    kind: 'rocaniiru-task-box-package',
    version: fields.version,
    baseAppFingerprint: fields.baseAppFingerprint,
    source: { mainSha256: fields.sourceMainSha256, extensionSha256: fields.sourceExtensionSha256 },
    candidate: {
      bundleFingerprint: fields.candidateBundleFingerprint,
      asarSha256: fields.candidateAsarSha256,
      mainSha256: fields.candidateMainSha256,
      extensionSha256: fields.candidateExtensionSha256,
      infoPlistSha256: fields.candidateInfoPlistSha256
    },
    requiresManualActivation: true,
    requiresOldClearExtensionDisabled: true,
    resetsStorage: false,
    smokeLaunched: false,
    createdAt: fields.createdAt ?? new Date().toISOString()
  };
}

function validateDescriptor(descriptor) {
  if (!descriptor || descriptor.protocol !== 1 || descriptor.kind !== 'rocaniiru-task-box-package' ||
      descriptor.requiresManualActivation !== true || descriptor.requiresOldClearExtensionDisabled !== true ||
      descriptor.resetsStorage !== false || descriptor.smokeLaunched !== false) {
    throw new Error('Invalid TASK BOX package descriptor.');
  }
  for (const digest of [
    descriptor.baseAppFingerprint,
    descriptor.source?.mainSha256,
    descriptor.source?.extensionSha256,
    descriptor.candidate?.bundleFingerprint,
    descriptor.candidate?.asarSha256,
    descriptor.candidate?.mainSha256,
    descriptor.candidate?.extensionSha256,
    descriptor.candidate?.infoPlistSha256
  ]) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/i.test(digest)) throw new Error('Invalid TASK BOX descriptor fingerprint.');
  }
  return descriptor;
}

function sourceState() {
  const sourcePackage = readJson(path.join(repo, 'package.json'));
  const sourceExtensionPath = path.join(repo, 'extension');
  const sourceManifest = readJson(path.join(sourceExtensionPath, 'manifest.json'));
  const sourceMain = path.join(repo, 'out', 'main', 'index.js');
  if (!existsSync(sourceMain)) throw new Error(`Built main entry is required before prepare: ${sourceMain}`);
  return { sourcePackage, sourceManifest, sourceExtensionPath, sourceMain };
}

function installedState(installedAppPath) {
  if (!existsSync(installedAppPath)) throw new Error(`Installed app not found: ${installedAppPath}`);
  const info = readPlist(path.join(installedAppPath, PLIST_RELATIVE));
  const manifest = readJson(path.join(installedAppPath, EXTENSION_RELATIVE, 'manifest.json'));
  return { version: info.CFBundleShortVersionString, extensionVersion: manifest.version };
}

export async function prepareCandidate(options) {
  if (process.platform !== 'darwin') throw new Error('TASK BOX macOS package preparation is macOS-only.');
  const installedAppPath = options.installedAppPath ?? DEFAULT_APP;
  const source = sourceState();
  const installed = installedState(installedAppPath);
  const version = validateVersions({
    sourceVersion: source.sourcePackage.version,
    sourceExtensionVersion: source.sourceManifest.version,
    installedVersion: installed.version,
    installedExtensionVersion: installed.extensionVersion
  });
  const baseAppFingerprint = fingerprintTree(installedAppPath);
  assertExpectedBaselineFingerprint(baseAppFingerprint, options.expectedBaselineFingerprint);
  const sourceMainSha256 = sha256File(source.sourceMain);
  const sourceExtensionSha256 = fingerprintTree(source.sourceExtensionPath);

  const outputRoot = options.outputRoot ?? path.join(
    os.homedir(), 'Library', 'Application Support', 'chat-on-steroids', 'task-box-packages',
    `${version}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  );
  mkdirSync(outputRoot, { recursive: true });
  const candidate = path.join(outputRoot, 'Chat On Steroids.app');
  const descriptorPath = path.join(outputRoot, 'task-box-package.json');
  if (existsSync(candidate) || existsSync(descriptorPath)) throw new Error(`Preparation output already exists: ${outputRoot}`);

  run('/usr/bin/ditto', [installedAppPath, candidate]);
  const asarResult = await rebuildAsarWithMain(path.join(candidate, ASAR_RELATIVE), source.sourceMain);
  const candidateExtensionSha256 = copyCompanionExtension(source.sourceExtensionPath, candidate);
  const candidateInfoPlistSha256 = updateCandidatePlist(candidate, asarResult.integrity);
  const copiedManifest = readJson(path.join(candidate, EXTENSION_RELATIVE, 'manifest.json'));
  if (copiedManifest.version !== version) throw new Error(`Candidate extension version drifted: ${copiedManifest.version}`);

  codesignCandidate(candidate);
  assertExpectedBaselineFingerprint(fingerprintTree(installedAppPath),baseAppFingerprint);
  if (sha256File(source.sourceMain) !== sourceMainSha256 || asarResult.mainSha256 !== sourceMainSha256 ||
      fingerprintTree(source.sourceExtensionPath) !== sourceExtensionSha256 || candidateExtensionSha256 !== sourceExtensionSha256) {
    throw new Error('Source changed during preparation; refusing to publish a mixed candidate.');
  }
  const descriptor = buildDescriptor({
    version,
    baseAppFingerprint,
    sourceMainSha256,
    sourceExtensionSha256,
    candidateBundleFingerprint: fingerprintTree(candidate),
    candidateAsarSha256: asarResult.asarSha256,
    candidateMainSha256: asarResult.mainSha256,
    candidateExtensionSha256,
    candidateInfoPlistSha256
  });
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  return { candidate, descriptorPath, descriptor };
}

export function validateApplyCandidate({ descriptor, candidate, installedAppPath, oldClearDisabled, running }) {
  const checked = validateDescriptor(descriptor);
  assertOldClearDisabled(oldClearDisabled);
  refuseIfInstalledAppRunning(running);
  const installed = installedState(installedAppPath);
  if (installed.version !== checked.version || installed.extensionVersion !== checked.version) {
    throw new Error(`Installed app changed version after prepare: ${installed.version}`);
  }
  assertExpectedBaselineFingerprint(fingerprintTree(installedAppPath), checked.baseAppFingerprint);
  assertExpectedBaselineFingerprint(fingerprintTree(candidate), checked.candidate.bundleFingerprint);
  if (sha256File(path.join(candidate, ASAR_RELATIVE)) !== checked.candidate.asarSha256 ||
      fingerprintTree(path.join(candidate, EXTENSION_RELATIVE)) !== checked.candidate.extensionSha256 ||
      sha256File(path.join(candidate, PLIST_RELATIVE)) !== checked.candidate.infoPlistSha256) {
    throw new Error('Candidate payload no longer matches its descriptor.');
  }
  const mainHash = sha256Bytes(asar.extractFile(path.join(candidate, ASAR_RELATIVE), MAIN_ENTRY));
  if (mainHash !== checked.candidate.mainSha256) throw new Error('Candidate main entry no longer matches its descriptor.');
  return checked;
}

export function applyCandidate(options) {
  if (process.platform !== 'darwin') throw new Error('TASK BOX macOS apply is macOS-only.');
  const installedAppPath = options.installedAppPath ?? DEFAULT_APP;
  const candidate = options.candidate;
  const descriptor = readJson(options.descriptorPath);
  const running = exactInstalledProcessRunning(installedProcessCommands(), installedAppPath);
  validateApplyCandidate({ descriptor, candidate, installedAppPath, oldClearDisabled: options.oldClearDisabled, running });
  verifyCandidateSignature(candidate);

  const parent = path.dirname(installedAppPath);
  if (options.slot !== undefined && !/^[a-f0-9]{12}$/.test(options.slot)) throw new Error('Invalid TASK BOX apply slot.');
  const suffix = options.slot ? `-${options.slot}` : '';
  const staged = path.join(parent, `.Chat On Steroids.task-box-new${suffix}.app`);
  const rollback = path.join(parent, `.Chat On Steroids.task-box-old${suffix}.app`);
  if (existsSync(staged) || existsSync(rollback)) throw new Error('TASK BOX apply staging/rollback path already exists; resolve it manually.');
  run('/usr/bin/ditto', [candidate, staged]);
  assertExpectedBaselineFingerprint(fingerprintTree(staged), descriptor.candidate.bundleFingerprint);
  verifyCandidateSignature(staged);
  refuseIfInstalledAppRunning(exactInstalledProcessRunning(installedProcessCommands(), installedAppPath));

  renameSync(installedAppPath, rollback);
  try {
    renameSync(staged, installedAppPath);
  } catch (error) {
    if (!existsSync(installedAppPath) && existsSync(rollback)) renameSync(rollback, installedAppPath);
    throw error;
  }
  return { applied: true, rollback, requiresManualActivation: true };
}

function parseCli(argv) {
  const result = { prepare: false, apply: false, oldClearDisabled: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--prepare') result.prepare = true;
    else if (arg === '--apply') result.apply = true;
    else if (arg === '--old-clear-disabled') result.oldClearDisabled = true;
    else if (arg === '--expected-baseline') result.expectedBaselineFingerprint = argv[++index];
    else if (arg === '--candidate') result.candidate = argv[++index];
    else if (arg === '--descriptor') result.descriptorPath = argv[++index];
    else if (arg === '--installed-app') result.installedAppPath = argv[++index];
    else if (arg === '--output-root') result.outputRoot = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (result.prepare === result.apply) throw new Error('Choose exactly one of --prepare or --apply.');
  return result;
}

async function cli() {
  const options = parseCli(process.argv.slice(2));
  if (options.prepare) {
    const prepared = await prepareCandidate({
      installedAppPath: options.installedAppPath,
      expectedBaselineFingerprint: options.expectedBaselineFingerprint ?? process.env.COS_TASK_BOX_BASELINE_SHA256,
      outputRoot: options.outputRoot
    });
    process.stdout.write(`TASK_BOX_CANDIDATE_READY ${prepared.candidate}\n`);
    process.stdout.write(`descriptor=${prepared.descriptorPath}\n`);
    process.stdout.write('requiresManualActivation=true oldClearDisabledBeforeApply=true storageReset=false\n');
    return;
  }
  if (!options.candidate || !options.descriptorPath) throw new Error('--apply requires --candidate and --descriptor.');
  const applied = applyCandidate({
    installedAppPath: options.installedAppPath,
    candidate: options.candidate,
    descriptorPath: options.descriptorPath,
    oldClearDisabled: options.oldClearDisabled
  });
  process.stdout.write(`TASK_BOX_APPLIED rollback=${applied.rollback}\n`);
  process.stdout.write('App was not started. TASK BOX activation remains manual.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptFile)) {
  cli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
