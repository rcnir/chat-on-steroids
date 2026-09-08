import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import asarImport from '@electron/asar';
import plistImport from 'plist';
import { feature, releaseFor, composeMain, sha256 } from './main-adapter.mjs';
import { composeBackground } from './extension-adapter.mjs';
import { buildFeature, featureFingerprint } from './build-feature.mjs';
import { fingerprintTree, rebuildAsarWithMain, buildDescriptor, applyCandidate } from '../../scripts/rocaniiru-task-box-package.mjs';

const asar = asarImport?.default ?? asarImport;
const plist = plistImport?.default ?? plistImport;
const DEFAULT_APP = '/Applications/Chat On Steroids.app';
const MAIN = 'out/main/index.js';
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}

/** Read-only compatibility check. No fetching, state/config changes or extension publication. */
export function inspectOfficialApp(appPath, { baseDescriptorPath } = {}) {
  const app = realpathSync(appPath);
  const resources = path.join(app, 'Contents/Resources');
  const info = plist.parse(readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8'));
  const release = releaseFor(info.CFBundleShortVersionString);
  const archive = path.join(resources, 'app.asar');
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  const currentExtension = path.join(resources, 'extension');
  const currentManifest = json(path.join(currentExtension, 'manifest.json'));
  if (packaged.version !== info.CFBundleShortVersionString || currentManifest.version !== packaged.version) {
    throw new Error('TASK_BOX_APP_EXTENSION_VERSION_MISMATCH');
  }
  // Preserve the pinned official inputs inside our signed addon for same-app feature updates.
  // They are never executed and do not contain user data. A legacy patched app without this
  // provenance must first be replaced by its verified official release, not guessed at.
  const originalRoot = path.join(resources, 'rocaniiru-task-box/original');
  const alreadyAddon = existsSync(originalRoot);
  let previous = null;
  const fullFingerprint = fingerprintTree(app);
  if (alreadyAddon) {
    if (!baseDescriptorPath) throw new Error('TASK_BOX_EXISTING_ADDON_DESCRIPTOR_REQUIRED');
    previous = json(baseDescriptorPath);
    if (previous?.kind !== 'rocaniiru-task-box-package' || previous.protocol !== 1 ||
        previous.addon?.schema !== 1 || previous.version !== packaged.version ||
        previous.candidate?.bundleFingerprint !== fullFingerprint) throw new Error('TASK_BOX_EXISTING_ADDON_FINGERPRINT_MISMATCH');
  } else if (fullFingerprint !== release.bundleFingerprint) {
    throw new Error('TASK_BOX_OFFICIAL_BUNDLE_HASH_MISMATCH');
  }
  const extension = alreadyAddon ? path.join(originalRoot, 'extension') : currentExtension;
  const manifest = json(path.join(extension, 'manifest.json'));
  if (manifest.version !== packaged.version) throw new Error('TASK_BOX_ORIGINAL_VERSION_MISMATCH');
  if (manifest.background?.service_worker !== 'background.js' || manifest.background.type !== 'module' ||
      manifest.options_page || manifest.options_ui) throw new Error('TASK_BOX_UPSTREAM_EXTENSION_SHAPE_CHANGED');
  const currentMain = asar.extractFile(archive, MAIN).toString();
  const original = alreadyAddon ? readFileSync(path.join(originalRoot, 'main.js'), 'utf8') : currentMain;
  const main = composeMain(original, packaged.version);
  if (alreadyAddon && sha256(currentMain) !== previous.candidate.mainSha256) throw new Error('TASK_BOX_EXISTING_LOADER_CHANGED');
  if (fingerprintTree(extension) !== release.extensionFingerprint) throw new Error('TASK_BOX_OFFICIAL_EXTENSION_HASH_MISMATCH');
  return { app, resources, archive, extension, manifest, info, version: packaged.version, release, main, original, alreadyAddon,
    baselineFingerprint: fullFingerprint };
}

export function composeManifest(original, version) {
  const release = releaseFor(version);
  if (original.version !== version || original.background?.service_worker !== 'background.js' || original.background.type !== 'module') {
    throw new Error('TASK_BOX_MANIFEST_CONTRACT_MISMATCH');
  }
  const out = structuredClone(original);
  const scripts = out.content_scripts?.filter(entry => entry.js?.includes('content.js') && (!entry.world || entry.world === 'ISOLATED'));
  if (scripts?.length !== 1 || original.options_page || original.options_ui) throw new Error('TASK_BOX_CONTENT_SCRIPT_SEAM_MISMATCH');
  if (scripts[0].js.some(file => file.startsWith('task-box-'))) throw new Error('TASK_BOX_FEATURE_ALREADY_PRESENT');
  out.options_page = 'task-box-setup.html';
  out.background = { service_worker: 'task-box-worker.js', type: 'module' };
  scripts[0].js.push('task-box-compatibility.js', 'task-box-core.js', 'task-box.js');
  if (!Number.isSafeInteger(release.bridgeProtocol)) throw new Error('TASK_BOX_INVALID_BRIDGE_CONTRACT');
  return out;
}

/** Compose a signed COPY of a supported original app. The installed app is never stopped or changed. */
export async function prepareAddon({ appPath, outputRoot, baseDescriptorPath }) {
  if (process.platform !== 'darwin') throw new Error('TASK_BOX_MACOS_PACKAGE_REQUIRED');
  if (!appPath || !outputRoot) throw new Error('Explicit appPath and new outputRoot are required.');
  const source = inspectOfficialApp(appPath, { baseDescriptorPath });
  // Resolve even a not-yet-created output's existing parents. A symlink must not hide
  // /Applications or the input bundle behind an apparently harmless output pathname.
  let parent = path.resolve(outputRoot);
  const tail = [];
  while (!existsSync(parent)) { tail.unshift(path.basename(parent)); parent = path.dirname(parent); }
  const out = path.join(realpathSync(parent), ...tail);
  if (existsSync(out) || out.startsWith(source.app + path.sep) || out === source.app ||
      out === '/Applications' || out.startsWith('/Applications/')) throw new Error('TASK_BOX_UNSAFE_PREPARATION_DESTINATION');
  const arch = run('/usr/bin/lipo', ['-archs', path.join(source.app, 'Contents/MacOS/Chat On Steroids')]).trim();
  if (arch !== source.release.arch) throw new Error('TASK_BOX_UNVERIFIED_ARCHITECTURE');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source.app]);
  const baseline = source.baselineFingerprint;
  if (fingerprintTree(source.app) !== baseline) throw new Error('TASK_BOX_BASELINE_CHANGED_AFTER_INSPECTION');
  const featureBefore = featureFingerprint();
  mkdirSync(out, { recursive: true });
  const featureRoot = path.join(out, 'feature');
  const built = buildFeature(featureRoot, source.version);
  const candidate = path.join(out, 'Chat On Steroids.app');
  run('/usr/bin/ditto', [source.app, candidate]);
  const resources = path.join(candidate, 'Contents/Resources');
  const extension = path.join(resources, 'extension');
  // Recompose from the pinned upstream, not the previous feature's generated output.
  rmSync(extension, { recursive: true });
  cpSync(source.extension, extension, { recursive: true });
  const background = readFileSync(path.join(source.extension, 'background.js'), 'utf8');
  const composed = composeBackground(background, {
    appVersion: source.version, featureVersion: feature.featureVersion, protocol: feature.protocol
  });
  writeFileSync(path.join(extension, 'background.js'), composed);
  cpSync(path.join(featureRoot, 'extension'), extension, { recursive: true });
  writeJson(path.join(extension, 'manifest.json'), composeManifest(source.manifest, source.version));
  const addonRoot = path.join(resources, 'rocaniiru-task-box');
  rmSync(addonRoot, { recursive: true, force: true });
  cpSync(path.join(featureRoot, 'runtime'), addonRoot, { recursive: true });
  const originalRoot = path.join(addonRoot, 'original');
  mkdirSync(originalRoot);
  writeFileSync(path.join(originalRoot, 'main.js'), source.original);
  cpSync(source.extension, path.join(originalRoot, 'extension'), { recursive: true });

  const mainFile = path.join(out, 'composed-main.js');
  writeFileSync(mainFile, source.main.source);
  const repacked = await rebuildAsarWithMain(path.join(resources, 'app.asar'), mainFile);
  const info = { ...source.info, ElectronAsarIntegrity: {
    ...(source.info.ElectronAsarIntegrity || {}), 'Resources/app.asar': repacked.integrity
  } };
  const infoFile = path.join(candidate, 'Contents/Info.plist');
  writeFileSync(infoFile, plist.build(info));
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', candidate]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate]);
  if (fingerprintTree(source.app) !== baseline || featureBefore !== featureFingerprint() || built.featureFingerprint !== featureBefore) {
    throw new Error('TASK_BOX_PACKAGE_INPUT_CHANGED');
  }
  // The shared packager's stopped-app apply/rollback boundary remains the only installer.
  const descriptor = buildDescriptor({
    version: source.version, baseAppFingerprint: baseline,
    sourceMainSha256: source.main.sha256, sourceExtensionSha256: fingerprintTree(extension),
    candidateBundleFingerprint: fingerprintTree(candidate), candidateAsarSha256: repacked.asarSha256,
    candidateMainSha256: repacked.mainSha256, candidateExtensionSha256: fingerprintTree(extension),
    candidateInfoPlistSha256: sha256(readFileSync(infoFile))
  });
  descriptor.addon = {
    schema: 1, featureVersion: feature.featureVersion, featureFingerprint: featureBefore,
    protocol: feature.protocol, adapterRevision: feature.adapterRevision,
    upstream: source.release, mainInsertedBytes: source.main.insertedBytes,
    runtimeFingerprint: fingerprintTree(path.join(resources, 'rocaniiru-task-box')),
    officialMainBodyPreserved: true, officialApplicationRebuilt: false,
    liveAcceptance: false
  };
  const descriptorPath = path.join(out, 'task-box-package.json');
  writeJson(descriptorPath, descriptor);
  return { candidate, descriptorPath, descriptor };
}

