// Svix webhook signatures — the scheme Resend signs its webhooks with.
//
// Three headers travel with the delivery (`svix-id`, `svix-timestamp`,
// `svix-signature`) and the signed content is `${id}.${timestamp}.${body}`,
// HMAC-SHA256'd with the base64 secret behind the `whsec_` prefix. The
// signature header carries a SPACE-SEPARATED list of versioned signatures
// (`v1,<base64> v1,<base64>`) because Svix rotates secrets by signing with
// both — one matching entry is a pass.
//
// Two things it is easy to get wrong, and both are silent:
//   • the body must be the bytes that arrived, not a re-serialisation — key
//     order and whitespace are part of what was signed;
//   • a valid signature over an OLD delivery is still valid forever, so the
//     timestamp is checked against a tolerance. Without it a captured request
//     can be replayed indefinitely.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far the delivery's timestamp may be from ours, in either direction. */
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

interface SvixHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

type SvixVerdict = 'verified' | 'bad-signature' | 'stale' | 'malformed';

/** The raw key bytes behind a `whsec_`-prefixed secret. */
function secretBytes(secret: string): Buffer {
  const base64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(base64, 'base64');
}

/** The base64 signature Svix expects for one delivery. */
function svixSignature(input: {
  secret: string;
  id: string;
  timestamp: string;
  body: string;
}): string {
  return createHmac('sha256', secretBytes(input.secret))
    .update(`${input.id}.${input.timestamp}.${input.body}`)
    .digest('base64');
}

function matchesAny(header: string, expected: string): boolean {
  const want = Buffer.from(expected);
  for (const entry of header.split(' ')) {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || value === undefined) continue;
    const given = Buffer.from(value);
    // A length mismatch is a wrong signature, not an exception: `timingSafeEqual`
    // throws on unequal lengths.
    if (given.length !== want.length) continue;
    if (timingSafeEqual(given, want)) return true;
  }
  return false;
}

/**
 * Verify a Svix-signed delivery. `body` must be the exact bytes received.
 *
 * `now` is injectable so the staleness rule can be tested without sleeping.
 */
function verifySvixSignature(input: {
  secret: string;
  headers: SvixHeaders;
  body: string;
  now?: number;
}): SvixVerdict {
  const { id, timestamp, signature } = input.headers;
  if (!id || !timestamp || !signature) return 'malformed';

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return 'malformed';
  const now = input.now ?? Date.now();
  if (Math.abs(now - seconds * 1000) > TIMESTAMP_TOLERANCE_MS) return 'stale';

  const expected = svixSignature({ secret: input.secret, id, timestamp, body: input.body });
  return matchesAny(signature, expected) ? 'verified' : 'bad-signature';
}

export {
  TIMESTAMP_TOLERANCE_MS,
  svixSignature,
  verifySvixSignature,
  type SvixHeaders,
  type SvixVerdict,
};
