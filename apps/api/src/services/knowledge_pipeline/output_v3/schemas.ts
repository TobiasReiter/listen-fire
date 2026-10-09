import { z } from 'zod';

import type { Expression } from './expression';

import { webhookGraphOutputConfigInputSchema } from '../../../adapters/webhook/configSchema';
import { expressionSchema } from './expression';

export { expressionSchema };
export type { Expression };

// Inlined to avoid circular import with configSchema.ts (which imports outputV3ConfigSchema from here)
const nodeRelationshipSchema = z.object({
  parentField: z.string().optional(),
  childField: z.string().optional(),
  type: z.enum(['reference', 'embed', 'attachment']),
});

// -- FieldRef: references a value on a node, edge, linked object, or trigger metadata --

const nodePropertyRefSchema = z.object({
  type: z.literal('node_property'),
  propertyTypeId: z.string(),
  old: z.boolean().optional(),
});

const edgePropertyRefSchema = z.object({
  type: z.literal('edge_property'),
  propertyTypeId: z.string(),
  old: z.boolean().optional(),
});

const linkedObjectRefSchema = z.object({
  type: z.literal('linked_object'),
  adapter: z.string(),
  actionNodeId: z.string(),
  field: z.string(),
});

const metaRefSchema = z.object({
  type: z.literal('meta'),
  key: z.string(),
});

const parentResultRefSchema = z.object({
  type: z.literal('parent_result'),
  field: z.enum(['created', 'external_id']),
});

export const fieldRefSchema = z.discriminatedUnion('type', [
  nodePropertyRefSchema,
  edgePropertyRefSchema,
  linkedObjectRefSchema,
  metaRefSchema,
  parentResultRefSchema,
]);

export type FieldRef = z.infer<typeof fieldRefSchema>;

// -- TraversalStep (discriminated union) --
// Defined before FilterExpression because filterConditionSchema references traversalStepSchema

/**
 * An ordering key. The movement language writes an EXPRESSION over the element
 * here (`ORDER BY \`Added At\``, `ORDER BY e-[:Signal]->.\`Discovered At\``);
 * configs saved before that carry the legacy `node_property` FieldRef, which is
 * the same fact under an older name and still validates.
 *
 */
const orderKeySchema = z.union([
  z.lazy(() => expressionSchema) as z.ZodType<Expression>,
  fieldRefSchema,
]);

const cardinalitySchema = z.object({
  mode: z.enum(['all', 'first', 'n']),
  limit: z.number().optional(),
  orderBy: orderKeySchema.optional(),
  orderDirection: z.enum(['asc', 'desc']).optional(),
});

const edgeStepSchemaBase = z.object({
  type: z.literal('edge'),
  edgeTypeId: z.string(),
  direction: z.enum(['outgoing', 'incoming']),
  /** TG-parity cypher-bracket alias (`-[name:Edge]->`). */
  alias: z.string().optional(),
  cardinality: cardinalitySchema.optional(),
  /**
   * Legacy FilterExpression slot — what v3 projections produce and what
   * the structured FilterEditor wrote historically. The engine evaluates
   * this via `evaluateFilterExpression`.
   */
  filter: z.unknown().optional(),
  /**
   * Expression-shaped per-step filter — produced by the text-field
   * expression editor. The engine evaluates this directly via
   * `evaluateExpression` against the destination position (cypher
   * analogue of `-[:Edge]->(c) WHERE ...`). Preferred over `filter`
   * for newly-authored TGs; the engine checks it first.
   */
  expressionFilter: z.unknown().optional(),
});

// filter is typed as FilterExpression at runtime via z.unknown(); the EdgeStep type below adds the proper typing
const edgeStepSchema = edgeStepSchemaBase;

const linkBackStepSchema = z.object({
  type: z.literal('linkBack'),
});

const resourceFilterSchema = z.object({
  resourceType: z.enum(['URL', 'EMAIL', 'WHATSAPP', 'FILE', 'TEXT']).optional(),
  hasDocument: z.boolean().optional(),
  mimeType: z.string().optional(),
  namePattern: z.string().optional(),
  includePayload: z.boolean().optional(),
});

