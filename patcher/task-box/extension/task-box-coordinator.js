(() => {
  'use strict';

  const GLOBAL_KEY = 'taskBoxCreationGlobal';
  const LEGACY_PREFIX = 'taskBoxCreationAttempt:';
  const CLEAR_ATTEMPT_PREFIX = 'taskBoxClearAttempt:';
  const MANUAL_RECOVERY_PREFIX = 'taskBoxManualRecovery:';

  function create(storage) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
      throw new TypeError('storage.get/set required');
    }

    let queue = Promise.resolve();
    const serial = operation => {
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    };
    const fail = error => ({ok:false,error});
    const validText = value => typeof value === 'string' && value.length > 0;
    const validOwner = owner => Boolean(owner && Number.isInteger(owner.tabId) && owner.tabId >= 0 &&
      typeof owner.documentId === 'string' && owner.documentId.length > 0);
    const ownerMatches = (record, owner) => record?.owner?.tabId === owner.tabId &&
      record?.owner?.documentId === owner.documentId;
    const generationOf = record => Number.isInteger(record?.generation) && record.generation >= 0
      ? record.generation : 0;
    const creationTicket = record => ({generation:record.generation,requestId:record.requestId,mode:record.mode});
    const deletionTicket = record => ({generation:record.generation,requestId:record.requestId,kind:record.kind});
    const validCreationTicket = ticket => Boolean(ticket && Number.isInteger(ticket.generation) && ticket.generation >= 0 &&
      validText(ticket.requestId) && (ticket.mode === 'worker' || ticket.mode === 'cleanup'));
    const validDeletionTicket = ticket => Boolean(ticket && Number.isInteger(ticket.generation) && ticket.generation >= 0 &&
      validText(ticket.requestId) && (ticket.kind === 'clear' || ticket.kind === 'manual'));
    const sameCreationTicket = (record,ticket) => record?.generation === ticket.generation &&
      record?.requestId === ticket.requestId && record?.mode === ticket.mode;
    const sameDeletionTicket = (record,ticket) => record?.generation === ticket.generation &&
      record?.requestId === ticket.requestId && record?.kind === ticket.kind;

    function manualRecoveryView(stored,requestId,generation) {
      if (!validText(requestId) || !Number.isInteger(generation) || generation < 0) {
        return fail('TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE');
      }
      const current = stored?.[GLOBAL_KEY];
      const attempt = stored?.[`${CLEAR_ATTEMPT_PREFIX}${requestId}`];
      const recovery = stored?.[`${MANUAL_RECOVERY_PREFIX}${requestId}`];
      const toGeneration = generation + 1;

      // A recovery receipt is an idempotency fence, not permission to release a new lifecycle.
      // It is accepted only while the global state still reflects the exact transition it records.
      if (recovery?.state === 'completed' && recovery.requestId === requestId &&
          recovery.fromGeneration === generation && recovery.toGeneration === toGeneration &&
          recovery.reason === 'human-attested-manual-project-delete' &&
          current?.state === 'open' && current.generation === toGeneration) {
        return {ok:true,alreadyRecovered:true,state:'open',generation:toGeneration};
      }
      if (recovery !== undefined) {
        return fail('TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE');
      }

      if (current?.state !== 'deleting' || current.kind !== 'clear' || current.clearCompleted !== true ||
          current.requestId !== requestId || current.generation !== generation || !validOwner(current.owner) ||
          attempt?.state !== 'completed' || attempt.kind !== 'clear' || attempt.requestId !== requestId ||
          attempt.generation !== generation || !ownerMatches(attempt,current.owner)) {
        return fail('TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE');
      }
      return {ok:true,available:true,owner:{tabId:current.owner.tabId,documentId:current.owner.documentId},generation};
    }

    function manualDeletionRecoveryStatus(requestId,generation) {
      return serial(async () => {
        const stored = await storage.get([
          GLOBAL_KEY,
          `${CLEAR_ATTEMPT_PREFIX}${requestId}`,
          `${MANUAL_RECOVERY_PREFIX}${requestId}`
        ]);
        return manualRecoveryView(stored,requestId,generation);
      });
    }

    function recoverManualDeletion(requestId,generation) {
      return serial(async () => {
        const recoveryKey = `${MANUAL_RECOVERY_PREFIX}${requestId}`;
        const stored = await storage.get([GLOBAL_KEY,`${CLEAR_ATTEMPT_PREFIX}${requestId}`,recoveryKey]);
        const view = manualRecoveryView(stored,requestId,generation);
        if (!view.ok || view.alreadyRecovered) return view;
        const toGeneration = generation + 1;
        const receipt = {
          state:'completed',requestId,fromGeneration:generation,toGeneration,
          reason:'human-attested-manual-project-delete'
        };
        await storage.set({[GLOBAL_KEY]:{state:'open',generation:toGeneration},[recoveryKey]:receipt});
        return {ok:true,recovered:true,state:'open',generation:toGeneration};
      });
    }

    async function readGlobal() {
      const stored = await storage.get(GLOBAL_KEY);
      return stored?.[GLOBAL_KEY];
    }

    function observePresent() {
      return serial(async () => {
        const current = await readGlobal();
        if (current?.state === 'reserved' || current?.state === 'deleting') return fail('TASK_BOX_GLOBAL_BUSY');
        if (current?.state === 'present') return {ok:true,observed:true,state:'present',generation:generationOf(current)};
        if (current && current.state !== 'open') return fail('TASK_BOX_GLOBAL_STATE_INVALID');
        const next = {state:'present',generation:generationOf(current)};
        await storage.set({[GLOBAL_KEY]:next});
        return {ok:true,observed:true,state:'present',generation:next.generation};
      });
    }

    function reserveWorker(owner,requestId,conversationId) {
      return serial(async () => {
        if (!validOwner(owner) || !validText(requestId) || !validText(conversationId)) return fail('INVALID_WORKER_RESERVATION');
        const legacyKey = `${LEGACY_PREFIX}${conversationId}`;
        const stored = await storage.get([GLOBAL_KEY,legacyKey]);
        const current = stored?.[GLOBAL_KEY];
        if (stored?.[legacyKey]) return fail('TASK_BOX_CREATE_ALREADY_ATTEMPTED');
        if (current && current.state !== 'open') return fail('TASK_BOX_GLOBAL_NOT_OPEN');
        const generation = generationOf(current);
        const global = {state:'reserved',generation,mode:'worker',requestId,
          owner:{tabId:owner.tabId,documentId:owner.documentId},conversationId};
        const legacy = {state:'reserved',generation,conversationId,requestId,
          tabId:owner.tabId,documentId:owner.documentId};
        await storage.set({[GLOBAL_KEY]:global,[legacyKey]:legacy});
        return {ok:true,reserved:true,ticket:creationTicket(global)};
      });
    }

    function completeCreation(owner,ticket) {
      return serial(async () => {
        if (!validOwner(owner) || !validCreationTicket(ticket)) return fail('INVALID_CREATION_COMPLETION');
        const current = await readGlobal();
        if (current?.state !== 'reserved' || !ownerMatches(current,owner) || !sameCreationTicket(current,ticket)) {
          return fail('TASK_BOX_CREATION_NOT_RESERVED');
        }
        const next = {state:'present',generation:current.generation};
        await storage.set({[GLOBAL_KEY]:next});
        return {ok:true,completed:true,state:'present',generation:next.generation};
      });
    }

    function beginDeletion(owner,requestId,kind) {
      return serial(async () => {
        if (!validOwner(owner) || !validText(requestId) || (kind !== 'clear' && kind !== 'manual')) return fail('INVALID_DELETION_BEGIN');
        const attemptKey = `${CLEAR_ATTEMPT_PREFIX}${requestId}`;
        const stored = await storage.get(kind === 'clear' ? [GLOBAL_KEY,attemptKey] : GLOBAL_KEY);
        const current = stored?.[GLOBAL_KEY];
        if (kind === 'clear' && stored?.[attemptKey] !== undefined) return fail('TASK_BOX_CLEAR_ALREADY_ATTEMPTED');
        if (current?.state === 'reserved' || current?.state === 'deleting') return fail('TASK_BOX_DELETE_NOT_AVAILABLE');
        if (current && current.state !== 'open' && current.state !== 'present') return fail('TASK_BOX_GLOBAL_STATE_INVALID');
        const next = {state:'deleting',generation:generationOf(current),kind,requestId,
          owner:{tabId:owner.tabId,documentId:owner.documentId},clearCompleted:false};
        const write = {[GLOBAL_KEY]:next};
        if (kind === 'clear') write[attemptKey] = {state:'reserved',generation:next.generation,requestId,kind,
          owner:{tabId:owner.tabId,documentId:owner.documentId}};
        await storage.set(write);
        return {ok:true,deleting:true,ticket:deletionTicket(next)};
      });
    }

    function pendingClear(owner,requestId) {
      return serial(async () => {
        if (!validOwner(owner) || !validText(requestId)) return fail('INVALID_CLEAR_STATUS');
        const attemptKey = `${CLEAR_ATTEMPT_PREFIX}${requestId}`;
        const stored = await storage.get([GLOBAL_KEY,attemptKey]);
        const current = stored?.[GLOBAL_KEY];
        const attempt = stored?.[attemptKey];
        if (current?.state !== 'deleting' || current.kind !== 'clear' || current.clearCompleted !== false ||
            current.requestId !== requestId || !ownerMatches(current,owner) || attempt?.state !== 'reserved' ||
            !ownerMatches(attempt,owner) || attempt.requestId !== requestId || attempt.generation !== current.generation) {
          return fail('TASK_BOX_CLEAR_NOT_PENDING');
        }
        return {ok:true,pending:true,ticket:deletionTicket(current)};
      });
    }

    function clearCompleted(owner,ticket) {
      return serial(async () => {
        if (!validOwner(owner) || !validDeletionTicket(ticket) || ticket.kind !== 'clear') return fail('INVALID_CLEAR_COMPLETION');
        const attemptKey = `${CLEAR_ATTEMPT_PREFIX}${ticket.requestId}`;
        const stored = await storage.get([GLOBAL_KEY,attemptKey]);
        const current = stored?.[GLOBAL_KEY];
        const attempt = stored?.[attemptKey];
        if (current?.state !== 'deleting' || current.kind !== 'clear' || !ownerMatches(current,owner) ||
            !sameDeletionTicket(current,ticket) || !['reserved','completed'].includes(attempt?.state) ||
            !ownerMatches(attempt,owner) || attempt.generation !== ticket.generation ||
            attempt.requestId !== ticket.requestId) return fail('TASK_BOX_CLEAR_NOT_PENDING');
        if (current.clearCompleted === true && attempt.state === 'completed') {
          return {ok:true,clearCompleted:true,alreadyCompleted:true};
        }
        if (attempt.state !== 'reserved') return fail('TASK_BOX_CLEAR_NOT_PENDING');
        await storage.set({
          [GLOBAL_KEY]:{...current,clearCompleted:true},
          [attemptKey]:{...attempt,state:'completed'}
        });
        return {ok:true,clearCompleted:true};
      });
    }

    function confirmDeletion(owner,ticket) {
      return serial(async () => {
        if (!validOwner(owner) || !validDeletionTicket(ticket)) return fail('INVALID_DELETION_CONFIRM');
        const current = await readGlobal();
        if (current?.state !== 'deleting' || !ownerMatches(current,owner) || !sameDeletionTicket(current,ticket)) {
          return fail('TASK_BOX_DELETE_NOT_PENDING');
        }
        if (current.kind === 'clear' && current.clearCompleted !== true) return fail('TASK_BOX_CLEAR_NOT_COMPLETED');
        const generation = current.generation + 1;
        if (current.kind === 'manual') {
          await storage.set({[GLOBAL_KEY]:{state:'open',generation}});
          return {ok:true,deleted:true,state:'open',generation};
        }
        const next = {state:'reserved',generation,mode:'cleanup',requestId:current.requestId,
          owner:{tabId:owner.tabId,documentId:owner.documentId}};
        await storage.set({[GLOBAL_KEY]:next});
        return {ok:true,reserved:true,ticket:creationTicket(next)};
      });
    }

    return {
      observePresent,reserveWorker,completeCreation,beginDeletion,pendingClear,clearCompleted,confirmDeletion,
      manualDeletionRecoveryStatus,recoverManualDeletion
    };
  }

  globalThis.CLFTaskBoxCoordinator = Object.freeze({create,GLOBAL_KEY,CLEAR_ATTEMPT_PREFIX,MANUAL_RECOVERY_PREFIX});
})();
