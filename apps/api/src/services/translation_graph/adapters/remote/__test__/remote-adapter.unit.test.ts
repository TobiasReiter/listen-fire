// RemoteAdapter — the client side of the wire protocol. These tests stub the
// transport by jest.mocking `postRpc` from `protocol/client`, so we assert the
// exact RPC envelope the adapter issues (method, params, cacheScopeId) and the
// re-wrapping of paged streams + manifest-gated optional methods. Names on the
// wire are the caller's natural names, forwarded untranslated.

import type { RuntimeCapabilities } from '../../../adapter';
import type { RemoteAdapterConfig, RemoteManifest } from '../index';

// Mock the transport. Every forwarder funnels through `postRpc`; we control its
// return value per-method and inspect the calls.
jest.mock('../../../protocol/client', () => {
  const actual = jest.requireActual('../../../protocol/client');
  return { ...actual, postRpc: jest.fn() };
});

import { postRpc } from '../../../protocol/client';
import { RemoteAdapter, createRemoteAdapter, fetchRemoteManifest } from '../index';

const postRpcMock = postRpc as jest.MockedFunction<typeof postRpc>;

const runtimeCapabilities: RuntimeCapabilities = {
  traversal: { incoming: false, edgeProperties: false },
  resources: false,
};

const config: RemoteAdapterConfig = {
  adapterType: 'remote-email',
  baseUrl: 'https://adapter.example/rpc',
  authStrategy: { kind: 'bearer' },
  credentialsId: 'cred-1',
};

const CACHE_SCOPE = 'scope-abc';

const ALL_METHODS = [
  'manifest',
  'listEntryPoints',
  'describe',
  'resolveEntity',
  'getFieldValue',
  'getRelated',
  'iterateRelated',
  'preprocessInbound',
  'listEventTypes',
  'createRecord',
  'updateRecord',
  'deleteRecord',
  'readRecord',
  'translateFilter',
  'getDedupRules',
  'getActorCandidates',
  'extractActor',
  'describeOpaqueId',
  'resolveFileRef',
  'invokeFieldFunction',
  'linkRecords',
  'unlinkRecords',
  'ensureEventSubscription',
  'removeEventSubscription',
  'wakeKeys',
];

function manifest(methods: readonly string[] = ALL_METHODS): RemoteManifest {
  return {
    adapterType: 'remote-email',
    supportedTriggers: ['snapshot', 'webhook'],
    runtimeCapabilities,
    methods,
  };
}

function buildAdapter(methods: readonly string[] = ALL_METHODS): RemoteAdapter {
  return createRemoteAdapter({
    config,
    secret: 's3cr3t',
    cacheScopeId: CACHE_SCOPE,
    manifest: manifest(methods),
  });
}

const samplePosition = {
  adapterType: 'remote-email',
  recordType: 'email:message',
  identity: { kind: 'unstable' as const, data: { from: 'h@x.com' } },
};

// ── Transport ────────────────────────────────────────────────────────────────
//
// The adapter is a pure forwarder: every call is exactly one RPC carrying the
// caller's natural names. `primeTransport` serves each RPC from a per-test FIFO
// queue (`enqueue`) and fails on any call nobody queued for — so a stray
// introspection round-trip (the deleted id shim's signature) fails the test.

let responseQueue: unknown[] = [];
function enqueue(...responses: unknown[]): void {
  responseQueue.push(...responses);
}

function primeTransport(): void {
  postRpcMock.mockImplementation(async (req: { method: string }) => {
    if (responseQueue.length === 0) {
      throw new Error(`unit-test transport: no queued response for method=${req.method}`);
    }
    return responseQueue.shift();
  });
}

function calledMethods(): string[] {
  return postRpcMock.mock.calls.map((c) => c[0].method);
}

beforeEach(() => {
  primeTransport();
});

afterEach(() => {
  postRpcMock.mockReset();
  responseQueue = [];
});

