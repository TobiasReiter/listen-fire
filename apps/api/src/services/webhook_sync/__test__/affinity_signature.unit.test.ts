// Affinity's optional HMAC verification (2026-07-05): without a configured
// key the URL-trust stance holds; WITH a key, deliveries verify strictly —
// SHA256 HMAC of the raw body, accepted as hex or base64, optional
// `sha256=` prefix, and an unsigned delivery is rejected.

jest.mock('../../../lib/credentials', () => ({
  decryptToken: async () => JSON.stringify(storedCredential),
}));

jest.mock('../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: () => {
      const api = {
        where: () => api,
        select: () => api,
        executeTakeFirstOrThrow: async () => ({ id: 'cred-1', credentials: 'enc' }),
      };
      return api;
    },
  });
  return { getQb: qb, getCoreQb: qb, getAutomationsQb: qb };
});

const createdSubscriptions: unknown[] = [];
jest.mock('../../../adapters/affinity/apiClient', () => ({
  affinityCredsParser: { parse: (v: unknown) => v },
  getAffinityClient: () => ({
    createWebhookSubscription: async (args: unknown) => {
      createdSubscriptions.push(args);
      return { id: 77 };
    },
  }),
}));

import crypto from 'node:crypto';

import { affinityProvider } from '../providers/affinity';

let storedCredential: Record<string, unknown> = { apiKey: 'k' };

const KEY = 'affinity-signature-key';
const BODY = Buffer.from(JSON.stringify({ type: 'organization.created', body: { id: 1 } }));
const hexSig = () => crypto.createHmac('sha256', KEY).update(BODY).digest('hex');
const b64Sig = () => crypto.createHmac('sha256', KEY).update(BODY).digest('base64');

describe('affinityProvider.verifySignature', () => {
  it('URL-trust when no key is configured (empty secret)', () => {
    expect(affinityProvider.verifySignature(BODY, '', '')).toBe(true);
    expect(affinityProvider.verifySignature(BODY, 'anything', '')).toBe(true);
  });

  it('accepts a correct HMAC as hex, base64, or sha256=-prefixed', () => {
    expect(affinityProvider.verifySignature(BODY, hexSig(), KEY)).toBe(true);
    expect(affinityProvider.verifySignature(BODY, b64Sig(), KEY)).toBe(true);
    expect(affinityProvider.verifySignature(BODY, `sha256=${hexSig()}`, KEY)).toBe(true);
  });

  it('rejects a wrong signature and an unsigned delivery once a key is set', () => {
    const tampered = crypto.createHmac('sha256', 'other-key').update(BODY).digest('hex');
    expect(affinityProvider.verifySignature(BODY, tampered, KEY)).toBe(false);
    expect(affinityProvider.verifySignature(BODY, 'not-a-signature', KEY)).toBe(false);
    expect(affinityProvider.verifySignature(BODY, '', KEY)).toBe(false);
  });
});

describe('affinityProvider.registerSubscription', () => {
  it('stores the credential webhook key as the subscription secret when present', async () => {
    storedCredential = { apiKey: 'k', webhookSignatureKey: KEY };
    const registered = await affinityProvider.registerSubscription({
      credentialsId: 'cred-1',
      teamId: 'team-1',
      targetUrl: 'https://x/api/public/webhook-sync/affinity/sub-1',
      eventTypes: ['organization.created'],
    } as never);
    expect(registered).toEqual({ externalId: '77', secret: KEY });
  });

  it('keeps the URL-trust stance (empty secret) without a key', async () => {
    storedCredential = { apiKey: 'k' };
    const registered = await affinityProvider.registerSubscription({
      credentialsId: 'cred-1',
      teamId: 'team-1',
      targetUrl: 'https://x/api/public/webhook-sync/affinity/sub-1',
      eventTypes: ['organization.created'],
    } as never);
    expect(registered.secret).toBe('');
  });
});
