// The adapter-facing graph API: the `Adapter` contract, transported (K-24).
//
// Every route here exists because a method the movement engine can call on an
// adapter needs a remote equivalent — nothing was designed from first
// principles, so the surface stops growing exactly where the adapter contract
// stops. The consumer is automations' kg adapter, which after D25 reaches the
// graph the way it reaches valuations: over HTTP, with a stored credential.
//
// Two rules run through the whole file:
//
//   - **Ids are the wire currency** (K-5). Node/property/edge TYPE ids identify
//     everything; names ride along for introspection and are never accepted as
//     identity. A display name is renameable, and a persisted trigger routed by
//     name would silently stop matching after a rename.
//   - **One request is one transaction** (K-25). A node arrives with its
//     properties, its edges, its bridge and its evidence in one body and
//     commits atomically; evidence and mutation context travel ON the write
//     (K-27), because a follow-up call could fail independently and would turn
//     provenance back into a convention.
//
// Writes go through the store's write door, never raw SQL — the door owns the
// `writable_by` gate, evidence, change rows and the mutation outbox, so these
// handlers emit no events of their own.

import { randomBytes, randomUUID } from 'node:crypto';

import { Router, type RequestHandler } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { currentPrincipal } from 'principal';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { ResourceId } from '../../../generated/kysely/knowledge/Resource';
import type { NodeTypeId } from '../../../generated/kysely/knowledge/NodeType';
import type { EdgeId } from '../../../generated/kysely/knowledge/Edge';
import type { EdgeTypeId } from '../../../generated/kysely/knowledge/EdgeType';
import type { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';

import { getKnowledgeQb } from '../../../lib/kysely';
import EvidenceType from '../../../generated/kysely/knowledge/EvidenceType';
import { ChangeSource } from '../../../lib/knowledge/changes';
import {
  createNode,
  summarizeNodes,
  deleteNode,
  findCandidates,
  inTransaction,
  lockNaturalKey,
  KnowledgeWriteRefused,
  link,
  openKnowledgeStore,
  projectUniqueness,
  setProperties,
  unlink,
  uniquenessFor,
  type WriteContext,
} from '../../../lib/knowledge/store';
import { MUTATION_EVENT_TYPES } from '../../../lib/knowledge/store/events';
import { readOutboxHealth } from '../../../services/knowledge/mutation_outbox/worker';
import { readArbitrationHealth } from '../../../services/knowledge/arbitration/worker';
import { mutationDelivery } from '../../../services/knowledge/mutation_outbox/delivery_mode';
import { buildRelationshipContextFromDb } from '../../../lib/knowledge/relationship_context';
import { resolveToolTeam, ToolTeamError } from './team_scope';

// ── Errors ─────────────────────────────────────────────────────────────────

function internalError(res: Parameters<RequestHandler>[1], err: unknown) {
  // A team-resolution problem (wrong/missing `team`) is a clean 400 the caller
  // can act on, not an opaque 500.
  if (err instanceof ToolTeamError) {
    return res.status(400).json({ error: err.message, ...(err.teams ? { teams: err.teams } : {}) });
  }
  // A refused write is the ontology answering "this property does not accept
  // writes from that evidence type" — a decision the caller must see and act
  // on, so it never degrades into a 500 and is never quietly skipped.
  if (err instanceof KnowledgeWriteRefused) {
    return res.status(403).json({
      error: 'write_refused',
      message: err.message,
      propertyTypeId: err.propertyTypeId,
    });
  }
  const traceId = randomUUID();
  console.error(`[knowledge-graph-api:${traceId}]`, err);
  return res.status(500).json({
    error: 'internal_error',
    message: 'An internal error occurred.',
    traceId,
  });
}

function invalidBody(res: Parameters<RequestHandler>[1], error: z.ZodError) {
  return res.status(400).json({ error: 'invalid_body', issues: error.issues });
}

const notFound = { error: 'not_found' } as const;

// ── Shared shapes ──────────────────────────────────────────────────────────

const evidenceSchema = z.object({
  type: z.nativeEnum(EvidenceType),
  description: z.string().min(1),
});

const mutationContextSchema = z.record(z.string(), z.unknown());

const propertyWriteSchema = z.object({
  propertyTypeId: z.string().min(1),
  /** `null` clears the property — the door's semantics (D37a), not ours. */
  value: z.unknown(),
  description: z.string().optional(),
});

const edgeAssertionSchema = z.object({
  edgeTypeId: z.string().min(1),
  otherNodeId: z.string().min(1),
  direction: z.enum(['out', 'in']),
});

const bridgeSchema = z.object({
  adapterType: z.string().min(1),
  externalId: z.string().min(1),
  externalObjectType: z.string().nullish(),
});

type EvidenceInput = z.infer<typeof evidenceSchema>;

/**
 * How the change feed should name this write. Declared rather than assumed:
 * `api` is what a client calling this surface directly is, but a movement's
 * graph write reads as `pipeline` in the feed (D37f) and MUST keep reading that
 * way now that it arrives over the same HTTP hop as everything else. Absent it
 * defaults to `api`, so a client that says nothing is described honestly.
 */
const changeSourceSchema = z.nativeEnum(ChangeSource).optional();

/** The door's context, assembled from what rode in on the request. The mutation
 *  context is passed through verbatim: the consumer's echo suppression reads
 *  nothing else, and a stripped bag makes every 2-way sync echo itself (K-29). */
function writeContext(input: {
  teamId: string;
  evidence: EvidenceInput;
  mutationContext?: unknown;
  changeSource?: ChangeSource;
}): WriteContext {
  return {
    teamId: input.teamId as TeamId,
    evidenceType: input.evidence.type,
    changeSource: input.changeSource ?? ChangeSource.api,
    description: input.evidence.description,
    mutationContext: input.mutationContext,
    // Who to name in the change feed. Attribution, not authorisation — the
    // scope check upstream already decided the write may happen. A machine
    // principal (api key, static stub) is nobody in particular and has no
    // `userId` by design, so the change row records no author rather than
    // throwing, which is what reading `Context.user` did to every write here.
    createdBy: currentPrincipal().userId ?? null,
  };
}

function propertyWrites(properties: z.infer<typeof propertyWriteSchema>[]) {
  return properties.map((p) => ({
    propertyTypeId: p.propertyTypeId as PropertyTypeId,
    value: p.value,
    ...(p.description === undefined ? {} : { description: p.description }),
  }));
}

function edgeAssertions(edges: z.infer<typeof edgeAssertionSchema>[] | undefined) {
  return edges?.map((e) => ({
    edgeTypeId: e.edgeTypeId as EdgeTypeId,
    otherNodeId: e.otherNodeId as NodeId,
    direction: e.direction,
  }));
}

function bridgeInput(bridge: z.infer<typeof bridgeSchema> | undefined) {
  return bridge
    ? {
        adapterType: bridge.adapterType,
        externalId: bridge.externalId,
        externalObjectType: bridge.externalObjectType ?? null,
      }
    : undefined;
}

const queryTeam = (req: Parameters<RequestHandler>[0]): string | undefined =>
  typeof req.query.team === 'string' ? req.query.team : undefined;

// ── Reads ──────────────────────────────────────────────────────────────────

const ONTOLOGY_TABLES = ['node_type', 'property_type', 'edge_type'] as const;
const GRAPH_TABLES = ['node', 'property', 'edge'] as const;

interface PropertyValueRow {
  value_text: string | null;
  value_text_array: string[] | null;
  value_number: string | number | null;
  value_boolean: boolean | null;
  value_date: Date | null;
  value_json: unknown;
}

/** One value per property row, from whichever column holds it. Multi-cardinality
 *  text surfaces as `string[]`; single cardinality picks the first non-null. */
function canonicalValue(row: PropertyValueRow): unknown {
  if (row.value_text_array != null) return row.value_text_array;
  if (row.value_text != null && row.value_text !== '') return row.value_text;
  return row.value_number ?? row.value_boolean ?? row.value_date ?? row.value_json ?? null;
}

const PROPERTY_VALUE_COLUMNS = [
  'property.value_text',
  'property.value_text_array',
  'property.value_number',
  'property.value_boolean',
  'property.value_date',
  'property.value_json',
] as const;

async function propertiesByNode(input: {
  teamId: string;
  nodeIds: NodeId[];
}): Promise<Map<string, Record<string, unknown>>> {
  const byNode = new Map<string, Record<string, unknown>>();
  if (input.nodeIds.length === 0) return byNode;
  const rows = await getKnowledgeQb(['property'])
    .selectFrom('property')
    .where('property.team_id', '=', input.teamId)
    .where('property.node_id', 'in', input.nodeIds)
    .select(['property.node_id', 'property.property_type_id', ...PROPERTY_VALUE_COLUMNS])
    .execute();
  for (const row of rows) {
    if (row.node_id === null) continue;
    const bag = byNode.get(row.node_id) ?? {};
    bag[row.property_type_id] = canonicalValue(row);
    byNode.set(row.node_id, bag);
  }
  return byNode;
}

async function propertiesByEdge(input: {
  teamId: string;
  edgeIds: EdgeId[];
}): Promise<Map<string, Record<string, unknown>>> {
  const byEdge = new Map<string, Record<string, unknown>>();
  if (input.edgeIds.length === 0) return byEdge;
  const rows = await getKnowledgeQb(['property'])
    .selectFrom('property')
    .where('property.team_id', '=', input.teamId)
    .where('property.edge_id', 'in', input.edgeIds)
    .select(['property.edge_id', 'property.property_type_id', ...PROPERTY_VALUE_COLUMNS])
    .execute();
  for (const row of rows) {
    if (row.edge_id === null) continue;
    const bag = byEdge.get(row.edge_id) ?? {};
    bag[row.property_type_id] = canonicalValue(row);
    byEdge.set(row.edge_id, bag);
  }
  return byEdge;
}

interface EdgeView {
  edgeId: string;
  edgeTypeId: string;
  direction: 'out' | 'in';
  otherNodeId: string;
  otherNodeTypeId: string;
  properties: Record<string, unknown>;
}

/** The edges touching each of `nodeIds`, keyed by the node they were asked
 *  about — an edge walked from both ends appears once per end, with the
 *  direction that end sees. */
async function edgesByNode(input: {
  teamId: string;
  nodeIds: NodeId[];
  edgeTypeId?: string;
  direction?: 'out' | 'in';
}): Promise<Map<string, EdgeView[]>> {
  const byNode = new Map<string, EdgeView[]>();
  if (input.nodeIds.length === 0) return byNode;

  const qb = getKnowledgeQb(['edge', 'node']);
  const wanted: ('out' | 'in')[] = input.direction ? [input.direction] : ['out', 'in'];

  const rows: { direction: 'out' | 'in'; anchor: string; edge_id: EdgeId; edge_type_id: EdgeTypeId; other_node_id: NodeId; other_node_type_id: NodeTypeId }[] =
    [];

  for (const direction of wanted) {
    // `out` anchors on the source and lands on the target; `in` is the mirror.
    let query = qb
      .selectFrom('edge')
      .innerJoin(
        'node as other',
        'other.id',
        direction === 'out' ? 'edge.target_node_id' : 'edge.source_node_id',
      )
      .where('edge.team_id', '=', input.teamId)
      .where(
        direction === 'out' ? 'edge.source_node_id' : 'edge.target_node_id',
        'in',
        input.nodeIds,
      )
      .select([
        'edge.id as edge_id',
        'edge.edge_type_id',
        'edge.source_node_id',
        'edge.target_node_id',
        'other.id as other_node_id',
        'other.node_type_id as other_node_type_id',
      ]);
    if (input.edgeTypeId !== undefined) {
      query = query.where('edge.edge_type_id', '=', input.edgeTypeId as EdgeTypeId);
    }
    for (const row of await query.execute()) {
      rows.push({
        direction,
        anchor: direction === 'out' ? row.source_node_id : row.target_node_id,
        edge_id: row.edge_id,
        edge_type_id: row.edge_type_id,
        other_node_id: row.other_node_id,
        other_node_type_id: row.other_node_type_id,
      });
    }
  }

  const edgeProperties = await propertiesByEdge({
    teamId: input.teamId,
    edgeIds: rows.map((r) => r.edge_id),
  });

  for (const row of rows) {
    const list = byNode.get(row.anchor) ?? [];
    list.push({
      edgeId: row.edge_id,
      edgeTypeId: row.edge_type_id,
      direction: row.direction,
      otherNodeId: row.other_node_id,
      otherNodeTypeId: row.other_node_type_id,
      properties: edgeProperties.get(row.edge_id) ?? {},
    });
    byNode.set(row.anchor, list);
  }
  return byNode;
}

/** The node-detail shape, for one id or many. Ids that are not this team's are
 *  absent from the result rather than an error — the batch caller wants the
 *  ones that exist, and the single-node route turns an empty result into 404. */
async function nodeDetails(input: { teamId: string; nodeIds: NodeId[] }) {
  const nodes = await getKnowledgeQb(['node'])
    .selectFrom('node')
    .where('node.team_id', '=', input.teamId)
    .where('node.id', 'in', input.nodeIds)
    .select(['node.id', 'node.node_type_id', 'node.summary'])
    .execute();
  if (nodes.length === 0) return [];

  const ids = nodes.map((n) => n.id);
  const [properties, edges] = await Promise.all([
    propertiesByNode({ teamId: input.teamId, nodeIds: ids }),
    edgesByNode({ teamId: input.teamId, nodeIds: ids }),
  ]);

  return nodes.map((n) => ({
    id: n.id,
    nodeTypeId: n.node_type_id,
    summary: n.summary,
    properties: properties.get(n.id) ?? {},
    edges: edges.get(n.id) ?? [],
  }));
}

// ── Ontology ───────────────────────────────────────────────────────────────

const nodeTypeColumns = [
  'id',
  'name',
  'description',
  'category',
  'display_name_template',
  'display_name_expression',
  'uniqueness_constraints',
] as const;

const propertyTypeColumns = [
  'id',
  'name',
  'description',
  'node_type_id',
  'edge_type_id',
  'value_type',
  'cardinality',
  'enum_values',
  'writable_by',
  'evaluation_strategy',
] as const;

const edgeTypeColumns = [
  'id',
  'outbound_name',
  'inbound_name',
  'source_node_type_id',
  'target_node_type_id',
  'required',
  'scopes',
  'filters',
] as const;

type NodeTypeRow = { [K in (typeof nodeTypeColumns)[number]]: unknown } & {
  id: NodeTypeId;
  name: string;
};

function serializeNodeType(row: NodeTypeRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    displayNameTemplate: row.display_name_template,
    displayNameExpression: row.display_name_expression,
    // PROJECTED, never the raw stored jsonb: the stored shape is an expression
    // grammar this unit owns, and a consumer that parsed it would be coupled to
    // the grammar rather than to its answer. What leaves is the opaque
    // OR-of-AND over field ids — the same currency `/dedup-rules` returns.
    uniquenessConstraints: projectUniqueness(row.uniqueness_constraints),
  };
}

