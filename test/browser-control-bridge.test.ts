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

describe('browser-control command lifecycle', () => {
  it('settles one collected command and never reissues it', async () => {
    const h = scheduledControl();
    const result = h.control.runBrowserCommand(CONVERSATION, { type: 'click_ref', ref: 'g1_e2' });
    expect(h.control.status(CONVERSATION)).toMatchObject({ pending: true, state: 'queued', id: 'bc-test' });
    h.advance();
    const command = h.control.collectBrowserCommand(CONVERSATION);
    expect(command).toMatchObject({ id: 'bc-test', action: { type: 'click_ref', ref: 'g1_e2' }, collectedAt: 101 });
    expect(h.control.collectBrowserCommand(CONVERSATION)).toBeNull();
    expect(h.control.settleBrowserCommand(CONVERSATION, 'bc-test', { ok: true, effect: 'confirmed', data: { hit: true } })).toBe(true);
    await expect(result).resolves.toMatchObject({ ok: true, delivery: 'settled', effect: 'confirmed', data: { hit: true } });
  });

  it('distinguishes safe pre-collection timeout from ambiguous collected timeout', async () => {
    const queued = scheduledControl();
    const before = queued.control.runBrowserCommand(CONVERSATION, { type: 'observe' });
    queued.fire();
    await expect(before).resolves.toMatchObject({ error: 'BROWSER_TIMEOUT', delivery: 'not_delivered', effect: 'none', retrySafe: true });

    const collected = scheduledControl();
    const after = collected.control.runBrowserCommand(CONVERSATION_2, { type: 'click_ref', ref: 'g1_e1' });
    expect(collected.control.collectBrowserCommand(CONVERSATION_2)).not.toBeNull();
    collected.fire();
    await expect(after).resolves.toMatchObject({ error: 'BROWSER_TIMEOUT', delivery: 'collected', effect: 'unknown', retrySafe: false });
  });

  it('refuses invalid identity and a second outstanding command before delivery', async () => {
    const h = scheduledControl();
    await expect(h.control.runBrowserCommand('conversation-1', { type: 'observe' })).resolves.toMatchObject({ error: 'BROWSER_BAD_COMMAND', retrySafe: true });
    const first = h.control.runBrowserCommand(CONVERSATION, { type: 'observe' });
    await expect(h.control.runBrowserCommand(CONVERSATION, { type: 'click_ref', ref: 'g1_e1' })).resolves.toMatchObject({ error: 'BROWSER_BUSY', delivery: 'not_delivered', retrySafe: true });
    h.fire();
    await first;
  });
});

describe('browser-control production bridge settlement', () => {
  it('round-trips a command and accepts only an identical result replay', async () => {
    const h = await bridgeHarness();
    const resultBody = { ok: true, effect: 'confirmed', data: { scrollY: 300 } };
    const pending = h.loader.runBrowserCommand(CONVERSATION, { type: 'scroll', scroll_y: 300 });
    const next = await h.call('/browser/next', { conversationId: CONVERSATION });
    expect(next.body.command).toMatchObject({ id: 'bc-roundtrip', action: { type: 'scroll', scroll_y: 300 } });
    expect((await h.call('/browser/next', { conversationId: CONVERSATION })).body.command).toBeNull();

    expect(await h.call('/browser/result', { conversationId: CONVERSATION, id: 'bc-roundtrip', result: resultBody }))
      .toMatchObject({ status: 200, body: { ok: true, accepted: true, replayed: false } });
    await expect(pending).resolves.toMatchObject({ ok: true, delivery: 'settled', effect: 'confirmed' });
    expect(await h.call('/browser/result', { conversationId: CONVERSATION, id: 'bc-roundtrip', result: resultBody }))
      .toMatchObject({ status: 200, body: { accepted: true, replayed: true } });
    expect(await h.call('/browser/result', { conversationId: CONVERSATION, id: 'bc-roundtrip', result: { ok: false, effect: 'unknown' } }))
      .toMatchObject({ status: 409, body: { error: 'browser_result_mismatch' } });
  });

  it('validates exact bridge request shapes and exposes the lifecycle contract', async () => {
    const h = await bridgeHarness();
    expect(await h.call('/browser/next', { conversationId: 'not-a-chat' })).toMatchObject({ status: 400, body: { error: 'bad_conversation_id' } });
    expect(await h.call('/browser/next', { conversationId: CONVERSATION, extra: true })).toMatchObject({ status: 400, body: { error: 'bad_request' } });
    expect((await h.call('/browser/capabilities', undefined, 'GET')).body).toMatchObject({
      protocol: 1,
      commandLifecycle: ['queued', 'collected', 'settled'],
      ambiguousOutcomeIsRetryable: false,
      idempotentResultReplay: true
    });
  });
});

