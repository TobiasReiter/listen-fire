import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { z } from 'zod';

import type { EdgeTypeMetaMap } from '../../lib/knowledge/relationship_context';
import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import type { EdgeTypeId } from '../../generated/kysely/knowledge/EdgeType';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { EdgeStep } from '#shared/expression/types';
import type { EdgeFilter } from '../../lib/knowledge/templates/types';
import type {
  ExtractedSubgraph,
  ExtractedNode,
  ExtractedProperty,
  ExtractedEdge,
  ExtractedEvidence,
  ResolutionDecision,
  Changeset,
  ChangesetNode,
  ChangesetProperty,
} from './types';
import type { StoredUniquenessConstraints } from './uniqueness_constraints';

import {
  searchCandidatesByConstraints,
  loadConstraintsForNodeTypes,
  collectEdgeTypeIds,
  isEdgeToEntry,
} from './uniqueness_constraints';
import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import {
  loadEdgeTypeMeta,
  buildRelationshipContextFromDb,
  buildRelationshipContextFromSubgraph,
  formatEntityContext,
} from '../../lib/knowledge/relationship_context';
import { resolveDisplayNames } from '../../lib/knowledge/resolve_display_name';
import { logger } from 'movement-engine/public/log';
import { promptDef } from '../../lib/prompts/definition';
import { execute } from '../../lib/prompts/execute';
import { getKnowledgeQb } from '../../lib/kysely';

// -- Topological sort (constraint-driven) --

function topologicalSortByConstraints(
  subgraph: ExtractedSubgraph,
  constraintsMap: Map<string, StoredUniquenessConstraints>,
  edgeTypeInfo: Map<string, { sourceNodeTypeId: string; targetNodeTypeId: string }>,
): ExtractedNode[] {
  // Build node-type-level dependency graph from constraint edge references
  const nodeTypeOrder = new Map<string, number>();
  const nodesByType = new Map<string, ExtractedNode[]>();

  for (const node of subgraph.nodes) {
    const ntId = node.nodeType as string;
    const arr = nodesByType.get(ntId) ?? [];
    arr.push(node);
    nodesByType.set(ntId, arr);
  }

  // Build deps: nodeType → depends on nodeTypes
  const deps = new Map<string, Set<string>>();
  for (const ntId of nodesByType.keys()) {
    deps.set(ntId, new Set());
  }

  for (const [ntId, constraints] of constraintsMap) {
    if (!deps.has(ntId)) continue;
    for (const constraint of constraints) {
      for (const entry of constraint) {
        // `edge_to` entries reference TG-ancestor names rather than
        // ontology edge types; they don't contribute node-type-level
        // dependencies here (the TG drives ancestor ordering directly).
        if (isEdgeToEntry(entry)) continue;
        const edgeTypeIds = collectEdgeTypeIds(entry.expr);
        for (const etId of edgeTypeIds) {
          const et = edgeTypeInfo.get(etId);
          if (!et) continue;
          const dependsOn = et.sourceNodeTypeId === ntId ? et.targetNodeTypeId : et.sourceNodeTypeId;
          if (deps.has(dependsOn)) deps.get(ntId)!.add(dependsOn);
        }
      }
    }
  }

  // Kahn's algorithm — deps[A] = {B} means A depends on B (B must come before A)
  const dependents = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const [id] of deps) {
    dependents.set(id, new Set());
    inDegree.set(id, 0);
  }
  for (const [id, d] of deps) {
    inDegree.set(id, d.size);
    for (const dep of d) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep)!.add(id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const typeOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    typeOrder.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  // Fallback: if topo sort didn't cover all types (shouldn't happen if no cycles),
  // append remaining types
  for (const ntId of nodesByType.keys()) {
    if (!typeOrder.includes(ntId)) typeOrder.push(ntId);
  }

  // Emit nodes in type order, preserving extraction order within each type
  const ordered: ExtractedNode[] = [];
  for (const ntId of typeOrder) {
    for (const node of nodesByType.get(ntId) ?? []) {
      if (node.tempId !== subgraph.messageNode.tempId) {
        ordered.push(node);
      }
    }
  }

  return ordered;
}

// -- LLM matching --

