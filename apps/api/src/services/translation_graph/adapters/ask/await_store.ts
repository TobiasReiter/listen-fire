// The ask adapter's slice of the GENERIC correlation map (`adapter_await`, rows
// with `adapter_type='ask'`). The engine writes and drops the rows itself
// (`await_correlation.ts`); what is ask-SPECIFIC and lives here is RESOLVABILITY:
// an ask await resolves when its ask record SETTLES (answered / expired), which
// the resume drain reads by joining the correlation rows to `ask.state`. An
// answer wakes its awaiters through the settle notifier; an expiry has no door
// of its own, so the expiry sweep finds it here. Correlation, NOT stability —
// the ask id IS the identity, stored as the row's `correlation_key`.

import { getAsksQb, getAutomationsQb, getQb } from '../../../../lib/kysely';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { AskId } from '../../../../generated/kysely/asks/Ask';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';
import { dropAwaitCorrelation, type ResolvableAwait } from '../await_correlation';
import { ASK_ADAPTER_TYPE } from './type';
import { cancelAsk } from './store';

/**
 * Withdraw ask await parks that will NEVER be consumed — a race arm that lost,
 * a run that failed, a run stranded by a retired listener — and close the asks
 * behind them.
 *
 * This is the one closing routine every drop-the-parks path calls. Dropping the
 * correlation alone (the older behaviour) left the ask `open`: its link kept
 * rendering a live answer form, took a submission, and told the person "the
 * workflow will continue shortly" — a promise nothing was left to keep. An ask
 * whose asker is gone is closed, so the link renders the already-closed page and
 * a late submission is refused instead of falsely accepted.
 *
 * Order matters: the correlation goes FIRST. `loadResolvableAskAwaits` treats a
 * settled ask as a resolvable leaf, so closing the ask while its correlation
 * still stands would hand the resume worker the very park we are withdrawing.
 *
 * An ask that raced us to `answered` (the race WINNER, whose answer is what
 * settled the frame) stays answered — `cancelAsk`'s `WHERE state = 'open'` guard
 * makes that a no-op, which is why this is safe to call over a whole subtree.
 */
export async function abandonAskAwaits(input: {
  runId: TriggerRunId;
  /** The parks to withdraw. Omit to withdraw EVERY ask park of the run. */
  addresses?: string[];
}): Promise<void> {
  if (input.addresses !== undefined && input.addresses.length === 0) return;

  let corr = getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('adapter_type', '=', ASK_ADAPTER_TYPE)
    .where('run_id', '=', input.runId);
  if (input.addresses !== undefined) {
    corr = corr.where('address', 'in', input.addresses);
  }
  const rows = await corr.select(['address', 'correlation_key']).execute();
  if (rows.length === 0) return;

  for (const row of rows) {
    await dropAwaitCorrelation({ runId: input.runId, address: row.address });
  }
  for (const askId of new Set(rows.map((r) => r.correlation_key))) {
    await cancelAsk({ id: askId as AskId });
  }
}

/** One resolvable ask await park: an `adapter_await` row (ask) whose ask has
 *  SETTLED (answered / expired), so the engine can drive its run forward. */
export type ResolvableAskAwait = ResolvableAwait;

/**
 * Every ask await park whose ask has SETTLED — the ask half of the resume
 * worker's scan. An OPEN ask's parks are excluded (still waiting); a dropped
 * correlation (run death) has no row. Pass `runId` to scope to ONE run — the
 * single-flight drain's authoritative per-run batch load (all of a run's
 * currently-resolvable ask leaves in one query, so a multi-winner tie settles
 * together — F18/F21).
 */
export async function loadResolvableAskAwaits(
  opts: { runId?: TriggerRunId } = {},
): Promise<ResolvableAskAwait[]> {
  // The correlation_key holds the ask id as opaque text on the generic map, so
  // resolvability is a second read against `ask.state` rather than a cross-type
  // SQL join: load this adapter's rows, then keep the ones whose ask has settled.
  let corr = getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('adapter_type', '=', ASK_ADAPTER_TYPE);
  if (opts.runId !== undefined) {
    corr = corr.where('run_id', '=', opts.runId);
  }
  const rows = await corr
    .select(['run_id', 'team_id', 'address', 'correlation_key'])
    .execute();
  if (rows.length === 0) return [];

  const askIds = [...new Set(rows.map((r) => r.correlation_key))] as AskId[];
  const settled = await getAsksQb(['ask'])
    .selectFrom('ask')
    .where('id', 'in', askIds)
    .where('state', 'in', ['answered', 'expired'])
    .select('id')
    .execute();
  const settledIds = new Set<string>(settled.map((s) => s.id));

  return rows
    .filter((r) => settledIds.has(r.correlation_key))
    // `adapter_await.team_id` is an opaque tenant uuid (D3 dropped the FK, and
    // with it the brand); naming it as core's team id is the boundary conversion.
    .map((r) => ({ runId: r.run_id, teamId: r.team_id as TeamId, address: r.address }));
}

/**
 * Every EXPIRED ask that a run is still parked on — what the expiry sweep wakes.
 * The correlation row is the "not yet woken" marker: a resumed await drops it,
 * so an ask drops out of this read once its wake has run, and a sweep that
 * overlaps an earlier one's pending wake finds the same asks and coalesces onto
 * the same rows. No timestamp is kept between sweeps, so a missed sweep loses
 * nothing.
 */
export async function loadExpiredAskAwaits(): Promise<Array<{ teamId: TeamId; askId: AskId }>> {
  const rows = await getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('adapter_type', '=', ASK_ADAPTER_TYPE)
    .select('correlation_key')
    .distinct()
    .execute();
  if (rows.length === 0) return [];

  const expired = await getAsksQb(['ask'])
    .selectFrom('ask')
    .where('id', 'in', rows.map((r) => r.correlation_key) as AskId[])
    .where('state', '=', 'expired')
    .select(['id', 'team_id'])
    .execute();
  return expired.map((a) => ({ teamId: a.team_id as TeamId, askId: a.id }));
}
