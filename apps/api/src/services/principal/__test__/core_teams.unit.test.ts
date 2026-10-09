// Core's team resolution must make the same decisions `team_scope.ts` makes for
// the MCP surface today — a pinned credential can't be escaped, a user-anchored
// one spans memberships, and multi-team ambiguity is refused with the list
// attached rather than silently resolved to the home team.

import { TeamScopeError } from 'principal';

import type { Principal } from 'principal';

interface Row {
  [column: string]: unknown;
}

const rows: { team_membership: Row[]; team: Row[] } = { team_membership: [], team: [] };

interface Chain {
  where(...args: unknown[]): Chain;
  select(...args: unknown[]): Chain;
  orderBy(...args: unknown[]): Chain;
  execute(): Promise<Row[]>;
  executeTakeFirst(): Promise<Row | undefined>;
}

function chainFor(table: keyof typeof rows): Chain {
  const chain: Chain = {
    where: () => chain,
    select: () => chain,
    orderBy: () => chain,
    execute: async () => rows[table],
    executeTakeFirst: async () => rows[table][0],
  };
  return chain;
}

jest.mock('../../../lib/kysely', () => ({
  getQb: () => ({
    selectFrom: (table: string) => {
      if (table === 'team_membership') return chainFor('team_membership');
      if (table === 'team') return chainFor('team');
      throw new Error(`unexpected table ${table}`);
    },
  }),
  getCoreQb: () => ({
    selectFrom: (table: string) => {
      if (table === 'team_membership') return chainFor('team_membership');
      if (table === 'team') return chainFor('team');
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { accessFor, listTeamsFor, resolveTeamFor } from '../core_teams';

const USER = 'user-1';
const HOME = 'team-home';
const OTHER = 'team-other';

function principal(over: Partial<Principal> = {}): Principal {
  return {
    teamId: HOME,
    userId: USER,
    access: 'write',
    scopes: ['*'],
    pinnedTeamId: null,
    ...over,
  };
}

function membership(teamId: string, access = 'write', isPersonal = false): Row {
  return { team_id: teamId, access, is_personal: isPersonal };
}

beforeEach(() => {
  rows.team_membership = [];
  rows.team = [
    { id: HOME, name: 'Home' },
    { id: OTHER, name: 'Other' },
  ];
});

describe('a pinned credential sees exactly one team', () => {
  it('lists the pinned team, named, with the credential’s own access level', async () => {
    rows.team_membership = [membership(HOME, 'write', true)];

    const teams = await listTeamsFor(principal({ pinnedTeamId: HOME, access: 'read' }));

    expect(teams).toEqual([{ teamId: HOME, name: 'Home', access: 'read', isPersonal: true }]);
  });

  it('refuses a `team` argument that would escape the pin', async () => {
    await expect(
      resolveTeamFor(principal({ pinnedTeamId: HOME }), OTHER),
    ).rejects.toBeInstanceOf(TeamScopeError);
  });

  it('accepts the pinned team named explicitly', async () => {
    rows.team_membership = [membership(HOME)];

    await expect(resolveTeamFor(principal({ pinnedTeamId: HOME }), HOME)).resolves.toEqual({
      teamId: HOME,
      name: 'Home',
      access: 'write',
      isPersonal: false,
    });
  });
});

describe('a machine principal has no memberships to span', () => {
  it('resolves to its own team without asking who the user is', async () => {
    const machine = principal({ userId: undefined, teamId: OTHER });

    expect(await listTeamsFor(machine)).toEqual([
      { teamId: OTHER, name: 'Other', access: 'write', isPersonal: false },
    ]);
    await expect(resolveTeamFor(machine)).resolves.toMatchObject({ teamId: OTHER });
  });
});

describe('a user-anchored credential spans memberships', () => {
  it('lists every membership with its own access level and personal flag', async () => {
    rows.team_membership = [membership(HOME, 'read', true), membership(OTHER, 'write')];

    expect(await listTeamsFor(principal())).toEqual([
      { teamId: HOME, name: 'Home', access: 'read', isPersonal: true },
      { teamId: OTHER, name: 'Other', access: 'write', isPersonal: false },
    ]);
  });

  it('resolves the single membership when there is exactly one', async () => {
    rows.team_membership = [membership(OTHER, 'read')];

    await expect(resolveTeamFor(principal())).resolves.toEqual({
      teamId: OTHER,
      name: 'Other',
      access: 'read',
      isPersonal: false,
    });
  });

  it('honours a requested team the user is a member of', async () => {
    rows.team_membership = [membership(HOME), membership(OTHER, 'read')];

    await expect(resolveTeamFor(principal(), OTHER)).resolves.toEqual({
      teamId: OTHER,
      name: 'Other',
      access: 'read',
      isPersonal: false,
    });
  });

  it('refuses a requested team the user is not a member of', async () => {
    rows.team_membership = [membership(HOME)];

    await expect(resolveTeamFor(principal(), OTHER)).rejects.toBeInstanceOf(TeamScopeError);
  });

  it('refuses to guess between several teams, and hands the list back', async () => {
    rows.team_membership = [membership(HOME), membership(OTHER)];

    const error = await resolveTeamFor(principal()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TeamScopeError);
    if (!(error instanceof TeamScopeError)) throw new Error('expected a TeamScopeError');
    expect(error.teams).toEqual([
      { teamId: HOME, name: 'Home', access: 'write', isPersonal: false },
      { teamId: OTHER, name: 'Other', access: 'write', isPersonal: false },
    ]);
    expect(error.message).toContain('Home (team-home)');
  });

  // The last echo of the home-team allowance (D45): a user principal with no
  // memberships used to be handed the team its credential resolved as — the
  // same shape D44b killed in `accessFor`. Membership is the sole authority, so
  // belonging to nothing means having nowhere to act.
  it('refuses outright when there are no memberships — no fallback to the credential team', async () => {
    rows.team_membership = [];

    const error = await resolveTeamFor(principal()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TeamScopeError);
    if (!(error instanceof TeamScopeError)) throw new Error('expected a TeamScopeError');
    expect(error.message).toContain('not a member of any team');
    expect(error.teams).toEqual([]);
    expect(await listTeamsFor(principal())).toEqual([]);
  });
});

describe('access is a membership derivation, and no membership is no access (D44b)', () => {
  it('is write when any membership in the team can write', async () => {
    rows.team_membership = [membership(HOME, 'read'), membership(HOME, 'write')];

    expect(await accessFor({ userId: USER, teamId: HOME })).toBe('write');
  });

  it('is read when every membership in the team is read-only', async () => {
    rows.team_membership = [membership(HOME, 'read')];

    expect(await accessFor({ userId: USER, teamId: HOME })).toBe('read');
  });

  it('is NOTHING for a user with no membership in the team they were paired with', async () => {
    rows.team_membership = [membership(OTHER, 'write')];

    expect(await accessFor({ userId: USER, teamId: HOME })).toBeNull();
  });

  it('is nothing for a user with no memberships at all — the home-team allowance is gone', async () => {
    rows.team_membership = [];

    expect(await accessFor({ userId: USER, teamId: HOME })).toBeNull();
  });

  it('keeps team-scoped write for a machine principal, which has no user to be a member', async () => {
    rows.team_membership = [];

    expect(await accessFor({ teamId: HOME })).toBe('write');
  });
});
