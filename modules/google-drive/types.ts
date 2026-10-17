// Google Drive TG adapter — shared types + the name → structured-identifier
// cache. Drive's surface is the two nouns the API itself has (adapters/
// CLAUDE.md rule 4 — the old `document`/`upload` write forms were ONE
// concept, a File: `files.create` is the single creation endpoint; a Google
// Doc is a file created with the Doc mimeType and imported text):
//
//   • `folder` — a Drive folder: readable (granted roots + `Folders` edges)
//     and creatable ALONG A FOLDER'S EDGE (`write folder-[:Folders]->`).
//   • `file`   — a Drive file: readable (granted roots + `Files` edges,
//     bytes via the `File` field) and creatable along a folder's `Files`
//     edge — `File` uploads bytes, `Content` imports text as a Google Doc.
//
// Under the drive.file scope there is no root to write into: every create
// names a real parent folder, so creates live on the folder edges and the
// ROOT entries are read-only (rule 0 — access lives where access is real;
// the root collections are the credential's GRANTED items, and a parentless
// create would mint a record no root read could ever show again).
//
// A Drive write type is NOT parameterised by a target record id (a folder/
// file is CREATED, not addressed): the surface is a FIXED set of two kinds.
// The framework names each by its pretty `displayName` (`"Folder"`, `"File"`
// — rule 5: never the system name; the instance already says which system
// you're in) — that IS the `typeId`/`recordType` every entry and position
// carries — and the write/describe logic recovers the `kind` it routes on
// from that name via `structuredIdFor`. There is deliberately NO
// `encode/decodeTypeId` magic-string codec: the kind is never flattened into
// a string and crammed onto a position. Because the kind set is compile-time
// fixed (no introspection), the "cache" is a plain reverse map
// (Listen-Fire-Valuations style), not a fetched one.

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`
 *  and the `GOOGLE_DRIVE` trigger-kind alias in the registry. */
export const GOOGLE_DRIVE_ADAPTER_TYPE = 'google_drive';

/** Which write path a Drive type drives. This kind enum is the adapter's
 *  PRIVATE structured identifier, recovered from a position's pretty type
 *  NAME via `structuredIdFor`; it never appears on a position. */
export type DriveTypeKind = 'folder' | 'file';

// ── Name → structured-identifier cache ─────────────────────────────────────
// The pretty display name IS each kind's framework identity (the `typeId`
// `listEntryPoints`/`describe` publish and the `recordType` every position
// carries). The kind set is a compile-time constant, so the name↔kind map is a
// plain record, not an async introspection cache.

export const DISPLAY_NAME_BY_KIND: Record<DriveTypeKind, string> = {
  folder: 'Folder',
  file: 'File',
};

const KIND_BY_DISPLAY_NAME: Record<string, DriveTypeKind> = Object.fromEntries(
  (Object.keys(DISPLAY_NAME_BY_KIND) as DriveTypeKind[]).map((kind) => [
    DISPLAY_NAME_BY_KIND[kind],
    kind,
  ]),
);

/** Resolve a type's pretty NAME to its kind, or undefined when the name isn't a
 *  known Drive type. */
export function structuredIdFor(name: string): DriveTypeKind | undefined {
  return KIND_BY_DISPLAY_NAME[name];
}

/** The write variant: a name that doesn't resolve is a hard error (the movement
 *  targets a type this adapter doesn't expose — drift). */
export function requireStructuredId(name: string, method: string): DriveTypeKind {
  const kind = structuredIdFor(name);
  if (!kind) {
    throw new Error(`GoogleDriveAdapter.${method}: unrecognised recordType "${name}".`);
  }
  return kind;
}

// ── Display URL helpers (lifted from output_v3/adapters/gdrive.ts) ───────────
// Copied, not imported (P4), so the TG adapter carries its own behavioral
// reference and never reaches into the v3 module.

export function driveUrl(id: string, type: 'folder' | 'file'): string {
  return type === 'folder'
    ? `https://drive.google.com/drive/folders/${id}`
    : `https://drive.google.com/file/d/${id}`;
}