describe('RemoteAdapter manifest props', () => {
  it('exposes adapterType / supportedTriggers / runtimeCapabilities from the manifest', () => {
    const adapter = buildAdapter();
    expect(adapter.adapterType).toBe('remote-email');
    expect(adapter.supportedTriggers).toEqual(['snapshot', 'webhook']);
    expect(adapter.runtimeCapabilities()).toBe(runtimeCapabilities);
  });

  it('exposes webhookEventTypeId from the manifest (static config, no RPC)', () => {
    const adapter = createRemoteAdapter({
      config,
      secret: 's3cr3t',
      cacheScopeId: CACHE_SCOPE,
      manifest: { ...manifest(), webhookEventTypeId: 'remote-attio:webhook_event' },
    });
    expect(adapter.webhookEventTypeId).toBe('remote-attio:webhook_event');
  });
});

describe('RemoteAdapter forwarding (natural names, untranslated)', () => {
  const mutationContext = { source: { adapterType: 'kg' }, occurredAt: '2026-06-05T00:00:00Z' };
  const contact = {
    adapterType: 'remote-email',
    recordType: 'Contact',
    identity: { kind: 'stable' as const, recordId: 'c1', data: { Email: 'a@x.com' } },
  };

  it('describe forwards the natural type name as typeId with the cacheScopeId stamped', async () => {
    const descriptor = { typeId: 'obj_1', displayName: 'Contact', fields: [], references: [] };
    enqueue(descriptor);
    const adapter = buildAdapter();
    expect(await adapter.describe('Contact')).toEqual(descriptor);
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: config.baseUrl,
        method: 'describe',
        cacheScopeId: CACHE_SCOPE,
        params: { typeId: 'Contact' },
        auth: { Authorization: 'Bearer s3cr3t' },
      }),
    );
    expect(calledMethods()).toEqual(['describe']);
  });

  it('listEntryPoints issues method=listEntryPoints with empty params', async () => {
    const entryPoints = [{ typeId: 'obj_1', displayName: 'Contact', writable: false, readable: true }];
    enqueue(entryPoints);
    const adapter = buildAdapter();
    expect(await adapter.listEntryPoints()).toEqual(entryPoints);
    expect(postRpcMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'listEntryPoints', params: {} }));
  });

  it('getFieldValue forwards the natural field name in one call', async () => {
    enqueue('a@x.com');
    const adapter = buildAdapter();
    expect(await adapter.getFieldValue({ position: contact, fieldId: 'Email' })).toBe('a@x.com');
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'getFieldValue', params: { position: contact, fieldId: 'Email' } }),
    );
    expect(calledMethods()).toEqual(['getFieldValue']);
  });

  it('getRelated forwards the natural edge name', async () => {
    const related = [{ position: { ...contact, recordType: 'Company' } }];
    enqueue(related);
    const adapter = buildAdapter();
    const input = { position: contact, fieldId: 'Company', direction: 'outgoing' as const };
    expect(await adapter.getRelated(input)).toEqual(related);
    expect(postRpcMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'getRelated', params: input }));
    expect(calledMethods()).toEqual(['getRelated']);
  });

  it('resolveEntity forwards record keys and constraints as given and returns candidates as given', async () => {
    const candidate = { adapterType: 'remote-email', externalId: 'c1', data: { Email: 'a@x.com' } };
    enqueue({ candidates: [candidate] });
    const input = {
      record: { Email: 'a@x.com' },
      recordType: 'Contact',
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Email' }] }] },
    };
    const adapter = buildAdapter();
    expect(await adapter.resolveEntity(input)).toEqual({ candidates: [candidate] });
    expect(postRpcMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'resolveEntity', params: input }));
    expect(calledMethods()).toEqual(['resolveEntity']);
  });

  it('createRecord forwards natural field names and normalises the parent set', async () => {
    const writeResult = { adapterType: 'remote-email', externalId: 'c9', data: { Email: 'a@x.com' } };
    enqueue(writeResult);
    const parentLinks = [{ recordType: 'Company', externalId: 'co1', edgeName: 'Contacts' }];
    const adapter = buildAdapter();
    const result = await adapter.createRecord({
      recordType: 'Contact',
      fields: { Email: 'a@x.com' },
      evidence: { Email: { quote: 'a@x.com' } },
      parentLinks,
      mutationContext,
    } as never);
    expect(result).toEqual(writeResult);
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'createRecord',
        params: expect.objectContaining({
          recordType: 'Contact',
          fields: { Email: 'a@x.com' },
          evidence: { Email: { quote: 'a@x.com' } },
          parentLinks,
        }),
      }),
    );
    expect(calledMethods()).toEqual(['createRecord']);
  });

  it('createRecord with no parents sends an empty parentLinks', async () => {
    enqueue({ adapterType: 'remote-email', externalId: 'c9', data: {} });
    const adapter = buildAdapter();
    await adapter.createRecord({ recordType: 'Contact', fields: {}, mutationContext } as never);
    expect(postRpcMock.mock.calls[0][0].params).toMatchObject({ parentLinks: [] });
  });

  it('deleteRecord / translateFilter / getDedupRules / invokeFieldFunction forward their natural names', async () => {
    const adapter = buildAdapter();

    enqueue({});
    await adapter.deleteRecord({ recordType: 'Contact', externalId: 'c1', mutationContext } as never);
    enqueue({ native: { q: 1 }, residual: null });
    await adapter.translateFilter!({ expression: { kind: 'x' } as never, entityType: 'Contact' });
    enqueue({ constraints: [] });
    await adapter.getDedupRules!({ typeRef: 'Contact' });
    enqueue('composed');
    const invoke = {
      recordType: 'Contact',
      fieldId: 'Email',
      functionName: 'COMPOSE',
      args: { instructions: 'do it', data: [] },
    };
    expect(await adapter.invokeFieldFunction!(invoke)).toBe('composed');

    const params = postRpcMock.mock.calls.map((c) => [c[0].method, c[0].params]);
    expect(params).toEqual([
      ['deleteRecord', { recordType: 'Contact', externalId: 'c1', mutationContext }],
      ['translateFilter', { expression: { kind: 'x' }, entityType: 'Contact' }],
      ['getDedupRules', { typeRef: 'Contact' }],
      ['invokeFieldFunction', invoke],
    ]);
  });

  it('stamps the same cacheScopeId on every call', async () => {
    enqueue([], []);
    const adapter = buildAdapter();
    await adapter.listEntryPoints();
    await adapter.getRelated({ position: samplePosition, fieldId: 'attachments', direction: 'outgoing' });
    for (const call of postRpcMock.mock.calls) {
      expect(call[0].cacheScopeId).toBe(CACHE_SCOPE);
    }
  });
});

