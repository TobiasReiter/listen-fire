// The TypeScript side of the Rust engine (crates/movement-engine). A segment
// runs inside its own WASM instance; whatever it needs from the world it asks
// for as `{id, family, method, args}` requests, and this shim serves each one
// from the run's `EngineHost`, several at once when the engine issues several,
// answering each by id as it settles. The segment is the run host's
// (`inRunContext` opened it): every request the engine makes of the host names
// it, in the shapes docs/contracts/host-families.md freezes, and the shim forwards each one
// to the run's `EngineHost` (rust_host.ts).
//
// Which engine runs a program is decided by `MOVEMENT_ENGINE` (`engineChoice`),
// and then by the Rust engine
// itself: its admission walks its own parse of the program before it asks for
// anything (crates/movement-engine/src/admit.rs). What it refuses or declines
// runs on the TypeScript engine. Each decision is logged once per run
// (`noteEngine`) and counted (`rustRunStats`).
//
// Below a whole program, one expression can already run in Rust: `evalInRust`
// is the TypeScript evaluator's switch (expression.ts `evalMovementExpr`) for
// an expression `rustCanEval` admits whose every name is a value binding.

import { callEvalExpression, openEngineSegment } from 'movement-lang';

import type { Expression } from '#shared/expression/types';
import { isObjectSpread, listElementExpression, objectMemberExpression } from '#shared/expression/types';
import { chatModelNames } from '../../lib/models/registry';
import { RunCostCapExceeded } from '../../lib/run_cost';
import { extractionTierAssignments } from './ai_tiers';
import { CallDepthExceeded, maxCallDepth } from './call_depth';
import { logger } from '../logger';
import { MovementEngineError, MovementRunFailed, isCheckFailure, type MovementEngineErrorCode } from './errors';
import { servedHostMethods } from './host';
import type { Binding, MovementEvalResult, MovementExprContext } from './expression';
import { bindingOf, pinnedNow } from './expression';
import { NO_PROVENANCE, type Provenance, type ProvenanceOrigin } from './provenance';
import { maxFileChars } from './extraction';
import type { CheckedProgram } from './program_check';
import type { MovementRunResult, ResumeMovementInput, RunMovementInput } from './run';
import type { CallbackBodyInput, SettleRaceInput } from 'engine-contracts';
import type { RunContext } from './run_context';
import { checkedKey, serve, type RouteContext } from './rust_host';
import {
  currentDryRunClock,
  emptyAdmissionTally,
  holdAdmissionVerdict,
  recordDryRunDuration,
  recordRunEngine,
  rustEvalStats,
  rustRunStats,
  tallyVerdict,
  type DryRunRoute,
} from './rust_stats';
import { filesInParkState, REFUSED, RustShimError, WireOut, plainJson, record, string } from './rust_wire';

export { RustShimError, plainJson } from './rust_wire';

/** One request a segment makes of its host. */
export interface HostRequest {
  id: number;
  family: string;
  method: string;
  args: unknown;
}

/** What a segment says after `start` or an answer: the requests it issued
 *  since the last step (earlier ones are still awaited), or its result. */
export type EngineStep = { pending: HostRequest[] } | { done: unknown };

/** An answer: the value (`{}` when it is `undefined`), or the error the host
 *  raised, which the engine receives as an `Err` it may handle. */
export type HostAnswer =
  | { value: unknown }
  | Record<string, never>
  | { error: { message: string; name?: string; ref?: number } };

/** The engine's side of the conversation. `openWasmEngine` is the real one;
 *  a test drives the shim with a double. */
export interface EngineProtocol {
  start(input: unknown): EngineStep;
  answer(id: number, answer: HostAnswer): EngineStep;
  /** Ends the segment, dropping everything it held. */
  finish(): void;
}

export type EngineChoice = 'rust' | 'ts';

/** The one place `MOVEMENT_ENGINE` is read. Unset is `ts`; anything other
 *  than `rust` or `ts` is refused rather than read as either. */
export function engineChoice(env: Record<string, string | undefined> = process.env): EngineChoice {
  const value = env.MOVEMENT_ENGINE;
  if (value === undefined || value === '' || value === 'ts') return 'ts';
  if (value === 'rust') return 'rust';
  throw new Error(`MOVEMENT_ENGINE is "${value}": it must be "rust" or "ts"`);
}

/** What happens to a run `MOVEMENT_ENGINE=rust` routes and the Rust engine
 *  refuses or declines: `ts` runs it on the TypeScript engine, `none` fails
 *  it with the reason (the setting to run with once nothing is refused, so a
 *  refusal is an error and not a silent slow path). */
export type EngineFallback = 'ts' | 'none';

/** The one place `MOVEMENT_ENGINE_FALLBACK` is read. Unset is `ts`. */
export function engineFallback(env: Record<string, string | undefined> = process.env): EngineFallback {
  const value = env.MOVEMENT_ENGINE_FALLBACK;
  if (value === undefined || value === '' || value === 'ts') return 'ts';
  if (value === 'none') return 'none';
  throw new Error(`MOVEMENT_ENGINE_FALLBACK is "${value}": it must be "ts" or "none"`);
}

/** For a process's boot: a bad `MOVEMENT_ENGINE`, `MOVEMENT_ENGINE_FALLBACK`
 *  or `MOVEMENT_ENGINE_DRY_RUN_EVERY` fails startup rather than every run (or,
 *  for the dry run, every dry run, silently). */
export function assertEngineChoiceConfigured(env: Record<string, string | undefined> = process.env): void {
  const choice = engineChoice(env);
  // No fallback with no Rust engine would fail every run, whatever its program.
  if (engineFallback(env) === 'none' && choice !== 'rust') {
    throw new Error('MOVEMENT_ENGINE_FALLBACK is "none", which fails every run the Rust engine refuses: it needs MOVEMENT_ENGINE=rust');
  }
  admissionDryRunEvery(env);
}

/** The error a refused run fails with under `MOVEMENT_ENGINE_FALLBACK=none`. */
function refusedWithoutFallback(reason: string): MovementEngineError {
  return new MovementEngineError(
    'MOVENG_UNSUPPORTED',
    `the Rust engine does not run this movement (${reason}), and MOVEMENT_ENGINE_FALLBACK=none leaves no other engine to run it`,
    { reason },
  );
}

/** What a run the Rust engine did not take does next: the TypeScript engine
 *  runs it (`undefined`), or the run fails (`fallback=none`). */
export function refusalOutcome(reason: string): MovementEngineError | undefined {
  return engineFallback() === 'none' ? refusedWithoutFallback(reason) : undefined;
}

