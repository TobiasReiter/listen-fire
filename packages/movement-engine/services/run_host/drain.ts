// Stepping a parked run forward, written once for every backend: a wake on an
// adapter identity finds its parks (await correlation), each run is stepped
// under its lease, and each of the run's resolvable leaves is claimed and
// stepped in one batch. A race branch that completes in the batch DEFERS its
// race; once every leaf has stepped, each deferred race settles once, with
// every winner on its receipt. Then a run that nothing waits on any more has
// its residual state cleared.
//
// The product supplies only the step itself (`StepLeaf`): running one engine
// segment for one leaf, and recording what it did.

import type { ParkedScopeState } from 'engine-contracts';
import type { CoreParkReason } from 'engine-contracts';
import { withRunLease, type HeldRunLease, type LeaseOptions } from './lease';
import {
  abandonRun,
  clearIfQuiescent,
  failRun,
  CANCELLED_BY_OPERATOR,
  runCompleteWithout,
  settleIfCancelRequested,
  type RunHost,
} from './rules';
import type { CorrelatedAwait } from './store';

/** One segment the drain asks the product to run. */
export type StepRequest =
  /** Resume a claimed leaf: re-enter at its statement (an await, a suspension,
   *  an `await until`) or step past it (a slept timer). A completing race
   *  branch defers its race. */
  | { kind: 'leaf'; address: string; reason: CoreParkReason; state: ParkedScopeState; reenter: boolean; deferRaceSettlement: true }
  /** Settle a race whose branches completed in this batch, with all winners.
   *  `state` is a completed branch's (its scope chain covers the race). */
  | { kind: 'race'; frameAddress: string; state: ParkedScopeState };

/** What one segment came to. */
export type StepOutcome =
  /** The segment stopped because the run lease was lost: the run may be
   *  another instance's, so the drain leaves every row as it is. */
  | { kind: 'leaseLost' }
  /** The engine failed the run: the product recorded it failed; the drain
   *  tears its live state down. */
  | { kind: 'failed'; error: string }
  /** An operator's cancel stopped the segment. */
  | { kind: 'cancelled'; reason?: string }
  /** It parked again: at the same address (an await re-armed without
   *  resolving), or further on. */
  | { kind: 'parked'; parkedAddress: string | undefined; deferredRaceFrames: readonly string[] }
  | { kind: 'completed'; deferredRaceFrames: readonly string[] };

/**
 * Run one segment. When it completes, the product asks `runComplete()`
 * whether the run as a whole is now complete (the core's rule: no join
 * waiting and no other leaf parked) and records the run completed, or still
 * parked, accordingly.
 */
export type StepLeaf = (request: StepRequest, settle: { runComplete(): Promise<boolean> }) => Promise<StepOutcome>;

/** Which of a run's leaves a drain steps, and how a leaf is claimed. */
export interface DrainLeaves {
  addresses: readonly string[];
  /** Claim only leaves parked for this reason. */
  reason?: CoreParkReason;
}

/**
 * Step the chosen leaves of one run, under the lease the caller holds. A
 * cancel requested meanwhile settles the run instead of stepping it. Answers
 * `leaseLost` when the lease went mid-drain (every row is left as it is).
 */
export async function drainRun(
  host: RunHost,
  input: { runId: string; leaves: DrainLeaves; lease?: HeldRunLease; step: StepLeaf },
): Promise<'done' | 'leaseLost'> {
  const { store } = host;
  const { runId, lease, step } = input;
  const fence = lease !== undefined ? { fence: lease.token } : {};
  if (await settleIfCancelRequested(host, { runId, ...fence })) return 'done';

  const deferredRaces = new Map<string, ParkedScopeState>();
  for (const address of input.leaves.addresses) {
    if (lease?.isLost()) return 'leaseLost';
    // Claimed before it is stepped: a leaf another entry already took, or a
    // race this batch settled cancelled, is not parked any more.
    const claimed = await store.parks.claimLeaf({ runId, address, ...(input.leaves.reason !== undefined ? { reason: input.leaves.reason } : {}) });
    if (claimed === null) {
      // Not ours to judge once the lease is lost: the new holder may have
      // claimed it itself.
      if (lease?.isLost()) return 'leaseLost';
      // Already drained, or cancelled as a race loser: later wakes need not
      // drive it again.
      await store.correlations.drop({ runId, address });
      continue;
    }
    const state = parkedStateOf(claimed.state);
    const outcome = await step(
      {
        kind: 'leaf',
        address,
        reason: claimed.reason,
        state,
        // A slept timer steps past its sleep (re-entering would sleep again);
        // everything else re-enters to re-check live.
        reenter: claimed.reason !== 'timer' || state.until === true,
        deferRaceSettlement: true,
      },
      { runComplete: () => runCompleteWithout(store, { runId, leafAddress: address }) },
    );
    const settled = await afterStep(host, { runId, ...fence, outcome });
    if (settled !== 'continue') return settled;
    if (outcome.kind !== 'parked' && outcome.kind !== 'completed') continue;
    for (const frame of outcome.deferredRaceFrames) if (!deferredRaces.has(frame)) deferredRaces.set(frame, state);
    // Parked again at its own address: the await re-armed without resolving,
    // and its rows were just rewritten as parked. Anything else resolved this
    // leaf: its correlation and its claimed row go.
    if (outcome.kind === 'parked' && outcome.parkedAddress === address) continue;
    await store.correlations.drop({ runId, address });
    await store.parks.finishLeaf({ runId, address, ...fence });
  }

  for (const [frameAddress, state] of deferredRaces) {
    const outcome = await step(
      { kind: 'race', frameAddress, state },
      { runComplete: () => runCompleteWithout(store, { runId, leafAddress: frameAddress }) },
    );
    const settled = await afterStep(host, { runId, ...fence, outcome });
    if (settled !== 'continue') return settled;
  }

  await clearIfQuiescent(store, { runId, ...fence });
  return 'done';
}

