import { z } from 'zod';

import { MINUTE, SECOND } from '../constants';
import { Prompt } from '../lib/prompts';
import { anthropicChat } from '../lib/anthropic';
import { getEnvVar } from '../lib/utils/environment';
import { neverAsAny } from '../lib/utils/types';
import { logger } from './logger';
// Tavily is a legacy-only supplementary search (no DPA) — gated per-caller via
// `allowSupplementaryWebSearch`, which only the legacy pipelines pass.
import { webSearch as tavilySearch, isAvailable as tavilyAvailable } from '../lib/web_search';

// Google is discontinuing "search the entire web" in Programmable Search on
// 2027-01-01. Bright Data's SERP API returns Google's own results as JSON —
// same ranking, different transport — so it stands in as a second provider
// rather than a different search engine. Default stays `google` so an
// unset variable reproduces today's behaviour exactly.
export type WebSearchProvider = 'google' | 'brightdata';

export function resolveWebSearchProvider(env: NodeJS.ProcessEnv = process.env): WebSearchProvider {
  const value = env.WEB_SEARCH_PROVIDER ?? 'google';
  if (value === 'google' || value === 'brightdata') return value;
  throw new Error(
    `WEB_SEARCH_PROVIDER must be "google" or "brightdata" (got "${value}")`,
  );
}

// The SERP zone is provisioned separately from the Web Unlocker zone the page
// scraper uses (see scraper.ts's `missingBrightDataVars`) — a Bright Data
// account keeps one zone per product. The access token is shared.
function missingBrightDataSerpVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['BRIGHT_DATA_ACCESS_TOKEN', 'BRIGHT_DATA_SERP_ZONE'].filter((name) => !env[name]);
}

// SERP JSON is a few KB; these only guard a runaway or hung request, mirroring
// the ceilings scraper.ts holds a page fetch to. Against a live SERP zone,
// successful replies have arrived after as long as 65s, so the ceiling sits
// well past that rather than cutting off slow-but-good answers.
const BRIGHT_DATA_SERP_TIMEOUT = 90 * SECOND;
const MAX_BRIGHT_DATA_SERP_RESPONSE_BYTES = 1 * 1024 * 1024;

// A zone that times out, rate-limits or returns an empty body on one call
// usually answers the same query moments later; three tries covers that
// without turning one search into minutes of waiting.
const BRIGHT_DATA_SERP_MAX_ATTEMPTS = 3;
// Back-to-back retries kept failing the same way, so the zone gets a real
// cooldown between attempts rather than a short blip.
const BRIGHT_DATA_SERP_RETRY_DELAY = 15 * SECOND;
// A 429 (from the gateway or from Bright Data) asks us to slow down; retrying
// sooner only extends the limit.
const BRIGHT_DATA_SERP_RATE_LIMIT_RETRY_DELAY = 30 * SECOND;

// Verified against https://docs.brightdata.com/scraping-automation/serp-api/
// (2026-09-18): POST the target Google search URL through the SERP zone with
// `brd_json=1` in the query string, and the reply is Google's own parsed
// result set. Only the fields the callers below actually read are declared;
// everything else (`general`, `people_also_ask`, `knowledge`, …) passes
// through unparsed.
const BrightDataSerpOrganicResult = z.object({
  link: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});
const BrightDataSerpResponseShape = z.object({
  organic: z.array(BrightDataSerpOrganicResult),
});

/** Maps a parsed Bright Data reply onto the same `Search` shape the Google
 *  provider returns, so callers don't change. An `organic` array — even an
 *  empty one — is Google's own answer of "nothing found"; anything else
 *  (the key missing, the wrong type, an error envelope) is a shape this
 *  code doesn't understand, and fails rather than reading as "no results". */
function mapBrightDataSerpResponse(raw: unknown): Search {
  const parsed = BrightDataSerpResponseShape.safeParse(raw);
  if (!parsed.success) {
    const topLevelKeys =
      typeof raw === 'object' && raw !== null ? Object.keys(raw) : [];
    throw new Error(
      `Bright Data SERP response did not have the expected shape (top-level keys: ${
        topLevelKeys.length ? topLevelKeys.join(', ') : 'none'
      })`,
    );
  }

  const items: SearchResult[] = parsed.data.organic.map((hit) => ({
    link: hit.link,
    title: hit.title,
    snippet: hit.description,
  }));

  return { items };
}

