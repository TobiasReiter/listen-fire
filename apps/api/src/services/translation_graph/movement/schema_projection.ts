// M5 — pure projections from the host's real schema sources into the
// movement checker's `InstanceSchema`:
//
//   - adapter introspection output (`listEntryPoints()` entries + one
//     `describe(typeId)` descriptor per entry) → per-instance schema,
//   - workspace credential rows → identifier-safe import names.
//
// Everything here is pure (type-only imports) so the unit suite exercises
// the mapping without a DB or the adapter registry's module graph. The
// I/O assembly lives in `catalog.ts:movementCatalogForTeam`.
//
// Name convention: the movement language identifies types, edges, fields
// and collections by the most NATURAL name the adapter provides — the
// adapter's `displayName` (types / fields) and reference `name` (edges),
// backtick-quoted when that name isn't a bare identifier. So the projection
// keys positions/collections/writableRoots/edges/properties by the NATURAL
// name (displayName), NOT the internal id (typeId / fieldId / ontology UUID).
// The internal ids the adapter's read/write calls consume are resolved INSIDE
// each adapter from the SAME introspection, by the adapter-layer
// `AdapterNameResolver` (adapters/name_resolution.ts) — uniform for every
// adapter, the KG included; the engine/host carries no translation. The
// projection here only produces the checker's `InstanceSchema`.

import type {
  CollectionSchema,
  DiscriminatedWriteShape,
  EdgeSchema,
  SchemaFieldType,
  InstanceSchema,
  PositionSchema,
  WritableRootSchema,
  WriteUnionShape,
} from 'movement-lang';
import { isArtificialEdge, unionDisplay, unionKey, unionVariants } from 'movement-lang';
import type { AdapterManifest } from '../adapter';
import { RESOURCES_REFERENCE_FIELD_ID } from '../adapter';
import type {
  SchemaEntryPoint,
  SchemaFieldDescriptor,
  SchemaReferenceDescriptor,
  SchemaTypeDescriptor,
} from '../types';
import { referenceTargetTypeIds } from '../types';
import type { FieldCapability } from '#shared/expression/types';
import type { UniquenessConstraints } from '../uniqueness';

/**
 * Project a descriptor's native uniqueness constraints (OR-of-AND of the
 * adapter's own field ids — `describe().uniquenessConstraints`, e.g.
 * Attio's per-attribute `is_unique`) into the movement surface's
 * `nativeUniqueness` (OR-of-AND of surface names). Property entries pass
 * through when the field is known; reference entries map to the surface
 * edge name. Branches carrying anything unmappable are dropped — the
 * projection only declares what it can honestly name — with a note.
 *
 * An entry may also name the EDGE THE RECORD HANGS OFF rather than anything the
 * record itself carries: a company sits on a list once, so a list entry is
 * identified by the pair (the company, the list). That edge belongs to the
 * parent's type, so it is in neither of this type's own maps — `parentEdges`
 * carries it, and it maps to itself, which is both the word the author walks in
 * the write's path and the word the engine folds the resolved parent in under.
 */
function projectNativeUniqueness(input: {
  constraints: UniquenessConstraints | undefined;
  /** Internal field id → surface property name. */
  surfaceFieldByInternalId: ReadonlyMap<string, string>;
  /** Reference fieldId → surface edge name (for KG-style edge entries). */
  edgeSurfaceByFieldId: ReadonlyMap<string, string>;
  /** Surface names of the edges that LAND on this type — declared by the
   *  parents that reach it, so absent from its own reference map. */
  parentEdges: ReadonlySet<string>;
  /** Prose label for notes, e.g. `Companies`. */
  label: string;
  notes: string[];
}): string[][] {
  const projected: string[][] = [];
  for (const branch of input.constraints?.any ?? []) {
    if (branch.all.length === 0) continue;
    const group: string[] = [];
    let mappable = true;
    for (const entry of branch.all) {
      const surfaceField = input.surfaceFieldByInternalId.get(entry.field);
      if (surfaceField !== undefined) {
        group.push(surfaceField);
      } else {
        const edgeSurface = input.edgeSurfaceByFieldId.get(entry.field);
        if (edgeSurface !== undefined) {
          group.push(edgeSurface);
        } else if (input.parentEdges.has(entry.field)) {
          group.push(entry.field);
        } else {
          mappable = false;
          break;
        }
      }
    }
    if (mappable) {
      projected.push(group);
    } else {
      input.notes.push(
        `${input.label}: a native uniqueness rule references '${branch.all
          .map((e) => e.field)
          .join(', ')}' — not all of it maps to surface names, so the rule is omitted from the declared nativeUniqueness`,
      );
    }
  }
  return projected;
}

/**
 * Project a descriptor's fuzzy-resolution declaration onto the write shape.
 * `true` is every field; a list names the fields the adapter can search by
 * similarity, in the adapter's INTERNAL field ids (the same currency as its
 * uniqueness constraints), so each maps through the field descriptors to the
 * surface name the checker compares a `unique by` component against. An id
 * that maps to nothing is dropped with a note — declaring a field the author
 * cannot name would promise nothing — and a list that maps to nothing at all
 * declares no fuzzy resolution.
 */
function projectFuzzyResolution(input: {
  declared: boolean | readonly string[] | undefined;
  /** Internal field id → surface name (readable and write-only fields). */
  surfaceFieldByInternalId: ReadonlyMap<string, string>;
  label: string;
  notes: string[];
}): true | string[] | undefined {
  const declared = input.declared;
  if (declared === undefined || declared === false) return undefined;
  if (declared === true) return true;
  const fields: string[] = [];
  for (const fieldId of declared) {
    const surface = input.surfaceFieldByInternalId.get(fieldId);
    if (surface === undefined) {
      input.notes.push(
        `${input.label}: fuzzy resolution names '${fieldId}', which is not one of its fields — omitted`,
      );
    } else if (!fields.includes(surface)) {
      fields.push(surface);
    }
  }
  return fields.length > 0 ? fields : undefined;
}

