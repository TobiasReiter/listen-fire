// C8 — Result rebinding.
//
// The LLM produced a JSON object keyed by `#extract` siteId. Each
// entry contains the structural payload (passed through verbatim) and
// the `EXTRACT_VALUE` sub-fields wrapped in `{ evidence, value }`.
//
// Rebinding routes:
//   - the structural payload → the `#extract` invocation's
//     materialised `EphemeralNode.data`
//   - each `EXTRACT_VALUE` field's `value` → the matching invocation's
//     promised scalar
//   - each `EXTRACT_VALUE` field's `evidence` → a `PropertyEvidence`
//     entry the apply stage forwards to `writeResource`
//
// Topological resolution order — inherited from legacy
// `consolidate.topologicalSortByConstraints`. Compound-scoped entities
// (R5's `edge_to:` constraint entries) must resolve AFTER their
// scoping parents so the parents' node ids are available to drive the
// edge-existence search. We compute the order by walking the
// `#extract` invocations' `scope.parentExtractSiteId` chain — the
// TG's nesting structure already encodes the parent-first ordering
// we want for compound scoping.

import type { EphemeralNode } from 'movement-engine/public/catalog';
import type { ExtractInvocation, ExtractValueInvocation } from '../evaluator/batcher';
import type { FieldEvidence } from 'movement-engine/public/adapter';
import type { Bundle } from './bundle';
import type { SyntheticSchema, FieldShape } from './schema_synthesis';
import type { FullExtractionResult } from './phases';

import { makeEphemeralPosition } from 'movement-engine/public/catalog';

export interface RebindResult {
  /** Materialised ephemeral nodes per `#extract` siteId — `#extract` is
   *  a traversal (W3-F5), so every site resolves to the full ephemeral
   *  array (zero, one, or many entities). Returned verbatim to the
   *  batcher's `registerExtract` callers. */
  nodesBySite: Record<string, EphemeralNode[]>;
  /** Resolved scalar value per `EXTRACT_VALUE` siteId. Returned to
   *  the batcher's `registerExtractValue` callers. */
  valuesBySite: Record<string, unknown>;
  /** Per-`EXTRACT_VALUE`-site provenance (the extraction quote), returned to
   *  `registerExtractValue` callers alongside the value so it rides through the
   *  expression evaluator's metadata channel onto the write (3b §3.4) — no
   *  post-write evidence pass. Fan-out evidence rides on each `EphemeralNode`
   *  (`evidence` keyed by data field name) instead. */
  evidenceBySite: Record<string, FieldEvidence>;
  /** Topological resolution order — siteIds in the order they should
   *  be applied to the target adapter (parents before compound-scoped
   *  children). */
  applicationOrder: string[];
}

/**
 * Re-bind a full-extraction LLM result against the bundle's
 * invocations. Pure function — no I/O. Apply stage (C9) takes the
 * result and writes it to the target.
 *
 * W6-D1 — when a `dedupRemap` is supplied (duplicate ephemeralRef →
 * canonical ephemeralRef), the rebinder:
 *   - drops duplicate ephemerals from `nodesBySite[siteId]` so the
 *     engine evaluator iterates only the canonical (intra-site case);
 *   - rewrites every `IntermediateEvidence.ephemeralRef` so duplicates
 *     consolidate onto the canonical (intra-site + cross-site case —
 *     finalisation resolves the canonical ref to a single real NodeId
 *     and all evidence rows land against it).
 */
