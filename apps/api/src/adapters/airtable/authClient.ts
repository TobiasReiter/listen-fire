import { randomBytes, createHash } from 'node:crypto';

import { z } from 'zod';

import { logger } from 'movement-engine/services/logger';

const scopes = [
  'data.records:read',
  'data.records:write',
  'schema.bases:read',
  'user.email:read',
  'webhook:manage',
];

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
  private authCache: Record<string, string> = {};

  constructor({ clientId, clientSecret, redirectBaseUrl }: { clientId: string; clientSecret: string; redirectBaseUrl: string }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = `${redirectBaseUrl}/airtable/callback`;
  }

  async codeToToken({ state, code }: { state: string; code: string }) {
    const codeVerifier = this.authCache[state];
    if (!codeVerifier) {
      throw new Error('Invalid state parameter value');
    }

    delete this.authCache[state];

    const tokenUrl = new URL('/oauth2/v1/token', 'https://airtable.com');
    const response = await fetch(tokenUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: this.callbackUrl,
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

    const authUrl = new URL('/oauth2/v1/authorize', 'https://airtable.com');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('client_id', this.clientId);
    authUrl.searchParams.set('redirect_uri', this.callbackUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes.join(' '));
    return authUrl.toString();
  }
}

export { AirtableAuthClient };
