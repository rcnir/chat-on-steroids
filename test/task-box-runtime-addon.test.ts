import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

const ownerA = { tabId: 7, documentId: 'doc-a' };
const ownerB = { tabId: 8, documentId: 'doc-b' };
const requestA = '11111111-2222-4333-8444-555555555555';
const requestB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const runtimeSource = path.join(process.cwd(), 'patcher', 'task-box', 'runtime', 'index.cjs');
const clearSource = path.join(process.cwd(), 'patcher', 'task-box', 'runtime', 'clear-service.ts');
const tsc = path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
const execFileAsync = promisify(execFile);

type RuntimeDependencies = {
  readState: () => Promise<unknown | null>;
  writeState: (value: unknown) => Promise<void>;
  clear: () => Promise<void>;
};

type ResponseRecord = { status: number; body: unknown; origin: string; tooLarge?: boolean };

type TaskBoxRuntime = {
  handleTaskBox(input: {
    req: { method: string; body?: unknown; bodyError?: Error };
    res: Record<string, never>;
    url: URL;
    origin: string;
    route: string;
    readBody: (req: { body?: unknown; bodyError?: Error }) => Promise<unknown>;
    json: (res: unknown, status: number, body: unknown, origin: string) => void;
    tooLarge: (res: unknown, origin: string) => void;
    readState: RuntimeDependencies['readState'];
    writeState: RuntimeDependencies['writeState'];
    clear: RuntimeDependencies['clear'];
  }): Promise<boolean>;
};

let tempRoot = '';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadRuntime(name: string): Promise<TaskBoxRuntime> {
  const dir = path.join(tempRoot, name);
  await fs.mkdir(dir, { recursive: true });
  const [serviceTs, wrapper] = await Promise.all([
    fs.readFile(clearSource, 'utf8'),
    fs.readFile(runtimeSource, 'utf8')
  ]);
  expect(serviceTs.length).toBeGreaterThan(0);
  await execFileAsync(process.execPath, [
    tsc,
    clearSource,
    '--ignoreConfig',
    '--target', 'ES2023',
    '--module', 'commonjs',
    '--strict',
    '--skipLibCheck',
    '--outDir', dir
  ]);
  await fs.rename(path.join(dir, 'clear-service.js'), path.join(dir, 'clear-service.cjs'));
  await fs.writeFile(path.join(dir, 'index.cjs'), wrapper, 'utf8');
  const localRequire = createRequire(import.meta.url);
  return localRequire(path.join(dir, 'index.cjs')) as TaskBoxRuntime;
}

function stateHarness(options: { clear?: () => Promise<void> } = {}) {
  let durable: unknown | null = null;
  let readFailure: Error | null = null;
  const readState = vi.fn(async () => {
    if (readFailure) throw readFailure;
    return clone(durable);
  });
  const writeState = vi.fn(async (value: unknown) => {
    durable = clone(value);
  });
  const clear = vi.fn(options.clear ?? (async () => {}));
  return {
    deps: { readState, writeState, clear } satisfies RuntimeDependencies,
    readState,
    writeState,
    clear,
    durable: () => clone(durable),
    setDurable: (value: unknown | null) => { durable = clone(value); },
    failReads: (error: Error | null) => { readFailure = error; }
  };
}

async function invoke(
  runtime: TaskBoxRuntime,
  deps: RuntimeDependencies,
  method: string,
  requestPath: string,
  body?: unknown,
  options: { bodyError?: Error; jsonError?: Error } = {}
): Promise<{ handled: boolean; response: ResponseRecord | null }> {
  const url = new URL(requestPath, 'http://127.0.0.1');
  const req = { method, body, ...(options.bodyError ? { bodyError: options.bodyError } : {}) };
  let response: ResponseRecord | null = null;
  const handled = await runtime.handleTaskBox({
    req,
    res: {},
    url,
    origin,
    route: url.pathname,
    readBody: async input => {
      if (input.bodyError) throw input.bodyError;
      return input.body;
    },
    json: (_res, status, payload, responseOrigin) => {
      response = { status, body: clone(payload), origin: responseOrigin };
      if (options.jsonError) throw options.jsonError;
    },
    tooLarge: (_res, responseOrigin) => {
      response = { status: 413, body: null, origin: responseOrigin, tooLarge: true };
    },
    ...deps
  });
  return { handled, response };
}

beforeEach(async () => {
  tempRoot = await makeTempDir('task-box-runtime-addon-');
});

afterEach(async () => {
  await removeTempDir(tempRoot);
});

