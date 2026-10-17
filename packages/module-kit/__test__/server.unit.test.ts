// The protocol server kit, driven in process: a request body goes in, the
// envelope that comes out is asserted. Covers how a traversal is paged (the
// adapter's own pages vs a drained stream with its hard limit) and how
// `resolveFileRef` answers (a URL, or not at all).

import { Readable } from 'node:stream';

import { PROTOCOL_VERSION } from 'engine-contracts';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Adapter, GetRelatedInput, RelatedPage, RelatedResult } from 'movement-engine/public/adapter';

import { BASE_RUNTIME_CAPABILITIES, isFileValue } from 'movement-engine/public/adapter';
import { makeMetaPosition, makeStablePosition } from 'movement-engine/public/catalog';
import { AdapterBadRequestError, createAdapterProtocolHandler, DRAINED_PAGE_LIMIT } from '../server';

function baseAdapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    adapterType: 'paged_crm',
    supportedTriggers: [],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async () => null,
    getRelated: async () => [],
    createRecord: async () => {
      throw new Error('read-only');
    },
    updateRecord: async () => {
      throw new Error('read-only');
    },
    deleteRecord: async () => {
      throw new Error('read-only');
    },
    ...overrides,
  };
}

function related(n: number): RelatedResult {
  return {
    position: makeStablePosition({ adapterType: 'paged_crm', recordType: 'Company', recordId: `c${n}` }),
  };
}

const relatedInput = {
  position: makeMetaPosition('paged_crm'),
  fieldId: 'Company',
  direction: 'outgoing' as const,
};

/** POST one envelope at the handler; answer its HTTP status and body. */
async function rpc(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  method: string,
  params: unknown,
): Promise<{ status: number; body: { ok: boolean; result?: unknown; error?: { code: string; message: string; retryable?: boolean } } }> {
  const req = Object.assign(
    Readable.from([JSON.stringify({ protocolVersion: PROTOCOL_VERSION, method, cacheScopeId: 's', params })]),
    { headers: {} },
  ) as unknown as IncomingMessage;
  let status = 0;
  let payload = '';
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (body: string) => {
      payload = body;
    },
  } as unknown as ServerResponse;
  await handler(req, res);
  return { status, body: JSON.parse(payload) };
}

function ids(result: unknown): string[] {
  const { items } = result as { items: RelatedResult[] };
  return items.map((item) =>
    item.position.identity.kind === 'stable' ? item.position.identity.recordId : '?',
  );
}

describe('paged traversal: an adapter that pages natively', () => {
  const pages: Record<string, RelatedPage> = {
    start: { items: [related(1), related(2)], nextCursor: { after: 2 } },
    after2: { items: [related(3)] },
  };
  const seen: Array<{ input: GetRelatedInput; cursor: unknown }> = [];
  const adapter = baseAdapter({
    iterateRelatedPage: async (input, cursor) => {
      seen.push({ input, cursor });
      return cursor === undefined ? pages.start! : pages.after2!;
    },
    iterateRelated: () => {
      throw new Error('a native pager must not be drained');
    },
  });
  const handler = createAdapterProtocolHandler({ adapter });

  beforeEach(() => {
    seen.length = 0;
  });

  it('answers the adapter page and its opaque cursor, then the cursor comes back', async () => {
    const first = await rpc(handler, 'iterateRelatedPage', relatedInput);
    expect(first.body.ok).toBe(true);
    expect(ids(first.body.result)).toEqual(['c1', 'c2']);
    expect(first.body.result).toMatchObject({ nextCursor: { after: 2 } });

    const second = await rpc(handler, 'iterateRelatedPage', { ...relatedInput, cursor: { after: 2 } });
    expect(ids(second.body.result)).toEqual(['c3']);
    expect(second.body.result).not.toHaveProperty('nextCursor');

    // The cursor is the second argument in process, not part of the input.
    expect(seen.map((s) => s.cursor)).toEqual([undefined, { after: 2 }]);
    expect(seen[1]!.input).not.toHaveProperty('cursor');
    expect(seen[1]!.input).toMatchObject({ fieldId: 'Company', direction: 'outgoing' });
  });

  it('serves the v1 iterateRelated spelling from the same pages', async () => {
    const first = await rpc(handler, 'iterateRelated', relatedInput);
    expect(ids(first.body.result)).toEqual(['c1', 'c2']);
    expect(first.body.result).toMatchObject({ nextCursor: { after: 2 } });
  });

  it('advertises iterateRelatedPage', async () => {
    const manifest = await rpc(handler, 'manifest', {});
    expect((manifest.body.result as { methods: string[] }).methods).toContain('iterateRelatedPage');
  });
});

