// `@lf/airtable`: Airtable as a module. The host hands it the install's OAuth
// credential (the protocol's token fields, optionally a base URL), a fetch and
// its files; the module builds one client per instance over them. The host
// refreshes the token: before a call by its expiry, and — where it can (the
// platform) — when Airtable refuses it. `ctx.config.baseUrlOverride` (the dev
// loop's fake) wins over the credential's own base URL; the `base:`
// construction argument scopes the instance to one base. Deliveries carry
// Airtable's MAC, keyed with the secret the webhook was created with; the host
// refuses one with no secret or a bad MAC.

import { defineModule, type CredentialFields, type ModuleContext } from 'module-kit';

import { AirtableAdapter } from './adapter';
import { AirtableAPIClient } from './api_client';
import { AIRTABLE_MANIFEST } from './manifest';
import { airtableOAuth2 } from './oauth';

function tokenOf(fields: CredentialFields): string {
  const token = fields.access_token;
  if (token === undefined || token === '') {
    throw new Error('Airtable: the connected credential holds no access token. Connect Airtable again.');
  }
  return token;
}

/** The client the context's credential reaches Airtable with. */
export function airtableClientFrom(ctx: ModuleContext): () => Promise<AirtableAPIClient> {
  let client: AirtableAPIClient | undefined;
  return async () => {
    if (client !== undefined) return client;
    const fields = await ctx.credential.fields();
    tokenOf(fields);
    const baseUrl = ctx.config.baseUrlOverride ?? fields.baseUrl;
    client = new AirtableAPIClient({
      ...(baseUrl !== undefined && baseUrl !== '' ? { baseUrl } : {}),
      fetch: ctx.fetch,
      tokens: {
        accessToken: async () => tokenOf(await ctx.credential.fields()),
        refresh: async () => {
          if (ctx.credential.refresh === undefined) {
            throw new Error('Airtable refused the token, and this host refreshes it only before a call (by its expiry)');
          }
          await ctx.credential.refresh();
        },
      },
    });
    return client;
  };
}

export const airtableModule = defineModule({
  kind: 'adapter',
  name: '@lf/airtable',
  manifest: AIRTABLE_MANIFEST,
  credentials: [
    {
      name: 'airtable',
      kind: 'oauth2',
      oauth2: airtableOAuth2,
      fields: [{ name: 'baseUrl', label: 'Base URL', secret: false, optional: true }],
    },
  ],
  // Today's provider key and header chain, so every registered webhook URL and
  // every valid MAC keeps working.
  inbound: {
    providerKey: 'airtable',
    scheme: 'airtable_mac',
    signatureHeaders: ['attio-signature', 'x-attio-signature', 'x-airtable-content-mac', 'x-webhook-signature'],
    // Airtable issues each webhook's MAC secret when it is registered.
    secretIssuedBy: 'provider',
  },
  create: (ctx) => {
    const base = ctx.config.constructionArgs.base;
    return new AirtableAdapter({
      tenant: ctx.config.tenant,
      client: airtableClientFrom(ctx),
      files: ctx.files,
      ...(base !== undefined ? { base } : {}),
    });
  },
});

export default airtableModule;

export * from './adapter';
export * from './api_client';
export * from './manifest';
export * from './oauth';
export * from './record';
export * from './schema_catalog';
export * from './types';
export * from './webhook';
