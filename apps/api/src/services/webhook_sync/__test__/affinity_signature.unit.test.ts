// Affinity's HMAC verification, as the webhook door applies it: SHA256 HMAC
// of the raw body, accepted as hex or base64, optional `sha256=` prefix, and
// an unsigned delivery is rejected. Without a configured key every delivery
// is refused: Affinity's module declares its inbound signed, and the host's
// one rule refuses a missing key (before the module, URL secrecy carried it).

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
jest.mock('@listen-fire/affinity/api_client', () => ({
  affinityCredsParser: { parse: (v: unknown) => v },
  getAffinityClient: () => ({
    createWebhookSubscription: async (args: unknown) => {
      createdSubscriptions.push(args);
      return { id: 77 };
    },
  }),
}));

import crypto from 'node:crypto';

import { verifyInbound } from 'movement-engine/public/inbound';

import { affinityProvider } from '../providers/affinity';
import { builtinModuleInboundVerifier } from '../../translation_graph/adapters/builtin_modules';

/** The door's verifier for Affinity, with the signature in its first header. */
function verifyAsProvider(_provider: 'AFFINITY', rawBody: Buffer, signature: string, secret: string): boolean {
  const verifier = builtinModuleInboundVerifier('AFFINITY');
  if (verifier === undefined) throw new Error('Affinity is not on its module line');
  return verifyInbound(verifier, { rawBody, headers: signature === '' ? {} : { 'x-affinity-webhook-signature': signature }, secret });
}

let storedCredential: Record<string, unknown> = { apiKey: 'k' };

const KEY = 'affinity-signature-key';
const BODY = Buffer.from(JSON.stringify({ type: 'organization.created', body: { id: 1 } }));
const hexSig = () => crypto.createHmac('sha256', KEY).update(BODY).digest('hex');
const b64Sig = () => crypto.createHmac('sha256', KEY).update(BODY).digest('base64');

describe('Affinity signature verification', () => {
  it('refuses every delivery when no key is configured (empty or placeholder secret)', () => {
    expect(verifyAsProvider('AFFINITY', BODY, '', '')).toBe(false);
    expect(verifyAsProvider('AFFINITY', BODY, 'anything', '')).toBe(false);
    expect(verifyAsProvider('AFFINITY', BODY, hexSig(), 'pending')).toBe(false);
  });

  it('accepts a correct HMAC as hex, base64, or sha256=-prefixed', () => {
    expect(verifyAsProvider('AFFINITY', BODY, hexSig(), KEY)).toBe(true);
    expect(verifyAsProvider('AFFINITY', BODY, b64Sig(), KEY)).toBe(true);
    expect(verifyAsProvider('AFFINITY', BODY, `sha256=${hexSig()}`, KEY)).toBe(true);
  });

  it('rejects a wrong signature and an unsigned delivery once a key is set', () => {
    const tampered = crypto.createHmac('sha256', 'other-key').update(BODY).digest('hex');
    expect(verifyAsProvider('AFFINITY', BODY, tampered, KEY)).toBe(false);
    expect(verifyAsProvider('AFFINITY', BODY, 'not-a-signature', KEY)).toBe(false);
    expect(verifyAsProvider('AFFINITY', BODY, '', KEY)).toBe(false);
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

  it('registers with an empty secret without a key (its deliveries are then refused)', async () => {
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
