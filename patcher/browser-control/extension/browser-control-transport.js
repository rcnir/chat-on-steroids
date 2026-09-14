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
  const MAX_ERROR = 160;
  const MAX_DETAIL = 4_000;
  let executor = null;
  let binding = null;
  const inFlight = new Map();
  const pendingResults = new Map();

  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : undefined;

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
        // Result metadata must never make the action itself execute twice. Drop unreportable data
        // and preserve a retry-unsafe failure envelope instead.
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
    if (['confirmed', 'none', 'unknown'].includes(value.effect)) out.effect = value.effect;
    if (typeof value.retrySafe === 'boolean') out.retrySafe = value.retrySafe;
    return out;
  }

  function failureResult(error) {
    const code = text(error?.code, MAX_ERROR) || 'BROWSER_ACTION_FAILED';
    const detail = text(error?.message, MAX_DETAIL) || String(error ?? 'browser action failed').slice(0, MAX_DETAIL);
    const effect = ['confirmed', 'none', 'unknown'].includes(error?.effect) ? error.effect : 'unknown';
    const retrySafe = typeof error?.retrySafe === 'boolean' ? error.retrySafe : effect === 'none';
    return { ok: false, error: code, detail, effect, retrySafe };
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

  async function settlePendingResult(conversationId) {
    const pending = pendingResults.get(conversationId);
    if (!pending) return null;
    try {
      const reply = await binding.call('/browser/result', {
        method: 'POST',
        body: JSON.stringify({ conversationId, id: pending.id, result: pending.result })
      });
      if (reply?.ok === true && reply.data?.ok === true) {
        pendingResults.delete(conversationId);
        return {
          ok: true,
          collected: true,
          settled: true,
          commandId: pending.id,
          result: pending.result,
          replayed: reply.data.replayed === true
        };
      }
      // A 409 is terminal for this exact app process: either its pending command already timed
      // out/vanished, or a mismatched replay was correctly refused. Never execute the action again.
      if (reply?.status === 409) {
        pendingResults.delete(conversationId);
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

  async function poll(rawConversationId) {
    if (!binding) return { ok: false, collected: false, reason: 'transport_unbound' };
    const conversationId = binding.cleanConversationId(rawConversationId);
    if (!conversationId) return { ok: false, collected: false, reason: 'bad_conversation_id' };
    if (inFlight.has(conversationId)) return inFlight.get(conversationId);

    const work = (async () => {
      // Result retry has priority and never requires a live executor. The action has already run;
      // doing anything except settling that exact result would risk reordering or duplication.
      const retry = await settlePendingResult(conversationId);
      if (retry) return retry;
      if (!executor) return { ok: true, collected: false, reason: 'executor_unavailable' };

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
          // The app has already crossed the collection boundary if it returned a command-shaped
          // payload at all. Fail conservative: no action is attempted and no blind retry is safe.
          return { ok: false, collected: true, settled: false, reason: 'malformed_command' };
        }

        let result;
        try {
          result = normalizeResult(await executor(structuredClone(command.action), {
            id: command.id,
            conversationId,
            collectedAt: command.collectedAt
          }));
        } catch (error) {
          // Collection is the ambiguity boundary. Unless a driver can prove that no effect occurred,
          // an exception after this point is not safe to retry as an input action.
          result = failureResult(error);
        }

        // Save before the first POST. A failed settlement may be retried on a later activity poll,
        // but this map is never a license to call the executor again.
        pendingResults.set(conversationId, { id: command.id, result });
        return await settlePendingResult(conversationId);
      } catch (error) {
        // The official call() currently never throws, but a transport layer must remain safe if
        // that contract changes or serialization itself fails. Never leak an unhandled rejection
        // from the fire-and-forget activity hook.
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
    if (binding && (binding.call !== deps.call || binding.cleanConversationId !== deps.cleanConversationId)) {
      throw new Error('BROWSER_CONTROL_TRANSPORT_ALREADY_BOUND');
    }
    binding = Object.freeze({ call: deps.call, cleanConversationId: deps.cleanConversationId });
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
