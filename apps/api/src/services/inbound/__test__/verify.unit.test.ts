// The inbound core's declarative signature schemes, the edges each one keeps
// from the door it came from, and the frozen built-in table staying in step
// with the registered providers.

import { createHmac } from 'node:crypto';

import { INBOUND_SIGNATURE_SCHEMES } from 'engine-contracts';
import {
  authenticateInbound,
  firstPresentHeader,
  signRemoteDelivery,
  verifyInbound,
  verifyWithScheme,
} from 'movement-engine/public/inbound';

import { LEGACY_INTERCEPTS, LEGACY_SIGNATURE_HEADERS } from '../legacy_signature_headers';
import { listWebhookProviders } from '../../webhook_sync/providers';

const BODY = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf-8');
const hex = (secret: string | Buffer, data: Buffer | string = BODY) => createHmac('sha256', secret).update(data).digest('hex');

describe('firstPresentHeader', () => {
  it('takes the first header present, even when it is empty', () => {
    expect(firstPresentHeader({ b: 'two', a: '' }, ['a', 'b'])).toBe('');
    expect(firstPresentHeader({ b: 'two' }, ['a', 'b'])).toBe('two');
    expect(firstPresentHeader({}, ['a'])).toBe('');
    expect(firstPresentHeader({ a: ['x', 'y'] }, ['a'])).toBe('x');
  });
});

describe('the declarative schemes', () => {
  it('names a check for every scheme the protocol declares', () => {
    for (const scheme of INBOUND_SIGNATURE_SCHEMES) {
      expect(typeof verifyWithScheme(scheme, { rawBody: BODY, headers: {}, secret: 'k' })).toBe('boolean');
    }
  });

  it('airtable_mac: base64 secret, optional hmac-sha256= prefix', () => {
    const secret = Buffer.from('airtable-mac-secret').toString('base64');
    const mac = hex(Buffer.from(secret, 'base64'));
    const check = (signature: string) =>
      verifyWithScheme('airtable_mac', { rawBody: BODY, headers: { 'x-airtable-content-mac': signature }, secret });
    expect(check(`hmac-sha256=${mac}`)).toBe(true);
    expect(check(mac)).toBe(true);
    expect(check(`hmac-sha256=${hex('other')}`)).toBe(false);
  });

  it('telegram_secret_token: the echoed token, never with no secret', () => {
    const check = (token: string | undefined, secret: string) =>
      verifyWithScheme('telegram_secret_token', {
        rawBody: BODY,
        headers: { 'x-telegram-bot-api-secret-token': token },
        secret,
      });
    expect(check('tok', 'tok')).toBe(true);
    expect(check('tok2', 'tok')).toBe(false);
    expect(check(undefined, 'tok')).toBe(false);
    expect(check('', '')).toBe(false);
  });

  it('remote: the protocol header only, never with a placeholder secret', () => {
    const check = (secret: string) =>
      verifyWithScheme('remote', {
        rawBody: BODY,
        headers: { 'x-listen-fire-signature': signRemoteDelivery(BODY, secret) },
        secret,
      });
    expect(check('whsec')).toBe(true);
    expect(check('pending')).toBe(false);
    expect(check('')).toBe(false);
  });

  it('hmac_sha256_hex: optional sha256= prefix, no empty secret', () => {
    const check = (signature: string, secret = 'k') =>
      verifyWithScheme('hmac_sha256_hex', { rawBody: BODY, headers: { 'x-hub-signature-256': signature }, secret });
    expect(check(`sha256=${hex('k')}`)).toBe(true);
    expect(check(hex('k'))).toBe(true);
    expect(check(`sha256=${hex('')}`, '')).toBe(false);
  });

  it('attio: bare hex only', () => {
    const check = (signature: string) =>
      verifyWithScheme('attio', { rawBody: BODY, headers: { 'attio-signature': signature }, secret: 'k' });
    expect(check(hex('k'))).toBe(true);
    expect(check(`sha256=${hex('k')}`)).toBe(false);
  });

  it('slack_v0: needs the timestamp header beside the signature', () => {
    const signature = `v0=${hex('k', `v0:1700000000:${BODY.toString('utf-8')}`)}`;
    const check = (headers: Record<string, string>) => verifyWithScheme('slack_v0', { rawBody: BODY, headers, secret: 'k' });
    expect(check({ 'x-slack-request-timestamp': '1700000000', 'x-slack-signature': signature })).toBe(true);
    expect(check({ 'x-slack-signature': signature })).toBe(false);
    expect(check({ 'x-slack-request-timestamp': '1700000001', 'x-slack-signature': signature })).toBe(false);
  });

  it('a verifyInbound escape hatch decides on its own', () => {
    expect(verifyInbound({ verifyInbound: ({ secret }) => secret === 'yes' }, { rawBody: BODY, headers: {}, secret: 'yes' })).toBe(true);
  });
});

describe('authenticateInbound', () => {
  const verifier = { scheme: 'hmac_sha256_hex' as const, signatureHeaders: ['x-sig'] };
  it('with a key: the signature decides', () => {
    const headers = { 'x-sig': hex('k') };
    expect(authenticateInbound({ verifier, rawBody: BODY, headers, secret: 'k', allowUnsigned: () => true })).toEqual({ authorized: true });
    expect(authenticateInbound({ verifier, rawBody: BODY, headers, secret: 'k2', allowUnsigned: () => true })).toEqual({
      authorized: false,
      reason: 'signature_invalid',
    });
  });
  it("without a key: the host's no-secret rule decides", () => {
    expect(authenticateInbound({ verifier, rawBody: BODY, headers: {}, secret: null, allowUnsigned: () => false })).toEqual({
      authorized: false,
      reason: 'no_secret',
    });
    expect(authenticateInbound({ verifier, rawBody: BODY, headers: {}, secret: null, allowUnsigned: () => true })).toEqual({ authorized: true });
  });
});

describe('the frozen built-in table', () => {
  it('has exactly one entry per registered webhook provider', () => {
    expect(Object.keys(LEGACY_SIGNATURE_HEADERS).sort()).toEqual(listWebhookProviders().map((p) => p.provider).sort());
  });

  it('never reads the remote protocol header for a built-in', () => {
    for (const verifier of Object.values(LEGACY_SIGNATURE_HEADERS)) {
      if ('signatureHeaders' in verifier) expect(verifier.signatureHeaders).not.toContain('x-listen-fire-signature');
    }
  });

  it('intercepts only for providers it verifies', () => {
    for (const key of Object.keys(LEGACY_INTERCEPTS)) expect(LEGACY_SIGNATURE_HEADERS[key]).toBeDefined();
  });
});
