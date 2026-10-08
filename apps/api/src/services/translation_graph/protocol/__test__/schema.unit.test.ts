import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Adapter } from '../../adapter';
import { BASE_RUNTIME_CAPABILITIES } from '../../adapter';
import { createAdapterProtocolHandler } from '../server';
import {
  MANIFEST_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  RpcRequest,
  RpcError,
  RpcResponse,
  RelatedPage,
  WireResource,
  WireSourcePosition,
  WireLandedRecordPosition,
  WireTriggerEvent,
  WireRelatedResult,
  WireEdgesFromResult,
  WireActorCandidate,
  WireFileRef,
  WireResolveEntityResult,
  METHODS,
} from 'engine-contracts';

// A representative source position — the wire mirror of `SourcePosition`.
const samplePosition = {
  adapterType: 'remote-email',
  recordType: 'email:message',
  identity: { kind: 'unstable', data: { from: 'h@x.com', subject: 'hi' } },
};

describe('protocol envelope', () => {
  it('PROTOCOL_VERSION is the string "2"; the manifest field is the number 2', () => {
    expect(PROTOCOL_VERSION).toBe('2');
    expect(MANIFEST_PROTOCOL_VERSION).toBe(2);
  });

  it('RpcRequest round-trips a well-formed request', () => {
    const req = {
      protocolVersion: PROTOCOL_VERSION,
      method: 'describe',
      cacheScopeId: 'scope-123',
      params: { typeId: 'email:message' },
    };
    expect(RpcRequest.parse(req)).toEqual(req);
  });

  it('RpcRequest rejects a request missing the method', () => {
    expect(() =>
      RpcRequest.parse({
        protocolVersion: '1',
        cacheScopeId: 'scope-123',
        params: {},
      }),
    ).toThrow();
  });

  it('RpcResponse accepts the ok:true branch', () => {
    const ok = { ok: true, result: { typeId: 'x' } };
    const parsed = RpcResponse.parse(ok);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result).toEqual({ typeId: 'x' });
  });

  it('RpcResponse accepts the ok:false branch with a structured error', () => {
    const err = {
      ok: false,
      error: { code: 'method_not_implemented', message: 'nope', retryable: false },
    };
    const parsed = RpcResponse.parse(err);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('method_not_implemented');
  });

  it('RpcResponse rejects a body missing the discriminator', () => {
    expect(() => RpcResponse.parse({ result: {} })).toThrow();
  });

  it('RpcError validates the error shape', () => {
    expect(() =>
      RpcError.parse({ code: 'x', message: 'y', retryable: 'not-a-bool' }),
    ).toThrow();
  });
});

describe('streaming page shapes', () => {
  it('RelatedPage round-trips with a nextCursor', () => {
    const page = {
      items: [{ position: samplePosition, edgeId: 'edge-1' }],
      nextCursor: { offset: 50 },
    };
    expect(RelatedPage.parse(page)).toEqual(page);
  });

  it('RelatedPage round-trips without a nextCursor', () => {
    const page = { items: [{ position: samplePosition }] };
    expect(RelatedPage.parse(page)).toEqual(page);
  });
});