describe('paged traversal: an adapter that only streams', () => {
  function streamingAdapter(count: number): { adapter: Adapter; pulled: () => number } {
    let pulled = 0;
    const adapter = baseAdapter({
      async *iterateRelated() {
        for (let n = 1; n <= count; n++) {
          pulled++;
          yield related(n);
        }
      },
    });
    return { adapter, pulled: () => pulled };
  }

  it('drains a short stream into one page with no cursor and no warning', async () => {
    const warn = jest.fn();
    const { adapter } = streamingAdapter(3);
    const handler = createAdapterProtocolHandler({ adapter, warn });
    const page = await rpc(handler, 'iterateRelatedPage', relatedInput);
    expect(ids(page.body.result)).toEqual(['c1', 'c2', 'c3']);
    expect(page.body.result).not.toHaveProperty('nextCursor');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a stream exactly at the limit is whole: no warning', async () => {
    const warn = jest.fn();
    const { adapter } = streamingAdapter(DRAINED_PAGE_LIMIT);
    const handler = createAdapterProtocolHandler({ adapter, warn });
    const page = await rpc(handler, 'iterateRelatedPage', relatedInput);
    expect(ids(page.body.result)).toHaveLength(DRAINED_PAGE_LIMIT);
    expect(warn).not.toHaveBeenCalled();
  });

  it('cuts a longer stream at the limit, answers no cursor, and warns naming adapter and method', async () => {
    const warn = jest.fn();
    const { adapter, pulled } = streamingAdapter(DRAINED_PAGE_LIMIT + 50);
    const handler = createAdapterProtocolHandler({ adapter, warn });
    const page = await rpc(handler, 'iterateRelatedPage', relatedInput);
    expect(ids(page.body.result)).toHaveLength(DRAINED_PAGE_LIMIT);
    expect(page.body.result).not.toHaveProperty('nextCursor');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/paged_crm\.iterateRelatedPage/);
    expect(warn.mock.calls[0]![0]).toMatch(String(DRAINED_PAGE_LIMIT));
    // The stream is abandoned one past the limit, not read to its end.
    expect(pulled()).toBe(DRAINED_PAGE_LIMIT + 1);
  });

  it('an adapter with neither pager nor stream answers method_not_implemented', async () => {
    const handler = createAdapterProtocolHandler({ adapter: baseAdapter() });
    const page = await rpc(handler, 'iterateRelatedPage', relatedInput);
    expect(page.body).toMatchObject({ ok: false, error: { code: 'method_not_implemented' } });
  });
});

describe('resolveFileRef answers by URL', () => {
  const fileOwner = baseAdapter({
    resolveFileRef: async () => {
      throw new Error('the kit never streams bytes');
    },
  });
  const handler = createAdapterProtocolHandler({ adapter: fileOwner });

  it('answers the URL and content type a ref carries', async () => {
    const answer = await rpc(handler, 'resolveFileRef', {
      ref: { name: 'deck.pdf', contentType: 'application/pdf', url: 'https://files.example/deck.pdf' },
    });
    expect(answer.body).toEqual({
      ok: true,
      result: { url: 'https://files.example/deck.pdf', contentType: 'application/pdf' },
    });
  });

  it('a ref with no URL answers method_not_implemented', async () => {
    const answer = await rpc(handler, 'resolveFileRef', {
      ref: { name: 'deck.pdf', source: { ownerAdapterType: 'paged_crm', handle: 'h1' } },
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'method_not_implemented' } });
    expect(answer.body.error?.message).toMatch(/by URL/);
  });

  it('is advertised only by an adapter that owns files', async () => {
    const owner = await rpc(handler, 'manifest', {});
    expect((owner.body.result as { methods: string[] }).methods).toContain('resolveFileRef');
    const plain = await rpc(createAdapterProtocolHandler({ adapter: baseAdapter() }), 'manifest', {});
    expect((plain.body.result as { methods: string[] }).methods).not.toContain('resolveFileRef');
  });
});

describe('what an adapter throw answers', () => {
  it('a request the adapter refuses is bad_request, not retryable', async () => {
    const handler = createAdapterProtocolHandler({
      adapter: baseAdapter({
        iterateRelatedPage: async () => {
          throw new AdapterBadRequestError('unrecognised page cursor "x"');
        },
      }),
    });
    const { status, body } = await rpc(handler, 'iterateRelatedPage', { ...relatedInput, cursor: 'x' });
    expect(status).toBe(200);
    expect(body.error).toEqual({
      code: 'bad_request',
      message: 'iterateRelatedPage: unrecognised page cursor "x"',
      retryable: false,
    });
  });

  it('any other throw is adapter_error, retryable', async () => {
    const { body } = await rpc(
      createAdapterProtocolHandler({ adapter: baseAdapter() }),
      'createRecord',
      { recordType: 'Company', fields: {}, mutationContext: { source: {}, occurredAt: 'now' } },
    );
    expect(body.error).toEqual({ code: 'adapter_error', message: 'read-only', retryable: true });
  });
});

