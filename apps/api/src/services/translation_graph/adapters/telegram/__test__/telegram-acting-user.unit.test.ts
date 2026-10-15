// Integration-flavoured: the email a Telegram binding resolves flows through
// the SHARED, team-clamped acting-user chain to the right ActingUser — and a
// same-email user in another team is unreachable from teamA's binding.
//
// Path under test:
//   TelegramAdapter.getActorCandidates  (telegram_user_id → email, team-scoped)
//     → resolveActingUser               (originator → scheme: 'email')
//       → lookupTeamUserByEmail         (HARD-CLAMPED: u.team_id = teamId)
//         → ActingUser
//
// Both DB leaves are mocked: `getAutomationsQb` models `telegram_identity`
// (team-scoped binding store) and `getQb` models the `user_email ⋈ user`
// lookup WITH the team clamp, so the test exercises the real clamp logic
// rather than asserting it abstractly.

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

// ── telegram_identity store: (team_id, telegram_user_id) → email ──────────────
const identityStore = new Map<string, string>();
const identityKey = (teamId: string, tgUserId: string) => `${teamId}::${tgUserId}`;

// ── user_email ⋈ user table: (default_team_id, email, is_service_email) → user row ─
// Models the SHARED lookupTeamUserByEmail query, including its hard team clamp.
interface UserRow { id: string; email: string; username: string; teamId: string; isService: boolean }
const userRows: UserRow[] = [];

jest.mock('../../../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    selectFrom: () => {
      const filters: Record<string, string> = {};
      const builder = {
        where: (column: string, _op: string, value: string) => {
          filters[column] = value;
          return builder;
        },
        select: () => ({
          executeTakeFirst: async () => {
            const email = identityStore.get(
              identityKey(filters['team_id'], filters['telegram_user_id']),
            );
            return email ? { email } : undefined;
          },
        }),
      };
      return builder;
    },
  }),
  // Models `lookupTeamUserByEmail`'s `runUserEmailLookup` chain:
  //   selectFrom('user_email as ue').innerJoin('user as u', ...)
  //     .where('ue.email', '=', email)
  //     .where('u.default_team_id', '=', teamId)    ← the hard clamp (C-6 rename)
  //     .where('ue.is_service_email', '=', requireServiceEmail)
  //     .select(...).executeTakeFirst()
  getQb: () => ({
    selectFrom: () => {
      const filters: Record<string, string | boolean> = {};
      const builder = {
        innerJoin: () => builder,
        where: (column: string, _op: string, value: string | boolean) => {
          filters[column] = value;
          return builder;
        },
        select: () => ({
          executeTakeFirst: async () => {
            const match = userRows.find(
              (r) =>
                r.email === filters['ue.email'] &&
                r.teamId === filters['u.default_team_id'] && // CLAMP
                r.isService === filters['ue.is_service_email'],
            );
            return match
              ? { id: match.id, email: match.email, username: match.username }
              : undefined;
          },
        }),
      };
      return builder;
    },
  }),
  getCoreQb: () => ({
    selectFrom: () => {
      const filters: Record<string, string | boolean> = {};
      const builder = {
        innerJoin: () => builder,
        where: (column: string, _op: string, value: string | boolean) => {
          filters[column] = value;
          return builder;
        },
        select: () => ({
          executeTakeFirst: async () => {
            const match = userRows.find(
              (r) =>
                r.email === filters['ue.email'] &&
                r.teamId === filters['u.default_team_id'] && // CLAMP
                r.isService === filters['ue.is_service_email'],
            );
            return match
              ? { id: match.id, email: match.email, username: match.username }
              : undefined;
          },
        }),
      };
      return builder;
    },
  }),
}));

import { TelegramAdapter, TELEGRAM_ADAPTER_TYPE } from '../index';
import { resolveActingUser } from '../../acting_user/resolve';

const TEAM_A = 'team-A' as TeamId;
const TEAM_B = 'team-B' as TeamId;
const TG_USER = '123';
const EMAIL = 'shared@example.com';

function event(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:t-1',
    adapterType: TELEGRAM_ADAPTER_TYPE,
    triggerType: 'webhook',
    payload: { message_id: '42', sender_id: TG_USER, sender_first_name: 'Ada', sender_username: 'adas' },
  };
}

beforeEach(() => {
  identityStore.clear();
  userRows.length = 0;
});

describe('Telegram acting-user chain (resolved email → team-clamped user)', () => {
  it('bound id resolves to the teamA user with that email', async () => {
    identityStore.set(identityKey(TEAM_A, TG_USER), EMAIL);
    userRows.push({ id: 'user-A', email: EMAIL, username: 'ada', teamId: TEAM_A, isService: false });

    const adapter = new TelegramAdapter(TEAM_A, 'cred-1');
    const user = await resolveActingUser({
      teamId: TEAM_A,
      getCandidates: () => adapter.getActorCandidates({ event: event() }),
    });

    expect(user).toEqual({ id: 'user-A', email: EMAIL, name: 'ada' });
  });

  it('teamB user with the SAME email is unreachable from teamA-only binding', async () => {
    // Binding lives only in teamA; a same-email user exists in teamB.
    identityStore.set(identityKey(TEAM_A, TG_USER), EMAIL);
    userRows.push({ id: 'user-B', email: EMAIL, username: 'someoneB', teamId: TEAM_B, isService: false });

    // teamB adapter: no teamB binding for tg user 123 → no candidate → null.
    const teamBAdapter = new TelegramAdapter(TEAM_B, 'cred-1');
    const viaTeamB = await resolveActingUser({
      teamId: TEAM_B,
      getCandidates: () => teamBAdapter.getActorCandidates({ event: event() }),
    });
    expect(viaTeamB).toBeNull();

    // Even teamA's binding resolves an email, but with teamId=teamA the clamp
    // keeps it from ever matching the teamB user — no teamA user exists, so null.
    const teamAAdapter = new TelegramAdapter(TEAM_A, 'cred-1');
    const viaTeamA = await resolveActingUser({
      teamId: TEAM_A,
      getCandidates: () => teamAAdapter.getActorCandidates({ event: event() }),
    });
    expect(viaTeamA).toBeNull();
  });

  it('unbound sender → no candidate → no acting user', async () => {
    userRows.push({ id: 'user-A', email: EMAIL, username: 'ada', teamId: TEAM_A, isService: false });
    const adapter = new TelegramAdapter(TEAM_A, 'cred-1');
    const user = await resolveActingUser({
      teamId: TEAM_A,
      getCandidates: () => adapter.getActorCandidates({ event: event() }),
    });
    expect(user).toBeNull();
  });
});
