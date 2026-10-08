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
// by this shim's input check on a resume (`rustResumeRefusal`: what the run is
// handed, never what its program says), and then by the Rust engine
// itself: its admission walks its own parse of the program before it asks for
// anything (crates/movement-engine/src/admit.rs). What it refuses or declines
// runs on the TypeScript engine. Each decision is logged once per run
// (`noteEngine`) and counted (`rustRunStats`).
//
// Below a whole program, one expression can already run in Rust: `evalInRust`
// is the TypeScript evaluator's switch (expression.ts `evalMovementExpr`) for
// an expression `rustCanEval` admits whose every name is a value binding.

import { callEvalExpression, CURRENT_LANGUAGE_VERSION, openEngineSegment } from 'movement-lang';
// Internal to movement-lang: the Rust bridge below (delete with 5B).
import { withEnvNow } from 'movement-lang/wasm/env_services';

import type { Expression } from '#shared/expression/types';
import { isObjectSpread, listElementExpression, objectMemberExpression } from '#shared/expression/types';
import { RunCostCapExceeded } from '../../lib/run_cost';
import { logger } from '../logger';
import { MovementEngineError, type MovementEngineErrorCode } from './errors';
import type { Binding, MovementEvalResult, MovementExprContext } from './expression';
import { pinnedNow } from './expression';
import { NO_PROVENANCE, type Provenance, type ProvenanceOrigin } from './provenance';
import { MovementRunFailed, type MovementRunResult, type ResumeMovementInput, type RunMovementInput } from './run';
import type { RunContext } from './run_context';
import { serve, type RouteContext } from './rust_host';
import { rustEvalStats, rustRunStats } from './rust_stats';
import { LONE_SURROGATE, REFUSED, RustShimError, WireOut, plainJson, record, string } from './rust_wire';

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

/** For a process's boot: a bad `MOVEMENT_ENGINE` fails startup rather than
 *  every run. */
export function assertEngineChoiceConfigured(env: Record<string, string | undefined> = process.env): void {
  engineChoice(env);
}

/** What a segment in the Rust engine runs: the run's input and the segment
 *  the run host opened. */
