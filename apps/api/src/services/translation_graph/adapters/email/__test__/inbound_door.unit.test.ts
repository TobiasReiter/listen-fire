// What the inbound email door must keep true (carve M-41/D32): the same
// senders get in, the same teams answer for them, and nobody new does.
//
// The centrepiece is the equivalence block: a snapshot of the PRE-CARVE
// resolution (`InboundMailgunAdapter.getSenderIdentifier` +
// `.validateInboundRequest`, `adapters/pipeline/inbound/mailgun.adapter.ts`)
// re-derived here over the same fixture, asserted to pick the same team as the
// door for every sender shape we know of. It is written out rather than
// imported because the file it came from is deleted by the next carve chunk —
// the point is to preserve the old behaviour, not the old code.

import { createHmac } from 'node:crypto';

interface RouteRow {
  address: string;
  team_id: string;
  is_service_email: boolean;
  accepts_plus_addressing: boolean;
}

interface Association {
  teamId: string;
  userId: string;
}

const state: {
  routes: RouteRow[];
  associations: Record<string, Association[]>;
  access: Record<string, boolean>;
  triggers: Record<string, { id: string; kind: string }>;
  slack: { text: string }[];
  warnings: string[];
} = {
  routes: [],
  associations: {},
  access: {},
  triggers: {},
  slack: [],
  warnings: [],
};

function matches(row: RouteRow, column: string, op: string, value: unknown): boolean {
  const cell = row[column as keyof RouteRow];
  const text = String(cell).toLowerCase();
  if (op === 'in') {
    return Array.isArray(value) && value.some((entry) => String(entry).toLowerCase() === text);
  }
  if (op === '=') return cell === value;
  // citext + `like '%@domain'`
  if (op === 'like' && typeof value === 'string') {
    return text.endsWith(value.replace(/^%/, '').toLowerCase());
  }
  return true;
}

jest.mock('../../../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: () => {
      let rows = [...state.routes];
      const chain = {
        where(column: string, op: string, value: unknown) {
          rows = rows.filter((row) => matches(row, column, op, value));
          return chain;
        },
        select: () => chain,
        execute: async () => rows,
        executeTakeFirst: async () => rows[0],
      };
      return chain;
    },
  });
  return { getQb: qb, getCoreQb: qb, getAutomationsQb: qb };
});

jest.mock('../../../../principal', () => ({
  principalDirectory: () => ({
    async teamsForEmail(email: string) {
      return state.associations[email.toLowerCase()] ?? [];
    },
    async userById({ id, teamId }: { id: string; teamId: string }) {
      const key = `${id} ${teamId}`;
      if (!(key in state.access)) return null;
      return { id, hasAccess: state.access[key] };
    },
  }),
}));

jest.mock('../../../storage/tg_table', () => ({
  findTriggerByInboundKey: async ({ teamId, key }: { teamId: string; key: string }) =>
    state.triggers[`${teamId} ${key}`] ?? null,
}));

jest.mock('../../../../../lib/slack', () => ({
  sendSlackNotification: async (notification: { text: string }) => {
    state.slack.push(notification);
  },
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: {
    warn: (message: string) => state.warnings.push(message),
    error: (message: string) => state.warnings.push(message),
    info: () => undefined,
  },
}));

import { verifyInboundEmailRequest, type InboundEmailDecision } from '../inbound_door';

const API_KEY = 'test-harness-dummy-key';
const TEAM = 'team-1';
const OTHER_TEAM = 'team-2';

function signed(body: Record<string, unknown>): Record<string, unknown> {
  const timestamp = '1750000000';
  const token = 'a-token';
  return {
    ...body,
    timestamp,
    token,
    signature: createHmac('sha256', API_KEY)
      .update(timestamp + token)
      .digest('hex'),
  };
}

function request(body: Record<string, unknown>): Parameters<typeof verifyInboundEmailRequest>[0] {
  // The door reads `req.body` and nothing else off the request.
  return { body } as Parameters<typeof verifyInboundEmailRequest>[0];
}

/** A person of TEAM whose address is a login, granted. */
function member(email: string, userId: string, teamId: string = TEAM) {
  state.associations[email] = [{ teamId, userId }];
  state.access[`${userId} ${teamId}`] = true;
}

