// The model's web tools: what a request declares, and how the reply reads back.
//
// On the two Claude doors search runs on the vendor's infrastructure: the
// request declares it, the model uses it inside one turn, and the reply carries
// a `server_tool_use` block per request plus a result block per answer. A page
// read runs there too where the provider serves it. Whatever the provider does
// not run itself is an ordinary client tool of the same name, which the web
// chat loop answers with a handler the caller supplied. Nothing here executes
// anything — this file declares the tools and reads the blocks; the loop next
// door does the work.
//
// Two shapes bite anyone reading those blocks for the first time:
//
//   - A FAILED server tool is still an HTTP 200. The failure is an error
//     OBJECT where the result would be, so a reader that assumes the search
//     result is a list silently treats "the search was rate-limited" as "the
//     search found nothing", and the model's answer looks merely unlucky.
//   - A search result IS a list and a fetch result is NOT: one search returns
//     many hits, one fetch returns one document. Both branch on the block's
//     own `type` rather than on whether it is an array.
//
// The blocks are read structurally rather than through the SDK's types: a tool
// version newer than the installed library still has to read back, and the
// Google client types its own reply separately. Reading the wire shapes keeps
// one reader for both.

import type Anthropic from '@anthropic-ai/sdk';
import type { Provider } from '../models/map';

import { neverAsAny } from '../utils/types';

/** The tool versions that filter results before they reach the context
 *  window. No beta header: they are generally available. */
export const WEB_SEARCH_TOOL_TYPE = 'web_search_20260209';
export const WEB_FETCH_TOOL_TYPE = 'web_fetch_20260209';

/** Vertex serves web search in its first version only. Its results read back
 *  through exactly the same blocks (one `web_search_tool_result` carrying
 *  either a list of hits or an error object), so nothing below branches on it. */
export const WEB_SEARCH_TOOL_TYPE_BASIC = 'web_search_20250305';

/** How much of a fetched page is worth carrying back to the caller. The model
 *  has already read the whole thing server-side; this is for the caller that
 *  wants to quote it. */
const FETCHED_TEXT_CHARS = 8000;

/**
 * How much of a fetched page is allowed into the model's own context
 * (`max_content_tokens` on the fetch tool — the server truncates past it).
 *
 * Uncapped, one large page is tens of thousands of tokens, and a server-side
 * loop re-reads every page it has already opened on every later iteration. A
 * production entry re-read 443k cached tokens across a single turn, which is
 * where its five and a half minutes went. A page answers the questions in its
 * first few thousand tokens or it is the wrong page.
 */
export const WEB_FETCH_MAX_CONTENT_TOKENS = 6000;

/**
 * Chars per token for a ceiling this file has to express in characters.
 *
 * Deliberately three rather than the familiar four: the four-chars-per-token
 * rule of thumb UNDERCOUNTS real tokens on the text we actually fetch (a
 * measured chat transcript came in four times over its estimate), and the cost
 * of erring low is a page cut a third short, while the cost of erring high is
 * the context blow-up this ceiling exists to prevent.
 */
const CHARS_PER_TOKEN = 3;

/** Who reads a page for the model.
 *
 *  `hosted` — Anthropic's own fetcher, inside its turn. Nothing to run here.
 *  `own`    — a client-side tool this codebase answers with its own page
 *             fetcher. It is not only the fallback where hosted fetch is
 *             missing: our fetcher renders JavaScript-heavy pages the hosted
 *             one returns empty, so a caller may prefer it anywhere. */
export type PageReader = 'hosted' | 'own';

/** What a provider serves when the caller expresses no preference. */
export function defaultPageReader(provider: Provider): PageReader {
  return hasHostedWebFetch(provider) ? 'hosted' : 'own';
}

/** One name for the page reader whichever side runs it, so a prompt written
 *  for one reads the same to the other. */
export const WEB_FETCH_TOOL_NAME = 'web_fetch';

/** One name for web search whichever side runs it, so a prompt written for
 *  one reads the same to the other. */
export const WEB_SEARCH_TOOL_NAME = 'web_search';

/** Whether the model can search the web itself on this provider. Only the two
 *  Claude doors run server tools at all; a translator has nothing to run one
 *  on, and would drop a server tool silently rather than refuse it. */
export function hasHostedWebSearch(provider: Provider): boolean {
  switch (provider) {
    case 'anthropic':
    case 'vertex':
      return true;
    case 'openai':
    case 'gemini':
      return false;
    default:
      return neverAsAny(provider);
  }
}

/** Search as this provider can run it: hosted, in whichever version the
 *  provider serves (both read back through identical blocks, so only the
 *  declaration differs), or the client-side tool the loop answers. */
