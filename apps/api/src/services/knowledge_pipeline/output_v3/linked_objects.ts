import { sql } from 'kysely';

import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type LinkedObjectSource from '../../../generated/kysely/knowledge/LinkedObjectSource';

import { getKnowledgeQb } from '../../../lib/kysely';
import { normalizeAdapterType } from 'movement-engine/services/translation_graph/adapter_type';

// unified linked object model

/**
 * Canonical form for `linked_object.adapter_type` — lowercase. Two
 * conventions used to coexist (the legacy refresh path stored
 * `ExternalServiceType` enum values in uppercase like `ATTIO`, the TG
 * dispatch path stored adapter ids in lowercase like `attio`); Postgres
 * is case-sensitive, so a node bridged via one path didn't match
 * queries from the other.
 *
 * All linked_object reads and writes funnel adapter_type through this
 * helper so the column is always lowercase. Rows written before this
 * normalisation landed are migrated by the
 * `*_lowercase_linked_object_adapter_type` migration.
 */
export { normalizeAdapterType };

interface LinkedObjectRow {
  id: string;
  node_id: string;
  source: LinkedObjectSource;
  adapter_type: string;
  external_id: string;
  external_object_type: string | null;
  data: unknown;
  retrieval_source_id: string | null;
  output_id: string | null;
  action_node_id: string | null;
  fetched_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

async function storeLinkedObject(options: {
  nodeId: NodeId;
  teamId: TeamId;
  source: LinkedObjectSource;
  adapterType: string;
  externalId: string;
  externalObjectType?: string;
  data?: Record<string, unknown>;
  retrievalSourceId?: string;
  outputId?: string;
  actionNodeId?: string;
}): Promise<void> {
  const qb = getKnowledgeQb([]);

  const adapterType = normalizeAdapterType(options.adapterType);
  await sql`
    INSERT INTO knowledge.linked_object
      (team_id, node_id, source, adapter_type, external_id, external_object_type, data, retrieval_source_id, output_id, action_node_id)
    VALUES (
      ${options.teamId}, ${options.nodeId}, ${options.source},
      ${adapterType}, ${options.externalId}, ${options.externalObjectType ?? null},
      ${JSON.stringify(options.data ?? {})}::jsonb,
      ${options.retrievalSourceId ?? null}, ${options.outputId ?? null}, ${options.actionNodeId ?? null}
    )
    ON CONFLICT (node_id, adapter_type, external_id)
    DO UPDATE SET
      data = EXCLUDED.data,
      external_object_type = COALESCE(EXCLUDED.external_object_type, knowledge.linked_object.external_object_type),
      source = EXCLUDED.source,
      output_id = COALESCE(EXCLUDED.output_id, knowledge.linked_object.output_id),
      action_node_id = COALESCE(EXCLUDED.action_node_id, knowledge.linked_object.action_node_id),
      updated_at = CURRENT_TIMESTAMP
  `.execute(qb);
}

async function loadLinkedObjects(
  nodeId: NodeId,
  teamId: TeamId,
  filter?: { adapterType?: string; source?: LinkedObjectSource },
): Promise<LinkedObjectRow[]> {
  const qb = getKnowledgeQb([]);

  let query = sql<LinkedObjectRow>`
    SELECT id, node_id, source, adapter_type, external_id, external_object_type, data,
           retrieval_source_id, output_id, action_node_id,
           fetched_at, created_at, updated_at
    FROM knowledge.linked_object
    WHERE node_id = ${nodeId} AND team_id = ${teamId}`;

  if (filter?.adapterType) {
    query = sql<LinkedObjectRow>`${query} AND adapter_type = ${normalizeAdapterType(filter.adapterType)}`;
  }
  if (filter?.source) {
    query = sql<LinkedObjectRow>`${query} AND source = ${filter.source}`;
  }

  const result = await query.execute(qb);
  return result.rows;
}

async function deleteLinkedObject(id: string, teamId: TeamId): Promise<void> {
  const qb = getKnowledgeQb([]);

  await sql`
    DELETE FROM knowledge.linked_object
    WHERE id = ${id} AND team_id = ${teamId}
  `.execute(qb);
}

async function storeOutputRun(options: {
  teamId: TeamId;
  pipelineOutputId: string;
  actionNodeId: string;
  contextNodeId: NodeId | null;
  adapterType: string;
  externalId: string | null;
  externalObjectType?: string;
  status: string;
  error?: string;
  fieldValues?: Record<string, unknown>;
  runGroupId?: string;
  created?: boolean;
  rootNodeId?: NodeId | null;
}): Promise<void> {
  const qb = getKnowledgeQb([]);

  const fieldValuesJson = options.fieldValues ? JSON.stringify(options.fieldValues) : null;

  // During initial ingestion dry runs, context/root node IDs may be temp changeset IDs
  // that don't exist in the DB. Verify they exist before inserting.
  const idsToCheck = [options.contextNodeId, options.rootNodeId].filter(Boolean) as string[];
  const existingIds = new Set<string>();
  if (idsToCheck.length > 0) {
    const idLiterals = idsToCheck.map((id) => `'${id}'::uuid`).join(', ');
    const rows = await sql<{ id: string }>`
      SELECT id FROM knowledge.node WHERE id IN (${sql.raw(idLiterals)})
    `.execute(qb);
    for (const row of rows.rows) existingIds.add(row.id);
  }

  const ctxId = options.contextNodeId && existingIds.has(options.contextNodeId as string) ? options.contextNodeId : null;
  const rootId = options.rootNodeId && existingIds.has(options.rootNodeId as string) ? options.rootNodeId : null;

  // output_run.adapter_type joins back to linked_object.adapter_type,
  // so the same lowercase canon applies.
  const adapterType = normalizeAdapterType(options.adapterType);
  await sql`
    INSERT INTO knowledge.output_run (team_id, pipeline_output_id, action_node_id, context_node_id, adapter_type, external_id, external_object_type, status, error, field_values, run_group_id, created, root_node_id)
    VALUES (${options.teamId}, ${options.pipelineOutputId}, ${options.actionNodeId}, ${ctxId}, ${adapterType}, ${options.externalId}, ${options.externalObjectType ?? null}, ${options.status}, ${options.error ?? null}, ${fieldValuesJson}::jsonb, ${options.runGroupId ?? null}::uuid, ${options.created ?? null}, ${rootId}::uuid)
  `.execute(qb);
}

async function updateLinkedObjectExternalId(
  id: string,
  teamId: TeamId,
  newExternalId: string,
): Promise<void> {
  const qb = getKnowledgeQb([]);

  // If another linked object already points to the new external_id (same node + adapter),
  // just delete the stale one — the existing row is already correct.
  const existing = await sql<{ id: string }>`
    SELECT lo2.id FROM knowledge.linked_object lo2
    JOIN knowledge.linked_object lo1 ON lo1.node_id = lo2.node_id AND lo1.adapter_type = lo2.adapter_type
    WHERE lo1.id = ${id} AND lo2.external_id = ${newExternalId} AND lo2.team_id = ${teamId}
  `.execute(qb);

  if (existing.rows.length > 0) {
    await sql`
      DELETE FROM knowledge.linked_object WHERE id = ${id} AND team_id = ${teamId}
    `.execute(qb);
    return;
  }

  await sql`
    UPDATE knowledge.linked_object
    SET external_id = ${newExternalId}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id} AND team_id = ${teamId}
  `.execute(qb);
}

export { storeLinkedObject, loadLinkedObjects, deleteLinkedObject, updateLinkedObjectExternalId, storeOutputRun };
export type { LinkedObjectRow };
