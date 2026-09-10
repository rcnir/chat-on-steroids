import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Patcher modules intentionally remain plain ESM.
import { composePluginRefreshExtension } from '../patcher/task-box/plugin-refresh-adapter.mjs';

const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const appId = 'asdk_app_synthetic';
const pluginId = `plugin_${appId}`;
const tools = [{ name: 'read', description: 'Read current.', inputSchema: { type: 'object' } }];

function official(appVersion: '2.0.6' | '2.0.7' | '2.0.8', file: string) {
  return execFileSync('git', ['show', `v${appVersion}:extension/${file}`], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 3 * 1024 * 1024
  });
}

function compose(appVersion: '2.0.6' | '2.0.7' | '2.0.8' = '2.0.8') {
  return composePluginRefreshExtension({
    background: official(appVersion, 'background.js'),
    content: official(appVersion, 'content.js'),
    chatgptDom: official(appVersion, 'chatgpt-dom.js')
  }, { appVersion });
}

function contentWorkflow() {
  const source = compose().content;
  const start = source.indexOf('  let pluginRefreshBusy = false;');
  const next = source.indexOf('  function inputReuseSafe(', start);
  const fallback = source.indexOf('  function catalogPageReady(', start);
  return source.slice(start, next > start ? next : fallback);
}

function runWorkflow(href: string, overrides: Record<string, unknown> = {}) {
  const assign = vi.fn();
  const ask = vi.fn(async (message: { action: string }) => ({ data: { ok: message.action !== 'deny' } }));
  const context = vm.createContext({
    URL, alive: true, generating: false, epoch: 1, ask,
    location: { href, assign },
    CLF_DOM: {
      generating: () => false,
      pluginManagementIdle: () => true,
      pluginInstalledLinks: () => [],
      pluginRefreshView: () => null
    },
    ...overrides
  });
  vm.runInContext(`${contentWorkflow()}\nwaitPageView = async (read, current) => { if (!current()) return null; const value = read(); return value?.then ? await value : value; }; globalThis.run = refreshManagedPlugin;`, context);
  return { context, assign, ask, run: context.run as Function };
}

