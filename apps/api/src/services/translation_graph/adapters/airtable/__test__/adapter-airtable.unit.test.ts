// Unit tests for the Airtable TG adapter — pure helpers + mocked-client paths
// only (no network, no LLM). Covers:
//   1. the name → structured-identifier cache: a recordType NAMED by its
//      displayName resolves to its `{ baseId, tableId }` and routes correctly.
//   2. coerceAirtableValue per Airtable field type.
//   3. describe — field/reference/writable mapping against a mocked listTables.
//   4. resolveEntity — filterByFormula building from constraints (exact branch)
//      against a mocked listRecords, with allEntriesExact attribution.
//   5. a write that filters read-only fields + coerces values.
//
// The API client is mocked by overriding the adapter's private getApiClient;
// fake-channels is never hit. Module-scope deps that crash at load (credentials
// master key, logger → casl, the broken zod chain) are stubbed exactly as the
// Attio adapter test does.

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

jest.mock('../../../../logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

// The real Airtable apiClient pulls in the adapters registry / token-refresh
// chain that crashes at module load in jest. The adapter under test only
// references `AirtableAPIClient` (a class — unused as a value here, since
// getApiClient is overridden) + `getAirtableClient` (never called). Stub both.
jest.mock('../../../../../adapters/airtable/apiClient', () => ({
  AirtableAPIClient: class {},
  getAirtableClient: () => ({}),
}));

// types.ts transitively loads the broken output_v3/schemas zod chain. Stub at
// the leaf — the adapter consumes it only at type level.
jest.mock('../../../../knowledge_pipeline/output_v3/schemas', () => {
  const stub: Record<string, unknown> = {};
  const ret = () => stub;
  Object.assign(stub, {
    optional: ret, nullable: ret, default: ret, array: ret,
    parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }),
    refine: ret, transform: ret, extend: ret, merge: ret,
    pick: ret, omit: ret, partial: ret, describe: ret, or: ret, and: ret, min: ret,
  });
  return {
    traversalStepSchema: stub,
    fieldRefSchema: stub,
    expressionSchema: stub,
    filterExpressionSchema: stub,
    webhookGraphOutputConfigSchema: stub,
  };
});

// uniqueness_constraints — the record module imports `isEdgeToEntry` (used in
// branch building) + the type-level StoredUniquenessConstraints. The real
// module's transitive zod import crashes at load. Provide a faithful
// `isEdgeToEntry` (checks `kind === 'edge_to'`) so resolveEntity's branch
// logic is exercised correctly.
jest.mock('../../../../knowledge_pipeline/uniqueness_constraints', () => {
  const stub: Record<string, unknown> = {};
  const ret = () => stub;
  Object.assign(stub, {
    optional: ret, nullable: ret, default: ret, array: ret,
    parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }),
    refine: ret, transform: ret,
  });
  return {
    isEdgeToEntry: (entry: { kind?: string }) => entry?.kind === 'edge_to',
    storedUniquenessConstraintsSchema: stub,
  };
});

// Attachment writes pull the FileRef's bytes and expose them at a short-lived
// Listen-Fire URL (`exposeFile` → S3 + DB). Stub it so the test asserts the wiring
// (FileRef → exposeFile → attachment url) without real S3/Postgres.
jest.mock('../../../engine/files/expose', () => ({
  exposeFile: jest.fn(async () => ({
    url: 'https://example.test/api/files/blob/blob-1',
    expiresAt: new Date(0),
  })),
}));

import { installMemoryDocumentStore } from '../../../engine/files/__test__/memory_document_store';
import { AirtableAdapter } from '../index';
import { coerceAirtableValue } from '../record';
import { makeStablePosition, makeMetaPosition, makeUnstablePosition, positionData } from '../../../types';
import { eventsFromPayload } from '../webhook';
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { ResolveEntityInput } from '../../../adapter';
import { instanceSchemaFromDescriptors } from '../../../movement/schema_projection';
import { refineInstanceSchema } from '../../../movement/refinements';
import { scanInstanceChains } from 'movement-lang';

// ---------------------------------------------------------------------------
// Fake API client + table fixtures
// ---------------------------------------------------------------------------

const BASE_ID = 'appBASE01';
const TABLE_ID = 'tblDEALS01';
const LINKED_TABLE_ID = 'tblPEOPLE1';

// The NATURAL type name the adapter publishes for the Deals table: its OWN
// name. A table lives behind its base and naming one needs a base, so the base
// is the instance and never repeated in the name.
// plans/2026-07-10-adapter-entry-positions/5_paths_as_addresses.md
const DEALS_TYPE = 'Deals';
// The People table's natural name — what a reference to it (and a `getRelated`
// landing on it) is stamped with, instead of an encoded id.
const PEOPLE_TYPE = 'People';

type FakeRecord = { id: string; fields: Record<string, unknown> };

