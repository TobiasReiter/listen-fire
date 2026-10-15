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

import { NotJson, notJsonAt } from './not_json';
import { VOID_HOST_METHODS, hostMethodPaths, servedHostMethods, type EngineHost } from 'movement-engine/services/movement_engine/host';
import { MovementRunFailed } from 'movement-engine/services/movement_engine/errors';

const MANIFEST: ReadonlySet<string> = new Set(hostMethodPaths());
const VOID_METHODS: ReadonlySet<string> = new Set(VOID_HOST_METHODS);

/** A request as it is being recorded: its answer arrives later. `issued`
 *  and `answered` are ticks of one clock the entry's requests share, so
 *  which requests were answered before another was made can be read off
 *  them. */
interface Recording {
  family: string;
  method: string;
  args: unknown;
  issued: number;
  answered?: number;
  outcome?: { answer?: unknown } | { error: RecordedError };
}

/** Where one entry's requests are recorded, and whether the entry has ended:
 *  a request made after that is no part of the recording, and is refused. */
interface Conversation {
  requests: Recording[];
  ticks: number;
  ended: boolean;
  /** Told of every request made after the entry ended. */
  late: (message: string) => void;
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
  const cause: unknown = error instanceof MovementRunFailed ? error.cause : error;
  const code: unknown = typeof cause === 'object' && cause !== null ? Reflect.get(cause, 'code') : undefined;
  return {
    class: error.constructor.name,
    ...(typeof code === 'string' ? { code } : {}),
    message: error.message,
  };
}

/** `host` with every manifest method recording into `conversation`. */
function recordingHost(host: EngineHost, conversation: Conversation): EngineHost {
  return wrapFamily(host, '', conversation);
}

function wrapFamily<T extends object>(family: T, prefix: string, conversation: Conversation): T {
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
        wrapper = (...args: unknown[]) => recordCall({ path, target, method: value, args, conversation });
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        wrapper = wrapFamily(value, `${path}.`, conversation);
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
  conversation,
}: {
  path: string;
  target: object;
  method: Function;
  args: unknown[];
  conversation: Conversation;
}): unknown {
  if (conversation.ended) {
    const message = `host request ${path} was made after the entry ended`;
    conversation.late(message);
    throw new Error(message);
  }
  if (args.length > 1) throw new Error(`${path} was called with ${args.length} arguments; a host request is one object`);
  const recording: Recording = {
    ...familyAndMethod(path),
    args: copied(args[0], path, 'request'),
    issued: ++conversation.ticks,
  };
  conversation.requests.push(recording);
  const answered = (outcome: NonNullable<Recording['outcome']>): void => {
    recording.outcome = outcome;
    recording.answered = ++conversation.ticks;
  };
  let answer: unknown;
  try {
    answer = Reflect.apply(method, target, args);
  } catch (error) {
    // A method that throws rather than rejecting threw at the engine all the
    // same: the recording says so, and the engine sees the throw.
    answered({ error: recordedError(error) });
    throw error;
  }
  return Promise.resolve(answer).then(
    (resolved: unknown) => {
      try {
        if (VOID_METHODS.has(path)) {
          if (resolved !== undefined) throw new NotJson(path, 'answer', 'a value from a void method');
          answered({});
        } else {
          if (resolved === undefined) throw new NotJson(path, 'answer', 'undefined');
          answered({ answer: copied(resolved, path, 'answer') });
        }
      } catch (error) {
        // The engine is handed the refusal, so the recording says it was.
        answered({ error: recordedError(error) });
        throw error;
      }
      return resolved;
    },
    (error: unknown) => {
      answered({ error: recordedError(error) });
      throw error;
    },
  );
}

/**
 * The recorded requests, each with the requests answered before it was made
 * (`after`), reduced to those no other of them implies. A request answered
 * before one that was itself answered before this one was made is implied:
 * of the requests answered before this one was made, what the latest-made
 * of them was made after is implied, so `after` is exactly the requests
 * answered between that one's making and this one's.
 */
function finished(requests: readonly Recording[]): RecordedRequest[] {
  return requests.map(({ family, method, args, issued, outcome }, i) => {
    if (outcome === undefined) {
      throw new Error(`host request #${i + 1} ${family}.${method} was still unanswered when the entry ended`);
    }
    const before = requests.filter((other) => other.answered !== undefined && other.answered < issued);
    const implied = Math.max(0, ...before.map((other) => other.issued));
    const after = before.filter((other) => (other.answered ?? 0) >= implied).map((other) => requests.indexOf(other));
    return { family, method, args, after, ...outcome };
  });
}

/**
 * Run one entry into the engine with its host recording, and hand `keep` the
 * recording however the entry ends; the entry's own result or error passes
 * through unchanged. The input is recorded with the language version the
 * entry ran under, so a recording made where the current version is another
 * (a conformance corpus) replays under its own. A request made after the
 * entry ended is refused and reported to `late` (by default, thrown into the
 * engine only): a recording cannot hold it.
 */
export async function recordEntry<E extends RecordedEntry, Result>({
  entry,
  input,
  run,
  keep,
  late = () => undefined,
}: {
  entry: E;
  input: EntryInputs[E] & { host: EngineHost };
  run: (input: EntryInputs[E] & { host: EngineHost }) => Promise<Result>;
  keep: (recording: HostRecording) => void;
  late?: (message: string) => void;
}): Promise<Result> {
  const { host, ...data } = input;
  const recordedInput = copied(
    { ...data, languageVersion: data.languageVersion ?? CURRENT_LANGUAGE_VERSION },
    entry,
    'input',
  );
  const conversation: Conversation = { requests: [], ticks: 0, ended: false, late };
  const methods = servedHostMethods(host);
  const ended = (end: { result: unknown } | { failure: RecordedError }): HostRecording => {
    conversation.ended = true;
    return hostRecordingSchema.parse({
      kit: 'host',
      version: HOST_RECORDING_VERSION,
      entry,
      input: recordedInput,
      methods,
      requests: finished(conversation.requests),
      ...end,
    });
  };
  let result: Result;
  try {
    result = await run({ ...input, host: recordingHost(host, conversation) });
  } catch (error) {
    keep(ended({ failure: recordedError(error) }));
    throw error;
  }
  keep(ended({ result: copied(result, entry, 'result') }));
  return result;
}
