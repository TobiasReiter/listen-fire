// The deep-link handshake — the security core. These tests exercise the REAL
// `mintTelegramToken` / `bindTelegramFromStart` logic against an in-memory model
// of the three tables they touch (`automations.telegram_token`,
// `automations.telegram_identity`, `core.user_email`), driven through a fake
// `globalQb` whose `.transaction()` runs the callback over the same store — so
// the atomicity, one-time, expiry and primary-email branches are all real.

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── In-memory tables ──────────────────────────────────────────────────────────
interface TokenRow {
  id: string;
  token: string;
  native_user_id: string;
  team_id: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}
interface IdentityRow {
  id: string;
  team_id: string;
  telegram_user_id: string;
  email: string;
  linked_at: Date;
}
interface UserEmailRow {
  user_id: string;
  email: string;
  is_primary: boolean;
}

const tokens: TokenRow[] = [];
const identities: IdentityRow[] = [];
const userEmails: UserEmailRow[] = [];
let idSeq = 0;

// A minimal fluent builder covering exactly the calls the handshake makes
// against one named table. Each terminal (`execute` / `executeTakeFirst`)
// reads/writes the in-memory arrays.
function makeBuilder(schema: 'automations' | 'core') {
  return {
    // ── selectFrom ──
    selectFrom(table: string) {
      const filters: Record<string, unknown> = {};
      const chain = {
        where(col: string, _op: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        select() {
          return chain;
        },
        forUpdate() {
          return chain;
        },
        async executeTakeFirst() {
          if (schema === 'automations' && table === 'telegram_token') {
            return tokens.find((t) => t.token === filters['token']);
          }
          if (schema === 'core' && table === 'user_email') {
            return userEmails.find(
              (u) => u.user_id === filters['user_id'] && u.is_primary === filters['is_primary'],
            );
          }
          return undefined;
        },
      };
      return chain;
    },
    // ── deleteFrom ──
    deleteFrom(table: string) {
      const filters: Record<string, unknown> = {};
      const chain = {
        where(col: string, op: string, val: unknown) {
          filters[`${col}|${op}`] = val;
          return chain;
        },
        async execute() {
          if (schema === 'automations' && table === 'telegram_token') {
            for (let i = tokens.length - 1; i >= 0; i--) {
              const t = tokens[i];
              if (
                t.native_user_id === filters['native_user_id|='] &&
                t.team_id === filters['team_id|='] &&
                // `used_at is null`
                't.used_at' &&
                t.used_at === null
              ) {
                tokens.splice(i, 1);
              }
            }
          }
        },
      };
      return chain;
    },
    // ── insertInto ──
    insertInto(table: string) {
      let row: Record<string, unknown> = {};
      let conflict: { cols: string[]; set: Record<string, unknown> } | null = null;
      const chain = {
        values(v: Record<string, unknown>) {
          row = v;
          return chain;
        },
        onConflict(cb: (oc: unknown) => unknown) {
          const oc = {
            columns(cols: string[]) {
              return {
                doUpdateSet(set: Record<string, unknown>) {
                  conflict = { cols, set };
                  return oc;
                },
              };
            },
          };
          cb(oc);
          return chain;
        },
        async execute() {
          if (schema === 'automations' && table === 'telegram_token') {
            tokens.push({
              id: `tok-${++idSeq}`,
              token: row['token'] as string,
              native_user_id: row['native_user_id'] as string,
              team_id: row['team_id'] as string,
              expires_at: row['expires_at'] as Date,
              used_at: null,
              created_at: new Date(),
            });
          } else if (schema === 'automations' && table === 'telegram_identity') {
            const existing = identities.find(
              (i) =>
                i.team_id === row['team_id'] && i.telegram_user_id === row['telegram_user_id'],
            );
            if (existing && conflict) {
              Object.assign(existing, conflict.set);
            } else if (!existing) {
              identities.push({
                id: `idn-${++idSeq}`,
                team_id: row['team_id'] as string,
                telegram_user_id: row['telegram_user_id'] as string,
                email: row['email'] as string,
                linked_at: new Date(),
              });
            }
          }
        },
      };
      return chain;
    },
    // ── updateTable ──
    updateTable(table: string) {
      let setVals: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      const chain = {
        set(v: Record<string, unknown>) {
          setVals = v;
          return chain;
        },
        where(col: string, _op: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        async execute() {
          if (schema === 'automations' && table === 'telegram_token') {
            const t = tokens.find((r) => r.id === filters['id']);
            if (t) Object.assign(t, setVals);
          }
        },
      };
      return chain;
    },
  };
}

const fakeTrx = {
  withSchema(schema: 'automations' | 'core') {
    return makeBuilder(schema);
  },
};

jest.mock('../../../../../lib/kysely', () => ({
  globalQb: {
    transaction: () => ({
      execute: async (cb: (trx: unknown) => unknown) => cb(fakeTrx),
    }),
  },
}));

import {
  mintTelegramToken,
  bindTelegramFromStart,
  generateTelegramToken,
  builtInBotUsername,
  telegramStartUrl,
  TELEGRAM_TOKEN_TTL_MS,
} from '../handshake';

const USER = 'user-1';
const TEAM = 'team-1';
const TG = 'tg-999';
const PRIMARY_EMAIL = 'ada@example.com';

beforeEach(() => {
  tokens.length = 0;
  identities.length = 0;
  userEmails.length = 0;
  idSeq = 0;
  delete process.env.TELEGRAM_BOT_USERNAME;
});

describe('generateTelegramToken', () => {
  it('is url-safe and within Telegram’s 64-char start cap', () => {
    const t = generateTelegramToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeLessThanOrEqual(64);
  });

  it('is unguessable (distinct across calls)', () => {
    const a = generateTelegramToken();
    const b = generateTelegramToken();
    expect(a).not.toEqual(b);
  });
});

describe('builtInBotUsername / telegramStartUrl', () => {
  it('returns null when unset or whitespace', () => {
    expect(builtInBotUsername()).toBeNull();
    process.env.TELEGRAM_BOT_USERNAME = '   ';
    expect(builtInBotUsername()).toBeNull();
  });

  it('strips a leading @ and builds a well-formed t.me url', () => {
    process.env.TELEGRAM_BOT_USERNAME = '@ListenFireBot';
    expect(builtInBotUsername()).toBe('ListenFireBot');
    expect(telegramStartUrl({ botUsername: 'ListenFireBot', token: 'abc' })).toBe(
      'https://t.me/ListenFireBot?start=abc',
    );
  });
});

describe('mintTelegramToken', () => {
  it('creates a token row with the right user/team and a ~10m expiry', async () => {
    const before = Date.now();
    const { token, expiresAt } = await mintTelegramToken({ nativeUserId: USER, teamId: TEAM });
    expect(tokens).toHaveLength(1);
    const row = tokens[0];
    expect(row.token).toBe(token);
    expect(row.native_user_id).toBe(USER);
    expect(row.team_id).toBe(TEAM);
    expect(row.used_at).toBeNull();
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + TELEGRAM_TOKEN_TTL_MS - 50);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + TELEGRAM_TOKEN_TTL_MS + 50);
  });

  it('sweeps the user’s prior UNCONSUMED token (no pile-up)', async () => {
    await mintTelegramToken({ nativeUserId: USER, teamId: TEAM });
    await mintTelegramToken({ nativeUserId: USER, teamId: TEAM });
    expect(tokens.filter((t) => t.used_at === null)).toHaveLength(1);
  });

  it('keeps already-consumed tokens (audit trail) while minting a new one', async () => {
    await mintTelegramToken({ nativeUserId: USER, teamId: TEAM });
    tokens[0].used_at = new Date(); // simulate a prior successful bind
    await mintTelegramToken({ nativeUserId: USER, teamId: TEAM });
    expect(tokens).toHaveLength(2);
    expect(tokens.filter((t) => t.used_at === null)).toHaveLength(1);
  });
});

