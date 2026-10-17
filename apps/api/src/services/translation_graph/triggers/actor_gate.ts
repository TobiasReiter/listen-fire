// Ownership gating for inbound events — the §6.4b rule: on a gated adapter,
// an inbound event is processed only when its actor resolves to a
// REGISTERED team user. One rule covers both hazards: the bot's own reply
// re-ingested (never a registered user → drops → no self-loop) and an
// unregistered person addressing the bot (drops — accepted implication:
// listeners never fire on messages from externals/guests).
//
// The resolver runs WITHOUT trigger context, deliberately: resolveActingUser's
// creator override and fallbackToCreatorIfActorUnregistered authenticate an
// UNRESOLVED actor as the trigger creator — attribution conveniences that
// would let the bot's own echo pass an ownership gate. They keep governing
// run-time `@user_*` attribution only.
//
// Fail CLOSED: no candidates, no match, or a resolution error all drop —
// failing open reopens the loop this gate exists to kill. The dispatcher
// marks the stored receipt suppressed, so nothing is lost: a wrongly-dropped
// event is visible and replayable.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ActingUser, ActorCandidate, Adapter } from 'movement-engine/public/adapter';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { resolveActingUser } from '../adapters/acting_user/resolve';
import { getAdapterManifest } from '../adapters/registry';

export type ActorGateDisposition =
  | { kind: 'proceed' }
  | { kind: 'drop'; reason: string };

/** Construction-free read of the manifest fact (slug-alias tolerant). */
export function inboundActorGateEnabled(adapterType: string): boolean {
  return getAdapterManifest(adapterType)?.inboundRequiresRegisteredActor === true;
}

type Resolve = (input: {
  teamId: TeamId;
  getCandidates: () => Promise<ActorCandidate[]>;
}) => Promise<ActingUser | null>;

export async function consultActorGate(input: {
  teamId: TeamId;
  sourceAdapter: Adapter | null;
  event: TriggerEvent;
  /** Injectable for tests; defaults to the real Listen-Fire-side resolution. */
  resolve?: Resolve;
}): Promise<ActorGateDisposition> {
  if (!inboundActorGateEnabled(input.event.adapterType)) return { kind: 'proceed' };

  const candidates = input.sourceAdapter?.getActorCandidates;
  if (!candidates) {
    return {
      kind: 'drop',
      reason:
        `${input.event.adapterType}: inbound requires a registered actor, but the source ` +
        'adapter surfaces no actor candidates — dropping (fail closed).',
    };
  }
  const resolve: Resolve = input.resolve ?? resolveActingUser;
  try {
    const user = await resolve({
      teamId: input.teamId,
      getCandidates: () => candidates.call(input.sourceAdapter, { event: input.event }),
    });
    if (user) return { kind: 'proceed' };
    return {
      kind: 'drop',
      reason:
        `${input.event.adapterType}: the inbound actor does not resolve to a registered ` +
        'team user (unregistered sender, or the bot\'s own message) — dropped by the ' +
        'ownership gate.',
    };
  } catch (err) {
    return {
      kind: 'drop',
      reason:
        `${input.event.adapterType}: the inbound actor could not be resolved ` +
        `(${err instanceof Error ? err.message : String(err)}) — dropped (fail closed; ` +
        'the event receipt is replayable).',
    };
  }
}
