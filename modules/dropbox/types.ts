// Dropbox — shared types + the name → structured-identifier cache.
// Dropbox's surface is the two nouns the API itself has (adapters/CLAUDE.md
// rule 4 — the old `document`/`upload` write forms were ONE concept, a File:
// `files/upload` is the single file-creation endpoint and "create a text
// document" is just an upload of text/plain bytes):
//
//   • `folder` — a Dropbox folder: readable (root collection + `folders`
//     edges) and creatable (root or along a folder's `folders` edge).
//   • `file`   — a Dropbox file: readable (root collection + `files` edges,
//     bytes via the `File` field) and creatable (root or along a folder's
//     `files` edge; the `File` field carries the bytes — a File-typed value
//     or inline text).
//
// A Dropbox record is addressed by PATH (not id): the externalId of a created
// record is its path, the display URL is `dropboxWebUrl(path)`, and the
// linked_object externalId is a path. The Dropbox ROOT is itself a real
// folder (path ""), so the root collections are that folder's children and a
// root create lands there.
//
// A Dropbox write type is NOT parameterised by a target record id (a folder/
// file is CREATED, not addressed): the writable surface is a FIXED set of two
// kinds. The framework names each by its pretty `displayName` (`"Folder"`,
// `"File"` — rule 5: never the system name; the instance already says which
// system you're in) — that IS the `typeId`/`recordType` every entry and
// position carries — and the write/describe logic recovers the `kind` it
// routes on from that name via `structuredIdFor`. There is deliberately NO
// `encode/decodeTypeId` magic-string codec: the kind is never flattened into
// a string and crammed onto a position. The kind set is compile-time fixed,
// so the "cache" is a plain reverse map (Listen-Fire-Valuations style), not a
// fetched one.

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`
 *  and the `DROPBOX` trigger-kind alias in the registry. */
export const DROPBOX_ADAPTER_TYPE = 'dropbox';

/** Which write path a Dropbox type drives. This kind enum is the adapter's
 *  PRIVATE structured identifier, recovered from a position's pretty type
 *  NAME via `structuredIdFor`; it never appears on a position. */
export type DropboxTypeKind = 'folder' | 'file';

// ── Name → structured-identifier cache ─────────────────────────────────────
// The pretty display name IS each kind's framework identity (the `typeId`
// `listEntryPoints`/`describe` publish and the `recordType` every position
// carries). The kind set is a compile-time constant, so the name↔kind map is a
// plain record, not an async introspection cache.

export const DISPLAY_NAME_BY_KIND: Record<DropboxTypeKind, string> = {
  folder: 'Folder',
  file: 'File',
};

const KIND_BY_DISPLAY_NAME: Record<string, DropboxTypeKind> = Object.fromEntries(
  (Object.keys(DISPLAY_NAME_BY_KIND) as DropboxTypeKind[]).map((kind) => [
    DISPLAY_NAME_BY_KIND[kind],
    kind,
  ]),
);

/** Resolve a type's pretty NAME to its kind, or undefined when the name isn't a
 *  known Dropbox type. */
export function structuredIdFor(name: string): DropboxTypeKind | undefined {
  return KIND_BY_DISPLAY_NAME[name];
}

/** The write variant: a name that doesn't resolve is a hard error (the movement
 *  targets a type this adapter doesn't expose — drift). */
export function requireStructuredId(name: string, method: string): DropboxTypeKind {
  const kind = structuredIdFor(name);
  if (!kind) {
    throw new Error(`DropboxAdapter.${method}: unrecognised recordType "${name}".`);
  }
  return kind;
}

// ── Display URL helper ───────────────────────────────────────────────────────
// Dropbox addresses by path, so the URL is built from the path (vs Drive's
// id-based URL).

export function dropboxWebUrl(path: string): string {
  return `https://www.dropbox.com/home${path}`;
}
