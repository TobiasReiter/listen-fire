import { logger } from '../logger';
import { awaitTeamWorkSettled } from './store';

const HARNESS_SETTLE_TIMEOUT_MS = 30_000;

/** The test-harness doors answer only once their rows ran. The door's own drain
 *  skips a row another drainer already claimed, so it also waits for those. */
export async function awaitHarnessWorkSettled(teamIds: string[]): Promise<void> {
  for (const teamId of teamIds) {
    const settled = await awaitTeamWorkSettled({ teamId, timeoutMs: HARNESS_SETTLE_TIMEOUT_MS });
    if (!settled) {
      logger.warn('[work] harness door answered before its rows settled', { teamId });
    }
  }
}
