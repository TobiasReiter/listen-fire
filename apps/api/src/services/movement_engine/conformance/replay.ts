// The host-conformance kit's replay harness: a recording served back to our
// engines through a host that answers from it, and judged by the kit's rules
// (`engine-contracts/conformance`: the matching rule, the verdict). The
// recordings are of the TypeScript engine (language versions 1–4), and two
// targets take one:
//
//  - `typescript`: the in-process TypeScript engine, answered in process;
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

import { neverAsAny } from 'movement-engine/public/utils';
import type { EngineHost } from 'movement-engine/public/host';
import { fireCallbackBody, resumeMovement, runMovement, settleRaceFrame, type MovementRunResult } from 'movement-engine/public/movement-engine';
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

export const typescriptTarget: ReplayTarget = {
  name: 'typescript',
  replay: (recording) => replayThrough(recording, (conversation) => inProcess(conversation, recording.methods)),
};

/** The HTTP target: the TypeScript engine against a host that POSTs every
 *  request to a host double serving the recording. `close` stops the double. */
export async function httpTarget(): Promise<ReplayTarget & { close(): Promise<void> }> {
  const double = await startHostDouble();
  return {
    name: 'http',
    replay: (recording) =>
      replayThrough(recording, (conversation) => {
        double.serve(conversation);
        return httpHost(double.url, recording.methods);
      }),
    close: () => double.close(),
  };
}

export { ReplayDivergence };
