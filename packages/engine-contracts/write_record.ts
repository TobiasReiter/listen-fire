// A write as a run records it: which record in which system, what the write
// did, and where each written value came from.

import type { ProvenanceOrigin, SummarisedOrigin } from './provenance';

/**
 * A recorded adapter write — the single shape that is BOTH the firing-log
 * entry (`MovementRunResult.writes`, in program order) AND the binding
 * value a write handle reads (`co = write crm-[:company]-> { … }` then
 * `co.externalId`, `co.`url``). Producing the write and recording it are
 * one act: every adapter create/update/link/unlink/delete yields ONE
 * `WriteRecord`, pushed onto the run's firing log as it is produced, and
 * the `handle` binding wraps that same object. (Shape writes —
 * in-memory `shapePosition`s — are NOT writes: no adapter, no external
 * record, so they keep their own path and never reach the firing log.)
 *
 * The fields fall in three groups:
 *   • record identity — which record in which system this write touched;
 *   • write-event facts — what the write did and what it sent / got back;
 *   • firing-log provenance — the summarised per-slot trails the run
 *     history consumes, plus the interned write origin later reads chain
 *     to by index.
 *
 * `resultData` and `origin` are the in-memory handle-read surface; they
 * are NOT part of the firing record's serialized output — `trigger_run`'s
 * `recordMovementStep` projects the persisted shape explicitly from the
 * other fields.
 */
export interface WriteRecord {
  // ── Record identity ──────────────────────────────────────────────────────
  /** The receiving adapter's type. */
  adapterType: string;
  /** The written record's type, in the program's NATURAL name. For a
   *  standalone link / unlink this is the FROM side's type; the TO side
   *  rides in `link`. */
  recordType: string;
  externalId?: string;

  // ── Write-event facts ────────────────────────────────────────────────────
  /** True for a create; for a link / unlink, whether the statement
   *  actually changed the target (asserted a new edge / severed one). */
  created: boolean;
  /** Whether this write actually landed in the target system. False when
   *  the write was REHEARSED — the target instance was constructed
   *  `dry_run: true`, or the whole run is a rehearsal — so the effect was
   *  captured, not committed. The per-write truth the run-inspection surface
   *  reports (a live run can still capture a `dry_run` instance's write). */
  committed: boolean;
  /**
   * The parent record(s) this write hangs off, with the connecting edge —
   * 1 for a linked write (`write s-[:edge]-> { … }`), N for a tuple path,
   * absent for a root write. The cardinal rule is that records connect
   * through edges; the firing log must SHOW that linkage, not just the
   * written fields (prod inspection report, 2026-07-05).
   */
  parents?: Array<{ recordType: string; externalId: string; edgeName: string }>;
  /**
   * What kind of entry this is. Absent = a record write (create/update —
   * `created` discriminates). 'link' / 'unlink' are the standalone link
   * statements (`link a -[:e]-> b` and its inverse `unlink`), both carrying
   * the edge in `link`; 'delete' is a record removal (`delete <handle>`).
   *
   * 'match' is the one entry that is NOT an effect: a `match` FOUND this
   * record by identity and wrote nothing (`created` and `committed` are
   * false, `writtenValues` empty). It is on the log so an inspector sees what
   * the run resolved to; every count of what a run wrote goes through
   * `isWriteEffect`, which leaves it out.
   */
  kind?: 'link' | 'unlink' | 'delete' | 'match';
  /**
   * What a record write ACTUALLY did, which `created` alone cannot say:
   * 'create' (the record was minted), 'update' (at least one field — or
   * resource provenance — was sent), 'attach' (nothing but the parent
   * association was sent: a matched record whose own fields were all
   * unchanged, hung off its parent) or 'noop' (nothing was sent at all —
   * the engine's own no-change suppression). Absent on links / unlinks /
   * deletes, whose `kind` already names the effect, and on runs recorded
   * before the field existed.
   */
  outcome?: 'create' | 'update' | 'attach' | 'noop';
  /**
   * This write landed on an edge of a node THIS RUN BUILT (`write
   * deduped-[:companies]-> { … }`) — the run's own graph rather than a system.
   * `edge` names the edge it landed on, which is the only name the run has for
   * what it wrote. There is no `externalId` (no system holds one) and
   * `committed` is false, because nothing was committed anywhere.
   *
   * `candidatesCapped` marks a write whose identity search stopped at the
   * engine's candidate ceiling with landings still unexamined — a merge it
   * could have made and did not consider. Absent means the search saw
   * everything.
   */
  local?: { edge: string; candidatesCapped?: true };
  /**
   * What became of the parent association this write named, as the TARGET
   * SYSTEM reported it: 'made' (it did not exist and now does) or 'already'
   * (it was there). Absent when the write named no parent — and never
   * 'unsupported', which fails the write instead of being recorded. It rides
   * alongside `parents` rather than inside it because the parents are what the
   * author wrote and this is what the system did about them.
   */
  association?: 'made' | 'already';
  /** What the engine actually sent to the adapter (after no-op
   *  suppression). Empty for links / unlinks / deletes (the edge or the
   *  removal IS the write). */
  writtenValues: Record<string, unknown>;
  /** The adapter's `WriteResult.data` bag + top-level `url` — fields the
   *  target system computed that the author never wrote. In-memory
   *  handle-read surface only. */
  resultData?: Record<string, unknown>;
  /**
   * Present for a standalone link assert (`link a -[:e]-> b`, kind
   * 'link') or sever (`unlink a -[:e]-> b`, kind 'unlink'): the edge in
   * engine currency. `recordType` / `externalId` are the from side; the
   * to side rides here.
   */
  link?: {
    edgeName: string;
    toRecordType: string;
    toExternalId: string;
    /** Version 1's link body: the to side was FOUND by the body's criteria
     *  in the same statement — never created, never written — rather than a
     *  bound handle. */
    foundTarget?: boolean;
  };

