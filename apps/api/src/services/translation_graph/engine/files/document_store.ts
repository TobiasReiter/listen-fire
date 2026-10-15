// A document-store FileRef — the descriptor for a file that lives in
// Listen-Fire's own document storage rather than behind an external adapter (a
// `FILE()` render artifact, a plugin's file output). Its owner is the global
// store itself (`services.document`, no per-team credentials); the host
// redeems it by `objectUri` (`streamFileRef`).

import type { FileRef } from 'movement-engine/services/translation_graph/adapter';

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
