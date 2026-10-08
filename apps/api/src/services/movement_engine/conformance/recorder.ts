// The host-conformance kit's recorder: any `EngineHost` wrapped so every
// request the engine makes of it, and every answer, is written down as it
// crossed, and one entry into the engine (a run, a resume, a race settlement,
// a callback body) becomes one recording (`engine-contracts/conformance`).
//
// The host and the engine still see each other's own values: the recording
// takes a JSON copy of each, so it holds exactly what would have crossed a
// wire at that moment and recording changes nothing about the run. A value
// JSON cannot carry fails the call instead — after chunk 4A every request and
// answer is JSON (the seam guard's round trip proves it), so such a throw is a
// bug report against the boundary, not a case to record around.

import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';
import {
  HOST_RECORDING_VERSION,
  familyAndMethod,
  hostRecordingSchema,
  type EntryInputs,
  type HostRecording,
  type RecordedEntry,
  type RecordedError,
  type RecordedRequest,
} from 'engine-contracts/conformance';

import { NotJson, notJsonAt } from '../__test__/round_trip_host';
import { VOID_HOST_METHODS, hostMethodPaths, type EngineHost } from '../host';
import { withHeldClock } from './clock';

const MANIFEST: ReadonlySet<string> = new Set(hostMethodPaths());
const VOID_METHODS: ReadonlySet<string> = new Set(VOID_HOST_METHODS);

/** A request as it is being recorded: its answer arrives later. */
interface Recording {
  family: string;
  method: string;
  args: unknown;
  outcome?: { answer?: unknown } | { error: RecordedError };
}

function copied(value: unknown, where: string, path: string): unknown {
  const found = notJsonAt(value, path);
  if (found !== undefined) throw new NotJson(where, found.path, found.what);
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** A thrown value as data. A run that died mid-way throws the transparent
 *  carrier of its partial ledger (`MovementRunFailed`), whose `cause` is what
 *  it died of: the code is read through it. */
export function recordedError(error: unknown): RecordedError {
  if (!(error instanceof Error)) return { class: typeof error, message: String(error) };
  const cause: unknown = 'partial' in error && error.cause !== undefined ? error.cause : error;
  const code: unknown = typeof cause === 'object' && cause !== null ? Reflect.get(cause, 'code') : undefined;
  return {
    class: error.constructor.name,
    ...(typeof code === 'string' ? { code } : {}),
    message: error.message,
  };
}

/** Every manifest method `host` serves, by path. */
export function servedMethods(host: EngineHost): string[] {
  return [...MANIFEST].filter((path) => {
    let at: unknown = host;
    for (const key of path.split('.')) {
      if (typeof at !== 'object' || at === null) return false;
      at = Reflect.get(at, key);
    }
    return typeof at === 'function';
  });
}

/** `host` with every manifest method recording into `requests`. */
export function recordingHost(host: EngineHost, requests: Recording[]): EngineHost {
  return wrapFamily(host, '', requests);
}

function wrapFamily<T extends object>(family: T, prefix: string, requests: Recording[]): T {
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy(family, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof key !== 'string') return value;
      const existing = wrappers.get(key);
      if (existing !== undefined) return existing;
      const path = `${prefix}${key}`;
      let wrapper: unknown;
      if (typeof value === 'function' && MANIFEST.has(path)) {
        wrapper = (...args: unknown[]) => recordCall({ path, target, method: value, args, requests });
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        wrapper = wrapFamily(value, `${path}.`, requests);
      } else {
        return value;
      }
      wrappers.set(key, wrapper);
      return wrapper;
    },
  });
}

function recordCall({
  path,
  target,
  method,
  args,
  requests,
}: {
  path: string;
  target: object;
  method: Function;
  args: unknown[];
  requests: Recording[];
}): unknown {
  if (args.length > 1) throw new Error(`${path} was called with ${args.length} arguments; a host request is one object`);
  const recording: Recording = { ...familyAndMethod(path), args: copied(args[0], path, 'request') };
  requests.push(recording);
  const answer: unknown = Reflect.apply(method, target, args);
  return Promise.resolve(answer).then(
    (resolved: unknown) => {
      try {
        if (VOID_METHODS.has(path)) {
          if (resolved !== undefined) throw new NotJson(path, 'answer', 'a value from a void method');
          recording.outcome = {};
        } else {
          if (resolved === undefined) throw new NotJson(path, 'answer', 'undefined');
          recording.outcome = { answer: copied(resolved, path, 'answer') };
        }
      } catch (error) {
        // The engine is handed the refusal, so the recording says it was.
        recording.outcome = { error: recordedError(error) };
        throw error;
      }
      return resolved;
    },
    (error: unknown) => {
      recording.outcome = { error: recordedError(error) };
      throw error;
    },
  );
}

function finished(requests: readonly Recording[]): RecordedRequest[] {
  return requests.map(({ family, method, args, outcome }, i) => {
    if (outcome === undefined) {
      throw new Error(`host request #${i + 1} ${family}.${method} was still unanswered when the entry ended`);
    }
    return { family, method, args, ...outcome };
  });
}

/**
 * Run one entry into the engine with its host recording, and hand `keep` the
 * recording however the entry ends; the entry's own result or error passes
 * through unchanged. The input is recorded with the language version the
 * entry ran under, so a recording made where the current version is another
 * (a conformance corpus) replays under its own. The entry runs with the clock
 * held (./clock.ts), and the recording keeps the instant.
 */
export async function recordEntry<E extends RecordedEntry, Result>({
  entry,
  input,
  run,
  keep,
}: {
  entry: E;
  input: EntryInputs[E] & { host: EngineHost };
  run: (input: EntryInputs[E] & { host: EngineHost }) => Promise<Result>;
  keep: (recording: HostRecording) => void;
}): Promise<Result> {
  const { host, ...data } = input;
  const recordedInput = copied(
    { ...data, languageVersion: data.languageVersion ?? CURRENT_LANGUAGE_VERSION },
    entry,
    'input',
  );
  const requests: Recording[] = [];
  const methods = servedMethods(host);
  return withHeldClock(undefined, async (clock) => {
    const ended = (end: { result: unknown } | { failure: RecordedError }): HostRecording =>
      hostRecordingSchema.parse({
        kit: 'host',
        version: HOST_RECORDING_VERSION,
        entry,
        clock,
        input: recordedInput,
        methods,
        requests: finished(requests),
        ...end,
      });
    let result: Result;
    try {
      result = await run({ ...input, host: recordingHost(host, requests) });
    } catch (error) {
      keep(ended({ failure: recordedError(error) }));
      throw error;
    }
    keep(ended({ result: copied(result, entry, 'result') }));
    return result;
  });
}
