// SLACK_MESSAGE — Slack's field function for composing a message body.
//
// Relocates the v3 Slack output adapter's compose path
// (`knowledge_pipeline/output_v3/adapters/slack.ts`) into the TG Slack adapter
// as an adapter-provided expression function (P8). The author writes
// `SLACK_MESSAGE("brief", …data)` against a message `text` field; the adapter
// runs an LLM call with its own Slack-formatting system prompt and returns
// mrkdwn carrying `@[Name]` mention tokens.
//
// Mentions are resolved to `<@id>` later, at the write boundary (`write.ts`),
// where the channel — and thus the roster — is known. This compose step is
// therefore deliberately roster-free and channel-blind.

import type { FieldFunctionDescriptor } from 'movement-engine/services/translation_graph/types';

/** Advertised on the message `text` fields (post-message + thread-reply). */
export const SLACK_MESSAGE_FUNCTION: FieldFunctionDescriptor = {
  name: 'SLACK_MESSAGE',
  displayName: 'Compose Slack message',
  summary:
    'Write a Slack-formatted message from a brief plus any supporting data. ' +
    'Ask the brief to mention someone and the posted message will tag them.',
  params: [
    {
      name: 'instructions',
      kind: 'string',
      doc: 'What the message should say — a brief in your own words, not the final text.',
    },
    {
      name: 'data',
      kind: 'value',
      variadic: true,
      doc:
        'Any values the message can draw on (names, amounts, links). Bare values — ' +
        'wrap one in CONCAT if you want to label it, e.g. CONCAT("deal: ", `Deal`.name).',
    },
  ],
  // It writes the message with a model (`composeSlackMessage`) and touches
  // nothing else — no source is read, nothing is written, the clock is never
  // consulted. An empty row would be the wrong claim; this is the right one.
  effects: { ai: true },
};

// Relocated verbatim-in-spirit from v3 `SLACK_SYSTEM_PROMPT_EXTENSION`, plus
// the `@[Name]` mention convention this design adds (the model has no roster,
// so it emits a delimited name token the write step resolves).
const SLACK_SYSTEM_PROMPT = `You are composing a message that will be posted to Slack. Write only the message body — no preamble, no surrounding quotes.

Use Slack-native ("mrkdwn") formatting only:
- Bold: *bold*  (never **bold**)
- Italic: _italic_
- Strikethrough: ~strike~
- Link: <https://example.com|display text>  (angle brackets and a pipe; never [text](url))
- Inline code: \`code\`;  code block: triple backticks
- Emoji: :emoji_name:
Do NOT use markdown headings (#) or markdown bold/links — Slack shows the raw characters.

To mention a person, write their name wrapped as @[Name] — for example @[Frank Smith]. Only use names that appear in the brief or the data; never invent a Slack id. If no mention is called for, don't add one.`;

function renderDatum(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(renderDatum).join(', ');
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function buildUserMessage(instructions: string, data: unknown[]): string {
  const lines: string[] = [instructions.trim()];
  const rendered = data
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map((v) => `- ${renderDatum(v)}`);
  if (rendered.length > 0) {
    lines.push('', 'Data you can use:', ...rendered);
  }
  return lines.join('\n');
}

/**
 * Run the SLACK_MESSAGE compose. Returns mrkdwn carrying `@[Name]` mention
 * tokens (resolved to `<@id>` at the write boundary). Roster-free.
 */
export async function composeSlackMessage(args: {
  instructions: string;
  data: unknown[];
}): Promise<string> {
  // Lazy-require to dodge the chat wrapper's transitive Prisma dependency in
  // unit tests (same reason as engine/expression.ts:callLLM).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { anthropicChat }: typeof import('../../../../lib/anthropic') = require('../../../../lib/anthropic');
  const text = await anthropicChat({
    model: 'claude-sonnet-5',
    temperature: 0,
    label: 'slack_message_compose',
    system: SLACK_SYSTEM_PROMPT,
    userMessage: buildUserMessage(args.instructions, args.data),
  });
  return text.trim();
}
