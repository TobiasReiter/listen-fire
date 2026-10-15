// The constrained engine: every decision about what to look at is in code.
//
// It routes on what the entry actually carries, because the three things an
// entry can be are three different identity problems:
//
//   - A LINKEDIN ADDRESS is an identity anchor. Whoever holds that profile is
//     the person, so the only question is freshness, and everything found
//     afterwards is accepted only where it is consistent with their own
//     headline.
//   - A WEBSITE is the subject's own words. There is nothing to confirm; it is
//     read through the shared fetch, which is HTML-only and capped.
//   - A BARE NAME is the hard case and the common one. A name alone returns
//     the world, so nothing is searched without a distinctive term from the
//     context, no result counts on a name match alone, and a model confirms
//     the candidate before the address is trusted. A WRONG website is worse
//     than none: it poisons every field extracted after it.
//
// Whatever routes ran, they end in ONE synthesis call sized to the caller's
// questions. The routes gather evidence; the synthesis is where the answer is
// written, so an entry that arrived with a profile AND a name gets one dossier
// rather than two half-answers.

import { z } from 'zod';

import type { ChatModelName } from 'movement-engine/lib/models/registry';
import type { ProfileIdentity } from '../linkedin_identity';
import type { SearchHit } from '../search_hygiene';
import type {
  AnsweredExtent,
  ResearchConfidence,
  ResearchEngine,
  ResearchInput,
  ResearchOptions,
  ResearchResult,
  ResearchUsage,
} from './contract';

import { SECOND } from '../../../../../constants';
import { anthropicChatStructured, meterAnthropicUsage } from '../../../../../lib/anthropic';
import { DocumentSourceService } from '../../../../../lib/document_sources';
import { runFields } from '../../../../../lib/llm_usage';
import { looksLikeNonHtmlAddress } from '../../../../../lib/utils/url';
import { logger } from 'movement-engine/services/logger';
import { describeError, fetchWithTimeout } from '../fetch_resource';
import { canonicalProfileUrl, isLinkedInLink, profileSlug } from '../linkedin_identity';
import {
  addHit,
  asExactPhrase,
  containsAnchor,
  distinctiveContextTerms,
  distinctiveOrganisation,
  homepageOf,
  hostOf,
  isAggregator,
  isConsistent,
  looksLikeOwnDomain,
  runSearch,
} from '../search_hygiene';
import {
  budgetOf,
  DEFAULT_RESEARCH_MODEL,
  dossierField,
  emptyUsage,
  noteFetchFailure,
  nothingFound,
  outcomeOf,
  retryFiling,
  sourcesField,
  stripVerificationOpener,
} from './contract';
import { readProfile } from './profile_read';

const LOG = '[transform:research:constrained]';

/** What the engine itself spent. The model counts are filled in by the meter
 *  around it, so they are not the engine's to report mid-run. */
function spend(usage: ResearchUsage): { searches: number; fetches: number } {
  return { searches: usage.searches, fetches: usage.fetches };
}

/** How much of a fetched page the synthesiser is shown. The answer is a few
 *  paragraphs; a whole homepage in the prompt buys nothing but tokens. */
const PAGE_EXCERPT_CHARS = 4000;

/** One page inside a three-minute budget is worth this much patience and no
 *  more. The shared plumbing's own backstop is SEVEN minutes, which is the
 *  right patience for a deck behind a login and would spend the whole budget
 *  on one homepage; the wall clock stops the reads adding up. */
const PAGE_FETCH_TIMEOUT_MS = 60 * SECOND;

/** How many candidate sites the confirming model is shown. Past the third the
 *  ranking has already said the answer is not in the list. */
const MAX_CANDIDATES = 3;

// ── The evidence one entry accumulates ────────────────────────────────────

interface Evidence {
  hits: SearchHit[];
  pages: Array<{ url: string; text: string }>;
  website: string | null;
  linkedin: string | null;
  identity: ProfileIdentity | null;
  /** What a result must be consistent with to be about THIS subject. */
  terms: string[];
  /** Why a chosen page could not be read, when that happened. */
  fetchFailed: boolean;
}

