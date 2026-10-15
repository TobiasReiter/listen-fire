// The Listen-Fire Slack app's Events door routes each delivery by the envelope
// team_id → the app_id='listen-fire' install for that workspace → its Listen-Fire team +
// credential, then dispatches with that credential (a real BYO-style dispatch:
// the credential is both the trigger-matching key and the send identity). A
// workspace with no install is dropped. Plus the route's signature auth.

import crypto from "node:crypto";

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// external_service_credentials lookup — keyed by the `identifier` (teamId:<id>).
const installByIdentifier = new Map<string, { id: string; team_id: string }>();
jest.mock('../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: () => {
      const conds: Record<string, unknown> = {};
      const chain = {
        where(col: string, _op: string, val: unknown) {
          conds[col] = val;
          return chain;
        },
        select() {
          return chain;
        },
        async executeTakeFirst() {
          return installByIdentifier.get(String(conds.identifier));
        },
      };
      return chain;
    },
  });
  return { getQb: qb, getCoreQb: qb, getAutomationsQb: qb };
});

const dispatchCalls: Array<{ team: string; cred: string | null; adapter: string }> = [];
jest.mock('../handler', () => ({
  dispatchToProviderTriggers: jest.fn(async (input: any) => {
    dispatchCalls.push({
      team: input.subscription.team_id,
      cred: input.subscription.credentials_id,
      adapter: input.adapterType,
    });
  }),
}));
jest.mock('../../movement_engine/await_wake', () => ({
  enqueueAwaitWakes: jest.fn(async (input: unknown) => {
    wakeCalls.push(input);
  }),
}));

const wakeCalls: unknown[] = [];
const wakeKeys = jest.fn(async (_input: { raw: unknown }) => ['C1:0.9']);
jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(async () => ({ adapterType: 'slack', wakeKeys })),
}));

import { handleSlackEventsInbound } from '../slack_events';
import { verifySlackEventsRequest } from '../../../interfaces/rest/slackEvents';

const TEAM = '00000000-0000-4000-8000-000000000001';

function eventCallback(teamId: string) {
  return {
    type: 'event_callback',
    team_id: teamId,
    event: { type: 'message', user: 'U1', channel: 'C1', ts: '1.0', text: 'hi' },
  };
}

beforeEach(() => {
  installByIdentifier.clear();
  dispatchCalls.length = 0;
  wakeCalls.length = 0;
  wakeKeys.mockClear();
});

describe('handleSlackEventsInbound — team_id routing', () => {
  it('dispatches to the workspace install (its Listen-Fire team + credential)', async () => {
    installByIdentifier.set('teamId:T_SLACK', { id: 'cred-slack', team_id: TEAM });
    const result = await handleSlackEventsInbound(eventCallback('T_SLACK'));
    expect(result.classification).toBe('dispatched');
    expect(dispatchCalls).toEqual([{ team: TEAM, cred: 'cred-slack', adapter: 'slack' }]);
  });

  it("queues the adapter's wake keys for the delivery, beside dispatch", async () => {
    installByIdentifier.set('teamId:T_SLACK', { id: 'cred-slack', team_id: TEAM });
    const raw = eventCallback('T_SLACK');
    await handleSlackEventsInbound(raw);
    expect(wakeKeys).toHaveBeenCalledWith({ raw });
    expect(wakeCalls).toEqual([{ adapterType: 'slack', teamId: TEAM, correlationKeys: ['C1:0.9'] }]);
  });

  it('drops a workspace with no Listen-Fire install', async () => {
    const result = await handleSlackEventsInbound(eventCallback('T_UNKNOWN'));
    expect(result.classification).toBe('unknown_workspace');
    expect(dispatchCalls).toHaveLength(0);
  });

  it('drops a delivery with no team_id', async () => {
    const result = await handleSlackEventsInbound({ type: 'event_callback', event: { type: 'message' } });
    expect(result.classification).toBe('no_team');
    expect(dispatchCalls).toHaveLength(0);
  });
});

describe('verifySlackEventsRequest — signature auth (fail-closed)', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  function signed(body: Buffer, secret: string, ts = '1700000000'): string {
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
    return `${ts}:${sig}`;
  }

  it('authorizes a correctly-signed request', () => {
    process.env.SLACK_MOVEMENTS_SIGNING_SECRET = 'shh';
    const body = Buffer.from(JSON.stringify(eventCallback('T')));
    expect(verifySlackEventsRequest(body, signed(body, 'shh'))).toEqual({ authorized: true });
  });

  it('rejects a bad signature', () => {
    process.env.SLACK_MOVEMENTS_SIGNING_SECRET = 'shh';
    const body = Buffer.from('{}');
    expect(verifySlackEventsRequest(body, signed(body, 'wrong'))).toEqual({
      authorized: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects everything when no secret is set in production', () => {
    delete process.env.SLACK_MOVEMENTS_SIGNING_SECRET;
    process.env.NODE_ENV = 'production';
    expect(verifySlackEventsRequest(Buffer.from('{}'), '')).toEqual({
      authorized: false,
      reason: 'no_secret',
    });
  });

  it('rejects an unsigned delivery OUTSIDE production too, unless it was opted into', () => {
    delete process.env.SLACK_MOVEMENTS_SIGNING_SECRET;
    delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
    process.env.NODE_ENV = 'development';
    expect(verifySlackEventsRequest(Buffer.from('{}'), '')).toEqual({
      authorized: false,
      reason: 'no_secret',
    });

    process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';
    expect(verifySlackEventsRequest(Buffer.from('{}'), '')).toEqual({ authorized: true });
  });
});
