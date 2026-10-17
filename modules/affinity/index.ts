// `@lf/affinity`: Affinity as a module. The host hands it the install's
// credential (an API key, optionally a base URL and the account's webhook
// signature key), a fetch, its files and its models; the module builds one
// client per key, so the workspace's cached shape is shared by every install
// on that key. `ctx.config.baseUrlOverride` (the dev loop's fake) wins over
// the credential's own base URL. Deliveries are signed with the account's
// webhook signature key; the host refuses one with no key or a bad signature.

import { defineModule, type ModuleContext } from 'module-kit';

import { AffinityAdapter } from './adapter';
import { affinityCredsParser, getAffinityClient, type AffinityAPIClient } from './api_client';
import { AFFINITY_MANIFEST } from './manifest';

/** The client the context's credential reaches Affinity with. */
export function affinityClientFrom(ctx: ModuleContext): () => Promise<AffinityAPIClient> {
  return async () => {
    const parsed = affinityCredsParser.safeParse(await ctx.credential.fields());
    if (!parsed.success) {
      throw new Error(`Affinity: the connected credential is malformed (${parsed.error.message}). Connect Affinity again.`);
    }
    return getAffinityClient(parsed.data.apiKey, ctx.config.baseUrlOverride ?? parsed.data.baseUrl);
  };
}

export const affinityModule = defineModule({
  kind: 'adapter',
  name: '@lf/affinity',
  manifest: AFFINITY_MANIFEST,
  // The stored payload the connect form writes.
  credentials: [
    {
      name: 'affinity',
      kind: 'static',
      fields: [
        { name: 'apiKey', label: 'API key' },
        { name: 'baseUrl', label: 'Base URL', secret: false, optional: true },
        { name: 'webhookSignatureKey', label: 'Webhook signature key', optional: true },
      ],
    },
  ],
  // Today's provider key and header chain, so every registered webhook URL and
  // every valid signature keeps working.
  inbound: {
    providerKey: 'affinity',
    scheme: 'affinity_hex_or_b64',
    signatureHeaders: ['x-affinity-webhook-signature', 'x-affinity-signature', 'x-signature', 'x-webhook-signature'],
  },
  create: (ctx) =>
    new AffinityAdapter({
      tenant: ctx.config.tenant,
      client: affinityClientFrom(ctx),
      models: ctx.models,
      files: ctx.files,
      fetch: ctx.fetch,
    }),
});

export default affinityModule;

export * from './adapter';
export * from './api_client';
export * from './common';
export * from './employer_association';
export * from './field_configuration';
export * from './inbound';
export * from './manifest';
export * from './operations';
export * from './shared';
export * from './types';
export * from './write_failures';
