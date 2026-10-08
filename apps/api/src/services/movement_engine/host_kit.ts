// What both hosts build from — the production host
// (`translation_graph/movement/engine_host.ts`) and the test host
// (`test_host.ts`). Host side: none of this crosses the boundary, it is how a
// host serves the families that do.

import type { TenantId } from 'engine-contracts';
import type { CostLine } from '../../lib/run_cost';
import type { ActorCandidate } from '../translation_graph/adapter';
import type { SegmentWriteLocks } from '../write_locks/write_locks';
import type { MovementTraceEntry } from './expression';
import type { EngineHost, SegmentOpening } from './host';
import type { CancelGate } from './run';

/** The gate of a run nothing can cancel. */
export const NEVER_CANCELLED: CancelGate = {
  cancelled: async () => false,
  cancelledNow: async () => false,
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

/** A host's `trace` family over an array a caller reads as the run goes. */
export function appendingInto(trace: MovementTraceEntry[]): NonNullable<EngineHost['trace']> {
  return {
    append: async ({ entries }) => {
      trace.push(...entries);
    },
  };
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
