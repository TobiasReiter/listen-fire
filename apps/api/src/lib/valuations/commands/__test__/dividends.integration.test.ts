// The rights edge on the real write path. `due_to_rights_from_asset_id` is what
// tells a dividend on the company we invested in apart from one on the stock we
// took for it, and the command is the only place that can know which holding a
// payment rode in on. The unit test pins the decision; this pins the query that
// feeds it — held balances netted at the dividend date, resolved through the
// same tracked-entity rule the roll-up uses.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';

import { getCoreQb, getValuationsQb } from '../../../kysely';
import { Context } from '../../../../services/context';
import { userPrincipal } from '../../../../services/principal';
import { applyDividends } from '../dividends';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../../../generated/kysely/valuations/AssetType';
import LegalEntityType from '../../../../generated/kysely/valuations/LegalEntityType';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

let teamId: TeamId;
let userId: UserId;
let fundId: string;
let companyId: string;
let usdAssetId: string;

async function entity({
  name,
  type,
  underlyingCompanyId,
}: {
  name: string;
  type: LegalEntityType;
  underlyingCompanyId?: string;
}): Promise<string> {
  const id = randomUUID();
  await getValuationsQb(['legal_entity'])
    .insertInto('legal_entity')
    .values(
      anyVals({
        id,
        team_id: teamId,
        name,
        type,
        is_own_investing_entity: type === LegalEntityType.FUND || null,
        underlying_company_id: underlyingCompanyId ?? null,
      }),
    )
    .execute();
  return id;
}

async function asset({
  issuerId,
  name,
  type,
  properties = {},
}: {
  issuerId: string;
  name: string;
  type: AssetType;
  properties?: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  await getValuationsQb(['asset'])
    .insertInto('asset')
    .values(
      anyVals({
        id,
        team_id: teamId,
        issued_by_legal_entity_id: issuerId,
        name,
        properties,
        type,
      }),
    )
    .execute();
  return id;
}

async function transfer({
  assetId,
  num,
  from,
  to,
  date,
}: {
  assetId: string;
  num: number;
  from: string;
  to: string;
  date: string;
}): Promise<void> {
  const transactionId = randomUUID();
  await getValuationsQb(['transaction'])
    .insertInto('transaction')
    .values(anyVals({ id: transactionId, team_id: teamId, close_date: date }))
    .execute();
  await getValuationsQb(['asset_transfer'])
    .insertInto('asset_transfer')
    .values(
      anyVals({
        id: randomUUID(),
        team_id: teamId,
        transaction_id: transactionId,
        date,
        asset_id: assetId,
        num_assets: num,
        from_legal_entity_id: from,
        to_legal_entity_id: to,
      }),
    )
    .execute();
}

async function payDividend(date: string): Promise<string> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId, teamId }));
  return ctx.runAsync(async () => {
    await ctx.enterTransaction();
    const { eventId } = await applyDividends({
      companyId,
      date,
      amount: 5000,
      currency: CurrencyIsoCode.USD,
      fundId,
    });
    return eventId;
  });
}

async function rightsAssetOf(eventId: string): Promise<string | null> {
  const row = await getValuationsQb(['transaction'])
    .selectFrom('transaction')
    .select('due_to_rights_from_asset_id')
    .where('event_id', '=', eventId as never)
    .executeTakeFirstOrThrow();
  return row.due_to_rights_from_asset_id;
}

