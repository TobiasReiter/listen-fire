// Gmail's OAuth half — signing in AS the mailbox.
//
// The OAuth client is the deployment's EXISTING Google pair
// (`GOOGLE_INTEGRATIONS_CLIENT_ID` / `_SECRET`, the one Sheets and Drive already
// use). Gmail is a different scope set on the same client in the same Google
// project, so a second client id would be a second consent screen to register
// and verify for no gain.
//
// What a sign-in buys over the service account acting as the mailbox: Google
// itself confines the refresh token to the one address that signed in. Domain
// wide delegation cannot be confined that way — once granted it covers every
// mailbox in the Workspace — which is why this is the default method.
//
// Two halves live here. `GmailAuthClient` is the CONNECT half (install URL,
// code exchange), held once by the registered connector. `gmailTokenClient` is
// the USE half: a token-bearing client for one stored credential, built
// wherever a mailbox is read or written, with the rotation listener that keeps
// the stored token current.

import { createHash, randomBytes } from 'node:crypto';

import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { z } from 'zod';

import type { Credentials } from 'google-auth-library';

import { decryptToken, encryptToken } from '../../lib/credentials';
import { getAutomationsQb } from '../../lib/kysely';
import { logger } from '../../services/logger';
import { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import {
  GMAIL_OAUTH_CLIENT_LABEL,
  gmailOAuthClientCredentials,
  gmailOAuthScopes,
} from './connect_method';
import { GMAIL_READONLY_SCOPE } from '../../lib/google_cloud';

/** The token half of a signed-in mailbox's credential, as the rotation listener
 *  rewrites it. The mailbox address and the granted scopes sit beside it on the
 *  stored payload (`gmailOAuthCredsParser`) and never change on a refresh. */
export const gmailTokensParser = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
});
export type GmailTokens = z.infer<typeof gmailTokensParser>;

/** What Google says it actually granted, off the token response. Space
 *  separated, and absent on some responses — an absent one means "what you
 *  asked for", which the caller supplies. */
export function parseGrantedScopes(raw: unknown, requested: readonly string[]): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [...requested];
  return raw.split(/\s+/).filter((scope) => scope !== '');
}

/** The OAuth endpoints, redirected at the dev loop's fake Google when one is
 *  configured. A fake base URL is what makes the whole sign-in provable without
 *  a real consent screen; unset, the library's own Google endpoints apply. */
function endpointOverrides(fakeBaseUrl: string | undefined): {
  endpoints?: { oauth2AuthBaseUrl: string; oauth2TokenUrl: string; tokenInfoUrl: string };
} {
  if (fakeBaseUrl === undefined) return {};
  const base = fakeBaseUrl.replace(/\/$/, '');
  return {
    endpoints: {
      oauth2AuthBaseUrl: `${base}/fake-google-oauth/auth`,
      oauth2TokenUrl: `${base}/fake-google-oauth/token`,
      tokenInfoUrl: `${base}/fake-google-oauth/tokeninfo`,
    },
  };
}

/** A bare client for this installation's Gmail OAuth client — no tokens on it
 *  yet. Null when the deployment has configured no client at all. */
function bareOAuthClient(input: {
  fakeBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): OAuth2Client | null {
  const configured = gmailOAuthClientCredentials(input.env ?? process.env);
  if (configured === null) return null;
  return new OAuth2Client({
    clientId: configured.clientId,
    clientSecret: configured.clientSecret,
    ...endpointOverrides(input.fakeBaseUrl),
  });
}

// ── The use half ────────────────────────────────────────────────────────────

/**
 * Clients are cached per credential because the library's refresh cache lives
 * on the client: a fresh one per call would mint a new access token every time,
 * and would attach the rotation listener again with it.
 */
const clientsById = new Map<string, OAuth2Client>();

export function forgetGmailTokenClient(credentialsId: string): void {
  clientsById.delete(credentialsId);
}

/**
 * Rewrite the token half of a stored payload in place. The mailbox address and
 * the granted scopes are read back off the row and written through unchanged: a
 * refresh renews a token, it never re-grants anything, so inventing either here
 * would be inventing a fact Google did not state.
 */
async function persistRotation(input: {
  credentialsId: string;
  previous: GmailTokens;
  issued: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null };
}): Promise<void> {
  const { credentialsId, issued } = input;
  if (!issued.access_token || !issued.expiry_date) {
    logger.error('[GMAIL] token refresh missing required fields', { credentialsId });
    return;
  }
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', credentialsId as ExternalServiceCredentialsId)
    .select(['credentials'])
    .executeTakeFirst();
  if (!row) return;

  const stored: unknown = JSON.parse(await decryptToken(row.credentials, credentialsId));
  const payload = typeof stored === 'object' && stored !== null ? { ...stored } : {};
  const next = {
    ...payload,
    accessToken: issued.access_token,
    refreshToken: issued.refresh_token ?? input.previous.refreshToken,
    expiresAt: issued.expiry_date,
  };

  await getAutomationsQb(['external_service_credentials'])
    .updateTable('external_service_credentials')
    .set({
      credentials: await encryptToken(JSON.stringify(next), credentialsId),
      updated_at: new Date(),
    })
    .where('id', '=', credentialsId as ExternalServiceCredentialsId)
    .execute();
}

