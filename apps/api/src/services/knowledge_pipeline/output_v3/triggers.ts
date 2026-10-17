import type { OutputExecutionContext } from './resolve';
import type { Changeset, ApplyResult } from '../types';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../../generated/kysely/knowledge/NodeType';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { PipelineConfigurationId } from '../../../generated/kysely/public/PipelineConfiguration';
import type { SystemContext } from '../extract';

import { outputV3ConfigSchema } from 'movement-engine/public/output-v3';
import { initializeV3Adapter } from './adapters';
import { evaluateFilter } from './filter';
import { executeOutputs } from './execute';
import { logger } from 'movement-engine/public/log';
import { getQb } from '../../../lib/kysely';

// -- Extraction trigger --

async function onExtractionComplete(options: {
  changeset: Changeset;
  result: ApplyResult;
  teamId: TeamId;
  pipelineConfigurationId: PipelineConfigurationId;
  dryRun?: boolean;
}): Promise<void> {
  const { changeset, result, teamId, pipelineConfigurationId } = options;
  const messageNodeTypeId = changeset.messageNode.nodeType;

  // Load v3 outputs (trigger info is embedded in config, parsed via outputV3ConfigSchema)
  const outputs = await getQb(['pipeline_output'])
    .selectFrom('pipeline_output')
    .where('pipeline_output.pipeline_configuration_id', '=', pipelineConfigurationId)
    .where('pipeline_output.config_version', '=', 3)
    .where('pipeline_output.deleted_at', 'is', null)
    .where('pipeline_output.run_mode', 'in', ['live', 'dry_run'])
    .select([
      'pipeline_output.id',
      'pipeline_output.type',
      'pipeline_output.config',
      'pipeline_output.credentials_id',
      'pipeline_output.run_mode',
    ])
    .orderBy('pipeline_output.position', 'asc')
    .execute();

  logger.info('[V3Triggers] onExtractionComplete', {
    pipelineConfigurationId,
    messageNodeTypeId,
    outputCount: outputs.length,
  });

  if (!outputs.length) return;

  // Build old properties map from the changeset
  const oldPropertiesByNodeId = buildOldPropertiesMap(changeset, result);

  // Resolve the message node's real ID
  const messageNodeId = result.tempToRealId.get(changeset.messageNode.tempId);
  if (!messageNodeId) {
    logger.warn('V3 extraction trigger: could not resolve message node ID');
    return;
  }

  for (const output of outputs) {
    try {
      const parsed = outputV3ConfigSchema.safeParse(output.config);
      if (!parsed.success) {
        logger.warn(`V3 output ${output.id}: invalid config`, parsed.error);
        continue;
      }

      const config = parsed.data;

      // Check trigger type matches
      if (config.trigger.type !== 'extraction') {
        logger.info(`[V3Triggers] output ${output.id}: trigger type is ${config.trigger.type}, not extraction — skipping`);
        continue;
      }
      if (config.trigger.messageNodeTypeId !== (messageNodeTypeId as string)) {
        logger.info(`[V3Triggers] output ${output.id}: messageNodeTypeId mismatch — trigger wants ${config.trigger.messageNodeTypeId}, got ${messageNodeTypeId}`);
        continue;
      }

      logger.info(`[V3Triggers] output ${output.id}: trigger matched, executing`);

      const adapter = await initializeV3Adapter({
        id: output.id,
        type: output.type,
        config: output.config,
        credentials_id: output.credentials_id,
      });
      if (!adapter) continue;

      const isDryRun = output.run_mode === 'dry_run' || options.dryRun;
      const context: OutputExecutionContext = {
        rootNodeId: messageNodeId,
        teamId,
        pipelineOutputId: output.id,
        changeset,
        tempToRealId: result.tempToRealId,
        oldProperties: oldPropertiesByNodeId,
        meta: null,
        dryRun: isDryRun,
      };

      await executeOutputs(config, adapter, context);
    } catch (err) {
      logger.error(`V3 extraction output ${output.id} failed:`, err);
      // Abort on non-recoverable error — per design, the whole output execution should abort
      throw err;
    }
  }
}

// -- Mutation trigger --

interface MutationInfo {
  nodeId: NodeId;
  nodeTypeId: NodeTypeId;
  oldProperties: Record<string, unknown>;
  newProperties: Record<string, unknown>;
  source: string;
}