// The adapter receives the request's own params; the method's schema is only
// the gate. So every member the remote adapter sends must be one the schema
// accepts, or a well-formed call is refused as bad_request.
describe('every member the remote adapter sends passes the gate and reaches the adapter', () => {
  const received: Record<string, unknown> = {};
  const handler = createAdapterProtocolHandler({
    adapter: baseAdapter({
      getFieldValue: async (input) => {
        received.getFieldValue = input;
        return null;
      },
      getRelated: async (input) => {
        received.getRelated = input;
        return [];
      },
      async *iterateRelated(input) {
        received.iterateRelated = input;
      },
      createRecord: async (input) => {
        received.createRecord = input;
        return { adapterType: 'paged_crm', externalId: 'c-1', recordType: 'Company', data: {} };
      },
    }),
  });
  const company = makeStablePosition({ adapterType: 'paged_crm', recordType: 'Company', recordId: 'c-7' });

  it('the pushdown hints reach the adapter on both edge reads', async () => {
    const hints = {
      where: { kind: 'literal', value: true },
      orderBy: { fieldId: 'Name', direction: 'desc' },
      limit: 2,
      nativeFilter: { q: 'acme' },
    };
    for (const method of ['getRelated', 'iterateRelated'] as const) {
      const input = { position: company, fieldId: 'People', direction: 'outgoing', ...hints };
      expect((await rpc(handler, method, input)).body).toMatchObject({ ok: true });
      expect(received[method]).toEqual(input);
    }
  });

  it('a position from a resources traversal is accepted with its provenance', async () => {
    const resourceNode = {
      adapterType: 'paged_crm',
      recordType: 'Company',
      identity: { kind: 'unstable', data: {} },
      originRef: { kind: 'resource', resourceId: 'r-1', nodeId: 'n-1' },
      evidence: { Name: { quote: 'Acme' } },
      resources: [
        {
          id: 'r-1',
          type: 'FILE',
          fileRef: { __brand: 'FileRef', name: 'deck.pdf', url: 'https://example.test/f' },
        },
      ],
    };
    expect((await rpc(handler, 'getFieldValue', { position: resourceNode, fieldId: 'Name' })).body).toMatchObject({
      ok: true,
    });
    expect(received.getFieldValue).toEqual({ position: resourceNode, fieldId: 'Name' });
  });

  it("a position's resources pass with the host's own file descriptors, which the remote adapter echoes unchanged", async () => {
    const extracted = {
      adapterType: 'paged_crm',
      recordType: 'Company',
      identity: { kind: 'unstable', data: {} },
      originRef: { kind: 'extract', extractStepId: 'x-1', nodeId: 'n-2' },
      resources: [
        {
          id: 'r-2',
          type: 'FILE',
          url: null,
          fileRef: {
            __brand: 'FileRef',
            name: 'deck.pdf',
            source: { adapterType: 'email', credentialId: 'cred-1', handle: 'att-1' },
            url: null,
          },
        },
      ],
    };
    expect((await rpc(handler, 'getFieldValue', { position: extracted, fieldId: 'Name' })).body).toMatchObject({
      ok: true,
    });
    expect(received.getFieldValue).toEqual({ position: extracted, fieldId: 'Name' });
  });

  it("a write's parent link keeps the parent's own payload", async () => {
    const write = {
      recordType: 'Company',
      fields: { Name: 'Acme' },
      evidence: { Name: { quote: 'Acme' } },
      mutationContext: { source: {}, occurredAt: '2026-10-11T00:00:00.000Z' },
      parentLinks: [{ recordType: 'Person', externalId: 'p-1', edgeName: 'People', data: { ts: '1' } }],
    };
    expect((await rpc(handler, 'createRecord', write)).body).toMatchObject({ ok: true });
    expect(received.createRecord).toEqual(write);
  });

  it('a body the method schema refuses is a non-retryable bad_request', async () => {
    const { status, body } = await rpc(handler, 'getRelated', { position: company });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, error: { code: 'bad_request', retryable: false } });
  });
});

describe("a write's files are what the adapter's own catalog declares", () => {
  const received: unknown[] = [];
  const handler = createAdapterProtocolHandler({
    adapter: baseAdapter({
      describe: async (typeId) =>
        typeId === 'Doc'
          ? {
              typeId: 'Doc',
              displayName: 'Doc',
              fields: [
                { fieldId: 'deck', displayName: 'Deck', kind: 'file', writable: true, required: false },
                { fieldId: 'meta', displayName: 'Meta', kind: 'json', writable: true, required: false },
              ],
              references: [],
            }
          : null,
      createRecord: async (input) => {
        received.push(input);
        return { adapterType: 'paged_crm', externalId: 'd-1', recordType: 'Doc', data: {} };
      },
    }),
  });
  const spelled = { __brand: 'FileRef', name: 'deck.pdf', url: 'https://example.test/f' };

  it('a declared file field holds a file; the same descriptor anywhere else is data', async () => {
    const write = {
      recordType: 'Doc',
      fields: { deck: spelled, meta: spelled },
      mutationContext: { source: {}, occurredAt: '2026-10-11T00:00:00.000Z' },
    };
    expect((await rpc(handler, 'createRecord', write)).body).toMatchObject({ ok: true });
    const { fields } = received[0] as { fields: { deck: unknown; meta: unknown } };
    expect(isFileValue(fields.deck)).toBe(true);
    expect(fields.deck).toEqual(spelled);
    expect(isFileValue(fields.meta)).toBe(false);
    expect(fields.meta).toEqual(spelled);
  });
});
