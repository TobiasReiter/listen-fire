// The realised/retained split turns on one question: does a held asset still
// track the underlying value of the company we invested in?
//
//   - Held equity in the investee, or an SPV interest whose underlying IS the
//     investee, still tracks it → RETAINED (even though an SPV interest is
//     illiquid).
//   - Held shares of an acquirer taken in a share-for-share deal no longer track
//     it → REALISED (covered by acquisition_track_through.integration.test.ts).
//
// This file pins the SPV edge case (must stay retained) and guards the two
// ordinary paths — a plain hold and a plain secondary exit — so the new rule
// doesn't disturb them.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getCoreQb, getValuationsQb } from '../../kysely';
import { Context } from '../../../services/context';
import { getInvestmentsValuation } from '../valuation';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import PriceType from '../../../generated/kysely/valuations/PriceType';
import InvestmentType from '../../../generated/kysely/valuations/InvestmentType';
import LegalEntityType from '../../../generated/kysely/valuations/LegalEntityType';
import { userPrincipal } from '../../../services/principal';

const AS_OF_DATE = new Date('2024-12-31');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

// A tiny seeding toolkit — each helper inserts one row-type for a team and
// returns the id(s) it minted, so a scenario reads as a short script.
class Scenario {
  readonly teamId: TeamId;
  readonly fundId: string;
  private readonly usdAssetIds = new Set<string>();

  private constructor(teamId: TeamId, fundId: string) {
    this.teamId = teamId;
    this.fundId = fundId;
  }

  static async create(): Promise<Scenario> {
    const teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      .values(anyVals({ id: teamId, name: `trk-${teamId.slice(0, 8)}` }))
      .execute();
    const s = new Scenario(teamId, randomUUID());
    await s.entity({ id: s.fundId, name: 'Our Fund', type: LegalEntityType.FUND, ownInvesting: true });
    return s;
  }

  async entity({
    id = randomUUID(),
    name,
    type = LegalEntityType.COMPANY,
    ownInvesting = false,
    underlyingCompanyId,
  }: {
    id?: string;
    name: string;
    type?: LegalEntityType;
    ownInvesting?: boolean;
    underlyingCompanyId?: string;
  }): Promise<string> {
    await getValuationsQb(['legal_entity'])
      .insertInto('legal_entity')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          name,
          type,
          is_own_investing_entity: ownInvesting || null,
          underlying_company_id: underlyingCompanyId ?? null,
        }),
      )
      .execute();
    return id;
  }

  async asset({
    id = randomUUID(),
    issuerId,
    name,
    type,
    properties = {},
  }: {
    id?: string;
    issuerId: string;
    name: string;
    type: AssetType;
    properties?: Record<string, unknown>;
  }): Promise<string> {
    await getValuationsQb(['asset'])
      .insertInto('asset')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          issued_by_legal_entity_id: issuerId,
          name,
          properties,
          type,
        }),
      )
      .execute();
    return id;
  }

  async usd(): Promise<string> {
    const assetId = randomUUID();
    await this.asset({ id: assetId, issuerId: this.fundId, name: 'USD', type: AssetType.CURRENCY });
    await getValuationsQb(['currency_asset'])
      .insertInto('currency_asset')
      .values(
        anyVals({
          id: randomUUID(),
          asset_id: assetId,
          iso_code: CurrencyIsoCode.USD,
          name: 'US Dollar',
          symbol: '$',
          pair_order: 1,
        }),
      )
      .execute();
    this.usdAssetIds.add(assetId);
    return assetId;
  }

  async investment({
    investeeId,
    type = InvestmentType.CASH,
  }: {
    investeeId: string;
    type?: InvestmentType;
  }): Promise<string> {
    const id = randomUUID();
    await getValuationsQb(['investment'])
      .insertInto('investment')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          investor_profile_id: this.fundId,
          investment_profile_id: investeeId,
          type,
        }),
      )
      .execute();
    return id;
  }

  /** One transaction with a set of transfers. Each transfer is {assetId, num,
   *  from, to} — flow direction is derived by the engine from which side is the
   *  fund. */
  async transaction({
    date,
    investmentId = null,
    transfers,
  }: {
    date: string;
    investmentId?: string | null;
    transfers: { assetId: string; num: number; from: string; to: string }[];
  }): Promise<string> {
    const id = randomUUID();
    await getValuationsQb(['transaction'])
      .insertInto('transaction')
      .values(anyVals({ id, team_id: this.teamId, close_date: date, investment_id: investmentId }))
      .execute();
    await getValuationsQb(['asset_transfer'])
      .insertInto('asset_transfer')
      .values(
        transfers.map((t) =>
          anyVals({
            id: randomUUID(),
            team_id: this.teamId,
            transaction_id: id,
            date,
            asset_id: t.assetId,
            num_assets: t.num,
            from_legal_entity_id: t.from,
            to_legal_entity_id: t.to,
          }),
        ),
      )
      .execute();
    return id;
  }

  async price({
    assetId,
    issuerId,
    price,
    date,
  }: {
    assetId: string;
    issuerId: string;
    price: number;
    date: string;
  }): Promise<void> {
    await getValuationsQb(['price'])
      .insertInto('price')
      .values(
        anyVals({
          id: randomUUID(),
          team_id: this.teamId,
          date,
          price,
          currency: CurrencyIsoCode.USD,
          asset_id: assetId,
          legal_entity_id: issuerId,
          type: PriceType.FROM_ASSET_HOLDER,
        }),
      )
      .execute();
  }

  value(investmentId: string) {
    return withTeamContext(this.teamId, () =>
      getInvestmentsValuation({
        investments: [{ id: investmentId, date: null }],
        asOfDate: AS_OF_DATE,
        fxDate: AS_OF_DATE,
        targetCurrency: CurrencyIsoCode.USD,
      }),
    );
  }

  async cleanup(): Promise<void> {
    await getValuationsQb(['price']).deleteFrom('price').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['asset_transfer']).deleteFrom('asset_transfer').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['transaction']).deleteFrom('transaction').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['investment']).deleteFrom('investment').where('team_id', '=', this.teamId).execute();
    for (const usdAssetId of this.usdAssetIds) {
      await getValuationsQb(['currency_asset']).deleteFrom('currency_asset').where('asset_id', '=', usdAssetId as never).execute();
    }
    await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['legal_entity']).deleteFrom('legal_entity').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['valuations_change_outbox'])
      .deleteFrom('valuations_change_outbox')
      .where('team_id', '=', this.teamId)
      .execute();
    await getCoreQb(['team']).deleteFrom('team').where('id', '=', this.teamId).execute();
  }
}

