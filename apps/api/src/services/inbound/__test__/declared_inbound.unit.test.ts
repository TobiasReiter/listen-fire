// The host's one rule for an inbound a module's manifest declares signed
// (Henry 2026-10-17): whatever the scheme, a delivery is refused when its key
// is missing, blank or the placeholder, and when its signature is wrong; a
// right signature under a real key is let in. The built-in doors' frozen
// table keeps its leniencies; they never reach a declared module.

import { createHmac } from 'node:crypto';

import { INBOUND_SIGNATURE_SCHEMES, type WireInboundSignatureSchemeShape } from 'engine-contracts';
import {
  SCHEME_DEFAULT_HEADERS,
  SLACK_TIMESTAMP_HEADER,
  UNREGISTERED_SECRET,
  declaredInboundVerifier,
  isUsableInboundSecret,
  verifyInbound,
  verifyWithScheme,
  type InboundHeaders,
} from 'movement-engine/public/inbound';

const BODY = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf-8');
const hex = (key: string | Buffer, data: Buffer | string = BODY) => createHmac('sha256', key).update(data).digest('hex');

/** The headers a provider sends for `body` under `secret`, per scheme. */
function signed(scheme: WireInboundSignatureSchemeShape, secret: string): InboundHeaders {
  const [header] = SCHEME_DEFAULT_HEADERS[scheme];
  switch (scheme) {
    case 'hmac_sha256_hex':
      return { [header]: `sha256=${hex(secret)}` };
    case 'attio':
    case 'affinity_hex_or_b64':
    case 'remote':
      return { [header]: hex(secret) };
    case 'airtable_mac':
      return { [header]: `hmac-sha256=${hex(Buffer.from(secret, 'base64'))}` };
    case 'slack_v0':
      return { [SLACK_TIMESTAMP_HEADER]: '1700000000', [header]: `v0=${hex(secret, `v0:1700000000:${BODY.toString('utf-8')}`)}` };
    case 'telegram_secret_token':
      return { [header]: secret };
  }
}

const SECRET = Buffer.from('a-real-signing-key').toString('base64');
/** Another key, base64 too, so Airtable's decode does not fold it into SECRET. */
const WRONG = Buffer.from('somebody-elses-key').toString('base64');

describe('a declared signed inbound', () => {
  for (const scheme of INBOUND_SIGNATURE_SCHEMES) {
    describe(scheme, () => {
      const verifier = declaredInboundVerifier({ scheme, signatureHeaders: SCHEME_DEFAULT_HEADERS[scheme] });

      it('lets in a right signature under a real key', () => {
        expect(verifyInbound(verifier, { rawBody: BODY, headers: signed(scheme, SECRET), secret: SECRET })).toBe(true);
      });

      it('refuses a wrong signature', () => {
        expect(verifyInbound(verifier, { rawBody: BODY, headers: signed(scheme, WRONG), secret: SECRET })).toBe(false);
        expect(verifyInbound(verifier, { rawBody: BODY, headers: {}, secret: SECRET })).toBe(false);
      });

      it('refuses an empty, blank or placeholder key, even signed with that key', () => {
        for (const key of ['', '   ', UNREGISTERED_SECRET]) {
          expect(verifyInbound(verifier, { rawBody: BODY, headers: signed(scheme, key), secret: key })).toBe(false);
        }
      });
    });
  }

  it('is stricter than the doors that predate it, which keep their leniency', () => {
    // An empty key verifies under the frozen built-in schemes …
    expect(verifyWithScheme('attio', { rawBody: BODY, headers: signed('attio', ''), secret: '' })).toBe(true);
    expect(verifyWithScheme('airtable_mac', { rawBody: BODY, headers: signed('airtable_mac', ''), secret: '' })).toBe(true);
    expect(verifyWithScheme('affinity_hex_or_b64', { rawBody: BODY, headers: {}, secret: '' })).toBe(true);
    // … and never under a module's declaration.
    for (const scheme of ['attio', 'airtable_mac', 'affinity_hex_or_b64'] as const) {
      const verifier = declaredInboundVerifier({ scheme, signatureHeaders: SCHEME_DEFAULT_HEADERS[scheme] });
      expect(verifyInbound(verifier, { rawBody: BODY, headers: signed(scheme, ''), secret: '' })).toBe(false);
    }
  });

  it('reads the signature from the first declared header present', () => {
    const verifier = declaredInboundVerifier({ scheme: 'attio', signatureHeaders: ['x-first', 'x-second'] });
    expect(verifyInbound(verifier, { rawBody: BODY, headers: { 'x-second': hex(SECRET) }, secret: SECRET })).toBe(true);
    expect(verifyInbound(verifier, { rawBody: BODY, headers: { 'x-first': 'bad', 'x-second': hex(SECRET) }, secret: SECRET })).toBe(false);
  });

  it('knows a usable key', () => {
    expect([null, undefined, '', ' ', UNREGISTERED_SECRET, 'k'].map(isUsableInboundSecret)).toEqual([false, false, false, false, false, true]);
  });
});
