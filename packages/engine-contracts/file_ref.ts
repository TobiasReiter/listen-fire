// A file as a descriptor: where its bytes live, never the bytes. The engine,
// a remote adapter's wire and a parked run's state all carry it unchanged;
// whatever needs the bytes redeems the descriptor on the host side.
//
// A descriptor is only ever data. What makes one a FILE is the envelope that
// carries it — a field the catalog declares as a file, a typed resource slot,
// a plugin output's declared file, a parked `file` value — and the engine
// marks the file it makes there (`fileValue`). No reader asks a value's keys
// whether it is a file.

import { isMarkedFile, markedFile, type FileMark, type SchemaFieldType } from 'movement-lang';

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
 * `__brand` is the descriptor's spelling on the wire and in a park, kept so
 * the JSON every earlier reader wrote still reads; nothing branches on it.
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

/**
 * A file the engine holds: a descriptor the engine itself marked at a typed
 * entry point. Only `fileValue` makes one; a copy (`{ ...file }`) is a plain
 * descriptor again, which is data.
 */
export type FileValue = FileMark & FileRef;

/** The ONE constructor of a file value: a fresh marked object holding the
 *  descriptor's own members, in the descriptor's order. Called only where an
 *  envelope declares a file. */
export function fileValue(descriptor: FileRef): FileValue {
  return markedFile<FileRef>({
    __brand: 'FileRef',
    ...(descriptor.name !== undefined ? { name: descriptor.name } : {}),
    ...(descriptor.contentType !== undefined ? { contentType: descriptor.contentType } : {}),
    ...(descriptor.size !== undefined ? { size: descriptor.size } : {}),
    ...(descriptor.source !== undefined ? { source: descriptor.source } : {}),
    ...(descriptor.url !== undefined ? { url: descriptor.url } : {}),
  });
}

/** Whether a value is a file the engine made — by its mark, never its keys. */
export function isFileValue(value: unknown): value is FileValue {
  return isMarkedFile(value);
}

/** The members a descriptor may have: one with any other is not one. */
const DESCRIPTOR_MEMBERS: ReadonlySet<string> = new Set(['__brand', 'name', 'contentType', 'size', 'source', 'url']);

/**
 * The descriptor a value spells, when it spells one: a plain object with
 * nothing but a descriptor's members, each of its type (`source` in one of its
 * spellings), and at least one of `__brand`, `source` and `url`. Read only at
 * an envelope that declares a file — anywhere else the same object is data.
 * `__brand` may be absent (a remote adapter's wire omits it).
 */
export function fileDescriptorOf(value: unknown): FileRef | undefined {
  if (!isPlainObject(value)) return undefined;
  if (!Object.keys(value).every((key) => DESCRIPTOR_MEMBERS.has(key))) return undefined;
  const member = (key: string): unknown => (Object.hasOwn(value, key) ? value[key] : undefined);
  if (member('__brand') === undefined && member('source') === undefined && member('url') === undefined) return undefined;
  const brand = member('__brand');
  if (brand !== undefined && brand !== 'FileRef') return undefined;
  const name = member('name');
  const contentType = member('contentType');
  const size = member('size');
  const url = member('url');
  const source = member('source');
  if (name !== undefined && typeof name !== 'string') return undefined;
  if (contentType !== undefined && typeof contentType !== 'string') return undefined;
  if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size))) return undefined;
  if (url !== undefined && url !== null && typeof url !== 'string') return undefined;
  const spelled = source === undefined ? undefined : fileSourceOf(source);
  if (source !== undefined && spelled === undefined) return undefined;
  return {
    __brand: 'FileRef',
    ...(name !== undefined ? { name } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(spelled !== undefined ? { source: spelled } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

/** A descriptor's `source` in one of its spellings, its members each a string. */
function fileSourceOf(value: unknown): FileSource | EarlierFileSource | undefined {
  if (!isPlainObject(value)) return undefined;
  const text = (key: string): string | undefined => {
    const entry: unknown = Object.hasOwn(value, key) ? value[key] : undefined;
    return typeof entry === 'string' ? entry : undefined;
  };
  if (Object.hasOwn(value, 'store')) {
    const objectUri = text('objectUri');
    return text('store') === 'document' && objectUri !== undefined ? { store: 'document', objectUri } : undefined;
  }
  const handle = text('handle');
  if (handle === undefined) return undefined;
  if (Object.hasOwn(value, 'ownerAdapterType')) {
    const ownerAdapterType = text('ownerAdapterType');
    return ownerAdapterType !== undefined ? { ownerAdapterType, handle } : undefined;
  }
  const adapterType = text('adapterType');
  if (adapterType === undefined) return undefined;
  const credentialId: unknown = Object.hasOwn(value, 'credentialId') ? value.credentialId : undefined;
  if (credentialId !== undefined && typeof credentialId !== 'string') return undefined;
  const args: unknown = Object.hasOwn(value, 'constructionArgs') ? value.constructionArgs : undefined;
  let constructionArgs: Record<string, string> | undefined;
  if (args !== undefined) {
    if (!isPlainObject(args)) return undefined;
    constructionArgs = {};
    for (const [key, entry] of Object.entries(args)) {
      if (typeof entry !== 'string') return undefined;
      constructionArgs[key] = entry;
    }
  }
  return {
    adapterType,
    ...(typeof credentialId === 'string' ? { credentialId } : {}),
    ...(constructionArgs !== undefined ? { constructionArgs } : {}),
    handle,
  };
}

/** The file a value is, at an envelope that declares one: the engine's own
 *  file as itself, a descriptor marked, anything else not a file. */
export function fileValueOf(value: unknown): FileValue | undefined {
  if (isFileValue(value)) return value;
  const descriptor = fileDescriptorOf(value);
  return descriptor !== undefined ? fileValue(descriptor) : undefined;
}

/**
 * A value read where the catalog declares its type — a field, a plugin
 * output's field — with every position the type calls a file made a file:
 * `file` itself, a list's or a dict's members of that type, a tuple's slots,
 * a maybe-absent one. A value that does not spell a descriptor where a file is
 * declared stays as it is (data). Nothing else is ever a file, whatever its
 * keys.
 */
export function filesAtType(type: SchemaFieldType | undefined, value: unknown): unknown {
  if (type === undefined || value === null || value === undefined) return value;
  if (typeof type === 'string') return type === 'file' ? fileValueOf(value) ?? value : value;
  switch (type.kind) {
    case 'list':
      return Array.isArray(value) ? value.map((member) => filesAtType(type.of, member)) : value;
    case 'tuple':
      return Array.isArray(value)
        ? value.map((member, i) => filesAtType(type.of[i] ?? undefined, member))
        : value;
    case 'dict':
      return isPlainObject(value)
        ? Object.fromEntries(Object.entries(value).map(([key, member]) => [key, filesAtType(type.of, member)]))
        : value;
    case 'maybeAbsent':
      return filesAtType(type.of, value);
    case 'enum':
      return value;
  }
}

/** A plain object: not `null`, not an array, its prototype `Object.prototype`
 *  or none (a JSON object, never a class instance). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A file value as the plain descriptor the wire and a park carry. */
export function fileDescriptorOfValue(file: FileValue): FileRef {
  return { ...file };
}

/** The file's durable identity within its owner: the owner's handle, or the
 *  store key. What a file is memoised and cited by. */
export function fileHandle(ref: FileRef): string | undefined {
  const source = ref.source;
  if (source === undefined) return undefined;
  return 'store' in source ? source.objectUri : source.handle;
}

