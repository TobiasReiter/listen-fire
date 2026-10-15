// The await-resume DRIVER's re-park disposition (asks-as-adapter §A/C, B.1).
//
// The defect this pins: a WHERE-narrowed await that resumes on a NON-matching
// candidate re-arms itself — `interpretAwait` re-registers the correlation and
// re-upserts the parked_run at the SAME address (the ordinary pending-park path,
// run.ts) — and the run must stay awaitable. The old driver read only
// `result.parked` (no address) and ALWAYS dropped the leaf's correlation +
// parked_run, deleting the row the interpreter had just re-committed and
// stranding the run parked forever, deaf to every later matching candidate.
//
// The fix threads `result.parkedAddress` out of the interpreter and the driver
// compares it to the leaf it re-entered:
//   • SAME address  → re-armed, still pending → leave correlation + parked_run.
//   • DIFFERENT addr → resolved-then-parked-deeper → drop the now-stale leaf.
// Adapter-agnostic (slack `Replies`, `ask` `Response`, …) and race-safe.

const loadCorrelatedParksMock = jest.fn();
const dropAwaitCorrelationMock = jest.fn();
const dropAwaitCorrelationsForRunMock = jest.fn();
const loadResolvableAskAwaitsMock = jest.fn();
const resumeMovementFiringMock = jest.fn();
const loadTriggerByIdMock = jest.fn();
const runHasPendingJoinsMock = jest.fn();
const loggerErrorMock = jest.fn();

// ── The parked_run substrate, in memory ─────────────────────────────────────
// `livePark` is the set of addresses with a live `parked` row for the run — what
// the interpreter writes (commitAwaitPark) and the driver deletes (resolveAwait
// leaf / final sweep). `deletedAddresses` records every targeted-address delete;
// `sweepDeleted` records the run-wide final sweep.
const livePark = new Set<string>();
const deletedAddresses: string[] = [];
let sweepDeleted = false;

const whereVal = (ctx: { wheres: unknown[][] }, col: string): unknown =>
  ctx.wheres.find((w) => w[0] === col)?.[2];

// Every table the driver reads now lives in `automations`, so the fake is keyed
// on the TABLE rather than on which accessor asked for it.
function makeQb() {
  const make = (ctx: { table?: string; op?: string; wheres: unknown[][] }): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'executeTakeFirst') {
          return async () => {
            // The run's snapshot was minted under version 1; the movement's pin may
            // have moved since — the snapshot's is the one a resume honours.
            if (ctx.table === 'movement_version') return { source: 'PINNED SOURCE', language_version: 1 };
            if (ctx.table === 'trigger_run') {
              return {
                trigger_id: 't-1',
                trigger_type: 'webhook_sync',
                trigger_payload: { adapterType: 'slack' },
                movement_version_id: 'mv-1',
                cancel_requested_at: null,
              };
            }
            // parked_run select
            const address = whereVal(ctx, 'address') as string | undefined;
            if (address !== undefined) {
              // Per-leaf existence check.
              return livePark.has(address) ? { id: `p:${address}`, state: { address } } : undefined;
            }
            // Final-sweep "any leaf still parked?" — no address predicate.
            return livePark.size > 0 ? { id: 'p:any' } : undefined;
          };
        }
        if (prop === 'execute') {
          return async () => {
            if (ctx.op === 'delete' && ctx.table === 'parked_run') {
              const address = whereVal(ctx, 'address') as string | undefined;
              if (address !== undefined) {
                deletedAddresses.push(address);
                livePark.delete(address);
              } else {
                sweepDeleted = true;
                livePark.clear();
              }
            }
            return [];
          };
        }
        if (prop === 'then') return undefined;
        return (...args: unknown[]) => {
          const next = { ...ctx, wheres: [...ctx.wheres] };
          if (prop === 'selectFrom') {
            next.table = args[0] as string;
            next.op = 'select';
          } else if (prop === 'deleteFrom') {
            next.table = args[0] as string;
            next.op = 'delete';
          } else if (prop === 'where') {
            next.wheres.push(args);
          }
          return make(next);
        };
      },
    });
  return () => make({ wheres: [] });
}

