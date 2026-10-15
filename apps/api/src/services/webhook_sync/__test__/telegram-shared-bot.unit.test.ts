// Shared built-in Telegram bot routing — the capstone. Drives
// `handleSharedBotInbound` through its four branches against in-memory models
// of the collaborators it owns (the `telegram_identity` reverse lookup, the
// per-team capture primitive, the work rows the dispatch half queues), plus a
// mocked handshake +
// built-in send:
//
//   • /start <token>     → binds via `bindTelegramFromStart`, replies through
//                          the built-in bot, never dispatches a movement.
//   • linked message     → fans out to EVERY team with a binding (route-all),
//                          capturing once per team, run-as-that-user.
//   • unlinked message   → ignored silently (no dispatch, no send).
//   • reply-to-bot       → classified, no-op in v1.
//
// The cross-team gate is asserted structurally: a sender bound only in team-A
// dispatches to team-A and NEVER team-B (the identity rows are the gate). The
// downstream `lookupTeamUserByEmail` team clamp is covered by the sibling
// telegram-acting-user test; here we prove the fan-out only ever touches teams
// that own a binding for the sender.
//
// The door is also capture-then-ack: routing + receipts settle inside the
// request, the returned `enqueueDeferred` queues a work row per receipt, and the
// movement runs when the row drains. That split is pinned below (nothing is
// queued before it's called; a per-team dispatch failure is data read back off
// the receipt, not a rejection; a harness team asks the route to wait).

import type { WebhookEvent } from '../providers';

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── telegram_identity reverse lookup: telegram_user_id → [team_id] ────────────
interface IdentityRow { team_id: string; telegram_user_id: string }
const identities: IdentityRow[] = [];

jest.mock('../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    selectFrom: () => {
      const filters: Record<string, string> = {};
      const chain = {
        where(col: string, _op: string, val: string) {
          filters[col] = val;
          return chain;
        },
        select() {
          return chain;
        },
        async execute() {
          return identities
            .filter((r) => r.telegram_user_id === filters['telegram_user_id'])
            .map((r) => ({ team_id: r.team_id }));
        },
      };
      return chain;
    },
  }),
}));

// ── per-team CAPTURE primitive (phase 1) — record each invocation ────────────
const captureCalls: Array<{
  teamId: string;
  credentialsId: string | null;
  adapterType: string;
  matchAnyCredential?: boolean;
  event: { externalId?: string; recordType?: string; eventType?: string; tag?: string };
}> = [];
let captureShouldThrowForTeam: string | null = null;

jest.mock('../handler', () => ({
  captureProviderTriggerEvents: jest.fn(async (input: any) => {
    captureCalls.push({
      teamId: input.subscription.team_id,
      credentialsId: input.subscription.credentials_id,
      adapterType: input.adapterType,
      matchAnyCredential: input.matchAnyCredential,
      event: input.event,
    });
    if (captureShouldThrowForTeam === input.subscription.team_id) {
      throw new Error(`capture boom for ${input.subscription.team_id}`);
    }
    return [
      {
        triggerId: `trig-${input.subscription.team_id}`,
        teamId: input.subscription.team_id,
        triggerEvent: { payload: input.event.payload },
        storedEventId: `evt-${input.subscription.team_id}`,
        duplicate: false,
      },
    ];
  }),
}));

// ── the DISPATCH half (phase 2) — record each queued row; a team named in
//    `dispatchShouldThrowForTeam` reads back as a failed receipt once drained ──
const dispatchCalls: Array<{ teamId: string; triggerId: string }> = [];
let dispatchShouldThrowForTeam: string | null = null;

