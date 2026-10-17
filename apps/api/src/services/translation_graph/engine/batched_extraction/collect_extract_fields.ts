// W3-F4 — Pre-synthesise extract fields from the action AST.
//
// Why this exists:
//
// The synthetic schema's "entity guide" (the only place the LLM sees
// field-name hints upfront in the system prompt) is built from
// `EntityShape.fields`. Pre-W3-F4, `EntityShape.fields` was populated
// exclusively from `bundle.extractValueInvocations` — i.e. only AFTER
// the evaluator had actually fired the `EXTRACT_VALUE` invocations.
//
// In the field-mapping + action-traversal extract patterns, the
// evaluator awaits `batcher.registerExtract(...)` BEFORE the trailing
// `extract_value` invocations register. `registerExtract` schedules
// `runRoot` on the microtask queue; the queue drains before any
// follow-up synchronous code in the surrounding `traverse` runs.
// Schema synthesis therefore sees an empty `extractValueInvocations`
// list → the entity guide reads "(no scalar fields — structural only)"
// → the LLM is asked for `z.record(z.string(), z.unknown())` passthrough
// with no hints → returns `{}` → values come back NULL.
//
// The fix: walk the action's AST upfront — BEFORE we even call into the
// expression evaluator — to collect every `extract_value` description
// grouped by its ancestral `#extract` alias. The action layer threads
// the resulting map through `ExtractState.fieldsByAlias`; the extract
// evaluator looks the map up by `step.alias` when allocating each
// `ExtractInvocation` and attaches the resolved `FieldShape[]` as
// `inv.entityFields`. Schema synthesis prefers these upfront fields
// when present, so the entity guide carries the hints from the very
// first LLM call.
//
// Out of scope (handled elsewhere):
//   - Allocating siteIds upfront — siteIds remain runtime-allocated
//     in `evaluateExtractStep` / `fireExtractFromActionTraversal`.
//     This helper keys by AST alias because alias is the only stable
//     identifier visible to a static walk.
//   - Updating the structural Zod schema. The structural seam
//     (`perSiteStructuralSchema`) still lands as response-validation
//     and is independent of this entity-guide path.

import type { ActionNode, ExpressionType, SchemaFieldDescriptor, TGFieldMapping } from 'movement-engine/public/catalog';
import type { Expression } from 'movement-engine/public/catalog';
import type { TraversalStep } from 'movement-engine/public/output-v3';
import type { FieldShape } from './schema_synthesis';

import { listElementExpression, type ListElement } from '#shared/expression/types';

/**
 * Synthetic binding key for an `#extract` step the author left unaliased.
 * Shared by the static field collection here and the runtime lookup in
 * `evaluateExtractStep`, so an anonymous `#extract`'s `extract_value`
 * field hints still reach the entity guide. Without a shared key the
 * hints were dropped, the guide read "(no scalar fields — structural
 * only)", and every extracted value came back null.
 *
 * The `#` prefix can't appear in an author-supplied alias (cypher-bracket
 * identifiers), so it never collides with a real alias. One key per
 * action: an action with multiple unaliased `#extract` steps would share
 * it (their hints union) — that matches the single-`#extract`-per-action
 * shape authored TGs use; add an alias to disambiguate two.
 */
export const ANON_EXTRACT_ALIAS = '#anon-extract';

/**
 * Sanitise a description into the JSON-friendly field key
 * `schema_synthesis.sanitizeFieldName` writes onto ephemeral `data`.
 * Local copy (kept in sync with that module's helper) so consumers can
 * import the walker without pulling the schema-synthesis surface.
 *
 * Kept intentionally identical to the schema_synthesis helper: any
 * drift would cause the entity guide's field names to disagree with
 * the rebinder's `field.name` lookup, breaking value routing.
 */
function sanitizeFieldName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/** Project a target-adapter field descriptor into the broader
 *  `ExpressionType` system. Mirrors `evaluate.ts`'s
 *  `projectFieldDescriptorToExpressionType` so the static walker
 *  infers the same field type the runtime EXTRACT_VALUE invocation
 *  would have inferred from `expectedFieldType`. Kept local rather
 *  than imported to avoid a cycle: `evaluate.ts` imports
 *  schema_synthesis transitively. */
