// The natural-name CONTRACT (adapter-natural-names refactor, 2026-06-13).
//
// The movement engine carries ZERO name↔id translation: it names every
// type/edge/field by the adapter's NATURAL name (its `displayName` / reference
// `name`) and hands those verbatim across the Adapter interface. Each adapter
// translates natural→its-own-internal-id INTERNALLY, from its own
// introspection. Record ids stay opaque.
//
// These tests run the engine against recording fakes that are WIRED WITH A
// RESOLVER (built from the same introspection the catalog projects schemas
// from). Each fake translates on its first line — exactly as a real adapter
// does — and records BOTH the natural names it received at the boundary AND
// the internal ids it resolved them to. The assertions prove:
//
//   1. the engine passes the adapter's NATURAL names verbatim (`Companies`,
//      `Name`, `m.\`Subject\``) — never an internal id;
//   2. the adapter, resolving against its own introspection, lands the write
//      on the correct internal ids (`attio:companies`, `name`); the KG resolves
//      ontology display names → UUIDs and edge names → its write currency, with
//      the edge-scoped compound-identity fold landing under the edge name;
//   3. a name the adapter's introspection doesn't publish THROWS loud drift
//      (Decision #4) — no silent mis-resolve, no passthrough.

// ── Jest module workarounds (mirrors run.unit.test.ts) ──────────────────────

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
    methods: [
      'listEntryPoints', 'describe', 'resolveEntity', 'getDedupRules',
      'getFieldValue', 'getRelated', 'createRecord', 'updateRecord',
      'getPriorMatch', 'recordLink',
    ],
    triggerKinds: ['KG_MUTATION'],
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
jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import type { Catalog } from 'movement-lang';
import { runMovement } from '../run';
import { MovementEngineError } from '../expression';
import type {
  Adapter,
  ParentLink,
  ResolveEntityInput,
  WriteInput,
} from '../../translation_graph/adapter';
import { singleParentLink } from '../../translation_graph/adapter';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
} from '../../translation_graph/types';
import { positionData, makeStablePosition, META_RECORD_TYPE } from '../../translation_graph/types';
import {
  adapterNameResolver,
  naturalName,
  AdapterNameDriftError,
  type AdapterIntrospection,
} from '../../translation_graph/adapters/name_resolution';
import { containerAssociation } from '../../translation_graph/adapter';
import { instanceSchemaFromDescriptors } from '../../translation_graph/movement/schema_projection';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as TeamId;
const KG_ADAPTER_TYPE = 'kg';

// ── The introspection fixtures (same projections as catalog.unit.test) ──────

const field = (
  fieldId: string,
  kind: SchemaTypeDescriptor['fields'][number]['kind'],
  opts: { writable?: boolean; displayName?: string } = {},
): SchemaTypeDescriptor['fields'][number] => ({
  fieldId,
  displayName: opts.displayName ?? fieldId,
  kind,
  writable: opts.writable ?? false,
  required: false,
});

const emailEntries: SchemaEntryPoint[] = [
  { typeId: 'email:message', displayName: 'Email', writable: false, readable: true },
];
const emailDescriptors = new Map<string, SchemaTypeDescriptor>([
  [
    'email:message',
    {
      typeId: 'email:message',
      displayName: 'Email',
      // `subject`/`sender` are internal ids; their natural names (the
      // program-facing displayName) are `Subject`/`From`.
      fields: [
        field('subject', 'string', { displayName: 'Subject' }),
        field('sender', 'string', { displayName: 'From' }),
      ],
      references: [],
    },
  ],
]);

const attioEntries: SchemaEntryPoint[] = [
  { typeId: 'attio:companies', displayName: 'Companies', writable: true, readable: true },
];
const attioDescriptors = new Map<string, SchemaTypeDescriptor>([
  [
    'attio:companies',
    {
      typeId: 'attio:companies',
      displayName: 'Companies',
      fields: [
        field('name', 'string', { writable: true, displayName: 'Name' }),
        field('description', 'string', { writable: true, displayName: 'Description' }),
      ],
      references: [],
    },
  ],
]);

