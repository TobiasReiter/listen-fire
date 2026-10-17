// The test-harness doors answer a delivery only once its rows ran, so the dev
// loop and the eval harness see settled runs in the response. A production
// door never waits.
import { logger } from 'movement-engine/public/log';
import { drainUntilIdle } from './drain';
import { awaitTeamWorkSettled } from './store';

const HARNESS_SETTLE_TIMEOUT_MS = 30_000;

/** Which teams' rows were still due or leased when the wait gave up. */
export interface SettleReport {
  unsettledTeamIds: ReadonlySet<string>;
  /** The per-event error a door reports for a receipt such a team left unrun. */
  unsettledError: string;
}

/** What a door's enqueue step hands back for the harness sequence. */
export interface HarnessDelivery<T> {
  /** The teams whose rows were queued — what the sequence waits on. */
  teamIds: string[];
  readOutcome(settle: SettleReport): Promise<T>;
}

/** Wait for each team's rows to settle. The door's own drain skips a row
 *  another drainer already claimed, so it also waits for those. */
export async function awaitHarnessWorkSettled(
  teamIds: string[],
  opts: { timeoutMs?: number } = {},
): Promise<SettleReport> {
  const timeoutMs = opts.timeoutMs ?? HARNESS_SETTLE_TIMEOUT_MS;
  const unsettledTeamIds = new Set<string>();
  for (const teamId of teamIds) {
    if (!(await awaitTeamWorkSettled({ teamId, timeoutMs }))) {
      logger.warn('[work] harness door answering before its rows settled', { teamId });
      unsettledTeamIds.add(teamId);
    }
  }
  return {
    unsettledTeamIds,
    unsettledError: `not settled within ${Math.round(timeoutMs / 1000)}s`,
  };
}

/** The harness sequence both waiting doors run: enqueue → drain → settle → read.
 *  The drain is each delivering team's own: a harness door must not fire other
 *  tenants' due rows (their cron, their timers) on its request. */
export async function runHarnessDelivery<T>(
  enqueue: () => Promise<HarnessDelivery<T>>,
  opts: { settleTimeoutMs?: number } = {},
): Promise<T> {
  const enqueued = await enqueue();
  const teamIds = [...new Set(enqueued.teamIds)];
  await Promise.all(teamIds.map((teamId) => drainUntilIdle({ owner: 'door', teamId })));
  const settle = await awaitHarnessWorkSettled(enqueued.teamIds, {
    ...(opts.settleTimeoutMs !== undefined ? { timeoutMs: opts.settleTimeoutMs } : {}),
  });
  return enqueued.readOutcome(settle);
}
