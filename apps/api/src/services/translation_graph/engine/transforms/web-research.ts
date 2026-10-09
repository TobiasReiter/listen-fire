// web-research — the entry that arrived with nothing but a name.
//
// Most of a deal-flow message is links: a website to fetch, a profile to
// research. The rest is a name and a line of traction text, and every
// retrieval plugin skips it, so the stage behind them sees the same one line
// the stage before it read. This plugin is what those entries go through: it
// resolves the name to the company's own homepage, fetches it, and hands back
// the address plus the page, in the shape `fetch-url` hands back a page, so
// the next stage folds it the same way.
//
// It stands down rather than duplicating work: an entry that already carries a
// website or a profile address is somebody else's job, and this one returns
// immediately without a model call or a search.
//
// A WRONG website is worse than none — it poisons the description, the deep
// dive and whatever the run writes into a CRM domain field — so the gates are
// deliberately severe:
//
//   1. No search without an anchor. A bare short name is a word, not a
//      company, and searching for it returns the world. A query has to name
//      the company AND something the context said about it (a location, a
//      sector, a founder). No anchor in the context, no search — that entry
//      stays unenriched, which is the correct answer rather than a failure.
//   2. No candidate on a name match alone. Aggregators and app stores name
//      everybody; only the company's own site is worth having, and a model
//      confirms it against the context before it counts. Anything short of a
//      confident match emits nothing.
//   3. Two queries, one fetch. These entries are two thirds of a run, so
//      every cost here multiplies.

import { z } from 'zod';

import type { PluginManifest, TransformImpl, TransformOutput } from './registry';
import type { SearchHit } from './search_hygiene';
import type { TransformSignature } from '../../types';

import { anthropicChatStructured } from '../../../../lib/anthropic';
import { runFields } from '../../../../lib/llm_usage';
import { looksLikeNonHtmlAddress } from '../../../../lib/utils/url';
import { logger } from '../../../logger';
import { describeError, emissionOf, fetchWithTimeout } from './fetch_resource';
import {
  asExactPhrase,
  containsAnchor,
  distinctiveOrganisation,
  homepageOf,
  hostOf,
  isAggregator,
  looksLikeOwnDomain,
  runSearch,
} from './search_hygiene';
import { WEB_RESEARCH_HANDBOOK_SECTION } from './web_research_handbook_section';
import { importIdentifier } from '../../movement/schema_projection';

// ── Signature ─────────────────────────────────────────────────────────────

export const WEB_RESEARCH_SIGNATURE: TransformSignature = {
  name: 'web-research',
  description:
    "Find a company's own website from its name and what a message said about it, and fetch it. Stands down for a record that already carries a link.",
  params: [
    {
      name: 'name',
      type: { kind: 'string' },
      required: true,
      description:
        'The name to research. Normally a field an earlier stage extracted, so each record is ' +
        'researched from its own name.',
    },
    {
      name: 'context',
      type: { kind: 'string' },
      description:
        'What the message said about it — a description, a sector, a location, the people ' +
        'behind it. This is what tells the company apart from every other use of the word, ' +
        'and without it nothing is searched for at all.',
    },
    {
      name: 'website',
      type: { kind: 'string' },
      description:
        "The record's web address, when it has one. Pass it so this stands down: a record " +
        'that already has a link needs no research, and nothing is searched or fetched for it.',
    },
    {
      name: 'linkedin',
      type: { kind: 'string' },
      description:
        "The record's LinkedIn address, when it has one. Pass it for the same reason as " +
        '`website` — the profile is a better source than a search, and the profile plugin ' +
        'has it covered.',
    },
  ],
  // The name and the context are fields the enclosing extract produced, so
  // this only makes sense as a stage of an extraction.
  dataDependency: 'extracted_context',
  // Searches, fetches one page, and asks a model twice — to plan the queries
  // and to confirm the candidate.
  effects: { reads: ['the web'], ai: true },
  additions: {
    properties: {
      website: { kind: 'string' },
    },
    // The same record `fetch-url` emits, so a stage behind either of them
    // reads the page the same way.
    edges: {
      fetchedUrl: {
        target: {
          kind: 'record',
          fields: {
            name: { kind: 'string' },
            url: { kind: 'string' },
            file: { kind: 'file' },
            text: { kind: 'string' },
          },
        },
      },
    },
  },
  // Both halves of what it did: the address it settled on, and the page it
  // fetched from there. Either can be missing — a record that already carried a
  // link makes this stand down, and a search that found nothing fetches nothing.
  output: {
    kind: 'record',
    fields: {
      website: {
        type: { kind: 'string' },
        optional: true,
        description: "The company's own web address, as found.",
      },
      text: {
        type: { kind: 'string' },
        optional: true,
        description: 'The text of the page it fetched from that address.',
      },
    },
  },
};

