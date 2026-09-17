import { feature, releaseFor } from './main-adapter.mjs';
const TASK_BOX_PROTOCOL = feature.protocol;

const LISTENER_SEAM = 'chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {\n';
const HEALTHY_RESTORE_SEAM = `        // The tab can navigate between the ping and repair. Static injection covers it.
      }
      return true;
`;
const RECOVERY_RESTORE_SEAM = `    await chrome.scripting.insertCSS({ target: { tabId: id }, files: ['overlay.css'] });
    // Successful injection means this exact tab is recovering. Its document registration will
`;
const RESTORE_FUNCTION_SEAM = 'async function restoreOpenChatgptTabs() {\n';
const ACTIVITY_RESTORE_SEAM = `  async activity(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    await noteTabConversation(source, message.conversationId);
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
`;

const AUTHORIZE_DOCUMENT_CONTRACT = `async function authorizeDocument(sender, message) {
  await load();
  const id = tabId(sender);
  const documentId = senderDocument(sender);
  if (id === null || !documentId) return { ok: false, error: 'document_identity_missing' };
  const key = String(id);
  const retired = Array.isArray(retiredDocuments[key]) ? retiredDocuments[key] : [];
  if (retired.includes(documentId)) return { ok: false, error: 'stale_document' };
  const current = typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null;
  const requestedEpoch = messageEpoch(message);
  const currentEpoch = Number.isSafeInteger(tabEpochs[key]) ? tabEpochs[key] : 0;
  let terminal = Object.prototype.hasOwnProperty.call(terminalDocuments, key);
  if (terminal && (await terminalPredictionWrong(id, key, documentId))) {
    delete terminalDocuments[key];
    terminal = false;
    await persistLive();
  }
  if (terminal) {
    return { ok: false, error: !current || current === documentId ? 'tab_closed' : 'document_unregistered' };
  }
  if (current === documentId && !terminal) {
    if (requestedEpoch < currentEpoch) return { ok: false, error: 'stale_navigation' };
    if (requestedEpoch > currentEpoch) {
      tabEpochs[key] = requestedEpoch;
      await persistLive();
    }
    return { ok: true, tab: id, documentId, navigationEpoch: requestedEpoch };
  }
  if (current && current !== documentId) {
    retiredDocuments[key] = [...new Set([...retired, current])].slice(-8);
  }
  tabDocuments[key] = documentId;
  tabEpochs[key] = requestedEpoch;
  delete terminalDocuments[key];
  await persistLive();
  return { ok: true, tab: id, documentId, navigationEpoch: requestedEpoch };
}`;

const OWNS_DOCUMENT_CONTRACT = `function ownsDocument(source) {
  if (!source || !Number.isInteger(source.tab) || !source.documentId) return false;
  const key = String(source.tab);
  return (
    tabDocuments[key] === source.documentId &&
    (!Number.isSafeInteger(source.navigationEpoch) || tabEpochs[key] === source.navigationEpoch) &&
    !Object.prototype.hasOwnProperty.call(terminalDocuments, key) &&
    !(Array.isArray(retiredDocuments[key]) && retiredDocuments[key].includes(source.documentId))
  );
}`;

const SERIALIZE_TAB_CONTRACT = `function serializeTab(tab, operation) {
  if (!Number.isInteger(tab)) return operation();
  const prior = tabOperationQueues.get(tab) || Promise.resolve();
  const current = prior.then(operation, operation);
  const tracked = current.finally(() => {
    if (tabOperationQueues.get(tab) === tracked) tabOperationQueues.delete(tab);
  });
  tabOperationQueues.set(tab, tracked);
  return tracked;
}`;

const CONVERSATION_FOR_TAB_CONTRACT = `function conversationForTab(tab) {
  if (!tab || typeof tab.id !== 'number') return null;
  const current = conversationFromUrl(tab.url);
  if (current) return current;
  const pending = conversationFromUrl(tab.pendingUrl);
  if (pending) return pending;
  const urls = [tab.url, tab.pendingUrl].filter((value) => typeof value === 'string' && value);
  if (urls.some((value) => !isChatGptUrl(value))) return null;
  return cleanConversationId(tabConversations[String(tab.id)]);
}`;

