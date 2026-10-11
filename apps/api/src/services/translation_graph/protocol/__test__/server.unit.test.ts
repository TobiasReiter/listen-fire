// The generic protocol server fronts an in-process adapter. The wire carries the
// adapter's INTERNAL ids (the remote shim resolved the program's natural names
// before sending); the in-process adapter takes NATURAL names. These cases pin
// the server turning one into the other, for an adapter whose ids and names
// differ — the shape every identity-named test fake hides.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Adapter } from '../../adapter';
import { META_RECORD_TYPE, makeUnstablePosition } from '../../types';
import type { SchemaTypeDescriptor } from '../../types';
import { createAdapterProtocolHandler } from '../server';
import { PROTOCOL_VERSION } from '../schema';

const COMPANY: SchemaTypeDescriptor = {
  typeId: 'crm:company',
  displayName: 'Company',
  fields: [
    { fieldId: 'name_attr', displayName: 'Name', kind: 'string', writable: true, required: true },
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

/** An adapter that records the input each call receives. */
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
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue(input) {
      received.getFieldValue = input;
      return null;
    },
    async getRelated(input) {
      received.getRelated = input;
      return [];
    },
    async createRecord(input) {
      received.createRecord = input;
      return { adapterType: 'crm', externalId: 'c-1', recordType: 'Company', data: {} };
    },
    async updateRecord() {
      return { notFound: true };
    },
    async deleteRecord() {
      return {};
    },
  };
}

describe('protocol server: wire ids reach the in-process adapter as natural names', () => {
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

  async function rpc(method: string, params: unknown): Promise<{ ok: boolean }> {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, method, cacheScopeId: 's', params }),
    });
    return (await res.json()) as { ok: boolean };
  }

  const company = makeUnstablePosition({ adapterType: 'crm', recordType: 'Company', data: {} });

  it('an edge read id becomes the edge name', async () => {
    expect(
      await rpc('getRelated', { position: company, fieldId: 'people_ref', direction: 'outgoing' }),
    ).toMatchObject({ ok: true });
    expect(received.getRelated).toMatchObject({ fieldId: 'People' });
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
        mutationContext: {},
        parentLinks: [{ recordType: 'crm:person', externalId: 'p-1', edgeName: 'People' }],
      }),
    ).toMatchObject({ ok: true });
    expect(received.createRecord).toMatchObject({
      recordType: 'Company',
      fields: { Name: 'Acme' },
      evidence: { Name: { quote: 'Acme' } },
      parentLinks: [{ recordType: 'Person', externalId: 'p-1', edgeName: 'People' }],
    });
  });

  it('an id the adapter does not publish passes through for the adapter to judge', async () => {
    await rpc('getRelated', { position: company, fieldId: 'no_such_ref', direction: 'outgoing' });
    expect(received.getRelated).toMatchObject({ fieldId: 'no_such_ref' });
  });
});
