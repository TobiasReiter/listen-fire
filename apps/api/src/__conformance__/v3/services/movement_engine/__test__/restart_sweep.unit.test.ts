// A run row left `running` by a process death has nothing left to settle it —
// the firing that owned it is gone with the process. Without a sweep it stays
// `running` forever, holding its asks open as live forms.
//
// What these tests pin is the CRITERION, because that is the part that can do
// damage: too loose and it settles a run that is genuinely executing. The
// criterion is this process's own boot — a `running` row older than that was
// written by a process that has since let the background lock go.

interface Row {
  [column: string]: unknown;
}

const rows: { trigger_run: Row[]; parked_run: Row[] } = { trigger_run: [], parked_run: [] };

/** Every `.where()` the sweep applied, per table — the criterion, as asserted. */
const wheres: { trigger_run: unknown[][]; parked_run: unknown[][] } = {
  trigger_run: [],
  parked_run: [],
};

interface Chain {
  where(...args: unknown[]): Chain;
  select(...args: unknown[]): Chain;
  execute(): Promise<Row[]>;
}

function chainFor(table: keyof typeof rows): Chain {
  const chain: Chain = {
    where: (...args: unknown[]) => {
      wheres[table].push(args);
      return chain;
    },
    select: () => chain,
    execute: async () => rows[table],
  };
  return chain;
}

jest.mock('../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    selectFrom: (table: string) => {
      if (table === 'trigger_run' || table === 'parked_run') return chainFor(table);
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const settleUnresumableRun = jest.fn().mockResolvedValue(undefined);
jest.mock('../../interaction/run_failure', () => ({ settleUnresumableRun }));

const warn = jest.fn();
const error = jest.fn();
jest.mock('../../logger', () => ({ logger: { info: jest.fn(), warn, error } }));

import { processBootedAt, sweepRestartOrphanedRuns } from '../restart_sweep';

beforeEach(() => {
  rows.trigger_run = [];
  rows.parked_run = [];
  wheres.trigger_run = [];
  wheres.parked_run = [];
  settleUnresumableRun.mockClear();
  warn.mockClear();
  error.mockClear();
});

const ago = (ms: number) => new Date(Date.now() - ms);

/** A run that started before this process did — five minutes back, which the
 *  old six-hour bound would have left `running` until the evening. */
const BEFORE_BOOT = 5 * 60 * 1000;

describe('the restart-orphan sweep', () => {
  it('settles a run left running by a process death, saying why', async () => {
    rows.trigger_run = [{ id: 'run-dead', started_at: ago(BEFORE_BOOT) }];

    await sweepRestartOrphanedRuns();

    expect(settleUnresumableRun).toHaveBeenCalledWith({
      runId: 'run-dead',
      reason: expect.stringMatching(/restart/i),
    });
  });

  // The whole point of routing through `settleUnresumableRun` rather than a
  // bare status update: that path closes the run's asks with it.
  it('settles through the path that closes the run asks', async () => {
    rows.trigger_run = [{ id: 'run-dead', started_at: ago(BEFORE_BOOT) }];

    await sweepRestartOrphanedRuns();

    expect(settleUnresumableRun).toHaveBeenCalledTimes(1);
  });

  // A parked run is legitimately long-lived — it is waiting on a person, a
  // timer or an await, and it has its own live leaf rows saying so.
  it('leaves a parked run alone even when its row still reads running', async () => {
    rows.trigger_run = [{ id: 'run-parked', started_at: ago(BEFORE_BOOT) }];
    rows.parked_run = [{ run_id: 'run-parked' }];

    await sweepRestartOrphanedRuns();

    expect(settleUnresumableRun).not.toHaveBeenCalled();
  });

  it('asks only for running rows that started before this process booted', async () => {
    await sweepRestartOrphanedRuns();

    expect(wheres.trigger_run).toContainEqual(['status', '=', 'running']);

    const bootBound = wheres.trigger_run.find(
      ([column, operator]) => column === 'started_at' && operator === '<',
    );
    expect(bootBound).toBeDefined();

    // And only LIVE park leaves count as evidence of a legitimate park.
    expect(wheres.parked_run).toContainEqual(['status', '=', 'parked']);
  });

  // The bound itself, since the query is where it is applied: a run that
  // started five minutes ago is INSIDE it, where the old six-hour bound would
  // have left it running until the evening.
  it('bounds at this process’s boot, not hours before it', () => {
    expect(processBootedAt().getTime()).toBeGreaterThan(Date.now() - BEFORE_BOOT);
  });

  it('says nothing when there is nothing to settle', async () => {
    await sweepRestartOrphanedRuns();

    expect(settleUnresumableRun).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('one unsettleable row does not cost the others their settlement', async () => {
    rows.trigger_run = [
      { id: 'run-bad', started_at: ago(BEFORE_BOOT) },
      { id: 'run-good', started_at: ago(BEFORE_BOOT) },
    ];
    settleUnresumableRun.mockRejectedValueOnce(new Error('row is wedged'));

    await sweepRestartOrphanedRuns();

    expect(settleUnresumableRun).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalled();
  });
});