function fieldTypeForTargetField(
  fd: SchemaFieldDescriptor | undefined,
): { type: ExpressionType; enumOptions?: string[] } {
  if (!fd) return { type: { kind: 'string' } };
  switch (fd.kind) {
    case 'string':
      return { type: { kind: 'string' } };
    case 'number':
      return { type: { kind: 'number' } };
    case 'boolean':
      return { type: { kind: 'boolean' } };
    case 'date':
      return { type: { kind: 'date' } };
    case 'json':
      return { type: { kind: 'json' } };
    case 'enum':
      return {
        type: { kind: 'enum', values: fd.enumValues ?? [] },
        enumOptions: fd.enumValues ?? [],
      };
    case 'reference':
      return { type: { kind: 'string' } };
    case 'file':
      return { type: { kind: 'file' } };
  }
}

/**
 * Walk an action node's traversal + field-mapping expressions to
 * collect every `extract_value` description, grouped by its ancestral
 * `#extract` alias.
 *
 * Two structural patterns are recognised:
 *
 * 1. Action-traversal `#extract` (the fan-out path):
 *      action.traversal = [ ..., { meta_edge: extract, alias: 'opp' }, ... ]
 *      action.fieldMappings[i].expression = { type: 'extract_value', description: '...' }
 *    The `extract_value` lives at the top level of the field-mapping
 *    expression; its parent alias is the most-recent action-traversal
 *    `#extract` alias.
 *
 * 2. Field-mapping `extractTraversal`:
 *      action.fieldMappings[i].expression =
 *        { type: 'traverse', steps: [ { meta_edge: extract, alias: 'opp' } ],
 *          expression: { type: 'extract_value', description: '...' } }
 *    The `extract_value` lives inside the `traverse.expression`; its
 *    parent alias is determined from the nearest enclosing
 *    `traverse.steps` chain.
 *
 * Other expression shapes (`concat`, `conditional`, `arithmetic`,
 * `compare`, ...) recurse normally — `extract_value` discovered inside
 * them inherits the ancestral alias from the surrounding context.
 *
 * The returned map's values are `FieldShape`s ready to drop into
 * `EntityShape.fields`. Each carries `extractValueSiteId: undefined` —
 * the runtime EV invocation, once it actually registers, populates the
 * real siteId on `bundle.extractValueInvocations` and rebind keys
 * `valuesBySite` off that. We can't pre-allocate siteIds here without
 * widening the contract; the schema's entity-guide hint is what
 * matters for the LLM, and rebind routes by sanitised field name.
 */
export function collectExtractFieldsFromAction(input: {
  node: ActionNode;
  targetFieldsById?: Map<string, SchemaFieldDescriptor>;
}): Map<string, FieldShape[]> {
  const { node, targetFieldsById } = input;
  const result = new Map<string, FieldShape[]>();
  const pushField = (alias: string, field: FieldShape) => {
    const arr = result.get(alias) ?? [];
    // Dedupe by sanitised name so duplicate authoring (e.g. two
    // `extract_value("name")` mappings pointing at different target
    // fields) still produces a single entity-guide entry. The first
    // occurrence wins.
    if (!arr.some((f) => f.name === field.name)) {
      arr.push(field);
      result.set(alias, arr);
    }
  };

  // The action's own traversal may bind one or more `#extract` aliases.
  // We track the most-recent alias as the "default ancestor" for any
  // field-mapping whose expression doesn't introduce its own
  // `traverse`-wrapped `#extract` step. This is the action-traversal
  // fan-out pattern (#1 above).
  const actionExtractAliases = collectActionTraversalExtractAliases(node.traversal);

  // W5-D3 — walk every `#extract` step in the action AST and add any
  // `enrich_with` argument fields to the entity's first-pass schema.
  // These fields must be in the prompt even if no downstream
  // field-mapping consumes them — they exist to feed the per-emission
  // transform call.
  for (const { alias, fields } of collectEnrichWithFieldsFromAction(node)) {
    for (const field of fields) pushField(alias, field);
  }

  for (const mapping of node.fieldMappings) {
    if (!mapping.expression) continue;
    const { type, enumOptions } = fieldTypeForTargetField(
      targetFieldsById?.get(mapping.targetField),
    );
    // W3-T1 — `targetField` is the target adapter's property type
    // identifier. For the knowledge-graph adapter this is a
    // `PropertyTypeId` UUID (per `node.fieldMappings[].targetField`,
    // which is what `buildActionPlan` already routes through
    // `targetFieldsById`). Thread it onto the FieldShape so rebind
    // can stamp it onto `IntermediateEvidence.propertyTypeId` —
    // otherwise the property_type_id leak from the LLM's synthesised
    // field-name string would crash the Postgres UUID cast in
    // `knowledge_graph.ts:865`.
    const propertyTypeId = mapping.targetField;
    walkExpression({
      expr: mapping.expression,
      ancestorAliasStack: [...actionExtractAliases],
      onExtractValue: (description, alias) => {
        if (!alias) return; // no ancestral #extract — invalid TG, but defensively ignore
        pushField(alias, {
          name: sanitizeFieldName(description),
          description,
          type,
          ...(enumOptions ? { enumOptions } : {}),
          propertyTypeId,
        });
      },
    });
  }

  return result;
}

