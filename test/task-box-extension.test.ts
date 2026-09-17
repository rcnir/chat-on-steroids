import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const extension = path.join(process.cwd(), 'extension');
const compatibilitySource = readFileSync(path.join(extension, 'task-box-compatibility.js'), 'utf8');
const coreSource = readFileSync(path.join(extension, 'task-box-core.js'), 'utf8');
const coordinatorSource = readFileSync(path.join(extension, 'task-box-coordinator.js'), 'utf8');
const backgroundSource = readFileSync(path.join(extension, 'task-box-background.js'), 'utf8');
const contentSource = readFileSync(path.join(extension, 'task-box.js'), 'utf8');

const FEATURE = 'taskBoxIntegrationEnabled';
const GLOBAL = 'taskBoxCreationGlobal';
const PROTOCOL = 1;
const conversationId = '11111111-2222-4333-8444-555555555555';
const requestOne = '11111111-2222-4333-8444-555555555551';
const requestLocked = '22222222-3333-4444-8555-666666666661';
const requestNew = '33333333-4444-4555-8666-777777777771';
const requestCreateOne = '44444444-5555-4666-8777-888888888881';
const requestCreateTwo = '55555555-6666-4777-8888-999999999991';
const sender = {
  tab: { id: 17 },
  frameId: 0,
  documentId: 'document-17',
  url: `https://chatgpt.com/c/${conversationId}`
};

type ChangeListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

function makeChromeStorage(seed: Record<string, unknown> = {}) {
  const data: Record<string, any> = structuredClone(seed);
  const listeners = new Set<ChangeListener>();
  let holdNotifications = false;
  const pendingNotifications: Array<Record<string, { oldValue?: unknown; newValue?: unknown }>> = [];
  const local = {
    async get(keys: string | string[]) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
    },
    async set(values: Record<string, unknown>) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: structuredClone(data[key]), newValue: structuredClone(value) };
        data[key] = structuredClone(value);
      }
      if (holdNotifications) pendingNotifications.push(changes);
      else for (const listener of listeners) listener(changes, 'local');
    }
  };
  const onChanged = {
    addListener(listener: ChangeListener) { listeners.add(listener); },
    removeListener(listener: ChangeListener) { listeners.delete(listener); }
  };
  return {
    data, local, onChanged,
    holdChanges() { holdNotifications = true; },
    flushChanges() {
      holdNotifications = false;
      for (const changes of pendingNotifications.splice(0)) {
        for (const listener of listeners) listener(changes, 'local');
      }
    }
  };
}

function makeBackground(seed: Record<string, unknown> = {}, bridge?: (...args: any[]) => Promise<any>) {
  const storage = makeChromeStorage(seed);
  const calls: Array<{ path: string; init: any; retried: unknown }> = [];
  const call = async (route: string, init: any = {}, retried?: boolean) => {
    calls.push({ path: route, init, retried });
    if (route === '/task-box/capabilities') {
      return { ok: true, data: { protocol: PROTOCOL, supported: true, atMostOnce: true, durableReceipts: true } };
    }
    return bridge ? bridge(route, init, retried) : { ok: false, status: 0, error: 'unexpected_bridge_call' };
  };
  const chrome = {
    storage: { local: storage.local },
    runtime: { getManifest: () => ({ version: '2.0.6' }) }
  };
  const box: any = { URL, URLSearchParams, structuredClone, console };
  vm.runInNewContext(compatibilitySource, box);
  vm.runInNewContext(coordinatorSource, box);
  vm.runInNewContext(backgroundSource, box);
  const registered = box.CLFTaskBoxBackground.registerTaskBox({ chrome, call });
  const api = {
    ...registered,
    handle(
      message: any,
      owner: any,
      assertCurrent: () => boolean = () => true,
      currentConversation: () => string | null | Promise<string | null> = () => {
        try {
          return new URL(owner?.url || '').pathname.match(/^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/)?.[1] || null;
        } catch {
          return null;
        }
      }
    ) {
      return registered.handle(message, owner, assertCurrent, currentConversation);
    }
  };
  return { storage, calls, chrome, api, coordinator: box.CLFTaskBoxCoordinator };
}

function taskRow(name = 'TASK BOX', id = 'task-old') {
  return `<div class="project-row" data-row="${id}">
    <a href="/g/${id}"><span class="_NCija_content">${name}</span></a>
    <button aria-label="Pin project">pin</button>
    <button aria-label="Open project options for ${name}" aria-haspopup="menu">…</button>
  </div>`;
}

function makeNativeProjectMenu(document: Document) {
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button role="menuitem" aria-label="プロジェクトを共有">プロジェクトを共有</button>
    <div role="separator"></div>
    <button role="menuitem">プロジェクトを削除する</button>`;
  return menu;
}

async function makeContent(
  html: string,
  seed: Record<string, unknown>,
  bridge?: (...args: any[]) => Promise<any>
) {
  const background = makeBackground(seed, bridge);
  const dom = new JSDOM(html, { url: `https://chatgpt.com/c/${conversationId}`, runScripts: 'outside-only' });
  const { window } = dom;
  (window as any).__CLF_TASK_BOX_TEST__ = true;
  const runtimeListeners = new Set<(message: any, sender: any, sendResponse: (value: any) => void) => boolean | void>();
  const runtime: any = {
    id: 'companion-test',
    getManifest: () => ({ version: '2.0.6' }),
    sendMessage: (message: any) => background.api.handle(message, sender),
    onMessage: {
      addListener(listener: any) { runtimeListeners.add(listener); },
      removeListener(listener: any) { runtimeListeners.delete(listener); }
    }
  };
  (window as any).chrome = {
    storage: { local: background.storage.local, onChanged: background.storage.onChanged },
    runtime
  };
  window.eval(coreSource);
  window.eval(compatibilitySource);
  window.eval(contentSource);
  const started = await (window as any).CLFTaskBox.start();
  return {
    ...background,
    dom,
    window: window as any,
    document: window.document,
    hooks: (window as any).CLFTaskBoxTestHooks,
    runtime,
    dispatchRuntimeMessage(message: any) {
      return new Promise<any>((resolve) => {
        let settled = false;
        const sendResponse = (value: any) => { if (!settled) { settled = true; resolve(value); } };
        for (const listener of runtimeListeners) {
          const async = listener(message, { id: 'companion-test' }, sendResponse);
          if (settled) return;
          if (async === true) return;
        }
        if (!settled) resolve(undefined);
      });
    },
    started
  };
}

function closeContent(h: { window: any; dom: JSDOM }) {
  try { h.window.__CLF_TASK_BOX_RUNTIME__?.stop?.(); } catch {}
  h.dom.window.close();
}

