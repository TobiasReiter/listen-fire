/**
 * Unit tests for the KG adapter's schema + resource paths, across the TWO
 * seams the adapter now has (D25):
 *
 *   - **Reads go over HTTP.** The ontology and a node's attachments are
 *     fetched from `/api/v1/knowledge/graph/*` with a stored credential, so
 *     they are served here by a fake graph server standing in for `fetch`.
 *     The client itself (`kg_client`) is REAL — only credential loading is
 *     stubbed — so the URL, query and auth header each read builds are the
 *     adapter's own behaviour under test, not a mock's opinion of it.
 *   - **Writes still go through the in-process store door.** Resource
 *     persistence (`persistKgResources`) is unchanged, so it keeps the
 *     in-memory kysely mock that records inserts and serves selects from the
 *     recorded state — the same pattern as `apply.unit.test.ts`.
 *
 * The two seams share state deliberately: the fake server answers "what is
 * attached to this node" out of the same in-memory `node_resource` rows the
 * write path fills, so the write→read roundtrip still means what it meant when
 * both halves were SQL.
 *
 * Verifies:
 *
 *   1. `describe()` projects the fetched ontology — edge write promises in
 *      both directions, and the read-only `#resources` edge.
 *   2. `persistKgResources` writes a `public.resource` row, a
 *      `knowledge.node_resource` link, and `knowledge.extraction_fact` rows.
 *   3. The round-trip: a resource written that way is then readable by walking
 *      the `#resources` reference.
 *
 * No real DB and no real network is involved.
 */

import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ResourceId } from '../../../generated/kysely/knowledge/Resource';
import type { Resource, Fact } from '../adapter';
import type { WireNodeType, WireOntology } from '../adapters/kg_client';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../generated/kysely/knowledge/EvidenceType', () => ({
  __esModule: true,
  default: {
    extraction: 'extraction',
    user_edit: 'user_edit',
    retrieval: 'retrieval',
    input_mapping: 'input_mapping',
  },
}));

// `translation_graph/types.ts` transitively loads
// `knowledge_pipeline/output_v3/schemas`, which pulls in the
// webhook/slack output chain. That chain has a circular zod import
// that crashes at test load time (a pre-existing baseline issue).
// The KG adapter only needs the type-level surface of those schemas,
// so stub them. A chainable zod-shape stub that returns itself from
// every method — we don't validate anything in this suite; types.ts
// just needs the chain operations to not crash at module load.
// Inlined into the factory because factories are hoisted above
// top-level declarations.
jest.mock('../../knowledge_pipeline/output_v3/schemas', () => {
  const stub: Record<string, unknown> = {};
  const ret = () => stub;
  Object.assign(stub, {
    optional: ret, nullable: ret, default: ret, array: ret,
    parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }),
    refine: ret, transform: ret, extend: ret, merge: ret,
    pick: ret, omit: ret, partial: ret, describe: ret, or: ret, and: ret,
  });
  return {
    traversalStepSchema: stub,
    fieldRefSchema: stub,
    expressionSchema: stub,
    filterExpressionSchema: stub,
    webhookGraphOutputConfigSchema: stub,
  };
});

// `knowledge_graph_writes` pulls in the knowledge store + mutation_context,
// which transitively crash on the same load chain. We don't exercise
// createRecord / updateRecord in this suite.
jest.mock('../adapters/knowledge_graph_writes', () => ({
  createKgRecord: jest.fn(),
  updateKgRecord: jest.fn(),
}));

jest.mock('../../../generated/kysely/knowledge/ResourceType', () => ({
  __esModule: true,
  default: { URL: 'URL', EMAIL: 'EMAIL', WHATSAPP: 'WHATSAPP', FILE: 'FILE', TEXT: 'TEXT' },
}));

// The graph client is REAL — building the request IS adapter behaviour, and a
// module mock here would stop proving it. Only credential loading is stubbed:
// that is an encrypted row in someone else's table, and nothing about which URL
// a read dials depends on how the credential was decrypted.
jest.mock('../adapters/kg_client', () => {
  const actual = jest.requireActual('../adapters/kg_client');
  return {
    __esModule: true,
    ...actual,
    loadKgCredentials: jest.fn(async () => ({
      apiKey: 'kg-test-key',
      baseUrl: 'https://graph.test',
    })),
  };
});

// ── In-memory DB state behind the kysely mock (the WRITE door) ──────────────

