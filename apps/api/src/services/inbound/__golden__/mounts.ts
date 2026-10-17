// The two snapshots that sit beside the request corpus: where each inbound
// door is mounted, and the URL each provider key is told to call back.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Router } from 'express';

import { adapterDoorsRouter } from '../../../interfaces/rest/adapterDoors';
import { asksRouter } from '../../../interfaces/rest/asks';
import { callbacksRouter } from '../../../interfaces/rest/callbacks';
import { slackEventsRouter } from '../../../interfaces/rest/slackEvents';
import { slackInteractivityRouter } from '../../../interfaces/rest/slackInteractivity';
import { telegramBuiltinRouter } from '../../../interfaces/rest/telegramBuiltin';
import { webhookSyncRouter } from '../../../interfaces/rest/webhookSync';
import { whatsappRouter } from '../../../interfaces/rest/whatsapp';
import { webhooksRouter as valuationsWebhooksRouter } from '../../../interfaces/rest/v1/valuations/webhooks';
import { listWebhookProviders } from '../../webhook_sync/providers';
import { buildWebhookTargetUrl, webhookProviderKey } from '../../webhook_sync/urls';
import { listAdapterManifests } from '../../translation_graph/adapters/registry';

const SRC = join(__dirname, '..', '..', '..');

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name: string;
  handle: { stack?: Layer[] };
}

function routesOf(router: Router): string[] {
  const out: string[] = [];
  for (const layer of (router as unknown as { stack: Layer[] }).stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods).sort()) out.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return out.sort();
}

/** Each mounted router's own route table, keyed by the path server.ts mounts it at. */
export function routerTables(): Record<string, string[]> {
  return {
    '/api/public/webhook-sync': routesOf(webhookSyncRouter),
    '/api/public/adapter': routesOf(adapterDoorsRouter),
    '/api/public/telegram': routesOf(telegramBuiltinRouter),
    '/api/public/slack': routesOf(slackEventsRouter),
    '/api/public/slack-actions': routesOf(slackInteractivityRouter),
    '/api/public/whatsapp': routesOf(whatsappRouter),
    '/api/cb': routesOf(callbacksRouter),
    '/api/asks': routesOf(asksRouter),
    '/api/v1/valuations/webhooks': routesOf(valuationsWebhooksRouter),
  };
}

const INBOUND_LINE = /(webhook-sync|\/adapter'|\/telegram'|\/slack'|slack-actions|\/resend|\/api\/cb|\/api\/asks|whatsapp|mailgun|resend\/callback|valuations\/webhooks|'\/webhook'|'\/api', privateRouter|'\/api\/public', publicRouter|\/v1\/valuations|webhooksRouter|'\/mailgun')/;

/** The lines of server.ts and rest/index.ts that mount an inbound door, as
 *  written: the path, the parser in front of it, and the router behind it. */
export function mountLines(): Record<string, string[]> {
  const pick = (file: string): string[] =>
    readFileSync(join(SRC, file), 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(app|publicRouter|privateRouter|authRouter|valuationsRouter|webhookRouter)\.(use|get|post)\(/.test(line) || /^if \(mounts\('[a-z]+'\)\) (publicRouter|privateRouter)\./.test(line))
      .filter((line) => INBOUND_LINE.test(line));
  return {
    'server.ts': pick('server.ts'),
    'interfaces/rest/index.ts': pick('interfaces/rest/index.ts'),
    'interfaces/rest/v1/valuations/index.ts': pick('interfaces/rest/v1/valuations/index.ts'),
    'interfaces/rest/webhooks/index.ts': pick('interfaces/rest/webhooks/index.ts'),
  };
}

/** The callback URL for every provider key a subscription can carry: the
 *  registered webhook providers, and the key each registered adapter's
 *  deliveries route by. */
export function targetUrls(): { providerKeys: Record<string, string>; adapterKeys: Record<string, { providerKey: string; url: string }> } {
  const providerKeys: Record<string, string> = {};
  for (const { provider } of listWebhookProviders()) providerKeys[provider] = buildWebhookTargetUrl(provider, 'SUBSCRIPTION-ID');
  providerKeys['ACME-CRM (a remote install)'] = buildWebhookTargetUrl(webhookProviderKey({ adapterType: 'acme-crm' }), 'SUBSCRIPTION-ID');

  const adapterKeys: Record<string, { providerKey: string; url: string }> = {};
  for (const manifest of listAdapterManifests()) {
    if (!manifest) continue;
    const providerKey = webhookProviderKey(manifest);
    adapterKeys[manifest.adapterType] = { providerKey, url: buildWebhookTargetUrl(providerKey, 'SUBSCRIPTION-ID') };
  }
  return { providerKeys, adapterKeys };
}
