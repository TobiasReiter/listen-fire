// The Rust engine's host dispatch: every request a segment makes, by family
// and method, answered from the run's `EngineHost` (and the live adapters
// behind the instance handles the segment holds). This is the one module that
// knows the host's shapes, so a change to the host boundary
// (docs/engine-host.md) is adapted here and in the Rust request builders
// (crates/movement-engine/src/host.rs) and nowhere between.

import { applyStdlib, stdlibFunctionById, type CatalogSnapshot } from 'movement-lang';

import { compareValues } from '#shared/expression/filter';
import type { FilterOperator } from '#shared/expression/types';
import type { Adapter } from '../translation_graph/adapter';
import {
  newDryRunRehearsal,
  wrapAdapterForDryRun,
  type DryRunRehearsal,
  type DryRunWriteSink,
} from '../translation_graph/engine/dry_run_adapter';
import type { UniquenessConstraints } from '../translation_graph/uniqueness';
import { applyMovementFunction } from './builtins';
import { MovementEngineError } from './errors';
import type { EngineHost } from './host';
import { checkAnswer, checkPinned } from './program_check';
import type { MovementRunResult, RunMovementInput } from './run';
import { segmentWriteLockHolder } from './run_scope';
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
  teamId: RunMovementInput['teamId'];
  /** The live adapters behind the handles the engine holds, numbered from 1. */
  instances: Map<number, Adapter>;
  catalog: CatalogSnapshot;
  trace: MovementRunResult['trace'];
  hostErrors: unknown[];
  /** Where a rehearsal's captured writes go (`RunMovementInput.writeSink`). */
  writeSink?: DryRunWriteSink;
  /** The run's one rehearsal, made when its first target is wrapped. */
  rehearsal?: DryRunRehearsal;
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
      if (request.dryRun !== undefined && request.dryRun !== true) throw new RustShimError('adapters.resolve dryRun is true or absent');
      const live = await context.host.adapters.resolve({
        adapterType: string(request.adapterType, 'adapters.resolve adapterType'),
        teamId: context.teamId,
        credentialsId,
        ...(constructionArgs !== undefined ? { constructionArgs } : {}),
        role,
      });
      // A rehearsed target: the run's one dry-run capture wraps it, as the
      // interpreter's `resolveTargetAdapter` wraps it.
      const adapter = request.dryRun === true
        ? wrapAdapterForDryRun(live, (context.rehearsal ??= newDryRunRehearsal(context.writeSink)))
        : live;
      const instance = context.instances.size + 1;
      context.instances.set(instance, adapter);
      return { instance, adapterType: adapter.adapterType };
    },
    /** Whether the adapter implements an optional member (`readRecord`). */
    async has(args, context) {
      const request = record(args, 'adapters.has');
      const method = string(request.method, 'adapters.has method');
      return typeof Reflect.get(adapterOf(request.instance, method, context), method) === 'function';
    },
    async credentialId(args, context) {
      const request = record(args, 'adapters.credentialId');
      return context.host.adapters.credentialId(string(request.credentialName, 'adapters.credentialId credentialName'));
    },
    async call(args, context) {
      const request = record(args, 'adapters.call');
      const method = string(request.method, 'adapters.call method');
      const adapter = adapterOf(request.instance, method, context);
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
  llm: {
    /** The identity judge over a write's candidates. What the host's
     *  `onJudgeUnavailable` heard rides back beside the index. */
    async arbitrateEntities(args, context) {
      const request = record(args, 'llm.arbitrateEntities');
      const asserted = wiredRecord(request.asserted, 'llm.arbitrateEntities asserted');
      const candidates = new WireOut().read(request.candidates);
      if (!Array.isArray(candidates)) throw new RustShimError('llm.arbitrateEntities candidates is a list');
      const constraints = new WireOut().read(request.constraints);
      if (!isUniquenessConstraints(constraints)) throw new RustShimError('llm.arbitrateEntities constraints are {any: [{all}]}');
      let judgeUnavailable: string | undefined;
      const index = await context.host.llm.arbitrateEntities({
        asserted,
        candidates,
        recordType: string(request.recordType, 'llm.arbitrateEntities recordType'),
        constraints,
        onJudgeUnavailable: (message) => {
          judgeUnavailable = message;
        },
      });
      return { index, ...(judgeUnavailable !== undefined ? { judgeUnavailable } : {}) };
    },
  },
  locks: {
    /** The segment's cross-run write locks, by name (the segment's holder,
     *  `segmentWriteLockHolder`, as the effect locks take them). */
    async acquire(args) {
      await segmentWriteLockHolder().acquire(lockNames(args, 'locks.acquire'));
      return undefined;
    },
    async release(args) {
      await segmentWriteLockHolder().release(lockNames(args, 'locks.release'));
      return undefined;
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

/** The live adapter behind an instance handle. */
function adapterOf(instance: unknown, method: string, context: RouteContext): Adapter {
  const adapter = typeof instance === 'number' ? context.instances.get(instance) : undefined;
  if (adapter === undefined) throw new RustShimError(`adapters.call ${method}: no adapter instance ${String(instance)}`);
  return adapter;
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

function lockNames(args: unknown, what: string): string[] {
  const names = record(args, what).names;
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
    throw new RustShimError(`${what} names are a list of texts`);
  }
  return names;
}

export async function serve(request: HostRequest, context: RouteContext): Promise<HostAnswer> {
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

