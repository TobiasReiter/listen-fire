// The legacy line's credentialed Granola client: the row read and decrypted
// here, the dev-loop redirect applied here, as before Granola became a module
// (@lf/granola). Shared by the legacy adapter and poll (index.ts). The wire
// shape is the module's client.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';

import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { GranolaClient, granolaCredsParser } from '@lf/granola';
import { logger } from 'movement-engine/public/log';

/**
 * Construct a credentialed client for a team. Returns null when no credential
 * is wired or the stored payload doesn't parse — the caller turns that into a
 * clear "connect Granola" error, which is a better diagnostic than a 401.
 */
export async function resolveGranolaClient(input: {
  teamId: TeamId;
  credentialsId?: string;
}): Promise<GranolaClient | null> {
  if (!input.credentialsId) return null;
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', input.credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', input.teamId)
    .select(['id', 'credentials'])
    .executeTakeFirst();
  if (!row) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(await decryptToken(row.credentials, row.id));
  } catch {
    return null;
  }
  // Route dev-loop team traffic to the fake Granola API (fake-channels).
  // Without it the client hits real Granola and 401s on the seeded stub token.
  const rawPayload = isTestHarnessTeam(input.teamId)
    ? injectFakeBaseUrl(payload as Record<string, unknown>, 'GRANOLA')
    : payload;
  const parsed = granolaCredsParser.safeParse(rawPayload);
  if (!parsed.success) return null;
  return new GranolaClient({ ...parsed.data, fetch, log: logger });
}
