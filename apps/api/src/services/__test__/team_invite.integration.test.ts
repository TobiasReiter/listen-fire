// Invites, auto-join and removal against a REAL DB — the three rules the
// product now rests on:
//
//   • an invite is a pending membership: writing an address down is the act;
//   • a verified sign-in claims whatever was written down for it, and an
//     address nobody wrote down has no way in;
//   • removing a member ends their memberships AND their sessions (access is
//     withdrawn, which is what every authenticated request re-reads).

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import { getCoreQb } from '../../lib/kysely';
import { cleanupTeam } from '../../test/harness/cleanup';
import { ProvisioningService } from '../provisioning';
import { TeamInviteService } from '../team_invite';
import { TeamMembershipService } from '../team_membership';

async function makeTeam(): Promise<TeamId> {
  const teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    .values({ id: teamId, name: `invites-${teamId.slice(0, 8)}` })
    .execute();
  return teamId;
}

async function makeAdmin(teamId: TeamId): Promise<{ userId: UserId; email: string }> {
  const email = `admin-${randomUUID().slice(0, 8)}@example.com`;
  const { userId } = await ProvisioningService.provisionUser({ teamId, email, access: 'write' });
  return { userId, email };
}

async function accessOf(userId: UserId): Promise<Date | null> {
  const row = await getCoreQb(['user'])
    .selectFrom('user')
    .select('granted_access_at')
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  return row.granted_access_at;
}

async function membershipTeams(userId: UserId): Promise<string[]> {
  const rows = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select('team_id')
    .where('user_id', '=', userId)
    .execute();
  return rows.map((r) => String(r.team_id));
}

describe('invites — writing an address down is the whole act', () => {
  let teamId: TeamId;
  let admin: { userId: UserId; email: string };

  beforeEach(async () => {
    teamId = await makeTeam();
    admin = await makeAdmin(teamId);
  });
  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  it('adds, lists and withdraws an invite — no seat check, no email, no token', async () => {
    const email = `pending-${randomUUID().slice(0, 8)}@example.com`;
    const added = await TeamInviteService.addInvite({
      teamId,
      email,
      invitedBy: admin.userId,
    });
    expect(added.status).toBe('created');

    const listed = await TeamInviteService.listPendingInvites(teamId);
    expect(listed.map((i) => String(i.email))).toEqual([email]);

    if (added.status !== 'created') throw new Error('unreachable');
    await TeamInviteService.revokeInvite({ teamId, inviteId: added.inviteId });
    expect(await TeamInviteService.listPendingInvites(teamId)).toEqual([]);
  });

  it('refuses the two no-ops: an existing member and a second pending invite', async () => {
    const email = `dupe-${randomUUID().slice(0, 8)}@example.com`;
    await TeamInviteService.addInvite({ teamId, email, invitedBy: admin.userId });
    expect(
      (await TeamInviteService.addInvite({ teamId, email, invitedBy: admin.userId })).status,
    ).toBe('already_invited');

    expect(
      (await TeamInviteService.addInvite({ teamId, email: admin.email, invitedBy: admin.userId }))
        .status,
    ).toBe('already_member');
  });
});