const resourceStepSchema = z.object({
  type: z.literal('resource'),
  filter: resourceFilterSchema.optional(),
  cardinality: cardinalitySchema.optional(),
});

/**
 * Meta-edge step (TG-parity wave-0): `-[#extract { ... }]->`,
 * `-[#transform { ... }]->`, `-[#resources WHERE ...]->`.
 *
 * Carried structurally so storage / serialization can round-trip
 * meta-edges produced by the wave-0 parser; engine semantics land in
 * wave-1 R1/R2.
 */
// `config.description`, `config.data`, `config.plugin`, and `config.extra`
// carry Expression-typed values per F3's MetaEdgeStep shape in
// `packages/shared/expression/types.ts`. They're wired in via
// `z.lazy(() => expressionSchema)` to break the schemas ⇄ expression import
// cycle (expression.ts imports traversalStepSchema; metaEdgeStepSchema lives
// here and needs expressionSchema). The lazy ref resolves at parse time.
// Typed as z.ZodType<Expression> (not z.ZodTypeAny) so consumers that
// destructure the inferred type get the precise Expression shape, not
// `unknown`. The cast is safe — expressionSchema *is* z.ZodType<Expression>;
// the z.lazy wrapper just defers the access to runtime to break the
// module-init cycle between schemas.ts and expression.ts.
const lazyExpression = z.lazy(() => expressionSchema) as z.ZodType<Expression>;

const metaEdgeStepSchema = z.object({
  type: z.literal('meta_edge'),
  metaEdge: z.enum(['extract', 'transform', 'resources']),
  alias: z.string().optional(),
  config: z.object({
    description: lazyExpression.optional(),
    data: z.array(lazyExpression).optional(),
    plugin: lazyExpression.optional(),
    // W5-D3 — entity-level enrichment hooks. Each entry names a
    // registered transform and an `argument` expression resolved
    // per-emission against the just-extracted entity's properties.
    // See `plans/2026-05-19-tg-extraction-parity/_wave-3-stubs/W5-D3-entity-enrichment.md`.
    enrichWith: z.array(z.object({
      transform: lazyExpression,
      argument: lazyExpression,
    })).optional(),
    extra: z.record(z.string(), lazyExpression).optional(),
  }).optional(),
  expressionFilter: z.unknown().optional(),
  filter: resourceFilterSchema.optional(),
});

// W3-F5 — the dedicated alias-fan-out variant was removed. `#extract` is
// a traversal step by nature and traversals already yield N positions per
// emission; see plans/2026-05-19-tg-extraction-parity/_wave-3-stubs/W3-F5-extract-as-traversal.md.

export const traversalStepSchema = z.discriminatedUnion('type', [
  edgeStepSchema,
  linkBackStepSchema,
  resourceStepSchema,
  metaEdgeStepSchema,
]);

export type EdgeStep = z.infer<typeof edgeStepSchema>;
export type LinkBackStep = z.infer<typeof linkBackStepSchema>;
export type ResourceStep = z.infer<typeof resourceStepSchema>;
export type ResourceFilter = z.infer<typeof resourceFilterSchema>;
export type MetaEdgeStep = z.infer<typeof metaEdgeStepSchema>;
export type TraversalStep = z.infer<typeof traversalStepSchema>;

export { resourceStepSchema };

// -- FilterExpression: recursive MongoDB-style composable filter tree --

const filterOperatorSchema = z.enum([
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
  'in',
]);

export type FilterOperator = z.infer<typeof filterOperatorSchema>;

// FilterSelection — superset of Selection (property, edge_property, llm) plus context-level sources
export const filterSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('property'), propertyTypeId: z.string() }),
  z.object({ mode: z.literal('edge_property'), propertyTypeId: z.string() }),
  z.object({ mode: z.literal('llm'), prompt: z.string() }),
  z.object({ mode: z.literal('linked_object'), adapter: z.string(), field: z.string() }),
  z.object({ mode: z.literal('meta'), key: z.string() }),
  z.object({ mode: z.literal('parent_result'), field: z.enum(['created', 'external_id']) }),
  z.object({ mode: z.literal('resource'), field: z.enum(['name', 'url', 'type', 'document_url', 'content', 'contentType']) }),
]);

