import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Plain ESM build-time module.
import { composeBackground } from '../patcher/browser-control/extension-adapter.mjs';

const CONVERSATION = '12345678-abcd-4abc-8abc-123456789abc';

async function transportHarness() {
  const source = await fs.readFile(
    path.join(process.cwd(), 'patcher/browser-control/extension/browser-control-transport.js'),
    'utf8'
  );
  const box: any = { console, structuredClone, Promise, Map, Set, Error, TypeError, JSON, String };
  vm.createContext(box);
  vm.runInContext(source, box);
  return box.CLFBrowserControlTransport;
}

describe('browser-control controller authority', () => {
  it('threads the exact owned-document proof through the fire-and-forget activity hook', () => {
    const source = `const BRIDGE_PROTOCOL = 13;\nfunction cleanConversationId(v) { return v; }\nfunction call() {}\nfunction ownsDocument() { return true; }\nconst HANDLERS = {\n  async activity(message, _sender, source) {\n    await load();\n    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };\n    await noteTabConversation(source, message.conversationId);\n    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };\n    const query =\n      \`?conversationId=\${encodeURIComponent(message.conversationId)}\` +\n      \`&since=\${Number(message.since) || 0}\` +\n      \`&goalClient=\${encodeURIComponent(String(source.tab))}\`;\n    const result = await call(\`/activity\${query}\`);\n    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };\n  }\n};\n`;
    const composed = composeBackground(source, { appVersion: '2.1.11' });
    expect(composed).toContain('const __rcnirBrowserControlStillOwns = () => ownsDocument(source);');
    expect(composed).toContain(
      'void __rcnirBrowserControlTransport.poll(message.conversationId, __rcnirBrowserControlStillOwns);'
    );
  });

  it('never collects a new command once the controller document is stale', async () => {
    const transport = await transportHarness();
    const call = vi.fn(async () => ({ ok: true, data: { ok: true, command: null } }));
    const bound = transport.bindBackground({ cleanConversationId: (value: unknown) => value, call });
    transport.registerExecutor(async () => ({ ok: true, effect: 'confirmed' }));

    await expect(bound.poll(CONVERSATION, () => false)).resolves.toMatchObject({
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

    await expect(bound.poll(CONVERSATION, () => current)).resolves.toMatchObject({
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

  it('may settle an already-executed result after controller ownership moves', async () => {
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

    await expect(bound.poll(CONVERSATION, () => true)).resolves.toMatchObject({
      collected: true,
      settled: false
    });
    await expect(bound.poll(CONVERSATION, () => false)).resolves.toMatchObject({
      ok: true,
      collected: true,
      settled: true,
      commandId: 'bc-result'
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(call.mock.calls.map(([requestPath]) => requestPath)).toEqual([
      '/browser/next',
      '/browser/result',
      '/browser/result'
    ]);
  });
});