describe('companion TASK BOX bridge and lifecycle', () => {
  it('is default-off and performs zero bridge or project UI work without explicit cutover', async () => {
    const h = await makeContent(`<nav>${taskRow()}</nav>`, {});
    expect(h.started).toEqual({ ok: true, enabled: false, protocol: PROTOCOL });
    expect(h.calls).toHaveLength(0);
    expect(h.document.querySelector('[data-cos-box-clear-sidebar]')).toBeNull();
    expect(h.storage.data[GLOBAL]).toBeUndefined();
    closeContent(h);
  });

  it('uses one Clear POST and status-only reconciliation for the exact pending request', async () => {
    let statusReads = 0;
    const h = makeBackground({ [FEATURE]: true, [GLOBAL]: { state: 'present', generation: 2 } }, async (route) => {
      if (route === '/task-box/clear') return { ok: false, status: 0, error: 'TIMED_OUT' };
      if (route.startsWith('/task-box/clear/status?')) {
        statusReads += 1;
        return statusReads === 1
          ? { ok: true, data: { ok: true, status: 'incomplete', requestId: requestOne, protocol: PROTOCOL } }
          : { ok: true, data: { ok: true, status: 'completed', requestId: requestOne, protocol: PROTOCOL } };
      }
      throw new Error(`unexpected ${route}`);
    });
    const message = { type: 'clf-task-box:clear', protocol: PROTOCOL, requestId: requestOne };
    expect((await h.api.handle(message, sender)).ok).toBe(false);
    expect(h.storage.data[GLOBAL]).toMatchObject({ state: 'deleting', requestId: requestOne, clearCompleted: false });
    const reconciled = await h.api.handle(message, sender);
    expect(reconciled).toMatchObject({ ok: true, status: 'completed', requestId: requestOne, protocol: PROTOCOL });
    expect(h.calls.filter((entry) => entry.path === '/task-box/clear')).toHaveLength(1);
    expect(h.calls.filter((entry) => entry.path.startsWith('/task-box/clear/status?'))).toHaveLength(2);
    expect(h.calls.find((entry) => entry.path === '/task-box/clear')?.retried).toBe(true);
    expect(h.storage.data[GLOBAL]).toMatchObject({ state: 'deleting', clearCompleted: true });
    expect(h.storage.data[`taskBoxClearAttempt:${requestOne}`].state).toBe('completed');
  });

  it('keeps malformed/incomplete Clear results locked and never POSTs a different request through that lock', async () => {
    const h = makeBackground({ [FEATURE]: true, [GLOBAL]: { state: 'present', generation: 0 } }, async (route) => {
      if (route === '/task-box/clear') {
        return { ok: true, data: { ok: true, status: 'completed', requestId: requestNew, protocol: PROTOCOL } };
      }
      return { ok: true, data: { ok: true, status: 'busy', requestId: requestLocked, protocol: PROTOCOL } };
    });
    const first = await h.api.handle({ type: 'clf-task-box:clear', protocol: PROTOCOL, requestId: requestLocked }, sender);
    expect(first.ok).toBe(false);
    expect(h.storage.data[GLOBAL]).toMatchObject({ state: 'deleting', requestId: requestLocked, clearCompleted: false });
    const second = await h.api.handle({ type: 'clf-task-box:clear', protocol: PROTOCOL, requestId: requestNew }, sender);
    expect(second).toMatchObject({ ok: false, error: 'TASK_BOX_DELETE_NOT_AVAILABLE' });
    expect(h.calls.filter((entry) => entry.path === '/task-box/clear')).toHaveLength(1);
  });

  it('requires protocol-1 durable at-most-once capability before starting a new flow', async () => {
    const storage = makeChromeStorage({ [FEATURE]: true, [GLOBAL]: { state: 'present', generation: 0 } });
    const calls: string[] = [];
    const chrome = { storage: { local: storage.local }, runtime: { getManifest: () => ({ version: '2.0.6' }) } };
    const box: any = { URL, URLSearchParams, structuredClone, console };
    vm.runInNewContext(compatibilitySource, box);
    vm.runInNewContext(coordinatorSource, box);
    vm.runInNewContext(backgroundSource, box);
    const api = box.CLFTaskBoxBackground.registerTaskBox({
      chrome,
      call: async (route: string) => {
        calls.push(route);
        return { ok: true, data: { protocol: PROTOCOL, supported: true, atMostOnce: false, durableReceipts: true } };
      }
    });
    const result = await api.handle({ type: 'clf-task-box:clear', protocol: PROTOCOL, requestId: requestOne }, sender, () => true);
    expect(result).toMatchObject({ ok: false, error: 'TASK_BOX_CAPABILITY_UNAVAILABLE' });
    expect(calls).toEqual(['/task-box/capabilities']);
    expect(storage.data[GLOBAL]).toEqual({ state: 'present', generation: 0 });
    expect(storage.data[`taskBoxClearAttempt:${requestOne}`]).toBeUndefined();
  });

  it('does not mark browser lifecycle complete when cutover is disabled while Clear is in flight', async () => {
    const storage = makeChromeStorage({ [FEATURE]: true, [GLOBAL]: { state: 'present', generation: 0 } });
    const chrome = { storage: { local: storage.local }, runtime: { getManifest: () => ({ version: '2.0.6' }) } };
    const box: any = { URL, URLSearchParams, structuredClone, console };
    vm.runInNewContext(compatibilitySource, box);
    vm.runInNewContext(coordinatorSource, box);
    vm.runInNewContext(backgroundSource, box);
    const api = box.CLFTaskBoxBackground.registerTaskBox({
      chrome,
      call: async (route: string, init: any) => {
        if (route === '/task-box/capabilities') {
          return { ok: true, data: { protocol: PROTOCOL, supported: true, atMostOnce: true, durableReceipts: true } };
        }
        if (route === '/task-box/clear') {
          await storage.local.set({ [FEATURE]: false });
          const body = JSON.parse(init.body);
          return { ok: true, data: { ok: true, status: 'completed', requestId: body.requestId, protocol: PROTOCOL } };
        }
        throw new Error(`unexpected ${route}`);
      }
    });
    const result = await api.handle({ type: 'clf-task-box:clear', protocol: PROTOCOL, requestId: requestOne }, sender, () => true);
    expect(result).toMatchObject({ ok: false, error: 'TASK_BOX_DISABLED' });
    expect(storage.data[GLOBAL]).toMatchObject({ state: 'deleting', requestId: requestOne, clearCompleted: false });
    expect(storage.data[`taskBoxClearAttempt:${requestOne}`].state).toBe('reserved');
  });

  it('refuses destructive dispatch when the shared document guard turns stale after capability await', async () => {
    let current = true;
    const box: any = { URL, URLSearchParams, structuredClone, console };
    vm.runInNewContext(compatibilitySource, box);
    const storage = makeChromeStorage({ [FEATURE]: true, [GLOBAL]: { state: 'present', generation: 0 } });
    vm.runInNewContext(coordinatorSource, box);
    vm.runInNewContext(backgroundSource, box);
    const calls: string[] = [];
    const registered = box.CLFTaskBoxBackground.registerTaskBox({
      chrome: { storage: { local: storage.local }, runtime: { getManifest: () => ({ version: '2.0.6' }) } },
      call: async (route: string) => {
        calls.push(route);
        if (route === '/task-box/capabilities') {
          current = false;
          return { ok: true, data: { protocol: PROTOCOL, supported: true, atMostOnce: true, durableReceipts: true } };
        }
        throw new Error('destructive bridge dispatch must not run');
      }
    });
    const result = await registered.handle(
      { type: 'clf-task-box:clear', protocol: PROTOCOL, requestId: requestOne }, sender, () => current
    );
    expect(result).toMatchObject({ ok: false, error: 'STALE_TASK_BOX_DOCUMENT' });
    expect(calls).toEqual(['/task-box/capabilities']);
    expect(storage.data[GLOBAL]).toEqual({ state: 'present', generation: 0 });
  });

  it('derives owner from MessageSender and preserves one global worker-create authority', async () => {
    const h = makeBackground({ [FEATURE]: true });
    const reserve = await h.api.handle({
      type: 'clf-task-box:reserve-create', protocol: PROTOCOL, requestId: requestCreateOne, conversationId,
      owner: { tabId: 999, documentId: 'forged' }
    }, sender);
    expect(reserve.reserved).toBe(true);
    expect(h.storage.data[GLOBAL].owner).toEqual({ tabId: 17, documentId: 'document-17' });
    expect(h.storage.data[`taskBoxCreationAttempt:${conversationId}`]).toMatchObject({ tabId: 17, documentId: 'document-17' });
    const otherSender = { ...sender, tab: { id: 18 }, documentId: 'document-18', url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    const other = await h.api.handle({
      type: 'clf-task-box:reserve-create', protocol: PROTOCOL, requestId: requestCreateTwo,
      conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    }, otherSender);
    expect(other).toMatchObject({ ok: false, error: 'TASK_BOX_GLOBAL_NOT_OPEN' });
  });

  it('uses the companion current-tab conversation authority when MessageSender.url is transiently id-less', async () => {
    const h = makeBackground({ [FEATURE]: true });
    const transientSender = { ...sender, url: 'https://chatgpt.com/' };
    const reserve = await h.api.handle({
      type: 'clf-task-box:reserve-create', protocol: PROTOCOL, requestId: requestCreateOne, conversationId
    }, transientSender, () => true, () => conversationId);
    expect(reserve).toMatchObject({ ok: true, reserved: true });
    expect(h.storage.data[GLOBAL]).toMatchObject({
      state: 'reserved', conversationId, owner: { tabId: 17, documentId: 'document-17' }
    });
  });

  it('rejects reserve-create when the current tab has navigated to a different conversation even if MessageSender.url is stale', async () => {
    const h = makeBackground({ [FEATURE]: true });
    const currentConversation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const reserve = await h.api.handle({
      type: 'clf-task-box:reserve-create', protocol: PROTOCOL, requestId: requestCreateOne, conversationId
    }, sender, () => true, () => currentConversation);
    expect(reserve).toMatchObject({ ok: false, error: 'INVALID_CREATE_OWNER' });
    expect(h.storage.data[GLOBAL]).toBeUndefined();
  });

  it('reconciles an exact completed Clear after human-confirmed manual Project deletion without replaying Clear', async () => {
    const h = makeBackground({
      [FEATURE]: true,
      [GLOBAL]: {
        state: 'deleting', generation: 14, kind: 'clear', requestId: requestOne,
        owner: { tabId: 17, documentId: 'document-17' }, clearCompleted: true
      },
      [`taskBoxClearAttempt:${requestOne}`]: {
        state: 'completed', generation: 14, requestId: requestOne, kind: 'clear',
        owner: { tabId: 17, documentId: 'document-17' }
      }
    }, async (route) => {
      if (route.startsWith('/task-box/clear/status?')) {
        return { ok: true, data: { ok: true, status: 'completed', requestId: requestOne, protocol: PROTOCOL } };
      }
      throw new Error(`unexpected ${route}`);
    });

    const recovery = await h.api.recoverManualDeletion(requestOne, 14);
    expect(recovery).toMatchObject({ ok: true, recovered: true, state: 'open', generation: 15 });
    expect(h.storage.data[GLOBAL]).toEqual({ state: 'open', generation: 15 });
    expect(h.storage.data[`taskBoxClearAttempt:${requestOne}`]).toMatchObject({ state: 'completed', generation: 14 });
    expect(h.storage.data[`taskBoxManualRecovery:${requestOne}`]).toMatchObject({
      state: 'completed', requestId: requestOne, fromGeneration: 14, toGeneration: 15,
      reason: 'human-attested-manual-project-delete'
    });
    expect(h.calls.filter((entry) => entry.path === '/task-box/clear')).toHaveLength(0);
    expect(h.calls.filter((entry) => entry.path.startsWith('/task-box/clear/status?'))).toHaveLength(1);

    const repeated = await h.api.recoverManualDeletion(requestOne, 14);
    expect(repeated).toMatchObject({ ok: true, recovered: true, alreadyRecovered: true, generation: 15 });
    expect(h.calls.filter((entry) => entry.path.startsWith('/task-box/clear/status?'))).toHaveLength(1);
  });

  it('never releases a non-completed or mismatched lifecycle through manual-deletion recovery', async () => {
    for (const lifecycle of [
      { state: 'deleting', generation: 14, kind: 'clear', requestId: requestOne,
        owner: { tabId: 17, documentId: 'document-17' }, clearCompleted: false },
      { state: 'deleting', generation: 14, kind: 'manual', requestId: requestOne,
        owner: { tabId: 17, documentId: 'document-17' }, clearCompleted: true },
      { state: 'reserved', generation: 14, requestId: requestOne,
        owner: { tabId: 17, documentId: 'document-17' } },
      { state: 'open', generation: 14 },
      { state: 'present', generation: 14 }
    ]) {
      const h = makeBackground({ [FEATURE]: true, [GLOBAL]: lifecycle });
      const before = structuredClone(h.storage.data);
      const result = await h.api.recoverManualDeletion(requestOne, 14);
      expect(result).toMatchObject({ ok: false, error: 'TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE' });
      expect(h.storage.data).toEqual(before);
    }
  });

  it('requires the exact completed app receipt before releasing a manually deleted Clear lifecycle', async () => {
    const seed = {
      [FEATURE]: true,
      [GLOBAL]: {
        state: 'deleting', generation: 14, kind: 'clear', requestId: requestOne,
        owner: { tabId: 17, documentId: 'document-17' }, clearCompleted: true
      },
      [`taskBoxClearAttempt:${requestOne}`]: {
        state: 'completed', generation: 14, requestId: requestOne, kind: 'clear',
        owner: { tabId: 17, documentId: 'document-17' }
      }
    };
    const h = makeBackground(seed, async (route) => {
      if (route.startsWith('/task-box/clear/status?')) {
        return { ok: true, data: { ok: true, status: 'incomplete', requestId: requestOne, protocol: PROTOCOL } };
      }
      throw new Error(`unexpected ${route}`);
    });
    const result = await h.api.recoverManualDeletion(requestOne, 14);
    expect(result).toMatchObject({ ok: false, error: 'TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE' });
    expect(h.storage.data).toEqual(seed);
    expect(h.calls.filter((entry) => entry.path === '/task-box/clear')).toHaveLength(0);
  });

  it('does not release a completed Clear when its browser lifecycle changes during app receipt verification', async () => {
    const seed = {
      [FEATURE]: true,
      [GLOBAL]: {
        state: 'deleting', generation: 14, kind: 'clear', requestId: requestOne,
        owner: { tabId: 17, documentId: 'document-17' }, clearCompleted: true
      },
      [`taskBoxClearAttempt:${requestOne}`]: {
        state: 'completed', generation: 14, requestId: requestOne, kind: 'clear',
        owner: { tabId: 17, documentId: 'document-17' }
      }
    };
    let h: ReturnType<typeof makeBackground>;
    h = makeBackground(seed, async (route) => {
      if (route.startsWith('/task-box/clear/status?')) {
        await h.storage.local.set({ [GLOBAL]: { state: 'present', generation: 14 } });
        return { ok: true, data: { ok: true, status: 'completed', requestId: requestOne, protocol: PROTOCOL } };
      }
      throw new Error(`unexpected ${route}`);
    });
    const result = await h.api.recoverManualDeletion(requestOne, 14);
    expect(result).toMatchObject({ ok: false, error: 'TASK_BOX_STATE_CHANGED' });
    expect(h.storage.data[GLOBAL]).toEqual({ state: 'present', generation: 14 });
    expect(h.storage.data[`taskBoxManualRecovery:${requestOne}`]).toBeUndefined();
    expect(h.calls.filter((entry) => entry.path === '/task-box/clear')).toHaveLength(0);
  });

  it('binds manual-deletion recovery to the exact request and generation', async () => {
    const seed = {
      [FEATURE]: true,
      [GLOBAL]: {
        state: 'deleting', generation: 14, kind: 'clear', requestId: requestOne,
        owner: { tabId: 17, documentId: 'document-17' }, clearCompleted: true
      },
      [`taskBoxClearAttempt:${requestOne}`]: {
        state: 'completed', generation: 14, requestId: requestOne, kind: 'clear',
        owner: { tabId: 17, documentId: 'document-17' }
      }
    };
    for (const [requestId, generation] of [[requestNew, 14], [requestOne, 13], [requestOne, 15]] as const) {
      const h = makeBackground(seed);
      const result = await h.api.recoverManualDeletion(requestId, generation);
      expect(result).toMatchObject({ ok: false, error: 'TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE' });
      expect(h.storage.data).toEqual(seed);
      expect(h.calls).toHaveLength(0);
    }
  });

  it('requires the browser completed-attempt fence and an enabled feature before app receipt lookup', async () => {
    const lifecycle = {
      state: 'deleting', generation: 14, kind: 'clear', requestId: requestOne,
      owner: { tabId: 17, documentId: 'document-17' }, clearCompleted: true
    };
    const missingAttempt = makeBackground({ [FEATURE]: true, [GLOBAL]: lifecycle });
    expect(await missingAttempt.api.recoverManualDeletion(requestOne, 14))
      .toMatchObject({ ok: false, error: 'TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE' });
    expect(missingAttempt.calls).toHaveLength(0);

    const disabled = makeBackground({
      [FEATURE]: false,
      [GLOBAL]: lifecycle,
      [`taskBoxClearAttempt:${requestOne}`]: {
        state: 'completed', generation: 14, requestId: requestOne, kind: 'clear',
        owner: { tabId: 17, documentId: 'document-17' }
      }
    });
    expect(await disabled.api.recoverManualDeletion(requestOne, 14))
      .toMatchObject({ ok: false, error: 'TASK_BOX_DISABLED' });
    expect(disabled.calls).toHaveLength(0);
  });

  it('rejects a completed app status for any request other than the bound Clear', async () => {
    const seed = {
      [FEATURE]: true,
      [GLOBAL]: {
        state: 'deleting', generation: 14, kind: 'clear', requestId: requestOne,
        owner: { tabId: 17, documentId: 'document-17' }, clearCompleted: true
      },
      [`taskBoxClearAttempt:${requestOne}`]: {
        state: 'completed', generation: 14, requestId: requestOne, kind: 'clear',
        owner: { tabId: 17, documentId: 'document-17' }
      }
    };
    const h = makeBackground(seed, async (route) => {
      if (route.startsWith('/task-box/clear/status?')) {
        return { ok: true, data: { ok: true, status: 'completed', requestId: requestNew, protocol: PROTOCOL } };
      }
      throw new Error(`unexpected ${route}`);
    });
    expect(await h.api.recoverManualDeletion(requestOne, 14))
      .toMatchObject({ ok: false, error: 'TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE' });
    expect(h.storage.data).toEqual(seed);
    expect(h.calls.filter((entry) => entry.path === '/task-box/clear')).toHaveLength(0);
  });

  it('never overwrites an existing conflicting manual-recovery receipt', async () => {
    const recoveryKey = `taskBoxManualRecovery:${requestOne}`;
    const seed = {
      [FEATURE]: true,
      [GLOBAL]: {
        state: 'deleting', generation: 14, kind: 'clear', requestId: requestOne,
        owner: { tabId: 17, documentId: 'document-17' }, clearCompleted: true
      },
      [`taskBoxClearAttempt:${requestOne}`]: {
        state: 'completed', generation: 14, requestId: requestOne, kind: 'clear',
        owner: { tabId: 17, documentId: 'document-17' }
      },
      [recoveryKey]: {
        state: 'pending', requestId: requestOne, fromGeneration: 14, toGeneration: 15,
        reason: 'human-attested-manual-project-delete'
      }
    };
    const h = makeBackground(seed);
    expect(await h.api.recoverManualDeletion(requestOne, 14))
      .toMatchObject({ ok: false, error: 'TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE' });
    expect(h.storage.data).toEqual(seed);
    expect(h.calls).toHaveLength(0);
  });

  it('moves one exact orphaned cleanup reservation to a new owner and completes it without replaying Clear', async () => {
    const oldOwner = { tabId: 17, documentId: 'document-17' };
    const newOwner = { tabId: 99, documentId: 'repair-document' };
    const seed = {
      [FEATURE]: true,
      [GLOBAL]: {
        state: 'reserved', generation: 15, mode: 'cleanup', requestId: requestOne, owner: oldOwner
      },
      [`taskBoxClearAttempt:${requestOne}`]: {
        state: 'completed', generation: 14, requestId: requestOne, kind: 'clear', owner: oldOwner
      }
    };
    const h = makeBackground(seed);
    const coordinator = h.coordinator.create(h.storage.local);

    expect(await coordinator.cleanupRecoveryStatus(requestOne, 15)).toMatchObject({
      ok: true, available: true, generation: 15, owner: oldOwner,
      ticket: { generation: 15, requestId: requestOne, mode: 'cleanup' }
    });
    const claimed = await coordinator.claimCleanupRecovery(newOwner, requestOne, 15);
    expect(claimed).toMatchObject({
      ok: true, claimed: true, generation: 15, owner: newOwner, fromOwner: oldOwner,
      ticket: { generation: 15, requestId: requestOne, mode: 'cleanup' }
    });
    expect(h.storage.data[GLOBAL]).toMatchObject({ state: 'reserved', generation: 15, mode: 'cleanup', owner: newOwner });
    expect(h.storage.data[`taskBoxCleanupRecovery:${requestOne}`]).toMatchObject({
      state: 'claimed', requestId: requestOne, generation: 15,
      reason: 'orphaned-cleanup-reservation', fromOwner: oldOwner, toOwner: newOwner
    });

    expect(await coordinator.completeCreation(newOwner, claimed.ticket)).toMatchObject({ ok: true, completed: true, state: 'present' });
    expect(h.storage.data[GLOBAL]).toEqual({ state: 'present', generation: 15 });
    expect(h.storage.data[`taskBoxCleanupRecovery:${requestOne}`]).toMatchObject({ state: 'completed' });
    expect(await coordinator.cleanupRecoveryStatus(requestOne, 15)).toMatchObject({
      ok: true, alreadyRecovered: true, state: 'present', generation: 15
    });
    expect(h.calls.filter((entry) => entry.path === '/task-box/clear')).toHaveLength(0);
  });

  it('never claims cleanup recovery without the exact prior completed Clear attempt', async () => {
    const oldOwner = { tabId: 17, documentId: 'document-17' };
    const newOwner = { tabId: 99, documentId: 'repair-document' };
    for (const attempt of [
      undefined,
      { state: 'reserved', generation: 14, requestId: requestOne, kind: 'clear', owner: oldOwner },
      { state: 'completed', generation: 13, requestId: requestOne, kind: 'clear', owner: oldOwner },
      { state: 'completed', generation: 14, requestId: requestNew, kind: 'clear', owner: oldOwner }
    ]) {
      const seed: Record<string, unknown> = {
        [FEATURE]: true,
        [GLOBAL]: { state: 'reserved', generation: 15, mode: 'cleanup', requestId: requestOne, owner: oldOwner }
      };
      if (attempt) seed[`taskBoxClearAttempt:${requestOne}`] = attempt;
      const h = makeBackground(seed);
      const coordinator = h.coordinator.create(h.storage.local);
      const before = structuredClone(h.storage.data);
      expect(await coordinator.claimCleanupRecovery(newOwner, requestOne, 15))
        .toMatchObject({ ok: false, error: 'TASK_BOX_CLEANUP_RECOVERY_NOT_AVAILABLE' });
      expect(h.storage.data).toEqual(before);
    }
  });

  it('requires the exact completed app receipt and a dead old document before cleanup recovery can start', async () => {
    const oldOwner = { tabId: 17, documentId: 'document-17' };
    const seed = {
      [FEATURE]: true,
      [GLOBAL]: { state: 'reserved', generation: 15, mode: 'cleanup', requestId: requestOne, owner: oldOwner },
      [`taskBoxClearAttempt:${requestOne}`]: {
        state: 'completed', generation: 14, requestId: requestOne, kind: 'clear', owner: oldOwner
      }
    };
    const noReceipt = makeBackground(seed, async (route) => {
      if (route.startsWith('/task-box/clear/status?')) {
        return { ok: true, data: { ok: true, status: 'incomplete', requestId: requestOne, protocol: PROTOCOL } };
      }
      throw new Error(`unexpected ${route}`);
    });
    expect(await noReceipt.api.cleanupRecoveryStatus(requestOne, 15))
      .toMatchObject({ ok: false, error: 'TASK_BOX_CLEANUP_RECOVERY_NOT_AVAILABLE' });

    const ownerAlive = makeBackground(seed, async (route) => {
      if (route.startsWith('/task-box/clear/status?')) {
        return { ok: true, data: { ok: true, status: 'completed', requestId: requestOne, protocol: PROTOCOL } };
      }
      throw new Error(`unexpected ${route}`);
    });
    (ownerAlive.chrome as any).tabs = {
      sendMessage: vi.fn(async () => ({ ok: true, protocol: PROTOCOL }))
    };
    expect(await ownerAlive.api.cleanupRecoveryStatus(requestOne, 15))
      .toMatchObject({ ok: false, error: 'TASK_BOX_CLEANUP_OWNER_STILL_LIVE' });
    expect(ownerAlive.storage.data).toEqual(seed);
  });

  it('uses one inactive repair tab to finish an orphaned cleanup and closes only that tab on success', async () => {
    const oldOwner = { tabId: 17, documentId: 'document-17' };
    const repairSender = {
      tab: { id: 99 }, frameId: 0, documentId: 'repair-document', url: 'https://chatgpt.com/'
    };
    const seed = {
      [FEATURE]: true,
      [GLOBAL]: { state: 'reserved', generation: 15, mode: 'cleanup', requestId: requestOne, owner: oldOwner },
      [`taskBoxClearAttempt:${requestOne}`]: {
        state: 'completed', generation: 14, requestId: requestOne, kind: 'clear', owner: oldOwner
      }
    };
    const h = makeBackground(seed, async (route) => {
      if (route.startsWith('/task-box/clear/status?')) {
        return { ok: true, data: { ok: true, status: 'completed', requestId: requestOne, protocol: PROTOCOL } };
      }
      throw new Error(`unexpected ${route}`);
    });
    const removed: number[] = [];
    (h.chrome as any).tabs = {
      create: vi.fn(async (options: any) => ({ id: 99, url: options.url, status: 'complete', active: options.active })),
      get: vi.fn(async (id: number) => ({ id, url: 'https://chatgpt.com/', status: 'complete' })),
      remove: vi.fn(async (id: number) => { removed.push(id); }),
      sendMessage: vi.fn(async (id: number, message: any, options?: any) => {
        if (id === oldOwner.tabId && options?.documentId === oldOwner.documentId) throw new Error('No document');
        if (id !== 99) throw new Error('Unexpected tab');
        if (message.type === 'clf-task-box-recovery:prepare') return { ok: true, ready: true };
        if (message.type === 'clf-task-box-recovery:execute') {
          const claim = await h.api.handle({
            type: 'clf-task-box:claim-cleanup-recovery', protocol: PROTOCOL, requestId: requestOne, generation: 15
          }, repairSender);
          expect(claim).toMatchObject({ ok: true, claimed: true });
          const completed = await h.api.handle({
            type: 'clf-task-box:complete-create', protocol: PROTOCOL, ticket: claim.ticket
          }, repairSender);
          expect(completed).toMatchObject({ ok: true, completed: true, state: 'present' });
          return { ok: true, claimed: true, completed: true };
        }
        throw new Error(`Unexpected message ${message.type}`);
      })
    };
    (h.chrome as any).scripting = { executeScript: vi.fn(async () => []) };

    expect(await h.api.recoverCleanupReservation(requestOne, 15)).toMatchObject({
      ok: true, recovered: true, state: 'present', generation: 15, repairTabClosed: true
    });
    expect((h.chrome as any).tabs.create).toHaveBeenCalledWith({ url: 'https://chatgpt.com/', active: false });
    expect(removed).toEqual([99]);
    expect(h.storage.data[GLOBAL]).toEqual({ state: 'present', generation: 15 });
    expect(h.calls.filter((entry) => entry.path === '/task-box/clear')).toHaveLength(0);
  });

  it('keeps the repair tab when creation is uncertain after the cleanup ticket was claimed', async () => {
    const oldOwner = { tabId: 17, documentId: 'document-17' };
    const repairSender = {
      tab: { id: 99 }, frameId: 0, documentId: 'repair-document', url: 'https://chatgpt.com/'
    };
    const seed = {
      [FEATURE]: true,
      [GLOBAL]: { state: 'reserved', generation: 15, mode: 'cleanup', requestId: requestOne, owner: oldOwner },
      [`taskBoxClearAttempt:${requestOne}`]: {
        state: 'completed', generation: 14, requestId: requestOne, kind: 'clear', owner: oldOwner
      }
    };
    const h = makeBackground(seed, async (route) => {
      if (route.startsWith('/task-box/clear/status?')) {
        return { ok: true, data: { ok: true, status: 'completed', requestId: requestOne, protocol: PROTOCOL } };
      }
      throw new Error(`unexpected ${route}`);
    });
    const remove = vi.fn(async () => undefined);
    (h.chrome as any).tabs = {
      create: vi.fn(async () => ({ id: 99, url: 'https://chatgpt.com/', status: 'complete', active: false })),
      get: vi.fn(async (id: number) => ({ id, url: 'https://chatgpt.com/', status: 'complete' })),
      remove,
      sendMessage: vi.fn(async (id: number, message: any, options?: any) => {
        if (id === oldOwner.tabId && options?.documentId === oldOwner.documentId) throw new Error('No document');
        if (message.type === 'clf-task-box-recovery:prepare') return { ok: true, ready: true };
        if (message.type === 'clf-task-box-recovery:execute') {
          const claim = await h.api.handle({
            type: 'clf-task-box:claim-cleanup-recovery', protocol: PROTOCOL, requestId: requestOne, generation: 15
          }, repairSender);
          expect(claim).toMatchObject({ ok: true, claimed: true });
          return { ok: false, claimed: true, error: 'CREATE_OUTCOME_UNKNOWN' };
        }
        throw new Error('unexpected message');
      })
    };
    (h.chrome as any).scripting = { executeScript: vi.fn(async () => []) };

    expect(await h.api.recoverCleanupReservation(requestOne, 15)).toMatchObject({
      ok: false, error: 'CREATE_OUTCOME_UNKNOWN', repairTabId: 99, claimed: true
    });
    expect(remove).not.toHaveBeenCalled();
    expect(h.storage.data[GLOBAL]).toMatchObject({ state: 'reserved', mode: 'cleanup', owner: { tabId: 99, documentId: 'repair-document' } });
  });

  it('keeps a durably claimed repair tab when the execute response is lost, then resumes the same tab without another Create owner', async () => {
    const oldOwner = { tabId: 17, documentId: 'document-17' };
    const repairOwner = { tabId: 99, documentId: 'repair-document' };
    const repairSender = {
      tab: { id: repairOwner.tabId }, frameId: 0, documentId: repairOwner.documentId, url: 'https://chatgpt.com/'
    };
    const seed = {
      [FEATURE]: true,
      [GLOBAL]: { state: 'reserved', generation: 15, mode: 'cleanup', requestId: requestOne, owner: oldOwner },
      [`taskBoxClearAttempt:${requestOne}`]: {
        state: 'completed', generation: 14, requestId: requestOne, kind: 'clear', owner: oldOwner
      }
    };
    const h = makeBackground(seed, async (route) => {
      if (route.startsWith('/task-box/clear/status?')) {
        return { ok: true, data: { ok: true, status: 'completed', requestId: requestOne, protocol: PROTOCOL } };
      }
      throw new Error(`unexpected ${route}`);
    });
    let executeCount = 0;
    const create = vi.fn(async () => ({ id: 99, url: 'https://chatgpt.com/', status: 'complete', active: false }));
    const remove = vi.fn(async () => undefined);
    (h.chrome as any).tabs = {
      create,
      get: vi.fn(async (id: number) => ({ id, url: 'https://chatgpt.com/', status: 'complete' })),
      remove,
      sendMessage: vi.fn(async (id: number, message: any, options?: any) => {
        if (id === oldOwner.tabId && options?.documentId === oldOwner.documentId) throw new Error('No old document');
        if (id !== repairOwner.tabId) throw new Error('Unexpected tab');
        if (message.type === 'clf-task-box-recovery:ping') {
          expect(options?.documentId).toBe(repairOwner.documentId);
          return { ok: true, protocol: PROTOCOL };
        }
        if (message.type === 'clf-task-box-recovery:prepare') return { ok: true, ready: true };
        if (message.type === 'clf-task-box-recovery:execute') {
          executeCount += 1;
          const claim = await h.api.handle({
            type: 'clf-task-box:claim-cleanup-recovery', protocol: PROTOCOL, requestId: requestOne, generation: 15
          }, repairSender);
          expect(claim).toMatchObject({ ok: true });
          throw new Error('response lost after durable claim');
        }
        if (message.type === 'clf-task-box-recovery:reconcile') {
          executeCount += 1;
          const claim = await h.api.handle({
            type: 'clf-task-box:claim-cleanup-recovery', protocol: PROTOCOL, requestId: requestOne, generation: 15
          }, repairSender);
          expect(claim).toMatchObject({ ok: true });
          const completed = await h.api.handle({
            type: 'clf-task-box:complete-create', protocol: PROTOCOL, ticket: claim.ticket
          }, repairSender);
          expect(completed).toMatchObject({ ok: true, completed: true, state: 'present' });
          return { ok: true, claimed: true, completed: true };
        }
        throw new Error('unexpected message');
      })
    };
    (h.chrome as any).scripting = { executeScript: vi.fn(async () => []) };

    expect(await h.api.recoverCleanupReservation(requestOne, 15)).toMatchObject({
      ok: false, error: 'response lost after durable claim', repairTabId: 99, claimed: true
    });
    expect(remove).not.toHaveBeenCalled();
    expect(h.storage.data[GLOBAL]).toMatchObject({ state: 'reserved', mode: 'cleanup', owner: repairOwner });
    expect(create).toHaveBeenCalledTimes(1);

    expect(await h.api.recoverCleanupReservation(requestOne, 15)).toMatchObject({
      ok: true, recovered: true, state: 'present', generation: 15, repairTabClosed: true
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(99);
    expect(h.storage.data[GLOBAL]).toEqual({ state: 'present', generation: 15 });
  });
});

describe('companion TASK BOX page behavior', () => {
  it('reconciles a claimed cleanup without clicking Create again', async () => {
    const oldOwner = { tabId: 88, documentId: 'old-document' };
    const repairOwner = { tabId: 17, documentId: 'document-17' };
    const h = await makeContent(
      `<nav id="sidebar"><button id="new-project" aria-label="New project">+</button></nav><div id="portal"></div>`,
      {
        [FEATURE]: true,
        [GLOBAL]: { state: 'reserved', generation: 15, mode: 'cleanup', requestId: requestOne, owner: repairOwner },
        [`taskBoxClearAttempt:${requestOne}`]: {
          state: 'completed', generation: 14, requestId: requestOne, kind: 'clear', owner: oldOwner
        },
        [`taskBoxCleanupRecovery:${requestOne}`]: {
          state: 'claimed', requestId: requestOne, generation: 15, reason: 'orphaned-cleanup-reservation',
          fromOwner: oldOwner, toOwner: repairOwner
        }
      }
    );
    let createClicks = 0;
    h.document.getElementById('new-project')!.addEventListener('click', () => { createClicks += 1; });

    expect(await h.dispatchRuntimeMessage({
      type: 'clf-task-box-recovery:reconcile', protocol: PROTOCOL, requestId: requestOne, generation: 15
    })).toMatchObject({ ok: false, claimed: true, error: 'TASK_BOX_CLEANUP_REPAIR_RECONCILE_MISSING' });
    expect(createClicks).toBe(0);
    expect(h.storage.data[GLOBAL]).toMatchObject({ state: 'reserved', owner: repairOwner });

    const shell = h.document.createElement('div');
    shell.innerHTML = taskRow('TASK BOX', 'task-reconciled');
    h.document.getElementById('sidebar')!.insertBefore(shell.firstElementChild!, h.document.getElementById('new-project'));
    expect(await h.dispatchRuntimeMessage({
      type: 'clf-task-box-recovery:reconcile', protocol: PROTOCOL, requestId: requestOne, generation: 15
    })).toMatchObject({ ok: true, claimed: true, completed: true, reconciled: true });
    expect(createClicks).toBe(0);
    expect(h.storage.data[GLOBAL]).toEqual({ state: 'present', generation: 15 });
    closeContent(h);
  });

  it('prepares cleanup recovery without mutation, then claims once and recreates TASK BOX in the repair document', async () => {
    const oldOwner = { tabId: 88, documentId: 'old-document' };
    const h = await makeContent(
      `<nav id="sidebar"><button id="new-project" aria-label="New project">+</button></nav><div id="portal"></div>`,
      {
        [FEATURE]: true,
        [GLOBAL]: { state: 'reserved', generation: 15, mode: 'cleanup', requestId: requestOne, owner: oldOwner },
        [`taskBoxClearAttempt:${requestOne}`]: {
          state: 'completed', generation: 14, requestId: requestOne, kind: 'clear', owner: oldOwner
        }
      },
      async (route) => {
        if (route.startsWith('/task-box/clear/status?')) {
          return { ok: true, data: { ok: true, status: 'completed', requestId: requestOne, protocol: PROTOCOL } };
        }
        throw new Error(`unexpected ${route}`);
      }
    );
    h.document.getElementById('new-project')!.addEventListener('click', () => {
      const dialog = h.document.createElement('dialog');
      dialog.setAttribute('open', '');
      const input = h.document.createElement('input');
      input.type = 'text'; input.id = 'project-name'; input.name = 'projectName'; input.placeholder = 'コペンハーゲン旅行';
      const label = h.document.createElement('label');
      label.htmlFor = input.id; label.textContent = 'プロジェクト名';
      const save = h.document.createElement('button');
      save.type = 'submit'; save.textContent = 'プロジェクトを作成する'; save.disabled = true;
      input.addEventListener('input', () => { save.disabled = input.value !== 'TASK BOX'; });
      save.addEventListener('click', () => {
        const shell = h.document.createElement('div');
        shell.innerHTML = taskRow(input.value, 'task-repaired');
        h.document.getElementById('sidebar')!.insertBefore(shell.firstElementChild!, h.document.getElementById('new-project'));
        dialog.remove();
      });
      dialog.append(label, input, save);
      h.document.getElementById('portal')!.append(dialog);
    });

    const before = structuredClone(h.storage.data[GLOBAL]);
    expect(await h.dispatchRuntimeMessage({
      type: 'clf-task-box-recovery:prepare', protocol: PROTOCOL, requestId: requestOne, generation: 15
    })).toMatchObject({ ok: true, ready: true, existing: false });
    expect(h.storage.data[GLOBAL]).toEqual(before);
    expect(h.document.querySelector('[data-row="task-repaired"]')).toBeNull();

    expect(await h.dispatchRuntimeMessage({
      type: 'clf-task-box-recovery:execute', protocol: PROTOCOL, requestId: requestOne, generation: 15
    })).toMatchObject({ ok: true, claimed: true, completed: true, existing: false });
    expect(h.storage.data[GLOBAL]).toEqual({ state: 'present', generation: 15 });
    expect(h.storage.data[`taskBoxCleanupRecovery:${requestOne}`]).toMatchObject({
      state: 'completed', fromOwner: oldOwner, toOwner: { tabId: 17, documentId: 'document-17' }
    });
    expect(h.document.querySelector('[data-row="task-repaired"]')).not.toBeNull();
    closeContent(h);
  });

  it('recognizes native open dialogs and associated name labels without treating a placeholder or unrelated input as identity', async () => {
    const h = await makeContent('<dialog id="closed"><input type="text" aria-label="Project name"></dialog><dialog open id="create"><label for="real-name">プロジェクト名</label><input id="unrelated" placeholder="Project name"><input id="real-name" type="text" placeholder="コペンハーゲン旅行"></dialog>', { [FEATURE]: true });
    expect(h.hooks.openProjectDialogs().map((x: Element) => x.id)).toEqual(['create']);
    expect(h.hooks.findProjectNameInput(h.document.getElementById('create')).id).toBe('real-name');
    h.document.getElementById('real-name')!.remove();
    expect(h.hooks.findProjectNameInput(h.document.getElementById('create'))).toBeNull();
    closeContent(h);
  });

  it('finds a native delete-confirm dialog through the same open-dialog authority used for Project creation', async () => {
    vi.useFakeTimers();
    let h: Awaited<ReturnType<typeof makeContent>> | null = null;
    try {
      const ticket = { generation: 7, requestId: requestOne, kind: 'clear' };
      h = await makeContent(
        `<nav>${taskRow()}</nav><div id="portal"></div>`,
        { [FEATURE]: true, [GLOBAL]: {
          state: 'deleting', generation: 7, kind: 'clear', requestId: requestOne,
          owner: { tabId: 17, documentId: 'document-17' }, clearCompleted: true
        } }
      );
      const context = h.hooks.taskBoxSidebarContext();
      const menu = makeNativeProjectMenu(h.document);
      const remove = [...menu.querySelectorAll('button')]
        .find((button) => button.textContent === 'プロジェクトを削除する')!;
      remove.addEventListener('click', () => {
        menu.remove();
        const dialog = h!.document.createElement('dialog');
        dialog.setAttribute('open', '');
        const confirm = h!.document.createElement('button');
        confirm.textContent = 'Delete from Chat and Work';
        confirm.addEventListener('click', () => {
          h!.document.querySelector('[data-row="task-old"]')?.remove();
          dialog.remove();
        });
        dialog.append(confirm);
        h!.document.getElementById('portal')!.append(dialog);
      });
      h.document.getElementById('portal')!.append(menu);

      const deletion = h.hooks.deleteTaskBoxProjectFromContext(context, menu, ticket);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(4_000);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(9_000);
      await expect(deletion).resolves.toBeUndefined();
      expect(h.document.querySelector('[data-row="task-old"]')).toBeNull();
    } finally {
      if (h) closeContent(h);
      vi.useRealTimers();
    }
  });

  it('does not let pointer or DOM activity collapse the UI_BUSY retry backoff', async () => {
    let h: Awaited<ReturnType<typeof makeContent>> | null = null;
    try {
      h = await makeContent(
        `<main><div data-clf-bootstrap="worker"></div><div role="menu">busy</div></main>`,
        { [FEATURE]: true, [GLOBAL]: { state: 'present', generation: 0 } }
      );
      await new Promise(resolve => setTimeout(resolve, 350));
      const first = structuredClone(h.storage.data.lastMoveOperation);
      expect(first).toMatchObject({ stage: 'failed', lastError: 'UI_BUSY' });

      h.document.body.dispatchEvent(new h.window.Event('pointerover', { bubbles: true }));
      const mutation = h.document.createElement('span');
      h.document.body.append(mutation);
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(h.storage.data.lastMoveOperation.operationId).toBe(first.operationId);

      await new Promise(resolve => setTimeout(resolve, 650));
      expect(h.storage.data.lastMoveOperation.operationId).not.toBe(first.operationId);
      expect(h.storage.data.lastMoveOperation.lastError).toBe('UI_BUSY');
    } finally {
      if (h) closeContent(h);
    }
  });

  it('refuses ambiguous project-name inputs before writing either input', async () => {
    const h = await makeContent('<dialog open id="create"><input type="text" aria-label="Project name"><input type="text" aria-label="プロジェクト名"></dialog>', { [FEATURE]: true });
    expect(() => h.hooks.findProjectNameInput(h.document.getElementById('create'))).toThrow('PROJECT_NAME_INPUT_AMBIGUOUS');
    expect([...h.document.querySelectorAll('input')].every(x => x.value === '')).toBe(true);
    closeContent(h);
  });

  it('replaces an older adapter once without an extension reload and retains the healthy current adapter', async () => {
    const h = await makeContent('<nav></nav>', { [FEATURE]: true });
    const old = h.window.__CLF_TASK_BOX_RUNTIME__;
    old.adapterRevision = 2;
    let stops = 0;
    const stop = old.stop;
    old.stop = () => { stops++; stop(); };
    h.window.eval(contentSource);
    await h.window.CLFTaskBox.start();
    const current = h.window.__CLF_TASK_BOX_RUNTIME__;
    expect(current).not.toBe(old);
    expect(current.adapterRevision).toBe(4);
    expect(stops).toBe(1);
    h.window.eval(contentSource);
    await h.window.CLFTaskBox.start();
    expect(h.window.__CLF_TASK_BOX_RUNTIME__).toBe(current);
    expect(stops).toBe(1);
    closeContent(h);
  });

  it.each(['aria', 'native', 'mounted-native'])('requires a trusted user click and recycles the whole Project, including an ordinary manually-filed chat (%s create dialog)', async (dialogKind) => {
    const bridgeCalls: string[] = [];
    const h = await makeContent(
      `<nav id="sidebar">${taskRow()}<button id="new-project" aria-label="New project" data-cos-test-hidden="true">+</button></nav>
       <div id="portal"></div>`,
      { [FEATURE]: true, [GLOBAL]: { state: 'present', generation: 0 } },
      async (route, init) => {
        bridgeCalls.push(route);
        if (route === '/task-box/clear') {
          const body = JSON.parse(init.body);
          expect(body.owner).toEqual({ tabId: 17, documentId: 'document-17' });
          return { ok: true, data: { ok: true, status: 'completed', requestId: body.requestId, protocol: PROTOCOL } };
        }
        throw new Error(`unexpected ${route}`);
      }
    );
    expect(h.started).toMatchObject({ ok: true, enabled: true });
    h.hooks.ensureSidebarBoxClearButton();
    const oldRow = h.document.querySelector('[data-row="task-old"]') as HTMLElement;
    const ordinary = h.document.createElement('div');
    ordinary.id = 'ordinary-chat';
    ordinary.textContent = 'ordinary manually-filed chat';
    oldRow.append(ordinary);
    const context = h.hooks.taskBoxSidebarContext();
    const boxClear = oldRow.querySelector('[data-cos-box-clear-sidebar]') as HTMLButtonElement;

    // Synthetic page code cannot invoke the destructive bridge action.
    boxClear.click();
    await Promise.resolve();
    expect(bridgeCalls).toHaveLength(0);

    const menu = makeNativeProjectMenu(h.document);
    const remove = [...menu.querySelectorAll('button')].find((button) => button.textContent === 'プロジェクトを削除する')!;
    remove.addEventListener('click', () => {
      menu.remove();
      const dialog = h.document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      const confirm = h.document.createElement('button');
      confirm.textContent = 'Delete from Chat and Work';
      confirm.addEventListener('click', () => {
        oldRow.remove();
        dialog.remove();
      });
      dialog.append(confirm);
      h.document.getElementById('portal')!.append(dialog);
    });
    h.document.getElementById('portal')!.append(menu);

    const mountedCreate = h.document.createElement('dialog');
    if (dialogKind === 'mounted-native') h.document.getElementById('portal')!.append(mountedCreate);
    h.document.getElementById('new-project')!.addEventListener('click', () => {
      const dialog = dialogKind === 'mounted-native' ? mountedCreate : h.document.createElement(dialogKind === 'aria' ? 'div' : 'dialog');
      if (dialogKind === 'aria') dialog.setAttribute('role', 'dialog');
      else dialog.setAttribute('open', '');
      const input = h.document.createElement('input');
      input.type = 'text'; input.id = 'project-name'; input.name = 'projectName';
      input.placeholder = 'コペンハーゲン旅行';
      const label = h.document.createElement('label');
      label.htmlFor = input.id; label.textContent = 'プロジェクト名';
      const save = h.document.createElement('button');
      save.type = 'submit'; save.textContent = 'プロジェクトを作成する'; save.disabled = true;
      input.addEventListener('input', () => { save.disabled = input.value !== 'TASK BOX'; });
      save.addEventListener('click', () => {
        const shell = h.document.createElement('div');
        shell.innerHTML = taskRow(input.value, 'task-new');
        h.document.getElementById('sidebar')!.insertBefore(shell.firstElementChild!, h.document.getElementById('new-project'));
        dialog.remove();
      });
      dialog.append(label, input, save);
      h.document.getElementById('portal')!.append(dialog);
    });

    await h.hooks.clearTaskBoxFromContext(boxClear, context, menu, { testBypass: true });
    expect(bridgeCalls).toEqual(['/task-box/clear']);
    expect(h.document.getElementById('ordinary-chat')).toBeNull();
    expect(h.document.querySelector('[data-row="task-old"]')).toBeNull();
    expect(h.document.querySelector('[data-row="task-new"]')).not.toBeNull();
    expect(h.storage.data[GLOBAL]).toEqual({ state: 'present', generation: 1 });
    expect(h.storage.data.lastBoxClearOperation).toMatchObject({ stage: 'completed', recreateCompleted: true });
    expect(JSON.stringify(h.storage.data)).not.toContain('task-old');
    expect(JSON.stringify(h.storage.data)).not.toContain('task-new');
    closeContent(h);
  });

  it('feature OFF after Clear completion but before native Confirm prevents Project deletion even when onChanged is delayed', async () => {
    let deleteConfirm = 0;
    const h = await makeContent(
      `<nav id="sidebar">${taskRow()}<button id="new-project" aria-label="New project" data-cos-test-hidden="true">+</button></nav>
       <div id="portal"></div>`,
      { [FEATURE]: true, [GLOBAL]: { state: 'present', generation: 0 } },
      async (route, init) => {
        if (route === '/task-box/clear') {
          const body = JSON.parse(init.body);
          return { ok: true, data: { ok: true, status: 'completed', requestId: body.requestId, protocol: PROTOCOL } };
        }
        throw new Error(`unexpected ${route}`);
      }
    );
    h.hooks.ensureSidebarBoxClearButton();
    const oldRow = h.document.querySelector('[data-row="task-old"]') as HTMLElement;
    const context = h.hooks.taskBoxSidebarContext();
    const boxClear = oldRow.querySelector('[data-cos-box-clear-sidebar]') as HTMLButtonElement;
    const menu = makeNativeProjectMenu(h.document);
    const remove = [...menu.querySelectorAll('button')].find((button) => button.textContent === 'プロジェクトを削除する')!;

    h.storage.holdChanges();
    remove.addEventListener('click', () => {
      // The content script has not received storage.onChanged yet, but the background's
      // authorization read must observe the durable feature revocation.
      void h.storage.local.set({ [FEATURE]: false });
      menu.remove();
      const dialog = h.document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      const confirm = h.document.createElement('button');
      confirm.textContent = 'Delete from Chat and Work';
      confirm.addEventListener('click', () => {
        deleteConfirm += 1;
        oldRow.remove();
        dialog.remove();
      });
      dialog.append(confirm);
      h.document.getElementById('portal')!.append(dialog);
    });
    h.document.getElementById('portal')!.append(menu);

    await h.hooks.clearTaskBoxFromContext(boxClear, context, menu, { testBypass: true });
    expect(deleteConfirm).toBe(0);
    expect(oldRow.isConnected).toBe(true);
    expect(h.storage.data[FEATURE]).toBe(false);
    expect(h.storage.data.lastBoxClearOperation).toMatchObject({
      stage: 'failed', failedStage: 'project-delete-started', clearCompleted: true
    });
    h.storage.flushChanges();
    closeContent(h);
  });

  it('retires stale runtime controls and an old finally cannot re-enable them', async () => {
    const h = await makeContent(`<nav>${taskRow()}</nav>`, { [FEATURE]: true, [GLOBAL]: { state: 'present', generation: 0 } });
    h.hooks.ensureSidebarBoxClearButton();
    const context = h.hooks.taskBoxSidebarContext();
    const button = h.document.querySelector('[data-cos-box-clear-sidebar]') as HTMLButtonElement;
    let sends = 0;
    h.runtime.sendMessage = () => {
      sends += 1;
      return Promise.reject(new Error('Extension context invalidated.'));
    };
    await h.hooks.clearTaskBoxFromContext(button, context, null, { testBypass: true });
    expect(sends).toBe(1);
    expect(button.disabled).toBe(true);
    expect(button.dataset.cosClearState).toBe('context-invalidated');
    h.runtime.sendMessage = async () => ({ protocol: PROTOCOL, ok: true });
    await h.hooks.clearTaskBoxFromContext(button, context, null, { testBypass: true });
    expect(button.disabled).toBe(true);
    expect(sends).toBe(1);
    closeContent(h);
  });
});
