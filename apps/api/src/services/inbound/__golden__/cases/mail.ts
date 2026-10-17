// Inbound mail through Resend (a Svix-signed notification the handler follows
// by fetching the message) and the valuations webhook destination routes.

import type { GoldenCase } from '../harness';

import { signMailgunPayload } from '../../../../scripts/dev/lib/mailgun-sign';
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

// ── Mailgun: inbound mail (a form post, signed with the account key) ──────

const MAILGUN_PATH = '/api/mailgun/callback';
const MAILGUN_EVENT_PATH = '/api/webhook/mailgun/event';
const MAILGUN_ENV = { NODE_ENV: 'production', MAILGUN_API_KEY: SECRETS.mailgunApiKey, INBOUND_EMAIL_ADDRESS: 'inbox@example.com' };
const mailgunSigned = (apiKey: string = SECRETS.mailgunApiKey) =>
  signMailgunPayload({ apiKey, timestamp: FIXED_NOW_SECONDS, token: 'golden-mailgun-token-0001' });
const mailgunForm = (fields: Record<string, string> = {}, signing: Record<string, string> = { ...mailgunSigned() }) => ({
  kind: 'form' as const,
  fields: {
    sender: 'ada@example.com',
    recipient: 'inbox+deals@example.com',
    To: 'inbox+deals@example.com',
    subject: 'Intro',
    'body-plain': 'Hello there',
    'Message-Id': '<m-1@example.com>',
    ...signing,
    ...fields,
  },
});
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const givenMailMember = (email = 'ada@example.com') => {
  world.mailMembers[email] = [{ teamId: 'team-1', userId: 'user-1' }];
  world.mailAccess['user-1 team-1'] = true;
  world.emailActingUser = { userId: 'user-1' };
};
const givenMailTrigger = () => {
  world.mailKeyTriggers['team-1 deals'] = { id: 'trigger-1', kind: 'INBOUND_EMAIL' };
  givenTrigger({ kind: 'INBOUND_EMAIL' });
};
const mailgunArrange = (setup: () => void = () => undefined) => () => {
  const restore = withEnv(MAILGUN_ENV);
  setup();
  return restore;
};

