// Unit tests for the Dropbox TG adapter — pure helpers + mocked-client paths
// only (no network, no LLM). Structural twin of the Google Drive adapter test;
// the divergence is that Dropbox addresses records by PATH. Covers:
//   1. the name → kind map (Folder / File — rules 4/5: one File concept, no
//      system prefix) + rejection of foreign/malformed names.
//   2. listEntryPoints + describe — both nouns readable AND writable; the
//      folder edges (`folders`/`files`) are writable (rule 6); the `parent`
//      up-hop is read-only.
//   3. createRecord — folder (create + by-name reuse), file (inline text +
//      FileRef byte channel), honouring parentLink / `parent` field / the
//      ROOT default (bare create lands at path "").
//   4. create-only updateRecord / deleteRecord throw.
//   5. resolveEntity — always 0 candidates (create-only).
//
// The Dropbox client is faked and the host's files are a map of bytes;
// fake-channels is never hit.

import type { FileRef, ResolveEntityInput, WriteInput, UpdateInput, DeleteInput } from 'movement-engine/public/adapter';

import { DropboxAdapter } from '../adapter';
import {
  DISPLAY_NAME_BY_KIND,
  structuredIdFor,
  requireStructuredId,
  dropboxWebUrl,
} from '../types';

// The pretty type names are the framework identity — a position's
// `recordType` / an entry's `typeId`. No system prefix (rule 5): the
// instance already says which system you're in.
const FOLDER_TYPE = DISPLAY_NAME_BY_KIND.folder;
const FILE_TYPE = DISPLAY_NAME_BY_KIND.file;

// ---------------------------------------------------------------------------
// Fixtures + fake client
// ---------------------------------------------------------------------------

const PARENT_FOLDER = '/Clients';

interface FakeClientCalls {
  findFolder: Array<{ name: string; parentPath: string }>;
  createFolder: Array<{ name: string; parentPath: string }>;
  uploadBytes: Array<{ name: string; parentPath: string; body: string }>;
}

/** The bytes the host holds, by the handle a file value names. */
const HOST_FILES: Record<string, string> = { 'file-1': 'file-bytes' };

