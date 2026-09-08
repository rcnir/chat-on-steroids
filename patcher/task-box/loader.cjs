'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { handleTaskBox } = require('./index.cjs');

/** Strict, atomic storage at the existing receipt path. No migration, expiry or reset. */
function receiptStore(userData) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw new Error('TASK_BOX_INVALID_DATA_ROOT');
  const dir = path.join(userData, 'state');
  const file = path.join(dir, 'task-box-clear.json');
  return {
    async readState() {
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('TASK_BOX_INVALID_RECEIPT_FILE');
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        if (value === null) throw new Error('TASK_BOX_INVALID_RECEIPT_STATE');
        return value;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async writeState(value) {
      if (!value || typeof value !== 'object') throw new Error('TASK_BOX_INVALID_RECEIPT_WRITE');
      await fs.mkdir(dir, { recursive: true });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
        await handle.close(); handle = null;
        await fs.rename(temporary, file);
        const directory = await fs.open(dir, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally {
        await handle?.close();
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  };
}

exports.createLoader = function createLoader({ getUserData }) {
  if (typeof getUserData !== 'function') throw new TypeError('getUserData required');
  let official;
  let store;
  let inFlight = null;
  // A stable callback identity, shared by the captured official UI and addon requests.
  const clear = () => {
    if (!official) return Promise.reject(new Error('TASK_BOX_OFFICIAL_CLEAR_UNAVAILABLE'));
    if (!inFlight) inFlight = Promise.resolve().then(official).finally(() => { inFlight = null; });
    return inFlight;
  };
  return Object.freeze({
    captureClear(callback) {
      if (official || typeof callback !== 'function') throw new Error('TASK_BOX_CLEAR_REGISTRATION_MISMATCH');
      official = callback;
      return clear;
    },
    async handleTaskBox(context) {
      if (!['/task-box/capabilities', '/task-box/clear', '/task-box/clear/status'].includes(context.route)) return false;
      if (!official) {
        context.json(context.res, 503, { ok: false, error: 'TASK_BOX_OFFICIAL_CLEAR_UNAVAILABLE' }, context.origin);
        return true;
      }
      store ??= receiptStore(getUserData());
      return handleTaskBox({ ...context, ...store, clear });
    }
  });
};
