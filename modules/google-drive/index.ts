// `@lf/google-drive`: Google Drive as a module. The host hands it the
// install's Google credential (an OAuth token it keeps fresh: the module never
// refreshes), a fetch, its kv (the Drive items the user granted) and its
// files (the bytes of a file a write is handed without a url).
// `ctx.config.baseUrlOverride` (the dev loop's fake) replaces Google's root
// URL. googleapis builds the requests; gaxios sends them through `ctx.fetch`.

import { defineModule, readHandedFile, type CredentialFields, type ModuleContext } from 'module-kit';
import { GOOGLE_DRIVE_FILE_CREDENTIAL } from '@lf/google-sheets/google_oauth';

import { GoogleDriveAdapter, type GoogleDriveClientSource } from './adapter';
import { GoogleDriveClient } from './drive_client';
import { GOOGLE_DRIVE_MANIFEST } from './manifest';

/** The client the context's credential reaches Google Drive with. */
export function googleDriveClientFrom(ctx: ModuleContext): GoogleDriveClientSource {
  // The client for the fields last read: a host hands back the same fields
  // until the credential changes (a refresh), so one client serves until then.
  let last: { fields: CredentialFields; client: GoogleDriveClient } | undefined;
  return async () => {
    const fields = await ctx.credential.fields();
    if (last?.fields === fields) return last.client;
    const token = fields.access_token;
    if (token === undefined || token === '') {
      throw new Error('Google Drive: the connected credential holds no access token. Connect Google Drive.');
    }
    const client = new GoogleDriveClient({
      accessToken: async () => token,
      fetch: ctx.fetch,
      ...(ctx.config.baseUrlOverride !== undefined ? { baseUrl: ctx.config.baseUrlOverride } : {}),
    });
    last = { fields, client };
    return client;
  };
}

export const googleDriveModule = defineModule({
  kind: 'adapter',
  name: '@lf/google-drive',
  manifest: GOOGLE_DRIVE_MANIFEST,
  credentials: [GOOGLE_DRIVE_FILE_CREDENTIAL],
  create: (ctx) =>
    new GoogleDriveAdapter({
      client: googleDriveClientFrom(ctx),
      kv: ctx.kv,
      readFile: (ref) => readHandedFile(ctx, ref),
      log: ctx.log,
    }),
});

export default googleDriveModule;

export * from './adapter';
export * from './drive_client';
export * from './grants';
export * from './manifest';
export * from './types';