function dealsTable() {
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

function peopleTable() {
  return {
    id: LINKED_TABLE_ID,
    name: 'People',
    primaryFieldId: 'fldPersonName',
    fields: [{ id: 'fldPersonName', name: 'Full Name', type: 'singleLineText' }],
  };
}

interface FakeClientCalls {
  createRecord: Array<{ baseId: string; tableId: string; fields: Record<string, unknown> }>;
  listRecords: Array<{ baseId: string; tableId: string; filterByFormula?: string }>;
}

function makeAdapter(input?: { records?: FakeRecord[] }): {
  adapter: AirtableAdapter;
  calls: FakeClientCalls;
} {
  const adapter = new AirtableAdapter({
    teamId: 'team-air' as TeamId,
    credentialsId: 'creds-1',
  });
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

// ---------------------------------------------------------------------------
// 1. Name → structured-identifier cache
// ---------------------------------------------------------------------------
// The recordType carried on positions is the pretty NAME (`"<Base> — <Table>"`);
// the adapter recovers `{ baseId, tableId }` from it privately. These prove the
// name routes to the right base/table on read, and an unknown name degrades
// gracefully (read) / fails loud (write) without any magic-string codec.

describe('Airtable name → structured-id routing', () => {
  it('routes a NAMED recordType to its base/table on a read', async () => {
    const { adapter, calls } = makeAdapter({
      records: [{ id: 'recA', fields: { fldName: 'Acme' } }],
    });
    await adapter.resolveEntity({
      record: { Name: 'Acme' },
      recordType: DEALS_TYPE,
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Name' }] }] } as never,
    });
    // The name resolved to the Deals base/table — never an encoded string.
    expect(calls.listRecords[0].baseId).toBe(BASE_ID);
    expect(calls.listRecords[0].tableId).toBe(TABLE_ID);
  });

  it('degrades to no candidates for an unknown recordType name (read)', async () => {
    const { adapter, calls } = makeAdapter({ records: [] });
    const result = await adapter.resolveEntity({
      record: { Name: 'Acme' },
      recordType: 'Nonexistent',
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Name' }] }] } as never,
    });
    expect(result.candidates).toHaveLength(0);
    expect(calls.listRecords).toHaveLength(0);
  });

  it('fails loud for an unknown recordType name (write)', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.createRecord({
        recordType: 'Nonexistent',
        fields: { Name: 'x' },
        mutationContext: {} as never,
      }),
    ).rejects.toThrow(/unrecognised recordType/);
  });
});

// ---------------------------------------------------------------------------
// 2. coerceAirtableValue
// ---------------------------------------------------------------------------

describe('coerceAirtableValue', () => {
  it('coerces numeric types via Number()', () => {
    expect(coerceAirtableValue('42', 'currency')).toBe(42);
    expect(coerceAirtableValue(7, 'number')).toBe(7);
    expect(coerceAirtableValue('not-a-number', 'rating')).toBeNull();
  });

  it('coerces checkbox truthiness strings', () => {
    expect(coerceAirtableValue('yes', 'checkbox')).toBe(true);
    expect(coerceAirtableValue('1', 'checkbox')).toBe(true);
    expect(coerceAirtableValue('no', 'checkbox')).toBe(false);
    expect(coerceAirtableValue(true, 'checkbox')).toBe(true);
  });

  it('splits a comma string into an array for multipleSelects', () => {
    expect(coerceAirtableValue('a, b,c', 'multipleSelects')).toEqual(['a', 'b', 'c']);
    expect(coerceAirtableValue(['x'], 'multipleSelects')).toEqual(['x']);
  });

  it('normalises a date/dateTime value to ISO', () => {
    expect(coerceAirtableValue('2026-06-18', 'date')).toBe('2026-06-18T00:00:00.000Z');
    expect(coerceAirtableValue(new Date('2026-06-18T00:00:00Z'), 'dateTime')).toBe(
      '2026-06-18T00:00:00.000Z',
    );
    // unparseable date passes through untouched
    expect(coerceAirtableValue('not-a-date', 'date')).toBe('not-a-date');
  });

  it('passes strings + unknown types through unchanged', () => {
    expect(coerceAirtableValue('hello', 'singleLineText')).toBe('hello');
    expect(coerceAirtableValue('v', undefined)).toBe('v');
  });
});

// ---------------------------------------------------------------------------
// 3. describe
// ---------------------------------------------------------------------------

