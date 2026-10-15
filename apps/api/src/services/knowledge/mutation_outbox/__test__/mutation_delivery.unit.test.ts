// A drained mutation event leaves knowledge exactly ONE way per deployment:
// the in-process subscriber (composed) or the team's registered webhooks
// (standalone). Delivering both for one outbox row is a double-fire — the same
// graph write reaching a listener twice — so these pin the mode as a choice,
// the default as composed, and an unrecognised value as a boot failure.

import { mutationDelivery } from '../delivery_mode';

const ROW = {
  id: 'outbox-1',
  team_id: 'team-1',
  event_type: 'node.created',
  payload: { event: 'node.created', data: { nodeId: 'n-1' } },
  attempts: 0,
};

const ENDPOINT = {
  id: 'endpoint-1',
  url: 'https://consumer.example/hooks/kg',
  event_types: [],
  secret: 'shh',
};

interface SetCall {
  table: string;
  values: Record<string, unknown>;
}

/** One double keyed by TABLE — the drainer reads two of them in one drain. */
function chainableQb(rowsByTable: Record<string, unknown[]>, setCalls: SetCall[]): object {
  let table = '';
  const builder: Record<string, unknown> = {};
  const enter = jest.fn((name: string) => {
    table = name;
    return builder;
  });
  Object.assign(builder, {
    selectFrom: enter,
    updateTable: enter,
    insertInto: enter,
    where: jest.fn(() => builder),
    select: jest.fn(() => builder),
    values: jest.fn(() => builder),
    onConflict: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    limit: jest.fn(() => builder),
    set: jest.fn((values: Record<string, unknown>) => {
      setCalls.push({ table, values });
      return builder;
    }),
    execute: jest.fn(async () => rowsByTable[table] ?? []),
    executeTakeFirst: jest.fn(async () => (rowsByTable[table] ?? [])[0]),
  });
  return builder;
}

interface Harness {
  drainOnce: typeof import('../worker').drainOnce;
  subscriber: jest.Mock;
  fetchMock: jest.Mock;
  setCalls: SetCall[];
}

async function loadWorker(options: {
  delivery?: string;
  /** Whether the composition root registered an in-process consumer. */
  subscribed?: boolean;
  endpoints?: unknown[];
}): Promise<Harness> {
  jest.resetModules();

  if (options.delivery === undefined) delete process.env.KNOWLEDGE_MUTATION_DELIVERY;
  else process.env.KNOWLEDGE_MUTATION_DELIVERY = options.delivery;

  const setCalls: SetCall[] = [];
  const qb = chainableQb(
    { mutation_outbox: [ROW], webhook_endpoint: options.endpoints ?? [ENDPOINT] },
    setCalls,
  );

  jest.doMock('movement-engine/services/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  jest.doMock('../../../../lib/kysely', () => ({ getKnowledgeQb: jest.fn(() => qb) }));

  const { drainOnce, registerLocalMutationSubscriber } = await import('../worker');

  const subscriber = jest.fn(async () => undefined);
  if (options.subscribed !== false) registerLocalMutationSubscriber(subscriber);

  const fetchMock = jest.fn(async () => new Response('ok', { status: 200 }));
  global.fetch = fetchMock as unknown as typeof fetch;

  return { drainOnce, subscriber, fetchMock, setCalls };
}

describe('choosing where a drained mutation event goes', () => {
  const REAL_FETCH = global.fetch;
  const REAL_DELIVERY = process.env.KNOWLEDGE_MUTATION_DELIVERY;

  afterEach(() => {
    global.fetch = REAL_FETCH;
    if (REAL_DELIVERY === undefined) delete process.env.KNOWLEDGE_MUTATION_DELIVERY;
    else process.env.KNOWLEDGE_MUTATION_DELIVERY = REAL_DELIVERY;
  });

  it('delivers in-process, and to nothing else, in the composed default', async () => {
    const h = await loadWorker({});

    expect(await h.drainOnce()).toEqual({ delivered: 1, failed: 0 });
    expect(h.subscriber).toHaveBeenCalledWith({ teamId: 'team-1', envelope: ROW.payload });
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.setCalls).toContainEqual(
      expect.objectContaining({
        table: 'mutation_outbox',
        values: expect.objectContaining({ delivered_at: expect.any(Date) }),
      }),
    );
  });

  it('posts to registered endpoints, and skips the subscriber, when standalone', async () => {
    const h = await loadWorker({ delivery: 'webhook' });

    expect(await h.drainOnce()).toEqual({ delivered: 1, failed: 0 });
    expect(h.subscriber).not.toHaveBeenCalled();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT.url);
    expect((init.headers as Record<string, string>)['X-Webhook-Signature']).toEqual(
      expect.any(String),
    );
  });

  // A consumer that never booted is a listener that will not fire. The row has
  // to stay pending and loud rather than be marked delivered into nowhere.
  it('fails the row when in-process delivery has nobody to deliver to', async () => {
    const h = await loadWorker({ subscribed: false });

    expect(await h.drainOnce()).toEqual({ delivered: 0, failed: 1 });
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.setCalls).toContainEqual(
      expect.objectContaining({
        table: 'mutation_outbox',
        values: expect.objectContaining({
          attempts: 1,
          last_error: expect.stringContaining('No local mutation subscriber'),
        }),
      }),
    );
  });
});

describe('reading the configured delivery path', () => {
  it('runs the composed in-process path unless told otherwise', () => {
    expect(mutationDelivery({})).toBe('local');
    expect(mutationDelivery({ KNOWLEDGE_MUTATION_DELIVERY: '' })).toBe('local');
    expect(mutationDelivery({ KNOWLEDGE_MUTATION_DELIVERY: 'local' })).toBe('local');
  });

  it('runs webhooks when asked', () => {
    expect(mutationDelivery({ KNOWLEDGE_MUTATION_DELIVERY: 'webhook' })).toBe('webhook');
  });

  it('refuses to guess at anything else', () => {
    expect(() => mutationDelivery({ KNOWLEDGE_MUTATION_DELIVERY: 'Webhook' })).toThrow(
      /must be "local" or "webhook"/,
    );
    expect(() => mutationDelivery({ KNOWLEDGE_MUTATION_DELIVERY: 'both' })).toThrow(/got "both"/);
  });
});
