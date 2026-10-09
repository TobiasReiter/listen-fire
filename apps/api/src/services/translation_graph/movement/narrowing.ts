// Narrowing consumes an expression that evaluates to a Boolean.
//
// A WHERE already means "evaluate this predicate over these members" at
// runtime. Saying the same thing at author time gives ONE semantics instead of
// a special equality-against-a-literal case beside it — so any predicate the
// shared filter unit can evaluate composes for free (conjunctions, disjunction,
// negation, nesting), and there is nothing to widen when the language grows.
//
// This module is only the EVALUATION half. Who the members ARE is the caller's
// question, and it has two different answers on purpose:
//
//   - the direct walk (`instance_cache`'s `stepTo`) narrows over the members
//     THIS hop published — it holds them already, and a hop's own edges are
//     what a path step addresses;
//   - the refinement pre-pass narrows over the members the META WALK published
//     (`positionsByName`), because valid members are discovered by traversing
//     from the meta node — not from wherever the author happens to be standing.
//     That is what lets an EVENT's edge narrow to a table: the event never
//     enumerates the tables, the meta walk does.

import type { Expression } from '#shared/expression/types';

import {
  evaluatePredicate,
  flattenAndConjuncts,
  isPurePredicate,
  leafReadKey,
  pureLeafReads,
} from '#shared/expression/filter';

/** A candidate the predicate runs against: the labelled facts the adapter
 *  minted onto the member's position (Airtable's `{ Name }`, Sheets'
 *  `{ Title }`), plus whatever the caller wants back when it wins. */
export interface NarrowableMember<T> {
  /** The member's published data — the position's `identity.data`, as minted. */
  data: unknown;
  value: T;
}

function readableData(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  return data as Record<string, unknown>;
}

/**
 * The parts of `filter` THIS member can decide — a pushdown, and the same one
 * every filtering source performs.
 *
 * A WHERE is answered in two places: the member picks which node you are
 * standing on, and the rest runs over that node's rows. An AND is the one shape
 * where splitting it that way still answers the question asked
 * (`flattenAndConjuncts`), so the conjuncts are taken one at a time and an
 * OR / NOT stays whole.
 *
 * Two gates decide a conjunct, and they are why this can never over-claim:
 *
 *   - `isPurePredicate` — an `AI()`, a traversal or a function call can't be
 *     decided without the adapter/LLM/graph;
 *   - every leaf it reads must be present in the MEMBER'S OWN data. This is
 *     TIGHTER than purity, deliberately: `alias_ref` and `@current_date` are
 *     pure but are RUNTIME values, unknowable while typing.
 *
 * Dropping the undecidable rest is SOUND rather than a best effort: a
 * conjunction only ever selects a subset of what one of its conjuncts selects,
 * so the rows the hop yields are still that member's rows. This is what lets
 * `` `listName` == "Deal Pipeline" AND `Stage Order` >= cutoff `` narrow —
 * the list is named right there, and the cutoff is a runtime value that could
 * never have chosen a different list.
 */
export function decidableConjuncts(
  filter: Expression,
  data: Record<string, unknown>,
): Expression[] {
  return flattenAndConjuncts(filter).filter(
    (conjunct) =>
      isPurePredicate(conjunct) &&
      pureLeafReads(conjunct)
        .map(leafReadKey)
        .every((name) => name in data),
  );
}

/**
 * The member this predicate selects, or `undefined` for "doesn't narrow".
 *
 * A predicate none of whose conjuncts a member can decide, one that matches
 * nothing, and a member the adapter minted without data all land in the same
 * place — no refinement, the unnarrowed surface stands, and the runtime guards
 * stay the safety mechanism. That is the pre-existing contract, not a new
 * failure mode.
 *
 * First match wins: members of one type are distinct positions, so a predicate
 * selecting two of them is an author error the type layer can't adjudicate —
 * and picking the first is what a runtime WHERE over an ordered set does.
 */
export function selectMember<T>(input: {
  members: ReadonlyArray<NarrowableMember<T>>;
  filter: Expression;
}): T | undefined {
  for (const member of input.members) {
    const data = readableData(member.data);
    if (!data) continue;
    const decidable = decidableConjuncts(input.filter, data);
    // Nothing this member can answer is not a match — otherwise every member
    // would satisfy an empty conjunction and the first one would win.
    if (decidable.length === 0) continue;
    if (decidable.every((c) => evaluatePredicate(c, { read: (name) => data[name] }) === true)) {
      return member.value;
    }
  }
  return undefined;
}

/**
 * The fields a narrowing predicate may test: every key the members were
 * labelled with. Read off the members themselves, so it cannot name a field no
 * member carries. One rule for both places it is shown — a connection's
 * describe (`narrowBy` on a polymorphic edge) and the checker's refusal of a
 * field the unnarrowed type does not carry.
 */
export function narrowByOf(members: ReadonlyArray<{ data: unknown }>): string[] {
  const fields = new Set<string>();
  for (const member of members) {
    const data = readableData(member.data);
    if (data) for (const key of Object.keys(data)) fields.add(key);
  }
  return [...fields];
}
