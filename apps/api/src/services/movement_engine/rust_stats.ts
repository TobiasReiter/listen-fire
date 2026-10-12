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
 *   (crates/movement-engine's README lists every reason). One count per
 *   run, under the first reason;
 * - `allReasons`: the same runs, each counted under each statement's first
 *   reason (the engine's admission walks on to the next statement past a
 *   refusal, not past one within a statement; a shim input check names
 *   one), so a reason an earlier statement's hides is still counted;
 * - `routed`: segments the Rust engine started, its admission refusals
 *   among them;
 * - `admitted`: routed segments its admission let by (`routed` less its
 *   refusals);
 * - `ranWhole`: routed runs it ran to their end (a run's own failure
 *   included, but not `mirroredFailure`'s or `unreproduced`'s);
 * - `mirroredFailure`: routed runs it admitted that then ended mid-run in
 *   the TypeScript engine's own `MOVENG_UNSUPPORTED`, which this engine
 *   mirrors: both engines end the run so;
 * - `unreproduced`: routed runs it admitted that then ended mid-run, after
 *   an effect, in this engine's own refusal of what the TypeScript engine
 *   runs on through (the `done`'s `unreproduced` marker; the wire codes it
 *   `MOVENG_UNSUPPORTED` too): what admission should have refused, a
 *   divergence;
 * - `declined`: routed runs it admitted and then declined, after the check
 *   and before anything the host can see, by reason;
 * - `endedAtCheck`: runs that failed their check (`MOVENG_PARSE`,
 *   `MOVENG_CHECK`, `MOVENG_LANGUAGE_VERSION`), which the Rust route checks
 *   before it opens a segment, as the TypeScript route does: never routed,
 *   and the same ending on either engine, with no host request made;
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
  mirroredFailure: number;
  unreproduced: number;
  shimFaults: number;
  endedAtCheck: number;
  notAdmitted: Record<string, number>;
  allReasons: Record<string, number>;
  declined: Record<string, number>;
  hostCalls: Record<string, number>;
  dryRun: DryRunStats;
} = {
  routed: 0,
  admitted: 0,
  ranWhole: 0,
  mirroredFailure: 0,
  unreproduced: 0,
  shimFaults: 0,
  endedAtCheck: 0,
  notAdmitted: {},
  allReasons: {},
  declined: {},
  hostCalls: {},
  dryRun: emptyDryRunStats(),
};

