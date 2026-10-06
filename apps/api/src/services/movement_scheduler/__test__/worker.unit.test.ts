// The movement scheduler's cron semantics — the REAL cron math
// (@listen-fire/shared/cron) over a faked trigger table, work store and
// dispatch seam:
//
// fire_cron (one trigger's row):
//   1. first sight establishes the checkpoint WITHOUT firing, and arms the
//      next occurrence
//   2. an occurrence due since the checkpoint advances the mark BEFORE
//      dispatching one tick (payload carries the occurrence + the schedule),
//      then the row is re-armed for the occurrence after
//   3. several missed occurrences collapse into ONE tick
//   4. nothing due yet → no dispatch, mark untouched, re-armed at the due time
//   5. an invalid schedule is tolerated (logged, never thrown, not re-armed)
//   6. a paused or deleted trigger → nothing fires, nothing re-armed
//
// cron_reconcile (periodic):
//   7. one row per active trigger at its computed due time
//   8. a row whose trigger is paused or gone is removed
//   9. a leased row is left to its running handler

jest.mock('../../../lib/kysely', () => {
  const rows: Array<Record<string, unknown>> = [];
  type Clause = { col: string; op: string; value: unknown };
  function matches(row: Record<string, unknown>, clauses: Clause[]): boolean {
    return clauses.every(({ col, op, value }) => {
      if (op === '=') return row[col] === value;
      if (op === '!=') return row[col] !== value;
      if (op === 'is not') return row[col] !== value;
      throw new Error(`fake kysely: unsupported operator ${op}`);
    });
  }
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function select(clauses: Clause[]): any {
    return {
      where: (col: string, op: string, value: unknown) => select([...clauses, { col, op, value }]),
      select: () => select(clauses),
      execute: async () => rows.filter((r) => matches(r, clauses)).map((r) => ({ ...r })),
      executeTakeFirst: async () => {
        const row = rows.find((r) => matches(r, clauses));
        return row ? { ...row } : undefined;
      },
    };
  }
  const api: any = {
    selectFrom: () => select([]),
    updateTable: () => {
      const update: any = { patch: {} as Record<string, unknown> };
      update.set = (p: Record<string, unknown>) => {
        update.patch = p;
        return update;
      };
      update.where = (_col: string, _op: string, id: unknown) => {
        const row = rows.find((r) => r.id === id);
        if (row) Object.assign(row, update.patch);
        return update;
      };
      update.execute = async () => [];
      return update;
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { getAutomationsQb: () => api, __rows: rows };
});

jest.mock('../../translation_graph/triggers/router', () => ({
  dispatchTriggerByIdEvent: jest.fn(async () => ({ evaluations: [], movementFirings: [] })),
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
import { cronReconcileHandler, cronWorkKey, fireCronHandler, registerCronWork } from '../worker';

const { __rows } = jest.requireMock('../../../lib/kysely') as {
  __rows: Array<Record<string, unknown>>;
};
const { dispatchTriggerByIdEvent } = jest.requireMock(
  '../../translation_graph/triggers/router',
) as { dispatchTriggerByIdEvent: jest.Mock };
const { enqueueWork, removeWork, listWorkByKind } = jest.requireMock('../../work/store') as {
  enqueueWork: jest.Mock;
  removeWork: jest.Mock;
  listWorkByKind: jest.Mock;
};
const { registerWorkHandler } = jest.requireMock('../../work/drain') as {
  registerWorkHandler: jest.Mock;
};
const { logger } = jest.requireMock('../../logger') as { logger: { warn: jest.Mock } };

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

function cronRow(input: {
  id: string;
  schedule?: string;
  timezone?: string;
  lastFiredAt?: Date | null;
  runMode?: string;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (input.schedule !== undefined) config.schedule = input.schedule;
  if (input.timezone !== undefined) config.timezone = input.timezone;
  return {
    id: input.id,
    team_id: 'team-1',
    name: `movement/file/${input.id}`,
    kind: 'cron',
    movement_id: 'mov-1',
    run_mode: input.runMode ?? 'live',
    config,
    cron_last_fired_at: input.lastFiredAt ?? null,
  };
}

function workRow(input: { triggerId: string; leaseUntil?: Date | null }): WorkRow {
  return {
    id: `work-${input.triggerId}`,
    teamId: 'team-1',
    kind: 'fire_cron',
    key: cronWorkKey(input.triggerId),
    payload: { triggerId: input.triggerId },
    dueAt: new Date(0),
    intervalMs: null,
    attempts: input.leaseUntil ? 1 : 0,
    leaseOwner: input.leaseUntil ? 'other' : null,
    leaseUntil: input.leaseUntil ?? null,
    leaseToken: input.leaseUntil ? 'token' : null,
    updatedAt: new Date(0),
  };
}

function armedAt(triggerId: string, dueAt: Date) {
  return {
    kind: 'fire_cron',
    key: `fire_cron:${triggerId}`,
    teamId: 'team-1',
    payload: { triggerId },
    dueAt,
  };
}

function fire(triggerId: string, now: Date) {
  return fireCronHandler.run({ triggerId }, testWorkContext(now));
}

beforeEach(() => {
  __rows.length = 0;
  jest.clearAllMocks();
  listWorkByKind.mockResolvedValue([]);
});

const MONDAY_TEN = new Date('2026-06-08T10:00:00.000Z'); // a Monday, 10:00 UTC
const NEXT_MONDAY_NINE = new Date('2026-06-15T09:00:00.000Z');

describe('fireCronHandler', () => {
  it('first sight establishes the checkpoint without firing and arms the next occurrence', async () => {
    __rows.push(cronRow({ id: T1, schedule: '0 9 * * 1', lastFiredAt: null }));
    await fire(T1, MONDAY_TEN);
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
    expect(__rows[0].cron_last_fired_at).toEqual(MONDAY_TEN);
    expect(enqueueWork).toHaveBeenCalledTimes(1);
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, NEXT_MONDAY_NINE));
  });

  it('fires one tick when an occurrence came due, carrying the occurrence + schedule', async () => {
    __rows.push(
      cronRow({
        id: T1,
        schedule: '0 9 * * 1',
        lastFiredAt: new Date('2026-06-08T08:00:00.000Z'),
      }),
    );
    await fire(T1, MONDAY_TEN);
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledTimes(1);
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerId: T1,
        teamId: 'team-1',
        event: expect.objectContaining({
          adapterType: 'cron',
          triggerType: 'webhook',
          payload: {
            firedAt: '2026-06-08T09:00:00.000Z',
            schedule: '0 9 * * 1',
          },
        }),
      }),
    );
    expect(__rows[0].cron_last_fired_at).toEqual(MONDAY_TEN);
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, NEXT_MONDAY_NINE));
  });

  it('advances the checkpoint and arms the next occurrence before dispatching', async () => {
    __rows.push(
      cronRow({
        id: T1,
        schedule: '0 9 * * 1',
        lastFiredAt: new Date('2026-06-08T08:00:00.000Z'),
      }),
    );
    let seenAtDispatch: { checkpoint: unknown; enqueued: number } | null = null;
    dispatchTriggerByIdEvent.mockImplementationOnce(async () => {
      seenAtDispatch = {
        checkpoint: __rows[0].cron_last_fired_at,
        enqueued: enqueueWork.mock.calls.length,
      };
      return { evaluations: [], movementFirings: [] };
    });
    await fire(T1, MONDAY_TEN);
    expect(seenAtDispatch).toEqual({ checkpoint: MONDAY_TEN, enqueued: 1 });
  });

  it('a throwing dispatch still leaves the next occurrence armed and the mark advanced', async () => {
    __rows.push(
      cronRow({
        id: T1,
        schedule: '0 9 * * 1',
        lastFiredAt: new Date('2026-06-08T08:00:00.000Z'),
      }),
    );
    dispatchTriggerByIdEvent.mockRejectedValueOnce(new Error('dispatch down'));
    await expect(fire(T1, MONDAY_TEN)).rejects.toThrow('dispatch down');
    expect(__rows[0].cron_last_fired_at).toEqual(MONDAY_TEN);
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, NEXT_MONDAY_NINE));
  });

  it('collapses several missed occurrences into one tick', async () => {
    // Every 15 minutes, last fired two hours ago → 8 missed occurrences.
    __rows.push(
      cronRow({
        id: T1,
        schedule: '*/15 * * * *',
        lastFiredAt: new Date('2026-06-08T08:00:00.000Z'),
      }),
    );
    await fire(T1, MONDAY_TEN);
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledTimes(1);
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, new Date('2026-06-08T10:15:00.000Z')));
  });

  it('does not dispatch when the occurrence is not yet due, and re-arms at the due time', async () => {
    // Hourly schedule, checkpoint just after the 10:00 occurrence —
    // nothing comes due before 11:00.
    const justFired = new Date('2026-06-08T10:00:30.000Z');
    __rows.push(cronRow({ id: T1, schedule: '0 * * * *', lastFiredAt: justFired }));
    await fire(T1, new Date('2026-06-08T10:30:00.000Z'));
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
    expect(__rows[0].cron_last_fired_at).toEqual(justFired);
    expect(enqueueWork).toHaveBeenCalledTimes(1);
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, new Date('2026-06-08T11:00:00.000Z')));
  });

  it('tolerates an invalid schedule: no dispatch, no re-arm, no throw', async () => {
    __rows.push(cronRow({ id: T1, schedule: '99 9 * * 1', lastFiredAt: new Date(0) }));
    await expect(fire(T1, MONDAY_TEN)).resolves.toBeUndefined();
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
    expect(enqueueWork).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[MovementScheduler] invalid schedule on cron trigger',
      expect.objectContaining({ triggerId: T1 }),
    );
  });

  it('interprets a schedule in the configured timezone, tracking DST (BST → 08:00Z)', async () => {
    // `0 9 * * *` Europe/London == 09:00 LOCAL. On 6 Jul 2026 (BST, UTC+1)
    // that is 08:00Z — the handler must fire the tick at the correct instant.
    __rows.push(
      cronRow({
        id: T1,
        schedule: '0 9 * * *',
        timezone: 'Europe/London',
        lastFiredAt: new Date('2026-07-06T07:00:00.000Z'),
      }),
    );
    await fire(T1, new Date('2026-07-06T08:30:00.000Z'));
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledTimes(1);
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          payload: { firedAt: '2026-07-06T08:00:00.000Z', schedule: '0 9 * * *' },
        }),
      }),
    );
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, new Date('2026-07-07T08:00:00.000Z')));
  });

  it('same schedule in winter (GMT) fires at 09:00Z', async () => {
    __rows.push(
      cronRow({
        id: T1,
        schedule: '0 9 * * *',
        timezone: 'Europe/London',
        lastFiredAt: new Date('2026-01-05T07:00:00.000Z'),
      }),
    );
    await fire(T1, new Date('2026-01-05T09:30:00.000Z'));
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledTimes(1);
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          payload: { firedAt: '2026-01-05T09:00:00.000Z', schedule: '0 9 * * *' },
        }),
      }),
    );
  });

  it('a paused trigger (run_mode off) neither fires nor re-arms', async () => {
    __rows.push(
      cronRow({
        id: T1,
        schedule: '0 9 * * 1',
        lastFiredAt: new Date('2026-06-08T08:00:00.000Z'),
        runMode: 'off',
      }),
    );
    await fire(T1, MONDAY_TEN);
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
    expect(enqueueWork).not.toHaveBeenCalled();
  });

  it('a deleted trigger neither fires nor re-arms', async () => {
    await fire(T1, MONDAY_TEN);
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
    expect(enqueueWork).not.toHaveBeenCalled();
  });

  it('rejects a payload without a trigger id', async () => {
    await expect(fireCronHandler.run({}, testWorkContext(MONDAY_TEN))).rejects.toThrow();
  });
});

