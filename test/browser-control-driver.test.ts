import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Plain ESM build-time module.
import { composeManifest, workerWrapper } from '../patcher/browser-control/extension-adapter.mjs';

const DRIVER = path.join(process.cwd(), 'patcher/browser-control/extension/browser-control-driver.js');

async function harness() {
  const source = await fs.readFile(DRIVER, 'utf8');
  let executor: ((action: any, command?: any) => Promise<any>) | null = null;
  const calls: Array<{ method: string; params?: any }> = [];
  const tab = { id: 20, url: 'https://example.com/', title: 'Example', lastAccessed: 50, windowId: 1, active: false };
  const onEvent: Array<(source: any, method: string, params: any) => void> = [];
  const onDetach: Array<(source: any) => void> = [];
  let groupId = 4;
  let evaluateCount = 0;

  const chrome: any = {
    runtime: { lastError: null },
    permissions: {
      contains: vi.fn(async () => true),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() }
    },
    tabs: {
      get: vi.fn(async () => ({ ...tab })),
      query: vi.fn(async (query: any) => query?.groupId !== undefined ? [] : [{ ...tab }]),
      group: vi.fn(async () => groupId),
      ungroup: vi.fn(async () => undefined),
      create: vi.fn(async () => ({ ...tab })),
      remove: vi.fn(async () => undefined)
    },
    tabGroups: {
      update: vi.fn(async () => ({ id: groupId })),
      query: vi.fn(async () => [])
    },
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      onEvent: { addListener: (fn: any) => onEvent.push(fn) },
      onDetach: { addListener: (fn: any) => onDetach.push(fn) },
      sendCommand: vi.fn(async (_target: any, method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: 'https://example.com/' }, childFrames: [] } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        if (method === 'Page.getLayoutMetrics') return {
          cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 },
          visualViewport: { clientWidth: 800, clientHeight: 600 },
          cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 }
        };
        if (method === 'Page.captureScreenshot') return { data: 'aGVsbG8=' };
        if (method === 'Runtime.evaluate') {
          const expression = String(params?.expression || '');
          if (expression.includes('const selector=')) {
            return { result: { value: {
              url: 'https://example.com/', title: 'Example', scrollY: 0, scrollHeight: 1200,
              elements: [{ path: '#go', tag: 'button', type: '', role: 'button', name: 'Go', value: '', disabled: false, checked: '', x: 100, y: 80, width: 60, height: 30, signature: 'button||button|Go' }]
            } } };
          }
          if (expression.includes('const p=')) {
            return { result: { value: { signature: 'button||button|Go', x: 100, y: 80, disabled: false, covered: false } } };
          }
          if (expression.includes('({x:scrollX,y:scrollY})')) {
            evaluateCount += 1;
            return { result: { value: evaluateCount > 1 ? { x: 0, y: 200 } : { x: 0, y: 0 } } };
          }
          return { result: { value: null } };
        }
        return {};
      })
    }
  };

  const transport = {
    registerExecutor(fn: any) { executor = fn; return () => { executor = null; return true; }; }
  };
  const box: any = { console, chrome, structuredClone, URL, Promise, Map, Set, Error, TypeError, String, Number, JSON, Math, Object, Array, RegExp, Date, setTimeout, clearTimeout, navigator: { userAgent: 'Macintosh' }, CLFBrowserControlTransport: transport };
  vm.createContext(box);
  vm.runInContext(source, box);
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!executor) throw new Error('executor not registered');
  return { source, chrome, calls, driver: box.CLFBrowserControlDriver, run: executor!, onEvent, onDetach };
}

