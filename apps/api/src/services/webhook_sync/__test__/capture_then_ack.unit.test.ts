// The webhook_sync door is capture-then-ack: everything up to the durable
// receipt runs inside the request, the door queues a work row per receipt and
// await wake before its 200, and the movement runs when the row drains. These
// pin the split at the handler seam —
//
//   phase 1 (handleInboundWebhook): signature → preprocessInbound → trigger
//                      matching → receipt store → pull-cursor advance
//   phase 2 (enqueueDeferred): linked-object refresh → wake_await rows →
//                      dispatch_event rows
//
// with the two properties that make it safe: the cursor only advances over
// RECEIPTED events, and a phase-2 failure is per-event data, never a rejected
// delivery. Fully mocked — no DB, no adapters, no engine.

import type { DiscriminableEvent } from '../../translation_graph/adapter';

interface Harness {
  handleInboundWebhook: typeof import('../handler').handleInboundWebhook;
  captureDiscriminableEvent: jest.Mock;
  enqueueCapturedEvents: jest.Mock;
  readReceiptGroupOutcomes: jest.Mock;
  enqueueAwaitWake: jest.Mock;
  notifyWork: jest.Mock;
  findTriggersByKind: jest.Mock;
  preprocessInbound: jest.Mock;
  handleTelegramCallbackQuery: jest.Mock;
  handleWhatsappInteractiveReplies: jest.Mock;
  qbSetCalls: Array<Record<string, unknown>>;
}

const SUBSCRIPTION = {
  id: 'sub-1',
  team_id: 'team-1',
  provider: 'ATTIO',
  credentials_id: 'cred-1',
  webhook_secret: 'shh',
  external_webhook_id: 'ext-1',
  inbound_checkpoint: null,
};

// One double, keyed by TABLE rather than by which accessor asked. Both the
// subscription and the automations tables answer through the same builder now
// that the vault and its subscriptions live in `automations` — a double that
// branched on the accessor answered the wrong table the moment one moved.
function chainableQb(
  rowsByTable: Record<string, unknown>,
  setCalls: Array<Record<string, unknown>>,
): object {
  let table = '';
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    selectFrom: jest.fn((name: string) => {
      table = name;
      return builder;
    }),
    updateTable: jest.fn((name: string) => {
      table = name;
      return builder;
    }),
    where: jest.fn(() => builder),
    select: jest.fn(() => builder),
    selectAll: jest.fn(() => builder),
    set: jest.fn((values: Record<string, unknown>) => {
      setCalls.push(values);
      return builder;
    }),
    execute: jest.fn(async () => []),
    executeTakeFirst: jest.fn(async () => rowsByTable[table]),
  });
  return builder;
}

/** The shared outcome reader, over an in-memory receipt-failure map. */
function fakeReadReceiptGroupOutcomes(failedById: () => Map<string, string>) {
  return jest.fn(
    async (input: { groups: { group: unknown; receipts: { storedEventId?: string }[] }[] }) => {
      const failedMap = failedById();
      const cleared: unknown[] = [];
      const failed: { group: unknown; error: string }[] = [];
      for (const { group, receipts } of input.groups) {
        const error = receipts
          .map((r) => (r.storedEventId !== undefined ? failedMap.get(r.storedEventId) : undefined))
          .find((e) => e !== undefined);
        if (error === undefined) cleared.push(group);
        else failed.push({ group, error });
      }
      return { cleared, failed };
    },
  );
}

