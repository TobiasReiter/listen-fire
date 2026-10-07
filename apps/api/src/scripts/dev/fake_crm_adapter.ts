// A minimal, in-process "homespun CRM" adapter used to VERIFY the remote-adapter
// subsystem end-to-end without any real third-party system. It stands in for a
// user-supplied remote adapter: it implements the same in-process `Adapter`
// interface every built-in speaks, and `startFakeCrmServer` mounts it behind
// the wire protocol (`createAdapterProtocolHandler`) on an HTTP server, exactly
// as a third-party adapter server would. It runs two ways: ephemeral (port 0)
// for a self-contained test, and on the profile-assigned `FAKE_REMOTE_ADAPTER_PORT`
// as a DURABLE dev-loop fixture (`pnpm dev:fake-crm`, booted by `dev/loop.sh`),
// which is what lets the installed `acme_crm` row stay true between runs.
//
// The CRM has ONE writable record type — `Company` (natural fields `Name`,
// `Description`) — and records every write into an in-memory array so a test
// (or the `dev:remote-verify` harness) can assert the write actually landed on
// the other side of the wire.
//
// It also speaks the inbound half: a subscription (ensure/remove), a webhook body
// (`FakeCrmDelivery`) it turns into events (preprocessInbound) and wake keys
// (wakeKeys, one per thread comment), and the event-type union for them.
//
// The descriptor shapes mirror a real hardcoded writable adapter (see
// `adapters/native_valuations.ts`, whose `commonFields()` / per-type descriptors
// are the template), with `displayName === fieldId`.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { randomUUID } from 'node:crypto';

import type {
  Adapter,
  DeleteInput,
  DeleteResult,
  DiscriminableEvent,
  EnsureEventSubscriptionInput,
  EventSubscriptionRegistration,
  EventType,
  RemoveEventSubscriptionInput,
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
  ResolveEntityInput,
  ResolveEntityResult,
  RuntimeCapabilities,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from '../../services/translation_graph/adapter';
import { BASE_RUNTIME_CAPABILITIES, containerAssociation } from '../../services/translation_graph/adapter';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
} from '../../services/translation_graph/types';
import { positionData } from '../../services/translation_graph/types';
import { createAdapterProtocolHandler } from '../../services/translation_graph/protocol/server';
import type { RemoteAdapterManifestFile } from '../../services/translation_graph/adapters/remote/manifest';

/** Slug the engine routes on — the `acme_crm` in `import { acme_crm } from adapters`. */
export const FAKE_CRM_ADAPTER_TYPE = 'acme_crm';
/** The single writable record type this CRM exposes. */
export const FAKE_CRM_COMPANY_TYPE = 'Company';
/** Name the install (and its minted REMOTE credential) carries. */
export const FAKE_CRM_DISPLAY_NAME = 'Acme CRM';

/**
 * The bearer secret the fake CRM authenticates against. One constant shared by
 * everything that stands it up (the dev-loop fixture server, `dev:seed`'s
 * install, `dev:remote-verify`) — the install mints it into an encrypted
 * `REMOTE` credential whose decrypted `{ secret }` is what `authHeader` sends,
 * so a drift between server and install reads as a 401 at describe time.
 */
export const FAKE_CRM_SECRET = 'dev-loop-acme-crm-secret';

/**
 * The port the DURABLE dev-loop fixture binds. Profile-assigned, exactly like
 * `FAKE_CHANNELS_PORT` — `dev/loop.sh` exports it (harness base + 2) and
 * records it in `.dev-loop/profiles/<profile>.json`, so the agent stack and
 * a local stack never collide. Absent (no loop booted), it falls back to the
 * default profile's slot so a bare `pnpm dev:fake-crm` still has a home.
 */
export function fakeCrmPort(): number {
  const fromEnv = process.env.FAKE_REMOTE_ADAPTER_PORT;
  return fromEnv ? Number(fromEnv) : 5557;
}

/** Base URL of the durable fixture for the active profile. */
export function fakeCrmBaseUrl(): string {
  return process.env.FAKE_REMOTE_ADAPTER_URL ?? `http://127.0.0.1:${fakeCrmPort()}/`;
}

/**
 * The install manifest for the fake CRM at `baseUrl`. Shared by the dev-loop
 * seed (which installs it against the durable fixture) and `dev:remote-verify`
 * (which installs it against its own ephemeral server), so the two can never
 * describe the same adapter differently.
 */
