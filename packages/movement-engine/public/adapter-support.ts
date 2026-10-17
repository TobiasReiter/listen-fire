// What a built-in adapter module reaches beside the adapter contract: the run
// segment's read memo, call counter and call ceiling (each one passes straight
// through outside a segment, so a module served as a process simply has
// none), a bounded-concurrency queue, lenient JSON parsing of a provider's or
// a model's reply, option matching, and the uniqueness rules a resolver
// answers. `withSegment` is for a module's tests, which open one.

export {
  AdapterCallCeilingExceeded,
  bindAdapterCallCounter,
  fillMemoisedRead,
  forgetMemoisedReads,
  forgetMemoisedReadsUnder,
  isAdapterCallCeilingExceeded,
  memoisedRead,
  withSegment,
  type AdapterCallSystem,
} from '../services/translation_graph/segment_scope';
export { Queue } from '../lib/utils/queue';
export { parseJson, parseJsonReply } from '../lib/utils/parse_json';
export { matchOption } from '../lib/utils/string';
export type { UniquenessConstraints } from '../services/translation_graph/uniqueness';