export const WEB_RESEARCH_PLUGIN_MANIFEST: PluginManifest = {
  pluginName: WEB_RESEARCH_SIGNATURE.name,
  importName: importIdentifier(WEB_RESEARCH_SIGNATURE.name),
  displayName: 'Find the website',
  description:
    'The fallback for a record that arrived with no link: it works out a ' +
    "company's own website from its name and what the message said about it, " +
    'checks the site really is that company, and loads it. Pass the record’s ' +
    'link fields as well and it stands down whenever one of them is filled, so ' +
    'it only spends anything on the records nothing else could reach.',
  params: WEB_RESEARCH_SIGNATURE.params,
  contextAdditions:
    'Adds the resolved web address to the record, plus the page it loaded — ' +
    'the same fetched page a targeted fetch adds. Adds nothing at all when the ' +
    'message said too little to search on, or when no site could be confirmed ' +
    'as that company’s.',
  additions: WEB_RESEARCH_SIGNATURE.additions,
  handbookSection: WEB_RESEARCH_HANDBOOK_SECTION,
};

// ── Bounds ────────────────────────────────────────────────────────────────

/** Two searches and one fetch per record. These records are most of a run. */
const MAX_QUERIES = 2;

/** How many candidates the confirming model is shown. Past the third the
 *  ranking has already said the answer is not in the list. */
const MAX_CANDIDATES = 3;

const LOG = '[transform:web-research]';

// ── The two model calls ───────────────────────────────────────────────────

const planSchema = z.object({
  queries: z.array(z.string()).max(6).nullish(),
  anchors: z.array(z.string()).max(8).nullish(),
});

const PLANNER_SYSTEM = `You are finding one company's own website.

You are given a name and a line of context about it — whatever a message said: what it does, where it is, who is behind it.

Return JSON:
- "queries": at most two web searches that would surface that company's own site. Every query must contain the name AND at least one distinctive word from the context (a city, a sector, a product, a person). A query that is only the name searches for the word, not for the company.
- "anchors": the distinctive words FROM THE CONTEXT you relied on, each written exactly as it appears there. A word you did not take from the context is not an anchor.

If the context says nothing distinctive, return empty lists. That is a real answer: some names cannot be searched for.`;

const confirmSchema = z.object({
  choice: z.number().int().nullish(),
  confidence: z.enum(['high', 'medium', 'low']).nullish(),
});

const CONFIRM_SYSTEM = `You are deciding whether one of these websites belongs to the company described.

You are given a company name, the context a message gave about it, and numbered candidate sites with their titles, snippets and hosts.

Return JSON:
- "choice": the number of the candidate that is that company's own site, or null if none of them is.
- "confidence": "high" only if the candidate's content matches the context — the same business, the same sector, and where the context names a place or a person, no contradiction. "medium" if it is plausibly them but the page says nothing that confirms it. "low" otherwise.

A different company with the same name is the failure to avoid, and it is common: names are reused across countries and sectors. When the evidence only says "this name exists", the answer is null.

Two more nulls, both of which look like matches:
- a page belonging to a large established company, product, standard or framework that happens to share the name — the company described is one a message has just noticed, not a household name;
- a page ABOUT the company rather than BY it: an article, a directory entry, a review, a jobs board, a list it appears on.`;

