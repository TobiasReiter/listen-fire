/**
 * The STORY LINK — a movement's picture, addressable by anyone holding the URL.
 *
 * The asks idiom, exactly: the token IS the authorisation, the route that
 * serves it is mounted before the auth middleware, and the page it opens
 * touches no credential. What it grants is deliberately narrow — a read of one
 * movement's story, projected fresh on every hit, and nothing else.
 *
 * One durable token per movement, minted the first time someone asks for the
 * link and reused ever after, so the link an agent hands out today is the link
 * it hands out tomorrow. No expiry: what the page shows is what the automation
 * currently does, which does not go stale on a clock. Revoking is explicit
 * (`revoked_at`), and deleting the automation takes the link with it.
 *
 */

import { randomBytes } from 'node:crypto';

import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../../lib/kysely';
import { getEnvVar } from '../../../lib/utils/environment';

/** Prefixed like the ask token, and for the same reason: a route can tell what
 *  kind of capability it was handed before it queries anything. */
export const STORY_TOKEN_PREFIX = 'story_';

export interface StoryTokenTarget {
  movementId: string;
  teamId: string;
}

/**
 * The link a movement's story is served on, minted lazily.
 *
 * Idempotent by intent rather than by constraint: a live token is reused, and
 * only a movement that has none (or whose only tokens were revoked) mints one.
 * The race — two readers minting at once — costs an extra row, and both links
 * work; a unique index over (movement_id) would instead have made revocation
 * mean "this movement can never be shared again".
 */
export async function storyTokenForMovement(input: {
  teamId: string;
  movementId: string;
}): Promise<string> {
  const existing = await getAutomationsQb(['movement_story_token'])
    .selectFrom('movement_story_token')
    .where('movement_id', '=', input.movementId as MovementId)
    .where('revoked_at', 'is', null)
    .select(['token'])
    .orderBy('created_at', 'asc')
    .executeTakeFirst();
  if (existing) return existing.token;

  const token = STORY_TOKEN_PREFIX + randomBytes(24).toString('base64url');
  await getAutomationsQb(['movement_story_token'])
    .insertInto('movement_story_token')
    .values({
      movement_id: input.movementId as MovementId,
      team_id: input.teamId as TeamId,
      token,
    })
    .execute();
  return token;
}

/**
 * The same lazy mint as `storyTokenForMovement`, for a whole list at once —
 * the list surface's shape, where minting one row at a time would cost one
 * round-trip per movement. One query for every live token across the given
 * movements, then one insert for whichever movements came back with none.
 *
 * Same race as the single-movement mint (two readers minting at once costs an
 * extra row, and both links work) — batching doesn't change that trade-off,
 * only the number of round-trips it takes.
 */
export async function storyTokensForMovements(
  targets: StoryTokenTarget[],
): Promise<Map<string, string>> {
  const byMovement = new Map<string, string>();
  if (targets.length === 0) return byMovement;

  const ids = [...new Set(targets.map((t) => t.movementId))];
  const existing = await getAutomationsQb(['movement_story_token'])
    .selectFrom('movement_story_token')
    .where('movement_id', 'in', ids as MovementId[])
    .where('revoked_at', 'is', null)
    .select(['movement_id', 'token', 'created_at'])
    .orderBy('created_at', 'asc')
    .execute();
  // Earliest live token per movement wins, same tie-break as the single mint.
  for (const row of existing) {
    if (!byMovement.has(row.movement_id)) byMovement.set(row.movement_id, row.token);
  }

  const missing = targets.filter((t) => !byMovement.has(t.movementId));
  if (missing.length > 0) {
    const minted = missing.map((t) => ({
      movement_id: t.movementId as MovementId,
      team_id: t.teamId as TeamId,
      token: STORY_TOKEN_PREFIX + randomBytes(24).toString('base64url'),
    }));
    await getAutomationsQb(['movement_story_token'])
      .insertInto('movement_story_token')
      .values(minted)
      .execute();
    for (const m of minted) byMovement.set(m.movement_id, m.token);
  }

  return byMovement;
}

/** What a token stands for, or null when it stands for nothing any more — a
 *  token we never minted, or one that was revoked. The caller says the same
 *  thing for both, since telling them apart would confirm the guess. */
export async function lookupStoryToken(token: string): Promise<StoryTokenTarget | null> {
  if (!token.startsWith(STORY_TOKEN_PREFIX)) return null;
  const row = await getAutomationsQb(['movement_story_token'])
    .selectFrom('movement_story_token')
    .where('token', '=', token)
    .where('revoked_at', 'is', null)
    .select(['movement_id', 'team_id'])
    .executeTakeFirst();
  if (!row) return null;
  return { movementId: row.movement_id as string, teamId: row.team_id as string };
}

/** Kill every live link to a movement's story. The rows stay, so a revoked
 *  token is a fact we can still see rather than an absence we have to guess at. */
export async function revokeStoryTokens(input: { movementId: string }): Promise<number> {
  const result = await getAutomationsQb(['movement_story_token'])
    .updateTable('movement_story_token')
    .set({ revoked_at: new Date() })
    .where('movement_id', '=', input.movementId as MovementId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

/** The API base the story link lands at — the same base every other capability
 *  link (asks, connect, billing) is minted against. */
export function storyUrl(token: string): string {
  const base = getEnvVar('API_BASE_URL', { devDefault: 'http://localhost:3000' }).replace(/\/$/, '');
  return `${base}/api/story/${token}`;
}
