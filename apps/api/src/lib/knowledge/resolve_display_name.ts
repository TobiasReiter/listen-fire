import type { Expression } from '#shared/expression/types';

import { getKnowledgeQb } from '../kysely';
import { NodeId } from '../../generated/kysely/knowledge/Node';
import { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import { TeamId } from '../../generated/kysely/core/Team';
import PropertyIdentity from '../../generated/kysely/knowledge/PropertyIdentity';
import PropertyValueType from '../../generated/kysely/knowledge/PropertyValueType';
import { evaluateDisplayNameExpression } from './evaluate_display_name_expression';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function parseTokens(template: string): string[] {
  const tokens: string[] = [];
  const regex = /\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(template)) !== null) {
    tokens.push(match[1]);
  }
  return tokens;
}

function formatDate(date: Date): string {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function cleanupTemplate(result: string): string {
  result = result.replace(/^\s*'s\s+/g, '');
  result = result.replace(/'s\s*$/g, '');
  result = result.replace(/\s*—\s*$/g, '');
  result = result.replace(/^\s*—\s*/g, '');
  result = result.replace(/:\s*$/g, '');
  result = result.replace(/\s{2,}/g, ' ');
  return result.trim();
}

interface NodeTypeGroup {
  nodeIds: string[];
  expression: Expression | null;
  template: string | null;
}

/**
 * Resolve display names for a batch of nodes.
 *
 * Resolution order per node type:
 *   1. display_name_expression (Expression AST evaluated per node)
 *   2. display_name_template (legacy {token} interpolation)
 *   3. First unique/fuzzy identity property value
 */
async function resolveDisplayNames(options: {
  nodeIds: string[];
  teamId: string;
}): Promise<Map<string, string | null>> {
  const { nodeIds, teamId } = options;
  const result = new Map<string, string | null>();

  if (nodeIds.length === 0) return result;

  // 1. Fetch node type info for all nodes
  const nodeInfos = await getKnowledgeQb(['node', 'node_type'])
    .selectFrom('node')
    .innerJoin('node_type', 'node_type.id', 'node.node_type_id')
    .where('node.id', 'in', nodeIds as NodeId[])
    .select([
      'node.id',
      'node.node_type_id',
      'node_type.display_name_expression',
      'node_type.display_name_template',
    ])
    .execute();

  // Group by node type
  const byNodeType = new Map<string, NodeTypeGroup>();
  for (const info of nodeInfos) {
    const existing = byNodeType.get(info.node_type_id);
    if (existing) {
      existing.nodeIds.push(info.id);
    } else {
      byNodeType.set(info.node_type_id, {
        nodeIds: [info.id],
        expression: info.display_name_expression as Expression | null,
        template: info.display_name_template,
      });
    }
  }

  // 2. Resolve nodes with expressions
  for (const group of byNodeType.values()) {
    if (!group.expression) continue;
    for (const nid of group.nodeIds) {
      try {
        const val = await evaluateDisplayNameExpression(group.expression, { nodeId: nid });
        result.set(nid, val != null ? String(val) : null);
      } catch {
        result.set(nid, null);
      }
    }
  }

  // 3. Resolve nodes with templates (no expression)
  for (const [nodeTypeId, group] of byNodeType) {
    if (group.expression) continue;
    if (!group.template) continue;

    const tokens = parseTokens(group.template);
    if (tokens.length === 0) {
      for (const nid of group.nodeIds) {
        result.set(nid, group.template);
      }
      continue;
    }

    // Classify tokens: property vs edge
    const propertyTypes = await getKnowledgeQb(['property_type'])
      .selectFrom('property_type')
      .where('property_type.node_type_id', '=', nodeTypeId as NodeTypeId)
      .where('property_type.name', 'in', tokens)
      .select(['property_type.id', 'property_type.name', 'property_type.value_type'])
      .execute();

    const propTokenMap = new Map(propertyTypes.map((pt) => [pt.name, pt]));
    const edgeTokenNames = tokens.filter((t) => !propTokenMap.has(t));

    const edgeTypes = edgeTokenNames.length > 0
      ? await getKnowledgeQb(['edge_type'])
          .selectFrom('edge_type')
          .where('edge_type.source_node_type_id', '=', nodeTypeId as NodeTypeId)
          .where('edge_type.team_id', '=', teamId as TeamId)
          .where('edge_type.outbound_name', 'in', edgeTokenNames)
          .select(['edge_type.id', 'edge_type.outbound_name'])
          .execute()
      : [];

    const edgeTokenMap = new Map(edgeTypes.map((et) => [et.outbound_name, et]));

    // Batch-fetch property values
    const propTypeIds = propertyTypes.map((pt) => pt.id);
    const propValues = propTypeIds.length > 0
      ? await getKnowledgeQb(['property'])
          .selectFrom('property')
          .where('property.node_id', 'in', group.nodeIds as NodeId[])
          .where('property.property_type_id', 'in', propTypeIds)
          .select([
            'property.node_id',
            'property.property_type_id',
            'property.value_text',
            'property.value_number',
            'property.value_date',
            'property.value_boolean',
          ])
          .execute()
      : [];

    // nodeId → { propTypeName → displayValue }
    const propByNode = new Map<string, Map<string, string>>();
    for (const pv of propValues) {
      if (!pv.node_id) continue;
      let nodeMap = propByNode.get(pv.node_id);
      if (!nodeMap) {
        nodeMap = new Map();
        propByNode.set(pv.node_id, nodeMap);
      }
      const pt = propertyTypes.find((p) => p.id === pv.property_type_id);
      if (!pt) continue;
      if (nodeMap.has(pt.name)) continue;

      let displayVal: string | null = null;
      if (pt.value_type === PropertyValueType.date && pv.value_date) {
        displayVal = formatDate(new Date(pv.value_date));
      } else if (pt.value_type === PropertyValueType.number && pv.value_number != null) {
        displayVal = String(pv.value_number);
      } else if (pt.value_type === PropertyValueType.boolean && pv.value_boolean != null) {
        displayVal = pv.value_boolean ? 'Yes' : 'No';
      } else if (pv.value_text) {
        displayVal = pv.value_text;
      }

      if (displayVal) nodeMap.set(pt.name, displayVal);
    }

    // Batch-fetch edge targets
    const edgeTypeIds = edgeTypes.map((et) => et.id);
    const edges = edgeTypeIds.length > 0
      ? await getKnowledgeQb(['edge'])
          .selectFrom('edge')
          .where('edge.source_node_id', 'in', group.nodeIds as NodeId[])
          .where('edge.edge_type_id', 'in', edgeTypeIds)
          .orderBy('edge.created_at asc')
          .select(['edge.source_node_id', 'edge.target_node_id', 'edge.edge_type_id'])
          .execute()
      : [];

    // nodeId → { edgeTypeOutboundName → targetNodeId } (first edge wins)
    const edgeByNode = new Map<string, Map<string, string>>();
    for (const edge of edges) {
      let nodeMap = edgeByNode.get(edge.source_node_id);
      if (!nodeMap) {
        nodeMap = new Map();
        edgeByNode.set(edge.source_node_id, nodeMap);
      }
      const et = edgeTypes.find((e) => e.id === edge.edge_type_id);
      if (!et) continue;
      if (!nodeMap.has(et.outbound_name)) {
        nodeMap.set(et.outbound_name, edge.target_node_id);
      }
    }

    // Resolve target node display names (depth 1: identity property only)
    const allTargetIds = new Set<string>();
    for (const nodeMap of edgeByNode.values()) {
      for (const targetId of nodeMap.values()) {
        allTargetIds.add(targetId);
      }
    }

    const targetDisplayNames = new Map<string, string | null>();
    if (allTargetIds.size > 0) {
      const targetIds = [...allTargetIds];
      const targetProps = await getKnowledgeQb(['property', 'property_type'])
        .selectFrom('property')
        .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
        .where('property.node_id', 'in', targetIds as NodeId[])
        .where((eb) =>
          eb.or([
            eb('property_type.identity', '=', PropertyIdentity.unique),
            eb('property_type.identity', '=', PropertyIdentity.fuzzy),
          ]),
        )
        .select(['property.node_id', 'property.value_text'])
        .execute();

      const seen = new Set<string>();
      for (const tp of targetProps) {
        if (tp.node_id && tp.value_text && !seen.has(tp.node_id)) {
          targetDisplayNames.set(tp.node_id, tp.value_text);
          seen.add(tp.node_id);
        }
      }
    }

    // Interpolate template for each node
    for (const nid of group.nodeIds) {
      const values = new Map<string, string | null>();
      const nodePropMap = propByNode.get(nid);
      const nodeEdgeMap = edgeByNode.get(nid);

      for (const token of tokens) {
        const propVal = nodePropMap?.get(token);
        if (propVal) {
          values.set(token, propVal);
          continue;
        }
        const targetId = nodeEdgeMap?.get(token);
        if (targetId) {
          values.set(token, targetDisplayNames.get(targetId) ?? null);
          continue;
        }
        values.set(token, null);
      }

      let display = group.template!.replace(/\{([^}]+)\}/g, (_, token: string) => {
        return values.get(token) ?? '';
      });
      display = cleanupTemplate(display);
      result.set(nid, display || null);
    }
  }

  // 4. Fallback: identity property for nodes with neither expression nor template
  const fallbackNodeIds: string[] = [];
  for (const group of byNodeType.values()) {
    if (group.expression || group.template) continue;
    fallbackNodeIds.push(...group.nodeIds);
  }

  if (fallbackNodeIds.length > 0) {
    const identityProps = await getKnowledgeQb(['property', 'property_type'])
      .selectFrom('property')
      .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
      .where('property.node_id', 'in', fallbackNodeIds as NodeId[])
      .where((eb) =>
        eb.or([
          eb('property_type.identity', '=', PropertyIdentity.unique),
          eb('property_type.identity', '=', PropertyIdentity.fuzzy),
        ]),
      )
      .select(['property.node_id', 'property.value_text'])
      .execute();

    const seen = new Set<string>();
    for (const prop of identityProps) {
      if (prop.node_id && prop.value_text && !seen.has(prop.node_id)) {
        result.set(prop.node_id, prop.value_text);
        seen.add(prop.node_id);
      }
    }
    for (const nid of fallbackNodeIds) {
      if (!result.has(nid)) result.set(nid, null);
    }
  }

  return result;
}

export { resolveDisplayNames };
