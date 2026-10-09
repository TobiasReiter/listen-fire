// Core's first-boot provisioning: the three rows a fresh install needs, as a
// startup step rather than folklore.
//
// A `core` deployment pointed at a freshly-migrated database has no team, no
// user, and — the one nobody documents — no `PUBLIC_USER_ID` user row. Without
// that last one every `/api/public/*` route answers "Invalid or expired
// session", which is indistinguishable from a stale cookie and is exactly what
// an unprovisioned install looks like from outside. This module turns the
// undocumented row set into a step that runs itself, says what it did, and
// never touches an install that already has people in it.

import type { TeamId } from '../generated/kysely/core/Team';
import type { UserId } from '../generated/kysely/core/User';
import type { WorkerRegistry } from './registry';

import { getCoreQb } from '../lib/kysely';
import { runInBackground } from '../lib/utils/background';
import { ProvisioningService } from '../services/provisioning';

/**
 * The public identity's own team. Pinned rather than minted so the row set is
 * recognisable and so re-running it (the dev seed does, on every seed) is
 * idempotent by id. It holds nothing: the public identity's single membership
 * is here, which is what keeps an unauthenticated request from resolving into
 * anybody's real team.
 */
const PUBLIC_TEAM_ID = '3c556453-82b3-4314-ab78-67d843aaa7da' as TeamId;
const PUBLIC_TEAM_NAME = 'Public';
const PUBLIC_USER_USERNAME = 'Public Listen-Fire';

/** The team name and first account come from the environment (D51(d)); the
 *  public identity's id is the one the auth path already reads. */
const TEAM_NAME_VAR = 'LISTEN_FIRE_BOOTSTRAP_TEAM_NAME';
const USER_EMAIL_VAR = 'LISTEN_FIRE_BOOTSTRAP_USER_EMAIL';
const PUBLIC_USER_VAR = 'PUBLIC_USER_ID';

/**
 * The installation's own team, decided once by the installer and read by every
 * unit — the static-identity principal resolves requests to it, and the demo
 * seed writes its sample data into it. Core mints its own team instead, which
 * on a `core` deployment produced a SECOND team: the operator signed in to an
 * empty one while the sample data sat in the pinned one. So when the installer
 * has named a team, core provisions THAT team rather than one of its own.
 *
 * Optional, because an install that names no team id is the older shape and
 * must keep working: the id is then minted as before.
 */
const TEAM_ID_VAR = 'LISTEN_FIRE_TEAM_ID';
const TEAM_NAME_PINNED_VAR = 'LISTEN_FIRE_TEAM_NAME';

type Env = Record<string, string | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What this database already contains, with the public identity subtracted.
 * The public rows are machinery, not an install's people: a database holding
 * only those is still unprovisioned, and subtracting them is what makes the
 * step resumable — a crash between the two halves leaves a state the next boot
 * still recognises as empty.
 */
interface InstallState {
  /** Teams other than the public identity's own and the installation's pinned one. */
  teams: number;
  /** Users other than the `PUBLIC_USER_ID` identity. */
  users: number;
  /** Does the `PUBLIC_USER_ID` row exist? */
  publicIdentity: boolean;
}

type BootstrapPlan =
  | {
      action: 'provision';
      teamName: string;
      /** Absent when the installation names no team id — mint one, as before. */
      teamId?: string;
      email: string;
      publicUserId: string;
    }
  | { action: 'skip'; state: InstallState }
  | { action: 'unconfigured'; missing: string[] };