describe('AirtableAdapter.describe', () => {
  it('maps fields, references, and writable flags', async () => {
    const { adapter } = makeAdapter();
    // describe is reached by the table's NATURAL name now (== its typeId).
    const descriptor = await adapter.describe(DEALS_TYPE);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.displayName).toBe('Deals');
    expect(descriptor!.labelTemplate).toBe('{fldName}');
    expect(descriptor!.uniquenessConstraints).toBeUndefined();

    const byId = new Map(descriptor!.fields.map((f) => [f.fieldId, f]));
    expect(byId.get('fldName')!.kind).toBe('string');
    expect(byId.get('fldName')!.writable).toBe(true);
    expect(byId.get('fldAmount')!.kind).toBe('number');
    expect(byId.get('fldClosed')!.kind).toBe('boolean');
    expect(byId.get('fldTags')!.kind).toBe('string');
    expect(byId.get('fldTags')!.cardinality).toBe('many');
    expect(byId.get('fldCreated')!.kind).toBe('date');
    // Read-only field types are surfaced but writable:false.
    expect(byId.get('fldCreated')!.writable).toBe(false);
    expect(byId.get('fldFormula')!.writable).toBe(false);
    // multipleAttachments is a first-class, WRITABLE File field.
    expect(byId.get('fldDeck')!.kind).toBe('file');
    expect(byId.get('fldDeck')!.cardinality).toBe('many');
    expect(byId.get('fldDeck')!.writable).toBe(true);

    // multipleRecordLinks becomes a reference to the linked table's NAME.
    expect(descriptor!.references).toHaveLength(1);
    const ref = descriptor!.references[0];
    expect(ref.fieldId).toBe('fldOwner');
    expect(ref.targetTypeId).toBe(PEOPLE_TYPE);
  });

  it('returns null for a foreign / unknown type name', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.describe('attio:companies')).toBeNull();
    expect(await adapter.describe('Missing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. resolveEntity — exact-branch filterByFormula
// ---------------------------------------------------------------------------

// One uniqueness constraint = an AND of `{ field, fuzzy? }` entries. The
// opaque shape is OR-of-AND, so the helper wraps the single AND-branch.
function constraints(entries: Array<{ fieldId: string; fuzzy?: boolean }>): ResolveEntityInput['constraints'] {
  return {
    any: [{ all: entries.map((e) => ({ field: e.fieldId, fuzzy: e.fuzzy })) }],
  };
}

describe('AirtableAdapter.resolveEntity', () => {
  it('builds a {fieldName} = "value" formula from an exact constraint and attributes exactness', async () => {
    const { adapter, calls } = makeAdapter({
      records: [{ id: 'recA', fields: { fldName: 'Acme', fldAmount: 100 } }],
    });
    const input: ResolveEntityInput = {
      // NATURAL currency: type displayName + field displayNames (the Airtable
      // field names). The adapter resolves them to the encoded typeId + `fld…`
      // ids before the record layer runs.
      record: { Name: 'Acme' },
      recordType: DEALS_TYPE,
      candidates: [],
      constraints: constraints([{ fieldId: 'Name' }]) as unknown as ResolveEntityInput['constraints'],
    };
    const result = await adapter.resolveEntity(input);

    // The formula uses the field NAME, not the id, and exact equality.
    expect(calls.listRecords).toHaveLength(1);
    expect(calls.listRecords[0].filterByFormula).toBe('{Name} = "Acme"');

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].externalId).toBe('recA');
    // data is keyed by field name.
    expect(result.candidates[0].data.Name).toBe('Acme');
  });

  it('ANDs multi-entry branches and marks fuzzy entries non-exact', async () => {
    const { adapter, calls } = makeAdapter({ records: [] });
    const input: ResolveEntityInput = {
      record: { Name: 'Acme', Amount: 100 },
      recordType: DEALS_TYPE,
      candidates: [],
      constraints: constraints([
        { fieldId: 'Name', fuzzy: true },
        { fieldId: 'Amount' },
      ]) as unknown as ResolveEntityInput['constraints'],
    };
    await adapter.resolveEntity(input);
    expect(calls.listRecords[0].filterByFormula).toBe('AND({Name} = "Acme",{Amount} = "100")');
  });

  it('escapes quotes/backslashes in constraint values', async () => {
    const { adapter, calls } = makeAdapter({ records: [] });
    const input: ResolveEntityInput = {
      record: { Name: 'A "quoted" \\ name' },
      recordType: DEALS_TYPE,
      candidates: [],
      constraints: constraints([{ fieldId: 'Name' }]) as unknown as ResolveEntityInput['constraints'],
    };
    await adapter.resolveEntity(input);
    expect(calls.listRecords[0].filterByFormula).toBe('{Name} = "A \\"quoted\\" \\\\ name"');
  });

  it('prefers a linked_object bridge over a constraint search', async () => {
    const { adapter, calls } = makeAdapter({ records: [] });
    const input: ResolveEntityInput = {
      record: { Name: 'Acme' },
      recordType: DEALS_TYPE,
      candidates: [
        {
          node_id: 'node-1',
          external_id: 'recBRIDGED',
          // `external_object_type` is the record-type label the engine persisted
          // when it bridged this record — the position's recordType, which is
          // the pretty NAME now (the engine speaks natural names end-to-end).
          external_object_type: DEALS_TYPE,
          created_at: new Date(),
        } as unknown as ResolveEntityInput['candidates'][number],
      ],
      constraints: constraints([{ fieldId: 'Name' }]) as unknown as ResolveEntityInput['constraints'],
    };
    const result = await adapter.resolveEntity(input);
    expect(calls.listRecords).toHaveLength(0); // bridge short-circuits the search
    // The bridge candidate carries the external id; the KG node is no longer
    // surfaced per-candidate (the engine derives the bridge from externalId).
    expect(result.candidates[0].externalId).toBe('recBRIDGED');
  });
});

// ---------------------------------------------------------------------------
// 5. createRecord — read-only filtering + coercion
// ---------------------------------------------------------------------------

describe('AirtableAdapter.createRecord', () => {
  it('filters read-only fields and coerces values to their field type', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      // NATURAL currency: type displayName + field displayNames (the Airtable
      // field names). The adapter resolves each to its internal `fld…` id
      // before the write builder coerces + filters read-only fields.
      recordType: DEALS_TYPE,
      fields: {
        Name: 'New Deal',
        Amount: '250', // currency → Number
        Closed: 'yes', // checkbox → true
        Score: 'computed', // formula → read-only → dropped
        Created: '2026-01-01', // createdTime → read-only → dropped
        // No such field on the table — an unmapped name falls through
        // unresolved; its null value is dropped regardless.
        fldNull: null, // null → dropped
      },
      mutationContext: {} as never,
    });

    expect(calls.createRecord).toHaveLength(1);
    const written = calls.createRecord[0].fields;
    expect(written.fldName).toBe('New Deal');
    expect(written.fldAmount).toBe(250);
    expect(written.fldClosed).toBe(true);
    expect(written).not.toHaveProperty('fldFormula');
    expect(written).not.toHaveProperty('fldCreated');
    expect(written).not.toHaveProperty('fldNull');

    expect(result.externalId).toBe('recNEW01');
    // buildRecordData surfaces a flat {name, url}.
    expect(result.data!.url).toBe(`https://airtable.com/${BASE_ID}/${TABLE_ID}/recNEW01`);
    expect(result.data!.name).toBe('New Deal');
  });
});

// ---------------------------------------------------------------------------
// 6. Link-field resolution — element-wise (ids pass through, names resolve)
// ---------------------------------------------------------------------------

