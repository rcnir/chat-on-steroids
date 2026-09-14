'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_COMMAND_TIMEOUT_MS = 45_000;
const CONVERSATION_ID = /^[0-9a-f-]{8,64}$/i;
const MAX_COMMAND_ID = 120;
const MAX_ERROR = 160;
const MAX_DETAIL = 4_000;
const MAX_ACTION_BYTES = 64 * 1024;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function normalizedConversationId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return CONVERSATION_ID.test(id) ? id : null;
}

function normalizedAction(value) {
  if (!record(value)) return null;
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_ACTION_BYTES) return null;
    return structuredClone(value);
  } catch {
    return null;
  }
}

function timeoutResult(command) {
  const delivered = command.collectedAt !== null;
  return {
    ok: false,
    error: 'BROWSER_TIMEOUT',
    detail: delivered
      ? 'the browser collected this action but no result returned; it may have happened. Observe before deciding whether to continue.'
      : 'no browser collected this action before the deadline; it did not run and is safe to retry.',
    delivery: delivered ? 'collected' : 'not_delivered',
    effect: delivered ? 'unknown' : 'none',
    retrySafe: !delivered
  };
}

function normalizeSettledResult(value) {
  if (!record(value) || typeof value.ok !== 'boolean') {
    return {
      ok: false,
      error: 'BROWSER_RESULT_INVALID',
      detail: 'the browser returned a malformed result',
      delivery: 'settled',
      effect: 'unknown',
      retrySafe: false
    };
  }
  const result = {
    ok: value.ok,
    delivery: 'settled'
  };
  if (record(value.data)) result.data = structuredClone(value.data);
  const error = boundedText(value.error, MAX_ERROR);
  const detail = boundedText(value.detail, MAX_DETAIL);
  if (error) result.error = error;
  if (detail) result.detail = detail;
  const effect = value.effect === 'confirmed' || value.effect === 'none' || value.effect === 'unknown'
    ? value.effect
    : undefined;
  if (effect) result.effect = effect;
  // A post-collection failure is retry-safe only when the executor explicitly proved no effect.
  // `retrySafe: true` can never override `effect: unknown/confirmed`.
  if (!value.ok) result.retrySafe = value.retrySafe === true && effect === 'none';
  return result;
}

function createBrowserControl(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_COMMAND_TIMEOUT_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const schedule = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const cancel = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const makeId = typeof options.makeId === 'function' ? options.makeId : () => `bc-${randomUUID()}`;
  const pending = new Map();

  function finish(command, result) {
    if (pending.get(command.conversationId) !== command) return false;
    pending.delete(command.conversationId);
    cancel(command.timer);
    command.resolve(result);
    return true;
  }

  function runBrowserCommand(conversationIdValue, actionValue) {
    const conversationId = normalizedConversationId(conversationIdValue);
    const action = normalizedAction(actionValue);
    if (!conversationId || !action) {
      return Promise.resolve({
        ok: false,
        error: 'BROWSER_BAD_COMMAND',
        detail: 'browser commands require a valid ChatGPT conversation id and an object action',
        delivery: 'not_delivered',
        effect: 'none',
        retrySafe: true
      });
    }
    if (pending.has(conversationId)) {
      return Promise.resolve({
        ok: false,
        error: 'BROWSER_BUSY',
        detail: 'another browser action for this conversation is still pending',
        delivery: 'not_delivered',
        effect: 'none',
        retrySafe: true
      });
    }

    return new Promise((resolve) => {
      const command = {
        id: String(makeId()).slice(0, MAX_COMMAND_ID),
        conversationId,
        action,
        createdAt: now(),
        collectedAt: null,
        resolve,
        timer: null
      };
      command.timer = schedule(() => finish(command, timeoutResult(command)), timeoutMs);
      pending.set(conversationId, command);
    });
  }

  function collectBrowserCommand(conversationIdValue) {
    const conversationId = normalizedConversationId(conversationIdValue);
    if (!conversationId) return null;
    const command = pending.get(conversationId);
    if (!command || command.collectedAt !== null) return null;
    command.collectedAt = now();
    return {
      id: command.id,
      action: structuredClone(command.action),
      collectedAt: command.collectedAt
    };
  }

  function settleBrowserCommand(conversationIdValue, idValue, resultValue) {
    const conversationId = normalizedConversationId(conversationIdValue);
    const id = typeof idValue === 'string' ? idValue.slice(0, MAX_COMMAND_ID) : '';
    if (!conversationId || !id) return false;
    const command = pending.get(conversationId);
    if (!command || command.id !== id || command.collectedAt === null) return false;
    return finish(command, normalizeSettledResult(resultValue));
  }

  function abandonBrowserCommands(conversationIdValue, reason = 'the controller conversation is no longer available') {
    const conversationId = normalizedConversationId(conversationIdValue);
    if (!conversationId) return false;
    const command = pending.get(conversationId);
    if (!command) return false;
    const delivered = command.collectedAt !== null;
    return finish(command, {
      ok: false,
      error: 'BROWSER_GONE',
      detail: delivered
        ? `${String(reason).slice(0, MAX_DETAIL)} after the browser collected the action; it may have happened. Observe before retrying.`
        : `${String(reason).slice(0, MAX_DETAIL)} before the action was collected; it did not run and is safe to retry.`,
      delivery: delivered ? 'collected' : 'not_delivered',
      effect: delivered ? 'unknown' : 'none',
      retrySafe: !delivered
    });
  }

  function status(conversationIdValue) {
    const conversationId = normalizedConversationId(conversationIdValue);
    const command = conversationId ? pending.get(conversationId) : null;
    return command
      ? {
          pending: true,
          id: command.id,
          state: command.collectedAt === null ? 'queued' : 'collected',
          createdAt: command.createdAt,
          collectedAt: command.collectedAt
        }
      : { pending: false };
  }

  function resetForTests() {
    for (const command of [...pending.values()]) {
      finish(command, {
        ok: false,
        error: 'BROWSER_GONE',
        detail: 'browser control reset',
        delivery: command.collectedAt === null ? 'not_delivered' : 'collected',
        effect: command.collectedAt === null ? 'none' : 'unknown',
        retrySafe: command.collectedAt === null
      });
    }
  }

  return Object.freeze({
    runBrowserCommand,
    collectBrowserCommand,
    settleBrowserCommand,
    abandonBrowserCommands,
    status,
    resetForTests
  });
}

module.exports = {
  DEFAULT_COMMAND_TIMEOUT_MS,
  createBrowserControl
};
