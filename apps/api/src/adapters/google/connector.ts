import { z } from 'zod';
import { Request, Response } from 'express';

import { GoogleConnector } from './interface';
import { logger } from 'movement-engine/public/log';
import { storePendingCredentials } from '../../lib/pendingCredentials';
import { getFlowUserId } from '../../lib/oauthFlows';
import { resolveOAuthCallbackRedirect } from '../../lib/oauthCallbackRedirect';
import { GoogleAuthClient, googleCredsParser } from './authClient';
import { GoogleSheetsApiClient, TableInfo } from '../googleSheets/apiClient';

class GoogleAppAdapter implements GoogleConnector {
  authClient: GoogleAuthClient;

  constructor({ authClient }: { authClient: GoogleAuthClient }) {
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
      res.status(401).send('Error authorizing Google connection');
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

  async generateInstallUrl(): Promise<string> {
    return this.authClient.generateInstallUrl();
  }

  async listSheets({
    spreadsheetId,
    id,
    credentials,
  }: {
    spreadsheetId: string;
    id: string;
    credentials: z.infer<typeof googleCredsParser>;
  }): Promise<{ name: string; id: number }[]> {
    const sheetsApiClient = new GoogleSheetsApiClient(id, credentials);
    const sheets = await sheetsApiClient.listSheets({ spreadsheetId });
    return sheets.map((sheet: { title: string; sheetId: number }) => ({
      name: sheet.title,
      id: sheet.sheetId,
    }));
  }

  async listTables({
    spreadsheetId,
    id,
    credentials,
  }: {
    spreadsheetId: string;
    id: string;
    credentials: z.infer<typeof googleCredsParser>;
  }): Promise<TableInfo[]> {
    const sheetsApiClient = new GoogleSheetsApiClient(id, credentials);
    return sheetsApiClient.listTables({ spreadsheetId });
  }
}

export { GoogleAppAdapter };