describe('AirtableAdapter link-field write resolution', () => {
  const people = [{ id: 'recAlice', fields: { 'Full Name': 'Alice' } }];

  it('resolves a link NAME to a record id', async () => {
    const { adapter, calls } = makeAdapter({ records: people });
    await adapter.createRecord({
      recordType: DEALS_TYPE,
      fields: { Name: 'D', Owner: ['Alice'] },
      mutationContext: {} as never,
    });
    expect(calls.createRecord[0].fields.fldOwner).toEqual(['recAlice']);
  });

  it('handles a MIXED list (record ids + names) and de-dupes — the shape a `+:` append hands the adapter', async () => {
    const { adapter, calls } = makeAdapter({ records: people });
    await adapter.createRecord({
      recordType: DEALS_TYPE,
      // recBob is already-resolved (passes through); Alice is a name (resolves);
      // recBob is duplicated (de-duped). This is exactly current-ids ++ new-name.
      fields: { Name: 'D', Owner: ['recBob', 'Alice', 'recBob'] },
      mutationContext: {} as never,
    });
    expect(calls.createRecord[0].fields.fldOwner).toEqual(['recBob', 'recAlice']);
  });

  it('a pure list of already-resolved ids passes through (no lookup)', async () => {
    const { adapter, calls } = makeAdapter({ records: people });
    await adapter.createRecord({
      recordType: DEALS_TYPE,
      fields: { Name: 'D', Owner: ['recX', 'recY'] },
      mutationContext: {} as never,
    });
    expect(calls.createRecord[0].fields.fldOwner).toEqual(['recX', 'recY']);
    expect(calls.listRecords).toHaveLength(0); // no name to resolve
  });
});

// ---------------------------------------------------------------------------
// 7. Attachment write — FileRef → Airtable [{ url, filename }]
// ---------------------------------------------------------------------------

describe('AirtableAdapter attachment write', () => {
  it('exposes a FileRef\'s bytes at a Listen-Fire URL and maps it to an Airtable attachment object', async () => {
    const { adapter, calls } = makeAdapter();
    const store = installMemoryDocumentStore();
    await adapter.createRecord({
      recordType: DEALS_TYPE,
      fields: {
        Name: 'D',
        Deck: [store.file('pdf-bytes', { name: 'deck.pdf', contentType: 'application/pdf' })],
      },
      mutationContext: {} as never,
    });
    expect(calls.createRecord[0].fields.fldDeck).toEqual([
      { url: 'https://example.test/api/files/blob/blob-1', filename: 'deck.pdf' },
    ]);
  });

  it('drops an unresolvable file (no URL) and leaves the field unwritten rather than clearing it', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: DEALS_TYPE,
      fields: { Name: 'D', Deck: [{ name: 'no-url.pdf' }] },
      mutationContext: {} as never,
    });
    expect(calls.createRecord[0].fields).not.toHaveProperty('fldDeck');
  });
});

// ---------------------------------------------------------------------------
// 8. getRelated — landings are stamped with the linked table's NAME
// ---------------------------------------------------------------------------
// Proves an EMITTED position carries the linked table's pretty displayName
// (`"People"`) rather than an encoded id — so a chained hop resolves it
// straight back through the same name → structured-id cache.

// ---------------------------------------------------------------------------
// 9. Entry-position (`base:`) scoping — the large-workspace escape hatch
// ---------------------------------------------------------------------------
// Positioning at a base narrows introspection to that ONE base, so a big
// workspace's tables surface without walking every base. Unpositioned keeps the
// pre-existing full-workspace walk (no migration pressure on existing
// movements). The `base:` value enum is the `Base` collection off the meta root.

function tasksTable() {
  return { id: 'tblTASKS01', name: 'Tasks', primaryFieldId: 'fldTask', fields: [] };
}

/** A multi-base fake client — each test uses a UNIQUE teamId so the module-level
 *  base/table LRU caches (keyed by team) never leak between cases. */