/** What a segment in the Rust engine runs: the run's input, the segment
 *  the run host opened, and the check the run host made before opening it
 *  (run.ts), which answers the engine's `check.program` (absent: the route
 *  checks). */
export interface RustSegment<Input extends RunMovementInput = RunMovementInput> {
  input: Input;
  context: RunContext;
  checked?: CheckedProgram;
}

/** A segment of `input`'s run in the Rust engine: its result, or why the
 *  engine refused or declined it (before it touched an adapter) for the
 *  TypeScript engine to run. */
export async function runSegmentInRust(
  segment: RustSegment,
  engine?: EngineProtocol,
): Promise<{ ran: MovementRunResult } | { declined: string }> {
  return segmentInRust(segment, undefined, engine);
}

/** A parked run resumed in the Rust engine: its result, or why the engine
 *  refused (its state reader decides) or declined it before touching an
 *  adapter. An answer to bind at the leaf crosses on the eval wire. */
export async function resumeSegmentInRust(
  segment: RustSegment<ResumeMovementInput>,
  engine?: EngineProtocol,
): Promise<{ ran: MovementRunResult } | { declined: string }> {
  return segmentInRust(segment, resumptionOf(segment.input), engine);
}

/** What a parked run's resume hands the engine. */
function resumptionOf(input: ResumeMovementInput): Resumption {
  return {
    state: input.state,
    ...(input.reenter === true ? { reenter: true } : {}),
    ...(input.answer !== undefined && input.reenter !== true ? { answer: input.answer } : {}),
    ...(input.deferRaceSettlement === true ? { deferRaceSettlement: true } : {}),
  };
}

/** A race a batch resume deferred, settled in the Rust engine
 *  (`settleRaceFrame`): `state` any completed branch's. */
export async function settleSegmentInRust(
  segment: RustSegment<SettleRaceInput & { host: RunMovementInput['host'] }>,
  engine?: EngineProtocol,
): Promise<{ ran: MovementRunResult } | { declined: string }> {
  return segmentInRust(segment, settlementOf(segment.input), engine);
}

/** What a race settlement hands the engine. */
function settlementOf(input: SettleRaceInput): Resumption {
  return { state: input.state, settle: { frameAddress: input.frameAddress } };
}

/** A fired callback's body run in the Rust engine (`fireCallbackBody`):
 *  `state` the callback's captured continuation. */
export async function fireSegmentInRust(
  segment: RustSegment<CallbackBodyInput & { host: RunMovementInput['host'] }>,
  engine?: EngineProtocol,
): Promise<{ ran: MovementRunResult } | { declined: string }> {
  return segmentInRust(segment, firingOf(segment.input), engine);
}

/** What a callback's firing hands the engine. */
function firingOf(input: CallbackBodyInput): Resumption {
  return { state: input.state, fire: { values: input.values, callIndex: input.callIndex } };
}

/** What a segment resumes from, and how. */
interface Resumption {
  state: unknown;
  reenter?: true;
  answer?: unknown;
  deferRaceSettlement?: true;
  settle?: { frameAddress: string };
  fire?: { values: Record<string, unknown>; callIndex: number };
}

async function segmentInRust(
  { input, context, checked }: RustSegment,
  resume: Resumption | undefined,
  engine?: EngineProtocol,
): Promise<{ ran: MovementRunResult } | { declined: string }> {
  // Read before the instance opens. An event or state that cannot cross the
  // eval wire as itself (a class instance in a payload; a `Date` is its ISO
  // text by now, `withIsoEvent`) is refused here, before the engine has
  // asked the host for anything.
  // The segment's one wire: what it sends the engine (the event, then every
  // answer) keeps the ids the engine names it back by.
  const wire = new WireOut({ whole: true });
  const localZone = processLocalZone();
  if (localZone === undefined) return notAdmitted(input, LOCAL_ZONE_UNVERIFIED);
  const start = segmentInput(input, context, { resume, localZone }, wire);
  if (start === undefined) return notAdmitted(input, EVENT_DOES_NOT_CROSS);
  const hostErrors: unknown[] = [];
  let outcome: RunOutcome;
  let unreproduced = false;
  try {
    const done = await driveEngine(engine ?? openWasmEngine(), start, {
      host: input.host,
      context,
      catalog: input.catalog,
      hostErrors,
      wire,
      ...(checked !== undefined ? { prechecked: { source: input.source, languageVersion: context.languageVersion, checked } } : {}),
    });
    unreproduced = endedUnreproduced(done);
    outcome = readRunResult(done, { context, hostErrors, wire });
  } catch (error) {
    // A driver that did not check before the segment opened (run.ts does):
    // the engine's own `check.program` ended it, counted as the run host's
    // check ending is, never as a run the engine ran.
    if (isCheckFailure(error)) {
      endedAtItsCheck(input);
      throw error;
    }
    // Anything else ends in a `done` past admission.
    rustRunStats.routed += 1;
    rustRunStats.admitted += 1;
    // The run's own failure, which the Rust engine ran to as the TypeScript
    // engine would have; a shim fault is not one.
    if (error instanceof RustShimError) {
      rustRunStats.shimFaults += 1;
      noteEngine(input, 'rust', SHIM_FAULT);
    } else if (unreproduced) {
      // This engine's own refusal, met mid-run after an effect, of what the
      // TypeScript engine runs on through: a divergence.
      rustRunStats.unreproduced += 1;
      noteEngine(input, 'rust', UNREPRODUCED_MID_RUN);
    } else if (endedByName(error)) {
      // The TypeScript engine's own MOVENG_UNSUPPORTED, mirrored: both
      // engines end the run so. Not counted as one that ran whole.
      rustRunStats.mirroredFailure += 1;
      noteEngine(input, 'rust', MIRRORED_FAILURE);
    } else {
      rustRunStats.ranWhole += 1;
      noteEngine(input, 'rust', ADMITTED);
    }
    throw error;
  }
  rustRunStats.routed += 1;
  if ('refused' in outcome) return notAdmitted(input, outcome.refused, outcome.reasons);
  rustRunStats.admitted += 1;
  if ('declined' in outcome) {
    rustRunStats.declined[outcome.declined] = (rustRunStats.declined[outcome.declined] ?? 0) + 1;
    noteEngine(input, engineFallback() === 'none' ? 'rust' : 'ts', outcome.declined);
    return outcome;
  }
  rustRunStats.ranWhole += 1;
  noteEngine(input, 'rust', ADMITTED);
  return outcome;
}

/** Whether a `done` is marked as ending in this engine's own refusal of
 *  what the TypeScript engine runs on through (crates/movement-engine/src/
 *  run.rs `marked`): only a run's failure carries the marker, and only as
 *  `true`. */
