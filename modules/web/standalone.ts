// The tools a host other than the platform runs the web plugins with, built
// from what any host hands a module: its fetch, its credential and its log.
//
//   - Models: Anthropic, on the credential's `anthropicApiKey` (and
//     `anthropicBaseUrl` for another endpoint speaking the same API). Each
//     call is priced from the shared price table and reported on the answer,
//     since no meter of the host's sees it.
//   - Search: Bright Data's SERP zone (`brightDataAccessToken`,
//     `brightDataSerpZone`), one attempt per query.
//   - Pages: Bright Data's Web Unlocker (`brightDataAccessToken`,
//     `brightDataUnlockerZone`) when configured, else a plain GET — a local
//     host reads the open web as its user does.
//   - No profile reader, no gated-document browser and no document store: a
//     profile address or a document source (a deck host, a data room, a file
//     the platform keeps) fails, naming what is not available off the
//     platform; a page whose body is not HTML or text is not kept.
//
// `ctx.config.baseUrlOverride` stands in for api.brightdata.com and Anthropic
// alike, so a test serves both from one fake.

import type { WireCredentialDeclarationShape } from 'engine-contracts';
import type { ModuleContext } from 'module-kit';

import { z } from 'zod';
import type { ChatCall, ChatModelName } from 'movement-engine/public/anthropic';
import type { FetchedResource, SearchResult, WebTools } from './tools';

import { anthropicClient, anthropicKeyedChatProvider, type LlmUsage } from 'movement-engine/public/anthropic';
import { costMicrodollars, models } from 'movement-engine/public/anthropic';
import { FULLY_SUPPORTED_DOCUMENT_REGEXES, NOTION_REGEX } from '#shared/constants/document_sources';
import { isLinkedInUrl, looksLikeNonHtmlAddress } from './addresses';

const BRIGHT_DATA = 'https://api.brightdata.com';
const PAGE_CHAR_LIMIT = 50_000;
const PAGE_TIMEOUT_MS = 60_000;

/** The credential's fields the standalone tools read. Every one is optional:
 *  a plugin that needs none of them (fetching an open page) runs without. */
export const WEB_CREDENTIAL_FIELDS: WireCredentialDeclarationShape['fields'] = [
  { name: 'anthropicApiKey', label: 'Anthropic API key', optional: true },
  { name: 'anthropicBaseUrl', label: 'Anthropic base URL', secret: false, optional: true },
  { name: 'brightDataAccessToken', label: 'Bright Data access token', optional: true },
  { name: 'brightDataSerpZone', label: 'Bright Data SERP zone', secret: false, optional: true },
  { name: 'brightDataUnlockerZone', label: 'Bright Data Web Unlocker zone', secret: false, optional: true },
];

type Fields = Readonly<Record<string, string>>;

/** The addresses the platform reads through its document sources (a browser
 *  for gated decks and data rooms, a store that keeps the file). Canva's edit
 *  links are read as its view links there, so any design link is one. */