/** The response body, read as a stream and abandoned at the cap — mirrors
 *  scraper.ts's `readCappedBytes`, sized down for a JSON reply rather than a
 *  whole page. */
async function readCappedText(response: Response): Promise<string> {
  if (!response.body) return response.text();

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  try {
    while (received < MAX_BRIGHT_DATA_SERP_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks, Math.min(received, MAX_BRIGHT_DATA_SERP_RESPONSE_BYTES)).toString(
    'utf8',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Pacing ─────────────────────────────────────────────────────────────────
//
// Bright Data throttles a SERP zone per target host once its success rate
// drops, and says so with a 429 naming the rate it will accept ("Please
// decrease your request rate to 14/min", measured in production). Sending
// faster than that does not get answers sooner: every refused request costs a
// 30-second wait and one of three attempts, and keeps the success rate low.
// So requests wait their turn here instead of being sent and refused.

export const BRIGHT_DATA_SERP_RATE_ENV_VAR = 'BRIGHT_DATA_SERP_PER_MINUTE';

export const DEFAULT_BRIGHT_DATA_SERP_PER_MINUTE = 14;

/** The rate, or the default when unset. Throws on a value that is set but is
 *  not a positive whole number — a typo here must not read as "no limit". */
export function parseBrightDataSerpPerMinute(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_BRIGHT_DATA_SERP_PER_MINUTE;
  const perMinute = Number(raw.trim());
  if (!Number.isInteger(perMinute) || perMinute <= 0) {
    throw new Error(
      `${BRIGHT_DATA_SERP_RATE_ENV_VAR}="${raw}" is not a positive whole number. ` +
        `Set it to how many Bright Data SERP requests this process may send per minute ` +
        `(e.g. ${BRIGHT_DATA_SERP_RATE_ENV_VAR}=${DEFAULT_BRIGHT_DATA_SERP_PER_MINUTE}), ` +
        `or leave it unset for the default of ${DEFAULT_BRIGHT_DATA_SERP_PER_MINUTE}.`,
    );
  }
  return perMinute;
}

/** Boot: refuse a malformed rate rather than letting the first search find out. */
export function assertBrightDataSerpRateConfigured(env: NodeJS.ProcessEnv = process.env): void {
  parseBrightDataSerpPerMinute(env[BRIGHT_DATA_SERP_RATE_ENV_VAR]);
}

/** Hands out turns so that no rolling minute holds more than `perMinute()` of
 *  them. Callers are served in arrival order; one that arrives when the minute
 *  is full waits until the oldest turn in it is a minute old. The rate is read
 *  at each turn, so a test (or an operator, on restart) moves it by env alone. */
export class RollingMinuteLimiter {
  private granted: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly perMinute: () => number) {}

  take(): Promise<void> {
    const turn = this.tail.then(() => this.waitForRoom());
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  private async waitForRoom(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.granted = this.granted.filter((at) => now - at < MINUTE);
      if (this.granted.length < this.perMinute()) {
        this.granted.push(now);
        return;
      }
      await sleep(this.granted[0] + MINUTE - now);
    }
  }
}

// One per process: every search in it — every run, every plugin — shares the
// zone's limit, so they share the queue too.
const brightDataSerpLimiter = new RollingMinuteLimiter(() =>
  parseBrightDataSerpPerMinute(process.env[BRIGHT_DATA_SERP_RATE_ENV_VAR]),
);

// What one attempt observed, for the per-attempt log line. Every field but
// `durationMs` is absent when the fetch itself rejected.
type BrightDataSerpAttemptTrace = {
  durationMs: number;
  status?: number;
  brdStatus?: string | null;
  brdError?: string | null;
  // Bright Data's machine-readable reason (`sr_rate_limit`, `verifying`, …),
  // which tells apart failures whose human-readable message is the same.
  brdErrorCode?: string | null;
  bytes?: number;
};

type BrightDataSerpAttemptOutcome =
  | ({ ok: true; search: Search } & BrightDataSerpAttemptTrace)
  | ({
      ok: false;
      retryable: boolean;
      // Whether this failure was a 429 at either layer; the retry loop waits
      // longer before the next attempt when it was.
      rateLimited: boolean;
      reason: string;
      error: Error;
    } & BrightDataSerpAttemptTrace);

/** Classifies an HTTP-style status code as a failure: 429 and 5xx are the
 *  zone under load and worth retrying; any other 4xx is a bad token, a
 *  disabled zone or a malformed request, which no retry will fix. */
function classifyFailureStatus(code: number): { retryable: boolean; rateLimited: boolean } {
  return { retryable: code === 429 || code >= 500, rateLimited: code === 429 };
}

/** One round-trip against the SERP endpoint, classified into an outcome the
 *  retry loop in `searchBrightData` can act on. Never throws: a fetch that
 *  rejects outright comes back as a retryable failure too. */
async function performBrightDataSerpAttempt(
  searchUrl: URL,
): Promise<BrightDataSerpAttemptOutcome> {
  const start = Date.now();
  let response: Response;
  try {
    response = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getEnvVar('BRIGHT_DATA_ACCESS_TOKEN')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        zone: getEnvVar('BRIGHT_DATA_SERP_ZONE'),
        url: searchUrl.toString(),
        format: 'raw',
      }),
      signal: AbortSignal.timeout(BRIGHT_DATA_SERP_TIMEOUT),
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const timedOut = error.name === 'AbortError' || error.name === 'TimeoutError';
    return {
      ok: false,
      retryable: true,
      rateLimited: false,
      reason: timedOut ? 'timed out' : `network error: ${error.message}`,
      error,
      durationMs: Date.now() - start,
    };
  }

  const brdStatus = response.headers.get('x-brd-status-code');
  const brdError = response.headers.get('x-brd-error');
  const brdErrorCode = response.headers.get('x-brd-error-code');
  const text = await readCappedText(response).catch(() => '');
  const trace: BrightDataSerpAttemptTrace = {
    durationMs: Date.now() - start,
    status: response.status,
    brdStatus,
    brdError,
    brdErrorCode,
    bytes: text.length,
  };

  // Bright Data answers HTTP 200 for a page it could not render (its own
  // selector wait timing out, or its own rate limit) and carries the real
  // outcome in `x-brd-status-code`, so that header decides first. Only when it
  // is absent or 2xx do the HTTP status and then the body decide.
  const brdStatusCode = brdStatus === null ? NaN : Number(brdStatus);
  if (Number.isFinite(brdStatusCode) && (brdStatusCode < 200 || brdStatusCode >= 300)) {
    const reason = `Bright Data reported ${brdStatusCode}${brdError ? `: ${brdError}` : ''}`;
    return {
      ok: false,
      ...classifyFailureStatus(brdStatusCode),
      reason,
      error: new Error(`Bright Data SERP request failed: ${reason}`),
      ...trace,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      ...classifyFailureStatus(response.status),
      reason: `HTTP ${response.status} ${response.statusText}`,
      error: new Error(
        `Bright Data SERP request failed: ${response.status} ${response.statusText}: ${text.slice(0, 200)}`,
      ),
      ...trace,
    };
  }

  let raw: unknown;
  try {
    raw = text.length ? JSON.parse(text) : undefined;
  } catch {
    raw = undefined;
  }
  if (raw === undefined) {
    return {
      ok: false,
      retryable: true,
      rateLimited: false,
      reason: `response was not JSON (${response.status}, ${text.length} bytes)`,
      error: new Error('Bright Data SERP response was not valid JSON'),
      ...trace,
    };
  }

  try {
    return { ok: true, search: mapBrightDataSerpResponse(raw), ...trace };
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      rateLimited: false,
      reason: `response was missing the organic array (${response.status}, ${text.length} bytes)`,
      error: err instanceof Error ? err : new Error(String(err)),
      ...trace,
    };
  }
}

