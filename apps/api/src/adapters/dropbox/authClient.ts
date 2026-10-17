import { z } from 'zod';
import { DROPBOX_OAUTH2 } from '@lf/dropbox/manifest';
import { logger } from 'movement-engine/services/logger';
import {
  createOAuth2Connector,
  createSecretsFamily,
  expiresWithin,
  OAuth2ExchangeFailed,
  oauth2Refresher,
  type OAuth2Connector,
  type OAuth2Declaration,
  type Refresher,
  type SecretFields,
} from 'movement-engine/public/secrets';

import { camelTokenPayloadShape, postgresSecrets } from '../../services/credentials/secrets_postgres';

const REFRESH_WINDOW_MS = 60_000;

/** How a Dropbox credential is connected and refreshed: what Dropbox's module
 *  manifest declares. */
export const dropboxOAuth2: OAuth2Declaration = DROPBOX_OAUTH2;

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

const dropboxIssuedTokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number(),
});

export class DropboxAuthClient {
  private readonly connector: OAuth2Connector;
  private clientId: string;
  private clientSecret: string;
  private readonly oauth2: OAuth2Declaration;
  readonly callbackUrl: string;

  /** `fakeBaseUrl` points both OAuth endpoints at the dev loop's fake OAuth
   *  provider, so the real exchange and refresh run with nothing mocked. */
  constructor({ clientId, clientSecret, redirectBaseUrl, fakeBaseUrl }: {
    clientId: string;
    clientSecret: string;
    redirectBaseUrl: string;
    fakeBaseUrl?: string;
  }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    const fakeBase = fakeBaseUrl?.replace(/\/$/, '');
    this.oauth2 = fakeBase === undefined
      ? dropboxOAuth2
      : { ...dropboxOAuth2, authorizeUrl: `${fakeBase}/oauth/authorize`, tokenUrl: `${fakeBase}/oauth/token` };
    this.callbackUrl = `${redirectBaseUrl}/dropbox/callback`;
    this.connector = createOAuth2Connector({ oauth2: this.oauth2, client: { clientId, clientSecret }, redirectUri: this.callbackUrl });
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
        refresher: this.refresher(),
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

  /** The refresh-token grant for this app, at the token URL it connects to
   *  (the dev loop's fake provider in the dev loop). */
  refresher(): Refresher {
    return oauth2Refresher({
      tokenUrl: this.oauth2.tokenUrl,
      clientAuth: this.oauth2.clientAuth,
      client: { clientId: this.clientId, clientSecret: this.clientSecret },
    });
  }

  async getValidAccessToken(credentialsId: string, creds: DropboxCreds): Promise<string> {
    if (creds.expiresAt > Date.now() + REFRESH_WINDOW_MS) {
      return creds.accessToken;
    }
    const refreshed = await this.refreshAccessToken(credentialsId, creds);
    return refreshed.accessToken;
  }

  async codeToToken({ state, code }: { state: string; code: string }): Promise<DropboxCreds> {
    let data: Readonly<Record<string, unknown>>;
    try {
      data = (await this.connector.complete({ state, code })).response;
    } catch (error) {
      if (!(error instanceof OAuth2ExchangeFailed)) throw error;
      logger.error(`[DROPBOX] Token exchange failed: ${error.message}`);
      throw new Error('Invalid token received');
    }

    const issued = dropboxIssuedTokens.safeParse(data);
    if (!issued.success) {
      logger.error('[DROPBOX] Token exchange answered without a refresh token');
      throw new Error('Invalid token received');
    }

    return {
      accessToken: issued.data.access_token,
      refreshToken: issued.data.refresh_token,
      expiresAt: Date.now() + issued.data.expires_in * 1000,
    };
  }

  generateInstallUrl(): string {
    return this.connector.begin();
  }
}
