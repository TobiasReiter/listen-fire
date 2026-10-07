// The TypeScript side of the Rust engine (crates/movement-engine). A segment
// runs inside its own WASM instance; whatever it needs from the world it asks
// for as `{id, family, method, args}` requests, and this shim serves each one
// from the run's `EngineHost`, several at once when the engine issues several,
// answering each by id as it settles. The live objects the host deals in stay
// here: an adapter the engine resolves becomes a numeric instance handle, and
// the engine calls its methods by that handle.
//
// Which engine runs a program is decided by `MOVEMENT_ENGINE` (`engineChoice`)
// and by `rustCanRun`, the allow-list of what the Rust engine can already run
// whole (bindings, `if` and `return` over reads of the event and of values,
// slice 2a). It grows one slice at a time, each proven against the TypeScript
// engine on the same programs.
//
// Below a whole program, one expression can already run in Rust: `evalInRust`
// is the TypeScript evaluator's switch (expression.ts `evalMovementExpr`) for
// an expression `rustCanEval` admits whose every name is a value binding.

import {
  applyStdlib,
  callEvalExpression,
  readCall,
  resolveCallee,
  conditionOfSlot,
  CURRENT_LANGUAGE_VERSION,
  expressionOfSlot,
  openEngineSegment,
  stdlibFunctionById,
  type CatalogSnapshot,
  type CallStatement,
  type ExprSlot,
  type LanguageVersion,
  type MovementCondition,
  type Program,
  type Statement,
} from 'movement-lang';

import { compareValues } from '#shared/expression/filter';
import type { Expression, FilterOperator } from '#shared/expression/types';
import { isObjectSpread, listElementExpression, objectMemberExpression } from '#shared/expression/types';
import { currentRunSpend } from '../../lib/run_spend';
import { neverAsAny } from '../../lib/utils/types';
import type { Adapter } from '../translation_graph/adapter';
import { applyMovementFunction } from './builtins';
import { MovementEngineError, type MovementEngineErrorCode } from './errors';
import { bindingOf, type Binding, type MovementEvalResult, type MovementExprContext } from './expression';
import type { EngineHost } from './host';
import { checkAnswer, checkPinned } from './program_check';
import { rustEvalStats, rustRunStats } from './rust_stats';
import { NO_PROVENANCE, type Provenance, type ProvenanceOrigin } from './provenance';
import { MovementRunFailed, type MovementRunResult, type RunMovementInput } from './run';

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

/** The run ends with this host call's error rather than the engine hearing
 *  it: what the TypeScript engine throws before it runs anything (the check),
 *  the Rust engine must not be able to catch. */
class RunAborted extends Error {
  constructor(readonly abortedWith: unknown) {
    super('the run was aborted by a host call');
  }
}

/** A fault in the shim itself (a request it has no route for, a result it
 *  cannot carry), never handed to the engine as an answer: the run fails. */
export class RustShimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RustShimError';
  }
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

/** A segment of `input`'s run in the Rust engine: its result, or that the
 *  engine declined it (before it touched an adapter) for the TypeScript
 *  engine to run. */
export async function runSegmentInRust(
  input: RunMovementInput,
  engine?: EngineProtocol,
): Promise<{ ran: MovementRunResult } | { declined: string }> {
  // Read before the instance opens: an input that cannot cross must not
  // leave a segment open behind it.
  const start = segmentInput(input);
  if (start === undefined) throw new RustShimError('this run cannot cross to the Rust engine (rustCanRun admits none such)');
  const trace = input.host.trace ?? [];
  const hostErrors: unknown[] = [];
  rustRunStats.routed += 1;
  const done = await driveEngine(engine ?? openWasmEngine(), start, { ...input, trace, hostErrors });
  const outcome = readRunResult(done, { trace, hostErrors });
  if ('declined' in outcome) rustRunStats.declined[outcome.declined] = (rustRunStats.declined[outcome.declined] ?? 0) + 1;
  return outcome;
}

/**
 * Runs one segment to its result: starts it, serves every request it issues
 * from `input.host` concurrently, answers each as it settles, and finishes
 * the segment however the run ends.
 */
