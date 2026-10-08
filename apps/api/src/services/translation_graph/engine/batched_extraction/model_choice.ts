// Which model an extraction runs on, by how many entities it declares: pure
// computation over a count, which the engine and the extraction pipeline
// share.

/**
 * Inherited from legacy `extract.ts`. Entity-count threshold above
 * which the pipeline routes to Opus (rather than Sonnet) for the
 * main extraction call. The two-phase skeleton+expand path is
 * triggered by the same threshold when no transform dictates a
 * skeleton pass.
 */
export const ENTITY_DENSITY_OPUS_THRESHOLD = 30;

/**
 * Model selection by entity density — direct port of legacy
 * `useOpus = entityCount >= ENTITY_DENSITY_OPUS_THRESHOLD`.
 */
export function selectModel(entityCount: number): 'opus' | 'sonnet' {
  return entityCount >= ENTITY_DENSITY_OPUS_THRESHOLD ? 'opus' : 'sonnet';
}
