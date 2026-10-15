// Orchestration for the WhatsApp phone-verification loop: fetch the active code,
// let the pure logic (logic.ts) decide, apply the outcome, send the code. The
// only way a phone earns `phone_number.verified_at` — which is what inbound
// routing now requires. Under `WHATSAPP_LINK_VERIFICATION=trust` the code step
// is skipped and the claim itself earns it (see link_verification.ts).

import type { UserId } from '../../../generated/kysely/core/User';
import type { PhoneVerificationId } from '../../../generated/kysely/automations/PhoneVerification';

import { getAutomationsQb } from '../../../lib/kysely';
import { logger } from 'movement-engine/services/logger';
import { sendVerificationCode } from '../metaApi';
import { maskPhoneNumber, whatsappLinkVerification } from './link_verification';
import {
  PHONE_VERIFICATION,
  evaluateStart,
  evaluateConfirm,
  generateVerificationCode,
  hashVerificationCode,
  type ActiveCode,
} from './logic';

/** `code_sent`: a code is on its way and the link is verified only once it
 *  comes back. `linked`: the link is verified already (the deployment trusts a
 *  signed-in user's claim) and there is no code to ask for. */
export type StartOutcome =
  | { ok: true; outcome: 'code_sent'; expiresAt: Date }
  | { ok: true; outcome: 'linked' }
  | { ok: false; reason: 'cooldown' | 'too_many_sends' | 'number_taken' };

export type ConfirmOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: 'no_active_code' | 'expired' | 'too_many_attempts' | 'invalid_code' | 'no_code_needed';
    };

/** Canonical stored form: `+` then digits only — the exact form the inbound
 *  router (resolveSenderTeam / findUserByPhoneNumber) resolves against, so a
 *  verified link actually matches an incoming message's sender. */
export function canonicalizePhone(input: string): string {
  return `+${input.replace(/\D/g, '')}`;
}

async function fetchActiveCode(userId: string, phone: string): Promise<ActiveCode | null> {
  const row = await getAutomationsQb(['phone_verification'])
    .selectFrom('phone_verification')
    .where('user_id', '=', userId as UserId)
    .where('phone_number', '=', phone)
    .where('consumed_at', 'is', null)
    .select(['id', 'code_hash', 'expires_at', 'attempts', 'send_count', 'last_sent_at'])
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    codeHash: row.code_hash,
    expiresAt: new Date(row.expires_at),
    attempts: row.attempts,
    sendCount: row.send_count,
    lastSentAt: new Date(row.last_sent_at),
  };
}

/** Whether this user has at least one verified WhatsApp number — the gate on
 *  any WhatsApp listener firing for them. A WhatsApp automation can save and go
 *  live but never fire until this is true. */
export async function userHasVerifiedWhatsappNumber(userId: string): Promise<boolean> {
  const row = await getAutomationsQb(['phone_number'])
    .selectFrom('phone_number')
    .where('user_id', '=', userId as UserId)
    .where('verified_at', 'is not', null)
    .select(['user_id'])
    .executeTakeFirst();
  return !!row;
}

export async function startPhoneVerification(input: {
  userId: string;
  phoneNumber: string;
}): Promise<StartOutcome> {
  const { userId } = input;
  const phone = canonicalizePhone(input.phoneNumber);

  // Collision: a number already verified to a DIFFERENT account can't be taken.
  const owner = await getAutomationsQb(['phone_number'])
    .selectFrom('phone_number')
    .where('phone_number', '=', phone)
    .where('verified_at', 'is not', null)
    .select(['user_id'])
    .executeTakeFirst();
  if (owner?.user_id && owner.user_id !== userId) return { ok: false, reason: 'number_taken' };

  const now = new Date();
  if (whatsappLinkVerification() === 'trust') {
    await linkVerifiedPhone({ userId, phone, at: now });
    logger.info('[whatsapp/link] number linked without a code (WHATSAPP_LINK_VERIFICATION=trust)', {
      userId,
      phoneNumber: maskPhoneNumber(phone),
    });
    return { ok: true, outcome: 'linked' };
  }

  const existing = await fetchActiveCode(userId, phone);
  const decision = evaluateStart({ existing, now });
  if (decision.kind === 'reject') return { ok: false, reason: decision.reason };

  const code = generateVerificationCode();
  const codeHash = hashVerificationCode(code);
  const expiresAt = new Date(now.getTime() + PHONE_VERIFICATION.ttlMs);

  if (decision.mode === 'insert') {
    await getAutomationsQb(['phone_verification'])
      .insertInto('phone_verification')
      .values({
        user_id: userId as UserId,
        phone_number: phone,
        code_hash: codeHash,
        expires_at: expiresAt,
        attempts: 0,
        send_count: decision.sendCount,
        last_sent_at: now,
      })
      .execute();
  } else {
    await getAutomationsQb(['phone_verification'])
      .updateTable('phone_verification')
      .set({
        code_hash: codeHash,
        expires_at: expiresAt,
        attempts: 0,
        send_count: decision.sendCount,
        last_sent_at: now,
        updated_at: now,
      })
      .where('id', '=', existing!.id as PhoneVerificationId)
      .execute();
  }

  await sendVerificationCode({ to: phone, code });
  return { ok: true, outcome: 'code_sent', expiresAt };
}

export async function confirmPhoneVerification(input: {
  userId: string;
  phoneNumber: string;
  code: string;
}): Promise<ConfirmOutcome> {
  // Under trust no code is ever issued, so there is nothing to check a code
  // against — say so rather than answer `no_active_code`, which reads as
  // "request one first".
  if (whatsappLinkVerification() === 'trust') return { ok: false, reason: 'no_code_needed' };

  const { userId } = input;
  const phone = canonicalizePhone(input.phoneNumber);
  const existing = await fetchActiveCode(userId, phone);
  const now = new Date();
  const decision = evaluateConfirm({ existing, now, code: input.code.trim() });

  if (decision.kind === 'reject') {
    if (decision.incrementAttempts && existing) {
      await getAutomationsQb(['phone_verification'])
        .updateTable('phone_verification')
        .set({ attempts: existing.attempts + 1, updated_at: now })
        .where('id', '=', existing.id as PhoneVerificationId)
        .execute();
    }
    return { ok: false, reason: decision.reason };
  }

  // Accept: burn the code, then stamp the verified link routing depends on.
  await getAutomationsQb(['phone_verification'])
    .updateTable('phone_verification')
    .set({ consumed_at: now, updated_at: now })
    .where('id', '=', existing!.id as PhoneVerificationId)
    .execute();

  await linkVerifiedPhone({ userId, phone, at: now });
  return { ok: true };
}

/** Upsert the phone→user link and stamp it verified. Keyed on the (unique)
 *  phone_number, so an existing (possibly unverified) row is claimed rather than
 *  duplicated. */
async function linkVerifiedPhone(input: { userId: string; phone: string; at: Date }): Promise<void> {
  await getAutomationsQb(['phone_number'])
    .insertInto('phone_number')
    .values({ phone_number: input.phone, user_id: input.userId as UserId, verified_at: input.at })
    .onConflict((oc) =>
      oc.column('phone_number').doUpdateSet({
        user_id: input.userId as UserId,
        verified_at: input.at,
        updated_at: input.at,
      }),
    )
    .execute();
}
