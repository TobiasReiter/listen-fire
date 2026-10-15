// Movement engine — provenance as the value model (E4).
//
// Every runtime value the interpreter produces is a (value, provenance)
// pair, propagated automatically — zero language surface. The pair rides
// NEXT TO the value (`MovementEvalResult` in ./expression.ts), never
// inside it: values stay plain JS data, so adapters receive exactly what
// they always received, and equality/comparison ignore provenance by
// construction rather than by unwrapping discipline.
//
// Origins (6_engine.md §"Provenance is the value model"):
//   - extract field reads carry { extraction site, field description,
//     data sources in context at that stage } — `through` fences make
//     stage context precise, so evidence precision falls out of the
//     staging semantics; the LLM's verbatim quote rides along;
//   - source property reads carry { instance, record, field };
//   - handle reads carry the earlier write (provenance chains across
//     systems — the referenced write's own per-field trails continue
//     the chain);
//   - `AI()` carries prompt + inputs (the origin kind is modelled here;
//     its production site lands when the engine evaluates `AI()`);
//   - literals carry their source span (the program is part of the
//     trail).
//
// Expressions union operand trails taint-style. A value additionally
// keeps a `direct` origin while it flows UN-transformed from its source
// (extract / property read, branch selection, single-position collapse)
// — the TG engine's provenance-faithfulness rule (3b §3.4). `direct`
// is what translates to `WriteInput.evidence`: a transformed value's
// quote would be a misleading citation, so transforms keep the taint
// union but drop `direct`.
//
// Trail size discipline: shared refs are interned, not copied — one
// `ExtractSiteRef` per planned LLM call site (every field origin of
// every emission points at the same object), write origins reference
// the run's write by INDEX into `MovementRunResult.writes`, and the
// summarised form (`SummarisedOrigin`) stores refs, not blobs: site
// detail lives once in the run's `extractionSites` catalog; per-field
// entries carry only the field name, its description, and the verbatim
// quote. Unions dedupe by object identity, which interning makes
// meaningful.

import type {
  ExtractSiteRef,
  ExtractSiteSummary,
  FieldEvidence,
  Provenance,
  ProvenanceOrigin,
  SummarisedOrigin,
} from 'engine-contracts';

export type { ExtractSiteRef, ExtractSiteSummary, Provenance, ProvenanceOrigin, SummarisedOrigin };

// The origins, the trail and their summarised form are the contract's
// (`engine-contracts`): they ride a parked run's state and a run's result.

export const NO_PROVENANCE: Provenance = Object.freeze({ origins: [] });

/** A value read straight off one origin — faithful by definition. */
export function fromOrigin(origin: ProvenanceOrigin): Provenance {
  return { origins: [origin], direct: origin };
}

/** Taint union: every operand's origins, deduped by object identity
 *  (interned refs make identity dedupe meaningful), no `direct` — a
 *  combined value is justified by no single origin. */
export function unionProvenance(
  parts: ReadonlyArray<Provenance | undefined>,
): Provenance {
  const seen = new Set<ProvenanceOrigin>();
  const origins: ProvenanceOrigin[] = [];
  for (const part of parts) {
    for (const origin of part?.origins ?? []) {
      if (seen.has(origin)) continue;
      seen.add(origin);
      origins.push(origin);
    }
  }
  return { origins };
}

/** The trail through a transformation: origins survive, `direct` does
 *  not (the transformed value is no longer justified by the quote). */
export function transformed(provenance: Provenance): Provenance {
  return provenance.direct === undefined
    ? provenance
    : { origins: provenance.origins };
}

/**
 * Translate a field's trail into the adapter contract's per-field
 * evidence — exactly the TG engine's rule (today's model is the special
 * case): only a value that arrived UN-transformed from an extraction,
 * with a verbatim quote, earns a citation. The KG adapter persists it
 * as its native evidence rows; adapters without an evidence sink
 * ignore it.
 */
export function fieldEvidenceFromProvenance(
  provenance: Provenance,
): FieldEvidence | undefined {
  const direct = provenance.direct;
  if (direct?.kind !== 'extraction' || !direct.quote) return undefined;
  return { quote: direct.quote, type: 'extraction' };
}

// ── Summarisation (the firing record's currency) ────────────────────────────



/**
 * Summarises trails for the run result, interning each referenced
 * extraction site exactly once into `sites`.
 */
export class ProvenanceSummariser {
  readonly sites: Record<string, ExtractSiteSummary> = {};

  /** `writes`, when given, is told of every summarised origin that cites a
   *  write by number, so the run's final numbering reaches it. */
  constructor(private readonly writes?: { cite(citation: Extract<SummarisedOrigin, { kind: 'write' }>): void }) {}

  summariseTrail(provenance: Provenance | undefined): SummarisedOrigin[] {
    return (provenance?.origins ?? []).map((origin) => this.summariseOrigin(origin));
  }

  private summariseOrigin(origin: ProvenanceOrigin): SummarisedOrigin {
    switch (origin.kind) {
      case 'extraction': {
        return {
          kind: 'extraction',
          site: this.internSite(origin.site),
          ...(origin.field !== undefined ? { field: origin.field } : {}),
          ...(origin.description !== undefined ? { description: origin.description } : {}),
          ...(origin.quote !== undefined ? { quote: origin.quote } : {}),
          ...(origin.item !== undefined ? { item: origin.item } : {}),
        };
      }
      case 'write': {
        const cited: Extract<SummarisedOrigin, { kind: 'write' }> = {
          kind: 'write',
          write: origin.writeIndex,
          ...(origin.externalId !== undefined ? { externalId: origin.externalId } : {}),
          ...(origin.field !== undefined ? { field: origin.field } : {}),
        };
        this.writes?.cite(cited);
        return cited;
      }
      case 'ai':
        return { kind: 'ai', prompt: origin.prompt };
      case 'source_field':
      case 'resource':
      case 'enrichment':
      case 'file':
      case 'literal':
      case 'meta':
        return { ...origin };
    }
  }

  private internSite(site: ExtractSiteRef): string {
    if (!(site.siteId in this.sites)) {
      // Reserve the slot before summarising data sources — a site whose
      // data sources somehow referenced itself would terminate.
      this.sites[site.siteId] = {
        node: site.node,
        description: site.description,
        stage: site.stage,
        dataSources: [],
      };
      this.sites[site.siteId].dataSources = site.dataSources.map((origin) =>
        this.summariseOrigin(origin),
      );
    }
    return site.siteId;
  }
}
