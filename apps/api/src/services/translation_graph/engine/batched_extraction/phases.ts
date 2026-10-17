// C3 / C5 / C6 / C7 — Pipeline phases.
//
// The four phases that bracket schema-synthesis + rebinding:
//
//   - C3 pre-extraction transforms (`dataDependency: 'none'`)
//   - C5 skeleton pass (identity + edges only, when warranted)
//   - C6 context-dependent transforms (`dataDependency: 'extracted_context'`)
//   - C7 full extraction (single-pass when skeleton skipped)
//
// Behavioural parity with legacy `extractFromSegments`:
//
//   - Pre-extraction transforms append `additionalContent` to the
//     bundle and surface new resources. We re-classify their output
//     as `FRAGMENT` segments and append to the bundle's segment list.
//   - Skeleton pass is triggered when (a) any registered transform on
//     the bundle has `dataDependency: 'extracted_context'`, OR (b) the
//     entity-count crosses the Opus threshold AND no pre-extraction
//     transform already enriched the bundle (matches legacy's
//     "no progressive branches" check).
//   - Validation failure → one retry with the validation issues
//     prepended to the user message (direct port of legacy
//     `extractSingleCall`'s retry loop).
//   - Model selection is `Opus` when entity density crosses the
//     threshold OR when the skeleton pass fires (legacy uses Opus for
//     all skeleton calls regardless).
//
// LLM access is injected via `LlmClient` so unit tests can stub.

import { z } from 'zod';

import type { Bundle, BundleSegment } from './bundle';
import type { SyntheticSchema } from './schema_synthesis';
import type {
  LlmCallInput,
  LlmCallResult,
  LlmClient,
  TransformDispatcher,
  TransformDispatchResult,
} from './batcher';
import type { EnrichmentBinding } from '../evaluator/batcher';
import type { Resource } from 'movement-engine/public/adapter';

import { ENTITY_DENSITY_OPUS_THRESHOLD, selectModel } from './schema_synthesis';
import { bundleHandleFor } from './bundle';

// ── C3: pre-extraction transforms ─────────────────────────────────────────

/**
 * Run every `dataDependency: 'none'` transform attached to the bundle
 * and merge their additions back into the bundle:
 *
 *   - `additionalContent` → appended as FRAGMENT segments
 *   - new resources       → unioned into `bundle.resources`
 *
 * Returns a new bundle (immutable update) so callers don't have to
 * worry about mid-pipeline state mutation surprises.
 */
export async function runPreExtractionTransforms(input: {
  bundle: Bundle;
  dispatcher: TransformDispatcher;
}): Promise<Bundle> {
  const results = await input.dispatcher.runPreExtraction({
    bundle: input.bundle,
  });
  if (results.length === 0) return input.bundle;

  return mergeIntoBundle(input.bundle, results);
}

// ── C5: skeleton pass ─────────────────────────────────────────────────────

export interface SkeletonResult {
  /** The identity properties + edges the skeleton call extracted, per
   *  `#extract` siteId. Each entry is the raw LLM response for that
   *  entity — rebinding consumes it the same way as the full
   *  extraction result. */
  identitiesBySite: Record<string, unknown>;
  /** Pass-through context the C6 transforms consume. */
  extractedContextBySite: Record<string, Record<string, unknown>>;
}

/**
 * Decide whether the skeleton pass should fire. Legacy logic:
 *
 *   hasProgressive = any branch.expand || branch.entityPlugins.length > 0
 *                    || dynamicExpandEdges has its edge
 *
 *   if (!hasProgressive && entityCount >= OPUS_THRESHOLD)  → two-phase
 *   else if (hasProgressive)                               → skeleton+expand
 *   else                                                   → single-pass
 *
 * In TG terms: "progressive" means any context-dependent transform is
 * registered against the bundle; "two-phase by density" is the same
 * decision.
 */
export function shouldRunSkeleton(input: {
  schema: SyntheticSchema;
  hasContextDependentTransform: boolean;
}): boolean {
  if (input.hasContextDependentTransform) return true;
  return input.schema.entityCount >= ENTITY_DENSITY_OPUS_THRESHOLD;
}