/**
 * Collect `#extract` aliases bound by an action's traversal. Order is
 * preserved so the field-mapping walker uses the most-recent alias as
 * the ancestral parent for top-level `extract_value` leaves (matching
 * runtime `extractState.stack` semantics within a single action).
 */
function collectActionTraversalExtractAliases(
  traversal: ActionNode['traversal'],
): string[] {
  const aliases: string[] = [];
  for (const step of traversal) {
    if (step.type === 'meta_edge' && step.metaEdge === 'extract') {
      // Anonymous `#extract` binds under the shared sentinel key so its
      // `extract_value` leaves still find an ancestral alias.
      aliases.push(step.alias ?? ANON_EXTRACT_ALIAS);
    }
  }
  return aliases;
}

/**
 * Recursive AST walk. Visits every `extract_value` leaf and invokes
 * `onExtractValue(description, ancestralAlias)` — where
 * `ancestralAlias` is the most-recent `#extract` alias bound by an
 * enclosing `traverse.steps` chain, falling back to the action-
 * traversal's ancestor stack when no inner `traverse` introduces one.
 *
 * The walker is structural — it doesn't evaluate expressions. It only
 * tracks which alias is the nearest enclosing `#extract`. Expression
 * kinds that don't introduce or consume aliases just recurse into
 * their sub-expressions.
 */
function walkExpression(input: {
  expr: Expression;
  ancestorAliasStack: string[];
  onExtractValue: (description: string, ancestralAlias: string | undefined) => void;
}): void {
  const { expr, ancestorAliasStack, onExtractValue } = input;
  const top = (): string | undefined =>
    ancestorAliasStack.length > 0
      ? ancestorAliasStack[ancestorAliasStack.length - 1]
      : undefined;

  switch (expr.type) {
    case 'extract_value':
      onExtractValue(expr.description, top());
      return;

    case 'traverse': {
      // A `traverse` may bind one or more `#extract` aliases via
      // `meta_edge: extract` steps. Push them onto the stack for the
      // duration of the inner expression walk so any `extract_value`
      // leaves see the nearest enclosing `#extract` as their parent.
      const innerStack = [...ancestorAliasStack];
      const traverseStep = expr as Expression & {
        steps?: TraversalStep[];
        expression?: Expression;
      };
      const steps = traverseStep.steps ?? [];
      for (const step of steps) {
        if (step.type === 'meta_edge' && step.metaEdge === 'extract') {
          innerStack.push(step.alias ?? ANON_EXTRACT_ALIAS);
        }
        // Step config may itself contain expressions (e.g. `#extract`'s
        // `description: Expression`, `data: Expression[]`). Those run
        // in the enclosing scope, NOT under the alias they're about to
        // bind. Walk them with the pre-step stack — matches runtime
        // behaviour where the description/data expressions evaluate
        // BEFORE registerExtract fires.
        const cfg = (step as { config?: Record<string, unknown> }).config;
        if (cfg) {
          for (const value of Object.values(cfg)) {
            walkConfigExpressions({
              value,
              ancestorAliasStack,
              onExtractValue,
            });
          }
        }
      }
      if (traverseStep.expression) {
        walkExpression({
          expr: traverseStep.expression,
          ancestorAliasStack: innerStack,
          onExtractValue,
        });
      }
      return;
    }

    case 'resource_traverse': {
      walkExpression({
        expr: (expr as { expression: Expression }).expression,
        ancestorAliasStack,
        onExtractValue,
      });
      return;
    }

    case 'exists': {
      // `where` is a boolean — extract_value inside it would be
      // semantically odd, but recurse defensively so the helper stays
      // total.
      const where = (expr as { where?: Expression }).where;
      if (where) {
        walkExpression({ expr: where, ancestorAliasStack, onExtractValue });
      }
      return;
    }

    case 'arithmetic':
    case 'compare': {
      const e = expr as Expression & { left: Expression; right: Expression };
      walkExpression({ expr: e.left, ancestorAliasStack, onExtractValue });
      walkExpression({ expr: e.right, ancestorAliasStack, onExtractValue });
      return;
    }

    case 'logical': {
      const e = expr as Expression & { operands: Expression[] };
      for (const o of e.operands) {
        walkExpression({ expr: o, ancestorAliasStack, onExtractValue });
      }
      return;
    }

    case 'not': {
      walkExpression({
        expr: (expr as { expression: Expression }).expression,
        ancestorAliasStack,
        onExtractValue,
      });
      return;
    }

    case 'concat': {
      const e = expr as Expression & { parts: Expression[] };
      for (const p of e.parts) {
        walkExpression({ expr: p, ancestorAliasStack, onExtractValue });
      }
      return;
    }

    case 'conditional': {
      const e = expr as Expression & {
        condition: Expression;
        then: Expression;
        else: Expression;
      };
      walkExpression({ expr: e.condition, ancestorAliasStack, onExtractValue });
      walkExpression({ expr: e.then, ancestorAliasStack, onExtractValue });
      walkExpression({ expr: e.else, ancestorAliasStack, onExtractValue });
      return;
    }

    case 'at': {
      const e = expr as Expression & { expression: Expression; index: Expression };
      walkExpression({ expr: e.expression, ancestorAliasStack, onExtractValue });
      walkExpression({ expr: e.index, ancestorAliasStack, onExtractValue });
      return;
    }

    case 'aggregate': {
      walkExpression({
        expr: (expr as { expression: Expression }).expression,
        ancestorAliasStack,
        onExtractValue,
      });
      return;
    }

    case 'function': {
      const e = expr as Expression & { args: Expression[] };
      for (const a of e.args) {
        walkExpression({ expr: a, ancestorAliasStack, onExtractValue });
      }
      return;
    }

    case 'list': {
      const e = expr as Expression & { elements: ListElement[] };
      for (const elem of e.elements) {
        walkExpression({ expr: listElementExpression(elem), ancestorAliasStack, onExtractValue });
      }
      return;
    }

    case 'kg_exists':
    case 'kg_value': {
      const e = expr as Expression & { params: Expression[] };
      for (const p of e.params) {
        walkExpression({ expr: p, ancestorAliasStack, onExtractValue });
      }
      return;
    }

    case 'llm': {
      const promptExpr = (expr as { promptExpression?: Expression }).promptExpression;
      if (promptExpr) {
        walkExpression({ expr: promptExpr, ancestorAliasStack, onExtractValue });
      }
      return;
    }

    // Leaves with no sub-expressions — nothing to do.
    case 'property':
    case 'edge_property':
    case 'static':
    case 'meta':
    case 'parent_result':
    case 'resource':
    case 'linked_object':
    case 'alias_ref':
      return;
  }
}

