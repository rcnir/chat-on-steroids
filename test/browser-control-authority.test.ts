import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Plain ESM build-time module.
import { composeBackground } from '../patcher/browser-control/extension-adapter.mjs';

const CONVERSATION = '12345678-abcd-4abc-8abc-123456789abc';
const CONVERSATION_B = 'abcdef12-3456-4abc-8abc-abcdef123456';

async function transportHarness() {
  const source = await fs.readFile(
    path.join(process.cwd(), 'patcher/browser-control/extension/browser-control-transport.js'),
    'utf8'
  );
  const box: any = { console, structuredClone, Promise, Map, Set, Error, TypeError, JSON, String, Number };
  vm.createContext(box);
  vm.runInContext(source, box);
  return box.CLFBrowserControlTransport;
}

describe('browser-control controller authority', () => {
  it('threads exact document and controller-tab proof through the activity hook', () => {
    const source = `const BRIDGE_PROTOCOL = 13;\nfunction cleanConversationId(v) { return v; }\nfunction call() {}\nfunction ownsDocument() { return true; }\nconst HANDLERS = {\n  async activity(message, _sender, source) {\n    await load();\n    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };\n    await noteTabConversation(source, message.conversationId);\n    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };\n    const query =\n      \`?conversationId=\${encodeURIComponent(message.conversationId)}\` +\n      \`&since=\${Number(message.since) || 0}\` +\n      \`&goalClient=\${encodeURIComponent(String(source.tab))}\`;\n    const result = await call(\`/activity\${query}\`);\n    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };\n  }\n};\n`;
    const composed = composeBackground(source, { appVersion: '2.1.11' });
    expect(composed).toContain('const __rcnirBrowserControlStillOwns = () => ownsDocument(source);');
    expect(composed).toContain(
      'void __rcnirBrowserControlTransport.poll(message.conversationId, __rcnirBrowserControlStillOwns, source.tab);'
    );
  });

  it('never collects a new command once the controller document is stale', async () => {
    const transport = await transportHarness();
    const call = vi.fn(async () => ({ ok: true, data: { ok: true, command: null } }));
    const bound = transport.bindBackground({ cleanConversationId: (value: unknown) => value, call });
    transport.registerExecutor(async () => ({ ok: true, effect: 'confirmed' }));

    await expect(bound.poll(CONVERSATION, () => false, 41)).resolves.toMatchObject({
      ok: false,
      collected: false,
      reason: 'stale_controller'
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('settles no-effect instead of executing if ownership changes while next is in flight', async () => {
    const transport = await transportHarness();
    let current = true;
    let reported: any = null;
    const call = vi.fn(async (requestPath: string, init: any) => {
      if (requestPath === '/browser/next') {
        current = false;
        return {
          ok: true,
          data: {
            ok: true,
            command: { id: 'bc-stale', action: { type: 'click_ref', ref: 'g1_e1' }, collectedAt: 123 }
          }
        };
      }
      reported = JSON.parse(init.body).result;
      return { ok: true, data: { ok: true, accepted: true, replayed: false } };
    });
    const bound = transport.bindBackground({ cleanConversationId: (value: unknown) => value, call });
    const executor = vi.fn(async () => ({ ok: true, effect: 'confirmed' }));
    transport.registerExecutor(executor);

    await expect(bound.poll(CONVERSATION, () => current, 42)).resolves.toMatchObject({
      ok: true,
      collected: true,
      settled: true,
      commandId: 'bc-stale'
    });
    expect(executor).not.toHaveBeenCalled();
    expect(reported).toMatchObject({
      ok: false,
      error: 'BROWSER_CONTROLLER_STALE',
      effect: 'none',
      retrySafe: true
    });
  });

  it('passes the exact controller tab to the executor and may settle after ownership moves', async () => {
    const transport = await transportHarness();
    let resultAttempts = 0;
    let offered = true;
    const call = vi.fn(async (requestPath: string) => {
      if (requestPath === '/browser/next') {
        const command = offered ? { id: 'bc-result', action: { type: 'click_ref', ref: 'g1_e2' } } : null;
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

    await expect(bound.poll(CONVERSATION, () => true, 77)).resolves.toMatchObject({
      collected: true,
      settled: false
    });
    await expect(bound.poll(CONVERSATION, () => false, 77)).resolves.toMatchObject({
      ok: true,
      collected: true,
      settled: true,
      commandId: 'bc-result'
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith(
      { type: 'click_ref', ref: 'g1_e2' },
      expect.objectContaining({ conversationId: CONVERSATION, controllerTabId: 77 })
    );
    expect(call.mock.calls.map(([requestPath]) => requestPath)).toEqual([
      '/browser/next',
      '/browser/result',
      '/browser/result'
    ]);
  });

  it('coalesces one conversation while allowing another conversation to execute in parallel', async () => {
    const transport = await transportHarness();
    const offered = new Set<string>();
    const nextCalls: string[] = [];
    const resultCalls: string[] = [];
    const call = vi.fn(async (requestPath: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const conversationId = body.conversationId as string;
      if (requestPath === '/browser/next') {
        nextCalls.push(conversationId);
        const command = offered.has(conversationId)
          ? null
          : { id: `bc-${conversationId.slice(0, 8)}`, action: { type: 'status' } };
        offered.add(conversationId);
        return { ok: true, data: { ok: true, command } };
      }
      resultCalls.push(conversationId);
      return { ok: true, status: 200, data: { ok: true, accepted: true, replayed: false } };
    });
    const bound = transport.bindBackground({ cleanConversationId: (value: unknown) => value, call });

    let enterA!: () => void;
    let enterB!: () => void;
    const enteredA = new Promise<void>(resolve => { enterA = resolve; });
    const enteredB = new Promise<void>(resolve => { enterB = resolve; });
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const gateB = new Promise<void>(resolve => { releaseB = resolve; });
    const executor = vi.fn(async (_action: any, command: any) => {
      if (command.conversationId === CONVERSATION) {
        enterA();
        await gateA;
      } else {
        enterB();
        await gateB;
      }
      return { ok: true, effect: 'none', data: { conversationId: command.conversationId } };
    });
    transport.registerExecutor(executor);

    const firstA = bound.poll(CONVERSATION, () => true, 41);
    const duplicateA = bound.poll(CONVERSATION, () => true, 41);
    await enteredA;
    const firstB = bound.poll(CONVERSATION_B, () => true, 42);
    await enteredB;

    expect(executor).toHaveBeenCalledTimes(2);
    expect(nextCalls.filter(id => id === CONVERSATION)).toHaveLength(1);
    expect(nextCalls.filter(id => id === CONVERSATION_B)).toHaveLength(1);

    releaseB();
    releaseA();
    await expect(Promise.all([firstA, duplicateA, firstB])).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: true, settled: true }),
      expect.objectContaining({ ok: true, settled: true }),
      expect.objectContaining({ ok: true, settled: true })
    ]));
    expect(resultCalls.filter(id => id === CONVERSATION)).toHaveLength(1);
    expect(resultCalls.filter(id => id === CONVERSATION_B)).toHaveLength(1);
  });
});
