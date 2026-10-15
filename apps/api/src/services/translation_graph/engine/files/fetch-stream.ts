// Owner-side helper: fetch a URL to a Node `Readable`, the common shape a
// source adapter's `resolveFileRef` returns.
//
// Several source adapters (email, whatsapp, slack) resolve a `FileRef`'s
// owner handle to a directly-fetchable URL — the attachment's storage URL,
// the Twilio media URL, the Slack `url_private_download`. They all then need
// the same impedance match: an HTTP `fetch` whose web `ReadableStream` body
// becomes a Node `Readable` the engine pipes through `/api/files/{token}`.
// Centralised here so each adapter's `resolveFileRef` stays a one-liner and
// the conversion lives in one place (mirrors `RemoteAdapter`'s url→stream).
//
// resolveFileRef yields a stream
// owner-side byte resolution

import { Readable } from 'node:stream';

import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { ResolveFileRefResult } from 'movement-engine/services/translation_graph/adapter';

import { describeError } from 'movement-engine/lib/utils/error';

/**
 * Fetch `url` (optionally with caller-supplied headers, e.g. an owner's
 * bearer token) and return its body as a Node `Readable` plus the response
 * `content-type`. Throws on a non-2xx — the caller's `resolveFileRef` is in
 * the `/api/files/{token}` control flow, where a throw becomes a 502.
 */
export async function fetchUrlToStream(
  url: string,
  init?: RequestInit,
): Promise<ResolveFileRefResult> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // A network-level throw (undici `TypeError: fetch failed`) carries the
    // real reason on `.cause`; name the URL and unwind it so the failure
    // reason isn't a bare "fetch failed".
    throw new Error(`fetchUrlToStream: fetch of "${url}" failed — ${describeError(err)}`);
  }
  if (!res.ok || !res.body) {
    throw new Error(`fetchUrlToStream: fetch of "${url}" failed (status ${res.status}).`);
  }
  const lengthHeader = res.headers.get('content-length');
  const size = lengthHeader ? Number(lengthHeader) : undefined;
  return {
    stream: Readable.fromWeb(res.body as unknown as WebReadableStream),
    contentType: res.headers.get('content-type') ?? undefined,
    size: size != null && Number.isFinite(size) ? size : undefined,
  };
}
