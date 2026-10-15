// WhatsApp adapter's `getActorCandidates` + `extractActor`, exercised
// through Listen-Fire's `resolveActingUser` (the acting-user split). The phone
// twin of `adapter-email-acting-user.unit.test.ts`.
//
// The auth chain:
//   1. Sender (`From`) as a `scheme: 'phone'` `originator` → the
//      `automations.phone_number` link, then the owning user in core —
//      two reads since the carve (D3/D28), scoped to the team and gated on
//      granted access.
//   2. Otherwise → null. Dispatcher rejects.
//
// `extractActor` is a pure parse: it reads the sender phone into an
// `ActorIdentity` (with the WhatsApp profile name as label) regardless of
// whether the number maps to a Listen-Fire user.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { ActingUserTriggerContext } from '../adapters/acting_user_shared';

// DB mock: each `where` chain ends in an `executeTakeFirst` that returns
// the next queued row. Tests queue rows in the order the resolver looks
// them up. Every `where(...)` call is recorded into `whereCalls` so tests
// can assert the *predicates* a query issued — the row is returned
// regardless of predicates, so without this the mock would green-light a
// query that dropped its auth gate (the exact false-positive we're guarding
// against).
const dbQueue: Array<unknown> = [];
const whereCalls: unknown[][] = [];
function setDbRow(row: unknown) {
  dbQueue.push(row);
}
function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_t: object, prop: string | symbol): unknown {
      if (prop === 'executeTakeFirst') return async () => dbQueue.shift() ?? null;
      if (prop === 'execute') return async () => [];
      if (prop === 'then') return undefined;
      return (...args: unknown[]) => {
        if (prop === 'where') whereCalls.push(args);
        return mockChainable();
      };
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

import { WhatsappAdapter } from '../adapters/whatsapp';
import { resolveActingUser } from '../adapters/acting_user/resolve';

const TEAM_ID = 'team-1' as TeamId;

function identify(input: {
  adapter: WhatsappAdapter;
  event: TriggerEvent;
  trigger?: ActingUserTriggerContext;
}) {
  return resolveActingUser({
    teamId: TEAM_ID,
    trigger: input.trigger,
    getCandidates: () => input.adapter.getActorCandidates({ event: input.event }),
  });
}

function makeEvent(payload: Record<string, unknown>): TriggerEvent {
  return {
    pipelineInputId: 'pi-1',
    adapterType: 'whatsapp',
    triggerType: 'webhook',
    triggerEntryId: 'te-1',
    payload,
  };
}

beforeEach(() => {
  dbQueue.length = 0;
  whereCalls.length = 0;
});

describe('WhatsappAdapter acting-user — creator override (T6)', () => {
  it('overrides to creator when overrideActingUserToCreator is set (skips sender chain)', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    setDbRow({ id: 'creator-1', email: 'creator@example.com', username: 'creator' });
    const user = await identify({
      adapter,
      event: makeEvent({ From: 'whatsapp:+15551234567' }),
      trigger: {
        id: 't-1',
        kind: 'TWILIO',
        config: { overrideActingUserToCreator: true },
        createdByUserId: 'creator-1',
      },
    });
    expect(user).toEqual({ id: 'creator-1', email: 'creator@example.com', name: 'creator' });
  });

  it('rejects when override is on but the trigger has no creator', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const user = await identify({
      adapter,
      event: makeEvent({ From: 'whatsapp:+15551234567' }),
      trigger: {
        id: 't-1',
        kind: 'TWILIO',
        config: { overrideActingUserToCreator: true },
        createdByUserId: null,
      },
    });
    expect(user).toBeNull();
  });
});

