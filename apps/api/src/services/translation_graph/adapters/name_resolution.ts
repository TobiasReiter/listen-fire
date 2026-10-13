// Adapter-layer natural-name → internal-id resolution.
//
// A movement program names every adapter/KG type, edge and field by the most
// NATURAL name the adapter can provide — the adapter's own `displayName`
// (types / fields) and reference `name` (edges), backtick-quoted when that
// name isn't a bare identifier (`kg.\`Funding Round\``, `crm.Companies`). The
// movement language prepends the adapter-instance identifier (`crm.`, `kg.`),
// so the adapter is unambiguous and the raw internal id (`attio:companies`, an
// ontology UUID) NEVER appears in program text.
//
// Naming is the ADAPTER's responsibility, NOT the host's. The Adapter
// INTERFACE trades in natural names; each adapter maps natural→its own backend
// id INTERNALLY, on the first line of each method, from its OWN cached
// introspection. The engine/host therefore contains ZERO id-translation.
// Only RECORD IDENTITY (`recordId` / `externalId` /
// `ExternalRecordRef.externalId`) stays an opaque id — it's a record key, not
// a name.
//
// This module is that translation, derived purely from the universal
// introspection every adapter already implements (`listEntryPoints()`
// displayName↔typeId, `describe(typeId)` field displayName↔fieldId + reference
// name↔fieldId/EdgeTypeId). The KG is NOT special — its `displayName` is the
// ontology node/property/edge name and its internal id is a UUID, resolved
// through this same path. A REMOTE adapter works identically: the shim builds
// the resolver from the introspection it already fetches over the wire.
//
// Two settled properties shape the contract:
//
//   - DRIFT ALWAYS THROWS (Decision #4). An adapter resolves a name against
//     EXACTLY the set its introspection exposes; a name that isn't there is
//     drift (the program was authored against a schema that has since changed)
//     and fails LOUD with a `MOVENG_RUNTIME`-style error. There is no
//     identity-passthrough branch and no "only throw if the surface is typed"
//     conditional — a `manual`/`cron` stub and every test fake must describe
//     what it exposes so its names resolve.
//
//   - NAME CLASHES ARE THE ADAPTER'S PROBLEM (Decision #5). The framework
//     defines no collision policy. An adapter is responsible for exposing an
//     unambiguous set; if it exposes two things with the same name the
//     consequence is the adapter's / the data model's (this resolver simply
//     keeps whichever it iterated last for that name — undefined behaviour we
//     don't paper over).

import type { SchemaEntryPoint, SchemaTypeDescriptor } from '../types';
import { RESOURCES_REFERENCE_FIELD_ID } from '../adapter';

/**
 * A name in the program's NATURAL vocabulary — the adapter's `displayName`
 * (types / fields) or reference `name` (edges). Branded so a value that is a
 * raw internal id can't silently masquerade as a natural name across the
 * resolver boundary (id-leakage is a correctness bug, not a noisy one).
 *
 * It is a structural brand only — `naturalName('Companies')` is the explicit
 * cast at the seam where a program string becomes a resolver input; everywhere
 * else the type system keeps natural names and internal ids from being
 * confused without an `as` escape.
 */
export type NaturalName = string & { readonly __naturalName: unique symbol };

/** Tag a program-supplied string as a natural name at the resolver boundary. */
export function naturalName(s: string): NaturalName {
  return s as NaturalName;
}

// ── Drift error ─────────────────────────────────────────────────────────────

/**
 * Thrown when a program names a type/field/edge the adapter's introspection
 * does NOT publish (Decision #4). A missing name against the adapter's exposed
 * set is real DRIFT — the program was authored against a schema that has since
 * changed — and must fail LOUD, never silently mis-resolve or pass through.
 *
 * The `code` matches the engine's `MOVENG_RUNTIME` family so dispatch surfaces
 * it exactly like any other runtime fault.
 */
