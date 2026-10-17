// Transform/plugin registry — framework-global lookup for the
// `TransformSignature`s an author can dispatch via `-[…:#transform]->`
// traversal steps.
//
// The registry is process-global and statically populated at boot
// (R7 will register the two existing knowledge-pipeline plugins).
// Lookup by `signature.name`; duplicate registrations throw so a
// later wire-up doesn't silently shadow an earlier one.
//
// Two timing signatures are supported and surfaced through
// `TransformInput`'s discriminated union:
//
//   - `'pre-extraction'`  — the transform depends only on the source
//                            node it was attached to (matches
//                            `signature.dataDependency: 'none'`).
//   - `'context-dependent'` — the transform additionally needs the
//                             extracted context from an ancestral
//                             `#extract` (matches `signature.dataDependency:
//                             'extracted_context'`).
//
// The engine selects the correct variant based on the registered
// signature's `dataDependency` before invoking `run`. Implementations
// can switch on `input.kind` to access the extra context safely.
//
//   (#transform — transforms add ephemeral nodes to the source graph)

import type { HandbookSection } from 'movement-engine/lib/handbook_section';
import type { PluginDeclaration } from 'movement-engine/public/plugins';
import type { CostEnvelope } from 'movement-engine/lib/run_cost';
import type {
  EphemeralOriginRef,
  SourcePosition,
  TransformAdditions,
  TransformParam,
  TransformSignature,
} from 'movement-engine/services/translation_graph/types';

// ── TransformInput / TransformOutput ───────────────────────────────────────

/**
 * Pre-extraction input — the transform was scheduled before any
 * `#extract` ran (or sits outside an extraction context). `sourceNode`
 * is the position the `#transform` step was attached to; the transform
 * may inspect its properties / declared edges via the adapter, but no
 * extracted context is available yet.
 */
export type PreExtractionInput = {
  kind: 'pre-extraction';
  sourceNode: SourcePosition;
  /** Values the author wrote in the `config:` object of the
   *  `#transform` step. Keys correspond to `signature.params[].name`. */
  config: Record<string, unknown>;
};

/**
 * Context-dependent input — the transform sits under an `#extract`
 * step and the engine has already produced extracted context that the
 * transform may consume. `extractedContext` is opaque to the registry;
 * the transform's own contract determines what it reads from there
 * (R7 ports `linkedin-enrichment`, which consumes the extracted
 * person-record fields, into this shape).
 */
export type ContextDependentInput = {
  kind: 'context-dependent';
  sourceNode: SourcePosition;
  config: Record<string, unknown>;
  /** Extracted values from the enclosing `#extract` context. Shape is
   *  transform-specific. Keep `unknown` here — the registry doesn't
   *  validate it; the transform's own `run` does. */
  extractedContext: unknown;
};

export type TransformInput = PreExtractionInput | ContextDependentInput;

/**
 * Output of a transform's `run`. Mirrors `TransformSignature.additions`
 * but carries concrete values:
 *
 *   - `properties` — extra properties to attach to `sourceNode`.
 *   - `edges`      — outgoing ephemeral edges from `sourceNode`. Each
 *                    entry is keyed by edge name; the value is the
 *                    destination(s). The engine wraps these as
 *                    `SourcePosition` with `kind: 'ephemeral-node'`
 *                    carrying an `originRef` of
 *                    `{ kind: 'transform', transformName, emissionIndex }`.
 *   - `nodes`      — free-standing ephemeral nodes (rare). Same
 *                    ephemerality treatment as `edges`' destinations.
 *
 * Values are intentionally `unknown` at the registry boundary — the
 * declared `additions` schema is what the evaluator uses to type-check
 * downstream expressions. Per-transform input validation against
 * `signature.params` is also out of scope for the registry; the engine
 * applies it before `run` is invoked.
 */
export type TransformOutput = {
  properties?: Record<string, unknown>;
  edges?: Record<string, EphemeralEmission | EphemeralEmission[]>;
  nodes?: EphemeralEmission[];
  /**
   * How the run went, in the plugin's own vocabulary (`resolved`,
   * `no_match`, …). NOT an addition — nothing downstream reads it as data;
   * it rides the run record so a plugin that attached nothing can still say
   * why. A plugin that has nothing to report leaves it unset.
   */
  outcome?: string;
  /**
   * What this invocation cost, when the plugin prices its own work — the cost
   * envelope documented in `lib/run_cost.ts`, the same one an external
   * function returns. The engine charges it to the run under the plugin's
   * name. Leave it unset for work already priced where it happens (a model
   * call, a paid service client that reports its own cost) — reporting it here
   * as well would charge it twice.
   */
  cost?: CostEnvelope;
};

/**
 * A single ephemeral node emission. `data` is the node's properties +
 * edges as the transform produced them; the evaluator wraps it as a
 * `SourcePosition` with `kind: 'ephemeral-node'` and the appropriate
 * `originRef`.
 */
