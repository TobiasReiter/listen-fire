// Wiring pin for the shared-number WhatsApp door: a tapped interactive reply
// button must be recognised and acked BEFORE the ordinary dumb-dispatch path
// sees it, and — unlike Telegram's single callback_query per delivery — the
// rest of the SAME batch must still reach `dispatchWhatsappMessage`
// unaffected (a delivery can carry a tap alongside a plain message). The
// callback door's own recognition/ack/mismatch rules are pinned in
// `services/webhook_sync/__test__/whatsapp_callback_door.unit.test.ts`; this
// file only pins that `interfaces/whatsapp/webhook.ts` actually calls it, with
// the real door logic (only the router and the Meta send client are mocked).

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../lib/slack', () => ({ sendSlackNotification: jest.fn(async () => {}) }));
jest.mock('../../../services/whatsapp/utils', () => ({
  resolveWhatsappSender: jest.fn(async () => ({ teamId: 'team-1', displayName: 'Ada' })),
}));
jest.mock('movement-engine/public/inbound', () => ({
  ...jest.requireActual('movement-engine/public/inbound'),
  verifyWithScheme: jest.fn(() => true),
}));

const dispatchWhatsappMessage = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('../../../services/whatsapp/dispatch', () => ({
  dispatchWhatsappMessage: (...args: unknown[]) => dispatchWhatsappMessage(...args),
}));

const sendTextMessageMock = jest.fn(async () => 'wamid.ACK');
jest.mock('../../../services/whatsapp/metaApi', () => ({
  getMetaWhatsappApi: jest.fn(() => ({ sendTextMessage: sendTextMessageMock })),
}));

// The router is mocked; recognition (`ownsWhatsappInteractiveReply`) and the
// ack wiring (`handleWhatsappInteractiveReplies`) are the REAL implementation
// under test.
const fireCallback = jest.fn();
jest.mock('../../../services/movement_engine/callback_fire', () => ({
  ...jest.requireActual('../../../services/movement_engine/callback_fire'),
  fireCallback: (input: unknown) => fireCallback(input),
}));

import { receiveWebhook } from '../webhook';

function fakeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    sendStatus: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

// A configured app secret and a signature header, because the door is now
// fail-closed without one (`lib/unsigned_webhooks`). The signature check is
// mocked true above — the HMAC is Meta's business, not this wiring pin's.
function deliver(body: unknown) {
  const req = { get: () => 'sha256=stub', body } as any;
  const res = fakeRes();
  const handler = receiveWebhook({ verifyToken: undefined, appSecret: 'test-app-secret' });
  return { req, res, promise: handler(req, res as any) };
}

function metaBody(message: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { display_phone_number: '15550000000', phone_number_id: 'PNID_1' },
              contacts: [{ wa_id: '+15551234567', profile: { name: 'Dev Sender' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sendTextMessageMock.mockResolvedValue('wamid.ACK');
});

// Off-request: the handler kicks off promises but returns before they settle
// (the fire-and-forget doctrine every branch here shares). Flush the
// microtask queue once so the fire-and-forget promises land before assertions.
async function flush() {
  await new Promise((r) => setImmediate(r));
}

describe('the shared WhatsApp door: a callback-id tap', () => {
  it('is fired and acked with a threaded reply — and never reaches dumb dispatch for THIS message', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: { singleUse: true } });
    const message = {
      from: '15551234567',
      id: 'wamid.TAP',
      timestamp: '1700000000',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'cb_abc', title: 'Ship' } },
    };
    const { res, promise } = deliver(metaBody(message));
    await promise;
    await flush();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(fireCallback).toHaveBeenCalledWith({ id: 'cb_abc', values: {} });
    expect(sendTextMessageMock).toHaveBeenCalledWith(
      '15551234567',
      'Thanks — that has been recorded.',
      { replyToMessageId: 'wamid.TAP' },
    );
    // The number that received the tap sends the ack — the responder is keyed
    // by `phone_number_id`, exactly like every other WhatsApp send.
    const getMetaWhatsappApi = jest.requireMock('../../../services/whatsapp/metaApi')
      .getMetaWhatsappApi as jest.Mock;
    expect(getMetaWhatsappApi).toHaveBeenCalledWith('PNID_1');
  });

  it("acks with the closed wording when the callback is already settled — and the ack goes out regardless", async () => {
    fireCallback.mockResolvedValue({ kind: 'closed', callback: {} });
    const message = {
      from: '15551234567',
      id: 'wamid.TAP2',
      timestamp: '1700000001',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'cb_gone', title: 'Ship' } },
    };
    await deliver(metaBody(message)).promise;
    await flush();

    expect(sendTextMessageMock).toHaveBeenCalledWith(
      '15551234567',
      'This request was already closed.',
      { replyToMessageId: 'wamid.TAP2' },
    );
  });
});

