// Unit tests for the Attio adapter's file-on-write path (4d_resources.md).
//
// The input-side `_resources` READ path (getRelated scanning a record's
// value envelope for file-shaped entries) has been REMOVED: `_resources` is
// now EXTRACTED-NODE provenance only and is NOT reachable off an input/source
// Attio record position. The one negative test below pins that — a
// `_resources` hop off a stable Attio record drifts (the reference is no
// longer published, so name-resolution rejects it) instead of resolving.
//
// Covers:
//   1. A `_resources` hop off an Attio record position no longer resolves.
//   2. createRecord/updateRecord detect `file`-kind field values (branded
//      `FileRef` descriptors), redeem them for their bytes, and
//      upload them via /v2/files/upload against the record's own id + object
//      slug — keeping them out of the records values envelope. Non-file
//      fields flow through untouched; a record with no file fields triggers
//      no uploads.
//
// API client + linked_object queries are stubbed — no DB, no network; a
// written FileRef's bytes sit in an in-memory document store.

// The Attio adapter imports lib/credentials at module scope which reads
// ENCRYPTION_MASTER_KEY. Stub it; the adapter's getApiClient is overridden
// per-test so decryptToken never actually fires.
jest.mock('../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

// Logger pulls in services/context, which loads casl extensions and crashes
// at module-load. Stub it.
jest.mock('movement-engine/services/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Recording shim is unused for non-harness team ids but its module pulls
// in additional transitive deps; stub to keep the load chain light.
jest.mock('../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

// The real Attio apiClient imports lib/slack → dealflow_pipeline → casl,
// which crashes at module load. The adapter under test only consults
// `attioCredsParser` + `getAttioClient` at runtime; we override
// `getApiClient` per-test so neither is actually called.
jest.mock('../../../adapters/attio/apiClient', () => ({
  attioCredsParser: {
    safeParse: (data: unknown) => ({ success: true, data }),
  },
  getAttioClient: () => ({}),
}));

// `translation_graph/types.ts` transitively loads the same broken zod
// chain via `knowledge_pipeline/output_v3/schemas`. Stub at the leaf —
// types.ts only consumes the shape at type-level.
jest.mock('movement-engine/services/knowledge_pipeline/output_v3/schemas', () => {
  const stub: Record<string, unknown> = {};
  const ret = () => stub;
  Object.assign(stub, {
    optional: ret, nullable: ret, default: ret, array: ret,
    parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }),
    refine: ret, transform: ret, extend: ret, merge: ret,
    pick: ret, omit: ret, partial: ret, describe: ret, or: ret, and: ret,
  });
  return {
    traversalStepSchema: stub,
    fieldRefSchema: stub,
    expressionSchema: stub,
    filterExpressionSchema: stub,
    webhookGraphOutputConfigSchema: stub,
  };
});

// `services/knowledge_pipeline/uniqueness_constraints` transitively loads
// the webhook/slack output chain which has a circular zod import that
// crashes at module-load. The Attio adapter only needs the type-level
// surface of uniqueness_constraints here (the entity-resolution path
// isn't exercised by these tests).
jest.mock('../../knowledge_pipeline/uniqueness_constraints', () => {
  const stub: Record<string, unknown> = {};
  const ret = () => stub;
  Object.assign(stub, {
    optional: ret, nullable: ret, default: ret, array: ret,
    parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }),
    refine: ret, transform: ret,
  });
  return {
    isEdgeToEntry: () => false,
    storedUniquenessConstraintsSchema: stub,
  };
});

// Hold a mockable linked_object row store on globalThis so the kysely
// factory (which runs hoisted, before any module imports) can read from
// the same array test code mutates. Variable name must start with `mock`
// per jest's hoist guard.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).mockAttioLinkedObjects = [];

jest.mock('../../../lib/kysely', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = () => (globalThis as any).mockAttioLinkedObjects;

  function makeChain(table: string) {
    const conds: Array<[string, unknown]> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      selectFrom: () => chain,
      where: (col: string, _op: string, val: unknown) => {
        conds.push([col, val]);
        return chain;
      },
      select: () => chain,
      executeTakeFirst: async () => {
        if (table === 'linked_object') {
          const match = store().find((row: Record<string, unknown>) =>
            conds.every(([col, val]) => {
              const field = col.split('.').pop() as string;
              return row[field] === val;
            }),
          );
          if (!match) return undefined;
          return {
            external_id: match.external_id,
            external_object_type: match.external_object_type,
          };
        }
        return undefined;
      },
      execute: async () => [],
    };
    return chain;
  }
  return {
    getQb: () => ({ selectFrom: () => makeChain('public') }),
    getCoreQb: () => ({ selectFrom: () => makeChain('public') }),
    getKnowledgeQb: () => ({ selectFrom: () => makeChain('linked_object') }),
    getAutomationsQb: () => ({ selectFrom: () => makeChain('linked_object') }),
  };
});

// The Attio adapter's recording shim runs against test-harness team ids.
// We're using non-harness ids so no need to stub here.

import { Readable } from 'node:stream';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { SourcePosition } from 'movement-engine/services/translation_graph/types';
import type { FileRef, WriteInput } from 'movement-engine/services/translation_graph/adapter';

import { ADAPTER_META_TYPE_ID, isStablePosition, makeMetaPosition, makeStablePosition, makeUnstablePosition, positionRecordId } from 'movement-engine/services/translation_graph/types';
import {
  AttioAdapter,
  ATTIO_LIST_ENTRY_TYPE_ID,
  ATTIO_LISTS_EDGE,
  ATTIO_WEBHOOK_EVENT_TYPE_ID,
} from '../adapters/attio';
import { fileValue, RESOURCES_REFERENCE_FIELD_ID, type FileValue } from 'movement-engine/services/translation_graph/adapter';
import { installMemoryDocumentStore } from '../engine/files/__test__/memory_document_store';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { logger } from 'movement-engine/services/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LinkedObjectRow = {
  team_id: string;
  node_id: string;
  adapter_type: string;
  external_id: string;
  external_object_type: string | null;
};

function getLinkedObjectsStore(): LinkedObjectRow[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).mockAttioLinkedObjects as LinkedObjectRow[];
}

function resetState() {
  getLinkedObjectsStore().length = 0;
}

type UploadCall = {
  fileName: string;
  objectSlug: string;
  recordId: string;
  bytes: ArrayBuffer;
  blobType: string;
};

type RecordWriteCall = {
  objectId: string;
  recordId?: string;
  fields: Record<string, unknown>;
};

