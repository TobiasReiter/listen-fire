// The append-only step channel, against the real DB.
//
// A parked run's pre-park writes are already in the external systems, but they
// used to reach the `trigger_run` row NOWHERE: the parking firing early-returns
// before `finish()` (finishing would overwrite the live `parked` status), and
// the resuming firing's `finish()` then REPLACED `steps` wholesale. So the
// inspector read a parked run as "wrote nothing", and the pre-park half was
// gone for good once the run settled.
//
// `snapshotSteps()` is the park-time channel; `finish()` appends to it. Both
// merge under a `FOR UPDATE` row lock so two branches of a fan-out settling at
// the same moment can't swallow each other's segment.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { NodeId } from '../../../../generated/kysely/knowledge/Node';
import type { PipelineConfigurationId } from '../../../../generated/kysely/public/PipelineConfiguration';
import type { MovementRunResult } from '../../../movement_engine/run';
import type { TriggerEvent } from '../../triggers/types';

import { TriggerRunRecorder } from '../../runs/trigger_run';
import { failRunAndCancelRequests } from '../../../interaction/run_failure';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { getAutomationsQb, getCoreQb, getQb } from '../../../../lib/kysely';
import { listMovementRuns, inspectMovementRun } from '../run_now';

function makeEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:park-channel',
    adapterType: 'attio',
    triggerType: 'webhook',
    payload: { dealName: 'Acme Series A' },
    recordId: 'rec-1' as unknown as NodeId,
  };
}

/** A segment result whose writes are distinguishable by external id, so the
 *  persisted union can be read back in order. */
function segmentResult(externalIds: string[]): MovementRunResult {
  return {
    movementName: 'Dealflow → Attio',
    writes: externalIds.map((externalId) => ({
      adapterType: 'attio',
      recordType: 'Company',
      externalId,
      created: true,
      committed: true,
      writtenValues: { name: externalId },
      provenance: {},
      bindingName: externalId,
    })) as unknown as MovementRunResult['writes'],
    extractionSites: {},
    trace: [],
  };
}

async function seedMovementWithManualLane(teamId: TeamId): Promise<{
  movementId: MovementId;
  triggerId: TriggerId;
}> {
  const pipelineConfigurationId = randomUUID() as PipelineConfigurationId;
  await getQb(['pipeline_configuration'])
    .insertInto('pipeline_configuration')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: pipelineConfigurationId, team_id: teamId, name: `cfg-${pipelineConfigurationId.slice(0, 8)}` } as any)
    .execute();

  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: movementId, team_id: teamId, name: 'Dealflow → Attio', source: 'go = manual()' } as any)
    .execute();

  const triggerId = randomUUID() as TriggerId;
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: triggerId,
      team_id: teamId,
      pipeline_configuration_id: pipelineConfigurationId,
      name: 'Run now',
      kind: 'manual',
      movement_id: movementId,
    } as any)
    .execute();

  return { movementId, triggerId };
}

function makeRecorder(input: {
  teamId: TeamId;
  triggerId: TriggerId;
  runId?: TriggerRunId;
}): TriggerRunRecorder {
  return new TriggerRunRecorder({
    teamId: input.teamId,
    triggerId: input.triggerId,
    triggerType: 'webhook',
    triggerEvent: makeEvent(),
    ...(input.runId !== undefined ? { existingRunId: input.runId } : {}),
  });
}

/** The parking half of a firing: the run row exists, the pre-park writes are
 *  snapshotted onto it, and the run is observably `parked`. */
async function recordParkedSegment(input: {
  teamId: TeamId;
  triggerId: TriggerId;
  movementId: MovementId;
  externalIds: string[];
}): Promise<TriggerRunId> {
  const recorder = makeRecorder(input);
  await recorder.ensureStarted();
  recorder.recordMovementStep({
    movementId: input.movementId,
    movementName: 'Dealflow → Attio',
    sourceAdapterType: 'attio',
    result: segmentResult(input.externalIds),
  });
  await recorder.snapshotSteps();
  await recorder.markParked();
  return recorder.triggerRunId;
}

async function readRow(runId: TriggerRunId) {
  return getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .select(['status', 'steps', 'nodes_written', 'diagnostics', 'completed_at', 'failed_at'])
    .where('id', '=', runId)
    .executeTakeFirstOrThrow();
}

