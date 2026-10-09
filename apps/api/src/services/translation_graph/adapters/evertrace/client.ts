// Credentialed Evertrace client resolution — shared by the read/write Adapter
// (index.ts) and the PollSource (poll.ts). The wire shape itself lives in
// `adapters/evertrace/apiClient.ts`; this is only the credential half.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';

import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import {
  EvertraceApiClient,
  evertraceCredsParser,
  getEvertraceClient,
} from '../../../../adapters/evertrace/apiClient';

export type { EvertraceApiClient };

/**
 * Construct a credentialed client for a team. Returns null when no credential
 * is wired or the stored payload doesn't parse — the caller turns that into a
 * clear "connect Evertrace" error, which is a better diagnostic than a 401.
 */
export async function resolveEvertraceClient(input: {
  teamId: TeamId;
  credentialsId?: string;
}): Promise<EvertraceApiClient | null> {
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

  // Route dev-loop team traffic to the fake Evertrace API (fake-channels).
  // Without this the client hits the real API and 401s on the seeded stub key.
  const rawPayload = isTestHarnessTeam(input.teamId)
    ? injectFakeBaseUrl(payload as Record<string, unknown>, 'EVERTRACE')
    : payload;

  const parsed = evertraceCredsParser.safeParse(rawPayload);
  if (!parsed.success) return null;
  return getEvertraceClient(parsed.data.apiKey, parsed.data.baseUrl);
}