/**
 * Project a descriptor's UNTAGGED write union (`writeUnion` — variants of field
 * IDS) onto the write shape the checker sees (variants of surface field NAMES).
 * The descriptor schema has already guaranteed each id is a writable field of
 * the type, so the only thing that can go missing here is a field whose KIND
 * didn't project at all (an unmappable descriptor kind) — that field can never
 * appear in a body, so the variant is honest without it, and the note says so
 * rather than leaving the surface silently different from the declaration.
 */
function projectWriteUnion(input: {
  declaration: NonNullable<SchemaTypeDescriptor['writeUnion']>;
  /** Writable field id → surface write-shape field name. */
  writeFieldNameById: ReadonlyMap<string, string>;
  /** Prose label for notes, e.g. `Slack Message`. */
  label: string;
  notes: string[];
}): WriteUnionShape {
  return {
    variants: input.declaration.variants.map((variant) => {
      const fields: string[] = [];
      for (const fieldId of variant.fields) {
        const name = input.writeFieldNameById.get(fieldId);
        if (name === undefined) {
          input.notes.push(
            `${input.label}: write variant '${variant.name}' names field '${fieldId}', which did not project onto the write surface — the variant is projected without it`,
          );
          continue;
        }
        fields.push(name);
      }
      return { name: variant.name, fields };
    }),
  };
}

/**
 * `@` names an edge the ENGINE makes (a write handle's `-[:@old]->`), and the
 * checker never looks such a name up among a system's edges — so an edge
 * spelled that way would publish something no author can reach. A described
 * surface is the user's own naming (an Airtable table or link field), so the
 * edge is left out with a note rather than failing the whole connection's
 * describe. Returns true when the edge is to be left out.
 */
function leaveOutArtificialEdge(input: { adapterType: string; edge: string; notes: string[] }): boolean {
  if (!isArtificialEdge(input.edge)) return false;
  input.notes.push(
    `${input.adapterType}: the edge '${input.edge}' starts with '@', which is reserved for edges the engine makes (such as '@old') — it was left out; rename it in the source system to reach it`,
  );
  return true;
}

/**
 * Project an arbitrary string into a bare identifier
 * (`[A-Za-z_][A-Za-z0-9_]*`): lowercase, runs of non-alphanumerics → `_`,
 * leading digit prefixed. `'Dev Loop Attio'` → `dev_loop_attio`.
 *
 * This is NOT a type/edge/field name derivation — those are the adapter's
 * verbatim exposed names (see module header). It exists ONLY to derive a
 * default IMPORT BINDING name for a credential row or plugin (`import {
 * dev_loop_attio } from credentials`, `import { linkedin_enrichment } from
 * plugins`), because an import name is a bare identifier the author types —
 * distinct from the type names a movement reads/writes.
 */
export function importIdentifier(raw: string): string {
  const collapsed = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const named = collapsed.length > 0 ? collapsed : '_';
  return /^[0-9]/.test(named) ? `_${named}` : named;
}

/** Map one adapter field descriptor to a movement SchemaFieldType. `reference`
 *  fields return undefined (they surface as edges, not properties). */
export function fieldTypeFromDescriptor(
  field: Pick<
    SchemaFieldDescriptor,
    'kind' | 'enumValues' | 'cardinality' | 'knownValues' | 'knownValuePattern'
  >,
): SchemaFieldType | undefined {
  const scalar = ((): SchemaFieldType | undefined => {
    switch (field.kind) {
      case 'string':
        // Live known-values project as an OPEN enum: literal misses WARN with
        // a did-you-mean; pattern-matching ids and expressions stay silent.
        if (field.knownValues !== undefined && field.knownValues.length > 0) {
          return {
            kind: 'enum',
            options: [...field.knownValues],
            open: {
              ...(field.knownValuePattern !== undefined
                ? { allowPattern: field.knownValuePattern }
                : {}),
            },
          };
        }
        return 'text';
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'date':
        return 'date';
      case 'file':
        return 'file';
      case 'enum':
        // `undefined` and `[]` are DIFFERENT facts and must not collapse. No
        // `enumValues` at all is "the adapter declared an enum but didn't
        // enumerate it" — unknown domain, so `text`. An EMPTY array is "the
        // adapter looked and the system offers nothing": the empty union,
        // which accepts nothing. Projecting that as `text` made an impossible
        // field accept any value and fail at run time (MOV_ENUM_EMPTY_DOMAIN
        // is the honest answer).
        return field.enumValues === undefined
          ? 'text'
          : { kind: 'enum', options: field.enumValues };
      case 'json':
        // A structured value, projected as one. `text` used to stand in here,
        // which made every json field claim a shape it does not have: a
        // many-cardinality one comma-joined into `[object Object], …` at run
        // time, and a scalar one read as text nobody could use. `json` is the
        // DATA top type — the author assembles a value with an object literal
        // and passes it through verbatim.
        return 'json';
      case 'reference':
        return undefined;
      default:
        return undefined;
    }
  })();
  if (scalar === undefined) return undefined;
  return field.cardinality === 'many' ? { kind: 'list', of: scalar } : scalar;
}

export interface AdapterSchemaProjection {
  schema: InstanceSchema;
  notes: string[];
}

/**
 * Project an adapter's real introspection output (`listEntryPoints()` +
 * one `describe(typeId)` per entry) into the checker's `InstanceSchema`.
 *
 * Every key is the adapter's NATURAL name — a position/collection by its
 * entry-point `displayName`, a property by its field `displayName`, an edge
 * by its reference `name` (display) — the names the program writes. The
 * INTERNAL ids the adapter's read/write calls consume (`typeId`, `fieldId`)
 * are resolved INSIDE each adapter from this same introspection by the
 * adapter-layer `AdapterNameResolver` (adapters/name_resolution.ts) — no
 * translation lives here. Two entries sharing a natural name → the first wins,
 * with a note (name clashes are the adapter's own concern — Decision #5).
 */
