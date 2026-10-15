// Telegram deep-link handshake — the AUTHENTICATED binding that ties a real
// Telegram account to a Listen-Fire user. This is the ONLY write path into
// `automations.telegram_identity`, which is the anti-hijack guarantee: a team can
// only ever bind a Telegram id it controls via a token minted by one of its
// own logged-in sessions, then consented to by that real Telegram account's
// `/start <token>`.
//
// Two halves of the handshake live here:
//   - `mintTelegramToken`   — the logged-in side (called by the `connectTelegram`
//     tRPC mutation): generate a random, short-lived, single-use token.
//   - `bindTelegramFromStart` — the Telegram side (called by Chunk 5's inbound
//     webhook when a `/start <token>` arrives): validate the token, resolve the
//     minting user's primary email, write the identity row, burn the token —
//     atomically.
//
// Security properties honoured:
//   - The token is the only secret linking a logged-in session to a Telegram
//     account. It is cryptographically random (`randomBytes(32)` → url-safe
//     base64, ≤64 chars so it fits Telegram's `start` payload cap).
//   - One-time (`used_at`), short-lived (10-minute expiry) — defends replay.
//   - The binding is created ONLY here, in one transaction with the token
//     consume, so token-consume and identity-write can never diverge.

import { randomBytes, randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import type CoreSchema from '../../../../generated/kysely/core/CoreSchema';
import type AutomationsSchema from '../../../../generated/kysely/automations/AutomationsSchema';
import type { UserId } from '../../../../generated/kysely/core/User';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';

import { encryptToken } from '../../../../lib/credentials';
import { getAutomationsQb, getQb, globalQb } from '../../../../lib/kysely';
import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { logger } from 'movement-engine/services/logger';

/**
 * Typed, schema-scoped clients off an explicit transaction. `withSchema`
 * doesn't narrow the row types on its own, so we cast to the generated schema
 * interfaces — the same cast the `getAutomationsQb`/`getQb` helpers make, applied
 * to OUR transaction so every query in the handshake shares one atomic unit
 * (independent of any ambient context transaction).
 */
function automationsTrx(trx: unknown): Kysely<AutomationsSchema> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (trx as any).withSchema('automations');
}

/**
 * The login-identity read is core's now (D3). This was `withSchema('public')`
 * against `Kysely<DB>` — which kept compiling after the move, because `DB` is
 * the intersection of every schema, and would have failed only at runtime.
 * `getQb`'s surface excludes moved tables for exactly this reason; a hand-typed
 * client has to be pointed by hand.
 */
function coreTrx(trx: unknown): Kysely<CoreSchema> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (trx as any).withSchema('core');
}

/** How long a freshly minted handshake token stays valid. */
export const TELEGRAM_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * The shared built-in Listen-Fire bot's @username, read from `TELEGRAM_BOT_USERNAME`.
 * Optional by design and read directly off `process.env` (mirroring how the
 * adapter reads `TELEGRAM_BOT_TOKEN`) — an unset or whitespace-only value yields
 * null rather than crashing, so the deep-link mint can surface a clean
 * "bot not configured" error instead of throwing. The value is the bare
 * username (no leading `@`); a leading `@` is stripped if present so the
 * `t.me/<username>` URL is always well-formed.
 */
export function builtInBotUsername(): string | null {
  const raw = process.env.TELEGRAM_BOT_USERNAME;
  const trimmed = typeof raw === 'string' ? raw.trim().replace(/^@/, '') : '';
  return trimmed.length > 0 ? trimmed : null;
}

/** The `t.me` deep-link a logged-in user opens to bind their Telegram account. */
export function telegramStartUrl(input: { botUsername: string; token: string }): string {
  return `https://t.me/${input.botUsername}?start=${input.token}`;
}

/**
 * Generate a cryptographically-random, url-safe one-time token. 32 random
 * bytes → 43 base64url chars, comfortably under Telegram's 64-char `start`
 * payload limit and well clear of any collision concern (the UNIQUE(token)
 * constraint is the backstop, not the primary defence).
 */
