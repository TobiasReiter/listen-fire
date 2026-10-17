// A host built from a recording's method list, each method answered by a
// function of its path and request — the in-process replay host and the HTTP
// host are both this, with a different answer. And a recorded thrown error,
// thrown again as the class the engine branches on.

import type { RecordedError, ServedAnswer } from 'engine-contracts/conformance';

import { MovementEngineError, RunCancelledSignal, RunLeaseLost, type MovementEngineErrorCode } from 'movement-engine/public/run-support';
import { missingHostMethods, type EngineHost } from 'movement-engine/public/host';

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

// Every code, held to the type: a code added there and not here fails to
// compile.
const ENGINE_CODES: Record<MovementEngineErrorCode, true> = {
  MOVENG_PARSE: true,
  MOVENG_CHECK: true,
  MOVENG_LANGUAGE_VERSION: true,
  MOVENG_NOT_FOUND: true,
  MOVENG_UNSUPPORTED: true,
  MOVENG_RUNTIME: true,
  MOVENG_CALL_DEPTH: true,
  MOVENG_PARK_NONSERIALIZABLE: true,
  MOVENG_ERROR: true,
  MOVENG_LIMIT_STEPS: true,
  MOVENG_LIMIT_TEXT_SIZE: true,
  MOVENG_LIMIT_COLLECTION_SIZE: true,
  MOVENG_LIMIT_RESULT_SIZE: true,
  MOVENG_LIMIT_WALL_CLOCK: true,
};

function isEngineCode(code: string): code is MovementEngineErrorCode {
  return Object.prototype.hasOwnProperty.call(ENGINE_CODES, code);
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
    throw new Error(`a host serving ${methods.join(', ')} lacks ${missingHostMethods(root).join(', ')}, which every host serves`);
  }
  return root;
}

function isFamily(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A tree serving every method the manifest requires (its non-optional
 *  families'), each a function from the recording, is a host. */
function isEngineHost(tree: Record<string, unknown>): tree is Record<string, unknown> & EngineHost {
  return missingHostMethods(tree).length === 0;
}
