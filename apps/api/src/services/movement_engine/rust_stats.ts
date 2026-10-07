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