/** Why this address must not be opened, or null when it is a page. A plugin
 *  researching a subject has no use for a sixty-megabyte annual report, and
 *  the shared fetch would route one into the document pipeline before the
 *  scraper's own file guard is reached. */
function unreadableAddress(link: string): string | null {
  if (DocumentSourceService.isSupportedUrl(link)) return 'a document source, not a page';
  if (looksLikeNonHtmlAddress(link)) return 'an address that names a file';
  return null;
}

// ── The model calls ───────────────────────────────────────────────────────

const planSchema = z.object({
  queries: z.array(z.string()).max(6).nullish(),
  anchors: z.array(z.string()).max(8).nullish(),
});

const PLANNER_SYSTEM = `You are planning web searches to find out about one specific subject — a company or a person.

You are given a name, a line of context about it (whatever a message said: what it does, where it is, who is behind it), and what the caller wants to find out.

Return JSON:
- "queries": at most three web searches that would surface the subject's own pages and recent news about it. Every query must contain the name AND at least one distinctive word from the context (a city, a sector, a product, a person). A query that is only the name searches for the word, not for the subject.
- "anchors": the distinctive words FROM THE CONTEXT you relied on, each written exactly as it appears there. A word you did not take from the context is not an anchor.

A context saying "Stealth", "Stealth Startup", "Confidential", "Self-employed", "Independent" or "Freelance" names nothing: it is what someone writes when they will not say. Never anchor on one.

If the context says nothing distinctive, return empty lists. That is a real answer: some names cannot be searched for.`;

const confirmSchema = z.object({
  choice: z.number().int().nullish(),
  confidence: z.enum(['high', 'medium', 'low']).nullish(),
});

const CONFIRM_SYSTEM = `You are deciding whether one of these websites belongs to the subject described.

You are given a name, the context a message gave about it, and numbered candidate sites with their titles, snippets and hosts.

Return JSON:
- "choice": the number of the candidate that is that subject's own site, or null if none of them is.
- "confidence": "high" only if the candidate's content matches the context — the same business, the same sector, and where the context names a place or a person, no contradiction. "medium" if it is plausibly them but the page says nothing that confirms it. "low" otherwise.

A different subject with the same name is the failure to avoid, and it is common: names are reused across countries and sectors. When the evidence only says "this name exists", the answer is null.

Two more nulls, both of which look like matches:
- a page belonging to a large established company, product, standard or framework that happens to share the name — the subject described is one a message has just noticed, not a household name;
- a page ABOUT the subject rather than BY it: an article, a directory entry, a review, a jobs board, a list it appears on.`;

/** `found`, `answers_everything`, `confidence` and `summary` are load-bearing
 *  — there is nothing to file without them, and "found nothing" is an answer
 *  rather than an absence. `dossier` and `sources` are not (see
 *  `contract.ts` — the quirk this guards against is shared with the agentic
 *  engine's own shaping call). */
const synthesisSchema = z.object({
  found: z.boolean(),
  answers_everything: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string(),
  dossier: dossierField,
  sources: sourcesField,
});

