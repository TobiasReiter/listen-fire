// Dropbox's legacy line: the module's adapter (@lf/dropbox), over the
// credential path the platform used before modules (the decrypted row, a token
// refreshed through the Dropbox auth client). Kept so the `BUILTIN_MODULES`
// line for Dropbox can go back to `legacy` in one edit while the module line is
// new; remove it with the line once the module line has soaked.

import type { Adapter } from 'movement-engine/public/adapter';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';

import { DropboxAdapter, DropboxClient, type DropboxClientSource } from '@listen-fire/dropbox';
import { z } from 'zod';
import { logger } from 'movement-engine/public/log';
import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { services } from '../../../../adapters/registry';
import { readHandedFile } from 'module-kit';
import { ownedFilesAdapter } from 'movement-engine/public/modules';
import { platformModuleFiles } from '../../engine/files/module_files';

export { DROPBOX_ADAPTER_TYPE, DROPBOX_MANIFEST } from '@listen-fire/dropbox';

/** The stored payload, `baseUrl` being the test-harness redirect slot
 *  `injectFakeBaseUrl` fills for the dev-loop team. */
const dropboxStoredCredential = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  baseUrl: z.string().url().optional(),
});

/** The client built once, on first use, from the install's stored credential. */
function legacyClient(input: { teamId: TeamId; credentialsId: string }): DropboxClientSource {
  let client: DropboxClient | null = null;
  return async () => {
    if (client) return client;

    const row = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', input.credentialsId as ExternalServiceCredentialsId)
      .where('team_id', '=', input.teamId)
      .select(['id', 'credentials'])
      .executeTakeFirst();

    if (!row) {
      throw new Error(
        `Dropbox credentials ${input.credentialsId} not found for team ${input.teamId}. Either the credential was deleted, or the consumer is misconfigured.`,
      );
    }

    const decrypted = await decryptToken(row.credentials, row.id);
    let payload: unknown;
    try {
      payload = JSON.parse(decrypted);
    } catch (err) {
      logger.error('[DropboxAdapter] credential payload is not valid JSON', {
        teamId: input.teamId,
        credentialsId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`Dropbox credentials ${row.id} are malformed (not valid JSON).`);
    }

    // Route dev-loop team traffic to fake-channels.
    const rawPayload = isTestHarnessTeam(input.teamId)
      ? injectFakeBaseUrl(payload as Record<string, unknown>, 'DROPBOX')
      : payload;

    const parsed = dropboxStoredCredential.safeParse(rawPayload);
    if (!parsed.success) {
      logger.error('[DropboxAdapter] credential payload failed validation', {
        teamId: input.teamId,
        credentialsId: row.id,
        error: parsed.error.message,
      });
      throw new Error(`Dropbox credentials ${row.id} are malformed (${parsed.error.message}).`);
    }

    if (!services.dropbox) {
      throw new Error('Dropbox adapter: Dropbox integrations are not configured (services.dropbox is unset).');
    }

    const accessToken = await services.dropbox.authClient.getValidAccessToken(row.id, {
      accessToken: parsed.data.accessToken,
      refreshToken: parsed.data.refreshToken,
      expiresAt: parsed.data.expiresAt,
    });
    client = new DropboxClient(accessToken, parsed.data.baseUrl ? { baseUrl: parsed.data.baseUrl } : undefined);
    return client;
  };
}

export function createDropboxAdapter(input: { teamId: TeamId; credentialsId?: string }): Adapter {
  if (!input.credentialsId) {
    throw new Error(
      'Dropbox adapter requires credentialsId — wire pipeline_output.credentials_id (out-flow) through getAdapter.',
    );
  }
  const install = { teamId: input.teamId, credentialsId: input.credentialsId };
  const files = platformModuleFiles({ teamId: input.teamId, module: '@lf/dropbox' });
  return ownedFilesAdapter(
    new DropboxAdapter({ client: legacyClient(install), files: { read: (ref) => readHandedFile({ fetch, files }, ref) }, log: logger }),
    { adapterType: 'dropbox', credentialsId: input.credentialsId },
  );
}