async function loadHandler(options: {
  events: DiscriminableEvent[];
  provider?: string;
  adapterType?: string;
  harnessTeam?: boolean;
  checkpoint?: unknown;
  triggers?: unknown[];
  onEnqueue?: jest.Mock;
  /** Receipt id → failure reason, as the drained receipts would read back. */
  failedReceipts?: Record<string, string>;
  /** Whether the raw delivery reads as a Telegram button tap the answer door
   *  owns (the branch that short-circuits the raw→events seam). */
  askCallback?: boolean;
  /** Whether the raw delivery reads as carrying a WhatsApp callback-id tap
   *  (the branch that does NOT short-circuit — see the WhatsApp describe
   *  block below). */
  waCallback?: boolean;
}): Promise<Harness> {
  jest.resetModules();

  const qbSetCalls: Array<Record<string, unknown>> = [];
  const qb = chainableQb(
    { webhook_subscription: { ...SUBSCRIPTION, provider: options.provider ?? 'ATTIO' } },
    qbSetCalls,
  );
  const knowledgeQb = chainableQb({}, []);

  jest.doMock('../../logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  jest.doMock('../../../lib/kysely', () => ({
    getQb: jest.fn(() => qb),
    getCoreQb: jest.fn(() => qb),
    getKnowledgeQb: jest.fn(() => knowledgeQb),
    getAutomationsQb: jest.fn(() => qb),
  }));
  jest.doMock('../providers', () => ({
    getWebhookProvider: jest.fn(() => ({ verifySignature: jest.fn(() => true) })),
  }));
  jest.doMock('../../../lib/credentials', () => ({ decryptToken: jest.fn() }));
  jest.doMock('../../../adapters/attio/apiClient', () => ({
    AttioAPIClient: jest.fn(),
    attioCredsParser: { parse: jest.fn() },
  }));
  jest.doMock('../../knowledge_pipeline/output_v3/adapters/attio', () => ({
    buildRecordData: jest.fn(),
  }));
  jest.doMock('../../knowledge_pipeline/output_v3/linked_objects', () => ({
    normalizeAdapterType: (p: string) => p.toLowerCase(),
  }));
  jest.doMock('../../translation_graph/adapters/attio', () => ({ ATTIO_ADAPTER_TYPE: 'attio' }));
  jest.doMock('../../translation_graph/adapters/slack', () => ({ SLACK_ADAPTER_TYPE: 'slack' }));
  jest.doMock('../../translation_graph/adapters/telegram', () => ({
    TELEGRAM_ADAPTER_TYPE: 'telegram',
    TelegramAdapter: class {
      constructor(
        public readonly teamId: string,
        public readonly credentialsId?: string,
      ) {}
    },
  }));
  jest.doMock('../telegram_callback_door', () => ({
    ownsCallbackQuery: jest.fn(() => options.askCallback === true),
    handleTelegramCallbackQuery: jest.fn(async () => ({ handled: true, outcome: 'answered' })),
  }));
  jest.doMock('../../translation_graph/adapters/whatsapp', () => ({
    WHATSAPP_ADAPTER_TYPE: 'whatsapp',
  }));
  jest.doMock('../whatsapp_callback_door', () => ({
    ownsWhatsappInteractiveReply: jest.fn(() => options.waCallback === true),
    handleWhatsappInteractiveReplies: jest.fn(async () => [{ replyId: 'cb_abc', outcome: 'recorded' }]),
    defaultWhatsappCallbackResponder: jest.fn(() => ({ sendReply: jest.fn(async () => {}) })),
  }));
  jest.doMock('../../../lib/recording', () => ({
    isTestHarnessTeam: jest.fn(() => options.harnessTeam === true),
    injectFakeBaseUrl: jest.fn((c: unknown) => c),
  }));
  jest.doMock('../../translation_graph/adapters/registry', () => ({
    hasAdapter: jest.fn(() => true),
    resolveAdapterSlug: jest.fn(() => options.adapterType ?? 'attio'),
  }));
  const preprocessInbound = jest.fn(async () => ({
    events: options.events,
    ...(options.checkpoint !== undefined ? { checkpoint: options.checkpoint } : {}),
  }));
  jest.doMock('../../translation_graph/adapters/resolve', () => ({
    resolveAdapter: jest.fn(async () => ({
      preprocessInbound,
      listEventTypes: jest.fn(async () => []),
    })),
  }));
  jest.doMock('../../translation_graph/storage/tg_table', () => ({
    findTriggersByKind: jest.fn(async () =>
      options.triggers ?? [{ id: 'trig-1', movementId: 'movement-1', credentialsId: null, config: {} }],
    ),
  }));
  jest.doMock('../../movement_engine/await_resume', () => ({
    enqueueAwaitWake: jest.fn(async () => undefined),
  }));
  jest.doMock('../../work/drain', () => ({ notifyWork: jest.fn() }));
  jest.doMock('../../translation_graph/triggers/dispatch_event', () => ({
    captureDiscriminableEvent: jest.fn(async (input: { event: DiscriminableEvent }) => ({
      triggerId: 'trig-1',
      teamId: 'team-1',
      triggerEvent: { payload: input.event.payload },
      storedEventId: `evt-${(input.event.payload as { n?: number }).n ?? 0}`,
      duplicate: false,
    })),
    enqueueCapturedEvents: options.onEnqueue ?? jest.fn(async () => undefined),
    readReceiptGroupOutcomes: fakeReadReceiptGroupOutcomes(
      () => new Map(Object.entries(options.failedReceipts ?? {})),
    ),
  }));

  const { handleInboundWebhook } = await import('../handler');
  const dispatchMod = jest.requireMock('../../translation_graph/triggers/dispatch_event') as {
    captureDiscriminableEvent: jest.Mock;
    enqueueCapturedEvents: jest.Mock;
    readReceiptGroupOutcomes: jest.Mock;
  };
  const awaitMod = jest.requireMock('../../movement_engine/await_resume') as {
    enqueueAwaitWake: jest.Mock;
  };
  const drainMod = jest.requireMock('../../work/drain') as { notifyWork: jest.Mock };
  const tgTable = jest.requireMock('../../translation_graph/storage/tg_table') as {
    findTriggersByKind: jest.Mock;
  };
  const callbackDoor = jest.requireMock('../telegram_callback_door') as {
    handleTelegramCallbackQuery: jest.Mock;
  };
  const waCallbackDoor = jest.requireMock('../whatsapp_callback_door') as {
    handleWhatsappInteractiveReplies: jest.Mock;
  };

  return {
    handleInboundWebhook,
    captureDiscriminableEvent: dispatchMod.captureDiscriminableEvent,
    enqueueCapturedEvents: dispatchMod.enqueueCapturedEvents,
    readReceiptGroupOutcomes: dispatchMod.readReceiptGroupOutcomes,
    enqueueAwaitWake: awaitMod.enqueueAwaitWake,
    notifyWork: drainMod.notifyWork,
    findTriggersByKind: tgTable.findTriggersByKind,
    preprocessInbound,
    handleTelegramCallbackQuery: callbackDoor.handleTelegramCallbackQuery,
    handleWhatsappInteractiveReplies: waCallbackDoor.handleWhatsappInteractiveReplies,
    qbSetCalls,
  };
}