function serializePropertyType(row: { [K in (typeof propertyTypeColumns)[number]]: unknown }) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    nodeTypeId: row.node_type_id,
    edgeTypeId: row.edge_type_id,
    valueType: row.value_type,
    cardinality: row.cardinality,
    enumValues: row.enum_values,
    writableBy: row.writable_by,
    evaluationStrategy: row.evaluation_strategy,
  };
}

function serializeEdgeType(row: { [K in (typeof edgeTypeColumns)[number]]: unknown }) {
  return {
    id: row.id,
    outboundName: row.outbound_name,
    inboundName: row.inbound_name,
    sourceNodeTypeId: row.source_node_type_id,
    targetNodeTypeId: row.target_node_type_id,
    required: row.required,
    scopes: row.scopes,
    filters: row.filters,
  };
}

/** The whole model in one call — the checker's catalog build reads it, so a
 *  chatty per-type surface would turn a catalog into N round trips. */
const ontologyHandler: RequestHandler = async (req, res) => {
  try {
    const teamId = await resolveToolTeam(queryTeam(req));
    const qb = getKnowledgeQb(ONTOLOGY_TABLES);
    const [nodeTypes, propertyTypes, edgeTypes] = await Promise.all([
      qb
        .selectFrom('node_type')
        .where('team_id', '=', teamId)
        .select(nodeTypeColumns)
        .orderBy('sort_order')
        .orderBy('name')
        .execute(),
      qb
        .selectFrom('property_type')
        .where('team_id', '=', teamId)
        .select(propertyTypeColumns)
        .orderBy('sort_order')
        .orderBy('name')
        .execute(),
      qb
        .selectFrom('edge_type')
        .where('team_id', '=', teamId)
        .select(edgeTypeColumns)
        .orderBy('sort_order')
        .orderBy('outbound_name')
        .execute(),
    ]);

    return res.status(200).json({
      nodeTypes: nodeTypes.map(serializeNodeType),
      propertyTypes: propertyTypes.map(serializePropertyType),
      edgeTypes: edgeTypes.map(serializeEdgeType),
    });
  } catch (err) {
    return internalError(res, err);
  }
};

