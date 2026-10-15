// Integration test for the trigger_run recording backbone. Exercises the
// real DB roundtrip: a firing-scoped TriggerRunRecorder accumulating several
// orchestration steps, writing exactly ONE row aggregating them, and the
// reading side (keyed on the real trigger id) returning it with every step's
// writes under `steps`. This is the observability backbone the tg_run →
// trigger_run migration rests on, so it's verified through the real path.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { EvaluationResult } from '../../engine/types';
import type { NodeId } from '../../../../generated/kysely/knowledge/Node';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';

import { getAutomationsQb, getCoreQb, getQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { TriggerRunRecorder } from '../trigger_run';
import { flattenTriggerRunPlans, parseTriggerRunSteps } from '../trigger_run_read';


function evalResult(opts: {
  writes: number;
  plans?: number;
  errors?: number;
}): EvaluationResult {
  return {
    appliedActionPlans: Array.from({ length: opts.plans ?? opts.writes }, (_, i) => ({
      nodeId: `node-${i}`,
      adapterType: 'kg',
      recordType: 'Deal',
      created: true,
      writtenValues: { status: 'Considering' },
    })) as unknown as EvaluationResult['appliedActionPlans'],
    diagnostics: { reads: 0, writes: opts.writes } as unknown as EvaluationResult['diagnostics'],
    errors: Array.from({ length: opts.errors ?? 0 }, (_, i) => ({
      nodeId: `err-node-${i}`,
      position: null,
      message: `non-fatal error ${i}`,
    })) as unknown as EvaluationResult['errors'],
  };
}

function makeEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:test',
    adapterType: 'attio',
    triggerType: 'webhook',
    payload: { hello: 'world' },
    recordId: 'rec-1' as unknown as NodeId,
  };
}

describe('trigger_run recording (real DB)', () => {
  let teamId: TeamId;

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `trigger-run-it-${teamId.slice(0, 8)}` } as any)
      .execute();
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  it('writes exactly ONE row per firing, aggregating every step', async () => {
    const triggerId = randomUUID();
    const recorder = new TriggerRunRecorder({
      teamId,
      triggerId,
      triggerType: 'webhook',
      triggerEvent: makeEvent(),
    });

    // Two steps: a clean write of 2 records, then a partial step (1 write,
    // 1 non-fatal error).
    recorder.recordStep({
      tgId: 'tg-1',
      tgName: 'Attio → KG',
      sourceAdapterType: 'attio',
      targetAdapterType: 'kg',
      result: evalResult({ writes: 2 }),
    });
    recorder.recordStep({
      tgId: 'tg-2',
      tgName: 'KG enrich',
      sourceAdapterType: 'kg',
      targetAdapterType: 'kg',
      result: evalResult({ writes: 1, errors: 1 }),
    });

    await recorder.finish();

    const rows = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('team_id', '=', teamId)
      .where('trigger_id', '=', triggerId)
      .selectAll()
      .execute();

    // ONE row per firing — not one per step.
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // Aggregate status: a step with non-fatal errors → 'partial'.
    expect(row.status).toBe('partial');
    // nodes_written summed across steps (2 + 1).
    expect(row.nodes_written).toBe(3);
    // The triggering record id is captured.
    expect(row.record_id).toBe('rec-1');

    // Every step's applied plans land under `steps`, in order.
    const steps = parseTriggerRunSteps(row.steps);
    expect(steps).toHaveLength(2);
    expect(steps[0].tgName).toBe('Attio → KG');
    expect(Array.isArray(steps[0].appliedActionPlans)).toBe(true);
    expect((steps[0].appliedActionPlans as unknown[]).length).toBe(2);
    expect(steps[1].status).toBe('partial');

    // The flattened firing-level action tree is the union across steps.
    const flat = flattenTriggerRunPlans(row.steps);
    expect(flat).toHaveLength(3);

    // Errors are aggregated and tagged with their step's tgId.
    const errors = row.errors as Array<{ tgId?: string; message?: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0].tgId).toBe('tg-2');
  });

  it('records a hard step failure as a failed firing', async () => {
    const triggerId = randomUUID();
    const recorder = new TriggerRunRecorder({
      teamId,
      triggerId,
      triggerType: 'webhook',
      triggerEvent: makeEvent(),
    });
    recorder.recordStepFailure({
      tgId: 'tg-1',
      sourceAdapterType: 'attio',
      targetAdapterType: 'kg',
      message: 'target credential missing',
    });
    await recorder.finish();

    const row = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('team_id', '=', teamId)
      .where('trigger_id', '=', triggerId)
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(row.status).toBe('failed');
    expect(row.failed_at).not.toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.failure_reason).toBe('target credential missing');
    expect(row.nodes_written).toBe(0);
  });

  it('ensureStarted() inserts a running row; markParked() flips it; finish() upserts to terminal', async () => {
    const triggerId = randomUUID();
    const recorder = new TriggerRunRecorder({
      teamId,
      triggerId,
      triggerType: 'webhook',
      triggerEvent: makeEvent(),
    });

    // A parking firing creates the run row LAZILY as `running`.
    await recorder.ensureStarted();
    let row = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('team_id', '=', teamId)
      .where('trigger_id', '=', triggerId)
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('running');
    expect(row.completed_at).toBeNull();

    // ensureStarted is idempotent — a second call inserts nothing.
    await recorder.ensureStarted();

    // markParked flips it to the observable waiting state.
    await recorder.markParked();
    row = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', row.id)
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('parked');

    // A later resume reaching the end UPSERTS the same row to its terminal
    // status — NOT a second row.
    recorder.recordStep({ tgId: 'tg-1', result: evalResult({ writes: 2 }) });
    await recorder.finish();

    const rows = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('team_id', '=', teamId)
      .where('trigger_id', '=', triggerId)
      .selectAll()
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].nodes_written).toBe(2);
    expect(rows[0].completed_at).not.toBeNull();
  });

  it('finish() is idempotent — never double-writes a firing', async () => {
    const triggerId = randomUUID();
    const recorder = new TriggerRunRecorder({
      teamId,
      triggerId,
      triggerType: 'webhook',
      triggerEvent: makeEvent(),
    });
    recorder.recordStep({
      tgId: 'tg-1',
      result: evalResult({ writes: 1 }),
    });
    await recorder.finish();
    await recorder.finish();

    const count = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('team_id', '=', teamId)
      .where('trigger_id', '=', triggerId)
      .select((b) => b.fn.count('id').as('c'))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(1);
  });
});
