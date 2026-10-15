// Telegram's door onto the callback router — the branch a button tap takes.
//
// Load-bearing in four separate ways, so all four are pinned:
//   • a tap that is NOT ours must flow on untouched, or the door starts eating
//     other people's buttons (and every non-callback update besides);
//   • recognition order: a callback id first, the legacy ask link after — a
//     re-authored automation and one not yet re-authored must both work;
//   • a tap that IS ours must be acked on EVERY outcome, or the tapper's client
//     spins forever;
//   • the keyboard comes off only when the tap SERVED the message (recorded +
//     single-use) — closed-request-wins means a late tap leaves the message
//     exactly as whoever acted first left it, and a repeatable callback's
//     keyboard is still live.
//
// The responder is a stub: the two Bot API calls are the door's whole contract
// with Telegram, and the adapter's own credential resolution is tested with the
// adapter (adapters/telegram/__test__/telegram.unit.test.ts).

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const answerAskByToken = jest.fn();
jest.mock('../../translation_graph/adapters/ask/answer_door', () => ({
  answerAskByToken: (...args: unknown[]) => answerAskByToken(...args),
}));

// The router is mocked; `interactionServed` / `callbackAckText` are the real
// shared rules, since it is the door's USE of them that is under test.
const fireCallback = jest.fn();
jest.mock('../../movement_engine/callback_fire', () => ({
  ...jest.requireActual('../../movement_engine/callback_fire'),
  fireCallback: (input: unknown) => fireCallback(input),
}));

import type { CallbackRecord } from '../../movement_engine/callback_store';

import { logger } from 'movement-engine/services/logger';
import {
  callbackQueryOf,
  handleTelegramCallbackQuery,
  ownsCallbackQuery,
  type TelegramCallbackResponder,
} from '../telegram_callback_door';

const ASK: Record<string, unknown> = { id: 'ask-1' };

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

function responder() {
  const stub = {
    answerCallbackQuery: jest.fn(async () => {}),
    clearReplyMarkup: jest.fn(async () => {}),
  };
  return stub satisfies TelegramCallbackResponder & Record<string, jest.Mock>;
}

function tapUpdate(data: string, opts?: { withoutMessage?: boolean }) {
  return {
    update_id: 9,
    callback_query: {
      id: 'cbq_1',
      from: { id: 777, is_bot: false, first_name: 'Ada' },
      ...(opts?.withoutMessage
        ? { inline_message_id: 'inline_1' }
        : { message: { message_id: 42, chat: { id: -1001, type: 'supergroup' } } }),
      chat_instance: 'ci_1',
      data,
    },
  };
}

beforeEach(() => {
  answerAskByToken.mockReset();
  fireCallback.mockReset();
  jest.clearAllMocks();
});

describe('recognising a tap', () => {
  it('reads the callback_query off an update', () => {
    expect(callbackQueryOf(tapUpdate('ask_abc?answer=true'))?.id).toBe('cbq_1');
  });

  it('is null for every other kind of delivery', () => {
    expect(callbackQueryOf({ update_id: 1, message: { message_id: 1 } })).toBeNull();
    expect(callbackQueryOf({})).toBeNull();
    expect(callbackQueryOf(null)).toBeNull();
  });

  it('claims taps whose data is a callback id, or (legacy) an answer link', () => {
    expect(ownsCallbackQuery(tapUpdate('cb_abc'))).toBe(true);
    expect(ownsCallbackQuery(tapUpdate('ask_abc?answer=true'))).toBe(true);
    expect(ownsCallbackQuery(tapUpdate('http://localhost:3500/api/asks/ask_abc?answer=true'))).toBe(true);
    expect(ownsCallbackQuery(tapUpdate('refresh_dashboard'))).toBe(false);
    expect(ownsCallbackQuery({ update_id: 1, message: { message_id: 1 } })).toBe(false);
  });
});