function deliver(h: Harness, provider = 'ATTIO') {
  return h.handleInboundWebhook({
    provider,
    subscriptionId: 'sub-1',
    rawBody: Buffer.from('{}'),
    signatureHeader: 'sig',
  });
}

const SETTLED = { unsettledTeamIds: new Set<string>(), unsettledError: 'not settled within 30s' };

const EVENT_A: DiscriminableEvent = { payload: { n: 1 } } as DiscriminableEvent;
const EVENT_B: DiscriminableEvent = { payload: { n: 2 } } as DiscriminableEvent;

describe('handleInboundWebhook — phase 1 ends at the receipt', () => {
  it('stores a receipt per event and queues NOTHING until the door asks', async () => {
    const h = await loadHandler({ events: [EVENT_A, EVENT_B] });

    const result = await deliver(h);

    expect(result.ok).toBe(true);
    // `eventsProcessed` now means CAPTURED — what the ack is answering for.
    expect(result.eventsProcessed).toBe(2);
    expect(h.captureDiscriminableEvent).toHaveBeenCalledTimes(2);
    expect(h.enqueueCapturedEvents).not.toHaveBeenCalled();
    expect(h.enqueueAwaitWake).not.toHaveBeenCalled();
    expect(typeof result.enqueueDeferred).toBe('function');
  });

  it('advances the pull cursor pre-ack — the invariant is receipted, not dispatched', async () => {
    const h = await loadHandler({ events: [EVENT_A], checkpoint: { cursor: 42 } });

    await deliver(h);

    expect(h.qbSetCalls).toHaveLength(1);
    expect(h.qbSetCalls[0]).toHaveProperty('inbound_checkpoint');
    expect(h.enqueueCapturedEvents).not.toHaveBeenCalled();
  });

  it('an empty delivery is a bare ack with nothing deferred', async () => {
    const h = await loadHandler({ events: [] });

    const result = await deliver(h);

    expect(result).toEqual({ ok: true, eventsProcessed: 0 });
  });

  it('a production team never asks the route to wait', async () => {
    const h = await loadHandler({ events: [EVENT_A] });
    expect((await deliver(h)).awaitDeferred).toBeUndefined();
  });
});