export type EphemeralEmission = {
  data: unknown;
  /** Optional override for the origin reference. Defaults to the
   *  `originRef` the engine derives from the transform name + emission
   *  order. Present for completeness — most transforms leave it unset. */
  originRef?: EphemeralOriginRef;
};

// ── TransformImpl ──────────────────────────────────────────────────────────

/**
 * Concrete implementation of a transform. Bound at registration:
 * `signature` declares the contract the editor and evaluator consume,
 * and `run` is the runtime body the engine invokes once per
 * `#transform` step (after parameter validation).
 *
 * The `signature.dataDependency` determines which `TransformInput`
 * variant `run` receives. Implementations may either narrow inside
 * `run` (`if (input.kind === 'context-dependent') …`) or be authored
 * to accept the specific variant their dependency implies — the
 * registry doesn't enforce a tighter type binding here so both
 * timings flow through the same registration API.
 */
export type TransformImpl = {
  signature: TransformSignature;
  run: (input: TransformInput) => Promise<TransformOutput>;
  /**
   * The plugin may cost money to run — a paid scrape or search, model calls,
   * or a price of its own on `TransformOutput.cost`. A priced plugin is not
   * started once its run has spent the cost cap (`MOVEMENT_MAX_RUN_COST_USD`).
   */
  priced?: true;
};

/**
 * The signature and price of a bundled plugin's implementation, taken from its
 * declaration in the engine package (`movement-engine/public/plugins`): what a
 * plugin accepts and costs is data every host reads, and this host only
 * supplies the body.
 */
export function implementing(declaration: PluginDeclaration): Pick<TransformImpl, 'signature' | 'priced'> {
  return { signature: declaration.signature, ...(declaration.priced ? { priced: true as const } : {}) };
}

// ── PluginManifest ─────────────────────────────────────────────────────────

/**
 * Static, construction-free description of a plugin — the transform-side
 * twin of `AdapterManifest` (see `../../adapter.ts`). Each plugin declares
 * its own manifest alongside its `TransformImpl`; the bundled aggregation
 * (`./register-bundled.ts:listPluginManifests`) is what catalogue surfaces
 * (the Plugins page, the movement catalog's `plugins` namespace) read.
 *
 * `params` / `additions` reference the plugin's `TransformSignature`
 * directly so the manifest can't drift from what the plugin actually
 * accepts and emits; `importName` is the identifier-safe projection of the
 * registry name (`importIdentifier`), i.e. exactly the name a movement
 * program writes in `import { vc_url_retrieval } from plugins`.
 */
export interface PluginManifest {
  /** Registry name the engine dispatches on — matches `signature.name`. */
  pluginName: string;
  /** The name a movement imports: `import { <importName> } from plugins`. */
  importName: string;
  /** Human label, free of internal jargon. */
  displayName: string;
  /** One or two honest sentences about what the plugin does, written for users. */
  description: string;
  /** Arguments the caller passes — mirrors `signature.params`. */
  params: readonly TransformParam[];
  /** Plain-language account of what the plugin adds to the data passing
   *  through it (new fields, linked records) — the prose twin of `additions`. */
  contextAdditions: string;
  /** Declared schema of those additions — mirrors `signature.additions`. */
  additions: TransformAdditions;
  /**
   * A conceptual handbook section for this plugin — what an author should know
   * BEFORE reaching for it: what it does, what each argument means, and where
   * in an extraction to put it. Assembled into the automation handbook as a
   * `plugin:<importName>` chapter, so it is bound by the same prose and probe
   * contract as every hand-written chapter.
   *
   * A different tier from `description` / `contextAdditions`, which are the
   * one-line catalogue entries the Plugins page shows.
   */
  handbookSection?: HandbookSection;
}

// ── Registry ───────────────────────────────────────────────────────────────

const registry = new Map<string, TransformImpl>();

/**
 * Register a transform under its signature name. Throws on duplicate
 * names — registration is meant to happen once at module-import
 * time, so a duplicate indicates two transforms competing for the
 * same identifier (and the editor / evaluator can't disambiguate).
 *
 * Tests that need to register and clean up transforms should call
 * `_resetTransformRegistry()` (test-only export) between cases.
 */
export function registerTransform(impl: TransformImpl): void {
  const { name } = impl.signature;
  if (registry.has(name)) {
    throw new Error(
      `Transform "${name}" is already registered. Each transform name must be unique across the framework-global registry.`,
    );
  }
  registry.set(name, impl);
}

/** Look up a transform by signature name. Returns `undefined` when no
 *  transform with that name is registered — callers (the evaluator)
 *  handle the missing-transform case explicitly. */
export function getTransform(name: string): TransformImpl | undefined {
  return registry.get(name);
}

/** All registered transforms, in registration order. Used by the
 *  editor's transform inspector (wave-2 E3) and by debugging surfaces. */
export function listTransforms(): TransformImpl[] {
  return Array.from(registry.values());
}

/**
 * Test-only — clears the registry. Production code should never call
 * this; transforms are registered once at module-import time.
 *
 * Exported under a `_`-prefixed name to signal intent.
 */
export function _resetTransformRegistry(): void {
  registry.clear();
}