export type FilterSelection = z.infer<typeof filterSelectionSchema>;

const filterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

// Backward compat: convert old { field: FieldRef } → { traversal: [], selection: ... }
function normalizeFilterCondition(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const obj = input as Record<string, unknown>;
  // Already new format
  if ('selection' in obj) return obj;
  // Old format: { field: FieldRef, operator, value }
  if ('field' in obj && typeof obj.field === 'object' && obj.field !== null) {
    const field = obj.field as Record<string, unknown>;
    let selection: Record<string, unknown>;
    switch (field.type) {
      case 'node_property':
        selection = { mode: 'property', propertyTypeId: field.propertyTypeId };
        break;
      case 'edge_property':
        selection = { mode: 'edge_property', propertyTypeId: field.propertyTypeId };
        break;
      case 'linked_object':
        selection = { mode: 'linked_object', adapter: field.adapter, field: field.field };
        break;
      case 'meta':
        selection = { mode: 'meta', key: field.key };
        break;
      case 'parent_result':
        selection = { mode: 'parent_result', field: field.field };
        break;
      default:
        return obj;
    }
    return { traversal: [], selection, operator: obj.operator, value: obj.value };
  }
  return obj;
}

// FilterCondition and FilterExpression are defined after Selection and Aggregation
// (forward-declared here for type export, schema defined below)

type FilterCondition = {
  expression?: Expression;
  traversal: z.infer<typeof traversalStepSchema>[];
  selection?: Selection;
  aggregation?: Aggregation;
  operator?: z.infer<typeof filterOperatorSchema>;
  value?: z.infer<typeof filterValueSchema>;
};

export type { FilterCondition };

export type FilterExpression =
  | { $and: FilterExpression[] }
  | { $or: FilterExpression[] }
  | { $not: FilterExpression }
  | FilterCondition;

// -- Selection --

export const selectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('property'), propertyTypeId: z.string() }),
  z.object({ mode: z.literal('edge_property'), propertyTypeId: z.string() }),
  z.object({ mode: z.literal('llm'), prompt: z.string() }),
  z.object({ mode: z.literal('static'), value: z.string() }),
  z.object({ mode: z.literal('linked_object'), adapter: z.string(), field: z.string() }),
  z.object({ mode: z.literal('resource'), field: z.enum(['name', 'url', 'type', 'document_url', 'content', 'contentType']) }),
  z.object({ mode: z.literal('meta'), key: z.string() }),
  z.object({ mode: z.literal('parent_result'), field: z.enum(['created', 'external_id']) }),
]);

export type Selection = z.infer<typeof selectionSchema>;

// -- Aggregation --

export const aggregationSchema = z.object({
  function: z.enum([
    'first',
    'last',
    // The commutative singleton — exactly one, or the value is empty.
    'only',
    'count',
    'sum',
    'avg',
    'min',
    'max',
    'join',
    'collect',
    'llm',
  ]),
  separator: z.string().optional(),
  prompt: z.string().optional(),
  orderBy: orderKeySchema.optional(),
  orderDirection: z.enum(['asc', 'desc']).optional(),
});

export type Aggregation = z.infer<typeof aggregationSchema>;
export type OrderKey = z.infer<typeof orderKeySchema>;

// -- FilterCondition / FilterExpression schemas (defined here after Selection + Aggregation) --

const filterConditionSchema = z.preprocess(
  normalizeFilterCondition,
  z.object({
    expression: lazyExpression.optional(),
    traversal: z.array(traversalStepSchema).default([]),
    selection: selectionSchema.optional(),
    aggregation: aggregationSchema.optional(),
    operator: filterOperatorSchema.optional(),
    value: filterValueSchema.optional(),
  }),
);

export const filterExpressionSchema: z.ZodType<FilterExpression> = z.union([
  z.object({ $and: z.lazy(() => z.array(filterExpressionSchema)) }),
  z.object({ $or: z.lazy(() => z.array(filterExpressionSchema)) }),
  z.object({ $not: z.lazy(() => filterExpressionSchema) }),
  filterConditionSchema,
]);

// -- FieldMapping --

