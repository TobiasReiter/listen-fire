// Anthropic's own API, passed through: the seam IS this SDK's shape.

import Anthropic from '@anthropic-ai/sdk';

import type { ChatProvider } from '../chat';

import { getEnvVar } from '../../utils/environment';

// Built at first use, not at import: `getEnvVar` throws in production on an
// unset key, and merely importing this must not stop a deployment that routes
// every name elsewhere from booting.
let client: Anthropic | undefined;

export function anthropicChatProvider(env: NodeJS.ProcessEnv = process.env): ChatProvider {
  return (client ??= new Anthropic({
    // An explicitly passed environment answers first, so a caller that threads
    // one is not silently overruled by `process.env`.
    apiKey:
      env.ANTHROPIC_API_KEY ??
      getEnvVar('ANTHROPIC_API_KEY', {
        devDefault: 'test',
        because: 'it is the key for every model name that resolves to the anthropic provider',
      }),
  }));
}

// One per key rather than one per process: a unit that pays with its own key
// (knowledge's `KNOWLEDGE_LLM_API_KEY`) must not share the platform's client.
const keyedClients = new Map<string, Anthropic>();

/** Anthropic's own API on a key the caller holds, rather than the platform's. */
export function anthropicKeyedChatProvider(apiKey: string): ChatProvider {
  let keyed = keyedClients.get(apiKey);
  if (!keyed) {
    keyed = new Anthropic({ apiKey });
    keyedClients.set(apiKey, keyed);
  }
  return keyed;
}
