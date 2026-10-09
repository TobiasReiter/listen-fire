// Listen-Fire-side acting-user resolution — the half of the acting-user split
// that owns Listen-Fire DB access.
//
// Adapters parse `ActorCandidate[]` from the event (`getActorCandidates`,
// NO Listen-Fire DB). This module runs the identical resolution chain that the
// per-adapter `identifyActingUser` methods used to run inline:
//
//   1. Creator override (T6) — `trigger.config.overrideActingUserToCreator`
//      short-circuits to the trigger creator (rejects if no creator). Never
//      loosens the gate.
//   2. Originator candidates — matched against NON-service `user_email`
//      rows (the email sender, the Slack/Attio actor).
//   3. Relay candidates — matched against SERVICE `user_email` rows (the
//      forwarding / service inbox that delivered the message).
//   4. Creator fallback (Slack/Attio) — if
//      `trigger.config.fallbackToCreatorIfActorUnregistered` and the
//      trigger has a creator, authenticate as the creator.
//   5. Otherwise → null. The dispatcher rejects.
//
// The candidate thunk is invoked LAZILY (after the override short-circuit)
// so an override-on dispatch never pays the Slack/Attio actor-email API
// round-trip.

import type { ActingUser, ActorCandidate } from '../../adapter';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import {
  applyCreatorOverride,
  lookupTeamUserByEmail,
  lookupTeamUserByPhone,
  loadActingUserById,
  readCreatorFallbackConfig,
  type ActingUserTriggerContext,
} from '../acting_user_shared';

export async function resolveActingUser(input: {
  teamId: TeamId;
  trigger?: ActingUserTriggerContext;
  getCandidates: () => Promise<ActorCandidate[]>;
}): Promise<ActingUser | null> {
  // 1. Creator override (T6) — short-circuits before the parse thunk runs.
  const override = await applyCreatorOverride(input.trigger);
  if (override.overridden) return override.user;

  const candidates = await input.getCandidates();
  const emailOf = (c: ActorCandidate) => c.identity.email ?? c.identity.identifier;

  // 2. Originators → non-service team users. The candidate's `scheme` says
  //    how it resolves: `'phone'` (WhatsApp) matches against `phone_number`;
  //    `'email'` matches against non-service `user_email`. `'opaque'`
  //    candidates carry no email/phone the team-user tables can match, so
  //    they're skipped (resolution falls through to the next candidate /
  //    creator fallback) rather than triggering a bogus email lookup.
  for (const c of candidates.filter((c) => c.source === 'originator')) {
    if (c.identity.scheme === 'opaque') continue;
    const u = c.identity.scheme === 'phone'
      ? await lookupTeamUserByPhone({
          phone: c.identity.identifier,
          teamId: input.teamId,
        })
      : await lookupTeamUserByEmail({
          email: emailOf(c),
          teamId: input.teamId,
          requireServiceEmail: false,
        });
    if (u) return u;
  }

  // 3. Relays → service team users. Relays are always email-addressed
  //    (forwarding / service inboxes); an `'opaque'` relay has no email to
  //    match, so skip it.
  for (const c of candidates.filter((c) => c.source === 'relay')) {
    if (c.identity.scheme === 'opaque') continue;
    const u = await lookupTeamUserByEmail({
      email: emailOf(c),
      teamId: input.teamId,
      requireServiceEmail: true,
    });
    if (u) return u;
  }

  // 4. Creator fallback (Slack/Attio chains opt in via trigger config).
  if (
    input.trigger
    && readCreatorFallbackConfig(input.trigger.config)
    && input.trigger.createdByUserId
  ) {
    return await loadActingUserById(input.trigger.createdByUserId);
  }

  // 5. No signal — reject.
  return null;
}
