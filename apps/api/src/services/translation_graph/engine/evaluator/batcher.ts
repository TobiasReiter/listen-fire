// Batcher interface — the contract R1 (this evaluator) calls and R2
// implements. The evaluator owns site-identification, scope capture, and
// schema synthesis; the batcher owns the actual LLM batching, prompt
// assembly, and result distribution.
//
// Why the split:
//   - The evaluator can resolve everything statically about a site
//     except the LLM result (siteId, description, data set, scope,
//     output schema).
//   - The batcher is the only piece that needs the LLM client, prompt
//     templating, and result re-binding. Keeping it behind an interface
//     means unit tests for the evaluator can use a deterministic stub
//     batcher with canned answers.

import type { z } from 'zod';
import type { EphemeralNode, ExpressionType, SourcePosition } from 'movement-engine/public/catalog';
import type { FieldEvidence } from 'movement-engine/public/adapter';
import type { FieldShape } from '../batched_extraction/schema_synthesis';

import { makeEphemeralPosition } from 'movement-engine/public/catalog';

/**
 * What `registerExtractValue` resolves to — the typed scalar plus the
 * extraction quote that justified it (3b §3.4). The evidence rides the value
 * through the evaluator's metadata channel onto `WriteInput.evidence`.
 */
export interface ExtractValueResult {
  value: unknown;
  evidence?: FieldEvidence;
}

// ── Invocation shapes ──────────────────────────────────────────────────────

/**
 * One `#extract` site. The evaluator constructs this when it encounters
 * a `-[name:#extract { description, data }]->` step and passes it to
 * the batcher. The batcher returns an `EphemeralNode` that the engine
 * binds to the step's alias (and uses as the resolved source position
 * for downstream traversal).
 */
export interface ExtractInvocation {
  /** Stable identifier for this extract site within the current TG run.
   *  Two distinct sites get distinct ids; the same site visited twice
   *  (e.g. once per parent position in a fan-out) gets distinct ids per
   *  fan-out arm. */
  siteId: string;
  /** The `description:` config from the meta-edge. Required at the
   *  syntax level — the batcher uses it to prompt the LLM. */
  description: string;
  /** Resolved `data:` values — a flat list of strings / File handles /
   *  arrays thereof. Already evaluated by the time the batcher sees it,
   *  so the batcher doesn't need expression-evaluator access. */
  data: unknown[];
  /** Zod schema for the ephemeral node's structural fields, synthesised
   *  by the engine from the surrounding action's target schema +
   *  `EXTRACT_VALUE` sites. The batcher uses it to constrain the LLM
   *  output. */
  outputSchema: z.ZodTypeAny;
  /** Lexical scope at the site. Used by the batcher for:
   *   - nested-#extract batching (parent's siteId is the batch root)
   *   - context inclusion in the prompt (resolved ancestor positions)
   */
  scope: ExtractScope;
  /**
   * W3-F4 — fields the LLM should produce for this `#extract` site,
   * collected upfront from the surrounding action's AST (every
   * `extract_value` description bound to this site's alias). Threaded
   * here so schema synthesis can fold them into `EntityShape.fields`
   * BEFORE the LLM call, surfacing the field-name hints in the
   * system prompt's entity guide.
   *
   * Without this, schema synthesis would source fields exclusively
   * from `bundle.extractValueInvocations`, which the evaluator only
   * registers AFTER `registerExtract`'s microtask has already
   * resolved `runRoot` — i.e. too late for the prompt the LLM sees.
   *
   * Optional: when absent, schema synthesis falls back to the legacy
   * `valuesByParent` source (the post-runRoot path). The two sources
   * are unioned in schema_synthesis with `entityFields` taking
   * precedence on field-name collisions.
   *
   * See `plans/2026-05-19-tg-extraction-parity/_wave-3-stubs/W3-F4-schema-presynthesis.md`.
   */
  entityFields?: FieldShape[];
  /**
   * W5-D3 — entity-level enrichment hooks. Presence triggers the
   * implicit extract → transform → re-extract cycle:
   *
   *   1. First-pass extract emits N entities (schema includes the
   *      argument fields, even when not bound to downstream mappings).
   *   2. Per-emission: each entry's transform is invoked with the
   *      argument's resolved value from the entity's properties.
   *   3. Second-pass extract re-runs with enrichment outputs added to
   *      the source context; per-emission identity is preserved.
   *
   * The evaluator captures the AST entries plus a runtime resolver
   * that reads each argument's value from a given emission's `data`
   * record. Transform names are pre-resolved to strings at invocation
   * construction so the batcher can dispatch without re-evaluating
   * the AST.
   *
   * See `plans/2026-05-19-tg-extraction-parity/_wave-3-stubs/W5-D3-entity-enrichment.md`.
   */
  enrichWith?: EnrichmentBinding[];
}

/**
 * W5-D3 — one resolved enrichment hook attached to an
 * `ExtractInvocation`. The evaluator builds these from the AST's
 * `MetaEdgeStep.config.enrichWith` entries:
 *
 *   - `transformName` is the resolved transform identifier (the AST's
 *     `transform` Expression evaluated at invocation construction —
 *     almost always a static string).
 *   - `argumentFieldName` is the sanitised field name to read off
 *     each emission's `data` record. Derived from the AST's
 *     `argument` Expression at invocation construction (today: from
 *     `extract_value("description")` or from an alias-rooted
 *     dot-chain `alias.property`). When the argument doesn't match a
 *     known shape, the field name is undefined and the framework
 *     resolves the argument to `null` per emission (the transform
 *     decides whether to no-op).
 */
