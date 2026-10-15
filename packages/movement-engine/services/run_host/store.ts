// The run host's backend: the durable state a run leaves between its segments
// (parked leaves, the joins they hold, await correlations, the run lease, the
// work queue), as the families every backend serves. The hosted product serves
// them from Postgres and `lf` from SQLite; the rules that read and write them
// (when a run is complete, how a wake finds its parks, how a race settles,
// how a cancel or a failure tears a run down) are the core's (rules.ts,
// drain.ts), written once over these families.
//
// Every method is plain data in and out. A backend is held to one meaning by
// the contract suite (contract.ts), run against each.

import type { CoreParkReason, ParkReason } from 'engine-contracts';

/** One parked leaf of a run, as the backend lists it. */
export interface LeafRow {
  address: string;
  /** One of the core's reasons, or one a unit owns: a unit's parked leaf
   *  still holds its run open. */
  reason: ParkReason;
  /** `parked`, or `resuming` while a resume holds its claim. */
  status: 'parked' | 'resuming';
  /** A timer's wake instant (ISO 8601); null for any other reason. */
  wakeAt: string | null;
}

export interface ParkStore {
  /**
   * Park a leaf: one row per (run, address), so a re-reached park rewrites its
   * own row, `parked` again. `rewritten` stamps the row as rewritten (how a
   * limit resume tells a flow that suspended again at once from the one it
   * stepped). Given `fence`, it lands only while the run's lease is that
   * token's, and throws `RunLeaseLost` otherwise.
   */
  putLeaf(input: {
    runId: string;
    address: string;
    reason: CoreParkReason;
    wakeAt: string | null;
    state: unknown;
    rewritten?: boolean;
    fence?: string;
  }): Promise<void>;
  /** Claim a parked leaf for its resume (`parked` → `resuming`). Null when it
   *  is not parked: another resume took it, or a race cancelled it. */
  claimLeaf(input: { runId: string; address: string; reason?: ParkReason }): Promise<{ state: unknown; reason: ParkReason } | null>;
  /** The claimed leaf is done with: delete it unless its step parked it again
   *  (the row is `parked` again, and stays). Given `fence`, only while the run's
   *  lease is still that token's. */
  finishLeaf(input: { runId: string; address: string; fence?: string }): Promise<void>;
  /** The run's leaves, by address. `parkedOnly` leaves out claimed ones;
   *  `dueBy` keeps only timers due by that instant. */
  leaves(input: { runId: string; parkedOnly?: boolean; reason?: ParkReason; dueBy?: string }): Promise<LeafRow[]>;
  /** Delete the named leaves, whatever their status. */
  deleteLeaves(input: { runId: string; addresses: readonly string[] }): Promise<void>;
}

export interface JoinStore {
  /** A join frame's count of parked children. A re-reached frame rewrites the
   *  count to the same value, never double-counting. Fenced as `putLeaf`. */
  recordJoin(input: { runId: string; frameAddress: string; pending: number; fence?: string }): Promise<void>;
  /** One branch finished: decrement exactly once per branch. True for the one
   *  branch that closes the frame, also on a retry of that branch. */
  decrementJoin(input: { runId: string; frameAddress: string; branchAddress: string; leafAddress: string }): Promise<{ closed: boolean }>;
  /** A completed branch's exports, written before its decrement. A rewrite
   *  keeps the branch's decrement claim. */
  persistBranchExport(input: { runId: string; frameAddress: string; branchAddress: string; branchIndex: number; exports: unknown }): Promise<void>;
  collectBranchExports(input: { runId: string; frameAddress: string }): Promise<Array<{ branchAddress: string; branchIndex: number; exports: unknown }>>;
  /** Whether any join of the run still waits on a branch (a closed frame does not). */
  hasPendingJoins(input: { runId: string }): Promise<boolean>;
  /** Every join frame of the run, pending or closed. */
  frames(input: { runId: string }): Promise<string[]>;
  /** Delete the named frames and their branch exports. */
  deleteFrames(input: { runId: string; frameAddresses: readonly string[] }): Promise<void>;
}

