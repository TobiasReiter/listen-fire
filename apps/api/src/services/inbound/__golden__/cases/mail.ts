// Inbound mail through Resend (a Svix-signed notification the handler follows
// by fetching the message) and the valuations webhook destination routes.

import type { GoldenCase } from '../harness';

import { signResendWebhook } from '../../../../scripts/dev/lib/resend-sign';
import { withEnv } from '../env';
import { FIXED_NOW_SECONDS, SECRETS } from '../secrets';
import { world } from '../world';
import { define, givenTrigger, json, post, text } from './support';

const ENVELOPE = {
  email_id: 're_golden_1',
  from: 'Ada <ada@example.com>',
  to: ['inbox+deals@example.com'],
  received_for: ['inbox+deals@example.com'],
  message_id: '<m-1@example.com>',
  subject: 'Intro',
};
const received = (data: Record<string, unknown> = {}) => ({ type: 'email.received', data: { ...ENVELOPE, ...data } });
const svix = (secret: string = SECRETS.resend, timestamp: string = FIXED_NOW_SECONDS) => (body: Buffer) => ({
  'content-type': 'application/json',
  ...signResendWebhook({ secret, body: body.toString('utf-8'), timestamp, id: 'msg_golden0001' }),
});
const ROUTED = {
  outcome: 'routed' as const,
  userId: 'user-1',
  teamId: 'team-1',
  route: { teamId: 'team-1', key: 'deals', trigger: { id: 'trigger-1', kind: 'INBOUND_EMAIL' } },
};
const givenMail = (routeOverrides: Record<string, unknown> = {}) => {
  world.emailRoute = { ...ROUTED, route: { ...ROUTED.route, ...routeOverrides } };
  world.resendFetch = {
    id: 're_golden_1',
    from: 'Ada <ada@example.com>',
    to: ['inbox+deals@example.com'],
    received_for: ['inbox+deals@example.com'],
    message_id: '<m-1@example.com>',
    subject: 'Intro',
    text: 'Hello there',
    headers: {},
    attachments: [],
  };
  world.emailActingUser = { userId: 'user-1' };
};
const PATH = '/api/resend/callback';

export const resendCases: GoldenCase[] = define('resend', [
  {
    id: 'mail-routed-to-trigger',
    note: 'A signed email.received is verified, routed, its message fetched, and stored against the matching trigger before the 201.',
    arrange: () => {
      givenMail();
      givenTrigger({ kind: 'INBOUND_EMAIL' });
    },
    request: post(PATH, json(received()), svix()),
  },
  {
    id: 'mail-no-trigger-matches-quarantined',
    note: 'Authenticated mail nothing listens for is stored for replay, ops is told, and the answer is 200.',
    arrange: () => givenMail({ trigger: null }),
    request: post(PATH, json(received()), svix()),
  },
  {
    id: 'mail-trigger-not-live-quarantined',
    note: 'A matching trigger with no movement behind it is not dispatched; the mail is quarantined.',
    arrange: () => {
      givenMail();
      givenTrigger({ kind: 'INBOUND_EMAIL' });
      world.emailTriggerLive = false;
    },
    request: post(PATH, json(received()), svix()),
  },
  {
    id: 'sender-not-a-team-member',
    note: 'Mail whose sender maps to no acting user is 401 after the fetch.',
    arrange: () => {
      givenMail();
      world.emailActingUser = null;
    },
    request: post(PATH, json(received()), svix()),
  },
  {
    id: 'fetch-fails',
    note: 'A Resend API outage while fetching the message is a retryable 500.',
    arrange: () => {
      givenMail();
      world.resendFetch = 'fail';
    },
    request: post(PATH, json(received()), svix()),
  },
  {
    id: 'secret-unset',
    note: 'With no webhook secret configured every delivery is refused 401.',
    arrange: () => withEnv({ RESEND_WEBHOOK_SECRET: undefined }),
    request: post(PATH, json(received()), svix()),
  },
  {
    id: 'bad-signature',
    note: 'A delivery signed with another key is refused 406 (never a code Resend retries).',
    arrange: () => givenMail(),
    request: post(PATH, json(received()), svix(`whsec_${Buffer.from('some-other-key').toString('base64')}`)),
  },
  {
    id: 'missing-signature',
    note: 'No Svix headers: 406.',
    arrange: () => givenMail(),
    request: post(PATH, json(received())),
  },
  {
    id: 'stale-timestamp',
    note: 'A correctly signed delivery older than the tolerance is 406 (replay protection).',
    arrange: () => givenMail(),
    request: post(PATH, json(received()), svix(SECRETS.resend, String(Number(FIXED_NOW_SECONDS) - 3600))),
  },
  {
    id: 'other-event-type-acknowledged',
    note: 'Resend sends its whole event stream here; anything that is not mail arriving is acknowledged 200 and ignored.',
    arrange: () => givenMail(),
    request: post(PATH, json({ type: 'email.delivered', data: { email_id: 're_x' } }), svix()),
  },
  {
    id: 'received-without-email-id',
    note: 'An email.received with no email id is 406.',
    arrange: () => givenMail(),
    request: post(PATH, json({ type: 'email.received', data: { from: 'Ada <ada@example.com>' } }), svix()),
  },
  {
    id: 'received-without-sender',
    note: 'No parseable sender is 406.',
    arrange: () => givenMail(),
    request: post(PATH, json(received({ from: 'nobody' })), svix()),
  },
  {
    id: 'sender-unrecognised-refused-201',
    note: 'Routing refuses a sender with no account (201, so the provider does not retry).',
    arrange: () => {
      world.emailRoute = { outcome: 'refused', status: 201 };
    },
    request: post(PATH, json(received()), svix()),
  },
  {
    id: 'not-json-content-type',
    note: 'Without the raw body the signature can never be checked: 406.',
    arrange: () => givenMail(),
    request: post(PATH, text('plain'), { 'content-type': 'text/plain' }),
  },
]);

