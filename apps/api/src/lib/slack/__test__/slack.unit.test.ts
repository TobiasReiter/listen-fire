// Ops-event tests for sendSlackNotification: every operator-facing notification
// writes a flat ops event, with the feed title, team attribution and
// suppressed-type handling exercised here.

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Slack webhook — prevent real HTTP calls
jest.mock('@slack/webhook', () => ({
  IncomingWebhook: class {
    async send() {}
  },
}));
jest.mock('@slack/web-api', () => ({
  WebClient: class {
    async apiCall() { return {}; }
  },
}));

// ── credentials / decrypt (not exercised in these tests) ─────────────────────
jest.mock('../../credentials', () => ({ decryptToken: jest.fn() }));

// ── adapters registry: the shim reads it for the Slack client ────────────────
jest.mock('../../../adapters/registry', () => ({
  services: { slackMonitoring: null },
}));

// ── app context — stable stub, overridable per test for the no-context case ──
let unsafeContextOverride: { id: string } | undefined = {
  id: 'ctx-req-1',
};
jest.mock('../../../services/context', () => ({
  unsafeCurrentContext: () => unsafeContextOverride,
}));

// ── Kysely: the shim only reads credentials here ─────────────────────────────
jest.mock('../../kysely', () => ({
  getQb: () => ({
    selectFrom: () => ({
      where: () => ({
        select: () => ({ executeTakeFirst: async () => undefined }),
      }),
    }),
    updateTable: () => ({
      set: () => ({ where: () => ({ execute: async () => {} }) }),
    }),
    insertInto: () => ({
      values: () => ({ returning: () => ({ executeTakeFirstOrThrow: async () => ({ id: 'evt-1' }) }), execute: async () => {} }),
    }),
  }),
  getCoreQb: () => ({
    selectFrom: () => ({
      where: () => ({
        select: () => ({ executeTakeFirst: async () => undefined }),
      }),
    }),
    updateTable: () => ({
      set: () => ({ where: () => ({ execute: async () => {} }) }),
    }),
    insertInto: () => ({
      values: () => ({ returning: () => ({ executeTakeFirstOrThrow: async () => ({ id: 'evt-1' }) }), execute: async () => {} }),
    }),
  }),
}));

// ── ops/emit ───────────────────────────────────────────────────────────────────
const mockEmitOpsEvent = jest.fn().mockResolvedValue('event-1');
jest.mock('../../ops/emit', () => ({
  emitOpsEvent: (...args: unknown[]) => mockEmitOpsEvent(...args),
}));

// ── ops/push (transitive dep of ops/emit) ─────────────────────────────────────
jest.mock('../../ops/push', () => ({
  dispatchPush: jest.fn().mockResolvedValue(undefined),
}));

import { sendSlackNotification } from '../index';

function flush() {
  return new Promise<void>((r) => setImmediate(r));
}

beforeEach(() => {
  unsafeContextOverride = { id: 'ctx-req-1' };
  mockEmitOpsEvent.mockClear();
});

describe('sendSlackNotification ops events', () => {
  it('writes a flat ops event for a notification', async () => {
    await sendSlackNotification({ type: 'SUPPORT', text: 'Support alert' });
    await flush();

    expect(mockEmitOpsEvent).toHaveBeenCalled();
  });

  it('forwards teamId to the ops event so the admin feed can attribute the team', async () => {
    await sendSlackNotification({ type: 'OVI', text: 'New WhatsApp message', teamId: 'team-xyz' });
    await flush();

    expect(mockEmitOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-xyz' }),
    );
  });

  it('uses opsTitle for the feed while leaving the Slack text (in detail) intact', async () => {
    await sendSlackNotification({
      type: 'ONBOARDING',
      text: ':tada: Ada (ada@x.com) signed up via self-serve (team abc-123)',
      opsTitle: 'Ada (ada@x.com) signed up via self-serve',
    });
    await flush();

    expect(mockEmitOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Ada (ada@x.com) signed up via self-serve',
        detail: expect.objectContaining({
          text: ':tada: Ada (ada@x.com) signed up via self-serve (team abc-123)',
        }),
      }),
    );
  });

  it('falls back to the first line of text when opsTitle is omitted', async () => {
    await sendSlackNotification({ type: 'SUPPORT', text: 'Sync broke\nmore detail' });
    await flush();

    expect(mockEmitOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Sync broke' }),
    );
  });

  it('does not throw with no ambient AsyncLocalStorage context at all (bare worker loop)', async () => {
    unsafeContextOverride = undefined; // no ALS store — currentContext() would throw here

    // Would reject with "Async local storage undefined" pre-fix; must resolve.
    await sendSlackNotification({ type: 'SUPPORT', text: 'all sends failed — notice lost' });
    await flush();

    expect(mockEmitOpsEvent).toHaveBeenCalled();
  });

  it('still records an ops event for Slack-suppressed types (OVI / ONBOARDING)', async () => {
    // OVI and ONBOARDING no longer ping Slack, but they must remain in the
    // Operations Feed via emitOpsEvent.
    for (const type of ['OVI', 'ONBOARDING'] as const) {
      mockEmitOpsEvent.mockClear();
      await sendSlackNotification({ type, text: `${type} event` });
      await flush();
      expect(mockEmitOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type }),
      );
    }
  });
});
