// Acquisition-consideration investments must not surface as their own
// portfolio row.
//
// addAcquisition (portfolio/company.ts) records an exit paid partly in
// acquirer equity by minting a NEW investment INTO the acquirer entity, tagged
// via investment.event_id -> the exit's DISTRIBUTION event. That consideration
// is already rolled into the acquired (source) company's realised value, so
// surfacing the acquirer as a separate portfolio company both pollutes list/
// export surfaces (e.g. "WorkBoard, Inc." showing up as if we'd invested in
// it) and double-counts the value in aggregate totals.
//
// The acquirer does get a portfolio line — for the shares we hold in it, minted
// by the holdings projection out of the acquired company's row — but never a
// line of its own for the consideration investment, which is what this file is
// about: the excluded row is the one that would carry money we never put in.
//
// getBaseQuery (investments.ts) is the shared row source for
// getPortfolioInvestments / getPortfolioTotals / getCSVExport /
// pushToGoogleSheets / getPerCompanyMovementExport (and the MCP
// listPortfolioCompanies, which rides on getPortfolioInvestments) — this test
// hits it directly with real seeded rows to prove the acquirer-side
// investment is excluded while the source-company investment survives
// untouched, using regular (non-EQUITY_TRANSFER) investment types throughout
// so it also proves the fix does not rely on the dead type != EQUITY_TRANSFER
// filters some call sites carry.
//
// The second half of this file goes through a REAL addAcquisition and then
// reads the company-detail surfaces the MCP's getCompanyFunding calls
// (getOverview, getEventHistory, the first-investment lookup), which used to
// carry no exclusion at all and so reported the acquirer's consideration as if
// we had bought into it.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { getCoreQb, getValuationsQb } from '../../../../lib/kysely';
import { Context } from '../../../../services/context';
import { trpc } from '../../trpc';
import { getBaseQuery, investmentsRouter } from '../investments';
import { companyRouter } from '../portfolio/company';
import { getCompanyFunding } from '../../../mcp/valuations/reads';
import { portfolioTools } from '../../../mcp/valuations/portfolio';
import AssetType from '../../../../generated/kysely/valuations/AssetType';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import EventType from '../../../../generated/kysely/valuations/EventType';
import InvestmentType from '../../../../generated/kysely/valuations/InvestmentType';
import LegalEntityType from '../../../../generated/kysely/valuations/LegalEntityType';
import PriceType from '../../../../generated/kysely/valuations/PriceType';
import { userPrincipal } from '../../../../services/principal';

const INVESTED_AT = '2024-01-01';
const DISTRIBUTION_DATE = '2024-06-01';

interface Scenario {
  teamId: TeamId;
  fundId: string;
  sourceCompanyId: string;
  acquirerCompanyId: string;
  sourceInvestmentId: string;
  acquirerInvestmentId: string;
  distributionEventId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

async function seedScenario(): Promise<Scenario> {
  const teamId = randomUUID() as TeamId;
  const fundId = randomUUID();
  const sourceCompanyId = randomUUID();
  const acquirerCompanyId = randomUUID();
  const sourceInvestmentId = randomUUID();
  const acquirerInvestmentId = randomUUID();
  const distributionEventId = randomUUID();

  await getCoreQb(['team'])
    .insertInto('team')
    .values(anyVals({ id: teamId, name: `acq-excl-${teamId.slice(0, 8)}` }))
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
      anyVals({
        id: sourceCompanyId,
        team_id: teamId,
        name: 'Source Co',
        type: LegalEntityType.COMPANY,
      }),
      anyVals({
        id: acquirerCompanyId,
        team_id: teamId,
        name: 'Acquirer Co',
        type: LegalEntityType.COMPANY,
      }),
    ])
    .execute();

  // The DISTRIBUTION event recording the exit — event.legal_entity_id is the
  // company being exited (the source), matching addAcquisition's usage.
  await getValuationsQb(['event'])
    .insertInto('event')
    .values(
      anyVals({
        id: distributionEventId,
        team_id: teamId,
        legal_entity_id: sourceCompanyId,
        name: 'Acquisition exit',
        type: EventType.DISTRIBUTION,
        date: DISTRIBUTION_DATE,
      }),
    )
    .execute();

  await getValuationsQb(['investment'])
    .insertInto('investment')
    .values([
      // The real cash investment into the source company — no event_id.
      anyVals({
        id: sourceInvestmentId,
        team_id: teamId,
        investor_profile_id: fundId,
        investment_profile_id: sourceCompanyId,
        type: InvestmentType.CASH,
        invested_at: new Date(INVESTED_AT),
      }),
      // The acquirer-side consideration investment minted by addAcquisition —
      // tagged with the DISTRIBUTION event's id. Deliberately NOT
      // EQUITY_TRANSFER, since nothing ever writes that type in practice.
      anyVals({
        id: acquirerInvestmentId,
        team_id: teamId,
        investor_profile_id: fundId,
        investment_profile_id: acquirerCompanyId,
        type: InvestmentType.CASH,
        invested_at: new Date(DISTRIBUTION_DATE),
        event_id: distributionEventId,
      }),
    ])
    .execute();

  return {
    teamId,
    fundId,
    sourceCompanyId,
    acquirerCompanyId,
    sourceInvestmentId,
    acquirerInvestmentId,
    distributionEventId,
  };
}