export const mailgunCases: GoldenCase[] = define('mailgun', [
  {
    id: 'mail-routed-to-trigger',
    note: 'A signed form post from a team member to a keyed address is stored against the matching trigger before the 201.',
    arrange: mailgunArrange(() => {
      givenMailMember();
      givenMailTrigger();
    }),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm() },
  },
  {
    id: 'mail-no-key-quarantined',
    note: 'Authenticated mail whose recipients carry no routing key is stored for replay, ops is told, and the answer is 200.',
    arrange: mailgunArrange(() => givenMailMember()),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm({ To: 'someone@example.com' }) },
  },
  {
    id: 'mail-key-names-no-trigger-quarantined',
    note: 'A routing key no trigger of the sender\'s team answers for is quarantined, not dropped.',
    arrange: mailgunArrange(() => givenMailMember()),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm() },
  },
  {
    id: 'mail-trigger-not-live-quarantined',
    note: 'A matching trigger with no movement behind it is not dispatched; the mail is quarantined.',
    arrange: mailgunArrange(() => {
      givenMailMember();
      givenMailTrigger();
      world.emailTriggerLive = false;
    }),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm() },
  },
  {
    id: 'mail-key-in-two-teams-dropped',
    note: 'A key that two of the sender\'s teams own is ambiguous: 201, nothing runs.',
    arrange: mailgunArrange(() => {
      world.mailMembers['ada@example.com'] = [
        { teamId: 'team-1', userId: 'user-1' },
        { teamId: 'team-2', userId: 'user-1' },
      ];
      world.mailAccess['user-1 team-1'] = true;
      world.mailAccess['user-1 team-2'] = true;
      world.mailKeyTriggers['team-1 deals'] = { id: 'trigger-1', kind: 'INBOUND_EMAIL' };
      world.mailKeyTriggers['team-2 deals'] = { id: 'trigger-2', kind: 'INBOUND_EMAIL' };
    }),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm() },
  },
  {
    id: 'sender-unrecognised-refused-201',
    note: 'A sender with no account and no service address for their domain is 201 and ops is told.',
    arrange: mailgunArrange(),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm({ sender: 'stranger@elsewhere.test' }) },
  },
  {
    id: 'sender-without-access-refused-201',
    note: 'A known login that may not act for the team is not a sender for it: 201.',
    arrange: mailgunArrange(() => {
      world.mailMembers['ada@example.com'] = [{ teamId: 'team-1', userId: 'user-1' }];
      world.mailAccess['user-1 team-1'] = false;
    }),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm() },
  },
  {
    id: 'same-domain-service-address-answers',
    note: 'A stranger from a domain whose shared inbox a team registered is routed to that team.',
    arrange: mailgunArrange(() => {
      world.mailRoutes.push({ address: 'shared@example.org', team_id: 'team-1', is_service_email: true, accepts_plus_addressing: false });
      world.mailMembers['shared@example.org'] = [{ teamId: 'team-1', userId: 'user-1' }];
      world.mailAccess['user-1 team-1'] = true;
      world.emailActingUser = { userId: 'user-1' };
      givenMailTrigger();
    }),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm({ sender: 'newcomer@example.org' }) },
  },
  {
    id: 'sender-not-a-team-member',
    note: 'Mail whose sender maps to no acting user is 401 after routing.',
    arrange: mailgunArrange(() => {
      givenMailMember();
      world.emailActingUser = null;
    }),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm() },
  },
  {
    id: 'store-fails',
    note: 'A failure writing the trigger event is a retryable 500.',
    arrange: mailgunArrange(() => {
      givenMailMember();
      givenMailTrigger();
      world.storeFails = true;
    }),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm() },
  },
  {
    id: 'bad-signature',
    note: 'A signature made with another key is 406 (never a code Mailgun retries).',
    arrange: mailgunArrange(() => givenMailMember()),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm({}, { ...mailgunSigned('some-other-key') }) },
  },
  {
    id: 'signature-of-another-length',
    note: 'A signature of the wrong length is a wrong signature, 406, not an error.',
    arrange: mailgunArrange(() => givenMailMember()),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm({ signature: 'abc' }) },
  },
  {
    id: 'missing-signature-fields',
    note: 'No timestamp, token or signature at all: 406.',
    arrange: mailgunArrange(() => givenMailMember()),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm({}, {}) },
  },
  {
    id: 'no-sender-field',
    note: 'A post with no sender is not an inbound email: 406.',
    arrange: mailgunArrange(),
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: { kind: 'form', fields: { ...mailgunSigned() } } },
  },
  {
    id: 'no-signing-key-configured',
    note: 'A production deployment with no Mailgun key refuses every delivery 401.',
    arrange: () => {
      const restore = withEnv({ ...MAILGUN_ENV, MAILGUN_API_KEY: undefined });
      givenMailMember();
      return restore;
    },
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm() },
  },
  {
    id: 'test-harness-key-outside-production',
    note: 'Outside production, only a harness deployment has a signing key: the fixed harness key signs.',
    arrange: () => {
      const restore = withEnv({ ...MAILGUN_ENV, NODE_ENV: 'development', TEST_HARNESS_TEAM_ID: 'team-1' });
      givenMailMember();
      givenMailTrigger();
      return restore;
    },
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm({}, { ...mailgunSigned('test-harness-dummy-key') }) },
  },
  {
    id: 'not-production-no-harness-refused',
    note: 'Outside production and without a harness team there is no signing key: 401.',
    arrange: () => {
      const restore = withEnv({ ...MAILGUN_ENV, NODE_ENV: 'development', TEST_HARNESS_TEAM_ID: undefined });
      givenMailMember();
      return restore;
    },
    request: { method: 'POST', path: MAILGUN_PATH, headers: FORM, body: mailgunForm() },
  },
]);

// ── Mailgun's event sink (delivery telemetry; a signed 200 sink) ──────────

const eventBody = (signature: unknown) => json({ signature, 'event-data': { event: 'delivered' } });

export const mailgunEventCases: GoldenCase[] = define('mailgun_events', [
  {
    id: 'signed-event-acknowledged',
    note: 'A correctly signed event is acknowledged 200 and nothing is kept.',
    arrange: () => withEnv({ MAILGUN_API_KEY: SECRETS.mailgunApiKey, PUBLIC_USER_ID: 'public-user' }),
    request: post(MAILGUN_EVENT_PATH, eventBody({ ...mailgunSigned() })),
  },
  {
    id: 'bad-signature',
    note: 'A signature made with another key is 406, so Mailgun does not retry.',
    arrange: () => withEnv({ MAILGUN_API_KEY: SECRETS.mailgunApiKey, PUBLIC_USER_ID: 'public-user' }),
    request: post(MAILGUN_EVENT_PATH, eventBody({ ...mailgunSigned('some-other-key') })),
  },
  {
    id: 'signature-of-another-length',
    note: 'A signature of the wrong length is judged like any other wrong signature.',
    arrange: () => withEnv({ MAILGUN_API_KEY: SECRETS.mailgunApiKey, PUBLIC_USER_ID: 'public-user' }),
    request: post(MAILGUN_EVENT_PATH, eventBody({ timestamp: FIXED_NOW_SECONDS, token: 'golden-mailgun-token-0001', signature: 'abc' })),
  },
  {
    id: 'no-signature-object',
    note: 'A body with no signature block cannot be judged.',
    arrange: () => withEnv({ MAILGUN_API_KEY: SECRETS.mailgunApiKey, PUBLIC_USER_ID: 'public-user' }),
    request: post(MAILGUN_EVENT_PATH, json({ 'event-data': { event: 'delivered' } })),
  },
]);