const matchPromptDef = promptDef({
  description: 'Match extracted entity against candidates',
  arguments: ['extracted', 'candidates'] as const,
  messages: [
    {
      role: 'system' as const,
      content: `You are an entity resolution system.
Given an extracted entity and candidate matches from a knowledge graph,
decide which (if any) represents the same real-world entity.

Consider:
- Property values (names, identifiers)
- Relationships to other entities (shared connections strongly suggest same entity)
- Ancestor context (e.g., "John at Company X" vs "John at Company Y")

If uncertain, return null for match_index. Better to create a duplicate than incorrectly merge.

Respond with a JSON object: {"match_index": <number or null>, "confidence": <0-1>, "reasoning": "<explanation>"}`,
    },
    {
      role: 'user' as const,
      content: `Extracted entity:
{{{extracted}}}

Candidates:
{{{candidates}}}`,
    },
  ],
  validator: z.object({
    match_index: z.number().nullable(),
    confidence: z.number(),
    reasoning: z.string(),
  }),
});

// -- Unified resolution --

async function resolveNode(
  node: ExtractedNode,
  subgraph: ExtractedSubgraph,
  resolved: Map<string, ResolutionDecision>,
  constraints: StoredUniquenessConstraints,
  edgeTypeMeta: EdgeTypeMetaMap,
  teamId: TeamId,
): Promise<ResolutionDecision> {
  if (!constraints.length) return { action: 'create' };

  // Collect extracted property values for this node
  const extractedPropertyValues = new Map<string, unknown>();
  for (const prop of subgraph.properties) {
    if (prop.parentTempId === node.tempId && prop.value != null) {
      extractedPropertyValues.set(prop.propertyTypeId as string, prop.value);
    }
  }

  // Collect resolved edge targets from prior resolutions
  const resolvedEdgeTargets = new Map<string, NodeId>();
  for (const edge of subgraph.edges) {
    if (edge.sourceTempId === node.tempId) {
      const targetResolution = resolved.get(edge.targetTempId);
      if (targetResolution?.action === 'match') {
        resolvedEdgeTargets.set(edge.edgeType as string, targetResolution.existingNodeId);
      }
    }
    if (edge.targetTempId === node.tempId) {
      const sourceResolution = resolved.get(edge.sourceTempId);
      if (sourceResolution?.action === 'match') {
        resolvedEdgeTargets.set(edge.edgeType as string, sourceResolution.existingNodeId);
      }
    }
  }

  const candidates = await searchCandidatesByConstraints({
    nodeType: node.nodeType,
    constraints,
    extractedPropertyValues,
    resolvedEdgeTargets,
    teamId,
  });

  if (!candidates.length) return { action: 'create' };

  // Single exact match → auto-match, skip LLM
  const exactMatches = candidates.filter((c) => c.allEntriesExact);
  if (exactMatches.length === 1) {
    logger.info('[consolidate] resolveNode: exact match, skipping LLM', {
      nodeType: node.nodeType,
      matchedNodeId: exactMatches[0].nodeId,
      constraintIndex: exactMatches[0].constraintIndex,
    });
    return {
      action: 'match',
      existingNodeId: exactMatches[0].nodeId,
      confidence: 1.0,
    };
  }

  // Fuzzy or ambiguous matches → LLM decides
  const { entries: extractedRels, dbNodeIdsToResolve } = buildRelationshipContextFromSubgraph({
    tempId: node.tempId,
    subgraph,
    resolved,
    edgeTypeMeta,
  });

  let resolvedNames = new Map<string, string | null>();
  if (dbNodeIdsToResolve.length > 0) {
    resolvedNames = await resolveDisplayNames({ nodeIds: dbNodeIdsToResolve, teamId: teamId as string });
    const { entries: enrichedRels } = buildRelationshipContextFromSubgraph({
      tempId: node.tempId,
      subgraph,
      resolved,
      edgeTypeMeta,
      resolvedDisplayNames: resolvedNames,
    });
    extractedRels.length = 0;
    extractedRels.push(...enrichedRels);
  }

  // Build property name map for display
  const propNames = new Map<string, string>();
  for (const [propTypeId] of extractedPropertyValues) {
    propNames.set(propTypeId, propTypeId); // fallback to ID
  }
  // Fetch actual names
  const propTypeIds = [...extractedPropertyValues.keys()] as PropertyTypeId[];
  if (propTypeIds.length > 0) {
    const qb = getKnowledgeQb(['property_type']);
    const rows = await qb
      .selectFrom('property_type')
      .where('property_type.id', 'in', propTypeIds)
      .select(['property_type.id', 'property_type.name'])
      .execute();
    for (const row of rows) propNames.set(row.id as string, row.name);
  }

  const extractedText = formatEntityContext({
    properties: Object.fromEntries(
      [...extractedPropertyValues].map(([id, val]) => [propNames.get(id) ?? id, val]),
    ),
    relationships: extractedRels,
  });

  const candidateTexts = await Promise.all(
    candidates.map(async (c, i) => {
      const rels = await buildRelationshipContextFromDb({
        nodeId: c.nodeId,
        teamId,
        edgeTypeMeta,
      });
      const text = formatEntityContext({
        properties: c.properties,
        relationships: rels,
      });
      return `[Candidate ${i}]\n${text}`;
    }),
  );

  logger.info('[consolidate] resolveNode: LLM matching', {
    nodeType: node.nodeType,
    candidateCount: candidates.length,
  });

  const result = await execute('knowledge_match', matchPromptDef, {
    extracted: extractedText,
    candidates: candidateTexts.join('\n\n'),
  });

  if (result.match_index != null && result.confidence > 0.5) {
    return {
      action: 'match',
      existingNodeId: candidates[result.match_index].nodeId,
      confidence: result.confidence,
    };
  }

  return { action: 'create' };
}

