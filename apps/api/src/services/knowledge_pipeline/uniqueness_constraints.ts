import { sql } from 'kysely';
import { z } from 'zod';
import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

import { getKnowledgeQb } from '../../lib/kysely';
import { logger } from '../logger';
import type { Expression, EdgeStep } from '#shared/expression/types';
import { expressionSchema } from './output_v3/expression';
import { isBlankIdentityValue } from '../translation_graph/uniqueness';
import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import type { EdgeTypeId } from '../../generated/kysely/knowledge/EdgeType';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExtractedSubgraph, ExtractedNode, ExtractedProperty, ExtractedEdge } from './types';

// ── Types ──

/**
 * Expression-based constraint entry — the original shape. Carries an
 * `Expression` plus an optional `fuzzy` flag; resolved at search time
 * against extracted property values + resolved edge targets.
 */
interface ExpressionConstraintEntry {
  expr: Expression;
  fuzzy?: boolean;
}

/**
 * Compound-scope entry — references a named ancestor bound by an
 * ancestor action in the same translation graph. AND-tupled with all
 * other entries in the same constraint. Resolved at search time via
 * the `resolvedAncestorNodes` map: candidate must have an edge to the
 * resolved ancestor node.
 *
 */
interface EdgeToConstraintEntry {
  kind: 'edge_to';
  ancestorName: string;
}

type ConstraintEntry = ExpressionConstraintEntry | EdgeToConstraintEntry;

function isEdgeToEntry(entry: ConstraintEntry): entry is EdgeToConstraintEntry {
  return (entry as EdgeToConstraintEntry).kind === 'edge_to';
}

const expressionConstraintEntrySchema = z.object({
  expr: expressionSchema,
  fuzzy: z.boolean().optional(),
});

const edgeToConstraintEntrySchema = z.object({
  kind: z.literal('edge_to'),
  ancestorName: z.string().min(1),
});

const constraintEntrySchema = z.union([
  edgeToConstraintEntrySchema,
  expressionConstraintEntrySchema,
]);
const uniquenessConstraintSchema = z.array(constraintEntrySchema);
const storedUniquenessConstraintsSchema = z.array(uniquenessConstraintSchema);

type UniquenessConstraint = ConstraintEntry[];
type StoredUniquenessConstraints = UniquenessConstraint[];

interface CandidateResult {
  nodeId: NodeId;
  properties: Record<string, unknown>;
  constraintIndex: number;
  allEntriesExact: boolean;
}

// ── Validation ──

const ALLOWED_EXPRESSION_TYPES = new Set([
  'property', 'traverse', 'function', 'static', 'arithmetic', 'concat',
  'compare', 'logical', 'not',
]);

const ALLOWED_FUNCTIONS = new Set([
  'lower', 'upper', 'trim', 'coalesce', 'tostring', 'tonumber', 'isnull',
  'length', 'abs', 'round', 'floor', 'ceil',
  // N1: time-window scope. `WITHIN(<dateProperty>, "<interval>")`
  // restricts the candidate set to nodes whose date property is no
  // older than the given Postgres interval. The SQL compiler at
  // `compileExpressionToWhere` understands this shape; the parser at
  // `parseConstraintText` recognises the surface syntax.
  'within',
]);

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateExpression(expr: Expression, path: string): string[] {
  const errors: string[] = [];

  if (!ALLOWED_EXPRESSION_TYPES.has(expr.type)) {
    errors.push(`${path}: expression type "${expr.type}" is not allowed in uniqueness constraints`);
    return errors;
  }

  if (expr.type === 'traverse') {
    if (expr.steps.length !== 1) {
      errors.push(`${path}: traverse must have exactly one step, got ${expr.steps.length}`);
    }
    const step = expr.steps[0];
    if (step.type !== 'edge') {
      errors.push(`${path}: traverse step must be an edge step, got "${step.type}"`);
    }
  }

  if (expr.type === 'function') {
    if (!ALLOWED_FUNCTIONS.has(expr.fn)) {
      errors.push(`${path}: function "${expr.fn}" is not allowed in uniqueness constraints`);
    }
    for (let i = 0; i < expr.args.length; i++) {
      errors.push(...validateExpression(expr.args[i], `${path}.args[${i}]`));
    }
  }

  if (expr.type === 'arithmetic') {
    errors.push(...validateExpression(expr.left, `${path}.left`));
    errors.push(...validateExpression(expr.right, `${path}.right`));
  }

  if (expr.type === 'concat') {
    for (let i = 0; i < expr.parts.length; i++) {
      errors.push(...validateExpression(expr.parts[i], `${path}.parts[${i}]`));
    }
  }

  if (expr.type === 'compare') {
    errors.push(...validateExpression(expr.left, `${path}.left`));
    errors.push(...validateExpression(expr.right, `${path}.right`));
  }

  if (expr.type === 'logical') {
    for (let i = 0; i < expr.operands.length; i++) {
      errors.push(...validateExpression(expr.operands[i], `${path}.operands[${i}]`));
    }
  }

  if (expr.type === 'not') {
    errors.push(...validateExpression(expr.expression, `${path}.expression`));
  }

  return errors;
}

