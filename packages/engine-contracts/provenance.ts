// Provenance: where a value came from. Every value a run produces carries a
// trail of origins next to it; a written record carries the summarised form,
// whose extraction sites are interned once per run.

import type { Span } from 'movement-lang';

// ── Origins ─────────────────────────────────────────────────────────────────

/**
 * One planned extraction LLM call site — interned: created once per
 * (node, stage) call by the materialiser and shared by reference across
 * every origin it produces. `dataSources` is the data context the call
 * saw: the `from` slots' own origins plus one `enrichment` entry per
 * `through` plugin whose output was in context at this stage.
 */
export interface ExtractSiteRef {
  /** The call's response key (`x:<node>#<n>`) — unique within a run. */
  siteId: string;
  /** The extract tree node's name. */
  node: string;
  /** The node's authored description. */
  description: string;
  /** Which stage of the node this call extracted. */
  stage: number;
  /** Assigned by the materialiser when the call is issued (the region
   *  is built immediately before its call, so this is never observed
   *  unset by origin consumers). */
  dataSources: ProvenanceOrigin[];
}

export type ProvenanceOrigin =
  /** A property read off a source position (the event, a resource-free
   *  adapter read). `instance` is the constructed instance's name in the
   *  movement file — the program-level identity of the system read. */
  | {
      kind: 'source_field';
      instance: string;
      adapterType: string;
      recordType?: string;
      externalId?: string;
      field: string;
    }
  /** An extracted field (or, with `field` absent, an extracted entity
   *  itself). `quote` is the LLM's verbatim supporting quote. */
  | {
      kind: 'extraction';
      site: ExtractSiteRef;
      field?: string;
      description?: string;
      quote?: string;
      /** The extraction CALL's content item the value came from — its
       *  position in the content list. Absent under the keyword, whose
       *  content is one undivided message. */
      item?: number;
    }
  /** A read off an earlier write's handle — `writeIndex` indexes the
   *  run's `MovementRunResult.writes`, whose own per-field provenance
   *  continues the chain across systems. */
  | { kind: 'write'; writeIndex: number; externalId?: string; field?: string }
  /** A field read off one of the event's resources. */
  | { kind: 'resource'; externalId?: string; name?: string; field?: string }
  /** A `through` plugin whose output was in extraction context. */
  | { kind: 'enrichment'; plugin: string }
  /** The extracted TEXT of a source file (an attachment `FileRef`) that
   *  fed an extraction. `rawTextId` links to the stored, deduped text;
   *  `handle`/`name`/`contentType` identify the file the text came from,
   *  so extracted-field evidence traces back to the attachment. */
  | {
      kind: 'file';
      rawTextId?: string;
      handle?: string;
      name?: string;
      contentType?: string;
    }
  /** An `AI()` evaluation — prompt plus the origins of its inputs.
   *  Modelled for the value union; produced once the engine runs AI(). */
  | { kind: 'ai'; prompt: string; inputs: ProvenanceOrigin[] }
  /** A literal in the movement text — the span locates it in the file. */
  | { kind: 'literal'; span?: Span }
  /** An ambient meta value (`@user_email`, `@current_date`, …) —
   *  literal-ish: the value comes from the dispatch context, not from
   *  any record, so the key is the whole story. */
  | { kind: 'meta'; key: string };

// ── The trail ───────────────────────────────────────────────────────────────

export interface Provenance {
  /** Every origin that influenced the value (taint-style union). */
  origins: ProvenanceOrigin[];
  /**
   * The single origin the value arrived from UN-transformed, when it
   * did (provenance-faithfulness, TG 3b §3.4). Drives evidence
   * translation; transforms drop it while keeping `origins`.
   */
  direct?: ProvenanceOrigin;
}

/**
 * A JSON-able, ref-not-blob projection of an origin for
 * `MovementRunResult.writes[*].provenance` (trigger_run recording):
 * extraction sites collapse to their id (detail interned once in the
 * run's `extractionSites`), earlier writes stay an index into the same
 * result's `writes`.
 */
export type SummarisedOrigin =
  | {
      kind: 'source_field';
      instance: string;
      adapterType: string;
      recordType?: string;
      externalId?: string;
      field: string;
    }
  | {
      kind: 'extraction';
      site: string;
      field?: string;
      description?: string;
      quote?: string;
      item?: number;
    }
  | { kind: 'write'; write: number; externalId?: string; field?: string }
  | { kind: 'resource'; externalId?: string; name?: string; field?: string }
  | { kind: 'enrichment'; plugin: string }
  | {
      kind: 'file';
      rawTextId?: string;
      handle?: string;
      name?: string;
      contentType?: string;
    }
  | { kind: 'ai'; prompt: string }
  | { kind: 'literal'; span?: Span }
  | { kind: 'meta'; key: string };

/** One extraction call site, summarised once per run. */
export interface ExtractSiteSummary {
  node: string;
  description: string;
  stage: number;
  dataSources: SummarisedOrigin[];
}
