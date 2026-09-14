import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Plain ESM build-time module.
import { AUTH_SEAM, ROUTE_SEAM, composeMain, composeVerifiedMain, releaseFor } from '../patcher/browser-control/main-adapter.mjs';
// @ts-expect-error Plain ESM build-time module.
import { composeBackground, composeManifest, workerWrapper } from '../patcher/browser-control/extension-adapter.mjs';
// @ts-expect-error Plain ESM build-time module.
import { buildFeature, featureFingerprint } from '../patcher/browser-control/build-feature.mjs';

const requireLocal = createRequire(import.meta.url);
const runtimeModule = requireLocal('../patcher/browser-control/runtime/browser-control.cjs');
const loaderModule = requireLocal('../patcher/browser-control/loader.cjs');
const roots: string[] = [];
const CONVERSATION = '12345678-abcd-4abc-8abc-123456789abc';
const CONVERSATION_2 = 'abcdef12-3456-4abc-8abc-abcdef123456';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function scheduledControl() {
  let timer: (() => void) | null = null;
  let now = 100;
  const control = runtimeModule.createBrowserControl({
    timeoutMs: 1000,
    now: () => now,
    makeId: () => 'bc-test',
    setTimeout: (fn: () => void) => { timer = fn; return 1; },
    clearTimeout: () => { timer = null; }
  });
  return {
    control,
    advance(value = 1) { now += value; },
    fire() { const fn = timer; if (!fn) throw new Error('no timer'); timer = null; fn(); }
  };
}

async function bridgeHarness() {
  const loader = loaderModule.createLoader({ timeoutMs: 10_000, makeId: () => 'bc-roundtrip' });
  const call = async (route: string, body?: unknown, method = 'POST') => {
    const res: any = {};
    const handled = await loader.handleBridge({
      route,
      origin: 'chrome-extension://test',
      req: { method, body },
      res,
      readBody: async (req: any) => req.body,
      json: (target: any, status: number, value: unknown) => Object.assign(target, { status, body: value }),
      tooLarge: (target: any) => Object.assign(target, { status: 413 })
    });
    return { handled, ...res };
  };
  return { loader, call };
}

async function extensionHarness() {
  const source = await fs.readFile(path.join(process.cwd(), 'patcher/browser-control/extension/browser-control-transport.js'), 'utf8');
  const box: any = { console, structuredClone, Promise, Map, Set, Error, TypeError, JSON, String };
  vm.createContext(box);
  vm.runInContext(source, box);
  return box.CLFBrowserControlTransport;
}

describe('browser control command lifecycle', () => {
  it('settles exactly one collected command and never reissues it', async () => {
    const h = scheduledControl();
    const result = h.control.runBrowserCommand(CONVERSATION, { type: 'click_ref', ref: 'g1_e2' });
    expect(h.control.status(CONVERSATION)).toMatchObject({ pending: true, state: 'queued', id: 'bc-test' });
    h.advance();
    const command = h.control.collectBrowserCommand(CONVERSATION);
    expect(command).toMatchObject({ id: 'bc-test', action: { type: 'click_ref', ref: 'g1_e2' }, collectedAt: 101 });
    expect(h.control.collectBrowserCommand(CONVERSATION)).toBeNull();
    expect(h.control.settleBrowserCommand(CONVERSATION, 'wrong', { ok: true })).toBe(false);
    expect(h.control.settleBrowserCommand(CONVERSATION, 'bc-test', { ok: true, effect: 'confirmed', data: { hit: true } })).toBe(true);
    await expect(result).resolves.toMatchObject({ ok: true, delivery: 'settled', effect: 'confirmed', data: { hit: true } });
    expect(h.control.status(CONVERSATION)).toEqual({ pending: false });
  });

  it('distinguishes retry-safe uncollected timeout from ambiguous collected timeout', async () => {
    const queued = scheduledControl();
    const beforeCollection = queued.control.runBrowserCommand(CONVERSATION, { type: 'observe' });
    queued.fire();
    await expect(beforeCollection).resolves.toMatchObject({
      error: 'BROWSER_TIMEOUT', delivery: 'not_delivered', effect: 'none', retrySafe: true
    });

    const collected = scheduledControl();
    const afterCollection = collected.control.runBrowserCommand(CONVERSATION_2, { type: 'click', x: 10, y: 20 });
    expect(collected.control.collectBrowserCommand(CONVERSATION_2)).not.toBeNull();
    collected.fire();
    await expect(afterCollection).resolves.toMatchObject({
      error: 'BROWSER_TIMEOUT', delivery: 'collected', effect: 'unknown', retrySafe: false
    });
  });

  it('rejects invalid conversation identity and a second outstanding command without delivery', async () => {
    const h = scheduledControl();
    await expect(h.control.runBrowserCommand('conversation-1', { type: 'observe' })).resolves.toMatchObject({
      error: 'BROWSER_BAD_COMMAND', delivery: 'not_delivered', retrySafe: true
    });
    const first = h.control.runBrowserCommand(CONVERSATION, { type: 'observe' });
    await expect(h.control.runBrowserCommand(CONVERSATION, { type: 'click', x: 1, y: 2 })).resolves.toMatchObject({
      error: 'BROWSER_BUSY', delivery: 'not_delivered', retrySafe: true
    });
    h.fire();
    await first;
  });
});

