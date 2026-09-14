import { feature, releaseFor } from './main-adapter.mjs';

const HANDLERS_SEAM = 'const HANDLERS = {\n';
const ACTIVITY_RESULT_SEAM = '    const result = await call(`/activity${query}`);\n';
const BRIDGE_PROTOCOL_PREFIX = 'const BRIDGE_PROTOCOL = ';

const BACKGROUND_BINDING = `// <RC-BROWSER-CONTROL:binding>\nconst __rcnirBrowserControlTransport = globalThis.CLFBrowserControlTransport?.bindBackground({\n  call,\n  cleanConversationId,\n  sessionStorage: chrome.storage.session\n}) || null;\nconst __rcnirBrowserControlDriver = globalThis.CLFBrowserControlDriver || null;\nfunction __rcnirBrowserControlPopupOwner(sender) {\n  return sender?.id === chrome.runtime.id && sender?.url === chrome.runtime.getURL('popup.html') &&\n    (sender.frameId === undefined || sender.frameId === 0);\n}\n// </RC-BROWSER-CONTROL:binding>\n\n`;

const BROWSER_HANDLERS = `  // <RC-BROWSER-CONTROL:handlers>\n  async browser_control_status(_message, sender) {\n    if (!__rcnirBrowserControlPopupOwner(sender) || !__rcnirBrowserControlDriver) return { ok: false, error: 'invalid_browser_control_owner' };\n    return { ok: true, ...(await __rcnirBrowserControlDriver.status()), transport: globalThis.CLFBrowserControlTransport?.status?.() || null };\n  },\n  async browser_control_detach(_message, sender) {\n    if (!__rcnirBrowserControlPopupOwner(sender) || !__rcnirBrowserControlDriver) return { ok: false, error: 'invalid_browser_control_owner' };\n    return { ok: true, ...(await __rcnirBrowserControlDriver.detach()) };\n  },\n  // </RC-BROWSER-CONTROL:handlers>\n`;

const ACTIVITY_POLL = `    // <RC-BROWSER-CONTROL:poll>\n    // Fire-and-forget: normal ChatGPT activity must never wait on browser automation. The closure\n    // re-proves this exact document/navigation immediately before command collection/execution.\n    // Result settlement from an action that already ran is still allowed after ownership moves.\n    const __rcnirBrowserControlStillOwns = () => ownsDocument(source);\n    if (__rcnirBrowserControlStillOwns() && result.ok && __rcnirBrowserControlTransport) {\n      void __rcnirBrowserControlTransport.poll(message.conversationId, __rcnirBrowserControlStillOwns);\n    }\n    // </RC-BROWSER-CONTROL:poll>\n`;

function fail(reason) {
  throw new Error(`BROWSER_CONTROL_EXTENSION_ADAPTER_${reason}`);
}

function count(source, needle) {
  let total = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    total += 1;
    offset += needle.length;
  }
  return total;
}

function requireUnique(source, needle, reason) {
  if (count(source, needle) !== 1) fail(reason);
}

function validateContract(source, appVersion) {
  if (typeof source !== 'string') fail('INVALID_SOURCE');
  if (/RC-BROWSER-CONTROL:|__rcnirBrowserControlTransport/.test(source)) fail('SOURCE_ALREADY_COMPOSED');
  const release = releaseFor(appVersion);
  const bridgeLine = `${BRIDGE_PROTOCOL_PREFIX}${release.bridgeProtocol};`;
  requireUnique(source, bridgeLine, 'BRIDGE_PROTOCOL_DRIFT');
  if (count(source, BRIDGE_PROTOCOL_PREFIX) !== 1) fail('BRIDGE_PROTOCOL_DRIFT');
  requireUnique(source, HANDLERS_SEAM, 'HANDLERS_SEAM_DRIFT');
  requireUnique(source, ACTIVITY_RESULT_SEAM, 'ACTIVITY_SEAM_DRIFT');
  requireUnique(source, 'async activity(message, _sender, source) {', 'ACTIVITY_SEAM_DRIFT');
}

/** Compose only thin hooks into the verified companion background source. */
export function composeBackground(source, { appVersion } = {}) {
  if (!Object.hasOwn(feature.releases, appVersion)) fail('UNSUPPORTED_APP_VERSION');
  validateContract(source, appVersion);
  let output = source.replace(HANDLERS_SEAM, `${BACKGROUND_BINDING}${HANDLERS_SEAM}${BROWSER_HANDLERS}`);
  output = output.replace(ACTIVITY_RESULT_SEAM, `${ACTIVITY_RESULT_SEAM}${ACTIVITY_POLL}`);
  return output;
}

/**
 * Wrapper ordering is load-bearing: transport first, driver second, official/combined worker last.
 * The driver registers exactly one executor into the Task 1 transport.
 */
export function workerWrapper(target = 'background.js') {
  if (typeof target !== 'string' || !/^[A-Za-z0-9._-]+\.js$/.test(target)) fail('INVALID_WORKER_TARGET');
  if (['browser-control-worker.js', 'browser-control-transport.js', 'browser-control-driver.js'].includes(target)) fail('INVALID_WORKER_TARGET');
  return `// Generated Browser Control wrapper.\nimport './browser-control-transport.js';\nimport './browser-control-driver.js';\nimport './${target}';\n`;
}

/**
 * `debugger` cannot be optional in Chrome. tabs/tabGroups remain optional and are requested only
 * from the popup's user gesture. No all-URLs host permission is added.
 */
export function composeManifest(original, { appVersion, worker = 'browser-control-worker.js' } = {}) {
  const release = releaseFor(appVersion);
  if (!original || typeof original !== 'object' || Array.isArray(original) || original.version !== appVersion ||
      original.background?.service_worker !== 'background.js' || original.background.type !== 'module') {
    fail('MANIFEST_CONTRACT_MISMATCH');
  }
  if (!Number.isSafeInteger(release.bridgeProtocol)) fail('INVALID_BRIDGE_CONTRACT');
  const out = structuredClone(original);
  out.permissions = [...new Set([...(Array.isArray(out.permissions) ? out.permissions : []), 'debugger'])];
  out.optional_permissions = [...new Set([...(Array.isArray(out.optional_permissions) ? out.optional_permissions : []), 'tabs', 'tabGroups'])];
  out.background = { service_worker: worker, type: 'module' };
  return out;
}
