// A fake Airtable for the adapter's unit tests: the real AirtableAdapter over
// a fake client (bases, tables, rows) that records its writes, and files the
// host exposes at a fixed URL. Shared with the platform's tests that run the
// adapter through its own projection.

import type { FileRef } from 'movement-engine/public/adapter';

import { AirtableAdapter } from '../adapter';

/** The client every test replaces. */
async function noClient(): Promise<never> {
  throw new Error('this test replaces the client');
}

/** Files the host holds, by handle; an exposed one is served at one URL. */
const heldFiles = new Map<string, Uint8Array>();
export const testFiles = {
  put: async (): Promise<never> => {
    throw new Error('no put in this test');
  },
  read: async (ref: FileRef): Promise<Uint8Array> => {
    const source = ref.source;
    const bytes = source !== undefined && 'handle' in source && typeof source.handle === 'string' ? heldFiles.get(source.handle) : undefined;
    if (bytes === undefined) throw new Error(`no such file: ${ref.name ?? '(unnamed)'}`);
    return bytes;
  },
  expose: async (ref: FileRef): Promise<{ url: string }> => {
    await testFiles.read(ref);
    return { url: 'https://example.test/api/files/blob/blob-1' };
  },
};

export function testFileStore(): { file(text: string, meta: { name: string; contentType: string }): FileRef } {
  return {
    file(text, meta) {
      const handle = `held-${heldFiles.size + 1}`;
      heldFiles.set(handle, new TextEncoder().encode(text));
      return { __brand: 'FileRef', ...meta, source: { adapterType: 'test', handle } };
    },
  };
}

export const BASE_ID = 'appBASE01';
export const TABLE_ID = 'tblDEALS01';
export const LINKED_TABLE_ID = 'tblPEOPLE1';

// The NATURAL type name the adapter publishes for the Deals table: its OWN
// name. A table lives behind its base and naming one needs a base, so the base
// is the instance and never repeated in the name.
// plans/2026-07-10-adapter-entry-positions/5_paths_as_addresses.md
export const DEALS_TYPE = 'Deals';
// The People table's natural name — what a reference to it (and a `getRelated`
// landing on it) is stamped with, instead of an encoded id.
export const PEOPLE_TYPE = 'People';

export type FakeRecord = { id: string; fields: Record<string, unknown> };

export function dealsTable() {
  return {
    id: TABLE_ID,
    name: 'Deals',
    primaryFieldId: 'fldName',
    fields: [
      { id: 'fldName', name: 'Name', type: 'singleLineText' },
      { id: 'fldAmount', name: 'Amount', type: 'currency' },
      { id: 'fldClosed', name: 'Closed', type: 'checkbox' },
      { id: 'fldTags', name: 'Tags', type: 'multipleSelects' },
      { id: 'fldCreated', name: 'Created', type: 'createdTime' },
      { id: 'fldFormula', name: 'Score', type: 'formula' },
      { id: 'fldDeck', name: 'Deck', type: 'multipleAttachments' },
      {
        id: 'fldOwner',
        name: 'Owner',
        type: 'multipleRecordLinks',
        options: { linkedTableId: LINKED_TABLE_ID },
      },
    ],
  };
}

export function peopleTable() {
  return {
    id: LINKED_TABLE_ID,
    name: 'People',
    primaryFieldId: 'fldPersonName',
    fields: [{ id: 'fldPersonName', name: 'Full Name', type: 'singleLineText' }],
  };
}

export interface FakeClientCalls {
  createRecord: Array<{ baseId: string; tableId: string; fields: Record<string, unknown> }>;
  listRecords: Array<{ baseId: string; tableId: string; filterByFormula?: string }>;
}

export function makeAdapter(input?: { records?: FakeRecord[] }): {
  adapter: AirtableAdapter;
  calls: FakeClientCalls;
} {
  const adapter = new AirtableAdapter({ tenant: 'team-air', client: noClient, files: testFiles });
  const calls: FakeClientCalls = { createRecord: [], listRecords: [] };
  const fakeClient = {
    listBases: async () => [{ id: BASE_ID, name: 'CRM' }],
    listTables: async ({ baseId }: { baseId: string }) =>
      baseId === BASE_ID ? [dealsTable(), peopleTable()] : [],
    listRecords: async (args: { baseId: string; tableId: string; filterByFormula?: string }) => {
      calls.listRecords.push(args);
      return input?.records ?? [];
    },
    getRecord: async ({ recordId }: { recordId: string }) => ({
      id: recordId,
      fields: { fldName: 'Fetched' },
    }),
    createRecord: async (args: { baseId: string; tableId: string; fields: Record<string, unknown> }) => {
      calls.createRecord.push(args);
      return { id: 'recNEW01', fields: args.fields };
    },
    updateRecord: async (args: { recordId: string; fields: Record<string, unknown> }) => ({
      id: args.recordId,
      fields: args.fields,
    }),
    deleteRecord: async ({ recordId }: { recordId: string }) => ({ id: recordId, deleted: true }),
  };
  (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient = async () =>
    fakeClient;
  return { adapter, calls };
}

export function tasksTable() {
  return { id: 'tblTASKS01', name: 'Tasks', primaryFieldId: 'fldTask', fields: [] };
}

/** A multi-base fake client — each test uses a UNIQUE teamId so the module-level
 *  base/table LRU caches (keyed by team) never leak between cases. */
export function makeMultiBaseAdapter(input: {
  teamId: string;
  bases: Array<{ id: string; name: string; tables: ReturnType<typeof dealsTable>[] }>;
  base?: string;
  /** Rows the collection read lists back. */
  records?: FakeRecord[];
}): { adapter: AirtableAdapter; listedTableBaseIds: string[] } {
  const adapter = new AirtableAdapter({
    tenant: input.teamId,
    client: noClient,
    files: testFiles,
    ...(input.base !== undefined ? { base: input.base } : {}),
  });
  const listedTableBaseIds: string[] = [];
  const fakeClient = {
    listBases: async () => input.bases.map((b) => ({ id: b.id, name: b.name })),
    listTables: async ({ baseId }: { baseId: string }) => {
      listedTableBaseIds.push(baseId);
      return input.bases.find((b) => b.id === baseId)?.tables ?? [];
    },
    listRecords: async () => input.records ?? [],
  };
  (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient = async () =>
    fakeClient;
  return { adapter, listedTableBaseIds };
}
