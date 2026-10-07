/**
 * The settle-notification seam (A-4, A-5, D39c).
 *
 * Two things matter and the rest is the worker's job: EXACTLY ONE path is
 * active per deployment (a settle is never announced twice), and a
 * notification failure never turns an accepted answer into an error.
 */

const insertInto = jest.fn();
const values = jest.fn();
const execute = jest.fn(async () => undefined);

jest.mock('../../../lib/kysely', () => ({
  getAsksQb: () => ({ insertInto: insertInto.mockReturnValue({ values: values.mockReturnValue({ execute }) }) }),
}));

import { askSettleDelivery } from '../../translation_graph/adapters/ask/delivery_mode';
import {
  notifyAskSettled,
  registerAskSettledNotifier,
} from '../../translation_graph/adapters/ask/notifier';
import type { AskRecord } from '../../translation_graph/adapters/ask/store';

function settled(callbackUrl: string | null): AskRecord {
  return {
    id: 'ask-1' as AskRecord['id'],
    teamId: 'team-1' as AskRecord['teamId'],
    family: 'Check',
    answerType: null,
    prompt: 'q',
    detail: null,
    options: null,
    rows: null,
    state: 'answered',
    answer: true,
    token: 'ask_t',
    url: 'http://example.test/api/asks/ask_t',
    tokenExpiresAt: new Date(),
    provenance: {},
    callbackUrl,
    createdAt: new Date(),
    answeredAt: new Date(),
    expiredAt: null,
  };
}

describe('delivery mode — one active path, chosen by config', () => {
  it('defaults to local, and refuses to guess at anything else', () => {
    expect(askSettleDelivery({})).toBe('local');
    expect(askSettleDelivery({ ASKS_SETTLE_DELIVERY: '' })).toBe('local');
    expect(askSettleDelivery({ ASKS_SETTLE_DELIVERY: 'webhook' })).toBe('webhook');
    expect(() => askSettleDelivery({ ASKS_SETTLE_DELIVERY: 'Webhook' })).toThrow(
      /ASKS_SETTLE_DELIVERY must be "local" or "webhook"/,
    );
  });
});

describe('notifyAskSettled', () => {
  beforeEach(() => {
    insertInto.mockClear();
    values.mockClear();
    execute.mockClear();
    delete process.env.ASKS_SETTLE_DELIVERY;
  });

  it('local: notifies in-process and enqueues NOTHING', async () => {
    const notified: string[] = [];
    registerAskSettledNotifier({
      async notify(ask) {
        notified.push(ask.id);
      },
      async cancelled() {},
    });
    await notifyAskSettled(settled('https://receiver.test/hook'));
    expect(notified).toEqual(['ask-1']);
    expect(insertInto).not.toHaveBeenCalled();
  });

  it('webhook: enqueues the settle and calls NO in-process notifier', async () => {
    const notified: string[] = [];
    registerAskSettledNotifier({
      async notify(ask) {
        notified.push(ask.id);
      },
      async cancelled() {},
    });
    process.env.ASKS_SETTLE_DELIVERY = 'webhook';
    await notifyAskSettled(settled('https://receiver.test/hook'));
    expect(notified).toEqual([]);
    expect(insertInto).toHaveBeenCalledWith('ask_webhook_delivery');
    // The URL is snapshotted onto the delivery row, not joined at send time.
    expect(values).toHaveBeenCalledWith({ ask_id: 'ask-1', url: 'https://receiver.test/hook' });
  });

  it('webhook with no callback_url: nobody asked to be told', async () => {
    process.env.ASKS_SETTLE_DELIVERY = 'webhook';
    await notifyAskSettled(settled(null));
    expect(insertInto).not.toHaveBeenCalled();
  });

  it('never throws — an accepted answer survives a broken notification', async () => {
    registerAskSettledNotifier({
      async notify() {
        throw new Error('receiver exploded');
      },
      async cancelled() {},
    });
    await expect(notifyAskSettled(settled(null))).resolves.toBeUndefined();
  });
});
