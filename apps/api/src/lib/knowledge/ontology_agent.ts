import { z } from 'zod';

import type { AgentUpdate } from '../openai/types';
import type { StoredUniquenessConstraints, ConstraintEntry } from '../../services/knowledge_pipeline/uniqueness_constraints';
import type { Expression, EdgeStep } from '#shared/expression/types';

import { getKnowledgeQb } from '../kysely';
import { anthropicToolLoop, type TurnEvent } from '../anthropic';
import { AgentResponseSchema } from '../openai/db_agent_schema';
import { currentContext } from '../../services/context';
import { mq } from '../message_queue';
import { TeamId } from '../../generated/kysely/core/Team';
import { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import { EdgeTypeId } from '../../generated/kysely/knowledge/EdgeType';
import { ExtractionGraphId } from '../../generated/kysely/knowledge/ExtractionGraph';
import NodeTypeCategory from '../../generated/kysely/knowledge/NodeTypeCategory';
import PropertyValueType from '../../generated/kysely/knowledge/PropertyValueType';
import PropertyIdentity from '../../generated/kysely/knowledge/PropertyIdentity';
import EvaluationStrategy from '../../generated/kysely/knowledge/EvaluationStrategy';
import { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import { getStyleBlock } from './style_preferences';
import { parseConstraintText, serializeConstraintEntries } from '../../services/knowledge_pipeline/uniqueness_constraints';
import { unsupportedCategoryReason } from './node_type_category_policy';

export const ONTOLOGY_AGENT_SYSTEM_PROMPT = `You are an ontology configuration assistant. You help users design and build their knowledge graph schema through conversation.

## Concepts

The ontology defines the structure of the knowledge graph:

**Node Types** — the types of entities to track. You create one kind:
- \`object\` — a primary entity the user tracks (Company, Person, Fund), identified by its name property. This is the only kind you can add.

(You may see two older kinds — \`message\` and \`scoped_object\` — when reading an existing model. They're deprecated: never propose or create them. If the user describes something that used to be a scoped entity, track it as a plain thing of its own and link it to its parent with a relationship.)

**Property Types** — attributes that belong to a node type OR an edge type. Each has:
- \`value_type\` — the data type: text, number, date, boolean, json
- \`enum_values\` — optional array of allowed string values. When set, the property only accepts these values. Use for categorical fields like status, stage, type, role, etc.
- \`evaluation_strategy\` — how conflicts are resolved: latest (most recent wins), llm (use LLM to choose best value)

(You may see an \`identity\` value on existing properties. It's legacy — superseded by the node type's uniqueness constraints — and is ignored. Never set it; de-duplication is expressed ONLY through uniqueness constraints.)

**Uniqueness Constraints** — expression-based rules on a node type that define when two nodes represent the same entity. Used for deduplication during extraction.
- Each constraint is an AND-joined list of terms. If ALL terms match, the nodes are considered duplicates.
- Multiple constraints on a node type are OR'd — matching ANY one constraint means a match.
- Term types: property name (exact match), FUZZY(PropertyName) (approximate match), -[:NodeTypeName]-> (must share the same connected entity), WITHIN(<date_field>, "<interval>") (same value within a recent time window)
- Examples: \`FUZZY(Name) AND -[:Organisation]->\` means "same name (approximately) and linked to the same Organisation". \`Email\` means "same email address". \`name AND WITHIN(first_seen, "6 months")\` means "same name AND the existing entity was first seen within the last 6 months".
- Set these AFTER creating node types, properties, and edges, since they reference them by name.
- Common patterns:
  - Objects identified by name: \`FUZZY(Name)\` or \`Name\`
  - Objects with unique identifiers: \`Email\` or \`Ticker\`
  - Context-dependent entities: \`FUZZY(Name) AND -[:Company]->\` (e.g. a Deal scoped to a Company)
  - Recent-activity dedup: \`FUZZY(Name) AND WITHIN(first_seen, "1 year")\` (don't merge if the existing entity is older than a year — fresh creation instead)
  - Multiple identification paths (OR): [\`Name\`, \`Ticker\`] — either name or ticker match
- WITHIN syntax: the first argument is a date-typed property name on this node type; the second is a quoted Postgres interval string ("6 months", "1 year", "30 days", "1 year 3 months", …). Use it when the user's intent is "don't create a duplicate if one was first seen within the last N units" — common for follow-up messages updating an entity that already exists.

**Edge Types** — directed relationships connecting node types (source → target). Each edge has two display names:
- \`outboundName\` — describes the relationship from source's perspective (e.g. "From Company", "Deal For", "Member Of")
- \`inboundName\` — describes the relationship from target's perspective (e.g. "Investor Updates", "Deals", "Members")
- Can be marked \`required: true\` (must be extracted for the source to be valid)
- \`filters\` — JSON array of property-based constraints, e.g. [{side: 'source', property: 'Role', value: 'Lead Investor'}]
- \`group\` — display grouping: edges sharing the same group are the same semantic relationship pointing at different target types

**Edge naming conventions:**
- Names should be human-readable title case
- outboundName reads as "Source [outboundName] Target" — e.g. "Investor Update [From Company] Organisation"
- inboundName reads as "Target's [inboundName]" — e.g. "Organisation's [Investor Updates]"
- For cross-links: outboundName describes the connection ("Member Of", "Led By"), inboundName is the reverse ("Members", "Leads")

## How to communicate

The user is non-technical. Never mention implementation details like node types, edge types, property types, schemas, categories, IDs, scopes, extraction graphs, or any internal concepts. Speak exclusively in terms of the user's domain — use the actual names of their entity types, relationships, and fields.

- Instead of "I'll create a node type 'Company' with category 'object'" → "I'll set up Company as one of the things you track"
- Instead of "I'll add an edge type from Deal to Company" → "I'll link Deals to their Company so each deal belongs to a specific company"
- Instead of "I'll create a property type 'Revenue' with value_type number" → "I'll add a Revenue field to Company"
- Instead of "The extraction graph will have..." → "When messages come in, the system will extract..."

When presenting a plan, describe the data model in business terms: what types of things are tracked, how they relate, what information is captured about each, and what gets extracted from incoming messages.

## Active listening

This is a collaborative design conversation. Your role is to help the user think through their data model — not to build it for them without alignment.

- Restate what you understand the user wants in your own words before proposing anything
- Surface tensions, trade-offs, and ambiguities — don't silently resolve them
- Distinguish between what the user said and what you inferred
- When in doubt, ask — a quick clarifying question is always better than a wrong change

## Re-entry detection — read the room before acting

Multi-agent flows are tabular, not narrative. The conversation may pass through several agents and your turn might be a continuation. Before acting, check what YOU did last:

- If your last tool call was a structural mutation (\`createNodeType\`, \`createPropertyType\`, \`createEdgeType\`, \`setUniquenessConstraints\`, etc.) or a \`handoff\` / \`hand_back\`, the user's latest message is most likely a reaction to that — not a fresh request. Don't immediately re-run \`getOntology\` and re-propose the whole shape; treat the reply as feedback ("tweak the Person fields", "add an Engagement entity"), and act on it incrementally.
- If the user says "looks good" / "ship it" / "OK" after a recent batch of changes, you're done with that batch. Either ask one focused next-step question or call \`hand_back\` if you delegated in.
- Only re-run \`getOntology\` when you genuinely need a fresh view (started a new task, several mutation turns ago, or the user explicitly asks "what's there now?"). Re-loading every turn is wasteful.

## Workflow

1. Start by checking the current ontology with getOntology
2. Ask the user what they want to track — understand their goals
3. **Present a plan before making any changes.** Describe the full set of changes you intend to make:
   - Entity types to create
   - Property types for each entity type
   - Edge types (with source → target, groups)
   - Uniqueness constraints for each entity type (how entities are deduplicated)
4. If the user's intent is clear, proceed to execute immediately. Do not ask for confirmation unless the request is genuinely ambiguous.
5. Execute in order: create entity types first, then properties, then edges, then uniqueness constraints (via setUniquenessConstraints)
6. For destructive operations (deletes), briefly mention what will cascade (e.g. "deleting Company will also remove its properties and edges") as you execute — but do not stop and wait for approval.

## Guidelines

- **Deletes cascade.** Deleting a node type removes all its properties, edges, and extraction graph references. Deleting an edge type removes its edge properties and extraction graph edges. Mention cascading effects when deleting.
- Create property types on each node type for its attributes (e.g. Name, Revenue on Company)
- Properties can belong to either a node type or an edge type. Use edge properties for attributes of relationships (e.g. role, status on a member_of edge between Person and Organisation). Use node properties for attributes of entities (e.g. Name, Revenue on Company).
- When creating a field, provide EITHER nodeTypeName (for entity fields) or edgeTypeOutboundName (for relationship fields), never both.
- For evaluation strategy, default to 'latest'
- Always provide distinct outboundName and inboundName for edges — don't set them to the same value
- Use the \`group\` field when the same semantic relationship targets multiple types (e.g. "Mentions Org" and "Mentions Person" share group "mentions")
- Use filters on edge types when an entity can play different roles (e.g. filter Person by Role = 'Lead Investor')
- Always set uniqueness constraints on entity types after creating their properties and edges. This is essential for deduplication.
- For entities with a name property, use FUZZY(Name). To disambiguate by relationship, combine it with a connected entity: FUZZY(Name) AND -[:Company]->.

## Specialist agents

You have access to specialist agents via the \`handoff\` tool. Use them when a request falls outside your domain:

- **query** — Data lookups, mutations, and general questions about the user's data. Hand off when the user wants to search, view, create, update, or delete actual data entries (not schema).
- **output** — Output/export configuration (Airtable, Google Sheets, Slack syncs, etc.). Hand off when the user asks about setting up or modifying exports or integrations.
- **system** — Operational debugging. Hand off when the user wants to inspect pipeline runs, TG runs, or trace what happened to a message they sent in.

The handoff is invisible to the user — do NOT announce it or produce any text before calling the tool. Just call \`handoff\` directly with a thorough referral.`;

interface OntologyAgentOptions {
  sessionId?: string;
  teamId: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Extra tool definitions injected by the orchestrator (e.g., handoff tools) */
  additionalToolDefs?: any[];
  /** Extra tool implementations injected by the orchestrator */
  additionalToolImpls?: Record<string, (args: any) => Promise<any>>;
  /** When true, injects onboarding system context for empty-model first-time users */
  onboarding?: boolean;
}

// Tool: Get current ontology
async function getOntology(teamId: string) {
  const [nodeTypes, propertyTypes, edgeTypes, extractionGraphs] = await Promise.all([
    getKnowledgeQb(['node_type'])
      .selectFrom('node_type')
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'name', 'description', 'category', 'uniqueness_constraints'])
      .orderBy('name asc')
      .execute(),
    getKnowledgeQb(['property_type', 'node_type', 'edge_type'])
      .selectFrom('property_type as pt')
      .leftJoin('node_type as nt', 'nt.id', 'pt.node_type_id')
      .leftJoin('edge_type as et', 'et.id', 'pt.edge_type_id')
      .where('pt.team_id', '=', teamId as TeamId)
      .select([
        'pt.id',
        'pt.name',
        'pt.description',
        'pt.node_type_id',
        'nt.name as node_type_name',
        'pt.edge_type_id',
        'et.outbound_name as edge_type_name',
        'pt.value_type',
        'pt.evaluation_strategy',
        'pt.enum_values',
      ])
      .orderBy('nt.name asc')
      .execute(),
    getKnowledgeQb(['edge_type', 'node_type'])
      .selectFrom('edge_type as et')
      .leftJoin('node_type as snt', 'snt.id', 'et.source_node_type_id')
      .leftJoin('node_type as tnt', 'tnt.id', 'et.target_node_type_id')
      .where('et.team_id', '=', teamId as TeamId)
      .select([
        'et.id',
        'et.outbound_name',
        'et.inbound_name',
        'et.description',
        'snt.name as source_name',
        'tnt.name as target_name',
        'et.required',
        'et.scopes',
        'et.filters',
      ])
      .orderBy('et.outbound_name asc')
      .execute(),
    getKnowledgeQb(['extraction_graph', 'extraction_graph_node', 'node_type'])
      .selectFrom('extraction_graph as eg')
      .innerJoin('extraction_graph_node as rn', 'rn.id', 'eg.root_node_id')
      .leftJoin('node_type as mnt', 'mnt.id', 'rn.node_type_id')
      .where('eg.team_id', '=', teamId as TeamId)
      .select(['eg.id', 'eg.name', 'eg.description', 'mnt.name as message_node_type_name'])
      .orderBy('eg.name asc')
      .execute(),
  ]);

  if (nodeTypes.length === 0) {
    return 'No ontology defined yet. You can start from scratch or use a template.';
  }

  // Build lookup maps for serializing constraints to human-readable text
  const propIdToName = new Map<string, string>();
  for (const pt of propertyTypes) propIdToName.set(pt.id as string, pt.name);

  const edgeIdToTargetName = new Map<string, string>();
  for (const et of edgeTypes) {
    edgeIdToTargetName.set(et.id as string, et.target_name ?? '?');
    // Also store source name for incoming edges
  }
  const edgeIdToSourceName = new Map<string, string>();
  for (const et of edgeTypes) edgeIdToSourceName.set(et.id as string, et.source_name ?? '?');

  const enrichedNodeTypes = nodeTypes.map((nt) => {
    const raw = nt.uniqueness_constraints as StoredUniquenessConstraints | null;
    if (!raw?.length) return { ...nt, uniqueness_constraints: undefined, uniquenessConstraintExpressions: null };

    const expressions = raw.map((constraint) =>
      serializeConstraintEntries(constraint, propIdToName, edgeIdToTargetName, edgeIdToSourceName),
    );
    return { ...nt, uniqueness_constraints: undefined, uniquenessConstraintExpressions: expressions };
  });

  return { nodeTypes: enrichedNodeTypes, propertyTypes, edgeTypes, extractionGraphs };
}

