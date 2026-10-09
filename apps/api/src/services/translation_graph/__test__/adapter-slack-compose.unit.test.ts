/**
 * Unit tests for SLACK_MESSAGE — the Slack adapter's field function (C7).
 *
 * Verifies the compose step is roster-free and channel-blind: it builds a
 * Slack-formatting system prompt (teaching the `@[Name]` mention convention)
 * plus a user message carrying the author's brief and the bare data, calls the
 * LLM, and returns the text verbatim — `@[Name]` tokens intact, to be resolved
 * at the write boundary (S4). Also checks the function is advertised on the
 * message `text` fields and that `invokeFieldFunction` routes to it.
 *
 * The LLM (`anthropicChat`) is mocked — no network.
 */

const mockChatCalls: Array<{ system: string; userMessage: string }> = [];
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: (options: { system: string; userMessage: string }) => {
    mockChatCalls.push(options);
    return Promise.resolve('*Thanks @[Ada Okafor] for leading the Acme round!* 🎉');
  },
}));

import type { TeamId } from '../../../generated/kysely/core/Team';

import { SlackAdapter, SLACK_MESSAGE_TYPE_ID } from '../adapters/slack';
import { composeSlackMessage } from '../adapters/slack/compose';

const TEAM_ID = 'team-1' as TeamId;
const COMPOSED = '*Thanks @[Ada Okafor] for leading the Acme round!* 🎉';

beforeEach(() => {
  mockChatCalls.length = 0;
});

describe('SLACK_MESSAGE — advertisement', () => {
  it('is advertised on the unified message `Message` (text) field', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const desc = await adapter.describe(SLACK_MESSAGE_TYPE_ID);
    const text = desc?.fields.find((f) => f.fieldId === 'text');
    expect(text?.functions?.map((fn) => fn.name)).toContain('SLACK_MESSAGE');
  });

  it('is NOT advertised on the read-only Channel field or the File field', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const desc = await adapter.describe(SLACK_MESSAGE_TYPE_ID);
    expect(desc?.fields.find((f) => f.fieldId === 'channel')?.functions).toBeUndefined();
    expect(desc?.fields.find((f) => f.fieldId === 'file')?.functions).toBeUndefined();
  });
});

describe('composeSlackMessage', () => {
  it('builds a Slack system prompt + a user message carrying the brief and data', async () => {
    const out = await composeSlackMessage({
      instructions: 'thank them for leading the round',
      data: ['Ada Okafor', 'Acme Series A'],
    });
    expect(out).toBe(COMPOSED);

    const { system, userMessage } = mockChatCalls[0];
    expect(system).toMatch(/@\[Name\]/); // mention convention taught
    expect(system).toMatch(/\*bold\*/); // mrkdwn rules present
    expect(userMessage).toContain('thank them for leading the round');
    expect(userMessage).toContain('Ada Okafor');
    expect(userMessage).toContain('Acme Series A');
  });

  it('drops null/undefined/empty data values from the user message', async () => {
    await composeSlackMessage({ instructions: 'hi', data: [null, undefined, '', 'Keep'] });
    expect(mockChatCalls[0].userMessage).toContain('Keep');
    expect(mockChatCalls[0].userMessage).not.toMatch(/-\s*$/m); // no empty bullet line
  });

  it('renders array data as a joined value', async () => {
    await composeSlackMessage({ instructions: 'hi', data: [['a', 'b', 'c']] });
    expect(mockChatCalls[0].userMessage).toContain('a, b, c');
  });
});

describe('SlackAdapter.invokeFieldFunction', () => {
  it('routes SLACK_MESSAGE to the composer', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const composed = await adapter.invokeFieldFunction({
      recordType: SLACK_MESSAGE_TYPE_ID,
      fieldId: 'text',
      functionName: 'SLACK_MESSAGE',
      args: { instructions: 'thank them', data: [] },
    });
    expect(composed).toBe(COMPOSED);
  });

  it('rejects an unknown function name', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    await expect(
      adapter.invokeFieldFunction({
        recordType: SLACK_MESSAGE_TYPE_ID,
        fieldId: 'text',
        functionName: 'NOPE',
        args: { instructions: '', data: [] },
      }),
    ).rejects.toThrow(/unknown function "NOPE"/);
  });
});
