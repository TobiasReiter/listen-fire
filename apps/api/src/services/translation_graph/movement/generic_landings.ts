// Construction-site landing types, host side (2026-07-30).
//
// The refinements pre-pass next door resolves what a program's WHERE selects;
// this one resolves what a program's WRITE BODY decides. An edge may declare
// that its landing type is generic over one body field (`genericOver`) — an
// ask's `Response` over the `Options` that ask offered, so `Choose` with
// `["Seed","Series A"]` answers an enum of exactly those two, and `Provide`
// with `Answer Type: "number"` answers a number.
//
// Same skeleton, same reasons:
//
//   1. `scanInstanceChains` (movement-lang) yields every write's target chain
//      with its body as authored (`InstanceChain.writeBody`);
//   2. each chain is walked over the instance's PROJECTED schema in type space
//      to find the written type and the generic edge it declares;
//   3. the adapter turns the literals into a descriptor, which is projected the
//      standard way and grafted into a COPY of the schema, keyed for the checker
//      by `genericLandingKey`.
//
// THE TYPE IS ITS DERIVATION. The key is (base landing type, authored values),
// so two asks offering the same options share ONE synthesized position —
// collisions are structural identity, which is the point, not a hazard. The
// checker decides nothing; it agrees with us on a key.
//
// TYPE-SPACE ONLY. Nothing here reaches the engine: `resolveAwait` still matches
// landings by the family's base recordType, and the runtime answer values are
// already right (`coerceAnswer`). Threading the construction's literals into the
// ask record would be a second copy of a type nobody would read.

import { genericLandingKey, genericLandingName, literalStringValuesOf } from 'movement-lang';
import type {
  InstanceChain,
  InstanceSchema,
  PositionSchema,
  WritableRootSchema,
} from 'movement-lang';
import type { SchemaTypeDescriptor } from '../types';
import { landingSynthesizerFor } from '../adapters/packages';
import { instanceSchemaFromDescriptors } from './schema_projection';

/**
 * What a set of authored literals MEANS for a given written type — the one
 * piece of this that is the adapter's knowledge rather than the graph's, so it
 * lives with the adapter and is looked up by adapter type in the adapter
 * registry. An adapter that declares no `genericOver` never reaches here.
 */
export type LandingSynthesizer = (input: {
  /** The written record type (e.g. an ask family). */
  writtenType: string;
  /** The parameter's literal values, in authored order. */
  values: readonly string[];
}) => SchemaTypeDescriptor | null;

export interface GenericLandingInstance {
  adapterType: string;
  schema: InstanceSchema;
  /** The full node list — the descriptor projection resolves edge targets and
   *  natural names through it (same contract as `RefinableInstance`). */
  entryPoints: { typeId: string; displayName: string; writable: boolean; readable: boolean }[];
}

/** Project one synthesized descriptor into the surfaces a landing has: the
 *  POSITION it is read/awaited through, and — when the type has writable fields
 *  — the write SHAPE a write along the generic edge is checked against.
 *
 *  The scratch entry says `writable: true` purely to make the projection BUILD
 *  that shape; where it lands in the real schema is decided by the caller, and
 *  it is `createShapes`, never `writableRoots`. A landing is reached along its
 *  edge and nowhere else — a top-level `write instance.<landing>` would be a
 *  root promise nothing honours. */
function projectLanding(input: {
  instance: GenericLandingInstance;
  name: string;
  syntheticTypeId: string;
  descriptor: SchemaTypeDescriptor;
}): { position: PositionSchema; shape: WritableRootSchema | undefined } | undefined {
  const projected = instanceSchemaFromDescriptors({
    adapterType: input.instance.adapterType,
    entries: [
      ...input.instance.entryPoints,
      { typeId: input.syntheticTypeId, displayName: input.name, readable: true, writable: true },
    ],
    descriptors: new Map([[input.syntheticTypeId, input.descriptor]]),
    supportsInPlaceUpdate: false,
  });
  const position = projected.schema.positions[input.name];
  if (position === undefined) return undefined;
  return { position, shape: projected.schema.writableRoots[input.name] };
}

/**
 * Resolve every construction-site landing the program's writes decide, and
 * return the schema with the synthesized positions grafted in (copy-on-write —
 * the input schema is shared cache state and never mutated). No writes, no
 * generic edges, or nothing literal ⇒ the input schema comes back unchanged.
 */
export function graftGenericLandings(input: {
  instance: GenericLandingInstance;
  chains: InstanceChain[];
}): { schema: InstanceSchema } {
  const { instance } = input;
  const synthesize = landingSynthesizerFor(instance.adapterType);
  if (synthesize === undefined) return { schema: instance.schema };

  let schema = instance.schema;
  let positions = schema.positions;
  let createShapes = schema.createShapes ?? {};
  let genericLandings = schema.genericLandings ?? {};

  for (const chain of input.chains) {
    const body = chain.writeBody;
    if (body === undefined) continue;

    // Walk to the type this write creates — the chain's last hop, resolved the
    // same way the checker resolves it.
    let written: string | undefined = chain.startPosition;
    let reachable = true;
    for (const step of chain.steps) {
      if (step.type !== 'edge') {
        reachable = false;
        break;
      }
      const target: string | undefined =
        written === undefined
          ? schema.collections[step.edgeTypeId]?.target
          : positions[written]?.edges[step.edgeTypeId]?.target;
      if (target === undefined) {
        reachable = false;
        break;
      }
      written = target;
    }
    if (!reachable || written === undefined) continue;

    // A writable-only type (an ask family) mints no readable position, so its
    // edges live on the write shape — the same lookup the checker's handle does.
    const shape = schema.writableRoots[written] ?? schema.createShapes?.[written];
    const edges = shape?.edges ?? positions[written]?.edges;
    if (edges === undefined) continue;

    for (const [edgeName, edgeSchema] of Object.entries(edges)) {
      const generic = edgeSchema.genericOver;
      if (generic === undefined) continue;
      const raw = body[generic.field];
      if (raw === undefined) continue;
      // Not a literal ⇒ computed at run time ⇒ nothing to synthesize. The
      // checker reports it or stays silent per the edge's own declaration; this
      // pass has no diagnostics of its own to add.
      const values = literalStringValuesOf(raw);
      if (values === undefined) continue;

      const key = genericLandingKey({ target: edgeSchema.target, values });
      if (genericLandings[key] !== undefined) continue;

      const name = genericLandingName({ target: edgeSchema.target, values });
      // A name the schema already carries is one we must not overwrite: the
      // base surface stands and the landing simply isn't narrowed.
      if (positions[name] !== undefined) continue;

      const descriptor = synthesize({ writtenType: written, values });
      if (descriptor === null) continue;
      const landing = projectLanding({
        instance,
        name,
        syntheticTypeId: `${edgeSchema.target}::${key}`,
        descriptor,
      });
      if (landing === undefined) continue;

      positions = { ...positions, [name]: landing.position };
      // A landing with writable fields is also a WRITE target along its own edge
      // — the specialized `Response` a `write a-[:Response]-> { … }` body is
      // held to. Same key, same name: the checker resolves the write target
      // through `genericLandings` exactly as it resolves the read.
      if (landing.shape !== undefined) createShapes = { ...createShapes, [name]: landing.shape };
      genericLandings = { ...genericLandings, [key]: name };
      schema = { ...schema, positions, createShapes, genericLandings };
    }
  }

  return { schema };
}