beforeEach(() => {
  state.routes = [];
  state.associations = {};
  state.access = {};
  state.triggers = {};
  state.slack = [];
  state.warnings = [];
  process.env.TEST_HARNESS_TEAM_ID = 'harness';
  // The routing address is the deployment's, not a constant — these fixtures
  // are written against one fixed address.
  process.env.INBOUND_EMAIL_ADDRESS = 'inbox@example.com';
  delete process.env.NODE_ENV_OVERRIDE;
});

describe('proving it is really Mailgun', () => {
  it('admits a correctly signed payload', async () => {
    member('ada@example.com', 'user-1');
    const decision = await verifyInboundEmailRequest(
      request(signed({ sender: 'ada@example.com', recipient: 'inbox@example.com' })),
    );

    expect(decision).toMatchObject({ outcome: 'routed', teamId: TEAM, userId: 'user-1' });
  });

  it('refuses a wrong signature with a code Mailgun will not retry', async () => {
    member('ada@example.com', 'user-1');
    const body = signed({ sender: 'ada@example.com' });
    body.signature = createHmac('sha256', 'a-different-key').update('x').digest('hex');

    await expect(verifyInboundEmailRequest(request(body))).resolves.toEqual({
      outcome: 'refused',
      status: 406,
    });
  });

  it('treats a malformed signature as wrong rather than as a server error', async () => {
    member('ada@example.com', 'user-1');
    const body = signed({ sender: 'ada@example.com' });
    body.signature = 'nonsense';

    await expect(verifyInboundEmailRequest(request(body))).resolves.toEqual({
      outcome: 'refused',
      status: 406,
    });
  });

  it('refuses everything when no signing key is configured', async () => {
    delete process.env.TEST_HARNESS_TEAM_ID;
    member('ada@example.com', 'user-1');

    await expect(
      verifyInboundEmailRequest(request(signed({ sender: 'ada@example.com' }))),
    ).resolves.toEqual({ outcome: 'refused', status: 401 });
  });
});

describe('who is allowed to send', () => {
  it('drops a stranger and raises them for onboarding', async () => {
    const decision = await verifyInboundEmailRequest(
      request(signed({ sender: 'stranger@nowhere.com', To: 'inbox+deals@example.com' })),
    );

    expect(decision).toEqual({ outcome: 'refused', status: 201 });
    expect(state.slack[0].text).toMatch(/Unrecognised inbound email from stranger@nowhere.com/);
  });

  it('drops a known person who may not act for the team', async () => {
    state.associations['invited@example.com'] = [{ teamId: TEAM, userId: 'user-9' }];
    state.access['user-9 team-1'] = false;

    await expect(
      verifyInboundEmailRequest(request(signed({ sender: 'invited@example.com' }))),
    ).resolves.toEqual({ outcome: 'refused', status: 201 });
  });

  it('answers for a service address through its own team', async () => {
    state.routes = [
      {
        address: 'deals@acme.com',
        team_id: OTHER_TEAM,
        is_service_email: true,
        accepts_plus_addressing: false,
      },
    ];
    state.associations['deals@acme.com'] = [{ teamId: TEAM, userId: 'user-3' }];
    state.access[`user-3 ${OTHER_TEAM}`] = true;

    const decision = await verifyInboundEmailRequest(
      request(
        signed({
          sender: 'outsider@elsewhere.com',
          'X-Forwarded-For': 'deals@acme.com',
          To: 'inbox+deals@example.com',
        }),
      ),
    );

    expect(decision).toMatchObject({ outcome: 'routed', teamId: OTHER_TEAM, userId: 'user-3' });
  });

  it('accepts a +tag on an address only when that address opted in', async () => {
    // Not a service address — so the same-domain fallback below cannot rescue
    // it, and the opt-in is the only thing deciding.
    state.routes = [
      {
        address: 'shared@acme.com',
        team_id: TEAM,
        is_service_email: false,
        accepts_plus_addressing: true,
      },
    ];
    state.associations['shared@acme.com'] = [{ teamId: TEAM, userId: 'user-3' }];
    state.access[`user-3 ${TEAM}`] = true;

    await expect(
      verifyInboundEmailRequest(request(signed({ sender: 'shared+q3@acme.com' }))),
    ).resolves.toMatchObject({ outcome: 'routed', teamId: TEAM });

    state.routes[0].accepts_plus_addressing = false;
    await expect(
      verifyInboundEmailRequest(request(signed({ sender: 'shared+q3@acme.com' }))),
    ).resolves.toEqual({ outcome: 'refused', status: 201 });
  });

  it('falls back to a service address of the sender’s own domain', async () => {
    state.routes = [
      {
        address: 'inbox@acme.com',
        team_id: TEAM,
        is_service_email: true,
        accepts_plus_addressing: false,
      },
    ];
    state.associations['inbox@acme.com'] = [{ teamId: TEAM, userId: 'user-4' }];
    state.access[`user-4 ${TEAM}`] = true;

    await expect(
      verifyInboundEmailRequest(request(signed({ sender: 'newcomer@acme.com' }))),
    ).resolves.toMatchObject({ outcome: 'routed', teamId: TEAM, userId: 'user-4' });
  });
});

