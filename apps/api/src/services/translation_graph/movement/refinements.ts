// Position-aware narrowing, host side (2026-07-05; rebuilt on the walk
// 2026-07-16).
//
// The checker is position-aware purely in TYPE-space: a hop WHERE can rebind to
// a REFINED position type — an anonymous subtype carrying that position's actual
// surface (one spreadsheet's table edges, not the type's whole-collection
// union). The checker only LOOKS UP refinements (`InstanceSchema.refinements`);
// producing them is this module's job, run during catalog assembly where the
// program source, the projected schemas, and the live adapters are all in hand:
//
//   1. `scanInstanceChains` (movement-lang) yields every hop chain the
//      program walks from a constructed instance, filters as authored;
//   2. each chain is walked over the instance's PROJECTED schema in type
//      space — the same walk the checker will do — and every selection
//      resolves by EVALUATING its WHERE over the members the meta walk
//      published, then walking to the member it selected;
//   3. the resolved descriptor is projected (the standard descriptor→position
//      projection) and grafted into a COPY of the schema under a readable
//      synthetic name, keyed for the checker by `refinementKey`.
//
// NARROWING CONSUMES AN EXPRESSION THAT EVALUATES TO A BOOLEAN. That is what a
// WHERE already means at runtime, so there is ONE semantics here rather than a
// special author-time equality case beside it — and any predicate the shared
// filter unit can evaluate composes for free, conjunctions included. The
// checker decides nothing; it agrees with us on a key.
//
// A narrowed polymorphic edge is procedurally identical to a named one:
// `-[s:Spreadsheet WHERE `Title` == "Foo"]->` and `-[s:`Foo`]->` land on the
// same type node via the same minimal fanout, because the selected member NAMES
// its type and `describeType` walks one hop along a path the meta walk already
// handed over. That identity is why this module never asks an adapter to narrow
// on its behalf (the former `describeSelected`, which resolved the selector AND
// paid a fanout across every member to answer).
//
// Predicates that decide nothing, selectors that match nothing, and
// unresolvable hops all degrade to "no refinement" — the unnarrowed surface
// stays and the runtime guards remain the safety mechanism. The walk itself
// steps THROUGH refinements it just grafted, so nested selection composes.

import { refinementKey } from 'movement-lang';

import type { InstanceChain, InstanceSchema, PositionSchema } from 'movement-lang';
import type { Expression } from '#shared/expression/types';
import type { SchemaTypeDescriptor } from 'movement-engine/public/catalog';

import { decidableConjuncts, narrowByOf, selectMember } from './narrowing';
import { instanceSchemaFromDescriptors } from 'movement-engine/public/catalog';

export interface RefinableInstance {
  adapterType: string;
  schema: InstanceSchema;
  /** The full node list — natural-name → internal-typeId resolution plus
   *  edge-target naming for the descriptor projection. */
  entryPoints: { typeId: string; displayName: string; writable: boolean; readable: boolean }[];
  /** Walk to one type by name (`CachedAdapterInstance.describeType`) — the
   *  member the predicate selected names it. */
  describeType: (typeName: string) => Promise<SchemaTypeDescriptor | null>;
  /** The members of a meta-graph type as the META WALK published them, each
   *  with its addressing name and the data the adapter labelled it with —
   *  what a narrowing predicate runs against
   *  (`CachedAdapterInstance.membersOf`). */
  membersOf: (recordType: string) => Promise<Array<{ name: string; data: unknown }>>;
}

/**
 * Why a narrowing produced no member. The chain pre-pass treats every case the
 * same (no refinement, unnarrowed surface stands, runtime guards catch it);
 * ad-hoc INSPECTION must report it, because there the narrowing IS the request
 * and a thin unnarrowed surface silently returned is the whole failure mode
 * layer 11 exists to prevent. One mechanism, two policies at the edge.
 */
export type NarrowFailure =
  | { kind: 'not-polymorphic' }
  | { kind: 'undecidable' }
  | { kind: 'no-match'; members: string[] }
  | { kind: 'no-descriptor'; member: string }
  | { kind: 'error'; message: string };

type Attempt<T> = { ok: true; value: T } | { ok: false; failure: NarrowFailure };

/**
 * Which member does this predicate select? The candidates are the ones the META
 * WALK published — narrowing is discovered by traversing from the meta node,
 * not from wherever the caller is standing.
 *
 * Kept separate from describing it because the two callers must interleave
 * differently: the chain pre-pass has to check whether it already grafted this
 * member BEFORE paying for a describe, or a second spelling of one selection
 * costs a second walk.
 */
