// A file as a descriptor: where its bytes live, never the bytes. The engine,
// a remote adapter's wire and a parked run's state all carry it unchanged;
// whatever needs the bytes redeems the descriptor on the host side.

/**
 * A file as the engine holds it: a pure descriptor of where its bytes live,
 * never the bytes and never a closure over them. Symmetric across the
 * source→engine→target seam, and JSON as it stands, so it crosses the engine
 * boundary, a remote adapter's wire and a parked run's state unchanged.
 *
 * Metadata (`name` / `contentType` / `size`) is always carried. Bytes are a
 * host concern: whatever needs them (a target adapter's write, file-to-text)
 * redeems the descriptor's `source` on the host side.
 *
 * Branded so a plain object can't masquerade as a FileRef in the deep field
 * walk (`isFileRef`).
 */
export interface FileRef {
  readonly __brand: 'FileRef';
  /** Display name. */
  name?: string;
  /** MIME type when known. */
  contentType?: string;
  /** Byte length when known. */
  size?: number;
  /** Where the bytes live. Absent only for a file that has no way back to
   *  them. A run parked before descriptors named their instance holds the
   *  earlier spelling. */
  source?: FileSource | EarlierFileSource;
  /**
   * A short-lived, fetchable URL for the bytes, minted by the host. Set when
   * a FileRef is written INTO a remote adapter: the host buffers the bytes
   * and puts the URL here so the remote server can fetch them (raw bytes
   * can't ride the JSON wire). Nullable because adapter file VALUES carry a
   * nullable `url` off raw JSON.
   */
  url?: string | null;
}

/**
 * Where a file's bytes live. An adapter-owned file names the INSTANCE that
 * owns it — its type, credential and construction args — so the host resolves
 * that same instance to redeem `handle` (`Adapter.resolveFileRef`), with the
 * credentials the file was read with. A file in the host's own document
 * storage (a `FILE()` artifact, a plugin's output) names its store key.
 */
export type FileSource =
  | {
      adapterType: string;
      credentialId?: string;
      constructionArgs?: Record<string, string>;
      /** Opaque to everyone but the owner. */
      handle: string;
    }
  | { store: 'document'; objectUri: string };

/** The source of a file an adapter instance owns, naming that instance as it
 *  was constructed (the factory's credential and construction args). */
export function ownedFileSource(input: {
  adapterType: string;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
  handle: string;
}): FileSource {
  return {
    adapterType: input.adapterType,
    ...(input.credentialsId !== undefined ? { credentialId: input.credentialsId } : {}),
    ...(input.constructionArgs !== undefined ? { constructionArgs: input.constructionArgs } : {}),
    handle: input.handle,
  };
}

/**
 * How a file's source was spelled before it named its owning instance — the
 * owner TYPE and its handle, no credential (`'document-store'` for the
 * document store). Nothing produces it any more; it is read from runs parked
 * before descriptors changed, which resolve their owner credential-free, as
 * they did when they parked.
 */
export interface EarlierFileSource {
  ownerAdapterType: string;
  handle: string;
}

/** Structural guard for a branded `FileRef`. */
export function isFileRef(value: unknown): value is FileRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === 'FileRef'
  );
}

/** The file's durable identity within its owner: the owner's handle, or the
 *  store key. What a file is memoised and cited by. */
export function fileHandle(ref: FileRef): string | undefined {
  const source = ref.source;
  if (source === undefined) return undefined;
  return 'store' in source ? source.objectUri : source.handle;
}