function searchTool(provider: Provider, maxSearches: number): Anthropic.ToolUnion {
  switch (provider) {
    case 'anthropic':
      return { type: WEB_SEARCH_TOOL_TYPE, name: WEB_SEARCH_TOOL_NAME, max_uses: maxSearches };
    case 'vertex':
      return { type: WEB_SEARCH_TOOL_TYPE_BASIC, name: WEB_SEARCH_TOOL_NAME, max_uses: maxSearches };
    case 'openai':
    case 'gemini':
      return clientWebSearchTool({ maxSearches });
    default:
      return neverAsAny(provider);
  }
}

/** The client-side search, declared as an ordinary tool. Its budget is said out
 *  loud for the same reason the client page reader's is: nothing on the server
 *  enforces a `max_uses` for it. */
function clientWebSearchTool(options: { maxSearches: number }): Anthropic.ToolUnion {
  return {
    name: WEB_SEARCH_TOOL_NAME,
    description:
      'Search the web and get back a list of results, each with its title, address and a short ' +
      `excerpt. Search at most ${options.maxSearches} time(s) in this conversation. A search ` +
      'that fails comes back as an error; rephrase rather than repeat it.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, as you would type it.' },
      },
      required: ['query'],
    },
  };
}

/** The client-side page reader, declared as an ordinary tool: the model asks,
 *  the loop answers, and the model never learns which side ran it. Its budget
 *  is said out loud because a client tool has no `max_uses` for the server to
 *  enforce — the loop enforces it, and a model told the number does not spend
 *  a turn discovering it. */
function clientWebFetchTool(options: { maxFetches: number }): Anthropic.ToolUnion {
  return {
    name: WEB_FETCH_TOOL_NAME,
    description:
      'Read one web page and get its text back, with the markup stripped and long pages cut ' +
      `short. Read at most ${options.maxFetches} page(s) in this conversation. Only an address ` +
      'already in front of you — one the message gave you, or one a search returned. A page ' +
      'that will not open comes back as an error; do not ask for it again.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full address of the page to read.' },
      },
      required: ['url'],
    },
  };
}

/**
 * The tools one web chat request declares: search as the provider can run it,
 * plus whichever page reader the caller asked for. Server and client tools
 * travel in the same array.
 *
 * Vertex runs web search in its first version and does not run hosted web fetch
 * at all — a request that declares one is rejected — so asking for the hosted
 * reader there is refused here rather than at the vendor.
 */
export function webChatTools(options: {
  provider: Provider;
  pageReader: PageReader;
  maxSearches: number;
  maxFetches: number;
  maxFetchContentTokens: number;
}): Anthropic.ToolUnion[] {
  const { provider, pageReader, maxSearches, maxFetches, maxFetchContentTokens } = options;
  const search = searchTool(provider, maxSearches);
  switch (pageReader) {
    case 'hosted':
      if (!hasHostedWebFetch(provider)) {
        throw new Error(
          `Anthropic's hosted page reader does not exist on the ${provider} provider. Ask for the ` +
            "'own' page reader, which answers the model's page reads with our own fetcher.",
        );
      }
      return [
        search,
        {
          type: WEB_FETCH_TOOL_TYPE,
          name: WEB_FETCH_TOOL_NAME,
          max_uses: maxFetches,
          max_content_tokens: maxFetchContentTokens,
        },
      ];
    case 'own':
      return [search, clientWebFetchTool({ maxFetches })];
    default:
      return neverAsAny(pageReader);
  }
}

/** Whether the model can read a page itself on this provider. */
export function hasHostedWebFetch(provider: Provider): boolean {
  switch (provider) {
    case 'anthropic':
      return true;
    case 'vertex':
    case 'openai':
    case 'gemini':
      return false;
    default:
      return neverAsAny(provider);
  }
}

/** What one server tool did, in the caller's terms. A failure is an event of
 *  its own rather than an absence — "the search was rate-limited" and "the
 *  search found nothing" are different answers. */
export type WebToolEvent =
  | {
      kind: 'search';
      query: string | null;
      results: Array<{ url: string; title: string; pageAge: string | null }>;
    }
  | { kind: 'search_failed'; query: string | null; errorCode: string }
  | { kind: 'fetch'; url: string; retrievedAt: string | null; text: string }
  | { kind: 'fetch_failed'; url: string | null; errorCode: string };

// ── Reading the blocks ────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function errorCodeOf(content: unknown): string {
  return isRecord(content) ? (str(content.error_code) ?? 'unknown') : 'unknown';
}

/** The plain text of a fetched document, when it is text at all. A PDF comes
 *  back base64-encoded under a binary media type and is not worth decoding
 *  here — the model read it server-side, and the caller wants a quotable
 *  excerpt or nothing. */
function documentText(content: unknown): string {
  if (!isRecord(content)) return '';
  const source = content.source;
  if (!isRecord(source) || source.type !== 'text') return '';
  const data = str(source.data);
  return data ? data.slice(0, FETCHED_TEXT_CHARS) : '';
}

