// WhatsApp's door onto the callback router — the branch a button tap takes.
//
// Load-bearing in the ways that differ from Telegram's door
// (telegram_callback_door.unit.test.ts), which this mirrors:
//   • a delivery is a BATCH of messages, not one callback_query — so
//     recognition and firing operate per-message, and a non-callback reply in
//     the same batch must never be touched;
//   • WhatsApp supplies no tap-time value at all (no picker captures
//     anything), so a parameterized callback's tap is always a mismatch;
//   • the ack is ALWAYS a reply (WhatsApp can neither edit the sent message
//     nor show a toast) — on every outcome, never conditionally, and there is
//     no keyboard-equivalent to retire.

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const fireCallback = jest.fn();
jest.mock('../../movement_engine/callback_fire', () => ({
  ...jest.requireActual('../../movement_engine/callback_fire'),
  fireCallback: (input: unknown) => fireCallback(input),
}));

import type { CallbackRecord } from '../../movement_engine/callback_store';

import { logger } from 'movement-engine/services/logger';
import {
  handleWhatsappInteractiveReplies,
  interactiveRepliesOf,
  ownsWhatsappInteractiveReply,
  type WhatsappCallbackResponder,
} from '../whatsapp_callback_door';

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
  const stub = { sendReply: jest.fn(async () => {}) };
  return stub satisfies WhatsappCallbackResponder & Record<string, jest.Mock>;
}

function metaBody(messages: Record<string, unknown>[], phoneNumberId = 'PNID_1') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
              messages,
            },
          },
        ],
      },
    ],
  };
}

function tap(id: string, replyId: string, from = '15551234567') {
  return {
    id,
    from,
    timestamp: '1700000000',
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: replyId, title: 'Tap' } },
  };
}

function listTap(id: string, replyId: string, from = '15551234567') {
  return {
    id,
    from,
    timestamp: '1700000000',
    type: 'interactive',
    interactive: { type: 'list_reply', list_reply: { id: replyId, title: 'Pick' } },
  };
}

beforeEach(() => {
  fireCallback.mockReset();
  jest.clearAllMocks();
});

describe('recognising a tap', () => {
  it('extracts every interactive reply in a delivery, button and list alike', () => {
    const replies = interactiveRepliesOf(
      metaBody([tap('wamid.1', 'cb_a'), listTap('wamid.2', 'cb_b')]),
    );
    expect(replies).toEqual([
      { messageId: 'wamid.1', from: '15551234567', replyId: 'cb_a', businessPhoneNumberId: 'PNID_1' },
      { messageId: 'wamid.2', from: '15551234567', replyId: 'cb_b', businessPhoneNumberId: 'PNID_1' },
    ]);
  });

  it('is empty for a plain-text message, or a delivery with no messages at all', () => {
    expect(interactiveRepliesOf(metaBody([{ id: 'm', from: 'x', type: 'text', text: { body: 'hi' } }]))).toEqual([]);
    expect(interactiveRepliesOf({})).toEqual([]);
    expect(interactiveRepliesOf(null)).toEqual([]);
  });

  it('claims a delivery only when at least one reply id is a callback id', () => {
    expect(ownsWhatsappInteractiveReply(metaBody([tap('wamid.1', 'cb_abc')]))).toBe(true);
    expect(ownsWhatsappInteractiveReply(metaBody([tap('wamid.1', 'menu_refresh')]))).toBe(false);
    expect(
      ownsWhatsappInteractiveReply(
        metaBody([tap('wamid.1', 'menu_refresh'), tap('wamid.2', 'cb_abc')]),
      ),
    ).toBe(true);
  });
});

