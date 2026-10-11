// Manual adapter — the unified on-demand trigger. Covers the actor-only run
// AND the folded-in web surface: schema introspection, field reads (text +
// `content` alias), reference traversal (files + #resources), actor parsing,
// and owner-side byte resolution. Manual is now the closest twin of the email
// adapter — a stateless inbound source whose invocation OPTIONALLY carries text
// + uploaded files, fanning out one TEXT resource for the text and one FILE
// resource per file.

import { Readable } from 'node:stream';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { TriggerEvent } from '../../../triggers/types';

import { RESOURCES_REFERENCE_FIELD_ID } from '../../../adapter';
import { makeUnstablePosition, positionData } from '../../../types';

// `types.ts` (imported transitively by the adapter) loads the output_v3
// zod-schema chain, which pulls in the prisma/openai/logger graph that crashes
// at module load in jest without a test DB. Stub it at the leaf — the adapter
// consumes these schemas only at type level. Mirrors the google-sheets /
// airtable adapter tests.
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

// No document row records any of these files: only the team's key prefix
// makes one the team's.
jest.mock('../../../../../lib/kysely', () => {
  const query = { select: () => query, where: () => query, executeTakeFirst: async () => undefined };
  return { getKnowledgeQb: () => ({ selectFrom: () => query }) };
});

// Mock document storage so `resolveFileRef` can be exercised without S3.
const getFileNodeStream = jest.fn();
jest.mock('../../../../../adapters/registry', () => ({
  services: {
    document: {
      get getFileNodeStream() {
        return getFileNodeStream;
      },
      // The store's own reading of its keys (bucket `docs`).
      keyOf: (objectUri: string) =>
        objectUri.startsWith('s3://docs/')
          ? jest.requireActual('../../../../../adapters/document/interface').storeKey(objectUri.slice('s3://docs/'.length))
          : undefined,
    },
  },
}));

import {
  ManualAdapter,
  MANUAL_ADAPTER_TYPE,
  MANUAL_INVOCATION_TYPE_ID,
  MANUAL_INVOCATION_DISPLAY_NAME,
  MANUAL_FILE_TYPE_ID,
  MANUAL_FILE_DISPLAY_NAME,
  MANUAL_FILES_FIELD,
  type ManualInvocationPayload,
} from '../index';

const TEAM_ID = 'team-1' as TeamId;

// Positions carry the NATURAL type name (the displayName the read wrapper
// stamps) — the adapter resolves it to its internal id on each method's first
// line. The natural names are TitleCase (`Invocation` / `File`); the internal
// typeIds (`invocation` / `file`) live only in the adapter's private cache.
const INVOCATION_TYPE = MANUAL_INVOCATION_DISPLAY_NAME;
const FILE_TYPE = MANUAL_FILE_DISPLAY_NAME;

function invocationPosition(payload: Partial<ManualInvocationPayload>) {
  return makeUnstablePosition({
    adapterType: MANUAL_ADAPTER_TYPE,
    recordType: INVOCATION_TYPE,
    data: payload,
  });
}

const SAMPLE: ManualInvocationPayload = {
  firedAt: '2026-06-23T00:00:00.000Z',
  actorEmail: 'Ada@Example.com',
  actorName: 'Ada',
  text: 'Please look at this deck.',
  submissionId: 'inv-1',
  files: [
    {
      objectUri: 's3://docs/deck.pdf',
      filename: 'deck.pdf',
      contentType: 'application/pdf',
      size: 1234,
    },
  ],
};

beforeEach(() => {
  getFileNodeStream.mockReset();
});

