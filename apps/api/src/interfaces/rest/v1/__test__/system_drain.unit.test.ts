// The external drain tick: the route a scheduler calls when AUTOMATIONS_DRAIN_MODE=external.
// The drain itself is tested with the work table; this pins only the door — scope,
// body validation, and what reaches drainUntilIdle.

import express, { Router } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const drainUntilIdle = jest.fn();

jest.mock('../../../../services/work/drain', () => ({
  drainUntilIdle: (opts: unknown) => drainUntilIdle(opts),
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
    const result = { claimed: 3, ran: 2, recovered: 1, failed: 0 };
    drainUntilIdle.mockResolvedValue(result);

    const res = await tick({ limit: 5, maxPasses: 2 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(drainUntilIdle).toHaveBeenCalledWith({
      owner: expect.stringMatching(/^http:/),
      limit: 5,
      maxPasses: 2,
    });
  });

  it('drains with the defaults when no body is sent', async () => {
    drainUntilIdle.mockResolvedValue({ claimed: 0, ran: 0, recovered: 0, failed: 0 });
    const res = await tick();
    expect(res.status).toBe(200);
    expect(drainUntilIdle).toHaveBeenCalledWith({ owner: expect.stringMatching(/^http:/) });
  });

  it('rejects a malformed body without draining', async () => {
    const res = await tick({ limit: 0 });
    expect(res.status).toBe(400);
    expect(drainUntilIdle).not.toHaveBeenCalled();
  });
});