async function cleanupScenario(s: Scenario): Promise<void> {
  await getValuationsQb(['investment'])
    .deleteFrom('investment')
    .where('team_id', '=', s.teamId)
    .execute();
  await getValuationsQb(['event']).deleteFrom('event').where('team_id', '=', s.teamId).execute();
  await getValuationsQb(['legal_entity'])
    .deleteFrom('legal_entity')
    .where('team_id', '=', s.teamId)
    .execute();
  // Every valuations write above fires the audit trigger that populates the
  // change-outbox, whose rows FK the team — drain it LAST, before the team.
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

describe('getBaseQuery — acquisition-consideration exclusion', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await seedScenario();
  });

  afterAll(async () => {
    await cleanupScenario(scenario);
  });

  it('excludes the acquirer-side investment but keeps the source company', async () => {
    const rows = await withTeamContext(scenario.teamId, () =>
      getBaseQuery({
        input: { filter: {}, config: {} },
      })
        .select(['company.id as company_id', 'investment.id as investment_id'])
        .execute(),
    );

    const companyIds = rows.map((r) => r.company_id);
    const investmentIds = rows.map((r) => r.investment_id);

    // (a) the acquirer entity does not appear at all.
    expect(companyIds).not.toContain(scenario.acquirerCompanyId);
    expect(investmentIds).not.toContain(scenario.acquirerInvestmentId);

    // (c) the source company row still appears.
    expect(companyIds).toContain(scenario.sourceCompanyId);
    expect(investmentIds).toContain(scenario.sourceInvestmentId);

    // (b) — the base query is the shared row source for getPortfolioTotals'
    // per-company JSONB_AGG of investments, so with the acquirer row gone,
    // the consideration value is only ever aggregated once, via the source
    // company's own (untouched) investment row.
    expect(rows.filter((r) => r.company_id === scenario.sourceCompanyId)).toHaveLength(1);
    expect(rows.filter((r) => r.company_id === scenario.acquirerCompanyId)).toHaveLength(0);
  });

  it('keeps a non-DISTRIBUTION-tagged investment (NULL event_id is the common case)', async () => {
    const rows = await withTeamContext(scenario.teamId, () =>
      getBaseQuery({
        input: { filter: {}, config: {} },
      })
        .select(['investment.event_id'])
        .where('investment.id', '=', scenario.sourceInvestmentId as never)
        .execute(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The company-detail surfaces, through a real acquisition.
// ---------------------------------------------------------------------------

const ACQUISITION_DATE = '2024-06-01';
const VALUATION_DATE = '2024-12-31';
const INVESTED_CASH = 50000;
const A_SHARES = 20;
const A_SHARE_PRICE = 3000;
const DEAL_CASH = 5000;
const B_SHARES = 15;
const B_SHARE_PRICE = 2000;
const TRANSFER_CASH = 7000;
const TRANSFER_SHARES = 7;
const TRANSFER_SHARE_PRICE = 1000;

/**
 * $50k into Source Co for 20 A-shares, then acquired for $5k cash plus 15
 * shares of Acquirer Co. Alongside, a company we hold through an
 * EQUITY_TRANSFER-typed investment carrying no event at all — the other way a
 * non-reportable row is marked.
 */
class AcquisitionScenario {
  readonly teamId = randomUUID() as TeamId;
  readonly userId = randomUUID();
  readonly fundId = randomUUID();
  usdAssetId!: string;
  sourceCompanyId!: string;
  acquirerCompanyId!: string;
  transferCompanyId!: string;
  sourceInvestmentId!: string;
  transferInvestmentId!: string;
  aSharesId!: string;
  consideration!: { investmentId: string; eventId: string };

  async seed(): Promise<void> {
    await getCoreQb(['team'])
      .insertInto('team')
      .values(anyVals({ id: this.teamId, name: `acq-detail-${this.teamId.slice(0, 8)}` }))
      .execute();

    // addAcquisition only sweeps investments whose investor is a live
    // portfolio entity — and `is_deprecated` is nullable, so leaving it NULL
    // silently drops the fund out of that filter.
    await this.entity({
      id: this.fundId,
      name: 'Our Fund',
      type: LegalEntityType.FUND,
      extra: { is_own_investing_entity: true, is_portfolio: true, is_deprecated: false },
    });

    this.usdAssetId = await this.currencyAsset();
    this.sourceCompanyId = await this.entity({ name: 'Source Co' });
    this.acquirerCompanyId = await this.entity({ name: 'Acquirer Co' });
    this.transferCompanyId = await this.entity({ name: 'Transfer Co' });

    this.aSharesId = await this.asset({
      issuerId: this.sourceCompanyId,
      name: 'A Shares',
      type: AssetType.EQUITY,
    });
    this.sourceInvestmentId = await this.investment({
      investeeId: this.sourceCompanyId,
      investedAt: INVESTED_AT,
    });
    await this.transaction({
      date: INVESTED_AT,
      investmentId: this.sourceInvestmentId,
      transfers: [
        {
          assetId: this.usdAssetId,
          num: INVESTED_CASH,
          from: this.fundId,
          to: this.sourceCompanyId,
        },
        { assetId: this.aSharesId, num: A_SHARES, from: this.sourceCompanyId, to: this.fundId },
      ],
    });
    await this.price({
      assetId: this.aSharesId,
      issuerId: this.sourceCompanyId,
      price: A_SHARE_PRICE,
      date: '2024-01-02',
    });

    // The row that is non-reportable by TYPE rather than by event: an
    // API-authored share-for-share position with no event of its own.
    const transferSharesId = await this.asset({
      issuerId: this.transferCompanyId,
      name: 'T Shares',
      type: AssetType.EQUITY,
    });
    this.transferInvestmentId = await this.investment({
      investeeId: this.transferCompanyId,
      investedAt: '2024-02-01',
      type: InvestmentType.EQUITY_TRANSFER,
    });
    await this.transaction({
      date: '2024-02-01',
      investmentId: this.transferInvestmentId,
      transfers: [
        {
          assetId: this.usdAssetId,
          num: TRANSFER_CASH,
          from: this.fundId,
          to: this.transferCompanyId,
        },
        {
          assetId: transferSharesId,
          num: TRANSFER_SHARES,
          from: this.transferCompanyId,
          to: this.fundId,
        },
      ],
    });
    await this.price({
      assetId: transferSharesId,
      issuerId: this.transferCompanyId,
      price: TRANSFER_SHARE_PRICE,
      date: '2024-02-02',
    });

    await this.recordAcquisition();
  }

  /** The real write path: $5k cash plus 15 acquirer shares for the position. */
  private async recordAcquisition(): Promise<void> {
    await this.asUser(() =>
      companyRouter(trpc.procedure)
        .createCaller({ authorise: async () => {} })
        .addAcquisition({
          companyId: this.sourceCompanyId,
          date: ACQUISITION_DATE,
          acquirer: { id: this.acquirerCompanyId, name: 'Acquirer Co' },
          transactions: [
            {
              fundId: this.fundId,
              assetsSold: [{ id: this.aSharesId, amount: A_SHARES }],
              assetsReceived: [
                {
                  type: 'CASH',
                  amount: DEAL_CASH,
                  date: ACQUISITION_DATE,
                  currency: CurrencyIsoCode.USD,
                },
                {
                  type: 'EQUITY',
                  amount: B_SHARES,
                  date: ACQUISITION_DATE,
                  shareClass: 'B Shares',
                },
              ],
            },
          ],
        }),
    );

    const minted = await getValuationsQb(['investment'])
      .selectFrom('investment')
      .select(['id', 'event_id'])
      .where('team_id', '=', this.teamId)
      .where('investment_profile_id', '=', this.acquirerCompanyId as never)
      .executeTakeFirstOrThrow();
    if (!minted.event_id) throw new Error('addAcquisition minted no consideration investment');
    this.consideration = { investmentId: minted.id, eventId: minted.event_id };

    const bShares = await getValuationsQb(['asset'])
      .selectFrom('asset')
      .select('id')
      .where('team_id', '=', this.teamId)
      .where('issued_by_legal_entity_id', '=', this.acquirerCompanyId as never)
      .executeTakeFirstOrThrow();
    await this.price({
      assetId: bShares.id,
      issuerId: this.acquirerCompanyId,
      price: B_SHARE_PRICE,
      date: '2024-06-02',
    });
  }

  private async entity({
    id = randomUUID(),
    name,
    type = LegalEntityType.COMPANY,
    extra = {},
  }: {
    id?: string;
    name: string;
    type?: LegalEntityType;
    extra?: Record<string, unknown>;
  }): Promise<string> {
    await getValuationsQb(['legal_entity'])
      .insertInto('legal_entity')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          name,
          type,
          slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${id.slice(0, 8)}`,
          ...extra,
        }),
      )
      .execute();
    return id;
  }

  private async asset({
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

  private async currencyAsset(): Promise<string> {
    const assetId = await this.asset({
      issuerId: this.fundId,
      name: 'USD',
      type: AssetType.CURRENCY,
    });
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
    return assetId;
  }

  private async investment({
    investeeId,
    investedAt,
    type = InvestmentType.CASH,
  }: {
    investeeId: string;
    investedAt: string;
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
          invested_at: new Date(investedAt),
          type,
        }),
      )
      .execute();
    return id;
  }

  private async transaction({
    date,
    investmentId,
    transfers,
  }: {
    date: string;
    investmentId: string;
    transfers: { assetId: string; num: number; from: string; to: string }[];
  }): Promise<void> {
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
  }

  private async price({
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

  asUser<T>(fn: () => Promise<T>): Promise<T> {
    const ctx = new Context();
    // A `write` principal is what puts the context on the writable pool, which
    // addAcquisition needs; nothing else here reads the user row.
    ctx.bindPrincipal(userPrincipal({ userId: this.userId, teamId: this.teamId }));
    return ctx.runAsync(fn);
  }

  company() {
    return companyRouter(trpc.procedure).createCaller({ authorise: async () => {} });
  }

  investments() {
    return investmentsRouter(trpc.procedure).createCaller({ authorise: async () => {} });
  }

  /** The MCP tool the bug was reported through, decoded back to a value. */
  async companyFunding(company: string) {
    const result = await this.asUser(async () =>
      getCompanyFunding.handler!({
        company,
        currency: CurrencyIsoCode.USD,
        asOfDate: `${VALUATION_DATE}T00:00:00.000Z`,
      }),
    );
    const text = result.content[0];
    if (text.type !== 'text') throw new Error('expected a text tool result');
    const parsed = JSON.parse(text.text);
    if (result.isError) throw new Error(`getCompanyFunding failed: ${parsed.error}`);
    return parsed;
  }

  /** The list as an agent gets it: through the MCP tool, decoded back. */
  async listPortfolioCompanies(args: Record<string, unknown>) {
    const result = await this.asUser(async () =>
      portfolioTools.listPortfolioCompanies.handler!(args),
    );
    const text = result.content[0];
    if (text.type !== 'text') throw new Error('expected a text tool result');
    const parsed = JSON.parse(text.text);
    if (result.isError) throw new Error(`listPortfolioCompanies failed: ${parsed.error}`);
    return parsed;
  }

  async cleanup(): Promise<void> {
    const team = this.teamId;
    await getValuationsQb(['price']).deleteFrom('price').where('team_id', '=', team).execute();
    await getValuationsQb(['asset_transfer'])
      .deleteFrom('asset_transfer')
      .where('team_id', '=', team)
      .execute();
    await getValuationsQb(['transaction'])
      .deleteFrom('transaction')
      .where('team_id', '=', team)
      .execute();
    // event_id / exit_event_id / acquired_event_id all FK the events below.
    await getValuationsQb(['investment'])
      .updateTable('investment')
      .set(anyVals({ event_id: null, exit_event_id: null }))
      .where('team_id', '=', team)
      .execute();
    await getValuationsQb(['legal_entity'])
      .updateTable('legal_entity')
      .set(
        anyVals({ acquired_by_legal_entity_id: null, acquired_event_id: null, acquired_at: null }),
      )
      .where('team_id', '=', team)
      .execute();
    await getValuationsQb(['investment'])
      .deleteFrom('investment')
      .where('team_id', '=', team)
      .execute();
    await getValuationsQb(['event']).deleteFrom('event').where('team_id', '=', team).execute();
    const changelogIds = await getValuationsQb(['funding_changelog'])
      .selectFrom('funding_changelog')
      .select('id')
      .where('team_id', '=', team)
      .execute();
    if (changelogIds.length) {
      await getValuationsQb(['funding_changelog_fund'])
        .deleteFrom('funding_changelog_fund')
        .where(
          'changelog_id',
          'in',
          changelogIds.map((r) => r.id),
        )
        .execute();
    }
    await getValuationsQb(['funding_changelog'])
      .deleteFrom('funding_changelog')
      .where('team_id', '=', team)
      .execute();
    if (this.usdAssetId) {
      await getValuationsQb(['currency_asset'])
        .deleteFrom('currency_asset')
        .where('asset_id', '=', this.usdAssetId as never)
        .execute();
    }
    await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', team).execute();
    await getValuationsQb(['legal_entity'])
      .deleteFrom('legal_entity')
      .where('team_id', '=', team)
      .execute();
    await getValuationsQb(['valuations_change_outbox'])
      .deleteFrom('valuations_change_outbox')
      .where('team_id', '=', team)
      .execute();
    await getCoreQb(['team']).deleteFrom('team').where('id', '=', team).execute();
  }
}

describe('company-detail surfaces — reportable investments only', () => {
  let s: AcquisitionScenario;

  beforeAll(async () => {
    // Built before seeding so a half-seeded fixture is still torn down —
    // currency_asset.iso_code is unique across every team in the test DB, so a
    // leak here breaks the NEXT run rather than this one.
    s = new AcquisitionScenario();
    await s.seed();
  });

  afterAll(async () => {
    await s.cleanup();
  });

  const overview = (companyId: string) =>
    s.asUser(async () => {
      const entity = await getValuationsQb(['legal_entity'])
        .selectFrom('legal_entity')
        .select('slug')
        .where('id', '=', companyId as never)
        .executeTakeFirstOrThrow();
      return s.company().getOverview({
        slug: entity.slug as string,
        config: { currency: CurrencyIsoCode.USD, valuationDate: `${VALUATION_DATE}T00:00:00.000Z` },
      });
    });

  const eventHistory = (companyId: string) =>
    s.asUser(() =>
      s.company().getEventHistory({
        companyId,
        config: { currency: CurrencyIsoCode.USD, valuationDate: `${VALUATION_DATE}T00:00:00.000Z` },
      }),
    );

  // On a mixed deal the roll-up anchors the cash leg to the ACQUIRED company's
  // line, so what the acquirer's own page double-counted was mostly the
  // retained stock — all three figures are pinned rather than just realised.
  it('(a) the acquirer overview carries nothing from the consideration', async () => {
    const acquirer = await overview(s.acquirerCompanyId);

    expect(acquirer).not.toBeNull();
    expect(acquirer!.realizedValue).toBe(0);
    expect(acquirer!.invested).toBe(0);
    expect(acquirer!.value).toBe(0);
    // Including the date: the consideration is the only position on this
    // entity, and it is not a date we invested in it.
    expect(acquirer!.firstInvested).toBeNull();
  });

  // The consideration is kept out of the figures, not out of sight: the
  // acquirer's page lists it separately, against what the fund paid for the
  // company it gave up.
  it('(a) the acquirer overview lists the consideration as an acquisition', async () => {
    const acquirer = await overview(s.acquirerCompanyId);
    const source = await overview(s.sourceCompanyId);

    expect(acquirer!.investments).toHaveLength(0);
    expect(acquirer!.acquisitions).toHaveLength(1);
    const [acquisition] = acquirer!.acquisitions;
    expect(acquisition.investmentId).toBe(s.consideration.investmentId);
    expect(acquisition.fund).toEqual({ id: s.fundId, name: 'Our Fund' });
    expect(acquisition.acquiredCompany.id).toBe(s.sourceCompanyId);
    expect(acquisition.sharesReceived).toEqual([
      expect.objectContaining({ assetName: 'B Shares', quantity: B_SHARES }),
    ]);
    expect(acquisition.acquiredCompanyCost).toBeCloseTo(INVESTED_CASH, 6);
    expect(acquisition.valueNow).toBeCloseTo(B_SHARES * B_SHARE_PRICE, 6);
    expect(acquisition.cashReceived).toBeCloseTo(DEAL_CASH, 6);

    expect(source!.acquisitions).toEqual([]);
  });

  it('(a) the acquired company keeps every figure the fix was not about', async () => {
    const source = await overview(s.sourceCompanyId);

    expect(source!.firstInvested).toBe(new Date(INVESTED_AT).toISOString());
    expect(source!.invested).toBeCloseTo(INVESTED_CASH, 6);
    expect(source!.realizedValue).toBeCloseTo(DEAL_CASH, 6);
    expect(source!.value).toBeCloseTo(B_SHARES * B_SHARE_PRICE, 6);
  });

  it('(b) the acquirer history has no valuation row for the consideration', async () => {
    const history = await eventHistory(s.acquirerCompanyId);

    expect(history.investments.map((i) => i.id)).not.toContain(s.consideration.investmentId);
    expect(history.investments).toHaveLength(0);
  });

  it('(b) the acquired company still lists the acquisition event, and reconciles', async () => {
    const history = await eventHistory(s.sourceCompanyId);

    // Events belong to the company, so the exit is still on its timeline.
    expect(history.events.map((e) => e.type)).toContain(EventType.DISTRIBUTION);

    expect(history.investments.map((i) => i.id)).toEqual([s.sourceInvestmentId]);
    const [line] = history.investments;
    expect(line.totalInvested).toBeCloseTo(INVESTED_CASH, 6);
    expect(line.realizedValue).toBeCloseTo(DEAL_CASH, 6);
    expect(line.totalValue).toBeCloseTo(line.realizedValue + line.unrealizedValue, 6);
  });

  it('(c) the MCP first-investment lookup skips the consideration row', async () => {
    const acquirer = await s.companyFunding(s.acquirerCompanyId);
    expect(acquirer.firstInvestment).toBeNull();
    expect(acquirer.overview.realizedValue).toBe(0);

    const source = await s.companyFunding(s.sourceCompanyId);
    expect(source.firstInvestment.invested).toBeCloseTo(INVESTED_CASH, 6);
    expect(source.firstInvestment.realised).toBeCloseTo(DEAL_CASH, 6);
  });

  it('(d) an EQUITY_TRANSFER row with no event is out of the list and the totals', async () => {
    const [list, totals] = await s.asUser(async () => {
      const caller = s.investments();
      const config = {
        currency: CurrencyIsoCode.USD,
        valuationDate: VALUATION_DATE,
        aggregation: 'company' as const,
      };
      return Promise.all([
        caller.getPortfolioInvestments({ filter: {}, config }),
        caller.getPortfolioTotals({ filter: {}, config }),
      ]);
    });

    const listed = list.items.map((i) => i.legal_entity_id as string);
    expect(listed).toContain(s.sourceCompanyId);
    expect(listed).not.toContain(s.transferCompanyId);

    // The acquirer IS on the list, but as the line for shares we hold, not as
    // an investment we made: one line, minted by the projection, with no
    // invested figure on it. The consideration investment is still excluded —
    // if it were being valued as a row of its own, this line would carry the
    // money it pretends we put in.
    const acquirerLines = list.items.filter((i) => i.legal_entity_id === s.acquirerCompanyId);
    expect(acquirerLines).toHaveLength(1);
    expect(acquirerLines[0].totalInvested).toBeNull();
    expect(acquirerLines[0].moic).toBeNull();
    expect(acquirerLines[0].unrealizedValue).toBeCloseTo(B_SHARES * B_SHARE_PRICE, 6);
    expect(acquirerLines[0].investment_ids).toEqual([]);

    // Only the source company's $50k — not the transfer row's $7k, and not the
    // consideration's deal cash a second time.
    expect(totals.totalInvested).toBeCloseTo(INVESTED_CASH, 6);
    expect(totals.realizedValue).toBeCloseTo(DEAL_CASH, 6);

    // And the totals are untouched by the projection: it moved the shares from
    // one line to another, which sums to the same thing.
    const sum = (pick: (row: (typeof list.items)[number]) => number | null) =>
      list.items.reduce((total, row) => total + (pick(row) ?? 0), 0);
    expect(totals.unrealizedValue).toBeCloseTo(B_SHARES * B_SHARE_PRICE, 6);
    expect(sum((row) => row.totalInvested)).toBeCloseTo(totals.totalInvested, 6);
    expect(sum((row) => row.unrealizedValue)).toBeCloseTo(totals.unrealizedValue, 6);
    expect(sum((row) => row.realizedValue)).toBeCloseTo(totals.realizedValue, 6);
    expect(sum((row) => row.totalValue)).toBeCloseTo(totals.totalValue, 6);
  });

  it('(e) searching the acquirer by name returns the line we hold in it', async () => {
    const list = await s.asUser(() =>
      s.investments().getPortfolioInvestments({
        filter: { name: 'Acquirer Co' },
        config: {
          currency: CurrencyIsoCode.USD,
          valuationDate: VALUATION_DATE,
          aggregation: 'company' as const,
        },
      }),
    );

    // Source Co matches nothing typed here — it survives the SQL filter only
    // so this line can be minted from it, and is dropped once it has been.
    expect(list.items.map((i) => i.legal_entity_id as string)).toEqual([s.acquirerCompanyId]);
    expect(list.items[0].unrealizedValue).toBeCloseTo(B_SHARES * B_SHARE_PRICE, 6);
  });

  it('(f) under the investment lens the acquirer has no line and the shares stay on ours', async () => {
    const list = await s.asUser(() =>
      s.investments().getPortfolioInvestments({
        filter: {},
        config: {
          currency: CurrencyIsoCode.USD,
          valuationDate: VALUATION_DATE,
          aggregation: 'company' as const,
        },
        lens: 'investment' as const,
      }),
    );

    const listed = list.items.map((i) => i.legal_entity_id as string);
    expect(listed).toContain(s.sourceCompanyId);
    // Not as a minted holdings line, and not as the excluded consideration
    // investment either: under this lens the acquirer is simply not a company
    // we put money into.
    expect(listed).not.toContain(s.acquirerCompanyId);

    // The shares are still ours, so they are still counted — on the line for
    // the investment that earned them.
    const source = list.items.find((i) => i.legal_entity_id === s.sourceCompanyId)!;
    expect(source.unrealizedValue).toBeCloseTo(B_SHARES * B_SHARE_PRICE, 6);
    expect(source.totalInvested).toBeCloseTo(INVESTED_CASH, 6);
  });

  it("(g) under the investment lens the acquirer's name is not a way to find us", async () => {
    const list = await s.asUser(() =>
      s.investments().getPortfolioInvestments({
        filter: { name: 'Acquirer Co' },
        config: {
          currency: CurrencyIsoCode.USD,
          valuationDate: VALUATION_DATE,
          aggregation: 'company' as const,
        },
        lens: 'investment' as const,
      }),
    );

    // There is no acquirer line to mint here, so widening the search to reach
    // one would only have returned Source Co, which nobody asked for.
    expect(list.items).toHaveLength(0);
  });

  it('(h) the MCP list offers the same lever, defaulted to holdings', async () => {
    const tool = portfolioTools.listPortfolioCompanies;
    // The lever has to be visible to an agent, not just accepted: the tool's
    // input schema is read straight off the procedure's zod input.
    expect(tool.inputSchema).toHaveProperty('lens');
    expect(tool.inputSchema.lens.description).toMatch(/investment/);

    const config = { currency: 'USD', valuationDate: VALUATION_DATE, aggregation: 'company' };
    const [byDefault, asInvestments] = await Promise.all([
      s.listPortfolioCompanies({ filter: {}, config }),
      s.listPortfolioCompanies({ filter: {}, config, lens: 'investment' }),
    ]);

    const ids = (list: { items: { legal_entity_id: string }[] }) =>
      list.items.map((i) => i.legal_entity_id);
    expect(ids(byDefault)).toContain(s.acquirerCompanyId);
    expect(ids(asInvestments)).not.toContain(s.acquirerCompanyId);

    // Same atoms, differently apportioned: what the acquirer line holds by
    // default is what the source company's line holds without it.
    const retained = (list: { items: { unrealizedValue: number }[] }) =>
      list.items.reduce((total, row) => total + (row.unrealizedValue ?? 0), 0);
    expect(retained(asInvestments)).toBeCloseTo(retained(byDefault), 6);
  });
});
