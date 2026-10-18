/**
 * What a model does when NOBODY names a thinking depth.
 *
 * The tier map carries a written claim — opus-4-7 in that silence does not
 * think at all, opus-5 in the same silence thinks by default — and cites a
 * bake-off page that exists on no branch. The claim decides whether renaming a
 * model at a call site with a small output ceiling is safe, because thinking is
 * paid for out of that same ceiling. So it gets re-established rather than
 * trusted.
 *
 * The probe is deliberately the smallest thing that can answer it: one request
 * per model, straight at the platform client, with no `thinking` field on the
 * wire at all. What comes back is read at the block level — a `thinking` block
 * present or absent is the whole finding — and the token counts come along so
 * the cost of that silence is visible too.
 *
 *   pnpm dev:probe-thinking
 *   pnpm dev:probe-thinking --models claude-opus-5,claude-sonnet-5
 */
import type { ChatModelName } from 'movement-engine/public/models';

import { chatCallFor } from '../../lib/models/chat';
import { parseChatModelName } from 'movement-engine/public/models';

/** Every model the Claude 5 move has to decide about, plus the two already on
 *  5 that the claim says behave differently. */
const DEFAULT_MODELS: ChatModelName[] = [
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5',
];

/** Small enough to be free, and a question a model could plausibly want to
 *  reason about — a prompt with nothing to think about would not distinguish
 *  "does not think" from "had no reason to". */
const PROMPT =
  'A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Reply with just the number.';

/** The adaptive models decide per request whether the question is worth
 *  thinking about, so one easy prompt cannot settle "does it think by
 *  default" — it can only settle "did it think about THIS". `--hard` asks the
 *  same question of a prompt no model should answer off the cuff. */
const HARD_PROMPT =
  'Three switches outside a windowless room control three bulbs inside it. You may flip switches as much as you like, then enter the room exactly once. Explain how to tell which switch controls which bulb, in at most three sentences.';

const MAX_TOKENS = 4000;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

async function probe(model: ChatModelName, prompt: string): Promise<void> {
  const { client, wireModel } = chatCallFor(model);
  const started = Date.now();
  try {
    const reply = await client.messages.create({
      model: wireModel,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });
    const blocks = reply.content.map((block) => block.type);
    const thinking = reply.content.find((block) => block.type === 'thinking');
    const text = reply.content.find((block) => block.type === 'text');
    console.log(
      [
        `model            ${model}`,
        `block types      [${blocks.join(', ')}]`,
        `thinking block   ${thinking ? 'PRESENT' : 'absent'}`,
        `stop reason      ${reply.stop_reason}`,
        `input tokens     ${reply.usage.input_tokens}`,
        `output tokens    ${reply.usage.output_tokens}`,
        `visible text     ${JSON.stringify(text && text.type === 'text' ? text.text.slice(0, 200) : null)}`,
        `thinking chars   ${thinking && thinking.type === 'thinking' ? thinking.thinking.length : 0}`,
        `latency ms       ${Date.now() - started}`,
      ].join('\n'),
    );
  } catch (error) {
    console.log(`model            ${model}\nFAILED           ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const models =
    flag('models')
      ?.split(',')
      .map((name) => parseChatModelName(name, '--models')) ?? DEFAULT_MODELS;
  const prompt = process.argv.includes('--hard') ? HARD_PROMPT : PROMPT;
  console.log(`no thinking field on the wire; max_tokens ${MAX_TOKENS}\nprompt: ${prompt}\n`);
  for (const model of models) await probe(model, prompt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
