// The Slack interactivity door, end to end through the route: a signed
// block_actions POST in, an ack out at the payload's `response_url`.
//
// Three claims carry it:
//   1. The outcome the router returns is what the tapper is told — every
//      refusal is SAID, never swallowed into a silent 200.
//   2. The message is edited only when the tap SERVED it (`interactionServed`):
//      recorded + single-use. A repeatable callback's message keeps its
//      controls; a refusal never rewrites what the first tapper is looking at.
//   3. Legacy ask answer links still resolve through the ask door, unchanged.
//
// The router and the ask door are mocked — what is under test is the door.

import { createServer, type Server } from 'node:http';

import express, { type Router } from 'express';

import type { AddressInfo } from 'node:net';
import type { CallbackFireOutcome } from '../../../services/movement_engine/callback_fire';
import type { CallbackRecord } from '../../../services/movement_engine/callback_store';

const fireCallback = jest.fn<Promise<CallbackFireOutcome>, [unknown]>();
const answerAskByToken = jest.fn();

jest.mock('../../../services/movement_engine/callback_fire', () => ({
  ...jest.requireActual('../../../services/movement_engine/callback_fire'),
  fireCallback: (input: unknown) => fireCallback(input),
}));
jest.mock('../../../services/translation_graph/adapters/ask/answer_door', () => ({
  answerAskByToken: (...args: unknown[]) => answerAskByToken(...args),
}));
// The signature is Slack's business, not this door's — verified by
// slackEvents' own suite.
jest.mock('../slackEvents', () => ({
  verifySlackEventsRequest: () => ({ authorized: true }),
}));

import { slackInteractivityRouter } from '../slackInteractivity';

let server: Server;
let baseUrl: string;

function record(overrides: Partial<CallbackRecord> = {}): CallbackRecord {
  return {
    id: 'cb_abc',
    teamId: 'team-1',
    runId: 'run-1',
    address: 's1',
    params: [],
    state: { version: 1, address: 's1', bindingName: null, scopeChain: [] },
    calls: [],
    singleUse: true,
    expiresAt: null,
    status: 'live',
    createdAt: new Date('2026-07-31T09:00:00.000Z'),
    firedAt: null,
    revokedAt: null,
    ...overrides,
  } as CallbackRecord;
}

/** Every POST the door made to the payload's response_url, in order. */
let acks: Record<string, unknown>[] = [];
const RESPONSE_URL = 'https://hooks.slack.example/response/1';

beforeAll((done) => {
  const app = express();
  app.use('/api/public/slack-actions', express.raw({ type: '*/*' }), slackInteractivityRouter as Router);
  server = createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

/** The real one — the test's own POSTs at the loopback server must still go
 *  out; only the response_url ack is intercepted. */
const realFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  acks = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) !== RESPONSE_URL) return await realFetch(url, init);
    acks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('ok');
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** POST one block action, then wait for the off-request half (the door acks
 *  Slack first and does the work in a `setImmediate`). */
async function tap(action: Record<string, unknown>): Promise<void> {
  const payload = {
    type: 'block_actions',
    response_url: RESPONSE_URL,
    actions: [action],
  };
  const res = await fetch(`${baseUrl}/api/public/slack-actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
  });
  expect(res.status).toBe(200);
  // Two turns: the setImmediate, then the ack's own await chain.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('a tap that fires a callback', () => {
  it('tells the tapper something went wrong when firing throws, rather than nothing', async () => {
    fireCallback.mockRejectedValue(new Error('lease table unreachable'));

    await tap({ type: 'button', action_id: 'ship', value: 'cb_abc' });

    expect(acks).toEqual([
      { response_type: 'ephemeral', replace_original: false, text: 'Something went wrong recording that.' },
    ]);
  });

  it('fires by id with no supplied value, and replaces the message on a single-use recorded fire', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: record({ singleUse: true }) });

    await tap({ type: 'button', action_id: 'ship', value: 'cb_abc' });

    expect(fireCallback).toHaveBeenCalledWith({ id: 'cb_abc', values: {} });
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({
      replace_original: true,
      text: 'Thanks — that has been recorded.',
    });
  });

  it('passes a datepicker`s pick as the ONE supplied value, unnamed', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: record() });

    await tap({ type: 'datepicker', action_id: 'cb_date', selected_date: '2026-08-15' });

    expect(fireCallback).toHaveBeenCalledWith({
      id: 'cb_date',
      values: {},
      suppliedValue: '2026-08-15',
    });
  });

  it('leaves a REPEATABLE callback`s message alone — the controls are still live', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: record({ singleUse: false }) });

    await tap({ type: 'button', action_id: 'refresh', value: 'cb_repeat' });

    expect(acks[0]).toMatchObject({
      response_type: 'ephemeral',
      replace_original: false,
      text: 'Thanks — that has been recorded.',
    });
  });
});

describe('every refusal is said, and none of them touches the message', () => {
  it.each([
    ['closed', 'This request was already closed.'],
    ['not_found', 'This request was already closed.'],
    ['expired', 'This is no longer available — the time window for it has passed.'],
  ])('%s → an ephemeral notice', async (kind, text) => {
    fireCallback.mockResolvedValue({ kind, callback: record() } as CallbackFireOutcome);

    await tap({ type: 'button', action_id: 'ship', value: 'cb_abc' });

    expect(acks[0]).toEqual({ response_type: 'ephemeral', replace_original: false, text });
  });

  it('a mismatch says exactly what was wrong', async () => {
    fireCallback.mockResolvedValue({
      kind: 'mismatch',
      callback: record(),
      message: "this control sent a value, but the action it fires takes none",
    });

    await tap({ type: 'datepicker', action_id: 'cb_abc', selected_date: '2026-08-15' });

    expect(acks[0]).toMatchObject({
      response_type: 'ephemeral',
      replace_original: false,
      text: 'That could not be recorded: this control sent a value, but the action it fires takes none',
    });
  });
});

describe('the migration window', () => {
  it('LEGACY: an ask answer link still resolves through the ask door', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: { id: 'ask-1' } });

    await tap({
      type: 'button',
      action_id: 'ask_answer_0',
      value: 'http://localhost:3500/api/asks/ask_abc?answer=true',
    });

    expect(answerAskByToken).toHaveBeenCalledWith('ask_abc', 'true');
    expect(fireCallback).not.toHaveBeenCalled();
    expect(acks[0]).toMatchObject({
      replace_original: true,
      text: 'Thanks — your answer was recorded.',
    });
  });

  it('an ordinary block action fires nothing and acks nothing', async () => {
    await tap({ type: 'button', action_id: 'open_expense_42', value: 'expense_42' });

    expect(fireCallback).not.toHaveBeenCalled();
    expect(answerAskByToken).not.toHaveBeenCalled();
    expect(acks).toHaveLength(0);
  });
});
