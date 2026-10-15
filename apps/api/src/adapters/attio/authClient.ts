import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { logger } from 'movement-engine/services/logger';

const attioTokenResponseSchema = z.object({
  access_token: z.string(),
});

// Available attribute options
// text, number, checkbox, currency, date, timestamp, rating, status, select, record-reference, actor-reference, location, domain, email-address, phone-number, interaction, personal-name

class AttioAuthClient {
  private clientId: string;
  private clientSecret: string;
  readonly callbackUrl: string;
  private authCache: Record<string, string> = {};

  constructor({ clientId, clientSecret, redirectBaseUrl }: { clientId: string; clientSecret: string; redirectBaseUrl: string }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = `${redirectBaseUrl}/attio/callback`;
  }

  async codeToToken({ state, code }: { state: string; code: string }) {
    const codeVerifier = this.authCache[state];
    if (!codeVerifier) {
      throw new Error('Invalid state parameter value');
    }

    delete this.authCache[state];

    const tokenUrl = new URL('/oauth/token', 'https://app.attio.com');
    const response = await fetch(tokenUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.callbackUrl,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      logger.error({
        msg: 'Attio token exchange failed',
        status: response.status,
        statusText: response.statusText,
        body: raw,
        sent: { grant_type: 'authorization_code', redirect_uri: this.callbackUrl, client_id: this.clientId, hasSecret: !!this.clientSecret },
      });
      throw new Error('Error retrieving access token');
    }

    const body = attioTokenResponseSchema.parse(JSON.parse(raw));

    return {
      accessToken: body.access_token,
    };
  }

  async generateInstallUrl(): Promise<string> {
    const state = randomBytes(100).toString('base64url');
    const codeVerifier = randomBytes(96).toString('base64url');

    this.authCache[state] = codeVerifier;
    setTimeout(
      () => {
        delete this.authCache[state];
      },
      1000 * 60 * 15,
    ); // 15 minutes

    const authUrl = new URL('/authorize', 'https://app.attio.com');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('client_id', this.clientId);
    authUrl.searchParams.set('redirect_uri', this.callbackUrl);
    authUrl.searchParams.set('response_type', 'code');
    return authUrl.toString();
  }
}

export { AttioAuthClient };
