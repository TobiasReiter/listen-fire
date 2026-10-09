import { sql } from 'kysely';

import type { ResourceId } from '../../generated/kysely/knowledge/Resource';
import type { SourceRef } from './agent_types';

import { getQb, getKnowledgeQb } from '../kysely';
import { logger } from '../../services/logger';
import { anthropicChat } from '../anthropic';
import { TeamId } from '../../generated/kysely/core/Team';
import { NodeId } from '../../generated/kysely/knowledge/Node';
import { resolveDisplayNames } from './resolve_display_name';
import { buildRelationshipContextFromDb, formatEntityContext } from './relationship_context';
import { unwrapAgentQueryRows } from './query_agent_utils';


const QUERY_PLANNER_PROMPT = `You are a query planner for a knowledge graph stored in PostgreSQL. You receive the user's question and conversation context. Your job:

1. **Plan**: Reason about which entity types, fields, relationships, and traversals are needed to answer the question. Think about join paths, aggregations, and edge cases.
2. **Generate SQL**: Produce a single executable SQL query that retrieves the data.

## Output format

Return a JSON object with two fields:
\`\`\`
{"plan": "...", "sql": "..."}
\`\`\`

- **plan**: 1-3 sentences explaining your reasoning — which entities to look at, what joins/filters are needed, and why.
- **sql**: The executable SQL query on a single line.

Output ONLY the JSON object. No markdown fences, no commentary outside the JSON.

## Schema

All tables live in the \`knowledge\` schema:

- **knowledge.node_type** — entity type definitions (id, name, category, description, team_id). Category: message, object, scoped_object.
- **knowledge.property_type** — field definitions (id, name, value_type, identity, enum_values, description). Has \`node_type_id\` (for node properties) OR \`edge_type_id\` (for edge properties), never both.
- **knowledge.edge_type** — relationship definitions (id, outbound_name, inbound_name, source_node_type_id, target_node_type_id, scopes, required, description).
- **knowledge.node** — entity instances (id, team_id, node_type_id, created_at, updated_at).
- **knowledge.property** — field values (id, node_id OR edge_id, property_type_id, value_text, value_text_array, value_number, value_date, value_boolean, value_json, value_text_search tsvector).
- **knowledge.edge** — relationship instances (id, source_node_id, target_node_id, edge_type_id).
- **knowledge.evidence** — provenance records (type: extraction, user_edit, retrieval).

## Category semantics

- **object**: a standalone entity (e.g. Company, Person)
- **scoped_object**: an entity that belongs to a parent via a scoping edge (e.g. Funding Round belongs to a Company). To find the parent, follow the scoping edge from the scoped_object (source) to the parent (target).
- **message**: the original input that was processed (e.g. an email). Usually not interesting to query directly.

## Helper functions

Use these instead of scalar subselects for property lookups:

- \`knowledge.prop(node_id, 'Name')\` → text
- \`knowledge.prop_num(node_id, 'Amount')\` → numeric
- \`knowledge.prop_bool(node_id, 'Active')\` → boolean
- \`knowledge.prop_date(node_id, 'Founded')\` → timestamp
- \`knowledge.edge_prop(edge_id, 'Role')\` → text
- \`knowledge.edge_prop_num(edge_id, 'Weight')\` → numeric

These return NULL when the property doesn't exist, so they're safe for sparse data.

## Query patterns

Property lookups:
\`\`\`sql
SELECT n.id,
  knowledge.prop(n.id, 'Name') as name,
  knowledge.prop(n.id, 'Stage') as stage
FROM knowledge.node n
JOIN knowledge.node_type nt ON nt.id = n.node_type_id
WHERE nt.name = 'Funding Round'
ORDER BY n.created_at DESC LIMIT 20
\`\`\`

Filtering on a property:
\`\`\`sql
WHERE nt.name = 'Funding Round' AND knowledge.prop(n.id, 'Stage') = 'Pre-Seed'
\`\`\`

For ILIKE or complex filters on text properties, use EXISTS with the raw tables:
\`\`\`sql
WHERE EXISTS (
  SELECT 1 FROM knowledge.property p
  JOIN knowledge.property_type pt ON pt.id = p.property_type_id
  WHERE p.node_id = n.id AND pt.name = 'Name' AND p.value_text ILIKE '%acme%'
)
\`\`\`

Traverse relationships:
\`\`\`sql
SELECT target.id, knowledge.prop(target.id, 'Name') as name
FROM knowledge.edge e
JOIN knowledge.node target ON target.id = e.target_node_id
WHERE e.source_node_id = '<node_id>' AND e.edge_type_id = '<edge_type_id>'
\`\`\`

Edge properties:
\`\`\`sql
SELECT target.id, knowledge.prop(target.id, 'Name') as name, knowledge.edge_prop(e.id, 'Role') as role
FROM knowledge.edge e
JOIN knowledge.node target ON target.id = e.target_node_id
WHERE e.source_node_id = '<node_id>' AND e.edge_type_id = '<edge_type_id>'
\`\`\`

Scoped objects to parent: follow the scoping edge from source (scoped object) to target (parent).

## Rules

1. Always include ORDER BY and LIMIT.
2. Use the node_type_id, edge_type_id, and property_type name values from the ontology. Prefer filtering by ID when you have it.
3. Not every entity has every property — the helper functions return NULL gracefully.
4. SELECT only the columns needed to answer the question. Always include \`n.id\`.
5. Write the SQL on a single line.
6. All tables must use the \`knowledge.\` prefix.
7. Always use the helper functions for property lookups. Never use raw scalar subselects for simple reads.
8. Never SELECT summary or summary_tsvector. Use properties for all data — summary is an internal field.`;