export function endedUnreproduced(done: unknown): boolean {
  const outcome = record(done, 'the Rust engine result');
  if (outcome.unreproduced === undefined) return false;
  if (outcome.unreproduced !== true || !('thrown' in outcome || 'failed' in outcome)) {
    throw new RustShimError('the Rust engine marks only a failed run unreproduced, and as true');
  }
  return true;
}

/** Whether a run ended by naming a construct neither engine runs
 *  (`MOVENG_UNSUPPORTED`), mid-run. */
function endedByName(error: unknown): boolean {
  const cause = error instanceof MovementRunFailed ? error.cause : error;
  return cause instanceof MovementEngineError && cause.code === 'MOVENG_UNSUPPORTED';
}

/** A `done`'s cost lines, summed by source. */
function costBySource(cost: unknown): Record<string, number> {
  if (!Array.isArray(cost)) throw new RustShimError('the Rust engine cost is a list of cost lines');
  const bySource: Record<string, number> = {};
  for (const line of cost) {
    const { source, microdollars } = record(line, 'a Rust engine cost line');
    if (typeof source !== 'string' || typeof microdollars !== 'number') {
      throw new RustShimError('a Rust engine cost line is {source, microdollars}');
    }
    bySource[source] = (bySource[source] ?? 0) + microdollars;
  }
  return bySource;
}