interface ProfileSearchInput {
  name: string;
  description?: string | null;
  company?: string | null;
}

// A selection from https://github.com/googleapis/google-api-nodejs-client/blob/main/src/apis/customsearch/v1.ts
type Search = {
  items?: SearchResult[];
  searchInformation?: {
    formattedSearchTime?: string;
    formattedTotalResults?: string;
    searchTime?: number;
    totalResults?: string;
  } | null;
  spelling?: { correctedQuery?: string; htmlCorrectedQuery?: string } | null;
  url?: { template?: string; type?: string } | null;
};

type SearchResult = {
  link?: string | null;
  snippet?: string | null;
  title?: string | null;
};

// What Google sends in place of a `Search` when it refuses the request: a bad
// or restricted key, an unknown `cx`, an exhausted quota, or an API that is
// not enabled on the key's project. A genuine no-match never carries `error`;
// it is a `Search` with no `items`.
type SearchErrorBody = {
  error: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
};

function isSearchErrorBody(body: unknown): body is SearchErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  return typeof body.error === 'object' && body.error !== null;
}

class WebSearch {
  async search(query: string): Promise<Search> {
    const provider = resolveWebSearchProvider();
    switch (provider) {
      case 'google':
        return this.searchGoogle(query);
      case 'brightdata':
        return this.searchBrightData(query);
      default:
        return neverAsAny(provider);
    }
  }

