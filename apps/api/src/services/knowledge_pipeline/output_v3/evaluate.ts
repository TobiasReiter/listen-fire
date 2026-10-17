// Expression evaluator — recursive evaluation of the expression AST
// unified expression model

import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';
import type { FieldConstraints, ResourceContext } from './adapters/types';
import type { Selection, ResourceFilter } from 'movement-engine/public/output-v3';
import type {
  Expression,
  AggregateExpr,
  FunctionExpr,
} from 'movement-engine/public/output-v3';
import type { OutputExecutionContext, ResolvedEdge } from './resolve';
import type { runKgQuery as RunKgQueryFn } from './kg_query_runner';

import {
  selectValues,
  aggregate,
  traverseWithEdges,
  resolveMetaKey,
  resolveTempToReal,
  loadResources,
  selectResourceField,
} from './resolve';
import { evaluateCondition } from './filter';
import { logger } from 'movement-engine/public/log';

import { compareOrderValues } from '#shared/expression/order_limit';

// ── Evaluation context ──

interface EvalContext {
  nodeIds: NodeId[];
  lastEdges: ResolvedEdge[];
  exec: OutputExecutionContext;
  constraints?: FieldConstraints;
  resourceContext?: ResourceContext; // set when inside a resource_traverse
}

// ── Main entry point ──

async function evaluateExpression(
  expr: Expression,
  ctx: EvalContext,
): Promise<unknown> {
  logger.info(`[ExprEval] evaluating type=${expr.type}`, {
    nodeIds: ctx.nodeIds,
    exprDetail: JSON.stringify(expr).slice(0, 200),
  });

  const result = await evaluateExpressionInner(expr, ctx);

  logger.info(`[ExprEval] result type=${expr.type}`, {
    value: result == null ? 'NULL' : JSON.stringify(result).slice(0, 200),
  });

  return result;
}

