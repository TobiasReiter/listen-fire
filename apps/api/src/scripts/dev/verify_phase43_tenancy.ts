/**
 * Phase 4.3 verification: membership is the only thing that grants access, and
 * a second team can see none of the first team's rows.
 *
 * This is the two-team e2e Phase 4.2 owed. Everything runs against a live
 * dev-loop stack on `listenfire_dev` with a REAL second team, because the claims
 * are about what a credential is refused — and a refusal is only proven by a
 * request that gets one.
 *
 *   DEV_LOOP_PROFILE=<profile> npx ts-node ... src/scripts/dev/verify_phase43_tenancy.ts
 */
import './_profile_loader';

import { randomUUID } from 'node:crypto';

import { DEV_LOOP_EMAIL } from './_lib';
import { getCoreQb, getValuationsQb } from '../../lib/kysely';
import { generateJWT } from '../../lib/middleware/authentication/token';
import { runInContext } from '../../services/context/utils';
import LegalEntityType from '../../generated/kysely/valuations/LegalEntityType';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

const API = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

interface CheckResult {
  id: string;
  name: string;
  pass: boolean;
  evidence: unknown;
}

const results: CheckResult[] = [];

function record(id: string, name: string, pass: boolean, evidence: unknown) {
  results.push({ id, name, pass, evidence });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}`);
  console.log(`       ${JSON.stringify(evidence)}`);
}

async function wire(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: string; json: unknown }> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.text();
  let json: unknown;
  try {
    json = body === '' ? undefined : JSON.parse(body);
  } catch {
    json = undefined;
  }
  return { status: res.status, body, json };
}

/** A tRPC mutation over HTTP, in the shape the web client sends. */
async function trpcMutation(procedure: string, input: unknown, headers: Record<string, string>) {
  return wire(`/api/trpc/${procedure}`, { method: 'POST', headers, body: input });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

interface Fixture {
  teamId: TeamId;
  userId: UserId;
  entityId: string;
  eventId: string;
}

const tag = randomUUID().slice(0, 8);

/** The second tenant: its own team, user, membership, company and event. */
async function makeTeamB(): Promise<Fixture> {
  const teamId = randomUUID() as TeamId;
  const userId = randomUUID() as UserId;
  const entityId = randomUUID();
  const eventId = randomUUID();

  await getCoreQb(['team'])
    .insertInto('team')
    .values(anyVals({ id: teamId, name: `carve43-b-${tag}` }))
    .execute();
  await getCoreQb(['user'])
    .insertInto('user')
    .values(
      anyVals({
        id: userId,
        default_team_id: teamId,
        username: `carve43-b-${tag}`,
        granted_access_at: new Date(),
        completed_registration_at: new Date(),
      }),
    )
    .execute();
  await getCoreQb(['team_membership'])
    .insertInto('team_membership')
    .values(anyVals({ id: randomUUID(), user_id: userId, team_id: teamId, access: 'write' }))
    .execute();
  await getCoreQb(['user_email'])
    .insertInto('user_email')
    .values(
      anyVals({
        id: randomUUID(),
        user_id: userId,
        email: `carve43-b-${tag}@listen-fire.local`,
        is_primary: true,
      }),
    )
    .execute();
  await getValuationsQb(['legal_entity'])
    .insertInto('legal_entity')
    .values(
      anyVals({
        id: entityId,
        team_id: teamId,
        name: `TeamB Co ${tag}`,
        type: LegalEntityType.COMPANY,
      }),
    )
    .execute();
  await getValuationsQb(['event'])
    .insertInto('event')
    .values(
      anyVals({
        id: eventId,
        team_id: teamId,
        legal_entity_id: entityId,
        date: new Date('2026-01-01'),
        name: `TeamB Round ${tag}`,
        type: 'INVESTMENT_ROUND',
      }),
    )
    .execute();

  return { teamId, userId, entityId, eventId };
}

async function dropTeamB(b: Fixture): Promise<void> {
  await getValuationsQb(['investment'])
    .deleteFrom('investment')
    .where('team_id', '=', b.teamId)
    .execute();
  await getValuationsQb(['event']).deleteFrom('event').where('team_id', '=', b.teamId).execute();
  await getValuationsQb(['legal_entity'])
    .deleteFrom('legal_entity')
    .where('team_id', '=', b.teamId)
    .execute();
  await getCoreQb(['user_email']).deleteFrom('user_email').where('user_id', '=', b.userId).execute();
  await getCoreQb(['team_membership'])
    .deleteFrom('team_membership')
    .where('user_id', '=', b.userId)
    .execute();
  await getCoreQb(['user']).deleteFrom('user').where('id', '=', b.userId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', b.teamId).execute();
}

async function main() {
  const identity = await getCoreQb(['user_email'])
    .selectFrom('user_email')
    .select(['user_id'])
    .where('email', '=', DEV_LOOP_EMAIL)
    .executeTakeFirstOrThrow();
  const userA = identity.user_id;
  const home = await getCoreQb(['user'])
    .selectFrom('user')
    .select(['default_team_id'])
    .where('id', '=', userA)
    .executeTakeFirstOrThrow();
  const teamA = home.default_team_id as unknown as TeamId;

  const b = await makeTeamB();
  const cookieA = { Cookie: `listen_fire_token=${generateJWT(DEV_LOOP_EMAIL)}` };
  const cookieB = { Cookie: `listen_fire_token=${generateJWT(`carve43-b-${tag}@listen-fire.local`)}` };

  console.log(`team A ${teamA} / user A ${userA}`);
  console.log(`team B ${b.teamId} / user B ${b.userId}`);

  try {
    // ------------------------------------------------- 1. both tenants log in
    {
      const ra = await wire('/api/v1/me', { headers: cookieA });
      const rb = await wire('/api/v1/me', { headers: cookieB });
      record(
        '1',
        'both teams authenticate on their own credential',
        ra.status === 200 && rb.status === 200,
        { a: ra.status, b: rb.status },
      );
    }

    // ------------------------------------------ 2. the membership lockout
    // The headline of D44b: `default_team_id` still names team A, and that
    // used to be enough. Membership is the only authority now.
    {
      const before = await wire('/api/v1/me', { headers: cookieA });

      const removed = await getCoreQb(['team_membership'])
        .deleteFrom('team_membership')
        .where('user_id', '=', userA)
        .where('team_id', '=', teamA)
        .returningAll()
        .execute();

      const stillHome = await getCoreQb(['user'])
        .selectFrom('user')
        .select(['default_team_id'])
        .where('id', '=', userA)
        .executeTakeFirstOrThrow();

      const during = await wire('/api/v1/me', { headers: cookieA });

      // Background work takes the same answer, which is where the old
      // `accessFor` handed out `write` because nothing else was looking.
      let backgroundRefusal = '';
      try {
        await runInContext(async () => undefined, { id: userA });
        backgroundRefusal = '(no refusal — background work still ran)';
      } catch (e) {
        backgroundRefusal = (e as Error).message;
      }

      for (const row of removed) {
        await getCoreQb(['team_membership']).insertInto('team_membership').values(anyVals(row)).execute();
      }
      const after = await wire('/api/v1/me', { headers: cookieA });

      record(
        '2',
        'removing a membership kills access even though default_team_id still points there',
        before.status === 200 &&
          during.status === 403 &&
          after.status === 200 &&
          (stillHome.default_team_id as unknown as string) === teamA &&
          backgroundRefusal.includes('no team membership'),
        {
          before: before.status,
          duringRequest: during.status,
          duringBackground: backgroundRefusal,
          defaultTeamIdThroughout: stillHome.default_team_id,
          afterRestore: after.status,
        },
      );
    }

    // -------------------------------- 3. background work refuses a foreign team
    {
      let message = '(no refusal)';
      try {
        await runInContext(async () => undefined, { id: userA }, { teamId: b.teamId });
      } catch (e) {
        message = (e as Error).message;
      }
      record(
        '3',
        'runInContext refuses to act as a user in a team they are not a member of',
        message.includes('no team membership'),
        { message },
      );
    }

    // --------------------------- 4. a read-only membership gets a readonly pool
    // The pool used to be chosen from the ability; it is chosen from
    // `principal.access` now, and this is the wire proof that a read-only
    // member cannot write even where the procedure itself has no gate.
    {
      await getCoreQb(['team_membership'])
        .updateTable('team_membership')
        .set({ access: 'read' })
        .where('user_id', '=', userA)
        .where('team_id', '=', teamA)
        .execute();

      const readonlyWrite = await trpcMutation(
        'views.userSettings.updateUsername',
        { username: `readonly-probe-${tag}` },
        cookieA,
      );

      await getCoreQb(['team_membership'])
        .updateTable('team_membership')
        .set({ access: 'write' })
        .where('user_id', '=', userA)
        .where('team_id', '=', teamA)
        .execute();

      const writeAgain = await trpcMutation(
        'views.userSettings.updateUsername',
        { username: 'dev-loop' },
        cookieA,
      );

      record(
        '4',
        'a read-only membership cannot write, and write access restores it',
        readonlyWrite.status >= 400 &&
          // Postgres 42501 from the readonly role IS the proof: the pool was
          // chosen from `access`, not from a rule set.
          /permission denied|42501/i.test(readonlyWrite.body) &&
          writeAgain.status === 200,
        {
          readonly: readonlyWrite.status,
          readonlyReason: /permission denied[^"\\]*/i.exec(readonlyWrite.body)?.[0] ?? readonlyWrite.body.slice(0, 200),
          restored: writeAgain.status,
        },
      );
    }

    // ------------------------------ 5. the D20(b) company-view event lookups
    {
      const foreign = await trpcMutation(
        'views.portfolio.company.addInvestorToEvent',
        {
          companyId: b.entityId,
          eventId: b.eventId,
          name: `intruder-${tag}`,
          type: 'NATURAL_PERSON',
        },
        cookieA,
      );

      const leaked = await getValuationsQb(['investment'])
        .selectFrom('investment')
        .select(['id'])
        .where('event_id', '=', b.eventId as never)
        .execute();

      record(
        '5a',
        'addInvestorToEvent cannot reach another team’s event',
        foreign.status >= 400 &&
          leaked.length === 0 &&
          // A 404 (no such procedure) or a zod rejection would mean the
          // procedure body was never reached, which proves nothing about
          // scoping — this must fail on the EVENT lookup and say so.
          foreign.body.includes('Event not found'),
        { status: foreign.status, body: foreign.body.slice(0, 200), investmentsWritten: leaked.length },
      );
    }

    {
      // The read that feeds the changelog is the one D20(b) missed on this
      // procedure; scoped, it finds nothing and no changelog row is written.
      const before = await getValuationsQb(['funding_changelog'])
        .selectFrom('funding_changelog')
        .select(['id'])
        .where('legal_entity_id', '=', b.entityId as never)
        .execute();

      const foreign = await trpcMutation(
        'views.portfolio.company.removeInvestorFromEvent',
        { eventId: b.eventId, investorId: b.entityId },
        cookieA,
      );

      const after = await getValuationsQb(['funding_changelog'])
        .selectFrom('funding_changelog')
        .select(['id'])
        .where('legal_entity_id', '=', b.entityId as never)
        .execute();

      record(
        '5b',
        'removeInvestorFromEvent writes no changelog for another team’s event',
        after.length === before.length,
        { status: foreign.status, changelogBefore: before.length, changelogAfter: after.length },
      );
    }

    // ------------------------------------------- 6. the team-override refusal
    {
      const r = await wire('/api/v1/me', {
        headers: { ...cookieA, 'x-request-team-id': b.teamId },
      });
      record('6', 'team A cannot act as team B by asking', r.status === 403, {
        status: r.status,
        body: r.body.slice(0, 160),
      });
    }
  } finally {
    await dropTeamB(b);
  }

  console.log('\n================ SUMMARY ================');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}    ${r.id}  ${r.name}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