describe('cronReconcileHandler', () => {
  it('arms one row per active trigger at its computed due time', async () => {
    __rows.push(
      cronRow({
        id: T1,
        schedule: '0 9 * * 1',
        lastFiredAt: new Date('2026-06-08T08:00:00.000Z'),
      }),
      cronRow({ id: T2, schedule: '0 * * * *', lastFiredAt: new Date('2026-06-08T10:00:30.000Z') }),
    );
    await cronReconcileHandler.run({}, testWorkContext(MONDAY_TEN));
    expect(enqueueWork).toHaveBeenCalledTimes(2);
    // Missed while nothing ran: due in the past, so the drain fires it at once.
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, new Date('2026-06-08T09:00:00.000Z')));
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T2, new Date('2026-06-08T11:00:00.000Z')));
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
  });

  it('first sight sets the checkpoint and arms the next occurrence without dispatching', async () => {
    __rows.push(cronRow({ id: T1, schedule: '0 9 * * 1', lastFiredAt: null }));
    await cronReconcileHandler.run({}, testWorkContext(MONDAY_TEN));
    expect(__rows[0].cron_last_fired_at).toEqual(MONDAY_TEN);
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, NEXT_MONDAY_NINE));
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
  });

  it('removes the row of a trigger now off, and keeps the active ones', async () => {
    __rows.push(
      cronRow({ id: T1, schedule: '0 9 * * 1', lastFiredAt: MONDAY_TEN }),
      cronRow({ id: T2, schedule: '0 9 * * 1', lastFiredAt: MONDAY_TEN, runMode: 'off' }),
    );
    listWorkByKind.mockResolvedValue([workRow({ triggerId: T1 }), workRow({ triggerId: T2 })]);
    await cronReconcileHandler.run({}, testWorkContext(MONDAY_TEN));
    expect(listWorkByKind).toHaveBeenCalledWith('fire_cron');
    expect(removeWork).toHaveBeenCalledTimes(1);
    expect(removeWork).toHaveBeenCalledWith({ key: cronWorkKey(T2) });
    expect(enqueueWork).toHaveBeenCalledTimes(1);
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T1, NEXT_MONDAY_NINE));
  });

  it('removes the row of a deleted trigger', async () => {
    listWorkByKind.mockResolvedValue([workRow({ triggerId: T1 })]);
    await cronReconcileHandler.run({}, testWorkContext(MONDAY_TEN));
    expect(removeWork).toHaveBeenCalledWith({ key: cronWorkKey(T1) });
  });

  it('leaves a leased row to its running handler', async () => {
    __rows.push(cronRow({ id: T1, schedule: '0 9 * * 1', lastFiredAt: new Date(0) }));
    listWorkByKind.mockResolvedValue([
      workRow({ triggerId: T1, leaseUntil: new Date(MONDAY_TEN.getTime() + 60_000) }),
    ]);
    await cronReconcileHandler.run({}, testWorkContext(MONDAY_TEN));
    expect(enqueueWork).not.toHaveBeenCalled();
    expect(removeWork).not.toHaveBeenCalled();
  });

  it('tolerates an invalid schedule and still arms the other triggers', async () => {
    __rows.push(
      cronRow({ id: T1, schedule: '99 9 * * 1', lastFiredAt: new Date(0) }),
      cronRow({ id: T2, schedule: '0 9 * * 1', lastFiredAt: MONDAY_TEN }),
    );
    await expect(cronReconcileHandler.run({}, testWorkContext(MONDAY_TEN))).resolves.toBeUndefined();
    expect(enqueueWork).toHaveBeenCalledTimes(1);
    expect(enqueueWork).toHaveBeenCalledWith(armedAt(T2, NEXT_MONDAY_NINE));
  });
});

describe('registerCronWork', () => {
  it('registers the per-trigger and the reconcile handlers', () => {
    registerCronWork();
    expect(registerWorkHandler).toHaveBeenCalledWith('fire_cron', fireCronHandler);
    expect(registerWorkHandler).toHaveBeenCalledWith('cron_reconcile', cronReconcileHandler);
  });
});