async function onNodesMutated(options: {
  mutations: MutationInfo[];
  teamId: TeamId;
}): Promise<void> {
  const { mutations, teamId } = options;
  if (!mutations.length) return;

  // Get all node type IDs involved
  const nodeTypeIds = [...new Set(mutations.map((m) => m.nodeTypeId as string))];

  // Load v3 outputs with mutation triggers, scoped to this team
  const outputs = await getQb(['pipeline_output', 'pipeline_configuration'])
    .selectFrom('pipeline_output')
    .innerJoin('pipeline_configuration', 'pipeline_configuration.id', 'pipeline_output.pipeline_configuration_id')
    .where('pipeline_configuration.team_id', '=', teamId)
    .where('pipeline_output.config_version', '=', 3)
    .where('pipeline_output.deleted_at', 'is', null)
    .where('pipeline_output.run_mode', 'in', ['live', 'dry_run'])
    .select([
      'pipeline_output.id',
      'pipeline_output.type',
      'pipeline_output.config',
      'pipeline_output.credentials_id',
      'pipeline_output.run_mode',
    ])
    .orderBy('pipeline_output.position', 'asc')
    .execute();

  if (!outputs.length) return;

  // Build old properties map keyed by nodeId
  const oldPropertiesByNodeId = new Map<string, Record<string, unknown>>();
  for (const m of mutations) {
    oldPropertiesByNodeId.set(m.nodeId as string, m.oldProperties);
  }

  for (const output of outputs) {
    try {
      const parsed = outputV3ConfigSchema.safeParse(output.config);
      if (!parsed.success) continue;

      const config = parsed.data;
      if (config.trigger.type !== 'mutation') continue;
      const trigger = config.trigger;

      // Find matching mutations for this trigger's node type
      const matchingMutations = mutations.filter(
        (m) => (m.nodeTypeId as string) === trigger.nodeTypeId,
      );
      if (!matchingMutations.length) continue;

      const adapter = await initializeV3Adapter({
        id: output.id,
        type: output.type,
        config: output.config,
        credentials_id: output.credentials_id,
      });
      if (!adapter) continue;

      for (const mutation of matchingMutations) {
        const context: OutputExecutionContext = {
          rootNodeId: mutation.nodeId,
          teamId,
          pipelineOutputId: output.id,
          changeset: null,
          tempToRealId: null,
          oldProperties: oldPropertiesByNodeId,
          meta: { source: mutation.source },
            dryRun: output.run_mode === 'dry_run',
        };

        // Evaluate trigger filter if present
        if (trigger.filter) {
          if (!(await evaluateFilter(trigger.filter, mutation.nodeId, context))) continue;
        }

        await executeOutputs(config, adapter, context);
      }
    } catch (err) {
      logger.error(`V3 mutation output ${output.id} failed:`, err);
      throw err;
    }
  }
}

// -- Helpers --

function buildOldPropertiesMap(
  changeset: Changeset,
  result: ApplyResult,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();

  // For matched (existing) nodes, we can get their old property values from the changeset
  // The changeset's property resolution decisions tell us which properties were matched
  for (const node of changeset.nodes) {
    if (node.resolution.action === 'match') {
      const realId = result.tempToRealId.get(node.tempId);
      if (realId && result.propertiesUpdated.has(realId)) {
        // Old values were the matched property values — but we don't have them in the changeset.
        // For now, old properties for extraction triggers are empty.
        // The mutation wrapper (Phase 6) will provide proper snapshots.
        map.set(realId as string, {});
      }
    }
  }

  return map;
}

// -- Single output execution (called from output.ts per-output loop) --

async function executeExtractionOutput(options: {
  output: { id: string; type: string; config: unknown; credentials_id: string | null };
  changeset: Changeset;
  result: ApplyResult;
  teamId: TeamId;
  systemContext?: SystemContext;
  dryRun?: boolean;
}): Promise<void> {
  const { output, changeset, result, teamId, systemContext, dryRun } = options;
  const messageNodeTypeId = changeset.messageNode.nodeType;

  const parsed = outputV3ConfigSchema.safeParse(output.config);
  if (!parsed.success) {
    logger.warn(`V3 output ${output.id}: invalid config`, parsed.error);
    return;
  }

  const config = parsed.data;

  if (config.trigger.type !== 'extraction') {
    logger.info(`[V3Triggers] output ${output.id}: trigger type is ${config.trigger.type}, not extraction — skipping`);
    return;
  }
  if (config.trigger.messageNodeTypeId !== (messageNodeTypeId as string)) {
    logger.info(`[V3Triggers] output ${output.id}: messageNodeTypeId mismatch — trigger wants ${config.trigger.messageNodeTypeId}, got ${messageNodeTypeId}`);
    return;
  }

  const messageNodeId = result.tempToRealId.get(changeset.messageNode.tempId);
  if (!messageNodeId) {
    logger.warn('V3 extraction trigger: could not resolve message node ID');
    return;
  }

  logger.info(`[V3Triggers] output ${output.id}: trigger matched, executing`);

  const adapter = await initializeV3Adapter({
    id: output.id,
    type: output.type,
    config: output.config,
    credentials_id: output.credentials_id,
  });
  if (!adapter) {
    logger.warn(`[V3Triggers] output ${output.id}: adapter initialization returned null — skipping`);
    return;
  }

  logger.info(`[V3Triggers] output ${output.id}: adapter initialized (${output.type}), proceeding to execute`);

  const oldPropertiesByNodeId = buildOldPropertiesMap(changeset, result);

  const context: OutputExecutionContext = {
    rootNodeId: messageNodeId,
    teamId,
    pipelineOutputId: output.id,
    changeset,
    tempToRealId: result.tempToRealId,
    oldProperties: oldPropertiesByNodeId,
    meta: null,
    systemContext,
    dryRun,
  };

  await executeOutputs(config, adapter, context);
}

export { onExtractionComplete, onNodesMutated, executeExtractionOutput };
export type { MutationInfo };
