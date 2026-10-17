
import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ResourceId } from '../../generated/kysely/knowledge/Resource';
import type { Resource } from 'movement-engine/public/adapter';

import { getKnowledgeQb } from '../../lib/kysely';
import { anthropicChat } from '../../lib/anthropic';
import { parseJson } from 'movement-engine/public/utils';
import { embedTexts } from '../embedding';
import { logger } from 'movement-engine/public/log';
import { resourceIdSchema } from '../../lib/resource_id';

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const BASE_FACT_PROMPT = `Extract every factual claim from the following text as (subject, predicate, object) triples.

Rules:
1. One fact per triple. Split compound claims — e.g. "CEO of Tesla" becomes two triples:
   {"s": "Elon Musk", "p": "role", "o": "CEO"} and {"s": "Elon Musk", "p": "affiliated_with", "o": "Tesla"}
2. Use canonical predicates where they fit:
   role, affiliated_with, located_in, founded, raised_amount, round_type, revenue, valuation,
   employees, investor_in, acquired_by, built, previously_at, education
   For other claims use a short, specific predicate (e.g. "NRR", "gross_margin", "deliveries").
3. Subjects and objects should be proper nouns or specific values — not generic types.
   Do NOT emit taxonomic triples like ("Tesla", "is_a", "company").
4. Be thorough — extract MORE triples rather than fewer. Always extract definitional triples
   for people and organisations when context allows.
5. Resolve ambiguous references (pronouns, "we", "our", bare first names) using any
   [Document context], [Definitions], [Previous section], or [Trailing context] provided above.
   Replace resolved references with the full entity name in your triples.`;

interface ExtractionBranch {
  edgeName: string;
  nodeTypeName: string;
  nodeTypeDescription?: string;
  instructions?: string | null;
}

function buildFactPrompt(branches?: ExtractionBranch[]): string {
  if (!branches?.length) {
    return `${BASE_FACT_PROMPT}

Example:
"Sarah Chen from Sequoia introduced Acme Corp, which is raising a $5M Series A."
→ [
  {"s": "Sarah Chen", "p": "role", "o": "Partner"},
  {"s": "Sarah Chen", "p": "affiliated_with", "o": "Sequoia"},
  {"s": "Sarah Chen", "p": "introduced", "o": "Acme Corp"},
  {"s": "Acme Corp", "p": "round_type", "o": "Series A"},
  {"s": "Acme Corp", "p": "raised_amount", "o": "$5M"}
]

Return a JSON object with two keys:
- "facts": array of {"s", "p", "o"} triples
- "summary": a one-sentence summary of what this text section covers`;
  }

  const branchDescriptions = branches.map((b) => {
    let desc = `- "${b.edgeName}" (${b.nodeTypeName})`;
    if (b.nodeTypeDescription) desc += `: ${b.nodeTypeDescription}`;
    if (b.instructions) desc += `\n  Guidance: ${b.instructions}`;
    return desc;
  }).join('\n');

  return `${BASE_FACT_PROMPT}

For each triple, classify the subject into the most fitting relationship category.
The categories are:
${branchDescriptions}

Use "t" for the category, matching the relationship name exactly.
If the subject doesn't clearly fit any category, use "t": null.

Example (with categories: "team_member" (Person), "has_company" (Organisation)):
"Sarah Chen from Sequoia introduced Acme Corp, which is raising a $5M Series A."
→ [
  {"s": "Sarah Chen", "p": "role", "o": "Partner", "t": "team_member"},
  {"s": "Sarah Chen", "p": "affiliated_with", "o": "Sequoia", "t": "team_member"},
  {"s": "Sarah Chen", "p": "introduced", "o": "Acme Corp", "t": "team_member"},
  {"s": "Acme Corp", "p": "round_type", "o": "Series A", "t": "has_company"},
  {"s": "Acme Corp", "p": "raised_amount", "o": "$5M", "t": "has_company"}
]

Return a JSON object with two keys:
- "facts": array of {"s", "p", "o", "t"} triples
- "summary": a one-sentence summary of what this text section covers`;
}

// ---------------------------------------------------------------------------
// Four-level chunk preamble
// ---------------------------------------------------------------------------

