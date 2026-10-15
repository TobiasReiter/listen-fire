// Acting-user resolution — Listen-Fire's half of the acting-user split
// (adapters/acting_user/resolve.ts). The adapter parses `ActorCandidate[]`;
// this module runs the resolution chain against Listen-Fire's DB:
//
//   1. Creator override (T6) — short-circuits before the candidate thunk
//      is even awaited (lazy parse). Rejects when no creator.
//   2. Originator candidates → NON-service `user_email`.
//   3. Relay candidates → SERVICE `user_email` (after originator miss).
//   4. Creator fallback — `fallbackToCreatorIfActorUnregistered` + creator.
//   5. Otherwise → null.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ActorCandidate } from 'movement-engine/services/translation_graph/adapter';

// DB mock: each `where` chain ends in `executeTakeFirst` returning the next
// queued row. Tests queue rows in the order the resolver looks them up.
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

import { resolveActingUser } from '../adapters/acting_user/resolve';

const TEAM_ID = 'team-1' as TeamId;

function originator(email: string): ActorCandidate {
  return { identity: { identifier: email, scheme: 'email', email }, source: 'originator' };
}
function relay(email: string): ActorCandidate {
  return { identity: { identifier: email, scheme: 'email', email }, source: 'relay' };
}
function phoneOriginator(phone: string): ActorCandidate {
  return { identity: { identifier: phone, scheme: 'phone' }, source: 'originator' };
}
function opaqueOriginator(id: string): ActorCandidate {
  return { identity: { identifier: id, scheme: 'opaque' }, source: 'originator' };
}

beforeEach(() => {
  dbQueue.length = 0;
});

describe('resolveActingUser — creator override (T6)', () => {
  it('returns the creator when overrideActingUserToCreator is set', async () => {
    setDbRow({ id: 'creator-1', email: 'creator@example.com', username: 'creator' });
    const getCandidates = jest.fn(async () => [originator('ext@other.com')]);
    const user = await resolveActingUser({
      teamId: TEAM_ID,
      trigger: { id: 't-1', kind: 'EMAIL', config: { overrideActingUserToCreator: true }, createdByUserId: 'creator-1' },
      getCandidates,
    });
    expect(user).toEqual({ id: 'creator-1', email: 'creator@example.com', name: 'creator' });
  });

  it('rejects (null) when override is on but the trigger has no creator', async () => {
    const getCandidates = jest.fn(async () => [originator('ada@example.com')]);
    const user = await resolveActingUser({
      teamId: TEAM_ID,
      trigger: { id: 't-1', kind: 'EMAIL', config: { overrideActingUserToCreator: true }, createdByUserId: null },
      getCandidates,
    });
    expect(user).toBeNull();
  });

  it('does NOT await the candidate thunk when the override short-circuits (lazy parse)', async () => {
    setDbRow({ id: 'creator-1', email: 'creator@example.com', username: 'creator' });
    const getCandidates = jest.fn(async () => [originator('ext@other.com')]);
    await resolveActingUser({
      teamId: TEAM_ID,
      trigger: { id: 't-1', kind: 'EMAIL', config: { overrideActingUserToCreator: true }, createdByUserId: 'creator-1' },
      getCandidates,
    });
    expect(getCandidates).not.toHaveBeenCalled();
  });
});