describe('bindTelegramFromStart (the security core)', () => {
  function seedUserEmail() {
    userEmails.push({ user_id: USER, email: PRIMARY_EMAIL, is_primary: true });
  }

  it('valid token → writes identity with primary email + burns token (atomic)', async () => {
    seedUserEmail();
    const { token } = await mintTelegramToken({ nativeUserId: USER, teamId: TEAM });

    const res = await bindTelegramFromStart({ token, telegramUserId: TG });

    expect(res).toEqual({ ok: true, email: PRIMARY_EMAIL, telegramUserId: TG });
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      team_id: TEAM,
      telegram_user_id: TG,
      email: PRIMARY_EMAIL,
    });
    expect(tokens[0].used_at).not.toBeNull(); // burned
  });

  it('lowercases/trims the primary email it binds', async () => {
    userEmails.push({ user_id: USER, email: '  Ada@Example.COM ', is_primary: true });
    const { token } = await mintTelegramToken({ nativeUserId: USER, teamId: TEAM });
    const res = await bindTelegramFromStart({ token, telegramUserId: TG });
    expect(res).toEqual({ ok: true, email: PRIMARY_EMAIL, telegramUserId: TG });
    expect(identities[0].email).toBe(PRIMARY_EMAIL);
  });

  it('EXPIRED token → reject, no identity, token untouched', async () => {
    seedUserEmail();
    const { token } = await mintTelegramToken({ nativeUserId: USER, teamId: TEAM });
    tokens[0].expires_at = new Date(Date.now() - 1000); // already expired

    const res = await bindTelegramFromStart({ token, telegramUserId: TG });

    expect(res).toEqual({ ok: false, reason: 'token_expired' });
    expect(identities).toHaveLength(0);
    expect(tokens[0].used_at).toBeNull(); // untouched
  });

  it('USED token → reject, no second binding', async () => {
    seedUserEmail();
    const { token } = await mintTelegramToken({ nativeUserId: USER, teamId: TEAM });
    await bindTelegramFromStart({ token, telegramUserId: TG }); // first consumes it
    identities.length = 0; // pretend we want to observe a second attempt's effect

    const res = await bindTelegramFromStart({ token, telegramUserId: 'tg-other' });

    expect(res).toEqual({ ok: false, reason: 'token_used' });
    expect(identities).toHaveLength(0);
  });

  it('UNKNOWN token → reject', async () => {
    seedUserEmail();
    const res = await bindTelegramFromStart({ token: 'never-minted', telegramUserId: TG });
    expect(res).toEqual({ ok: false, reason: 'token_not_found' });
    expect(identities).toHaveLength(0);
  });

  it('re-linking the same (team, tg user) UPDATES the row, not duplicates', async () => {
    // First bind.
    userEmails.push({ user_id: USER, email: PRIMARY_EMAIL, is_primary: true });
    const first = await mintTelegramToken({ nativeUserId: USER, teamId: TEAM });
    await bindTelegramFromStart({ token: first.token, telegramUserId: TG });

    // A second user (in the same team) re-links the SAME telegram account.
    const USER2 = 'user-2';
    userEmails.push({ user_id: USER2, email: 'second@example.com', is_primary: true });
    const second = await mintTelegramToken({ nativeUserId: USER2, teamId: TEAM });
    const res = await bindTelegramFromStart({ token: second.token, telegramUserId: TG });

    expect(res).toEqual({ ok: true, email: 'second@example.com', telegramUserId: TG });
    expect(identities).toHaveLength(1); // updated, not duplicated
    expect(identities[0].email).toBe('second@example.com');
  });

  it('no primary email → clear fail, no identity, token untouched', async () => {
    // user has a NON-primary email only.
    userEmails.push({ user_id: USER, email: PRIMARY_EMAIL, is_primary: false });
    const { token } = await mintTelegramToken({ nativeUserId: USER, teamId: TEAM });

    const res = await bindTelegramFromStart({ token, telegramUserId: TG });

    expect(res).toEqual({ ok: false, reason: 'no_primary_email' });
    expect(identities).toHaveLength(0);
    expect(tokens[0].used_at).toBeNull();
  });
});