const SYNTHESIS_SYSTEM = `You are writing a short, honest dossier about one subject — a company or a person — from what has been gathered about it: search snippets, pages read in full, and where there is one, a LinkedIn headline.

THE ACCEPTANCE RULE. Attribute a source to this subject only if it is consistent with the consistency terms you are given — the organisation, the sector, the location. A source that merely matches the name is a namesake's and must be excluded. Where the subject is a person and their own headline is given, nothing is attributed to them that contradicts it. A famous namesake is not a match.

SIZE IT TO THE QUESTIONS. You are told what the caller wants to know. Answer that and stop. A dossier for "what does it do and which sector" is a few paragraphs, not a page dump.

ANSWER, DON'T NARRATE. Write the summary as if the caller never doubted who this is: never mention searching, which sources were accepted or excluded, or that the identity checks out. Any doubt about identity belongs in confidence, not in the prose.

THE FIRST SENTENCE SAYS WHAT THE SUBJECT DOES. Not that a source matches, not that the identification is consistent, not which of several candidates this is. And never close on what could or could not be retrieved — a page that would not open, an address that could not be read: that is what confidence is for, and it belongs nowhere in the prose.

Report through the tool. Every field is required; when nothing survives the acceptance rule, report found = false with empty strings and an empty source list.

- "found": true only if at least one source consistent with the subject was found.
- "answers_everything": true only if the questions asked are all answered. False when some are and some are not.
- "confidence": "high" when the subject's own page, or two independent sources that agree, support the answer; "medium" when it is plausible and unconfirmed; "low" when the material is thin.
- "summary": the answer, in prose, sized to the questions. Cite every claim with a bracketed number, [1], [2].
- "dossier": the content itself — the excerpts and snippets that bear on the questions, each under its source address, so a later stage can read a detail this summary did not anticipate. Quote; do not paraphrase into a second summary.
- "sources": the addresses your citations refer to, in citation order.

A bracketed number is a position in the "sources" list YOU build, counting from 1 — never the position of a source in the list you were given. Every number in the summary must have an entry in "sources".`;

// ── The engine ────────────────────────────────────────────────────────────

export const constrainedEngine: ResearchEngine = async (input, options) => {
  const started = Date.now();
  const { value, usage: modelUsage } = await meterAnthropicUsage(() => research(input, options));
  return {
    ...value,
    usage: {
      ...value.usage,
      modelCalls: modelUsage.calls,
      inputTokens: modelUsage.inputTokens,
      outputTokens: modelUsage.outputTokens,
      cacheReadTokens: modelUsage.cacheReadTokens,
      cacheCreationTokens: modelUsage.cacheCreationTokens,
      wallClockMs: Date.now() - started,
    },
  };
};

