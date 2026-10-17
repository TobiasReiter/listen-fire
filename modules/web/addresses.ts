// What an address says about itself before anything is fetched, and the
// record a fetched one becomes. Shared by every plugin here and by the
// platform's scraper, which declines a file address for the same reason the
// research plugin declines to queue one.

import type { FetchedResource } from './tools';

const NON_HTML_PATH_PATTERN = /\.(?:pdf|png|jpe?g|gif|webp|svg|zip|mp4|docx?|xlsx?|pptx?)$/i;

/** Whether the address itself says the target is a file rather than a page.
 *  Cheaper than learning it from the response, and the only way to learn it
 *  without paying for the fetch. */
export function looksLikeNonHtmlAddress(url: string): boolean {
  try {
    return NON_HTML_PATH_PATTERN.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// LinkedIn shows a login wall to anything arriving without a session, so a
// scrape of any LinkedIn address comes back as a hundred characters of "join
// to view" — after tens of seconds of rendering, and indistinguishable
// downstream from a page that was genuinely thin. The profile reader is the
// one mechanism that reads LinkedIn, and it reads people: a profile address
// goes to it, and every other LinkedIn address is known here to be
// unreadable, without spending a request to find out.
const LINKEDIN_HOST_REGEX = /^(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com(?:[/?#]|$)/i;
export const LINKEDIN_PROFILE_REGEX = /^(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/(?:pub|in|profile)\/([\w-]+)/i;

export function isLinkedInUrl(url: string): boolean {
  return LINKEDIN_HOST_REGEX.test(url);
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

/** One record a plugin hands back about something it made: its fields. */
export interface Emission {
  data: unknown;
}

/** The record a fetched page becomes: the link, a name, the downloaded file,
 *  and the text. One shape, so every plugin's emissions read identically
 *  downstream. */
export function emissionOf(r: FetchedResource): Emission {
  return { data: { name: r.url, url: r.url, file: r.file, text: r.content } };
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
