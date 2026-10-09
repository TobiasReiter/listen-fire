// Shared helpers for Listen-Fire's acting-user resolution chain
// (adapters/acting_user/resolve.ts).
//
// The chain reads `trigger.config.overrideActingUserToCreator` /
// `trigger.config.fallbackToCreatorIfActorUnregistered` and loads
// `trigger.created_by_user_id` → user row, and matches actor emails against
// `user_email`. Centralising these helpers keeps the Listen-Fire DB access in one
// place — the adapters' `getActorCandidates` never touch them.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { ActingUser } from '../adapter';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { normalizeWhatsappPhone } from './acting_user/phone';

/**
 * Per-trigger config slot for the creator-fallback opt-in. Adapters whose
 * auth chain includes "if the actor doesn't map to a Listen-Fire user, the
 * dispatch counts as the trigger creator" (Slack, Attio) read this off
 * `trigger.config`.
 *
 * Schema-wise it's a single boolean; the slot lives on the existing
 * `automations.trigger.config` jsonb column — no migration. Authors who
 * provision a trigger without setting it default to `false` (strict
 * rejection), matching the rest of the auth model.
 */
export const FALLBACK_TO_CREATOR_CONFIG_KEY = 'fallbackToCreatorIfActorUnregistered' as const;

/**
 * Per-trigger config slot for the creator-override (T6, ruling 2026-06-01).
 * When set, `resolveActingUser` short-circuits at step 1 and authenticates
 * as the trigger creator — NOT a bypass of auth, a re-credit. The raw actor
 * who performed the change is still surfaced verbatim via `@actor_*`
 * (`extractActor` is untouched by this flag).
 *
 * Rationale: for Attio (the primary use case) the creator connected the
 * integration — that connection is the fact that makes events flow to us —
 * so crediting them as the acting user is correct even though the literal
 * actor who edited the record is someone else. General across adapters.
 *
 * Like the fallback flag, this lives on the existing `trigger.config` jsonb
 * column (no migration) and defaults to `false`. Crucially it does NOT
 * loosen the gate: override-on with no creator on the trigger still rejects.
 */
export const OVERRIDE_ACTING_USER_TO_CREATOR_CONFIG_KEY = 'overrideActingUserToCreator' as const;

/**
 * Read the creator-fallback flag from a trigger row's config. Tolerates
 * missing/malformed config (default false) so a partial provisioning
 * doesn't accidentally open the auth gate.
 */
export function readCreatorFallbackConfig(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const value = (config as Record<string, unknown>)[FALLBACK_TO_CREATOR_CONFIG_KEY];
  return value === true;
}

/**
 * Read the creator-override flag from a trigger row's config. Same
 * tolerant defaults as the fallback flag (missing/malformed → false).
 */
export function readOverrideToCreatorConfig(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const value = (config as Record<string, unknown>)[OVERRIDE_ACTING_USER_TO_CREATOR_CONFIG_KEY];
  return value === true;
}

/**
 * Trigger context shape `resolveActingUser` receives.
 * Hoisted here so the shared step-1 override helper can take it directly.
 */
export interface ActingUserTriggerContext {
  id: string;
  kind: string;
  config: unknown;
  createdByUserId: string | null;
}

/**
 * Step 1 of every adapter's resolution order (T6): the creator-override.
 *
 * Returns:
 *   • `{ overridden: false }` — the flag is off; the adapter should fall
 *     through to its normal actor-resolution chain.
 *   • `{ overridden: true, user }` — the flag is on; the dispatch is
 *     re-credited to the trigger creator. `user` is `null` when there is
 *     no creator on the trigger (or the creator row is gone) — the caller
 *     must treat that as a rejection. Override never opens the gate.
 *
 * Centralised here (rather than inlined per adapter) so the override is
 * uniformly step 1 across email / Slack / Attio.
 */
export async function applyCreatorOverride(
  trigger: ActingUserTriggerContext | undefined,
): Promise<{ overridden: false } | { overridden: true; user: ActingUser | null }> {
  if (!trigger || !readOverrideToCreatorConfig(trigger.config)) {
    return { overridden: false };
  }
  if (!trigger.createdByUserId) {
    return { overridden: true, user: null };
  }
  const user = await loadActingUserById(trigger.createdByUserId);
  return { overridden: true, user };
}

/**
 * Load a Listen-Fire user by id, projecting them onto the `ActingUser` shape
 * the meta resolver expects. Used by the Slack/Attio creator-fallback
 * arm — the trigger row stores `created_by_user_id`; this resolves it to
 * `{ id, email, name }`. Returns null when the row is missing or
 * doesn't have a usable primary email.
 *
 * Email fallback to username matches `engine/expression.ts:loadActingUser`
 * so service users without a primary email row still surface a non-null
 * `@user_email` (the username slot).
 */
export async function loadActingUserById(userId: string): Promise<ActingUser | null> {
  const row = await getCoreQb(['user', 'user_email'])
    .selectFrom('user as u')
    .leftJoin('user_email as ue', (j) =>
      j.onRef('ue.user_id', '=', 'u.id').on('ue.is_primary', '=', true),
    )
    .where('u.id', '=', userId as never)
    .select(['u.id', 'u.username', 'ue.email'])
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id as unknown as string,
    email: (row.email ?? row.username) as unknown as string,
    name: row.username as unknown as string,
  };
}