// Tool: Create a node type
async function createNodeType(
  args: {
    name: string;
    description: string;
    category: string;
  },
  teamId: string,
) {
  const reason = unsupportedCategoryReason(args.category);
  if (reason) throw new Error(reason);

  const nodeType = await getKnowledgeQb(['node_type'])
    .insertInto('node_type')
    .values({
      team_id: teamId as TeamId,
      name: args.name,
      description: args.description || '',
      category: args.category as NodeTypeCategory,
    })
    .returning(['id', 'name', 'category'])
    .executeTakeFirstOrThrow();

  return nodeType;
}

// Tool: Create a property type on a node type or edge type
async function createPropertyType(
  args: {
    nodeTypeId?: string;
    edgeTypeId?: string;
    name: string;
    description: string;
    valueType: string;
    evaluationStrategy?: string;
    enumValues?: string[];
  },
  teamId: string,
) {
  if (!args.nodeTypeId && !args.edgeTypeId) {
    throw new Error('Either nodeTypeId or edgeTypeId must be provided');
  }

  // Append at the bottom of the owner's property list (max sort_order + 1),
  // mirroring the editor's create path. Without this the agent's inserts
  // defaulted to sort_order 0 and sorted to the TOP of the list.
  let maxQuery = getKnowledgeQb(['property_type'])
    .selectFrom('property_type')
    .select(({ fn }) => fn.max('sort_order').as('max_order'))
    .where('team_id', '=', teamId as TeamId);
  maxQuery = args.nodeTypeId
    ? maxQuery.where('node_type_id', '=', args.nodeTypeId as NodeTypeId)
    : maxQuery.where('edge_type_id', '=', args.edgeTypeId as EdgeTypeId);
  const maxResult = await maxQuery.executeTakeFirst();
  const nextOrder = ((maxResult?.max_order as number | null) ?? -1) + 1;

  const propertyType = await getKnowledgeQb(['property_type'])
    .insertInto('property_type')
    .values({
      team_id: teamId as TeamId,
      sort_order: nextOrder,
      node_type_id: args.nodeTypeId ? (args.nodeTypeId as NodeTypeId) : undefined,
      edge_type_id: args.edgeTypeId ? (args.edgeTypeId as EdgeTypeId) : undefined,
      name: args.name,
      description: args.description || '',
      value_type: (args.valueType as PropertyValueType) ?? PropertyValueType.text,
      // Legacy column (superseded by uniqueness constraints, ignored by
      // every current consumer) — 'none' so nothing downstream can read
      // meaning into it.
      identity: PropertyIdentity.none,
      evaluation_strategy:
        (args.evaluationStrategy as EvaluationStrategy) ?? EvaluationStrategy.latest,
      enum_values: args.enumValues ?? null,
    })
    .returning(['id', 'name', 'node_type_id', 'edge_type_id'])
    .executeTakeFirstOrThrow();

  return propertyType;
}

