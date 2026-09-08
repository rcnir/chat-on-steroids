import { createTaskBoxClearService } from './task-box-clear.js';
import { durableStoreReady, readDurableStrict, writeDurableNow } from './durable.js';
import { clearSwarmDurably } from './swarm-clear.js';

const STATE = 'task-box-clear';
let service: ReturnType<typeof createTaskBoxClearService> | null = null;

export function taskBoxClearService(): ReturnType<typeof createTaskBoxClearService> {
  if (!durableStoreReady()) throw new Error('durable_store_not_ready');
  service ??= createTaskBoxClearService({
    read: () => readDurableStrict(STATE),
    write: snapshot => writeDurableNow(STATE, snapshot),
    clear: async () => { await clearSwarmDurably(); }
  });
  return service;
}

/** Isolated test store teardown only; production never discards a pending Clear receipt. */
export function resetTaskBoxClearRuntimeForTests(): void { service = null; }
