// The TypeScript side of the Rust engine (crates/movement-engine). A segment
// runs inside its own WASM instance; whatever it needs from the world it asks
// for as `{id, family, method, args}` requests, and this shim serves each one
// from the run's `EngineHost`, several at once when the engine issues several,
// answering each by id as it settles. The live objects the host deals in stay
// here: an adapter the engine resolves becomes a numeric instance handle, and
// the engine calls its methods by that handle.
//
// Which engine runs a program is decided by `MOVEMENT_ENGINE` (`engineChoice`)
// and by `rustCanRun`, the allow-list of what the Rust engine can already run.
// It allows nothing yet; it grows one slice at a time, each proven by the
// engine conformance corpora running unchanged against both engines.
//
// Below a whole program, one expression can already run in Rust: `evalInRust`
// is the TypeScript evaluator's switch (expression.ts `evalMovementExpr`) for
// an expression `rustCanEval` admits whose every name is a value binding.

import { applyStdlib, callEvalExpression, openEngineSegment, stdlibFunctionById, type Program } from 'movement-lang';

import type { Expression } from '#shared/expression/types';
import { isObjectSpread, listElementExpression, objectMemberExpression } from '#shared/expression/types';
import { neverAsAny } from '../../lib/utils/types';
import type { Adapter } from '../translation_graph/adapter';
import { MovementEngineError, type MovementEngineErrorCode } from './errors';
import { bindingOf, type Binding, type MovementEvalResult, type MovementExprContext } from './expression';
import type { EngineHost } from './host';
import { NO_PROVENANCE, type Provenance, type ProvenanceOrigin } from './provenance';
import type { MovementRunResult, RunMovementInput } from './run';

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
export type HostAnswer = { value: unknown } | Record<string, never> | { error: { message: string; name?: string } };

/** The engine's side of the conversation. `openWasmEngine` is the real one;
 *  a test drives the shim with a double. */
export interface EngineProtocol {
  start(input: unknown): EngineStep;
  answer(id: number, answer: HostAnswer): EngineStep;
  /** Ends the segment, dropping everything it held. */
  finish(): void;
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

/** Whether the Rust engine can run `program`. Nothing yet: each slice adds
 *  the constructs its conformance cases prove. */
export function rustCanRun(_program: Program): boolean {
  return false;
}

/** A segment of `input`'s run, in the Rust engine. */
export async function runSegmentInRust(
  input: RunMovementInput,
  engine?: EngineProtocol,
): Promise<MovementRunResult> {
  // Read before the instance opens: an input that cannot cross must not
  // leave a segment open behind it.
  const start = segmentInput(input);
  const done = await driveEngine(engine ?? openWasmEngine(), start, input);
  return readRunResult(done);
}

/**
 * Runs one segment to its result: starts it, serves every request it issues
 * from `input.host` concurrently, answers each as it settles, and finishes
 * the segment however the run ends.
 */
export async function driveEngine(
  engine: EngineProtocol,
  start: unknown,
  input: Pick<RunMovementInput, 'host' | 'teamId' | 'firedAt'>,
): Promise<unknown> {
  const context: RouteContext = {
    host: input.host,
    teamId: input.teamId,
    instances: new Map(),
    now: input.firedAt ?? new Date(),
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
  /** The run's pinned instant (`firedAt`, else when the segment began). */
  now: Date;
}

type Route = (args: unknown, context: RouteContext) => Promise<unknown>;

/**
 * Every host call the engine can make, by family and method. The request
 * shapes are the engine's (crates/movement-engine/src/host.rs, one builder
 * each); a route reads its args at this boundary and answers plain data.
 */
const ROUTES: Record<string, Record<string, Route> | undefined> = {
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
      return { instance };
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
      return Reflect.apply(fn, adapter, request.args);
    },
  },
  clock: {
    /** The pinned instant, and `DATE.TODAY(zone)` from it: the zone database
     *  is the host's, not the artifact's. A zone that is not one is the
     *  member's own error, answered as an error. */
    async now(args, context) {
      const zone = string(record(args, 'clock.now').zone, 'clock.now zone');
      const spec = stdlibFunctionById(DATE_TODAY);
      if (spec === undefined) throw new RustShimError('the standard library has no DATE.TODAY');
      return { nowIso: context.now.toISOString(), zone, today: applyStdlib(spec, [zone], context.now) };
    },
  },
};

