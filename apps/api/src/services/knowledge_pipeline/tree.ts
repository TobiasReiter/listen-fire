import type { ExtractionGraphId } from '../../generated/kysely/knowledge/ExtractionGraph';
import type { ExtractionGraphNodeId } from '../../generated/kysely/knowledge/ExtractionGraphNode';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { EdgeTypeId } from '../../generated/kysely/knowledge/EdgeType';
import type { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import type PropertyValueType from '../../generated/kysely/knowledge/PropertyValueType';
import type PropertyIdentity from '../../generated/kysely/knowledge/PropertyIdentity';
import type EvaluationStrategy from '../../generated/kysely/knowledge/EvaluationStrategy';
import type NodeTypeCategory from '../../generated/kysely/knowledge/NodeTypeCategory';
import type { EdgeFilter, PluginHookRef } from '../../lib/knowledge/templates/types';
import type { InputPropertyMapping } from '../../adapters/pipeline/inbound/metadata';
import type {
  ExtractionTree,
  ExtractionTreeNode,
  ExtractionTreeNodeType,
  ExtractionTreeEdgeType,
  ExtractionTreePropertyDef,
} from './types';

import { parsePropertyMappings } from './input_mappings';
import { getKnowledgeQb } from '../../lib/kysely';

interface NodeTypeRow {
  id: NodeTypeId;
  name: string;
  description: string;
  category: NodeTypeCategory;
}

interface EdgeTypeRow {
  id: EdgeTypeId;
  outbound_name: string;
  inbound_name: string;
  description: string;
  source_node_type_id: NodeTypeId;
  target_node_type_id: NodeTypeId;
  required: boolean;
  scopes: boolean;
  filters: unknown;
}

interface PropertyOverride {
  property_type_id: string;
  instructions?: string;
}

interface GraphEdgeRow {
  source_node_id: ExtractionGraphNodeId;
  edge_type_id: EdgeTypeId;
  target_node_id: ExtractionGraphNodeId;
}

interface ExtractionNodeRow {
  id: ExtractionGraphNodeId;
  node_type_id: NodeTypeId;
  property_overrides: unknown;
  instructions: string | null;
  expand: boolean;
  filters: unknown;
}

interface PropertyTypeRow {
  id: PropertyTypeId;
  node_type_id: NodeTypeId | null;
  edge_type_id: EdgeTypeId | null;
  name: string;
  description: string;
  value_type: PropertyValueType;
  identity: PropertyIdentity;
  evaluation_strategy: EvaluationStrategy;
  enum_values: string[] | null;
}

function toTreeNodeType(row: NodeTypeRow): ExtractionTreeNodeType {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
  };
}

function parseFilters(raw: unknown): EdgeFilter[] {
  if (!raw) return [];
  if (typeof raw === 'string') return JSON.parse(raw);
  if (Array.isArray(raw)) return raw as EdgeFilter[];
  return [];
}


function toTreeEdgeType(row: EdgeTypeRow, nodeFilters: unknown, edgePropertyDefs: ExtractionTreePropertyDef[]): ExtractionTreeEdgeType {
  const graphFilters = parseFilters(nodeFilters);
  const filters = graphFilters.length > 0 ? graphFilters : parseFilters(row.filters);
  return {
    id: row.id,
    sourceNodeTypeId: row.source_node_type_id,
    targetNodeTypeId: row.target_node_type_id,
    outboundName: row.outbound_name,
    inboundName: row.inbound_name,
    description: row.description,
    required: row.required,
    scopes: row.scopes,
    filters,
    propertyDefs: edgePropertyDefs,
  };
}

