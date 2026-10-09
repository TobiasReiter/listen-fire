// Integration test for the run-observability read surface (AZ-1): the MCP
// `listRuns` + `inspectRun` tools' service functions, exercised through the
// REAL DB. A movement with one manual lane records a real firing via the
// recorder; we then read it back exactly as the agent surface does and assert
// the discovery list AND the resolved write-plan / decision trace / source
// event come back faithfully. This is the runtime path author-time rigor can't
// catch (the brief's AZ-2 class) — so it's verified end-to-end against Postgres.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { NodeId } from '../../../../generated/kysely/knowledge/Node';
import type { PipelineConfigurationId } from '../../../../generated/kysely/public/PipelineConfiguration';
import type { MovementRunResult } from '../../../movement_engine/run';
import type { TriggerEvent } from '../../triggers/types';

import { TriggerRunRecorder } from '../../runs/trigger_run';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { getAutomationsQb, getCoreQb, getQb } from '../../../../lib/kysely';
import { listMovementRuns, inspectMovementRun } from '../run_now';

function makeEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:test',
    adapterType: 'attio',
    triggerType: 'webhook',
    payload: { dealName: 'Acme Series A', amount: 5_000_000 },
    recordId: 'rec-1' as unknown as NodeId,
  };
}

// A realistic firing: one created record carrying resolved field values, and a
// standalone link — plus a decision trace with a satisfied gate.
function movementResult(): MovementRunResult {
  return {
    movementName: 'Dealflow → Attio',
    writes: [
      {
        adapterType: 'attio',
        recordType: 'Company',
        externalId: 'company-123',
        created: true,
        committed: true,
        writtenValues: { name: 'Acme', stage: 'Series A', amount: 5_000_000 },
        provenance: {},
        bindingName: 'co',
      },
      {
        adapterType: 'attio',
        recordType: 'Company',
        externalId: 'company-123',
        created: true,
        // Rehearsed against a `dry_run` target inside an otherwise-live run —
        // the per-write truth the run-level flag used to hide.
        committed: false,
        kind: 'link',
        writtenValues: {},
        provenance: {},
        link: { edgeName: 'deal_flow', toRecordType: 'List entry', toExternalId: 'entry-9' },
      },
    ] as unknown as MovementRunResult['writes'],
    extractionSites: {},
    trace: [
      { kind: 'gate', outcome: true },
    ] as unknown as MovementRunResult['trace'],
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

async function recordOneRun(teamId: TeamId, triggerId: TriggerId, movementId: MovementId): Promise<void> {
  const recorder = new TriggerRunRecorder({
    teamId,
    triggerId,
    triggerType: 'webhook',
    triggerEvent: makeEvent(),
  });
  recorder.recordMovementStep({
    movementId,
    movementName: 'Dealflow → Attio',
    sourceAdapterType: 'attio',
    result: movementResult(),
  });
  await recorder.finish();
}

describe('run observability read surface (real DB)', () => {
  let teamId: TeamId;

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `run-insp-${teamId.slice(0, 8)}` } as any)
      .execute();
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  it('listMovementRuns surfaces the firing, tagged with its lane', async () => {
    const { movementId, triggerId } = await seedMovementWithManualLane(teamId);
    await recordOneRun(teamId, triggerId, movementId);

    const runs = await listMovementRuns({ teamId, movementId });
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.status).toBe('success');
    expect(run.lane).toBe('Run now');
    // One record write + one link → 2 writes counted; the link was rehearsed.
    expect(run.recordCount).toBe(2);
    expect(run.committed).toBe(1);
    expect(run.captured).toBe(1);
    expect(typeof run.runId).toBe('string');
    expect(run.finishedAt).not.toBeNull();
  });

  it('listMovementRuns is empty for a movement with no runs', async () => {
    const { movementId } = await seedMovementWithManualLane(teamId);
    expect(await listMovementRuns({ teamId, movementId })).toEqual([]);
  });

  it('inspectMovementRun returns the source event, resolved write-plan, and trace', async () => {
    const { movementId, triggerId } = await seedMovementWithManualLane(teamId);
    await recordOneRun(teamId, triggerId, movementId);

    const [{ runId }] = await listMovementRuns({ teamId, movementId });
    const detail = await inspectMovementRun({ teamId, runId });
    if ('error' in detail) throw new Error(detail.error);

    expect(detail.status).toBe('success');
    expect(detail.committed).toBe(1);
    expect(detail.captured).toBe(1);

    // The source event that fired it is recoverable.
    expect(detail.sourceEvent).toMatchObject({
      payload: { dealName: 'Acme Series A', amount: 5_000_000 },
    });

    // The resolved write-plan: a create with its FINAL field values, and a link.
    expect(detail.writes).toHaveLength(2);
    const create = detail.writes[0];
    expect(create.action).toBe('create');
    expect(create.target).toBe('attio:Company');
    expect(create.externalId).toBe('company-123');
    expect(create.committed).toBe(true);
    expect(create.values).toEqual({ name: 'Acme', stage: 'Series A', amount: 5_000_000 });

    const link = detail.writes[1];
    expect(link.action).toBe('link');
    expect(link.committed).toBe(false);
    expect(link.link).toMatchObject({ edgeName: 'deal_flow', toExternalId: 'entry-9' });

    // The decision trace carries the gate outcome.
    expect(detail.trace).toContainEqual({ kind: 'gate', outcome: true });
  });

  it('inspectMovementRun is team-scoped — a cross-team runId is not found', async () => {
    const { movementId, triggerId } = await seedMovementWithManualLane(teamId);
    await recordOneRun(teamId, triggerId, movementId);
    const [{ runId }] = await listMovementRuns({ teamId, movementId });

    const otherTeam = randomUUID() as TeamId;
    const detail = await inspectMovementRun({ teamId: otherTeam, runId });
    expect('error' in detail).toBe(true);
  });
});
