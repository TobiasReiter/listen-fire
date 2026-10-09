// Cache/live agreement for the acquisition track-through (acquirer roll-up).
//
// The cache path stores inventory deltas and re-prices them in SQL at read
// time. It historically classified EVERY held non-cash asset as unrealised, so
// the marked-to-market value of assets that no longer track the investee (an
// acquirer's shares taken in a share-for-share swap) was reported as retained
// rather than realised — under-reporting realised value versus the
// from-first-principles path.
//
// The write path bakes each held asset's tracking status into the cache
// (tracks_investee), and the read path splits the non-cash side on it:
//   - still tracks the investee  → retained in the company itself
//   - no longer tracks it        → the roll-up: retained in what it became
// Both are held positions, so both are marked live; cash is the only thing that
// is realised, and it is pinned.
//
// Same scenario as acquisition_track_through.integration.test.ts:
//   1. Fund invests $50k for 20 A-shares.
//   2. Company B acquires A: 20 A-shares out, 30 B-shares in (@ $2k PPS).
//   3. Partial exit: sell 5 B-shares for $20k cash.
// For the Company A investment: Retained = 25 illiquid B-shares marked to
// market ($50k); Realised = $20k cash; Total = $70k.
//
// This test warms the cache for that investment and asserts the cache path
// (useHoldingsCache) matches the live path on the whole split.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getCoreQb, getQb, getValuationsQb } from '../../kysely';
import { Context } from '../../../services/context';
import { getInvestmentsValuation } from '../valuation';
import { InvestmentValuation } from '../valuation/types';
import { warmInventoryCacheForInvestment } from '../cache';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import PriceType from '../../../generated/kysely/valuations/PriceType';
import InvestmentType from '../../../generated/kysely/valuations/InvestmentType';
import LegalEntityType from '../../../generated/kysely/valuations/LegalEntityType';
import { userPrincipal } from '../../../services/principal';

const TXN1_DATE = '2024-01-01';
const TXN2_DATE = '2024-06-01';
const TXN3_DATE = '2024-09-01';
const AS_OF_DATE = new Date('2024-12-31');

const FX_DATE = '2024-12-01'; // latest USD->GBP rate on or before AS_OF_DATE

const A_SHARE_PRICE = 2500;
const B_SHARE_PRICE = 2000;

// USD -> GBP, different on every date. Retained value marks at CURRENT FX while
// realised cash keeps the rate it arrived at, so the SQL read path has to reach
// both the same way the live path does — a parity dimension a same-currency
// scenario cannot exercise. (A different pair from the sibling track-through
// suite, so the global rate rows can never collide.)
const FX_TXN1 = 0.9;
const FX_TXN2 = 0.95;
const FX_TXN3 = 0.8;
const FX_NOW = 0.5;