async function buildExtractionTree(extractionGraphId: ExtractionGraphId): Promise<ExtractionTree> {
  const qb = getKnowledgeQb(['extraction_graph', 'extraction_graph_node', 'extraction_graph_edge', 'node_type', 'edge_type', 'property_type']);

  const graph = await qb
    .selectFrom('extraction_graph')
    .where('extraction_graph.id', '=', extractionGraphId)
    .select(['extraction_graph.id', 'extraction_graph.root_node_id', 'extraction_graph.team_id'])
    .executeTakeFirstOrThrow();

  // Fetch all extraction nodes for this graph (config fields now live here)
  const extractionNodes = await qb
    .selectFrom('extraction_graph_node')
    .where('extraction_graph_node.extraction_graph_id', '=', extractionGraphId)
    .select([
      'extraction_graph_node.id',
      'extraction_graph_node.node_type_id',
      'extraction_graph_node.property_overrides',
      'extraction_graph_node.instructions',
      'extraction_graph_node.expand',
      'extraction_graph_node.filters',
      'extraction_graph_node.default_property_mappings',
    ])
    .execute();

  const graphEdges = await qb
    .selectFrom('extraction_graph_edge')
    .where('extraction_graph_edge.extraction_graph_id', '=', extractionGraphId)
    .select([
      'extraction_graph_edge.source_node_id',
      'extraction_graph_edge.edge_type_id',
      'extraction_graph_edge.target_node_id',
    ])
    .execute();

  // Collect all node type IDs and edge type IDs
  const nodeTypeIds = new Set<string>();
  const edgeTypeIds = new Set<string>();

  for (const en of extractionNodes) {
    nodeTypeIds.add(en.node_type_id);
  }
  for (const ge of graphEdges) {
    edgeTypeIds.add(ge.edge_type_id);
  }

  const allEdgeTypes = edgeTypeIds.size > 0
    ? await qb
        .selectFrom('edge_type')
        .where('edge_type.id', 'in', [...edgeTypeIds] as EdgeTypeId[])
        .select([
          'edge_type.id',
          'edge_type.outbound_name',
          'edge_type.inbound_name',
          'edge_type.description',
          'edge_type.source_node_type_id',
          'edge_type.target_node_type_id',
          'edge_type.required',
          'edge_type.scopes',
          'edge_type.filters',
        ])
        .execute()
    : [];

  const nodeTypes = await qb
    .selectFrom('node_type')
    .where('node_type.id', 'in', [...nodeTypeIds] as NodeTypeId[])
    .where('node_type.team_id', '=', graph.team_id)
    .select([
      'node_type.id',
      'node_type.name',
      'node_type.description',
      'node_type.category',
    ])
    .execute();

  const nodePropertyTypes = await qb
    .selectFrom('property_type')
    .where('property_type.node_type_id', 'in', [...nodeTypeIds] as NodeTypeId[])
    .select([
      'property_type.id',
      'property_type.node_type_id',
      'property_type.edge_type_id',
      'property_type.name',
      'property_type.description',
      'property_type.value_type',
      'property_type.identity',
      'property_type.evaluation_strategy',
      'property_type.enum_values',
    ])
    .execute();

  const edgePropertyTypes = edgeTypeIds.size > 0
    ? await qb
        .selectFrom('property_type')
        .where('property_type.edge_type_id', 'in', [...edgeTypeIds] as EdgeTypeId[])
        .select([
          'property_type.id',
          'property_type.node_type_id',
          'property_type.edge_type_id',
          'property_type.name',
          'property_type.description',
          'property_type.value_type',
          'property_type.identity',
          'property_type.evaluation_strategy',
          'property_type.enum_values',
        ])
        .execute()
    : [];

  const nodeTypeMap = new Map(nodeTypes.map((nt) => [nt.id as string, nt]));
  const edgeTypeMap = new Map(allEdgeTypes.map((et) => [et.id as string, et]));
  const extractionNodeMap = new Map(extractionNodes.map((en) => [en.id as string, en]));

  function parsePropertyOverrides(raw: unknown): PropertyOverride[] | null {
    if (raw == null) return null;
    if (typeof raw === 'string') try { return JSON.parse(raw); } catch { return null; }
    if (Array.isArray(raw)) return raw as PropertyOverride[];
    return null;
  }

  function getPropertyDefs(nodeTypeId: NodeTypeId, overrides: unknown): ExtractionTreePropertyDef[] {
    const allProps = nodePropertyTypes.filter((pt) => pt.node_type_id === nodeTypeId);
    const parsed = parsePropertyOverrides(overrides);

    if (!parsed) {
      return allProps.map((pt) => ({
        propertyTypeId: pt.id,
        name: pt.name,
        description: pt.description,
        valueType: pt.value_type,
        identity: pt.identity,
        evaluationStrategy: pt.evaluation_strategy,
        enumValues: pt.enum_values,
      }));
    }

    const overrideMap = new Map(parsed.map((o) => [o.property_type_id, o]));
    return allProps
      .filter((pt) => overrideMap.has(pt.id as string))
      .map((pt) => ({
        propertyTypeId: pt.id,
        name: pt.name,
        description: pt.description,
        valueType: pt.value_type,
        identity: pt.identity,
        evaluationStrategy: pt.evaluation_strategy,
        enumValues: pt.enum_values,
        extractionInstructions: overrideMap.get(pt.id as string)?.instructions ?? null,
      }));
  }

  function getEdgePropertyDefs(edgeTypeId: EdgeTypeId): ExtractionTreePropertyDef[] {
    return edgePropertyTypes
      .filter((pt) => pt.edge_type_id === edgeTypeId)
      .map((pt) => ({
        propertyTypeId: pt.id,
        name: pt.name,
        description: pt.description,
        valueType: pt.value_type,
        identity: pt.identity,
        evaluationStrategy: pt.evaluation_strategy,
        enumValues: pt.enum_values,
      }));
  }

  // BFS from extraction nodes — group edges by source_node_id
  function buildChildren(
    sourceExtractionNodeId: ExtractionGraphNodeId,
    visited: Set<string>,
  ): ExtractionTreeNode[] {
    const children: ExtractionTreeNode[] = [];

    for (const ge of graphEdges) {
      if (ge.source_node_id !== sourceExtractionNodeId) continue;

      const targetExtractionNode = extractionNodeMap.get(ge.target_node_id as string);
      if (!targetExtractionNode) continue;

      const childNt = nodeTypeMap.get(targetExtractionNode.node_type_id as string);
      const et = edgeTypeMap.get(ge.edge_type_id as string);
      if (!childNt || !et) continue;

      const edgePropDefs = getEdgePropertyDefs(ge.edge_type_id as EdgeTypeId);

      // Cycle guard keyed on extraction node ID (each node is unique per edge)
      if (visited.has(ge.target_node_id as string)) continue;
      const next = new Set(visited);
      next.add(ge.target_node_id as string);

      // Config fields come from the target extraction node
      children.push({
        nodeType: toTreeNodeType(childNt),
        edgeType: toTreeEdgeType(et, targetExtractionNode.filters, edgePropDefs),
        instructions: targetExtractionNode.instructions,
        expand: targetExtractionNode.expand,
        propertyDefs: getPropertyDefs(targetExtractionNode.node_type_id, targetExtractionNode.property_overrides),
        defaultPropertyMappings: parsePropertyMappings(targetExtractionNode.default_property_mappings),
        children: buildChildren(ge.target_node_id, next),
      });
    }

    return children;
  }

  const rootExtractionNode = extractionNodeMap.get(graph.root_node_id as string);
  if (!rootExtractionNode) {
    throw new Error(`Root extraction node ${graph.root_node_id} not found`);
  }

  const messageNt = nodeTypeMap.get(rootExtractionNode.node_type_id as string);
  if (!messageNt) {
    throw new Error(`Message node type ${rootExtractionNode.node_type_id} not found`);
  }

  // Build unfiltered property defs per node type for input mapping resolution
  const allPropertyDefsByNodeType = new Map<string, ExtractionTreePropertyDef[]>();
  for (const ntId of nodeTypeIds) {
    allPropertyDefsByNodeType.set(ntId, getPropertyDefs(ntId as NodeTypeId, null));
  }

  return {
    extractionGraphId,
    messageType: toTreeNodeType(messageNt),
    messagePropertyDefs: getPropertyDefs(rootExtractionNode.node_type_id, rootExtractionNode.property_overrides),
    messageDefaultPropertyMappings: parsePropertyMappings(rootExtractionNode.default_property_mappings),
    children: buildChildren(graph.root_node_id, new Set([graph.root_node_id as string])),
    allPropertyDefsByNodeType,
  };
}

export { buildExtractionTree };