export function applyAddon({ candidate, descriptorPath, appPath = DEFAULT_APP, oldClearDisabled = false }) {
  const descriptor = json(descriptorPath);
  if (descriptor.addon?.schema !== 1 || descriptor.addon.featureFingerprint !== featureFingerprint() ||
      descriptor.addon.featureVersion !== feature.featureVersion) throw new Error('TASK_BOX_PREPARED_FEATURE_MISMATCH');
  releaseFor(descriptor.version);
  return applyCandidate({ candidate, descriptorPath, installedAppPath: appPath, oldClearDisabled,
    slot: descriptor.baseAppFingerprint.slice(0, 12) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const operation = args.shift();
  const opts = {};
  while (args.length) {
    const name = args.shift();
    if (name === '--old-clear-disabled') { opts.oldClearDisabled = true; continue; }
    const field = { '--app': 'appPath', '--output': 'outputRoot', '--candidate': 'candidate', '--descriptor': 'descriptorPath', '--base-descriptor': 'baseDescriptorPath' }[name];
    if (!field || !args[0] || args[0].startsWith('--')) throw new Error(`Invalid argument: ${name}`);
    opts[field] = args.shift();
  }
  try {
    if (operation === 'check') {
      const inspected = inspectOfficialApp(opts.appPath || DEFAULT_APP, opts);
      console.log(JSON.stringify({ compatible: true, appVersion: inspected.version, featureVersion: feature.featureVersion,
        mainInsertedBytes: inspected.main.insertedBytes, liveChanged: false }, null, 2));
    } else if (operation === 'prepare') {
      console.log(JSON.stringify(await prepareAddon(opts), null, 2));
    } else if (operation === 'apply') {
      console.log(JSON.stringify(applyAddon(opts), null, 2));
    } else throw new Error('Use check, prepare or apply. See Update-Reference.md.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
