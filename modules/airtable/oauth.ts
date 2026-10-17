// How an Airtable credential is connected: the authorize and token endpoints,
// the scopes, the client in an HTTP Basic header, PKCE required. The module's
// manifest declares it, and the platform's connect flow uses the same one.

import type { OAuth2Declaration } from 'movement-engine/public/secrets';

export const airtableOAuth2: OAuth2Declaration = {
  authorizeUrl: 'https://airtable.com/oauth2/v1/authorize',
  tokenUrl: 'https://airtable.com/oauth2/v1/token',
  scopes: ['data.records:read', 'data.records:write', 'schema.bases:read', 'user.email:read', 'webhook:manage'],
  clientAuth: 'basic',
  pkce: true,
};
