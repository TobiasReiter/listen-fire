// W6-D1 — In-batch dedup of co-extracted ephemerals.
//
// Runs after C7b enrichment, before C9 apply. When the LLM emits two
// ephemerals that represent the same real-world entity (e.g. "Greylock"
// + "Greylock Partners" inside one `#extract`; or "Alice" emitted by
// two sibling `#extract(person)` sites under different parents), today
// both flow through `resolveEntity` independently and the KG's unique
// constraints catch duplicates only at insert time — often too late to
// merge evidence cleanly.
//
// This phase collects all ephemerals across the batch, groups by their
// target type, and uses adapter-supplied uniqueness rules to:
//   1. Exact-match pairs → union-find merge (duplicate → canonical).
//   2. Fuzzy-but-matching pairs → optionally route to the LLM judge.
//
// Adapters that don't model dedup (Slack, Email) return null from
// `getDedupRules` and the phase silently skips the type.
//
// Behavioural parity with legacy `consolidate.findDedupGroups`:
//   - Set-overlap (case-insensitive) for non-fuzzy property entries.
//   - Bigram-similarity ≥ 0.3 for fuzzy entries.
//   - One constraint match is enough; constraints are OR'd, entries AND'd.
//   - LLM-clustering arm for constraint-less types is intentionally
//     skipped (per the 2026-05-22 design ruling).

import type { EphemeralNode } from 'movement-engine/public/catalog';
import type {
  Adapter,
  DedupRules,
  ExternalRecordRef,
} from 'movement-engine/public/adapter';
import type { Bundle } from './bundle';
import type { SyntheticSchema } from './schema_synthesis';

import { positionData } from 'movement-engine/public/catalog';

// ── Public types ──────────────────────────────────────────────────────────

/**
 * Outcome of the dedup phase. The remap is a `duplicateEphemeralRef →
 * canonicalEphemeralRef` map; rebind + apply collapse evidence onto
 * the canonical via this map. Empty when no duplicates were detected
 * (the common case for hand-authored extractions).
 */
export interface InBatchDedupResult {
  /** Duplicate ephemeral ref → canonical ephemeral ref. The canonical
   *  is always the lexicographically-first ephemeral ref in a merged
   *  group (deterministic for snapshot-friendly tests). */
  remap: Map<string, string>;
}

/**
 * LLM judge surface — same shape as `engine/entity_match.ts`'s
 * `judgeEntityMatch`. Injected so tests can wire deterministic stubs
 * without invoking the real prompt path; production wires the real
 * implementation at the batcher construction site.
 *
 * Returns the index of the candidate the asserted record matches, or
 * `null` to decline. For dedup the judge is called with the two
 * ephemerals' data records framed as `asserted` + `[candidate]`; a
 * non-null return means "they're the same entity — merge".
 */
export interface DedupJudge {
  judge(input: {
    asserted: Record<string, unknown>;
    candidates: ExternalRecordRef[];
    recordType: string;
  }): Promise<number | null>;
}

// ── Phase entry point ─────────────────────────────────────────────────────

/**
 * Run the in-batch dedup phase. Collects ephemerals across the bundle's
 * `#extract` sites, groups by target type, evaluates pairwise
 * uniqueness against adapter-supplied rules, and emits a duplicate →
 * canonical remap for the rebind/apply stages to honour.
 *
 * Side-effect-free: this module only computes the remap. Rebind +
 * apply are the surfaces that actually apply it.
 *
 * Type grouping requires `perSiteTargetType` — the engine threads this
 * through the batcher config alongside `perSiteUniquenessConstraints`.
 * When absent (unit tests that don't exercise dedup), the phase
 * resolves to an empty remap and the pipeline behaves as before.
 */
