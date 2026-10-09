// Integration test for the context-free api-key mint (real DB). `createForOwner`
// and `revokeById` are the path the author-time connect-link route uses: that
// route is tokenless (mounted before the auth gate), so the mint MUST NOT read
// `currentContext().user` — the owner is the connect token's user, passed
// explicitly. The context-based `create`/`revoke` throw "Missing user" there;
// these don't. Verified against the real api_key schema (column names, the
// text[] scopes, the FKs) so a Kysely insert-shape mistake can't hide.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';

import { getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { ApiKeyService, API_KEY_PREFIX } from '..';

describe('ApiKeyService.createForOwner / revokeById (real DB)', () => {
  let teamId: TeamId;
  let userId: UserId;

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    userId = randomUUID() as UserId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `ak-${teamId.slice(0, 8)}` } as any)
      .execute();
    await getCoreQb(['user'])
      .insertInto('user')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: userId, default_team_id: teamId, username: `ak-${userId.slice(0, 8)}` } as any)
      .execute();
  });

  afterEach(async () => {
    // api_key.created_by → user FK has no cascade, so drop our keys before
    // cleanupTeam removes the user/team.
    await getCoreQb(['api_key']).deleteFrom('api_key').where('team_id', '=', teamId).execute();
    await cleanupTeam(teamId);
  });

  it('mints a key owned by the explicit user/team — no auth-context user needed', async () => {
    const minted = await ApiKeyService.createForOwner({
      name: 'Listen-Fire Valuations (auto)',
      scopes: ['valuations'],
      teamId,
      createdBy: userId,
    });

    expect(minted.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(typeof minted.id).toBe('string');

    const row = await getCoreQb(['api_key'])
      .selectFrom('api_key')
      .where('id', '=', minted.id as never)
      .select(['team_id', 'created_by', 'scopes', 'name', 'key_hash', 'revoked_at'])
      .executeTakeFirstOrThrow();

    expect(row.created_by as unknown as string).toBe(userId);
    expect(row.team_id as unknown as string).toBe(teamId);
    expect(row.scopes).toEqual(['valuations']);
    expect(row.name).toBe('Listen-Fire Valuations (auto)');
    expect(row.key_hash.length).toBeGreaterThan(0);
    expect(row.revoked_at).toBeNull();
  });

  it('revokeById revokes by id without a team-scoped context', async () => {
    const minted = await ApiKeyService.createForOwner({
      name: 'Listen-Fire Valuations (auto)',
      scopes: ['valuations'],
      teamId,
      createdBy: userId,
    });
    await ApiKeyService.revokeById(minted.id);

    const row = await getCoreQb(['api_key'])
      .selectFrom('api_key')
      .where('id', '=', minted.id as never)
      .select(['revoked_at'])
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
  });
});