function makeAdapter(input: {
  teamId: string;
  uploadCalls?: UploadCall[];
  createCalls?: RecordWriteCall[];
  updateCalls?: RecordWriteCall[];
  downloadCalls?: { fileId: string }[];
  webhookCalls?: { subscriptions: unknown }[];
  createdRecordId?: string;
  uploadShouldThrow?: Error;
}): AttioAdapter {
  const adapter = new AttioAdapter({
    teamId: input.teamId as TeamId,
    credentialsId: 'creds-1',
  });
  const createdRecordId = input.createdRecordId ?? 'rec-created-1';
  const fakeClient = {
    // The write methods now build the natural-name resolver from the
    // adapter's own introspection (listEntryPoints → warmCatalogs); these
    // tests pass internal recordType ids + attribute-slug field keys, so the
    // resolver just needs to build without throwing (names fall through to
    // identity). One object is enough to satisfy the catalog warm.
    listObjects: async () => [
      { id: 'companies', name: 'Companies', slug: 'companies' },
    ],
    listLists: async () => [],
    listAttributes: async () => [],
    downloadFile: async (args: { fileId: string }) => {
      input.downloadCalls?.push({ fileId: args.fileId });
      return {
        stream: Readable.toWeb(Readable.from(Buffer.from(DOWNLOAD_BYTES))),
        contentType: 'application/pdf',
      };
    },
    uploadFile: async (args: {
      file: Blob;
      fileName: string;
      objectSlug: string;
      recordId: string;
    }) => {
      if (input.uploadShouldThrow) throw input.uploadShouldThrow;
      const bytes = await args.file.arrayBuffer();
      input.uploadCalls?.push({
        fileName: args.fileName,
        objectSlug: args.objectSlug,
        recordId: args.recordId,
        bytes,
        blobType: args.file.type,
      });
      return {
        fileId: 'file-uploaded-1',
        name: args.fileName,
        contentType: args.file.type,
        contentSize: bytes.byteLength,
      };
    },
    createRecord: async (args: { objectId: string; fields: Record<string, unknown> }) => {
      input.createCalls?.push({ objectId: args.objectId, fields: args.fields });
      return {
        id: { record_id: createdRecordId },
        values: {},
        web_url: 'https://app.attio.com/rec-created-1',
      };
    },
    updateRecord: async (args: {
      objectId: string;
      recordId: string;
      fields: Record<string, unknown>;
    }) => {
      input.updateCalls?.push({
        objectId: args.objectId,
        recordId: args.recordId,
        fields: args.fields,
      });
      return {
        id: { record_id: args.recordId },
        values: {},
        web_url: 'https://app.attio.com/rec-updated-1',
      };
    },
    createWebhook: async (args: { targetUrl: string; subscriptions: unknown }) => {
      input.webhookCalls?.push({ subscriptions: args.subscriptions });
      return { webhookId: 'wh-1', workspaceId: 'ws-1', secret: 'shh', status: 'active' };
    },
    updateWebhook: async (args: { webhookId: string; subscriptions: unknown }) => {
      input.webhookCalls?.push({ subscriptions: args.subscriptions });
      return {};
    },
  } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
  (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient = async () => fakeClient;
  return adapter;
}

/**
 * A `file`-kind field value as the engine hands it to the target — a branded
 * `FileRef` descriptor of fixed bytes in the document store, so we can assert
 * what reaches `uploadFile`.
 */
const FILE_BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const fileStore = installMemoryDocumentStore();

/** Bytes the fake `downloadFile` streams back — asserted on the read side's
 *  `resolveFileRef`, so we know the FileRef is redeemed through the Attio
 *  download endpoint. */
const DOWNLOAD_BYTES = new Uint8Array([9, 8, 7, 6]);

/** A file the engine writes: the stored descriptor, made a file as the engine
 *  makes one at a typed entry (a dict that spells one is data to the write). */
function makeFileRef(overrides?: { name?: string; contentType?: string }): FileValue {
  return fileValue(
    fileStore.file(Buffer.from(FILE_BYTES), {
      name: overrides?.name ?? 'report.pdf',
      contentType: overrides?.contentType ?? 'application/pdf',
    }),
  );
}

const writeMutationContext = {
  source: { adapterType: 'attio' },
} as unknown as WriteInput['mutationContext'];

// ---------------------------------------------------------------------------
// `_resources` is EXTRACTED-NODE provenance only — the input-side READ path
// (getRelated scanning a record's value envelope for file-shaped entries) has
// been removed. A `_resources` hop off a stable Attio record position no
// longer resolves: it is not a published reference, so it falls through to
// name-resolution and drifts (the loud, correct failure for an unknown edge).
// ---------------------------------------------------------------------------

describe('AttioAdapter `_resources` is not a readable edge', () => {
  beforeEach(resetState);

  it('a `_resources` hop off an Attio record position no longer resolves', async () => {
    const adapter = makeAdapter({ teamId: 'team-no-resources' });
    const position: SourcePosition = makeStablePosition({
      adapterType: 'attio',
      recordType: 'Companies',
      recordId: 'rec-acme',
      data: {
        pitch_deck: [
          {
            file_id: 'file-pitch-123',
            file_url: 'https://attio-cdn.example.com/files/file-pitch-123',
            name: 'pitch.pdf',
            content_type: 'application/pdf',
          },
        ],
      },
    });

    // It's not a published reference of the record type, so name-resolution
    // rejects it as schema drift rather than scanning the value envelope.
    await expect(
      adapter.getRelated({
        position,
        fieldId: RESOURCES_REFERENCE_FIELD_ID,
        direction: 'outgoing',
      }),
    ).rejects.toThrow(/'_resources' is not a known edge/);
  });
});

// ---------------------------------------------------------------------------
// READ side: a record's file-shaped attribute values are reachable as
// `attio:file` positions via `record-[:files]->`, each carrying a `File`
// field that returns a byte-bearing `FileRef`. Symmetric with the
// file-on-write path: the same Attio credential downloads the bytes
// (`GET /v2/files/{file_id}/download`) that the upload path uploads with.
// This is what makes a movement read a file off an Attio source record
// (e.g. extract from / carry forward an attached PDF).
// ---------------------------------------------------------------------------

describe('AttioAdapter file read (`record-[:files]->.`File`)', () => {
  beforeEach(resetState);

  const fileRecordPosition = (): SourcePosition =>
    makeStablePosition({
      adapterType: 'attio',
      // The engine stamps the NATURAL type name on a source-read position;
      // the resolver keys its per-type edge maps by display name.
      recordType: 'Companies',
      recordId: 'rec-acme',
      data: {
        // A file-shaped attribute value (Attio's `[{ file_id, ... }]` shape)
        // plus a plain scalar that must NOT be mistaken for a file.
        pitch_deck: [
          {
            file_id: 'file-pitch-123',
            file_url: 'https://attio-cdn.example.com/files/file-pitch-123',
            name: 'pitch.pdf',
            content_type: 'application/pdf',
          },
        ],
        name: [{ value: 'Acme' }],
      },
    });

  it('publishes a `files` reference on a record descriptor → attio:file', async () => {
    const adapter = makeAdapter({ teamId: 'team-files-describe' });
    const co = await adapter.describe('Companies');
    const filesEdge = co!.references.find((r) => r.fieldId === 'files');
    expect(filesEdge).toBeDefined();
    expect(filesEdge!.targetTypeId).toBe('attio:file');
    expect(filesEdge!.cardinality).toBe('many');
  });

  it('fans a record out into one attio:file position per file value', async () => {
    const adapter = makeAdapter({ teamId: 'team-files-related' });
    const related = await adapter.getRelated({
      position: fileRecordPosition(),
      fieldId: 'Files',
      direction: 'outgoing',
    });
    // Exactly one file — the plain `name` scalar is not file-shaped.
    expect(related).toHaveLength(1);
    // NATURAL recordType — the sentinel spelling (`attio:file`) drifts at
    // resolveFieldId, so every minted position speaks the display name
    // (`File`, system-name-free per adapters/CLAUDE.md rule 5).
    expect(related[0].position.recordType).toBe('File');
  });

  it("the file position's `File` field returns a FileRef this instance redeems for the bytes", async () => {
    const downloadCalls: { fileId: string }[] = [];
    const adapter = makeAdapter({ teamId: 'team-files-fileref', downloadCalls });
    const [related] = await adapter.getRelated({
      position: fileRecordPosition(),
      fieldId: 'Files',
      direction: 'outgoing',
    });

    // Metadata fields resolve off the parsed record (natural display names).
    expect(await adapter.getFieldValue({ position: related.position, fieldId: 'Name' })).toBe('pitch.pdf');
    expect(await adapter.getFieldValue({ position: related.position, fieldId: 'Content Type' })).toBe('application/pdf');
    expect(await adapter.getFieldValue({ position: related.position, fieldId: 'File Id' })).toBe('file-pitch-123');

    // The `File` field is the binary primitive — a branded FileRef.
    const fileRef = (await adapter.getFieldValue({
      position: related.position,
      fieldId: 'File',
    })) as FileRef;
    expect(fileRef).not.toBeNull();
    expect(fileRef.__brand).toBe('FileRef');
    // The descriptor names this instance — its credential — and the stable
    // Attio file id as the handle.
    expect(fileRef.source).toEqual({ adapterType: 'attio', credentialId: 'creds-1', handle: 'file-pitch-123' });
    expect(JSON.parse(JSON.stringify(fileRef))).toEqual(fileRef);

    // The owner streams the bytes via the Attio download endpoint, with the
    // same credential the write path uploads with.
    const resolved = await adapter.resolveFileRef({ ref: fileRef });
    const chunks: Buffer[] = [];
    for await (const chunk of resolved.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(new Uint8Array(Buffer.concat(chunks))).toEqual(DOWNLOAD_BYTES);
    expect(resolved.contentType).toBe('application/pdf');
    // The download hit Attio by the file id (the write-side credential).
    expect(downloadCalls).toEqual([{ fileId: 'file-pitch-123' }]);
  });
});

// ---------------------------------------------------------------------------
// Per-list `within` recency key (INV2, trial3-fix 2026-06-01)
//
// A `within` uniqueness clause READS a date field to scope dedup by
// recency. On an Attio LIST ENTRY the natural recency key is `Added to
// list at` — the system timestamp stamped when a record is added to the
// list. That field is NOT returned by `/v2/lists/<id>/attributes` (which
// only carries the list's *custom* attributes), so before the fix it
// never appeared on the per-list synthetic type's descriptor and a
// `within` keyed on it failed `resolveFieldName` at authoring.
//
// The fix surfaces the system entry date as a read-only `kind:'date'`
// field on every per-list descriptor (mirroring W-VAL's object fix:
// system dates are readable recency keys regardless of writability),
// keyed on the `created_at` slug the entries-query filter accepts so the
// dispatch filter is correct.
// ---------------------------------------------------------------------------

function makePerListAdapter(input: { teamId: string }): AttioAdapter {
  const adapter = new AttioAdapter({
    teamId: input.teamId as TeamId,
    credentialsId: 'creds-1',
  });
  const fakeClient = {
    listObjects: async () => [
      { id: 'deals', name: 'Deal', slug: 'deals' },
    ],
    listLists: async () => [
      {
        id: 'list-vcdf',
        name: 'VC Deal Flow',
        parentObjectSlugs: ['deals'],
        apiSlug: 'vc_deal_flow',
      },
    ],
    listAttributes: async () => [
      // The list's own custom attributes — the only thing the real
      // `/v2/lists/<id>/attributes` endpoint returns. Note: NO system
      // entry date here, exactly like Attio.
      {
        id: 'attr-stage',
        name: 'Stage',
        type: 'status',
        apiSlug: 'stage',
        isWritable: true,
        isRequired: false,
        isMulti: false,
        options: [{ id: 'o1', name: 'New' }],
      },
    ],
  } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
  (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient = async () => fakeClient;
  return adapter;
}

const PER_LIST_TYPE_ID = 'VC Deal Flow';

describe('AttioAdapter per-list within recency key (INV2)', () => {
  it('surfaces `Added to list at` as a read-only date field on the per-list descriptor', async () => {
    const adapter = makePerListAdapter({ teamId: 'team-inv2-describe' });
    const descriptor = await adapter.describe(PER_LIST_TYPE_ID);
    expect(descriptor).not.toBeNull();
    const addedAt = descriptor!.fields.find((f) => f.displayName === 'Added to list at');
    expect(addedAt).toBeDefined();
    // It is a date the engine can read for recency — and it is read-only
    // (the system stamps it), which must NOT disqualify it as a `within`
    // key (the W-VAL principle, applied to list entries).
    expect(addedAt!.kind).toBe('date');
    expect(addedAt!.writable).toBe(false);
    // The slug matches the entries-query filter field so a dispatch-time
    // `{ created_at: { $gte: cutoff } }` filter resolves.
    expect(addedAt!.fieldId).toBe('created_at');
    // The list's own custom attributes still come through.
    expect(descriptor!.fields.some((f) => f.displayName === 'Stage')).toBe(true);
  });

  it('does not duplicate the entry date when a custom attribute already claims the slug', async () => {
    const adapter = new AttioAdapter({
      teamId: 'team-inv2-collide' as TeamId,
      credentialsId: 'creds-1',
    });
    const fakeClient = {
      listObjects: async () => [{ id: 'deals', name: 'Deal', slug: 'deals' }],
      listLists: async () => [
        { id: 'list-c', name: 'Collide List', parentObjectSlugs: ['deals'], apiSlug: 'collide_list' },
      ],
      listAttributes: async () => [
        { id: 'attr-c', name: 'Custom Created', type: 'date', apiSlug: 'created_at', isWritable: true, isRequired: false, isMulti: false },
      ],
    } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
    (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient = async () => fakeClient;
    const descriptor = await adapter.describe('Collide List');
    const createdAtFields = descriptor!.fields.filter((f) => f.fieldId === 'created_at');
    // Exactly one — the custom attribute wins, no synthetic duplicate.
    expect(createdAtFields).toHaveLength(1);
    expect(createdAtFields[0].displayName).toBe('Custom Created');
  });
});

// ---------------------------------------------------------------------------
// Chunk 4 (adapter-capability-contract): describe() carries the filter/order/
// limit capability — per-field (what the source can filter server-side) and
// per-edge (whether/how filter/order/limit push across a relationship).
// ---------------------------------------------------------------------------

function makeCapabilityAdapter(): AttioAdapter {
  const adapter = new AttioAdapter({
    teamId: 'team-cap' as TeamId,
    credentialsId: 'creds-1',
  });
  const fakeClient = {
    listObjects: async () => [
      { id: 'companies', name: 'Company', slug: 'companies' },
      { id: 'people', name: 'Person', slug: 'people' },
    ],
    listLists: async () => [],
    listAttributes: async () => [
      { id: 'a-name', name: 'Name', type: 'text', apiSlug: 'name', isWritable: true, isRequired: false, isMulti: false },
      { id: 'a-seen', name: 'Last Seen', type: 'date', apiSlug: 'last_seen', isWritable: true, isRequired: false, isMulti: false },
      { id: 'a-people', name: 'People', type: 'record-reference', apiSlug: 'associated_people', relationshipObjectId: 'people', isWritable: true, isRequired: false, isMulti: true },
      // A DERIVED reverse-relationship attribute — Attio marks these
      // `is_writable: false` and rejects a PATCH to them.
      { id: 'a-derived', name: 'Team', type: 'record-reference', apiSlug: 'team', relationshipObjectId: 'people', isWritable: false, isRequired: false, isMulti: true },
    ],
  } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
  (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient = async () => fakeClient;
  return adapter;
}

describe('AttioAdapter.translateFilter pushdown (chunk 7)', () => {
  it('pushes an equality conjunct to a records-query filter', async () => {
    const adapter = makeCapabilityAdapter();
    const result = await adapter.translateFilter({
      expression: {
        type: 'compare',
        op: 'eq',
        left: { type: 'property', propertyTypeId: 'name' },
        right: { type: 'static', value: 'Acme' },
      },
      entityType: 'Company',
    });
    expect((result.native as { kind: string }).kind).toBe('records');
    expect(result.residual).toBeNull();
  });

  it('leaves a non-equality predicate as residual (the engine satisfies it)', async () => {
    const adapter = makeCapabilityAdapter();
    const result = await adapter.translateFilter({
      expression: {
        type: 'compare',
        op: 'gt',
        left: { type: 'property', propertyTypeId: 'last_seen' },
        right: { type: 'static', value: 5 },
      },
      entityType: 'Company',
    });
    expect((result.native as { kind: string }).kind).toBe('all');
    expect(result.residual).not.toBeNull();
  });

  it('splits a mixed WHERE: pushes the equality, keeps the rest as residual', async () => {
    const adapter = makeCapabilityAdapter();
    const result = await adapter.translateFilter({
      expression: {
        type: 'logical',
        op: 'and',
        operands: [
          { type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'name' }, right: { type: 'static', value: 'Acme' } },
          { type: 'compare', op: 'gt', left: { type: 'property', propertyTypeId: 'last_seen' }, right: { type: 'static', value: 5 } },
        ],
      },
      entityType: 'Company',
    });
    expect((result.native as { kind: string }).kind).toBe('records');
    expect(result.residual).not.toBeNull();
  });
});

describe('AttioAdapter capability declarations (chunk 4)', () => {
  it('top-level object collections are natively filterable, and sorted here', async () => {
    const adapter = makeCapabilityAdapter();
    const meta = await adapter.describe('__adapter_meta__');
    expect(meta).not.toBeNull();
    // OBJECT collections carry the native FILTER capability. The order is
    // `bounded` because `getRelated` reads no `orderBy` — the records-query
    // carries the filter and nothing else, so the sort happens in the engine
    // and the declaration says so (D2). The record-owned types (Note / Task /
    // List / Comment / File) have NO root edge at all — they are reached
    // through their parent record (rule 0).
    const objectRefs = meta!.references.filter((ref) => ref.targetTypeId === 'Company');
    expect(objectRefs.length).toBeGreaterThan(0);
    for (const ref of objectRefs) {
      expect(ref.capability).toEqual({ filter: 'native', order: 'bounded', supportsLimit: true });
    }
  });

  it('per-field capability reflects the source-system filter surface', async () => {
    const adapter = makeCapabilityAdapter();
    const co = await adapter.describe('Company');
    expect(co).not.toBeNull();

    const name = co!.fields.find((f) => f.fieldId === 'name');
    expect(name!.capability?.filterOperators).toEqual(['eq', 'neq', 'in', 'contains']);
    expect(name!.capability?.orderable).toBe(true);

    // A date field carries WITHIN (recency) and is orderable.
    const seen = co!.fields.find((f) => f.fieldId === 'last_seen');
    expect(seen!.capability?.filterOperators).toContain('within');
    expect(seen!.capability?.orderable).toBe(true);

    // The synthetic read-only `Created At` is likewise a recency key.
    const created = co!.fields.find((f) => f.displayName === 'Created At');
    expect(created!.capability?.filterOperators).toContain('within');
  });

  it('a record-reference edge is bounded (adapter filters via the shared unit)', async () => {
    const adapter = makeCapabilityAdapter();
    const co = await adapter.describe('Company');
    const peopleEdge = co!.references.find((r) => r.fieldId === 'associated_people');
    expect(peopleEdge!.capability).toEqual({ filter: 'bounded', order: 'bounded', supportsLimit: true });

    // The input-side `_resources` read reference has been removed — it is now
    // EXTRACTED-NODE provenance only and is never published on a record's
    // descriptor. The record's normal references still come through.
    expect(
      co!.references.find((r) => r.fieldId === RESOURCES_REFERENCE_FIELD_ID),
    ).toBeUndefined();
    expect(co!.references.length).toBeGreaterThan(0);
    expect(co!.references.some((r) => r.fieldId === 'associated_people')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 13 (one explicit writable): `writable` on an edge is the EXPLICIT write
// promise — absent IS the read-only fact. A record-reference is a real linked
// write (`classifyParentLink` → child-ref fold-in or parent-ref PATCH), so it
// must declare the promise; a derived (non-writable) attribute must not.
// ---------------------------------------------------------------------------
describe('AttioAdapter record-reference write promises (layer 13)', () => {
  it('declares a writable record-reference edge writable, and a derived one read-only', async () => {
    const adapter = makeCapabilityAdapter();
    const co = await adapter.describe('Company');

    // `classifyParentLink` matches the write's edgeName against the
    // record-reference attributes of BOTH endpoints and either folds the value
    // into the create payload (child-ref) or PATCHes the parent
    // (parent-ref → linkParentReference).
    expect(co!.references.find((r) => r.fieldId === 'associated_people')!.writable).toBe(true);

    // Attio rejects a PATCH to a derived reverse-relationship attribute.
    expect(co!.references.find((r) => r.fieldId === 'team')!.writable).toBeUndefined();
  });

  // The blind spot the Affinity sweep found: fixing describe() alone can do
  // nothing if a SECOND projection publishes the edges. Attio's checker
  // currency comes from `instanceSchemaFromDescriptors` over listEntryPoints()
  // + describe() (`instanceSchemaFromOntology` is KG-only), so assert the
  // promise at the checker's currency, not just the descriptor's.
  it('carries the write promise through to the CHECKER projection', async () => {
    const adapter = makeCapabilityAdapter();
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (
        await Promise.all(
          entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
        )
      ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    const projection = instanceSchemaFromDescriptors({
      adapterType: 'attio',
      entries,
      descriptors,
      supportsInPlaceUpdate: true,
    });
    const companyEdges = projection.schema.positions.Company!.edges;
    // Named by the attribute's TITLE, not Attio's api slug — these edges are
    // writable, so the slug would otherwise be what an author types.
    expect(companyEdges.associated_people).toBeUndefined();
    expect(companyEdges.People).toMatchObject({ target: 'Person', writable: true });
    expect(companyEdges.Team!.writable).toBeUndefined();
    // The edge-anchored creates keep their promises through the same path.
    expect(companyEdges.Notes).toMatchObject({ target: 'Note', writable: true });
    expect(companyEdges.Lists!.writable).toBe(true);
  });

  // The root is a node and its collections are edges: what the meta descriptor
  // declares for one is what the checker gates the hop by (D2). Attio's
  // records-query narrows but takes no sort argument, so the sort runs in the
  // engine — and a per-list root, which pushes NOTHING at all (no filter, no
  // sort), declares `bounded`/`bounded` so a WHERE or ORDER BY there is legal
  // and warned about, rather than silently permissive.
  it('carries the ROOT collection capability through to the CHECKER projection', async () => {
    const adapter = new AttioAdapter({ teamId: 'team-root' as TeamId, credentialsId: 'creds-1' });
    const fakeClient = {
      listObjects: async () => [{ id: 'companies', name: 'Company', slug: 'companies' }],
      listLists: async () => [
        { id: 'list-1', name: 'VC Deal Flow', parentObjectSlugs: ['companies'] },
      ],
      listAttributes: async () => [
        { id: 'a-name', name: 'Name', type: 'text', apiSlug: 'name', isWritable: true, isRequired: false, isMulti: false },
      ],
      listListAttributes: async () => [],
    } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
    (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient =
      async () => fakeClient;

    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (
        await Promise.all(
          entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
        )
      ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    const metaDescriptor = await adapter.describe(ADAPTER_META_TYPE_ID);
    const { schema, notes } = instanceSchemaFromDescriptors({
      adapterType: 'attio',
      entries,
      descriptors,
      ...(metaDescriptor !== null ? { metaDescriptor } : {}),
      supportsInPlaceUpdate: true,
    });
    expect(schema.collections.Company).toEqual({
      target: 'Company',
      capability: { filter: 'native', order: 'bounded', supportsLimit: true },
    });
    expect(schema.collections['VC Deal Flow']).toEqual({
      target: 'VC Deal Flow',
      capability: { filter: 'bounded', order: 'bounded', supportsLimit: true },
    });
    expect(notes.filter((n) => n.includes('root descriptor'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// INV3 (trial3-fix 2026-06-01): WITHIN on `Created At` for an OBJECT.
//
// THE BLIND SPOT this test closes: the W-VAL/INV unit test
// (`translation_agent_within_readable_date.unit.test.ts`) hand-built a
// `Deal` descriptor mock that HARDCODED a `Created At` date field. The
// REAL adapter never produces that field from `listAttributes` — Attio's
// `/v2/objects/<id>/attributes` doesn't reliably return the system
// `created_at` date, and the dev-loop fake-channels mock returns zero
// attributes for `deals`. So the agent's real authoring path got
// `resolveFieldName('Created At') → No field named 'Created At'` and
// rolled back, while the unit test stayed green.
//
// Mirroring the INV2 list-entry fix, `buildTypeDescriptor` now injects a
// read-only `Created At` (slug `created_at`) onto every record descriptor.
// These tests exercise the REAL `describe` → `describeRecord` →
// `buildTypeDescriptor` path — the production code the prior mock bypassed.
// ---------------------------------------------------------------------------

function makeRecordAdapter(input: {
  teamId: string;
  attrs: Array<{ id: string; name: string; type: string; apiSlug: string; isWritable: boolean; isRequired: boolean; isMulti: boolean; relationshipObjectId?: string; allowedObjectIds?: string[] }>;
  /** Workspace object catalog. Defaults to the single `Deal` object the
   *  INV3/enum tests describe against; multi-target reference tests need
   *  more than one object in the catalog to have anything to resolve. */
  objects?: Array<{ id: string; name: string; slug: string }>;
}): AttioAdapter {
  const adapter = new AttioAdapter({
    teamId: input.teamId as TeamId,
    credentialsId: 'creds-1',
  });
  const fakeClient = {
    listObjects: async () => input.objects ?? [{ id: 'deals', name: 'Deal', slug: 'deals' }],
    // No lists scoped to deals — keeps `describeRecord`'s per-list ref
    // collection empty and focuses the assertion on the object fields.
    listLists: async () => [],
    listAttributes: async () => input.attrs,
  } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
  (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient = async () => fakeClient;
  return adapter;
}

describe('AttioAdapter object within recency key (INV3)', () => {
  it('surfaces `Created At` as a read-only date on a record descriptor even when listAttributes omits it', async () => {
    // Exactly the fake-channels dev-loop shape: object custom attributes
    // with NO system `created_at` (the real Attio attributes endpoint
    // behaves the same). This is what the agent's real path saw.
    const adapter = makeRecordAdapter({
      teamId: 'team-inv3-object',
      attrs: [
        { id: 'attr-name', name: 'Name', type: 'text', apiSlug: 'name', isWritable: true, isRequired: true, isMulti: false },
        { id: 'attr-stage', name: 'Stage', type: 'status', apiSlug: 'stage', isWritable: true, isRequired: false, isMulti: false },
      ],
    });
    const descriptor = await adapter.describe('Deal');
    expect(descriptor).not.toBeNull();
    const createdAt = descriptor!.fields.find((f) => f.displayName === 'Created At');
    // The crux: it MUST be present so `resolveFieldName('Created At')`
    // resolves on the agent's authoring path — the prior mock faked this.
    expect(createdAt).toBeDefined();
    expect(createdAt!.kind).toBe('date');
    // Read-only — writability must not disqualify a `within` recency key.
    expect(createdAt!.writable).toBe(false);
    // The slug matches the records-query filter field so a dispatch-time
    // `{ created_at: { $gte: cutoff } }` filter resolves.
    expect(createdAt!.fieldId).toBe('created_at');
    // The object's own custom attributes still come through.
    expect(descriptor!.fields.some((f) => f.displayName === 'Name')).toBe(true);
  });

  it('does not duplicate `Created At` when a custom attribute already claims the `created_at` slug', async () => {
    const adapter = makeRecordAdapter({
      teamId: 'team-inv3-collide',
      attrs: [
        { id: 'attr-name', name: 'Name', type: 'text', apiSlug: 'name', isWritable: true, isRequired: true, isMulti: false },
        { id: 'attr-c', name: 'Custom Created', type: 'date', apiSlug: 'created_at', isWritable: true, isRequired: false, isMulti: false },
      ],
    });
    const descriptor = await adapter.describe('Deal');
    const createdAtFields = descriptor!.fields.filter((f) => f.fieldId === 'created_at');
    // Exactly one — the object's own attribute wins, no synthetic duplicate.
    expect(createdAtFields).toHaveLength(1);
    expect(createdAtFields[0].displayName).toBe('Custom Created');
  });
});

// ---------------------------------------------------------------------------
// Enum options on descriptors. Attio serves select options and status
// values from dedicated endpoints (`/options`, `/statuses`) — they are
// never inline on the attributes list, so `buildTypeDescriptor` must
// fetch them or every select/status field reaches the extraction
// entity guide as an enum with no allowed values (EXTRACT_VALUE then
// can't see them — ruling 2026-06-10).
// ---------------------------------------------------------------------------

describe('AttioAdapter descriptor enum options', () => {
  function makeEnumAdapter(input: {
    teamId: string;
    statuses?: Record<string, { id: string; name: string }[]>;
    options?: Record<string, { id: string; name: string }[]>;
    failOptions?: boolean;
  }): AttioAdapter {
    const adapter = new AttioAdapter({
      teamId: input.teamId as TeamId,
      credentialsId: 'creds-1',
    });
    const fakeClient = {
      listObjects: async () => [{ id: 'deals', name: 'Deal', slug: 'deals' }],
      listLists: async () => [],
      listAttributes: async () => [
        { id: `${input.teamId}-attr-name`, name: 'Name', type: 'text', apiSlug: 'name', isWritable: true, isRequired: true, isMulti: false },
        { id: `${input.teamId}-attr-stage`, name: 'Stage', type: 'status', apiSlug: 'stage', isWritable: true, isRequired: false, isMulti: false },
        { id: `${input.teamId}-attr-source`, name: 'Source', type: 'select', apiSlug: 'source', isWritable: true, isRequired: false, isMulti: false },
      ],
      listStatuses: async ({ attributeId }: { attributeId: string }) => {
        if (input.failOptions) throw new Error('boom');
        return input.statuses?.[attributeId] ?? [];
      },
      listAttributeOptions: async ({ attributeId }: { attributeId: string }) => {
        if (input.failOptions) throw new Error('boom');
        return input.options?.[attributeId] ?? [];
      },
    } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
    (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient =
      async () => fakeClient;
    return adapter;
  }

  it('populates enumValues for status and select attributes from their dedicated endpoints', async () => {
    const adapter = makeEnumAdapter({
      teamId: 'team-enum-1',
      statuses: {
        'team-enum-1-attr-stage': [
          { id: 's1', name: 'Lead' },
          { id: 's2', name: 'Won' },
        ],
      },
      options: {
        'team-enum-1-attr-source': [
          { id: 'o1', name: 'Inbound' },
          { id: 'o2', name: 'Referral' },
        ],
      },
    });
    const descriptor = await adapter.describe('Deal');
    const stage = descriptor!.fields.find((f) => f.fieldId === 'stage');
    expect(stage?.kind).toBe('enum');
    expect(stage?.enumValues).toEqual(['Lead', 'Won']);
    const source = descriptor!.fields.find((f) => f.fieldId === 'source');
    expect(source?.enumValues).toEqual(['Inbound', 'Referral']);
    // Non-enum fields stay untouched.
    expect(descriptor!.fields.find((f) => f.fieldId === 'name')?.enumValues).toBeUndefined();
  });

  it('degrades to an option-less enum when the options fetch fails (describe must not throw)', async () => {
    const adapter = makeEnumAdapter({ teamId: 'team-enum-2', failOptions: true });
    const descriptor = await adapter.describe('Deal');
    const stage = descriptor!.fields.find((f) => f.fieldId === 'stage');
    expect(stage?.kind).toBe('enum');
    expect(stage?.enumValues).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reference-valued uniqueness (compound identity). The engine folds a
// resolved parent neighbour into the resolve record as `{ id }` under the
// reference's fieldId (evaluate.ts resolveEdgeContext). The adapter must
// translate that into Attio's reference filter (`target_record_id`) so
// "deals unique by associated company" actually narrows the candidate
// search — previously the whole branch was skipped.
// ---------------------------------------------------------------------------

describe('AttioAdapter reference-valued uniqueness resolution', () => {
  function makeResolveAdapter(input: {
    teamId: string;
    onFilter: (filter: unknown) => void;
  }): AttioAdapter {
    const adapter = new AttioAdapter({
      teamId: input.teamId as TeamId,
      credentialsId: 'creds-1',
    });
    const fakeClient = {
      listObjects: async () => [{ id: 'obj-deals', name: 'Deals', slug: 'deals' }],
      listLists: async () => [],
      listAttributes: async () => [
        { id: 'attr-dname', name: 'Name', type: 'text', apiSlug: 'name', isMulti: false },
        {
          id: 'attr-company',
          name: 'Associated Company',
          type: 'record-reference',
          apiSlug: 'associated_company',
          isMulti: false,
          relationshipObjectId: 'obj-companies',
        },
      ],
      queryRecordsWithFilter: async ({ filter }: { filter: unknown }) => {
        input.onFilter(filter);
        return [{ id: { record_id: 'rec-deal-1' }, values: {} }];
      },
    } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
    (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient =
      async () => fakeClient;
    return adapter;
  }

  it('translates a folded `{ id }` neighbour into a target_record_id filter', async () => {
    let capturedFilter: unknown;
    const adapter = makeResolveAdapter({
      teamId: 'team-ref-resolve',
      onFilter: (f) => {
        capturedFilter = f;
      },
    });
    const result = await adapter.resolveEntity({
      recordType: 'Deals',
      candidates: [],
      constraints: {
        any: [{ all: [{ field: 'name' }, { field: 'associated_company' }] }],
      },
      record: {
        name: 'Series A',
        associated_company: { id: 'rec-acme-co' },
      },
    } as never);

    expect(capturedFilter).toEqual({
      name: { $eq: 'Series A' },
      associated_company: { target_record_id: { $eq: 'rec-acme-co' } },
    });
    expect(result.candidates).toEqual([
      { adapterType: 'attio', externalId: 'rec-deal-1', data: {} },
    ]);
  });

  it('still skips `{ id }` values on non-reference attributes', async () => {
    let queried = false;
    const adapter = makeResolveAdapter({
      teamId: 'team-ref-skip',
      onFilter: () => {
        queried = true;
      },
    });
    const result = await adapter.resolveEntity({
      recordType: 'Deals',
      candidates: [],
      constraints: { any: [{ all: [{ field: 'name' }] }] },
      record: { name: { id: 'not-a-reference-shape' } },
    } as never);
    expect(queried).toBe(false);
    expect(result.candidates).toEqual([]);
  });
});

describe('AttioAdapter.listEventTypes', () => {
  function makeAdapter(teamId: string): AttioAdapter {
    const adapter = new AttioAdapter({ teamId: teamId as TeamId, credentialsId: 'creds-1' });
    const fakeClient = {
      listObjects: async () => [
        { id: 'uuid-companies', name: 'Companies', slug: 'companies' },
        { id: 'uuid-deals', name: 'Deals', slug: 'deals' },
      ],
      listLists: async () => [],
    } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
    (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient =
      async () => fakeClient;
    return adapter;
  }

  it('emits one event type per object, matched on id.object_id', async () => {
    const adapter = makeAdapter('team-eventtypes');
    const types = await adapter.listEventTypes();
    expect(types).toEqual([
      { tag: 'Companies', positionType: 'Companies', match: { path: 'id.object_id', equals: 'uuid-companies' } },
      { tag: 'Deals', positionType: 'Deals', match: { path: 'id.object_id', equals: 'uuid-deals' } },
    ]);
  });

  it('its union discriminates a real inbound Attio webhook payload', async () => {
    const adapter = makeAdapter('team-eventtypes-2');
    const types = await adapter.listEventTypes();
    const { discriminateEvent } = await import('movement-engine/services/translation_graph/engine/inbound/discriminate');
    const result = discriminateEvent({
      adapterType: 'attio',
      event: {
        payload: { event_type: 'record.updated', id: { object_id: 'uuid-deals', record_id: 'rec-7' } },
        externalId: 'rec-7',
      },
      eventTypes: types,
    });
    expect(result?.eventType.positionType).toBe('Deals');
    expect(result?.position.recordType).toBe('Deals');
  });
});

// ---------------------------------------------------------------------------
// getRecordForEvent — the meta-edge hydrate (`ev-[:Companies]->`). The ACTION
// axis (Layer 3) is orthogonal to this OBJECT axis: the variant is on the seed,
// the object is reached here. Pinned unchanged: an object-matching event
// hydrates the live record; a non-matching (Person) event yields an empty
// traversal — the framework's clean no-op.
// ---------------------------------------------------------------------------

describe('AttioAdapter.getRelated — webhook event → record (getRecordForEvent)', () => {
  function makeEventAdapter(teamId: string): AttioAdapter {
    const adapter = new AttioAdapter({ teamId: teamId as TeamId, credentialsId: 'creds-1' });
    const fakeClient = {
      listObjects: async () => [
        { id: 'uuid-companies', name: 'Companies', slug: 'companies' },
        { id: 'uuid-people', name: 'People', slug: 'people' },
      ],
      listLists: async () => [],
      getRecord: async ({ recordId }: { objectId: string; recordId: string }) => ({
        id: { record_id: recordId },
        values: { name: [{ value: 'Acme' }] },
        web_url: null,
      }),
    } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
    (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient =
      async () => fakeClient;
    return adapter;
  }

  const eventPosition = (objectId: string): SourcePosition =>
    makeUnstablePosition({
      adapterType: 'attio',
      // The action variant rides as the seed type (Layer 3 seedEventPosition).
      recordType: 'Record Created',
      data: { event_type: 'record.created', id: { object_id: objectId, record_id: 'co-1' } },
    });

  it('hydrates the live record when the event object matches the edge target', async () => {
    const adapter = makeEventAdapter('team-getrecordforevent-1');
    const related = await adapter.getRelated({
      position: eventPosition('uuid-companies'),
      fieldId: 'Companies',
      direction: 'outgoing',
    });
    expect(related).toHaveLength(1);
    const [hit] = related;
    expect(isStablePosition(hit.position)).toBe(true);
    expect(hit.position.recordType).toBe('Companies');
    expect(positionRecordId(hit.position)).toBe('co-1');
  });

  it('yields an empty traversal when the event is for a different object (the no-op)', async () => {
    const adapter = makeEventAdapter('team-getrecordforevent-2');
    const related = await adapter.getRelated({
      position: eventPosition('uuid-people'),
      fieldId: 'Companies',
      direction: 'outgoing',
    });
    expect(related).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// List entry → parent record back-edge (`entry-[:Companies]->`). The entry
// carries parent_record_id + parent_object; the edge whose object matches the
// entry's parent object hydrates the live record, and a non-matching object
// edge yields the empty no-op — the honest "can't resolve" outcome.
// ---------------------------------------------------------------------------

describe('AttioAdapter.getRelated — list entry → parent record', () => {
  function makeEntryAdapter(teamId: string): AttioAdapter {
    const adapter = new AttioAdapter({ teamId: teamId as TeamId, credentialsId: 'creds-1' });
    const fakeClient = {
      listObjects: async () => [
        { id: 'uuid-companies', name: 'Companies', slug: 'companies' },
        { id: 'uuid-people', name: 'People', slug: 'people' },
      ],
      listLists: async () => [],
      getRecord: async ({ recordId }: { objectId: string; recordId: string }) => ({
        id: { record_id: recordId },
        values: { name: [{ value: 'Acme' }] },
        web_url: null,
      }),
    } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
    (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient =
      async () => fakeClient;
    return adapter;
  }

  const entryPosition = (parentObject: string | null): SourcePosition =>
    makeStablePosition({
      adapterType: 'attio',
      recordType: ATTIO_LIST_ENTRY_TYPE_ID,
      recordId: 'entry-1',
      data: { parent_record_id: 'co-1', parent_object: parentObject, Stage: 'Diligence' },
    });

  it('hydrates the parent record when the object edge matches parent_object', async () => {
    const adapter = makeEntryAdapter('team-entry-rec-1');
    const related = await adapter.getRelated({
      position: entryPosition('companies'),
      fieldId: 'Companies',
      direction: 'outgoing',
    });
    expect(related).toHaveLength(1);
    const [hit] = related;
    expect(isStablePosition(hit.position)).toBe(true);
    expect(hit.position.recordType).toBe('Companies');
    expect(positionRecordId(hit.position)).toBe('co-1');
  });

  it('yields nothing when the object edge does not match the entry parent object', async () => {
    const adapter = makeEntryAdapter('team-entry-rec-2');
    const related = await adapter.getRelated({
      position: entryPosition('companies'),
      fieldId: 'People',
      direction: 'outgoing',
    });
    expect(related).toEqual([]);
  });

  it('yields nothing when the entry parent object cannot be confirmed', async () => {
    const adapter = makeEntryAdapter('team-entry-rec-3');
    const related = await adapter.getRelated({
      position: entryPosition(null),
      fieldId: 'Companies',
      direction: 'outgoing',
    });
    expect(related).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// File-on-write (4d_resources.md): createRecord/updateRecord turn a
// `file`-kind field's `FileRef` value into an Attio /v2/files/upload, instead
// of passing the raw FileRef into the records values envelope (which the API
// rejects). The adapter redeems the FileRef for its bytes and uploads them against the record's own id + object slug.
// ---------------------------------------------------------------------------

describe('AttioAdapter file-on-write', () => {
  beforeEach(() => {
    resetState();
  });

  it('createRecord: uploads a file-kind field against the new record, keeps it out of the values envelope', async () => {
    const uploadCalls: UploadCall[] = [];
    const createCalls: RecordWriteCall[] = [];
    const adapter = makeAdapter({
      teamId: 'team-fow-1',
      uploadCalls,
      createCalls,
      createdRecordId: 'rec-new-co',
    });

    const result = await adapter.createRecord({
      recordType: 'Companies',
      fields: {
        name: 'Acme',
        pitch_deck: makeFileRef({ name: 'deck.pdf', contentType: 'application/pdf' }),
      },
      mutationContext: writeMutationContext,
    });

    // The record was created from the NON-file fields only — the FileRef
    // never reaches the values envelope.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].objectId).toBe('companies');
    expect(createCalls[0].fields).toEqual({ name: 'Acme' });
    expect(createCalls[0].fields).not.toHaveProperty('pitch_deck');

    // The file uploaded against the freshly-created record id + object slug.
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].objectSlug).toBe('companies');
    expect(uploadCalls[0].recordId).toBe('rec-new-co');
    expect(uploadCalls[0].fileName).toBe('deck.pdf');
    expect(new Uint8Array(uploadCalls[0].bytes)).toEqual(FILE_BYTES);

    expect(result.externalId).toBe('rec-new-co');
  });

  it('createRecord: a record with no file fields performs no uploads or fetches', async () => {
    const uploadCalls: UploadCall[] = [];
    const createCalls: RecordWriteCall[] = [];
    const adapter = makeAdapter({ teamId: 'team-fow-2', uploadCalls, createCalls });

    await adapter.createRecord({
      recordType: 'Companies',
      fields: { name: 'Beta', domain: 'beta.com' },
      mutationContext: writeMutationContext,
    });

    // Non-file fields pass through verbatim; nothing is stripped.
    expect(createCalls[0].fields).toEqual({ name: 'Beta', domain: 'beta.com' });
    expect(uploadCalls).toHaveLength(0);
  });

  it('createRecord: multi-cardinality file field uploads each FileRef in the array', async () => {
    const uploadCalls: UploadCall[] = [];
    const createCalls: RecordWriteCall[] = [];
    const adapter = makeAdapter({
      teamId: 'team-fow-3',
      uploadCalls,
      createCalls,
      createdRecordId: 'rec-multi',
    });

    await adapter.createRecord({
      recordType: 'Companies',
      fields: {
        name: 'Gamma',
        attachments: [
          makeFileRef({ name: 'a.pdf' }),
          makeFileRef({ name: 'b.pdf' }),
        ],
      },
      mutationContext: writeMutationContext,
    });

    expect(createCalls[0].fields).toEqual({ name: 'Gamma' });
    expect(uploadCalls).toHaveLength(2);
    expect(uploadCalls.map((c) => c.fileName).sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(uploadCalls.every((c) => c.recordId === 'rec-multi')).toBe(true);
  });

  it('updateRecord: uploads a file-kind field against the existing record id', async () => {
    const uploadCalls: UploadCall[] = [];
    const updateCalls: RecordWriteCall[] = [];
    const adapter = makeAdapter({ teamId: 'team-fow-4', uploadCalls, updateCalls });

    await adapter.updateRecord({
      recordType: 'Companies',
      externalId: 'rec-existing',
      fields: {
        stage: 'Won',
        contract: makeFileRef({ name: 'signed.pdf' }),
      },
      mutationContext: writeMutationContext,
    });

    // Scalar fields patched without the FileRef.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].recordId).toBe('rec-existing');
    expect(updateCalls[0].fields).toEqual({ stage: 'Won' });

    // File uploaded against the existing record id.
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].recordId).toBe('rec-existing');
    expect(uploadCalls[0].objectSlug).toBe('companies');
    expect(uploadCalls[0].fileName).toBe('signed.pdf');
  });

  it('updateRecord: no file fields → no uploads, scalar patch only', async () => {
    const uploadCalls: UploadCall[] = [];
    const updateCalls: RecordWriteCall[] = [];
    const adapter = makeAdapter({ teamId: 'team-fow-5', uploadCalls, updateCalls });

    await adapter.updateRecord({
      recordType: 'Companies',
      externalId: 'rec-x',
      fields: { stage: 'Lost' },
      mutationContext: writeMutationContext,
    });

    expect(updateCalls[0].fields).toEqual({ stage: 'Lost' });
    expect(uploadCalls).toHaveLength(0);
  });

  it('createRecord: a FileRef with no way back to its bytes is a write error', async () => {
    const adapter = makeAdapter({ teamId: 'team-fow-6' });
    await expect(
      adapter.createRecord({
        recordType: 'Companies',
        fields: { logo: fileValue({ __brand: 'FileRef', name: 'x.png' }) },
        mutationContext: writeMutationContext,
      }),
    ).rejects.toThrow(/no handle to its bytes/);
  });

  it('createRecord: a failed byte retrieval surfaces as a write error', async () => {
    const adapter = makeAdapter({ teamId: 'team-fow-7' });
    const failing = fileValue({
      __brand: 'FileRef',
      name: 'deck.pdf',
      source: { store: 'document', objectUri: 'mem://doc/gone' },
    });
    await expect(
      adapter.createRecord({
        recordType: 'Companies',
        fields: { deck: failing },
        mutationContext: writeMutationContext,
      }),
    // A key the store never stored is nobody's: refused by name before any read.
    ).rejects.toThrow(/stored document mem:\/\/doc\/gone, which is not this team's/);
  });
});

// ---------------------------------------------------------------------------
// parentLink — record→record relationship writes (a child action authored
// under a parent via an edge). The reference attribute can live on either
// object, so the adapter must wire the correct side.
// ---------------------------------------------------------------------------

type LinkCall = { objectId: string; recordId?: string; fields: Record<string, unknown> };

function makeLinkAdapter(input: {
  teamId: string;
  attrsByObject: Record<string, unknown[]>;
  createCalls: LinkCall[];
  updateCalls: LinkCall[];
  parentRecordValues?: Record<string, unknown>;
}): AttioAdapter {
  const adapter = new AttioAdapter({ teamId: input.teamId as TeamId, credentialsId: 'creds-1' });
  const fakeClient = {
    listObjects: async () => [
      { id: 'obj-people', slug: 'people', name: 'People' },
      { id: 'obj-comp', slug: 'companies', name: 'Companies' },
    ],
    listLists: async () => [],
    listAttributes: async ({ objectId }: { objectId?: string }) =>
      input.attrsByObject[objectId ?? ''] ?? [],
    getRecord: async ({ recordId }: { objectId: string; recordId: string }) => ({
      id: { record_id: recordId },
      values: input.parentRecordValues ?? {},
      web_url: null,
    }),
    createRecord: async (args: { objectId: string; fields: Record<string, unknown> }) => {
      input.createCalls.push({ objectId: args.objectId, fields: args.fields });
      return { id: { record_id: 'person-new' }, values: {}, web_url: null };
    },
    updateRecord: async (args: { objectId: string; recordId: string; fields: Record<string, unknown> }) => {
      input.updateCalls.push({ objectId: args.objectId, recordId: args.recordId, fields: args.fields });
      return { id: { record_id: args.recordId }, values: {}, web_url: null };
    },
  } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
  (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient = async () =>
    fakeClient;
  return adapter;
}

const refAttr = (apiSlug: string, relationshipObjectId: string, isMulti: boolean) => ({
  id: `attr-${apiSlug}`,
  name: apiSlug,
  type: 'record-reference' as const,
  isMulti,
  relationshipObjectId,
  apiSlug,
  isWritable: true,
});

describe('AttioAdapter.createRecord — parentLink relationship', () => {
  beforeEach(resetState);

  it('child-ref: sets the reference on the child create when the edge lives on the child', async () => {
    const createCalls: LinkCall[] = [];
    const updateCalls: LinkCall[] = [];
    const adapter = makeLinkAdapter({
      teamId: 'team-link-a',
      attrsByObject: {
        'obj-people': [refAttr('company', 'obj-comp', false)],
        'obj-comp': [],
      },
      createCalls,
      updateCalls,
    });
    await adapter.createRecord({
      recordType: 'People',
      fields: { name: 'Jonas Lindqvist' },
      mutationContext: writeMutationContext,
      parentLinks: [{ recordType: 'Companies', externalId: 'comp-1', edgeName: 'company' }],
    });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].fields.company).toEqual([
      { target_object: 'companies', target_record_id: 'comp-1' },
    ]);
    // No follow-up parent update — the link rode the child create.
    expect(updateCalls).toHaveLength(0);
  });

  it('parent-ref: unions the child into the parent multi-reference when the edge lives on the parent', async () => {
    const createCalls: LinkCall[] = [];
    const updateCalls: LinkCall[] = [];
    const adapter = makeLinkAdapter({
      teamId: 'team-link-b',
      attrsByObject: {
        'obj-people': [],
        'obj-comp': [refAttr('team', 'obj-people', true)],
      },
      createCalls,
      updateCalls,
      // Company already has one team member — the new person must be unioned in.
      parentRecordValues: { team: [{ target_object: 'people', target_record_id: 'person-existing' }] },
    });
    await adapter.createRecord({
      recordType: 'People',
      fields: { name: 'Jonas Lindqvist' },
      mutationContext: writeMutationContext,
      parentLinks: [{ recordType: 'Companies', externalId: 'comp-1', edgeName: 'team' }],
    });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].fields.team).toBeUndefined(); // not set on the child
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ objectId: 'obj-comp', recordId: 'comp-1' });
    expect(updateCalls[0].fields.team).toEqual([
      { target_object: 'people', target_record_id: 'person-existing' },
      { target_object: 'people', target_record_id: 'person-new' },
    ]);
  });

  it('an author names the edge by its TITLE; the write lands on the api slug', async () => {
    const createCalls: LinkCall[] = [];
    const updateCalls: LinkCall[] = [];
    const adapter = makeLinkAdapter({
      teamId: 'team-link-titled',
      attrsByObject: {
        // Title ("Company") and api slug ("parent_object") diverge — the
        // program text carries the title, the payload carries the slug.
        'obj-people': [{ ...refAttr('parent_object', 'obj-comp', false), name: 'Company' }],
        'obj-comp': [],
      },
      createCalls,
      updateCalls,
    });
    await adapter.createRecord({
      recordType: 'People',
      fields: { name: 'Jonas Lindqvist' },
      mutationContext: writeMutationContext,
      parentLinks: [{ recordType: 'Companies', externalId: 'comp-1', edgeName: 'Company' }],
    });
    expect(createCalls[0].fields.parent_object).toEqual([
      { target_object: 'companies', target_record_id: 'comp-1' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// actor-reference ("User") fields — e.g. Deal owner, Created by. These are
// SETTABLE by email, not edges. Regression: they were mapped to kind
// 'reference', never added to `references`, and silently dropped by
// schema_projection — so a required User field disappeared from the editor.
// ---------------------------------------------------------------------------

function makeActorAdapter(input: {
  teamId: string;
  createCalls?: RecordWriteCall[];
}): AttioAdapter {
  const adapter = new AttioAdapter({
    teamId: input.teamId as TeamId,
    credentialsId: 'creds-1',
  });
  const fakeClient = {
    listObjects: async () => [{ id: 'deals', name: 'Deal', slug: 'deals' }],
    listLists: async () => [],
    listAttributes: async () => [
      {
        id: 'attr-owner',
        name: 'Deal owner',
        type: 'actor-reference',
        apiSlug: 'deal_owner',
        isWritable: true,
        isRequired: true,
        isMulti: false,
      },
      {
        id: 'attr-name',
        name: 'Deal name',
        type: 'text',
        apiSlug: 'deal_name',
        isWritable: true,
        isRequired: true,
        isMulti: false,
      },
    ],
    listWorkspaceMembers: async () => [
      { id: 'wm-jonas', firstName: 'Jonas', lastName: 'L', email: 'jonas@example.com' },
    ],
    createRecord: async (args: { objectId: string; fields: Record<string, unknown> }) => {
      input.createCalls?.push({ objectId: args.objectId, fields: args.fields });
      return {
        id: { record_id: 'deal-created-1' },
        values: {},
        web_url: 'https://app.attio.com/deal-created-1',
      };
    },
  } as unknown as Awaited<ReturnType<typeof import('../../../adapters/attio/apiClient').getAttioClient>>;
  (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient = async () => fakeClient;
  return adapter;
}

describe('AttioAdapter actor-reference (User) fields', () => {
  it('describe surfaces an actor-reference attribute as a writable, required field (not an edge)', async () => {
    const adapter = makeActorAdapter({ teamId: 'team-actor-describe' });
    const descriptor = await adapter.describe('Deal');
    expect(descriptor).not.toBeNull();

    const owner = descriptor!.fields.find((f) => f.displayName === 'Deal owner');
    expect(owner).toBeDefined();
    expect(owner!.kind).toBe('string');
    expect(owner!.writable).toBe(true);
    expect(owner!.required).toBe(true);

    // It must NOT have leaked into references (that's record-reference's lane);
    // an actor-reference is a settable value, not a traversable edge.
    expect(descriptor!.references.some((r) => r.fieldId === 'deal_owner')).toBe(false);
  });

  it('createRecord resolves an owner email to the workspace-member write shape (case-insensitive)', async () => {
    const createCalls: RecordWriteCall[] = [];
    const adapter = makeActorAdapter({ teamId: 'team-actor-write', createCalls });

    await adapter.createRecord({
      recordType: 'Deal',
      fields: { deal_owner: 'Jonas@Example.com', deal_name: 'Acme deal' },
      mutationContext: writeMutationContext,
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].fields.deal_owner).toEqual([
      { referenced_actor_type: 'workspace-member', referenced_actor_id: 'wm-jonas' },
    ]);
    // Non-actor fields pass through untouched.
    expect(createCalls[0].fields.deal_name).toBe('Acme deal');
  });

  it('createRecord drops an owner email that matches no workspace member', async () => {
    const createCalls: RecordWriteCall[] = [];
    const adapter = makeActorAdapter({ teamId: 'team-actor-unresolved', createCalls });

    await adapter.createRecord({
      recordType: 'Deal',
      fields: { deal_owner: 'external-founder@startup.com', deal_name: 'Acme deal' },
      mutationContext: writeMutationContext,
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].fields).not.toHaveProperty('deal_owner');
    expect(createCalls[0].fields.deal_name).toBe('Acme deal');
  });
});

// Event subscriptions: Attio rejects a webhook subscription that omits `filter`
// (400 validation_type on `subscriptions[].filter`). Every subscription must
// carry it — `null` means "no filter", the listen semantics here. Regression
// guard for the silent webhook-registration failure that also stalled saves.
describe('ensureEventSubscription — Attio webhook payload', () => {
  it('sends filter: null on every subscription when creating a webhook', async () => {
    const webhookCalls: { subscriptions: unknown }[] = [];
    const adapter = makeAdapter({ teamId: 'team-webhook-create', webhookCalls });

    const result = await adapter.ensureEventSubscription({
      events: ['record.created', 'record.updated'],
      callbackUrl: 'https://example.test/cb',
    });

    expect(result).toEqual({ externalId: 'wh-1', secret: 'shh' });
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0].subscriptions).toEqual([
      { event_type: 'record.created', filter: null },
      { event_type: 'record.updated', filter: null },
    ]);
  });

  it('sends filter: null when PATCHing an existing webhook whose events changed', async () => {
    const webhookCalls: { subscriptions: unknown }[] = [];
    const adapter = makeAdapter({ teamId: 'team-webhook-update', webhookCalls });

    await adapter.ensureEventSubscription({
      events: ['record.created', 'record.deleted'],
      callbackUrl: 'https://example.test/cb',
      current: { externalId: 'wh-existing', events: ['record.created'] },
    });

    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0].subscriptions).toEqual([
      { event_type: 'record.created', filter: null },
      { event_type: 'record.deleted', filter: null },
    ]);
  });
});

// Regression guard for the 'attio:companies' drift: the webhook-event's
// record-for-event edges must target the object's NATURAL entry typeId
// (obj.name, e.g. 'Companies'), NOT the retired `attio:<slug>` codec. Object
// entry points are keyed `typeId: obj.name` (post typeid→displayname refactor),
// so a stale `attio:companies` target fails to resolve in the projection and
// surface-stamps a traversed record with the unresolvable colon-key — which is
// exactly what broke `evt-[co:Companies]-> { … co.Domains }` in production.
describe('describeWebhookEvent — record-for-event edge targets', () => {
  it('targets the object entry typeId (natural name), not attio:<slug>', async () => {
    const adapter = makeAdapter({ teamId: 'team-webhook-edge' });
    const descriptor = await adapter.describe(ATTIO_WEBHOOK_EVENT_TYPE_ID);
    const companiesEdge = descriptor!.references.find((r) => r.fieldId === 'Companies');
    expect(companiesEdge).toBeDefined();
    // The fake catalog's object is { id:'companies', name:'Companies', slug:'companies' };
    // its entry point typeId is obj.name = 'Companies', so the edge must match it.
    expect(companiesEdge!.targetTypeId).toBe('Companies');
  });

  it('publishes a PER-LIST entry edge (not a generic `Entry`), symmetric with the record edges', async () => {
    const adapter = makeRootReadAdapter('team-webhook-perlist');
    const descriptor = await adapter.describe(ATTIO_WEBHOOK_EVENT_TYPE_ID);
    const names = descriptor!.references.map((r) => r.fieldId);
    // 'Hot Leads' is the workspace's one list; its entry edge lands on the
    // per-list type (which carries its single parent), replacing the old
    // generic `Entry` → `List Entry` hop.
    expect(names).toContain('Hot Leads');
    expect(descriptor!.references.find((r) => r.fieldId === 'Hot Leads')!.targetTypeId).toBe('Hot Leads');
    expect(names).not.toContain('Entry');
  });

  it('the generic `List Entry` publishes NO parent up-hop — the empty intersection (layer 11)', async () => {
    const adapter = makeRootReadAdapter('team-generic-listentry');
    const descriptor = await adapter.describe('List Entry');
    // No Companies/People/... parent up-hops on the generic union; the parent
    // is reached by narrowing to a list (the webhook event's per-list edge).
    expect(descriptor!.references.find((r) => r.fieldId === 'Companies')).toBeUndefined();
    expect(descriptor!.references.find((r) => r.fieldId === 'People')).toBeUndefined();
    // Only the genuinely-universal attachable reads survive (every entry can
    // carry notes/tasks/comments).
    expect(descriptor!.references.every((r) => ['Notes', 'Tasks', 'Comments'].includes(r.fieldId))).toBe(true);
  });
});

// Hardening guard (sibling of the attio:companies drift): a record-reference
// whose target object can't be named from the workspace catalog must be DROPPED,
// not emitted with the raw object UUID as its targetTypeId — an unresolvable
// target leaks an internal id and drifts at traversal-time field resolution.
describe('describe — record-reference to an un-nameable object is dropped', () => {
  it('keeps a resolvable reference (natural target) and drops one whose object is absent', async () => {
    const adapter = makeRecordAdapter({
      teamId: 'team-rel-drop',
      attrs: [
        { id: 'a-name', name: 'Name', type: 'text', apiSlug: 'name', isWritable: true, isRequired: false, isMulti: false },
        // target 'deals' IS in the catalog → resolves to the natural 'Deal'
        { id: 'a-ok', name: 'Related', type: 'record-reference', apiSlug: 'related_deal', isWritable: true, isRequired: false, isMulti: false, relationshipObjectId: 'deals' },
        // target UUID is NOT in the catalog → the edge is dropped (no UUID leak)
        { id: 'a-ghost', name: 'Ghost', type: 'record-reference', apiSlug: 'ghost', isWritable: true, isRequired: false, isMulti: false, relationshipObjectId: 'ghost-object-uuid' },
      ],
    });
    const d = await adapter.describe('Deal');
    expect(d!.references.find((r) => r.fieldId === 'related_deal')?.targetTypeId).toBe('Deal');
    expect(d!.references.find((r) => r.fieldId === 'ghost')).toBeUndefined();
    expect(d!.references.every((r) => r.targetTypeId !== 'ghost-object-uuid')).toBe(true);
  });
});

// A record-reference created through the Attio UI arrives with
// `relationship: null` — Attio only mints the paired `relationship` for its own
// built-in links. Its targets live in `config.record_reference.allowed_object_ids`
// instead. Reading targets from `relationship` alone made EVERY UI-created
// reference invisible: no edge, and (worse) it fell through to the field branch
// where kind `reference` is silently discarded by the movement projection — a
// phantom that is neither field nor edge, with nothing logged.
describe('describe — record-reference with relationship: null (UI-created)', () => {
  const ATTIO_OBJECTS = [
    { id: 'deals', name: 'Deal', slug: 'deals' },
    { id: 'people', name: 'Person', slug: 'people' },
    { id: 'companies', name: 'Company', slug: 'companies' },
  ];
  const NAME_ATTR = { id: 'a-name', name: 'Name', type: 'text', apiSlug: 'name', isWritable: true, isRequired: false, isMulti: false };

  beforeEach(() => {
    (logger.warn as jest.Mock).mockClear();
  });

  it('declares the edge from allowed_object_ids when relationship is absent', async () => {
    const adapter = makeRecordAdapter({
      teamId: 'team-allowed-single',
      objects: ATTIO_OBJECTS,
      attrs: [
        NAME_ATTR,
        { id: 'a-gps', name: 'GPs', type: 'record-reference', apiSlug: 'gps', isWritable: true, isRequired: false, isMulti: true, allowedObjectIds: ['people'] },
      ],
    });
    const d = await adapter.describe('Deal');
    const gps = d!.references.find((r) => r.fieldId === 'gps');
    expect(gps).toBeDefined();
    // The fieldId MUST stay the api slug — `getRecordReferenceTargets` keys the
    // runtime traversal on it, so any other identity breaks the read.
    expect(gps!.targetTypeId).toBe('Person');
    expect(gps!.name).toBe('GPs');
    expect(gps!.cardinality).toBe('many');
    expect(gps!.writable).toBe(true);
    // …and it must NOT also land as a (silently-discarded) reference field.
    expect(d!.fields.find((f) => f.fieldId === 'gps')).toBeUndefined();
  });

  it('a single-valued allowed reference is cardinality one', async () => {
    const adapter = makeRecordAdapter({
      teamId: 'team-allowed-one',
      objects: ATTIO_OBJECTS,
      attrs: [
        NAME_ATTR,
        { id: 'a-lead', name: 'Lead Partner', type: 'record-reference', apiSlug: 'lead_partner', isWritable: false, isRequired: true, isMulti: false, allowedObjectIds: ['people'] },
      ],
    });
    const d = await adapter.describe('Deal');
    const lead = d!.references.find((r) => r.fieldId === 'lead_partner')!;
    expect(lead.cardinality).toBe('one');
    expect(lead.required).toBe(true);
    // Attio marks derived / read-only attributes unwritable — no write promise.
    expect(lead.writable).toBeUndefined();
  });

  it('publishes a multi-target reference as ONE edge over the whole target set', async () => {
    const adapter = makeRecordAdapter({
      teamId: 'team-allowed-multi',
      objects: ATTIO_OBJECTS,
      attrs: [
        NAME_ATTR,
        { id: 'a-any', name: 'Counterparty', type: 'record-reference', apiSlug: 'counterparty', isWritable: true, isRequired: false, isMulti: false, allowedObjectIds: ['people', 'companies'] },
      ],
    });
    const d = await adapter.describe('Deal');
    const ref = d!.references.find((r) => r.fieldId === 'counterparty')!;
    expect(ref.targetTypeIds).toEqual(['Person', 'Company']);
    // The single field stays honest — it is one of the members, so a consumer
    // that reads only it names a type the edge really can land on.
    expect(ref.targetTypeIds).toContain(ref.targetTypeId);
    expect(d!.fields.find((f) => f.fieldId === 'counterparty')).toBeUndefined();
  });

  it('drops an uncatalogued member LOUDLY and publishes the rest as the union', async () => {
    const adapter = makeRecordAdapter({
      teamId: 'team-allowed-multi-partial',
      objects: ATTIO_OBJECTS,
      attrs: [
        NAME_ATTR,
        { id: 'a-any', name: 'Counterparty', type: 'record-reference', apiSlug: 'counterparty', isWritable: true, isRequired: false, isMulti: false, allowedObjectIds: ['people', 'companies', 'ghost-object-uuid'] },
      ],
    });
    const d = await adapter.describe('Deal');
    const ref = d!.references.find((r) => r.fieldId === 'counterparty')!;
    expect(ref.targetTypeIds).toEqual(['Person', 'Company']);
    expect(
      (logger.warn as jest.Mock).mock.calls.some(([msg]) =>
        String(msg).includes('ghost-object-uuid'),
      ),
    ).toBe(true);
  });

  it('a set that resolves to ONE member is an ordinary single-target edge', async () => {
    const adapter = makeRecordAdapter({
      teamId: 'team-allowed-multi-one',
      objects: ATTIO_OBJECTS,
      attrs: [
        NAME_ATTR,
        { id: 'a-any', name: 'Counterparty', type: 'record-reference', apiSlug: 'counterparty', isWritable: true, isRequired: false, isMulti: false, allowedObjectIds: ['people', 'ghost-object-uuid'] },
      ],
    });
    const d = await adapter.describe('Deal');
    const ref = d!.references.find((r) => r.fieldId === 'counterparty')!;
    expect(ref.targetTypeId).toBe('Person');
    expect(ref.targetTypeIds).toBeUndefined();
  });

  it('skips an UNRESTRICTED reference (no allowed_object_ids) LOUDLY', async () => {
    const adapter = makeRecordAdapter({
      teamId: 'team-allowed-none',
      objects: ATTIO_OBJECTS,
      attrs: [
        NAME_ATTR,
        { id: 'a-any', name: 'Anything', type: 'record-reference', apiSlug: 'anything', isWritable: true, isRequired: false, isMulti: false },
        { id: 'a-empty', name: 'Empty', type: 'record-reference', apiSlug: 'empty', isWritable: true, isRequired: false, isMulti: false, allowedObjectIds: [] },
      ],
    });
    const d = await adapter.describe('Deal');
    for (const slug of ['anything', 'empty']) {
      expect(d!.references.find((r) => r.fieldId === slug)).toBeUndefined();
      expect(d!.fields.find((f) => f.fieldId === slug)).toBeUndefined();
      expect((logger.warn as jest.Mock).mock.calls.some(([msg]) => String(msg).includes(slug))).toBe(true);
    }
  });

  it('an allowed target absent from the workspace catalog is skipped LOUDLY, never emitted as a raw UUID', async () => {
    const adapter = makeRecordAdapter({
      teamId: 'team-allowed-ghost',
      objects: ATTIO_OBJECTS,
      attrs: [
        NAME_ATTR,
        { id: 'a-ghost', name: 'Ghost', type: 'record-reference', apiSlug: 'ghost', isWritable: true, isRequired: false, isMulti: false, allowedObjectIds: ['ghost-object-uuid'] },
      ],
    });
    const d = await adapter.describe('Deal');
    expect(d!.references.find((r) => r.fieldId === 'ghost')).toBeUndefined();
    expect(d!.references.every((r) => r.targetTypeId !== 'ghost-object-uuid')).toBe(true);
    expect(d!.fields.find((f) => f.fieldId === 'ghost')).toBeUndefined();
    expect((logger.warn as jest.Mock).mock.calls.some(([msg]) => String(msg).includes('ghost'))).toBe(true);
  });

  it('relationship wins when BOTH are present (built-in links keep their paired target)', async () => {
    const adapter = makeRecordAdapter({
      teamId: 'team-allowed-both',
      objects: ATTIO_OBJECTS,
      attrs: [
        NAME_ATTR,
        { id: 'a-both', name: 'Company', type: 'record-reference', apiSlug: 'associated_company', isWritable: true, isRequired: false, isMulti: false, relationshipObjectId: 'companies', allowedObjectIds: ['companies'] },
      ],
    });
    const d = await adapter.describe('Deal');
    expect(d!.references.find((r) => r.fieldId === 'associated_company')!.targetTypeId).toBe('Company');
  });
});

import { extractAttioValue, flattenAttioRecordValues } from '../adapters/attio';

// Attio status / select values nest the chosen option under `status` /
// `option` with a human `title`. Reading them back must yield that title —
// the raw envelope stringifies as "[object Object]" AND makes the engine's
// re-check of a pushed-down `Deal stage == "Lead"` filter compare an object
// to a string, silently matching nothing (found live on the demo team,
// 2026-07-07).
describe('extractAttioValue — status and select options', () => {
  it('reads a status value back as its option title', () => {
    expect(
      extractAttioValue([
        { active_from: '2026-07-07', status: { id: { status_id: 's1' }, title: 'Lead', is_archived: false } },
      ]),
    ).toBe('Lead');
  });

  it('reads a select value back as its option title', () => {
    expect(
      extractAttioValue([
        { active_from: '2026-07-07', option: { id: { option_id: 'o1' }, title: 'SAAS', is_archived: false } },
      ]),
    ).toBe('SAAS');
  });

  it('plain scalar values are unchanged', () => {
    expect(extractAttioValue([{ value: 42 }])).toBe(42);
  });
});

describe('flattenAttioRecordValues — status and select options', () => {
  it('flattens status and select to their option titles', () => {
    expect(
      flattenAttioRecordValues({
        stage: [{ status: { title: 'Won 🎉' } }],
        categories: [{ option: { title: 'Technology' } }],
        name: [{ value: 'Acme' }],
      }),
    ).toEqual({ stage: 'Won 🎉', categories: 'Technology', name: 'Acme' });
  });
});

// ---------------------------------------------------------------------------
// readable means readable (7_readable_means_readable.md) — the entry list's
// promises, the root reads behind them, and the record-reference traversal.
// Verified against Attio's OpenAPI spec: GET /v2/notes and GET /v2/tasks take
// no required filters (root-enumerable → category 3, reads wired below);
// comments have no list endpoint and GET /v2/files requires object+record_id
// (child types → category 1, readable: false).
// ---------------------------------------------------------------------------

/** An adapter whose fake client covers the introspection + root-read surface. */
function makeRootReadAdapter(teamId: string): AttioAdapter {
  const adapter = new AttioAdapter({
    teamId: teamId as TeamId,
    credentialsId: 'creds-1',
  });
  const attr = (input: {
    slug: string;
    name: string;
    type: string;
    relationshipObjectId?: string;
  }) => ({
    id: `${input.slug}-id`,
    name: input.name,
    description: null,
    type: input.type,
    isMulti: false,
    relationshipObjectId: input.relationshipObjectId,
    isRequired: false,
    isUnique: false,
    isWritable: true,
    apiSlug: input.slug,
  });
  const fakeClient = {
    listObjects: async () => [
      { id: 'companies-uuid', name: 'Companies', slug: 'companies' },
      { id: 'people-uuid', name: 'People', slug: 'people' },
    ],
    listLists: async () => [
      { id: 'hot-uuid', name: 'Hot Leads', parentObjectSlugs: ['companies'], apiSlug: 'hot_leads' },
    ],
    listAttributes: async (args: { objectId?: string; listId?: string }) => {
      if (args.listId === 'hot-uuid') return [attr({ slug: 'stage', name: 'Stage', type: 'status' })];
      if (args.objectId === 'people-uuid') {
        return [
          attr({ slug: 'name', name: 'Name', type: 'personal-name' }),
          attr({
            slug: 'parent_object',
            name: 'Company',
            type: 'record-reference',
            relationshipObjectId: 'companies-uuid',
          }),
        ];
      }
      return [attr({ slug: 'name', name: 'Name', type: 'text' })];
    },
    listStatuses: async () => [],
    listAttributeOptions: async () => [],
    listWorkspaceMembers: async () => [
      { id: 'member-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
    ],
    // The record-scope params (parent_object/parent_record_id, linked_object/
    // linked_record_id) mirror the real endpoints' OPTIONAL filters: absent ⇒
    // the workspace enumeration (the root read), present ⇒ one record's rows
    // (the record-scoped edge read). The fake honours them so a test can pin
    // that the adapter actually SENDS the scope.
    listNotesPage: async ({
      offset,
      parentObject,
      parentRecordId,
    }: {
      limit: number;
      offset: number;
      parentObject?: string;
      parentRecordId?: string;
    }) => {
      const all = [
        {
          id: { workspace_id: 't', note_id: 'note-1' },
          title: 'First note',
          content_plaintext: 'hello',
          parent_object: 'companies',
          parent_record_id: 'rec-1',
          created_at: '2026-07-01T00:00:00Z',
        },
        {
          id: { workspace_id: 't', note_id: 'note-2' },
          title: 'Someone else’s note',
          content_plaintext: 'other',
          parent_object: 'companies',
          parent_record_id: 'rec-OTHER',
          created_at: '2026-07-01T01:00:00Z',
        },
      ];
      if (offset > 0) return [];
      return all
        .filter((n) => (parentObject ? n.parent_object === parentObject : true))
        .filter((n) => (parentRecordId ? n.parent_record_id === parentRecordId : true));
    },
    listTasksPage: async ({
      offset,
      linkedObject,
      linkedRecordId,
    }: {
      limit: number;
      offset: number;
      linkedObject?: string;
      linkedRecordId?: string;
    }) => {
      const all = [
        {
          id: { workspace_id: 't', task_id: 'task-1' },
          content_plaintext: 'call Acme',
          deadline_at: null,
          is_completed: false,
          completed_at: null,
          created_at: '2026-07-02T00:00:00Z',
          linked: { object: 'companies', recordId: 'rec-1' },
        },
        {
          id: { workspace_id: 't', task_id: 'task-2' },
          content_plaintext: 'call Someone Else',
          deadline_at: null,
          is_completed: false,
          completed_at: null,
          created_at: '2026-07-02T01:00:00Z',
          linked: { object: 'companies', recordId: 'rec-OTHER' },
        },
      ];
      if (offset > 0) return [];
      return all
        .filter((t) => (linkedObject ? t.linked.object === linkedObject : true))
        .filter((t) => (linkedRecordId ? t.linked.recordId === linkedRecordId : true))
        .map(({ linked: _linked, ...t }) => t);
    },
    listThreadsPage: async (input: {
      limit: number;
      offset: number;
      recordId?: string;
      object?: string;
      entryId?: string;
      list?: string;
    }) => {
      if (input.offset > 0) return [];
      // One thread on rec-1 (companies); one on entry-1 (hot-uuid list).
      const recordThread = {
        id: { workspace_id: 't', thread_id: 'thread-1' },
        created_at: '2026-07-04T00:00:00Z',
        comments: [
          {
            id: { workspace_id: 't', comment_id: 'comment-1' },
            thread_id: 'thread-1',
            content_plaintext: 'Let’s close this',
            resolved_at: null,
            created_at: '2026-07-04T00:00:00Z',
            author: { type: 'workspace-member', id: 'member-1' },
          },
        ],
      };
      const entryThread = {
        id: { workspace_id: 't', thread_id: 'thread-2' },
        created_at: '2026-07-05T00:00:00Z',
        comments: [
          {
            id: { workspace_id: 't', comment_id: 'comment-2' },
            thread_id: 'thread-2',
            content_plaintext: 'Entry-side remark',
            resolved_at: null,
            created_at: '2026-07-05T00:00:00Z',
            author: { type: 'api-token', id: null },
          },
        ],
      };
      if (input.recordId === 'rec-1' && input.object === 'companies') return [recordThread];
      if (input.entryId === 'entry-1' && input.list === 'hot-uuid') return [entryThread];
      return [];
    },
    listFilesPage: async ({ object, recordId }: { object: string; recordId: string; cursor?: string }) =>
      object === 'companies' && recordId === 'rec-1'
        ? {
            files: [
              {
                file_type: 'file' as const,
                id: { workspace_id: 't', file_id: 'file-api-1' },
                name: 'attached.pdf',
                content_type: 'application/pdf',
                created_at: '2026-07-06T00:00:00Z',
              },
            ],
            nextCursor: null,
          }
        : { files: [], nextCursor: null },
    queryListEntriesPage: async ({ offset }: { listId: string; limit: number; offset: number }) =>
      offset === 0
        ? [
            {
              entryId: 'entry-1',
              parentRecordId: 'rec-1',
              parentObjectId: 'companies',
              entryValues: { stage: [{ status: { title: 'New' } }] },
              createdAt: '2026-07-03T00:00:00Z',
            },
          ]
        : [],
    getRecord: async ({ recordId }: { objectId: string; recordId: string }) => ({
      id: { record_id: recordId },
      values: { name: [{ value: 'Acme' }] },
    }),
  };
  (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient =
    async () => fakeClient;
  return adapter;
}

const attioMeta = makeMetaPosition('attio') as SourcePosition;

describe('AttioAdapter listEntryPoints — readable means readable', () => {
  it('publishes honest root promises per entry (rule 0: access lives where access is real)', async () => {
    const adapter = makeRootReadAdapter('team-entry-honesty');
    const entries = await adapter.listEntryPoints();
    const byName = new Map(entries.map((e) => [e.displayName, e]));
    // Records OWN their tasks and notes — no root promise at all. Both are
    // reached AND created through the record (`record-[:Tasks]->` /
    // `record-[:Notes]->`); the workspace-wide GET is API-shape rule 0 reverses.
    expect(byName.get('Task')).toMatchObject({ readable: false, writable: false });
    expect(byName.get('Note')).toMatchObject({ readable: false, writable: false });
    // Per-list roots stay READABLE — a list's entries are list-native
    // (enumerated by the list, POST /v2/lists/{list}/entries/query, not by a
    // record), a real root read (rule 8). But NOT writable: a per-list ENTRY
    // needs the parent record `createPerListEntry` attaches to, which a root
    // write can't supply — so the entry WRITE moved to `<record>-[:Lists]->`
    // and the top-level list write now fails at the checker, not at run time.
    expect(byName.get('Hot Leads')).toMatchObject({ readable: true, writable: false });
    // Reachable ONLY through their parent: no root promise at all. Lists
    // live under their parent object (`record-[:Lists]->`); comments and
    // files live on the record (reads AND creates).
    expect(byName.get('List')).toMatchObject({ readable: false, writable: false });
    expect(byName.get('Comment')).toMatchObject({ readable: false, writable: false });
    expect(byName.get('File')).toMatchObject({ readable: false, writable: false });
    expect(byName.get('List Entry')).toMatchObject({ readable: false, writable: false });
    // The event edge's promise is `fires`, never read.
    const event = byName.get('Webhook Event');
    expect(event).toMatchObject({ readable: false, writable: false });
    expect(event?.fires).toBe(true);
  });

  it('the inert scope declaration is gone from every entry', async () => {
    const adapter = makeRootReadAdapter('team-entry-scope');
    const entries = await adapter.listEntryPoints();
    expect(entries.every((e) => e.scope === undefined)).toBe(true);
  });

  it('the entry list and the meta node publish the same root edges', async () => {
    const adapter = makeRootReadAdapter('team-entry-walk-agree');
    const entries = await adapter.listEntryPoints();
    const meta = await adapter.describe('__adapter_meta__');
    const metaEdgeNames = new Set(meta!.references.map((r) => r.name ?? r.fieldId));
    for (const entry of entries) {
      if (entry.fires === true) {
        // An event edge must not mint a collection (8_event_edges.md).
        expect(metaEdgeNames.has(entry.displayName)).toBe(false);
      } else if (entry.readable || entry.writable) {
        expect(metaEdgeNames.has(entry.collectionName ?? entry.displayName)).toBe(true);
        // ...and make the same write promise on it.
        const edge = meta!.references.find((r) => (r.name ?? r.fieldId) === (entry.collectionName ?? entry.displayName));
        expect({ edge: edge?.fieldId, writable: edge?.writable === true }).toEqual({
          edge: edge?.fieldId,
          writable: entry.writable === true,
        });
      }
    }
    // ...no meta edge exists for ANY record-owned type (rule 0): Note and Task
    // are record-owned exactly like List / Comment / File, so none carries a
    // root edge — reached only through the record.
    const byField = new Map(meta!.references.map((r) => [r.fieldId, r]));
    expect(byField.has('List')).toBe(false);
    expect(byField.has('Comment')).toBe(false);
    expect(byField.has('File')).toBe(false);
    expect(byField.has('Note')).toBe(false);
    expect(byField.has('Task')).toBe(false);
  });
});

describe('AttioAdapter root collection reads (the wired category-3 reads)', () => {
  it('a root Note read fails loudly, pointing at the record path', async () => {
    const adapter = makeRootReadAdapter('team-root-notes');
    await expect(
      adapter.getRelated({ position: attioMeta, fieldId: 'Note', direction: 'outgoing' }),
    ).rejects.toThrow(/notes live on the record they annotate/);
  });

  it('a root Task read fails loudly, pointing at the record path', async () => {
    const adapter = makeRootReadAdapter('team-root-tasks');
    await expect(
      adapter.getRelated({ position: attioMeta, fieldId: 'Task', direction: 'outgoing' }),
    ).rejects.toThrow(/tasks live on the record they belong to/);
  });

  it('record-[:Lists]-> lands on the lists under the record’s object (rule 0)', async () => {
    const adapter = makeRootReadAdapter('team-record-lists');
    const company = makeStablePosition({
      adapterType: 'attio',
      recordType: 'Companies',
      recordId: 'rec-1',
      data: {},
    });
    const results = await adapter.getRelated({
      position: company,
      fieldId: 'Lists',
      direction: 'outgoing',
    });
    expect(results).toHaveLength(1);
    // Lands on THIS object's membership type (layer 12), agreeing with the
    // `Lists` edge target — not the generic `List`.
    expect(results[0].position.recordType).toBe('Companies List');
    await expect(
      adapter.getFieldValue({ position: results[0].position, fieldId: 'Name' }),
    ).resolves.toBe('Hot Leads');
    // An object no list scopes to has none.
    const person = makeStablePosition({
      adapterType: 'attio',
      recordType: 'People',
      recordId: 'person-1',
      data: {},
    });
    await expect(
      adapter.getRelated({ position: person, fieldId: 'Lists', direction: 'outgoing' }),
    ).resolves.toEqual([]);
  });

  it('a root List read fails loudly, pointing at the parent-object path', async () => {
    const adapter = makeRootReadAdapter('team-root-lists');
    await expect(
      adapter.getRelated({ position: attioMeta, fieldId: 'List', direction: 'outgoing' }),
    ).rejects.toThrow(/lists live under their parent object/);
  });

  it('a per-list root read yields the list entries as per-list positions', async () => {
    const adapter = makeRootReadAdapter('team-root-perlist');
    const results = await adapter.getRelated({
      position: attioMeta,
      fieldId: 'Hot Leads',
      direction: 'outgoing',
    });
    expect(results).toHaveLength(1);
    const position = results[0].position;
    expect(position.recordType).toBe('Hot Leads');
    expect(positionRecordId(position)).toBe('entry-1');
    await expect(adapter.getFieldValue({ position, fieldId: 'Stage' })).resolves.toBe('New');
  });

  it('the streaming and eager meta reads agree', async () => {
    const adapter = makeRootReadAdapter('team-root-agree');
    // A per-list root collection streams (the record-owned Note/Task roots now
    // throw); the eager and streaming meta hops must yield the same entries.
    const eager = await adapter.getRelated({
      position: attioMeta,
      fieldId: 'Hot Leads',
      direction: 'outgoing',
    });
    const streamed: string[] = [];
    for await (const r of adapter.iterateRelated({
      position: attioMeta,
      fieldId: 'Hot Leads',
      direction: 'outgoing',
    })) {
      streamed.push(positionRecordId(r.position) ?? '');
    }
    expect(streamed).toEqual(eager.map((r) => positionRecordId(r.position) ?? ''));
    expect(eager.length).toBeGreaterThan(0);
  });

  it('iterateRelatedPage pages a root collection with Attio\'s offset as the cursor', async () => {
    const adapter = makeRootReadAdapter('team-root-paged');
    const PAGE = 500;
    const TOTAL = PAGE + 3;
    const offsets: number[] = [];
    const inner = (adapter as unknown as { getApiClient: () => Promise<Record<string, unknown>> }).getApiClient;
    (adapter as unknown as { getApiClient: () => Promise<Record<string, unknown>> }).getApiClient = async () => ({
      ...(await inner()),
      queryRecordsPage: async ({ offset, limit }: { objectId: string; limit: number; offset: number }) => {
        offsets.push(offset);
        return Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, i) => ({
          id: { record_id: `rec-${offset + i}` },
          values: {},
        }));
      },
    });
    const input = { position: attioMeta, fieldId: 'Companies', direction: 'outgoing' as const };

    const first = await adapter.iterateRelatedPage(input);
    expect(first.items).toHaveLength(PAGE);
    expect(first.nextCursor).toBe(PAGE);
    const second = await adapter.iterateRelatedPage(input, first.nextCursor);
    expect(second.items.map((r) => positionRecordId(r.position))).toEqual(['rec-500', 'rec-501', 'rec-502']);
    expect(second.nextCursor).toBeUndefined();
    expect(offsets).toEqual([0, PAGE]);

    // The stream is the same pages walked to the end.
    const streamed: string[] = [];
    for await (const r of adapter.iterateRelated(input)) streamed.push(positionRecordId(r.position) ?? '');
    expect(streamed).toHaveLength(TOTAL);
    expect(streamed[TOTAL - 1]).toBe('rec-502');
  });

  it('a list-scoped collection hydrates parents lazily: iterateRelated stopped after one item fetches one parent', async () => {
    const adapter = makeRootReadAdapter('team-root-lazy');
    const fetched: string[] = [];
    const inner = (adapter as unknown as { getApiClient: () => Promise<Record<string, unknown>> }).getApiClient;
    (adapter as unknown as { getApiClient: () => Promise<Record<string, unknown>> }).getApiClient = async () => ({
      ...(await inner()),
      queryListEntriesPage: async ({ offset }: { listId: string; limit: number; offset: number }) =>
        offset > 0
          ? []
          : Array.from({ length: 5 }, (_, i) => ({
              entryId: `entry-${i}`,
              parentRecordId: `rec-${i}`,
              parentObjectId: 'companies',
              entryValues: {},
              createdAt: '2026-07-03T00:00:00Z',
            })),
      getRecord: async ({ recordId }: { objectId: string; recordId: string }) => {
        fetched.push(recordId);
        return { id: { record_id: recordId }, values: {} };
      },
    });
    const input = {
      position: attioMeta,
      fieldId: 'Companies',
      direction: 'outgoing' as const,
      nativeFilter: { kind: 'list', listId: 'hot-uuid' },
    };

    for await (const r of adapter.iterateRelated(input)) {
      expect(positionRecordId(r.position)).toBe('rec-0');
      break;
    }
    expect(fetched).toEqual(['rec-0']);

    // The paged contract hands back a whole page, so it hydrates all of it.
    fetched.length = 0;
    const page = await adapter.iterateRelatedPage(input);
    expect(page.items).toHaveLength(5);
    expect(fetched).toHaveLength(5);
  });

  it('iterateRelatedPage refuses a cursor it did not mint', async () => {
    const adapter = makeRootReadAdapter('team-root-badcursor');
    await expect(
      adapter.iterateRelatedPage(
        { position: attioMeta, fieldId: 'Hot Leads', direction: 'outgoing' },
        'not-an-offset',
      ),
    ).rejects.toThrow(/unrecognised page cursor/);
  });

  it('a READ over the parent-only Comment / File / List Entry types fails loudly at the root', async () => {
    const adapter = makeRootReadAdapter('team-root-writeonly');
    await expect(
      adapter.getRelated({ position: attioMeta, fieldId: 'Comment', direction: 'outgoing' }),
    ).rejects.toThrow(/cannot list comments from the root/);
    await expect(
      adapter.getRelated({ position: attioMeta, fieldId: 'File', direction: 'outgoing' }),
    ).rejects.toThrow(/cannot list files from the root/);
    await expect(
      adapter.getRelated({ position: attioMeta, fieldId: 'List Entry', direction: 'outgoing' }),
    ).rejects.toThrow(/generic list entries/);
  });
});

describe('AttioAdapter record-reference traversal (record → record)', () => {
  const person = makeStablePosition({
    adapterType: 'attio',
    recordType: 'People',
    recordId: 'person-1',
    data: {
      name: [{ value: 'Ada' }],
      parent_object: [{ target_object: 'companies', target_record_id: 'rec-9' }],
    },
  });

  it('names the edge by the attribute title, not Attio\'s api slug', async () => {
    const adapter = makeRootReadAdapter('team-recref-name');
    const people = await adapter.describe('People');
    const ref = people!.references.find((r) => r.fieldId === 'parent_object');
    // The slug stays the stable IDENTITY (fieldId / backingFields), but the
    // NAME an author types is the attribute's own title.
    expect(ref!.name).toBe('Company');
    expect(ref!.backingFields).toContain('parent_object');
  });

  it('follows the reference value to the target record, typed by the target object', async () => {
    const adapter = makeRootReadAdapter('team-recref-hit');
    const results = await adapter.getRelated({
      position: person,
      fieldId: 'Company',
      direction: 'outgoing',
    });
    expect(results).toHaveLength(1);
    expect(results[0].position.recordType).toBe('Companies');
    expect(positionRecordId(results[0].position)).toBe('rec-9');
    await expect(
      adapter.getFieldValue({ position: results[0].position, fieldId: 'Name' }),
    ).resolves.toBe('Acme');
  });

  it('an empty reference value is an empty traversal', async () => {
    const adapter = makeRootReadAdapter('team-recref-empty');
    const empty = makeStablePosition({
      adapterType: 'attio',
      recordType: 'People',
      recordId: 'person-2',
      data: { name: [{ value: 'Bo' }], parent_object: [] },
    });
    await expect(
      adapter.getRelated({ position: empty, fieldId: 'Company', direction: 'outgoing' }),
    ).resolves.toEqual([]);
  });

  it('an unpublished edge still drifts loudly instead of resolving', async () => {
    const adapter = makeRootReadAdapter('team-recref-miss');
    await expect(
      adapter.getRelated({ position: person, fieldId: 'Bogus Edge', direction: 'outgoing' }),
    ).rejects.toThrow(/not a known edge/);
  });
});

// ---------------------------------------------------------------------------
// Record-scoped attachable reads — the reads behind the published
// `record-[:Notes|Tasks|Comments]->` and `record-[:files]->` edges
// (d255f1016's loose end: these were published readable and THREW). Each is
// a real API scope per the OpenAPI spec: notes filter by parent_object +
// parent_record_id, tasks by linked_object + linked_record_id, comments ride
// GET /v2/threads (record- or entry-scoped; comments come inline on the
// thread), files ride GET /v2/files (object + record_id REQUIRED).
// ---------------------------------------------------------------------------

describe('AttioAdapter record-scoped attachable reads', () => {
  const company = makeStablePosition({
    adapterType: 'attio',
    recordType: 'Companies',
    recordId: 'rec-1',
    data: { name: [{ value: 'Acme' }] },
  });

  it('record-[:Notes]-> reads ONLY this record’s notes (the parent filters are sent)', async () => {
    const adapter = makeRootReadAdapter('team-rec-notes');
    const results = await adapter.getRelated({
      position: company,
      fieldId: 'Notes',
      direction: 'outgoing',
    });
    expect(results.map((r) => positionRecordId(r.position))).toEqual(['note-1']);
    expect(results[0].position.recordType).toBe('Note');
    await expect(
      adapter.getFieldValue({ position: results[0].position, fieldId: 'Title' }),
    ).resolves.toBe('First note');
  });

  it('record-[:Tasks]-> reads ONLY this record’s tasks (the linked filters are sent)', async () => {
    const adapter = makeRootReadAdapter('team-rec-tasks');
    const results = await adapter.getRelated({
      position: company,
      fieldId: 'Tasks',
      direction: 'outgoing',
    });
    expect(results.map((r) => positionRecordId(r.position))).toEqual(['task-1']);
    expect(results[0].position.recordType).toBe('Task');
    await expect(
      adapter.getFieldValue({ position: results[0].position, fieldId: 'Content' }),
    ).resolves.toBe('call Acme');
  });

  it('record-[:Comments]-> flattens the record’s threads and resolves the author to an email', async () => {
    const adapter = makeRootReadAdapter('team-rec-comments');
    const results = await adapter.getRelated({
      position: company,
      fieldId: 'Comments',
      direction: 'outgoing',
    });
    expect(results.map((r) => positionRecordId(r.position))).toEqual(['comment-1']);
    const position = results[0].position;
    expect(position.recordType).toBe('Comment');
    await expect(adapter.getFieldValue({ position, fieldId: 'Content' })).resolves.toBe(
      'Let’s close this',
    );
    await expect(adapter.getFieldValue({ position, fieldId: 'Author (email)' })).resolves.toBe(
      'ada@example.com',
    );
    await expect(adapter.getFieldValue({ position, fieldId: 'Thread ID' })).resolves.toBe(
      'thread-1',
    );
  });

  it('a list entry’s Comments edge scopes by the ENTRY (threads?entry_id&list)', async () => {
    const adapter = makeRootReadAdapter('team-entry-comments');
    const entry = makeStablePosition({
      adapterType: 'attio',
      recordType: 'List Entry',
      recordId: 'entry-1',
      data: {
        parent_record_id: 'rec-1',
        parent_object: 'companies',
        list_id: 'hot-uuid',
      },
    });
    const results = await adapter.getRelated({
      position: entry,
      fieldId: 'Comments',
      direction: 'outgoing',
    });
    expect(results.map((r) => positionRecordId(r.position))).toEqual(['comment-2']);
    // A non-member author (api-token) reads as a null email, never an error.
    await expect(
      adapter.getFieldValue({ position: results[0].position, fieldId: 'Author (email)' }),
    ).resolves.toBeNull();
  });

  it('a list entry’s Notes edge reads its PARENT record’s notes', async () => {
    const adapter = makeRootReadAdapter('team-entry-notes');
    const entry = makeStablePosition({
      adapterType: 'attio',
      recordType: 'List Entry',
      recordId: 'entry-1',
      data: {
        parent_record_id: 'rec-1',
        parent_object: 'companies',
        list_id: 'hot-uuid',
      },
    });
    const results = await adapter.getRelated({
      position: entry,
      fieldId: 'Notes',
      direction: 'outgoing',
    });
    expect(results.map((r) => positionRecordId(r.position))).toEqual(['note-1']);
  });

  it('record-[:files]-> unions attribute-envelope files with GET /v2/files, deduped', async () => {
    const adapter = makeRootReadAdapter('team-rec-files');
    const withEnvelopeFile = makeStablePosition({
      adapterType: 'attio',
      recordType: 'Companies',
      recordId: 'rec-1',
      data: {
        pitch_deck: [
          {
            file_id: 'file-attr-1',
            file_url: 'https://cdn/f1',
            name: 'pitch.pdf',
            content_type: 'application/pdf',
          },
        ],
      },
    });
    const results = await adapter.getRelated({
      position: withEnvelopeFile,
      fieldId: 'Files',
      direction: 'outgoing',
    });
    const names = await Promise.all(
      results.map((r) => adapter.getFieldValue({ position: r.position, fieldId: 'Name' })),
    );
    expect(names.sort()).toEqual(['attached.pdf', 'pitch.pdf']);
  });
});

// ---------------------------------------------------------------------------
// Event-hop positions carry NATURAL recordTypes — the internal sentinel
// spelling (`attio:note` …) drifts at resolveFieldId, whose maps are keyed by
// displayName. The regression this pins: a movement that hops
// `event-[:Note]->` must be able to READ the fields of what it lands on.
// ---------------------------------------------------------------------------

describe('AttioAdapter event hops mint natural recordTypes', () => {
  const eventPosition = (id: Record<string, string>): SourcePosition =>
    makeUnstablePosition({
      adapterType: 'attio',
      recordType: ATTIO_WEBHOOK_EVENT_TYPE_ID,
      data: { event_type: 'x', id },
    });

  function makeEventHopAdapter(teamId: string): AttioAdapter {
    const adapter = makeRootReadAdapter(teamId);
    // Extend the root-read fake client with the single-entity GETs the event
    // hops fetch through.
    const withClient = adapter as unknown as {
      getApiClient: () => Promise<Record<string, unknown>>;
    };
    const clientPromise = withClient.getApiClient();
    withClient.getApiClient = async () => {
      const client = await clientPromise;
      return {
        ...client,
        getTask: async () => ({
          id: { workspace_id: 't', task_id: 'task-1' },
          content_plaintext: 'call Acme',
          deadline_at: null,
          is_completed: false,
          completed_at: null,
          created_at: '2026-07-02T00:00:00Z',
        }),
        getNote: async () => ({
          id: { workspace_id: 't', note_id: 'note-1' },
          title: 'First note',
          content_plaintext: 'hello',
          parent_object: 'companies',
          parent_record_id: 'rec-1',
          created_at: '2026-07-01T00:00:00Z',
        }),
        getComment: async () => ({
          id: { workspace_id: 't', comment_id: 'comment-1' },
          thread_id: 'thread-1',
          content_plaintext: 'Let’s close this',
          resolved_at: null,
          created_at: '2026-07-04T00:00:00Z',
          author: { type: 'workspace-member', id: 'member-1' },
        }),
        getListEntry: async () => ({
          id: { workspace_id: 't', list_id: 'hot-uuid', entry_id: 'entry-1' },
          entry_values: { stage: [{ status: { title: 'New' } }] },
          values: { stage: [{ status: { title: 'New' } }] },
          parent_record_id: 'rec-1',
          parent_object: 'companies',
          created_at: '2026-07-03T00:00:00Z',
        }),
      };
    };
    return adapter;
  }

  it('event-[:Task]-> lands on `Task` and its fields read', async () => {
    const adapter = makeEventHopAdapter('team-hop-task');
    const results = await adapter.getRelated({
      position: eventPosition({ workspace_id: 't', task_id: 'task-1' }),
      fieldId: 'Task',
      direction: 'outgoing',
    });
    expect(results).toHaveLength(1);
    expect(results[0].position.recordType).toBe('Task');
    await expect(
      adapter.getFieldValue({ position: results[0].position, fieldId: 'Content' }),
    ).resolves.toBe('call Acme');
  });

  it('event-[:Note]-> lands on `Note` and its fields read', async () => {
    const adapter = makeEventHopAdapter('team-hop-note');
    const results = await adapter.getRelated({
      position: eventPosition({ workspace_id: 't', note_id: 'note-1' }),
      fieldId: 'Note',
      direction: 'outgoing',
    });
    expect(results[0].position.recordType).toBe('Note');
    await expect(
      adapter.getFieldValue({ position: results[0].position, fieldId: 'Title' }),
    ).resolves.toBe('First note');
  });

  it('event-[:Comment]-> lands on `Comment` with the author resolved to an email', async () => {
    const adapter = makeEventHopAdapter('team-hop-comment');
    const results = await adapter.getRelated({
      position: eventPosition({ workspace_id: 't', comment_id: 'comment-1' }),
      fieldId: 'Comment',
      direction: 'outgoing',
    });
    expect(results[0].position.recordType).toBe('Comment');
    await expect(
      adapter.getFieldValue({ position: results[0].position, fieldId: 'Author (email)' }),
    ).resolves.toBe('ada@example.com');
  });

  it('event-[:List]-> lands on `List`', async () => {
    const adapter = makeEventHopAdapter('team-hop-list');
    const results = await adapter.getRelated({
      position: eventPosition({ workspace_id: 't', list_id: 'hot-uuid' }),
      fieldId: 'List',
      direction: 'outgoing',
    });
    expect(results[0].position.recordType).toBe('List');
    await expect(
      adapter.getFieldValue({ position: results[0].position, fieldId: 'Name' }),
    ).resolves.toBe('Hot Leads');
  });

  it('event-[:<list>]-> lands on the PER-LIST type (not generic `List Entry`), so its Comments edge works', async () => {
    const adapter = makeEventHopAdapter('team-hop-entry');
    const results = await adapter.getRelated({
      position: eventPosition({ workspace_id: 't', list_id: 'hot-uuid', entry_id: 'entry-1' }),
      // Option 3: the entry hop is per-list, symmetric with the record hop.
      // `Hot Leads` is list `hot-uuid`'s display name.
      fieldId: 'Hot Leads',
      direction: 'outgoing',
    });
    expect(results[0].position.recordType).toBe('Hot Leads');
    // The entry-scoped Comments read works straight off the hopped-to entry.
    const comments = await adapter.getRelated({
      position: results[0].position,
      fieldId: 'Comments',
      direction: 'outgoing',
    });
    expect(comments.map((r) => positionRecordId(r.position))).toEqual(['comment-2']);
  });

  it('event-[:<list>]-> reaches the parent record via the per-list type\'s single object edge', async () => {
    const adapter = makeEventHopAdapter('team-hop-entry-parent');
    const [entry] = await adapter.getRelated({
      position: eventPosition({ workspace_id: 't', list_id: 'hot-uuid', entry_id: 'entry-1' }),
      fieldId: 'Hot Leads',
      direction: 'outgoing',
    });
    // Hot Leads is a companies list, so its entry's one parent is Companies —
    // and the entry carries parent_object: 'companies', parent_record_id: 'rec-1'.
    const parent = await adapter.getRelated({
      position: entry.position,
      fieldId: 'Companies',
      direction: 'outgoing',
    });
    expect(parent[0].position.recordType).toBe('Companies');
    expect(positionRecordId(parent[0].position)).toBe('rec-1');
  });

  it('event-[:<list>]-> yields [] when the event is for a DIFFERENT list', async () => {
    const adapter = makeEventHopAdapter('team-hop-entry-mismatch');
    const results = await adapter.getRelated({
      // The event is for a list id that isn't `hot-uuid`.
      position: eventPosition({ workspace_id: 't', list_id: 'some-other-list', entry_id: 'entry-1' }),
      fieldId: 'Hot Leads',
      direction: 'outgoing',
    });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `Lists` is ONE polymorphic edge with a member per joinable list, and
// narrowing it reaches the SAME node the named per-list edge reaches.
//
// Asserted because both halves fail SILENTLY: a member minted under the wrong
// `recordType` is simply never matched (`membersOf` gates on it), and narrowing
// then no-ops rather than erroring.
//
// ---------------------------------------------------------------------------

describe('AttioAdapter `Lists` narrowing', () => {
  const companies = {
    adapterType: 'attio',
    recordType: 'Companies',
    identity: { kind: 'unstable' as const, data: undefined },
  };

  it('offers a member per joinable list, addressed by the EDGE name', async () => {
    const adapter = makeRootReadAdapter('team-lists-members');
    const hop = await adapter.edgesFrom(companies);

    const members = Object.entries(hop!.targetPositions ?? {}).filter(
      ([, p]) => p.recordType === ATTIO_LISTS_EDGE,
    );
    expect(members.map(([, p]) => (p.identity.data as { Name: string }).Name)).toEqual([
      'Hot Leads',
    ]);
    // Keyed by list id, NOT by a reference fieldId — that difference is what
    // makes it a member rather than the edge's own address.
    expect(members.map(([key]) => key)).toEqual(['list:hot-uuid']);
    expect(hop!.descriptor.references.map((r) => r.fieldId)).not.toContain('list:hot-uuid');
  });

  it('the per-list NAMED edge is writable — a record supplies the parent link', async () => {
    const adapter = makeRootReadAdapter('team-lists-writable');
    const hop = await adapter.edgesFrom(companies);
    const named = hop!.descriptor.references.find((r) => r.fieldId === 'Hot Leads');
    expect(named?.writable).toBe(true);
  });

  it('standing on a narrowed member lands on the concrete list, as naming it does', async () => {
    const adapter = makeRootReadAdapter('team-lists-narrowed');
    const hop = await adapter.edgesFrom(companies);
    const member = Object.values(hop!.targetPositions ?? {}).find(
      (p) => p.recordType === ATTIO_LISTS_EDGE,
    );

    const narrowed = await adapter.edgesFrom(member!);
    const named = await adapter.edgesFrom({
      adapterType: 'attio',
      recordType: 'Hot Leads',
      identity: { kind: 'unstable' as const, data: undefined },
    });

    expect(narrowed!.descriptor.displayName).toBe('Hot Leads');
    // One relationship, two spellings — never two different claims.
    expect(narrowed!.descriptor).toEqual(named!.descriptor);
  });
});
