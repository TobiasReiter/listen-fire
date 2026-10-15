// The hosted product's model clients: the shared ones (movement-engine's
// movement/llm_clients) on this deployment's Anthropic client.

import type { ExtractCallLlmClient } from 'movement-engine/services/movement_engine/extraction_call';
import type { CancelGate } from 'movement-engine/services/movement_engine/run';
import type { LlmClient } from '../engine/batched_extraction';

import { anthropicChatDetailed } from '../../../lib/anthropic';
import {
  makeAnthropicExtractCallClient as makeExtractCallClient,
  makeAnthropicLlmClient as makeLlmClient,
} from 'movement-engine/services/translation_graph/movement/llm_clients';

interface HostedModelClientOptions {
  cancel?: CancelGate;
}

// Reached at call time rather than bound once, so a test that mocks the
// client module is heard here.
const chat: typeof anthropicChatDetailed = (options) => anthropicChatDetailed(options);

export function makeAnthropicLlmClient(options: HostedModelClientOptions = {}): LlmClient {
  return makeLlmClient({ ...options, chat });
}

export function makeAnthropicExtractCallClient(options: HostedModelClientOptions = {}): ExtractCallLlmClient {
  return makeExtractCallClient({ ...options, chat });
}
