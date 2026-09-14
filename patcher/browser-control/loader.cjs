'use strict';

const { createHash } = require('node:crypto');
const { createBrowserControl } = require('./runtime/browser-control.cjs');

const BROWSER_CONTROL_PROTOCOL = 1;
const CONVERSATION_ID = /^[0-9a-f-]{8,64}$/i;
const NEXT_KEYS = new Set(['conversationId']);
const RESULT_KEYS = new Set(['conversationId', 'id', 'result']);
const RESULT_RECEIPT_TTL_MS = 2 * 60_000;
const MAX_RESULT_RECEIPTS = 256;

function badRequest(json, res, origin, error) {
  json(res, 400, { ok: false, error }, origin);
  return true;
}

function cleanConversationId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return CONVERSATION_ID.test(id) ? id : null;
}

function exactKeys(value, allowed) {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every(key => allowed.has(key));
}

function resultDigest(value) {
  try {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  } catch {
    return null;
  }
}

function createLoader(options = {}) {
  const control = createBrowserControl(options);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const resultReceipts = new Map();

  function pruneReceipts() {
    const cutoff = now() - RESULT_RECEIPT_TTL_MS;
    for (const [key, receipt] of resultReceipts) {
      if (receipt.at < cutoff) resultReceipts.delete(key);
    }
    while (resultReceipts.size > MAX_RESULT_RECEIPTS) {
      const oldest = resultReceipts.keys().next().value;
      if (oldest === undefined) break;
      resultReceipts.delete(oldest);
    }
  }

  async function handleBridge(context) {
    const { req, res, route, origin, readBody, json, tooLarge } = context || {};
    if (!req || !res || typeof route !== 'string' || typeof json !== 'function') return false;

    if (route === '/browser/capabilities') {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method_not_allowed' }, origin);
        return true;
      }
      json(
        res,
        200,
        {
          ok: true,
          protocol: BROWSER_CONTROL_PROTOCOL,
          commandLifecycle: ['queued', 'collected', 'settled'],
          ambiguousOutcomeIsRetryable: false,
          idempotentResultReplay: true
        },
        origin
      );
      return true;
    }

    if (route !== '/browser/next' && route !== '/browser/result') return false;
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'method_not_allowed' }, origin);
      return true;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      if (error && error.message === 'body_too_large' && typeof tooLarge === 'function') {
        tooLarge(res, origin);
        return true;
      }
      return badRequest(json, res, origin, 'bad_request');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(json, res, origin, 'bad_request');

    const allowed = route === '/browser/next' ? NEXT_KEYS : RESULT_KEYS;
    if (!exactKeys(body, allowed)) return badRequest(json, res, origin, 'bad_request');

    const conversationId = cleanConversationId(body.conversationId);
    if (!conversationId) return badRequest(json, res, origin, 'bad_conversation_id');

    if (route === '/browser/next') {
      const command = control.collectBrowserCommand(conversationId);
      json(res, 200, { ok: true, protocol: BROWSER_CONTROL_PROTOCOL, command }, origin);
      return true;
    }

    const id = typeof body.id === 'string' ? body.id : '';
    if (!id || id.length > 120 || !body.result || typeof body.result !== 'object' || Array.isArray(body.result)) {
      return badRequest(json, res, origin, 'bad_browser_result');
    }
    const digest = resultDigest(body.result);
    if (!digest) return badRequest(json, res, origin, 'bad_browser_result');

    pruneReceipts();
    const receiptKey = `${conversationId}\0${id}`;
    const prior = resultReceipts.get(receiptKey);
    if (prior) {
      if (prior.digest !== digest) {
        json(res, 409, { ok: false, error: 'browser_result_mismatch' }, origin);
        return true;
      }
      json(res, 200, { ok: true, accepted: true, replayed: true }, origin);
      return true;
    }

    const accepted = control.settleBrowserCommand(conversationId, id, body.result);
    if (!accepted) {
      json(res, 409, { ok: false, error: 'browser_result_not_pending' }, origin);
      return true;
    }
    resultReceipts.set(receiptKey, { digest, at: now() });
    pruneReceipts();
    json(res, 200, { ok: true, accepted: true, replayed: false }, origin);
    return true;
  }

  return Object.freeze({
    protocol: BROWSER_CONTROL_PROTOCOL,
    runBrowserCommand: control.runBrowserCommand,
    collectBrowserCommand: control.collectBrowserCommand,
    settleBrowserCommand: control.settleBrowserCommand,
    abandonBrowserCommands: control.abandonBrowserCommands,
    status: control.status,
    resetForTests: control.resetForTests,
    handleBridge
  });
}

module.exports = {
  BROWSER_CONTROL_PROTOCOL,
  createLoader
};
