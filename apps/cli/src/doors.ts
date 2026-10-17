// lf's inbound doors, on the engine's inbound core (movement-engine's
// services/inbound): the core owns verification, the delivery pipeline and the
// push doors' answers; this file is only what lf keeps behind them.
//
//   POST /api/public/webhook-sync/<provider>/<install>   a provider's delivery
//        (`/hooks/<external>/<install>` is the same door under lf's older name)
//   POST /api/public/adapter/<external>/emit  { events }  an external's new data
//   POST /api/public/adapter/<external>/wake  { keys }    resume what is parked
//
// An install is a credential in the secrets file; its name is the
// "subscription" in the URL. A delivery's signature is checked by the scheme
// the external's manifest declares (`inbound`), or, for an external that
// declares none, by what its `lf-external.yaml` `webhook:` block says (the
// protocol's own scheme). A signed delivery with no usable secret is refused,
// as everywhere. Events are queued as work rows in lf's SQLite state and
// drained by `lf serve`; wakes are queued the same way.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { WireInboundDeclarationShape } from 'engine-contracts';
import {
  answerDelivery,
  declaredInboundVerifier,
  type InboundAdapter,
  type InboundAnswer,
  type InboundDelivery,
  type InboundHeaders,
  type InboundStore,
  type InboundSubscription,
  type PushAuth,
  type PushStore,
} from 'movement-engine/public/inbound';
import type { DiscriminableEvent } from 'movement-engine/services/translation_graph/adapter';
import { authHeader } from 'movement-engine/services/translation_graph/protocol/client';
import { queueAwaitWake } from 'movement-engine/services/run_host/rules';
import { type RunningExternal } from './externals';
import { LOCAL_TENANT } from './host';
import { remoteAdapterOf } from './remote';
import { fireEvent, type RunOutcome, type Session } from './runs';
import { installOf, type Credential } from './secrets';

/** What the doors need of a session: tests supply a session of their own. */
export type DoorSession = Pick<Session, 'runHost' | 'state' | 'credentials' | 'running' | 'documents'>;

/** The field of an install's credential that holds the webhook secret when the
 *  external declares `inbound` and `lf-external.yaml` names none. */
export const DEFAULT_WEBHOOK_SECRET_FIELD = 'webhook_secret';

export interface InboundSetup {
  declaration: WireInboundDeclarationShape;
  secretField: string;
}

/** How an external's deliveries are verified: its manifest's `inbound`, else
 *  its `lf-external.yaml` `webhook:` block as the protocol's own scheme. */
export function inboundSetupOf(running: RunningExternal): InboundSetup | undefined {
  const yaml = running.external.manifest.webhook;
  if (running.inbound !== undefined) {
    return { declaration: running.inbound, secretField: yaml?.secretField ?? DEFAULT_WEBHOOK_SECRET_FIELD };
  }
  if (yaml === undefined) return undefined;
  return {
    declaration: { providerKey: running.external.manifest.name, scheme: 'remote', signatureHeaders: [yaml.header.toLowerCase()] },
    secretField: yaml.secretField,
  };
}

/** The provider segment an external's door answers to. Doors compare it
 *  upper-cased, so any casing in a URL reaches it. */
export function providerKeyOf(setup: InboundSetup): string {
  return setup.declaration.providerKey.toUpperCase();
}

export interface LfInboundOptions {
  /** Poke the drain: work rows were queued. */
  notify(): void;
  /** What a verified event becomes. Default: a `fire_event` work row. */
  enqueueEvent?(input: { external: string; event: DiscriminableEvent }): Promise<void>;
  /** The adapter that reads a delivery. Default: the external, over the protocol. */
  adapterOf?(input: { running: RunningExternal; credential: Credential; session: DoorSession }): InboundAdapter;
}

export interface LfInboundStores {
  store: InboundStore<DiscriminableEvent>;
  push: PushStore<PushedEvent>;
}

/** Compared as digests, so the comparison takes the same time whatever the
 *  lengths and wherever they differ. */