jest.mock('../../../lib/kysely', () => ({
  getQb: () => makeQb()(),
  getCoreQb: () => makeQb()(),
  getAutomationsQb: () => makeQb()(),
}));
jest.mock('../../../lib/worker', () => ({ worker: jest.fn() }));
jest.mock('movement-engine/services/logger', () => ({ logger: { error: (...a: unknown[]) => loggerErrorMock(...a), info: jest.fn(), warn: jest.fn() } }));
jest.mock('../../translation_graph/adapters/packages', () => ({
  awaitKeepers: () => [
    {
      adapterType: 'ask',
      loadResolvable: (...a: unknown[]) => loadResolvableAskAwaitsMock(...a),
      abandon: jest.fn(async () => {}),
    },
  ],
}));
jest.mock('../callback_sink', () => ({
  callbackAwaitKeeper: { adapterType: 'callback', loadResolvable: async () => [], abandon: async () => {} },
}));
jest.mock('../callback_store', () => ({ revokeRunCallbacks: jest.fn() }));
jest.mock('../run_engine_record', () => ({ settleRunEngineRecord: jest.fn(async () => {}) }));
jest.mock('../../translation_graph/movement/execute', () => ({
  resumeMovementFiring: (...a: unknown[]) => resumeMovementFiringMock(...a),
}));
jest.mock('../../translation_graph/storage/tg_table', () => ({
  loadTriggerById: (...a: unknown[]) => loadTriggerByIdMock(...a),
}));
jest.mock('movement-engine/services/translation_graph/triggers/types', () => ({
  triggerEventSchema: { parse: (x: unknown) => x },
}));

// The run host's backend, in memory: the run's lease (`leaseHeldElsewhere` is
// another process stepping the run), its leaves, its joins and its
// correlations. The core's drain runs over it for real.
let leaseHeldElsewhere = false;
jest.mock('../run_host_store', () => ({
  triggerRunIdOf: (id: string) => id,
  postgresRunHostStore: {
    leases: {
      claim: async () => (leaseHeldElsewhere ? null : { token: 'lease-1' }),
      renew: async () => true,
      release: async () => {},
      dropRunState: async () => {
        sweepDeleted = true;
        livePark.clear();
        return true;
      },
    },
    parks: {
      claimLeaf: async ({ address }: { address: string }) =>
        livePark.has(address) ? { state: { address }, reason: 'await' } : null,
      finishLeaf: async ({ address }: { address: string }) => {
        deletedAddresses.push(address);
        livePark.delete(address);
      },
      leaves: async () => [...livePark].map((address) => ({ address, reason: 'await', status: 'parked', wakeAt: null })),
    },
    joins: { hasPendingJoins: (...a: unknown[]) => runHasPendingJoinsMock(...a) },
    correlations: {
      correlated: (...a: unknown[]) => loadCorrelatedParksMock(...a),
      drop: (...a: unknown[]) => dropAwaitCorrelationMock(...a),
      dropRun: (...a: unknown[]) => dropAwaitCorrelationsForRunMock(...a),
    },
  },
}));

// The work table, in memory: what the drain claims, completes and releases.
const claimDueWorkMock = jest.fn();
const completeWorkMock = jest.fn();
const releaseWorkMock = jest.fn();
const deferWorkMock = jest.fn();
jest.mock('../../work/store', () => ({
  claimDueWork: (...a: unknown[]) => claimDueWorkMock(...a),
  completeWork: (...a: unknown[]) => completeWorkMock(...a),
  releaseWork: (...a: unknown[]) => releaseWorkMock(...a),
  deferWork: (...a: unknown[]) => deferWorkMock(...a),
  heartbeatWork: jest.fn(async () => true),
  enqueueWork: jest.fn(),
}));

import { registerAwaitWork, resumeAwaitsForCorrelation } from '../await_resume';
import { drainWork, resetWorkHandlersForTests } from '../../work/drain';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

const RUN = 'run-1' as TriggerRunId;
const TEAM = 'team-1' as TeamId;
const LEAF = 'ROOT.stmt 1';

/** A completed resume outcome (the branch ran to its end). */
const completed = () => ({ result: { parked: false } });
/** A re-park outcome at `parkedAddress` (with any deferred race frames). */
const reparked = (parkedAddress: string, deferredRaceFrames: string[] = []) => ({
  result: { parked: true, parkedAddress, ...(deferredRaceFrames.length ? { deferredRaceFrames } : {}) },
});