// Tool: Describe the team's ontology
async function describeOntology(teamId: string) {
  const [nodeTypes, propertyTypes, edgeTypes] = await Promise.all([
    getKnowledgeQb(['node_type'])
      .selectFrom('node_type')
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'name', 'description', 'category'])
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
        'pt.value_type',
        'pt.identity',
        'pt.enum_values',
        'nt.name as node_type_name',
        'et.outbound_name as edge_type_name',
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
        'et.edge_group',
      ])
      .orderBy('et.outbound_name asc')
      .execute(),
  ]);

  if (nodeTypes.length === 0) {
    return 'No ontology defined yet. The knowledge graph is empty.';
  }

  const nodeTypeText = nodeTypes
    .map(
      (nt) =>
        `  - ${nt.name} (${nt.category}): ${nt.description || 'no description'} [id: ${nt.id}]`,
    )
    .join('\n');

  const propsByOwner = new Map<string, string[]>();
  for (const pt of propertyTypes) {
    const key = pt.node_type_name
      ? pt.node_type_name
      : pt.edge_type_name
        ? `edge: ${pt.edge_type_name}`
        : '?';
    const list = propsByOwner.get(key) ?? [];
    let propDesc = `${pt.name} (${pt.value_type})`;
    if (pt.description) propDesc += `: ${pt.description}`;
    if (pt.enum_values && (pt.enum_values as string[]).length > 0) {
      propDesc += ` [values: ${(pt.enum_values as string[]).join(', ')}]`;
    }
    list.push(propDesc);
    propsByOwner.set(key, list);
  }
  const propertyTypeText = [...propsByOwner.entries()]
    .map(([ownerName, props]) => `  - ${ownerName}:\n${props.map((p) => `      ${p}`).join('\n')}`)
    .join('\n');

  // Group edges by edge_group for concise rendering
  const grouped = new Map<string, typeof edgeTypes>();
  const ungrouped: typeof edgeTypes = [];
  for (const et of edgeTypes) {
    if (et.edge_group) {
      const arr = grouped.get(et.edge_group) ?? [];
      arr.push(et);
      grouped.set(et.edge_group, arr);
    } else {
      ungrouped.push(et);
    }
  }

  const edgeLines: string[] = [];
  for (const [, members] of grouped) {
    const first = members[0];
    const targets = [...new Set(members.map((m) => m.target_name))].join(', ');
    const ids = members.map((m) => m.id).join(', ');
    const flags = [first.required && 'required', first.scopes && 'scopes']
      .filter(Boolean)
      .join(', ');
    edgeLines.push(
      `  - ${first.source_name} → ${targets} (${first.outbound_name.replace(/_(?:org|person)$/, '')} / ${first.inbound_name.replace(/_(?:org|person)$/, '')})${flags ? ` (${flags})` : ''}: ${first.description} [ids: ${ids}]`,
    );
  }
  for (const et of ungrouped) {
    const flags = [et.required && 'required', et.scopes && 'scopes'].filter(Boolean).join(', ');
    edgeLines.push(
      `  - ${et.source_name} → ${et.target_name} (${et.outbound_name} / ${et.inbound_name})${flags ? ` (${flags})` : ''}: ${et.description} [id: ${et.id}]`,
    );
  }

  const edgeTypeText = edgeLines.join('\n') || '  (none)';

  return `Node Types:\n${nodeTypeText}\n\nProperty Types:\n${propertyTypeText || '  (none)'}\n\nEdge Types:\n${edgeTypeText}`;
}