beforeEach(async () => {
  teamId = randomUUID() as TeamId;
  userId = randomUUID() as UserId;
  await getCoreQb(['team'])
    .insertInto('team')
    .values(anyVals({ id: teamId, name: `div-${teamId.slice(0, 8)}` }))
    .execute();
  await getCoreQb(['user'])
    .insertInto('user')
    .values(anyVals({ id: userId, default_team_id: teamId, username: `div-${userId.slice(0, 8)}` }))
    .execute();
  fundId = await entity({ name: 'Our Fund', type: LegalEntityType.FUND });
  companyId = await entity({ name: 'Company A', type: LegalEntityType.COMPANY });
  usdAssetId = await asset({ issuerId: fundId, name: 'USD', type: AssetType.CURRENCY });
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

afterEach(async () => {
  await getValuationsQb(['funding_changelog_fund', 'funding_changelog'])
    .deleteFrom('funding_changelog_fund')
    .where('changelog_id', 'in', ($) =>
      $.selectFrom('funding_changelog').select('id').where('team_id', '=', teamId),
    )
    .execute();
  await getValuationsQb(['funding_changelog'])
    .deleteFrom('funding_changelog')
    .where('team_id', '=', teamId)
    .execute();
  await getValuationsQb(['asset_transfer']).deleteFrom('asset_transfer').where('team_id', '=', teamId).execute();
  await getValuationsQb(['transaction']).deleteFrom('transaction').where('team_id', '=', teamId).execute();
  await getValuationsQb(['event']).deleteFrom('event').where('team_id', '=', teamId).execute();
  await getValuationsQb(['currency_asset'])
    .deleteFrom('currency_asset')
    .where('asset_id', '=', usdAssetId as never)
    .execute();
  await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', teamId).execute();
  await getValuationsQb(['legal_entity']).deleteFrom('legal_entity').where('team_id', '=', teamId).execute();
  await getValuationsQb(['valuations_change_outbox'])
    .deleteFrom('valuations_change_outbox')
    .where('team_id', '=', teamId)
    .execute();
  await getCoreQb(['user']).deleteFrom('user').where('id', '=', userId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

describe('applyDividends stamps the rights edge', () => {
  it('names the single holding that tracks the paying company', async () => {
    const shares = await asset({ issuerId: companyId, name: 'A Shares', type: AssetType.EQUITY });
    await transfer({ assetId: shares, num: 20, from: companyId, to: fundId, date: '2024-01-01' });

    expect(await rightsAssetOf(await payDividend('2024-06-01'))).toEqual(shares);
  });

  it('leaves it null once the position has been sold down to nothing', async () => {
    const shares = await asset({ issuerId: companyId, name: 'A Shares', type: AssetType.EQUITY });
    const buyer = await entity({ name: 'Secondary Buyer', type: LegalEntityType.COMPANY });
    await transfer({ assetId: shares, num: 20, from: companyId, to: fundId, date: '2024-01-01' });
    await transfer({ assetId: shares, num: 20, from: fundId, to: buyer, date: '2024-03-01' });

    expect(await rightsAssetOf(await payDividend('2024-06-01'))).toBeNull();
  });

  it('leaves it null when both direct equity and an SPV over the company are held', async () => {
    const shares = await asset({ issuerId: companyId, name: 'A Shares', type: AssetType.EQUITY });
    const spv = await entity({
      name: 'A SPV',
      type: LegalEntityType.SPV,
      underlyingCompanyId: companyId,
    });
    const spvInterest = await asset({
      issuerId: spv,
      name: 'A SPV Interest',
      type: AssetType.SPV_INTEREST_POINT,
      properties: { spv_investment_target_company_id: companyId },
    });
    await transfer({ assetId: shares, num: 20, from: companyId, to: fundId, date: '2024-01-01' });
    await transfer({ assetId: spvInterest, num: 1, from: spv, to: fundId, date: '2024-02-01' });

    expect(await rightsAssetOf(await payDividend('2024-06-01'))).toBeNull();
  });

  it('ignores a holding acquired after the dividend date', async () => {
    const shares = await asset({ issuerId: companyId, name: 'A Shares', type: AssetType.EQUITY });
    await transfer({ assetId: shares, num: 20, from: companyId, to: fundId, date: '2024-09-01' });

    expect(await rightsAssetOf(await payDividend('2024-06-01'))).toBeNull();
  });
});