function makeMultiBaseAdapter(input: {
  teamId: string;
  bases: Array<{ id: string; name: string; tables: ReturnType<typeof dealsTable>[] }>;
  base?: string;
  /** Rows the collection read lists back. */
  records?: FakeRecord[];
}): { adapter: AirtableAdapter; listedTableBaseIds: string[] } {
  const adapter = new AirtableAdapter({
    teamId: input.teamId as TeamId,
    credentialsId: 'creds-1',
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

describe('AirtableAdapter entry-position (base) scoping', () => {
  const crm = () => ({ id: 'appCRM01', name: 'CRM', tables: [dealsTable()] });
  const ops = () => ({ id: 'appOPS01', name: 'Ops', tables: [tasksTable()] });

  // Two bases hold different tables, so they are two TYPES, not two instances
  // of one — each gets its own type-edge off the root, and the tables live
  // behind them. plans/2026-07-10-adapter-entry-positions/2_type_space.md.
  it('unpositioned → the polymorphic `Base` edge, and nothing walked at all', async () => {
    const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
      teamId: 'team-air-full',
      bases: [crm(), ops()],
    });
    const entries = await adapter.listEntryPoints();
    // `Record Change` is the EVENT edge — on the meta node, behind no base,
    // because a listen hands you the event rather than you walking to it.
    // `Base` is the ONE presentation of the bases: the named per-base edges
    // were dropped — narrowing (`WHERE `Name` == …`) replaces naming.
    expect(entries.map((e) => e.displayName)).toEqual(['Record Change', 'Base']);
    // Both entries are static facts, so the unpositioned root walks NOTHING —
    // not even `listBases` (the walk pays that when someone follows the edge).
    expect(listedTableBaseIds).toEqual([]);
  });

  it('a base is readable but never writable — you write a row, not a base', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-rw', bases: [crm(), ops()] });
    const entries = await adapter.listEntryPoints();
    const bases = entries.filter((e) => e.fires !== true);
    expect(bases.every((e) => e.readable && !e.writable)).toBe(true);
  });

  // The event edge says two true things at once. You cannot enumerate the
  // changes that have happened — only be told of one — so the ROOT does not
  // offer it for reads. Its whole promise is `fires`, and THE EVENT IS JUST A
  // NODE: the change kind is the node's own `action` enum field, not a
  // synthesized variant set. plans/2026-07-10-adapter-entry-positions/8_event_edges.md
  it('the event edge is neither readable nor writable — a listen delivers it', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-ev', bases: [crm(), ops()] });
    const entries = await adapter.listEntryPoints();
    const event = entries.find((e) => e.displayName === 'Record Change');
    expect(event).toBeDefined();
    expect(event?.readable).toBe(false);
    expect(event?.writable).toBe(false);
    // The declaration that makes it reachable at all.
    expect(event?.fires).toBe(true);
    // The change-kind axis is an ORDINARY FIELD on the node — the `events:`
    // vocabulary verbatim, one namespace, nothing translated.
    const described = await adapter.describe('Record Change');
    const action = described?.fields.find((f) => f.fieldId === 'action');
    expect(action?.kind).toBe('enum');
    expect(action?.enumValues).toEqual(['record.created', 'record.updated', 'record.deleted']);
  });

  it('positioned at a base → only that base\'s tables, and only that base is walked', async () => {
    const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
      teamId: 'team-air-pos',
      bases: [crm(), ops()],
      base: 'Ops',
    });
    const entries = await adapter.listEntryPoints();
    // The event edge rides the positioned root too: it belongs to the meta
    // node and to no base.
    expect(entries.map((e) => e.displayName)).toEqual(['Record Change', 'Tasks']);
    expect(entries[1].externalId).toBe('tblTASKS01');
    // The other base's tables were never enumerated — this is the timeout fix.
    expect(listedTableBaseIds).toEqual(['appOPS01']);
  });

  it('resolves the base name case-insensitively', async () => {
    const { adapter } = makeMultiBaseAdapter({
      teamId: 'team-air-ci',
      bases: [crm(), ops()],
      base: '  ops  ',
    });
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.displayName)).toEqual(['Record Change', 'Tasks']);
  });

  it('positioned at an UNKNOWN base → falls back to the unpositioned root', async () => {
    const { adapter } = makeMultiBaseAdapter({
      teamId: 'team-air-unknown',
      bases: [crm(), ops()],
      base: 'Nonexistent',
    });
    // A name that resolves to no base leaves the cursor at the root, so the
    // author sees the `Base` collection and can narrow to a real one. (The
    // checker warns on the unknown name separately — an introspection miss
    // must not block.)
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.displayName)).toEqual(['Record Change', 'Base']);
  });

  // The drill-down: describe the connection → the bases; follow one → its
  // tables; follow a table → its fields. Each hop is ONE upstream call
  // answering exactly what was asked.
  // plans/2026-07-10-adapter-entry-positions/3_edges_from.md
  describe('edgesFrom — the meta-graph walk', () => {
    it('root hop → ONE polymorphic edge whose members carry the paths on', async () => {
      const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
        teamId: 'team-air-walk-root',
        bases: [crm(), ops()],
      });
      const hop = await adapter.edgesFrom(makeMetaPosition('airtable'));

      // The named per-base edges are gone from the presentation; the members
      // ride `targetPositions` with no reference row each.
      expect(hop?.descriptor.references.map((r) => r.targetTypeId).sort()).toEqual([
        'Base', 'airtable:record_change',
      ]);
      // You traverse a base; you never write one. An absent flag would
      // default to a write claim the entry list denies.
      const baseRef = hop?.descriptor.references.find((r) => r.targetTypeId === 'Base');
      expect(baseRef?.writable).toBe(false);
      // The path is what makes the next hop one call rather than a re-walk.
      const path = hop?.targetPositions?.appCRM01;
      expect(path?.recordType).toBe('Base');
      expect(path?.identity.kind === 'stable' && path.identity.recordId).toBe('appCRM01');
      // A member's `Name` label is what narrows it AND what names it.
      expect(path?.identity.kind === 'stable' && path.identity.data).toEqual({
        Name: 'CRM',
        Id: 'appCRM01',
      });
      expect(listedTableBaseIds).toEqual([]);
    });

    it('base hop → its tables, and touches ONLY that base', async () => {
      const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
        teamId: 'team-air-walk-base',
        bases: [crm(), ops()],
      });
      const hop = await adapter.edgesFrom(
        makeStablePosition({ adapterType: 'airtable', recordType: 'Base', recordId: 'appCRM01' }),
      );

      expect(hop?.descriptor.displayName).toBe('CRM');
      expect(hop?.descriptor.references.map((r) => r.targetTypeId)).toEqual(['Deals']);
      // Mid-walk, a table is traversed AND written: `createRecord` resolves
      // the table by its own name, so a walked-to table is exactly as
      // writable as a positioned root's. Unpositioned, this edge is the ONLY
      // place a row create can be authored — the root publishes only `Base`.
      expect(hop?.descriptor.references[0]?.writable).toBe(true);
      // The whole point: `Ops` is never walked.
      expect(listedTableBaseIds).toEqual(['appCRM01']);
      // The table's path carries its baseId — a table is only reachable
      // through its base, so its path must say which one — plus the two ways
      // the table is ADDRESSED: `Id` is how a LISTEN names it (`table:
      // "tblDEALS01"`), `Name` how a movement does. A narrowing predicate
      // evaluates over exactly this data, so an unpublished field is a field
      // nothing can narrow on.
      const path = hop?.targetPositions?.tblDEALS01;
      expect(path?.recordType).toBe('Table');
      expect(path?.identity.kind === 'stable' && path.identity.data).toEqual({
        baseId: 'appCRM01',
        Id: 'tblDEALS01',
        Name: 'Deals',
      });
    });

    it('table hop → its fields, routed off the path with no workspace walk', async () => {
      const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
        teamId: 'team-air-walk-table',
        bases: [crm(), ops()],
      });
      const hop = await adapter.edgesFrom(
        makeStablePosition({
          adapterType: 'airtable',
          recordType: 'Table',
          recordId: 'tblDEALS01',
          data: { baseId: 'appCRM01' },
        }),
      );

      expect(hop?.descriptor.displayName).toBe('Deals');
      expect(hop?.descriptor.fields.length).toBeGreaterThan(0);
      // Describing this table BY NAME would have walked every base to map the
      // name back to {baseId, tableId}. The path already said.
      expect(listedTableBaseIds).toEqual(['appCRM01']);
    });

    it('positioned at a base → the ROOT publishes its tables (construction walked us there)', async () => {
      const { adapter } = makeMultiBaseAdapter({
        teamId: 'team-air-walk-positioned',
        bases: [crm(), ops()],
        base: 'Ops',
      });
      const hop = await adapter.edgesFrom(makeMetaPosition('airtable'));

      // The event edge belongs to the meta node, so it rides the positioned
      // root as well — and the entry list publishes it there too. Same node,
      // same edges.
      expect(hop?.descriptor.references.map((r) => r.targetTypeId)).toEqual([
        'airtable:record_change', 'Tasks',
      ]);
      // A POSITIONED root's tables are its writable roots — the entry list
      // says `writable: true` for the same edges (the write gate), and the
      // walk must not disagree with it.
      const tasks = hop?.descriptor.references.find((r) => r.targetTypeId === 'Tasks');
      expect(tasks?.writable).toBe(true);
    });

    it('an unrecognised position is null, like an unknown typeId', async () => {
      const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-walk-null', bases: [crm()] });
      const hop = await adapter.edgesFrom(
        makeStablePosition({ adapterType: 'airtable', recordType: 'Base', recordId: 'appNOPE' }),
      );
      expect(hop).toBeNull();
    });
  });

  // An adapter that publishes `readable: true` and then can't read is a lie.
  // Both container reads were published and neither worked: the root threw (a
  // meta position isn't a record) and a base's silently returned nothing.
  describe('collection reads from a container', () => {
    it('reads a table from the ROOT of a base-positioned instance', async () => {
      const { adapter } = makeMultiBaseAdapter({
        teamId: 'team-air-coll-root',
        bases: [crm(), ops()],
        base: 'CRM',
        records: [{ id: 'rec1', fields: { Name: 'Acme' } }],
      });
      const landings = await adapter.getRelated({
        position: makeMetaPosition('airtable'),
        fieldId: 'Deals',
        direction: 'outgoing',
      });
      expect(landings.map((l) => l.position.recordType)).toEqual(['Deals']);
      expect(landings[0].position.identity.kind === 'stable' && landings[0].position.identity.recordId).toBe('rec1');
    });

    it('reads a table from a BASE reached by traversal', async () => {
      const { adapter } = makeMultiBaseAdapter({
        teamId: 'team-air-coll-base',
        bases: [crm(), ops()],
        records: [{ id: 'rec1', fields: { Name: 'Acme' } }],
      });
      // `-[b:Base WHERE `Name` == "CRM"]->-[d:`Deals`]->` at runtime.
      const landings = await adapter.getRelated({
        position: makeStablePosition({
          adapterType: 'airtable',
          recordType: 'Base',
          recordId: 'appCRM01',
          data: { Name: 'CRM' },
        }),
        fieldId: 'Deals',
        direction: 'outgoing',
      });
      expect(landings.map((l) => l.position.recordType)).toEqual(['Deals']);
    });

    it('an unknown collection is empty, not a throw', async () => {
      const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-coll-nope', bases: [crm()], base: 'CRM' });
      expect(
        await adapter.getRelated({
          position: makeMetaPosition('airtable'),
          fieldId: 'Nonexistent',
          direction: 'outgoing',
        }),
      ).toEqual([]);
    });
  });

  // `listEntryPoints` IS `edgesFrom(meta)` — the same node's edges — so they
  // must publish the same EDGES with the same PROMISES. Disagreement here is
  // the unchecked-default class the explorer flags: an absent flag on a walk
  // ref defaults to a claim the entry list denies.
  // plans/2026-07-10-adapter-entry-positions/4_polymorphic_edges.md
  it('the entry list and the walk agree on the root\'s edges AND their promises', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-agree', bases: [crm(), ops()] });
    const entries = (await adapter.listEntryPoints()).map((e) => ({
      name: e.displayName,
      readable: e.readable === true,
      writable: e.writable === true,
    }));
    const hop = await adapter.edgesFrom(makeMetaPosition('airtable'));
    const walk = (hop?.descriptor.references ?? []).map((r) => ({
      name: r.name ?? r.fieldId,
      readable: r.readable !== false,
      writable: r.writable === true,
    }));
    expect(walk).toEqual(entries);
    expect(entries.map((e) => e.name)).toEqual(['Record Change', 'Base']);
  });

  it('an unknown name off the UNPOSITIONED root is empty — never a workspace walk', async () => {
    const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
      teamId: 'team-air-named',
      bases: [crm(), ops()],
    });
    // The named per-base edges are gone: `CRM` is not an edge off the root any
    // more. Narrowing (`-[b:Base WHERE `Name` == "CRM"]->`) is the route.
    const landings = await adapter.getRelated({
      position: makeMetaPosition('airtable'),
      fieldId: 'CRM',
      direction: 'outgoing',
    });
    expect(landings).toEqual([]);
    expect(listedTableBaseIds).toEqual([]);
  });

  it('publishes ONE presentation of a base — the narrowable `Base` edge', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-both', bases: [crm(), ops()] });
    const entries = await adapter.listEntryPoints();
    // The named spelling was dropped (2026-07-17): it added nothing the
    // narrowable edge doesn't say, and layer 4's steer is that the
    // polymorphic form reads better for containers.
    expect(entries.map((e) => e.typeId)).toEqual(['airtable:record_change', 'Base']);
    // Unnarrowed, a Base has its Name and NO tables — which tables exist
    // depends on which base, and nobody has said yet. The Name field is what
    // a narrowing predicate reads.
    const base = await adapter.describe('Base');
    expect(base?.references).toEqual([]);
    expect(base?.fields.map((f) => f.fieldId)).toEqual(['Name']);
    expect(base?.description).toContain('narrow');
  });

  it('a base is still describable BY NAME — the node narrowing lands on', async () => {
    const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
      teamId: 'team-air-desc-name',
      bases: [crm(), ops()],
    });
    // `refineInstanceSchema` describes the member a predicate selected by its
    // label — this is that call, and it must cost ONE base's walk.
    const descriptor = await adapter.describe('CRM');
    expect(descriptor?.displayName).toBe('CRM');
    expect(descriptor?.references.map((r) => r.name)).toEqual(['Deals']);
    expect(listedTableBaseIds).toEqual(['appCRM01']);
  });

  it('the unnarrowed `Table` node is honestly minimal — the event\'s record edge target', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-tablemeta', bases: [crm()] });
    // Which fields a table has depends on WHICH (base, table) — unnarrowed,
    // there is nothing true to publish except that fact. "Undescribed" must
    // mean nobody looked, not that the describe was never written.
    const table = await adapter.describe('Table');
    expect(table?.displayName).toBe('Table');
    expect(table?.fields).toEqual([]);
    expect(table?.references).toEqual([]);
    expect(table?.description).toContain('base');
    // The event node's `record` edge lands exactly there.
    const event = await adapter.describe('Record Change');
    expect(event?.references[0]?.targetTypeId).toBe('Table');
  });

  it('projects the `Base` collection off the meta root, labelled by name (the `base:` value enum)', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-bases', bases: [crm(), ops()] });
    const results = await adapter.getRelated({
      position: makeMetaPosition('airtable'),
      fieldId: 'Base',
      direction: 'outgoing',
    });
    expect(results.map((r) => r.position.recordType)).toEqual(['Base', 'Base']);
    const labels = results
      .map((r) => (positionData(r.position) as { Name: string }).Name)
      .sort();
    expect(labels).toEqual(['CRM', 'Ops']);
  });
});