describe('browser control production bridge path', () => {
  it('round-trips app command -> collector -> result settlement', async () => {
    const h = await bridgeHarness();
    const pending = h.loader.runBrowserCommand(CONVERSATION, { type: 'scroll', scroll_y: 300 });
    const next = await h.call('/browser/next', { conversationId: CONVERSATION });
    expect(next).toMatchObject({ handled: true, status: 200, body: { ok: true, protocol: 1 } });
    expect(next.body.command).toMatchObject({ id: 'bc-roundtrip', action: { type: 'scroll', scroll_y: 300 } });
    expect((await h.call('/browser/next', { conversationId: CONVERSATION })).body.command).toBeNull();

    const settled = await h.call('/browser/result', {
      conversationId: CONVERSATION,
      id: 'bc-roundtrip',
      result: { ok: true, effect: 'confirmed', data: { scrollY: 300 } }
    });
    expect(settled).toMatchObject({ status: 200, body: { ok: true, accepted: true } });
    await expect(pending).resolves.toMatchObject({ ok: true, delivery: 'settled', effect: 'confirmed' });
    expect((await h.call('/browser/result', {
      conversationId: CONVERSATION, id: 'bc-roundtrip', result: { ok: true }
    }))).toMatchObject({ status: 409, body: { error: 'browser_result_not_pending' } });
  });

  it('owns conversation validation and exact request shapes inside the addon', async () => {
    const h = await bridgeHarness();
    expect((await h.call('/browser/next', { conversationId: 'not-a-chat' }))).toMatchObject({ status: 400, body: { error: 'bad_conversation_id' } });
    expect((await h.call('/browser/next', { conversationId: CONVERSATION, extra: true }))).toMatchObject({ status: 400, body: { error: 'bad_request' } });
    expect((await h.call('/browser/result', { conversationId: CONVERSATION, id: 'x' }))).toMatchObject({ status: 400, body: { error: 'bad_request' } });
    expect((await h.call('/browser/capabilities', undefined, 'GET')).body).toMatchObject({
      ok: true, protocol: 1, commandLifecycle: ['queued', 'collected', 'settled'], ambiguousOutcomeIsRetryable: false
    });
    expect((await h.call('/unrelated')).handled).toBe(false);
  });
});

describe('companion browser-control transport', () => {
  it('does not collect without a driver and settles through the registered executor', async () => {
    const transport = await extensionHarness();
    const calls: Array<{ path: string; body: any }> = [];
    let offered = true;
    const bound = transport.bindBackground({
      cleanConversationId: (value: unknown) => typeof value === 'string' && value ? value : null,
      call: async (requestPath: string, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : null;
        calls.push({ path: requestPath, body });
        if (requestPath === '/browser/next') {
          const command = offered ? { id: 'bc-1', action: { type: 'click_ref', ref: 'g1_e1' }, collectedAt: 123 } : null;
          offered = false;
          return { ok: true, data: { ok: true, protocol: 1, command } };
        }
        return { ok: true, data: { ok: true, accepted: true } };
      }
    });

    expect(await bound.poll(CONVERSATION)).toMatchObject({ collected: false, reason: 'executor_unavailable' });
    expect(calls).toHaveLength(0);
    const executor = vi.fn(async () => ({ ok: true, effect: 'confirmed', data: { hit: true } }));
    const release = transport.registerExecutor(executor);
    expect(await bound.poll(CONVERSATION)).toMatchObject({ ok: true, collected: true, settled: true, commandId: 'bc-1' });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(calls.map(row => row.path)).toEqual(['/browser/next', '/browser/result']);
    expect(release()).toBe(true);
    expect(transport.status()).toMatchObject({ bound: true, executor: false, inFlight: 0 });
  });

  it('makes post-collection executor failure retry-unsafe by default', async () => {
    const transport = await extensionHarness();
    let reported: any = null;
    const bound = transport.bindBackground({
      cleanConversationId: (value: unknown) => value,
      call: async (requestPath: string, init: any) => {
        if (requestPath === '/browser/next') return { ok: true, data: { ok: true, command: { id: 'bc-2', action: { type: 'click' } } } };
        reported = JSON.parse(init.body).result;
        return { ok: true, data: { ok: true } };
      }
    });
    transport.registerExecutor(async () => { throw new Error('driver crashed'); });
    await bound.poll(CONVERSATION);
    expect(reported).toMatchObject({ error: 'BROWSER_ACTION_FAILED', effect: 'unknown', retrySafe: false });
  });

  it('contains unexpected bridge throws without leaking the fire-and-forget poll', async () => {
    const transport = await extensionHarness();
    const bound = transport.bindBackground({
      cleanConversationId: (value: unknown) => value,
      call: async () => { throw new Error('bridge exploded'); }
    });
    transport.registerExecutor(async () => ({ ok: true }));
    await expect(bound.poll(CONVERSATION)).resolves.toMatchObject({
      ok: false, collected: false, settled: false, reason: 'transport_failed'
    });
  });
});