// Tool: Create an edge type
async function createEdgeType(
  args: {
    outboundName: string;
    inboundName: string;
    description: string;
    sourceNodeTypeId: string;
    targetNodeTypeId: string;
    required?: boolean;
    scopes?: boolean;
    group?: string;
    filters?: { side: string; property: string; value: string }[];
  },
  teamId: string,
) {
  const edgeType = await getKnowledgeQb(['edge_type'])
    .insertInto('edge_type')
    .values({
      team_id: teamId as TeamId,
      outbound_name: args.outboundName,
      inbound_name: args.inboundName,
      description: args.description || '',
      source_node_type_id: args.sourceNodeTypeId as NodeTypeId,
      target_node_type_id: args.targetNodeTypeId as NodeTypeId,
      required: args.required ?? false,
      scopes: args.scopes ?? false,
      filters: JSON.stringify(args.filters ?? []),
      edge_group: args.group ?? null,
    })
    .returning(['id', 'outbound_name', 'inbound_name'])
    .executeTakeFirstOrThrow();

  return edgeType;
}

// Tool: Update a node type
async function updateNodeType(
  args: { id: string; name?: string; description?: string; category?: string },
  teamId: string,
) {
  if (args.category !== undefined) {
    const reason = unsupportedCategoryReason(args.category);
    if (reason) throw new Error(reason);
  }

  const values: Record<string, unknown> = {};
  if (args.name !== undefined) values.name = args.name;
  if (args.description !== undefined) values.description = args.description;
  if (args.category !== undefined) values.category = args.category as NodeTypeCategory;
  if (Object.keys(values).length === 0) throw new Error('No fields to update');

  const result = await getKnowledgeQb(['node_type'])
    .updateTable('node_type')
    .set(values)
    .where('id', '=', args.id as NodeTypeId)
    .where('team_id', '=', teamId as TeamId)
    .returning(['id', 'name', 'category'])
    .executeTakeFirstOrThrow();
  return result;
}

