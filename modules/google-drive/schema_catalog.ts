// Google Drive TG adapter — schema introspection. The surface is the two
// nouns the Drive API itself has — Folder and File — each ONE type that is
// both the read noun and the create form (adapters/CLAUDE.md rules 4/6: the
// old `Drive Document` / `Drive Upload` write forms were duplicates of the
// File concept — `files.create` is the API's single creation endpoint; a
// Google Doc is a file created with the Doc mimeType and imported text).
// There is no per-credential enumeration to do (no API call), so the catalog
// is static.
//
// The graph (rule 0 — the natural shape under the drive.file scope):
//
//   meta ─[Folders ro]→ Folder ─[Folders r/w]→ Folder
//        └[Files ro]──→ File   ←[Files r/w]───┘
//
// The ROOT collections are the credential's GRANTED items (the Picker is the
// only way an item becomes reachable under drive.file — there is no "root"
// listing), and they are READ-ONLY: every create names a real parent folder,
// so creates live on the folder edges (`write folder-[:Folders]->` /
// `write folder-[:Files]->` — the parent rides `parentLink.externalId`). A
// parentless root create would mint a record the granted-items read could
// never show again — the surface must not claim writes it cannot then
// witness (rule 0's second clause).
//
// `Folders`/`Files` are ONE edge each: readable (list children) AND
// creatable (rule 6). Files publish no parent up-hop today — the API offers
// one (`files.get?fields=parents`) but under drive.file the parent may be
// outside the grant; wiring the honest hop is a recorded follow-up
// (plans/2026-07-10-adapter-entry-positions/9_graph_explorer.md).

import type { SchemaEntryPoint, SchemaFieldDescriptor, SchemaTypeDescriptor } from 'movement-engine/public/catalog';

import { META_RECORD_TYPE } from 'movement-engine/public/catalog';
import { DISPLAY_NAME_BY_KIND, structuredIdFor } from './types';

export const DRIVE_FOLDER_TYPE = DISPLAY_NAME_BY_KIND.folder;
export const DRIVE_FILE_TYPE = DISPLAY_NAME_BY_KIND.file;
export const DRIVE_FOLDERS_COLLECTION = 'Folders';
export const DRIVE_FILES_COLLECTION = 'Files';
export const DRIVE_FOLDER_EDGES = { folders: 'folders', files: 'files' } as const;
/** The NATURAL names those edges publish — Title Case, the one convention
 *  across every adapter surface. The `fieldId` above stays the adapter's
 *  internal read currency (`getRelated` dispatch); this is what a movement
 *  writes (`folder-[:Files]->`) and what `edgeWriteName` resolves to. */
export const DRIVE_FOLDER_EDGE_NAMES = { folders: 'Folders', files: 'Files' } as const;

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