async function resolveProperty(
  prop: ExtractedProperty,
  resolved: Map<string, ResolutionDecision>,
  teamId: TeamId,
): Promise<ResolutionDecision> {
  if (prop.ownerEdgeKey) {
    return resolveEdgeProperty(prop, resolved, teamId);
  }

  const parentResolution = resolved.get(prop.parentTempId);
  if (!parentResolution || parentResolution.action === 'create') return { action: 'create' };

  // Parent matched an existing node — look for existing property row
  const qb = getKnowledgeQb(['property']);

  const existing = await qb
    .selectFrom('property')
    .where('property.node_id', '=', parentResolution.existingNodeId)
    .where('property.property_type_id', '=', prop.propertyTypeId)
    .select(['property.id'])
    .executeTakeFirst();

  if (existing) {
    return {
      action: 'match',
      existingNodeId: existing.id as unknown as NodeId,
      confidence: 1.0,
    };
  }

  return { action: 'create' };
}

async function resolveEdgeProperty(
  prop: ExtractedProperty,
  resolved: Map<string, ResolutionDecision>,
  teamId: TeamId,
): Promise<ResolutionDecision> {
  const parts = prop.ownerEdgeKey!.split(':');
  if (parts.length !== 3) return { action: 'create' };
  const [srcTempId, tgtTempId, edgeTypeId] = parts;

  const srcResolution = resolved.get(srcTempId);
  const tgtResolution = resolved.get(tgtTempId);
  if (!srcResolution || srcResolution.action === 'create') return { action: 'create' };
  if (!tgtResolution || tgtResolution.action === 'create') return { action: 'create' };

  // Both endpoints matched — find the existing edge
  const qb = getKnowledgeQb(['edge', 'property']);

  const existingEdge = await qb
    .selectFrom('edge')
    .where('edge.source_node_id', '=', srcResolution.existingNodeId)
    .where('edge.target_node_id', '=', tgtResolution.existingNodeId)
    .where('edge.edge_type_id', '=', edgeTypeId as EdgeTypeId)
    .where('edge.team_id', '=', teamId)
    .select('edge.id')
    .executeTakeFirst();

  if (!existingEdge) return { action: 'create' };

  // Edge exists — check for existing property on that edge
  const existingProp = await qb
    .selectFrom('property')
    .where('property.edge_id', '=', existingEdge.id)
    .where('property.property_type_id', '=', prop.propertyTypeId)
    .select('property.id')
    .executeTakeFirst();

  if (existingProp) {
    return {
      action: 'match',
      existingNodeId: existingProp.id as unknown as NodeId,
      confidence: 1.0,
    };
  }

  return { action: 'create' };
}

// -- Auto-role injection from filters --