export interface RustSegment<Input extends RunMovementInput = RunMovementInput> {
  input: Input;
  context: RunContext;
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
 *  adapter. */
export async function resumeSegmentInRust(
  segment: RustSegment<ResumeMovementInput>,
  engine?: EngineProtocol,
): Promise<{ ran: MovementRunResult } | { declined: string }> {
  const { input } = segment;
  return segmentInRust(segment, { state: input.state, ...(input.reenter === true ? { reenter: true } : {}) }, engine);
}

async function segmentInRust(
  { input, context }: RustSegment,
  resume: { state: unknown; reenter?: true } | undefined,
  engine?: EngineProtocol,
): Promise<{ ran: MovementRunResult } | { declined: string }> {
  // Read before the instance opens. An event, source or state that cannot
  // cross the eval wire as itself (a `Date` in a payload, a lone surrogate)
  // is refused here, before the engine has asked the host for anything.
  const start = segmentInput(input, context, resume);
  if (start === undefined) return notAdmitted(input, EVENT_DOES_NOT_CROSS);
  rustRunStats.routed += 1;
  const hostErrors: unknown[] = [];
  let outcome: RunOutcome;
  try {
    const done = await driveEngine(withPinnedEnvClock(engine ?? openWasmEngine(), context.pinnedNow), start, {
      host: input.host,
      context,
      catalog: input.catalog,
      hostErrors,
    });
    outcome = readRunResult(done, { context, hostErrors });
  } catch (error) {
    // Anything but a refusal ends in a `done` past admission.
    rustRunStats.admitted += 1;
    // The run's own failure, which the Rust engine ran to as the TypeScript
    // engine would have; a shim fault is not one.
    if (error instanceof RustShimError) {
      rustRunStats.shimFaults += 1;
      noteEngine(input, 'rust', 'shim_fault');
    } else {
      rustRunStats.ranWhole += 1;
      noteEngine(input, 'rust', ADMITTED);
    }
    throw error;
  }
  if ('refused' in outcome) return notAdmitted(input, outcome.refused);
  rustRunStats.admitted += 1;
  if ('declined' in outcome) {
    rustRunStats.declined[outcome.declined] = (rustRunStats.declined[outcome.declined] ?? 0) + 1;
    noteEngine(input, 'ts', outcome.declined);
    return outcome;
  }
  rustRunStats.ranWhole += 1;
  noteEngine(input, 'rust', ADMITTED);
  return outcome;
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

/** The reason a run the Rust engine ran is logged with. */
const ADMITTED = 'admitted';

/** A run that never ran in Rust: counted by its reason, and logged. */
function notAdmitted(input: Pick<RunMovementInput, 'runId'>, reason: string): { declined: string } {
  rustRunStats.notAdmitted[reason] = (rustRunStats.notAdmitted[reason] ?? 0) + 1;
  noteEngine(input, 'ts', reason);
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
export function noteEngine(input: Pick<RunMovementInput, 'runId'>, engine: EngineChoice, reason: string): void {
  const line = `movement engine: engine=${engine} run=${input.runId ?? '-'} reason=${reason}`;
  if (reason === ENGINE_CHOICE_TS) logger.debug(line);
  else logger.info(line);
}

/** Why the TypeScript engine runs a run that `MOVEMENT_ENGINE` did not route. */
export const ENGINE_CHOICE_TS = 'movement_engine_ts';

/**
 * Why the Rust engine must not resume this run, read off its input alone:
 * a resume that answers into its leaf or defers a race's settlement. The
 * parked state itself is the Rust engine's to read
 * (crates/movement-engine/src/park.rs `resume_refusal`), and a run's pause
 * and suspensions (`limitPaused`, `suspendAt`, a cost cap) are its own.
 * Counted and logged as not admitted; undefined to route the resume.
 */
export function rustResumeRefusal(
  input: Pick<ResumeMovementInput, 'runId' | 'answer' | 'deferRaceSettlement'>,
): string | undefined {
  const reason =
    input.answer !== undefined ? 'resume_answer'
    : input.deferRaceSettlement === true ? 'resume_defers_race_settlement'
    : undefined;
  if (reason !== undefined) notAdmitted(input, reason);
  return reason;
}

/**
 * Runs one segment to its result: starts it, serves every request it issues
 * from `input.host` concurrently, answers each as it settles, and finishes
 * the segment however the run ends.
 */
export async function driveEngine(
  engine: EngineProtocol,
  start: unknown,
  input: Omit<RouteContext, 'hostErrors' | 'positions'> & {
    /** The errors host calls failed with, by the `ref` their answers carry. */
    hostErrors?: unknown[];
  },
): Promise<unknown> {
  const context: RouteContext = { ...input, hostErrors: input.hostErrors ?? [], positions: new Map() };
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
      const next = await settled.next();
      inFlight -= 1;
      if ('failure' in next) throw next.failure;
      step = engine.answer(next.id, next.answer);
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
function segmentInput(input: RunMovementInput, context: RunContext, resume?: { state: unknown; reenter?: true }): unknown {
  const event = new WireOut().value(input.event);
  if (event === REFUSED || LONE_SURROGATE.test(input.source)) return undefined;
  const state = resume !== undefined ? new WireOut({ asData: true }).value(resume.state) : undefined;
  if (state === REFUSED) return undefined;
  return plainJson(
    {
      entry: 'segment',
      ...(input.dryRun === true ? { dryRun: true } : {}),
      ...(resume !== undefined ? { resume: { ...resume, state } } : {}),
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
      catalog: input.catalog,
    },
    'the segment input',
  );
}

/** What a segment ended in: its result, a refusal by its admission (nothing
 *  ran but its parse), or a decline after its check (nothing the host can
 *  see happened). */
type RunOutcome = { ran: MovementRunResult } | { refused: string } | { declined: string };

/**
 * The segment's `done` (crates/movement-engine/src/run.rs says its shapes):
 * the run's result, the error it failed with (a body's failure wrapped in
 * `MovementRunFailed`, carrying what the run did, as the interpreter wraps
 * it), or that it refused or declined.
 */
export function readRunResult(
  done: unknown,
  run: { context: Pick<RunContext, 'trace' | 'ledger'>; hostErrors: unknown[] },
): RunOutcome {
  const outcome = record(done, 'the Rust engine result');
  if ('refused' in outcome) return { refused: string(outcome.refused, 'the Rust engine refused') };
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
    throw new MovementRunFailed(failureOf(failed.error, run.hostErrors), resultOf(failed.result, trace));
  }
  if ('result' in outcome) return { ran: resultOf(outcome.result, trace) };
  throw new RustShimError(`the Rust engine finished with ${Object.keys(outcome).join(', ') || 'nothing'}, which this shim does not decode`);
}

const RESULT_KEYS: ReadonlySet<string> = new Set(['movementName', 'writes', 'parked', 'parkedAddress', 'cancelled']);

function resultOf(value: unknown, trace: MovementRunResult['trace']): MovementRunResult {
  const result = record(value, 'the Rust engine result');
  const unread = Object.keys(result).filter((key) => !RESULT_KEYS.has(key));
  if (unread.length > 0) {
    throw new RustShimError(`the Rust engine result has ${unread.join(', ')}, which this shim does not decode yet`);
  }
  if (result.cancelled !== undefined && result.cancelled !== true) throw new RustShimError('a cancelled result says true');
  if (result.parked !== undefined && result.parked !== true) throw new RustShimError('a parked result says true');
  const writes = new WireOut().read(result.writes ?? ['l', 0, []]);
  if (!Array.isArray(writes) || !writes.every(isWriteRecord)) throw new RustShimError('the Rust engine result writes are write records');
  // The spend fields are the run host's to add, read off the run's account
  // once the segment closes (run.ts `inRunContext`).
  return {
    movementName: string(result.movementName, 'the Rust engine result movementName'),
    writes,
    extractionSites: {},
    trace,
    ...(result.parked === true ? { parked: true, parkedAddress: string(result.parkedAddress, 'the parked address') } : {}),
    ...(result.cancelled === true ? { cancelled: true } : {}),
  };
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

/**
 * Bridge — delete with the Rust engine merge (5B).
 *
 * `engine` with its environment clock held at the segment's pinned instant
 * through every step. The Rust engine still reads its own clock for a timer's
 * wake time; held there, what it computes is the pinned instant plus the
 * sleep, which the shim re-bases on the host's `clock.now` as it commits the
 * park (rust_host.ts) — the request the TypeScript engine makes there. (The
 * Rust engine asking `clock.now` itself lands with its merge.)
 */
function withPinnedEnvClock(engine: EngineProtocol, pinnedNow: Date): EngineProtocol {
  const at = pinnedNow.getTime();
  return {
    start: (input) => withEnvNow(at, () => engine.start(input)),
    answer: (id, answer) => withEnvNow(at, () => engine.answer(id, answer)),
    finish: () => engine.finish(),
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
 * and every literal and name one JSON carries as itself into a Rust string.
 */
export function rustCanEval(expr: Expression): boolean {
  const child = rustCanEval;
  switch (expr.type) {
    case 'static':
      if (typeof expr.value === 'string') return !LONE_SURROGATE.test(expr.value);
      return typeof expr.value !== 'number' || (Number.isFinite(expr.value) && !Object.is(expr.value, -0));
    case 'alias_ref':
      return !LONE_SURROGATE.test(expr.name);
    case 'property':
      return !LONE_SURROGATE.test(expr.propertyTypeId);
    case 'at':
      return child(expr.expression) && child(expr.index);
    case 'list':
      return expr.elements.every((element) => child(listElementExpression(element)));
    case 'object':
      return expr.entries.every(
        (member) =>
          (isObjectSpread(member) || (member.key !== '__proto__' && !LONE_SURROGATE.test(member.key)))
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
  // The Rust evaluator refuses an evaluation with no pin: it has no release
  // version to fall back to. A context without one is the TypeScript
  // evaluator's to answer, under its own rule for that case.
  const languageVersion = ctx.languageVersion;
  if (languageVersion === undefined) return notAdmitted();
  const wire = new WireOut();
  const bindings: Record<string, unknown> = {};
  const read = new Map<string, Extract<Binding, { kind: 'value' }>>();
  for (const name of namesRead(expr)) {
    const binding = ctx.env.resolve(name);
    if (binding?.kind !== 'value') return notAdmitted();
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
  const envelope = {
    bindings,
    origins: wire.origins.length,
    languageVersion,
    // The run's pinned instant, which DATE.TODAY reads.
    now: pinnedNow(ctx).toISOString(),
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
  const message = string(error.message, 'the Rust evaluator error message');
  switch (error.class) {
    case 'MovementEngineError':
      return new MovementEngineError(engineErrorCode(error.code), message);
    case 'Error':
      return new Error(message);
    case 'RangeError':
      return new RangeError(message);
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
      return code;
    default:
      throw new RustShimError(`the Rust evaluator threw an unknown code ${String(code)}`);
  }
}

