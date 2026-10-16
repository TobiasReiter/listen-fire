// Loads a movement artifact (built by scripts/build-movement-wasm.sh) and
// calls its hand-written C ABI: UTF-8 bytes in, UTF-8 JSON bytes out, every
// buffer freed by the side that did not allocate it. There are two artifacts,
// and this one loader serves both:
//
//  - movement.wasm (crates/movement-engine, which links in crates/movement-
//    parser): the parser and the engine. Node instantiates it synchronously
//    when this module loads; the API runs movements on it.
//  - movement_parser.wasm (crates/movement-parser alone): the parser, the
//    lowering and the catalog. A browser loads it with `await initParser(url)`
//    (browsers refuse large synchronous compiles on the main thread), and so
//    never downloads the engine; `eval_expression` and the engine segments
//    are then absent, and refused by name.
//
// One compiled module serves two kinds of instance: the parser's, long-lived
// and replaced only after a trap, and one per engine segment
// (`openEngineSegment`), which lives exactly as long as its segment.
//
// Every instance imports `movement_env.call`: the environment services the
// engine asks JavaScript for mid-evaluation (env_services.ts).

// Declared here rather than taken from a lib: this package compiles without
// the DOM and Node libs, while apps/api and apps/web compile it with them.
// Module-scoped declarations shadow those globals instead of clashing.
declare const WebAssembly: {
  Module: new (bytes: Uint8Array) => WasmModule;
  Instance: new (module: WasmModule, imports: object) => { exports: Record<string, unknown> };
  compile(bytes: Uint8Array): Promise<WasmModule>;
};
declare const TextEncoder: new () => { encode(text: string): Uint8Array };
declare const TextDecoder: new (label: 'utf-8', options: { fatal: boolean }) => {
  decode(bytes: Uint8Array): string;
};
declare const fetch: (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
declare const process: { versions?: { node?: string }; getBuiltinModule?(id: string): unknown } | undefined;
declare const window: unknown;
declare const __dirname: string;

import { answerEnvRequest } from './env_services';

interface WasmModule {
  readonly __wasmModule?: never;
}

type ParserFunction = 'parse_program' | 'parse_program_eager' | 'parse_expression' | 'parse_nested_call';

/** The lowering's exports take two inputs: the tree's JSON, and its source. */
type LoweringFunction = 'lower_expression' | 'lower_condition';

/** The catalog's export takes two inputs: the snapshot's JSON, and the query's. */
type CatalogFunction = 'catalog_query';

type WasmFunction = ParserFunction | LoweringFunction | CatalogFunction;

interface ParserExports extends BufferExports {
  call(fn: WasmFunction, args: number[]): number;
  /** Absent from a module built without the engine (the loader test's). */
  evalExpression: ((...args: number[]) => number) | undefined;
  /** The Rust checker's export: absent from a module built without the
   *  engine (the browser's parser artifact). */
  checkProgram: ((...args: number[]) => number) | undefined;
}

interface Loaded {
  module: WasmModule;
  // Absent after a trap: the next call instantiates afresh from `module`.
  exports: ParserExports | undefined;
}

const WASM_FILE = 'movement.wasm';
const OK = 0;
const ERROR = 1;

let loaded: Loaded | undefined;
let loadFailure: unknown;
let generation = 0;

/**
 * Thrown by a parse that runs before the parser has loaded: in a browser,
 * until `await initParser(…)` resolves; in Node, when the artifact could not
 * be read as this module loaded (the `cause`).
 */
export class MovementParserNotReady extends Error {
  constructor(loadFailure?: unknown) {
    super(
      loadFailure === undefined
        ? 'the movement parser is not ready: await initParser() before parsing'
        : `the movement parser did not load: ${loadFailure instanceof Error ? loadFailure.message : String(loadFailure)}`,
      loadFailure === undefined ? undefined : { cause: loadFailure },
    );
    this.name = 'MovementParserNotReady';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export async function initParser(bytesOrUrl?: Uint8Array | string): Promise<void> {
  if (bytesOrUrl === undefined) {
    if (loaded) return;
    if (!isNode()) {
      throw new Error(`initParser() needs the parser's .wasm bytes or URL outside Node (${WASM_FILE})`);
    }
    loadFromDisk();
    return;
  }
  const bytes = typeof bytesOrUrl === 'string' ? await fetchBytes(bytesOrUrl) : bytesOrUrl;
  install(await WebAssembly.compile(bytes));
}

export function isParserReady(): boolean {
  return loaded !== undefined;
}

/** For a Node process's boot: throws `MovementParserNotReady`, saying why
 *  the load failed, unless the parser loaded with this module. */
export function assertParserReady(): void {
  if (!loaded) throw new MovementParserNotReady(loadFailure);
}

/**
 * Calls one parse export with `input` as its (pointer, length) pair, then
 * `extra` as its remaining scalar arguments, and returns the parsed JSON it
 * emits: the tree, or `{error: …}`.
 *
 * @internal Used by the parser wrappers; not part of the package surface.
 */
export function callJson(fn: ParserFunction, input: string | Uint8Array, extra: number[]): unknown {
  return call(fn, input, extra).json;
}

/**
 * `callJson` with the status the export returned: whether the JSON is the
 * tree or `{error: …}`, without guessing from its shape.
 *
 * @internal Used by the parser wrappers (parser/rust_parser.ts).
 */
export function callParser(
  fn: ParserFunction,
  input: string | Uint8Array,
  extra: number[],
): { ok: boolean; json: unknown } {
  return call(fn, input, extra);
}

/**
 * Calls one lowering export with the tree (as JSON) and the source text it
 * was parsed from, and returns the JSON it emits: the lowered value, or
 * `{error: …}`.
 *
 * @internal Used by the lowering wrapper (parser/expression/lower.ts).
 */
export function callLowering(fn: LoweringFunction, treeJson: string, source: string): { ok: boolean; json: unknown } {
  return call(fn, [treeJson, source], []);
}

/**
 * One catalog lookup or helper call (crates/movement-parser/src/catalog):
 * the snapshot and the query as JSON, and the JSON answer — `{value}`, `{}`
 * for an `undefined` answer, or `{error}`.
 *
 * @internal Used by the catalog differential; the checker's own callers
 * arrive with the Rust checker.
 */
export function callCatalog(snapshotJson: string, queryJson: string): { ok: boolean; json: unknown } {
  return call('catalog_query', [snapshotJson, queryJson], []);
}

/**
 * One expression evaluated by the Rust engine against value bindings
 * (crates/movement-engine/src/abi.rs `eval_expression`), on the parser's
 * instance: the lowered expression's JSON and the bindings envelope's, and
 * the reply — `{value, provenance}`, `{error}` or `{fallback}` — or a
 * misuse as `{ok: false, json: {error: {message}}}`.
 *
 * @internal Used by the engine's evaluator switch (apps/api's rust_engine.ts).
 */
export function callEvalExpression(exprJson: string, envelopeJson: string): { ok: boolean; json: unknown } {
  const exports = currentExports();
  const evalExpression = exports.evalExpression;
  if (evalExpression === undefined) throw new Error('this movement artifact has no eval_expression()');
  let reply: { status: number; text: string };
  try {
    reply = exchange(exports, [exprJson, envelopeJson], (pairs, slots) => evalExpression(...pairs, slots, slots + 4));
  } catch (trap) {
    if (!(trap instanceof WasmTrap)) throw trap;
    if (loaded) loaded.exports = undefined;
    throw new Error(`movement engine crashed in eval_expression: ${trap.detail}`, { cause: trap.trapped });
  }
  return statusReply(reply, 'movement engine returned unknown status %s from eval_expression');
}

/**
 * The Rust checker over `source` (crates/movement-checker/src/abi.rs
 * `check_program`), on the parser's instance: the snapshot as JSON, the
 * version checked under and the one upgraded from (0: none), and the reply —
 * `{diagnostics}`, or `{error}` for a source that does not parse or a
 * snapshot that does not load.
 *
 * @internal Used by the Rust checker's wrapper (checker/rust_checker.ts).
 */
export function callCheckProgram(
  source: string,
  snapshotJson: string,
  languageVersion: number,
  upgradingFrom: number,
): { ok: boolean; json: unknown } {
  const exports = currentExports();
  const checkProgram = exports.checkProgram;
  if (checkProgram === undefined) throw new Error('this movement artifact has no check_program()');
  let reply: { status: number; text: string };
  try {
    reply = exchange(exports, [source, snapshotJson], (pairs, slots) =>
      checkProgram(...pairs, languageVersion, upgradingFrom, slots, slots + 4),
    );
  } catch (trap) {
    if (!(trap instanceof WasmTrap)) throw trap;
    if (loaded) loaded.exports = undefined;
    throw new Error(`movement checker crashed in check_program: ${trap.detail}`, { cause: trap.trapped });
  }
  return statusReply(reply, 'movement checker returned unknown status %s from check_program');
}

/** `inputs`: one (pointer, length) pair each, in order, before `extra`. */
function call(
  fn: WasmFunction,
  inputs: string | Uint8Array | Array<string | Uint8Array>,
  extra: number[],
): { ok: boolean; json: unknown } {
  const exports = currentExports();
  let reply: { status: number; text: string };
  try {
    reply = exchange(exports, Array.isArray(inputs) ? inputs : [inputs], (pairs, slots) =>
      exports.call(fn, [...pairs, ...extra, slots, slots + 4]),
    );
  } catch (trap) {
    if (!(trap instanceof WasmTrap)) throw trap;
    // A trap (a Rust panic aborts) leaves the instance's heap in an unknown
    // state, so it is never called again.
    if (loaded) loaded.exports = undefined;
    throw new Error(`movement parser crashed in ${fn}: ${trap.detail}`, { cause: trap.trapped });
  }
  return statusReply(reply, `movement parser returned unknown status %s from ${fn}`);
}

/** What every instance's exports share: memory, its allocator, and the
 *  panic message a trap leaves behind. */
interface BufferExports {
  memory: { readonly buffer: unknown };
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  lastPanic(outPtrPtr: number, outLenPtr: number): void;
}

/** A call that trapped; `detail` is the trap and the panic message, if any. */
class WasmTrap extends Error {
  constructor(
    readonly trapped: unknown,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/**
 * Copies each input into the instance, calls `invoke` with their (pointer,
 * length) pairs flattened and an 8-byte pair of out slots, and reads back the
 * UTF-8 output the call wrote there, freeing everything it allocated. A trap
 * is rethrown as a `WasmTrap` carrying the panic message, read from the
 * trapped instance's memory, the one place it lives.
 */
function exchange(
  exports: BufferExports,
  inputs: Array<string | Uint8Array>,
  invoke: (pairs: number[], slots: number) => number,
): { status: number; text: string } {
  const buffers = inputs.map(input => (typeof input === 'string' ? encoder.encode(input) : input));
  let slots: number | undefined;
  try {
    const pairs = buffers.map(bytes => {
      const ptr = exports.alloc(bytes.length);
      memoryBytes(exports).set(bytes, ptr);
      return { ptr, len: bytes.length };
    });
    slots = exports.alloc(8);
    const status = invoke(
      pairs.flatMap(p => [p.ptr, p.len]),
      slots,
    );
    for (const p of pairs) exports.dealloc(p.ptr, p.len);
    const view = new DataView(memoryBuffer(exports));
    const outPtr = view.getUint32(slots, true);
    const outLen = view.getUint32(slots + 4, true);
    exports.dealloc(slots, 8);
    const text = decoder.decode(memoryBytes(exports).subarray(outPtr, outPtr + outLen));
    exports.dealloc(outPtr, outLen);
    return { status, text };
  } catch (cause) {
    const panic = slots === undefined ? undefined : panicMessage(exports, slots);
    throw new WasmTrap(cause, `${String(cause)}${panic ? `: ${panic}` : ''}`);
  }
}

/** `unknownStatus` names the call, with `%s` where the status goes. */
function statusReply(reply: { status: number; text: string }, unknownStatus: string): { ok: boolean; json: unknown } {
  if (reply.status !== OK && reply.status !== ERROR) {
    throw new Error(unknownStatus.replace('%s', String(reply.status)));
  }
  return { ok: reply.status === OK, json: JSON.parse(reply.text) };
}

/** What the Rust panic hook recorded before the trap, read through the
 *  out slots the failed call had already allocated. A static buffer, so it
 *  is not freed. Best effort: the error is thrown either way. */
function panicMessage(exports: BufferExports, slots: number): string | undefined {
  try {
    exports.lastPanic(slots, slots + 4);
    const view = new DataView(memoryBuffer(exports));
    const ptr = view.getUint32(slots, true);
    const len = view.getUint32(slots + 4, true);
    return len === 0 ? undefined : decoder.decode(memoryBytes(exports).subarray(ptr, ptr + len));
  } catch {
    return undefined;
  }
}

/**
 * One engine segment's conversation (crates/movement-engine/src/abi.rs):
 * `start` and `answer` each return the next step as `{ok: true, json}` —
 * `{pending: [{id, family, method, args}]}` or `{done: result}` — or a
 * protocol misuse as `{ok: false, json: {error: {message}}}`. A trap
 * (a panic) throws with the panic's message and ends the segment.
 */
export interface EngineSegment {
  start(inputJson: string): { ok: boolean; json: unknown };
  answer(id: number, answerJson: string): { ok: boolean; json: unknown };
  /** Drops the segment's state. The instance is never used again. */
  finish(): void;
}

/** Resolves once the engine can open segments: the parser's load, since
 *  they are one artifact. */
export async function initEngine(bytesOrUrl?: Uint8Array | string): Promise<void> {
  await initParser(bytesOrUrl);
}

/** A fresh instance for one segment: its memory is the segment's, and goes
 *  with it. */
export function openEngineSegment(): EngineSegment {
  if (!loaded) throw new MovementParserNotReady(loadFailure);
  const exports = readEngineExports(newInstance(loaded.module));
  let state: 'open' | 'trapped' | 'finished' = 'open';
  const step = (fn: string, inputJson: string, invoke: (pairs: number[], slots: number) => number) => {
    if (state !== 'open') throw new Error(`the engine segment is ${state}: ${fn} cannot be called`);
    try {
      return statusReply(exchange(exports, [inputJson], invoke), `movement engine returned unknown status %s from ${fn}`);
    } catch (trap) {
      if (!(trap instanceof WasmTrap)) throw trap;
      state = 'trapped';
      throw new Error(`movement engine crashed in ${fn}: ${trap.detail}`, { cause: trap.trapped });
    }
  };
  return {
    start: inputJson => step('engine_start', inputJson, (pairs, slots) => exports.start(...pairs, slots, slots + 4)),
    answer: (id, answerJson) =>
      step('engine_answer', answerJson, (pairs, slots) => exports.answer(id, ...pairs, slots, slots + 4)),
    finish: () => {
      if (state === 'open') exports.finish();
      state = 'finished';
    },
  };
}

interface EngineExports extends BufferExports {
  start(...args: number[]): number;
  answer(...args: number[]): number;
  finish(): void;
}

/**
 * How many instances have been created. Each trap discards one.
 *
 * @internal Test seam for the re-instantiation path.
 */
export function parserGeneration(): number {
  return generation;
}

function currentExports(): ParserExports {
  if (!loaded) {
    throw new MovementParserNotReady(loadFailure);
  }
  loaded.exports ??= instantiate(loaded.module);
  return loaded.exports;
}

function install(module: WasmModule): void {
  const exports = instantiate(module);
  loaded = { module, exports };
  loadFailure = undefined;
}

function instantiate(module: WasmModule): ParserExports {
  const exports = readExports(newInstance(module));
  generation += 1;
  return exports;
}

/**
 * A fresh instance of `module`, its `movement_env.call` import answering
 * from this runtime: the request's JSON in, the `{value}` reply copied into
 * a buffer of the instance's own `alloc` (the Rust side frees it), through
 * the two out slots. Status 1 with `{error: {message}}` for a request it
 * cannot read or answer. Only a failure to hand the reply back (the
 * instance's `alloc` trapping, or its memory gone) throws through the
 * instance, which then traps as any call into it would.
 */
function newInstance(module: WasmModule): Record<string, unknown> {
  let raw: Record<string, unknown> | undefined;
  let read: ReturnType<typeof exportReader> | undefined;
  const call = (requestPtr: number, requestLen: number, outPtrPtr: number, outLenPtr: number): number => {
    if (raw === undefined) throw new Error('the movement artifact called its environment while instantiating');
    read ??= exportReader(raw, 'movement engine');
    const exports = read;
    let status = OK;
    let reply: unknown;
    try {
      const request: unknown = JSON.parse(decoder.decode(memoryBytes(exports).slice(requestPtr, requestPtr + requestLen)));
      reply = answerEnvRequest(request);
    } catch (error) {
      status = ERROR;
      reply = { error: { message: error instanceof Error ? error.message : String(error) } };
    }
    const bytes = encoder.encode(JSON.stringify(reply));
    const ptr = exports.buffers.alloc(bytes.length);
    memoryBytes(exports).set(bytes, ptr);
    const view = new DataView(memoryBuffer(exports));
    view.setUint32(outPtrPtr, ptr, true);
    view.setUint32(outLenPtr, bytes.length, true);
    return status;
  };
  raw = new WebAssembly.Instance(module, { movement_env: { call } }).exports;
  return raw;
}

function readExports(raw: Record<string, unknown>): ParserExports {
  const { memory, exported, number, buffers } = exportReader(raw, 'movement parser');
  const parsers: Record<WasmFunction, (...args: number[]) => unknown> = {
    parse_program: exported('parse_program'),
    parse_program_eager: exported('parse_program_eager'),
    parse_expression: exported('parse_expression'),
    parse_nested_call: exported('parse_nested_call'),
    lower_expression: exported('lower_expression'),
    lower_condition: exported('lower_condition'),
    catalog_query: exported('catalog_query'),
  };
  const evalExpression = typeof raw.eval_expression === 'function' ? exported('eval_expression') : undefined;
  const checkProgram = typeof raw.check_program === 'function' ? exported('check_program') : undefined;
  return {
    memory,
    ...buffers,
    call: (fn, args) => number(parsers[fn](...args), fn),
    evalExpression: evalExpression && ((...args) => number(evalExpression(...args), 'eval_expression')),
    checkProgram: checkProgram && ((...args) => number(checkProgram(...args), 'check_program')),
  };
}

// Read only when a segment opens, so a module without the engine (the
// loader test's hand-built one) still serves the parser.
function readEngineExports(raw: Record<string, unknown>): EngineExports {
  const { exported, number, buffers, memory } = exportReader(raw, 'movement engine');
  const start = exported('engine_start');
  const answer = exported('engine_answer');
  const finish = exported('engine_finish');
  return {
    memory,
    ...buffers,
    start: (...args) => number(start(...args), 'engine_start'),
    answer: (...args) => number(answer(...args), 'engine_answer'),
    finish: () => void finish(),
  };
}

function exportReader(raw: Record<string, unknown>, what: string) {
  const memory = raw.memory;
  if (typeof memory !== 'object' || memory === null || !('buffer' in memory)) {
    throw new Error(`${what} module exports no memory`);
  }
  const exported = (name: string): ((...args: number[]) => unknown) => {
    const fn = raw[name];
    if (typeof fn !== 'function') throw new Error(`${what} module exports no ${name}()`);
    return (...args) => fn(...args);
  };
  const number = (value: unknown, name: string): number => {
    if (typeof value !== 'number') throw new Error(`${what} ${name}() returned ${typeof value}`);
    return value;
  };
  const alloc = exported('alloc');
  const dealloc = exported('dealloc');
  const lastPanic = exported('last_panic');
  const buffers = {
    alloc: (len: number) => number(alloc(len), 'alloc'),
    dealloc: (ptr: number, len: number) => void dealloc(ptr, len),
    lastPanic: (outPtrPtr: number, outLenPtr: number) => void lastPanic(outPtrPtr, outLenPtr),
  };
  return { memory, exported, number, buffers };
}

// Read afresh on every access: growing the memory detaches the old buffer.
function memoryBuffer(exports: Pick<BufferExports, 'memory'>): ArrayBuffer {
  const buffer = exports.memory.buffer;
  if (!isArrayBuffer(buffer)) throw new Error('movement parser memory has no ArrayBuffer');
  return buffer;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  // A tag check rather than instanceof: under jest the buffer comes from
  // another realm.
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function memoryBytes(exports: Pick<BufferExports, 'memory'>): Uint8Array {
  return new Uint8Array(memoryBuffer(exports));
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not fetch the movement parser from ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// The window check too: a bundler's browser `process` shim may carry
// `versions`, and a browser must never take the disk path.
function isNode(): boolean {
  return typeof window === 'undefined' && typeof process !== 'undefined' && typeof process.versions?.node === 'string';
}

function loadFromDisk(): void {
  // getBuiltinModule rather than require('fs'): bundlers resolve a literal
  // require for the browser and fail on `fs`.
  const fs = process?.getBuiltinModule?.('fs');
  if (typeof fs !== 'object' || fs === null || !('readFileSync' in fs) || typeof fs.readFileSync !== 'function') {
    throw new Error('this Node has no process.getBuiltinModule("fs") (needs Node 22.3+)');
  }
  const bytes: unknown = fs.readFileSync(`${__dirname}/${WASM_FILE}`);
  if (!ArrayBuffer.isView(bytes)) throw new Error(`reading ${WASM_FILE} did not return bytes`);
  install(new WebAssembly.Module(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
}

if (isNode()) {
  // Recorded rather than thrown so a bundle that cannot reach the file (a
  // server bundle with a rewritten __dirname) still loads; the first parse
  // then throws with this as its cause.
  try {
    loadFromDisk();
  } catch (failure) {
    loadFailure = failure;
  }
}