export async function runInBatchDedup(input: {
  bundle: Bundle;
  schema: SyntheticSchema;
  /** Resolver from `#extract`-siteId to its target type id (e.g. KG
   *  NodeTypeId UUID). Required for type-grouped dedup; sites whose
   *  resolver returns undefined are skipped (each ephemeral stays as
   *  its own group of one). */
  perSiteTargetType?: (siteId: string) => string | undefined;
  /** Adapter that owns the target side. Provides `getDedupRules`. */
  adapter: Adapter | undefined;
  /** Per-`#extract`-siteId, per-emission-index ephemeral arrays —
   *  same shape as `RebindResult.nodesBySite`. The dedup phase reads
   *  ephemeral `data` (post-W3-F5 wrapping unwrapped by rebind) to
   *  evaluate uniqueness entries. */
  nodesBySite: Record<string, EphemeralNode[]>;
  /** Optional LLM judge for fuzzy-but-matching pairs. When omitted,
   *  fuzzy pairs are NOT merged (conservative — the LLM judge is the
   *  only thing that distinguishes "close" from "same"). */
  judge?: DedupJudge;
}): Promise<InBatchDedupResult> {
  const remap = new Map<string, string>();
  if (!input.adapter?.getDedupRules) return { remap };
  const resolveType = input.perSiteTargetType;
  if (!resolveType) return { remap };

  // 1. Group ephemerals by target type. Each group carries the ephemeral
  //    plus its originating siteId so we can read field-name mappings
  //    from the synthetic schema's per-site `FieldShape[]`.
  interface GroupedEphemeral {
    siteId: string;
    ephemeral: EphemeralNode;
    /** Per-propertyTypeId field name on this ephemeral's data record.
     *  Sourced from the bundle's synthetic schema for the originating
     *  site (where every `FieldShape.propertyTypeId` was stamped during
     *  W3-F4 pre-collection). */
    propertyTypeIdToFieldName: Map<string, string>;
  }
  const groupsByType = new Map<string, GroupedEphemeral[]>();

  for (const [siteId, ephemerals] of Object.entries(input.nodesBySite)) {
    const typeRef = resolveType(siteId);
    if (!typeRef) continue;
    const entityShape = input.schema.entities[siteId];
    if (!entityShape) continue;
    const propertyTypeIdToFieldName = new Map<string, string>();
    for (const field of entityShape.fields) {
      if (field.propertyTypeId) {
        propertyTypeIdToFieldName.set(field.propertyTypeId, field.name);
      }
    }
    const arr = groupsByType.get(typeRef) ?? [];
    for (const ephemeral of ephemerals) {
      arr.push({ siteId, ephemeral, propertyTypeIdToFieldName });
    }
    groupsByType.set(typeRef, arr);
  }

  // 2. For each type group, fetch the adapter's dedup rules + walk pairs.
  for (const [typeRef, group] of groupsByType) {
    if (group.length < 2) continue;
    const rules = await input.adapter.getDedupRules({ typeRef });
    if (!rules || rules.constraints.length === 0) continue;

    // Union-find over the group's ephemeral refs. Canonical = the
    // lexicographically-first ref in each merged set (deterministic).
    const refs = group.map((g) => g.ephemeral.originRef.nodeId);
    const parent = new Map<string, string>();
    for (const r of refs) parent.set(r, r);

    const find = (id: string): string => {
      let cursor = id;
      while (parent.get(cursor) !== cursor) {
        parent.set(cursor, parent.get(parent.get(cursor)!)!);
        cursor = parent.get(cursor)!;
      }
      return cursor;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      // Canonical = lexicographically-first. Repoint the larger to
      // the smaller so subsequent finds short-circuit to the canonical.
      const canonical = ra < rb ? ra : rb;
      const duplicate = ra < rb ? rb : ra;
      parent.set(duplicate, canonical);
    };

    // Fuzzy candidates — pairs whose only matching constraint involved
    // a fuzzy entry. Routed to the LLM judge after the exact pass so
    // judge calls only fire when the exact-merge result didn't already
    // collapse the pair.
    const fuzzyCandidates: Array<{ a: number; b: number }> = [];

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        // Already in the same exact-merge group? Skip — the union
        // already captured the merge through a transitive pair.
        if (find(a.ephemeral.originRef.nodeId) === find(b.ephemeral.originRef.nodeId)) continue;

        let matched = false;
        let hadFuzzy = false;

        for (const constraint of rules.constraints) {
          if (constraint.entries.length === 0) continue;
          let allMatch = true;
          let constraintHasFuzzy = false;

          for (const entry of constraint.entries) {
            const fieldNameA = a.propertyTypeIdToFieldName.get(entry.propertyTypeId);
            const fieldNameB = b.propertyTypeIdToFieldName.get(entry.propertyTypeId);
            if (!fieldNameA || !fieldNameB) { allMatch = false; break; }
            const valsA = gatherValues(coerceData(positionData(a.ephemeral)), fieldNameA);
            const valsB = gatherValues(coerceData(positionData(b.ephemeral)), fieldNameB);
            if (valsA.length === 0 || valsB.length === 0) {
              allMatch = false;
              break;
            }

            if (entry.fuzzy) {
              constraintHasFuzzy = true;
              let anyFuzzy = false;
              outer: for (const va of valsA) {
                for (const vb of valsB) {
                  if (stringSimilarity(String(va), String(vb)) >= 0.3) {
                    anyFuzzy = true;
                    break outer;
                  }
                }
              }
              if (!anyFuzzy) { allMatch = false; break; }
            } else {
              const setA = new Set(valsA.map((v) => String(v).toLowerCase()));
              let overlap = false;
              for (const vb of valsB) {
                if (setA.has(String(vb).toLowerCase())) { overlap = true; break; }
              }
              if (!overlap) { allMatch = false; break; }
            }
          }

          if (allMatch) {
            if (constraintHasFuzzy) {
              hadFuzzy = true;
            } else {
              union(a.ephemeral.originRef.nodeId, b.ephemeral.originRef.nodeId);
              matched = true;
            }
            // One matching constraint is enough — break out of OR loop.
            break;
          }
        }

        if (!matched && hadFuzzy) {
          fuzzyCandidates.push({ a: i, b: j });
        }
      }
    }

    // 3. Pair-judge fuzzy candidates that survived the exact pass. The
    //    judge sees the asserted (= a) record and a one-candidate
    //    shortlist (= b); a non-null return means "same entity → merge".
    if (input.judge) {
      for (const { a, b } of fuzzyCandidates) {
        const aGrp = group[a];
        const bGrp = group[b];
        if (find(aGrp.ephemeral.originRef.nodeId) === find(bGrp.ephemeral.originRef.nodeId)) continue;
        const matchIndex = await input.judge.judge({
          asserted: unwrapEphemeralData(coerceData(positionData(aGrp.ephemeral))),
          candidates: [
            {
              // Ephemeral-vs-ephemeral: the judge only reads `data`; the
              // identity fields just satisfy the flat currency shape.
              adapterType: bGrp.ephemeral.adapterType,
              externalId: bGrp.ephemeral.originRef.nodeId,
              data: unwrapEphemeralData(coerceData(positionData(bGrp.ephemeral))),
            },
          ],
          recordType: typeRef,
        });
        if (matchIndex === 0) {
          union(aGrp.ephemeral.originRef.nodeId, bGrp.ephemeral.originRef.nodeId);
        }
      }
    }

    // 4. Compress union-find into the public remap. Every ephemeral whose
    //    root is not itself becomes an entry pointing to its canonical
    //    root. Single-member groups (canonical only) produce no entry.
    for (const ref of refs) {
      const root = find(ref);
      if (root !== ref) remap.set(ref, root);
    }
  }

  return { remap };
}