jest.mock('../../translation_graph/triggers/dispatch_event', () => ({
  enqueueCapturedEvents: jest.fn(async (receipts: any[]) => {
    for (const receipt of receipts) {
      dispatchCalls.push({ teamId: receipt.teamId, triggerId: receipt.triggerId });
    }
  }),
  readReceiptGroupOutcomes: jest.fn(async (input: any) => {
    const failing = `evt-${dispatchShouldThrowForTeam}`;
    const cleared: unknown[] = [];
    const failed: { group: unknown; error: string }[] = [];
    for (const { group, receipts } of input.groups) {
      if (receipts.some((r: any) => r.storedEventId === failing)) {
        failed.push({ group, error: `boom for ${dispatchShouldThrowForTeam}` });
      } else {
        cleared.push(group);
      }
    }
    return { cleared, failed };
  }),
}));

// ── handshake — record bind input, return a scripted result ──────────────────
const bindCalls: Array<{ token: string; telegramUserId: string }> = [];
let bindResult: any = { ok: true, email: 'ada@example.com', telegramUserId: '999' };

jest.mock('../../translation_graph/adapters/telegram/handshake', () => ({
  bindTelegramFromStart: jest.fn(async (input: any) => {
    bindCalls.push(input);
    return bindResult;
  }),
}));

// ── built-in send — record the reply that the bot would post, and the two
//    Bot API calls a button tap makes through the SAME built-in client ───────
const sentReplies: Array<{ chatId: string; text: string }> = [];
const callbackAcks: Array<{ callbackQueryId: string; text?: string }> = [];
const keyboardEdits: Array<{ chatId: string; messageId: number }> = [];
jest.mock('../../translation_graph/adapters/telegram', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/telegram');
  return {
    ...actual,
    TelegramAdapter: class {
      constructor(public readonly teamId: string) {}
      async sendBuiltInReply(input: { chatId: string; text: string }) {
        sentReplies.push(input);
      }
      async answerCallbackQuery(input: { callbackQueryId: string; text?: string }) {
        callbackAcks.push(input);
      }
      async clearReplyMarkup(input: { chatId: string; messageId: number }) {
        keyboardEdits.push(input);
      }
    },
  };
});

// ── the ONE answer door, scripted ────────────────────────────────────────────
const answerCalls: Array<{ token: string; answer: unknown }> = [];
let answerOutcome: any = { kind: 'answered', ask: { id: 'ask-1' } };
jest.mock('../../translation_graph/adapters/ask/answer_door', () => ({
  answerAskByToken: jest.fn(async (token: string, answer: unknown) => {
    answerCalls.push({ token, answer });
    return answerOutcome;
  }),
}));

import * as telegramBuiltinService from '../telegram_builtin';
import { handleSharedBotInbound, classifySharedBotInbound } from '../telegram_builtin';
import {
  authenticateAndHandle,
  verifyTelegramWebhookSecret,
} from '../../../interfaces/rest/telegramBuiltin';
import { testHarnessConfig } from '../../../lib/recording';

const TG_USER = '999';
const SETTLED = { unsettledTeamIds: new Set<string>(), unsettledError: 'not settled within 30s' };
const ORIGINAL_HARNESS_TEAM = testHarnessConfig.teamId;

function privateMessage(overrides?: { senderId?: string; text?: string }) {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      from: { id: Number(overrides?.senderId ?? TG_USER), is_bot: false, first_name: 'Ada', username: 'ada' },
      chat: { id: 111222, type: 'private' },
      date: 1700000000,
      text: overrides?.text ?? 'hello bot',
    },
  };
}

beforeEach(() => {
  identities.length = 0;
  captureCalls.length = 0;
  dispatchCalls.length = 0;
  bindCalls.length = 0;
  sentReplies.length = 0;
  callbackAcks.length = 0;
  keyboardEdits.length = 0;
  answerCalls.length = 0;
  answerOutcome = { kind: 'answered', ask: { id: 'ask-1' } };
  captureShouldThrowForTeam = null;
  dispatchShouldThrowForTeam = null;
  testHarnessConfig.teamId = ORIGINAL_HARNESS_TEAM;
  bindResult = { ok: true, email: 'ada@example.com', telegramUserId: TG_USER };
});

