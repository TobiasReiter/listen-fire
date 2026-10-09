// holdsTrackingAssets answers one question: do we CURRENTLY hold any asset that
// still tracks this company itself? "Holding" means a positive-balance, non-cash
// asset (CURRENCY and the quasi-cash FUND_OUTSTANDING_COMMITMENT don't count)
// whose tracked-entity set includes the investee.
//
// This is the same tracksInvestee classification the valuation engine uses to
// split retained value into "in the company" and "in what it became". It is
// deliberately independent of marked value: an illiquid SPV interest over the
// investee reads true even if unpriced; an acquirer's shares taken in a swap
// read false even though we still hold them.
//
// NOTE: this is the DIRECT predicate, not the Status column's. Status asks the
// wider "is anything left to come?" (holdsRetainedAssets), so the acquired case
// below — false here — still reads active in the exports.
//
// Covers the live path (true/false cases incl. the acquisition + SPV coherence
// checks the brief calls out) and cache/live agreement. Fixture toolkit mirrors
// tracks_investee_realisation.integration.test.ts.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getCoreQb, getQb, getValuationsQb } from '../../kysely';
import { Context } from '../../../services/context';
import { getInvestmentsValuation } from '../valuation';
import { warmInventoryCacheForInvestment } from '../cache';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import PriceType from '../../../generated/kysely/valuations/PriceType';
import InvestmentType from '../../../generated/kysely/valuations/InvestmentType';
import LegalEntityType from '../../../generated/kysely/valuations/LegalEntityType';
import { userPrincipal } from '../../../services/principal';

const AS_OF_DATE = new Date('2024-12-31');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

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
      .values(anyVals({ id: teamId, name: `hta-${teamId.slice(0, 8)}` }))
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
    investedAt = '2024-01-01',
  }: {
    investeeId: string;
    type?: InvestmentType;
    investedAt?: string;
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
          invested_at: new Date(investedAt),
        }),
      )
      .execute();
    return id;
  }

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

  liveValue(investmentId: string) {
    return withTeamContext(this.teamId, () =>
      getInvestmentsValuation({
        investments: [{ id: investmentId, date: null }],
        asOfDate: AS_OF_DATE,
        fxDate: AS_OF_DATE,
        targetCurrency: CurrencyIsoCode.USD,
      }),
    );
  }

  cachedValue(investmentId: string) {
    return withTeamContext(this.teamId, async () => {
      await warmInventoryCacheForInvestment({ investmentId });
      return getInvestmentsValuation({
        investments: [{ id: investmentId, date: null }],
        asOfDate: AS_OF_DATE,
        fxDate: AS_OF_DATE,
        targetCurrency: CurrencyIsoCode.USD,
        useHoldingsCache: true,
      });
    });
  }

  async cleanup(): Promise<void> {
    // Holdings cascade from events (ON DELETE CASCADE), so removing events by
    // team is enough to clear the warmed cache.
    await getQb(['inventory_delta_event'])
      .deleteFrom('inventory_delta_event')
      .where('team_id', '=', this.teamId)
      .execute();
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

describe('holdsTrackingAssets (the direct "still in the company itself?" predicate)', () => {
  let scenario: Scenario;
  afterEach(async () => {
    await scenario.cleanup();
  });

  it('live: a plain held equity position still tracks the investee', async () => {
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

    const v = await scenario.liveValue(investment);
    expect(v.holdsTrackingAssets).toBe(true);
  });

  it('live: a full secondary sale leaves nothing tracking held', async () => {
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
    // Sell every share to a secondary buyer — no held tracking asset remains.
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: cShares, num: 15, from: scenario.fundId, to: buyer },
        { assetId: usd, num: 45000, from: buyer, to: scenario.fundId },
      ],
    });

    const v = await scenario.liveValue(investment);
    expect(v.holdsTrackingAssets).toBe(false);
  });

  it('live: an SPV interest over the investee still tracks it', async () => {
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

    const v = await scenario.liveValue(investment);
    // Retained SPV interest still tracks Company C.
    expect(v.holdsTrackingAssets).toBe(true);
  });

  it('live: an acquired company tracks nothing, even though we still hold the acquirer shares', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyA = await scenario.entity({ name: 'Company A' });
    const companyB = await scenario.entity({ name: 'Company B (acquirer)' });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'Company A Shares', type: AssetType.EQUITY });
    const bShares = await scenario.asset({ issuerId: companyB, name: 'Company B Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyA });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
      ],
    });
    // Share-for-share acquisition: A-shares out, acquirer B-shares in. We still
    // HOLD B-shares, but they track B, not our investee A.
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: aShares, num: 20, from: scenario.fundId, to: companyB },
        { assetId: bShares, num: 30, from: companyB, to: scenario.fundId },
      ],
    });
    await scenario.price({ assetId: bShares, issuerId: companyB, price: 2000, date: '2024-06-01' });

    const v = await scenario.liveValue(investment);
    expect(v.holdsTrackingAssets).toBe(false);
  });

  it('cache agrees with live — held equity and acquired both round-trip', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();

    // Active: plain held equity in the investee.
    const companyC = await scenario.entity({ name: 'Company C' });
    const cShares = await scenario.asset({ issuerId: companyC, name: 'Company C Shares', type: AssetType.EQUITY });
    const heldInvestment = await scenario.investment({ investeeId: companyC });
    await scenario.transaction({
      date: '2024-01-01',
      investmentId: heldInvestment,
      transfers: [
        { assetId: usd, num: 30000, from: scenario.fundId, to: companyC },
        { assetId: cShares, num: 15, from: companyC, to: scenario.fundId },
      ],
    });
    await scenario.price({ assetId: cShares, issuerId: companyC, price: 2500, date: '2024-06-01' });

    // Exited: acquired company — acquirer shares held but track the acquirer.
    const companyA = await scenario.entity({ name: 'Company A' });
    const companyB = await scenario.entity({ name: 'Company B (acquirer)' });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'Company A Shares', type: AssetType.EQUITY });
    const bShares = await scenario.asset({ issuerId: companyB, name: 'Company B Shares', type: AssetType.EQUITY });
    const acquiredInvestment = await scenario.investment({ investeeId: companyA });
    await scenario.transaction({
      date: '2024-01-01',
      investmentId: acquiredInvestment,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
      ],
    });
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: aShares, num: 20, from: scenario.fundId, to: companyB },
        { assetId: bShares, num: 30, from: companyB, to: scenario.fundId },
      ],
    });
    await scenario.price({ assetId: bShares, issuerId: companyB, price: 2000, date: '2024-06-01' });

    const heldLive = await scenario.liveValue(heldInvestment);
    const heldCached = await scenario.cachedValue(heldInvestment);
    expect(heldLive.holdsTrackingAssets).toBe(true);
    expect(heldCached.holdsTrackingAssets).toBe(heldLive.holdsTrackingAssets);

    const acquiredLive = await scenario.liveValue(acquiredInvestment);
    const acquiredCached = await scenario.cachedValue(acquiredInvestment);
    expect(acquiredLive.holdsTrackingAssets).toBe(false);
    expect(acquiredCached.holdsTrackingAssets).toBe(acquiredLive.holdsTrackingAssets);
  });
});