function describeFolder(): SchemaTypeDescriptor {
  return {
    typeId: DRIVE_FOLDER_TYPE,
    displayName: DRIVE_FOLDER_TYPE,
    description:
      'A Google Drive folder. Creating one reuses an existing folder with the ' +
      'same name in the same parent instead of duplicating it. Create folders ' +
      'inside a connected folder (`write folder-[:Folders]-> { … }`).',
    fields: [
      field('name', { displayName: 'Name', kind: 'string', required: true }),
      readOnlyField('id', { displayName: 'Id', kind: 'string' }),
      readOnlyField('url', { displayName: 'Url', kind: 'string' }),
    ],
    references: [
      {
        fieldId: DRIVE_FOLDER_EDGES.folders,
        targetTypeId: DRIVE_FOLDER_TYPE,
        cardinality: 'many',
        direction: 'outgoing',
        name: DRIVE_FOLDER_EDGE_NAMES.folders,
        // One relationship, one edge (rule 6): list the sub-folders AND
        // create one here (`write folder-[:Folders]-> { … }`).
        writable: true,
      },
      {
        fieldId: DRIVE_FOLDER_EDGES.files,
        targetTypeId: DRIVE_FILE_TYPE,
        cardinality: 'many',
        direction: 'outgoing',
        name: DRIVE_FOLDER_EDGE_NAMES.files,
        writable: true,
      },
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
    typeId: DRIVE_FILE_TYPE,
    displayName: DRIVE_FILE_TYPE,
    description:
      'A file in Google Drive. On a create (along a folder\'s `Files` edge), ' +
      'provide EITHER `File` (upload bytes) OR `Content` (text imported as a ' +
      'Google Doc) — not both. `File` reads the content back as bytes.',
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
        description:
          'The file content. On a create: a File-typed value (e.g. FILE(…) or ' +
          'a file read from another system) or inline text uploaded as-is. On ' +
          'a read: the bytes — Docs-native files cannot be fetched this way ' +
          '(export is a recorded follow-up).',
      }),
      field('content', {
        displayName: 'Content',
        kind: 'string',
        readable: false,
        description:
          'Text imported as a Google Doc (the doc body). Write-only — a ' +
          'Doc\'s text cannot be read back through this adapter today. ' +
          'Provide either Content or File, not both.',
      }),
      readOnlyField('id', { displayName: 'Id', kind: 'string' }),
      readOnlyField('mimeType', { displayName: 'Mime Type', kind: 'string' }),
      readOnlyField('url', { displayName: 'Url', kind: 'string' }),
      readOnlyField('size', { displayName: 'Size', kind: 'number' }),
    ],
    references: [],
    uniquenessConstraints: undefined,
    uniquenessAuthorable: false,
  };
}

// ── listEntryPoints ────────────────────────────────────────────────────────
// Two entries, both READ-ONLY at the root (the granted items); creation
// lives on the folder edges, where the parent is real.

export async function listEntryPoints(): Promise<SchemaEntryPoint[]> {
  return [
    {
      typeId: DRIVE_FOLDER_TYPE,
      displayName: DRIVE_FOLDER_TYPE,
      description:
        'A Google Drive folder this connection has been granted. Create new ' +
        'folders inside one via its `Folders` edge.',
      writable: false,
      readable: true,
      collectionName: DRIVE_FOLDERS_COLLECTION,
    },
    {
      typeId: DRIVE_FILE_TYPE,
      displayName: DRIVE_FILE_TYPE,
      description:
        'A file in Google Drive (granted at the root; create new files inside ' +
        'a folder via its `Files` edge).',
      writable: false,
      readable: true,
      collectionName: DRIVE_FILES_COLLECTION,
    },
  ];
}

// ── the root ───────────────────────────────────────────────────────────────

/**
 * What a Drive connection IS, and the edges leaving it: the GRANTED items.
 * Under `drive.file` the Picker is the only way something becomes reachable,
 * so there is no "everything in Drive" to offer — and both root edges are
 * READ-ONLY, because every create names a real parent folder and lives on the
 * folder edges instead.
 */
export function rootDescriptor(): SchemaTypeDescriptor {
  return {
    typeId: META_RECORD_TYPE,
    displayName: 'Google Drive',
    description:
      'The Drive items this connection has been granted. Nothing else in the ' +
      'account is visible — granting happens through the Google picker. ' +
      'Create inside a folder via its `Folders` / `Files` edges.',
    fields: [],
    references: [
      {
        fieldId: DRIVE_FOLDERS_COLLECTION,
        targetTypeId: DRIVE_FOLDER_TYPE,
        cardinality: 'many',
        direction: 'outgoing',
        name: DRIVE_FOLDERS_COLLECTION,
        description: 'Folders this connection has been granted.',
        // The grants table is read `.orderBy('created_at', 'asc')` and this hop
        // only filters it — so these arrive in the order they were granted.
        sequenced: 'arrival',
      },
      {
        fieldId: DRIVE_FILES_COLLECTION,
        targetTypeId: DRIVE_FILE_TYPE,
        cardinality: 'many',
        direction: 'outgoing',
        name: DRIVE_FILES_COLLECTION,
        description: 'Files this connection has been granted.',
        // Same grants table, same `.orderBy('created_at', 'asc')`.
        sequenced: 'arrival',
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
