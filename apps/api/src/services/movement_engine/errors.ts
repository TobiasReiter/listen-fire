// The movement engine's error types — in a module with no heavy dependencies
// so light modules (the name translator, consumed by the catalog's editor
// snapshot path) can throw the engine's currency without dragging in the
// evaluator's heavy import graph. `expression.ts` re-exports both symbols,
// so existing import sites are unchanged.

import { getErrorMessage } from '../../lib/utils/error';
import type { MovementRunResult } from './run';

export type MovementEngineErrorCode =
  | 'MOVENG_PARSE'
  | 'MOVENG_CHECK'
  // The movement is pinned to a language version this release does not
  // support. Refused before parsing — never run as the current version.
  | 'MOVENG_LANGUAGE_VERSION'
  | 'MOVENG_NOT_FOUND'
  | 'MOVENG_UNSUPPORTED'
  | 'MOVENG_RUNTIME'
  // Calls nested deeper than MOVEMENT_MAX_CALL_DEPTH (language version 3) —
  // a recursion that may never end. Never forgiven by a collection op's
  // `onError` (`call_depth.ts`).
  | 'MOVENG_CALL_DEPTH'
  // A parked scope held a non-JSON-serialisable value (a closure / Map / a
  // value that stringifies to undefined). Fails LOUD at park rather than
  // corrupting the durable scope (async user interaction §4.1).
  | 'MOVENG_PARK_NONSERIALIZABLE'
  // An author-thrown `ERROR("…")` — the movement deliberately failed the run
  // (async user interaction §3c). Surfaced as a FAILED trigger_run.
  | 'MOVENG_ERROR';

export class MovementEngineError extends Error {
  constructor(
    readonly code: MovementEngineErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = 'MovementEngineError';
  }
}

/**
 * Thrown when the user requested cancellation (runs-and-cancel spec §cancel) —
 * at a statement boundary (the interpreter's cancel gate) or a boundary inside
 * a statement (an LLM call, a plugin invocation). Caught at the top of
 * `run()`/`resume()` (like `RunParked`), NEVER by the fan-out/parallel park
 * machinery (which special-cases only `RunParked`/`ScopeEndedQuietly`, so this
 * propagates). Here rather than beside a gate so the interpreter, the
 * extraction and a host's model client all raise the same signal without a
 * cycle. Re-exported from `run.ts` for the engine's public surface.
 */
export class RunCancelledSignal extends Error {
  constructor() {
    super('run cancelled by user request');
    this.name = 'RunCancelledSignal';
  }
}

/**
 * A segment whose run lease was lost stops at its next statement: another
 * instance may be stepping the run, so it settles nothing and touches no
 * parked row. The statement in flight when the lease lapsed has already run,
 * and the new holder may run it again: its effects can land twice.
 *
 * Raised by an in-process host (its cancel gate, a fenced park), and defined
 * here because the engine treats it as control flow, exactly as it treats a
 * cancel: no collection op's `onError` forgives it.
 */
export class RunLeaseLost extends Error {
  constructor(readonly runId: string) {
    super('run lease lost; another instance may hold the run');
    this.name = 'RunLeaseLost';
  }
}

/**
 * A run that DIED mid-way, carrying out the ledger of what it had already done.
 *
 * Writes hit external systems inline, so a throw after the third write leaves
 * three real records behind. Before this channel the ledger died with the stack
 * and the firing record claimed nothing happened — users re-ran and collided
 * with their own writes.
 *
 * Deliberately transparent: `message`, `name` and `stack` are the original
 * error's and it hangs off `cause`, so logs and failure reasons read exactly as
 * they did. Only genuine failures are wrapped — `RunParked`,
 * `RunCancelledSignal` and `ScopeEndedQuietly` are control flow and never reach
 * here.
 */
export class MovementRunFailed extends Error {
  constructor(
    cause: unknown,
    /** Everything the run had done when it died: writes in program order, the
     *  extraction sites their provenance references, and the decision trace. */
    readonly partial: MovementRunResult,
  ) {
    super(getErrorMessage(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'MovementRunFailed';
    if (cause instanceof Error && cause.stack !== undefined) this.stack = cause.stack;
  }
}

/**
 * The error a run really died of. `MovementRunFailed` is a transparent CARRIER
 * for the partial ledger, so anything that discriminates on the error itself —
 * its class, its `MovementEngineError` code — must look THROUGH it. Errors
 * raised before the interpreter starts (parse / check) are never wrapped and
 * pass straight back.
 */
export function runFailureCause(error: unknown): unknown {
  return error instanceof MovementRunFailed ? error.cause : error;
}
