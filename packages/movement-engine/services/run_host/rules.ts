// The run host's rules, written once over the backend families (store.ts):
// what a park writes and in which order, when a run counts as complete, how a
// run that failed or was cancelled is torn down, and how a race's losing
// subtrees are withdrawn. The hosted product and `lf` both run these; neither
// keeps a copy.

import { randomUUID } from 'node:crypto';
import { isAncestorOrSelf, parseAddress } from '../movement_engine/address';
import type { ParkSink, RunLimitPause } from '../movement_engine/run';
import type { AwaitKeeper, RunHostStore } from './store';

/** What the product keeps about a run beyond its live state: its status, and
 *  the records only it knows of (callbacks, the ops feed). */
export interface RunRecords {
  /** The operator's cancel request on the run, with its reason; null when none. */
  cancelRequest(input: { runId: string }): Promise<{ reason: string | null } | null>;
  /** The run is over without completing: mark it failed with `message`. A run
   *  already settled stays as it is. */
  markFailed(input: { runId: string; message: string }): Promise<void>;
  /** The run is over, however it ended: close what the product keeps for it
   *  that a live run would still answer (a callback's link). */
  closeRun?(input: { runId: string }): Promise<void>;
}

/** A run host: its backend, the adapters whose awaits are backed by records of
 *  their own, and the product's run records. */
export interface RunHost {
  store: RunHostStore;
  keepers: readonly AwaitKeeper[];
  runs: RunRecords;
  log?: RunHostLog;
}

export interface RunHostLog {
  warn(message: string, fields: Record<string, unknown>): void;
  error(message: string, fields: Record<string, unknown>): void;
}

export const CANCELLED_BY_OPERATOR = 'Cancelled by an operator';

// ── Work the run host queues ────────────────────────────────────────────────

/** One row per run, shared by every timer leaf the run parks: due at its
 *  earliest. */
export function timerWorkKey(runId: string): string {
  return `resume_timer:${runId}`;
}

export async function armTimerWake(store: RunHostStore, input: { runId: string; teamId: string; wakeAt: string }): Promise<void> {
  await store.work.enqueue({
    kind: 'resume_timer',
    key: timerWorkKey(input.runId),
    teamId: input.teamId,
    payload: { runId: input.runId },
    dueAt: input.wakeAt,
  });
}

/** The wake for one adapter identity: "resume whatever is parked on it". A
 *  signal's wake is never coalesced: a second signal while the first wake runs
 *  must still drive the parks the first pass looked past. A sweep or backstop
 *  that re-derives the same wake every pass names a `coalesceKey` instead. */
export async function queueAwaitWake(
  store: RunHostStore,
  wake: { adapterType: string; teamId: string; correlationKey: string },
  opts: { coalesceKey?: string; dueAt?: string } = {},
): Promise<void> {
  await store.work.enqueue({
    kind: 'wake_await',
    key: `wake_await:${opts.coalesceKey ?? randomUUID()}`,
    teamId: wake.teamId,
    payload: wake,
    ...(opts.dueAt !== undefined ? { dueAt: opts.dueAt } : {}),
  });
}

// ── Completion ──────────────────────────────────────────────────────────────

/**
 * A branch just completed: is the run complete? Only when no join still waits
 * on a branch and no OTHER leaf is parked (a sibling not yet due, a sibling
 * under another join). The leaf just stepped is excluded: its own row goes
 * after its step.
 */
export async function runCompleteWithout(store: RunHostStore, input: { runId: string; leafAddress: string }): Promise<boolean> {
  if (await store.joins.hasPendingJoins({ runId: input.runId })) return false;
  const parked = await store.parks.leaves({ runId: input.runId, parkedOnly: true });
  return parked.every((leaf) => leaf.address === input.leafAddress);
}

/** Whether nothing waits on the run: no join pending, no leaf parked. */
export async function runQuiescent(store: RunHostStore, input: { runId: string }): Promise<boolean> {
  if (await store.joins.hasPendingJoins(input)) return false;
  return (await store.parks.leaves({ runId: input.runId, parkedOnly: true })).length === 0;
}

/** A quiescent run's residual live state (closed joins and their exports)
 *  goes; under `fence`, only while the run is still that holder's. True when
 *  the run was quiescent. */
export async function clearIfQuiescent(store: RunHostStore, input: { runId: string; fence?: string }): Promise<boolean> {
  if (!(await runQuiescent(store, input))) return false;
  await store.leases.dropRunState(input);
  return true;
}

// ── A run that ends without completing ──────────────────────────────────────

/**
 * Tear a run's live state down: every leaf and join, then every record-backed
 * await closed by its keeper (nothing is left to consume an answer), every
 * correlation dropped (a late signal lands as data), and what the product
 * keeps for a live run closed. Under `fence`, the fenced drop goes first and
 * gates the rest: a holder whose lease lapsed tears down nothing of the new
 * holder's. False when fenced out.
 */
export async function abandonRun(host: RunHost, input: { runId: string; fence?: string }): Promise<boolean> {
  if (!(await host.store.leases.dropRunState(input))) return false;
  for (const keeper of host.keepers) await keeper.abandon({ runId: input.runId });
  await host.store.correlations.dropRun({ runId: input.runId });
  await host.runs.closeRun?.({ runId: input.runId });
  return true;
}

/** An error in any branch fails the whole run; the writes it made stand. */
export async function failRun(host: RunHost, input: { runId: string; message: string; fence?: string }): Promise<boolean> {
  await host.runs.markFailed({ runId: input.runId, message: input.message });
  return abandonRun(host, input);
}

/** A run an operator asked to cancel is settled as failed with the reason they
 *  gave, its live state torn down. False when no cancel was asked for. */
