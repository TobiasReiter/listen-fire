// `@lf/granola`: Granola as a module. The host hands it the install's
// credential (an API key, and optionally a base URL) and a fetch; the module
// builds a client per call from them, so a credential edited between calls is
// read by the next one. `ctx.config.baseUrlOverride` (the dev loop's fake)
// wins over the credential's own base URL.

import { defineModule, type CredentialFields, type ModuleContext } from 'module-kit';

import { GranolaClient, granolaCredsParser } from './api_client';
import { GranolaAdapter, type GranolaClientSource } from './adapter';
import { GRANOLA_MANIFEST } from './manifest';
import { GRANOLA_POLL_INTERVAL_SECONDS, pollGranola } from './poll';

/** The client the context's credential reaches Granola with. */
export function granolaClientFrom(ctx: ModuleContext): GranolaClientSource {
  // The client for the fields last read: a host hands back the same fields
  // until the credential changes, so one client serves until then.
  let last: { fields: CredentialFields; client: GranolaClient } | undefined;
  return async () => {
    const fields = await ctx.credential.fields();
    if (last?.fields === fields) return last.client;
    const parsed = granolaCredsParser.safeParse(fields);
    if (!parsed.success) {
      throw new Error('Granola: the connected credential holds no API key. Connect Granola.');
    }
    const baseUrl = ctx.config.baseUrlOverride ?? parsed.data.baseUrl;
    const client = new GranolaClient({
      apiKey: parsed.data.apiKey,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      fetch: ctx.fetch,
      log: ctx.log,
    });
    last = { fields, client };
    return client;
  };
}

export const granolaModule = defineModule({
  kind: 'adapter',
  name: '@lf/granola',
  manifest: GRANOLA_MANIFEST,
  // The stored payload the connect form writes: `{ apiKey, baseUrl? }`.
  credentials: [
    {
      name: 'granola',
      kind: 'static',
      fields: [
        { name: 'apiKey', label: 'API key' },
        { name: 'baseUrl', label: 'Base URL', secret: false, optional: true },
      ],
    },
  ],
  poll: { intervalSeconds: GRANOLA_POLL_INTERVAL_SECONDS },
  create: (ctx) => {
    const client = granolaClientFrom(ctx);
    return Object.assign(new GranolaAdapter(client), {
      poll: async (input: Parameters<typeof pollGranola>[1]) => pollGranola(await client(), input),
    });
  },
});

export default granolaModule;

export * from './adapter';
export * from './api_client';
export * from './manifest';
export * from './poll';
export * from './types';
