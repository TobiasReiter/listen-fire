// The external drain tick: the route a scheduler calls when AUTOMATIONS_DRAIN_MODE=external.
// The drain itself is tested with the work table; this pins only the door — scope,
// body validation, and what reaches drainUntilIdle.

import express, { Router } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const drainUntilIdle = jest.fn();
const recordExternalDrainPass = jest.fn();

jest.mock('../../../../services/work/drain', () => ({
  drainUntilIdle: (opts: unknown) => drainUntilIdle(opts),
  recordExternalDrainPass: (result: unknown) => recordExternalDrainPass(result),
}));
jest.mock('../../../../services/context', () => ({ currentContext: jest.fn() }));
jest.mock('../../../../services/system_debug', () => ({ listTgRuns: jest.fn(), getTgRun: jest.fn() }));
jest.mock('../../../../lib/knowledge/orchestrator', () => ({ runConversationTurn: jest.fn() }));
jest.mock('../../../../lib/llm_usage', () => ({ LlmUsageContext: jest.fn() }));
jest.mock('principal', () => ({ currentPrincipal: jest.fn() }));

import { systemRouter } from '../system';

let server: Server;
let baseUrl: string;
let scopes: string[] = [];

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.apiKeyScopes = scopes;
    next();
  });
  app.use('/system', systemRouter as Router);
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
  scopes = ['system'];
});

function tick(body?: unknown) {
  return fetch(`${baseUrl}/system/automations/drain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('POST /system/automations/drain', () => {
  it('refuses a key without the system scope and drains nothing', async () => {
    scopes = ['automation'];
    const res = await tick({ limit: 5 });
    expect(res.status).toBe(403);
    expect(drainUntilIdle).not.toHaveBeenCalled();
  });

  it('drains with the body limit and answers with the drain result', async () => {
    const result = { claimed: 3, ran: 2, recovered: 1, failed: 0, deferred: 0, claimFailed: false };
    drainUntilIdle.mockResolvedValue(result);

    const res = await tick({ limit: 5, maxPasses: 2 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(drainUntilIdle).toHaveBeenCalledWith({
      owner: expect.stringMatching(/^http:/),
      limit: 5,
      maxPasses: 2,
    });
    expect(recordExternalDrainPass).toHaveBeenCalledWith(result);
  });

  it('drains with the defaults when no body is sent', async () => {
    drainUntilIdle.mockResolvedValue({ claimed: 0, ran: 0, recovered: 0, failed: 0, deferred: 0, claimFailed: false });
    const res = await tick();
    expect(res.status).toBe(200);
    expect(drainUntilIdle).toHaveBeenCalledWith({ owner: expect.stringMatching(/^http:/) });
  });

  it('rejects a malformed body without draining', async () => {
    const res = await tick({ limit: 0 });
    expect(res.status).toBe(400);
    expect(drainUntilIdle).not.toHaveBeenCalled();
    expect(recordExternalDrainPass).not.toHaveBeenCalled();
  });

  it('drains on any instance: two overlapping ticks both drain', async () => {
    let finish: () => void = () => {};
    drainUntilIdle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ claimed: 1, ran: 1, recovered: 0, failed: 0, deferred: 0, claimFailed: false });
        }),
    );
    drainUntilIdle.mockResolvedValueOnce({ claimed: 0, ran: 0, recovered: 0, failed: 0, deferred: 0, claimFailed: false });

    const first = tick({});
    const second = await tick({});
    finish();

    expect(second.status).toBe(200);
    expect((await first).status).toBe(200);
    expect(drainUntilIdle).toHaveBeenCalledTimes(2);
  });

  it('caps a tick at 100 rows a pass and 50 passes', async () => {
    drainUntilIdle.mockResolvedValue({ claimed: 0, ran: 0, recovered: 0, failed: 0, deferred: 0, claimFailed: false });

    expect((await tick({ limit: 101 })).status).toBe(400);
    expect((await tick({ maxPasses: 51 })).status).toBe(400);
    expect(drainUntilIdle).not.toHaveBeenCalled();

    expect((await tick({ limit: 100, maxPasses: 50 })).status).toBe(200);
    expect(drainUntilIdle).toHaveBeenCalledTimes(1);
  });
});
