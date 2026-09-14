/**
 * Browser-control command transport for the companion service worker.
 *
 * Task 1 deliberately owns no browser driver. A future driver registers exactly one executor;
 * until then this transport does not collect commands, so an app-side timeout remains provably
 * "not delivered" and safe to retry. Once a command is collected its action is executed at most
 * once; only the result envelope may be retried after bridge reply loss.
 */
(() => {
  'use strict';

  const PROTOCOL = 1;
  const STORAGE_KEY = 'rcBrowserControlPendingResultsV1';
  const MAX_ERROR = 160;
  const MAX_DETAIL = 4_000;
  // The official 2.1.11 bridge caps the complete HTTP body at 2 MiB. Leave ample room for the
  // conversation/id envelope and JSON overhead; Task 2 must keep observations below this result cap.
  const MAX_DURABLE_RESULT_BYTES = 1536 * 1024;
  let executor = null;
  let binding = null;
  let restorePromise = null;
  let storageChain = Promise.resolve();
  const inFlight = new Map();
  const pendingResults = new Map();

  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : undefined;

  function utf8ByteLength(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const low = value.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else bytes += 3;
      } else bytes += 3;
    }
    return bytes;
  }

  function normalizeResult(value) {
    if (!record(value) || typeof value.ok !== 'boolean') {
      return {
        ok: false,
        error: 'BROWSER_RESULT_INVALID',
        detail: 'the browser executor returned a malformed result',
        effect: 'unknown',
        retrySafe: false
      };
    }
    const out = { ok: value.ok };
    if (record(value.data)) {
      try {
        const data = structuredClone(value.data);
        JSON.stringify(data);
        out.data = data;
      } catch {
        return {
          ok: false,
          error: 'BROWSER_RESULT_INVALID',
          detail: 'the browser executor returned non-serializable result data',
          effect: 'unknown',
          retrySafe: false
        };
      }
    }
    const error = text(value.error, MAX_ERROR);
    const detail = text(value.detail, MAX_DETAIL);
    if (error) out.error = error;
    if (detail) out.detail = detail;
    const effect = ['confirmed', 'none', 'unknown'].includes(value.effect) ? value.effect : undefined;
    if (effect) out.effect = effect;
    if (!value.ok) out.retrySafe = value.retrySafe === true && effect === 'none';
    return out;
  }

  function failureResult(error) {
    const code = text(error?.code, MAX_ERROR) || 'BROWSER_ACTION_FAILED';
    const detail = text(error?.message, MAX_DETAIL) || String(error ?? 'browser action failed').slice(0, MAX_DETAIL);
    const effect = ['confirmed', 'none', 'unknown'].includes(error?.effect) ? error.effect : 'unknown';
    const retrySafe = typeof error?.retrySafe === 'boolean' ? error.retrySafe && effect === 'none' : effect === 'none';
    return { ok: false, error: code, detail, effect, retrySafe };
  }

  function staleControllerResult() {
    return {
      ok: false,
      error: 'BROWSER_CONTROLLER_STALE',
      detail: 'the ChatGPT document that requested browser control changed before execution; no browser action was attempted',
      effect: 'none',
      retrySafe: true
    };
  }

  function boundedDurableResult(result, action) {
    try {
      const encoded = JSON.stringify(result);
      if (typeof encoded === 'string' && utf8ByteLength(encoded) <= MAX_DURABLE_RESULT_BYTES) return result;
    } catch {
      // normalizeResult already rejected non-serializable data; keep this fail-closed anyway.
    }
    const readOnly = action?.type === 'observe' || action?.type === 'status';
    return {
      ok: false,
      error: 'BROWSER_RESULT_TOO_LARGE',
      detail: `the browser result exceeded the ${MAX_DURABLE_RESULT_BYTES} byte transport limit`,
      effect: readOnly ? 'none' : 'unknown',
      retrySafe: readOnly
    };
  }

  function transportFailure(error, { collected, commandId, result } = {}) {
    return {
      ok: false,
      collected: collected === true,
      settled: false,
      ...(commandId ? { commandId } : {}),
      ...(result ? { result } : {}),
      reason: 'transport_failed',
      detail: text(error?.message, MAX_DETAIL) || String(error ?? 'browser transport failed').slice(0, MAX_DETAIL)
    };
  }

  function authorityCurrent(check) {
    if (typeof check !== 'function') return true;
    try { return check() === true; } catch { return false; }
  }

  function storageAvailable() {
    const storage = binding?.sessionStorage;
    return Boolean(storage && typeof storage.get === 'function' && typeof storage.set === 'function' && typeof storage.remove === 'function');
  }

  function pendingSnapshot() {
    return {
      version: 1,
      rows: Object.fromEntries(
        [...pendingResults.entries()].map(([conversationId, pending]) => [
          conversationId,
          { id: pending.id, result: pending.result }
        ])
      )
    };
  }

  function queueStorageWrite() {
    if (!storageAvailable()) return Promise.resolve(false);
    storageChain = storageChain.catch(() => undefined).then(async () => {
      if (pendingResults.size === 0) await binding.sessionStorage.remove(STORAGE_KEY);
      else await binding.sessionStorage.set({ [STORAGE_KEY]: pendingSnapshot() });
    });
    return storageChain.then(() => true, () => false);
  }

  async function restorePendingResults() {
    if (!storageAvailable()) return false;
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      const saved = await binding.sessionStorage.get(STORAGE_KEY);
      const state = saved?.[STORAGE_KEY];
      if (!record(state) || state.version !== 1 || !record(state.rows)) return true;
      for (const [rawConversationId, row] of Object.entries(state.rows)) {
        const conversationId = binding.cleanConversationId(rawConversationId);
        if (!conversationId || !record(row) || typeof row.id !== 'string' || !record(row.result) || typeof row.result.ok !== 'boolean') continue;
        if (!pendingResults.has(conversationId)) {
          pendingResults.set(conversationId, { id: row.id.slice(0, 120), result: structuredClone(row.result) });
        }
      }
      return true;
    })().catch(() => {
      restorePromise = null;
      return false;
    });
    return restorePromise;
  }

  async function rememberPendingResult(conversationId, id, result) {
    pendingResults.set(conversationId, { id, result });
    await queueStorageWrite();
  }

  async function forgetPendingResult(conversationId) {
    pendingResults.delete(conversationId);
    await queueStorageWrite();
  }

  async function settlePendingResult(conversationId) {
    const pending = pendingResults.get(conversationId);
    if (!pending) return null;
    try {
      const reply = await binding.call('/browser/result', {
        method: 'POST',
        body: JSON.stringify({ conversationId, id: pending.id, result: pending.result })
      });
      if (reply?.ok === true && reply.data?.ok === true) {
        await forgetPendingResult(conversationId);
        return {
          ok: true,
          collected: true,
          settled: true,
          commandId: pending.id,
          result: pending.result,
          replayed: reply.data.replayed === true
        };
      }
      // 400/413 are structural refusals for this exact envelope; 409 means the matching app-side
      // command/receipt no longer accepts it. None can become valid by retrying the same bytes.
      if (reply?.status === 400 || reply?.status === 409 || reply?.status === 413) {
        await forgetPendingResult(conversationId);
        return {
          ok: false,
          collected: true,
          settled: false,
          terminal: true,
          commandId: pending.id,
          result: pending.result,
          reason: reply.data?.error || 'browser_result_rejected'
        };
      }
      return {
        ok: false,
        collected: true,
        settled: false,
        commandId: pending.id,
        result: pending.result,
        reason: reply?.data?.error || reply?.error || 'bridge_unavailable'
      };
    } catch (error) {
      return transportFailure(error, {
        collected: true,
        commandId: pending.id,
        result: pending.result
      });
    }
  }

  async function poll(rawConversationId, stillOwnsController) {
    if (!binding) return { ok: false, collected: false, reason: 'transport_unbound' };
    const conversationId = binding.cleanConversationId(rawConversationId);
    if (!conversationId) return { ok: false, collected: false, reason: 'bad_conversation_id' };
    await restorePendingResults();
    if (inFlight.has(conversationId)) return inFlight.get(conversationId);

    const work = (async () => {
      const retry = await settlePendingResult(conversationId);
      if (retry) return retry;
      if (!executor) return { ok: true, collected: false, reason: 'executor_unavailable' };
      if (!authorityCurrent(stillOwnsController)) {
        return { ok: false, collected: false, reason: 'stale_controller' };
      }

      try {
        const next = await binding.call('/browser/next', {
          method: 'POST',
          body: JSON.stringify({ conversationId })
        });
        if (!next?.ok || next.data?.ok !== true) {
          return { ok: false, collected: false, reason: next?.data?.error || next?.error || 'bridge_unavailable' };
        }
        const command = next.data.command;
        if (command === null || command === undefined) return { ok: true, collected: false };
        if (!record(command) || typeof command.id !== 'string' || !record(command.action)) {
          return { ok: false, collected: true, settled: false, reason: 'malformed_command' };
        }

        if (!authorityCurrent(stillOwnsController)) {
          const result = staleControllerResult();
          await rememberPendingResult(conversationId, command.id, result);
          return await settlePendingResult(conversationId);
        }

        let result;
        try {
          result = normalizeResult(await executor(structuredClone(command.action), {
            id: command.id,
            conversationId,
            collectedAt: command.collectedAt
          }));
        } catch (error) {
          result = failureResult(error);
        }
        result = boundedDurableResult(result, command.action);
        await rememberPendingResult(conversationId, command.id, result);
        return await settlePendingResult(conversationId);
      } catch (error) {
        return transportFailure(error, { collected: false });
      }
    })().finally(() => {
      if (inFlight.get(conversationId) === work) inFlight.delete(conversationId);
    });

    inFlight.set(conversationId, work);
    return work;
  }

  function bindBackground(deps) {
    if (!record(deps) || typeof deps.call !== 'function' || typeof deps.cleanConversationId !== 'function') {
      throw new TypeError('BROWSER_CONTROL_TRANSPORT_INVALID_BINDING');
    }
    if (binding && (binding.call !== deps.call || binding.cleanConversationId !== deps.cleanConversationId || binding.sessionStorage !== deps.sessionStorage)) {
      throw new Error('BROWSER_CONTROL_TRANSPORT_ALREADY_BOUND');
    }
    binding = Object.freeze({
      call: deps.call,
      cleanConversationId: deps.cleanConversationId,
      sessionStorage: deps.sessionStorage ?? null
    });
    return Object.freeze({ protocol: PROTOCOL, poll });
  }

  function registerExecutor(next) {
    if (typeof next !== 'function') throw new TypeError('BROWSER_CONTROL_EXECUTOR_REQUIRED');
    if (executor && executor !== next) throw new Error('BROWSER_CONTROL_EXECUTOR_ALREADY_REGISTERED');
    executor = next;
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      if (executor !== next) return false;
      executor = null;
      return true;
    };
  }

  function status() {
    return {
      protocol: PROTOCOL,
      bound: binding !== null,
      executor: executor !== null,
      durableOutbox: storageAvailable(),
      inFlight: inFlight.size,
      pendingResults: pendingResults.size
    };
  }

  if (globalThis.CLFBrowserControlTransport) {
    throw new Error('BROWSER_CONTROL_TRANSPORT_DUPLICATE');
  }
  globalThis.CLFBrowserControlTransport = Object.freeze({
    protocol: PROTOCOL,
    bindBackground,
    registerExecutor,
    status
  });
})();
