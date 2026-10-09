// The poll-source work handlers: a trigger's row pulls its PollSource's events,
// injects them into the dispatch pipeline, advances the checkpoint only on
// success, and re-arms one interval later; the reconcile keeps one row per
// poll-source trigger. DB / registry / dispatch / event-store / work store are
// mocked; the test asserts the orchestration.

import type { DiscriminableEvent } from '../../translation_graph/adapter';
import type { PollSource } from '../../translation_graph/poll_source';

// ── DB: a filtering select + a capturing update ──────────────────────────
let rows: Array<Record<string, unknown>> = [];
const updates: Array<{ id: unknown; set: Record<string, unknown> }> = [];

jest.mock('../../../lib/kysely', () => {
  type Clause = { col: string; op: string; value: unknown };
  function matches(row: Record<string, unknown>, clauses: Clause[]): boolean {
    return clauses.every(({ col, op, value }) => {
      if (op === '=') return row[col] === value;
      if (op === '!=' || op === 'is not') return row[col] !== value;
      throw new Error(`fake kysely: unsupported operator ${op}`);
    });
  }
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function select(clauses: Clause[]): any {
    return {
      where: (col: string, op: string, value: unknown) => select([...clauses, { col, op, value }]),
      select: () => select(clauses),
      execute: async () => rows.filter((r) => matches(r, clauses)),
      executeTakeFirst: async () => rows.find((r) => matches(r, clauses)),
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return {
    getAutomationsQb: () => ({
      selectFrom: () => select([]),
      updateTable: () => ({
        set: (set: Record<string, unknown>) => ({
          where: (_col: string, _op: string, id: unknown) => ({
            execute: async () => {
              updates.push({ id, set });
            },
          }),
        }),
      }),
    }),
  };
});

// ── Registry: a fake PollSource + no adapter (skip discrimination) ───────────
const getEventsMock = jest.fn();
let pollIntervalSeconds = 300;
jest.mock('../../translation_graph/adapters/registry', () => ({
  isPollSource: (kind: string) => kind === 'granola',
  resolveAdapterSlug: (kind: string) => kind,
  hasAdapter: () => false,
  getAdapter: () => null,
  getPollSource: (): PollSource => ({
    get pollIntervalSeconds() {
      return pollIntervalSeconds;
    },
    getEvents: getEventsMock,
  }),
}));

// ── Dispatch + event store ──────────────────────────────────────────────────
const dispatchMock = jest.fn(async (_input: unknown) => ({}));
jest.mock('../../translation_graph/triggers/router', () => ({
  dispatchTriggerByIdEvent: (input: unknown) => dispatchMock(input),
}));
jest.mock('../../translation_graph/triggers/event_store', () => ({
  storeTriggerEvent: async () => 'receipt-1',
  markTriggerEventDispatched: async () => {},
  markTriggerEventFailed: async () => {},
}));

jest.mock('../../work/store', () => ({
  enqueueWork: jest.fn(async () => {}),
  removeWork: jest.fn(async () => {}),
  listWorkByKind: jest.fn(async () => []),
}));
jest.mock('../../work/drain', () => ({
  registerWorkHandler: jest.fn(),
}));
jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { WorkRow } from '../../work/kinds';

import { testWorkContext } from '../../../test/harness/work';
import {
  pollReconcileHandler,
  pollSourceHandler,
  pollTriggerNow,
  pollWorkKey,
  registerPollWork,
} from '../worker';

const { enqueueWork, removeWork, listWorkByKind } = jest.requireMock('../../work/store') as {
  enqueueWork: jest.Mock;
  removeWork: jest.Mock;
  listWorkByKind: jest.Mock;
};
const { registerWorkHandler } = jest.requireMock('../../work/drain') as {
  registerWorkHandler: jest.Mock;
};

const NOW = new Date('2026-06-19T12:00:00.000Z');
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

function row(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: T1,
    team_id: 'team-1',
    kind: 'granola',
    config: {},
    credentials_id: 'cred-1',
    movement_id: 'mov-1',
    run_mode: 'live',
    poll_checkpoint: undefined,
    poll_last_at: null,
    ...over,
  };
}

function event(over: Partial<DiscriminableEvent> = {}): DiscriminableEvent {
  return { payload: { title: 'Sync' }, externalId: 'note-9', tag: 'granola:note', ...over };
}

function workRow(input: { triggerId: string; leaseUntil?: Date | null }): WorkRow {
  return {
    id: `work-${input.triggerId}`,
    teamId: 'team-1',
    kind: 'poll_source',
    key: pollWorkKey(input.triggerId),
    payload: { triggerId: input.triggerId },
    dueAt: new Date(0),
    intervalMs: null,
    attempts: input.leaseUntil ? 1 : 0,
    deferrals: 0,
    leaseOwner: input.leaseUntil ? 'other' : null,
    leaseUntil: input.leaseUntil ?? null,
    leaseToken: input.leaseUntil ? 'token' : null,
    updatedAt: new Date(0),
  };
}

function armedAt(triggerId: string, dueAt: Date) {
  return {
    kind: 'poll_source',
    key: `poll_source:${triggerId}`,
    teamId: 'team-1',
    payload: { triggerId },
    dueAt,
  };
}

function poll(triggerId: string) {
  return pollSourceHandler.run({ triggerId }, testWorkContext(NOW));
}

beforeEach(() => {
  rows = [];
  updates.length = 0;
  getEventsMock.mockReset();
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({});
  jest.clearAllMocks();
  listWorkByKind.mockResolvedValue([]);
  pollIntervalSeconds = 300;
});

describe('pollSourceHandler', () => {
  it('polls the source, dispatches each event, advances the checkpoint, and re-arms one interval later', async () => {
    rows = [row()];
    getEventsMock.mockResolvedValue({
      events: [event({ externalId: 'a' }), event({ externalId: 'b' })],
      checkpoint: { updatedAfter: '2026-06-19T11:59:00Z' },
    });

    await poll(T1);

    // The listener's automation rides along, so a source whose events concern
    // automations can keep one from being told about itself.
    expect(getEventsMock).toHaveBeenCalledWith({
      config: {},
      checkpoint: undefined,
      movementId: 'mov-1',
    });
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    // checkpoint + poll_last_at advanced once, after the pull.
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(T1);
    expect(updates[0].set.poll_last_at).toBe(NOW);
    expect(enqueueWork).toHaveBeenCalledTimes(1);
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, new Date(NOW.getTime() + 300_000)));
  });

  it('re-arms at the per-trigger interval override from config (P4)', async () => {
    rows = [row({ config: { pollIntervalSeconds: 30 } })];
    getEventsMock.mockResolvedValue({ events: [], checkpoint: null });
    await poll(T1);
    expect(getEventsMock).toHaveBeenCalled();
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, new Date(NOW.getTime() + 30_000)));
  });

  it('an early row (poll_last_at within the interval) skips the pull and re-arms', async () => {
    rows = [row({ poll_last_at: new Date(NOW.getTime() - 60_000) })]; // 60s ago, interval 300s
    await poll(T1);
    expect(getEventsMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, new Date(NOW.getTime() + 300_000)));
  });

  it('does NOT advance the checkpoint or re-arm when the pull throws (the drain retries the row)', async () => {
    rows = [row()];
    getEventsMock.mockRejectedValue(new Error('granola 500'));
    await expect(poll(T1)).rejects.toThrow('granola 500');
    expect(updates).toHaveLength(0);
    expect(enqueueWork).not.toHaveBeenCalled();
  });

  it('returns without polling or re-arming when the trigger disappeared', async () => {
    await poll(T1);
    expect(getEventsMock).not.toHaveBeenCalled();
    expect(enqueueWork).not.toHaveBeenCalled();
  });

  it('treats a paused trigger (run_mode off) as gone', async () => {
    rows = [row({ run_mode: 'off' })];
    await poll(T1);
    expect(getEventsMock).not.toHaveBeenCalled();
    expect(enqueueWork).not.toHaveBeenCalled();
  });

  it('ignores a trigger whose kind is not a registered PollSource', async () => {
    rows = [row({ kind: 'attio' })];
    await poll(T1);
    expect(getEventsMock).not.toHaveBeenCalled();
    expect(enqueueWork).not.toHaveBeenCalled();
  });

  it('rejects a payload without a trigger id', async () => {
    await expect(pollSourceHandler.run({}, testWorkContext(NOW))).rejects.toThrow();
  });
});