async function research(
  input: ResearchInput,
  options: ResearchOptions | undefined,
): Promise<ResearchResult> {
  const run = runFields();
  const budget = budgetOf(options);
  const model = options?.model ?? DEFAULT_RESEARCH_MODEL;
  const deadline = Date.now() + budget.wallClockMs;

  const usage: ResearchUsage = emptyUsage();
  const spent = {
    searches: () => usage.searches < budget.maxSearches && Date.now() < deadline,
    fetches: () => usage.fetches < budget.maxFetches && Date.now() < deadline,
  };

  const name = input.name.trim();
  const context = (input.context ?? '').trim();
  const questions = (input.questions ?? '').trim();
  const evidence: Evidence = {
    hits: [],
    pages: [],
    website: null,
    linkedin: null,
    identity: null,
    terms: [],
    fetchFailed: false,
  };

  const search = async (query: string): Promise<SearchHit[]> => {
    if (!spent.searches()) return [];
    usage.searches += 1;
    return runSearch(query, LOG, run);
  };

  const read = async (url: string): Promise<string | null> => {
    if (!spent.fetches()) return null;
    const unreadable = unreadableAddress(url);
    if (unreadable) {
      logger.info(`${LOG} Skipped an address that is not a page`, { url, reason: unreadable, ...run });
      return null;
    }
    usage.fetches += 1;
    const text = await fetchExcerpt(url, run);
    if (text) evidence.pages.push({ url, text });
    return text;
  };

  // ── Route on what arrived ───────────────────────────────────────────────
  const { profile, website, others } = sortUrls(input.urls ?? []);

  if (profile) {
    evidence.linkedin = canonicalProfileUrl(profile);
    await researchProfile({ slug: profile, evidence, search, read, run });
  }

  if (website) {
    evidence.website = homepageOf(website) ?? website;
    const text = await read(website);
    if (!text) evidence.fetchFailed = true;
  }

  for (const url of others) {
    await read(url);
  }

  // A name with nothing but context is the fallback case: resolve the site
  // first, then read it.
  if (!website && name && context) {
    const resolved = await resolveWebsite({
      name,
      context,
      questions,
      model,
      evidence,
      search,
      run,
    });
    if (resolved) {
      evidence.website = resolved;
      const text = await read(resolved);
      if (!text) evidence.fetchFailed = true;
    }
  }

  // ── One synthesis ───────────────────────────────────────────────────────
  const anything =
    evidence.hits.length > 0 || evidence.pages.length > 0 || evidence.identity != null;
  if (!anything) {
    const outcome = outcomeOf({ answered: 'none', fetchFailed: evidence.fetchFailed });
    logger.info(`${LOG} ${outcome}`, { name, outcome, ...spend(usage), ...run });
    return {
      ...nothingFound(outcome, usage),
      ...(evidence.website ? { website: evidence.website } : {}),
      ...(evidence.linkedin ? { linkedin: evidence.linkedin } : {}),
    };
  }

  const synthesis = await synthesise({ name, context, questions, evidence, model, run });

  // A schema failure on BOTH attempts has nothing left to decide — the
  // evidence was real, only the call that would have turned it into prose
  // choked. File the raw evidence, flagged low-confidence, and put the
  // failure on the record rather than the outcome.
  if ('failure' in synthesis) {
    const outcome = outcomeOf({ answered: 'some', fetchFailed: evidence.fetchFailed });
    usage.notes = [...(usage.notes ?? []), `synthesis failed after a retry: ${synthesis.failure}`];
    if (evidence.fetchFailed) noteFetchFailure(usage, evidence.website ?? 'unknown url');
    logger.warn(`${LOG} filed the raw evidence after the synthesis call failed twice`, {
      name,
      outcome,
      error: synthesis.failure,
      ...run,
    });
    return {
      outcome,
      summary: rawEvidenceText(evidence),
      confidence: 'low',
      sources: [...new Set(evidence.pages.map((p) => p.url))],
      ...(evidence.website ? { website: evidence.website } : {}),
      ...(evidence.linkedin ? { linkedin: evidence.linkedin } : {}),
      usage,
    };
  }

  const filed = synthesis.value;
  if (!filed.found || !filed.summary.trim()) {
    logger.info(`${LOG} nothing consistent`, {
      name,
      outcome: 'no_match',
      ...spend(usage),
      ...run,
    });
    return {
      ...nothingFound(outcomeOf({ answered: 'none', fetchFailed: evidence.fetchFailed }), usage),
      ...(evidence.website ? { website: evidence.website } : {}),
      ...(evidence.linkedin ? { linkedin: evidence.linkedin } : {}),
    };
  }

  const answered: AnsweredExtent = filed.answers_everything ? 'all' : 'some';
  const outcome = outcomeOf({ answered, fetchFailed: evidence.fetchFailed });
  if (evidence.fetchFailed) {
    noteFetchFailure(usage, evidence.website ?? 'unknown url');
    logger.info(`${LOG} a fetch failed alongside a real answer`, {
      name,
      outcome,
      url: evidence.website,
      ...run,
    });
  }

  const { summary, stripped } = stripVerificationOpener(filed.summary.trim());
  if (stripped) {
    usage.notes = [...(usage.notes ?? []), `dropped a verification opener: ${stripped}`];
    logger.info(`${LOG} dropped a verification opener`, { name, sentence: stripped, ...run });
  }

  logger.info(`${LOG} ${outcome}`, {
    name,
    outcome,
    confidence: filed.confidence,
    ...spend(usage),
    ...run,
  });

  return {
    outcome,
    summary,
    confidence: filed.confidence satisfies ResearchConfidence,
    sources: filed.sources.map((s) => s.trim()).filter(Boolean),
    ...(evidence.website ? { website: evidence.website } : {}),
    ...(evidence.linkedin ? { linkedin: evidence.linkedin } : {}),
    ...(filed.dossier.trim() ? { dossier: filed.dossier.trim() } : {}),
    usage,
  };
}

// ── Routing ───────────────────────────────────────────────────────────────

