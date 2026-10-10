// The boundary every value crosses between the TypeScript side of the Rust
// engine (rust_engine.ts, rust_host.ts) and the WASM instance: the eval wire
// (crates/movement-engine/src/env.rs says the format), the plain-JSON check,
// and the shim's own faults.

import { isCallbackParamType, type CallbackParamSpec } from 'engine-contracts';
import { neverAsAny } from '../../lib/utils/types';
import type { Binding } from './expression';
import type { Provenance, ProvenanceOrigin } from './provenance';

export class RunAborted extends Error {
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

export function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RustShimError(`${what}: args must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

export function string(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new RustShimError(`${what} must be a string`);
  return value;
}

export function optionalString(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : string(value, what);
}

export function optionalStringRecord(value: unknown, what: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(record(value, what));
  return Object.fromEntries(entries.map(([key, entry]) => [key, string(entry, `${what}.${key}`)]));
}

export const REFUSED: unique symbol = Symbol('refused');

/** A lone surrogate: JSON cannot carry it into a Rust string. */
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The built-ins a read of an `Object.prototype` name off a plain object finds
 * (`{}.toString`, `{}.constructor`): the engine holds each by the name it
 * prints, and the wire carries that name (`["f", name]`).
 */
const OBJECT_PROTOTYPE_BUILTINS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['Object', Object],
  ...Object.getOwnPropertyNames(Object.prototype)
    .filter((name) => name !== 'constructor' && name !== '__proto__')
    .map((name): [string, unknown] => [name, Reflect.get(Object.prototype, name)]),
  // A list's methods, `Array#<name>`: what an object whose prototype a
  // GROUPBY filing made a list reads under those names.
  ...Object.getOwnPropertyNames(Array.prototype)
    .filter((name) => typeof Reflect.get(Array.prototype, name) === 'function')
    .map((name): [string, unknown] => [`Array#${name}`, Reflect.get(Array.prototype, name)]),
]);

function builtinName(value: unknown): ['f', string] | undefined {
  for (const [name, builtin] of OBJECT_PROTOTYPE_BUILTINS) if (builtin === value) return ['f', name];
  return undefined;
}

function builtinNamed(name: unknown): unknown {
  const builtin = typeof name === 'string' ? OBJECT_PROTOTYPE_BUILTINS.get(name) : undefined;
  if (builtin === undefined) throw new RustShimError(`the wire names no built-in ${String(name)}`);
  return builtin;
}

export function isCallbackParam(value: unknown): value is CallbackParamSpec {
  if (typeof value !== 'object' || value === null) return false;
  const type: unknown = Reflect.get(value, 'type');
  return typeof Reflect.get(value, 'name') === 'string' && typeof type === 'string' && isCallbackParamType(type);
}

/**
 * A record the engine handed the host (`["x", id, descriptor]`), built from
 * the descriptor the engine wrote: the event's binding object, or a
 * callback's. Only the wire's own tag makes one, so nothing the host or a
 * webhook sends can become one, whatever keys it carries.
 */
function bindingFromWire(descriptor: unknown): Binding {
  const kind = typeof descriptor === 'object' && descriptor !== null ? Reflect.get(descriptor, 'kind') : undefined;
  if (kind === 'event') return { kind: 'event' };
  if (kind === 'callback' && typeof descriptor === 'object' && descriptor !== null) {
    const callbackId: unknown = Reflect.get(descriptor, 'callbackId');
    const url: unknown = Reflect.get(descriptor, 'url');
    const params: unknown = Reflect.get(descriptor, 'params');
    if (typeof callbackId !== 'string' || typeof url !== 'string' || !Array.isArray(params) || !params.every(isCallbackParam)) {
      throw new RustShimError('the engine handed the host a callback that is not {callbackId, url, params}');
    }
    return { kind: 'callback', callbackId, url, params };
  }
  throw new RustShimError(`the engine handed the host a record of kind ${String(kind)}, which the shim does not rebuild`);
}

/**
 * The wire to the Rust evaluator and back (crates/movement-engine/src/env.rs
 * says the format): values with their identity, and the origins of the trails
 * they carry, numbered. A value is data or one of the engine's records, and
 * the two never share a form: every object the host writes is data, whatever
 * keys it carries; a record is only ever one the engine handed out
 * (`["x", id, descriptor]`), handed back by its id.
 */
