// The protocol's own webhook signature: hex HMAC-SHA256 of the raw body, keyed
// by the secret the remote's `ensureEventSubscription` returned.

import { createHmac } from 'node:crypto';

import { UNREGISTERED_SECRET, verifyRemoteSignature } from 'movement-engine/services/webhook_sync/remote_inbound';

const BODY = Buffer.from('{"companies":[{"id":"co-1","Name":"Acme"}]}');
const sign = (secret: string, body: Buffer = BODY) => createHmac('sha256', secret).update(body).digest('hex');

describe('verifyRemoteSignature', () => {
  it('accepts the body signed with the subscription secret', () => {
    expect(verifyRemoteSignature(BODY, sign('whsec'), 'whsec')).toBe(true);
  });

  it('refuses another secret, a tampered body, and a malformed header', () => {
    expect(verifyRemoteSignature(BODY, sign('other'), 'whsec')).toBe(false);
    expect(verifyRemoteSignature(Buffer.from('{}'), sign('whsec'), 'whsec')).toBe(false);
    expect(verifyRemoteSignature(BODY, 'not-hex', 'whsec')).toBe(false);
    expect(verifyRemoteSignature(BODY, '', 'whsec')).toBe(false);
  });

  it('never verifies against a subscription whose registration returned no secret', () => {
    expect(verifyRemoteSignature(BODY, sign(UNREGISTERED_SECRET), UNREGISTERED_SECRET)).toBe(false);
    expect(verifyRemoteSignature(BODY, sign(''), '')).toBe(false);
    expect(verifyRemoteSignature(BODY, sign('x'), null)).toBe(false);
  });
});
