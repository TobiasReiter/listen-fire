// The scheduler key's rotation touches only its own owner's key (real DB).

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';

import { getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { ApiKeyService } from '../../../services/api_key';
import { SCHEDULER_KEY_NAME, rotateSchedulerKey } from './scheduler_key';

async function owner(): Promise<{ teamId: TeamId; userId: UserId }> {
  const teamId = randomUUID() as TeamId;
  const userId = randomUUID() as UserId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `sk-${teamId.slice(0, 8)}` } as any)
    .execute();
  await getCoreQb(['user'])
    .insertInto('user')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: userId, default_team_id: teamId, username: `sk-${userId.slice(0, 8)}` } as any)
    .execute();
  return { teamId, userId };
}

async function liveKeys(teamId: TeamId) {
  return getCoreQb(['api_key'])
    .selectFrom('api_key')
    .where('team_id', '=', teamId)
    .where('name', '=', SCHEDULER_KEY_NAME)
    .where('revoked_at', 'is', null)
    .select(['id', 'scopes'])
    .execute();
}

describe('rotateSchedulerKey (real DB)', () => {
  const owners: Array<{ teamId: TeamId; userId: UserId }> = [];

  afterEach(async () => {
    for (const { teamId } of owners.splice(0)) {
      await getCoreQb(['api_key']).deleteFrom('api_key').where('team_id', '=', teamId).execute();
      await cleanupTeam(teamId);
    }
  });

  it('leaves its owner exactly one live system key, and a same-named key in another team alive', async () => {
    const mine = await owner();
    const theirs = await owner();
    owners.push(mine, theirs);
    const other = await ApiKeyService.createForOwner({
      name: SCHEDULER_KEY_NAME,
      scopes: ['system'],
      teamId: theirs.teamId,
      createdBy: theirs.userId,
    });

    const first = await rotateSchedulerKey(mine);
    const second = await rotateSchedulerKey(mine);

    expect(second).not.toBe(first);
    const live = await liveKeys(mine.teamId);
    expect(live).toHaveLength(1);
    expect(live[0]?.scopes).toEqual(['system']);
    expect((await ApiKeyService.validateKey(first)).valid).toBe(false);
    expect((await ApiKeyService.validateKey(second)).valid).toBe(true);
    expect((await liveKeys(theirs.teamId)).map((key) => key.id)).toEqual([other.id]);
  });
});
