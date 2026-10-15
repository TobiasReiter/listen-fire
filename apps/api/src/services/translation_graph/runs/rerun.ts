// Re-run a recorded firing from its trigger_run row. Loads the run,
// reconstructs the inbound trigger event from `trigger_payload`, and
// re-dispatches it through the firing dispatcher
// (`dispatchTriggerByIdEvent`) — which records a fresh trigger_run.
//
// trigger_run keys on the real `trigger_id` (the automation that fired),
// so the re-run is a clean replay of the same firing against the current
// orchestration. The old pipeline_input/output-keyed re-run is gone with
// tg_run.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TriggerRunTriggerType } from './trigger_run';

import { getAutomationsQb, getQb } from '../../../lib/kysely';
import { triggerEventSchema, type TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { dispatchTriggerByIdEvent } from '../triggers/router';


export async function rerunTriggerRun(input: {
  runId: TriggerRunId;
  teamId: TeamId;
  /**
   * When true the re-run executes in dry-run mode — target writes are
   * intercepted and replaced with synthesized placeholders, no
   * linked_object bridges are written, and no mutation events are
   * dispatched downstream. See engine/dry_run_adapter.ts.
   */
  dryRun?: boolean;
}): Promise<{ runId: TriggerRunId; triggerType: TriggerRunTriggerType }> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', input.runId)
    .where('team_id', '=', input.teamId)
    .select(['trigger_id', 'trigger_type', 'trigger_payload'])
    .executeTakeFirst();
  if (!row) {
    throw new Error(`trigger_run ${input.runId} not found`);
  }
  if (!row.trigger_payload) {
    throw new Error(`trigger_run ${input.runId} has no trigger_payload — cannot re-run`);
  }

  // W3-B1 — schema enforces UUID shape; cast lifts the brand.
  const triggerEvent = triggerEventSchema.parse(row.trigger_payload) as TriggerEvent;
  const triggerType = row.trigger_type as TriggerRunTriggerType;

  await dispatchTriggerByIdEvent({
    triggerId: row.trigger_id,
    event: triggerEvent,
    teamId: input.teamId,
    recordingTriggerType: triggerType,
    dryRun: input.dryRun,
  });

  return { runId: input.runId, triggerType };
}