interface Scenario {
  teamId: TeamId;
  fundId: string;
  companyAId: string;
  companyBId: string;
  aSharesAssetId: string;
  bSharesAssetId: string;
  usdAssetId: string;
  investmentXId: string; // Fund -> Company A
  investmentYId: string; // Fund -> Company B (the acquisition)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

async function seedScenario(): Promise<Scenario> {
  const teamId = randomUUID() as TeamId;
  const fundId = randomUUID();
  const companyAId = randomUUID();
  const companyBId = randomUUID();
  const aSharesAssetId = randomUUID();
  const bSharesAssetId = randomUUID();
  const usdAssetId = randomUUID();
  const usdCurrencyAssetId = randomUUID();
  const investmentXId = randomUUID();
  const investmentYId = randomUUID();
  const txn1Id = randomUUID();
  const txn2Id = randomUUID();
  const txn3Id = randomUUID();

  await getCoreQb(['team'])
    .insertInto('team')
    .values(anyVals({ id: teamId, name: `cache-acq-${teamId.slice(0, 8)}` }))
    .execute();

  await getValuationsQb(['legal_entity'])
    .insertInto('legal_entity')
    .values([
      anyVals({
        id: fundId,
        team_id: teamId,
        name: 'Our Fund',
        type: LegalEntityType.FUND,
        is_own_investing_entity: true,
      }),
      anyVals({ id: companyAId, team_id: teamId, name: 'Company A', type: LegalEntityType.COMPANY }),
      anyVals({ id: companyBId, team_id: teamId, name: 'Company B', type: LegalEntityType.COMPANY }),
    ])
    .execute();

  await getValuationsQb(['asset'])
    .insertInto('asset')
    .values([
      anyVals({
        id: aSharesAssetId,
        team_id: teamId,
        issued_by_legal_entity_id: companyAId,
        name: 'Company A Shares',
        properties: {},
        type: AssetType.EQUITY,
      }),
      anyVals({
        id: bSharesAssetId,
        team_id: teamId,
        issued_by_legal_entity_id: companyBId,
        name: 'Company B Shares',
        properties: {},
        type: AssetType.EQUITY,
      }),
      anyVals({ id: usdAssetId, team_id: teamId, name: 'USD', properties: {}, type: AssetType.CURRENCY }),
    ])
    .execute();

  await getValuationsQb(['currency_asset'])
    .insertInto('currency_asset')
    .values(
      anyVals({
        id: usdCurrencyAssetId,
        asset_id: usdAssetId,
        iso_code: CurrencyIsoCode.USD,
        name: 'US Dollar',
        symbol: '$',
        pair_order: 1,
      }),
    )
    .execute();

  await getValuationsQb(['investment'])
    .insertInto('investment')
    .values([
      anyVals({
        id: investmentXId,
        team_id: teamId,
        investor_profile_id: fundId,
        investment_profile_id: companyAId,
        type: InvestmentType.CASH,
        invested_at: new Date(TXN1_DATE),
      }),
      anyVals({
        id: investmentYId,
        team_id: teamId,
        investor_profile_id: fundId,
        investment_profile_id: companyBId,
        type: InvestmentType.EQUITY_TRANSFER,
        invested_at: new Date(TXN2_DATE),
      }),
    ])
    .execute();

  await getValuationsQb(['transaction'])
    .insertInto('transaction')
    .values([
      anyVals({ id: txn1Id, team_id: teamId, close_date: TXN1_DATE, investment_id: investmentXId }),
      anyVals({ id: txn2Id, team_id: teamId, close_date: TXN2_DATE, investment_id: investmentYId }),
      anyVals({ id: txn3Id, team_id: teamId, close_date: TXN3_DATE, investment_id: null }),
    ])
    .execute();

  await getValuationsQb(['asset_transfer'])
    .insertInto('asset_transfer')
    .values([
      anyVals({
        id: randomUUID(), team_id: teamId, transaction_id: txn1Id, date: TXN1_DATE,
        asset_id: usdAssetId, num_assets: 50000, from_legal_entity_id: fundId, to_legal_entity_id: companyAId,
      }),
      anyVals({
        id: randomUUID(), team_id: teamId, transaction_id: txn1Id, date: TXN1_DATE,
        asset_id: aSharesAssetId, num_assets: 20, from_legal_entity_id: companyAId, to_legal_entity_id: fundId,
      }),
      anyVals({
        id: randomUUID(), team_id: teamId, transaction_id: txn2Id, date: TXN2_DATE,
        asset_id: aSharesAssetId, num_assets: 20, from_legal_entity_id: fundId, to_legal_entity_id: companyBId,
      }),
      anyVals({
        id: randomUUID(), team_id: teamId, transaction_id: txn2Id, date: TXN2_DATE,
        asset_id: bSharesAssetId, num_assets: 30, from_legal_entity_id: companyBId, to_legal_entity_id: fundId,
      }),
      anyVals({
        id: randomUUID(), team_id: teamId, transaction_id: txn3Id, date: TXN3_DATE,
        asset_id: bSharesAssetId, num_assets: 5, from_legal_entity_id: fundId, to_legal_entity_id: companyBId,
      }),
      anyVals({
        id: randomUUID(), team_id: teamId, transaction_id: txn3Id, date: TXN3_DATE,
        asset_id: usdAssetId, num_assets: 20000, from_legal_entity_id: companyBId, to_legal_entity_id: fundId,
      }),
    ])
    .execute();

  await getValuationsQb(['price'])
    .insertInto('price')
    .values([
      anyVals({
        id: randomUUID(), team_id: teamId, date: TXN1_DATE, price: A_SHARE_PRICE,
        currency: CurrencyIsoCode.USD, asset_id: aSharesAssetId, legal_entity_id: companyAId,
        type: PriceType.FROM_ASSET_HOLDER,
      }),
      anyVals({
        id: randomUUID(), team_id: teamId, date: TXN2_DATE, price: B_SHARE_PRICE,
        currency: CurrencyIsoCode.USD, asset_id: bSharesAssetId, legal_entity_id: companyBId,
        type: PriceType.FROM_ASSET_HOLDER,
      }),
    ])
    .execute();

  await getValuationsQb(['exchange_rate'])
    .insertInto('exchange_rate')
    .values([
      anyVals({ id: randomUUID(), date: TXN1_DATE, from_currency: CurrencyIsoCode.USD, to_currency: CurrencyIsoCode.GBP, rate: FX_TXN1 }),
      anyVals({ id: randomUUID(), date: TXN2_DATE, from_currency: CurrencyIsoCode.USD, to_currency: CurrencyIsoCode.GBP, rate: FX_TXN2 }),
      anyVals({ id: randomUUID(), date: TXN3_DATE, from_currency: CurrencyIsoCode.USD, to_currency: CurrencyIsoCode.GBP, rate: FX_TXN3 }),
      anyVals({ id: randomUUID(), date: FX_DATE, from_currency: CurrencyIsoCode.USD, to_currency: CurrencyIsoCode.GBP, rate: FX_NOW }),
    ])
    .execute();

  return {
    teamId, fundId, companyAId, companyBId,
    aSharesAssetId, bSharesAssetId, usdAssetId,
    investmentXId, investmentYId,
  };
}

async function cleanupScenario(s: Scenario): Promise<void> {
  await getValuationsQb(['exchange_rate'])
    .deleteFrom('exchange_rate')
    .where('date', 'in', [TXN1_DATE, TXN2_DATE, TXN3_DATE, FX_DATE].map((d) => new Date(d)))
    .where('from_currency', '=', CurrencyIsoCode.USD)
    .where('to_currency', '=', CurrencyIsoCode.GBP)
    .execute();
  await getValuationsQb(['price']).deleteFrom('price').where('team_id', '=', s.teamId).execute();
  await getValuationsQb(['asset_transfer']).deleteFrom('asset_transfer').where('team_id', '=', s.teamId).execute();
  await getValuationsQb(['transaction']).deleteFrom('transaction').where('team_id', '=', s.teamId).execute();
  await getValuationsQb(['investment']).deleteFrom('investment').where('team_id', '=', s.teamId).execute();
  await getValuationsQb(['currency_asset']).deleteFrom('currency_asset').where('asset_id', '=', s.usdAssetId as never).execute();
  await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', s.teamId).execute();
  await getValuationsQb(['legal_entity']).deleteFrom('legal_entity').where('team_id', '=', s.teamId).execute();
  await getValuationsQb(['valuations_change_outbox'])
    .deleteFrom('valuations_change_outbox')
    .where('team_id', '=', s.teamId)
    .execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', s.teamId).execute();
}

async function withTeamContext<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: randomUUID(), teamId }));
  return ctx.runAsync(fn);
}

