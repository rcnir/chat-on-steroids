import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signMacOSBundle } from './macos-local-signing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const sourceExtension = path.join(repo, 'extension');
const sourcePackage = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const sourceManifest = JSON.parse(readFileSync(path.join(sourceExtension, 'manifest.json'), 'utf8'));

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const applyExtensionOnly = args.has('--apply-extension-only');
const app = '/Applications/Chat On Steroids.app';
const appParent = path.dirname(app);
const appName = path.basename(app);
const hiddenNew = path.join(appParent, '.Chat On Steroids.rocaniiru-new.app');
const hiddenOld = path.join(appParent, '.Chat On Steroids.rocaniiru-old.app');
const stableExtension = path.join(os.homedir(), 'Library', 'Application Support', 'chat-on-steroids', 'extension');

if (process.platform !== 'darwin') throw new Error('This patcher is macOS-only.');
if (!existsSync(app)) throw new Error(`Installed app not found: ${app}`);
if (!existsSync(path.join(sourceExtension, 'chatgpt-dom.js'))) throw new Error('Fork extension source is incomplete.');
if (sourcePackage.version !== sourceManifest.version) {
  throw new Error(`Fork version mismatch: package=${sourcePackage.version}, extension=${sourceManifest.version}`);
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`${command} ${argv.join(' ')} failed: ${detail || result.error?.message || result.status}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function plistValue(bundle, key) {
  return run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(bundle, 'Contents', 'Info.plist')]).trim();
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function extensionFingerprint(root) {
  const hash = createHash('sha256');
  const visit = (dir, relativeDir = '') => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(readFileSync(absolute));
        hash.update('\0');
      } else {
        throw new Error(`Unsupported extension entry: ${relative}`);
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

function replaceExtension(bundle) {
  const target = path.join(bundle, 'Contents', 'Resources', 'extension');
  rmSync(target, { recursive: true, force: true });
  cpSync(sourceExtension, target, { recursive: true, force: true });
  const copied = JSON.parse(readFileSync(path.join(target, 'manifest.json'), 'utf8'));
  if (copied.version !== sourceManifest.version) throw new Error(`Copied extension version drifted: ${copied.version}`);
  const sourceHash = sha256(path.join(sourceExtension, 'chatgpt-dom.js'));
  const copiedHash = sha256(path.join(target, 'chatgpt-dom.js'));
  if (sourceHash !== copiedHash) throw new Error('chatgpt-dom.js did not copy byte-for-byte.');
  return sourceHash;
}

function sealAndVerify(bundle) {
  signMacOSBundle(bundle);
}

function bundleArch(bundle) {
  const binary = path.join(bundle, 'Contents', 'MacOS', 'Chat On Steroids');
  const archs = run('lipo', ['-archs', binary]).trim().split(/\s+/).filter(Boolean);
  if (archs.length !== 1) throw new Error(`Expected one installed architecture, got ${archs.join(', ')}`);
  if (archs[0] === 'arm64') return 'arm64';
  if (archs[0] === 'x86_64') return 'x64';
  throw new Error(`Unsupported installed architecture: ${archs[0]}`);
}

function smoke(bundle, arch) {
  run(process.execPath, [path.join(repo, 'scripts', 'smoke-macos-bundle.mjs'), arch, bundle], { cwd: repo });
}

function waitForExit(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync('pgrep', ['-f', '^/Applications/Chat On Steroids\\.app/Contents/MacOS/Chat On Steroids$']);
    if (result.status !== 0) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return false;
}

function quitInstalledApp() {
  const running = spawnSync('pgrep', ['-f', '^/Applications/Chat On Steroids\\.app/Contents/MacOS/Chat On Steroids$']).status === 0;
  if (!running) return;
  run('osascript', ['-e', 'tell application "Chat On Steroids" to quit']);
  if (!waitForExit()) throw new Error('Chat On Steroids did not exit within 20 seconds; refusing to replace a running app.');
}

function publishStableExtension(sourceMarker = null) {
  const stage = `${stableExtension}.rocaniiru-new`;
  const old = `${stableExtension}.rocaniiru-old`;
  rmSync(stage, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  cpSync(sourceExtension, stage, { recursive: true, force: true });
  // The packaged app refreshes this stable path when its bundled fingerprint changes.
  // An extension-only ROCANIIRU patch deliberately leaves the signed app untouched, so mark
  // the published tree as based on the currently installed bundle. This prevents a later
  // settings/open path from overwriting the patched stable tree with the same old bundle.
  if (sourceMarker) writeFileSync(path.join(stage, '.chat-on-steroids-source'), `${sourceMarker}\n`, { mode: 0o600 });
  if (existsSync(stableExtension)) renameSync(stableExtension, old);
  try {
    renameSync(stage, stableExtension);
  } catch (error) {
    if (!existsSync(stableExtension) && existsSync(old)) renameSync(old, stableExtension);
    throw error;
  }
  rmSync(old, { recursive: true, force: true });
}

function applyStableExtensionOnly(installedVersion) {
  const bundled = path.join(app, 'Contents', 'Resources', 'extension');
  const marker = extensionFingerprint(bundled);
  publishStableExtension(marker);
  for (const file of ['background.js', 'chatgpt-dom.js']) {
    const source = path.join(sourceExtension, file);
    const published = path.join(stableExtension, file);
    if (sha256(source) !== sha256(published)) throw new Error(`${file} did not publish byte-for-byte.`);
  }
  process.stdout.write(`APPLIED_EXTENSION_ONLY version=${installedVersion} app_mutated=false codesign=false\n`);
  process.stdout.write(`bundled_fingerprint=${marker}\n`);
  process.stdout.write(`stable_extension=${stableExtension}\n`);
}

const installedVersion = plistValue(app, 'CFBundleShortVersionString');
if (installedVersion !== sourcePackage.version) {
  throw new Error(`Refusing cross-version patch: installed=${installedVersion}, fork=${sourcePackage.version}`);
}
const bundledManifest = JSON.parse(readFileSync(path.join(app, 'Contents', 'Resources', 'extension', 'manifest.json'), 'utf8'));
if (bundledManifest.version !== installedVersion) {
  throw new Error(`Installed app/extension mismatch: app=${installedVersion}, extension=${bundledManifest.version}`);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rocaniiru-cos-patch-'));
const candidate = path.join(tempRoot, appName);
run('ditto', [app, candidate]);
const patchHash = replaceExtension(candidate);
sealAndVerify(candidate);
const arch = bundleArch(candidate);
smoke(candidate, arch);

process.stdout.write(`CANDIDATE_OK version=${installedVersion} arch=${arch} patch_sha256=${patchHash}\n`);
process.stdout.write(`candidate=${candidate}\n`);

if (applyExtensionOnly) {
  applyStableExtensionOnly(installedVersion);
  process.exit(0);
}

if (!apply) {
  process.stdout.write('Dry run only. Re-run with --apply to publish this patch to /Applications.\n');
  process.exit(0);
}

if (existsSync(hiddenOld)) {
  throw new Error(`Rollback app already exists: ${hiddenOld}. Resolve it before applying another patch.`);
}
rmSync(hiddenNew, { recursive: true, force: true });
run('ditto', [candidate, hiddenNew]);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', hiddenNew]);

quitInstalledApp();
renameSync(app, hiddenOld);
try {
  renameSync(hiddenNew, app);
} catch (error) {
  if (!existsSync(app) && existsSync(hiddenOld)) renameSync(hiddenOld, app);
  throw error;
}

try {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  publishStableExtension(extensionFingerprint(path.join(app, 'Contents', 'Resources', 'extension')));
} catch (error) {
  rmSync(app, { recursive: true, force: true });
  renameSync(hiddenOld, app);
  throw error;
}

process.stdout.write(`APPLIED_OK app=${app}\n`);
process.stdout.write(`rollback=${hiddenOld}\n`);
process.stdout.write(`stable_extension=${stableExtension}\n`);
