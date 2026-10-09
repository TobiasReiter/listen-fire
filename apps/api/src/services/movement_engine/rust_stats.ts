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
 *   checks before a segment opened (an input that cannot cross the eval
 *   wire, a resume this engine does not answer), or by the engine's own
 *   admission on its own parse before it asked its host for anything
 *   (crates/movement-engine's README lists every reason);
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
 *
 * `dryRun` is the other direction: what the Rust engine's admission says of
 * each run `MOVEMENT_ENGINE` sends to the TypeScript engine, asked without
 * running it (rust_engine.ts `dryAdmitRun`), so the reasons left to burn down
 * are counted by what production runs, not by what a test corpus holds.
 */
export const rustRunStats: {
  routed: number;
  admitted: number;
  ranWhole: number;
  shimFaults: number;
  notAdmitted: Record<string, number>;
  declined: Record<string, number>;
  hostCalls: Record<string, number>;
  dryRun: DryRunStats;
} = {
  routed: 0,
  admitted: 0,
  ranWhole: 0,
  shimFaults: 0,
  notAdmitted: {},
  declined: {},
  hostCalls: {},
  dryRun: emptyDryRunStats(),
};

export function resetRustRunStats(): void {
  rustRunStats.routed = 0;
  rustRunStats.admitted = 0;
  rustRunStats.ranWhole = 0;
  rustRunStats.shimFaults = 0;
  rustRunStats.notAdmitted = {};
  rustRunStats.declined = {};
  rustRunStats.hostCalls = {};
  rustRunStats.dryRun = emptyDryRunStats();
  admissionVerdicts.length = 0;
}

/**
 * What the admission dry runs found, of the runs they asked about:
 *
 * - `admitted`: runs the Rust engine would have started;
 * - `first`: refused runs by the reason the engine names first (the one a
 *   real run is logged and counted by);
 * - `all`: refused runs by every reason the engine names (each run once per
 *   reason), so a reason that is never first still shows its demand.
 */
export interface AdmissionTally {
  sampled: number;
  admitted: number;
  first: Record<string, number>;
  all: Record<string, number>;
}

/**
 * - `firings`: runs the TypeScript engine ran that a dry run could ask
 *   about (every run and resume `MOVEMENT_ENGINE` did not route);
 * - `sampled`, `admitted`, `first`, `all`: the dry runs asked (one firing
 *   in `MOVEMENT_ENGINE_DRY_RUN_EVERY`), as `AdmissionTally` says;
 * - `faults`: dry runs that ended in no verdict (the run itself is never
 *   touched by one);
 * - `byVersion`: the same tally, by the language version the run is
 *   pinned to.
 */
export interface DryRunStats extends AdmissionTally {
  firings: number;
  faults: number;
  byVersion: Record<string, AdmissionTally>;
}

export function emptyAdmissionTally(): AdmissionTally {
  return { sampled: 0, admitted: 0, first: {}, all: {} };
}

function emptyDryRunStats(): DryRunStats {
  return { firings: 0, faults: 0, ...emptyAdmissionTally(), byVersion: {} };
}

/** Adds one dry run's verdict to `tally`: no reasons is admitted. */
export function tallyVerdict(tally: AdmissionTally, reasons: readonly string[]): void {
  tally.sampled += 1;
  const [first] = reasons;
  if (first === undefined) {
    tally.admitted += 1;
    return;
  }
  tally.first[first] = (tally.first[first] ?? 0) + 1;
  for (const reason of new Set(reasons)) tally.all[reason] = (tally.all[reason] ?? 0) + 1;
}

/** One dry run's verdict, waiting for the host to persist it
 *  (admission_rollup.ts): the run it was, so the host can name its
 *  automation, its pinned version, and its reasons, first first (none for a
 *  run the Rust engine would have started). */
export interface AdmissionVerdict {
  runId: string;
  languageVersion: number;
  reasons: readonly string[];
}

/** How many verdicts wait at most: a host that never drains them costs this
 *  process a bounded buffer, not its memory. */
export const ADMISSION_VERDICTS_HELD = 10_000;

/** Verdicts not yet persisted, oldest first. */
export const admissionVerdicts: AdmissionVerdict[] = [];

/** Holds a verdict for the host; past the bound the oldest is dropped. */
export function holdAdmissionVerdict(verdict: AdmissionVerdict): void {
  if (admissionVerdicts.length >= ADMISSION_VERDICTS_HELD) admissionVerdicts.shift();
  admissionVerdicts.push(verdict);
}

/** Every verdict waiting, handed over and no longer held. */
export function takeAdmissionVerdicts(): AdmissionVerdict[] {
  return admissionVerdicts.splice(0, admissionVerdicts.length);
}
