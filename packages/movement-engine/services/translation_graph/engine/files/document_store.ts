// The document store: where the files a run makes itself are kept (a `FILE()`
// render artifact, a plugin's file output), and where a file is exposed at a
// URL an external can fetch. A document-store FileRef is the descriptor for
// such a file; its owner is the store itself (no per-tenant credentials), and
// the host redeems it by `objectUri` (`redeemFileRef`).
//
// The store is a host family: every shell has a backend. The hosted product's
// is object storage behind its API's blob route; `lf`'s is the project's
// `.lf/files/` folder.

import type { Readable } from 'node:stream';

import type { FileRef, ResolveFileRefResult } from '../../adapter';

export interface DocumentStore {
  /** Keep a run's own file for its tenant, under the tenant's prefix
   *  (`teamDocumentKeyPrefix`), and answer its descriptor. */
  put(input: { tenantId: string; bytes: Buffer; name: string; contentType: string }): Promise<FileRef>;
  /** Whether a stored document is the tenant's to read. */
  owns(input: { objectUri: string; tenantId: string }): Promise<boolean>;
  /** Fresh bytes of a stored document. */
  open(input: { objectUri: string; ref: FileRef }): Promise<ResolveFileRefResult>;
  /** Make bytes fetchable at a short-lived URL, for a party that cannot take
   *  them in-line (a remote adapter's server, across the JSON wire). */
  expose(input: { stream: Readable; filename?: string; contentType?: string; tenantId: string }): Promise<{ url: string }>;
}

/**
 * The key prefix of the documents a team's movements store themselves (a
 * `FILE()` artifact, a manual run's uploaded files): what makes such a
 * document the team's without a row recording it (`streamFileRef`'s ownership
 * check, on the store's own reading of the key, `keyOf`).
 */
export function teamDocumentKeyPrefix(teamId: string): string {
  return `movement-files/${teamId}`;
}

/** How a document-store file is spelled where a source names an OWNER TYPE —
 *  the remote adapter's wire, and runs parked before descriptors named their
 *  store directly. Not an adapter. */
export const DOCUMENT_STORE_OWNER = 'document-store';

export interface DocumentStoreFileRefInput {
  /** The store handle (`services.document.upload`'s returned `objectUri`). */
  objectUri: string;
  name?: string;
  contentType?: string;
  size?: number;
}

export function documentStoreFileRef(input: DocumentStoreFileRefInput): FileRef {
  const { objectUri, name, contentType, size } = input;
  return {
    __brand: 'FileRef',
    ...(name !== undefined ? { name } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    ...(size !== undefined ? { size } : {}),
    source: { store: 'document', objectUri },
  };
}