const DOCUMENT_SOURCES = [...FULLY_SUPPORTED_DOCUMENT_REGEXES, NOTION_REGEX, /^https:\/\/www\.canva\.com\/design\//];

export function isDocumentSourceAddress(url: string): boolean {
  return DOCUMENT_SOURCES.some((source) => source.test(url));
}

/** What this host cannot do that the platform does, as the refusal a plugin
 *  call fails with. */
export class NotAvailableOffPlatform extends Error {
  constructor(what: string, needs: string) {
    super(`@lf/web: ${what} needs ${needs}, which is not available off the platform`);
    this.name = 'NotAvailableOffPlatform';
  }
}

const PROFILE_READER = "the platform's LinkedIn profile reader";
const DOCUMENT_BROWSER = "the platform's gated-document browser and document store";

/** The fields, or none when the host connected no credential. */
async function fieldsOf(ctx: ModuleContext): Promise<Fields> {
  try {
    return await ctx.credential.fields();
  } catch {
    return {};
  }
}

export async function standaloneTools(ctx: ModuleContext): Promise<WebTools> {
  const fields = await fieldsOf(ctx);
  const brightData = ctx.config.baseUrlOverride ?? BRIGHT_DATA;
  let spent = 0;

  const models_ = anthropicClient({
    chatCallFor: (name) => anthropicCall(name, fields, ctx.config.baseUrlOverride),
    recordUsage: async (usage) => {
      spent += priced(usage) ?? 0;
    },
    logFields: () => ({}),
  });

  async function brightDataRequest(zone: string, url: string): Promise<Response> {
    return ctx.fetch(`${brightData}/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fields.brightDataAccessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone, url, format: 'raw' }),
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  }

  async function scrape(url: string): Promise<string> {
    if (looksLikeNonHtmlAddress(url)) return '';
    const zone = fields.brightDataUnlockerZone;
    const response =
      fields.brightDataAccessToken && zone
        ? await brightDataRequest(zone, url)
        : await ctx.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} fetching ${url}`);
    const type = response.headers.get('content-type') ?? '';
    if (type && !/html|text|xml|json/i.test(type)) {
      await response.body?.cancel().catch(() => undefined);
      return '';
    }
    return pageText(await response.text());
  }

  async function search(query: string): Promise<{ items: SearchResult[] }> {
    const zone = fields.brightDataSerpZone;
    if (!fields.brightDataAccessToken || !zone) {
      throw new Error('@lf/web: web search needs brightDataAccessToken and brightDataSerpZone on its credential');
    }
    const target = new URL('https://www.google.com/search');
    target.searchParams.set('q', query);
    target.searchParams.set('brd_json', '1');
    const response = await brightDataRequest(zone, target.toString());
    if (!response.ok) throw new Error(`Bright Data search failed: ${response.status} ${response.statusText}`);
    return { items: organicResults(await response.json()) };
  }

  return {
    log: ctx.log,
    logFields: () => ({}),
    models: {
      anthropicChat: models_.anthropicChat,
      anthropicChatStructured: models_.anthropicChatStructured,
      anthropicWebChat: models_.anthropicWebChat,
    },
    searchProvider: () => 'brightdata',
    search,
    async findLinkedIn({ name, company }) {
      const found = await search(`site:linkedin.com/in ${name}${company ? ` ${company}` : ''}`);
      return (found.items ?? []).filter((hit) => typeof hit.link === 'string' && /linkedin\.com\/in\//i.test(hit.link));
    },
    scrape,
    missingScraperSettings: () => [],
    profiles: {
      getProfileTextByUrl: async (url) => {
        throw new NotAvailableOffPlatform(`reading the LinkedIn profile ${url}`, PROFILE_READER);
      },
    },
    isDocumentSource: isDocumentSourceAddress,
    async fetchResource(url): Promise<FetchedResource | null> {
      if (isLinkedInUrl(url)) throw new NotAvailableOffPlatform(`reading the LinkedIn profile ${url}`, PROFILE_READER);
      if (isDocumentSourceAddress(url)) throw new NotAvailableOffPlatform(`reading the document at ${url}`, DOCUMENT_BROWSER);
      let content = await scrape(url);
      if (!content || content.trim().length < 50) return null;
      if (content.length > PAGE_CHAR_LIMIT) content = content.slice(0, PAGE_CHAR_LIMIT);
      return { url, content, file: null };
    },
    // Nothing here stores a document, so no handle is ever handed out.
    fileValues: async (handles) => handles.map(() => undefined),
    spentMicrodollars: () => spent,
  };
}

function anthropicCall(name: ChatModelName, fields: Fields, baseUrlOverride: string | undefined): ChatCall {
  const apiKey = fields.anthropicApiKey;
  if (!apiKey) throw new Error('@lf/web: a model call needs anthropicApiKey on its credential');
  const { home } = models[name];
  if (home !== 'anthropic') throw new Error(`@lf/web: model "${name}" is served by ${home}; this host calls only Anthropic`);
  const baseUrl = baseUrlOverride ?? fields.anthropicBaseUrl;
  return {
    client: anthropicKeyedChatProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
    wireModel: name,
    resolved: { preferred: name, provider: 'anthropic', wireModel: name },
  };
}

function priced(usage: LlmUsage): number | undefined {
  return costMicrodollars(`${usage.resolved.provider}/${usage.resolved.wireModel}`, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
  });
}

// Only the fields read here are declared; the rest of Google's parsed result
// set passes through unread.
const SerpReply = z.object({
  organic: z.array(z.object({ link: z.string().optional(), title: z.string().optional(), description: z.string().optional() })),
});

function organicResults(body: unknown): SearchResult[] {
  const parsed = SerpReply.safeParse(body);
  if (!parsed.success) throw new Error('Bright Data search answered without an organic result list');
  return parsed.data.organic.map((hit) => ({ link: hit.link ?? null, title: hit.title ?? null, snippet: hit.description ?? null }));
}

/** A page's readable text: scripts, styles and tags dropped, entities read,
 *  whitespace folded. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}