describe('AirtableAdapter.getRelated', () => {
  it('emits a landing typed by the linked table displayName', async () => {
    const { adapter } = makeAdapter({
      records: [{ id: 'recAlice', fields: { 'Full Name': 'Alice' } }],
    });
    const results = await adapter.getRelated({
      // A Deals position whose `Owner` link holds one People record id.
      position: makeStablePosition({
        adapterType: 'airtable',
        recordType: DEALS_TYPE,
        recordId: 'recDeal1',
        data: { Owner: ['recAlice'] },
      }),
      fieldId: 'Owner',
      direction: 'outgoing',
    });
    expect(results).toHaveLength(1);
    expect(results[0].position.recordType).toBe(PEOPLE_TYPE);
  });
});

// The event node and the row are DIFFERENT NODES. This adapter used to seed the
// row AS the event, which is why a movement could declare `<at-[:`Deals`]->>` and
// have nothing check it. The `record` edge is what un-conflates them.
// plans/2026-07-10-adapter-entry-positions/8_event_edges.md
describe('the event node → its record', () => {
  const crm = () => ({ id: 'appCRM01', name: 'CRM', tables: [dealsTable()] });
  const ops = () => ({ id: 'appOPS01', name: 'Ops', tables: [tasksTable()] });
  const eventPosition = (data: unknown) =>
    makeUnstablePosition({ adapterType: 'airtable', recordType: 'Record Created', data });

  const eventData = {
    record: 'recNEW01',
    table: 'tblDEALS01',
    tableName: 'Deals',
    base: 'appCRM01',
    fields: { Name: 'Acme', Stage: 'Seed' },
  };

  it('mints the row from the event — a stable position, and NOT a fetch', async () => {
    const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
      teamId: 'team-air-event-rec',
      bases: [crm(), ops()],
    });

    const results = await adapter.getRelated({
      position: eventPosition(eventData),
      fieldId: 'record',
      direction: 'outgoing',
    });

    expect(results).toHaveLength(1);
    // The TABLE's name types it, so field reads resolve against the right
    // table — the event said which, so nothing had to be looked up.
    expect(results[0].position.recordType).toBe('Deals');
    expect(results[0].position.identity.kind).toBe('stable');
    expect(
      results[0].position.identity.kind === 'stable' && results[0].position.identity.recordId,
    ).toBe('recNEW01');
    expect(positionData(results[0].position)).toEqual({ Name: 'Acme', Stage: 'Seed' });
    // The whole point: Attio pays an API call here. Airtable's payload already
    // said everything, so nothing was walked.
    expect(listedTableBaseIds).toEqual([]);
  });

  it('a position that is not one of our events yields nothing, never a guess', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-event-bad', bases: [crm()] });
    const results = await adapter.getRelated({
      position: eventPosition({ something: 'else' }),
      fieldId: 'record',
      direction: 'outgoing',
    });
    expect(results).toEqual([]);
  });

  it('a delete carries the row identity with no fields — the row is still named', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-event-del', bases: [crm()] });
    const results = await adapter.getRelated({
      position: eventPosition({ ...eventData, fields: {} }),
      fieldId: 'record',
      direction: 'outgoing',
    });
    expect(results).toHaveLength(1);
    expect(results[0].position.recordType).toBe('Deals');
    expect(positionData(results[0].position)).toEqual({});
  });
});