/** One await park correlated to an adapter identity. */
export interface CorrelatedAwait {
  runId: string;
  teamId: string;
  address: string;
}

export interface CorrelationStore {
  /** Map an adapter identity (its type and native key) to a park. Idempotent on
   *  (run, address): a re-armed await rewrites its own entry. */
  correlate(input: { runId: string; teamId: string; address: string; adapterType: string; correlationKey: string }): Promise<void>;
  /** Every park correlated to one identity, within one team. */
  correlated(input: { adapterType: string; teamId: string; correlationKey: string }): Promise<CorrelatedAwait[]>;
  /** The run's correlations of one adapter type, with their keys. */
  ofRun(input: { runId: string; adapterType: string }): Promise<Array<CorrelatedAwait & { correlationKey: string }>>;
  drop(input: { runId: string; address: string }): Promise<void>;
  dropRun(input: { runId: string }): Promise<void>;
}

export interface RunLeaseStore {
  /** Take the run's lease if it is free or lapsed, returning every leaf a
   *  lapsed holder left claimed to `parked`. Null while someone else holds it. */
  claim(input: { runId: string; ttlMs: number }): Promise<{ token: string } | null>;
  /** Extend a held lease. False once it is not this token's, or has lapsed. */
  renew(input: { runId: string; token: string; ttlMs: number }): Promise<boolean>;
  /** Give it back. A no-op when it is no longer this token's. */
  release(input: { runId: string; token: string }): Promise<void>;
  /**
   * Drop the run's live state, every leaf and every join with its exports.
   * Given `fence`, only while the run is still leased under it: false when it
   * is not, and nothing was dropped.
   */
  dropRunState(input: { runId: string; fence?: string }): Promise<boolean>;
}

/** A claimed work row: what to do, and the claim to finish it under. */
export interface ClaimedWork {
  id: string;
  kind: string;
  key: string;
  payload: unknown;
  claim: string;
}

export interface WorkQueue {
  /** Upsert by key. Against an unleased row the earliest due time wins; against
   *  a leased row the new one does (a re-arm during the work). The payload is
   *  always the new one. */
  enqueue(input: { kind: string; key: string; payload: unknown; dueAt?: string; teamId?: string }): Promise<void>;
  /** Lease up to `limit` rows due by `dueBy`, unleased or with a lapsed lease. */
  claimDue(input: { limit: number; leaseMs: number; dueBy?: string }): Promise<ClaimedWork[]>;
  /** Done: delete the row, unless it was re-armed since the claim (it stays,
   *  unleased, due at its new time). A stale claim changes nothing. */
  complete(work: ClaimedWork): Promise<void>;
  /** Unlease it for a retry, due at `dueAt` unless re-armed since the claim. */
  release(work: ClaimedWork & { dueAt?: string }): Promise<void>;
}

/** Every family a run host's backend serves. */
export interface RunHostStore {
  parks: ParkStore;
  joins: JoinStore;
  correlations: CorrelationStore;
  leases: RunLeaseStore;
  work: WorkQueue;
}

/**
 * The run host's half of an awaitable adapter whose awaits are backed by
 * records of its own (an ask is: the ask settles, the await resolves; a
 * callback is: a call lands). The core reaches it only through this
 * interface: the resume drain loads each keeper's settled leaves, and
 * whatever withdraws parks (a lost race arm, a run that ended) hands them to
 * every keeper to close what stood behind them.
 */
export interface AwaitKeeper {
  /** The adapter type its correlations carry. */
  adapterType: string;
  /** The run's parked leaves whose records have settled. */
  loadResolvable(input: { runId: string }): Promise<CorrelatedAwait[]>;
  /** Withdraw parks that will never be consumed and close the records behind
   *  them: the run's parks at `addresses`, or every one when absent. */
  abandon(input: { runId: string; addresses?: readonly string[] }): Promise<void>;
}
