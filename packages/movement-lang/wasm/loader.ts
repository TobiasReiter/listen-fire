// Loads the Rust parser and lowering (crates/movement-parser, built by
// scripts/build-parser-wasm.sh) and calls its hand-written C ABI: UTF-8 bytes
// in, UTF-8 JSON bytes out, every buffer freed by the side that did not
// allocate it. Node instantiates synchronously when this module loads; a
// browser must `await initParser(…)` first, because browsers refuse large
// synchronous compiles on the main thread.

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

interface WasmModule {
  readonly __wasmModule?: never;
}

type ParserFunction = 'parse_program' | 'parse_program_eager' | 'parse_expression' | 'parse_nested_call';

/** The lowering's exports take two inputs: the tree's JSON, and its source. */
type LoweringFunction = 'lower_expression' | 'lower_condition';

/** The catalog's export takes two inputs: the snapshot's JSON, and the query's. */
type CatalogFunction = 'catalog_query';

type WasmFunction = ParserFunction | LoweringFunction | CatalogFunction;

interface ParserExports {
  memory: { readonly buffer: unknown };
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  call(fn: WasmFunction, args: number[]): number;
  lastPanic(outPtrPtr: number, outLenPtr: number): void;
}

interface Loaded {
  module: WasmModule;
  // Absent after a trap: the next call instantiates afresh from `module`.
  exports: ParserExports | undefined;
}

const WASM_FILE = 'movement_parser.wasm';
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

/** `inputs`: one (pointer, length) pair each, in order, before `extra`. */
function call(
  fn: WasmFunction,
  inputs: string | Uint8Array | Array<string | Uint8Array>,
  extra: number[],
): { ok: boolean; json: unknown } {
  const exports = currentExports();
  const buffers = (Array.isArray(inputs) ? inputs : [inputs]).map(input =>
    typeof input === 'string' ? encoder.encode(input) : input,
  );
  let status: number;
  let json: string;
  let slots: number | undefined;
  try {
    const pairs = buffers.map(bytes => {
      const ptr = exports.alloc(bytes.length);
      memoryBytes(exports).set(bytes, ptr);
      return { ptr, len: bytes.length };
    });
    slots = exports.alloc(8);
    status = exports.call(fn, [...pairs.flatMap(p => [p.ptr, p.len]), ...extra, slots, slots + 4]);
    for (const p of pairs) exports.dealloc(p.ptr, p.len);
    const view = new DataView(memoryBuffer(exports));
    const outPtr = view.getUint32(slots, true);
    const outLen = view.getUint32(slots + 4, true);
    exports.dealloc(slots, 8);
    json = decoder.decode(memoryBytes(exports).subarray(outPtr, outPtr + outLen));
    exports.dealloc(outPtr, outLen);
  } catch (cause) {
    // A trap (a Rust panic aborts) leaves the instance's heap in an unknown
    // state, so it is never called again — except to read the panic's
    // message, which lives only in its memory.
    const panic = slots === undefined ? undefined : panicMessage(exports, slots);
    if (loaded) loaded.exports = undefined;
    const detail = panic ? `: ${panic}` : '';
    throw new Error(`movement parser crashed in ${fn}: ${String(cause)}${detail}`, { cause });
  }
  if (status !== OK && status !== ERROR) {
    throw new Error(`movement parser returned unknown status ${status} from ${fn}`);
  }
  return { ok: status === OK, json: JSON.parse(json) };
}

/** What the Rust panic hook recorded before the trap, read through the
 *  out slots the failed call had already allocated. A static buffer, so it
 *  is not freed. Best effort: the error is thrown either way. */
function panicMessage(exports: ParserExports, slots: number): string | undefined {
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
  const exports = readExports(new WebAssembly.Instance(module, {}).exports);
  generation += 1;
  return exports;
}

function readExports(raw: Record<string, unknown>): ParserExports {
  const memory = raw.memory;
  if (typeof memory !== 'object' || memory === null || !('buffer' in memory)) {
    throw new Error('movement parser module exports no memory');
  }
  const exported = (name: string): ((...args: number[]) => unknown) => {
    const fn = raw[name];
    if (typeof fn !== 'function') throw new Error(`movement parser module exports no ${name}()`);
    return (...args) => fn(...args);
  };
  const number = (value: unknown, name: string): number => {
    if (typeof value !== 'number') throw new Error(`movement parser ${name}() returned ${typeof value}`);
    return value;
  };
  const alloc = exported('alloc');
  const dealloc = exported('dealloc');
  const lastPanic = exported('last_panic');
  const parsers: Record<WasmFunction, (...args: number[]) => unknown> = {
    parse_program: exported('parse_program'),
    parse_program_eager: exported('parse_program_eager'),
    parse_expression: exported('parse_expression'),
    parse_nested_call: exported('parse_nested_call'),
    lower_expression: exported('lower_expression'),
    lower_condition: exported('lower_condition'),
    catalog_query: exported('catalog_query'),
  };
  return {
    memory,
    alloc: (len) => number(alloc(len), 'alloc'),
    dealloc: (ptr, len) => void dealloc(ptr, len),
    call: (fn, args) => number(parsers[fn](...args), fn),
    lastPanic: (outPtrPtr, outLenPtr) => void lastPanic(outPtrPtr, outLenPtr),
  };
}

// Read afresh on every access: growing the memory detaches the old buffer.
function memoryBuffer(exports: ParserExports): ArrayBuffer {
  const buffer = exports.memory.buffer;
  if (!isArrayBuffer(buffer)) throw new Error('movement parser memory has no ArrayBuffer');
  return buffer;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  // A tag check rather than instanceof: under jest the buffer comes from
  // another realm.
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function memoryBytes(exports: ParserExports): Uint8Array {
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
