import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const DRIVER = path.join(process.cwd(), 'patcher/browser-control/extension/browser-control-driver.js');
const CONVERSATION_A = '12345678-abcd-4abc-8abc-123456789abc';
const CONVERSATION_B = 'abcdef12-3456-4abc-8abc-abcdef123456';

type DriverHarness = Awaited<ReturnType<typeof harness>>;

async function harness() {
  const source = await fs.readFile(DRIVER, 'utf8');
  let executor: ((action: any, command?: any) => Promise<any>) | null = null;
  let permissions = true;
  let nextTabId = 20;
  let nextGroupId = 4;
  const tabs = new Map<number, any>();
  const groups = new Map<number, number>();
  const attached = new Set<number>();
  const calls: Array<{ tabId: number; method: string; params?: any }> = [];
  const onEvent: Array<(source: any, method: string, params: any) => void> = [];
  const onDetach: Array<(source: any) => void> = [];
  const onRemoved: Array<(tabId: number) => void> = [];
  const onUpdated: Array<(tabId: number, changeInfo: any, tab: any) => void> = [];
  const permissionRemoved: Array<(removed?: any) => void> = [];
  let concurrentInsertText = 0;
  let maxConcurrentInsertText = 0;
  let releaseInsertText: (() => void) | null = null;
  let insertTextGate: Promise<void> | null = null;
  let debuggerAttachGate: Promise<void> | null = null;
  let releaseDebuggerAttach: (() => void) | null = null;
  let debuggerAttachEnteredResolve: (() => void) | null = null;
  let debuggerAttachEntered: Promise<void> = Promise.resolve();
  let mouseDispatchGate: Promise<void> | null = null;
  let releaseMouseDispatch: (() => void) | null = null;
  let mouseDispatchEnteredResolve: (() => void) | null = null;
  let mouseDispatchEntered: Promise<void> = Promise.resolve();
  let permissionGate: Promise<void> | null = null;
  let releasePermission: (() => void) | null = null;
  let permissionEnteredResolve: (() => void) | null = null;
  let permissionEntered: Promise<void> = Promise.resolve();
  let tabGetGate: Promise<void> | null = null;
  let releaseTabGet: (() => void) | null = null;
  let tabGetEnteredResolve: (() => void) | null = null;
  let tabGetEntered: Promise<void> = Promise.resolve();
  let collectGate: Promise<void> | null = null;
  let releaseCollect: (() => void) | null = null;
  let collectEnteredResolve: (() => void) | null = null;
  let collectEntered: Promise<void> = Promise.resolve();
  let resolveGate: Promise<void> | null = null;
  let releaseResolve: (() => void) | null = null;
  let resolveEnteredResolve: (() => void) | null = null;
  let resolveEntered: Promise<void> = Promise.resolve();

  function tabFor(id: number) {
    return tabs.get(id) || null;
  }

  const chrome: any = {
    runtime: { lastError: null },
    permissions: {
      contains: vi.fn(async () => {
        if (permissionGate) {
          permissionEnteredResolve?.();
          await permissionGate;
        }
        return permissions;
      }),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: (fn: any) => permissionRemoved.push(fn) }
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (tabGetGate) {
          tabGetEnteredResolve?.();
          await tabGetGate;
        }
        const tab = tabFor(tabId);
        if (!tab) throw new Error('No tab');
        return { ...tab };
      }),
      query: vi.fn(async (query: any) => {
        if (query?.groupId === undefined) return [...tabs.values()].map(tab => ({ ...tab }));
        return [...tabs.values()].filter(tab => tab.groupId === query.groupId).map(tab => ({ ...tab }));
      }),
      group: vi.fn(async ({ tabIds }: any) => {
        const groupId = nextGroupId++;
        for (const tabId of tabIds || []) {
          const tab = tabFor(tabId);
          if (tab) tab.groupId = groupId;
          groups.set(tabId, groupId);
        }
        return groupId;
      }),
      ungroup: vi.fn(async (value: number | number[]) => {
        for (const tabId of Array.isArray(value) ? value : [value]) {
          const tab = tabFor(tabId);
          if (tab) delete tab.groupId;
          groups.delete(tabId);
        }
      }),
      create: vi.fn(async ({ url, active }: any) => {
        const id = nextTabId++;
        const tab = { id, url, title: `Agent ${id}`, lastAccessed: id, windowId: 1, active, groupId: -1 };
        tabs.set(id, tab);
        return { ...tab };
      }),
      remove: vi.fn(async (tabId: number) => {
        tabs.delete(tabId);
        groups.delete(tabId);
      }),
      onRemoved: { addListener: (fn: any) => onRemoved.push(fn) },
      onUpdated: { addListener: (fn: any) => onUpdated.push(fn) }
    },
    tabGroups: {
      update: vi.fn(async (groupId: number) => ({ id: groupId })),
      query: vi.fn(async () => [])
    },
    debugger: {
      attach: vi.fn(async ({ tabId }: any) => {
        debuggerAttachEnteredResolve?.();
        if (debuggerAttachGate) await debuggerAttachGate;
        attached.add(tabId);
      }),
      detach: vi.fn(async ({ tabId }: any) => { attached.delete(tabId); }),
      onEvent: { addListener: (fn: any) => onEvent.push(fn) },
      onDetach: { addListener: (fn: any) => onDetach.push(fn) },
      sendCommand: vi.fn(async ({ tabId }: any, method: string, params: any) => {
        calls.push({ tabId, method, params });
        const tab = tabFor(tabId);
        if (method === 'Input.dispatchMouseEvent' && mouseDispatchGate) {
          mouseDispatchEnteredResolve?.();
          await mouseDispatchGate;
        }
        if (method === 'Page.getFrameTree') {
          return { frameTree: { frame: { id: `root-${tabId}`, url: tab?.url || '' }, childFrames: [] } };
        }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: tabId * 10 };
        if (method === 'Page.getLayoutMetrics') {
          return {
            cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 },
            visualViewport: { clientWidth: 800, clientHeight: 600 },
            cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 }
          };
        }
        if (method === 'Page.captureScreenshot') return { data: 'aGVsbG8=' };
        if (method === 'Page.navigate') {
          if (tab) tab.url = String(params?.url || tab.url);
          return { frameId: `root-${tabId}` };
        }
        if (method === 'Runtime.evaluate') {
          const expression = String(params?.expression || '');
          const name = `Go ${tabId}`;
          const signature = `button||button|${name}`;
          if (expression.includes('const selector=')) {
            if (collectGate) {
              collectEnteredResolve?.();
              await collectGate;
            }
            const elements = [{ path: '#go', tag: 'button', type: '', role: 'button', name, value: '', disabled: false, checked: '', x: 100, y: 80, width: 60, height: 30, signature }];
            if (tabId % 2 === 0) elements.push({ path: '#extra', tag: 'button', type: '', role: 'button', name: `Extra ${tabId}`, value: '', disabled: false, checked: '', x: 200, y: 80, width: 60, height: 30, signature: `button||button|Extra ${tabId}` });
            return { result: { value: { url: tab?.url || '', title: tab?.title || '', scrollY: 0, scrollHeight: 1200, elements } } };
          }
          if (expression.includes('const p=')) {
            if (resolveGate) {
              resolveEnteredResolve?.();
              await resolveGate;
            }
            const extra = expression.includes('#extra');
            return { result: { value: { signature: extra ? `button||button|Extra ${tabId}` : signature, x: extra ? 200 : 100, y: 80, disabled: false, covered: false } } };
          }
          if (expression.includes('({x:scrollX,y:scrollY})')) return { result: { value: { x: 0, y: 0 } } };
          return { result: { value: null } };
        }
        if (method === 'Input.insertText' && insertTextGate) {
          concurrentInsertText += 1;
          maxConcurrentInsertText = Math.max(maxConcurrentInsertText, concurrentInsertText);
          if (concurrentInsertText === 2) releaseInsertText?.();
          await insertTextGate;
          concurrentInsertText -= 1;
        }
        return {};
      })
    }
  };

  const transport = {
    registerExecutor(fn: any) { executor = fn; return () => { executor = null; return true; }; }
  };
  const box: any = {
    console, chrome, structuredClone, URL, Promise, Map, Set, Error, TypeError, String, Number, JSON,
    Math, Object, Array, RegExp, Date, setTimeout, clearTimeout,
    navigator: { userAgent: 'Macintosh' }, CLFBrowserControlTransport: transport
  };
  vm.createContext(box);
  vm.runInContext(source, box);
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  const run = executor as ((action: any, command?: any) => Promise<any>) | null;
  if (!run) throw new Error('executor not registered');

  return {
    chrome,
    driver: box.CLFBrowserControlDriver,
    run,
    tabs,
    attached,
    calls,
    onEvent,
    onDetach,
    onRemoved,
    onUpdated,
    permissionRemoved,
    setPermissions(value: boolean) { permissions = value; },
    armInsertTextBarrier() {
      insertTextGate = new Promise<void>(resolve => { releaseInsertText = resolve; });
    },
    armDebuggerAttachBarrier() {
      debuggerAttachEntered = new Promise<void>(resolve => { debuggerAttachEnteredResolve = resolve; });
      debuggerAttachGate = new Promise<void>(resolve => { releaseDebuggerAttach = resolve; });
      return debuggerAttachEntered;
    },
    releaseDebuggerAttach() {
      const release = releaseDebuggerAttach;
      releaseDebuggerAttach = null;
      debuggerAttachGate = null;
      release?.();
    },
    armMouseDispatchBarrier() {
      mouseDispatchEntered = new Promise<void>(resolve => { mouseDispatchEnteredResolve = resolve; });
      mouseDispatchGate = new Promise<void>(resolve => { releaseMouseDispatch = resolve; });
      return mouseDispatchEntered;
    },
    releaseMouseDispatch() {
      const release = releaseMouseDispatch;
      releaseMouseDispatch = null;
      mouseDispatchGate = null;
      release?.();
    },
    armPermissionBarrier() {
      permissionEntered = new Promise<void>(resolve => { permissionEnteredResolve = resolve; });
      permissionGate = new Promise<void>(resolve => { releasePermission = resolve; });
      return permissionEntered;
    },
    releasePermission() {
      const release = releasePermission;
      releasePermission = null;
      permissionGate = null;
      release?.();
    },
    armTabGetBarrier() {
      tabGetEntered = new Promise<void>(resolve => { tabGetEnteredResolve = resolve; });
      tabGetGate = new Promise<void>(resolve => { releaseTabGet = resolve; });
      return tabGetEntered;
    },
    releaseTabGet() {
      const release = releaseTabGet;
      releaseTabGet = null;
      tabGetGate = null;
      release?.();
    },
    armCollectBarrier() {
      collectEntered = new Promise<void>(resolve => { collectEnteredResolve = resolve; });
      collectGate = new Promise<void>(resolve => { releaseCollect = resolve; });
      return collectEntered;
    },
    releaseCollect() {
      const release = releaseCollect;
      releaseCollect = null;
      collectGate = null;
      release?.();
    },
    armResolveBarrier() {
      resolveEntered = new Promise<void>(resolve => { resolveEnteredResolve = resolve; });
      resolveGate = new Promise<void>(resolve => { releaseResolve = resolve; });
      return resolveEntered;
    },
    releaseResolve() {
      const release = releaseResolve;
      releaseResolve = null;
      resolveGate = null;
      release?.();
    },
    maxConcurrentInsertText() { return maxConcurrentInsertText; }
  };
}