afterAll(() => {
  testHarnessConfig.teamId = ORIGINAL_HARNESS_TEAM;
});

/** Drive a delivery through BOTH halves and read the drained outcome — the
 *  pre-split behaviour, for the assertions that are about routing rather than
 *  about the ack boundary. */
async function deliverFully(raw: unknown) {
  const delivery = await handleSharedBotInbound(raw);
  return delivery.enqueueDeferred
    ? (await delivery.enqueueDeferred()).readOutcome(SETTLED)
    : delivery.result;
}

describe('shared-bot classification', () => {
  it('detects /start <token>', () => {
    const c = classifySharedBotInbound({
      message: { from: { id: 1 }, chat: { id: 2 }, text: '/start abc123' },
    });
    expect(c).toMatchObject({ kind: 'start', token: 'abc123', telegramUserId: '1' });
  });

  it('detects /start@botname <token>', () => {
    const c = classifySharedBotInbound({
      message: { from: { id: 1 }, chat: { id: 2 }, text: '/start@listen_fire_bot tok' },
    });
    expect(c).toMatchObject({ kind: 'start', token: 'tok' });
  });

  it('treats a bare /start (no token) as a normal message, not a handshake', () => {
    const c = classifySharedBotInbound({
      message: { message_id: 7, from: { id: 1 }, chat: { id: 2, type: 'private' }, date: 1, text: '/start' },
    });
    expect(c.kind).toBe('message');
  });

  it('classifies a reply-to-bot', () => {
    const c = classifySharedBotInbound({
      message: { from: { id: 1 }, chat: { id: 2 }, text: 'hi', reply_to_message: { from: { is_bot: true } } },
    });
    expect(c.kind).toBe('reply_to_bot');
  });

  it('ignores an update with no message', () => {
    expect(classifySharedBotInbound({ edited_message: {} }).kind).toBe('ignore');
  });
});

describe('/start handshake branch', () => {
  it('binds the token and replies "Linked" through the built-in bot — no dispatch', async () => {
    const delivery = await handleSharedBotInbound({
      message: { from: { id: 999, first_name: 'Ada' }, chat: { id: 111222 }, text: '/start tok-xyz' },
    });

    expect(bindCalls).toEqual([{ token: 'tok-xyz', telegramUserId: '999' }]);
    expect(delivery.result).toMatchObject({
      ok: true,
      classification: 'start',
      bind: { ok: true, email: 'ada@example.com' },
    });
    expect(sentReplies).toHaveLength(1);
    expect(sentReplies[0]).toMatchObject({ chatId: '111222' });
    expect(sentReplies[0].text).toContain('Linked');
    // A handshake is NOT a movement message — and it is WHOLLY pre-ack: the bind
    // outcome IS the response body, so there is nothing to defer.
    expect(delivery.enqueueDeferred).toBeUndefined();
    expect(captureCalls).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(0);
  });

  it('sends a friendly reject (and no binding effect) when the token is bad', async () => {
    bindResult = { ok: false, reason: 'token_expired' };
    const delivery = await handleSharedBotInbound({
      message: { from: { id: 999 }, chat: { id: 111222 }, text: '/start stale' },
    });
    expect(delivery.result).toMatchObject({
      classification: 'start',
      bind: { ok: false, reason: 'token_expired' },
    });
    expect(sentReplies[0].text).toContain('expired');
    expect(delivery.enqueueDeferred).toBeUndefined();
    expect(dispatchCalls).toHaveLength(0);
  });
});

