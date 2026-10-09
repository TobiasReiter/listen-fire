import { sql } from 'kysely';
import { z } from 'zod';

import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import type { EdgeTypeId } from '../../generated/kysely/knowledge/EdgeType';
import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { PropertyId } from '../../generated/kysely/knowledge/Property';
import type { TeamId } from '../../generated/kysely/core/Team';

import { getKnowledgeQb } from '../../lib/kysely';
import { execute } from '../../lib/prompts/execute';
import { promptDef } from '../../lib/prompts/definition';
import { anthropicChat } from '../../lib/anthropic';
import { parseJson } from '../../lib/utils/parse_json';
import { searchFacts } from './facts';
import { logger } from '../logger';
import PropertyIdentity from '../../generated/kysely/knowledge/PropertyIdentity';
import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import { recordChange, ChangeSource, ChangeKind, propertyToChangeValue, changeValuesEqual } from '../../lib/knowledge/changes';

// ---------------------------------------------------------------------------
// reassignNodes — move nodes from one type to another, remapping properties
// ---------------------------------------------------------------------------

interface PropertyMapping {
  from: PropertyTypeId;
  to: PropertyTypeId;
}

interface ReassignResult {
  nodesReassigned: number;
  propertiesRemapped: number;
  edgesRemapped: number;
  orphanedProperties: number;
}

