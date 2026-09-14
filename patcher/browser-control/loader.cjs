'use strict';

const { createBrowserControl } = require('./runtime/browser-control.cjs');

const BROWSER_CONTROL_PROTOCOL = 1;
const CONVERSATION_ID = /^[0-9a-f-]{8,64}$/i;
const NEXT_KEYS = new Set(['conversationId']);
const RESULT_KEYS = new Set(['conversationId', 'id', 'result']);

function badRequest(json, res, origin, error) {
  json(res, 400, { ok: false, error }, origin);
  return true;
}

function cleanConversationId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return CONVERSATION_ID.test(id) ? id : null;
}

function exactKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key)) && Object.keys(value).length === allowed.size;
}

function createLoader(options = {}) {
  const control = createBrowserControl(options);

  async function handleBridge(context) {
    const { req, res, route, origin, readBody, json, tooLarge } = context || {};
    if (!req || !res || typeof route !== 'string' || typeof json !== 'function') return false;

    if (route === '/browser/capabilities' && req.method === 'GET') {
      json(
        res,
        200,
        {
          ok: true,
          protocol: BROWSER_CONTROL_PROTOCOL,
          commandLifecycle: ['queued', 'collected', 'settled'],
          ambiguousOutcomeIsRetryable: false
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
    const accepted = control.settleBrowserCommand(conversationId, id, body.result);
    if (!accepted) {
      json(res, 409, { ok: false, error: 'browser_result_not_pending' }, origin);
      return true;
    }
    json(res, 200, { ok: true, accepted: true }, origin);
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
