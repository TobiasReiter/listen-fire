// `@lf/google-sheets`: Google Sheets as a module. The host hands it the
// install's Google credential (an OAuth token it keeps fresh: the module never
// refreshes), a fetch, its kv (the spreadsheets the user granted, and the
// team's emails a created spreadsheet is shared with) and the
// `spreadsheet:` construction argument. `ctx.config.baseUrlOverride` (the dev
// loop's fake) replaces Google's own URLs.

import { defineModule, type CredentialFields, type ModuleContext } from 'module-kit';

import { GoogleSheetsAdapter, type GoogleSheetsClientSource } from './adapter';
import { GoogleSheetsApiClient } from './api_client';
import { GOOGLE_DRIVE_FILE_CREDENTIAL } from './google_oauth';
import { GOOGLE_SHEETS_MANIFEST } from './manifest';

/** The client the context's credential reaches Google Sheets with. */
export function googleSheetsClientFrom(ctx: ModuleContext): GoogleSheetsClientSource {
  // The client for the fields last read: a host hands back the same fields
  // until the credential changes (a refresh), so one client serves until then.
  let last: { fields: CredentialFields; client: GoogleSheetsApiClient } | undefined;
  return async () => {
    const fields = await ctx.credential.fields();
    if (last?.fields === fields) return last.client;
    const token = fields.access_token;
    if (token === undefined || token === '') {
      throw new Error('Google Sheets: the connected credential holds no access token. Connect Google Sheets.');
    }
    const client = new GoogleSheetsApiClient({
      accessToken: async () => token,
      fetch: ctx.fetch,
      ...(ctx.config.baseUrlOverride !== undefined ? { baseUrl: ctx.config.baseUrlOverride } : {}),
    });
    last = { fields, client };
    return client;
  };
}

export const googleSheetsModule = defineModule({
  kind: 'adapter',
  name: '@lf/google-sheets',
  manifest: GOOGLE_SHEETS_MANIFEST,
  credentials: [GOOGLE_DRIVE_FILE_CREDENTIAL],
  create: (ctx) => {
    const spreadsheet = ctx.config.constructionArgs.spreadsheet;
    return new GoogleSheetsAdapter({
      client: googleSheetsClientFrom(ctx),
      kv: ctx.kv,
      log: ctx.log,
      tenant: ctx.config.tenant,
      ...(spreadsheet !== undefined ? { spreadsheet } : {}),
    });
  },
});

export default googleSheetsModule;

export * from './adapter';
export * from './api_client';
export * from './google_oauth';
export * from './grants';
export * from './manifest';
export * from './types';