  // ── Firing-log provenance ────────────────────────────────────────────────
  /**
   * Per-slot provenance, summarised as refs (E4): extraction sites by id
   * (detail interned once in the run's `extractionSites`), earlier writes
   * by index into the run's `writes` — the firing record IS the
   * write-provenance graph, field-resolved. Keyed by the written field
   * for a record write; by `from` / `to` for a link / unlink; by `record`
   * for a delete. Assigned at record time. Carried on dry runs too.
   */
  provenance: Record<string, SummarisedOrigin[]>;
  /** The write's interned provenance origin, assigned when the write is
   *  recorded — handle reads derive their per-field origins from it
   *  (`writeIndex` chains into `MovementRunResult.writes`). */
  origin?: Extract<ProvenanceOrigin, { kind: 'write' }>;
  /** The handle name when the statement was bound (`co = write …`,
   *  `p = match …`). */
  bindingName?: string;
  /**
   * An honest caveat about how this write's own decision was made, for a
   * run inspector to surface directly — never something a reader has to
   * infer from `outcome` alone. Set today when the entity-match judge threw
   * rather than deciding: the write still lands (declining would create on
   * top of an already-violated constraint too), but a CREATE here may be
   * standing in for a merge the judge never got to attempt.
   */
  note?: string;
}

/**
 * What a declared landing carries, as a tree — its own field names and the
 * nested nodes under it, each with its own.
 *
 * A node declaration IS a tree, so a landing written into one of its edges is a
 * whole node of that shape: it carries the declaration's nested nodes as empty
 * appendable edges, and each of those carries its own. Nothing here is a type —
 * the landing type is a checker-side fact — only the NAMES the run needs: the
 * edges to mint, so a `link` has somewhere to append, and the fields in
 * declaration order, which is the order the landing's dot plane reads in
 * whichever order writes happened to fill it.
 */
export interface LocalLandingShape {
  fields: string[];
  edges: { [edge: string]: LocalLandingShape };
}
