import { Request, Response } from 'express';

import { logger } from '../../services/logger';
import { storePendingCredentials } from '../../lib/pendingCredentials';
import { getFlowUserId } from '../../lib/oauthFlows';
import { resolveOAuthCallbackRedirect } from '../../lib/oauthCallbackRedirect';
import { DropboxAuthClient } from './authClient';

export class DropboxAppAdapter {
  authClient: DropboxAuthClient;

  constructor({ authClient }: { authClient: DropboxAuthClient }) {
    this.authClient = authClient;
  }

  async handleCallback(req: Request, res: Response): Promise<void> {
    const state = req.query.state;
    if (typeof state !== 'string') {
      res.status(401).send('Invalid state parameter');
      return;
    }

    if (req.query.error) {
      logger.error({ error: req.query.error });
      res.status(401).send('Error authorizing Dropbox connection');
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
      const claimToken = await storePendingCredentials(tokenResult, userId);

      res.redirect(
        resolveOAuthCallbackRedirect({ state, claimToken, callbackUrl: this.authClient.callbackUrl }),
      );
    } catch (e) {
      logger.error(e);
      res.status(401).end();
    }
  }

  generateInstallUrl(): string {
    return this.authClient.generateInstallUrl();
  }
}
