import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const requireLocal = createRequire(import.meta.url);
const runtime = requireLocal('../patcher/browser-control/runtime/browser-control.cjs');
const CONVERSATION = '12345678-abcd-4abc-8abc-123456789abc';

function controlled() {
  let timer: (() => void) | null = null;
  const control = runtime.createBrowserControl({
    timeoutMs: 10_000,
    makeId: () => 'bc-mutation-safety',
    setTimeout: (fn: () => void) => { timer = fn; return 1; },
    clearTimeout: () => { timer = null; }
  });
  return { control, timer: () => timer };
}

describe('browser-control post-collection retry authority', () => {
  it('never permits blind retry of a collected mutation even when an executor claims effect=none', async () => {
    const h = controlled();
    const pending = h.control.runBrowserCommand(CONVERSATION, { type: 'click_ref', ref: 'g1_e1' });
    const command = h.control.collectBrowserCommand(CONVERSATION);
    expect(command).toMatchObject({ id: 'bc-mutation-safety' });
    expect(h.control.settleBrowserCommand(CONVERSATION, command.id, {
      ok: false,
      error: 'BROWSER_CONTROLLER_STALE',
      effect: 'none',
      retrySafe: true
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      delivery: 'settled',
      effect: 'none',
      retrySafe: false
    });
  });

  it('retains retry authority for a collected read-only action only when no effect is proved', async () => {
    const h = controlled();
    const pending = h.control.runBrowserCommand(CONVERSATION, { type: 'observe' });
    const command = h.control.collectBrowserCommand(CONVERSATION);
    expect(h.control.settleBrowserCommand(CONVERSATION, command.id, {
      ok: false,
      error: 'BROWSER_CONTROLLER_STALE',
      effect: 'none',
      retrySafe: true
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      delivery: 'settled',
      effect: 'none',
      retrySafe: true
    });
  });

  it('keeps unknown effects retry-unsafe even for read-only actions', async () => {
    const h = controlled();
    const pending = h.control.runBrowserCommand(CONVERSATION, { type: 'observe' });
    const command = h.control.collectBrowserCommand(CONVERSATION);
    expect(h.control.settleBrowserCommand(CONVERSATION, command.id, {
      ok: false,
      effect: 'unknown',
      retrySafe: true
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({ retrySafe: false, effect: 'unknown' });
  });
});
