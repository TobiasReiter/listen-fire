// A host wrapped so every call crosses as JSON would: each request and each
// answer is checked for anything JSON cannot carry, then serialised and
// parsed, so the far side only ever sees the copy. A value JSON would drop or
// change — a function, a class instance, a Date, a Map, a stream, a BigInt, a
// NaN, a hole in an array — fails the call, naming the method and the path to
// the value. The wrapping walks the host object itself, so a method added to
// any family is wrapped without anyone listing it.

import type { EngineHost } from '../host';

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
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return undefined;
    case 'number':
      return Number.isFinite(value) ? undefined : { path, what: String(value) };
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
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) return { path: `${path}[${i}]`, what: 'a hole' };
          const found = notJsonAt(value[i], `${path}[${i}]`);
          if (found !== undefined) return found;
        }
        return undefined;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'an object';
        return { path, what: `an instance of ${name}` };
      }
      for (const [key, field] of Object.entries(value)) {
        if (field === undefined) continue;
        const found = notJsonAt(field, `${path}.${key}`);
        if (found !== undefined) return found;
      }
      return undefined;
    }
  }
}

function crossed<T>(value: T, where: string, path: string): T {
  if (value === undefined) return value;
  const found = notJsonAt(value, path);
  if (found !== undefined) throw new NotJson(where, found.path, found.what);
  return JSON.parse(JSON.stringify(value)) as T;
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

function wrapFamily<T extends object>(family: T, prefix: string, called: Set<string>): T {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(family)) {
    const path = `${prefix}${key}`;
    if (typeof value === 'function') {
      wrapped[key] = (...args: unknown[]) => {
        called.add(path);
        const request = crossed(args, path, 'request');
        const answer: unknown = Reflect.apply(value, family, request);
        if (!(answer instanceof Promise)) {
          throw new NotJson(path, 'answer', 'answered synchronously');
        }
        return answer.then((resolved) => crossed(resolved, path, 'answer'));
      };
    } else if (typeof value === 'object' && value !== null) {
      wrapped[key] = wrapFamily(value, `${path}.`, called);
    } else {
      wrapped[key] = value;
    }
  }
  // The only cast: the wrapper has the same keys, each method the same
  // signature, as the family it wraps.
  return wrapped as T;
}