/**
 * Every server-tool request and its answer, in order, paired up by the
 * `tool_use_id` that links a result block back to the `server_tool_use` block
 * that asked for it — which is the only place the query text and the fetched
 * address appear.
 */
export function readWebToolEvents(content: readonly unknown[]): WebToolEvent[] {
  const asked = new Map<string, { name: string; query: string | null; url: string | null }>();
  const events: WebToolEvent[] = [];

  for (const block of content) {
    if (!isRecord(block)) continue;

    if (block.type === 'server_tool_use') {
      const id = str(block.id);
      const input = isRecord(block.input) ? block.input : {};
      if (id) {
        asked.set(id, {
          name: typeof block.name === 'string' ? block.name : '',
          query: str(input.query),
          url: str(input.url),
        });
      }
      continue;
    }

    const request = asked.get(str(block.tool_use_id) ?? '');

    if (block.type === 'web_search_tool_result') {
      const results = block.content;
      // A list is hits; anything else is the error object a failed search
      // returns inside a 200.
      if (Array.isArray(results)) {
        events.push({
          kind: 'search',
          query: request?.query ?? null,
          results: results.flatMap((hit) => {
            if (!isRecord(hit)) return [];
            const url = str(hit.url);
            return url
              ? [{ url, title: str(hit.title) ?? '', pageAge: str(hit.page_age) }]
              : [];
          }),
        });
      } else {
        events.push({
          kind: 'search_failed',
          query: request?.query ?? null,
          errorCode: errorCodeOf(results),
        });
      }
      continue;
    }

    if (block.type === 'web_fetch_tool_result') {
      const result = block.content;
      // Both outcomes are objects here — one fetch, one document — so the
      // branch is on the block's own type, never on its shape.
      if (isRecord(result) && result.type === 'web_fetch_result') {
        const url = str(result.url) ?? request?.url;
        if (url) {
          events.push({
            kind: 'fetch',
            url,
            retrievedAt: str(result.retrieved_at),
            text: documentText(result.content),
          });
          continue;
        }
      }
      events.push({
        kind: 'fetch_failed',
        url: request?.url ?? null,
        errorCode: errorCodeOf(result),
      });
    }
  }

  return events;
}

/** The text the model wrote, ignoring its thinking and its tool traffic. */
export function readAnswerText(content: readonly unknown[]): string {
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? [block.text]
        : [],
    )
    .join('');
}

// ── The client-side page reader ───────────────────────────────────────────
//
// What the model asks for, and what it is told back. The reading of the
// request and the shaping of the answer live here beside the hosted reader's,
// because the whole point is that a trace cannot tell which one ran: the same
// `fetch` / `fetch_failed` events, carrying the same fields.

/** What our own fetcher came back with. A failure is a VALUE rather than a
 *  rejection, because it has to reach the model as a failure — a page that
 *  would not open and a page that said nothing are different answers, and
 *  swallowing the difference sends the model back to the same dead address. */
export type PageFetchResult = { text: string } | { error: string };

/** Reads one page. The caller supplies it, so `lib/anthropic` never learns
 *  what a scraper is. */
export type PageFetcher = (url: string) => Promise<PageFetchResult>;

/** The error code a read or search refused for want of budget carries.
 *  Anthropic's own hosted tools use this exact code when a turn exceeds
 *  `max_uses`, so a trace reads the same either way. */
export const FETCH_BUDGET_SPENT = 'max_uses_exceeded';

/** How much of a page reaches the model, in characters, for a ceiling the
 *  caller expressed in tokens. */
export function pageTextCeiling(maxContentTokens: number): number {
  return maxContentTokens * CHARS_PER_TOKEN;
}

/** One page read the model asked for. `url` is null when it sent no address —
 *  a malformed call is answered rather than dropped, or the conversation
 *  stalls on a tool call nobody replied to. */
export interface PageRequest {
  id: string;
  url: string | null;
}

/** The client-side page reads in one assistant turn, in the order asked. */
export function readPageRequests(content: readonly unknown[]): PageRequest[] {
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'tool_use') return [];
    if (block.name !== WEB_FETCH_TOOL_NAME) return [];
    const id = str(block.id);
    if (!id) return [];
    const input = isRecord(block.input) ? block.input : {};
    return [{ id, url: str(input.url) }];
  });
}

/** A failure the model can act on: short, and never mistakable for a page. */
function toldAbout(errorCode: string): string {
  return errorCode === FETCH_BUDGET_SPENT
    ? 'Not read: this conversation has spent its whole page-reading budget. Answer with what you already have.'
    : `Not read: ${errorCode}. Do not ask for this address again — look elsewhere, or answer with what you have.`;
}