export function instanceSchemaFromDescriptors(input: {
  adapterType: string;
  /** The meta node's edges — what `listEntryPoints` publishes. These become
   *  BOTH a `collections` meta edge and a position. */
  entries: SchemaEntryPoint[];
  /**
   * Types reached by TRAVERSAL rather than published off the meta node (an
   * Airtable table behind its base). They get a position like any other type,
   * but no meta edge: you can't `write instance.<name>` your way to one
   * without walking there, so publishing a collection for it would state a
   * reachability that doesn't exist. Their write shape lands in `createShapes`
   * via the ordinary writable-edge path.
   */
  reached?: SchemaEntryPoint[];
  /** Descriptor per entry typeId; entries whose describe() returned null
   *  are simply absent. */
  descriptors: Map<string, SchemaTypeDescriptor>;
  /**
   * The META node's own descriptor (`describe(ADAPTER_META_TYPE_ID)`) — the
   * root as a NODE, whose references are the root collections as EDGES. Its
   * only job here is the `capability` each root collection declares, matched
   * to the entry's collection name; everything else about a collection comes
   * from the entry list, which stays the authority on WHICH collections exist.
   * Absent ⇒ no root capability declared ⇒ the checker's gate stays silent,
   * exactly as an undeclared record edge does.
   *
   */
  metaDescriptor?: SchemaTypeDescriptor;
  /** Whether the adapter implements `updateRecord` (its manifest
   *  `methods[]`) — gates the position write `write a { … }`. */
  supportsInPlaceUpdate: boolean;
  /** Whether the adapter's traversals can carry INLINE edge properties
   *  (`runtimeCapabilities().traversal.edgeProperties`) — facts belonging to
   *  the relationship, attached per traversed record and enumerated by no
   *  describe. It rides the schema because it is the third surface a bare name
   *  in a bracket WHERE can address, and the checker has to know the surface
   *  exists before it can call such a name a mistake. */
  edgesCarryProperties?: boolean;
  /**
   * The FULL entry list when `entries` is a scoped subset (types-scoped
   * describe). Scope-INVARIANT facts derive from here so the efficient path
   * never contradicts the expensive one: edge TARGET names always resolve to
   * their natural displayName (never a raw out-of-scope typeId), and
   * `eventPosition` reflects the instance's real event surface (never
   * recomputed from a subset — the single-readable heuristic over a scoped
   * set of one would LIE, teaching an agent to type a listener parameter
   * against the wrong position). Defaults to `entries` (full describe).
   */
  allEntries?: SchemaEntryPoint[];
  /**
   * Whether this instance's type-space is WALKED lazily rather than published
   * whole — i.e. its adapter implements `edgesFrom`. It changes what an
   * unpublished edge target MEANS: on a walked instance it is a type nobody
   * has followed yet (expected), on a whole-published one it is drift.
   *
   */
  lazilyWalked?: boolean;
}): AdapterSchemaProjection {
  const notes: string[] = [];
  const reached = input.reached ?? [];
  // Edge targets resolve to a natural name across everything KNOWN — meta
  // edges and traversed types alike — so a scoped describe never surfaces a
  // raw internal id the full one would have named.
  const allEntries = [...(input.allEntries ?? input.entries), ...reached];
  const metaEdgeTypeIds = new Set((input.allEntries ?? input.entries).map((e) => e.typeId));

  // Every type some KNOWN type has an edge to — i.e. reachable by traversal,
  // whether or not the root offers it as a starting point.
  //
  // This is what a POSITION should depend on. `readable` means "the root can
  // offer this as a starting point for reads" (its documented meaning, and
  // what mints the collection below) — but it was ALSO gating whether a type
  // got a position at all. One flag, two unrelated jobs, and an adapter needs
  // the position: without it a type cannot be an edge target or a listen
  // position. So every adapter with a CHILD type — a Slack reaction, an Attio
  // note — had to publish it `readable: true` and claim a root collection it
  // could not read. The lie was forced, and 11 of 15 adapters told it.
  //
  // Deriving reachability from the edges the descriptors already declare lets
  // a child type say `readable: false` honestly and still be traversable.
  //
  /** The natural names a reference can land on — one for an ordinary edge,
   *  several for a polymorphic one, de-duplicated and in declaration order. */
  const targetNamesOf = (reference: SchemaReferenceDescriptor): string[] => [
    ...new Set(
      referenceTargetTypeIds(reference).map(
        (typeId) => allEntries.find((e) => e.typeId === typeId)?.displayName ?? typeId,
      ),
    ),
  ];

  const edgeTargetNames = new Set<string>();
  /**
   * The edges that LAND on a type, by the name the author walks them under —
   * declared by the PARENT, so a type never carries them in its own reference
   * list. Identity can name one: a record sits on a list once, so a list entry
   * is identified by the pair (the company it hangs off, the list), and the
   * company reaches the write through its `List Entries` edge. That is a fact
   * about a type the type itself cannot state.
   */
  const incomingEdgeNames = new Map<string, Set<string>>();
  for (const descriptor of input.descriptors.values()) {
    for (const reference of descriptor.references) {
      // The resources reference (`_resources`, walked by its name — the
      // knowledge graph's `Resources`) is an ordinary edge: its landing is
      // reachable type-space like any other, though never an entry.
      // EVERY member of a polymorphic reference is reachable — a union whose
      // variants aren't positions is a type nobody can read through, and the
      // engine's landed-record restamp is gated on the variant being one.
      for (const name of targetNamesOf(reference)) {
        edgeTargetNames.add(name);
        const named = incomingEdgeNames.get(name) ?? new Set<string>();
        named.add(reference.name ?? reference.fieldId);
        incomingEdgeNames.set(name, named);
      }
    }
  }

  const positions: Record<string, PositionSchema> = {};
  const collections: Record<string, CollectionSchema> = {};
  // What the ROOT descriptor says each of its collections can do, by the name
  // the collection reads as. The meta node and the entry list must agree on
  // that name — where they don't, the capability is dropped WITH a note rather
  // than attached to the wrong collection.
  const rootCapabilities = new Map(
    (input.metaDescriptor?.references ?? [])
      .filter((ref) => ref.capability !== undefined)
      .map((ref) => [ref.name ?? ref.fieldId, ref.capability] as const),
  );

  // Union position types, minted by the multi-target references below. Keyed by
  // a DERIVED structural address, so two edges landing on the same member set
  // register ONE type; the author-facing text lives alongside, separately.
  const unions: Record<string, string[]> = {};
  const unionDisplayNames: Record<string, string> = {};
  const writableRoots: Record<string, WritableRootSchema> = {};
  // Write shapes for types writable ALONG AN EDGE but with no top-level
  // writable root of their own (message-write-unification §5.1) — see the
  // `createShapes` fill after the entry loop.
  const createShapes: Record<string, WritableRootSchema> = {};
  const writableTargets = new Set<string>();
  const shapeByName: Record<string, WritableRootSchema> = {};
  /** The typeId each natural name has already been claimed by — a name is a
   *  collision only when a SECOND type wants it. */
  const typeIdByName = new Map<string, string>();

  for (const entry of [...input.entries, ...reached]) {
    // The NATURAL name IS the entry-point displayName — the name the program
    // writes (`crm.Companies`, `<inbox-[:Email]->>`); the resolver maps it back to
    // `entry.typeId` at the boundary.
    const name = entry.displayName;
    const claimedBy = typeIdByName.get(name);
    if (claimedBy !== undefined) {
      // One TYPE published twice is the entry surface working as intended: a
      // readable root collection and an event edge are two promises about the
      // same node (adapters/CLAUDE.md rule 9), and the first entry already
      // carries the position. Only a second DESCRIPTOR under one name costs an
      // author a type they cannot address.
      if (claimedBy !== entry.typeId) {
        notes.push(
          `${input.adapterType}: more than one type is named '${name}' — keeping the first; rename one in the source system to address the other`,
        );
      }
      continue;
    }
    typeIdByName.set(name, entry.typeId);

    // Every entry point IS a meta edge off the adapter's meta position — the
    // node the cursor starts at. A READABLE entry's edge is a traversable
    // collection (`root-[c:Companies]-> …`); a WRITABLE entry's edge is how you
    // create along it (`write root-[:Companies]-> { … }`) — the ONLY write form
    // now that flat `root.Type` writes are gone, so a write-only root (an
    // append-only Sheets tab) still needs its meta edge or it's unreachable.
    // Keyed by the entry's NATURAL collection name (default: the type's display
    // name; an entry may declare a DISTINCT `collectionName` so the meta-edge
    // reads differently from the record type it yields — Granola's `meetings` →
    // `Meeting Note`). The value is where the hop LANDS plus what the source
    // can do across it — a root collection is an edge and says so like any
    // other (D2).
    // …but ONLY for a type the meta node actually publishes. A traversed type
    // is reached through its container's edge, not off the root.
    if (metaEdgeTypeIds.has(entry.typeId) && (entry.readable || entry.writable)) {
      const collectionName = entry.collectionName ?? name;
      if (!leaveOutArtificialEdge({ adapterType: input.adapterType, edge: collectionName, notes })) {
        const capability = rootCapabilities.get(collectionName);
        collections[collectionName] = {
          target: name,
          ...(capability !== undefined ? { capability } : {}),
        };
      }
    }

    const descriptor = input.descriptors.get(entry.typeId);
    if (!descriptor) {
      // No descriptor came back for this entry — describe() answered null, or a
      // demand-scoped introspection never asked. The position exists; NOBODY HAS
      // LOOKED at its surface.
      //
      // That is `undescribed`, NOT `openProperties`, and the distinction is the
      // whole point. This used to say open, which made "I haven't looked" and
      // "anything goes" the same value — so an unnarrowed event's `record` edge,
      // landing on the meta type `Table`, accepted ANY field name and
      // `` r.`Name` `` compiled with no diagnostics and ran as null. A check
      // asking "may I say this surface lacks X?" is still answered no either way
      // (`surfaceNotEnumerated`); a READ through the handle is now an error,
      // because nothing ever claimed it carries anything.
      if (entry.readable || entry.fires === true || edgeTargetNames.has(name)) {
        positions[name] = { properties: {}, edges: {}, undescribed: true };
      }
      continue;
    }

    const properties: Record<string, SchemaFieldType> = {};
    const propertyCapabilities: Record<string, FieldCapability> = {};
    const writableFields: Record<string, SchemaFieldType> = {};
    const writeOnlyProperties: string[] = [];
    /** Display names carried by more than one of the source's fields. */
    const ambiguousProperties: string[] = [];
    const requiredFields: string[] = [];
    const fieldDocs: Record<string, string> = {};
    /** Writable field id → the surface name it projected to — what an
     *  UNTAGGED write union's variants (declared in field ids) map through. */
    const writeFieldNameById = new Map<string, string>();
    let droppedField = false;
    for (const field of descriptor.fields) {
      const type = fieldTypeFromDescriptor(field);
      if (type === undefined) {
        // Reference fields surface as edges; other unmappable kinds are
        // genuinely dropped, so the position must stay OPEN to property
        // strictness (a dropped field would otherwise false-positive).
        if (field.kind !== 'reference') droppedField = true;
        continue;
      }
      const fieldName = field.displayName;
      if (properties[fieldName] !== undefined || writeOnlyProperties.includes(fieldName)) {
        // Two of the source's fields present under one display name (an Attio
        // object whose own title attribute is called "Name", plus a custom
        // "Name"). The name still resolves — to the FIRST, deterministically —
        // so this must not blank the schema or open the position. It is
        // recorded so the CHECKER can warn at the point of use, which is the
        // only place the author can act on it. Silently keeping the first was
        // the bug: a field you cannot see is a field that does not exist.
        if (!ambiguousProperties.includes(fieldName)) ambiguousProperties.push(fieldName);
        notes.push(
          `${input.adapterType}: '${name}' has more than one field named '${fieldName}' — reads resolve to the first`,
        );
        continue;
      }
      if (field.readable === false) {
        // A WRITE-ONLY field (WhatsApp's send-side `File`): it stays on the
        // write shape below, but is DELIBERATELY absent from the readable
        // properties — this is intent, not under-description, so it must
        // not open the position. Listed so a read gets the pointed
        // write-only diagnostic instead of the generic unknown-property one.
        writeOnlyProperties.push(fieldName);
      } else {
        properties[fieldName] = type;
        // The per-property filter/order capability rides alongside the type,
        // keyed by the same surface name (chunk 4/5). The gate (chunk 6) reads it
        // for a `native` edge into this position.
        if (field.capability !== undefined) propertyCapabilities[fieldName] = field.capability;
      }
      if (field.writable) {
        writableFields[fieldName] = type;
        writeFieldNameById.set(field.fieldId, fieldName);
        if (field.required === true) requiredFields.push(fieldName);
        // Authoring guidance rides along — value conventions and live
        // workspace facts (e.g. Slack's actual channel names) that an
        // author can't know from the type alone.
        if (typeof field.description === 'string' && field.description.length > 0) {
          fieldDocs[fieldName] = field.description;
        }
      }
    }

    const edges: Record<string, EdgeSchema> = {};
    const edgeSurfaceByFieldId = new Map<string, string>();
    // A required reference field IS a required edge (the projection rule):
    // the declaring type cannot be created without it, so its writable
    // root declares the entry — satisfied by a tuple/linked path rooted at
    // a `from`-typed handle, or a body field named like the edge. The edge
    // is keyed by its NATURAL name (reference `name` ?? `fieldId`); the
    // target is the target type's natural name (its displayName).
    const requiredEdges: Array<{ edge: string; from: string }> = [];
    for (const ref of descriptor.references) {
      const edge = ref.name ?? ref.fieldId;
      if (leaveOutArtificialEdge({ adapterType: input.adapterType, edge, notes })) continue;
      const targetNames = targetNamesOf(ref);
      // ONE edge, ONE landing TYPE — but that type may be a UNION. A reference
      // that declares several targets projects as a polymorphic edge onto a
      // union of them: the read side types the hop as the union (narrow with
      // `IS` to reach a variant's own surface), the write side already demands
      // an explicit member (`write x-[:GPs]-><People> { … }`).
      //
      // The union's identity is DERIVED from its members (`unionKey`) — an
      // opaque address both sides re-derive, never a fabricated name. Two edges
      // landing on the same types therefore land on the SAME type, which is
      // what a structural union means.
      //
      // Members that resolve to one name are not a union at all: the landing IS
      // that single type, and minting a one-member union would spell an
      // ordinary edge two ways.
      const polymorphic = targetNames.length > 1;
      const target = polymorphic ? unionKey(targetNames) : targetNames[0];
      if (polymorphic) {
        unions[target] = unionVariants(targetNames);
        unionDisplayNames[target] = unionDisplay(targetNames);
      }
      // The reserved `_resources` reference targets the engine's synthetic
      // resource type by design — never a published entry point.
      const unpublished = referenceTargetTypeIds(ref).filter(
        (typeId) => allEntries.find((e) => e.typeId === typeId) === undefined,
      );
      if (
        unpublished.length > 0 &&
        ref.fieldId !== RESOURCES_REFERENCE_FIELD_ID &&
        !input.lazilyWalked
      ) {
        // The reference points at a type `listEntryPoints` doesn't publish —
        // the raw internal id lands in the schema (and poisons the landed-
        // record restamp for this edge). Adapter drift: make it visible.
        //
        // ...but only for an instance whose surface is published WHOLE. When
        // the adapter is walked lazily (`edgesFrom`), an edge to a type we
        // haven't walked to yet is the NORMAL state, not drift — a base's
        // tables are unpublished until someone follows the base. Firing here
        // would mean a note on every un-traversed edge, which is noise that
        // teaches readers to ignore the real thing.
        notes.push(
          `${input.adapterType}: '${name}' reference '${ref.name ?? ref.fieldId}' targets ` +
            `${unpublished.map((t) => `'${t}'`).join(', ')}, which listEntryPoints does not ` +
            `publish — the internal id will surface; publish the type or name it naturally`,
        );
      }
      if (edges[edge] === undefined) {
        edges[edge] = {
          target,
          // The landing type varies per record: reads type as the union and
          // narrow with `IS`; a linked write must name the member it creates.
          ...(polymorphic ? { polymorphic: true } : {}),
          ...(ref.required === true ? { required: true } : {}),
          // Whether/how filter/order/limit push across this edge (chunk 4/5).
          ...(ref.capability !== undefined ? { capability: ref.capability } : {}),
          // What the edge's members are inherently ordered BY — a different
          // fact from `capability.order` (pushdown). Absent ⇒ unordered.
          ...(ref.sequenced !== undefined ? { sequenced: ref.sequenced } : {}),
          // Writing along this edge is an ACTION, not a record write — the
          // typing-indicator seam (message-write-unification §4.2).
          ...(ref.ephemeral === true ? { ephemeral: true } : {}),
          // `readable` still defaults TRUE — only an explicit opt-out projects
          // (readable:false = write-only edge, no read API behind it).
          ...(ref.readable === false ? { readable: false } : {}),
          // `writable` is THE write promise and is EXPLICIT (layer 13): only
          // `true` projects, and its absence IS the read-only fact. It carries
          // what `creatable` used to, so it gates `createShapes` below.
          ...(ref.writable === true ? { writable: true } : {}),
          // The half of that promise an adapter can withdraw: `false` says two
          // records that already exist cannot be joined along this edge, so
          // `link`/`unlink` are refused at check time rather than at run time.
          // Absent ⇒ `writable`'s promise stands whole.
          ...(ref.linkable === false ? { linkable: false } : {}),
          // The far end must still EXIST to traverse (the adapter hydrates it
          // by fetch). An event position whose address pins `action` to the
          // deleted kind drops these edges (listen_narrowing's graft — keyed
          // on the pin, not on a synthesized variant name).
          ...(ref.requiresLiveRecord === true ? { requiresLiveRecord: true } : {}),
          // The hop from an event to the record it is about (D40(b)) — what a
          // listen's `fields:` names properties of. Declared by the adapter,
          // never inferred from the edge's name.
          ...(ref.subject === true ? { subject: true } : {}),
          // The AWAITABLE promise (asks-as-adapter §A) — `await x-[:edge]->`
          // untilNonEmpty. Only `true` projects; its absence is the ordinary
          // (non-awaitable) fact. `resolvesEmpty` rides it (F20).
          ...(ref.awaitable === true ? { awaitable: true } : {}),
          ...(ref.resolvesEmpty === true ? { resolvesEmpty: true } : {}),
          // The PUSH promise beside the resolution promise: whether anything
          // tells the run this edge resolved. Only `true` projects — an
          // adapter that hasn't said gets the polled form.
          ...(ref.watchable === true ? { watchable: true } : {}),
          // The landing is decided by the WRITE (`Options` fixing an ask's
          // answer enum). Carried verbatim: the checker matches `field` against
          // the body's authored names, which are these same display names.
          ...(ref.genericOver !== undefined ? { genericOver: ref.genericOver } : {}),
          // The system's resources edge (the reserved `_resources` reference,
          // walked by its own name — the knowledge graph's `Resources`). Only
          // a diagnostic reads it: since language version 5 `x-[f:_resources]->`
          // off a record is refused, naming this edge.
          ...(ref.fieldId === RESOURCES_REFERENCE_FIELD_ID ? { resources: true as const } : {}),
        };
        if (ref.required === true) requiredEdges.push({ edge, from: target });
      }
      // Writing along a polymorphic edge creates ONE of its members, so every
      // member needs a write shape — the union key names no shape of its own.
      if (ref.writable === true) for (const t of targetNames) writableTargets.add(t);
      // The native-uniqueness projection maps a reference's INTERNAL fieldId
      // (how `describe().uniquenessConstraints` names it) to the surface
      // edge name.
      edgeSurfaceByFieldId.set(ref.fieldId, edge);
    }

    if (entry.readable || entry.fires === true || edgeTargetNames.has(name)) {
      // Readable from the root, reachable by traversing to it, OR delivered by
      // a listen (`fires`). A type you can only arrive at still has a surface
      // once you're there.
      //
      // THE EVENT IS JUST A NODE — a `fires` entry projects like any other:
      // no per-action variants, no union, no synthesized names. Where a
      // change-kind axis exists it is an ordinary `action` enum field on this
      // node, narrowed in the ADDRESS (`` WHERE `action` == "record.created" ``);
      // the narrowed positions are grafted on demand from the addresses the
      // program names (listen_narrowing.ts), never synthesized here.
      //
      // `fires` is not gated on `readable`, and that is the point: nobody can
      // enumerate an inbox, so an event entry says `readable: false` honestly
      // — it mints this position but never a root collection.
      positions[name] = {
        properties,
        edges,
        ...(Object.keys(propertyCapabilities).length > 0 ? { propertyCapabilities } : {}),
        ...(droppedField ? { openProperties: true } : {}),
        ...(writeOnlyProperties.length > 0 ? { writeOnlyProperties } : {}),
        ...(ambiguousProperties.length > 0 ? { ambiguousProperties } : {}),
        // The system removes a record of this type (its `deleteRecord`) — the
        // promise `delete x` is checked against since language version 5.
        ...(descriptor.deletable === true ? { deletable: true } : {}),
      };
    }
    // A purely read-only type (no writable field) needs no write shape at
    // all — neither a writableRoot nor a createShapes entry. Types with a
    // writable field get a shape unconditionally: `entry.writable` only
    // gates whether it registers as a top-level `write instance.<root>`
    // target; an edge-writable type (message-write-unification §5.1) gets
    // the SAME shape filed under `createShapes` instead, below.
    if (Object.keys(writableFields).length > 0) {
      // The target's own identity rules, declaratively — what the adapter
      // already enforces behaviourally at resolveEntity time (it merges
      // `describe().uniquenessConstraints` into every resolve). The
      // constraints name the adapter's INTERNAL fieldIds; project them onto
      // the surface property names (`knownFields`) and edge names.
      const surfaceFieldByInternalId = new Map(
        descriptor.fields
          .filter((f) => properties[f.displayName] !== undefined)
          .map((f) => [f.fieldId, f.displayName] as const),
      );
      const nativeUniqueness = projectNativeUniqueness({
        constraints: descriptor.uniquenessConstraints,
        surfaceFieldByInternalId,
        edgeSurfaceByFieldId,
        parentEdges: incomingEdgeNames.get(name) ?? new Set<string>(),
        label: name,
        notes,
      });
      // The UNTAGGED write union, mapped from declared field ids onto the
      // surface names the checker checks a body against. Projected HERE — with
      // the shape, from this type's own fields — rather than in a second pass
      // like `discriminatedWrite`, which has to wait for its variant TYPES to
      // have been described. A union variant names no type, so there is
      // nothing to wait for.
      const fuzzyResolution = projectFuzzyResolution({
        declared: descriptor.supportsFuzzyResolution,
        surfaceFieldByInternalId: new Map([...writeFieldNameById, ...surfaceFieldByInternalId]),
        label: name,
        notes,
      });
      const writeUnion =
        descriptor.writeUnion !== undefined
          ? projectWriteUnion({
              declaration: descriptor.writeUnion,
              writeFieldNameById,
              label: name,
              notes,
            })
          : undefined;
      const shape: WritableRootSchema = {
        fields: writableFields,
        // A write handle references the CREATED RECORD, so its readable surface
        // is that record's type: the engine's result currency (synthesized/real
        // externalId + the adapter's result-data url), the READABLE fields the
        // type describes, and the written fields echoed back (M4a). The readable
        // set matters once a handle can be `refresh`ed (asks-as-adapter F5): a
        // re-fetch moves the snapshot of fields like an ask's read-only `State`,
        // so those must be part of the handle's type even though the create body
        // never wrote them. Write echoes win on shared names (same type anyway).
        // What the write DID is not a field of the record: an author asks the
        // handle's `-[:@old]->`, and the checker supplies the retired
        // `created` / `committed` itself to a program pinned before it.
        resultShape: {
          externalId: 'text',
          url: 'text',
          ...properties,
          ...writableFields,
        },
        ...(nativeUniqueness.length > 0 ? { nativeUniqueness } : {}),
        // The full relationship surface for the write side — every edge with
        // its target + required flag, so authoring a write sees the OPTIONAL
        // linkable edges too (not just `requiredEdges`). Same edges the
        // readable position carries.
        ...(Object.keys(edges).length > 0 ? { edges } : {}),
        ...(requiredEdges.length > 0 ? { requiredEdges } : {}),
        ...(requiredFields.length > 0 ? { requiredFields } : {}),
        ...(Object.keys(fieldDocs).length > 0 ? { fieldDocs } : {}),
        ...(fuzzyResolution !== undefined ? { fuzzyResolution } : {}),
        ...(descriptor.uniquenessAuthorable === false
          ? { uniquenessAuthorable: false }
          : {}),
        ...(writeUnion !== undefined ? { writeUnion } : {}),
      };
      shapeByName[name] = shape;
      if (entry.writable) writableRoots[name] = shape;
    }
  }

  // A type some edge TARGETS that THE ENTRY LIST NEVER MENTIONS — an Airtable
  // table behind its base on a lazily-walked instance, or genuine adapter drift
  // (noted above). It is reachable, so it IS a position; nothing has described
  // it, so it is `undescribed`.
  //
  // It used to be NOTHING — no entry, no position, so `positionRefIn` answered
  // `undefined` and the handle went untyped. That is the same conflation as the
  // open projection, one level down: "no type information" and "no such type"
  // were both spelled `undefined`, so `` e-[r:record]->.`Name` `` had no
  // position to be wrong about and drew no diagnostics. Minting the position is
  // what lets the read be TOLD it is a guess.
  //
  // Targets that ARE entries are deliberately not swept: the entry loop above
  // already mints them (undescribed when no descriptor came back), and WHICH
  // entries this projection covers is the caller's scope to choose — a
  // types-scoped describe answering about one type must not start inventing
  // positions for the rest. This sweep is only for types the entry list has
  // never heard of, which nothing else can account for.
  const entryNames = new Set(allEntries.map((e) => e.displayName));
  for (const target of edgeTargetNames) {
    if (positions[target] !== undefined) continue;
    if (entryNames.has(target)) continue;
    positions[target] = { properties: {}, edges: {}, undescribed: true };
  }

  // Types with no top-level writable root, but reachable via a writable
  // edge from another written record — a linked write may create them
  // there even without a `write instance.<root>` entry point of their own.
  // A type that already has a writableRoot doesn't need a createShapes
  // entry too — `writableRoots[t] ?? createShapes?.[t]` already finds it,
  // and the two stay disjoint registries.
  for (const target of writableTargets) {
    if (writableRoots[target] !== undefined) continue;
    const shape = shapeByName[target];
    if (shape) createShapes[target] = shape;
  }

  // DISCRIMINATED WRITE SHAPES: a descriptor may declare that its write body is
  // a discriminated union keyed on a required field's literal (the write-side
  // dual of read narrowing). Compose each variant from the per-variant type's
  // ALREADY-BUILT write shape — no new fanout: the variant types were described
  // in this same pass and their shapes are in `shapeByName`. Merge onto the
  // base type's own shape so the discriminant field + common fields ride every
  // variant, then hang the `discriminated` block on wherever the base shape is
  // registered (a top-level `writableRoots` entry or, for a create-edge target
  // like Attio's `List`, its `createShapes` entry — the same object).
  //
  /** Type names somebody actually LOOKED at — an entry with a descriptor back. */
  const describedTypeNames = new Set(
    allEntries.filter((e) => input.descriptors.has(e.typeId)).map((e) => e.displayName),
  );
  for (const [typeId, descriptor] of input.descriptors) {
    const declaration = descriptor.discriminatedWrite;
    if (declaration === undefined) continue;
    const name = allEntries.find((e) => e.typeId === typeId)?.displayName ?? typeId;
    const base = shapeByName[name];
    // No writable base shape ⇒ nothing to discriminate (a read-only type that
    // happens to declare a discriminant — degrade to silence, don't invent).
    if (base === undefined) continue;
    const variants: Record<string, WritableRootSchema> = {};
    for (const [literal, variantTypeName] of Object.entries(declaration.variantTypes)) {
      // DESCRIBED is the question, not "has a write shape". A variant type that
      // was described and simply has no writable fields of its own (Attio's
      // Pipeline) legitimately IS the base; one nobody ever looked at is not —
      // and `shapeByName` alone cannot tell them apart, since a type with no
      // writable fields never gets an entry either.
      //
      // Silently treating the second as the first is the conflation this file
      // already calls out for positions (`undescribed` vs `openProperties`): it
      // makes "the adapter promised a variant we never resolved" indistinguishable
      // from "this variant adds nothing", and quietly widens the create body to
      // whatever the base happens to allow. So omit it and SAY so — the checker
      // then falls back to the base shape, which is strict rather than
      // permissive, and the note names the variant that went missing.
      if (!describedTypeNames.has(variantTypeName)) {
        notes.push(
          `${input.adapterType}: ${name} declares write variant "${literal}" as type ` +
            `'${variantTypeName}', which was never described — the variant is omitted rather ` +
            `than collapsed onto the base shape, so a body naming that variant's own fields is ` +
            `rejected rather than silently accepted.`,
        );
        continue;
      }
      variants[literal] = {
        ...mergeVariantShape(base, shapeByName[variantTypeName]),
        // The variant is a TYPE, not just a body shape: the record this write
        // creates is a row of that one list, so the handle it hands back stands
        // on the list's own position and a chained write or `link` off it walks
        // that type's edges. Only when the variant type mints a position —
        // otherwise the handle keeps the collection's, which is the strict
        // answer rather than an invented one.
        ...(positions[variantTypeName] !== undefined ? { position: variantTypeName } : {}),
      };
    }
    const discriminated: DiscriminatedWriteShape = {
      discriminant: declaration.discriminant,
      variants,
    };
    // `writableRoots[name]` / `createShapes[name]` alias the same object as
    // `base`, so mutating `base` attaches the block to whichever registry holds
    // it. Set it AFTER building the variants (a variant is never itself
    // discriminated — nested discriminants aren't needed).
    base.discriminated = discriminated;
  }

  // The DECLARED event surface: one entry per `fires`-marked meta edge, in
  // declaration order, read off the FULL entry list so a scoped describe that
  // excludes an event entry still names the real event surface. The primary
  // `eventPosition` (shape conformance, diagnostics) is the first declared
  // edge; adapters with none fall back to the single-readable heuristic (an
  // adapter whose one readable entry IS what a listen delivers). The heuristic
  // never joins `eventPositions`: that list drives listen typing and event
  // seeding, and a heuristic there would type a re-retrievable record as an
  // occurrence.
  const eventPositions = allEntries
    .filter((e) => e.fires === true)
    .map((e) => ({
      position: e.displayName,
      ...(e.firesOn !== undefined ? { on: [...e.firesOn] } : {}),
    }));
  // A capability the ROOT descriptor declares for a name `listEntryPoints`
  // publishes no collection under: the walk and the entry list disagreeing
  // about the same root edge. Dropping it silently would leave the gate
  // permissive with nothing saying why, so it is named. Checked against the
  // FULL entry list — a scoped describe states fewer facts, never different
  // ones.
  const publishedCollectionNames = new Set(
    allEntries
      .filter((e) => e.readable === true || e.writable === true)
      .map((e) => e.collectionName ?? e.displayName),
  );
  for (const collectionName of rootCapabilities.keys()) {
    if (publishedCollectionNames.has(collectionName)) continue;
    notes.push(
      `${input.adapterType}: the root descriptor declares a capability for '${collectionName}', which listEntryPoints publishes no collection under — the declaration is dropped; give the two the same name`,
    );
  }

  const readableEntries = allEntries.filter((e) => e.readable);
  const eventPosition =
    eventPositions[0]?.position ??
    (readableEntries.length === 1 ? readableEntries[0].displayName : undefined);

  return {
    schema: {
      positions,
      collections,
      ...(Object.keys(unions).length > 0 ? { unions, unionDisplayNames } : {}),
      writableRoots,
      ...(Object.keys(createShapes).length > 0 ? { createShapes } : {}),
      ...(input.supportsInPlaceUpdate ? { supportsInPlaceUpdate: true } : {}),
      ...(input.edgesCarryProperties ? { edgesCarryProperties: true } : {}),
      ...(eventPosition !== undefined ? { eventPosition } : {}),
      ...(eventPositions.length > 0 ? { eventPositions } : {}),
    },
    notes,
  };
}

