// R2's `Batcher` implementation — the orchestrator that runs the
// C1-C9 pipeline.
//
// Lifecycle:
//
//   1. The evaluator calls `registerExtract(inv)` and awaits a
//      promise. We push the invocation onto a per-root queue, keyed
//      by `scope.parentExtractSiteId` (root sites have none).
//   2. Likewise for `registerExtractValue(inv)` — folded into the
//      root's queue via `parentExtractSiteId`.
//   3. When the evaluator finishes the top-level traversal (or
//      explicitly calls `flush()`), we resolve each queued root by
//      running the full pipeline (C1-C9) once.
//
// The flush model accommodates "always batch" without forcing the
// evaluator to know about batch boundaries: nested `#extract` calls
// resolve back through the same root's pipeline.
//
// Synchronization shape: each invocation hands the evaluator a
// promise resolved by the pipeline run. The pipeline runs once per
// root; invocations attached to that root all resolve from the same
// LLM call's distribution.
//
// Behavioural parity (from legacy `extract.ts` + `consolidate.ts`):
//   - Pre-extraction transforms run before any LLM call.
//   - Skeleton pass fires when context-dependent transforms exist OR
//     entity count crosses the Opus threshold.
//   - Context-dependent transforms run AFTER the skeleton pass with
//     the extracted context threaded in.
//   - Full extraction is the single-pass call (or the second pass
//     after the skeleton).
//   - Validation failure → one retry with feedback (`callWithRetry`).
//   - Topological resolution order is parent-first (compound scoping
//     via R5's `edge_to:` falls out of the parent-pointer walk).

import type {
  Batcher,
  ExtractInvocation,
  ExtractValueInvocation,
  ExtractValueResult,
} from '../evaluator/batcher';
import type { EphemeralNode } from 'movement-engine/public/catalog';
import type { Adapter, Fact, Resource } from 'movement-engine/public/adapter';
import type { StoredUniquenessConstraints } from '../../../knowledge_pipeline/uniqueness_constraints';
import type { LlmClient } from 'movement-engine/public/models';

import { assembleBundle, type Bundle } from './bundle';
import { buildSyntheticSchema, type SyntheticSchema } from './schema_synthesis';
import {
  runPreExtractionTransforms,
  runSkeletonPass,
  shouldRunSkeleton,
  runContextDependentTransforms,
  runFullExtraction,
  runEntityEnrichment,
  hasEntityEnrichment,
  mergeExtractionResults,
  makeEnrichmentCache,
  type SkeletonResult,
  type FullExtractionResult,
  type EnrichmentInvoker,
  type EnrichmentOutput,
} from './phases';
import { rebindResults, type RebindResult } from './rebind';
import { type ApplyTarget } from './apply';
import { runInBatchDedup, type DedupJudge } from './dedup';

// ── Public injected dependencies ──────────────────────────────────────────

// The model call the batcher is handed is its own module (`./llm_call`), so
// the movement engine can name it without the batcher's storage types.
export type { LlmCallInput, LlmCallResult, LlmClient } from 'movement-engine/public/models';

/**
 * One transform's contribution back to the bundle. The dispatcher
 * (below) handles invocation; this is what comes back.
 */
export interface TransformDispatchResult {
  /** Free-form text appended to the bundle as a FRAGMENT segment. */
  additionalContent?: string;
  /** New resources unioned into the bundle. */
  resources?: Resource[];
  /** Optional bundle-level facts produced by the transform. */
  facts?: Fact[];
}

/**
 * Transform dispatcher — bridges the batcher to F4's registry +
 * the per-bundle transform schedule. The default implementation
 * (provided below) walks the bundle's `extractInvocations`'
 * ancestor aliases, finds registered transforms attached as
 * `#transform` steps in the same TG, and dispatches them.
 *
 * Wave-1 R6's composition runtime overrides this with its own
 * dispatcher when running standalone-TG mode; tests inject a noop.
 */
export interface TransformDispatcher {
  runPreExtraction(input: { bundle: Bundle }): Promise<TransformDispatchResult[]>;
  runContextDependent(input: {
    bundle: Bundle;
    extractedContextBySite: Record<string, Record<string, unknown>>;
  }): Promise<TransformDispatchResult[]>;
  /** True iff the dispatcher has any `dataDependency:
   *  'extracted_context'` transform registered for this bundle. The
   *  batcher consults this to decide whether to run the skeleton
   *  pass. */
  hasContextDependentTransforms(input: { bundle: Bundle }): boolean;
}

