// A MACHINE principal — an api key minted for a service, or the static
// single-tenant stub a coreless deployment boots with — has no `userId` by
// design (D2). The v1 surface used to reach identity through `Context.user`,
// which is user-SHAPED and THROWS when there is none, so those callers got a
// 500 (or, off an unwrapped async middleware, no response at all) on routes
// that never needed a person in the first place.
//
// This pins the two halves of the sweep: a route that only needs a TENANT works
// unchanged, and a route that genuinely acts on one person's account refuses in
// words rather than throwing. The user-principal case is asserted alongside each
// so the guard is provably about the machine case, not a blanket refusal.

import { createServer, type Server } from 'node:http';

import express, { Router } from 'express';
import { currentPrincipal, runWithPrincipalSync, type Principal } from 'principal';

import type { AddressInfo } from 'node:net';


const startPhoneVerification = jest.fn();
const listTgRuns = jest.fn();
const userFindUnique = jest.fn();

jest.mock('../../../../services/system_debug', () => ({
  ...jest.requireActual('../../../../services/system_debug'),
  listTgRuns: (input: unknown) => listTgRuns(input),
}));

// The database, and ONLY the database. Identity still comes from the real
// ambient principal the middleware below installs — a suite that mocks the
// Context to fake identity is the shape 6.2 had to unpick.
jest.mock('../../../../services/context', () => ({
  ...jest.requireActual('../../../../services/context'),
  currentContext: () => ({ prisma: { user: { findUnique: userFindUnique } } }),
}));

jest.mock('../../../../services/whatsapp/phone_verification', () => {
  const actual = jest.requireActual('../../../../services/whatsapp/phone_verification');
  return {
    ...actual,
    startPhoneVerification: (input: unknown) => startPhoneVerification(input),
  };
});

// A query builder that answers every chain with itself and every execution with
// nothing. The knowledge routes are exercised for WHO they act as, not what
// they select, so no database is involved.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const emptyQb = (): any =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        if (prop === 'execute') return async () => [];
        if (prop === 'executeTakeFirst') return async () => undefined;
        return () => emptyQb();
      },
    },
  );

jest.mock('../../../../lib/kysely', () => ({
  ...jest.requireActual('../../../../lib/kysely'),
  getKnowledgeQb: () => emptyQb(),
}));

jest.mock('../../../../lib/knowledge/cypher', () => ({
  ...jest.requireActual('../../../../lib/knowledge/cypher'),
  loadOntology: async () => ({ nodeTypes: new Map(), edgeTypes: new Map() }),
}));

import { mountAutomationToolRoutes } from '../knowledge_agent_tools';
import { knowledgeRouter } from '../knowledge';
import { meRouter } from '../me';
import { systemRouter } from '../system';
import { teamId as valuationsTeamId } from '../valuations/shared';

const MACHINE: Principal = {
  teamId: 'team-machine',
  access: 'write',
  scopes: ['*'],
  pinnedTeamId: 'team-machine',
  credentialId: 'key-1',
};

const HUMAN: Principal = { ...MACHINE, userId: 'user-1' };

// Swapped per test, then installed by the middleware below — the same shape
// `principalMiddleware` produces, without an authentication round trip.
// `undefined` is the unauthenticated case: no principal is made ambient at all.
let acting: Principal | undefined = MACHINE;

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.apiKeyScopes = ['knowledge', 'system'];
    if (acting === undefined) return next();
    runWithPrincipalSync(acting, () => next());
  });
  const tools = Router();
  mountAutomationToolRoutes(tools);
  app.use('/v1/automation', tools);
  app.use('/v1/knowledge', knowledgeRouter);
  app.use('/v1', meRouter);
  app.use('/v1/system', systemRouter);
  server = createServer(app);
  server.listen(0, () => {
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
  acting = MACHINE;
});

