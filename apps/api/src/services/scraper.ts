import { backOff } from 'exponential-backoff';
import { htmlToText } from 'html-to-text';

import type { CostSource } from '../lib/run_cost';

import { SECOND } from '../constants';
import { logger } from './logger';
import { sendSlackNotification } from '../lib/slack';
import { Queue } from '../lib/utils/queue';
import { getEnvVar } from '../lib/utils/environment';
import { looksLikeNonHtmlAddress } from '../lib/utils/url';
import { assertRunBudget, reportRunCost } from '../lib/run_spend';

// Web Unlocker uses a dedicated zone, distinct from the LinkedIn Dataset API zone.
// The zone must be provisioned in the Bright Data dashboard under Web Unlocker.
// Docs: https://docs.brightdata.com/api-reference/rest-api/unlocker/unlock-website
// ScraperAPI replaced by Bright Data Web Unlocker

// Web Unlocker is synchronous and returns rendered HTML; concurrency can be higher
// than the Dataset API (which is async long-poll). Start at 10 and tune based on limits.
const rateLimitQueue = new Queue<string>({
  concurrency: 10,
});

const RETRY_LIMIT = 2;
const INITIAL_DELAY = 1 * SECOND;
const TIME_MULTIPLE = 4;
const RATE_LIMIT_DELAY = 60 * SECOND;
const FETCH_TIMEOUT = 90 * SECOND;
const MIN_CONTENT_LENGTH = 50;
// A client-rendered SPA's shell text is short even once fully loaded (nav +
// a loading notice); above this length, the page has real content whether or
// not JS ran, so it's not worth the extra billable render.
const SPA_SHELL_MAX_LENGTH = 300;
const JS_REQUIRED_NOTICE_PATTERN = /enable javascript|javascript is required|requires javascript/i;
const EMPTY_MOUNT_POINT_PATTERN = /<div\s+id=["'](?:root|app|__next)["']\s*>\s*<\/div>/i;

// A response body is held in memory whole, and ten scrapes run at once, so one
// large download is a peak-memory cost multiplied by the concurrency. Two
// megabytes is more HTML than any page whose text we would keep, and a body
// that reaches the cap is by definition not the thin page a JS render fixes.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// Everything downstream reads an excerpt, so text beyond this is carried,
// stored and paid for without ever being read.
const MAX_EXTRACTED_CHARS = 50_000;

// A binary file's first bytes give it away, and its extension usually does so
// before a request is even made. Both matter: `htmlToText` over a PDF returns
// pages of glyph noise that reads downstream as a real page.
const SNIFF_BYTES = 4096;
const MAX_CONTROL_BYTE_RATIO = 0.1;
const NON_HTML_CONTENT_TYPE_PATTERN =
  /^(?:image|video|audio|font)\/|^application\/(?:pdf|zip|x-zip|octet-stream\+|msword|vnd\.(?:ms-|openxmlformats-))/i;

// Legacy pipelines (dealflow + knowledge extraction) scrape via ScraperAPI;
// movements scrape via Bright Data Web Unlocker. The caller picks the provider —
// deliberately no default, so a new caller can't silently route a non-DPA
// sub-processor (ScraperAPI) into a movement's compliance-clean surface.
type ScrapeProvider = 'scraperapi' | 'brightdata';

// What a movement run is charged for Web Unlocker (`lib/run_spend.ts`). Bright
// Data bills it pay-as-you-go, per successful request, and a JS-rendered
// retry is a request of its own; a failed request is not billed. The figure is
// the pay-as-you-go list price of $1.50 per 1,000 requests — the response
// carries no price, so when the contract price changes, change it here.
const WEB_UNLOCKER_COST_SOURCE: CostSource = { kind: 'service', name: 'brightdata.web_unlocker' };
const WEB_UNLOCKER_MICRODOLLARS_PER_REQUEST = 1_500;

/** How many billable Web Unlocker requests one scrape made — counted where the
 *  request is answered, charged once the scrape returns to its caller. */
interface BilledRequests {
  count: number;
}

/** What one request came back with. `html` is empty when the body was not a
 *  page at all, and `truncated` says the download was stopped at the cap
 *  rather than ending — which is why a short text is not evidence of a page
 *  waiting on JavaScript. */
interface FetchedBody {
  html: string;
  truncated: boolean;
  /** Why this body is not a page, or null when it is one. */
  nonHtml: string | null;
}

async function fetchHtml(url: string, provider: ScrapeProvider, billed: BilledRequests): Promise<FetchedBody> {
  return provider === 'scraperapi'
    ? fetchHtmlScraperApi(url)
    : fetchHtmlBrightData(url, { render: false, billed });
}

// ScraperAPI (legacy pipelines). Key read lazily so importing this module never
// requires it — a scrape only fails if the key is genuinely missing at call time.
async function fetchHtmlScraperApi(url: string): Promise<FetchedBody> {
  const apiKey = getEnvVar('SCRAPER_API_KEY');
  const response = await fetch(
    `https://api.scraperapi.com/?api_key=${apiKey}&url=${url}&premium=true&render=true`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
  );

  if (!response.ok) {
    throw new Error(response.statusText);
  }

  return readCappedBody(response);
}

// Bright Data Web Unlocker response envelope (movements)
// POST https://api.brightdata.com/request
// Body: { zone, url, format: "raw" }
// Response body contains an HTML string (synchronous).
async function fetchHtmlBrightData(
  url: string,
  { render, billed }: { render: boolean; billed: BilledRequests },
): Promise<FetchedBody> {
  // Read Bright Data config lazily so importing this module never requires the
  // Web Unlocker zone to be provisioned — keeps tests and zone-less environments
  // loadable. A scrape only fails if the zone is genuinely missing at call time.
  const BRIGHT_DATA_ACCESS_TOKEN = getEnvVar('BRIGHT_DATA_ACCESS_TOKEN');
  const BRIGHT_DATA_UNLOCKER_ZONE = getEnvVar('BRIGHT_DATA_UNLOCKER_ZONE');
  const response = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BRIGHT_DATA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    // render is omitted (not sent as false) so the common, non-rendered path's
    // wire payload is unchanged from before this fallback existed.
    body: JSON.stringify({
      zone: BRIGHT_DATA_UNLOCKER_ZONE,
      url,
      format: 'raw',
      ...(render ? { render: true } : {}),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
  }

  billed.count += 1;
  return readCappedBody(response);
}

/**
 * The body, read as a stream and abandoned at the cap, so a hundred-megabyte
 * download is never held in memory to be thrown away afterwards. A body that
 * is not a page — the address said `.html` but the server sent a PDF, or Web
 * Unlocker forwarded a file — comes back empty with the reason attached.
 */
async function readCappedBody(response: Response): Promise<FetchedBody> {
  const declared = nonHtmlContentType(response.headers.get('content-type'));
  if (declared) {
    await response.body?.cancel().catch(() => undefined);
    return { html: '', truncated: false, nonHtml: declared };
  }

  const { bytes, truncated } = await readCappedBytes(response);
  const sniffed = nonHtmlSignature(bytes);
  if (sniffed) return { html: '', truncated, nonHtml: sniffed };
  return { html: bytes.toString('utf8'), truncated, nonHtml: null };
}

async function readCappedBytes(response: Response): Promise<{ bytes: Buffer; truncated: boolean }> {
  // A body-less response is a test double or an empty reply; either way there
  // is nothing to stream and `text()` is already bounded by what arrived.
  if (!response.body) {
    const text = await response.text();
    return { bytes: Buffer.from(text.slice(0, MAX_RESPONSE_BYTES), 'utf8'), truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  let ended = false;
  const reader = response.body.getReader();
  try {
    while (received < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      if (!value) continue;
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined);
  }

  return {
    bytes: Buffer.concat(chunks, Math.min(received, MAX_RESPONSE_BYTES)),
    truncated: !ended,
  };
}

/** Bright Data forwards the origin's content type on some responses and none
 *  on others, so this only rules a body out when the type positively names a
 *  binary family — anything vaguer is left to the signature sniff. */
function nonHtmlContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  return NON_HTML_CONTENT_TYPE_PATTERN.test(contentType.trim())
    ? `content-type ${contentType.trim()}`
    : null;
}

/** What the first bytes say the body is. Magic numbers first, then the general
 *  case: text of any encoding is almost free of control bytes, so a body full
 *  of them is a file however it was labelled. */
function nonHtmlSignature(bytes: Buffer): string | null {
  if (bytes.length === 0) return null;
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'a PDF';
  if (head.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') return 'a PNG';
  if (head.subarray(0, 3).toString('latin1') === '\xff\xd8\xff') return 'a JPEG';
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'a GIF';
  if (head.subarray(0, 4).toString('latin1') === 'PK\x03\x04') return 'a zip archive';

  let control = 0;
  for (const byte of head) {
    const printable = byte >= 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (!printable || byte === 0x7f) control += 1;
  }
  return control / head.length > MAX_CONTROL_BYTE_RATIO ? 'binary' : null;
}

async function enqueueQuery(fn: () => Promise<string>) {
  return rateLimitQueue.enqueue(async () => {
    return backOff(fn, {
      jitter: 'full',
      numOfAttempts: RETRY_LIMIT,
      startingDelay: INITIAL_DELAY,
      timeMultiple: TIME_MULTIPLE,
      retry: async (e, attempt) => {
        if (e instanceof Error && e.message.includes('429')) {
          // Rate limit
          logger.info(`Hit rate limit, waiting an additional ${RATE_LIMIT_DELAY / SECOND} seconds`);
          const jitterWidth = RATE_LIMIT_DELAY * 0.2;
          const jitter = (Math.random() - 0.5) * jitterWidth;
          await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY + jitter));
        } else if (e instanceof Error && e.message.includes('401')) {
          // Invalid API key
          return false;
        }

        if (attempt < RETRY_LIMIT) {
          logger.info(
            `Retrying query in ${
              (INITIAL_DELAY / SECOND) * TIME_MULTIPLE ** (attempt - 1)
            } seconds`,
            {
              error: e,
            },
          );
        }
        return true;
      },
    });
  });
}

function isReadableString(value: string): boolean {
  if (value.length < 20 || value.length > 50_000) return false;
  if (/^https?:\/\//.test(value)) return false;
  if (/[{};()=]/.test(value)) return false;
  const letterRatio = (value.match(/[a-zA-Z\s]/g)?.length ?? 0) / value.length;
  return letterRatio > 0.6;
}

function collectStrings(data: unknown): string[] {
  const results: string[] = [];

  function walk(node: unknown) {
    if (typeof node === 'string') {
      if (isReadableString(node)) {
        results.push(node);
      }
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node !== null && typeof node === 'object') {
      for (const value of Object.values(node)) walk(value);
    }
  }

  walk(data);
  return results;
}

function extractJsonScriptContent(html: string): string | null {
  // Try __NEXT_DATA__ first (Next.js), then any script[type=application/json]
  const patterns = [
    /<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/,
    /<script\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/g,
  ];

  const allStrings: string[] = [];

  for (const pattern of patterns) {
    if (pattern.global) {
      for (const match of Array.from(html.matchAll(pattern))) {
        try {
          const data = JSON.parse(match[1]);
          allStrings.push(...collectStrings(data));
        } catch {
          // skip unparseable
        }
      }
    } else {
      const match = html.match(pattern);
      if (match) {
        try {
          const data = JSON.parse(match[1]);
          // For __NEXT_DATA__, focus on pageProps
          const root = data.props?.pageProps ?? data.props ?? data;
          allStrings.push(...collectStrings(root));
        } catch {
          // skip unparseable
        }
      }
    }

    if (allStrings.length > 0) break;
  }

  if (allStrings.length === 0) return null;
  return allStrings.join('\n\n');
}

// A client-rendered SPA's shell HTML: short text either explicitly asking the
// visitor to enable JavaScript, or an empty div the framework mounts into once
// its bundle runs — neither of which a static (non-rendered) fetch populates.
function looksLikeSpaShell(html: string): boolean {
  const text = htmlToText(html).trim();
  if (text.length >= SPA_SHELL_MAX_LENGTH) return false;
  return JS_REQUIRED_NOTICE_PATTERN.test(text) || EMPTY_MOUNT_POINT_PATTERN.test(html);
}

// Whether a non-rendered Bright Data fetch is worth retrying with JS
// rendering, and why either way — a page that looked thin and was still not
// re-fetched has to say which guard stopped it, or the second billable call
// looks like it went missing.
function jsRenderDecision({
  text,
  html,
  truncated,
}: {
  text: string;
  html: string;
  truncated: boolean;
}): { retry: boolean; reason: string } {
  const thin =
    text.trim().length < MIN_CONTENT_LENGTH
      ? 'thin content'
      : looksLikeSpaShell(html)
        ? 'SPA shell'
        : null;
  if (!thin) return { retry: false, reason: 'the first pass has content' };
  // A body cut off at the cap is a large document, not a shell waiting on its
  // bundle: rendering it costs a second call to truncate the same file again.
  if (truncated) return { retry: false, reason: `${thin}, but the body hit the size cap` };
  return { retry: true, reason: thin };
}

/** The Web Unlocker variables a Bright Data scrape needs. Empty when it is
 *  configured. Answered rather than thrown, so a caller whose whole step
 *  depends on scraping can refuse honestly before spending anything — the
 *  scrape itself still raises at call time if it is reached unconfigured. */
function missingBrightDataVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['BRIGHT_DATA_ACCESS_TOKEN', 'BRIGHT_DATA_UNLOCKER_ZONE'].filter((name) => !env[name]);
}

class Scraper {
  async getWebsite(url: string, { provider }: { provider: ScrapeProvider }) {
    if (looksLikeNonHtmlAddress(url)) {
      logger.info('Address names a file rather than a page — not scraping', { url, provider });
      return '';
    }

    logger.info('Scraping URL', { url, provider });
    // Asked and charged here, in the caller's own async context — the queued
    // job may be started from another job's, and so from another run's.
    if (provider === 'brightdata') assertRunBudget();
    const billed: BilledRequests = { count: 0 };
    try {
      return await this.scrape(url, provider, billed);
    } finally {
      if (billed.count > 0) {
        reportRunCost({
          source: WEB_UNLOCKER_COST_SOURCE,
          microdollars: billed.count * WEB_UNLOCKER_MICRODOLLARS_PER_REQUEST,
        });
      }
    }
  }

  private scrape(url: string, provider: ScrapeProvider, billed: BilledRequests): Promise<string> {
    return enqueueQuery(async () => {
      const body = await fetchHtml(url, provider, billed);
      if (body.nonHtml) {
        logger.info('Scrape returned a body that is not a page', { url, reason: body.nonHtml });
        return '';
      }

      const scrapeResponse = body.html;
      let text = htmlToText(scrapeResponse);
      logger.info('Initial htmlToText extraction', {
        url,
        contentLength: text.trim().length,
      });

      // Bright Data's Web Unlocker only executes JavaScript when asked (it's a
      // second billable call), so a client-rendered page's empty shell needs a
      // deliberate retry. ScraperAPI already renders on every call.
      if (provider === 'brightdata') {
        const decision = jsRenderDecision({ text, html: scrapeResponse, truncated: body.truncated });
        if (decision.retry) {
          logger.info('Retrying with JavaScript rendering', { url, reason: decision.reason });
          const rendered = await fetchHtmlBrightData(url, { render: true, billed });
          const renderedText = rendered.nonHtml ? '' : htmlToText(rendered.html);
          if (renderedText.trim().length > text.trim().length) {
            text = renderedText;
          }
        } else {
          logger.info('Not retrying with JavaScript rendering', { url, reason: decision.reason });
        }
      }

      if (text.trim().length < MIN_CONTENT_LENGTH) {
        const scriptText = extractJsonScriptContent(scrapeResponse);
        if (scriptText && scriptText.trim().length >= MIN_CONTENT_LENGTH) {
          logger.info('Fell back to JSON script extraction', {
            url,
            contentLength: scriptText.trim().length,
          });
          text = scriptText;
        }
      }

      if (text.trim().length < MIN_CONTENT_LENGTH) {
        logger.warn('Scrape returned no meaningful content', { url });
        await sendSlackNotification({
          type: 'DEALFLOW',
          text: `Scrape returned no meaningful content for ${url}`,
          opsTitle: `Scrape returned no meaningful content for ${url}`,
        });
      }

      if (text.length > MAX_EXTRACTED_CHARS) {
        logger.info('Truncating extracted text', { url, chars: text.length });
        text = text.slice(0, MAX_EXTRACTED_CHARS);
      }

      return text;
    });
  }
}

const ScraperService = new Scraper();

export { ScraperService, looksLikeSpaShell, missingBrightDataVars };
