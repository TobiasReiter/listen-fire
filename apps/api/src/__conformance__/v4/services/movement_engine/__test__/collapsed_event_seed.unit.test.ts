// Rule 1's collapse, runtime. A field-less 1:1 event node is pure indirection,
// so the messaging adapters' `fires` edge lands STRAIGHT on the record
// (`chat -[:Slack Message]->`, no `Message Received` in between). The seed is
// then the record itself:
//
//   - typed by the address (`<chat-[:`Slack Message`]->>` resolves at runtime),
//   - STABLE — the dispatcher recorded the record's durable id and the
//     adapter's own discrimination named the delivered node, so a linked write
//     anchors off the PARAMETER (`write ev-[:replies]->`) exactly as it
//     anchored off the retired `e-[r:record]->` hop,
//   - fields read directly off the seed (`ev.`Text``) — the record-edge hop is
//     gone from movement bodies.
//
// The counter-case stays: an event node DISTINCT from its record
// (airtable/attio — discrimination names the RECORD type, never the event
// node) seeds an unstable occurrence; typed_event_run.unit.test.ts pins that
// half. Here we also pin the boundary: a delivery whose dispatcher recorded no
// record ref seeds unstable and REFUSES to parent a linked write.

// ── Jest module workarounds (mirrors typed_event_run.unit.test.ts) ──────────

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

import type { Catalog, InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { positionData } from '../../translation_graph/types';
import type { Adapter, ParentLink, RuntimeCapabilities } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000011' as TeamId;
const MESSAGE = 'Slack Message';
const TS = '1752700000.000100';

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: true, edgeProperties: true },
    resources: true,
  };
}

// The collapsed messaging shape, as the projection produces it: the record
// entry carries `fires` itself (no event node, no record edge), keeps its
// honest `readable: false` (a fires edge is reachability), and its `replies`
// edge is the write anchor. `createShapes` holds the edge-created shape, the
// same way the real slack projection files it.
const CHAT_SCHEMA: InstanceSchema = {
  positions: {
    [MESSAGE]: {
      properties: { Text: 'text', Timestamp: 'text' },
      edges: { replies: { target: MESSAGE, writable: true, readable: false } },
    },
  },
  collections: {},
  writableRoots: {},
  createShapes: {
    [MESSAGE]: {
      fields: { Text: 'text' },
      resultShape: { externalId: 'text', url: 'text', Text: 'text' },
    },
  },
  eventPosition: MESSAGE,
  eventPositions: [{ position: MESSAGE, on: ['message', 'app_mention'] }],
};

const baseCatalog = staticCatalogFromManifests({
  credentials: { acme_slack: { adapters: ['slack'] } },
});
const catalog: Catalog = {
  ...baseCatalog,
  instantiate(name, args) {
    if (name === 'slack') return CHAT_SCHEMA;
    return baseCatalog.instantiate(name, args);
  },
};

interface RecordedWrite {
  recordType: string;
  fields: Record<string, unknown>;
  parentLinks: ParentLink[] | undefined;
}

function makeChatFake(): { adapter: Adapter; creates: RecordedWrite[] } {
  const creates: RecordedWrite[] = [];
  const adapter: Adapter = {
    adapterType: 'slack',
    supportedTriggers: ['webhook'] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      // What the collapsed slack adapter publishes: the record IS the fires
      // target (`naturalRootTypeName` maps the discriminated typeId here).
      return [
        {
          typeId: 'slack:message',
          displayName: MESSAGE,
          readable: false,
          writable: false,
          fires: true,
          firesOn: ['message', 'app_mention'],
        },
      ];
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
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push({
        recordType: input.recordType,
        fields: input.fields,
        parentLinks: input.parentLinks,
      });
      return { adapterType: 'slack', externalId: `reply-${creates.length}`, data: {} };
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

// The collapsed movement shape: no `e-[r:record]->` — the field read and the
// reply write both hang straight off the parameter.
const REPLY = [
  'import { slack } from adapters',
  'import { acme_slack } from credentials',
  '',
  'chat = slack(credentials: acme_slack)',
  '',
  'movement reply(ev: <chat-[:`Slack Message`]->>) {',
  '  write ev-[:replies]-> {',
  '    Text: "Noted: ${ev.`Text`}"',
  '  }',
  '}',
  '',
  'listen to chat {} fire reply',
].join('\n');

function messageEvent(input: { withRecordRef: boolean }): TriggerEvent {
  return {
    pipelineInputId: 'trigger:t-slack-1',
    adapterType: 'slack',
    triggerType: 'webhook',
    payload: { Text: 'step6 probe', Timestamp: TS, ts: TS },
    changeType: 'create',
    rootRecordType: 'slack:message',
    ...(input.withRecordRef
      ? {
          externalRecordRef: {
            adapterType: 'slack',
            externalId: TS,
            recordType: 'slack:message',
          },
        }
      : {}),
    occurredAt: new Date().toISOString(),
  };
}

async function run(event: TriggerEvent) {
  const chat = makeChatFake();
  const result = await runMovement({
    source: REPLY,
    movementName: 'reply',
    event,
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: () => 'cred-1',
    resolveAdapter: ({ adapterType }) => {
      if (adapterType === 'slack') return chat.adapter;
      throw new Error(`test: no fake for '${adapterType}'`);
    },
  });
  return { result, creates: chat.creates };
}

describe('collapsed event seed — fires lands straight on the record (runMovement)', () => {
  it('seeds the record STABLE: the field reads off the seed and the reply anchors on its id', async () => {
    const { result, creates } = await run(messageEvent({ withRecordRef: true }));
    expect(result.writes).toHaveLength(1);
    expect(creates).toHaveLength(1);
    expect(creates[0].recordType).toBe(MESSAGE);
    expect(creates[0].fields).toEqual({ Text: 'Noted: step6 probe' });
    // The load-bearing half: the parameter itself parented the write — the
    // parentLink carries the delivered record's durable id (the ts), which is
    // what the retired record-edge hop existed to supply.
    expect(creates[0].parentLinks).toEqual([
      expect.objectContaining({ recordType: MESSAGE, externalId: TS, edgeName: 'replies' }),
    ]);
  });

  it('a delivery with no recorded record ref seeds unstable and refuses to parent the write', async () => {
    await expect(run(messageEvent({ withRecordRef: false }))).rejects.toThrow(
      /carries no durable record id/,
    );
  });
});
