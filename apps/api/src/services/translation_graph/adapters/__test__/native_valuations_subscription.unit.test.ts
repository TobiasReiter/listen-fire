// native-valuations is now a first-class movement-listen source: a movement that
// `listen`s to it gets a Valuations webhook auto-provisioned via the adapter's
// ensureEventSubscription (the `syncListenSubscriptions` bridge), exactly like
// Attio/Airtable. Before this it only registered via the manual Settings path,
// so `listen to vals {}` provisioned nothing. These guard (1) the manifest
// opt-in the reconciler gates on, and (2) the adapter delegating to the shared
// register/deregister helper with correct change-handling.

// logger → services/context → casl crashes at module load; stub it.
jest.mock('../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const registerValuationsWebhook = jest.fn(async (_a: unknown) => ({ externalId: 'https://cb', secret: 'shh' }));
const deregisterValuationsWebhook = jest.fn(async (_a: unknown) => {});
jest.mock('../native_valuations_webhook', () => ({
  NATIVE_VALUATIONS_SUBSCRIBABLE_EVENTS: [
    'valuations:legal_entity:create',
    'valuations:legal_entity:update',
    'valuations:legal_entity:delete',
  ],
  registerValuationsWebhook: (a: unknown) => registerValuationsWebhook(a),
  deregisterValuationsWebhook: (a: unknown) => deregisterValuationsWebhook(a),
}));

import type { TeamId } from '../../../../generated/kysely/core/Team';

import {
  NATIVE_VALUATIONS_MANIFEST,
  createNativeValuationsAdapter,
} from '../native_valuations';

const adapter = () =>
  createNativeValuationsAdapter({ teamId: 'team-1' as TeamId, credentialsId: 'cred-1' });

beforeEach(() => jest.clearAllMocks());

describe('native-valuations manifest — movement-listen opt-in', () => {
  it('declares ensureEventSubscription + removeEventSubscription + subscribableEvents, and requires events', () => {
    expect(NATIVE_VALUATIONS_MANIFEST.methods).toEqual(
      expect.arrayContaining(['ensureEventSubscription', 'removeEventSubscription']),
    );
    expect(NATIVE_VALUATIONS_MANIFEST.subscribableEvents).toEqual([
      'valuations:legal_entity:create',
      'valuations:legal_entity:update',
      'valuations:legal_entity:delete',
    ]);
    // `events` required → `listen to vals {}` is flagged (the user must name what it watches).
    expect(NATIVE_VALUATIONS_MANIFEST.listenConfig).toEqual([{ key: 'events', required: true }]);
  });
});

describe('NativeValuationsAdapter.ensureEventSubscription', () => {
  it('registers via the shared helper with the channel events + callback URL', async () => {
    const result = await adapter().ensureEventSubscription!({
      events: ['valuations:legal_entity:create', 'valuations:legal_entity:update'],
      callbackUrl: 'https://cb',
    });
    expect(registerValuationsWebhook).toHaveBeenCalledWith({
      credentialsId: 'cred-1',
      targetUrl: 'https://cb',
      eventTypes: ['valuations:legal_entity:create', 'valuations:legal_entity:update'],
    });
    expect(result).toEqual({ externalId: 'https://cb', secret: 'shh' });
  });

  it('no-ops (no register) when the registered event set is unchanged', async () => {
    const result = await adapter().ensureEventSubscription!({
      events: ['valuations:legal_entity:create'],
      callbackUrl: 'https://cb',
      current: { externalId: 'https://cb', events: ['valuations:legal_entity:create'] },
    });
    expect(result).toBeUndefined();
    expect(registerValuationsWebhook).not.toHaveBeenCalled();
    expect(deregisterValuationsWebhook).not.toHaveBeenCalled();
  });

  it('deregisters the superseded webhook then re-registers when the event set changes', async () => {
    await adapter().ensureEventSubscription!({
      events: ['valuations:legal_entity:create', 'valuations:legal_entity:update'],
      callbackUrl: 'https://cb',
      current: { externalId: 'https://cb', events: ['valuations:legal_entity:create'] },
    });
    expect(deregisterValuationsWebhook).toHaveBeenCalledWith({
      credentialsId: 'cred-1',
      externalId: 'https://cb',
    });
    expect(registerValuationsWebhook).toHaveBeenCalledTimes(1);
  });
});

describe('NativeValuationsAdapter.removeEventSubscription', () => {
  it('deregisters by the held externalId', async () => {
    await adapter().removeEventSubscription!({ callbackUrl: 'https://cb', externalId: 'https://cb' });
    expect(deregisterValuationsWebhook).toHaveBeenCalledWith({
      credentialsId: 'cred-1',
      externalId: 'https://cb',
    });
  });
});