async function evaluateExpressionInner(
  expr: Expression,
  ctx: EvalContext,
): Promise<unknown> {
  switch (expr.type) {
    // ── Leaf expressions — delegate to selectValues for complex modes ──

    case 'property':
    case 'edge_property':
    case 'linked_object': {
      const selection = leafToSelection(expr);
      const values = await selectValues(
        ctx.nodeIds, ctx.lastEdges, selection, ctx.exec, ctx.constraints,
      );
      return unwrap(values);
    }

    case 'llm': {
      let prompt = expr.prompt;
      if (expr.promptExpression) {
        const resolved = await evaluateExpression(expr.promptExpression, ctx);
        prompt = String(resolved ?? '');
      }
      const selection = leafToSelection({ type: 'llm', prompt });
      const values = await selectValues(
        ctx.nodeIds, ctx.lastEdges, selection, ctx.exec, ctx.constraints,
      );
      return unwrap(values);
    }

    case 'resource': {
      // When inside a resource_traverse, read directly from the current ResourceContext
      if (ctx.resourceContext) {
        return selectResourceField(ctx.resourceContext, expr.field);
      }
      // Legacy: load all resources from context nodes (unfiltered)
      const selection = leafToSelection(expr);
      const values = await selectValues(
        ctx.nodeIds, ctx.lastEdges, selection, ctx.exec, ctx.constraints,
      );
      return unwrap(values);
    }

    case 'static':
      return expr.value;

    case 'meta':
      return resolveMetaKey(expr.key, ctx.exec);

    case 'parent_result': {
      const pr = ctx.exec.parentResult;
      if (!pr) return null;
      if (expr.field === 'created') return pr.created ?? null;
      if (expr.field === 'external_id') return pr.externalId ?? null;
      return null;
    }

    // `action_result` (write-handle reads) is a TG-engine concept — the v3
    // evaluator carries no applied-action map, so it resolves to null here.
    case 'action_result':
      return null;

    // ── Traversal — walk graph edges, evaluate child in new context ──

    case 'traverse': {
      const allNodeIds: NodeId[] = [];
      const allEdges: ResolvedEdge[] = [];
      let linkedBack = false;

      for (const nodeId of ctx.nodeIds) {
        const result = await traverseWithEdges(expr.steps, nodeId, ctx.exec);
        allNodeIds.push(...result.nodeIds);
        allEdges.push(...result.lastEdges);
        if (result.linkedBack) linkedBack = true;
      }

      if (allNodeIds.length === 0) {
        logger.info('[ExprEval] traverse yielded 0 nodes');
        return null;
      }

      // After linkBack, child expressions evaluate against the permanent graph
      const childExec = linkedBack
        ? { ...ctx.exec, changeset: null, tempToRealId: null }
        : ctx.exec;

      return evaluateExpression(expr.expression, {
        ...ctx,
        exec: childExec,
        nodeIds: allNodeIds,
        lastEdges: allEdges,
      });
    }

    // ── Resource traversal — load resources for context nodes, evaluate child per resource ──

    case 'resource_traverse': {
      const filter = expr.filter as ResourceFilter | undefined;
      const results: unknown[] = [];

      for (const nodeId of ctx.nodeIds) {
        const resources = await loadResources(nodeId, ctx.exec, filter);
        for (const resource of resources) {
          if (expr.expressionFilter) {
            const keep = await evaluateExpression(expr.expressionFilter, {
              ...ctx,
              resourceContext: resource,
            });
            if (!keep) continue;
          }
          const val = await evaluateExpression(expr.expression, {
            ...ctx,
            resourceContext: resource,
          });
          if (val != null) results.push(val);
        }
      }

      if (results.length === 0) return null;
      if (results.length === 1) return results[0];
      return results;
    }

    // ── Aggregation — reduces array to scalar ──

    case 'aggregate':
      return evaluateAggregate(expr, ctx);

    // ── Arithmetic — null propagation ──
    // Strip constraints: operands are intermediate values, not output

    case 'arithmetic': {
      const noConstraints = { ...ctx, constraints: undefined };
      const [left, right] = await Promise.all([
        evaluateExpression(expr.left, noConstraints),
        evaluateExpression(expr.right, noConstraints),
      ]);
      if (left == null || right == null) return null;
      const l = Number(left);
      const r = Number(right);
      if (isNaN(l) || isNaN(r)) return null;
      switch (expr.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? null : l / r;
        case '%': return r === 0 ? null : l % r;
      }
      break;
    }

    // ── Comparison ──
    // Strip constraints: operands are intermediate values used for comparison, not output

    case 'compare': {
      const noConstraints = { ...ctx, constraints: undefined };
      const [left, right] = await Promise.all([
        evaluateExpression(expr.left, noConstraints),
        evaluateExpression(expr.right, noConstraints),
      ]);
      // For array LHS (multi-node), use "any" semantics
      if (Array.isArray(left)) {
        return left.some((v) => evaluateCondition(v, expr.op, right));
      }
      return evaluateCondition(left, expr.op, right);
    }

    // ── Logical — short-circuit ──
    // Strip constraints: operands are intermediate booleans, not output

    case 'logical': {
      const noConstraints = { ...ctx, constraints: undefined };
      if (expr.op === 'and') {
        for (const operand of expr.operands) {
          const val = await evaluateExpression(operand, noConstraints);
          if (!val) return false;
        }
        return true;
      }
      // or
      for (const operand of expr.operands) {
        const val = await evaluateExpression(operand, noConstraints);
        if (val) return true;
      }
      return false;
    }

    case 'not': {
      const noConstraints = { ...ctx, constraints: undefined };
      const val = await evaluateExpression(expr.expression, noConstraints);
      return !val;
    }

    case 'negate': {
      const noConstraints = { ...ctx, constraints: undefined };
      const val = await evaluateExpression(expr.expression, noConstraints);
      if (val == null) return null;
      const n = Number(val);
      if (isNaN(n)) return null;
      return -n;
    }

    // ── Concat — null propagation (null in any part → null) ──
    // Strip constraints: parts are intermediate; the concatenated result is the output

    case 'concat': {
      const noConstraints = { ...ctx, constraints: undefined };
      const parts: string[] = [];
      for (const part of expr.parts) {
        const val = await evaluateExpression(part, noConstraints);
        if (val == null) return null;
        parts.push(String(val));
      }
      return parts.join('');
    }

    // ── Conditional — short-circuit (only evaluate the taken branch) ──
    // Condition is intermediate (no constraints); then/else are output paths (keep constraints)

    case 'conditional': {
      const condition = await evaluateExpression(expr.condition, { ...ctx, constraints: undefined });
      if (condition) {
        return evaluateExpression(expr.then, ctx);
      }
      return evaluateExpression(expr.else, ctx);
    }

    // ── Functions ──

    case 'function':
      return evaluateFunction(expr, ctx);

    // ── Knowledge graph queries ──

    case 'kg_exists': {
      const rows = await runKgQueryForV3({ kind: 'kg_exists', expr, ctx });
      return rows.length > 0;
    }

    case 'kg_value': {
      const rows = await runKgQueryForV3({ kind: 'kg_value', expr, ctx });
      if (rows.length === 0) return null;
      const column = Object.keys(rows[0])[0];
      const values = rows.map((r) => r[column] ?? null);
      if (values.length === 1) return values[0];
      return values;
    }

    case 'exists': {
      // The v3 evaluator (legacy KG-only path) doesn't yet implement EXISTS.
      // The TG engine implements it adapter-uniformly; v3 throws to flag any
      // configuration that slipped through here.
      throw new Error(
        `output_v3 evaluator: 'exists' expression is not implemented in the legacy v3 path. Use a translation graph instead.`,
      );
    }

    case 'at': {
      // `at` is multivalue scalar indexing, used by translation graphs to pick
      // an element out of a multi-cardinality field. v3 is the legacy KG-only
      // path and doesn't model multivalue at the expression level — throw to
      // make any slipped configuration visible.
      throw new Error(
        `output_v3 evaluator: 'at' expression is not implemented in the legacy v3 path. Use a translation graph instead.`,
      );
    }

    case 'extract_value':
    case 'alias_ref':
    case 'list':
    case 'object':
      // TG-parity AST variants land here only via the shared parser when
      // a TG-mode expression is fed into the legacy v3 evaluator. Not
      // yet implemented — see wave-1 R1/R2.
      throw new Error(
        `output_v3 evaluator: '${expr.type}' expression is not yet implemented — see wave-1 R1/R2`,
      );
  }
}