/** Which of the entry's addresses is a profile, which is a homepage, which is
 *  something else worth reading. */
function sortUrls(urls: readonly string[]): {
  profile: string | null;
  website: string | null;
  others: string[];
} {
  let profile: string | null = null;
  let website: string | null = null;
  const others: string[] = [];

  for (const raw of urls) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (!url) continue;
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const slug = profileSlug(withScheme);
    if (slug) {
      profile ??= slug;
      continue;
    }
    // A LinkedIn address that is not a profile (a company page, a post) is a
    // login wall to the scraper — nothing to read.
    if (isLinkedInLink(withScheme)) continue;
    if (!website) website = withScheme;
    else others.push(withScheme);
  }

  return { profile, website, others };
}

// ── The profile route ─────────────────────────────────────────────────────

/**
 * The address anchors identity: two searches establish who holds it, the
 * profile service is asked only when the index came back with nothing to check
 * a result against, and every query after that has to name them or a real
 * organisation they are attached to.
 */
async function researchProfile(args: {
  slug: string;
  evidence: Evidence;
  search: (query: string) => Promise<SearchHit[]>;
  read: (url: string) => Promise<string | null>;
  run: Record<string, unknown>;
}): Promise<void> {
  const { slug, evidence, search, read, run } = args;

  const { profileUrl, identity, text } = await readProfile({ slug, search, log: LOG, run });
  if (text) evidence.pages.push({ url: profileUrl, text });

  if (!identity.name) return;
  evidence.identity = identity;

  // The organisation the headline names is reported as it stands; only a
  // distinctive one is something to search for, and only a distinctive one
  // tells a result apart from a stranger's.
  const organisation = distinctiveOrganisation(identity.organisation);
  const parts = identity.name.split(/\s+/);
  const anchors = [
    identity.name,
    ...(parts.length > 1 ? [parts[parts.length - 1]] : []),
    ...(organisation ? [organisation] : []),
  ];
  evidence.terms = [
    ...(organisation ? [organisation] : []),
    ...(identity.role ? [identity.role] : []),
  ];

  const queries = [
    `"${identity.name}"${organisation ? ` "${organisation}"` : ''}`,
    ...(organisation ? [`"${organisation}" ${identity.name}`] : []),
  ];
  for (const query of queries) {
    for (const hit of await search(query)) {
      if (!addHit(evidence.hits, hit)) continue;
      // Opening a page costs a large part of the wall clock, so a result that
      // already fails the acceptance rule stays a snippet: a namesake's page
      // is not worth twenty-five seconds.
      if (
        !isLinkedInLink(hit.link) &&
        isConsistent(hit, evidence.terms) &&
        containsAnchor(`${hit.title} ${hit.snippet}`, anchors)
      ) {
        await read(hit.link);
      }
    }
  }
}

// ── The bare-name route ───────────────────────────────────────────────────

/**
 * Resolve a name to the subject's own homepage: plan queries, enforce the
 * anchors in code, keep only what could be their own site, and let a model
 * confirm one candidate. Anything short of a confident match resolves nothing
 * — a wrong website is worse than none.
 */
