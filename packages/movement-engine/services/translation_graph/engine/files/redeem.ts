// Redeeming a FileRef for its bytes, host side.
//
// A FileRef is a descriptor: it names where its bytes live and carries no way
// to fetch them. Whatever needs the bytes — a target adapter's write, the
// file-to-text seam, the remote adapter exposing a file to its server — is
// host code, and redeems the descriptor here: the document store by its key,
// or the owning adapter INSTANCE through its `resolveFileRef`. The engine never
// imports this module; bytes never reach it.
//
// Every byte read is the run's tenant's, whatever made the descriptor. Bytes
// are read only (a) from a stored document the store says the tenant owns, or
// (b) through an adapter instance the run itself holds — the instance the run
// resolved for that adapter type (its own credential), never one the
// descriptor's credential id or handle would build. A descriptor naming
// anything else is refused by name (`FileOutsideTeamError`), never fetched and
// never answered as an empty file.

import type { Adapter, EarlierFileSource, FileRef, FileSource, ResolveFileRefResult } from '../../adapter';

import { DOCUMENT_STORE_OWNER, type DocumentStore } from './document_store';
import { FileOutsideTeamError } from './file_outside_team';
import { fileOwnersScope } from './file_owners';

/** How the owning instance is found: the run's own instance of the type (the
 *  scope `withFileOwners` sets) unless a test supplies its own. */
export type ResolveFileOwner = (input: {
  adapterType: string;
  /** The tenant (the engine's `teamId`). */
  teamId: string;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
}) => Adapter | Promise<Adapter>;

/** Fresh bytes for a descriptor on every call (a consumer that needs them
 *  twice calls twice). Throws when the descriptor has no way back to them. */
export async function redeemFileRef(
  ref: FileRef,
  options: {
    /** The tenant the file was read for — the owner instance is the tenant's. */
    tenantId: string;
    documents: Pick<DocumentStore, 'owns' | 'open'>;
    resolveOwner?: ResolveFileOwner;
  },
): Promise<ResolveFileRefResult> {
  const owner = fileOwner(ref.source);
  if (owner === undefined) {
    throw new Error(
      `the file${ref.name !== undefined ? ` '${ref.name}'` : ''} carries no handle to its bytes, so they cannot be fetched`,
    );
  }
  if (owner.kind === 'document') {
    if (!(await options.documents.owns({ objectUri: owner.objectUri, tenantId: options.tenantId }))) {
      throw new FileOutsideTeamError('document', owner.objectUri);
    }
    return options.documents.open({ objectUri: owner.objectUri, ref });
  }
  const resolveOwner = options.resolveOwner ?? runResolveOwner;
  const adapter = await resolveOwner({
    adapterType: owner.adapterType,
    teamId: options.tenantId,
    ...(owner.credentialId !== undefined ? { credentialsId: owner.credentialId } : {}),
    ...(owner.constructionArgs !== undefined ? { constructionArgs: owner.constructionArgs } : {}),
  });
  if (!adapter.resolveFileRef) {
    throw new Error(`the adapter '${owner.adapterType}' that owns this file cannot serve its bytes`);
  }
  return adapter.resolveFileRef({ ref });
}

/** Whether `redeemFileRef` has anywhere to go for this file's bytes. */
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
    throw new FileOutsideTeamError(
      'instance',
      input.credentialsId !== undefined ? `${input.adapterType} (credential ${input.credentialsId})` : input.adapterType,
    );
  }
  return adapter;
};