export function rebindResults(input: {
  bundle: Bundle;
  schema: SyntheticSchema;
  fullResult: FullExtractionResult;
  /** W6-D1 — duplicate ephemeralRef → canonical ephemeralRef. Empty /
   *  undefined → no dedup remap; rebind preserves every emission. */
  dedupRemap?: Map<string, string>;
}): RebindResult {
  const nodesBySite: Record<string, EphemeralNode[]> = {};
  const valuesBySite: Record<string, unknown> = {};
  const evidenceBySite: Record<string, FieldEvidence> = {};

  // Walk one raw entity payload (a single object) into its
  // `EphemeralNode.data` + `EXTRACT_VALUE` results + per-field evidence.
  // Called once per emission in the per-site array.
  const projectEntity = (
    raw: Record<string, unknown>,
    shape: { fields: FieldShape[] },
    /** Total number of emissions for this site — drives whether the
     *  single-emission `valuesBySite`/`evidenceBySite` wiring fires. */
    emissionCount: number,
  ): { data: Record<string, unknown>; evidence: Record<string, FieldEvidence> } => {
    const ephemeralData: Record<string, unknown> = {};
    const ephemeralEvidence: Record<string, FieldEvidence> = {};
    const fieldByName = new Map<string, FieldShape>(shape.fields.map((f) => [f.name, f]));
    for (const [key, value] of Object.entries(raw)) {
      const field = fieldByName.get(key);
      // Any field schema synthesis declared for this entity (whether
      // sourced from a registered EXTRACT_VALUE invocation or from
      // the W3-F4 action-AST pre-collection) is wrapped in
      // `{ evidence, value }` per `wrapFieldEvidence`. Unwrap on the
      // way out so downstream consumers see the typed scalar, not
      // the wrapper.
      if (field) {
        const wrapped = value as { evidence?: string | null; value?: unknown } | null | undefined;
        const resolved = wrapped?.value ?? null;
        const fieldEvidence: FieldEvidence | undefined = wrapped?.evidence
          ? { quote: wrapped.evidence, type: 'extraction' }
          : undefined;
        // EXTRACT_VALUE values: when the site emits exactly one entity
        // (the description signals "the X"), wire valuesBySite +
        // evidenceBySite so the batcher's registerExtractValue callers
        // resolve to the scalar + its provenance. When the site fans out
        // ("each X"), each emission's per-field value + evidence is
        // projected onto the ephemeral node so the downstream action's
        // per-position re-evaluation reads it via ephemeral-node lookup.
        if (emissionCount === 1 && field.extractValueSiteId) {
          valuesBySite[field.extractValueSiteId] = resolved;
          if (fieldEvidence) evidenceBySite[field.extractValueSiteId] = fieldEvidence;
        }
        if (fieldEvidence) ephemeralEvidence[field.name] = fieldEvidence;
        ephemeralData[field.name] = resolved;
        continue;
      }
      ephemeralData[key] = value;
    }
    return { data: ephemeralData, evidence: ephemeralEvidence };
  };

  for (const inv of input.bundle.extractInvocations) {
    const shape = input.schema.entities[inv.siteId];
    if (!shape) continue;
    const raw = input.fullResult.resultsBySite[inv.siteId];

    // W3-F5 — every `#extract` site's response slot is an array
    // (`z.array(entity)`). The runtime collapses to one emission for
    // "the X" descriptions and N emissions for "each X" descriptions —
    // the LLM picks based on the description's cardinality intent.
    const items = Array.isArray(raw) ? raw : [];
    const ephemerals: EphemeralNode[] = items.map((item, i) => {
      const itemObj =
        item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const { data, evidence } = projectEntity(itemObj, shape, items.length);
      const nodeId = items.length === 1 ? `ephemeral:${inv.siteId}` : `ephemeral:${inv.siteId}#${i}`;
      return makeEphemeralPosition({
        data,
        evidence: Object.keys(evidence).length > 0 ? evidence : undefined,
        // The whole record was extracted from the bundle's resources, so they
        // are node-level provenance for every ephemeral the bundle produced
        // (`4d_resources.md`). buildActionPlan seeds these onto the action's
        // ResourceSink → WriteInput.resources.
        resources: input.bundle.resources,
        originRef: { kind: 'extract' as const, extractStepId: inv.siteId, nodeId },
      });
    });
    // W6-D1 — drop duplicate ephemerals from the per-site array so the
    // engine evaluator iterates only the canonical. Duplicates whose
    // canonical lives in a *different* site stay dropped (the canonical
    // site keeps them); duplicates whose canonical is in the same site
    // are filtered out here.
    const dedupedEphemerals = input.dedupRemap
      ? ephemerals.filter((e) => !input.dedupRemap!.has(e.originRef.nodeId))
      : ephemerals;
    nodesBySite[inv.siteId] = dedupedEphemerals;
  }

  // Topological order: parent-first walk. The evaluator already
  // emits `#extract` invocations in source order (root → nested),
  // but compound-scoped children may reference a peer rather than a
  // strict ancestor — we honour both by performing Kahn's algorithm
  // on the `parentExtractSiteId` graph PLUS any explicit
  // `edge_to:<ancestorName>` references in the action's uniqueness
  // constraints. For wave 1 the parent-pointer chain is sufficient:
  // R5 enforces that compound-scoped entries reference TG-ancestor
  // names, and the TG-ancestor chain == the `parentExtractSiteId`
  // chain by construction.
  const order: string[] = [];
  const visited = new Set<string>();
  const visit = (siteId: string) => {
    if (visited.has(siteId)) return;
    const inv = input.bundle.extractInvocations.find((i) => i.siteId === siteId);
    if (inv?.scope.parentExtractSiteId) {
      visit(inv.scope.parentExtractSiteId);
    }
    visited.add(siteId);
    order.push(siteId);
  };
  for (const inv of input.bundle.extractInvocations) {
    visit(inv.siteId);
  }

  // Also seed valuesBySite with null for any EXTRACT_VALUE site the
  // LLM didn't return — so the batcher's promise resolves rather
  // than hanging.
  for (const ev of input.bundle.extractValueInvocations) {
    if (!(ev.siteId in valuesBySite)) {
      valuesBySite[ev.siteId] = null;
    }
  }

  return {
    nodesBySite,
    valuesBySite,
    evidenceBySite,
    applicationOrder: order,
  };
}

// Re-exported for ergonomics — tests inspect both shapes commonly.
export type { ExtractInvocation, ExtractValueInvocation };
