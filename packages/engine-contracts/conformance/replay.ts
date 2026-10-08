// Serving a recording back, and judging a replay. An engine under replay is
// handed the recorded input and a host that answers from the recording; it
// conforms when every request it makes was recorded, it makes every recorded
// request, and it ends as the recording did.
//
// The matching rule: a request is answered by the EARLIEST recorded request
// not yet served whose family, method and canonical args (`canonicalJson`)
// are its own. Equal requests are served in recorded order, and branches that
// interleave differently from the recording still match. A request with no
// such counterpart is a divergence, and so is a recorded request the replay
// never makes.

import {
  canonicalJson,
  familyAndMethod,
  outcomeOf,
  pathOf,
  type HostRecording,
  type RecordedError,
  type RecordedOutcome,
  type RecordedRequest,
} from './recording';

/** What a request was answered with: a value (absent for a method that
 *  answers nothing), or the error to throw. */
export type ServedAnswer = { answer?: unknown } | { error: RecordedError };

const SHOWN = 300;

const shown = (value: unknown): string => {
  const text = canonicalJson(value) ?? 'undefined';
  return text.length > SHOWN ? `${text.slice(0, SHOWN)}…` : text;
};

/** The recording's requests, served by the matching rule. The first
 *  divergence is kept, because the engine may catch the error a divergent
 *  request throws and carry on (an `onError`, a forgiven read). */
export class RecordedConversation {
  private readonly keys: string[];
  private readonly served: boolean[];
  private made = 0;
  private divergence: string | undefined;

  constructor(private readonly requests: readonly RecordedRequest[]) {
    this.keys = requests.map((request) => keyOf(pathOf(request), request.args));
    this.served = requests.map(() => false);
  }

  /** The recorded answer to the request at `path` with `args`. */
  answer(path: string, args: unknown): ServedAnswer {
    const made = ++this.made;
    const key = keyOf(path, args);
    const index = this.keys.findIndex((recorded, i) => !this.served[i] && recorded === key);
    if (index < 0) {
      const message = this.unmatched(made, path, args);
      this.divergence ??= message;
      throw new ReplayDivergence(message);
    }
    this.served[index] = true;
    const request = this.requests[index];
    if (request === undefined) throw new ReplayDivergence(`request ${index} vanished`);
    return 'error' in request ? { error: request.error } : request.answer === undefined ? {} : { answer: request.answer };
  }

  /** The first divergence: a request with no recorded counterpart, or else
   *  the first recorded request the replay never made. Undefined when the
   *  conversation matched. */
  firstDivergence(): string | undefined {
    if (this.divergence !== undefined) return this.divergence;
    const unmade = this.served.indexOf(false);
    if (unmade < 0) return undefined;
    const request = this.requests[unmade];
    return request === undefined
      ? undefined
      : `recorded request #${unmade + 1} ${pathOf(request)} ${shown(request.args)} was never made`;
  }

  private unmatched(made: number, path: string, args: unknown): string {
    const head = `request #${made} ${path} ${shown(args)} has no recorded counterpart`;
    const samePath = this.requests.findIndex((request, i) => !this.served[i] && pathOf(request) === path);
    const sameRequest = this.requests[samePath];
    if (sameRequest !== undefined) {
      const at = firstDifference(sameRequest.args, args, 'args');
      return `${head}; the first unserved ${path} recorded was #${samePath + 1} ${shown(sameRequest.args)}${at !== undefined ? `, which differs at ${at}` : ''}`;
    }
    const next = this.served.indexOf(false);
    const nextRequest = this.requests[next];
    return nextRequest !== undefined
      ? `${head}; the next unserved request recorded was #${next + 1} ${pathOf(nextRequest)} ${shown(nextRequest.args)}`
      : `${head}; every recorded request was already served`;
  }
}

function keyOf(path: string, args: unknown): string {
  const { family, method } = familyAndMethod(path);
  return canonicalJson({ family, method, args });
}

/** Thrown into the engine for a request the recording has no answer to. */
export class ReplayDivergence extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayDivergence';
  }
}

/** How a replay against one target went. */
export type ReplayVerdict =
  | { kind: 'same' }
  | { kind: 'diverged'; divergence: string }
  /** The target cannot take this recording (an engine that does not run its
   *  program), with why: never a failure. */
  | { kind: 'skipped'; reason: string };

/** A host and engine to replay recordings against. */
export interface ReplayTarget {
  name: string;
  replay(recording: HostRecording): Promise<ReplayVerdict>;
}

/** The verdict on one replay: the conversation's first divergence, else the
 *  first difference between how the recording ended and how the replay did.
 *  Results compare as canonical JSON; failures by class, code and message. */
export function verdictOf(
  recording: HostRecording,
  conversation: RecordedConversation,
  replayed: RecordedOutcome,
): ReplayVerdict {
  const divergence = conversation.firstDivergence();
  if (divergence !== undefined) return { kind: 'diverged', divergence };
  const difference = outcomeDifference(outcomeOf(recording), replayed);
  return difference === undefined ? { kind: 'same' } : { kind: 'diverged', divergence: difference };
}

export function outcomeDifference(recorded: RecordedOutcome, replayed: RecordedOutcome): string | undefined {
  if ('failure' in recorded) {
    if (!('failure' in replayed)) return `recorded a failure ${shown(recorded.failure)}; the replay answered ${shown(replayed.result)}`;
    return canonicalJson(recorded.failure) === canonicalJson(replayed.failure)
      ? undefined
      : `recorded the failure ${shown(recorded.failure)}; the replay failed ${shown(replayed.failure)}`;
  }
  if ('failure' in replayed) return `recorded a result; the replay failed ${shown(replayed.failure)}`;
  const at = firstDifference(recorded.result, replayed.result, 'result');
  return at === undefined ? undefined : `the results differ at ${at}`;
}

/** Where two JSON values first differ, as a path with both sides shown. */
function firstDifference(recorded: unknown, replayed: unknown, path: string): string | undefined {
  if (canonicalJson(recorded) === canonicalJson(replayed)) return undefined;
  const bothObjects =
    typeof recorded === 'object' && recorded !== null && typeof replayed === 'object' && replayed !== null;
  if (bothObjects && Array.isArray(recorded) === Array.isArray(replayed)) {
    const left = new Map<string, unknown>(Object.entries(recorded));
    const right = new Map<string, unknown>(Object.entries(replayed));
    const keys = [...new Set([...left.keys(), ...right.keys()])];
    for (const key of keys) {
      const found = firstDifference(left.get(key), right.get(key), `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  return `${path}: recorded ${shown(recorded)}, replayed ${shown(replayed)}`;
}