export async function runSkeletonPass(input: {
  bundle: Bundle;
  schema: SyntheticSchema;
  llm: LlmClient;
}): Promise<SkeletonResult> {
  const prompt = buildSkeletonPrompt(input.schema);
  const userMessage = renderBundleAsUserMessage(input.bundle, { numbered: true });
  // An empty source renders to an empty user message; Anthropic rejects
  // that with `400 messages.0: user messages must have non-empty content`.
  // Nothing to extract from nothing — yield an empty result without the
  // (invalid) call.
  if (userMessage.trim().length === 0) {
    return { identitiesBySite: {}, extractedContextBySite: {} };
  }
  // W3-F5 — every `#extract` site is array-shaped (the LLM emits one
  // object per entity per the description's cardinality). The skeleton
  // pass mirrors that: each siteId's slot is an array of identity-shaped
  // objects (zero, one, or many).
  const skeletonSchema = z.record(
    z.string(),
    z.array(z.record(z.string(), z.unknown())).optional(),
  );

  const raw = await callWithRetry({
    llm: input.llm,
    system: prompt,
    userMessage,
    label: 'tg_skeleton_extraction',
    model: 'opus',
    schema: skeletonSchema,
  });

  const identitiesBySite: Record<string, unknown> = {};
  const extractedContextBySite: Record<string, Record<string, unknown>> = {};
  const rawRecord = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  for (const [siteId, value] of Object.entries(rawRecord)) {
    if (Array.isArray(value)) {
      identitiesBySite[siteId] = value;
      // Flatten the array's entries together so context-dependent
      // transforms can read across emissions; preserves legacy
      // behaviour for the common single-emission case.
      const merged: Record<string, unknown> = {};
      for (const entry of value) {
        if (entry && typeof entry === 'object') {
          Object.assign(merged, flattenFieldValues(entry as Record<string, unknown>));
        }
      }
      extractedContextBySite[siteId] = merged;
    }
  }

  return { identitiesBySite, extractedContextBySite };
}

// ── C6: context-dependent transforms ──────────────────────────────────────

/**
 * After the skeleton pass, run any `dataDependency: 'extracted_context'`
 * transforms per identified entity. Their additions augment the bundle
 * (more segments / resources) before the full extraction call.
 *
 * In the legacy path this was the "step 2: run entity plugins" arm of
 * the per-entity expansion loop. We hoist it to bundle-level here — the
 * TG model is graph-augmenting transforms, not per-branch hooks.
 */
export async function runContextDependentTransforms(input: {
  bundle: Bundle;
  extractedContextBySite: Record<string, Record<string, unknown>>;
  dispatcher: TransformDispatcher;
}): Promise<Bundle> {
  const results = await input.dispatcher.runContextDependent({
    bundle: input.bundle,
    extractedContextBySite: input.extractedContextBySite,
  });
  if (results.length === 0) return input.bundle;
  return mergeIntoBundle(input.bundle, results);
}

// ── C6b: entity-level enrichment (W5-D3) ──────────────────────────────────

/**
 * W5-D3 — invoke a single transform with one emission's argument
 * value. The framework owns the cycle; the transform decides whether
 * to no-op (returns empty when its input is missing).
 *
 * Injected so tests can wire deterministic stubs without touching the
 * process-global transform registry. Production wires the default
 * impl (`registryEnrichmentInvoker`) at the batcher construction site.
 */
export interface EnrichmentInvoker {
  invoke(input: {
    transformName: string;
    /** The resolved argument value (typically a string read off the
     *  emission's `data` record by sanitised field name). `null` /
     *  `undefined` when the argument couldn't be resolved — the
     *  transform decides what to do with that. */
    argument: unknown;
  }): Promise<EnrichmentOutput>;
}

/**
 * One transform's per-emission contribution. The framework collates
 * these into a per-entity context block that the second-pass prompt
 * surfaces alongside the original source.
 */
export interface EnrichmentOutput {
  /** Free-form text to surface as the enrichment's contribution. Empty
   *  string → the transform decided to no-op for this emission. */
  text?: string;
  /** Structured data (kept as-is for prompt rendering). */
  data?: Record<string, unknown>;
}

/**
 * Per-emission enrichment results, keyed by `#extract` site then by
 * emission index. The second-pass prompt walks this map to build the
 * "Additional Context" section.
 */