async function runKgQueryForV3(input: {
  kind: 'kg_exists' | 'kg_value';
  expr: Extract<Expression, { type: 'kg_exists' | 'kg_value' }>;
  ctx: EvalContext;
}): Promise<Record<string, unknown>[]> {
  const { kind, expr, ctx } = input;
  const noConstraints = { ...ctx, constraints: undefined };
  const paramValues: unknown[] = [];
  for (const p of expr.params) {
    paramValues.push(await evaluateExpression(p, noConstraints));
  }
  const cache = (ctx.exec.kgQueryCache ??= new Map<string, unknown>());
  // Lazy-loaded: kg_query_runner pulls in cypher → kysely → Prisma runtime,
  // which fails in unit-test envs that don't mock the chain.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runKgQuery } = require('./kg_query_runner') as { runKgQuery: typeof RunKgQueryFn };
  return runKgQuery({ kind, query: expr.query, paramValues, teamId: ctx.exec.teamId, cache });
}

// ── Aggregate evaluation ──

async function evaluateAggregate(
  expr: AggregateExpr,
  ctx: EvalContext,
): Promise<unknown> {
  const childResult = await evaluateExpression(expr.expression, ctx);
  const values = Array.isArray(childResult) ? childResult : [childResult];

  // `SORT` hands the members back in order rather than folding them. Here it
  // orders plain values by themselves; a key is read off each ELEMENT, and this
  // evaluator has no element scope to read one from.
  if (expr.fn === 'sort') {
    if (expr.orderBy !== undefined) {
      throw new Error(
        'SORT with a key is not available here — order the values themselves: SORT(list) or SORT(list, DESC)',
      );
    }
    const sorted = [...values].sort(compareOrderValues);
    return expr.orderDirection === 'desc' ? sorted.reverse() : sorted;
  }

  return aggregate(
    values,
    {
      function: expr.fn,
      separator: expr.separator,
      prompt: expr.prompt,
      orderBy: expr.orderBy,
      orderDirection: expr.orderDirection,
    },
    ctx.constraints,
  );
}

