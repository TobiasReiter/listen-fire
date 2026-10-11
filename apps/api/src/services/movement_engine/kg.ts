// Movement engine — the KG-as-adapter seam (E3).
//
// The knowledge graph already speaks the Adapter contract
// (`translation_graph/adapters/knowledge_graph.ts`): consolidation's
// candidate search is its `resolveEntity` (including the kg_uniqueness
// adjacency search that powers edge-scoped compound identity), changeset
// application is `createRecord`/`updateRecord`
// (`knowledge_graph_writes.ts` — property + evidence rows in one
// transaction, parent-link edge wiring, mutation-event derivation at the
// commit boundary), and the team ontology is its own `listEntryPoints()` /
// `describe()` introspection like any other adapter's. The movement engine
// therefore resolves graph write targets through the SAME `resolveAdapter`
// seam as every other target — there is no special engine path, exactly as
// 6_engine.md prescribes.
//
// The engine-side correspondence GLUE that used to live here
// (`loadBridgeCandidates`, `bridgeToExternalForCreate`, `ensureKgBridge`) is
// RETIRED: correspondence is no longer an implicit KG bridge the engine
// asserts on every write. It is now a generic, engine-owned, symmetric
// BINDING declared in the language (`write … bind other`) and stored by
// the host (`translation_graph/movement/record_bindings.ts`) — the adapter is
// correspondence-agnostic. The KG
// adapter keeps `getPriorMatch` / `recordLink` and `linked_object` solely for
// the frozen TG engine (a parity harness), which still rides them; the live
// movement engine touches neither (explicit-linking, 3b).
//
// What remains HERE is the read-side `surfaceReadAdapter`, which is NOT
// KG-specific: it is the
// uniform natural-name read wrapper every source adapter rides. It carries NO
// name↔id translation (the adapter does that internally, Decision #3) — it
// only stamps each position's `recordType` with the hop target's NATURAL type
// (so the adapter can resolve the verbatim field/edge name) and preserves
// inline `data`. It lives here because the kg-seeded source was its first
// consumer, but it carries no KG knowledge.

import type { InstanceSchema, SchemaFieldType } from 'movement-lang';
import type {
  Adapter,
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
} from '../translation_graph/adapter';
import { filesAtType } from '../translation_graph/adapter';
import {
  META_RECORD_TYPE,
  isStablePosition,
  makeStablePosition,
  makeUnstablePosition,
  positionData,
  positionRecordId,
  type SourcePosition,
} from '../translation_graph/types';

// ── Source reads in the program's natural vocabulary ────────────────────────
//
// A movement reads its source positions through the SAME adapter read seam
// every source uses (`getFieldValue` / `getRelated`), and the PROGRAM speaks
// the adapter's NATURAL names (`m.\`From\``, `rec.\`Amount\``, `-[:\`Lead
// Investor\`]->`). The engine carries ZERO name↔id translation: it hands the
// natural field / edge / collection name straight to the adapter, which
// resolves it to its own internal id on the first line of `getFieldValue` /
// `getRelated` (Decision #3). This wrapper is therefore NOT a translator. It
// owns exactly two read-side concerns the adapter can't:
//
//   - STAMP each position's `recordType` with the hop target's NATURAL TYPE
//     NAME (resolved from the instance schema), so the adapter's own
//     `getFieldValue` knows which type to resolve the natural field against.
//     The raw event seed is often typeless (a webhook/email payload with
//     `recordType: null`); the movement parameter's declared natural type
//     (`startSurfaceType`) names it. A landed record is stamped with its hop
//     target's natural type.
//   - PRESERVE each position's inline `data` across the stamp — adapters that
//     carry record values inline (and the engine's bridge-to-external on the
//     iterated record) read it; re-stamping the natural type must not drop it.
//     (This inline-`data` preservation is a real bug fix kept from the prior
//     translating wrapper.)
//
// It is UNIFORM — the KG is not special. It lives here because the kg-seeded
// source was its first consumer, but it carries no KG knowledge.

/**
 * WHAT THE ADAPTER SAID THIS RECORD IS — its own stamp, where the schema
 * recognises the name as a position; `undefined` when it does not.
 *
 * The declared edge target is what the SCHEMA says a hop lands on; a walked
 * adapter often knows better, because the landing is polymorphic and it just
 * resolved which member it actually got (Affinity's `List Entries` declares the
 * collection `Organization List Entry`; the adapter lands the concrete `List
 * Entry — Pipeline`, which is the type that genuinely has `Deal Stage`).
 *
 * So the adapter's stamp WINS whenever the projected schema knows that name as
 * a position — it is a more specific answer to the same question, and the
 * schema knowing it is exactly the evidence that downstream reads can resolve
 * against it. Everything else is "the adapter told us nothing usable": the read
 * wrapper falls back to the declared target, and the member gate treats the
 * record as making no claim about which member it belongs to.
 *
 * ONE definition, because those two are the same question asked twice — the
 * wrapper decides what to STAMP a landing with and the gate decides what a
 * landing's stamp MEANS, and a gate that answered differently would compare a
 * name no record can ever carry (which is exactly how a narrowed `List Entries`
 * hop came to drop every record it landed).
 */
export function stampedPositionName(input: {
  schema: InstanceSchema | undefined;
  position: SourcePosition;
}): string | undefined {
  const concrete = input.position.recordType;
  if (concrete === null || concrete === undefined) return undefined;
  return input.schema?.positions[concrete] !== undefined ? concrete : undefined;
}

/** The type the instance's schema declares for a field of a position type. */
export function declaredFieldType(
  schema: InstanceSchema | undefined,
  recordType: string | null,
  field: string,
): SchemaFieldType | undefined {
  if (schema === undefined || recordType === null) return undefined;
  const position = schema.positions[recordType];
  return position !== undefined && Object.hasOwn(position.properties, field) ? position.properties[field] : undefined;
}