export function generateTelegramToken(): string {
  return randomBytes(32).toString('base64url');
}

export type MintTelegramTokenInput = {
  nativeUserId: string;
  teamId: string;
};

export type MintTelegramTokenResult = {
  token: string;
  expiresAt: Date;
};

/**
 * Mint a handshake token for a logged-in user. Dedupe policy: before inserting,
 * delete this user's prior UNCONSUMED tokens (same `native_user_id` + `team_id`,
 * `used_at` null) so a user clicking "Connect" repeatedly leaves at most one
 * live token instead of an unbounded pile. Already-consumed tokens are kept (an
 * audit trail of past bindings); expired-but-unconsumed ones are swept here too
 * since they share the unconsumed predicate. The whole mint is one transaction
 * so the sweep + insert are atomic.
 */
export async function mintTelegramToken(
  input: MintTelegramTokenInput,
): Promise<MintTelegramTokenResult> {
  const { nativeUserId, teamId } = input;
  const token = generateTelegramToken();
  const expiresAt = new Date(Date.now() + TELEGRAM_TOKEN_TTL_MS);

  await globalQb.transaction().execute(async (trx) => {
    const automations = automationsTrx(trx);

    await automations
      .deleteFrom('telegram_token')
      .where('native_user_id', '=', nativeUserId)
      .where('team_id', '=', teamId)
      .where('used_at', 'is', null)
      .execute();

    await automations
      .insertInto('telegram_token')
      .values({
        token,
        native_user_id: nativeUserId,
        team_id: teamId,
        expires_at: expiresAt,
      })
      .execute();
  });

  return { token, expiresAt };
}

/**
 * The default display name for a freshly created shared-bot credential row.
 * Deliberately just "Telegram" — "shared bot" leaked the multi-tenant transport
 * into a user-facing name and posed a tenancy question ("shared with whom?")
 * it never answered. The credential is the TEAM's Telegram connection; the
 * transport being Listen-Fire's bot is an implementation detail.
 */
export const SHARED_TELEGRAM_CREDENTIAL_NAME = 'Telegram';

/**
 * Connect the TEAM to the optional shared built-in Telegram bot by ensuring an
 * EMPTY `TELEGRAM` credential exists — a real `external_service_credentials`
 * row whose encrypted payload carries NO bot token (`{}`). That row does two
 * jobs:
 *   (a) satisfies movement-lang's `telegram(credentials: …)` construction
 *       requirement — it's a valid catalog credential the program imports;
 *   (b) signifies "this team has opted into the optional shared adapter".
 * The transport secret stays the env `TELEGRAM_BOT_TOKEN`; the adapter's
 * empty-credential resolution falls THIS row back to the built-in token.
 *
 * Idempotent: if the team already has any `TELEGRAM` credential (empty or
 * BYO), return the existing one — WITH ITS NAME — rather than duplicating.
 * `name` applies only on creation (an agent's requested credentialName, or the
 * default); an existing credential keeps its name, which is why callers that
 * PROMISE a name up-front (mintConnectLink) must resolve the existing name at
 * promise time. Distinct from the deep-link handshake above, which links a
 * single USER's identity — this connects the TEAM. Shared by the in-app
 * connect flow (`connectTelegramTeam`) and the author-time connect-link
 * landing route.
 *
 */
export async function ensureSharedTelegramTeamCredential(input: {
  teamId: TeamId;
  userId: UserId;
  name?: string;
}): Promise<{ id: string; name: string; created: boolean }> {
  const existing = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', input.teamId)
    .where('type', '=', ExternalServiceType.TELEGRAM)
    .select(['id', 'name'])
    .executeTakeFirst();
  if (existing) {
    return { id: existing.id as unknown as string, name: existing.name, created: false };
  }

  // Mirror the standard credential-create path (pipelineConfiguration
  // .addCredential): randomUUID id → encryptToken(JSON, id) → insert.
  // The payload is empty (`{}`) — a secret-less, connected credential.
  const name = input.name?.trim() || SHARED_TELEGRAM_CREDENTIAL_NAME;
  const id = randomUUID();
  const encrypted = await encryptToken(JSON.stringify({}), id);
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({
      id: id as ExternalServiceCredentialsId,
      name,
      type: ExternalServiceType.TELEGRAM,
      credentials: encrypted,
      identifier: null,
      team_id: input.teamId,
      user_id: input.userId,
    })
    .executeTakeFirst();

  return { id, name, created: true };
}

