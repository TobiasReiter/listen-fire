import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { logger } from 'movement-engine/services/logger';
import { createSecretsFamily, expiresWithin, oauth2Refresher, type SecretFields } from 'movement-engine/public/secrets';
import { camelTokenPayloadShape, postgresSecrets } from '../../services/credentials/secrets_postgres';

const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const REFRESH_WINDOW_MS = 60_000;

function dropboxSecrets() {
  return createSecretsFamily({ backend: postgresSecrets({ shape: camelTokenPayloadShape }) });
}

/** The stored token fields as the Dropbox payload, keeping the caller's
 *  refresh token if the store somehow holds none. */
function credsOf(fields: SecretFields, previous: DropboxCreds): DropboxCreds {
  const expiresAt = fields.expires_at !== undefined ? Date.parse(fields.expires_at) : Number.NaN;
  return {
    accessToken: fields.access_token ?? previous.accessToken,
    refreshToken: fields.refresh_token ?? previous.refreshToken,
    expiresAt: Number.isNaN(expiresAt) ? previous.expiresAt : expiresAt,
  };
}

export const dropboxCredsParser = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
});

export type DropboxCreds = z.infer<typeof dropboxCredsParser>;

export class DropboxAuthClient {
  private authCache: Record<string, string> = {};
  private clientId: string;
  private clientSecret: string;
  readonly callbackUrl: string;

  constructor({ clientId, clientSecret, redirectBaseUrl }: { clientId: string; clientSecret: string; redirectBaseUrl: string }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = `${redirectBaseUrl}/dropbox/callback`;
  }

  /**
   * Refresh through the secrets family over the credentials table, so the
   * refresh runs once at a time across processes and the write-back is a
   * compare-and-swap: a second caller that found the same stale token takes
   * the first one's answer instead of spending the refresh token again.
   */
  async refreshAccessToken(credentialsId: string, creds: DropboxCreds): Promise<DropboxCreds> {
    const secrets = dropboxSecrets();
    const stored = await secrets.resolve(credentialsId);
    if (stored.fields.access_token !== creds.accessToken && !expiresWithin(stored.fields, REFRESH_WINDOW_MS)) {
      return credsOf(stored.fields, creds);
    }
    try {
      const refreshed = await secrets.refresh(credentialsId, {
        seenVersion: stored.version,
        refresher: oauth2Refresher({
          tokenUrl: DROPBOX_TOKEN_URL,
          clientAuth: 'body',
          client: { clientId: this.clientId, clientSecret: this.clientSecret },
        }),
      });
      logger.info('[DROPBOX] CREDENTIALS REFRESHED');
      return credsOf(refreshed.fields, creds);
    } catch (error) {
      // The family's message names the credential and the provider's answer
      // with every secret value taken out.
      logger.error(`[DROPBOX] Token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error('Dropbox token refresh failed');
    }
  }

  async getValidAccessToken(credentialsId: string, creds: DropboxCreds): Promise<string> {
    if (creds.expiresAt > Date.now() + REFRESH_WINDOW_MS) {
      return creds.accessToken;
    }
    const refreshed = await this.refreshAccessToken(credentialsId, creds);
    return refreshed.accessToken;
  }

  async codeToToken({ state, code }: { state: string; code: string }): Promise<DropboxCreds> {
    if (!this.authCache[state]) {
      throw new Error('Invalid state parameter value');
    }
    delete this.authCache[state];

    const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.callbackUrl,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(`[DROPBOX] Token exchange failed: ${text}`);
      throw new Error('Invalid token received');
    }

    const data = await response.json();
    if (!data.access_token || !data.refresh_token) {
      logger.error(data);
      throw new Error('Invalid token received');
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  generateInstallUrl(): string {
    const state = randomBytes(100).toString('base64url');
    this.authCache[state] = '1';
    setTimeout(() => { delete this.authCache[state]; }, 1000 * 60 * 15);

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      response_type: 'code',
      token_access_type: 'offline',
      state,
    });

    return `https://www.dropbox.com/oauth2/authorize?${params}`;
  }
}
