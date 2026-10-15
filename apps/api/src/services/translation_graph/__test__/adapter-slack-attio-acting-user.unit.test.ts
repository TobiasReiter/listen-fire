// T5 + T6 — Slack and Attio adapter auth chains.
//
// T5 established: actor → Listen-Fire user mapping (none existed), optional
// `trigger.config.fallbackToCreatorIfActorUnregistered`, else reject.
//
// T6 (ruling 2026-06-01) completes the picture with two additions, both
// uniform across adapters:
//
//   1. Creator override — `trigger.config.overrideActingUserToCreator`.
//      Step 1 of resolution: re-credit the dispatch to the trigger
//      creator (reject if no creator). Does NOT bypass auth. `@actor_*`
//      is untouched (still the raw originator).
//   2. Runtime actor email auto-match — no persistence. Slack resolves
//      the actor email via `users.info`; Attio via
//      `/v2/workspace_members/{id}`. The resolved email is matched with
//      the shared two-pass `lookupTeamUserByEmail`. API failures swallow
//      to null and fall through the chain.
//
// Full order (both adapters): override → actor-email-match → creator
// fallback → reject.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';

// ── DB mock (user_email / user lookups + creator load) ──────────────────
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
jest.mock('../../../lib/credentials', () => ({
  decryptToken: async () => '{"accessToken":"xoxb-test","baseUrl":"https://slack.test"}',
  encryptToken: async () => '',
}));
jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// Keep credential baseUrl injection a no-op so the parsed payload above
// flows through unchanged for both adapters.
jest.mock('../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (c: Record<string, unknown>) => c,
}));

// ── Slack `users.info` mock ──────────────────────────────────────────────
const slackUsersInfo = jest.fn();
jest.mock('../../../adapters/slack/webApi/apiClient', () => ({
  slackCredsParser: { safeParse: (v: unknown) => ({ success: true, data: v }) },
  getSlackClient: () => ({ api: { users: { info: slackUsersInfo } } }),
}));

// ── Attio `client.fetch` mock ────────────────────────────────────────────
const attioFetch = jest.fn();
jest.mock('../../../adapters/attio/apiClient', () => ({
  getAttioClient: () => ({ fetch: attioFetch }),
  attioCredsParser: { safeParse: (v: unknown) => ({ success: true, data: v }) },
}));

import type { ActingUserTriggerContext } from '../adapters/acting_user_shared';
import type { ActorCandidate } from 'movement-engine/services/translation_graph/adapter';

import { SlackAdapter } from '../adapters/slack';
import { AttioAdapter } from '../adapters/attio';
import { resolveActingUser } from '../adapters/acting_user/resolve';

const TEAM_ID = 'team-1' as TeamId;

// Drive the full acting-user path: the adapter parses candidates (with its
// runtime actor-email API enrichment), `resolveActingUser` maps them.
function identify(input: {
  adapter: { getActorCandidates(i: { event: TriggerEvent }): Promise<ActorCandidate[]> };
  event: TriggerEvent;
  trigger?: ActingUserTriggerContext;
}) {
  return resolveActingUser({
    teamId: TEAM_ID,
    trigger: input.trigger,
    getCandidates: () => input.adapter.getActorCandidates({ event: input.event }),
  });
}

function makeEvent(payload: Record<string, unknown>, actor?: Record<string, unknown>): TriggerEvent {
  return {
    pipelineInputId: 'pi-1',
    adapterType: 'slack',
    triggerType: 'webhook',
    triggerEntryId: 'te-1',
    payload,
    actor: actor as TriggerEvent['actor'],
  };
}

// Both adapters read their credential row from the DB before making any
// API call (Slack's `getSlackApiClient`, Attio's `getApiClient`); queue
// this first whenever the runtime email-resolution path runs.
const ATTIO_CRED_ROW = { id: 'cred-1', credentials: 'enc' };
const SLACK_CRED_ROW = { id: 'cred-1', credentials: 'enc' };

beforeEach(() => {
  dbQueue.length = 0;
  slackUsersInfo.mockReset();
  attioFetch.mockReset();
});

// ── Slack ──────────────────────────────────────────────────────────────