export function fakeCrmManifest(baseUrl: string): Omit<RemoteAdapterManifestFile, 'credentialsId'> {
  return {
    protocolVersion: 2,
    adapterType: FAKE_CRM_ADAPTER_TYPE,
    displayName: FAKE_CRM_DISPLAY_NAME,
    description: 'A homespun CRM installed as a remote adapter for e2e verification.',
    baseUrl,
    authStrategy: { kind: 'bearer' },
    supportedTriggers: ['webhook'],
    runtimeCapabilities: {
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    },
    // The methods the fake CRM genuinely implements — `createRecord` makes it
    // a valid write target.
    methods: [
      'listEntryPoints',
      'describe',
      'resolveEntity',
      'getFieldValue',
      'getRelated',
      'createRecord',
      'updateRecord',
      'deleteRecord',
      'preprocessInbound',
      'listEventTypes',
      'wakeKeys',
      'ensureEventSubscription',
      'removeEventSubscription',
    ],
  };
}

/** The one event the CRM emits: a company was created. */
export const FAKE_CRM_COMPANY_CREATED = 'company.created';

/**
 * The CRM's own webhook body (what it POSTs to a subscription's callback URL):
 * created companies, and comments on threads. A comment wakes whatever is
 * parked on its thread (`thread:<id>`).
 */
export interface FakeCrmDelivery {
  companies?: Array<{ id: string; Name: string }>;
  comments?: Array<{ thread: string; text: string }>;
}

export function fakeCrmThreadKey(thread: string): string {
  return `thread:${thread}`;
}

function deliveryOf(raw: unknown): FakeCrmDelivery {
  return raw !== null && typeof raw === 'object' ? (raw as FakeCrmDelivery) : {};
}

/** A subscription the CRM holds: where it POSTs, and the secret it signs with. */
export interface FakeCrmSubscription {
  externalId: string;
  callbackUrl: string;
  events: string[];
  secret: string;
}

/** The `Company` type descriptor: a writable `Name` (required) + `Description`
 *  (optional). */
const COMPANY_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: FAKE_CRM_COMPANY_TYPE,
  displayName: FAKE_CRM_COMPANY_TYPE,
  fields: [
    { fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: true },
    { fieldId: 'Description', displayName: 'Description', kind: 'string', writable: true, required: false },
  ],
  references: [],
};

/** One record the fake CRM "persisted" — the id it minted plus the field bag
 *  the write carried. */
export interface FakeCrmWrite {
  externalId: string;
  fields: Record<string, unknown>;
}

/** The in-process adapter plus its own write and subscription ledgers, exposed
 *  for assertions. */
export type FakeCrmAdapter = Adapter & {
  readonly writes: FakeCrmWrite[];
  readonly subscriptions: FakeCrmSubscription[];
};

/**
 * Build an in-process fake-CRM `Adapter`. Its `createRecord` / `updateRecord` /
 * `deleteRecord` mutate the returned `writes` array (a getter for assertions);
 * every other method is the minimal honest implementation the protocol needs.
 */
