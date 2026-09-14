/**
 * Browser-control command transport for the companion service worker.
 *
 * Task 1 deliberately owns no browser driver. A future driver registers exactly one executor;
 * until then this transport does not collect commands, so an app-side timeout remains provably
 * "not delivered" and safe to retry. Once a command is collected it is never fetched again.
 */
(() => {
  'use strict';

  const PROTOCOL = 1;
  const MAX_ERROR = 160;
  const MAX_DETAIL = 4_000;
  let executor = null;
  let binding = null;
  const inFlight = new Map();

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
    if (record(value.data)) out.data = structuredClone(value.data);
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

  async function poll(rawConversationId) {
    if (!executor || !binding) return { ok: true, collected: false, reason: 'executor_unavailable' };
    const conversationId = binding.cleanConversationId(rawConversationId);
    if (!conversationId) return { ok: false, collected: false, reason: 'bad_conversation_id' };
    if (inFlight.has(conversationId)) return inFlight.get(conversationId);

    const work = (async () => {
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
        return { ok: false, collected: false, reason: 'malformed_command' };
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

      const settled = await binding.call('/browser/result', {
        method: 'POST',
        body: JSON.stringify({ conversationId, id: command.id, result })
      });
      return {
        ok: settled?.ok === true && settled.data?.ok === true,
        collected: true,
        settled: settled?.ok === true && settled.data?.ok === true,
        commandId: command.id,
        result
      };
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
      inFlight: inFlight.size
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