function canonicalJson(bySource: Record<string, number>): string {
  return JSON.stringify(Object.entries(bySource).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Why a run whose event, source or parked state cannot cross the eval wire
 *  is not admitted. */
export const EVENT_DOES_NOT_CROSS = 'event_does_not_cross';

/** Why a run (or an expression) is left to the TypeScript engine when this
 *  process's `Date` reads in a zone `Intl` cannot name (`TZ=GMT+3`,
 *  `TZ=utc`): no zone sent could make the Rust engine read as it does. */
export const LOCAL_ZONE_UNVERIFIED = 'local_zone_unverified';

/** The reason a run the Rust engine ran is logged with. */
const ADMITTED = 'admitted';

/** The reason a run that ended in the TypeScript engine's own
 *  MOVENG_UNSUPPORTED, mirrored, is logged with. */
const MIRRORED_FAILURE = 'mirrored_failure';

/** The reason a run that ended mid-run in this engine's own refusal, after
 *  an effect, is logged with: a divergence. */
const UNREPRODUCED_MID_RUN = 'unreproduced_mid_run';

/** The reason a run the shim faulted in is logged with. */
const SHIM_FAULT = 'shim_fault';

/** The reason a Rust-routed run that failed its check is logged with: it
 *  ended there, on either engine, and no engine ran it. */
export const ENDED_AT_CHECK = 'ended_at_check';

/**
 * The Rust route's check (`check`: run.ts's own, `checkPinned`), made where
 * the TypeScript route makes it: before the segment opens, so a program that
 * fails it makes no host request on either engine. A check failure
 * (`isCheckFailure`) is counted and logged as that ending; anything else the
 * check throws is a fault of the shim's check, counted as one.
 */
export function checkBeforeRustSegment(input: Pick<RunMovementInput, 'runId' | 'dryRun'>, check: () => CheckedProgram): CheckedProgram {
  try {
    return check();
  } catch (error) {
    if (isCheckFailure(error)) endedAtItsCheck(input);
    else {
      rustRunStats.shimFaults += 1;
      noteEngine(input, 'rust', SHIM_FAULT);
    }
    throw error;
  }
}

/** A Rust-routed run that ended at its check: counted apart, never routed,
 *  and logged with that reason. */
function endedAtItsCheck(input: Pick<RunMovementInput, 'runId' | 'dryRun'>): void {
  rustRunStats.endedAtCheck += 1;
  noteEngine(input, 'rust', ENDED_AT_CHECK);
}

/** A run that never ran in Rust: counted by its first reason and under each
 *  of its reasons, and logged by its first. */
function notAdmitted(input: Pick<RunMovementInput, 'runId'>, reason: string, reasons: readonly string[] = [reason]): { declined: string } {
  rustRunStats.notAdmitted[reason] = (rustRunStats.notAdmitted[reason] ?? 0) + 1;
  for (const each of new Set(reasons)) rustRunStats.allReasons[each] = (rustRunStats.allReasons[each] ?? 0) + 1;
  noteEngine(input, engineFallback() === 'none' ? 'rust' : 'ts', reason);
  return { declined: reason };
}

/**
 * The one log line per run that says which engine ran it, and why: `admitted`
 * for a run the Rust engine ran (to its end or its own failure), else the
 * reason it ran on the TypeScript engine — the shim's input check, the Rust
 * engine's refusal or decline, or `movement_engine_ts` when the Rust engine
 * was not chosen. At info under `MOVEMENT_ENGINE=rust`, where it is the
 * evidence of what the Rust engine takes; at debug otherwise.
 */
export function noteEngine(input: Pick<RunMovementInput, 'runId' | 'dryRun'>, engine: EngineChoice, reason: string): void {
  const line = `movement engine: engine=${engine} run=${input.runId ?? '-'} reason=${reason}`;
  if (reason === ENGINE_CHOICE_TS) logger.debug(line);
  else logger.info(line);
  // A run `MOVEMENT_ENGINE` did not route is recorded with the dry run's
  // verdict instead (`recordTypeScriptRun`).
  if (reason !== ENGINE_CHOICE_TS) recordEngine(input, engine, reason);
}

function recordEngine(input: Pick<RunMovementInput, 'runId' | 'dryRun'>, engine: EngineChoice, reason: string | null): void {
  // A rehearsal has no run row.
  if (input.runId !== undefined && input.dryRun !== true) recordRunEngine({ runId: input.runId, engine, reason });
}

/** A run `MOVEMENT_ENGINE` kept on the TypeScript engine, with the first
 *  reason the Rust engine's admission gave for it, or `admitted` when it
 *  would take it (undefined reasons: the dry run was not asked or faulted,
 *  recorded as no reason). */
export function recordTypeScriptRun(input: Pick<RunMovementInput, 'runId' | 'dryRun'>, reasons: string[] | undefined): void {
  recordEngine(input, 'ts', reasons === undefined ? null : (reasons[0] ?? ADMITTED));
}

/** Why the TypeScript engine runs a run that `MOVEMENT_ENGINE` did not route. */
export const ENGINE_CHOICE_TS = 'movement_engine_ts';

// ── The admission dry run ─────────────────────────────────────────────────────

/**
 * What the Rust engine's admission says of a run the TypeScript engine is
 * about to run, counted (`rustRunStats.dryRun`) and held for the host to
 * persist (`holdAdmissionVerdict`), without running it in Rust. Never throws
 * and never changes the run: a dry run that cannot reach a verdict is
 * counted as a fault and nothing else.
 */
export function dryAdmitRun(segment: RustSegment, engine?: EngineProtocol): string[] | undefined {
  return dryAdmit(segment, undefined, engine, 'run');
}

/** `dryAdmitRun` for a parked run the TypeScript engine resumes: the
 *  resume the Rust engine would be handed (`resumeSegmentInRust`). */
export function dryAdmitResume(segment: RustSegment<ResumeMovementInput>, engine?: EngineProtocol): string[] | undefined {
  return dryAdmit(segment, resumptionOf(segment.input), engine, 'resume');
}

/** `dryAdmitRun` for a deferred race the TypeScript engine settles: the
 *  settlement the Rust engine would be handed (`settleSegmentInRust`). */
export function dryAdmitSettle(
  segment: RustSegment<SettleRaceInput & { host: RunMovementInput['host'] }>,
  engine?: EngineProtocol,
): string[] | undefined {
  return dryAdmit(segment, settlementOf(segment.input), engine, 'settle');
}

/** `dryAdmitRun` for a callback's body the TypeScript engine runs: the
 *  firing the Rust engine would be handed (`fireSegmentInRust`). */
export function dryAdmitFire(
  segment: RustSegment<CallbackBodyInput & { host: RunMovementInput['host'] }>,
  engine?: EngineProtocol,
): string[] | undefined {
  return dryAdmit(segment, firingOf(segment.input), engine, 'fire');
}

/** Whether a dry run asks about one firing in this many: 1 asks about
 *  every firing, 0 about none. Unset is 1. */
export function admissionDryRunEvery(env: Record<string, string | undefined> = process.env): number {
  const value = env.MOVEMENT_ENGINE_DRY_RUN_EVERY;
  if (value === undefined || value.trim() === '') return 1;
  const every = Number(value);
  if (!Number.isInteger(every) || every < 0) {
    throw new Error(`MOVEMENT_ENGINE_DRY_RUN_EVERY is "${value}": it must be a whole number, 0 to turn the dry run off`);
  }
  return every;
}

function dryAdmit(
  { input, context }: RustSegment,
  resume: Resumption | undefined,
  engine: EngineProtocol | undefined,
  route: DryRunRoute,
): string[] | undefined {
  // A rehearsal is an author trying a program, not a firing: it is not
  // demand to burn down.
  if (input.dryRun === true) return undefined;
  const stats = rustRunStats.dryRun;
  try {
    const every = admissionDryRunEvery();
    stats.firings += 1;
    if (every === 0 || (stats.firings - 1) % every !== 0) return undefined;
    const clock = currentDryRunClock();
    const startedAt = clock?.();
    const reasons = admissionReasons({ input, context }, resume, engine);
    if (clock !== undefined && startedAt !== undefined) recordDryRunDuration(clock() - startedAt);
    const languageVersion = context.languageVersion;
    tallyVerdict(stats, reasons);
    tallyVerdict((stats.byVersion[String(languageVersion)] ??= emptyAdmissionTally()), reasons);
    tallyVerdict(stats.byRoute[route], reasons);
    if (input.runId !== undefined) holdAdmissionVerdict({ runId: input.runId, languageVersion, reasons });
    return reasons;
  } catch (error) {
    stats.faults += 1;
    logger.warn(`movement engine: admission dry run fault run=${input.runId ?? '-'}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Every reason the Rust engine would refuse the run for, first first; none
 * when it would start it. The shim's own input check first, as a real run
 * meets it; then the engine's start entry, whose admission is pure over
 * its parse and the input: a refusal is its `done`, and an admitted run's
 * first step is the `check.program` request, which is never answered — the
 * segment is finished there, so nothing reaches the host.
 */
function admissionReasons(
  { input, context }: RustSegment,
  resume: Resumption | undefined,
  engine: EngineProtocol | undefined,
): string[] {
  const localZone = processLocalZone();
  if (localZone === undefined) return [LOCAL_ZONE_UNVERIFIED];
  const start = segmentInput(input, context, { resume, localZone }, new WireOut({ whole: true }));
  if (start === undefined) return [EVENT_DOES_NOT_CROSS];
  // Never answered: a lowering miss a real run leaves to its check is named
  // here, as the refusal it is until the check passes it.
  const asked = record(start, 'the dry run start');
  const segment = engine ?? openWasmEngine();
  try {
    const step = segment.start({ ...asked, dryAdmission: true });
    if ('pending' in step) return [];
    const done = record(step.done, 'the dry run start');
    if (!('refused' in done)) {
      throw new RustShimError(`the Rust engine's start ended with ${Object.keys(done).join(', ') || 'nothing'}, neither a request nor a refusal`);
    }
    // Every reason the engine's admission walk met, the first first: what
    // `rustRunStats.allReasons` counts for a routed run.
    return refusalOf(done).reasons;
  } finally {
    segment.finish();
  }
}

/**
 * Runs one segment to its result: starts it, serves every request it issues
 * from `input.host` concurrently, answers each as it settles, and finishes
 * the segment however the run ends.
 */
export async function driveEngine(
  engine: EngineProtocol,
  start: unknown,
  input: Omit<RouteContext, 'hostErrors' | 'positions' | 'wire' | 'checked'> & {
    /** The errors host calls failed with, by the `ref` their answers carry. */
    hostErrors?: unknown[];
    /** The segment's wire, when its input went out on it. */
    wire?: WireOut;
  },
): Promise<unknown> {
  const context: RouteContext = {
    ...input,
    hostErrors: input.hostErrors ?? [],
    positions: new Map(),
    wire: input.wire ?? new WireOut({ whole: true }),
    // The run's own check, made before the segment opened, is the program
    // `check.compatible` asks about too.
    checked: new Map(
      input.prechecked !== undefined
        ? [[checkedKey(input.prechecked.source, input.prechecked.languageVersion), input.prechecked.checked.program]]
        : [],
    ),
  };
  // A settle queue: each request in flight, as it settles, joins the queue
  // and wakes the one waiter. An answer costs O(1) however many requests are
  // in flight (a race over every one of them per answer was O(n) each).
  const settled = new SettleQueue();
  let inFlight = 0;
  try {
    let step = engine.start(start);
    for (;;) {
      if ('done' in step) return step.done;
      for (const request of step.pending) {
        inFlight += 1;
        serve(request, context).then(
          (answer) => settled.push({ id: request.id, answer }),
          (failure: unknown) => settled.push({ id: request.id, failure }),
        );
      }
      if (inFlight === 0) throw new RustShimError('the Rust engine is waiting with no request in flight');
      // Every answer already settled is handed over before any request it
      // leads to is served: the TypeScript engine runs each continuation an
      // answer wakes before the host is asked anything further, so flows
      // woken together ask together (crates/movement-engine/README.md,
      // "Concurrent flows").
      const pending: HostRequest[] = [];
      let next: Settled | undefined = await settled.next();
      while (next !== undefined) {
        inFlight -= 1;
        if ('failure' in next) throw next.failure;
        step = engine.answer(next.id, next.answer);
        if ('done' in step) break;
        pending.push(...step.pending);
        next = settled.ready();
      }
      if ('done' in step) return step.done;
      step = { pending };
    }
  } catch (error) {
    // The segment is ending (a shim fault, or the engine's own throw): every
    // request still in flight settles first, so no host call outlives the
    // segment it named.
    for (; inFlight > 0; inFlight -= 1) await settled.next();
    throw error;
  } finally {
    engine.finish();
  }
}

type Settled = { id: number; answer: HostAnswer } | { id: number; failure: unknown };

/** Settled requests in the order they settled, and one waiter for the next. */
class SettleQueue {
  private readonly items: Settled[] = [];
  private head = 0;
  private waiter: (() => void) | undefined;

  push(item: Settled): void {
    this.items.push(item);
    const wake = this.waiter;
    this.waiter = undefined;
    wake?.();
  }

  /** The next settled item when one is already waiting, without waiting. */
  ready(): Settled | undefined {
    if (this.head === this.items.length) return undefined;
    const item = this.items[this.head];
    this.head += 1;
    if (this.head === this.items.length) {
      this.items.length = 0;
      this.head = 0;
    }
    return item;
  }

  async next(): Promise<Settled> {
    while (this.head === this.items.length) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    const item = this.items[this.head];
    if (item === undefined) throw new RustShimError('the settle queue woke with nothing settled');
    this.head += 1;
    // Drained: start over, so a long segment's queue holds only what waits.
    if (this.head === this.items.length) {
      this.items.length = 0;
      this.head = 0;
    }
    return item;
  }
}


// ── The segment's data ────────────────────────────────────────────────────────

/** Everything of `input` but its host, as the `segment` entry reads it
 *  (crates/movement-engine/src/run.rs `SegmentInput`): the event, and a
 *  resumed state, on the eval wire, so their objects keep their key order
 *  (a stored state's is the order it was stored in). Undefined for an input
 *  that cannot cross as itself. */
function segmentInput(
  input: RunMovementInput,
  context: RunContext,
  { resume, localZone }: { resume: Resumption | undefined; localZone: string },
  wire: WireOut,
): unknown {
  // The event is data, whatever keys it carries: a dict shaped like a
  // binding crosses, and is read, as the dict it is.
  const event = wire.value(input.event);
  if (event === REFUSED) return undefined;
  // A parked state's files are made host-side, in the segment's file table:
  // the engine is handed their handles, never their descriptors.
  const state = resume !== undefined ? new WireOut({ files: wire.files }).value(filesInParkState(resume.state)) : undefined;
  if (state === REFUSED) return undefined;
  // The answer a step-past resume binds and a fired callback's values are
  // data, as the event is.
  const answer = resume?.answer !== undefined ? wire.value(resume.answer) : undefined;
  if (answer === REFUSED) return undefined;
  const values = resume?.fire !== undefined ? wire.value(resume.fire.values) : undefined;
  if (values === REFUSED) return undefined;
  const resumed =
    resume === undefined
      ? undefined
      : {
          state,
          ...(resume.reenter === true ? { reenter: true } : {}),
          ...(answer !== undefined ? { answer } : {}),
          ...(resume.deferRaceSettlement === true ? { deferRaceSettlement: true } : {}),
        };
  return plainJson(
    {
      entry: 'segment',
      ...(input.dryRun === true ? { dryRun: true } : {}),
      ...(resumed !== undefined ? { resume: resumed } : {}),
      ...(resume?.settle !== undefined ? { settle: resume.settle } : {}),
      ...(resume?.fire !== undefined ? { fire: { values, callIndex: resume.fire.callIndex } } : {}),
      source: input.source,
      // The pin the run is under, written out: the engine cannot know this
      // release's current version.
      languageVersion: context.languageVersion,
      ...(input.movementName !== undefined ? { movementName: input.movementName } : {}),
      event,
      // The segment the run host opened: every host request names it.
      segmentId: context.segmentId,
      ...(input.credentialIds !== undefined ? { credentialIds: input.credentialIds } : {}),
      // The run's account as this segment starts (crates/movement-engine/src/ledger.rs).
      spend: {
        priorMicrodollars: input.priorSpentMicrodollars ?? 0,
        capBaselineMicrodollars: input.capBaselineMicrodollars ?? 0,
        ...(input.costCapMicrodollars !== undefined ? { capMicrodollars: input.costCapMicrodollars } : {}),
      },
      // Where the run's flows suspend (crates/movement-engine/src/park.rs).
      ...(input.limitPaused === true ? { limitPaused: true } : {}),
      ...(input.suspendAt !== undefined && input.suspendAt.length > 0 ? { suspendAt: [...input.suspendAt] } : {}),
      // The run's pinned instant, as the TypeScript interpreter pins it.
      now: input.firedAt ?? context.pinnedNow.toISOString(),
      // The zone a date-time text with no offset is read in: this
      // process's, as its `Date` reads one (verified against it).
      localZone,
      catalog: input.catalog,
      // What the host serves: the engine asks an optional family's method
      // only of a host that serves it, as the TypeScript engine reads its
      // host object (a park sink's, `canSuspend`).
      serves: servedHostMethods(input.host),
      // How much of a source file an extraction prompt takes: the
      // deployment's, read here so the engine reads no environment; the
      // number as written, a fraction included, which the marker prints.
      extractionFileChars: maxFileChars(),
      // How many named calls deep the run may nest (version 3): the
      // deployment's, read here for the same reason.
      maxCallDepth: maxCallDepth(),
      // What this deployment buys for each extraction tier: read here so the
      // engine reads no environment; the built-in table where it names none.
      extractionTiers: extractionTierAssignments(),
      // The chat models the model registry knows: an extraction call's
      // `model` is held to them, as `parseChatModelName` holds it.
      chatModels: [...chatModelNames],
    },
    'the segment input',
  );
}

/** What a segment ended in: its result, a refusal by its admission (nothing
 *  ran but its parse), or a decline after its check (nothing the host can
 *  see happened). */
type RunOutcome = { ran: MovementRunResult } | { refused: string; reasons: string[] } | { declined: string };

/**
 * The segment's `done` (crates/movement-engine/src/run.rs says its shapes):
 * the run's result, the error it failed with (a body's failure wrapped in
 * `MovementRunFailed`, carrying what the run did, as the interpreter wraps
 * it), or that it refused or declined.
 */
export function readRunResult(
  done: unknown,
  run: { context: Pick<RunContext, 'trace' | 'ledger'>; hostErrors: unknown[]; wire?: WireOut },
): RunOutcome {
  const outcome = record(done, 'the Rust engine result');
  if ('refused' in outcome) return refusalOf(outcome);
  if ('declined' in outcome) return { declined: string(outcome.declined, 'the Rust engine declined') };
  // What the segment's priced calls spent was charged to the run's account
  // as each answer passed through the shim (rust_host.ts), so a fault cannot
  // lose it. The engine reports the same lines from its own ledger: they
  // must agree.
  const reported = costBySource(outcome.cost ?? []);
  if (canonicalJson(reported) !== canonicalJson(run.context.ledger.spend.bySource)) {
    throw new RustShimError(
      `the Rust engine reports spending ${JSON.stringify(reported)}, but its host charged ${JSON.stringify(run.context.ledger.spend.bySource)}`,
    );
  }
  const trace = run.context.trace.entries;
  if ('thrown' in outcome) throw failureOf(outcome.thrown, run.hostErrors);
  if ('failed' in outcome) {
    const failed = record(outcome.failed, 'the Rust engine failure');
    throw new MovementRunFailed(failureOf(failed.error, run.hostErrors), resultOf(failed.result, trace, run.wire ?? new WireOut()));
  }
  if ('result' in outcome) return { ran: resultOf(outcome.result, trace, run.wire ?? new WireOut()) };
  throw new RustShimError(`the Rust engine finished with ${Object.keys(outcome).join(', ') || 'nothing'}, which this shim does not decode`);
}

/** An admission refusal: its first reason, and every reason, the first
 *  first (crates/movement-engine/src/run.rs). */
function refusalOf(outcome: Record<string, unknown>): { refused: string; reasons: string[] } {
  const refused = string(outcome.refused, 'the Rust engine refused');
  const { reasons } = outcome;
  if (!Array.isArray(reasons) || reasons[0] !== refused) {
    throw new RustShimError('the Rust engine refused with its reasons, the refused one first');
  }
  return { refused, reasons: reasons.map((reason, i) => string(reason, `the Rust engine refusal reason ${i}`)) };
}

const RESULT_KEYS: ReadonlySet<string> = new Set(['movementName', 'writes', 'extractionSites', 'parked', 'parkedAddress', 'cancelled', 'deferredRaceFrames']);

function resultOf(value: unknown, trace: MovementRunResult['trace'], wire: WireOut): MovementRunResult {
  const result = record(value, 'the Rust engine result');
  const unread = Object.keys(result).filter((key) => !RESULT_KEYS.has(key));
  if (unread.length > 0) {
    throw new RustShimError(`the Rust engine result has ${unread.join(', ')}, which this shim does not decode yet`);
  }
  if (result.cancelled !== undefined && result.cancelled !== true) throw new RustShimError('a cancelled result says true');
  if (result.parked !== undefined && result.parked !== true) throw new RustShimError('a parked result says true');
  // A value an adapter answered is in the writes as that very object.
  const writes = wire.read(result.writes ?? ['l', 0, []]);
  if (!Array.isArray(writes) || !writes.every(isWriteRecord)) throw new RustShimError('the Rust engine result writes are write records');
  const extractionSites = result.extractionSites === undefined ? {} : wire.read(result.extractionSites);
  if (!isSiteTable(extractionSites)) throw new RustShimError('the Rust engine result extractionSites are site summaries');
  // The spend fields are the run host's to add, read off the run's account
  // once the segment closes (run.ts `inRunContext`).
  return {
    movementName: string(result.movementName, 'the Rust engine result movementName'),
    writes,
    extractionSites,
    trace,
    ...(result.parked === true ? { parked: true, parkedAddress: string(result.parkedAddress, 'the parked address') } : {}),
    ...(result.cancelled === true ? { cancelled: true } : {}),
    ...(result.deferredRaceFrames !== undefined ? { deferredRaceFrames: deferredFrames(result.deferredRaceFrames) } : {}),
  };
}

/** The race frames a batch resume deferred, as addresses. */
function deferredFrames(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((frame) => typeof frame === 'string')) {
    throw new RustShimError('the Rust engine result deferredRaceFrames are addresses');
  }
  return value;
}

/** The extraction sites a result's provenance cites, by site id. */
function isSiteTable(value: unknown): value is MovementRunResult['extractionSites'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (site) =>
      typeof site === 'object' &&
      site !== null &&
      typeof Reflect.get(site, 'node') === 'string' &&
      typeof Reflect.get(site, 'description') === 'string' &&
      typeof Reflect.get(site, 'stage') === 'number' &&
      Array.isArray(Reflect.get(site, 'dataSources')),
  );
}