describe('companion browser-control transport', () => {
  it('collects nothing until an executor exists, then settles through it', async () => {
    const transport = await extensionHarness();
    const calls: string[] = [];
    let offered = true;
    const bound = transport.bindBackground({
      cleanConversationId: (value: unknown) => typeof value === 'string' && value ? value : null,
      call: async (requestPath: string) => {
        calls.push(requestPath);
        if (requestPath === '/browser/next') {
          const command = offered ? { id: 'bc-1', action: { type: 'click_ref', ref: 'g1_e1' }, collectedAt: 123 } : null;
          offered = false;
          return { ok: true, data: { ok: true, command } };
        }
        return { ok: true, data: { ok: true, accepted: true } };
      }
    });
    expect(await bound.poll(CONVERSATION)).toMatchObject({ collected: false, reason: 'executor_unavailable' });
    expect(calls).toHaveLength(0);
    const executor = vi.fn(async () => ({ ok: true, effect: 'confirmed', data: { hit: true } }));
    transport.registerExecutor(executor);
    expect(await bound.poll(CONVERSATION)).toMatchObject({ ok: true, collected: true, settled: true, commandId: 'bc-1' });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['/browser/next', '/browser/result']);
  });

  it('retries result delivery without re-executing the action', async () => {
    const transport = await extensionHarness();
    let offered = true;
    let resultAttempts = 0;
    const call = vi.fn(async (requestPath: string) => {
      if (requestPath === '/browser/next') {
        const command = offered ? { id: 'bc-retry', action: { type: 'click_ref', ref: 'g1_e2' } } : null;
        offered = false;
        return { ok: true, data: { ok: true, command } };
      }
      resultAttempts += 1;
      return resultAttempts === 1
        ? { ok: false, status: 0, error: 'app_not_found' }
        : { ok: true, status: 200, data: { ok: true, accepted: true, replayed: true } };
    });
    const bound = transport.bindBackground({ cleanConversationId: (value: unknown) => value, call });
    const executor = vi.fn(async () => ({ ok: true, effect: 'confirmed', data: { hit: true } }));
    transport.registerExecutor(executor);
    expect(await bound.poll(CONVERSATION)).toMatchObject({ collected: true, settled: false });
    expect(await bound.poll(CONVERSATION)).toMatchObject({ ok: true, settled: true });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(call.mock.calls.map(([requestPath]) => requestPath)).toEqual(['/browser/next', '/browser/result', '/browser/result']);
  });
});

describe('upstream-preserving Task 2 adapters', () => {
  it('keeps browser bridge routes behind the existing authenticated app boundary', () => {
    const source = `"use strict";\nasync function handle$1(req, res) {\n${AUTH_SEAM}${ROUTE_SEAM}\n  }\n}\n`;
    const composed = composeVerifiedMain(source);
    expect(composed.source).toContain('rocaniiru-browser-control');
    expect(composed.source).toContain('__rcnirBrowserControl.handleBridge');
    expect(() => composeVerifiedMain(source.replace('rateLimited()', 'rateLimitedChanged()'))).toThrow(/AUTH_BOUNDARY|SEAM_MISMATCH/);
    expect(() => composeMain(source, '2.1.11')).toThrow(/OFFICIAL_MAIN_HASH_MISMATCH/);
    expect(() => releaseFor('2.1.12')).toThrow(/UNSUPPORTED_RELEASE/);
  });

  it('keeps the background hook thin and declares only debugger plus optional tab ownership permissions', () => {
    const source = `const BRIDGE_PROTOCOL = 13;\nfunction cleanConversationId(v) { return v; }\nfunction call() {}\nfunction ownsDocument() { return true; }\nconst HANDLERS = {\n  async activity(message, _sender, source) {\n    await load();\n    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };\n    await noteTabConversation(source, message.conversationId);\n    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };\n    const query =\n      \`?conversationId=\${encodeURIComponent(message.conversationId)}\` +\n      \`&since=\${Number(message.since) || 0}\` +\n      \`&goalClient=\${encodeURIComponent(String(source.tab))}\`;\n    const result = await call(\`/activity\${query}\`);\n    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };\n  }\n};\n`;
    const composed = composeBackground(source, { appVersion: '2.1.11' });
    expect(composed).toContain('CLFBrowserControlTransport?.bindBackground');
    expect(composed).toContain('__rcnirBrowserControlTransport.poll(message.conversationId, __rcnirBrowserControlStillOwns)');
    expect(() => composeBackground(composed, { appVersion: '2.1.11' })).toThrow(/SOURCE_ALREADY_COMPOSED/);

    const manifest = { version: '2.1.11', permissions: ['storage', 'scripting', 'alarms'], background: { service_worker: 'background.js', type: 'module' } };
    const next = composeManifest(manifest, { appVersion: '2.1.11' });
    expect(next.permissions).toEqual(expect.arrayContaining(['storage', 'scripting', 'alarms', 'debugger']));
    expect(next.optional_permissions).toEqual(expect.arrayContaining(['tabs', 'tabGroups']));
    expect(JSON.stringify(next)).not.toContain('<all_urls>');
    expect(next.background).toEqual({ service_worker: 'browser-control-worker.js', type: 'module' });
    expect(manifest.permissions).toEqual(['storage', 'scripting', 'alarms']);
    expect(workerWrapper()).toContain("import './browser-control-transport.js';\nimport './browser-control-driver.js';\nimport './background.js';");
    expect(workerWrapper()).toContain("import './browser-control-guard.js';");
  });

  it('builds an isolated driver payload without mutating an app or browser', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-control-feature-')); roots.push(root);
    const out = path.join(root, 'feature');
    const before = featureFingerprint();
    const built = buildFeature(out, '2.1.11');
    expect(built.featureFingerprint).toBe(before);
    expect(await fs.readFile(path.join(out, 'addon/loader.cjs'), 'utf8')).toContain('createBrowserControl');
    expect(await fs.readFile(path.join(out, 'extension/browser-control-transport.js'), 'utf8')).toContain('registerExecutor');
    expect(await fs.readFile(path.join(out, 'extension/browser-control-driver.js'), 'utf8')).toContain('Input.dispatchMouseEvent');
    expect(await fs.readFile(path.join(out, 'extension/browser-control-guard.js'), 'utf8')).toContain('Page.frameNavigated');
    expect(await fs.readFile(path.join(out, 'extension/browser-control-worker.js'), 'utf8')).toContain("import './background.js';");
  });
});
