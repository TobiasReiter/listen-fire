// `@lf/dropbox`: Dropbox as a module. The host hands it the install's OAuth
// credential — already refreshed, the host's job — and a fetch; the module
// builds a client per call from them, so a token refreshed between calls is
// read by the next one. `ctx.config.baseUrlOverride` (the dev loop's fake)
// wins over the credential's own base URL. Bytes a write carries are read
// through `ctx.files`; a file the module returns is a handle (a Dropbox
// path) the host redeems through `resolveFileRef`.

import { defineModule, type CredentialFields, type ModuleContext } from 'module-kit';

import { DropboxAdapter, type DropboxClientSource } from './adapter';
import { DropboxClient } from './api_client';
import { DROPBOX_MANIFEST, DROPBOX_OAUTH2 } from './manifest';

/** The client the context's credential reaches Dropbox with. */
export function dropboxClientFrom(ctx: ModuleContext): DropboxClientSource {
  // The client for the fields last read: a host hands back the same fields
  // until the credential changes, so one client serves until then.
  let last: { fields: CredentialFields; client: DropboxClient } | undefined;
  return async () => {
    const fields = await ctx.credential.fields();
    if (last?.fields === fields) return last.client;
    const accessToken = fields.access_token;
    if (accessToken === undefined || accessToken === '') {
      throw new Error('Dropbox: the connected credential holds no access token. Connect Dropbox.');
    }
    const baseUrl = ctx.config.baseUrlOverride ?? fields.baseUrl;
    const client = new DropboxClient(accessToken, { fetch: ctx.fetch, ...(baseUrl !== undefined && baseUrl !== '' ? { baseUrl } : {}) });
    last = { fields, client };
    return client;
  };
}

export const dropboxModule = defineModule({
  kind: 'adapter',
  name: '@lf/dropbox',
  manifest: DROPBOX_MANIFEST,
  // The stored payload the connect flow writes: `{ accessToken, refreshToken,
  // expiresAt }` (the host reads it as the protocol's token fields), and
  // `baseUrl` where the dev loop redirects it.
  credentials: [
    {
      name: 'dropbox',
      kind: 'oauth2',
      fields: [{ name: 'baseUrl', label: 'Base URL', secret: false, optional: true }],
      oauth2: DROPBOX_OAUTH2,
    },
  ],
  create: (ctx) => new DropboxAdapter({ client: dropboxClientFrom(ctx), files: ctx.files, log: ctx.log }),
});

export default dropboxModule;

export * from './adapter';
export * from './api_client';
export * from './manifest';
export * from './schema';
export * from './types';
