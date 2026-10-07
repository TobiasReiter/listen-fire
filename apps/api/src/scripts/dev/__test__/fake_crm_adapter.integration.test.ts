// No-DB round-trip proof for a user-supplied "remote" adapter (a homespun CRM).
//
// Modeled on `adapters/remote/__test__/remote-email-parity.integration.test.ts`:
// it stands up the fake CRM behind the wire protocol on an ephemeral
// `http.Server`, fetches the manifest over REAL HTTP, builds a `RemoteAdapter`
// from it, and proves the two surfaces that matter for a write target:
//   (i)  `describe('Company')` round-trips over the wire, and
//   (ii) `remote.createRecord({ recordType: 'Company', … })` mutates the fake
//        CRM's in-memory `writes` array on the other side of the socket.
//
// It touches NO Postgres — every exercised method is DB-free — but carries the
// `.integration.test.ts` suffix because that config's testMatch owns real-
// transport tests (real socket, real HTTP round-trip).

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { MutationContext } from '../../../services/translation_graph/mutation_context';
import { BASE_RUNTIME_CAPABILITIES } from '../../../services/translation_graph/adapter';
import {
  createRemoteAdapter,
  fetchRemoteManifest,
  RemoteAdapter,
} from '../../../services/translation_graph/adapters/remote';
import type { RemoteAdapterConfig } from '../../../services/translation_graph/adapters/remote';
import { makeMetaPosition, positionData } from '../../../services/translation_graph/types';
import {
  FAKE_CRM_ADAPTER_TYPE,
  FAKE_CRM_COMPANY_TYPE,
  FAKE_CRM_PAGE_SIZE,
  startFakeCrmServer,
} from '../fake_crm_adapter';
import type { FakeCrmServer } from '../fake_crm_adapter';

const SECRET = 'fake-crm-secret';

/** A minimal write-time provenance context — the shape every write carries. */
const MUTATION_CONTEXT: MutationContext = {
  source: { type: 'structured_input', adapterType: FAKE_CRM_ADAPTER_TYPE },
  occurredAt: new Date().toISOString(),
};

