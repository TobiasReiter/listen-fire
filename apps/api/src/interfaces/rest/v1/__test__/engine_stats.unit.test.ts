// The engine evidence route: what the movement engines did in this process,
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

import { recordDryRunDuration, resetRustEvalStats, resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';
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
  resetRustEvalStats();
});

describe('GET /system/engine-stats', () => {
  it('refuses a key without the system scope', async () => {
    scopes = ['automation'];
    const res = await fetch(`${baseUrl}/system/engine-stats`);
    expect(res.status).toBe(403);
  });

  it("answers this process's counters, the reasons runs were not admitted among them, and its uptime", async () => {
    rustRunStats.routed = 3;
    rustRunStats.ranWhole = 2;
    rustRunStats.notAdmitted = { 'statement:block': 4, limit_paused: 1 };
    rustRunStats.allReasons = { 'statement:block': 4, block_park: 2, limit_paused: 1 };
    rustRunStats.declined = { expression_does_not_lower: 1 };
    const res = await fetch(`${baseUrl}/system/engine-stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      engine: process.env.MOVEMENT_ENGINE === 'rust' ? 'rust' : 'ts',
      runs: {
        routed: 3,
        admitted: 0,
        ranWhole: 2,
        shimFaults: 0,
        notAdmitted: { 'statement:block': 4, limit_paused: 1 },
        allReasons: { 'statement:block': 4, block_park: 2, limit_paused: 1 },
        declined: { expression_does_not_lower: 1 },
        hostCalls: {},
      },
      evaluator: { notAdmitted: 0, admitted: 0, answered: 0, fallback: {} },
    });
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(Number.isNaN(Date.parse(String(body.since)))).toBe(false);
  });

  it('answers what the admission dry runs found of the runs the TypeScript engine ran, by first and every reason, and by version', async () => {
    const tally = { sampled: 3, admitted: 1, first: { plugin_call: 2 }, all: { plugin_call: 2, 'statement:call': 1 } };
    const none = { sampled: 0, admitted: 0, first: {}, all: {} };
    rustRunStats.dryRun = { firings: 4, faults: 0, ...tally, byVersion: { '3': tally }, byRoute: { run: tally, resume: none, settle: none, fire: none } };
    recordDryRunDuration(1);
    recordDryRunDuration(4);
    const res = await fetch(`${baseUrl}/system/engine-stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      runs: {
        dryRun: {
          firings: 4,
          sampled: 3,
          admitted: 1,
          faults: 0,
          first: { plugin_call: 2 },
          all: { plugin_call: 2, 'statement:call': 1 },
          byVersion: { '3': { sampled: 3, admitted: 1, first: { plugin_call: 2 }, all: { plugin_call: 2, 'statement:call': 1 } } },
          durationMs: { timed: 2, p50: 4, p95: 4, p99: 4, max: 4 },
        },
      },
    });
  });
});