/** Fact extractor — wired to R8's per-resource fact-extraction lifecycle.
 *  Called once per resource that enters the bundle; the result is
 *  cached so the fact extraction doesn't re-run. */
export interface FactExtractor {
  extract(input: { resource: Resource }): Promise<Fact[]>;
}

/**
 * Identifies where to write a `#extract` site's resolved payload.
 * Re-exported from `./apply` for convenience.
 */
export type { ApplyTarget };

// ── Configuration ─────────────────────────────────────────────────────────

export interface BatchedExtractionBatcherConfig {
  /** LLM client (production: anthropic; tests: stub). */
  llm: LlmClient;
  /** Transform dispatcher. When omitted, a noop dispatcher is used. */
  transformDispatcher?: TransformDispatcher;
  /**
   * W5-D3 — entity-level enrichment invoker. When a `#extract` site
   * declares `enrich_with`, the batcher fires this once per emission
   * per binding to fetch external data, then re-extracts with that
   * data as additional context. When omitted, the default invoker
   * resolves transform names via the global registry; tests inject
   * a deterministic stub for hermetic coverage.
   */
  enrichmentInvoker?: EnrichmentInvoker;
  /** Fact extractor (R8). When omitted, fact extraction is skipped. */
  factExtractor?: FactExtractor;
  /** Apply target. When omitted, the batcher is read-only (used by
   *  the editor preview path and unit tests that don't want to
   *  exercise the adapter write surface). */
  applyTarget?: ApplyTarget;
  /** Per-`#extract`-siteId uniqueness constraints from the
   *  surrounding action. The schema-synthesis stage threads these
   *  into the entity shape so rebinding can drive consolidation. */
  perSiteUniquenessConstraints?: Map<string, StoredUniquenessConstraints>;
  /**
   * W6-D1 — resolver from `#extract`-siteId to its target type
   * identifier (e.g. KG NodeTypeId UUID). Required for the in-batch
   * dedup phase to group ephemerals across sites by target type. When
   * absent (or when the resolver returns undefined for every site),
   * dedup is skipped and the pipeline behaves as before W6-D1.
   *
   * Resolver shape rather than `Map` because siteIds are runtime-
   * allocated by `allocateSiteId` and the production wiring derives
   * them from action node metadata; tests typically derive type from
   * an alias substring of the siteId. Either source can compute on
   * demand without pre-populating a map.
   */
  perSiteTargetType?: (siteId: string) => string | undefined;
  /**
   * W6-D1 — LLM judge for fuzzy-but-matching dedup pairs. When omitted,
   * fuzzy pairs are NOT auto-merged (conservative). Production wires
   * this to the existing `engine/entity_match.ts:judgeEntityMatch`
   * surface; tests inject a deterministic stub.
   */
  dedupJudge?: DedupJudge;
  /** Hook fired once the pipeline finishes for a root. The runner
   *  uses this to record `tg_run` rows / surface apply results.
   *  Optional; absent → results discarded. */
  onApplied?: (input: {
    rootSiteId: string;
    bundle: Bundle;
    schema: SyntheticSchema;
    skeleton?: SkeletonResult;
    full: FullExtractionResult;
    rebind: RebindResult;
  }) => void | Promise<void>;
}

const NOOP_DISPATCHER: TransformDispatcher = {
  async runPreExtraction() {
    return [];
  },
  async runContextDependent() {
    return [];
  },
  hasContextDependentTransforms() {
    return false;
  },
};

/**
 * W5-D3 — default enrichment invoker. Looks the transform up in the
 * process-global registry and dispatches it as a context-dependent
 * input shape (the closest match — `extractedContext` carries the
 * argument value; `sourceNode` is intentionally synthetic since
 * entity-level enrichment isn't attached to a source-graph position).
 *
 * Production wires this by default; tests can inject a deterministic
 * stub via `BatchedExtractionBatcherConfig.enrichmentInvoker` for
 * hermetic coverage. When the named transform isn't registered the
 * invoker returns an empty output — the framework treats that as
 * "no enrichment available" and the second-pass prompt simply omits
 * the per-emission context block.
 */