export type BindTelegramInput = {
  token: string;
  telegramUserId: string;
};

export type BindTelegramFailureReason =
  | 'token_not_found'
  | 'token_used'
  | 'token_expired'
  | 'no_primary_email';

export type BindTelegramResult =
  | { ok: true; email: string; telegramUserId: string }
  | { ok: false; reason: BindTelegramFailureReason };

/**
 * Consume a `/start <token>` handshake and bind the real Telegram account to
 * the minting user's identity. The whole thing runs in ONE transaction so the
 * token-burn and the identity-write are atomic — a half-applied bind can never
 * exist.
 *
 * Validation (each a typed reject, no row written, token untouched):
 *   - token not found              → `token_not_found`
 *   - token already consumed       → `token_used`
 *   - token past `expires_at`      → `token_expired`
 *   - minting user has no primary  → `no_primary_email`
 *     email (`user_email.is_primary`)
 *
 * On success: UPSERT `automations.telegram_identity { team_id, telegram_user_id,
 * email }` — re-linking the same (team, telegram user) UPDATES the existing row
 * (respecting `UNIQUE(team_id, telegram_user_id)`) rather than duplicating —
 * and set the token's `used_at = now`.
 *
 */
export async function bindTelegramFromStart(
  input: BindTelegramInput,
): Promise<BindTelegramResult> {
  const { token, telegramUserId } = input;

  return globalQb.transaction().execute(async (trx): Promise<BindTelegramResult> => {
    const automations = automationsTrx(trx);
    const core = coreTrx(trx);

    // Lock the token row for the duration of the transaction so two concurrent
    // `/start`s with the same token can't both pass the unused check.
    const tokenRow = await automations
      .selectFrom('telegram_token')
      .where('token', '=', token)
      .select(['id', 'native_user_id', 'team_id', 'expires_at', 'used_at'])
      .forUpdate()
      .executeTakeFirst();

    if (!tokenRow) return { ok: false, reason: 'token_not_found' };
    if (tokenRow.used_at !== null) return { ok: false, reason: 'token_used' };
    if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
      return { ok: false, reason: 'token_expired' };
    }

    const emailRow = await core
      .selectFrom('user_email')
      .where('user_id', '=', tokenRow.native_user_id as unknown as UserId)
      .where('is_primary', '=', true)
      .select(['email'])
      .executeTakeFirst();

    const email =
      typeof emailRow?.email === 'string' ? emailRow.email.trim().toLowerCase() : '';
    if (email.length === 0) return { ok: false, reason: 'no_primary_email' };

    // UPSERT the identity: re-linking the same (team, tg user) updates the
    // bound email + linked_at instead of inserting a duplicate.
    await automations
      .insertInto('telegram_identity')
      .values({
        team_id: tokenRow.team_id,
        telegram_user_id: telegramUserId,
        email,
      })
      .onConflict((oc) =>
        oc.columns(['team_id', 'telegram_user_id']).doUpdateSet({
          email,
          linked_at: new Date(),
        }),
      )
      .execute();

    // Burn the token — single-use.
    await automations
      .updateTable('telegram_token')
      .set({ used_at: new Date() })
      .where('id', '=', tokenRow.id)
      .execute();

    logger.info('[TelegramHandshake] bound telegram identity', {
      teamId: tokenRow.team_id,
      telegramUserId,
    });

    return { ok: true, email, telegramUserId };
  });
}
