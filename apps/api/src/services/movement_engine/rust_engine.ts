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

import { openEngineSegment, type Program } from 'movement-lang';

import { neverAsAny } from '../../lib/utils/types';
import type { Adapter } from '../translation_graph/adapter';
import type { EngineHost } from './host';
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
  input: Pick<RunMovementInput, 'host' | 'teamId'>,
): Promise<unknown> {
  const context: RouteContext = { host: input.host, teamId: input.teamId, instances: new Map() };
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