const defaultRegistryEnrichmentInvoker: EnrichmentInvoker = {
  async invoke({ transformName, argument }): Promise<EnrichmentOutput> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getTransform } = require('../transforms/registry');
    const impl = getTransform(transformName);
    if (!impl) return {};
    try {
      const result = await impl.run({
        kind: 'context-dependent',
        sourceNode: { kind: 'ephemeral-node', nodeId: 'enrichment-synthetic', data: {}, originRef: { kind: 'transform', transformName, emissionIndex: 0 } },
        config: { argument },
        extractedContext: { argument },
      });
      // Project the transform's structural additions into the
      // text+data shape the enrichment prompt section consumes.
      const data: Record<string, unknown> = {};
      if (result.properties) Object.assign(data, result.properties);
      return Object.keys(data).length > 0 ? { data } : {};
    } catch {
      return {};
    }
  },
};

// ── Batcher ───────────────────────────────────────────────────────────────

/** Queued state for one root `#extract` site. */
interface RootState {
  rootInvocation?: ExtractInvocation;
  nestedExtracts: ExtractInvocation[];
  extractValues: ExtractValueInvocation[];
  /** Promise resolvers keyed by site id. `#extract` is a traversal —
   *  each site resolves to the full ephemeral array (W3-F5). */
  extractResolvers: Map<string, (nodes: EphemeralNode[]) => void>;
  extractValueResolvers: Map<string, (value: ExtractValueResult) => void>;
  /** Promise resolvers' rejecters — surfaced if the pipeline throws. */
  rejecters: Set<(err: unknown) => void>;
  /** Whether the pipeline has been kicked off for this root. Lets
   *  `registerExtract` for nested sites fall under the same run. */
  scheduled: boolean;
  /** The pipeline-run promise, once scheduled. */
  runPromise?: Promise<void>;
}

export class BatchedExtractionBatcher implements Batcher {
  private readonly roots = new Map<string, RootState>();

  constructor(private readonly config: BatchedExtractionBatcherConfig) {}

  async registerExtract(inv: ExtractInvocation): Promise<EphemeralNode[]> {
    // W3-F5 — `#extract` is a traversal; resolves to the full
    // ephemeral array (zero, one, or many).
    const rootId = inv.scope.parentExtractSiteId ?? inv.siteId;
    const state = this.getOrInit(rootId);

    if (rootId === inv.siteId) {
      state.rootInvocation = inv;
    } else {
      state.nestedExtracts.push(inv);
    }

    const nodes = new Promise<EphemeralNode[]>((resolve, reject) => {
      state.extractResolvers.set(inv.siteId, resolve);
      state.rejecters.add(reject);
    });

    // Schedule the pipeline run on the microtask queue so all
    // synchronous-following `registerExtract` / `registerExtractValue`
    // calls under the same root land in the queue before we flush.
    this.scheduleRun(rootId);

    return nodes;
  }

  async registerExtractValue(inv: ExtractValueInvocation): Promise<ExtractValueResult> {
    // Walk up the parent chain to find the root.
    const rootId = this.findRoot(inv.parentExtractSiteId);
    const state = this.getOrInit(rootId);
    state.extractValues.push(inv);

    const value = new Promise<ExtractValueResult>((resolve, reject) => {
      state.extractValueResolvers.set(inv.siteId, resolve);
      state.rejecters.add(reject);
    });

    this.scheduleRun(rootId);
    return value;
  }

  /**
   * Force any pending roots to flush. Called by the runner at the end
   * of a TG evaluation; tests call it directly to await pipeline
   * completion deterministically.
   */
  async flush(): Promise<void> {
    const runs: Promise<void>[] = [];
    for (const [rootId] of this.roots) {
      runs.push(this.scheduleRun(rootId));
    }
    await Promise.all(runs);
  }

  // ── internals ───────────────────────────────────────────────────────────

  private getOrInit(rootId: string): RootState {
    let state = this.roots.get(rootId);
    if (!state) {
      state = {
        nestedExtracts: [],
        extractValues: [],
        extractResolvers: new Map(),
        extractValueResolvers: new Map(),
        rejecters: new Set(),
        scheduled: false,
      };
      this.roots.set(rootId, state);
    }
    return state;
  }

