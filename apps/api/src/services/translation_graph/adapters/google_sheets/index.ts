// Google Sheets' legacy line: the module's adapter (@lf/google-sheets) over
// the credential path the platform used before modules (client.ts) and the
// grants table. Kept so the `BUILTIN_MODULES` line for Google Sheets can go
// back to `legacy` in one edit while the module line is new; remove it with
// the line once the module line has soaked.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { GoogleSheetsApiClient } from '../../../../adapters/googleSheets/apiClient';

import { GoogleSheetsAdapter } from '@listen-fire/google-sheets';
import { logger } from 'movement-engine/public/log';
import { grantedItemsKv } from '../../../credentials/granted_items';
import { resolveGoogleSheetsClient } from './client';

export { GOOGLE_SHEETS_ADAPTER_TYPE, GOOGLE_SHEETS_MANIFEST, GoogleSheetsAdapter } from '@listen-fire/google-sheets';

export function createGoogleSheetsAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
  /** The `spreadsheet:` construction arg — a granted spreadsheet's Title to
   *  start the instance at (optional; default position is the meta node). */
  spreadsheet?: string;
}): GoogleSheetsAdapter {
  const { credentialsId } = input;
  if (!credentialsId) {
    throw new Error(
      'Google Sheets adapter requires credentialsId — wire pipeline_output.credentials_id (out-flow) through getAdapter.',
    );
  }
  // One client per adapter, built on first use and kept once built, as before.
  let client: GoogleSheetsApiClient | undefined;
  return new GoogleSheetsAdapter({
    client: async () => (client ??= await resolveGoogleSheetsClient({ teamId: input.teamId, credentialsId })),
    kv: grantedItemsKv(credentialsId, { teamId: input.teamId }),
    log: logger,
    tenant: input.teamId,
    ...(input.spreadsheet !== undefined ? { spreadsheet: input.spreadsheet } : {}),
  });
}
