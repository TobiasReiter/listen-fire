// The run lease as a fence on the rows a holder writes. A holder whose lease
// lapsed may still be mid-statement when another instance takes the run; its
// writes to the run's live state must then change nothing. Each such write
// names the token it holds the lease under and lands only while the run's
// lease is still that token's (run_lease.ts).

import type { ExpressionBuilder } from 'kysely';

import type AutomationsSchema from '../../generated/kysely/automations/AutomationsSchema';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb } from '../../lib/kysely';
import { clearJoins } from './join_pending';

type ParkedRunScope = ExpressionBuilder<Pick<AutomationsSchema, 'parked_run' | 'trigger_run'>, 'parked_run'>;

/** A `parked_run` predicate: the row's run is still leased under `token`. */
export function runLeasedTo(token: string) {
  return (eb: ParkedRunScope) =>
    eb.exists(
      eb
        .selectFrom('trigger_run')
        .select('trigger_run.id')
        .whereRef('trigger_run.id', '=', 'parked_run.run_id')
        .where('trigger_run.lease_token', '=', token),
    );
}

/** Drop a run's live state, every leaf and every join, as a run that has
 *  settled or failed leaves it. Given the lease, only while the run is still
 *  leased under it. */
export async function dropRunLeaves(runId: TriggerRunId, lease?: { token: string }): Promise<void> {
  let leaves = getAutomationsQb(['parked_run', 'trigger_run']).deleteFrom('parked_run').where('run_id', '=', runId);
  if (lease !== undefined) leaves = leaves.where(runLeasedTo(lease.token));
  await leaves.execute();
  await clearJoins(runId, lease !== undefined ? { leaseToken: lease.token } : {});
}
