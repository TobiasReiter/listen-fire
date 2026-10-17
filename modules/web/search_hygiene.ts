// Query hygiene, shared by the plugins that go looking for something on the
// open web.
//
// Both of them face the same failure: a query with nothing distinctive in it
// searches for the topic rather than for the subject, so every result belongs
// to somebody else, and a result accepted on a name alone attaches a
// stranger's page to the record. The rules that stop that are not
// plugin-specific — an anchor is an anchor — so they live here and each
// plugin decides only what its own anchors ARE.

import { describeError } from './addresses';
import { logger, tools } from './tools';

export type SearchHit = { title: string; snippet: string; link: string };

/** What people write where an employer would go. Anchoring a search on one of
 *  these searches for the placeholder rather than for a company: "Stealth
 *  Startup" is thousands of unrelated people's answer to the same question, so
 *  every result is a namesake and every page fetched is wasted. Kept short and
 *  literal — a longer list starts discarding real companies. */
const PLACEHOLDER_ORGANISATIONS = new Set([
  'stealth',
  'stealth startup',
  'stealth mode',
  'confidential',
  'self employed',
  'independent',
  'freelance',
  'n/a',
  // Not an employer at all: it is the trailing segment of a LinkedIn index
  // title, and reading it as a company sends every query after the site
  // rather than after the person.
  'linkedin',
]);

/** The organisation as something to search for, or null when the name is a
 *  placeholder rather than an organisation. */
export function distinctiveOrganisation(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const normalised = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, ' ')
    .trim();
  if (!normalised) return null;
  // "Stealth", "Stealth Startup", "Stealth mode company" — one non-answer.
  if (normalised.startsWith('stealth')) return null;
  // "LinkedIn", "LinkedIn Norge", "LinkedIn España" — a locale word tacked on
  // the site's own name is still the site's own name, never an employer.
  // Defense in depth: `readTitle` (linkedin_identity.ts) already strips this
  // segment off a search-index title before it gets here.
  if (normalised.startsWith('linkedin')) return null;
  return PLACEHOLDER_ORGANISATIONS.has(normalised) ? null : trimmed;
}

/** The terms that make a query, or a result, about THIS subject rather than
 *  about its topic in general. Each plugin builds its own list; what they
 *  share is what having one means. */
export type Anchors = string[];

export function containsAnchor(text: string, anchors: Anchors): boolean {
  const haystack = text.toLowerCase();
  return anchors.some((term) => haystack.includes(term.toLowerCase()));
}

/** The acceptance rule, applied where it can be applied mechanically: a page
 *  about some other subject of the same name is a namesake by another route.
 *  With no terms to check against there is nothing to reject on — the caller's
 *  own gate is what stands then. */