export function resetRustRunStats(): void {
  rustRunStats.routed = 0;
  rustRunStats.admitted = 0;
  rustRunStats.ranWhole = 0;
  rustRunStats.mirroredFailure = 0;
  rustRunStats.unreproduced = 0;
  rustRunStats.shimFaults = 0;
  rustRunStats.endedAtCheck = 0;
  rustRunStats.notAdmitted = {};
  rustRunStats.allReasons = {};
  rustRunStats.declined = {};
  rustRunStats.hostCalls = {};
  rustRunStats.dryRun = emptyDryRunStats();
  admissionVerdicts.length = 0;
  dryRunDurations.length = 0;
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
 *   about (every run and resume `MOVEMENT_ENGINE` did not route, but a
 *   rehearsal);
 * - `sampled`, `admitted`, `first`, `all`: the dry runs asked (one firing
 *   in `MOVEMENT_ENGINE_DRY_RUN_EVERY`), as `AdmissionTally` says;
 * - `faults`: dry runs that ended in no verdict (the run itself is never
 *   touched by one);
 * - `byVersion`: the same tally, by the language version the run is
 *   pinned to;
 * - `byRoute`: the same tally, by the route the TypeScript engine ran it
 *   by — a first firing, a resume, a race's settlement, a callback's firing.
 */
export interface DryRunStats extends AdmissionTally {
  firings: number;
  faults: number;
  byVersion: Record<string, AdmissionTally>;
  byRoute: Record<DryRunRoute, AdmissionTally>;
}

/** The routes a run the TypeScript engine runs comes by. */
export type DryRunRoute = 'run' | 'resume' | 'settle' | 'fire';

export function emptyAdmissionTally(): AdmissionTally {
  return { sampled: 0, admitted: 0, first: {}, all: {} };
}

function emptyDryRunStats(): DryRunStats {
  return {
    firings: 0,
    faults: 0,
    ...emptyAdmissionTally(),
    byVersion: {},
    byRoute: { run: emptyAdmissionTally(), resume: emptyAdmissionTally(), settle: emptyAdmissionTally(), fire: emptyAdmissionTally() },
  };
}

/** How many distinct reasons a tally keeps by name; past it, a new reason
 *  counts under `OTHER_REASONS`. The engine's reasons are a fixed set well
 *  under this, so the cap only bounds what a future engine could add. */
export const REASONS_KEPT = 200;
export const OTHER_REASONS = 'other';

/** `key` while `counts` names fewer than `cap` keys (or already names it);
 *  `overflow` after. */
export function cappedKey(counts: Record<string, unknown>, key: string, cap: number, overflow: string): string {
  return Object.hasOwn(counts, key) || Object.keys(counts).length < cap ? key : overflow;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Adds one dry run's verdict to `tally`: no reasons is admitted. */
export function tallyVerdict(tally: AdmissionTally, reasons: readonly string[]): void {
  tally.sampled += 1;
  const [first] = reasons;
  if (first === undefined) {
    tally.admitted += 1;
    return;
  }
  bump(tally.first, cappedKey(tally.first, first, REASONS_KEPT, OTHER_REASONS));
  const counted = new Set<string>();
  for (const reason of reasons) {
    const key = cappedKey(tally.all, reason, REASONS_KEPT, OTHER_REASONS);
    if (counted.has(key)) continue;
    counted.add(key);
    bump(tally.all, key);
  }
}

/** How long recent dry runs took, in milliseconds, newest last: the last
 *  `DURATIONS_KEPT`. Timed only once a host installs a clock
 *  (`setDryRunClock`): the engine reads no clock of its own, and this one
 *  feeds the counters alone, never a run. */
export const DURATIONS_KEPT = 1_000;
const dryRunDurations: number[] = [];
let dryRunClock: (() => number) | undefined;

export function setDryRunClock(clock: (() => number) | undefined): void {
  dryRunClock = clock;
}

export function currentDryRunClock(): (() => number) | undefined {
  return dryRunClock;
}

export function recordDryRunDuration(ms: number): void {
  if (dryRunDurations.length >= DURATIONS_KEPT) dryRunDurations.shift();
  dryRunDurations.push(ms);
}

/** The recent dry runs' durations, by percentile (milliseconds); nulls with
 *  none timed. */
export function dryRunDurationSummary(): { timed: number; p50: number | null; p95: number | null; p99: number | null; max: number | null } {
  const sorted = [...dryRunDurations].sort((a, b) => a - b);
  const at = (p: number) => (sorted.length === 0 ? null : (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null));
  return { timed: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null) };
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

// ── Which engine ran a run ────────────────────────────────────────────────────

/** What the engine decided for one segment of a run: the engine that ran it,
 *  and the first reason the Rust engine's admission gave for not running it
 *  (null when it did, or would have). */
export interface RunEngineRecord {
  runId: string;
  engine: 'ts' | 'rust';
  reason: string | null;
}

let runEngineRecorder: ((record: RunEngineRecord) => void) | undefined;

/** The host installs where a decision goes (the run row); the engine writes
 *  no rows of its own, so with none installed a decision goes nowhere. */
export function setRunEngineRecorder(recorder: ((record: RunEngineRecord) => void) | undefined): void {
  runEngineRecorder = recorder;
}

export function recordRunEngine(record: RunEngineRecord): void {
  runEngineRecorder?.(record);
}
