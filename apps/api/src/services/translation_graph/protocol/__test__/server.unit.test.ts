// The generic protocol server fronts an in-process adapter. The wire carries the
// adapter's INTERNAL ids both ways (the remote shim resolves the program's
// natural names before sending, and renames ids in a reply itself); the
// in-process adapter takes and returns NATURAL names. These cases pin the
// server translating in both directions, for an adapter whose ids and names
// differ — the shape every identity-named test fake hides.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Adapter } from '../../adapter';
import { createRemoteAdapter, fetchRemoteManifest } from '../../adapters/remote';
import type { RemoteAdapterConfig } from '../../adapters/remote';
import { META_RECORD_TYPE, makeUnstablePosition } from '../../types';
import type { SchemaTypeDescriptor } from '../../types';
import { createAdapterProtocolHandler } from '../server';
import { PROTOCOL_VERSION } from '../schema';

const COMPANY: SchemaTypeDescriptor = {
  typeId: 'crm:company',
  displayName: 'Company',
  fields: [
    { fieldId: 'name_attr', displayName: 'Name', kind: 'string', writable: true, required: true },
    // A collision real systems allow (Attio custom attributes): one field's
    // display name is another field's id.
    { fieldId: 'notes', displayName: 'Notes', kind: 'string', writable: true, required: false },
    { fieldId: 'summary', displayName: 'notes', kind: 'string', writable: true, required: false },
  ],
  references: [
    {
      fieldId: 'people_ref',
      targetTypeId: 'crm:person',
      cardinality: 'many',
      direction: 'outgoing',
      name: 'People',
    },
  ],
};

const MUTATION_CONTEXT = { source: {}, occurredAt: '2026-10-11T00:00:00.000Z' };

/** An adapter that records the input each call receives, and answers entity
 *  resolution in its own (natural) field names. */
function recordingAdapter(received: Record<string, unknown>): Adapter {
  return {
    adapterType: 'crm',
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    }),
    async listEntryPoints() {
      return [
        { typeId: 'crm:company', displayName: 'Company', writable: true, readable: true },
        { typeId: 'crm:person', displayName: 'Person', writable: true, readable: true },
      ];
    },
    async describe(typeId: string) {
      return typeId === COMPANY.typeId ? COMPANY : null;
    },
    async resolveEntity(input) {
      received.resolveEntity = input;
      return {
        candidates: [
          {
            adapterType: 'crm',
            externalId: 'c-9',
            recordType: 'Company',
            data: { Name: 'Acme', Notes: 'from notes', notes: 'from summary' },
          },
        ],
      };
    },
    async getFieldValue(input) {
      received.getFieldValue = input;
      return null;
    },
    async getRelated(input) {
      received.getRelated = input;
      return [];
    },
    async *iterateRelated(input) {
      received.iterateRelated = input;
    },
    async createRecord(input) {
      received.createRecord = input;
      return { adapterType: 'crm', externalId: 'c-1', recordType: 'Company', data: {} };
    },
    async updateRecord(input) {
      received.updateRecord = input;
      return { notFound: true };
    },
    async deleteRecord(input) {
      received.deleteRecord = input;
      return {};
    },
    async invokeFieldFunction(input) {
      received.invokeFieldFunction = input;
      return null;
    },
    async translateFilter(input) {
      received.translateFilter = input;
      return { native: null, residual: null };
    },
    async getDedupRules(input) {
      received.getDedupRules = input;
      return null;
    },
  };
}