describe('WhatsappAdapter acting-user', () => {
  it('authenticates as sender when the phone matches a team phone_number', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    setDbRow({ user_id: 'u-1' });
    setDbRow({ id: 'u-1', email: 'ada@example.com', username: 'ada' });
    const user = await identify({
      adapter,
      event: makeEvent({ From: 'whatsapp:+15551234567', ProfileName: 'Ada' }),
    });
    expect(user).toEqual({
      id: 'u-1',
      email: 'ada@example.com',
      name: 'ada',
    });
  });

  it('resolves the phone from the TG-side `from` field (prefix already stripped)', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    setDbRow({ user_id: 'u-2' });
    setDbRow({ id: 'u-2', email: 'ada@example.com', username: 'ada' });
    const user = await identify({
      adapter,
      event: makeEvent({ from: '+15551234567' }),
    });
    expect(user?.id).toBe('u-2');
  });

  it('falls back to username for display email when the user has no primary email', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    setDbRow({ user_id: 'u-3' });
    setDbRow({ id: 'u-3', email: null, username: 'svcuser' });
    const user = await identify({
      adapter,
      event: makeEvent({ From: 'whatsapp:+15559999999' }),
    });
    expect(user).toEqual({ id: 'u-3', email: 'svcuser', name: 'svcuser' });
  });

  it('rejects when the sender phone maps to no team user', async () => {
    // The number is linked, but the user fails the team + granted-access gate.
    const adapter = new WhatsappAdapter(TEAM_ID);
    setDbRow({ user_id: 'u-9' });
    setDbRow(null);
    const user = await identify({
      adapter,
      event: makeEvent({ From: 'whatsapp:+15550000000' }),
    });
    expect(user).toBeNull();
  });

  it('gates phone resolution on the granted-access predicate (auth boundary)', async () => {
    // Parity with v3 `unauthorisedGetUserByPhone`, which requires
    // `grantedAccessAt: { not: null }`. Without this predicate an
    // invited/pending/revoked user whose number is on the team would
    // authenticate. We assert the query actually issues the gate rather
    // than trusting the (predicate-blind) row mock.
    const adapter = new WhatsappAdapter(TEAM_ID);
    setDbRow({ user_id: 'u-1' });
    setDbRow({ id: 'u-1', email: 'ada@example.com', username: 'ada' });
    await identify({
      adapter,
      event: makeEvent({ From: 'whatsapp:+15551234567' }),
    });
    expect(whereCalls).toContainEqual(['u.granted_access_at', 'is not', null]);
  });

  it('rejects when the sender phone is not linked at all', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    setDbRow(null);
    const user = await identify({
      adapter,
      event: makeEvent({ From: 'whatsapp:+15550000000' }),
    });
    expect(user).toBeNull();
  });

  it('returns null when the payload carries no sender', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const user = await identify({ adapter, event: makeEvent({}) });
    expect(user).toBeNull();
  });
});

describe('WhatsappAdapter.getActorCandidates', () => {
  it('emits a single phone-scheme originator with the whatsapp: prefix stripped', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const candidates = await adapter.getActorCandidates({
      event: makeEvent({ From: 'whatsapp:+15551234567' }),
    });
    expect(candidates).toEqual([
      {
        identity: { identifier: '+15551234567', scheme: 'phone', adapterType: 'whatsapp' },
        source: 'originator',
      },
    ]);
  });

  it('emits no candidates when there is no sender', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const candidates = await adapter.getActorCandidates({ event: makeEvent({}) });
    expect(candidates).toEqual([]);
  });
});

describe('WhatsappAdapter.extractActor', () => {
  it('returns the raw sender phone with the profile name as label', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const actor = await adapter.extractActor({
      event: makeEvent({ From: 'whatsapp:+15551234567', ProfileName: 'Ada Okafor' }),
    });
    expect(actor).toEqual({
      identifier: '+15551234567',
      scheme: 'phone',
      adapterType: 'whatsapp',
      name: 'Ada Okafor',
      label: 'Ada Okafor',
    });
  });

  it('falls back to the phone as label when there is no profile name', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const actor = await adapter.extractActor({
      event: makeEvent({ From: 'whatsapp:+15551234567' }),
    });
    expect(actor).toEqual({
      identifier: '+15551234567',
      scheme: 'phone',
      adapterType: 'whatsapp',
      name: undefined,
      label: '+15551234567',
    });
  });

  it('returns null when the event carries no sender', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const actor = await adapter.extractActor({ event: makeEvent({}) });
    expect(actor).toBeNull();
  });
});
