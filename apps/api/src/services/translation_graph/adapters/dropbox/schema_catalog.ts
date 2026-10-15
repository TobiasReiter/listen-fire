// Dropbox TG adapter — schema introspection. The surface is the two nouns the
// Dropbox API itself has — Folder and File — each ONE type that is both the
// read noun and the create form (adapters/CLAUDE.md rules 4/6: the old
// `Dropbox Document` / `Dropbox Upload` write forms were duplicates of the
// File concept — `files/upload` is the API's single file-creation endpoint,
// and a "text document" is an upload of text/plain bytes). There is no
// per-credential enumeration to do (no API call), so the catalog is static.
//
// The graph (rule 0 — the natural shape; the Dropbox ROOT is a real folder,
// path "", so the root collections are its children and root creates land
// there):
//
//   meta ─[Folders r/w]→ Folder ─[Folders r/w]→ Folder
//        └[Files r/w]──→ File   ←[Files r/w]───┘
//                          └──────[Parent ro]──→ Folder (both carry it)
//
// `Folders`/`Files` are ONE edge each: readable (list children) AND
// creatable (`write folder-[:Files]-> { … }` creates inside that folder —
// the parent folder rides `parentLink.externalId`). The read-only `Parent`
// up-hop is path-derived. The optional `parent` FIELD on each write shape is
// the root-action pin (a Dropbox folder PATH); absent ⇒ the Dropbox root.

import type {
  SchemaEntryPoint,
  SchemaFieldDescriptor,
  SchemaReferenceDescriptor,
  SchemaTypeDescriptor,
} from 'movement-engine/services/translation_graph/types';

import { META_RECORD_TYPE } from 'movement-engine/services/translation_graph/types';
import { DISPLAY_NAME_BY_KIND, structuredIdFor } from './types';

export const DROPBOX_FOLDER_TYPE = DISPLAY_NAME_BY_KIND.folder;
export const DROPBOX_FILE_TYPE = DISPLAY_NAME_BY_KIND.file;
export const DROPBOX_FOLDERS_COLLECTION = 'Folders';
export const DROPBOX_FILES_COLLECTION = 'Files';
export const DROPBOX_FOLDER_EDGES = { folders: 'folders', files: 'files' } as const;
/** The NATURAL names those edges publish — Title Case, the one convention
 *  across every adapter surface. The `fieldId` above stays the adapter's
 *  internal read currency (`getRelated` dispatch); this is what a movement
 *  writes (`folder-[:Files]->`) and what `edgeWriteName` resolves to. */
export const DROPBOX_FOLDER_EDGE_NAMES = { folders: 'Folders', files: 'Files' } as const;
/** The up-hop every file and sub-folder carries to its containing folder —
 *  the reverse of `Folders`/`Files`. Path-derived, so it resolves without a
 *  round trip; an entry directly under the Dropbox root has no Folder node
 *  above it and yields []. */
export const DROPBOX_PARENT_EDGE = 'parent';
export const DROPBOX_PARENT_EDGE_NAME = 'Parent';

function field(
  fieldId: string,
  options: {
    displayName: string;
    kind: SchemaFieldDescriptor['kind'];
    required?: boolean;
    readable?: boolean;
    writable?: boolean;
    description?: string;
  },
): SchemaFieldDescriptor {
  return {
    fieldId,
    displayName: options.displayName,
    kind: options.kind,
    cardinality: 'one',
    writable: options.writable ?? true,
    required: options.required ?? false,
    ...(options.readable === false ? { readable: false } : {}),
    description: options.description,
  };
}

function readOnlyField(
  fieldId: string,
  options: { displayName: string; kind: SchemaFieldDescriptor['kind']; description?: string },
): SchemaFieldDescriptor {
  return field(fieldId, { ...options, writable: false });
}

/** The `parent` field is the ROOT-action pin — a Dropbox folder PATH that
 *  scopes where a root-created record lands. Write-only (a pin, not data —
 *  the containing folder READS via the `Parent` edge). Optional everywhere:
 *  child actions get the parent from `parentLink.externalId` (the enclosing
 *  folder), and a bare root create lands in the Dropbox root. */
const parentField = field('parent', {
  displayName: 'Parent folder',
  kind: 'string',
  readable: false,
  description:
    'Dropbox folder path to create this inside. Optional: a bare create lands ' +
    'in the Dropbox root, and a create along a folder\'s edge inherits that ' +
    'folder automatically.',
});

/** The read-only `Parent` up-hop shared by files and folders. Read-only by
 *  the adapter's own model (create-only, no move/update path) — re-parenting
 *  exists in the API (`files/move_v2`) but is an UPDATE of the child, which
 *  this adapter does not offer. */
const PARENT_REFERENCE: SchemaReferenceDescriptor = {
  fieldId: DROPBOX_PARENT_EDGE,
  targetTypeId: DROPBOX_FOLDER_TYPE,
  cardinality: 'one',
  direction: 'outgoing',
  name: DROPBOX_PARENT_EDGE_NAME,
  writable: false,
};

