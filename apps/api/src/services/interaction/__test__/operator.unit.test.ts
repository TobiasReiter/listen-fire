// Operator run-actions (control tower) — each delegates to an engine primitive
// after a team-scoped ownership check. We mock kysely (the ownership lookups) +
// the primitive and pin that abortRun → failRunAndCancelRequests, and that a
// cross-team / missing id is rejected BEFORE the primitive fires. (Ask answering
// / re-delivery are no longer operator run-actions — asks are adapter records
// answered through the one answer door; see ask_records.)

const TEAM_ID = 'team-1' as never;

// One configurable qb stub: `executeTakeFirst` returns whatever the test sets,
// so we can simulate "owned" (a row) vs "not found / wrong team" (undefined).
let ownedRow: Record<string, unknown> | undefined;
const stamps: unknown[][] = [];
function makeQbStub() {
  let stamping = false;
  const wheres: unknown[][] = [];
  const stub: any = {
    selectFrom: () => stub,
    updateTable: () => {
      stamping = true;
      return stub;
    },
    set: () => stub,
    returning: () => stub,
    where: (...args: unknown[]) => {
      wheres.push(args);
      return stub;
    },
    select: () => stub,
    executeTakeFirst: async () => {
      if (stamping) stamps.push(...wheres.filter((w) => w[0] === 'status'));
      return ownedRow;
    },
  };
  return stub;
}

const failRunAndCancelRequests = jest.fn();

jest.mock('../../../lib/kysely', () => ({
  getQb: jest.fn(() => makeQbStub()),
  getCoreQb: jest.fn(() => makeQbStub()),
  getKnowledgeQb: jest.fn(() => makeQbStub()),
  getAutomationsQb: jest.fn(() => makeQbStub()),
}));
// The run's lease: free unless a test says another process holds it.
let leaseHeldElsewhere = false;
jest.mock('../../movement_engine/run_lease', () => ({
  ...jest.requireActual('../../movement_engine/run_lease'),
  withRunLease: async (_runId: string, fn: () => Promise<unknown>) =>
    leaseHeldElsewhere ? { kind: 'busy' } : { kind: 'held', value: await fn() },
}));
const resumeLimitPausedRun = jest.fn();
jest.mock('../../movement_engine/limit_pause', () => ({
  resumeLimitPausedRun: (...args: unknown[]) => resumeLimitPausedRun(...args),
}));
jest.mock('../run_failure', () => ({
  ...jest.requireActual('../run_failure'),
  failRunAndCancelRequests: (...args: unknown[]) => failRunAndCancelRequests(...args),
}));

import { abortRun, resumeRun } from '../operator';
import { RunBusy } from '../../movement_engine/run_lease';
import { MovementEngineError } from '../../movement_engine/errors';

beforeEach(() => {
  failRunAndCancelRequests.mockReset().mockResolvedValue(undefined);
  resumeLimitPausedRun.mockReset().mockResolvedValue({ resumed: 1 });
  leaseHeldElsewhere = false;
  stamps.length = 0;
});

describe('abortRun', () => {
  it('delegates to failRunAndCancelRequests for an owned parked run', async () => {
    // The dual-behavior branching (running vs parked) is covered in depth by
    // abort_running.unit.test.ts; this just pins the still-immediate parked path.
    ownedRow = { id: 'run-1', status: 'parked' };
    const result = await abortRun({ runId: 'run-1', teamId: TEAM_ID, abortedBy: 'Ada' });
    expect(failRunAndCancelRequests).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', message: 'Cancelled by Ada' }),
    );
    expect(result.runId).toBe('run-1');
  });

  it('rejects a cross-team / missing run before cancelling', async () => {
    ownedRow = undefined;
    await expect(
      abortRun({ runId: 'nope', teamId: TEAM_ID }),
    ).rejects.toBeInstanceOf(MovementEngineError);
    expect(failRunAndCancelRequests).not.toHaveBeenCalled();
  });
});

describe('a run another process is stepping', () => {
  it('resumeRun refuses with RunBusy — the doors answer it 409 — and resumes nothing', async () => {
    ownedRow = { id: 'run-1', status: 'parked' };
    leaseHeldElsewhere = true;
    await expect(resumeRun({ runId: 'run-1', teamId: TEAM_ID })).rejects.toBeInstanceOf(RunBusy);
    expect(resumeLimitPausedRun).not.toHaveBeenCalled();
  });

  it('resumeRun resumes under the lease when it is free', async () => {
    ownedRow = { id: 'run-1', status: 'parked' };
    await expect(resumeRun({ runId: 'run-1', teamId: TEAM_ID })).resolves.toEqual({ runId: 'run-1', resumed: 1 });
  });

  it('abortRun of a parked run being resumed elsewhere stamps the cancel for that resume to settle', async () => {
    ownedRow = { id: 'run-1', status: 'parked' };
    leaseHeldElsewhere = true;
    await abortRun({ runId: 'run-1', teamId: TEAM_ID });
    expect(failRunAndCancelRequests).not.toHaveBeenCalled();
    expect(stamps).toEqual([['status', 'in', ['running', 'parked']]]);
  });
});
