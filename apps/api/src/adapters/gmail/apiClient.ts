// Gmail for the platform's own callers: the stored credential shapes, the
// connect-time checks (the mailbox allowlist, a pasted refresh token, the
// first call as the mailbox) and a client per stored credential. The wire
// client itself is the module's (@lf/gmail); this one hands it tokens from
// the platform's own token clients — the sign-in's google-auth-library client
// (which refreshes and writes the stored credential back itself), or the
// service account acting as the mailbox, one token per scope.
//
// The mailbox is reached one of two ways, and the stored credential says which
// (see `connect_method.ts` for the choice and `app_id.ts` for how a row is told
// apart without decrypting it):
//
//   OAUTH — somebody signed in as the mailbox, and the credential carries that
//     sign-in's refresh token plus the scopes Google granted. Google confines
//     the token to that one address.
//   DELEGATED — the deployment's service account acts as the address, granted
//     once by a Workspace admin. The credential is then just the address:
//     everything secret lives in the deployment's own environment.

import { z } from 'zod';

import type { GmailConnectMethod } from './connect_method';

import {
  GMAIL_SEND_SCOPE,
  GmailApiClient as ModuleGmailApiClient,
  classifyGmailError,
  type GmailProfile,
  type GmailScope,
} from '@lf/gmail/api_client';
import {
  GMAIL_READONLY_SCOPE,
  delegatedGoogleAuth,
  gmailMailboxAllowlist,
  isGoogleServiceAccountConfigured,
} from 'movement-engine/public/google-cloud';
import { neverAsAny } from 'movement-engine/public/utils';
import {
  GMAIL_REFRESH_TOKEN_REFUSED_MESSAGE,
  GmailRefreshTokenError,
  gmailTokenClient,
  redeemGmailRefreshToken,
  type GmailTokens,
} from './authClient';

export {
  GMAIL_MAX_PAGE,
  GMAIL_SCOPES,
  GmailApiError,
  classifyGmailError,
  gmailMessageSchema,
  gmailMissingSendScopeMessage,
  gmailPartSchema,
  gmailProfileSchema,
  type GmailFailure,
  type GmailHistoryAddition,
  type GmailMessage,
  type GmailMessageRef,
  type GmailPart,
  type GmailProfile,
  type GmailSentMessage,
} from '@lf/gmail/api_client';

/** The scopes per call: each asks for exactly the ONE it needs, so a
 *  delegation grant that covers reads but not sends fails only the send. */
const DELEGATED_SCOPES: Record<GmailScope, readonly string[]> = {
  read: [GMAIL_READONLY_SCOPE],
  send: [GMAIL_SEND_SCOPE],
};

/** What the dev loop's fake is authenticated with: a fake needs no token, and
 *  minting one would mean impersonating a mailbox that does not exist against
 *  a Google that was never asked. */
export const DEV_LOOP_GMAIL_TOKEN = 'dev-loop-gmail-key';

/**
 * Stored DELEGATED credential. One field the user typed — the mailbox address —
 * plus the dev loop's injected base URL. No token, because there is none: the
 * deployment's service account is the whole authority, and this row only names
 * whose mail it acts on.
 */
export const gmailDelegatedCredsParser = z.object({
  mailbox: z.string().email(),
  baseUrl: z.string().url().optional(),
});
export type GmailDelegatedCredentials = z.infer<typeof gmailDelegatedCredsParser>;

/**
 * Stored OAUTH credential — the sign-in's tokens, the address that signed in
 * (read from `users.getProfile` at connect time, never typed), and the scopes
 * Google said it granted.
 *
 * The granted scopes are stored because they are the only way to know a send
 * will be refused BEFORE asking Google to send. Google is still the authority,
 * and the classification of a refused call stays the backstop — but a message
 * that was never going to leave should fail saying so, not after a round trip.
 */