function sameSecret(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

function firstHeader(headers: InboundHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : value?.[0];
}

/** Which install of `external` presented its credential. Every install is
 *  compared, with no early exit. */
function authenticatePush(session: DoorSession, input: { adapterType: string; headers: InboundHeaders }): PushAuth {
  const auth = session.running.get(input.adapterType)?.external.manifest.auth;
  if (auth === undefined) return { kind: 'unauthorized' };
  const matches: Credential[] = [];
  for (const credential of session.credentials.values()) {
    if (credential.external !== input.adapterType) continue;
    const secret = credential.fields[auth.field];
    if (secret === undefined) continue;
    let matched = false;
    for (const [name, expected] of Object.entries(authHeader({ kind: auth.kind }, secret))) {
      const presented = firstHeader(input.headers, name.toLowerCase());
      if (presented !== undefined && sameSecret(presented, expected)) matched = true;
    }
    if (matched) matches.push(credential);
  }
  const [credential, ...others] = matches;
  if (credential === undefined) return { kind: 'unauthorized' };
  if (others.length > 0) return { kind: 'ambiguous' };
  return { kind: 'authenticated', caller: { teamId: LOCAL_TENANT, adapterType: input.adapterType, credentialsId: credential.name } };
}

function remoteInboundAdapter(input: { running: RunningExternal; credential: Credential; session: DoorSession }): InboundAdapter {
  const adapter = remoteAdapterOf({
    running: input.running,
    credential: input.credential,
    secrets: input.session.credentials,
    documents: input.session.documents,
    tenant: LOCAL_TENANT,
  });
  // No `listEventTypes`: lf routes by the event itself, so a delivery never
  // costs the external a second call.
  return {
    adapterType: adapter.adapterType,
    ...(adapter.preprocessInbound !== undefined ? { preprocessInbound: adapter.preprocessInbound.bind(adapter) } : {}),
    ...(adapter.wakeKeys !== undefined ? { wakeKeys: adapter.wakeKeys.bind(adapter) } : {}),
  };
}

/** lf's side of the core's two store interfaces, over the session. */
export function createLfInboundStores(session: DoorSession, options: LfInboundOptions): LfInboundStores {
  const { work } = session.runHost.store;
  const enqueueEvent =
    options.enqueueEvent ??
    (async ({ external, event }) => {
      await work.enqueue({ kind: 'fire_event', key: `fire_event:${randomUUID()}`, teamId: LOCAL_TENANT, payload: { external, event } });
    });
  const adapterOf = options.adapterOf ?? remoteInboundAdapter;
  const enqueueWakes = async (input: { adapterType: string; teamId: string; keys: readonly string[] }) => {
    for (const correlationKey of input.keys) {
      await queueAwaitWake(session.runHost.store, { adapterType: input.adapterType, teamId: input.teamId, correlationKey });
    }
  };

  const externalServing = (providerKey: string): { running: RunningExternal; setup: InboundSetup } | undefined => {
    for (const running of session.running.values()) {
      const setup = inboundSetupOf(running);
      if (setup !== undefined && providerKeyOf(setup) === providerKey) return { running, setup };
    }
    return undefined;
  };

  const store: InboundStore<DiscriminableEvent> = {
    async findSubscription(id) {
      const credential = session.credentials.get(id);
      const running = credential && session.running.get(credential.external);
      const setup = running && inboundSetupOf(running);
      if (!credential || !setup) return null;
      return {
        id,
        teamId: LOCAL_TENANT,
        providerKey: providerKeyOf(setup),
        credentialsId: credential.name,
        secret: credential.fields[setup.secretField] ?? '',
        checkpoint: session.state.inboundCheckpoint(id),
      } satisfies InboundSubscription;
    },
    knowsProvider: (providerKey) => externalServing(providerKey) !== undefined,
    intercepts: (providerKey) => externalServing(providerKey)?.setup.declaration.intercepts ?? [],
    async sourceFor(subscription) {
      const credential = session.credentials.get(subscription.id);
      const running = credential && session.running.get(credential.external);
      const setup = running && inboundSetupOf(running);
      if (!credential || !running || !setup) return null;
      return {
        // The core's one signed-inbound rule, for a manifest's `inbound` and
        // for a `webhook:` block alike (the latter is the protocol's scheme).
        verifier: declaredInboundVerifier(setup.declaration),
        secret: subscription.secret,
        open: async () => ({
          adapterType: running.external.manifest.name,
          credentialsId: credential.name,
          adapter: adapterOf({ running, credential, session }),
        }),
      };
    },
    // lf has no synthetic team: every delivery is verified.
    verifiesSignature: () => true,
    // lf keeps no receipts: the event itself is what is queued.
    capture: async ({ event }) => event,
    saveCheckpoint: async ({ subscriptionId, checkpoint }) => session.state.saveInboundCheckpoint(subscriptionId, checkpoint),
    enqueue: async ({ captured, source }) => enqueueEvent({ external: source.adapterType, event: captured }),
    enqueueWakes,
  };

  const push: PushStore<PushedEvent> = {
    authenticate: async (input) => authenticatePush(session, input),
    eventTypes: async () => [],
    capture: async ({ caller, event }) => [{ external: caller.adapterType, event }],
    enqueue: async (pushed) => {
      for (const entry of pushed) await enqueueEvent(entry);
    },
    enqueueWakes,
    notify: options.notify,
  };
  return { store, push };
}

/** What a push door receipts: the event, and the external that pushed it. */
export interface PushedEvent {
  external: string;
  event: DiscriminableEvent;
}

// ── The legacy name: /hooks/<external>/<install> ───────────────────────────

/** The door's provider segment and subscription for lf's older
 *  `/hooks/<external>[/<install>]`; the install is the external's only
 *  credential when the URL names none. Null: the external takes no webhooks. */
export function hookTarget(session: DoorSession, input: { external: string; install?: string }): Pick<InboundDelivery, 'provider' | 'subscriptionId'> | null {
  const running = session.running.get(input.external);
  const setup = running && inboundSetupOf(running);
  if (!setup) return null;
  return {
    provider: setup.declaration.providerKey,
    subscriptionId: input.install ?? installOf(session.credentials, input.external)?.name ?? '',
  };
}

/**
 * One delivery through the core with its events run inside the request, as
 * `/hooks/...` and `lf run --webhook` have always answered: the runs it
 * started come back with the answer. (The canonical door queues them instead
 * and answers `{ ok, eventsProcessed }`.)
 */
export async function deliverInline(
  session: Session,
  delivery: InboundDelivery,
  options: Pick<LfInboundOptions, 'notify' | 'adapterOf'>,
): Promise<{ answer: InboundAnswer; outcomes: RunOutcome[] }> {
  const outcomes: RunOutcome[] = [];
  const { store } = createLfInboundStores(session, {
    ...options,
    enqueueEvent: async ({ external, event }) => {
      outcomes.push(...(await fireEvent(session, { external, event })));
    },
  });
  const answer = await answerDelivery(store, { notify: options.notify }, delivery);
  return { answer, outcomes };
}

export class WebhookRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookRefused';
  }
}

/** `lf run --webhook`: a delivery taken as production takes one, its runs
 *  returned. A refusal throws. */
export async function receiveWebhook(
  session: Session,
  input: { external: string; install?: string; rawBody: Buffer; headers: InboundHeaders },
): Promise<RunOutcome[]> {
  const target = hookTarget(session, input);
  if (target === null) throw new WebhookRefused(`external "${input.external}" takes no webhooks`);
  const { answer, outcomes } = await deliverInline(session, { ...target, rawBody: input.rawBody, headers: input.headers }, { notify: () => {} });
  if (answer.status === 200) return outcomes;
  const refusal = z.object({ error: z.string() }).safeParse(answer.body);
  const code = refusal.success ? refusal.data.error : 'unreadable';
  throw new WebhookRefused(
    code === 'signature_invalid' ? `signature did not verify for external "${input.external}"` : `delivery refused: ${code} (${answer.status})`,
  );
}