export function isConsistent(hit: SearchHit, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${hit.title} ${hit.snippet}`.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

/** One search against the index, as hits. A failed search is no hits rather
 *  than a failed run: a plugin that found nothing attaches nothing, which is
 *  already the honest answer for a subject with no public signal. */
export async function runSearch(
  query: string,
  log: string,
  run: Record<string, unknown>,
): Promise<SearchHit[]> {
  try {
    const results = await tools().search(query);
    const hits = (results.items ?? []).flatMap((item) =>
      item.link ? [{ title: item.title ?? '', snippet: item.snippet ?? '', link: item.link }] : [],
    );
    logger.info(`${log} Searched`, { query, results: hits.length, ...run });
    return hits;
  } catch (error) {
    logger.warn(`${log} A search failed`, { query, error: describeError(error), ...run });
    return [];
  }
}

// ── Where a hit points, and whether it could be the subject's own page ─────
//
// Reading a host out of a link, preferring a company's own domain to a
// directory that lists every company there is, quoting a name so the index
// reads it as a phrase: three rules about search RESULTS rather than about
// any one subject, so they sit beside the rules about queries.

/** Sites that name every company there is. A hit on one of them says the name
 *  exists, which was never in doubt — the question is which site is the
 *  subject's OWN, and none of these is. Directories, app stores, social
 *  networks, encyclopaedias and the startup press, which between them account
 *  for most of what a search for a young company returns. */
export const AGGREGATOR_DOMAINS = [
  'linkedin.com',
  'crunchbase.com',
  'pitchbook.com',
  'dealroom.co',
  'tracxn.com',
  'cbinsights.com',
  'theorg.com',
  'wikipedia.org',
  'wikidata.org',
  'apps.apple.com',
  'play.google.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'tiktok.com',
  'reddit.com',
  'medium.com',
  'substack.com',
  'github.com',
  'glassdoor.com',
  'indeed.com',
  'bloomberg.com',
  'techcrunch.com',
  'sifted.eu',
  'eu-startups.com',
  'businesswire.com',
  'prnewswire.com',
  'producthunt.com',
];

export function isAggregator(host: string): boolean {
  return AGGREGATOR_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** The host a link points at, lower-cased and stripped of `www.`, or null when
 *  the string is not an address at all. */
export function hostOf(link: string): string | null {
  try {
    return new URL(link).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** The site root, which is what a CRM's domain field wants and what is worth
 *  reading about a company — a search may well land on a blog post. */
export function homepageOf(link: string): string | null {
  try {
    const url = new URL(link);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** Whether the host reads as the subject's own: the name, or a substantial
 *  word of it, is in the domain. A preference rather than a requirement —
 *  plenty of companies trade under a domain that spells something else — so it
 *  ranks candidates instead of rejecting them. */
export function looksLikeOwnDomain(host: string, name: string): boolean {
  const compactHost = host.replace(/[^a-z0-9]/g, '');
  const compactName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compactName.length >= 4 && compactHost.includes(compactName)) return true;
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4)
    .some((token) => compactHost.includes(token));
}

/** The name as an exact phrase. The index reads a quoted name as the phrase it
 *  is and an unquoted one as a bag of ordinary words, and for a young company
 *  that is the difference between its own site and ten pages about the word.
 *  Enforced here rather than trusted to a planner. */
export function asExactPhrase(query: string, name: string): string {
  if (query.includes(`"${name}"`)) return query;
  const at = query.toLowerCase().indexOf(name.toLowerCase());
  if (at < 0) return `"${name}" ${query}`;
  const head = query.slice(0, at);
  const found = query.slice(at, at + name.length);
  return `${head}"${found}"${query.slice(at + name.length)}`;
}

/** Append a hit unless its address is already held. Returns whether it is new,
 *  so the caller can decide about fetching exactly once per address. */
export function addHit(hits: SearchHit[], hit: SearchHit): boolean {
  if (hits.some((h) => h.link === hit.link)) return false;
  hits.push(hit);
  return true;
}

// ── Is there anything here to search on at all? ────────────────────────────

/** Words that appear in any sentence about anything. A context made only of
 *  these says nothing about WHICH subject of that name, so a query built on
 *  it searches for the topic. Deliberately short: a longer list starts
 *  discarding the sector words that are exactly what anchors a query. */
const UNDISTINCTIVE_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'its', 'new', 'of', 'on', 'or', 'that', 'the', 'their',
  'they', 'this', 'to', 'was', 'were', 'with', 'company', 'startup', 'business',
  'app', 'platform', 'team', 'people', 'thing', 'stuff',
]);

/**
 * The words in `context` that could tell THIS subject apart from another of
 * the same name: a city, a sector, a product, a person. The subject's own name
 * is not one of them — it is what they have in common.
 *
 * The gate this feeds is the one that decides whether an entry is worth
 * spending anything on, so it is deliberately mechanical: a model asked
 * whether a line is distinctive will always find something to say.
 */
export function distinctiveContextTerms(context: string, name: string): string[] {
  const nameTokens = new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const seen = new Set<string>();
  return context
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => {
      if (word.length < 3) return false;
      if (nameTokens.has(word) || UNDISTINCTIVE_WORDS.has(word)) return false;
      if (distinctiveOrganisation(word) === null) return false;
      if (seen.has(word)) return false;
      seen.add(word);
      return true;
    });
}
