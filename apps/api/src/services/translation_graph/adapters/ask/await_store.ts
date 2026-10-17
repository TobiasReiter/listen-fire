// The ask adapter's slice of the GENERIC correlation map (`adapter_await`, rows
// with `adapter_type='ask'`). The engine writes and drops the rows itself
// (`await_correlation.ts`); what is ask-SPECIFIC and lives here is RESOLVABILITY:
// an ask await resolves when its ask record SETTLES (answered / expired), which
// the resume drain reads by joining the correlation rows to `ask.state`. An
// answer and a cancel each wake their awaiters at their own door; the closed
// sweep reads here for the parks a lost wake left behind. Correlation, NOT
// stability — the ask id IS the identity, stored as the row's `correlation_key`.

import type { AskId } from '../../../../generated/kysely/asks/Ask';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';
import type { CorrelatedAwait } from 'movement-engine/public/run-host';

import { getAsksQb, getAutomationsQb } from '../../../../lib/kysely';
import { postgresRunHostStore } from '../../../movement_engine/run_host_store';
import { ASK_ADAPTER_TYPE } from './type';
import { askIdSchema, cancelAsk } from './store';

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
  addresses?: readonly string[];
}): Promise<void> {
  if (input.addresses !== undefined && input.addresses.length === 0) return;

  let corr = getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('adapter_type', '=', ASK_ADAPTER_TYPE)
    .where('run_id', '=', input.runId);
  if (input.addresses !== undefined) {
    corr = corr.where('address', 'in', [...input.addresses]);
  }
  const rows = await corr.select(['address', 'correlation_key']).execute();
  if (rows.length === 0) return;

  for (const row of rows) {
    await postgresRunHostStore.correlations.drop({ runId: input.runId, address: row.address });
  }
  for (const askId of new Set(rows.map((r) => r.correlation_key))) {
    await cancelAsk({ id: askId as AskId });
  }
}

/** One resolvable ask await park: an `adapter_await` row (ask) whose ask has
 *  SETTLED (answered / expired), so the engine can drive its run forward. */
export type ResolvableAskAwait = CorrelatedAwait;

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
    .map((r) => ({ runId: r.run_id, teamId: r.team_id, address: r.address }));
}

/** One page of the closed sweep: the wakes it found, and where the next page
 *  starts (absent on the last page). */
export interface ClosedAskAwaitPage {
  wakes: Array<{ teamId: string; askId: AskId }>;
  next?: string;
}

/**
 * One page of CLOSED asks (anything but `open`) that a run is still parked on —
 * what the closed sweep wakes. Paged over the correlation rows, keyed and
 * ordered by ask id, so each read is bounded however many runs are parked on
 * open asks. The team comes from the correlation row: it is the tenant the
 * park, and so the wake, belongs to.
 *
 * The correlation row is the "not yet woken" marker: a resumed await drops it,
 * so an ask drops out of this read once its wake has run. No timestamp is kept
 * between sweeps, so a missed sweep loses nothing.
 */
export async function loadClosedAskAwaitPage(
  opts: { after?: string; limit: number },
): Promise<ClosedAskAwaitPage> {
  let corr = getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('adapter_type', '=', ASK_ADAPTER_TYPE);
  if (opts.after !== undefined) corr = corr.where('correlation_key', '>', opts.after);
  const rows = await corr
    .select(['team_id', 'correlation_key'])
    .distinct()
    .orderBy('correlation_key')
    .limit(opts.limit)
    .execute();
  const last = rows[rows.length - 1];
  const next = rows.length === opts.limit && last !== undefined ? { next: last.correlation_key } : {};

  const parked = rows.flatMap((r) => {
    const askId = askIdSchema.safeParse(r.correlation_key);
    return askId.success ? [{ teamId: r.team_id, askId: askId.data }] : [];
  });
  if (parked.length === 0) return { wakes: [], ...next };

  const closed = await getAsksQb(['ask'])
    .selectFrom('ask')
    .where('id', 'in', parked.map((p) => p.askId))
    .where('state', '!=', 'open')
    .select('id')
    .execute();
  const closedIds = new Set<string>(closed.map((a) => a.id));
  return { wakes: parked.filter((p) => closedIds.has(p.askId)), ...next };
}
