// The Gmail OAuth connector — the callback half of signing in as a mailbox.
//
// It mirrors the Sheets/Drive connector beside it (adapters/google/connector.ts)
// and rides the same pending-credentials + redirect machinery, with one thing
// added: the sign-in's own mailbox. The user picked which Google account to
// sign in as, and `users.getProfile` is what tells us WHICH — the address is
// never typed, so it can never be typed wrong, and the allowlist is checked
// against what Google says rather than against a claim.

import { Request, Response } from 'express';
import { google } from 'googleapis';

import { logger } from 'movement-engine/public/log';
import { storePendingCredentials } from '../../lib/pendingCredentials';
import { getFlowUserId } from '../../lib/oauthFlows';
import { resolveOAuthCallbackRedirect } from '../../lib/oauthCallbackRedirect';
import {
  GMAIL_OAUTH_NOT_ALLOWED_PREFIX,
  checkGmailMailboxAllowed,
  gmailProfileSchema,
  type GmailOAuthCredentials,
} from './apiClient';
import { GmailAuthClient, gmailTokenClient, type GmailTokens } from './authClient';

class GmailAppAdapter {
  readonly authClient: GmailAuthClient;

  constructor({ authClient }: { authClient: GmailAuthClient }) {
    this.authClient = authClient;
  }

  async generateInstallUrl(): Promise<string> {
    return this.authClient.generateInstallUrl();
  }

  async handleCallback(req: Request, res: Response): Promise<void> {
    const state = req.query.state;
    if (typeof state !== 'string') {
      res.status(401).send('Invalid state parameter');
      return;
    }
    if (req.query.error) {
      logger.error({ error: req.query.error });
      res.status(401).send('Error authorizing Gmail connection');
      return;
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';

    try {
      const userId = getFlowUserId(state);
      if (!userId) {
        res.status(401).send('Unknown OAuth flow');
        return;
      }

      const granted = await this.authClient.codeToToken({ state, code });
      const mailbox = await this.signedInMailbox(granted);

      const allowed = checkGmailMailboxAllowed(mailbox, { method: 'oauth' });
      if (!allowed.ok) {
        // Nothing is stored: a sign-in this installation will not act on must
        // leave no credential behind, and the user needs to read WHY on the
        // page rather than discover it in a run.
        res.status(403).send(`${GMAIL_OAUTH_NOT_ALLOWED_PREFIX}${allowed.message}`);
        return;
      }

      const credentials: Omit<GmailOAuthCredentials, 'baseUrl'> = {
        mailbox,
        accessToken: granted.accessToken,
        refreshToken: granted.refreshToken,
        expiresAt: granted.expiresAt,
        grantedScopes: granted.grantedScopes,
      };
      const claimToken = await storePendingCredentials(credentials, userId);

      res.redirect(
        resolveOAuthCallbackRedirect({
          state,
          claimToken,
          callbackUrl: this.authClient.callbackUrl,
        }),
      );
    } catch (e) {
      logger.error(e);
      res.status(401).end();
    }
  }

  /** Which mailbox just signed in. Asked of Gmail with the fresh token, before
   *  any row exists — so there is nothing yet for a rotation to be saved to,
   *  and none is expected within the second this call takes. */
  private async signedInMailbox(tokens: GmailTokens): Promise<string> {
    const fake = this.authClient.fakeBaseUrl;
    const api = google.gmail({
      version: 'v1',
      auth: gmailTokenClient({
        tokens,
        ...(fake !== undefined ? { fakeBaseUrl: fake } : {}),
      }),
      ...(fake !== undefined ? { rootUrl: fake } : {}),
    });
    const { data } = await api.users.getProfile({ userId: 'me' });
    return gmailProfileSchema.parse(data).emailAddress;
  }
}

export { GmailAppAdapter };