/** A step that failed, was cancelled or lost its lease ends the drain. */
async function afterStep(
  host: RunHost,
  input: { runId: string; fence?: string; outcome: StepOutcome },
): Promise<'continue' | 'done' | 'leaseLost'> {
  const { runId, fence, outcome } = input;
  const fenced = fence !== undefined ? { fence } : {};
  switch (outcome.kind) {
    case 'leaseLost':
      return 'leaseLost';
    case 'failed':
      // An error in any branch fails the whole run; the product already
      // recorded the failure.
      await abandonRun(host, { runId, ...fenced });
      return 'done';
    case 'cancelled':
      await failRun(host, { runId, message: outcome.reason ?? CANCELLED_BY_OPERATOR, ...fenced });
      return 'done';
    case 'parked':
    case 'completed':
      return 'continue';
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled step outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

function parkedStateOf(state: unknown): ParkedScopeState {
  if (typeof state !== 'object' || state === null) throw new Error('a parked leaf has no state to resume from');
  // The backend stores what the engine handed it; the engine re-validates the
  // shape (and its version) when it resumes.
  return state as ParkedScopeState;
}

// ── Await correlation ───────────────────────────────────────────────────────

/** How the drain reaches the product for one run: the step it runs each
 *  segment with, or null when the run cannot be resumed (logged by the
 *  product). */
export type StepperFor = (input: { runId: string; lease: HeldRunLease }) => Promise<StepLeaf | null>;

/**
 * Step every currently resolvable await leaf of one run, under the lease the
 * caller holds: the leaves each keeper's records have settled, plus the
 * `extra` ones the caller already knows are resolvable (an event-driven
 * signal's correlated parks). Deduplicated by address, so a leaf resolvable
 * both ways is stepped once.
 */
export async function drainAwaits(
  host: RunHost,
  input: { runId: string; extra?: readonly CorrelatedAwait[]; lease: HeldRunLease; stepper: StepperFor },
): Promise<'done' | 'leaseLost'> {
  const addresses = new Set<string>();
  for (const keeper of host.keepers) for (const leaf of await keeper.loadResolvable({ runId: input.runId })) addresses.add(leaf.address);
  for (const leaf of input.extra ?? []) addresses.add(leaf.address);
  if (addresses.size === 0) return 'done';
  const step = await input.stepper({ runId: input.runId, lease: input.lease });
  if (step === null) return 'done';
  return drainRun(host, { runId: input.runId, leaves: { addresses: [...addresses] }, lease: input.lease, step });
}

/**
 * A wake on one adapter identity: look up the parks correlated to it and drive
 * each of their runs, each under its lease (and inside `around`, the
 * product's in-process slot, when it has one). A run held elsewhere is
 * reported busy; its wake retries, and its re-gather finds whatever is still
 * resolvable then.
 */
export async function wakeAwaits(
  host: RunHost,
  input: {
    wake: { adapterType: string; teamId: string; correlationKey: string };
    stepper: StepperFor;
    around?: (runId: string, body: () => Promise<void>) => Promise<void>;
    lease?: LeaseOptions;
  },
): Promise<{ busy: string[] }> {
  const parks = await host.store.correlations.correlated(input.wake);
  const byRun = new Map<string, CorrelatedAwait[]>();
  for (const park of parks) byRun.set(park.runId, [...(byRun.get(park.runId) ?? []), park]);
  const busy: string[] = [];
  const around = input.around ?? ((_runId: string, body: () => Promise<void>) => body());
  const outcomes = await Promise.allSettled(
    [...byRun.entries()].map(([runId, extra]) =>
      around(runId, async () => {
        const drained = await withRunLease(host.store.leases, runId, (lease) => drainAwaits(host, { runId, extra, lease, stepper: input.stepper }), input.lease);
        if (drained.kind === 'busy') busy.push(runId);
      }),
    ),
  );
  const failed = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
  return { busy };
}

// ── Timers ──────────────────────────────────────────────────────────────────

/** Step one run's timer leaves due by `dueBy`, under the lease the caller
 *  holds. A not-yet-due sibling still counts as parked. */
export async function drainDueTimers(
  host: RunHost,
  input: { runId: string; dueBy: string; lease?: HeldRunLease; step: StepLeaf },
): Promise<'done' | 'leaseLost'> {
  const due = await host.store.parks.leaves({ runId: input.runId, parkedOnly: true, reason: 'timer', dueBy: input.dueBy });
  return drainRun(host, {
    runId: input.runId,
    leaves: { addresses: due.map((l) => l.address), reason: 'timer' },
    ...(input.lease !== undefined ? { lease: input.lease } : {}),
    step: input.step,
  });
}

/** The earliest wake of the run's still-parked timers, for re-arming its row. */
export async function nextTimerWake(host: RunHost, input: { runId: string }): Promise<string | null> {
  const timers = await host.store.parks.leaves({ runId: input.runId, parkedOnly: true, reason: 'timer' });
  const wakes = timers.map((t) => t.wakeAt).filter((w): w is string => w !== null).sort();
  return wakes[0] ?? null;
}
