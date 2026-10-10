// Typed listen events, runtime. THE EVENT IS JUST A NODE: a webhook event
// seeds the EVENT NODE typed by its canonical narrowed address (the payload's
// own `action` as the pin), so the `if ev IS <crm-[:`Webhook Event` WHERE
// `action` == "record.created"]->>` narrowing the checker blesses resolves at
// runtime (test pins ⊆ seed pins), and the meta-edge traversal
// (`ev-[:Companies]->`) hydrates the live record. Three scenarios prove the
// two orthogonal axes:
//
//   1. ACTION axis — a `record.created` Companies event satisfies the
//      created-pinned IS and the traversal hydrates `Name` ('Acme').
//   2. ACTION axis — a `record.deleted` event does not, so the IS arm is
//      skipped: zero writes (no traversal, no live-record branch).
//   3. OBJECT axis — a `record.created` PERSON event narrows fine (it IS a
//      created record) but the `-[:Companies]->` traversal yields empty (object
//      mismatch in `getRecordForEvent`), so the per-record block body never runs
//      — zero writes. The object axis is orthogonal to the action axis.

// ── Jest module workarounds (mirrors listen_kg_engine.unit.test.ts) ─────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../knowledge_pipeline/output_v3/schemas');

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??=
  'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.SCRAPER_API_KEY ??= 'unit-test-unused';

function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      if (prop === 'executeTakeFirst') return async () => null;
      if (prop === 'then') return undefined;
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../context', () => ({
  unsafeCurrentContext: () => undefined,
  currentContext: () => ({
    user: undefined,
    runAsync: async <T>(fn: () => Promise<T>) => fn(),
  }),
}));

jest.mock('../../translation_graph/adapters/knowledge_graph', () => ({
  KG_ADAPTER_TYPE: 'kg',
  KG_MANIFEST: {
    adapterType: 'kg',
    displayName: 'Knowledge Graph',
    supportedTriggers: ['mutation'],
    methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated'],
    triggerKinds: ['KG_MUTATION'],
    subscribableEvents: ['record.created', 'record.updated', 'record.deleted'],
    listenConfig: [
      { key: 'type', required: true, narrows: { collection: 'Node Type', matchField: 'Id' } },
      { key: 'fields', format: 'fields' },
    ],
  },
  createKnowledgeGraphAdapter: jest.fn(() => ({ adapterType: 'kg' })),
}));

jest.mock('../../knowledge_pipeline/facts', () => ({
  extractFactsForResource: jest.fn(async () => []),
}));
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => '{}'),
  anthropicChatDetailed: jest.fn(async () => ({
    text: '{}',
    stopReason: 'end_turn',
    truncated: false,
  })),
  MAX_CHAT_CONTINUATIONS: 5,
}));
jest.mock('../../translation_graph/adapters/acting_user/resolve', () => ({
  resolveActingUser: jest.fn(async () => null),
}));
jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import type { Catalog, InstanceSchema, PositionSchema } from 'movement-lang';
import { eventAddressDisplay, eventAddressKey } from 'movement-lang';
import { runMovement } from '../run';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import {
  makeStablePosition,
  positionData,
} from '../../translation_graph/types';
import type { Adapter, RuntimeCapabilities } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as TeamId;
const COMPANIES_OBJECT_ID = 'obj-companies';
const PERSON_OBJECT_ID = 'obj-person';

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: true, edgeProperties: true },
    resources: true,
  };
}