/**
 * One variant of a discriminated write shape: the per-variant type's write
 * shape merged ONTO the base type's own, so the discriminant field and any
 * common fields ride every variant (the TS union member carries the whole
 * object type, discriminant included). The variant's fields/required set win
 * where they overlap. Always a fresh object, and never itself discriminated —
 * nested discriminants aren't needed and a variant must not alias the base
 * (which gains `.discriminated`).
 *
 * `variant === undefined` now means exactly ONE thing: the variant type WAS
 * described and has no writable fields of its own (Attio's Pipeline, no entry
 * attributes), so the variant legitimately is the base shape. The caller
 * filters out never-described variant types before calling — collapsing those
 * onto the base is a silent widening, not a merge.
 */
function mergeVariantShape(
  base: WritableRootSchema,
  variant: WritableRootSchema | undefined,
): WritableRootSchema {
  if (variant === undefined) {
    const { discriminated: _drop, ...rest } = base;
    return rest;
  }
  const { discriminated: _dropBase, ...baseRest } = base;
  const requiredFields = [
    ...new Set([...(base.requiredFields ?? []), ...(variant.requiredFields ?? [])]),
  ];
  return {
    ...baseRest,
    fields: { ...base.fields, ...variant.fields },
    resultShape: { ...base.resultShape, ...variant.resultShape },
    ...(requiredFields.length > 0 ? { requiredFields } : {}),
    ...(base.edges !== undefined || variant.edges !== undefined
      ? { edges: { ...(base.edges ?? {}), ...(variant.edges ?? {}) } }
      : {}),
    ...(base.fieldDocs !== undefined || variant.fieldDocs !== undefined
      ? { fieldDocs: { ...(base.fieldDocs ?? {}), ...(variant.fieldDocs ?? {}) } }
      : {}),
    // A variant TYPE may itself declare an untagged write union over its own
    // fields (the base cannot — a type declaring both write unions is a schema
    // error). It rides the merged variant rather than being dropped, which
    // would silently widen that variant's body to "anything goes".
    ...(variant.writeUnion !== undefined ? { writeUnion: variant.writeUnion } : {}),
  };
}

