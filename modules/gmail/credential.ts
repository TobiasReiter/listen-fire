// The credential Gmail declares, and how its fields become a client.
//
// The fields a host hands the module, whichever way the mailbox was
// connected:
//
//   access_token       the token for the read scope (a sign-in's one token)
//   mailbox            the address the mailbox is
//   method             `oauth` (absent) or `delegated`
//   granted_scopes     a sign-in's granted scopes, space separated; absent
//                      means the ones the declaration asks for
//   send_access_token  delegated only: the token for the send scope
//   send_refusal       delegated only: why the host holds no send token
//
// The host keeps the tokens fresh. A sign-in is refreshed by the standard
// grant over Google's endpoints (or by the platform's own Gmail client); a
// delegated mailbox has no refresh token at all — its host mints both tokens
// with the service account it holds, and the module never sees that key.
// Which mailboxes a host will hand over at all (its allowlist) is the host's
// policy, enforced before the credential reaches the module.

import type { WireCredentialDeclarationShape } from 'engine-contracts';
import type { CredentialFields, ModuleContext } from 'module-kit';
import type { OAuth2Declaration } from 'movement-engine/public/secrets';

import { GOOGLE_OAUTH2_ENDPOINTS, GOOGLE_OFFLINE_CONSENT } from '@listen-fire/google-sheets/google_oauth';

import { GMAIL_CONNECT_METHODS, GMAIL_SCOPES, GmailApiClient, GmailApiError, type GmailConnectMethod, type GmailScope } from './api_client';
import type { GmailClientSource } from './adapter';

/** How a mailbox is signed into: Google's endpoints, read and send, the
 *  client in the form body, with PKCE and offline consent. */
export const GMAIL_OAUTH2: OAuth2Declaration = {
  ...GOOGLE_OAUTH2_ENDPOINTS,
  scopes: [...GMAIL_SCOPES],
  clientAuth: 'body',
  pkce: true,
  authorizeParams: { ...GOOGLE_OFFLINE_CONSENT },
};

export const GMAIL_CREDENTIAL: WireCredentialDeclarationShape = {
  name: 'gmail',
  kind: 'oauth2',
  fields: [
    { name: 'mailbox', label: 'Mailbox', secret: false },
    { name: 'method', label: 'Connected by', secret: false, optional: true },
    { name: 'granted_scopes', label: 'Granted scopes', secret: false, optional: true },
    { name: 'send_access_token', label: 'Send token', optional: true },
    { name: 'send_refusal', label: 'Why sending is refused', secret: false, optional: true },
  ],
  oauth2: GMAIL_OAUTH2,
};

const isMethod = (value: string): value is GmailConnectMethod => GMAIL_CONNECT_METHODS.some((method) => method === value);

/** A client for the mailbox the fields name. */
export function gmailClientFromFields(fields: CredentialFields, host: { fetch: typeof fetch; baseUrl?: string }): GmailApiClient {
  const readToken = fields.access_token;
  const mailbox = fields.mailbox;
  if (readToken === undefined || readToken === '' || mailbox === undefined || mailbox === '') {
    throw new Error('GmailAdapter: the connected credential names no mailbox or holds no access token. Connect Gmail.');
  }
  const rawMethod = fields.method ?? 'oauth';
  if (!isMethod(rawMethod)) {
    throw new Error(`GmailAdapter: the credential says it was connected by '${rawMethod}', which is not ${GMAIL_CONNECT_METHODS.join(' or ')}.`);
  }
  const method = rawMethod;
  const sendToken = method === 'oauth' ? readToken : fields.send_access_token;
  const accessToken = async (scope: GmailScope): Promise<string> => {
    if (scope === 'read') return readToken;
    if (sendToken === undefined || sendToken === '') {
      throw new GmailApiError('missing_send_scope', undefined, 'users.messages.send', fields.send_refusal ?? 'the host holds no token for the send scope');
    }
    return sendToken;
  };
  return new GmailApiClient(
    {
      mailbox,
      method,
      ...(method === 'oauth' ? { grantedScopes: fields.granted_scopes !== undefined ? fields.granted_scopes.split(/\s+/).filter((s) => s !== '') : [...GMAIL_SCOPES] } : {}),
    },
    { accessToken, fetch: host.fetch, ...(host.baseUrl !== undefined ? { baseUrl: host.baseUrl } : {}) },
  );
}

/** The client the context's credential reaches the mailbox with. */
export function gmailClientFrom(ctx: Pick<ModuleContext, 'credential' | 'fetch' | 'config'>): GmailClientSource {
  // The client for the fields last read: a host hands back the same fields
  // until the credential changes (a refresh), so one client serves until then.
  let last: { fields: CredentialFields; client: GmailApiClient } | undefined;
  return async () => {
    const fields = await ctx.credential.fields();
    if (last?.fields === fields) return last.client;
    const client = gmailClientFromFields(fields, {
      fetch: ctx.fetch,
      ...(ctx.config.baseUrlOverride !== undefined ? { baseUrl: ctx.config.baseUrlOverride } : {}),
    });
    last = { fields, client };
    return client;
  };
}