describe('SlackAdapter acting-user', () => {
  it('rejects when config has no creator fallback set and email does not match', async () => {
    const adapter = new SlackAdapter(TEAM_ID, 'cred-1');
    setDbRow(SLACK_CRED_ROW); // getSlackApiClient credential lookup
    setDbRow(null); // email-match exact-lookup misses
    slackUsersInfo.mockResolvedValue({ user: { profile: { email: 'nobody@external.com' } } });
    const user = await identify({
      adapter,
      event: makeEvent({ event: { user: 'U123' } }),
      trigger: { id: 't-1', kind: 'SLACK', config: {}, createdByUserId: 'creator-1' },
    });
    expect(user).toBeNull();
  });

  it('authenticates as creator when fallback is enabled and no email match', async () => {
    const adapter = new SlackAdapter(TEAM_ID, 'cred-1');
    slackUsersInfo.mockResolvedValue({ user: { profile: { email: 'nobody@external.com' } } });
    setDbRow(SLACK_CRED_ROW); // getSlackApiClient credential lookup
    setDbRow(null); // email-match exact-lookup misses
    setDbRow({ id: 'creator-1', email: 'creator@example.com', username: 'creator' });
    const user = await identify({
      adapter,
      event: makeEvent({ event: { user: 'U123' } }),
      trigger: {
        id: 't-1',
        kind: 'SLACK',
        config: { fallbackToCreatorIfActorUnregistered: true },
        createdByUserId: 'creator-1',
      },
    });
    expect(user).toEqual({ id: 'creator-1', email: 'creator@example.com', name: 'creator' });
  });

  it('rejects when fallback is enabled but trigger has no creator', async () => {
    const adapter = new SlackAdapter(TEAM_ID, 'cred-1');
    setDbRow(SLACK_CRED_ROW); // getSlackApiClient credential lookup
    setDbRow(null); // email-match exact-lookup misses
    slackUsersInfo.mockResolvedValue({ user: { profile: { email: 'nobody@external.com' } } });
    const user = await identify({
      adapter,
      event: makeEvent({ event: { user: 'U123' } }),
      trigger: {
        id: 't-1',
        kind: 'SLACK',
        config: { fallbackToCreatorIfActorUnregistered: true },
        createdByUserId: null,
      },
    });
    expect(user).toBeNull();
  });

  it('rejects when no trigger context is supplied and no email match', async () => {
    const adapter = new SlackAdapter(TEAM_ID, 'cred-1');
    setDbRow(SLACK_CRED_ROW); // getSlackApiClient credential lookup
    setDbRow(null); // email-match exact-lookup misses
    slackUsersInfo.mockResolvedValue({ user: { profile: { email: 'nobody@external.com' } } });
    const user = await identify({
      adapter,
      event: makeEvent({ event: { user: 'U123' } }),
    });
    expect(user).toBeNull();
  });

  // ── T6 — runtime email auto-match ──────────────────────────────────────
  it('auto-matches the actor email (users.info) to a Listen-Fire user', async () => {
    const adapter = new SlackAdapter(TEAM_ID, 'cred-1');
    slackUsersInfo.mockResolvedValue({ user: { profile: { email: 'Ada@Example.com' } } });
    setDbRow(SLACK_CRED_ROW); // getSlackApiClient credential lookup
    // Next DB row answers lookupTeamUserByEmail's exact-match pass.
    setDbRow({ id: 'user-h', email: 'ada@example.com', username: 'ada' });
    const user = await identify({
      adapter,
      event: makeEvent({ event: { user: 'U123' } }),
      trigger: { id: 't-1', kind: 'SLACK', config: {}, createdByUserId: 'creator-1' },
    });
    expect(slackUsersInfo).toHaveBeenCalledWith({ user: 'U123' });
    expect(user).toEqual({ id: 'user-h', email: 'ada@example.com', name: 'ada' });
  });

  it('propagates when users.info throws — a lookup failure, not a no-match (actor_gate catches it)', async () => {
    // A failed users.info is "couldn't check", distinct from "checked, no
    // match": resolveActorEmail throws so the caller (consultActorGate) can drop
    // the event as a replayable lookup failure rather than an unregistered
    // sender. Mirrors the getActorCandidates contract in actor_email.unit.test.
    const adapter = new SlackAdapter(TEAM_ID, 'cred-1');
    setDbRow(SLACK_CRED_ROW); // getSlackApiClient credential lookup
    slackUsersInfo.mockRejectedValue(new Error('missing_scope'));
    await expect(
      identify({
        adapter,
        event: makeEvent({ event: { user: 'U123' } }),
        trigger: { id: 't-1', kind: 'SLACK', config: {}, createdByUserId: 'creator-1' },
      }),
    ).rejects.toThrow('missing_scope');
  });

  it('falls through to creator when email resolves but matches no user and fallback on', async () => {
    const adapter = new SlackAdapter(TEAM_ID, 'cred-1');
    slackUsersInfo.mockResolvedValue({ user: { profile: { email: 'ext@other.com' } } });
    setDbRow(SLACK_CRED_ROW); // getSlackApiClient credential lookup
    setDbRow(null); // email-match exact-lookup misses
    setDbRow({ id: 'creator-1', email: 'creator@example.com', username: 'creator' });
    const user = await identify({
      adapter,
      event: makeEvent({ event: { user: 'U123' } }),
      trigger: {
        id: 't-1',
        kind: 'SLACK',
        config: { fallbackToCreatorIfActorUnregistered: true },
        createdByUserId: 'creator-1',
      },
    });
    expect(user?.id).toBe('creator-1');
  });

  it('returns null (no email) when no credentialsId is wired', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const user = await identify({
      adapter,
      event: makeEvent({ event: { user: 'U123' } }),
      trigger: { id: 't-1', kind: 'SLACK', config: {}, createdByUserId: 'creator-1' },
    });
    expect(slackUsersInfo).not.toHaveBeenCalled();
    expect(user).toBeNull();
  });

  // ── T6 — creator override ──────────────────────────────────────────────
  it('overrides to creator when overrideActingUserToCreator is set (skips email match)', async () => {
    const adapter = new SlackAdapter(TEAM_ID, 'cred-1');
    setDbRow({ id: 'creator-1', email: 'creator@example.com', username: 'creator' });
    const user = await identify({
      adapter,
      event: makeEvent({ event: { user: 'U123' } }),
      trigger: {
        id: 't-1',
        kind: 'SLACK',
        config: { overrideActingUserToCreator: true },
        createdByUserId: 'creator-1',
      },
    });
    expect(slackUsersInfo).not.toHaveBeenCalled();
    expect(user).toEqual({ id: 'creator-1', email: 'creator@example.com', name: 'creator' });
  });

  it('rejects when override is on but the trigger has no creator', async () => {
    const adapter = new SlackAdapter(TEAM_ID, 'cred-1');
    const user = await identify({
      adapter,
      event: makeEvent({ event: { user: 'U123' } }),
      trigger: {
        id: 't-1',
        kind: 'SLACK',
        config: { overrideActingUserToCreator: true },
        createdByUserId: null,
      },
    });
    expect(slackUsersInfo).not.toHaveBeenCalled();
    expect(user).toBeNull();
  });

  it('override leaves @actor_* (extractActor) showing the raw originator', async () => {
    const adapter = new SlackAdapter(TEAM_ID, 'cred-1');
    const actor = await adapter.extractActor({ event: makeEvent({ event: { user: 'U999' } }) });
    expect(actor).toEqual({ identifier: 'U999', scheme: 'opaque', adapterType: 'slack', label: 'U999' });
  });
});