// ── valuations webhook destinations (authenticated management) ────────────

const WEBHOOKS = '/api/v1/valuations/webhooks';
const DESTINATION = 'https://hooks.subscriber.test/valuations';

export const valuationsWebhookCases: GoldenCase[] = define('valuations_webhooks', [
  {
    id: 'register-new-destination',
    note: 'Registering a URL inserts one subscription row per requested event type and returns their ids.',
    request: post(WEBHOOKS, json({ url: DESTINATION, eventTypes: ['valuations:legal_entity:create', 'valuations:investment:update'], secret: 'golden-subscriber-secret-0001' })),
  },
  {
    id: 'register-existing-destination-rotates-secret',
    note: 'Re-registering reuses existing rows, inserts only the missing types and rotates the secret across the existing rows.',
    arrange: () => {
      world.valuationsRows = [{ id: 'row-1', event_type: 'valuations:legal_entity:create' }];
    },
    request: post(WEBHOOKS, json({ url: DESTINATION, eventTypes: ['valuations:legal_entity:create', 'valuations:investment:update'], secret: 'golden-subscriber-secret-0002' })),
  },
  {
    id: 'register-invalid-event-type',
    note: 'An event type outside the valuations shape is 400 with the issue tree.',
    request: post(WEBHOOKS, json({ url: DESTINATION, eventTypes: ['attio:record:create'] })),
  },
  {
    id: 'register-short-secret',
    note: 'A secret under 16 characters is 400.',
    request: post(WEBHOOKS, json({ url: DESTINATION, eventTypes: ['valuations:legal_entity:create'], secret: 'short' })),
  },
  {
    id: 'delete-destination',
    note: 'DELETE soft-deletes every row for the url and reports the count.',
    request: { method: 'DELETE', path: `${WEBHOOKS}?url=${encodeURIComponent(DESTINATION)}`, headers: {}, body: { kind: 'none' } },
  },
  {
    id: 'delete-without-url',
    note: 'No url query parameter is 400.',
    request: { method: 'DELETE', path: WEBHOOKS, headers: {}, body: { kind: 'none' } },
  },
  {
    id: 'list-destinations-grouped-by-url',
    note: 'GET lists active destinations grouped by url.',
    arrange: () => {
      world.valuationsRows = [
        { id: 'row-1', url: DESTINATION, event_type: 'valuations:legal_entity:create', name: 'Valuations -> hooks.subscriber.test', created_at: '2026-10-01T00:00:00.000Z' },
        { id: 'row-2', url: DESTINATION, event_type: 'valuations:investment:update', name: 'Valuations -> hooks.subscriber.test', created_at: '2026-10-01T00:00:00.000Z' },
      ];
    },
    request: { method: 'GET', path: WEBHOOKS, headers: {}, body: { kind: 'none' } },
  },
]);
