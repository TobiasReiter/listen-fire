// The remote adapter push doors' REST contract (emit / wake). Drives the real
// router and the real door service over an in-process HTTP server; the install
// store, secret decryption, trigger capture and the work queue are mocked, so
// what's under test is authentication (the credential picks the install, and
// the install is the team), body validation, and what each door queues.

import { createServer, type Server } from 'node:http';

import express, { type Router } from 'express';

import type { AddressInfo } from 'node:net';

const listRemoteAdaptersOfType = jest.fn();
const loadRemoteAdapterSecret = jest.fn();
const resolveAdapter = jest.fn();
const captureProviderTriggerEvents = jest.fn();
const enqueueCapturedEvents = jest.fn();
const enqueueAwaitWake = jest.fn();
const notifyWork = jest.fn();

jest.mock('node:crypto', () => {
  const actual = jest.requireActual('node:crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});
jest.mock('../../../services/translation_graph/adapters/remote/store', () => ({
  listRemoteAdaptersOfType: (input: unknown) => listRemoteAdaptersOfType(input),
}));
jest.mock('../../../services/translation_graph/adapters/resolve', () => ({
  loadRemoteAdapterSecret: (...args: unknown[]) => loadRemoteAdapterSecret(...args),
  resolveAdapter: (input: unknown) => resolveAdapter(input),
}));
jest.mock('../../../services/webhook_sync/handler', () => ({
  captureProviderTriggerEvents: (input: unknown) => captureProviderTriggerEvents(input),
}));
jest.mock('../../../services/translation_graph/triggers/dispatch_event', () => ({
  enqueueCapturedEvents: (input: unknown) => enqueueCapturedEvents(input),
}));
jest.mock('../../../services/movement_engine/await_wake', () => ({
  enqueueAwaitWakes: async (input: { adapterType: string; teamId: string; correlationKeys: string[] }) => {
    for (const correlationKey of input.correlationKeys) {
      await enqueueAwaitWake({ adapterType: input.adapterType, teamId: input.teamId, correlationKey });
    }
  },
}));
jest.mock('../../../services/work/drain', () => ({ notifyWork: () => notifyWork() }));
jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { timingSafeEqual } from 'node:crypto';

import { adapterDoorsRouter } from '../adapterDoors';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api/public/adapter', adapterDoorsRouter as Router);
  server = createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

const A_TEAM = '00000000-0000-4000-8000-0000000000a1';
const B_TEAM = '00000000-0000-4000-8000-0000000000b1';
const TEAM_A = { team_id: A_TEAM, adapter_type: 'acme_crm', credentials_id: 'cred-a', auth_strategy: { kind: 'bearer' } };
const TEAM_B = {
  team_id: B_TEAM,
  adapter_type: 'acme_crm',
  credentials_id: 'cred-b',
  auth_strategy: { kind: 'shared_secret', header: 'x-crm-key' },
};
const SECRETS: Record<string, string> = { 'cred-a': 'secret-a', 'cred-b': 'secret-b' };

beforeEach(() => {
  jest.clearAllMocks();
  listRemoteAdaptersOfType.mockImplementation(
    async ({ adapterType, teamId }: { adapterType: string; teamId?: string }) =>
      (adapterType === 'acme_crm' ? [TEAM_A, TEAM_B] : []).filter((row) => teamId === undefined || row.team_id === teamId),
  );
  loadRemoteAdapterSecret.mockImplementation(async (credentialsId: string) => SECRETS[credentialsId]);
  resolveAdapter.mockResolvedValue({ listEventTypes: async () => [{ tag: 'company.created', positionType: 'Company' }] });
  captureProviderTriggerEvents.mockResolvedValue([{ triggerId: 'trig-1', teamId: A_TEAM, storedEventId: 'evt-1' }]);
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/api/public/adapter${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const BEARER_A = { authorization: 'Bearer secret-a' };
const EVENT = { payload: { id: 'co-1', Name: 'Acme' }, eventType: 'company.created' };

describe('authentication — the credential picks the install, the install is the team', () => {
  it('a bearer credential authenticates as the install it belongs to', async () => {
    const res = await post('/acme_crm/wake', { keys: ['thread:1'] }, BEARER_A);

    expect(res).toEqual({ status: 202, body: { accepted: 1 } });
    expect(enqueueAwaitWake).toHaveBeenCalledWith({ adapterType: 'acme_crm', teamId: A_TEAM, correlationKey: 'thread:1' });
    expect(timingSafeEqual).toHaveBeenCalled();
  });

  it("a shared-secret credential is read from the install's own header", async () => {
    const res = await post('/acme_crm/wake', { keys: ['thread:1'] }, { 'x-crm-key': 'secret-b' });

    expect(res.status).toBe(202);
    expect(enqueueAwaitWake).toHaveBeenCalledWith(expect.objectContaining({ teamId: B_TEAM }));
  });

  it("another install's secret in the wrong carrier does not authenticate", async () => {
    const res = await post('/acme_crm/wake', { keys: ['thread:1'] }, { authorization: 'Bearer secret-b' });

    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(enqueueAwaitWake).not.toHaveBeenCalled();
  });

  it('a wrong secret is 401 with no detail, and nothing is queued', async () => {
    const wake = await post('/acme_crm/wake', { keys: ['thread:1'] }, { authorization: 'Bearer nope' });
    const emit = await post('/acme_crm/emit', { events: [EVENT] }, { authorization: 'Bearer nope' });

    expect(wake).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(emit).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(enqueueAwaitWake).not.toHaveBeenCalled();
    expect(captureProviderTriggerEvents).not.toHaveBeenCalled();
    expect(enqueueCapturedEvents).not.toHaveBeenCalled();
  });

  it('no credential at all is 401', async () => {
    expect((await post('/acme_crm/wake', { keys: ['thread:1'] })).status).toBe(401);
  });

  it("one team's credential at another adapter type it never installed is refused", async () => {
    listRemoteAdaptersOfType.mockImplementation(async ({ adapterType }: { adapterType: string }) =>
      adapterType === 'other_crm'
        ? [{ team_id: B_TEAM, adapter_type: 'other_crm', credentials_id: 'cred-b', auth_strategy: { kind: 'bearer' } }]
        : [TEAM_A],
    );

    const res = await post('/other_crm/wake', { keys: ['thread:1'] }, BEARER_A);

    expect(res.status).toBe(401);
    expect(enqueueAwaitWake).not.toHaveBeenCalled();
  });

  it('an adapter type no team installed is the same 401, so the door reveals nothing', async () => {
    const res = await post('/nobody_crm/emit', { events: [EVENT] }, BEARER_A);

    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } });
  });

  it('every install is checked, even after a match', async () => {
    await post('/acme_crm/wake', { keys: ['thread:1'] }, BEARER_A);

    expect(loadRemoteAdapterSecret).toHaveBeenCalledTimes(2);
  });

  it.each(['slack', 'callback', 'ask', 'KG_MUTATION'])(
    'a slug a built-in or the engine answers to (%s) is 401 even with a valid secret, and no install is looked up',
    async (slug) => {
      listRemoteAdaptersOfType.mockResolvedValue([{ ...TEAM_A, adapter_type: slug }]);

      const wake = await post(`/${slug}/wake`, { keys: ['thread:1'] }, BEARER_A);
      const emit = await post(`/${slug}/emit`, { events: [EVENT] }, BEARER_A);

      expect(wake).toEqual({ status: 401, body: { error: 'unauthorized' } });
      expect(emit).toEqual({ status: 401, body: { error: 'unauthorized' } });
      expect(listRemoteAdaptersOfType).not.toHaveBeenCalled();
      expect(enqueueAwaitWake).not.toHaveBeenCalled();
      expect(captureProviderTriggerEvents).not.toHaveBeenCalled();
    },
  );

  describe('a credential shared by several teams', () => {
    const TEAM_A_ID = '00000000-0000-4000-8000-00000000000a';
    const TEAM_C_ID = '00000000-0000-4000-8000-00000000000c';
    beforeEach(() => {
      const rows = [
        { ...TEAM_A, team_id: TEAM_A_ID },
        { ...TEAM_A, team_id: TEAM_C_ID, credentials_id: 'cred-c' },
      ];
      SECRETS['cred-c'] = 'secret-a';
      listRemoteAdaptersOfType.mockImplementation(async ({ teamId }: { teamId?: string }) =>
        rows.filter((row) => teamId === undefined || row.team_id === teamId),
      );
    });

    it('is 409 without a team named, and nothing is queued', async () => {
      const res = await post('/acme_crm/wake', { keys: ['thread:1'] }, BEARER_A);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ambiguous_credential');
      expect(res.body.message).toMatch(/x-listen-fire-team/);
      expect(enqueueAwaitWake).not.toHaveBeenCalled();
    });

    it("reaches only the team named in x-listen-fire-team, decrypting only that team's install", async () => {
      const res = await post('/acme_crm/wake', { keys: ['thread:1'] }, { ...BEARER_A, 'x-listen-fire-team': TEAM_C_ID });

      expect(res.status).toBe(202);
      expect(listRemoteAdaptersOfType).toHaveBeenCalledWith({ adapterType: 'acme_crm', teamId: TEAM_C_ID });
      expect(loadRemoteAdapterSecret).toHaveBeenCalledTimes(1);
      expect(enqueueAwaitWake).toHaveBeenCalledWith(expect.objectContaining({ teamId: TEAM_C_ID }));
    });

    it('a named team with no install of the type is 401', async () => {
      const res = await post(
        '/acme_crm/wake',
        { keys: ['thread:1'] },
        { ...BEARER_A, 'x-listen-fire-team': '00000000-0000-4000-8000-0000000000ff' },
      );

      expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } });
    });

    it('a team header that is not a team id is 401, and nothing is looked up', async () => {
      const res = await post('/acme_crm/wake', { keys: ['thread:1'] }, { ...BEARER_A, 'x-listen-fire-team': 'nope' });

      expect(res.status).toBe(401);
      expect(listRemoteAdaptersOfType).not.toHaveBeenCalled();
    });
  });

  it('an install with no credential, or an unreadable secret, is skipped rather than fatal', async () => {
    listRemoteAdaptersOfType.mockResolvedValue([
      { ...TEAM_B, credentials_id: null },
      { ...TEAM_B, credentials_id: 'cred-broken' },
      TEAM_A,
    ]);
    loadRemoteAdapterSecret.mockImplementation(async (credentialsId: string) => {
      if (credentialsId === 'cred-broken') throw new Error('cannot decrypt');
      return SECRETS[credentialsId];
    });

    const res = await post('/acme_crm/wake', { keys: ['thread:1'] }, BEARER_A);

    expect(res.status).toBe(202);
    expect(enqueueAwaitWake).toHaveBeenCalledWith(expect.objectContaining({ teamId: A_TEAM }));
  });
});

