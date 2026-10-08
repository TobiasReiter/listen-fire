// The Rust engine's host dispatch: every request a segment makes, by family
// and method, answered from the run's `EngineHost`. This is the one module that
// knows the host's shapes, so a change to the host boundary
// (docs/contracts/host-families.md) is adapted here and in the Rust request builders
// (crates/movement-engine/src/host.rs) and nowhere between.
//
// A request whose family and method are an `EngineHost` method's
// (`HOST_FAMILIES`) is that method's request, in the contract's shape, and is
// forwarded as it is: the engine names the segment the run host opened. Two
// families are the engine's own and never reach an `EngineHost`
// (`ENGINE_OWN_ROUTES`): `check`, the TypeScript checker until the checker is
// Rust, and `builtins`, the TypeScript standard library for the readings the
// Rust engine hands back.
//
// One encoding is this shim's own: a request marked `wire: true` carries its
// values on the eval wire (rust_wire.ts), not as plain JSON, so the host is
// handed exactly the JavaScript values (key order, `undefined`) the TypeScript
// engine hands it in process, and an adapter's result comes back the same way.

import { applyStdlib, stdlibFunctionById, type CatalogSnapshot, type Program } from 'movement-lang';

import { compareValues } from '#shared/expression/filter';
import type { FilterOperator } from '#shared/expression/types';
import type { UniquenessConstraints } from '../translation_graph/uniqueness';
import { applyMovementFunction } from './builtins';
import { MovementEngineError } from './errors';
import { ADAPTER_METHODS, type AdapterCall, type AdapterMethod, type EngineHost } from './host';
import { hostCallFailure } from './host_adapter';
import { checkAnswer, checkPinned } from './program_check';
import type { MovementRunResult } from './run';
import { publishTrace, type RunContext } from './run_context';
import type { HostAnswer, HostRequest } from './rust_engine';
import { rustRunStats } from './rust_stats';
import {
  REFUSED,
  RunAborted,
  RustShimError,
  WireOut,
  optionalString,
  optionalStringRecord,
  plainJson,
  record,
  string,
} from './rust_wire';

// ── Routes ────────────────────────────────────────────────────────────────────

export interface RouteContext {
  host: EngineHost;
  /** The segment the run host opened, with the run's trace and account. */
  context: RunContext;
  catalog: CatalogSnapshot;
  hostErrors: unknown[];
  /** The program the run host parsed, for `check.program` to check as it
   *  is. Checked at most once: the checker stamps the tree it checks. */
  parsed?: { source: string; languageVersion: number; program: Program };
}

type Route = (args: Record<string, unknown>, context: RouteContext) => Promise<unknown>;

/** The routes that are the Rust engine's own, not `EngineHost` methods, and
 *  why each is not on the host boundary. */
export const ENGINE_OWN_ROUTES: Readonly<Record<string, string>> = {
  'check.program': 'the TypeScript checker, which the Rust engine asks for until the checker is Rust',
  'builtins.function': 'a TypeScript standard-library member, for a reading the Rust engine hands back',
  'builtins.compare': "the shared comparator, for a reading the Rust engine hands back",
};

/**
 * Every host call the engine can make, by its path (`park.sink.commitTimerPark`).
 * The request shapes are the engine's (crates/movement-engine/src/host.rs, one
 * builder each); a route reads its args at this boundary and answers plain
 * data.
 */
