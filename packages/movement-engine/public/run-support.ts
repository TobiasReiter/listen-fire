// What a shell needs around running movements beside the front door
// (`public/movement-engine`): the engine's error type and codes, a step's
// address inside a run, the configuration checks a shell runs at boot, which
// engine ran a run, the file listeners a program declares, the host's segment
// bookkeeping, the trace a run records, and the request context id the logger
// reads.

export * from '../services/movement_engine/errors';
export * from '../services/movement_engine/address';
export { assertExtractionTiersConfigured } from '../services/movement_engine/ai_tiers';
export { assertMaxCallDepthConfigured } from '../services/movement_engine/call_depth';
export { listUnsupportedConstructs } from '../services/movement_engine/interpretable';
export * from '../services/movement_engine/rust_stats';
export { RUST_ENGINE_FROM_VERSION } from '../services/movement_engine/rust_engine';
export {
  isWriteEffect,
  type FileTextResolution,
  type MovementTraceEntry,
} from '../services/movement_engine/expression';
export * from '../services/translation_graph/movement/file_listeners';
export { hostSegments, segmentScopedCalls } from '../services/translation_graph/segment_scope';
export * from '../services/context/current_id';