export interface EnrichmentBinding {
  transformName: string;
  /** Sanitised field name on the emission data record. */
  argumentFieldName?: string;
  /** Human-readable description of the argument's source, surfaced in
   *  the second-pass prompt so the LLM understands what the enrichment
   *  context corresponds to. */
  argumentDescription?: string;
}

/**
 * One `EXTRACT_VALUE("...")` invocation, registered against its
 * enclosing `#extract` site. The batcher folds it into the LLM call
 * for that site and returns the typed scalar value.
 */
export interface ExtractValueInvocation {
  /** Stable identifier for this sub-invocation. */
  siteId: string;
  /** The `#extract` site this invocation belongs to. F3's
   *  `validateTgExpression` already enforces that an ancestral
   *  `#extract` exists; the evaluator confirms it at runtime as a
   *  defence-in-depth check. */
  parentExtractSiteId: string;
  /** The description argument the author wrote. */
  description: string;
  /** Inferred type from the expression-field context. */
  fieldType: ExpressionType;
  /** Optional enum options, when `fieldType.kind === 'enum'`. */
  enumOptions?: string[];
}

/**
 * Resolved scope captured at the `#extract` site. The evaluator
 * snapshots the relevant alias bindings + parent-extract pointer.
 * Kept opaque to the evaluator — the batcher decides how to use it
 * (prompt context, grouping key, etc.).
 */
export interface ExtractScope {
  /** SiteId of the nearest ancestral `#extract`, if any. Drives the
   *  batcher's "nested extracts share an LLM call" optimisation. */
  parentExtractSiteId?: string;
  /** All in-scope alias bindings at the moment the site is reached.
   *  Includes trigger aliases (`msg`) and any nested edge / meta-edge
   *  aliases bound by ancestors. */
  ancestorAliases: Record<string, SourcePosition>;
}

// ── Batcher interface ──────────────────────────────────────────────────────

/**
 * The batcher contract. R2 implements; R1 calls.
 *
 * Both methods are async because the actual LLM call is — but the
 * evaluator does NOT await the LLM directly. It awaits a promise that
 * the batcher resolves once it has collected enough invocations to
 * batch (or has decided to fire). Implementations may resolve eagerly
 * (one call per invocation, for debug) or lazily (collect a tree,
 * single call, distribute results).
 */
export interface Batcher {
  /**
   * Register a `#extract` site. Resolves to ALL materialised ephemerals
   * (zero, one, or many) — `#extract` is a traversal step, and
   * traversals yield N positions by nature per the description's
   * cardinality intent. The caller decides what to do with the array:
   * action-traversal terminal sites yield one source position per
   * emission; expression-level `#extract` walks the array as the
   * downstream cursor.
   *
   */
  registerExtract(inv: ExtractInvocation): Promise<EphemeralNode[]>;
  /** Register an `EXTRACT_VALUE` sub-invocation. Resolves to the typed scalar
   *  value plus its extraction-quote provenance. */
  registerExtractValue(inv: ExtractValueInvocation): Promise<ExtractValueResult>;
}

// ── Stub batcher (test-only) ────────────────────────────────────────────────

/**
 * Deterministic stub for unit tests. Returns canned values keyed by
 * `siteId` (or by alias-fallback for #extract). Used by the R1 test
 * suite; R2 replaces with the real implementation.
 *
 * Behaviour:
 *   - `registerExtract` looks up `extractResponses[siteId]`. The value
 *     is the `data` payload for the resulting ephemeral node (used by
 *     `getFieldValue` calls on the ephemeral position to resolve
 *     property reads). If the entry is absent, returns an empty
 *     ephemeral with `data = {}`.
 *   - `registerExtractValue` looks up `extractValueResponses[siteId]`.
 *     If absent, returns `null`.
 *
 * Test fixtures construct the responses map before invoking the
 * evaluator; the evaluator's siteId generation is deterministic for
 * a given AST + position, so tests can pre-compute the ids.
 */
export class StubBatcher implements Batcher {
  constructor(
    /** Responses keyed by siteId. Each value can be either a single
     *  `data` blob (collapses to a 1-element ephemeral array on
     *  resolution — the common test case) or an array of blobs
     *  (multi-emission tests). W3-F5 collapsed the two registration
     *  paths into one; both response shapes are honoured for test
     *  ergonomics. */
    private readonly extractResponses: Record<
      string,
      Record<string, unknown> | Record<string, unknown>[]
    > = {},
    private readonly extractValueResponses: Record<string, unknown> = {},
  ) {}

  async registerExtract(inv: ExtractInvocation): Promise<EphemeralNode[]> {
    const raw = this.extractResponses[inv.siteId];
    const items: Record<string, unknown>[] = raw === undefined
      ? [{}]
      : Array.isArray(raw)
        ? raw
        : [raw];
    return items.map((data, i) => {
      const nodeId = items.length === 1 ? `ephemeral:${inv.siteId}` : `ephemeral:${inv.siteId}#${i}`;
      return makeEphemeralPosition({
        data,
        originRef: { kind: 'extract' as const, extractStepId: inv.siteId, nodeId },
      });
    });
  }

  async registerExtractValue(inv: ExtractValueInvocation): Promise<ExtractValueResult> {
    if (inv.siteId in this.extractValueResponses) {
      return { value: this.extractValueResponses[inv.siteId] };
    }
    return { value: null };
  }
}