// The Attio instance schema as the projection + host graft produce it: the
// event NODE with its `action` enum + requiresLiveRecord record edge, and the
// demand-grafted per-action narrowings (the deleted pin drops the edge).
// Mirrors the movement-lang checker fixture so the program type-checks
// identically at run time.
const ACTIONS = ['record.created', 'record.updated', 'record.deleted'];
const EVENT = 'Webhook Event';
const graftPositions: Record<string, PositionSchema> = {};
const graftVariants: string[] = [];
for (const action of ACTIONS) {
  const key = eventAddressKey({ event: EVENT, narrowing: { action } });
  graftVariants.push(key);
  graftPositions[key] = {
    properties: { action: { kind: 'enum', options: ACTIONS } },
    edges: action === 'record.deleted' ? {} : { Companies: { target: 'Companies' } },
    displayName: eventAddressDisplay({ event: EVENT, narrowing: { action } }),
  };
}
const ATTIO_SCHEMA: InstanceSchema = {
  positions: {
    Companies: { properties: { Name: 'text', Description: 'text' }, edges: {} },
    [EVENT]: {
      properties: { action: { kind: 'enum', options: ACTIONS } },
      edges: { Companies: { target: 'Companies', requiresLiveRecord: true } },
    },
    ...graftPositions,
  },
  collections: {},
  unions: { [EVENT]: graftVariants },
  writableRoots: {},
  eventPosition: EVENT,
  eventPositions: [{ position: EVENT }],
};

// The catalog: the real manifests give `attio`/`slack` their construction +
// listen-config vocabulary; we override `instantiate('attio')` to project the
// typed-event schema (the static-manifest stub returns a thin Attio schema
// without the variants).
const baseCatalog = staticCatalogFromManifests({
  credentials: {
    acme_main: { adapters: ['attio'] },
    acme_slack: { adapters: ['slack'] },
  },
});
const catalog: Catalog = {
  ...baseCatalog,
  instantiate(name, args) {
    if (name === 'attio') return ATTIO_SCHEMA;
    return baseCatalog.instantiate(name, args);
  },
};

interface RecordedWrite {
  recordType: string;
  fields: Record<string, unknown>;
}

