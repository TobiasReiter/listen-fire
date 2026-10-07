// A host wrapped so every call crosses as JSON would: each request and each
// answer is checked for anything JSON cannot carry, then serialised and
// parsed, so the far side only ever sees the copy. A value JSON would drop or
// change — a function, a class instance, a Date, a Map, a stream, a BigInt, a
// NaN, a -0, a lone surrogate, a hole in an array, a cycle — fails the call,
// naming the method and the path to the value. The wrapping walks the host
// object itself, so a method added to any family is wrapped without anyone
// listing it.

import { VOID_HOST_METHODS, type EngineHost } from '../host';

export class NotJson extends Error {
  constructor(where: string, path: string, what: string) {
    super(`${where}: ${path} is ${what}, which does not cross the host boundary as JSON`);
    this.name = 'NotJson';
  }
}

/** Why `value` would not survive a JSON round trip, or undefined when it
 *  would. An undefined object field is absent on the far side, which is what
 *  an optional field means, so it passes. */
export function notJsonAt(value: unknown, path: string): { path: string; what: string } | undefined {
  return notJsonWithin(value, path, new Map());
}

/** `ancestors` maps each object on the way down to its path, so a value that
 *  contains itself is named instead of recursed into forever. */
function notJsonWithin(
  value: unknown,
  path: string,
  ancestors: Map<object, string>,
): { path: string; what: string } | undefined {
  switch (typeof value) {
    case 'boolean':
      return undefined;
    case 'string':
      return value.isWellFormed() ? undefined : { path, what: 'a string with a lone surrogate' };
    case 'number':
      if (!Number.isFinite(value)) return { path, what: String(value) };
      return Object.is(value, -0) ? { path, what: '-0' } : undefined;
    case 'bigint':
      return { path, what: 'a BigInt' };
    case 'function':
      return { path, what: 'a function' };
    case 'symbol':
      return { path, what: 'a symbol' };
    case 'undefined':
      return { path, what: 'undefined' };
    case 'object': {
      if (value === null) return undefined;
      const cycleTo = ancestors.get(value);
      if (cycleTo !== undefined) return { path, what: `a cycle back to ${cycleTo}` };
      ancestors.set(value, path);
      try {
        return Array.isArray(value)
          ? notJsonInArray(value, path, ancestors)
          : notJsonInObject(value, path, ancestors);
      } finally {
        ancestors.delete(value);
      }
    }
  }
}

function notJsonInArray(
  value: readonly unknown[],
  path: string,
  ancestors: Map<object, string>,
): { path: string; what: string } | undefined {
  for (let i = 0; i < value.length; i++) {
    if (!(i in value)) return { path: `${path}[${i}]`, what: 'a hole' };
    const found = notJsonWithin(value[i], `${path}[${i}]`, ancestors);
    if (found !== undefined) return found;
  }
  return undefined;
}

function notJsonInObject(
  value: object,
  path: string,
  ancestors: Map<object, string>,
): { path: string; what: string } | undefined {
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const constructor: unknown = Reflect.get(value, 'constructor');
    const name =
      typeof constructor === 'function' && constructor.name !== '' ? constructor.name : 'an object';
    return { path, what: `an instance of ${name}` };
  }
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    const found = notJsonWithin(field, `${path}.${key}`, ancestors);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The far side's copy of a value already checked to be JSON: the same type,
 *  by construction, as what went in. */
function jsonCopy<T>(value: T): T {
  const copy: T = JSON.parse(JSON.stringify(value));
  return copy;
}

function crossed<T>(value: T, where: string, path: string): T {
  const found = notJsonAt(value, path);
  if (found !== undefined) throw new NotJson(where, found.path, found.what);
  return jsonCopy(value);
}

const VOID_METHODS: ReadonlySet<string> = new Set(VOID_HOST_METHODS);

/** An answer as the far side sends it back: nothing at all from a void
 *  method, and a JSON value — never a bare undefined — from every other. */
function answered(value: unknown, where: string): unknown {
  if (VOID_METHODS.has(where)) {
    if (value !== undefined) throw new NotJson(where, 'answer', 'a value from a void method');
    return undefined;
  }
  return crossed(value, where, 'answer');
}

/** Each wrapped method's path (`park.sink.recordJoin`), as the host is built. */
export function methodPaths(host: object, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(host)) {
    if (value === undefined) continue;
    const path = `${prefix}${key}`;
    if (typeof value === 'function') paths.push(path);
    else if (typeof value === 'object' && value !== null) paths.push(...methodPaths(value, `${path}.`));
  }
  return paths;
}

/**
 * `host` with every method of every family wrapped in a JSON round trip.
 * `called` collects each method path the run reached. A method that answers
 * synchronously fails too: over a wire every answer is awaited.
 */
export function roundTripHost(host: EngineHost, called: Set<string> = new Set()): EngineHost {
  return wrapFamily(host, '', called);
}

/** The family seen through a proxy: each method read off it is the wrapped
 *  one, each nested family the wrapped family, so the wrapper has the family's
 *  own type with no cast. */
function wrapFamily<T extends object>(family: T, prefix: string, called: Set<string>): T {
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy(family, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof key !== 'string') return value;
      const existing = wrappers.get(key);
      if (existing !== undefined) return existing;
      const path = `${prefix}${key}`;
      let wrapper: unknown;
      if (typeof value === 'function') {
        wrapper = (...args: unknown[]) => {
          called.add(path);
          const request = crossed(args, path, 'request');
          const answer: unknown = Reflect.apply(value, target, request);
          if (!(answer instanceof Promise)) {
            throw new NotJson(path, 'answer', 'answered synchronously');
          }
          return answer.then((resolved: unknown) => answered(resolved, path));
        };
      } else if (typeof value === 'object' && value !== null) {
        wrapper = wrapFamily(value, `${path}.`, called);
      } else {
        return value;
      }
      wrappers.set(key, wrapper);
      return wrapper;
    },
  });
}
