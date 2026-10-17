// Signing secrets for the golden corpus. Test values only: made up for this
// corpus, never a real deployment's, so the recordings can hold the signatures
// computed from them.

import { createHmac } from 'node:crypto';

export const SECRETS = {
  attio: 'golden-attio-secret-0001',
  /** Airtable's MAC secret is base64 on the wire. */
  airtable: Buffer.from('golden-airtable-mac-secret-0001').toString('base64'),
  affinity: 'golden-affinity-secret-0001',
  affinityUnset: '',
  slackBring: 'golden-slack-byo-secret-0001',
  slackApp: 'golden-slack-app-signing-secret-0001',
  whatsappSub: 'golden-whatsapp-sub-secret-0001',
  whatsappApp: 'golden-whatsapp-app-secret-0001',
  valuations: 'golden-valuations-secret-0001',
  knowledge: 'golden-knowledge-secret-0001',
  remote: 'golden-remote-secret-0001',
  telegramBring: 'golden-telegram-byo-secret-0001',
  telegramShared: 'golden-telegram-shared-secret-0001',
  /** Resend / Svix: whsec_ prefix, base64 key. */
  resend: `whsec_${Buffer.from('golden-resend-svix-key-0001').toString('base64')}`,
  mailgunApiKey: 'golden-mailgun-api-key-0001',
  adapterDoor: 'golden-adapter-door-secret-0001',
} as const;

/** The fixed clock every golden case runs at (Svix checks timestamp drift). */
export const FIXED_NOW_MS = Date.UTC(2026, 9, 17, 12, 0, 0);
export const FIXED_NOW_SECONDS = String(FIXED_NOW_MS / 1000);

export function hmacHex(secret: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function hmacBase64(secret: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('base64');
}

/** Slack's v0 scheme: `v0=` + hmac(secret, `v0:{timestamp}:{body}`). */
export function slackSignature(input: { secret: string; timestamp: string; body: Buffer }): string {
  return `v0=${hmacHex(input.secret, `v0:${input.timestamp}:${input.body.toString('utf-8')}`)}`;
}
