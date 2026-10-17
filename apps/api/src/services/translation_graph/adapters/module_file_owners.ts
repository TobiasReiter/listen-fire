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

/** The adapter, each answer's own files naming `install` as their owner. */
export function stampingFileOwners<A extends Adapter>(adapter: A, install: BuiltinInstall): A {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function' || property === 'resolveFileRef') return member;
      return (...args: unknown[]) => {
        const answer: unknown = Reflect.apply(member, target, args);
        return answer instanceof Promise ? answer.then((settled: unknown) => stamped(settled, adapter.adapterType, install)) : answer;
      };
    },
  });
}