function describeFolder(): SchemaTypeDescriptor {
  return {
    typeId: DROPBOX_FOLDER_TYPE,
    displayName: DROPBOX_FOLDER_TYPE,
    description:
      'A Dropbox folder. Creating one reuses an existing folder with the same ' +
      'name in the same parent instead of duplicating it.',
    fields: [
      field('name', { displayName: 'Name', kind: 'string', required: true }),
      parentField,
      readOnlyField('path', { displayName: 'Path', kind: 'string' }),
      readOnlyField('url', { displayName: 'Url', kind: 'string' }),
    ],
    references: [
      {
        fieldId: DROPBOX_FOLDER_EDGES.folders,
        targetTypeId: DROPBOX_FOLDER_TYPE,
        cardinality: 'many',
        direction: 'outgoing',
        name: DROPBOX_FOLDER_EDGE_NAMES.folders,
        // One relationship, one edge (rule 6): list the sub-folders AND
        // create one here (`write folder-[:Folders]-> { … }`).
        writable: true,
      },
      {
        fieldId: DROPBOX_FOLDER_EDGES.files,
        targetTypeId: DROPBOX_FILE_TYPE,
        cardinality: 'many',
        direction: 'outgoing',
        name: DROPBOX_FOLDER_EDGE_NAMES.files,
        writable: true,
      },
      PARENT_REFERENCE,
    ],
    uniquenessConstraints: undefined,
    // Create-only with no addressable record — `unique by` can't be honoured,
    // so reject it at author time rather than silently no-op (matches Sheets).
    // Folder creation dedups by (name, parent) natively instead.
    uniquenessAuthorable: false,
  };
}

function describeFile(): SchemaTypeDescriptor {
  return {
    typeId: DROPBOX_FILE_TYPE,
    displayName: DROPBOX_FILE_TYPE,
    description:
      'A file in Dropbox. `File` carries the content — read it as bytes, or ' +
      'set it on a create (a File-typed value, or inline text saved as a ' +
      'plain-text file).',
    fields: [
      field('name', {
        displayName: 'Name',
        kind: 'string',
        description:
          'The file name. Optional on a create — defaults to the file value\'s own name.',
      }),
      field('file', {
        displayName: 'File',
        kind: 'file',
        required: true,
        description:
          'The file content. On a create: a File-typed value (e.g. FILE(…) or ' +
          'a file read from another system) or inline text. On a read: the ' +
          'bytes — feed them to extraction or another upload.',
      }),
      parentField,
      readOnlyField('path', { displayName: 'Path', kind: 'string' }),
      readOnlyField('url', { displayName: 'Url', kind: 'string' }),
      readOnlyField('size', { displayName: 'Size', kind: 'number' }),
    ],
    references: [PARENT_REFERENCE],
    uniquenessConstraints: undefined,
    uniquenessAuthorable: false,
  };
}

// ── listEntryPoints ────────────────────────────────────────────────────────
// Two entries, each readable AND writable: the root collections are the
// Dropbox root folder's children (a real folder), and a root create lands
// there (or where the `parent` field pins).

export async function listEntryPoints(): Promise<SchemaEntryPoint[]> {
  return [
    {
      typeId: DROPBOX_FOLDER_TYPE,
      displayName: DROPBOX_FOLDER_TYPE,
      description: 'A Dropbox folder — list them from the root, create one anywhere.',
      writable: true,
      readable: true,
      collectionName: DROPBOX_FOLDERS_COLLECTION,
    },
    {
      typeId: DROPBOX_FILE_TYPE,
      displayName: DROPBOX_FILE_TYPE,
      description: 'A file in Dropbox — read content, upload new files.',
      writable: true,
      readable: true,
      collectionName: DROPBOX_FILES_COLLECTION,
    },
  ];
}

// ── the root ───────────────────────────────────────────────────────────────

/**
 * The Dropbox root is a REAL folder (path ""), which is why its edges are
 * writable where Drive's are not: a create here lands somewhere that exists,
 * and the read that follows can witness it.
 */
export function rootDescriptor(): SchemaTypeDescriptor {
  return {
    typeId: META_RECORD_TYPE,
    displayName: 'Dropbox',
    description:
      'The connected Dropbox. Its root is a real folder, so `Folders` and ' +
      '`Files` list what is in it — and creating along either edge puts the ' +
      'new item there.',
    fields: [],
    references: [
      {
        fieldId: DROPBOX_FOLDERS_COLLECTION,
        targetTypeId: DROPBOX_FOLDER_TYPE,
        cardinality: 'many',
        direction: 'outgoing',
        name: DROPBOX_FOLDERS_COLLECTION,
        writable: true,
        description: 'Folders at the top of the connected Dropbox.',
      },
      {
        fieldId: DROPBOX_FILES_COLLECTION,
        targetTypeId: DROPBOX_FILE_TYPE,
        cardinality: 'many',
        direction: 'outgoing',
        name: DROPBOX_FILES_COLLECTION,
        writable: true,
        description: 'Files at the top of the connected Dropbox.',
      },
    ],
  };
}

// ── describe ───────────────────────────────────────────────────────────────

export async function describe(input: {
  name: string;
}): Promise<SchemaTypeDescriptor | null> {
  // `name` is the pretty type name (a position's recordType / entry typeId);
  // recover the kind from the static name → kind map.
  const kind = structuredIdFor(input.name);
  if (!kind) return null;
  return kind === 'folder' ? describeFolder() : describeFile();
}