describe('a tap the door does not own flows on untouched', () => {
  it('a plain message update is not handled and nothing is called', async () => {
    const r = responder();
    const result = await handleTelegramCallbackQuery({
      raw: { update_id: 1, message: { message_id: 1, chat: { id: 5 } } },
      responder: r,
    });
    expect(result).toEqual({ handled: false });
    expect(r.answerCallbackQuery).not.toHaveBeenCalled();
    expect(answerAskByToken).not.toHaveBeenCalled();
  });

  it("another bot button's callback_data is not handled — and is NOT acked (it is not ours to ack)", async () => {
    const r = responder();
    expect(await handleTelegramCallbackQuery({ raw: tapUpdate('refresh_dashboard'), responder: r })).toEqual({
      handled: false,
    });
    expect(r.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it('a callback_query with no data at all is not handled', async () => {
    const r = responder();
    expect(
      await handleTelegramCallbackQuery({
        raw: { update_id: 1, callback_query: { id: 'cbq_2' } },
        responder: r,
      }),
    ).toEqual({ handled: false });
  });
});

describe('a tap that fires a callback', () => {
  it('fires by id with NO values (Telegram captures nothing at tap time), acks, and retires the keyboard', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: record({ singleUse: true }) });
    const r = responder();

    const result = await handleTelegramCallbackQuery({ raw: tapUpdate('cb_abc'), responder: r });

    expect(fireCallback).toHaveBeenCalledWith({ id: 'cb_abc', values: {} });
    expect(answerAskByToken).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: true, outcome: 'recorded' });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'Thanks — that has been recorded.',
    });
    expect(r.clearReplyMarkup).toHaveBeenCalledWith({ chatId: '-1001', messageId: 42 });
  });

  it('a REPEATABLE callback keeps its keyboard — the buttons are still live', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: record({ singleUse: false }) });
    const r = responder();

    await handleTelegramCallbackQuery({ raw: tapUpdate('cb_repeat'), responder: r });

    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'Thanks — that has been recorded.',
    });
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it('an inline-mode tap is acked even though there is no message to edit', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: record() });
    const r = responder();

    await handleTelegramCallbackQuery({
      raw: tapUpdate('cb_abc', { withoutMessage: true }),
      responder: r,
    });

    expect(r.answerCallbackQuery).toHaveBeenCalled();
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it.each([
    ['closed', 'This request was already closed.'],
    ['not_found', 'This request was already closed.'],
    ['expired', 'This is no longer available — the time window for it has passed.'],
  ])('%s: acked, and the keyboard STAYS', async (kind, text) => {
    fireCallback.mockResolvedValue({ kind, callback: record() });
    const r = responder();

    const result = await handleTelegramCallbackQuery({ raw: tapUpdate('cb_abc'), responder: r });

    expect(result).toEqual({ handled: true, outcome: kind });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({ callbackQueryId: 'cbq_1', text });
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it('a parameter mismatch is LOUD in the toast, naming what was wrong', async () => {
    fireCallback.mockResolvedValue({
      kind: 'mismatch',
      callback: record(),
      message: "missing 'day' — this callback expects day (date)",
    });
    const r = responder();

    await handleTelegramCallbackQuery({ raw: tapUpdate('cb_needs_a_date'), responder: r });

    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: "That could not be recorded: missing 'day' — this callback expects day (date)",
    });
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it('a router that throws still acks — a spinning client is worse than a visible failure', async () => {
    fireCallback.mockRejectedValue(new Error('store down'));
    const r = responder();

    const result = await handleTelegramCallbackQuery({ raw: tapUpdate('cb_abc'), responder: r });

    expect(result).toEqual({ handled: true, outcome: 'not_found' });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'Something went wrong recording that.',
    });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('a tap that answers', () => {
  it('resolves through the one answer door, acks, and retires the keyboard', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    const r = responder();

    const result = await handleTelegramCallbackQuery({
      raw: tapUpdate('ask_abc?answer=true'),
      responder: r,
    });

    expect(answerAskByToken).toHaveBeenCalledWith('ask_abc', 'true');
    expect(result).toEqual({ handled: true, outcome: 'answered' });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'Thanks — your answer was recorded.',
    });
    expect(r.clearReplyMarkup).toHaveBeenCalledWith({ chatId: '-1001', messageId: 42 });
  });

  it('accepts the full answer URL too (the same link the page uses)', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    await handleTelegramCallbackQuery({
      raw: tapUpdate('http://localhost:3500/api/asks/ask_xyz?answer=Seed'),
      responder: responder(),
    });
    expect(answerAskByToken).toHaveBeenCalledWith('ask_xyz', 'Seed');
  });

  it('url-decodes a multi-word answer', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    await handleTelegramCallbackQuery({
      raw: tapUpdate('ask_abc?answer=option%20two'),
      responder: responder(),
    });
    expect(answerAskByToken).toHaveBeenCalledWith('ask_abc', 'option two');
  });

  it('acks a tap on an inline message it cannot edit, rather than skipping the ack', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    const r = responder();
    await handleTelegramCallbackQuery({
      raw: tapUpdate('ask_abc?answer=true', { withoutMessage: true }),
      responder: r,
    });
    expect(r.answerCallbackQuery).toHaveBeenCalled();
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it('a failed keyboard edit does not undo the answer', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    const r = responder();
    r.clearReplyMarkup.mockRejectedValue(new Error('message is not modified'));

    const result = await handleTelegramCallbackQuery({
      raw: tapUpdate('ask_abc?answer=true'),
      responder: r,
    });
    expect(result).toEqual({ handled: true, outcome: 'answered' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('retiring the keyboard failed'),
      expect.anything(),
    );
  });
});

