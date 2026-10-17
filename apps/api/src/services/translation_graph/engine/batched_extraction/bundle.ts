// C1 — Bundle assembly.
//
// A bundle is the input that drives a batched-extraction LLM call. It
// aggregates the `data:` payloads from one root `#extract` site (plus
// any nested `#extract` sites that share the root) into a flat sequence
// of segments + linked resources. The structure mirrors what today's
// `extractFromSegments(tree, segments, resourceIds, ...)` takes in the
// legacy extractor — segments + resourceIds + classification headers —
// so the prompt shape stays familiar.
//
// Inputs come from the evaluator: `ExtractInvocation.data` is the
// resolved data set (after parent inheritance). Elements may be:
//   - strings (raw text → TEXT segments)
//   - `Resource` handles (typed; segments derive from `content` or are
//     referenced by id with the LLM call carrying a resource-content
//     fetch around it)
//   - arrays (flattened one level by the evaluator already)
//
// We deliberately keep this module synchronous + side-effect-free: the
// real I/O (resource content materialisation) is the caller's job, and
// happens up the stack so the bundle can be inspected, snapshotted,
// and diffed in tests.

import type { Resource } from 'movement-engine/public/adapter';
import type { ExtractInvocation, ExtractValueInvocation } from '../evaluator/batcher';

/**
 * One segment in a bundle. Mirrors the legacy `Segment` shape from
 * `services/dealflow_pipeline/types` (classification + content),
 * narrowed to what the prompt actually consumes. Adapters don't see
 * this shape — only the batcher prompt-assembly does.
 */
export interface BundleSegment {
  /** Stable id for this segment within the bundle. Used by evidence
   *  anchoring to point back at a specific segment + offset range. */
  id: string;
  /** Classification header. `'TEXT'` for raw strings, the resource
   *  type for resources, or a custom label when set by the caller. */
  classification: string;
  /** Body the LLM sees. Populated either from a raw string or from a
   *  resource's `content` field. */
  content: string;
  /** Originating resource, when this segment derives from one. Stable
   *  handle used by evidence anchoring — prefer the internal UUID (`id`)
   *  when the resource has been persisted; otherwise the external
   *  handle (`externalId`). */
  resourceId?: string;
}

/**
 * Stable in-bundle handle for deduplication + segment-id construction.
 * Prefers the internal UUID when set; otherwise the external handle.
 * Both can't be undefined for any resource that has flowed through the
 * adapter `#resources` reference.
 *
 */
export function bundleHandleFor(resource: Resource): string | undefined {
  return resource.id ?? resource.externalId;
}

/**
 * A bundle aggregates the inputs for one root `#extract` site (plus
 * all nested `#extract` and `EXTRACT_VALUE` invocations that resolve
 * against the same root). The downstream pipeline reads:
 *
 *   - `segments` for the prompt user-message body
 *   - `resources` for evidence anchoring + `writeResource` round-trip
 *   - `invocations` for the synthetic schema build (C4) and rebinding (C8)
 */
export interface Bundle {
  /** Root `#extract` site this bundle belongs to. */
  rootSiteId: string;
  /** Ordered segment list — fed to the LLM as the user message. */
  segments: BundleSegment[];
  /** Resources surfaced by `data:`. Each appears at most once
   *  regardless of how many invocations referenced it. */
  resources: Resource[];
  /** All `#extract` invocations under this root (root included). */
  extractInvocations: ExtractInvocation[];
  /** All `EXTRACT_VALUE` invocations folded into this root's LLM call. */
  extractValueInvocations: ExtractValueInvocation[];
}

const CLASSIFICATION_LABELS: Record<NonNullable<Resource['type']>, string> = {
  URL: 'WEBSITE',
  EMAIL: 'EMAIL',
  WHATSAPP: 'WHATSAPP',
  FILE: 'DOCUMENT',
  TEXT: 'TEXT',
};

function classificationForResource(r: Resource): string {
  return r.type ? CLASSIFICATION_LABELS[r.type] ?? 'TEXT' : 'TEXT';
}

/**
 * Assemble a bundle for one root `#extract` and the set of
 * descendant `#extract` / `EXTRACT_VALUE` sites that share it.
 *
 * The caller is responsible for grouping invocations by root — that's
 * the batcher's job (driven by `ExtractScope.parentExtractSiteId`).
 *
 * Behavioural parity notes vs `extractFromSegments`:
 *   - Segments are emitted in `data:` order. The legacy code emits
 *     segments in `inboundHandler` order; for the TG path the author's
 *     `data:` declaration is the equivalent ordering choice.
 *   - Strings flow through as `TEXT` segments with a synthetic id
 *     (`seg:<rootSiteId>:<index>`). Resource-derived segments use the
 *     resource id as the segment id so evidence offsets can pair back.
 *   - Duplicate resource handles are deduped by `resourceId`.
 *   - Resources missing `content` are still included in `resources`
 *     (so `writeResource` round-trips them) but contribute no segment
 *     unless the caller hydrated `content` upstream.
 */
export function assembleBundle(input: {
  rootSiteId: string;
  rootInvocation: ExtractInvocation;
  nestedExtractInvocations: ExtractInvocation[];
  extractValueInvocations: ExtractValueInvocation[];
}): Bundle {
  const segments: BundleSegment[] = [];
  const resourcesById = new Map<string, Resource>();

  // The root's data drives segment ordering. Nested invocations
  // inherit (the evaluator already passed `state.data` through), so
  // re-walking their `data` would double-count — we only walk the root.
  const allData = input.rootInvocation.data;

  let textIdx = 0;
  for (const datum of allData) {
    if (datum == null) continue;
    if (typeof datum === 'string') {
      segments.push({
        id: `seg:${input.rootSiteId}:${textIdx++}`,
        classification: 'TEXT',
        content: datum,
      });
      continue;
    }
    if (isResource(datum)) {
      const handle = bundleHandleFor(datum);
      if (handle === undefined) {
        // A Resource with neither `id` nor `externalId` carries no
        // stable handle — drop it from the bundle so dedup + evidence
        // anchoring stay coherent. (Should not happen for adapter
        // output; possible for hand-rolled fixtures during migration.)
        continue;
      }
      if (!resourcesById.has(handle)) {
        resourcesById.set(handle, datum);
        if (datum.content) {
          segments.push({
            id: `res:${handle}`,
            classification: classificationForResource(datum),
            content: datum.content,
            resourceId: handle,
          });
        }
      }
      continue;
    }
    // Unknown payload — coerce to JSON-ish string so the LLM still
    // sees something. Mirrors the legacy "raw text fragment" fallback.
    segments.push({
      id: `seg:${input.rootSiteId}:${textIdx++}`,
      classification: 'FRAGMENT',
      content: safeStringify(datum),
    });
  }

  return {
    rootSiteId: input.rootSiteId,
    segments,
    resources: Array.from(resourcesById.values()),
    extractInvocations: [input.rootInvocation, ...input.nestedExtractInvocations],
    extractValueInvocations: input.extractValueInvocations,
  };
}

function isResource(value: unknown): value is Resource {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as { id?: unknown; externalId?: unknown };
  // A Resource must carry at least one identifying handle. We accept
  // either the internal UUID (when the resource has been persisted) or
  // the external handle (when it's fresh adapter output). Hand-rolled
  // POJOs with only `content` will not match — and that's the right
  // outcome: the bundle assembler needs a stable id to dedup against.
  return typeof r.id === 'string' || typeof r.externalId === 'string';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