/**
 * A token-bearing Google client for one connected mailbox.
 *
 * `credentialsId` is what lets a rotated token be written down; without one
 * (a connect-time probe, where no row exists yet) the client still works, it
 * just has nowhere to save a rotation to.
 */
export function gmailTokenClient(input: {
  tokens: GmailTokens;
  credentialsId?: string;
  fakeBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): OAuth2Client {
  const build = () =>
    bareOAuthClient({
      ...(input.fakeBaseUrl !== undefined ? { fakeBaseUrl: input.fakeBaseUrl } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    }) ??
    // A deployment with no Gmail OAuth client can still USE an access token
    // that has not expired; only the refresh needs the client, and that refusal
    // is Google's to give in the terms it uses.
    new OAuth2Client({ ...endpointOverrides(input.fakeBaseUrl) });

  if (input.credentialsId === undefined) {
    const client = build();
    client.setCredentials(toLibraryCredentials(input.tokens));
    return client;
  }

  const credentialsId = input.credentialsId;
  let client = clientsById.get(credentialsId);
  if (!client) {
    client = build();
    clientsById.set(credentialsId, client);
    const tokensAtBind = input.tokens;
    client.on('tokens', (issued) => {
      void persistRotation({ credentialsId, previous: tokensAtBind, issued }).catch((err) => {
        logger.error('[GMAIL] failed to save rotated tokens', { credentialsId, err });
      });
    });
  }
  client.setCredentials(toLibraryCredentials(input.tokens));
  return client;
}

function toLibraryCredentials(tokens: GmailTokens) {
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiresAt,
  };
}

// ── Redeeming a refresh token somebody else obtained ────────────────────────

/** What a pasted refresh token is refused with. The token itself never appears
 *  in any of them, nor in any log line on this path. */
export const GMAIL_REFRESH_TOKEN_REFUSED_MESSAGE =
  `Google would not exchange that refresh token. It has to be one ${GMAIL_OAUTH_CLIENT_LABEL} ` +
  'issued — a token from a different OAuth client, or one the account has since revoked, ' +
  'is refused exactly like this.';

export const GMAIL_NO_OAUTH_CLIENT_MESSAGE =
  'This server has no Gmail OAuth client configured, so it cannot exchange a refresh ' +
  'token at all. Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET (or the ' +
  'GOOGLE_INTEGRATIONS pair) first.';

export class GmailRefreshTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailRefreshTokenError';
  }
}

/**
 * Turn a refresh token a Workspace admin obtained themselves into the same
 * thing a sign-in through this server would have produced.
 *
 * The exchange IS the validation: a token from another OAuth client, or one the
 * account revoked, is refused here rather than at the first run. What it grants
 * is read off the response's `scope`; Google usually sends it, and when it does
 * not, `tokeninfo` is asked directly. Only if both are silent does this fall
 * back to READ ONLY — never to "probably both", because a mailbox wrongly
 * believed to hold the send scope is one whose first reply fails with the wrong
 * diagnosis.
 */