describe('closed-request-wins', () => {
  it('a late tap on a settled question is acked with the notice and KEEPS its keyboard', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'closed', ask: ASK });
    const r = responder();

    const result = await handleTelegramCallbackQuery({
      raw: tapUpdate('ask_abc?answer=true'),
      responder: r,
    });

    expect(result).toEqual({ handled: true, outcome: 'closed' });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'This request was already closed.',
    });
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it('a token this store never minted reads the same way', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'not_ours' });
    const r = responder();
    expect(await handleTelegramCallbackQuery({ raw: tapUpdate('ask_gone?answer=true'), responder: r })).toEqual({
      handled: true,
      outcome: 'not_ours',
    });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'This request was already closed.',
    });
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it("an answer the question's type refuses carries the reason back to the tapper", async () => {
    answerAskByToken.mockResolvedValue({ kind: 'invalid', message: 'expected one of: ship, hold', ask: ASK });
    const r = responder();
    await handleTelegramCallbackQuery({ raw: tapUpdate('ask_abc?answer=maybe'), responder: r });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'That answer could not be accepted: expected one of: ship, hold',
    });
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });
});

describe('loud, never silent', () => {
  it('an answer-less token in callback_data is logged loudly, acked, and consumed', async () => {
    const r = responder();
    const result = await handleTelegramCallbackQuery({ raw: tapUpdate('ask_bare'), responder: r });

    expect(answerAskByToken).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: true, outcome: 'malformed' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no answer'),
      expect.anything(),
    );
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'That button could not be read.',
    });
  });

  it('a thrown resolution is logged and still acked — a spinning client is worse', async () => {
    answerAskByToken.mockRejectedValue(new Error('database is on fire'));
    const r = responder();

    const result = await handleTelegramCallbackQuery({ raw: tapUpdate('ask_abc?answer=true'), responder: r });

    expect(result.handled).toBe(true);
    expect(logger.error).toHaveBeenCalled();
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'Something went wrong recording that answer.',
    });
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it('a failed ack is warned about, not thrown', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    const r = responder();
    r.answerCallbackQuery.mockRejectedValue(new Error('query is too old'));

    await expect(
      handleTelegramCallbackQuery({ raw: tapUpdate('ask_abc?answer=true'), responder: r }),
    ).resolves.toEqual({ handled: true, outcome: 'answered' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('answerCallbackQuery failed'),
      expect.anything(),
    );
  });
});

describe('the migration window: legacy links are tried only AFTER the prefix check', () => {
  it('an ask answer link never reaches the router', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    const r = responder();

    await handleTelegramCallbackQuery({ raw: tapUpdate('ask_abc?answer=true'), responder: r });

    expect(fireCallback).not.toHaveBeenCalled();
    expect(answerAskByToken).toHaveBeenCalledWith('ask_abc', 'true');
  });

  it('a callback id never reaches the ask door', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: record() });
    const r = responder();

    await handleTelegramCallbackQuery({ raw: tapUpdate('cb_abc'), responder: r });

    expect(answerAskByToken).not.toHaveBeenCalled();
  });
});