interface ChunkContext {
  documentSummary: string;
  definitions: Map<string, string[]>;
  previousChunkSummary: string;
  trailingContext: string;
}

const DEFINITIONAL_PREDICATES = [
  'role',
  'title',
  'affiliated_with',
  'works_at',
  'is_a',
  'type',
  'position',
  'company',
  'organisation',
];

// Keyed by resource_id, lives for the duration of a pipeline run
const chunkContexts = new Map<string, ChunkContext>();

function buildChunkPreamble(resourceId: string): string {
  const ctx = chunkContexts.get(resourceId);
  if (!ctx) return '';

  let preamble = '';

  if (ctx.documentSummary) {
    preamble += `[Document context]\n${ctx.documentSummary}\n\n`;
  }

  if (ctx.definitions.size > 0) {
    preamble += '[Definitions]\n';
    for (const [entity, descs] of ctx.definitions) {
      preamble += `- ${entity} = ${descs.join(', ')}\n`;
    }
    preamble += '\n';
  }

  if (ctx.previousChunkSummary) {
    preamble += `[Previous section]\n${ctx.previousChunkSummary}\n\n`;
  }

  if (ctx.trailingContext) {
    preamble += `[Trailing context]\n"${ctx.trailingContext}"\n\n`;
  }

  return preamble;
}

async function updateChunkContext(options: {
  resourceId: string;
  chunkText: string;
  extractedFacts: Array<{ s: string; p: string; o: string }>;
  chunkSummary: string;
}): Promise<void> {
  const { resourceId, chunkText, extractedFacts, chunkSummary } = options;

  const ctx = chunkContexts.get(resourceId) ?? {
    documentSummary: '',
    definitions: new Map<string, string[]>(),
    previousChunkSummary: '',
    trailingContext: '',
  };

  // Level 1: condense running document summary
  if (ctx.documentSummary) {
    ctx.documentSummary = await condenseSummary(ctx.documentSummary, chunkSummary);
  } else {
    ctx.documentSummary = chunkSummary;
  }

  // Level 2: accumulate definitional tuples
  for (const f of extractedFacts) {
    if (DEFINITIONAL_PREDICATES.includes(f.p)) {
      const desc = `${f.p}: ${f.o}`;
      const existing = ctx.definitions.get(f.s) ?? [];
      if (!existing.includes(desc)) existing.push(desc);
      ctx.definitions.set(f.s, existing);
    }
  }

  // Level 3: this chunk's summary becomes next chunk's "previous"
  ctx.previousChunkSummary = chunkSummary;

  // Level 4: last 2-3 sentences of raw text
  ctx.trailingContext = extractTrailingSentences(chunkText, 3);

  chunkContexts.set(resourceId, ctx);
}

async function condenseSummary(existing: string, newChunkSummary: string): Promise<string> {
  const raw = await anthropicChat({
    system:
      'Combine these two summaries into a single 1-2 sentence summary of the document so far.',
    userMessage: `Previous: ${existing}\nNew section: ${newChunkSummary}`,
    model: 'claude-haiku-4-5-20251001',
    label: 'knowledge_fact_summary_condense',
  });
  return raw.trim();
}

function extractTrailingSentences(text: string, count: number): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [];
  return sentences.slice(-count).join(' ').trim();
}

/** Clear chunk contexts — call at start of each pipeline run */
function resetChunkContexts(): void {
  chunkContexts.clear();
}

// ---------------------------------------------------------------------------
// Batch embedding (into extraction_fact's 256-wide vector column)
// ---------------------------------------------------------------------------