export class AdapterNameDriftError extends Error {
  readonly code = 'MOVENG_RUNTIME';
  constructor(message: string) {
    super(message);
    this.name = 'AdapterNameDriftError';
  }
}

// ── The resolver contract ─────────────────────────────────────────────────

/**
 * Resolve a program's natural names to the internal ids the adapter's own
 * read/write logic consumes — and back (a position write holds the internal
 * `recordType` and needs the natural type name to translate its body's field
 * names). Built once per adapter instance from that instance's own cached
 * introspection.
 *
 * Every resolution either returns a real internal id or THROWS
 * `AdapterNameDriftError` — there is no `undefined` escape (Decision #4: a miss
 * is drift, always loud). The `try*` variants are the ONLY non-throwing
 * lookups: they exist for resolution orders where a name is admissible as
 * EITHER a field or an edge and the caller falls through before deciding drift,
 * and for best-effort host contexts (listen reconciliation) where an
 * unresolved name is tolerated, not fatal.
 */
export interface AdapterNameResolver {
  /** Type natural name (displayName) → typeId. Throws on drift. */
  typeId(naturalName: NaturalName): string;
  /** typeId → its natural name (displayName) — the reverse a position write
   *  needs (it carries the internal `recordType` and must resolve its body's
   *  field names against the natural type). Returns the id itself when no
   *  reverse mapping exists (an internal id with no known natural name still
   *  round-trips as its own currency — not drift). */
  naturalTypeName(typeId: string): string;
  /** Field natural name (displayName) → fieldId, within one type (named by its
   *  natural name). Throws on drift. */
  fieldId(typeNaturalName: NaturalName, fieldNaturalName: NaturalName): string;
  /** Field natural name → fieldId, OR undefined when the type/field isn't
   *  known — the non-throwing variant for the property-then-edge resolution
   *  order (`unique by` components, position-write fields where an edge name is
   *  also admissible). The caller falls through to `tryEdgeWriteName` before
   *  deciding drift. */
  tryFieldId(typeNaturalName: NaturalName, fieldNaturalName: NaturalName): string | undefined;
  /** Edge natural name → the READ currency for `getRelated` (the reference
   *  `fieldId` — the KG's EdgeTypeId), within one type. Throws on drift. */
  edgeReadId(typeNaturalName: NaturalName, edgeNaturalName: NaturalName): string;
  /** Edge read id OR undefined when not known — the non-throwing variant for
   *  the property-then-edge resolution order (the KG's adjacency-identity
   *  resolve keys on the EdgeTypeId, not the write name). */
  tryEdgeReadId(typeNaturalName: NaturalName, edgeNaturalName: NaturalName): string | undefined;
  /** Edge natural name → the WRITE currency `parentLink.edgeName` /
   *  `linkRecords.edgeName` consume (the KG's edge display `outbound_name`; for
   *  external adapters the reference `fieldId`), within one type. Throws on
   *  drift. */
  edgeWriteName(typeNaturalName: NaturalName, edgeNaturalName: NaturalName): string;
  /** Edge write name OR undefined when not known — the non-throwing variant
   *  used in the property-then-edge resolution order. */
  tryEdgeWriteName(typeNaturalName: NaturalName, edgeNaturalName: NaturalName): string | undefined;
  /** A meta-root collection hop's natural name (a type's displayName) → the
   *  typeId `getRelated(meta, …)` scans (== `typeId`). Throws on drift. */
  collectionTypeId(naturalName: NaturalName): string;
}

/**
 * How an adapter reaches its own resolver: name the types you are about to
 * resolve against, and only those get described.
 *
 * Bare (`resolver()`) is not "all types" — it is NONE, which is exactly right
 * for the entries-only lookups (`typeId`, `naturalTypeName`,
 * `collectionTypeId`). Naming a type you never resolve against costs a
 * describe for nothing; forgetting to name one you do costs correctness, and
 * fails LOUD as drift rather than quietly (Decision #4), which is the property
 * that makes this safe to scope.
 */