async function reassignNodes(options: {
  teamId: TeamId;
  fromNodeTypeId: NodeTypeId;
  toNodeTypeId: NodeTypeId;
  nodeIds?: NodeId[];
  propertyMapping?: PropertyMapping[];
}): Promise<ReassignResult> {
  const { teamId, fromNodeTypeId, toNodeTypeId, nodeIds } = options;

  const qb = getKnowledgeQb([
    'node',
    'node_type',
    'edge',
    'edge_type',
    'property',
    'property_type',
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return qb.transaction().execute(async (trx: any) => {
    // 1. Find nodes to reassign
    let nodeQuery = trx
      .selectFrom('node')
      .where('node.team_id', '=', teamId)
      .where('node.node_type_id', '=', fromNodeTypeId)
      .select('node.id');

    if (nodeIds?.length) {
      nodeQuery = nodeQuery.where('node.id', 'in', nodeIds);
    }

    const nodesToMove: { id: NodeId }[] = await nodeQuery.execute();
    if (!nodesToMove.length) {
      return { nodesReassigned: 0, propertiesRemapped: 0, edgesRemapped: 0, orphanedProperties: 0 };
    }

    const nodeIdList = nodesToMove.map((n) => n.id);

    // 2. Build property mapping — explicit + auto-mapped by name
    const propMapping = await buildPropertyMapping(trx, teamId, fromNodeTypeId, toNodeTypeId, options.propertyMapping);

    // 3. Remap properties
    let propertiesRemapped = 0;
    for (const mapping of propMapping) {
      const result = await trx
        .updateTable('property')
        .set({ property_type_id: mapping.to, updated_at: new Date() })
        .where('property.property_type_id', '=', mapping.from)
        .where('property.node_id', 'in', nodeIdList)
        .where('property.team_id', '=', teamId)
        .execute();
      propertiesRemapped += Number((result[0] as { numUpdatedRows?: bigint })?.numUpdatedRows ?? 0);
    }

    // Count orphaned properties (those on the moved nodes whose property_type
    // still belongs to the old node type — no mapping found)
    const mappedFromIds = new Set(propMapping.map((m) => m.from as string));
    const oldPropTypes: { id: PropertyTypeId }[] = await trx
      .selectFrom('property_type')
      .where('property_type.node_type_id', '=', fromNodeTypeId)
      .where('property_type.team_id', '=', teamId)
      .select('property_type.id')
      .execute();
    const unmappedPropTypeIds = oldPropTypes
      .filter((pt) => !mappedFromIds.has(pt.id as string))
      .map((pt) => pt.id);

    let orphanedProperties = 0;
    if (unmappedPropTypeIds.length) {
      const orphaned = await trx
        .selectFrom('property')
        .where('property.node_id', 'in', nodeIdList)
        .where('property.property_type_id', 'in', unmappedPropTypeIds)
        .where('property.team_id', '=', teamId)
        .select(trx.fn.count('property.id').as('count'))
        .executeTakeFirst();
      orphanedProperties = Number(orphaned?.count ?? 0);
    }

    // 4. Remap edges — update edge_types that reference the old node type
    let edgesRemapped = 0;

    // Find edge types where source = old type, and a corresponding edge type
    // exists (or we create one) where source = new type
    const edgeTypeMapping = await buildEdgeTypeMapping(trx, teamId, fromNodeTypeId, toNodeTypeId);

    for (const etMap of edgeTypeMapping) {
      // Remap edges where source node is being moved
      const srcResult = await trx
        .updateTable('edge')
        .set({ edge_type_id: etMap.to })
        .where('edge.edge_type_id', '=', etMap.from)
        .where('edge.source_node_id', 'in', nodeIdList)
        .where('edge.team_id', '=', teamId)
        .execute();
      edgesRemapped += Number((srcResult[0] as { numUpdatedRows?: bigint })?.numUpdatedRows ?? 0);

      // Remap edges where target node is being moved
      const tgtResult = await trx
        .updateTable('edge')
        .set({ edge_type_id: etMap.to })
        .where('edge.edge_type_id', '=', etMap.from)
        .where('edge.target_node_id', 'in', nodeIdList)
        .where('edge.team_id', '=', teamId)
        .execute();
      edgesRemapped += Number((tgtResult[0] as { numUpdatedRows?: bigint })?.numUpdatedRows ?? 0);
    }

    // 5. Reassign the nodes themselves
    await trx
      .updateTable('node')
      .set({ node_type_id: toNodeTypeId, updated_at: new Date() })
      .where('node.id', 'in', nodeIdList)
      .where('node.team_id', '=', teamId)
      .execute();

    return {
      nodesReassigned: nodeIdList.length,
      propertiesRemapped,
      edgesRemapped,
      orphanedProperties,
    };
  });
}

// ---------------------------------------------------------------------------
// Auto-map property types by matching name (case-insensitive)
// ---------------------------------------------------------------------------

async function buildPropertyMapping(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trx: any,
  teamId: TeamId,
  fromNodeTypeId: NodeTypeId,
  toNodeTypeId: NodeTypeId,
  explicitMapping?: PropertyMapping[],
): Promise<PropertyMapping[]> {
  const result: PropertyMapping[] = [];
  const explicitFromIds = new Set((explicitMapping ?? []).map((m) => m.from as string));

  // Add explicit mappings first
  if (explicitMapping) {
    result.push(...explicitMapping);
  }

  // Fetch property types for both node types
  const fromProps: { id: PropertyTypeId; name: string }[] = await trx
    .selectFrom('property_type')
    .where('property_type.node_type_id', '=', fromNodeTypeId)
    .where('property_type.team_id', '=', teamId)
    .select(['property_type.id', 'property_type.name'])
    .execute();

  const toProps: { id: PropertyTypeId; name: string }[] = await trx
    .selectFrom('property_type')
    .where('property_type.node_type_id', '=', toNodeTypeId)
    .where('property_type.team_id', '=', teamId)
    .select(['property_type.id', 'property_type.name'])
    .execute();

  // Build name→id lookup for target type
  const toByName = new Map(toProps.map((p) => [p.name.toLowerCase(), p.id]));

  // Auto-map by name
  for (const fromProp of fromProps) {
    if (explicitFromIds.has(fromProp.id as string)) continue;
    const match = toByName.get(fromProp.name.toLowerCase());
    if (match) {
      result.push({ from: fromProp.id, to: match });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Auto-map edge types — find edge types on the old node type and match to
// equivalent edge types on the new node type by outbound_name
// ---------------------------------------------------------------------------

async function buildEdgeTypeMapping(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trx: any,
  teamId: TeamId,
  fromNodeTypeId: NodeTypeId,
  toNodeTypeId: NodeTypeId,
): Promise<{ from: EdgeTypeId; to: EdgeTypeId }[]> {
  // Find all edge types that reference the old node type (source or target)
  const oldEdgeTypes: {
    id: EdgeTypeId;
    outbound_name: string;
    source_node_type_id: NodeTypeId;
    target_node_type_id: NodeTypeId;
  }[] = await trx
    .selectFrom('edge_type')
    .where('edge_type.team_id', '=', teamId)
    .where((eb: any) =>
      eb.or([
        eb('edge_type.source_node_type_id', '=', fromNodeTypeId),
        eb('edge_type.target_node_type_id', '=', fromNodeTypeId),
      ]),
    )
    .select([
      'edge_type.id',
      'edge_type.outbound_name',
      'edge_type.source_node_type_id',
      'edge_type.target_node_type_id',
    ])
    .execute();

  // Find all edge types that reference the new node type
  const newEdgeTypes: {
    id: EdgeTypeId;
    outbound_name: string;
    source_node_type_id: NodeTypeId;
    target_node_type_id: NodeTypeId;
  }[] = await trx
    .selectFrom('edge_type')
    .where('edge_type.team_id', '=', teamId)
    .where((eb: any) =>
      eb.or([
        eb('edge_type.source_node_type_id', '=', toNodeTypeId),
        eb('edge_type.target_node_type_id', '=', toNodeTypeId),
      ]),
    )
    .select([
      'edge_type.id',
      'edge_type.outbound_name',
      'edge_type.source_node_type_id',
      'edge_type.target_node_type_id',
    ])
    .execute();

  const result: { from: EdgeTypeId; to: EdgeTypeId }[] = [];

  for (const oldEt of oldEdgeTypes) {
    // Find a matching new edge type: same outbound_name, and the "other"
    // endpoint (the one that isn't the old node type) matches
    const match = newEdgeTypes.find((newEt) => {
      if (newEt.outbound_name !== oldEt.outbound_name) return false;

      const oldIsSource = oldEt.source_node_type_id === (fromNodeTypeId as string);
      const newIsSource = newEt.source_node_type_id === (toNodeTypeId as string);

      if (oldIsSource && newIsSource) {
        return oldEt.target_node_type_id === newEt.target_node_type_id;
      }

      const oldIsTarget = oldEt.target_node_type_id === (fromNodeTypeId as string);
      const newIsTarget = newEt.target_node_type_id === (toNodeTypeId as string);

      if (oldIsTarget && newIsTarget) {
        return oldEt.source_node_type_id === newEt.source_node_type_id;
      }

      return false;
    });

    if (match) {
      result.push({ from: oldEt.id, to: match.id });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// reEvaluateProperties — re-evaluate property values from evidence
// ---------------------------------------------------------------------------

interface ReEvaluateResult {
  propertiesEvaluated: number;
  propertiesChanged: number;
}

const evaluationPromptDef = promptDef({
  description: 'Re-evaluate property value from evidence after ontology change',
  arguments: ['propertyTypeName', 'propertyTypeDescription', 'valueType', 'evidence'] as const,
  messages: [
    {
      role: 'system' as const,
      content: `You are re-evaluating a property value from its evidence after an ontology change.
The property type may have a new name, description, or value type.
Determine the most accurate value given the evidence and the CURRENT property definition.
More recent evidence is generally more reliable.

Respond with a JSON object: {"value": <the value or null>, "reasoning": "<explanation>"}`,
    },
    {
      role: 'user' as const,
      content: `Property: {{{propertyTypeName}}}
Description: {{{propertyTypeDescription}}}
Expected type: {{{valueType}}}

Evidence (most recent first):
{{{evidence}}}`,
    },
  ],
  validator: z.object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).nullable(),
    reasoning: z.string(),
  }),
});

function setPropertyValue(
  valueType: string | null,
  value: unknown,
): { value_text?: string | null; value_number?: string | null; value_date?: string | null; value_boolean?: boolean | null; value_json?: unknown } {
  if (value == null) return {};
  switch (valueType) {
    case 'text':
      return { value_text: String(value) };
    case 'number':
      return { value_number: String(value) };
    case 'date':
      return { value_date: String(value) };
    case 'boolean':
      return { value_boolean: Boolean(value) };
    case 'json':
      return { value_json: value };
    default:
      return { value_text: String(value) };
  }
}

async function reEvaluateProperties(options: {
  teamId: TeamId;
  propertyTypeId: PropertyTypeId;
  nodeIds?: NodeId[];
}): Promise<ReEvaluateResult> {
  const { teamId, propertyTypeId, nodeIds } = options;

  const qb = getKnowledgeQb(['property', 'property_type', 'evidence']);

  // Fetch the property type definition
  const propType = await qb
    .selectFrom('property_type')
    .where('property_type.id', '=', propertyTypeId)
    .where('property_type.team_id', '=', teamId)
    .select([
      'property_type.name',
      'property_type.description',
      'property_type.value_type',
      'property_type.evaluation_strategy',
    ])
    .executeTakeFirstOrThrow();

  // Find all properties of this type
  let propQuery = qb
    .selectFrom('property')
    .where('property.property_type_id', '=', propertyTypeId)
    .where('property.team_id', '=', teamId)
    .select(['property.id', 'property.value_text', 'property.value_number', 'property.value_date', 'property.value_boolean', 'property.value_json', 'property.node_id', 'property.edge_id']);

  if (nodeIds?.length) {
    propQuery = propQuery.where('property.node_id', 'in', nodeIds);
  }

  const properties = await propQuery.execute();

  let propertiesEvaluated = 0;
  let propertiesChanged = 0;

  for (const prop of properties) {
    // Fetch all evidence for this property
    const allEvidence = await qb
      .selectFrom('evidence')
      .where('evidence.property_id', '=', prop.id as PropertyId)
      .where('evidence.team_id', '=', teamId)
      .orderBy('evidence.created_at', 'desc')
      .select(['evidence.type', 'evidence.description', 'evidence.created_at'])
      .execute();

    if (!allEvidence.length) continue;

    // User edits take priority — skip re-evaluation
    const hasUserEdit = allEvidence.some(
      (e: { type: string }) => e.type === EvidenceType.user_edit,
    );
    if (hasUserEdit) continue;

    propertiesEvaluated++;

    // Use LLM to re-evaluate from evidence against current property definition
    const result = await execute(
      'knowledge_reevaluate_property',
      evaluationPromptDef,
      {
        propertyTypeName: propType.name,
        propertyTypeDescription: propType.description,
        valueType: propType.value_type ?? 'text',
        evidence: JSON.stringify(
          allEvidence.map((e: { description: string; created_at: Date }) => ({
            description: e.description,
            created_at: e.created_at,
          })),
        ),
      },
    );

    if (result.value != null) {
      const valueFields = setPropertyValue(propType.value_type, result.value);
      const oldChangeValue = propertyToChangeValue(prop);
      const newChangeValue = propertyToChangeValue(valueFields);

      if (!changeValuesEqual(oldChangeValue, newChangeValue)) {
        propertiesChanged++;
      }

      await qb
        .updateTable('property')
        .set({
          // Clear all value columns first, then set the correct one
          value_text: null,
          value_number: null,
          value_date: null,
          value_boolean: null,
          value_json: null,
          ...valueFields,
          updated_at: new Date(),
        })
        .where('property.id', '=', prop.id as PropertyId)
        .execute();

      if (!changeValuesEqual(oldChangeValue, newChangeValue)) {
        await recordChange({
          teamId,
          requestId: crypto.randomUUID(),
          source: ChangeSource.pipeline,
          kind: ChangeKind.property_set,
          propertyId: prop.id as string,
          nodeId: prop.node_id,
          oldValue: oldChangeValue,
          newValue: newChangeValue,
        });
      }
    }
  }

  return { propertiesEvaluated, propertiesChanged };
}

// ---------------------------------------------------------------------------
// backfillFromFacts — search fact store to populate new ontology elements
// ---------------------------------------------------------------------------

type BackfillType =
  | { kind: 'add_property'; nodeTypeId: NodeTypeId; propertyTypeId: PropertyTypeId }
  | { kind: 'add_node_type'; nodeTypeId: NodeTypeId }
  | { kind: 'add_edge_type'; edgeTypeId: EdgeTypeId };

interface BackfillResult {
  factsSearched: number;
  factsMatched: number;
  instancesFound: number;
  instancesApplied: number;
  instancesSkipped: number;
}

function emptyBackfillResult(): BackfillResult {
  return { factsSearched: 0, factsMatched: 0, instancesFound: 0, instancesApplied: 0, instancesSkipped: 0 };
}

async function backfillFromFacts(options: {
  teamId: TeamId;
  change: BackfillType;
  searchTerms: string[];
}): Promise<BackfillResult> {
  const { teamId, change, searchTerms } = options;

  // 1. Search fact store for relevant facts
  const query = searchTerms.join(' ');
  const facts = await searchFacts({ query, teamId, limit: 500 });
  if (!facts.length) return emptyBackfillResult();

  // 2. Build a purpose-built prompt for this change type
  const prompt = await buildBackfillPrompt(change, teamId);

  // 3. Format facts as numbered list for source_facts references
  const factsText = facts
    .map((f, i) => `Fact ${i}: ${f.subject} ${f.predicate} ${f.object}`)
    .join('\n');

  // 4. Single LLM call to find instances in facts
  const raw = await anthropicChat({
    system: prompt,
    userMessage: factsText,
    model: 'claude-sonnet-5',
    label: 'knowledge_backfill_mapping',
  });

  const instances = parseJson(raw);
  if (!Array.isArray(instances)) return { ...emptyBackfillResult(), factsSearched: facts.length };

  // 5. Resolve + apply each instance
  let applied = 0;
  let skipped = 0;

  for (const instance of instances) {
    try {
      const success = await resolveAndApplyInstance({ instance, change, facts, teamId });
      if (success) applied++;
      else skipped++;
    } catch (err) {
      logger.warn('Backfill instance failed', { error: err, instance });
      skipped++;
    }
  }

  return {
    factsSearched: facts.length,
    factsMatched: instances.length,
    instancesFound: instances.length,
    instancesApplied: applied,
    instancesSkipped: skipped,
  };
}

// ---------------------------------------------------------------------------
// Prompt construction — purpose-built per change type
// ---------------------------------------------------------------------------

async function buildBackfillPrompt(change: BackfillType, teamId: TeamId): Promise<string> {
  const qb = getKnowledgeQb(['node_type', 'property_type', 'edge_type']);

  if (change.kind === 'add_property') {
    const nodeType = await qb
      .selectFrom('node_type')
      .where('node_type.id', '=', change.nodeTypeId)
      .where('node_type.team_id', '=', teamId)
      .select(['node_type.name', 'node_type.description'])
      .executeTakeFirstOrThrow();

    const propType = await qb
      .selectFrom('property_type')
      .where('property_type.id', '=', change.propertyTypeId)
      .where('property_type.team_id', '=', teamId)
      .select(['property_type.name', 'property_type.description', 'property_type.value_type'])
      .executeTakeFirstOrThrow();

    const identityProp = await qb
      .selectFrom('property_type')
      .where('property_type.node_type_id', '=', change.nodeTypeId)
      .where('property_type.team_id', '=', teamId)
      .where('property_type.identity', '!=', PropertyIdentity.none)
      .select(['property_type.name'])
      .executeTakeFirst();

    const identityField = identityProp?.name ?? 'name';

    return [
      `You are searching extracted facts for a specific property.`,
      `For each ${nodeType.name} mentioned, extract: ${propType.name} (${propType.description}).`,
      `Return a JSON array. Each element: {"name": "<${nodeType.name} ${identityField}>", "${propType.name}": <value>, "source_facts": [<fact indices>]}`,
      `Only include entries where you can confidently determine the ${propType.name}.`,
      `Return [] if no relevant facts are found.`,
    ].join('\n');
  }

  if (change.kind === 'add_node_type') {
    const nodeType = await qb
      .selectFrom('node_type')
      .where('node_type.id', '=', change.nodeTypeId)
      .where('node_type.team_id', '=', teamId)
      .select(['node_type.name', 'node_type.description'])
      .executeTakeFirstOrThrow();

    const scopeEdges = await qb
      .selectFrom('edge_type')
      .innerJoin('node_type', 'node_type.id', 'edge_type.source_node_type_id')
      .where('edge_type.target_node_type_id', '=', change.nodeTypeId)
      .where('edge_type.team_id', '=', teamId)
      .where('edge_type.scopes', '=', true)
      .select([
        'edge_type.id',
        'node_type.name as source_node_type_name',
        'edge_type.source_node_type_id',
      ])
      .execute();

    const propTypes = await qb
      .selectFrom('property_type')
      .where('property_type.node_type_id', '=', change.nodeTypeId)
      .where('property_type.team_id', '=', teamId)
      .select(['property_type.name', 'property_type.description', 'property_type.value_type'])
      .execute();

    const scopeFields = scopeEdges
      .map((e) => `"${e.source_node_type_name.toLowerCase()}": "<name>"`)
      .join(', ');
    const propFields = propTypes
      .map((p) => `"${p.name}": <${p.value_type}>`)
      .join(', ');

    return [
      `You are searching extracted facts for ${nodeType.name} instances.`,
      nodeType.description,
      scopeEdges.length > 0
        ? `Each ${nodeType.name} is identified by its parent entities: ${scopeEdges.map((e) => e.source_node_type_name).join(' and ')}.`
        : '',
      propTypes.length > 0
        ? `Properties: ${propTypes.map((p) => `${p.name} (${p.description})`).join(', ')}.`
        : '',
      `Return a JSON array. Each element: {${scopeFields}${scopeFields && propFields ? ', ' : ''}"properties": {${propFields}}, "source_facts": [<fact indices>]}`,
      `Only include entries where parent entities are clearly identifiable.`,
      `Return [] if no relevant facts are found.`,
    ].filter(Boolean).join('\n');
  }

  if (change.kind === 'add_edge_type') {
    const edgeType = await qb
      .selectFrom('edge_type')
      .where('edge_type.id', '=', change.edgeTypeId)
      .where('edge_type.team_id', '=', teamId)
      .select([
        'edge_type.outbound_name',
        'edge_type.description',
        'edge_type.source_node_type_id',
        'edge_type.target_node_type_id',
      ])
      .executeTakeFirstOrThrow();

    const sourceType = await qb
      .selectFrom('node_type')
      .where('node_type.id', '=', edgeType.source_node_type_id as NodeTypeId)
      .select('node_type.name')
      .executeTakeFirstOrThrow();

    const targetType = await qb
      .selectFrom('node_type')
      .where('node_type.id', '=', edgeType.target_node_type_id as NodeTypeId)
      .select('node_type.name')
      .executeTakeFirstOrThrow();

    return [
      `You are searching extracted facts for ${edgeType.outbound_name} relationships.`,
      edgeType.description,
      `Return a JSON array. Each element: {"${sourceType.name.toLowerCase()}": "<name>", "${targetType.name.toLowerCase()}": "<name>", "source_facts": [<fact indices>]}`,
      `Only include entries where both entities are clearly identifiable.`,
      `Return [] if no relevant facts are found.`,
    ].join('\n');
  }

  throw new Error(`Unknown backfill change kind`);
}

// ---------------------------------------------------------------------------
// Resolve entity by name — find existing node by identity property text match
// ---------------------------------------------------------------------------

async function resolveEntityByName(
  nodeTypeId: NodeTypeId,
  name: string,
  teamId: TeamId,
): Promise<NodeId | null> {
  const qb = getKnowledgeQb(['node', 'property', 'property_type']);

  // Find identity properties for this node type
  const identityPropTypes = await qb
    .selectFrom('property_type')
    .where('property_type.node_type_id', '=', nodeTypeId)
    .where('property_type.team_id', '=', teamId)
    .where('property_type.identity', '!=', PropertyIdentity.none)
    .select('property_type.id')
    .execute();

  if (!identityPropTypes.length) return null;

  // Search by fuzzy text match against identity properties
  const candidates = await qb
    .selectFrom('node')
    .innerJoin('property', 'property.node_id', 'node.id')
    .where('node.node_type_id', '=', nodeTypeId)
    .where('node.team_id', '=', teamId)
    .where('property.property_type_id', 'in', identityPropTypes.map((pt) => pt.id))
    .where(sql`lower(property.value_text)`, '=', name.toLowerCase())
    .select('node.id')
    .limit(1)
    .execute();

  return candidates.length > 0 ? candidates[0].id : null;
}

// ---------------------------------------------------------------------------
// Resolve and apply a single backfill instance
// ---------------------------------------------------------------------------

interface FactRef {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  message_node_id: string;
  resource_id: string | null;
  similarity: number;
}

async function resolveAndApplyInstance(options: {
  instance: Record<string, unknown>;
  change: BackfillType;
  facts: FactRef[];
  teamId: TeamId;
}): Promise<boolean> {
  const { instance, change, facts, teamId } = options;

  if (change.kind === 'add_property') {
    return resolveAddProperty({ instance, change, facts, teamId });
  }
  if (change.kind === 'add_node_type') {
    return resolveAddNodeType({ instance, change, facts, teamId });
  }
  if (change.kind === 'add_edge_type') {
    return resolveAddEdgeType({ instance, change, facts, teamId });
  }
  return false;
}

// -- add_property resolution --

async function resolveAddProperty(options: {
  instance: Record<string, unknown>;
  change: { kind: 'add_property'; nodeTypeId: NodeTypeId; propertyTypeId: PropertyTypeId };
  facts: FactRef[];
  teamId: TeamId;
}): Promise<boolean> {
  const { instance, change, facts, teamId } = options;
  const qb = getKnowledgeQb(['property', 'property_type', 'evidence']);

  const name = instance.name as string | undefined;
  if (!name) return false;

  const nodeId = await resolveEntityByName(change.nodeTypeId, name, teamId);
  if (!nodeId) return false;

  // Check if property already exists on this node
  const existing = await qb
    .selectFrom('property')
    .where('property.node_id', '=', nodeId)
    .where('property.property_type_id', '=', change.propertyTypeId)
    .where('property.team_id', '=', teamId)
    .select('property.id')
    .executeTakeFirst();
  if (existing) return false;

  // Fetch property type for value column mapping
  const propType = await qb
    .selectFrom('property_type')
    .where('property_type.id', '=', change.propertyTypeId)
    .where('property_type.team_id', '=', teamId)
    .select(['property_type.name', 'property_type.value_type'])
    .executeTakeFirstOrThrow();

  const value = instance[propType.name];
  if (value == null) return false;

  const valueFields = setPropertyValue(propType.value_type, value);

  const prop = await qb
    .insertInto('property')
    .values({
      team_id: teamId,
      node_id: nodeId,
      property_type_id: change.propertyTypeId,
      ...valueFields,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  // Create evidence from source facts
  await createEvidenceFromFacts({
    qb,
    teamId,
    propertyId: prop.id as PropertyId,
    sourceFactIndices: instance.source_facts as number[] | undefined,
    facts,
  });

  return true;
}

// -- add_node_type resolution --

async function resolveAddNodeType(options: {
  instance: Record<string, unknown>;
  change: { kind: 'add_node_type'; nodeTypeId: NodeTypeId };
  facts: FactRef[];
  teamId: TeamId;
}): Promise<boolean> {
  const { instance, change, facts, teamId } = options;
  const qb = getKnowledgeQb(['node', 'edge', 'edge_type', 'node_type', 'property', 'property_type', 'evidence']);

  // Resolve ALL scope parents
  const scopeEdges = await qb
    .selectFrom('edge_type')
    .innerJoin('node_type', 'node_type.id', 'edge_type.source_node_type_id')
    .where('edge_type.target_node_type_id', '=', change.nodeTypeId)
    .where('edge_type.team_id', '=', teamId)
    .where('edge_type.scopes', '=', true)
    .select([
      'edge_type.id as edge_type_id',
      'edge_type.source_node_type_id',
      'node_type.name as source_node_type_name',
    ])
    .execute();

  const parentNodeIds = new Map<EdgeTypeId, NodeId>();

  for (const scopeEdge of scopeEdges) {
    const parentKey = scopeEdge.source_node_type_name.toLowerCase();
    const parentName = instance[parentKey] as string | undefined;
    if (!parentName) return false;

    const parentId = await resolveEntityByName(
      scopeEdge.source_node_type_id as NodeTypeId,
      parentName,
      teamId,
    );
    if (!parentId) return false;

    parentNodeIds.set(scopeEdge.edge_type_id as EdgeTypeId, parentId);
  }

  // Check if this scoped object already exists (compound scope: all parents must match)
  if (parentNodeIds.size > 0) {
    let existsQuery = qb
      .selectFrom('node')
      .where('node.node_type_id', '=', change.nodeTypeId)
      .where('node.team_id', '=', teamId)
      .select('node.id');

    for (const parentId of parentNodeIds.values()) {
      existsQuery = existsQuery.where((eb) =>
        eb.exists(
          eb
            .selectFrom('edge')
            .whereRef('edge.target_node_id', '=', 'node.id')
            .where('edge.source_node_id', '=', parentId),
        ),
      );
    }

    const existingNodes = await existsQuery.limit(1).execute();
    if (existingNodes.length > 0) return false;
  }

  // Create the node
  const node = await qb
    .insertInto('node')
    .values({ team_id: teamId, node_type_id: change.nodeTypeId })
    .returning('id')
    .executeTakeFirstOrThrow();

  // Create scope edges
  for (const [edgeTypeId, parentId] of parentNodeIds) {
    await qb.insertInto('edge').values({
      team_id: teamId,
      source_node_id: parentId,
      target_node_id: node.id as NodeId,
      edge_type_id: edgeTypeId,
    }).execute();
  }

  // Create properties
  const propTypes = await qb
    .selectFrom('property_type')
    .where('property_type.node_type_id', '=', change.nodeTypeId)
    .where('property_type.team_id', '=', teamId)
    .select(['property_type.id', 'property_type.name', 'property_type.value_type'])
    .execute();

  const properties = (instance.properties ?? {}) as Record<string, unknown>;

  for (const propType of propTypes) {
    const value = properties[propType.name];
    if (value == null) continue;

    const valueFields = setPropertyValue(propType.value_type, value);
    const prop = await qb
      .insertInto('property')
      .values({
        team_id: teamId,
        node_id: node.id as NodeId,
        property_type_id: propType.id as PropertyTypeId,
        ...valueFields,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await createEvidenceFromFacts({
      qb,
      teamId,
      propertyId: prop.id as PropertyId,
      sourceFactIndices: instance.source_facts as number[] | undefined,
      facts,
    });
  }

  // Summarize + embed the new node
  await summarizeAndEmbedSingleNode(node.id as NodeId, teamId);

  return true;
}

// -- add_edge_type resolution --

async function resolveAddEdgeType(options: {
  instance: Record<string, unknown>;
  change: { kind: 'add_edge_type'; edgeTypeId: EdgeTypeId };
  facts: FactRef[];
  teamId: TeamId;
}): Promise<boolean> {
  const { instance, change, facts, teamId } = options;
  const qb = getKnowledgeQb(['node', 'edge', 'edge_type', 'node_type', 'property', 'property_type', 'evidence']);

  // Fetch edge type to know source/target node types
  const edgeType = await qb
    .selectFrom('edge_type')
    .where('edge_type.id', '=', change.edgeTypeId)
    .where('edge_type.team_id', '=', teamId)
    .select(['edge_type.source_node_type_id', 'edge_type.target_node_type_id'])
    .executeTakeFirstOrThrow();

  const sourceNodeType = await qb
    .selectFrom('node_type')
    .where('node_type.id', '=', edgeType.source_node_type_id as NodeTypeId)
    .select('node_type.name')
    .executeTakeFirstOrThrow();

  const targetNodeType = await qb
    .selectFrom('node_type')
    .where('node_type.id', '=', edgeType.target_node_type_id as NodeTypeId)
    .select('node_type.name')
    .executeTakeFirstOrThrow();

  const sourceName = instance[sourceNodeType.name.toLowerCase()] as string | undefined;
  const targetName = instance[targetNodeType.name.toLowerCase()] as string | undefined;
  if (!sourceName || !targetName) return false;

  const sourceNodeId = await resolveEntityByName(
    edgeType.source_node_type_id as NodeTypeId,
    sourceName,
    teamId,
  );
  const targetNodeId = await resolveEntityByName(
    edgeType.target_node_type_id as NodeTypeId,
    targetName,
    teamId,
  );
  if (!sourceNodeId || !targetNodeId) return false;

  // Check if edge already exists
  const existing = await qb
    .selectFrom('edge')
    .where('edge.source_node_id', '=', sourceNodeId)
    .where('edge.target_node_id', '=', targetNodeId)
    .where('edge.edge_type_id', '=', change.edgeTypeId)
    .where('edge.team_id', '=', teamId)
    .select('edge.id')
    .executeTakeFirst();
  if (existing) return false;

  await qb.insertInto('edge').values({
    team_id: teamId,
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    edge_type_id: change.edgeTypeId,
  }).execute();

  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createEvidenceFromFacts(options: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qb: any;
  teamId: TeamId;
  propertyId: PropertyId;
  sourceFactIndices: number[] | undefined;
  facts: FactRef[];
}): Promise<void> {
  const { qb, teamId, propertyId, sourceFactIndices, facts } = options;

  const indices = sourceFactIndices ?? [];
  for (const factIdx of indices) {
    const fact = facts[factIdx];
    if (!fact) continue;

    await qb.insertInto('evidence').values({
      team_id: teamId,
      property_id: propertyId,
      source_ref: fact.resource_id
        ? JSON.stringify({ kind: 'resource', id: fact.resource_id })
        : null,
      type: EvidenceType.extraction,
      description: `Backfill: ${fact.subject} ${fact.predicate} ${fact.object}`,
    }).execute();
  }
}

async function summarizeAndEmbedSingleNode(nodeId: NodeId, teamId: TeamId): Promise<void> {
  const qb = getKnowledgeQb(['node', 'property', 'property_type', 'node_type']);

  // Build a simple summary text from properties
  const nodeInfo = await qb
    .selectFrom('node')
    .innerJoin('node_type', 'node_type.id', 'node.node_type_id')
    .where('node.id', '=', nodeId)
    .select(['node_type.name as type_name'])
    .executeTakeFirst();

  if (!nodeInfo) return;

  const props = await qb
    .selectFrom('property')
    .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
    .where('property.node_id', '=', nodeId)
    .where('property.team_id', '=', teamId)
    .select(['property_type.name', 'property.value_text', 'property.value_number', 'property.value_boolean'])
    .execute();

  const lines = [`## ${nodeInfo.type_name}`];
  for (const p of props) {
    const val = p.value_text ?? p.value_number ?? p.value_boolean;
    if (val != null) lines.push(`${p.name}: ${val}`);
  }
  const summary = lines.join('\n');

  // Save summary
  await qb
    .updateTable('node')
    .set({ summary })
    .where('node.id', '=', nodeId)
    .execute();
  // The embedding that used to follow went with `node.summary_embedding` (K-12).
}

export { reassignNodes, reEvaluateProperties, backfillFromFacts };
export type { PropertyMapping, ReassignResult, ReEvaluateResult, BackfillType, BackfillResult };
