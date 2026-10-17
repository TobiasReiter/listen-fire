// The inbound doors' contract suite: one set of HTTP-level cases every host's
// doors must pass — the hosted express app, `lf serve` (TypeScript and Rust).
// A case arranges a small world (one provider, one subscription, an adapter
// whose behaviour is read off the delivery itself, injected faults), sends real
// requests, and checks the answer and what the host queued.
//
// The world is plain data so a host in any language can build it. The adapter
// every case uses reads a delivery's JSON body as:
//
//   { events?: object[], wake?: string[], checkpoint?: unknown }
//
// events → one event each (payload = the object), wake → the correlation keys,
// checkpoint → the pull cursor to save. A captured event counts once (one
// matching trigger per event).
//
// Runner-agnostic: each case is a name and an async body that throws on
// failure (node:assert), so jest and node:test both wrap the same list.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import type { DiscriminableEvent } from '../translation_graph/adapter';
import type {
  DeliveryHost,
  InboundIntercept,
  InboundStore,
  InboundSubscription,
  QueuedDelivery,
} from './deliver';
import type { PushStore } from './push';
import type { InboundSignatureScheme } from './verify';

import { firstPresentHeader } from './verify';

export const CONTRACT_PROVIDER_KEY = 'CONTRACT_CRM';
export const CONTRACT_SLACK_KEY = 'CONTRACT_SLACK';
export const CONTRACT_PUSH_TYPE = 'contract-push';

export interface ContractProvider {
  providerKey: string;
  scheme: InboundSignatureScheme;
  signatureHeaders: string[];
  intercepts?: InboundIntercept[];
}

export interface ContractWorld {
  /** The providers the host serves itself. */
  providers: ContractProvider[];
  subscriptions: { id: string; teamId: string; providerKey: string; secret: string }[];
  /** Installs the push doors authenticate against: `authorization: Bearer <credential>`. */
  pushInstalls: { teamId: string; adapterType: string; credential: string }[];
  faults: {
    /** Capturing the event whose payload has `fail: true` throws. */
    captureMarked?: boolean;
    /** Queueing any captured event throws. */
    enqueue?: boolean;
    /** The adapter's wakeKeys throws. */
    wakeKeys?: boolean;
    /** Queueing the wakes throws. */
    enqueueWakes?: boolean;
  };
  /** The subscription's deliveries are synthetic: no signature check, drained before the ack. */
  synthetic?: boolean;
}

/** What the host did since the world was arranged. */
export interface ContractObservations {
  captured: number;
  enqueued: number;
  wakes: string[];
  checkpoints: unknown[];
  notified: number;
}

export interface InboundContractBackend {
  /** Where the doors are served: `${baseUrl}/api/public/webhook-sync/…`, `${baseUrl}/api/public/adapter/…`. */
  baseUrl: string;
  arrange(world: ContractWorld): Promise<void>;
  observed(): Promise<ContractObservations>;
}

export interface InboundContractCase {
  name: string;
  run(backend: InboundContractBackend): Promise<void>;
}

const SECRET = 'contract-secret';
const TEAM = 'team-contract';

const CRM: ContractProvider = {
  providerKey: CONTRACT_PROVIDER_KEY,
  scheme: 'hmac_sha256_hex',
  signatureHeaders: ['x-crm-signature', 'x-crm-signature-legacy'],
};
const SLACK: ContractProvider = {
  providerKey: CONTRACT_SLACK_KEY,
  scheme: 'slack_v0',
  signatureHeaders: ['x-slack-signature'],
  intercepts: ['slack_url_verification'],
};

function world(overrides: Partial<ContractWorld> = {}): ContractWorld {
  return {
    providers: [CRM, SLACK],
    subscriptions: [
      { id: 'sub-crm', teamId: TEAM, providerKey: CONTRACT_PROVIDER_KEY, secret: SECRET },
      { id: 'sub-slack', teamId: TEAM, providerKey: CONTRACT_SLACK_KEY, secret: SECRET },
    ],
    pushInstalls: [{ teamId: TEAM, adapterType: CONTRACT_PUSH_TYPE, credential: 'push-credential' }],
    faults: {},
    ...overrides,
  };
}

