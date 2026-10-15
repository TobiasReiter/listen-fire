import { randomUUID } from 'node:crypto';

import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { NodeRelationship } from '../../../adapters/pipeline/outbound/configSchema';
import type { OutputExecutionContext, ResolvedEdge } from './resolve';
import type { OutputV3Config, ActionNode, BranchNode, TreeNode, ResourceStep, FieldMapping } from 'movement-engine/services/knowledge_pipeline/output_v3/schemas';
import type { V3Adapter, AdapterResult, FieldConstraints, ResourceContext } from './adapters/types';

import { logger } from 'movement-engine/services/logger';
import { evaluateFilter } from './filter';
import { resolveFieldMapping, traverseForContext, traverseWithEdges, findLinkBackNodeIds, loadResources, documentPublicUrl, resolvePromptEmbeds, interpolatePromptEmbeds, insertPreserveTags, resolvePreserveTags } from './resolve';
import LinkedObjectSource from '../../../generated/kysely/knowledge/LinkedObjectSource';
import { storeLinkedObject, loadLinkedObjects, deleteLinkedObject, updateLinkedObjectExternalId, storeOutputRun } from './linked_objects';
import { StaleLinkedObjectError, MergedEntityError } from './adapters/types';
import { wrapAdapterForDryRun } from './adapters/dry_run';

async function collectDocumentLinks(
  contextNodeId: NodeId,
  context: OutputExecutionContext,
): Promise<Array<{ name: string; url: string }>> {
  const resources = await loadResources(contextNodeId, context, { hasDocument: true });
  return resources.flatMap((r) =>
    r.documentId ? [{ name: r.name, url: documentPublicUrl(r.documentId) }] : [],
  );
}

function coerceFieldValue(value: unknown, dataType: FieldMapping['dataType']): unknown {
  if (value == null || !dataType || dataType === 'documents') return value;

  if (dataType === 'number') {
    if (typeof value === 'number') return value;
    const num = Number(value);
    return isNaN(num) ? null : num;
  }
  if (dataType === 'boolean') {
    if (typeof value === 'boolean') return value;
    const str = String(value).trim().toLowerCase();
    if (str === 'true' || str === '1' || str === 'yes') return true;
    if (str === 'false' || str === '0' || str === 'no' || str === '') return false;
    return null;
  }
  if (dataType === 'json') {
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed || trimmed === 'null') return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
    return value;
  }
  // dataType === 'string'
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    // Extract a meaningful string from objects rather than "[object Object]"
    const obj = value as Record<string, unknown>;
    if (typeof obj.name === 'string') return obj.name;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.id === 'string') return obj.id;
    // Array — join string elements
    if (Array.isArray(value)) {
      const strings = value.map((v) =>
        typeof v === 'string' ? v
          : typeof v === 'object' && v !== null ? (v as Record<string, unknown>).name ?? (v as Record<string, unknown>).value ?? (v as Record<string, unknown>).id ?? JSON.stringify(v)
          : String(v),
      );
      return strings.join(', ');
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function remapFieldNames(
  fieldValues: Record<string, unknown>,
  constraints: Map<string, FieldConstraints>,
): Record<string, unknown> {
  if (constraints.size === 0) return fieldValues;
  const remapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fieldValues)) {
    const displayName = constraints.get(key)?.displayName;
    remapped[displayName ?? key] = value;
  }
  return remapped;
}

async function executeOutputs(
  config: OutputV3Config,
  adapter: V3Adapter,
  context: OutputExecutionContext,
): Promise<void> {
  const runGroupId = randomUUID();
  const effectiveAdapter = context.dryRun ? wrapAdapterForDryRun(adapter) : adapter;
  logger.info(`[V3Execute] executeOutputs: ${config.actionTree.roots.length} root(s), rootNodeId=${context.rootNodeId}, runGroupId=${runGroupId}, dryRun=${!!context.dryRun}`);
  for (const root of config.actionTree.roots) {
    const kind = root.kind;
    const type = kind === 'action' ? root.type : 'branch';
    logger.info(`[V3Execute] executing root: kind=${kind} type=${type}`);
    await executeTreeNode(root, context.rootNodeId, null, null, effectiveAdapter, context, runGroupId);
  }
}