describe('RemoteAdapter v2 forwarders', () => {
  const mutationContext = { source: { adapterType: 'kg' }, occurredAt: '2026-06-05T00:00:00Z' };
  const link = {
    from: { recordType: 'Contact', externalId: 'c1' },
    edgeName: 'Company',
    to: { recordType: 'Company', externalId: 'co1' },
    mutationContext,
  };

  it('linkRecords / unlinkRecords forward the edge by name', async () => {
    enqueue({ created: true }, { removed: true });
    const adapter = buildAdapter();
    expect(await adapter.linkRecords!(link as never)).toEqual({ created: true });
    expect(await adapter.unlinkRecords!(link as never)).toEqual({ removed: true });
    expect(postRpcMock.mock.calls.map((c) => [c[0].method, c[0].params])).toEqual([
      ['linkRecords', link],
      ['unlinkRecords', link],
    ]);
  });

  it('ensureEventSubscription maps a null answer to "nothing registered"; removeEventSubscription resolves void', async () => {
    enqueue({ externalId: 'wh-1', secret: 's' }, null, null);
    const adapter = buildAdapter();
    const input = { events: ['record.created'], callbackUrl: 'https://host/hook' };
    expect(await adapter.ensureEventSubscription!(input)).toEqual({ externalId: 'wh-1', secret: 's' });
    expect(await adapter.ensureEventSubscription!(input)).toBeUndefined();
    expect(await adapter.removeEventSubscription!({ callbackUrl: 'https://host/hook' })).toBeUndefined();
    expect(calledMethods()).toEqual([
      'ensureEventSubscription',
      'ensureEventSubscription',
      'removeEventSubscription',
    ]);
  });

  it('wakeKeys forwards the raw payload', async () => {
    enqueue(['C1:1.2']);
    const adapter = buildAdapter();
    expect(await adapter.wakeKeys!({ raw: { thread_ts: '1.2' } })).toEqual(['C1:1.2']);
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'wakeKeys', params: { raw: { thread_ts: '1.2' } } }),
    );
  });

  it('prunes each v2 forwarder the manifest does not advertise', () => {
    const adapter = buildAdapter(['listEntryPoints', 'describe']);
    expect(adapter.linkRecords).toBeUndefined();
    expect(adapter.unlinkRecords).toBeUndefined();
    expect(adapter.ensureEventSubscription).toBeUndefined();
    expect(adapter.removeEventSubscription).toBeUndefined();
    expect(adapter.wakeKeys).toBeUndefined();
  });
});

