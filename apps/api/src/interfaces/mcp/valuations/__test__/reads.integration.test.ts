// Drives the two valuations read tools end-to-end through the tRPC caller
// against the real test DB: getCompanyFunding (tab composition + first
// investment) and findCompanies (multi-field fuzzy batch search).

import { randomUUID } from 'node:crypto';


import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';

import { getCoreQb, getValuationsQb } from '../../../../lib/kysely';
import { Context } from '../../../../services/context';
import { getCompanyFunding, findCompanies } from '../reads';
import { portfolioTools } from '../portfolio';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../../../generated/kysely/valuations/AssetType';
import PriceType from '../../../../generated/kysely/valuations/PriceType';
import InvestmentType from '../../../../generated/kysely/valuations/InvestmentType';
import LegalEntityType from '../../../../generated/kysely/valuations/LegalEntityType';
import { userPrincipal } from '../../../../services/principal';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

let teamId: TeamId;
let userId: UserId;
let fundId: string;
let companyId: string;
let usdAssetId: string;

async function run<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId, teamId }));
  return ctx.runAsync(fn);
}

async function callTool(tool: { handler?: (a: Record<string, unknown>) => unknown }, args: Record<string, unknown>) {
  const result = (await tool.handler!(args)) as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  userId = randomUUID() as UserId;
  fundId = randomUUID();
  companyId = randomUUID();
  usdAssetId = randomUUID();
  const sharesAssetId = randomUUID();
  const investmentId = randomUUID();
  const txnId = randomUUID();

  await getCoreQb(['team']).insertInto('team').values(anyVals({ id: teamId, name: `mcp-${teamId.slice(0, 8)}` })).execute();
  await getCoreQb(['user']).insertInto('user').values(anyVals({ id: userId, default_team_id: teamId, username: `mcp-${userId.slice(0, 8)}` })).execute();
  await getCoreQb(['user_email']).insertInto('user_email').values(anyVals({ id: randomUUID(), user_id: userId, email: `mcp-${userId.slice(0, 8)}@test-vc-firm.com`, is_primary: true })).execute();
  await getValuationsQb(['legal_entity']).insertInto('legal_entity').values([
    anyVals({ id: fundId, team_id: teamId, name: 'Our Fund', type: LegalEntityType.FUND, is_own_investing_entity: true, is_portfolio: true }),
    anyVals({
      id: companyId, team_id: teamId, name: 'Acme Robotics', slug: `acme-robotics-${companyId.slice(0, 8)}`,
      legal_name: 'Acme Robotics Incorporated', also_known_as: 'Acme', other_names: ['AcmeCo', 'Robotics Ltd'],
      type: LegalEntityType.COMPANY,
    }),
  ]).execute();
  await getValuationsQb(['asset']).insertInto('asset').values([
    anyVals({ id: usdAssetId, team_id: teamId, issued_by_legal_entity_id: fundId, name: 'USD', properties: {}, type: AssetType.CURRENCY }),
    anyVals({ id: sharesAssetId, team_id: teamId, issued_by_legal_entity_id: companyId, name: 'Acme Shares', properties: {}, type: AssetType.EQUITY }),
  ]).execute();
  await getValuationsQb(['currency_asset']).insertInto('currency_asset').values(anyVals({
    id: randomUUID(), asset_id: usdAssetId, iso_code: CurrencyIsoCode.USD, name: 'US Dollar', symbol: '$', pair_order: 1,
  })).execute();
  await getValuationsQb(['investment']).insertInto('investment').values(anyVals({
    id: investmentId, team_id: teamId, investor_profile_id: fundId, investment_profile_id: companyId,
    type: InvestmentType.CASH, invested_at: new Date('2023-05-15'),
  })).execute();
  await getValuationsQb(['transaction']).insertInto('transaction').values(anyVals({
    id: txnId, team_id: teamId, close_date: '2023-05-15', investment_id: investmentId,
  })).execute();
  await getValuationsQb(['asset_transfer']).insertInto('asset_transfer').values([
    anyVals({ id: randomUUID(), team_id: teamId, transaction_id: txnId, date: '2023-05-15', asset_id: usdAssetId, num_assets: 50000, from_legal_entity_id: fundId, to_legal_entity_id: companyId }),
    anyVals({ id: randomUUID(), team_id: teamId, transaction_id: txnId, date: '2023-05-15', asset_id: sharesAssetId, num_assets: 20, from_legal_entity_id: companyId, to_legal_entity_id: fundId }),
  ]).execute();
  await getValuationsQb(['price']).insertInto('price').values(anyVals({
    id: randomUUID(), team_id: teamId, date: '2023-05-15', price: 3500, currency: CurrencyIsoCode.USD,
    asset_id: sharesAssetId, legal_entity_id: companyId, type: PriceType.FROM_ASSET_HOLDER,
  })).execute();
});

