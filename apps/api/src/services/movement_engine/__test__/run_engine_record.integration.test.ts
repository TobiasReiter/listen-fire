// The engine's decision for a run, kept on the run's row against the real
// database and shown by the operator run view.

import { randomUUID } from 'node:crypto';

import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { getAutomationsQb } from '../../../lib/kysely';
import { getTgRun, listTgRuns } from '../../system_debug';
import { recordRunEnginesOnRows, settleRunEngineRecords } from '../run_engine_record';
import { recordRunEngine, setRunEngineRecorder } from '../rust_stats';

const TEAM_ID = randomUUID() as TeamId;
const runs: TriggerRunId[] = [];

async function seedRun(): Promise<TriggerRunId> {
  const row = await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    .values({ team_id: TEAM_ID, trigger_id: `engine-record-${randomUUID()}`, trigger_type: 'webhook', status: 'running' })
    .returning('id')
    .executeTakeFirstOrThrow();
  runs.push(row.id);
  return row.id;
}

async function engineOf(runId: TriggerRunId) {
  return getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select(['engine', 'engine_reason'])
    .executeTakeFirstOrThrow();
}

beforeAll(() => recordRunEnginesOnRows());

afterAll(async () => {
  setRunEngineRecorder(undefined);
  if (runs.length > 0) await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('id', 'in', runs).execute();
});

describe('a run row records its engine', () => {
  it('is null before the engine has decided, additive for runs from before the columns', async () => {
    const runId = await seedRun();
    expect(await engineOf(runId)).toEqual({ engine: null, engine_reason: null });
  });

  it('keeps the engine and the first reason, and the latest segment overwrites an earlier one', async () => {
    const runId = await seedRun();
    recordRunEngine({ runId, engine: 'ts', reason: 'expression_closure' });
    await settleRunEngineRecords();
    expect(await engineOf(runId)).toEqual({ engine: 'ts', engine_reason: 'expression_closure' });
    recordRunEngine({ runId, engine: 'rust', reason: null });
    await settleRunEngineRecords();
    expect(await engineOf(runId)).toEqual({ engine: 'rust', engine_reason: null });
  });

  it('writes in the order the decisions were made', async () => {
    const runId = await seedRun();
    for (const reason of ['a', 'b', 'c', 'last']) recordRunEngine({ runId, engine: 'ts', reason });
    await settleRunEngineRecords();
    expect(await engineOf(runId)).toEqual({ engine: 'ts', engine_reason: 'last' });
  });

  it('ignores a run id that is not a trigger run, and a run with no row', async () => {
    recordRunEngine({ runId: 'dev-script-run', engine: 'ts', reason: null });
    recordRunEngine({ runId: randomUUID(), engine: 'ts', reason: null });
    await expect(settleRunEngineRecords()).resolves.toBeUndefined();
  });

  it('is shown by the operator run views', async () => {
    const runId = await seedRun();
    recordRunEngine({ runId, engine: 'ts', reason: 'plugin_call' });
    await settleRunEngineRecords();
    expect(await getTgRun({ teamId: TEAM_ID, runId })).toMatchObject({ engine: 'ts', engineReason: 'plugin_call' });
    expect(await listTgRuns({ teamId: TEAM_ID })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: runId, engine: 'ts', engineReason: 'plugin_call' })]),
    );
  });
});
