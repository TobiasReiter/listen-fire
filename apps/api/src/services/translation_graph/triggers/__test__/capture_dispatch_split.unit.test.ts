// The inbound tail is split in two so an acking front door (webhook_sync) can
// store the durable receipt INSIDE the request and run the movement after the
// 200. These pin the seam: capture never dispatches, dispatch never re-stores,
// and the invariants that used to live in one function survive the split —
// store-before-dispatch, duplicate ⇒ no dispatch, store failure ⇒ dispatch
// anyway (unreceipted), and `platformTokenRegistry` reaching the router.
//
// Fully mocked (no DB, no engine): `../event_store` and `../router` stand in,
// so what's under test is exactly the tail's wiring.

const baseInput = {
  triggerId: 'trig-1' as never,
  movementId: 'movement-1',
  event: { payload: { hello: 'world' }, idempotencyKey: 'delivery-1' },
  adapterType: 'attio',
  triggerType: 'webhook' as never,
  eventTypes: [],
  teamId: 'team-1' as never,
};

function mockTail(storeResult: unknown) {
  jest.doMock('../router', () => ({ dispatchTriggerByIdEvent: jest.fn() }));
  jest.doMock('movement-engine/services/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  jest.doMock('../event_store', () => ({
    storeTriggerEvent: jest.fn(async () => storeResult),
    markTriggerEventDispatched: jest.fn(),
    markTriggerEventFailed: jest.fn(),
    stampDroppedReason: jest.fn(),
  }));
  jest.doMock('../../engine/platform_token_registry_db', () => ({
    platformTokenRegistry: { __marker: 'platform-token-registry' },
  }));
  const router = jest.requireMock('../router') as { dispatchTriggerByIdEvent: jest.Mock };
  router.dispatchTriggerByIdEvent.mockResolvedValue({ evaluations: [], droppedReason: undefined });
  return {
    router,
    store: jest.requireMock('../event_store') as {
      storeTriggerEvent: jest.Mock;
      markTriggerEventDispatched: jest.Mock;
      markTriggerEventFailed: jest.Mock;
      stampDroppedReason: jest.Mock;
    },
  };
}

describe('captureDiscriminableEvent — the pre-ack half', () => {
  beforeEach(() => jest.resetModules());

  it('stores the receipt and does NOT dispatch', async () => {
    const { router, store } = mockTail({ id: 'evt-1', duplicate: false });
    const { captureDiscriminableEvent } = await import('../dispatch_event');

    const captured = await captureDiscriminableEvent(baseInput);

    expect(store.storeTriggerEvent).toHaveBeenCalledTimes(1);
    expect(router.dispatchTriggerByIdEvent).not.toHaveBeenCalled();
    expect(captured).toMatchObject({ storedEventId: 'evt-1', duplicate: false });
    expect(captured?.triggerEvent.payload).toEqual({ hello: 'world' });
  });

  it('flags a redelivery as duplicate (the receipt already exists)', async () => {
    mockTail({ id: 'evt-1', duplicate: true });
    const { captureDiscriminableEvent } = await import('../dispatch_event');

    const captured = await captureDiscriminableEvent(baseInput);

    expect(captured).toMatchObject({ storedEventId: 'evt-1', duplicate: true });
  });

  it('returns null for a trigger with no movement bound (nothing to dispatch)', async () => {
    const { store } = mockTail({ id: 'evt-1', duplicate: false });
    const { captureDiscriminableEvent } = await import('../dispatch_event');

    expect(await captureDiscriminableEvent({ ...baseInput, movementId: null })).toBeNull();
    expect(store.storeTriggerEvent).not.toHaveBeenCalled();
  });

  it('a store failure yields no receipt id but still a dispatchable capture', async () => {
    jest.doMock('../router', () => ({ dispatchTriggerByIdEvent: jest.fn() }));
    jest.doMock('movement-engine/services/logger', () => ({
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    }));
    jest.doMock('../event_store', () => ({
      storeTriggerEvent: jest.fn(async () => {
        throw new Error('db down');
      }),
      markTriggerEventDispatched: jest.fn(),
      markTriggerEventFailed: jest.fn(),
      stampDroppedReason: jest.fn(),
    }));
    const { captureDiscriminableEvent } = await import('../dispatch_event');

    const captured = await captureDiscriminableEvent(baseInput);

    expect(captured).not.toBeNull();
    expect(captured?.storedEventId).toBeUndefined();
    expect(captured?.duplicate).toBe(false);
  });
});