const ROUTES: Record<string, Route> = {
  /** The TypeScript checker over the pinned source (program_check.ts):
   *  every diagnostic, the import link and the checker's AST stamps as
   *  data. A program that fails its check ends the run with the check's
   *  error, exactly as parseAndCheck throws it. */
  async 'check.program'(request, context) {
    const languageVersion = request.languageVersion;
    if (typeof languageVersion !== 'number') throw new RustShimError('check.program languageVersion must be a number');
    const upgradingFrom = request.upgradingFrom;
    if (upgradingFrom !== undefined && typeof upgradingFrom !== 'number') {
      throw new RustShimError('check.program upgradingFrom must be a number');
    }
    const source = string(request.source, 'check.program source');
    // The run host's own parse of this very source, when it has one: used
    // once, then forgotten, since checking stamps it.
    const reuse = context.parsed;
    const parsed =
      reuse !== undefined && reuse.source === source && reuse.languageVersion === languageVersion && upgradingFrom === undefined
        ? reuse.program
        : undefined;
    if (parsed !== undefined) context.parsed = undefined;
    let checked;
    try {
      checked = checkPinned(
        {
          source,
          catalog: context.catalog,
          languageVersion,
          ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
        },
        parsed,
      );
    } catch (error) {
      throw new RunAborted(error);
    }
    return checkAnswer(checked);
  },
  async 'adapters.resolve'(request, { host }) {
    const role = request.role;
    if (role !== 'source' && role !== 'target') {
      throw new RustShimError(`adapters.resolve role must be "source" or "target", not ${JSON.stringify(role)}`);
    }
    const credentialsId = optionalString(request.credentialsId, 'adapters.resolve credentialsId');
    const constructionArgs = optionalStringRecord(request.constructionArgs, 'adapters.resolve constructionArgs');
    if (request.dryRun !== undefined && request.dryRun !== true) throw new RustShimError('adapters.resolve dryRun is true or absent');
    return host.adapters.resolve({
      segmentId: segmentOf(request),
      adapterType: string(request.adapterType, 'adapters.resolve adapterType'),
      ...(credentialsId !== undefined ? { credentialsId } : {}),
      ...(constructionArgs !== undefined ? { constructionArgs } : {}),
      role,
      ...(request.dryRun === true ? { dryRun: true } : {}),
    });
  },
  /** `{result}` or `{error}`, as data. A host error is held here as the very
   *  error the TypeScript's stand-in raises for it (host_adapter.ts), under
   *  the `ref` its answer carries, so a run that fails with it fails with an
   *  equal error. */
  async 'adapters.call'(request, { host, hostErrors }) {
    const method = adapterMethod(request.method);
    if (request.wire !== true) throw new RustShimError('adapters.call carries its args on the eval wire');
    const args = new WireOut().read(request.args);
    if (!isCallArgs(args)) throw new RustShimError(`adapters.call ${method}: args are one object`);
    const answer = await host.adapters.call({
      segmentId: segmentOf(request),
      instance: string(request.instance, 'adapters.call instance'),
      method,
      args,
    });
    if ('error' in answer) {
      hostErrors.push(hostCallFailure(answer.error));
      return new Plain(plainJson({ error: { ...answer.error, ref: hostErrors.length - 1 } }, `adapters.call ${method} error`));
    }
    const result = new WireOut().value(answer.result);
    if (result === REFUSED) throw new RustShimError(`adapters.call ${method} returned a value the eval wire cannot carry as itself`);
    return new Plain({ result });
  },
  /** The identity judge over a write's candidates, a priced call: the
   *  engine's budget goes in, the answer (its cost, or a budget refusal)
   *  comes back as data for the engine's ledger. */
  async 'llm.arbitrateEntities'(request, { host, context }) {
    const asserted = wiredRecord(request.asserted, 'llm.arbitrateEntities asserted');
    const candidates = new WireOut().read(request.candidates);
    if (!Array.isArray(candidates)) throw new RustShimError('llm.arbitrateEntities candidates is a list');
    const constraints = new WireOut().read(request.constraints);
    if (!isUniquenessConstraints(constraints)) throw new RustShimError('llm.arbitrateEntities constraints are {any: [{all}]}');
    const languageVersion = request.languageVersion;
    if (typeof languageVersion !== 'number') throw new RustShimError('llm.arbitrateEntities languageVersion is a number');
    const answer = await host.llm.arbitrateEntities({
      segmentId: segmentOf(request),
      asserted,
      candidates,
      recordType: string(request.recordType, 'llm.arbitrateEntities recordType'),
      constraints,
      languageVersion,
      budget: budgetOf(request.budget),
    });
    // Charged to the run's account as the answer passes, so what the host
    // spent reaches the run even if the segment then faults; the engine's own
    // ledger charges it too, for its budget, and `done` reports it back
    // (rust_engine.ts `readRunResult` holds the two equal).
    context.ledger.charge(answer.cost);
    if ('error' in answer) return answer;
    // `candidates[index]` finds nothing for anything but an integer (NaN,
    // a fraction, `undefined`), exactly as for null: the write creates.
    const { index, ...rest } = answer;
    return { ...rest, index: typeof index === 'number' && Number.isInteger(index) ? index : null };
  },
  /** The segment's cross-run write locks: a token per acquire. */
  async 'locks.acquire'(request, { host }) {
    return host.locks.acquire({ segmentId: segmentOf(request), names: lockNames(request) });
  },
  async 'locks.release'(request, { host }) {
    await host.locks.release({ segmentId: segmentOf(request), token: string(request.token, 'locks.release token') });
    return undefined;
  },
  /** A timer park. A run with no park sink is told so, and fails as the
   *  interpreter fails it. */
  async 'park.sink.commitTimerPark'(request, { host, context }) {
    const sink = host.park.sink;
    if (sink === undefined) return { noSink: true };
    if (request.wire !== true) throw new RustShimError('park.sink.commitTimerPark carries its state on the eval wire');
    // Bridge — delete with the Rust engine merge (5B). The engine computed
    // the wake from its environment clock, held at the segment's pinned
    // instant (rust_engine.ts): re-based on the host's clock, as the
    // TypeScript engine computes it.
    const sleptMs = new Date(instant(request.wakeAt, 'park.sink.commitTimerPark wakeAt')).getTime() - context.pinnedNow.getTime();
    const wakeAt = new Date((await context.clock.now()).getTime() + sleptMs).toISOString();
    await sink.commitTimerPark({
      segmentId: segmentOf(request),
      address: string(request.address, 'park.sink.commitTimerPark address'),
      // On the eval wire: the state's objects in the order the engine wrote them.
      state: new WireOut().read(request.state),
      wakeAt,
    });
    return undefined;
  },
  /** The cancel gate at a statement boundary. */
  async 'control.cancel.cancelled'(request, { host }) {
    return host.control.cancel.cancelled({ segmentId: segmentOf(request) });
  },
  /** The run's last, undebounced, cancel check. */
  async 'control.cancel.cancelledNow'(request, { host }) {
    return host.control.cancel.cancelledNow({ segmentId: segmentOf(request) });
  },
  /** Entries on the run's trace, as they land: the segment's own trace (the
   *  result's), handed on to the host's. */
  async 'trace.append'(request, { host, context }) {
    segmentOf(request);
    const entries = request.entries;
    if (!Array.isArray(entries)) throw new RustShimError('trace.append entries are a list');
    context.trace.entries.push(...entries.map(traceEntry));
    await publishTrace(context, host);
    return undefined;
  },
  /** A built-in the Rust engine hands back for these arguments, answered by
   *  the TypeScript member: its value, or what it throws. */
  async 'builtins.function'(request) {
    const id = string(request.id, 'builtins.function id');
    if (!Array.isArray(request.args)) throw new RustShimError('builtins.function args must be an array');
    const values = request.args.map((arg) => new WireOut().read(arg));
    const now = new Date(string(request.now, 'builtins.function now'));
    const spec = stdlibFunctionById(id);
    return builtinAnswer(() => (spec !== undefined ? applyStdlib(spec, values, now) : applyMovementFunction(id, values)));
  },
  /** The shared comparator, likewise. */
  async 'builtins.compare'(request, { context }) {
    const op = filterOperator(request.op);
    const left = new WireOut().read(request.left);
    const right = new WireOut().read(request.right);
    // `WITHIN` measures from the host's clock, as the TypeScript engine's does.
    const now = op === 'within' ? (await context.clock.now()).getTime() : undefined;
    return builtinAnswer(() => compareValues(left, op, right, now !== undefined ? { now } : {}));
  },
};

