// The platform's own Airtable clients (the extraction pipeline, the output
// agent, Airtable's legacy line): Airtable's module client over the stored
// credential row, one per credential, refreshing as it always has — the
// platform's OAuth app exchanges the refresh token and the row is rewritten
// in place. A module line refreshes through its host instead.

import type { z } from 'zod';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { AirtableAPIClient, airtableCredsParser, fieldParser, type AirtableTokens } from '@listen-fire/airtable/api_client';
import { logger } from 'movement-engine/public/log';
import { services } from '../registry';
import { encryptToken } from '../../lib/credentials';
import { getAutomationsQb } from '../../lib/kysely';

type AirtableCreds = z.infer<typeof airtableCredsParser>;

/** The row's tokens, refreshed with the platform's app and written back. */
function rowTokens(credentialsId: string, creds: AirtableCreds): AirtableTokens {
  let accessToken = creds.accessToken;
  let refreshToken = creds.refreshToken;
  return {
    accessToken: async () => accessToken,
    refresh: async () => {
      logger.info('[AIRTABLE] EXCHANGING REFRESH TOKEN');
      const tokenResult = await services.airtable?.authClient.exchangeRefreshToken({ refreshToken });
      logger.info('[AIRTABLE] REFRESH TOKEN EXCHANGED');
      if (!tokenResult) {
        throw new Error('Failed to refresh Airtable access token');
      }
      accessToken = tokenResult.accessToken;
      refreshToken = tokenResult.refreshToken;

      logger.info('[AIRTABLE] SAVING CREDENTIALS');
      const newSavedCreds: AirtableCreds = {
        accessToken,
        refreshToken,
        accessTokenExpiresAt: new Date(Date.now() + tokenResult.expiresIn * 1000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + tokenResult.refreshExpiresIn * 1000).toISOString(),
      };
      const encrypted = await encryptToken(JSON.stringify(newSavedCreds), credentialsId);
      await getAutomationsQb(['external_service_credentials'])
        .updateTable('external_service_credentials')
        .set({ credentials: encrypted, updated_at: new Date() })
        .where('id', '=', credentialsId as ExternalServiceCredentialsId)
        .execute();
      logger.info('[AIRTABLE] CREDENTIALS SAVED');
    },
  };
}

const clientsByCredentialsId: Record<string, AirtableAPIClient> = {};

const getAirtableClient = (id: string, creds: AirtableCreds): AirtableAPIClient => {
  if (!clientsByCredentialsId[id]) {
    clientsByCredentialsId[id] = new AirtableAPIClient({
      tokens: rowTokens(id, creds),
      ...(creds.baseUrl !== undefined ? { baseUrl: creds.baseUrl } : {}),
    });
  }
  return clientsByCredentialsId[id];
};

function clearClientByCredentialsId(id: string) {
  delete clientsByCredentialsId[id];
}

export { AirtableAPIClient, getAirtableClient, airtableCredsParser, clearClientByCredentialsId, fieldParser };