function fireCandidate() {
  return resumeAwaitsForCorrelation({
    adapterType: 'slack',
    teamId: TEAM,
    correlationKey: 'C123:1700000000.000100',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  livePark.clear();
  deletedAddresses.length = 0;
  leaseHeldElsewhere = false;
  sweepDeleted = false;
  // The correlation lookup yields one park (the WHERE-narrowed await leaf).
  loadCorrelatedParksMock.mockResolvedValue([{ runId: RUN, teamId: TEAM, address: LEAF }]);
  loadResolvableAskAwaitsMock.mockResolvedValue([]);
  loadTriggerByIdMock.mockResolvedValue({ movementId: 'mov-1', name: 'intake', firedMovementName: null });
  runHasPendingJoinsMock.mockResolvedValue(false);
  // The interpreter has a live parked row for this leaf (it parked here originally).
  livePark.add(LEAF);
});

describe('await-resume driver — a WHERE-narrowed await re-arming at the SAME address', () => {
  it('a non-matching candidate leaves the correlation + parked_run INTACT (does not strand the run)', async () => {
    // The resumed await found no matching landing → re-parked at its OWN address.
    resumeMovementFiringMock.mockResolvedValue(reparked(LEAF));

    await fireCandidate();

    expect(loggerErrorMock).not.toHaveBeenCalled();
    // The park the interpreter re-committed is untouched: no correlation dropped,
    // no parked_run deleted, no run-wide sweep. The run is STILL awaitable.
    expect(dropAwaitCorrelationMock).not.toHaveBeenCalled();
    expect(deletedAddresses).toEqual([]);
    expect(sweepDeleted).toBe(false);
    expect(livePark.has(LEAF)).toBe(true);
  });

  it('a later MATCHING candidate then resumes the still-armed leaf to completion', async () => {
    // First: a non-matching candidate re-arms (same address).
    resumeMovementFiringMock.mockResolvedValueOnce(reparked(LEAF));
    await fireCandidate();
    expect(livePark.has(LEAF)).toBe(true);
    expect(dropAwaitCorrelationMock).not.toHaveBeenCalled();

    // Then: a matching candidate arrives — the branch completes.
    resumeMovementFiringMock.mockResolvedValueOnce(completed());
    await fireCandidate();

    expect(loggerErrorMock).not.toHaveBeenCalled();
    // NOW the leaf resolves: its correlation + parked_run are dropped.
    expect(dropAwaitCorrelationMock).toHaveBeenCalledWith({ runId: RUN, address: LEAF });
    expect(deletedAddresses).toContain(LEAF);
    expect(livePark.has(LEAF)).toBe(false);
  });
});

describe('await-resume driver — resolved-then-parked-DEEPER (the case the code was written for)', () => {
  it('drops the resolved leaf and keeps the run parked on the new deeper leaf', async () => {
    const DEEPER = 'ROOT.stmt 2';
    // The await RESOLVED and the resumed body parked at a further await — the
    // interpreter wrote the deeper park row; the driver must drop the OLD leaf.
    resumeMovementFiringMock.mockImplementation(async () => {
      livePark.add(DEEPER); // commitAwaitPark wrote the deeper row
      return reparked(DEEPER);
    });

    await fireCandidate();

    expect(loggerErrorMock).not.toHaveBeenCalled();
    // The old (resolved) leaf is cleaned up…
    expect(dropAwaitCorrelationMock).toHaveBeenCalledWith({ runId: RUN, address: LEAF });
    expect(deletedAddresses).toContain(LEAF);
    // …and the run stays parked on the deeper leaf — no run-wide sweep.
    expect(sweepDeleted).toBe(false);
    expect(livePark.has(DEEPER)).toBe(true);
  });
});

describe('await-resume driver — a WHERE-narrowed branch inside a race (deferRaceSettlement)', () => {
  it('a non-matching candidate leaves the branch armed WITHOUT disturbing the race frame', async () => {
    // The branch's await re-parked at its own address and reported NO completed
    // (deferred) race frame — the race is still waiting on a first completer.
    resumeMovementFiringMock.mockResolvedValue(reparked(LEAF, []));

    await fireCandidate();

    expect(loggerErrorMock).not.toHaveBeenCalled();
    // The branch stays armed (no correlation/parked_run touched)…
    expect(dropAwaitCorrelationMock).not.toHaveBeenCalled();
    expect(deletedAddresses).toEqual([]);
    expect(livePark.has(LEAF)).toBe(true);
    // …and the race frame is never settled: resumeMovementFiring ran once for the
    // branch and there is NO post-batch settlement pass (no deferred frame).
    expect(resumeMovementFiringMock).toHaveBeenCalledTimes(1);
  });
});

describe('await-resume driver — the language version a resume runs under', () => {
  it('is the one copied onto the run\'s pinned snapshot, never the movement\'s pin now', async () => {
    resumeMovementFiringMock.mockResolvedValue(completed());

    await fireCandidate();

    expect(resumeMovementFiringMock).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedSource: 'PINNED SOURCE', pinnedLanguageVersion: 1 }),
    );
  });
});