/** Every route's path: each an `EngineHost` method or one of
 *  `ENGINE_OWN_ROUTES`, which the seam guard holds. */
export function shimRoutePaths(): string[] {
  return Object.keys(ROUTES);
}

/** The segment a forwarded request names (`serve` has held it to the one
 *  the run host opened). */
function segmentOf(request: Record<string, unknown>): string {
  return string(request.segmentId, 'a host request segmentId');
}

/** An adapter call's one argument object. The engine builds each method's
 *  (crates/movement-engine/src/write.rs, run.rs) as the TypeScript engine
 *  does; what the shim can hold it to here is that it is one object, and the
 *  host's adapter reads it as its protocol `params`. */
function isCallArgs(value: unknown): value is AdapterCall['args'] {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function adapterMethod(value: unknown): AdapterMethod {
  const method = ADAPTER_METHODS.find((m) => m === value);
  if (method === undefined) throw new RustShimError(`adapters.call method ${JSON.stringify(value)} is not an adapter method`);
  return method;
}

function budgetOf(value: unknown): { remainingMicrodollars: number | null } {
  const remaining = record(value, 'a priced call budget').remainingMicrodollars;
  if (remaining !== null && (typeof remaining !== 'number' || !Number.isFinite(remaining))) {
    throw new RustShimError('a budget is {remainingMicrodollars: number | null}');
  }
  return { remainingMicrodollars: remaining };
}

function instant(value: unknown, what: string): string {
  const text = string(value, what);
  if (Number.isNaN(new Date(text).getTime())) throw new RustShimError(`${what} is not an ISO 8601 instant`);
  return text;
}

function wiredRecord(value: unknown, what: string): Record<string, unknown> {
  const read = new WireOut().read(value);
  if (typeof read !== 'object' || read === null || Array.isArray(read)) throw new RustShimError(`${what} is an object`);
  return Object.fromEntries(Object.entries(read));
}

function isUniquenessConstraints(value: unknown): value is UniquenessConstraints {
  if (typeof value !== 'object' || value === null) return false;
  const any: unknown = Reflect.get(value, 'any');
  return Array.isArray(any) && any.every((branch) => typeof branch === 'object' && branch !== null && Array.isArray(Reflect.get(branch, 'all')));
}

function lockNames(request: Record<string, unknown>): string[] {
  const names = request.names;
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
    throw new RustShimError('locks.acquire names are a list of texts');
  }
  return names;
}

