// Attio's legacy line: the module's adapter (@lf/attio), over the credential
// path the platform used before modules (the row read and decrypted here, the
// dev loop's fake for the test-harness team). Kept so the `BUILTIN_MODULES`
// line for Attio can go back to `legacy` in one edit while the module line is
// new; remove it with the line once the module line has soaked.

import './attio_field_rejection_alerts';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { AttioAdapter, attioCredsParser, getAttioClient, type AttioAPIClient } from '@lf/attio';
import { logger } from 'movement-engine/public/log';
import { decryptToken } from '../../../lib/credentials';
import { getAutomationsQb } from '../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../lib/recording';
import { platformModuleFiles } from '../engine/files/module_files';
import { ownedFilesAdapter } from 'movement-engine/public/modules';

export * from '@lf/attio/adapter';

async function legacyClient(input: { teamId: TeamId; credentialsId: string }): Promise<AttioAPIClient> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', input.credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', input.teamId)
    .select(['id', 'credentials'])
    .executeTakeFirst();
  if (!row) {
    throw new Error(
      `Attio credentials ${input.credentialsId} not found for team ${input.teamId}. Either the credential was deleted, or the consumer is misconfigured.`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await decryptToken(row.credentials, row.id));
  } catch (err) {
    logger.error('[AttioAdapter] credential payload is not valid JSON', {
      teamId: input.teamId,
      credentialsId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Attio credentials ${row.id} are malformed (not valid JSON).`);
  }
  // Route dev-loop team traffic to fake-channels.
  const parsed = attioCredsParser.safeParse(isTestHarnessTeam(input.teamId) ? injectFakeBaseUrl(payload as Record<string, unknown>, 'ATTIO') : payload);
  if (!parsed.success) {
    logger.error('[AttioAdapter] credential payload failed validation', {
      teamId: input.teamId,
      credentialsId: row.id,
      error: parsed.error.message,
    });
    throw new Error(`Attio credentials ${row.id} are malformed (${parsed.error.message}).`);
  }
  return getAttioClient(parsed.data.accessToken, parsed.data.baseUrl);
}

export function createAttioAdapter(input: { teamId: TeamId; credentialsId?: string }): AttioAdapter {
  const { credentialsId } = input;
  if (!credentialsId) {
    throw new Error(
      'Attio adapter requires credentialsId — wire pipeline_input.credentials_id (in-flow) or pipeline_output.credentials_id (out-flow) through getAdapter.',
    );
  }
  const adapter = new AttioAdapter({
    tenant: input.teamId,
    client: () => legacyClient({ teamId: input.teamId, credentialsId }),
    files: platformModuleFiles({ teamId: input.teamId, module: '@lf/attio' }),
    fetch,
  });
  // Its files name this install as their owner, as they always have.
  return ownedFilesAdapter(adapter, { adapterType: adapter.adapterType, credentialsId });
}
