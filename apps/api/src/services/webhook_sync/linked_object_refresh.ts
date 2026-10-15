// The `linked_object_refresh` work kind: the cache refresh an inbound delivery
// owes, whether or not any movement listens for the event. It makes a live
// provider read, so it runs as its own row, never in the request, and
// independently of the event's dispatch rows.
import { randomUUID } from 'node:crypto';

import type { WorkHandler } from '../work/kinds';

import { logger } from 'movement-engine/services/logger';
import { registerWorkKinds } from '../work/drain';
import { enqueueWork } from '../work/store';
import {
  linkedObjectRefreshSchema,
  refreshLinkedObjects,
  type LinkedObjectRefresh,
} from './linked_object_cache';

export {
  hasBridgedLinkedObjects,
  linkedObjectRefreshSchema,
  refreshLinkedObjects,
  type LinkedObjectRefresh,
} from './linked_object_cache';

/** Queue one refresh for one inbound event. Never deduped: each delivery
 *  carries the record's state at that moment. */
export async function enqueueLinkedObjectRefresh(input: {
  refresh: LinkedObjectRefresh;
  /** The delivery's own id when it has one, else the record's. */
  eventKey: string;
}): Promise<void> {
  await enqueueWork({
    kind: 'linked_object_refresh',
    key: `linked_object_refresh:${input.eventKey}:${randomUUID()}`,
    teamId: input.refresh.teamId,
    payload: input.refresh,
  });
}

// A provider outage backs a row off to minutes between attempts; past this
// many the record is left stale until its next event rather than retried forever.
const MAX_REFRESH_ATTEMPTS = 10;

export const linkedObjectRefreshHandler: WorkHandler = {
  async run(payload, ctx) {
    const refresh = linkedObjectRefreshSchema.parse(payload);
    try {
      await refreshLinkedObjects(refresh);
    } catch (error) {
      if (ctx.attempts < MAX_REFRESH_ATTEMPTS) throw error;
      logger.warn('[LinkedObjectRefresh] giving up on the refresh', {
        teamId: refresh.teamId,
        provider: refresh.provider,
        externalId: refresh.externalId,
        attempts: ctx.attempts,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

// Inbound sync's own kind: one row per linked record to re-read.

declare module '../work/kinds' {
  interface UnitWorkKinds {
    linked_object_refresh: true;
  }
}

export function registerLinkedObjectWork(): void {
  registerWorkKinds([{ kind: 'linked_object_refresh', handler: linkedObjectRefreshHandler }]);
}
