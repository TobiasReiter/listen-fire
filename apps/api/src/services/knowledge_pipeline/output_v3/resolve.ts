import { z } from 'zod';

import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { EdgeId } from '../../../generated/kysely/knowledge/Edge';
import type { EdgeTypeId } from '../../../generated/kysely/knowledge/EdgeType';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ResourceId } from '../../../generated/kysely/knowledge/Resource';
import type { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';
import type { Changeset } from '../types';
import type {
  FieldMapping,
  TraversalStep,
  EdgeStep,
  ResourceStep,
  ResourceFilter,
  Selection,
  Aggregation,
  FieldRef,
  OrderKey,
  PromptEmbed,
  FilterExpression,
} from 'movement-engine/services/knowledge_pipeline/output_v3/schemas';
import type { FieldConstraints, ResourceContext, AdapterResult } from './adapters/types';
import type { NodeData } from './filter';
import type { SystemContext } from '../extract';

import { resolveFieldRef, evaluateFilter } from './filter';
import { loadLinkedObjects } from './linked_objects';
import ResourceType from '../../../generated/kysely/knowledge/ResourceType';
import { signDocumentUrl } from '../../../lib/document_link';
import { logger } from 'movement-engine/services/logger';
import { anthropicChat, anthropicChatStructured } from '../../../lib/anthropic';
import { HAIKU_MODEL } from '../../agent_running_state';
import { getKnowledgeQb, getQb } from '../../../lib/kysely';
import { evaluateExpression } from './evaluate';
import { fieldMappingToExpression } from 'movement-engine/services/knowledge_pipeline/output_v3/expression';

// -- Execution context --

interface OutputExecutionContext {
  rootNodeId: NodeId;
  teamId: TeamId;
  pipelineOutputId: string;
  changeset: Changeset | null;
  tempToRealId: Map<string, NodeId> | null;
  oldProperties: Map<string, Record<string, unknown>> | null;
  meta: Record<string, unknown> | null;
  systemContext?: SystemContext;
  parentResult?: AdapterResult | null;
  dryRun?: boolean;
  /** Per-evaluation cache for kg_exists/kg_value results. */
  kgQueryCache?: Map<string, unknown>;
}

// -- Edge representation --

interface ResolvedEdge {
  id: EdgeId | null;
  sourceNodeId: NodeId;
  targetNodeId: NodeId;
  edgeTypeId: string;
}

// -- Meta key resolution --
// Reads from systemContext (well-known keys) first, then falls back to context.meta

const SYSTEM_CONTEXT_KEYS: Record<string, (ctx: SystemContext) => unknown> = {
  user_name: (ctx) => ctx.userName ?? null,
  user_email: (ctx) => ctx.userEmail ?? null,
  current_date: (ctx) => ctx.currentDate ?? null,
  input_channel_name: (ctx) => ctx.inputChannelName ?? null,
};

function resolveMetaKey(key: string, context: OutputExecutionContext): unknown {
  if (context.systemContext) {
    const resolver = SYSTEM_CONTEXT_KEYS[key];
    if (resolver) return resolver(context.systemContext);
  }
  return context.meta?.[key] ?? null;
}

// -- Core pipeline --

async function resolveFieldMapping(
  mapping: FieldMapping,
  contextNodeId: NodeId,
  context: OutputExecutionContext,
  constraints?: FieldConstraints,
  contextEdges?: ResolvedEdge[],
): Promise<unknown> {
  // Expression-based path: evaluate the expression tree directly
  if (mapping.expression) {
    logger.info(`[V3Resolve] expression path: type=${mapping.expression.type}, contextNodeId=${contextNodeId}, lastEdges=${(contextEdges ?? []).length}`);
    const result = await evaluateExpression(mapping.expression, {
      nodeIds: [contextNodeId],
      lastEdges: contextEdges ?? [],
      exec: context,
      constraints,
    });
    logger.info(`[V3Resolve] expression result: ${result == null ? 'NULL' : JSON.stringify(result).slice(0, 200)}`);
    return result;
  }

  // Legacy path: traversal → selection → aggregation
  if (!mapping.selection) {
    logger.warn('[V3Resolve] field mapping has neither expression nor selection');
    return null;
  }

  // Stage 1: Traversal
  let nodeIds: NodeId[] = [contextNodeId];
  let lastEdges: ResolvedEdge[] = [];
  let effectiveContext = context;

  for (const step of mapping.traversal) {
    if (step.type === 'linkBack') {
      nodeIds = resolveTempToReal(nodeIds, context);
      lastEdges = [];
      effectiveContext = { ...context, changeset: null, tempToRealId: null };
      logger.info(`[V3Resolve] traversal linkBack pivot: → ${nodeIds.length} nodes`);
    } else if (step.type === 'edge') {
      const result = await walkEdge(nodeIds, step, effectiveContext);
      logger.info(
        `[V3Resolve] traversal step edgeType=${step.edgeTypeId} dir=${step.direction}: ${nodeIds.length} → ${result.nextNodeIds.length} nodes`,
      );
      nodeIds = result.nextNodeIds;
      lastEdges = result.edges;
    }
    // resource steps in field mapping traversals are skipped — use resource selection mode instead
  }

  // Fall back to action-level edges when the field mapping has no traversal of its own
  if (lastEdges.length === 0 && contextEdges?.length) {
    lastEdges = contextEdges;
  }

  // Stage 2: Selection
  const values = await selectValues(nodeIds, lastEdges, mapping.selection, effectiveContext, constraints);
  logger.info(
    `[V3Resolve] selection mode=${mapping.selection.mode}: ${values.length} values from ${nodeIds.length} nodes`,
  );

  // Stage 3: Aggregation
  if (mapping.aggregation) {
    return aggregate(values, mapping.aggregation, constraints);
  }
  if (values.length === 1) {
    return values[0];
  }
  return values;
}

// -- Link-back resolution --
// Punch through from extraction tree (temp IDs) to merged knowledge graph (real IDs)

function resolveTempToReal(nodeIds: NodeId[], context: OutputExecutionContext): NodeId[] {
  if (!context.tempToRealId) return nodeIds;
  return nodeIds.map((id) => context.tempToRealId!.get(id as string) ?? id);
}

// -- Traversal --

async function walkEdge(
  nodeIds: NodeId[],
  step: {
    type: 'edge';
    edgeTypeId: string;
    direction: 'outgoing' | 'incoming';
    cardinality?: EdgeStep['cardinality'];
    filter?: unknown;
  },
  context: OutputExecutionContext,
): Promise<{ nextNodeIds: NodeId[]; edges: ResolvedEdge[] }> {
  const allNextIds: NodeId[] = [];
  const allEdges: ResolvedEdge[] = [];
  const stepFilter = step.filter as FilterExpression | undefined;

  for (const nodeId of nodeIds) {
    const edges = await queryEdges(nodeId, step.edgeTypeId, step.direction, context);
    let connectedIds = edges.map((e) => otherEnd(e, step.direction));
    let keptEdges = edges;

    // Apply filter before cardinality (filter first, then order/limit)
    if (stepFilter) {
      const passing: NodeId[] = [];
      for (const id of connectedIds) {
        if (await evaluateFilter(stepFilter, id, context)) {
          passing.push(id);
        }
      }
      const passedSet = new Set(passing.map((id) => id as string));
      keptEdges = edges.filter((e) => passedSet.has(otherEnd(e, step.direction) as string));
      connectedIds = passing;
      logger.info(
        `[V3Resolve] walkEdge filter: ${edges.length} → ${connectedIds.length} nodes passed`,
      );
    }

    if (step.cardinality) {
      const filtered = await applyCardinality(connectedIds, keptEdges, step, context);
      connectedIds = filtered.nodeIds;
      const keptSet = new Set(connectedIds.map((id) => id as string));
      allEdges.push(...keptEdges.filter((e) => keptSet.has(otherEnd(e, step.direction) as string)));
    } else {
      allEdges.push(...keptEdges);
    }

    allNextIds.push(...connectedIds);
  }

  return { nextNodeIds: allNextIds, edges: allEdges };
}

async function applyCardinality(
  nodeIds: NodeId[],
  edges: ResolvedEdge[],
  step: Pick<EdgeStep, 'cardinality' | 'direction'>,
  context: OutputExecutionContext,
): Promise<{ nodeIds: NodeId[] }> {
  const cardinality = step.cardinality!;

  if (cardinality.mode === 'all') {
    return { nodeIds };
  }

  const ordered = await orderNodeIds(
    nodeIds,
    cardinality.orderBy ?? null,
    cardinality.orderDirection ?? 'asc',
    edges,
    step.direction,
    context,
  );

  if (cardinality.mode === 'first') {
    return { nodeIds: ordered.slice(0, 1) };
  }
  // mode === 'n'
  return { nodeIds: ordered.slice(0, cardinality.limit ?? 1) };
}

async function orderNodeIds(
  nodeIds: NodeId[],
  orderBy: OrderKey | null,
  direction: 'asc' | 'desc',
  edges: ResolvedEdge[],
  edgeDirection: 'outgoing' | 'incoming',
  context: OutputExecutionContext,
): Promise<NodeId[]> {
  if (!orderBy || nodeIds.length <= 1) return nodeIds;

  // Build edge lookup: nodeId → edge (for edge property ordering)
  const edgeByNode = new Map<string, ResolvedEdge>();
  for (const edge of edges) {
    const nid = otherEnd(edge, edgeDirection);
    edgeByNode.set(nid as string, edge);
  }

  const pairs: { id: NodeId; sortKey: unknown }[] = [];
  for (const id of nodeIds) {
    let sortKey: unknown = null;

    // `property` is the movement language's spelling of the same key
    // `node_property` always meant. Anything else is an expression over the
    // element, which this evaluator has no element scope to read — say so
    // rather than rank by nothing.
    if (orderBy.type === 'node_property' || orderBy.type === 'property') {
      sortKey = await readProperty(id, orderBy.propertyTypeId as PropertyTypeId, context);
    } else if (orderBy.type === 'edge_property') {
      const edge = edgeByNode.get(id as string);
      if (edge) {
        sortKey = await readEdgeProperty(edge, orderBy.propertyTypeId as PropertyTypeId, context);
      }
    } else {
      logger.warn(
        `[V3Resolve] ordering key '${orderBy.type}' is not readable here — leaving the order as it came`,
      );
    }

    pairs.push({ id, sortKey });
  }

  pairs.sort((a, b) => {
    const aVal = a.sortKey;
    const bVal = b.sortKey;
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    if (aVal < bVal) return direction === 'asc' ? -1 : 1;
    if (aVal > bVal) return direction === 'asc' ? 1 : -1;
    return 0;
  });

  return pairs.map((p) => p.id);
}

// -- Enum mapping --
// When a property value targets a field with constrained options (select/status),
// use an LLM to pick the closest match if the raw value isn't an exact match.

async function maybeMapToOptions(
  values: unknown[],
  constraints?: FieldConstraints,
): Promise<unknown[]> {
  if (!constraints?.options?.length) return values;

  const optionSet = new Set(constraints.options.map((o) => o.toLowerCase()));

  const mapped: unknown[] = [];
  for (const val of values) {
    if (val == null || val === '') {
      mapped.push(val);
      continue;
    }
    const str = String(val);
    if (optionSet.has(str.toLowerCase())) {
      // Exact match (case-insensitive) — use the canonical option name
      const canonical = constraints.options.find((o) => o.toLowerCase() === str.toLowerCase());
      mapped.push(canonical ?? str);
      continue;
    }
    // No match — LLM picks the closest option
    mapped.push(await llmMapToOption(str, constraints.options));
  }
  return mapped;
}

async function llmMapToOption(value: string, options: string[]): Promise<string | null> {
  const optionsList = options.map((o) => `  - ${o}`).join('\n');
  const result = await anthropicChat({
    system: `You are mapping a value to the closest matching option in a constrained field. Pick the single best match from the provided options. If none of the options are a reasonable match, respond with exactly: NONE. Return ONLY the option text (exactly as listed) or NONE. No explanation.`,
    userMessage: `The value is: "${value}"\n\nOptions:\n${optionsList}`,
    model: HAIKU_MODEL,
    maxTokens: 50,
    noContinue: true,
    label: 'output_enum_mapping',
  });

  const trimmed = result.trim();
  if (trimmed === 'NONE') {
    logger.info(
      `[V3Resolve] enum mapping: no match for "${value}" among ${options.length} options`,
    );
    return null;
  }
  // Verify the LLM returned an actual option
  const matched = options.find((o) => o.toLowerCase() === trimmed.toLowerCase());
  if (matched) return matched;

  logger.warn(
    `[V3Resolve] enum mapping: LLM returned "${trimmed}" which isn't a valid option, falling back to null`,
  );
  return null;
}

// -- Selection --

async function selectValues(
  nodeIds: NodeId[],
  lastEdges: ResolvedEdge[],
  selection: Selection,
  context: OutputExecutionContext,
  constraints?: FieldConstraints,
): Promise<unknown[]> {
  if (selection.mode === 'static') {
    return [selection.value];
  }

  if (selection.mode === 'property') {
    const values: unknown[] = [];
    for (const id of nodeIds) {
      values.push(await readProperty(id, selection.propertyTypeId as PropertyTypeId, context));
    }
    return maybeMapToOptions(values, constraints);
  }

  if (selection.mode === 'edge_property') {
    const values: unknown[] = [];
    for (const edge of lastEdges) {
      values.push(
        await readEdgeProperty(edge, selection.propertyTypeId as PropertyTypeId, context),
      );
    }
    return maybeMapToOptions(values, constraints);
  }

  if (selection.mode === 'linked_object') {
    const values: unknown[] = [];
    for (const id of nodeIds) {
      const resolvedId = (context.tempToRealId?.get(id as string) as NodeId) ?? id;
      const linkedObjects = await loadLinkedObjects(resolvedId, context.teamId, {
        adapterType: selection.adapter.toUpperCase(),
      });
      if (linkedObjects.length > 0) {
        const lo = linkedObjects[0];
        if (selection.field === 'external_id') {
          values.push(lo.external_id);
        } else if (selection.field === 'external_object_type') {
          values.push(lo.external_object_type);
        } else {
          const data = (lo.data ?? {}) as Record<string, unknown>;
          values.push(data[selection.field] ?? null);
        }
        logger.info(`[V3Resolve] linked_object hit: nodeId=${resolvedId}, adapter=${selection.adapter}, field=${selection.field}, value=${JSON.stringify(values[values.length - 1])}, source=${lo.source}, externalId=${lo.external_id}`);
      } else {
        values.push(null);
        logger.warn(`[V3Resolve] linked_object miss: nodeId=${resolvedId}, adapter=${selection.adapter} — no linked objects found for this node`);
      }
    }
    return values;
  }

  if (selection.mode === 'resource') {
    const values: unknown[] = [];
    for (const id of nodeIds) {
      const resources = await loadResources(id, context);
      for (const resource of resources) {
        values.push(selectResourceField(resource, selection.field));
      }
    }
    return values.filter((v) => v != null);
  }

  if (selection.mode === 'meta') {
    return [resolveMetaKey(selection.key, context)];
  }

  if (selection.mode === 'parent_result') {
    const pr = context.parentResult;
    if (!pr) return [null];
    if (selection.field === 'created') return [pr.created ?? null];
    if (selection.field === 'external_id') return [pr.externalId ?? null];
    return [null];
  }

  // selection.mode === 'llm'
  const llmContext = await buildLLMContext(nodeIds, context);

  const optionsClause =
    constraints?.options && constraints.options.length > 0
      ? `\n\nThe value MUST be one of the following options (pick the closest match, or leave empty if none fit):\n${constraints.options.map((o: string) => `  - ${o}`).join('\n')}`
      : '';

  return [
    await resolveScalarByPrompt({
      task: selection.prompt,
      optionsClause,
      inputDescription: 'entity data along with the source document it was extracted from',
      input: llmContext,
      label: 'output_resolve_value',
    }),
  ];
}

/**
 * Evaluate a user-authored field prompt against some input and return the one
 * scalar the field resolves to.
 *
 * The value comes back as a forced tool argument, not as JSON inside a text
 * reply. That is the whole point of this function: a field prompt is arbitrary
 * user text, and a prompt that asks for a finished document ("write a board
 * briefing, ready to send") beats an instruction-only "now reply with JSON"
 * envelope — the model writes the document and the envelope is simply gone.
 * A tool argument has nowhere for that prose to leak into, so the shape holds
 * no matter what the field prompt asks for.
 */
export const scalarValueSchema = z.object({
  // Somewhere to reason before committing to a value. Never read — and
  // optional, because a required-but-unread field would turn "the model didn't
  // bother explaining itself" into a failed run.
  thought: z.string().nullish(),
  // `.nullish()`, not a required union: the prompt asks the model to emit `null`
  // when a field has no value, but a model that instead simply omits the key
  // means the same thing. A required union turned that benign omission into a
  // ZodError that failed the WHOLE output run. Genuine truncation (the model was
  // cut off before reaching `value`) is caught upstream as a max_tokens
  // StructuredOutputError, so a missing key that reaches here is a real "no
  // value", and `return value || null` below collapses it to null.
  value: z.union([z.string(), z.number(), z.boolean()]).nullish(),
});

async function resolveScalarByPrompt(options: {
  task: string;
  optionsClause: string;
  inputDescription: string;
  input: string;
  label: string;
}): Promise<unknown> {
  const { value } = await anthropicChatStructured({
    system: `You are an intelligent function in a data extraction system.

The user will provide ${options.inputDescription}. Evaluate this instruction against that input and return the single value it resolves to:

<instruction>
${options.task}
</instruction>${options.optionsClause}

Call the emit_value tool exactly once. Everything the instruction asks you to produce belongs in the tool's "value" argument — including long or formatted text. Never write it as a reply instead.

"value" is a single scalar. If the instruction yields multiple values, join them into one comma-separated string. If you cannot determine a value, set it to null.`,
    userMessage: options.input,
    schema: scalarValueSchema,
    toolName: 'emit_value',
    toolDescription: 'Return the single value this field resolves to.',
    model: 'claude-sonnet-5',
    // A field prompt may ask for a whole document; the default 4096 would
    // truncate it, and a truncated reply carries no complete tool call.
    maxTokens: 16384,
    label: options.label,
  });

  return value || null;
}

// -- Aggregation --

async function aggregate(
  values: unknown[],
  config: Aggregation,
  constraints?: FieldConstraints,
): Promise<unknown> {
  if (config.function === 'llm') {
    const serialized = values.map((v) => (v == null ? '(null)' : String(v))).join('\n');
    const prompt = config.prompt ?? 'Summarize the following values into a single output.';

    const optionsClause = constraints?.options?.length
      ? `\n\nThe value MUST be one of the following options (pick the closest match, or leave empty if none fit):\n${constraints.options.map((o) => `  - ${o}`).join('\n')}`
      : '';

    return resolveScalarByPrompt({
      task: prompt,
      optionsClause,
      inputDescription: 'a list of values',
      input: serialized,
      label: 'output_aggregate_value',
    });
  }

  // Apply ordering if specified
  const ordered = [...values];
  if (config.orderBy) {
    // For aggregation ordering, values are already primitive — just sort them
    const dir = config.orderDirection ?? 'asc';
    ordered.sort((a, b) => {
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      if (a < b) return dir === 'asc' ? -1 : 1;
      if (a > b) return dir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  switch (config.function) {
    case 'first':
      return ordered[0] ?? null;
    case 'last':
      return ordered[ordered.length - 1] ?? null;
    case 'only': {
      // "The one that matched": nothing is empty, one is it, and more than one
      // means the claim was wrong — a field write treats the empty as no value.
      const present = ordered.filter((v) => v != null);
      if (present.length > 1) {
        throw new Error(`ONLY says there is exactly one value, and there are ${present.length}.`);
      }
      return present[0] ?? null;
    }
    case 'count':
      return ordered.filter((v) => v != null).length;
    case 'sum':
      return ordered.reduce((acc: number, v) => acc + (typeof v === 'number' ? v : 0), 0);
    case 'avg': {
      const nums = ordered.filter((v): v is number => typeof v === 'number');
      return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    }
    case 'min': {
      const nums = ordered.filter((v): v is number => typeof v === 'number');
      return nums.length > 0 ? Math.min(...nums) : null;
    }
    case 'max': {
      const nums = ordered.filter((v): v is number => typeof v === 'number');
      return nums.length > 0 ? Math.max(...nums) : null;
    }
    case 'join': {
      const sep = (config.separator ?? ', ').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      return ordered.map((v) => (v == null ? '' : String(v))).join(sep);
    }
    case 'collect':
      return ordered;
    default:
      return ordered[0] ?? null;
  }
}

// -- Edge queries (overlay-aware) --

async function queryEdges(
  nodeId: NodeId,
  edgeTypeId: string,
  direction: 'outgoing' | 'incoming',
  context: OutputExecutionContext,
): Promise<ResolvedEdge[]> {
  // Check changeset overlay first (extraction trigger)
  if (context.changeset && context.tempToRealId) {
    const overlayEdges = resolveOverlayEdges(nodeId, edgeTypeId, direction, context);
    if (overlayEdges.length > 0) {
      logger.info(
        `[V3Resolve] queryEdges: ${overlayEdges.length} overlay edge(s) for node=${nodeId} edgeType=${edgeTypeId} dir=${direction}`,
      );
      return overlayEdges;
    }
    // Node might be a pinned (resolved) node — fall through to permanent graph
  }

  // Permanent graph query
  const qb = getKnowledgeQb(['edge']);

  if (direction === 'outgoing') {
    const rows = await qb
      .selectFrom('edge')
      .where('edge.source_node_id', '=', nodeId)
      .where('edge.edge_type_id', '=', edgeTypeId as EdgeTypeId)
      .where('edge.team_id', '=', context.teamId)
      .select(['edge.id', 'edge.source_node_id', 'edge.target_node_id', 'edge.edge_type_id'])
      .execute();

    logger.info(
      `[V3Resolve] queryEdges permanent (outgoing): node=${nodeId} edgeType=${edgeTypeId} → ${rows.length} edges`,
    );

    return rows.map((r) => ({
      id: r.id as EdgeId,
      sourceNodeId: r.source_node_id as NodeId,
      targetNodeId: r.target_node_id as NodeId,
      edgeTypeId: r.edge_type_id as string,
    }));
  }

  const rows = await qb
    .selectFrom('edge')
    .where('edge.target_node_id', '=', nodeId)
    .where('edge.edge_type_id', '=', edgeTypeId as EdgeTypeId)
    .where('edge.team_id', '=', context.teamId)
    .select(['edge.id', 'edge.source_node_id', 'edge.target_node_id', 'edge.edge_type_id'])
    .execute();

  logger.info(
    `[V3Resolve] queryEdges permanent (incoming): node=${nodeId} edgeType=${edgeTypeId} → ${rows.length} edges`,
  );

  return rows.map((r) => ({
    id: r.id as EdgeId,
    sourceNodeId: r.source_node_id as NodeId,
    targetNodeId: r.target_node_id as NodeId,
    edgeTypeId: r.edge_type_id as string,
  }));
}

function resolveOverlayEdges(
  nodeId: NodeId,
  edgeTypeId: string,
  direction: 'outgoing' | 'incoming',
  context: OutputExecutionContext,
): ResolvedEdge[] {
  const changeset = context.changeset!;
  const tempToRealId = context.tempToRealId!;

  // Build reverse map: realId → tempId
  const realToTemp = new Map<string, string>();
  for (const [tempId, realId] of tempToRealId) {
    realToTemp.set(realId as string, tempId);
  }

  const nodeTempId = realToTemp.get(nodeId as string);
  if (!nodeTempId) {
    logger.info(`[V3Resolve] resolveOverlayEdges: node ${nodeId} not in tempToRealId reverse map`);
    return [];
  }

  // Log available edges of this type for debugging
  const edgesOfType = changeset.edges.filter((e) => e.edgeType === edgeTypeId);
  if (edgesOfType.length === 0) {
    logger.info(
      `[V3Resolve] resolveOverlayEdges: 0 changeset edges of type ${edgeTypeId}. Available types: ${[...new Set(changeset.edges.map((e) => e.edgeType))].join(', ')}`,
    );
  } else {
    logger.info(
      `[V3Resolve] resolveOverlayEdges: ${edgesOfType.length} changeset edge(s) of type ${edgeTypeId}, looking for tempId=${nodeTempId} as ${direction === 'outgoing' ? 'source' : 'target'}`,
      {
        edges: edgesOfType.map((e) => ({ source: e.sourceTempId, target: e.targetTempId })),
      },
    );
  }

  const matching = changeset.edges.filter((e) => {
    if (e.edgeType !== edgeTypeId) return false;
    if (direction === 'outgoing') return e.sourceTempId === nodeTempId;
    return e.targetTempId === nodeTempId;
  });

  const results: ResolvedEdge[] = [];
  const seen = new Set<string>();
  for (const e of matching) {
    const sourceRealId = tempToRealId.get(e.sourceTempId);
    const targetRealId = tempToRealId.get(e.targetTempId);
    if (!sourceRealId || !targetRealId) continue;
    const key = `${sourceRealId}:${targetRealId}:${e.edgeType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      id: null,
      sourceNodeId: sourceRealId,
      targetNodeId: targetRealId,
      edgeTypeId: e.edgeType as string,
    });
  }
  return results;
}

function otherEnd(edge: ResolvedEdge, direction: 'outgoing' | 'incoming'): NodeId {
  return direction === 'outgoing' ? edge.targetNodeId : edge.sourceNodeId;
}

// -- Property reading --

async function readProperty(
  nodeId: NodeId,
  propertyTypeId: PropertyTypeId,
  context: OutputExecutionContext,
): Promise<unknown> {
  // Changeset overlay: resolve from in-memory extraction data when the node
  // hasn't been persisted (dry-run mode) or was just created in K_APPLY.
  if (context.changeset && context.tempToRealId) {
    const value = readPropertyFromChangeset(nodeId, propertyTypeId, context);
    if (value !== undefined) return value;
  }

  const qb = getKnowledgeQb(['property']);

  const row = await qb
    .selectFrom('property')
    .where('property.node_id', '=', nodeId)
    .where('property.property_type_id', '=', propertyTypeId)
    .where('property.team_id', '=', context.teamId)
    .select([
      'property.value_text',
      'property.value_number',
      'property.value_boolean',
      'property.value_date',
      'property.value_json',
    ])
    .executeTakeFirst();

  if (!row) return null;
  const text = row.value_text;
  if (text != null && text !== '') return text;
  return row.value_number ?? row.value_boolean ?? row.value_date ?? row.value_json ?? null;
}

// Look up a property value from the changeset's in-memory data.
// Returns undefined if not found (signals "not in overlay, try DB").
function readPropertyFromChangeset(
  nodeId: NodeId,
  propertyTypeId: PropertyTypeId,
  context: OutputExecutionContext,
): unknown {
  const changeset = context.changeset!;
  const tempToRealId = context.tempToRealId!;

  // Build reverse map: realId → tempId(s)
  // A single real ID can have multiple temp IDs when consolidation merges nodes
  const nodeTempIds: string[] = [];
  for (const [tempId, realId] of tempToRealId) {
    if ((realId as string) === (nodeId as string)) {
      nodeTempIds.push(tempId);
    }
  }
  if (nodeTempIds.length === 0) {
    logger.info(`[V3Resolve] readPropertyFromChangeset: nodeId=${nodeId} not in tempToRealId reverse map (${tempToRealId.size} entries)`);
    return undefined;
  }

  // Find the property in the changeset (check all temp IDs for this node)
  const prop = changeset.properties.find(
    (p) => nodeTempIds.includes(p.parentTempId) && (p.propertyTypeId as string) === (propertyTypeId as string),
  );
  if (!prop) {
    const allPropsForNode = changeset.properties.filter((p) => nodeTempIds.includes(p.parentTempId));
    logger.info(`[V3Resolve] readPropertyFromChangeset: property ${propertyTypeId} not found for nodeId=${nodeId} (tempIds=${nodeTempIds.join(',')}). Node has ${allPropsForNode.length} changeset properties: [${allPropsForNode.map((p) => p.propertyTypeId).join(', ')}]`);
    return undefined;
  }

  return prop.value ?? null;
}

async function readEdgeProperty(
  edge: ResolvedEdge,
  propertyTypeId: PropertyTypeId,
  context: OutputExecutionContext,
): Promise<unknown> {
  if (!edge.id) return null;

  const qb = getKnowledgeQb(['property']);

  const row = await qb
    .selectFrom('property')
    .where('property.edge_id', '=', edge.id)
    .where('property.property_type_id', '=', propertyTypeId)
    .where('property.team_id', '=', context.teamId)
    .select([
      'property.value_text',
      'property.value_number',
      'property.value_boolean',
      'property.value_date',
      'property.value_json',
    ])
    .executeTakeFirst();

  if (!row) return null;
  const text = row.value_text;
  if (text != null && text !== '') return text;
  return row.value_number ?? row.value_boolean ?? row.value_date ?? row.value_json ?? null;
}

// -- Node serialization for LLM --

async function serializeNodeForLLM(
  nodeId: NodeId,
  context: OutputExecutionContext,
): Promise<string> {
  const qb = getKnowledgeQb(['node', 'node_type', 'property', 'property_type']);

  const node = await qb
    .selectFrom('node')
    .innerJoin('node_type', 'node_type.id', 'node.node_type_id')
    .where('node.id', '=', nodeId)
    .where('node.team_id', '=', context.teamId)
    .select(['node_type.name as type_name'])
    .executeTakeFirst();

  const props = await qb
    .selectFrom('property')
    .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
    .where('property.node_id', '=', nodeId)
    .where('property.team_id', '=', context.teamId)
    .select([
      'property_type.name',
      'property.value_text',
      'property.value_number',
      'property.value_boolean',
    ])
    .execute();

  const lines = [`## ${node?.type_name ?? 'Node'}`];
  for (const p of props) {
    const value = p.value_text ?? p.value_number ?? p.value_boolean;
    if (value != null) lines.push(`${p.name}: ${value}`);
  }
  return lines.join('\n');
}

async function loadSourceContent(
  nodeId: NodeId,
  context: OutputExecutionContext,
): Promise<string | null> {
  const knowledgeQb = getKnowledgeQb(['node_resource']);
  const nodeResources = await knowledgeQb
    .selectFrom('node_resource')
    .where('node_resource.node_id', '=', nodeId)
    .where('node_resource.team_id', '=', context.teamId)
    .select(['node_resource.resource_id', 'node_resource.start_offset', 'node_resource.end_offset'])
    .execute();

  if (!nodeResources.length) return null;

  // `node_resource.resource_id` lost its brand with the cross-schema FK (D3).
  const resourceIds = [...new Set(nodeResources.map((nr) => nr.resource_id))] as ResourceId[];
  const publicQb = getKnowledgeQb(['resource', 'raw_text']);
  const resources = await publicQb
    .selectFrom('resource')
    .innerJoin('raw_text', 'raw_text.id', 'resource.raw_text_id')
    .where('resource.id', 'in', resourceIds)
    .select(['resource.id as resource_id', 'raw_text.content'])
    .execute();

  const contentByResourceId = new Map(
    resources.map(
      (r: { resource_id: string; content: string }) => [r.resource_id, r.content] as const,
    ),
  );

  const texts: string[] = [];
  for (const nr of nodeResources) {
    const fullContent = contentByResourceId.get(nr.resource_id as string);
    if (!fullContent) continue;
    const text =
      nr.start_offset != null && nr.end_offset != null
        ? fullContent.slice(nr.start_offset, nr.end_offset)
        : fullContent;
    texts.push(text);
  }

  if (!texts.length) return null;
  const joined = texts.join('\n\n---\n\n');
  return joined.length > 10000 ? joined.slice(0, 10000) + '\n\n[truncated]' : joined;
}

// -- Load node data for filter evaluation --

async function loadFieldRefsForNode(
  nodeId: NodeId,
  context: OutputExecutionContext,
  edgeProperties?: Record<string, unknown>,
  oldEdgeProperties?: Record<string, unknown>,
): Promise<NodeData> {
  const qb = getKnowledgeQb(['property', 'property_type']);

  const props = await qb
    .selectFrom('property')
    .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
    .where('property.node_id', '=', nodeId)
    .where('property.team_id', '=', context.teamId)
    .select([
      'property_type.id as property_type_id',
      'property.value_text',
      'property.value_number',
      'property.value_boolean',
      'property.value_date',
      'property.value_json',
    ])
    .execute();

  const properties: Record<string, unknown> = {};
  for (const p of props) {
    const propText = p.value_text;
    properties[p.property_type_id] =
      propText != null && propText !== ''
        ? propText
        : p.value_number ?? p.value_boolean ?? p.value_date ?? p.value_json ?? null;
  }

  // Load all linked objects (retrieval, output, manual) from the unified table
  const allLinkedObjects = await loadLinkedObjects(nodeId, context.teamId);

  const linkedObjects = allLinkedObjects.map((lo) => ({
    adapter: lo.adapter_type,
    actionNodeId: lo.action_node_id,
    externalId: lo.external_id,
    data: (lo.data ?? {}) as Record<string, unknown>,
  }));

  const oldProps = context.oldProperties?.get(nodeId as string) ?? null;

  return {
    properties,
    edgeProperties: edgeProperties ?? {},
    linkedObjects,
    _old: oldProps,
    _oldEdgeProperties: oldEdgeProperties ?? null,
    _meta: context.meta,
    _parentResult: null,
  };
}

// -- Context traversal for children --

async function traverseForContext(
  steps: TraversalStep[],
  parentNodeId: NodeId,
  context: OutputExecutionContext,
): Promise<NodeId[]> {
  const { nodeIds } = await traverseWithEdges(steps, parentNodeId, context);
  return nodeIds;
}

async function traverseWithEdges(
  steps: TraversalStep[],
  parentNodeId: NodeId,
  context: OutputExecutionContext,
): Promise<{ nodeIds: NodeId[]; lastEdges: ResolvedEdge[]; linkedBack: boolean }> {
  let nodeIds: NodeId[] = [parentNodeId];
  let lastEdges: ResolvedEdge[] = [];
  // After linkBack, subsequent steps query the permanent graph only —
  // strip changeset overlay so queryEdges doesn't return extraction-only edges
  let linkedBack = false;
  let effectiveContext = context;
  for (const step of steps) {
    if (step.type === 'linkBack') {
      nodeIds = resolveTempToReal(nodeIds, context);
      lastEdges = [];
      linkedBack = true;
      effectiveContext = { ...context, changeset: null, tempToRealId: null };
    } else if (step.type === 'edge') {
      const result = await walkEdge(nodeIds, step, effectiveContext);
      nodeIds = result.nextNodeIds;
      lastEdges = result.edges;
    }
    // resource steps are handled by executeAction, not traverseForContext

    // Deduplicate after each step — multiple paths to the same node should not trigger duplicate processing
    nodeIds = [...new Set(nodeIds)];
  }
  return { nodeIds, lastEdges, linkedBack };
}

async function findLinkBackNodeIds(
  traversal: TraversalStep[],
  startNodeId: NodeId,
  context: OutputExecutionContext,
): Promise<NodeId[] | null> {
  let nodeIds: NodeId[] = [startNodeId];
  for (const step of traversal) {
    if (step.type === 'linkBack') {
      return resolveTempToReal(nodeIds, context);
    } else if (step.type === 'edge') {
      const result = await walkEdge(nodeIds, step, context);
      nodeIds = result.nextNodeIds;
    }
  }
  return null;
}

function formatSystemContextBlock(ctx: SystemContext): string | null {
  const lines: string[] = [];
  if (ctx.userName) lines.push(`Current User: ${ctx.userName}${ctx.userEmail ? ` (${ctx.userEmail})` : ''}`);
  else if (ctx.userEmail) lines.push(`Current User Email: ${ctx.userEmail}`);
  if (ctx.currentDate) lines.push(`Current Date: ${ctx.currentDate}`);
  if (ctx.inputChannelName) lines.push(`Input Channel: ${ctx.inputChannelName}`);
  return lines.length > 0 ? `<system_context>\n${lines.join('\n')}\n</system_context>` : null;
}

async function buildLLMContext(
  contextNodeIds: NodeId[],
  context: OutputExecutionContext,
): Promise<string> {
  const serialized = await Promise.all(
    contextNodeIds.map((id) => serializeNodeForLLM(id, context)),
  );

  const sourceContent = await loadSourceContent(context.rootNodeId, context);
  const rootSerialized =
    context.rootNodeId !== contextNodeIds[0]
      ? await serializeNodeForLLM(context.rootNodeId, context)
      : null;

  const parts: string[] = [];
  if (context.systemContext) {
    const systemBlock = formatSystemContextBlock(context.systemContext);
    if (systemBlock) parts.push(systemBlock);
  }
  if (sourceContent) {
    parts.push(`<source_document>\n${sourceContent}\n</source_document>`);
  }
  if (rootSerialized) {
    parts.push(`<message_context>\n${rootSerialized}\n</message_context>`);
  }
  parts.push(`<entity_data>\n${serialized.join('\n\n---\n\n')}\n</entity_data>`);

  return parts.join('\n\n');
}

async function composeTextFromPrompt(
  prompt: string,
  contextNodeId: NodeId,
  context: OutputExecutionContext,
  options?: { systemPromptExtension?: string; additionalContext?: string },
): Promise<string | null> {
  // If the prompt is purely preserve tags (all real content is after-LLM embeds),
  // skip the LLM call — there are no instructions for it to follow.
  const strippedPrompt = prompt.replace(PRESERVE_TAG_RE, '').trim();
  if (!strippedPrompt) {
    return prompt;
  }

  const llmContext = await buildLLMContext([contextNodeId], context);

  const extensionBlock = options?.systemPromptExtension
    ? `\n\n${options.systemPromptExtension}`
    : '';

  const additionalBlock = options?.additionalContext
    ? `\n\n${options.additionalContext}`
    : '';

  const hasPreserveTags = PRESERVE_TAG_RE.test(prompt);
  PRESERVE_TAG_RE.lastIndex = 0; // reset after .test() with global flag

  const preserveTagNote = hasPreserveTags
    ? `\n\nIMPORTANT: The task contains placeholder tags like <llm-preserve-tag:N>. You MUST include these tags exactly as-is in your output — they will be replaced with actual values after generation. Do not remove, rewrite, or explain them.`
    : '';

  const system = `You are composing a message for an output destination.
Return ONLY the message text. No XML, no labels, no preamble — just the message exactly as it should appear.${extensionBlock}${additionalBlock}${preserveTagNote}
The user will provide entity data along with the source document it was extracted from. Your task:
${prompt}`;

  const result = await anthropicChat({
    system,
    userMessage: llmContext,
    model: 'claude-sonnet-5',
    label: 'output_compose_text',
  });

  const trimmed = result.trim();
  return trimmed || null;
}

// -- Safe regex / glob helpers --

function safeRegex(pattern: string, flags?: string): RegExp | null {
  try {
    const re = new RegExp(pattern, flags);
    // Test against a benign string with a timeout-like guard:
    // reject patterns that are obviously pathological (nested quantifiers)
    if (/(\+|\*|\{)\s*(\+|\*|\{)/.test(pattern)) {
      logger.warn(`[V3Resolve] rejected potentially pathological regex: ${pattern}`);
      return null;
    }
    return re;
  } catch {
    logger.warn(`[V3Resolve] invalid regex pattern: ${pattern}`);
    return null;
  }
}

function mimeGlobMatch(mime: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '*/*') return true;
  if (pattern.endsWith('/*')) {
    return mime.startsWith(pattern.slice(0, -1));
  }
  return mime === pattern;
}

const EXTENSION_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  zip: 'application/zip',
};

function inferMimeType(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? null;
}

// -- Resource traversal --

async function loadResources(
  nodeId: NodeId,
  context: OutputExecutionContext,
  filter?: ResourceFilter,
): Promise<ResourceContext[]> {
  // When a changeset is available (extraction trigger), scope to only the current extraction's resources.
  // This prevents resources from previous ingestions accumulating on consolidated/matched nodes.
  let resourceIds: ResourceId[];
  if (context.changeset && context.tempToRealId) {
    const changesetResourceIds = new Set<ResourceId>();
    for (const nr of context.changeset.nodeResources) {
      const realNodeId = context.tempToRealId.get(nr.targetTempId);
      if (realNodeId === nodeId) {
        changesetResourceIds.add(nr.resourceId);
      }
    }
    resourceIds = [...changesetResourceIds];
  } else {
    const knowledgeQb = getKnowledgeQb(['node_resource']);
    const nodeResources = await knowledgeQb
      .selectFrom('node_resource')
      .where('node_resource.node_id', '=', nodeId)
      .where('node_resource.team_id', '=', context.teamId)
      .select(['node_resource.resource_id'])
      .execute();
    // Brand re-asserted at the crossing — the FK went with the carve (D3).
    resourceIds = [...new Set(nodeResources.map((nr) => nr.resource_id))] as ResourceId[];
  }

  if (!resourceIds.length) return [];
  const includePayload = filter?.includePayload === true;
  const publicQb = getKnowledgeQb(['resource', 'document', 'raw_text']);

  let baseQuery = publicQb
    .selectFrom('resource')
    .leftJoin('document', 'document.id', 'resource.document_id')
    .leftJoin('raw_text', 'raw_text.id', 'resource.raw_text_id')
    .where('resource.id', 'in', resourceIds)
    .select([
      'resource.id',
      'resource.name',
      'resource.url',
      'resource.type',
      'resource.document_id',
      'resource.metadata',
      'document.object_uri',
      'raw_text.content as raw_text_content',
    ]);

  if (filter?.resourceType) {
    baseQuery = baseQuery.where('resource.type', '=', filter.resourceType as unknown as ResourceType);
  }
  if (filter?.hasDocument === true) {
    baseQuery = baseQuery.where('resource.document_id', 'is not', null);
  } else if (filter?.hasDocument === false) {
    baseQuery = baseQuery.where('resource.document_id', 'is', null);
  }

  const rows = await baseQuery.execute();
  let results: ResourceContext[] = rows.map((r) => ({
    resourceId: r.id,
    name: r.name,
    url: r.url,
    type: r.type,
    documentObjectUri: r.object_uri ?? null,
    documentId: r.document_id,
    content: (r as Record<string, unknown>).raw_text_content as string | null ?? null,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));

  if (includePayload && results.length > 0) {
    const rIds = results.map((r) => r.resourceId) as ResourceId[];
    const payloadByResourceId = new Map<string, { data: Record<string, unknown>; channel?: string }>();

    // Path 1: direct resource.inbound_payload_id. Crosses the schema line —
    // `resource` is knowledge's, `inbound_payload` sits in `public` — so both
    // are named schema-qualified.
    const directQb = getQb(['knowledge.resource', 'inbound_payload']);
    const directRows = await directQb
      .selectFrom('knowledge.resource as resource')
      .innerJoin('inbound_payload', 'inbound_payload.id', 'resource.inbound_payload_id')
      .where('resource.id', 'in', rIds)
      .select(['resource.id', 'inbound_payload.data', 'inbound_payload.channel'])
      .execute();

    for (const row of directRows) {
      if (row.data) {
        payloadByResourceId.set(row.id, {
          data: row.data as Record<string, unknown>,
          channel: (row.channel ?? undefined) as string | undefined,
        });
      }
    }

    // Path 2: resource_payload junction table (for resources without direct inbound_payload_id)
    const missingIds = rIds.filter((id) => !payloadByResourceId.has(id));
    if (missingIds.length > 0) {
      const junctionQb = getQb(['resource_payload', 'inbound_payload']);
      const junctionRows = await junctionQb
        .selectFrom('resource_payload')
        .innerJoin('inbound_payload', 'inbound_payload.id', 'resource_payload.inbound_payload_id')
        .where('resource_payload.resource_id', 'in', missingIds)
        .select(['resource_payload.resource_id', 'inbound_payload.data', 'inbound_payload.channel'])
        .execute();

      for (const row of junctionRows) {
        if (payloadByResourceId.has(row.resource_id)) continue;
        if (row.data) {
          payloadByResourceId.set(row.resource_id, {
            data: row.data as Record<string, unknown>,
            channel: (row.channel ?? undefined) as string | undefined,
          });
        }
      }
    }

    for (const result of results) {
      const payload = payloadByResourceId.get(result.resourceId);
      if (payload) {
        result.payload = payload.data;
        if (payload.channel) {
          (result.metadata as Record<string, unknown>).payloadChannel = payload.channel;
        }
      }
    }
  }

  // Apply in-memory filters that can't be done in SQL
  if (filter?.namePattern) {
    const regex = safeRegex(filter.namePattern, 'i');
    if (regex) {
      results = results.filter((r) => regex.test(r.name));
    }
  }
  if (filter?.mimeType) {
    // Comma-separated glob matching (e.g. "application/pdf, image/*")
    const matchers = filter.mimeType
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    results = results.filter((r) => {
      const mime = (
        (r.metadata.mimeType as string | undefined) ?? inferMimeType(r.name)
      )?.toLowerCase();
      if (!mime) return false;
      return matchers.some((pattern) => mimeGlobMatch(mime, pattern.toLowerCase()));
    });
  }

  return results;
}

/**
 * The public link to a stored document's bytes, for anything we write OUT of
 * the pipeline (a CRM field, a Slack message) to point at.
 *
 * It used to name `share.example.com` — an Listen-Fire-hosted viewer that no longer
 * deploys — so the link was both dead for us and, for anyone else running this
 * code, a link to a document on somebody else's host. This deployment serves
 * the same bytes from its own public route, which is what `lib/notion/parser`
 * already links to, so the host comes from API_BASE_URL like every other URL we
 * hand to the outside world.
 *
 * The link is SIGNED (`lib/document_link`): the route no longer serves bytes by
 * id, so the signature travels with the URL into whatever CRM field or message
 * it lands in. Deliberately without expiry — see that module for why a link
 * written into someone else's system must not carry a clock.
 */
function documentPublicUrl(documentId: string): string {
  return signDocumentUrl(documentId);
}

function selectResourceField(resource: ResourceContext, field: string): unknown {
  switch (field) {
    case 'name':
      return resource.name;
    case 'url':
      return resource.url;
    case 'type':
      return resource.type;
    case 'document_url':
      return resource.documentId ? documentPublicUrl(resource.documentId) : null;
    case 'content':
      return resource.content;
    default:
      return null;
  }
}

// -- Prompt template interpolation --

async function resolvePromptEmbeds(
  embeds: PromptEmbed[],
  contextNodeId: NodeId,
  context: OutputExecutionContext,
): Promise<Map<number, string>> {
  const results = new Map<number, string>();

  for (let i = 0; i < embeds.length; i++) {
    const embed = embeds[i];
    const resolved = await resolveFieldMapping(
      {
        targetField: `__embed_${i}`,
        expression: embed.expression,
        traversal: embed.traversal,
        selection: embed.selection,
        aggregation: embed.aggregation,
      },
      contextNodeId,
      context,
    );
    if (resolved != null) {
      results.set(i + 1, String(resolved));
    }
  }

  return results;
}

function interpolatePromptEmbeds(text: string, embedValues: Map<number, string>): string {
  return text.replace(/\$\{(\d+)\}/g, (_match, num) => {
    return embedValues.get(Number(num)) ?? '';
  });
}

const PRESERVE_TAG_RE = /<llm-preserve-tag:(\d+)>/g;

function insertPreserveTags(text: string, embedKeys: Set<number>): string {
  return text.replace(/\$\{(\d+)\}/g, (match, num) => {
    return embedKeys.has(Number(num)) ? `<llm-preserve-tag:${num}>` : match;
  });
}

function resolvePreserveTags(text: string, embedValues: Map<number, string>): string {
  return text.replace(PRESERVE_TAG_RE, (_match, num) => {
    return embedValues.get(Number(num)) ?? '';
  });
}

export {
  resolveFieldMapping,
  walkEdge,
  selectValues,
  aggregate,
  traverseForContext,
  traverseWithEdges,
  findLinkBackNodeIds,
  loadFieldRefsForNode,
  readProperty,
  readEdgeProperty,
  resolveMetaKey,
  maybeMapToOptions,
  queryEdges,
  buildLLMContext,
  composeTextFromPrompt,
  loadResources,
  documentPublicUrl,
  selectResourceField,
  resolvePromptEmbeds,
  interpolatePromptEmbeds,
  insertPreserveTags,
  resolvePreserveTags,
  resolveTempToReal,
};
export type { OutputExecutionContext, ResolvedEdge };