  private findRoot(siteId: string): string {
    // Walk the parent pointer chain. The state map carries each
    // `#extract` invocation by its own siteId only when it's a root;
    // nested invocations live under their root's state. For a nested
    // EXTRACT_VALUE we may not have the parent's state directly, so
    // fall back to the siteId itself (which becomes the root).
    for (const [rootId, state] of this.roots) {
      if (state.rootInvocation?.siteId === siteId) return rootId;
      if (state.nestedExtracts.some((e) => e.siteId === siteId)) return rootId;
    }
    return siteId;
  }

  private scheduleRun(rootId: string): Promise<void> {
    const state = this.getOrInit(rootId);
    if (state.scheduled && state.runPromise) return state.runPromise;
    state.scheduled = true;
    state.runPromise = Promise.resolve().then(() => this.runRoot(rootId));
    return state.runPromise;
  }

  private async runRoot(rootId: string): Promise<void> {
    const state = this.roots.get(rootId);
    if (!state) return;
    if (!state.rootInvocation) {
      // Root never registered — shouldn't happen, but resolve any
      // dangling waiters with empty data so callers don't hang.
      for (const [, resolve] of state.extractResolvers) {
        resolve([]);
      }
      for (const [, resolve] of state.extractValueResolvers) {
        resolve({ value: null });
      }
      this.roots.delete(rootId);
      return;
    }

    try {
      const result = await this.runPipeline(rootId, state);
      // W3-F5 — every `#extract` site resolves to its full ephemeral
      // array (zero, one, or many).
      for (const [siteId, resolve] of state.extractResolvers) {
        const nodes = result.rebind.nodesBySite[siteId] ?? [];
        resolve(nodes);
      }
      for (const [siteId, resolve] of state.extractValueResolvers) {
        resolve({
          value: result.rebind.valuesBySite[siteId] ?? null,
          evidence: result.rebind.evidenceBySite[siteId],
        });
      }
    } catch (err) {
      for (const reject of state.rejecters) reject(err);
    } finally {
      this.roots.delete(rootId);
    }
  }

