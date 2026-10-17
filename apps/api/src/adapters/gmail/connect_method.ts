// How THIS deployment connects a Gmail mailbox, and which scopes it asks for.
//
// Two methods, and the difference is who enforces the boundary:
//
//   oauth (the default) — somebody signs in AS the mailbox. Google hands back a
//     refresh token that works for that one mailbox and no other, so the
//     boundary is Google's and cannot be widened from here.
//   delegated — the deployment's service account acts as an address it was
//     never signed into, granted once by a Workspace admin. That grant covers
//     EVERY mailbox in the Workspace, so the boundary is entirely ours.
//
// Everything downstream that differs between the two — which connect form is
// offered, which credential shape is stored, whether an unset allowlist is safe
// — reads the method from here rather than re-deriving it.

import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from 'movement-engine/public/google-cloud';
import { GMAIL_CONNECT_METHODS, type GmailConnectMethod } from '@listen-fire/gmail/api_client';

export { GMAIL_CONNECT_METHODS, type GmailConnectMethod };

const METHOD_VAR = 'GMAIL_CONNECT_METHOD';
const SEND_VAR = 'GMAIL_SEND_ENABLED';

function isConnectMethod(value: string): value is GmailConnectMethod {
  return GMAIL_CONNECT_METHODS.some((method) => method === value);
}

/**
 * This deployment's Gmail connect method. Unset means `oauth`: a sign-in that
 * Google confines to one mailbox is the safe default, and delegation is the
 * thing an operator opts into.
 *
 * A value that is neither throws rather than falling back — an operator who
 * typed `GMAIL_CONNECT_METHOD=delegation` meant something, and silently serving
 * them OAuth would leave them looking for a form that is not there.
 */
export function gmailConnectMethod(env: NodeJS.ProcessEnv = process.env): GmailConnectMethod {
  const raw = (env[METHOD_VAR] ?? '').trim();
  if (raw === '') return 'oauth';
  if (isConnectMethod(raw)) return raw;
  throw new Error(
    `${METHOD_VAR}='${raw}' is not a Gmail connect method. Set it to ` +
      `${GMAIL_CONNECT_METHODS.join(' or ')}, or leave it unset for ` +
      `${GMAIL_CONNECT_METHODS[0]}.`,
  );
}

/** Whether this installation lets a connected mailbox SEND. Off unless it says
 *  so: sending is the half that reaches other people, and an installation that
 *  only ever reads should never be able to ask for the scope by accident. */
export function gmailSendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[SEND_VAR] ?? '').trim().toLowerCase() === 'true';
}

/**
 * The scopes the OAuth consent asks for. Reading is always in; sending is added
 * only when the installation enabled it, so a deployment that never sends never
 * shows its users a consent screen asking to send mail on their behalf.
 */
export function gmailOAuthScopes(env: NodeJS.ProcessEnv = process.env): string[] {
  return gmailSendEnabled(env)
    ? [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE]
    : [GMAIL_READONLY_SCOPE];
}

/** How a Gmail OAuth client is named everywhere a user or an authoring agent
 *  reads about one. Deliberately does NOT say which pair of variables it came
 *  from: an operator's own client and the shared Google one behave identically,
 *  and the difference is theirs to know, not the user's. */
export const GMAIL_OAUTH_CLIENT_LABEL = "this installation's Gmail OAuth client";

export interface GmailOAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * The OAuth client a Gmail sign-in runs through, or null when this deployment
 * has none.
 *
 * `GMAIL_OAUTH_CLIENT_ID` / `_SECRET` is a client registered FOR THE CONNECTOR,
 * which an operator sets when they want Gmail on a client of their own —
 * separate verification, separate consent screen, separate refresh tokens.
 * Absent, Gmail rides `GOOGLE_INTEGRATIONS_*`, the same client Sheets and Drive
 * use: one Google project, a different scope set.
 *
 * Half a pair throws. Google refuses a token exchange that carries an id
 * without its secret, so half a pair is a deployment whose Gmail is broken in a
 * way nothing else would report until somebody tried to connect.
 */
export function gmailOAuthClientCredentials(
  env: NodeJS.ProcessEnv = process.env,
): GmailOAuthClientCredentials | null {
  const clientId = (env.GMAIL_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = (env.GMAIL_OAUTH_CLIENT_SECRET ?? '').trim();
  if (clientId !== '' && clientSecret !== '') return { clientId, clientSecret };
  if (clientId !== '' || clientSecret !== '') {
    throw new Error(
      'Set BOTH GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET, or neither — ' +
        `only ${clientId !== '' ? 'GMAIL_OAUTH_CLIENT_ID' : 'GMAIL_OAUTH_CLIENT_SECRET'} ` +
        'is set, and Google refuses an exchange that carries one without the other. ' +
        'With neither, Gmail uses GOOGLE_INTEGRATIONS_CLIENT_ID / _SECRET instead.',
    );
  }

  const sharedId = (env.GOOGLE_INTEGRATIONS_CLIENT_ID ?? '').trim();
  const sharedSecret = (env.GOOGLE_INTEGRATIONS_CLIENT_SECRET ?? '').trim();
  if (sharedId !== '' && sharedSecret !== '') {
    return { clientId: sharedId, clientSecret: sharedSecret };
  }
  return null;
}