  private async searchGoogle(query: string): Promise<Search> {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', getEnvVar('GOOGLE_CUSTOM_SEARCH_API_KEY', { devDefault: 'local' }));
    url.searchParams.set('cx', getEnvVar('GOOGLE_CX', { devDefault: 'local' }));
    url.searchParams.set('q', query);

    const response = await fetch(url);
    const body: unknown = await response.json().catch(() => undefined);

    // A refusal arrives either as a non-2xx status or, for at least the quota
    // case, as a 200 whose body is an error envelope. Neither has `items`, so
    // passing it on would read downstream as "nothing found".
    if (!response.ok || isSearchErrorBody(body)) {
      const error = isSearchErrorBody(body) ? body.error : undefined;
      const code = error?.code ?? response.status;
      const status = error?.status ?? response.statusText;
      const reason = error?.errors?.[0]?.reason;
      const message = error?.message ?? reason ?? response.statusText;

      logger.warn('[web_search] Google Custom Search refused the request', {
        status: code,
        reason,
        message,
        query,
      });

      throw new Error(
        `Google Custom Search refused the request (${code} ${status}): ${message}. ` +
          `Check GOOGLE_CUSTOM_SEARCH_API_KEY and GOOGLE_CX, and that the Custom Search JSON API is enabled on the key's Google Cloud project.`,
      );
    }

    return body as Search;
  }

  // Read lazily, same reason as scraper.ts's Bright Data path: importing this
  // module should never require the SERP zone to be provisioned.
  private async searchBrightData(query: string): Promise<Search> {
    const missing = missingBrightDataSerpVars();
    if (missing.length) {
      throw new Error(`Bright Data web search requires ${missing.join(' and ')} to be set`);
    }

    // The query text is the whole `q=` parameter, `site:` restriction and all
    // — the same string the Google provider would have received — so a
    // caller's existing `site:linkedin.com/in …` queries carry over unchanged.
    const searchUrl = new URL('https://www.google.com/search');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('brd_json', '1');

    const failures: string[] = [];
    for (let attempt = 1; ; attempt++) {
      // A retry is a request the zone counts like any other, so it queues too.
      await brightDataSerpLimiter.take();
      const outcome = await performBrightDataSerpAttempt(searchUrl);
      const trace = {
        attempt,
        durationMs: outcome.durationMs,
        status: outcome.status,
        brdStatus: outcome.brdStatus,
        brdError: outcome.brdError,
        brdErrorCode: outcome.brdErrorCode,
        bytes: outcome.bytes,
      };

      if (outcome.ok) {
        logger.info('[web_search] Bright Data SERP request', { ...trace, outcome: 'ok' });
        return outcome.search;
      }

      const isLastAttempt = attempt >= BRIGHT_DATA_SERP_MAX_ATTEMPTS;
      const willRetry = outcome.retryable && !isLastAttempt;
      logger.info('[web_search] Bright Data SERP request', {
        ...trace,
        outcome: willRetry ? 'retry' : 'failed',
        reason: outcome.reason,
      });

      if (!outcome.retryable) throw outcome.error;

      failures.push(`#${attempt} ${outcome.reason} (${outcome.durationMs}ms)`);
      if (isLastAttempt) {
        throw new Error(
          `Bright Data SERP request failed after ${attempt} attempts: ${failures.join('; ')}`,
        );
      }

      await sleep(
        outcome.rateLimited ? BRIGHT_DATA_SERP_RATE_LIMIT_RETRY_DELAY : BRIGHT_DATA_SERP_RETRY_DELAY,
      );
    }
  }