describe('RemoteAdapter awaitable gating', () => {
  const point = { recordId: 'ask-1', edge: 'Response', headData: { channel: 'C1' } };

  it('has no awaitable capability unless the manifest advertises resolveAwait', () => {
    expect(buildAdapter(ALL_METHODS).awaitable).toBeUndefined();
  });

  it('forwards resolveAwait when advertised and returns the resolution', async () => {
    const adapter = buildAdapter([...ALL_METHODS, 'resolveAwait']);
    expect(adapter.awaitable).toBeDefined();
    enqueue(
      { status: 'pending', correlationKey: 'C1:1.2' },
      { status: 'landed', correlationKey: 'C1:1.2', landings: [{ recordType: 'Response', fields: { Answer: 'yes' } }] },
    );
    expect(await adapter.awaitable!.resolveAwait(point)).toEqual({ status: 'pending', correlationKey: 'C1:1.2' });
    expect(await adapter.awaitable!.resolveAwait(point)).toEqual({
      status: 'landed',
      correlationKey: 'C1:1.2',
      landings: [{ recordType: 'Response', fields: { Answer: 'yes' } }],
    });
    expect(postRpcMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'resolveAwait', params: point }));
  });
});

describe('RemoteAdapter resolveEntity tolerance', () => {
  const resolveInput = {
    record: { name: 'Acme' },
    recordType: 'attio:companies',
    candidates: [],
    constraints: { any: [] },
  };

  it('tolerates a server that returns a bare [] (no { candidates } wrapper)', async () => {
    // The handbook historically said resolveEntity "may always return []".
    // A homespun adapter that did so must not crash the write path.
    enqueue([]);
    const adapter = buildAdapter();
    const result = await adapter.resolveEntity(resolveInput as never);
    expect(result).toEqual({ candidates: [] });
  });

  it('tolerates a bare candidates array', async () => {
    enqueue([{ adapterType: 'attio', externalId: 'rec-1', data: { name: 'Acme' } }]);
    const adapter = buildAdapter();
    const result = await adapter.resolveEntity(resolveInput as never);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ externalId: 'rec-1' });
  });
});

describe('RemoteAdapter surfaces a helpful error on a malformed response', () => {
  it('names the failing method when a result does not match its schema', async () => {
    // createRecord result must be an ExternalRecordRef; this is missing the
    // required fields. The thrown error should name the method, not just dump
    // a raw Zod issue.
    enqueue({ nope: true });
    const adapter = buildAdapter();
    await expect(
      adapter.createRecord({
        recordType: 'attio:companies',
        fields: { name: 'Acme' },
        mutationContext: {
          source: { adapterType: 'kg' },
          occurredAt: '2026-06-05T00:00:00Z',
        },
      } as never),
    ).rejects.toThrow(/createRecord/);
  });
});