export const fieldMappingSchema = z.object({
  targetField: z.unknown(),
  expression: lazyExpression.optional(),
  // Legacy fields (used when expression is absent; normalized to expression at evaluation time)
  traversal: z.array(traversalStepSchema).default([]),
  selection: selectionSchema.optional(),
  aggregation: aggregationSchema.optional(),
  identity: z.enum(['unique', 'fuzzy', 'none']).optional(),
  dataType: z.enum(['string', 'number', 'boolean', 'json', 'documents']).optional(),
});

export type FieldMapping = z.infer<typeof fieldMappingSchema>;

// -- PromptEmbed: deterministic content slots in LLM prompts --

export const promptEmbedSchema = z.object({
  expression: lazyExpression.optional(),
  traversal: z.array(traversalStepSchema).default([]),
  selection: selectionSchema.optional(),
  aggregation: aggregationSchema.optional(),
  timing: z.enum(['before', 'after']).default('after'),
});

export type PromptEmbed = z.infer<typeof promptEmbedSchema>;

// -- ActionNode / BranchNode / TreeNode --

export type ActionNode = {
  kind: 'action';
  id: string;
  type: string;
  mode?: 'assert' | 'read';
  knowledgeNodeTypeId: string;
  traversal: TraversalStep[];
  linkTraversal?: TraversalStep[];
  adapterConfig: Record<string, unknown>;
  fieldMappings: FieldMapping[];
  embeds?: PromptEmbed[];
  storeLink?: boolean;
  children: {
    node: TreeNode;
    relationship: z.infer<typeof nodeRelationshipSchema>;
  }[];
};

export type BranchNode = {
  kind: 'branch';
  id: string;
  filter: FilterExpression;
  match?: TreeNode;
  noMatch?: TreeNode;
};

export type TreeNode = ActionNode | BranchNode;

const branchNodeSchema: z.ZodType<BranchNode> = z.object({
  kind: z.literal('branch'),
  id: z.string(),
  filter: filterExpressionSchema,
  match: z.lazy((): z.ZodType<TreeNode> => treeNodeSchema).optional(),
  noMatch: z.lazy((): z.ZodType<TreeNode> => treeNodeSchema).optional(),
});

const actionNodeSchema: z.ZodType<ActionNode> = z.object({
  kind: z.literal('action'),
  id: z.string(),
  type: z.string(),
  mode: z.enum(['assert', 'read']).optional(),
  knowledgeNodeTypeId: z.string(),
  traversal: z.array(traversalStepSchema),
  linkTraversal: z.array(traversalStepSchema).optional(),
  adapterConfig: z.record(z.string(), z.unknown()),
  fieldMappings: z.array(fieldMappingSchema),
  embeds: z.array(promptEmbedSchema).optional(),
  storeLink: z.boolean().optional(),
  children: z.array(
    z.object({
      node: z.lazy((): z.ZodType<TreeNode> => treeNodeSchema),
      relationship: nodeRelationshipSchema,
    }),
  ),
});

export const treeNodeSchema: z.ZodType<TreeNode> = z.union([actionNodeSchema, branchNodeSchema]);

// -- ActionTree --

export const actionTreeSchema = z.object({
  roots: z.array(treeNodeSchema),
});

export type ActionTree = z.infer<typeof actionTreeSchema>;

// -- Triggers --

export const extractionTriggerSchema = z.object({
  type: z.literal('extraction'),
  messageNodeTypeId: z.string(),
});

export const mutationTriggerSchema = z.object({
  type: z.literal('mutation'),
  nodeTypeId: z.string(),
  filter: filterExpressionSchema.optional(),
});

export const triggerSchema = z.discriminatedUnion('type', [
  extractionTriggerSchema,
  mutationTriggerSchema,
]);

export type ExtractionTrigger = z.infer<typeof extractionTriggerSchema>;
export type MutationTrigger = z.infer<typeof mutationTriggerSchema>;
export type Trigger = z.infer<typeof triggerSchema>;

// -- V3 Output Config --

export const outputV3ConfigSchema = z.object({
  version: z.literal(3),
  trigger: triggerSchema,
  actionTree: actionTreeSchema,
  webhookConfig: webhookGraphOutputConfigInputSchema.optional(),
});

export type OutputV3Config = z.infer<typeof outputV3ConfigSchema>;
