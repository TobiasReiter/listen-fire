// Reading a person out of a LinkedIn address and out of what the index says
// about it — shared by every plugin that starts from a profile.
//
// The address is the identity anchor: whoever holds that profile IS the
// person, so there is no namesake problem at the first step. Everything after
// it is a namesake problem, and the terms this file reads out of the index
// entry — the name, the headline, the organisation — are what answers it. Two
// plugins reading a title differently would attribute the same page to two
// different people, so there is one reading.

const PROFILE_SLUG_REGEX = /^(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/in\/([^/?#\s]+)/i;

/** The slug the address anchors on, or null when it is not a profile address
 *  at all. A company page, a post, a bare name: nothing to research from. */
export function profileSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = PROFILE_SLUG_REGEX.exec(value.trim());
  if (!match) return null;
  const slug = decodeURIComponent(match[1]).trim();
  return slug ? slug : null;
}

export function canonicalProfileUrl(slug: string): string {
  return `https://www.linkedin.com/in/${slug}`;
}

export function isLinkedInLink(link: string): boolean {
  return /(?:^|\/\/|\.)linkedin\.com\//i.test(link);
}

export function matchesSlug(link: string, slug: string): boolean {
  const linked = profileSlug(link);
  return linked != null && linked.toLowerCase() === slug.toLowerCase();
}

/** Who a profile is, as far as anything outside LinkedIn can tell. */
export interface ProfileIdentity {
  name: string | null;
  headline: string | null;
  role: string | null;
  organisation: string | null;
}

/** Any of the separator characters an index has used to append its own name
 *  to a result title. */
const SEPARATOR_CHAR = /[|\-–—]/g;

/** Drops the site's own name off the end of an index title, whichever
 *  punctuation joined it and whichever locale it was localised to —
 *  "- LinkedIn", "– LinkedIn Norge", "| LinkedIn España". Structural, not a
 *  list of locale words: the LAST separator-delimited segment is dropped
 *  when THAT SEGMENT starts with "LinkedIn", whatever follows it. A title
 *  with no such segment is returned untouched. */
function stripLinkedInSuffix(title: string): string {
  const trimmed = title.trim();
  let lastSeparator = -1;
  for (const match of trimmed.matchAll(SEPARATOR_CHAR)) {
    lastSeparator = match.index;
  }
  if (lastSeparator < 0) return trimmed;
  const head = trimmed.slice(0, lastSeparator).trim();
  const tail = trimmed.slice(lastSeparator + 1).trim();
  if (!head || !/^LinkedIn\b/i.test(tail)) return trimmed;
  return head;
}

/** A LinkedIn result's title reads "Name - Headline - Organisation | LinkedIn"
 *  in most vintages, and something else in the rest, so this is best effort:
 *  the first segment is the name, whatever follows is the headline, and a
 *  third segment is the organisation often enough to be worth taking.
 *
 *  The site's own name is never one of those segments, whichever punctuation
 *  the index used to append it and whichever locale it localised it to —
 *  taking that last segment for an employer is how a research run ends up
 *  searching Crunchbase for "LinkedIn Norge". */
export function readTitle(title: string): ProfileIdentity {
  const stripped = stripLinkedInSuffix(title);
  const parts = stripped
    .split(/\s+[-–—]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const [name, ...rest] = parts;
  return {
    name: name ?? null,
    headline: rest.length ? rest.join(' - ') : null,
    role: rest[0] ?? null,
    organisation: rest.length > 1 ? rest[rest.length - 1] : null,
  };
}

/** Thin means the index told us nothing to check a search result against —
 *  no role and no organisation — which is exactly when the profile service
 *  is worth its wait. */
export function isThin(identity: ProfileIdentity): boolean {
  return !identity.role && !identity.organisation;
}