const hex = (body: Buffer, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');
const crmSigned = (body: Buffer, secret = SECRET) => ({ 'x-crm-signature': `sha256=${hex(body, secret)}` });

interface Answer {
  status: number;
  contentType: string | null;
  body: unknown;
}

async function post(
  backend: InboundContractBackend,
  path: string,
  body: Buffer,
  headers: (raw: Buffer) => Record<string, string> = () => ({}),
): Promise<Answer> {
  const response = await fetch(`${backend.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers(body) },
    body,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON: compared as text
  }
  return { status: response.status, contentType: response.headers.get('content-type'), body: parsed };
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf-8');
const door = (provider: string, subscription: string) => `/api/public/webhook-sync/${provider}/${subscription}`;
const CRM_DOOR = door('contract_crm', 'sub-crm');

const TWO_EVENTS = { events: [{ n: 1 }, { n: 2 }] };

async function arrangeAnd(backend: InboundContractBackend, overrides: Partial<ContractWorld> = {}): Promise<void> {
  await backend.arrange(world(overrides));
}

export const INBOUND_CONTRACT_CASES: InboundContractCase[] = [
  {
    name: 'a delivery signed in its declared header is captured, queued and acked',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, CRM_DOOR, json(TWO_EVENTS), crmSigned);
      assert.deepEqual([answer.status, answer.body], [200, { ok: true, eventsProcessed: 2 }]);
      const seen = await backend.observed();
      assert.deepEqual([seen.captured, seen.enqueued, seen.notified], [2, 2, 1]);
    },
  },
  {
    name: 'the provider segment is matched case-insensitively',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, door('CONTRACT_CRM', 'sub-crm'), json(TWO_EVENTS), crmSigned);
      assert.equal(answer.status, 200);
    },
  },
  {
    name: 'a bad signature is refused 401 and nothing is captured',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, CRM_DOOR, json(TWO_EVENTS), (body) => crmSigned(body, 'not-the-secret'));
      assert.deepEqual([answer.status, answer.body], [401, { error: 'signature_invalid' }]);
      assert.equal((await backend.observed()).captured, 0);
    },
  },
  {
    name: 'no signature is refused 401',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, CRM_DOOR, json(TWO_EVENTS));
      assert.deepEqual([answer.status, answer.body], [401, { error: 'signature_invalid' }]);
    },
  },
  {
    name: 'the first declared header present decides, even when a later one is right',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, CRM_DOOR, json(TWO_EVENTS), (body) => ({
        'x-crm-signature': 'sha256=' + 'b'.repeat(64),
        'x-crm-signature-legacy': `sha256=${hex(body)}`,
      }));
      assert.equal(answer.status, 401);
    },
  },
  {
    name: 'a later declared header carries the signature when the first is absent',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, CRM_DOOR, json(TWO_EVENTS), (body) => ({
        'x-crm-signature-legacy': `sha256=${hex(body)}`,
      }));
      assert.equal(answer.status, 200);
    },
  },
  {
    name: 'a header the provider does not declare never shadows its signature',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, CRM_DOOR, json(TWO_EVENTS), (body) => ({
        'x-listen-fire-signature': 'c'.repeat(64),
        ...crmSigned(body),
      }));
      assert.equal(answer.status, 200);
    },
  },
  {
    name: 'a subscription nobody has, for a provider nobody serves, is 404 unknown_provider',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, door('nope', 'missing'), json(TWO_EVENTS));
      assert.deepEqual([answer.status, answer.body], [404, { error: 'unknown_provider' }]);
    },
  },
  {
    name: 'a missing subscription of a served provider is 404 subscription_not_found',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, door('contract_crm', 'missing'), json(TWO_EVENTS), crmSigned);
      assert.deepEqual([answer.status, answer.body], [404, { error: 'subscription_not_found' }]);
    },
  },
  {
    name: "a subscription addressed under another provider's segment is 400 provider_mismatch",
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, door('contract_slack', 'sub-crm'), json(TWO_EVENTS), crmSigned);
      assert.deepEqual([answer.status, answer.body], [400, { error: 'provider_mismatch' }]);
    },
  },
  {
    name: "a body over 100 KB is refused 413 in the doors' JSON shape",
    async run(backend) {
      await arrangeAnd(backend);
      const big = json({ events: [], pad: 'x'.repeat(120_000) });
      const answer = await post(backend, CRM_DOOR, big, crmSigned);
      assert.equal(answer.status, 413);
      assert.match(answer.contentType ?? '', /application\/json/);
      assert.deepEqual(answer.body, { error: 'payload_too_large' });
    },
  },
  {
    name: 'a correctly signed body that is not JSON is a 500',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, CRM_DOOR, Buffer.from('not json', 'utf-8'), crmSigned);
      assert.deepEqual([answer.status, answer.body], [500, { error: 'internal' }]);
    },
  },
  {
    name: 'a delivery with nothing to run is acked with zero events and queues nothing',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, CRM_DOOR, json({}), crmSigned);
      assert.deepEqual([answer.status, answer.body], [200, { ok: true, eventsProcessed: 0 }]);
      const seen = await backend.observed();
      assert.deepEqual([seen.enqueued, seen.wakes], [0, []]);
    },
  },
  {
    name: 'wake keys are queued whether or not any event came with them',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, CRM_DOOR, json({ wake: ['thread:1', 'thread:2'] }), crmSigned);
      assert.deepEqual([answer.status, answer.body], [200, { ok: true, eventsProcessed: 0 }]);
      assert.deepEqual((await backend.observed()).wakes, ['thread:1', 'thread:2']);
    },
  },
  {
    name: 'an event whose receipt cannot be stored is dropped from the count; the rest are acked',
    async run(backend) {
      await arrangeAnd(backend, { faults: { captureMarked: true } });
      const answer = await post(backend, CRM_DOOR, json({ events: [{ n: 1, fail: true }, { n: 2 }] }), crmSigned);
      assert.deepEqual([answer.status, answer.body], [200, { ok: true, eventsProcessed: 1 }]);
      assert.equal((await backend.observed()).enqueued, 1);
    },
  },
  {
    name: 'a receipt that cannot be queued is a 500 so the sender retries; the wakes still go in',
    async run(backend) {
      await arrangeAnd(backend, { faults: { enqueue: true } });
      const answer = await post(backend, CRM_DOOR, json({ ...TWO_EVENTS, wake: ['thread:1'] }), crmSigned);
      assert.deepEqual([answer.status, answer.body], [500, { error: 'internal' }]);
      const seen = await backend.observed();
      assert.deepEqual([seen.enqueued, seen.wakes, seen.notified], [0, ['thread:1'], 0]);
    },
  },
  {
    name: 'a wake door that fails is a 500 after the events are queued',
    async run(backend) {
      await arrangeAnd(backend, { faults: { wakeKeys: true } });
      const answer = await post(backend, CRM_DOOR, json(TWO_EVENTS), crmSigned);
      assert.equal(answer.status, 500);
      assert.equal((await backend.observed()).enqueued, 2);
    },
  },
  {
    name: 'wakes that cannot be queued are a 500',
    async run(backend) {
      await arrangeAnd(backend, { faults: { enqueueWakes: true } });
      const answer = await post(backend, CRM_DOOR, json({ wake: ['thread:1'] }), crmSigned);
      assert.equal(answer.status, 500);
    },
  },
  {
    name: 'a pull cursor the adapter returns is saved before the ack',
    async run(backend) {
      await arrangeAnd(backend);
      await post(backend, CRM_DOOR, json({ ...TWO_EVENTS, checkpoint: { cursor: 'c-2' } }), crmSigned);
      assert.deepEqual((await backend.observed()).checkpoints, [{ cursor: 'c-2' }]);
    },
  },
  {
    name: "Slack's url_verification is answered unsigned, before any lookup",
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, door('contract_slack', 'no-such-row'), json({ type: 'url_verification', challenge: 'ch-1' }));
      assert.deepEqual([answer.status, answer.body], [200, { challenge: 'ch-1' }]);
      const missing = await post(backend, door('contract_slack', 'no-such-row'), json({ type: 'url_verification' }));
      assert.deepEqual([missing.status, missing.body], [400, { error: 'missing_challenge' }]);
    },
  },
  {
    name: 'only a provider that declares the intercept answers it',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, CRM_DOOR, json({ type: 'url_verification', challenge: 'ch-1' }));
      assert.equal(answer.status, 401);
    },
  },
  {
    name: 'a slack_v0 delivery verifies over its timestamp and body',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, door('contract_slack', 'sub-slack'), json(TWO_EVENTS), (body) => {
        const timestamp = '1700000000';
        const signature = createHmac('sha256', SECRET).update(`v0:${timestamp}:${body.toString('utf-8')}`).digest('hex');
        return { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${signature}` };
      });
      assert.deepEqual([answer.status, answer.body], [200, { ok: true, eventsProcessed: 2 }]);
    },
  },
  {
    name: 'a synthetic subscription skips the signature and drains before the ack',
    async run(backend) {
      await arrangeAnd(backend, { synthetic: true });
      const answer = await post(backend, CRM_DOOR, json(TWO_EVENTS));
      assert.deepEqual([answer.status, answer.body], [200, { ok: true, eventsProcessed: 2 }]);
      assert.equal((await backend.observed()).notified, 0);
    },
  },

  // ── The push doors ──────────────────────────────────────────────────────
  {
    name: "a push body over 1 MB is refused 413 in the doors' JSON shape, whichever door",
    async run(backend) {
      await arrangeAnd(backend);
      for (const verb of ['emit', 'wake']) {
        const big = json({ keys: [], events: [], pad: 'x'.repeat(1_100_000) });
        const answer = await post(backend, `/api/public/adapter/${CONTRACT_PUSH_TYPE}/${verb}`, big, () => ({
          authorization: 'Bearer push-credential',
        }));
        assert.equal(answer.status, 413);
        assert.match(answer.contentType ?? '', /application\/json/);
        assert.deepEqual(answer.body, { error: 'payload_too_large' });
      }
    },
  },
  {
    name: 'emit with the install credential receipts the events: 202 accepted',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, `/api/public/adapter/${CONTRACT_PUSH_TYPE}/emit`, json({ events: [{ payload: { n: 1 } }] }), () => ({
        authorization: 'Bearer push-credential',
      }));
      assert.deepEqual([answer.status, answer.body], [202, { accepted: 1 }]);
      const seen = await backend.observed();
      assert.deepEqual([seen.enqueued, seen.notified], [1, 1]);
    },
  },
  {
    name: 'emit with a credential no install holds is 401, whatever the body',
    async run(backend) {
      await arrangeAnd(backend);
      for (const body of [{ events: [{ payload: {} }] }, { events: [] }, { nonsense: true }]) {
        const answer = await post(backend, `/api/public/adapter/${CONTRACT_PUSH_TYPE}/emit`, json(body), () => ({
          authorization: 'Bearer wrong',
        }));
        assert.deepEqual([answer.status, answer.body], [401, { error: 'unauthorized' }]);
      }
    },
  },
  {
    name: 'emit with a credential two teams hold, and no team named, is 409',
    async run(backend) {
      await arrangeAnd(backend, {
        pushInstalls: [
          { teamId: 'team-a', adapterType: CONTRACT_PUSH_TYPE, credential: 'shared' },
          { teamId: 'team-b', adapterType: CONTRACT_PUSH_TYPE, credential: 'shared' },
        ],
      });
      const answer = await post(backend, `/api/public/adapter/${CONTRACT_PUSH_TYPE}/emit`, json({ events: [{ payload: {} }] }), () => ({
        authorization: 'Bearer shared',
      }));
      assert.equal(answer.status, 409);
      assert.equal((answer.body as { error?: unknown }).error, 'ambiguous_credential');
    },
  },
  {
    name: 'a malformed emit body is judged only after authentication: 400',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, `/api/public/adapter/${CONTRACT_PUSH_TYPE}/emit`, json({ events: [] }), () => ({
        authorization: 'Bearer push-credential',
      }));
      assert.equal(answer.status, 400);
      assert.equal((answer.body as { error?: unknown }).error, 'bad_request');
    },
  },
  {
    name: 'wake queues one wake per key: 202 accepted',
    async run(backend) {
      await arrangeAnd(backend);
      const answer = await post(backend, `/api/public/adapter/${CONTRACT_PUSH_TYPE}/wake`, json({ keys: ['k1', 'k2'] }), () => ({
        authorization: 'Bearer push-credential',
      }));
      assert.deepEqual([answer.status, answer.body], [202, { accepted: 2 }]);
      assert.deepEqual((await backend.observed()).wakes, ['k1', 'k2']);
    },
  },
];