async function resolveWebsite(args: {
  name: string;
  context: string;
  questions: string;
  model: ChatModelName;
  evidence: Evidence;
  search: (query: string) => Promise<SearchHit[]>;
  run: Record<string, unknown>;
}): Promise<string | null> {
  const { name, context, questions, model, evidence, search, run } = args;

  const searchable = distinctiveOrganisation(name);
  if (!searchable) return null;

  const plan = await planQueries({ name: searchable, context, questions, model, run });

  // An anchor the planner invented is not an anchor: only what the message
  // actually said tells this subject apart from another of the same name.
  const haystack = context.toLowerCase();
  const anchors = (plan.anchors ?? [])
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && haystack.includes(term.toLowerCase()))
    .filter((term) => distinctiveOrganisation(term) !== null);
  if (anchors.length === 0) {
    logger.info(`${LOG} No anchor survived the context check`, { name, ...run });
    return null;
  }
  evidence.terms = [...evidence.terms, ...anchors];

  const queries = (plan.queries ?? [])
    .map((query) => query.trim())
    .filter(
      (query) => query && containsAnchor(query, [searchable]) && containsAnchor(query, anchors),
    )
    .map((query) => asExactPhrase(query, searchable));

  const candidates: SearchHit[] = [];
  for (const query of queries) {
    for (const hit of await search(query)) {
      addHit(evidence.hits, hit);
      const host = hostOf(hit.link);
      if (!host || isAggregator(host)) continue;
      // A conference programme or a filing is not anybody's homepage.
      if (looksLikeNonHtmlAddress(hit.link)) continue;
      // A result that does not name the subject cannot be its site, whatever
      // the query was.
      if (!containsAnchor(`${hit.title} ${hit.snippet}`, [searchable])) continue;
      if (candidates.some((c) => hostOf(c.link) === host)) continue;
      candidates.push(hit);
    }
  }

  // A domain that spells the name is the likeliest answer, so it is the one
  // the confirming model is shown first.
  candidates.sort((a, b) => {
    const own = (hit: SearchHit) => (looksLikeOwnDomain(hostOf(hit.link) ?? '', searchable) ? 0 : 1);
    return own(a) - own(b);
  });
  const shortlist = candidates.slice(0, MAX_CANDIDATES);
  if (shortlist.length === 0) return null;

  const confirmed = await confirmCandidate({ name: searchable, context, shortlist, model, run });
  const chosen =
    confirmed.confidence === 'high' && typeof confirmed.choice === 'number'
      ? shortlist[confirmed.choice - 1]
      : undefined;
  return chosen ? homepageOf(chosen.link) : null;
}

// ── The steps ─────────────────────────────────────────────────────────────

async function planQueries(args: {
  name: string;
  context: string;
  questions: string;
  model: ChatModelName;
  run: Record<string, unknown>;
}): Promise<z.infer<typeof planSchema>> {
  const { name, context, questions, model, run } = args;
  try {
    return await anthropicChatStructured({
      system: PLANNER_SYSTEM,
      userMessage: [
        `Name: ${name}`,
        `Context: ${context}`,
        `The caller wants to know: ${questions || 'what it is and what it does'}`,
      ].join('\n'),
      schema: planSchema,
      toolName: 'plan_searches',
      toolDescription: "Plan the searches that would find this subject's own pages.",
      model,
      label: 'plugin_research_plan',
    });
  } catch (error) {
    logger.warn(`${LOG} The query planner failed`, { name, error: describeError(error), ...run });
    return { queries: [], anchors: [] };
  }
}

async function confirmCandidate(args: {
  name: string;
  context: string;
  shortlist: SearchHit[];
  model: ChatModelName;
  run: Record<string, unknown>;
}): Promise<z.infer<typeof confirmSchema>> {
  const { name, context, shortlist, model, run } = args;
  try {
    return await anthropicChatStructured({
      system: CONFIRM_SYSTEM,
      userMessage: [
        `Name: ${name}`,
        `Context: ${context}`,
        'Candidates:',
        ...shortlist.map(
          (hit, i) => `${i + 1}. ${hostOf(hit.link) ?? hit.link}\n   ${hit.title}\n   ${hit.snippet}`,
        ),
      ].join('\n'),
      schema: confirmSchema,
      toolName: 'confirm_website',
      toolDescription: "Say which candidate is this subject's own site, or that none is.",
      model,
      label: 'plugin_research_confirm',
    });
  } catch (error) {
    logger.warn(`${LOG} The confirmation failed`, { name, error: describeError(error), ...run });
    return { choice: null, confidence: 'low' };
  }
}

