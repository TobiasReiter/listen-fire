// The engine's front door: run a movement, resume a parked one, check a
// program, and ask which engine a run belongs to. Re-exports what exists
// today; the internals stay where they are until the import codemod (F2).

export {
  MovementRunFailed,
  RunCancelledSignal,
  resumeMovement,
  runFailureCause,
  runMovement,
  fireCallbackBody,
  settleRaceFrame,
  type CancelGate,
  type MovementRunResult,
  type MovementWriteRecord,
  type ParkSink,
  type ResumeMovementInput,
  type RunLimitPause,
  type RunMovementInput,
} from '../services/movement_engine/run';

// A run's engine follows its pinned language version; a parked run goes back
// to the engine that parked it.
export {
  assertEngineConfigured,
  engineFor as engineRoute,
  type EngineChoice,
} from '../services/movement_engine/rust_engine';

// Which engine ran a run, counted, and what keeps a program off the
// TypeScript engine.
export * from '../services/movement_engine/rust_stats';
export { RUST_ENGINE_FROM_VERSION } from '../services/movement_engine/rust_engine';
export { listUnsupportedConstructs } from '../services/movement_engine/interpretable';

export * as programCheck from '../services/movement_engine/program_check';
export {
  checkAnswer,
  checkPinned,
  checkPinnedInRust,
  fileResolverOf,
  parsePinned,
  type CheckAnswer,
  type CheckedProgram,
  type CheckInput,
  type LinkData,
  type LinkedImportData,
  type Stamp,
} from '../services/movement_engine/program_check';

/** This release of the engine. `lf` pins a new project to it and refuses a pin
 *  newer than it; lf's copy is held equal to this one by a cargo test. */
export const ENGINE_VERSION = '0.12.0';