/** One node type, with everything a `describe()` of it needs: its own
 *  properties, the edges it can walk in both directions, and the properties
 *  anchored on those edges. */
const nodeTypeHandler: RequestHandler = async (req, res) => {
  try {
    const teamId = await resolveToolTeam(queryTeam(req));
    const nodeTypeId = req.params.nodeTypeId as NodeTypeId;
    const qb = getKnowledgeQb(ONTOLOGY_TABLES);

    const nodeType = await qb
      .selectFrom('node_type')
      .where('team_id', '=', teamId)
      .where('id', '=', nodeTypeId)
      .select(nodeTypeColumns)
      .executeTakeFirst();
    if (!nodeType) return res.status(404).json(notFound);

    const [propertyTypes, edgeTypes] = await Promise.all([
      qb
        .selectFrom('property_type')
        .where('team_id', '=', teamId)
        .where('node_type_id', '=', nodeTypeId)
        .select(propertyTypeColumns)
        .orderBy('sort_order')
        .execute(),
      qb
        .selectFrom('edge_type')
        .where('team_id', '=', teamId)
        .where((eb) =>
          eb.or([
            eb('source_node_type_id', '=', nodeTypeId),
            eb('target_node_type_id', '=', nodeTypeId),
          ]),
        )
        .select(edgeTypeColumns)
        .orderBy('sort_order')
        .execute(),
    ]);

    const edgeTypeIds = edgeTypes.map((e) => e.id);
    const edgePropertyTypes =
      edgeTypeIds.length === 0
        ? []
        : await qb
            .selectFrom('property_type')
            .where('team_id', '=', teamId)
            .where('edge_type_id', 'in', edgeTypeIds)
            .select(propertyTypeColumns)
            .orderBy('sort_order')
            .execute();

    return res.status(200).json({
      nodeType: serializeNodeType(nodeType),
      propertyTypes: propertyTypes.map(serializePropertyType),
      outboundEdgeTypes: edgeTypes
        .filter((e) => e.source_node_type_id === nodeTypeId)
        .map(serializeEdgeType),
      inboundEdgeTypes: edgeTypes
        .filter((e) => e.target_node_type_id === nodeTypeId)
        .map(serializeEdgeType),
      edgePropertyTypes: edgePropertyTypes.map(serializePropertyType),
    });
  } catch (err) {
    return internalError(res, err);
  }
};