const slackEntries: SchemaEntryPoint[] = [
  { typeId: 'slack:channel', displayName: 'Channel', collectionName: 'Channels', writable: false, readable: true },
  { typeId: 'slack:message', displayName: 'Slack Message', writable: false, readable: true },
];
const slackDescriptors = new Map<string, SchemaTypeDescriptor>([
  [
    'slack:channel',
    {
      typeId: 'slack:channel',
      displayName: 'Channel',
      fields: [
        field('id', 'string', { displayName: 'Id' }),
        field('name', 'string', { displayName: 'Name' }),
      ],
      references: [
        { fieldId: 'messages', targetTypeId: 'slack:message', cardinality: 'many', name: 'messages', writable: true },
      ],
    },
  ],
  [
    'slack:message',
    {
      typeId: 'slack:message',
      displayName: 'Slack Message',
      fields: [
        field('text', 'string', { writable: true, displayName: 'Message' }),
        field('channel', 'string', { displayName: 'Channel' }),
      ],
      references: [
        { fieldId: 'replies', targetTypeId: 'slack:message', cardinality: 'many', name: 'replies', writable: true },
      ],
    },
  ],
]);

/** The ontology fixture's own shape — a graph's model is projected through the
 *  ADAPTER's introspection now, so nothing in production names these rows. */
interface OntologyRows {
  nodeTypes: Array<{ id: string; name: string }>;
  propertyTypes: Array<{
    id: string;
    name: string;
    nodeTypeId: string;
    valueType: 'text' | 'number';
    cardinality: 'single' | 'multi';
    enumValues: string[] | null;
  }>;
  edgeTypes: Array<{
    id: string;
    outboundName: string;
    sourceNodeTypeId: string;
    targetNodeTypeId: string;
  }>;
}

const ontology: OntologyRows = {
  nodeTypes: [
    { id: 'nt-round', name: 'Funding Round' },
    { id: 'nt-part', name: 'Round Participation' },
  ],
  propertyTypes: [
    {
      id: 'pt-name',
      name: 'Name',
      nodeTypeId: 'nt-round',
      valueType: 'text',
      cardinality: 'single',
      enumValues: null,
    },
    {
      id: 'pt-amount',
      name: 'Amount',
      nodeTypeId: 'nt-round',
      valueType: 'number',
      cardinality: 'single',
      enumValues: null,
    },
    {
      id: 'pt-investor',
      name: 'Investor Name',
      nodeTypeId: 'nt-part',
      valueType: 'text',
      cardinality: 'single',
      enumValues: null,
    },
  ],
  edgeTypes: [
    {
      id: 'et-part',
      outboundName: 'Participants',
      sourceNodeTypeId: 'nt-round',
      targetNodeTypeId: 'nt-part',
    },
  ],
};

const emailProjection = instanceSchemaFromDescriptors({
  supportsInPlaceUpdate: false,
  adapterType: 'email',
  entries: emailEntries,
  descriptors: emailDescriptors,
});
const attioProjection = instanceSchemaFromDescriptors({
  supportsInPlaceUpdate: false,
  adapterType: 'attio',
  entries: attioEntries,
  descriptors: attioDescriptors,
});
const slackProjection = instanceSchemaFromDescriptors({
  supportsInPlaceUpdate: false,
  adapterType: 'slack',
  entries: slackEntries,
  descriptors: slackDescriptors,
});
// THE SAME projection every adapter's schema comes from — the graph's model
// reaches the checker through its own `listEntryPoints()` / `describe()`, not a
// second DB-direct path.
const kgIntrospection = ontologyIntrospection(ontology);
const kgProjection = instanceSchemaFromDescriptors({
  supportsInPlaceUpdate: false,
  adapterType: KG_ADAPTER_TYPE,
  entries: kgIntrospection.entries,
  descriptors: kgIntrospection.descriptors,
});

