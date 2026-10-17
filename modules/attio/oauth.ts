// How an Attio credential is connected: the authorize and token endpoints,
// the client in the form body, no PKCE. The module's manifest declares it,
// and the platform's connect flow uses the same one.

import type { OAuth2Declaration } from 'movement-engine/public/secrets';

export const attioOAuth2: OAuth2Declaration = {
  authorizeUrl: 'https://app.attio.com/authorize',
  tokenUrl: 'https://app.attio.com/oauth/token',
  clientAuth: 'body',
};
