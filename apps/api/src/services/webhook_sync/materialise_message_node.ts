// W3-B1 — external→KG identity bridging at the webhook dispatch layer.
//
// Restores the contract that **KG-internal code never sees external
// identifiers**. R18 wired `applyTarget.anchorNodeId` off
// `trigger.recordId`; R19 patched the resulting bug (Slack `ts` is not a
// UUID) by gating apply-target construction on UUID shape. That was a
// fallback path. The proper fix lives here: webhook bridges materialise
// the inbound source as a KG node (or look up an existing one via
// `linked_object`) and surface its real `NodeId` UUID as
// `trigger.recordId` before the engine ever runs.
//
// External identifiers (Slack `ts`, MIME Message-ID, Attio record id)
// move to a separate `externalRecordRef` slot on `TriggerEvent` for
// traceability — they never touch UUID-typed columns again.
//
// Lookup-first / create-second:
//
//   1. Existing `linked_object` for `(team, adapter, externalId)` → reuse
//      its `node_id`. Idempotent: re-deliveries of the same Slack message
//      land on the same KG node.
//   2. Otherwise, if the `pipeline_input` has a configured
//      `pipeline_input_message_type` (a node type the operator nominated
//      as the materialisation target), insert a node of that type +
//      a `linked_object` row in one transaction.
//   3. Otherwise, return undefined. The engine then runs without an
//      anchor (no apply-target → batcher stays read-only). This matches
//      R19's closing position, but the failure mode is "operator hasn't
//      configured a message type" rather than "string isn't UUID-shaped".

import type { TeamId } from '../../generated/kysely/core/Team';
import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { PipelineInputId } from '../../generated/kysely/public/PipelineInput';

import { logger } from 'movement-engine/public/log';
import { getKnowledgeQb, getQb } from '../../lib/kysely';
import { normalizeAdapterType } from '../knowledge_pipeline/output_v3/linked_objects';

export interface MaterialisedSourceNode {
  nodeId: NodeId;
  created: boolean;
}

export interface MaterialiseInput {
  teamId: TeamId;
  pipelineInputId: PipelineInputId;
  adapterType: string;
  externalId: string;
  externalRecordType?: string;
  data?: Record<string, unknown>;
}

export async function materialiseInboundSourceAsKgNode(
  input: MaterialiseInput,
): Promise<MaterialisedSourceNode | undefined> {
  const adapter = normalizeAdapterType(input.adapterType);

  const existing = await getKnowledgeQb(['linked_object'])
    .selectFrom('linked_object')
    .where('team_id', '=', input.teamId)
    .where('adapter_type', '=', adapter)
    .where('external_id', '=', input.externalId)
    .select(['node_id'])
    .executeTakeFirst();
  if (existing) {
    return { nodeId: existing.node_id as NodeId, created: false };
  }

  const messageType = await getQb(['pipeline_input_message_type'])
    .selectFrom('pipeline_input_message_type')
    .where('pipeline_input_id', '=', input.pipelineInputId)
    .select(['node_type_id'])
    .executeTakeFirst();
  if (!messageType) {
    logger.info(
      '[WebhookBridge] no pipeline_input_message_type configured; engine runs without an anchor',
      {
        pipelineInputId: input.pipelineInputId,
        adapterType: adapter,
        externalId: input.externalId,
      },
    );
    return undefined;
  }

  const qb = getKnowledgeQb(['node', 'linked_object']);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await qb.transaction().execute(async (trx: any) => {
    const node = await trx
      .insertInto('node')
      .values({
        team_id: input.teamId,
        node_type_id: messageType.node_type_id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const nodeId = node.id as NodeId;

    await trx
      .insertInto('linked_object')
      .values({
        team_id: input.teamId,
        node_id: nodeId,
        adapter_type: adapter,
        external_id: input.externalId,
        source: 'input',
        external_object_type: input.externalRecordType ?? null,
        data: input.data ?? {},
        fetched_at: new Date(),
      })
      .onConflict((oc: any) => oc.doNothing())
      .execute();

    return nodeId;
  });

  return { nodeId: result, created: true };
}