describe('linked-message routing (route-all)', () => {
  it('fans out to EVERY team that has a binding for the sender', async () => {
    identities.push({ team_id: 'team-A', telegram_user_id: TG_USER });
    identities.push({ team_id: 'team-B', telegram_user_id: TG_USER });

    const res = await deliverFully(privateMessage());

    expect(res).toMatchObject({ classification: 'message' });
    expect(new Set(res.routedTeamIds)).toEqual(new Set(['team-A', 'team-B']));
    expect(captureCalls).toHaveLength(2);
    expect(dispatchCalls).toHaveLength(2);
    // Shared bot dispatches credential-free (built-in env token).
    for (const call of captureCalls) {
      expect(call.credentialsId).toBeNull();
      expect(call.adapterType).toBe('telegram');
      // The shared bot receives globally — never narrow by credential.
      expect(call.matchAnyCredential).toBe(true);
      expect(call.event.externalId).toBe('42'); // the parsed message id (normalized)
      // Verify handleSharedBotInbound uses the TAGGED mapper telegramEventToDiscriminable
      expect(call.event.tag).toBe('message');
    }
  });

  it('one team failing does not abort the others (route-all is independent)', async () => {
    identities.push({ team_id: 'team-A', telegram_user_id: TG_USER });
    identities.push({ team_id: 'team-B', telegram_user_id: TG_USER });
    dispatchShouldThrowForTeam = 'team-A';

    const res = await deliverFully(privateMessage());

    // Both were attempted; only the successful team is reported as routed.
    expect(dispatchCalls.map((c) => c.teamId).sort()).toEqual(['team-A', 'team-B']);
    expect(res.routedTeamIds).toEqual(['team-B']);
  });

  it('a team whose CAPTURE fails is dropped before the ack, the rest still run', async () => {
    identities.push({ team_id: 'team-A', telegram_user_id: TG_USER });
    identities.push({ team_id: 'team-B', telegram_user_id: TG_USER });
    captureShouldThrowForTeam = 'team-A';

    const delivery = await handleSharedBotInbound(privateMessage());

    expect(delivery.result.routedTeamIds).toEqual(['team-B']);
    expect(await (await delivery.enqueueDeferred!()).readOutcome(SETTLED)).toMatchObject({
      routedTeamIds: ['team-B'],
    });
    expect(dispatchCalls.map((c) => c.teamId)).toEqual(['team-B']);
  });
});

// ── capture-then-ack: where the split sits ───────────────────────────────────
describe('capture-then-ack split', () => {
  it('receipts are captured pre-ack and NOTHING is queued until the deferred half', async () => {
    identities.push({ team_id: 'team-A', telegram_user_id: TG_USER });

    const delivery = await handleSharedBotInbound(privateMessage());

    // The ack body is settled and the receipt is stored…
    expect(delivery.result).toMatchObject({
      ok: true,
      classification: 'message',
      routedTeamIds: ['team-A'],
    });
    expect(captureCalls).toHaveLength(1);
    // …but no row is queued yet.
    expect(dispatchCalls).toHaveLength(0);

    await delivery.enqueueDeferred!();
    expect(dispatchCalls).toEqual([{ teamId: 'team-A', triggerId: 'trig-team-A' }]);
  });

  it('a failed dispatch reads back as data — it never rejects', async () => {
    identities.push({ team_id: 'team-A', telegram_user_id: TG_USER });
    dispatchShouldThrowForTeam = 'team-A';

    const delivery = await handleSharedBotInbound(privateMessage());

    await expect((await delivery.enqueueDeferred!()).readOutcome(SETTLED)).resolves.toMatchObject({
      ok: true,
      classification: 'message',
      routedTeamIds: [],
    });
  });

  it('a production team never asks the door to wait', async () => {
    identities.push({ team_id: 'team-A', telegram_user_id: TG_USER });

    expect((await handleSharedBotInbound(privateMessage())).awaitDeferred).toBeUndefined();
  });

  it('a test-harness team asks the door to wait (the dev-loop contract)', async () => {
    testHarnessConfig.teamId = 'team-A';
    identities.push({ team_id: 'team-A', telegram_user_id: TG_USER });

    const delivery = await handleSharedBotInbound(privateMessage());
    expect(delivery.awaitDeferred).toBe(true);
  });
});

