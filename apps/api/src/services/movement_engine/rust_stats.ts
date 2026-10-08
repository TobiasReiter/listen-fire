// What the Rust engine did in this process, counted where the TypeScript
// side hands it work (rust_engine.ts). The conformance runs print it and fail
// a Rust run Rust answered nothing in (src/test/rust_eval_stats.*). Its own
// module, importing nothing: a jest setup file reads it, and a setup file
// that loaded the engine would load it before a test's module mocks apply.

/**
 * What the evaluator switch did in this process: expressions it did not send
 * (`notAdmitted`), sent (`admitted`), had answered by Rust (`answered`, a
 * thrown error included) and had handed back, by Rust's reason (`fallback`).
 * The conformance runs print it and fail on a Rust run Rust answered nothing in.
 */
export const rustEvalStats: {
  notAdmitted: number;
  admitted: number;
  answered: number;
  fallback: Record<string, number>;
} = { notAdmitted: 0, admitted: 0, answered: 0, fallback: {} };

export function resetRustEvalStats(): void {
  rustEvalStats.notAdmitted = 0;
  rustEvalStats.admitted = 0;
  rustEvalStats.answered = 0;
  rustEvalStats.fallback = {};
}

/**
 * What happened to each whole run under `MOVEMENT_ENGINE=rust`, by where it
 * was decided:
 *
 * - `notAdmitted`: never run in Rust, by reason — refused by the shim's input
 *   checks before a segment opened (a limit pause, a cost cap, an input that
 *   cannot cross the eval wire), or by the engine's own admission on its own
 *   parse before it asked its host for anything (crates/movement-engine's
 *   README lists every reason);
 * - `routed`: segments the Rust engine started, its admission refusals
 *   among them;
 * - `admitted`: routed segments its admission let by (`routed` less its
 *   refusals);
 * - `ranWhole`: routed runs it ran to their end (a run's own failure
 *   included);
 * - `declined`: routed runs it admitted and then declined, after the check
 *   and before anything the host can see, by reason;
 * - `shimFaults`: routed runs that ended in a fault of the shim's own
 *   (`RustShimError`);
 * - `hostCalls`: the host calls segments made, by `family.method`.
 *
 * Every run that `notAdmitted` or `declined` counts ran on the TypeScript
 * engine instead.
 */
export const rustRunStats: {
  routed: number;
  admitted: number;
  ranWhole: number;
  shimFaults: number;
  notAdmitted: Record<string, number>;
  declined: Record<string, number>;
  hostCalls: Record<string, number>;
} = {
  routed: 0,
  admitted: 0,
  ranWhole: 0,
  shimFaults: 0,
  notAdmitted: {},
  declined: {},
  hostCalls: {},
};

export function resetRustRunStats(): void {
  rustRunStats.routed = 0;
  rustRunStats.admitted = 0;
  rustRunStats.ranWhole = 0;
  rustRunStats.shimFaults = 0;
  rustRunStats.notAdmitted = {};
  rustRunStats.declined = {};
  rustRunStats.hostCalls = {};
}
