import { currentContext } from '../../../services/context';
import { logger } from 'movement-engine/public/log';
import { getErrorMessage } from 'movement-engine/public/errors';

async function unauthorisedGetUserByEmail(email: string) {
  const ctx = currentContext();

  try {
    const userEmail = await ctx.prisma.userEmail.findUniqueOrThrow({
      where: { email, user: { grantedAccessAt: { not: null } } },
      select: { user: true },
    });
    return userEmail.user;
  } catch (err) {
    logger.error(getErrorMessage(err), { email });
    throw err;
  }
}

/**
 * Non-throwing existence check for a real, access-granted user by email — the
 * pre-auth counterpart to `unauthorisedGetUserByEmail`. Returns null (rather
 * than throwing) when no such user exists. It runs on routes that execute
 * before authentication (signup/login), so there is no acting team to scope the
 * lookup to — an email is the key. "Real user" mirrors the JWT-auth notion:
 * `grantedAccessAt` set — so a match is safe to treat as an idempotent login.
 */
async function unauthorisedFindUserByEmail(email: string) {
  const ctx = currentContext();
  const userEmail = await ctx.prisma.userEmail.findFirst({
    where: { email, user: { grantedAccessAt: { not: null } } },
    select: { user: true },
  });
  if (!userEmail) return null;
  return userEmail.user;
}

async function unauthorisedGetUserById(id: string) {
  const ctx = currentContext();

  return ctx.prisma.user.findUniqueOrThrow({
    where: { id, grantedAccessAt: { not: null } },
  });
}

async function unauthorisedGetUserByPhone(phoneNumber: string) {
  const ctx = currentContext();

  try {
    // The number is automations' channel identity and the user is core's, so
    // this is two reads rather than a relation traversal (D3/D28).
    const link = await ctx.prisma.phoneNumber.findFirstOrThrow({
      where: { phoneNumber, userId: { not: null } },
      select: { userId: true },
    });
    const user = await ctx.prisma.user.findFirstOrThrow({
      where: { id: link.userId as string, grantedAccessAt: { not: null } },
    });
    return user;
  } catch (err) {
    logger.error(getErrorMessage(err), { phoneNumber });
    throw err;
  }
}

async function unauthorisedGetDefaultUserByTeamId(teamId: string) {
  const ctx = currentContext();

  const team = await ctx.prisma.team.findUnique({
    where: { id: teamId },
    select: { defaultUserId: true },
  });

  if (!team?.defaultUserId) {
    throw new Error(`Team ${teamId} has no default user`);
  }

  return unauthorisedGetUserById(team.defaultUserId);
}

export {
  unauthorisedGetUserByEmail,
  unauthorisedFindUserByEmail,
  unauthorisedGetUserById,
  unauthorisedGetUserByPhone,
  unauthorisedGetDefaultUserByTeamId,
};