afterAll(async () => {
  await getValuationsQb(['price']).deleteFrom('price').where('team_id', '=', teamId).execute();
  await getValuationsQb(['asset_transfer']).deleteFrom('asset_transfer').where('team_id', '=', teamId).execute();
  await getValuationsQb(['transaction']).deleteFrom('transaction').where('team_id', '=', teamId).execute();
  await getValuationsQb(['investment']).deleteFrom('investment').where('team_id', '=', teamId).execute();
  await getValuationsQb(['currency_asset']).deleteFrom('currency_asset').where('asset_id', '=', usdAssetId as never).execute();
  await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', teamId).execute();
  await getValuationsQb(['legal_entity']).deleteFrom('legal_entity').where('team_id', '=', teamId).execute();
  await getValuationsQb(['valuations_change_outbox']).deleteFrom('valuations_change_outbox').where('team_id', '=', teamId).execute();
  await getCoreQb(['user_email']).deleteFrom('user_email').where('user_id', '=', userId).execute();
  await getCoreQb(['user']).deleteFrom('user').where('id', '=', userId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

describe('getCompanyFunding', () => {
  it('returns the tab composition and a first-investment with quarter/year + MOIC', async () => {
    const data = await run(() => callTool(getCompanyFunding, { company: companyId, currency: 'USD' }));

    expect(data.company.name).toBe('Acme Robotics');
    expect(data.overview.invested).toBeCloseTo(50000, 2);
    expect(data.firstInvestment).toBeTruthy();
    expect(data.firstInvestment.year).toBe(2023);
    expect(data.firstInvestment.quarter).toBe(2); // May → Q2
    expect(data.firstInvestment.fund.name).toBe('Our Fund');
    // 20 shares @ 3500 = 70000 held, invested 50000 → MOIC 1.4
    expect(data.firstInvestment.moic).toBeCloseTo(1.4, 2);
    expect(data.overview).toHaveProperty('moic');
    expect(data.eventHistory).toHaveProperty('investments');
  });

  it('resolves a company by slug too', async () => {
    const bySlug = await run(async () => {
      const c = await getValuationsQb(['legal_entity']).selectFrom('legal_entity').select('slug').where('id', '=', companyId as never).executeTakeFirstOrThrow();
      return callTool(getCompanyFunding, { company: c.slug!, currency: 'USD' });
    });
    expect(bySlug.company.id).toBe(companyId);
  });
});

describe('listPortfolioCompanies (portfolio/companies UI)', () => {
  it('returns the portfolio with per-company MOIC', async () => {
    const data = await run(() =>
      callTool(portfolioTools.listPortfolioCompanies, { filter: {}, config: { currency: 'USD' } }),
    );
    const acme = data.items.find((c: { name: string }) => c.name === 'Acme Robotics');
    expect(acme).toBeTruthy();
    expect(acme).toHaveProperty('moic');
  });

  // The MCP surface is the API, not the app: where the app states an opinion
  // about what a line means, an agent gets to choose. The two answers only
  // diverge over a share-for-share sale, which this fixture has none of — what
  // is pinned here is that the choice is offered, described, and accepted.
  // investmentsAcquisitionExclusion (f)-(h) pins how they diverge.
  it('offers the lens as a described input, and takes either answer', async () => {
    const { lens } = portfolioTools.listPortfolioCompanies.inputSchema;
    expect(lens).toBeDefined();
    expect(lens.description).toMatch(/investment/);
    expect(lens.description).toMatch(/holdings/);

    const args = { filter: {}, config: { currency: 'USD' } };
    const [byDefault, asInvestments] = await run(async () => [
      await callTool(portfolioTools.listPortfolioCompanies, args),
      await callTool(portfolioTools.listPortfolioCompanies, { ...args, lens: 'investment' }),
    ]);

    const names = (list: { items: { name: string }[] }) => list.items.map((c) => c.name).sort();
    expect(names(asInvestments)).toEqual(names(byDefault));
  });
});

describe('findCompanies', () => {
  it('matches across name, legal_name, also_known_as, and other_names, in one batch', async () => {
    const res = await run(() =>
      callTool(findCompanies, { queries: ['Acme Robotics', 'Incorporated', 'Acme', 'AcmeCo'] }),
    );
    expect(res['Acme Robotics'][0].id).toBe(companyId);
    expect(res['Acme Robotics'][0].matchedField).toBe('name');
    expect(res['Incorporated'][0].id).toBe(companyId);
    expect(res['Incorporated'][0].matchedField).toBe('legal_name');
    expect(res['Acme'].some((m: { matchedField: string }) => m.matchedField === 'also_known_as' || m.matchedField === 'name')).toBe(true);
    expect(res['AcmeCo'][0].matchedField).toBe('other_names');
  });
});
