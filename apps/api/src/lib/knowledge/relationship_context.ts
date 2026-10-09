import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { EdgeTypeId } from '../../generated/kysely/knowledge/EdgeType';
import type { TeamId } from '../../generated/kysely/core/Team';
import type {
  ExtractedSubgraph,
  ExtractedProperty,
  ResolutionDecision,
} from '../../services/knowledge_pipeline/types';

import { resolveDisplayNames } from './resolve_display_name';
import { getKnowledgeQb } from '../kysely';

// -- Types --

interface EdgeTypeMeta {
  outboundName: string;
  inboundName: string;
  sourceNodeTypeId: NodeTypeId;
  targetNodeTypeId: NodeTypeId;
}

type EdgeTypeMetaMap = Map<string, EdgeTypeMeta>;

interface RelationshipEntry {
  edgeName: string;
  targetName: string;
  edgeProperties?: Record<string, unknown>;
}

interface EntityContext {
  properties: Record<string, unknown>;
  relationships: RelationshipEntry[];
}

const CAP_PER_EDGE_TYPE = 5;

// -- Metadata loaders --

async function loadEdgeTypeMeta(options: {
  edgeTypeIds: string[];
  teamId: TeamId;
}): Promise<EdgeTypeMetaMap> {
  const { edgeTypeIds, teamId } = options;
  if (!edgeTypeIds.length) return new Map();

  const rows = await getKnowledgeQb(['edge_type'])
    .selectFrom('edge_type')
    .where('edge_type.id', 'in', edgeTypeIds as EdgeTypeId[])
    .where('edge_type.team_id', '=', teamId)
    .select([
      'edge_type.id',
      'edge_type.outbound_name',
      'edge_type.inbound_name',
      'edge_type.source_node_type_id',
      'edge_type.target_node_type_id',
    ])
    .execute();

  const map: EdgeTypeMetaMap = new Map();
  for (const row of rows) {
    map.set(row.id as string, {
      outboundName: row.outbound_name,
      inboundName: row.inbound_name,
      sourceNodeTypeId: row.source_node_type_id as NodeTypeId,
      targetNodeTypeId: row.target_node_type_id as NodeTypeId,
    });
  }
  return map;
}

async function loadNodeTypeNames(options: {
  nodeTypeIds: string[];
  teamId: TeamId;
}): Promise<Map<string, string>> {
  const { nodeTypeIds, teamId } = options;
  if (!nodeTypeIds.length) return new Map();

  const rows = await getKnowledgeQb(['node_type'])
    .selectFrom('node_type')
    .where('node_type.id', 'in', nodeTypeIds as NodeTypeId[])
    .where('node_type.team_id', '=', teamId)
    .select(['node_type.id', 'node_type.name'])
    .execute();

  return new Map(rows.map((r) => [r.id as string, r.name]));
}

// -- Direction helper --

function orientEdgeName(
  edgeTypeMeta: EdgeTypeMeta,
  entityIsSource: boolean,
): string {
  const name = entityIsSource ? edgeTypeMeta.outboundName : edgeTypeMeta.inboundName;
  return name.replace(/_/g, ' ');
}

// -- Build from DB --