describe('RemoteAdapter streaming re-wrap', () => {
  const input = { position: samplePosition, fieldId: 'attachments', direction: 'outgoing' as const };
  const r1 = { position: samplePosition, edgeId: 'e1' };
  const r2 = { position: samplePosition, edgeId: 'e2' };

  async function drain(adapter: RemoteAdapter): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const r of adapter.iterateRelated!(input)) out.push(r);
    return out;
  }

  it('iterateRelated pages the old method when only it is advertised, cursor starting undefined', async () => {
    enqueue({ items: [r1], nextCursor: 'rc1' }, { items: [r2] });
    expect(await drain(buildAdapter())).toEqual([r1, r2]);
    expect(calledMethods()).toEqual(['iterateRelated', 'iterateRelated']);
    expect(postRpcMock.mock.calls[0][0].params).toMatchObject({ cursor: undefined });
    expect(postRpcMock.mock.calls[1][0].params).toMatchObject({ cursor: 'rc1' });
  });

  it('iterateRelated pages iterateRelatedPage when advertised', async () => {
    enqueue({ items: [r1], nextCursor: 'rc1' }, { items: [r2] });
    const adapter = buildAdapter(['listEntryPoints', 'describe', 'iterateRelatedPage']);
    expect(typeof adapter.iterateRelated).toBe('function');
    expect(await drain(adapter)).toEqual([r1, r2]);
    expect(calledMethods()).toEqual(['iterateRelatedPage', 'iterateRelatedPage']);
    expect(postRpcMock.mock.calls[1][0].params).toMatchObject({ ...input, cursor: 'rc1' });
  });

  it('loops the cursor through three pages and stops at the page with none', async () => {
    const r3 = { position: samplePosition, edgeId: 'e3' };
    enqueue(
      { items: [r1], nextCursor: { page: 2 } },
      { items: [r2], nextCursor: { page: 3 } },
      { items: [r3] },
    );
    const adapter = buildAdapter(['listEntryPoints', 'describe', 'iterateRelatedPage']);
    expect(await drain(adapter)).toEqual([r1, r2, r3]);
    expect(postRpcMock.mock.calls.map((c) => (c[0].params as { cursor?: unknown }).cursor)).toEqual([
      undefined,
      { page: 2 },
      { page: 3 },
    ]);
  });

  it('a failing page surfaces through the stream after the pages before it', async () => {
    const adapter = buildAdapter(['listEntryPoints', 'describe', 'iterateRelatedPage']);
    postRpcMock
      .mockImplementationOnce(async () => ({ items: [r1], nextCursor: 'rc1' }))
      .mockImplementationOnce(async () => {
        throw new Error('page 2 exploded');
      });
    const out: unknown[] = [];
    await expect(
      (async () => {
        for await (const r of adapter.iterateRelated!(input)) out.push(r);
      })(),
    ).rejects.toThrow('page 2 exploded');
    expect(out).toEqual([r1]);
  });

  it('a server answering the same cursor again fails after the first page instead of looping', async () => {
    enqueue({ items: [r1], nextCursor: 'a' }, { items: [r1], nextCursor: 'a' });
    const adapter = buildAdapter(['listEntryPoints', 'describe', 'iterateRelatedPage']);
    const out: unknown[] = [];
    await expect(
      (async () => {
        for await (const r of adapter.iterateRelated!(input)) out.push(r);
      })(),
    ).rejects.toThrow(/same cursor again/);
    expect(out).toEqual([r1]);
    expect(calledMethods()).toHaveLength(2);
  });

  it('exposes one page as iterateRelatedPage, so a remote behind a remote pages through', async () => {
    enqueue({ items: [r2], nextCursor: 'rc2' });
    const adapter = buildAdapter(['listEntryPoints', 'describe', 'iterateRelatedPage']);
    expect(await adapter.iterateRelatedPage!(input, 'rc1')).toEqual({ items: [r2], nextCursor: 'rc2' });
    expect(calledMethods()).toEqual(['iterateRelatedPage']);
    expect(postRpcMock.mock.calls[0][0].params).toMatchObject({ ...input, cursor: 'rc1' });
  });

  it('prunes iterateRelatedPage with iterateRelated when neither paging method is advertised', () => {
    const adapter = buildAdapter(['listEntryPoints', 'describe']);
    expect(adapter.iterateRelatedPage).toBeUndefined();
    expect(adapter.iterateRelated).toBeUndefined();
  });
});