/**
 * Helper for walking `#extract` step config values that may be
 * `Expression` or `Expression[]` (e.g. `data`). Permissive: anything
 * that doesn't look like an Expression is silently ignored.
 */
function walkConfigExpressions(input: {
  value: unknown;
  ancestorAliasStack: string[];
  onExtractValue: (description: string, ancestralAlias: string | undefined) => void;
}): void {
  const { value, ancestorAliasStack, onExtractValue } = input;
  if (Array.isArray(value)) {
    for (const v of value) {
      walkConfigExpressions({ value: v, ancestorAliasStack, onExtractValue });
    }
    return;
  }
  if (value && typeof value === 'object' && 'type' in value) {
    walkExpression({
      expr: value as Expression,
      ancestorAliasStack,
      onExtractValue,
    });
  }
}

// ── W5-D3 — `enrich_with` argument field collection ────────────────────────

/**
 * Project an `enrich_with` argument expression into the field metadata
 * the LLM needs to populate it. Two shapes are recognised:
 *
 *  1. `extract_value("description")` — the argument is itself an
 *     extraction sub-prompt. Use the description verbatim as both the
 *     field label and the sanitised name source.
 *  2. Alias-rooted dot-chain (`alias.property`) — encoded as
 *     `{ type: 'traverse', aliasRoot, steps: [], expression: { type: 'property', propertyTypeId } }`.
 *     The trailing `propertyTypeId` doubles as the sanitised field
 *     name (authors using this shape are referencing a field they've
 *     already declared elsewhere; the engine just needs the LLM to
 *     populate it).
 *
 * Other shapes return `undefined`; the runtime treats the per-emission
 * argument as `null` and lets the transform decide whether to no-op.
 */