export type EnrichmentContext = Record<
  string,
  Array<Array<{ transformName: string; output: EnrichmentOutput }>>
>;

/**
 * Per-transform-per-argument-value cache for `runEntityEnrichment`.
 * Scoped to one TG run (the batcher constructs a fresh `Map` per
 * pipeline invocation and discards after). Cache key:
 * `${transformName}::${JSON.stringify(argument)}` — deterministic for
 * any JSON-serialisable argument value.
 *
 * Motivation (W6-D1): dedup runs AFTER enrichment per the position
 * ruling, so two ephemerals that will collapse have already been
 * enriched independently. The cache makes repeat invocations with the
 * same argument value share a single transform call rather than
 * paying twice.
 *
 * Values that fail to serialise (cycles, non-JSON types) fall back to
 * `String(argument)` — still deterministic per-run, just with coarser
 * collision behaviour.
 */
export type EnrichmentCache = Map<string, EnrichmentOutput>;

export function makeEnrichmentCache(): EnrichmentCache {
  return new Map();
}

function enrichmentCacheKey(transformName: string, argument: unknown): string {
  let argRepr: string;
  try {
    argRepr = JSON.stringify(argument);
  } catch {
    argRepr = String(argument);
  }
  return `${transformName}::${argRepr ?? 'undefined'}`;
}

/**
 * Run enrichment for every `#extract` site that declared `enrich_with`.
 * Per-emission iteration: for each entity the LLM emitted, resolve
 * each binding's argument from the emission's `data` and invoke the
 * transform. Empty input → empty output; the transform decides.
 *
 * When a `cache` is passed, repeat `(transformName, argument)` pairs
 * resolve from cache instead of re-invoking the transform — the
 * W6-D1 mitigation for "enrichment runs before dedup, so duplicate
 * ephemerals enrich twice". The cache is per-batch (per pipeline run)
 * and the batcher constructs a fresh instance via `makeEnrichmentCache`.
 *
 * The result is consumed by `runFullExtractionWithEnrichment` to
 * augment the second-pass prompt's context section.
 */
export async function runEntityEnrichment(input: {
  bundle: Bundle;
  /** First-pass results keyed by site — the same shape as
   *  `FullExtractionResult.resultsBySite`. Each site's value is an
   *  array of emissions (W3-F5: `#extract` always returns an array).
   *  Per-emission objects carry fields wrapped as `{ evidence, value }`
   *  — `flattenFieldValues` unwraps them for argument resolution. */
  firstPassBySite: Record<string, unknown>;
  invoker: EnrichmentInvoker;
  /** W6-D1 — per-(transform, argument) cache scoped to one TG run.
   *  Skip the parameter to disable caching (legacy behaviour: every
   *  emission re-invokes the transform). */
  cache?: EnrichmentCache;
}): Promise<EnrichmentContext> {
  const ctx: EnrichmentContext = {};
  for (const inv of input.bundle.extractInvocations) {
    const bindings = inv.enrichWith;
    if (!bindings || bindings.length === 0) continue;
    const raw = input.firstPassBySite[inv.siteId];
    const emissions: Array<Record<string, unknown>> = Array.isArray(raw)
      ? raw.filter((e): e is Record<string, unknown> => e != null && typeof e === 'object')
      : [];
    if (emissions.length === 0) {
      ctx[inv.siteId] = [];
      continue;
    }
    const perSite: Array<Array<{ transformName: string; output: EnrichmentOutput }>> = [];
    for (const emission of emissions) {
      const flat = flattenFieldValues(emission);
      const perEmission: Array<{ transformName: string; output: EnrichmentOutput }> = [];
      for (const binding of bindings) {
        const argument = binding.argumentFieldName ? flat[binding.argumentFieldName] : undefined;
        let output: EnrichmentOutput | undefined;
        const cacheKey = input.cache
          ? enrichmentCacheKey(binding.transformName, argument)
          : null;
        if (cacheKey !== null && input.cache!.has(cacheKey)) {
          output = input.cache!.get(cacheKey)!;
        } else {
          output = await input.invoker.invoke({
            transformName: binding.transformName,
            argument,
          });
          if (cacheKey !== null) {
            input.cache!.set(cacheKey, output);
          }
        }
        perEmission.push({ transformName: binding.transformName, output });
      }
      perSite.push(perEmission);
    }
    ctx[inv.siteId] = perSite;
  }
  return ctx;
}

