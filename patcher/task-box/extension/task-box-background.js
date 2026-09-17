(() => {
  'use strict';

  const PROTOCOL = 1;
  const COMPANION_VERSION = globalThis.CLFTaskBoxCompatibility?.appVersion;
  const FEATURE_KEY = 'taskBoxIntegrationEnabled';
  const PREFIX = 'clf-task-box:';
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const CONVERSATION_ID = /^[0-9a-f-]{36}$/i;

  const reply = value => ({protocol:PROTOCOL,...value});
  const validRequest = value => typeof value === 'string' && UUID_V4.test(value);

  function registerTaskBox({chrome,call}) {
    if (!chrome?.storage?.local || typeof call !== 'function') throw new TypeError('chrome storage and call required');
    if (!globalThis.CLFTaskBoxCoordinator?.create) throw new Error('TASK_BOX_COORDINATOR_MISSING');
    const coordinator = globalThis.CLFTaskBoxCoordinator.create(chrome.storage.local);
    const GLOBAL_KEY = globalThis.CLFTaskBoxCoordinator.GLOBAL_KEY;

    const handles = type => typeof type === 'string' && type.startsWith(PREFIX);

    function ownerFor(sender) {
      let url;
      try { url = new URL(sender?.url || ''); } catch { return null; }
      if (url.origin !== 'https://chatgpt.com' || sender?.frameId !== 0 ||
          !Number.isInteger(sender?.tab?.id) || sender.tab.id < 0 ||
          typeof sender?.documentId !== 'string' || !sender.documentId) return null;
      return {tabId:sender.tab.id,documentId:sender.documentId};
    }

    async function enabled() {
      if (typeof COMPANION_VERSION !== 'string' || globalThis.CLFTaskBoxCompatibility?.protocol !== PROTOCOL) return false;
      let version;
      try { version = chrome.runtime?.getManifest?.().version; } catch { return false; }
      if (version !== COMPANION_VERSION) return false;
      const stored = await chrome.storage.local.get(FEATURE_KEY);
      return stored?.[FEATURE_KEY] === true;
    }

    async function capabilitiesReady() {
      const result = await call('/task-box/capabilities', {method:'GET'});
      const data = result?.ok === true ? result.data : null;
      return Boolean(data && data.protocol === PROTOCOL && data.supported === true &&
        data.atMostOnce === true && data.durableReceipts === true);
    }

    function exactCompleted(result,requestId) {
      const data = result?.ok === true ? result.data : null;
      return Boolean(data && data.ok === true && data.status === 'completed' &&
        data.requestId === requestId && data.protocol === PROTOCOL);
    }

    function validClearTicket(ticket) {
      if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return false;
      const keys = Object.keys(ticket).sort();
      if (keys.length !== 3 || keys[0] !== 'generation' || keys[1] !== 'kind' || keys[2] !== 'requestId') return false;
      return Number.isInteger(ticket.generation) && ticket.generation >= 0 && ticket.kind === 'clear' && validRequest(ticket.requestId);
    }

    const sameOwner = (left,right) => left?.tabId === right?.tabId && left?.documentId === right?.documentId;

    async function manualDeletionRecoveryStatus(requestId,generation) {
      if (!validRequest(requestId) || !Number.isInteger(generation) || generation < 0) {
        return reply({ok:false,error:'TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE'});
      }
      const before = await coordinator.manualDeletionRecoveryStatus(requestId,generation);
      if (!before.ok) return reply(before);
      if (before.alreadyRecovered) {
        return reply({ok:true,recovered:true,alreadyRecovered:true,state:'open',generation:before.generation});
      }
      if (!(await enabled())) return reply({ok:false,error:'TASK_BOX_DISABLED'});
      if (!(await capabilitiesReady())) return reply({ok:false,error:'TASK_BOX_CAPABILITY_UNAVAILABLE'});

      // The old ChatGPT document is intentionally not revived as an owner. Its stored owner is
      // used only to bind a read-only app receipt lookup to the exact Clear that already finished.
      const afterCapability = await coordinator.manualDeletionRecoveryStatus(requestId,generation);
      if (!afterCapability.ok || afterCapability.alreadyRecovered || !sameOwner(afterCapability.owner,before.owner)) {
        return reply({ok:false,error:'TASK_BOX_STATE_CHANGED'});
      }
      const query = new URLSearchParams({
        requestId,
        tabId:String(before.owner.tabId),
        documentId:before.owner.documentId
      });
      const result = await call(`/task-box/clear/status?${query.toString()}`, {method:'GET'});
      if (!exactCompleted(result,requestId)) {
        return reply({ok:false,error:'TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE'});
      }
      if (!(await enabled())) return reply({ok:false,error:'TASK_BOX_DISABLED'});
      const afterReceipt = await coordinator.manualDeletionRecoveryStatus(requestId,generation);
      if (!afterReceipt.ok || afterReceipt.alreadyRecovered || !sameOwner(afterReceipt.owner,before.owner)) {
        return reply({ok:false,error:'TASK_BOX_STATE_CHANGED'});
      }
      return reply({ok:true,recoveryRequired:true,requestId,generation});
    }

    async function recoverManualDeletion(requestId,generation) {
      const verified = await manualDeletionRecoveryStatus(requestId,generation);
      if (!verified.ok || verified.alreadyRecovered) return verified;
      if (verified.recoveryRequired !== true) {
        return reply({ok:false,error:'TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE'});
      }
      const recovered = await coordinator.recoverManualDeletion(requestId,generation);
      return reply(recovered);
    }

    async function exactDocumentAlive(owner) {
      if (!owner || !Number.isInteger(owner.tabId) || typeof owner.documentId !== 'string' || !owner.documentId) return false;
      try {
        const response = await chrome.tabs.sendMessage(
          owner.tabId,
          {type:'clf-task-box-recovery:ping',protocol:PROTOCOL},
          {documentId:owner.documentId}
        );
        return response?.ok === true && response.protocol === PROTOCOL;
      } catch {
        return false;
      }
    }

    async function cleanupRecoveryStatus(requestId,generation) {
      if (!validRequest(requestId) || !Number.isInteger(generation) || generation < 1) {
        return reply({ok:false,error:'TASK_BOX_CLEANUP_RECOVERY_NOT_AVAILABLE'});
      }
      const before = await coordinator.cleanupRecoveryStatus(requestId,generation);
      if (!before.ok) return reply(before);
      if (before.alreadyRecovered) {
        return reply({ok:true,recovered:true,alreadyRecovered:true,state:'present',generation});
      }
      if (before.claimed) {
        return reply({
          ok:true,recoveryRequired:true,recoveryClaimed:true,requestId,generation,owner:before.owner,ticket:before.ticket
        });
      }
      if (!(await enabled())) return reply({ok:false,error:'TASK_BOX_DISABLED'});
      if (!(await capabilitiesReady())) return reply({ok:false,error:'TASK_BOX_CAPABILITY_UNAVAILABLE'});

      const afterCapability = await coordinator.cleanupRecoveryStatus(requestId,generation);
      if (!afterCapability.ok || afterCapability.claimed || afterCapability.alreadyRecovered ||
          !sameOwner(afterCapability.owner,before.owner)) {
        return reply({ok:false,error:'TASK_BOX_STATE_CHANGED'});
      }
      const query = new URLSearchParams({
        requestId,
        tabId:String(before.owner.tabId),
        documentId:before.owner.documentId
      });
      const result = await call(`/task-box/clear/status?${query.toString()}`, {method:'GET'});
      if (!exactCompleted(result,requestId)) {
        return reply({ok:false,error:'TASK_BOX_CLEANUP_RECOVERY_NOT_AVAILABLE'});
      }
      if (await exactDocumentAlive(before.owner)) {
        return reply({ok:false,error:'TASK_BOX_CLEANUP_OWNER_STILL_LIVE'});
      }
      const afterReceipt = await coordinator.cleanupRecoveryStatus(requestId,generation);
      if (!afterReceipt.ok || afterReceipt.claimed || afterReceipt.alreadyRecovered ||
          !sameOwner(afterReceipt.owner,before.owner)) {
        return reply({ok:false,error:'TASK_BOX_STATE_CHANGED'});
      }
      return reply({ok:true,recoveryRequired:true,requestId,generation,orphanedOwner:before.owner});
    }

    async function claimCleanupRecovery(owner,requestId,generation) {
      const verified = await cleanupRecoveryStatus(requestId,generation);
      if (!verified.ok || verified.alreadyRecovered) return verified;
      if (verified.recoveryClaimed) {
        if (!sameOwner(verified.owner,owner)) return reply({ok:false,error:'TASK_BOX_CLEANUP_RECOVERY_CLAIMED'});
        return verified;
      }
      if (verified.recoveryRequired !== true) {
        return reply({ok:false,error:'TASK_BOX_CLEANUP_RECOVERY_NOT_AVAILABLE'});
      }
      return reply(await coordinator.claimCleanupRecovery(owner,requestId,generation));
    }

    const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

    async function waitForRepairTab(tabId) {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          const tab = await chrome.tabs.get(tabId);
          const address = String(tab?.pendingUrl || tab?.url || '');
          if (tab?.status === 'complete' && /^https:\/\/chatgpt\.com\//i.test(address)) return tab;
        } catch {
          return null;
        }
        await pause(100);
      }
      return null;
    }

    async function recoverCleanupReservation(requestId,generation) {
      const verified = await cleanupRecoveryStatus(requestId,generation);
      if (!verified.ok || verified.alreadyRecovered) return verified;
      if (verified.recoveryRequired !== true) {
        return reply({ok:false,error:'TASK_BOX_CLEANUP_RECOVERY_NOT_AVAILABLE'});
      }
      if (!chrome.tabs?.create || !chrome.tabs?.sendMessage || !chrome.scripting?.executeScript) {
        return reply({ok:false,error:'TASK_BOX_CLEANUP_RECOVERY_BROWSER_UNAVAILABLE'});
      }

      let repairTabId = null;
      let claimed = verified.recoveryClaimed === true;
      try {
        if (claimed) {
          repairTabId = Number.isInteger(verified.owner?.tabId) ? verified.owner.tabId : null;
          if (repairTabId === null || !(await exactDocumentAlive(verified.owner))) {
            return reply({ok:false,error:'TASK_BOX_CLEANUP_CLAIMED_OWNER_UNAVAILABLE',repairOwner:verified.owner});
          }
        } else {
          const created = await chrome.tabs.create({url:'https://chatgpt.com/',active:false});
          repairTabId = Number.isInteger(created?.id) ? created.id : null;
          if (repairTabId === null) return reply({ok:false,error:'TASK_BOX_CLEANUP_REPAIR_TAB_FAILED'});
        }
        if (!(await waitForRepairTab(repairTabId))) {
          if (!claimed) await chrome.tabs.remove(repairTabId).catch(() => undefined);
          return reply({ok:false,error:'TASK_BOX_CLEANUP_REPAIR_TAB_NOT_READY'});
        }
        await chrome.scripting.executeScript({
          target:{tabId:repairTabId},
          files:['task-box-compatibility.js','task-box-core.js','task-box.js']
        });
        const prepared = await chrome.tabs.sendMessage(repairTabId,{
          type:'clf-task-box-recovery:prepare',protocol:PROTOCOL,requestId,generation
        });
        if (prepared?.ok !== true || prepared.ready !== true) {
          if (!claimed) await chrome.tabs.remove(repairTabId).catch(() => undefined);
          return reply({ok:false,error:prepared?.error || 'TASK_BOX_CLEANUP_REPAIR_NOT_READY'});
        }
        const executed = await chrome.tabs.sendMessage(repairTabId,{
          type:'clf-task-box-recovery:execute',protocol:PROTOCOL,requestId,generation
        });
        claimed = executed?.claimed === true;
        if (executed?.ok !== true || executed.completed !== true) {
          const durable = await coordinator.cleanupRecoveryStatus(requestId,generation);
          if (durable?.ok && durable.alreadyRecovered === true) {
            await chrome.tabs.remove(repairTabId).catch(() => undefined);
            return reply({ok:true,recovered:true,state:'present',generation,repairTabClosed:true,reconciled:true});
          }
          if (durable?.ok && durable.claimed === true && durable.owner?.tabId === repairTabId) claimed = true;
          return reply({
            ok:false,error:executed?.error || 'TASK_BOX_CLEANUP_REPAIR_INCOMPLETE',
            repairTabId,claimed
          });
        }
        const final = await coordinator.cleanupRecoveryStatus(requestId,generation);
        if (!final.ok || final.alreadyRecovered !== true) {
          return reply({ok:false,error:'TASK_BOX_CLEANUP_RECOVERY_UNCONFIRMED',repairTabId,claimed:true});
        }
        await chrome.tabs.remove(repairTabId).catch(() => undefined);
        return reply({ok:true,recovered:true,state:'present',generation,repairTabClosed:true});
      } catch (error) {
        if (repairTabId !== null) {
          try {
            const durable = await coordinator.cleanupRecoveryStatus(requestId,generation);
            if (durable?.ok && durable.alreadyRecovered === true) {
              await chrome.tabs.remove(repairTabId).catch(() => undefined);
              return reply({ok:true,recovered:true,state:'present',generation,repairTabClosed:true,reconciled:true});
            }
            if (durable?.ok && durable.claimed === true && durable.owner?.tabId === repairTabId) claimed = true;
          } catch {
            // The original error remains authoritative; never close a possibly claimed owner on readback failure.
            claimed = true;
          }
          if (!claimed) await chrome.tabs.remove(repairTabId).catch(() => undefined);
        }
        return reply({
          ok:false,error:String(error?.message || error || 'TASK_BOX_CLEANUP_RECOVERY_FAILED'),
          ...(repairTabId !== null ? {repairTabId} : {}),claimed
        });
      }
    }

    async function authorizeDelete(owner,ticket) {
      if (!validClearTicket(ticket)) return reply({ok:false,error:'INVALID_TASK_BOX_DELETE_TICKET'});
      // This is the linearization point for feature revocation before native ChatGPT
      // Project deletion. Read policy and exact browser lifecycle in one snapshot; no
      // network call and no mutation is performed here.
      const stored = await chrome.storage.local.get([FEATURE_KEY,GLOBAL_KEY]);
      const current = stored?.[GLOBAL_KEY];
      if (stored?.[FEATURE_KEY] !== true) return reply({ok:false,error:'TASK_BOX_DISABLED'});
      if (current?.state !== 'deleting' || current.kind !== 'clear' || current.clearCompleted !== true ||
          current.generation !== ticket.generation || current.requestId !== ticket.requestId ||
          current.owner?.tabId !== owner.tabId || current.owner?.documentId !== owner.documentId) {
        return reply({ok:false,error:'TASK_BOX_DELETE_NOT_AUTHORIZED'});
      }
      return reply({ok:true,authorized:true,requestId:ticket.requestId});
    }

    const currentDocument = assertCurrent => {
      if (typeof assertCurrent !== 'function') return false;
      try { return assertCurrent() === true; } catch { return false; }
    };
    const staleDocument = () => reply({ok:false,error:'STALE_TASK_BOX_DOCUMENT'});

    async function statusOnly(owner,requestId,ticket,assertCurrent) {
      const query = new URLSearchParams({requestId,tabId:String(owner.tabId),documentId:owner.documentId});
      const result = await call(`/task-box/clear/status?${query.toString()}`);
      if (!exactCompleted(result,requestId)) {
        return reply({ok:false,error:result?.error || result?.data?.error || 'TASK_BOX_CLEAR_UNCONFIRMED'});
      }
      if (!(await enabled())) return reply({ok:false,error:'TASK_BOX_DISABLED'});
      if (!currentDocument(assertCurrent)) return staleDocument();
      const completed = await coordinator.clearCompleted(owner,ticket);
      if (!completed.ok) return reply(completed);
      return reply({ok:true,status:'completed',requestId,ticket});
    }

    async function clear(owner,requestId,assertCurrent) {
      if (!currentDocument(assertCurrent)) return staleDocument();
      const begun = await coordinator.beginDeletion(owner,requestId,'clear');
      if (!begun.ok) {
        // Re-presenting an exact pending request can read status, but can never POST Clear again.
        const pending = await coordinator.pendingClear(owner,requestId);
        if (!pending.ok) return reply(begun);
        return statusOnly(owner,requestId,pending.ticket,assertCurrent);
      }

      let result;
      try {
        if (!currentDocument(assertCurrent)) return staleDocument();
        // Existing call() normally retries after a 401. Passing retried=true keeps this
        // mutation to one HTTP attempt; any ambiguity is reconciled by GET status only.
        result = await call('/task-box/clear', {
          method:'POST',
          body:JSON.stringify({owner,requestId})
        }, true);
      } catch (error) {
        result = {ok:false,error:String(error?.message || error)};
      }
      if (exactCompleted(result,requestId)) {
        if (!(await enabled())) return reply({ok:false,error:'TASK_BOX_DISABLED'});
        if (!currentDocument(assertCurrent)) return staleDocument();
        const completed = await coordinator.clearCompleted(owner,begun.ticket);
        if (!completed.ok) return reply(completed);
        return reply({ok:true,status:'completed',requestId,ticket:begun.ticket});
      }
      return statusOnly(owner,requestId,begun.ticket,assertCurrent);
    }

    async function handle(message,sender,assertCurrent,currentConversation) {
      if (!handles(message?.type)) return reply({ok:false,error:'TASK_BOX_MESSAGE_NOT_HANDLED'});
      if (message.protocol !== PROTOCOL) return reply({ok:false,error:'TASK_BOX_PROTOCOL_MISMATCH'});
      const owner = ownerFor(sender);
      if (!owner) return reply({ok:false,error:'INVALID_TASK_BOX_OWNER'});
      if (typeof assertCurrent !== 'function') return reply({ok:false,error:'TASK_BOX_DOCUMENT_GUARD_REQUIRED'});
      if (!(await enabled())) return reply({ok:false,error:'TASK_BOX_DISABLED'});
      if (!currentDocument(assertCurrent)) return staleDocument();
      const action = message.type.slice(PREFIX.length);

      if (action === 'probe') {
        if (!(await capabilitiesReady())) return reply({ok:false,error:'TASK_BOX_CAPABILITY_UNAVAILABLE'});
        if (!currentDocument(assertCurrent)) return staleDocument();
        return reply({ok:true,enabled:true,version:COMPANION_VERSION});
      }
      if (action === 'authorize-delete') {
        const authorization = await authorizeDelete(owner,message.ticket);
        if (!currentDocument(assertCurrent)) return staleDocument();
        return authorization;
      }
      if (action === 'complete-create') {
        if (!currentDocument(assertCurrent)) return staleDocument();
        return reply(await coordinator.completeCreation(owner,message.ticket));
      }
      if (action === 'claim-cleanup-recovery') {
        if (!currentDocument(assertCurrent)) return staleDocument();
        return claimCleanupRecovery(owner,message.requestId,message.generation);
      }
      if (action === 'confirm-deleted') {
        if (!currentDocument(assertCurrent)) return staleDocument();
        return reply(await coordinator.confirmDeletion(owner,message.ticket));
      }
      if (action === 'present') {
        if (!(await capabilitiesReady())) return reply({ok:false,error:'TASK_BOX_CAPABILITY_UNAVAILABLE'});
        if (!currentDocument(assertCurrent)) return staleDocument();
        return reply(await coordinator.observePresent());
      }
      if (!validRequest(message.requestId)) return reply({ok:false,error:'INVALID_TASK_BOX_REQUEST'});
      if (action === 'clear') {
        const pending = await coordinator.pendingClear(owner,message.requestId);
        if (pending.ok) return statusOnly(owner,message.requestId,pending.ticket,assertCurrent);
        if (!(await capabilitiesReady())) return reply({ok:false,error:'TASK_BOX_CAPABILITY_UNAVAILABLE'});
        if (!currentDocument(assertCurrent)) return staleDocument();
        return clear(owner,message.requestId,assertCurrent);
      }
      if (!['begin-manual-delete','reserve-create'].includes(action)) {
        return reply({ok:false,error:'TASK_BOX_UNKNOWN_ACTION'});
      }
      if (!(await capabilitiesReady())) return reply({ok:false,error:'TASK_BOX_CAPABILITY_UNAVAILABLE'});
      if (!currentDocument(assertCurrent)) return staleDocument();
      if (action === 'begin-manual-delete') return reply(await coordinator.beginDeletion(owner,message.requestId,'manual'));
      if (action === 'reserve-create') {
        const conversationId = message.conversationId;
        if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId) || typeof currentConversation !== 'function') {
          return reply({ok:false,error:'INVALID_CREATE_OWNER'});
        }
        // MessageSender.url can lag or become temporarily id-less during ChatGPT SPA/reload
        // transitions. The companion background already owns the authoritative current-tab
        // conversation arbitration; reserve-create must consume that one fact rather than
        // re-implementing route identity here.
        let currentConversationId = null;
        try { currentConversationId = await currentConversation(); } catch {}
        if (!currentDocument(assertCurrent)) return staleDocument();
        if (currentConversationId !== conversationId) return reply({ok:false,error:'INVALID_CREATE_OWNER'});
        return reply(await coordinator.reserveWorker(owner,message.requestId,conversationId));
      }
      return reply({ok:false,error:'TASK_BOX_UNKNOWN_ACTION'});
    }

    return Object.freeze({
      handles,handle,manualDeletionRecoveryStatus,recoverManualDeletion,
      cleanupRecoveryStatus,recoverCleanupReservation,protocol:PROTOCOL
    });
  }

  globalThis.CLFTaskBoxBackground = Object.freeze({registerTaskBox,protocol:PROTOCOL});
})();