// The event's data is the row's IDENTITY plus its changed fields — not the
// fields at top level. That is what makes the `record` edge free.
describe('eventsFromPayload — the event node carries the row identity', () => {
  it('names the base, the table (by id AND name), and the row', () => {
    const events = eventsFromPayload({
      baseId: 'appCRM01',
      tableNamesById: new Map([['tblDEALS01', 'Deals']]),
      fieldNamesByTable: new Map([['tblDEALS01', new Map([['fldNAME', 'Name']])]]),
      payload: {
        timestamp: '2026-07-17T00:00:00Z',
        changedTablesById: {
          tblDEALS01: {
            createdRecordsById: { recNEW01: { cellValuesByFieldId: { fldNAME: 'Acme' } } },
          },
        },
      } as Parameters<typeof eventsFromPayload>[0]['payload'],
    });

    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      action: 'record.created',
      record: 'recNEW01',
      table: 'tblDEALS01',
      tableName: 'Deals',
      base: 'appCRM01',
      fields: { Name: 'Acme' },
    });
    // Unchanged, and load-bearing: the dispatch filter compares `recordType` to
    // the listen's `table` — it predates the event node and must keep working.
    expect(events[0].recordType).toBe('tblDEALS01');
    expect(events[0].externalId).toBe('recNEW01');
    expect(events[0].tag).toBe('record.created');
    expect(events[0].changeType).toBe('create');
  });

  it('degrades to the bare id when table metadata is unavailable', () => {
    const events = eventsFromPayload({
      baseId: 'appCRM01',
      fieldNamesByTable: new Map(),
      payload: {
        changedTablesById: {
          tblDEALS01: { destroyedRecordIds: ['recGONE'] },
        },
      } as Parameters<typeof eventsFromPayload>[0]['payload'],
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      action: 'record.deleted',
      record: 'recGONE',
      table: 'tblDEALS01',
      tableName: 'tblDEALS01',
      base: 'appCRM01',
      fields: {},
    });
  });
});