describe('SlackAdapter.extractActor', () => {
  it('parses the user id from the event_callback envelope', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const actor = await adapter.extractActor({ event: makeEvent({ event: { user: 'U123', text: 'hi' } }) });
    expect(actor).toEqual({ identifier: 'U123', scheme: 'opaque', adapterType: 'slack', label: 'U123' });
  });

  it('parses the user id from a flat event payload', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const actor = await adapter.extractActor({ event: makeEvent({ user: 'U456' }) });
    expect(actor?.identifier).toBe('U456');
  });

  it('returns null when no user id is present', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const actor = await adapter.extractActor({ event: makeEvent({}) });
    expect(actor).toBeNull();
  });
});

// ── Attio ──────────────────────────────────────────────────────────────

describe('AttioAdapter acting-user', () => {
  it('rejects without creator fallback and no email match', async () => {
    const adapter = new AttioAdapter({ teamId: TEAM_ID, credentialsId: 'cred-1' });
    attioFetch.mockResolvedValue({ data: { email_address: 'someone@external.com' } });
    setDbRow(ATTIO_CRED_ROW); // getApiClient credential lookup
    setDbRow(null); // email-match exact-lookup misses
    const user = await identify({
      adapter,
      event: makeEvent({}, { id: 'wm-1', type: 'workspace-member' }),
      trigger: { id: 't-2', kind: 'ATTIO_WEBHOOK', config: {}, createdByUserId: 'creator-1' },
    });
    expect(user).toBeNull();
  });

  it('authenticates as creator when fallback enabled and no email match', async () => {
    const adapter = new AttioAdapter({ teamId: TEAM_ID, credentialsId: 'cred-1' });
    attioFetch.mockResolvedValue({ data: { email_address: 'someone@external.com' } });
    setDbRow(ATTIO_CRED_ROW); // getApiClient credential lookup
    setDbRow(null); // email-match exact-lookup misses
    setDbRow({ id: 'creator-2', email: 'creator2@example.com', username: 'c2' });
    const user = await identify({
      adapter,
      event: makeEvent({}, { id: 'wm-1', type: 'workspace-member' }),
      trigger: {
        id: 't-2',
        kind: 'ATTIO_WEBHOOK',
        config: { fallbackToCreatorIfActorUnregistered: true },
        createdByUserId: 'creator-2',
      },
    });
    expect(user?.id).toBe('creator-2');
  });

  // ── T6 — runtime email auto-match ──────────────────────────────────────
  it('auto-matches the workspace-member email to a Listen-Fire user', async () => {
    const adapter = new AttioAdapter({ teamId: TEAM_ID, credentialsId: 'cred-1' });
    attioFetch.mockResolvedValue({ data: { email_address: 'Ada@Example.com' } });
    setDbRow(ATTIO_CRED_ROW); // getApiClient credential lookup
    setDbRow({ id: 'user-h', email: 'ada@example.com', username: 'ada' });
    const user = await identify({
      adapter,
      event: makeEvent({}, { id: 'wm-1', type: 'workspace-member' }),
      trigger: { id: 't-2', kind: 'ATTIO_WEBHOOK', config: {}, createdByUserId: 'creator-2' },
    });
    expect(attioFetch).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/v2/workspace_members/wm-1', method: 'GET' }),
    );
    expect(user).toEqual({ id: 'user-h', email: 'ada@example.com', name: 'ada' });
  });

  it('does not call the API for api-token actors (no human email)', async () => {
    const adapter = new AttioAdapter({ teamId: TEAM_ID, credentialsId: 'cred-1' });
    const user = await identify({
      adapter,
      event: makeEvent({}, { id: 'tok-1', type: 'api-token' }),
      trigger: { id: 't-2', kind: 'ATTIO_WEBHOOK', config: {}, createdByUserId: 'creator-2' },
    });
    expect(attioFetch).not.toHaveBeenCalled();
    expect(user).toBeNull();
  });

  it('falls through to null when the member lookup throws (API error)', async () => {
    const adapter = new AttioAdapter({ teamId: TEAM_ID, credentialsId: 'cred-1' });
    setDbRow(ATTIO_CRED_ROW); // getApiClient credential lookup
    attioFetch.mockRejectedValue(new Error('403'));
    const user = await identify({
      adapter,
      event: makeEvent({}, { id: 'wm-1', type: 'workspace-member' }),
      trigger: { id: 't-2', kind: 'ATTIO_WEBHOOK', config: {}, createdByUserId: 'creator-2' },
    });
    expect(user).toBeNull();
  });

  // ── T6 — creator override ──────────────────────────────────────────────
  it('overrides to creator when overrideActingUserToCreator is set (skips email match)', async () => {
    const adapter = new AttioAdapter({ teamId: TEAM_ID, credentialsId: 'cred-1' });
    setDbRow({ id: 'creator-2', email: 'creator2@example.com', username: 'c2' });
    const user = await identify({
      adapter,
      event: makeEvent({}, { id: 'wm-1', type: 'workspace-member' }),
      trigger: {
        id: 't-2',
        kind: 'ATTIO_WEBHOOK',
        config: { overrideActingUserToCreator: true },
        createdByUserId: 'creator-2',
      },
    });
    expect(attioFetch).not.toHaveBeenCalled();
    expect(user?.id).toBe('creator-2');
  });

  it('rejects when override is on but the trigger has no creator', async () => {
    const adapter = new AttioAdapter({ teamId: TEAM_ID, credentialsId: 'cred-1' });
    const user = await identify({
      adapter,
      event: makeEvent({}, { id: 'wm-1', type: 'workspace-member' }),
      trigger: {
        id: 't-2',
        kind: 'ATTIO_WEBHOOK',
        config: { overrideActingUserToCreator: true },
        createdByUserId: null,
      },
    });
    expect(attioFetch).not.toHaveBeenCalled();
    expect(user).toBeNull();
  });
});

describe('AttioAdapter.extractActor', () => {
  it('reads actor.id from the event envelope', async () => {
    const adapter = new AttioAdapter({ teamId: TEAM_ID, credentialsId: 'cred-1' });
    const actor = await adapter.extractActor({
      event: makeEvent({}, { id: 'wm-789', type: 'workspace-member' }),
    });
    expect(actor).toEqual({ identifier: 'wm-789', scheme: 'opaque', adapterType: 'attio', label: 'wm-789' });
  });

  it('falls back to payload.actor.id when event.actor is absent', async () => {
    const adapter = new AttioAdapter({ teamId: TEAM_ID, credentialsId: 'cred-1' });
    const actor = await adapter.extractActor({ event: makeEvent({ actor: { id: 'wm-from-payload' } }) });
    expect(actor?.identifier).toBe('wm-from-payload');
  });

  it('returns null when nothing carries an actor id', async () => {
    const adapter = new AttioAdapter({ teamId: TEAM_ID, credentialsId: 'cred-1' });
    const actor = await adapter.extractActor({ event: makeEvent({}) });
    expect(actor).toBeNull();
  });
});