/**
 * Resolve an email address to a `user_email` row scoped to the team,
 * optionally requiring the row to be flagged as a service email. Returns a
 * minimal `ActingUser` (id + email + name) on hit, null on miss.
 *
 * Two-pass lookup, mirroring the legacy `mailgun.adapter.ts:getSenderIdentifier`
 * (audited verbatim in T5-audit):
 *   1. Exact match on `user_email.email`.
 *   2. If miss AND the address contains a `+tag`, strip the tag and retry
 *      against rows with `accepts_plus_addressing = true`. This lets a
 *      sender like `ada+notes@example.com` resolve to the canonical
 *      `ada@example.com` user row when that row opts in.
 *
 * This is the single email→user resolver shared across adapters. T5-audit
 * settled the email auth chain against this; T6's Slack/Attio runtime
 * auto-match reuses the exact same two-pass semantics so a person who
 * email-matches on one channel matches identically on all of them.
 */
export async function lookupTeamUserByEmail(input: {
  email: string;
  teamId: TeamId;
  requireServiceEmail: boolean;
}): Promise<ActingUser | null> {
  const normalized = input.email.trim().toLowerCase();
  if (!normalized.includes('@')) return null;

  const direct = await runUserEmailLookup({
    email: normalized,
    teamId: input.teamId,
    requireServiceEmail: input.requireServiceEmail,
    acceptsPlusOnly: false,
  });
  if (direct) return direct;

  const stripped = stripPlusAddress(normalized);
  if (stripped && stripped !== normalized) {
    const viaPlus = await runUserEmailLookup({
      email: stripped,
      teamId: input.teamId,
      requireServiceEmail: input.requireServiceEmail,
      acceptsPlusOnly: true,
    });
    if (viaPlus) return viaPlus;
  }

  return null;
}

async function runUserEmailLookup(input: {
  email: string;
  teamId: TeamId;
  requireServiceEmail: boolean;
  acceptsPlusOnly: boolean;
}): Promise<ActingUser | null> {
  let qb = getCoreQb(['user_email', 'user'])
    .selectFrom('user_email as ue')
    .innerJoin('user as u', 'u.id', 'ue.user_id')
    .where('ue.email', '=', input.email)
    .where('u.default_team_id', '=', input.teamId)
    .where('ue.is_service_email', '=', input.requireServiceEmail);
  if (input.acceptsPlusOnly) {
    qb = qb.where('ue.accepts_plus_addressing', '=', true);
  }
  const row = await qb
    .select(['u.id', 'ue.email as email', 'u.username'])
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id as unknown as string,
    email: row.email as unknown as string,
    name: row.username as unknown as string,
  };
}

/**
 * Strip a plus-address tag from an email: `ada+notes@example.com` →
 * `ada@example.com`. Returns the original string when no `+` precedes `@`.
 */
function stripPlusAddress(email: string): string {
  return email.replace(/\+[^@]*@/, '@');
}

/**
 * Resolve a phone number to a team user via the `phone_number` table.
 * The WhatsApp twin of `lookupTeamUserByEmail` — WhatsApp originator
 * candidates carry a `scheme: 'phone'` identity rather than an email.
 *
 * Mirrors the v3 WhatsApp auth path
 * (`twilio.adapter.ts:validateInboundRequest` →
 * `unauthorisedGetUserByPhone`), which matches the `whatsapp:`-stripped
 * `From` against `phone_number.phone_number` AND requires the matched user
 * to have been granted access (`granted_access_at IS NOT NULL`). The
 * grant gate is the auth boundary — without it an invited/pending/revoked
 * user whose number happens to be on the team would authenticate. Scoped to
 * the team via the owning user's `team_id` (`phone_number` has no team
 * column of its own).
 *
 * Returns a minimal `ActingUser` (id + a usable display email + name) on
 * hit, null on miss. There's no plus-address / service-email distinction
 * for phones — a single exact match on the normalised number.
 */
export async function lookupTeamUserByPhone(input: {
  phone: string;
  teamId: TeamId;
}): Promise<ActingUser | null> {
  const normalized = normalizeWhatsappPhone(input.phone);
  if (!normalized) return null;

  // Two queries, not a join: the number lives in this unit's own channel-identity
  // table and the person lives in core's, and the carve forbids a query that
  // spans both (D3/D28). The gates are unchanged — same normalised match, same
  // team scope, same `granted_access_at` requirement.
  const link = await getAutomationsQb(['phone_number'])
    .selectFrom('phone_number')
    .where('phone_number', '=', normalized)
    .select('user_id')
    .executeTakeFirst();
  if (!link?.user_id) return null;

  const row = await getCoreQb(['user', 'user_email'])
    .selectFrom('user as u')
    .leftJoin('user_email as ue', (j) =>
      j.onRef('ue.user_id', '=', 'u.id').on('ue.is_primary', '=', true),
    )
    .where('u.id', '=', link.user_id as UserId)
    .where('u.default_team_id', '=', input.teamId)
    .where('u.granted_access_at', 'is not', null)
    .select(['u.id', 'u.username', 'ue.email'])
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id as unknown as string,
    email: (row.email ?? row.username) as unknown as string,
    name: row.username as unknown as string,
  };
}