  private async runPipeline(
    rootId: string,
    state: RootState,
  ): Promise<{
    bundle: Bundle;
    schema: SyntheticSchema;
    skeleton?: SkeletonResult;
    full: FullExtractionResult;
    rebind: RebindResult;
  }> {
    const dispatcher = this.config.transformDispatcher ?? NOOP_DISPATCHER;

    // C1 — Bundle assembly.
    let bundle = assembleBundle({
      rootSiteId: rootId,
      rootInvocation: state.rootInvocation!,
      nestedExtractInvocations: state.nestedExtracts,
      extractValueInvocations: state.extractValues,
    });

    // C2 — Per-resource fact extraction (R8). Facts attach to the resource
    // they were extracted from (`4d_resources.md`): the resource then carries
    // them to every node it contributes to (via rebind → ephemeral.resources)
    // and they persist as part of `WriteInput.resources`. The transform phases
    // preserve resource identity (`mergeIntoBundle`), so attaching here is
    // safe ahead of C3.
    if (this.config.factExtractor) {
      for (const r of bundle.resources) {
        const fs = await this.config.factExtractor.extract({ resource: r });
        if (fs.length > 0) r.facts = [...(r.facts ?? []), ...fs];
      }
    }

    // C3 — Pre-extraction transforms.
    bundle = await runPreExtractionTransforms({ bundle, dispatcher });

    // C4 — Synthetic schema build.
    const perSiteStructuralSchema = new Map(
      bundle.extractInvocations.map((inv) => [inv.siteId, inv.outputSchema] as const),
    );
    const schema = buildSyntheticSchema({
      bundle,
      perSiteStructuralSchema,
      perSiteUniquenessConstraints: this.config.perSiteUniquenessConstraints,
    });

    // C5 — Skeleton pass (conditional).
    const hasContextDeps = dispatcher.hasContextDependentTransforms({ bundle });
    let skeleton: SkeletonResult | undefined;
    if (shouldRunSkeleton({ schema, hasContextDependentTransform: hasContextDeps })) {
      skeleton = await runSkeletonPass({
        bundle,
        schema,
        llm: this.config.llm,
      });

      // C6 — Context-dependent transforms (only meaningful after C5).
      bundle = await runContextDependentTransforms({
        bundle,
        extractedContextBySite: skeleton.extractedContextBySite,
        dispatcher,
      });
    }

    // C7 — Full extraction (first pass).
    let full = await runFullExtraction({
      bundle,
      schema,
      llm: this.config.llm,
      skeletonContext: skeleton,
    });

    // C7b — Entity-level enrichment (W5-D3). When any `#extract` site
    // in the bundle declared `enrich_with`, the framework runs the
    // implicit cycle: per-emission transform invocation, then a
    // second-pass extract with the enrichment outputs as additional
    // context. Per-emission identity is preserved by surfacing the
    // first-pass entities in the second-pass prompt and merging
    // results positionally (second overrides first for re-emitted
    // fields; first-pass-only fields are retained).
    if (hasEntityEnrichment(bundle)) {
      const invoker = this.config.enrichmentInvoker ?? defaultRegistryEnrichmentInvoker;
      // W6-D1 — per-run cache so duplicate ephemerals (which haven't been
      // deduped yet at this point) don't re-fire the transform for the
      // same argument value. Scoped to this pipeline run; discarded with
      // the local binding when `runPipeline` returns.
      const enrichmentCache = makeEnrichmentCache();
      const enrichmentContext = await runEntityEnrichment({
        bundle,
        firstPassBySite: full.resultsBySite,
        invoker,
        cache: enrichmentCache,
      });
      const enrichedSiteIds = new Set(
        bundle.extractInvocations
          .filter((inv) => inv.enrichWith && inv.enrichWith.length > 0)
          .map((inv) => inv.siteId),
      );
      const secondPass = await runFullExtraction({
        bundle,
        schema,
        llm: this.config.llm,
        skeletonContext: skeleton,
        enrichmentContext,
        firstPassBySite: full.resultsBySite,
        label: 'tg_full_extraction_enriched',
      });
      full = {
        resultsBySite: mergeExtractionResults({
          first: full.resultsBySite,
          second: secondPass.resultsBySite,
          enrichedSiteIds,
        }),
        modelUsed: secondPass.modelUsed,
      };
    }

    // C7c — In-batch dedup (W6-D1). Runs AFTER enrichment so the
    // enriched fields can disambiguate fuzzy pairs; runs BEFORE rebind
    // so the remap can collapse `nodesBySite` + rewrite
    // `intermediateEvidence.ephemeralRef` onto canonical ephemerals.
    //
    // The phase is opt-in via `perSiteTargetType` — when absent (every
    // pre-W6-D1 caller) it short-circuits to an empty remap and the
    // pipeline behaves exactly as before.
    //
    // To compute the remap we first need the materialised ephemerals
    // per site, which today only `rebindResults` produces. We run a
    // dedup-less first rebind to get them, then dedup, then a second
    // rebind passing the remap. The first rebind is pure + cheap (no
    // I/O, just array transforms); the cost is negligible relative to
    // the LLM call we just made.
    const preDedupRebind = rebindResults({ bundle, schema, fullResult: full });
    const dedup = await runInBatchDedup({
      bundle,
      schema,
      perSiteTargetType: this.config.perSiteTargetType,
      adapter: this.config.applyTarget?.adapter,
      nodesBySite: preDedupRebind.nodesBySite,
      judge: this.config.dedupJudge,
    });
    const rebind = dedup.remap.size > 0
      ? rebindResults({ bundle, schema, fullResult: full, dedupRemap: dedup.remap })
      : preDedupRebind;

    // C9 — Resources/facts persist via `WriteInput.resources` at the
    // per-action create/update now (`4d_resources.md`), not through a separate
    // apply stage. The target adapter (when wired) is still consulted for
    // in-batch dedup above; nothing to write here.

    if (this.config.onApplied) {
      await this.config.onApplied({
        rootSiteId: rootId,
        bundle,
        schema,
        skeleton,
        full,
        rebind,
      });
    }

    return { bundle, schema, skeleton, full, rebind };
  }
}