function validateUniquenessConstraints(
  constraints: StoredUniquenessConstraints,
  options?: {
    /**
     * Names bound by ancestor actions in the surrounding translation graph.
     * When provided, every `edge_to` entry's `ancestorName` must be a member;
     * otherwise the entry is reported as referring to an unknown ancestor.
     * Omit to skip the ancestor-name check (e.g. legacy callers that don't
     * carry TG-level scope).
     */
    ancestorNamesInScope?: ReadonlySet<string>;
  },
): ValidationResult {
  const errors: string[] = [];

  for (let ci = 0; ci < constraints.length; ci++) {
    const constraint = constraints[ci];
    for (let ei = 0; ei < constraint.length; ei++) {
      const entry = constraint[ei];
      const path = `constraint[${ci}][${ei}]`;
      if (isEdgeToEntry(entry)) {
        if (!entry.ancestorName.trim()) {
          errors.push(`${path}: edge_to entry has empty ancestorName`);
          continue;
        }
        if (options?.ancestorNamesInScope && !options.ancestorNamesInScope.has(entry.ancestorName)) {
          errors.push(
            `${path}: edge_to references ancestor "${entry.ancestorName}" which is not bound by any ancestor action`,
          );
        }
        continue;
      }
      errors.push(...validateExpression(entry.expr, `${path}.expr`));
    }
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

// ── Topological ordering from constraints ──

function buildResolutionOrder(
  nodeTypes: Map<NodeTypeId, { constraints: StoredUniquenessConstraints | null }>,
  edgeTypes: Map<EdgeTypeId, { sourceNodeTypeId: NodeTypeId; targetNodeTypeId: NodeTypeId }>,
): NodeTypeId[] {
  const deps = new Map<string, Set<string>>();
  for (const [ntId] of nodeTypes) {
    deps.set(ntId as string, new Set());
  }

  for (const [ntId, { constraints }] of nodeTypes) {
    if (!constraints) continue;
    for (const constraint of constraints) {
      for (const entry of constraint) {
        // `edge_to` entries reference TG-ancestor names rather than
        // ontology edge types, so they don't contribute node-type-level
        // dependencies — the TG's ancestor action drives that ordering.
        if (isEdgeToEntry(entry)) continue;
        const edgeTypeIds = collectEdgeTypeIds(entry.expr);
        for (const etId of edgeTypeIds) {
          const et = edgeTypes.get(etId as EdgeTypeId);
          if (!et) continue;
          const dependsOn = (et.sourceNodeTypeId as string) === (ntId as string)
            ? et.targetNodeTypeId
            : et.sourceNodeTypeId;
          deps.get(ntId as string)?.add(dependsOn as string);
        }
      }
    }
  }

  // Kahn's algorithm — deps[A] = {B} means A depends on B (B must come before A)
  // Build reverse map: dependents[B] = {A} and count in-degrees
  const dependents = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const [id] of deps) {
    dependents.set(id as string, new Set());
    inDegree.set(id as string, 0);
  }
  for (const [id, d] of deps) {
    inDegree.set(id as string, d.size);
    for (const dep of d) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep)!.add(id as string);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const ordered: NodeTypeId[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(id as NodeTypeId);
    for (const dependent of dependents.get(id) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  if (ordered.length !== deps.size) {
    const remaining = [...deps.keys()].filter((id) => !ordered.includes(id as NodeTypeId));
    throw new Error(`Cycle detected in uniqueness constraint dependencies: ${remaining.join(', ')}`);
  }

  return ordered;
}

function collectEdgeTypeIds(expr: Expression): string[] {
  if (expr.type === 'traverse') {
    const ids: string[] = [];
    for (const step of expr.steps) {
      if (step.type === 'edge') ids.push(step.edgeTypeId);
    }
    return ids;
  }
  if (expr.type === 'function') return expr.args.flatMap(collectEdgeTypeIds);
  if (expr.type === 'arithmetic') return [...collectEdgeTypeIds(expr.left), ...collectEdgeTypeIds(expr.right)];
  if (expr.type === 'concat') return expr.parts.flatMap(collectEdgeTypeIds);
  return [];
}

// ── SQL compilation ──

async function searchCandidatesByConstraints(options: {
  nodeType: NodeTypeId;
  constraints: StoredUniquenessConstraints;
  extractedPropertyValues: Map<string, unknown>;
  resolvedEdgeTargets: Map<string, NodeId>;
  /**
   * Resolved KG node id for each TG ancestor name in scope. Consumed by
   * `edge_to: <ancestorName>` entries — the candidate must have *some*
   * edge to the resolved ancestor node (edge type unconstrained, per
   * `compound_scoping.md`'s "edge to the resolved round").
   *
   * Empty / missing entries cause the entry to bail (`canExecute=false`)
   * — the topological order guarantees ancestors resolve before the
   * compound-scoped child runs, so a missing entry means the ancestor
   * also failed to resolve and the child writes a fresh row.
   */
  resolvedAncestorNodes?: Map<string, NodeId>;
  teamId: TeamId;
}): Promise<CandidateResult[]> {
  const {
    nodeType,
    constraints,
    extractedPropertyValues,
    resolvedEdgeTargets,
    resolvedAncestorNodes,
    teamId,
  } = options;

  if (!constraints.length) return [];

  const qb = getKnowledgeQb(['node', 'edge', 'property', 'property_type']);

  // Build one query with OR'd constraint groups
  let query = qb
    .selectFrom('node')
    .where('node.node_type_id', '=', nodeType)
    .where('node.team_id', '=', teamId)
    .select(['node.id']);

  // Each constraint is an OR branch; within a constraint, all entries are ANDed
  const constraintConditions: Array<{
    constraintIndex: number;
    hasFuzzy: boolean;
    canExecute: boolean;
  }> = [];

  const orConditions: Array<(eb: any) => any> = [];

  for (let ci = 0; ci < constraints.length; ci++) {
    const constraint = constraints[ci];
    let hasFuzzy = false;
    let canExecute = true;
    const andConditions: Array<(eb: any) => any> = [];

    for (const entry of constraint) {
      const compiled = compileEntry(
        entry,
        extractedPropertyValues,
        resolvedEdgeTargets,
        resolvedAncestorNodes,
      );
      if (!compiled) {
        canExecute = false;
        break;
      }
      if (!isEdgeToEntry(entry) && entry.fuzzy) hasFuzzy = true;
      andConditions.push(compiled);
    }

    constraintConditions.push({ constraintIndex: ci, hasFuzzy, canExecute });

    if (canExecute && andConditions.length > 0) {
      orConditions.push((eb: any) => eb.and(andConditions.map((fn: any) => fn(eb))));
    }
  }

  if (orConditions.length === 0) return [];

  query = query.where((eb: any) =>
    orConditions.length === 1
      ? orConditions[0](eb)
      : eb.or(orConditions.map((fn: any) => fn(eb))),
  );

  const candidates = await query.limit(50).execute();

  if (!candidates.length) return [];

  // Fetch properties for candidates
  const candidateIds = candidates.map((c) => c.id);
  const allProps = await qb
    .selectFrom('property')
    .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
    .where('property.node_id', 'in', candidateIds)
    .where('property.team_id', '=', teamId)
    .select([
      'property.node_id',
      'property_type.id as property_type_id',
      'property_type.name',
      'property.value_text',
      'property.value_text_array',
      'property.value_number',
      'property.value_boolean',
    ])
    .execute();

  const propsByNode = new Map<string, Record<string, unknown>>();
  // Per-node, per-property-type, set of lower-cased text values (covers both single value_text
  // and multi-cardinality value_text_array).
  const propValuesByNode = new Map<string, Map<string, Set<string>>>();
  for (const p of allProps) {
    const nodeId = p.node_id as string;
    const propMap = propsByNode.get(nodeId) ?? {};
    const arrayDisplay = p.value_text_array && p.value_text_array.length > 0 ? p.value_text_array : null;
    propMap[p.name] = arrayDisplay ?? p.value_text ?? p.value_number ?? p.value_boolean;
    propsByNode.set(nodeId, propMap);

    const valMap = propValuesByNode.get(nodeId) ?? new Map<string, Set<string>>();
    const propTypeId = p.property_type_id as string;
    const valueSet = valMap.get(propTypeId) ?? new Set<string>();
    if (p.value_text) valueSet.add(p.value_text.toLowerCase());
    if (p.value_text_array) {
      for (const v of p.value_text_array) {
        if (v != null) valueSet.add(v.toLowerCase());
      }
    }
    if (valueSet.size > 0) valMap.set(propTypeId, valueSet);
    propValuesByNode.set(nodeId, valMap);
  }

  // Fetch edges for candidates (for constraint matching evaluation)
  const allEdges = await qb
    .selectFrom('edge')
    .where((eb: any) =>
      eb.or([
        eb('edge.source_node_id', 'in', candidateIds),
        eb('edge.target_node_id', 'in', candidateIds),
      ]),
    )
    .where('edge.team_id', '=', teamId)
    .select(['edge.source_node_id', 'edge.target_node_id', 'edge.edge_type_id'])
    .execute();

  // For each candidate, determine which constraint matched and whether it's exact
  return candidates.map((c) => {
    const nodeId = c.id as string;
    let bestConstraintIndex = 0;
    let bestExactCount = -1;
    let bestAllExact = false;

    for (const { constraintIndex, hasFuzzy, canExecute } of constraintConditions) {
      if (!canExecute) continue;
      const constraint = constraints[constraintIndex];
      let allMatch = true;
      let exactCount = 0;

      for (const entry of constraint) {
        if (isEdgeToEntry(entry)) {
          const resolvedAncestor = resolvedAncestorNodes?.get(entry.ancestorName);
          if (!resolvedAncestor) { allMatch = false; break; }
          const hasEdge = allEdges.some((e) => {
            const src = e.source_node_id as string;
            const tgt = e.target_node_id as string;
            const anc = resolvedAncestor as string;
            // Either direction — `edge_to` is direction-agnostic per spec.
            return (
              (src === nodeId && tgt === anc) ||
              (tgt === nodeId && src === anc)
            );
          });
          if (!hasEdge) { allMatch = false; break; }
          exactCount++;
          continue;
        }
        if (entry.expr.type === 'property') {
          const extractedVal = extractedPropertyValues.get(entry.expr.propertyTypeId);
          if (isBlankIdentityValue(extractedVal, CURRENT_LANGUAGE_VERSION)) { allMatch = false; break; }
          const candidateVals = propValuesByNode.get(nodeId)?.get(entry.expr.propertyTypeId);
          if (!candidateVals || candidateVals.size === 0) { allMatch = false; break; }
          const match = entry.fuzzy
            ? true // SQL already filtered by similarity
            : candidateVals.has(String(extractedVal).toLowerCase());
          if (!match) { allMatch = false; break; }
          if (!entry.fuzzy) exactCount++;
        } else if (entry.expr.type === 'traverse') {
          const step = entry.expr.steps[0] as EdgeStep;
          const resolvedTarget = resolvedEdgeTargets.get(step.edgeTypeId);
          if (!resolvedTarget) { allMatch = false; break; }
          const hasEdge = allEdges.some((e) => {
            if ((e.edge_type_id as string) !== step.edgeTypeId) return false;
            if (step.direction === 'outgoing') {
              return (e.source_node_id as string) === nodeId && (e.target_node_id as string) === (resolvedTarget as string);
            }
            return (e.target_node_id as string) === nodeId && (e.source_node_id as string) === (resolvedTarget as string);
          });
          if (!hasEdge) { allMatch = false; break; }
          exactCount++;
        }
      }

      if (allMatch && exactCount > bestExactCount) {
        bestConstraintIndex = constraintIndex;
        bestExactCount = exactCount;
        bestAllExact = !hasFuzzy;
      }
    }

    return {
      nodeId: c.id,
      properties: propsByNode.get(nodeId) ?? {},
      constraintIndex: bestConstraintIndex,
      allEntriesExact: bestAllExact,
    };
  });
}

function compileEntry(
  entry: ConstraintEntry,
  extractedPropertyValues: Map<string, unknown>,
  resolvedEdgeTargets: Map<string, NodeId>,
  resolvedAncestorNodes?: Map<string, NodeId>,
): ((eb: any) => any) | null {
  if (isEdgeToEntry(entry)) {
    const resolvedAncestor = resolvedAncestorNodes?.get(entry.ancestorName);
    if (!resolvedAncestor) return null;
    // Direction-agnostic: candidate must have *some* edge to the
    // resolved ancestor (per `compound_scoping.md`'s "edge to the
    // resolved round"). Edge type unconstrained.
    return (eb: any) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom('edge')
            .whereRef('edge.source_node_id', '=', 'node.id')
            .where('edge.target_node_id', '=', resolvedAncestor),
        ),
        eb.exists(
          eb
            .selectFrom('edge')
            .whereRef('edge.target_node_id', '=', 'node.id')
            .where('edge.source_node_id', '=', resolvedAncestor),
        ),
      ]);
  }

  const { expr } = entry;

  if (expr.type === 'property') {
    const value = extractedPropertyValues.get(expr.propertyTypeId);
    if (isBlankIdentityValue(value, CURRENT_LANGUAGE_VERSION)) return null;
    const lowerVal = String(value).toLowerCase();

    // Check both value_text (single-cardinality) and value_text_array (multi-cardinality)
    // by unnesting them into a single virtual list per row.
    if (entry.fuzzy) {
      return (eb: any) =>
        eb.exists(
          eb
            .selectFrom('property')
            .whereRef('property.node_id', '=', 'node.id')
            .where('property.property_type_id', '=', expr.propertyTypeId)
            .where(sql<boolean>`EXISTS (
              SELECT 1 FROM unnest(
                ARRAY[property.value_text]::text[] || COALESCE(property.value_text_array, ARRAY[]::text[])
              ) AS v
              WHERE v IS NOT NULL AND public.similarity(lower(v), ${lowerVal}) > 0.3
            )`),
        );
    }

    return (eb: any) =>
      eb.exists(
        eb
          .selectFrom('property')
          .whereRef('property.node_id', '=', 'node.id')
          .where('property.property_type_id', '=', expr.propertyTypeId)
          .where(sql<boolean>`EXISTS (
            SELECT 1 FROM unnest(
              ARRAY[property.value_text]::text[] || COALESCE(property.value_text_array, ARRAY[]::text[])
            ) AS v
            WHERE v IS NOT NULL AND lower(v) = ${lowerVal}
          )`),
      );
  }

  if (expr.type === 'traverse' && expr.steps.length === 1 && expr.steps[0].type === 'edge') {
    const step = expr.steps[0] as EdgeStep;
    const resolvedTarget = resolvedEdgeTargets.get(step.edgeTypeId);
    if (!resolvedTarget) return null;

    if (step.direction === 'outgoing') {
      return (eb: any) =>
        eb.exists(
          eb
            .selectFrom('edge')
            .whereRef('edge.source_node_id', '=', 'node.id')
            .where('edge.target_node_id', '=', resolvedTarget)
            .where('edge.edge_type_id', '=', step.edgeTypeId),
        );
    }

    return (eb: any) =>
      eb.exists(
        eb
          .selectFrom('edge')
          .whereRef('edge.target_node_id', '=', 'node.id')
          .where('edge.source_node_id', '=', resolvedTarget)
          .where('edge.edge_type_id', '=', step.edgeTypeId),
      );
  }

  // WITHIN(<dateField>, "<interval>") — temporal identity scope.
  // Restricts the candidate set to nodes whose date property is no older
  // than the given Postgres-style interval. Used for "don't create a
  // duplicate deal if one already exists in the last 6 months" patterns.
  if (
    expr.type === 'function' &&
    expr.fn === 'within' &&
    expr.args.length === 2 &&
    expr.args[0].type === 'property' &&
    expr.args[1].type === 'static' &&
    typeof expr.args[1].value === 'string'
  ) {
    const dateFieldId = expr.args[0].propertyTypeId;
    const intervalStr = expr.args[1].value;
    // Defer interval parsing to Postgres — it accepts the same shapes the
    // agent emits ("6 months", "1 year 3 months", etc.). If the string is
    // malformed, Postgres will throw at query time with a clear error.
    return (eb: any) =>
      eb.exists(
        eb
          .selectFrom('property')
          .whereRef('property.node_id', '=', 'node.id')
          .where('property.property_type_id', '=', dateFieldId)
          .where(
            sql<boolean>`property.value_date IS NOT NULL AND property.value_date >= NOW() - (${intervalStr})::interval`,
          ),
      );
  }

  // For function/arithmetic/concat expressions applied to property values,
  // we would need to compile them to SQL transforms. For now, these are uncommon
  // in initial templates, so log a warning and skip.
  logger.warn('[uniqueness_constraints] Unsupported expression type in SQL compilation', {
    exprType: expr.type,
  });
  return null;
}