// Which model embeds these, how wide the vector is and who bills for it all
// belong to the destination column, so they live with the embedding service
// rather than being restated here. This function is now just the name the
// pipeline calls that by.
async function batchEmbed(texts: string[]): Promise<number[][]> {
  return embedTexts({
    texts,
    destination: 'extraction_fact',
    label: 'knowledge_fact_embedding',
  });
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

interface Fact {
  s: string;
  p: string;
  o: string;
  t?: string;
}

interface ExtractedFacts {
  facts: Fact[];
  chunkSummary: string;
}

async function extractFacts(options: {
  resourceId: ResourceId | undefined;
  contextText: string;
  branches?: ExtractionBranch[];
}): Promise<ExtractedFacts> {
  const { resourceId, contextText, branches } = options;

  const preamble = resourceId ? buildChunkPreamble(resourceId) : '';

  const raw = await anthropicChat({
    system: buildFactPrompt(branches),
    userMessage: preamble + contextText,
    model: 'claude-haiku-4-5-20251001',
    label: 'knowledge_fact_extraction',
  });

  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object') {
    return { facts: [], chunkSummary: '' };
  }

  const rawFacts: unknown[] = Array.isArray(parsed) ? parsed : parsed.facts;
  const chunkSummary: string = parsed.summary ?? '';
  if (!Array.isArray(rawFacts)) {
    return { facts: [], chunkSummary };
  }

  const facts = rawFacts
    .filter((f: any): f is Fact => f && f.s && f.p && f.o)
    .map((f: any) => ({ s: f.s, p: f.p, o: f.o, ...(f.t ? { t: f.t } : {}) }));

  if (resourceId) {
    await updateChunkContext({
      resourceId,
      chunkText: contextText,
      extractedFacts: facts,
      chunkSummary,
    });
  }

  return { facts, chunkSummary };
}

// ---------------------------------------------------------------------------
// Resource-lifecycle fact extraction (R8)
// ---------------------------------------------------------------------------
//
// When a Resource enters the pipeline (inbound trigger, transform output,
// sub-resource discovery) the framework calls `extractFactsForResource`
// once. The result is cached on the Resource value itself via a WeakMap
// keyed by the Resource object — so a second invocation on the same
// Resource returns the cached facts without re-issuing the LLM call.
//
// Persistence of the cached facts rides on adapter `writeResource`
// (gaps_inventory.md §D5 / R3 ruling). This module owns extraction +
// in-memory caching only.

const MIN_RESOURCE_CONTENT_LENGTH = 100;

interface ResourceFactCacheEntry {
  facts: Fact[];
  /** When extraction is still in-flight, both keys point at the same
   *  promise so concurrent callers coalesce on the same LLM call. */
  inFlight?: Promise<Fact[]>;
}

const resourceFactCache = new WeakMap<Resource, ResourceFactCacheEntry>();

/**
 * Run fact extraction on a Resource, caching the result on the Resource
 * value. Idempotent: repeat calls on the same Resource object return the
 * cached facts without re-invoking the LLM.
 *
 * Returns `[]` for resources whose content is too short to be worth
 * extracting (or unavailable). Errors during extraction are logged and
 * surfaced as `[]` to keep the lifecycle non-fatal — extraction is a
 * best-effort enrichment, not a precondition for the resource entering
 * the pipeline.
 */
async function extractFactsForResource(resource: Resource): Promise<Fact[]> {
  // G1-content K.4 — entry log so the dev loop can confirm the
  // lifecycle hook is reached at all. Pair with the apply-side
  // log emitted by `apply.ts` when `writeResource.facts` is forwarded.
  logger.debug('[extractFactsForResource] Enter', {
    resourceId: resource.id ?? resource.externalId,
    resourceType: resource.type,
    contentLength: resource.content?.length ?? 0,
    hasName: !!resource.name,
  });

  const existing = resourceFactCache.get(resource);
  if (existing?.inFlight) {
    logger.debug('[extractFactsForResource] Cache hit (in-flight)', {
      resourceId: resource.id ?? resource.externalId,
    });
    return existing.inFlight;
  }
  if (existing) {
    logger.debug('[extractFactsForResource] Cache hit (resolved)', {
      resourceId: resource.id ?? resource.externalId,
      factCount: existing.facts.length,
    });
    return existing.facts;
  }

  const content = resource.content;
  if (!content || content.trim().length < MIN_RESOURCE_CONTENT_LENGTH) {
    logger.debug('[extractFactsForResource] Skipping (no/short content)', {
      resourceId: resource.id ?? resource.externalId,
      contentLength: content?.length ?? 0,
    });
    const entry: ResourceFactCacheEntry = { facts: [] };
    resourceFactCache.set(resource, entry);
    return entry.facts;
  }

  const promise = (async () => {
    try {
      const { facts } = await extractFacts({
        // Internal UUID when persisted; undefined when the resource is
        // still in-flight (writeResource hasn't yet minted an id). The
        // fact-cache write path tolerates `undefined` — extractFacts
        // uses it for downstream provenance only.
        resourceId: resource.id !== undefined ? resourceIdSchema.parse(resource.id) : undefined,
        contextText: content,
      });
      logger.debug('[extractFactsForResource] Extracted', {
        resourceId: resource.id ?? resource.externalId,
        factCount: facts.length,
      });
      return facts;
    } catch (err) {
      logger.warn('[extractFactsForResource] Extraction failed', {
        resourceId: resource.id ?? resource.externalId,
        error: err,
      });
      return [] as Fact[];
    }
  })();

  const entry: ResourceFactCacheEntry = { facts: [], inFlight: promise };
  resourceFactCache.set(resource, entry);

  const facts = await promise;
  resourceFactCache.set(resource, { facts });
  return facts;
}

