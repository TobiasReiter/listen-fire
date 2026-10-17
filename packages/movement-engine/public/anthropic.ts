// The Anthropic client a module builds over its own model access (a plugin
// module that calls models: `@lf/web`), the usage metering that tallies a
// call's tokens, the page reader and searcher types its web turns use, and the
// reading of a model's JSON reply.

export {
  anthropicClient,
  defaultPageReader,
  meterAnthropicUsage,
  StructuredOutputError,
  type AnthropicChatOptions,
  type AnthropicChatStructuredOptions,
  type AnthropicClient,
  type AnthropicUsageTally,
  type AnthropicWebChatOptions,
  type AnthropicWebChatReply,
  type LlmUsage,
  type ModelAccess,
  type PageFetcher,
  type PageFetchResult,
  type PageReader,
  type SearchHit,
  type WebSearcher,
  type WebSearchResult,
  type WebToolEvent,
} from '../lib/anthropic';
export { anthropicKeyedChatProvider, type AnthropicKey } from '../lib/models/providers/anthropic';
export { parseJson } from '../lib/utils/parse_json';
