// The hosted product's Anthropic client: the shared one (movement-engine's
// lib/anthropic), routed by this deployment's MODEL_MAP and environment and
// billed to the ambient llm-usage context.

import { anthropicClient } from 'movement-engine/lib/anthropic';
import { chatCallFor } from '../models/chat';
import { recordLlmUsage, runFields } from '../llm_usage';

// Each hook reaches its import at call time, so a test that mocks the routing
// or the billing module is heard by the client built here.
export const {
  anthropicToolLoop,
  anthropicChat,
  anthropicChatDetailed,
  anthropicChatStructured,
  anthropicWebChat,
} = anthropicClient({
  chatCallFor: (name) => chatCallFor(name),
  recordUsage: (usage) => recordLlmUsage(usage),
  logFields: () => runFields(),
});

export {
  defaultPageReader,
  meterAnthropicUsage,
  MAX_CHAT_CONTINUATIONS,
  StructuredOutputError,
} from 'movement-engine/lib/anthropic';
export type {
  AnthropicChatOptions,
  AnthropicChatStructuredOptions,
  AnthropicSystemBlock,
  AnthropicToolLoopParams,
  AnthropicUsageTally,
  AnthropicUserBlock,
  AnthropicWebChatOptions,
  AnthropicWebChatReply,
  ChatReply,
  PageFetcher,
  PageFetchResult,
  PageReader,
  SearchHit,
  TurnEvent,
  WebSearcher,
  WebSearchResult,
  WebToolEvent,
} from 'movement-engine/lib/anthropic';