describe('upstream-preserving adapters', () => {
  it('adds the main loader only behind the existing authenticated bridge gate', () => {
    const source = `"use strict";\nasync function handle$1(req, res) {\n${AUTH_SEAM}${ROUTE_SEAM}\n  }\n}\n`;
    const composed = composeVerifiedMain(source);
    expect(composed.source).toContain('rocaniiru-browser-control');
    expect(composed.source).toContain('__rcnirBrowserControl.handleBridge({req, res, route, origin, readBody, json, tooLarge})');
    expect(composed.source).not.toContain('conversationId}))');
    expect(() => composeVerifiedMain(source.replace('rateLimited()', 'rateLimitedChanged()'))).toThrow(/AUTH_BOUNDARY|SEAM_MISMATCH/);
    expect(() => composeMain(source, '2.1.11')).toThrow(/OFFICIAL_MAIN_HASH_MISMATCH/);
    expect(() => releaseFor('2.1.12')).toThrow(/UNSUPPORTED_RELEASE/);
  });

  it('keeps the background hook thin and adds no Chrome permission', () => {
    const source = `const BRIDGE_PROTOCOL = 13;\nfunction cleanConversationId(v) { return v; }\nfunction call() {}\nfunction ownsDocument() { return true; }\nconst HANDLERS = {\n  async activity(message, _sender, source) {\n    await load();\n    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };\n    await noteTabConversation(source, message.conversationId);\n    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };\n    const query =\n      \`?conversationId=\${encodeURIComponent(message.conversationId)}\` +\n      \`&since=\${Number(message.since) || 0}\` +\n      \`&goalClient=\${encodeURIComponent(String(source.tab))}\`;\n    const result = await call(\`/activity\${query}\`);\n    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };\n  }\n};\n`;
    const composed = composeBackground(source, { appVersion: '2.1.11' });
    expect(composed).toContain('CLFBrowserControlTransport?.bindBackground');
    expect(composed).toContain('void __rcnirBrowserControlTransport.poll(message.conversationId)');
    expect(() => composeBackground(composed, { appVersion: '2.1.11' })).toThrow(/SOURCE_ALREADY_COMPOSED/);

    const manifest = { version: '2.1.11', permissions: ['storage', 'scripting', 'alarms'], background: { service_worker: 'background.js', type: 'module' } };
    const next = composeManifest(manifest, { appVersion: '2.1.11' });
    expect(next.permissions).toEqual(manifest.permissions);
    expect(next.background).toEqual({ service_worker: 'browser-control-worker.js', type: 'module' });
    expect(manifest.background.service_worker).toBe('background.js');
    expect(workerWrapper()).toContain("import './browser-control-transport.js';");
    expect(workerWrapper()).toContain("import './background.js';");
  });

  it('builds an isolated payload with stable fingerprint and no app mutation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-control-feature-')); roots.push(root);
    const out = path.join(root, 'feature');
    const before = featureFingerprint();
    const built = buildFeature(out, '2.1.11');
    expect(built.featureFingerprint).toBe(before);
    expect(await fs.readFile(path.join(out, 'addon/loader.cjs'), 'utf8')).toContain('createBrowserControl');
    expect(await fs.readFile(path.join(out, 'addon/runtime/browser-control.cjs'), 'utf8')).toContain('collectBrowserCommand');
    expect(await fs.readFile(path.join(out, 'extension/browser-control-transport.js'), 'utf8')).toContain('registerExecutor');
    expect(await fs.readFile(path.join(out, 'extension/browser-control-worker.js'), 'utf8')).toContain("import './background.js';");
  });
});
