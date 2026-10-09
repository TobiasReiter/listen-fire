// Merging, from the product's side: the store performs the structural merge
// (gated, evidenced, recorded — see `store/merge.ts`) and hands back the
// properties whose evaluation strategy wants the model to arbitrate. Running
// that arbitration is this side's job, after the transaction commits: an LLM
// call inside a transaction holds the connection open for the length of an API
// call, and the store never calls a model at all (K-5).

import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { EdgeId } from '../../generated/kysely/knowledge/Edge';
import type { PropertyId } from '../../generated/kysely/knowledge/Property';
import type { TeamId } from '../../generated/kysely/core/Team';

import { execute } from '../prompts/execute';
import { evaluationPromptDef, setPropertyValue } from '../../services/knowledge_pipeline/apply';
import EvaluationStrategy from '../../generated/kysely/knowledge/EvaluationStrategy';
import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import { getKnowledgeQb } from '../kysely';
import {
  mergeEdges as mergeEdgesInStore,
  mergeNodes as mergeNodesInStore,
  openKnowledgeStore,
  type PropertyToReEvaluate,
  type WriteContext,
} from './store';
import { recordChange, ChangeSource, ChangeKind, propertyToChangeValue, changeValuesEqual } from './changes';

interface MergeParams {
  targetNodeId: NodeId;
  sourceNodeId: NodeId;
  teamId: TeamId;
  /** How the change feed should attribute the merge. */
  source?: ChangeSource;
}

/** A merge is curation: the values it lands are `user_edit` writes (D37b). */
function mergeContext(teamId: TeamId, source: ChangeSource | undefined): WriteContext {
  return {
    teamId,
    evidenceType: EvidenceType.user_edit,
    changeSource: source ?? ChangeSource.agent,
    description: 'Merged',
  };
}

async function reEvaluateAll(props: PropertyToReEvaluate[], teamId: TeamId): Promise<void> {
  for (const prop of props) {
    await reEvaluateProperty(prop.propertyId, prop.valueType, prop.strategy, teamId);
  }
}

async function mergeNodes({ targetNodeId, sourceNodeId, teamId, source }: MergeParams) {
  const { mergedNodeId, propertiesToReEvaluate } = await mergeNodesInStore(openKnowledgeStore(), {
    context: mergeContext(teamId, source),
    targetNodeId,
    sourceNodeId,
  });
  await reEvaluateAll(propertiesToReEvaluate, teamId);
  return { mergedNodeId };
}

async function mergeEdges({
  targetEdgeId,
  sourceEdgeId,
  teamId,
  source,
}: {
  targetEdgeId: EdgeId;
  sourceEdgeId: EdgeId;
  teamId: TeamId;
  source?: ChangeSource;
}) {
  const { mergedEdgeId, propertiesToReEvaluate } = await mergeEdgesInStore(openKnowledgeStore(), {
    context: mergeContext(teamId, source),
    targetEdgeId,
    sourceEdgeId,
  });
  await reEvaluateAll(propertiesToReEvaluate, teamId);
  return { mergedEdgeId };
}

// ── Re-evaluation ──

async function reEvaluateProperty(
  propertyId: PropertyId,
  valueType: string | null,
  strategy: string | null,
  teamId: TeamId,
  options?: {
    propertyName?: string;
    propertyDescription?: string;
    force?: boolean;
  },
) {
  const qb = getKnowledgeQb(['evidence', 'property']);
  const force = options?.force ?? false;

  const allEvidence = await qb
    .selectFrom('evidence')
    .where('evidence.property_id', '=', propertyId)
    .where('evidence.team_id', '=', teamId)
    .orderBy('evidence.created_at', 'desc')
    .select(['evidence.type', 'evidence.description', 'evidence.created_at'])
    .execute();

  if (!allEvidence.length) return;

  // User edits take priority (unless force regeneration)
  if (!force && allEvidence.find((e: { type: string }) => e.type === EvidenceType.user_edit)) return;

  // Normal mode: only LLM strategy with multiple evidence. Force mode: always run.
  if (!force && (strategy !== EvaluationStrategy.llm || allEvidence.length <= 1)) return;

  // Fetch current property value for change tracking
  const currentProp = await qb
    .selectFrom('property')
    .where('property.id', '=', propertyId)
    .select(['property.node_id', 'property.edge_id', 'property.value_text', 'property.value_number', 'property.value_date', 'property.value_boolean', 'property.value_json'])
    .executeTakeFirst();

  // Fetch property name/description if not provided
  let propertyName = options?.propertyName;
  let propertyDescription = options?.propertyDescription;
  if (!propertyName || !propertyDescription) {
    const propType = await getKnowledgeQb(['property', 'property_type'])
      .selectFrom('property')
      .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
      .where('property.id', '=', propertyId)
      .select(['property_type.name', 'property_type.description'])
      .executeTakeFirst();
    propertyName = propertyName ?? propType?.name ?? 'Unknown';
    propertyDescription = propertyDescription ?? propType?.description ?? '';
  }

  const result = await execute('knowledge_evaluate_property', evaluationPromptDef, {
    propertyName: propertyName ?? 'Unknown',
    propertyDescription: propertyDescription ?? '',
    propertyType: valueType ?? 'text',
    evidence: JSON.stringify(
      allEvidence.map((e: { description: string; created_at: Date }) => ({
        description: e.description,
        created_at: e.created_at,
      })),
    ),
  });

  if (result.value != null) {
    const valueFields = setPropertyValue(valueType, result.value);
    await qb
      .updateTable('property')
      .set(valueFields)
      .where('property.id', '=', propertyId)
      .execute();

    if (currentProp) {
      const oldValue = propertyToChangeValue(currentProp);
      const newValue = propertyToChangeValue(valueFields);
      if (!changeValuesEqual(oldValue, newValue)) {
        await recordChange({
          teamId,
          requestId: crypto.randomUUID(),
          source: ChangeSource.pipeline,
          kind: ChangeKind.property_set,
          propertyId: propertyId as string,
          nodeId: currentProp.node_id,
          edgeId: currentProp.edge_id,
          oldValue,
          newValue,
        });
      }
    }
  }
}

export { mergeNodes, mergeEdges, reEvaluateProperty };
