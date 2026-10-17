// How every Google credential is connected and refreshed: Google's OAuth
// endpoints, the offline-consent parameters that make it issue a refresh
// token, and the declaration Sheets and Drive share (`drive.file`, so a user
// grants files one at a time through the Picker). Gmail declares its own
// scopes over the same endpoints. Data only, so the platform's connect flow
// and every Google module read one copy.

import type { WireCredentialDeclarationShape } from 'engine-contracts';
import type { OAuth2Declaration } from 'movement-engine/public/secrets';

/** Google's OAuth endpoints, shared by every Google credential. */
export const GOOGLE_OAUTH2_ENDPOINTS = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
} as const;

/** `access_type=offline` with `prompt=consent` is what makes Google issue a
 *  refresh token on every connect, not only on an account's first grant. */
export const GOOGLE_OFFLINE_CONSENT = { access_type: 'offline', prompt: 'consent' } as const;

/** The scope Sheets and Drive connect with: only the files the user grants. */
export const GOOGLE_DRIVE_FILE_SCOPES = ['https://www.googleapis.com/auth/drive.file'] as const;

/** How a Google (Sheets and Drive) credential is connected. The client goes
 *  in the form body. */
export const GOOGLE_DRIVE_FILE_OAUTH2: OAuth2Declaration = {
  ...GOOGLE_OAUTH2_ENDPOINTS,
  scopes: [...GOOGLE_DRIVE_FILE_SCOPES],
  clientAuth: 'body',
  pkce: true,
  authorizeParams: { ...GOOGLE_OFFLINE_CONSENT },
};

/** The credential Sheets and Drive declare: a Google OAuth token, stored by
 *  the connect flow; the module reads `access_token` per call and never
 *  refreshes (the host does). */
export const GOOGLE_DRIVE_FILE_CREDENTIAL: WireCredentialDeclarationShape = {
  name: 'google',
  kind: 'oauth2',
  fields: [],
  oauth2: GOOGLE_DRIVE_FILE_OAUTH2,
};
