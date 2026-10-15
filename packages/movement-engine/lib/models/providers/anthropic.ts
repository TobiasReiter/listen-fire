// Anthropic's own API on a key the caller holds, passed through: the seam IS
// this SDK's shape.

import Anthropic from '@anthropic-ai/sdk';

import type { ChatProvider } from '../chat';

export interface AnthropicKey {
  apiKey: string;
  /** Another endpoint speaking the same Messages API (a proxy, a test fake). */
  baseUrl?: string;
}

// One per key rather than one per process: a unit that pays with its own key
// (knowledge's `KNOWLEDGE_LLM_API_KEY`) must not share the platform's client.
const keyedClients = new Map<string, Anthropic>();

export function anthropicKeyedChatProvider({ apiKey, baseUrl }: AnthropicKey): ChatProvider {
  const cacheKey = `${baseUrl ?? ''}\n${apiKey}`;
  let keyed = keyedClients.get(cacheKey);
  if (!keyed) {
    keyed = new Anthropic({ apiKey, ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}) });
    keyedClients.set(cacheKey, keyed);
  }
  return keyed;
}
