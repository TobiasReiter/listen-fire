import { z } from 'zod';

import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { PropertyId } from '../../generated/kysely/knowledge/Property';
import type { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import type { EdgeId } from '../../generated/kysely/knowledge/Edge';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { Changeset, ChangesetProperty, ApplyResult } from './types';

import { getKnowledgeQb } from '../../lib/kysely';
import { execute } from '../../lib/prompts/execute';
import { promptDef } from '../../lib/prompts/definition';
import EvaluationStrategy from '../../generated/kysely/knowledge/EvaluationStrategy';
import PropertyCardinality from '../../generated/kysely/knowledge/PropertyCardinality';
import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import { isWritableBy } from '../../lib/knowledge/writable_by';
import { recordChanges, ChangeSource, ChangeKind, propertyToChangeValue, changeValuesEqual, type RecordChangeParams } from '../../lib/knowledge/changes';

function coerceNumeric(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'number') return isFinite(value) ? String(value) : null;
  const str = String(value).trim().replace(/,/g, '');
  // Strip common prefixes/suffixes: $, %, +, M/B/K suffixes
  const cleaned = str.replace(/^[$£€]/, '').replace(/%$/, '').trim();
  const num = Number(cleaned);
  return isFinite(num) ? String(num) : null;
}

function setPropertyValue(
  valueType: string | null,
  value: unknown,
  cardinality: PropertyCardinality | string | null = PropertyCardinality.single,
): { value_text?: string | null; value_text_array?: string[] | null; value_number?: string | null; value_date?: string | null; value_boolean?: boolean | null; value_json?: unknown } {
  if (value == null) return {};
  if (cardinality === PropertyCardinality.multi) {
    // Multi-cardinality only supports text values for now; other value types fall through to single behavior.
    // We also mirror a representative value into value_text so existing read paths
    // (display name, retrieval, UI) keep returning something useful without needing to know about arrays.
    if (valueType === 'text' || !valueType) {
      const v = String(value);
      return { value_text: v, value_text_array: [v] };
    }
  }
  switch (valueType) {
    case 'text':
      return { value_text: String(value) };
    case 'number':
      return { value_number: coerceNumeric(value) };
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

// Naive case-insensitive set-union for multi-cardinality text properties.
// LLM-curated set evaluation is the eventual treatment per consolidation-authority plan;
// this is the MVP that gets uniqueness-matching working.
function unionTextSet(existing: string[] | null | undefined, incoming: string[]): string[] {
  const seen = new Map<string, string>();
  for (const v of existing ?? []) {
    if (v == null) continue;
    const key = v.toLowerCase();
    if (!seen.has(key)) seen.set(key, v);
  }
  for (const v of incoming) {
    if (v == null) continue;
    const key = v.toLowerCase();
    if (!seen.has(key)) seen.set(key, v);
  }
  return [...seen.values()];
}

const evaluationPromptDef = promptDef({
  description: 'Evaluate property value from evidence',
  arguments: ['propertyName', 'propertyDescription', 'propertyType', 'evidence'] as const,
  messages: [
    {
      role: 'system' as const,
      content: `You are evaluating a property value from pieces of evidence.
Synthesize the evidence into the most accurate current value for this property.
The value must match the property's description and type — read both carefully.
More recent evidence is generally more reliable.
Note if there's a significant conflict between sources.

Respond with a JSON object: {"value": <the value or null>, "has_conflict": <true/false>, "reasoning": "<explanation>"}`,
    },
    {
      role: 'user' as const,
      content: `Property: {{{propertyName}}}
Description: {{{propertyDescription}}}
Type: {{{propertyType}}}

Evidence (most recent first):
{{{evidence}}}`,
    },
  ],
  validator: z.object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).nullable(),
    has_conflict: z.boolean(),
    reasoning: z.string(),
  }),
});