const schemasBySlug = {
  email: emailProjection.schema,
  attio: attioProjection.schema,
  slack: slackProjection.schema,
  [KG_ADAPTER_TYPE]: kgProjection.schema,
};

const teamLikeCatalog: Catalog = {
  adapter(name) {
    if (!(name in schemasBySlug)) return undefined;
    return {
      constructionArgs:
        name === 'email'
          ? [{ name: 'credentials', kind: 'position', required: false }]
          : name === KG_ADAPTER_TYPE
            ? []
            : [{ name: 'credentials', kind: 'credential', required: true }],
    };
  },
  credential(name) {
    if (name === 'dev_loop_attio') return { adapters: ['attio'] };
    if (name === 'dev_loop_slack') return { adapters: ['slack'] };
    return undefined;
  },
  plugin() {
    return undefined;
  },
  instantiate(adapter) {
    return schemasBySlug[adapter as keyof typeof schemasBySlug];
  },
};

const CREDENTIAL_IDS: Record<string, string> = {
  dev_loop_attio: 'cred-attio-1',
  dev_loop_slack: 'cred-slack-1',
};

// The KG ontology projects to an `AdapterIntrospection` so a KG fake builds
// the SAME resolver every adapter does — the KG is not special.
function ontologyIntrospection(rows: OntologyRows): AdapterIntrospection {
  const entries: SchemaEntryPoint[] = rows.nodeTypes.map((nt) => ({
    typeId: nt.id,
    displayName: nt.name,
    writable: true,
    readable: true,
  }));
  const descriptors = new Map<string, SchemaTypeDescriptor>();
  for (const nt of rows.nodeTypes) {
    descriptors.set(nt.id, {
      typeId: nt.id,
      displayName: nt.name,
      fields: rows.propertyTypes
        .filter((p) => p.nodeTypeId === nt.id)
        .map((p) => ({
          fieldId: p.id,
          displayName: p.name,
          kind: p.valueType === 'number' ? 'number' : 'string',
          writable: true,
          required: false,
        })),
      references: rows.edgeTypes
        .filter((e) => e.sourceNodeTypeId === nt.id)
        .map((e) => ({
          fieldId: e.id,
          targetTypeId: e.targetNodeTypeId,
          cardinality: 'many' as const,
          // The KG publishes the edge's display name (`outbound_name`) as the
          // reference `name` — the write currency parentLink consumes — and
          // every ontology edge is writable in both directions.
          name: e.outboundName,
          writable: true,
        })),
    });
  }
  return { entries, descriptors };
}

const introspectionBySlug: Record<string, AdapterIntrospection> = {
  email: { entries: emailEntries, descriptors: emailDescriptors },
  attio: { entries: attioEntries, descriptors: attioDescriptors },
  slack: { entries: slackEntries, descriptors: slackDescriptors },
  [KG_ADAPTER_TYPE]: ontologyIntrospection(ontology),
};

// ── A resolver-wired fake adapter — translates on its first line, like a real
// ── adapter, and records BOTH the natural boundary calls AND the internal ids
// ── it resolved them to.

interface BoundaryCalls {
  /** The NATURAL recordType the engine passed to each describe. */
  describedNatural: string[];
  resolves: Array<{
    /** What the engine passed (NATURAL). */
    recordTypeNatural: string;
    constraintsNatural: ResolveEntityInput['constraints'];
    recordNatural: Record<string, unknown>;
    /** What the adapter resolved to (INTERNAL). */
    recordTypeInternal: string;
    recordInternal: Record<string, unknown>;
    constraintsInternal: ResolveEntityInput['constraints'];
  }>;
  creates: Array<{
    recordTypeNatural: string;
    fieldsNatural: Record<string, unknown>;
    parentLinkNatural?: ParentLink;
    /** What the adapter resolved to. */
    recordTypeInternal: string;
    fieldsInternal: Record<string, unknown>;
    parentLinkInternal?: ParentLink;
  }>;
}

