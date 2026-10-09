import type { WebhookProvider } from './interface';

import { attioProvider } from './attio';
import { airtableProvider } from './airtable';
import { affinityProvider } from './affinity';
import { nativeValuationsProvider } from './native_valuations';
import { NATIVE_KNOWLEDGE_PROVIDER_KEY, nativeKnowledgeProvider } from './native_knowledge';
import { slackProvider } from './slack';
import { telegramProvider } from './telegram';
import { whatsappProvider } from './whatsapp';

const providers: Record<string, WebhookProvider> = {
  ATTIO: attioProvider,
  AIRTABLE: airtableProvider,
  AFFINITY: affinityProvider,
  NATIVE_VALUATIONS: nativeValuationsProvider,
  // Keyed by the graph adapter's trigger-kind alias, not by its credential
  // type — the key IS what `resolveAdapterSlug` routes a delivery by.
  [NATIVE_KNOWLEDGE_PROVIDER_KEY]: nativeKnowledgeProvider,
  SLACK: slackProvider,
  TELEGRAM: telegramProvider,
  INBOUND_WHATSAPP: whatsappProvider,
};

function getWebhookProvider(provider: string): WebhookProvider | null {
  return providers[provider] ?? null;
}

/** List every registered provider with the UI-relevant metadata. The
 *  Settings page uses this to decide which integrations to offer as
 *  subscribable in the "Create subscription" modal. */
function listWebhookProviders(): {
  provider: string;
  canRegisterViaApi: boolean;
  defaultEventTypes: string[];
  setupInstructions: string | null;
}[] {
  return Object.entries(providers).map(([key, p]) => ({
    provider: key,
    canRegisterViaApi: p.canRegisterViaApi,
    defaultEventTypes: [...p.defaultEventTypes],
    setupInstructions: p.setupInstructions ?? null,
  }));
}

/** Surface the metadata the UI needs to render registration affordances
 *  without round-tripping into the provider object itself. */
function getWebhookProviderMeta(provider: string): {
  canRegisterViaApi: boolean;
  setupInstructions: string | null;
} | null {
  const p = providers[provider];
  if (!p) return null;
  return {
    canRegisterViaApi: p.canRegisterViaApi,
    setupInstructions: p.setupInstructions ?? null,
  };
}

export { getWebhookProvider, getWebhookProviderMeta, listWebhookProviders };
export type {
  WebhookProvider,
  WebhookEvent,
  WebhookRegistration,
} from './interface';
