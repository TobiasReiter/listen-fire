// Lazy schema introspection for the TG editor.
//
// Built on the adapter contract's two primitives:
//   - `listEntryPoints(ref)` — lightweight adapter info: entry-point
//     catalog + capabilities + supportedTriggers. One call per (ref,
//     creds); no per-type attribute fetches.
//   - `describeTypes(ref, typeIds[])` — batched per-type detail
//     loader. The hook gathers all the typeIds a consumer needs into
//     one round-trip; per-type attribute fetches happen lazily inside
//     the adapter and are cached server-side.
//
// Each consumer (right panel, canvas, picker, trigger filter editor)
// declares which types it needs; the hook returns a partial
// `descriptor`-shaped view containing exactly those types — so
// existing `descriptor.types.find(...)` lookups keep working without
// pulling the whole schema upfront.

import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import type { SchemaRef, TraversalStep } from "./schema-ref";
import {
  ontologyToDescriptor,
  type OntologySummary,
} from "./ontology-descriptor";

/**
 * Mirror of F2's `adapterTypeForRef`
 * (apps/api/services/translation_graph/types.ts) — resolves a SchemaRef
 * to a concrete adapter type when one exists. The editor-side schema
 * introspection (entries / describe) is meaningless for the composition
 * arms; they materialise via the runtime, not through an adapter
 * `describe()` call. Returns null in that case so callers can drop the
 * trpc query and render a composition-specific surface instead.
 *
 *   ("E1 — Editor store's `SchemaRef` union has only `knowledge-graph` / `adapter` arms")
 */
function refToAdapterType(ref: SchemaRef): string | null {
  switch (ref.kind) {
    case "knowledge-graph":
      return "kg";
    case "adapter":
      return ref.adapterType;
    case "generic":
    case "generic_reference":
      return null;
  }
}

// Mirrors packages/movement-engine/services/translation_graph/mutation_context.ts.
export type TriggerType =
  | "snapshot"
  | "poll"
  | "changes-feed"
  | "webhook"
  | "mutation"
  | "extraction";

// Schema shapes mirrored locally to avoid a circular dep on the API
// types. Kept in sync with packages/movement-engine/services/translation_graph/types.ts.
export type SchemaEntryPoint = {
  typeId: string;
  displayName: string;
  externalId?: string;
  scope?: "self-configured" | "inherits-parent-config";
  labelTemplate?: string;
  writable: boolean;
  readable: boolean;
};

export type SchemaTypeDescriptor = {
  typeId: string;
  displayName: string;
  /** Optional human description of the node type — mirrors the API
   *  contract; surfaced by the editor's caret hints. */
  description?: string;
  externalId?: string;
  labelTemplate?: string;
  scope?: "self-configured" | "inherits-parent-config";
  fields: {
    fieldId: string;
    displayName: string;
    kind: string;
    enumValues?: string[];
    writable: boolean;
    required: boolean;
    referenceTargetType?: string;
    /** Optional human description of the field — surfaced in caret hints. */
    description?: string;
    /** `'one'` (default) or `'many'` — drives the multi-value type
     *  warning in the expression editor and the engine's
     *  cardinality coercion at write time. */
    cardinality?: "one" | "many";
  }[];
  references: {
    fieldId: string;
    targetTypeId: string;
    cardinality: string;
    polymorphic?: boolean;
    /** Optional human description of the edge — surfaced in caret hints. */
    description?: string;
    /** Direction of the reference. Defaults to `'outgoing'` when omitted.
     *  KG bidirectional edges publish both outgoing (from source type)
     *  and incoming (on target type) references; the runtime dispatches
     *  to `getRelated(direction)`. */
    direction?: "outgoing" | "incoming";
    /** Display name — what the formula editor shows in completions and
     *  what the serialized formula renders inside `-[:name]->`. When
     *  unset, `fieldId` doubles as the display name (the common case
     *  for adapter references). KG bidirectional edges set this to
     *  `outbound_name` or `inbound_name` per direction. */
    name?: string;
    /** Property descriptors for the edge itself — KG edges can carry
     *  attributes (e.g. `since: date`). The editor's `edge.X`
     *  autocomplete inside `-[:Edge WHERE …]->` clauses reads from
     *  here, and the engine's `edge_property` expression evaluator
     *  uses it during traversal. */
    edgeFields?: SchemaTypeDescriptor["fields"];
  }[];
};

export type PartialDescriptor = {
  adapterType: string;
  types: SchemaTypeDescriptor[];
};

// Mirrors packages/movement-engine/services/translation_graph/adapter.ts —
// `RuntimeCapabilities`. The honest whole-adapter facts the editor can
// still gate on: inverse-edge traversal, edge-property reads, and
// resource support. (`outgoing` traversal is universal, hence implicit.)
// Per-edge filter/order/limit capability now lives on `describe()`
// output, not here (capability-at-grain).
export type AdapterCapabilities = {
  traversal: { incoming: boolean; edgeProperties: boolean };
  resources: boolean;
};

