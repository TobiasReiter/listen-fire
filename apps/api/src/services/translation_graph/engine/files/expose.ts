// Expose a file's bytes at a short-lived, fetchable Listen-Fire URL.
//
// Some targets can't take bytes directly: Airtable wants `[{ url }]` and fetches
// server-side; a REMOTE adapter can't ride raw bytes over the JSON wire. For
// those, the consuming adapter pulls the FileRef's bytes (`streamFileRef`) and
// calls `exposeFile` — this deployment buffers them to S3 under an isolated
// temp prefix, records the handle in `exposed_file`, and hands back a
// deployment-domain URL. The public `GET /api/files/blob/:id` route
// (interfaces/rest/files.ts) 302-redirects that to a presigned S3 URL scoped
// to the prefix. S3 stays an implementation detail — this deployment is the
// party both ends already trust, so it exposes the URL.
//
// Lazy-at-write: only called for files actually written to a URL-needing target,
// never by the engine on every write. A periodic poller (services/exposed_file)
// deletes expired rows + their S3 objects.

import { Readable } from 'node:stream';

import { maybePrincipal } from 'principal';

import { services } from '../../../../adapters/registry';
import { getAutomationsQb, getQb } from '../../../../lib/kysely';
import { HOUR } from '../../../../constants';

/** Isolation prefix for every exposed object's S3 key. The presign route is
 *  scoped to it, so the public blob endpoint can never sign anything else. */
export const EXPOSED_FILE_PREFIX = 'exposed';

/** How long an exposed URL stays fetchable. Long enough for a target to fetch
 *  server-side (Airtable) or a remote service to pull it; short enough that the
 *  bytes don't linger. The cleanup poller sweeps once expired. */
export const EXPOSED_FILE_TTL_MS = 1 * HOUR;

/** The externally-reachable API origin the consumer's target fetches the blob
 *  from. `GET /api/files/blob/:id` is served by the API itself, so this must
 *  resolve to the API origin — `OAUTH_REDIRECT_BASE_URL` points at the web app
 *  (and, in the dev loop, the wrong stack / an https port the API doesn't
 *  serve). `EXPOSED_FILE_PUBLIC_BASE_URL` lets the dev loop pin it to the
 *  active stack's API base so the blob-URL byte path resolves in-loop. */
function publicBase(): string {
  return (
    process.env.EXPOSED_FILE_PUBLIC_BASE_URL ??
    process.env.OAUTH_REDIRECT_BASE_URL ??
    'http://localhost:3003'
  );
}

/** Whether `url` is one this deployment exposed (`exposeFile`): its own API
 *  origin's blob route. What a URL-handle owner accepts as a handle it issued
 *  through this deployment. */
export function isExposedFileUrl(url: string): boolean {
  try {
    const exposed = new URL(publicBase());
    const parsed = new URL(url);
    return parsed.origin === exposed.origin && parsed.pathname.startsWith('/api/files/blob/');
  } catch {
    return false;
  }
}

export interface ExposeFileInput {
  stream: Readable;
  filename?: string;
  contentType?: string;
  /** When set, abort with an error once the streamed byte total exceeds this
   *  cap — guards against an unbounded upload OOMing the process. Omitted by
   *  existing callers (e.g. the remote adapter), which stay uncapped. */
  maxBytes?: number;
  /**
   * Whose file this is. Pass it wherever the caller knows — the inbound
   * WhatsApp dispatch resolves a sender's team before it downloads a thing, so
   * it does. Omitted, the team is read from the ambient Principal, which is
   * what the authenticated REST callers have.
   *
   * Neither is available inside a movement run dispatched by the scheduler or
   * a poller: the engine threads `teamId` as a parameter and establishes no
   * ambient identity, and the two adapters that expose files (Airtable
   * attachments, the remote wire form) have no team in scope to hand down. So
   * the stamp is best-effort by construction — see the column's note in
   * schema.sql. It must never be made to throw: this function was contextless
   * before the tenancy work, and a mandatory stamp fails the RUN rather than
   * tenanting the row.
   */
  teamId?: string;
}

export interface ExposedFile {
  url: string;
  expiresAt: Date;
}

/**
 * Buffer a byte stream to S3 under the temp prefix and return a Listen-Fire
 * URL the target can fetch. The stream is consumed fully (S3 needs the content length),
 * so the caller must hand a fresh stream — `streamFileRef` is re-callable.
 */
export async function exposeFile(input: ExposeFileInput): Promise<ExposedFile> {
  const filename = input.filename ?? 'file';
  const bytes = await streamToBuffer(input.stream, input.maxBytes);

  const { objectUri } = await services.document.upload(Readable.from(bytes), {
    filename,
    mimeType: input.contentType,
    contentLength: bytes.byteLength,
    keyPrefix: EXPOSED_FILE_PREFIX,
  });

  const expiresAt = new Date(Date.now() + EXPOSED_FILE_TTL_MS);
  const row = await getAutomationsQb(['exposed_file'])
    .insertInto('exposed_file')
    .values({
      // Whose bytes these are, best-effort: what the caller told us, else the
      // ambient tenant, else nothing. The PRINCIPAL rather than `ctx.user`,
      // because an identified run acts as a machine principal — a team and no
      // person — and asking that path for a person would throw where it has a
      // perfectly good tenant. `maybePrincipal` rather than `currentPrincipal`,
      // because a run the scheduler dispatched has neither.
      //
      // The team is provenance, not authorization: the blob route stays an
      // unauthenticated by-id capability, exactly as before.
      team_id: input.teamId ?? maybePrincipal()?.teamId ?? null,
      object_uri: objectUri,
      content_type: input.contentType ?? null,
      filename,
      expires_at: expiresAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { url: `${publicBase()}/api/files/blob/${row.id}`, expiresAt };
}

async function streamToBuffer(stream: Readable, maxBytes?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new Error('Upload exceeds the size limit.');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
