// Models, their registry and per-environment map, the clients that call them,
// the money a run spends on them and their prices, the identity judge (the
// model-backed decision of whether two records are the same entity) and the
// uniqueness rules it arbitrates with, the model calls the engine makes (the
// extraction and transform call shapes, the batched extraction client and its
// model choice), and the embedding models and their destinations.

export * from '../lib/models/registry';
export * from '../lib/models/map';
export * from '../lib/models/chat';
export * from '../lib/run_cost';
export * from '../lib/run_spend';
export * from '../lib/models/pricing';
export * from '../services/identity_judge/judge';
export {
  makeAnthropicExtractCallClient,
  makeAnthropicLlmClient,
  type ModelClientOptions,
} from '../services/translation_graph/movement/llm_clients';
export { metered, refusingPastBudget } from '../services/translation_graph/movement/metered';
export * from '../services/translation_graph/uniqueness';
export type {
  FileUnreadable,
  TransformInvocationResult,
  TransformInvokeInput,
} from '../services/movement_engine/extraction';
export type { ExtractCallLlmClient } from '../services/movement_engine/extraction_call';
export * from '../services/translation_graph/engine/batched_extraction/llm_call';
export * from '../services/translation_graph/engine/batched_extraction/model_choice';
export * from '../lib/models/embedding/destinations';
export * from '../lib/models/embedding/range';
