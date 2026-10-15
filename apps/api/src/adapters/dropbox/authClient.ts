import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { logger } from 'movement-engine/services/logger';
import { encryptToken } from '../../lib/credentials';
import { getAutomationsQb } from '../../lib/kysely';
import { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

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

  async refreshAccessToken(credentialsId: string, creds: DropboxCreds): Promise<DropboxCreds> {
    const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(`[DROPBOX] Token refresh failed: ${text}`);
      throw new Error('Dropbox token refresh failed');
    }

    const data = await response.json();
    const newCreds: DropboxCreds = {
      accessToken: data.access_token,
      refreshToken: creds.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    const encrypted = await encryptToken(JSON.stringify(newCreds), credentialsId);
    await getAutomationsQb(['external_service_credentials'])
      .updateTable('external_service_credentials')
      .set({ credentials: encrypted, updated_at: new Date() })
      .where('id', '=', credentialsId as ExternalServiceCredentialsId)
      .execute();
    logger.info('[DROPBOX] CREDENTIALS REFRESHED');

    return newCreds;
  }

  async getValidAccessToken(credentialsId: string, creds: DropboxCreds): Promise<string> {
    if (creds.expiresAt > Date.now() + 60_000) {
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
