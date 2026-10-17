// Airtable's legacy line: the module's adapter (@lf/airtable), over the
// credential path the platform used before modules (the row read and
// decrypted here, the dev loop's fake for the test-harness team, the row's
// own refresh). Kept so the `BUILTIN_MODULES` line for Airtable can go back
// to `legacy` in one edit while the module line is new; remove it with the
// line once the module line has soaked.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';

import { AirtableAdapter, airtableAdapterCredsParser, type AirtableAPIClient } from '@listen-fire/airtable';
import { logger } from 'movement-engine/public/log';
import { getAirtableClient } from '../../../../adapters/airtable/apiClient';
import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { platformModuleFiles } from '../../engine/files/module_files';

export { AIRTABLE_ADAPTER_TYPE } from '@listen-fire/airtable/types';
export { AIRTABLE_MANIFEST } from '@listen-fire/airtable/manifest';

async function legacyClient(input: { teamId: TeamId; credentialsId: string }): Promise<AirtableAPIClient> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', input.credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', input.teamId)
    .select(['id', 'credentials'])
    .executeTakeFirst();
  if (!row) {
    throw new Error(
      `Airtable credentials ${input.credentialsId} not found for team ${input.teamId}. Either the credential was deleted, or the consumer is misconfigured.`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await decryptToken(row.credentials, row.id));
  } catch (err) {
    logger.error('[AirtableAdapter] credential payload is not valid JSON', {
      teamId: input.teamId,
      credentialsId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Airtable credentials ${row.id} are malformed (not valid JSON).`);
  }
  // Route dev-loop team traffic to fake-channels.
  const parsed = airtableAdapterCredsParser.safeParse(isTestHarnessTeam(input.teamId) ? injectFakeBaseUrl(payload as Record<string, unknown>, 'AIRTABLE') : payload);
  if (!parsed.success) {
    logger.error('[AirtableAdapter] credential payload failed validation', {
      teamId: input.teamId,
      credentialsId: row.id,
      error: parsed.error.message,
    });
    throw new Error(`Airtable credentials ${row.id} are malformed (${parsed.error.message}).`);
  }
  return getAirtableClient(row.id, parsed.data);
}

export function createAirtableAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
  /** The `base:` construction arg — a base's name to scope the instance to
   *  (optional; default is the full workspace). */
  base?: string;
}): AirtableAdapter {
  const { credentialsId } = input;
  if (!credentialsId) {
    throw new Error('Airtable adapter requires credentialsId — wire pipeline_output.credentials_id (out-flow) through getAdapter.');
  }
  return new AirtableAdapter({
    tenant: input.teamId,
    client: () => legacyClient({ teamId: input.teamId, credentialsId }),
    files: platformModuleFiles({ teamId: input.teamId, module: '@lf/airtable' }),
    ...(input.base !== undefined ? { base: input.base } : {}),
  });
}
