// A host built from a recording's method list, each method answered by a
// function of its path and request — the in-process replay host and the HTTP
// host are both this, with a different answer. And a recorded thrown error,
// thrown again as the class the engine branches on.

import type { RecordedError, ServedAnswer } from 'engine-contracts/conformance';

import { MovementEngineError, RunCancelledSignal, RunLeaseLost, type MovementEngineErrorCode } from '../errors';
import type { EngineHost } from '../host';

/** The error a recorded thrown error was. The engine branches on three
 *  classes a host may throw (a cancel, a lost lease, its own error by code);
 *  any other is an `Error` under its recorded name. */
export function rethrown(error: RecordedError): Error {
  switch (error.class) {
    case 'RunCancelledSignal':
      return new RunCancelledSignal();
    case 'RunLeaseLost':
      return Object.assign(new RunLeaseLost(''), { message: error.message });
    case 'MovementEngineError': {
      const code = error.code;
      if (code !== undefined && isEngineCode(code)) {
        const prefix = `${code}: `;
        return new MovementEngineError(
          code,
          error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
        );
      }
      break;
    }
  }
  const thrown = new Error(error.message);
  thrown.name = error.class;
  if (error.code !== undefined) Object.assign(thrown, { code: error.code });
  return thrown;
}

const ENGINE_CODES: ReadonlySet<string> = new Set<MovementEngineErrorCode>([
  'MOVENG_PARSE',
  'MOVENG_CHECK',
  'MOVENG_LANGUAGE_VERSION',
  'MOVENG_NOT_FOUND',
  'MOVENG_UNSUPPORTED',
  'MOVENG_RUNTIME',
  'MOVENG_CALL_DEPTH',
  'MOVENG_PARK_NONSERIALIZABLE',
  'MOVENG_ERROR',
]);

function isEngineCode(code: string): code is MovementEngineErrorCode {
  return ENGINE_CODES.has(code);
}

/** What a served answer resolves to, or the error it throws. */
export function settle(served: ServedAnswer): unknown {
  if ('error' in served) throw rethrown(served.error);
  return served.answer;
}

/**
 * An `EngineHost` serving exactly `methods` (a recording's), each answered
 * by `serve`. The host is built from the method list, not written out, so a
 * family a recording's host left out is absent here too.
 */
export function hostServing(
  methods: readonly string[],
  serve: (path: string, request: unknown) => Promise<unknown>,
): EngineHost {
  const root: Record<string, unknown> = {};
  for (const path of methods) {
    const keys = path.split('.');
    const name = keys.pop();
    if (name === undefined) continue;
    let family = root;
    for (const key of keys) {
      const next = family[key];
      if (isFamily(next)) {
        family = next;
      } else {
        const created: Record<string, unknown> = {};
        family[key] = created;
        family = created;
      }
    }
    family[name] = (...args: unknown[]) => serve(path, args[0]);
  }
  if (!isEngineHost(root)) {
    throw new Error(`a host serving ${methods.join(', ')} lacks a family every host has`);
  }
  return root;
}

function isFamily(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The families every host serves (the manifest's non-optional ones): a tree
 *  holding them, each method a function from the recording, is a host. */
const REQUIRED_FAMILIES = ['segment', 'adapters', 'llm', 'park', 'control', 'files', 'lookup', 'locks'];

function isEngineHost(tree: Record<string, unknown>): tree is Record<string, unknown> & EngineHost {
  return REQUIRED_FAMILIES.every((family) => isFamily(tree[family]));
}
