// The system surface's original caller: an API key holding the `system` scope.
//
// The key is not checked here. The host's own authentication has already
// verified it (or the static secret) and made its owner the request's principal,
// which is what the tenant routes on the surface act as; this verifier reads
// only the verdict, so the behaviour is exactly the scope gate it replaced.

import { SYSTEM_ACTIONS, type SystemCallerVerifier } from './verifier';

const SYSTEM_SCOPE = 'system';

const apiKeyVerifier: SystemCallerVerifier = {
  name: 'api_key',
  async verify({ hostCredential }) {
    // `'*'` grants everything: the Principal contract's own wording (require_scope.ts).
    // No key at all (a session) gets the same answer the scope gate gave it.
    if (!hostCredential?.scopes.some((granted) => granted === SYSTEM_SCOPE || granted === '*')) {
      return { ok: false, reason: `API key missing required scope: ${SYSTEM_SCOPE}` };
    }
    return {
      ok: true,
      principal: { id: hostCredential.id === undefined ? 'api_key' : `api_key:${hostCredential.id}` },
      actions: SYSTEM_ACTIONS,
    };
  },
};

export { apiKeyVerifier };
