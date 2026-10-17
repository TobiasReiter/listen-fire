// The `wake_await` work row: "resume whatever is parked on this key". Its own
// module so the doors that queue one (the inbound handler, the push doors, the
// production host's `park.wake`) never import the resume driver, which imports
// the engine.

import { z } from 'zod';
import { queueAwaitWake } from 'movement-engine/public/run-host';

import type { TeamId } from '../../generated/kysely/core/Team';

import { postgresRunHostStore } from './run_host_store';

export const wakeAwaitPayloadSchema = z.object({
  adapterType: z.string(),
  teamId: z.custom<TeamId>((value) => typeof value === 'string'),
  correlationKey: z.string(),
});

export type AwaitWake = z.infer<typeof wakeAwaitPayloadSchema>;

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
  await queueAwaitWake(postgresRunHostStore, wake, {
    ...(opts.coalesceKey !== undefined ? { coalesceKey: opts.coalesceKey } : {}),
    ...(opts.dueAt !== undefined ? { dueAt: opts.dueAt.toISOString() } : {}),
  });
}

/** Queue a wake per correlation key one signal named (a webhook delivery's
 *  `wakeKeys`, a push door's `wake`). Team-scoped, so a signal only wakes its
 *  own team's parks; a key nothing is parked on drains as a no-op. Throws on
 *  the first row that cannot be queued, so the caller can refuse the signal
 *  and have its sender retry. */
export async function enqueueAwaitWakes(input: {
  adapterType: string;
  teamId: TeamId;
  correlationKeys: readonly string[];
}): Promise<void> {
  for (const correlationKey of input.correlationKeys) {
    await enqueueAwaitWake({ adapterType: input.adapterType, teamId: input.teamId, correlationKey });
  }
}
