// The host's generic OAuth 2 refresh: the standard refresh-token grant at the
// token URL a module's manifest declares (`credentials[].oauth2`). A provider
// whose refresh is something else implements the protocol's
// `refreshCredential` instead, and the host calls that as the refresher.

import { z } from 'zod';
import type { WireCredentialDeclarationShape } from 'engine-contracts';
import type { Refresher, SecretFields } from './family';

/** The host's own registered app at the provider. */
export interface OAuth2ClientApp {
  clientId: string;
  clientSecret?: string;
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().optional(),
  refresh_token: z.string().min(1).optional(),
});

/** The token fields every OAuth 2 credential holds (protocol `oauth2` kind). */
export const OAUTH2_TOKEN_FIELDS = ['access_token', 'refresh_token', 'expires_at'] as const;

const ERROR_BODY_CHARS = 200;

export function oauth2Refresher(input: {
  tokenUrl: string;
  /** Where the client id and secret go: an HTTP Basic header (the protocol's
   *  default) or the form body. */
  clientAuth?: 'basic' | 'body';
  /** The host's app. Absent: the credential's own `client_id` and
   *  `client_secret` fields, if it has them (lf's secrets file). */
  client?: OAuth2ClientApp;
  fetch?: typeof fetch;
  now?: () => number;
}): Refresher {
  const doFetch = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  return async (current) => {
    const refreshToken = current.fields.refresh_token;
    if (refreshToken === undefined || refreshToken === '') throw new Error('the credential holds no refresh_token');
    const client = input.client ?? clientFromFields(current.fields);
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (client !== undefined) {
      if ((input.clientAuth ?? 'basic') === 'basic') {
        const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret ?? '')}`;
        headers.authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
      } else {
        form.set('client_id', client.clientId);
        if (client.clientSecret !== undefined) form.set('client_secret', client.clientSecret);
      }
    }
    const response = await doFetch(input.tokenUrl, { method: 'POST', headers, body: form });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${input.tokenUrl}: ${(await response.text()).slice(0, ERROR_BODY_CHARS)}`);
    }
    const parsed = TokenResponse.safeParse(await response.json());
    if (!parsed.success) throw new Error(`the answer from ${input.tokenUrl} has no access_token`);
    const changed: Record<string, string> = { access_token: parsed.data.access_token };
    if (parsed.data.expires_in !== undefined) changed.expires_at = new Date(now() + parsed.data.expires_in * 1000).toISOString();
    // A provider that does not rotate leaves the stored refresh_token alone: a
    // write-back merges, so a field not named is kept.
    if (parsed.data.refresh_token !== undefined) changed.refresh_token = parsed.data.refresh_token;
    return changed;
  };
}

function clientFromFields(fields: SecretFields): OAuth2ClientApp | undefined {
  const clientId = fields.client_id;
  if (clientId === undefined) return undefined;
  return { clientId, ...(fields.client_secret !== undefined ? { clientSecret: fields.client_secret } : {}) };
}

/** The host's refresher for a declared credential: the generic grant for an
 *  `oauth2` one, none for a `static` one. */
export function declaredRefresher(
  declaration: WireCredentialDeclarationShape,
  options: { client?: OAuth2ClientApp; fetch?: typeof fetch; now?: () => number } = {},
): Refresher | undefined {
  switch (declaration.kind) {
    case 'static':
      return undefined;
    case 'oauth2':
      return oauth2Refresher({
        tokenUrl: declaration.oauth2.tokenUrl,
        ...(declaration.oauth2.clientAuth !== undefined ? { clientAuth: declaration.oauth2.clientAuth } : {}),
        ...options,
      });
  }
}

/** The fields of a stored credential a module that declares it is sent: the
 *  ones it names, and the token fields of an `oauth2` one. Nothing else the
 *  store keeps beside them (the host's client secret, a token URL) leaves. */
export function declaredFields(declaration: WireCredentialDeclarationShape, fields: SecretFields): Record<string, string> {
  const names = new Set(declaration.fields.map((field) => field.name));
  if (declaration.kind === 'oauth2') for (const name of OAUTH2_TOKEN_FIELDS) names.add(name);
  const sent: Record<string, string> = {};
  for (const name of names) {
    const value = fields[name];
    if (value !== undefined) sent[name] = value;
  }
  return sent;
}
