// T5 — email adapter's `getActorCandidates` + `extractActor`, exercised
// through Listen-Fire's `resolveActingUser` (the acting-user split, 2026-05-29).
//
// The auth chain (now owned by `resolveActingUser`, fed by the adapter's
// parsed candidates):
//   1. Sender (`From:`) as `originator` → `user_email WHERE NOT
//      is_service_email`.
//   2. Forwarding-header recipients as `relay` → `user_email WHERE
//      is_service_email = true`.
//   3. Otherwise → null. Dispatcher rejects.
//
// `extractActor` is a pure parse (async only for remoteability): it reads
// the `From:` header into an `ActorIdentity` regardless of whether the
// address maps to a Listen-Fire user.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { ActingUserTriggerContext } from '../adapters/acting_user_shared';

// DB mock: each `where` chain ends in an `executeTakeFirst` that returns
// the next queued row. Tests queue rows in the order the adapter will
// look them up.
const dbQueue: Array<unknown> = [];
function setDbRow(row: unknown) {
  dbQueue.push(row);
}
function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_t: object, prop: string | symbol): unknown {
      if (prop === 'executeTakeFirst') return async () => dbQueue.shift() ?? null;
      if (prop === 'execute') return async () => [];
      if (prop === 'then') return undefined;
      return () => mockChainable();
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

import { EmailAdapter } from '../adapters/email';
import { resolveActingUser } from '../adapters/acting_user/resolve';

const TEAM_ID = 'team-1' as TeamId;

// Drive the full acting-user path: the adapter parses candidates,
// `resolveActingUser` maps them to a team user.
function identify(input: {
  adapter: EmailAdapter;
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
    adapterType: 'email',
    triggerType: 'webhook',
    triggerEntryId: 'te-1',
    payload,
  };
}

beforeEach(() => {
  dbQueue.length = 0;
});

describe('EmailAdapter acting-user — creator override (T6)', () => {
  it('overrides to creator when overrideActingUserToCreator is set (skips sender chain)', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    setDbRow({ id: 'creator-1', email: 'creator@example.com', username: 'creator' });
    const user = await identify({
      adapter,
      event: makeEvent({ sender: '"Ext" <ext@other.com>' }),
      trigger: {
        id: 't-1',
        kind: 'INBOUND_EMAIL',
        config: { overrideActingUserToCreator: true },
        createdByUserId: 'creator-1',
      },
    });
    expect(user).toEqual({ id: 'creator-1', email: 'creator@example.com', name: 'creator' });
  });

  it('rejects when override is on but the trigger has no creator', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const user = await identify({
      adapter,
      event: makeEvent({ sender: '"Ada" <ada@example.com>' }),
      trigger: {
        id: 't-1',
        kind: 'INBOUND_EMAIL',
        config: { overrideActingUserToCreator: true },
        createdByUserId: null,
      },
    });
    expect(user).toBeNull();
  });
});

