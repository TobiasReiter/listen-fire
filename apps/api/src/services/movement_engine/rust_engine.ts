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
  callEvalExpression,
  readCall,
  resolveCallee,
  conditionOfSlot,
  CURRENT_LANGUAGE_VERSION,
  expressionOfSlot,
  openEngineSegment,
  identityKeyOf,
  parseMovementExpression,
  probePathHead,
  splitUniquenessConjuncts,
  type CallStatement,
  type ExprSlot,
  type LanguageVersion,
  type MovementCondition,
  type NodeLiteral,
  type PathHead,
  type Program,
  type Statement,
  type WriteExpression,
} from 'movement-lang';

import { isPurePredicate } from '#shared/expression/filter';
import type { Expression } from '#shared/expression/types';
import { isObjectSpread, listElementExpression, objectMemberExpression } from '#shared/expression/types';
import { currentRunSpend } from '../../lib/run_spend';
import { neverAsAny } from '../../lib/utils/types';
import { MovementEngineError, type MovementEngineErrorCode } from './errors';
import type { Binding, MovementEvalResult, MovementExprContext } from './expression';
import { NO_PROVENANCE, type Provenance, type ProvenanceOrigin } from './provenance';
import { MovementRunFailed, type MovementRunResult, type ResumeMovementInput, type RunMovementInput } from './run';
import type { BindingDescriptor } from './serialize';
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

/** A segment of `input`'s run in the Rust engine: its result, or that the
 *  engine declined it (before it touched an adapter) for the TypeScript
 *  engine to run. */
export async function runSegmentInRust(
  input: RunMovementInput,
  engine?: EngineProtocol,
): Promise<{ ran: MovementRunResult } | { declined: string }> {
  return segmentInRust(input, undefined, engine);
}

/** A parked run resumed in the Rust engine (`rustCanResume` admits its
 *  state): its result, or that the engine declined it before touching an
 *  adapter. */
export async function resumeSegmentInRust(
  input: ResumeMovementInput,
  engine?: EngineProtocol,
): Promise<{ ran: MovementRunResult } | { declined: string }> {
  return segmentInRust(input, { state: input.state, ...(input.reenter === true ? { reenter: true } : {}) }, engine);
}