export async function serve(request: HostRequest, context: RouteContext): Promise<HostAnswer> {
  const label = `${request.family}.${request.method}`;
  const route = Object.hasOwn(ROUTES, label) ? ROUTES[label] : undefined;
  if (route === undefined) throw new RustShimError(`the shim has no route for ${label}`);
  rustRunStats.hostCalls[label] = (rustRunStats.hostCalls[label] ?? 0) + 1;
  const args = record(request.args, label);
  // Every request bound for the host names the segment the run host opened
  // for this engine: it has no other.
  if (!Object.hasOwn(ENGINE_OWN_ROUTES, label) && args.segmentId !== context.context.segmentId) {
    throw new RustShimError(`${label} named segment ${String(args.segmentId)}, not this engine's ${context.context.segmentId}`);
  }
  let value: unknown;
  try {
    value = await route(args, context);
  } catch (error) {
    if (error instanceof RustShimError) throw error;
    if (error instanceof RunAborted) throw error.abortedWith;
    // The host's own failure: the engine decides what it means for the run.
    // The error itself stays here, under the `ref` its answer carries, so a
    // run that fails with it fails with this very object.
    context.hostErrors.push(error);
    return { error: { ...errorAnswer(error), ref: context.hostErrors.length - 1 } };
  }
  if (value instanceof Plain) return { value: value.json };
  return value === undefined ? {} : { value: plainJson(value, adapterCallName(request) ?? label) };
}

/** A route's answer that is already the JSON to send (an eval-wire value
 *  inside it). */
class Plain {
  constructor(readonly json: unknown) {}
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

