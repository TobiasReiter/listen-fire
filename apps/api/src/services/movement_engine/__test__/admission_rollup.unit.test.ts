// The admission dry run's daily roll-up: verdicts drained into one operator
// event row per process per day, and summed back into the burn-down.

const writes: Array<{ op: 'insert' | 'update'; detail: unknown; id?: string }> = [];
const triggerRuns = new Map<string, string>();
let failNextWrite = false;

jest.mock('../../../lib/kysely', () => {
  const write = (op: 'insert' | 'update', detail: unknown, id?: string) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('test: the database is down');
    }
    writes.push({ op, detail: structuredClone(detail), ...(id !== undefined ? { id } : {}) });
  };
  return {
    getQb: () => ({
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
            execute: async () => write('update', row.detail, id),
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
  UNKNOWN_AUTOMATION,
  flushAdmissionRollup,
  readAdmissionRollup,
  resetAdmissionRollupForTests,
  summariseAdmissionRollups,
  type AdmissionRollup,
} from '../admission_rollup';
import { admissionVerdicts, holdAdmissionVerdict, resetRustRunStats } from '../rust_stats';

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
  resetRustRunStats();
  resetAdmissionRollupForTests();
});

describe('flushing the verdicts', () => {
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

describe('reading the roll-ups back', () => {
  it('reads only a roll-up as one', () => {
    expect(readAdmissionRollup({ text: 'a run failed' })).toBeUndefined();
    expect(readAdmissionRollup(null)).toBeUndefined();
    const rollup: AdmissionRollup = { kind: ADMISSION_ROLLUP_KIND, day: '2026-10-09', versions: {}, automations: { first: {}, all: {} } };
    expect(readAdmissionRollup(rollup)).toEqual(rollup);
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
      },
      {
        kind: ADMISSION_ROLLUP_KIND,
        day: '2026-10-08',
        versions: { '2': tally(3, 0, { exists_node: 3 }, { exists_node: 3 }) },
        automations: { first: { exists_node: { a6: 3 } }, all: { exists_node: { a6: 3 } } },
      },
    ]);
    expect(report.days).toEqual(['2026-10-08', '2026-10-09']);
    expect(report.total).toEqual(tally(13, 4, { plugin_call: 5, exists_node: 4 }, { plugin_call: 5, exists_node: 6 }));
    expect(Object.keys(report.versions)).toEqual(['2', '3']);
    expect(report.first).toEqual([
      { reason: 'plugin_call', runs: 5, automations: 5, top: ['a1', 'a2', 'a3', 'a4', 'a5'].map((automation) => ({ automation, runs: 1 })) },
      { reason: 'exists_node', runs: 4, automations: 2, top: [{ automation: 'a6', runs: 3 }, { automation: 'a1', runs: 1 }] },
    ]);
    expect(report.all.map((row) => [row.reason, row.runs])).toEqual([
      ['exists_node', 6],
      ['plugin_call', 5],
    ]);
  });
});
