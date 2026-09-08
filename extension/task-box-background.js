(() => {
  'use strict';

  const PROTOCOL = 1;
  const COMPANION_VERSION = '2.0.6';
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
      return {owner:{tabId:sender.tab.id,documentId:sender.documentId},url};
    }

    async function enabled() {
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

    async function handle(message,sender,assertCurrent) {
      if (!handles(message?.type)) return reply({ok:false,error:'TASK_BOX_MESSAGE_NOT_HANDLED'});
      if (message.protocol !== PROTOCOL) return reply({ok:false,error:'TASK_BOX_PROTOCOL_MISMATCH'});
      const verified = ownerFor(sender);
      if (!verified) return reply({ok:false,error:'INVALID_TASK_BOX_OWNER'});
      if (typeof assertCurrent !== 'function') return reply({ok:false,error:'TASK_BOX_DOCUMENT_GUARD_REQUIRED'});
      if (!(await enabled())) return reply({ok:false,error:'TASK_BOX_DISABLED'});
      if (!currentDocument(assertCurrent)) return staleDocument();
      const {owner,url} = verified;
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
        const route = url.pathname.match(/^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/);
        if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId) || route?.[1] !== conversationId) {
          return reply({ok:false,error:'INVALID_CREATE_OWNER'});
        }
        if (!currentDocument(assertCurrent)) return staleDocument();
        return reply(await coordinator.reserveWorker(owner,message.requestId,conversationId));
      }
      return reply({ok:false,error:'TASK_BOX_UNKNOWN_ACTION'});
    }

    return Object.freeze({handles,handle,protocol:PROTOCOL});
  }

  globalThis.CLFTaskBoxBackground = Object.freeze({registerTaskBox,protocol:PROTOCOL});
})();
