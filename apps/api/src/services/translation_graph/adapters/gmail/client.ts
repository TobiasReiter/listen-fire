// Credentialed Gmail client resolution — shared by the read Adapter (index.ts)
// and the PollSource (poll.ts). The wire shape itself lives in
// `adapters/gmail/apiClient.ts`; this is only the credential half.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';

import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { gmailCredentialShape } from '../../../credentials/app_id';
import { neverAsAny } from '../../../../lib/utils/types';
import {
  GmailApiClient,
  checkGmailMailboxAllowed,
  gmailDelegatedCredsParser,
  gmailOAuthCredsParser,
  type GmailCredentials,
} from '../../../../adapters/gmail/apiClient';

export type { GmailApiClient };

/**
 * Construct a client for a team's connected mailbox. Returns null when no
 * credential is wired, when the row belongs to the RETIRED per-user sign-in
 * (`app_id` says so without anything being decrypted), or when the stored
 * payload doesn't parse for the shape that column names — the caller turns that
 * into a clear "connect Gmail" error, which is a better diagnostic than an
 * authentication failure.
 *
 * The shape comes from `app_id` rather than from sniffing the payload: a row
 * whose column and contents disagree is a row nothing should act on.
 *
 * THROWS, rather than returning null, when the credential is real but its
 * mailbox is not (or no longer) allowed here — a credential connected under a
 * wider list must stop working the moment the list narrows, and the run's trace
 * should say why, not just that Gmail needs reconnecting.
 */
export async function resolveGmailClient(input: {
  teamId: TeamId;
  credentialsId?: string;
}): Promise<GmailApiClient | null> {
  if (!input.credentialsId) return null;
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', input.credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', input.teamId)
    .select(['id', 'credentials', 'app_id'])
    .executeTakeFirst();
  if (!row) return null;
  const shape = gmailCredentialShape(row.app_id);
  if (shape === null) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(await decryptToken(row.credentials, row.id));
  } catch {
    return null;
  }

  // Route dev-loop team traffic to the fake Gmail (fake-channels). Without this
  // the client would address a mailbox that does not exist against a Google
  // that was never asked.
  const rawPayload =
    isTestHarnessTeam(input.teamId) && typeof payload === 'object' && payload !== null
      ? injectFakeBaseUrl({ ...payload }, 'GOOGLE_GMAIL')
      : payload;

  let credentials: GmailCredentials;
  switch (shape) {
    case 'oauth': {
      const parsed = gmailOAuthCredsParser.safeParse(rawPayload);
      if (!parsed.success) return null;
      credentials = parsed.data;
      break;
    }
    case 'delegated': {
      const parsed = gmailDelegatedCredsParser.safeParse(rawPayload);
      if (!parsed.success) return null;
      credentials = parsed.data;
      break;
    }
    default:
      return neverAsAny(shape);
  }

  const allowed = checkGmailMailboxAllowed(credentials.mailbox, { method: shape });
  if (!allowed.ok) {
    throw new Error(`GmailAdapter: ${allowed.message}`);
  }
  // The row id travels so a rotated OAuth token can be written back to the row
  // it came from; the delegated shape has no token and ignores it.
  return new GmailApiClient(credentials, { credentialsId: row.id });
}