describe('cache acquisition roll-up (cache vs live agreement)', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await seedScenario();
  });

  afterAll(async () => {
    await cleanupScenario(scenario);
  });

  it('cached realised value and realised cash match the from-first-principles path', async () => {
    const live = await withTeamContext(scenario.teamId, () =>
      getInvestmentsValuation({
        investments: [{ id: scenario.investmentXId, date: new Date(TXN1_DATE) }],
        asOfDate: AS_OF_DATE,
        fxDate: AS_OF_DATE,
        targetCurrency: CurrencyIsoCode.USD,
      }),
    );

    // Warm the cache for the Company A investment, then read it back.
    const cached = await withTeamContext(scenario.teamId, async () => {
      await warmInventoryCacheForInvestment({ investmentId: scenario.investmentXId });
      return getInvestmentsValuation({
        investments: [{ id: scenario.investmentXId, date: new Date(TXN1_DATE) }],
        asOfDate: AS_OF_DATE,
        fxDate: AS_OF_DATE,
        targetCurrency: CurrencyIsoCode.USD,
        useHoldingsCache: true,
      });
    });

    // The live path is the reference. Pin its known values first so a regression
    // in EITHER path is caught.
    expect(live.realizedTransactionDateValue).toBeCloseTo(70000, 2);
    expect(live.realizedCashTransactionDateValue).toBeCloseTo(20000, 2);
    expect(live.unrealizedValuationDateValue).toBeCloseTo(0, 2);

    // Cache must agree with live on the full realised split — this is the bug
    // this change fixes (roll-up previously counted as unrealised, not realised).
    expect(cached.realizedTransactionDateValue).toBeCloseTo(live.realizedTransactionDateValue, 2);
    expect(cached.realizedValuationDateValue).toBeCloseTo(live.realizedValuationDateValue, 2);
    expect(cached.realizedCashTransactionDateValue).toBeCloseTo(
      live.realizedCashTransactionDateValue,
      2,
    );
    expect(cached.unrealizedTransactionDateValue).toBeCloseTo(live.unrealizedTransactionDateValue, 2);
    expect(cached.unrealizedValuationDateValue).toBeCloseTo(live.unrealizedValuationDateValue, 2);
    expect(cached.totalValuationDateValue).toBeCloseTo(live.totalValuationDateValue, 2);
  });

  // The two headline columns sit on different FX bases by construction, so
  // cache/live parity has an FX dimension: the SQL path has to pin every cash
  // flow to its own date's rate while marking the still-held roll-up at fxDate
  // — the same split, and the same rates, the live path picks.
  it('agrees with the live path on the realised/retained split across FX bases', async () => {
    const args = {
      investments: [{ id: scenario.investmentXId, date: new Date(TXN1_DATE) }],
      asOfDate: AS_OF_DATE,
      fxDate: AS_OF_DATE,
      targetCurrency: CurrencyIsoCode.GBP,
    };

    const live = await withTeamContext(scenario.teamId, () => getInvestmentsValuation(args));
    const cached = await withTeamContext(scenario.teamId, async () => {
      await warmInventoryCacheForInvestment({ investmentId: scenario.investmentXId });
      return getInvestmentsValuation({ ...args, useHoldingsCache: true });
    });

    // 25 B-shares still held, at the latest price and today's rate — retained.
    const expectedRetained = 25 * B_SHARE_PRICE * FX_NOW;
    // The $20k, at the rate it was received — realised, and never moving again.
    const expectedRealised = 20000 * FX_TXN3;
    const expectedTotal = expectedRetained + expectedRealised;

    expect(live.retainedValue).toBeCloseTo(expectedRetained, 2);
    expect(live.realizedCashTransactionDateValue).toBeCloseTo(expectedRealised, 2);
    expect(live.totalValuationDateValue).toBeCloseTo(expectedTotal, 2);
    // The legacy single-basis views put the cash leg on one rate for both legs,
    // so neither can reach the total — which is why neither is a headline.
    expect(live.realizedTransactionDateValue).not.toBeCloseTo(expectedTotal, 2);
    expect(live.realizedValuationDateValue).not.toBeCloseTo(expectedTotal, 2);

    expect(cached.retainedValue).toBeCloseTo(live.retainedValue, 2);
    expect(cached.realizedCashTransactionDateValue).toBeCloseTo(
      live.realizedCashTransactionDateValue,
      2,
    );
    expect(cached.realizedValuationDateValue).toBeCloseTo(live.realizedValuationDateValue, 2);
    expect(cached.realizedTransactionDateValue).toBeCloseTo(live.realizedTransactionDateValue, 2);
    expect(cached.unrealizedValuationDateValue).toBeCloseTo(live.unrealizedValuationDateValue, 2);
    expect(cached.totalValuationDateValue).toBeCloseTo(live.totalValuationDateValue, 2);
    expect(cached.investedTransactionDateValue).toBeCloseTo(
      live.investedTransactionDateValue ?? 0,
      2,
    );
    // Status agrees too: B-shares are still held, so there is something left to
    // come on both paths.
    expect(live.holdsRetainedAssets).toBe(true);
    expect(cached.holdsRetainedAssets).toBe(live.holdsRetainedAssets);

    // Direct realised too: the $20k came out of the acquirer's stock, two steps
    // from Company A, so nothing here was paid by Company A itself. The cache is
    // degree-bucketed, so it reaches the same zero rather than reporting unknown.
    expect(live.realisedDirectValue).toBeCloseTo(0, 2);
    expect(cached.realisedDirectValue).toBeCloseTo(live.realisedDirectValue, 2);
  });
});

