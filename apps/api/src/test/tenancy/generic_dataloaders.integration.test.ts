// The two-team probe for the three GENERIC dataloaders (D44d).
//
// `findByIdDataloader`, `findByUniqueDataloader` and `findManyByFkDataloader`
// carry no scoping of their own: every `ModelService.getById` in the codebase
// funnels through them, and each is handed nothing but a model name and a key.
// Whatever filter they applied used to be whatever the CLIENT they ran on
// applied — which is why this was the one place deleting CASL could silently
// open cross-tenant reads. `TENANT_SCOPES` answers that now, per model, in
// writing, and this asks the question directly against real rows in a real
// database: acting as a member of team A, which of team B's rows comes back?
//
// While the ability layer stood, this ran in two states — under a real user's
// abilities, and again with the ability opened all the way up so the declared
// filter was the only one left — and the two had to agree. They did, which was
// the evidence that these loaders' tenancy never depended on CASL. That second
// state is gone because it arrived; the expectations are unchanged from the
// two-state form, so the runs stay comparable across the deletion.
//
// The expectations below are DESCRIPTIVE, not aspirational: they record what
// the system does, including where that is wider than one would like. Where a
// model is knowingly unscoped the test says so and why, so the next reader does
// not mistake a recorded fact for an endorsement.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import { getCoreQb, getValuationsQb } from '../../lib/kysely';
import { Context } from '../../services/context';
import { findByIdDataloader } from '../../lib/datasources/dataloaders';
import { userPrincipal } from '../../services/principal';
import { UserService } from '../../services/user';
import { TeamService } from '../../services/team';
import { ProfileService } from '../../services/profiles/profile';
import { ApiKeyService } from '../../services/api_key';
import LegalEntityType from '../../generated/kysely/valuations/LegalEntityType';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

interface Tenant {
  teamId: TeamId;
  userId: UserId;
  email: string;
  apiKeyId: string;
  entityId: string;
  slug: string;
}

const tag = randomUUID().slice(0, 8);

async function makeTenant(label: string): Promise<Tenant> {
  const teamId = randomUUID() as TeamId;
  const userId = randomUUID() as UserId;
  const tenant: Tenant = {
    teamId,
    userId,
    email: `${label}-${tag}@probe.invalid`,
    apiKeyId: randomUUID(),
    entityId: randomUUID(),
    slug: `probe-${label}-${tag}`,
  };

  await getCoreQb(['team'])
    .insertInto('team')
    .values(anyVals({ id: teamId, name: `probe-${label}-${tag}` }))
    .execute();
  await getCoreQb(['user'])
    .insertInto('user')
    .values(
      anyVals({
        id: userId,
        default_team_id: teamId,
        username: `probe-${label}-${tag}`,
        granted_access_at: new Date(),
      }),
    )
    .execute();
  await getCoreQb(['team_membership'])
    .insertInto('team_membership')
    .values(anyVals({ id: randomUUID(), user_id: userId, team_id: teamId, access: 'write' }))
    .execute();
  await getCoreQb(['user_email'])
    .insertInto('user_email')
    .values(anyVals({ id: randomUUID(), user_id: userId, email: tenant.email, is_primary: true }))
    .execute();
  await getCoreQb(['api_key'])
    .insertInto('api_key')
    .values(
      anyVals({
        id: tenant.apiKeyId,
        team_id: teamId,
        name: `probe-${label}`,
        key_hash: `hash-${tenant.apiKeyId}`,
        key_prefix: 'lf_probe',
        scopes: ['probe'],
        created_by: userId,
      }),
    )
    .execute();
  await getValuationsQb(['legal_entity'])
    .insertInto('legal_entity')
    .values(
      anyVals({
        id: tenant.entityId,
        team_id: teamId,
        name: `Probe ${label}`,
        slug: tenant.slug,
        type: LegalEntityType.COMPANY,
      }),
    )
    .execute();

  return tenant;
}

async function dropTenant(t: Tenant): Promise<void> {
  await getValuationsQb(['legal_entity'])
    .deleteFrom('legal_entity')
    .where('team_id', '=', t.teamId)
    .execute();
  await getCoreQb(['api_key']).deleteFrom('api_key').where('team_id', '=', t.teamId).execute();
  await getCoreQb(['user_email']).deleteFrom('user_email').where('user_id', '=', t.userId).execute();
  await getCoreQb(['team_membership'])
    .deleteFrom('team_membership')
    .where('user_id', '=', t.userId)
    .execute();
  await getCoreQb(['user']).deleteFrom('user').where('id', '=', t.userId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', t.teamId).execute();
}

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  a = await makeTenant('a');
  b = await makeTenant('b');
});

afterAll(async () => {
  await dropTenant(a);
  await dropTenant(b);
});

/** Run `fn` as tenant A's user, with the identity built exactly the way a
 *  request builds it. A fresh Context per call, since the dataloaders memoise
 *  per context and a cached row would answer for the loader rather than the
 *  loader answering for itself. */
