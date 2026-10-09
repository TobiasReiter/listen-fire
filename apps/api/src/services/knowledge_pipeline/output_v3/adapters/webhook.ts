import type { V3Adapter, V3AdapterExecuteInput, AdapterResult } from './types';

import { logger } from '../../../logger';

interface WebhookV3Config {
  url: string;
  method: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  auth?: {
    type: 'none' | 'bearer' | 'basic' | 'api_key';
    token?: string;
    username?: string;
    password?: string;
    apiKey?: string;
    headerName?: string;
  };
}

function createWebhookV3Adapter(webhookConfig: WebhookV3Config): V3Adapter {
  return {
    async execute(input: V3AdapterExecuteInput): Promise<AdapterResult> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...webhookConfig.headers,
      };

      if (webhookConfig.auth && webhookConfig.auth.type !== 'none') {
        const authHeader = buildAuthHeader(webhookConfig.auth);
        if (authHeader) {
          if (webhookConfig.auth.type === 'api_key' && webhookConfig.auth.headerName) {
            headers[webhookConfig.auth.headerName] = authHeader;
          } else {
            headers['Authorization'] = authHeader;
          }
        }
      }

      const response = await fetch(webhookConfig.url, {
        method: webhookConfig.method,
        headers,
        body: JSON.stringify(input.fieldValues),
      });

      if (!response.ok) {
        logger.error('Webhook v3: request failed', { status: response.status, url: webhookConfig.url });
        throw new Error(`Webhook request failed with status ${response.status}`);
      }

      return {};
    },
  };
}

function buildAuthHeader(auth: NonNullable<WebhookV3Config['auth']>): string | null {
  if (auth.type === 'bearer') return `Bearer ${auth.token}`;
  if (auth.type === 'basic') return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  if (auth.type === 'api_key') return auth.apiKey ?? null;
  return null;
}

export { createWebhookV3Adapter };
export type { WebhookV3Config };
