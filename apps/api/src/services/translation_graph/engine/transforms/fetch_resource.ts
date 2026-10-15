// One URL → one fetched resource, shared by the two retrieval plugins.
//
// `vc-url-retrieval` scans a message and fetches everything it decides is
// worth fetching; `fetch-url` fetches the one link an author named. What
// happens to a single URL once something has decided to fetch it is the same
// either way — the gated-document path, the profile path, the plain scrape —
// so it lives here rather than in whichever plugin was written first.

import type { FetchedSegment } from './url-fetch';
import type { ResourceId } from '../../../../generated/kysely/knowledge/Resource';
import type { EphemeralEmission } from './registry';

import { DocumentSourceService } from '../../../../lib/document_sources';
import { runFields } from '../../../../lib/llm_usage';
import { isBudgetExhausted } from 'movement-engine/lib/run_cost';
import { logger } from 'movement-engine/services/logger';
import { RawTextService } from '../../../raw_text';
import { ResourceService } from '../../../resource';
import { ScraperService } from '../../../scraper';
import { fetchLinkedInProfile, fetchPitchDeckUrl, isLinkedInUrl } from './url-fetch';

// Per-URL backstop. The Playwright queue has its own 5-min wall-clock
// timeout for browser sessions, so this needs to be longer than that
// to let the in-browser timeout fire first with proper cleanup.
const FETCH_URL_TIMEOUT_MS = 7 * 60 * 1000;

export interface FetchedResource {
  url: string;
  /** Empty when the fetch downloaded a document none of whose text could be
   *  read — the document itself still rides on `documentId`. */
  content: string;
  rawTextId: string | null;
  resourceId: ResourceId;
  /** Document id when the fetch produced a binary artefact (PDFs, etc.).
   *  Null otherwise. Carried into the ephemeral record's `file` field. */
  documentId: string | null;
}

async function toFetchedResource(
  url: string,
  fetched: FetchedSegment | null,
): Promise<FetchedResource | null> {
  if (!fetched) return null;
  if (!fetched.rawTextId) {
    if (!fetched.documentId) return null;
    return {
      url,
      content: '',
      rawTextId: null,
      resourceId: fetched.resourceId,
      documentId: fetched.documentId,
    };
  }
  const rawText = await RawTextService.getById(fetched.rawTextId);
  return {
    url,
    content: rawText.content,
    rawTextId: fetched.rawTextId,
    resourceId: fetched.resourceId,
    documentId: fetched.documentId,
  };
}

async function fetchUrlInner(
  url: string,
  email: string | null,
  password?: string | null,
): Promise<FetchedResource | null> {
  const isSupported = DocumentSourceService.isSupportedUrl(url);

  try {
    if (isSupported) {
      const fetched = await fetchPitchDeckUrl({ url, email, password: password ?? null });
      return toFetchedResource(url, fetched);
    }

    // Every LinkedIn address goes to the profile service and none of them to
    // the scraper — a scrape of LinkedIn returns its login wall, which reads
    // downstream as a real but useless page. Where the profile service has
    // nothing to offer (an address that is not a person, or no service
    // configured) the answer is nothing, decided without a request.
    if (isLinkedInUrl(url)) {
      const fetched = await fetchLinkedInProfile(url);
      return toFetchedResource(url, fetched);
    }

    let content = await ScraperService.getWebsite(url, { provider: 'brightdata' });
    if (!content || content.trim().length < 50) return null;
    if (content.length > 50000) content = content.slice(0, 50000);

    const rawText = await RawTextService.getOrCreateFromContent(content);
    const resource = await ResourceService.getOrCreate({
      type: 'URL',
      name: url,
      url,
      rawTextId: rawText.id,
      retrievedAt: new Date(),
      isDemo: false,
      isPrivate: true,
    });

    return {
      url,
      content,
      rawTextId: rawText.id,
      resourceId: resource.id as ResourceId,
      documentId: null,
    };
  } catch (e) {
    // A run out of budget is not a page that failed to load.
    if (isBudgetExhausted(e)) throw e;
    logger.warn('[transform:fetch-resource] Failed to fetch URL', {
      url,
      error: describeError(e),
      ...runFields(),
    });
    return null;
  }
}

/** Winston's `format.simple()` serialises meta fields with plain JSON, and an
 *  `Error`'s message/stack aren't enumerable — so `{ error: e }` logs as `{}`.
 *  Render the message + stack explicitly so a failure is legible. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`;
  return typeof e === 'string' ? e : safeStringifyError(e);
}

function safeStringifyError(e: unknown): string {
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export async function fetchWithTimeout(
  url: string,
  email: string | null,
  password?: string | null,
): Promise<FetchedResource | null> {
  // Read at scheduling time rather than inside the timer callback: whichever
  // run is waiting on this fetch is the run that started it.
  const run = runFields();
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => {
      logger.warn('[transform:fetch-resource] Per-URL timeout exceeded — abandoning', {
        url,
        timeoutMs: FETCH_URL_TIMEOUT_MS,
        ...run,
      });
      resolve(null);
    }, FETCH_URL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fetchUrlInner(url, email, password), timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/** The ephemeral record a fetched page becomes: the link, a name, the
 *  downloaded file, and the text. One shape, so both plugins' emissions read
 *  identically downstream. */
export function emissionOf(r: FetchedResource): EphemeralEmission {
  return { data: { name: r.url, url: r.url, file: r.documentId, text: r.content } };
}

/** A web-address field is as likely to hold `acme.com` as `https://acme.com`,
 *  so a bare host gets the scheme a discovered bare domain would have got.
 *  A value that is blank, missing, or not text at all is nothing to load. */
export function normaliseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
