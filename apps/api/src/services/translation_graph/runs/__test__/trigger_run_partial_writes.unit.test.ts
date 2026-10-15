// A movement run that FAILS mid-way still has to account for the records it
// already put into external systems — writes execute inline, so they exist
// whether or not the run finished. The failure step carries their applied
// plans (and their write count feeds `nodes_written`), while the step and the
// run stay `failed`: honest accounting, not partial success.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementRunResult } from 'movement-engine/services/movement_engine/run';

// `sql` is used here only to wrap a JSON payload for a JSONB column
// (sql`${json}::jsonb`). Returning the interpolated value itself lets the test
// read the persisted `steps` back out of the captured insert.
jest.mock('kysely', () => ({
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => values[0],
}));

const insertedRows: Array<Record<string, unknown>> = [];

/** A chainable query-builder stand-in that records every `.values(…)` payload
 *  and resolves every terminal. Covers both the direct `getQb(...)` chains and
 *  the transaction `finish()` runs its upsert in. */
function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      if (prop === 'executeTakeFirst') return async () => null;
      if (prop === 'then') return undefined;
      if (prop === 'values') {
        return (row: Record<string, unknown>) => {
          insertedRows.push(row);
          return mockChainable();
        };
      }
      if (prop === 'transaction') {
        return () => ({
          execute: async (fn: (trx: object) => Promise<unknown>) => fn(mockChainable()),
        });
      }
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}

jest.mock('../../../../lib/kysely', () => ({
  getQb: () => mockChainable(),
  getCoreQb: () => mockChainable(),
  getAutomationsQb: () => mockChainable(),
}));

jest.mock('../../../../lib/message_queue', () => ({
  mq: {
    triggerRunActivity: { activity: { publish: jest.fn(async () => undefined) } },
    triggerRuns: { recorded: { publish: jest.fn(async () => undefined) } },
  },
}));

jest.mock('../../../../lib/ops/run', () => ({
  startOpsRun: jest.fn(async () => null),
  addOpsRunMessage: jest.fn(async () => undefined),
  completeOpsRun: jest.fn(async () => undefined),
  failOpsRun: jest.fn(async () => undefined),
  parkOpsRun: jest.fn(async () => undefined),
  unparkOpsRun: jest.fn(async () => undefined),
}));

jest.mock('../../../../lib/journey', () => ({
  recordTeamMilestone: jest.fn(async () => true),
}));

jest.mock('../../../context', () => ({
  unsafeCurrentContext: jest.fn().mockReturnValue(null),
  currentContext: jest.fn().mockReturnValue(null),
}));

import { TriggerRunRecorder } from '../trigger_run';
import { flattenTriggerRunPlans, parseTriggerRunSteps } from '../trigger_run_read';

const TEAM_ID = 'team-partial' as TeamId;

function makeRecorder(): TriggerRunRecorder {
  return new TriggerRunRecorder({
    teamId: TEAM_ID,
    triggerId: 'trigger-1',
    triggerName: 'movement/intake_file/intake',
    triggerType: 'webhook',
    triggerEvent: {
      pipelineInputId: 'trigger:trigger-1',
      adapterType: 'email',
      triggerType: 'webhook',
      payload: {},
    },
  });
}

/** A run that created one Attio company and then died on its second write. */
function partialLedger(): MovementRunResult {
  return {
    movementName: 'intake',
    writes: [
      {
        bindingName: 'co',
        adapterType: 'attio',
        recordType: 'company',
        created: true,
        committed: true,
        externalId: 'co-1',
        writtenValues: { name: 'Acme' },
        provenance: {},
      },
    ],
    extractionSites: {},
    trace: [],
  };
}

function persistedSteps(): ReturnType<typeof parseTriggerRunSteps> {
  const terminal = insertedRows[insertedRows.length - 1];
  return parseTriggerRunSteps(JSON.parse(String(terminal.steps)));
}

beforeEach(() => {
  insertedRows.length = 0;
});

describe('a failed movement step carries the writes that landed', () => {
  it('persists the applied plans, counts them as nodes written, and stays failed', async () => {
    const recorder = makeRecorder();
    recorder.recordStepFailure({
      tgId: 'movement:mov-1',
      tgName: 'intake',
      sourceAdapterType: 'email',
      message: 'slack: 422 Unprocessable Entity',
      partial: partialLedger(),
    });
    await recorder.finish();

    const terminal = insertedRows[insertedRows.length - 1];
    // Honest accounting, not partial success — the run failed.
    expect(terminal.status).toBe('failed');
    expect(terminal.failure_reason).toBe('slack: 422 Unprocessable Entity');
    expect(terminal.nodes_written).toBe(1);

    const [step] = persistedSteps();
    expect(step.status).toBe('failed');
    expect(step.targetAdapterType).toBe('attio');
    expect(step.errors).toEqual([{ message: 'slack: 422 Unprocessable Entity' }]);

    const plans = flattenTriggerRunPlans(JSON.parse(String(terminal.steps)));
    expect(plans).toEqual([
      expect.objectContaining({
        nodeId: 'co',
        adapterType: 'attio',
        recordType: 'company',
        created: true,
        committed: true,
        externalId: 'co-1',
        writtenValues: { name: 'Acme' },
      }),
    ]);
  });

  it('a record a match FOUND is persisted for the reader but never counted as written', async () => {
    const ledger = partialLedger();
    ledger.writes.unshift({
      bindingName: 'known',
      kind: 'match',
      adapterType: 'hubspot',
      recordType: 'company',
      created: false,
      committed: false,
      externalId: 'found-1',
      writtenValues: {},
      provenance: {},
    });
    const recorder = makeRecorder();
    recorder.recordStepFailure({
      tgId: 'movement:mov-1',
      tgName: 'intake',
      sourceAdapterType: 'email',
      message: 'boom',
      partial: ledger,
    });
    await recorder.finish();

    const terminal = insertedRows[insertedRows.length - 1];
    expect(terminal.nodes_written).toBe(1);
    const [step] = persistedSteps();
    // The system the run WROTE to, not the one it only looked in.
    expect(step.targetAdapterType).toBe('attio');
    const plans = flattenTriggerRunPlans(JSON.parse(String(terminal.steps)));
    expect(plans).toEqual([
      expect.objectContaining({ nodeId: 'known', kind: 'match', externalId: 'found-1' }),
      expect.objectContaining({ nodeId: 'co', externalId: 'co-1' }),
    ]);
  });

  it('a failure with no ledger records nothing — the pre-existing shape is unchanged', async () => {
    const recorder = makeRecorder();
    recorder.recordStepFailure({
      tgId: 'tg-1',
      message: 'the evaluation threw',
    });
    await recorder.finish();

    const terminal = insertedRows[insertedRows.length - 1];
    expect(terminal.status).toBe('failed');
    expect(terminal.nodes_written).toBe(0);

    const [step] = persistedSteps();
    expect(step.appliedActionPlans).toEqual([]);
    expect(step.diagnostics).toEqual({});
    expect(step.targetAdapterType).toBeNull();
  });
});