function parseFilters(raw: unknown): EdgeFilter[] {
  if (!raw) return [];
  if (typeof raw === 'string') return JSON.parse(raw);
  if (Array.isArray(raw)) return raw as EdgeFilter[];
  return [];
}

async function injectFilterRoles(
  subgraph: ExtractedSubgraph,
  resolved: Map<string, ResolutionDecision>,
  teamId: TeamId,
): Promise<{
  syntheticProperties: ExtractedProperty[];
  syntheticEvidence: ExtractedEvidence[];
}> {
  const syntheticProperties: ExtractedProperty[] = [];
  const syntheticEvidence: ExtractedEvidence[] = [];

  const edgeTypeIds = [...new Set(subgraph.edges.map((e) => e.edgeType))];
  if (!edgeTypeIds.length) return { syntheticProperties, syntheticEvidence };

  const qb = getKnowledgeQb(['edge_type', 'property_type', 'property']);

  // Fetch edge types with filters
  const edgeTypesWithFilters = await qb
    .selectFrom('edge_type')
    .where('edge_type.id', 'in', edgeTypeIds)
    .where('edge_type.filters', '!=', '[]')
    .select(['edge_type.id', 'edge_type.filters', 'edge_type.source_node_type_id', 'edge_type.target_node_type_id'])
    .execute();

  if (!edgeTypesWithFilters.length) return { syntheticProperties, syntheticEvidence };

  // Collect implied role values per node tempId
  const impliedRoles = new Map<string, { nodeTypeId: NodeTypeId; property: string; value: string }[]>();

  for (const et of edgeTypesWithFilters) {
    const filters = parseFilters(et.filters);
    for (const f of filters) {
      // Find which tempIds are on the filtered side
      const targetSideNodeTypeId = f.side === 'source' ? et.source_node_type_id as NodeTypeId : et.target_node_type_id as NodeTypeId;

      for (const edge of subgraph.edges) {
        if (edge.edgeType !== et.id) continue;
        const tempId = f.side === 'source' ? edge.sourceTempId : edge.targetTempId;
        const entries = impliedRoles.get(tempId) ?? [];
        entries.push({ nodeTypeId: targetSideNodeTypeId, property: f.property, value: f.value });
        impliedRoles.set(tempId, entries);
      }
    }
  }

  if (!impliedRoles.size) return { syntheticProperties, syntheticEvidence };

  // For each implied role, find the matching property_type and check if it already exists
  const nodeTypeIds = [...new Set([...impliedRoles.values()].flatMap((entries) => entries.map((e) => e.nodeTypeId)))];
  const propertyNames = [...new Set([...impliedRoles.values()].flatMap((entries) => entries.map((e) => e.property)))];

  const propTypes = await qb
    .selectFrom('property_type')
    .where('property_type.node_type_id', 'in', nodeTypeIds)
    .where('property_type.name', 'in', propertyNames)
    .where('property_type.team_id', '=', teamId)
    .select(['property_type.id', 'property_type.node_type_id', 'property_type.name'])
    .execute();

  const propTypeMap = new Map(propTypes.map((pt) => [`${pt.node_type_id}:${pt.name}`, pt.id as PropertyTypeId]));

  for (const [tempId, roleEntries] of impliedRoles) {
    const resolution = resolved.get(tempId);

    for (const entry of roleEntries) {
      const propTypeId = propTypeMap.get(`${entry.nodeTypeId}:${entry.property}`);
      if (!propTypeId) continue;

      // Check if a property with this value already exists in the subgraph
      const alreadyExtracted = subgraph.properties.some(
        (p) => p.parentTempId === tempId && p.propertyTypeId === propTypeId && p.value === entry.value,
      );
      if (alreadyExtracted) continue;

      // For matched entities, check if the property already exists in DB
      if (resolution?.action === 'match') {
        const existing = await qb
          .selectFrom('property')
          .where('property.node_id', '=', resolution.existingNodeId)
          .where('property.property_type_id', '=', propTypeId)
          .where(sql`lower(property.value_text)`, '=', entry.value.toLowerCase())
          .select('property.id')
          .executeTakeFirst();

        if (existing) continue;
      }

      const propTempId = `filter_role_${randomUUID()}`;
      syntheticProperties.push({
        tempId: propTempId,
        propertyTypeId: propTypeId,
        parentTempId: tempId,
        value: entry.value,
        evidenceDescription: `${entry.property} "${entry.value}" assigned from edge filter`,
      });
      syntheticEvidence.push({
        targetPropertyTempId: propTempId,
        resourceId: null,
        type: EvidenceType.extraction,
        description: `${entry.property} "${entry.value}" assigned from extraction context`,
      });
      resolved.set(propTempId, { action: 'create' });
    }
  }

  return { syntheticProperties, syntheticEvidence };
}