let commandSequence = 0;
const command = (conversationId: string, controllerTabId: number) => {
  commandSequence += 1;
  return {
    id: `bc-00000000-0000-4000-8000-${commandSequence.toString(16).padStart(12, '0')}`,
    conversationId,
    controllerTabId
  };
};

async function navigate(h: DriverHarness, conversationId: string, controllerTabId: number, url: string) {
  const result = await h.run({ type: 'navigate', url }, command(conversationId, controllerTabId));
  expect(result).toMatchObject({ ok: true, data: { created: true } });
  return result.data.tabId as number;
}

describe('browser-control multi-session driver', () => {
  it('creates independent Agent tabs and permits commands from different conversations to overlap', async () => {
    const h = await harness();
    const tabA = await navigate(h, CONVERSATION_A, 90, 'https://a.example/');
    const tabB = await navigate(h, CONVERSATION_B, 91, 'https://b.example/');
    expect(tabB).not.toBe(tabA);
    expect(h.attached).toEqual(new Set([tabA, tabB]));

    const [observedA, observedB] = await Promise.all([
      h.run({ type: 'observe' }, command(CONVERSATION_A, 90)),
      h.run({ type: 'observe' }, command(CONVERSATION_B, 91))
    ]);
    expect(observedA.data.tabId).toBe(tabA);
    expect(observedB.data.tabId).toBe(tabB);
    const refA0 = observedA.data.elements[0].ref as string;
    const refB0 = observedB.data.elements[0].ref as string;
    expect(refA0).toMatch(/_g1_e0$/);
    expect(refB0).toMatch(/_g1_e0$/);
    expect(refA0).not.toBe(refB0);

    const refA1 = observedA.data.elements[1].ref as string;
    expect(refA1).toMatch(/_g1_e1$/);
    await expect(h.run({ type: 'move_ref', ref: refA1 }, command(CONVERSATION_B, 91)))
      .resolves.toMatchObject({ ok: false, error: 'BROWSER_STALE_REF' });

    await h.run({ type: 'move_ref', ref: refA0 }, command(CONVERSATION_A, 90));
    await h.run({ type: 'scroll', x: 321, y: 222, scroll_y: 0 }, command(CONVERSATION_B, 91));
    await expect(h.run({ type: 'status' }, command(CONVERSATION_A, 90))).resolves.toMatchObject({
      ok: true,
      data: { pointer: { x: 100, y: 80, visible: true } }
    });
    await expect(h.run({ type: 'status' }, command(CONVERSATION_B, 91))).resolves.toMatchObject({
      ok: true,
      data: { pointer: { x: 321, y: 222, visible: true } }
    });

    h.armInsertTextBarrier();
    await Promise.all([
      h.run({ type: 'type', text: 'A' }, command(CONVERSATION_A, 90)),
      h.run({ type: 'type', text: 'B' }, command(CONVERSATION_B, 91))
    ]);
    expect(h.maxConcurrentInsertText()).toBe(2);
    const insertTargets = h.calls.filter(call => call.method === 'Input.insertText').map(call => call.tabId);
    expect(insertTargets).toEqual(expect.arrayContaining([tabA, tabB]));
  });

  it('keeps the controller-tab fence within the owning conversation', async () => {
    const h = await harness();
    const tabA = await navigate(h, CONVERSATION_A, 90, 'https://a.example/');
    await expect(h.run({ type: 'status' }, { controllerTabId: 90 })).resolves.toMatchObject({
      ok: false,
      error: 'BROWSER_CONVERSATION_REQUIRED'
    });
    await expect(h.run({ type: 'observe' }, command(CONVERSATION_A, 99))).resolves.toMatchObject({
      ok: false,
      error: 'BROWSER_CONTROLLER_CHANGED'
    });
    expect(h.attached.has(tabA)).toBe(true);
  });

  it('scopes detach, navigation epochs, debugger detach, and tab removal to the owning session', async () => {
    const h = await harness();
    const tabA = await navigate(h, CONVERSATION_A, 90, 'https://a.example/');
    const tabB = await navigate(h, CONVERSATION_B, 91, 'https://b.example/');
    const observedA = await h.run({ type: 'observe' }, command(CONVERSATION_A, 90));
    const observedB = await h.run({ type: 'observe' }, command(CONVERSATION_B, 91));

    h.onEvent[0]!({ tabId: tabA }, 'Page.frameNavigated', { frame: { id: `root-${tabA}`, url: 'https://a.example/next' } });
    await Promise.resolve();
    await expect(h.run({ type: 'move_ref', ref: observedA.data.elements[0].ref }, command(CONVERSATION_A, 90)))
      .resolves.toMatchObject({ ok: false, error: 'BROWSER_STALE_REF' });
    const observedAAfterNavigation = await h.run({ type: 'observe' }, command(CONVERSATION_A, 90));
    expect(observedAAfterNavigation.data.elements[0].ref).not.toBe(observedA.data.elements[0].ref);
    await expect(h.run({ type: 'move_ref', ref: observedA.data.elements[0].ref }, command(CONVERSATION_A, 90)))
      .resolves.toMatchObject({ ok: false, error: 'BROWSER_STALE_REF' });
    await expect(h.run({ type: 'move_ref', ref: observedB.data.elements[0].ref }, command(CONVERSATION_B, 91)))
      .resolves.toMatchObject({ ok: true });

    const detachedA = await h.run({ type: 'detach' }, command(CONVERSATION_A, 90));
    expect(detachedA).toMatchObject({ ok: true, data: { released: { tabId: tabA } } });
    expect(h.attached.has(tabA)).toBe(false);
    expect(h.attached.has(tabB)).toBe(true);
    await expect(h.run({ type: 'status' }, command(CONVERSATION_B, 91)))
      .resolves.toMatchObject({ ok: true, data: { attached: true, tabId: tabB } });

    h.onDetach[0]!({ tabId: tabB });
    await expect(h.run({ type: 'status' }, command(CONVERSATION_B, 91)))
      .resolves.toMatchObject({ ok: true, data: { attached: false } });

    const tabA2 = await navigate(h, CONVERSATION_A, 90, 'https://a.example/reopen');
    const tabB2 = await navigate(h, CONVERSATION_B, 91, 'https://b.example/reopen');
    h.onRemoved[0]!(tabA2);
    await expect(h.run({ type: 'status' }, command(CONVERSATION_A, 90)))
      .resolves.toMatchObject({ ok: true, data: { attached: false } });
    await expect(h.run({ type: 'status' }, command(CONVERSATION_B, 91)))
      .resolves.toMatchObject({ ok: true, data: { attached: true, tabId: tabB2 } });
  });

  it('never re-mints a stale ref when the same conversation detaches and creates a replacement session', async () => {
    const h = await harness();
    const tabA1 = await navigate(h, CONVERSATION_A, 90, 'https://a.example/one');
    const first = await h.run({ type: 'observe' }, command(CONVERSATION_A, 90));
    const oldRef = first.data.elements[0].ref as string;

    await expect(h.run({ type: 'detach' }, command(CONVERSATION_A, 90)))
      .resolves.toMatchObject({ ok: true, data: { released: { tabId: tabA1 } } });
    const tabA2 = await navigate(h, CONVERSATION_A, 90, 'https://a.example/two');
    expect(tabA2).not.toBe(tabA1);
    const second = await h.run({ type: 'observe' }, command(CONVERSATION_A, 90));
    const newRef = second.data.elements[0].ref as string;
    expect(newRef).not.toBe(oldRef);

    await expect(h.run({ type: 'move_ref', ref: oldRef }, command(CONVERSATION_A, 90)))
      .resolves.toMatchObject({ ok: false, error: 'BROWSER_STALE_REF' });
    await expect(h.run({ type: 'move_ref', ref: newRef }, command(CONVERSATION_A, 90)))
      .resolves.toMatchObject({ ok: true });
  });

  it('hard-detaches only the session whose main frame reaches a refused surface', async () => {
    const h = await harness();
    const tabA = await navigate(h, CONVERSATION_A, 90, 'https://a.example/');
    const tabB = await navigate(h, CONVERSATION_B, 91, 'https://b.example/');
    const before = h.calls.length;
    h.onEvent[0]!({ tabId: tabA }, 'Page.frameNavigated', { frame: { id: `root-${tabA}`, url: 'https://chatgpt.com/c/refused' } });
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(h.calls.slice(before).filter(call => call.tabId === tabA)).toHaveLength(0);
    await expect(h.run({ type: 'status' }, command(CONVERSATION_A, 90)))
      .resolves.toMatchObject({ ok: true, data: { attached: false } });
    await expect(h.run({ type: 'status' }, command(CONVERSATION_B, 91)))
      .resolves.toMatchObject({ ok: true, data: { attached: true, tabId: tabB } });
  });

  it('detaches all sessions when Browser authority is revoked', async () => {
    const h = await harness();
    await navigate(h, CONVERSATION_A, 90, 'https://a.example/');
    await navigate(h, CONVERSATION_B, 91, 'https://b.example/');
    h.setPermissions(false);
    await h.driver.syncExecutor();
    expect(h.attached.size).toBe(0);
    expect(await h.driver.status()).toMatchObject({ granted: false, attached: false, sessionCount: 0 });
  });

  it('invalidates a first-session create that is still in flight across global detach', async () => {
    const h = await harness();
    const entered = h.armDebuggerAttachBarrier();
    const pending = h.run(
      { type: 'navigate', url: 'https://a.example/' },
      command(CONVERSATION_A, 90)
    );
    await entered;

    // Popup/global detach must invalidate pending creates, not only snapshot established sessions.
    await h.driver.detach();
    h.releaseDebuggerAttach();

    await expect(pending).resolves.toMatchObject({ ok: false, error: 'BROWSER_AUTHORITY_CHANGED' });
    expect(h.attached.size).toBe(0);
    expect(h.chrome.tabs.remove).toHaveBeenCalledTimes(1);
    expect(await h.driver.status()).toMatchObject({ attached: false, sessionCount: 0 });
  });

  it('rechecks authority generation after the final permission await before publishing a session', async () => {
    const h = await harness();
    const attachEntered = h.armDebuggerAttachBarrier();
    const pending = h.run(
      { type: 'navigate', url: 'https://a.example/' },
      command(CONVERSATION_A, 90)
    );
    await attachEntered;

    // Let debugger.attach complete, then stop inside the final permissionsGranted() re-proof.
    // The global detach occurs while that permission await is pending: generation must be compared
    // again after the await, not only as the left operand of a pre-await boolean expression.
    const permissionEntered = h.armPermissionBarrier();
    h.releaseDebuggerAttach();
    await permissionEntered;
    await h.driver.detach();
    h.releasePermission();

    await expect(pending).resolves.toMatchObject({ ok: false, error: 'BROWSER_AUTHORITY_CHANGED' });
    expect(h.attached.size).toBe(0);
    expect(h.chrome.tabs.remove).toHaveBeenCalledTimes(1);
    expect(await h.driver.status()).toMatchObject({ attached: false, sessionCount: 0 });
  });

  it('invalidates a first-session create that is still in flight when Browser permission is revoked', async () => {
    const h = await harness();
    const entered = h.armDebuggerAttachBarrier();
    const pending = h.run(
      { type: 'navigate', url: 'https://a.example/' },
      command(CONVERSATION_A, 90)
    );
    await entered;

    h.setPermissions(false);
    await h.driver.syncExecutor();
    h.releaseDebuggerAttach();

    await expect(pending).resolves.toMatchObject({ ok: false, error: 'BROWSER_AUTHORITY_CHANGED' });
    expect(h.attached.size).toBe(0);
    expect(h.chrome.tabs.remove).toHaveBeenCalledTimes(1);
    expect(await h.driver.status()).toMatchObject({ granted: false, attached: false, sessionCount: 0 });
  });

  it('closes established authority synchronously when a Browser optional permission is removed', async () => {
    const h = await harness();
    const tabA = await navigate(h, CONVERSATION_A, 90, 'https://a.example/');
    const observed = await h.run({ type: 'observe' }, command(CONVERSATION_A, 90));
    const entered = h.armMouseDispatchBarrier();
    const pending = h.run(
      { type: 'click_ref', ref: observed.data.elements[0].ref },
      command(CONVERSATION_A, 90)
    );
    await entered;

    h.setPermissions(false);
    h.permissionRemoved[0]!({ permissions: ['tabs'] });
    // No permission probe/await is allowed in front of this refusal boundary.
    await expect(h.run(
      { type: 'navigate', url: 'https://b.example/' },
      command(CONVERSATION_B, 91)
    )).resolves.toMatchObject({ ok: false, error: 'BROWSER_CONTROL_DISABLED' });
    h.releaseMouseDispatch();
    await expect(pending).resolves.toMatchObject({ ok: false });
    await Promise.resolve();

    const mouseTypes = h.calls
      .filter(call => call.tabId === tabA && call.method === 'Input.dispatchMouseEvent')
      .map(call => call.params?.type);
    expect(mouseTypes).toEqual(['mouseMoved']);
    expect(await h.driver.status()).toMatchObject({ granted: false, attached: false, sessionCount: 0 });
  });

  it('retires established authority before awaiting global detach cleanup', async () => {
    const h = await harness();
    const tabA = await navigate(h, CONVERSATION_A, 90, 'https://a.example/');
    const observed = await h.run({ type: 'observe' }, command(CONVERSATION_A, 90));
    const entered = h.armMouseDispatchBarrier();
    const pending = h.run(
      { type: 'click_ref', ref: observed.data.elements[0].ref },
      command(CONVERSATION_A, 90)
    );
    await entered;

    const globalDetach = h.driver.detach();
    h.releaseMouseDispatch();
    await globalDetach;
    await expect(pending).resolves.toMatchObject({ ok: false });

    const mouseTypes = h.calls
      .filter(call => call.tabId === tabA && call.method === 'Input.dispatchMouseEvent')
      .map(call => call.params?.type);
    expect(mouseTypes).toEqual(['mouseMoved']);
    expect(h.attached.has(tabA)).toBe(false);
    expect(await h.driver.status()).toMatchObject({ attached: false, sessionCount: 0 });
  });

  it('keeps new-session admission closed from global detach through permission removal/re-enable', async () => {
    const h = await harness();
    await navigate(h, CONVERSATION_A, 90, 'https://a.example/');

    const globalDetach = h.driver.detach();
    await expect(h.run(
      { type: 'navigate', url: 'https://b.example/' },
      command(CONVERSATION_B, 91)
    )).resolves.toMatchObject({ ok: false, error: 'BROWSER_CONTROL_DISABLED' });
    await globalDetach;

    // Permissions are intentionally still true here, matching the popup gap between detach reply
    // and chrome.permissions.remove(). Admission must remain closed even after cleanup has finished.
    await expect(h.run(
      { type: 'navigate', url: 'https://b.example/' },
      command(CONVERSATION_B, 91)
    )).resolves.toMatchObject({ ok: false, error: 'BROWSER_CONTROL_DISABLED' });
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(await h.driver.status()).toMatchObject({ granted: false, attached: false, sessionCount: 0 });

    // A later permission/startup sync is the only path that reopens admission.
    await h.driver.syncExecutor();
    const tabB = await navigate(h, CONVERSATION_B, 91, 'https://b.example/');
    expect(tabB).toBeGreaterThan(0);
  });

  it('does not let a stale successful permission sync reopen admission after global detach', async () => {
    const h = await harness();
    const permissionEntered = h.armPermissionBarrier();
    const staleSync = h.driver.syncExecutor();
    await permissionEntered;

    await h.driver.detach();
    h.releasePermission();
    await expect(staleSync).resolves.toBe(false);

    await expect(h.run(
      { type: 'navigate', url: 'https://b.example/' },
      command(CONVERSATION_B, 91)
    )).resolves.toMatchObject({ ok: false, error: 'BROWSER_CONTROL_DISABLED' });
    expect(await h.driver.status()).toMatchObject({ granted: false, attached: false, sessionCount: 0 });
  });

  it('refuses an attach-time redirect before issuing any page CDP command', async () => {
    const h = await harness();
    const attachEntered = h.armDebuggerAttachBarrier();
    const pending = h.run(
      { type: 'navigate', url: 'https://a.example/' },
      command(CONVERSATION_A, 90)
    );
    await attachEntered;

    const permissionEntered = h.armPermissionBarrier();
    h.releaseDebuggerAttach();
    await permissionEntered;
    const tab = h.tabs.get(20)!;
    tab.url = 'https://chatgpt.com/c/refused';
    h.releasePermission();

    await expect(pending).resolves.toMatchObject({ ok: false, error: 'BROWSER_TARGET_REFUSED' });
    expect(h.calls.filter(call => call.tabId === 20)).toHaveLength(0);
    expect(h.attached.has(20)).toBe(false);
    expect(h.chrome.tabs.remove).toHaveBeenCalledWith(20);
  });

  it('does not publish a phantom session when debugger detach lands before session publication', async () => {
    const h = await harness();
    const attachEntered = h.armDebuggerAttachBarrier();
    const pending = h.run(
      { type: 'navigate', url: 'https://a.example/' },
      command(CONVERSATION_A, 90)
    );
    await attachEntered;

    const permissionEntered = h.armPermissionBarrier();
    h.releaseDebuggerAttach();
    await permissionEntered;
    h.onDetach[0]!({ tabId: 20 });
    h.releasePermission();

    await expect(pending).resolves.toMatchObject({ ok: false, error: 'BROWSER_AUTHORITY_CHANGED' });
    expect(await h.driver.status()).toMatchObject({ attached: false, sessionCount: 0 });
    expect(h.chrome.tabs.remove).toHaveBeenCalledWith(20);
  });

  it('does not commit an observation collected across a main-frame navigation', async () => {
    const h = await harness();
    const tabA = await navigate(h, CONVERSATION_A, 90, 'https://a.example/');
    const collectEntered = h.armCollectBarrier();
    const pending = h.run({ type: 'observe' }, command(CONVERSATION_A, 90));
    await collectEntered;

    h.onEvent[0]!({ tabId: tabA }, 'Page.frameNavigated', {
      frame: { id: `root-${tabA}`, url: 'https://a.example/next' }
    });
    h.releaseCollect();

    await expect(pending).resolves.toMatchObject({ ok: false, error: 'BROWSER_STALE_OBSERVATION' });
    const fresh = await h.run({ type: 'observe' }, command(CONVERSATION_A, 90));
    expect(fresh).toMatchObject({ ok: true });
  });

  it('refuses a ref whose resolution crossed a navigation before any input is dispatched', async () => {
    const h = await harness();
    const tabA = await navigate(h, CONVERSATION_A, 90, 'https://a.example/');
    const observed = await h.run({ type: 'observe' }, command(CONVERSATION_A, 90));
    const resolveEntered = h.armResolveBarrier();
    const beforeInput = h.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length;
    const pending = h.run(
      { type: 'move_ref', ref: observed.data.elements[0].ref },
      command(CONVERSATION_A, 90)
    );
    await resolveEntered;

    h.onEvent[0]!({ tabId: tabA }, 'Page.frameNavigated', {
      frame: { id: `root-${tabA}`, url: 'https://a.example/next' }
    });
    h.releaseResolve();

    await expect(pending).resolves.toMatchObject({ ok: false, error: 'BROWSER_STALE_REF' });
    expect(h.calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(beforeInput);
  });

  it('invalidates semantic refs when a child frame navigates', async () => {
    const h = await harness();
    const tabA = await navigate(h, CONVERSATION_A, 90, 'https://a.example/');
    const observed = await h.run({ type: 'observe' }, command(CONVERSATION_A, 90));
    const ref = observed.data.elements[0].ref;

    h.onEvent[0]!({ tabId: tabA }, 'Page.frameNavigated', {
      frame: { id: 'child-frame', parentId: `root-${tabA}`, url: 'https://frame.example/next' }
    });

    await expect(h.run({ type: 'move_ref', ref }, command(CONVERSATION_A, 90)))
      .resolves.toMatchObject({ ok: false, error: 'BROWSER_STALE_REF' });
  });

  it('retires a session from browser-level URL updates before a refused page can be driven', async () => {
    const h = await harness();
    const tabA = await navigate(h, CONVERSATION_A, 90, 'https://a.example/');
    expect(h.onUpdated.length).toBeGreaterThan(0);
    const tab = h.tabs.get(tabA)!;
    tab.url = 'https://chatgpt.com/c/refused';
    h.onUpdated[0]!(tabA, { url: tab.url }, { ...tab });
    await Promise.resolve();

    await expect(h.run({ type: 'status' }, command(CONVERSATION_A, 90)))
      .resolves.toMatchObject({ ok: true, data: { attached: false } });
    expect(h.attached.has(tabA)).toBe(false);
  });

  it('does not report a retired session attached when status crosses the retirement boundary', async () => {
    const h = await harness();
    await navigate(h, CONVERSATION_A, 90, 'https://a.example/');
    const tabGetEntered = h.armTabGetBarrier();
    const pending = h.run({ type: 'status' }, command(CONVERSATION_A, 90));
    await tabGetEntered;

    const globalDetach = h.driver.detach();
    h.releaseTabGet();
    await globalDetach;

    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: { granted: false, attached: false }
    });
  });

  it('bounds Browser sessions at Prime plus the hard worker limit without evicting an owner', async () => {
    const h = await harness();
    const requests = Array.from({ length: 10 }, (_, index) => {
      const conversationId = `12345678-abcd-4abc-8abc-${String(index).padStart(12, '0')}`;
      const controllerTabId = 100 + index;
      return {
        conversationId,
        controllerTabId,
        promise: h.run({ type: 'navigate', url: `https://site-${index}.example/` }, command(conversationId, controllerTabId))
      };
    });
    const results = await Promise.all(requests.map(request => request.promise));
    const accepted = requests.flatMap((request, index) => results[index]?.ok
      ? [{ ...request, tabId: results[index].data.tabId as number }]
      : []);
    const refused = results.filter((result: any) => result?.error === 'BROWSER_SESSION_CAPACITY');
    expect(accepted).toHaveLength(9);
    expect(refused).toHaveLength(1);
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(9);
    expect(h.attached.size).toBe(9);
    for (const existing of accepted) {
      await expect(h.run({ type: 'status' }, command(existing.conversationId, existing.controllerTabId)))
        .resolves.toMatchObject({ ok: true, data: { attached: true, tabId: existing.tabId } });
    }
  });
});
