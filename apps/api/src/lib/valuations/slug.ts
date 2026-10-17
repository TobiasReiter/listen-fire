// Minting a legal entity's URL slug.
//
// `legal_entity.slug` is what the app addresses a company by
// (`/portfolio/c/[slug]`), and a row without one is not merely ugly — it is
// UNREACHABLE. The deals table renders its link as
// `row.company?.slug ? … : null`, so a null slug silently produces a dead row
// rather than an error anyone would notice.
//
// The REST create takes `slug` as an optional caller-supplied field, so every
// caller that is not the UI — an automation, a script, an integration — used
// to create companies nobody could click. Minting here, on the way in, is the
// one place that fixes all of them at once.

import { randomBytes } from 'node:crypto';

import type { Kysely } from 'kysely';

import { slugify } from 'movement-engine/public/text';

/**
 * A slug for `name` that is actually free, or undefined when `name` slugifies
 * to nothing at all (a name of pure punctuation — rare, but a company called
 * "!!!" should not become a row with an empty-string slug).
 *
 * `legal_entity_slug_key` is unique GLOBALLY, not per team, so a slug free for
 * this team can still collide with another team's row. Hence the probe rather
 * than a bare `slugify`, and a short random suffix on collision.
 *
 * This narrows the race but does not close it: two concurrent creates can both
 * probe clear and then both insert. The unique index is the real guard — the
 * loser gets a constraint violation, which is the correct outcome for a
 * duplicate and is surfaced as such.
 */
async function mintUniqueSlug(
  qb: Kysely<any>,
  name: string,
  options: { excludeId?: string } = {},
): Promise<string | undefined> {
  const base = slugify(name);
  if (base === '') return undefined;

  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
    let query = qb.selectFrom('legal_entity').where('slug', '=', candidate).select(['id']);
    if (options.excludeId !== undefined) query = query.where('id', '!=', options.excludeId);
    const collision = await query.executeTakeFirst();
    if (!collision) return candidate;
  }
  throw new Error(`Could not mint a unique slug for '${name}' after 10 attempts`);
}

export { mintUniqueSlug };
