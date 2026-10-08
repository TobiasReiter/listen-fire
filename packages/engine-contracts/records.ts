// The records a run carries between systems: a resource (a file, a text, a
// link, with what was extracted from it), where it came from, and the
// evidence behind a written value.

import type { FileRef } from './file_ref';

/**
 * The single external-record currency. One flat shape returned by
 * `resolveEntity` candidates and `createRecord`/`updateRecord`.
 *
 * `adapterType` names the system the `externalId` lives in — so a link
 * store knows whose id it's recording, and a candidate/write result
 * carries its own provenance. `data` is the record's flat field bag: the
 * identity judge compares candidates over it, a host may snapshot it for
 * display, and any relationship disambiguation context folds into it as
 * ordinary entries (e.g. `data['participates in'] = 'Series A'`). A display
 * name is *derived* from `data` via the type's `labelTemplate` — never a
 * separate field.
 */
export interface ExternalRecordRef {
  /** The system this `externalId` lives in (e.g. `attio`, the KG). */
  adapterType: string;
  /** Target-system id — the value the engine passes to `updateRecord`. */
  externalId: string;
  /** The record's type in its own system (e.g. `attio:companies`).
   *  Optional; omitted when unknown. */
  recordType?: string;
  /** Canonical link to the record in its own system, when one exists. */
  url?: string;
  /** Flat field bag — judge comparison, UI snapshot, folded-in
   *  relationship context. `{}` when the adapter has nothing to surface. */
  data: Record<string, unknown>;
}

/**
 * Unified resource shape carried on a resource position's `data` (resolved via
 * the `RESOURCES_REFERENCE_FIELD_ID` reference through `getRelated`) and
 * consumed by `Adapter.writeResource`. Persisted superset of the older
 * `ResourcePosition`
 * — carries the same opaque handle plus the fields the engine and downstream
 * adapters need to round-trip a resource without re-fetch.
 *
 * Per the 2026-05-21 R3 ruling, this is the single resource currency across
 * KG / Slack / email / Attio adapters. Adapters materialise the fields a
 * `resource` expression can read into `data`; the engine reads them there
 * directly (a local lookup — no bespoke resource-field method).
 */
export interface Resource {
  /** The host's own id for a stored resource (a UUID); absent for one not
   *  yet stored (fresh adapter `#resources` output), which the store mints
   *  an id for.
   *
   *  Never an external identifier (a Slack `ts`, a file id, an attachment
   *  id): those belong in `externalId`. */
  id?: string;
  /** Original identifier from the source system (Slack `ts`, file id,
   *  email attachment key, MIME content-id, etc.). Adapters populate this on
   *  `#resources` resolution; a store keys idempotent re-delivery on
   *  `(tenant, provenance.adapterType, externalId)` — the same external
   *  handle is the same stored resource across re-fires. */
  externalId?: string;
  /** Resource kind. */
  type?: 'URL' | 'EMAIL' | 'WHATSAPP' | 'FILE' | 'TEXT';
  /** Display name. */
  name?: string;
  /** Stable URL when one exists (URL/FILE resources; null for inline text).
   *  DISPLAY-ONLY per `3_model.md` — never the byte channel. Bytes for FILE
   *  resources are named by `fileRef`; consumers that need the binary redeem
   *  it on the host (`streamFileRef`), not `url`. */
  url?: string | null;
  /** The file behind a FILE resource: a descriptor naming the instance that
   *  owns the bytes. Absent for TEXT/URL resources whose payload rides
   *  `content` / `url`. */
  fileRef?: FileRef;
  /** MIME type when known. */
  contentType?: string | null;
  /** Materialised field bag a `resource` expression reads from (a local
   *  lookup). Adapters populate the fields they expose. */
  data?: Record<string, unknown>;
  /** Inline content payload — text body for TEXT resources, the raw
   *  string for URL resources, etc. Undefined when the adapter prefers
   *  the lazy-fetch path. */
  content?: string;
  /** Free-form adapter-defined metadata. */
  metadata?: Record<string, unknown>;
  /** Facts (subject-predicate-object triples) extracted from this resource.
   *  Persisted by the target adapter in the same transaction as the resource
   *  itself. Empty / absent when the resource
   *  carries no extracted facts. */
  facts?: Fact[];
  /** Where this resource came from — the external record + the field on it.
   *  Same currency as a prior match (`ExternalRecordRef`) plus the source
   *  `field`, so "this came from the `body` of this email" /
   *  "the `description` of this CRM record" is recorded structurally.
   *  `provenance.adapterType` also namespaces the `externalId` for idempotent
   *  persistence. */
  provenance?: ResourceProvenance;
}

/**
 * Where a `Resource` originated: the external record it was read from, in the
 * same flat currency as a correspondence (`ExternalRecordRef`), plus the name
 * of the source field. Lets the persistence layer record provenance at the
 * grain of "the <field> of <record>" without a bespoke shape.
 *
 */
export interface ResourceProvenance extends ExternalRecordRef {
  /** The source field the resource's content was read from (e.g. `body`,
   *  `description`, `notes`). Absent when the resource is the whole record
   *  rather than one of its fields. */
  field?: string;
}

/**
 * A subject-predicate-object triple extracted from a resource. Carried on
 * `Resource.facts` so the adapter persists facts in the same write as the
 * resource itself.
 */
export interface Fact {
  /** Subject phrase. */
  s: string;
  /** Predicate phrase. */
  p: string;
  /** Object phrase. */
  o: string;
  /** Optional temporal modifier (e.g. "2024-05"). */
  t?: string;
}

/**
 * Per-field provenance for a written value (3b §3.3). Carried inline on
 * `WriteInput.evidence`, keyed by the adapter's target field name, so the
 * record and its provenance persist as one transactional unit — no
 * post-structural `writeEvidence` call, no ephemeral-ref → node-id dance.
 *
 * The engine attaches a `FieldEvidence` to a field only when the value is
 * *provenance-faithful* — it arrived un-transformed from an extraction /
 * property read (3b §3.4). A value dropped through `AI()` or a function is no
 * longer evidence-bearing, so no evidence is attached (a misleading citation
 * is worse than none).
 *
 */
export interface FieldEvidence {
  /** Verbatim text that justified the value. */
  quote?: string;
  /** Character offsets into the source resource content, when known. */
  startOffset?: number;
  endOffset?: number;
  /** Evidence kind — defaults to `extraction` when omitted. */
  type?: 'extraction' | 'user_edit' | 'retrieval';
  /** The resource the quote came from, when the adapter can anchor to it. */
  sourceResourceRef?: { externalId?: string; fileRef?: FileRef };
}