// The write promise has to survive all the way to the CHECKER, not just sit in
// a descriptor: creating a row is THE Airtable operation, and unpositioned the
// per-table edge off a narrowed base is the ONLY place it can be authored (the
// root publishes just the read-only `Base`). Since layer 13 an edge's
// `writable` is EXPLICIT — absent means read-only — so a missing flag here
// failed every row create at the checker while `createRecord` sat implemented.
describe('the table write promise reaches the CHECKER projection', () => {
  const crm = () => ({ id: 'appCRM01', name: 'CRM', tables: [dealsTable()] });
  const ops = () => ({ id: 'appOPS01', name: 'Ops', tables: [tasksTable()] });

  /** The unpositioned instance's schema exactly as the catalog assembles it:
   *  the published entries, each described, through the real projection. */
  async function projectUnpositioned(adapter: AirtableAdapter) {
    const entries = await adapter.listEntryPoints();
    const described = await Promise.all(
      entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
    );
    const projection = instanceSchemaFromDescriptors({
      adapterType: 'airtable',
      entries,
      descriptors: new Map(described.flatMap(([id, d]) => (d ? [[id, d] as const] : []))),
      supportsInPlaceUpdate: false,
    });
    return { entries, projection };
  }

  const source = `import { airtable } from adapters
import { airtable_cred } from credentials
air = airtable(credentials: airtable_cred)
movement m(x: <air-[:\`Record Change\`]->>) {
  air-[b:Base WHERE \`Name\` == "CRM"]-> {
    write b-[:\`Deals\`]-> { Name: "X" }
  }
}`;

  it('a narrowed base\'s table edge is writable at the checker', async () => {
    const { adapter } = makeMultiBaseAdapter({
      teamId: 'team-air-checker-write',
      bases: [crm(), ops()],
    });
    const { entries, projection } = await projectUnpositioned(adapter);

    // The refined position the checker looks up — produced by the same
    // `refineInstanceSchema` the catalog runs, off the real `describe('CRM')`.
    const hop = await adapter.edgesFrom(makeMetaPosition('airtable'));
    const { schema } = await refineInstanceSchema({
      instance: {
        adapterType: 'airtable',
        schema: projection.schema,
        entryPoints: entries.map((e) => ({
          typeId: e.typeId,
          displayName: e.displayName,
          writable: e.writable === true,
          readable: e.readable === true,
        })),
        describeType: (typeName: string) => adapter.describe(typeName),
        membersOf: async () =>
          Object.values(hop?.targetPositions ?? {}).map((position) => {
            const data = positionData(position) as { Name: string };
            return { name: data.Name, data };
          }),
      },
      chains: scanInstanceChains(source),
    });

    const refined = schema.positions['Base "CRM"'];
    expect(refined).toBeDefined();
    expect(refined!.edges.Deals).toMatchObject({ target: 'Deals', writable: true });
  });

  it('the root\'s own edges carry NO write promise — no base or event is created', async () => {
    const { adapter } = makeMultiBaseAdapter({
      teamId: 'team-air-checker-readonly',
      bases: [crm(), ops()],
    });
    const { projection } = await projectUnpositioned(adapter);
    // `createRecord` resolves a TABLE name and calls `recordCreateRecord`;
    // there is no create-base and no create-table call anywhere in the client,
    // so neither root edge may promise one.
    expect(projection.schema.writableRoots.Base).toBeUndefined();
    expect(projection.schema.writableRoots['Record Change']).toBeUndefined();
  });

  it('a base-POSITIONED root publishes its tables as writable roots', async () => {
    const { adapter } = makeMultiBaseAdapter({
      teamId: 'team-air-checker-positioned',
      bases: [crm(), ops()],
      base: 'CRM',
    });
    const { projection } = await projectUnpositioned(adapter);
    // Positioned, the table IS a root — the same write, reached without the
    // base hop. Both standpoints must promise it, because both dispatch into
    // the same `createRecord`.
    expect(projection.schema.writableRoots.Deals?.fields).toMatchObject({ Name: 'text' });
  });
});