async function executeTreeNode(
  treeNode: TreeNode,
  contextNodeId: NodeId,
  parentResult: AdapterResult | null,
  relationship: NodeRelationship | null,
  adapter: V3Adapter,
  context: OutputExecutionContext,
  runGroupId: string,
): Promise<void> {
  if (treeNode.kind === 'branch') {
    await executeBranch(treeNode, contextNodeId, parentResult, adapter, context, runGroupId);
  } else {
    await executeAction(treeNode, contextNodeId, parentResult, relationship, adapter, context, runGroupId);
  }
}

// Upload-style action types that operate per-resource. When the user hasn't
// added an explicit resource step, fan out over the context node's attached
// resources automatically — a resource step here is purely UI ceremony,
// node_resource already gives a direct edge.
const AUTO_LOAD_RESOURCE_ACTION_TYPES = new Set([
  'affinity:file',
  'attio:upload',
  'gdrive:upload',
  'dropbox:upload',
]);

// resource step splitting
function splitResourceStep(traversal: ActionNode['traversal']): {
  edgeSteps: ActionNode['traversal'];
  resourceStep: ResourceStep | null;
} {
  if (traversal.length === 0) return { edgeSteps: [], resourceStep: null };

  const last = traversal[traversal.length - 1];
  if (last.type === 'resource') {
    return {
      edgeSteps: traversal.slice(0, -1),
      resourceStep: last,
    };
  }
  return { edgeSteps: traversal, resourceStep: null };
}

// prompt embed interpolation
function interpolateAdapterConfig(
  config: Record<string, unknown>,
  embedValues: Map<number, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    result[key] = typeof value === 'string' ? interpolatePromptEmbeds(value, embedValues) : value;
  }
  return result;
}

function insertPreserveTagsInConfig(
  config: Record<string, unknown>,
  embedKeys: Set<number>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    result[key] = typeof value === 'string' ? insertPreserveTags(value, embedKeys) : value;
  }
  return result;
}

// ── Webhook payload composition ──
// Webhook children represent JSON nesting, not separate API calls.
// Recursively resolve child nodes and compose into the parent's payload.

function isWebhookType(type: string): boolean {
  return type === 'webhook:object' || type === 'webhook:array';
}

async function resolveWebhookFieldValues(
  actionNode: ActionNode,
  contextNodeId: NodeId,
  context: OutputExecutionContext,
): Promise<Record<string, unknown>> {
  const fieldValues: Record<string, unknown> = {};
  for (const mapping of actionNode.fieldMappings) {
    if (mapping.dataType === 'documents') {
      fieldValues[mapping.targetField as string] = await collectDocumentLinks(contextNodeId, context);
      continue;
    }
    const resolved = await resolveFieldMapping(mapping, contextNodeId, context);
    fieldValues[mapping.targetField as string] = coerceFieldValue(resolved, mapping.dataType);
  }

  // Recursively compose webhook children into this node's payload
  for (const child of actionNode.children) {
    if (child.node.kind !== 'action' || !isWebhookType(child.node.type)) continue;
    const childNode = child.node;
    const key = (childNode.adapterConfig.key as string) ?? '';
    if (!key) continue;

    if (childNode.type === 'webhook:array') {
      // Array: traverse to get context nodes, resolve each as an array item
      const { edgeSteps } = splitResourceStep(childNode.traversal);
      const itemNodeIds = edgeSteps.length > 0
        ? await traverseForContext(edgeSteps, contextNodeId, context)
        : [contextNodeId];

      const items: Record<string, unknown>[] = [];
      for (const itemNodeId of itemNodeIds) {
        items.push(await resolveWebhookFieldValues(childNode, itemNodeId, context));
      }
      fieldValues[key] = items;
    } else {
      // Nested object: resolve at the same context (or traversed context)
      const { edgeSteps } = splitResourceStep(childNode.traversal);
      const childContextIds = edgeSteps.length > 0
        ? await traverseForContext(edgeSteps, contextNodeId, context)
        : [contextNodeId];

      if (childContextIds.length > 0) {
        fieldValues[key] = await resolveWebhookFieldValues(childNode, childContextIds[0], context);
      }
    }
  }

  return fieldValues;
}