// ── Record reads ───────────────────────────────────────────────────────────

const listNodesQuery = z.object({
  nodeTypeId: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  team: z.string().optional(),
});

const listNodesHandler: RequestHandler = async (req, res) => {
  const parsed = listNodesQuery.safeParse(req.query);
  if (!parsed.success) return invalidBody(res, parsed.error);
  const { nodeTypeId, search, limit, offset, team } = parsed.data;

  try {
    const teamId = await resolveToolTeam(team);
    let query = getKnowledgeQb(GRAPH_TABLES)
      .selectFrom('node')
      .where('node.team_id', '=', teamId)
      .select([
        'node.id',
        'node.node_type_id',
        'node.summary',
        'node.created_at',
        'node.updated_at',
      ]);

    if (nodeTypeId !== undefined) {
      query = query.where('node.node_type_id', '=', nodeTypeId as NodeTypeId);
    }
    if (search !== undefined && search !== '') {
      query = query.where(
        sql<boolean>`node.summary_tsvector @@ plainto_tsquery('english', ${search})`,
      );
    }

    const nodes = await query
      .orderBy('node.created_at', 'desc')
      // Id breaks ties. Offset paging over a non-total order can show a row
      // twice and skip another between pages, which for a consumer paging a
      // whole type means a silently wrong collection rather than an error.
      .orderBy('node.id', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    const properties = await propertiesByNode({ teamId, nodeIds: nodes.map((n) => n.id) });

    return res.status(200).json({
      data: nodes.map((n) => ({
        id: n.id,
        nodeTypeId: n.node_type_id,
        summary: n.summary,
        createdAt: n.created_at,
        updatedAt: n.updated_at,
        properties: properties.get(n.id) ?? {},
      })),
      meta: { count: nodes.length, limit, offset },
    });
  } catch (err) {
    return internalError(res, err);
  }
};

const nodeDetailHandler: RequestHandler = async (req, res) => {
  try {
    const teamId = await resolveToolTeam(queryTeam(req));
    const [detail] = await nodeDetails({ teamId, nodeIds: [req.params.id as NodeId] });
    if (!detail) return res.status(404).json(notFound);
    return res.status(200).json(detail);
  } catch (err) {
    return internalError(res, err);
  }
};

const batchNodesSchema = z.object({
  ids: z.array(z.string().min(1)).max(200),
  team: z.string().optional(),
});

const batchNodesHandler: RequestHandler = async (req, res) => {
  const parsed = batchNodesSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error);

  try {
    const teamId = await resolveToolTeam(parsed.data.team);
    const data = await nodeDetails({
      teamId,
      nodeIds: parsed.data.ids as NodeId[],
    });
    return res.status(200).json({ data });
  } catch (err) {
    return internalError(res, err);
  }
};

const nodeEdgesQuery = z.object({
  edgeTypeId: z.string().optional(),
  direction: z.enum(['out', 'in']).optional(),
  team: z.string().optional(),
});

const nodeEdgesHandler: RequestHandler = async (req, res) => {
  const parsed = nodeEdgesQuery.safeParse(req.query);
  if (!parsed.success) return invalidBody(res, parsed.error);

  try {
    const teamId = await resolveToolTeam(parsed.data.team);
    const nodeId = req.params.id as NodeId;
    const node = await getKnowledgeQb(['node'])
      .selectFrom('node')
      .where('node.team_id', '=', teamId)
      .where('node.id', '=', nodeId)
      .select('node.id')
      .executeTakeFirst();
    if (!node) return res.status(404).json(notFound);

    const edges = await edgesByNode({
      teamId,
      nodeIds: [nodeId],
      edgeTypeId: parsed.data.edgeTypeId,
      direction: parsed.data.direction,
    });
    return res.status(200).json({ data: edges.get(nodeId) ?? [] });
  } catch (err) {
    return internalError(res, err);
  }
};