// ── Function evaluation ──

async function evaluateFunction(
  expr: FunctionExpr,
  ctx: EvalContext,
): Promise<unknown> {
  switch (expr.fn) {
    case 'isnull': {
      const val = await evaluateExpression(expr.args[0], ctx);
      return val == null;
    }

    case 'coalesce': {
      for (const arg of expr.args) {
        const val = await evaluateExpression(arg, ctx);
        if (val != null) return val;
      }
      return null;
    }

    case 'trim': {
      const val = await evaluateExpression(expr.args[0], ctx);
      return typeof val === 'string' ? val.trim() : val;
    }

    case 'lower': {
      const val = await evaluateExpression(expr.args[0], ctx);
      return typeof val === 'string' ? val.toLowerCase() : val;
    }

    case 'upper': {
      const val = await evaluateExpression(expr.args[0], ctx);
      return typeof val === 'string' ? val.toUpperCase() : val;
    }

    case 'length': {
      const val = await evaluateExpression(expr.args[0], ctx);
      if (typeof val === 'string') return val.length;
      if (Array.isArray(val)) return val.length;
      return null;
    }

    case 'abs': {
      const val = await evaluateExpression(expr.args[0], ctx);
      if (val == null) return null;
      const n = Number(val);
      return isNaN(n) ? null : Math.abs(n);
    }

    case 'round': {
      const val = await evaluateExpression(expr.args[0], ctx);
      if (val == null) return null;
      const n = Number(val);
      return isNaN(n) ? null : Math.round(n);
    }

    case 'floor': {
      const val = await evaluateExpression(expr.args[0], ctx);
      if (val == null) return null;
      const n = Number(val);
      return isNaN(n) ? null : Math.floor(n);
    }

    case 'ceil': {
      const val = await evaluateExpression(expr.args[0], ctx);
      if (val == null) return null;
      const n = Number(val);
      return isNaN(n) ? null : Math.ceil(n);
    }

    case 'tostring': {
      const val = await evaluateExpression(expr.args[0], ctx);
      if (val == null) return null;
      return String(val);
    }

    case 'tonumber': {
      const val = await evaluateExpression(expr.args[0], ctx);
      if (val == null) return null;
      const n = Number(val);
      return isNaN(n) ? null : n;
    }

    case 'multi': {
      const values = await Promise.all(expr.args.map((a) => evaluateExpression(a, ctx)));
      const flat: unknown[] = [];
      for (const v of values) {
        if (v == null) continue;
        if (Array.isArray(v)) flat.push(...v.filter((x) => x != null));
        else flat.push(v);
      }
      return flat;
    }

    case 'split': {
      const val = await evaluateExpression(expr.args[0], ctx);
      if (val == null) return [];
      const sepRaw = expr.args[1] !== undefined ? await evaluateExpression(expr.args[1], ctx) : ',';
      const sep = sepRaw == null ? ',' : String(sepRaw);
      return String(val)
        .split(sep)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    default:
      logger.warn(`[ExprEval] unknown function: ${expr.fn}`);
      return null;
  }
}

// ── Helpers ──

function leafToSelection(expr: Expression): Selection {
  switch (expr.type) {
    case 'property':
      return { mode: 'property', propertyTypeId: expr.propertyTypeId };
    case 'edge_property':
      return { mode: 'edge_property', propertyTypeId: expr.propertyTypeId };
    case 'llm':
      return { mode: 'llm', prompt: expr.prompt };
    case 'linked_object':
      return { mode: 'linked_object', adapter: expr.adapter, field: expr.field };
    case 'resource':
      return { mode: 'resource', field: expr.field };
    default:
      throw new Error(`leafToSelection: not a leaf selection type: ${(expr as Expression).type}`);
  }
}

function unwrap(values: unknown[]): unknown {
  if (values.length === 1) return values[0];
  return values;
}

export { evaluateExpression };
export type { EvalContext };