async function synthesise(args: {
  name: string;
  context: string;
  questions: string;
  evidence: Evidence;
  model: ChatModelName;
  run: Record<string, unknown>;
}): Promise<{ value: z.infer<typeof synthesisSchema> } | { failure: string }> {
  const { name, context, questions, evidence, model, run } = args;
  const userMessage = [
    // An entry can arrive as an address and nothing else — a profile with no
    // name beside it — and then the address is the whole identity.
    name ? `Subject: ${name}` : 'Subject: not named — the entry carried only an address, so whoever holds it IS the subject.',
    context ? `What the message said about it: ${context}` : null,
    `The caller wants to know: ${questions || 'what it is and what it does'}`,
    evidence.identity
      ? `Their own headline (the identity anchor): ${evidence.identity.headline ?? 'unknown'}`
      : null,
    `Consistency terms (the acceptance rule): ${
      evidence.terms.length ? evidence.terms.join(', ') : 'the context above'
    }`,
    evidence.website ? `Resolved website: ${evidence.website}` : null,
    evidence.linkedin ? `Profile address: ${evidence.linkedin}` : null,
    evidence.hits.length
      ? `Search results:\n${evidence.hits
          .map((h) => `- ${h.title}\n  ${h.link}\n  ${h.snippet}`)
          .join('\n')}`
      : 'No search results.',
    evidence.pages.length
      ? `Pages read in full:\n${evidence.pages.map((p) => `${p.url}\n${p.text}`).join('\n\n')}`
      : null,
  ]
    .filter((part): part is string => part != null)
    .join('\n\n');

  // A forced tool call, not free text asked to be JSON: the summary is prose
  // inside a JSON string, and a stray bracket there throws a whole answer
  // away. The tool's schema is the shape, so there is nothing left to
  // mis-punctuate. Retried once with the rejection reason appended
  // (`retryFiling` in `contract.ts`); only a failure on BOTH attempts is
  // reported, and the caller falls back to the raw evidence rather than
  // discard it.
  return retryFiling({
    call: (message) =>
      anthropicChatStructured({
        system: SYNTHESIS_SYSTEM,
        userMessage: message,
        schema: synthesisSchema,
        toolName: 'report_research',
        toolDescription:
          'Report what was found about this subject, with a confidence and its sources.',
        model,
        maxTokens: 8192,
        label: 'plugin_research_synthesise',
      }),
    firstMessage: userMessage,
    onFailure: (attempt, error) => {
      logger.warn(
        `${LOG} The synthesis failed${attempt === 1 ? '; retrying once' : ' on retry'}`,
        { name, error, ...run },
      );
    },
  });
}

/** What synthesis had to work with, before it tried to turn it into prose —
 *  the same reasoning the agentic engine applies to its own unshaped
 *  write-up when the call that would file it fails twice. The gate before
 *  `synthesise` is called guarantees at least one of these is non-empty. */
function rawEvidenceText(evidence: Evidence): string {
  const parts = [
    ...evidence.pages.map((p) => `${p.url}\n${p.text}`),
    ...evidence.hits.map((h) => `${h.title}\n${h.link}\n${h.snippet}`),
    ...(evidence.identity
      ? [[evidence.identity.name, evidence.identity.headline].filter(Boolean).join(' — ')]
      : []),
  ];
  return parts.filter(Boolean).join('\n\n').trim();
}

/**
 * Load one page. The shared plumbing's backstop is minutes long, which is the
 * wrong patience here — a handful of pages inside a three-minute budget are
 * worth a few seconds each — so the wait is bounded again on top of it.
 */
async function fetchExcerpt(url: string, run: Record<string, unknown>): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const abandon = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.info(`${LOG} Gave up on a page`, { url, timeoutMs: PAGE_FETCH_TIMEOUT_MS, ...run });
      resolve(null);
    }, PAGE_FETCH_TIMEOUT_MS);
  });
  try {
    const fetched = await Promise.race([fetchWithTimeout(url, null), abandon]);
    const content = fetched?.content?.trim();
    if (!content) return null;
    logger.info(`${LOG} Read a page`, { url, chars: content.length, ...run });
    return content.slice(0, PAGE_EXCERPT_CHARS);
  } catch (error) {
    logger.warn(`${LOG} A page failed to load`, { url, error: describeError(error), ...run });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
