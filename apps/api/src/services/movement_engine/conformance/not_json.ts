// What crosses the host boundary as JSON, and what does not: the check the
// seam guard's round trip (__test__/round_trip_host.ts) and the conformance
// recorder (./recorder.ts) both make of every request and answer. A value
// JSON would drop or change — a function, a class instance, a Date, a Map, a
// stream, a BigInt, a NaN, a -0, a lone surrogate, a hole in an array, a
// cycle — is named by its path.

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
