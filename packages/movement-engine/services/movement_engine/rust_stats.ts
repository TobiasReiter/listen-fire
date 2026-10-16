// What the Rust engine did in this process, counted where the TypeScript
// side hands it work (rust_engine.ts). Its own module, importing nothing: the
// system stats route reads it without loading the engine.

/**
 * What happened to each Rust segment in this process:
 *
 * - `segments`: segments the Rust engine started (to their end, their own
 *   failure, or a refusal);
 * - `unsupported`: segments that failed because the engine (or the shim, on
 *   its behalf) would not run them, by reason. A program the checker passed
 *   should never land here: each count is a checker or engine bug;
 * - `endedAtCheck`: runs that failed their check (`MOVENG_PARSE`,
 *   `MOVENG_CHECK`, `MOVENG_LANGUAGE_VERSION`) before a segment opened, with
 *   no host request made;
 * - `failedCheckMidRun`: segments that passed their check, ran, and then
 *   failed a check mid-run (`check.compatible`, an `IS <Decl>` test);
 * - `shimFaults`: segments that ended in a fault of the shim's own
 *   (`RustShimError`);
 * - `hostCalls`: the host calls segments made, by `family.method`.
 */
export const rustRunStats: {
  segments: number;
  unsupported: Record<string, number>;
  endedAtCheck: number;
  failedCheckMidRun: number;
  shimFaults: number;
  hostCalls: Record<string, number>;
} = {
  segments: 0,
  unsupported: {},
  endedAtCheck: 0,
  failedCheckMidRun: 0,
  shimFaults: 0,
  hostCalls: {},
};

export function resetRustRunStats(): void {
  rustRunStats.segments = 0;
  rustRunStats.unsupported = {};
  rustRunStats.endedAtCheck = 0;
  rustRunStats.failedCheckMidRun = 0;
  rustRunStats.shimFaults = 0;
  rustRunStats.hostCalls = {};
}

// ── Which engine ran a run ────────────────────────────────────────────────────

/** The engine that ran one segment of a run. A resume reads it back
 *  (`parkedOnEngine`) to refuse a version-5 park the TypeScript engine
 *  wrote. */
export interface RunEngineRecord {
  runId: string;
  engine: 'ts' | 'rust';
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