/**
 * Fetch lightweight adapter info + a caller-specified set of type
 * details for the given schema ref. The lightweight call gives us
 * `entries` (typeId catalog), `capabilities` (runtime traversal /
 * resource gates) and `supportedTriggers` (the kinds the adapter can
 * fire). The
 * per-type call gives us a partial descriptor view containing only
 * the requested types.
 *
 * `typeIds` is de-duped and sorted internally so React Query's cache
 * key is stable across re-renders that produce the same set.
 */
export function useTypes(
  ref: SchemaRef | undefined,
  credentialsId: string | undefined,
  typeIds: string[],
): {
  entries: SchemaEntryPoint[] | undefined;
  capabilities: AdapterCapabilities | null | undefined;
  supportedTriggers: readonly TriggerType[] | undefined;
  descriptor: PartialDescriptor | undefined;
  isLoading: boolean;
} {
  const sortedIds = useMemo(
    () => Array.from(new Set(typeIds)).sort(),
    [typeIds],
  );

  const { data: info, isLoading: infoLoading } =
    trpc.views.credentials.listEntryPoints.useQuery(
      {
        ref: ref ?? { kind: "knowledge-graph" },
        credentialsId: credentialsId ?? undefined,
      },
      { enabled: !!ref, staleTime: 30_000 },
    );

  const { data: types, isLoading: typesLoading } =
    trpc.views.credentials.describeTypes.useQuery(
      {
        ref: ref ?? { kind: "knowledge-graph" },
        credentialsId: credentialsId ?? undefined,
        typeIds: sortedIds,
      },
      { enabled: !!ref && sortedIds.length > 0, staleTime: 30_000 },
    );

  const descriptor = useMemo<PartialDescriptor | undefined>(() => {
    if (!ref) return undefined;
    // Composition arms (generic / generic_reference) don't dispatch
    // through an adapter, so there's no concrete adapterType to label
    // the descriptor with. Use the empty string as the sentinel — the
    // descriptor's `types` array is the only field consumers read for
    // composition shapes, and they'll be supplying inline shape data
    // (not adapter `describe()` output) regardless.
    const adapterType = refToAdapterType(ref) ?? "";
    return {
      adapterType,
      types: Object.values(types ?? {}) as SchemaTypeDescriptor[],
    };
  }, [ref, types]);

  return {
    entries: info?.entries,
    capabilities: info?.runtimeCapabilities,
    supportedTriggers: info?.supportedTriggers,
    descriptor,
    isLoading: infoLoading || (sortedIds.length > 0 && typesLoading),
  };
}

/**
 * Self-stabilising source-side schema view.
 *
 * Many editor surfaces walk a source-side traversal from a seed type
 * (e.g. the trigger / invoker) through references to a resolved
 * position. They need every type touched along the walk fully
 * described (fields + references). This hook:
 *
 *   1. Composes a `SchemaDescriptor`-shaped view from `useTypes` —
 *      described types contribute fields + references; entry-only
 *      shells contribute displayName so labels work even before a
 *      type is fully loaded.
 *   2. Walks the supplied `walks` (each = a starting type + a
 *      sequence of `TraversalStep`s) using the composed descriptor
 *      and the KG ontology, collecting every type ID encountered —
 *      including one hop ahead from the resolved end (so completion
 *      pickers have references ready).
 *   3. Feeds the discovered set back into `useTypes`. The walk
 *      converges in O(depth) renders as types load in.
 *
 * Returns the composed descriptor plus the adapter's capabilities and
 * the entries catalog (consumers often want both).
 */