describe('cross-team isolation gate', () => {
  it('a sender bound only in team-A dispatches to team-A and NEVER team-B', async () => {
    identities.push({ team_id: 'team-A', telegram_user_id: TG_USER });
    // team-B has a binding for a DIFFERENT telegram user — must not be hit.
    identities.push({ team_id: 'team-B', telegram_user_id: '555' });

    const res = await deliverFully(privateMessage());

    expect(res.routedTeamIds).toEqual(['team-A']);
    expect(captureCalls).toHaveLength(1);
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].teamId).toBe('team-A');
  });
});

describe('unlinked sender', () => {
  it('ignores silently — no dispatch, no send', async () => {
    // No identity rows at all → unlinked.
    const delivery = await handleSharedBotInbound(privateMessage({ senderId: '777' }));
    expect(delivery.result).toMatchObject({ ok: true, classification: 'unlinked_ignore' });
    expect(delivery.enqueueDeferred).toBeUndefined();
    expect(captureCalls).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(0);
    expect(sentReplies).toHaveLength(0);
  });
});

// ── button taps ──────────────────────────────────────────────────────────────
// The same bot, the same webhook: a tap is a `callback_query`, classified ahead
// of everything else so it can never be mistaken for a message, and settled
// wholly pre-ack (the tapper's client spins until the ack lands).
describe('button tap branch', () => {
  const tap = (data: string) => ({
    update_id: 5,
    callback_query: {
      id: 'cbq_9',
      from: { id: Number(TG_USER), is_bot: false, first_name: 'Ada' },
      message: { message_id: 42, chat: { id: 111222, type: 'private' } },
      data,
    },
  });

  it('classifies a tap ahead of the message path', () => {
    expect(classifySharedBotInbound(tap('ask_abc?answer=true')).kind).toBe('callback_query');
  });

  it("leaves another bot button's tap to the ordinary path", () => {
    expect(classifySharedBotInbound(tap('refresh_dashboard')).kind).toBe('ignore');
  });

  it('answers, acks, and retires the keyboard — no capture, no dispatch, no deferred half', async () => {
    const delivery = await handleSharedBotInbound(tap('ask_abc?answer=true'));

    expect(answerCalls).toEqual([{ token: 'ask_abc', answer: 'true' }]);
    expect(delivery.result).toMatchObject({
      ok: true,
      classification: 'callback_query',
      callback: { handled: true, outcome: 'answered' },
    });
    expect(delivery.enqueueDeferred).toBeUndefined();
    expect(captureCalls).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(0);
    expect(callbackAcks).toEqual([
      { callbackQueryId: 'cbq_9', text: 'Thanks — your answer was recorded.' },
    ]);
    expect(keyboardEdits).toEqual([{ chatId: '111222', messageId: 42 }]);
  });

  it('a tap on a settled question keeps its keyboard (closed-request-wins)', async () => {
    answerOutcome = { kind: 'closed', ask: { id: 'ask-1' } };
    const delivery = await handleSharedBotInbound(tap('ask_abc?answer=true'));
    expect(delivery.result.callback).toEqual({ handled: true, outcome: 'closed' });
    expect(callbackAcks[0].text).toBe('This request was already closed.');
    expect(keyboardEdits).toHaveLength(0);
  });

  it('a tap requires no linking — the token is the authorisation, not the sender', async () => {
    // No `telegram_identity` row for this sender at all.
    const delivery = await handleSharedBotInbound(tap('ask_abc?answer=true'));
    expect(delivery.result.classification).toBe('callback_query');
    expect(answerCalls).toHaveLength(1);
  });
});

describe('reply-to-bot', () => {
  it('classifies but no-ops in v1', async () => {
    const delivery = await handleSharedBotInbound({
      message: { from: { id: 999 }, chat: { id: 2 }, text: 'thanks', reply_to_message: { from: { is_bot: true } } },
    });
    expect(delivery.result).toMatchObject({ classification: 'reply_to_bot' });
    expect(delivery.enqueueDeferred).toBeUndefined();
    expect(dispatchCalls).toHaveLength(0);
  });
});

