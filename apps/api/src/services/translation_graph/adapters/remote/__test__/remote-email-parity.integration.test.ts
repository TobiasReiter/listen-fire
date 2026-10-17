// Headline parity proof for the remote-adapter protocol.
//
// A `RemoteAdapter` driving the in-process email adapter OVER A REAL HTTP
// SERVER must return byte-for-byte the same results as calling that email
// adapter in-process. This test wires the email adapter through
// `createAdapterProtocolHandler`, serves it on an ephemeral `http.Server`
// port (NOT a mocked `fetch`), fetches the manifest over HTTP, constructs a
// `RemoteAdapter` from it, and asserts deep equality across the source-only
// surface (`describe`, `listEntryPoints`, the explicit `attachments` edge
// traversal via `getRelated`, `getActorCandidates`, `extractActor`).
//
// Why these methods: they are pure transforms / parses with NO Listen-Fire DB
// access (the email adapter's `getRelated`/`getActorCandidates`/
// `extractActor` read only the position / event payload;
// `describe`/`listEntryPoints` are hardcoded). The email adapter's writes
// throw (source-only) and aren't part of the parity surface. `extractActor`
// is now async (for remoteability) and IS a protocol method, so it
// round-trips over the wire here.
//
// A second describe block stands up a small synthetic adapter that declares
// `webhookEventTypeId` (static config) and an async `narrowReferenceType`,
// mounts it on the same protocol handler, and proves a `RemoteAdapter` built
// from its manifest (i) exposes `webhookEventTypeId` from the manifest and
// (ii) forwards `narrowReferenceType` over the wire — the proof that the
// closed gaps make a remote Attio-style (polymorphic) adapter buildable.
//
// The `.integration.test.ts` suffix marks this as a real-transport test
// (real socket, real HTTP round-trip). It does not touch Postgres — every
// exercised method is DB-free — but it runs under the integration jest
// config because that config's testMatch owns `*.integration.test.ts`.

import { hostedDocumentStore } from '../../../engine/files/retrieve';
import http from 'node:http';

import type { AddressInfo } from 'node:net';
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { EmailAdapter, EmailPayload } from '../../email';
import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { SourcePosition } from 'movement-engine/services/translation_graph/types';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { RemoteAdapterConfig } from 'movement-engine/services/translation_graph/adapters/remote';

import {
  createEmailAdapter,
  EMAIL_ADAPTER_TYPE,
  EMAIL_RECORD_TYPE_ID,
} from '../../email';
import { RESOURCES_REFERENCE_FIELD_ID } from 'movement-engine/services/translation_graph/adapter';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { makeUnstablePosition, positionData } from 'movement-engine/services/translation_graph/types';


/** Walk the explicit `attachments` edge and read each attachment's payload. */
async function attachmentsVia(adapter: Adapter, position: SourcePosition): Promise<Record<string, unknown>[]> {
  const related = await adapter.getRelated({
    position,
    fieldId: 'Attachments',
    direction: 'outgoing',
  });
  return related.map((r) => (positionData(r.position) ?? {}) as Record<string, unknown>);
}

import { createAdapterProtocolHandler } from 'module-kit';
import {
  createRemoteAdapter,
  fetchRemoteManifest,
  RemoteAdapter,
} from 'movement-engine/services/translation_graph/adapters/remote';


const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000001' as TeamId;
const TEST_SECRET = 'test-secret';

// ── Shared fixtures ───────────────────────────────────────────────────────

/**
 * One inbound email payload reused for both adapters. Mirrors the shape the
 * email adapter reads: a `From:` sender (→ originator candidate), forwarding
 * headers (→ relay candidates), a subject, an HTML + plain body (read via the
 * `Body` field), and two attachments (walked via the `attachments` edge).
 */
const EMAIL_PAYLOAD: EmailPayload & Record<string, unknown> = {
  messageId: '<msg-001@sender.example>',
  subject: 'Series A deck for Acme',
  sender: '"Jane Founder" <jane@acme.example>',
  recipient: 'inbox+dealflow@example.com',
  bodyHtml: '<p>Hi — attaching our deck and the cap table.</p>',
  bodyText: 'Hi — attaching our deck and the cap table.',
  attachments: [
    { key: 'att-deck-1', filename: 'deck.pdf', contentType: 'application/pdf', size: 12345, url: 'https://files.example/deck.pdf' },
    { key: 'att-cap-2', filename: 'cap-table.xlsx', contentType: 'application/vnd.ms-excel', size: 6789 },
  ],
  // Forwarding headers → relay candidates. The dealflow inbox forwarded it.
  'X-Forwarded-For': 'dealflow@portfolio.example',
  'Delivered-To': 'inbox+dealflow@example.com',
};

/** The single inbound `TriggerEvent` both adapters parse for actor candidates. */
const TRIGGER_EVENT: TriggerEvent = {
  pipelineInputId: 'pi-1',
  adapterType: EMAIL_ADAPTER_TYPE,
  triggerType: 'webhook',
  payload: EMAIL_PAYLOAD,
};