type Row = Record<string, unknown>;
type ResourceRow = Row & {
  id: string;
  team_id: string;
  type: string;
  url: string | null;
  name: string;
  metadata: unknown;
  raw_text_id?: string | null;
};
// The source-text side of a resource's excerpt (D43a) — a separate table on
// this side of the boundary, joined by `excerptFor` in
// knowledge_graph_resources.ts. No test currently seeds a row here, so the
// join always resolves to zero matches, same as a resource with no body.
type RawTextRow = Row & {
  id: string;
  content: string;
};
type NodeResourceRow = Row & {
  id: string;
  team_id: string;
  node_id: string;
  resource_id: string;
};
type PropertyRow = Row & {
  id: string;
  team_id: string;
  node_id: string;
  property_type_id: string;
};
type EvidenceRow = Row & {
  id: string;
  team_id: string;
  property_id: string;
  resource_id: string;
  type: string;
  description: string;
};
type ExtractionFactRow = Row & {
  id: string;
  team_id: string;
  message_node_id: string;
  resource_id: string;
  subject: string;
  predicate: string;
  object: string;
};

interface DbState {
  resources: ResourceRow[];
  nodeResources: NodeResourceRow[];
  properties: PropertyRow[];
  evidence: EvidenceRow[];
  extractionFacts: ExtractionFactRow[];
  rawText: RawTextRow[];
}

const dbState: DbState = {
  resources: [],
  nodeResources: [],
  properties: [],
  evidence: [],
  extractionFacts: [],
  rawText: [],
};

function resetDbState() {
  dbState.resources.length = 0;
  dbState.nodeResources.length = 0;
  dbState.properties.length = 0;
  dbState.evidence.length = 0;
  dbState.extractionFacts.length = 0;
  dbState.rawText.length = 0;
}

// Counters for auto-generated PKs.
let evidenceCounter = 0;
let factCounter = 0;
let nodeResourceCounter = 0;

// Conditions captured along a chained .where() call.
interface Condition {
  column: string;
  op: string;
  value: unknown;
}

// A captured `.innerJoin(table, leftCol, rightCol)` — only `resource ⋈
// raw_text` (excerptFor, D43a) exercises this today.
interface Join {
  table: string;
  leftCol: string;
  rightCol: string;
}

interface OpCtx {
  table: string;
  op: string;
  values?: Record<string, unknown>;
  conditions: Condition[];
  joins: Join[];
  selectColumns?: string[];
}

function makeChain(opCtx: OpCtx) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    values: (v: Record<string, unknown>) => {
      opCtx.values = v;
      return chain;
    },
    where: (col: string, cmp: string, val: unknown) => {
      opCtx.conditions.push({ column: col, op: cmp, value: val });
      return chain;
    },
    innerJoin: (table: string, leftCol: string, rightCol: string) => {
      opCtx.joins.push({ table, leftCol, rightCol });
      return chain;
    },
    select: (cols?: string[]) => {
      if (cols) opCtx.selectColumns = cols;
      return chain;
    },
    selectAll: () => chain,
    orderBy: () => chain,
    returning: () => chain,
    onConflict: () => chain,
    columns: () => chain,
    doNothing: () => chain,
    execute: async () => {
      return runOp(opCtx);
    },
    executeTakeFirst: async () => {
      const rows = await runOp(opCtx);
      return rows[0];
    },
    executeTakeFirstOrThrow: async () => {
      const rows = await runOp(opCtx);
      if (!rows[0]) throw new Error(`expected at least one row from ${opCtx.table}`);
      return rows[0];
    },
  });
  return chain;
}

function matchesAllConditions<T extends Record<string, unknown>>(row: T, conditions: Condition[], stripTablePrefix = true): boolean {
  for (const c of conditions) {
    const col = stripTablePrefix ? c.column.split('.').pop() ?? c.column : c.column;
    if (c.op === 'in') {
      const vs = c.value as unknown[];
      if (!vs.includes(row[col])) return false;
    } else if (c.op === '=') {
      if (row[col] !== c.value) return false;
    }
  }
  return true;
}