describe('handleInboundWebhook — phase 2 queues the work', () => {
  it('queues each event\'s receipts, in delivery order', async () => {
    const seen: unknown[] = [];
    const onEnqueue = jest.fn(async (receipts: { triggerEvent: unknown }[]) => {
      seen.push(...receipts.map((r) => r.triggerEvent));
    });
    const h = await loadHandler({ events: [EVENT_A, EVENT_B], onEnqueue });

    const result = await deliver(h);
    const outcome = await (await result.enqueueDeferred!()).readOutcome(SETTLED);

    expect(outcome.eventsProcessed).toBe(2);
    expect(outcome.perEventErrors).toEqual([]);
    expect(seen).toEqual([{ payload: { n: 1 } }, { payload: { n: 2 } }]);
    // The door pokes the drain, after its ack.
    expect(h.notifyWork).not.toHaveBeenCalled();
  });

  it('one event failing to queue does not stop the next — the failure is per-event data', async () => {
    let call = 0;
    const onEnqueue = jest.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('enqueue exploded');
    });
    const h = await loadHandler({ events: [EVENT_A, EVENT_B], onEnqueue });

    const result = await deliver(h);
    const outcome = await (await result.enqueueDeferred!()).readOutcome(SETTLED);

    expect(onEnqueue).toHaveBeenCalledTimes(2);
    expect(outcome.eventsProcessed).toBe(1);
    expect(outcome.perEventErrors).toEqual([{ event: EVENT_A, error: 'enqueue exploded' }]);
  });

  it('an event naming a source record carries its linked-object refresh on each receipt', async () => {
    // The refresh is a live provider read: it runs in the row, not the request.
    const onEnqueue = jest.fn(async () => undefined);
    const h = await loadHandler({
      events: [{ payload: { n: 1 }, externalId: 'rec-1', recordType: 'companies' } as DiscriminableEvent],
      onEnqueue,
    });

    await (await deliver(h)).enqueueDeferred!();

    expect(onEnqueue).toHaveBeenCalledWith([
      expect.objectContaining({
        storedEventId: 'evt-1',
        linkedObjectRefresh: {
          teamId: 'team-1',
          provider: 'ATTIO',
          credentialsId: 'cred-1',
          externalId: 'rec-1',
          recordType: 'companies',
        },
      }),
    ]);
  });

  it('queues a Slack thread wake even when NO trigger matched the delivery', async () => {
    // Consent-by-silence: a reply must wake its `await …-[:Replies]->` park
    // whether or not any movement listens for Slack messages.
    const h = await loadHandler({
      events: [{ payload: { channel: 'C1', thread_ts: '111.1' } } as DiscriminableEvent],
      provider: 'SLACK',
      adapterType: 'slack',
      triggers: [],
    });

    const result = await deliver(h, 'SLACK');
    expect(h.enqueueAwaitWake).not.toHaveBeenCalled();

    await result.enqueueDeferred!();

    expect(h.enqueueAwaitWake).toHaveBeenCalledWith({
      adapterType: 'slack',
      teamId: 'team-1',
      correlationKey: 'C1:111.1',
    });
    expect(h.enqueueCapturedEvents).toHaveBeenCalledWith([]);
  });
});

describe('handleInboundWebhook — test-harness subscriptions stay synchronous', () => {
  it('asks the route to wait, and the drained outcome reports each failed receipt', async () => {
    const h = await loadHandler({
      events: [EVENT_A, EVENT_B],
      harnessTeam: true,
      failedReceipts: { 'evt-1': 'movement blew up' },
    });

    const result = await deliver(h);
    expect(result.awaitDeferred).toBe(true);

    const outcome = await (await result.enqueueDeferred!()).readOutcome(SETTLED);
    expect(h.readReceiptGroupOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({ settle: SETTLED }),
    );
    expect(outcome.eventsProcessed).toBe(1);
    expect(outcome.perEventErrors).toEqual([{ event: EVENT_A, error: 'movement blew up' }]);
  });
});