// ── Internals ─────────────────────────────────────────────────────────────

/**
 * Narrow `EphemeralNode.data` (typed as `unknown` to keep the source-
 * position union open) to a record shape the dedup helpers can index
 * into. Non-object values resolve to undefined → every entry's
 * `gatherValues` returns `[]` → the constraint bails for the pair.
 */
function coerceData(data: unknown): Record<string, unknown> | undefined {
  if (data == null) return undefined;
  if (typeof data !== 'object') return undefined;
  return data as Record<string, unknown>;
}

/**
 * Read every value present at `fieldName` on the ephemeral data record.
 * Multi-cardinality fields surface as arrays; mirror legacy
 * `gatherSubgraphValues`'s behaviour of returning a flat value list so
 * set-overlap collapses cardinality automatically.
 */
function gatherValues(
  data: Record<string, unknown> | undefined,
  fieldName: string,
): unknown[] {
  if (!data) return [];
  const v = data[fieldName];
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null);
  return [v];
}

/**
 * Bigram-similarity scoring — direct port of legacy
 * `uniqueness_constraints.ts:stringSimilarity`. Lowercased Dice
 * coefficient on character bigrams; ≥ 0.3 is the legacy fuzzy
 * threshold.
 */
function stringSimilarity(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 1;
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const aBigrams = bigrams(al);
  const bBigrams = bigrams(bl);
  let intersection = 0;
  for (const bg of aBigrams) {
    if (bBigrams.has(bg)) intersection++;
  }
  return (2 * intersection) / (aBigrams.size + bBigrams.size) || 0;
}

/**
 * The ephemeral data record carries already-unwrapped field values
 * (rebind's `projectEntity` strips the `{ evidence, value }` wrapping
 * before stashing into `EphemeralNode.data`). This helper is a no-op
 * for that shape — kept as a seam so future shape changes don't bleed
 * through the judge prompt.
 */
function unwrapEphemeralData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return data ?? {};
}