describe('RemoteAdapter manifest gating', () => {
  it('omits an optional method the manifest did not advertise', () => {
    const adapter = buildAdapter(ALL_METHODS.filter((m) => m !== 'getActorCandidates'));
    expect(adapter.getActorCandidates).toBeUndefined();
  });

  it('keeps an optional method the manifest advertised as a callable forwarder', async () => {
    postRpcMock.mockResolvedValueOnce([
      { identity: { identifier: 'h@x.com', scheme: 'email' }, source: 'originator' },
    ]);

    const adapter = buildAdapter();
    expect(typeof adapter.getActorCandidates).toBe('function');

    const event = { pipelineInputId: 'pi', adapterType: 'remote-email', triggerType: 'webhook', payload: null };
    const result = await adapter.getActorCandidates!({ event: event as never });
    expect(result).toEqual([
      { identity: { identifier: 'h@x.com', scheme: 'email' }, source: 'originator' },
    ]);
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'getActorCandidates', params: { event } }),
    );
  });

  it('omits iterateRelated when neither paging method is advertised', () => {
    const adapter = buildAdapter(['listEntryPoints', 'describe']);
    expect(adapter.iterateRelated).toBeUndefined();
  });

  it('forwards extractActor over the wire when advertised', async () => {
    postRpcMock.mockResolvedValueOnce({ identifier: 'wm-1', scheme: 'opaque', adapterType: 'attio', label: 'wm-1' });
    const adapter = buildAdapter();
    expect(typeof adapter.extractActor).toBe('function');

    const event = { pipelineInputId: 'pi', adapterType: 'remote-email', triggerType: 'webhook', payload: null };
    const result = await adapter.extractActor!({ event: event as never });
    expect(result).toEqual({ identifier: 'wm-1', scheme: 'opaque', adapterType: 'attio', label: 'wm-1' });
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'extractActor', params: { event } }),
    );
  });

  it('forwards invokeFieldFunction over the wire when advertised', async () => {
    enqueue('*Thanks @[Frank Smith]!* 🎉');
    const adapter = buildAdapter();
    expect(typeof adapter.invokeFieldFunction).toBe('function');

    const params = {
      recordType: 'remote:message',
      fieldId: 'text',
      functionName: 'SLACK_MESSAGE',
      args: { instructions: 'thank them', data: ['Frank Smith'] },
    };
    const result = await adapter.invokeFieldFunction!(params);
    expect(result).toBe('*Thanks @[Frank Smith]!* 🎉');
    // recordType + fieldId resolve (identity) to the remote's internal ids.
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'invokeFieldFunction', params }),
    );
  });

  it('prunes extractActor / invokeFieldFunction when not advertised', () => {
    const adapter = buildAdapter(
      ALL_METHODS.filter(
        (m) => m !== 'extractActor' && m !== 'invokeFieldFunction',
      ),
    );
    expect(adapter.extractActor).toBeUndefined();
    expect(adapter.invokeFieldFunction).toBeUndefined();
  });
});

describe('fetchRemoteManifest', () => {
  it('calls method=manifest and parses the result into a RemoteManifest', async () => {
    postRpcMock.mockResolvedValueOnce({
      protocolVersion: 2,
      adapterType: 'remote-email',
      supportedTriggers: ['snapshot', 'webhook'],
      runtimeCapabilities,
      methods: ['describe', 'getRelated'],
      webhookEventTypeId: 'remote-email:webhook_event',
    });

    const result = await fetchRemoteManifest(config, 's3cr3t');

    expect(result.adapterType).toBe('remote-email');
    expect(result.supportedTriggers).toEqual(['snapshot', 'webhook']);
    expect(result.methods).toEqual(['describe', 'getRelated']);
    expect(result.webhookEventTypeId).toBe('remote-email:webhook_event');
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: config.baseUrl,
        method: 'manifest',
        params: {},
        auth: { Authorization: 'Bearer s3cr3t' },
      }),
    );
  });
});

