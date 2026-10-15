// The Resend door, and the fetch that has to follow it.
//
// Routing is mocked out on purpose: whose team a message belongs to is asked
// in one place for both providers and is proved over there
// (`inbound_door.unit.test.ts`). What is proved HERE is the part that is
// Resend's alone — believing a Svix delivery, reading its envelope, and
// turning an id into an email an author can read.

import type { Request } from 'express';

import { signResendWebhook } from '../../../../../scripts/dev/lib/resend-sign';

const routed = {
  outcome: 'routed' as const,
  userId: 'user-1',
  teamId: 'team-1',
  route: { teamId: 'team-1', key: 'deals', trigger: null },
};

const routeInboundEmail = jest.fn().mockResolvedValue(routed);

jest.mock('../inbound_door', () => ({
  routeInboundEmail: (...args: unknown[]) => routeInboundEmail(...args),
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
}));

import { fetchResendEmailPayload, verifyResendInboundRequest } from '../resend_inbound';

const SECRET = 'whsec_ZGV2LWxvb3AtcmVzZW5kLXNlY3JldA==';

function delivery(body: Record<string, unknown>): Request {
  const raw = JSON.stringify(body);
  const signed = signResendWebhook({ secret: SECRET, body: raw });
  return { body: Buffer.from(raw), headers: signed } as unknown as Request;
}

function received(overrides: Record<string, unknown> = {}) {
  return {
    type: 'email.received',
    data: {
      email_id: 're_1',
      from: 'Ada <ada@example.com>',
      to: ['inbox+deals@example.com'],
      received_for: ['inbox+deals@example.com'],
      message_id: '<m-1@example.com>',
      subject: 'Intro',
      ...overrides,
    },
  };
}

beforeEach(() => {
  routeInboundEmail.mockClear();
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
});

describe('the Resend door', () => {
  it('routes a delivery it believes, on the envelope’s addresses', async () => {
    const decision = await verifyResendInboundRequest(delivery(received()));
    expect(decision).toEqual(routed);
    expect(routeInboundEmail).toHaveBeenCalledWith({
      recipients: ['inbox+deals@example.com'],
      senderCandidates: ['ada@example.com'],
    });
  });

  it('refuses a delivery whose signature does not verify', async () => {
    const req = delivery(received());
    const decision = await verifyResendInboundRequest({
      ...req,
      headers: { ...req.headers, 'svix-signature': 'v1,bm90LWl0' },
    } as unknown as Request);
    expect(decision).toEqual({ outcome: 'refused', status: 406 });
    expect(routeInboundEmail).not.toHaveBeenCalled();
  });

  it('refuses everything when no webhook secret is configured', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    expect(await verifyResendInboundRequest(delivery(received()))).toEqual({
      outcome: 'refused',
      status: 401,
    });
  });

  it('refuses a body it was handed already parsed — the signature covers bytes', async () => {
    const decision = await verifyResendInboundRequest({
      body: received(),
      headers: {},
    } as unknown as Request);
    expect(decision).toEqual({ outcome: 'refused', status: 406 });
  });

  it('acknowledges an event that is not mail arriving, rather than retrying forever', async () => {
    const decision = await verifyResendInboundRequest(
      delivery({ type: 'email.delivered', data: { email_id: 're_1' } }),
    );
    expect(decision).toEqual({ outcome: 'refused', status: 200 });
    expect(routeInboundEmail).not.toHaveBeenCalled();
  });

  it('refuses mail with no sender to answer for it', async () => {
    expect(await verifyResendInboundRequest(delivery(received({ from: 'not-an-address' })))).toEqual(
      { outcome: 'refused', status: 406 },
    );
  });
});

describe('fetching the message the webhook only named', () => {
  const email = {
    id: 're_1',
    from: 'Ada <ada@example.com>',
    to: ['inbox+deals@example.com'],
    received_for: ['inbox+deals@example.com'],
    subject: 'Intro',
    text: 'the body',
    html: '<p>the body</p>',
    message_id: '<m-1@example.com>',
    headers: { 'X-Forwarded-For': 'dealflow@acme.com' },
  };

  it('shapes it like every other email, attachment handles included', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => email })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'att_1', filename: 'deck.pdf', content_type: 'application/pdf', size: 12 }],
          has_more: false,
        }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const payload = await fetchResendEmailPayload('re_1');

    expect(payload).toMatchObject({
      messageId: '<m-1@example.com>',
      subject: 'Intro',
      sender: 'Ada <ada@example.com>',
      recipient: 'inbox+deals@example.com',
      bodyText: 'the body',
      bodyHtml: '<p>the body</p>',
      attachments: [
        {
          key: 'resend:re_1/att_1',
          filename: 'deck.pdf',
          contentType: 'application/pdf',
          size: 12,
        },
      ],
    });
    // Forwarding headers reach the acting-user chain where it looks for them:
    // flat, the way Mailgun sends them.
    expect(payload['X-Forwarded-For']).toBe('dealflow@acme.com');
  });

  it('falls back to the email id when the message carries no Message-Id', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...email, message_id: undefined }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [], has_more: false }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await fetchResendEmailPayload('re_1')).toMatchObject({ messageId: 're_1' });
  });
});