export async function redeemGmailRefreshToken(input: {
  refreshToken: string;
  fakeBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GmailTokens & { grantedScopes: string[] }> {
  const client = bareOAuthClient({
    ...(input.fakeBaseUrl !== undefined ? { fakeBaseUrl: input.fakeBaseUrl } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
  });
  if (client === null) throw new GmailRefreshTokenError(GMAIL_NO_OAUTH_CLIENT_MESSAGE);

  client.setCredentials({ refresh_token: input.refreshToken });
  let issued: Credentials;
  try {
    ({ credentials: issued } = await client.refreshAccessToken());
  } catch {
    // Swallowed deliberately: the thrown value carries the request, and the
    // request carries the token.
    throw new GmailRefreshTokenError(GMAIL_REFRESH_TOKEN_REFUSED_MESSAGE);
  }
  if (!issued.access_token) {
    throw new GmailRefreshTokenError(GMAIL_REFRESH_TOKEN_REFUSED_MESSAGE);
  }

  return {
    accessToken: issued.access_token,
    // Google returns the refresh token only on the original grant, so the one
    // that was pasted is the one that gets stored.
    refreshToken: input.refreshToken,
    // A refresh response without an expiry is one that expires within the hour
    // like any other; an hour from now is the honest reading, and the client
    // refreshes again at that point regardless.
    expiresAt: issued.expiry_date ?? Date.now() + 3600 * 1000,
    grantedScopes: await grantedScopesFor(client, issued, input.refreshToken),
  };
}

async function grantedScopesFor(
  client: OAuth2Client,
  issued: { scope?: string | null; access_token?: string | null },
  requestedFallbackFor: string,
): Promise<string[]> {
  if (typeof issued.scope === 'string' && issued.scope.trim() !== '') {
    return parseGrantedScopes(issued.scope, []);
  }
  if (issued.access_token) {
    try {
      const info = await client.getTokenInfo(issued.access_token);
      if (info.scopes.length > 0) return [...info.scopes];
    } catch (err) {
      logger.warn('[GMAIL] tokeninfo could not say what a pasted token grants', { err });
    }
  }
  logger.warn(
    '[GMAIL] a pasted refresh token said nothing about its scopes — treating it as read only',
    { tokenLength: requestedFallbackFor.length },
  );
  return [GMAIL_READONLY_SCOPE];
}

// ── The connect half ────────────────────────────────────────────────────────

interface GmailAuthClientOptions {
  clientId: string;
  clientSecret: string;
  redirectBaseUrl: string;
  /** The dev loop's fake Google — see {@link endpointOverrides}. It also names
   *  where the callback asks for the signed-in mailbox's profile. */
  fakeBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

class GmailAuthClient {
  private readonly authCache: Record<string, string> = {};
  private readonly oauth2Client: OAuth2Client;
  private readonly env: NodeJS.ProcessEnv;
  readonly callbackUrl: string;
  readonly fakeBaseUrl: string | undefined;

  constructor(options: GmailAuthClientOptions) {
    this.env = options.env ?? process.env;
    this.fakeBaseUrl = options.fakeBaseUrl;
    this.callbackUrl = `${options.redirectBaseUrl.replace(/\/$/, '')}/gmail/callback`;
    this.oauth2Client = new OAuth2Client({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUri: this.callbackUrl,
      ...endpointOverrides(options.fakeBaseUrl),
    });
  }

  /** The scopes this installation's consent asks for — read always, send only
   *  when the installation enabled it. */
  scopes(): string[] {
    return gmailOAuthScopes(this.env);
  }

  /** Exchange the consent's code for tokens, reporting what Google actually
   *  granted alongside them. */
  async codeToToken(input: {
    state: string;
    code: string;
  }): Promise<GmailTokens & { grantedScopes: string[] }> {
    const codeVerifier = this.authCache[input.state];
    if (!codeVerifier) {
      throw new Error('Invalid state parameter value');
    }
    delete this.authCache[input.state];

    const { tokens } = await this.oauth2Client.getToken({ code: input.code, codeVerifier });
    if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
      throw new Error(
        'Google returned no refresh token for this sign-in. Remove Listen-Fire from ' +
          'the account’s third-party access and sign in again.',
      );
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date,
      grantedScopes: parseGrantedScopes(tokens.scope, this.scopes()),
    };
  }

  /**
   * The consent URL. `access_type=offline` with `prompt=consent` is what makes
   * Google issue a refresh token every time rather than only on the account's
   * first ever grant — without both, a second connect returns an access token
   * that dies in an hour and nothing to renew it with.
   */
  async generateInstallUrl(): Promise<string> {
    const state = randomBytes(100).toString('base64url');
    const codeVerifier = randomBytes(96).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    this.authCache[state] = codeVerifier;
    setTimeout(() => {
      delete this.authCache[state];
    }, 15 * 60 * 1000);

    return this.oauth2Client.generateAuthUrl({
      state,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      scope: this.scopes(),
    });
  }
}

export { GmailAuthClient };
