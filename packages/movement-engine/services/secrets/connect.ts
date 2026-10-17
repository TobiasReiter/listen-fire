// Connecting an OAuth 2 credential, from what a module's manifest declares
// about it (`credentials[].oauth2`): the authorize URL a person opens, the
// state that ties the provider's redirect back to the attempt that sent them,
// the PKCE pair when the declaration asks for one, and the exchange of the
// returned code for tokens. Every shell connects through this: the platform's
// own OAuth flows (each a declaration plus the URLs and stored shapes it has
// always had) and `lf connect` (a loopback redirect, written to lf's secrets
// file). Storing the result goes through the secrets family like any other
// write of a credential.
//
// What stays with the shell: where the redirect lands (a platform callback
// route, lf's loopback listener), who the attempt belongs to, and where the
// host's own client id and secret come from.

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { WireOAuth2Declaration } from 'engine-contracts';
import { redactSecrets, type SecretFields, type SecretRecord, type SecretsFamily } from './family';
import { authenticateClient, tokenRequestHeaders, type OAuth2ClientApp } from './oauth2';

/** How a credential is connected and refreshed, as a manifest declares it. */
export type OAuth2Declaration = z.infer<typeof WireOAuth2Declaration>;

// ── Attempts waiting for their redirect ─────────────────────────────────────

/** How long a person has between opening the authorize URL and coming back. */
export const CONNECT_ATTEMPT_TTL_MS = 15 * 60 * 1000;

/** Values kept by an attempt's state until it expires. `peek` leaves the entry
 *  for a second reader (a callback page mounted twice); `take` is single use. */
export interface PendingStates<T> {
  put(state: string, value: T): void;
  peek(state: string): T | undefined;
  take(state: string): T | undefined;
}

export function createPendingStates<T>(options: { ttlMs?: number; now?: () => number } = {}): PendingStates<T> {
  const ttlMs = options.ttlMs ?? CONNECT_ATTEMPT_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const live = (state: string): T | undefined => {
    const entry = entries.get(state);
    if (entry === undefined) return undefined;
    if (entry.expiresAt < now()) {
      entries.delete(state);
      return undefined;
    }
    return entry.value;
  };
  return {
    put(state, value) {
      entries.set(state, { value, expiresAt: now() + ttlMs });
      // The sweep only frees memory; expiry itself is checked on every read.
      // Unreferenced, so a command line that connected can exit.
      setTimeout(() => {
        const entry = entries.get(state);
        if (entry !== undefined && entry.expiresAt <= now()) entries.delete(state);
      }, ttlMs).unref();
    },
    peek: live,
    take(state) {
      const value = live(state);
      entries.delete(state);
      return value;
    },
  };
}

// ── The authorize URL ──────────────────────────────────────────────────────

const STATE_BYTES = 100;
const VERIFIER_BYTES = 96;

/** What the redirect must bring back to be completed. */
export interface OAuth2Attempt {
  state: string;
  redirectUri: string;
  /** Present when the declaration asks for PKCE. */
  codeVerifier?: string;
}

export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * The provider's authorize URL for one attempt: `response_type=code`, the
 * host's client id, the redirect, the declared scopes (space separated), the
 * state, the S256 challenge when the declaration asks for PKCE, and the
 * declaration's own extra parameters. `state` is the shell's when it signs
 * its own; otherwise a random one.
 */
export function beginOAuth2Connect(input: {
  oauth2: OAuth2Declaration;
  clientId: string;
  redirectUri: string;
  state?: string;
}): { url: string; attempt: OAuth2Attempt } {
  const { oauth2 } = input;
  const state = input.state ?? randomBytes(STATE_BYTES).toString('base64url');
  const codeVerifier = oauth2.pkce === true ? randomBytes(VERIFIER_BYTES).toString('base64url') : undefined;
  const url = new URL(oauth2.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  if (oauth2.scopes !== undefined && oauth2.scopes.length > 0) url.searchParams.set('scope', oauth2.scopes.join(' '));
  url.searchParams.set('state', state);
  if (codeVerifier !== undefined) {
    url.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(oauth2.authorizeParams ?? {})) url.searchParams.set(key, value);
  return {
    url: url.toString(),
    attempt: { state, redirectUri: input.redirectUri, ...(codeVerifier !== undefined ? { codeVerifier } : {}) },
  };
}

// ── The code exchange ──────────────────────────────────────────────────────

const TokenResponse = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().optional(),
  refresh_token: z.string().min(1).optional(),
});

/** What the token endpoint granted: the credential's token fields, and its
 *  whole answer for anything provider specific (granted scopes, a refresh
 *  token's own expiry). */
export interface OAuth2Grant {
  fields: SecretFields;
  response: Readonly<Record<string, unknown>>;
}

export class OAuth2ExchangeFailed extends Error {
  constructor(
    readonly tokenUrl: string,
    readonly status: number | undefined,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`exchanging the authorization code at ${tokenUrl} failed: ${detail}`, options);
    this.name = 'OAuth2ExchangeFailed';
  }
}

