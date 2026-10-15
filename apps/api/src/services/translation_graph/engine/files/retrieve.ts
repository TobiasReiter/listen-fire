// The hosted product's document store, and FileRef byte resolution bound to
// it. The redeeming itself — which owner a descriptor names, and that only the
// run's tenant's bytes are read — is shared with every other shell
// (`movement-engine/.../files/redeem`); what is the product's is the store:
// object storage, ownership by key prefix or a `knowledge.document` row, and
// exposure through the API's blob route (`expose.ts`).

import { Readable } from 'node:stream';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type {
  FileRef,
  ResolveFileRefResult,
} from 'movement-engine/services/translation_graph/adapter';

import {
  documentStoreFileRef,
  teamDocumentKeyPrefix,
  type DocumentStore,
} from 'movement-engine/services/translation_graph/engine/files/document_store';
import {
  redeemFileRef,
  type ResolveFileOwner,
} from 'movement-engine/services/translation_graph/engine/files/redeem';
import { teamKeySchema } from '../../movement/tenant';

export {
  withFileOwners,
  type FileOwners,
} from 'movement-engine/services/translation_graph/engine/files/file_owners';
export {
  hasFileSource,
  type ResolveFileOwner,
} from 'movement-engine/services/translation_graph/engine/files/redeem';
export { FileOutsideTeamError } from 'movement-engine/services/translation_graph/engine/files/file_outside_team';

export interface StreamFileRefOptions {
  /** The team the file was read for — the owner instance is the team's. */
  teamId: TeamId;
  resolveOwner?: ResolveFileOwner;
  /** Who owns a stored document: the store's own answer unless a test
   *  supplies one (`useDocumentOwnership`). */
  documentOwnership?: DocumentOwnership;
}

/** Whether a stored document is the team's. */
export type DocumentOwnership = (input: { objectUri: string; teamId: string }) => Promise<boolean>;

/**
 * The document store's owner lookup: a key under the team's prefix (where a
 * movement's own artifacts are stored, `teamDocumentKeyPrefix`), else the
 * team-scoped `knowledge.document` row that recorded the upload (a plugin's
 * stored document). Anything else — another team's document, a key no row
 * names — is not the team's.
 */
const productionDocumentOwnership: DocumentOwnership = async ({ objectUri, teamId }) => {
  // The store's own reading of its key (one parser for read, delete and
  // this check): a URI it would not read is no document of anyone's.
  const { services } = await import('../../../../adapters/registry');
  const key = services.document.keyOf(objectUri);
  if (key === undefined) return false;
  if (key.startsWith(`${teamDocumentKeyPrefix(teamId)}/`)) return true;
  // Only a team has document rows, and a team's id is a uuid.
  const team = teamKeySchema.safeParse(teamId);
  if (!team.success) return false;
  // Lazy: the database client is off this module's eval-time graph, which
  // every byte-consuming adapter imports.
  const { getKnowledgeQb } = await import('../../../../lib/kysely');
  const row = await getKnowledgeQb(['document'])
    .selectFrom('document')
    .select('id')
    .where('object_uri', '=', objectUri)
    .where('team_id', '=', team.data)
    .executeTakeFirst();
  return row !== undefined;
};

let documentOwnership: DocumentOwnership = productionDocumentOwnership;

/** Who answers for stored documents from here on (a test's in-memory store
 *  answers for its own files); the earlier answerer, to put back. */
export function useDocumentOwnership(ownership: DocumentOwnership): DocumentOwnership {
  const earlier = documentOwnership;
  documentOwnership = ownership;
  return earlier;
}

/** The hosted document store. Lazy throughout: the store's registry and the
 *  database are off this module's eval-time graph, which every byte-consuming
 *  adapter imports. */
export const hostedDocumentStore: DocumentStore = {
  put: async ({ tenantId, bytes, name, contentType }) => {
    const { services } = await import('../../../../adapters/registry');
    const { objectUri } = await services.document.upload(Readable.from(bytes), {
      filename: name,
      mimeType: contentType,
      contentLength: bytes.byteLength,
      keyPrefix: teamDocumentKeyPrefix(tenantId),
    });
    return documentStoreFileRef({ objectUri, name, contentType, size: bytes.byteLength });
  },
  owns: ({ objectUri, tenantId }) => documentOwnership({ objectUri, teamId: tenantId }),
  open: ({ objectUri, ref }) => streamDocument(objectUri, ref),
  expose: async ({ stream, filename, contentType, tenantId }) => {
    const { exposeFile } = await import('./expose');
    return exposeFile({
      stream,
      ...(filename !== undefined ? { filename } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
      teamId: tenantId,
    });
  },
};

/** Fresh bytes for a descriptor on every call (a consumer that needs them
 *  twice calls twice). Throws when the descriptor has no way back to them. */
export function streamFileRef(
  ref: FileRef,
  options: StreamFileRefOptions,
): Promise<ResolveFileRefResult> {
  const ownership = options.documentOwnership;
  return redeemFileRef(ref, {
    tenantId: options.teamId,
    documents:
      ownership !== undefined
        ? {
            ...hostedDocumentStore,
            owns: ({ objectUri, tenantId }) => ownership({ objectUri, teamId: tenantId }),
          }
        : hostedDocumentStore,
    ...(options.resolveOwner !== undefined ? { resolveOwner: options.resolveOwner } : {}),
  });
}

async function streamDocument(objectUri: string, ref: FileRef): Promise<ResolveFileRefResult> {
  const { services } = await import('../../../../adapters/registry');
  const stream = await services.document.getFileNodeStream({ objectUri });
  const contentType = stream.contentType ?? ref.contentType;
  const size = stream.size ?? ref.size;
  return {
    stream,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}
