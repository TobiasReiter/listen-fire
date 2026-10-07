// The public callback URL a webhook_subscription row receives events at.
//
// Stable per subscription ROW — and rows are keyed per (provider,
// credential), so the URL is the "stable per-(adapter, credential)
// subscription URL" listen reconciliation diff-syncs against
// (6_engine.md: keyed to the instance, not the listen, so reconciliation
// never changes inbound URLs). Dev / preview / prod each hit a different
// origin — `API_BASE_URL` carries the right one, and its absence is fatal
// rather than defaulted: this used to fall back to `https://example.com`, which
// pointed every third-party subscription at somebody else's deployment.

import { apiBaseUrl } from '../../lib/api_base_url';

export function buildWebhookTargetUrl(provider: string, subscriptionId: string): string {
  return `${apiBaseUrl()}/api/public/webhook-sync/${provider.toLowerCase()}/${subscriptionId}`;
}

/**
 * The `webhook_subscription.provider` key an adapter's deliveries route by: its
 * first trigger-kind alias, else its upper-cased slug. A remote install declares
 * no aliases, so it always takes the second branch — and the webhook door finds
 * the install again by the same rule.
 */
export function webhookProviderKey(manifest: { adapterType: string; triggerKinds?: readonly string[] }): string {
  return manifest.triggerKinds?.[0] ?? manifest.adapterType.toUpperCase();
}