async function withTeamContext<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: randomUUID(), teamId }));
  return ctx.runAsync(fn);
}

describe('tracks-investee realised/retained split', () => {
  let scenario: Scenario;
  afterEach(async () => {
    await scenario.cleanup();
  });

  it('keeps an SPV interest RETAINED — it still tracks the underlying company', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyC = await scenario.entity({ name: 'Company C' });
    const spv = await scenario.entity({
      name: 'C SPV',
      type: LegalEntityType.SPV,
      underlyingCompanyId: companyC,
    });
    const cShares = await scenario.asset({ issuerId: companyC, name: 'Company C Shares', type: AssetType.EQUITY });
    const spvInterest = await scenario.asset({
      issuerId: spv,
      name: 'C SPV Interest',
      type: AssetType.SPV_INTEREST_POINT,
      properties: { spv_investment_target_company_id: companyC },
    });
    const investment = await scenario.investment({ investeeId: companyC });

    // Invest $30k for 15 C-shares, then roll those shares into an SPV interest.
    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 30000, from: scenario.fundId, to: companyC },
        { assetId: cShares, num: 15, from: companyC, to: scenario.fundId },
      ],
    });
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: cShares, num: 15, from: scenario.fundId, to: spv },
        { assetId: spvInterest, num: 1, from: spv, to: scenario.fundId },
      ],
    });
    await scenario.price({ assetId: spvInterest, issuerId: spv, price: 30000, date: '2024-06-01' });

    const v = await scenario.value(investment);
    const moic = v.investedTransactionDateValue
      ? v.totalValuationDateValue / v.investedTransactionDateValue
      : null;

    expect(v.investedTransactionDateValue).toBeCloseTo(30000, 2);
    // The SPV interest tracks Company C, so it is retained, not realised.
    expect(v.unrealizedValuationDateValue).toBeCloseTo(30000, 2);
    expect(v.realizedTransactionDateValue).toBeCloseTo(0, 2);
    expect(moic).toBeCloseTo(1.0, 3);
  });

  it('guard: a plain held equity position is retained, nothing realised', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyC = await scenario.entity({ name: 'Company C' });
    const cShares = await scenario.asset({ issuerId: companyC, name: 'Company C Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyC });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 30000, from: scenario.fundId, to: companyC },
        { assetId: cShares, num: 15, from: companyC, to: scenario.fundId },
      ],
    });
    await scenario.price({ assetId: cShares, issuerId: companyC, price: 2500, date: '2024-06-01' });

    const v = await scenario.value(investment);
    const moic = v.investedTransactionDateValue
      ? v.totalValuationDateValue / v.investedTransactionDateValue
      : null;

    expect(v.investedTransactionDateValue).toBeCloseTo(30000, 2);
    expect(v.unrealizedValuationDateValue).toBeCloseTo(37500, 2); // 15 × 2500
    expect(v.realizedTransactionDateValue).toBeCloseTo(0, 2);
    expect(moic).toBeCloseTo(1.25, 3);
  });

  it('guard: a full secondary sale realises cash and retains nothing', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyC = await scenario.entity({ name: 'Company C' });
    const buyer = await scenario.entity({ name: 'Secondary Buyer' });
    const cShares = await scenario.asset({ issuerId: companyC, name: 'Company C Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyC });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 30000, from: scenario.fundId, to: companyC },
        { assetId: cShares, num: 15, from: companyC, to: scenario.fundId },
      ],
    });
    // Sell all 15 shares to a secondary buyer for $45k.
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: cShares, num: 15, from: scenario.fundId, to: buyer },
        { assetId: usd, num: 45000, from: buyer, to: scenario.fundId },
      ],
    });

    const v = await scenario.value(investment);
    const moic = v.investedTransactionDateValue
      ? v.totalValuationDateValue / v.investedTransactionDateValue
      : null;

    expect(v.investedTransactionDateValue).toBeCloseTo(30000, 2);
    expect(v.unrealizedValuationDateValue).toBeCloseTo(0, 2);
    expect(v.realizedTransactionDateValue).toBeCloseTo(45000, 2);
    expect(moic).toBeCloseTo(1.5, 3);
  });
});
