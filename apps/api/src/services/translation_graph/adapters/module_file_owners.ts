// The files a built-in module serves name the install that owns them. A
// module mints a file's source with its own adapter type and the provider's
// handle, but not the install: it is not told which credential it runs as.
// The platform redeems a file by constructing that owner again, so a module
// line's answers have their own files stamped with the install's credential
// and construction arguments on the way out — what the remote adapter does
// for a module served as a process.

import type { Adapter } from 'movement-engine/public/adapter';

import type { BuiltinInstall } from './builtin_modules';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function stamped(value: unknown, adapterType: string, install: BuiltinInstall): unknown {
  if (Array.isArray(value)) return value.map((item) => stamped(item, adapterType, install));
  if (!isRecord(value) || value instanceof Date || ArrayBuffer.isView(value)) return value;
  const source = value.source;
  if (value.__brand === 'FileRef' && isRecord(source) && source.adapterType === adapterType && source.credentialId === undefined) {
    return {
      ...value,
      source: {
        ...source,
        ...(install.credentialsId !== undefined ? { credentialId: install.credentialsId } : {}),
        ...(install.constructionArgs !== undefined ? { constructionArgs: install.constructionArgs } : {}),
      },
    };
  }
  // A stream or other live object is passed through untouched.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stamped(item, adapterType, install)]));
}

/** The methods whose answers are field values, where a file value lives. The
 *  rest (catalogue, walks, writes) are left as they are, so stamping costs
 *  nothing on the calls that cannot carry a file. */
const VALUE_METHODS = ['getFieldValue', 'readRecord'] as const;

/** The adapter, each field value's own files naming `install` as their owner:
 *  its two value methods are overridden on the instance itself (a proxy would
 *  sit in front of every property the adapter reads of itself). */
export function stampingFileOwners<A extends Adapter>(adapter: A, install: BuiltinInstall): A {
  for (const name of VALUE_METHODS) {
    const method: unknown = Reflect.get(adapter, name);
    if (typeof method !== 'function') continue;
    Object.defineProperty(adapter, name, {
      configurable: true,
      writable: true,
      value: async (...args: unknown[]) => stamped(await Reflect.apply(method, adapter, args), adapter.adapterType, install),
    });
  }
  return adapter;
}