/**
 * The sources attached to a node, as ids.
 *
 * Only the ATTACHMENT is knowledge's — `public.resource` itself belongs to the
 * other side of the boundary, and the consumer already owns it. So this returns
 * the join and stops, rather than reaching across a schema it does not own to
 * assemble a richer answer nobody asked this unit for.
 */
const nodeResourcesHandler: RequestHandler = async (req, res) => {
  try {
    const teamId = await resolveToolTeam(queryTeam(req));
    const rows = await getKnowledgeQb(['node_resource'])
      .selectFrom('node_resource')
      .where('node_resource.team_id', '=', teamId)
      .where('node_resource.node_id', '=', req.params.id as NodeId)
      .select(['node_resource.resource_id'])
      .execute();
    return res.status(200).json({ data: rows.map((r) => ({ resourceId: r.resource_id })) });
  } catch (err) {
    return internalError(res, err);
  }
};

// ── Identity ───────────────────────────────────────────────────────────────

const matchSchema = z.object({
  nodeTypeId: z.string().min(1),
  record: z.record(z.string(), z.unknown()),
  team: z.string().optional(),
});

/**
 * Uniqueness-scoped candidate search.
 *
 * `data` is the candidate's own property bag and `relationships` its adjacency
 * — both passed through for whoever arbitrates, because the arbiter, not this
 * API, decides what a match means. Adjacency rides along because a caller who
 * had to fetch it separately would be walking the graph to answer a question it
 * just asked the graph.
 */
const matchHandler: RequestHandler = async (req, res) => {
  const parsed = matchSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error);

  try {
    const teamId = await resolveToolTeam(parsed.data.team);
    const nodeTypeId = parsed.data.nodeTypeId as NodeTypeId;
    const store = openKnowledgeStore();
    const constraints = await uniquenessFor(store, { teamId, nodeTypeId });
    if (!constraints) return res.status(404).json(notFound);

    const candidates = await findCandidates(store, {
      teamId,
      nodeTypeId,
      constraints,
      record: parsed.data.record,
    });

    // Only worth hydrating when there is something to disambiguate — a single
    // candidate is decided without an arbiter, so its adjacency is waste.
    const withAdjacency =
      candidates.length > 1
        ? await Promise.all(
            candidates.map(async (c) => ({
              ...c,
              relationships: await buildRelationshipContextFromDb({
                nodeId: c.nodeId as NodeId,
                teamId: teamId as TeamId,
              }),
            })),
          )
        : candidates.map((c) => ({ ...c, relationships: [] }));

    return res.status(200).json({ candidates: withAdjacency });
  } catch (err) {
    return internalError(res, err);
  }
};

const dedupRulesHandler: RequestHandler = async (req, res) => {
  try {
    const teamId = await resolveToolTeam(queryTeam(req));
    const constraints = await uniquenessFor(openKnowledgeStore(), {
      teamId,
      nodeTypeId: req.params.nodeTypeId as NodeTypeId,
    });
    if (!constraints) return res.status(404).json(notFound);
    return res.status(200).json({ constraints });
  } catch (err) {
    return internalError(res, err);
  }
};

// ── Writes ─────────────────────────────────────────────────────────────────

const createNodeSchema = z.object({
  nodeTypeId: z.string().min(1),
  properties: z.array(propertyWriteSchema).default([]),
  edges: z.array(edgeAssertionSchema).optional(),
  bridge: bridgeSchema.optional(),
  evidence: evidenceSchema,
  mutationContext: mutationContextSchema.optional(),
  changeSource: changeSourceSchema,
  team: z.string().optional(),
});

const createNodeHandler: RequestHandler = async (req, res) => {
  const parsed = createNodeSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error);
  const body = parsed.data;

  try {
    const teamId = await resolveToolTeam(body.team);
    const { nodeId } = await createNode(openKnowledgeStore(), {
      context: writeContext({ teamId, evidence: body.evidence, mutationContext: body.mutationContext, changeSource: body.changeSource }),
      nodeTypeId: body.nodeTypeId as NodeTypeId,
      properties: propertyWrites(body.properties),
      edges: edgeAssertions(body.edges),
      bridge: bridgeInput(body.bridge),
    });
    // The summary is derived text, so it is regenerated AFTER the write commits
    // and reads persisted rows. The store composes it from its own tables now
    // (D43a); it used to be a second call the adapter made from the far side of
    // the hop.
    await summarizeNodes(openKnowledgeStore(), { teamId, nodeIds: [nodeId] });
    return res.status(200).json({ nodeId });
  } catch (err) {
    return internalError(res, err);
  }
};

const updateNodeSchema = z.object({
  properties: z.array(propertyWriteSchema),
  evidence: evidenceSchema,
  mutationContext: mutationContextSchema.optional(),
  changeSource: changeSourceSchema,
  team: z.string().optional(),
});

/** A `null` value clears the property; the door owns what that means (D37a).
 *  The 404 is load-bearing: the consumer's bind self-heal re-mints a record on
 *  it, and a 500 would look like an outage instead of a missing node. */
const updateNodeHandler: RequestHandler = async (req, res) => {
  const parsed = updateNodeSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error);
  const body = parsed.data;

  try {
    const teamId = await resolveToolTeam(body.team);
    const store = openKnowledgeStore();
    const node = await store
      .selectFrom('node')
      .where('node.team_id', '=', teamId)
      .where('node.id', '=', req.params.id as NodeId)
      .select(['node.id', 'node.node_type_id'])
      .executeTakeFirst();
    if (!node) return res.status(404).json(notFound);

    const written = await setProperties(store, {
      context: writeContext({ teamId, evidence: body.evidence, mutationContext: body.mutationContext, changeSource: body.changeSource }),
      anchor: { kind: 'node', nodeId: node.id, nodeTypeId: node.node_type_id },
      properties: propertyWrites(body.properties),
    });
    await summarizeNodes(store, { teamId, nodeIds: [node.id] });
    return res.status(200).json({ nodeId: node.id, updated: written.length });
  } catch (err) {
    return internalError(res, err);
  }
};

