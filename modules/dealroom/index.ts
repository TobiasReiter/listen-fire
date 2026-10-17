// `@lf/dealroom`: Dealroom as a module. The host hands it the install's
// credential (an API key, and optionally a base URL) and a fetch; the module
// builds a client per call from them, so a credential edited between calls is
// read by the next one. `ctx.config.baseUrlOverride` (the dev loop's fake)
// wins over the credential's own base URL.

import { defineModule, type CredentialFields, type ModuleContext } from 'module-kit';

import { DealroomApiClient, dealroomCredsParser } from './api_client';
import { DealroomAdapter, type DealroomClientSource } from './adapter';
import { DEALROOM_MANIFEST } from './manifest';
import { DEALROOM_POLL_INTERVAL_SECONDS, pollDealroom } from './poll';

/** The client the context's credential reaches Dealroom with. */
export function dealroomClientFrom(ctx: ModuleContext): DealroomClientSource {
  // The client for the fields last read: a host hands back the same fields
  // until the credential changes, so one client serves until then.
  let last: { fields: CredentialFields; client: DealroomApiClient } | undefined;
  return async () => {
    const fields = await ctx.credential.fields();
    if (last?.fields === fields) return last.client;
    const parsed = dealroomCredsParser.safeParse(fields);
    if (!parsed.success) {
      throw new Error('Dealroom: the connected credential holds no API key. Connect Dealroom.');
    }
    const baseUrl = ctx.config.baseUrlOverride ?? parsed.data.baseUrl;
    const client = new DealroomApiClient({
      apiKey: parsed.data.apiKey,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      fetch: ctx.fetch,
      log: ctx.log,
    });
    last = { fields, client };
    return client;
  };
}

export const dealroomModule = defineModule({
  kind: 'adapter',
  name: '@lf/dealroom',
  manifest: DEALROOM_MANIFEST,
  // The stored payload the connect form writes: `{ apiKey, baseUrl? }`.
  credentials: [
    {
      name: 'dealroom',
      kind: 'static',
      fields: [
        { name: 'apiKey', label: 'API key' },
        { name: 'baseUrl', label: 'Base URL', secret: false, optional: true },
      ],
    },
  ],
  poll: { intervalSeconds: DEALROOM_POLL_INTERVAL_SECONDS },
  create: (ctx) => {
    const client = dealroomClientFrom(ctx);
    return Object.assign(new DealroomAdapter(client), {
      poll: async (input: Parameters<typeof pollDealroom>[1]) => pollDealroom(await client(), input),
    });
  },
});

export default dealroomModule;

export * from './adapter';
export * from './api_client';
export * from './filter';
export * from './manifest';
export * from './poll';
export * from './schema';
export * from './types';