/** A failure reason fit for a tool result and a log line, out of whatever the
 *  fetcher threw. */
function shortReason(reason: string): string {
  const collapsed = reason.replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed.slice(0, 200) : 'unknown';
}

/**
 * One client-side page read, in the two shapes the loop needs: what the model
 * is told, and what the trace records. They are built together because they
 * are the same decision — a page that failed must not reach the model as empty
 * text, and must not reach the trace as an absence.
 */
export function pageFetchOutcome(options: {
  url: string | null;
  result: PageFetchResult;
  maxContentChars: number;
  retrievedAt: string;
}): { event: WebToolEvent; told: string; isError: boolean } {
  const { url, result, maxContentChars, retrievedAt } = options;

  if (url && 'text' in result) {
    const told = result.text.slice(0, maxContentChars);
    return {
      // The event's own excerpt is the caller's to quote and is capped the same
      // way the hosted reader's is, whatever the model was given.
      event: { kind: 'fetch', url, retrievedAt, text: told.slice(0, FETCHED_TEXT_CHARS) },
      told,
      isError: false,
    };
  }

  const errorCode = 'error' in result ? shortReason(result.error) : 'no_url';
  return { event: { kind: 'fetch_failed', url, errorCode }, told: toldAbout(errorCode), isError: true };
}

// ── The client-side search ────────────────────────────────────────────────
//
// The same arrangement as the page reader above: the model asks through an
// ordinary tool, the loop answers with a handler the caller supplied, and the
// trace records the same `search` / `search_failed` events a hosted search
// produces.

/** One result of our own search. */
export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

/** What our own search came back with. A failure is a value for the same
 *  reason a page read's is: "the search broke" and "the search found nothing"
 *  are different answers, and the model has to be told which. */
export type WebSearchResult = { hits: SearchHit[] } | { error: string };

/** Runs one search. The caller supplies it, so `lib/anthropic` never learns
 *  which search service a deployment has. */
export type WebSearcher = (query: string) => Promise<WebSearchResult>;

/** How many results one search hands the model. A results page is ten; more
 *  than that is scrolling, and the context pays for every line. */
const SEARCH_RESULTS_TOLD = 10;

/** One client-side search the model asked for. `query` is null when it sent
 *  none, and is answered rather than dropped, as a page read is. */
export interface SearchRequest {
  id: string;
  query: string | null;
}

/** The client-side searches in one assistant turn, in the order asked. */
export function readSearchRequests(content: readonly unknown[]): SearchRequest[] {
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'tool_use') return [];
    if (block.name !== WEB_SEARCH_TOOL_NAME) return [];
    const id = str(block.id);
    if (!id) return [];
    const input = isRecord(block.input) ? block.input : {};
    return [{ id, query: str(input.query) }];
  });
}

/** A failed search the model can act on. */
function toldAboutSearch(errorCode: string): string {
  return errorCode === FETCH_BUDGET_SPENT
    ? 'Not searched: this conversation has spent its whole search budget. Answer with what you already have.'
    : `Search failed: ${errorCode}. Rephrase it, or answer with what you have.`;
}

/**
 * One client-side search, as the model is told it and as the trace records it
 * — built together for the same reason a page read's are.
 */
export function searchOutcome(options: {
  query: string | null;
  result: WebSearchResult;
}): { event: WebToolEvent; told: string; isError: boolean } {
  const { query, result } = options;

  if (query && 'hits' in result) {
    const hits = result.hits.slice(0, SEARCH_RESULTS_TOLD);
    const told = hits.length
      ? hits.map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`).join('\n')
      : 'No results.';
    return {
      event: {
        kind: 'search',
        query,
        results: hits.map((hit) => ({ url: hit.url, title: hit.title, pageAge: null })),
      },
      told,
      isError: false,
    };
  }

  const errorCode = 'error' in result ? shortReason(result.error) : 'no_query';
  return {
    event: { kind: 'search_failed', query, errorCode },
    told: toldAboutSearch(errorCode),
    isError: true,
  };
}

/** How many server-tool requests Anthropic billed, as the reply reports them.
 *  Counted from the usage row rather than from the blocks: a request that
 *  produced no readable block was still made.
 *
 *  Only Anthropic's own tools appear here. A page read or search answered by
 *  our own handlers is not a server tool use and is counted by the loop
 *  instead — so this number answers "what was billed", never "was a page
 *  read" or "was the web searched". */
export function readServerToolCounts(usage: unknown): { searches: number; fetches: number } {
  const server = isRecord(usage) ? usage.server_tool_use : null;
  const count = (value: unknown) => (typeof value === 'number' ? value : 0);
  return isRecord(server)
    ? { searches: count(server.web_search_requests), fetches: count(server.web_fetch_requests) }
    : { searches: 0, fetches: 0 };
}