export class WireOut {
  /** `whole`: each value is written whole — a back-reference only within
   *  it — because a segment's engine decodes each answer on its own, in the
   *  order it reads them, and an object re-sent after a mutation must cross
   *  as it now is. An object keeps the id it was first sent under, so the
   *  engine knows an object sent twice for the one object it is (the same
   *  object a host hands the TypeScript engine twice is `===` itself). */
  constructor(private readonly options: { whole?: true } = {}) {}

  /** The records the engine handed out, by the id it gave each. */
  private readonly records = new Map<number, Binding>();
  private readonly recordIds = new Map<object, number>();

  /** The objects and lists sent, by the id the wire gave them. */
  private readonly sent: object[] = [];
  /** The ids of the objects written so far: a back-reference names one. */
  private readonly ids = new Map<object, number>();
  /** The id each object was first sent under, kept across values. */
  private readonly identity = new Map<object, number>();
  private readonly open = new Set<object>();
  readonly origins: ProvenanceOrigin[] = [];
  private readonly originIds = new Map<ProvenanceOrigin, number>();

  /** How deep the value being written is: 0 between values. */
  private writing = 0;

  /** `value` on the wire, or REFUSED where it would not cross as itself: a
   *  function, a Date, a class instance, a lone surrogate. A record the
   *  engine handed out crosses back as itself; nothing else is a record. */
  value(value: unknown): unknown {
    if (this.options.whole === true && this.writing === 0) this.ids.clear();
    this.writing += 1;
    try {
      return this.write(value);
    } finally {
      this.writing -= 1;
    }
  }

  private write(value: unknown): unknown {
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
        return value === Object.prototype ? ['p'] : this.composite(value);
      case 'function':
        return builtinName(value) ?? REFUSED;
      case 'bigint':
      case 'symbol':
        return REFUSED;
      default:
        return neverAsAny(kind);
    }
  }

  private composite(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    const record = this.recordIds.get(value);
    if (record !== undefined) return ['x', record];
    const seen = this.ids.get(value);
    if (seen !== undefined) return this.open.has(value) ? REFUSED : ['r', seen];
    const proto: unknown = Object.getPrototypeOf(value);
    const isList = Array.isArray(value) && proto === Array.prototype;
    if (!isList && proto !== Object.prototype) return REFUSED;
    let id = this.identity.get(value);
    if (id === undefined) {
      id = this.sent.length;
      this.sent.push(value);
      this.identity.set(value, id);
    }
    this.ids.set(value, id);
    this.open.add(value);
    try {
      if (Array.isArray(value)) {
        const items: unknown[] = [];
        for (let i = 0; i < value.length; i++) {
          // A hole is not `undefined` to every array method.
          if (!(i in value)) return REFUSED;
          const item = this.write(value[i]);
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
        const item = this.write(Reflect.get(value, key));
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
      case 'f':
        return builtinNamed(a);
      case 'p':
        return Object.prototype;
      case 'i':
        if (typeof a !== 'number' || this.sent[a] === undefined) throw new RustShimError(`the wire names no sent value ${String(a)}`);
        return this.sent[a];
      case 'r':
        if (typeof a !== 'number' || !made.has(a)) throw new RustShimError(`the wire names no value ${String(a)} it made`);
        return made.get(a);
      case 'x': {
        if (typeof a !== 'number') throw new RustShimError(`the engine handed the host a record it cannot carry (${String(a)})`);
        const held = this.records.get(a);
        if (held !== undefined) return held;
        const record = bindingFromWire(this.read(b, made));
        this.records.set(a, record);
        this.recordIds.set(record, a);
        return record;
      }
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
        // `["o", id, entries, prototype]`: what a GROUPBY or KEYBY filing
        // under `__proto__` made the object's prototype.
        if (wire.length > 3) {
          const proto = this.read(wire[3], made);
          if (typeof proto !== 'object' && typeof proto !== 'function') throw new RustShimError('a wire prototype is an object');
          Object.setPrototypeOf(object, proto);
        }
        return object;
      }
      default:
        throw new RustShimError(`an unknown wire tag ${String(tag)}`);
    }
  }
}