function makeSlackTargetFake(): { adapter: Adapter; creates: RecordedWrite[] } {
  const creates: RecordedWrite[] = [];
  const adapter: Adapter = {
    adapterType: 'slack',
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType: 'slack', externalId: `msg-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: 'slack', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

// A fake Attio SOURCE that mirrors `getRecordForEvent` (attio.ts): the
// `-[:Companies]->` meta-edge hydrates the live record ONLY when the event's
// `id.object_id` matches the Companies object; a mismatch (a Person event)
// yields an empty traversal — the framework's clean no-op.
function makeAttioSourceFake(): Adapter {
  return {
    adapterType: 'attio',
    supportedTriggers: ['webhook'] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId] ?? null;
    },
    async getRelated({ position, fieldId }) {
      if (fieldId !== 'Companies') return [];
      const data = positionData(position) as
        | { id?: { object_id?: string; record_id?: string } }
        | undefined;
      // The object axis: only Companies events traverse to a Companies record.
      if (data?.id?.object_id !== COMPANIES_OBJECT_ID) return [];
      const recordId = data.id.record_id ?? 'unknown';
      return [
        {
          position: makeStablePosition({
            adapterType: 'attio',
            recordType: 'Companies',
            recordId,
            data: { Name: 'Acme' },
          }),
        },
      ];
    },
    async createRecord() {
      throw new Error('test: the attio fake is a source — nothing writes to it here');
    },
    async updateRecord() {
      throw new Error('test: the attio fake is a source — nothing writes to it here');
    },
    async deleteRecord() {
      return {};
    },
  };
}

// A typed Attio webhook event: the payload carries the discriminant the
// meta-edge traversal reads (`id.object_id` / `id.record_id`) and the event
// node's own `action` field — the pin the seed derives its type from.
function webhookEvent(input: {
  changeType: 'create' | 'update' | 'delete';
  objectId: string;
  eventType: string;
}): TriggerEvent {
  return {
    pipelineInputId: 'trigger:t-attio-1',
    adapterType: 'attio',
    triggerType: 'webhook',
    payload: {
      event_type: input.eventType,
      action: input.eventType,
      id: { record_id: 'co-1', object_id: input.objectId },
    },
    changeType: input.changeType,
    rootRecordType: 'Companies',
    externalRecordRef: { adapterType: 'attio', externalId: 'co-1', recordType: 'Companies' },
    occurredAt: new Date().toISOString(),
  };
}

/** The same event with NO `action` on the payload — the trigger delivered it
 *  without the axis every pinned address test asks about. */
function undiscriminatedEvent(): TriggerEvent {
  const event = webhookEvent({
    changeType: 'create',
    objectId: COMPANIES_OBJECT_ID,
    eventType: 'record.created',
  });
  const payload = { ...(event.payload as Record<string, unknown>) };
  delete payload.action;
  return { ...event, payload };
}

const ROUTE_BY_ACTION = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'chat = slack(credentials: acme_slack)',
  '',
  'movement route_by_action(ev: <crm-[:`Webhook Event`]->>) {',
  '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->> {',
  '    write chat-[:messages]-> {',
  '      channel: "#alerts"',
  '      text: "created"',
  '    }',
  '  } else {',
  '    write chat-[:messages]-> {',
  '      channel: "#alerts"',
  '      text: "not created"',
  '    }',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire route_by_action',
].join('\n');

const NOTIFY_NEW_COMPANY = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'chat = slack(credentials: acme_slack)',
  '',
  'movement notify_new_company(ev: <crm-[:`Webhook Event`]->>) {',
  '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->> {',
  '    ev-[co:Companies]-> {',
  '      write chat-[:messages]-> {',
  '        channel: "#alerts"',
  '        text: co.`Name`',
  '      }',
  '    }',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire notify_new_company',
].join('\n');

// A scalar-only program: reads the event's OWN field (`action`) directly off
// the seeded unstable event node — no narrow, no traversal. `action` is an
// ordinary field of the node, so it is readable on the union as-is.
const READ_ACTION = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'chat = slack(credentials: acme_slack)',
  '',
  'movement read_action(ev: <crm-[:`Webhook Event`]->>) {',
  '  write chat-[:messages]-> {',
  '    channel: "#alerts"',
  '    text: ev.`action`',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire read_action',
].join('\n');

async function runProgram(input: { source: string; movementName: string; event: TriggerEvent }) {
  const target = makeSlackTargetFake();
  const source = makeAttioSourceFake();
  const result = await runMovement({
    source: input.source,
    movementName: input.movementName,
    event: input.event,
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: () => 'cred-1',
    resolveAdapter: ({ adapterType }) => {
      if (adapterType === 'attio') return source;
      if (adapterType === 'slack') return target.adapter;
      throw new Error(`test: no fake for '${adapterType}'`);
    },
  });
  return { result, creates: target.creates };
}

async function run(event: TriggerEvent) {
  return runProgram({ source: NOTIFY_NEW_COMPANY, movementName: 'notify_new_company', event });
}

describe('typed listen events — runtime action binding (runMovement)', () => {
  it('a created Companies event seeds the created-pinned address; IS-narrow + traverse hydrates Name', async () => {
    const { result, creates } = await run(
      webhookEvent({ changeType: 'create', objectId: COMPANIES_OBJECT_ID, eventType: 'record.created' }),
    );
    expect(result.writes).toHaveLength(1);
    expect(creates).toEqual([{ recordType: 'message', fields: { channel: '#alerts', text: 'Acme' } }]);
  });

  it('a delete event does not satisfy the created pin — the IS arm is skipped, zero writes', async () => {
    const { result, creates } = await run(
      webhookEvent({ changeType: 'delete', objectId: COMPANIES_OBJECT_ID, eventType: 'record.deleted' }),
    );
    expect(result.writes).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });

  it('a created PERSON event narrows fine but the Companies traversal is empty — zero writes (object axis)', async () => {
    const { result, creates } = await run(
      webhookEvent({ changeType: 'create', objectId: PERSON_OBJECT_ID, eventType: 'record.created' }),
    );
    expect(result.writes).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });

  it("reads the event's own scalar field (action) directly off the unstable event seed — resolves from the payload", async () => {
    const { result, creates } = await runProgram({
      source: READ_ACTION,
      movementName: 'read_action',
      event: webhookEvent({ changeType: 'create', objectId: COMPANIES_OBJECT_ID, eventType: 'record.created' }),
    });
    expect(result.writes).toHaveLength(1);
    // The scalar read goes through getFieldValue against the seeded event
    // node and resolves from the unstable seed's payload data.
    expect(creates).toEqual([{ recordType: 'message', fields: { channel: '#alerts', text: 'record.created' } }]);
  });

  // The ADDRESS plane's half of the undiscriminated-IS ruling. A test whose
  // pin the seed never carried is not answerable, and answering `false` would
  // route the run into an `else` the checker has typed as "not that address" —
  // the silent degradation the record plane already refuses. It stops instead.
  describe('an address test the event cannot answer', () => {
    it('FAILS THE RUN rather than taking the else', async () => {
      await expect(
        runProgram({
          source: ROUTE_BY_ACTION,
          movementName: 'route_by_action',
          event: undiscriminatedEvent(),
        }),
      ).rejects.toThrow(/can't tell what kind of record 'ev' is/);
    });

    it('the refusal names the AXIS the event is missing', async () => {
      await expect(
        runProgram({
          source: ROUTE_BY_ACTION,
          movementName: 'route_by_action',
          event: undiscriminatedEvent(),
        }),
      ).rejects.toThrow(/carries no 'action'/);
    });

    it('…and it is the same refusal when the arm has no else at all', async () => {
      await expect(
        runProgram({
          source: NOTIFY_NEW_COMPANY,
          movementName: 'notify_new_company',
          event: undiscriminatedEvent(),
        }),
      ).rejects.toThrow(/can't tell what kind of record 'ev' is/);
    });
  });

  it('a pin the event HAS, disagreeing, is an ordinary false — the else runs', async () => {
    const { creates } = await runProgram({
      source: ROUTE_BY_ACTION,
      movementName: 'route_by_action',
      event: webhookEvent({
        changeType: 'delete',
        objectId: COMPANIES_OBJECT_ID,
        eventType: 'record.deleted',
      }),
    });
    expect(creates).toEqual([
      { recordType: 'message', fields: { channel: '#alerts', text: 'not created' } },
    ]);
  });

  it('…and a pin that AGREES still takes the arm', async () => {
    const { creates } = await runProgram({
      source: ROUTE_BY_ACTION,
      movementName: 'route_by_action',
      event: webhookEvent({
        changeType: 'create',
        objectId: COMPANIES_OBJECT_ID,
        eventType: 'record.created',
      }),
    });
    expect(creates).toEqual([
      { recordType: 'message', fields: { channel: '#alerts', text: 'created' } },
    ]);
  });

  it("an EMPTY field on a hydrated stable record reads null WITHOUT a spurious field_miss", async () => {
    // The hydrated company carries { Name: 'Acme' } and no Description. Reading
    // `co.Description` resolves through the adapter (a known, declared field) to
    // null — a legitimately empty value, NOT a schema-vs-payload mismatch. The
    // field_miss diagnostic is for raw-payload (unstable) positions only; a
    // stable adapter record must not trip it (it also used to leak the record's
    // internal keys at the user). This is the 'this event has no Domains —
    // it carries: [slugs]' false positive.
    const SRC = NOTIFY_NEW_COMPANY.replace('text: co.`Name`', 'text: co.`Description`');
    const { result, creates } = await runProgram({
      source: SRC,
      movementName: 'notify_new_company',
      event: webhookEvent({ changeType: 'create', objectId: COMPANIES_OBJECT_ID, eventType: 'record.created' }),
    });
    // The write still happens (Description is null → empty text), and crucially
    // the run records NO field_miss for the empty field.
    expect(creates).toEqual([{ recordType: 'message', fields: { channel: '#alerts', text: null } }]);
    expect(result.trace.find((e) => e.kind === 'field_miss')).toBeUndefined();
  });
});