describe('patcher-owned TASK BOX runtime addon', () => {
  it('ships a self-contained wrapper and the exact current Clear service source', async () => {
    const [canonical, wrapper] = await Promise.all([
      fs.readFile(clearSource),
      fs.readFile(runtimeSource, 'utf8')
    ]);
    // Verified service extracted without a logic change. Do not depend on private Git history.
    expect(createHash('sha256').update(canonical).digest('hex')).toBe('af69ab0a7fd9b4c5b04c94013f0af48ec835d5b4479c13eea56a81ec39a2246e');
    expect([...wrapper.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1])).toEqual(['./clear-service.cjs']);
    expect(wrapper).not.toMatch(/electron|src\/main|server\.js/i);
  });

  it('returns false for unsupported routes and exact protocol-1 capability without touching state', async () => {
    const runtime = await loadRuntime('capability');
    const h = stateHarness();
    expect(await invoke(runtime, h.deps, 'GET', '/task-box/not-supported')).toEqual({ handled: false, response: null });
    const cap = await invoke(runtime, h.deps, 'GET', '/task-box/capabilities');
    expect(cap).toEqual({
      handled: true,
      response: {
        status: 200,
        origin,
        body: { protocol: 1, supported: true, atMostOnce: true, durableReceipts: true }
      }
    });
    expect(h.readState).not.toHaveBeenCalled();
    expect(h.writeState).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('joins concurrent duplicate requests onto one official Clear and one receipt', async () => {
    const runtime = await loadRuntime('concurrent');
    const gate = deferred();
    const h = stateHarness({ clear: () => gate.promise });
    const first = invoke(runtime, h.deps, 'POST', '/task-box/clear', { owner: ownerA, requestId: requestA });
    const duplicate = invoke(runtime, h.deps, 'POST', '/task-box/clear', { owner: ownerA, requestId: requestA });
    await vi.waitFor(() => expect(h.clear).toHaveBeenCalledTimes(1));
    expect((h.durable() as any).busy).toMatchObject({ state: 'pending', requestId: requestA, owner: ownerA });

    gate.resolve();
    const [a, b] = await Promise.all([first, duplicate]);
    expect(a.response).toEqual({ status: 200, origin, body: { protocol: 1, ok: true, status: 'completed', requestId: requestA } });
    expect(b.response).toEqual(a.response);
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect((h.durable() as any).busy).toBeNull();
    expect((h.durable() as any).receipts[requestA]).toMatchObject({ protocol: 1, state: 'completed', owner: ownerA });
  });

  it('keeps an uncertain Clear fenced across addon restart and never reexecutes it', async () => {
    const firstRuntime = await loadRuntime('uncertain-before-restart');
    const h = stateHarness({ clear: async () => { throw new Error('official clear outcome uncertain'); } });
    const first = await invoke(firstRuntime, h.deps, 'POST', '/task-box/clear', { owner: ownerA, requestId: requestA });
    expect(first.response).toEqual({
      status: 409,
      origin,
      body: { protocol: 1, ok: false, status: 'incomplete', requestId: requestA, reason: 'clear_uncertain' }
    });
    expect((h.durable() as any).busy).toMatchObject({ state: 'uncertain', requestId: requestA, owner: ownerA });

    const restartedRuntime = await loadRuntime('uncertain-after-restart');
    const status = await invoke(
      restartedRuntime,
      h.deps,
      'GET',
      `/task-box/clear/status?requestId=${requestA}&tabId=${ownerA.tabId}&documentId=${ownerA.documentId}`
    );
    expect(status.response).toEqual({
      status: 409,
      origin,
      body: { protocol: 1, ok: false, status: 'incomplete', requestId: requestA, reason: 'uncertain' }
    });
    const replay = await invoke(restartedRuntime, h.deps, 'POST', '/task-box/clear', { owner: ownerA, requestId: requestA });
    expect(replay.response).toEqual(status.response);
    expect(h.clear).toHaveBeenCalledTimes(1);
  });

  it('surfaces strict corrupt and literal-null store failures instead of treating them as absence', async () => {
    const runtime = await loadRuntime('strict-store');
    const h = stateHarness();
    h.failReads(new SyntaxError('corrupt durable JSON'));
    await expect(invoke(runtime, h.deps, 'POST', '/task-box/clear', { owner: ownerA, requestId: requestA }))
      .rejects.toThrow('corrupt durable JSON');
    h.failReads(new Error('durable_state_invalid'));
    await expect(invoke(runtime, h.deps, 'POST', '/task-box/clear', { owner: ownerA, requestId: requestA }))
      .rejects.toThrow('durable_state_invalid');
    expect(h.writeState).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('preserves exact owner scoping for durable completed receipts', async () => {
    const runtime = await loadRuntime('owner');
    const h = stateHarness();
    const completed = await invoke(runtime, h.deps, 'POST', '/task-box/clear', { owner: ownerA, requestId: requestA });
    expect(completed.response).toMatchObject({ status: 200, body: { protocol: 1, ok: true, status: 'completed' } });

    const wrongStatus = await invoke(
      runtime,
      h.deps,
      'GET',
      `/task-box/clear/status?requestId=${requestA}&tabId=${ownerB.tabId}&documentId=${ownerB.documentId}`
    );
    expect(wrongStatus.response).toEqual({
      status: 409,
      origin,
      body: { protocol: 1, ok: false, status: 'owner_mismatch', requestId: requestA }
    });
    const wrongReplay = await invoke(runtime, h.deps, 'POST', '/task-box/clear', { owner: ownerB, requestId: requestA });
    expect(wrongReplay.response).toEqual(wrongStatus.response);
    expect(h.clear).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed methods, bodies, owners, query strings and oversized bodies before Clear', async () => {
    const runtime = await loadRuntime('malformed');
    const h = stateHarness();
    const malformedBodies = [
      null,
      [],
      { owner: ownerA, requestId: 'bad' },
      { owner: { ...ownerA, tabId: -1 }, requestId: requestA },
      { owner: { ...ownerA, documentId: '' }, requestId: requestA },
      { owner: { ...ownerA, documentId: 'x'.repeat(257) }, requestId: requestA },
      { owner: { ...ownerA, extra: true }, requestId: requestA },
      { owner: ownerA, requestId: requestA, command: 'anything' }
    ];
    for (const body of malformedBodies) {
      const result = await invoke(runtime, h.deps, 'POST', '/task-box/clear', body);
      expect(result.handled).toBe(true);
      expect(result.response).toEqual({ status: 400, origin, body: { ok: false, error: 'invalid_task_box_request' } });
    }

    const duplicateQuery = await invoke(
      runtime,
      h.deps,
      'GET',
      `/task-box/clear/status?requestId=${requestA}&tabId=7&documentId=doc-a&requestId=${requestB}`
    );
    expect(duplicateQuery.response).toEqual({ status: 400, origin, body: { ok: false, error: 'invalid_task_box_request' } });
    expect((await invoke(runtime, h.deps, 'GET', '/task-box/clear')).response)
      .toEqual({ status: 405, origin, body: { ok: false, error: 'method_not_allowed' } });
    expect((await invoke(runtime, h.deps, 'POST', `/task-box/clear/status?requestId=${requestA}&tabId=7&documentId=doc-a`)).response)
      .toEqual({ status: 405, origin, body: { ok: false, error: 'method_not_allowed' } });
    const oversized = await invoke(
      runtime,
      h.deps,
      'POST',
      '/task-box/clear',
      undefined,
      { bodyError: new Error('body_too_large') }
    );
    expect(oversized).toEqual({ handled: true, response: { status: 413, origin, body: null, tooLarge: true } });
    expect(h.readState).not.toHaveBeenCalled();
    expect(h.writeState).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('recovers a lost POST response through status without issuing a second Clear', async () => {
    const runtime = await loadRuntime('lost-response');
    const h = stateHarness();
    await expect(invoke(
      runtime,
      h.deps,
      'POST',
      '/task-box/clear',
      { owner: ownerA, requestId: requestA },
      { jsonError: new Error('response socket disappeared') }
    )).rejects.toThrow('response socket disappeared');
    expect(h.clear).toHaveBeenCalledTimes(1);

    const status = await invoke(
      runtime,
      h.deps,
      'GET',
      `/task-box/clear/status?requestId=${requestA}&tabId=${ownerA.tabId}&documentId=${ownerA.documentId}`
    );
    expect(status.response).toEqual({
      status: 200,
      origin,
      body: { protocol: 1, ok: true, status: 'completed', requestId: requestA }
    });
    const duplicate = await invoke(runtime, h.deps, 'POST', '/task-box/clear', { owner: ownerA, requestId: requestA });
    expect(duplicate.response).toEqual(status.response);
    expect(h.clear).toHaveBeenCalledTimes(1);
  });

  it('fails closed if a caller tries to replace process-lifetime Clear dependencies', async () => {
    const runtime = await loadRuntime('stable-dependencies');
    const h = stateHarness();
    await invoke(runtime, h.deps, 'GET', '/task-box/capabilities');
    const replacement = stateHarness();
    await expect(invoke(runtime, replacement.deps, 'POST', '/task-box/clear', { owner: ownerA, requestId: requestA }))
      .rejects.toThrow('task_box_runtime_dependencies_changed');
    expect(h.clear).not.toHaveBeenCalled();
    expect(replacement.clear).not.toHaveBeenCalled();
  });
});
