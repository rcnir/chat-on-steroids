import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const requireLocal = createRequire(import.meta.url);
const runtimeModule = requireLocal('../patcher/browser-control/runtime/browser-control.cjs');
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

describe('browser-control retry authority', () => {
  it('app settlement refuses retrySafe=true unless failure effect is none', async () => {
    const control = runtimeModule.createBrowserControl({ timeoutMs: 10_000, makeId: () => 'bc-app-safety' });
    const pending = control.runBrowserCommand(CONVERSATION, { type: 'click_ref', ref: 'g1_e1' });
    expect(control.collectBrowserCommand(CONVERSATION)?.id).toBe('bc-app-safety');
    expect(control.settleBrowserCommand(CONVERSATION, 'bc-app-safety', {
      ok: false,
      error: 'DRIVER_UNCERTAIN',
      effect: 'unknown',
      retrySafe: true
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      delivery: 'settled',
      effect: 'unknown',
      retrySafe: false
    });
  });

  it('extension transport also narrows unsafe executor retry claims before reporting them', async () => {
    const transport = await transportHarness();
    let reported: any = null;
    const bound = transport.bindBackground({
      cleanConversationId: (value: unknown) => value,
      call: async (requestPath: string, init: any) => {
        if (requestPath === '/browser/next') {
          return { ok: true, data: { ok: true, command: { id: 'bc-extension-safety', action: { type: 'click_ref', ref: 'g1_e2' } } } };
        }
        reported = JSON.parse(init.body).result;
        return { ok: true, status: 200, data: { ok: true, accepted: true, replayed: false } };
      }
    });
    transport.registerExecutor(async () => ({
      ok: false,
      error: 'DRIVER_UNCERTAIN',
      effect: 'unknown',
      retrySafe: true
    }));

    await bound.poll(CONVERSATION, () => true);
    expect(reported).toMatchObject({
      ok: false,
      effect: 'unknown',
      retrySafe: false
    });
  });

  it('preserves explicit retry authority when the executor proves no effect', async () => {
    const transport = await transportHarness();
    let reported: any = null;
    const bound = transport.bindBackground({
      cleanConversationId: (value: unknown) => value,
      call: async (requestPath: string, init: any) => {
        if (requestPath === '/browser/next') {
          return { ok: true, data: { ok: true, command: { id: 'bc-none', action: { type: 'click_ref', ref: 'g1_e3' } } } };
        }
        reported = JSON.parse(init.body).result;
        return { ok: true, status: 200, data: { ok: true, accepted: true, replayed: false } };
      }
    });
    transport.registerExecutor(async () => ({
      ok: false,
      error: 'TARGET_GONE',
      effect: 'none',
      retrySafe: true
    }));

    await bound.poll(CONVERSATION, () => true);
    expect(reported).toMatchObject({
      ok: false,
      effect: 'none',
      retrySafe: true
    });
  });
});
