// The engine evidence route: what the Rust engine did in this process,
// behind the system scope like its sibling admin routes.

import { createServer, type Server } from 'node:http';

import express, { Router } from 'express';

import type { AddressInfo } from 'node:net';

jest.mock('../../../../services/work/drain', () => ({ drainUntilIdle: jest.fn(), recordExternalDrainPass: jest.fn() }));
jest.mock('../../../../services/context', () => ({ currentContext: jest.fn() }));
jest.mock('../../../../services/system_debug', () => ({ listTgRuns: jest.fn(), getTgRun: jest.fn() }));
jest.mock('../../../../lib/knowledge/orchestrator', () => ({ runConversationTurn: jest.fn() }));
jest.mock('../../../../lib/llm_usage', () => ({ LlmUsageContext: jest.fn() }));
jest.mock('principal', () => ({ currentPrincipal: jest.fn() }));

import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';
import { systemRouter } from '../system';

let server: Server;
let baseUrl: string;
let scopes: string[] = [];

beforeAll((done) => {
  const app = express();
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
  scopes = ['system'];
  resetRustRunStats();
});

describe('GET /system/engine-stats', () => {
  it('refuses a key without the system scope', async () => {
    scopes = ['automation'];
    const res = await fetch(`${baseUrl}/system/engine-stats`);
    expect(res.status).toBe(403);
  });

  it("answers this process's counters, the reasons segments were not run among them, and its uptime", async () => {
    rustRunStats.segments = 3;
    rustRunStats.unsupported = { event_does_not_cross: 1 };
    rustRunStats.endedAtCheck = 2;
    const res = await fetch(`${baseUrl}/system/engine-stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      uptimeSeconds: expect.any(Number),
      since: expect.any(String),
      runs: { segments: 3, unsupported: { event_does_not_cross: 1 }, endedAtCheck: 2, failedCheckMidRun: 0, shimFaults: 0, hostCalls: {} },
    });
    expect(Number.isNaN(Date.parse(String(body.since)))).toBe(false);
  });
});