// ── A reference backend's stores, in memory ───────────────────────────────

/** The world as an InboundStore + PushStore, for hosts whose doors are
 *  wired to injected stores (the express runner); a host with its own
 *  storage arranges the same world in it instead. */
export function memoryInboundStores(arranged: ContractWorld): {
  store: InboundStore<DiscriminableEvent>;
  host: DeliveryHost<DiscriminableEvent>;
  push: PushStore<DiscriminableEvent>;
  observed(): ContractObservations;
} {
  const seen: ContractObservations = { captured: 0, enqueued: 0, wakes: [], checkpoints: [], notified: 0 };
  const providers = new Map(arranged.providers.map((p) => [p.providerKey, p]));
  const { faults } = arranged;

  const enqueueWakes = async (input: { keys: readonly string[] }) => {
    if (faults.enqueueWakes) throw new Error('wake queue unavailable');
    seen.wakes.push(...input.keys);
  };

  const store: InboundStore<DiscriminableEvent> = {
    async findSubscription(id) {
      const row = arranged.subscriptions.find((s) => s.id === id);
      return row ? ({ ...row, credentialsId: 'credential', checkpoint: null } satisfies InboundSubscription) : null;
    },
    knowsProvider: (key) => providers.has(key),
    intercepts: (key) => providers.get(key)?.intercepts ?? [],
    async sourceFor(subscription) {
      const provider = providers.get(subscription.providerKey);
      if (!provider) return null;
      return {
        verifier: { scheme: provider.scheme, signatureHeaders: provider.signatureHeaders },
        secret: subscription.secret,
        async open() {
          return {
            adapterType: provider.providerKey.toLowerCase(),
            credentialsId: 'credential',
            adapter: {
              adapterType: provider.providerKey.toLowerCase(),
              async preprocessInbound({ raw }) {
                const body = raw as { events?: Record<string, unknown>[]; checkpoint?: unknown };
                return {
                  events: (body.events ?? []).map((payload) => ({ payload })),
                  ...(body.checkpoint !== undefined ? { checkpoint: body.checkpoint } : {}),
                };
              },
              async wakeKeys({ raw }) {
                if (faults.wakeKeys) throw new Error('wake door down');
                return (raw as { wake?: string[] }).wake ?? [];
              },
            },
          };
        },
      };
    },
    verifiesSignature: () => !arranged.synthetic,
    async capture({ event }) {
      if (faults.captureMarked && (event.payload as { fail?: unknown } | undefined)?.fail === true) {
        throw new Error('receipt store unavailable');
      }
      seen.captured += 1;
      return event;
    },
    async saveCheckpoint({ checkpoint }) {
      seen.checkpoints.push(checkpoint);
    },
    async enqueue() {
      if (faults.enqueue) throw new Error('work table unavailable');
      seen.enqueued += 1;
    },
    enqueueWakes,
  };

  const host: DeliveryHost<DiscriminableEvent> = {
    notify: () => {
      seen.notified += 1;
    },
    async drainBeforeAck(queue: () => Promise<QueuedDelivery<DiscriminableEvent>>) {
      const queued = await queue();
      return { eventsProcessed: queued.enqueued.length, perEventErrors: queued.captureErrors };
    },
  };

  const push: PushStore<DiscriminableEvent> = {
    async authenticate({ adapterType, headers }) {
      const presented = firstPresentHeader(headers, ['authorization']);
      const team = firstPresentHeader(headers, ['x-listen-fire-team']);
      const matches = arranged.pushInstalls.filter(
        (install) =>
          install.adapterType === adapterType &&
          presented === `Bearer ${install.credential}` &&
          (team === '' || install.teamId === team),
      );
      const [only, ...others] = matches;
      if (!only) return { kind: 'unauthorized' };
      if (others.length > 0) return { kind: 'ambiguous' };
      return { kind: 'authenticated', caller: { teamId: only.teamId, adapterType, credentialsId: only.credential } };
    },
    eventTypes: async () => [],
    async capture({ event }) {
      seen.captured += 1;
      return [event];
    },
    async enqueue(captured) {
      seen.enqueued += captured.length;
    },
    enqueueWakes,
    notify: () => {
      seen.notified += 1;
    },
  };

  return { store, host, push, observed: () => ({ ...seen, wakes: [...seen.wakes], checkpoints: [...seen.checkpoints] }) };
}