describe('Fake CRM RemoteAdapter round-trip (over real HTTP, no Postgres)', () => {
  let server: FakeCrmServer;
  let remote: RemoteAdapter;

  beforeAll(async () => {
    server = await startFakeCrmServer({ secret: SECRET });

    const config: RemoteAdapterConfig = {
      adapterType: FAKE_CRM_ADAPTER_TYPE,
      baseUrl: server.baseUrl,
      authStrategy: { kind: 'bearer' },
      credentialsId: 'test',
    };

    // Manifest fetch over real HTTP — proves the install-time handshake.
    const manifest = await fetchRemoteManifest(config, SECRET);
    remote = createRemoteAdapter({
      config,
      secret: SECRET,
      cacheScopeId: 'fake-crm-scope',
      manifest,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('describe(Company) round-trips over the wire with a writable Name field', async () => {
    const desc = await remote.describe(FAKE_CRM_COMPANY_TYPE);
    expect(desc).not.toBeNull();
    expect(desc?.typeId).toBe(FAKE_CRM_COMPANY_TYPE);

    const name = desc?.fields.find((f) => f.fieldId === 'Name');
    expect(name).toMatchObject({ kind: 'string', writable: true, required: true });
  });

  it('createRecord(Company) reaches the fake CRM in-memory writes over the wire', async () => {
    const result = await remote.createRecord({
      recordType: FAKE_CRM_COMPANY_TYPE,
      fields: { Name: 'Vireo Robotics' },
      mutationContext: MUTATION_CONTEXT,
    });

    expect(result.externalId).toBeTruthy();
    expect(result.adapterType).toBe(FAKE_CRM_ADAPTER_TYPE);

    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]?.fields).toMatchObject({ Name: 'Vireo Robotics' });
    expect(server.writes[0]?.externalId).toBe(result.externalId);
  });
});

// The written companies read back from the root cross the wire in the fake
// CRM's own small pages: the RemoteAdapter echoes each cursor until the last.
describe('Fake CRM pages a traversal over the wire', () => {
  let server: FakeCrmServer;
  let remote: RemoteAdapter;

  beforeAll(async () => {
    server = await startFakeCrmServer({ secret: SECRET });
    const config: RemoteAdapterConfig = {
      adapterType: FAKE_CRM_ADAPTER_TYPE,
      baseUrl: server.baseUrl,
      authStrategy: { kind: 'bearer' },
      credentialsId: 'test',
    };
    const manifest = await fetchRemoteManifest(config, SECRET);
    remote = createRemoteAdapter({ config, secret: SECRET, cacheScopeId: 'fake-crm-paging', manifest });
  });

  afterAll(async () => {
    await server.close();
  });

  it('streams every company across ceil(n / page size) pages', async () => {
    const names = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm'];
    for (const Name of names) {
      await remote.createRecord({
        recordType: FAKE_CRM_COMPANY_TYPE,
        fields: { Name },
        mutationContext: MUTATION_CONTEXT,
      });
    }
    const input = {
      position: makeMetaPosition(FAKE_CRM_ADAPTER_TYPE),
      fieldId: FAKE_CRM_COMPANY_TYPE,
      direction: 'outgoing' as const,
    };

    const first = await remote.iterateRelatedPage!(input);
    expect(first.items).toHaveLength(FAKE_CRM_PAGE_SIZE);
    expect(first.nextCursor).toBe(FAKE_CRM_PAGE_SIZE);

    const streamed: unknown[] = [];
    for await (const r of remote.iterateRelated!(input)) streamed.push(positionData(r.position));
    expect(streamed).toEqual(names.map((Name) => ({ Name })));
  });

  it('refuses a cursor it did not mint', async () => {
    await expect(
      remote.iterateRelatedPage!(
        { position: makeMetaPosition(FAKE_CRM_ADAPTER_TYPE), fieldId: FAKE_CRM_COMPANY_TYPE, direction: 'outgoing' },
        'not-an-offset',
      ),
    ).rejects.toThrow(/unrecognised page cursor/);
  });
});

// A homespun server can return a bare `[]` from `resolveEntity` (the handbook
// once told authors it "may always return []"). That must NOT crash the write
// path with "expected object, received array" — the client coerces it to the
// canonical `{ candidates: [] }`. This proves the tolerance over a REAL socket,
// not just the schema unit test.
describe('resolveEntity bare-array tolerance (over real HTTP)', () => {
  let server: http.Server;
  let remote: RemoteAdapter;

  const SECRET = 'homespun-secret';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const { method } = JSON.parse(raw || '{}') as { method: string };
        const send = (result: unknown): void => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        };
        switch (method) {
          case 'manifest':
            return send({
              protocolVersion: 2,
              adapterType: FAKE_CRM_ADAPTER_TYPE,
              supportedTriggers: [],
              runtimeCapabilities: BASE_RUNTIME_CAPABILITIES,
              methods: ['listEntryPoints', 'describe', 'resolveEntity', 'createRecord'],
            });
          case 'listEntryPoints':
            return send([
              {
                typeId: FAKE_CRM_COMPANY_TYPE,
                displayName: FAKE_CRM_COMPANY_TYPE,
                scope: 'self-configured',
                writable: true,
                readable: false,
              },
            ]);
          case 'describe':
            return send({
              typeId: FAKE_CRM_COMPANY_TYPE,
              displayName: FAKE_CRM_COMPANY_TYPE,
              fields: [
                { fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: true },
              ],
              references: [],
            });
          case 'resolveEntity':
            // The bug shape: a bare array instead of `{ candidates: [] }`.
            return send([]);
          default:
            return send({ ok: false });
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const config: RemoteAdapterConfig = {
      adapterType: FAKE_CRM_ADAPTER_TYPE,
      baseUrl: `http://127.0.0.1:${port}`,
      authStrategy: { kind: 'bearer' },
      credentialsId: 'test',
    };
    const manifest = await fetchRemoteManifest(config, SECRET);
    remote = createRemoteAdapter({ config, secret: SECRET, cacheScopeId: 'scope', manifest });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('coerces a bare-array resolveEntity response to { candidates: [] }', async () => {
    const result = await remote.resolveEntity({
      record: { Name: 'Vireo Robotics' },
      recordType: FAKE_CRM_COMPANY_TYPE,
      candidates: [],
      constraints: { any: [] },
    });
    expect(result).toEqual({ candidates: [] });
  });
});
