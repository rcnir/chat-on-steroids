import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import asarImport from '@electron/asar';
import plistImport from 'plist';
import { feature, inspectMainSeams } from './main-adapter.mjs';
import { fingerprintTree } from '../../scripts/rocaniiru-task-box-package.mjs';

const asar = asarImport?.default ?? asarImport;
const plist = plistImport?.default ?? plistImport;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(HERE, '../..');
const DEFAULT_APP = '/Applications/Chat On Steroids.app';
const MAIN = 'out/main/index.js';
const DESKTOP_SOURCE = 'native/macos-desktop-helper/main.swift';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));

function runMaybe(command, args, options = {}) {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim(); }
  catch { return null; }
}

function runRawMaybe(command, args, options = {}) {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }); }
  catch { return null; }
}

function bridgeProtocolFromBackground(source) {
  const matches = [...source.matchAll(/const BRIDGE_PROTOCOL = (\d+);/g)];
  if (matches.length !== 1) return null;
  const value = Number(matches[0][1]);
  return Number.isSafeInteger(value) ? value : null;
}

function count(source, needle) {
  return source.split(needle).length - 1;
}

function functionBlock(source, signature) {
  if (count(source, signature) !== 1) return null;
  const start = source.indexOf(signature);
  const brace = start + signature.length - 1;
  if (signature.at(-1) !== '{' || source[brace] !== '{') return null;
  if (brace < 0) return null;
  let depth = 0;
  for (let at = brace; at < source.length; at += 1) {
    if (source[at] === '{') depth += 1;
    else if (source[at] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, at + 1);
    }
  }
  return null;
}

function stateFromMarkers(source, beforeMarkers, afterMarkers) {
  const before = beforeMarkers.every(marker => count(source, marker) === 1);
  const after = afterMarkers.every(marker => count(source, marker) === 1);
  if (before && !after) return 'needs-patch';
  if (!before && after) return 'absorbed-or-already-patched';
  return 'changed';
}

function inspectMainCompatibility(main) {
  let baseSeams = true;
  let baseSeamError = null;
  try { inspectMainSeams(main); }
  catch (error) {
    baseSeams = false;
    baseSeamError = error instanceof Error ? error.message : String(error);
  }
  const claim = functionBlock(main, 'function claimPluginRefresh(input2) {') || '';
  return {
    baseSeams,
    baseSeamError,
    refreshPendingRecovery: stateFromMarkers(main,
      ['&& !row2.attempted && !row2.manual && row2.completedSchemaId !== row2.schemaId'],
      ['verifyOnly: true']),
    refreshCurrentReconciliation: stateFromMarkers(claim,
      ['if (!row2 || row2.attempted || row2.manual || row2.completedSchemaId === row2.schemaId'],
      ['if (input2.alreadyCurrent === true) {', 'row2.completedSchemaId = row2.schemaId;']),
    mcpToolActivityHistory: stateFromMarkers(main,
      ['const surfaceToolCallAt = /* @__PURE__ */ new Map();'],
      ['const historicalSurfaceToolCallAt = /* @__PURE__ */ new Map();']),
    mcpToolActivityNote: stateFromMarkers(main,
      ['surfaceToolCallAt.set(surface, Date.now());'],
      ['noteMcpActivity("tool", surface, surfaceToolSeenAt);']),
    mcpRequestActivityHistory: stateFromMarkers(main,
      ['const surfaceRequestAt = /* @__PURE__ */ new Map();'],
      ['const historicalSurfaceRequestAt = /* @__PURE__ */ new Map();']),
    mcpRequestActivityNote: stateFromMarkers(main,
      ['surfaceRequestAt.set(route.id, requestSeenAt);'],
      ['noteMcpActivity("request", route.id, requestSeenAt);']),
    mcpActivityRestore: stateFromMarkers(main,
      ['initDurableStore(userData);\n  await restoreChatModels();'],
      ['restoreMcpActivity(await readDurable("mcp-activity"));'])
  };
}

function inspectExtensionContract(background, bridgeProtocol) {
  if (!Number.isSafeInteger(bridgeProtocol)) return { compatibleShape: false, error: 'BRIDGE_PROTOCOL_NOT_UNIQUELY_OBSERVED' };
  const call = functionBlock(background, 'async function call(path, init = {}, retried = false) {');
  if (!call) return { compatibleShape: false, error: 'CHANGED_EXTENSION_CONTRACT:call' };
  const callRequired = [
    'authorization: `Bearer ${token}`',
    '...versionHeaders(),',
    'const response = await fetchBounded('
  ];
  if (callRequired.some(marker => count(call, marker) !== 1)) {
    return { compatibleShape: false, error: 'CHANGED_EXTENSION_CONTRACT:call-body' };
  }
  const required = [
    `const BRIDGE_PROTOCOL = ${bridgeProtocol};`,
    'async function call(path, init = {}, retried = false) {',
    'async function authorizeDocument(sender, message) {',
    'function ownsDocument(source) {',
    'function serializeTab(tab, operation) {',
    'function conversationForTab(tab) {',
    'chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {',
    'async function restoreOpenChatgptTabs() {'
  ];
  const missing = required.filter(marker => count(background, marker) !== 1);
  return missing.length === 0
    ? { compatibleShape: true, error: null }
    : { compatibleShape: false, error: `CHANGED_EXTENSION_CONTRACT:${missing.length}` };
}

