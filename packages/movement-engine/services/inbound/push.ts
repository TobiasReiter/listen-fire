// The two push doors a module calls when it owns its own inbound URL:
//
//   POST …/<adapterType>/emit  { events }  new data, receipted against the
//                                          caller's triggers as a webhook
//                                          delivery's events are
//   POST …/<adapterType>/wake  { keys }    resume whatever is parked on these
//                                          correlation keys
//
// The caller presents the credential its install holds and the install whose
// secret matches is the team (the store decides). Both answer 202
// `{ accepted }` once the rows are queued; 401 with no detail when the
// credential matches no install, so the door says nothing about who installed
// what; 409 when it matches installs on several teams and none is named; 400
// for a malformed body, judged only after authentication.
//
// Beside them, the models door a module served as a process asks for model
// calls through (module kit `hostModels`), authenticated the same way:
//
//   POST …/<adapterType>/models  HostModelRequest  →  200 HostModelAnswer
//
// The host answers through its models; the door bills no run itself. The
// answer's `cost` rides back on the response of the call whose work asked,
// so the run that made that call is charged.

import { AdapterEmitBody, AdapterWakeBody, HostModelRequest, type HostModelAnswerShape, type HostModelRequestShape } from 'engine-contracts';
import type { z } from 'zod';

import type { DiscriminableEvent, EventType } from '../translation_graph/adapter';
import type { InboundAnswer } from './deliver';
import type { InboundHeaders } from './verify';

import { logger } from '../logger';
import { ADAPTER_TEAM_HEADER } from '../translation_graph/protocol/client';
import { neverAsAny } from '../../lib/utils/types';

/** The install a push authenticated as. */
export interface PushCaller {
  teamId: string;
  adapterType: string;
  credentialsId: string;
}

export type PushAuth =
  | { kind: 'authenticated'; caller: PushCaller }
  | { kind: 'unauthorized' }
  | { kind: 'ambiguous' };

export interface PushStore<Captured> {
  authenticate(input: { adapterType: string; headers: InboundHeaders }): Promise<PushAuth>;
  /** The adapter's event-type union, best effort ([] when unreadable). */
  eventTypes(caller: PushCaller): Promise<readonly EventType[]>;
  /** The receipts one event earns (one per matching trigger). */
  capture(input: { caller: PushCaller; event: DiscriminableEvent; eventTypes: readonly EventType[] }): Promise<Captured[]>;
  enqueue(captured: readonly Captured[]): Promise<void>;
  enqueueWakes(input: { adapterType: string; teamId: string; keys: readonly string[] }): Promise<void>;
  notify(): void;
}

export interface PushRequest {
  adapterType: string;
  headers: InboundHeaders;
  /** The parsed JSON body. */
  body: unknown;
}

async function callerOf<C>(store: PushStore<C>, request: PushRequest): Promise<PushCaller | InboundAnswer> {
  const auth = await store.authenticate({ adapterType: request.adapterType, headers: request.headers });
  switch (auth.kind) {
    case 'authenticated':
      return auth.caller;
    case 'unauthorized':
      return { status: 401, body: { error: 'unauthorized' } };
    case 'ambiguous':
      return {
        status: 409,
        body: {
          error: 'ambiguous_credential',
          message: `this credential belongs to more than one team's install; name the team in the ${ADAPTER_TEAM_HEADER} header`,
        },
      };
    default:
      return neverAsAny(auth);
  }
}

function badRequest(error: z.ZodError): InboundAnswer {
  return {
    status: 400,
    body: {
      error: 'bad_request',
      issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    },
  };
}

/**
 * Receipt each event against the caller's triggers and queue a run per
 * receipt. A capture that throws fails the call (500) AFTER the receipts
 * already made are queued, since a receipt without its row would never run.
 */
export async function emitEvents<C>(
  store: PushStore<C>,
  input: { caller: PushCaller; events: readonly DiscriminableEvent[] },
): Promise<{ accepted: number; failed: number }> {
  const { caller } = input;
  const eventTypes = input.events.length > 0 ? await store.eventTypes(caller) : [];
  const captured: C[] = [];
  let failed = 0;
  for (const event of input.events) {
    try {
      captured.push(...(await store.capture({ caller, event, eventTypes })));
    } catch (err) {
      failed += 1;
      logger.error('[AdapterDoors] emit capture failed', {
        adapterType: caller.adapterType,
        teamId: caller.teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await store.enqueue(captured);
  if (captured.length > 0) store.notify();
  return { accepted: captured.length, failed };
}

/** Queue a wake per key. A key nothing is parked on drains as a no-op. */
export async function wakeKeys<C>(
  store: PushStore<C>,
  input: { caller: PushCaller; keys: readonly string[] },
): Promise<{ accepted: number }> {
  await store.enqueueWakes({ adapterType: input.caller.adapterType, teamId: input.caller.teamId, keys: input.keys });
  store.notify();
  return { accepted: input.keys.length };
}

export async function answerEmit<C>(store: PushStore<C>, request: PushRequest): Promise<InboundAnswer> {
  try {
    const body = AdapterEmitBody.safeParse(request.body);
    // Authenticate before judging the body, so an unauthenticated caller learns
    // nothing about the shape the door wants.
    const caller = await callerOf(store, request);
    if ('status' in caller) return caller;
    if (!body.success) return badRequest(body.error);
    const { accepted, failed } = await emitEvents(store, { caller, events: body.data.events });
    if (failed > 0) return { status: 500, body: { error: 'capture_failed', accepted, failed } };
    return { status: 202, body: { accepted } };
  } catch (err) {
    logger.error('[AdapterDoors] emit failed', { err });
    return { status: 500, body: { error: 'internal' } };
  }
}

export async function answerWake<C>(store: PushStore<C>, request: PushRequest): Promise<InboundAnswer> {
  try {
    const body = AdapterWakeBody.safeParse(request.body);
    const caller = await callerOf(store, request);
    if ('status' in caller) return caller;
    if (!body.success) return badRequest(body.error);
    return { status: 202, body: await wakeKeys(store, { caller, keys: body.data.keys }) };
  } catch (err) {
    logger.error('[AdapterDoors] wake failed', { err });
    return { status: 500, body: { error: 'internal' } };
  }
}

/** How a host answers its models door: one model call for the install that asked. */
export type HostModelCall = (input: { caller: PushCaller; request: HostModelRequestShape }) => Promise<HostModelAnswerShape>;

/** A request the host's models refuse as asked (a model it does not know, a
 *  schema a forced tool cannot carry): answered 400 with its message. */
export class HostModelRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostModelRefused';
  }
}

export async function answerModels<C>(store: PushStore<C>, request: PushRequest, models: HostModelCall): Promise<InboundAnswer> {
  try {
    const body = HostModelRequest.safeParse(request.body);
    const caller = await callerOf(store, request);
    if ('status' in caller) return caller;
    if (!body.success) return badRequest(body.error);
    return { status: 200, body: await models({ caller, request: body.data }) };
  } catch (err) {
    if (err instanceof HostModelRefused) return { status: 400, body: { error: 'bad_request', message: err.message } };
    logger.error('[AdapterDoors] model call failed', { err });
    return { status: 502, body: { error: 'model_call_failed', message: err instanceof Error ? err.message : String(err) } };
  }
}