// ── Subgraph expression resolver (in-memory dedup) ──

/**
 * Walk the subgraph's edges to collect every ancestor tempId reachable
 * from `nodeTempId` (direction-agnostic, cycle-guarded). Used by
 * in-memory dedup of compound-scoped nodes: two extracted nodes share
 * scope when they share at least one ancestor parent in the subgraph,
 * mirroring the AND-tuple semantics applied by the SQL search path.
 */
function collectSubgraphParents(
  nodeTempId: string,
  subgraph: ExtractedSubgraph,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [nodeTempId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const e of subgraph.edges) {
      let parent: string | null = null;
      if (e.targetTempId === id) parent = e.sourceTempId;
      else if (e.sourceTempId === id) parent = e.targetTempId;
      if (parent && !visited.has(parent) && parent !== nodeTempId) {
        visited.add(parent);
        queue.push(parent);
      }
    }
  }
  return visited;
}

// For in-batch dedup of multi-cardinality properties: gather every extracted value
// for (tempId, propertyTypeId) so two nodes can match on set-overlap rather than
// just first-value equality. For non-property expressions, falls back to the scalar resolver.
function gatherSubgraphValues(
  expr: Expression,
  nodeTempId: string,
  subgraph: ExtractedSubgraph,
): unknown[] {
  if (expr.type === 'property') {
    return subgraph.properties
      .filter(
        (p) =>
          p.parentTempId === nodeTempId &&
          (p.propertyTypeId as string) === expr.propertyTypeId &&
          p.value != null,
      )
      .map((p) => p.value);
  }
  const single = resolveExpressionInSubgraph(expr, nodeTempId, subgraph);
  return single == null ? [] : [single];
}