/** Evidence is optional on a delete — no property is written, so the gate never
 *  runs and the evidence type is inert — but the mutation context is not: the
 *  deletion event carries it, and without it the consumer cannot tell its own
 *  delete from someone else's. */
const deleteNodeSchema = z.object({
  evidence: evidenceSchema.optional(),
  mutationContext: mutationContextSchema.optional(),
  changeSource: changeSourceSchema,
  team: z.string().optional(),
});

const DELETE_EVIDENCE: EvidenceInput = {
  type: EvidenceType.user_edit,
  description: 'Deleted through the knowledge API',
};

const deleteNodeHandler: RequestHandler = async (req, res) => {
  const parsed = deleteNodeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalidBody(res, parsed.error);
  const body = parsed.data;

  try {
    const teamId = await resolveToolTeam(body.team);
    const { removed } = await deleteNode(openKnowledgeStore(), {
      context: writeContext({
        teamId,
        evidence: body.evidence ?? DELETE_EVIDENCE,
        mutationContext: body.mutationContext,
        changeSource: body.changeSource,
      }),
      nodeId: req.params.id as NodeId,
    });
    return res.status(200).json({ removed });
  } catch (err) {
    return internalError(res, err);
  }
};

const edgeSchema = z.object({
  edgeTypeId: z.string().min(1),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  evidence: evidenceSchema,
  mutationContext: mutationContextSchema.optional(),
  changeSource: changeSourceSchema,
  team: z.string().optional(),
});

const createEdgeHandler: RequestHandler = async (req, res) => {
  const parsed = edgeSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error);
  const body = parsed.data;

  try {
    const teamId = await resolveToolTeam(body.team);
    const { edgeId, created } = await link(openKnowledgeStore(), {
      context: writeContext({ teamId, evidence: body.evidence, mutationContext: body.mutationContext, changeSource: body.changeSource }),
      edgeTypeId: body.edgeTypeId as EdgeTypeId,
      sourceNodeId: body.sourceNodeId as NodeId,
      targetNodeId: body.targetNodeId as NodeId,
    });
    return res.status(200).json({ edgeId, created });
  } catch (err) {
    return internalError(res, err);
  }
};

const deleteEdgeHandler: RequestHandler = async (req, res) => {
  const parsed = edgeSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error);
  const body = parsed.data;

  try {
    const teamId = await resolveToolTeam(body.team);
    const { removed } = await unlink(openKnowledgeStore(), {
      context: writeContext({ teamId, evidence: body.evidence, mutationContext: body.mutationContext, changeSource: body.changeSource }),
      edgeTypeId: body.edgeTypeId as EdgeTypeId,
      sourceNodeId: body.sourceNodeId as NodeId,
      targetNodeId: body.targetNodeId as NodeId,
    });
    return res.status(200).json({ removed });
  } catch (err) {
    return internalError(res, err);
  }
};

/**
 * Edge-anchored property write — the same door call as `PATCH /nodes/:id`, on
 * the other anchor the door accepts.
 *
 * It exists because a property can be a fact about a RELATIONSHIP rather than
 * about either end of it ("this person's title AT this company"), and the
 * adapter has been writing those since W4-KG3. The route was the one piece of
 * the write surface the read-side rebuild left unbuilt.
 */
const updateEdgeSchema = z.object({
  properties: z.array(propertyWriteSchema),
  evidence: evidenceSchema,
  mutationContext: mutationContextSchema.optional(),
  changeSource: changeSourceSchema,
  team: z.string().optional(),
});

const updateEdgeHandler: RequestHandler = async (req, res) => {
  const parsed = updateEdgeSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error);
  const body = parsed.data;

  try {
    const teamId = await resolveToolTeam(body.team);
    const store = openKnowledgeStore();
    const edge = await store
      .selectFrom('edge')
      .where('edge.team_id', '=', teamId)
      .where('edge.id', '=', req.params.id as EdgeId)
      .select(['edge.id'])
      .executeTakeFirst();
    if (!edge) return res.status(404).json(notFound);

    const written = await setProperties(store, {
      context: writeContext({
        teamId,
        evidence: body.evidence,
        mutationContext: body.mutationContext,
        changeSource: body.changeSource,
      }),
      anchor: { kind: 'edge', edgeId: edge.id },
      properties: propertyWrites(body.properties),
    });
    return res.status(200).json({ edgeId: edge.id, updated: written.length });
  } catch (err) {
    return internalError(res, err);
  }
};

/**
 * Attach a resource to a node — the knowledge HALF of resource provenance.
 *
 * The resource row is minted or resolved by the CALLER, which then posts its
 * id; what knowledge owns is the LINK (which node a resource informs, and at
 * what offsets) and the facts extracted from it, so that is exactly what this
 * takes. Idempotent by (node, resource), because re-delivering the same
 * resource to the same node across a run must collapse rather than accumulate.
 *
 * Phase 5.4 changed one thing here: `resource` moved INTO this schema
 * (D48(i)), so the link's FK is back and a posted id that names no resource is
 * now a referential-integrity error rather than a dangling row. The handler
 * checks first and answers 404, so the caller learns which id was wrong
 * instead of reading a constraint name out of a 500.
 */