// ── Public run ────────────────────────────────────────────────────────────

/** What became of one record's research. Carried on the trace, so a run's
 *  coverage is readable without re-deriving it from which fields landed. */
type Outcome = 'has_link' | 'no_anchor' | 'no_match' | 'fetch_failed' | 'resolved';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const webResearchImpl: TransformImpl = {
  signature: WEB_RESEARCH_SIGNATURE,
  // Every fetch, search and model call it makes is paid for.
  priced: true,
  run: async (input): Promise<TransformOutput> => {
    if (input.kind !== 'context-dependent') {
      throw new Error(`web-research: expected context-dependent input, got ${input.kind}`);
    }

    const run = runFields();
    const name = text(input.config.name);
    const context = text(input.config.context);

    const done = (outcome: Outcome, extra: Record<string, unknown> = {}) => {
      logger.info(`${LOG} ${outcome}`, { name, outcome, ...extra, ...run });
    };

    // A record that already has somewhere to go needs no research. Decided
    // before anything is spent — no model call, no search.
    const heldLink = text(input.config.website) || text(input.config.linkedin);
    if (heldLink) {
      done('has_link', { link: heldLink });
      return { outcome: 'has_link' };
    }

    // A placeholder is not a name to search for, and neither is a blank one
    // (the stage boundary normally skips that before this runs).
    const searchableName = distinctiveOrganisation(name);
    if (!searchableName || !context) {
      done('no_anchor', { reason: searchableName ? 'no context' : 'no distinctive name' });
      return { outcome: 'no_anchor' };
    }

    // ── 1. Plan, then enforce the anchors ourselves ───────────────────────
    const plan = await planQueries(searchableName, context, run);
    const haystack = context.toLowerCase();
    // An anchor the planner invented is not an anchor: only what the message
    // actually said tells this company apart from another of the same name.
    const contextAnchors = (plan.anchors ?? [])
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && haystack.includes(term.toLowerCase()))
      .filter((term) => distinctiveOrganisation(term) !== null);
    if (contextAnchors.length === 0) {
      done('no_anchor', { reason: 'nothing distinctive in the context' });
      return { outcome: 'no_anchor' };
    }

    const queries = (plan.queries ?? [])
      .map((query) => query.trim())
      .filter((query) => query.length > 0)
      // The mission's rule, applied here rather than trusted to the planner:
      // the name says which company, the context anchor says which of the
      // companies with that name.
      .filter(
        (query) =>
          containsAnchor(query, [searchableName]) && containsAnchor(query, contextAnchors),
      )
      .slice(0, MAX_QUERIES)
      .map((query) => asExactPhrase(query, searchableName));
    if (queries.length === 0) {
      done('no_anchor', { reason: 'no query named both the company and an anchor' });
      return { outcome: 'no_anchor' };
    }

    // ── 2. Search, and keep only what could be their own site ─────────────
    const candidates: SearchHit[] = [];
    for (const query of queries) {
      for (const hit of await runSearch(query, LOG, run)) {
        const host = hostOf(hit.link);
        if (!host || isAggregator(host)) continue;
        // A conference programme or a filing is not anybody's homepage, and
        // the shared fetch would route it into the document pipeline.
        if (looksLikeNonHtmlAddress(hit.link)) continue;
        // A result that does not name the company cannot be its site,
        // whatever the query was.
        if (!containsAnchor(`${hit.title} ${hit.snippet}`, [searchableName])) continue;
        if (candidates.some((c) => hostOf(c.link) === host)) continue;
        candidates.push(hit);
      }
    }
    // A domain that spells the name is the likeliest answer, so it is the one
    // the confirming model is shown first.
    candidates.sort((a, b) => {
      const aOwn = looksLikeOwnDomain(hostOf(a.link) ?? '', searchableName) ? 0 : 1;
      const bOwn = looksLikeOwnDomain(hostOf(b.link) ?? '', searchableName) ? 0 : 1;
      return aOwn - bOwn;
    });
    const shortlist = candidates.slice(0, MAX_CANDIDATES);
    if (shortlist.length === 0) {
      done('no_match', { queries, reason: 'no candidate named the company' });
      return { outcome: 'no_match' };
    }

    // ── 3. Confirm ────────────────────────────────────────────────────────
    const confirmed = await confirmCandidate(searchableName, context, shortlist, run);
    const chosen =
      confirmed.confidence === 'high' && typeof confirmed.choice === 'number'
        ? shortlist[confirmed.choice - 1]
        : undefined;
    const homepage = chosen ? homepageOf(chosen.link) : null;
    if (!homepage) {
      done('no_match', {
        queries,
        candidates: shortlist.map((c) => c.link),
        confidence: confirmed.confidence ?? 'none',
      });
      return { outcome: 'no_match' };
    }

    // ── 4. Fetch ──────────────────────────────────────────────────────────
    const fetched = await fetchPage(homepage, run);
    if (!fetched) {
      // The address alone is worth having: it is what a CRM's domain field
      // wants, and a site that would not be scraped is still their site.
      done('fetch_failed', { queries, url: homepage });
      return { properties: { website: homepage }, outcome: 'fetch_failed' };
    }

    done('resolved', { queries, url: homepage, chars: fetched.content.length });
    return {
      properties: { website: homepage },
      edges: { fetchedUrl: emissionOf(fetched) },
      outcome: 'resolved',
    };
  },
};

