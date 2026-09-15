import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature, releaseFor, sha256 } from './main-adapter.mjs';
import { workerWrapper } from './extension-adapter.mjs';

export const root = path.dirname(fileURLToPath(import.meta.url));
const inputFiles = [
  'feature.json', 'main-adapter.mjs', 'surface-adapter.mjs', 'extension-adapter.mjs', 'popup-adapter.mjs', 'loader.cjs', 'build-feature.mjs', 'package.mjs',
  '../task-box/package.mjs', '../../scripts/rocaniiru-task-box-package.mjs', '../../scripts/macos-local-signing.mjs',
  'runtime/browser-control.cjs', 'extension/browser-control-transport.js', 'extension/browser-control-driver.js',
  'extension/browser-control-guard.js'
];

export function featureFingerprint() {
  return sha256(inputFiles.slice().sort().map(file => `${file}\0${sha256(readFileSync(path.join(root, file)))}\0`).join(''));
}

export function emitRuntime(target) {
  mkdirSync(path.join(target, 'runtime'), { recursive: true });
  copyFileSync(path.join(root, 'runtime/browser-control.cjs'), path.join(target, 'runtime/browser-control.cjs'));
  copyFileSync(path.join(root, 'loader.cjs'), path.join(target, 'loader.cjs'));
}

export function emitExtension(target, workerTarget = 'background.js') {
  mkdirSync(target, { recursive: true });
  copyFileSync(path.join(root, 'extension/browser-control-transport.js'), path.join(target, 'browser-control-transport.js'));
  copyFileSync(path.join(root, 'extension/browser-control-driver.js'), path.join(target, 'browser-control-driver.js'));
  copyFileSync(path.join(root, 'extension/browser-control-guard.js'), path.join(target, 'browser-control-guard.js'));
  writeFileSync(path.join(target, 'browser-control-worker.js'), workerWrapper(workerTarget));
}

/** Build only Browser Control payload. No app, browser profile, installed extension or OS service is touched. */
export function buildFeature(target, version, { workerTarget = 'background.js' } = {}) {
  releaseFor(version);
  if (existsSync(target)) throw new Error('BROWSER_CONTROL_FEATURE_OUTPUT_EXISTS');
  const before = featureFingerprint();
  emitRuntime(path.join(target, 'addon'));
  emitExtension(path.join(target, 'extension'), workerTarget);
  if (before !== featureFingerprint()) throw new Error('BROWSER_CONTROL_FEATURE_INPUT_CHANGED');
  const manifest = {
    schema: 1,
    featureVersion: feature.featureVersion,
    featureFingerprint: before,
    appVersion: version,
    protocol: feature.protocol,
    adapterRevision: feature.adapterRevision
  };
  writeFileSync(path.join(target, 'feature-build.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
