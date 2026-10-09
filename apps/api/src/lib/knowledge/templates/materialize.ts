import { getTemplate } from './index';

import { Kysely } from 'kysely';

import type { Expression } from '#shared/expression/types';

import KnowledgeSchema from '../../../generated/kysely/knowledge/KnowledgeSchema';
import { NodeTypeId } from '../../../generated/kysely/knowledge/NodeType';
import { EdgeTypeId } from '../../../generated/kysely/knowledge/EdgeType';
import { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';
import { ExtractionGraphId } from '../../../generated/kysely/knowledge/ExtractionGraph';
import { ExtractionGraphNodeId } from '../../../generated/kysely/knowledge/ExtractionGraphNode';
import { TeamId } from '../../../generated/kysely/core/Team';
import PropertyValueType from '../../../generated/kysely/knowledge/PropertyValueType';
import PropertyIdentity from '../../../generated/kysely/knowledge/PropertyIdentity';
import EvaluationStrategy from '../../../generated/kysely/knowledge/EvaluationStrategy';
import NodeTypeCategory from '../../../generated/kysely/knowledge/NodeTypeCategory';
import { OntologyTemplate, ExtractionTreeNode, TemplateUniquenessConstraint } from './types';
import { getTemplateIcon } from './icons';


function resolveExpressionKeys(
  expr: Expression,
  propertyTypeIdMap: Map<string, PropertyTypeId>,
  edgeTypeIdMap: Map<string, EdgeTypeId>,
): Expression {
  if (expr.type === 'property') {
    const resolved = propertyTypeIdMap.get(expr.propertyTypeId);
    if (!resolved) throw new Error(`Uniqueness constraint references unknown property key: "${expr.propertyTypeId}"`);
    return { ...expr, propertyTypeId: resolved as string };
  }
  if (expr.type === 'traverse') {
    return {
      ...expr,
      steps: expr.steps.map((step) => {
        if (step.type === 'edge') {
          const resolved = edgeTypeIdMap.get(step.edgeTypeId);
          if (!resolved) throw new Error(`Uniqueness constraint references unknown edge key: "${step.edgeTypeId}"`);
          return { ...step, edgeTypeId: resolved as string };
        }
        return step;
      }),
      expression: resolveExpressionKeys(expr.expression, propertyTypeIdMap, edgeTypeIdMap),
    };
  }
  if (expr.type === 'function') {
    return { ...expr, args: expr.args.map((a) => resolveExpressionKeys(a, propertyTypeIdMap, edgeTypeIdMap)) };
  }
  if (expr.type === 'arithmetic') {
    return {
      ...expr,
      left: resolveExpressionKeys(expr.left, propertyTypeIdMap, edgeTypeIdMap),
      right: resolveExpressionKeys(expr.right, propertyTypeIdMap, edgeTypeIdMap),
    };
  }
  if (expr.type === 'concat') {
    return { ...expr, parts: expr.parts.map((p) => resolveExpressionKeys(p, propertyTypeIdMap, edgeTypeIdMap)) };
  }
  return expr;
}

function resolveConstraintKeys(
  constraints: TemplateUniquenessConstraint[],
  propertyTypeIdMap: Map<string, PropertyTypeId>,
  edgeTypeIdMap: Map<string, EdgeTypeId>,
): TemplateUniquenessConstraint[] {
  return constraints.map((constraint) =>
    constraint.map((entry) => ({
      ...entry,
      expr: resolveExpressionKeys(entry.expr, propertyTypeIdMap, edgeTypeIdMap),
    })),
  );
}

type MaterializeDb = Pick<
  KnowledgeSchema,
  'node_type' | 'property_type' | 'edge_type' | 'extraction_graph' | 'extraction_graph_node' | 'extraction_graph_edge'
>;

type MaterializeResult = {
  nodeTypesCreated: number;
  propertyTypesCreated: number;
  edgeTypesCreated: number;
  extractionGraphsCreated: number;
  extractionGraphEdgesCreated: number;
};

async function materializeTemplate(
  trx: Kysely<MaterializeDb>,
  teamId: TeamId,
  templateKey: string,
): Promise<MaterializeResult> {
  const template = getTemplate(templateKey);
  if (!template) {
    throw new Error(`Unknown template: ${templateKey}`);
  }

  return materialize(trx, teamId, template);
}

async function materialize(
  trx: Kysely<MaterializeDb>,
  teamId: TeamId,
  template: OntologyTemplate,
): Promise<MaterializeResult> {
  // 1. Insert all node types, build key → id map
  const nodeTypeIdMap = new Map<string, NodeTypeId>();
  const categoryMap: Record<string, NodeTypeCategory> = {
    message: NodeTypeCategory.message,
    object: NodeTypeCategory.object,
  };

  for (let i = 0; i < template.nodeTypes.length; i++) {
    const nt = template.nodeTypes[i];
    const row = await trx
      .insertInto('node_type')
      .values({
        team_id: teamId,
        name: nt.name,
        description: nt.description,
        category: categoryMap[nt.category],
        icon_svg: nt.iconSvg ?? getTemplateIcon(nt.key) ?? null,
        display_name_template: nt.displayNameTemplate ?? null,
        sort_order: i,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    nodeTypeIdMap.set(nt.key, row.id);
  }

  // 2. Insert property types per node type from inline definitions
  const propertyTypeIdMap = new Map<string, PropertyTypeId>();
  let propertyTypesCreated = 0;

  for (const nt of template.nodeTypes) {
    const nodeTypeId = nodeTypeIdMap.get(nt.key)!;

    for (let pi = 0; pi < nt.properties.length; pi++) {
      const p = nt.properties[pi];
      const row = await trx
        .insertInto('property_type')
        .values({
          team_id: teamId,
          node_type_id: nodeTypeId,
          name: p.name,
          description: p.description,
          value_type: p.valueType,
          identity: PropertyIdentity.none,
          evaluation_strategy: p.evaluationStrategy,
          cardinality: p.cardinality,
          enum_values: p.enumValues ?? null,
          sort_order: pi,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      propertyTypeIdMap.set(p.key, row.id);
      propertyTypesCreated++;
    }
  }

  // 3. Auto-create Role property type for node types referenced by edges with Role filters
  // Collect distinct Role values per node type from filters
  const roleValuesByNodeType = new Map<string, Set<string>>();
  for (const et of template.edgeTypes) {
    for (const f of et.filters ?? []) {
      if (f.property === 'Role') {
        const ntKey = f.side === 'source' ? et.source : et.target;
        const vals = roleValuesByNodeType.get(ntKey) ?? new Set();
        vals.add(f.value);
        roleValuesByNodeType.set(ntKey, vals);
      }
    }
  }

  for (const ntKey of roleValuesByNodeType.keys()) {
    const roleKey = `${ntKey}__role`;
    if (propertyTypeIdMap.has(roleKey)) continue;

    const nodeTypeId = nodeTypeIdMap.get(ntKey);
    if (!nodeTypeId) continue;

    const roleEnumValues = [...(roleValuesByNodeType.get(ntKey) ?? [])];
    // Find how many explicit properties this node type already has, so Role sorts after them
    const existingPropCount = template.nodeTypes.find((n) => n.key === ntKey)?.properties.length ?? 0;
    const row = await trx
      .insertInto('property_type')
      .values({
        team_id: teamId,
        node_type_id: nodeTypeId,
        name: 'Role',
        description: `The role this ${ntKey} plays in the current context`,
        value_type: PropertyValueType.text,
        identity: PropertyIdentity.none,
        evaluation_strategy: EvaluationStrategy.latest,
        enum_values: roleEnumValues.length > 0 ? roleEnumValues : null,
        sort_order: existingPropCount,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    propertyTypeIdMap.set(roleKey, row.id);
    propertyTypesCreated++;
  }

  // 4. Insert all edge types with filters JSON
  const edgeTypeIdMap = new Map<string, EdgeTypeId>();

  for (let ei = 0; ei < template.edgeTypes.length; ei++) {
    const et = template.edgeTypes[ei];
    const sourceId = nodeTypeIdMap.get(et.source);
    const targetId = nodeTypeIdMap.get(et.target);
    if (!sourceId || !targetId) {
      throw new Error(
        `Edge type "${et.key}" references unknown node types: source="${et.source}", target="${et.target}"`,
      );
    }

    const row = await trx
      .insertInto('edge_type')
      .values({
        team_id: teamId,
        outbound_name: et.outboundName,
        inbound_name: et.inboundName,
        description: et.description,
        source_node_type_id: sourceId,
        target_node_type_id: targetId,
        required: et.required,
        scopes: false,
        filters: JSON.stringify(et.filters ?? []),
        edge_group: et.group ?? null,
        sort_order: ei,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    edgeTypeIdMap.set(et.key, row.id);
  }

  // 4b. Insert property types for edge types
  for (const et of template.edgeTypes) {
    if (!et.properties?.length) continue;
    const edgeTypeId = edgeTypeIdMap.get(et.key)!;

    for (let pi = 0; pi < et.properties.length; pi++) {
      const p = et.properties[pi];
      const row = await trx
        .insertInto('property_type')
        .values({
          team_id: teamId,
          edge_type_id: edgeTypeId,
          name: p.name,
          description: p.description,
          value_type: p.valueType,
          identity: PropertyIdentity.none,
          evaluation_strategy: p.evaluationStrategy,
          cardinality: p.cardinality,
          enum_values: p.enumValues ?? null,
          sort_order: pi,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      propertyTypeIdMap.set(`${et.key}.${p.key}`, row.id);
      propertyTypesCreated++;
    }
  }

  // 4c. Resolve uniqueness constraints: replace template keys with real UUIDs and write to node_type
  for (const nt of template.nodeTypes) {
    if (!nt.unique?.length) continue;
    const nodeTypeId = nodeTypeIdMap.get(nt.key)!;
    const resolved = resolveConstraintKeys(nt.unique, propertyTypeIdMap, edgeTypeIdMap);
    await trx
      .updateTable('node_type')
      .set({ uniqueness_constraints: JSON.stringify(resolved) })
      .where('id', '=', nodeTypeId)
      .execute();
  }

  // 4d. Resolve display name expressions: replace template keys with real UUIDs and write to node_type
  for (const nt of template.nodeTypes) {
    if (!nt.displayNameExpression) continue;
    const nodeTypeId = nodeTypeIdMap.get(nt.key)!;
    const resolved = resolveExpressionKeys(nt.displayNameExpression, propertyTypeIdMap, edgeTypeIdMap);
    await trx
      .updateTable('node_type')
      .set({ display_name_expression: JSON.stringify(resolved) })
      .where('id', '=', nodeTypeId)
      .execute();
  }

  // Build edge type key → template definition lookup
  const edgeTypeByKey = new Map(template.edgeTypes.map((et) => [et.key, et]));

  // 5. Insert extraction graphs by recursively walking the template tree
  let extractionGraphEdgesCreated = 0;

  for (const eg of template.extractionGraphs) {
    const messageNodeTypeId = nodeTypeIdMap.get(eg.messageNodeType);
    if (!messageNodeTypeId) {
      throw new Error(
        `Extraction graph "${eg.key}" references unknown message node type: "${eg.messageNodeType}"`,
      );
    }

    // Create graph row with temporary root_node_id (deferred FK)
    const graphRow = await trx
      .insertInto('extraction_graph')
      .values({
        team_id: teamId,
        name: eg.name,
        description: eg.description,
        root_node_id: '00000000-0000-0000-0000-000000000000' as ExtractionGraphNodeId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const graphId = graphRow.id as ExtractionGraphId;

    // Create root extraction node for the message node type
    const rootNode = await trx
      .insertInto('extraction_graph_node')
      .values({
        team_id: teamId,
        extraction_graph_id: graphId,
        node_type_id: messageNodeTypeId,
        sort_order: 0,
        content_plugins: eg.contentPlugins?.length ? JSON.stringify(eg.contentPlugins) : null,
        entity_plugins: eg.entityPlugins?.length ? JSON.stringify(eg.entityPlugins) : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('extraction_graph')
      .set({ root_node_id: rootNode.id })
      .where('id', '=', graphId)
      .execute();

    let sortOrder = 1;

    // Recursively materialize tree children
    async function materializeChildren(
      parentExtractionNodeId: ExtractionGraphNodeId,
      children: ExtractionTreeNode[],
    ) {
      for (const child of children) {
        const edgeTypeId = edgeTypeIdMap.get(child.edge);
        if (!edgeTypeId) {
          throw new Error(
            `Extraction graph "${eg.key}" references unknown edge type: "${child.edge}"`,
          );
        }

        const childNodeTypeId = nodeTypeIdMap.get(child.nodeType);
        if (!childNodeTypeId) {
          throw new Error(
            `Extraction graph "${eg.key}" references unknown node type: "${child.nodeType}"`,
          );
        }

        const childExtNode = await trx
          .insertInto('extraction_graph_node')
          .values({
            team_id: teamId,
            extraction_graph_id: graphId,
            node_type_id: childNodeTypeId,
            sort_order: sortOrder++,
            instructions: child.instructions ?? null,
            expand: false,
            gather: child.gather ?? false,
            filters: JSON.stringify(child.filters ?? []),
            content_plugins: child.contentPlugins?.length ? JSON.stringify(child.contentPlugins) : null,
            entity_plugins: child.entityPlugins?.length ? JSON.stringify(child.entityPlugins) : null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await trx
          .insertInto('extraction_graph_edge')
          .values({
            team_id: teamId,
            extraction_graph_id: graphId,
            source_node_id: parentExtractionNodeId,
            edge_type_id: edgeTypeId,
            target_node_id: childExtNode.id,
          })
          .execute();

        extractionGraphEdgesCreated++;

        if (child.children?.length) {
          await materializeChildren(childExtNode.id, child.children);
        }
      }
    }

    await materializeChildren(rootNode.id, eg.children);
  }

  return {
    nodeTypesCreated: template.nodeTypes.length,
    propertyTypesCreated,
    edgeTypesCreated: template.edgeTypes.length,
    extractionGraphsCreated: template.extractionGraphs.length,
    extractionGraphEdgesCreated,
  };
}

export { materializeTemplate };
export type { MaterializeResult };