describe('ManualAdapter schema', () => {
  it('lists the invocation + file entry points (source-only)', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const entries = await adapter.listEntryPoints();
    // The invocation is an EVENT edge (`fires`) — nothing enumerates Run-now
    // presses; a file is reached only via the invocation's `files` edge.
    expect(entries).toEqual([
      { typeId: MANUAL_INVOCATION_TYPE_ID, displayName: MANUAL_INVOCATION_DISPLAY_NAME, writable: false, readable: false, fires: true },
      { typeId: MANUAL_FILE_TYPE_ID, displayName: MANUAL_FILE_DISPLAY_NAME, writable: false, readable: false },
    ]);
  });

  it('describes the invocation with actor + text fields and a files reference (no input-side #resources)', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const desc = await adapter.describe(MANUAL_INVOCATION_TYPE_ID);
    expect(desc?.fields.map((f) => f.fieldId)).toEqual(
      expect.arrayContaining(['firedAt', 'actorEmail', 'text', 'content']),
    );
    const refIds = desc?.references.map((r) => r.fieldId);
    expect(refIds).toContain(MANUAL_FILES_FIELD);
    // `_resources` is extracted-node provenance now, never an input bundle —
    // the input position exposes content explicitly (the `text` field + the
    // `files` edge), not via a `_resources` reference.
    expect(refIds).not.toContain(RESOURCES_REFERENCE_FIELD_ID);
  });

  it('describes the file type with a File-typed `data` field', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const desc = await adapter.describe(MANUAL_FILE_TYPE_ID);
    const dataField = desc?.fields.find((f) => f.fieldId === 'data');
    expect(dataField?.kind).toBe('file');
  });

  it('returns null for an unknown type', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    expect(await adapter.describe('manual:nope')).toBeNull();
  });
});

describe('ManualAdapter.getFieldValue', () => {
  it('reads scalar fields and the `content` alias off an invocation', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const position = invocationPosition(SAMPLE);
    expect(await adapter.getFieldValue({ position, fieldId: 'Text' })).toBe(
      'Please look at this deck.',
    );
    expect(await adapter.getFieldValue({ position, fieldId: 'Content' })).toBe(
      'Please look at this deck.',
    );
    expect(await adapter.getFieldValue({ position, fieldId: 'Run by (email)' })).toBe(
      'Ada@Example.com',
    );
    expect(await adapter.getFieldValue({ position, fieldId: 'Fired at' })).toBe(
      '2026-06-23T00:00:00.000Z',
    );
  });

  it('reads the `name` alias off a file position', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const filePos = makeUnstablePosition({
      adapterType: MANUAL_ADAPTER_TYPE,
      recordType: FILE_TYPE,
      data: SAMPLE.files![0],
    });
    expect(await adapter.getFieldValue({ position: filePos, fieldId: 'Name' })).toBe('deck.pdf');
    expect(await adapter.getFieldValue({ position: filePos, fieldId: 'Content Type' })).toBe(
      'application/pdf',
    );
  });

  it('yields a working FileRef off the `File` field (lossless replacement for input-side #resources)', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const filePos = makeUnstablePosition({
      adapterType: MANUAL_ADAPTER_TYPE,
      recordType: FILE_TYPE,
      data: SAMPLE.files![0],
    });
    // `go-[:files]->.`File`` evaluates this — the file bytes that fed an
    // extraction now reach it explicitly (the `_resources` bundle used to be
    // the only path). The FileRef is a descriptor: its owner and its handle.
    const file = await adapter.getFieldValue({ position: filePos, fieldId: 'File' });
    expect(file).toMatchObject({
      __brand: 'FileRef',
      name: 'deck.pdf',
      contentType: 'application/pdf',
      source: { adapterType: MANUAL_ADAPTER_TYPE, handle: 's3://docs/deck.pdf' },
    });
  });

  it('throws for a position from another adapter', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const foreign = makeUnstablePosition({
      adapterType: 'email',
      recordType: INVOCATION_TYPE,
      data: {},
    });
    await expect(adapter.getFieldValue({ position: foreign, fieldId: 'Text' })).rejects.toThrow();
  });
});

