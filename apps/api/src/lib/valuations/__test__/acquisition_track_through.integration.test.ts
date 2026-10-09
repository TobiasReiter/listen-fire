// Acquisition track-through — the consideration's value must follow the
// original investment, and land in the column its tense says it belongs in.
//
// Worked example (this test):
//   1. Fund invests $50k for 20 shares in Company A.
//   2. Company B acquires Company A: we give up our 20 A-shares and receive
//      30 B-shares. B-shares have a price of $2k/share. The acquisition is
//      recorded as an Investment object IN THE ACQUIRER (transaction carries
//      that investment_id) — this is what used to terminate the track-through.
//   3. We partially exit B: sell 5 B-shares for $20k cash.
//
// The whole $70k traces back to the Company A investment and is counted there
// exactly once. How it splits is the tense rule: the $20k is cash, a fact,
// pinned at the rate it arrived at; the 25 B-shares are a position we still
// hold, so they float — retained, not realised, even though they no longer
// track Company A and even though they are illiquid.
//
//   Company A investment  →  Invested $50k · Retained $50k · Realised $20k
//                            Total $70k · MOIC 1.4x
//
// Nothing is retained IN COMPANY A itself: the direct retained leg is $0, which
// is what "we are out of Company A" means. "Is there anything left to come?" is
// a different question, and its answer is yes — we still hold the B-shares.
//
// NOTE: the acquirer-side investment (our new holding in B) is deliberately NOT
// asserted here — the engine already values it the way it should (invested
// undefined, B-shares as its own retained position). The bug this fixture was
// built for is purely the acquired-side investment's severed track-through.

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

const TXN1_DATE = '2024-01-01'; // invest $50k for 20 A-shares
const TXN2_DATE = '2024-06-01'; // B acquires A: 20 A-shares out, 30 B-shares in
const TXN3_DATE = '2024-09-01'; // partial exit: 5 B-shares out, $20k in
const AS_OF_DATE = new Date('2024-12-31');

const FX_DATE = '2024-12-01'; // latest USD->EUR rate on or before AS_OF_DATE

const A_SHARE_PRICE = 2500; // 50000 / 20 at entry
const B_SHARE_PRICE = 2000; // PPS of the acquirer's shares