describe('wire DTOs', () => {
  it('WireResource accepts a plain-string id (not a branded ResourceId)', () => {
    const resource = {
      id: 'a-plain-string-id',
      externalId: 'slack-ts-123',
      type: 'FILE',
      name: 'report.pdf',
      url: 'https://x/report.pdf',
    };
    expect(WireResource.parse(resource)).toEqual(resource);
  });

  it('WireResource is valid with no id at all', () => {
    expect(WireResource.parse({ name: 'inline text' })).toEqual({ name: 'inline text' });
  });

  it('WireSourcePosition round-trips a stable position', () => {
    const pos = {
      adapterType: 'attio',
      recordType: 'attio:companies',
      identity: { kind: 'stable', recordId: 'rec-1', data: { name: 'Acme' } },
    };
    expect(WireSourcePosition.parse(pos)).toEqual(pos);
  });

  it('WireTriggerEvent round-trips a minimal event', () => {
    const event = {
      pipelineInputId: 'pi-1',
      adapterType: 'remote-email',
      triggerType: 'webhook',
      payload: null,
    };
    expect(WireTriggerEvent.parse(event)).toEqual(event);
  });

  it('WireRelatedResult requires a position', () => {
    expect(() => WireRelatedResult.parse({ edgeId: 'e' })).toThrow();
    expect(WireRelatedResult.parse({ position: samplePosition })).toEqual({
      position: samplePosition,
    });
  });

  it('WireSourcePosition still tolerates a null recordType (request-side echo)', () => {
    const pos = {
      adapterType: 'attio',
      recordType: null,
      identity: { kind: 'unstable', data: {} },
    };
    expect(WireSourcePosition.parse(pos)).toEqual(pos);
  });

  it('WireLandedRecordPosition rejects a null recordType', () => {
    const pos = {
      adapterType: 'attio',
      recordType: null,
      identity: { kind: 'unstable', data: {} },
    };
    expect(() => WireLandedRecordPosition.parse(pos)).toThrow(/must name its type/);
  });

  it('WireRelatedResult (a getRelated/iterateRelated traversal result) rejects a typeless position', () => {
    const typeless = { ...samplePosition, recordType: null };
    expect(() => WireRelatedResult.parse({ position: typeless })).toThrow(/must name its type/);
  });

  it('WireEdgesFromResult rejects a typeless targetPosition', () => {
    const descriptor = {
      typeId: 'email:message',
      displayName: 'Email Message',
      fields: [],
      references: [],
    };
    expect(
      WireEdgesFromResult.parse({
        descriptor,
        targetPositions: { attachments: samplePosition },
      }),
    ).toEqual({ descriptor, targetPositions: { attachments: samplePosition } });
    expect(() =>
      WireEdgesFromResult.parse({
        descriptor,
        targetPositions: { attachments: { ...samplePosition, recordType: null } },
      }),
    ).toThrow(/must name its type/);
  });

  it('WireActorCandidate validates the source tag', () => {
    const candidate = {
      identity: { identifier: 'h@x.com', scheme: 'email', email: 'h@x.com' },
      source: 'originator',
    };
    expect(WireActorCandidate.parse(candidate)).toEqual(candidate);
    expect(() =>
      WireActorCandidate.parse({ ...candidate, source: 'terminal' }),
    ).toThrow();
  });
});

