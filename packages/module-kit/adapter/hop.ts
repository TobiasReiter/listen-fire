// One hop of the walk, built two ways.
//
// Every adapter answers the same question — "what is here, what leaves it, and
// what would I land on" — but they do not all answer it the same way. An
// adapter with CONTAINERS (Airtable's bases, Sheets' spreadsheets) has to walk
// them itself: which containers exist, and how each is addressed, is not
// derivable from anything. An adapter without containers has nothing to walk;
// its type ids already locate every node in its meta graph.
//
// So this module offers the two shapes:
//
//   - `hydrateTargets` — the LOOKAHEAD alone, for an adapter that builds its
//     own hops. The one mechanical part of the contract, and the reason it is
//     separable: what an edge says about its target is a fact about the
//     descriptor, never about how you got there.
//   - `uniformWalk` — the whole walk, for an adapter with no containers.
//
// Both exist so the answer to "what does an edge tell you about its target"
// has ONE implementation. Layer 2 requires that scaling the lookahead back to
// a stub be an edit in one place rather than sixteen; that promise is only
// true if sixteen adapters do not each hand-roll it.

import type { SchemaReferenceDescriptor, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/public/catalog';

import { stubTargetOf, targetNodeOf, type EdgesFromResult, type EdgeTargetNode, type StubTargetNode } from 'movement-engine/public/adapter';
import { META_RECORD_TYPE, makeUnstablePosition } from 'movement-engine/public/catalog';

type Describe = (typeId: string) => Promise<SchemaTypeDescriptor | null>;

/**
 * Whether THIS edge's target should be a stub rather than a described node —
 * and if so, WHAT the stub says.
 *
 * The adapter's call, per edge, because the adapter is the only thing that
 * knows what describing a target costs it. A wide node is where the lookahead
 * stops being one position's frontier and becomes the whole graph.
 *
 * It returns the stub rather than a boolean because a stub still has to NAME
 * its target usefully, and only the adapter knows the natural name — a
 * framework building one from `targetTypeId` alone would put `email:message`
 * in front of an agent that should be reading `Email`. Return undefined to
 * describe the target normally.
 */
type StubDecision = (reference: SchemaReferenceDescriptor) => StubTargetNode | undefined;

/**
 * What each of a node's edges LANDS ON, keyed by the edge's `fieldId`.
 *
 * Undefined rather than `{}` when nothing could be hydrated: "this node has no
 * edges" and "we did not tell you about its edges" are different statements,
 * and only the descriptor's own `references` makes the first one.
 *
 * Each distinct target is described ONCE however many edges point at it. The
 * lookahead is already the expensive read in this design; paying for it twice
 * on one node would be the fan-out the walk exists to remove.
 */
export async function hydrateTargets(input: {
  descriptor: SchemaTypeDescriptor;
  describe: Describe;
  stubTarget?: StubDecision;
}): Promise<Record<string, EdgeTargetNode> | undefined> {
  const stubs = new Map<string, StubTargetNode>();
  for (const reference of input.descriptor.references) {
    const stub = input.stubTarget?.(reference);
    if (stub) stubs.set(reference.fieldId, stub);
  }

  // Only describe what is actually going to be described. A stubbed edge must
  // cost NOTHING — the whole reason to stub is that the fetch is expensive.
  //
  // A MULTI-TARGET reference has no single landing node, and this map holds one
  // node per edge — so it hydrates nothing here. The walk names its members
  // (`WalkedEdge.landsOn`) instead: "any of these" is a different fact from
  // "this", and filing one of them under `target` would be the lie.
  const wanted = [
    ...new Set(
      input.descriptor.references
        .filter((r) => !stubs.has(r.fieldId) && r.targetTypeIds === undefined)
        .map((r) => r.targetTypeId),
    ),
  ];
  const described = new Map<string, SchemaTypeDescriptor>();
  await Promise.all(
    wanted.map(async (typeId) => {
      const descriptor = await input.describe(typeId);
      if (descriptor) described.set(typeId, descriptor);
    }),
  );

  const targets: Record<string, EdgeTargetNode> = {};
  for (const reference of input.descriptor.references) {
    const stub = stubs.get(reference.fieldId);
    if (stub) {
      targets[reference.fieldId] = stub;
      continue;
    }
    if (reference.targetTypeIds !== undefined) continue;
    const target = described.get(reference.targetTypeId);
    if (target) targets[reference.fieldId] = targetNodeOf(target);
  }
  return Object.keys(targets).length > 0 ? targets : undefined;
}

/**
 * Every one of this node's edges landing on a STUB — for a container-shaped
 * adapter, where hydration is never free.
 *
 * These adapters are container-shaped precisely because their describes are
 * API-backed: naming one target means fetching that list's or table's fields,
 * and a root has an edge per container. Hydrating would fetch the workspace to
 * answer "what is in this connection".
 *
 * Stubbing costs nothing, and it is strictly more than they said before, which
 * was nothing at all — an agent now learns what is on the other end of an edge
 * and that exactly one hop resolves it.
 *
 * Spreads into an `EdgesFromResult`, and yields NOTHING for a leaf, so an edge-
 * less node keeps saying "I have no edges" rather than "I have no targets".
 *
 */
export function targetStubs(
  descriptor: SchemaTypeDescriptor,
): Pick<EdgesFromResult, 'targetNodes'> | Record<string, never> {
  if (descriptor.references.length === 0) return {};
  const targetNodes: Record<string, EdgeTargetNode> = {};
  for (const reference of descriptor.references) {
    // A multi-target reference lands on several types — see `hydrateTargets`.
    if (reference.targetTypeIds !== undefined) continue;
    targetNodes[reference.fieldId] = stubTargetOf({
      typeId: reference.targetTypeId,
      // These adapters name their types by their natural name already — a
      // table IS "Deals" — so the type id is what an agent should read.
      displayName: reference.targetTypeId,
    });
  }
  return { targetNodes };
}

/**
 * An address for every edge of a TYPE-ADDRESSED node — one whose targets are
 * located by their type id alone, with no route data to carry.
 *
 * Separated from `uniformWalk` because an adapter can be type-addressed for
 * MOST of its graph and container-shaped for the rest: Affinity walks its
 * per-list members by id, but everything below a record is reached by name.
 * Such an adapter builds its own hops and would otherwise hand-roll this —
 * which is how Affinity came to publish six edges from `Organization` with no
 * address on any of them, leaving the walk unable to go past depth one.
 *
 * An edge with no address is not a smaller promise than one with an address; it
 * is the absence of the promise, and it silently ends the walk.
 */
export function typeAddressedPositions(input: {
  adapterType: string;
  descriptor: SchemaTypeDescriptor;
}): Record<string, SourcePosition> {
  const positions: Record<string, SourcePosition> = {};
  for (const reference of input.descriptor.references) {
    // A MULTI-TARGET reference is located by no single type id, so there is no
    // address for the walk to hand over: standing "at" a union is standing
    // nowhere. Its members are named on the edge (`WalkedEdge.landsOn`) and
    // each is reachable in its own right; inventing an address to one of them
    // would silently walk past the other.
    if (reference.targetTypeIds !== undefined) continue;
    positions[reference.fieldId] = makeUnstablePosition({
      adapterType: input.adapterType,
      recordType: reference.targetTypeId,
      data: {},
    });
  }
  return positions;
}

/**
 * The whole walk for an adapter with no containers.
 *
 * Such an adapter is not a shallow one — Slack declares three real hops and
 * Dropbox models cyclic folder nesting. It is one whose meta graph is located
 * ENTIRELY by type id, so every hop is `describe` and every path is derivable.
 * Give it its root node and its `describe` and the walk falls out.
 *
 * The root is not special: it is simply the node you get when the position
 * names no type. Everything else is `describe(recordType)`.
 */
export async function uniformWalk(input: {
  adapterType: string;
  at: SourcePosition;
  /** The meta node — what this connection IS, and the edges leaving it. The
   *  one thing no `describe` can answer, so the adapter states it. */
  root: SchemaTypeDescriptor;
  describe: Describe;
  /** Which of this node's edges land on a stub. Omitted ⇒ describe them all,
   *  which is right for an adapter whose describes are local and free. */
  stubTarget?: StubDecision;
}): Promise<EdgesFromResult | null> {
  const recordType = input.at.recordType ?? META_RECORD_TYPE;
  const descriptor =
    recordType === META_RECORD_TYPE || recordType === input.root.typeId
      ? input.root
      : await input.describe(recordType);
  if (!descriptor) return null;

  // A path per edge, minted from the target's type id alone — which is what
  // "no containers" means: the type IS the address, so there is no route data
  // to carry and no member to narrow between.
  const targetPositions = typeAddressedPositions({
    adapterType: input.adapterType,
    descriptor,
  });

  const targetNodes = await hydrateTargets({
    descriptor,
    describe: input.describe,
    ...(input.stubTarget !== undefined ? { stubTarget: input.stubTarget } : {}),
  });

  return {
    descriptor,
    ...(Object.keys(targetPositions).length > 0 ? { targetPositions } : {}),
    ...(targetNodes !== undefined ? { targetNodes } : {}),
  };
}
