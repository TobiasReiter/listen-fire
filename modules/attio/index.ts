// `@lf/attio`: Attio as a module. The host hands it the install's OAuth
// credential (the protocol's access token, optionally a base URL), a fetch and
// its files; the module builds one client per token, so a workspace's cached
// attributes are shared by every install on that token. Attio's tokens do not
// expire. `ctx.config.baseUrlOverride` (the dev loop's fake) wins over the
// credential's own base URL. Deliveries are signed with the secret Attio
// issued for the webhook; the host refuses one with no secret or a bad
// signature.

import { defineModule, type ModuleContext } from 'module-kit';

import { AttioAdapter } from './adapter';
import { getAttioClient, type AttioAPIClient } from './api_client';
import { ATTIO_MANIFEST } from './manifest';
import { attioOAuth2 } from './oauth';

/** The client the context's credential reaches Attio with. */
export function attioClientFrom(ctx: ModuleContext): () => Promise<AttioAPIClient> {
  return async () => {
    const fields = await ctx.credential.fields();
    const token = fields.access_token;
    if (token === undefined || token === '') {
      throw new Error('Attio: the connected credential holds no access token. Connect Attio again.');
    }
    const baseUrl = ctx.config.baseUrlOverride ?? fields.baseUrl;
    return getAttioClient(token, baseUrl === '' ? undefined : baseUrl);
  };
}

export const attioModule = defineModule({
  kind: 'adapter',
  name: '@lf/attio',
  manifest: ATTIO_MANIFEST,
  credentials: [
    {
      name: 'attio',
      kind: 'oauth2',
      oauth2: attioOAuth2,
      fields: [
        { name: 'baseUrl', label: 'Base URL', secret: false, optional: true },
        // The id of the API token Attio assigns to the access token, captured
        // at connect; a delivery caused by our own write carries it as actor.
        { name: 'apiTokenId', label: 'API token id', secret: false, optional: true },
      ],
    },
  ],
  // Today's provider key and header chain, so every registered webhook URL and
  // every valid signature keeps working.
  inbound: {
    providerKey: 'attio',
    scheme: 'attio',
    signatureHeaders: ['attio-signature', 'x-attio-signature', 'x-airtable-content-mac', 'x-webhook-signature'],
  },
  create: (ctx) =>
    new AttioAdapter({ tenant: ctx.config.tenant, client: attioClientFrom(ctx), files: ctx.files, fetch: ctx.fetch }),
});

export default attioModule;

export * from './adapter';
export * from './api_client';
export * from './attributes';
export * from './field_rejections';
export * from './manifest';
export * from './oauth';
export * from './types';