/** A write record off the wire: the fields every one carries. */
function isWriteRecord(value: unknown): value is MovementRunResult['writes'][number] {
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof Reflect.get(value, 'adapterType') === 'string'
    && typeof Reflect.get(value, 'recordType') === 'string'
    && typeof Reflect.get(value, 'created') === 'boolean'
    && typeof Reflect.get(value, 'committed') === 'boolean'
    && typeof Reflect.get(value, 'writtenValues') === 'object'
    && typeof Reflect.get(value, 'provenance') === 'object'
  );
}

/** The error the TypeScript engine would have thrown: rebuilt from its class,
 *  or the very one a host call failed with. */
function failureOf(value: unknown, hostErrors: unknown[]): unknown {
  const error = record(value, 'the Rust engine error');
  if ('hostError' in error) {
    const ref = error.hostError;
    if (typeof ref !== 'number' || ref < 0 || ref >= hostErrors.length) {
      throw new RustShimError(`the Rust engine failed with a host error this shim never answered (${String(ref)})`);
    }
    return hostErrors[ref];
  }
  return thrownBy(error);
}

// ── The WASM engine ───────────────────────────────────────────────────────────

/** A segment in a fresh instance of the movement artifact. */
export function openWasmEngine(): EngineProtocol {
  const segment = openEngineSegment();
  return {
    start: (input) => readStep(segment.start(JSON.stringify(input)), 'start'),
    answer: (id, answer) => readStep(segment.answer(id, JSON.stringify(answer)), `answer ${id}`),
    finish: () => segment.finish(),
  };
}

