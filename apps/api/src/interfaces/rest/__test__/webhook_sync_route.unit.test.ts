// The webhook_sync door's REST contract after the capture-then-ack split.
// Drives the real router over an in-process HTTP server (same idiom as
// connect_handshake.unit.test.ts) with the handler and the work drain mocked,
// so what's under test is the route's own decisions:
//
//   • the Slack url_verification handshake still short-circuits FIRST,
//   • a production delivery queues its work rows BEFORE the ack, and pokes the
//     drain after it,
//   • a delivery whose wakes cannot be queued is answered 500, never acked,
//   • a test-harness delivery drains its rows and reports dispatch errors inline,
//   • phase-1 refusals keep their status codes (404/400/401).

import { createServer, type Server } from 'node:http';

import express, { type Router } from 'express';

import type { AddressInfo } from 'node:net';

const handleInboundWebhook = jest.fn();
const drainUntilIdle = jest.fn();
const notifyWork = jest.fn();
const awaitTeamWorkSettled = jest.fn();

jest.mock('../../../services/webhook_sync/handler', () => ({
  handleInboundWebhook: (input: unknown) => handleInboundWebhook(input),
}));

jest.mock('../../../services/work/drain', () => ({
  drainUntilIdle: (input: unknown) => drainUntilIdle(input),
  notifyWork: () => notifyWork(),
}));

// The real harness sequence runs over a mocked drain and settle wait.
jest.mock('../../../services/work/store', () => ({
  awaitTeamWorkSettled: (input: unknown) => awaitTeamWorkSettled(input),
}));

jest.mock('../../../services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { webhookSyncRouter } from '../webhookSync';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api/public/webhook-sync', express.raw({ type: '*/*' }), webhookSyncRouter as Router);
  server = createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
  drainUntilIdle.mockResolvedValue({ claimed: 0, ran: 0, recovered: 0, failed: 0 });
  awaitTeamWorkSettled.mockResolvedValue(true);
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}/api/public/webhook-sync${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function outcome(eventsProcessed: number, perEventErrors: unknown[] = []) {
  return { teamIds: ['team-1'], readOutcome: async () => ({ eventsProcessed, perEventErrors }) };
}

describe('POST /:provider/:subscriptionId — production deliveries', () => {
  it('queues the work rows before acking, then pokes the drain', async () => {
    const order: string[] = [];
    handleInboundWebhook.mockResolvedValue({
      ok: true,
      eventsProcessed: 3,
      enqueueDeferred: async () => {
        order.push('enqueue');
        return outcome(3);
      },
    });
    notifyWork.mockImplementation(() => order.push('notify'));

    const res = await post('/attio/sub-1', { any: 'payload' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, eventsProcessed: 3 });
    expect(order).toEqual(['enqueue', 'notify']);
    // The rows run off the request; the door never drains for a production sender.
    expect(drainUntilIdle).not.toHaveBeenCalled();
  });

  it('never leaks per-event errors to a production sender', async () => {
    handleInboundWebhook.mockResolvedValue({
      ok: true,
      eventsProcessed: 1,
      enqueueDeferred: async () => outcome(0, [{ event: {}, error: 'boom' }]),
    });

    const res = await post('/attio/sub-1', { any: 'payload' });

    expect(res.body).toEqual({ ok: true, eventsProcessed: 1 });
  });
});

describe('POST /:provider/:subscriptionId — a delivery whose wakes cannot be queued', () => {
  it('answers 500 and never acks, so the sender retries', async () => {
    handleInboundWebhook.mockResolvedValue({
      ok: true,
      eventsProcessed: 1,
      enqueueDeferred: async () => {
        throw new Error('wake door down');
      },
    });

    const res = await post('/attio/sub-1', { any: 'payload' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(notifyWork).not.toHaveBeenCalled();
  });
});

describe('POST /:provider/:subscriptionId — test-harness deliveries', () => {
  it('drains the rows before acking and reports dispatch errors inline (the dev-loop contract)', async () => {
    const order: string[] = [];
    handleInboundWebhook.mockResolvedValue({
      ok: true,
      eventsProcessed: 2,
      awaitDeferred: true,
      enqueueDeferred: async () => {
        order.push('enqueue');
        return {
          teamIds: ['team-1'],
          readOutcome: async () => {
            order.push('read');
            return {
              eventsProcessed: 1,
              perEventErrors: [{ event: { payload: {} }, error: 'movement blew up' }],
            };
          },
        };
      },
    });
    drainUntilIdle.mockImplementation(async () => {
      order.push('drain');
      return { claimed: 1, ran: 1, recovered: 0, failed: 0 };
    });
    // Rows another drainer claimed are waited out too.
    awaitTeamWorkSettled.mockImplementation(async () => {
      order.push('settle');
      return true;
    });

    const res = await post('/attio/sub-1', { any: 'payload' });

    expect(order).toEqual(['enqueue', 'drain', 'settle', 'read']);
    expect(awaitTeamWorkSettled).toHaveBeenCalledWith({ teamId: 'team-1', timeoutMs: 30_000 });
    expect(drainUntilIdle).toHaveBeenCalledWith({ owner: 'door', teamId: 'team-1' });
    expect(notifyWork).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      // The dispatch outcome, not the capture count — what it always reported.
      eventsProcessed: 1,
      perEventErrors: [{ event: { payload: {} }, error: 'movement blew up' }],
    });
  });

  it('omits perEventErrors when the harness delivery ran clean', async () => {
    handleInboundWebhook.mockResolvedValue({
      ok: true,
      eventsProcessed: 1,
      awaitDeferred: true,
      enqueueDeferred: async () => outcome(1),
    });

    expect((await post('/attio/sub-1', {})).body).toEqual({ ok: true, eventsProcessed: 1 });
  });
});

describe('POST /:provider/:subscriptionId — pre-ack refusals are unchanged', () => {
  it.each([
    ['unknown_provider', 404],
    ['subscription_not_found', 404],
    ['provider_mismatch', 400],
    ['signature_invalid', 401],
  ])('%s → %i', async (error, status) => {
    handleInboundWebhook.mockResolvedValue({ ok: false, eventsProcessed: 0, error });

    const res = await post('/attio/sub-1', {});

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error });
  });

  it('the Slack url_verification challenge short-circuits before the handler', async () => {
    handleInboundWebhook.mockResolvedValue({ ok: true, eventsProcessed: 0 });

    const res = await post('/slack/sub-1', { type: 'url_verification', challenge: 'abc-123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: 'abc-123' });
    expect(handleInboundWebhook).not.toHaveBeenCalled();
  });
});