describe('which team, when the sender belongs to several', () => {
  beforeEach(() => {
    state.associations['ada@example.com'] = [
      { teamId: TEAM, userId: 'user-1' },
      { teamId: OTHER_TEAM, userId: 'user-1' },
    ];
    state.access[`user-1 ${TEAM}`] = true;
    state.access[`user-1 ${OTHER_TEAM}`] = true;
  });

  it('routes to the team that owns a trigger for the address', async () => {
    state.triggers[`${OTHER_TEAM} deals`] = { id: 'trigger-2', kind: 'CUSTOM_EMAIL' };

    const decision = await verifyInboundEmailRequest(
      request(signed({ sender: 'ada@example.com', To: 'inbox+deals@example.com' })),
    );

    expect(decision).toMatchObject({
      outcome: 'routed',
      teamId: OTHER_TEAM,
      route: { teamId: OTHER_TEAM, key: 'deals', trigger: { id: 'trigger-2' } },
    });
  });

  it('drops the message when two of their teams claim the same key', async () => {
    state.triggers[`${TEAM} deals`] = { id: 'trigger-1', kind: 'CUSTOM_EMAIL' };
    state.triggers[`${OTHER_TEAM} deals`] = { id: 'trigger-2', kind: 'CUSTOM_EMAIL' };

    await expect(
      verifyInboundEmailRequest(
        request(signed({ sender: 'ada@example.com', To: 'inbox+deals@example.com' })),
      ),
    ).resolves.toEqual({ outcome: 'refused', status: 201 });
    expect(state.warnings.join(' ')).toMatch(/ambiguous/);
  });

  it('still names a team of record when nothing listens for the address', async () => {
    const decision = await verifyInboundEmailRequest(
      request(signed({ sender: 'ada@example.com', To: 'inbox+unknown@example.com' })),
    );

    expect(decision).toMatchObject({
      outcome: 'routed',
      teamId: TEAM,
      route: { key: 'unknown', trigger: null },
    });
  });
});

// ── Equivalence with the pre-carve door ────────────────────────────────────

/** A `user_email` row as the old resolution saw it, plus the facts it reached
 *  for through `unauthorisedGetUserByEmail`. */
interface LegacyUserEmail {
  email: string;
  is_service_email: boolean;
  accepts_plus_addressing: boolean;
  associated_team_id: string | null;
  user_id: string;
  home_team_id: string;
  granted: boolean;
}

/** `getEmailsListFromEmails`, verbatim in behaviour. */
function legacyRegisteredEmails(emails: string[], rows: LegacyUserEmail[]): LegacyUserEmail[] {
  const exact = rows.filter((row) => emails.includes(row.email));
  const strippedCandidates = emails.map((email) => email.replace(/\+.*@/, '@'));
  const stripped = rows.filter(
    (row) => row.accepts_plus_addressing && strippedCandidates.includes(row.email),
  );

  const registered: LegacyUserEmail[] = [];
  for (const email of emails) {
    let match = exact.find((row) => row.email === email);
    if (!match) {
      const base = email.replace(/\+.*@/, '@');
      match = stripped.find((row) => row.email === base);
    }
    if (!match) continue;

    if (match.is_service_email) {
      registered.push(match);
      continue;
    }
    const domain = match.email.split('@')[1];
    const serviceIdx = registered.findIndex(
      (seen) => seen.is_service_email && seen.email.split('@')[1] === domain,
    );
    if (serviceIdx > -1) registered.splice(serviceIdx, 0, match);
    else registered.push(match);
  }
  return registered;
}

/** `validateInboundRequest`'s team resolution: the identifier's own row, else
 *  a service row of the same domain, else nothing. */
