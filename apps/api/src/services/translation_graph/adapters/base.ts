// Base class for TG adapters — provides sensible defaults so new adapters
// only have to override the methods that actually differ from the common
// case. Three rough categories of defaults:
//
//   • Identity resolution → linked-object bridge match on `record.id`.
//     This is what most external adapters want; the engine pre-filters
//     candidates by adapterType + recordType, so all that's left is
//     matching the inbound record's id against `candidate.external_id`.
//
//   • Field-level reads → scalar lookup on the position's data payload
//     (`positionData(position)[fieldId]`). New adapters that cache their
//     record payload on the position get scalar reads for free; override
//     for adapters with computed/aliased fields or nested-envelope
//     payloads.
//
//   • Writes (create/update/delete) → throw a uniform
//     "not implemented" error. Source-only adapters inherit this and
//     get a clean diagnostic if anything ever tries to route writes
//     through them; target-capable adapters override.
//
// ── THE ONE RULE every adapter follows (name ↔ structured-identifier) ──
// A position's `recordType` is the pretty TYPE NAME (the `displayName`) — the
// only type currency the framework, the engine, and other adapters ever see.
// Your own routing identifier (an object slug, a `{ baseId, tableId }`, a kind
// enum, a node-type UUID — whatever your API actually needs) is PRIVATE: it
// lives only in a per-adapter `name → identifier` cache (built from your own
// introspection, or read off the event/record when only the payload exposes
// it), and you resolve the name → identifier on the first line of each method.
// NEVER stamp your identifier onto a position you emit, and never encode it into
// a magic string. A position that carries a raw identifier is a leak — it drifts
// loudly at the resolver boundary, by design, so the bug is caught immediately
// rather than silently tolerated. (See `airtable/` for the introspected-id
// reference, `native_valuations.ts` for the fixed-set variant, and
// `plans/2026-06-29-typeid-displayname-duality/1_name_to_identifier_cache.md`.)
//
// The KG adapter is intentionally NOT built on this base — its source
// positions are `kg-node`/`kg-edge` rather than `external-record`, and
// its identity model is constraint-driven, not bridge-driven. Anything
// derived from `BaseAdapter` is, by convention, an external-system
// adapter.

import { eventAddressEventName } from 'movement-lang';

