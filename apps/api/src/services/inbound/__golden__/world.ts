// The fake world every golden case runs in: a mutable description of what the
// stores and adapters behind the doors hold, and the record of what the doors
// did to them. The jest.mock factories in the replay test read from here, so a
// case is "arrange the world, send one request, compare the response and the
// effects".

import type { IncomingHttpHeaders } from 'node:http';

export interface FakeSubscription {
  id: string;
  team_id: string;
  provider: string;
  credentials_id: string | null;
  webhook_secret: string;
  external_webhook_id: string | null;
  inbound_checkpoint: unknown;
}

export interface FakeEvent {
  eventType: string;
  externalId?: string;
  idempotencyKey?: string;
  payload?: unknown;
}

export interface FakeAdapter {
  adapterType: string;
  /** Events one delivery carries; `throws` makes the adapter fail instead. */
  preprocess: (raw: unknown) => { events: FakeEvent[]; checkpoint?: unknown };
  /** Absent: the adapter has no wake door. A function that throws: a failing one. */
  wakeKeys?: (raw: unknown) => string[];
  hasPreprocess: boolean;
}

export interface FakeTrigger {
  id: string;
  movementId: string | null;
  kind: string;
  credentialsId: string | null;
  config: Record<string, unknown>;
}

export interface FakeRemoteInstall {
  adapter_type: string;
  team_id: string;
  credentials_id: string | null;
  auth_strategy: unknown;
  secret: string;
}

export interface FakeCallback {
  id: string;
  status: 'live' | 'fired' | 'revoked';
  expiresAt: Date | null;
  params: { name: string; type: string }[];
}

export interface World {
  subscriptions: Record<string, FakeSubscription>;
  adapters: Record<string, FakeAdapter>;
  triggers: FakeTrigger[];
  remoteInstalls: FakeRemoteInstall[];
  /** Per-team: does a linked_object bridge exist for the event's record. */
  bridgedLinkedObjects: boolean;
  /** Team ids the dev-loop harness bypass applies to. */
  harnessTeams: string[];
  /** How the callback router answers a fired id. */
  fireCallback: (input: { id: string; values: Record<string, unknown>; suppliedValue?: string }) => unknown;
  callbacks: Record<string, FakeCallback>;
  /** What the ask store holds, by token. */
  asks: Record<string, unknown>;
  askAnswer: (token: string, raw: unknown) => unknown;
  enqueueFails: boolean;
  captureFails: boolean;
  telegramBuiltin: (raw: unknown) => unknown;
  slackEvents: (raw: unknown) => unknown;
  whatsappSender: { teamId: string | null; displayName: string | null };
  /** Meta number → team the sender dispatch resolves to; the dispatch fake records it. */
  responseUrlPosts: boolean;
  /** Mailgun / Resend routing decision. */
  emailRoute: unknown;
  resendFetch: unknown;
  emailActingUser: unknown;
  emailTriggerLive: boolean;
}

export type Effect = Record<string, unknown>;

export const effects: Effect[] = [];

export function record(effect: Effect): void {
  effects.push(JSON.parse(JSON.stringify(effect)));
}

function defaultAdapter(adapterType: string): FakeAdapter {
  return {
    adapterType,
    hasPreprocess: true,
    preprocess: (raw) => ({
      events: [
        {
          eventType: 'inbound',
          externalId: 'rec-1',
          idempotencyKey: (raw as { event_id?: string } | null)?.event_id ?? 'delivery-1',
          payload: raw,
        },
      ],
    }),
  };
}

/** The record a fired callback hands back; only `singleUse` is read by the doors. */
export const GOLDEN_CALLBACK = { id: 'cb_golden0001', singleUse: true, status: 'fired' };

export function freshWorld(): World {
  return {
    subscriptions: {},
    adapters: {},
    triggers: [],
    remoteInstalls: [],
    bridgedLinkedObjects: false,
    harnessTeams: [],
    fireCallback: () => ({ kind: 'recorded', callback: GOLDEN_CALLBACK }),
    callbacks: {},
    asks: {},
    askAnswer: () => ({ kind: 'not_found' }),
    enqueueFails: false,
    captureFails: false,
    telegramBuiltin: () => ({ result: { ok: true, classification: 'no_message' } }),
    slackEvents: () => ({ ok: true, classification: 'dispatched', eventsProcessed: 1 }),
    whatsappSender: { teamId: 'team-1', displayName: 'Ada' },
    responseUrlPosts: true,
    emailRoute: null,
    resendFetch: null,
    emailActingUser: null,
    emailTriggerLive: true,
  };
}

export let world: World = freshWorld();

export function resetWorld(): void {
  world = freshWorld();
  effects.length = 0;
}

export function adapterFor(adapterType: string): FakeAdapter {
  return world.adapters[adapterType] ?? defaultAdapter(adapterType);
}

export type { IncomingHttpHeaders };