describe('METHODS registry', () => {
  it('covers the full protocol catalog', () => {
    const expected = [
      'manifest',
      'listEntryPoints',
      'describe',
      'edgesFrom',
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
      'resolveAwait',
      'wakeKeys',
      'iterateRelatedPage',
    ];
    expect(Object.keys(METHODS).sort()).toEqual([...expected].sort());
  });

  it('every entry exposes a params + result zod schema', () => {
    for (const [name, def] of Object.entries(METHODS)) {
      expect(typeof def.params.parse).toBe('function');
      expect(typeof def.result.parse).toBe('function');
      // sanity: the names are non-empty
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('manifest: params {} → { adapterType, supportedTriggers, runtimeCapabilities, methods }', () => {
    expect(METHODS.manifest.params.parse({})).toEqual({});
    const result = {
      protocolVersion: 2,
      adapterType: 'remote-email',
      supportedTriggers: ['snapshot', 'webhook'],
      runtimeCapabilities: {
        traversal: { incoming: false, edgeProperties: false },
        resources: false,
      },
      methods: ['listEntryPoints', 'describe', 'getRelated', 'getActorCandidates'],
    };
    // webhookEventTypeId is optional → a manifest without it round-trips.
    expect(METHODS.manifest.result.parse(result)).toEqual(result);
  });

  it('manifest: result carries the optional webhookEventTypeId config', () => {
    const result = {
      protocolVersion: 2,
      adapterType: 'remote-attio',
      supportedTriggers: ['webhook'],
      runtimeCapabilities: {
        traversal: { incoming: false, edgeProperties: false },
        resources: true,
      },
      methods: ['listEntryPoints', 'describe', 'getActorCandidates'],
      webhookEventTypeId: 'remote-attio:webhook_event',
    };
    expect(METHODS.manifest.result.parse(result)).toEqual(result);
  });

  it('manifest: result rejects a payload missing the methods array', () => {
    expect(() =>
      METHODS.manifest.result.parse({
        protocolVersion: 2,
        adapterType: 'remote-email',
        supportedTriggers: [],
        runtimeCapabilities: {
          traversal: { incoming: false, edgeProperties: false },
          resources: false,
        },
      }),
    ).toThrow();
  });

  it('manifest: result refuses a missing or older protocolVersion, naming the field', () => {
    const v2 = {
      protocolVersion: 2,
      adapterType: 'remote-email',
      supportedTriggers: [],
      runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
      methods: [],
    };
    const { protocolVersion: _omit, ...unversioned } = v2;
    expect(() => METHODS.manifest.result.parse(unversioned)).toThrow(/protocolVersion: expected 2/);
    expect(() => METHODS.manifest.result.parse({ ...v2, protocolVersion: 1 })).toThrow(
      /protocolVersion: expected 2, got 1/,
    );
  });

  it('describe: params { typeId } → descriptor | null', () => {
    expect(METHODS.describe.params.parse({ typeId: 'email:message' })).toEqual({
      typeId: 'email:message',
    });
    expect(METHODS.describe.result.parse(null)).toBeNull();
    const descriptor = {
      typeId: 'email:message',
      displayName: 'Email Message',
      fields: [],
      references: [],
    };
    expect(METHODS.describe.result.parse(descriptor)).toEqual(descriptor);
  });

  it('getRelated: input has no fetchCache field', () => {
    const input = { position: samplePosition, fieldId: 'attachments', direction: 'outgoing' };
    const parsed = METHODS.getRelated.params.parse({ ...input, fetchCache: { x: 1 } }) as Record<
      string,
      unknown
    >;
    expect(parsed).not.toHaveProperty('fetchCache');
  });

  it('iterateRelated: result is a RelatedPage', () => {
    const page = { items: [{ position: samplePosition }], nextCursor: 'c' };
    expect(METHODS.iterateRelated.result.parse(page)).toEqual(page);
  });

  it('getFieldValue: result is opaque (any value passes)', () => {
    expect(METHODS.getFieldValue.result.parse('a string')).toBe('a string');
    expect(METHODS.getFieldValue.result.parse(42)).toBe(42);
    expect(METHODS.getFieldValue.result.parse(null)).toBeNull();
  });

  it('createRecord: result is the ExternalRecordRef currency', () => {
    // Missing the required adapterType + externalId.
    expect(() => METHODS.createRecord.result.parse({ data: {} })).toThrow();
    const result = { adapterType: 'attio', externalId: 'new-rec-1', data: { name: 'Acme' } };
    expect(METHODS.createRecord.result.parse(result)).toEqual(result);
  });

  it('resolveEntity: result carries a flat candidates array', () => {
    const result = {
      candidates: [{ adapterType: 'attio', externalId: 'n1', data: { name: 'Acme' } }],
    };
    expect(METHODS.resolveEntity.result.parse(result)).toEqual(result);
  });

  it('getActorCandidates: result is an array of candidates', () => {
    const result = [
      { identity: { identifier: 'h@x.com', scheme: 'email' }, source: 'originator' },
    ];
    expect(METHODS.getActorCandidates.result.parse(result)).toEqual(result);
  });

  it('WireFileRef: round-trips a source-bearing ref (the remote handle)', () => {
    const sourceRef = {
      name: 'doc.pdf',
      contentType: 'application/pdf',
      size: 1234,
      source: { ownerAdapterType: 'email', handle: 'att-1' },
    };
    expect(WireFileRef.parse(sourceRef)).toEqual(sourceRef);
  });

  it('resolveFileRef: params { ref } and result { url, contentType? } round-trip', () => {
    const params = { ref: { name: 'd.pdf', source: { ownerAdapterType: 'email', handle: 'h' } } };
    expect(METHODS.resolveFileRef.params.parse(params)).toEqual(params);

    const result = { url: 'https://owner.example/blob', contentType: 'application/pdf' };
    expect(METHODS.resolveFileRef.result.parse(result)).toEqual(result);
    // contentType is optional.
    expect(METHODS.resolveFileRef.result.parse({ url: 'https://x/y' })).toEqual({ url: 'https://x/y' });
    // url is required.
    expect(() => METHODS.resolveFileRef.result.parse({})).toThrow();
  });
});

describe('v2 methods', () => {
  const mutationContext = { source: { adapterType: 'kg' }, occurredAt: '2026-10-07T00:00:00Z' };
  const link = {
    from: { recordType: 'Contact', externalId: 'c1' },
    edgeName: 'Company',
    to: { recordType: 'Company', externalId: 'co1' },
    mutationContext,
  };

  it('linkRecords / unlinkRecords: the Adapter interface shapes', () => {
    expect(METHODS.linkRecords.params.parse(link)).toEqual(link);
    expect(METHODS.unlinkRecords.params.parse(link)).toEqual(link);
    expect(METHODS.linkRecords.result.parse({ created: true })).toEqual({ created: true });
    expect(METHODS.unlinkRecords.result.parse({ removed: false })).toEqual({ removed: false });
    expect(() => METHODS.linkRecords.params.parse({ ...link, edgeName: undefined })).toThrow();
  });

  it('ensureEventSubscription / removeEventSubscription', () => {
    const ensure = {
      events: ['record.created'],
      callbackUrl: 'https://host.example/hook/1',
      current: { externalId: 'wh-1', events: [] },
      scope: { base: 'b1' },
    };
    expect(METHODS.ensureEventSubscription.params.parse(ensure)).toEqual(ensure);
    expect(METHODS.ensureEventSubscription.result.parse({ externalId: 'wh-2', secret: 's' })).toEqual({
      externalId: 'wh-2',
      secret: 's',
    });
    // null: the documented "nothing registered" no-op.
    expect(METHODS.ensureEventSubscription.result.parse(null)).toBeNull();
    const remove = { callbackUrl: 'https://host.example/hook/1', externalId: 'wh-1' };
    expect(METHODS.removeEventSubscription.params.parse(remove)).toEqual(remove);
    expect(METHODS.removeEventSubscription.result.parse(null)).toBeNull();
  });

  it('resolveAwait: pending and landed both carry a correlation key; empty is bare', () => {
    const point = { recordId: 'ask-1', edge: 'Response', headData: { channel: 'C1' } };
    expect(METHODS.resolveAwait.params.parse(point)).toEqual(point);
    const pending = { status: 'pending', correlationKey: 'C1:123.4' };
    expect(METHODS.resolveAwait.result.parse(pending)).toEqual(pending);
    expect(() => METHODS.resolveAwait.result.parse({ status: 'pending' })).toThrow();
    // The key to keep waiting on, for landings that all fail the await's WHERE.
    const landed = {
      status: 'landed',
      correlationKey: 'C1:1.2',
      landings: [{ recordId: 'r1', recordType: 'Response', fields: { Answer: 'yes' } }],
    };
    expect(METHODS.resolveAwait.result.parse(landed)).toEqual(landed);
    const { correlationKey: _key, ...keyless } = landed;
    expect(() => METHODS.resolveAwait.result.parse(keyless)).toThrow();
    expect(METHODS.resolveAwait.result.parse({ status: 'empty' })).toEqual({ status: 'empty' });
  });

  it('wakeKeys: { raw } → string[]', () => {
    expect(METHODS.wakeKeys.params.parse({ raw: { any: 'thing' } })).toEqual({ raw: { any: 'thing' } });
    expect(METHODS.wakeKeys.result.parse(['C1:123.4'])).toEqual(['C1:123.4']);
    expect(() => METHODS.wakeKeys.result.parse([1])).toThrow();
  });

  it('iterateRelatedPage: GetRelatedInput + cursor → a RelatedPage', () => {
    const params = { position: samplePosition, fieldId: 'attachments', direction: 'outgoing', cursor: 'c1' };
    expect(METHODS.iterateRelatedPage.params.parse(params)).toEqual(params);
    const page = { items: [{ position: samplePosition }], nextCursor: 'c2' };
    expect(METHODS.iterateRelatedPage.result.parse(page)).toEqual(page);
  });
});

describe('protocol server: the boundary checks', () => {
  const describeCalls: unknown[] = [];
  const adapter: Adapter = {
    adapterType: 'probe',
    supportedTriggers: [],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [],
    describe: async (typeId: string) => {
      describeCalls.push(typeId);
      return null;
    },
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async () => null,
    getRelated: async () => [],
    createRecord: async () => {
      throw new Error('not a target');
    },
    updateRecord: async () => {
      throw new Error('not a target');
    },
    deleteRecord: async () => {
      throw new Error('not a target');
    },
  };

  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const handler = createAdapterProtocolHandler({ adapter });
    server = http.createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    describeCalls.length = 0;
  });

  async function rpc(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cacheScopeId: 's', ...body }),
    });
    return { status: res.status, body: await res.json() };
  }

  it('refuses any protocol version but 2, in the envelope', async () => {
    for (const protocolVersion of ['1', '3']) {
      const res = await rpc({ protocolVersion, method: 'describe', params: { typeId: 'Contact' } });
      expect(res).toEqual({
        status: 200,
        body: {
          ok: false,
          error: { code: 'protocol_version', message: 'expected protocol version 2', retryable: false },
        },
      });
    }
    expect(describeCalls).toEqual([]);
  });

  it('answers a bad param with bad_request naming the method and the path, without dispatching', async () => {
    const res = await rpc({ protocolVersion: '2', method: 'describe', params: { typeId: 7 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      error: { code: 'bad_request', retryable: false, message: expect.stringMatching(/^describe: typeId: /) },
    });
    expect(describeCalls).toEqual([]);

    const nested = await rpc({
      protocolVersion: '2',
      method: 'getRelated',
      params: { position: { adapterType: 'probe', recordType: 'Contact' }, fieldId: 'Company', direction: 'outgoing' },
    });
    expect(nested.body).toMatchObject({
      ok: false,
      error: { code: 'bad_request', message: expect.stringMatching(/^getRelated: position\.identity: /) },
    });
  });

  it('dispatches valid params, and advertises protocolVersion 2 in the manifest', async () => {
    const res = await rpc({ protocolVersion: '2', method: 'describe', params: { typeId: 'Contact' } });
    expect(res.body).toEqual({ ok: true, result: null });
    expect(describeCalls).toEqual(['Contact']);

    const manifest = await rpc({ protocolVersion: '2', method: 'manifest', params: {} });
    expect(manifest.body).toMatchObject({ ok: true, result: { protocolVersion: 2, adapterType: 'probe' } });
  });

  it('a prototype key is an unknown method, not a dispatch', async () => {
    const res = await rpc({ protocolVersion: '2', method: 'toString', params: {} });
    expect(res.body).toMatchObject({ ok: false, error: { code: 'method_not_implemented' } });
  });
});

describe('WireResolveEntityResult (tolerant of a bare candidates array)', () => {
  const ref = { adapterType: 'acme_crm', externalId: 'c_1', data: {} };

  it('accepts the canonical { candidates: [...] } object form', () => {
    expect(WireResolveEntityResult.parse({ candidates: [ref] })).toEqual({
      candidates: [ref],
    });
  });

  it('coerces a bare empty array to { candidates: [] }', () => {
    // The handbook historically told authors they "may always return []" — a
    // bare array must not crash the write path with "expected object, received
    // array". Coerce it to the canonical object form.
    expect(WireResolveEntityResult.parse([])).toEqual({ candidates: [] });
  });

  it('coerces a bare candidates array to { candidates: [...] }', () => {
    expect(WireResolveEntityResult.parse([ref])).toEqual({ candidates: [ref] });
  });
});