describe('fetchRemoteManifest refuses an older server', () => {
  it('names the protocolVersion field when the server sends none or another version', async () => {
    const v1 = { adapterType: 'remote-email', supportedTriggers: [], runtimeCapabilities, methods: [] };
    postRpcMock.mockResolvedValueOnce(v1);
    await expect(fetchRemoteManifest(config, 's3cr3t')).rejects.toThrow(
      new RegExp(`Remote adapter "remote-email" at ${config.baseUrl} refused: protocolVersion: expected 2, got nothing`),
    );
    postRpcMock.mockResolvedValueOnce({ ...v1, protocolVersion: 1 });
    await expect(fetchRemoteManifest(config, 's3cr3t')).rejects.toThrow(/protocolVersion: expected 2, got 1/);
  });
});

describe('RemoteAdapter.resolveFileRef (url→stream)', () => {
  const ref = {
    __brand: 'FileRef' as const,
    name: 'doc.pdf',
    source: { ownerAdapterType: 'remote-email', handle: 'h-1' },
  };

  it('calls the wire resolveFileRef (→ {url}), fetches it, and yields a stream', async () => {
    const realFetch = global.fetch;
    // Wire method returns a presigned/proxy url; bytes never ride the envelope.
    postRpcMock.mockResolvedValueOnce({ url: 'https://owner.example/blob/abc', contentType: 'application/pdf' });
    const fetchMock = jest.fn(async () =>
      new Response('PDFBYTES', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const adapter = buildAdapter();
      const { stream, contentType } = await adapter.resolveFileRef!({ ref });

      // Forwarded the FileRef over the wire as the resolveFileRef params.
      expect(postRpcMock).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'resolveFileRef', params: { ref } }),
      );
      // Fetched the resolved url.
      expect(fetchMock).toHaveBeenCalledWith('https://owner.example/blob/abc');
      expect(contentType).toBe('application/pdf');

      // The stream yields the fetched bytes.
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
      expect(Buffer.concat(chunks).toString()).toBe('PDFBYTES');
    } finally {
      global.fetch = realFetch;
    }
  });

  it('is pruned when the manifest does not advertise it', () => {
    const adapter = buildAdapter(ALL_METHODS.filter((m) => m !== 'resolveFileRef'));
    expect(adapter.resolveFileRef).toBeUndefined();
  });
});

describe('RemoteAdapter FileRef revival on getFieldValue', () => {
  it('re-binds retrieve() on a wire FileRef so it fetches via the wire resolveFileRef', async () => {
    // A FileRef crosses the wire as plain JSON — no closure. getFieldValue
    // returns it; the adapter must re-attach a working retrieve().
    enqueue({
      __brand: 'FileRef',
      name: 'deck.pdf',
      contentType: 'application/pdf',
      source: { ownerAdapterType: 'remote-email', handle: 'h-1' },
    });

    const adapter = buildAdapter();
    const ref = (await adapter.getFieldValue({
      position: samplePosition,
      fieldId: 'from',
    })) as { retrieve?: () => Promise<{ stream: AsyncIterable<unknown> }> };

    expect(typeof ref.retrieve).toBe('function');

    // retrieve() forwards to the wire resolveFileRef (→ {url}) then fetches it.
    enqueue({ url: 'https://owner.example/blob/h-1', contentType: 'application/pdf' });
    const realFetch = global.fetch;
    const fetchMock = jest.fn(async () =>
      new Response('REMOTE-BYTES', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const resolved = await ref.retrieve!();
      expect(postRpcMock).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'resolveFileRef' }),
      );
      expect(fetchMock).toHaveBeenCalledWith('https://owner.example/blob/h-1');
      const chunks: Buffer[] = [];
      for await (const c of resolved.stream) chunks.push(Buffer.from(c as Buffer));
      expect(Buffer.concat(chunks).toString()).toBe('REMOTE-BYTES');
    } finally {
      global.fetch = realFetch;
    }
  });
});
