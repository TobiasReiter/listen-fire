import { z } from 'zod';
import { logger } from 'movement-engine/public/log';
import { createOAuth2Connector, OAuth2ExchangeFailed, type OAuth2Connector } from 'movement-engine/public/secrets';
import { attioOAuth2 } from '@listen-fire/attio/oauth';

/** How an Attio credential is connected: the declaration Attio's module
 *  manifest makes. */
export { attioOAuth2 } from '@listen-fire/attio/oauth';

const attioTokenResponseSchema = z.object({
  access_token: z.string(),
});

// Available attribute options
// text, number, checkbox, currency, date, timestamp, rating, status, select, record-reference, actor-reference, location, domain, email-address, phone-number, interaction, personal-name

class AttioAuthClient {
  readonly callbackUrl: string;
  private readonly connector: OAuth2Connector;

  constructor({ clientId, clientSecret, redirectBaseUrl }: { clientId: string; clientSecret: string; redirectBaseUrl: string }) {
    this.callbackUrl = `${redirectBaseUrl}/attio/callback`;
    this.connector = createOAuth2Connector({ oauth2: attioOAuth2, client: { clientId, clientSecret }, redirectUri: this.callbackUrl });
  }

  async codeToToken({ state, code }: { state: string; code: string }) {
    try {
      const grant = await this.connector.complete({ state, code });
      return { accessToken: attioTokenResponseSchema.parse(grant.response).access_token };
    } catch (error) {
      if (!(error instanceof OAuth2ExchangeFailed)) throw error;
      logger.error({ msg: 'Attio token exchange failed', status: error.status, detail: error.message, sent: { redirect_uri: this.callbackUrl } });
      throw new Error('Error retrieving access token');
    }
  }

  async generateInstallUrl(): Promise<string> {
    return this.connector.begin();
  }
}

export { AttioAuthClient };
