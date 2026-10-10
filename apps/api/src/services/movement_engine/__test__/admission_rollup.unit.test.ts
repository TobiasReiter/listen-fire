// The admission dry run's daily roll-up: verdicts drained into one operator
// event row per process per day, and summed back into the burn-down.

const writes: Array<{ op: 'insert' | 'update'; detail: unknown; id?: string }> = [];
const triggerRuns = new Map<string, string>();
const deletedRows = new Set<string>();
const selects: string[] = [];
let failNextWrite = false;

jest.mock('../../../lib/kysely', () => {
  const { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } = jest.requireActual('kysely');
  // Reads compile for real, and answer nothing: what a test asserts is the SQL.
  const reads = new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db: unknown) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event: { query: { sql: string } }) => selects.push(event.query.sql),
  });
  const write = (op: 'insert' | 'update', detail: unknown, id?: string) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('test: the database is down');
    }
    writes.push({ op, detail: structuredClone(detail), ...(id !== undefined ? { id } : {}) });
  };
  return {
    getQb: () => ({
      selectFrom: (table: string) => reads.selectFrom(table),
      insertInto: () => ({
        values: (row: { detail: unknown }) => ({
          returning: () => ({
            executeTakeFirstOrThrow: async () => {
              write('insert', row.detail);
              return { id: `event-${writes.length}` };
            },
          }),
        }),
      }),
      updateTable: () => ({
        set: (row: { detail: unknown }) => ({
          where: (_column: string, _op: string, id: string) => ({
            executeTakeFirst: async () => {
              if (deletedRows.has(id)) return { numUpdatedRows: 0n };
              write('update', row.detail, id);
              return { numUpdatedRows: 1n };
            },
          }),
        }),
      }),
    }),
    getAutomationsQb: () => ({
      selectFrom: () => ({
        select: () => ({
          where: (_column: string, _op: string, ids: string[]) => ({
            execute: async () => ids.flatMap((id) => (triggerRuns.has(id) ? [{ id, trigger_id: triggerRuns.get(id) }] : [])),
          }),
        }),
      }),
    }),
  };
});

import {
  ADMISSION_ROLLUP_KIND,
  AUTOMATIONS_KEPT,
  UNKNOWN_AUTOMATION,
  addVerdict,
  flushAdmissionRollup,
  readAdmissionRollup,
  readAdmissionRollups,
  resetAdmissionRollupForTests,
  summariseAdmissionRollups,
  type AdmissionRollup,
} from '../admission_rollup';
import { OTHER_REASONS, REASONS_KEPT, admissionVerdicts, holdAdmissionVerdict, resetRustRunStats } from '../rust_stats';

const RUN_A = '00000000-0000-0000-0000-00000000000a';
const RUN_B = '00000000-0000-0000-0000-00000000000b';
const RUN_C = '00000000-0000-0000-0000-00000000000c';
const DAY_1 = new Date('2026-10-09T10:00:00Z');
const DAY_2 = new Date('2026-10-10T00:01:00Z');

beforeEach(() => {
  writes.length = 0;
  triggerRuns.clear();
  triggerRuns.set(RUN_A, 'automation-1');
  triggerRuns.set(RUN_B, 'automation-2');
  failNextWrite = false;
  deletedRows.clear();
  selects.length = 0;
  resetRustRunStats();
  resetAdmissionRollupForTests();
});