describe('await-resume driver — a failing resume is retried by the work table', () => {
  it('a throwing resume releases its wake row for a backoff retry instead of completing it', async () => {
    resetWorkHandlersForTests();
    registerAwaitWork();
    const claimedAt = new Date('2001-01-01T00:00:00.000Z');
    claimDueWorkMock.mockResolvedValueOnce([
      {
        id: 'w-1',
        teamId: TEAM,
        kind: 'wake_await',
        key: 'wake_await:k',
        payload: { adapterType: 'slack', teamId: TEAM, correlationKey: 'C123:1700000000.000100' },
        dueAt: claimedAt,
        intervalMs: null,
        attempts: 1,
        deferrals: 0,
        leaseOwner: 'me',
        leaseUntil: claimedAt,
        leaseToken: 'token-1',
        updatedAt: claimedAt,
      },
    ]);
    // A transient fault mid-resume (the database went away).
    resumeMovementFiringMock.mockRejectedValue(new Error('connection reset'));

    const result = await drainWork({ owner: 'me', heartbeatMs: false });

    expect(loggerErrorMock).toHaveBeenCalledWith('[AwaitResume] run resume failed', expect.anything());
    expect(result).toMatchObject({ claimed: 1, failed: 1 });
    expect(completeWorkMock).not.toHaveBeenCalled();
    expect(releaseWorkMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'w-1', leaseToken: 'token-1' }));
    // The park is untouched for the retry to find.
    expect(livePark.has(LEAF)).toBe(true);
    expect(dropAwaitCorrelationMock).not.toHaveBeenCalled();
  });
});

describe('await-resume driver — a wake racing the park', () => {
  // The park sink writes the parked row before the correlation (park_sink.unit),
  // so a wake that finds the correlation always finds the park beside it.
  it('a correlation with its parked row beside it resumes the run, and keeps the correlation until the leaf resolves', async () => {
    resumeMovementFiringMock.mockResolvedValue(reparked(LEAF));

    await fireCandidate();

    expect(resumeMovementFiringMock).toHaveBeenCalledTimes(1);
    expect(dropAwaitCorrelationMock).not.toHaveBeenCalled();
    expect(livePark.has(LEAF)).toBe(true);
  });

  it('a correlation with no parked row is dropped as already drained — why the park must come first', async () => {
    livePark.clear();

    await fireCandidate();

    expect(resumeMovementFiringMock).not.toHaveBeenCalled();
    expect(dropAwaitCorrelationMock).toHaveBeenCalledWith({ runId: RUN, address: LEAF });
  });
});

describe('await-resume driver — a run another process is stepping', () => {
  it('defers the wake row a few seconds, resumes nothing, and completes nothing', async () => {
    resetWorkHandlersForTests();
    registerAwaitWork();
    livePark.add(LEAF);
    leaseHeldElsewhere = true;
    const claimedAt = new Date('2001-01-01T00:00:00.000Z');
    claimDueWorkMock.mockResolvedValueOnce([
      {
        id: 'w-2',
        teamId: TEAM,
        kind: 'wake_await',
        key: 'wake_await:k2',
        payload: { adapterType: 'slack', teamId: TEAM, correlationKey: 'C123:1700000000.000100' },
        dueAt: claimedAt,
        intervalMs: null,
        attempts: 1,
        deferrals: 0,
        leaseOwner: 'me',
        leaseUntil: claimedAt,
        leaseToken: 'token-2',
        updatedAt: claimedAt,
      },
    ]);
    const before = Date.now();

    const result = await drainWork({ owner: 'me', heartbeatMs: false });

    expect(result).toMatchObject({ claimed: 1, deferred: 1, failed: 0 });
    expect(resumeMovementFiringMock).not.toHaveBeenCalled();
    expect(completeWorkMock).not.toHaveBeenCalled();
    expect(releaseWorkMock).not.toHaveBeenCalled();
    const deferred = deferWorkMock.mock.calls[0]?.[0] as { id: string; dueAt: Date };
    expect(deferred.id).toBe('w-2');
    // The first deferral: two seconds on.
    expect(deferred.dueAt.getTime()).toBeGreaterThanOrEqual(before + 2_000);
    expect(deferred.dueAt.getTime()).toBeLessThan(before + 3_000);
    // The leaf and its correlation are left for the retry.
    expect(livePark.has(LEAF)).toBe(true);
    expect(dropAwaitCorrelationMock).not.toHaveBeenCalled();
  });
});
