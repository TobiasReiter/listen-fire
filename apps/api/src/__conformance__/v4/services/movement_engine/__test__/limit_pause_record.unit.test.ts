// The database side of a limit pause (limit_pause.ts), with the database faked:
// marking a run paused says so ONCE (the `Run Paused` system event), and what a
// paused run's row holds reads back as its status.

const updates: Array<{ marked: boolean }> = [];
let markResult: { id: string } | undefined = { id: 'run-1' };

function chain(): object {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'executeTakeFirst') {
        return async () => {
          updates.push({ marked: markResult !== undefined });
          return markResult;
        };
      }
      if (prop === 'execute') return async () => [];
      return () => chain();
    },
  };
  return new Proxy({}, handler);
}

jest.mock('../../../lib/kysely', () => ({
  getAutomationsQb: jest.fn(() => chain()),
  getQb: jest.fn(() => chain()),
}));
jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../translation_graph/storage/tg_table', () => ({
  loadTriggerById: jest.fn(async () => ({ movementId: null })),
}));
const recordSystemEvent = jest.fn(async () => undefined);
jest.mock('../../translation_graph/adapters/system/events', () => ({
  recordSystemEvent: (...args: unknown[]) => recordSystemEvent(...(args as [])),
  webBaseUrl: () => 'http://web.test',
}));
jest.mock('../../translation_graph/movement/execute', () => ({ resumeMovementFiring: jest.fn() }));
jest.mock('../../translation_graph/movement/version_store', () => ({ loadPinnedVersion: jest.fn() }));

import { describeLimitPause, markRunLimitPaused, readLimitPause } from '../limit_pause';
import { RUN_PAUSED } from '../../translation_graph/adapters/system/types';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TeamId } from '../../../generated/kysely/core/Team';

const DOLLAR = 1_000_000;
const pause = { limit: 'cost' as const, capMicrodollars: 5 * DOLLAR, spentMicrodollars: 5.2 * DOLLAR };
const input = {
  runId: 'run-1' as TriggerRunId,
  teamId: 'team-1' as TeamId,
  triggerId: 'trigger-1',
  pause,
};

beforeEach(() => {
  updates.length = 0;
  recordSystemEvent.mockClear();
  markResult = { id: 'run-1' };
});

describe('marking a run paused', () => {
  it('records a Run Paused event saying what it spent and the limit', async () => {
    await markRunLimitPaused(input);
    expect(recordSystemEvent).toHaveBeenCalledTimes(1);
    const [event] = recordSystemEvent.mock.calls[0] as unknown as [
      { teamId: string; kind: unknown; payload: { runId: string; reason: string; url: string } },
    ];
    expect(event.kind).toBe(RUN_PAUSED);
    expect(event.teamId).toBe('team-1');
    expect(event.payload.runId).toBe('run-1');
    expect(event.payload.reason).toMatch(/^Paused: cost limit reached\. This run has spent \$5\.20/);
    expect(event.payload.reason).toContain('MOVEMENT_MAX_RUN_COST_USD is $5.00');
  });

  it('says nothing when the run was already paused — one event per pause', async () => {
    markResult = undefined;
    await markRunLimitPaused(input);
    expect(recordSystemEvent).not.toHaveBeenCalled();
  });
});

describe("a paused run's row", () => {
  it('reads back as its pause, and describes itself', () => {
    const stored = { ...pause, pausedAt: '2026-10-05T10:00:00.000Z' };
    expect(readLimitPause(stored)).toEqual(stored);
    expect(describeLimitPause(stored)).toContain('Resume the run to carry on');
  });

  it('says a small cap as it was set, not rounded to cents', () => {
    const text = describeLimitPause({ capMicrodollars: 16_000, spentMicrodollars: 25_400 });
    expect(text).toContain('has spent $0.0254 on model calls');
    expect(text).toContain('MOVEMENT_MAX_RUN_COST_USD is $0.016.');
  });

  it('reads as not paused when empty or unreadable', () => {
    expect(readLimitPause(null)).toBeNull();
    expect(readLimitPause({ limit: 'calls' })).toBeNull();
  });
});
