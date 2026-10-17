// The platform's Google Drive client for its own callers (the v3 pipeline
// outputs): the module's client (@lf/google-drive), with its token from the
// platform's google-auth-library client, which refreshes and writes the
// stored credential back itself. Same names and constructor as before Drive
// became a module, so those callers are unchanged.

import type { OAuth2Client } from 'google-auth-library';

import { GoogleDriveClient as ModuleDriveClient } from '@lf/google-drive/drive_client';

export { DRIVE_FOLDER_MIME, type DriveItem } from '@lf/google-drive/drive_client';

class GoogleDriveClient extends ModuleDriveClient {
  /** `baseUrl` is the test-harness redirect (fake-channels). */
  constructor(oauth2Client: OAuth2Client, options?: { baseUrl?: string }) {
    super({
      accessToken: async () => (await oauth2Client.getAccessToken()).token ?? '',
      fetch,
      ...(options?.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });
  }
}

export { GoogleDriveClient };