function makeResolverFake(
  adapterType: string,
  introspection: AdapterIntrospection,
): { adapter: Adapter; calls: BoundaryCalls } {
  const calls: BoundaryCalls = { describedNatural: [], resolves: [], creates: [] };
  const resolver = adapterNameResolver(introspection);
  // entries-only natural-name → internal typeId for the `describe` dual-accept
  // (no recursion, no throw — describe returns null for an unknown ref).
  const typeIdByName = new Map(introspection.entries.map((e) => [e.displayName, e.typeId]));
  const describeTypeId = (ref: string) => typeIdByName.get(ref) ?? ref;
  // The read/write currency resolution THROWS loud drift on an unknown type
  // (Decision #4) — exactly as a real adapter's `resolver.typeId` does.
  const toInternalType = (n: string) => resolver.typeId(naturalName(n));
  // The internal field name for a natural field/edge name under a natural
  // type — property first, else the edge write name (the adjacency-identity
  // currency the KG resolve search keys on), mirroring the KG adapter. An edge
  // declared on the PARENT (not this child) has no reverse map and stays its
  // natural name — exactly as the engine threaded it.
  const internalField = (typeNatural: string, name: string): string =>
    resolver.tryFieldId(naturalName(typeNatural), naturalName(name)) ??
    resolver.tryEdgeWriteName(naturalName(typeNatural), naturalName(name)) ??
    name;

  const adapter: Adapter = {
    adapterType,
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    }),
    async listEntryPoints() {
      return introspection.entries;
    },
    async describe(typeRef) {
      calls.describedNatural.push(typeRef);
      // Accept the natural name (engine currency) OR the internal id — never
      // throws (an unknown ref returns null, like a real adapter's describe).
      const typeId = describeTypeId(typeRef);
      return introspection.descriptors.get(typeId) ?? null;
    },
    async resolveEntity(input) {
      const typeNatural = input.recordType;
      const recordTypeInternal = toInternalType(typeNatural);
      const recordInternal: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input.record)) {
        recordInternal[internalField(typeNatural, k)] = v;
      }
      const constraintsInternal = {
        any: input.constraints.any.map((b) => ({
          all: b.all.map((e) => ({ ...e, field: internalField(typeNatural, e.field) })),
        })),
      };
      calls.resolves.push({
        recordTypeNatural: typeNatural,
        constraintsNatural: input.constraints,
        recordNatural: input.record,
        recordTypeInternal,
        recordInternal,
        constraintsInternal,
      });
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      // The position's recordType is the NATURAL type (the read wrapper stamps
      // it); resolve the natural field against it (or the payload key when the
      // raw seed carries internal-id keys — both covered below).
      const data = positionData(position) as Record<string, unknown> | undefined;
      if (!data) return undefined;
      const typeNatural = position.recordType;
      const internal = typeNatural !== null ? internalField(typeNatural, fieldId) : fieldId;
      return data[internal] ?? data[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      const typeNatural = input.recordType;
      const recordTypeInternal = toInternalType(typeNatural);
      const fieldsInternal: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input.fields)) {
        fieldsInternal[internalField(typeNatural, k)] = v;
      }
      // These cases author single-parent linked writes — the lone parent.
      const parentLinkNatural = singleParentLink(input);
      const parentLinkInternal = parentLinkNatural
        ? {
            recordType: toInternalType(parentLinkNatural.recordType),
            externalId: parentLinkNatural.externalId,
            edgeName:
              resolver.tryEdgeWriteName(
                naturalName(parentLinkNatural.recordType),
                naturalName(parentLinkNatural.edgeName),
              ) ?? parentLinkNatural.edgeName,
          }
        : undefined;
      calls.creates.push({
        recordTypeNatural: typeNatural,
        fieldsNatural: input.fields,
        ...(parentLinkNatural ? { parentLinkNatural } : {}),
        recordTypeInternal,
        fieldsInternal,
        ...(parentLinkInternal ? { parentLinkInternal } : {}),
      });
      return {
        adapterType,
        externalId: `ext-${adapterType}-${calls.creates.length}`,
        data: { marker: `data-${adapterType}-${calls.creates.length}` },
      };
    },
    async updateRecord(input) {
      return { adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, calls };
}