describe('sign-in — invited addresses only', () => {
  let teamId: TeamId;
  let admin: { userId: UserId; email: string };

  beforeEach(async () => {
    teamId = await makeTeam();
    admin = await makeAdmin(teamId);
  });
  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  it('refuses an address nobody wrote down', async () => {
    const result = await TeamInviteService.resolveSignInForVerifiedEmail({
      email: `stranger-${randomUUID().slice(0, 8)}@example.com`,
    });
    expect(result.status).toBe('not_invited');
  });

  it('provisions an invited address onto the inviting team on first sign-in', async () => {
    const email = `joiner-${randomUUID().slice(0, 8)}@example.com`;
    await TeamInviteService.addInvite({ teamId, email, invitedBy: admin.userId });

    const result = await TeamInviteService.resolveSignInForVerifiedEmail({ email, name: 'Jo' });
    expect(result).toMatchObject({ status: 'ok', teamId, email, created: true });
    if (result.status !== 'ok') throw new Error('unreachable');

    expect(await membershipTeams(result.userId)).toEqual([teamId]);
    // The invite is spent, not left behind as a permanent pending row.
    expect(await TeamInviteService.listPendingInvites(teamId)).toEqual([]);
  });

  it('signs an existing account in and claims a second team on the way', async () => {
    const other = await makeTeam();
    try {
      await TeamInviteService.addInvite({
        teamId: other,
        email: admin.email,
        invitedBy: admin.userId,
      });

      const result = await TeamInviteService.resolveSignInForVerifiedEmail({ email: admin.email });
      expect(result).toMatchObject({ status: 'ok', created: false });
      if (result.status !== 'ok') throw new Error('unreachable');

      expect((await membershipTeams(result.userId)).sort()).toEqual([teamId, other].sort());
      expect(await TeamInviteService.listPendingInvites(other)).toEqual([]);
    } finally {
      await cleanupTeam(other);
    }
  });

  it('claiming twice is a no-op (the second sign-in finds nothing left)', async () => {
    const other = await makeTeam();
    try {
      await TeamInviteService.addInvite({
        teamId: other,
        email: admin.email,
        invitedBy: admin.userId,
      });
      await TeamInviteService.claimInvitesForVerifiedEmail({
        email: admin.email,
        userId: admin.userId,
      });
      const second = await TeamInviteService.claimInvitesForVerifiedEmail({
        email: admin.email,
        userId: admin.userId,
      });
      expect(second.claimed).toEqual([]);
      expect((await membershipTeams(admin.userId)).sort()).toEqual([teamId, other].sort());
    } finally {
      await cleanupTeam(other);
    }
  });
});

describe('removing a member', () => {
  let teamId: TeamId;
  let admin: { userId: UserId; email: string };

  beforeEach(async () => {
    teamId = await makeTeam();
    admin = await makeAdmin(teamId);
  });
  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  it('refuses to remove the last admin', async () => {
    const result = await TeamMembershipService.removeMember({ teamId, userId: admin.userId });
    expect(result.status).toBe('last_admin');
    expect(await membershipTeams(admin.userId)).toEqual([teamId]);
  });

  it('ends the membership and withdraws access — the live session dies with it', async () => {
    const email = `leaver-${randomUUID().slice(0, 8)}@example.com`;
    await TeamInviteService.addInvite({ teamId, email, invitedBy: admin.userId });
    const joined = await TeamInviteService.resolveSignInForVerifiedEmail({ email });
    if (joined.status !== 'ok') throw new Error('expected the invited address to join');

    expect(await accessOf(joined.userId)).not.toBeNull();

    const removed = await TeamMembershipService.removeMember({
      teamId,
      userId: joined.userId,
    });
    expect(removed).toEqual({ status: 'removed', signedOut: true });
    expect(await membershipTeams(joined.userId)).toEqual([]);
    expect(await accessOf(joined.userId)).toBeNull();

    // …and the door stays shut until an admin writes the address down again.
    expect((await TeamInviteService.resolveSignInForVerifiedEmail({ email })).status).toBe(
      'not_invited',
    );

    await TeamInviteService.addInvite({ teamId, email, invitedBy: admin.userId });
    const readmitted = await TeamInviteService.resolveSignInForVerifiedEmail({ email });
    expect(readmitted).toMatchObject({ status: 'ok', created: false });
    expect(await accessOf(joined.userId)).not.toBeNull();
  });

  it('keeps the session alive for someone still on another team', async () => {
    const other = await makeTeam();
    try {
      const email = `two-teams-${randomUUID().slice(0, 8)}@example.com`;
      await TeamInviteService.addInvite({ teamId, email, invitedBy: admin.userId });
      await TeamInviteService.addInvite({ teamId: other, email, invitedBy: admin.userId });
      const joined = await TeamInviteService.resolveSignInForVerifiedEmail({ email });
      if (joined.status !== 'ok') throw new Error('expected the invited address to join');

      const removed = await TeamMembershipService.removeMember({
        teamId,
        userId: joined.userId,
      });
      expect(removed).toEqual({ status: 'removed', signedOut: false });
      expect(await membershipTeams(joined.userId)).toEqual([other]);
      expect(await accessOf(joined.userId)).not.toBeNull();
    } finally {
      await cleanupTeam(other);
    }
  });

  it('is a no-op for somebody who is not on the team', async () => {
    const result = await TeamMembershipService.removeMember({
      teamId,
      userId: randomUUID() as UserId,
    });
    expect(result.status).toBe('not_a_member');
  });
});
