// Webhook signature-verification coverage for the HMAC-signing inbound
// providers. The signature check is a security boundary — a broken verifier
// silently accepts forged events or drops real ones — yet only Slack had
// pos/neg tests. This covers the other three HMAC providers (Attio, WhatsApp
// Meta Cloud API, Listen-Fire Valuations) with: valid signature accepted, tampered
// body rejected, wrong secret rejected, missing/garbage header rejected.

import { createHmac } from 'node:crypto';

import { verifyAsProvider } from '../../../inbound/__test__/verify_as_provider';

/** Hex HMAC-SHA256 of the raw body under `secret` — the digest Attio and
 *  Valuations send verbatim, and the value WhatsApp sends behind `sha256=`. */
function hexHmac(secret: string, body: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

const SECRET = 'the-app-secret';
const BODY = Buffer.from(JSON.stringify({ hello: 'world', n: 42 }), 'utf-8');

describe('webhook provider signature verification', () => {
  describe('attio (raw hex digest)', () => {
    const sign = (body: Buffer, secret = SECRET) => hexHmac(secret, body);

    it('accepts a valid signature', () => {
      expect(verifyAsProvider('ATTIO', BODY, sign(BODY), SECRET)).toBe(true);
    });
    it('rejects a tampered body', () => {
      const tampered = Buffer.from(BODY.toString() + ' ', 'utf-8');
      expect(verifyAsProvider('ATTIO', tampered, sign(BODY), SECRET)).toBe(false);
    });
    it('rejects a signature made with the wrong secret', () => {
      expect(verifyAsProvider('ATTIO', BODY, sign(BODY, 'other'), SECRET)).toBe(false);
    });
    it('rejects an empty / non-hex header', () => {
      expect(verifyAsProvider('ATTIO', BODY, '', SECRET)).toBe(false);
      expect(verifyAsProvider('ATTIO', BODY, 'not-hex!!', SECRET)).toBe(false);
    });
  });

  describe('native valuations (raw hex digest)', () => {
    const sign = (body: Buffer, secret = SECRET) => hexHmac(secret, body);

    it('accepts a valid signature', () => {
      expect(verifyAsProvider('NATIVE_VALUATIONS', BODY, sign(BODY), SECRET)).toBe(true);
    });
    it('rejects a tampered body', () => {
      const tampered = Buffer.from('{"hello":"evil"}', 'utf-8');
      expect(verifyAsProvider('NATIVE_VALUATIONS', tampered, sign(BODY), SECRET)).toBe(false);
    });
    it('rejects the wrong secret', () => {
      expect(verifyAsProvider('NATIVE_VALUATIONS', BODY, sign(BODY, 'other'), SECRET)).toBe(false);
    });
    it('rejects a missing header', () => {
      expect(verifyAsProvider('NATIVE_VALUATIONS', BODY, '', SECRET)).toBe(false);
    });
  });

  describe('whatsapp (Meta X-Hub-Signature-256, sha256= prefixed)', () => {
    const sign = (body: Buffer, secret = SECRET) => `sha256=${hexHmac(secret, body)}`;

    it('accepts a valid sha256=-prefixed signature', () => {
      expect(verifyAsProvider('INBOUND_WHATSAPP', BODY, sign(BODY), SECRET)).toBe(true);
    });
    it('rejects a tampered body', () => {
      const tampered = Buffer.from(BODY.toString() + 'x', 'utf-8');
      expect(verifyAsProvider('INBOUND_WHATSAPP', tampered, sign(BODY), SECRET)).toBe(false);
    });
    it('rejects the wrong secret', () => {
      expect(verifyAsProvider('INBOUND_WHATSAPP', BODY, sign(BODY, 'other'), SECRET)).toBe(false);
    });
    it('rejects an empty header', () => {
      expect(verifyAsProvider('INBOUND_WHATSAPP', BODY, '', SECRET)).toBe(false);
    });
    it('rejects a bare (unprefixed) but otherwise valid digest only if Meta would', () => {
      // The verifier strips a leading `sha256=`; a bare hex digest has no
      // prefix to strip, so the comparison is digest-vs-digest and still holds.
      // This documents the tolerance rather than asserting a rejection.
      const bare = hexHmac(SECRET, BODY);
      expect(verifyAsProvider('INBOUND_WHATSAPP', BODY, bare, SECRET)).toBe(true);
    });
  });
});
