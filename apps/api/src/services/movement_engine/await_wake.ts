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

/** Queue the event-driven wake for one adapter identity. A signal's wake is
 *  never deduped: a second signal on the same identity while the first wake is
 *  running must still drive the parks the first pass already looked past.
 *
 *  A sweep or backstop that re-derives the same wake on every pass names a
 *  `coalesceKey` instead, so repeated passes fold onto one pending row rather
 *  than piling up while the drain is behind. `dueAt` defers it (a backstop that
 *  should only matter if the prompt wake was lost). */
export async function enqueueAwaitWake(
  wake: AwaitWake,
  opts: { coalesceKey?: string; dueAt?: Date } = {},
): Promise<void> {
  await enqueueWork({
    kind: 'wake_await',
    key: `wake_await:${opts.coalesceKey ?? randomUUID()}`,
    teamId: wake.teamId,
    payload: wake,
    ...(opts.dueAt !== undefined ? { dueAt: opts.dueAt } : {}),
  });
}
