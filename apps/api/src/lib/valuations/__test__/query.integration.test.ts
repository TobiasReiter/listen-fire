// The valuation query API — every portfolio metric as a slice of one set of
// atoms. The fixture is the share-for-share deal the whole model was designed
// around: a partial swap leaves a degree-0 remainder next to degree-1 acquirer
// stock, the deal's cash component is degree-1 proceeds, and a dividend from
// the acquirer is degree-2 cash.
//
// What this pins beyond the arithmetic is the tense rule: cash is converted at
// the rate on the day it moved and never moves again, held positions are marked
// at the analysis date — which is why the surface takes no FX date at all.
//
// Fixture toolkit mirrors lots.integration.test.ts, plus prices and FX.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExchangeRateId } from '../../../generated/kysely/valuations/ExchangeRate';
import type { Principal } from 'principal';

import { getCoreQb, getValuationsQb } from '../../kysely';
import { Context } from '../../../services/context';
import { userPrincipal } from '../../../services/principal';
import { queryValuations, ValuationQueryInput, ValuationQueryRow } from '../query';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import InvestmentType from '../../../generated/kysely/valuations/InvestmentType';
import LegalEntityType from '../../../generated/kysely/valuations/LegalEntityType';
import PriceType from '../../../generated/kysely/valuations/PriceType';

const AS_OF_DATE = new Date('2022-12-31');
const A_SHARE_PRICE = 3000;
const B_SHARE_PRICE = 2000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

class Scenario {
  readonly teamId: TeamId;
  readonly fundId: string;
  private readonly usdAssetIds = new Set<string>();
  private readonly exchangeRateIds = new Set<string>();

  private constructor(teamId: TeamId, fundId: string) {
    this.teamId = teamId;
    this.fundId = fundId;
  }

  static async create(): Promise<Scenario> {
    const teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      .values(anyVals({ id: teamId, name: `qry-${teamId.slice(0, 8)}` }))
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
  }: {
    id?: string;
    name: string;
    type?: LegalEntityType;
    ownInvesting?: boolean;
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
  }: {
    id?: string;
    issuerId: string;
    name: string;
    type: AssetType;
  }): Promise<string> {
    await getValuationsQb(['asset'])
      .insertInto('asset')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          issued_by_legal_entity_id: issuerId,
          name,
          properties: {},
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
    investedAt,
    type = InvestmentType.CASH,
  }: {
    investeeId: string;
    investedAt?: string;
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
          invested_at: investedAt ?? null,
          type,
        }),
      )
      .execute();
    return id;
  }

  async transaction({
    date,
    investmentId = null,
    dueToRightsFromAssetId = null,
    transfers,
  }: {
    date: string;
    investmentId?: string | null;
    dueToRightsFromAssetId?: string | null;
    transfers: { assetId: string; num: number; from: string; to: string }[];
  }): Promise<string> {
    const id = randomUUID();
    await getValuationsQb(['transaction'])
      .insertInto('transaction')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          close_date: date,
          investment_id: investmentId,
          due_to_rights_from_asset_id: dueToRightsFromAssetId,
        }),
      )
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

  /** USD→EUR on one date. The table is global, so rows are tracked by id and
   *  torn down individually. */
  async fx({ date, rate }: { date: string; rate: number }): Promise<void> {
    const id = randomUUID();
    await getValuationsQb(['exchange_rate'])
      .insertInto('exchange_rate')
      .values(
        anyVals({
          id,
          date,
          from_currency: CurrencyIsoCode.USD,
          to_currency: CurrencyIsoCode.EUR,
          rate,
        }),
      )
      .execute();
    this.exchangeRateIds.add(id);
  }

  query(input: Partial<ValuationQueryInput> = {}) {
    return withTeamContext(this.teamId, () =>
      queryValuations({
        currency: CurrencyIsoCode.USD,
        asOfDate: AS_OF_DATE,
        ...input,
      }),
    );
  }

  async cleanup(): Promise<void> {
    if (this.exchangeRateIds.size) {
      await getValuationsQb(['exchange_rate'])
        .deleteFrom('exchange_rate')
        .where('id', 'in', Array.from(this.exchangeRateIds) as ExchangeRateId[])
        .execute();
    }
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

/** A machine principal (D2): team-scoped, no `userId` — the shape an api key
 *  or the static single-tenant stub authenticates as. `ctx.user.teamId` throws
 *  "Missing user" for exactly this principal; the engine reads must go through
 *  `currentPrincipal().teamId` instead so this shape works. */
function withMachineContext<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
  const ctx = new Context();
  const principal: Principal = {
    teamId,
    access: 'write',
    scopes: ['*'],
    pinnedTeamId: null,
  };
  ctx.bindPrincipal(principal);
  return ctx.runAsync(fn);
}

interface ShareForShare {
  investment: string;
  companyA: string;
  companyB: string;
  aShares: string;
  bShares: string;
}