function readStep(reply: { ok: boolean; json: unknown }, call: string): EngineStep {
  const json = record(reply.json, `the Rust engine's ${call}`);
  if (!reply.ok) {
    const error = record(json.error, `the Rust engine's ${call} error`);
    throw new RustShimError(`the Rust engine refused ${call}: ${String(error.message)}`);
  }
  if ('done' in json) return { done: json.done };
  if (!Array.isArray(json.pending)) throw new RustShimError(`the Rust engine's ${call} returned no step`);
  return { pending: json.pending.map((request) => readRequest(request, call)) };
}

function readRequest(value: unknown, call: string): HostRequest {
  const request = record(value, `a request from the Rust engine's ${call}`);
  if (typeof request.id !== 'number') throw new RustShimError(`a request from the Rust engine's ${call} has no id`);
  return {
    id: request.id,
    family: string(request.family, 'a request family'),
    method: string(request.method, 'a request method'),
    args: request.args,
  };
}

// ── The evaluator ─────────────────────────────────────────────────────────────

/** The flat built-ins and namespaced members the Rust evaluator runs
 *  (crates/movement-engine/src/stdlib.rs): every one. Zones, URLs and
 *  normalisation it asks of this runtime through the artifact's
 *  environment import (movement-lang's wasm/env_services.ts). */
