// The models a customer's `AI(…)` reaches. By default a fake that answers
// without the network and charges a fixed price per call, so the cost cap
// can be seen to hold; with ANTHROPIC_API_KEY set, Claude through the
// engine's own Anthropic client, charged at its real price.

import { anthropicClient, anthropicKeyedChatProvider, models, type ChatModelName } from '@lf/engine/public/anthropic';
import { makeAnthropicLlmClient } from '@lf/engine/public/models';
import type { ModelClient } from '@lf/engine/public/embed';

/** What the fake charges for one call, in microdollars. */
export const FAKE_CALL_MICRODOLLARS = 2_000;

/** Answers every call with the last line of its prompt, at a fixed price. */
export function fakeModels(): ModelClient {
  return {
    call: async (input) => {
      const lastLine = input.userMessage.trim().split('\n').at(-1) ?? '';
      return {
        parsedJson: { answer: `(fake model) ${lastLine.slice(0, 200)}` },
        cost: [{ source: 'fake-model', microdollars: FAKE_CALL_MICRODOLLARS }],
      };
    },
  };
}

/** Claude, on the SaaS's own Anthropic key. */
export function anthropicModels(apiKey: string): ModelClient {
  const client = anthropicClient({
    chatCallFor: (name: ChatModelName) => {
      if (models[name].home !== 'anthropic') throw new Error(`model "${name}" is not served by Anthropic`);
      return {
        client: anthropicKeyedChatProvider({ apiKey }),
        wireModel: name,
        resolved: { preferred: name, provider: 'anthropic', wireModel: name },
      };
    },
    recordUsage: async () => {},
    logFields: () => ({}),
  });
  return makeAnthropicLlmClient({ chat: client.anthropicChatDetailed });
}

/** The models this process uses: Claude when it has a key, else the fake. */
export function modelsFromEnv(env: Readonly<Record<string, string | undefined>>): ModelClient {
  const key = env.ANTHROPIC_API_KEY;
  return key !== undefined && key !== '' ? anthropicModels(key) : fakeModels();
}
