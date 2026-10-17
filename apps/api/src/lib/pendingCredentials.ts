import { randomBytes } from 'node:crypto';

import { encryptToken, decryptToken } from './credentials';
import { logger } from 'movement-engine/public/log';

const TTL_MS = 15 * 60 * 1000;

const store = new Map<string, { encrypted: Buffer; userId: string; expiresAt: number }>();

async function storePendingCredentials(credentials: unknown, userId: string): Promise<string> {
  const claimToken = randomBytes(32).toString('base64url');
  const encrypted = await encryptToken(JSON.stringify(credentials), claimToken);

  store.set(claimToken, { encrypted, userId, expiresAt: Date.now() + TTL_MS });
  setTimeout(() => store.delete(claimToken), TTL_MS);

  return claimToken;
}

async function claimPendingCredentials(claimToken: string, userId: string): Promise<unknown> {
  const entry = store.get(claimToken);
  if (!entry || entry.expiresAt < Date.now()) {
    store.delete(claimToken);
    throw new Error('Invalid or expired claim token');
  }

  if (entry.userId !== userId) {
    logger.error('[PENDING_CREDS] userId mismatch', { stored: entry.userId, claiming: userId });
    throw new Error('Claim token does not belong to this user');
  }

  store.delete(claimToken);
  const decrypted = await decryptToken(entry.encrypted, claimToken);
  return JSON.parse(decrypted);
}

export { storePendingCredentials, claimPendingCredentials };
