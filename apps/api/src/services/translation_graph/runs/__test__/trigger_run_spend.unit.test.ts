// A run's spend is the RUN's, not the segment's: a resume reads back what the
// run spent before it parked (the seed of the resumed segment's cost-cap
// account), and each segment's spend — total and by source — adds up on the
// run's record.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';
import type { MovementRunResult } from 'movement-engine/services/movement_engine/run';

// `sql` only wraps JSON for a JSONB column; hand the JSON text straight back so
// the test can read the persisted diagnostics out of the captured upsert.
jest.mock('kysely', () => ({
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => values[0],
}));

const insertedRows: Array<Record<string, unknown>> = [];
/** The run row as a resume finds it — what every `executeTakeFirst` reads. */
let existingRow: Record<string, unknown> | null = null;

function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      if (prop === 'executeTakeFirst') return async () => existingRow;
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

const TEAM_ID = 'team-spend' as TeamId;
const RUN_ID = '00000000-0000-0000-0000-0000000000aa' as TriggerRunId;
const DOLLAR = 1_000_000;

function resumingRecorder(): TriggerRunRecorder {
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
    existingRunId: RUN_ID,
  });
}

function segment(spend: Partial<MovementRunResult>): MovementRunResult {
  return { movementName: 'intake', writes: [], extractionSites: {}, trace: [], ...spend };
}

function persistedDiagnostics(): Record<string, unknown> {
  const terminal = insertedRows[insertedRows.length - 1];
  return JSON.parse(String(terminal?.diagnostics)) as Record<string, unknown>;
}

beforeEach(() => {
  insertedRows.length = 0;
  existingRow = null;
});

describe('a resumed run', () => {
  it('reads back the engine that parked it, which its resume goes back to', async () => {
    for (const engine of ['ts', 'rust'] as const) {
      existingRow = { ops_run_id: null, started_at: new Date(), diagnostics: {}, engine };
      const recorder = resumingRecorder();
      expect(recorder.parkedOnEngine).toBeUndefined();
      await recorder.adoptOpsRun();
      expect(recorder.parkedOnEngine).toBe(engine);
    }
    // A row that names no engine (or one this release does not know) leaves
    // the resume to be routed by the run's pin.
    for (const engine of [null, 'wasm']) {
      existingRow = { ops_run_id: null, started_at: new Date(), diagnostics: {}, engine };
      const recorder = resumingRecorder();
      await recorder.adoptOpsRun();
      expect(recorder.parkedOnEngine).toBeUndefined();
    }
  });

  it('reads back what the run spent before it parked', async () => {
    existingRow = {
      ops_run_id: null,
      started_at: new Date('2026-10-01T00:00:00Z'),
      diagnostics: { writes: 1, costUsd: 2, costMicrodollars: 2 * DOLLAR, runCostUsd: 2 },
    };
    const recorder = resumingRecorder();
    expect(recorder.priorSpentMicrodollars).toBe(0);
    await recorder.adoptOpsRun();
    expect(recorder.priorSpentMicrodollars).toBe(2 * DOLLAR);
  });

  it('a row recorded before the exact figure falls back to its dollar sum', async () => {
    existingRow = { ops_run_id: null, started_at: new Date(), diagnostics: { costUsd: 0.0123 } };
    const recorder = resumingRecorder();
    await recorder.adoptOpsRun();
    expect(recorder.priorSpentMicrodollars).toBe(12_300);
  });

  it('a run that has spent nothing reads back nothing', async () => {
    existingRow = { ops_run_id: null, started_at: new Date(), diagnostics: { writes: 3 } };
    const recorder = resumingRecorder();
    await recorder.adoptOpsRun();
    expect(recorder.priorSpentMicrodollars).toBe(0);
  });
});

describe("a segment's spend on the run's record", () => {
  it("adds this segment's spend and breakdown to the run's, and keeps the run's own figure unsummed", async () => {
    existingRow = {
      ops_run_id: null,
      started_at: new Date(),
      steps: [],
      errors: [],
      nodes_written: 0,
      diagnostics: {
        writes: 0,
        costUsd: 2,
        costMicrodollars: 2 * DOLLAR,
        costBySource: { 'model:claude-sonnet-5': 2 * DOLLAR },
        runCostUsd: 2,
      },
    };
    const recorder = resumingRecorder();
    await recorder.adoptOpsRun();
    recorder.recordMovementStep({
      movementId: 'mov-1',
      movementName: 'intake',
      result: segment({
        spentMicrodollars: DOLLAR,
        runSpentMicrodollars: 3 * DOLLAR,
        spentBySource: { 'model:claude-sonnet-5': 500_000, 'service:brightdata.web_unlocker': 500_000 },
      }),
    });
    await recorder.finish();

    expect(persistedDiagnostics()).toEqual({
      writes: 0,
      costUsd: 3,
      costMicrodollars: 3 * DOLLAR,
      costBySource: {
        'model:claude-sonnet-5': 2_500_000,
        'service:brightdata.web_unlocker': 500_000,
      },
      runCostUsd: 3,
    });
  });
});
