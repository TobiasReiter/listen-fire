// The shared built-in Telegram bot door's REST contract after the
// capture-then-ack split. Drives the real router over an in-process HTTP server
// with the shared-bot service and the work drain mocked, so what's under test is
// the route's own decisions:
//
//   • a production delivery queues its work rows BEFORE the ack, and pokes the
//     drain after it,
//   • a test-harness delivery drains its rows and reports the outcome inline,
//   • the always-200 policy survives auth refusals and a thrown service; an
//     unparseable body (400, unchanged) and rows that could not be queued (500,
//     so Telegram redelivers) are the exceptions.
//
// Telegram permits answering a webhook with a Bot API method call in the
// RESPONSE BODY. This door has never used that (replies are explicit Bot API
// calls out of `handleStart`), which is what makes deferring the dispatch safe:
// nothing the sender sees depends on work done after the ack.

import { createServer, type Server } from 'node:http';

import express, { type Router } from 'express';

import type { AddressInfo } from 'node:net';

const handleSharedBotInbound = jest.fn();
const drainUntilIdle = jest.fn();
const notifyWork = jest.fn();
const awaitTeamWorkSettled = jest.fn();

jest.mock('../../../services/work/drain', () => ({
  drainUntilIdle: (input: unknown) => drainUntilIdle(input),
  notifyWork: () => notifyWork(),
}));

jest.mock('../../../services/webhook_sync/telegram_builtin', () => ({
  handleSharedBotInbound: (raw: unknown) => handleSharedBotInbound(raw),
}));

// The real harness sequence runs over a mocked drain and settle wait.
jest.mock('../../../services/work/store', () => ({
  awaitTeamWorkSettled: (input: unknown) => awaitTeamWorkSettled(input),
}));

jest.mock('../../../services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { telegramBuiltinRouter } from '../telegramBuiltin';

let server: Server;
let baseUrl: string;

const ORIGINAL_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_BYPASS = process.env.ALLOW_UNSIGNED_WEBHOOKS;

beforeAll((done) => {
  const app = express();
  app.use('/api/public/telegram', express.raw({ type: '*/*' }), telegramBuiltinRouter as Router);
  server = createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  if (ORIGINAL_SECRET === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_BYPASS === undefined) delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
  else process.env.ALLOW_UNSIGNED_WEBHOOKS = ORIGINAL_BYPASS;
  process.env.NODE_ENV = ORIGINAL_NODE_ENV ?? 'test';
  server.close(() => done());
});

beforeEach(() => {
  handleSharedBotInbound.mockReset();
  drainUntilIdle.mockReset().mockResolvedValue({ claimed: 0, ran: 0, recovered: 0, failed: 0 });
  notifyWork.mockReset();
  awaitTeamWorkSettled.mockReset().mockResolvedValue(true);
  // No secret configured + the explicit unsigned opt-in → the door is open, so
  // the tests below are about the ack boundary rather than the gate (the gate
  // has its own suite in services/webhook_sync/__test__/telegram-shared-bot).
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';
  process.env.NODE_ENV = 'test';
});

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/api/public/telegram/builtin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const UPDATE = { update_id: 1, message: { message_id: 42, from: { id: 999 }, text: 'hi' } };

describe('POST /builtin — production deliveries', () => {
  it('queues the work rows before acking, then pokes the drain', async () => {
    const order: string[] = [];
    handleSharedBotInbound.mockResolvedValue({
      result: { ok: true, classification: 'message', routedTeamIds: ['team-A'] },
      enqueueDeferred: async () => {
        order.push('enqueue');
        return { readOutcome: async () => ({ ok: true, classification: 'message', routedTeamIds: [] }) };
      },
    });
    notifyWork.mockImplementation(() => order.push('notify'));

    const res = await post(UPDATE);

    expect(res.status).toBe(200);
    // The pre-ack routing, not a drained outcome: the rows run off the request.
    expect(res.body).toEqual({ ok: true, classification: 'message', routedTeamIds: ['team-A'] });
    expect(order).toEqual(['enqueue', 'notify']);
    expect(drainUntilIdle).not.toHaveBeenCalled();
  });

  it('a delivery whose rows could not be queued is a 500, so Telegram redelivers', async () => {
    handleSharedBotInbound.mockResolvedValue({
      result: { ok: true, classification: 'message', routedTeamIds: ['team-A'] },
      enqueueDeferred: async () => {
        throw new Error('database down');
      },
    });

    const res = await post(UPDATE);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'enqueue_failed' });
    expect(notifyWork).not.toHaveBeenCalled();
  });

  it('a delivery with nothing to run (a handshake) answers its result directly', async () => {
    handleSharedBotInbound.mockResolvedValue({
      result: { ok: true, classification: 'start', bind: { ok: true, email: 'ada@example.com' } },
    });

    const res = await post({ message: { from: { id: 999 }, text: '/start tok' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      classification: 'start',
      bind: { ok: true, email: 'ada@example.com' },
    });
  });
});

describe('POST /builtin — test-harness deliveries stay synchronous', () => {
  it('drains the rows before acking and answers with the outcome (the dev-loop contract)', async () => {
    const order: string[] = [];
    handleSharedBotInbound.mockResolvedValue({
      result: { ok: true, classification: 'message', routedTeamIds: ['team-A', 'team-B'] },
      awaitDeferred: true,
      enqueueDeferred: async () => {
        order.push('enqueue');
        return {
          teamIds: ['team-A', 'team-B'],
          readOutcome: async () => {
            order.push('read');
            return { ok: true, classification: 'message', routedTeamIds: ['team-B'] };
          },
        };
      },
    });
    drainUntilIdle.mockImplementation(async () => {
      order.push('drain');
      return { claimed: 1, ran: 1, recovered: 0, failed: 0 };
    });

    awaitTeamWorkSettled.mockImplementation(async () => {
      order.push('settle');
      return true;
    });

    const res = await post(UPDATE);

    expect(order).toEqual(['enqueue', 'drain', 'drain', 'settle', 'settle', 'read']);
    expect(awaitTeamWorkSettled.mock.calls.map(([input]) => input.teamId)).toEqual(['team-A', 'team-B']);
    // Each routed team's own rows only: never another tenant's due work.
    expect(drainUntilIdle.mock.calls.map(([input]) => input)).toEqual([
      { owner: 'door', teamId: 'team-A' },
      { owner: 'door', teamId: 'team-B' },
    ]);
    expect(notifyWork).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    // The dispatch outcome, not the capture list — what it always reported.
    expect(res.body).toEqual({ ok: true, classification: 'message', routedTeamIds: ['team-B'] });
  });
});

describe('POST /builtin — the always-200 policy is unchanged', () => {
  it('an unauthorized delivery is a 200 carrying the classification', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'the-real-secret';

    const res = await post(UPDATE, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, classification: 'unauthorized' });
    expect(handleSharedBotInbound).not.toHaveBeenCalled();
  });

  it('a thrown service is a 200 with the error in the body', async () => {
    handleSharedBotInbound.mockRejectedValue(new Error('capture exploded'));

    const res = await post(UPDATE);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      classification: 'no_message',
      error: 'capture exploded',
    });
  });

  it('an unparseable body is still the one 400', async () => {
    const res = await post('{not json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_json' });
  });
});
