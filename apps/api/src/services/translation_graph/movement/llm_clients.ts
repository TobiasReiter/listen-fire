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

/** Ops calibration knob for the extraction loop guard, read off `process.env`
 *  (the `LOOP_GUARD_*` idiom, not the prod-required `getEnvVar`): unset must
 *  fall back to trusting the model, in every environment including production. */
function extractionOutputBudgetEnabled(): boolean {
  const raw = process.env.EXTRACTION_OUTPUT_BUDGET;
  return raw === '1' || raw === 'true';
}

// Reached at call time rather than bound once, so a test that mocks the
// client module is heard here.
const chat: typeof anthropicChatDetailed = (options) => anthropicChatDetailed(options);

export function makeAnthropicLlmClient(options: HostedModelClientOptions = {}): LlmClient {
  return makeLlmClient({ ...options, chat, outputBudget: extractionOutputBudgetEnabled() });
}

export function makeAnthropicExtractCallClient(options: HostedModelClientOptions = {}): ExtractCallLlmClient {
  return makeExtractCallClient({ ...options, chat, outputBudget: extractionOutputBudgetEnabled() });
}