describe('EmailAdapter acting-user', () => {
  it('authenticates as sender when From matches a non-service user_email', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    setDbRow({ id: 'u-1', email: 'ada@example.com', username: 'ada' });
    const user = await identify({
      adapter,
      event: makeEvent({ sender: '"Ada Okafor" <ada@example.com>' }),
    });
    expect(user).toEqual({
      id: 'u-1',
      email: 'ada@example.com',
      name: 'ada',
    });
  });

  it('falls through to service-account when sender is not registered', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    // Sender lookup misses.
    setDbRow(null);
    // Intermediate-recipient (service-account) lookup hits.
    setDbRow({ id: 'u-svc-owner', email: 'dealflow@example.com', username: 'ada' });
    const user = await identify({
      adapter,
      event: makeEvent({
        sender: 'external@example.com',
        recipient: 'inbox+dealflow@example.com',
        'Delivered-To': 'dealflow@example.com',
      }),
    });
    expect(user).toEqual({
      id: 'u-svc-owner',
      email: 'dealflow@example.com',
      name: 'ada',
    });
  });

  it('rejects when neither sender nor any forwarding header maps to a team user', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    // Nothing matches.
    const user = await identify({
      adapter,
      event: makeEvent({
        sender: 'external@example.com',
        recipient: 'inbox+dealflow@example.com',
      }),
    });
    expect(user).toBeNull();
  });

  it('ignores the terminal inbox+ recipient as an auth signal (routing-only)', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    // No row matches anywhere — sender external, no forwarding header,
    // and the `recipient` lookup arm requires service-email = true,
    // which `inbox+dealflow@example.com` doesn't satisfy.
    const user = await identify({
      adapter,
      event: makeEvent({
        sender: 'external@example.com',
        recipient: 'inbox+dealflow@example.com',
      }),
    });
    expect(user).toBeNull();
  });

  it('returns null when the payload has no usable headers', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const user = await identify({ adapter, event: makeEvent({}) });
    expect(user).toBeNull();
  });

  it('parses From from message-headers when not present as a top-level key', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    setDbRow({ id: 'u-2', email: 'ada@example.com', username: 'ada' });
    const user = await identify({
      adapter,
      event: makeEvent({
        'message-headers': [
          ['Subject', 'A subject'],
          ['From', '"Ada" <ada@example.com>'],
        ],
      }),
    });
    expect(user?.email).toBe('ada@example.com');
  });

  // T5-audit — parity with legacy `mailgun.adapter.ts:getSenderIdentifier`,
  // which falls back to a plus-stripped lookup against rows with
  // `accepts_plus_addressing = true`. Without this, a legitimate sender
  // whose client adds a plus-tag (e.g. `ada+notes@example.com`) was
  // accepted by the legacy mailgun handler but rejected by the new gate.
  it('authenticates a sender via the plus-stripped fallback when the canonical row accepts plus-addressing', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    // Direct lookup misses.
    setDbRow(null);
    // Plus-stripped lookup hits.
    setDbRow({ id: 'u-3', email: 'ada@example.com', username: 'ada' });
    const user = await identify({
      adapter,
      event: makeEvent({ sender: 'ada+notes@example.com' }),
    });
    expect(user).toEqual({
      id: 'u-3',
      email: 'ada@example.com',
      name: 'ada',
    });
  });

  it('falls back to plus-stripped lookup for the intermediate-recipient arm too', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    // Sender direct miss + sender plus-strip skipped (no '+' in sender).
    setDbRow(null);
    // Intermediate direct miss.
    setDbRow(null);
    // Intermediate plus-stripped hit on service email.
    setDbRow({ id: 'u-svc', email: 'dealflow@example.com', username: 'ada' });
    const user = await identify({
      adapter,
      event: makeEvent({
        sender: 'external@example.com',
        'Delivered-To': 'dealflow+abc@example.com',
      }),
    });
    expect(user?.email).toBe('dealflow@example.com');
  });
});

describe('EmailAdapter.extractActor', () => {
  it('returns the raw sender even when auth would go through service-account', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const actor = await adapter.extractActor({
      event: makeEvent({
        sender: '"External Sender" <ext@example.com>',
        recipient: 'dealflow@example.com',
      }),
    });
    expect(actor).toEqual({
      identifier: 'ext@example.com',
      scheme: 'email',
      adapterType: 'email',
      email: 'ext@example.com',
      name: 'External Sender',
      label: 'External Sender',
    });
  });

  it('reads From from message-headers when sender top-level is missing', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const actor = await adapter.extractActor({
      event: makeEvent({
        'message-headers': [['From', 'plain@example.com']],
      }),
    });
    expect(actor?.identifier).toBe('plain@example.com');
    expect(actor?.scheme).toBe('email');
  });

  it('returns null when the event carries no actor-shaped headers', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const actor = await adapter.extractActor({ event: makeEvent({}) });
    expect(actor).toBeNull();
  });
});