// Tool: Update a property type
async function updatePropertyType(
  args: {
    id: string;
    name?: string;
    description?: string;
    valueType?: string;
    evaluationStrategy?: string;
    enumValues?: string[] | null;
  },
  teamId: string,
) {
  const values: Record<string, unknown> = {};
  if (args.name !== undefined) values.name = args.name;
  if (args.description !== undefined) values.description = args.description;
  if (args.valueType !== undefined) values.value_type = args.valueType as PropertyValueType;
  if (args.evaluationStrategy !== undefined)
    values.evaluation_strategy = args.evaluationStrategy as EvaluationStrategy;
  if (args.enumValues !== undefined) values.enum_values = args.enumValues;
  if (Object.keys(values).length === 0) throw new Error('No fields to update');

  const result = await getKnowledgeQb(['property_type'])
    .updateTable('property_type')
    .set(values)
    .where('id', '=', args.id as PropertyTypeId)
    .where('team_id', '=', teamId as TeamId)
    .returning(['id', 'name', 'node_type_id', 'edge_type_id'])
    .executeTakeFirstOrThrow();
  return result;
}

// Tool: Update an edge type
async function updateEdgeType(
  args: {
    id: string;
    outboundName?: string;
    inboundName?: string;
    description?: string;
    required?: boolean;
    scopes?: boolean;
    group?: string | null;
    filters?: { side: string; property: string; value: string }[];
  },
  teamId: string,
) {
  const values: Record<string, unknown> = {};
  if (args.outboundName !== undefined) values.outbound_name = args.outboundName;
  if (args.inboundName !== undefined) values.inbound_name = args.inboundName;
  if (args.description !== undefined) values.description = args.description;
  if (args.required !== undefined) values.required = args.required;
  if (args.scopes !== undefined) values.scopes = args.scopes;
  if (args.group !== undefined) values.edge_group = args.group;
  if (args.filters !== undefined) values.filters = JSON.stringify(args.filters);
  if (Object.keys(values).length === 0) throw new Error('No fields to update');

  const result = await getKnowledgeQb(['edge_type'])
    .updateTable('edge_type')
    .set(values)
    .where('id', '=', args.id as EdgeTypeId)
    .where('team_id', '=', teamId as TeamId)
    .returning(['id', 'outbound_name', 'inbound_name'])
    .executeTakeFirstOrThrow();
  return result;
}

// Tool: Delete a node type (cascades to properties, edges, extraction graph nodes)
async function deleteNodeType(args: { id: string }, teamId: string) {
  await getKnowledgeQb(['node_type'])
    .deleteFrom('node_type')
    .where('id', '=', args.id as NodeTypeId)
    .where('team_id', '=', teamId as TeamId)
    .executeTakeFirstOrThrow();
  return { deleted: true, id: args.id };
}

// Tool: Delete a property type
async function deletePropertyType(args: { id: string }, teamId: string) {
  await getKnowledgeQb(['property_type'])
    .deleteFrom('property_type')
    .where('id', '=', args.id as PropertyTypeId)
    .where('team_id', '=', teamId as TeamId)
    .executeTakeFirstOrThrow();
  return { deleted: true, id: args.id };
}

// Tool: Delete an edge type (cascades to edge properties and extraction graph edges)
async function deleteEdgeType(args: { id: string }, teamId: string) {
  await getKnowledgeQb(['edge_type'])
    .deleteFrom('edge_type')
    .where('id', '=', args.id as EdgeTypeId)
    .where('team_id', '=', teamId as TeamId)
    .executeTakeFirstOrThrow();
  return { deleted: true, id: args.id };
}

// Tool: Delete an extraction graph (cascades to nodes and edges)
async function deleteExtractionGraph(args: { id: string }, teamId: string) {
  await getKnowledgeQb(['extraction_graph'])
    .deleteFrom('extraction_graph')
    .where('id', '=', args.id as ExtractionGraphId)
    .where('team_id', '=', teamId as TeamId)
    .executeTakeFirstOrThrow();
  return { deleted: true, id: args.id };
}

// Tool: Set uniqueness constraints on a node type
async function setUniquenessConstraints(
  args: { nodeTypeId: string; constraints: string[] },
  teamId: string,
) {
  // Load context: properties for this node type, edges touching it, all node type names
  const [properties, edges, allNodeTypes] = await Promise.all([
    getKnowledgeQb(['property_type'])
      .selectFrom('property_type')
      .where('node_type_id', '=', args.nodeTypeId as NodeTypeId)
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'name'])
      .execute(),
    getKnowledgeQb(['edge_type'])
      .selectFrom('edge_type')
      .where('team_id', '=', teamId as TeamId)
      .where((eb: any) =>
        eb.or([
          eb('source_node_type_id', '=', args.nodeTypeId as NodeTypeId),
          eb('target_node_type_id', '=', args.nodeTypeId as NodeTypeId),
        ]),
      )
      .select(['id', 'source_node_type_id', 'target_node_type_id'])
      .execute(),
    getKnowledgeQb(['node_type'])
      .selectFrom('node_type')
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'name'])
      .execute(),
  ]);

  const propertyByName = new Map<string, string>();
  for (const p of properties) propertyByName.set(p.name.toLowerCase(), p.id as string);

  const nodeTypeNameById = new Map<string, string>();
  for (const nt of allNodeTypes) nodeTypeNameById.set(nt.id as string, nt.name);

  // Build edge lookup by connected node type name
  const edgeByNodeTypeName = new Map<string, { id: string; direction: 'outgoing' | 'incoming' }>();
  for (const et of edges) {
    if ((et.source_node_type_id as string) === args.nodeTypeId) {
      const name = nodeTypeNameById.get(et.target_node_type_id as string);
      if (name) edgeByNodeTypeName.set(name.toLowerCase(), { id: et.id as string, direction: 'outgoing' });
    } else {
      const name = nodeTypeNameById.get(et.source_node_type_id as string);
      if (name && !edgeByNodeTypeName.has(name.toLowerCase())) {
        edgeByNodeTypeName.set(name.toLowerCase(), { id: et.id as string, direction: 'incoming' });
      }
    }
  }

  // Parse each constraint expression
  const parsed: ConstraintEntry[][] = [];
  for (const text of args.constraints) {
    if (!text.trim()) continue;
    const result = parseConstraintText(text, propertyByName, edgeByNodeTypeName);
    if (!result.ok) {
      return { error: result.error, constraint: text };
    }
    parsed.push(result.entries!);
  }

  // Store
  const value = parsed.length > 0 ? JSON.stringify(parsed) : null;
  await getKnowledgeQb(['node_type'])
    .updateTable('node_type')
    .set({ uniqueness_constraints: value })
    .where('id', '=', args.nodeTypeId as NodeTypeId)
    .where('team_id', '=', teamId as TeamId)
    .execute();

  return {
    nodeTypeId: args.nodeTypeId,
    constraintCount: parsed.length,
    constraints: args.constraints.filter((t) => t.trim()),
  };
}