const RUST_FUNCTIONS: ReadonlySet<string> = new Set([
  'isnull', 'coalesce', 'trim', 'lower', 'upper', 'length', 'abs', 'round', 'floor', 'ceil', 'tostring', 'tonumber',
  'multi', 'split', 'date', 'datetime', 'number',
  'currency.get_number_from_figure', 'currency.get_code_from_figure', 'currency.format_figure',
  'date.parse', 'date.add_days', 'date.format', 'date.format_iso', 'date.today', 'datetime.at',
  'text.regex_extract', 'text.slug', 'text.pairs', 'text.serialise', 'url.host', 'number.format',
]);

/**
 * Whether the Rust evaluator runs `expr`: every node a kind it evaluates (no
 * host reads, no model, no traversal), every function one of its built-ins,
 * and every literal one the lowering carries as itself (a lone surrogate
 * crosses JSON as its escape, which the engine reads).
 */
export function rustCanEval(expr: Expression): boolean {
  const child = rustCanEval;
  switch (expr.type) {
    case 'static':
      return typeof expr.value !== 'number' || (Number.isFinite(expr.value) && !Object.is(expr.value, -0));
    case 'alias_ref':
    case 'property':
      return true;
    case 'at':
      return child(expr.expression) && child(expr.index);
    case 'list':
      return expr.elements.every((element) => child(listElementExpression(element)));
    case 'object':
      return expr.entries.every(
        (member) =>
          (isObjectSpread(member) || member.key !== '__proto__')
          && child(objectMemberExpression(member)),
      );
    case 'concat':
      return expr.parts.every((e) => child(e));
    case 'conditional':
      return child(expr.condition) && child(expr.then) && child(expr.else);
    case 'compare':
      return expr.op !== 'within' && child(expr.left) && child(expr.right);
    case 'logical':
      return expr.operands.every((e) => child(e));
    case 'not':
    case 'negate':
      return child(expr.expression);
    case 'arithmetic':
      return child(expr.left) && child(expr.right);
    case 'function':
      return RUST_FUNCTIONS.has(expr.fn) && expr.args.every((e) => child(e));
    default:
      return false;
  }
}

/** Whether a record (`bindingOf`) is anywhere inside `value`. */
function holdsBinding(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  if (bindingOf(value) !== undefined) return true;
  seen.add(value);
  return Object.values(value).some((member) => holdsBinding(member, seen));
}

/**
 * The zone this process's `Date` reads a date-time text with no offset in
 * (`new Date("2026-03-12T09:30")`, `Date.parse("March 12, 2026")`), as an
 * IANA name the Rust engine is handed (it reads no environment) — or
 * undefined when `Intl` names no zone `Date` agrees with.
 *
 * `Intl`'s resolved zone is `Date`'s for an IANA `TZ` only: under
 * `TZ=GMT+3` it says `+03:00` where `Date` reads POSIX's three hours WEST,
 * under `TZ=UTC+3` or `TZ=utc` it names none, under `TZ=""` `Etc/Unknown`.
 * So the name is checked against `Date`'s own wall clock at a winter, a
 * summer, a historic and a far-future instant; an ICU canonical name passes
 * (`Asia/Calcutta`, not `Asia/Kolkata`). A zone `Intl` cannot name at all
 * (`TZ=utc`, the dev and CLI scripts' setting) is tried as `UTC`, and sent
 * as that when `Date`'s clock agrees.
 */
export function processLocalZone(): string | undefined {
  const resolved: unknown = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const named = typeof resolved === 'string' && resolved !== '' && resolved !== 'Etc/Unknown';
  const zone = named ? resolved : 'UTC';
  const key = `${process.env.TZ ?? ''}\u0000${zone}`;
  const known = verifiedZones.get(key);
  if (known !== undefined) return known ? zone : undefined;
  // The wall clock each reads, to the second: `getTimezoneOffset` drops a
  // local mean time's seconds (Monrovia's −0:44:30 in 1950).
  const agrees = ZONE_PROBES.map((iso) => new Date(iso)).every(
    (at) => wallInZone(at, zone) === wallOfDate(at),
  );
  verifiedZones.set(key, agrees);
  return agrees ? zone : undefined;
}

/** Winter and summer in both hemispheres, an instant before most zones'
 *  present rules, and one under their final rules. Fixed instants: an
 *  engine file reads no clock (seam_guard). */
const ZONE_PROBES = ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z', '1950-07-01T12:00:00Z', '2100-07-15T12:00:00Z'];

/** Per `TZ` and resolved name: whether `Date` agrees with the name. */
const verifiedZones = new Map<string, boolean>();

/** `at` on `zone`'s wall clock, as `Intl` reads it. */
function wallInZone(at: Date, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].join(' ');
}

/** `at` on the wall clock this process's `Date` reads. */
function wallOfDate(at: Date): string {
  return [at.getFullYear(), at.getMonth() + 1, at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()].join(' ');
}

/**
 * `expr` evaluated by the Rust engine, or undefined where the TypeScript
 * evaluator must answer: not admitted, a name that is not a value binding, a
 * value that cannot cross as itself, or a reading Rust does not reproduce
 * (its `fallback`). Errors are thrown as the TypeScript evaluator throws them.
 */
