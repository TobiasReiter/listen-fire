// The `wake_await` work row: "resume whatever is parked on this key". Its own
// module so the doors that queue one (the inbound handler, the push doors, the
// production host's `park.wake`) never import the resume driver, which imports
// the engine.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { enqueueWork } from '../work/store';
import type { TeamId } from '../../generated/kysely/core/Team';

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
  await enqueueWork({
    kind: 'wake_await',
    key: `wake_await:${opts.coalesceKey ?? randomUUID()}`,
    teamId: wake.teamId,
    payload: wake,
    ...(opts.dueAt !== undefined ? { dueAt: opts.dueAt } : {}),
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