export function useSourceSchema(input: {
  ref: SchemaRef | undefined;
  credentialsId: string | undefined;
  /** Always-fetched seed types — typically the invoker / root context. */
  seedTypeIds: (string | null | undefined)[];
  /** Walks to expand discovery along. */
  walks: { from: string | null; steps: ReadonlyArray<TraversalStep> }[];
  /**
   * KG ontology summary — when `ref.kind === 'knowledge-graph'`, this is
   * folded into the composed descriptor so KG types/fields/edges are
   * available eagerly (no per-type `describe` round-trip on first
   * render). The KG is treated as just another adapter from the
   * consumer's perspective; this hook is the seam that converts
   * ontology data into the unified descriptor shape.
   */
  ontology?: OntologySummary;
}): {
  descriptor: PartialDescriptor;
  capabilities: AdapterCapabilities | null | undefined;
  entries: SchemaEntryPoint[] | undefined;
  isLoading: boolean;
} {
  const { ref, credentialsId, seedTypeIds, walks, ontology } = input;
  const [discovered, setDiscovered] = useState<string[]>([]);
  const { entries, capabilities, descriptor: rawDescriptor, isLoading } =
    useTypes(ref, credentialsId, discovered);

  // Pre-built KG descriptor from the eager ontology fetch. Built once
  // per ontology load; merged into the composed descriptor below.
  const kgDescriptor = useMemo(
    () =>
      ref?.kind === "knowledge-graph" && ontology
        ? ontologyToDescriptor(ontology)
        : undefined,
    [ref, ontology],
  );

  // Compose: described types take precedence; KG ontology fills in
  // fields/references for types the adapter hasn't been asked to
  // describe yet; entry shells fill in displayName for types we
  // haven't fully fetched yet.
  const descriptor = useMemo<PartialDescriptor>(() => {
    // Composition arms (generic / generic_reference) leave adapterType
    // as the empty-string sentinel; the composed descriptor's `types`
    // array remains the only field consumers look at for those refs.
    const adapterType = ref ? refToAdapterType(ref) ?? "" : "";
    const types: SchemaTypeDescriptor[] = [];
    const seen = new Set<string>();
    for (const t of rawDescriptor?.types ?? []) {
      types.push(t);
      seen.add(t.typeId);
    }
    for (const t of kgDescriptor?.types ?? []) {
      if (seen.has(t.typeId)) continue;
      types.push(t);
      seen.add(t.typeId);
    }
    for (const e of entries ?? []) {
      if (seen.has(e.typeId)) continue;
      types.push({
        typeId: e.typeId,
        displayName: e.displayName,
        externalId: e.externalId,
        labelTemplate: e.labelTemplate,
        scope: e.scope,
        fields: [],
        references: [],
      });
    }
    return { adapterType, types };
  }, [ref, rawDescriptor, kgDescriptor, entries]);

  // Walk to expand the discovered set. Each walk advances through
  // references on the composed descriptor; what we land on (and one
  // hop ahead from there) gets added. Walks chain: a walk with
  // `from: null` continues from where the previous walk ended,
  // which lets callers express ancestor → child traversal sequences
  // without having to resolve intermediate types themselves.
  useEffect(() => {
    const expanded = expandDiscoveredTypes({
      seedTypeIds,
      walks,
      ontology,
      descriptor,
      previouslyDiscovered: discovered,
    });
    if (expanded.length !== discovered.length) {
      setDiscovered(expanded);
    }
  }, [discovered, seedTypeIds, walks, ontology, descriptor]);

  return { descriptor, capabilities, entries, isLoading };
}

/**
 * Pure walk-discovery used by `useSourceSchema`. Returns the sorted set
 * of type IDs that should be fetched so the supplied walks resolve
 * end-to-end (plus one hop ahead from each resolved end, so completion
 * pickers have ref targets ready). Walks chain: a walk with
 * `from: null` continues from the previous walk's resolved end —
 * required for child actions whose own traversal sits on top of any
 * number of ancestor traversals.
 *
 * Exported for unit testing — the hook's useEffect wraps this so React
 * state-update batching stays where it belongs.
 */
export function expandDiscoveredTypes(input: {
  seedTypeIds: (string | null | undefined)[];
  walks: { from: string | null; steps: ReadonlyArray<TraversalStep> }[];
  ontology:
    | {
        edgeTypes: ReadonlyArray<{
          id: string;
          source_node_type_id: string;
          target_node_type_id: string;
        }>;
      }
    | undefined;
  descriptor: { types: SchemaTypeDescriptor[] };
  /**
   * Already-discovered types from a prior render. Optional. When
   * provided, discovery is monotone: types never disappear from the
   * set, even if the current walks no longer justify them. Without
   * this guarantee a partially-loaded descriptor could oscillate as
   * intermediate types come and go between renders.
   */
  previouslyDiscovered?: ReadonlyArray<string>;
}): string[] {
  const { seedTypeIds, walks, ontology, descriptor, previouslyDiscovered } = input;
  const next = new Set<string>(previouslyDiscovered ?? []);
  for (const id of seedTypeIds) {
    if (id) next.add(id);
  }
  let prevWalkEnd: string | null = null;
  for (const walk of walks) {
    let current: string | null = walk.from ?? prevWalkEnd;
    if (current) next.add(current);
    for (const step of walk.steps) {
      if (!current) break;
      if (step.type === "linkBack") continue;
      if (step.type === "resource") {
        current = null;
        break;
      }
      if (step.type === "edge") {
        // Descriptor-first: KG-source descriptors now publish both
        // outgoing and incoming references per type. Match on
        // (fieldId, direction). Ontology fallback is kept for
        // partially-loaded edge cases.
        const t = descriptor.types.find((x) => x.typeId === current);
        const stepDirection = step.direction ?? "outgoing";
        const ref = t?.references.find(
          (r) =>
            r.fieldId === step.edgeTypeId &&
            (r.direction ?? "outgoing") === stepDirection,
        );
        if (ref) {
          current = ref.targetTypeId;
          next.add(current);
          continue;
        }
        const et = ontology?.edgeTypes.find((e) => e.id === step.edgeTypeId);
        if (et) {
          current =
            step.direction === "incoming"
              ? et.source_node_type_id
              : et.target_node_type_id;
          next.add(current);
          continue;
        }
        current = null;
        break;
      }
    }
    if (current) {
      const t = descriptor.types.find((x) => x.typeId === current);
      for (const r of t?.references ?? []) next.add(r.targetTypeId);
    }
    prevWalkEnd = current;
  }
  return Array.from(next).sort();
}