function runOp(opCtx: OpCtx): Promise<Array<Record<string, unknown>>> {
  if (opCtx.op === 'insert') {
    const v = opCtx.values ?? {};
    switch (opCtx.table) {
      case 'resource': {
        // W3-B2: caller may omit `id` and rely on the column default
        // (gen_random_uuid in Postgres); the in-memory mock mints a
        // deterministic stand-in so tests can still assert against it.
        const id = v.id !== undefined ? String(v.id) : `res-mint-${dbState.resources.length + 1}`;
        const row = {
          id,
          team_id: String(v.team_id),
          type: String(v.type),
          url: (v.url as string | null) ?? null,
          name: String(v.name),
          metadata: v.metadata ?? {},
          external_id: (v.external_id as string | null) ?? null,
          external_adapter_type: (v.external_adapter_type as string | null) ?? null,
        };
        dbState.resources.push(row);
        // Return the row so `.returning(...).executeTakeFirstOrThrow()`
        // sees the materialised id.
        return Promise.resolve([row as unknown as Record<string, unknown>]);
      }
      case 'node_resource':
        dbState.nodeResources.push({
          id: `nr-${++nodeResourceCounter}`,
          team_id: String(v.team_id),
          node_id: String(v.node_id),
          resource_id: String(v.resource_id),
        });
        break;
      case 'evidence':
        dbState.evidence.push({
          id: `ev-${++evidenceCounter}`,
          team_id: String(v.team_id),
          property_id: String(v.property_id),
          resource_id: String(v.resource_id),
          type: String(v.type),
          description: String(v.description),
        });
        break;
      case 'extraction_fact':
        dbState.extractionFacts.push({
          id: `f-${++factCounter}`,
          team_id: String(v.team_id),
          message_node_id: String(v.message_node_id),
          resource_id: String(v.resource_id),
          subject: String(v.subject),
          predicate: String(v.predicate),
          object: String(v.object),
        });
        break;
    }
    return Promise.resolve([]);
  }

  if (opCtx.op === 'select') {
    switch (opCtx.table) {
      case 'resource': {
        const matched = dbState.resources.filter((r) => matchesAllConditions(r, opCtx.conditions));
        // `excerptFor` (D43a) inner-joins to `raw_text` — genuinely absent
        // for every resource this test double creates (none set
        // raw_text_id), so the join drops the row, same as production would
        // for a resource with no body.
        const rawTextJoin = opCtx.joins.find((j) => j.table === 'raw_text');
        if (!rawTextJoin) return Promise.resolve(matched);
        const joined = matched.flatMap((r) => {
          const rawText = dbState.rawText.find((rt) => rt.id === r.raw_text_id);
          return rawText ? [{ ...r, content: rawText.content }] : [];
        });
        if (!opCtx.selectColumns) return Promise.resolve(joined);
        return Promise.resolve(
          joined.map((row) => {
            const projected: Record<string, unknown> = {};
            for (const col of opCtx.selectColumns ?? []) {
              const key = col.split('.').pop() ?? col;
              projected[key] = (row as Record<string, unknown>)[key];
            }
            return projected;
          }),
        );
      }
      case 'node_resource':
        return Promise.resolve(dbState.nodeResources.filter((r) => matchesAllConditions(r, opCtx.conditions)));
      case 'property':
        return Promise.resolve(dbState.properties.filter((r) => matchesAllConditions(r, opCtx.conditions)));
      case 'evidence':
        return Promise.resolve(dbState.evidence.filter((r) => matchesAllConditions(r, opCtx.conditions)));
      case 'extraction_fact':
        return Promise.resolve(dbState.extractionFacts.filter((r) => matchesAllConditions(r, opCtx.conditions)));
    }
  }

  return Promise.resolve([]);
}

// A "qb" object exposes selectFrom/insertInto + transaction. The transaction
// just runs the callback with the same qb-like trx so writes route through
// the same in-memory state.
function makeQbLike() {
  const qb = {
    selectFrom: (table: string) => makeChain({ table, op: 'select', conditions: [], joins: [] }),
    insertInto: (table: string) => makeChain({ table, op: 'insert', conditions: [], joins: [] }),
    transaction: () => ({
      execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(qb),
    }),
  };
  return qb;
}

jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => makeQbLike()),
  getQb: jest.fn(() => makeQbLike()),
  getCoreQb: jest.fn(() => makeQbLike()),
  getAutomationsQb: jest.fn(() => makeQbLike()),
}));

// ---------------------------------------------------------------------------
// Subject under test (loaded after mocks are in place)
// ---------------------------------------------------------------------------

import { KnowledgeGraphAdapter, KG_ADAPTER_TYPE, KG_RESOURCE_TYPE_ID, KG_RESOURCES_EDGE_NAME } from '../adapters/knowledge_graph';
import { persistKgResources } from '../adapters/knowledge_graph_resources';
import { RESOURCES_REFERENCE_FIELD_ID, type ResourceFilter } from '../adapter';
import { makeStablePosition } from '../types';
import { surfaceReadAdapter } from '../../movement_engine/kg';
import { instanceSchemaFromDescriptors } from '../movement/schema_projection';
import type { InstanceSchema } from 'movement-lang';

/** A schema whose `Message` declares the knowledge graph's resources edge, as
 *  the projection flags it. */
const resourcesSchema: InstanceSchema = {
  positions: {
    Message: { properties: {}, edges: { [KG_RESOURCES_EDGE_NAME]: { target: KG_RESOURCE_TYPE_ID, resources: true } } },
    [KG_RESOURCE_TYPE_ID]: { properties: { Name: 'text', URL: 'text', Type: 'text' }, edges: {} },
  },
  collections: {},
  writableRoots: {},
};
import type { SourcePosition } from '../types';