export function createFakeCrmAdapter(): FakeCrmAdapter {
  const writes: FakeCrmWrite[] = [];
  const subscriptions: FakeCrmSubscription[] = [];
  let seq = 0;

  const adapter: FakeCrmAdapter = {
    writes,
    subscriptions,
    adapterType: FAKE_CRM_ADAPTER_TYPE,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: (): RuntimeCapabilities => BASE_RUNTIME_CAPABILITIES,

    async listEntryPoints(): Promise<SchemaEntryPoint[]> {
      // Write-only target: offered as a writable entry, not a readable source.
      return [
        {
          typeId: FAKE_CRM_COMPANY_TYPE,
          displayName: FAKE_CRM_COMPANY_TYPE,
          scope: 'self-configured',
          writable: true,
          readable: false,
        },
      ];
    },

    async describe(typeId: string): Promise<SchemaTypeDescriptor | null> {
      return typeId === FAKE_CRM_COMPANY_TYPE ? COMPANY_DESCRIPTOR : null;
    },

    // No native identity model — the engine falls through to create.
    async resolveEntity(_input: ResolveEntityInput): Promise<ResolveEntityResult> {
      return { candidates: [] };
    },

    async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
      const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
      return data[input.fieldId] ?? null;
    },

    // Write-only CRM: nothing to traverse.
    async getRelated(_input: GetRelatedInput): Promise<RelatedResult[]> {
      return [];
    },

    async createRecord(input: WriteInput): Promise<WriteResult> {
      const externalId = `company-${++seq}`;
      writes.push({ externalId, fields: { ...input.fields } });
      return {
        adapterType: FAKE_CRM_ADAPTER_TYPE,
        externalId,
        recordType: input.recordType,
        data: { ...input.fields },
      };
    },

    async updateRecord(input: UpdateInput): Promise<UpdateResult> {
      const existing = writes.find((w) => w.externalId === input.externalId);
      if (!existing) return { notFound: true };
      existing.fields = { ...existing.fields, ...input.fields };
      return {
        adapterType: FAKE_CRM_ADAPTER_TYPE,
        externalId: input.externalId,
        recordType: input.recordType,
        data: { ...existing.fields },
        association: containerAssociation(input),
      };
    },

    async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
      const i = writes.findIndex((w) => w.externalId === input.externalId);
      if (i >= 0) writes.splice(i, 1);
      return {};
    },

    async preprocessInbound(input: { raw: unknown }): Promise<{ events: DiscriminableEvent[] }> {
      return {
        events: (deliveryOf(input.raw).companies ?? []).map((company) => ({
          payload: company,
          externalId: company.id,
          tag: FAKE_CRM_COMPANY_CREATED,
          eventType: FAKE_CRM_COMPANY_CREATED,
          changeType: 'create',
          recordType: FAKE_CRM_COMPANY_TYPE,
        })),
      };
    },

    async listEventTypes(): Promise<EventType[]> {
      return [{ tag: FAKE_CRM_COMPANY_CREATED, positionType: FAKE_CRM_COMPANY_TYPE }];
    },

    async wakeKeys(input: { raw: unknown }): Promise<string[]> {
      return (deliveryOf(input.raw).comments ?? []).map((comment) => fakeCrmThreadKey(comment.thread));
    },

    async ensureEventSubscription(
      input: EnsureEventSubscriptionInput,
    ): Promise<EventSubscriptionRegistration> {
      const existing = subscriptions.find((sub) => sub.callbackUrl === input.callbackUrl);
      if (existing) {
        existing.events = [...input.events];
        return { externalId: existing.externalId, secret: existing.secret };
      }
      const subscription: FakeCrmSubscription = {
        externalId: `crm-sub-${subscriptions.length + 1}`,
        callbackUrl: input.callbackUrl,
        events: [...input.events],
        secret: randomUUID(),
      };
      subscriptions.push(subscription);
      return { externalId: subscription.externalId, secret: subscription.secret };
    },

    async removeEventSubscription(input: RemoveEventSubscriptionInput): Promise<void> {
      const i = subscriptions.findIndex((sub) => sub.callbackUrl === input.callbackUrl);
      if (i >= 0) subscriptions.splice(i, 1);
    },
  };

  return adapter;
}

/** A running fake-CRM protocol server — its base URL, the live write ledger,
 *  and a graceful close. */
export interface FakeCrmServer {
  baseUrl: string;
  /** The backing adapter's write ledger — assert the Company landed here. */
  writes: FakeCrmWrite[];
  /** The subscriptions the host registered — where (and with what secret) the
   *  CRM would deliver its webhooks. */
  subscriptions: FakeCrmSubscription[];
  close: () => Promise<void>;
}

/**
 * Mount a fresh fake-CRM adapter behind the wire protocol on an `http.Server`,
 * bearer-authenticated against `secret`. This is the out-of-process shape a
 * real user-supplied remote adapter takes; a `RemoteAdapter` built from the
 * served manifest drives it over real HTTP.
 *
 * `port` defaults to 0 (ephemeral) — the shape a self-contained test wants,
 * where the server's lifetime IS the caller's. The durable dev-loop fixture
 * passes the profile-assigned port so the installed `remote_adapter` row can
 * name a URL that stays true after the process that installed it exits.
 */
export async function startFakeCrmServer(options: {
  secret: string;
  port?: number;
}): Promise<FakeCrmServer> {
  const { secret, port: requestedPort = 0 } = options;
  const adapter = createFakeCrmAdapter();

  const handler = createAdapterProtocolHandler({
    adapter,
    authenticate: (headers) => headers['authorization'] === `Bearer ${secret}`,
  });

  const server = http.createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve) => server.listen(requestedPort, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    writes: adapter.writes,
    subscriptions: adapter.subscriptions,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