export const ONTOLOGY_TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'getOntology',
    description:
      'Get the current ontology (entity types, fields, relationships, extraction graphs). Call this first.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'createNodeType',
    description: 'Create a new entity type in the ontology.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the entity type (e.g. "Company", "Person", "Funding Round")',
        },
        description: {
          type: 'string',
          description: 'Brief description of what this type represents',
        },
        category: {
          type: 'string',
          enum: ['object'],
          description:
            'Always "object" — a primary entity the user tracks (Company, Person, Fund). This is the only kind of thing you can add.',
        },
      },
      required: ['name', 'description', 'category'],
    },
  },
  {
    type: 'function',
    name: 'createPropertyType',
    description:
      'Create a field on an entity type OR on a relationship. Provide EITHER nodeTypeName or edgeTypeOutboundName. Use relationship fields for relationship attributes (role, amount); use entity fields for entity attributes (name, revenue).',
    parameters: {
      type: 'object',
      properties: {
        nodeTypeName: {
          type: 'string',
          description:
            'Name of the entity type this field belongs to (provide this OR edgeTypeOutboundName, not both)',
        },
        edgeTypeOutboundName: {
          type: 'string',
          description:
            'Outbound name of the relationship this field belongs to (provide this OR nodeTypeName, not both)',
        },
        name: {
          type: 'string',
          description: 'Name of the field (e.g. "Name", "Revenue", "Role", "Start Date")',
        },
        description: {
          type: 'string',
          description: 'Brief description of what this field captures',
        },
        valueType: {
          type: 'string',
          enum: ['text', 'number', 'date', 'boolean', 'json'],
          description: 'The data type of the field value',
        },
        evaluationStrategy: {
          type: 'string',
          enum: ['latest', 'llm'],
          description:
            'How to resolve conflicts: latest (most recent wins), llm (LLM picks best). Default: latest',
        },
        enumValues: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of allowed values for this field. Use for categorical fields like status, stage, type, role. When set, only these values are accepted during extraction.',
        },
      },
      required: ['name', 'description', 'valueType'],
    },
  },
  {
    type: 'function',
    name: 'createEdgeType',
    description:
      'Create a new relationship between two entity types (source → target).',
    parameters: {
      type: 'object',
      properties: {
        outboundName: {
          type: 'string',
          description:
            'Name from source perspective, reads as "Source [outboundName] Target" (e.g. "Mentions Org", "From Company", "Deal For", "Member Of")',
        },
        inboundName: {
          type: 'string',
          description:
            'Name from target perspective, reads as "Target\'s [inboundName]" (e.g. "Mentioned In Dealflow", "Investor Updates", "Deals", "Members")',
        },
        description: { type: 'string', description: 'Brief description of the relationship' },
        sourceNodeTypeName: { type: 'string', description: 'Name of the source entity type' },
        targetNodeTypeName: { type: 'string', description: 'Name of the target entity type' },
        required: {
          type: 'boolean',
          description: 'Whether this relationship is required during extraction',
        },
        group: {
          type: 'string',
          description:
            'Display grouping key — relationships sharing the same group are the same semantic relationship targeting different types (e.g. "mentions" for mentions_org and mentions_person)',
        },
        filters: {
          type: 'array',
          description:
            'Field-based filters to constrain which entities participate in this relationship. Example: [{side: "source", property: "Role", value: "Lead Investor"}]',
          items: {
            type: 'object',
            properties: {
              side: {
                type: 'string',
                enum: ['source', 'target'],
                description: 'Which side of the relationship to filter',
              },
              property: { type: 'string', description: 'Name of the field to filter on' },
              value: { type: 'string', description: 'Required value for the field' },
            },
            required: ['side', 'property', 'value'],
          },
        },
      },
      required: [
        'outboundName',
        'inboundName',
        'description',
        'sourceNodeTypeName',
        'targetNodeTypeName',
      ],
    },
  },
  // Extraction graph CREATION tools are gone (2026-06-12): extraction is
  // authored as a movement (`#extract` in the movement language); the
  // legacy graphs that exist keep running but no agent makes new ones.
  {
    type: 'function',
    name: 'updateNodeType',
    description: 'Update an existing entity type by name. Only provide the fields you want to change.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Current name of the entity type to update' },
        newName: { type: 'string', description: 'New name (omit to keep)' },
        description: { type: 'string', description: 'New description' },
        category: {
          type: 'string',
          enum: ['object'],
          description: 'Always "object" — the only kind of thing that can be added or kept.',
        },
      },
      required: ['name'],
    },
  },
  {
    type: 'function',
    name: 'updatePropertyType',
    description: 'Update an existing field. Identify it by entity type (or relationship) + field name. Only provide the fields you want to change.',
    parameters: {
      type: 'object',
      properties: {
        nodeTypeName: {
          type: 'string',
          description:
            'Name of the entity type the field is on (provide this OR edgeTypeOutboundName).',
        },
        edgeTypeOutboundName: {
          type: 'string',
          description:
            'Outbound name of the relationship the field is on (provide this OR nodeTypeName).',
        },
        name: { type: 'string', description: 'Current name of the field to update' },
        newName: { type: 'string', description: 'New name (omit to keep)' },
        description: { type: 'string', description: 'New description' },
        valueType: {
          type: 'string',
          enum: ['text', 'number', 'date', 'boolean', 'json'],
          description: 'New value type',
        },
        evaluationStrategy: {
          type: 'string',
          enum: ['latest', 'llm'],
          description: 'New evaluation strategy',
        },
        enumValues: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'New enum values, or null to remove the enum constraint',
        },
      },
      required: ['name'],
    },
  },
  {
    type: 'function',
    name: 'updateEdgeType',
    description: 'Update an existing relationship by its outbound name. Only provide the fields you want to change.',
    parameters: {
      type: 'object',
      properties: {
        outboundName: { type: 'string', description: 'Current outbound name of the relationship to update' },
        newOutboundName: { type: 'string', description: 'New outbound name (omit to keep)' },
        inboundName: { type: 'string', description: 'New inbound name' },
        description: { type: 'string', description: 'New description' },
        required: { type: 'boolean', description: 'Whether the relationship is required' },
        group: { type: ['string', 'null'], description: 'New group key, or null to remove' },
        filters: {
          type: 'array',
          description: 'New filters array',
          items: {
            type: 'object',
            properties: {
              side: { type: 'string', enum: ['source', 'target'] },
              property: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['side', 'property', 'value'],
          },
        },
      },
      required: ['outboundName'],
    },
  },
  {
    type: 'function',
    name: 'deleteNodeType',
    description:
      'Delete an entity type by name. WARNING: This cascades — all fields, relationships, and extraction graph references for this entity type will also be deleted.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the entity type to delete' },
      },
      required: ['name'],
    },
  },
  {
    type: 'function',
    name: 'deletePropertyType',
    description: 'Delete a field by entity type (or relationship) + field name.',
    parameters: {
      type: 'object',
      properties: {
        nodeTypeName: {
          type: 'string',
          description: 'Name of the entity type the field is on (provide this OR edgeTypeOutboundName).',
        },
        edgeTypeOutboundName: {
          type: 'string',
          description: 'Outbound name of the relationship the field is on (provide this OR nodeTypeName).',
        },
        name: { type: 'string', description: 'Name of the field to delete' },
      },
      required: ['name'],
    },
  },
  {
    type: 'function',
    name: 'deleteEdgeType',
    description:
      'Delete a relationship by its outbound name. WARNING: This cascades — its fields and any extraction graph references using this relationship will also be deleted.',
    parameters: {
      type: 'object',
      properties: {
        outboundName: { type: 'string', description: 'Outbound name of the relationship to delete' },
      },
      required: ['outboundName'],
    },
  },
  {
    type: 'function',
    name: 'deleteExtractionGraph',
    description: 'Delete an extraction graph and all its nodes and edges, by name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the extraction graph to delete' },
      },
      required: ['name'],
    },
  },
  {
    type: 'function',
    name: 'setUniquenessConstraints',
    description:
      'Set uniqueness constraints on an entity type by name. Each constraint is a text expression describing when two entities are the same. Multiple constraints are OR\'d — matching ANY one means the entities are duplicates.',
    parameters: {
      type: 'object',
      properties: {
        nodeTypeName: {
          type: 'string',
          description: 'Name of the entity type to set constraints on',
        },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Array of constraint expressions. Each is an AND-joined list of terms. Terms: field name (e.g. "Name"), FUZZY(Name) for approximate match, -[:EntityTypeName]-> for a relationship to another entity, WITHIN(<date_field>, "<interval>") for a recent-activity time window. Example: ["FUZZY(Name) AND -[:Organisation]->", "Email", "FUZZY(Name) AND WITHIN(first_seen, \\"1 year\\")"]',
        },
      },
      required: ['nodeTypeName', 'constraints'],
    },
  },
];
const toolDefinitions = ONTOLOGY_TOOL_DEFINITIONS;