// ── webhook secret-token gate (the auth on the SHARED entry) ──────────────────
//
// The shared entry is a fixed, guessable, public URL — so unlike the BYO door
// (unguessable subId) it MUST authenticate that the POST came from Telegram, via
// the `X-Telegram-Bot-Api-Secret-Token` header set by `setWebhook`. We verify
// the gate decides correctly AND that an unauthorized delivery never reaches the
// router (`handleSharedBotInbound`), which would otherwise run an automation as
// a forged sender.
describe('webhook secret-token authentication', () => {
  const ORIGINAL_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_BYPASS = process.env.ALLOW_UNSIGNED_WEBHOOKS;
  const SECRET = 'super-secret-token';

  let handleSpy: jest.SpyInstance;

  beforeEach(() => {
    // A bound sender so an authorized delivery would actually dispatch.
    identities.push({ team_id: 'team-A', telegram_user_id: TG_USER });
    handleSpy = jest.spyOn(telegramBuiltinService, 'handleSharedBotInbound');
  });

  afterEach(() => {
    handleSpy.mockRestore();
    if (ORIGINAL_SECRET === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
    else process.env.TELEGRAM_WEBHOOK_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_BYPASS === undefined) delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
    else process.env.ALLOW_UNSIGNED_WEBHOOKS = ORIGINAL_BYPASS;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV ?? 'test';
  });

  it('secret SET + correct header → processed (classification flows as before)', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const delivery = await authenticateAndHandle({ headerSecret: SECRET, raw: privateMessage() });

    expect(handleSpy).toHaveBeenCalledTimes(1);
    expect(delivery.result).toMatchObject({ classification: 'message', routedTeamIds: ['team-A'] });
    expect(captureCalls).toHaveLength(1);

    await delivery.enqueueDeferred!();
    expect(dispatchCalls).toHaveLength(1);
  });

  it('secret SET + WRONG header → unauthorized, router NOT invoked', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const delivery = await authenticateAndHandle({
      headerSecret: 'not-the-secret',
      raw: privateMessage(),
    });

    expect(delivery).toEqual({ result: { ok: false, classification: 'unauthorized' } });
    expect(handleSpy).not.toHaveBeenCalled();
    expect(captureCalls).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(0);
  });

  it('secret SET + MISSING header → unauthorized, router NOT invoked', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const delivery = await authenticateAndHandle({ headerSecret: undefined, raw: privateMessage() });

    expect(delivery).toEqual({ result: { ok: false, classification: 'unauthorized' } });
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('secret UNSET + NODE_ENV=production → rejected, router NOT invoked', async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'production';
    const delivery = await authenticateAndHandle({ headerSecret: undefined, raw: privateMessage() });

    expect(delivery).toEqual({ result: { ok: false, classification: 'unauthorized' } });
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('secret UNSET + dev, nothing opted in → STILL rejected (a dev build is not a network boundary)', async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
    process.env.NODE_ENV = 'development';
    const delivery = await authenticateAndHandle({ headerSecret: undefined, raw: privateMessage() });

    expect(delivery).toEqual({ result: { ok: false, classification: 'unauthorized' } });
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('secret UNSET + dev + ALLOW_UNSIGNED_WEBHOOKS → allowed (this is what the dev loop sets)', async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';
    process.env.NODE_ENV = 'development';
    const delivery = await authenticateAndHandle({ headerSecret: undefined, raw: privateMessage() });

    expect(handleSpy).toHaveBeenCalledTimes(1);
    expect(delivery.result).toMatchObject({ classification: 'message', routedTeamIds: ['team-A'] });
  });

  it('the verifier is constant-time-guarded: a length-mismatched header never matches', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    expect(verifyTelegramWebhookSecret(SECRET)).toEqual({ authorized: true });
    expect(verifyTelegramWebhookSecret(SECRET + 'x')).toMatchObject({ authorized: false });
    expect(verifyTelegramWebhookSecret('short')).toMatchObject({ authorized: false });
  });
});