const TEAM_ID = 'team-1' as TeamId;
const KG_CREDENTIALS_ID = 'kg-credential-1';

// ── The fake graph server (the READ seam) ──────────────────────────────────
//
// Stands in for `fetch`, routing on the same paths `knowledge_graph_api.ts`
// mounts. Every request is recorded, so a test whose point is the REQUEST the
// adapter makes — which URL, which query, which credential — can assert it.

interface GraphRequest {
  method: string;
  /** Relative to `/api/v1/knowledge/graph`, as the client's own paths are. */
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | null;
}

const graphRequests: GraphRequest[] = [];

/** The model this team's graph publishes — seeded per test. */
let graphOntology: WireOntology = { nodeTypes: [], propertyTypes: [], edgeTypes: [] };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fakeGraph = jest.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const path = url.pathname.replace('/api/v1/knowledge/graph', '');
  const headers = (init?.headers ?? {}) as Record<string, string>;
  graphRequests.push({
    method: init?.method ?? 'GET',
    path,
    query: Object.fromEntries(url.searchParams.entries()),
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    authorization: headers.Authorization ?? null,
  });

  if (path === '/ontology') return jsonResponse(200, graphOntology);

  const attachments = /^\/nodes\/([^/]+)\/resources$/.exec(path);
  if (attachments) {
    const nodeId = attachments[1];
    if (init?.method === 'POST') {
      // Persist the node-resource link on the knowledge side (4d_resources.md).
      const body = JSON.parse(String(init.body)) as { resourceId: string; facts?: Array<{ subject: string; predicate: string; object: string }> };
      dbState.nodeResources.push({
        id: `nr-${++nodeResourceCounter}`,
        team_id: TEAM_ID,
        node_id: nodeId,
        resource_id: body.resourceId,
      });
      // Persist facts as extraction_fact rows (4d_resources.md).
      if (body.facts && body.facts.length > 0) {
        for (const fact of body.facts) {
          dbState.extractionFacts.push({
            id: `f-${++factCounter}`,
            team_id: TEAM_ID,
            message_node_id: nodeId,
            resource_id: body.resourceId,
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
          });
        }
      }
      // The POST side returns 204 No Content.
      return jsonResponse(204, undefined);
    }
    // The ATTACHMENT is the graph's; the resource row itself is this side's
    // table — the same split the real endpoint makes.
    return jsonResponse(200, {
      data: dbState.nodeResources
        .filter((r) => r.node_id === nodeId)
        .map((r) => ({ resourceId: r.resource_id })),
    });
  }

  // An ontology edge read: no edges in these fixtures, only the request.
  if (/^\/nodes\/[^/]+\/edges$/.test(path)) return jsonResponse(200, { data: [] });

  return jsonResponse(404, { error: 'not_found' });
});

global.fetch = fakeGraph as unknown as typeof fetch;

function makeAdapter(): KnowledgeGraphAdapter {
  return new KnowledgeGraphAdapter({ teamId: TEAM_ID, credentialsId: KG_CREDENTIALS_ID });
}

/** A wire node type with only the parts a test cares about spelled out. */
function wireNodeType(input: Partial<WireNodeType> & { id: string; name: string }): WireNodeType {
  return {
    description: null,
    category: null,
    displayNameTemplate: null,
    displayNameExpression: null,
    uniquenessConstraints: { any: [] },
    ...input,
  };
}

/**
 * Resource persistence is `persistKgResources` (4d_resources.md) — the
 * per-node helper KG create/update call. The old `writeResource` adapter method
 * is gone; this shim preserves the original tests' call shape (target.nodeId +
 * side-channel facts) by folding the facts onto `Resource.facts`, exactly as
 * the engine now does before the write.
 */
async function writeResourceVia(input: {
  target: { nodeId: string };
  resource: Resource;
  facts: Fact[];
}): Promise<void> {
  await persistKgResources({
    connection: {
      creds: { apiKey: 'test-key', baseUrl: 'https://test.local' },
      ontology: { nodeTypes: [], propertyTypes: [], edgeTypes: [] },
    },
    teamId: TEAM_ID,
    nodeId: input.target.nodeId,
    resources: [{ ...input.resource, facts: input.facts }],
  });
}

/**
 * Resolve a node's resources the way the engine does: walk the `#resources`
 * reference via `getRelated`, read the `Resource` off each result's `data`,
 * then apply the author `ResourceFilter` post-hoc (filter inlined to keep
 * this heavily-mocked module free of the engine helper's import chain).
 */