describe('pollReconcileHandler', () => {
  it('arms one row per candidate: now if never polled, else last poll + interval', async () => {
    const lastPolled = new Date(NOW.getTime() - 60_000);
    rows = [
      row({ id: T1 }),
      row({ id: T2, poll_last_at: lastPolled, config: { pollIntervalSeconds: 30 } }),
      row({ id: 'not-a-poll-source', kind: 'attio' }),
    ];
    await pollReconcileHandler.run({}, testWorkContext(NOW));
    expect(enqueueWork).toHaveBeenCalledTimes(2);
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, NOW));
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T2, new Date(lastPolled.getTime() + 30_000)));
    expect(getEventsMock).not.toHaveBeenCalled();
  });

  it('removes the rows of triggers that went away, and keeps the active ones', async () => {
    rows = [row({ id: T1 }), row({ id: T2, run_mode: 'off' })];
    listWorkByKind.mockResolvedValue([workRow({ triggerId: T1 }), workRow({ triggerId: T2 })]);
    await pollReconcileHandler.run({}, testWorkContext(NOW));
    expect(listWorkByKind).toHaveBeenCalledWith('poll_source');
    expect(removeWork).toHaveBeenCalledTimes(1);
    expect(removeWork).toHaveBeenCalledWith({ key: pollWorkKey(T2) });
  });

  it('leaves a leased row to its running handler', async () => {
    rows = [row({ id: T1 })];
    listWorkByKind.mockResolvedValue([
      workRow({ triggerId: T1, leaseUntil: new Date(NOW.getTime() + 60_000) }),
    ]);
    await pollReconcileHandler.run({}, testWorkContext(NOW));
    expect(enqueueWork).not.toHaveBeenCalled();
    expect(removeWork).not.toHaveBeenCalled();
  });
});

describe('pollTriggerNow', () => {
  it('forces a poll inside the interval and surfaces the event count', async () => {
    rows = [row({ poll_last_at: new Date(NOW.getTime() - 60_000) })]; // 60s ago, interval 300s
    getEventsMock.mockResolvedValue({ events: [event()], checkpoint: null });
    await expect(pollTriggerNow({ triggerId: T1, now: NOW })).resolves.toEqual({
      found: true,
      eventCount: 1,
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
  });

  it('reports an unknown trigger as not found', async () => {
    await expect(pollTriggerNow({ triggerId: T1, now: NOW })).resolves.toEqual({
      found: false,
      eventCount: 0,
    });
  });
});

describe('registerPollWork', () => {
  it('registers the per-trigger and the reconcile handlers', () => {
    registerPollWork();
    expect(registerWorkHandler).toHaveBeenCalledWith('poll_source', pollSourceHandler);
    expect(registerWorkHandler).toHaveBeenCalledWith('poll_reconcile', pollReconcileHandler);
  });
});
