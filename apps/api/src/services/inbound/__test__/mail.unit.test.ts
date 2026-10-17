// The inbound core's mail doors and shared-door admission, over an in-memory
// store: every status a refusal earns, without a database or a directory.

import {
  admitMailgunMail,
  admitResendMail,
  admitShared,
  judgeMailgunEvent,
  parseEmailAddress,
  type InboundEmailDecision,
  type RoutableMessage,
} from 'movement-engine/public/inbound';

import { signMailgunPayload } from '../../../scripts/dev/lib/mailgun-sign';
import { signResendWebhook } from '../../../scripts/dev/lib/resend-sign';

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const ROUTED: InboundEmailDecision = {
  outcome: 'routed',
  userId: 'user-1',
  teamId: 'team-1',
  route: { teamId: 'team-1', key: null, trigger: null },
};

function routedTo(seen: RoutableMessage[]): (message: RoutableMessage) => Promise<InboundEmailDecision> {
  return async (message) => {
    seen.push(message);
    return ROUTED;
  };
}

const MAILGUN_KEY = 'mailgun-key';
const mailgunForm = (fields: Record<string, string> = {}, apiKey: string = MAILGUN_KEY) => ({
  sender: 'ada@example.com',
  To: 'Inbox <inbox+deals@example.com>, other@example.com',
  'X-Forwarded-For': 'proxy@example.com other',
  ...signMailgunPayload({ apiKey, timestamp: '1792238400', token: 'tok' }),
  ...fields,
});

describe('parseEmailAddress', () => {
  it('reads the bare lower-case address, or null without an @', () => {
    expect(parseEmailAddress('"Ada" <Ada@Example.com>')).toBe('ada@example.com');
    expect(parseEmailAddress('nobody')).toBeNull();
    expect(parseEmailAddress(undefined)).toBeNull();
  });
});

describe('admitMailgunMail', () => {
  const store = (seen: RoutableMessage[] = [], key: string | null = MAILGUN_KEY) => ({
    route: routedTo(seen),
    mailgunSigningKey: () => key ?? undefined,
  });

  it('routes a signed post on its recipients and sender candidates, proxy first', async () => {
    const seen: RoutableMessage[] = [];
    await expect(admitMailgunMail(store(seen), mailgunForm())).resolves.toEqual(ROUTED);
    expect(seen).toEqual([
      expect.objectContaining({
        recipients: ['inbox+deals@example.com', 'other@example.com'],
        senderCandidates: ['proxy@example.com', 'ada@example.com'],
      }),
    ]);
  });

  it.each([
    ['another key', mailgunForm({}, 'other-key'), MAILGUN_KEY, 406],
    ['a signature of another length', mailgunForm({ signature: 'abc' }), MAILGUN_KEY, 406],
    ['no signature at all', { sender: 'ada@example.com' }, MAILGUN_KEY, 406],
    ['no sender', { signature: 'x' }, MAILGUN_KEY, 406],
    ['a body that is not an object', 'text', MAILGUN_KEY, 406],
    ['no signing key', mailgunForm(), null, 401],
  ])('refuses %s without routing', async (_label, body, key, status) => {
    const seen: RoutableMessage[] = [];
    await expect(admitMailgunMail(store(seen, key), body)).resolves.toEqual({ outcome: 'refused', status });
    expect(seen).toEqual([]);
  });
});

describe('judgeMailgunEvent', () => {
  const signature = signMailgunPayload({ apiKey: MAILGUN_KEY, timestamp: '1', token: 't' });
  it('verifies a signature made with the key', () => {
    expect(judgeMailgunEvent({ signature, apiKey: MAILGUN_KEY })).toBe('verified');
  });
  it.each([
    ['another key', signature, 'other'],
    ['another length', { ...signature, signature: 'abc' }, MAILGUN_KEY],
    ['a missing block', undefined, MAILGUN_KEY],
    ['a block of the wrong shape', { token: 1, timestamp: 2, signature: 3 }, MAILGUN_KEY],
  ])('refuses %s', (_label, block, apiKey) => {
    expect(judgeMailgunEvent({ signature: block, apiKey })).toBe('refused');
  });
  it('is misconfigured when the host has no key', () => {
    expect(judgeMailgunEvent({ signature, apiKey: null })).toBe('misconfigured');
  });
});

describe('admitResendMail', () => {
  const SECRET = `whsec_${Buffer.from('resend-test-key').toString('base64')}`;
  const store = (seen: RoutableMessage[] = [], secret: string | null = SECRET) => ({
    route: routedTo(seen),
    resendWebhookSecret: () => secret ?? undefined,
  });
  const envelope = (type = 'email.received', data: Record<string, unknown> = {}) =>
    JSON.stringify({ type, data: { email_id: 're_1', from: 'Ada <ada@example.com>', to: ['inbox+deals@example.com'], ...data } });
  const delivery = (body: string, secret: string = SECRET) => ({
    rawBody: Buffer.from(body),
    headers: signResendWebhook({ secret, body }),
  });

  it('routes a signed email.received on the envelope', async () => {
    const seen: RoutableMessage[] = [];
    await expect(admitResendMail(store(seen), delivery(envelope()))).resolves.toEqual(ROUTED);
    expect(seen).toEqual([{ recipients: ['inbox+deals@example.com'], senderCandidates: ['ada@example.com'] }]);
  });

  it.each([
    ['no raw body', { rawBody: null, headers: {} }, SECRET, 406],
    ['no secret', delivery(envelope()), null, 401],
    ['an empty secret', delivery(envelope()), '', 401],
    ['a signature from another key', delivery(envelope(), `whsec_${Buffer.from('another').toString('base64')}`), SECRET, 406],
    ['another event type (acknowledged)', delivery(envelope('email.delivered')), SECRET, 200],
    ['an envelope with no email id', delivery(JSON.stringify({ type: 'email.received', data: { from: 'a@b.c' } })), SECRET, 406],
    ['no sender', delivery(envelope('email.received', { from: 'nobody' })), SECRET, 406],
  ])('answers %s with %d', async (_label, input, secret, status) => {
    const seen: RoutableMessage[] = [];
    await expect(admitResendMail(store(seen, secret), input)).resolves.toEqual({ outcome: 'refused', status });
    expect(seen).toEqual([]);
  });
});

describe('admitShared', () => {
  const SLACK = { verifier: { scheme: 'slack_v0' as const, signatureHeaders: ['x-slack-signature'] }, intercepts: ['slack_url_verification' as const] };
  const challenge = Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'c-1' }));
  const never = () => false;

  it('answers the setup check before looking at the signature or the key', () => {
    expect(admitShared(SLACK, { rawBody: challenge, headers: {}, secret: null, allowUnsigned: never })).toEqual({
      kind: 'answered',
      answer: { status: 200, body: { challenge: 'c-1' } },
    });
  });

  it('refuses an unset key unless the host allows unsigned, and a wrong signature always', () => {
    const body = Buffer.from('{}');
    expect(admitShared(SLACK, { rawBody: body, headers: {}, secret: null, allowUnsigned: never })).toEqual({ kind: 'refused', reason: 'no_secret' });
    expect(admitShared(SLACK, { rawBody: body, headers: {}, secret: null, allowUnsigned: () => true })).toEqual({ kind: 'admitted' });
    expect(admitShared(SLACK, { rawBody: body, headers: {}, secret: 'k', allowUnsigned: () => true })).toEqual({ kind: 'refused', reason: 'signature_invalid' });
  });
});