import type {
  Adapter,
  RuntimeCapabilities,
  DeleteInput,
  DeleteResult,
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
  ResolveEntityInput,
  ResolveEntityResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from 'movement-engine/services/translation_graph/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor } from 'movement-engine/services/translation_graph/types';
import type { TriggerType } from 'movement-engine/services/translation_graph/triggers/types';

import { BASE_RUNTIME_CAPABILITIES } from 'movement-engine/services/translation_graph/adapter';
import { positionData } from 'movement-engine/services/translation_graph/types';
import {
  AdapterNameDriftError,
  memoizedResolver,
  naturalName,
  type ScopedResolver,
} from './name_resolution';

export abstract class BaseAdapter implements Adapter {
  abstract readonly adapterType: string;
  abstract readonly supportedTriggers: readonly TriggerType[];

  /**
   * External adapters get the plain whole-adapter capability set by default:
   * outgoing-only traversal, no edge properties, no resources. The KG (which
   * does NOT extend this base) overrides to enable all three; any external
   * adapter that genuinely supports one overrides this method.
   */
  runtimeCapabilities(): RuntimeCapabilities {
    return BASE_RUNTIME_CAPABILITIES;
  }

  abstract listEntryPoints(): Promise<SchemaEntryPoint[]>;
  abstract describe(typeId: string): Promise<SchemaTypeDescriptor | null>;

  /**
   * Natural-name ⇄ internal-id resolver for THIS instance, memoized from the
   * instance's OWN `listEntryPoints()` / `describe()` (instances are
   * per-credential). The interface methods below trade in the program's
   * NATURAL names; each resolves them to the adapter's own internal currency
   * on its first line through this — the engine/host does NO id-translation.
   *
   * `describe()` itself takes an internal `typeId` (its result FEEDS the
   * resolver, so it cannot depend on it) — callers translate the natural type
   * name to an id with `resolver().typeId(...)` before calling `describe`.
   *
   */
  protected readonly resolver: ScopedResolver = memoizedResolver(this);

  /**
   * Resolve a `describe(ref)` argument to this adapter's INTERNAL typeId.
   * `describe` keeps its internal-typeId contract for the legacy callers that
   * feed it (the resolver build, the TG editor's stored `targetTypeRef`s), but
   * the movement engine and checker reach it by the program's NATURAL type
   * name — so each adapter accepts BOTH: a `ref` that matches an entry's
   * `displayName` resolves to that entry's typeId; otherwise `ref` is already
   * the internal typeId (or an unknown one — the adapter's own `describe`
   * returns null for it). Entries-only, memoized — never calls `describe`, so
   * there's no recursion.
   */
  protected async resolveTypeRef(ref: string): Promise<string> {
    if (this.typeIdByDisplayName === undefined) {
      this.typeIdByDisplayName = (async () => {
        const map = new Map<string, string>();
        for (const entry of await this.listEntryPoints()) {
          map.set(entry.displayName, entry.typeId);
        }
        return map;
      })();
      this.typeIdByDisplayName.catch(() => {
        this.typeIdByDisplayName = undefined;
      });
    }
    return (await this.typeIdByDisplayName).get(ref) ?? ref;
  }
  private typeIdByDisplayName?: Promise<Map<string, string>>;

  /**
   * Default identity resolution: match an inbound record against the
   * pre-filtered linked-object candidates by `record.id`. Covers the
   * "engine already bridged this record before" case. Override when the
   * adapter has native uniqueness rules to search against the live
   * external system (Attio's `is_unique` attribute filter, KG's
   * constraint-driven match).
   */
  async resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    const recordId = (input.record as { id?: unknown } | null | undefined)?.id;
    if (typeof recordId !== 'string') return { candidates: [] };
    const candidate = input.candidates.find((c) => c.external_id === recordId);
    if (!candidate) return { candidates: [] };
    return {
      candidates: [{ adapterType: this.adapterType, externalId: recordId, data: {} }],
    };
  }

  /**
   * Default field read: scalar lookup on the position's data payload, keyed by
   * the adapter's OWN internal field id. The interface hands `fieldId` as the
   * program's NATURAL name (the field `displayName`) and the position carries
   * the NATURAL type name as its `recordType` (the source-read wrapper stamps
   * it); we translate the natural field to the internal id this instance's
   * data is keyed by, against that type, through THIS instance's own resolver.
   * Works for any position that carries its record inline. Adapters whose
   * records carry nested envelopes (Attio's `values` arrays, …) or
   * computed/aliased fields must override. Returns null when the position has
   * no data (a stable position the adapter must materialise, or meta).
   */
  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== this.adapterType) {
      throw new Error(
        `${this.adapterType}.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    const data = positionData(input.position) as Record<string, unknown> | null | undefined;
    if (!data) return null;
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    return data[fieldId] ?? null;
  }

  /**
   * Translate a NATURAL field name to this adapter's internal field id against
   * a position's type — the per-method first-line translation the interface
   * requires. The position's `recordType` IS the natural type name (the
   * source-read wrapper stamps it), so the field resolves directly through this
   * instance's own resolver; a miss throws drift (Decision #4). When the
   * position has no type to resolve against (a typeless inbound node) there is
   * nothing to translate — the natural name is used as-is.
   */
  protected async resolveFieldId(
    position: GetFieldValueInput['position'],
    fieldNaturalName: string,
  ): Promise<string> {
    const typeName = position.recordType;
    if (typeName === null) return fieldNaturalName;
    const resolver = await this.resolver({ types: [typeName] });
    return resolver.fieldId(naturalName(typeName), naturalName(fieldNaturalName));
  }

  /**
   * Translate a NATURAL edge name to this adapter's READ-side reference id
   * (`getRelated` currency) against a position's NATURAL type — the per-method
   * first-line translation for traversal reads. A miss throws drift
   * (Decision #4).
   *
   * A TYPELESS position is an ERROR, not a case to handle (ruling
   * 2026-07-19). This used to fall back to scanning every described type for an
   * edge with a matching name — a whole-graph read on the write path, with no
   * collision policy, so on a graph where two types share an edge name it
   * silently picked one. It was the HOST guessing on the adapter's behalf.
   *
   * The producers were fixed instead: Slack names its file positions, the KG
   * joins the other end's node type, and the engine refuses an event it cannot
   * type. An adapter that mints a position knows what it is; nothing else can.
   */
  protected async resolveEdgeReadId(
    typeName: string | null,
    edgeNaturalName: string,
  ): Promise<string> {
    // The parameter stays nullable only because `SourcePosition.recordType`
    // still is; nothing may pass null and get an answer. Making the POSITION
    // type non-nullable is the structural finish (the producers are all fixed,
    // so it is unreachable in practice) — a ~47-site compiler-driven sweep,
    // deliberately not done in a tree another session is editing.
    if (typeName === null) {
      throw new AdapterNameDriftError(
        `${this.adapterType}: a position reached '${edgeNaturalName}' without a type. ` +
          `Nothing can resolve an edge without knowing what holds it — the position's minter must name its type.`,
      );
    }
    // An EVENT position's recordType is the engine's address KEY, not a type
    // name — so scoping by it looks up a type nobody described and the edge
    // name falls through unresolved. Ask the module that mints the key which
    // event it names; an ordinary type name comes back unchanged.
    //
    // Adapters whose events pin nothing were unaffected only because an
    // unpinned key IS the event name. Airtable pins base and table on every
    // event, so its `Record` edge never resolved to `record` and the row that
    // fired the listener was unreachable.
    const scope = eventAddressEventName(typeName);
    const resolver = await this.resolver({ types: [scope] });
    return resolver.edgeReadId(naturalName(scope), naturalName(edgeNaturalName));
  }

  /**
   * Default traversal: throws. Adapters that publish references in their
   * schema descriptor must implement this to back them — there's no
   * universal scalar fallback that does the right thing across systems.
   */
  async getRelated(_input: GetRelatedInput): Promise<RelatedResult[]> {
    throw this.notImplemented('getRelated');
  }

  /**
   * Default writes throw. Adapters that act as a target override the
   * three methods below; source-only adapters inherit the throws and
   * get a clear diagnostic if writes ever get routed to them.
   */
  async createRecord(_input: WriteInput): Promise<WriteResult> {
    throw this.notWriteCapable('createRecord');
  }
  async updateRecord(_input: UpdateInput): Promise<UpdateResult> {
    throw this.notWriteCapable('updateRecord');
  }
  async deleteRecord(_input: DeleteInput): Promise<DeleteResult> {
    throw this.notWriteCapable('deleteRecord');
  }

  protected notImplemented(method: string): Error {
    return new Error(`${this.adapterType}.${method} is not implemented`);
  }

  protected notWriteCapable(method: string): Error {
    return new Error(
      `${this.adapterType} is not configured as a write target — ${method} called`,
    );
  }
}