function resolveExpressionInSubgraph(
  expr: Expression,
  nodeTempId: string,
  subgraph: ExtractedSubgraph,
): unknown {
  if (expr.type === 'property') {
    const prop = subgraph.properties.find(
      (p) => p.parentTempId === nodeTempId && (p.propertyTypeId as string) === expr.propertyTypeId,
    );
    return prop?.value ?? null;
  }

  if (expr.type === 'traverse' && expr.steps.length === 1 && expr.steps[0].type === 'edge') {
    const step = expr.steps[0] as EdgeStep;
    for (const e of subgraph.edges) {
      if ((e.edgeType as string) !== step.edgeTypeId) continue;
      if (step.direction === 'outgoing' && e.sourceTempId === nodeTempId) return e.targetTempId;
      if (step.direction === 'incoming' && e.targetTempId === nodeTempId) return e.sourceTempId;
    }
    return null;
  }

  if (expr.type === 'static') return expr.value;

  if (expr.type === 'function') {
    const args = expr.args.map((a) => resolveExpressionInSubgraph(a, nodeTempId, subgraph));
    return applyFunction(expr.fn, args);
  }

  return null;
}

function applyFunction(fn: string, args: unknown[]): unknown {
  const val = args[0];
  if (val == null && fn !== 'coalesce' && fn !== 'isnull') return null;

  switch (fn) {
    case 'lower': return typeof val === 'string' ? val.toLowerCase() : val;
    case 'upper': return typeof val === 'string' ? val.toUpperCase() : val;
    case 'trim': return typeof val === 'string' ? val.trim() : val;
    case 'coalesce': return args.find((a) => a != null) ?? null;
    case 'isnull': return val == null;
    case 'tostring': return val == null ? null : String(val);
    case 'tonumber': return val == null ? null : Number(val);
    case 'length': return typeof val === 'string' ? val.length : null;
    case 'abs': return typeof val === 'number' ? Math.abs(val) : null;
    case 'round': return typeof val === 'number' ? Math.round(val) : null;
    case 'floor': return typeof val === 'number' ? Math.floor(val) : null;
    case 'ceil': return typeof val === 'number' ? Math.ceil(val) : null;
    default: return null;
  }
}