// ---------------------------------------------------------------------------
// Degree parity: the cache stores degree-bucketed lots, so EVERY atom the walk
// reports must come back identical from the cached read — including the direct
// realised leg, which the pre-L4 cache could not answer at all.
//
// The fixture above only ever produces cash two steps from Company A, so it
// cannot tell "direct realised is right" from "direct realised is zero". This
// one adds both kinds of dividend to the same share-for-share shape:
//
//   1. 2024-01-01  invest $50k for 20 A-shares
//   2. 2024-03-01  Company A pays a $6k dividend on the A-shares      → degree 1
//   3. 2024-06-01  Company B acquires A: 20 A out, 30 B in
//   4. 2024-08-01  Company B pays a $3k dividend on the B-shares      → degree 2
//   5. 2024-09-01  sell 5 B-shares for $20k                           → degree 2
//
// Direct realised is the $6k alone; full realised is all three, each pinned at
// its own date's rate; retained is the 25 B-shares still held, live.
// ---------------------------------------------------------------------------

const DIV_A_DATE = '2024-03-01';
const DIV_B_DATE = '2024-08-01';
const FX_DIV_A = 0.85;
const FX_DIV_B = 0.7;
const DIV_A_AMOUNT = 6000;
const DIV_B_AMOUNT = 3000;