/**
 * True iff any `#extract` site in the bundle declared `enrich_with`.
 * The batcher uses this to decide whether to run the second-pass
 * extract path.
 */
export function hasEntityEnrichment(bundle: Bundle): boolean {
  return bundle.extractInvocations.some(
    (inv) => inv.enrichWith && inv.enrichWith.length > 0,
  );
}

// ── C7: full extraction ───────────────────────────────────────────────────

export interface FullExtractionResult {
  /** Raw LLM response, validated against the synthetic schema. Keys
   *  are `#extract` siteIds; values are the entity payloads. */
  resultsBySite: Record<string, unknown>;
  /** Which model the call actually used — surfaced for debugging /
   *  observability. */
  modelUsed: 'opus' | 'sonnet';
}

export async function runFullExtraction(input: {
  bundle: Bundle;
  schema: SyntheticSchema;
  llm: LlmClient;
  /** Pre-extracted context from the skeleton pass — when present,
   *  surfaces in the system prompt so the full pass can lean on it. */
  skeletonContext?: SkeletonResult;
  /** W5-D3 — per-emission enrichment results. When present, the
   *  prompt's "Additional Context" section surfaces the per-entity
   *  enrichment outputs so the LLM can refine the entities with the
   *  newly-fetched data. First-pass identity is preserved by surfacing
   *  the entities themselves alongside their enrichments. */
  enrichmentContext?: EnrichmentContext;
  /** W5-D3 — first-pass results, needed to surface the pre-identified
   *  entities in the second-pass prompt for identity preservation. */
  firstPassBySite?: Record<string, unknown>;
  /** Override the call label so the second-pass extraction shows up
   *  distinctly in observability traces. Defaults to `'tg_full_extraction'`. */
  label?: string;
}): Promise<FullExtractionResult> {
  const prompt = buildFullExtractionPrompt(input.schema, input.skeletonContext, {
    enrichmentContext: input.enrichmentContext,
    firstPassBySite: input.firstPassBySite,
  });
  const userMessage = renderBundleAsUserMessage(input.bundle, { numbered: false });
  const model = selectModel(input.schema.entityCount);

  // An empty source renders to an empty user message; Anthropic rejects
  // that with `400 messages.0: user messages must have non-empty content`.
  // Nothing to extract from nothing — yield an empty result without the
  // (invalid) call.
  if (userMessage.trim().length === 0) {
    return { resultsBySite: {}, modelUsed: model };
  }

  const raw = await callWithRetry({
    llm: input.llm,
    system: prompt,
    userMessage,
    label: input.label ?? 'tg_full_extraction',
    model,
    schema: input.schema.responseSchema,
  });

  return {
    resultsBySite: raw as Record<string, unknown>,
    modelUsed: model,
  };
}

/**
 * W5-D3 — merge first-pass and second-pass extraction results.
 *
 * Semantics (per the brief):
 *   - Second-pass values override first-pass for fields the LLM
 *     re-emitted.
 *   - Properties only present in the first pass are retained.
 *   - When the second pass emits fewer entities than the first, all
 *     first-pass entities are retained; the second pass refines those
 *     it re-emits (matched positionally by index — the identity is
 *     preserved by emission order, which the prompt makes explicit).
 *   - Resulting structure mirrors `FullExtractionResult.resultsBySite`
 *     so rebind consumes the merged object unchanged.
 */
export function mergeExtractionResults(input: {
  first: Record<string, unknown>;
  second: Record<string, unknown>;
  /** Sites that participated in the enrichment cycle — only these
   *  get the two-pass merge; non-enriched sites pass first-pass
   *  through verbatim so unrelated sites in the same root aren't
   *  re-shuffled. */
  enrichedSiteIds: Set<string>;
}): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...input.first };
  for (const siteId of Object.keys(input.first)) {
    if (!input.enrichedSiteIds.has(siteId)) continue;
    const firstArr = Array.isArray(input.first[siteId]) ? (input.first[siteId] as unknown[]) : [];
    const secondArr = Array.isArray(input.second[siteId]) ? (input.second[siteId] as unknown[]) : [];
    const out: unknown[] = [];
    for (let i = 0; i < firstArr.length; i++) {
      const f = firstArr[i];
      const s = i < secondArr.length ? secondArr[i] : undefined;
      out.push(mergeEntityFields(f, s));
    }
    merged[siteId] = out;
  }
  return merged;
}

