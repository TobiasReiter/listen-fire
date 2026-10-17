// The Slack Web API client: `@slack/web-api`'s WebClient pointed at the
// install's base URL (Slack, or the dev loop's fake), with a short cache on
// the reads a busy workspace repeats (the user and channel lookups every
// inbound message makes). One client per token and base URL per process.
//
// The platform's installer and its v3 output agent use the same client
// (apps/api adapters/slack/webApi re-exports it).

import { z } from 'zod';
import { WebAPICallResult, WebClient } from '@slack/web-api';

const MINUTE = 60_000;

const slackCredsParser = z.object({
  accessToken: z.string(),
  teamId: z.string().optional(),
  enterpriseId: z.string().optional(),
  baseUrl: z.string().url().optional(),
});

class WebClientWithCache extends WebClient {
  private cache: Record<string, unknown> = {};
  private ttlMap: Record<string, number> = {
    'users.list': 1 * MINUTE,
    'conversations.info': 1 * MINUTE,
    'conversations.members': 1 * MINUTE,
    // Sender-email resolution (`users.info`) runs on every inbound message the
    // shared movements bot processes; profiles/emails are stable, so a 5-minute
    // cache collapses repeated lookups of the same user to one call per window.
    'users.info': 5 * MINUTE,
  };

  async apiCall(...args: Parameters<WebClient['apiCall']>) {
    const [method] = args;
    const ttl = this.ttlMap[method];
    const key = ttl ? JSON.stringify(args) : undefined;
    if (ttl && key) {
      if (this.cache[key]) {
        return this.cache[key] as WebAPICallResult;
      }
    }

    const result = await super.apiCall(...args);

    if (ttl && key) {
      this.cache[key] = result;
      setTimeout(() => {
        delete this.cache[key];
      }, ttl);
    }

    return result;
  }
}

class SlackAPIClient {
  api: WebClient;

  constructor({ token, baseUrl }: { token: string; baseUrl?: string }) {
    this.api = new WebClientWithCache(token, { slackApiUrl: baseUrl });
  }

  async fetch(url: string | URL, init?: RequestInit) {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.api.token}`,
        ...init?.headers,
      },
    });

    return response;
  }
}

const webClientsByAccessToken: Record<string, SlackAPIClient> = {};

const getSlackClient = (token: string, baseUrl?: string): SlackAPIClient => {
  const cacheKey = baseUrl ? `${token}:${baseUrl}` : token;
  if (!webClientsByAccessToken[cacheKey]) {
    webClientsByAccessToken[cacheKey] = new SlackAPIClient({ token, baseUrl });
  }

  return webClientsByAccessToken[cacheKey];
};

export { SlackAPIClient, getSlackClient, slackCredsParser };
