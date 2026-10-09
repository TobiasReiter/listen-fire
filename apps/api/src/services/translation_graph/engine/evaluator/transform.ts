// `#transform` semantics — dispatch a transform via the F4 registry,
// apply its declared additions to the source graph, and bind the
// alias to the stream of newly-emitted ephemeral nodes.
//
// Transforms don't *move* the traversal — they *augment* the current
// source node. After a `#transform` step the traversal cursor stays at
// the same source position, but that position now has additional
// properties / edges / ephemeral neighbours that downstream traversals
// can walk into.
//
//   ("Transforms add ephemeral nodes to the source graph")

import type { Expression, MetaEdgeStep } from '#shared/expression/types';
import type { EphemeralNode, SourcePosition } from '../../types';

import { makeEphemeralPosition } from '../../types';
import { getTransform, type TransformImpl, type TransformInput, type TransformOutput, type EphemeralEmission } from '../transforms';

/**
 * Augmentations a transform applied to a source position. The
 * evaluator stores these on a per-evaluation augmentation map and
 * consults it when the source-side adapter is asked for a field or
 * a related node — that's how "transforms augment the source graph"
 * becomes visible to downstream traversal.
 *
 * Today the augmentations are read back by:
 *   - the evaluator's alias resolver (when the author writes
 *     `urls.text` on a transform alias)
 *   - the alias-rooted traverse over emitted ephemeral edges
 *
 * Wave-1 R3 (adapter base) will plug the augmentation map into the
 * adapter's `getFieldValue` / `getRelated` calls so the augmented
 * fields are observable via any traversal idiom. For R1 the
 * augmentations are exposed via the alias-binding stream.
 */
export interface TransformAugmentation {
  /** Extra properties added to the source node, keyed by property
   *  name. Authors read them via dot-access on the source node alias. */
  properties: Record<string, unknown>;
  /** Newly-emitted ephemeral nodes, grouped by the edge name they're
   *  attached to (or `__nodes__` for free-standing nodes). Authors
   *  walk into them via `-[edgeName]->`-style traversal off the
   *  source node, or read them directly via the transform alias. */
  emissions: Record<string, EphemeralNode[]>;
}

/**
 * Evaluate a `#transform` meta-edge step. Looks up the transform from
 * the F4 registry, validates the plugin name resolves, runs the
 * transform, and returns the augmentation + the stream of new
 * ephemeral nodes the alias should bind to.
 *
 * The caller is responsible for:
 *   - binding the returned `aliasStream` to `step.alias` in scope
 *     (when an alias is present)
 *   - merging `augmentation` into the per-position augmentation map
 *     so downstream traversals can read it
 */
export async function evaluateTransformStep(input: {
  step: MetaEdgeStep;
  sourcePosition: SourcePosition;
  /** Has the enclosing #extract already produced context? Used to
   *  pick the TransformInput variant. The R1 evaluator runs in a
   *  pre-extraction context by default; R6 / R2 will thread the
   *  extracted context once batching wires up. */
  extractedContext?: unknown;
  evalExpression: (expr: Expression) => Promise<unknown>;
}): Promise<{
  augmentation: TransformAugmentation;
  /** The values that should be bound to `step.alias` — the stream of
   *  emitted ephemeral nodes. Authors reach `urls.text` by indexing
   *  into this stream's properties. */
  aliasStream: EphemeralNode[];
}> {
  const { step, sourcePosition, extractedContext, evalExpression } = input;

  const pluginExpr = step.config?.plugin;
  if (!pluginExpr) {
    throw new Error(
      `translation_graph engine: -[${step.alias ?? ''}:#transform]-> step is missing required 'plugin' config.`,
    );
  }
  const pluginName = String((await evalExpression(pluginExpr)) ?? '');
  if (!pluginName) {
    throw new Error(
      `translation_graph engine: #transform step's 'plugin' config evaluated to an empty value.`,
    );
  }

  const impl = getTransform(pluginName);
  if (!impl) {
    throw new Error(
      `translation_graph engine: no transform registered with name "${pluginName}". Register via registerTransform() at boot.`,
    );
  }

  // Resolve `config.extra` parameters against the transform signature.
  // The signature declares typed params; for R1 we evaluate each
  // declared param's matching `extra` expression and pass the value
  // through verbatim — type-checking happens inside the transform
  // when it reads `input.config`.
  const config: Record<string, unknown> = {};
  if (step.config?.extra) {
    for (const [key, expr] of Object.entries(step.config.extra)) {
      config[key] = await evalExpression(expr);
    }
  }

  const dataDependency = impl.signature.dataDependency;
  const transformInput: TransformInput =
    dataDependency === 'extracted_context'
      ? {
          kind: 'context-dependent',
          sourceNode: sourcePosition,
          config,
          extractedContext: extractedContext ?? null,
        }
      : { kind: 'pre-extraction', sourceNode: sourcePosition, config };

  const output: TransformOutput = await impl.run(transformInput);

  // Project TransformOutput into our augmentation shape. The registry
  // returns ephemeral emissions opaque to it; the evaluator wraps each
  // as a SourcePosition of kind `ephemeral-node` carrying its
  // origin-ref (defaulting to {kind: transform, ...}).
  const augmentation: TransformAugmentation = {
    properties: output.properties ?? {},
    emissions: {},
  };
  let emissionIndex = 0;
  const aliasStream: EphemeralNode[] = [];

  const wrap = (emission: EphemeralEmission): EphemeralNode => {
    const idx = emissionIndex++;
    const nodeId = `ephemeral:${pluginName}#${idx}`;
    return makeEphemeralPosition({
      data: emission.data,
      originRef:
        emission.originRef ??
        ({ kind: 'transform', transformName: pluginName, emissionIndex: idx, nodeId } as const),
    });
  };

  if (output.edges) {
    for (const [edgeName, value] of Object.entries(output.edges)) {
      const emissions = Array.isArray(value) ? value : [value];
      const wrapped = emissions.map(wrap);
      augmentation.emissions[edgeName] = wrapped;
      aliasStream.push(...wrapped);
    }
  }

  if (output.nodes) {
    const wrapped = output.nodes.map(wrap);
    augmentation.emissions['__nodes__'] = wrapped;
    aliasStream.push(...wrapped);
  }

  return { augmentation, aliasStream };
}

// Re-export for test convenience.
export type { TransformImpl };
