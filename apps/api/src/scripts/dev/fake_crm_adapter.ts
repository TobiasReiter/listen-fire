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
// the other side of the wire. Each Company has a comment thread (`Comments`, to
// `Comment { Text }`), awaitable: `await FIRST(c-[:Comments]->)` parks until a
// comment exists, keyed on the company's thread.
//
// It is the reference protocol-v2 adapter (docs/contracts/adapter-protocol.md), so it
// speaks every inbound route a third party has:
//   - the host's webhook door: a subscription (ensure/remove) and a webhook
//     body (`FakeCrmDelivery`) it turns into events (preprocessInbound) and
//     wake keys (wakeKeys, one per thread comment);
//   - the two push doors: its dev control routes (`/dev/companies`,
//     `/dev/comments`) change the CRM the way a user would and then push
//     `emit` / `wake` to the host themselves.
//
// The descriptor shapes mirror a real hardcoded writable adapter (see
// `adapters/native_valuations.ts`, whose `commonFields()` / per-type descriptors
// are the template), with `displayName === fieldId`.

import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

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
  RelatedPage,
  RelatedResult,
  ResolveEntityInput,
  ResolveEntityResult,
  RuntimeCapabilities,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from '../../services/translation_graph/adapter';
import type { AwaitPoint, AwaitResolution } from '../../services/translation_graph/awaitable';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
} from '../../services/translation_graph/types';
import type { RemoteAdapterManifestFile } from '../../services/translation_graph/adapters/remote/manifest';

import { BASE_RUNTIME_CAPABILITIES, containerAssociation } from '../../services/translation_graph/adapter';
import { META_RECORD_TYPE, makeStablePosition, positionData } from '../../services/translation_graph/types';
import { AdapterBadRequestError, createAdapterProtocolHandler } from '../../services/translation_graph/protocol/server';


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
      'iterateRelatedPage',
      'createRecord',
      'updateRecord',
      'deleteRecord',
      'preprocessInbound',
      'listEventTypes',
      'wakeKeys',
      'resolveAwait',
      'ensureEventSubscription',
      'removeEventSubscription',
    ],
  };
}

/** Companies per traversal page — small, so paging is exercised. */
export const FAKE_CRM_PAGE_SIZE = 2;

/** The offset a page cursor names — absent on the first page. The CRM mints
 *  only non-negative integer offsets; anything else did not come from it. */
function fakeCrmPageOffset(cursor: unknown): number {
  if (cursor === undefined || cursor === null) return 0;
  if (typeof cursor === 'number' && Number.isInteger(cursor) && cursor >= 0) return cursor;
  throw new AdapterBadRequestError(`fake CRM: unrecognised page cursor ${JSON.stringify(cursor)}.`);
}

/** The one event the CRM emits: a company was created. */
export const FAKE_CRM_COMPANY_CREATED = 'company.created';

/** A company's comment thread — the awaitable edge, and the type it lands. */
export const FAKE_CRM_COMMENTS_EDGE = 'Comments';
export const FAKE_CRM_COMMENT_TYPE = 'Comment';

/**
 * The CRM's own webhook body (what it POSTs to a subscription's callback URL):
 * created companies, and comments on threads. A thread is a company's id; a
 * comment wakes whatever is parked on it (`thread:<company id>`).
 */
export const FakeCrmDelivery = z.object({
  companies: z.array(z.object({ id: z.string(), Name: z.string() })).optional(),
  comments: z.array(z.object({ thread: z.string(), text: z.string() })).optional(),
});
export type FakeCrmDelivery = z.infer<typeof FakeCrmDelivery>;

export function fakeCrmThreadKey(thread: string): string {
  return `thread:${thread}`;
}

/** The fields a position carries: what `createRecord` echoed back, or a
 *  comment's `Text`. Anything else carries no fields. */
const PositionFields = z.record(z.string(), z.unknown());

/** A body that is not the CRM's own delivery is refused, not read as empty:
 *  the host should hear that it handed over something this adapter never sent. */
function deliveryOf(raw: unknown): FakeCrmDelivery {
  const parsed = FakeCrmDelivery.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`fake CRM: not a delivery this CRM sends (${parsed.error.issues[0]?.message ?? 'invalid'}).`);
  }
  return parsed.data;
}

/** The event a created company is announced as — on the host door and on `emit`. */
function companyCreatedEvent(company: { id: string; Name: string }): DiscriminableEvent {
  return {
    payload: company,
    externalId: company.id,
    tag: FAKE_CRM_COMPANY_CREATED,
    eventType: FAKE_CRM_COMPANY_CREATED,
    changeType: 'create',
    recordType: FAKE_CRM_COMPANY_TYPE,
  };
}

