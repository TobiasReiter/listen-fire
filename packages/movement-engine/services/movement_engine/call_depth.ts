// The maximum CALL DEPTH of a movement run (language version 3).
//
// From version 3 a function may call itself, directly or through others. A
// recursion that never reaches its base case would otherwise run until the
// process ran out of stack — or, where every level makes a priced call, until
// the cost cap stopped it, having spent the cap. The depth limit stops it
// first, and says which chain of calls it was.
//
// What counts is a call BY NAME: a movement or function, or a closure bound to
// a name, called directly, or handed by name to `MAP` and the other collection
// ops or to `race` / `parallel`. A function written in place
// (`MAP(xs, (x) => …)`) has no name to call itself by, so it cannot recurse
// and does not count: the limit reads as "how many named calls deep", which is
// what an author can see in the text. The movement the run started in is not a
// call. Depth is per FLOW: two `MAP` members or two `parallel` arms calling the
// same function at once are side by side, not nested, so each counts its own
// chain.
//
// Not forgivable by `onError` (ruled 2026-10-05, as the cost cap is): the limit
// is the operator's safeguard against a run that has gone wrong, not a failure
// of one member's data. Forgiving it would let raising or lowering the knob
// silently change which members a `MAP` answers for.
//
// Versions 1 and 2 keep their ban on recursion — a call to a movement already
// on the call stack fails — and have no depth limit.

import { MovementEngineError } from './errors';

export const CALL_DEPTH_ENV_VAR = 'MOVEMENT_MAX_CALL_DEPTH';

export const DEFAULT_MAX_CALL_DEPTH = 32;

/** The limit, or the default when unset. Throws on a value that is set but is
 *  not a positive whole number — a typo here must not read as "no limit". */
export function parseMaxCallDepth(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CALL_DEPTH;
  const depth = Number(raw.trim());
  if (!Number.isInteger(depth) || depth <= 0) {
    throw new Error(
      `${CALL_DEPTH_ENV_VAR}="${raw}" is not a positive whole number. ` +
        `Set it to how many calls deep one movement run may nest (e.g. ${CALL_DEPTH_ENV_VAR}=${DEFAULT_MAX_CALL_DEPTH}), ` +
        `or leave it unset for the default of ${DEFAULT_MAX_CALL_DEPTH}.`,
    );
  }
  return depth;
}

/** Boot: refuse a limit set to nonsense, rather than letting the first deep
 *  call find out. */
export function assertMaxCallDepthConfigured(env: NodeJS.ProcessEnv = process.env): void {
  parseMaxCallDepth(env[CALL_DEPTH_ENV_VAR]);
}

/** Read per call so ops (and tests) can move the limit without a restart. */
export function maxCallDepth(): number {
  return parseMaxCallDepth(process.env[CALL_DEPTH_ENV_VAR]);
}

/** A long chain, shortened to its two ends — the start says where it came
 *  from, the end which calls were repeating. */
function describeChain(chain: readonly string[]): string {
  if (chain.length <= 12) return chain.join(' → ');
  const omitted = chain.length - 10;
  return [...chain.slice(0, 4), `… ${omitted} more …`, ...chain.slice(-6)].join(' → ');
}

/** Thrown at the call that would have gone one deeper than the limit. Its
 *  message is the whole failure surface an author sees, so it says the chain,
 *  the limit and the knob. */
export class CallDepthExceeded extends MovementEngineError {
  constructor(
    readonly limit: number,
    /** The run's movement, then each call it is inside, then the refused one. */
    readonly chain: readonly string[],
  ) {
    super(
      'MOVENG_CALL_DEPTH',
      `call depth limit reached: '${describeChain(chain)}' would nest ${chain.length - 1} calls deep, ` +
        `and the limit set by ${CALL_DEPTH_ENV_VAR} is ${limit}. The run was stopped in case a recursion never ` +
        'reaches the case that ends it. If this run legitimately needs to go deeper, raise ' +
        `${CALL_DEPTH_ENV_VAR} in the server's environment.`,
    );
    this.name = 'CallDepthExceeded';
  }
}

export function isCallDepthExceeded(err: unknown): err is CallDepthExceeded {
  return err instanceof CallDepthExceeded;
}
