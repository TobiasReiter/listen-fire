// `EXTRACT_VALUE("description")` semantics — register an LLM-scalar
// sub-invocation under the ancestral `#extract` context and return the
// typed scalar that the batcher resolves.
//
// F3's `validateTgExpression` enforces at validation time that every
// `EXTRACT_VALUE` site has an ancestral `#extract`. The runtime check
// here is defence-in-depth: a malformed TG body that slipped past
// validation still surfaces a clear error rather than calling the
// batcher with an undefined parent.

import type { ExpressionType } from '../../types';
import type { Batcher, ExtractValueResult } from './batcher';

import { allocateSiteId, type ExtractState } from './extract';

/**
 * Evaluate an `extract_value` expression. Registers the invocation
 * with the batcher and returns the resolved scalar.
 *
 * `fieldType` is inferred from the surrounding expression-field
 * context by the caller (the field-mapping pipeline / inferring layer
 * supplies it). When the evaluator can't infer (e.g. tests calling
 * `evaluateExpression` directly with no field context), it defaults
 * to `string` — the LLM still gets the description; only type
 * coercion is affected.
 */
export async function evaluateExtractValue(input: {
  description: string;
  batcher: Batcher;
  state: ExtractState;
  fieldType?: ExpressionType;
  enumOptions?: string[];
}): Promise<ExtractValueResult> {
  const { description, batcher, state, fieldType, enumOptions } = input;

  const parent = state.stack.length > 0 ? state.stack[state.stack.length - 1] : undefined;
  if (!parent) {
    throw new Error(
      `EXTRACT_VALUE("${description}") evaluated outside an ancestral #extract context. ` +
        `F3's validateTgExpression should have rejected this at save time — please report as a bug.`,
    );
  }

  const siteId = allocateSiteId({ kind: 'extract_value', state });

  return batcher.registerExtractValue({
    siteId,
    parentExtractSiteId: parent,
    description,
    fieldType: fieldType ?? { kind: 'string' },
    enumOptions: enumOptions ?? (fieldType?.kind === 'enum' ? fieldType.values : undefined),
  });
}
