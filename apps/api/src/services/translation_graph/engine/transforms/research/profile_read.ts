// Reading the person behind a profile address — the one page neither engine
// can simply open.
//
// A profile address anchors identity: whoever holds it IS the person, so
// everything found afterwards is accepted only where it agrees with their own
// headline. But linkedin.com is closed. The shared scraper meets a login
// wall, and Anthropic's server fetcher refuses the host outright
// (`url_not_allowed`), so an engine that hands its loop to the model is blind
// to exactly the address that would settle who it is researching.
//
// So both engines read the profile the same way, in code, before they
// research anything: the search index first, because a profile's index entry
// carries the name, the headline and often the organisation; the profile
// service only when the index came back with nothing to check a later result
// against, because it is slow and paid for.
//
// One reading, shared — two readings would attribute the same page to two
// different people.

import type { ProfileIdentity } from '../linkedin_identity';
import type { SearchHit } from '../search_hygiene';

import { services } from '../../../../../adapters/registry';
import { SECOND } from '../../../../../constants';
import { logger } from 'movement-engine/services/logger';
import { describeError } from '../fetch_resource';
import { canonicalProfileUrl, isThin, matchesSlug, readTitle } from '../linkedin_identity';

/** Only spent when the index gave a thin headline, and it has to fit inside
 *  the wall clock alongside the searches. */
export const PROFILE_WAIT_MS = 75 * SECOND;

/** How much of the profile a prompt is shown. The answer is a few paragraphs;
 *  a whole career history buys nothing but tokens. */
export const PROFILE_EXCERPT_CHARS = 4000;

export interface ProfileRead {
  profileUrl: string;
  identity: ProfileIdentity;
  /** The profile's own text, when the index was thin and the service had it.
   *  Capped at `PROFILE_EXCERPT_CHARS`. */
  text: string | null;
}

/**
 * Who holds this profile, as far as anything outside LinkedIn can tell. Two
 * searches at most, and the profile service only on a thin index — the caller
 * owns the accounting, because a search costs a different engine a different
 * thing.
 */
export async function readProfile(args: {
  slug: string;
  search: (query: string) => Promise<SearchHit[]>;
  log: string;
  run: Record<string, unknown>;
}): Promise<ProfileRead> {
  const { slug, search, log, run } = args;
  const profileUrl = canonicalProfileUrl(slug);

  const identity: ProfileIdentity = { name: null, headline: null, role: null, organisation: null };
  for (const query of [profileUrl, `site:linkedin.com/in/${slug}`]) {
    const results = await search(query);
    const match = results.find((r) => matchesSlug(r.link, slug));
    if (!match) continue;
    Object.assign(identity, readTitle(match.title));
    logger.info(`${log} Identity from the index`, { slug, name: identity.name, ...run });
    break;
  }

  let text: string | null = null;
  if (isThin(identity) && services.linkedin) {
    try {
      const profile = await services.linkedin.getProfileTextByUrl(profileUrl, {
        maxWaitMs: PROFILE_WAIT_MS,
      });
      const read = profile?.text?.trim();
      if (read) {
        const lines = read.split('\n').map((l) => l.trim()).filter(Boolean);
        identity.name ??= lines[0] ?? null;
        identity.headline ??= lines[1] ?? null;
        identity.role ??= lines[1] ?? null;
        text = read.slice(0, PROFILE_EXCERPT_CHARS);
        logger.info(`${log} Read the profile`, { profileUrl, chars: read.length, ...run });
      }
    } catch (error) {
      logger.warn(`${log} The profile service failed`, {
        profileUrl,
        error: describeError(error),
        ...run,
      });
    }
  }

  return { profileUrl, identity, text };
}

/** The profile as a block of prompt: the address that anchors identity, what
 *  the index said about who holds it, and the profile's own words when they
 *  were read. */
export function describeProfile(read: ProfileRead): string {
  const { identity } = read;
  return [
    read.profileUrl,
    identity.name ? `Name: ${identity.name}` : null,
    identity.headline ? `Headline: ${identity.headline}` : null,
    identity.organisation ? `Organisation: ${identity.organisation}` : null,
    read.text ? `\nThe profile's own text:\n${read.text}` : null,
    !identity.name && !read.text ? 'Nothing could be read about who holds it.' : null,
  ]
    .filter((line): line is string => line != null)
    .join('\n');
}
