import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import asarImport from '@electron/asar';
import plistImport from 'plist';
import {
  prepareAddon as prepareTaskBoxAddon,
  applyAddon as applyTaskBoxAddon
} from '../task-box/package.mjs';
import {
  feature as browserFeature,
  releaseFor,
  composeTaskBoxMain,
  sha256
} from './main-adapter.mjs';
import { composeBrowserSurfaceContract } from './surface-adapter.mjs';
import {
  composeBackground as composeBrowserBackground,
  composeManifest as composeBrowserManifest
} from './extension-adapter.mjs';
import { composePopupHtml, composePopupJs } from './popup-adapter.mjs';
import { buildFeature as buildBrowserFeature, featureFingerprint } from './build-feature.mjs';
import { fingerprintTree, rebuildAsarWithMain } from '../../scripts/rocaniiru-task-box-package.mjs';
import { signMacOSBundle } from '../../scripts/macos-local-signing.mjs';

const asar = asarImport?.default ?? asarImport;
const plist = plistImport?.default ?? plistImport;
const DEFAULT_APP = '/Applications/Chat On Steroids.app';
const MAIN = 'out/main/index.js';
const HEX64 = /^[a-f0-9]{64}$/i;
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error}`);
  }
  return result.stdout;
}

export function composeCombinedManifest(taskBoxManifest, officialManifest, version) {
  const browser = composeBrowserManifest(officialManifest, { appVersion: version });
  if (!taskBoxManifest || taskBoxManifest.version !== version || taskBoxManifest.background?.service_worker !== 'task-box-worker.js' ||
      taskBoxManifest.background.type !== 'module' || taskBoxManifest.options_page !== 'task-box-setup.html') {
    throw new Error('BROWSER_CONTROL_TASK_BOX_MANIFEST_REQUIRED');
  }
  const out = structuredClone(taskBoxManifest);
  // Browser Control is a later layer. Preserve every permission already present on the verified
  // TASK BOX candidate and union only Browser's extra authority; never rebuild the permission set
  // from the older official manifest and accidentally erase a future TASK BOX requirement.
  out.permissions = [...new Set([
    ...(Array.isArray(taskBoxManifest.permissions) ? taskBoxManifest.permissions : []),
    ...(Array.isArray(browser.permissions) ? browser.permissions : [])
  ])];
  out.optional_permissions = [...new Set([
    ...(Array.isArray(taskBoxManifest.optional_permissions) ? taskBoxManifest.optional_permissions : []),
    ...(Array.isArray(browser.optional_permissions) ? browser.optional_permissions : [])
  ])];
  out.background = { service_worker: 'browser-control-worker.js', type: 'module' };
  return out;
}

function updateInfoPlist(candidate, integrity) {
  const target = path.join(candidate, 'Contents/Info.plist');
  const current = plist.parse(readFileSync(target, 'utf8'));
  if (!current || typeof current !== 'object' || Array.isArray(current) || !integrity || integrity.algorithm !== 'SHA256') {
    throw new Error('BROWSER_CONTROL_INVALID_ASAR_INTEGRITY');
  }
  const existing = current.ElectronAsarIntegrity;
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error('BROWSER_CONTROL_INVALID_EXISTING_ASAR_INTEGRITY');
  }
  const next = {
    ...current,
    ElectronAsarIntegrity: {
      ...(existing || {}),
      'Resources/app.asar': { algorithm: 'SHA256', hash: integrity.hash }
    }
  };
  writeFileSync(target, plist.build(next));
  return target;
}

function validateBrowserDescriptor(descriptor) {
  let release;
  try { release = releaseFor(descriptor?.version); }
  catch { throw new Error('BROWSER_CONTROL_PREPARED_FEATURE_MISMATCH'); }
  const browser = descriptor?.browserControl;
  const upstream = browser?.upstream;
  if (!descriptor || descriptor.kind !== 'rocaniiru-task-box-package' || descriptor.protocol !== 1 ||
      descriptor.requiresBrowserControlActivation !== true ||
      browser?.schema !== 1 || browser?.featureVersion !== browserFeature.featureVersion ||
      browser?.featureFingerprint !== featureFingerprint() || browser?.protocol !== browserFeature.protocol ||
      browser?.adapterRevision !== browserFeature.adapterRevision ||
      browser?.currentChromeProfileOnly !== true || browser?.alternateProfileCreated !== false ||
      browser?.nativeDesktopFallback !== false || browser?.foregroundEscalation !== false ||
      browser?.controlCapabilityGated !== true || browser?.statusToolListAligned !== true ||
      browser?.debuggerPermissionActivation !== 'human-required-on-first-enable' || browser?.liveAcceptance !== false ||
      typeof browser?.runtimeFingerprint !== 'string' || !HEX64.test(browser.runtimeFingerprint) ||
      upstream?.tagCommit !== release.tagCommit || upstream?.bridgeProtocol !== release.bridgeProtocol ||
      upstream?.mainSha256 !== release.mainSha256 || upstream?.extensionFingerprint !== release.extensionFingerprint) {
    throw new Error('BROWSER_CONTROL_PREPARED_FEATURE_MISMATCH');
  }
  return descriptor;
}

/**
 * Prepare a combined TASK BOX + Browser Control candidate. This mutates only the already-created
 * candidate copy; the installed app, current Chrome profile and live extension are untouched.
 */
export async function prepareCombinedAddon({ appPath = DEFAULT_APP, outputRoot, baseDescriptorPath } = {}) {
  const taskBox = await prepareTaskBoxAddon({ appPath, outputRoot, baseDescriptorPath });
  const candidate = taskBox.candidate;
  const descriptorPath = taskBox.descriptorPath;
  const descriptor = json(descriptorPath);
  const version = descriptor.version;
  const release = releaseFor(version);
  const featureBefore = featureFingerprint();
  const root = path.dirname(candidate);
  const browserFeatureRoot = path.join(root, 'browser-control-feature');
  if (existsSync(browserFeatureRoot)) throw new Error('BROWSER_CONTROL_FEATURE_OUTPUT_EXISTS');

  // The TASK BOX packager is the first authority. Before Browser adds a byte, prove that the
  // candidate we received still exactly matches the descriptor it just produced.
  if (!descriptor.candidate?.bundleFingerprint || fingerprintTree(candidate) !== descriptor.candidate.bundleFingerprint) {
    throw new Error('BROWSER_CONTROL_TASK_BOX_CANDIDATE_CHANGED');
  }
  const built = buildBrowserFeature(browserFeatureRoot, version, { workerTarget: 'task-box-worker.js' });

  const resources = path.join(candidate, 'Contents/Resources');
  const archive = path.join(resources, 'app.asar');
  const taskBoxRoot = path.join(resources, 'rocaniiru-task-box');
  const originalRoot = path.join(taskBoxRoot, 'original');
  const originalMain = readFileSync(path.join(originalRoot, 'main.js'), 'utf8');
  const originalExtension = path.join(originalRoot, 'extension');
  const officialManifest = json(path.join(originalExtension, 'manifest.json'));
  if (officialManifest.version !== version || fingerprintTree(originalExtension) !== release.extensionFingerprint) {
    throw new Error('BROWSER_CONTROL_ORIGINAL_EXTENSION_MISMATCH');
  }

  // Compose the model-facing tool + app-side browser bridge into the exact TASK BOX main, then
  // align Browser publication/status with the existing CoS Desktop `control` capability.
  const taskBoxMain = asar.extractFile(archive, MAIN).toString();
  if (sha256(taskBoxMain) !== descriptor.candidate.mainSha256) {
    throw new Error('BROWSER_CONTROL_TASK_BOX_MAIN_CHANGED');
  }
  const browserMain = composeTaskBoxMain(taskBoxMain, originalMain, version);
  const surfacedMain = composeBrowserSurfaceContract(browserMain.source);
  const mainFile = path.join(root, 'browser-control-composed-main.js');
  writeFileSync(mainFile, surfacedMain.source);
  const repacked = await rebuildAsarWithMain(archive, mainFile);

  // Layer browser transport/driver into the already-composed TASK BOX companion. Re-prove the
  // current TASK BOX companion before the first write, independently of the full-bundle proof.
  const extension = path.join(resources, 'extension');
  if (fingerprintTree(extension) !== descriptor.candidate.extensionSha256) {
    throw new Error('BROWSER_CONTROL_TASK_BOX_EXTENSION_CHANGED');
  }
  const backgroundFile = path.join(extension, 'background.js');
  const popupHtmlFile = path.join(extension, 'popup.html');
  const popupJsFile = path.join(extension, 'popup.js');
  const taskBoxManifest = json(path.join(extension, 'manifest.json'));
  writeFileSync(backgroundFile, composeBrowserBackground(readFileSync(backgroundFile, 'utf8'), { appVersion: version }));
  writeFileSync(popupHtmlFile, composePopupHtml(readFileSync(popupHtmlFile, 'utf8'), { appVersion: version }));
  writeFileSync(popupJsFile, composePopupJs(readFileSync(popupJsFile, 'utf8'), { appVersion: version }));
  cpSync(path.join(browserFeatureRoot, 'extension'), extension, { recursive: true });
  writeJson(path.join(extension, 'manifest.json'), composeCombinedManifest(taskBoxManifest, officialManifest, version));

  const browserAddon = path.join(resources, 'rocaniiru-browser-control');
  rmSync(browserAddon, { recursive: true, force: true });
  cpSync(path.join(browserFeatureRoot, 'addon'), browserAddon, { recursive: true });

  const infoFile = updateInfoPlist(candidate, repacked.integrity);
  signMacOSBundle(candidate);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate]);

  if (featureBefore !== featureFingerprint() || built.featureFingerprint !== featureBefore) {
    throw new Error('BROWSER_CONTROL_PACKAGE_INPUT_CHANGED');
  }

  descriptor.candidate = {
    ...descriptor.candidate,
    bundleFingerprint: fingerprintTree(candidate),
    asarSha256: repacked.asarSha256,
    mainSha256: repacked.mainSha256,
    extensionSha256: fingerprintTree(extension),
    infoPlistSha256: sha256(readFileSync(infoFile))
  };
  descriptor.browserControl = {
    schema: 1,
    featureVersion: browserFeature.featureVersion,
    featureFingerprint: featureBefore,
    protocol: browserFeature.protocol,
    adapterRevision: browserFeature.adapterRevision,
    upstream: release,
    mainInsertedBytes: browserMain.insertedBytes + surfacedMain.insertedBytes,
    runtimeFingerprint: fingerprintTree(browserAddon),
    currentChromeProfileOnly: true,
    alternateProfileCreated: false,
    nativeDesktopFallback: false,
    foregroundEscalation: false,
    controlCapabilityGated: true,
    statusToolListAligned: true,
    debuggerPermissionActivation: 'human-required-on-first-enable',
    liveAcceptance: false
  };
  descriptor.requiresBrowserControlActivation = true;
  writeJson(descriptorPath, descriptor);
  return { candidate, descriptorPath, descriptor };
}

/** The shared TASK BOX stopped-app installer remains the only live app replacement boundary. */
export function applyCombinedAddon({ candidate, descriptorPath, appPath = DEFAULT_APP, oldClearDisabled = false } = {}) {
  validateBrowserDescriptor(json(descriptorPath));
  return applyTaskBoxAddon({ candidate, descriptorPath, appPath, oldClearDisabled });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const operation = args.shift();
  const opts = {};
  while (args.length) {
    const name = args.shift();
    if (name === '--old-clear-disabled') { opts.oldClearDisabled = true; continue; }
    const field = {
      '--app': 'appPath',
      '--output': 'outputRoot',
      '--candidate': 'candidate',
      '--descriptor': 'descriptorPath',
      '--base-descriptor': 'baseDescriptorPath'
    }[name];
    if (!field || !args[0] || args[0].startsWith('--')) throw new Error(`Invalid argument: ${name}`);
    opts[field] = args.shift();
  }
  try {
    if (operation === 'prepare') {
      console.log(JSON.stringify(await prepareCombinedAddon(opts), null, 2));
    } else if (operation === 'apply') {
      console.log(JSON.stringify(applyCombinedAddon(opts), null, 2));
    } else {
      throw new Error('Use prepare or apply. Prepare never changes the installed app or live Chrome extension.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
