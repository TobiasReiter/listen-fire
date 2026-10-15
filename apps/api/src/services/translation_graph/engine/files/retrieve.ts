// Host-side FileRef byte resolution.
//
// A FileRef is a descriptor: it names where its bytes live and carries no way
// to fetch them. Whatever needs the bytes — a target adapter's write, the
// file-to-text seam, the remote adapter exposing a file to its server — is
// host code, and redeems the descriptor here: the document store by its key,
// or the owning adapter INSTANCE through its `resolveFileRef`. The engine never
// imports this module; bytes never reach it.
//
// Every byte read is the run's tenant's, whatever made the descriptor. Bytes
// are read only (a) from a stored document the store says the team owns, or
// (b) through an adapter instance the run itself holds — the instance the run
// resolved for that adapter type (its own credential), never one the
// descriptor's credential id or handle would build. A descriptor naming
// anything else — another team's document, an adapter type the run holds no
// instance of — is refused by name (`FileOutsideTeamError`), never fetched and
// never answered as an empty file.


import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { Adapter, EarlierFileSource, FileRef, FileSource, ResolveFileRefResult } from 'movement-engine/services/translation_graph/adapter';

import { DOCUMENT_STORE_OWNER, teamDocumentKeyPrefix } from './document_store';
import { FileOutsideTeamError } from './file_outside_team';
import { fileOwnersScope } from 'movement-engine/services/translation_graph/engine/files/file_owners';

export { withFileOwners, type FileOwners } from 'movement-engine/services/translation_graph/engine/files/file_owners';

export { FileOutsideTeamError } from './file_outside_team';

/** How the owning instance is found: the run's own instance of the type (the
 *  scope `withFileOwners` sets) unless a test supplies its own. */
export type ResolveFileOwner = (input: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
}) => Adapter | Promise<Adapter>;

export interface StreamFileRefOptions {
  /** The team the file was read for — the owner instance is the team's. */
  teamId: TeamId;
  resolveOwner?: ResolveFileOwner;
  /** Who owns a stored document: the store's own answer unless a test
   *  supplies one (`useDocumentOwnership`). */
  documentOwnership?: DocumentOwnership;
}

/** Whether a stored document is the team's. */
export type DocumentOwnership = (input: { objectUri: string; teamId: TeamId }) => Promise<boolean>;

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
  // Lazy: the database client is off this module's eval-time graph, which
  // every byte-consuming adapter imports.
  const { getKnowledgeQb } = await import('../../../../lib/kysely');
  const row = await getKnowledgeQb(['document'])
    .selectFrom('document')
    .select('id')
    .where('object_uri', '=', objectUri)
    .where('team_id', '=', teamId)
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

/** Fresh bytes for a descriptor on every call (a consumer that needs them
 *  twice calls twice). Throws when the descriptor has no way back to them. */
export async function streamFileRef(
  ref: FileRef,
  options: StreamFileRefOptions,
): Promise<ResolveFileRefResult> {
  const owner = fileOwner(ref.source);
  if (owner === undefined) {
    throw new Error(
      `the file${ref.name !== undefined ? ` '${ref.name}'` : ''} carries no handle to its bytes, so they cannot be fetched`,
    );
  }
  if (owner.kind === 'document') {
    const owns = options.documentOwnership ?? documentOwnership;
    if (!(await owns({ objectUri: owner.objectUri, teamId: options.teamId }))) {
      throw new FileOutsideTeamError('document', owner.objectUri);
    }
    return streamDocument(owner.objectUri, ref);
  }
  const resolveOwner = options.resolveOwner ?? runResolveOwner;
  const adapter = await resolveOwner({
    adapterType: owner.adapterType,
    teamId: options.teamId,
    ...(owner.credentialId !== undefined ? { credentialsId: owner.credentialId } : {}),
    ...(owner.constructionArgs !== undefined ? { constructionArgs: owner.constructionArgs } : {}),
  });
  if (!adapter.resolveFileRef) {
    throw new Error(`the adapter '${owner.adapterType}' that owns this file cannot serve its bytes`);
  }
  return adapter.resolveFileRef({ ref });
}

/** Whether `streamFileRef` has anywhere to go for this file's bytes. */
export function hasFileSource(ref: FileRef): boolean {
  return fileOwner(ref.source) !== undefined;
}

/** Where a file's bytes are, whichever spelling its descriptor carries. */
export type FileOwner =
  | { kind: 'document'; objectUri: string }
  | {
      kind: 'adapter';
      adapterType: string;
      credentialId?: string;
      constructionArgs?: Record<string, string>;
      handle: string;
    };

/**
 * The owner a descriptor names. A run parked before descriptors carried
 * instance identity holds the earlier spelling (`EarlierFileSource`): it still
 * resolves, to the type's credential-free instance, exactly as it did when it
 * parked. Parked data is JSON from storage, so each spelling is checked for
 * the strings it needs rather than trusted.
 */
export function fileOwner(source: FileSource | EarlierFileSource | undefined): FileOwner | undefined {
  if (source === undefined) return undefined;
  if ('store' in source) {
    return typeof source.objectUri === 'string' ? { kind: 'document', objectUri: source.objectUri } : undefined;
  }
  if (typeof source.handle !== 'string') return undefined;
  if ('ownerAdapterType' in source) {
    if (typeof source.ownerAdapterType !== 'string') return undefined;
    return source.ownerAdapterType === DOCUMENT_STORE_OWNER
      ? { kind: 'document', objectUri: source.handle }
      : { kind: 'adapter', adapterType: source.ownerAdapterType, handle: source.handle };
  }
  if (typeof source.adapterType !== 'string') return undefined;
  return {
    kind: 'adapter',
    adapterType: source.adapterType,
    ...(source.credentialId !== undefined ? { credentialId: source.credentialId } : {}),
    ...(source.constructionArgs !== undefined ? { constructionArgs: source.constructionArgs } : {}),
    handle: source.handle,
  };
}

async function streamDocument(objectUri: string, ref: FileRef): Promise<ResolveFileRefResult> {
  // Lazy: the document store's registry is off this module's eval-time graph,
  // which every byte-consuming adapter imports.
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

/**
 * The owning instance: the one the run holds for the descriptor's adapter type
 * (`withFileOwners`). Outside a run's scope there is none, so an adapter-owned
 * file is not read there.
 */
const runResolveOwner: ResolveFileOwner = (input) => {
  const owners = fileOwnersScope.getStore();
  const adapter = owners?.({
    adapterType: input.adapterType,
    ...(input.credentialsId !== undefined ? { credentialsId: input.credentialsId } : {}),
    ...(input.constructionArgs !== undefined ? { constructionArgs: input.constructionArgs } : {}),
  });
  if (adapter === undefined) {
    throw new FileOutsideTeamError('instance', input.credentialsId !== undefined ? `${input.adapterType} (credential ${input.credentialsId})` : input.adapterType);
  }
  return adapter;
};
