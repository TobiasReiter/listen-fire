// The legacy line's credentialed Google Drive client: the row read and
// decrypted here, the dev-loop redirect applied here, the token from the
// platform's google-auth-library client, as before Google Drive became a
// module (@lf/google-drive).

import { z } from 'zod';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';

import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { logger } from 'movement-engine/public/log';
import { services } from '../../../../adapters/registry';
import { GoogleDriveClient } from '../../../../adapters/google/driveClient';

/** Mirrors `googleCredsParser` from `adapters/google/authClient`, so the
 *  decrypted payload is validated at this boundary. `baseUrl` is the
 *  test-harness redirect slot injected by `injectFakeBaseUrl` (it becomes the
 *  googleapis rootUrl). */
export const googleDriveAdapterCredsParser = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  baseUrl: z.string().url().optional(),
});

export async function resolveGoogleDriveClient(input: { teamId: TeamId; credentialsId: string }): Promise<GoogleDriveClient> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', input.credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', input.teamId)
    .select(['id', 'credentials'])
    .executeTakeFirst();

  if (!row) {
    throw new Error(
      `Google Drive credentials ${input.credentialsId} not found for team ${input.teamId}. Either the credential was deleted, or the consumer is misconfigured.`,
    );
  }

  const decrypted = await decryptToken(row.credentials, row.id);
  let payload: unknown;
  try {
    payload = JSON.parse(decrypted);
  } catch (err) {
    logger.error('[GoogleDriveAdapter] credential payload is not valid JSON', {
      teamId: input.teamId,
      credentialsId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Google Drive credentials ${row.id} are malformed (not valid JSON).`);
  }

  // Route dev-loop team traffic to fake-channels (mirrors Attio / Airtable /
  // Sheets): the injected baseUrl becomes the googleapis rootUrl, so every
  // call — uploads included — hits the fake.
  const rawPayload = isTestHarnessTeam(input.teamId) ? injectFakeBaseUrl(payload as Record<string, unknown>, 'GOOGLE_DRIVE') : payload;

  const parsed = googleDriveAdapterCredsParser.safeParse(rawPayload);
  if (!parsed.success) {
    logger.error('[GoogleDriveAdapter] credential payload failed validation', {
      teamId: input.teamId,
      credentialsId: row.id,
      error: parsed.error.message,
    });
    throw new Error(`Google Drive credentials ${row.id} are malformed (${parsed.error.message}).`);
  }

  if (!services.google) {
    throw new Error('Google Drive adapter: Google integrations are not configured (services.google is unset).');
  }

  const oauth2Client = services.google.authClient.getGoogleClient(row.id, parsed.data);
  return new GoogleDriveClient(oauth2Client, parsed.data.baseUrl ? { baseUrl: parsed.data.baseUrl } : undefined);
}