async function serve(request: HostRequest, context: RouteContext): Promise<HostAnswer> {
  const route = ROUTES[request.family]?.[request.method];
  const label = `${request.family}.${request.method}`;
  if (route === undefined) throw new RustShimError(`the shim has no route for ${label}`);
  let value: unknown;
  try {
    value = await route(request.args, context);
  } catch (error) {
    if (error instanceof RustShimError) throw error;
    // The host's own failure: the engine decides what it means for the run.
    return { error: errorAnswer(error) };
  }
  const named = adapterCallName(request) ?? label;
  return value === undefined ? {} : { value: plainJson(value, named) };
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

/** Everything of `input` but its host, as the `segment` entry will read it. */
function segmentInput(input: RunMovementInput): unknown {
  return plainJson(
    {
      entry: 'segment',
      source: input.source,
      ...(input.languageVersion !== undefined ? { languageVersion: input.languageVersion } : {}),
      ...(input.movementName !== undefined ? { movementName: input.movementName } : {}),
      event: input.event,
      teamId: input.teamId,
      ...(input.firedAt !== undefined ? { firedAt: input.firedAt.toISOString() } : {}),
      ...(input.priorSpentMicrodollars !== undefined ? { priorSpentMicrodollars: input.priorSpentMicrodollars } : {}),
      ...(input.capBaselineMicrodollars !== undefined ? { capBaselineMicrodollars: input.capBaselineMicrodollars } : {}),
      ...(input.limitPaused !== undefined ? { limitPaused: input.limitPaused } : {}),
      catalog: input.catalog,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    },
    'the segment input',
  );
}

/**
 * The segment's `done` as a `MovementRunResult`. Only what a slice the
 * allow-list admits can produce is read; anything more (writes, trace
 * entries, parks) is refused until the slice that produces it decodes it.
 */
export function readRunResult(done: unknown): MovementRunResult {
  const result = record(done, 'the Rust engine result');
  const movementName = string(result.movementName, 'the Rust engine result movementName');
  for (const field of ['writes', 'trace'] as const) {
    const value = result[field];
    if (!Array.isArray(value) || value.length > 0) {
      throw new RustShimError(`the Rust engine result has ${field} this shim does not decode yet`);
    }
  }
  const sites = record(result.extractionSites ?? {}, 'the Rust engine result extractionSites');
  if (Object.keys(sites).length > 0) {
    throw new RustShimError('the Rust engine result has extraction sites this shim does not decode yet');
  }
  const unread = Object.keys(result).filter((key) => !['movementName', 'writes', 'trace', 'extractionSites'].includes(key));
  if (unread.length > 0) {
    throw new RustShimError(`the Rust engine result has ${unread.join(', ')}, which this shim does not decode yet`);
  }
  return { movementName, writes: [], extractionSites: {}, trace: [] };
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
 *  (crates/movement-engine/src/stdlib.rs). `DATETIME.AT` is not one: it
 *  needs the zone database, which the artifact does not carry. */
const RUST_FUNCTIONS: ReadonlySet<string> = new Set([
  'isnull', 'coalesce', 'trim', 'lower', 'upper', 'length', 'abs', 'round', 'floor', 'ceil', 'tostring', 'tonumber',
  'multi', 'split', 'date', 'datetime', 'number',
  'currency.get_number_from_figure', 'currency.get_code_from_figure', 'currency.format_figure',
  'date.parse', 'date.add_days', 'date.format', 'date.format_iso', 'date.today',
  'text.regex_extract', 'text.slug', 'text.pairs', 'text.serialise', 'url.host', 'number.format',
]);

const DATE_TODAY = 'date.today';

/**
 * Whether the Rust evaluator runs `expr`: every node a kind it evaluates (no
 * host reads, no model, no traversal), every function one of its built-ins,
 * `DATE.TODAY`'s zone written down (its answer is worked out here, from the
 * run's pinned instant), and every literal and name one JSON carries as
 * itself into a Rust string.
 */
export function rustCanEval(expr: Expression): boolean {
  switch (expr.type) {
    case 'static':
      if (typeof expr.value === 'string') return !LONE_SURROGATE.test(expr.value);
      return typeof expr.value !== 'number' || (Number.isFinite(expr.value) && !Object.is(expr.value, -0));
    case 'alias_ref':
      return !LONE_SURROGATE.test(expr.name);
    case 'property':
      return !LONE_SURROGATE.test(expr.propertyTypeId);
    case 'at':
      return rustCanEval(expr.expression) && rustCanEval(expr.index);
    case 'list':
      return expr.elements.every((element) => rustCanEval(listElementExpression(element)));
    case 'object':
      return expr.entries.every(
        (member) =>
          (isObjectSpread(member) || (member.key !== '__proto__' && !LONE_SURROGATE.test(member.key)))
          && rustCanEval(objectMemberExpression(member)),
      );
    case 'concat':
      return expr.parts.every(rustCanEval);
    case 'conditional':
      return rustCanEval(expr.condition) && rustCanEval(expr.then) && rustCanEval(expr.else);
    case 'compare':
      return expr.op !== 'within' && rustCanEval(expr.left) && rustCanEval(expr.right);
    case 'logical':
      return expr.operands.every(rustCanEval);
    case 'not':
    case 'negate':
      return rustCanEval(expr.expression);
    case 'arithmetic':
      return rustCanEval(expr.left) && rustCanEval(expr.right);
    case 'function':
      return (
        RUST_FUNCTIONS.has(expr.fn)
        && (expr.fn !== DATE_TODAY || expr.args[0]?.type === 'static')
        && expr.args.every(rustCanEval)
      );
    default:
      return false;
  }
}

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
  const today = todayAnswers(expr, ctx.meta?.now ?? new Date());
  if (today === undefined) return notAdmitted();
  rustEvalStats.admitted += 1;
  const envelope = {
    bindings,
    origins: wire.origins.length,
    ...(ctx.languageVersion !== undefined ? { languageVersion: ctx.languageVersion } : {}),
    ...(Object.keys(today).length > 0 ? { clock: { today } } : {}),
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

/** `DATE.TODAY(zone)` for each zone `expr` writes down, worked out by the
 *  TypeScript member from the run's pinned instant: the date, or the message
 *  it throws. Undefined where it throws something other than an Error. */
function todayAnswers(
  expr: Expression,
  now: Date,
): Record<string, { value: unknown } | { error: string }> | undefined {
  const spec = stdlibFunctionById(DATE_TODAY);
  const answers: Record<string, { value: unknown } | { error: string }> = {};
  const visit = (e: Expression): boolean => {
    if (e.type === 'function' && e.fn === DATE_TODAY) {
      const zone = e.args[0];
      if (spec !== undefined && zone?.type === 'static' && zone.value !== null) {
        try {
          answers[String(zone.value)] = { value: applyStdlib(spec, [zone.value], now) };
        } catch (error) {
          if (!(error instanceof Error) || error.constructor !== Error) return false;
          answers[String(zone.value)] = { error: error.message };
        }
      }
    }
    return childExpressions(e).every(visit);
  };
  return visit(expr) ? answers : undefined;
}

function childExpressions(expr: Expression): Expression[] {
  switch (expr.type) {
    case 'at':
      return [expr.expression, expr.index];
    case 'list':
      return expr.elements.map(listElementExpression);
    case 'object':
      return expr.entries.map(objectMemberExpression);
    case 'concat':
      return expr.parts;
    case 'conditional':
      return [expr.condition, expr.then, expr.else];
    case 'compare':
    case 'arithmetic':
      return [expr.left, expr.right];
    case 'logical':
      return expr.operands;
    case 'not':
    case 'negate':
      return [expr.expression];
    case 'function':
      return expr.args;
    default:
      return [];
  }
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

/** The codes the Rust evaluator throws with. */
function engineErrorCode(code: unknown): MovementEngineErrorCode {
  switch (code) {
    case 'MOVENG_RUNTIME':
    case 'MOVENG_UNSUPPORTED':
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

