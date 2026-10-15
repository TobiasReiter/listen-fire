import { z } from 'zod';
import { Request, Response } from 'express';

import { AirtableConnector } from './interface';
import { logger } from 'movement-engine/services/logger';
import { storePendingCredentials } from '../../lib/pendingCredentials';
import { getFlowUserId } from '../../lib/oauthFlows';
import { resolveOAuthCallbackRedirect } from '../../lib/oauthCallbackRedirect';
import { AirtableAuthClient } from './authClient';
import { airtableCredsParser, getAirtableClient } from './apiClient';

class AirtableAppAdapter implements AirtableConnector {
  authClient: AirtableAuthClient;

  constructor({ authClient }: { authClient: AirtableAuthClient }) {
    this.authClient = authClient;
  }

  async handleCallback(req: Request, res: Response): Promise<void> {
    const state = req.query.state;
    if (typeof state !== 'string') {
      res.status(401).send('Invalid state parameter');
      return;
    }

    if (req.query.error) {
      const error = req.query.error;
      const errorDescription = req.query.error_description;
      logger.error({ error, errorDescription });
      res.status(401).send('Error authorizing Airtable connection');
      return;
    }

    const code = req.query.code as string;

    try {
      const userId = getFlowUserId(state);
      if (!userId) {
        res.status(401).send('Unknown OAuth flow');
        return;
      }
      const tokenResult = await this.authClient.codeToToken({ state, code });
      const claimToken = await storePendingCredentials({
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        accessTokenExpiresAt: new Date(Date.now() + tokenResult.expiresIn * 1000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + tokenResult.refreshExpiresIn * 1000).toISOString(),
      }, userId);

      res.redirect(
        resolveOAuthCallbackRedirect({ state, claimToken, callbackUrl: this.authClient.callbackUrl }),
      );
    } catch (e) {
      logger.error(e);
      res.status(401).end();
    }
  }

  async generateInstallUrl(): Promise<string> {
    return this.authClient.generateInstallUrl();
  }

  async getApiClient(id: string, creds: z.infer<typeof airtableCredsParser>) {
    return getAirtableClient(id, creds);
  }
}

export { AirtableAppAdapter };