describe('independent browser driver', () => {
  it('contains no OS-pointer or foreground-escalation implementation', async () => {
    const source = await fs.readFile(DRIVER, 'utf8');
    expect(source).not.toContain('chrome.windows.update');
    expect(source).not.toContain('chrome.tabs.update');
    expect(source).not.toContain('CGEvent');
    expect(source).not.toContain('AXUIElement');
    expect(source).not.toContain('SendInput');
    expect(source).toContain('Input.dispatchMouseEvent');
    expect(source).toContain('pointer-events:none');
  });

  it('refuses ChatGPT and non-web targets before debugger attach', async () => {
    const h = await harness();
    expect(h.driver.refusedUrl('https://chatgpt.com/c/abc')).toBe(true);
    expect(h.driver.refusedUrl('https://sub.chatgpt.com/')).toBe(true);
    expect(h.driver.refusedUrl('chrome://settings/')).toBe(true);
    expect(h.driver.refusedUrl('file:///tmp/a')).toBe(true);
    expect(h.driver.refusedUrl('https://example.com/')).toBe(false);
  });

  it('creates an inactive dedicated Agent tab, observes refs, and drives only CDP', async () => {
    const h = await harness();
    const nav = await h.run({ type: 'navigate', url: 'https://example.com/' }, { controllerTabId: 99 });
    expect(nav).toMatchObject({ ok: true, effect: 'confirmed', data: { tabId: 20, created: true } });
    expect(h.chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/', active: false });
    expect(h.chrome.tabs.query).not.toHaveBeenCalledWith({});
    expect(h.chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 20 }, '1.3');
    expect(h.chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [20] });

    const observed = await h.run({ type: 'observe' }, { controllerTabId: 99 });
    expect(observed.ok).toBe(true);
    expect(observed.data).toMatchObject({ dedicated: true });
    expect(observed.data.elements[0]).toMatchObject({ ref: 'g1_e0', role: 'button', name: 'Go', x: 100, y: 80 });
    expect(observed.data.screenshot).toMatchObject({ mimeType: 'image/jpeg', width: 800, height: 600 });

    const hover = await h.run({ type: 'move_ref', ref: 'g1_e0' }, { controllerTabId: 99 });
    expect(hover).toMatchObject({ ok: true, effect: 'confirmed' });
    const click = await h.run({ type: 'click_ref', ref: 'g1_e0' }, { controllerTabId: 99 });
    expect(click).toMatchObject({ ok: true, effect: 'unknown' });
    expect(h.calls.filter(row => row.method === 'Input.dispatchMouseEvent').map(row => row.params.type)).toEqual(expect.arrayContaining(['mouseMoved', 'mousePressed', 'mouseReleased']));

    const released = await h.run({ type: 'detach' });
    expect(released).toMatchObject({ ok: true, data: { attached: false, released: { tabId: 20, dedicated: true } } });
    const evaluations = h.calls.filter(row => row.method === 'Runtime.evaluate').map(row => String(row.params?.expression || ''));
    expect(evaluations.some(expression => expression.includes("__cos_agent_pointer__')?.remove"))).toBe(true);
    expect(h.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 20 });
  });

  it('hard-detaches a refused main frame without sending another page command', async () => {
    const h = await harness();
    await h.run({ type: 'navigate', url: 'https://example.com/' }, { controllerTabId: 99 });
    const observed = await h.run({ type: 'observe' }, { controllerTabId: 99 });
    await h.run({ type: 'move_ref', ref: observed.data.elements[0].ref }, { controllerTabId: 99 });
    const before = h.calls.length;
    expect(h.onEvent.length).toBeGreaterThan(0);
    h.onEvent[0]({ tabId: 20 }, 'Page.frameNavigated', { frame: { id: 'root', url: 'https://chatgpt.com/c/refused' } });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 60));
    const after = h.calls.slice(before);
    expect(after).toHaveLength(0);
    expect(h.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 20 });
    expect(await h.driver.status()).toMatchObject({ attached: false });
  });

  it('makes earlier refs stale after a new observation', async () => {
    const h = await harness();
    await h.run({ type: 'navigate', url: 'https://example.com/' }, { controllerTabId: 99 });
    const first = await h.run({ type: 'observe' }, { controllerTabId: 99 });
    const ref = first.data.elements[0].ref;
    await h.run({ type: 'observe' }, { controllerTabId: 99 });
    const stale = await h.run({ type: 'click_ref', ref }, { controllerTabId: 99 });
    expect(stale).toMatchObject({ ok: false, error: 'BROWSER_STALE_REF', effect: 'none', retrySafe: true });
  });

  it('keeps ambiguous wheel delivery unknown when the top-level scroll position does not prove movement', async () => {
    const source = await fs.readFile(DRIVER, 'utf8');
    expect(source).toContain("effect: changed ? 'confirmed' : 'unknown'");
    expect(source).toContain('retrySafe: false');
  });

  it('does not register an executor unless debugger and optional tab permissions are held', async () => {
    const source = await fs.readFile(DRIVER, 'utf8');
    let registered = 0;
    const chrome: any = {
      permissions: { contains: async () => false, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
      tabs: { query: async () => [] }, tabGroups: { query: async () => [] },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} } }
    };
    const box: any = { console, chrome, structuredClone, URL, Promise, Map, Set, Error, TypeError, String, Number, JSON, Math, Object, Array, RegExp, Date, setTimeout, clearTimeout,
      navigator: { userAgent: 'Macintosh' }, CLFBrowserControlTransport: { registerExecutor() { registered += 1; return () => true; } } };
    vm.createContext(box); vm.runInContext(source, box); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(registered).toBe(0);
  });
});

describe('Task 2 manifest and worker contract', () => {
  it('requires debugger, keeps tab permissions optional, and never requests all_urls', () => {
    const original = { version: '2.1.11', permissions: ['storage', 'scripting', 'alarms'], background: { service_worker: 'background.js', type: 'module' } };
    const out = composeManifest(original, { appVersion: '2.1.11' });
    expect(out.permissions).toContain('debugger');
    expect(out.optional_permissions).toEqual(expect.arrayContaining(['tabs', 'tabGroups']));
    expect(JSON.stringify(out)).not.toContain('<all_urls>');
    expect(workerWrapper()).toContain("import './browser-control-transport.js';\nimport './browser-control-driver.js';\nimport './background.js';");
    expect(workerWrapper()).toContain("import './browser-control-guard.js';");
  });
});