describe('dispatchCapturedTriggerEvent — the post-ack half', () => {
  beforeEach(() => jest.resetModules());

  it('dispatches the captured receipt with its id and the Listen-Fire token registry', async () => {
    const { router, store } = mockTail({ id: 'evt-1', duplicate: false });
    const { captureDiscriminableEvent, dispatchCapturedTriggerEvent } = await import(
      '../dispatch_event'
    );

    const captured = await captureDiscriminableEvent(baseInput);
    await dispatchCapturedTriggerEvent({ captured: captured! });

    expect(router.dispatchTriggerByIdEvent).toHaveBeenCalledTimes(1);
    const arg = router.dispatchTriggerByIdEvent.mock.calls[0]![0] as Record<string, unknown>;
    // storedEventId reaches the router — the loop-guard's hold-and-release
    // re-dispatches THAT receipt, so dropping it here breaks suppression.
    expect(arg.storedEventId).toBe('evt-1');
    // The echo-drop gate reads the registry; routing around it (e.g. through
    // `dispatchStoredTriggerEvent`) would re-open Listen-Fire self-echo loops.
    expect(arg.platformTokenRegistry).toEqual({ __marker: 'platform-token-registry' });
    expect(store.markTriggerEventDispatched).toHaveBeenCalledWith('evt-1');
    // Dispatch never re-stores — the capture half already owns that.
    expect(store.storeTriggerEvent).toHaveBeenCalledTimes(1);
  });

  it('skips dispatch for a duplicate capture — the first delivery owns the run', async () => {
    const { router, store } = mockTail({ id: 'evt-1', duplicate: true });
    const { captureDiscriminableEvent, dispatchCapturedTriggerEvent } = await import(
      '../dispatch_event'
    );

    const captured = await captureDiscriminableEvent(baseInput);
    await dispatchCapturedTriggerEvent({ captured: captured! });

    expect(router.dispatchTriggerByIdEvent).not.toHaveBeenCalled();
    expect(store.markTriggerEventDispatched).not.toHaveBeenCalled();
  });

  it('dispatches an unreceipted capture (store failed) without marking anything', async () => {
    const { router } = mockTail({ id: 'evt-1', duplicate: false });
    const { dispatchCapturedTriggerEvent } = await import('../dispatch_event');
    const store = jest.requireMock('../event_store') as { markTriggerEventDispatched: jest.Mock };

    await dispatchCapturedTriggerEvent({
      captured: {
        triggerId: 'trig-1' as never,
        teamId: 'team-1' as never,
        triggerEvent: { pipelineInputId: 'trigger:trig-1' } as never,
        duplicate: false,
      },
    });

    expect(router.dispatchTriggerByIdEvent).toHaveBeenCalledTimes(1);
    expect(store.markTriggerEventDispatched).not.toHaveBeenCalled();
  });

  it('records a dispatch failure on the receipt and only rethrows when surfacing', async () => {
    const { router, store } = mockTail({ id: 'evt-1', duplicate: false });
    router.dispatchTriggerByIdEvent.mockRejectedValue(new Error('engine exploded'));
    const { captureDiscriminableEvent, dispatchCapturedTriggerEvent } = await import(
      '../dispatch_event'
    );
    const captured = await captureDiscriminableEvent(baseInput);

    await expect(dispatchCapturedTriggerEvent({ captured: captured! })).resolves.toBeUndefined();
    expect(store.markTriggerEventFailed).toHaveBeenCalledWith('evt-1', 'engine exploded');

    await expect(
      dispatchCapturedTriggerEvent({ captured: captured!, surfaceErrors: true }),
    ).rejects.toThrow('engine exploded');
  });
});

describe('dispatchDiscriminableEvent — the combined path other doors still use', () => {
  beforeEach(() => jest.resetModules());

  it('captures then dispatches in one call', async () => {
    const { router, store } = mockTail({ id: 'evt-1', duplicate: false });
    const { dispatchDiscriminableEvent } = await import('../dispatch_event');

    await dispatchDiscriminableEvent(baseInput);

    expect(store.storeTriggerEvent).toHaveBeenCalledTimes(1);
    expect(router.dispatchTriggerByIdEvent).toHaveBeenCalledTimes(1);
    expect(store.markTriggerEventDispatched).toHaveBeenCalledWith('evt-1');
  });

  it('a duplicate delivery stores nothing new and never dispatches', async () => {
    const { router } = mockTail({ id: 'evt-1', duplicate: true });
    const { dispatchDiscriminableEvent } = await import('../dispatch_event');

    await dispatchDiscriminableEvent(baseInput);

    expect(router.dispatchTriggerByIdEvent).not.toHaveBeenCalled();
  });
});