// A different currency pair again, so these rate rows can never collide with
// the suites that share this global table.
const DEGREE_FX_DATES = [TXN1_DATE, DIV_A_DATE, TXN2_DATE, DIV_B_DATE, TXN3_DATE, FX_DATE];

interface DegreeScenario extends Scenario {
  divATxnId: string;
  divBTxnId: string;
}

async function seedDegreeScenario(): Promise<DegreeScenario> {
  const base = await seedScenario();

  const divATxnId = randomUUID();
  const divBTxnId = randomUUID();

  // A dividend carries the holding it was paid on. That recorded rights edge is
  // the ONLY difference between these two payments, and it alone decides
  // degree 1 (Company A itself paid) from degree 2 (its acquirer did).
  await getValuationsQb(['transaction'])
    .insertInto('transaction')
    .values([
      anyVals({
        id: divATxnId,
        team_id: base.teamId,
        close_date: DIV_A_DATE,
        investment_id: null,
        due_to_rights_from_asset_id: base.aSharesAssetId,
      }),
      anyVals({
        id: divBTxnId,
        team_id: base.teamId,
        close_date: DIV_B_DATE,
        investment_id: null,
        due_to_rights_from_asset_id: base.bSharesAssetId,
      }),
    ])
    .execute();

  await getValuationsQb(['asset_transfer'])
    .insertInto('asset_transfer')
    .values([
      anyVals({
        id: randomUUID(), team_id: base.teamId, transaction_id: divATxnId, date: DIV_A_DATE,
        asset_id: base.usdAssetId, num_assets: DIV_A_AMOUNT,
        from_legal_entity_id: base.companyAId, to_legal_entity_id: base.fundId,
      }),
      anyVals({
        id: randomUUID(), team_id: base.teamId, transaction_id: divBTxnId, date: DIV_B_DATE,
        asset_id: base.usdAssetId, num_assets: DIV_B_AMOUNT,
        from_legal_entity_id: base.companyBId, to_legal_entity_id: base.fundId,
      }),
    ])
    .execute();

  await getValuationsQb(['exchange_rate'])
    .insertInto('exchange_rate')
    .values([
      anyVals({ id: randomUUID(), date: DIV_A_DATE, from_currency: CurrencyIsoCode.USD, to_currency: CurrencyIsoCode.GBP, rate: FX_DIV_A }),
      anyVals({ id: randomUUID(), date: DIV_B_DATE, from_currency: CurrencyIsoCode.USD, to_currency: CurrencyIsoCode.GBP, rate: FX_DIV_B }),
    ])
    .execute();

  return { ...base, divATxnId, divBTxnId };
}