// ── Action execution ──

async function executeAction(
  actionNode: ActionNode,
  invokerContextNodeId: NodeId,
  parentResult: AdapterResult | null,
  relationship: NodeRelationship | null,
  adapter: V3Adapter,
  context: OutputExecutionContext,
  runGroupId: string,
): Promise<void> {
  // 0. Split traversal: separate resource step (must be last) from edge/linkBack steps
  const { edgeSteps, resourceStep } = splitResourceStep(actionNode.traversal);

  let contextNodeIds: NodeId[];
  let actionEdges: ResolvedEdge[] = [];
  let effectiveContext = context;
  if (edgeSteps.length > 0) {
    const traversalResult = await traverseWithEdges(edgeSteps, invokerContextNodeId, context);
    contextNodeIds = traversalResult.nodeIds;
    actionEdges = traversalResult.lastEdges;
    // After linkBack, field resolution and children operate against the permanent graph
    if (traversalResult.linkedBack) {
      effectiveContext = { ...context, changeset: null, tempToRealId: null };
    }
  } else {
    contextNodeIds = [invokerContextNodeId];
  }

  if (contextNodeIds.length === 0) {
    logger.warn(`[V3Execute] action ${actionNode.id} (${actionNode.type}): traversal returned 0 context nodes from parent ${invokerContextNodeId}`, {
      traversal: actionNode.traversal,
    });
    return;
  }

  // 0b. Fetch field constraints from the adapter (e.g. valid select options)
  const fieldConstraints: Map<string, FieldConstraints> = adapter.getFieldConstraints
    ? await adapter.getFieldConstraints(actionNode)
    : new Map();

  // Build execution targets: (nodeId, resource | null) pairs
  const targets: { nodeId: NodeId; resource: ResourceContext | null }[] = [];

  if (resourceStep) {
    for (const nodeId of contextNodeIds) {
      const resources = await loadResources(nodeId, effectiveContext, resourceStep.filter);
      if (resources.length === 0) {
        logger.info(`[V3Execute] action ${actionNode.id}: no resources matched filter for node ${nodeId}`);
      }
      for (const resource of resources) {
        targets.push({ nodeId, resource });
      }
    }

    logger.info(`[V3Execute] action ${actionNode.id} (${actionNode.type}): ${targets.length} resource(s) from ${contextNodeIds.length} node(s)`);
  } else if (AUTO_LOAD_RESOURCE_ACTION_TYPES.has(actionNode.type)) {
    for (const nodeId of contextNodeIds) {
      const resources = await loadResources(nodeId, effectiveContext, { hasDocument: true });
      if (resources.length === 0) {
        logger.info(`[V3Execute] action ${actionNode.id} (${actionNode.type}): no resources on node ${nodeId}`);
      }
      for (const resource of resources) {
        targets.push({ nodeId, resource });
      }
    }
    logger.info(`[V3Execute] action ${actionNode.id} (${actionNode.type}): auto-loaded ${targets.length} resource(s) from ${contextNodeIds.length} node(s)`);
  } else {
    for (const nodeId of contextNodeIds) {
      targets.push({ nodeId, resource: null });
    }
    logger.info(`[V3Execute] action ${actionNode.id} (${actionNode.type}): ${contextNodeIds.length} context node(s) from traversal`);
  }

  for (const { nodeId: contextNodeId, resource } of targets) {
    // 1. Resolve all field values
    const fieldValues: Record<string, unknown> = {};
    for (const mapping of actionNode.fieldMappings) {
      if (mapping.dataType === 'documents') {
        fieldValues[mapping.targetField as string] = await collectDocumentLinks(contextNodeId, effectiveContext);
        continue;
      }
      const constraints = fieldConstraints.get(mapping.targetField as string);
      const hasExpr = !!mapping.expression;
      logger.info(`[V3Execute] resolving field "${mapping.targetField}": mode=${hasExpr ? 'expression' : 'legacy'}, contextNodeId=${contextNodeId}`, {
        expression: hasExpr ? JSON.stringify(mapping.expression).slice(0, 300) : undefined,
        selection: !hasExpr ? JSON.stringify(mapping.selection) : undefined,
        constraints: constraints ? JSON.stringify(constraints).slice(0, 200) : undefined,
      });
      const resolved = await resolveFieldMapping(mapping, contextNodeId, effectiveContext, constraints, actionEdges);
      const coerced = coerceFieldValue(resolved, mapping.dataType);
      logger.info(`[V3Execute] field "${mapping.targetField}" resolved=${resolved == null ? 'NULL' : JSON.stringify(resolved).slice(0, 200)} → coerced=${coerced == null ? 'NULL' : JSON.stringify(coerced).slice(0, 200)}`);
      fieldValues[mapping.targetField as string] = coerced;
    }

    // 1a. For webhook nodes, compose child data into this payload instead of dispatching children separately
    const hasWebhookChildren = isWebhookType(actionNode.type) &&
      actionNode.children.some((c) => c.node.kind === 'action' && isWebhookType(c.node.type));

    if (hasWebhookChildren) {
      for (const child of actionNode.children) {
        if (child.node.kind !== 'action' || !isWebhookType(child.node.type)) continue;
        const childNode = child.node;
        const key = (childNode.adapterConfig.key as string) ?? '';
        if (!key) continue;

        if (childNode.type === 'webhook:array') {
          const { edgeSteps: childEdgeSteps } = splitResourceStep(childNode.traversal);
          const itemNodeIds = childEdgeSteps.length > 0
            ? await traverseForContext(childEdgeSteps, contextNodeId, effectiveContext)
            : [contextNodeId];

          const items: Record<string, unknown>[] = [];
          for (const itemNodeId of itemNodeIds) {
            items.push(await resolveWebhookFieldValues(childNode, itemNodeId, effectiveContext));
          }
          fieldValues[key] = items;
        } else {
          const { edgeSteps: childEdgeSteps } = splitResourceStep(childNode.traversal);
          const childContextIds = childEdgeSteps.length > 0
            ? await traverseForContext(childEdgeSteps, contextNodeId, effectiveContext)
            : [contextNodeId];

          if (childContextIds.length > 0) {
            fieldValues[key] = await resolveWebhookFieldValues(childNode, childContextIds[0], effectiveContext);
          }
        }
      }
    }

    // 1b. Resolve prompt embeds — split by timing (before = LLM sees value, after = post-LLM interpolation)
    let resolvedAdapterConfig = actionNode.adapterConfig;
    let afterEmbedValues: Map<number, string> | undefined;
    if (actionNode.embeds?.length) {
      const allValues = await resolvePromptEmbeds(actionNode.embeds, contextNodeId, effectiveContext);

      for (let i = 0; i < actionNode.embeds.length; i++) {
        const embed = actionNode.embeds[i];
        const val = allValues.get(i + 1);
        const sel = embed.selection ?? embed.expression;
        logger.info(`[V3Execute] action ${actionNode.id} embed $\{${i + 1}\}: resolved=${val != null ? JSON.stringify(val) : 'NULL'}, timing=${embed.timing}, selection=${JSON.stringify(sel)}`);
      }

      const beforeValues = new Map<number, string>();
      const afterValues = new Map<number, string>();
      for (let i = 0; i < actionNode.embeds.length; i++) {
        const val = allValues.get(i + 1);
        if (val == null) continue;
        if (actionNode.embeds[i].timing === 'before') {
          beforeValues.set(i + 1, val);
        } else {
          afterValues.set(i + 1, val);
        }
      }

      if (beforeValues.size > 0) {
        resolvedAdapterConfig = interpolateAdapterConfig(actionNode.adapterConfig, beforeValues);
      }
      if (afterValues.size > 0) {
        afterEmbedValues = afterValues;
        // Replace ${N} with <llm-preserve-tag:N> for "after" embeds so the LLM
        // sees an opaque tag instead of a tempting interpolation placeholder
        const afterKeys = new Set(afterValues.keys());
        resolvedAdapterConfig = insertPreserveTagsInConfig(resolvedAdapterConfig, afterKeys);
      }
    }

    const [rawAdapterType] = actionNode.type.split(':');
    const adapterType = rawAdapterType.toUpperCase();

    // 2. Load existing linked objects for Tier 0 dedup
    //    Skip when storeLink is explicitly false — the user has opted out of linking
    //    If linkTraversal is set, load from the traversed node instead of the context node
    const resolvedContextId = (context.tempToRealId?.get(contextNodeId as string) as NodeId) ?? contextNodeId;
    const shouldLoadLinks = actionNode.storeLink !== false;
    let linkNodeId = resolvedContextId;
    let existingLinkedObjects: Awaited<ReturnType<typeof loadLinkedObjects>> = [];
    if (shouldLoadLinks) {
      if (actionNode.linkTraversal?.length) {
        const linkNodeIds = await traverseForContext(actionNode.linkTraversal, contextNodeId, context);
        if (linkNodeIds.length > 0) {
          linkNodeId = linkNodeIds[0];
        }
      }
      existingLinkedObjects = await loadLinkedObjects(linkNodeId, context.teamId, {
        adapterType,
      });
    }
    const linkedObjectRefs = existingLinkedObjects.map((lo) => ({
      externalId: lo.external_id,
      externalObjectType: lo.external_object_type,
      data: (lo.data ?? {}) as Record<string, unknown>,
    }));

    // 3. Call the adapter (with stale linked object recovery)
    //    In dry-run mode: read-mode actions execute normally, write-mode actions are skipped.
    const isReadOnly = actionNode.mode === 'read';
    const adapterInput = {
      type: actionNode.type,
      readOnly: isReadOnly,
      adapterConfig: resolvedAdapterConfig,
      fieldValues,
      fieldMappings: actionNode.fieldMappings,
      parentResult,
      relationship,
      contextNodeId,
      context: effectiveContext,
      linkedObjects: linkedObjectRefs,
      resource,
      afterEmbedValues,
    };

    let result: AdapterResult;
    try {
      result = await adapter.execute(adapterInput);
    } catch (err) {
      if (err instanceof MergedEntityError && existingLinkedObjects.length > 0) {
        logger.info(`[V3Execute] Merged entity detected (${err.oldExternalId} → ${err.newExternalId}), updating linked object and retrying`);
        if (!context.dryRun) {
          for (const lo of existingLinkedObjects) {
            await updateLinkedObjectExternalId(lo.id, context.teamId, err.newExternalId);
          }
        }
        const updatedRefs = linkedObjectRefs.map((ref) =>
          ref.externalId === err.oldExternalId
            ? { ...ref, externalId: err.newExternalId }
            : ref,
        );
        result = await adapter.execute({ ...adapterInput, linkedObjects: updatedRefs });
      } else if (err instanceof StaleLinkedObjectError && existingLinkedObjects.length > 0) {
        logger.info(`[V3Execute] Stale linked object detected (${err.externalId}), removing and retrying`);
        if (!context.dryRun) {
          for (const lo of existingLinkedObjects) {
            await deleteLinkedObject(lo.id, context.teamId);
          }
        }
        result = await adapter.execute({ ...adapterInput, linkedObjects: [] });
      } else {
        throw err;
      }
    }

    // 4. Handle skips
    // Use resolvedContextId (temp→real mapped) so dry-run reruns still record the real node
    const storedContextNodeId = resolvedContextId;

    if (result.skipped) {
      logger.info(`[V3Execute] action ${actionNode.id} (${actionNode.type}): SKIPPED — ${result.skipReason}`);
      const skippedFieldValues = remapFieldNames(fieldValues, fieldConstraints);
      const skippedStoredValues = result.displayValues
        ? { ...skippedFieldValues, ...result.displayValues }
        : skippedFieldValues;
      await storeOutputRun({
        teamId: context.teamId,
        pipelineOutputId: context.pipelineOutputId,
        actionNodeId: actionNode.id,
        contextNodeId: storedContextNodeId,
        adapterType,
        externalId: null,
        status: 'skipped',
        error: result.skipReason,
        fieldValues: skippedStoredValues,
        runGroupId,
        rootNodeId: context.rootNodeId,
      });
      continue;
    }

    // 5. Log the run
    logger.info(`[V3Execute] action ${actionNode.id} (${actionNode.type}): SUCCESS externalId=${result.externalId} created=${result.created}`);
    const displayFieldValues = remapFieldNames(fieldValues, fieldConstraints);
    const storedFieldValues = result.displayValues
      ? { ...displayFieldValues, ...result.displayValues }
      : displayFieldValues;
    await storeOutputRun({
      teamId: context.teamId,
      pipelineOutputId: context.pipelineOutputId,
      actionNodeId: actionNode.id,
      contextNodeId: storedContextNodeId,
      adapterType,
      externalId: result.externalId ?? null,
      externalObjectType: result.externalObjectType,
      status: 'success',
      fieldValues: storedFieldValues,
      runGroupId,
      created: result.created,
      rootNodeId: context.rootNodeId,
    });

    // 6. Store linked object — at linkTraversal target, linkBack pivot, or context node
    //    Respect storeLink config: explicit true/false wins, otherwise default by adapter type
    //    Skip in dry-run mode.
    const shouldStore = !context.dryRun && (actionNode.storeLink ?? defaultStoreLink(actionNode.type));
    if (shouldStore && result.externalId) {
      let targetNodeIds: NodeId[];
      if (actionNode.linkTraversal?.length) {
        targetNodeIds = [linkNodeId];
      } else {
        const linkBackNodeIds = await findLinkBackNodeIds(actionNode.traversal, invokerContextNodeId, context);
        targetNodeIds = linkBackNodeIds ?? [resolvedContextId];
      }
      for (const linkNodeId of targetNodeIds) {
        await storeLinkedObject({
          nodeId: linkNodeId,
          teamId: context.teamId,
          source: LinkedObjectSource.output,
          adapterType,
          externalId: result.externalId,
          externalObjectType: result.externalObjectType,
          data: result.data,
          outputId: context.pipelineOutputId,
          actionNodeId: actionNode.id,
        });
      }
    }

    // 7. Execute non-webhook children (webhook children were already composed into fieldValues)
    for (const child of actionNode.children) {
      if (hasWebhookChildren && child.node.kind === 'action' && isWebhookType(child.node.type)) continue;
      await executeTreeNode(child.node, contextNodeId, result, child.relationship, adapter, effectiveContext, runGroupId);
    }
  }
}

async function executeBranch(
  branchNode: BranchNode,
  contextNodeId: NodeId,
  parentResult: AdapterResult | null,
  adapter: V3Adapter,
  context: OutputExecutionContext,
  runGroupId: string,
): Promise<void> {
  const branchContext = { ...context, parentResult };
  const passes = await evaluateFilter(branchNode.filter, contextNodeId, branchContext);

  if (passes && branchNode.match) {
    await executeTreeNode(branchNode.match, contextNodeId, parentResult, null, adapter, context, runGroupId);
  } else if (!passes && branchNode.noMatch) {
    await executeTreeNode(branchNode.noMatch, contextNodeId, parentResult, null, adapter, context, runGroupId);
  }
}

// configurable storeLink
const LINK_STORING_ACTION_TYPES = new Set(['attio:object', 'attio:list-entry', 'affinity:organization', 'affinity:person', 'affinity:list-entry', 'gdrive:folder', 'gdrive:document', 'airtable:record']);
function defaultStoreLink(actionType: string): boolean {
  return LINK_STORING_ACTION_TYPES.has(actionType);
}

export { executeOutputs };