export type ScopedResolver = (scope?: { types?: readonly string[] }) => Promise<AdapterNameResolver>;

/** The introspection a resolver is built from — the SAME `listEntryPoints()`
 *  + per-entry `describe(typeId)` pair the instance-schema projection
 *  consumes. */
export interface AdapterIntrospection {
  entries: SchemaEntryPoint[];
  /** Descriptor per entry typeId; entries whose describe() returned null are
   *  absent (their fields/edges can't be resolved, only the type name). */
  descriptors: Map<string, SchemaTypeDescriptor>;
}

/** The reference's natural edge name — the same derivation everywhere: the
 *  reference's display `name` when set, else its `fieldId`. */
export function edgeNaturalName(ref: { name?: string; fieldId: string }): string {
  return ref.name ?? ref.fieldId;
}

// ── The resolver ─────────────────────────────────────────────────────────

/** Per-type field/edge name maps — built lazily on first resolution against a
 *  given type and memoised. */
interface TypeNameMaps {
  /** field displayName → fieldId. */
  fieldIdByName: Map<string, string>;
  /** edge name (reference `name` ?? `fieldId`) → reference `fieldId` (read). */
  edgeReadIdByName: Map<string, string>;
  /** edge name → its WRITE currency. For the KG that's the edge display name
   *  itself (the `outbound_name` the write path resolves by); for external
   *  adapters the reference `fieldId`. We store the reference `name` when set
   *  (KG edges always set it to `outbound_name`/`inbound_name`), else the
   *  `fieldId`. */
  edgeWriteNameByName: Map<string, string>;
}

/**
 * Build the resolver from an adapter instance's introspection. Forward and
 * reverse type maps are computed once here; per-type field/edge maps are
 * computed lazily (most runs touch a handful of types).
 *
 * Every lookup throws `AdapterNameDriftError` on a name the introspection
 * doesn't publish (Decision #4) — including against an EMPTY introspection,
 * which has nothing to resolve and so drifts on everything. There is no
 * collision policy (Decision #5): a duplicated natural name resolves to
 * whichever entry the map last saw, the adapter's own consequence.
 */
