// The `wake_await` work row: "resume whatever is parked on this key". Its own
// module so the doors that queue one (the inbound handler, the park sink's
// re-check) never import the resume driver, which imports the engine that
// imports the park sink.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { enqueueWork } from '../work/store';
import type { TeamId } from '../../generated/kysely/core/Team';

export const wakeAwaitPayloadSchema = z.object({
  adapterType: z.string(),
  teamId: z.custom<TeamId>((value) => typeof value === 'string'),
  correlationKey: z.string(),
});

type AwaitWake = z.infer<typeof wakeAwaitPayloadSchema>;

/** Queue the event-driven wake for one adapter identity. Never deduped: a second
 *  signal on the same identity while the first wake is running must still drive
 *  the parks the first pass already looked past. */
export async function enqueueAwaitWake(wake: AwaitWake): Promise<void> {
  await enqueueWork({
    kind: 'wake_await',
    key: `wake_await:${randomUUID()}`,
    teamId: wake.teamId,
    payload: wake,
  });
}