/** A subscription the CRM holds: where it POSTs, and the secret it signs with. */
export interface FakeCrmSubscription {
  externalId: string;
  callbackUrl: string;
  events: string[];
  secret: string;
}

/** The `Company` type descriptor: a writable `Name` (required) + `Description`
 *  (optional), and its comment thread. */
const COMPANY_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: FAKE_CRM_COMPANY_TYPE,
  displayName: FAKE_CRM_COMPANY_TYPE,
  fields: [
    { fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: true },
    { fieldId: 'Description', displayName: 'Description', kind: 'string', writable: true, required: false },
  ],
  references: [
    {
      fieldId: FAKE_CRM_COMMENTS_EDGE,
      name: FAKE_CRM_COMMENTS_EDGE,
      targetTypeId: FAKE_CRM_COMMENT_TYPE,
      cardinality: 'many',
      direction: 'outgoing',
      // People comment in the CRM; nothing is created along the thread.
      writable: false,
      // Readable (the comments so far) and awaitable (the first one): the
      // Slack `Replies` shape.
      awaitable: true,
      // The CRM pushes a wake when a comment lands, so a park is woken, not polled.
      watchable: true,
      // A deleted company's thread settles empty rather than parking forever.
      resolvesEmpty: true,
    },
  ],
};

const COMMENT_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: FAKE_CRM_COMMENT_TYPE,
  displayName: FAKE_CRM_COMMENT_TYPE,
  fields: [{ fieldId: 'Text', displayName: 'Text', kind: 'string', writable: false, required: false }],
  references: [],
};

/** One comment on a company's thread. */
export interface FakeCrmComment {
  id: string;
  /** The company the thread belongs to. */
  thread: string;
  Text: string;
}

/** One record the fake CRM "persisted" — the id it minted plus the field bag
 *  the write carried. */
export interface FakeCrmWrite {
  externalId: string;
  fields: Record<string, unknown>;
}

/** The in-process adapter plus its own ledgers, exposed for assertions, and
 *  the CRM-side changes a user makes (which the server then pushes). */
export type FakeCrmAdapter = Adapter & {
  readonly writes: FakeCrmWrite[];
  readonly comments: FakeCrmComment[];
  readonly subscriptions: FakeCrmSubscription[];
  /** A user creates a company in the CRM itself (not through Listen-Fire). */
  addCompany(fields: Record<string, unknown>): FakeCrmWrite;
  /** A user comments on a company's thread. */
  addComment(input: { thread: string; text: string }): FakeCrmComment;
};

/**
 * Build an in-process fake-CRM `Adapter`. Its `createRecord` / `updateRecord` /
 * `deleteRecord` mutate the returned `writes` array (a getter for assertions);
 * every other method is the minimal honest implementation the protocol needs.
 */