export function projectEnrichWithArgument(
  argument: Expression,
): { fieldName: string; description: string } | undefined {
  if (argument.type === 'extract_value') {
    return {
      fieldName: sanitizeFieldName(argument.description),
      description: argument.description,
    };
  }
  if (argument.type === 'traverse') {
    const t = argument as Expression & {
      aliasRoot?: string;
      steps?: TraversalStep[];
      expression?: Expression;
    };
    const steps = t.steps ?? [];
    const inner = t.expression;
    if (
      t.aliasRoot
      && steps.length === 0
      && inner
      && inner.type === 'property'
    ) {
      return {
        fieldName: sanitizeFieldName(inner.propertyTypeId),
        description: inner.propertyTypeId,
      };
    }
  }
  return undefined;
}

/**
 * Walk every `#extract` step in an action's traversal + field-mapping
 * expressions, collecting the `enrich_with` argument fields each step
 * requires. Result is grouped by `#extract` alias so the caller can
 * union the entries with the existing `extract_value`-derived field
 * list per alias (same shape as the rest of W3-F4 pre-collection).
 *
 */
export function collectEnrichWithFieldsFromAction(
  node: ActionNode,
): { alias: string; fields: FieldShape[] }[] {
  const out: { alias: string; fields: FieldShape[] }[] = [];

  const visitStep = (step: TraversalStep) => {
    if (step.type !== 'meta_edge') return;
    if (step.metaEdge !== 'extract') return;
    const enrich = step.config?.enrichWith;
    if (!enrich || enrich.length === 0) return;
    const fields: FieldShape[] = [];
    for (const entry of enrich) {
      const projected = projectEnrichWithArgument(entry.argument as Expression);
      if (!projected) continue;
      fields.push({
        name: projected.fieldName,
        description: projected.description,
        type: { kind: 'string' },
      });
    }
    if (fields.length > 0) {
      out.push({ alias: step.alias ?? ANON_EXTRACT_ALIAS, fields });
    }
  };

  for (const step of node.traversal) visitStep(step);

  // Field-mapping `#extract` shape — `enrich_with` may also live on
  // an `#extract` step nested inside a mapping expression's `traverse`.
  for (const mapping of node.fieldMappings) {
    if (!mapping.expression) continue;
    walkTraversalSteps(mapping.expression as Expression, visitStep);
  }

  return out;
}

/** Recursive descent collecting every `TraversalStep` from any
 *  `traverse` expression. Other expression shapes recurse so nested
 *  `traverse`s inside `concat` / `conditional` / etc. are visited. */
function walkTraversalSteps(
  expr: Expression,
  visit: (step: TraversalStep) => void,
): void {
  switch (expr.type) {
    case 'traverse': {
      const t = expr as Expression & {
        steps?: TraversalStep[];
        expression?: Expression;
      };
      for (const step of t.steps ?? []) visit(step);
      if (t.expression) walkTraversalSteps(t.expression, visit);
      return;
    }
    case 'resource_traverse':
      walkTraversalSteps((expr as { expression: Expression }).expression, visit);
      return;
    case 'arithmetic':
    case 'compare': {
      const e = expr as Expression & { left: Expression; right: Expression };
      walkTraversalSteps(e.left, visit);
      walkTraversalSteps(e.right, visit);
      return;
    }
    case 'logical': {
      for (const o of (expr as Expression & { operands: Expression[] }).operands) {
        walkTraversalSteps(o, visit);
      }
      return;
    }
    case 'not':
      walkTraversalSteps((expr as { expression: Expression }).expression, visit);
      return;
    case 'concat':
      for (const p of (expr as Expression & { parts: Expression[] }).parts) {
        walkTraversalSteps(p, visit);
      }
      return;
    case 'conditional': {
      const e = expr as Expression & {
        condition: Expression;
        then: Expression;
        else: Expression;
      };
      walkTraversalSteps(e.condition, visit);
      walkTraversalSteps(e.then, visit);
      walkTraversalSteps(e.else, visit);
      return;
    }
    case 'at': {
      const e = expr as Expression & { expression: Expression; index: Expression };
      walkTraversalSteps(e.expression, visit);
      walkTraversalSteps(e.index, visit);
      return;
    }
    case 'aggregate':
      walkTraversalSteps((expr as { expression: Expression }).expression, visit);
      return;
    case 'function':
      for (const a of (expr as Expression & { args: Expression[] }).args) {
        walkTraversalSteps(a, visit);
      }
      return;
    case 'list':
      for (const e of (expr as Expression & { elements: ListElement[] }).elements) {
        walkTraversalSteps(listElementExpression(e), visit);
      }
      return;
    case 'exists': {
      const where = (expr as { where?: Expression }).where;
      if (where) walkTraversalSteps(where, visit);
      return;
    }
    default:
      return;
  }
}