// A Telegram button tap rides the SAME per-subscription door as every message,
// as a `callback_query`. It resolves the question it was wired to and ends the
// delivery — there is no movement event in it — so the branch must sit ahead of
// the raw→events seam and must not touch any other provider.
describe('handleInboundWebhook — the Telegram button-tap branch', () => {
  const deliverTelegram = (h: Harness) =>
    h.handleInboundWebhook({
      provider: 'TELEGRAM',
      subscriptionId: 'sub-1',
      rawBody: Buffer.from('{}'),
      signatureHeader: 'sig',
    });

  it('a tap is answered against the subscription’s own bot and never reaches the events seam', async () => {
    const h = await loadHandler({
      events: [EVENT_A],
      provider: 'TELEGRAM',
      adapterType: 'telegram',
      askCallback: true,
    });

    const result = await deliverTelegram(h);

    expect(result).toEqual({ ok: true, eventsProcessed: 0 });
    expect(h.handleTelegramCallbackQuery).toHaveBeenCalledTimes(1);
    // The bot that sent the keyboard is the bot that acks the tap: the
    // responder is built from THIS subscription's team + credential.
    const responder = h.handleTelegramCallbackQuery.mock.calls[0][0].responder;
    expect(responder).toMatchObject({ teamId: 'team-1', credentialsId: 'cred-1' });
    expect(h.preprocessInbound).not.toHaveBeenCalled();
    expect(h.captureDiscriminableEvent).not.toHaveBeenCalled();
  });

  it('every other Telegram delivery flows on to the events seam untouched', async () => {
    const h = await loadHandler({
      events: [EVENT_A],
      provider: 'TELEGRAM',
      adapterType: 'telegram',
      askCallback: false,
    });

    const result = await deliverTelegram(h);

    expect(h.handleTelegramCallbackQuery).not.toHaveBeenCalled();
    expect(h.preprocessInbound).toHaveBeenCalledTimes(1);
    expect(result.eventsProcessed).toBe(1);
  });

  it('another provider is never asked whether its delivery is a tap', async () => {
    const h = await loadHandler({ events: [EVENT_A], askCallback: true });

    const result = await deliver(h);

    expect(h.handleTelegramCallbackQuery).not.toHaveBeenCalled();
    expect(result.eventsProcessed).toBe(1);
  });
});

describe('handleInboundWebhook — the BYO WhatsApp interactive-reply branch', () => {
  const deliverWhatsapp = (h: Harness) =>
    h.handleInboundWebhook({
      provider: 'INBOUND_WHATSAPP',
      subscriptionId: 'sub-1',
      rawBody: Buffer.from('{}'),
      signatureHeader: 'sig',
    });

  it('a callback-id tap is fired + acked through the door AND still reaches the events seam', async () => {
    // Unlike Telegram's single callback_query per delivery, a WhatsApp
    // delivery is a BATCH of messages — a tap can sit alongside an ordinary
    // one in the SAME body, so this branch must never early-return.
    const h = await loadHandler({
      events: [EVENT_A],
      provider: 'INBOUND_WHATSAPP',
      adapterType: 'whatsapp',
      waCallback: true,
    });

    const result = await deliverWhatsapp(h);

    expect(h.handleWhatsappInteractiveReplies).toHaveBeenCalledTimes(1);
    expect(h.handleWhatsappInteractiveReplies.mock.calls[0][0]).toMatchObject({ raw: {} });
    // No early return: the raw→events seam still runs for whatever else the
    // delivery carries.
    expect(h.preprocessInbound).toHaveBeenCalledTimes(1);
    expect(result.eventsProcessed).toBe(1);
  });

  it('a delivery with no callback-id tap never calls the door', async () => {
    const h = await loadHandler({
      events: [EVENT_A],
      provider: 'INBOUND_WHATSAPP',
      adapterType: 'whatsapp',
      waCallback: false,
    });

    const result = await deliverWhatsapp(h);

    expect(h.handleWhatsappInteractiveReplies).not.toHaveBeenCalled();
    expect(h.preprocessInbound).toHaveBeenCalledTimes(1);
    expect(result.eventsProcessed).toBe(1);
  });

  it('another provider is never asked whether its delivery carries a WhatsApp tap', async () => {
    const h = await loadHandler({ events: [EVENT_A], waCallback: true });

    await deliver(h);

    expect(h.handleWhatsappInteractiveReplies).not.toHaveBeenCalled();
  });
});