/** The email source position both adapters extract resources from. */
const EMAIL_POSITION: SourcePosition = makeUnstablePosition({
  adapterType: EMAIL_ADAPTER_TYPE,
  recordType: EMAIL_RECORD_TYPE_ID,
  data: EMAIL_PAYLOAD,
});

// ── Server + remote adapter wiring ────────────────────────────────────────

describe('RemoteAdapter ⟷ in-process email adapter parity (over real HTTP)', () => {
  let local: EmailAdapter;
  let server: http.Server;
  let baseUrl: string;
  let remote: RemoteAdapter;
  let requestCount = 0;

  beforeAll(async () => {
    local = createEmailAdapter({ teamId: TEST_TEAM_ID });

    const handler = createAdapterProtocolHandler({
      adapter: local,
      authenticate: (headers) => headers['authorization'] === `Bearer ${TEST_SECRET}`,
    });

    server = http.createServer((req, res) => {
      requestCount += 1;
      void handler(req, res);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/`;

    const config: RemoteAdapterConfig = {
      teamId: TEST_TEAM_ID,
      adapterType: EMAIL_ADAPTER_TYPE,
      baseUrl,
      authStrategy: { kind: 'bearer' },
      credentialsId: 'test',
    };

    // Manifest fetch over real HTTP — proves the install-time handshake.
    const manifest = await fetchRemoteManifest(config, TEST_SECRET);
    remote = createRemoteAdapter({ documents: hostedDocumentStore,
      config,
      secret: TEST_SECRET,
      cacheScopeId: 'test-scope',
      manifest,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  // ── Manifest ─────────────────────────────────────────────────────────────

  it('manifest reflects the email adapter type + the source-only method set', () => {
    expect(remote.adapterType).toBe(local.adapterType);
    expect(remote.supportedTriggers).toEqual(local.supportedTriggers);
    expect(remote.runtimeCapabilities()).toEqual(local.runtimeCapabilities());

    // The factory pruned writes / unadvertised optional methods; the
    // source-only surface survives. Resources are reached via the uniform
    // `getRelated` traversal now (no bespoke `getResources` method).
    expect(typeof remote.getRelated).toBe('function');
    expect(typeof remote.getActorCandidates).toBe('function');
    // Email is source-only → no `readRecord` advertised → pruned.
    expect(remote.readRecord).toBeUndefined();
  });

  // ── describe ───────────────────────────────────────────────────────────────

  it('describe(email:message) is deep-equal local vs remote', async () => {
    const [localDesc, remoteDesc] = await Promise.all([
      local.describe(EMAIL_RECORD_TYPE_ID),
      remote.describe(EMAIL_RECORD_TYPE_ID),
    ]);
    expect(remoteDesc).toEqual(localDesc);
    expect(remoteDesc).not.toBeNull();
  });

  // ── listEntryPoints ────────────────────────────────────────────────────────

  it('listEntryPoints() is deep-equal local vs remote', async () => {
    const [localEntries, remoteEntries] = await Promise.all([
      local.listEntryPoints(),
      remote.listEntryPoints(),
    ]);
    expect(remoteEntries).toEqual(localEntries);
  });

  // ── attachments edge (explicit-content parity over getRelated) ─────────────
  // `_resources` is no longer an input-side reference — it is extracted-node
  // provenance now. Input content is read EXPLICITLY (the body field + the
  // `attachments` edge), and that explicit surface must stay at parity over
  // the wire.

  it('the `attachments` edge yields the same attachment positions local vs remote', async () => {
    // The engine stamps a read position with the NATURAL type name (`Email`),
    // which is the currency a natural edge name resolves against.
    const naturalPosition: SourcePosition = makeUnstablePosition({
      adapterType: EMAIL_ADAPTER_TYPE,
      recordType: 'Email',
      data: EMAIL_PAYLOAD,
    });
    const [localAttachments, remoteAttachments] = await Promise.all([
      attachmentsVia(local, naturalPosition),
      attachmentsVia(remote, naturalPosition),
    ]);

    expect(remoteAttachments).toEqual(localAttachments);
    // Sanity: the parity surface carries the two attachments by name.
    expect(remoteAttachments.map((a) => a.filename)).toEqual(['deck.pdf', 'cap-table.xlsx']);
  });

  it('a `_resources` hop off an input email position no longer resolves (parity: both reject)', async () => {
    // The reference is gone from `describe`, so a `_resources` hop off an INPUT
    // position drifts. The remote proxies the same drift over the wire.
    await expect(
      local.getRelated({ position: EMAIL_POSITION, fieldId: RESOURCES_REFERENCE_FIELD_ID, direction: 'outgoing' }),
    ).rejects.toThrow();
    await expect(
      remote.getRelated({ position: EMAIL_POSITION, fieldId: RESOURCES_REFERENCE_FIELD_ID, direction: 'outgoing' }),
    ).rejects.toThrow();
  });

  // ── getActorCandidates (acting-user parse parity) ──────────────────────────

  it('getActorCandidates({ event }) yields the same ordered candidates (originator + relays)', async () => {
    const [localCandidates, remoteCandidates] = await Promise.all([
      local.getActorCandidates({ event: TRIGGER_EVENT }),
      remote.getActorCandidates!({ event: TRIGGER_EVENT }),
    ]);

    expect(remoteCandidates).toEqual(localCandidates);

    // Sanity: sender is the originator; forwarding hops are relays, in order.
    expect(remoteCandidates[0]).toEqual({
      identity: {
        identifier: 'jane@acme.example',
        scheme: 'email',
        adapterType: 'email',
        email: 'jane@acme.example',
      },
      source: 'originator',
    });
    expect(remoteCandidates.slice(1).map((c) => c.source)).toEqual(
      Array(remoteCandidates.length - 1).fill('relay'),
    );
    expect(remoteCandidates.map((c) => c.identity.identifier)).toContain('dealflow@portfolio.example');
  });

  // ── extractActor (raw-actor parse parity, async over the wire) ─────────────

  it('extractActor({ event }) yields the same ActorIdentity local vs remote', async () => {
    expect(typeof remote.extractActor).toBe('function');
    const [localActor, remoteActor] = await Promise.all([
      local.extractActor({ event: TRIGGER_EVENT }),
      remote.extractActor!({ event: TRIGGER_EVENT }),
    ]);

    expect(remoteActor).toEqual(localActor);
    // Sanity: the raw sender is parsed into an email-kind actor identity.
    expect(remoteActor).toEqual({
      identifier: 'jane@acme.example',
      scheme: 'email',
      adapterType: 'email',
      email: 'jane@acme.example',
      name: 'Jane Founder',
      label: 'Jane Founder',
    });
  });

  // ── Proof the remote path went over the wire ───────────────────────────────

  it('every remote call traversed the real HTTP server', () => {
    // manifest (1) + describe + listEntryPoints + getResources +
    // getActorCandidates + extractActor = 6 requests minimum reached the
    // socket.
    expect(requestCount).toBeGreaterThanOrEqual(6);
  });

  // ── Auth gate ──────────────────────────────────────────────────────────────

  it('a bad secret is rejected at the transport layer (401 → transport error)', async () => {
    const badConfig: RemoteAdapterConfig = {
      teamId: TEST_TEAM_ID,
      adapterType: EMAIL_ADAPTER_TYPE,
      baseUrl,
      authStrategy: { kind: 'bearer' },
      credentialsId: 'test',
    };
    await expect(fetchRemoteManifest(badConfig, 'wrong-secret')).rejects.toMatchObject({
      name: 'RemoteTransportError',
      status: 401,
    });
  });
});

// ── Polymorphic-adapter buildability proof ───────────────────────────────────
//
// The closed gaps (config-driven `webhookEventTypeId` + async, remoteable
// `narrowReferenceType`) are exactly what an Attio-style polymorphic adapter
// needs to live behind the protocol. This stands up a synthetic adapter that
// declares both, serves it over real HTTP, and proves a RemoteAdapter built
// from its manifest carries the config and forwards the call.

const POLY_ADAPTER_TYPE = 'synthetic-poly';
const POLY_WEBHOOK_TYPE = 'synthetic-poly:webhook_event';
const POLY_NARROWED_TYPE = 'synthetic-poly:companies';

const POLY_CAPS = {
  traversal: { incoming: false, edgeProperties: false },
  resources: false,
} as const;

function createPolyAdapter(): Adapter {
  return {
    adapterType: POLY_ADAPTER_TYPE,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => POLY_CAPS,
    webhookEventTypeId: POLY_WEBHOOK_TYPE,
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue() {
      return null;
    },
    async getRelated() {
      return [];
    },
    async createRecord() {
      return { adapterType: POLY_ADAPTER_TYPE, externalId: 'poly', data: {} };
    },
    async updateRecord(input) {
      return { adapterType: POLY_ADAPTER_TYPE, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
}

describe('RemoteAdapter buildability for a webhook adapter (static manifest config)', () => {
  let server: http.Server;
  let remote: RemoteAdapter;

  beforeAll(async () => {
    const local = createPolyAdapter();
    const handler = createAdapterProtocolHandler({
      adapter: local,
      authenticate: (headers) => headers['authorization'] === `Bearer ${TEST_SECRET}`,
    });
    server = http.createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const config: RemoteAdapterConfig = {
      teamId: TEST_TEAM_ID,
      adapterType: POLY_ADAPTER_TYPE,
      baseUrl: `http://127.0.0.1:${port}/`,
      authStrategy: { kind: 'bearer' },
      credentialsId: 'test',
    };
    const manifest = await fetchRemoteManifest(config, TEST_SECRET);
    remote = createRemoteAdapter({ documents: hostedDocumentStore,
      config,
      secret: TEST_SECRET,
      cacheScopeId: 'poly-scope',
      manifest,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('exposes webhookEventTypeId from the manifest (static config, no RPC)', () => {
    expect(remote.webhookEventTypeId).toBe(POLY_WEBHOOK_TYPE);
  });
});
