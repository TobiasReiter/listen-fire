// The hosted product's step for the run-host core's drains: one engine segment
// of a parked run (a leaf resumed, or a race settled with its winners), run
// against the run's PINNED version (P11) and recorded on its trigger_run. The
// drains themselves (which leaves, in what order, what a failure tears down)
// are the core's (run_host/drain.ts).

import { logger } from 'movement-engine/services/logger';
import { triggerEventSchema, type TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { neverAsAny } from 'movement-engine/lib/utils/types';

import type { LanguageVersion } from 'movement-lang';
import type { HeldRunLease } from 'movement-engine/services/run_host/lease';
import type { StepLeaf, StepOutcome } from 'movement-engine/services/run_host/drain';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { TriggerRunTriggerType } from '../translation_graph/runs/trigger_run';

import { getAutomationsQb } from '../../lib/kysely';
import { resumeMovementFiring, type MovementFiringOutcome } from '../translation_graph/movement/execute';
import { loadPinnedVersion } from '../translation_graph/movement/version_store';
import { loadTriggerById } from '../translation_graph/storage/tg_table';

/** Everything a segment needs to re-enter a run: its pinned source (the
 *  stored addresses name THAT AST), its trigger, its inbound event. */
export interface RunContext {
  teamId: TeamId;
  triggerId: string;
  triggerName: string;
  firedMovementName: string | null;
  movementId: string;
  movementVersionId: string;
  pinnedSource: string;
  pinnedLanguageVersion: LanguageVersion;
  event: TriggerEvent;
  triggerType: TriggerRunTriggerType;
}

/** Why a run cannot be re-entered, or its context. */
export async function loadRunContext(runId: TriggerRunId): Promise<RunContext | { unresumable: string }> {
  const run = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select(['team_id', 'trigger_id', 'trigger_type', 'trigger_payload', 'movement_version_id'])
    .executeTakeFirst();
  if (!run || !run.trigger_payload) return { unresumable: 'trigger_run missing or has no payload' };
  const trigger = await loadTriggerById(run.trigger_id);
  if (!trigger || !trigger.movementId) return { unresumable: 'trigger gone or not movement-derived' };
  const pinned = run.movement_version_id ? await loadPinnedVersion(run.movement_version_id) : null;
  if (!run.movement_version_id || !pinned) return { unresumable: 'no pinned movement_version source (P11)' };
  return {
    // `trigger_run.team_id` is an opaque tenant uuid (D3 dropped the FK, and
    // with it the brand); naming it as core's team id is the boundary conversion.
    teamId: run.team_id as TeamId,
    triggerId: run.trigger_id,
    triggerName: trigger.name,
    firedMovementName: trigger.firedMovementName,
    movementId: trigger.movementId,
    movementVersionId: run.movement_version_id,
    pinnedSource: pinned.source,
    pinnedLanguageVersion: pinned.languageVersion,
    event: triggerEventSchema.parse(run.trigger_payload) as TriggerEvent,
    triggerType: run.trigger_type as TriggerRunTriggerType,
  };
}

/** What one segment came to, as the core's drains read it. */
export function stepOutcomeOf(outcome: MovementFiringOutcome): StepOutcome {
  if (outcome.leaseLost === true) return { kind: 'leaseLost' };
  if (outcome.result === null) return { kind: 'failed', error: outcome.error ?? 'the segment failed' };
  const { result } = outcome;
  if (result.cancelled === true) return { kind: 'cancelled', ...(outcome.cancelReason !== undefined ? { reason: outcome.cancelReason } : {}) };
  const deferredRaceFrames = result.deferredRaceFrames ?? [];
  if (result.parked === true) return { kind: 'parked', parkedAddress: result.parkedAddress, deferredRaceFrames };
  return { kind: 'completed', deferredRaceFrames };
}

/**
 * The step for one parked run's drain, under the lease `lease`; its context
 * loads once. Null (logged under `log`) when the run cannot be re-entered:
 * its leaves stay as they are.
 */
export async function parkedRunStep(input: { runId: TriggerRunId; lease?: HeldRunLease; log: string }): Promise<StepLeaf | null> {
  const { runId, lease } = input;
  const context = await loadRunContext(runId);
  if ('unresumable' in context) {
    logger.error(`[${input.log}] cannot resume: ${context.unresumable}`, { runId });
    return null;
  }
  return async (request, settle) => {
    const common = {
      teamId: context.teamId,
      triggerId: context.triggerId,
      triggerName: context.triggerName,
      ...(context.firedMovementName !== null ? { firedMovementName: context.firedMovementName } : {}),
      pinnedSource: context.pinnedSource,
      pinnedLanguageVersion: context.pinnedLanguageVersion,
      movementVersionId: context.movementVersionId,
      runId,
      movementId: context.movementId,
      event: context.event,
      recordingTriggerType: context.triggerType,
      state: request.state,
      settleBranchComplete: async () => ({ runComplete: await settle.runComplete() }),
      ...(lease !== undefined ? { lease } : {}),
    };
    switch (request.kind) {
      case 'leaf':
        return stepOutcomeOf(
          await resumeMovementFiring({
            ...common,
            // A slept timer steps past its sleep; anything else re-enters to
            // re-check live (an await binds its own landing, nothing injected).
            ...(request.reenter ? { reenter: true } : {}),
            deferRaceSettlement: request.deferRaceSettlement,
          }),
        );
      case 'race':
        return stepOutcomeOf(await resumeMovementFiring({ ...common, settleRaceFrameAddress: request.frameAddress }));
      default:
        return neverAsAny(request);
    }
  };
}
