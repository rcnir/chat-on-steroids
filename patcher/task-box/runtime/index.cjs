'use strict';

const { createTaskBoxClearService } = require('./clear-service.cjs');

let service = null;
let serviceDependencies = null;

function taskBoxClearService(readState, writeState, clear) {
  if (service) {
    if (serviceDependencies.readState !== readState ||
        serviceDependencies.writeState !== writeState ||
        serviceDependencies.clear !== clear) {
      throw new Error('task_box_runtime_dependencies_changed');
    }
    return service;
  }

  serviceDependencies = { readState, writeState, clear };
  service = createTaskBoxClearService({
    read: readState,
    write: writeState,
    clear
  });
  return service;
}

function sendJson(json, res, status, body, origin) {
  json(res, status, body, origin);
  return true;
}

/**
 * TASK BOX route addon for the already-authenticated bridge request path.
 *
 * The caller MUST run the existing extension-origin, bearer-authentication,
 * bridge-protocol and rate-limit gates before this function. This module does
 * not duplicate or bypass any of those gates. It owns only the three TASK BOX
 * protocol-1 routes and the at-most-once Clear service behind them.
 *
 * Integration:
 *   if (await handleTaskBox({
 *     req, res, url, origin, route, readBody, json, tooLarge,
 *     readState, writeState, clear
 *   })) return;
 *
 * readState/writeState/clear are process-lifetime dependencies. Pass stable
 * function identities on every call. readState is also the strict durable
 * boundary: corrupt/unreadable/literal-null state must reject there rather
 * than being converted to an absent store.
 */
async function handleTaskBox({
  req,
  res,
  url,
  origin,
  route,
  readBody,
  json,
  tooLarge,
  readState,
  writeState,
  clear
}) {
  if (route === '/task-box/capabilities' && req.method === 'GET') {
    return sendJson(
      json,
      res,
      200,
      taskBoxClearService(readState, writeState, clear).capability(),
      origin
    );
  }

  if (route !== '/task-box/clear' && route !== '/task-box/clear/status') return false;

  const isStatus = route.endsWith('/status');
  if (req.method !== (isStatus ? 'GET' : 'POST')) {
    return sendJson(json, res, 405, { ok: false, error: 'method_not_allowed' }, origin);
  }

  let body;
  try {
    if (isStatus) {
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 3 || new Set(keys).size !== 3 ||
          keys.some(key => !['requestId', 'tabId', 'documentId'].includes(key))) {
        return sendJson(json, res, 400, { ok: false, error: 'invalid_task_box_request' }, origin);
      }
      const tab = url.searchParams.get('tabId') || '';
      body = {
        requestId: url.searchParams.get('requestId'),
        owner: {
          tabId: /^\d+$/.test(tab) ? Number(tab) : -1,
          documentId: url.searchParams.get('documentId')
        }
      };
    } else {
      const raw = await readBody(req);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return sendJson(json, res, 400, { ok: false, error: 'invalid_task_box_request' }, origin);
      }
      body = raw;
      if (Object.keys(body).some(key => !['requestId', 'owner'].includes(key))) {
        return sendJson(json, res, 400, { ok: false, error: 'invalid_task_box_request' }, origin);
      }
    }
  } catch (error) {
    if (error && error.message === 'body_too_large') {
      tooLarge(res, origin);
      return true;
    }
    return sendJson(json, res, 400, { ok: false, error: 'invalid_task_box_request' }, origin);
  }

  const owner = body.owner;
  if (!owner || Array.isArray(owner) ||
      Object.keys(owner).some(key => !['tabId', 'documentId'].includes(key)) ||
      !Number.isSafeInteger(owner.tabId) || owner.tabId < 0 ||
      typeof owner.documentId !== 'string' || owner.documentId.length < 1 || owner.documentId.length > 256 ||
      typeof body.requestId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.requestId)) {
    return sendJson(json, res, 400, { ok: false, error: 'invalid_task_box_request' }, origin);
  }

  const source = { tabId: owner.tabId, documentId: owner.documentId };
  const clearService = taskBoxClearService(readState, writeState, clear);
  const result = isStatus
    ? await clearService.status(source, body.requestId)
    : await clearService.request(source, body.requestId);
  return sendJson(json, res, result.ok ? 200 : 409, { protocol: 1, ...result }, origin);
}

module.exports = { handleTaskBox };
