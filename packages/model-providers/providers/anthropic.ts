// Anthropic's own API, passed through: the seam IS this SDK's shape.

import type Anthropic from '@anthropic-ai/sdk';

import type { ChatProvider } from 'movement-engine/public/models';

// Built at first use, not at import: a host that routes every name elsewhere
// need not hold a key, nor install the SDK.
let client: Anthropic | undefined;

export function anthropicChatProvider(env: NodeJS.ProcessEnv): ChatProvider {
  if (client) return client;
  const { apiKey } = anthropicKeyFrom(env);
  const sdk: typeof import('@anthropic-ai/sdk') = require('@anthropic-ai/sdk');
  return (client = new sdk.default({ apiKey }));
}

function anthropicKeyFrom(env: NodeJS.ProcessEnv): { apiKey: string } {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey === undefined) {
    throw new Error(
      'The ANTHROPIC_API_KEY environment variable is required — it is the key for every model name that resolves to the anthropic provider',
    );
  }
  return { apiKey };
}
