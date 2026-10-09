// Password signup — email-verified, so no account exists until the emailed token
// is confirmed (no unverified-email accounts, no squatting).
//
//   startPasswordSignup   — policy-check, invite check, de-dupe, then stash a
//     `pending_signup` (holding the ALREADY-hashed password) and email a confirm
//     link. The raw token lives only in that email; we store its sha256 hash.
//   confirmPasswordSignup — the token comes back, we look it up by hash, check
//     expiry, and sign the (now verified) address in through the same door every
//     other path uses, then burn the pending row (single-use).
//
// Only an invited address can start one: there is no self-serve team creation
// on this branch, so a stranger's signup is refused before an email is sent.

import { createHash, randomBytes } from 'node:crypto';

import { sql } from 'kysely';

import { getCoreQb } from '../../lib/kysely';
import { recordSignupEvent, type SignupAttribution } from '../signup/attribution';
import { getEnvVar } from '../../lib/utils/environment';
import { signupConfirmEmail } from '../../email/signupConfirmEmail';
import { TeamInviteService } from '../team_invite';
import { unauthorisedFindUserByEmail } from '../../lib/middleware/authentication/identify_user';
import { hashPassword, isPasswordAcceptable } from './password';

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Discriminated on `status` so the REST caller can map each outcome to its HTTP
 *  shape: weak → 400, not_invited → 403, exists / check_email → 200. */
export type StartPasswordSignupResult =
  | { status: 'weak_password'; reason: string }
  | { status: 'not_invited' }
  | { status: 'exists' }
  | { status: 'check_email' };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function confirmLinkFor(token: string): string {
  const webBaseUrl = getEnvVar('WEB_BASE_URL', { devDefault: 'http://localhost:3003' }).replace(
    /\/$/,
    '',
  );
  return `${webBaseUrl}/signup/confirm?token=${token}`;
}

/**
 * Begin a password signup: reject a weak password or an uninvited email,
 * short-circuit if the account already exists, else stash a `pending_signup`
 * and email a single-use confirm link. Never creates an account (that's
 * `confirm`).
 */
async function startPasswordSignup({
  email,
  password,
  name,
  source,
  attribution,
}: {
  email: string;
  password: string;
  /** Human display name from the signup form; carried on the pending row to
   *  `user.name` at confirm. */
  name?: string | null;
  source?: string;
  attribution?: SignupAttribution;
}): Promise<StartPasswordSignupResult> {
  const policy = isPasswordAcceptable(password);
  if (!policy.ok) return { status: 'weak_password', reason: policy.reason };

  const lower = email.toLowerCase();

  // Already have an account → route to login (the frontend routes 'exists' to
  // sign-in; no leak of whether a password is set).
  // Unauthorised lookup — this runs pre-auth, where the CASL dataloader
  // (UserService.findByEmail) would return null for a real account.
  const existing = await unauthorisedFindUserByEmail(lower);
  if (existing) return { status: 'exists' };

  // No account and nobody has written this address down — there is no door.
  const invited = await TeamInviteService.pendingInvitesFor(lower);
  if (invited.length === 0) return { status: 'not_invited' };

  const passwordHash = await hashPassword(password);
  const token = randomBytes(32).toString('hex');
  const tokenHash = sha256(token);

  // One pending signup per email — replace any prior (e.g. a resend).
  await getCoreQb(['pending_signup']).deleteFrom('pending_signup').where('email', '=', lower).execute();

  await getCoreQb(['pending_signup'])
    .insertInto('pending_signup')
    .values({
      email: lower,
      password_hash: passwordHash,
      terms_accepted: true,
      token_hash: tokenHash,
      source: source ?? null,
      attribution: attribution
        ? (sql`${JSON.stringify(attribution)}::jsonb` as unknown as null)
        : null,
      name: name?.trim() || null,
      expires_at: new Date(Date.now() + TOKEN_TTL_MS),
    })
    .execute();

  await signupConfirmEmail({
    recipientEmail: lower,
    confirmLink: confirmLinkFor(token),
    expiryMinutes: Math.round(TOKEN_TTL_MS / 60_000),
  });

  return { status: 'check_email' };
}

/**
 * Complete a password signup: look the pending row up by token hash, reject if
 * missing or expired, else sign the (now verified) address in through the shared
 * invite door, set the stashed password on it, and burn the pending row. Returns
 * the account identity, or `null` for an invalid/expired token — which is also
 * what an invite withdrawn between start and confirm gets.
 */
async function confirmPasswordSignup({
  token,
}: {
  token: string;
}): Promise<{ email: string; teamId: string; userId: string } | null> {
  const tokenHash = sha256(token);

  const pending = await getCoreQb(['pending_signup'])
    .selectFrom('pending_signup')
    .select(['email', 'password_hash', 'attribution', 'name'])
    .where('token_hash', '=', tokenHash)
    .where('expires_at', '>', new Date())
    .executeTakeFirst();
  if (!pending) return null;

  const resolution = await TeamInviteService.resolveSignInForVerifiedEmail({
    email: pending.email,
    name: pending.name,
  });
  if (resolution.status === 'not_invited') return null;
  const { userId, teamId } = resolution;

  await getCoreQb(['user'])
    .updateTable('user')
    .set({ password_hash: pending.password_hash, password_updated_at: new Date() })
    .where('id', '=', userId)
    .execute();

  await recordSignupEvent({
    email: pending.email,
    teamId,
    channel: 'password',
    attribution: (pending.attribution as SignupAttribution | null) ?? undefined,
  });

  await getCoreQb(['pending_signup'])
    .deleteFrom('pending_signup')
    .where('token_hash', '=', tokenHash)
    .execute();

  return { email: pending.email, teamId, userId };
}

export { startPasswordSignup, confirmPasswordSignup };