function fail(reason) {
  throw new Error(`TASK_BOX_EXTENSION_ADAPTER_${reason}`);
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

function topLevelFunction(source, signature, reason) {
  requireUnique(source, signature, reason);
  const start = source.indexOf(signature);
  const end = source.indexOf('\n}\n\n', start);
  if (end === -1) fail(reason);
  return source.slice(start, end + 2);
}

function validateContract(source, appVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(appVersion);
  if (!match) fail('INVALID_APP_VERSION');
  if (Number(match[1]) !== 2) fail('UNSUPPORTED_APP_MAJOR');
  let contract;
  try { contract = releaseFor(appVersion); } catch { fail('UNSUPPORTED_APP_VERSION'); }
  if (/CLFTaskBoxBackground|taskBoxSetupQueue|restoreTaskBoxTab|TASK-BOX-ADAPTER:/.test(source)) {
    fail('SOURCE_ALREADY_COMPOSED');
  }

  requireUnique(source, `const BRIDGE_PROTOCOL = ${contract.bridgeProtocol};`, 'SOURCE_VERSION_DRIFT');
  if (count(source, 'const BRIDGE_PROTOCOL = ') !== 1) fail('SOURCE_VERSION_DRIFT');

  const authenticatedCall = topLevelFunction(source, 'async function call(path, init = {}, retried = false) {', 'AUTH_DRIFT');
  requireUnique(authenticatedCall, 'authorization: `Bearer ${token}`', 'AUTH_DRIFT');
  requireUnique(authenticatedCall, '...versionHeaders(),', 'AUTH_DRIFT');
  requireUnique(authenticatedCall, 'const response = await fetchBounded(', 'AUTH_DRIFT');

  requireUnique(source, AUTHORIZE_DOCUMENT_CONTRACT, 'DOCUMENT_GUARD_DRIFT');
  requireUnique(source, OWNS_DOCUMENT_CONTRACT, 'DOCUMENT_GUARD_DRIFT');
  requireUnique(source, SERIALIZE_TAB_CONTRACT, 'DOCUMENT_GUARD_DRIFT');
  requireUnique(source, CONVERSATION_FOR_TAB_CONTRACT, 'CONVERSATION_GUARD_DRIFT');

  requireUnique(source, LISTENER_SEAM, 'MESSAGE_LISTENER_SEAM_DRIFT');
  requireUnique(source, HEALTHY_RESTORE_SEAM, 'HEALTHY_RESTORE_SEAM_DRIFT');
  requireUnique(source, RECOVERY_RESTORE_SEAM, 'RECOVERY_RESTORE_SEAM_DRIFT');
  requireUnique(source, RESTORE_FUNCTION_SEAM, 'RESTORE_FUNCTION_SEAM_DRIFT');
  requireUnique(source, ACTIVITY_RESTORE_SEAM, 'ACTIVITY_SEAM_DRIFT');
}

function validateFeatureContract(featureVersion, protocol) {
  if (typeof featureVersion !== 'string' || featureVersion.length < 1 || featureVersion.length > 96 ||
      !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(featureVersion)) fail('INVALID_FEATURE_VERSION');
  if (protocol !== TASK_BOX_PROTOCOL) fail('UNSUPPORTED_TASK_BOX_PROTOCOL');
}

function setupBlock({ appVersion, featureVersion, protocol }) {
  return `// <TASK-BOX-ADAPTER:setup>
const TASK_BOX_CONTRACT = Object.freeze({appVersion:${JSON.stringify(appVersion)},featureVersion:${JSON.stringify(featureVersion)},protocol:${protocol}});
const taskBoxCandidate = globalThis.CLFTaskBoxBackground?.registerTaskBox({chrome,call,...TASK_BOX_CONTRACT}) || null;
const taskBox = taskBoxCandidate?.protocol === TASK_BOX_CONTRACT.protocol ? taskBoxCandidate : null;

let taskBoxSetupQueue = Promise.resolve();
async function taskBoxSetup(message,sender) {
  // Extension-origin setup only; this is never a content-script rearm API.
  if (!taskBox || sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL('task-box-setup.html') ||
      (sender.frameId !== undefined && sender.frameId !== 0)) return {ok:false,error:'invalid_setup_owner'};
  const state=await chrome.storage.local.get(['taskBoxIntegrationEnabled','taskBoxCreationGlobal','taskBoxCutoverReceipt']);
  const lifecycle=state.taskBoxCreationGlobal;

  if (message.type === 'clf-task-box-setup:recover-manual-delete') {
    if (message.previousOutcomeReviewed !== true || message.manualProjectDeletionConfirmed !== true ||
        typeof message.requestId !== 'string' || !Number.isInteger(message.generation) || message.generation < 0) {
      return {ok:false,error:'TASK_BOX_MANUAL_RECOVERY_CONFIRMATION_REQUIRED'};
    }
    return taskBox.recoverManualDeletion(message.requestId,message.generation);
  }

  if (lifecycle?.state === 'reserved' && lifecycle.mode === 'cleanup' &&
      typeof lifecycle.requestId === 'string' && Number.isInteger(lifecycle.generation) && lifecycle.generation > 0) {
    if (message.type === 'clf-task-box-setup:recover-cleanup') {
      if (message.previousOutcomeReviewed !== true || message.inactiveRepairTabApproved !== true ||
          message.requestId !== lifecycle.requestId || message.generation !== lifecycle.generation) {
        return {ok:false,error:'TASK_BOX_CLEANUP_RECOVERY_CONFIRMATION_REQUIRED'};
      }
      return taskBox.recoverCleanupReservation(message.requestId,message.generation);
    }
    if (message.type !== 'clf-task-box-setup:status') return {ok:false,error:'TASK_BOX_LIFECYCLE_BLOCKED'};
    const cleanup=await taskBox.cleanupRecoveryStatus(lifecycle.requestId,lifecycle.generation);
    if (cleanup?.ok !== true || cleanup.recoveryRequired !== true) {
      return {ok:false,error:cleanup?.error || 'TASK_BOX_LIFECYCLE_BLOCKED'};
    }
    return {ok:true,available:true,enabled:state.taskBoxIntegrationEnabled === true,cleanupRecoveryRequired:true,
      cleanupRecoveryRequestId:cleanup.requestId,cleanupRecoveryGeneration:cleanup.generation,error:null};
  }

  if (lifecycle !== undefined && !['open','present'].includes(lifecycle?.state)) {
    if (message.type !== 'clf-task-box-setup:status' || lifecycle?.state !== 'deleting' || lifecycle.kind !== 'clear' ||
        lifecycle.clearCompleted !== true || typeof lifecycle.requestId !== 'string' ||
        !Number.isInteger(lifecycle.generation) || lifecycle.generation < 0) {
      return {ok:false,error:'TASK_BOX_LIFECYCLE_BLOCKED'};
    }
    const recovery=await taskBox.manualDeletionRecoveryStatus(lifecycle.requestId,lifecycle.generation);
    if (recovery?.ok !== true || recovery.recoveryRequired !== true ||
        recovery.requestId !== lifecycle.requestId || recovery.generation !== lifecycle.generation) {
      return {ok:false,error:'TASK_BOX_LIFECYCLE_BLOCKED'};
    }
    return {ok:true,available:true,enabled:state.taskBoxIntegrationEnabled === true,recoveryRequired:true,
      recoveryRequestId:recovery.requestId,recoveryGeneration:recovery.generation,error:null};
  }

  const capability=await call('/task-box/capabilities');
  const available=capability?.ok === true && capability.data?.protocol === TASK_BOX_CONTRACT.protocol && capability.data.supported === true &&
    capability.data.atMostOnce === true && capability.data.durableReceipts === true;
  if (message.type === 'clf-task-box-setup:status') {
    return {ok:true,available,enabled:state.taskBoxIntegrationEnabled === true,
      error:available ? null : '対応するアプリの直接Clear接続が未反映です。'};
  }
  if (message.type !== 'clf-task-box-setup:enable' || !available || message.oldExtensionDisabled !== true || message.previousOutcomeReviewed !== true) {
    return {ok:false,error:'TASK_BOX_CUTOVER_CONFIRMATION_REQUIRED'};
  }
  if (state.taskBoxIntegrationEnabled === true) return {ok:true,enabled:true};
  // Reread after the authenticated capability await; setup may not conceal pending work.
  const latest=await chrome.storage.local.get('taskBoxCreationGlobal');
  if (JSON.stringify(latest.taskBoxCreationGlobal) !== JSON.stringify(lifecycle)) return {ok:false,error:'TASK_BOX_STATE_CHANGED'};
  await chrome.storage.local.set({taskBoxIntegrationEnabled:true,taskBoxCutoverReceipt:{
    protocol:TASK_BOX_CONTRACT.protocol,acknowledgedAt:new Date().toISOString(),oldExtensionDisabled:'human-attested',
    previousOutcomeReviewed:true,legacyOperationReplayed:false,legacyOperationDeclaredComplete:false
  }});
  return {ok:true,enabled:true};
}
// </TASK-BOX-ADAPTER:setup>

`;
}

function dispatchBlock() {
  return `  // <TASK-BOX-ADAPTER:dispatch>
  if (typeof message?.type === 'string' && message.type.startsWith('clf-task-box-setup:')) {
    const work=taskBoxSetupQueue.then(()=>taskBoxSetup(message,sender));
    taskBoxSetupQueue=work.catch(()=>{});
    work.then(sendResponse,error=>sendResponse({ok:false,error:String(error?.message || error)}));
    return true;
  }
  if (taskBox?.handles(message?.type)) {
    // Owned content-document messages only. No external-extension or page bridge.
    serializeTab(tabId(sender),async () => {
      await load();
      // Reuse the official registry epoch while Chrome document identity remains authoritative.
      const source=await authorizeDocument(sender,{navigationEpoch:tabEpochs[String(tabId(sender))] ?? 0});
      if (!source.ok || !ownsDocument(source)) return {ok:false,protocol:taskBox.protocol,error:source.error || 'stale_document'};
      // TASK BOX does not own a second conversation registry. Resolve action-time identity through
      // the companion's existing current-tab arbitration, including its root/id-less fallback.
      const currentConversation=async()=>{
        if (!ownsDocument(source)) return null;
        let tab;
        try { tab=await chrome.tabs.get(source.tab); } catch { return null; }
        if (!ownsDocument(source)) return null;
        return conversationForTab(tab);
      };
      const reply=await taskBox.handle(message,sender,()=>ownsDocument(source),currentConversation);
      if (!ownsDocument(source)) return {ok:false,protocol:taskBox.protocol,error:'stale_document'};
      return reply;
    }).then(sendResponse, error =>
      sendResponse({ok:false,protocol:taskBox.protocol,error:String(error?.message || error)}));
    return true;
  }
  // </TASK-BOX-ADAPTER:dispatch>
`;
}

function restoreFunctionBlock() {
  return `// <TASK-BOX-ADAPTER:restore-function>
async function restoreTaskBoxTab(id) {
  if (!taskBox) return;
  // Recorder recovery does not activate TASK BOX; it only repairs an already-enabled feature.
  try {
    const stored = await chrome.storage.local.get('taskBoxIntegrationEnabled');
    if (stored.taskBoxIntegrationEnabled !== true) return;
    await chrome.scripting.executeScript({target:{tabId:id},files:['task-box-compatibility.js','task-box-core.js','task-box.js']});
  } catch {
    // Optional feature recovery must not make the official recorder unhealthy.
  }
}
// </TASK-BOX-ADAPTER:restore-function>

`;
}

/**
 * Compose TASK BOX into an unmodified supported official extension/background.js source.
 *
 * This transform intentionally owns no filesystem I/O. The caller is responsible for placing
 * the returned bytes and for making task-box-worker.js import the patcher-owned feature globals
 * before importing this composed background module.
 */
export function composeBackground(source, { appVersion, featureVersion, protocol } = {}) {
  if (typeof source !== 'string') fail('INVALID_SOURCE');
  validateFeatureContract(featureVersion, protocol);
  validateContract(source, appVersion);

  let output = source;
  output = output.replace(LISTENER_SEAM, `${setupBlock({ appVersion, featureVersion, protocol })}${LISTENER_SEAM}${dispatchBlock()}`);
  output = output.replace(
    HEALTHY_RESTORE_SEAM,
    HEALTHY_RESTORE_SEAM.replace('      return true;\n', `      // <TASK-BOX-ADAPTER:restore-healthy>
      await restoreTaskBoxTab(id);
      // </TASK-BOX-ADAPTER:restore-healthy>
      return true;
`)
  );
  output = output.replace(
    RECOVERY_RESTORE_SEAM,
    `    await chrome.scripting.insertCSS({ target: { tabId: id }, files: ['overlay.css'] });
    // <TASK-BOX-ADAPTER:restore-recovery>
    await restoreTaskBoxTab(id);
    // </TASK-BOX-ADAPTER:restore-recovery>
    // Successful injection means this exact tab is recovering. Its document registration will
`
  );
  output = output.replace(RESTORE_FUNCTION_SEAM, `${restoreFunctionBlock()}${RESTORE_FUNCTION_SEAM}`);
  output = output.replace(
    ACTIVITY_RESTORE_SEAM,
    `${ACTIVITY_RESTORE_SEAM}    // <TASK-BOX-ADAPTER:restore-activity>\n    await restoreTaskBoxTab(source.tab);\n    // </TASK-BOX-ADAPTER:restore-activity>\n`
  );
  return output;
}
