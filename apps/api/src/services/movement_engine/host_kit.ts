// What both hosts build from — the production host
// (`translation_graph/movement/engine_host.ts`) and the test host
// (`test_host.ts`). Host side: none of this crosses the boundary, it is how a
// host serves the families that do.

import { randomUUID } from 'node:crypto';

import { refuseUnsupportedHostFamiliesVersion, type ActingPrincipal, type TenantId } from 'engine-contracts';
import type { CostLine } from '../../lib/run_cost';
import type { ActingUser, ActorCandidate } from '../translation_graph/adapter';
import type { SegmentWriteLocks } from '../write_locks/write_locks';
import type { MovementTraceEntry } from './expression';
import type { EngineHost, SegmentOpening } from './host';
import type { CancelGate } from './run';
import type { ClockAndIds } from './run_context';

/** The gate of a run nothing can cancel. */
export const NEVER_CANCELLED: CancelGate = {
  cancelled: async () => false,
  cancelledNow: async () => false,
};

/** The wall clock, as a host serves `clock`. */
export const WALL_CLOCK: EngineHost['clock'] = {
  now: async () => ({ nowIso: new Date().toISOString() }),
};

/** Random UUIDs, as a host serves `ids`. */
export const RANDOM_IDS: EngineHost['ids'] = {
  mint: async ({ count }) => Array.from({ length: count }, () => randomUUID()),
};

/** A bare host's clock and ids, for a script that drives a piece of the
 *  engine outside a run (`ExtractRuntime.world`): the wall clock and random
 *  UUIDs. */
export const BARE_HOST: ClockAndIds = {
  clock: { now: async () => new Date() },
  ids: { mint: async (count) => Array.from({ length: count }, () => randomUUID()) },
};

/** What a host knows of a segment it opened: the run and the team every call
 *  made in it is for. */
export interface SegmentFacts {
  teamId: TenantId;
  runId?: string;
}

/**
 * The segments a host has open. Every host call names its segment, and the
 * host answers it for the segment's run and team, so no request repeats them.
 * A call naming a segment that was never opened, or has closed, is refused,
 * naming it.
 */
export class SegmentDirectory {
  private readonly open = new Map<string, SegmentFacts>();

  opened(segmentId: string, opening: SegmentOpening): void {
    this.open.set(segmentId, {
      teamId: opening.teamId,
      ...(opening.runId !== undefined ? { runId: opening.runId } : {}),
    });
  }

  closed(segmentId: string): void {
    this.open.delete(segmentId);
  }

  facts(segmentId: string): SegmentFacts {
    const facts = this.open.get(segmentId);
    if (facts === undefined) {
      throw new Error(`no open segment '${segmentId}': it was never opened, or it has closed`);
    }
    return facts;
  }
}

/** A wake as a host queues it: the request's key, for the segment's team. */
export interface QueuedWake {
  adapterType: string;
  teamId: TenantId;
  correlationKey: string;
}

/** An acting-user lookup with the source's candidates as a call: what the
 *  host's resolver works from, and what a test's lookup is handed. */
export interface ActingUserLookup {
  teamId: TenantId;
  triggerId?: string;
  getCandidates: () => Promise<ActorCandidate[]>;
}

/** A team user as the lookup answers it: the user's id as the principal's
 *  opaque reference, its name to show, and its email, which this host has. */
export function actingPrincipalOf(user: ActingUser | null): ActingPrincipal | null {
  if (user === null) return null;
  return {
    principal: { id: user.id, ...(typeof user.name === 'string' ? { display: user.name } : {}) },
    email: user.email,
  };
}

/** A host's `trace` family over an array a caller reads as the run goes. */
export function appendingInto(trace: MovementTraceEntry[]): NonNullable<EngineHost['trace']> {
  return {
    append: async ({ entries }) => {
      trace.push(...entries);
    },
  };
}

/** Open a segment's host half: refuse a host families version this host does
 *  not serve before anything opens, then the segment itself, its directory
 *  entry and its lock session. */
export async function openSegmentWith(
  opening: SegmentOpening,
  parts: {
    segments: SegmentDirectory;
    locks: SegmentWriteLocks;
    open: EngineHost['segment']['open'];
  },
): Promise<{ segmentId: string }> {
  refuseUnsupportedHostFamiliesVersion(opening);
  const opened = await parts.open(opening);
  parts.segments.opened(opened.segmentId, opening);
  parts.locks.opened(opened.segmentId, opening.teamId);
  return opened;
}

/** Close a segment's host half: forget its adapter instances, close its lock
 *  session, then the segment itself. The segment closes even when its lock
 *  session would not; that failure is raised after. */
export async function closeSegmentWith(
  input: { segmentId: string },
  parts: {
    segments: SegmentDirectory;
    table: { closeSegment(segmentId: string): void };
    locks: SegmentWriteLocks;
    close: EngineHost['segment']['close'];
  },
): Promise<{ cost?: CostLine[] }> {
  parts.segments.closed(input.segmentId);
  parts.table.closeSegment(input.segmentId);
  let lockFailure: unknown;
  try {
    await parts.locks.closed(input.segmentId);
  } catch (error) {
    lockFailure = error;
  }
  const answer = await parts.close(input);
  if (lockFailure !== undefined) throw lockFailure;
  return answer;
}