describe('a callback-id tap', () => {
  it('fires by id with NO values (WhatsApp captures nothing at tap time), and acks with a threaded reply', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: record({ singleUse: true }) });
    const r = responder();

    const results = await handleWhatsappInteractiveReplies({
      raw: metaBody([tap('wamid.TAP', 'cb_abc')]),
      responder: r,
    });

    expect(fireCallback).toHaveBeenCalledWith({ id: 'cb_abc', values: {} });
    expect(results).toEqual([{ replyId: 'cb_abc', outcome: 'recorded' }]);
    expect(r.sendReply).toHaveBeenCalledWith({
      to: '15551234567',
      text: 'Thanks — that has been recorded.',
      businessPhoneNumberId: 'PNID_1',
      replyToMessageId: 'wamid.TAP',
    });
  });

  it('a REPEATABLE callback still just gets a reply — there is no keyboard to leave alone', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: record({ singleUse: false }) });
    const r = responder();

    await handleWhatsappInteractiveReplies({ raw: metaBody([tap('wamid.TAP', 'cb_repeat')]), responder: r });

    expect(r.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Thanks — that has been recorded.' }),
    );
  });

  it.each([
    ['closed', 'This request was already closed.'],
    ['not_found', 'This request was already closed.'],
    ['expired', 'This is no longer available — the time window for it has passed.'],
  ])('%s: still acked with a reply, on the platform-forced rule (WhatsApp has no other feedback channel)', async (kind, text) => {
    fireCallback.mockResolvedValue({ kind, callback: record() });
    const r = responder();

    const results = await handleWhatsappInteractiveReplies({
      raw: metaBody([tap('wamid.TAP', 'cb_abc')]),
      responder: r,
    });

    expect(results).toEqual([{ replyId: 'cb_abc', outcome: kind }]);
    expect(r.sendReply).toHaveBeenCalledWith(expect.objectContaining({ text }));
  });

  it('a parameterized callback tapped with no value is a LOUD mismatch, naming what was wrong', async () => {
    // WhatsApp supplies no tap-time value at all — a button id carries nothing
    // beyond itself — so ANY parameterized callback tapped from a button is a
    // mismatch, unconditionally (never a silent "0 values, close enough").
    fireCallback.mockResolvedValue({
      kind: 'mismatch',
      callback: record(),
      message: "missing 'day' — this callback expects day (date)",
    });
    const r = responder();

    await handleWhatsappInteractiveReplies({ raw: metaBody([tap('wamid.TAP', 'cb_needs_a_date')]), responder: r });

    expect(fireCallback).toHaveBeenCalledWith({ id: 'cb_needs_a_date', values: {} });
    expect(r.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "That could not be recorded: missing 'day' — this callback expects day (date)",
      }),
    );
  });

  it('a router that throws still acks — a tapper left with no reply is worse than a visible failure', async () => {
    fireCallback.mockRejectedValue(new Error('store down'));
    const r = responder();

    const results = await handleWhatsappInteractiveReplies({
      raw: metaBody([tap('wamid.TAP', 'cb_abc')]),
      responder: r,
    });

    expect(results).toEqual([{ replyId: 'cb_abc', outcome: 'not_found' }]);
    expect(r.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Something went wrong recording that.' }),
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it('a failed ack is warned about, not thrown', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: record() });
    const r = responder();
    r.sendReply.mockRejectedValue(new Error('re-engagement window closed'));

    await expect(
      handleWhatsappInteractiveReplies({ raw: metaBody([tap('wamid.TAP', 'cb_abc')]), responder: r }),
    ).resolves.toEqual([{ replyId: 'cb_abc', outcome: 'recorded' }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ack reply send failed'),
      expect.anything(),
    );
  });
});

describe('a batch mixing a callback tap with someone else’s button', () => {
  it("fires only the callback id — the other button's tap is left for normal handling", async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: record() });
    const r = responder();

    const results = await handleWhatsappInteractiveReplies({
      raw: metaBody([tap('wamid.OWN', 'menu_refresh'), tap('wamid.TAP', 'cb_abc')]),
      responder: r,
    });

    expect(fireCallback).toHaveBeenCalledTimes(1);
    expect(fireCallback).toHaveBeenCalledWith({ id: 'cb_abc', values: {} });
    expect(results).toEqual([{ replyId: 'cb_abc', outcome: 'recorded' }]);
    expect(r.sendReply).toHaveBeenCalledTimes(1);
  });

  it('a delivery with no callback ids at all fires nothing', async () => {
    const r = responder();
    const results = await handleWhatsappInteractiveReplies({
      raw: metaBody([tap('wamid.OWN', 'menu_refresh')]),
      responder: r,
    });
    expect(results).toEqual([]);
    expect(fireCallback).not.toHaveBeenCalled();
    expect(r.sendReply).not.toHaveBeenCalled();
  });
});