export function adapterNameResolver(
  introspection: AdapterIntrospection,
  options?: {
    /** Describe every entry point — the whole surface, on demand.
     *
     *  Supplied by `memoizedResolver`, whose descriptor map fills in as types
     *  are asked for, so `tryEdgeReadIdAnyType` has something complete to scan.
     *  Absent for a resolver built from an introspection that is already whole
     *  (the remote shim, test fakes), where there is nothing left to fetch. */
    describeAll?: () => Promise<void>;
  },
): AdapterNameResolver {
  const typeIdByName = new Map<string, string>();
  // Reverse is keyed by typeId, so it's unambiguous regardless of name
  // collisions — a position write's recordType is a specific typeId.
  const nameByTypeId = new Map<string, string>();
  for (const entry of introspection.entries) {
    typeIdByName.set(entry.displayName, entry.typeId);
    if (!nameByTypeId.has(entry.typeId)) nameByTypeId.set(entry.typeId, entry.displayName);
  }

  const typeMaps = new Map<string, TypeNameMaps>();
  /** The per-type maps, or undefined when the type's name is unknown OR its
   *  describe() returned null (no fields/edges to resolve against). */
  const mapsForType = (typeName: string): TypeNameMaps | undefined => {
    const cached = typeMaps.get(typeName);
    if (cached) return cached;
    // Resolve a type by its NATURAL displayName — the one currency a position's
    // recordType carries (every adapter stamps the pretty name; ids live only in
    // each adapter's private structured-id cache, never on a position). A name
    // not in the map is genuine schema drift.
    const typeId = typeIdByName.get(typeName);
    if (typeId === undefined) return undefined;
    const descriptor = introspection.descriptors.get(typeId);
    if (descriptor === undefined) return undefined;
    const fieldIdByName = new Map<string, string>();
    for (const f of descriptor.fields) fieldIdByName.set(f.displayName, f.fieldId);
    const edgeReadIdByName = new Map<string, string>();
    const edgeWriteNameByName = new Map<string, string>();
    for (const ref of descriptor.references) {
      const edge = edgeNaturalName(ref);
      // A system's own edge and its reserved resources reference may share a
      // name (a team's ontology edge called `Resources`): the name is the
      // system's own edge's, as the schema projection keys it. The reserved
      // reference is asked for by its fieldId, never by the name.
      if (ref.fieldId === RESOURCES_REFERENCE_FIELD_ID && edgeReadIdByName.has(edge)) continue;
      edgeReadIdByName.set(edge, ref.fieldId);
      // The write boundary (parentLink / linkRecords) consumes the edge's own
      // name where the adapter publishes one (KG: `outbound_name`), else the
      // reference fieldId (external adapters: the reference id IS the write
      // currency).
      edgeWriteNameByName.set(edge, ref.name ?? ref.fieldId);
    }
    const maps: TypeNameMaps = { fieldIdByName, edgeReadIdByName, edgeWriteNameByName };
    typeMaps.set(typeName, maps);
    return maps;
  };

  const driftType = (n: string): never => {
    throw new AdapterNameDriftError(
      `'${n}' is not a known type in this connection — its schema has changed (drift). ` +
        `Re-open the movement so it picks up the current types, or rename in the source system.`,
    );
  };
  const driftField = (t: string, f: string, what: 'field' | 'edge'): never => {
    throw new AdapterNameDriftError(
      `'${f}' is not a known ${what} of '${t}' in this connection — its schema has changed (drift). ` +
        `Re-open the movement so it picks up the current ${what}s, or rename in the source system.`,
    );
  };

  return {
    typeId: (n) => typeIdByName.get(n) ?? driftType(n),
    // Reverse: an internal id with no known natural name still round-trips as
    // itself (it's already the adapter's own currency — not drift).
    naturalTypeName: (typeId) => nameByTypeId.get(typeId) ?? typeId,
    fieldId: (t, f) => mapsForType(t)?.fieldIdByName.get(f) ?? driftField(t, f, 'field'),
    tryFieldId: (t, f) => mapsForType(t)?.fieldIdByName.get(f),
    edgeReadId: (t, e) => mapsForType(t)?.edgeReadIdByName.get(e) ?? driftField(t, e, 'edge'),
    tryEdgeReadId: (t, e) => mapsForType(t)?.edgeReadIdByName.get(e),
    edgeWriteName: (t, e) => mapsForType(t)?.edgeWriteNameByName.get(e) ?? driftField(t, e, 'edge'),
    tryEdgeWriteName: (t, e) => mapsForType(t)?.edgeWriteNameByName.get(e),
    collectionTypeId: (n) => typeIdByName.get(n) ?? driftType(n),
  };
}

// ── Adapter-side memoization (the per-instance resolver) ────────────────────
//
// An adapter builds its resolver LAZILY from its OWN `listEntryPoints()` /
// `describe()` — one introspection per instance per process (instances are
// per-credential, short-lived per resolve scope). `BaseAdapter` wires this in
// (its subclasses get `protected resolver()`); the KG adapter, which doesn't
// extend `BaseAdapter`, composes the same helper.

/**
 * A memoizing resolver factory bound to one adapter's introspection
 * primitives. The adapter calls it on the first line of each interface method
 * to translate the natural names it receives into its own internal ids.
 *
 * SCOPED, and this is the whole point of the shape. `resolver({ types })`
 * describes exactly those types and nothing else; the descriptor map is an
 * accumulator, so repeated scoped calls build up whatever the run actually
 * touches and never more. `resolver()` bare describes NOTHING — it serves the
 * entries-only lookups (`typeId`, `naturalTypeName`, `collectionTypeId`),
 * which is most of them, at the cost of the entry list alone.
 *
 * It used to describe EVERY entry point on first resolve, regardless of what
 * was being written. That is a whole-graph load sitting on the write path: a
 * run that writes one Attio record paid an attribute fetch for every object in
 * the workspace. Nothing about resolving one name needed the other fifty.
 *
 * The returned resolver stays SYNCHRONOUS (bar `tryEdgeReadIdAnyType`, which
 * says why in its own doc). It closes over the live accumulator rather than a
 * snapshot, so one resolver object serves every call and simply knows more as
 * the run goes on — no call site changes shape, each just names its type.
 */