const ERROR_BODY_CHARS = 200;

/** Tries of one code exchange, and the wait before the first retry (doubled
 *  after each). A 5xx or a network error is retried; any other answer is the
 *  provider's verdict. Google's library retried its exchange like this before
 *  Google moved onto this flow, and a provider hiccup at the redirect would
 *  otherwise send the user back through consent. */
export const EXCHANGE_TRIES = 3;
export const EXCHANGE_RETRY_DELAY_MS = 250;

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exchange the code the redirect brought back, at the declared token URL. */
export async function exchangeOAuth2Code(input: {
  oauth2: OAuth2Declaration;
  client: OAuth2ClientApp;
  attempt: OAuth2Attempt;
  code: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<OAuth2Grant> {
  const { oauth2, client, attempt } = input;
  const doFetch = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: attempt.redirectUri });
  if (attempt.codeVerifier !== undefined) form.set('code_verifier', attempt.codeVerifier);
  const headers = tokenRequestHeaders();
  authenticateClient({ client, clientAuth: oauth2.clientAuth, form, headers });
  const hidden = [input.code, ...(client.clientSecret !== undefined ? [client.clientSecret] : []), ...(attempt.codeVerifier !== undefined ? [attempt.codeVerifier] : [])];
  const sleep = input.sleep ?? sleepFor;
  const { response, text } = await (async () => {
    for (let tried = 1; ; tried++) {
      try {
        const answer = await doFetch(oauth2.tokenUrl, { method: 'POST', headers, body: form });
        const body = await answer.text();
        if (answer.status < 500 || tried >= EXCHANGE_TRIES) return { response: answer, text: body };
      } catch (error) {
        if (tried >= EXCHANGE_TRIES) {
          throw new OAuth2ExchangeFailed(oauth2.tokenUrl, undefined, redactSecrets(error instanceof Error ? error.message : String(error), hidden), { cause: error });
        }
      }
      await sleep(EXCHANGE_RETRY_DELAY_MS * 2 ** (tried - 1));
    }
  })();
  if (!response.ok) {
    throw new OAuth2ExchangeFailed(oauth2.tokenUrl, response.status, `HTTP ${response.status}: ${redactSecrets(text.slice(0, ERROR_BODY_CHARS), hidden)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OAuth2ExchangeFailed(oauth2.tokenUrl, response.status, 'the answer is not JSON');
  }
  const parsed = TokenResponse.safeParse(json);
  if (!parsed.success) throw new OAuth2ExchangeFailed(oauth2.tokenUrl, response.status, 'the answer has no access_token');
  const fields: Record<string, string> = { access_token: parsed.data.access_token };
  if (parsed.data.refresh_token !== undefined) fields.refresh_token = parsed.data.refresh_token;
  if (parsed.data.expires_in !== undefined) fields.expires_at = new Date(now() + parsed.data.expires_in * 1000).toISOString();
  return { fields, response: parsed.data };
}

// ── One registered app's connect flow ──────────────────────────────────────

export interface OAuth2Connector {
  /** A new attempt's authorize URL; its state is remembered until it expires. */
  begin(options?: { state?: string }): string;
  /** Complete the attempt this state began, once. Throws when the state is
   *  unknown, expired or already used. */
  complete(input: { state: string; code: string }): Promise<OAuth2Grant>;
}

export class UnknownConnectAttempt extends Error {
  constructor() {
    super('Invalid state parameter value');
    this.name = 'UnknownConnectAttempt';
  }
}

/** A declared credential's connect flow through one registered app and one
 *  redirect: what each of the platform's OAuth clients holds. */
export function createOAuth2Connector(input: {
  oauth2: OAuth2Declaration;
  client: OAuth2ClientApp;
  redirectUri: string;
  fetch?: typeof fetch;
  now?: () => number;
}): OAuth2Connector {
  const attempts = createPendingStates<OAuth2Attempt>(input.now !== undefined ? { now: input.now } : {});
  return {
    begin(options = {}) {
      const { url, attempt } = beginOAuth2Connect({
        oauth2: input.oauth2,
        clientId: input.client.clientId,
        redirectUri: input.redirectUri,
        ...(options.state !== undefined ? { state: options.state } : {}),
      });
      attempts.put(attempt.state, attempt);
      return url;
    },
    async complete({ state, code }) {
      const attempt = attempts.take(state);
      if (attempt === undefined) throw new UnknownConnectAttempt();
      return exchangeOAuth2Code({
        oauth2: input.oauth2,
        client: input.client,
        attempt,
        code,
        ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
    },
  };
}

/** Store a grant over the credential it connects, under the store's lock:
 *  the token fields replace the old ones, every other field (the host's
 *  client id and secret, a webhook secret) is kept. */
export function storeGrant(family: SecretsFamily, ref: string, grant: OAuth2Grant): Promise<SecretRecord> {
  return family.update(ref, grant.fields);
}