// Tool: Plan a query with Opus, then execute the resulting SQL
async function planAndExecuteQuery(
  question: string,
  ontologyText: string,
  teamId: string,
  context?: string,
) {
  const systemPrompt = `${QUERY_PLANNER_PROMPT}\n\n## Current ontology\n\n${ontologyText}`;
  const userMessage = context ? `${question}\n\nAdditional context:\n${context}` : question;

  const raw = await anthropicChat({
    system: systemPrompt,
    userMessage,
    model: 'claude-opus-4-7',
    maxTokens: 2048,
    label: 'query_planner',
    noContinue: true,
  });

  // Parse the JSON response — extract plan and sql
  let plan: string | null = null;
  let cleanSql: string;
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(cleaned) as { plan?: string; sql?: string };
    plan = parsed.plan ?? null;
    cleanSql = (parsed.sql ?? cleaned).trim();
  } catch {
    // Fallback: treat entire response as SQL
    cleanSql = raw.replace(/^```(?:sql)?\n?/i, '').replace(/\n?```$/i, '').trim();
  }

  logger.info('[query_planner] generated', { question, plan, sql: cleanSql });

  const result = await queryKnowledgeGraph(cleanSql, teamId);

  // If the query errored, include the plan and SQL for context
  if (result && typeof result === 'object' && 'error' in result) {
    return { error: (result as { error: string }).error, plan, generatedSql: cleanSql };
  }

  return result;
}

