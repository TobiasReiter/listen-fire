// Host-side FileRef byte resolution.
//
// A FileRef is a descriptor: it names where its bytes live and carries no way
// to fetch them. Whatever needs the bytes — a target adapter's write, the
// file-to-text seam, the remote adapter exposing a file to its server — is
// host code, and redeems the descriptor here: the document store by its key,
// or the owning adapter INSTANCE (re-resolved with the credential and
// construction args the descriptor names) through its `resolveFileRef`. The
// engine never imports this module; bytes never reach it.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { Adapter, FileRef, FileSource, ResolveFileRefResult } from '../../adapter';
import { DOCUMENT_STORE_OWNER } from './document_store';

/** How the owning instance is resolved: production's `resolveAdapter` unless a
 *  test supplies its own. */
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
  if (owner.kind === 'document') return streamDocument(owner.objectUri, ref);
  const resolveOwner = options.resolveOwner ?? productionResolveOwner;
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
 * instance identity holds the earlier spelling, `{ ownerAdapterType, handle }`
 * (the remote wire's), with no credential: it still resolves, to the type's
 * credential-free instance, exactly as it did when it parked.
 */
export function fileOwner(source: FileSource | undefined): FileOwner | undefined {
  if (source === undefined) return undefined;
  if ('store' in source) return { kind: 'document', objectUri: source.objectUri };
  if ('ownerAdapterType' in source && typeof source.ownerAdapterType === 'string') {
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

const productionResolveOwner: ResolveFileOwner = async (input) => {
  // Lazy: the adapter registry imports every adapter, and the adapters import
  // this module.
  const { resolveAdapter } = await import('../../adapters/resolve');
  return resolveAdapter(input);
};