// -- Main consolidation --

async function consolidate(
  subgraph: ExtractedSubgraph,
  teamId: TeamId,
): Promise<Changeset> {
  const resolved = new Map<string, ResolutionDecision>();

  // Fetch edge type metadata (names, directions) — used for relationship context
  const edgeTypeIds = [...new Set(subgraph.edges.map((e) => e.edgeType))];
  const edgeTypeMeta = await loadEdgeTypeMeta({
    edgeTypeIds: edgeTypeIds.map((id) => id as string),
    teamId,
  });

  // Load uniqueness constraints for all node types in the subgraph
  const nodeTypeIds = [...new Set(subgraph.nodes.map((n) => n.nodeType))];
  const constraintsMap = await loadConstraintsForNodeTypes(nodeTypeIds, teamId);

  // Load edge type source/target info for topo sort
  const edgeTypeInfo = new Map<string, { sourceNodeTypeId: string; targetNodeTypeId: string }>();
  if (edgeTypeIds.length > 0) {
    const qb = getKnowledgeQb(['edge_type']);
    const etRows = await qb
      .selectFrom('edge_type')
      .where('edge_type.id', 'in', edgeTypeIds)
      .select(['edge_type.id', 'edge_type.source_node_type_id', 'edge_type.target_node_type_id'])
      .execute();
    for (const row of etRows) {
      edgeTypeInfo.set(row.id as string, {
        sourceNodeTypeId: row.source_node_type_id as string,
        targetNodeTypeId: row.target_node_type_id as string,
      });
    }
  }

  // Topological sort based on constraint edge dependencies
  const ordered = topologicalSortByConstraints(subgraph, constraintsMap, edgeTypeInfo);

  // Message node is always created
  resolved.set(subgraph.messageNode.tempId, { action: 'create' });

  // Resolve entity nodes using uniqueness constraints
  for (const node of ordered) {
    const constraints = constraintsMap.get(node.nodeType as string) ?? [];
    const decision = await resolveNode(node, subgraph, resolved, constraints, edgeTypeMeta, teamId);
    resolved.set(node.tempId, decision);
  }

  // Resolve properties
  const propertyResolutions = new Map<string, ResolutionDecision>();
  for (const prop of subgraph.properties) {
    const decision = await resolveProperty(prop, resolved, teamId);
    propertyResolutions.set(prop.tempId, decision);
  }

  // Auto-inject role properties from edge filters
  const { syntheticProperties, syntheticEvidence } = await injectFilterRoles(subgraph, resolved, teamId);

  // Resolve synthetic properties
  for (const prop of syntheticProperties) {
    const decision = await resolveProperty(prop, resolved, teamId);
    propertyResolutions.set(prop.tempId, decision);
  }

  const allProperties = [...subgraph.properties, ...syntheticProperties];
  const allEvidence = [...subgraph.evidence, ...syntheticEvidence];

  // Build changeset
  const changesetNodes: ChangesetNode[] = subgraph.nodes.map((node) => ({
    ...node,
    resolution: resolved.get(node.tempId) ?? { action: 'create' },
  }));

  const changesetProperties: ChangesetProperty[] = allProperties.map((prop) => ({
    ...prop,
    resolution: propertyResolutions.get(prop.tempId) ?? { action: 'create' },
  }));

  return {
    messageNode: { tempId: subgraph.messageNode.tempId, nodeType: subgraph.messageNode.nodeType },
    nodes: changesetNodes,
    properties: changesetProperties,
    edges: subgraph.edges,
    evidence: allEvidence,
    edgeEvidence: subgraph.edgeEvidence,
    nodeResources: subgraph.nodeResources,
  };
}

export { consolidate };
