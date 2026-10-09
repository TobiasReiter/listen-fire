// Expression AST for the unified value expression system
// unified expression model

import { z } from 'zod';

import type { Selection, Aggregation, TraversalStep } from '#shared/expression/types';

import { traversalStepSchema, fieldRefSchema } from './schemas';

// Re-export the shared Expression type as the single source of truth
export type { Expression } from '#shared/expression/types';
import type { Expression } from '#shared/expression/types';

// Convenience type aliases for narrowing within evaluator/resolver code
export type AggregateExpr = Extract<Expression, { type: 'aggregate' }>;
export type FunctionExpr = Extract<Expression, { type: 'function' }>;
export type TraverseExpr = Extract<Expression, { type: 'traverse' }>;
export type ResourceTraverseExpr = Extract<Expression, { type: 'resource_traverse' }>;

// ── Zod schema (recursive via z.lazy) ──

// The inferred output of this schema doesn't perfectly match Expression because
// traversalStepSchema uses z.unknown() for EdgeStep.filter. The cast is safe —
// the schema accepts a superset of valid Expressions.
const _expressionSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    // Leaves
    z.object({ type: z.literal('property'), propertyTypeId: z.string() }),
    z.object({ type: z.literal('edge_property'), propertyTypeId: z.string() }),
    z.object({ type: z.literal('static'), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
    z.object({ type: z.literal('llm'), prompt: z.string(), promptExpression: _expressionSchema.optional() }),
    z.object({ type: z.literal('meta'), key: z.string() }),
    z.object({ type: z.literal('parent_result'), field: z.enum(['created', 'external_id']) }),
    // `action_result` — a previously-applied action's result (write-handle
    // reads). `field` is 'created' / 'external_id' or a written-field /
    // result-data name. Compiler-emitted; serializer-led (no parser entry).
    z.object({ type: z.literal('action_result'), nodeId: z.string(), field: z.string() }),
    z.object({ type: z.literal('resource'), field: z.enum(['name', 'url', 'type', 'document_url', 'content', 'contentType']) }),
    z.object({ type: z.literal('linked_object'), adapter: z.string(), field: z.string() }),
    // TG-parity leaves (F3 — see plans/2026-05-19-tg-extraction-parity/expression_syntax.md)
    // `extract_value` — LLM-scalar extraction sub-prompt; valid only inside
    // an ancestral `#extract` meta-edge (enforced by validateTgExpression).
    z.object({ type: z.literal('extract_value'), description: z.string() }),
    // `alias_ref` — bare-name reference to an alias bound by an ancestor
    // cypher bracket or trigger binding.
    z.object({ type: z.literal('alias_ref'), name: z.string() }),
    // `list` — set literal used inside meta-edge config objects
    // (notably `#extract`'s `data:` parameter).
    // A member is a value or a spread of a collection's (`[a, ...xs]`).
    z.object({
      type: z.literal('list'),
      elements: z.array(z.union([
        _expressionSchema,
        z.object({ type: z.literal('spread'), expression: _expressionSchema }),
      ])),
    }),
    // `object` — object literal (`{ key: expr, … }`); keys are the target
    // API's verbatim spelling, values are ordinary expressions.
    z.object({
      type: z.literal('object'),
      entries: z.array(z.object({ key: z.string(), value: _expressionSchema })),
    }),
    // Traversal — `aliasRoot` (optional) starts the walk from a named
    // alias's bound position instead of the surrounding context. F3 emits
    // this for dot-chains (`opp.company`) and alias-rooted walks
    // (`msg-[:Author]->.email`).
    z.object({
      type: z.literal('traverse'),
      aliasRoot: z.string().optional(),
      steps: z.array(traversalStepSchema),
      expression: _expressionSchema,
    }),
    // Quantifier — `exists` returns true iff the traversal yields at least
    // one position satisfying `where` (or any position when `where` is
    // absent). Adapter-uniform substitute for canned predicates like
    // "is in list X".
    z.object({
      type: z.literal('exists'),
      steps: z.array(traversalStepSchema),
      where: _expressionSchema.optional(),
    }),
    // Resource traversal
    z.object({
      type: z.literal('resource_traverse'),
      filter: z.object({
        resourceType: z.enum(['URL', 'EMAIL', 'WHATSAPP', 'FILE', 'TEXT']).optional(),
        hasDocument: z.boolean().optional(),
        mimeType: z.string().optional(),
        namePattern: z.string().optional(),
      }).optional(),
      expressionFilter: _expressionSchema.optional(),
      expression: _expressionSchema,
    }),
    // Operations
    z.object({
      type: z.literal('arithmetic'),
      op: z.enum(['+', '-', '*', '/', '%']),
      left: _expressionSchema,
      right: _expressionSchema,
    }),
    z.object({
      type: z.literal('compare'),
      op: z.enum(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'in']),
      left: _expressionSchema,
      right: _expressionSchema,
    }),
    z.object({
      type: z.literal('logical'),
      op: z.enum(['and', 'or']),
      operands: z.array(_expressionSchema),
    }),
    z.object({ type: z.literal('not'), expression: _expressionSchema }),
    z.object({ type: z.literal('concat'), parts: z.array(_expressionSchema) }),
    z.object({
      type: z.literal('conditional'),
      condition: _expressionSchema,
      then: _expressionSchema,
      else: _expressionSchema,
    }),
    z.object({
      type: z.literal('at'),
      expression: _expressionSchema,
      index: _expressionSchema,
    }),
    // Aggregation
    z.object({
      type: z.literal('aggregate'),
      fn: z.enum(['first', 'last', 'count', 'sum', 'avg', 'min', 'max', 'join', 'collect', 'llm']),
      expression: _expressionSchema,
      separator: z.string().optional(),
      prompt: z.string().optional(),
      orderBy: fieldRefSchema.optional(),
      orderDirection: z.enum(['asc', 'desc']).optional(),
    }),
    // Functions
    z.object({
      type: z.literal('function'),
      fn: z.enum([
        'isnull', 'coalesce', 'trim', 'lower', 'upper', 'length',
        'abs', 'round', 'floor', 'ceil', 'tostring', 'tonumber',
        // Array constructors — produce a multi-cardinality value from
        // scalar inputs. Pair with the adapter-side `isMulti` write-path
        // so multi-select target fields receive a real array.
        'multi', 'split',
        // Recency-window predicate for uniqueness constraints —
        // `within(<dateProperty>, "<interval>")`. The uniqueness-constraint
        // validator (`ALLOWED_FUNCTIONS`), the SQL `compileExpressionToWhere`
        // path, and the Attio adapter's `resolveByConstraints` within branch
        // all consume this shape; it was absent from this persisted-schema
        // enum, so `setNodeUniquenessConstraints` built a valid `within`
        // expression that then failed the TG-body Zod parse on save —
        // rolling back the agent's whole batch (INV3, trial3-fix). Adding it
        // here closes the gap between the runtime contract and the schema.
        // within is a persistable function expr
        'within',
      ]),
      args: z.array(_expressionSchema),
    }),
    // Knowledge graph queries
    z.object({
      type: z.literal('kg_exists'),
      query: z.string(),
      params: z.array(_expressionSchema),
    }),
    z.object({
      type: z.literal('kg_value'),
      query: z.string(),
      params: z.array(_expressionSchema),
    }),
  ]),
);
const expressionSchema = _expressionSchema as z.ZodType<Expression>;

