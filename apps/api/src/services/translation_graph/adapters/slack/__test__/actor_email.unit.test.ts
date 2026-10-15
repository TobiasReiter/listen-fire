// resolveActorEmail / getActorCandidates — genuine misses (no actor, no
// client, no email on the profile) swallow to an empty candidate list; a
// `users.info` call that itself FAILS (missing scope, rate limit, network
// outage) must not be swallowed the same way, since a caller can't tell
// "actor unregistered" apart from "couldn't check" once both read as `[]`.
// The Slack web client is mocked by overriding the adapter's private
// getter — no network, no DB.

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';

import { SlackAdapter } from '../index';

const TEAM = 'team-1' as TeamId;

function adapterWithClient(client: unknown): SlackAdapter {
  const adapter = new SlackAdapter(TEAM, 'cred-1');
  (adapter as unknown as { getSlackApiClient: () => Promise<unknown> }).getSlackApiClient =
    async () => client;
  return adapter;
}

const event = (payload: unknown): TriggerEvent => ({
  pipelineInputId: 'trigger:t1',
  adapterType: 'slack',
  triggerType: 'webhook',
  payload,
  occurredAt: new Date().toISOString(),
});

describe('SlackAdapter#getActorCandidates — lookup failure vs genuine miss', () => {
  it('resolves an empty candidate list when the profile carries no email (genuine miss)', async () => {
    const adapter = adapterWithClient({
      api: { users: { info: async () => ({ user: { profile: {} } }) } },
    });
    await expect(
      adapter.getActorCandidates({ event: event({ user: 'U123' }) }),
    ).resolves.toEqual([]);
  });

  it('resolves an empty candidate list when the event has no actor at all', async () => {
    const adapter = adapterWithClient({
      api: { users: { info: async () => ({ user: { profile: { email: 'ada@example.com' } } }) } },
    });
    await expect(adapter.getActorCandidates({ event: event({}) })).resolves.toEqual([]);
  });

  it('REJECTS (does not swallow to []) when users.info itself fails — a Slack outage', async () => {
    const adapter = adapterWithClient({
      api: {
        users: {
          info: async () => {
            throw new Error('missing_scope');
          },
        },
      },
    });
    await expect(
      adapter.getActorCandidates({ event: event({ user: 'U123' }) }),
    ).rejects.toThrow('missing_scope');
  });
});