function makeResolveAdapter(byType: Record<string, Adapter>) {
  return ({ adapterType }: { adapterType: string }) => {
    const adapter = byType[adapterType];
    if (!adapter) throw new Error(`test: no fake adapter for '${adapterType}'`);
    return adapter;
  };
}

const event: TriggerEvent = {
  pipelineInputId: 'pi-refs-test',
  adapterType: 'email',
  triggerType: 'webhook',
  payload: { subject: 'Acme Corp intro', sender: 'alice@acme.dev' },
};

// ── 1. The engine passes NATURAL names; the adapter translates internally ───

const ADAPTER_FIXTURE = `
import { email, attio, slack } from adapters
import { dev_loop_attio, dev_loop_slack } from credentials

inbox = email()
crm   = attio(credentials: dev_loop_attio)
chat  = slack(credentials: dev_loop_slack)

movement dealflow_intake(m: <inbox-[:Email]->>) {
  co = write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        m.\`Subject\`
    Description: "Introduced by \${m.\`From\`}"
  }
  chat-[ch:Channels WHERE \`Name\` == "dealflow"]-> {
    write ch-[:messages]-> {
      Message: "New company: \${co.externalId}"
    }
  }
}
`;

describe('the engine passes natural names; the adapter translates internally', () => {
  it('describe / resolveEntity / createRecord receive NATURAL names; the adapter lands internal ids', async () => {
    const email = makeResolverFake('email', introspectionBySlug.email);
    const attio = makeResolverFake('attio', introspectionBySlug.attio);
    const slack = makeResolverFake('slack', introspectionBySlug.slack);
    // The lookup block `chat-[ch:Channels WHERE …]->` walks the meta root's
    // Channels collection; answer it with one channel position carrying its
    // own data (id + name) — the parent link the linked write inherits.
    slack.adapter.getRelated = async ({ position, fieldId }) => {
      if (position.recordType === META_RECORD_TYPE && naturalName(fieldId) === 'Channels') {
        return [
          {
            position: makeStablePosition({
              adapterType: 'slack',
              recordType: 'Channel',
              recordId: 'C123',
              data: { id: 'C123', name: 'dealflow' },
            }),
          },
        ];
      }
      return [];
    };

    const result = await runMovement({
      source: ADAPTER_FIXTURE,
      event,
      teamId: TEAM_ID,
      catalog: teamLikeCatalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolveAdapter({
        email: email.adapter,
        attio: attio.adapter,
        slack: slack.adapter,
      }),
    });

    // The engine passes the NATURAL type name to describe — never the slug.
    expect(attio.calls.describedNatural).toEqual(['Companies']);

    // resolveEntity receives natural names; the adapter resolves them.
    expect(attio.calls.resolves).toHaveLength(1);
    expect(attio.calls.resolves[0].recordTypeNatural).toBe('Companies');
    expect(attio.calls.resolves[0].constraintsNatural).toEqual({ any: [{ all: [{ field: 'Name' }] }] });
    expect(attio.calls.resolves[0].recordTypeInternal).toBe('attio:companies');
    expect(attio.calls.resolves[0].constraintsInternal).toEqual({
      any: [{ all: [{ field: 'name' }] }],
    });

    // createRecord: the engine passes the natural type + natural field keys
    // (`Name`/`Description`) with the email source's natural reads (`Subject`/
    // `From`) already resolved to values; the adapter lands the slug + internal
    // attribute ids.
    expect(attio.calls.creates).toHaveLength(1);
    expect(attio.calls.creates[0].recordTypeNatural).toBe('Companies');
    expect(attio.calls.creates[0].fieldsNatural).toEqual({
      Name: 'Acme Corp intro',
      Description: 'Introduced by alice@acme.dev',
    });
    expect(attio.calls.creates[0].recordTypeInternal).toBe('attio:companies');
    expect(attio.calls.creates[0].fieldsInternal).toEqual({
      name: 'Acme Corp intro',
      description: 'Introduced by alice@acme.dev',
    });

    expect(slack.calls.creates[0].recordTypeNatural).toBe('Slack Message');
    expect(slack.calls.creates[0].fieldsNatural).toEqual({
      Message: 'New company: ext-attio-1',
    });
    expect(slack.calls.creates[0].fieldsInternal).toEqual({
      text: 'New company: ext-attio-1',
    });
    // The anchor crosses the boundary as the parent link — WITH the channel
    // position's data (§5.2).
    expect(slack.calls.creates[0].parentLinkNatural).toMatchObject({
      recordType: 'Channel',
      externalId: 'C123',
      edgeName: 'messages',
      data: { id: 'C123', name: 'dealflow' },
    });

    // The firing record carries the engine currency — the NATURAL type names.
    expect(result.writes.map((w) => w.recordType)).toEqual([
      'Companies',
      'Slack Message',
    ]);
  });
});

