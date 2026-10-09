// Merging, inside the write door.
//
// A merge is curation: a person decided two records are one. That makes every
// value it lands a `user_edit` write, gated like any other (D37b), evidenced
// and recorded in the change feed (D37f). What a merge must NOT do is copy
// values around — re-pointing a property row keeps its evidence history, which
// is the whole point of merging rather than re-typing.
//
// The model never runs in here (K-5): properties whose strategy wants LLM
// arbitration come back on the result for the caller to re-evaluate after the
// transaction commits.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { EdgeId } from '../../../generated/kysely/knowledge/Edge';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../../generated/kysely/knowledge/NodeType';
import type { PropertyId } from '../../../generated/kysely/knowledge/Property';
import type { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';
import type { MutationCollector } from './events';

import { ChangeKind, propertyToChangeValue, recordChange, recordChanges, type RecordChangeParams } from '../changes';
import { assertWritable, type PropertyTypeFacts } from './values';
import {
  setProperties,
  withCollector,
  type KnowledgeWriteDb,
  type WriteContext,
} from './write';
import PropertyCardinality from '../../../generated/kysely/knowledge/PropertyCardinality';
import EvaluationStrategy from '../../../generated/kysely/knowledge/EvaluationStrategy';

export interface PropertyToReEvaluate {
  propertyId: PropertyId;
  valueType: string | null;
  strategy: string | null;
}

interface MergePropertyRow {
  id: PropertyId;
  property_type_id: PropertyTypeId;
  value_text: string | null;
  value_text_array: string[] | null;
  value_number: string | null;
  value_date: Date | null;
  value_boolean: boolean | null;
  value_json: unknown;
  name: string;
  description: string;
  value_type: PropertyTypeFacts['value_type'];
  cardinality: PropertyTypeFacts['cardinality'];
  evaluation_strategy: PropertyTypeFacts['evaluation_strategy'];
  writable_by: PropertyTypeFacts['writable_by'];
}

/** Merge one node into another. The target survives; the source is deleted. */
export async function mergeNodes(
  db: KnowledgeWriteDb,
  input: { context: WriteContext; targetNodeId: NodeId; sourceNodeId: NodeId },
): Promise<{ mergedNodeId: NodeId; propertiesToReEvaluate: PropertyToReEvaluate[] }> {
  const { targetNodeId, sourceNodeId } = input;
  const context = { ...input.context, requestId: input.context.requestId ?? randomUUID() };

  const propertiesToReEvaluate = await withCollector(db, context, async (trx, collector) => {
    const [target, source] = await Promise.all([
      trx
        .selectFrom('node')
        .where('node.id', '=', targetNodeId)
        .where('node.team_id', '=', context.teamId)
        .select(['node.id', 'node.node_type_id'])
        .executeTakeFirst(),
      trx
        .selectFrom('node')
        .where('node.id', '=', sourceNodeId)
        .where('node.team_id', '=', context.teamId)
        .select(['node.id', 'node.node_type_id'])
        .executeTakeFirst(),
    ]);

    if (!target) throw new Error('Target node not found');
    if (!source) throw new Error('Source node not found');
    if (target.node_type_id !== source.node_type_id) {
      throw new Error('Cannot merge nodes of different types');
    }

    const propertyWork = await mergePropertiesIn(trx, {
      context,
      anchor: 'node_id',
      targetId: targetNodeId,
      sourceId: sourceNodeId,
      collector,
      nodeTypeId: target.node_type_id,
    });
    const edgeWork = await mergeEdgesOfNode(trx, {
      context,
      targetNodeId,
      sourceNodeId,
      collector,
    });

    // `node_resource` and `linked_object` both carry uniqueness constraints the
    // move would violate, so the source's colliding rows go first.
    await sql`
      DELETE FROM knowledge.node_resource
      WHERE node_id = ${sourceNodeId}
        AND resource_id IN (
          SELECT resource_id FROM knowledge.node_resource WHERE node_id = ${targetNodeId}
        )
    `.execute(trx);
    await trx
      .updateTable('node_resource')
      .set({ node_id: targetNodeId })
      .where('node_id', '=', sourceNodeId)
      .execute();

    await sql`
      DELETE FROM knowledge.linked_object
      WHERE node_id = ${sourceNodeId}
        AND (adapter_type, external_id) IN (
          SELECT adapter_type, external_id FROM knowledge.linked_object WHERE node_id = ${targetNodeId}
        )
    `.execute(trx);
    await trx
      .updateTable('linked_object')
      .set({ node_id: targetNodeId })
      .where('node_id', '=', sourceNodeId)
      .execute();

    await trx
      .updateTable('extraction_fact')
      .set({ message_node_id: targetNodeId })
      .where('message_node_id', '=', sourceNodeId)
      .execute();

    await trx.deleteFrom('node').where('node.id', '=', sourceNodeId).execute();
    collector.nodeDeleted(sourceNodeId, source.node_type_id);

    // No node_id — the cascade already took the row this describes.
    await recordChange(
      {
        teamId: context.teamId as unknown as string,
        requestId: context.requestId!,
        source: context.changeSource,
        kind: ChangeKind.node_removed,
        createdBy: context.createdBy ?? null,
      },
      trx,
    );

    return [...propertyWork, ...edgeWork];
  });

  return { mergedNodeId: targetNodeId, propertiesToReEvaluate };
}

/** Merge two parallel edges (same type, same endpoints) into one. */
export async function mergeEdges(
  db: KnowledgeWriteDb,
  input: { context: WriteContext; targetEdgeId: EdgeId; sourceEdgeId: EdgeId },
): Promise<{ mergedEdgeId: EdgeId; propertiesToReEvaluate: PropertyToReEvaluate[] }> {
  const context = { ...input.context, requestId: input.context.requestId ?? randomUUID() };
  const propertiesToReEvaluate = await withCollector(db, context, async (trx) => {
    const [targetEdge, sourceEdge] = await Promise.all([
      trx
        .selectFrom('edge')
        .where('edge.id', '=', input.targetEdgeId)
        .where('edge.team_id', '=', context.teamId)
        .select(['edge.id', 'edge.edge_type_id', 'edge.source_node_id', 'edge.target_node_id'])
        .executeTakeFirst(),
      trx
        .selectFrom('edge')
        .where('edge.id', '=', input.sourceEdgeId)
        .where('edge.team_id', '=', context.teamId)
        .select(['edge.id', 'edge.edge_type_id', 'edge.source_node_id', 'edge.target_node_id'])
        .executeTakeFirst(),
    ]);

    if (!targetEdge) throw new Error('Target edge not found');
    if (!sourceEdge) throw new Error('Source edge not found');
    if (targetEdge.edge_type_id !== sourceEdge.edge_type_id) {
      throw new Error('Cannot merge edges of different types');
    }
    if (
      targetEdge.source_node_id !== sourceEdge.source_node_id ||
      targetEdge.target_node_id !== sourceEdge.target_node_id
    ) {
      throw new Error('Cannot merge edges with different endpoints');
    }

    await trx
      .updateTable('evidence')
      .set({ edge_id: targetEdge.id })
      .where('evidence.edge_id', '=', sourceEdge.id)
      .execute();

    const work = await mergePropertiesIn(trx, {
      context,
      anchor: 'edge_id',
      targetId: targetEdge.id,
      sourceId: sourceEdge.id,
    });

    await trx.deleteFrom('edge').where('edge.id', '=', sourceEdge.id).execute();
    await recordChange(
      {
        teamId: context.teamId as unknown as string,
        requestId: context.requestId!,
        source: context.changeSource,
        kind: ChangeKind.edge_removed,
        createdBy: context.createdBy ?? null,
      },
      trx,
    );
    return work;
  });

  return { mergedEdgeId: input.targetEdgeId, propertiesToReEvaluate };
}

// ── Property merging ───────────────────────────────────────────────────────

async function readMergeProperties(
  trx: KnowledgeWriteDb,
  input: { teamId: WriteContext['teamId']; anchor: 'node_id' | 'edge_id'; id: NodeId | EdgeId },
): Promise<MergePropertyRow[]> {
  const rows = await trx
    .selectFrom('property')
    .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
    .where(input.anchor === 'node_id' ? 'property.node_id' : 'property.edge_id', '=', input.id as never)
    .where('property.team_id', '=', input.teamId)
    .select([
      'property.id',
      'property.property_type_id',
      'property.value_text',
      'property.value_text_array',
      'property.value_number',
      'property.value_date',
      'property.value_boolean',
      'property.value_json',
      'property_type.name',
      'property_type.description',
      'property_type.value_type',
      'property_type.cardinality',
      'property_type.evaluation_strategy',
      'property_type.writable_by',
    ])
    .execute();
  return rows as MergePropertyRow[];
}

function factsOf(row: MergePropertyRow): PropertyTypeFacts {
  return {
    id: row.property_type_id,
    name: row.name,
    description: row.description,
    value_type: row.value_type,
    cardinality: row.cardinality,
    evaluation_strategy: row.evaluation_strategy,
    writable_by: row.writable_by,
    edge_type_id: null,
  };
}

async function mergePropertiesIn(
  trx: KnowledgeWriteDb,
  input: {
    context: WriteContext;
    anchor: 'node_id' | 'edge_id';
    targetId: NodeId | EdgeId;
    sourceId: NodeId | EdgeId;
    /** Present for node merges: a re-pointed row is a value the target gained. */
    collector?: MutationCollector;
    nodeTypeId?: NodeTypeId;
  },
): Promise<PropertyToReEvaluate[]> {
  const { context, anchor, targetId, sourceId } = input;
  const [targetProps, sourceProps] = await Promise.all([
    readMergeProperties(trx, { teamId: context.teamId, anchor, id: targetId }),
    readMergeProperties(trx, { teamId: context.teamId, anchor, id: sourceId }),
  ]);

  const targetByType = new Map(targetProps.map((p) => [p.property_type_id as string, p]));
  const toReEvaluate: PropertyToReEvaluate[] = [];
  const changes: RecordChangeParams[] = [];
  const doorAnchor =
    anchor === 'node_id'
      ? ({ kind: 'node', nodeId: targetId as NodeId } as const)
      : ({ kind: 'edge', edgeId: targetId as EdgeId } as const);

  for (const sourceProp of sourceProps) {
    const targetProp = targetByType.get(sourceProp.property_type_id as string);

    if (!targetProp) {
      // Only the source has it — re-point the ROW so its evidence comes with it.
      assertWritable(factsOf(sourceProp), context.evidenceType);
      await trx
        .updateTable('property')
        .set({ [anchor]: targetId })
        .where('property.id', '=', sourceProp.id)
        .execute();
      if (anchor === 'node_id') {
        input.collector?.propertyTouched({
          nodeId: targetId as NodeId,
          nodeTypeId: input.nodeTypeId ?? null,
          propertyTypeId: sourceProp.property_type_id,
          before: null,
        });
      }
      changes.push({
        teamId: context.teamId as unknown as string,
        requestId: context.requestId!,
        source: context.changeSource,
        kind: ChangeKind.property_set,
        nodeId: anchor === 'node_id' ? (targetId as string) : null,
        edgeId: anchor === 'edge_id' ? (targetId as string) : null,
        propertyId: sourceProp.id as string,
        oldValue: null,
        newValue: propertyToChangeValue(sourceProp),
        createdBy: context.createdBy ?? null,
      });
      continue;
    }

    // Both carry it: the evidence converges on the target's row first, so the
    // history is intact whichever value wins.
    await trx
      .updateTable('evidence')
      .set({ property_id: targetProp.id })
      .where('evidence.property_id', '=', sourceProp.id)
      .execute();

    if (sourceProp.cardinality === PropertyCardinality.multi) {
      // A set union is a value the merge itself authored — through the door.
      await setProperties(trx, {
        context,
        anchor: doorAnchor,
        properties: [
          {
            propertyTypeId: sourceProp.property_type_id,
            value: sourceProp.value_text_array ?? sourceProp.value_text,
            description: 'Merged',
          },
        ],
      });
    } else if (
      sourceProp.evaluation_strategy === EvaluationStrategy.latest ||
      !sourceProp.evaluation_strategy
    ) {
      // The user picked which record survives; its value survives with it.
    } else {
      assertWritable(factsOf(targetProp), context.evidenceType);
      toReEvaluate.push({
        propertyId: targetProp.id,
        valueType: targetProp.value_type,
        strategy: targetProp.evaluation_strategy,
      });
    }

    await trx.deleteFrom('property').where('property.id', '=', sourceProp.id).execute();
  }

  if (changes.length > 0) await recordChanges(changes, trx);
  return toReEvaluate;
}

// ── Edge merging ───────────────────────────────────────────────────────────

async function mergeEdgesOfNode(
  trx: KnowledgeWriteDb,
  input: {
    context: WriteContext;
    targetNodeId: NodeId;
    sourceNodeId: NodeId;
    collector: MutationCollector;
  },
): Promise<PropertyToReEvaluate[]> {
  const { context, targetNodeId, sourceNodeId, collector } = input;
  const edgesTouching = async (nodeId: NodeId) =>
    trx
      .selectFrom('edge')
      .where((eb) =>
        eb.or([eb('edge.source_node_id', '=', nodeId), eb('edge.target_node_id', '=', nodeId)]),
      )
      .where('edge.team_id', '=', context.teamId)
      .select(['edge.id', 'edge.source_node_id', 'edge.target_node_id', 'edge.edge_type_id'])
      .execute();

  const [sourceEdges, targetEdges] = await Promise.all([
    edgesTouching(sourceNodeId),
    edgesTouching(targetNodeId),
  ]);

  const keyOf = (e: { edge_type_id: string; source_node_id: NodeId; target_node_id: NodeId }, self: NodeId) => {
    const outgoing = (e.source_node_id as string) === (self as string);
    const other = outgoing ? e.target_node_id : e.source_node_id;
    return { key: `${e.edge_type_id}:${other}:${outgoing ? 'out' : 'in'}`, outgoing, other };
  };

  const targetIndex = new Map(targetEdges.map((e) => [keyOf(e, targetNodeId).key, e]));
  const toReEvaluate: PropertyToReEvaluate[] = [];

  for (const sourceEdge of sourceEdges) {
    const { key, outgoing, other } = keyOf(sourceEdge, sourceNodeId);

    // An edge between the two merging nodes has nowhere to point.
    if ((other as string) === (targetNodeId as string)) {
      await trx.deleteFrom('edge').where('edge.id', '=', sourceEdge.id).execute();
      collector.edgeChanged({
        sourceNodeId: sourceEdge.source_node_id,
        targetNodeId: sourceEdge.target_node_id,
        edgeTypeId: sourceEdge.edge_type_id,
      });
      continue;
    }

    // Either way the target's adjacency moves: it absorbs an edge it did not
    // have, or it absorbs the evidence of a twin it did.
    collector.edgeChanged({
      sourceNodeId: outgoing ? targetNodeId : (other as NodeId),
      targetNodeId: outgoing ? (other as NodeId) : targetNodeId,
      edgeTypeId: sourceEdge.edge_type_id,
    });

    const twin = targetIndex.get(key);
    if (twin) {
      await trx
        .updateTable('evidence')
        .set({ edge_id: twin.id })
        .where('evidence.edge_id', '=', sourceEdge.id)
        .execute();
      toReEvaluate.push(
        ...(await mergePropertiesIn(trx, {
          context,
          anchor: 'edge_id',
          targetId: twin.id,
          sourceId: sourceEdge.id,
        })),
      );
      await trx.deleteFrom('edge').where('edge.id', '=', sourceEdge.id).execute();
    } else {
      await trx
        .updateTable('edge')
        .set({ [outgoing ? 'source_node_id' : 'target_node_id']: targetNodeId })
        .where('edge.id', '=', sourceEdge.id)
        .execute();
    }
  }

  return toReEvaluate;
}