async function segmentInRust(
  input: RunMovementInput,
  resume: { state: unknown; reenter?: true } | undefined,
  engine?: EngineProtocol,
): Promise<{ ran: MovementRunResult } | { declined: string }> {
  // Read before the instance opens: an input that cannot cross must not
  // leave a segment open behind it.
  const start = segmentInput(input, resume);
  if (start === undefined) throw new RustShimError('this run cannot cross to the Rust engine (rustCanRun admits none such)');
  const trace = input.host.trace ?? [];
  const hostErrors: unknown[] = [];
  rustRunStats.routed += 1;
  let outcome: { ran: MovementRunResult } | { declined: string };
  try {
    const done = await driveEngine(engine ?? openWasmEngine(), start, { ...input, trace, hostErrors });
    outcome = readRunResult(done, { trace, hostErrors });
  } catch (error) {
    // The run's own failure, which the Rust engine ran to as the TypeScript
    // engine would have; a shim fault is not one.
    if (error instanceof RustShimError) rustRunStats.shimFaults += 1;
    else rustRunStats.ranWhole += 1;
    throw error;
  }
  if ('declined' in outcome) rustRunStats.declined[outcome.declined] = (rustRunStats.declined[outcome.declined] ?? 0) + 1;
  else rustRunStats.ranWhole += 1;
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
  input: Pick<RunMovementInput, 'host' | 'teamId' | 'catalog' | 'writeSink'> & {
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
    ...(input.writeSink !== undefined ? { writeSink: input.writeSink } : {}),
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


// ── The segment's data ────────────────────────────────────────────────────────

/** Everything of `input` but its host, as the `segment` entry reads it
 *  (crates/movement-engine/src/run.rs `SegmentInput`): the event, and a
 *  resumed state, on the eval wire, so their objects keep their key order
 *  (a stored state's is the order it was stored in). Undefined for an input
 *  that cannot cross as itself. */
function segmentInput(input: RunMovementInput, resume?: { state: unknown; reenter?: true }): unknown {
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
  // The run spent nothing itself; what the run had spent before rides along,
  // as the interpreter's `spendFields` reports it.
  const spend = currentRunSpend();
  return {
    movementName: string(result.movementName, 'the Rust engine result movementName'),
    writes,
    extractionSites: {},
    trace,
    ...(result.parked === true ? { parked: true, parkedAddress: string(result.parkedAddress, 'the parked address') } : {}),
    ...(result.cancelled === true ? { cancelled: true } : {}),
    ...(spend.segmentMicrodollars > 0
      ? { spentMicrodollars: spend.segmentMicrodollars, spentBySource: spend.bySource }
      : {}),
    ...(spend.runMicrodollars > 0 ? { runSpentMicrodollars: spend.runMicrodollars } : {}),
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
 * - writes (`write …` and `name = write …`): to a collection of a constructed
 *   instance, along one edge (no WHERE) off a write's handle or the event, or
 *   onto a held handle (`write co { … }`); with no `bind`; whose `unique by`
 *   clauses are keys only (no conjunct that narrows); whose fields and spreads
 *   read what an expression may;
 * - `await sleep(…)`, bare or bound;
 * - every expression one `rustCanEval` admits, where a name read is a value
 *   the bodies bind, plus `p.field` with no hops on the movement's event
 *   parameter, on such a value, or on a write's handle;
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
  const instances = new Set<string>();
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
        instances.add(statement.name);
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
    const handles = new Set<string>();
    const bodyInstances = new Set<string>();
    const nodes = new Set<string>();
    collectBound(movement.body, { values, handles, instances: bodyInstances, nodes });
    const bodyNames = [...values, ...handles, ...bodyInstances, ...nodes];
    for (const name of bodyNames) if (events.has(name) || fileNames.has(name)) return false;
    if (new Set(bodyNames).size !== bodyNames.length) return false;
    const functions = movements.map((m) => m.name);
    const bound = (name: string) =>
      events.has(name) || values.has(name) || handles.has(name) || nodes.has(name) || bodyInstances.has(name) || fileNames.has(name);
    return bodyRuns(movement.body, {
      events,
      values,
      handles,
      nodes,
      instances: new Set([...instances, ...bodyInstances]),
      movements: new Set(functions),
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
  /** Every name the body binds to a write's handle. */
  handles: ReadonlySet<string>;
  /** Every name the body binds to a node it builds (`{ … }`, `graph { … }`). */
  nodes: ReadonlySet<string>;
  /** The constructed instances, the file's and the body's. */
  instances: ReadonlySet<string>;
  /** The file's movements: a construction spelled with one is a call. */
  movements: ReadonlySet<string>;
  languageVersion: LanguageVersion;
  /** What a call's callee resolves against: every name the file and the
   *  body bind (a superset of any one point's scope), the file's functions. */
  scope: Parameters<typeof resolveCallee>[1];
}

function collectBound(
  statements: Statement[],
  into: { values: Set<string>; handles: Set<string>; instances: Set<string>; nodes: Set<string> },
): void {
  for (const statement of statements) {
    if (statement.kind === 'assign') {
      const kind = statement.value.kind;
      const set = kind === 'write' ? into.handles : kind === 'construct' ? into.instances : kind === 'node' ? into.nodes : into.values;
      set.add(statement.name);
    }
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
        if (statement.value.kind === 'write') return writeRuns(statement.value.write, names);
        if (statement.value.kind === 'await') return statement.value.await.source.kind === 'sleep';
        if (statement.value.kind === 'construct') return !names.movements.has(statement.value.construct.callee);
        if (statement.value.kind === 'node') return nodeRuns(statement.value.node, names, statement.value.node.graph !== undefined);
        return rvalueRuns(statement.value, names);
      case 'return':
        return rvalueRuns(statement.value, names);
      case 'write':
        return writeRuns(statement.write, names);
      case 'await':
        return statement.await.source.kind === 'sleep';
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

function rvalueRuns(value: Extract<Statement, { kind: 'assign' }>['value'], names: RunNames): boolean {
  if (value.kind === 'expr') return slotRuns(value.expr, names);
  const slot = value.kind === 'call' ? builtinValueSlot(value.call, names) : undefined;
  return slot !== undefined && slotRuns(slot, names);
}

/** A write the Rust engine runs (`write.rs`). */
function writeRuns(write: WriteExpression, names: RunNames): boolean {
  if (write.bind !== undefined) return false;
  const target = write.target;
  switch (target.kind) {
    case 'tuple':
      return false;
    case 'position':
      if (!names.handles.has(target.alias)) return false;
      break;
    case 'linked': {
      const root = target.path.root?.kind === 'name' ? target.path.root.name : undefined;
      if (root === undefined) return false;
      if (!names.instances.has(root) && !names.handles.has(root) && !names.events.has(root)) return false;
      if (!singleUnnarrowedEdge(target.path)) return false;
      break;
    }
    default:
      return neverAsAny(target);
  }
  if (!write.uniqueBy.every((clause) => keyOnly(clause.predicate.raw))) return false;
  const spreadsRun = (write.spreads ?? []).every(
    (spread) =>
      names.values.has(spread.source) || names.handles.has(spread.source) || names.nodes.has(spread.source) || names.events.has(spread.source),
  );
  return spreadsRun && write.fields.every((field) => slotRuns(field.value, names));
}

/** A node or graph literal the Rust engine builds (node.rs): value entries,
 *  nested literals, and in a graph a reference to a record the run holds and
 *  a spread of a value, a handle or a node; no shape, no traversal entry. */
function nodeRuns(literal: NodeLiteral, names: RunNames, graph: boolean): boolean {
  if (literal.graph?.shape !== undefined) return false;
  if (!graph && literal.spreads !== undefined) return false;
  const records = (name: string) => names.handles.has(name) || names.nodes.has(name);
  const spreadsRun = (literal.spreads ?? []).every((spread) => names.values.has(spread.source) || records(spread.source));
  return spreadsRun && literal.entries.every((entry) => {
    switch (entry.kind) {
      case 'value': {
        const bare = entry.value.raw.trim();
        if (graph && records(bare)) return true;
        if (names.events.has(bare)) return false;
        return slotRuns(entry.value, names);
      }
      case 'nodes':
        return entry.nodes.every((nested) => nodeRuns(nested, names, graph));
      case 'declared':
      case 'traversal':
        return false;
      default:
        return neverAsAny(entry);
    }
  });
}

/** One edge step, with no WHERE (`singleWriteEdge`). */
function singleUnnarrowedEdge(path: PathHead): boolean {
  try {
    const probe = parseMovementExpression(`${probePathHead(path)}.\`__movement_engine_probe__\``);
    if (probe.type !== 'traverse' || probe.steps.length !== 1) return false;
    const [step] = probe.steps;
    return step.type === 'edge' && step.expressionFilter === undefined;
  } catch {
    return false;
  }
}

/** A `unique by` clause with a key (`identityKeyOf`), whose other
 *  conjuncts read only the candidate (`isPurePredicate`). */
function keyOnly(raw: string): boolean {
  try {
    const conjuncts = splitUniquenessConjuncts(raw).flatMap((part) => andConjuncts(parseMovementExpression(part.raw)));
    const narrowing = conjuncts.filter((c) => identityKeyOf(c) === undefined);
    return conjuncts.length > narrowing.length && narrowing.every(isPurePredicate);
  } catch {
    return false;
  }
}

function andConjuncts(expr: Expression): Expression[] {
  return expr.type === 'logical' && expr.op === 'and' ? expr.operands.flatMap(andConjuncts) : [expr];
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
 *  off the event, a bound value or a write's handle. */
function runExpressionRuns(expr: Expression, names: RunNames): boolean {
  switch (expr.type) {
    case 'alias_ref':
      return names.values.has(expr.name) && rustCanEval(expr);
    case 'property':
      return names.values.has(expr.propertyTypeId) && rustCanEval(expr);
    case 'traverse':
      return (
        expr.aliasRoot !== undefined
        && (names.events.has(expr.aliasRoot)
          || names.values.has(expr.aliasRoot)
          || names.handles.has(expr.aliasRoot)
          || names.nodes.has(expr.aliasRoot))
        && expr.steps.length === 0
        && expr.expression.type === 'property'
        && !LONE_SURROGATE.test(expr.expression.propertyTypeId)
      );
    default:
      return rustCanEval(expr, (child) => runExpressionRuns(child, names));
  }
}

/**
 * Whether the Rust engine resumes this parked state: a timer park's state
 * of version 1 (no frames, no journal, no suspension, no `until`), whose
 * address steps only into `if` arms, and whose scopes hold only the binding
 * kinds the engine binds — values that hold no records, write handles, the
 * event, instances, imports and movements — with provenance it summarises.
 * The program itself must be one `rustCanRun` admits, and nothing may be
 * answered into the leaf.
 */
export function rustCanResume(
  program: Program,
  input: Pick<ResumeMovementInput, 'host' | 'limitPaused' | 'languageVersion' | 'state' | 'answer' | 'deferRaceSettlement'>,
): boolean {
  const state = input.state;
  if (input.answer !== undefined || input.deferRaceSettlement === true) return false;
  if (state.version !== 1 || state.frames !== undefined || state.journal !== undefined) return false;
  if (state.suspended !== undefined || state.until !== undefined) return false;
  if (!/^s\d+(\.b\d+\.s\d+)*$/.test(state.address)) return false;
  const plainOrigins = (provenance: Provenance | undefined): boolean =>
    provenance === undefined
    || [...provenance.origins, ...(provenance.direct !== undefined ? [provenance.direct] : [])].every(
      (origin) => origin.kind !== 'extraction',
    );
  const holds = (descriptor: BindingDescriptor): boolean => {
    switch (descriptor.kind) {
      case 'event':
      case 'instance':
      case 'opaque':
      case 'movement':
      case 'handle':
      case 'nodeRef':
        return true;
      case 'value':
        return plainOrigins(descriptor.provenance) && new WireOut().value(descriptor.value) !== REFUSED;
      case 'nodePosition':
        return (
          Object.values(descriptor.fieldProvenance).every(plainOrigins)
          && Object.values(descriptor.edges).every((edge) => edge.kind === 'landed' && edge.landing === undefined && edge.landingShape === undefined && edge.landings.every(holds))
        );
      default:
        return false;
    }
  };
  const resumable =
    state.scopeChain.every((scope) => Object.values(scope.bindings).every(holds)) && new WireOut({ asData: true }).value(state) !== REFUSED;
  return resumable && rustCanRun(program, input);
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

