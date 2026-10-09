import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { V3Adapter } from './types';

import { attioCredsParser, getAttioClient } from '../../../../adapters/attio/apiClient';
import { AttioOperations } from '../../../../adapters/attio/operations';
import { affinityCredsParser, getAffinityClient } from '../../../../adapters/affinity/apiClient';
import { AffinityOperations } from '../../../../adapters/affinity/operations';
import { airtableCredsParser, getAirtableClient } from '../../../../adapters/airtable/apiClient';
import { getSlackClient, slackCredsParser } from '../../../../adapters/slack/webApi/apiClient';
import { googleCredsParser } from '../../../../adapters/google/authClient';
import { GoogleDriveClient } from '../../../../adapters/google/driveClient';
import { GoogleSheetsApiClient } from '../../../../adapters/googleSheets/apiClient';
import { webhookGraphOutputConfigSchema } from '../../../../adapters/webhook/configSchema';
import { getAutomationsQb } from '../../../../lib/kysely';
import { decryptToken } from '../../../../lib/credentials';
import { logger } from '../../../logger';
import { createAttioV3Adapter } from './attio';
import { createAffinityV3Adapter } from './affinity';
import { createAirtableV3Adapter } from './airtable';
import { createGoogleSheetsV3Adapter } from './google_sheets';
import { createSlackV3Adapter } from './slack';
import { createWebhookV3Adapter } from './webhook';
import { createGDriveV3Adapter } from './gdrive';
import { createDropboxV3Adapter } from './dropbox';
import { dropboxCredsParser } from '../../../../adapters/dropbox/authClient';
import { DropboxClient } from '../../../../adapters/dropbox/apiClient';
import { services } from '../../../../adapters/registry';
import { currentContext } from '../../../context';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';


async function initializeV3Adapter(output: {
  id: string;
  type: string;
  config: unknown;
  credentials_id: string | null;
}): Promise<V3Adapter | null> {
  const adapterType = output.type;

  if (adapterType === 'WEBHOOK') {
    const configObj = output.config as Record<string, unknown> | null;
    const parsed = webhookGraphOutputConfigSchema.safeParse(configObj?.webhookConfig ?? configObj ?? {});
    if (!parsed.success) {
      logger.warn(`V3 output ${output.id}: invalid webhook config`);
      return null;
    }
    return createWebhookV3Adapter(parsed.data);
  }

  if (!output.credentials_id) {
    logger.warn(`V3 output ${output.id}: no credentials configured`);
    return null;
  }

  const outbound = await loadOutputCredentials({
    credentialsId: output.credentials_id,
    type: adapterType,
  });
  if (!outbound) {
    logger.warn(`V3 output ${output.id}: could not load credentials`);
    return null;
  }

  if (adapterType === 'ATTIO') {
    const credsParsed = attioCredsParser.safeParse(outbound.creds);
    if (!credsParsed.success) {
      logger.warn(`V3 output ${output.id}: invalid Attio credentials`);
      return null;
    }
    const client = getAttioClient(credsParsed.data.accessToken, credsParsed.data.baseUrl);
    return createAttioV3Adapter(new AttioOperations(client));
  }

  if (adapterType === 'SLACK') {
    const credsParsed = slackCredsParser.safeParse(outbound.creds);
    if (!credsParsed.success) {
      logger.warn(`V3 output ${output.id}: invalid Slack credentials`);
      return null;
    }
    return createSlackV3Adapter(getSlackClient(credsParsed.data.accessToken, credsParsed.data.baseUrl));
  }

  if (adapterType === 'AFFINITY') {
    const credsParsed = affinityCredsParser.safeParse(outbound.creds);
    if (!credsParsed.success) {
      logger.warn(`V3 output ${output.id}: invalid Affinity credentials`);
      return null;
    }
    const client = getAffinityClient(credsParsed.data.apiKey, credsParsed.data.baseUrl);
    return createAffinityV3Adapter(new AffinityOperations(client));
  }

  if (adapterType === 'AIRTABLE') {
    const credsParsed = airtableCredsParser.safeParse(outbound.creds);
    if (!credsParsed.success) {
      logger.warn(`V3 output ${output.id}: invalid Airtable credentials`);
      return null;
    }
    const client = getAirtableClient(output.credentials_id!, credsParsed.data);
    return createAirtableV3Adapter(client);
  }

  if (adapterType === 'GOOGLE_SHEETS') {
    const credsParsed = googleCredsParser.safeParse(outbound.creds);
    if (!credsParsed.success) {
      logger.warn(`V3 output ${output.id}: invalid Google credentials`);
      return null;
    }
    const client = new GoogleSheetsApiClient(output.credentials_id!, credsParsed.data);
    return createGoogleSheetsV3Adapter(client);
  }

  if (adapterType === 'GOOGLE_DRIVE') {
    const credsParsed = googleCredsParser.safeParse(outbound.creds);
    if (!credsParsed.success) {
      logger.warn(`V3 output ${output.id}: invalid Google credentials`);
      return null;
    }
    if (!services.google) {
      logger.warn(`V3 output ${output.id}: Google integrations not configured`);
      return null;
    }
    const oauth2Client = services.google.authClient.getGoogleClient(output.credentials_id!, credsParsed.data);
    return createGDriveV3Adapter(new GoogleDriveClient(oauth2Client));
  }

  if (adapterType === 'DROPBOX') {
    const credsParsed = dropboxCredsParser.safeParse(outbound.creds);
    if (!credsParsed.success) {
      logger.warn(`V3 output ${output.id}: invalid Dropbox credentials`);
      return null;
    }
    if (!services.dropbox) {
      logger.warn(`V3 output ${output.id}: Dropbox integrations not configured`);
      return null;
    }
    const accessToken = await services.dropbox.authClient.getValidAccessToken(output.credentials_id!, credsParsed.data);
    return createDropboxV3Adapter(new DropboxClient(accessToken));
  }

  logger.warn(`V3 adapter type "${adapterType}" not yet supported`);
  return null;
}

/**
 * The destination's stored credential, decrypted. Team-scoped by the caller's
 * context so an output can never borrow another team's credential. The
 * test-harness base-url injection mirrors the live adapter framework's.
 */
async function loadOutputCredentials(options: {
  credentialsId: string;
  type: string;
}): Promise<{ creds: Record<string, unknown> } | null> {
  const ctx = currentContext();
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', options.credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', ctx.user.teamId as TeamId)
    .select(['id', 'credentials'])
    .executeTakeFirst();
  if (!row) return null;

  let creds: Record<string, unknown>;
  try {
    creds = JSON.parse(await decryptToken(row.credentials, row.id)) as Record<string, unknown>;
  } catch (err) {
    logger.error('V3 output: failed to decrypt credential', err);
    return null;
  }

  if (isTestHarnessTeam(ctx.user.teamId)) {
    creds = injectFakeBaseUrl(creds, options.type);
  }
  return { creds };
}

export { initializeV3Adapter };
export type { V3Adapter } from './types';
export type { V3AdapterExecuteInput, AdapterResult } from './types';