function stringSimilarity(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 1;

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };

  const aBigrams = bigrams(al);
  const bBigrams = bigrams(bl);
  let intersection = 0;
  for (const bg of aBigrams) {
    if (bBigrams.has(bg)) intersection++;
  }
  return (2 * intersection) / (aBigrams.size + bBigrams.size) || 0;
}

interface DedupGroup {
  canonicalTempId: string;
  mergedTempIds: string[];
}

interface FuzzyCandidate {
  tempIdA: string;
  tempIdB: string;
  constraintIndex: number;
}

interface DedupResult {
  exactGroups: DedupGroup[];
  fuzzyCandidates: FuzzyCandidate[];
}

function findDedupGroups(
  nodes: ExtractedNode[],
  constraints: StoredUniquenessConstraints,
  subgraph: ExtractedSubgraph,
): DedupResult {
  if (nodes.length < 2 || !constraints.length) return { exactGroups: [], fuzzyCandidates: [] };

  // Union-find for exact-only matches
  const parent = new Map<string, string>();
  for (const n of nodes) parent.set(n.tempId, n.tempId);

  function find(id: string): string {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)!)!);
      id = parent.get(id)!;
    }
    return id;
  }

  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }

  const fuzzyCandidates: FuzzyCandidate[] = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];

      for (let ci = 0; ci < constraints.length; ci++) {
        const constraint = constraints[ci];
        let allMatch = true;
        let hasFuzzy = false;

        for (const entry of constraint) {
          if (isEdgeToEntry(entry)) {
            // Compound-scope entries match when both nodes share at
            // least one ancestor in the extracted subgraph (irrespective
            // of edge type or direction). Mirrors the AND-tuple semantics
            // used by the SQL search path.
            const ancestorsA = collectSubgraphParents(a.tempId, subgraph);
            const ancestorsB = collectSubgraphParents(b.tempId, subgraph);
            let overlap = false;
            for (const p of ancestorsA) {
              if (ancestorsB.has(p)) { overlap = true; break; }
            }
            if (!overlap) { allMatch = false; break; }
            continue;
          }
          const valsA = gatherSubgraphValues(entry.expr, a.tempId, subgraph);
          const valsB = gatherSubgraphValues(entry.expr, b.tempId, subgraph);

          if (valsA.length === 0 || valsB.length === 0) { allMatch = false; break; }

          if (entry.fuzzy) {
            hasFuzzy = true;
            // Fuzzy: any pair within threshold counts
            let anyFuzzy = false;
            outer: for (const va of valsA) {
              for (const vb of valsB) {
                if (stringSimilarity(String(va), String(vb)) >= 0.3) {
                  anyFuzzy = true;
                  break outer;
                }
              }
            }
            if (!anyFuzzy) { allMatch = false; break; }
          } else {
            // Exact: require set-overlap (any shared value, case-insensitive)
            const setA = new Set(valsA.map((v) => String(v).toLowerCase()));
            let overlap = false;
            for (const vb of valsB) {
              if (setA.has(String(vb).toLowerCase())) { overlap = true; break; }
            }
            if (!overlap) { allMatch = false; break; }
          }
        }

        if (allMatch) {
          if (hasFuzzy) {
            fuzzyCandidates.push({ tempIdA: a.tempId, tempIdB: b.tempId, constraintIndex: ci });
          } else {
            union(a.tempId, b.tempId);
          }
          break; // one constraint match is enough
        }
      }
    }
  }

  // Collect exact groups
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const root = find(n.tempId);
    const arr = groups.get(root) ?? [];
    arr.push(n.tempId);
    groups.set(root, arr);
  }

  const exactGroups: DedupGroup[] = [];
  for (const [canonical, members] of groups) {
    if (members.length > 1) {
      exactGroups.push({
        canonicalTempId: canonical,
        mergedTempIds: members.filter((id) => id !== canonical),
      });
    }
  }

  return { exactGroups, fuzzyCandidates };
}