/**
 * Look up cached facts for a Resource without triggering extraction.
 * Returns `undefined` when no extraction has run for this Resource value
 * yet. Bundle assemblers (R2's C2 stage) use this to surface facts that
 * the lifecycle hook has already produced.
 */
function getCachedFactsForResource(resource: Resource): Fact[] | undefined {
  const entry = resourceFactCache.get(resource);
  if (!entry || entry.inFlight) return entry?.facts.length ? entry.facts : undefined;
  return entry.facts;
}

/** Test hook — clear the per-Resource cache. Production callers should
 *  not need this since the WeakMap entries get GC'd alongside the
 *  Resource values themselves. */
function _resetResourceFactCache(resource: Resource): void {
  resourceFactCache.delete(resource);
}

async function storeFacts(options: {
  facts: Fact[];
  messageNodeId: NodeId;
  resourceId: ResourceId | undefined;
  teamId: TeamId;
}): Promise<number> {
  const { facts, messageNodeId, resourceId, teamId } = options;
  if (facts.length === 0) return 0;

  const factStrings = facts.map((f) => `${f.s} ${f.p} ${f.o}`);
  const embeddings = await batchEmbed(factStrings);

  const qb = getKnowledgeQb(['extraction_fact']);
  for (let i = 0; i < facts.length; i++) {
    await qb
      .insertInto('extraction_fact')
      .values({
        team_id: teamId,
        message_node_id: messageNodeId,
        resource_id: resourceId ?? null,
        subject: String(facts[i].s),
        predicate: String(facts[i].p),
        object: String(facts[i].o),
        embedding: JSON.stringify(embeddings[i]),
      })
      .execute();
  }

  return facts.length;
}

// ---------------------------------------------------------------------------
// Fact search (for ask-agent fallback and backfill)
// ---------------------------------------------------------------------------

interface FactSearchResult {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  message_node_id: string;
  resource_id: string | null;
  similarity: number;
}

async function searchFacts(options: {
  query: string;
  teamId: TeamId;
  limit?: number;
}): Promise<FactSearchResult[]> {
  const { query, teamId, limit = 50 } = options;

  // Embed the query
  const [queryEmbedding] = await batchEmbed([query]);
  const embeddingVector = JSON.stringify(queryEmbedding);

  const qb = getKnowledgeQb(['extraction_fact']);
  const { sql } = await import('kysely');

  const results = await qb
    .selectFrom('extraction_fact')
    .select([
      'extraction_fact.id',
      'extraction_fact.subject',
      'extraction_fact.predicate',
      'extraction_fact.object',
      'extraction_fact.message_node_id',
      'extraction_fact.resource_id',
      sql<number>`1 - (extraction_fact.embedding <=> ${embeddingVector}::vector)`.as('similarity'),
    ])
    .where('extraction_fact.team_id', '=', teamId)
    .where('extraction_fact.embedding', 'is not', null)
    .orderBy(sql`extraction_fact.embedding <=> ${embeddingVector}::vector`, 'asc')
    .limit(limit)
    .execute();

  return results as unknown as FactSearchResult[];
}

export {
  extractFacts,
  extractFactsForResource,
  getCachedFactsForResource,
  storeFacts,
  searchFacts,
  batchEmbed,
  resetChunkContexts,
  _resetResourceFactCache,
};
export type { Fact, ExtractionBranch, ExtractedFacts, FactSearchResult };