function trimmed(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * A configured id, but only if it can be a query VALUE. Both ids below are
 * compared against uuid columns, and Postgres refuses a malformed one with a
 * syntax error — which would kill this step inside the count, before it could
 * reach its own verdict about the variable. Dropping it here means the plan
 * decides, and `unconfigured` names the variable the way it says it does.
 */
function usableUuid(env: Env, name: string): string | undefined {
  const value = trimmed(env, name);
  return value !== undefined && UUID.test(value) ? value : undefined;
}

/**
 * Decide, from the install's state and the environment, which of the three
 * things this boot does. Pure — the database read and the logging live in
 * `bootstrapCoreInstall`, so the predicate itself is testable without one.
 *
 * Emptiness is checked BEFORE the environment on purpose: a running install
 * must never nag about bootstrap variables it will never use again.
 */
function planBootstrap(state: InstallState, env: Env): BootstrapPlan {
  if (state.teams > 0 || state.users > 0) return { action: 'skip', state };

  // The installer's name for the team wins over the bootstrap-only variable:
  // they are the same decision, and the one every other unit reads is the one
  // the operator will recognise.
  const teamName = trimmed(env, TEAM_NAME_PINNED_VAR) ?? trimmed(env, TEAM_NAME_VAR);
  const teamId = trimmed(env, TEAM_ID_VAR);
  const email = trimmed(env, USER_EMAIL_VAR);
  const publicUserId = trimmed(env, PUBLIC_USER_VAR);

  // All or nothing. Provisioning half a row set would leave a database that is
  // no longer empty and therefore never finishes — so an under-configured
  // install stays untouched and stays bootstrappable.
  if (teamName === undefined || email === undefined || publicUserId === undefined) {
    return {
      action: 'unconfigured',
      missing: [
        teamName === undefined ? TEAM_NAME_VAR : null,
        email === undefined ? USER_EMAIL_VAR : null,
        publicUserId === undefined ? PUBLIC_USER_VAR : null,
      ].filter((name): name is string => name !== null),
    };
  }

  // A value that is not a uuid cannot be the identity the auth path reads —
  // failing here names the variable, where the insert would name a column.
  if (!UUID.test(publicUserId)) return { action: 'unconfigured', missing: [PUBLIC_USER_VAR] };

  // Same rule for the pinned team: a malformed id would surface as a column
  // error from the insert, long after the variable that caused it is out of
  // sight.
  if (teamId !== undefined && !UUID.test(teamId)) {
    return { action: 'unconfigured', missing: [TEAM_ID_VAR] };
  }

  return { action: 'provision', teamName, teamId, email, publicUserId };
}

async function readInstallState(
  publicUserId: string | undefined,
  pinnedTeamId: string | undefined,
): Promise<InstallState> {
  // The pinned team is subtracted for the same reason the public one is: it is
  // this installation's own machinery, and it may already be there because
  // something else that reads the same id (the demo seed) got there first.
  // Idempotency does not rest on it — the admin USER this step creates is what
  // makes every later boot skip.
  const teams = await getCoreQb(['team'])
    .selectFrom('team')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('id', '!=', PUBLIC_TEAM_ID)
    .$if(pinnedTeamId !== undefined, (query) => query.where('id', '!=', pinnedTeamId as TeamId))
    .executeTakeFirstOrThrow();

  const users = await getCoreQb(['user'])
    .selectFrom('user')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .$if(publicUserId !== undefined, (query) => query.where('id', '!=', publicUserId as UserId))
    .executeTakeFirstOrThrow();

  const publicIdentity =
    publicUserId === undefined
      ? false
      : (await getCoreQb(['user'])
          .selectFrom('user')
          .select('id')
          .where('id', '=', publicUserId as UserId)
          .executeTakeFirst()) !== undefined;

  return { teams: Number(teams.count), users: Number(users.count), publicIdentity };
}

/**
 * Idempotently ensure the `PUBLIC_USER_ID` row exists, on its own team, with
 * `granted_access_at` set. Keyed by id, so it is safe to call on any database —
 * which is what lets the dev seed share it instead of keeping a copy.
 *
 * No `user_email`: the public identity is resolved by id (`isPublicUrl` →
 * `unauthorisedGetUserById`), never by email, and giving it one would put a
 * loginable address on a shared machine identity.
 */
async function ensurePublicIdentity(publicUserId: string): Promise<void> {
  const existing = await getCoreQb(['user'])
    .selectFrom('user')
    .select(['id', 'granted_access_at'])
    .where('id', '=', publicUserId as UserId)
    .executeTakeFirst();

  if (existing) {
    // The row is there but the gate is not — `unauthorisedGetUserById` filters
    // on it, so this is the same 401 as having no row at all.
    if (!existing.granted_access_at) {
      await getCoreQb(['user'])
        .updateTable('user')
        .set({ granted_access_at: new Date() })
        .where('id', '=', existing.id)
        .execute();
    }
    return;
  }

  const team = await getCoreQb(['team'])
    .selectFrom('team')
    .select('id')
    .where('id', '=', PUBLIC_TEAM_ID)
    .executeTakeFirst();
  if (!team) {
    await getCoreQb(['team'])
      .insertInto('team')
      .values({ id: PUBLIC_TEAM_ID, name: PUBLIC_TEAM_NAME })
      .execute();
  }

  await getCoreQb(['user'])
    .insertInto('user')
    .values({
      id: publicUserId as UserId,
      default_team_id: PUBLIC_TEAM_ID,
      username: PUBLIC_USER_USERNAME,
      granted_access_at: new Date(),
      is_platform_admin: false,
    })
    .execute();

  // Membership is the sole authority on where an identity may act (C-6): one
  // row, on the team that holds nothing.
  const membership = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select('id')
    .where('user_id', '=', publicUserId as UserId)
    .where('team_id', '=', PUBLIC_TEAM_ID)
    .executeTakeFirst();
  if (!membership) {
    await getCoreQb(['team_membership'])
      .insertInto('team_membership')
      .values({
        user_id: publicUserId as UserId,
        team_id: PUBLIC_TEAM_ID,
        access: 'write',
        is_personal: false,
      })
      .execute();
  }
}

/**
 * Provision a first-boot `core` install, or say why it didn't. Loud either
 * way: a self-hoster reading the boot log must be able to tell which happened.
 *
 * The public identity goes first and the operator's account second, so a crash
 * between them leaves a database the next boot still reads as empty (the
 * emptiness predicate ignores the public rows) and finishes the job.
 */
async function bootstrapCoreInstall(env: Env = process.env): Promise<void> {
  const state = await readInstallState(
    usableUuid(env, PUBLIC_USER_VAR),
    usableUuid(env, TEAM_ID_VAR),
  );
  const plan = planBootstrap(state, env);

  if (plan.action === 'skip') {
    console.warn(
      `[startup] core: install already provisioned (${plan.state.teams} team(s), ` +
        `${plan.state.users} user(s)) — first-boot bootstrap skipped.`,
    );
    if (!plan.state.publicIdentity) {
      // Not healed on purpose: this step provisions empty databases and does
      // not reach into a live one. But it is the folklore failure, so it is
      // named rather than left to look like expired sessions.
      console.error(
        `[startup] core: this install has NO ${PUBLIC_USER_VAR} user row — every ` +
          `/api/public/* route (signup, login, join) will answer "Invalid or expired ` +
          `session" until one exists. See SELF_HOSTING.md, "first boot".`,
      );
    }
    return;
  }

  if (plan.action === 'unconfigured') {
    console.error(
      `[startup] core: this database is EMPTY and ${plan.missing.join(', ')} ` +
        `${plan.missing.length === 1 ? 'is' : 'are'} unset — nothing was provisioned. ` +
        `The install has no team, no account that can log in, and no public identity ` +
        `(so /api/public/* answers "Invalid or expired session"). Set ${TEAM_NAME_VAR} ` +
        `(or ${TEAM_NAME_PINNED_VAR}), ${USER_EMAIL_VAR} and ${PUBLIC_USER_VAR} (a UUID), ` +
        `then restart.`,
    );
    return;
  }

  await ensurePublicIdentity(plan.publicUserId);
  const { teamId, userId } = await ProvisioningService.provisionTeamWithAdmin({
    email: plan.email,
    teamName: plan.teamName,
    teamId: plan.teamId === undefined ? undefined : (plan.teamId as TeamId),
  });

  console.warn(
    `[startup] core: first boot on an empty database — provisioned team ` +
      `"${plan.teamName}" (${teamId}), admin ${plan.email.toLowerCase()} (${userId}), ` +
      `and the ${PUBLIC_USER_VAR} identity (${plan.publicUserId}).`,
  );
}

/**
 * Core's startup unit. It has no loops — first-boot provisioning is wiring,
 * not a worker — but it takes core's background lock all the same, so that a
 * deployment of several instances provisions exactly once instead of racing
 * two identical empty databases into two teams.
 */
const coreStartup: WorkerRegistry = {
  unit: 'core',
  workers: [],
  wire() {
    runInBackground(() => bootstrapCoreInstall());
  },
};

export {
  PUBLIC_TEAM_ID,
  TEAM_ID_VAR,
  TEAM_NAME_PINNED_VAR,
  TEAM_NAME_VAR,
  USER_EMAIL_VAR,
  PUBLIC_USER_VAR,
  type InstallState,
  type BootstrapPlan,
  planBootstrap,
  ensurePublicIdentity,
  bootstrapCoreInstall,
  coreStartup,
};
