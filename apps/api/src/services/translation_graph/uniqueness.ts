// The target-role uniqueness contract (3b §3.2). An engine-opaque,
// editor-authored, adapter-interpreted OR-of-AND of the *adapter's own field
// names* — it replaces the KG-shaped `StoredUniquenessConstraints` (property
// expressions + `edge_to:` ancestor entries) on the TG path. Compound scoping
// is gone; there is no ancestor threading and no expression language here.
//
//   - The editor authors it from `describe` (structure to pick fields + fuzzy).
//   - The engine threads it to `resolveEntity` without interpreting it for the
//     search, and separately uses it to arbitrate exactness over the flat
//     candidate set (`candidateIsAllExact`).
//   - The adapter compiles it to its native search (KG → pg_trgm SQL;
//     Attio/Airtable → filterByFormula).
//
// The extraction-consolidation path keeps its own richer
// `StoredUniquenessConstraints` (see services/knowledge_pipeline/
// uniqueness_constraints.ts) — that is a separate pipeline and is untouched.

import { z } from 'zod';
import { since } from 'movement-lang';

import { currentLanguageVersion } from '../movement_engine/run_scope';

/** One AND-tupled entry: a target field name, optionally fuzzy-matched. */
export const uniquenessEntrySchema = z.object({
  field: z.string(),
  fuzzy: z.boolean().optional(),
});

/** OR-of-AND over the adapter's field names. */
export const uniquenessConstraintsSchema = z.object({
  any: z.array(z.object({ all: z.array(uniquenessEntrySchema) })),
});

export type UniquenessEntry = z.infer<typeof uniquenessEntrySchema>;
export type UniquenessConstraints = z.infer<typeof uniquenessConstraintsSchema>;

/** No constraints — entity resolution falls straight through to create. */
export const EMPTY_UNIQUENESS: UniquenessConstraints = { any: [] };

/**
 * Union two constraint sets (native-from-describe ∪ author-on-the-node). The
 * engine pre-combines these so the adapter sees one set at resolve time.
 */
export function mergeUniqueness(
  a: UniquenessConstraints | undefined,
  b: UniquenessConstraints | undefined,
): UniquenessConstraints {
  return { any: [...(a?.any ?? []), ...(b?.any ?? [])] };
}

/**
 * An identity key component that says nothing: absent, or text with nothing
 * in it. An empty key is no key — two records that both lack a name are not
 * thereby the same record — so such a component never matches and is never
 * matched on.
 */
export function isBlankIdentityValue(value: unknown): boolean {
  if (value == null) return true;
  // Since language version 2. A version-1 run matches "" like any other value.
  return (
    since(currentLanguageVersion(), 2) && typeof value === 'string' && value.trim() === ''
  );
}

/** Case-insensitive equality that treats a multi-value field as a match when
 *  the asserted scalar appears among the candidate's values. */
function fieldValuesMatch(asserted: unknown, candidate: unknown): boolean {
  if (isBlankIdentityValue(asserted) || isBlankIdentityValue(candidate)) return false;
  const target = String(asserted).toLowerCase();
  const pool = Array.isArray(candidate) ? candidate : [candidate];
  return pool.some((v) => v != null && String(v).toLowerCase() === target);
}

/**
 * Engine-side exactness arbitration (3b §3.1/§3.2): does *some* branch match
 * the candidate's `data` exactly, field for field, against the asserted
 * record? The engine treats exactly one all-exact candidate among many as an
 * auto-match without invoking the LLM judge. A FUZZY entry counts when its
 * values are equal outright — "Pavo AI" against "Pavo AI" is an identity, not
 * a resemblance, and spending a judge call on it buys nothing.
 */
export function candidateIsAllExact(
  constraints: UniquenessConstraints,
  asserted: Record<string, unknown>,
  candidateData: Record<string, unknown>,
): boolean {
  return constraints.any.some(
    (branch) =>
      branch.all.length > 0 &&
      branch.all.every((entry) =>
        fieldValuesMatch(asserted[entry.field], candidateData[entry.field]),
      ),
  );
}

/**
 * Does ANY branch of these constraints carry a FUZZY entry? A search that
 * accepted an approximate match on some branch can turn up a lone candidate
 * that is a different real-world entity merely sharing the fuzzy field (the
 * OriqX/Pavo AI incident) — that lone hit stays doubtful no matter what
 * `candidateIsAllExact` says.
 *
 * Constraints with NO fuzzy entry anywhere mean every branch's search was
 * exact, so a lone candidate needs no arbitration even when the engine
 * itself can't re-verify it field-by-field — e.g. a constraint naming a
 * parent EDGE, which is folded into the adapter's search record but never
 * into the write's own asserted fields, so `candidateIsAllExact` can never
 * see it. `{ any: [] }` (no constraints at all) has no branch to carry a
 * fuzzy entry, so it reads as "no fuzzy entry" too — preserving the
 * pre-existing unconstrained-write behaviour of matching a lone candidate.
 */
export function constraintsHaveFuzzyEntry(constraints: UniquenessConstraints): boolean {
  return constraints.any.some((branch) => branch.all.some((entry) => entry.fuzzy === true));
}

/**
 * The part of identity arbitration the rules decide with no model: no
 * candidates is no match (create); exactly one all-exact candidate wins; a sole
 * candidate of constraints with no fuzzy entry wins. Undefined ⇒ only a judge
 * can say (`arbitrateEntityCandidates`).
 */
export function arbitrateWithoutJudge(input: {
  asserted: Record<string, unknown>;
  candidates: ReadonlyArray<{ data: Record<string, unknown> }>;
  constraints: UniquenessConstraints;
}): number | null | undefined {
  if (input.candidates.length === 0) return null;
  const exactIdxs = input.candidates
    .map((c, i) => (candidateIsAllExact(input.constraints, input.asserted, c.data) ? i : -1))
    .filter((i) => i >= 0);
  if (exactIdxs.length === 1) return exactIdxs[0];
  if (input.candidates.length === 1 && !constraintsHaveFuzzyEntry(input.constraints)) return 0;
  return undefined;
}
