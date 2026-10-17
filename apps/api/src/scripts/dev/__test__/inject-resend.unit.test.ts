/**
 * Coverage for the `dev:inject resend-email` wrapper.
 *
 * The thing worth pinning is the two-step shape. Resend's webhook carries no
 * message, so the injector has to seed the fake receiving API BEFORE it fires
 * the notification — fire alone and the API fetches an email that does not
 * exist, which looks exactly like a routing bug and is not one.
 *
 * The signature is proved against the real verifier
 * (`services/inbound/svix.ts`), over the exact bytes the injector posts.
 */
import * as fs from 'node:fs/promises';

import {
  buildResendWebhookBody,
  DEFAULT_RESEND_FIXTURE,
  DEFAULT_RESEND_WEBHOOK_SECRET,
  injectResendEmail,
} from '../inject';
import { verifySvixSignature } from 'movement-engine/public/inbound';

const TO = 'inbox+pi-devloop@example.com';

describe('the email.received body the injector builds', () => {
  it('carries the ids and the envelope, and no message', () => {
    const body = buildResendWebhookBody({
      emailId: 're_1',
      to: TO,
      from: 'Dev Loop <dev-loop@listen-fire.local>',
      messageId: '<m-1@listen-fire.local>',
      subject: 'Intro',
      attachments: [{ id: 'att_1', filename: 'deck.pdf', content_type: 'application/pdf' }],
      now: '2026-08-27T00:00:00.000Z',
    });

    expect(body.type).toBe('email.received');
    expect(body.data).toMatchObject({
      email_id: 're_1',
      to: [TO],
      received_for: [TO],
      message_id: '<m-1@listen-fire.local>',
      subject: 'Intro',
    });
    // The bodies and the bytes are the API's to serve, not the webhook's.
    expect(JSON.stringify(body)).not.toMatch(/"html"|"text"|"content"/);
  });
});

describe('the fixture the dev loop ships', () => {
  it('has an id, a message id and an attachment with real bytes', async () => {
    const fixture = JSON.parse(await fs.readFile(DEFAULT_RESEND_FIXTURE, 'utf-8'));
    expect(typeof fixture.id).toBe('string');
    expect(typeof fixture.message_id).toBe('string');
    expect(fixture.attachments[0]).toMatchObject({ id: expect.any(String) });
    expect(Buffer.from(fixture.attachments[0].content, 'base64').length).toBeGreaterThan(0);
  });
});

describe('injectResendEmail', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  afterEach(() => fetchSpy.mockRestore());

  it('seeds the fake receiving API before it fires the webhook', async () => {
    await injectResendEmail({ to: TO });

    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain('/resend/_seed/received');
    expect(urls[1]).toContain('/api/resend/callback');

    // The seeded message is addressed to the address under test, so the door
    // routes on the same value the webhook announces.
    const seeded = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(seeded.to).toEqual([TO]);
    expect(seeded.received_for).toEqual([TO]);
  });

  it('signs the exact bytes it posts', async () => {
    await injectResendEmail({ to: TO });

    const [, init] = fetchSpy.mock.calls[1];
    const headers = init?.headers as Record<string, string>;
    const body = String(init?.body);

    expect(
      verifySvixSignature({
        secret: DEFAULT_RESEND_WEBHOOK_SECRET,
        headers: {
          id: headers['svix-id'],
          timestamp: headers['svix-timestamp'],
          signature: headers['svix-signature'],
        },
        body,
      }),
    ).toBe('verified');
  });

  it('honours from and subject overrides on both steps', async () => {
    await injectResendEmail({ to: TO, from: 'ada@example.com', subject: 'Changed' });

    const seeded = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    const announced = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body));
    expect(seeded).toMatchObject({ from: 'ada@example.com', subject: 'Changed' });
    expect(announced.data).toMatchObject({ from: 'ada@example.com', subject: 'Changed' });
  });

  it('says so when fake-channels is not there, rather than firing into the void', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('no', { status: 502 }));
    await expect(injectResendEmail({ to: TO })).rejects.toThrow(/is fake-channels running/);
  });
});