// ── N3-N: name resolvers for the ontology agent ─────────────────────────
// The agent's tool surface is name-based; these helpers translate
// names to the ids the underlying services require. Internal ids
// never appear in the LLM-facing tool defs OR results.

async function resolveNodeTypeIdByName(
  name: string,
  teamId: string,
): Promise<string | null> {
  const row = await getKnowledgeQb(['node_type'])
    .selectFrom('node_type')
    .where('team_id', '=', teamId as TeamId)
    .where('name', '=', name)
    .select('id')
    .executeTakeFirst();
  return row ? (row.id as unknown as string) : null;
}

async function resolveEdgeTypeIdByOutboundName(
  outboundName: string,
  teamId: string,
): Promise<string | null> {
  const row = await getKnowledgeQb(['edge_type'])
    .selectFrom('edge_type')
    .where('team_id', '=', teamId as TeamId)
    .where('outbound_name', '=', outboundName)
    .select('id')
    .executeTakeFirst();
  return row ? (row.id as unknown as string) : null;
}

async function resolveExtractionGraphIdByName(
  name: string,
  teamId: string,
): Promise<string | null> {
  const row = await getKnowledgeQb(['extraction_graph'])
    .selectFrom('extraction_graph')
    .where('team_id', '=', teamId as TeamId)
    .where('name', '=', name)
    .select('id')
    .executeTakeFirst();
  return row ? (row.id as unknown as string) : null;
}

async function resolvePropertyTypeIdByName(args: {
  name: string;
  nodeTypeName?: string;
  edgeTypeOutboundName?: string;
  teamId: string;
}): Promise<string | null> {
  if (args.nodeTypeName) {
    const nodeTypeId = await resolveNodeTypeIdByName(args.nodeTypeName, args.teamId);
    if (!nodeTypeId) return null;
    const row = await getKnowledgeQb(['property_type'])
      .selectFrom('property_type')
      .where('team_id', '=', args.teamId as TeamId)
      .where('node_type_id', '=', nodeTypeId as NodeTypeId)
      .where('name', '=', args.name)
      .select('id')
      .executeTakeFirst();
    return row ? (row.id as unknown as string) : null;
  }
  if (args.edgeTypeOutboundName) {
    const edgeTypeId = await resolveEdgeTypeIdByOutboundName(
      args.edgeTypeOutboundName,
      args.teamId,
    );
    if (!edgeTypeId) return null;
    const row = await getKnowledgeQb(['property_type'])
      .selectFrom('property_type')
      .where('team_id', '=', args.teamId as TeamId)
      .where('edge_type_id', '=', edgeTypeId as EdgeTypeId)
      .where('name', '=', args.name)
      .select('id')
      .executeTakeFirst();
    return row ? (row.id as unknown as string) : null;
  }
  return null;
}

/** Strip database id columns from a record before exposing it to the LLM. */
function stripIds<T extends Record<string, unknown>>(row: T): Omit<T, 'id' | 'node_type_id' | 'edge_type_id'> {
  const { id: _id, node_type_id: _ntid, edge_type_id: _etid, ...rest } = row as any;
  return rest;
}