describe('flushing the verdicts', () => {
  it("opens a new row when the day's row is gone, rather than losing its counts", async () => {
    holdAdmissionVerdict({ runId: RUN_A, languageVersion: 3, reasons: ['plugin_call'] });
    await flushAdmissionRollup({ now: DAY_1 });
    deletedRows.add('event-1');
    holdAdmissionVerdict({ runId: RUN_A, languageVersion: 3, reasons: ['plugin_call'] });
    await flushAdmissionRollup({ now: DAY_1 });
    expect(writes.map(({ op }) => op)).toEqual(['insert', 'insert']);
    expect(writes[1]?.detail).toMatchObject({ versions: { '3': { sampled: 2 } } });
  });

  it('writes nothing when no dry run found anything', async () => {
    await expect(flushAdmissionRollup({ now: DAY_1 })).resolves.toBe(0);
    expect(writes).toEqual([]);
  });

  it("opens one row for the process's day, rewrites it as the day goes on, and opens another on a new day", async () => {
    holdAdmissionVerdict({ runId: RUN_A, languageVersion: 3, reasons: ['plugin_call', 'statement:call'] });
    holdAdmissionVerdict({ runId: RUN_B, languageVersion: 2, reasons: [] });
    await expect(flushAdmissionRollup({ now: DAY_1 })).resolves.toBe(2);
    holdAdmissionVerdict({ runId: RUN_A, languageVersion: 3, reasons: ['plugin_call'] });
    // A run with no trigger run row, and a run id that is not one.
    holdAdmissionVerdict({ runId: RUN_C, languageVersion: 3, reasons: ['statement:call'] });
    holdAdmissionVerdict({ runId: 'dev-script-run', languageVersion: 3, reasons: ['statement:call'] });
    await flushAdmissionRollup({ now: DAY_1 });
    holdAdmissionVerdict({ runId: RUN_B, languageVersion: 3, reasons: ['plugin_call'] });
    await flushAdmissionRollup({ now: DAY_2 });

    expect(writes.map(({ op, id }) => [op, id])).toEqual([
      ['insert', undefined],
      ['update', 'event-1'],
      ['insert', undefined],
    ]);
    expect(writes[1]?.detail).toEqual({
      kind: ADMISSION_ROLLUP_KIND,
      day: '2026-10-09',
      versions: {
        '2': { sampled: 1, admitted: 1, first: {}, all: {} },
        '3': { sampled: 4, admitted: 0, first: { plugin_call: 2, 'statement:call': 2 }, all: { plugin_call: 2, 'statement:call': 3 } },
      },
      automations: {
        first: { plugin_call: { 'automation-1': 2 }, 'statement:call': { [UNKNOWN_AUTOMATION]: 2 } },
        all: { plugin_call: { 'automation-1': 2 }, 'statement:call': { 'automation-1': 1, [UNKNOWN_AUTOMATION]: 2 } },
      },
      overflow: { first: {}, all: {} },
    });
    expect(writes[2]?.detail).toMatchObject({ day: '2026-10-10', versions: { '3': { sampled: 1 } } });
    expect(admissionVerdicts).toEqual([]);
  });

  it('holds the verdicts again when the write fails, for the next flush to write', async () => {
    holdAdmissionVerdict({ runId: RUN_A, languageVersion: 3, reasons: ['plugin_call'] });
    failNextWrite = true;
    await expect(flushAdmissionRollup({ now: DAY_1 })).rejects.toThrow('the database is down');
    expect(admissionVerdicts).toHaveLength(1);
    await flushAdmissionRollup({ now: DAY_1 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ op: 'insert', detail: { versions: { '3': { sampled: 1 } } } });
  });
});

describe('a row stays small', () => {
  const empty = (): AdmissionRollup => ({ kind: ADMISSION_ROLLUP_KIND, day: '2026-10-09', versions: {}, automations: { first: {}, all: {} }, overflow: { first: {}, all: {} } });

  it(`names ${AUTOMATIONS_KEPT} automations a reason blocked, and counts the runs of any more`, () => {
    const rollup = empty();
    for (let i = 0; i <= AUTOMATIONS_KEPT + 1; i++) addVerdict(rollup, { runId: `r${i}`, languageVersion: 3, reasons: ['plugin_call'] }, `a${i}`);
    // One already named is still counted by name.
    addVerdict(rollup, { runId: 'again', languageVersion: 3, reasons: ['plugin_call'] }, 'a0');
    expect(Object.keys(rollup.automations.first.plugin_call ?? {})).toHaveLength(AUTOMATIONS_KEPT);
    expect(rollup.automations.first.plugin_call?.a0).toBe(2);
    expect(rollup.overflow).toEqual({ first: { plugin_call: 2 }, all: { plugin_call: 2 } });
    expect(summariseAdmissionRollups([rollup]).first[0]).toMatchObject({ reason: 'plugin_call', runs: AUTOMATIONS_KEPT + 3, automations: AUTOMATIONS_KEPT, unnamedRuns: 2 });
  });

  it(`keeps ${REASONS_KEPT} reasons by name, and counts any more as "${OTHER_REASONS}"`, () => {
    const rollup = empty();
    for (let i = 0; i < REASONS_KEPT + 3; i++) addVerdict(rollup, { runId: `r${i}`, languageVersion: 3, reasons: [`reason_${i}`, `also_${i}`] }, 'a1');
    const tally = rollup.versions['3'];
    expect(Object.keys(tally?.first ?? {})).toHaveLength(REASONS_KEPT + 1);
    expect(tally?.first[OTHER_REASONS]).toBe(3);
    expect(Object.keys(tally?.all ?? {})).toHaveLength(REASONS_KEPT + 1);
    expect(Object.keys(rollup.automations.first)).toHaveLength(REASONS_KEPT + 1);
    expect(rollup.automations.first[OTHER_REASONS]).toEqual({ a1: 3 });
    expect(Object.keys(rollup.automations.all)).toHaveLength(REASONS_KEPT + 1);
    // Both of a run's reasons past the cap are one "other", counted once.
    expect(rollup.automations.all[OTHER_REASONS]).toEqual({ a1: 103 });
  });
});