// ── The steps ─────────────────────────────────────────────────────────────

async function planQueries(
  name: string,
  context: string,
  run: Record<string, unknown>,
): Promise<z.infer<typeof planSchema>> {
  try {
    return await anthropicChatStructured({
      system: PLANNER_SYSTEM,
      userMessage: `Name: ${name}\nContext: ${context}`,
      schema: planSchema,
      toolName: 'plan_searches',
      toolDescription: "Plan the searches that would find this company's own website.",
      model: 'claude-sonnet-5',
      label: 'plugin_web_research_plan',
    });
  } catch (error) {
    logger.warn(`${LOG} The query planner failed`, { name, error: describeError(error), ...run });
    return { queries: [], anchors: [] };
  }
}

async function confirmCandidate(
  name: string,
  context: string,
  candidates: SearchHit[],
  run: Record<string, unknown>,
): Promise<z.infer<typeof confirmSchema>> {
  const userMessage = [
    `Name: ${name}`,
    `Context: ${context}`,
    'Candidates:',
    ...candidates.map(
      (hit, i) =>
        `${i + 1}. ${hostOf(hit.link) ?? hit.link}\n   ${hit.title}\n   ${hit.snippet}`,
    ),
  ].join('\n');

  try {
    return await anthropicChatStructured({
      system: CONFIRM_SYSTEM,
      userMessage,
      schema: confirmSchema,
      toolName: 'confirm_website',
      toolDescription: "Say which candidate is this company's own site, or that none is.",
      model: 'claude-sonnet-5',
      label: 'plugin_web_research_confirm',
    });
  } catch (error) {
    logger.warn(`${LOG} The confirmation failed`, { name, error: describeError(error), ...run });
    return { choice: null, confidence: 'low' };
  }
}

/** The homepage through the shared fetch — the same plumbing, the same caps
 *  (HTML only, byte and character limits) a named fetch goes through. */
async function fetchPage(url: string, run: Record<string, unknown>) {
  try {
    const fetched = await fetchWithTimeout(url, null);
    if (!fetched?.content?.trim()) return null;
    return fetched;
  } catch (error) {
    logger.warn(`${LOG} The homepage failed to load`, { url, error: describeError(error), ...run });
    return null;
  }
}