// Tool: Execute read-only SQL against knowledge schema with RLS
async function queryKnowledgeGraph(query: string, teamId: string) {
  const qb = getQb();

  try {
    const result = await qb.transaction().execute(async (trx) => {
      await sql`SELECT set_current_team_id(${teamId})`.execute(trx);
      await sql`SET LOCAL ROLE agent`.execute(trx);

      const rows = await sql`SELECT * FROM execute_agent_query(${query.replace(/;$/, '')})`.execute(
        trx,
      );
      return rows.rows;
    });

    if (Array.isArray(result)) {
      return unwrapAgentQueryRows(result);
    }

    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// Tool: Get detailed info about a specific node
async function getNodeDetail(nodeId: string, teamId: string, mode: 'full' | 'context' = 'full') {
  const node = await getKnowledgeQb(['node', 'node_type'])
    .selectFrom('node as n')
    .leftJoin('node_type as nt', 'nt.id', 'n.node_type_id')
    .where('n.id', '=', nodeId as NodeId)
    .where('n.team_id', '=', teamId as TeamId)
    .select([
      'n.id',
      'n.node_type_id',
      'n.summary',
      'nt.name as node_type_name',
      'nt.category',
      'n.created_at',
      'n.updated_at',
    ])
    .executeTakeFirst();

  if (!node) return { error: 'Node not found' };

  if (mode === 'context') {
    // Lightweight disambiguation view: properties + relationships with resolved names
    const properties = await getKnowledgeQb(['property', 'property_type'])
      .selectFrom('property as p')
      .innerJoin('property_type as pt', 'pt.id', 'p.property_type_id')
      .where('p.node_id', '=', nodeId as NodeId)
      .select(['pt.name as property_name', 'p.value_text', 'p.value_number', 'p.value_boolean'])
      .execute();

    const relationships = await buildRelationshipContextFromDb({
      nodeId: nodeId as NodeId,
      teamId: teamId as TeamId,
    });

    const propsMap: Record<string, unknown> = {};
    for (const p of properties) {
      propsMap[p.property_name] = p.value_text ?? p.value_number ?? p.value_boolean;
    }

    const contextText = formatEntityContext({
      properties: propsMap,
      relationships,
    });

    return {
      id: node.id,
      node_type_name: node.node_type_name,
      category: node.category,
      context: contextText,
      _summary: node.summary,
    };
  }

  // Full mode — existing behavior plus resolved neighbor display names
  const [properties, outgoingEdges, incomingEdges, evidence, sources, sourceRefs] =
    await Promise.all([
      getKnowledgeQb(['property', 'property_type'])
        .selectFrom('property as p')
        .innerJoin('property_type as pt', 'pt.id', 'p.property_type_id')
        .where('p.node_id', '=', nodeId as NodeId)
        .select(['pt.name as property_name', 'p.value_text', 'p.value_number', 'p.value_boolean'])
        .execute(),

      getKnowledgeQb(['edge', 'edge_type', 'node', 'node_type'])
        .selectFrom('edge as e')
        .innerJoin('edge_type as et', 'et.id', 'e.edge_type_id')
        .innerJoin('node as tn', 'tn.id', 'e.target_node_id')
        .innerJoin('node_type as tnt', 'tnt.id', 'tn.node_type_id')
        .where('e.source_node_id', '=', nodeId as NodeId)
        .select([
          'et.outbound_name as edge_type',
          'tnt.name as target_type',
          'tn.id as target_id',
        ])
        .execute(),

      getKnowledgeQb(['edge', 'edge_type', 'node', 'node_type'])
        .selectFrom('edge as e')
        .innerJoin('edge_type as et', 'et.id', 'e.edge_type_id')
        .innerJoin('node as sn', 'sn.id', 'e.source_node_id')
        .innerJoin('node_type as snt', 'snt.id', 'sn.node_type_id')
        .where('e.target_node_id', '=', nodeId as NodeId)
        .select([
          'et.outbound_name as edge_type',
          'snt.name as source_type',
          'sn.id as source_id',
        ])
        .execute(),

      // Evidence: provenance descriptions for this node's properties
      getKnowledgeQb(['evidence', 'property'])
        .selectFrom('evidence as ev')
        .innerJoin('property as p', 'p.id', 'ev.property_id')
        .where('p.node_id', '=', nodeId as NodeId)
        .select(['ev.type', 'ev.description'])
        .limit(20)
        .execute(),

      // Source texts for LLM + source refs for trace
      loadSourceTextsForNode(nodeId),
      loadSourceRefsForNode(nodeId),
    ]);

  // Resolve display names for neighbor nodes
  const neighborIds = [
    ...outgoingEdges.map((e) => e.target_id),
    ...incomingEdges.map((e) => e.source_id),
  ].filter(Boolean) as string[];

  const displayNames = neighborIds.length > 0
    ? await resolveDisplayNames({ nodeIds: neighborIds, teamId })
    : new Map<string, string | null>();

  const enrichedOutgoing = outgoingEdges.map((e) => ({
    ...e,
    target_name: displayNames.get(e.target_id as string) ?? null,
  }));

  const enrichedIncoming = incomingEdges.map((e) => ({
    ...e,
    source_name: displayNames.get(e.source_id as string) ?? null,
  }));

  return {
    id: node.id,
    node_type_id: node.node_type_id,
    node_type_name: node.node_type_name,
    category: node.category,
    created_at: node.created_at,
    updated_at: node.updated_at,
    properties,
    outgoingEdges: enrichedOutgoing,
    incomingEdges: enrichedIncoming,
    evidence,
    sourceTexts: sources,
    _summary: node.summary,
    _sourceRefs: sourceRefs,
  };
}

async function loadSourceRefsForNode(nodeId: string): Promise<SourceRef[]> {
  const nodeResources = await getKnowledgeQb(['node_resource'])
    .selectFrom('node_resource')
    .where('node_resource.node_id', '=', nodeId as NodeId)
    .select(['node_resource.resource_id'])
    .execute();

  if (!nodeResources.length) return [];

  // `node_resource.resource_id` lost its brand with the cross-schema FK (D3).
  const resourceIds = [...new Set(nodeResources.map((nr) => nr.resource_id))] as ResourceId[];

  const resources = await getKnowledgeQb(['resource', 'raw_text'])
    .selectFrom('resource')
    .leftJoin('raw_text', 'raw_text.id', 'resource.raw_text_id')
    .where('resource.id', 'in', resourceIds)
    .select([
      'resource.id',
      'resource.name',
      'resource.type',
      'resource.url',
      'raw_text.content as raw_text_content',
    ])
    .execute();

  return resources.map((r) => ({
    resourceId: r.id,
    resourceName: r.name,
    resourceType: r.type,
    resourceUrl: r.url ?? undefined,
    rawText: r.raw_text_content ?? undefined,
  }));
}

// Still used by getNodeDetail to return source texts to the LLM
async function loadSourceTextsForNode(nodeId: string): Promise<string[]> {
  const nodeResources = await getKnowledgeQb(['node_resource'])
    .selectFrom('node_resource')
    .where('node_resource.node_id', '=', nodeId as NodeId)
    .select(['node_resource.resource_id', 'node_resource.start_offset', 'node_resource.end_offset'])
    .execute();

  if (!nodeResources.length) return [];

  // `node_resource.resource_id` lost its brand with the cross-schema FK (D3).
  const resourceIds = [...new Set(nodeResources.map((nr) => nr.resource_id))] as ResourceId[];

  const resources = await getKnowledgeQb(['resource', 'raw_text'])
    .selectFrom('resource')
    .innerJoin('raw_text', 'raw_text.id', 'resource.raw_text_id')
    .where('resource.id', 'in', resourceIds)
    .select(['resource.id as resource_id', 'raw_text.content'])
    .execute();

  const resourceMap = new Map<string, string>(resources.map((r) => [r.resource_id, r.content]));

  const results: string[] = [];
  for (const nr of nodeResources) {
    const content = resourceMap.get(nr.resource_id);
    if (!content) continue;
    const text =
      nr.start_offset != null && nr.end_offset != null
        ? content.slice(nr.start_offset, nr.end_offset)
        : content;
    if (text.trim()) results.push(text);
  }
  return results;
}

export { describeOntology, planAndExecuteQuery, getNodeDetail };