function makeAdapter(options?: { existingFolderPath?: string }): {
  adapter: DropboxAdapter;
  calls: FakeClientCalls;
} {
  const calls: FakeClientCalls = {
    findFolder: [],
    createFolder: [],
    uploadBytes: [],
  };
  const fakeClient = {
    findFolder: async (args: { name: string; parentPath: string }) => {
      calls.findFolder.push(args);
      return options?.existingFolderPath ?? null;
    },
    createFolder: async (args: { name: string; parentPath: string }) => {
      calls.createFolder.push(args);
      return { path: `${args.parentPath}/${args.name}` };
    },
    uploadBytes: async (args: { name: string; parentPath: string; bytes: Uint8Array }) => {
      calls.uploadBytes.push({ name: args.name, parentPath: args.parentPath, body: Buffer.from(args.bytes).toString('utf8') });
      return { path: `${args.parentPath}/${args.name}` };
    },
  };
  const adapter = new DropboxAdapter({
    client: async () => fakeClient as never,
    files: {
      read: async (ref: FileRef) => {
        const handle = ref.source !== undefined && 'handle' in ref.source ? ref.source.handle : undefined;
        const bytes = handle !== undefined ? HOST_FILES[handle] : undefined;
        if (bytes === undefined) throw new Error('the host holds no such file');
        return Buffer.from(bytes);
      },
    },
    log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { adapter, calls };
}

// ---------------------------------------------------------------------------
// 1. Name → kind map
// ---------------------------------------------------------------------------

describe('Dropbox name → kind map', () => {
  it('maps each pretty type name to its kind (no system prefix — rule 5)', () => {
    expect(FOLDER_TYPE).toBe('Folder');
    expect(FILE_TYPE).toBe('File');
    expect(structuredIdFor(FOLDER_TYPE)).toBe('folder');
    expect(structuredIdFor(FILE_TYPE)).toBe('file');
  });

  it('returns undefined for an unknown / foreign / retired name', () => {
    expect(structuredIdFor('dropbox:folder')).toBeUndefined();
    // The old system-prefixed names and merged write forms are GONE.
    expect(structuredIdFor('Dropbox Folder')).toBeUndefined();
    expect(structuredIdFor('Dropbox Document')).toBeUndefined();
    expect(structuredIdFor('Dropbox Upload')).toBeUndefined();
    expect(structuredIdFor('Dropbox File')).toBeUndefined();
    expect(structuredIdFor('bogus')).toBeUndefined();
  });

  it('requireStructuredId throws on an unknown name', () => {
    expect(() => requireStructuredId('nope', 'createRecord')).toThrow(
      /unrecognised recordType/,
    );
  });

  it('dropboxWebUrl builds a path-based url', () => {
    expect(dropboxWebUrl('/Clients/Acme')).toBe('https://www.dropbox.com/home/Clients/Acme');
  });
});

// ---------------------------------------------------------------------------
// 2. listEntryPoints + describe
// ---------------------------------------------------------------------------

describe('DropboxAdapter schema introspection', () => {
  it('lists the two nouns, each readable AND writable (rules 4/6)', async () => {
    const { adapter } = makeAdapter();
    const entries = await adapter.listEntryPoints();
    const byId = new Map(entries.map((e) => [e.typeId, e]));
    expect(byId.size).toBe(2);
    expect(byId.get(FOLDER_TYPE)).toMatchObject({
      writable: true,
      readable: true,
      collectionName: 'Folders',
    });
    expect(byId.get(FILE_TYPE)).toMatchObject({
      writable: true,
      readable: true,
      collectionName: 'Files',
    });
  });

  it('describes Folder — Name required, Parent folder an optional write-only pin, writable child edges', async () => {
    const { adapter } = makeAdapter();
    const descriptor = await adapter.describe(FOLDER_TYPE);
    expect(descriptor).not.toBeNull();
    const byId = new Map(descriptor!.fields.map((f) => [f.fieldId, f]));
    expect(byId.get('name')!.required).toBe(true);
    expect(byId.get('name')!.displayName).toBe('Name');
    expect(byId.get('parent')!.required).toBe(false);
    expect(byId.get('parent')!.readable).toBe(false);
    // ONE edge per relationship (rule 6): folders/files read AND create;
    // the `parent` up-hop is read-only (create-only adapter — no move path).
    const refs = new Map(descriptor!.references.map((r) => [r.name, r]));
    expect([...refs.keys()]).toEqual(['Folders', 'Files', 'Parent']);
    expect(refs.get('Folders')!.writable).toBe(true);
    expect(refs.get('Files')!.writable).toBe(true);
    // No write promise on the up-hop: absent IS the read-only fact (layer 13);
    // this adapter still states it explicitly as `false`, which reads the same.
    expect(refs.get('Parent')!.writable).not.toBe(true);
  });

  it('describes File — one File field (read the bytes, write the bytes), read facts alongside', async () => {
    const { adapter } = makeAdapter();
    const file = await adapter.describe(FILE_TYPE);
    const fields = new Map(file!.fields.map((f) => [f.fieldId, f]));
    expect(fields.get('file')!.kind).toBe('file');
    expect(fields.get('file')!.required).toBe(true);
    expect(fields.get('file')!.writable).toBe(true);
    expect(fields.get('file')!.readable).not.toBe(false); // read side: the content FileRef
    expect(fields.get('name')!.required).toBe(false);
    expect(fields.get('path')!.writable).toBe(false);
    expect(fields.get('size')!.writable).toBe(false);
    expect(file!.references.map((r) => r.name)).toEqual(['Parent']);
  });

  it('returns null for a foreign / unknown / retired typeId', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.describe('google-drive:folder')).toBeNull();
    expect(await adapter.describe('Dropbox Document')).toBeNull();
    expect(await adapter.describe('Dropbox Upload')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. createRecord — write paths
// ---------------------------------------------------------------------------

describe('DropboxAdapter.createRecord — folder', () => {
  it('creates a new folder when none exists, using parentLink (the edge anchor)', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      recordType: FOLDER_TYPE,
      fields: { name: 'Acme Corp' },
      mutationContext: {} as never,
      parentLinks: [{ recordType: FOLDER_TYPE, externalId: PARENT_FOLDER, edgeName: 'Folders' }],
    } as WriteInput);

    expect(calls.findFolder).toEqual([{ name: 'Acme Corp', parentPath: PARENT_FOLDER }]);
    expect(calls.createFolder).toEqual([{ name: 'Acme Corp', parentPath: PARENT_FOLDER }]);
    expect(result.externalId).toBe('/Clients/Acme Corp');
    expect(result.data!.url).toBe('https://www.dropbox.com/home/Clients/Acme Corp');
  });

  it('reuses an existing folder found by name (tier-1), skipping create', async () => {
    const { adapter, calls } = makeAdapter({ existingFolderPath: '/Clients/Acme Corp' });
    const result = await adapter.createRecord({
      recordType: FOLDER_TYPE,
      fields: { name: 'Acme Corp', parent: PARENT_FOLDER },
      mutationContext: {} as never,
    } as WriteInput);

    expect(calls.findFolder).toHaveLength(1);
    expect(calls.createFolder).toHaveLength(0);
    expect(result.externalId).toBe('/Clients/Acme Corp');
  });

  it('uses the `parent` field when there is no parentLink (root action pin)', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: FOLDER_TYPE,
      fields: { name: 'Root', parent: '/RootCfg' },
      mutationContext: {} as never,
    } as WriteInput);
    expect(calls.findFolder[0].parentPath).toBe('/RootCfg');
  });

  it('defaults to the Dropbox ROOT (path "") when no parent is given — the root IS a real folder', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      recordType: FOLDER_TYPE,
      fields: { name: 'TopLevel' },
      mutationContext: {} as never,
    } as WriteInput);
    expect(calls.findFolder[0].parentPath).toBe('');
    expect(calls.createFolder[0]).toEqual({ name: 'TopLevel', parentPath: '' });
    expect(result.externalId).toBe('/TopLevel');
  });
});

