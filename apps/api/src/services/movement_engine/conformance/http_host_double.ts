// The model of an embedder's remote host, both halves: a tiny HTTP server that
// exposes every host family as JSON endpoints answering from a recording, and
// the thin `EngineHost` that reaches it — one POST per request. Replaying a
// recording through the pair proves the host contract survives a wire: every
// request and answer is JSON, and nothing the engine relies on is a value only
// a host in its own process could hand it.
//
// The wire:
//
//   POST /host/<family>/<method>      (`/host/park.sink/commitTimerPark`)
//   body:     the method's one request object, `{ segmentId, ... }`
//   200 body: `{ "answer": <value> }`, or `{}` from a method that answers
//             nothing, or `{ "error": { class, code?, message } }` for an
//             error the host threw
//   409 body: `{ "divergence": "<why>" }` — the recording has no such
//             request, or the replay made it out of the recording's order
//   503 body: the double is serving no recording
//
// A host's own thrown error travels as a 200 with an `error` envelope, not
// as an HTTP error status: the status says only whether the double could
// answer. A transport failure (a refused connection, any other status) is no
// host answer, and fails the request as a plain error naming the status; the
// kit does not model one. Nor does the double advertise which methods it
// serves: both halves are built from the recording's `methods` (a remote
// embedder's host will need to say what it serves on the wire).

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { ReplayDivergence, type RecordedConversation, type ServedAnswer } from 'engine-contracts/conformance';

import type { EngineHost } from '../host';
import { hostServing, settle } from './replay_host';

/** The double's address and the conversation it answers from. */
export interface HostDouble {
  url: string;
  /** Answer every request from here on from `conversation`. */
  serve(conversation: RecordedConversation): void;
  close(): Promise<void>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function startHostDouble(): Promise<HostDouble> {
  let conversation: RecordedConversation | undefined;
  const app = express();
  app.use(express.json({ limit: '200mb' }));
  app.post('/host/:family/:method', (request, response, next) => {
    if (conversation === undefined) {
      response.status(503).json({ divergence: 'the double is serving no recording' });
      return;
    }
    const { family, method } = request.params;
    conversation.answer(`${family}.${method}`, request.body).then(
      (served: ServedAnswer) => response.json(served),
      (error: unknown) => {
        if (!(error instanceof ReplayDivergence)) return next(error);
        response.status(409).json({ divergence: error.message });
      },
    );
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = addressOf(server);
  return {
    url: `http://127.0.0.1:${port}`,
    serve(next) {
      conversation = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function addressOf(server: Server): AddressInfo {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the host double is not listening on a port');
  return address;
}

/** What a reply's body says, read at the wire's edge. */
function servedFrom(body: unknown, where: string): ServedAnswer {
  if (!isObject(body)) throw new Error(`${where} answered ${JSON.stringify(body)}, which is no reply`);
  const error = body.error;
  if (isObject(error)) {
    const { class: name, code, message } = error;
    if (typeof name !== 'string' || typeof message !== 'string' || (code !== undefined && typeof code !== 'string')) {
      throw new Error(`${where} answered a malformed error ${JSON.stringify(error)}`);
    }
    return { error: { class: name, message, ...(code !== undefined ? { code } : {}) } };
  }
  return 'answer' in body ? { answer: body.answer } : {};
}

/** An `EngineHost` serving `methods`, each request a POST to the double at
 *  `url`. */
export function httpHost(url: string, methods: readonly string[]): EngineHost {
  return hostServing(methods, async (path, request) => {
    if (!isObject(request)) throw new Error(`${path}'s request is not an object, and the wire carries only objects`);
    const dot = path.lastIndexOf('.');
    const where = `POST /host/${path.slice(0, dot)}/${path.slice(dot + 1)}`;
    const response = await fetch(`${url}/host/${path.slice(0, dot)}/${path.slice(dot + 1)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    // Built in this realm: an answer parsed elsewhere (jest's fetch) has
    // another realm's `Object.prototype`, which no plain-object check takes.
    const body: unknown = JSON.parse(await response.text());
    if (response.status === 409 && isObject(body) && typeof body.divergence === 'string') {
      throw new ReplayDivergence(body.divergence);
    }
    if (!response.ok) throw new Error(`${where} answered ${response.status}: ${JSON.stringify(body)}`);
    return settle(servedFrom(body, where));
  });
}