function mergeEntityFields(first: unknown, second: unknown): unknown {
  if (!first || typeof first !== 'object') return second ?? first;
  if (!second || typeof second !== 'object') return first;
  const out: Record<string, unknown> = { ...(first as Record<string, unknown>) };
  for (const [key, val] of Object.entries(second as Record<string, unknown>)) {
    if (val == null) continue;
    // For evidence-wrapped fields, treat a `null` `value` as
    // "second-pass declined to refine" and keep the first-pass slot.
    if (
      val
      && typeof val === 'object'
      && 'value' in val
      && (val as { value?: unknown }).value == null
    ) {
      continue;
    }
    out[key] = val;
  }
  return out;
}

// ── Internals ─────────────────────────────────────────────────────────────

function mergeIntoBundle(bundle: Bundle, additions: TransformDispatchResult[]): Bundle {
  const newSegments: BundleSegment[] = [...bundle.segments];
  const newResourceById = new Map<string, Resource>();
  for (const r of bundle.resources) {
    const h = bundleHandleFor(r);
    if (h !== undefined) newResourceById.set(h, r);
  }

  let synthIdx = bundle.segments.length;
  for (const add of additions) {
    if (add.additionalContent) {
      newSegments.push({
        id: `xform:${bundle.rootSiteId}:${synthIdx++}`,
        classification: 'FRAGMENT',
        content: add.additionalContent,
      });
    }
    for (const r of add.resources ?? []) {
      const handle = bundleHandleFor(r);
      if (handle === undefined) continue;
      if (!newResourceById.has(handle)) {
        newResourceById.set(handle, r);
        if (r.content) {
          newSegments.push({
            id: `res:${handle}`,
            classification: r.type ?? 'TEXT',
            content: r.content,
            resourceId: handle,
          });
        }
      }
    }
  }

  return {
    ...bundle,
    segments: newSegments,
    resources: Array.from(newResourceById.values()),
  };
}

function renderBundleAsUserMessage(bundle: Bundle, opts: { numbered: boolean }): string {
  // Mirrors legacy `formatSegments` / `formatSegmentsNumbered`: per
  // segment, a classification header followed by content. Numbered
  // form is used for the skeleton pass so the LLM can emit line
  // refs the property pass slices against.
  const parts: string[] = [];
  if (!opts.numbered) {
    for (const seg of bundle.segments) {
      parts.push(`## ${seg.classification}\n${seg.content}`);
    }
    return parts.join('\n\n');
  }
  let line = 0;
  const multi = bundle.segments.length > 1;
  for (let i = 0; i < bundle.segments.length; i++) {
    const seg = bundle.segments[i];
    const lines = seg.content.split('\n');
    const numbered: string[] = [`## ${seg.classification}`];
    for (const l of lines) {
      line++;
      numbered.push(multi ? `${i}:${line} ${l}` : `${line} ${l}`);
    }
    parts.push(numbered.join('\n'));
  }
  return parts.join('\n\n');
}

function buildSkeletonPrompt(schema: SyntheticSchema): string {
  // Skeleton-pass prompt: identity + line refs only. The legacy
  // `buildSkeletonSystemPrompt` is the parity reference; we keep the
  // same task framing in a leaner form so the prompt-shape snapshot
  // is human-reviewable.
  return [
    'You are an information-extraction system.',
    '',
    '## Entity Guide',
    schema.entityGuide,
    '',
    '## Task',
    'Identify each entity above in the input text. Return identity values + line ranges only; do NOT extract detailed properties.',
    '',
    'Output a JSON object keyed by entity id. Each entity is either an object with its identity fields, or null when not present.',
    '',
    '## Rules',
    '- Extract every entity mentioned by name, even in passing.',
    '- Entities of the same type must have unique names; disambiguate when needed.',
    '- Quote evidence verbatim; use [bracketed paraphrasing] only to clarify implied context.',
    '- Do not fabricate.',
  ].join('\n');
}

