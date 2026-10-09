// The account tRPC surface the settings UI uses to manage the user's password.
// Passwords are stored only as scrypt hashes (see `services/auth/password.ts`);
// the hash is never read back to the client — these procedures expose only
// whether a password is set, plus set/change/remove mutations.

import { z } from 'zod';

import type { UserId } from '../../../generated/kysely/core/User';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { getCoreQb } from '../../../lib/kysely';
import {
  hashPassword,
  verifyPassword,
  isPasswordAcceptable,
} from '../../../services/auth/password';

/** The stored `scrypt$...` string for the acting user, or null if social-only. */
async function currentPasswordHash(userId: UserId): Promise<string | null> {
  const row = await getCoreQb(['user'])
    .selectFrom('user')
    .select(['password_hash'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.password_hash ?? null;
}

const accountRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /** Whether the user has a password set — drives set vs change/remove UI. */
    getPasswordStatus: userProcedure.query(async () => {
      const userId = currentContext().user.id as UserId;
      const hash = await currentPasswordHash(userId);
      return { hasPassword: hash !== null };
    }),

    /** Set a first password. Only valid when the user has none yet — changing an
     *  existing password goes through `changePassword` (which re-verifies). */
    setPassword: userProcedure
      .input(z.object({ password: z.string() }))
      .mutation(async ({ input }) => {
        const userId = currentContext().user.id as UserId;
        if ((await currentPasswordHash(userId)) !== null) {
          throw new Error('You already have a password — use change instead.');
        }
        const policy = isPasswordAcceptable(input.password);
        if (!policy.ok) throw new Error(policy.reason);

        const passwordHash = await hashPassword(input.password);
        await getCoreQb(['user'])
          .updateTable('user')
          .set({ password_hash: passwordHash, password_updated_at: new Date() })
          .where('id', '=', userId)
          .execute();
        return { success: true };
      }),

    /** Change an existing password — re-verify the current one first, then store
     *  the new (policy-checked) hash. Requires a password already set. */
    changePassword: userProcedure
      .input(z.object({ currentPassword: z.string(), newPassword: z.string() }))
      .mutation(async ({ input }) => {
        const userId = currentContext().user.id as UserId;
        const existing = await currentPasswordHash(userId);
        if (existing === null) {
          throw new Error('You do not have a password yet — set one instead.');
        }
        if (!(await verifyPassword(input.currentPassword, existing))) {
          throw new Error('Current password is incorrect.');
        }
        const policy = isPasswordAcceptable(input.newPassword);
        if (!policy.ok) throw new Error(policy.reason);

        const passwordHash = await hashPassword(input.newPassword);
        await getCoreQb(['user'])
          .updateTable('user')
          .set({ password_hash: passwordHash, password_updated_at: new Date() })
          .where('id', '=', userId)
          .execute();
        return { success: true };
      }),

    /** Remove the password — the user keeps social / magic-link sign-in. */
    removePassword: userProcedure.mutation(async () => {
      const userId = currentContext().user.id as UserId;
      await getCoreQb(['user'])
        .updateTable('user')
        .set({ password_hash: null, password_updated_at: new Date() })
        .where('id', '=', userId)
        .execute();
      return { success: true };
    }),
  });
};

export { accountRouter };