describe('DropboxAdapter.createRecord — file', () => {
  it('uploads inline text given as the File field', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      recordType: FILE_TYPE,
      fields: { name: 'notes.txt', file: 'hello world' },
      mutationContext: {} as never,
      parentLinks: [{ recordType: FOLDER_TYPE, externalId: PARENT_FOLDER, edgeName: 'Files' }],
    } as WriteInput);

    expect(calls.uploadBytes).toHaveLength(1);
    expect(calls.uploadBytes[0].name).toBe('notes.txt');
    expect(calls.uploadBytes[0].parentPath).toBe(PARENT_FOLDER);
    expect(calls.uploadBytes[0].body).toBe('hello world');
    expect(result.externalId).toBe('/Clients/notes.txt');
  });

  it('uploads the bytes the host reads for a file value, name defaulting from the ref', async () => {
    const { adapter, calls } = makeAdapter();
    const file: FileRef = {
      __brand: 'FileRef',
      name: 'report.pdf',
      contentType: 'application/pdf',
      source: { adapterType: 'email', handle: 'file-1' },
    };

    await adapter.createRecord({
      recordType: FILE_TYPE,
      fields: { file },
      mutationContext: {} as never,
      parentLinks: [{ recordType: FOLDER_TYPE, externalId: PARENT_FOLDER, edgeName: 'Files' }],
    } as WriteInput);

    expect(calls.uploadBytes[0].name).toBe('report.pdf');
    expect(calls.uploadBytes[0].body).toBe('file-bytes');
  });

  it('defaults to the Dropbox ROOT when no parent is given', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      recordType: FILE_TYPE,
      fields: { name: 'top.txt', file: 'x' },
      mutationContext: {} as never,
    } as WriteInput);
    expect(calls.uploadBytes[0].parentPath).toBe('');
    expect(result.externalId).toBe('/top.txt');
  });

  it('throws when the File field is empty', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.createRecord({
        recordType: FILE_TYPE,
        fields: { name: 'x' },
        mutationContext: {} as never,
        parentLinks: [{ recordType: FOLDER_TYPE, externalId: PARENT_FOLDER, edgeName: 'Files' }],
      } as WriteInput),
    ).rejects.toThrow(/`File` field is empty/);
  });
});

describe('DropboxAdapter.createRecord — dispatch', () => {
  it('throws on an unrecognised / retired recordType', async () => {
    const { adapter } = makeAdapter();
    for (const recordType of ['google-drive:folder', 'Dropbox Document', 'Dropbox Upload']) {
      await expect(
        adapter.createRecord({
          recordType,
          fields: {},
          mutationContext: {} as never,
        } as WriteInput),
      ).rejects.toThrow(/unrecognised recordType/);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. create-only update / delete throw
// ---------------------------------------------------------------------------

describe('DropboxAdapter create-only writes', () => {
  it('updateRecord throws a create-only error', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.updateRecord({
        recordType: FOLDER_TYPE,
        externalId: 'whatever',
        fields: {},
        mutationContext: {} as never,
      } as UpdateInput),
    ).rejects.toThrow(/create-only/);
  });

  it('deleteRecord throws a create-only error', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.deleteRecord({
        recordType: FOLDER_TYPE,
        externalId: 'whatever',
        mutationContext: {} as never,
      } as DeleteInput),
    ).rejects.toThrow(/create-only/);
  });
});

// ---------------------------------------------------------------------------
// 5. resolveEntity — bridge-only
// ---------------------------------------------------------------------------

describe('DropboxAdapter.resolveEntity', () => {
  it('returns 0 candidates with no prior bridge (engine creates fresh)', async () => {
    const { adapter } = makeAdapter();
    const result = await adapter.resolveEntity({
      record: { name: 'Acme' },
      recordType: FOLDER_TYPE,
      candidates: [],
      constraints: [],
    } as unknown as ResolveEntityInput);
    expect(result.candidates).toEqual([]);
  });

  it('returns 0 candidates EVEN WITH a prior bridge — Dropbox is create-only, so a candidate would route the engine into updateRecord (which throws)', async () => {
    const { adapter } = makeAdapter();
    const result = await adapter.resolveEntity({
      record: { name: 'Acme' },
      recordType: FOLDER_TYPE,
      candidates: [
        {
          node_id: 'node-1',
          external_id: '/Clients/Acme Corp',
          external_object_type: FOLDER_TYPE,
          created_at: new Date(),
        } as unknown as ResolveEntityInput['candidates'][number],
      ],
      constraints: [],
    } as unknown as ResolveEntityInput);
    expect(result.candidates).toEqual([]);
  });
});