function buildFullExtractionPrompt(
  schema: SyntheticSchema,
  skeletonContext: SkeletonResult | undefined,
  enrichment?: {
    enrichmentContext?: EnrichmentContext;
    firstPassBySite?: Record<string, unknown>;
  },
): string {
  const parts = [
    'You are an information-extraction system.',
    '',
    '## Entity Guide',
    schema.entityGuide,
    '',
    '## Task',
    'Extract structured data from the input message. For each field, return `{ evidence, value }` — the verbatim quote that supports the value, plus the typed value itself. Use null for missing values.',
    '',
    '## Rules',
    '- Every field must include `evidence` quoting the source passage.',
    '- Do not fabricate.',
    '- Entities of the same type must have unique names.',
  ];

  if (skeletonContext && Object.keys(skeletonContext.identitiesBySite).length > 0) {
    parts.push('', '## Pre-identified Entities');
    parts.push(JSON.stringify(skeletonContext.identitiesBySite, null, 2));
  }

  if (
    enrichment?.enrichmentContext
    && Object.keys(enrichment.enrichmentContext).length > 0
  ) {
    parts.push('', '## Re-extraction with Enrichment');
    parts.push(
      'A first-pass extraction has already identified the entities below. '
      + 'Additional context has been fetched for each entity from external sources. '
      + 'Re-extract each entity, preserving emission order and identity, refining '
      + 'and filling in fields with the enrichment data. Emit one array element '
      + 'per first-pass entity in the same order.',
    );
    for (const [siteId, perEmission] of Object.entries(enrichment.enrichmentContext)) {
      const firstPass = enrichment.firstPassBySite?.[siteId];
      const firstPassArr = Array.isArray(firstPass) ? firstPass : [];
      parts.push('', `### Site ${siteId}`);
      for (let i = 0; i < perEmission.length; i++) {
        const enrichments = perEmission[i];
        const entity = firstPassArr[i];
        parts.push('', `Emission ${i}:`);
        if (entity) {
          parts.push('First-pass entity:');
          parts.push('```json');
          parts.push(JSON.stringify(entity, null, 2));
          parts.push('```');
        }
        const nonEmpty = enrichments.filter(
          (e) => (e.output.text && e.output.text.trim().length > 0)
              || (e.output.data && Object.keys(e.output.data).length > 0),
        );
        if (nonEmpty.length === 0) {
          parts.push('(no enrichment data available)');
          continue;
        }
        for (const { transformName, output } of nonEmpty) {
          parts.push(`Enrichment via \`${transformName}\`:`);
          if (output.text) parts.push(output.text);
          if (output.data) {
            parts.push('```json');
            parts.push(JSON.stringify(output.data, null, 2));
            parts.push('```');
          }
        }
      }
    }
  }

  return parts.join('\n');
}

function flattenFieldValues(record: Record<string, unknown>): Record<string, unknown> {
  // EXTRACT_VALUE fields come wrapped in `{ evidence, value }`; for
  // pass-through to transforms we expose the raw `value` keyed by
  // field name.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
      out[k] = (v as { value: unknown }).value;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function callWithRetry(opts: {
  llm: LlmClient;
  system: string;
  userMessage: string;
  label: string;
  model: 'opus' | 'sonnet';
  schema: z.ZodTypeAny;
}): Promise<unknown> {
  const call = async (userMessage: string, label: string): Promise<LlmCallResult> =>
    opts.llm.call({
      system: opts.system,
      userMessage,
      label,
      model: opts.model,
    });

  const first = await call(opts.userMessage, opts.label);
  const firstParsed = opts.schema.safeParse(first.parsedJson);
  if (firstParsed.success) return firstParsed.data;

  // Direct port of legacy `extractSingleCall` validation-retry: feed
  // the issues back in a follow-up turn and parse again.
  const issues = firstParsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  const retryMessage = `${opts.userMessage}\n\n---\n\nYour previous response had validation errors:\n${issues}\n\nPlease fix ONLY the invalid values and return the complete corrected JSON.`;
  const retry = await call(retryMessage, `${opts.label}_retry`);
  return opts.schema.parse(retry.parsedJson);
}

// Re-export for adapter wiring + test introspection.
export { renderBundleAsUserMessage, buildSkeletonPrompt, buildFullExtractionPrompt };
export type { LlmCallInput, LlmCallResult, LlmClient };