async function cleanupDegreeScenario(s: DegreeScenario): Promise<void> {
  await getValuationsQb(['exchange_rate'])
    .deleteFrom('exchange_rate')
    .where('date', 'in', DEGREE_FX_DATES.map((d) => new Date(d)))
    .where('from_currency', '=', CurrencyIsoCode.USD)
    .where('to_currency', '=', CurrencyIsoCode.GBP)
    .execute();
  await cleanupScenario(s);
}

/** Every field of the valuation, compared cache-on vs cache-off. Asserting on
 *  the key set as well means a new atom cannot slip past this test unchecked. */
function expectIdenticalValuations(cached: InvestmentValuation, live: InvestmentValuation): void {
  expect(Object.keys(cached).sort()).toEqual(Object.keys(live).sort());
  for (const key of Object.keys(live) as (keyof InvestmentValuation)[]) {
    const liveValue = live[key];
    const cachedValue = cached[key];
    if (typeof liveValue === 'number' && typeof cachedValue === 'number') {
      expect([key, Number(cachedValue.toFixed(2))]).toEqual([key, Number(liveValue.toFixed(2))]);
    } else {
      expect([key, cachedValue]).toEqual([key, liveValue]);
    }
  }
}

describe('degree-bucketed cache (every atom identical with the cache on or off)', () => {
  let scenario: DegreeScenario;

  beforeAll(async () => {
    scenario = await seedDegreeScenario();
  });

  afterAll(async () => {
    await cleanupDegreeScenario(scenario);
  });

  const runBothPaths = async (targetCurrency: CurrencyIsoCode) => {
    const args = {
      investments: [{ id: scenario.investmentXId, date: new Date(TXN1_DATE) }],
      asOfDate: AS_OF_DATE,
      fxDate: AS_OF_DATE,
      targetCurrency,
    };
    const live = await withTeamContext(scenario.teamId, () => getInvestmentsValuation(args));
    const cached = await withTeamContext(scenario.teamId, async () => {
      await warmInventoryCacheForInvestment({ investmentId: scenario.investmentXId });
      return getInvestmentsValuation({ ...args, useHoldingsCache: true });
    });
    return { live, cached };
  };

  it('reports the five atoms identically in the investment currency', async () => {
    const { live, cached } = await runBothPaths(CurrencyIsoCode.USD);

    // Pin the live path first, so a regression in EITHER path is caught rather
    // than the two agreeing on a wrong number.
    expect(live.investedTransactionDateValue).toBeCloseTo(50000, 2);
    expect(live.realizedCashTransactionDateValue).toBeCloseTo(
      DIV_A_AMOUNT + DIV_B_AMOUNT + 20000,
      2,
    );
    // Only Company A's own dividend was paid by Company A.
    expect(live.realisedDirectValue).toBeCloseTo(DIV_A_AMOUNT, 2);
    expect(live.retainedValue).toBeCloseTo(25 * B_SHARE_PRICE, 2);
    // Nothing is left in Company A itself — the position is all acquirer stock.
    expect(live.unrealizedValuationDateValue).toBeCloseTo(0, 2);
    expect(live.totalValuationDateValue).toBeCloseTo(
      25 * B_SHARE_PRICE + DIV_A_AMOUNT + DIV_B_AMOUNT + 20000,
      2,
    );

    expectIdenticalValuations(cached, live);
  });

  it('reports them identically across FX bases, direct realised included', async () => {
    const { live, cached } = await runBothPaths(CurrencyIsoCode.GBP);

    // Each cash flow keeps the rate it arrived at; the still-held stock marks at
    // today's. Direct realised is a pinned fact like the rest of realised.
    expect(live.realisedDirectValue).toBeCloseTo(DIV_A_AMOUNT * FX_DIV_A, 2);
    expect(live.realizedCashTransactionDateValue).toBeCloseTo(
      DIV_A_AMOUNT * FX_DIV_A + DIV_B_AMOUNT * FX_DIV_B + 20000 * FX_TXN3,
      2,
    );
    expect(live.retainedValue).toBeCloseTo(25 * B_SHARE_PRICE * FX_NOW, 2);
    // Direct realised is a strict part of full realised, never the whole of it.
    expect(live.realisedDirectValue).toBeLessThan(live.realizedCashTransactionDateValue);

    expectIdenticalValuations(cached, live);
  });

  it('is unchanged by recomputing it — the same rows, the same answers', async () => {
    const first = await withTeamContext(scenario.teamId, async () => {
      await warmInventoryCacheForInvestment({ investmentId: scenario.investmentXId });
      return readCacheRows(scenario);
    });
    const second = await withTeamContext(scenario.teamId, async () => {
      await warmInventoryCacheForInvestment({ investmentId: scenario.investmentXId });
      return readCacheRows(scenario);
    });

    expect(second).toEqual(first);
    // The rights-linked dividends are the only degree-1 cash, so the cache must
    // hold a degree-1 bucket — proof the degree survived the write, not just the
    // read projection.
    expect(first.some((row) => row.degree === 1 && row.is_inflow)).toBe(true);
    expect(first.some((row) => row.degree === 2 && row.is_inflow)).toBe(true);
  });
});

async function readCacheRows(s: DegreeScenario) {
  const rows = await getQb(['inventory_delta_event', 'inventory_delta_holding'])
    .selectFrom('inventory_delta_event')
    .innerJoin(
      'inventory_delta_holding',
      'inventory_delta_holding.event_id',
      'inventory_delta_event.id',
    )
    .select([
      'inventory_delta_event.close_date',
      'inventory_delta_holding.asset_id',
      'inventory_delta_holding.asset_type',
      'inventory_delta_holding.degree',
      'inventory_delta_holding.is_inflow',
      'inventory_delta_holding.num_assets',
      'inventory_delta_holding.tracks_investee',
    ])
    .where('inventory_delta_event.investment_id', '=', s.investmentXId as never)
    .execute();
  return rows
    .map((r) => ({ ...r, close_date: String(r.close_date) }))
    .sort((a, b) =>
      `${a.close_date}${a.asset_id}${a.degree}${a.is_inflow}`.localeCompare(
        `${b.close_date}${b.asset_id}${b.degree}${b.is_inflow}`,
      ),
    );
}