describe('resolveActingUser — candidate chain', () => {
  it('matches an originator against a NON-service user', async () => {
    setDbRow({ id: 'u-1', email: 'ada@example.com', username: 'ada' });
    const user = await resolveActingUser({
      teamId: TEAM_ID,
      getCandidates: async () => [originator('ada@example.com')],
    });
    expect(user).toEqual({ id: 'u-1', email: 'ada@example.com', name: 'ada' });
  });

  it('matches a relay against a SERVICE user after the originator misses', async () => {
    setDbRow(null); // originator lookup misses
    setDbRow({ id: 'u-svc', email: 'dealflow@example.com', username: 'ada' }); // relay hits
    const user = await resolveActingUser({
      teamId: TEAM_ID,
      getCandidates: async () => [originator('ext@example.com'), relay('dealflow@example.com')],
    });
    expect(user).toEqual({ id: 'u-svc', email: 'dealflow@example.com', name: 'ada' });
  });

  it('tries all originators before any relay', async () => {
    setDbRow(null); // first originator misses
    setDbRow({ id: 'u-2', email: 'second@example.com', username: 'second' }); // second originator hits
    const user = await resolveActingUser({
      teamId: TEAM_ID,
      getCandidates: async () => [
        originator('first@example.com'),
        originator('second@example.com'),
        relay('svc@example.com'),
      ],
    });
    expect(user?.id).toBe('u-2');
  });

  it('falls back to the creator when nothing matches and fallback is on', async () => {
    setDbRow(null); // originator miss
    setDbRow(null); // relay miss
    setDbRow({ id: 'creator-1', email: 'creator@example.com', username: 'creator' });
    const user = await resolveActingUser({
      teamId: TEAM_ID,
      trigger: {
        id: 't-1',
        kind: 'SLACK',
        config: { fallbackToCreatorIfActorUnregistered: true },
        createdByUserId: 'creator-1',
      },
      getCandidates: async () => [originator('ext@example.com'), relay('svc@external.com')],
    });
    expect(user?.id).toBe('creator-1');
  });

  it('does not fall back to the creator when the fallback flag is off', async () => {
    setDbRow(null); // originator miss
    const user = await resolveActingUser({
      teamId: TEAM_ID,
      trigger: { id: 't-1', kind: 'SLACK', config: {}, createdByUserId: 'creator-1' },
      getCandidates: async () => [originator('ext@example.com')],
    });
    expect(user).toBeNull();
  });

  it('returns null when there are no candidates and no fallback', async () => {
    const user = await resolveActingUser({
      teamId: TEAM_ID,
      getCandidates: async () => [],
    });
    expect(user).toBeNull();
  });

  it('matches a phone-scheme originator against the phone_number table (WhatsApp)', async () => {
    // Two reads since the carve: the number link in `automations`, then the
    // user in core (D3/D28).
    setDbRow({ user_id: 'u-phone' });
    setDbRow({ id: 'u-phone', email: 'ada@example.com', username: 'ada' });
    const user = await resolveActingUser({
      teamId: TEAM_ID,
      getCandidates: async () => [phoneOriginator('+15551234567')],
    });
    expect(user).toEqual({ id: 'u-phone', email: 'ada@example.com', name: 'ada' });
  });

  it('rejects when a phone-scheme originator maps to no team user', async () => {
    setDbRow(null);
    const user = await resolveActingUser({
      teamId: TEAM_ID,
      getCandidates: async () => [phoneOriginator('+15550000000')],
    });
    expect(user).toBeNull();
  });

  it('skips an opaque originator (no lookup) and resolves the next candidate', async () => {
    // Only ONE row is queued: if the opaque candidate triggered a lookup it
    // would consume this row (an email match on the raw id) and wrongly
    // resolve. It must be skipped so the email originator gets the row.
    setDbRow({ id: 'u-1', email: 'ada@example.com', username: 'ada' });
    const user = await resolveActingUser({
      teamId: TEAM_ID,
      getCandidates: async () => [opaqueOriginator('U123'), originator('ada@example.com')],
    });
    expect(user).toEqual({ id: 'u-1', email: 'ada@example.com', name: 'ada' });
    // The opaque candidate consumed no lookup — the queued row was claimed by
    // the email originator, leaving the queue empty.
    expect(dbQueue).toHaveLength(0);
  });

  it('rejects when the only candidate is opaque (maps to no team user)', async () => {
    const user = await resolveActingUser({
      teamId: TEAM_ID,
      getCandidates: async () => [opaqueOriginator('U123')],
    });
    expect(user).toBeNull();
  });
});