describe('reading the roll-ups back', () => {
  it('asks the database for roll-up rows only, within the window', async () => {
    await expect(readAdmissionRollups(7)).resolves.toEqual([]);
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain(`detail->>'kind' = $`);
    expect(selects[0]).toContain('make_interval(days => $');
  });

  it('reads only a roll-up as one', () => {
    expect(readAdmissionRollup({ text: 'a run failed' })).toBeUndefined();
    expect(readAdmissionRollup(null)).toBeUndefined();
    const rollup: AdmissionRollup = { kind: ADMISSION_ROLLUP_KIND, day: '2026-10-09', versions: {}, automations: { first: {}, all: {} }, overflow: { first: {}, all: {} } };
    expect(readAdmissionRollup(rollup)).toEqual(rollup);
    // A row written before automations were capped reads with no overflow.
    const { overflow: _overflow, ...uncapped } = rollup;
    expect(readAdmissionRollup(uncapped)).toEqual(rollup);
  });

  it('sums every row into the burn-down, most demanded reason first, its five busiest automations named', () => {
    const tally = (sampled: number, admitted: number, first: Record<string, number>, all: Record<string, number>) => ({ sampled, admitted, first, all });
    const report = summariseAdmissionRollups([
      {
        kind: ADMISSION_ROLLUP_KIND,
        day: '2026-10-09',
        versions: { '3': tally(10, 4, { plugin_call: 5, exists_node: 1 }, { plugin_call: 5, exists_node: 3 }) },
        automations: {
          first: { plugin_call: { a1: 1, a2: 1, a3: 1, a4: 1, a5: 1 }, exists_node: { a1: 1 } },
          all: { plugin_call: { a1: 1, a2: 1, a3: 1, a4: 1, a5: 1 }, exists_node: { a1: 3 } },
        },
        overflow: { first: {}, all: {} },
      },
      {
        kind: ADMISSION_ROLLUP_KIND,
        day: '2026-10-08',
        versions: { '2': tally(3, 0, { exists_node: 3 }, { exists_node: 3 }) },
        automations: { first: { exists_node: { a6: 3 } }, all: { exists_node: { a6: 3 } } },
        overflow: { first: { exists_node: 7 }, all: {} },
      },
    ]);
    expect(report.days).toEqual(['2026-10-08', '2026-10-09']);
    expect(report.total).toEqual(tally(13, 4, { plugin_call: 5, exists_node: 4 }, { plugin_call: 5, exists_node: 6 }));
    expect(Object.keys(report.versions)).toEqual(['2', '3']);
    expect(report.first).toEqual([
      // Seven runs of automations past the ones a row names: counted, not named.
      { reason: 'exists_node', runs: 11, automations: 2, unnamedRuns: 7, top: [{ automation: 'a6', runs: 3 }, { automation: 'a1', runs: 1 }] },
      { reason: 'plugin_call', runs: 5, automations: 5, unnamedRuns: 0, top: ['a1', 'a2', 'a3', 'a4', 'a5'].map((automation) => ({ automation, runs: 1 })) },
    ]);
    expect(report.all.map((row) => [row.reason, row.runs])).toEqual([
      ['exists_node', 6],
      ['plugin_call', 5],
    ]);
  });
});