export function createFakeCrmAdapter(): FakeCrmAdapter {
  const writes: FakeCrmWrite[] = [];
  const comments: FakeCrmComment[] = [];
  const subscriptions: FakeCrmSubscription[] = [];
  let seq = 0;
  let commentSeq = 0;

  const addCompany = (fields: Record<string, unknown>): FakeCrmWrite => {
    const write = { externalId: `company-${++seq}`, fields: { ...fields } };
    writes.push(write);
    return write;
  };
  const threadOf = (company: string): FakeCrmComment[] => comments.filter((c) => c.thread === company);
  const commentResult = (comment: FakeCrmComment): RelatedResult => ({
    position: makeStablePosition({
      adapterType: FAKE_CRM_ADAPTER_TYPE,
      recordType: FAKE_CRM_COMMENT_TYPE,
      recordId: comment.id,
      data: { Text: comment.Text },
    }),
  });

  const resolveAwait = async (point: AwaitPoint): Promise<AwaitResolution> => {
    if (point.edge !== FAKE_CRM_COMMENTS_EDGE) {
      throw new Error(`fake CRM: '${point.edge}' is not an awaitable edge (only '${FAKE_CRM_COMMENTS_EDGE}').`);
    }
    if (!writes.some((w) => w.externalId === point.recordId)) return { status: 'empty' };
    const correlationKey = fakeCrmThreadKey(point.recordId);
    const thread = threadOf(point.recordId);
    if (thread.length === 0) return { status: 'pending', correlationKey };
    return {
      status: 'landed',
      correlationKey,
      landings: thread.map((comment) => ({
        recordId: comment.id,
        recordType: FAKE_CRM_COMMENT_TYPE,
        fields: { Text: comment.Text },
      })),
    };
  };

  const companiesFrom = (input: GetRelatedInput): FakeCrmWrite[] =>
    input.position.recordType === META_RECORD_TYPE && input.fieldId === FAKE_CRM_COMPANY_TYPE
      ? writes
      : [];
  const companyResult = (write: FakeCrmWrite): RelatedResult => ({
    position: makeStablePosition({
      adapterType: FAKE_CRM_ADAPTER_TYPE,
      recordType: FAKE_CRM_COMPANY_TYPE,
      recordId: write.externalId,
      data: { ...write.fields },
    }),
  });

  const adapter: FakeCrmAdapter = {
    writes,
    comments,
    subscriptions,
    addCompany,
    addComment(input) {
      const comment = { id: `comment-${++commentSeq}`, thread: input.thread, Text: input.text };
      comments.push(comment);
      return comment;
    },
    awaitable: { resolveAwait },
    adapterType: FAKE_CRM_ADAPTER_TYPE,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: (): RuntimeCapabilities => BASE_RUNTIME_CAPABILITIES,

    async listEntryPoints(): Promise<SchemaEntryPoint[]> {
      return [
        // Writable (created through Listen-Fire), not a readable source, and
        // fires: a company somebody creates in the CRM itself is delivered to
        // a listen (`company.created`) — pushed along, never enumerated.
        {
          typeId: FAKE_CRM_COMPANY_TYPE,
          displayName: FAKE_CRM_COMPANY_TYPE,
          scope: 'self-configured',
          writable: true,
          readable: false,
          fires: true,
          description: 'A company. A listen is delivered each one somebody creates in the CRM.',
        },
        // Reached only along a company's `Comments`; published so it is named.
        {
          typeId: FAKE_CRM_COMMENT_TYPE,
          displayName: FAKE_CRM_COMMENT_TYPE,
          scope: 'self-configured',
          writable: false,
          readable: false,
        },
      ];
    },

    async describe(typeId: string): Promise<SchemaTypeDescriptor | null> {
      if (typeId === FAKE_CRM_COMPANY_TYPE) return COMPANY_DESCRIPTOR;
      if (typeId === FAKE_CRM_COMMENT_TYPE) return COMMENT_DESCRIPTOR;
      return null;
    },

    // No native identity model — the engine falls through to create.
    async resolveEntity(_input: ResolveEntityInput): Promise<ResolveEntityResult> {
      return { candidates: [] };
    },

    async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
      const data = PositionFields.safeParse(positionData(input.position));
      return data.success ? (data.data[input.fieldId] ?? null) : null;
    },

    // The companies written so far, read back from the root — paged in
    // small pages so a traversal crosses the wire in several round trips.
    // A company's comments so far (a bare read of the awaitable edge).
    async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
      if (input.position.recordType === FAKE_CRM_COMPANY_TYPE && input.fieldId === FAKE_CRM_COMMENTS_EDGE) {
        return input.position.identity.kind === 'stable'
          ? threadOf(input.position.identity.recordId).map(commentResult)
          : [];
      }
      return companiesFrom(input).map(companyResult);
    },

    async iterateRelatedPage(input: GetRelatedInput, cursor?: unknown): Promise<RelatedPage> {
      const offset = fakeCrmPageOffset(cursor);
      const companies = companiesFrom(input);
      const next = offset + FAKE_CRM_PAGE_SIZE;
      return {
        items: companies.slice(offset, next).map(companyResult),
        ...(next < companies.length ? { nextCursor: next } : {}),
      };
    },

    async createRecord(input: WriteInput): Promise<WriteResult> {
      const { externalId } = addCompany(input.fields);
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
      return { events: (deliveryOf(input.raw).companies ?? []).map(companyCreatedEvent) };
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

/** Where the CRM pushes `emit` / `wake`: the host's API origin, and the team
 *  to name when one secret serves several teams' installs. */
export interface FakeCrmHost {
  apiBaseUrl: string;
  teamId?: string;
}

/** What the host's door answered a push with. */
export interface FakeCrmPushResult {
  door: 'emit' | 'wake';
  status: number;
  body: unknown;
}

/** A running fake-CRM protocol server — its base URL, the live ledgers, and a
 *  graceful close. */
export interface FakeCrmServer {
  baseUrl: string;
  /** The backing adapter's write ledger — assert the Company landed here. */
  writes: FakeCrmWrite[];
  /** Every comment on every company's thread. */
  comments: FakeCrmComment[];
  /** The subscriptions the host registered — where (and with what secret) the
   *  CRM would deliver its webhooks. */
  subscriptions: FakeCrmSubscription[];
  close: () => Promise<void>;
}

const DevCompanyBody = z.object({ Name: z.string().min(1), Description: z.string().optional() });
const DevCommentBody = z.object({ company: z.string().min(1), text: z.string().min(1) });

/**
 * Push to one of the host's adapter doors, authenticated the way the install
 * authenticates to this server (the same bearer secret, sent back). The CRM
 * awaits the answer without blocking its own event loop — the host calls the
 * CRM back (`listEventTypes`) while this request is still open.
 */
async function pushToHost(input: {
  host: FakeCrmHost;
  secret: string;
  door: 'emit' | 'wake';
  body: { events: DiscriminableEvent[] } | { keys: string[] };
}): Promise<FakeCrmPushResult> {
  const url = `${input.host.apiBaseUrl.replace(/\/$/, '')}/api/public/adapter/${FAKE_CRM_ADAPTER_TYPE}/${input.door}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${input.secret}`,
      ...(input.host.teamId !== undefined ? { 'x-listen-fire-team': input.host.teamId } : {}),
    },
    body: JSON.stringify(input.body),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // A non-JSON answer is reported as the text it was.
  }
  return { door: input.door, status: res.status, body };
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data.length > 0 ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * The CRM's own (dev) surface — what a user of the CRM does, outside the
 * protocol. Each change is then pushed to the host, as a real CRM would:
 *
 *   GET  /dev/state                            the companies, comments, subscriptions
 *   POST /dev/companies { Name, Description? } create a company → push `emit`
 *   POST /dev/comments  { company, text }      comment on its thread → push `wake`
 *
 * Unauthenticated: a localhost fixture, not part of the protocol.
 */