/**
 * Evidence records its source as an opaque `{kind, id}` ref rather than a
 * foreign key (K-7), so the store can say where a value came from without
 * knowing what sources exist. Everything this file evidences is a
 * `public.resource`, so that is the kind it stamps.
 */
function resourceSourceRef(resourceId: string | null | undefined): string | undefined {
  if (!resourceId) return undefined;
  return JSON.stringify({ kind: 'resource', id: resourceId });
}

async function applyChangeset(changeset: Changeset, teamId: TeamId): Promise<ApplyResult> {
  const qb = getKnowledgeQb([
    'node',
    'edge',
    'property',
    'property_type',
    'evidence',
    'node_resource',
  ]);

  const requestId = crypto.randomUUID();
  const changeRecords: RecordChangeParams[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await qb.transaction().execute(async (trx: any) => {
    const tempToRealId = new Map<string, NodeId>();
    const propTempToRealId = new Map<string, PropertyId>();
    const nodesCreated: NodeId[] = [];
    const nodesUpdated: NodeId[] = [];
    const propertiesUpdated = new Map<NodeId, Set<PropertyTypeId>>();

    // 1. Create message node
    const messageResult = await trx
      .insertInto('node')
      .values({
        team_id: teamId,
        node_type_id: changeset.messageNode.nodeType,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    tempToRealId.set(changeset.messageNode.tempId, messageResult.id as NodeId);
    nodesCreated.push(messageResult.id as NodeId);
    changeRecords.push({ teamId, requestId, source: ChangeSource.pipeline, kind: ChangeKind.node_created, nodeId: messageResult.id });

    // 2. Process entity nodes (already in topological order)
    for (const node of changeset.nodes) {
      if (node.tempId === changeset.messageNode.tempId) continue;

      if (node.resolution.action === 'create') {
        const result = await trx
          .insertInto('node')
          .values({
            team_id: teamId,
            node_type_id: node.nodeType,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        tempToRealId.set(node.tempId, result.id as NodeId);
        nodesCreated.push(result.id as NodeId);
        changeRecords.push({ teamId, requestId, source: ChangeSource.pipeline, kind: ChangeKind.node_created, nodeId: result.id });
      } else {
        tempToRealId.set(node.tempId, node.resolution.existingNodeId);
        nodesUpdated.push(node.resolution.existingNodeId);
      }
    }

    // 3. Create edges (skip duplicates)
    const edgeIds = new Map<string, EdgeId>();

    for (const edge of changeset.edges) {
      const sourceId = tempToRealId.get(edge.sourceTempId);
      const targetId = tempToRealId.get(edge.targetTempId);
      if (!sourceId || !targetId) continue;

      const existing = await trx
        .selectFrom('edge')
        .where('edge.source_node_id', '=', sourceId)
        .where('edge.target_node_id', '=', targetId)
        .where('edge.edge_type_id', '=', edge.edgeType)
        .where('edge.team_id', '=', teamId)
        .select('edge.id')
        .executeTakeFirst();

      if (existing) {
        edgeIds.set(`${edge.sourceTempId}:${edge.targetTempId}:${edge.edgeType}`, existing.id as EdgeId);
        continue;
      }

      const result = await trx
        .insertInto('edge')
        .values({
          team_id: teamId,
          source_node_id: sourceId,
          target_node_id: targetId,
          edge_type_id: edge.edgeType,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      edgeIds.set(`${edge.sourceTempId}:${edge.targetTempId}:${edge.edgeType}`, result.id as EdgeId);
      changeRecords.push({ teamId, requestId, source: ChangeSource.pipeline, kind: ChangeKind.edge_created, edgeId: result.id });
    }

    // 4. Process properties
    const propertiesWithNewEvidence = new Set<string>();

    // Track properties inserted in this transaction to prevent duplicates
    // Key: "node:{nodeId}:{propertyTypeId}" or "edge:{edgeId}:{propertyTypeId}"
    const insertedPropertyKeys = new Map<string, PropertyId>();

    // Fetch property type info for value setting and evaluation
    const propTypeIds = [...new Set(changeset.properties.map((p) => p.propertyTypeId))];
    const propTypes = propTypeIds.length > 0
      ? await trx
          .selectFrom('property_type')
          .where('property_type.id', 'in', propTypeIds)
          .where('property_type.team_id', '=', teamId)
          .select(['property_type.id', 'property_type.name', 'property_type.description', 'property_type.value_type', 'property_type.evaluation_strategy', 'property_type.cardinality', 'property_type.writable_by'])
          .execute()
      : [];
    interface PropTypeInfo { id: string; name: string; description: string | null; value_type: string | null; evaluation_strategy: string | null; cardinality: string | null; writable_by: EvidenceType[] | null }
    const propTypeMap = new Map<string, PropTypeInfo>(
      propTypes.map((pt: PropTypeInfo) => [pt.id, pt] as const),
    );

    // Build a map from property tempId → evidence type for writability checks
    const propEvidenceTypeMap = new Map<string, EvidenceType>();
    for (const ev of changeset.evidence) {
      propEvidenceTypeMap.set(ev.targetPropertyTempId, ev.type);
    }

    // For multi-cardinality, merge the incoming value into the property row's existing value_text_array
    // (case-insensitive set-union). Caller has already verified the row exists.
    // Also keeps value_text mirrored to the first array element for read-path compatibility.
    async function mergeMultiValue(propertyId: PropertyId, incomingValue: unknown) {
      if (incomingValue == null) return null;
      const existing = await trx
        .selectFrom('property')
        .where('property.id', '=', propertyId)
        .where('property.team_id', '=', teamId)
        .select('property.value_text_array')
        .executeTakeFirst();
      const merged = unionTextSet(existing?.value_text_array ?? null, [String(incomingValue)]);
      await trx
        .updateTable('property')
        .set({ value_text_array: merged, value_text: merged[0] ?? null, updated_at: new Date() })
        .where('property.id', '=', propertyId)
        .where('property.team_id', '=', teamId)
        .execute();
      return merged;
    }

    for (const prop of changeset.properties) {
      const ptInfo = propTypeMap.get(prop.propertyTypeId as string);

      // Enforce writable_by: skip properties whose type doesn't allow this evidence type
      const evidenceType = propEvidenceTypeMap.get(prop.tempId);
      if (ptInfo && evidenceType && !isWritableBy(ptInfo.writable_by, evidenceType)) {
        continue;
      }

      const isMulti = ptInfo?.cardinality === PropertyCardinality.multi;
      const valueFields = setPropertyValue(ptInfo?.value_type ?? null, prop.value, ptInfo?.cardinality ?? null);

      if (prop.ownerEdgeKey) {
        // Edge property — resolve edge ID from edgeIds map
        const edgeId = edgeIds.get(prop.ownerEdgeKey);
        if (!edgeId) continue;

        const edgePropKey = `edge:${edgeId}:${prop.propertyTypeId}`;

        if (prop.resolution.action === 'create') {
          // Check if we already inserted this property in this transaction
          const alreadyInserted = insertedPropertyKeys.get(edgePropKey);
          if (alreadyInserted) {
            if (isMulti) {
              const merged = await mergeMultiValue(alreadyInserted, prop.value);
              if (merged != null) {
                changeRecords.push({ teamId, requestId, source: ChangeSource.pipeline, kind: ChangeKind.property_set, edgeId, propertyId: alreadyInserted as string, newValue: propertyToChangeValue({ value_text_array: merged }) });
              }
            }
            propTempToRealId.set(prop.tempId, alreadyInserted);
            propertiesWithNewEvidence.add(prop.tempId);
            continue;
          }

          // Check if property already exists on this edge (upsert safety)
          const existing = await trx
            .selectFrom('property')
            .where('property.edge_id', '=', edgeId)
            .where('property.property_type_id', '=', prop.propertyTypeId)
            .select('property.id')
            .executeTakeFirst();

          if (existing) {
            if (isMulti) {
              const merged = await mergeMultiValue(existing.id as PropertyId, prop.value);
              changeRecords.push({ teamId, requestId, source: ChangeSource.pipeline, kind: ChangeKind.property_set, edgeId, propertyId: existing.id, newValue: propertyToChangeValue({ value_text_array: merged ?? null }) });
            } else {
              await trx
                .updateTable('property')
                .set({ ...valueFields, updated_at: new Date() })
                .where('property.id', '=', existing.id as PropertyId)
                .execute();
              changeRecords.push({ teamId, requestId, source: ChangeSource.pipeline, kind: ChangeKind.property_set, edgeId, propertyId: existing.id, newValue: propertyToChangeValue(valueFields) });
            }
            propTempToRealId.set(prop.tempId, existing.id as PropertyId);
            insertedPropertyKeys.set(edgePropKey, existing.id as PropertyId);
          } else {
            const result = await trx
              .insertInto('property')
              .values({
                team_id: teamId,
                edge_id: edgeId,
                property_type_id: prop.propertyTypeId,
                ...valueFields,
              })
              .returning('id')
              .executeTakeFirstOrThrow();
            propTempToRealId.set(prop.tempId, result.id as PropertyId);
            insertedPropertyKeys.set(edgePropKey, result.id as PropertyId);
            changeRecords.push({ teamId, requestId, source: ChangeSource.pipeline, kind: ChangeKind.property_set, edgeId, propertyId: result.id, newValue: propertyToChangeValue(valueFields) });
          }
        } else {
          propTempToRealId.set(prop.tempId, prop.resolution.existingNodeId as unknown as PropertyId);
        }
        continue;
      }

      // Node property
      const parentRealId = tempToRealId.get(prop.parentTempId);
      if (!parentRealId) continue;

      const nodePropKey = `node:${parentRealId}:${prop.propertyTypeId}`;

      if (prop.resolution.action === 'create') {
        // Check if we already inserted this property in this transaction
        const alreadyInserted = insertedPropertyKeys.get(nodePropKey);
        if (alreadyInserted) {
          if (isMulti) {
            const merged = await mergeMultiValue(alreadyInserted, prop.value);
            if (merged != null) {
              changeRecords.push({ teamId, requestId, source: ChangeSource.pipeline, kind: ChangeKind.property_set, nodeId: parentRealId, propertyId: alreadyInserted as string, newValue: propertyToChangeValue({ value_text_array: merged }) });
            }
          }
          // Map to existing property so evidence still gets attached
          propTempToRealId.set(prop.tempId, alreadyInserted);
          propertiesWithNewEvidence.add(prop.tempId);
          continue;
        }

        // For matched parent nodes, check if a property of this type already exists
        // (handles cases where consolidation marked 'create' but a row already exists)
        const parentNode = changeset.nodes.find((n) => n.tempId === prop.parentTempId);
        const parentIsMatched = parentNode?.resolution.action === 'match';

        let existingPropId: PropertyId | null = null;
        if (parentIsMatched) {
          const existing = await trx
            .selectFrom('property')
            .where('property.node_id', '=', parentRealId)
            .where('property.property_type_id', '=', prop.propertyTypeId)
            .select('property.id')
            .executeTakeFirst();
          if (existing) existingPropId = existing.id as PropertyId;
        }

        if (existingPropId) {
          if (isMulti) {
            const merged = await mergeMultiValue(existingPropId, prop.value);
            changeRecords.push({ teamId, requestId, source: ChangeSource.pipeline, kind: ChangeKind.property_set, nodeId: parentRealId, propertyId: existingPropId as string, newValue: propertyToChangeValue({ value_text_array: merged ?? null }) });
          } else {
            // Upsert: update existing property with new value
            await trx
              .updateTable('property')
              .set({ ...valueFields, updated_at: new Date() })
              .where('property.id', '=', existingPropId)
              .execute();
            changeRecords.push({ teamId, requestId, source: ChangeSource.pipeline, kind: ChangeKind.property_set, nodeId: parentRealId, propertyId: existingPropId as string, newValue: propertyToChangeValue(valueFields) });
          }
          propTempToRealId.set(prop.tempId, existingPropId);
          insertedPropertyKeys.set(nodePropKey, existingPropId);

          const propSet = propertiesUpdated.get(parentRealId) ?? new Set();
          propSet.add(prop.propertyTypeId);
          propertiesUpdated.set(parentRealId, propSet);
        } else {
          const result = await trx
            .insertInto('property')
            .values({
              team_id: teamId,
              node_id: parentRealId,
              property_type_id: prop.propertyTypeId,
              ...valueFields,
            })
            .returning('id')
            .executeTakeFirstOrThrow();

          propTempToRealId.set(prop.tempId, result.id as PropertyId);
          insertedPropertyKeys.set(nodePropKey, result.id as PropertyId);
          changeRecords.push({ teamId, requestId, source: ChangeSource.pipeline, kind: ChangeKind.property_set, nodeId: parentRealId, propertyId: result.id, newValue: propertyToChangeValue(valueFields) });
        }
      } else {
        // Matched existing property
        propTempToRealId.set(prop.tempId, prop.resolution.existingNodeId as unknown as PropertyId);

        // Track which parent had properties updated
        const propSet = propertiesUpdated.get(parentRealId) ?? new Set();
        propSet.add(prop.propertyTypeId);
        propertiesUpdated.set(parentRealId, propSet);
      }
    }

    // 5. Create property evidence
    for (const ev of changeset.evidence) {
      const propertyId = propTempToRealId.get(ev.targetPropertyTempId);
      if (!propertyId) continue;

      await trx
        .insertInto('evidence')
        .values({
          team_id: teamId,
          property_id: propertyId,
          source_ref: resourceSourceRef(ev.resourceId),
          type: ev.type,
          description: ev.description,
        })
        .execute();

      propertiesWithNewEvidence.add(ev.targetPropertyTempId);
    }

    // 5b. Create edge evidence
    for (const ev of changeset.edgeEvidence) {
      const edgeKey = `${ev.sourceTempId}:${ev.targetTempId}:${ev.edgeType}`;
      const edgeId = edgeIds.get(edgeKey);
      if (!edgeId) continue;

      await trx
        .insertInto('evidence')
        .values({
          team_id: teamId,
          edge_id: edgeId,
          source_ref: resourceSourceRef(ev.resourceId),
          type: ev.type,
          description: ev.description,
        })
        .execute();
    }

    // 6. Create node_resource links
    for (const nr of changeset.nodeResources) {
      const nodeId = tempToRealId.get(nr.targetTempId);
      if (!nodeId) continue;

      await trx
        .insertInto('node_resource')
        .values({
          team_id: teamId,
          node_id: nodeId,
          resource_id: nr.resourceId,
          start_offset: nr.startOffset,
          end_offset: nr.endOffset,
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .onConflict((oc: any) => oc.columns(['node_id', 'resource_id']).doNothing())
        .execute();
    }

    // 7. Re-evaluate properties that received new evidence
    // This covers: (a) matched properties with new extraction evidence,
    // (b) properties deduplicated within this transaction (multiple extractions
    //     of the same property that were merged at insert time).
    const reevaluated = new Set<string>();
    for (const propTempId of propertiesWithNewEvidence) {
      const propertyId = propTempToRealId.get(propTempId);
      if (!propertyId) continue;
      if (reevaluated.has(propertyId as string)) continue;
      reevaluated.add(propertyId as string);

      const prop = changeset.properties.find((p) => p.tempId === propTempId);
      if (!prop) continue;

      const ptInfo = propTypeMap.get(prop.propertyTypeId as string);
      if (!ptInfo) continue;

      // Count evidence on this property — only re-evaluate if there are multiple
      const evidenceRows = await trx
        .selectFrom('evidence')
        .where('evidence.property_id', '=', propertyId)
        .where('evidence.team_id', '=', teamId)
        .select('evidence.id')
        .execute();

      // Multi-cardinality properties skip recalculation: the set is already merged at write time.
      // LLM-curated set evaluation is the eventual treatment per consolidation-authority plan.
      if (ptInfo.cardinality === PropertyCardinality.multi) continue;

      if (evidenceRows.length > 1) {
        await evaluateProperty(trx, propertyId, ptInfo.value_type, ptInfo.evaluation_strategy, prop.value, teamId, ptInfo.name, ptInfo.description, { changeRecords, requestId });
      }
    }

    return { nodesCreated, nodesUpdated, propertiesUpdated, tempToRealId };
  });

  if (changeRecords.length > 0) {
    await recordChanges(changeRecords);
  }

  return result;
}

async function evaluateProperty(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trx: any,
  propertyId: PropertyId,
  valueType: string | null,
  strategy: string | null,
  newExtractedValue: unknown,
  teamId: TeamId,
  propertyName?: string,
  propertyDescription?: string | null,
  changeContext?: { changeRecords: RecordChangeParams[]; requestId: string },
) {
  const allEvidence = await trx
    .selectFrom('evidence')
    .where('evidence.property_id', '=', propertyId)
    .where('evidence.team_id', '=', teamId)
    .orderBy('evidence.created_at', 'desc')
    .select(['evidence.type', 'evidence.description', 'evidence.created_at'])
    .execute();

  if (!allEvidence.length) return;

  // User edits take priority
  const userEdit = allEvidence.find((e: { type: string }) => e.type === EvidenceType.user_edit);
  if (userEdit) return;

  // Fetch current property value for change tracking
  const currentProp = changeContext
    ? await trx
        .selectFrom('property')
        .where('property.id', '=', propertyId)
        .select(['property.node_id', 'property.edge_id', 'property.value_text', 'property.value_number', 'property.value_date', 'property.value_boolean', 'property.value_json'])
        .executeTakeFirst()
    : null;

  const recordPropertyChange = (valueFields: ReturnType<typeof setPropertyValue>) => {
    if (!changeContext || !currentProp) return;
    const oldValue = propertyToChangeValue(currentProp);
    const newValue = propertyToChangeValue(valueFields);
    if (changeValuesEqual(oldValue, newValue)) return;
    changeContext.changeRecords.push({
      teamId,
      requestId: changeContext.requestId,
      source: ChangeSource.pipeline,
      kind: ChangeKind.property_set,
      propertyId: propertyId as string,
      nodeId: currentProp.node_id,
      edgeId: currentProp.edge_id,
      oldValue,
      newValue,
    });
  };

  if (strategy === EvaluationStrategy.latest || !strategy) {
    if (newExtractedValue != null) {
      const valueFields = setPropertyValue(valueType, newExtractedValue);
      await trx
        .updateTable('property')
        .set(valueFields)
        .where('property.id', '=', propertyId)
        .execute();
      recordPropertyChange(valueFields);
    }
    return;
  }

  if (strategy === EvaluationStrategy.llm && allEvidence.length > 1) {
    const result = await execute(
      'knowledge_evaluate_property',
      evaluationPromptDef,
      {
        propertyName: propertyName ?? 'Unknown',
        propertyDescription: propertyDescription ?? '',
        propertyType: valueType ?? 'text',
        evidence: JSON.stringify(allEvidence.map((e: { description: string; created_at: Date }) => ({
          description: e.description,
          created_at: e.created_at,
        }))),
      },
    );

    if (result.value != null) {
      const valueFields = setPropertyValue(valueType, result.value);
      await trx
        .updateTable('property')
        .set(valueFields)
        .where('property.id', '=', propertyId)
        .execute();
      recordPropertyChange(valueFields);
    }
  }
}

export { applyChangeset, evaluationPromptDef, setPropertyValue };
