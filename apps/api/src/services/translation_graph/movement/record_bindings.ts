// The generic, SYMMETRIC correspondence store — the Postgres `RecordBindings`
// the production host hands the engine.
//
// Correspondence — "this record IS the counterpart of that one" — is NOT a KG
// concept and NOT an adapter verb. It is a generic binding between two stable
// record POSITIONS across any pair of systems, declared in the movement
// language by `write … bind other { … }` and owned end-to-end by the engine:
// storage (this module + public.record_binding, through the host), lifecycle
// (the bind write flow in run.ts), and id-based matching (lookup here). The adapter stays
// completely correspondence-agnostic — the engine maintains bindings using
// each adapter's NORMAL read/write (createRecord / updateRecord-by-id).
//
// This SUPERSEDES the KG-specific linked_object correspondence role
// (writePriorMatch / readPriorMatch / resolveByBridge) for the live movement
// engine. The frozen TG engine keeps its own linked_object machinery (P7).
//
// ── The endpoint is a fully-qualified POSITION key ──────────────────────────
//
// An endpoint is NOT (system, recordId): the same record id in a different
// Airtable base is a different record. Each endpoint encodes the full position
// identity, with ONE consistent encoding the store indexes on:
//
//     (adapterType, instanceKey, typeId, recordId)
//
//   - adapterType — the adapter slug (normalized, e.g. `airtable`).
//   - instanceKey — a canonical, stable encoding of the INSTANCE: the
//     credential identity + the normalized construction config (the Airtable
//     base, the Slack workspace). Two references to the same instance must
//     produce the same instanceKey regardless of how the construction was
//     phrased, so we canonicalize (credential id + sorted construction args).
//     Credentials are part of the identity by default (3b open nuance): the
//     same base reached via two credentials is two instances.
//   - typeId — the adapter's STABLE INTERNAL type id, NOT the mutable display
//     name. The caller resolves natural→internal at bind time (via the adapter
//     resolver) and hands us the stable id, so a type rename never orphans a
//     binding.
//   - recordId — the stable external record id (a KG node id when the endpoint
//     is the KG).
//
// The engine holds both endpoints' instance context at bind time — the write
// target's construction and the bound record's read seam — so it builds both
// keys itself. The adapter needs NO new surface for this.
//
// ── Symmetry ────────────────────────────────────────────────────────────────
//
// A binding is matchable from EITHER endpoint. We store the two endpoints
// canonically ORDERED (the lexicographically-smaller encoded key as `a`) so a
// binding is one row regardless of which side asked; the unique pair index
// dedupes it. Lookups query both the `a` and `b` columns.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { BindingEndpoint, EncodedEndpoint } from 'movement-engine/public/host';
import {
  asEncoded,
  encodeEndpoint,
  orderEndpoints,
} from 'movement-engine/public/catalog';

import { getAutomationsQb } from '../../../lib/kysely';

export { encodeEndpoint, encodeInstanceKey } from 'movement-engine/public/catalog';

/**
 * Record a symmetric binding between two endpoints (idempotent upsert on the
 * canonical pair). Called by the engine after a bind write creates a fresh
 * target record. Re-asserting an existing binding just refreshes `updated_at`.
 */
export async function recordBinding(input: {
  teamId: TeamId;
  from: BindingEndpoint;
  to: BindingEndpoint;
}): Promise<void> {
  const { a, b } = orderEndpoints(encodeEndpoint(input.from), encodeEndpoint(input.to));
  await getAutomationsQb(['record_binding'])
    .insertInto('record_binding')
    .values({
      team_id: input.teamId,
      a_adapter_type: a.adapterType,
      a_instance_key: a.instanceKey,
      a_type_id: a.typeId,
      a_record_id: a.recordId,
      b_adapter_type: b.adapterType,
      b_instance_key: b.instanceKey,
      b_type_id: b.typeId,
      b_record_id: b.recordId,
    })
    .onConflict((oc) =>
      oc
        .columns([
          'team_id',
          'a_adapter_type',
          'a_instance_key',
          'a_type_id',
          'a_record_id',
          'b_adapter_type',
          'b_instance_key',
          'b_type_id',
          'b_record_id',
        ])
        .doUpdateSet({ updated_at: new Date() }),
    )
    .execute();
}

/**
 * Find the record bound to `endpoint`, optionally constrained to a particular
 * counterpart adapter (the bind write resolves "what does `other` correspond to
 * in the target system?"). Symmetric: matches the endpoint on EITHER side and
 * returns the OTHER side. Returns null when there is no binding. Ambiguity (the
 * same endpoint bound to >1 counterpart in the same target adapter) is not
 * expected — one bind per write, and a live binding is updated, never
 * re-minted — but if it arises we return the most recently-bound counterpart.
 */