async function buildRelationshipContextFromDb(options: {
  nodeId: NodeId;
  teamId: TeamId;
  edgeTypeMeta?: EdgeTypeMetaMap;
}): Promise<RelationshipEntry[]> {
  const { nodeId, teamId } = options;
  const qb = getKnowledgeQb(['edge', 'property', 'property_type']);

  // Fetch all edges involving this node
  const edges = await qb
    .selectFrom('edge')
    .where((eb) =>
      eb.or([
        eb('edge.source_node_id', '=', nodeId),
        eb('edge.target_node_id', '=', nodeId),
      ]),
    )
    .select(['edge.id', 'edge.source_node_id', 'edge.target_node_id', 'edge.edge_type_id'])
    .execute();

  if (!edges.length) return [];

  // Load edge type meta if not provided
  const edgeTypeIds = [...new Set(edges.map((e) => e.edge_type_id as string))];
  const meta = options.edgeTypeMeta ?? await loadEdgeTypeMeta({ edgeTypeIds, teamId });

  // Group by edge type and cap
  const byEdgeType = new Map<string, typeof edges>();
  for (const edge of edges) {
    const key = edge.edge_type_id as string;
    const arr = byEdgeType.get(key) ?? [];
    arr.push(edge);
    byEdgeType.set(key, arr);
  }

  // Collect neighbor IDs and track overflow counts
  const selectedEdges: typeof edges = [];
  const overflowByEdgeType = new Map<string, number>();

  for (const [etId, edgesOfType] of byEdgeType) {
    if (edgesOfType.length > CAP_PER_EDGE_TYPE) {
      selectedEdges.push(...edgesOfType.slice(0, CAP_PER_EDGE_TYPE));
      overflowByEdgeType.set(etId, edgesOfType.length - CAP_PER_EDGE_TYPE);
    } else {
      selectedEdges.push(...edgesOfType);
    }
  }

  // Resolve neighbor display names
  const neighborIds = selectedEdges.map((e) =>
    e.source_node_id === nodeId ? e.target_node_id : e.source_node_id,
  );
  const uniqueNeighborIds = [...new Set(neighborIds.map((id) => id as string))];
  const displayNames = await resolveDisplayNames({ nodeIds: uniqueNeighborIds, teamId: teamId as string });

  // Fetch edge properties
  const edgeIds = selectedEdges.map((e) => e.id);
  const edgeProps = edgeIds.length > 0
    ? await qb
        .selectFrom('property')
        .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
        .where('property.edge_id', 'in', edgeIds)
        .select([
          'property.edge_id',
          'property_type.name',
          'property.value_text',
          'property.value_number',
          'property.value_boolean',
        ])
        .execute()
    : [];

  const propsByEdge = new Map<string, Record<string, unknown>>();
  for (const p of edgeProps) {
    if (!p.edge_id) continue;
    const edgeId = p.edge_id as string;
    const propMap = propsByEdge.get(edgeId) ?? {};
    propMap[p.name] = p.value_text ?? p.value_number ?? p.value_boolean;
    propsByEdge.set(edgeId, propMap);
  }

  // Build entries
  const entries: RelationshipEntry[] = [];
  for (const edge of selectedEdges) {
    const etMeta = meta.get(edge.edge_type_id as string);
    if (!etMeta) continue;

    const entityIsSource = edge.source_node_id === nodeId;
    const neighborId = entityIsSource ? edge.target_node_id : edge.source_node_id;
    const neighborName = displayNames.get(neighborId as string) ?? '(unknown)';
    const edgeName = orientEdgeName(etMeta, entityIsSource);
    const props = propsByEdge.get(edge.id as string);

    entries.push({
      edgeName,
      targetName: neighborName,
      ...(props && Object.keys(props).length > 0 ? { edgeProperties: props } : {}),
    });
  }

  // Add overflow markers
  for (const [etId, count] of overflowByEdgeType) {
    const etMeta = meta.get(etId);
    if (!etMeta) continue;
    // Use outbound name as default for the overflow marker
    const edgeName = etMeta.outboundName.replace(/_/g, ' ');
    entries.push({
      edgeName,
      targetName: `(+${count} more)`,
    });
  }

  return entries;
}

// -- Build from extracted subgraph --

