// How an inbound door decides a delivery really came from its provider.
//
// A provider either names one of the declarative schemes (the protocol's
// INBOUND_SIGNATURE_SCHEMES) plus the headers its signature may arrive in, or
// brings its own check (`verifyInbound`, the escape hatch). Each scheme here is
// the exact check a platform door ran before the doors shared one core, edge
// cases included, so moving a door onto the core changes no signature anyone
// sends: the scheme comments say where each one is lenient.

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { WireInboundSignatureSchemeShape } from 'engine-contracts';

import { REMOTE_SIGNATURE_HEADER, verifyRemoteSignature } from '../webhook_sync/remote_inbound';

export type InboundSignatureScheme = WireInboundSignatureSchemeShape;

/** Request headers as node delivers them: lower-case names. */
export type InboundHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/** What a check sees: the exact bytes that arrived, their headers, and the key
 *  the delivery should be signed with. */
export interface InboundVerification {
  rawBody: Buffer;
  headers: InboundHeaders;
  secret: string;
}

export type InboundVerifier =
  | {
      scheme: InboundSignatureScheme;
      /** Lower case. The FIRST one present carries the signature, even when it
       *  is wrong and a later one would be right. */
      signatureHeaders: readonly string[];
    }
  | { verifyInbound(input: InboundVerification): boolean };

/** Slack sends the signed timestamp beside the signature; the scheme fixes it. */
export const SLACK_TIMESTAMP_HEADER = 'x-slack-request-timestamp';

function headerValue(headers: InboundHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : value?.[0];
}

/** The first of `names` that is present, or '' when none is. */
export function firstPresentHeader(headers: InboundHeaders, names: readonly string[]): string {
  for (const name of names) {
    const value = headerValue(headers, name);
    if (value !== undefined) return value;
  }
  return '';
}