export async function settleIfCancelRequested(host: RunHost, input: { runId: string; fence?: string }): Promise<boolean> {
  const request = await host.runs.cancelRequest({ runId: input.runId });
  if (request === null) return false;
  await failRun(host, { ...input, message: request.reason ?? CANCELLED_BY_OPERATOR });
  return true;
}

// ── A race's losers ─────────────────────────────────────────────────────────

/**
 * Withdraw every park at or below one of the subtree addresses (a race's losing
 * arms), sparing `excludeLeaf` (the winner, whose own row may still be
 * mid-resume). The prefix algebra runs on the parsed address: `s1.b1` is not
 * an ancestor of `s1.b10`. Record-backed awaits are closed by their keeper,
 * every withdrawn park's correlation is dropped, and every join frame inside
 * the subtrees goes with its exports. Idempotent.
 */
export async function cancelSubtrees(
  host: RunHost,
  input: { runId: string; subtreeAddresses: readonly string[]; excludeLeaf?: string },
): Promise<void> {
  if (input.subtreeAddresses.length === 0) return;
  const prefixes = input.subtreeAddresses.map(parseAddress);
  const inSubtree = (address: string): boolean =>
    address !== input.excludeLeaf && prefixes.some((p) => isAncestorOrSelf(p, parseAddress(address)));
  const { runId } = input;
  const doomed = (await host.store.parks.leaves({ runId, parkedOnly: true })).map((l) => l.address).filter(inSubtree);
  if (doomed.length > 0) {
    for (const keeper of host.keepers) await keeper.abandon({ runId, addresses: doomed });
    for (const address of doomed) await host.store.correlations.drop({ runId, address });
    await host.store.parks.deleteLeaves({ runId, addresses: doomed });
  }
  const deadFrames = (await host.store.joins.frames({ runId })).filter(inSubtree);
  if (deadFrames.length > 0) await host.store.joins.deleteFrames({ runId, frameAddresses: deadFrames });
}

// ── The park sink ───────────────────────────────────────────────────────────

/** What the product does around a park: the run's own row and status. */
export interface ParkRecords {
  /** The run's record exists before anything is parked against it. */
  ensureRun(): Promise<void>;
  /** The run is observably parked. */
  markParked(): Promise<void>;
  /** The run met a limit and is pausing (status, and the system event). */
  markLimitPaused?(pause: RunLimitPause): Promise<void>;
}

/**
 * The engine's park sink for one run segment. Given the run lease the segment
 * holds (`fence`), every leaf and join it writes lands only while the run's
 * lease is still that token's; a holder whose lease lapsed is refused
 * (`RunLeaseLost`) rather than overwriting the parks of whoever took the run.
 *
 * After each park, a cancel an operator stamped meanwhile settles the run at
 * once: the park just written is stale.
 */
export function runParkSink(
  host: RunHost,
  input: { runId: string; teamId: string; fence?: string; records: ParkRecords },
): ParkSink {
  const { store } = host;
  const { runId, teamId, records } = input;
  const fence = input.fence !== undefined ? { fence: input.fence } : {};
  const afterPark = async (): Promise<void> => {
    await records.markParked();
    try {
      await settleIfCancelRequested(host, { runId });
    } catch (error) {
      // Never break the park path: the stamped-run sweep settles it later.
      host.log?.error('[ParkSink] cancel-race settle failed', { runId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  return {
    async commitTimerPark({ address, state, wakeAt }) {
      await records.ensureRun();
      await store.parks.putLeaf({ runId, address, reason: 'timer', wakeAt, state, ...fence });
      // The leaf is the truth; the work row only says when to look.
      await armTimerWake(store, { runId, teamId, wakeAt });
      await afterPark();
    },
    async commitAwaitPark({ address, state, adapterType, correlationKey }) {
      // The leaf first: it is the truth, the correlation only an index onto it.
      // A wake between the two writes finds no correlation (the engine's
      // re-check covers it) or both, never a correlation without its park.
      await records.ensureRun();
      await store.parks.putLeaf({ runId, address, reason: 'await', wakeAt: null, state, ...fence });
      await store.correlations.correlate({ runId, teamId, address, adapterType, correlationKey });
      await afterPark();
    },
    ...(records.markLimitPaused !== undefined
      ? {
          commitLimitPause: async (pause: RunLimitPause) => {
            await records.ensureRun();
            await records.markLimitPaused?.(pause);
          },
        }
      : {}),
    async commitSuspension({ address, state }) {
      // The fenced park first: a lapsed holder is refused before it drops
      // anything. Then an await that took the pause before re-checking drops
      // its correlation: resuming the run re-enters it, which re-registers it
      // if it still waits. Left in place, every signal would wake it into the
      // pause again.
      await records.ensureRun();
      await store.parks.putLeaf({ runId, address, reason: 'limit', wakeAt: null, state, rewritten: true, ...fence });
      await store.correlations.drop({ runId, address });
      await afterPark();
    },
    async recordJoin({ frameAddress, parkedChildren }) {
      await store.joins.recordJoin({ runId, frameAddress, pending: parkedChildren, ...fence });
    },
    decrementJoin: ({ frameAddress, branchAddress, leafAddress }) =>
      store.joins.decrementJoin({ runId, frameAddress, branchAddress, leafAddress }),
    persistBranchExport: ({ frameAddress, branchAddress, branchIndex, exports }) =>
      store.joins.persistBranchExport({ runId, frameAddress, branchAddress, branchIndex, exports }),
    collectBranchExports: ({ frameAddress }) => store.joins.collectBranchExports({ runId, frameAddress }),
    cancelSubtrees: ({ subtreeAddresses, excludeLeaf }) =>
      cancelSubtrees(host, { runId, subtreeAddresses, ...(excludeLeaf !== undefined ? { excludeLeaf } : {}) }),
  };
}