function buildRelationshipContextFromSubgraph(options: {
  tempId: string;
  subgraph: ExtractedSubgraph;
  resolved: Map<string, ResolutionDecision>;
  edgeTypeMeta: EdgeTypeMetaMap;
  resolvedDisplayNames?: Map<string, string | null>;
}): { entries: RelationshipEntry[]; dbNodeIdsToResolve: string[] } {
  const { tempId, subgraph, resolved, edgeTypeMeta, resolvedDisplayNames } = options;

  // Find edges involving this node
  const relatedEdges = subgraph.edges.filter(
    (e) => e.sourceTempId === tempId || e.targetTempId === tempId,
  );

  if (!relatedEdges.length) return { entries: [], dbNodeIdsToResolve: [] };

  // Group by edge type and cap
  const byEdgeType = new Map<string, typeof relatedEdges>();
  for (const edge of relatedEdges) {
    const key = edge.edgeType as string;
    const arr = byEdgeType.get(key) ?? [];
    arr.push(edge);
    byEdgeType.set(key, arr);
  }

  const selectedEdges: typeof relatedEdges = [];
  const overflowByEdgeType = new Map<string, number>();

  for (const [etId, edgesOfType] of byEdgeType) {
    if (edgesOfType.length > CAP_PER_EDGE_TYPE) {
      selectedEdges.push(...edgesOfType.slice(0, CAP_PER_EDGE_TYPE));
      overflowByEdgeType.set(etId, edgesOfType.length - CAP_PER_EDGE_TYPE);
    } else {
      selectedEdges.push(...edgesOfType);
    }
  }

  // Determine neighbor names — either from resolved DB node or from subgraph identity props
  const dbNodeIdsToResolve: string[] = [];
  const entries: RelationshipEntry[] = [];

  for (const edge of selectedEdges) {
    const entityIsSource = edge.sourceTempId === tempId;
    const neighborTempId = entityIsSource ? edge.targetTempId : edge.sourceTempId;
    const etMeta = edgeTypeMeta.get(edge.edgeType as string);
    if (!etMeta) continue;

    const neighborResolution = resolved.get(neighborTempId);
    let neighborName: string | null = null;

    if (neighborResolution?.action === 'match') {
      // Neighbor matched a DB node — use pre-resolved display name if available
      const dbId = neighborResolution.existingNodeId as string;
      neighborName = resolvedDisplayNames?.get(dbId) ?? null;
      if (!neighborName) dbNodeIdsToResolve.push(dbId);
    }

    if (!neighborName) {
      // Fall back to identity properties from the subgraph
      neighborName = getSubgraphNodeName(neighborTempId, subgraph);
    }

    const edgeName = orientEdgeName(etMeta, entityIsSource);

    // Gather edge properties from subgraph
    const edgeKey = `${edge.sourceTempId}:${edge.targetTempId}:${edge.edgeType}`;
    const edgeProps = getSubgraphEdgeProperties(edgeKey, subgraph.properties);

    entries.push({
      edgeName,
      targetName: neighborName ?? '(unknown)',
      ...(edgeProps ? { edgeProperties: edgeProps } : {}),
    });
  }

  // Add overflow markers
  for (const [etId, count] of overflowByEdgeType) {
    const etMeta = edgeTypeMeta.get(etId);
    if (!etMeta) continue;
    const edgeName = etMeta.outboundName.replace(/_/g, ' ');
    entries.push({
      edgeName,
      targetName: `(+${count} more)`,
    });
  }

  return { entries, dbNodeIdsToResolve };
}

function getSubgraphNodeName(tempId: string, subgraph: ExtractedSubgraph): string | null {
  // Use the first property value as a name — mirrors the identity-property fallback
  const props = subgraph.properties.filter(
    (p) => p.parentTempId === tempId && p.value != null && !p.ownerEdgeKey,
  );
  if (!props.length) return null;
  // Return the first text-like value
  for (const p of props) {
    if (typeof p.value === 'string' && p.value.length > 0) return p.value;
  }
  return props[0].value != null ? String(props[0].value) : null;
}

function getSubgraphEdgeProperties(
  edgeKey: string,
  properties: ExtractedProperty[],
): Record<string, unknown> | null {
  const edgeProps = properties.filter((p) => p.ownerEdgeKey === edgeKey && p.value != null);
  if (!edgeProps.length) return null;
  const result: Record<string, unknown> = {};
  for (const p of edgeProps) {
    result[p.propertyTypeId as string] = p.value;
  }
  return result;
}

// -- Format to plain text --

function formatEntityContext(context: EntityContext): string {
  const lines: string[] = [];

  // Properties
  for (const [key, value] of Object.entries(context.properties)) {
    if (value != null) {
      lines.push(`${key}: ${value}`);
    }
  }

  // Separator
  if (lines.length > 0 && context.relationships.length > 0) {
    lines.push('');
  }

  // Relationships
  for (const rel of context.relationships) {
    let line = `${titleCase(rel.edgeName)} → ${rel.targetName}`;
    if (rel.edgeProperties && Object.keys(rel.edgeProperties).length > 0) {
      const propsStr = Object.entries(rel.edgeProperties)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      line += ` (${propsStr})`;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

function titleCase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

export {
  loadEdgeTypeMeta,
  loadNodeTypeNames,
  buildRelationshipContextFromDb,
  buildRelationshipContextFromSubgraph,
  formatEntityContext,
};
export type { EdgeTypeMeta, EdgeTypeMetaMap, RelationshipEntry, EntityContext };