async function getResourcesVia(
  adapter: KnowledgeGraphAdapter,
  input: { position: SourcePosition; filter?: ResourceFilter },
): Promise<Resource[]> {
  const related = await adapter.getRelated({
    position: input.position,
    fieldId: RESOURCES_REFERENCE_FIELD_ID,
    direction: 'outgoing',
  });
  const resources = related.map((r) => r.position.identity.data as Resource);
  const f = input.filter;
  if (!f) return resources;
  return resources.filter((r) => {
    if (f.resourceType && r.type !== f.resourceType) return false;
    if (f.mimeType && r.contentType !== f.mimeType) return false;
    if (f.hasDocument && !r.url) return false;
    if (f.namePattern) {
      try {
        if (!new RegExp(f.namePattern).test(String(r.name ?? ''))) return false;
      } catch {
        return false;
      }
    }
    return true;
  });
}

const MSG_NODE_ID = 'msg-node-1' as NodeId;
const RESOURCE_ID = 'resource-1' as ResourceId;

beforeEach(() => {
  resetDbState();
  evidenceCounter = 0;
  factCounter = 0;
  nodeResourceCounter = 0;
  graphOntology = { nodeTypes: [], propertyTypes: [], edgeTypes: [] };
  graphRequests.length = 0;
  fakeGraph.mockClear();
});

describe('KnowledgeGraphAdapter — the connection is what makes a read possible', () => {
  it('refuses to read without one — an unconnected graph is an error, never an empty one', async () => {
    const adapter = new KnowledgeGraphAdapter({ teamId: TEAM_ID });
    await expect(adapter.describe('Company')).rejects.toThrow(/no connection/i);
    expect(fakeGraph).not.toHaveBeenCalled();
  });
});

describe('KnowledgeGraphAdapter — describe(`Attached Resource`)', () => {
  it('gives the `#resources` edge target a minimal honest descriptor (its real populated fields)', async () => {
    const adapter = makeAdapter();
    // Synthetic target of every node type's `#resources` edge — not an ontology
    // node type, so it would render undescribed without this branch. The branch
    // short-circuits before the graph is reached at all.
    const desc = await adapter.describe(KG_RESOURCE_TYPE_ID);
    expect(desc).not.toBeNull();
    expect(desc?.typeId).toBe(KG_RESOURCE_TYPE_ID);
    expect(desc?.displayName).toBe(KG_RESOURCE_TYPE_ID);
    expect(desc?.fields.map((f) => f.fieldId)).toEqual(['name', 'url', 'type']);
    // Read-only, and no invented fields (the always-null lazy document_url /
    // content are deliberately absent).
    expect(desc?.fields.every((f) => f.writable === false)).toBe(true);
    expect(desc?.references).toEqual([]);
    expect(fakeGraph).not.toHaveBeenCalled();
  });
});

describe('KnowledgeGraphAdapter — describe() edge write promises', () => {
  // One ontology edge, Company -[employs]-> Person, seen from both ends.
  function seedOntology(): void {
    graphOntology.nodeTypes.push(
      wireNodeType({ id: 'nt-company', name: 'Company' }),
      wireNodeType({ id: 'nt-person', name: 'Person' }),
    );
    graphOntology.edgeTypes.push({
      id: 'et-employs',
      sourceNodeTypeId: 'nt-company',
      targetNodeTypeId: 'nt-person',
      outboundName: 'employs',
      inboundName: 'works for',
      required: null,
      scopes: null,
      filters: null,
    });
  }

  it('asks the graph for the whole model, team-scoped and credentialled — once per instance', async () => {
    seedOntology();
    const adapter = makeAdapter();
    await adapter.describe('Company');
    await adapter.describe('Person');

    // Two describes, ONE ontology request: every schema question is a
    // projection of the same cached response.
    expect(graphRequests).toHaveLength(1);
    expect(graphRequests[0]).toMatchObject({
      method: 'GET',
      path: '/ontology',
      query: { team: TEAM_ID },
      authorization: 'Bearer kg-test-key',
    });
    expect(String(fakeGraph.mock.calls[0][0])).toBe(
      `https://graph.test/api/v1/knowledge/graph/ontology?team=${TEAM_ID}`,
    );
  });

  it('declares `writable: true` on an OUTGOING ontology edge — the write path resolves it by `outbound_name`', async () => {
    seedOntology();
    const desc = await makeAdapter().describe('Company');
    const employs = desc?.references.find((r) => r.name === 'employs');
    expect(employs?.targetTypeId).toBe('Person');
    expect(employs?.writable).toBe(true);
  });

  it('declares `writable: true` on an INCOMING ontology edge too — `resolveParentLinkEdgeType` matches `inbound_name` symmetrically', async () => {
    seedOntology();
    const desc = await makeAdapter().describe('Person');
    const worksFor = desc?.references.find((r) => r.name === 'works for');
    expect(worksFor?.targetTypeId).toBe('Company');
    expect(worksFor?.writable).toBe(true);
  });

  it('leaves the `#resources` edge with NO write promise — resources attach as write provenance, not along an edge', async () => {
    seedOntology();
    const desc = await makeAdapter().describe('Company');
    const resources = desc?.references.find((r) => r.fieldId === RESOURCES_REFERENCE_FIELD_ID);
    expect(resources?.targetTypeId).toBe(KG_RESOURCE_TYPE_ID);
    expect(resources?.writable).toBeUndefined();
  });
});

