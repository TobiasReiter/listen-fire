import { Request, Response } from 'express';
import { InstallProvider } from '@slack/oauth';

import { SlackConnector } from '../interface';
import { storePendingCredentials } from '../../../lib/pendingCredentials';
import { getFlowUserId } from '../../../lib/oauthFlows';
import { resolveOAuthCallbackRedirect } from '../../../lib/oauthCallbackRedirect';
import { getSlackClient } from './apiClient';
import { SlackWebApiConfigurer } from './configurer';
import { logger } from 'movement-engine/services/logger';

// Coalesce concurrent requests for the same OAuth code — React strict mode
// double-mounts the callback page, causing two simultaneous exchange attempts.
const inflightExchanges = new Map<string, Promise<string>>();

class SlackWebApiConnector implements SlackConnector {
  private installer: InstallProvider;
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor({
    clientId,
    clientSecret,
    stateSecret,
    redirectUri,
  }: {
    clientId: string;
    clientSecret: string;
    stateSecret: string;
    redirectUri: string;
  }) {
    this.installer = new InstallProvider({
      clientId,
      clientSecret,
      stateSecret,
      legacyStateVerification: true,
    });
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
  }

  async handleCallback(request: Request, response: Response) {
    const code = request.query.code;
    if (typeof code !== 'string') {
      logger.error('[SLACK] Missing code parameter');
      response.status(400).json({ error: 'Missing code parameter' });
      return;
    }

    const state = request.query.state;
    if (typeof state !== 'string') {
      logger.error('[SLACK] Missing state parameter');
      response.status(401).json({ error: 'Missing state parameter' });
      return;
    }

    const userId = getFlowUserId(state);
    if (!userId) {
      logger.error('[SLACK] Unknown OAuth flow — state not found or expired');
      response.status(401).json({ error: 'Unknown OAuth flow' });
      return;
    }

    try {
      let exchangePromise = inflightExchanges.get(code);
      if (!exchangePromise) {
        exchangePromise = this.exchangeCode(code, userId);
        inflightExchanges.set(code, exchangePromise);
        exchangePromise.finally(() => setTimeout(() => inflightExchanges.delete(code), 30_000));
      }

      const claimToken = await exchangePromise;

      response.redirect(
        resolveOAuthCallbackRedirect({ state, claimToken, callbackUrl: this.redirectUri }),
      );
    } catch (e) {
      logger.error('[SLACK] OAuth callback failed', e);
      response.status(500).json({ error: 'OAuth callback failed' });
    }
  }

  private async exchangeCode(code: string, userId: string): Promise<string> {
    logger.info('[SLACK] Exchanging code for token');

    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
    });

    const slackRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const data = await slackRes.json();
    if (!data.ok) {
      logger.error('[SLACK] Token exchange failed', { error: data.error });
      throw new Error(`Slack token exchange failed: ${data.error}`);
    }

    return storePendingCredentials({
      accessToken: data.access_token,
      teamId: data.team?.id,
      enterpriseId: data.enterprise?.id,
    }, userId);
  }

  async generateInstallUrl() {
    const installUrl = await this.installer.generateInstallUrl({
      scopes: [
        'app_mentions:read',
        'channels:history',
        'channels:join',
        'channels:read',
        'chat:write',
        'commands',
        'files:read',
        'files:write',
        'groups:history',
        'groups:read',
        'reactions:read',
        'reactions:write',
        'users:read',
        'users:read.email',
      ],
      redirectUri: this.redirectUri,
    });

    return installUrl;
  }

  async getConfigurer(token: string, baseUrl?: string) {
    const client = await getSlackClient(token, baseUrl);
    return new SlackWebApiConfigurer({ client });
  }
}

export { SlackWebApiConnector };
