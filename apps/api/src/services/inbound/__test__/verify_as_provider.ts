// Verify one delivery the way the webhook door verifies a built-in provider's
// (the frozen signature table over the core's schemes), with the signature in
// the provider's first header. Slack's signature is given packed as
// `{timestamp}:{signature}`, the form its tests were written in.

import { SLACK_TIMESTAMP_HEADER, verifyInbound, type InboundHeaders } from 'movement-engine/public/inbound';

import { LEGACY_SIGNATURE_HEADERS } from '../legacy_signature_headers';

function headersFor(providerKey: string, signature: string): InboundHeaders {
  const verifier = LEGACY_SIGNATURE_HEADERS[providerKey];
  if (!verifier) throw new Error(`no built-in provider ${providerKey}`);
  if (!('signatureHeaders' in verifier)) return {};
  const [header] = verifier.signatureHeaders;
  if (verifier.scheme !== 'slack_v0') return { [header]: signature };
  const idx = signature.indexOf(':');
  if (idx < 0) return {};
  return { [SLACK_TIMESTAMP_HEADER]: signature.slice(0, idx), [header]: signature.slice(idx + 1) };
}

export function verifyAsProvider(providerKey: string, rawBody: Buffer, signature: string, secret: string): boolean {
  const verifier = LEGACY_SIGNATURE_HEADERS[providerKey];
  if (!verifier) throw new Error(`no built-in provider ${providerKey}`);
  return verifyInbound(verifier, { rawBody, headers: headersFor(providerKey, signature), secret });
}