  /**
   * Notes:
   *  - we use Google search results to avoid Linkedin's bot detection
   *  - the search is restricted to the linkedin.com/in namespace
   *  - results are sorted by Google's relevance
   */
  async findLinkedIn(
    { name, description, company }: ProfileSearchInput,
    { allowSupplementaryWebSearch = false }: { allowSupplementaryWebSearch?: boolean } = {},
  ): Promise<SearchResult[]> {
    const query = `site:linkedin.com/in ${name}`;

    const oldCompanies = description
      ? await anthropicChat({
          model: 'claude-haiku-4-5-20251001',
          label: 'linkedin_previous_companies',
          system: `Your function is to output a company that someone used to work at.
      The input is a terse summary of someone's experience.
      Output a vbar-separated list of companies this person has worked at (e.g. "ex Facebook" -> "Facebook"). If there is one company, output just that company.
      Another example might be "ex Facebook, used to work at Google" -> "Facebook | Google".
      If you are not sure or there's not enough information, respond with "not sure".`,
          userMessage: description,
        }).then((response) =>
          response.toLowerCase().replace(/"/g, '') === 'not sure' ? null : response,
        )
      : null;

    // by ORing the current company with the previous companies, we handle stealth founders who
    // haven't updated their LinkedIn yet, and increase the chance of a correct match
    const companies = (oldCompanies ? `${company} | ${oldCompanies}` : company ?? '').replace(
      / (\| )?/g,
      ' OR ',
    );

    // Combine query by name and extended by company
    const parsed = await this.search(query);
    const specific = await this.search(`${query} ${companies}`);

    // Google CSE is the primary path. Legacy pipelines may additionally fall back
    // to Tavily for the rare person+company empty case — gated, because Tavily has
    // no DPA and must never run for a movement (which stays Google-CSE-only).
    let supplementaryItems: SearchResult[] = [];
    if (
      allowSupplementaryWebSearch &&
      (specific.items ?? []).length === 0 &&
      companies.trim() &&
      tavilyAvailable()
    ) {
      try {
        const tavilyResults = await tavilySearch(`${name} ${companies} site:linkedin.com/in`, 5);
        supplementaryItems = tavilyResults
          .filter((r) => /linkedin\.com\/in\//.test(r.url))
          .map((r) => ({ link: r.url, title: r.title, snippet: r.snippet }));
      } catch {
        // Tavily unavailable — continue with Google results only
      }
    }

    const items = (specific.items ?? [])
      .concat(supplementaryItems)
      .concat(parsed.items ?? []);

    if (!items.length) {
      return [];
    }

    const itemsText = items
      .map(
        (item, index) => `${index + 1}. name: ${item.title}
        snippet: ${item.snippet}`,
      )
      .join('\n');

    const response = await Prompt.matchSearchResult({
      company: company ?? '',
      name,
      description: description ?? '',
      items: itemsText,
    });

    const match = response.find((res) => res.is_match);

    if (match) {
      return [items[match.number - 1]];
    }

    return [];
  }

  async findTwitter({ name, company }: ProfileSearchInput) {
    const parsed = await this.search(`site:twitter.com ${name}`);

    if (!parsed.items || !parsed.items.length) {
      return;
    }

    const lowerCompany = company?.toLowerCase();
    const profilesMentioningCompany = parsed.items.filter(
      ({ snippet }) => lowerCompany && snippet?.toLowerCase().includes(lowerCompany),
    );

    return profilesMentioningCompany.concat(parsed.items)[0]?.link;
  }
}

const WebSearchService = new WebSearch();

export { WebSearchService };