describe('ManualAdapter.getRelated', () => {
  it('fans out one file position per uploaded file', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const related = await adapter.getRelated({
      position: invocationPosition(SAMPLE),
      fieldId: 'Files',
      direction: 'outgoing',
    });
    expect(related).toHaveLength(1);
    expect(related[0].position.recordType).toBe(MANUAL_FILE_DISPLAY_NAME);
  });

  it('no longer resolves a `_resources` hop off an input position (drifts — it is extracted-node-only now)', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    // The reference is gone from `describe`, so a `_resources` hop off an
    // INPUT position no longer resolves. Input content is read explicitly
    // (the `Text` field + the `files` edge, both asserted above); `_resources`
    // is reachable only off an extracted node (`extractedNode-[:_resources]->`).
    await expect(
      adapter.getRelated({
        position: invocationPosition(SAMPLE),
        fieldId: RESOURCES_REFERENCE_FIELD_ID,
        direction: 'outgoing',
      }),
    ).rejects.toThrow();
  });

  it('returns nothing for an incoming traversal', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const related = await adapter.getRelated({
      position: invocationPosition(SAMPLE),
      fieldId: 'Files',
      direction: 'incoming',
    });
    expect(related).toEqual([]);
  });
});

describe('ManualAdapter actor parsing', () => {
  function event(payload: Partial<ManualInvocationPayload>): TriggerEvent {
    return {
      pipelineInputId: 'trigger:t-1',
      adapterType: MANUAL_ADAPTER_TYPE,
      triggerType: 'webhook',
      payload,
    };
  }

  it('parses the actor email as a single originator candidate (normalised)', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const candidates = await adapter.getActorCandidates({ event: event(SAMPLE) });
    expect(candidates).toEqual([
      {
        identity: {
          identifier: 'ada@example.com',
          scheme: 'email',
          adapterType: MANUAL_ADAPTER_TYPE,
          email: 'ada@example.com',
        },
        source: 'originator',
      },
    ]);
  });

  it('extractActor surfaces the actor identity', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const actor = await adapter.extractActor({ event: event(SAMPLE) });
    expect(actor).toEqual({
      identifier: 'ada@example.com',
      scheme: 'email',
      adapterType: MANUAL_ADAPTER_TYPE,
      email: 'ada@example.com',
      name: 'Ada',
      label: 'Ada',
    });
  });

  it('yields no candidates / null actor when no actor email is present', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const e = event({ firedAt: SAMPLE.firedAt, files: [] });
    expect(await adapter.getActorCandidates({ event: e })).toEqual([]);
    expect(await adapter.extractActor({ event: e })).toBeNull();
  });
});

describe('ManualAdapter.resolveFileRef', () => {
  it("streams the file bytes back out of document storage by objectUri, under the team's own prefix", async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    const fake = Object.assign(Readable.from(Buffer.from('hello')), {
      size: 5,
      contentType: 'application/pdf',
    });
    getFileNodeStream.mockResolvedValue(fake);
    const objectUri = `s3://docs/movement-files/${TEAM_ID}/u/deck.pdf`;

    const result = await adapter.resolveFileRef({
      ref: {
        __brand: 'FileRef',
        source: { adapterType: MANUAL_ADAPTER_TYPE, handle: objectUri },
      },
    });
    expect(getFileNodeStream).toHaveBeenCalledWith({ objectUri });
    expect(result.contentType).toBe('application/pdf');
    expect(result.size).toBe(5);
  });

  it.each([
    ["another team's prefix", 's3://docs/movement-files/another-team/u/secret.pdf'],
    ['a dot segment out of the prefix', `s3://docs/movement-files/${TEAM_ID}/../another-team/u/secret.pdf`],
    ['another bucket', `s3://elsewhere/movement-files/${TEAM_ID}/u/secret.pdf`],
  ])("refuses, by name, a handle naming %s, and reads nothing", async (_what, handle) => {
    getFileNodeStream.mockClear();
    const adapter = new ManualAdapter(TEAM_ID);
    await expect(
      adapter.resolveFileRef({ ref: { __brand: 'FileRef', source: { adapterType: MANUAL_ADAPTER_TYPE, handle } } }),
    ).rejects.toMatchObject({ code: 'FILE_OUTSIDE_TEAM', owner: 'document' });
    expect(getFileNodeStream).not.toHaveBeenCalled();
  });

  it('throws when the FileRef has no source handle', async () => {
    const adapter = new ManualAdapter(TEAM_ID);
    await expect(
      adapter.resolveFileRef({ ref: { __brand: 'FileRef' } }),
    ).rejects.toThrow(/no source handle/);
  });
});
