// Which verifier a built-in subscription gets: the host's signed-inbound rule,
// except a grandfathered subscription with no usable secret, which keeps its
// door's old leniency.

import { createHmac } from 'node:crypto';

import { UNREGISTERED_SECRET, declaredInboundVerifier, verifyInbound, type InboundVerifier } from 'movement-engine/public/inbound';

import { LEGACY_SIGNATURE_HEADERS, builtInVerifierFor } from '../legacy_signature_headers';

const BODY = Buffer.from('{}');
const declaredFor = (providerKey: string): InboundVerifier => {
  const legacy = LEGACY_SIGNATURE_HEADERS[providerKey];
  if (legacy === undefined || !('scheme' in legacy)) throw new Error('no declared scheme');
  return declaredInboundVerifier(legacy);
};
const signedWith = (key: string) => ({ 'attio-signature': createHmac('sha256', key).update(BODY).digest('hex') });

describe('builtInVerifierFor', () => {
  it('keeps the old door for a grandfathered subscription with no usable secret', () => {
    for (const secret of ['', '  ', UNREGISTERED_SECRET]) {
      expect(builtInVerifierFor({ providerKey: 'ATTIO', secret, grandfatheredUnsigned: true, declared: declaredFor('ATTIO') })).toBe(
        LEGACY_SIGNATURE_HEADERS.ATTIO,
      );
    }
  });

  it('holds a grandfathered subscription to the new rule once its secret is set', () => {
    const declared = declaredFor('ATTIO');
    expect(builtInVerifierFor({ providerKey: 'ATTIO', secret: 'real', grandfatheredUnsigned: true, declared })).toBe(declared);
  });

  it('holds a new subscription to the new rule, secret or none', () => {
    const declared = declaredFor('AFFINITY');
    for (const secret of ['', 'real']) {
      expect(builtInVerifierFor({ providerKey: 'AFFINITY', secret, grandfatheredUnsigned: false, declared })).toBe(declared);
    }
  });

  it('falls back to the frozen table when no module declares the inbound', () => {
    expect(builtInVerifierFor({ providerKey: 'SLACK', secret: '', grandfatheredUnsigned: true, declared: undefined })).toBe(
      LEGACY_SIGNATURE_HEADERS.SLACK,
    );
    expect(builtInVerifierFor({ providerKey: 'NOPE', secret: 'x', grandfatheredUnsigned: false, declared: undefined })).toBeUndefined();
  });

  it('accepts an empty-key Attio delivery only for a grandfathered subscription', () => {
    const declared = declaredFor('ATTIO');
    const headers = signedWith('');
    const grandfathered = builtInVerifierFor({ providerKey: 'ATTIO', secret: '', grandfatheredUnsigned: true, declared });
    const fresh = builtInVerifierFor({ providerKey: 'ATTIO', secret: '', grandfatheredUnsigned: false, declared });
    expect(grandfathered && verifyInbound(grandfathered, { rawBody: BODY, headers, secret: '' })).toBe(true);
    expect(fresh && verifyInbound(fresh, { rawBody: BODY, headers, secret: '' })).toBe(false);
  });
});