export async function driveEngine(
  engine: EngineProtocol,
  start: unknown,
  input: Pick<RunMovementInput, 'host' | 'teamId' | 'catalog'> & {
    /** Where the engine's trace entries land (`host.trace`, else the run's own). */
    trace?: MovementRunResult['trace'];
    /** The errors host calls failed with, by the `ref` their answers carry. */
    hostErrors?: unknown[];
  },
): Promise<unknown> {
  const context: RouteContext = {
    host: input.host,
    teamId: input.teamId,
    instances: new Map(),
    catalog: input.catalog,
    trace: input.trace ?? [],
    hostErrors: input.hostErrors ?? [],
  };
  const inFlight = new Map<number, Promise<{ id: number; answer: HostAnswer }>>();
  try {
    let step = engine.start(start);
    for (;;) {
      if ('done' in step) return step.done;
      for (const request of step.pending) {
        const served = serve(request, context).then((answer) => ({ id: request.id, answer }));
        // Observed here so a shim fault in a request the race below never
        // reaches is not an unhandled rejection; the race still sees it.
        served.catch(() => undefined);
        inFlight.set(request.id, served);
      }
      if (inFlight.size === 0) throw new RustShimError('the Rust engine is waiting with no request in flight');
      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled.id);
      step = engine.answer(settled.id, settled.answer);
    }
  } finally {
    engine.finish();
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

interface RouteContext {
  host: EngineHost;
  teamId: RunMovementInput['teamId'];
  /** The live adapters behind the handles the engine holds, numbered from 1. */
  instances: Map<number, Adapter>;
  catalog: CatalogSnapshot;
  trace: MovementRunResult['trace'];
  hostErrors: unknown[];
}

type Route = (args: unknown, context: RouteContext) => Promise<unknown>;

/**
 * Every host call the engine can make, by family and method. The request
 * shapes are the engine's (crates/movement-engine/src/host.rs, one builder
 * each); a route reads its args at this boundary and answers plain data.
 */
const ROUTES: Record<string, Record<string, Route> | undefined> = {
  check: {
    /** The TypeScript checker over the pinned source (program_check.ts):
     *  every diagnostic, the import link and the checker's AST stamps as
     *  data. A program that fails its check ends the run with the check's
     *  error, exactly as parseAndCheck throws it. */
    async program(args, context) {
      const request = record(args, 'check.program');
      const languageVersion = request.languageVersion;
      if (typeof languageVersion !== 'number') throw new RustShimError('check.program languageVersion must be a number');
      const upgradingFrom = request.upgradingFrom;
      if (upgradingFrom !== undefined && typeof upgradingFrom !== 'number') {
        throw new RustShimError('check.program upgradingFrom must be a number');
      }
      const resolveFile = context.host.files.resolveFile;
      let checked;
      try {
        checked = checkPinned({
          source: string(request.source, 'check.program source'),
          catalog: context.catalog,
          languageVersion,
          ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
          ...(resolveFile !== undefined ? { hostResolveFile: resolveFile } : {}),
        });
      } catch (error) {
        throw new RunAborted(error);
      }
      return checkAnswer(checked);
    },
  },
  adapters: {
    async resolve(args, context) {
      const request = record(args, 'adapters.resolve');
      if (request.teamId !== context.teamId) {
        throw new RustShimError(`adapters.resolve asked for team ${String(request.teamId)} in a run of another team`);
      }
      const role = request.role;
      if (role !== 'source' && role !== 'target') {
        throw new RustShimError(`adapters.resolve role must be "source" or "target", not ${JSON.stringify(role)}`);
      }
      const credentialsId = optionalString(request.credentialsId, 'adapters.resolve credentialsId');
      const constructionArgs = optionalStringRecord(request.constructionArgs, 'adapters.resolve constructionArgs');
      const adapter = await context.host.adapters.resolve({
        adapterType: string(request.adapterType, 'adapters.resolve adapterType'),
        teamId: context.teamId,
        role,
        ...(credentialsId !== undefined ? { credentialsId } : {}),
        ...(constructionArgs !== undefined ? { constructionArgs } : {}),
      });
      const instance = context.instances.size + 1;
      context.instances.set(instance, adapter);
      return { instance, adapterType: adapter.adapterType };
    },
    async credentialId(args, context) {
      const request = record(args, 'adapters.credentialId');
      return context.host.adapters.credentialId(string(request.credentialName, 'adapters.credentialId credentialName'));
    },
    async call(args, context) {
      const request = record(args, 'adapters.call');
      const method = string(request.method, 'adapters.call method');
      const instance = request.instance;
      const adapter = typeof instance === 'number' ? context.instances.get(instance) : undefined;
      if (adapter === undefined) throw new RustShimError(`adapters.call ${method}: no adapter instance ${String(instance)}`);
      const fn: unknown = Reflect.get(adapter, method);
      if (typeof fn !== 'function') {
        throw new RustShimError(`adapters.call: the ${adapter.adapterType} adapter has no method ${method}`);
      }
      if (!Array.isArray(request.args)) throw new RustShimError(`adapters.call ${method}: args must be an array`);
      if (request.wire !== true) return Reflect.apply(fn, adapter, request.args);
      // On the eval wire both ways: the JavaScript's key order, `undefined`
      // and the numbers JSON cannot say cross as they are.
      const values = request.args.map((arg) => new WireOut().read(arg));
      return new Wired(await Reflect.apply(fn, adapter, values), `adapters.call ${method}`);
    },
  },
  control: {
    /** The cancel gate at a statement boundary. */
    async cancelled(_args, context) {
      return context.host.control.cancel.cancelled();
    },
    /** The run's last, undebounced, cancel check. */
    async cancelledNow(_args, context) {
      return context.host.control.cancel.cancelledNow();
    },
  },
  trace: {
    /** One entry on the run's trace, as it lands. */
    async append(args, context) {
      const entry = traceEntry(record(args, 'trace.append').entry);
      context.trace.push(entry);
      return undefined;
    },
  },
  builtins: {
    /** A built-in the Rust engine hands back for these arguments, answered by
     *  the TypeScript member: its value, or what it throws. */
    async function(args) {
      const request = record(args, 'builtins.function');
      const id = string(request.id, 'builtins.function id');
      if (!Array.isArray(request.args)) throw new RustShimError('builtins.function args must be an array');
      const values = request.args.map((arg) => new WireOut().read(arg));
      const now = new Date(string(request.now, 'builtins.function now'));
      const spec = stdlibFunctionById(id);
      return builtinAnswer(() => (spec !== undefined ? applyStdlib(spec, values, now) : applyMovementFunction(id, values)));
    },
    /** The shared comparator, likewise. */
    async compare(args) {
      const request = record(args, 'builtins.compare');
      const op = filterOperator(request.op);
      const left = new WireOut().read(request.left);
      const right = new WireOut().read(request.right);
      return builtinAnswer(() => compareValues(left, op, right));
    },
  },
};

async function serve(request: HostRequest, context: RouteContext): Promise<HostAnswer> {
  const route = ROUTES[request.family]?.[request.method];
  const label = `${request.family}.${request.method}`;
  if (route === undefined) throw new RustShimError(`the shim has no route for ${label}`);
  rustRunStats.hostCalls[label] = (rustRunStats.hostCalls[label] ?? 0) + 1;
  let value: unknown;
  try {
    value = await route(request.args, context);
  } catch (error) {
    if (error instanceof RustShimError) throw error;
    if (error instanceof RunAborted) throw error.abortedWith;
    // The host's own failure: the engine decides what it means for the run.
    // The error itself stays here, under the `ref` its answer carries, so a
    // run that fails with it fails with this very object.
    context.hostErrors.push(error);
    return { error: { ...errorAnswer(error), ref: context.hostErrors.length - 1 } };
  }
  const named = adapterCallName(request) ?? label;
  if (value instanceof Wired) {
    const wire = new WireOut().value(value.value);
    if (wire === REFUSED) throw new RustShimError(`${value.what} returned a value the eval wire cannot carry as itself`);
    return { value: wire };
  }
  return value === undefined ? {} : { value: plainJson(value, named) };
}

/** A route's value to send on the eval wire rather than as JSON. */
class Wired {
  constructor(
    readonly value: unknown,
    readonly what: string,
  ) {}
}

/** `{value: wire}` or `{threw: {class, code?, message}}`. */
function builtinAnswer(run: () => unknown): unknown {
  let value: unknown;
  try {
    value = run();
  } catch (error) {
    if (error instanceof MovementEngineError) return { threw: { class: 'MovementEngineError', code: error.code, message: unprefixed(error) } };
    if (error instanceof RangeError) return { threw: { class: 'RangeError', message: error.message } };
    if (error instanceof Error && error.constructor === Error) return { threw: { class: 'Error', message: error.message } };
    throw new RustShimError(`a built-in threw what the Rust engine cannot rethrow: ${String(error)}`);
  }
  const wire = new WireOut().value(value);
  if (wire === REFUSED) throw new RustShimError('a built-in answered a value the eval wire cannot carry as itself');
  return { value: wire };
}

/** A MovementEngineError's message without the `CODE: ` its constructor adds. */
function unprefixed(error: MovementEngineError): string {
  const prefix = `${error.code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

function filterOperator(value: unknown): FilterOperator {
  switch (value) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'exists':
    case 'in':
    case 'contains':
    case 'within':
      return value;
    default:
      throw new RustShimError(`builtins.compare op ${JSON.stringify(value)} is not an operator`);
  }
}

/** The trace entry kinds the Rust engine appends (crates/movement-engine/src/trace.rs). */
function traceEntry(value: unknown): MovementRunResult['trace'][number] {
  const entry = record(value, 'trace.append entry');
  switch (entry.kind) {
    case 'gate':
      if (typeof entry.outcome !== 'boolean') throw new RustShimError('a gate trace entry has a boolean outcome');
      return { kind: 'gate', outcome: entry.outcome };
    case 'warning':
      return { kind: 'warning', code: string(entry.code, 'a warning code'), message: string(entry.message, 'a warning message') };
    case 'field_miss': {
      const available = entry.available;
      if (!Array.isArray(available) || !available.every((key) => typeof key === 'string')) {
        throw new RustShimError('a field_miss trace entry lists its available keys');
      }
      return {
        kind: 'field_miss',
        binding: string(entry.binding, 'a field_miss binding'),
        field: string(entry.field, 'a field_miss field'),
        available,
      };
    }
    default:
      throw new RustShimError(`the Rust engine appended a trace entry this shim does not know: ${String(entry.kind)}`);
  }
}

function adapterCallName(request: HostRequest): string | undefined {
  if (request.family !== 'adapters' || request.method !== 'call') return undefined;
  const args = request.args;
  const method = typeof args === 'object' && args !== null ? Reflect.get(args, 'method') : undefined;
  return typeof method === 'string' ? `adapters.call ${method}` : undefined;
}

function errorAnswer(error: unknown): { message: string; name?: string } {
  if (error instanceof Error) return { message: error.message, name: error.name };
  return { message: String(error) };
}

// ── Boundary checks ───────────────────────────────────────────────────────────

/**
 * `value` itself when it is plain JSON (objects with no prototype but
 * Object's, arrays, strings, finite numbers, booleans, null); otherwise a
 * shim error naming the method that produced it. A stream, a closure, a Date
 * or a Map would not survive the crossing, and silently changing it into
 * something that does would hand the engine a different value.
 */
export function plainJson(value: unknown, method: string, at = ''): unknown {
  const where = at === '' ? '' : ` at ${at}`;
  const kind = typeof value;
  switch (kind) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (Number.isFinite(value)) return value;
      throw new RustShimError(`${method} returned ${String(value)}${where}, which JSON cannot carry`);
    case 'object':
      return plainJsonObject(value, method, at);
    case 'undefined':
    case 'function':
    case 'bigint':
    case 'symbol':
      throw new RustShimError(`${method} returned a ${kind}${where}, which is not plain JSON`);
    default:
      return neverAsAny(kind);
  }
}

/** `plainJson` for a value whose `typeof` is `object`. */
function plainJsonObject(value: unknown, method: string, at: string): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    value.forEach((item, i) => plainJson(item, method, `${at}[${i}]`));
    return value;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const kind = value.constructor?.name ?? 'an object with a prototype';
    const where = at === '' ? '' : ` at ${at}`;
    throw new RustShimError(`${method} returned a ${kind}${where}, which is not plain JSON`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) plainJson(entry, method, at === '' ? key : `${at}.${key}`);
  }
  return value;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RustShimError(`${what}: args must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new RustShimError(`${what} must be a string`);
  return value;
}

function optionalString(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : string(value, what);
}

function optionalStringRecord(value: unknown, what: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(record(value, what));
  return Object.fromEntries(entries.map(([key, entry]) => [key, string(entry, `${what}.${key}`)]));
}

// ── The segment's data ────────────────────────────────────────────────────────

/** Everything of `input` but its host, as the `segment` entry reads it
 *  (crates/movement-engine/src/run.rs `SegmentInput`): the event on the eval
 *  wire, so its payload keeps its key order. Undefined for an input that
 *  cannot cross as itself. */
function segmentInput(input: RunMovementInput): unknown {
  const event = new WireOut().value(input.event);
  if (event === REFUSED || LONE_SURROGATE.test(input.source)) return undefined;
  return plainJson(
    {
      entry: 'segment',
      source: input.source,
      // The pin the run is under, written out: the engine cannot know this
      // release's current version.
      languageVersion: input.languageVersion ?? CURRENT_LANGUAGE_VERSION,
      ...(input.movementName !== undefined ? { movementName: input.movementName } : {}),
      event,
      teamId: input.teamId,
      // The run's pinned instant, as the TypeScript interpreter pins it.
      now: (input.firedAt ?? new Date()).toISOString(),
      catalog: input.catalog,
    },
    'the segment input',
  );
}

/**
 * The segment's `done` (crates/movement-engine/src/run.rs says its shapes):
 * the run's result, the error it failed with (a body's failure wrapped in
 * `MovementRunFailed`, carrying what the run did, as the interpreter wraps
 * it), or that it declined.
 */
export function readRunResult(
  done: unknown,
  run: { trace: MovementRunResult['trace']; hostErrors: unknown[] },
): { ran: MovementRunResult } | { declined: string } {
  const outcome = record(done, 'the Rust engine result');
  if ('declined' in outcome) return { declined: string(outcome.declined, 'the Rust engine declined') };
  if ('thrown' in outcome) throw failureOf(outcome.thrown, run.hostErrors);
  if ('failed' in outcome) {
    const failed = record(outcome.failed, 'the Rust engine failure');
    throw new MovementRunFailed(failureOf(failed.error, run.hostErrors), resultOf(failed.result, run.trace));
  }
  if ('result' in outcome) return { ran: resultOf(outcome.result, run.trace) };
  throw new RustShimError(`the Rust engine finished with ${Object.keys(outcome).join(', ') || 'nothing'}, which this shim does not decode`);
}

function resultOf(value: unknown, trace: MovementRunResult['trace']): MovementRunResult {
  const result = record(value, 'the Rust engine result');
  const unread = Object.keys(result).filter((key) => key !== 'movementName' && key !== 'cancelled');
  if (unread.length > 0) {
    throw new RustShimError(`the Rust engine result has ${unread.join(', ')}, which this shim does not decode yet`);
  }
  if (result.cancelled !== undefined && result.cancelled !== true) throw new RustShimError('a cancelled result says true');
  // The run spent nothing itself; what the run had spent before rides along,
  // as the interpreter's `spendFields` reports it.
  const spend = currentRunSpend();
  return {
    movementName: string(result.movementName, 'the Rust engine result movementName'),
    writes: [],
    extractionSites: {},
    trace,
    ...(result.cancelled === true ? { cancelled: true } : {}),
    ...(spend.segmentMicrodollars > 0
      ? { spentMicrodollars: spend.segmentMicrodollars, spentBySource: spend.bySource }
      : {}),
    ...(spend.runMicrodollars > 0 ? { runSpentMicrodollars: spend.runMicrodollars } : {}),
  };
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

// ── What the Rust engine runs whole ───────────────────────────────────────────

/**
 * Whether the Rust engine runs `input`'s run whole: an explicit allow-list,
 * read off the parsed program (crates/movement-engine/src/run.rs runs what
 * it admits, and declines, before touching an adapter, what it finds it
 * cannot):
 *
 * - file scope: imports from `adapters` and `credentials`, instance
 *   constructions, `listen`s, movement declarations;
 * - every movement body: `name = <expression>` (a built-in's call among
 *   them, `n = UPPER(x)`, which reads as the expression it is), `if` /
 *   `else if` / `else` with expression conditions (no `IS`), `return
 *   <expression>`, nested arms alike;
 * - every expression one `rustCanEval` admits, where a name read is a name
 *   the bodies bind, plus `p.field` with no hops on the movement's event
 *   parameter or on such a name;
 * - a run that cannot suspend (no `limitPaused`, no `suspendWhen`), whose
 *   trace starts empty, and whose event and source cross as themselves.
 */
export function rustCanRun(
  program: Program,
  input: Pick<RunMovementInput, 'host' | 'limitPaused' | 'languageVersion'>,
): boolean {
  if (input.limitPaused === true || input.host.control.suspendWhen !== undefined) return false;
  // A trace the caller already wrote into: the TypeScript engine reads it
  // when it decides whether a `field_miss` is new, and the Rust one does not.
  if ((input.host.trace?.length ?? 0) > 0) return false;
  const fileNames = new Set<string>();
  const movements: Extract<Statement, { kind: 'movement' }>[] = [];
  for (const statement of program.statements) {
    switch (statement.kind) {
      case 'import':
        if (statement.source.kind !== 'builtin') return false;
        if (statement.source.namespace !== 'adapters' && statement.source.namespace !== 'credentials') return false;
        for (const name of statement.names) fileNames.add(name.alias ?? name.name);
        break;
      case 'assign':
        if (statement.value.kind !== 'construct') return false;
        fileNames.add(statement.name);
        break;
      case 'listen':
        break;
      case 'movement':
        fileNames.add(statement.name);
        movements.push(statement);
        break;
      default:
        return false;
    }
  }
  return movements.every((movement) => {
    const events = new Set(movement.params.map((p) => p.name));
    const values = new Set<string>();
    collectBound(movement.body, values);
    for (const name of values) if (events.has(name) || fileNames.has(name)) return false;
    const functions = movements.map((m) => m.name);
    const bound = (name: string) => events.has(name) || values.has(name) || fileNames.has(name);
    return bodyRuns(movement.body, {
      events,
      values,
      languageVersion: input.languageVersion ?? CURRENT_LANGUAGE_VERSION,
      scope: {
        binds: bound,
        functionSpelled: (name) => functions.find((f) => f.toLowerCase() === name.toLowerCase()),
      },
    });
  });
}

interface RunNames {
  /** The movement's parameters: the event. */
  events: ReadonlySet<string>;
  /** Every name the body binds to a value. */
  values: ReadonlySet<string>;
  languageVersion: LanguageVersion;
  /** What a call's callee resolves against: every name the file and the
   *  body bind (a superset of any one point's scope), the file's functions. */
  scope: Parameters<typeof resolveCallee>[1];
}

function collectBound(statements: Statement[], into: Set<string>): void {
  for (const statement of statements) {
    if (statement.kind === 'assign') into.add(statement.name);
    if (statement.kind === 'if') {
      for (const arm of statement.arms) collectBound(arm.body, into);
      if (statement.elseArm) collectBound(statement.elseArm.body, into);
    }
  }
}

function bodyRuns(statements: Statement[], names: RunNames): boolean {
  return statements.every((statement) => {
    switch (statement.kind) {
      case 'assign':
      case 'return': {
        if (statement.value.kind === 'expr') return slotRuns(statement.value.expr, names);
        const slot = statement.value.kind === 'call' ? builtinValueSlot(statement.value.call, names) : undefined;
        return slot !== undefined && slotRuns(slot, names);
      }
      case 'if':
        return (
          statement.arms.every((arm) => conditionRuns(arm.condition, names) && bodyRuns(arm.body, names))
          && (statement.elseArm === undefined || bodyRuns(statement.elseArm.body, names))
        );
      default:
        return false;
    }
  });
}

/** A bound call to a built-in, as the expression it reads as (run.ts
 *  `resolvedRValue`); undefined for any other call. */
function builtinValueSlot(call: CallStatement, names: RunNames): ExprSlot | undefined {
  const reading = readCall(call, (callee) => resolveCallee(callee, names.scope, names.languageVersion), 'value');
  return reading.kind === 'value' ? reading.expr : undefined;
}

function slotRuns(slot: ExprSlot, names: RunNames): boolean {
  try {
    return runExpressionRuns(expressionOfSlot(slot), names);
  } catch {
    return false;
  }
}

function conditionRuns(slot: ExprSlot, names: RunNames): boolean {
  let condition: MovementCondition;
  try {
    condition = conditionOfSlot(slot);
  } catch {
    return false;
  }
  const runs = (c: MovementCondition): boolean => {
    switch (c.kind) {
      case 'and':
        return c.conjuncts.every(runs);
      case 'expr':
        return runExpressionRuns(c.expr, names);
      case 'isTest':
        return false;
      default:
        return neverAsAny(c);
    }
  };
  return runs(condition);
}

/** `rustCanEval`'s nodes, a name read being a bound value, and a field read
 *  off the event or a bound value. */
function runExpressionRuns(expr: Expression, names: RunNames): boolean {
  switch (expr.type) {
    case 'alias_ref':
      return names.values.has(expr.name) && rustCanEval(expr);
    case 'property':
      return names.values.has(expr.propertyTypeId) && rustCanEval(expr);
    case 'traverse':
      return (
        expr.aliasRoot !== undefined
        && (names.events.has(expr.aliasRoot) || names.values.has(expr.aliasRoot))
        && expr.steps.length === 0
        && expr.expression.type === 'property'
        && !LONE_SURROGATE.test(expr.expression.propertyTypeId)
      );
    default:
      return rustCanEval(expr, (child) => runExpressionRuns(child, names));
  }
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
 * and every literal and name one JSON carries as itself into a Rust string.
 * `child` judges the sub-expressions (a whole run's admission widens it).
 */
export function rustCanEval(expr: Expression, child: (expr: Expression) => boolean = rustCanEval): boolean {
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
    ...(ctx.languageVersion !== undefined ? { languageVersion: ctx.languageVersion } : {}),
    // The run's pinned instant, which DATE.TODAY reads.
    now: (ctx.meta?.now ?? new Date()).toISOString(),
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

/** The error the TypeScript evaluator would have thrown. */
function thrownBy(error: Record<string, unknown>): Error {
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

const REFUSED: unique symbol = Symbol('refused');

/** A lone surrogate: JSON cannot carry it into a Rust string. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The wire to the Rust evaluator and back (crates/movement-engine/src/env.rs
 * says the format): values with their identity, and the origins of the trails
 * they carry, numbered.
 */
class WireOut {
  /** The objects and lists sent, by the id the wire gave them. */
  private readonly sent: object[] = [];
  private readonly ids = new Map<object, number>();
  private readonly open = new Set<object>();
  readonly origins: ProvenanceOrigin[] = [];
  private readonly originIds = new Map<ProvenanceOrigin, number>();

  /** `value` on the wire, or REFUSED where it would not cross as itself: a
   *  function, a Date, a class instance, a record, a lone surrogate. */
  value(value: unknown): unknown {
    const kind = typeof value;
    switch (kind) {
      case 'undefined':
        return ['u'];
      case 'boolean':
        return value;
      case 'string':
        return typeof value === 'string' && LONE_SURROGATE.test(value) ? REFUSED : value;
      case 'number':
        if (Number.isNaN(value)) return ['n', 'NaN'];
        if (value === Infinity) return ['n', 'Infinity'];
        if (value === -Infinity) return ['n', '-Infinity'];
        return Object.is(value, -0) ? ['n', '-0'] : value;
      case 'object':
        return this.composite(value);
      case 'function':
      case 'bigint':
      case 'symbol':
        return REFUSED;
      default:
        return neverAsAny(kind);
    }
  }

  private composite(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    const seen = this.ids.get(value);
    if (seen !== undefined) return this.open.has(value) ? REFUSED : ['r', seen];
    const proto: unknown = Object.getPrototypeOf(value);
    const isList = Array.isArray(value) && proto === Array.prototype;
    if (!isList && (proto !== Object.prototype || bindingOf(value) !== undefined)) return REFUSED;
    const id = this.sent.length;
    this.sent.push(value);
    this.ids.set(value, id);
    this.open.add(value);
    try {
      if (Array.isArray(value)) {
        const items: unknown[] = [];
        for (let i = 0; i < value.length; i++) {
          // A hole is not `undefined` to every array method.
          if (!(i in value)) return REFUSED;
          const item = this.value(value[i]);
          if (item === REFUSED) return REFUSED;
          items.push(item);
        }
        return ['l', id, items];
      }
      const keys = Object.keys(value);
      if (Object.getOwnPropertyNames(value).length !== keys.length || keys.includes('__proto__')) return REFUSED;
      const entries: unknown[] = [];
      for (const key of keys) {
        if (LONE_SURROGATE.test(key)) return REFUSED;
        const item = this.value(Reflect.get(value, key));
        if (item === REFUSED) return REFUSED;
        entries.push([key, item]);
      }
      return ['o', id, entries];
    } finally {
      this.open.delete(value);
    }
  }

  trail(provenance: Provenance): { origins: number[]; direct?: number } {
    return {
      origins: provenance.origins.map((o) => this.originId(o)),
      ...(provenance.direct !== undefined ? { direct: this.originId(provenance.direct) } : {}),
    };
  }

  private originId(origin: ProvenanceOrigin): number {
    let id = this.originIds.get(origin);
    if (id === undefined) {
      id = this.origins.length;
      this.origins.push(origin);
      this.originIds.set(origin, id);
    }
    return id;
  }

  /** A value back from the wire: the objects sent as themselves, the new
   *  ones built once each. */
  read(wire: unknown, made: Map<number, unknown> = new Map()): unknown {
    if (!Array.isArray(wire)) return wire;
    const [tag, a, b] = wire;
    switch (tag) {
      case 'u':
        return undefined;
      case 'n':
        return a === 'NaN' ? NaN : a === 'Infinity' ? Infinity : a === '-Infinity' ? -Infinity : -0;
      case 'i':
        if (typeof a !== 'number' || this.sent[a] === undefined) throw new RustShimError(`the wire names no sent value ${String(a)}`);
        return this.sent[a];
      case 'r':
        if (typeof a !== 'number' || !made.has(a)) throw new RustShimError(`the wire names no value ${String(a)} it made`);
        return made.get(a);
      case 'l': {
        if (typeof a !== 'number' || !Array.isArray(b)) throw new RustShimError('a wire list is ["l", id, items]');
        const list: unknown[] = [];
        made.set(a, list);
        for (const item of b) list.push(this.read(item, made));
        return list;
      }
      case 'o': {
        if (typeof a !== 'number' || !Array.isArray(b)) throw new RustShimError('a wire object is ["o", id, entries]');
        const object: Record<string, unknown> = {};
        made.set(a, object);
        for (const entry of b) {
          if (!Array.isArray(entry) || typeof entry[0] !== 'string') throw new RustShimError('a wire entry is [key, value]');
          object[entry[0]] = this.read(entry[1], made);
        }
        return object;
      }
      default:
        throw new RustShimError(`an unknown wire tag ${String(tag)}`);
    }
  }
}