export function memoizedResolver(introspect: {
  listEntryPoints(): Promise<SchemaEntryPoint[]>;
  describe(typeRef: string): Promise<SchemaTypeDescriptor | null>;
}): (scope?: { types?: readonly string[] }) => Promise<AdapterNameResolver> {
  let cached: Promise<{ resolver: AdapterNameResolver; entries: SchemaEntryPoint[] }> | undefined;
  const descriptors = new Map<string, SchemaTypeDescriptor>();
  /** Single-flight per typeId, so two methods naming the same type share one
   *  describe — and a failure is retried rather than cached as "absent". */
  const inFlight = new Map<string, Promise<void>>();

  const describeOnce = (typeId: string): Promise<void> => {
    const existing = inFlight.get(typeId);
    if (existing) return existing;
    // `describe` is fed the entry's INTERNAL typeId here — its result FEEDS
    // this resolver, so it cannot depend on it (the typeId path is
    // recursion-free). The engine and other callers reach `describe` by the
    // NATURAL type name; each adapter accepts both (it resolves a natural name
    // to its typeId via an entries-only lookup first).
    //
    // A FAILED describe leaves the type simply undescribed — it never
    // propagates to the caller. Resolution then decides: `fieldId` throws
    // drift, `tryFieldId` returns undefined and the caller falls through, which
    // is exactly what happened before this was scoped.
    //
    // That matters for currency the entry list doesn't publish. A scoped ask
    // may carry a traversed-to type name, which is forwarded to `describe`
    // as-is; a REMOTE adapter forwards that to somebody else's server, and a
    // server that throws on an unknown typeRef rather than answering null would
    // otherwise turn a lookup that used to fall through into a failed write.
    // Swallowing here keeps a scoped resolve strictly no more fragile than the
    // eager one it replaced. The single-flight entry is dropped on failure, so
    // the next ask retries rather than caching "absent".
    const promise = introspect
      .describe(typeId)
      .then((descriptor) => {
        if (descriptor) descriptors.set(typeId, descriptor);
      })
      .catch(() => {
        if (inFlight.get(typeId) === promise) inFlight.delete(typeId);
      });
    inFlight.set(typeId, promise);
    return promise;
  };

  const base = () => {
    if (cached === undefined) {
      cached = (async () => {
        const entries = await introspect.listEntryPoints();
        const describeAll = async () => {
          await Promise.all(entries.map((entry) => describeOnce(entry.typeId)));
        };
        return { resolver: adapterNameResolver({ entries, descriptors }, { describeAll }), entries };
      })();
      // A failed introspection mustn't poison the instance — drop the cache so
      // the next call retries (mirrors the instance_cache eviction policy).
      cached.catch(() => {
        cached = undefined;
      });
    }
    return cached;
  };

  return async (scope) => {
    const { resolver, entries } = await base();

    if (scope?.types?.length) {
      // A requested name may be the entry's natural `displayName` or already
      // its internal typeId — the same both-currencies rule `describe` itself
      // follows. An unknown name is not an error here: resolution decides
      // drift, and it does that loudly against the map it ends up with.
      const typeIdByName = new Map(entries.map((e) => [e.displayName, e.typeId]));
      await Promise.all(
        scope.types
          .map((name) => typeIdByName.get(name) ?? name)
          .filter((typeId) => !descriptors.has(typeId))
          .map((typeId) => describeOnce(typeId)),
      );
    }
    return resolver;
  };
}