async function asTenantA<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: a.userId, teamId: a.teamId }));
  return ctx.runAsync(fn);
}

const found = async (load: () => Promise<unknown>): Promise<boolean> => {
  try {
    return (await load()) !== null;
  } catch {
    // `ModelService.getById` throws rather than answering null when the filtered
    // read comes back empty; both spellings mean "not visible".
    return false;
  }
};

describe('findById — the loader every ModelService.getById funnels through', () => {
  it('hands back the acting team’s own rows', async () => {
    await asTenantA(async () => {
      await expect(found(() => ApiKeyService.getById(a.apiKeyId))).resolves.toBe(true);
      await expect(found(() => TeamService.getById(a.teamId))).resolves.toBe(true);
      await expect(found(() => ProfileService.getById(a.entityId))).resolves.toBe(true);
      await expect(found(() => UserService.getById(a.userId))).resolves.toBe(true);
    });
  });

  it('refuses the other team’s api key — the credential is team property', async () => {
    await asTenantA(async () => {
      await expect(found(() => ApiKeyService.getById(b.apiKeyId))).resolves.toBe(false);
    });
  });

  it('refuses the other team itself', async () => {
    await asTenantA(async () => {
      await expect(found(() => TeamService.getById(b.teamId))).resolves.toBe(false);
    });
  });

  it('RECORDS that legal entities and users are readable across teams', async () => {
    // Not a leak this chunk introduced and not one it may close: `legal_entity`
    // carries genuinely team-less rows (the shared company graph), and `user`
    // is core-owned identity every attribution read resolves by id. Both are
    // globally readable today. Narrowing either is a policy call that belongs
    // to valuations' own rework and to the Directory contract respectively —
    // pinned here so that a change to it trips a test rather than a customer.
    await asTenantA(async () => {
      await expect(found(() => ProfileService.getById(b.entityId))).resolves.toBe(true);
      await expect(found(() => UserService.getById(b.userId))).resolves.toBe(true);
    });
  });
});

describe('findByUnique — the by-slug / by-email / by-userId loaders', () => {
  it('finds the acting team’s own entity by slug', async () => {
    await asTenantA(async () => {
      await expect(found(() => ProfileService.getBySlug(a.slug))).resolves.toBe(true);
    });
  });

  it('RECORDS that a slug resolves across teams, like the by-id read above', async () => {
    await asTenantA(async () => {
      await expect(found(() => ProfileService.getBySlug(b.slug))).resolves.toBe(true);
    });
  });

  it('RECORDS that a login email resolves to its user whoever asks', async () => {
    // `user_email` is the login lookup: it answers before any team is known, so
    // it cannot be team-scoped without breaking sign-in. Core keeps it as
    // identity, deliberately global (D31 leaves login identities in core).
    await asTenantA(async () => {
      await expect(found(() => UserService.getByEmail(b.email))).resolves.toBe(true);
    });
  });

});

describe('findManyByFk — the by-foreign-key loader', () => {
  it('RECORDS that users list across teams', async () => {
    await asTenantA(async () => {
      const own = await UserService.findManyByTeamId(a.teamId);
      expect(own.map((u) => u.id)).toContain(a.userId);

      const other = await UserService.findManyByTeamId(b.teamId);
      expect(other.map((u) => u.id)).toContain(b.userId);
    });
  });
});

describe('the declared filter answers alone — the same answers the two-state form recorded', () => {
  it('still refuses the other team’s api key and the other team itself', async () => {
    await asTenantA(async () => {
      await expect(found(() => ApiKeyService.getById(a.apiKeyId))).resolves.toBe(true);
      await expect(found(() => ApiKeyService.getById(b.apiKeyId))).resolves.toBe(false);
      await expect(found(() => TeamService.getById(a.teamId))).resolves.toBe(true);
      await expect(found(() => TeamService.getById(b.teamId))).resolves.toBe(false);
    });
  });

  it('still reads the declared-unscoped models across teams, no wider than before', async () => {
    await asTenantA(async () => {
      await expect(found(() => UserService.getById(b.userId))).resolves.toBe(true);
      await expect(found(() => ProfileService.getById(b.entityId))).resolves.toBe(true);
      await expect(found(() => ProfileService.getBySlug(b.slug))).resolves.toBe(true);
      await expect(found(() => UserService.getByEmail(b.email))).resolves.toBe(true);
    });
  });
});

describe('a model with no declared tenant refuses to read rather than guessing', () => {
  it('names the model and what it is missing', async () => {
    await asTenantA(async () => {
      // `note` is a real model with a `teamId`, reached by no generic loader
      // today — exactly the shape of a future ModelService that forgets to say
      // what its tenant is.
      await expect(
        findByIdDataloader('note' as never)().load(randomUUID()),
      ).rejects.toThrow(/No tenant scope declared/);
    });
  });
});
