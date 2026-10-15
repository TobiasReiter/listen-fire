import { Context } from '.';

import * as db from '@prisma/client';
import { runWithPrincipal } from 'principal';

import { userPrincipal } from '../principal';
import { accessFor } from '../principal/core_teams';
import { AtLeastOne } from 'movement-engine/lib/utils/object';
import {
  unauthorisedGetUserById,
  unauthorisedGetUserByEmail,
} from '../../lib/middleware/authentication/identify_user';

type ContextOptions = {
  useTransaction?: boolean;
  requestId?: string;
  teamId?: string;
};

async function runInContext<T>(
  fn: (ctx: Context) => Promise<T>,
  userInfo: AtLeastOne<{ user?: db.User; id?: string; email?: string }>,
  options?: ContextOptions,
) {
  const ctx = new Context({ xRequestId: options?.requestId });
  return ctx.runAsync(async () => {
    let user: db.User;

    if (userInfo.user) {
      user = userInfo.user;
    } else if (userInfo.id) {
      user = await unauthorisedGetUserById(userInfo.id);
    } else if (userInfo.email) {
      user = await unauthorisedGetUserByEmail(userInfo.email);
    } else {
      throw new Error('Undefined user. Should never happen.');
    }

    const teamId = options?.teamId ? options.teamId : user.defaultTeamId;
    // The same membership derivation a request gets. Background work is not
    // exempt from a read-only membership — nor from having none (D44b): a
    // worker or script naming a team its user does not belong to is a bug in
    // the caller, and it says so instead of quietly acting there with write.
    const access = await accessFor({ userId: user.id, teamId });
    if (access === null) {
      throw new Error(
        `Cannot run as user ${user.id} in team ${teamId}: no team membership. ` +
          'Membership is the sole authority on which teams an identity may act in.',
      );
    }
    const principal = userPrincipal({ userId: user.id, teamId, access });
    ctx.bindPrincipal(principal);

    if (options && options.useTransaction) {
      await ctx.enterTransaction();
    }

    // Background work acts as somebody too: a worker, a CLI command or a script
    // running here gets the same ambient Principal a request would, so code that
    // reads identity from the contract rather than from the Context behaves
    // identically in both (core plan §3 — machine principals are the same type).
    return runWithPrincipal(principal, () => fn(ctx));
  });
}

async function runInContextUnauthorized<T>(
  fn: (ctx: Context) => Promise<T>,
  options?: { useTransaction?: boolean; requestId?: string; systemWritable?: boolean },
) {
  const ctx = new Context({ xRequestId: options?.requestId, systemWritable: options?.systemWritable });
  return ctx.runAsync(async () => {
    if (options && options.useTransaction) {
      await ctx.enterTransaction();
    }

    return fn(ctx);
  });
}

/**
 * Run a function under a Context with no acting user — for background jobs
 * (poll workers, inline calls off a metering/webhook chokepoint) that need
 * SOME ambient context so `currentContext()`-reading services don't throw,
 * but aren't acting on behalf of any particular user.
 *
 * Safe to nest: AsyncLocalStorage.run() just shadows the outer store for the
 * duration of `fn` and restores it after, so calling this from code that may
 * or may not already be inside a context (e.g. an inline call off a movement
 * run) is harmless either way.
 *
 * It WRITES — notice markers, magic-link tokens, the outbound-email ledger —
 * and it has no identity to derive that from, so `systemWritable` says so
 * outright: the pool is chosen from the Principal and there isn't one here.
 * (That flag exists because the writable pool used to arrive as a SIDE EFFECT
 * of the public ability carrying MANAGE rules, which deleting the layer would
 * have silently turned read-only.)
 */
async function runInSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = new Context({ systemWritable: true });
  return ctx.runAsync(fn);
}

export { runInContext, runInContextUnauthorized, runInSystemContext };