describe('a batch that mixes a tap with an ordinary message', () => {
  it('handles the tap AND still dispatches the ordinary message untouched', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: { singleUse: true } });
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { display_phone_number: '15550000000', phone_number_id: 'PNID_1' },
                contacts: [{ wa_id: '+15551234567', profile: { name: 'Dev Sender' } }],
                messages: [
                  {
                    from: '15551234567',
                    id: 'wamid.TAP3',
                    timestamp: '1700000002',
                    type: 'interactive',
                    interactive: { type: 'button_reply', button_reply: { id: 'cb_xyz', title: 'Ship' } },
                  },
                  {
                    from: '15551234567',
                    id: 'wamid.PLAIN',
                    timestamp: '1700000003',
                    type: 'text',
                    text: { body: 'hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await deliver(body).promise;
    await flush();

    expect(fireCallback).toHaveBeenCalledTimes(1);
    expect(fireCallback).toHaveBeenCalledWith({ id: 'cb_xyz', values: {} });
    // Dumb dispatch still runs over EVERY message in the batch — the door
    // narrows what fires a callback, never what reaches ordinary handling.
    expect(dispatchWhatsappMessage).toHaveBeenCalledTimes(2);
  });
});

describe('a non-callback button flows on untouched', () => {
  it("someone's own button vocabulary is never fired through the router", async () => {
    const message = {
      from: '15551234567',
      id: 'wamid.OWN',
      timestamp: '1700000004',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'menu_refresh', title: 'Refresh' } },
    };
    await deliver(metaBody(message)).promise;
    await flush();

    expect(fireCallback).not.toHaveBeenCalled();
    expect(sendTextMessageMock).not.toHaveBeenCalled();
    expect(dispatchWhatsappMessage).toHaveBeenCalledTimes(1);
  });
});

// A rejected signature used to log NOTHING beyond the 401 — an operator whose
// deliveries all bounce (a second Meta app subscribed to the same WhatsApp
// Business Account, signing with a different app secret; or a rotated
// secret) saw only 401s in the access log with no reason. These pin that the
// mismatch and missing-header branches now explain themselves.
describe('a signature that does not verify', () => {
  function deliverWithSignature(body: unknown, signatureHeader: string | undefined) {
    const req = { get: () => signatureHeader, body } as any;
    const res = fakeRes();
    const handler = receiveWebhook({ verifyToken: undefined, appSecret: 'test-app-secret' });
    return { req, res, promise: handler(req, res as any) };
  }

  const { verifyWithScheme } = jest.requireMock('movement-engine/public/inbound') as { verifyWithScheme: jest.Mock };
  const { logger } = jest.requireMock('movement-engine/services/logger') as {
    logger: { warn: jest.Mock };
  };

  it('logs a warn naming the second-app/rotated-secret cause and 401s on a mismatch', async () => {
    verifyWithScheme.mockReturnValueOnce(false);
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-123',
          changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PNID_1' } } }],
        },
      ],
    };

    const { res, promise } = deliverWithSignature(body, 'sha256=wrong');
    await promise;

    expect(res.sendStatus).toHaveBeenCalledWith(401);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "[whatsapp/webhook] REJECTING inbound: signature did not verify against WHATSAPP_WEBHOOK_SECRET — the sending Meta app's secret differs (a second app subscribed to this WhatsApp Business Account, or the secret was reset in Meta)",
      { hasSignature: true, businessAccountId: 'waba-123', phoneNumberId: 'PNID_1' },
    );
  });

  it('logs a warn naming the absent header and 401s when no signature header arrives', async () => {
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'waba-456', changes: [] }] };

    const { res, promise } = deliverWithSignature(body, undefined);
    await promise;

    expect(res.sendStatus).toHaveBeenCalledWith(401);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "[whatsapp/webhook] REJECTING inbound: X-Hub-Signature-256 header was absent — the sending Meta app's secret differs (a second app subscribed to this WhatsApp Business Account, or the secret was reset in Meta)",
      { hasSignature: false, businessAccountId: 'waba-456', phoneNumberId: null },
    );
    // verifySignature is never reached without a header — nothing to verify.
    expect(verifyWithScheme).not.toHaveBeenCalled();
  });

  it('never warns on a valid signature — 200 and dispatch proceeds', async () => {
    const message = {
      from: '15551234567',
      id: 'wamid.OK',
      timestamp: '1700000005',
      type: 'text',
      text: { body: 'hi' },
    };
    const { res, promise } = deliverWithSignature(metaBody(message), 'sha256=valid');
    await promise;
    await new Promise((r) => setImmediate(r));

    expect(res.status).toHaveBeenCalledWith(200);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(dispatchWhatsappMessage).toHaveBeenCalledTimes(1);
  });
});