describe('tenancy reads need no user', () => {
  it('valuations resolves its tenant off the principal, not a user row', () => {
    expect(runWithPrincipalSync(MACHINE, () => valuationsTeamId())).toBe('team-machine');
  });

  it('a knowledge node listing answers a machine principal', async () => {
    const res = await fetch(`${baseUrl}/v1/knowledge/nodes?limit=5`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], meta: { count: 0, offset: 0, limit: 5 } });
  });

  it('and still answers one that has a user', async () => {
    acting = HUMAN;
    const res = await fetch(`${baseUrl}/v1/knowledge/nodes?limit=5`);

    expect(res.status).toBe(200);
  });

  it('the system run listing scopes to the principal’s team, not a user row', async () => {
    listTgRuns.mockResolvedValue([]);

    const res = await fetch(`${baseUrl}/v1/system/tg-runs`);

    expect(res.status).toBe(200);
    expect(listTgRuns).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-machine' }));
  });

  it('and the inbound-email door reads the same tenant the door decided', async () => {
    // The door hands the funnel a requested team, which becomes the principal's
    // — so the handler's tenant is that decision read back, not a second one.
    expect(runWithPrincipalSync(MACHINE, () => currentPrincipal().teamId)).toBe('team-machine');
  });
});

// `/me` is a route ABOUT a person. A machine principal is not a caller whose
// tenant should be substituted; it is a caller this route has nothing to
// describe — so it 404s rather than 500ing or answering about somebody.
describe('the one route that IS about a user', () => {
  it('404s for a machine principal without touching the database', async () => {
    const res = await fetch(`${baseUrl}/v1/me`);
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(404);
    expect(body.error).toBe('not_found');
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it('404s for a user id with no row — the case LISTEN_FIRE_USER_ID creates', async () => {
    acting = HUMAN;
    userFindUnique.mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/v1/me`);

    expect(res.status).toBe(404);
    expect(userFindUnique).toHaveBeenCalled();
  });

  it('still describes a principal that does have a user row', async () => {
    acting = HUMAN;
    userFindUnique.mockResolvedValue({
      id: 'user-1',
      username: 'ada',
      userEmails: [{ email: 'ada@example.com' }],
    });

    const res = await fetch(`${baseUrl}/v1/me`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'user-1', name: 'ada', email: 'ada@example.com' });
  });
});

// The tenancy fix removes today's instance; this pins the class. Express 4
// drops an async handler's rejection on the floor, so a throw on the way IN
// (identity, before the handler's own try) used to leave the socket
// unanswered — `HTTP=000`, a hang rather than a 500, which reads as a dead
// server rather than a broken route.
describe('a route that throws before its own try/catch', () => {
  it('answers with a 500 rather than leaving the request unanswered', async () => {
    acting = undefined;

    const res = await fetch(`${baseUrl}/v1/knowledge/nodes?limit=5`);
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe('internal_error');
  });
});

describe('a tool that acts on one person’s account', () => {
  it('refuses a machine principal with a 400 the caller can act on', async () => {
    const res = await fetch(`${baseUrl}/v1/automation/whatsapp/verify/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '+447700900000' }),
    });
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/machine/i);
    // The refusal is the whole outcome: nothing reached the service, and
    // nothing threw on the way (a throw here was a 500 `internal_error`).
    expect(startPhoneVerification).not.toHaveBeenCalled();
  });

  it('still runs for a principal that does have a user', async () => {
    acting = HUMAN;
    startPhoneVerification.mockResolvedValue({
      ok: true,
      outcome: 'code_sent',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });

    const res = await fetch(`${baseUrl}/v1/automation/whatsapp/verify/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '+447700900000' }),
    });

    expect(res.status).toBe(200);
    expect(startPhoneVerification).toHaveBeenCalledWith({
      userId: 'user-1',
      phoneNumber: '+447700900000',
    });
  });

  // Starting a conversation is the same shape one layer down: it is not that a
  // machine may not chat, it is that `agent_conversation.user_id` is NOT NULL, so
  // there is no null upstream of the throw for attribution to degrade to and no
  // user to invent. Continuing an existing one is tenancy and stays open.
  it('refuses to start a conversation it would have to name an owner for', async () => {
    const res = await fetch(`${baseUrl}/v1/system/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/machine/i);
  });
});