describe('KnowledgeGraphAdapter — getResources / writeResource / writeEvidence', () => {
  it('writeResource persists a resource row, a node_resource link, and facts (evidence flows via writeEvidence post-W3-A1.1)', async () => {
    const resource: Resource = {
      id: RESOURCE_ID,
      type: 'TEXT',
      name: 'inbound message body',
      content: 'Alice met Bob at the conference.',
      metadata: { channel: 'slack' },
    };

    const facts: Fact[] = [
      { s: 'Alice', p: 'met', o: 'Bob' },
      { s: 'Bob', p: 'attended', o: 'conference', t: '2026-05' },
    ];

    await writeResourceVia({
      target: { nodeId: MSG_NODE_ID as string },
      resource,
      facts,
    });

    // 1. Resource row landed.
    expect(dbState.resources).toHaveLength(1);
    expect(dbState.resources[0]).toMatchObject({
      id: RESOURCE_ID,
      team_id: TEAM_ID,
      type: 'TEXT',
      name: 'inbound message body',
    });

    // 2. node_resource link.
    expect(dbState.nodeResources).toHaveLength(1);
    expect(dbState.nodeResources[0]).toMatchObject({
      node_id: MSG_NODE_ID,
      resource_id: RESOURCE_ID,
      team_id: TEAM_ID,
    });

    // 3. Evidence is NOT written by writeResource — it flows through
    //    writeEvidence post-structural-write. See the writeEvidence
    //    tests below.
    expect(dbState.evidence).toHaveLength(0);

    // 4. Both facts persisted, anchored to message node + resource.
    expect(dbState.extractionFacts).toHaveLength(2);
    expect(dbState.extractionFacts.map((f) => ({ s: f.subject, p: f.predicate, o: f.object }))).toEqual([
      { s: 'Alice', p: 'met', o: 'Bob' },
      { s: 'Bob', p: 'attended', o: 'conference' },
    ]);
    expect(dbState.extractionFacts.every((f) => f.message_node_id === MSG_NODE_ID && f.resource_id === RESOURCE_ID)).toBe(true);
  });

  it('writeResource is idempotent on resource id — does not duplicate the row on re-run', async () => {
    const args = {
      target: { nodeId: MSG_NODE_ID as string },
      resource: { id: RESOURCE_ID, type: 'TEXT' as const, name: 'r' },
      facts: [],
    };

    await writeResourceVia(args);
    await writeResourceVia(args);

    // Resource row written once (the second call sees existing → skip).
    expect(dbState.resources).toHaveLength(1);
  });

  // ── W3-B2 contract: external id is separate from internal UUID ──────────
  it('writeResource generates a fresh UUID for non-UUID externalId and persists the external handle', async () => {
    // The Slack `ts` (a string like "1747836000.000100") is not a UUID.
    // It must NOT land in resource.id; it must land in resource.external_id.
    // Resource.id should be the column default (mock mints "res-mint-N").
    await writeResourceVia({
      target: { nodeId: MSG_NODE_ID as string },
      resource: {
        externalId: '1747836000.000100',
        provenance: { adapterType: 'slack', externalId: 'ts-1', recordType: 'slack:message', data: {} },
        type: 'TEXT',
        name: 'inbound slack',
        content: 'hello',
      },
      facts: [],
    });

    expect(dbState.resources).toHaveLength(1);
    const row = dbState.resources[0];
    // (a) Resource.id is a fresh UUID (mock mints — the production path
    //     defers to Postgres' gen_random_uuid() default).
    expect(row.id).toBe('res-mint-1');
    // (b) externalId persists in the new typed column.
    expect((row as Record<string, unknown>).external_id).toBe('1747836000.000100');
    expect((row as Record<string, unknown>).external_adapter_type).toBe('slack');
  });

  it('writeResource is idempotent on (team, adapter, externalId) — second call reuses the same row', async () => {
    const resourceShape = {
      externalId: 'slack:1747836000.000100:body',
      provenance: { adapterType: 'slack', externalId: 'ts-2', data: {} },
      type: 'TEXT' as const,
      name: 'inbound slack',
      content: 'hello',
    };

    await writeResourceVia({
      target: { nodeId: MSG_NODE_ID as string },
      resource: resourceShape,
      facts: [],
    });
    await writeResourceVia({
      target: { nodeId: MSG_NODE_ID as string },
      resource: resourceShape,
      facts: [],
    });

    // (c) Re-write returns same Resource row — the second call must
    // resolve via the (team, adapter, externalId) lookup, NOT insert a
    // duplicate row.
    expect(dbState.resources).toHaveLength(1);
    expect((dbState.resources[0] as Record<string, unknown>).external_id)
      .toBe('slack:1747836000.000100:body');
  });

  it('writeResource defaults the resource name when caller omits it', async () => {
    await writeResourceVia({
      target: { nodeId: MSG_NODE_ID as string },
      resource: { id: RESOURCE_ID, url: 'https://example.com/x' },
      facts: [],
    });

    expect(dbState.resources[0].name).toBe('https://example.com/x');
    expect(dbState.resources[0].url).toBe('https://example.com/x');
    // type defaults to TEXT when caller omits it.
    expect(dbState.resources[0].type).toBe('TEXT');
  });

  it('getResources asks the graph which sources are attached, then reads the rows locally', async () => {
    // Seed the state to simulate a prior writeResource roundtrip: the
    // attachment (the graph's) and the resource row (this side's).
    dbState.resources.push({
      id: RESOURCE_ID as string,
      team_id: TEAM_ID as string,
      type: 'FILE',
      url: 'https://files/x.pdf',
      name: 'briefing.pdf',
      metadata: {},
    });
    dbState.nodeResources.push({
      id: 'nr-seed',
      team_id: TEAM_ID as string,
      node_id: MSG_NODE_ID as string,
      resource_id: RESOURCE_ID as string,
    });

    const adapter = makeAdapter();

    const resources = await getResourcesVia(adapter, {
      position: makeStablePosition({ adapterType: KG_ADAPTER_TYPE, recordType: null, recordId: MSG_NODE_ID as string }),
    });

    // The attachment question went over the wire, addressed by node id and
    // scoped to the team.
    expect(graphRequests).toEqual([
      {
        method: 'GET',
        path: `/nodes/${MSG_NODE_ID}/resources`,
        query: { team: TEAM_ID },
        body: undefined,
        authorization: 'Bearer kg-test-key',
      },
    ]);

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      id: RESOURCE_ID,
      type: 'FILE',
      name: 'briefing.pdf',
      url: 'https://files/x.pdf',
    });
    // The eagerly materialised data bag carries the same standard
    // fields so getResourceFieldValue is a local lookup.
    expect(resources[0].data).toMatchObject({
      name: 'briefing.pdf',
      url: 'https://files/x.pdf',
      type: 'FILE',
    });
  });

  it('`Resources` is an ordinary edge: walked by its name, each landing reads its fields off itself', async () => {
    // Language version 5: a node's resources are `c-[f:Resources]-> { … f.URL … }`
    // — the edge the describe declares, by its name (no `_resources` keying).
    dbState.resources.push({
      id: RESOURCE_ID as string,
      team_id: TEAM_ID as string,
      type: 'URL',
      url: 'https://acme.test/deck',
      name: 'Acme deck',
      metadata: {},
    });
    dbState.nodeResources.push({
      id: 'nr-by-name',
      team_id: TEAM_ID as string,
      node_id: MSG_NODE_ID as string,
      resource_id: RESOURCE_ID as string,
    });
    // Walked as the engine walks it: through the read wrapper, which sends
    // the schema's resources edge by its reserved fieldId (its address).
    const adapter = surfaceReadAdapter({ inner: makeAdapter(), schema: resourcesSchema });
    const related = await adapter.getRelated({
      position: makeStablePosition({ adapterType: KG_ADAPTER_TYPE, recordType: 'Message', recordId: MSG_NODE_ID as string }),
      fieldId: KG_RESOURCES_EDGE_NAME,
      direction: 'outgoing',
    });
    expect(related).toHaveLength(1);
    expect(related[0].position.recordType).toBe(KG_RESOURCE_TYPE_ID);
    const read = (fieldId: string) => adapter.getFieldValue({ position: related[0].position, fieldId });
    expect(await read('Name')).toBe('Acme deck');
    expect(await read('URL')).toBe('https://acme.test/deck');
    expect(await read('Type')).toBe('URL');
    // The field reads are local — only the attachment list crossed the wire.
    expect(graphRequests).toHaveLength(1);
  });

  it('an ontology edge named `Resources` is the ontology\'s: matched by address, never by the display name', async () => {
    graphOntology.nodeTypes.push(
      wireNodeType({ id: 'nt-company', name: 'Company' }),
      wireNodeType({ id: 'nt-doc', name: 'Doc' }),
    );
    graphOntology.edgeTypes.push({
      id: 'et-resources',
      sourceNodeTypeId: 'nt-company',
      targetNodeTypeId: 'nt-doc',
      outboundName: KG_RESOURCES_EDGE_NAME,
      inboundName: 'resource of',
      required: null,
      scopes: null,
      filters: null,
    });
    dbState.nodeResources.push({
      id: 'nr-shadow',
      team_id: TEAM_ID as string,
      node_id: MSG_NODE_ID as string,
      resource_id: RESOURCE_ID as string,
    });
    const from = makeStablePosition({ adapterType: KG_ADAPTER_TYPE, recordType: 'Company', recordId: MSG_NODE_ID as string });
    // Bare, and through the wrapper over the projected schema (where the
    // ontology's edge holds the name): the ontology lookup, every time.
    const projected = instanceSchemaFromDescriptors({
      adapterType: KG_ADAPTER_TYPE,
      entries: [{ typeId: 'Company', displayName: 'Company', readable: true, writable: true }],
      descriptors: new Map([['Company', (await makeAdapter().describe('Company'))!]]),
      supportsInPlaceUpdate: false,
    });
    expect(projected.schema.positions['Company'].edges[KG_RESOURCES_EDGE_NAME]?.resources).toBeUndefined();
    for (const adapter of [makeAdapter(), surfaceReadAdapter({ inner: makeAdapter(), schema: projected.schema })]) {
      graphRequests.length = 0;
      await adapter.getRelated({ position: from, fieldId: KG_RESOURCES_EDGE_NAME, direction: 'outgoing' });
      expect(graphRequests.map((r) => r.path)).not.toContain(`/nodes/${MSG_NODE_ID}/resources`);
      expect(graphRequests.find((r) => r.path === `/nodes/${MSG_NODE_ID}/edges`)?.query.edgeTypeId).toBe('et-resources');
    }
    // The node's attachments stay reachable by the reserved fieldId.
    graphRequests.length = 0;
    await makeAdapter().getRelated({ position: from, fieldId: RESOURCES_REFERENCE_FIELD_ID, direction: 'outgoing' });
    expect(graphRequests.map((r) => r.path)).toContain(`/nodes/${MSG_NODE_ID}/resources`);
  });

  it('roundtrip: writeResource → getResources returns the written resource, with facts persisted alongside', async () => {
    const adapter = makeAdapter();

    await writeResourceVia({
      target: { nodeId: MSG_NODE_ID as string },
      resource: {
        id: RESOURCE_ID,
        type: 'TEXT',
        name: 'Alice met Bob.',
      },
      facts: [{ s: 'Alice', p: 'met', o: 'Bob' }],
    });

    const readBack = await getResourcesVia(adapter, {
      position: makeStablePosition({ adapterType: KG_ADAPTER_TYPE, recordType: null, recordId: MSG_NODE_ID as string }),
    });

    expect(readBack).toHaveLength(1);
    expect(readBack[0].id).toBe(RESOURCE_ID);
    expect(readBack[0].type).toBe('TEXT');
    expect(readBack[0].name).toBe('Alice met Bob.');

    // Per-field evidence now persists inline via createRecord (3b §3.3),
    // exercised end-to-end by wave1-golden-path.integration.test; the
    // resource roundtrip here only carries facts.
    expect(dbState.extractionFacts).toHaveLength(1);
    expect(dbState.extractionFacts[0]).toMatchObject({
      subject: 'Alice',
      predicate: 'met',
      object: 'Bob',
      resource_id: RESOURCE_ID,
    });
  });

  it('getResources filters by resourceType', async () => {
    dbState.resources.push(
      {
        id: 'r-text',
        team_id: TEAM_ID as string,
        type: 'TEXT',
        url: null,
        name: 'note',
        metadata: {},
      },
      {
        id: 'r-file',
        team_id: TEAM_ID as string,
        type: 'FILE',
        url: 'https://files/x.pdf',
        name: 'attachment',
        metadata: {},
      },
    );
    dbState.nodeResources.push(
      { id: 'nr-a', team_id: TEAM_ID as string, node_id: MSG_NODE_ID as string, resource_id: 'r-text' },
      { id: 'nr-b', team_id: TEAM_ID as string, node_id: MSG_NODE_ID as string, resource_id: 'r-file' },
    );

    const adapter = makeAdapter();

    const onlyFiles = await getResourcesVia(adapter, {
      position: makeStablePosition({ adapterType: KG_ADAPTER_TYPE, recordType: null, recordId: MSG_NODE_ID as string }),
      filter: { resourceType: 'FILE' },
    });

    expect(onlyFiles).toHaveLength(1);
    expect(onlyFiles[0].id).toBe('r-file');
  });
});