export const gmailOAuthCredsParser = z.object({
  mailbox: z.string().email(),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  grantedScopes: z.array(z.string()),
  baseUrl: z.string().url().optional(),
});
export type GmailOAuthCredentials = z.infer<typeof gmailOAuthCredsParser>;

/** Either stored shape. Ordered so a full OAuth payload is never read as a
 *  delegated one that happens to carry extra keys. */
export const gmailCredsParser = z.union([gmailOAuthCredsParser, gmailDelegatedCredsParser]);
export type GmailCredentials = z.infer<typeof gmailCredsParser>;

/** Which shape a payload is, STRUCTURALLY — a credential that carries a refresh
 *  token is one somebody signed in for, whatever any column says. */
export function isGmailOAuthCredentials(
  credentials: GmailCredentials,
): credentials is GmailOAuthCredentials {
  return 'refreshToken' in credentials;
}

/** The connect method a stored credential belongs to. */
export function gmailMethodOf(credentials: GmailCredentials): GmailConnectMethod {
  return isGmailOAuthCredentials(credentials) ? 'oauth' : 'delegated';
}

// ── The client ──────────────────────────────────────────────────────────────

/** The service account acting as a mailbox, for one scope: a token minted
 *  per call, cached by the library until it expires. */
function delegatedToken(mailbox: string, scope: GmailScope): () => Promise<string> {
  const auth = delegatedGoogleAuth({ subject: mailbox, scopes: DELEGATED_SCOPES[scope] });
  return async () => {
    const { token } = await (await auth.getClient()).getAccessToken();
    if (!token) throw new Error(`Google issued no token acting as ${mailbox}.`);
    return token;
  };
}

/** One token for one scope, minted by the service account acting as the
 *  mailbox, with when it expires. */
export async function mintDelegatedGmailToken(mailbox: string, scope: string): Promise<{ token: string; expiresAt: number }> {
  const client = await delegatedGoogleAuth({ subject: mailbox, scopes: [scope] }).getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error(`Google issued no token acting as ${mailbox}.`);
  // A token without an expiry lasts the hour every Google token does.
  return { token, expiresAt: client.credentials.expiry_date ?? Date.now() + 3600_000 };
}

/**
 * Gmail for ONE stored credential: the module's client, with its tokens from
 * the platform's token clients.
 *
 * `baseUrl` is the dev loop's redirect at fake-channels. A redirected
 * delegated client never mints a token (see DEV_LOOP_GMAIL_TOKEN).
 */
export class GmailApiClient extends ModuleGmailApiClient {
  constructor(
    readonly stored: GmailCredentials,
    options: { credentialsId?: string } = {},
  ) {
    const fake = stored.baseUrl;
    let accessToken: (scope: GmailScope) => Promise<string>;
    if (isGmailOAuthCredentials(stored)) {
      // One sign-in, one token carrying whatever scopes were granted; under
      // the dev loop it refreshes against the fake Google.
      const tokens: GmailTokens = { accessToken: stored.accessToken, refreshToken: stored.refreshToken, expiresAt: stored.expiresAt };
      const client = gmailTokenClient({
        tokens,
        ...(options.credentialsId !== undefined ? { credentialsId: options.credentialsId } : {}),
        ...(fake !== undefined ? { fakeBaseUrl: fake } : {}),
      });
      accessToken = async () => (await client.getAccessToken()).token ?? '';
    } else if (fake !== undefined) {
      accessToken = async () => DEV_LOOP_GMAIL_TOKEN;
    } else {
      const perScope = { read: delegatedToken(stored.mailbox, 'read'), send: delegatedToken(stored.mailbox, 'send') };
      accessToken = (scope) => perScope[scope]();
    }
    super(
      {
        mailbox: stored.mailbox,
        method: gmailMethodOf(stored),
        ...(isGmailOAuthCredentials(stored) ? { grantedScopes: stored.grantedScopes } : {}),
      },
      { accessToken, fetch, ...(fake !== undefined ? { baseUrl: fake } : {}) },
    );
  }
}