describe('protocol server: ids on the wire, natural names at the in-process adapter', () => {
  const received: Record<string, unknown> = {};
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const handler = createAdapterProtocolHandler({ adapter: recordingAdapter(received) });
    server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, method, cacheScopeId: 's', params }),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  const company = makeUnstablePosition({ adapterType: 'crm', recordType: 'Company', data: {} });

  it('an edge read id becomes the edge name', async () => {
    expect(
      await rpc('getRelated', { position: company, fieldId: 'people_ref', direction: 'outgoing' }),
    ).toMatchObject({ ok: true });
    expect(received.getRelated).toMatchObject({ fieldId: 'People' });
  });

  it('a paged edge read names its edge the same way', async () => {
    expect(
      await rpc('iterateRelated', { position: company, fieldId: 'people_ref', direction: 'outgoing' }),
    ).toMatchObject({ ok: true, result: { items: [] } });
    expect(received.iterateRelated).toMatchObject({ fieldId: 'People' });
  });

  it('a meta-root hop names the collection by its type name', async () => {
    const meta = makeUnstablePosition({ adapterType: 'crm', recordType: META_RECORD_TYPE, data: {} });
    await rpc('getRelated', { position: meta, fieldId: 'crm:person', direction: 'outgoing' });
    expect(received.getRelated).toMatchObject({ fieldId: 'Person' });
  });

  it('a field id becomes the field name', async () => {
    await rpc('getFieldValue', { position: company, fieldId: 'name_attr' });
    expect(received.getFieldValue).toMatchObject({ fieldId: 'Name' });
  });

  it('a write names its type, fields, evidence and parent types naturally', async () => {
    expect(
      await rpc('createRecord', {
        recordType: 'crm:company',
        fields: { name_attr: 'Acme' },
        evidence: { name_attr: { quote: 'Acme' } },
        mutationContext: MUTATION_CONTEXT,
        parentLinks: [
          { recordType: 'crm:person', externalId: 'p-1', edgeName: 'People', data: { ts: '1' } },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(received.createRecord).toMatchObject({
      recordType: 'Company',
      fields: { Name: 'Acme' },
      evidence: { Name: { quote: 'Acme' } },
      // The parent's own payload survives the protocol schema's parse.
      parentLinks: [{ recordType: 'Person', externalId: 'p-1', edgeName: 'People', data: { ts: '1' } }],
    });
  });

  it('an update names its type and fields naturally', async () => {
    await rpc('updateRecord', {
      recordType: 'crm:company',
      externalId: 'c-1',
      fields: { notes: 'n', summary: 's' },
      mutationContext: MUTATION_CONTEXT,
    });
    expect(received.updateRecord).toMatchObject({
      recordType: 'Company',
      externalId: 'c-1',
      fields: { Notes: 'n', notes: 's' },
    });
  });

  it('a delete names its type naturally', async () => {
    await rpc('deleteRecord', {
      recordType: 'crm:company',
      externalId: 'c-1',
      mutationContext: MUTATION_CONTEXT,
    });
    expect(received.deleteRecord).toMatchObject({ recordType: 'Company', externalId: 'c-1' });
  });

  it('a field function names its type and field naturally', async () => {
    await rpc('invokeFieldFunction', {
      recordType: 'crm:company',
      fieldId: 'summary',
      functionName: 'ask',
      args: { instructions: 'x', data: [] },
    });
    expect(received.invokeFieldFunction).toMatchObject({ recordType: 'Company', fieldId: 'notes' });
  });

  it('filter translation and dedup rules name their type naturally', async () => {
    await rpc('translateFilter', { expression: null, entityType: 'crm:company' });
    expect(received.translateFilter).toMatchObject({ entityType: 'Company' });
    await rpc('getDedupRules', { typeRef: 'crm:company' });
    expect(received.getDedupRules).toMatchObject({ typeRef: 'Company' });
  });

  it('entity resolution: ids in, natural names to the adapter, ids back on the wire', async () => {
    const reply = await rpc('resolveEntity', {
      recordType: 'crm:company',
      record: { notes: 'n', summary: 's' },
      candidates: [],
      constraints: { any: [{ all: [{ field: 'summary' }] }] },
    });
    expect(received.resolveEntity).toMatchObject({
      recordType: 'Company',
      record: { Notes: 'n', notes: 's' },
      constraints: { any: [{ all: [{ field: 'notes' }] }] },
    });
    expect(reply).toMatchObject({
      ok: true,
      result: {
        candidates: [{ data: { name_attr: 'Acme', notes: 'from notes', summary: 'from summary' } }],
      },
    });
  });

  it('entity resolution through the remote shim keeps colliding names on their own fields', async () => {
    const config: RemoteAdapterConfig = {
      adapterType: 'crm',
      baseUrl,
      authStrategy: { kind: 'bearer' },
      credentialsId: 'test',
    };
    const remote = createRemoteAdapter({
      config,
      secret: 'unused',
      cacheScopeId: 'test-scope',
      manifest: await fetchRemoteManifest(config, 'unused'),
    });
    const { candidates } = await remote.resolveEntity({
      recordType: 'Company',
      record: { Notes: 'n' },
      candidates: [],
      constraints: { any: [{ all: [{ field: 'notes' }] }] },
    });
    expect(candidates[0]?.data).toEqual({ Name: 'Acme', Notes: 'from notes', notes: 'from summary' });
  });

  it('a type a write names by display name is not an id, so it passes through untranslated', async () => {
    await rpc('createRecord', {
      recordType: 'Company',
      fields: { name_attr: 'Acme' },
      mutationContext: MUTATION_CONTEXT,
    });
    expect(received.createRecord).toMatchObject({ recordType: 'Company', fields: { name_attr: 'Acme' } });
  });

  it('an id the adapter does not publish passes through for the adapter to judge', async () => {
    await rpc('getRelated', { position: company, fieldId: 'no_such_ref', direction: 'outgoing' });
    expect(received.getRelated).toMatchObject({ fieldId: 'no_such_ref' });
  });

  it('a body the method schema refuses is a non-retryable bad_request', async () => {
    expect(await rpc('getRelated', { position: company })).toMatchObject({
      ok: false,
      error: { code: 'bad_request', retryable: false },
    });
  });
});
