// What the Resend door has to be able to tell apart.
//
// Every case here is one a real webhook endpoint meets: a genuine delivery, a
// forged one, a captured one replayed later, and a delivery signed during a
// secret rotation (two signatures, one of which is ours).

import { signResendWebhook } from '../../../../../scripts/dev/lib/resend-sign';
import { svixSignature, verifySvixSignature } from 'movement-engine/public/inbound';

const SECRET = 'whsec_ZGV2LWxvb3AtcmVzZW5kLXNlY3JldA==';
const BODY = '{"type":"email.received","data":{"email_id":"re_1"}}';
const NOW = 1_750_000_000_000;
const TIMESTAMP = String(NOW / 1000);

function headers(overrides: Partial<Record<'id' | 'timestamp' | 'signature', string>> = {}) {
  return {
    id: 'msg_1',
    timestamp: TIMESTAMP,
    signature: `v1,${svixSignature({ secret: SECRET, id: 'msg_1', timestamp: TIMESTAMP, body: BODY })}`,
    ...overrides,
  };
}

describe('believing a Resend delivery', () => {
  it('admits a correctly signed one', () => {
    expect(verifySvixSignature({ secret: SECRET, headers: headers(), body: BODY, now: NOW })).toBe(
      'verified',
    );
  });

  it('refuses a forged signature', () => {
    expect(
      verifySvixSignature({
        secret: SECRET,
        headers: headers({ signature: 'v1,bm90LWEtc2lnbmF0dXJl' }),
        body: BODY,
        now: NOW,
      }),
    ).toBe('bad-signature');
  });

  it('refuses a signature of a different length rather than throwing', () => {
    expect(
      verifySvixSignature({
        secret: SECRET,
        headers: headers({ signature: 'v1,c2hvcnQ=' }),
        body: BODY,
        now: NOW,
      }),
    ).toBe('bad-signature');
  });

  it('refuses a body that changed after signing', () => {
    expect(
      verifySvixSignature({ secret: SECRET, headers: headers(), body: `${BODY} `, now: NOW }),
    ).toBe('bad-signature');
  });

  it('refuses a delivery captured and replayed later', () => {
    expect(
      verifySvixSignature({
        secret: SECRET,
        headers: headers(),
        body: BODY,
        now: NOW + 10 * 60 * 1000,
      }),
    ).toBe('stale');
  });

  it('admits a delivery signed with two secrets when one of them is ours', () => {
    const ours = svixSignature({ secret: SECRET, id: 'msg_1', timestamp: TIMESTAMP, body: BODY });
    const theirs = svixSignature({
      secret: 'whsec_b3RoZXItc2VjcmV0',
      id: 'msg_1',
      timestamp: TIMESTAMP,
      body: BODY,
    });
    expect(
      verifySvixSignature({
        secret: SECRET,
        headers: headers({ signature: `v1,${theirs} v1,${ours}` }),
        body: BODY,
        now: NOW,
      }),
    ).toBe('verified');
  });

  it('refuses a delivery missing its headers altogether', () => {
    expect(
      verifySvixSignature({
        secret: SECRET,
        headers: { id: '', timestamp: '', signature: '' },
        body: BODY,
        now: NOW,
      }),
    ).toBe('malformed');
  });

  it('refuses a timestamp that is not a number', () => {
    expect(
      verifySvixSignature({
        secret: SECRET,
        headers: headers({ timestamp: 'yesterday' }),
        body: BODY,
        now: NOW,
      }),
    ).toBe('malformed');
  });
});

describe('the dev loop signs what the door verifies', () => {
  it('round-trips the injector’s signature', () => {
    const signed = signResendWebhook({ secret: SECRET, body: BODY, timestamp: TIMESTAMP });
    expect(
      verifySvixSignature({
        secret: SECRET,
        headers: {
          id: signed['svix-id'],
          timestamp: signed['svix-timestamp'],
          signature: signed['svix-signature'],
        },
        body: BODY,
        now: NOW,
      }),
    ).toBe('verified');
  });
});