export async function findBoundCounterpart(input: {
  teamId: TeamId;
  endpoint: BindingEndpoint;
  /**
   * When set, only return a counterpart in this exact instance + type (the
   * binding write resolves "what record in MY target instance does `other`
   * correspond to?"). The recordId is the unknown being looked up, so only
   * the position's adapter / instance / type are constrained. Omit the
   * construction config / credential the same way an endpoint does — they
   * canonicalize into the instance key.
   */
  counterpart?: Omit<BindingEndpoint, 'recordId'>;
}): Promise<EncodedEndpoint | null> {
  const e = encodeEndpoint(input.endpoint);
  // Encode the counterpart's instance identity (recordId is the unknown).
  const cp =
    input.counterpart !== undefined
      ? encodeEndpoint({ ...input.counterpart, recordId: '' })
      : undefined;

  // The endpoint may be stored as either `a` or `b`. Query both directions and
  // project the OPPOSITE columns as the counterpart.
  const rows = await getAutomationsQb(['record_binding'])
    .selectFrom('record_binding')
    .where('team_id', '=', input.teamId)
    .where((eb) =>
      eb.or([
        eb.and([
          eb('a_adapter_type', '=', e.adapterType),
          eb('a_instance_key', '=', e.instanceKey),
          eb('a_type_id', '=', e.typeId),
          eb('a_record_id', '=', e.recordId),
          ...(cp !== undefined
            ? [
                eb('b_adapter_type', '=', cp.adapterType),
                eb('b_instance_key', '=', cp.instanceKey),
                eb('b_type_id', '=', cp.typeId),
              ]
            : []),
        ]),
        eb.and([
          eb('b_adapter_type', '=', e.adapterType),
          eb('b_instance_key', '=', e.instanceKey),
          eb('b_type_id', '=', e.typeId),
          eb('b_record_id', '=', e.recordId),
          ...(cp !== undefined
            ? [
                eb('a_adapter_type', '=', cp.adapterType),
                eb('a_instance_key', '=', cp.instanceKey),
                eb('a_type_id', '=', cp.typeId),
              ]
            : []),
        ]),
      ]),
    )
    .selectAll()
    .orderBy('updated_at', 'desc')
    .execute();

  const row = rows[0];
  if (row === undefined) return null;

  // The counterpart is the side that is NOT the queried endpoint. Determine
  // which side matched (the `a` side matches when its components equal `e`).
  const aMatches =
    row.a_adapter_type === e.adapterType &&
    row.a_instance_key === e.instanceKey &&
    row.a_type_id === e.typeId &&
    row.a_record_id === e.recordId;
  return aMatches
    ? {
        adapterType: row.b_adapter_type,
        instanceKey: row.b_instance_key,
        typeId: row.b_type_id,
        recordId: row.b_record_id,
      }
    : {
        adapterType: row.a_adapter_type,
        instanceKey: row.a_instance_key,
        typeId: row.a_type_id,
        recordId: row.a_record_id,
      };
}

/**
 * Delete the binding between two endpoints — the SELF-HEAL path: when the bind
 * write's `updateRecord` reports the target is gone, the engine drops the stale
 * binding before re-minting. Idempotent (no row → no-op). Symmetric: removes
 * the canonical pair regardless of which side each endpoint was stored as.
 *
 * Each side may be a raw `BindingEndpoint` (encoded here) OR an
 * already-`EncodedEndpoint` (the counterpart a `findBoundCounterpart` returned,
 * whose instance key the engine can't reverse into raw cred/config). Both
 * encode to the same stored components.
 */
export async function deleteBinding(input: {
  teamId: TeamId;
  from: BindingEndpoint | EncodedEndpoint;
  to: BindingEndpoint | EncodedEndpoint;
}): Promise<void> {
  const { a, b } = orderEndpoints(asEncoded(input.from), asEncoded(input.to));
  await getAutomationsQb(['record_binding'])
    .deleteFrom('record_binding')
    .where('team_id', '=', input.teamId)
    .where('a_adapter_type', '=', a.adapterType)
    .where('a_instance_key', '=', a.instanceKey)
    .where('a_type_id', '=', a.typeId)
    .where('a_record_id', '=', a.recordId)
    .where('b_adapter_type', '=', b.adapterType)
    .where('b_instance_key', '=', b.instanceKey)
    .where('b_type_id', '=', b.typeId)
    .where('b_record_id', '=', b.recordId)
    .execute();
}