/**
 * $50k for 20 A-shares; half the position swapped for 15 B-shares plus $5k
 * cash; then a $4k dividend from B on the stock it issued in the swap.
 *
 * So: 10 A-shares retained at degree 0, 15 B-shares retained at degree 1, $5k
 * realised at degree 1, $4k realised at degree 2.
 */
async function seedShareForShare(scenario: Scenario): Promise<ShareForShare & { usd: string }> {
  const usd = await scenario.usd();
  const companyA = await scenario.entity({ name: 'Company A' });
  const companyB = await scenario.entity({ name: 'Company B' });
  const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
  const bShares = await scenario.asset({ issuerId: companyB, name: 'B Shares', type: AssetType.EQUITY });
  const investment = await scenario.investment({ investeeId: companyA, investedAt: '2022-01-01' });

  await scenario.transaction({
    date: '2022-01-01',
    investmentId: investment,
    transfers: [
      { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
      { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
    ],
  });
  await scenario.transaction({
    date: '2022-06-01',
    transfers: [
      { assetId: aShares, num: 10, from: scenario.fundId, to: companyB },
      { assetId: bShares, num: 15, from: companyB, to: scenario.fundId },
      { assetId: usd, num: 5000, from: companyB, to: scenario.fundId },
    ],
  });
  // Paid by the acquirer, on the stock we took for Company A — the rights edge
  // the dividend command now stamps.
  await scenario.transaction({
    date: '2022-08-01',
    dueToRightsFromAssetId: bShares,
    transfers: [{ assetId: usd, num: 4000, from: companyB, to: scenario.fundId }],
  });

  await scenario.price({ assetId: aShares, issuerId: companyA, price: A_SHARE_PRICE, date: '2022-01-02' });
  await scenario.price({ assetId: bShares, issuerId: companyB, price: B_SHARE_PRICE, date: '2022-06-02' });

  return { investment, companyA, companyB, aShares, bShares, usd };
}

const only = (rows: ValuationQueryRow[]): ValuationQueryRow => {
  expect(rows).toHaveLength(1);
  return rows[0];
};

describe('valuation query — the five atoms of the share-for-share fixture', () => {
  let scenario: Scenario;
  let fixture: ShareForShare & { usd: string };

  beforeEach(async () => {
    scenario = await Scenario.create();
    fixture = await seedShareForShare(scenario);
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it('reads invested, full realised and direct realised off the cash lots', async () => {
    const selector = { investments: { ids: [fixture.investment] } };

    const invested = await scenario.query({ ...selector, leafType: 'cash', cashSign: 'paid' });
    expect(only(invested.rows).cashPaid).toBeCloseTo(50000, 6);

    const fullRealised = await scenario.query({
      ...selector,
      leafType: 'cash',
      cashSign: 'received',
    });
    expect(only(fullRealised.rows).cashReceived).toBeCloseTo(9000, 6);

    const directRealised = await scenario.query({
      ...selector,
      leafType: 'cash',
      cashSign: 'received',
      degree: { eq: 1 },
    });
    expect(only(directRealised.rows).cashReceived).toBeCloseTo(5000, 6);

    const indirectRealised = await scenario.query({
      ...selector,
      leafType: 'cash',
      cashSign: 'received',
      degree: { min: 2 },
    });
    expect(only(indirectRealised.rows).cashReceived).toBeCloseTo(4000, 6);
  });

  it('reads full and direct retained off the held lots', async () => {
    const selector = { investments: { ids: [fixture.investment] }, leafType: 'held' as const };

    const fullRetained = await scenario.query(selector);
    expect(only(fullRetained.rows).heldValue).toBeCloseTo(10 * A_SHARE_PRICE + 15 * B_SHARE_PRICE, 6);

    const directRetained = await scenario.query({ ...selector, degree: { eq: 0 } });
    expect(only(directRetained.rows).heldValue).toBeCloseTo(10 * A_SHARE_PRICE, 6);
  });

  it('answers acquirer exposure by grouping held value under the entity each asset tracks', async () => {
    const { rows } = await scenario.query({
      investments: { ids: [fixture.investment] },
      leafType: 'held',
      groupBy: ['trackedEntity'],
    });

    const byEntity = new Map(
      rows.map((row) => [row.groupKey.trackedEntity?.id ?? null, row.heldValue]),
    );
    expect(byEntity.get(fixture.companyA)).toBeCloseTo(10 * A_SHARE_PRICE, 6);
    expect(byEntity.get(fixture.companyB)).toBeCloseTo(15 * B_SHARE_PRICE, 6);
  });

  it('slices realised cash by the window the payments fell in', async () => {
    const beforeTheDividend = await scenario.query({
      investments: { ids: [fixture.investment] },
      leafType: 'cash',
      cashSign: 'received',
      factWindow: { to: new Date('2022-07-01') },
    });
    expect(only(beforeTheDividend.rows).cashReceived).toBeCloseTo(5000, 6);

    const afterTheSwap = await scenario.query({
      investments: { ids: [fixture.investment] },
      leafType: 'cash',
      cashSign: 'received',
      factWindow: { from: new Date('2022-07-01') },
    });
    expect(only(afterTheSwap.rows).cashReceived).toBeCloseTo(4000, 6);
  });

  it('separates the acquirer dividend from the deal cash by degree', async () => {
    const { rows } = await scenario.query({
      investments: { ids: [fixture.investment] },
      leafType: 'cash',
      cashSign: 'received',
      groupBy: ['degree', 'asset'],
    });

    const byDegree = new Map(rows.map((row) => [row.groupKey.degree, row.cashReceived]));
    expect(byDegree.get(1)).toBeCloseTo(5000, 6);
    expect(byDegree.get(2)).toBeCloseTo(4000, 6);
    expect(rows.every((row) => row.groupKey.asset?.id === fixture.usd)).toBe(true);
  });

  it('groups by company and investment, and finds the investments by filter', async () => {
    const { rows } = await scenario.query({
      investments: {
        investingEntityIds: [scenario.fundId],
        investedFrom: new Date('2021-12-31'),
        investedTo: new Date('2022-02-01'),
      },
      groupBy: ['company', 'investment'],
    });

    const row = only(rows);
    expect(row.groupKey.company).toEqual({ id: fixture.companyA, name: 'Company A' });
    expect(row.groupKey.investment?.id).toEqual(fixture.investment);
    expect(row.cashPaid).toBeCloseTo(50000, 6);
    expect(row.cashReceived).toBeCloseTo(9000, 6);
    expect(row.heldValue).toBeCloseTo(10 * A_SHARE_PRICE + 15 * B_SHARE_PRICE, 6);
  });

  it('pins each cash lot at its own date and marks held value at the analysis date', async () => {
    await scenario.fx({ date: '2022-01-01', rate: 0.5 });
    await scenario.fx({ date: '2022-06-01', rate: 0.8 });
    await scenario.fx({ date: '2022-08-01', rate: 2 });
    await scenario.fx({ date: '2022-12-31', rate: 4 });

    const row = only(
      (await scenario.query({ investments: { ids: [fixture.investment] }, currency: CurrencyIsoCode.EUR }))
        .rows,
    );

    // Facts, each at the rate on the day it moved — no analysis-date rate in sight.
    expect(row.cashPaid).toBeCloseTo(50000 * 0.5, 6);
    expect(row.cashReceived).toBeCloseTo(5000 * 0.8 + 4000 * 2, 6);
    // Live, at the analysis date's price and the analysis date's rate.
    expect(row.heldValue).toBeCloseTo((10 * A_SHARE_PRICE + 15 * B_SHARE_PRICE) * 4, 6);
  });
});

describe('valuation query — unpriced holdings', () => {
  let scenario: Scenario;
  afterEach(async () => {
    await scenario.cleanup();
  });

  it('reports an asset it cannot value instead of counting it as zero', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyC = await scenario.entity({ name: 'Company C' });
    const companyD = await scenario.entity({ name: 'Company D' });
    const cShares = await scenario.asset({ issuerId: companyC, name: 'C Shares', type: AssetType.EQUITY });
    const dShares = await scenario.asset({ issuerId: companyD, name: 'D Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyC });

    await scenario.transaction({
      date: '2022-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 30000, from: scenario.fundId, to: companyC },
        { assetId: cShares, num: 15, from: companyC, to: scenario.fundId },
      ],
    });
    // Swapped for stock nobody has ever priced, and no cash changed hands to
    // imply a price either.
    await scenario.transaction({
      date: '2022-06-01',
      transfers: [
        { assetId: cShares, num: 15, from: scenario.fundId, to: companyD },
        { assetId: dShares, num: 10, from: companyD, to: scenario.fundId },
      ],
    });

    const result = await scenario.query({
      investments: { ids: [investment] },
      leafType: 'held',
    });

    expect(only(result.rows).heldValue).toEqual(0);
    expect(result.warnings).toEqual([expect.stringContaining('No price found for D Shares')]);
  });
});

describe('valuation query — userless (machine) principal', () => {
  let scenario: Scenario;
  let fixture: ShareForShare & { usd: string };

  beforeEach(async () => {
    scenario = await Scenario.create();
    fixture = await seedShareForShare(scenario);
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it('reads held value under a machine principal, exercising the same query, lots, and price paths a userless api key would', async () => {
    const result = await withMachineContext(scenario.teamId, () =>
      queryValuations({
        currency: CurrencyIsoCode.USD,
        asOfDate: AS_OF_DATE,
        investments: { ids: [fixture.investment] },
        leafType: 'held',
      }),
    );

    expect(only(result.rows).heldValue).toBeCloseTo(10 * A_SHARE_PRICE + 15 * B_SHARE_PRICE, 6);
  });
});