// ── Normalizers: convert old-format configs to expressions ──

function selectionToExpression(selection: Selection): Expression {
  switch (selection.mode) {
    case 'property':
      return { type: 'property', propertyTypeId: selection.propertyTypeId! };
    case 'edge_property':
      return { type: 'edge_property', propertyTypeId: selection.propertyTypeId! };
    case 'llm':
      return { type: 'llm', prompt: selection.prompt! };
    case 'static':
      return { type: 'static', value: selection.value! };
    case 'meta':
      return { type: 'meta', key: selection.key! };
    case 'parent_result':
      return { type: 'parent_result', field: selection.field as 'created' | 'external_id' };
    case 'linked_object':
      return { type: 'linked_object', adapter: selection.adapter!, field: selection.field! };
    case 'resource':
      return { type: 'resource', field: selection.field as 'name' | 'url' | 'type' | 'document_url' | 'content' | 'contentType' };
  }
}

function fieldMappingToExpression(
  traversal: TraversalStep[],
  selection: Selection,
  aggregation?: Aggregation,
): Expression {
  let expr = selectionToExpression(selection);

  if (traversal.length > 0) {
    expr = { type: 'traverse', steps: traversal, expression: expr };
  }

  if (aggregation) {
    expr = {
      type: 'aggregate',
      fn: aggregation.function,
      expression: expr,
      separator: aggregation.separator,
      prompt: aggregation.prompt,
      // An ordering key is an expression; the legacy `node_property` FieldRef
      // is the same read under its older name.
      orderBy:
        aggregation.orderBy !== undefined && aggregation.orderBy.type === 'node_property'
          ? { type: 'property', propertyTypeId: aggregation.orderBy.propertyTypeId }
          : aggregation.orderBy,
      orderDirection: aggregation.orderDirection,
    };
  }

  return expr;
}

export { expressionSchema, selectionToExpression, fieldMappingToExpression };