function hmacHex(secret: string | Buffer, data: Buffer | string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Hex against hex. `Buffer.from(_, 'hex')` stops at the first non-hex
 *  character, so a malformed signature decodes short and fails on length. */
function sameHex(expectedHex: string, presentedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const presented = Buffer.from(presentedHex, 'hex');
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

function sameText(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(presented, 'utf-8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Slack's `v0` scheme over the two headers packed as `{timestamp}:{signature}`
 *  (split at the first colon), the form Slack's doors have always passed. */
function verifySlackPacked(rawBody: Buffer, packed: string, secret: string): boolean {
  const idx = packed.indexOf(':');
  if (idx <= 0) return false;
  const timestamp = packed.slice(0, idx);
  const signature = packed.slice(idx + 1);
  if (!signature) return false;
  const presented = signature.startsWith('v0=') ? signature.slice(3) : signature;
  return sameHex(hmacHex(secret, `v0:${timestamp}:${rawBody.toString('utf-8')}`), presented);
}

type SchemeCheck = (input: { rawBody: Buffer; signature: string; headers: InboundHeaders; secret: string }) => boolean;

const SCHEMES: Record<InboundSignatureScheme, SchemeCheck> = {
  /** Hex HMAC-SHA256 of the body, an optional `sha256=` prefix (Meta, GitHub).
   *  No secret or no signature never verifies. */
  hmac_sha256_hex: ({ rawBody, signature, secret }) =>
    signature !== '' && secret !== '' && sameHex(hmacHex(secret, rawBody), signature.replace(/^sha256=/, '')),

  /** Bare hex HMAC-SHA256 of the body, no prefix: Attio's, and the platform's
   *  own outbox (native valuations, knowledge mutations). Lenient: an empty
   *  secret is a key like any other. */
  attio: ({ rawBody, signature, secret }) => sameHex(hmacHex(secret, rawBody), signature),

  /** Airtable: the secret is base64, the header `hmac-sha256=<hex>` (prefix
   *  optional). Lenient on an empty secret, as `attio` is. */
  airtable_mac: ({ rawBody, signature, secret }) =>
    sameHex(
      hmacHex(Buffer.from(secret, 'base64'), rawBody),
      signature.startsWith('hmac-sha256=') ? signature.slice('hmac-sha256='.length) : signature,
    ),

  /** Affinity: HMAC-SHA256 as hex OR base64, an optional `sha256=` prefix in
   *  any case. An account with no signature key configured has nothing to
   *  verify with, so ANY delivery verifies — the URL's secrecy carries it. */
  affinity_hex_or_b64: ({ rawBody, signature, secret }) => {
    if (secret === '') return true;
    const token = signature.replace(/^sha256=/i, '').trim();
    if (token === '') return false;
    const digest = createHmac('sha256', secret).update(rawBody).digest();
    return [digest.toString('hex'), digest.toString('base64')].some((expected) => sameText(expected, token));
  },

  /** Slack's `v0:{timestamp}:{body}`, `v0=` prefix optional. No replay window
   *  (Slack recommends five minutes; no door has ever enforced one). */
  slack_v0: ({ rawBody, signature, headers, secret }) => {
    const timestamp = headerValue(headers, SLACK_TIMESTAMP_HEADER);
    if (timestamp === undefined || signature === '') return false;
    return verifySlackPacked(rawBody, `${timestamp}:${signature}`, secret);
  },

  /** Telegram signs nothing; `setWebhook(secret_token)` makes it echo the
   *  token in a header, compared in constant time. No secret never verifies. */
  telegram_secret_token: ({ signature, secret }) => secret !== '' && signature !== '' && sameText(secret, signature),

  /** This protocol's own: hex HMAC-SHA256 in `x-listen-fire-signature`, never
   *  with an unregistered (placeholder) or empty secret. */
  remote: ({ rawBody, signature, secret }) => verifyRemoteSignature(rawBody, signature, secret),
};

/** The headers each scheme reads when a declaration names none of its own. */
export const SCHEME_DEFAULT_HEADERS: Record<InboundSignatureScheme, readonly string[]> = {
  hmac_sha256_hex: ['x-hub-signature-256'],
  attio: ['attio-signature'],
  airtable_mac: ['x-airtable-content-mac'],
  affinity_hex_or_b64: ['x-affinity-webhook-signature'],
  slack_v0: ['x-slack-signature'],
  telegram_secret_token: ['x-telegram-bot-api-secret-token'],
  remote: [REMOTE_SIGNATURE_HEADER],
};

/** Check one delivery with a declared scheme. */
export function verifyWithScheme(
  scheme: InboundSignatureScheme,
  input: InboundVerification & { signatureHeaders?: readonly string[] },
): boolean {
  const signature = firstPresentHeader(input.headers, input.signatureHeaders ?? SCHEME_DEFAULT_HEADERS[scheme]);
  return SCHEMES[scheme]({ rawBody: input.rawBody, signature, headers: input.headers, secret: input.secret });
}

/** Check one delivery the way its provider says to. */
export function verifyInbound(verifier: InboundVerifier, input: InboundVerification): boolean {
  if ('verifyInbound' in verifier) return verifier.verifyInbound(input);
  return verifyWithScheme(verifier.scheme, { ...input, signatureHeaders: verifier.signatureHeaders });
}

export type InboundAuth = { authorized: true } | { authorized: false; reason: 'signature_invalid' | 'no_secret' };

/**
 * A door whose key may be unset (the platform's own Slack app, its Telegram
 * bot, its WhatsApp app): with a key the delivery must verify; without one the
 * host's no-secret rule decides, and refusing is the default.
 */
export function authenticateInbound(input: {
  verifier: InboundVerifier;
  rawBody: Buffer;
  headers: InboundHeaders;
  secret: string | null;
  /** The host's rule for a door with no key; true lets the delivery in. */
  allowUnsigned: () => boolean;
}): InboundAuth {
  if (input.secret === null) {
    return input.allowUnsigned() ? { authorized: true } : { authorized: false, reason: 'no_secret' };
  }
  return verifyInbound(input.verifier, { rawBody: input.rawBody, headers: input.headers, secret: input.secret })
    ? { authorized: true }
    : { authorized: false, reason: 'signature_invalid' };
}
