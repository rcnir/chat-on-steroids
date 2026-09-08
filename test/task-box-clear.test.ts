import { describe, expect, it, vi } from 'vitest';
import {
  createTaskBoxClearService,
  type TaskBoxClearOwner
} from '../src/main/task-box-clear.js';

const ownerA: TaskBoxClearOwner = { tabId: 7, documentId: 'doc-a' };
const ownerB: TaskBoxClearOwner = { tabId: 8, documentId: 'doc-b' };
const requestA = '11111111-2222-4333-8444-555555555555';
const requestB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function harness(options: {
  seed?: unknown | null;
  clear?: () => Promise<void>;
  write?: (value: unknown, persist: (value: unknown) => void) => Promise<void>;
} = {}) {
  let durable: unknown | null = options.seed ?? null;
  const writes: unknown[] = [];
  const clear = vi.fn(options.clear ?? (async () => {}));
  const read = vi.fn(async () => clone(durable));
  const write = vi.fn(async (value: unknown) => {
    const persist = (next: unknown) => { durable = clone(next); writes.push(clone(next)); };
    if (options.write) return options.write(value, persist);
    persist(value);
  });
  const make = () => createTaskBoxClearService({ read, write, clear });
  return { make, read, write, clear, writes, durable: () => clone(durable) };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('TASK BOX Clear durable at-most-once service', () => {
  it('persists intent before clear and concurrent duplicates join one mutation', async () => {
    const gate = deferred();
    const h = harness({ clear: () => gate.promise });
    const service = h.make();

    const first = service.request(ownerA, requestA);
    const duplicate = service.request(ownerA, requestA);
    await vi.waitFor(() => expect(h.clear).toHaveBeenCalledTimes(1));
    expect(h.write).toHaveBeenCalledTimes(1);
    expect((h.durable() as any).busy).toMatchObject({ state: 'pending', requestId: requestA, owner: ownerA });

    gate.resolve();
    await expect(first).resolves.toEqual({ ok: true, status: 'completed', requestId: requestA });
    await expect(duplicate).resolves.toEqual({ ok: true, status: 'completed', requestId: requestA });
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect((h.durable() as any).busy).toBeNull();
    expect((h.durable() as any).receipts[requestA]).toMatchObject({ protocol: 1, state: 'completed', requestId: requestA, owner: ownerA });
  });

  it('lost reply is recovered from the permanent receipt after restart without another clear', async () => {
    const h = harness();
    await expect(h.make().request(ownerA, requestA)).resolves.toEqual({ ok: true, status: 'completed', requestId: requestA });
    expect(h.clear).toHaveBeenCalledTimes(1);

    const restarted = h.make();
    await expect(restarted.status(ownerA, requestA)).resolves.toEqual({ ok: true, status: 'completed', requestId: requestA });
    await expect(restarted.request(ownerA, requestA)).resolves.toEqual({ ok: true, status: 'completed', requestId: requestA });
    expect(h.clear).toHaveBeenCalledTimes(1);
  });

  it('restart with a pending intent reports incomplete and never replays it', async () => {
    const seed = {
      version: 1,
      busy: { state: 'pending', requestId: requestA, owner: ownerA },
      receipts: {}
    };
    const h = harness({ seed });
    const service = h.make();
    await expect(service.status(ownerA, requestA)).resolves.toEqual({ ok: false, status: 'incomplete', requestId: requestA, reason: 'pending' });
    await expect(service.request(ownerA, requestA)).resolves.toEqual({ ok: false, status: 'incomplete', requestId: requestA, reason: 'pending' });
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('a new request is refused while another request owns the global busy record', async () => {
    const gate = deferred();
    const h = harness({ clear: () => gate.promise });
    const service = h.make();
    const first = service.request(ownerA, requestA);
    await vi.waitFor(() => expect(h.clear).toHaveBeenCalledTimes(1));
    await expect(service.request(ownerB, requestB)).resolves.toEqual({ ok: false, status: 'busy', requestId: requestB });
    expect(h.clear).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
  });

  it('wrong-owner replay is rejected for both pending intent and completed receipt', async () => {
    const gate = deferred();
    const h = harness({ clear: () => gate.promise });
    const service = h.make();
    const first = service.request(ownerA, requestA);
    await vi.waitFor(() => expect(h.clear).toHaveBeenCalledTimes(1));
    await expect(service.status(ownerB, requestA)).resolves.toEqual({ ok: false, status: 'owner_mismatch', requestId: requestA });
    await expect(service.request(ownerB, requestA)).resolves.toEqual({ ok: false, status: 'owner_mismatch', requestId: requestA });
    gate.resolve();
    await first;
    await expect(service.status(ownerB, requestA)).resolves.toEqual({ ok: false, status: 'owner_mismatch', requestId: requestA });
  });

  it('a failed intent write performs no clear, including a write that persisted then threw', async () => {
    let writes = 0;
    const h = harness({
      write: async (value, persist) => {
        writes += 1;
        if (writes === 1) {
          persist(value);
          throw new Error('reply lost after durable rename');
        }
        persist(value);
      }
    });
    const service = h.make();
    await expect(service.request(ownerA, requestA)).resolves.toEqual({
      ok: false,
      status: 'incomplete',
      requestId: requestA,
      reason: 'intent_write_failed'
    });
    expect(h.clear).not.toHaveBeenCalled();
    expect((h.durable() as any).busy.requestId).toBe(requestA);

    const restarted = h.make();
    await expect(restarted.request(ownerA, requestA)).resolves.toEqual({ ok: false, status: 'incomplete', requestId: requestA, reason: 'pending' });
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('clear failure becomes uncertain and permanently blocks reexecution', async () => {
    const h = harness({ clear: async () => { throw new Error('durability failed after reset'); } });
    const service = h.make();
    await expect(service.request(ownerA, requestA)).resolves.toEqual({
      ok: false,
      status: 'incomplete',
      requestId: requestA,
      reason: 'clear_uncertain'
    });
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect((h.durable() as any).busy).toMatchObject({ state: 'uncertain', requestId: requestA });

    await expect(h.make().request(ownerA, requestA)).resolves.toEqual({ ok: false, status: 'incomplete', requestId: requestA, reason: 'uncertain' });
    await expect(h.make().request(ownerB, requestB)).resolves.toEqual({ ok: false, status: 'busy', requestId: requestB });
    expect(h.clear).toHaveBeenCalledTimes(1);
  });

  it('receipt write failure after clear leaves an incomplete replay fence', async () => {
    let writeCount = 0;
    const h = harness({
      write: async (value, persist) => {
        writeCount += 1;
        if (writeCount === 1) return persist(value);
        if (writeCount === 2) throw new Error('receipt write failed');
        persist(value);
      }
    });
    await expect(h.make().request(ownerA, requestA)).resolves.toEqual({
      ok: false,
      status: 'incomplete',
      requestId: requestA,
      reason: 'receipt_write_failed'
    });
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect((h.durable() as any).busy).toMatchObject({ state: 'uncertain', requestId: requestA });
    await expect(h.make().request(ownerA, requestA)).resolves.toEqual({ ok: false, status: 'incomplete', requestId: requestA, reason: 'uncertain' });
    expect(h.clear).toHaveBeenCalledTimes(1);
  });

  it('a receipt write whose reply is lost is recovered by a fresh durable read', async () => {
    let writeCount = 0;
    const h = harness({
      write: async (value, persist) => {
        writeCount += 1;
        persist(value);
        if (writeCount === 2) throw new Error('reply lost after receipt rename');
      }
    });
    await expect(h.make().request(ownerA, requestA)).resolves.toEqual({ ok: true, status: 'completed', requestId: requestA });
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect((h.durable() as any).busy).toBeNull();
    expect((h.durable() as any).receipts[requestA]).toMatchObject({ protocol: 1, owner: ownerA });
  });

  it('a late clear callback keeps the request pending until it resolves, then publishes one receipt', async () => {
    const gate = deferred();
    const h = harness({ clear: () => gate.promise });
    const service = h.make();
    const request = service.request(ownerA, requestA);
    await vi.waitFor(() => expect(h.clear).toHaveBeenCalledTimes(1));
    await expect(service.status(ownerA, requestA)).resolves.toEqual({ ok: false, status: 'incomplete', requestId: requestA, reason: 'pending' });
    expect((h.durable() as any).receipts).toEqual({});

    gate.resolve();
    await expect(request).resolves.toEqual({ ok: true, status: 'completed', requestId: requestA });
    expect(Object.keys((h.durable() as any).receipts)).toEqual([requestA]);
  });

  it('unknown status is explicit and capability never reads or writes state', async () => {
    const h = harness();
    const service = h.make();
    expect(service.capability()).toEqual({ protocol: 1, supported: true, atMostOnce: true, durableReceipts: true });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    await expect(service.status(ownerA, requestA)).resolves.toEqual({ ok: false, status: 'unknown_request', requestId: requestA });
  });

  it('malformed persisted state and malformed caller identity fail closed without clear', async () => {
    const malformed = harness({ seed: { version: 1, busy: null, receipts: { [requestA]: { state: 'completed' } } } });
    await expect(malformed.make().request(ownerA, requestA)).resolves.toEqual({ ok: false, status: 'state_invalid', requestId: requestA });
    expect(malformed.clear).not.toHaveBeenCalled();

    const h = harness();
    await expect(h.make().request({ tabId: -1, documentId: 'doc' }, requestA)).resolves.toEqual({ ok: false, status: 'invalid', requestId: requestA });
    await expect(h.make().request(ownerA, 'not-a-uuid')).resolves.toEqual({ ok: false, status: 'invalid', requestId: 'not-a-uuid' });
    expect(h.clear).not.toHaveBeenCalled();
  });
});
