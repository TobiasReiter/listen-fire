// Reproduction: adding an investment to a NEW company (entity: 'NEW') fails with
// a foreign-key violation on the first row that references the freshly-minted
// entity.
//
// Root cause: `ctx.enterTransaction()` opens two SEPARATE database transactions
// — a prisma one and a kysely one (services/context/index.ts). `ProfileService.
// create` mints the entity via prisma; `getOrCreateEvent` / the investment /
// asset-transfer inserts run via kysely (`getQb`). The kysely transaction can't
// see the uncommitted prisma-created entity, so the event insert violates
// `event_legal_entity_id_fkey`. (With no round name the same failure lands on
// the investment insert instead.)

import { randomUUID } from 'node:crypto';


import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';

import { getCoreQb, getValuationsQb } from '../../../kysely';
import { Context } from '../../../../services/context';
import { applyInvestment, resolveInvestmentEntities } from '../investment';
import { applyRound, resolveRoundEntities } from '../round';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../../../generated/kysely/valuations/AssetType';
import LegalEntityType from '../../../../generated/kysely/valuations/LegalEntityType';
import { userPrincipal } from '../../../../services/principal';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

let teamId: TeamId;
let userId: UserId;
let fundId: string;
let companyId: string;
let usdAssetId: string;

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  userId = randomUUID() as UserId;
  fundId = randomUUID();
  companyId = randomUUID();
  usdAssetId = randomUUID();

  await getCoreQb(['team'])
    .insertInto('team')
    .values(anyVals({ id: teamId, name: `newco-${teamId.slice(0, 8)}` }))
    .execute();
  await getCoreQb(['user'])
    .insertInto('user')
    .values(anyVals({ id: userId, default_team_id: teamId, username: `newco-${userId.slice(0, 8)}` }))
    .execute();
  await getValuationsQb(['legal_entity'])
    .insertInto('legal_entity')
    .values(
      anyVals({
        id: fundId,
        team_id: teamId,
        name: 'Our Fund',
        type: LegalEntityType.FUND,
        is_own_investing_entity: true,
      }),
    )
    .execute();
  // An already-existing company — the addRound companion test's target
  // entity (applyRound has no 'NEW'-entity path, only 'NEW' co-investors).
  await getValuationsQb(['legal_entity'])
    .insertInto('legal_entity')
    .values(
      anyVals({
        id: companyId,
        team_id: teamId,
        name: 'ExistingCo',
        type: LegalEntityType.COMPANY,
      }),
    )
    .execute();
  // A USD currency asset so the cash-flow leg can resolve (not reached in the
  // failing case, but needed once the fix lets execution get that far).
  await getValuationsQb(['asset'])
    .insertInto('asset')
    .values(
      anyVals({
        id: usdAssetId,
        team_id: teamId,
        issued_by_legal_entity_id: fundId,
        name: 'USD',
        properties: {},
        type: AssetType.CURRENCY,
      }),
    )
    .execute();
  await getValuationsQb(['currency_asset'])
    .insertInto('currency_asset')
    .values(
      anyVals({
        id: randomUUID(),
        asset_id: usdAssetId,
        iso_code: CurrencyIsoCode.USD,
        name: 'US Dollar',
        symbol: '$',
        pair_order: 1,
      }),
    )
    .execute();
});

afterAll(async () => {
  // Drain everything the run may have written, children before parents.
  await getValuationsQb(['price']).deleteFrom('price').where('team_id', '=', teamId).execute();
  await getValuationsQb(['asset_transfer']).deleteFrom('asset_transfer').where('team_id', '=', teamId).execute();
  await getValuationsQb(['transaction']).deleteFrom('transaction').where('team_id', '=', teamId).execute();
  await getValuationsQb(['investment']).deleteFrom('investment').where('team_id', '=', teamId).execute();
  await getValuationsQb(['event']).deleteFrom('event').where('team_id', '=', teamId).execute();
  await getValuationsQb(['currency_asset']).deleteFrom('currency_asset').where('asset_id', '=', usdAssetId as never).execute();
  await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', teamId).execute();
  await getValuationsQb(['legal_entity']).deleteFrom('legal_entity').where('team_id', '=', teamId).execute();
  await getValuationsQb(['valuations_change_outbox']).deleteFrom('valuations_change_outbox').where('team_id', '=', teamId).execute();
  await getCoreQb(['user']).deleteFrom('user').where('id', '=', userId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

// Exercises the real fix path: resolve 'NEW' entities BEFORE the
// transaction opens (so ProfileService.create's Prisma write auto-commits
// and is visible to the Kysely bulk that follows), THEN enter the
// transaction and run the atomic apply — mirroring what every caller
// (tRPC addInvestment, REST add-investment) now does.
async function resolveThenApplyInvestment(
  input: Parameters<typeof applyInvestment>[0],
): Promise<ReturnType<typeof applyInvestment>> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId, teamId }));
  return ctx.runAsync(async () => {
    const resolved = await resolveInvestmentEntities(input);
    await ctx.enterTransaction();
    return applyInvestment(resolved);
  });
}

it('creates an equity investment against a brand-new company', async () => {
  const result = await resolveThenApplyInvestment({
    entity: 'NEW',
    entityName: 'BrandNewCo',
    entityType: LegalEntityType.COMPANY,
    investingEntity: fundId,
    investingEntityName: 'Our Fund',
    roundName: 'Seed',
    investmentDate: '2024-01-01',
    investmentAmount: '50000',
    investmentCurrency: CurrencyIsoCode.USD,
    investmentType: 'EQUITY',
    numberOfShares: '20',
    pricePerShare: '2500',
    pricePerShareCurrency: CurrencyIsoCode.USD,
  });

  expect(result.investmentId).toBeTruthy();

  // The new company, its round event and the investment all landed.
  const company = await getValuationsQb(['legal_entity'])
    .selectFrom('legal_entity')
    .select('id')
    .where('team_id', '=', teamId)
    .where('name', '=', 'BrandNewCo')
    .executeTakeFirst();
  expect(company).toBeTruthy();

  const investment = await getValuationsQb(['investment'])
    .selectFrom('investment')
    .select('id')
    .where('id', '=', result.investmentId as never)
    .executeTakeFirst();
  expect(investment).toBeTruthy();
});

it('adds a round with a brand-new co-investor', async () => {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId, teamId }));

  const result = await ctx.runAsync(async () => {
    const resolved = await resolveRoundEntities({
      entity: companyId,
      roundName: 'Seed',
      date: '2024-01-01',
      currency: CurrencyIsoCode.USD,
      coInvestors: [{ id: 'NEW', name: 'New Co-Investor Fund', type: 'FUND' }],
    });
    await ctx.enterTransaction();
    return applyRound(resolved);
  });

  expect(result.eventId).toBeTruthy();

  const coInvestorEntity = await getValuationsQb(['legal_entity'])
    .selectFrom('legal_entity')
    .select('id')
    .where('team_id', '=', teamId)
    .where('name', '=', 'New Co-Investor Fund')
    .executeTakeFirst();
  expect(coInvestorEntity).toBeTruthy();

  const coInvestorRow = await getValuationsQb(['investment'])
    .selectFrom('investment')
    .select('id')
    .where('event_id', '=', result.eventId as never)
    .where('investor_profile_id', '=', coInvestorEntity?.id as never)
    .executeTakeFirst();
  expect(coInvestorRow).toBeTruthy();
});