export function surfaceReadAdapter(input: {
  inner: Adapter;
  /** The source instance's schema — hop target types resolve against it. */
  schema: InstanceSchema | undefined;
  /** The movement parameter's declared natural type, when known — names the
   *  root position whose `recordType` is typeless/internal. */
  startSurfaceType?: string;
}): Adapter {
  const { inner, schema, startSurfaceType } = input;

  // The NATURAL type of a position: a position already stamped (or named by a
  // discriminated event seed) carries its natural recordType; a typeless root
  // (a raw webhook/email payload) is named by the parameter's declared type.
  const surfaceTypeOf = (position: SourcePosition): string | null =>
    position.recordType ?? startSurfaceType ?? null;

  /** The natural type a hop lands on: outgoing — the declared edge's
   *  target; incoming — the declaring type whose edge points at us. */
  const landedSurfaceType = (
    fromSurface: string | null,
    edgeSurface: string,
    direction: 'outgoing' | 'incoming',
  ): string | undefined => {
    if (schema === undefined || fromSurface === null) return undefined;
    // A POLYMORPHIC edge declares a UNION target — a type the hop lands on but
    // no record ever IS. Its key is not a position, so stamping it would put an
    // unresolvable name where a concrete one belongs; the adapter's own
    // per-record stamp is the answer here, and "we can't name it" (undefined)
    // leaves that stamp alone. "The declared target" and "the landed type" are
    // the same fact only for a single-target edge.
    const declared = (target: string | undefined): string | undefined =>
      target !== undefined && schema.unions?.[target] !== undefined ? undefined : target;
    if (direction === 'outgoing') {
      return declared(schema.positions[fromSurface]?.edges[edgeSurface]?.target);
    }
    for (const [typeName, position] of Object.entries(schema.positions)) {
      if (position.edges[edgeSurface]?.target === fromSurface) return typeName;
    }
    return undefined;
  };

  /**
   * The type a LANDED position should carry: the adapter's own stamp where the
   * schema recognises it, else the declared edge target.
   */
  const landedType = (position: SourcePosition, declared: string | undefined): string | undefined =>
    stampedPositionName({ schema, position }) ?? declared;

  // Re-stamp a position's `recordType` with a NATURAL type so the adapter's
  // own getFieldValue resolves the right type. `natural` undefined means "we
  // can't name the type" — the position is left untouched (the adapter's own
  // recordType stands), so an adapter that already yields a concrete type
  // isn't clobbered. Inline `data` is preserved across the re-stamp. Both a
  // stable record (a landed/iterated row) and an UNSTABLE node (the raw
  // webhook/email event seed — typeless but named by the parameter's declared
  // type) are stamped: the adapter needs the natural type to resolve the
  // verbatim natural field name against it.
  const restamp = (position: SourcePosition, natural: string | undefined): SourcePosition => {
    if (natural === undefined || natural === position.recordType) return position;
    const recordId = positionRecordId(position);
    const data = positionData(position);
    if (isStablePosition(position) && recordId !== undefined) {
      return makeStablePosition({
        adapterType: inner.adapterType,
        recordType: natural,
        recordId,
        ...(data !== undefined ? { data } : {}),
      });
    }
    // Unstable node — carry its inline content and the natural type.
    return makeUnstablePosition({
      adapterType: inner.adapterType,
      recordType: natural,
      data,
    });
  };

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'getFieldValue') {
        return async (read: GetFieldValueInput): Promise<unknown> => {
          // Ensure the adapter sees the NATURAL type on the position so it can
          // resolve the (also-natural) field against it — the field name
          // itself crosses verbatim (the adapter translates).
          const position = restamp(read.position, surfaceTypeOf(read.position) ?? undefined);
          const value = await target.getFieldValue({ ...read, position });
          // A file is what the catalog declares one: the answer at a field
          // typed `file` (or a list of them) is made a file, and any other
          // field's answer is data, whatever keys it carries.
          return filesAtType(declaredFieldType(schema, position.recordType, read.fieldId), value);
        };
      }
      if (prop === 'getRelated') {
        return async (read: GetRelatedInput): Promise<RelatedResult[]> => {
          // `#…` meta references (resources) are the engine's own
          // sentinels — never adapter edges; pass them through.
          if (read.fieldId.startsWith('#')) return target.getRelated(read);
          // A meta-root hop (`crm-[c:Companies]->`, `kg-[c:\`Funding
          // Round\`]->`) is a COLLECTION scan: the natural collection name
          // crosses verbatim (the adapter resolves it to the typeId it
          // scans), and every landed record is stamped with the collection's
          // TARGET type (`schema.collections[name]`, falling back to the
          // collection name) so deeper reads resolve against the right type.
          if (read.position.recordType === META_RECORD_TYPE) {
            const related = await target.getRelated(read);
            const landedNatural = schema?.collections[read.fieldId]?.target;
            return related.map((r) => ({
              ...r,
              position: restamp(r.position, landedType(r.position, landedNatural)),
            }));
          }
          const fromSurface = surfaceTypeOf(read.position);
          // Stamp the FROM position with its natural type so the adapter
          // resolves the (natural) edge name against the right type.
          const position = restamp(read.position, fromSurface ?? undefined);
          const related = await target.getRelated({ ...read, position });
          const landed = landedSurfaceType(fromSurface, read.fieldId, read.direction ?? 'outgoing');
          return related.map((r) => {
            const natural = landedType(r.position, landed);
            return natural === undefined ? r : { ...r, position: restamp(r.position, natural) };
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
