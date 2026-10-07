// The boundary every value crosses between the TypeScript side of the Rust
// engine (rust_engine.ts, rust_host.ts) and the WASM instance: the eval wire
// (crates/movement-engine/src/env.rs says the format), the plain-JSON check,
// and the shim's own faults.

import { neverAsAny } from '../../lib/utils/types';
import { bindingOf } from './expression';
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
 * The wire to the Rust evaluator and back (crates/movement-engine/src/env.rs
 * says the format): values with their identity, and the origins of the trails
 * they carry, numbered.
 */
export class WireOut {
  /** `asData`: a dict shaped like an engine binding crosses as the data it
   *  is (a parked state's descriptors), not refused as a record. */
  constructor(private readonly options: { asData?: true } = {}) {}

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
    if (!isList && (proto !== Object.prototype || (this.options.asData !== true && bindingOf(value) !== undefined))) return REFUSED;
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