const nodeResourceSchema = z.object({
  resourceId: z.string().min(1),
  startOffset: z.number().int().nullish(),
  endOffset: z.number().int().nullish(),
  /** The source text this link points at, resolved by the CALLER — the resource
   *  row is theirs, the link and what it quotes are ours (D43a). Copied at link
   *  time so the summary never has to read back across the boundary. */
  excerpt: z.string().nullish(),
  facts: z
    .array(z.object({ subject: z.string(), predicate: z.string(), object: z.string() }))
    .default([]),
  team: z.string().optional(),
});

const attachNodeResourceHandler: RequestHandler = async (req, res) => {
  const parsed = nodeResourceSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error);
  const body = parsed.data;

  try {
    const teamId = await resolveToolTeam(body.team);
    const nodeId = req.params.id as NodeId;
    const resourceId = body.resourceId as ResourceId;
    const qb = getKnowledgeQb(['node', 'node_resource', 'extraction_fact', 'resource']);

    const node = await qb
      .selectFrom('node')
      .where('node.team_id', '=', teamId)
      .where('node.id', '=', nodeId)
      .select(['node.id'])
      .executeTakeFirst();
    if (!node) return res.status(404).json(notFound);

    const resource = await qb
      .selectFrom('resource')
      .where('resource.id', '=', resourceId)
      .select(['resource.id'])
      .executeTakeFirst();
    if (!resource) return res.status(404).json(notFound);

    await qb.transaction().execute(async (trx) => {
      await trx
        .insertInto('node_resource')
        .values({
          team_id: teamId as TeamId,
          node_id: nodeId,
          resource_id: resourceId,
          start_offset: body.startOffset ?? null,
          end_offset: body.endOffset ?? null,
          excerpt: body.excerpt ?? null,
        })
        .onConflict((oc) => oc.columns(['node_id', 'resource_id']).doNothing())
        .execute();

      for (const fact of body.facts) {
        await trx
          .insertInto('extraction_fact')
          .values({
            team_id: teamId as TeamId,
            message_node_id: nodeId,
            resource_id: resourceId,
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
          })
          .execute();
      }
    });

    // A new quote changes what the node says about itself. (The store handle
    // rather than `qb`: the summary reads the type and property tables too.)
    await summarizeNodes(openKnowledgeStore(), { teamId, nodeIds: [nodeId] });
    return res.status(200).json({ nodeId, resourceId: body.resourceId });
  } catch (err) {
    return internalError(res, err);
  }
};

// ── Upsert (K-26) ──────────────────────────────────────────────────────────

const upsertSchema = createNodeSchema.extend({
  record: z.record(z.string(), z.unknown()),
});

type UpsertOutcome =
  | { kind: 'written'; nodeId: string; created: boolean }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unknown_type' };

/**
 * Match-and-write in one request AND in one transaction.
 *
 * The adapter's `resolveEntity` → `createRecord` sequence is two calls and
 * therefore already racy; over HTTP the window would widen by a round trip, so
 * it folds into one. Folding the REQUEST was only half of it: while the search
 * opened its own handle the match still ran outside the write's transaction, so
 * two simultaneous upserts of the same natural key could both find nothing and
 * both create. The search now takes `trx` — the read and the write it decides
 * are one transaction, which is what K-26 actually asked for.
 *
 * More than one candidate writes NOTHING: guessing which record to overwrite is
 * exactly the failure this endpoint exists to remove.
 */
const upsertHandler: RequestHandler = async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error);
  const body = parsed.data;

  try {
    const teamId = await resolveToolTeam(body.team);
    const nodeTypeId = body.nodeTypeId as NodeTypeId;
    const context = writeContext({
      teamId,
      evidence: body.evidence,
      mutationContext: body.mutationContext,
    });

    const outcome = await inTransaction(openKnowledgeStore(), async (trx): Promise<UpsertOutcome> => {
      const constraints = await uniquenessFor(trx, { teamId, nodeTypeId });
      if (!constraints) return { kind: 'unknown_type' };

      // Everyone upserting this key waits here. Without it the match and the
      // write are atomic but not exclusive: concurrent transactions cannot see
      // each other's un-committed insert, so they all match nothing and all
      // create (measured — six concurrent upserts produced three nodes).
      await lockNaturalKey(trx, { teamId, nodeTypeId, constraints, record: body.record });

      const candidates = await findCandidates(trx, {
        teamId,
        nodeTypeId,
        constraints,
        record: body.record,
      });
      if (candidates.length > 1) {
        return { kind: 'ambiguous', candidates: candidates.map((c) => c.nodeId) };
      }

      if (candidates.length === 1) {
        const nodeId = candidates[0].nodeId as NodeId;
        await setProperties(trx, {
          context,
          anchor: { kind: 'node', nodeId, nodeTypeId },
          properties: propertyWrites(body.properties),
        });
        return { kind: 'written', nodeId, created: false };
      }

      const { nodeId } = await createNode(trx, {
        context,
        nodeTypeId,
        properties: propertyWrites(body.properties),
        edges: edgeAssertions(body.edges),
        bridge: bridgeInput(body.bridge),
      });
      return { kind: 'written', nodeId, created: true };
    });

    if (outcome.kind === 'unknown_type') return res.status(404).json(notFound);
    if (outcome.kind === 'ambiguous') {
      return res.status(409).json({ error: 'ambiguous_match', candidates: outcome.candidates });
    }
    await summarizeNodes(openKnowledgeStore(), { teamId, nodeIds: [outcome.nodeId as NodeId] });
    return res.status(200).json({ nodeId: outcome.nodeId, created: outcome.created });
  } catch (err) {
    return internalError(res, err);
  }
};

// ── Subscriptions (K-28) ───────────────────────────────────────────────────

const registerWebhookSchema = z.object({
  url: z.string().url(),
  eventTypes: z.array(z.enum([...MUTATION_EVENT_TYPES])).optional(),
  secret: z.string().min(16).optional(),
  team: z.string().optional(),
});

/** Idempotent by URL, because the consumer re-registers whenever a listen's
 *  event selection changes. An empty selection means every event type. */