describe('parked runs: append-only step channel (real DB)', () => {
  let teamId: TeamId;
  let movementId: MovementId;
  let triggerId: TriggerId;

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `park-chan-${teamId.slice(0, 8)}` } as any)
      .execute();
    ({ movementId, triggerId } = await seedMovementWithManualLane(teamId));
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  it('mid-park inspection shows the pre-park writes; the run is still parked', async () => {
    const runId = await recordParkedSegment({
      teamId,
      triggerId,
      movementId,
      externalIds: ['company-1', 'company-2'],
    });

    const detail = await inspectMovementRun({ teamId, runId });
    if ('error' in detail) throw new Error(detail.error);
    expect(detail.status).toBe('parked');
    expect(detail.writes.map((w) => w.externalId)).toEqual(['company-1', 'company-2']);
    expect(detail.committed).toBe(2);
    // The snapshot is NOT a settle: the terminal columns stay untouched.
    expect(detail.finishedAt).toBeNull();
    expect(detail.failedAt).toBeNull();
  });

  it('post-resume inspection shows the union — the resume appends, never replaces', async () => {
    const runId = await recordParkedSegment({
      teamId,
      triggerId,
      movementId,
      externalIds: ['company-1', 'company-2'],
    });

    const resume = makeRecorder({ teamId, triggerId, runId });
    resume.recordMovementStep({
      movementId,
      movementName: 'Dealflow → Attio',
      sourceAdapterType: 'attio',
      result: segmentResult(['company-3']),
    });
    await resume.finish();

    const detail = await inspectMovementRun({ teamId, runId });
    if ('error' in detail) throw new Error(detail.error);
    expect(detail.status).toBe('success');
    expect(detail.writes.map((w) => w.externalId)).toEqual([
      'company-1',
      'company-2',
      'company-3',
    ]);

    // The list surface's counts follow the same union.
    const [run] = await listMovementRuns({ teamId, movementId });
    expect(run.recordCount).toBe(3);
    expect(run.committed).toBe(3);

    const row = await readRow(runId);
    expect(row.nodes_written).toBe(3);
    expect(row.diagnostics).toMatchObject({ writes: 3 });
    expect(row.completed_at).not.toBeNull();
  });

  it('a segment that snapshots and later finishes appends once — no double count', async () => {
    const recorder = makeRecorder({ teamId, triggerId });
    await recorder.ensureStarted();
    recorder.recordMovementStep({
      movementId,
      movementName: 'Dealflow → Attio',
      sourceAdapterType: 'attio',
      result: segmentResult(['company-1']),
    });
    await recorder.snapshotSteps();
    recorder.recordMovementStep({
      movementId,
      movementName: 'Dealflow → Attio',
      sourceAdapterType: 'attio',
      result: segmentResult(['company-2']),
    });
    await recorder.finish();

    const row = await readRow(recorder.triggerRunId);
    expect(Array.isArray(row.steps) ? row.steps.length : 0).toBe(2);
    expect(row.nodes_written).toBe(2);

    const detail = await inspectMovementRun({ teamId, runId: recorder.triggerRunId });
    if ('error' in detail) throw new Error(detail.error);
    expect(detail.writes.map((w) => w.externalId)).toEqual(['company-1', 'company-2']);
  });

  it('a cancelled run keeps its pre-cancel writes, and still settles as the cancel', async () => {
    const recorder = makeRecorder({ teamId, triggerId });
    await recorder.ensureStarted();
    recorder.recordMovementStep({
      movementId,
      movementName: 'Dealflow → Attio',
      sourceAdapterType: 'attio',
      result: segmentResult(['company-1', 'company-2']),
    });
    await recorder.snapshotSteps();
    await failRunAndCancelRequests({
      runId: recorder.triggerRunId,
      message: 'Cancelled by an operator',
    });

    const detail = await inspectMovementRun({ teamId, runId: recorder.triggerRunId });
    if ('error' in detail) throw new Error(detail.error);
    // The cancel is still the terminal outcome — the channel never touches it.
    expect(detail.status).toBe('failed');
    expect(detail.failureReason).toBe('Cancelled by an operator');
    expect(detail.failedAt).not.toBeNull();
    // …but what it had already put into the external systems is visible.
    expect(detail.writes.map((w) => w.externalId)).toEqual(['company-1', 'company-2']);

    const row = await readRow(recorder.triggerRunId);
    expect(Array.isArray(row.steps) ? row.steps.length : 0).toBe(1);
    expect(row.nodes_written).toBe(2);
  });

  it('a cancel mid-resume appends to the park segment rather than replacing it', async () => {
    const runId = await recordParkedSegment({
      teamId,
      triggerId,
      movementId,
      externalIds: ['company-1'],
    });

    const resume = makeRecorder({ teamId, triggerId, runId });
    resume.recordMovementStep({
      movementId,
      movementName: 'Dealflow → Attio',
      sourceAdapterType: 'attio',
      result: segmentResult(['company-2']),
    });
    await resume.snapshotSteps();
    await failRunAndCancelRequests({ runId, message: 'Cancelled by an operator' });

    const detail = await inspectMovementRun({ teamId, runId });
    if ('error' in detail) throw new Error(detail.error);
    expect(detail.status).toBe('failed');
    expect(detail.writes.map((w) => w.externalId)).toEqual(['company-1', 'company-2']);

    const row = await readRow(runId);
    expect(Array.isArray(row.steps) ? row.steps.length : 0).toBe(2);
    expect(row.nodes_written).toBe(2);
  });

  it('two branches settling concurrently both land — neither clobbers the other', async () => {
    const runId = await recordParkedSegment({
      teamId,
      triggerId,
      movementId,
      externalIds: ['company-1'],
    });

    const branch = (externalId: string): Promise<void> => {
      const recorder = makeRecorder({ teamId, triggerId, runId });
      recorder.recordMovementStep({
        movementId,
        movementName: 'Dealflow → Attio',
        sourceAdapterType: 'attio',
        result: segmentResult([externalId]),
      });
      return recorder.snapshotSteps();
    };

    await Promise.all([branch('company-2'), branch('company-3')]);

    const row = await readRow(runId);
    expect(Array.isArray(row.steps) ? row.steps.length : 0).toBe(3);
    expect(row.nodes_written).toBe(3);
    expect(row.status).toBe('parked');

    const detail = await inspectMovementRun({ teamId, runId });
    if ('error' in detail) throw new Error(detail.error);
    expect(detail.writes.map((w) => w.externalId).sort()).toEqual([
      'company-1',
      'company-2',
      'company-3',
    ]);
  });
});
