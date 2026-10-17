import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { logger } from 'movement-engine/public/log';
import {
  createOAuth2Connector,
  createSecretsFamily,
  OAuth2ExchangeFailed,
  type OAuth2ClientApp,
  type OAuth2Connector,
  type OAuth2Declaration,
} from 'movement-engine/public/secrets';

import { GOOGLE_DRIVE_FILE_OAUTH2, GOOGLE_DRIVE_FILE_SCOPES, GOOGLE_OAUTH2_ENDPOINTS, GOOGLE_OFFLINE_CONSENT } from '@listen-fire/google-sheets/google_oauth';

import { camelTokenPayloadShape, postgresSecrets } from '../../services/credentials/secrets_postgres';

const scopes = [...GOOGLE_DRIVE_FILE_SCOPES];

// Google's endpoints and the Sheets and Drive connect declaration live with
// the module that declares them (@lf/google-sheets); re-exported for the
// platform's connect flows (Gmail's among them).
export { GOOGLE_OAUTH2_ENDPOINTS, GOOGLE_OFFLINE_CONSENT };

/** How a Google (Sheets and Drive) credential is connected: what its module
 *  manifest declares. The client goes in the form body. */
export const googleOAuth2: OAuth2Declaration = GOOGLE_DRIVE_FILE_OAUTH2;

/** The platform's own Google app (Sheets and Drive), from the environment
 *  `services.google` is built from; undefined when it is not configured. */
export function googleIntegrationsApp(env: Readonly<Record<string, string | undefined>> = process.env): OAuth2ClientApp | undefined {
  const clientId = env.GOOGLE_INTEGRATIONS_CLIENT_ID;
  const clientSecret = env.GOOGLE_INTEGRATIONS_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** What a Google token endpoint must grant a connect: a refresh token and an
 *  expiry beside the access token. */
export const googleIssuedTokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number(),
});

const googleCredsParser = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
});

class GoogleAuthClient {
  private readonly connector: OAuth2Connector;
  private clientId: string;
  private clientSecret: string;
  private clientsById: Record<string, OAuth2Client> = {};
  readonly callbackUrl: string;

  constructor({ clientId, clientSecret, redirectBaseUrl }: { clientId: string; clientSecret: string; redirectBaseUrl: string }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = `${redirectBaseUrl}/google-integrations/callback`;
    this.connector = createOAuth2Connector({ oauth2: googleOAuth2, client: { clientId, clientSecret }, redirectUri: this.callbackUrl });
  }

  getGoogleClient(id: string, creds: z.infer<typeof googleCredsParser>): OAuth2Client {
    if (!this.clientsById[id]) {
      const client = new OAuth2Client({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      });
      this.clientsById[id] = client;

      client.on('tokens', async (tokens) => {
        logger.info('[GOOGLE] SAVING CREDENTIALS');
        if (!tokens.access_token || !tokens.expiry_date) {
          logger.error('[GOOGLE] Token refresh missing required fields');
          throw new Error('Invalid token received');
        }

        const refreshToken = tokens.refresh_token ?? client.credentials.refresh_token;
        const newSavedCreds: z.infer<typeof googleCredsParser> = {
          accessToken: tokens.access_token,
          refreshToken: refreshToken ?? creds.refreshToken,
          expiresAt: tokens.expiry_date,
        };

        // Re-set credentials on the client to preserve the refresh token
        client.setCredentials({
          access_token: tokens.access_token,
          refresh_token: newSavedCreds.refreshToken,
          expiry_date: tokens.expiry_date,
        });

        // The library refreshed by itself, so the write-back holds no
        // version: it goes under the credential's lock over what is stored.
        await createSecretsFamily({ backend: postgresSecrets({ shape: camelTokenPayloadShape }) }).update(id, {
          access_token: newSavedCreds.accessToken,
          refresh_token: newSavedCreds.refreshToken,
          expires_at: new Date(newSavedCreds.expiresAt).toISOString(),
        });
        logger.info('[GOOGLE] CREDENTIALS SAVED');
      });
    }

    // Always update credentials from the latest DB values
    if (!creds.refreshToken) {
      logger.error(`[GOOGLE] Credential ${id} has no refresh token — user must re-authenticate`);
    }
    logger.info(`[GOOGLE] Setting credentials for ${id}`, {
      hasAccessToken: !!creds.accessToken,
      hasRefreshToken: !!creds.refreshToken,
      expiresAt: creds.expiresAt,
    });
    this.clientsById[id].setCredentials({
      access_token: creds.accessToken,
      refresh_token: creds.refreshToken,
      expiry_date: creds.expiresAt,
    });

    return this.clientsById[id];
  }

  removeClient(id: string) {
    delete this.clientsById[id];
  }

  async codeToToken({
    state,
    code,
  }: {
    state: string;
    code: string;
  }): Promise<z.infer<typeof googleCredsParser>> {
    let response: Readonly<Record<string, unknown>>;
    try {
      response = (await this.connector.complete({ state, code })).response;
    } catch (error) {
      if (!(error instanceof OAuth2ExchangeFailed)) throw error;
      logger.error(`[GOOGLE] Token exchange failed: ${error.message}`);
      throw new Error('Invalid token received');
    }

    const issued = googleIssuedTokens.safeParse(response);
    if (!issued.success) {
      logger.error('[GOOGLE] Token exchange missing required fields');
      throw new Error('Invalid token received');
    }

    return {
      accessToken: issued.data.access_token,
      refreshToken: issued.data.refresh_token,
      expiresAt: Date.now() + issued.data.expires_in * 1000,
    };
  }

  async generateInstallUrl(): Promise<string> {
    return this.connector.begin();
  }
}

export { GoogleAuthClient, googleCredsParser, scopes };
