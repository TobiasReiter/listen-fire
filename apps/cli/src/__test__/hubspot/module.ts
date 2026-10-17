// A HubSpot-like module for the Alice/Bob acceptance, served as a separately
// run process (serve-module): one install, whose server secret (MODULE_TOKEN)
// signs every call, and one declared OAuth 2 credential, `oauth`, that each
// connection fills with one user's account. Every read and write goes to the
// provider with the access token of the credential the call carries, so the
// provider sees who it was made as. The module never refreshes: the host does,
// with its own OAuth app, and hands the next call the new token.
//
// The provider is reached at ctx.config.baseUrlOverride (MODULE_BASE_URL_OVERRIDE);
// its token endpoint is declared from HUBSPOT_PROVIDER_URL, read once at load,
// since a declaration is data the host acts on before any call.

import type { Adapter, RelatedResult } from 'movement-engine/public/adapter';

import { BASE_RUNTIME_CAPABILITIES } from 'movement-engine/public/adapter';
import { defineModule, type AdapterModuleMethods, type ModuleContext } from 'module-kit/define';

const PROVIDER = process.env.HUBSPOT_PROVIDER_URL ?? 'https://api.hubapi.com';
const DEAL = 'Deal';
const DEAL_CREATED = 'deal.created';

const MANIFEST = {
  adapterType: 'hubspot',
  displayName: 'HubSpot',
  description: 'Deals, read and written as the connection’s own HubSpot user.',
  supportedTriggers: ['webhook'] as const,
  subscribableEvents: [DEAL_CREATED],
  methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'listEventTypes'],
};

interface Deal {
  id: string;
  Name: string;
}

async function provider(ctx: ModuleContext, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const { access_token: token } = await ctx.credential.fields();
  const response = await ctx.fetch(`${ctx.config.baseUrlOverride ?? PROVIDER}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!response.ok) throw new Error(`HubSpot answered ${response.status}`);
  return response.json();
}

function hubspot(ctx: ModuleContext): AdapterModuleMethods {
  const adapter: Adapter = {
    adapterType: 'hubspot',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [
      { typeId: DEAL, displayName: DEAL, scope: 'self-configured', readable: false, writable: true, fires: true, description: 'A deal.' },
    ],
    describe: async (typeId) =>
      typeId === DEAL
        ? {
            typeId: DEAL,
            displayName: DEAL,
            fields: [{ fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: true }],
            references: [],
          }
        : null,
    resolveEntity: async () => ({ candidates: [] }),
    // A read is the provider's, as the connection's user: the deal as THEY see it.
    getFieldValue: async ({ position, fieldId }) => {
      if (position.identity.kind !== 'stable') return null;
      const deal = (await provider(ctx, `/deals/${position.identity.recordId}`)) as Deal;
      return fieldId === 'Name' ? deal.Name : null;
    },
    getRelated: async (): Promise<RelatedResult[]> => [],
    createRecord: async ({ recordType, fields }) => {
      const deal = (await provider(ctx, '/deals', { method: 'POST', body: { Name: fields.Name } })) as Deal;
      return { adapterType: 'hubspot', externalId: deal.id, recordType, data: { Name: deal.Name } };
    },
    updateRecord: async () => {
      throw new Error('hubspot (test module) does not update');
    },
    deleteRecord: async () => {
      throw new Error('hubspot (test module) does not delete');
    },
    listEventTypes: async () => [{ tag: DEAL_CREATED, positionType: DEAL }],
  };
  return adapter;
}

export function dealCreatedEvent(deal: Deal): Record<string, unknown> {
  return { payload: deal, externalId: deal.id, tag: DEAL_CREATED, eventType: DEAL_CREATED, changeType: 'create', recordType: DEAL };
}

export default defineModule({
  kind: 'adapter',
  name: '@acme/hubspot',
  manifest: MANIFEST,
  credentials: [
    {
      name: 'oauth',
      kind: 'oauth2',
      fields: [],
      oauth2: { authorizeUrl: `${PROVIDER}/oauth/authorize`, tokenUrl: `${PROVIDER}/oauth/token` },
    },
  ],
  create: hubspot,
});
