// Embedding the engine in another product's own process: the in-process host
// to fill with the embedder's own parts (its adapters, models, files, parks),
// the write locks it starts from, the instance schema it reads off each
// adapter it loaded, and the routing table it reads off a customer's
// movement (its `listen` statements). docs/embedding.md walks through it.

export { inProcessHost, type InProcessHostOptions } from '../services/embed/in_process_host';
export { introspectAdapter } from '../services/embed/introspect';
export { InMemoryWriteLocks, type WriteLocks } from '../services/write_locks/write_locks';
export { collectFileListeners, type FileListener } from '../services/translation_graph/movement/file_listeners';
export { MovementEngineError, isCheckFailure, type MovementEngineErrorCode } from '../services/movement_engine/errors';
export { pricedModels, type ExtractCallModelClient, type ModelClient } from '../services/embed/models';
export type { LlmCallInput, LlmCallResult } from '../services/translation_graph/engine/batched_extraction/llm_call';
export type { ExtractCallLlmInput, ExtractCallLlmResult } from '../services/movement_engine/extraction_call';
export type { SegmentLimits } from 'engine-contracts';