// ── Connect-time validation ─────────────────────────────────────────────────

/** What the connect page tells the user when a sign-in produced a mailbox this
 *  installation will not act as. */
export const GMAIL_OAUTH_NOT_ALLOWED_PREFIX = 'That Google account cannot be connected here. ';

/** What the connect form tells the user when the mailbox will not answer. */
export const GMAIL_DELEGATION_MESSAGE =
  'Google refused to act as this mailbox. A Workspace admin has to grant this ' +
  'deployment domain wide delegation for the Gmail read and send scopes before ' +
  'any mailbox can be connected.';

export const GMAIL_NO_MAILBOX_MESSAGE =
  'That address is not a mailbox in your Google Workspace. Use a real user or ' +
  'shared mailbox — a group address has no inbox to read.';

export const GMAIL_UNCONFIGURED_MESSAGE =
  'This server has no Google service account configured, so it cannot act as a ' +
  'mailbox at all.';

/** The env var naming which mailboxes the Gmail connector may touch. */
const ALLOWLIST_VAR = 'GMAIL_MAILBOX_ALLOWLIST';

/**
 * The ONE check every enforcement site shares: connect-time validation, the
 * in-app modal's save path, the OAuth callback, and the client built at use
 * time (`resolveGmailClient`). All of them read the same verdict rather than
 * each re-deriving it.
 *
 * Set, the list is policy and both methods obey it — a mailbox this
 * installation has not named is refused however it was connected.
 *
 * UNSET, the answer differs by method, because the question is who else is
 * enforcing anything:
 *   oauth — Google is. A refresh token from signing in as one address works for
 *     that address and no other, so an unset list restricts nothing that was
 *     not already restricted, and demanding one would only stop a deployment
 *     from connecting a mailbox it had every right to.
 *   delegated — nobody is. Once a Workspace admin grants the service account
 *     delegation it can act as EVERY mailbox in the Workspace, so an unset list
 *     defaulting to "all of them" would be a guarantee that silently is not
 *     one. Unset therefore refuses.
 */
export function checkGmailMailboxAllowed(
  mailbox: string,
  options: { method: GmailConnectMethod; env?: NodeJS.ProcessEnv },
): { ok: true } | { ok: false; message: string } {
  const allowlist = gmailMailboxAllowlist(options.env ?? process.env);
  if (allowlist.has(mailbox.trim().toLowerCase())) return { ok: true };
  if (allowlist.size === 0) {
    switch (options.method) {
      case 'oauth':
        return { ok: true };
      case 'delegated':
        return {
          ok: false,
          message:
            `${ALLOWLIST_VAR} is not set, so this installation cannot connect or use ` +
            'any Gmail mailbox. Set it to a comma separated list of the addresses ' +
            'automations may act as, for example ops@example.com,deals@example.com.',
        };
      default:
        return { ok: false, message: String(neverAsAny(options.method)) };
    }
  }
  return {
    ok: false,
    message: `${mailbox} is not on this installation's ${ALLOWLIST_VAR}. Add it there before connecting or using this mailbox.`,
  };
}

/**
 * What the paste-a-refresh-token form accepts. One field, and it is a secret:
 * a refresh token IS the mailbox, so it is never echoed back onto the form and
 * never reaches a log line.
 */
export const gmailRefreshTokenCredsParser = z.object({
  refreshToken: z.string().min(1),
  baseUrl: z.string().url().optional(),
});
export type GmailRefreshTokenEntry = z.infer<typeof gmailRefreshTokenCredsParser>;

/**
 * Connect a mailbox from a refresh token somebody obtained themselves — a
 * Workspace admin who would rather authorise the mailbox than hand a sign-in to
 * whoever is at the keyboard.
 *
 * It is an ordinary connect, not a way around one: the token is redeemed with
 * the same OAuth client a sign-in would have used, the mailbox is read off
 * `users.getProfile` rather than typed, the granted scopes come from what the
 * exchange reported, and the allowlist applies exactly as it does everywhere
 * else. What it stores is the SAME shape the callback stores, so nothing
 * downstream can tell the two apart — which is the point.
 */