describe('TASK BOX current ChatGPT plugin refresh adapter', () => {
  it.each(['2.0.6', '2.0.7', '2.0.8'] as const)('replaces obsolete root routing on official %s without weakening exact management custody', appVersion => {
    const output = compose(appVersion);
    expect(output.background).toContain('https://chatgpt.com/plugins?cos-plugin-refresh=${request.id}');
    expect(output.background).not.toContain('https://chatgpt.com/?cos-plugin-refresh=');
    expect(output.content).toContain("path === '/plugins' && !url.hash");
    expect(output.content).toContain('/^\\/plugins\\/(plugin_(asdk_app_');
    expect(output.content).toContain('url.hash === `#settings/Plugins/${detail[1]}`');
    expect(output.content).not.toContain("hash === '#settings/Plugins'");
    expect(output.chatgptDom).toContain('function pluginInstalledLinks(');
    expect(output.chatgptDom).not.toContain('pluginInstalledButtons');
    expect(output.chatgptDom).toContain("new Set(['更新する', 'Refresh', 'Update'])");
    expect(output.chatgptDom).toContain("hasAttribute('aria-haspopup')");
  });

  it('starts every automatic refresh at /plugins, then opens the exact installed plugin detail before management', async () => {
    const href = `https://chatgpt.com/plugins?cos-plugin-refresh=${requestId}`;
    const link = { getAttribute: (name: string) => name === 'href' ? `/plugins/${pluginId}` : null };
    const h = runWorkflow(href);
    (h.context.CLF_DOM as any).pluginInstalledLinks = vi.fn(() => [link]);

    expect(await h.run({ id: requestId, appId, connectorName: 'Chat On Steroids Core', tools })).toBe(true);
    expect(h.assign).toHaveBeenCalledExactlyOnceWith(
      `https://chatgpt.com/plugins/${pluginId}?cos-plugin-refresh=${requestId}`
    );
    expect(h.ask).not.toHaveBeenCalled();
  });

  it('adds the exact management hash only after the owned plugin detail route is loaded', async () => {
    const href = `https://chatgpt.com/plugins/${pluginId}?cos-plugin-refresh=${requestId}`;
    const h = runWorkflow(href);

    expect(await h.run({ id: requestId, appId, connectorName: 'Chat On Steroids Core', tools })).toBe(true);
    expect(h.assign).toHaveBeenCalledExactlyOnceWith(
      `https://chatgpt.com/plugins/${pluginId}?cos-plugin-refresh=${requestId}#settings/Plugins/${pluginId}`
    );
    expect(h.ask).not.toHaveBeenCalled();
  });

  it('keeps the durable claim before the one safe click and completes only after the expected schema is observed', async () => {
    let refreshed = false;
    const click = vi.fn(() => { refreshed = true; });
    const refresh = {
      disabled: false, isConnected: true, click,
      getAttribute: () => null,
      hasAttribute: () => false
    };
    const href = `https://chatgpt.com/plugins/${pluginId}?cos-plugin-refresh=${requestId}#settings/Plugins/${pluginId}`;
    const h = runWorkflow(href);
    (h.context.CLF_DOM as any).pluginRefreshView = vi.fn(() => ({
      appId, connectorName: 'Chat On Steroids Core', versionId: 'version-1', refresh,
      tools: refreshed ? tools : [{ ...tools[0], description: 'Old description.' }]
    }));

    expect(await h.run({ id: requestId, appId, connectorName: 'Chat On Steroids Core', tools })).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(h.ask.mock.calls.map(([message]) => (message as any).action)).toEqual(['claim', 'complete']);
    expect(h.ask.mock.invocationCallOrder[0]).toBeLessThan(click.mock.invocationCallOrder[0]!);
  });

  it('never clicks after a denied claim', async () => {
    const click = vi.fn();
    const href = `https://chatgpt.com/plugins/${pluginId}?cos-plugin-refresh=${requestId}#settings/Plugins/${pluginId}`;
    const ask = vi.fn(async (message: { action: string }) => ({ data: { ok: message.action !== 'claim' } }));
    const h = runWorkflow(href, { ask });
    (h.context.CLF_DOM as any).pluginRefreshView = vi.fn(() => ({
      appId, connectorName: 'Chat On Steroids Core', versionId: 'version-1',
      refresh: { disabled: false, isConnected: true, click, getAttribute: () => null, hasAttribute: () => false },
      tools: [{ ...tools[0], description: 'Old description.' }]
    }));

    expect(await h.run({ id: requestId, appId, connectorName: 'Chat On Steroids Core', tools })).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(ask.mock.calls.map(([message]) => message.action)).toEqual(['claim', 'fail']);
  });

  it('discovers only exact installed /plugins links and excludes public catalogue cards', () => {
    const source = compose().chatgptDom;
    const start = source.indexOf('  function pluginInstalledLinks(');
    const end = source.indexOf('  function pluginManagementIdle(', start);
    const helper = source.slice(start, end);
    const dom = new JSDOM(`
      <section id="installed"><div id="marker">インストール済み</div><div>
        <a id="core" href="/plugins/${pluginId}"><span>Chat On Steroids Core</span></a>
        <a id="desktop" href="/plugins/plugin_asdk_app_desktop"><span>Chat On Steroids Desktop</span></a>
      </div></section>
      <section id="public"><a id="decoy" href="/plugins/plugin_asdk_app_public"><span>Chat On Steroids Core</span></a></section>
    `, { url: 'https://chatgpt.com/plugins' });
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return [{}]; } });
    const marker = dom.window.document.getElementById('marker')!;
    Object.defineProperty(marker, 'getBoundingClientRect', { value: () => ({ top: 80, bottom: 100 }) });
    for (const id of ['core', 'desktop']) Object.defineProperty(dom.window.document.getElementById(id)!, 'getBoundingClientRect', { value: () => ({ top: 115, bottom: 130 }) });
    Object.defineProperty(dom.window.document.getElementById('decoy')!, 'getBoundingClientRect', { value: () => ({ top: 400, bottom: 415 }) });
    const context = vm.createContext({
      URL, document: dom.window.document, location: dom.window.location,
      safe: (fn: Function, fallback: unknown) => { try { return fn(); } catch { return fallback; } },
      text: (node: Element) => node.textContent || ''
    });
    vm.runInContext(`${helper}\nglobalThis.find = pluginInstalledLinks;`, context);

    expect((context.find as Function)('Chat On Steroids Core', appId)).toHaveLength(1);
    expect((context.find as Function)('Chat On Steroids Core', null)).toHaveLength(1);
    expect((context.find as Function)('Missing connector', null)).toEqual([]);
    dom.window.close();
  });

  it('fails closed when any pinned upstream routing seam drifts', () => {
    const inputs = {
      background: official('2.0.8', 'background.js').replace('function pluginRefreshMarker(tab) {', 'function pluginRefreshMarker(nextTab) {'),
      content: official('2.0.8', 'content.js'),
      chatgptDom: official('2.0.8', 'chatgpt-dom.js')
    };
    expect(() => composePluginRefreshExtension(inputs, { appVersion: '2.0.8' })).toThrow(/BACKGROUND_MARKER_DRIFT/);
    expect(() => composePluginRefreshExtension({ ...inputs, background: official('2.0.8', 'background.js'),
      content: inputs.content.replace('function ownsPluginRefreshPage(id) {', 'function ownsPluginRefreshPage(nextId) {') }, { appVersion: '2.0.8' }))
      .toThrow(/CONTENT_OWNERSHIP_DRIFT/);
    expect(() => composePluginRefreshExtension({ ...inputs, background: official('2.0.8', 'background.js'),
      chatgptDom: inputs.chatgptDom.replace('function pluginInstalledButtons(connectorName) {', 'function pluginInstalledButtons(name) {') }, { appVersion: '2.0.8' }))
      .toThrow(/DOM_INSTALLED_LIST_DRIFT/);
  });
});
