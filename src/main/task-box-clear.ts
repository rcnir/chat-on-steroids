export interface TaskBoxClearOwner {
  tabId: number;
  documentId: string;
}

export type TaskBoxClearStatus =
  | 'completed'
  | 'incomplete'
  | 'busy'
  | 'unknown_request'
  | 'invalid'
  | 'owner_mismatch'
  | 'state_invalid';

export interface TaskBoxClearResult {
  ok: boolean;
  status: TaskBoxClearStatus;
  requestId: string;
  reason?: string;
}

interface BusyIntent {
  state: 'pending' | 'uncertain';
  requestId: string;
  owner: TaskBoxClearOwner;
}

interface CompletedReceipt {
  protocol: 1;
  state: 'completed';
  requestId: string;
  owner: TaskBoxClearOwner;
}

interface TaskBoxClearSnapshot {
  version: 1;
  busy: BusyIntent | null;
  receipts: Record<string, CompletedReceipt>;
}

export interface TaskBoxClearDependencies {
  /** Reads the one durable TASK BOX Clear control snapshot. */
  read: () => Promise<unknown | null>;
  /** Immediate durable barrier. The side effect may run only after this resolves. */
  write: (snapshot: TaskBoxClearSnapshot) => Promise<void>;
  /**
   * The host wraps the official resetSwarm() + persistAgentAuthorityNow() transaction here.
   * Resolution means the official Clear mutation and its authority durability both completed.
   */
  clear: () => Promise<void>;
}