function createWrappedTools(
  emitUpdate: (update: Omit<AgentUpdate, 'sessionId' | 'timestamp'>) => void,
  teamId: string,
) {
  return {
    getOntology: async () => {
      const msg = 'Checking current ontology...';
      emitUpdate({ type: 'tool_call', message: msg });
      const result = await getOntology(teamId);
      emitUpdate({ type: 'tool_call', message: `${msg} — done` });
      if (typeof result === 'string') return result;
      // Strip all ids — the agent operates entirely on names downstream.
      return {
        nodeTypes: result.nodeTypes.map((nt) => stripIds(nt)),
        propertyTypes: result.propertyTypes.map((pt) => stripIds(pt)),
        edgeTypes: result.edgeTypes.map((et) => stripIds(et)),
        extractionGraphs: result.extractionGraphs.map((eg) => stripIds(eg)),
      };
    },
    createNodeType: async (args: any) => {
      const msg = `Creating entity type: ${args.name}...`;
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        const result = await createNodeType(args, teamId);
        emitUpdate({ type: 'tool_call', message: `${msg} — done` });
        return { name: result.name, category: result.category };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `createNodeType failed for ${args.name}:`,
          errMsg,
          'args:',
          JSON.stringify(args),
        );
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    },
    createPropertyType: async (args: any) => {
      const msg = `Creating field: ${args.name}...`;
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        if (!args.nodeTypeName && !args.edgeTypeOutboundName) {
          return {
            error:
              'Provide either `nodeTypeName` (for an entity field) or `edgeTypeOutboundName` (for a relationship field).',
          };
        }
        const nodeTypeId = args.nodeTypeName
          ? await resolveNodeTypeIdByName(args.nodeTypeName, teamId)
          : undefined;
        if (args.nodeTypeName && !nodeTypeId) {
          return { error: `No entity type named '${args.nodeTypeName}' was found.` };
        }
        const edgeTypeId = args.edgeTypeOutboundName
          ? await resolveEdgeTypeIdByOutboundName(args.edgeTypeOutboundName, teamId)
          : undefined;
        if (args.edgeTypeOutboundName && !edgeTypeId) {
          return {
            error: `No relationship with outbound name '${args.edgeTypeOutboundName}' was found.`,
          };
        }
        const result = await createPropertyType(
          {
            nodeTypeId: nodeTypeId ?? undefined,
            edgeTypeId: edgeTypeId ?? undefined,
            name: args.name,
            description: args.description,
            valueType: args.valueType,
            evaluationStrategy: args.evaluationStrategy,
            enumValues: args.enumValues,
          },
          teamId,
        );
        emitUpdate({ type: 'tool_call', message: `${msg} — done` });
        return { name: result.name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`createPropertyType failed for ${args.name}:`, errMsg);
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    },
    createEdgeType: async (args: any) => {
      const msg = `Creating relationship: ${args.outboundName}...`;
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        const sourceNodeTypeId = await resolveNodeTypeIdByName(
          args.sourceNodeTypeName,
          teamId,
        );
        if (!sourceNodeTypeId) {
          return { error: `No entity type named '${args.sourceNodeTypeName}' was found (source).` };
        }
        const targetNodeTypeId = await resolveNodeTypeIdByName(
          args.targetNodeTypeName,
          teamId,
        );
        if (!targetNodeTypeId) {
          return { error: `No entity type named '${args.targetNodeTypeName}' was found (target).` };
        }
        const result = await createEdgeType(
          {
            outboundName: args.outboundName,
            inboundName: args.inboundName,
            description: args.description,
            sourceNodeTypeId,
            targetNodeTypeId,
            required: args.required,
            scopes: args.scopes,
            group: args.group,
            filters: args.filters,
          },
          teamId,
        );
        emitUpdate({ type: 'tool_call', message: `${msg} — done` });
        return { outboundName: result.outbound_name, inboundName: result.inbound_name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`createEdgeType failed for ${args.outboundName}:`, errMsg);
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    },
    updateNodeType: async (args: any) => {
      const msg = `Updating entity type: ${args.name}...`;
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        const id = await resolveNodeTypeIdByName(args.name, teamId);
        if (!id) return { error: `No entity type named '${args.name}' was found.` };
        const result = await updateNodeType(
          {
            id,
            ...(args.newName !== undefined ? { name: args.newName } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.category !== undefined ? { category: args.category } : {}),
          },
          teamId,
        );
        emitUpdate({ type: 'tool_call', message: `${msg} — done` });
        return { name: result.name, category: result.category };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`updateNodeType failed:`, errMsg);
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    },
    updatePropertyType: async (args: any) => {
      const msg = `Updating field: ${args.name}...`;
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        const id = await resolvePropertyTypeIdByName({
          name: args.name,
          nodeTypeName: args.nodeTypeName,
          edgeTypeOutboundName: args.edgeTypeOutboundName,
          teamId,
        });
        if (!id) {
          return {
            error: `No field named '${args.name}' was found on the specified entity / relationship.`,
          };
        }
        const result = await updatePropertyType(
          {
            id,
            ...(args.newName !== undefined ? { name: args.newName } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.valueType !== undefined ? { valueType: args.valueType } : {}),
            ...(args.evaluationStrategy !== undefined
              ? { evaluationStrategy: args.evaluationStrategy }
              : {}),
            ...(args.enumValues !== undefined ? { enumValues: args.enumValues } : {}),
          },
          teamId,
        );
        emitUpdate({ type: 'tool_call', message: `${msg} — done` });
        return { name: result.name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`updatePropertyType failed:`, errMsg);
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    },
    updateEdgeType: async (args: any) => {
      const msg = `Updating relationship: ${args.outboundName}...`;
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        const id = await resolveEdgeTypeIdByOutboundName(args.outboundName, teamId);
        if (!id) {
          return {
            error: `No relationship with outbound name '${args.outboundName}' was found.`,
          };
        }
        const result = await updateEdgeType(
          {
            id,
            ...(args.newOutboundName !== undefined ? { outboundName: args.newOutboundName } : {}),
            ...(args.inboundName !== undefined ? { inboundName: args.inboundName } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.required !== undefined ? { required: args.required } : {}),
            ...(args.scopes !== undefined ? { scopes: args.scopes } : {}),
            ...(args.group !== undefined ? { group: args.group } : {}),
            ...(args.filters !== undefined ? { filters: args.filters } : {}),
          },
          teamId,
        );
        emitUpdate({ type: 'tool_call', message: `${msg} — done` });
        return { outboundName: result.outbound_name, inboundName: result.inbound_name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`updateEdgeType failed:`, errMsg);
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    },
    deleteNodeType: async (args: any) => {
      const msg = `Deleting entity type: ${args.name}...`;
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        const id = await resolveNodeTypeIdByName(args.name, teamId);
        if (!id) return { error: `No entity type named '${args.name}' was found.` };
        await deleteNodeType({ id }, teamId);
        emitUpdate({ type: 'tool_call', message: `${msg} — done` });
        return { deleted: true, name: args.name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`deleteNodeType failed:`, errMsg);
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    },
    deletePropertyType: async (args: any) => {
      const msg = `Deleting field: ${args.name}...`;
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        const id = await resolvePropertyTypeIdByName({
          name: args.name,
          nodeTypeName: args.nodeTypeName,
          edgeTypeOutboundName: args.edgeTypeOutboundName,
          teamId,
        });
        if (!id) {
          return {
            error: `No field named '${args.name}' was found on the specified entity / relationship.`,
          };
        }
        await deletePropertyType({ id }, teamId);
        emitUpdate({ type: 'tool_call', message: `${msg} — done` });
        return { deleted: true, name: args.name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`deletePropertyType failed:`, errMsg);
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    },
    deleteEdgeType: async (args: any) => {
      const msg = `Deleting relationship: ${args.outboundName}...`;
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        const id = await resolveEdgeTypeIdByOutboundName(args.outboundName, teamId);
        if (!id) {
          return {
            error: `No relationship with outbound name '${args.outboundName}' was found.`,
          };
        }
        await deleteEdgeType({ id }, teamId);
        emitUpdate({ type: 'tool_call', message: `${msg} — done` });
        return { deleted: true, outboundName: args.outboundName };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`deleteEdgeType failed:`, errMsg);
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    },
    deleteExtractionGraph: async (args: any) => {
      const msg = `Deleting extraction graph: ${args.name}...`;
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        const id = await resolveExtractionGraphIdByName(args.name, teamId);
        if (!id) return { error: `No extraction graph named '${args.name}' was found.` };
        await deleteExtractionGraph({ id }, teamId);
        emitUpdate({ type: 'tool_call', message: `${msg} — done` });
        return { deleted: true, name: args.name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`deleteExtractionGraph failed:`, errMsg);
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    },
    setUniquenessConstraints: async (args: any) => {
      const msg = `Setting uniqueness constraints on: ${args.nodeTypeName}...`;
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        const nodeTypeId = await resolveNodeTypeIdByName(args.nodeTypeName, teamId);
        if (!nodeTypeId) {
          return { error: `No entity type named '${args.nodeTypeName}' was found.` };
        }
        const result = await setUniquenessConstraints(
          { nodeTypeId, constraints: args.constraints },
          teamId,
        );
        if ('error' in result) {
          emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${result.error}` });
          return { error: result.error, constraint: (result as any).constraint };
        }
        emitUpdate({
          type: 'tool_call',
          message: `${msg} — done (${result.constraintCount} constraints)`,
        });
        return {
          nodeTypeName: args.nodeTypeName,
          constraintCount: result.constraintCount,
          constraints: result.constraints,
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`setUniquenessConstraints failed:`, errMsg);
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    },
  };
}

async function runOntologyAgent(
  message: string,
  options: OntologyAgentOptions,
): Promise<{ text: string }> {
  const { sessionId, teamId, conversationHistory, additionalToolDefs = [], additionalToolImpls = {}, onboarding } = options;

  return currentContext().runAsync(async () => {
    const startTime = Date.now();
    const sid = sessionId || `oa-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const emitUpdate = (update: Omit<AgentUpdate, 'sessionId' | 'timestamp'>) => {
      if (sessionId) {
        mq.agentUpdates.update.publish({
          sessionId: sid,
          timestamp: Date.now(),
          ...update,
        });
      }
    };

    try {
      emitUpdate({ type: 'start', message: 'Starting ontology assistant...' });
      emitUpdate({ type: 'thinking', message: 'Understanding your request...' });

      // Build system prompt with style preferences
      const styleBlock = await getStyleBlock(teamId);
      let systemPrompt = ONTOLOGY_AGENT_SYSTEM_PROMPT + styleBlock;

      if (sid.startsWith('mcp-')) {
        systemPrompt += `\n\n## MCP session constraints\n\nThis request is being served via MCP with a tight time budget. Be direct and concise — short answers, minimal formatting, no preamble. Prefer a single tool call over chained lookups when possible.`;
      }

      if (onboarding) {
        systemPrompt += `\n\n## Onboarding mode

The user has just opened the model page for the first time. Their knowledge model is completely empty — no node types, edges, properties, or extraction graphs exist yet. You do NOT need to call getOntology — it will return nothing.

Your role right now is to act like a brilliant Field Data Engineer meeting a new client for the first time. Your goal is to deeply understand the user's world before proposing any solution:

1. **Welcome them** — introduce yourself warmly as their data modeling assistant. Keep it brief and natural, not corporate.
2. **Understand their work** — ask about their role, their industry, what kinds of information flow through their day. Be genuinely curious.
3. **Find the pain** — what do they wish they could track, search, or connect? What falls through the cracks? Where do they waste time on manual work?
4. **Map the workflow** — what are their key data sources (emails, documents, CRM, etc.)? What information matters most? How do things relate to each other?
5. **Propose a model** — once you understand enough, propose a data model in business terms. If their use case closely matches a template, suggest starting from it and customizing. Otherwise, design something bespoke.

Be conversational and curious. Ask one or two questions at a time — don't overwhelm with a long list. Spend real time understanding before jumping to solutions. The user's first message is just them saying hello — start the discovery conversation.`;
      }

      const wrappedTools = createWrappedTools(emitUpdate, teamId);

      // Inject additional tools from orchestrator (e.g., handoff tools)
      const allToolDefs: any[] = [...(toolDefinitions as any[]), ...additionalToolDefs];
      const allToolImpls = { ...wrappedTools, ...additionalToolImpls };

      const onTurn = (event: TurnEvent) => {
        if (event.thinkingText) {
          emitUpdate({ type: 'thinking', message: event.thinkingText });
        }
      };

      const rawResult = await anthropicToolLoop(
        {
          model: 'claude-sonnet-5',
          max_output_tokens: 4096,
          maxTurns: 75,
          system: systemPrompt,
          userMessage: message,
          conversationHistory,
          tools: allToolDefs,
          onTurn,
          label: 'ontology_agent',
        },
        allToolImpls,
      );

      const validated = AgentResponseSchema.parse(rawResult);
      const text =
        validated
          .map((item) => item.text || item.content)
          .filter((t): t is string => !!t)
          .join('\n\n') || 'No response generated';

      const elapsedMs = Date.now() - startTime;
      emitUpdate({
        type: 'complete',
        message: `Complete in ${(elapsedMs / 1000).toFixed(1)}s`,
        data: { elapsedMs, text, agent: 'ontology' },
      });

      return { text };
    } catch (error: any) {
      // Re-throw control-flow signals — they must reach the orchestrator
      if (error?.isHandoff || error?.isHandBack) throw error;

      console.error('Ontology agent error:', error);

      emitUpdate({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        data: { error: String(error) },
      });

      if (error instanceof z.ZodError) {
        throw new Error(`Invalid response format: ${error.message}`);
      }
      throw error;
    }
  });
}

export { runOntologyAgent, createWrappedTools as createOntologyAgentTools };