describe('bodies', () => {
  it.each([
    ['no keys', {}],
    ['an empty list', { keys: [] }],
    ['an empty key', { keys: [''] }],
    ['a non-string key', { keys: [7] }],
    ['more than 1000 keys', { keys: Array.from({ length: 1001 }, (_, i) => `k${i}`) }],
  ])('wake refuses %s with 400', async (_label, body) => {
    const res = await post('/acme_crm/wake', body, BEARER_A);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(enqueueAwaitWake).not.toHaveBeenCalled();
  });

  it.each([
    ['no events', {}],
    ['an empty list', { events: [] }],
    ['an event with a bad changeType', { events: [{ payload: {}, changeType: 'upsert' }] }],
  ])('emit refuses %s with 400', async (_label, body) => {
    const res = await post('/acme_crm/emit', body, BEARER_A);

    expect(res.status).toBe(400);
    expect(captureProviderTriggerEvents).not.toHaveBeenCalled();
  });

  it('a body over 1 MB is refused 413 before anything is authenticated', async () => {
    const res = await fetch(`${baseUrl}/api/public/adapter/acme_crm/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...BEARER_A },
      body: JSON.stringify({ keys: ['x'.repeat(1024 * 1024)] }),
    });

    expect(res.status).toBe(413);
    expect(listRemoteAdaptersOfType).not.toHaveBeenCalled();
    expect(enqueueAwaitWake).not.toHaveBeenCalled();
  });

  it('a body just under 1 MB is read', async () => {
    const res = await post('/acme_crm/wake', { keys: ['x'.repeat(1024 * 1024 - 64)] }, BEARER_A);

    expect(res.status).toBe(202);
  });

  it('a malformed body from an unauthenticated caller is 401, not 400', async () => {
    expect((await post('/acme_crm/wake', { keys: [] })).status).toBe(401);
  });
});

describe('emit', () => {
  it("captures each event against the caller's triggers, queues the receipts, and answers the count", async () => {
    const res = await post('/acme_crm/emit', { events: [EVENT, { ...EVENT, payload: { id: 'co-2' } }] }, BEARER_A);

    expect(res).toEqual({ status: 202, body: { accepted: 2 } });
    expect(captureProviderTriggerEvents).toHaveBeenCalledTimes(2);
    expect(captureProviderTriggerEvents).toHaveBeenCalledWith({
      event: EVENT,
      subscription: { team_id: A_TEAM, credentials_id: 'cred-a', provider: 'ACME_CRM' },
      adapterType: 'acme_crm',
      eventTypes: [{ tag: 'company.created', positionType: 'Company' }],
    });
    expect(resolveAdapter).toHaveBeenCalledTimes(1);
    expect(enqueueCapturedEvents).toHaveBeenCalledWith([
      expect.objectContaining({ storedEventId: 'evt-1' }),
      expect.objectContaining({ storedEventId: 'evt-1' }),
    ]);
    expect(notifyWork).toHaveBeenCalled();
  });

  it('an event no trigger listens for is accepted as zero, with nothing queued', async () => {
    captureProviderTriggerEvents.mockResolvedValue([]);

    const res = await post('/acme_crm/emit', { events: [EVENT] }, BEARER_A);

    expect(res).toEqual({ status: 202, body: { accepted: 0 } });
    expect(enqueueCapturedEvents).toHaveBeenCalledWith([]);
    expect(notifyWork).not.toHaveBeenCalled();
  });

  it('a capture failure still queues what was captured, then answers 500 so the caller retries', async () => {
    captureProviderTriggerEvents
      .mockResolvedValueOnce([{ triggerId: 'trig-1', teamId: A_TEAM, storedEventId: 'evt-1' }])
      .mockRejectedValueOnce(new Error('db down'));

    const res = await post('/acme_crm/emit', { events: [EVENT, EVENT] }, BEARER_A);

    expect(res).toEqual({ status: 500, body: { error: 'capture_failed', accepted: 1, failed: 1 } });
    expect(enqueueCapturedEvents).toHaveBeenCalledWith([expect.objectContaining({ storedEventId: 'evt-1' })]);
  });

  it("a failing listEventTypes still dispatches, undiscriminated", async () => {
    resolveAdapter.mockRejectedValue(new Error('remote down'));

    const res = await post('/acme_crm/emit', { events: [EVENT] }, BEARER_A);

    expect(res.status).toBe(202);
    expect(captureProviderTriggerEvents).toHaveBeenCalledWith(expect.objectContaining({ eventTypes: [] }));
  });
});

describe('wake', () => {
  it('queues one wake per key for the caller’s team and adapter type, and pokes the drain', async () => {
    const res = await post('/acme_crm/wake', { keys: ['thread:1', 'thread:2'] }, BEARER_A);

    expect(res).toEqual({ status: 202, body: { accepted: 2 } });
    expect(enqueueAwaitWake.mock.calls).toEqual([
      [{ adapterType: 'acme_crm', teamId: A_TEAM, correlationKey: 'thread:1' }],
      [{ adapterType: 'acme_crm', teamId: A_TEAM, correlationKey: 'thread:2' }],
    ]);
    expect(notifyWork).toHaveBeenCalled();
  });
});
