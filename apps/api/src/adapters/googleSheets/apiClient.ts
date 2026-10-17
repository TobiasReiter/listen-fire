// The platform's Google Sheets client for its own callers (the connect flow's
// listing, the v3 pipeline outputs, the legacy adapter line): the module's
// client (@lf/google-sheets), with its token from the platform's
// google-auth-library client, which refreshes and writes the stored
// credential back itself. Same names and constructor as before Sheets became
// a module, so those callers are unchanged.

import type { z } from 'zod';
import type { GoogleSheetsClientOptions } from '@listen-fire/google-sheets';

import { GoogleSheetsApiClient as ModuleSheetsClient } from '@listen-fire/google-sheets';
import { logger } from 'movement-engine/public/log';

import { googleCredsParser } from '../google/authClient';
import { services } from '../registry';

export { sheetsFetchWithRetry, type TableColumnInfo, type TableInfo, type TableRange } from '@listen-fire/google-sheets';

type StoredGoogleCreds = z.infer<typeof googleCredsParser> & { baseUrl?: string };

function platformClientOptions(id: string, creds: StoredGoogleCreds): GoogleSheetsClientOptions {
  if (!services.google) {
    throw new Error('Google integrations not configured');
  }
  const oauth2Client = services.google.authClient.getGoogleClient(id, creds);
  const clientCreds = oauth2Client.credentials;
  logger.info(`[GOOGLE_SHEETS] Client created for ${id}`, {
    hasAccessToken: !!clientCreds.access_token,
    hasRefreshToken: !!clientCreds.refresh_token,
    refreshTokenType: typeof clientCreds.refresh_token,
    expiryDate: clientCreds.expiry_date,
  });
  return {
    accessToken: async () => (await oauth2Client.getAccessToken()).token ?? '',
    fetch,
    ...(creds.baseUrl !== undefined ? { baseUrl: creds.baseUrl } : {}),
  };
}

class GoogleSheetsApiClient extends ModuleSheetsClient {
  constructor(id: string, creds: StoredGoogleCreds) {
    super(platformClientOptions(id, creds));
  }
}

export { GoogleSheetsApiClient };