// ── Loading constraints from DB ──

async function loadConstraintsForNodeTypes(
  nodeTypeIds: NodeTypeId[],
  teamId: TeamId,
): Promise<Map<string, StoredUniquenessConstraints>> {
  if (!nodeTypeIds.length) return new Map();

  const qb = getKnowledgeQb(['node_type']);
  const rows = await qb
    .selectFrom('node_type')
    .where('node_type.id', 'in', nodeTypeIds)
    .where('node_type.team_id', '=', teamId)
    .select(['node_type.id', 'node_type.uniqueness_constraints'])
    .execute();

  const result = new Map<string, StoredUniquenessConstraints>();
  for (const row of rows) {
    const constraints = row.uniqueness_constraints as StoredUniquenessConstraints | null;
    if (constraints?.length) {
      result.set(row.id as string, constraints);
    }
  }
  return result;
}

// ── Constraint text format: parse & serialize ──

interface ConstraintParseResult {
  ok: boolean;
  entries?: ConstraintEntry[];
  error?: string;
}

function parseConstraintText(
  text: string,
  propertyByName: Map<string, string>,
  edgeByNodeTypeName: Map<string, { id: string; direction: 'outgoing' | 'incoming' }>,
): ConstraintParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Empty expression' };

  const parts = trimmed.split(/\s+AND\s+/i);
  const entries: ConstraintEntry[] = [];

  for (const raw of parts) {
    let part = raw.trim();
    if (!part) return { ok: false, error: 'Empty term in expression' };

    // Compound-scope: `edge_to:AncestorName` — bare-name reference to a
    // TG ancestor binding. Cannot be wrapped in FUZZY (resolution is
    // exact: edge exists or not).
    const edgeToMatch = part.match(/^edge_to:\s*(.+)$/i);
    if (edgeToMatch) {
      const ancestorName = edgeToMatch[1].trim();
      if (!ancestorName) return { ok: false, error: 'edge_to entry missing ancestor name' };
      entries.push({ kind: 'edge_to', ancestorName });
      continue;
    }

    // N1: time-window scope — `WITHIN(<dateProperty>, "<interval>")`.
    // The argument shape is `<bareName>, "<intervalString>"`; intervals
    // are quoted (single or double) Postgres interval strings ("6 months",
    // "1 year", "30 days", "1 year 3 months", …). Cannot be wrapped in
    // FUZZY — temporal-scope resolution is exact: the candidate's date
    // is in-range or not. Parser checks the structural shape; Postgres
    // catches malformed intervals at query time.
    const withinMatch = part.match(
      /^WITHIN\(\s*([^,]+?)\s*,\s*['"](.+?)['"]\s*\)$/i,
    );
    if (withinMatch) {
      const propName = withinMatch[1].trim();
      const intervalStr = withinMatch[2].trim();
      if (!propName) return { ok: false, error: 'WITHIN entry missing date property name' };
      if (!intervalStr) return { ok: false, error: 'WITHIN entry missing interval string' };
      const propId = propertyByName.get(propName.toLowerCase());
      if (!propId) return { ok: false, error: `Unknown property "${propName}" in WITHIN(...)` };
      entries.push({
        expr: {
          type: 'function',
          fn: 'within',
          args: [
            { type: 'property', propertyTypeId: propId } as Expression,
            { type: 'static', value: intervalStr } as Expression,
          ],
        } as Expression,
      });
      continue;
    }

    let fuzzy = false;
    const fuzzyMatch = part.match(/^FUZZY\((.+)\)$/i);
    if (fuzzyMatch) {
      fuzzy = true;
      part = fuzzyMatch[1].trim();
    }

    // Edge pattern: -[:Name]->
    const edgeMatch = part.match(/^-\[:(.+?)\]->$/);
    if (edgeMatch) {
      const name = edgeMatch[1].trim();
      const edge = edgeByNodeTypeName.get(name.toLowerCase());
      if (!edge) return { ok: false, error: `Unknown edge target "${name}"` };
      entries.push({
        expr: {
          type: 'traverse',
          steps: [{ type: 'edge', edgeTypeId: edge.id, direction: edge.direction } as EdgeStep],
          expression: { type: 'static', value: true } as Expression,
        } as Expression,
        ...(fuzzy ? { fuzzy: true } : {}),
      });
      continue;
    }

    // Property: bare name
    const propId = propertyByName.get(part.toLowerCase());
    if (propId) {
      entries.push({
        expr: { type: 'property', propertyTypeId: propId } as Expression,
        ...(fuzzy ? { fuzzy: true } : {}),
      });
      continue;
    }

    return { ok: false, error: `Unknown property or edge "${part}"` };
  }

  return { ok: true, entries };
}

function serializeConstraintEntries(
  entries: ConstraintEntry[],
  propIdToName: Map<string, string>,
  edgeIdToTargetName: Map<string, string>,
  edgeIdToSourceName: Map<string, string>,
): string {
  return entries
    .map((entry) => {
      if (isEdgeToEntry(entry)) {
        return `edge_to:${entry.ancestorName}`;
      }
      let token: string;
      const expr = entry.expr;
      if (expr.type === 'property' && expr.propertyTypeId) {
        token = propIdToName.get(expr.propertyTypeId) ?? expr.propertyTypeId.slice(0, 8);
      } else if (expr.type === 'traverse' && expr.steps?.[0]?.type === 'edge') {
        const step = expr.steps[0] as EdgeStep;
        const name =
          step.direction === 'incoming'
            ? edgeIdToSourceName.get(step.edgeTypeId)
            : edgeIdToTargetName.get(step.edgeTypeId);
        token = `-[:${name ?? step.edgeTypeId.slice(0, 8)}]->`;
      } else if (
        expr.type === 'function' &&
        expr.fn === 'within' &&
        expr.args.length === 2 &&
        expr.args[0].type === 'property' &&
        expr.args[1].type === 'static' &&
        typeof expr.args[1].value === 'string'
      ) {
        // N1: round-trip WITHIN(<dateProperty>, "<interval>") back to text.
        // Mirrors the parser at `parseConstraintText`; the interval is
        // quoted with double quotes for consistency with the canonical
        // surface syntax.
        const propId = expr.args[0].propertyTypeId;
        const propName = propIdToName.get(propId) ?? propId.slice(0, 8);
        const intervalStr = expr.args[1].value;
        token = `WITHIN(${propName}, "${intervalStr}")`;
      } else {
        token = expr.type;
      }
      return entry.fuzzy ? `FUZZY(${token})` : token;
    })
    .join(' AND ');
}

export {
  validateUniquenessConstraints,
  buildResolutionOrder,
  searchCandidatesByConstraints,
  resolveExpressionInSubgraph,
  findDedupGroups,
  loadConstraintsForNodeTypes,
  stringSimilarity,
  collectEdgeTypeIds,
  parseConstraintText,
  serializeConstraintEntries,
  isEdgeToEntry,
  constraintEntrySchema,
  uniquenessConstraintSchema,
  storedUniquenessConstraintsSchema,
};

export type {
  ConstraintEntry,
  ExpressionConstraintEntry,
  EdgeToConstraintEntry,
  UniquenessConstraint,
  StoredUniquenessConstraints,
  CandidateResult,
  ValidationResult,
  DedupGroup,
  DedupResult,
  FuzzyCandidate,
  ConstraintParseResult,
};
