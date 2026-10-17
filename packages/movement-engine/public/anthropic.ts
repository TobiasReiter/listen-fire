// The Anthropic client a module builds over its own model access (a plugin
// module that calls models: `@lf/web`), the usage metering that tallies a
// call's tokens, the page reader and searcher types its web turns use, the
// reading of a model's JSON reply, and the model names, prices and cost
// envelope such a module reads. Kept to what a module process needs, so
// serving one does not load the engine's extraction clients or its identity
// judge (`public/models`).

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
export { models, type ChatModelName } from '../lib/models/registry';
export { resolveModel } from '../lib/models/map';
export type { ChatCall } from '../lib/models/chat';
export { costMicrodollars } from '../lib/models/pricing';
export { costEnvelopeMicrodollars, type CostEnvelope } from '../lib/run_cost';