async function selectMemberFor(input: {
  instance: RefinableInstance;
  typeName: string;
  filter: Expression;
}): Promise<Attempt<string>> {
  const { instance, typeName, filter } = input;

  let members: Array<{ name: string; data: unknown }>;
  try {
    members = await instance.membersOf(typeName);
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'error', message: err instanceof Error ? err.message : String(err) },
    };
  }
  if (members.length === 0) return { ok: false, failure: { kind: 'not-polymorphic' } };

  // Decidability is checked here rather than left to `selectMember`'s undefined
  // so an inspecting agent is told WHY — "that predicate can't be decided while
  // typing" and "no member matches" are different problems with different
  // fixes. A predicate is decidable when SOME member can answer some part of it
  // (`decidableConjuncts` — the same split `selectMember` narrows by), so a
  // WHERE whose list name is right there still narrows however much runtime
  // condition rides alongside it.
  const decides = members.some((member) => {
    const data = member.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
    return decidableConjuncts(filter, data as Record<string, unknown>).length > 0;
  });
  if (!decides) return { ok: false, failure: { kind: 'undecidable' } };

  const selected = selectMember({
    members: members.map((member) => ({ data: member.data, value: member.name })),
    filter,
  });
  if (selected === undefined) {
    return { ok: false, failure: { kind: 'no-match', members: members.map((m) => m.name) } };
  }
  return { ok: true, value: selected };
}

/**
 * The selected member NAMES its type, so narrowing is a named hop: ONE
 * `describeType` along a path the meta walk already handed over, never a
 * describe per member. That is layer 4's no-fanout rule, kept.
 */
async function describeMember(input: {
  instance: RefinableInstance;
  member: string;
}): Promise<Attempt<SchemaTypeDescriptor>> {
  let descriptor: SchemaTypeDescriptor | null;
  try {
    descriptor = await input.instance.describeType(input.member);
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'error', message: err instanceof Error ? err.message : String(err) },
    };
  }
  if (!descriptor) return { ok: false, failure: { kind: 'no-descriptor', member: input.member } };
  return { ok: true, value: descriptor };
}

/** The name a narrowed type is known by — the SAME name the checker mints for
 *  `WHERE`-refined positions, so what an agent sees when it inspects is what it
 *  gets when it authors. */
function refinedTypeName(input: { typeName: string; member: string }): string {
  return `${input.typeName} "${input.member}"`;
}

/** Project one described member into a position under its refined name. */
function projectRefinedPosition(input: {
  instance: RefinableInstance;
  refinedName: string;
  syntheticTypeId: string;
  descriptor: SchemaTypeDescriptor;
}): PositionSchema | undefined {
  const projected = instanceSchemaFromDescriptors({
    adapterType: input.instance.adapterType,
    entries: [
      ...input.instance.entryPoints,
      {
        typeId: input.syntheticTypeId,
        displayName: input.refinedName,
        readable: true,
        writable: false,
      },
    ],
    descriptors: new Map([[input.syntheticTypeId, input.descriptor]]),
    supportsInPlaceUpdate: false,
  });
  return projected.schema.positions[input.refinedName];
}

/**
 * Narrow a polymorphic type on INSPECTION — the describe-path counterpart of
 * the chain pre-pass below, sharing its selection, its describe and its naming.
 *
 * An agent inspecting a polymorphic type meets the INTERSECTION of its members,
 * which is frequently empty; narrowing is the only way from there to a member's
 * real fields and edges. Unlike the chain pre-pass this NEVER degrades to the
 * unnarrowed surface — a miss comes back as a failure naming the members that
 * do exist.
 *
 */
export async function narrowForInspection(input: {
  instance: RefinableInstance;
  typeName: string;
  filter: Expression;
}): Promise<
  { ok: true; member: string; refinedName: string; schema: InstanceSchema } | { ok: false; failure: NarrowFailure }
> {
  const selection = await selectMemberFor(input);
  if (!selection.ok) return selection;
  const member = selection.value;

  const described = await describeMember({ instance: input.instance, member });
  if (!described.ok) return described;

  const refinedName = refinedTypeName({ typeName: input.typeName, member });
  const position = projectRefinedPosition({
    instance: input.instance,
    refinedName,
    syntheticTypeId: `${input.typeName}::${member}`,
    descriptor: described.value,
  });
  if (position === undefined) return { ok: false, failure: { kind: 'no-descriptor', member } };

  const schema = input.instance.schema;
  return {
    ok: true,
    member,
    refinedName,
    schema: { ...schema, positions: { ...schema.positions, [refinedName]: position } },
  };
}

/**
 * Resolve every decidable selection the chains make against this instance
 * and return the schema with the resulting refined positions grafted in
 * (copy-on-write — the input schema is shared cache state and never
 * mutated). No selections, or nothing resolvable ⇒ the input schema comes
 * back unchanged.
 */