// ── 2. The KG is not special — natural display names cross the boundary ─────

const KG_FIXTURE = `
import { email, kg } from adapters

inbox = email()
graph = kg()

movement log_round(m: <inbox-[:Email]->>) {
  fr = write graph-[:\`Funding Round\`]-> {
    unique by (\`Name\`)
    \`Name\`:   m.\`Subject\`
    \`Amount\`: 42
  }
  write fr-[:\`Participants\`]-> {
    unique by (fr AND \`Investor Name\`)
    \`Investor Name\`: m.\`From\`
  }
}
`;

describe('kg targets cross the boundary as natural ontology names', () => {
  it('node types, fields, unique-by, linked edges and parentLink all stay natural at the interface', async () => {
    const email = makeResolverFake('email', introspectionBySlug.email);
    const kg = makeResolverFake(KG_ADAPTER_TYPE, introspectionBySlug[KG_ADAPTER_TYPE]);

    const result = await runMovement({
      source: KG_FIXTURE,
      event,
      teamId: TEAM_ID,
      catalog: teamLikeCatalog,
      resolveAdapter: makeResolveAdapter({
        email: email.adapter,
        [KG_ADAPTER_TYPE]: kg.adapter,
      }),
    });

    // Root write: the interface sees the NATURAL node + property names; the
    // adapter resolves to UUIDs.
    expect(kg.calls.resolves[0].recordTypeNatural).toBe('Funding Round');
    expect(kg.calls.resolves[0].constraintsNatural).toEqual({ any: [{ all: [{ field: 'Name' }] }] });
    expect(kg.calls.resolves[0].recordTypeInternal).toBe('nt-round');
    expect(kg.calls.resolves[0].constraintsInternal).toEqual({ any: [{ all: [{ field: 'pt-name' }] }] });
    expect(kg.calls.creates[0].recordTypeNatural).toBe('Funding Round');
    expect(kg.calls.creates[0].fieldsNatural).toEqual({ Name: 'Acme Corp intro', Amount: 42 });
    expect(kg.calls.creates[0].fieldsInternal).toEqual({ 'pt-name': 'Acme Corp intro', 'pt-amount': 42 });

    // Linked write: the child type, the compound-identity edge name, the
    // folded parent and the parentLink all cross as NATURAL names. The
    // edge-scoped fold lands the parent under the EDGE NAME (`Participants`).
    expect(kg.calls.resolves[1].recordTypeNatural).toBe('Round Participation');
    expect(kg.calls.resolves[1].constraintsNatural).toEqual({
      any: [{ all: [{ field: 'Participants' }, { field: 'Investor Name' }] }],
    });
    expect(kg.calls.resolves[1].recordNatural).toEqual({
      'Investor Name': 'alice@acme.dev',
      Participants: { id: `ext-${KG_ADAPTER_TYPE}-1` },
    });
    expect(kg.calls.creates[1].recordTypeNatural).toBe('Round Participation');
    expect(kg.calls.creates[1].fieldsNatural).toEqual({ 'Investor Name': 'alice@acme.dev' });
    expect(kg.calls.creates[1].parentLinkNatural).toEqual({
      recordType: 'Funding Round',
      externalId: `ext-${KG_ADAPTER_TYPE}-1`,
      edgeName: 'Participants',
      data: { marker: `data-${KG_ADAPTER_TYPE}-1` },
    });
    // The parent link carries the parent's OWN data: a handle parent
    // contributes its WriteResult data (message-write-unification §5.2).
    expect(kg.calls.creates[1].parentLinkNatural?.data).toEqual({ marker: 'data-kg-1' });
    // …and the adapter resolves them: child type → UUID, the property
    // constraint → its PropertyTypeId, and the edge-scoped identity component
    // stays the edge name (`Participants` — declared on the parent, the
    // adjacency-search currency), exactly as the engine threaded it.
    expect(kg.calls.creates[1].recordTypeInternal).toBe('nt-part');
    expect(kg.calls.creates[1].fieldsInternal).toEqual({ 'pt-investor': 'alice@acme.dev' });
    expect(kg.calls.resolves[1].constraintsInternal).toEqual({
      any: [{ all: [{ field: 'Participants' }, { field: 'pt-investor' }] }],
    });

    expect(result.writes.map((w) => w.recordType)).toEqual(['Funding Round', 'Round Participation']);
    // Provenance keys follow the engine currency — the natural field names.
    expect(Object.keys(result.writes[0].provenance).sort()).toEqual(['Amount', 'Name']);
  });
});