async function handleDevRoute(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  path: string;
  adapter: FakeCrmAdapter;
  secret: string;
  host: FakeCrmHost | undefined;
}): Promise<void> {
  const { req, res, path, adapter, secret, host } = input;
  if (req.method === 'GET' && path === '/dev/state') {
    sendJson(res, 200, {
      companies: adapter.writes,
      comments: adapter.comments,
      subscriptions: adapter.subscriptions.map(({ secret: _secret, ...sub }) => sub),
    });
    return;
  }
  if (req.method !== 'POST' || (path !== '/dev/companies' && path !== '/dev/comments')) {
    sendJson(res, 404, { error: `no dev route ${req.method} ${path}` });
    return;
  }
  const raw = await readJson(req);
  if (path === '/dev/companies') {
    const body = DevCompanyBody.safeParse(raw);
    if (!body.success) {
      sendJson(res, 400, { error: body.error.issues });
      return;
    }
    const company = adapter.addCompany(body.data);
    const push = host
      ? await pushToHost({
          host,
          secret,
          door: 'emit',
          body: { events: [companyCreatedEvent({ id: company.externalId, Name: body.data.Name })] },
        })
      : null;
    sendJson(res, 200, { company, push });
    return;
  }
  const body = DevCommentBody.safeParse(raw);
  if (!body.success) {
    sendJson(res, 400, { error: body.error.issues });
    return;
  }
  if (!adapter.writes.some((w) => w.externalId === body.data.company)) {
    sendJson(res, 404, { error: `no company ${body.data.company}` });
    return;
  }
  const comment = adapter.addComment({ thread: body.data.company, text: body.data.text });
  const push = host
    ? await pushToHost({ host, secret, door: 'wake', body: { keys: [fakeCrmThreadKey(body.data.company)] } })
    : null;
  sendJson(res, 200, { comment, push });
}

/**
 * Mount a fresh fake-CRM adapter behind the wire protocol on an `http.Server`,
 * bearer-authenticated against `secret`. This is the out-of-process shape a
 * real user-supplied remote adapter takes; a `RemoteAdapter` built from the
 * served manifest drives it over real HTTP. Paths under `/dev/` are the CRM's
 * own surface (see `handleDevRoute`); every other path is the protocol.
 *
 * `port` defaults to 0 (ephemeral) — the shape a self-contained test wants,
 * where the server's lifetime IS the caller's. The durable dev-loop fixture
 * passes the profile-assigned port so the installed `remote_adapter` row can
 * name a URL that stays true after the process that installed it exits.
 * `host` is where the dev routes push; without it they change the CRM and
 * push nothing (`push: null`).
 */
export async function startFakeCrmServer(options: {
  secret: string;
  port?: number;
  host?: FakeCrmHost;
}): Promise<FakeCrmServer> {
  const { secret, port: requestedPort = 0, host } = options;
  const adapter = createFakeCrmAdapter();

  const handler = createAdapterProtocolHandler({
    adapter,
    authenticate: (headers) => headers['authorization'] === `Bearer ${secret}`,
  });

  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fake-crm').pathname;
    if (path.startsWith('/dev/')) {
      handleDevRoute({ req, res, path, adapter, secret, host }).catch((err: unknown) => {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }
    void handler(req, res);
  });

  await new Promise<void>((resolve) => server.listen(requestedPort, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('fake CRM: the server is not listening on a TCP port.');
  }
  const { port } = address;

  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    writes: adapter.writes,
    comments: adapter.comments,
    subscriptions: adapter.subscriptions,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
