// What both hosts build from — the production host
// (`translation_graph/movement/engine_host.ts`) and the test host
// (`test_host.ts`). Host side: none of this crosses the boundary, it is how a
// host serves the families that do.

import type { TeamId } from '../../generated/kysely/core/Team';
import type { CostLine } from '../../lib/run_cost';
import type { ActorCandidate } from '../translation_graph/adapter';
import type { SegmentWriteLocks } from '../write_locks/write_locks';
import type { MovementTraceEntry } from './expression';
import type { EngineHost } from './host';
import type { CancelGate } from './run';

/** The gate of a run nothing can cancel. */
export const NEVER_CANCELLED: CancelGate = {
  cancelled: async () => false,
  cancelledNow: async () => false,
};

/** An acting-user lookup with the source's candidates as a call: what the
 *  host's resolver works from, and what a test's lookup is handed. */
export interface ActingUserLookup {
  teamId: TeamId;
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
    table: { closeSegment(segmentId: string): void };
    locks: SegmentWriteLocks;
    close: EngineHost['segment']['close'];
  },
): Promise<{ cost?: CostLine[] }> {
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