// USD -> EUR, deliberately different on every date so the pinned-FX and
// current-FX readings of the same bucket cannot coincide.
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
  investmentYId: string; // Fund -> Company B (the acquisition / share-for-share)
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
    .values(anyVals({ id: teamId, name: `acq-${teamId.slice(0, 8)}` }))
    .execute();

  // Legal entities: our fund (own investing entity) + two plain companies.
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
      anyVals({
        id: companyAId,
        team_id: teamId,
        name: 'Company A',
        type: LegalEntityType.COMPANY,
      }),
      anyVals({
        id: companyBId,
        team_id: teamId,
        name: 'Company B',
        type: LegalEntityType.COMPANY,
      }),
    ])
    .execute();

  // Assets: A-shares (issued by A), B-shares (issued by B), USD currency asset.
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
      anyVals({
        id: usdAssetId,
        team_id: teamId,
        name: 'USD',
        properties: {},
        type: AssetType.CURRENCY,
      }),
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

  // Two investments: X = Fund->A (cash), Y = Fund->B (the share-for-share swap).
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

  // Transactions.
  await getValuationsQb(['transaction'])
    .insertInto('transaction')
    .values([
      anyVals({ id: txn1Id, team_id: teamId, close_date: TXN1_DATE, investment_id: investmentXId }),
      // The acquisition transaction carries the ACQUIRER's investment id (Y).
      anyVals({ id: txn2Id, team_id: teamId, close_date: TXN2_DATE, investment_id: investmentYId }),
      // The partial exit is a plain secondary sale — no new investment.
      anyVals({ id: txn3Id, team_id: teamId, close_date: TXN3_DATE, investment_id: null }),
    ])
    .execute();

  // Asset transfers. flowtype is derived from whether the receiving entity is
  // our own investing entity, so direction matters: shares issued TO the fund
  // are inflows, cash paid BY the fund is an outflow, etc.
  await getValuationsQb(['asset_transfer'])
    .insertInto('asset_transfer')
    .values([
      // TXN1: pay $50k (F->A), receive 20 A-shares (A->F).
      anyVals({
        id: randomUUID(), team_id: teamId, transaction_id: txn1Id, date: TXN1_DATE,
        asset_id: usdAssetId, num_assets: 50000, from_legal_entity_id: fundId, to_legal_entity_id: companyAId,
      }),
      anyVals({
        id: randomUUID(), team_id: teamId, transaction_id: txn1Id, date: TXN1_DATE,
        asset_id: aSharesAssetId, num_assets: 20, from_legal_entity_id: companyAId, to_legal_entity_id: fundId,
      }),
      // TXN2: give up 20 A-shares (F->B), receive 30 B-shares (B->F).
      anyVals({
        id: randomUUID(), team_id: teamId, transaction_id: txn2Id, date: TXN2_DATE,
        asset_id: aSharesAssetId, num_assets: 20, from_legal_entity_id: fundId, to_legal_entity_id: companyBId,
      }),
      anyVals({
        id: randomUUID(), team_id: teamId, transaction_id: txn2Id, date: TXN2_DATE,
        asset_id: bSharesAssetId, num_assets: 30, from_legal_entity_id: companyBId, to_legal_entity_id: fundId,
      }),
      // TXN3: sell 5 B-shares (F->B), receive $20k (B->F).
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

  // Prices: A-shares at entry, B-shares at the acquirer's PPS.
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

  // FX. The table is global (no team scoping), so the dates are pinned to this
  // scenario's timeline and torn down again in cleanup.
  await getValuationsQb(['exchange_rate'])
    .insertInto('exchange_rate')
    .values([
      anyVals({ id: randomUUID(), date: TXN1_DATE, from_currency: CurrencyIsoCode.USD, to_currency: CurrencyIsoCode.EUR, rate: FX_TXN1 }),
      anyVals({ id: randomUUID(), date: TXN2_DATE, from_currency: CurrencyIsoCode.USD, to_currency: CurrencyIsoCode.EUR, rate: FX_TXN2 }),
      anyVals({ id: randomUUID(), date: TXN3_DATE, from_currency: CurrencyIsoCode.USD, to_currency: CurrencyIsoCode.EUR, rate: FX_TXN3 }),
      anyVals({ id: randomUUID(), date: FX_DATE, from_currency: CurrencyIsoCode.USD, to_currency: CurrencyIsoCode.EUR, rate: FX_NOW }),
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
    .where('to_currency', '=', CurrencyIsoCode.EUR)
    .execute();
  await getValuationsQb(['price']).deleteFrom('price').where('team_id', '=', s.teamId).execute();
  await getValuationsQb(['asset_transfer']).deleteFrom('asset_transfer').where('team_id', '=', s.teamId).execute();
  await getValuationsQb(['transaction']).deleteFrom('transaction').where('team_id', '=', s.teamId).execute();
  await getValuationsQb(['investment']).deleteFrom('investment').where('team_id', '=', s.teamId).execute();
  await getValuationsQb(['currency_asset']).deleteFrom('currency_asset').where('asset_id', '=', s.usdAssetId as never).execute();
  await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', s.teamId).execute();
  await getValuationsQb(['legal_entity']).deleteFrom('legal_entity').where('team_id', '=', s.teamId).execute();
  // Every valuations write AND delete above fires the audit trigger that
  // populates the change-outbox, whose rows FK the team — so drain it LAST,
  // after all domain deletes, immediately before removing the team.
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

describe('acquisition track-through (share-for-share)', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await seedScenario();
  });

  afterAll(async () => {
    await cleanupScenario(scenario);
  });

  it('carries the full consideration through to the acquired-company investment', async () => {
    const valuation = await withTeamContext(scenario.teamId, () =>
      getInvestmentsValuation({
        investments: [{ id: scenario.investmentXId, date: new Date(TXN1_DATE) }],
        asOfDate: AS_OF_DATE,
        fxDate: AS_OF_DATE,
        targetCurrency: CurrencyIsoCode.USD,
      }),
    );

    const invested = valuation.investedTransactionDateValue;
    // The legacy single-basis view: cash proceeds and the still-held roll-up
    // added together. Kept for FX attribution, and the whole $70k is in it.
    const cashAndRollUp = valuation.realizedTransactionDateValue;
    const realisedCash = valuation.realizedCashTransactionDateValue;
    const directRetained = valuation.unrealizedValuationDateValue;
    const total = valuation.totalValuationDateValue;
    const moic = invested ? total / invested : null;

    // Invested $50k of cash.
    expect(invested).toBeCloseTo(50000, 2);
    // Nothing tracks Company A any more → nothing retained IN Company A.
    expect(directRetained).toBeCloseTo(0, 2);
    // The whole consideration traces through: $20k cash out + 25 illiquid
    // B-shares marked to market at $2k = $50k.
    expect(cashAndRollUp).toBeCloseTo(70000, 2);
    expect(moic).toBeCloseTo(1.4, 3);

    // Realised is the cash-only leg: only the $20k we actually took out (via
    // the partial B-share exit). The $50k of B-shares we still hold is
    // retained, not realised.
    expect(realisedCash).toBeCloseTo(20000, 2);
    expect(cashAndRollUp - realisedCash).toBeCloseTo(50000, 2);
  });

  // The tense rule, reported in EUR against a USD book. No column mixes tenses:
  //   - realised is the $20k we took out and nothing else, at the rate the day
  //     it arrived — the fund may have distributed it there and then, so what
  //     we got is what we got, and it never moves again;
  //   - the 25 B-shares we still hold are a live position and stay retained:
  //     latest price, today's rate. Holding an acquirer's stock is not an exit.
  // Cost basis is untouched by either: it stays at the rate we actually paid.
  //
  // Supersedes the hybrid realised mark (3d8755c49): the B-share leg used to be
  // folded into realised at a live FX rate, making one column half fact and
  // half forecast. Total Value is unchanged by the move — it is the same two
  // legs added in the same currency, just filed under the right tenses.
  it('pins realised cash at receipt FX and keeps held consideration retained and live', async () => {
    const valuation = await withTeamContext(scenario.teamId, () =>
      getInvestmentsValuation({
        investments: [{ id: scenario.investmentXId, date: new Date(TXN1_DATE) }],
        asOfDate: AS_OF_DATE,
        fxDate: AS_OF_DATE,
        targetCurrency: CurrencyIsoCode.EUR,
      }),
    );

    const expectedRetained = 25 * B_SHARE_PRICE * FX_NOW;
    const expectedRealised = 20000 * FX_TXN3;
    const expectedTotal = expectedRetained + expectedRealised;
    const expectedInvested = 50000 * FX_TXN1;

    // Realised is cash only, pinned. The B-shares are NOT in it.
    expect(valuation.realizedCashTransactionDateValue).toBeCloseTo(expectedRealised, 2);
    // …and all of it came from Company B, not Company A — the direct leg is
    // empty because Company A itself never paid us a penny.
    expect(valuation.realisedDirectValue).toBeCloseTo(0, 2);

    // Retained holds the whole consideration, live. Nothing tracks Company A
    // any more, so the direct leg is empty and the full leg carries it all.
    expect(valuation.retainedValue).toBeCloseTo(expectedRetained, 2);
    expect(valuation.unrealizedValuationDateValue).toBeCloseTo(0, 2);
    // Still holding B-shares → there is something left to come.
    expect(valuation.holdsRetainedAssets).toBe(true);
    expect(valuation.holdsTrackingAssets).toBe(false);

    expect(valuation.investedTransactionDateValue).toBeCloseTo(expectedInvested, 2);

    // Total = full retained + full realised, and the headline is invariant
    // under the split that moved the B-shares from one column to the other.
    expect(valuation.totalValuationDateValue).toBeCloseTo(
      valuation.retainedValue + valuation.realizedCashTransactionDateValue,
      2,
    );
    expect(valuation.totalValuationDateValue).toBeCloseTo(expectedTotal, 2);

    const moic = valuation.investedTransactionDateValue
      ? valuation.totalValuationDateValue / valuation.investedTransactionDateValue
      : null;
    expect(moic).toBeCloseTo(expectedTotal / expectedInvested, 6);

    // The two single-basis views survive for FX attribution and the trace, and
    // both still differ from the total — they put the cash leg on an FX basis
    // the tense rule forbids, which is exactly why they are not anyone's
    // headline.
    expect(valuation.realizedTransactionDateValue).not.toBeCloseTo(expectedTotal, 2);
    expect(valuation.realizedValuationDateValue).not.toBeCloseTo(expectedTotal, 2);
  });
});