// ── 3. A name the adapter's introspection doesn't publish throws loud drift ─

const KG_DRIFT_FIXTURE = `
import { email, kg } from adapters

inbox = email()
graph = kg()

movement log_round(m: <inbox-[:Email]->>) {
  write graph-[:\`Ghost Type\`]-> {
    \`Name\`: m.\`Subject\`
  }
}
`;

describe('drift throws loudly (Decision #4)', () => {
  it('a kg type the adapter does not publish fails the run with a MOVENG_RUNTIME drift error', async () => {
    const email = makeResolverFake('email', introspectionBySlug.email);
    const kg = makeResolverFake(KG_ADAPTER_TYPE, introspectionBySlug[KG_ADAPTER_TYPE]);

    // `Ghost Type` is not in the catalog kg schema OR the adapter's
    // introspection — the checker stays silent (untyped) but the adapter's
    // resolver THROWS drift when the engine hands it the natural name.
    await expect(
      runMovement({
        source: KG_DRIFT_FIXTURE,
        event,
        teamId: TEAM_ID,
        // No `Ghost Type` in the graph's schema, but keep the rest so the
        // checker doesn't reject the whole program for an unrelated reason.
        catalog: {
          ...teamLikeCatalog,
          instantiate: (adapter) =>
            adapter === KG_ADAPTER_TYPE
              ? undefined
              : schemasBySlug[adapter as keyof typeof schemasBySlug],
        },
        resolveAdapter: makeResolveAdapter({
          email: email.adapter,
          [KG_ADAPTER_TYPE]: kg.adapter,
        }),
      }),
    ).rejects.toThrow(/known type|drift/i);
  });

  it('the resolver throws AdapterNameDriftError on a missing name — never silently mis-resolves', () => {
    const resolver = adapterNameResolver(introspectionBySlug[KG_ADAPTER_TYPE]);
    expect(() => resolver.typeId(naturalName('Ghost Type'))).toThrow(AdapterNameDriftError);
    expect(() =>
      resolver.fieldId(naturalName('Funding Round'), naturalName('Ghost Field')),
    ).toThrow(AdapterNameDriftError);
    expect(MovementEngineError).toBeDefined();
  });
});