export async function refineInstanceSchema(input: {
  instance: RefinableInstance;
  chains: InstanceChain[];
}): Promise<{ schema: InstanceSchema; notes: string[] }> {
  const { instance } = input;
  const notes: string[] = [];
  if (input.chains.length === 0) {
    return { schema: instance.schema, notes };
  }

  let schema = instance.schema;
  let positions = schema.positions;
  let refinements = schema.refinements ?? {};
  /** The selected member's own TYPE, per key — the runtime half of the same
   *  fact. The checker rebinds the hop to `refinements[key]`; the engine drops
   *  any landed record whose own type is not `selectedMembers[key]`, so the two
   *  sides cannot disagree about which member a WHERE chose.
   *
   *  The TYPE, never the ADDRESSING name: a member is ADDRESSED by the label
   *  the meta walk filed it under (Affinity's `"Portfolio"`) and LANDS records
   *  of a type of its own (`"List Entry — Portfolio"`), and it is the landed
   *  type the adapter stamps. Storing the addressing name made the gate compare
   *  two different vocabularies, which is never true, so every record of every
   *  narrowed `List Entries` hop was silently dropped. */
  let selectedMembers = schema.selectedMembers ?? {};
  const attempted = new Set<string>();
  /** The refined positions THIS pass grafted, each with the member type it
   *  lands. A key is the WHERE as written, so two spellings of one selection
   *  (`` `T` == "F" `` and `` "F" == `T` ``) are two keys naming ONE member —
   *  the second must reuse the first's position rather than trip the name-taken
   *  guard below and silently not narrow, and must record the same member type
   *  without paying for the describe that names it. */
  const grafted = new Map<string, string>();
  /** How each narrowable type this program's hops land on narrows — the same
   *  `narrowBy` a describe shows. The checker reads it only to say how to fix a
   *  refused read of a field the unnarrowed type does not carry, so it is
   *  recorded whether or not this hop's WHERE selected anything. */
  let narrowBy = schema.narrowBy ?? {};
  const recordNarrowBy = async (typeName: string) => {
    if (narrowBy[typeName] !== undefined) return;
    let fields: string[];
    try {
      fields = narrowByOf(await instance.membersOf(typeName));
    } catch {
      return; // the selection below meets the same failure and notes it
    }
    if (fields.length === 0) return;
    narrowBy = { ...narrowBy, [typeName]: fields };
    schema = { ...schema, narrowBy };
  };

  const graft = async (typeName: string, filter: Expression) => {
    const key = refinementKey({ type: typeName, filter });
    if (refinements[key] !== undefined) return refinements[key];
    if (attempted.has(key)) return undefined;
    attempted.add(key);
    await recordNarrowBy(typeName);

    // Which member does this predicate select, and what does it look like? The
    // candidates are the ones the META WALK published — narrowing is discovered
    // by traversing from the meta node, not from where the author is standing.
    // A predicate that decides nothing, or an adapter with no meta-graph
    // members, simply doesn't narrow: on a CHAIN the unnarrowed surface stands
    // and the runtime guards remain the safety mechanism.
    const noteFailure = (failure: NarrowFailure) => {
      if (failure.kind === 'error') {
        notes.push(
          `${instance.adapterType}: narrowing ${typeName} failed (${failure.message}) — selection not narrowed`,
        );
      }
      return undefined;
    };

    const selection = await selectMemberFor({ instance, typeName, filter });
    if (!selection.ok) return noteFailure(selection.failure);
    const selected = selection.value;

    const refinedName = refinedTypeName({ typeName, member: selected });
    const already = grafted.get(refinedName);
    if (already !== undefined) {
      // A different spelling of this same selection — one member, one position,
      // now reachable under both keys. Answered before the walk, so a second
      // spelling costs nothing.
      refinements = { ...refinements, [key]: refinedName };
      selectedMembers = { ...selectedMembers, [key]: already };
      schema = { ...schema, refinements, selectedMembers };
      return refinedName;
    }
    if (positions[refinedName] !== undefined) return undefined; // name taken — leave unnarrowed

    // Describe only once we know this member isn't already grafted — otherwise
    // a second spelling of one selection pays a second walk.
    const described = await describeMember({ instance, member: selected });
    if (!described.ok) return noteFailure(described.failure);
    // The member's own type, as the walk names it — the SAME string a landed
    // record of this member carries, because both come from this descriptor
    // (the projection keys positions by `displayName`, and an adapter stamps
    // the type it published). Derived here, at the one point the selection is
    // made, so nothing downstream has to reconstruct it from the addressing
    // name.
    const memberType = described.value.displayName;

    const refinedPosition = projectRefinedPosition({
      instance,
      refinedName,
      syntheticTypeId: `${typeName}::${key}`,
      descriptor: described.value,
    });
    if (refinedPosition === undefined) return undefined;

    positions = { ...positions, [refinedName]: refinedPosition };
    refinements = { ...refinements, [key]: refinedName };
    selectedMembers = { ...selectedMembers, [key]: memberType };
    schema = { ...schema, positions, refinements, selectedMembers };
    grafted.set(refinedName, memberType);
    return refinedName;
  };

  for (const chain of input.chains) {
    let current: string | undefined = chain.startPosition; // undefined = the meta position
    for (const step of chain.steps) {
      if (step.type !== 'edge') break;
      const target =
        current === undefined
          ? schema.collections[step.edgeTypeId]?.target
          : schema.positions[current]?.edges[step.edgeTypeId]?.target;
      if (target === undefined) break; // unknown hop — the checker reports it
      // Step through the refinement when the selection resolves, so deeper
      // hops (and deeper selections) walk the narrowed surface.
      current =
        (step.expressionFilter !== undefined
          ? await graft(target, step.expressionFilter)
          : undefined) ?? target;
    }
  }

  return { schema, notes };
}