export interface TaskBoxClearService {
  capability(): Readonly<{ protocol: 1; supported: true; atMostOnce: true; durableReceipts: true }>;
  request(owner: TaskBoxClearOwner, requestId: string): Promise<TaskBoxClearResult>;
  status(owner: TaskBoxClearOwner, requestId: string): Promise<TaskBoxClearResult>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY = Object.freeze({ protocol: 1, supported: true, atMostOnce: true, durableReceipts: true } as const);

function validOwner(owner: unknown): owner is TaskBoxClearOwner {
  if (!owner || typeof owner !== 'object') return false;
  const value = owner as TaskBoxClearOwner;
  return Number.isInteger(value.tabId) && value.tabId >= 0 &&
    typeof value.documentId === 'string' && value.documentId.length > 0;
}

function sameOwner(left: TaskBoxClearOwner, right: TaskBoxClearOwner): boolean {
  return left.tabId === right.tabId && left.documentId === right.documentId;
}

function validRequestId(requestId: unknown): requestId is string {
  return typeof requestId === 'string' && UUID_RE.test(requestId);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validBusy(value: unknown): value is BusyIntent {
  if (!plainRecord(value) || !exactKeys(value, ['state', 'requestId', 'owner'])) return false;
  return (value.state === 'pending' || value.state === 'uncertain') &&
    validRequestId(value.requestId) && validOwner(value.owner);
}

function validReceipt(value: unknown, key: string): value is CompletedReceipt {
  if (!plainRecord(value) || !exactKeys(value, ['protocol', 'state', 'requestId', 'owner'])) return false;
  return value.protocol === 1 && value.state === 'completed' && value.requestId === key &&
    validRequestId(value.requestId) && validOwner(value.owner);
}

function parseSnapshot(value: unknown | null): TaskBoxClearSnapshot | null {
  if (value === null) return { version: 1, busy: null, receipts: {} };
  if (!plainRecord(value) || !exactKeys(value, ['version', 'busy', 'receipts']) || value.version !== 1) return null;
  if (value.busy !== null && !validBusy(value.busy)) return null;
  if (!plainRecord(value.receipts)) return null;
  const receipts: Record<string, CompletedReceipt> = {};
  for (const [requestId, receipt] of Object.entries(value.receipts)) {
    if (!validRequestId(requestId) || !validReceipt(receipt, requestId)) return null;
    receipts[requestId] = receipt;
  }
  if (value.busy && receipts[value.busy.requestId]) return null;
  return { version: 1, busy: value.busy, receipts };
}

function cloneOwner(owner: TaskBoxClearOwner): TaskBoxClearOwner {
  return { tabId: owner.tabId, documentId: owner.documentId };
}

export function createTaskBoxClearService(deps: TaskBoxClearDependencies): TaskBoxClearService {
  if (!deps || typeof deps.read !== 'function' || typeof deps.write !== 'function' || typeof deps.clear !== 'function') {
    throw new TypeError('task box clear dependencies are required');
  }

  let stateQueue: Promise<void> = Promise.resolve();
  const inFlight = new Map<string, { owner: TaskBoxClearOwner; promise: Promise<TaskBoxClearResult> }>();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = stateQueue.then(operation, operation);
    stateQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readState(): Promise<TaskBoxClearSnapshot | null> {
    return parseSnapshot(await deps.read());
  }

  async function lookup(owner: TaskBoxClearOwner, requestId: string): Promise<TaskBoxClearResult> {
    if (!validOwner(owner) || !validRequestId(requestId)) return { ok: false, status: 'invalid', requestId };
    const state = await readState();
    if (!state) return { ok: false, status: 'state_invalid', requestId };
    const receipt = state.receipts[requestId];
    if (receipt) {
      return sameOwner(receipt.owner, owner)
        ? { ok: true, status: 'completed', requestId }
        : { ok: false, status: 'owner_mismatch', requestId };
    }
    if (state.busy?.requestId === requestId) {
      return sameOwner(state.busy.owner, owner)
        ? { ok: false, status: 'incomplete', requestId, reason: state.busy.state }
        : { ok: false, status: 'owner_mismatch', requestId };
    }
    return { ok: false, status: 'unknown_request', requestId };
  }

  async function begin(owner: TaskBoxClearOwner, requestId: string): Promise<TaskBoxClearResult | 'execute'> {
    const state = await readState();
    if (!state) return { ok: false, status: 'state_invalid', requestId };
    const receipt = state.receipts[requestId];
    if (receipt) {
      return sameOwner(receipt.owner, owner)
        ? { ok: true, status: 'completed', requestId }
        : { ok: false, status: 'owner_mismatch', requestId };
    }
    if (state.busy) {
      if (state.busy.requestId === requestId) {
        return sameOwner(state.busy.owner, owner)
          ? { ok: false, status: 'incomplete', requestId, reason: state.busy.state }
          : { ok: false, status: 'owner_mismatch', requestId };
      }
      return { ok: false, status: 'busy', requestId };
    }

    const next: TaskBoxClearSnapshot = {
      version: 1,
      busy: { state: 'pending', requestId, owner: cloneOwner(owner) },
      receipts: state.receipts
    };
    try {
      await deps.write(next);
    } catch {
      return { ok: false, status: 'incomplete', requestId, reason: 'intent_write_failed' };
    }
    return 'execute';
  }

  async function markUncertain(owner: TaskBoxClearOwner, requestId: string): Promise<void> {
    try {
      await serialize(async () => {
        const state = await readState();
        if (!state || !state.busy || state.busy.requestId !== requestId || !sameOwner(state.busy.owner, owner)) return;
        if (state.busy.state === 'uncertain') return;
        await deps.write({
          version: 1,
          busy: { ...state.busy, state: 'uncertain' },
          receipts: state.receipts
        });
      });
    } catch {
      // The already-durable pending intent remains a permanent replay fence if this write fails.
    }
  }

  async function complete(owner: TaskBoxClearOwner, requestId: string): Promise<TaskBoxClearResult> {
    return serialize(async () => {
      const state = await readState();
      if (!state) return { ok: false, status: 'state_invalid', requestId };
      const receipt = state.receipts[requestId];
      if (receipt) {
        return sameOwner(receipt.owner, owner)
          ? { ok: true, status: 'completed', requestId }
          : { ok: false, status: 'owner_mismatch', requestId };
      }
      if (!state.busy || state.busy.requestId !== requestId || !sameOwner(state.busy.owner, owner)) {
        return { ok: false, status: 'incomplete', requestId, reason: 'intent_lost' };
      }
      const completed: CompletedReceipt = { protocol: 1, state: 'completed', requestId, owner: cloneOwner(owner) };
      try {
        await deps.write({
          version: 1,
          busy: null,
          receipts: { ...state.receipts, [requestId]: completed }
        });
      } catch {
        // A rejected barrier can still mean the atomic write reached disk and only its reply was
        // lost. Re-read before classifying the post-Clear outcome. If the receipt is absent, keep
        // the already-durable intent locked and strengthen it to uncertain where possible.
        try {
          const after = await readState();
          const durableReceipt = after?.receipts[requestId];
          if (durableReceipt && sameOwner(durableReceipt.owner, owner)) {
            return { ok: true, status: 'completed', requestId };
          }
          if (after?.busy?.requestId === requestId && sameOwner(after.busy.owner, owner)) {
            try {
              await deps.write({
                version: 1,
                busy: { ...after.busy, state: 'uncertain' },
                receipts: after.receipts
              });
            } catch {
              // The prior pending intent still fences replay even if this strengthening fails.
            }
          }
        } catch {
          // An unreadable post-Clear state is itself ambiguous; never clear the intent in memory.
        }
        return { ok: false, status: 'incomplete', requestId, reason: 'receipt_write_failed' };
      }
      return { ok: true, status: 'completed', requestId };
    });
  }

  async function execute(owner: TaskBoxClearOwner, requestId: string): Promise<TaskBoxClearResult> {
    const start = await serialize(() => begin(owner, requestId));
    if (start !== 'execute') return start;
    try {
      await deps.clear();
    } catch {
      await markUncertain(owner, requestId);
      return { ok: false, status: 'incomplete', requestId, reason: 'clear_uncertain' };
    }
    return complete(owner, requestId);
  }

  function request(owner: TaskBoxClearOwner, requestId: string): Promise<TaskBoxClearResult> {
    if (!validOwner(owner) || !validRequestId(requestId)) {
      return Promise.resolve({ ok: false, status: 'invalid', requestId });
    }
    const active = inFlight.get(requestId);
    if (active) {
      return sameOwner(active.owner, owner)
        ? active.promise
        : Promise.resolve({ ok: false, status: 'owner_mismatch', requestId });
    }
    const promise = execute(cloneOwner(owner), requestId).finally(() => {
      if (inFlight.get(requestId)?.promise === promise) inFlight.delete(requestId);
    });
    inFlight.set(requestId, { owner: cloneOwner(owner), promise });
    return promise;
  }

  return {
    capability: () => CAPABILITY,
    request,
    status: (owner, requestId) => serialize(() => lookup(owner, requestId))
  };
}