export function evalInRust(expr: Expression, ctx: MovementExprContext): MovementEvalResult | undefined {
  const notAdmitted = (): undefined => {
    rustEvalStats.notAdmitted += 1;
    return undefined;
  };
  if (!rustCanEval(expr)) return notAdmitted();
  const wire = new WireOut();
  const bindings: Record<string, unknown> = {};
  const read = new Map<string, Extract<Binding, { kind: 'value' }>>();
  for (const name of namesRead(expr)) {
    const binding = ctx.env.resolve(name);
    if (binding?.kind !== 'value') return notAdmitted();
    // The one place the TypeScript engine's own values cross: a record a
    // value holds stays with the evaluator that made it.
    if (holdsBinding(binding.value)) return notAdmitted();
    const value = wire.value(binding.value);
    if (value === REFUSED) return notAdmitted();
    read.set(name, binding);
    bindings[name] = {
      value,
      ...(binding.provenance !== undefined ? { provenance: wire.trail(binding.provenance) } : {}),
      ...(binding.many === true ? { many: true } : {}),
    };
  }
  rustEvalStats.admitted += 1;
  const localZone = processLocalZone();
  if (localZone === undefined) {
    rustEvalStats.fallback[LOCAL_ZONE_UNVERIFIED] = (rustEvalStats.fallback[LOCAL_ZONE_UNVERIFIED] ?? 0) + 1;
    return undefined;
  }
  const envelope = {
    bindings,
    origins: wire.origins.length,
    languageVersion: ctx.languageVersion,
    // The run's pinned instant, which DATE.TODAY reads.
    now: pinnedNow(ctx).toISOString(),
    // The zone a date-time text with no offset is read in.
    localZone,
  };
  const reply = callEvalExpression(JSON.stringify(expr), JSON.stringify(envelope));
  const answer = record(reply.json, 'the Rust evaluator reply');
  if (!reply.ok) {
    throw new RustShimError(`the Rust evaluator refused its input: ${String(record(answer.error, 'its error').message)}`);
  }
  if ('fallback' in answer) {
    const reason = String(answer.fallback);
    rustEvalStats.fallback[reason] = (rustEvalStats.fallback[reason] ?? 0) + 1;
    return undefined;
  }
  rustEvalStats.answered += 1;
  if ('error' in answer) throw thrownBy(record(answer.error, 'the Rust evaluator error'));
  const literal = new Map<number, ProvenanceOrigin>();
  const origin = (id: unknown): ProvenanceOrigin => {
    if (typeof id !== 'number') throw new RustShimError(`an origin id is a number, not ${String(id)}`);
    const own = wire.origins[id];
    if (own !== undefined) return own;
    // A literal the evaluation read: one fresh origin per literal, shared
    // between `origins` and `direct` as `fromOrigin` shares it.
    let minted = literal.get(id);
    if (minted === undefined) {
      minted = { kind: 'literal', ...(ctx.literalSpan !== undefined ? { span: ctx.literalSpan } : {}) };
      literal.set(id, minted);
    }
    return minted;
  };
  const trail = record(answer.provenance, 'the Rust evaluator provenance');
  let provenance: Provenance;
  if (typeof trail.binding === 'string') {
    provenance = read.get(trail.binding)?.provenance ?? NO_PROVENANCE;
  } else {
    if (!Array.isArray(trail.origins)) throw new RustShimError('the Rust evaluator provenance has no origins');
    provenance = {
      origins: trail.origins.map(origin),
      ...(trail.direct !== undefined ? { direct: origin(trail.direct) } : {}),
    };
  }
  return { value: wire.read(answer.value), provenance };
}

/** The names `expr` reads: its `alias_ref`s and rootless `property` reads. */
function namesRead(expr: Expression, into: Set<string> = new Set()): Set<string> {
  switch (expr.type) {
    case 'alias_ref':
      into.add(expr.name);
      break;
    case 'property':
      into.add(expr.propertyTypeId);
      break;
    case 'at':
      namesRead(expr.expression, into);
      namesRead(expr.index, into);
      break;
    case 'list':
      for (const element of expr.elements) namesRead(listElementExpression(element), into);
      break;
    case 'object':
      for (const member of expr.entries) namesRead(objectMemberExpression(member), into);
      break;
    case 'concat':
      for (const part of expr.parts) namesRead(part, into);
      break;
    case 'conditional':
      namesRead(expr.condition, into);
      namesRead(expr.then, into);
      namesRead(expr.else, into);
      break;
    case 'compare':
    case 'arithmetic':
      namesRead(expr.left, into);
      namesRead(expr.right, into);
      break;
    case 'logical':
      for (const operand of expr.operands) namesRead(operand, into);
      break;
    case 'not':
    case 'negate':
      namesRead(expr.expression, into);
      break;
    case 'function':
      for (const a of expr.args) namesRead(a, into);
      break;
    default:
      break;
  }
  return into;
}

/** The error the TypeScript engine would have thrown. */
function thrownBy(error: Record<string, unknown>): Error {
  // A run that met its cost cap where it could not suspend: the error is
  // rebuilt from its figures, message and all, as the TypeScript ledger
  // builds it.
  if (error.class === 'RunCostCapExceeded') {
    const { capMicrodollars, spentMicrodollars } = error;
    if (typeof capMicrodollars !== 'number' || typeof spentMicrodollars !== 'number') {
      throw new RustShimError('a RunCostCapExceeded carries its cap and spend as numbers');
    }
    return new RunCostCapExceeded(capMicrodollars, spentMicrodollars);
  }
  // A call past the depth limit: rebuilt from its limit and chain, message
  // and all, as call_depth.ts builds it.
  if (error.class === 'CallDepthExceeded') {
    const { limit, chain } = error;
    if (typeof limit !== 'number' || !Array.isArray(chain) || !chain.every((name): name is string => typeof name === 'string')) {
      throw new RustShimError('a CallDepthExceeded carries its limit and its chain of names');
    }
    return new CallDepthExceeded(limit, chain);
  }
  const message = string(error.message, 'the Rust evaluator error message');
  switch (error.class) {
    case 'MovementEngineError':
      return new MovementEngineError(engineErrorCode(error.code), message);
    case 'Error':
      return new Error(message);
    case 'RangeError':
      return new RangeError(message);
    case 'TypeError':
      return new TypeError(message);
    default:
      throw new RustShimError(`the Rust evaluator threw an unknown class ${String(error.class)}`);
  }
}

/** The codes the Rust engine throws with. */
function engineErrorCode(code: unknown): MovementEngineErrorCode {
  switch (code) {
    case 'MOVENG_RUNTIME':
    case 'MOVENG_UNSUPPORTED':
    case 'MOVENG_NOT_FOUND':
    case 'MOVENG_ERROR':
    case 'MOVENG_PARK_NONSERIALIZABLE':
      return code;
    default:
      throw new RustShimError(`the Rust evaluator threw an unknown code ${String(code)}`);
  }
}