function legacyTeam(emails: string[], rows: LegacyUserEmail[]): string | null {
  const registered = legacyRegisteredEmails(emails, rows);
  const identifier = registered[0]?.email ?? emails[0] ?? '';

  const row = rows.find((entry) => entry.email === identifier && entry.granted);
  if (row) return row.associated_team_id ?? row.home_team_id;

  const domain = identifier.split('@')[1];
  const service = rows.find(
    (entry) => entry.is_service_email && entry.email.endsWith(`@${domain}`) && entry.granted,
  );
  if (service) return service.associated_team_id ?? service.home_team_id;
  return null;
}

/** The same fixture, seen the way the carved door sees it: routing facts in
 *  `inbound_email_route`, identity through the Directory. */
function loadFixture(rows: LegacyUserEmail[]): void {
  state.routes = rows
    .filter(
      (row) => row.is_service_email || row.accepts_plus_addressing || row.associated_team_id !== null,
    )
    .map((row) => ({
      address: row.email,
      team_id: row.associated_team_id ?? row.home_team_id,
      is_service_email: row.is_service_email,
      accepts_plus_addressing: row.accepts_plus_addressing,
    }));

  for (const row of rows) {
    state.associations[row.email] = [{ teamId: row.home_team_id, userId: row.user_id }];
    state.access[`${row.user_id} ${row.home_team_id}`] = row.granted;
    if (row.associated_team_id !== null) {
      state.access[`${row.user_id} ${row.associated_team_id}`] = row.granted;
    }
  }
}

function userEmail(over: Partial<LegacyUserEmail> & { email: string }): LegacyUserEmail {
  return {
    is_service_email: false,
    accepts_plus_addressing: false,
    associated_team_id: null,
    user_id: `user-of-${over.email}`,
    home_team_id: TEAM,
    granted: true,
    ...over,
  };
}

describe('a sender of one team routes exactly where the old door routed them', () => {
  const rows: LegacyUserEmail[] = [
    userEmail({ email: 'ada@example.com', user_id: 'user-1' }),
    userEmail({ email: 'grace@example.com', user_id: 'user-2', associated_team_id: OTHER_TEAM }),
    userEmail({
      email: 'deals@acme.com',
      user_id: 'user-3',
      is_service_email: true,
      associated_team_id: OTHER_TEAM,
    }),
    userEmail({
      email: 'list@acme.com',
      user_id: 'user-4',
      is_service_email: true,
      accepts_plus_addressing: true,
    }),
    userEmail({ email: 'bob@acme.com', user_id: 'user-5' }),
    userEmail({ email: 'dormant@example.com', user_id: 'user-6', granted: false }),
  ];

  const cases: { name: string; body: Record<string, unknown> }[] = [
    { name: 'a plain member', body: { sender: 'ada@example.com' } },
    { name: 'a member whose address names another team', body: { sender: 'grace@example.com' } },
    {
      name: 'a stranger forwarded through a service address',
      body: { sender: 'outsider@elsewhere.com', 'X-Forwarded-For': 'deals@acme.com' },
    },
    {
      name: 'a member forwarded through their domain’s service address',
      body: { sender: 'bob@acme.com', 'X-Forwarded-For': 'deals@acme.com' },
    },
    { name: 'a +tagged mailing list', body: { sender: 'list+weekly@acme.com' } },
    { name: 'a stranger of a domain we serve', body: { sender: 'newcomer@acme.com' } },
    { name: 'an outright stranger', body: { sender: 'stranger@nowhere.com' } },
    { name: 'an un-activated account', body: { sender: 'dormant@example.com' } },
  ];

  it.each(cases)('picks the same team for $name', async ({ body }) => {
    loadFixture(rows);

    const candidates = [
      typeof body['X-Forwarded-For'] === 'string' ? body['X-Forwarded-For'] : undefined,
      typeof body.sender === 'string' ? body.sender : undefined,
    ].filter((entry): entry is string => entry !== undefined);

    const decision: InboundEmailDecision = await verifyInboundEmailRequest(request(signed(body)));
    const expected = legacyTeam(candidates, rows);

    if (expected === null) {
      expect(decision).toEqual({ outcome: 'refused', status: 201 });
      return;
    }
    expect(decision).toMatchObject({ outcome: 'routed', teamId: expected });
  });
});
