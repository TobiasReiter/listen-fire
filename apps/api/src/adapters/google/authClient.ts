import { randomBytes, createHash } from 'node:crypto';

import { z } from 'zod';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';

import { logger } from 'movement-engine/services/logger';
import { createSecretsFamily } from 'movement-engine/public/secrets';
import { camelTokenPayloadShape, postgresSecrets } from '../../services/credentials/secrets_postgres';

const scopes = [
  'https://www.googleapis.com/auth/drive.file',
];

const googleCredsParser = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
});

class GoogleAuthClient {
  private authCache: Record<string, string> = {};
  private oauth2Client: OAuth2Client;
  private clientId: string;
  private clientSecret: string;
  private clientsById: Record<string, OAuth2Client> = {};
  readonly callbackUrl: string;

  constructor({ clientId, clientSecret, redirectBaseUrl }: { clientId: string; clientSecret: string; redirectBaseUrl: string }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = `${redirectBaseUrl}/google-integrations/callback`;
    this.oauth2Client = new OAuth2Client({
      clientId,
      clientSecret,
      redirectUri: this.callbackUrl,
    });
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
    const codeVerifier = this.authCache[state];
    if (!codeVerifier) {
      throw new Error('Invalid state parameter value');
    }

    delete this.authCache[state];

    const { tokens } = await this.oauth2Client.getToken({
      code,
      codeVerifier,
    });

    if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
      logger.error('[GOOGLE] Token exchange missing required fields');
      throw new Error('Invalid token received');
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date,
    };
  }

  async generateInstallUrl(): Promise<string> {
    const state = randomBytes(100).toString('base64url');
    const codeVerifier = randomBytes(96).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier) // hash the code verifier with the sha256 algorithm
      .digest('base64') // base64 encode, needs to be transformed to base64url
      .replace(/=/g, '') // remove =
      .replace(/\+/g, '-') // replace + with -
      .replace(/\//g, '_'); // replace / with _ now base64url encoded

    this.authCache[state] = codeVerifier;
    setTimeout(
      () => {
        delete this.authCache[state];
      },
      1000 * 60 * 15,
    ); // 15 minutes

    return this.oauth2Client.generateAuthUrl({
      state,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      scope: scopes,
    });
  }
}

export { GoogleAuthClient, googleCredsParser, scopes };
