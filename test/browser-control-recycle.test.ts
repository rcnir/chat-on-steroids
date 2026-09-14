import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

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

function sessionStorageHarness() {
  const state: Record<string, unknown> = {};
  return {
    state,
    api: {
      async get(key: string) { return { [key]: state[key] }; },
      async set(value: Record<string, unknown>) { Object.assign(state, structuredClone(value)); },
      async remove(key: string) { delete state[key]; }
    }
  };
}

describe('browser-control MV3 result durability', () => {
  it('restores only the result after worker recycle and never executes the action twice', async () => {
    const storage = sessionStorageHarness();
    let offered = true;
    let resultAttempts = 0;
    const firstCall = vi.fn(async (requestPath: string) => {
      if (requestPath === '/browser/next') {
        const command = offered
          ? { id: 'bc-recycle', action: { type: 'click_ref', ref: 'g1_e2' }, collectedAt: 123 }
          : null;
        offered = false;
        return { ok: true, data: { ok: true, command } };
      }
      resultAttempts += 1;
      return { ok: false, status: 0, error: 'bridge_reply_lost' };
    });

    const first = await transportHarness();
    const firstBound = first.bindBackground({
      cleanConversationId: (value: unknown) => value,
      call: firstCall,
      sessionStorage: storage.api
    });
    const executor = vi.fn(async () => ({ ok: true, effect: 'confirmed', data: { hit: true } }));
    first.registerExecutor(executor);

    await expect(firstBound.poll(CONVERSATION, () => true)).resolves.toMatchObject({
      collected: true,
      settled: false,
      reason: 'bridge_reply_lost'
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(storage.state.rcBrowserControlPendingResultsV1).toBeTruthy();

    // New VM == new MV3 worker memory. It receives the same chrome.storage.session object but no
    // executor registration yet. The saved result must settle before any new command collection.
    const second = await transportHarness();
    const secondCall = vi.fn(async (requestPath: string, init: any) => {
      expect(requestPath).toBe('/browser/result');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        conversationId: CONVERSATION,
        id: 'bc-recycle',
        result: { ok: true, effect: 'confirmed', data: { hit: true } }
      });
      return { ok: true, status: 200, data: { ok: true, accepted: true, replayed: true } };
    });
    const secondBound = second.bindBackground({
      cleanConversationId: (value: unknown) => value,
      call: secondCall,
      sessionStorage: storage.api
    });

    await expect(secondBound.poll(CONVERSATION, () => false)).resolves.toMatchObject({
      ok: true,
      collected: true,
      settled: true,
      commandId: 'bc-recycle',
      replayed: true
    });
    expect(secondCall).toHaveBeenCalledTimes(1);
    expect(storage.state.rcBrowserControlPendingResultsV1).toBeUndefined();
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('bounds an oversized read-only result before durable storage', async () => {
    const storage = sessionStorageHarness();
    let reported: any = null;
    const transport = await transportHarness();
    const bound = transport.bindBackground({
      cleanConversationId: (value: unknown) => value,
      sessionStorage: storage.api,
      call: async (requestPath: string, init: any) => {
        if (requestPath === '/browser/next') {
          return { ok: true, data: { ok: true, command: { id: 'bc-large', action: { type: 'observe' } } } };
        }
        reported = JSON.parse(init.body).result;
        return { ok: true, status: 200, data: { ok: true, accepted: true, replayed: false } };
      }
    });
    transport.registerExecutor(async () => ({
      ok: true,
      effect: 'confirmed',
      data: { screenshot: 'x'.repeat(4 * 1024 * 1024 + 1024) }
    }));

    await bound.poll(CONVERSATION, () => true);
    expect(reported).toMatchObject({
      ok: false,
      error: 'BROWSER_RESULT_TOO_LARGE',
      effect: 'none',
      retrySafe: true
    });
    expect(storage.state.rcBrowserControlPendingResultsV1).toBeUndefined();
  });
});
