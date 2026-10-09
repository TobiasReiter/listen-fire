// A run's trace used to reach its row only when the run SETTLED — so the one
// run anybody needs to inspect, the slow one, was the one that showed nothing.
// "Not doing anything" and "seven minutes into an extraction" looked identical.
//
// The live trace publishes what a running firing has done so far, as a
// PROVISIONAL step. The two things that must hold either side of it: a running
// run shows its entries, and the settle neither loses nor duplicates them.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementRunResult } from '../../../movement_engine/run';

jest.mock('kysely', () => ({
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => values[0],
}));

/** What the row currently holds — the double reads it back like Postgres would,
 *  which is what makes the append-vs-replace question testable at all. */
let rowSteps: unknown[] | null = null;
const insertedRows: Array<Record<string, unknown>> = [];
const updatedRows: Array<Record<string, unknown>> = [];

function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      // The FOR UPDATE read inside every write transaction.
      if (prop === 'executeTakeFirst') {
        return async () => (rowSteps === null ? undefined : { steps: rowSteps, nodes_written: 0 });
      }
      if (prop === 'then') return undefined;
      if (prop === 'set') {
        return (row: Record<string, unknown>) => {
          updatedRows.push(row);
          if (row.steps !== undefined) rowSteps = JSON.parse(String(row.steps));
          return mockChainable();
        };
      }
      if (prop === 'values') {
        return (row: Record<string, unknown>) => {
          insertedRows.push(row);
          if (row.steps !== undefined) rowSteps = JSON.parse(String(row.steps));
          else rowSteps ??= [];
          return mockChainable();
        };
      }
      if (prop === 'doUpdateSet') {
        return (row: Record<string, unknown>) => {
          if (row.steps !== undefined) rowSteps = JSON.parse(String(row.steps));
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

jest.mock('../../../../lib/journey', () => ({ recordTeamMilestone: jest.fn(async () => true) }));

jest.mock('../../../context', () => ({
  unsafeCurrentContext: jest.fn().mockReturnValue(null),
  currentContext: jest.fn().mockReturnValue(null),
}));

import type { MovementTraceEntry } from '../../../movement_engine/expression';

import { TriggerRunRecorder } from '../trigger_run';

const TEAM_ID = 'team-live' as TeamId;

function makeRecorder(): TriggerRunRecorder {
  return new TriggerRunRecorder({
    teamId: TEAM_ID,
    triggerId: 'trigger-1',
    triggerName: 'movement/intake/intake',
    triggerType: 'webhook',
    triggerEvent: {
      pipelineInputId: 'trigger:trigger-1',
      adapterType: 'email',
      triggerType: 'webhook',
      payload: {},
    },
  });
}

const gate = (outcome: boolean) => ({ kind: 'gate', outcome }) as MovementTraceEntry;

function result(trace: MovementTraceEntry[]): MovementRunResult {
  return { movementName: 'intake', writes: [], extractionSites: {}, trace };
}

/** The trace as `inspectRun` projects it: every step's `diagnostics.trace`,
 *  flattened in program order. */
function inspectableTrace(): unknown[] {
  const out: unknown[] = [];
  for (const step of (rowSteps ?? []) as Array<{ diagnostics?: { trace?: unknown } }>) {
    const stepTrace = step.diagnostics?.trace;
    if (Array.isArray(stepTrace)) out.push(...stepTrace);
  }
  return out;
}

beforeEach(() => {
  rowSteps = null;
  insertedRows.length = 0;
  updatedRows.length = 0;
});

describe('a running run beats while it works', () => {
  it('stamps the heartbeat at start, on a publishing tick, and on a tick with nothing new', async () => {
    const recorder = makeRecorder();
    await recorder.ensureStarted();
    expect(insertedRows[0]?.last_heartbeat_at).toBeInstanceOf(Date);

    const trace: MovementTraceEntry[] = [];
    recorder.beginLiveTrace(trace);
    trace.push(gate(true));
    await recorder['flushLiveTrace']();
    expect(updatedRows.at(-1)?.last_heartbeat_at).toBeInstanceOf(Date);
    expect(updatedRows.at(-1)?.steps).toBeDefined();

    updatedRows.length = 0;
    await recorder['flushLiveTrace']();
    expect(updatedRows).toEqual([{ last_heartbeat_at: expect.any(Date) }]);
    recorder.endLiveTrace();
  });
});

describe('a running run publishes what it has done so far', () => {
  it('shows the entries so far while the run is still going', async () => {
    const recorder = makeRecorder();
    await recorder.ensureStarted();

    const trace: MovementTraceEntry[] = [];
    recorder.beginLiveTrace(trace);
    trace.push(gate(true), gate(false));

    await recorder['flushLiveTrace']();

    expect(inspectableTrace()).toEqual([gate(true), gate(false)]);
  });

  it('replaces the provisional entries rather than stacking them up', async () => {
    const recorder = makeRecorder();
    await recorder.ensureStarted();

    const trace: MovementTraceEntry[] = [];
    recorder.beginLiveTrace(trace);

    trace.push(gate(true));
    await recorder['flushLiveTrace']();
    trace.push(gate(false));
    await recorder['flushLiveTrace']();

    expect(inspectableTrace()).toEqual([gate(true), gate(false)]);
    expect(rowSteps).toHaveLength(1);
  });

  // The settle is authoritative: it records the real step, and the provisional
  // must neither survive alongside it nor take its entries with it.
  it('settles with the trace recorded once, not twice and not lost', async () => {
    const recorder = makeRecorder();
    await recorder.ensureStarted();

    const trace: MovementTraceEntry[] = [];
    recorder.beginLiveTrace(trace);
    trace.push(gate(true), gate(false));
    await recorder['flushLiveTrace']();

    recorder.recordMovementStep({
      movementId: 'mov-1',
      movementName: 'intake',
      sourceAdapterType: 'email',
      result: result(trace),
    });
    await recorder.finish();

    expect(inspectableTrace()).toEqual([gate(true), gate(false)]);
    expect(rowSteps).toHaveLength(1);
    expect((rowSteps as Array<Record<string, unknown>>)[0].inProgress).toBeUndefined();
  });

  it('stops publishing once the run has settled', async () => {
    const recorder = makeRecorder();
    await recorder.ensureStarted();

    const trace: MovementTraceEntry[] = [];
    recorder.beginLiveTrace(trace);
    recorder.recordMovementStep({
      movementId: 'mov-1',
      movementName: 'intake',
      sourceAdapterType: 'email',
      result: result(trace),
    });
    await recorder.finish();

    const settled = JSON.stringify(rowSteps);
    trace.push(gate(true));
    await recorder['flushLiveTrace']();

    expect(JSON.stringify(rowSteps)).toBe(settled);
  });
});
