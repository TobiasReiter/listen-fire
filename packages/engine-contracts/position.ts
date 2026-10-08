// A position: a typed node in a source graph, carrying either a stable
// external identity or its data inline.

/**
 * A position's identity/content:
 *   • stable   — a durable external record, the refetch + bridge key. The
 *     adapter materialises from `recordId`. `data` is a transitional
 *     materialised cache (today every `external-record` carries it inline;
 *     dropped in landing C once adapters re-fetch on demand).
 *   • unstable — content the adapter cannot otherwise retrieve, carried
 *     inline: inbound payloads, transformed/ephemeral nodes. Empty
 *     (`undefined`) for the `meta` root, which has no data.
 */
export type PositionIdentity =
  | { kind: 'stable'; recordId: string; data?: unknown }
  | { kind: 'unstable'; data: unknown };

export interface Position {
  /** Which adapter owns this position's type-driven behaviour. */
  adapterType: string;
  /**
   * The node's type. Concrete after narrowing. May be `null` (fully
   * unknown) or an abstract/union type the adapter narrows further;
   * "needs narrowing" is the adapter's call given this value, not a bare
   * null check. A non-concrete type implies an unstable inbound node (P4).
   * The schema root carries the reserved type `'meta'`.
   */
  recordType: string | null;
  /** Stable external identity, or unstable inline data. */
  identity: PositionIdentity;
  /**
   * Provenance for synthetic nodes — which `#extract` / `#transform` step
   * produced this node. Read by evidence + batching, ignored by the
   * evaluator. Absent for nodes reached as real records. A position is
   * "ephemeral" iff this is set (see `isEphemeralPosition`).
   *
   * ephemeral vs persistent
   */
  originRef?: EphemeralOriginRef;
}

/**
 * Transitional alias so the union→struct collapse touches only construction
 * and branch sites, not the hundreds of `SourcePosition` type references.
 * Remove once references are renamed to `Position`.
 */
export type SourcePosition = Position;

/**
 * Provenance for an ephemeral node — what TG step produced it, plus the
 * node's in-run synthetic id. Used for batching (collecting EXTRACT_VALUE
 * invocations sharing an `#extract` context), dedup, evidence wiring, and
 * debugging.
 *
 * `nodeId` is the ephemeral's *internal correlation* id — distinct from a
 * stable external `recordId` (an ephemeral has none; it's unstable). It
 * lives here, with provenance, rather than overloading `recordId`, so that
 * `recordId` stays external-only (P3/P5). Was `EphemeralNode.nodeId` on
 * the old union.
 */
export type EphemeralOriginRef =
  | { kind: 'extract'; extractStepId: string; nodeId: string }
  | { kind: 'transform'; transformName: string; emissionIndex: number; nodeId: string }
  // A `#resources` traversal off an extract node yields one ephemeral node per
  // carried resource — a plain source node whose readable fields are the
  // `Resource`'s own (`contentType`, `name`, `data`, …). `nodeId` derives from
  // the parent extract node so provenance keys stay stable.
  | { kind: 'resource'; resourceId?: string; nodeId: string };
