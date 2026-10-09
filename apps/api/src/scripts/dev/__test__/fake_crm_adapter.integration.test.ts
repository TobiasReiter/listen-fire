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
import type { RemoteAdapterConfig } from '../../../services/translation_graph/adapters/remote';
import type { FakeCrmServer } from '../fake_crm_adapter';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { BASE_RUNTIME_CAPABILITIES } from '../../../services/translation_graph/adapter';
import {
  createRemoteAdapter,
  fetchRemoteManifest,
  RemoteAdapter,
} from '../../../services/translation_graph/adapters/remote';
import { makeMetaPosition, positionData } from '../../../services/translation_graph/types';
import {
  FAKE_CRM_ADAPTER_TYPE,
  FAKE_CRM_COMMENTS_EDGE,
  FAKE_CRM_COMMENT_TYPE,
  FAKE_CRM_COMPANY_CREATED,
  FAKE_CRM_COMPANY_TYPE,
  FAKE_CRM_PAGE_SIZE,
  fakeCrmThreadKey,
  startFakeCrmServer,
} from '../fake_crm_adapter';


/** The team the adapter's calls are made for (sent as `x-listen-fire-team`). */
const CONFIG_TEAM_ID = '00000000-0000-4000-8000-0000000000c1' as TeamId;

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
      teamId: CONFIG_TEAM_ID,
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
      teamId: CONFIG_TEAM_ID,
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

  it('refuses a cursor it did not mint, as a bad request (not retryable)', async () => {
    await expect(
      remote.iterateRelatedPage!(
        { position: makeMetaPosition(FAKE_CRM_ADAPTER_TYPE), fieldId: FAKE_CRM_COMPANY_TYPE, direction: 'outgoing' },
        'not-an-offset',
      ),
    ).rejects.toThrow(/bad_request — iterateRelatedPage: fake CRM: unrecognised page cursor/);
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
      teamId: CONFIG_TEAM_ID,
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

async function remoteFor(server: FakeCrmServer, cacheScopeId: string): Promise<RemoteAdapter> {
  const config: RemoteAdapterConfig = {
    teamId: CONFIG_TEAM_ID,
    adapterType: FAKE_CRM_ADAPTER_TYPE,
    baseUrl: server.baseUrl,
    authStrategy: { kind: 'bearer' },
    credentialsId: 'test',
  };
  const manifest = await fetchRemoteManifest(config, SECRET);
  return createRemoteAdapter({ config, secret: SECRET, cacheScopeId, manifest });
}

// The comment thread is the awaitable edge: pending (keyed on the thread) until
// a comment exists, landed with the comments after, empty once the company is
// gone — all over the wire.
describe('Fake CRM awaits a comment thread over the wire', () => {
  let server: FakeCrmServer;
  let remote: RemoteAdapter;

  beforeAll(async () => {
    server = await startFakeCrmServer({ secret: SECRET });
    remote = await remoteFor(server, 'fake-crm-await');
  });

  afterAll(async () => {
    await server.close();
  });

  it('pending → landed → empty, with the thread as the correlation key', async () => {
    const { externalId } = await remote.createRecord({
      recordType: FAKE_CRM_COMPANY_TYPE,
      fields: { Name: 'Vireo Robotics' },
      mutationContext: MUTATION_CONTEXT,
    });
    const point = { recordId: externalId, edge: FAKE_CRM_COMMENTS_EDGE };

    expect(await remote.awaitable!.resolveAwait(point)).toEqual({
      status: 'pending',
      correlationKey: fakeCrmThreadKey(externalId),
    });

    await fetch(new URL('dev/comments', server.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company: externalId, text: 'approved' }),
    });
    expect(await remote.awaitable!.resolveAwait(point)).toEqual({
      status: 'landed',
      correlationKey: fakeCrmThreadKey(externalId),
      landings: [{ recordId: 'comment-1', recordType: FAKE_CRM_COMMENT_TYPE, fields: { Text: 'approved' } }],
    });

    await remote.deleteRecord({ recordType: FAKE_CRM_COMPANY_TYPE, externalId, mutationContext: MUTATION_CONTEXT });
    expect(await remote.awaitable!.resolveAwait(point)).toEqual({ status: 'empty' });
  });

  it('wakeKeys names the thread of each comment in its own delivery, and refuses anything else', async () => {
    expect(await remote.wakeKeys!({ raw: { comments: [{ thread: 'company-9', text: 'hi' }] } })).toEqual([
      fakeCrmThreadKey('company-9'),
    ]);
    await expect(remote.wakeKeys!({ raw: { comments: [{ thread: 9 }] } })).rejects.toThrow(
      /not a delivery this CRM sends/,
    );
  });
});

// The dev routes change the CRM as a user would, then push to the host's doors
// with the install's own bearer secret and the team header.
describe('Fake CRM pushes emit and wake to the host', () => {
  let server: FakeCrmServer;
  let host: http.Server;
  const received: Array<{ url: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];

  beforeAll(async () => {
    host = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) });
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: 1 }));
      });
    });
    await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
    const { port } = host.address() as AddressInfo;
    server = await startFakeCrmServer({
      secret: SECRET,
      host: { apiBaseUrl: `http://127.0.0.1:${port}`, teamId: 'team-1' },
    });
  });

  afterAll(async () => {
    await server.close();
    await new Promise<void>((resolve, reject) => host.close((err) => (err ? reject(err) : resolve())));
  });

  it('a created company is emitted; a comment wakes its thread', async () => {
    const created = await fetch(new URL('dev/companies', server.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Name: 'Larch' }),
    });
    const { company, push } = (await created.json()) as { company: { externalId: string }; push: unknown };
    expect(push).toEqual({ door: 'emit', status: 202, body: { accepted: 1 } });

    await fetch(new URL('dev/comments', server.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company: company.externalId, text: 'looks good' }),
    });

    expect(received.map((r) => r.url)).toEqual([
      `/api/public/adapter/${FAKE_CRM_ADAPTER_TYPE}/emit`,
      `/api/public/adapter/${FAKE_CRM_ADAPTER_TYPE}/wake`,
    ]);
    for (const r of received) {
      expect(r.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(r.headers['x-listen-fire-team']).toBe('team-1');
    }
    expect(received[0]?.body).toEqual({
      events: [
        {
          payload: { id: company.externalId, Name: 'Larch' },
          externalId: company.externalId,
          tag: FAKE_CRM_COMPANY_CREATED,
          eventType: FAKE_CRM_COMPANY_CREATED,
          changeType: 'create',
          recordType: FAKE_CRM_COMPANY_TYPE,
        },
      ],
    });
    expect(received[1]?.body).toEqual({ keys: [fakeCrmThreadKey(company.externalId)] });
    expect(server.comments).toEqual([{ id: 'comment-1', thread: company.externalId, Text: 'looks good' }]);
  });
});
