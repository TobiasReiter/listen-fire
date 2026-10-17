import { z } from 'zod';
import { logger } from 'movement-engine/services/logger';
import { createOAuth2Connector, OAuth2ExchangeFailed, type OAuth2Connector, type OAuth2Declaration } from 'movement-engine/public/secrets';

const scopes = [
  'data.records:read',
  'data.records:write',
  'schema.bases:read',
  'user.email:read',
  'webhook:manage',
];

/** How an Airtable credential is connected: what Airtable's module manifest
 *  will declare. The client goes in an HTTP Basic header; PKCE is required. */
export const airtableOAuth2: OAuth2Declaration = {
  authorizeUrl: 'https://airtable.com/oauth2/v1/authorize',
  tokenUrl: 'https://airtable.com/oauth2/v1/token',
  scopes,
  clientAuth: 'basic',
  pkce: true,
};

const airtableTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  refresh_expires_in: z.number(),
});

class AirtableAuthClient {
  private clientId: string;
  private clientSecret: string;
  readonly callbackUrl: string;
  private readonly connector: OAuth2Connector;

  constructor({ clientId, clientSecret, redirectBaseUrl }: { clientId: string; clientSecret: string; redirectBaseUrl: string }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = `${redirectBaseUrl}/airtable/callback`;
    this.connector = createOAuth2Connector({ oauth2: airtableOAuth2, client: { clientId, clientSecret }, redirectUri: this.callbackUrl });
  }

  async codeToToken({ state, code }: { state: string; code: string }) {
    let response: Readonly<Record<string, unknown>>;
    try {
      response = (await this.connector.complete({ state, code })).response;
    } catch (error) {
      if (!(error instanceof OAuth2ExchangeFailed)) throw error;
      logger.error(error.message);
      throw new Error('Error retrieving access token');
    }

    const body = airtableTokenResponseSchema.parse(response);

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
      refreshExpiresIn: body.refresh_expires_in,
    };
  }

  async exchangeRefreshToken({ refreshToken }: { refreshToken: string }) {
    const tokenUrl = new URL('/oauth2/v1/token', 'https://airtable.com');
    const response = await fetch(tokenUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    });

    const json = await response.json();
    if (!response.ok) {
      logger.error(json);
      throw new Error('Error retrieving access token');
    }

    const body = airtableTokenResponseSchema.parse(json);

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
      refreshExpiresIn: body.refresh_expires_in,
    };
  }

  async generateInstallUrl(): Promise<string> {
    return this.connector.begin();
  }
}

export { AirtableAuthClient };