const registerWebhookHandler: RequestHandler = async (req, res) => {
  const parsed = registerWebhookSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error);
  const body = parsed.data;

  // D39(c): exactly one delivery path per deployment. This one delivers
  // in-process, so the drainer will never post here — accepting the row would
  // hand back a subscription that silently never fires, which is the state the
  // whole ruling exists to prevent. Refuse it and say why. (In normal operation
  // this is unreachable: an adapter on a composed deployment does not advertise
  // the subscription methods at all, so nothing asks.)
  if (mutationDelivery() === 'local') {
    return res.status(400).json({
      error: 'delivery_is_local',
      message:
        'This deployment delivers graph mutations in-process, so a webhook ' +
        'subscription would never fire. Set KNOWLEDGE_MUTATION_DELIVERY=webhook ' +
        'to deliver by webhook instead.',
    });
  }

  try {
    const teamId = await resolveToolTeam(body.team);
    const eventTypes = body.eventTypes ?? [];
    const row = await getKnowledgeQb(['webhook_endpoint'])
      .insertInto('webhook_endpoint')
      .values({
        team_id: teamId,
        url: body.url,
        event_types: eventTypes,
        secret: body.secret ?? randomBytes(32).toString('hex'),
      })
      .onConflict((oc) =>
        oc.columns(['team_id', 'url']).doUpdateSet({
          event_types: eventTypes,
          // Re-registration keeps the secret the caller already verifies
          // against unless it explicitly supplies a new one.
          ...(body.secret === undefined ? {} : { secret: body.secret }),
          updated_at: new Date(),
        }),
      )
      .returning(['id', 'url', 'event_types', 'secret', 'created_at'])
      .executeTakeFirstOrThrow();

    return res.status(200).json({
      id: row.id,
      url: row.url,
      eventTypes: row.event_types,
      secret: row.secret,
      createdAt: row.created_at,
    });
  } catch (err) {
    return internalError(res, err);
  }
};

const listWebhooksHandler: RequestHandler = async (req, res) => {
  try {
    const teamId = await resolveToolTeam(queryTeam(req));
    const rows = await getKnowledgeQb(['webhook_endpoint'])
      .selectFrom('webhook_endpoint')
      .where('team_id', '=', teamId)
      .select(['id', 'url', 'event_types', 'created_at'])
      .orderBy('created_at')
      .execute();

    return res.status(200).json({
      // No secrets on a list: a list is read far more often than it is acted
      // on, and the secret is only ever needed by whoever registered it.
      data: rows.map((r) => ({
        id: r.id,
        url: r.url,
        eventTypes: r.event_types,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    return internalError(res, err);
  }
};

const deleteWebhookQuery = z.object({
  url: z.string().url(),
  team: z.string().optional(),
});

const deleteWebhookHandler: RequestHandler = async (req, res) => {
  const parsed = deleteWebhookQuery.safeParse(req.query);
  if (!parsed.success) return invalidBody(res, parsed.error);

  try {
    const teamId = await resolveToolTeam(parsed.data.team);
    const deleted = await getKnowledgeQb(['webhook_endpoint'])
      .deleteFrom('webhook_endpoint')
      .where('team_id', '=', teamId)
      .where('url', '=', parsed.data.url)
      .returning('id')
      .execute();
    return res.status(200).json({ deleted: deleted.length });
  } catch (err) {
    return internalError(res, err);
  }
};

// ── Health ─────────────────────────────────────────────────────────────────

/** Worker liveness. The outbox is the only emission path out of the unit
 *  (K-29), so a stalled drainer means every subscriber has silently stopped
 *  hearing about mutations — a state that has to be readable from outside.
 *
 *  `delivery` rides along because in a SPLIT deployment the two processes hold
 *  the mode independently: a consumer that thinks it should register webhooks
 *  against an instance that delivers in-process has a config disagreement, and
 *  this is where it becomes visible instead of becoming silence.
 *
 *  `arbitration` is the same argument for the other worker: with no model key
 *  configured, `evaluation_strategy: llm` properties keep whatever value landed
 *  last and the queue grows. That is a supported way to run the store — but only
 *  because `llmConfigured: false` and a rising `pending` say so out loud (D42). */
const healthHandler: RequestHandler = async (_req, res) => {
  try {
    return res.status(200).json({
      delivery: mutationDelivery(),
      outbox: await readOutboxHealth(),
      arbitration: await readArbitrationHealth(),
    });
  } catch (err) {
    return internalError(res, err);
  }
};

// ── Mount ──────────────────────────────────────────────────────────────────

export function mountKnowledgeGraphRoutes(router: Router): void {
  router.get('/ontology', ontologyHandler);
  router.get('/ontology/:nodeTypeId', nodeTypeHandler);

  router.get('/nodes', listNodesHandler);
  router.post('/nodes/batch', batchNodesHandler);
  router.post('/nodes/match', matchHandler);
  router.post('/nodes/upsert', upsertHandler);
  router.post('/nodes', createNodeHandler);
  router.get('/nodes/:id', nodeDetailHandler);
  router.get('/nodes/:id/edges', nodeEdgesHandler);
  router.get('/nodes/:id/resources', nodeResourcesHandler);
  router.post('/nodes/:id/resources', attachNodeResourceHandler);
  router.patch('/nodes/:id', updateNodeHandler);
  router.delete('/nodes/:id', deleteNodeHandler);

  router.get('/dedup-rules/:nodeTypeId', dedupRulesHandler);

  router.post('/edges', createEdgeHandler);
  router.delete('/edges', deleteEdgeHandler);
  router.patch('/edges/:id', updateEdgeHandler);

  router.post('/webhooks', registerWebhookHandler);
  router.get('/webhooks', listWebhooksHandler);
  router.delete('/webhooks', deleteWebhookHandler);

  router.get('/health', healthHandler);
}