// ── Credential rows → import names ──────────────────────────────────────────

export interface CredentialRow {
  id: string;
  name: string;
  type: string;
}

/**
 * Build the credential-name → catalog entry map. Keyed by the verbatim
 * `row.name` (unique per team). A credential type serving several adapters
 * (e.g. GOOGLE → sheets + drive) produces ONE entry whose `adapters` lists
 * them all. Credentials whose type has no registered adapter are omitted.
 */
export function credentialImportNames(input: {
  rows: CredentialRow[];
  manifests: Pick<AdapterManifest, 'adapterType' | 'requiredCredentialType'>[];
}): Record<string, { id: string; rowName: string; adapters: string[] }> {
  const adaptersByType = new Map<string, string[]>();
  for (const m of input.manifests) {
    if (!m.requiredCredentialType) continue;
    const list = adaptersByType.get(m.requiredCredentialType) ?? [];
    list.push(m.adapterType);
    adaptersByType.set(m.requiredCredentialType, list);
  }
  const out: Record<string, { id: string; rowName: string; adapters: string[] }> = {};
  for (const row of input.rows) {
    const adapters = adaptersByType.get(row.type) ?? [];
    if (adapters.length === 0) continue;
    out[row.name] = { id: row.id, rowName: row.name, adapters };
  }
  return out;
}
