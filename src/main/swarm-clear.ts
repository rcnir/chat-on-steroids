import { persistAgentAuthorityNow, resetSwarm, swarmState } from './agents.js';
import type { SwarmState } from '../shared/session.js';

let inFlight: Promise<SwarmState> | null = null;

/** The same official Clear operation for the app UI and authenticated companion. No UI automation. */
export function clearSwarmDurably(): Promise<SwarmState> {
  if (!inFlight) {
    inFlight = (async () => {
      resetSwarm();
      if (!(await persistAgentAuthorityNow())) {
        throw new Error('The cleared run could not be made durable.');
      }
      return swarmState();
    })().finally(() => { inFlight = null; });
  }
  return inFlight;
}
