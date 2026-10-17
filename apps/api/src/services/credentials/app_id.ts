// `external_service_credentials.app_id` — which app/bot in an external service a
// credential grants access through. A stable Listen-Fire-side shorthand (the real
// external ids live in env; we branch our own code on this), so a second app of
// the same ExternalServiceType can be told apart and filtered without decrypting
// the credential.

import { gmailConnectMethod } from '../../adapters/gmail/connect_method';
import { neverAsAny } from 'movement-engine/public/utils';

/** The Slack apps we distinguish. */
export const SLACK_APP_ID = {
  /** The legacy Slack app — knowledge pipeline, ops feed, monitoring. */
  legacy: 'legacy',
  /** The new "Listen-Fire" Slack app that runs movements. */
  movements: 'listen-fire',
} as const;

export type SlackAppId = (typeof SLACK_APP_ID)[keyof typeof SLACK_APP_ID];

/**
 * The Gmail credential SHAPES that share `GOOGLE_GMAIL`.
 *
 * Three values, two of them live. The connector's mailbox is reached EITHER by
 * a sign-in as that mailbox (an OAuth refresh token, which Google confines to
 * the one address) or by the service account acting as it (no token at all,
 * just the address). They are told apart here rather than by decrypting and
 * guessing at the payload, and the retired per-user sign-in — whose token
 * nothing ever read — must keep reading as dead before anything tries to use it
 * as a mailbox.
 */
export const GMAIL_APP_ID = {
  /** The retired per-user OAuth sign-in. Pre-discriminator rows are null and
   *  read as this, which is right: they all came from that flow. */
  legacySignIn: 'gmail-oauth',
  /** The connector: one mailbox, reached by domain wide delegation. */
  delegatedMailbox: 'gmail-delegated',
  /** The connector: one mailbox somebody signed into, reached by its own
   *  refresh token. Deliberately NOT `gmail-oauth` — that value already names
   *  the dead rows. */
  oauthMailbox: 'gmail-oauth-mailbox',
} as const;

export type GmailAppId = (typeof GMAIL_APP_ID)[keyof typeof GMAIL_APP_ID];

/** Which shape a `GOOGLE_GMAIL` credential is, or null when it is a dead row
 *  from the retired sign-in (explicitly, or by being pre-discriminator). */
export function gmailCredentialShape(
  appId: string | null | undefined,
): 'delegated' | 'oauth' | null {
  if (appId === GMAIL_APP_ID.delegatedMailbox) return 'delegated';
  if (appId === GMAIL_APP_ID.oauthMailbox) return 'oauth';
  return null;
}

/** Whether a `GOOGLE_GMAIL` credential is a connector mailbox rather than a
 *  dead row from the retired sign-in. */
export function isDelegatedGmail(appId: string | null | undefined): boolean {
  return appId === GMAIL_APP_ID.delegatedMailbox;
}

/**
 * Whether a credential belongs to the LEGACY app — explicitly `legacy`, or
 * pre-discriminator (`null`, from before this column existed). Legacy pipelines
 * filter on this; modern (movements) paths require `app_id === 'listen-fire'`.
 */
export function isLegacyApp(appId: string | null | undefined): boolean {
  return appId == null || appId === SLACK_APP_ID.legacy;
}

/**
 * The `app_id` a freshly-minted credential of `type` gets by default. Slack:
 * `listen-fire` — the modern connect flow IS the Listen-Fire app (Option A), so every new
 * Slack credential belongs to it; pre-existing legacy rows keep their `null`
 * (read as legacy). Gmail: whichever shape this installation's connect method
 * mints, since that method is the only flow a new mailbox can arrive through.
 * Other services: undefined (no second app to distinguish).
 */
export function defaultAppIdForType(type: string): string | undefined {
  if (type === 'SLACK') return SLACK_APP_ID.movements;
  if (type === 'GOOGLE_GMAIL') {
    const method = gmailConnectMethod();
    switch (method) {
      case 'oauth':
        return GMAIL_APP_ID.oauthMailbox;
      case 'delegated':
        return GMAIL_APP_ID.delegatedMailbox;
      default:
        return neverAsAny(method);
    }
  }
  return undefined;
}
