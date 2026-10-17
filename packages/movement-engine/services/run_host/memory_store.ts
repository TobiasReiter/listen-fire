// The run host's backend in memory: every family a parked run needs (its
// leaves, joins, await correlations, lease, work queue and pinned library
// texts), for an embedder that runs movements that `await` or `sleep` in one
// process. Held to the same contract suite as the Postgres and SQLite
// backends (contract.ts). Durable only for the life of the process: a restart
// forgets every parked run, so a product that must keep them across restarts
// implements `RunHostStore` over its own database instead.
//
// Every value goes in and comes out as JSON, as a database would keep it: a
// caller never shares an object with the store.

import { randomUUID } from 'node:crypto';

import type { ParkReason } from 'engine-contracts';

import { RunLeaseLost } from '../movement_engine/errors';
import type { ClaimedWork, CorrelatedAwait, LeafRow, RunHostStore } from './store';

interface Leaf {
  reason: ParkReason;
  status: 'parked' | 'resuming';
  wakeAt: string | null;
  state: string;
}

interface Join {
  pending: number;
  decremented: Set<string>;
  closer: string | undefined;
}

interface BranchExport {
  branchIndex: number;
  exports: string;
}

interface Correlation extends CorrelatedAwait {
  adapterType: string;
  correlationKey: string;
}

interface WorkRow {
  id: string;
  kind: string;
  key: string;
  payload: string;
  dueAt: number;
  teamId: string | undefined;
  claim: string | undefined;
  leasedUntil: number;
  /** Bumped by every enqueue: a claim remembers the one it saw, so a re-arm
   *  during the work is told from the work itself. */
  armed: number;
  armedAtClaim: number;
}

const stored = (value: unknown): string => JSON.stringify(value ?? null);
const read = (text: string): unknown => JSON.parse(text);

function byRun<T>(map: Map<string, Map<string, T>>, runId: string): Map<string, T> {
  let inner = map.get(runId);
  if (inner === undefined) {
    inner = new Map();
    map.set(runId, inner);
  }
  return inner;
}

/** A `RunHostStore` in this process's memory. `now` is its clock (due times,
 *  leases); default the wall clock. */
