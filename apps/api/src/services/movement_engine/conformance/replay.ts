// The host-conformance kit's replay harness: a recording served back to our
// engines through a host that answers from it, and judged by the kit's rules
// (`engine-contracts/conformance`: the matching rule, the verdict). Three
// targets take a recording:
//
//  - `typescript`: the in-process TypeScript engine, answered in process;
//  - `rust`: the Rust engine through its shim (rust_host.ts) against the same
//    host — only for a recording whose program the shim routes and the Rust
//    engine runs whole, which the shim's own counts say; any other is
//    skipped, with the reason;
//  - `http`: the TypeScript engine against a host that is a wire — each
//    request a POST to the HTTP host double (http_host_double.ts), the model
//    of an embedder's remote host.

import {
  RecordedConversation,
  ReplayDivergence,
  verdictOf,
  type HostRecording,
  type RecordedOutcome,
  type ReplayTarget,
  type ReplayVerdict,
} from 'engine-contracts/conformance';

import { neverAsAny } from '../../../lib/utils/types';
import type { EngineHost } from '../host';
import { fireCallbackBody, resumeMovement, runMovement, settleRaceFrame, type MovementRunResult } from '../run';
import { rustRunStats } from '../rust_stats';
import { startHostDouble, httpHost } from './http_host_double';
import { recordedError } from './recorder';
import { hostServing, settle } from './replay_host';

/** The entry the recording made, made again against `host`. */
export function enter(recording: HostRecording, host: EngineHost): Promise<MovementRunResult> {
  switch (recording.entry) {
    case 'run':
      return runMovement({ ...recording.input, host });
    case 'resume':
      return resumeMovement({ ...recording.input, host });
    case 'settleRace':
      return settleRaceFrame({ ...recording.input, host });
    case 'callbackBody':
      return fireCallbackBody({ ...recording.input, host });
    default:
      return neverAsAny(recording);
  }
}

/** How the entry ended, as a recording keeps it. */
async function outcomeAgainst(recording: HostRecording, host: EngineHost): Promise<RecordedOutcome> {
  try {
    const result = await enter(recording, host);
    return { result: JSON.parse(JSON.stringify(result)) };
  } catch (error) {
    return { failure: recordedError(error) };
  }
}

/** Replay `recording` through a host whose every request `serve` answers
 *  from the recording's conversation. */
async function replayThrough(
  recording: HostRecording,
  hostFor: (conversation: RecordedConversation) => EngineHost,
): Promise<ReplayVerdict> {
  const conversation = new RecordedConversation(recording.requests);
  const outcome = await outcomeAgainst(recording, hostFor(conversation));
  return verdictOf(recording, conversation, outcome);
}

const inProcess = (conversation: RecordedConversation, methods: readonly string[]): EngineHost =>
  hostServing(methods, async (path, request) => settle(await conversation.answer(path, request)));

/** Run `body` with `MOVEMENT_ENGINE` set to `engine`, restoring it after. */
async function underEngine<T>(engine: 'ts' | 'rust', body: () => Promise<T>): Promise<T> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

export const typescriptTarget: ReplayTarget = {
  name: 'typescript',
  replay: (recording) =>
    underEngine('ts', () => replayThrough(recording, (conversation) => inProcess(conversation, recording.methods))),
};

export const rustTarget: ReplayTarget = {
  name: 'rust',
  async replay(recording) {
    const before = {
      routed: rustRunStats.routed,
      ranWhole: rustRunStats.ranWhole,
      notAdmitted: { ...rustRunStats.notAdmitted },
      declined: { ...rustRunStats.declined },
    };
    const verdict = await underEngine('rust', () =>
      replayThrough(recording, (conversation) => inProcess(conversation, recording.methods)),
    );
    if (rustRunStats.ranWhole > before.ranWhole) return verdict;
    const grew = (now: Record<string, number>, then: Record<string, number>) =>
      Object.entries(now).filter(([reason, count]) => count > (then[reason] ?? 0)).map(([reason]) => reason);
    // The shim's own input checks (`event_does_not_cross`) count in `notAdmitted`
    // too, before a segment opens: only a routed run was refused by the engine.
    if (rustRunStats.routed === before.routed) {
      return { kind: 'skipped', reason: 'the shim does not route this program to the Rust engine' };
    }
    const refused = grew(rustRunStats.notAdmitted, before.notAdmitted);
    if (refused.length > 0) return { kind: 'skipped', reason: `the Rust engine refused it: ${refused.join('; ')}` };
    const declined = grew(rustRunStats.declined, before.declined);
    return { kind: 'skipped', reason: `the Rust engine declined it: ${declined.join('; ') || 'no reason counted'}` };
  },
};

/** The HTTP target: the TypeScript engine against a host that POSTs every
 *  request to a host double serving the recording. `close` stops the double. */
export async function httpTarget(): Promise<ReplayTarget & { close(): Promise<void> }> {
  const double = await startHostDouble();
  return {
    name: 'http',
    replay: (recording) =>
      underEngine('ts', () =>
        replayThrough(recording, (conversation) => {
          double.serve(conversation);
          return httpHost(double.url, recording.methods);
        }),
      ),
    close: () => double.close(),
  };
}

export { ReplayDivergence };
