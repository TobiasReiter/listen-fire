// The legacy line's credentialed Google Sheets client: the row read and
// decrypted here, the dev-loop redirect applied here, the token from the
// platform's google-auth-library client, as before Google Sheets became a
// module (@lf/google-sheets).

import { z } from 'zod';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';

import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { logger } from 'movement-engine/public/log';
import { GoogleSheetsApiClient } from '../../../../adapters/googleSheets/apiClient';

/** Mirrors `googleCredsParser` from `adapters/google/authClient`, so the
 *  decrypted payload is validated at this boundary. `baseUrl` is the
 *  test-harness redirect slot injected by `injectFakeBaseUrl`. */
export const googleSheetsAdapterCredsParser = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  baseUrl: z.string().url().optional(),
});

export async function resolveGoogleSheetsClient(input: { teamId: TeamId; credentialsId: string }): Promise<GoogleSheetsApiClient> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', input.credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', input.teamId)
    .select(['id', 'credentials'])
    .executeTakeFirst();

  if (!row) {
    throw new Error(
      `Google Sheets credentials ${input.credentialsId} not found for team ${input.teamId}. Either the credential was deleted, or the consumer is misconfigured.`,
    );
  }

  const decrypted = await decryptToken(row.credentials, row.id);
  let payload: unknown;
  try {
    payload = JSON.parse(decrypted);
  } catch (err) {
    logger.error('[GoogleSheetsAdapter] credential payload is not valid JSON', {
      teamId: input.teamId,
      credentialsId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Google Sheets credentials ${row.id} are malformed (not valid JSON).`);
  }

  // Route dev-loop team traffic to fake-channels (mirrors Attio / Airtable).
  // Without this branch the adapter hits real Sheets and 401s on the seeded
  // stub token.
  const rawPayload = isTestHarnessTeam(input.teamId) ? injectFakeBaseUrl(payload as Record<string, unknown>, 'GOOGLE_SHEETS') : payload;

  const parsed = googleSheetsAdapterCredsParser.safeParse(rawPayload);
  if (!parsed.success) {
    logger.error('[GoogleSheetsAdapter] credential payload failed validation', {
      teamId: input.teamId,
      credentialsId: row.id,
      error: parsed.error.message,
    });
    throw new Error(`Google Sheets credentials ${row.id} are malformed (${parsed.error.message}).`);
  }

  return new GoogleSheetsApiClient(row.id, parsed.data);
}