export async function connectGmailByRefreshToken(input: {
  refreshToken: string;
  /** The dev loop's fake Google, when one is in play. Never stored: the
   *  resolve path re-injects it per team. */
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: true; credentials: GmailOAuthCredentials } | { ok: false; message: string }> {
  let redeemed;
  try {
    redeemed = await redeemGmailRefreshToken({
      refreshToken: input.refreshToken,
      ...(input.baseUrl !== undefined ? { fakeBaseUrl: input.baseUrl } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      message: err instanceof GmailRefreshTokenError ? err.message : String(err),
    };
  }

  const probe = new GmailApiClient({
    // A placeholder only until the profile answers — every stored copy below
    // carries the address Google named.
    mailbox: 'pending@invalid.example',
    accessToken: redeemed.accessToken,
    refreshToken: redeemed.refreshToken,
    expiresAt: redeemed.expiresAt,
    grantedScopes: redeemed.grantedScopes,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
  });

  let mailbox: string;
  try {
    mailbox = (await probe.getProfile()).emailAddress;
  } catch (err) {
    const failure = classifyGmailError(err, 'users.getProfile');
    return {
      ok: false,
      message:
        failure.failure === 'delegation'
          ? GMAIL_REFRESH_TOKEN_REFUSED_MESSAGE
          : `Google could not be reached: ${failure.message}`,
    };
  }

  const allowed = checkGmailMailboxAllowed(mailbox, {
    method: 'oauth',
    ...(input.env !== undefined ? { env: input.env } : {}),
  });
  if (!allowed.ok) return allowed;

  return {
    ok: true,
    credentials: {
      mailbox,
      accessToken: redeemed.accessToken,
      refreshToken: redeemed.refreshToken,
      expiresAt: redeemed.expiresAt,
      grantedScopes: redeemed.grantedScopes,
    },
  };
}

/**
 * Prove a mailbox before storing it. First the allowlist — a mailbox this
 * installation has not named is refused before anything asks Google — then
 * one call as the mailbox: either Google refuses to act as it, or it does not
 * and Gmail says whether the address owns an inbox. Anything else is reported
 * as itself rather than guessed at.
 */
export async function validateGmailMailbox(
  credentials: GmailCredentials,
): Promise<{ ok: true; profile: GmailProfile } | { ok: false; message: string }> {
  const method = gmailMethodOf(credentials);
  const allowed = checkGmailMailboxAllowed(credentials.mailbox, { method });
  if (!allowed.ok) return allowed;
  // Only delegation needs the deployment's own service account; a sign-in
  // carries its own authority.
  if (
    method === 'delegated' &&
    credentials.baseUrl === undefined &&
    !isGoogleServiceAccountConfigured()
  ) {
    return { ok: false, message: GMAIL_UNCONFIGURED_MESSAGE };
  }
  try {
    const profile = await new GmailApiClient(credentials).getProfile();
    return { ok: true, profile };
  } catch (err) {
    const failure = classifyGmailError(err, 'users.getProfile');
    switch (failure.failure) {
      case 'delegation':
        return { ok: false, message: GMAIL_DELEGATION_MESSAGE };
      case 'no_such_mailbox':
        return { ok: false, message: GMAIL_NO_MAILBOX_MESSAGE };
      // `users.getProfile` only ever asks for the readonly scope, so a
      // send-scope failure can never actually classify this way — kept
      // explicit rather than folded into `other` so the switch stays
      // exhaustive against `GmailFailure` without an `as`.
      case 'missing_send_scope':
      case 'history_expired':
      case 'other':
        return { ok: false, message: `Google could not be reached: ${failure.message}` };
      default:
        return { ok: false, message: String(neverAsAny(failure.failure)) };
    }
  }
}