export function memoryRunHostStore(options: { now?: () => number } = {}): RunHostStore {
  const now = options.now ?? Date.now;
  const leaves = new Map<string, Map<string, Leaf>>();
  const joins = new Map<string, Map<string, Join>>();
  const branchExports = new Map<string, Map<string, Map<string, BranchExport>>>();
  const correlations: Correlation[] = [];
  const leases = new Map<string, { token: string; until: number }>();
  const work = new Map<string, WorkRow>();
  const sources = new Map<string, string>();

  const leasedTo = (runId: string, fence: string): boolean => leases.get(runId)?.token === fence;
  const refuseUnlessLeased = (runId: string, fence: string | undefined): void => {
    if (fence !== undefined && !leasedTo(runId, fence)) throw new RunLeaseLost(runId);
  };
  const exportsOf = (runId: string, frameAddress: string): Map<string, BranchExport> => byRun(byRun(branchExports, runId), frameAddress);

  return {
    parks: {
      async putLeaf({ runId, address, reason, wakeAt, state, fence }) {
        refuseUnlessLeased(runId, fence);
        byRun(leaves, runId).set(address, { reason, status: 'parked', wakeAt, state: stored(state) });
      },
      async claimLeaf({ runId, address, reason }) {
        const leaf = leaves.get(runId)?.get(address);
        if (leaf === undefined || leaf.status !== 'parked' || (reason !== undefined && leaf.reason !== reason)) return null;
        leaf.status = 'resuming';
        return { state: read(leaf.state), reason: leaf.reason };
      },
      async finishLeaf({ runId, address, fence }) {
        if (fence !== undefined && !leasedTo(runId, fence)) return;
        const run = leaves.get(runId);
        if (run?.get(address)?.status === 'resuming') run.delete(address);
      },
      async leaves({ runId, parkedOnly, reason, dueBy }) {
        const due = dueBy !== undefined ? Date.parse(dueBy) : undefined;
        const rows: LeafRow[] = [];
        for (const [address, leaf] of leaves.get(runId) ?? []) {
          if (parkedOnly === true && leaf.status !== 'parked') continue;
          if (reason !== undefined && leaf.reason !== reason) continue;
          if (due !== undefined && (leaf.wakeAt === null || Date.parse(leaf.wakeAt) > due)) continue;
          rows.push({ address, reason: leaf.reason, status: leaf.status, wakeAt: leaf.wakeAt });
        }
        return rows;
      },
      async deleteLeaves({ runId, addresses }) {
        const run = leaves.get(runId);
        for (const address of addresses) run?.delete(address);
      },
    },

    joins: {
      async recordJoin({ runId, frameAddress, pending, fence }) {
        refuseUnlessLeased(runId, fence);
        const frames = byRun(joins, runId);
        const frame = frames.get(frameAddress);
        if (frame === undefined) frames.set(frameAddress, { pending, decremented: new Set(), closer: undefined });
        else frame.pending = pending;
      },
      async decrementJoin({ runId, frameAddress, branchAddress }) {
        const frame = joins.get(runId)?.get(frameAddress);
        if (frame === undefined) return { closed: false };
        if (frame.decremented.has(branchAddress)) return { closed: frame.closer === branchAddress };
        frame.decremented.add(branchAddress);
        if (frame.decremented.size < frame.pending) return { closed: false };
        frame.closer = branchAddress;
        return { closed: true };
      },
      async persistBranchExport({ runId, frameAddress, branchAddress, branchIndex, exports }) {
        exportsOf(runId, frameAddress).set(branchAddress, { branchIndex, exports: stored(exports) });
      },
      async collectBranchExports({ runId, frameAddress }) {
        return [...(branchExports.get(runId)?.get(frameAddress) ?? [])]
          .map(([branchAddress, branch]) => ({ branchAddress, branchIndex: branch.branchIndex, exports: read(branch.exports) }))
          .sort((a, b) => a.branchIndex - b.branchIndex);
      },
      async hasPendingJoins({ runId }) {
        return [...(joins.get(runId)?.values() ?? [])].some((frame) => frame.decremented.size < frame.pending);
      },
      async frames({ runId }) {
        return [...(joins.get(runId)?.keys() ?? [])];
      },
      async deleteFrames({ runId, frameAddresses }) {
        for (const frameAddress of frameAddresses) {
          joins.get(runId)?.delete(frameAddress);
          branchExports.get(runId)?.delete(frameAddress);
        }
      },
    },

    correlations: {
      async correlate({ runId, teamId, address, adapterType, correlationKey }) {
        const entry = { runId, teamId, address, adapterType, correlationKey };
        const at = correlations.findIndex((c) => c.runId === runId && c.address === address);
        if (at >= 0) correlations[at] = entry;
        else correlations.push(entry);
      },
      async correlated({ adapterType, teamId, correlationKey }) {
        return correlations
          .filter((c) => c.adapterType === adapterType && c.teamId === teamId && c.correlationKey === correlationKey)
          .map(({ runId, teamId: team, address }) => ({ runId, teamId: team, address }));
      },
      async ofRun({ runId, adapterType }) {
        return correlations.filter((c) => c.runId === runId && c.adapterType === adapterType).map((c) => ({ ...c }));
      },
      async drop({ runId, address }) {
        const at = correlations.findIndex((c) => c.runId === runId && c.address === address);
        if (at >= 0) correlations.splice(at, 1);
      },
      async dropRun({ runId }) {
        for (let at = correlations.length - 1; at >= 0; at -= 1) if (correlations[at]?.runId === runId) correlations.splice(at, 1);
      },
    },

    leases: {
      async claim({ runId, ttlMs }) {
        const held = leases.get(runId);
        if (held !== undefined && held.until > now()) return null;
        const token = randomUUID();
        leases.set(runId, { token, until: now() + ttlMs });
        // A lapsed holder's claimed leaves are parked again for the new one.
        if (held !== undefined) for (const leaf of leaves.get(runId)?.values() ?? []) leaf.status = 'parked';
        return { token };
      },
      async renew({ runId, token, ttlMs }) {
        const held = leases.get(runId);
        if (held === undefined || held.token !== token || held.until <= now()) return false;
        held.until = now() + ttlMs;
        return true;
      },
      async release({ runId, token }) {
        if (leases.get(runId)?.token === token) leases.delete(runId);
      },
      async dropRunState({ runId, fence }) {
        if (fence !== undefined && !leasedTo(runId, fence)) return false;
        leaves.delete(runId);
        joins.delete(runId);
        branchExports.delete(runId);
        return true;
      },
    },

    work: {
      async enqueue({ kind, key, payload, dueAt, teamId }) {
        const due = dueAt !== undefined ? Date.parse(dueAt) : now();
        const row = work.get(key);
        if (row === undefined) {
          work.set(key, { id: randomUUID(), kind, key, payload: stored(payload), dueAt: due, teamId, claim: undefined, leasedUntil: 0, armed: 0, armedAtClaim: 0 });
          return;
        }
        const leased = row.claim !== undefined && row.leasedUntil > now();
        row.kind = kind;
        row.payload = stored(payload);
        row.dueAt = leased ? due : Math.min(row.dueAt, due);
        if (teamId !== undefined) row.teamId = teamId;
        row.armed += 1;
      },
      async claimDue({ limit, leaseMs, dueBy }) {
        const by = dueBy !== undefined ? Date.parse(dueBy) : now();
        const claimed: ClaimedWork[] = [];
        for (const row of [...work.values()].sort((a, b) => a.dueAt - b.dueAt)) {
          if (claimed.length >= limit) break;
          if (row.dueAt > by || (row.claim !== undefined && row.leasedUntil > now())) continue;
          row.claim = randomUUID();
          row.leasedUntil = now() + leaseMs;
          row.armedAtClaim = row.armed;
          claimed.push({ id: row.id, kind: row.kind, key: row.key, payload: read(row.payload), claim: row.claim });
        }
        return claimed;
      },
      async complete({ key, claim }) {
        const row = work.get(key);
        if (row === undefined || row.claim !== claim) return;
        if (row.armed !== row.armedAtClaim) {
          row.claim = undefined;
          row.leasedUntil = 0;
          return;
        }
        work.delete(key);
      },
      async release({ key, claim, dueAt }) {
        const row = work.get(key);
        if (row === undefined || row.claim !== claim) return;
        row.claim = undefined;
        row.leasedUntil = 0;
        if (row.armed === row.armedAtClaim) row.dueAt = dueAt !== undefined ? Date.parse(dueAt) : now();
      },
    },

    sources: {
      async put({ teamId, hash, source }) {
        const key = JSON.stringify([teamId, hash]);
        if (!sources.has(key)) sources.set(key, source);
      },
      async get({ teamId, hash }) {
        return sources.get(JSON.stringify([teamId, hash])) ?? null;
      },
    },
  };
}