function probePluginRefresh(background, content, chatgptDom) {
  const backgroundOld = [
    "url.origin === 'https://chatgpt.com' && url.pathname === '/' && /^#settings\\/Plugins",
    'https://chatgpt.com/?cos-plugin-refresh=${request.id}#settings/Plugins',
    'const requests = pending.data.requests.slice(0, 2);'
  ].every(marker => count(background, marker) === 1);
  const contentOld = count(content, '  function ownsPluginRefreshPage(id) {') === 1 &&
    count(content, '  async function refreshManagedPlugin(request) {') === 1 &&
    !content.includes('function pluginRefreshRoute(id)');
  const domOld = count(chatgptDom, '  function pluginInstalledButtons(connectorName) {') === 1 &&
    count(chatgptDom, '    pluginInstalledButtons,') === 1;
  const result = applicable => applicable
    ? { applicable: true, error: null }
    : { applicable: false, error: 'CURRENT_ADAPTER_SEAM_CHANGED_OR_ABSORBED' };
  return { background: result(backgroundOld), content: result(contentOld), chatgptDom: result(domOld) };
}

export function inspectReleaseCompatibilityEvidence({ main, background, content, chatgptDom, bridgeProtocol }) {
  return {
    main: inspectMainCompatibility(main),
    extensionContract: inspectExtensionContract(background, bridgeProtocol),
    pluginRefresh: probePluginRefresh(background, content, chatgptDom)
  };
}

function localTagEvidence(repoRoot, version) {
  const commit = runMaybe('/usr/bin/git', ['rev-parse', '--verify', `refs/tags/v${version}^{commit}`], { cwd: repoRoot });
  if (!commit) return { available: false, commit: null, desktopSourceSha256: null, sameAs209DesktopSource: null };
  const desktop = runRawMaybe('/usr/bin/git', ['show', `${commit}:${DESKTOP_SOURCE}`], { cwd: repoRoot });
  const desktopSourceSha256 = desktop === null ? null : sha256(desktop);
  return {
    available: true,
    commit,
    desktopSourceSha256,
    sameAs209DesktopSource: desktopSourceSha256 && feature.releases?.['2.0.9']?.desktopSourceSha256
      ? desktopSourceSha256 === feature.releases['2.0.9'].desktopSourceSha256
      : null
  };
}

/** Read-only evidence capture. This never adds a release to feature.json and never prepares/applies a candidate. */
export function inspectReleaseIntake({ appPath = DEFAULT_APP, repoRoot = DEFAULT_REPO } = {}) {
  const app = path.resolve(appPath);
  const resources = path.join(app, 'Contents', 'Resources');
  const info = plist.parse(readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8'));
  const version = String(info.CFBundleShortVersionString || '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`TASK_BOX_RELEASE_INTAKE_BAD_VERSION: ${version}`);
  const archive = path.join(resources, 'app.asar');
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  if (packaged.version !== version) throw new Error('TASK_BOX_RELEASE_INTAKE_APP_VERSION_MISMATCH');

  const originalRoot = path.join(resources, 'rocaniiru-task-box', 'original');
  const embeddedOriginal = existsSync(path.join(originalRoot, 'main.js')) && existsSync(path.join(originalRoot, 'extension', 'manifest.json'));
  const extension = embeddedOriginal ? path.join(originalRoot, 'extension') : path.join(resources, 'extension');
  const main = embeddedOriginal ? readFileSync(path.join(originalRoot, 'main.js'), 'utf8') : asar.extractFile(archive, MAIN).toString();
  const manifest = json(path.join(extension, 'manifest.json'));
  if (manifest.version !== version) throw new Error('TASK_BOX_RELEASE_INTAKE_EXTENSION_VERSION_MISMATCH');
  const background = readFileSync(path.join(extension, 'background.js'), 'utf8');
  const content = readFileSync(path.join(extension, 'content.js'), 'utf8');
  const chatgptDom = readFileSync(path.join(extension, 'chatgpt-dom.js'), 'utf8');
  const bridgeProtocol = bridgeProtocolFromBackground(background);
  const extensionFingerprint = fingerprintTree(extension);
  const known = feature.releases?.[version] ?? null;
  const tag = localTagEvidence(repoRoot, version);
  const architecture = runMaybe('/usr/bin/lipo', ['-archs', path.join(app, 'Contents', 'MacOS', 'Chat On Steroids')]);

  return {
    schema: 1,
    kind: 'rocaniiru-cos-release-intake',
    observedAt: new Date().toISOString(),
    authority: known ? 'catalogued-evidence-check' : 'review-required',
    version,
    sourceKind: embeddedOriginal ? 'embedded-official-provenance' : 'installed-bundle',
    architecture,
    installedBundleFingerprint: fingerprintTree(app),
    source: {
      mainSha256: sha256(main),
      extensionFingerprint,
      bridgeProtocol
    },
    catalog: known ? {
      mainMatches: known.mainSha256 === sha256(main),
      extensionMatches: known.extensionFingerprint === extensionFingerprint,
      bridgeProtocolMatches: known.bridgeProtocol === bridgeProtocol,
      release: known
    } : null,
    localTag: tag,
    compatibilityEvidence: {
      ...inspectReleaseCompatibilityEvidence({ main, background, content, chatgptDom, bridgeProtocol }),
      desktop: tag.available
        ? { review: tag.desktopSourceSha256 === null ? 'source-missing' : tag.sameAs209DesktopSource ? 'same-as-2.0.9-source' : 'source-changed' }
        : { review: 'fetch-release-tag-required' }
    },
    missingAuthority: known ? [] : ['published archive digest', 'explicit feature.json release entry', 'candidate tests', 'live acceptance']
  };
}

function cli(argv) {
  const options = { appPath: DEFAULT_APP, repoRoot: DEFAULT_REPO, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--app') options.appPath = argv[++index];
    else if (arg === '--repo') options.repoRoot = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const receipt = inspectReleaseIntake(options);
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  if (options.output) writeFileSync(options.output, text, { mode: 0o600 });
  else process.stdout.write(text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
