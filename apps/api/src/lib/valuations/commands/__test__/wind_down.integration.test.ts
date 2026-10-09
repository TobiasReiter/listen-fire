// Wind-down disposes every held position that TRACKS the company being wound
// down — not just assets under an investment literally profiled to it. The
// selection mirrors the valuation walk's tracked-entity resolution
// (getAssetTrackedEntities: issuer / issuer's underlying / SPV target), so:
//
//   (a) a holding under an investment profiled to the SPV itself (SPV.underlying
//       = the company) is disposed, though its investment never names the
//       company;
//   (b) equity ISSUED by an SPV wrapper over the company is marked to zero —
//       the per-asset markdown is keyed to the asset's own issuer, so it reaches
//       SPV-issued equity that a company-keyed price would miss;
//   (c) each disposed position is transferred out to the void (a one-way
//       outflow), closing the holding without conjuring realised proceeds;
//   (d) the plain direct-holding case still zeroes and closes.
//
// Runs the REAL service (applyWindDown) through a write-abilitied Context +
// enterTransaction, exactly as the tRPC / REST / movement callers do, then
// re-values through getInvestmentsValuation.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import Pg from 'pg';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';

import { getCoreQb, getValuationsQb } from '../../../kysely';
import { getDatabaseUrl } from '../../../../prisma';
import { Context } from '../../../../services/context';
import { getInvestmentsValuation } from '../../valuation';
import { applyWindDown, disposeTrackedHoldings } from '../wind_down';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../../../generated/kysely/valuations/AssetType';
import EventType from '../../../../generated/kysely/valuations/EventType';
import PriceType from '../../../../generated/kysely/valuations/PriceType';
import InvestmentType from '../../../../generated/kysely/valuations/InvestmentType';
import LegalEntityType from '../../../../generated/kysely/valuations/LegalEntityType';
import { userPrincipal } from '../../../../services/principal';

const AS_OF_DATE = new Date('2024-12-31');
const WIND_DOWN_DATE = '2024-06-01';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

const BACKFILL_DIR = path.resolve(__dirname, '../../../../db/backfills');

/** Run a backfill .sql file VERBATIM against the test DB via the simple-query
 *  protocol (multi-statement, honours BEGIN/COMMIT) — exactly as `psql -f`
 *  would. Scoped to `teamId` for test isolation via the CTE edit the file's
 *  header documents. Returns the last statement's rows (the report SELECT; []
 *  for the apply). */
async function runBackfillSql(
  file: 'report' | 'apply',
  teamId: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = fs.readFileSync(
    path.join(BACKFILL_DIR, `2026-07-23_wind_down_disposals.${file}.sql`),
    'utf8',
  );
  const scoped = raw.replaceAll(
    "WHERE e.type = 'LIQUIDATION'",
    `WHERE e.type = 'LIQUIDATION' AND e.team_id = '${teamId}'`,
  );
  // The backfill SQL text is a historical artifact (see file header) and
  // predates the `event`/`asset`/`legal_entity`/... tables' move out of
  // `public` into the `valuations` schema — it references them unqualified.
  // Rather than rewrite the SQL (which would break the parity claim this
  // test exists to make), point the connection's search_path at `valuations`
  // so the unqualified names resolve exactly as they did historically.
  const pool = new Pg.Pool({
    connectionString: getDatabaseUrl(false).url,
    options: '-c search_path=valuations,public',
  });
  try {
    const res = await pool.query(scoped);
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    return (last?.rows ?? []) as Array<Record<string, unknown>>;
  } finally {
    await pool.end();
  }
}

// A tiny seeding toolkit — mirrors tracks_investee_realisation's fixture, plus a
// `windDown` that drives the real service through a write-abilitied Context.
class Scenario {
  readonly teamId: TeamId;
  readonly userId: UserId;
  readonly fundId: string;
  private readonly usdAssetIds = new Set<string>();

  private constructor(teamId: TeamId, userId: UserId, fundId: string) {
    this.teamId = teamId;
    this.userId = userId;
    this.fundId = fundId;
  }

  static async create(): Promise<Scenario> {
    const teamId = randomUUID() as TeamId;
    const userId = randomUUID() as UserId;
    await getCoreQb(['team'])
      .insertInto('team')
      .values(anyVals({ id: teamId, name: `wd-${teamId.slice(0, 8)}` }))
      .execute();
    await getCoreQb(['user'])
      .insertInto('user')
      .values(anyVals({ id: userId, default_team_id: teamId, username: `wd-${userId.slice(0, 8)}` }))
      .execute();
    const s = new Scenario(teamId, userId, randomUUID());
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

  /** Drive the real service exactly as the callers do: resolve nothing up
   *  front (wind-down takes no NEW entities), open the tx, apply. */
  async windDown(companyId: string, date: string = WIND_DOWN_DATE): Promise<{ eventId: string }> {
    const ctx = new Context();
    ctx.bindPrincipal(userPrincipal({ userId: this.userId, teamId: this.teamId }));
    return ctx.runAsync(async () => {
      await ctx.enterTransaction();
      return applyWindDown({ companyId, date });
    });
  }

  /** Seed a PRE-FIX wound-down company: a bare LIQUIDATION event + DISSOLVED
   *  status, but NO markdown and NO disposal transfers (the state the old
   *  wind-down left behind). Returns the event id the backfill attaches to. */
  async liquidationEvent(companyId: string, date: string = WIND_DOWN_DATE): Promise<string> {
    const id = randomUUID();
    await getValuationsQb(['event'])
      .insertInto('event')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          name: 'Wind Down',
          type: EventType.LIQUIDATION,
          date,
          legal_entity_id: companyId,
        }),
      )
      .execute();
    await getValuationsQb(['legal_entity'])
      .updateTable('legal_entity')
      .set(anyVals({ legal_status: 'DISSOLVED' }))
      .where('id', '=', companyId as never)
      .execute();
    return id;
  }

  /** The SERVICE disposal path against an EXISTING event — no new event, no
   *  status change — inside a transaction, exactly what the backfill would do
   *  if it called the service. This is the reference the SQL is compared to. */
  async disposeViaService(companyId: string, eventId: string, date: string = WIND_DOWN_DATE) {
    const ctx = new Context();
    ctx.bindPrincipal(userPrincipal({ userId: this.userId, teamId: this.teamId }));
    return ctx.runAsync(async () => {
      await ctx.enterTransaction();
      return disposeTrackedHoldings({ companyId, date: new Date(date), eventId });
    });
  }

  async countEvents(): Promise<number> {
    const row = await getValuationsQb(['event'])
      .selectFrom('event')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('team_id', '=', this.teamId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** The markdown price rows + disposal transfers a wind-down produced for one
   *  company — keyed off that company's LIQUIDATION event. Used to prove the
   *  SQL and the service wrote the same artifacts. */
  async disposalArtifacts(companyId: string): Promise<{
    marks: Array<{ asset_id: string | null; legal_entity_id: string | null; price: number }>;
    transfers: Array<{ asset_id: string; from_legal_entity_id: string; to_legal_entity_id: string; num_assets: number | null }>;
  }> {
    const marks = await getValuationsQb(['price', 'event'])
      .selectFrom('price as p')
      .innerJoin('event as e', 'e.id', 'p.event_id')
      .select(['p.asset_id', 'p.legal_entity_id', 'p.price'])
      .where('e.team_id', '=', this.teamId)
      .where('e.type', '=', EventType.LIQUIDATION)
      .where('e.legal_entity_id', '=', companyId as never)
      .execute();
    const transfers = await getValuationsQb(['asset_transfer', 'transaction', 'event'])
      .selectFrom('asset_transfer as at')
      .innerJoin('transaction as t', 't.id', 'at.transaction_id')
      .innerJoin('event as e', 'e.id', 't.event_id')
      .select(['at.asset_id', 'at.from_legal_entity_id', 'at.to_legal_entity_id', 'at.num_assets'])
      .where('e.team_id', '=', this.teamId)
      .where('e.type', '=', EventType.LIQUIDATION)
      .where('e.legal_entity_id', '=', companyId as never)
      .execute();
    return { marks, transfers };
  }

  /** A complete PRE-FIX wound-down company exercising all three tracking
   *  branches — direct company equity, SPV-issued equity (issuer's underlying),
   *  and an SPV interest (target property) — all held by the fund under one
   *  investment, priced, with a bare LIQUIDATION event + DISSOLVED status but NO
   *  disposal. Returns the ids the equivalence assertions key off. */
  async seedPreFixWoundDown(
    usd: string,
    label: string,
  ): Promise<{ companyId: string; investmentId: string; eventId: string }> {
    const companyId = await this.entity({ name: `Company ${label}` });
    const spv = await this.entity({
      name: `${label} SPV`,
      type: LegalEntityType.SPV,
      underlyingCompanyId: companyId,
    });
    const cEquity = await this.asset({ issuerId: companyId, name: `${label} Shares`, type: AssetType.EQUITY });
    const spvEquity = await this.asset({ issuerId: spv, name: `${label} SPV Shares`, type: AssetType.EQUITY });
    const spvInterest = await this.asset({
      issuerId: spv,
      name: `${label} SPV Interest`,
      type: AssetType.SPV_INTEREST_POINT,
      properties: { spv_investment_target_company_id: companyId },
    });
    const investmentId = await this.investment({ investeeId: companyId });

    await this.transaction({
      date: '2024-01-01',
      investmentId,
      transfers: [
        { assetId: usd, num: 30000, from: this.fundId, to: companyId },
        { assetId: cEquity, num: 15, from: companyId, to: this.fundId },
      ],
    });
    await this.transaction({
      date: '2024-01-01',
      investmentId,
      transfers: [{ assetId: spvEquity, num: 10, from: spv, to: this.fundId }],
    });
    await this.transaction({
      date: '2024-01-01',
      investmentId,
      transfers: [{ assetId: spvInterest, num: 1, from: spv, to: this.fundId }],
    });

    await this.price({ assetId: cEquity, issuerId: companyId, price: 2500, date: '2024-02-01' });
    await this.price({ assetId: spvEquity, issuerId: spv, price: 2000, date: '2024-02-01' });
    await this.price({ assetId: spvInterest, issuerId: spv, price: 20000, date: '2024-02-01' });

    const eventId = await this.liquidationEvent(companyId);
    return { companyId, investmentId, eventId };
  }

  value(investmentId: string) {
    return withTeamContext(this.teamId, this.userId, () =>
      getInvestmentsValuation({
        investments: [{ id: investmentId, date: null }],
        asOfDate: AS_OF_DATE,
        fxDate: AS_OF_DATE,
        targetCurrency: CurrencyIsoCode.USD,
      }),
    );
  }

  /** Every asset_transfer the wind-down disposal produced (fund → issuer). */
  disposals() {
    return getValuationsQb(['asset_transfer', 'transaction', 'event'])
      .selectFrom('asset_transfer as at')
      .innerJoin('transaction as t', 't.id', 'at.transaction_id')
      .innerJoin('event as e', 'e.id', 't.event_id')
      .select(['at.asset_id', 'at.from_legal_entity_id', 'at.to_legal_entity_id', 'at.num_assets'])
      .where('at.team_id', '=', this.teamId)
      .where('e.type', '=', EventType.LIQUIDATION)
      .execute();
  }

  /** Wind-down markdown prices (price = 0 rows stamped by the LIQUIDATION event). */
  markdowns() {
    return getValuationsQb(['price', 'event'])
      .selectFrom('price as p')
      .innerJoin('event as e', 'e.id', 'p.event_id')
      .select(['p.asset_id', 'p.legal_entity_id', 'p.price'])
      .where('p.team_id', '=', this.teamId)
      .where('e.type', '=', EventType.LIQUIDATION)
      .execute();
  }

  async cleanup(): Promise<void> {
    await getValuationsQb(['price']).deleteFrom('price').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['asset_transfer']).deleteFrom('asset_transfer').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['transaction']).deleteFrom('transaction').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['investment']).deleteFrom('investment').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['event']).deleteFrom('event').where('team_id', '=', this.teamId).execute();
    for (const usdAssetId of this.usdAssetIds) {
      await getValuationsQb(['currency_asset']).deleteFrom('currency_asset').where('asset_id', '=', usdAssetId as never).execute();
    }
    await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['legal_entity']).deleteFrom('legal_entity').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['valuations_change_outbox'])
      .deleteFrom('valuations_change_outbox')
      .where('team_id', '=', this.teamId)
      .execute();
    await getCoreQb(['user']).deleteFrom('user').where('id', '=', this.userId).execute();
    await getCoreQb(['team']).deleteFrom('team').where('id', '=', this.teamId).execute();
  }
}

async function withTeamContext<T>(teamId: string, userId: string, fn: () => Promise<T>): Promise<T> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId, teamId }));
  return ctx.runAsync(fn);
}

describe('wind-down disposal', () => {
  let scenario: Scenario;
  afterEach(async () => {
    await scenario.cleanup();
  });

  it('(d) plain direct holding: marks the company equity to zero and closes it', async () => {
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
    await scenario.price({ assetId: cShares, issuerId: companyC, price: 2500, date: '2024-02-01' });

    // Before: 15 × 2500 = 37,500 retained.
    const before = await scenario.value(investment);
    expect(before.unrealizedValuationDateValue).toBeCloseTo(37500, 2);

    await scenario.windDown(companyC);

    const after = await scenario.value(investment);
    expect(after.unrealizedValuationDateValue).toBeCloseTo(0, 2);
    expect(after.realizedTransactionDateValue).toBeCloseTo(0, 2);

    const disposals = await scenario.disposals();
    expect(disposals).toEqual([
      expect.objectContaining({
        asset_id: cShares,
        from_legal_entity_id: scenario.fundId,
        to_legal_entity_id: companyC,
        num_assets: 15,
      }),
    ]);
    // No currency leg in the disposal transaction — nothing realised.
    expect(disposals.every((d) => d.asset_id !== usd)).toBe(true);
  });

  it('(a) SPV-profiled holding: disposes an SPV interest whose investment never names the company', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyC = await scenario.entity({ name: 'Company C' });
    const spv = await scenario.entity({
      name: 'C SPV',
      type: LegalEntityType.SPV,
      underlyingCompanyId: companyC,
    });
    const spvInterest = await scenario.asset({
      issuerId: spv,
      name: 'C SPV Interest',
      type: AssetType.SPV_INTEREST_POINT,
      properties: { spv_investment_target_company_id: companyC },
    });
    // Investment is profiled to the SPV, NOT to Company C — the old selection
    // (investment_profile_id === companyId) would never touch this holding.
    const spvInvestment = await scenario.investment({ investeeId: spv });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: spvInvestment,
      transfers: [
        { assetId: usd, num: 20000, from: scenario.fundId, to: spv },
        { assetId: spvInterest, num: 1, from: spv, to: scenario.fundId },
      ],
    });
    await scenario.price({ assetId: spvInterest, issuerId: spv, price: 20000, date: '2024-02-01' });

    const before = await scenario.value(spvInvestment);
    expect(before.unrealizedValuationDateValue).toBeCloseTo(20000, 2);

    await scenario.windDown(companyC);

    const after = await scenario.value(spvInvestment);
    expect(after.unrealizedValuationDateValue).toBeCloseTo(0, 2);
    expect(after.realizedTransactionDateValue).toBeCloseTo(0, 2);

    const disposals = await scenario.disposals();
    expect(disposals).toContainEqual(
      expect.objectContaining({
        asset_id: spvInterest,
        from_legal_entity_id: scenario.fundId,
        to_legal_entity_id: spv,
        num_assets: 1,
      }),
    );
  });

  it('(b) SPV-issued equity: zeroed via a per-issuer markdown a company-keyed price would miss', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyC = await scenario.entity({ name: 'Company C' });
    const spv = await scenario.entity({
      name: 'C Wrapper SPV',
      type: LegalEntityType.SPV,
      underlyingCompanyId: companyC,
    });
    // Equity ISSUED by the SPV wrapper (issuer = spv, underlying = companyC).
    const spvEquity = await scenario.asset({ issuerId: spv, name: 'SPV Wrapper Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyC });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 20000, from: scenario.fundId, to: spv },
        { assetId: spvEquity, num: 10, from: spv, to: scenario.fundId },
      ],
    });
    await scenario.price({ assetId: spvEquity, issuerId: spv, price: 2000, date: '2024-02-01' });

    const before = await scenario.value(investment);
    expect(before.unrealizedValuationDateValue).toBeCloseTo(20000, 2); // 10 × 2000

    await scenario.windDown(companyC);

    const after = await scenario.value(investment);
    expect(after.unrealizedValuationDateValue).toBeCloseTo(0, 2);

    // The markdown is keyed to the SPV-issued equity's OWN issuer, not the
    // wound-down company — that is what makes the per-issuer equity price lookup
    // zero it.
    const markdowns = await scenario.markdowns();
    expect(markdowns).toContainEqual(
      expect.objectContaining({ asset_id: spvEquity, legal_entity_id: spv, price: 0 }),
    );
  });

  it('(c) void disposal closes the holding without creating realised value', async () => {
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
    await scenario.price({ assetId: cShares, issuerId: companyC, price: 2500, date: '2024-02-01' });

    await scenario.windDown(companyC);

    const after = await scenario.value(investment);
    // No cash ever came back → realised stays zero (the one-way outflow is
    // classified ONE_WAY_TRANSACTION, conjuring no proceeds), and the marked-
    // down holding contributes nothing to unrealised.
    expect(after.realizedTransactionDateValue).toBeCloseTo(0, 2);
    expect(after.realizedValuationDateValue).toBeCloseTo(0, 2);
    expect(after.unrealizedValuationDateValue).toBeCloseTo(0, 2);
    expect(after.totalValuationDateValue).toBeCloseTo(0, 2);

    // The disposal is a pure outflow: the equity leaves the fund, and no
    // currency asset is transferred in.
    const disposals = await scenario.disposals();
    expect(disposals).toHaveLength(1);
    expect(disposals[0]).toMatchObject({ asset_id: cShares, from_legal_entity_id: scenario.fundId });
    expect(disposals[0].asset_id).not.toBe(usd);
  });
});

// The hand-written SQL backfill (db/backfills/2026-07-23_wind_down_disposals.*)
// deliberately duplicates the disposal logic. This proves END-EFFECT
// equivalence against the real service path and is the tripwire if the two
// drift: two identical pre-fix wound-down companies, one disposed via the
// service (disposeTrackedHoldings) and one via the SQL, must land in the same
// valuation state.
describe('wind-down disposal backfill — hand-written SQL ≡ service', () => {
  let scenario: Scenario;
  afterEach(async () => {
    await scenario.cleanup();
  });

  it('SQL matches the service end-state (holdings closed, unrealised 0, realised unchanged, no new event); re-run is a no-op', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();

    // Two identical pre-fix wound-down companies. A → service, B → SQL.
    const A = await scenario.seedPreFixWoundDown(usd, 'A');
    const B = await scenario.seedPreFixWoundDown(usd, 'B');

    const eventsBefore = await scenario.countEvents(); // the two liquidation events

    // Before disposal both still hold tracking assets with equal, non-zero
    // unrealised value (15×2500 + 10×2000 + 1×20000 = 77,500).
    const beforeA = await scenario.value(A.investmentId);
    const beforeB = await scenario.value(B.investmentId);
    expect(beforeA.holdsTrackingAssets).toBe(true);
    expect(beforeB.holdsTrackingAssets).toBe(true);
    expect(beforeA.unrealizedValuationDateValue).toBeCloseTo(77500, 2);
    expect(beforeA.unrealizedValuationDateValue).toBeCloseTo(beforeB.unrealizedValuationDateValue, 2);
    const realisedBefore = beforeA.realizedTransactionDateValue;

    // Dry-run report lists every position for BOTH companies — 3 assets each.
    const report = await runBackfillSql('report', scenario.teamId);
    expect(report).toHaveLength(6);
    expect(new Set(report.map((r) => r.company))).toEqual(new Set(['Company A', 'Company B']));
    expect(report.every((r) => Number(r.net_balance) > 0)).toBe(true);

    // Dispose A via the SERVICE first (zeroing its balances), so the team-wide
    // SQL that follows acts only on B.
    await scenario.disposeViaService(A.companyId, A.eventId);
    // Apply the SQL backfill — disposes B (A is already clean).
    await runBackfillSql('apply', scenario.teamId);

    // End state is identical across the two paths.
    const afterA = await scenario.value(A.investmentId);
    const afterB = await scenario.value(B.investmentId);
    for (const v of [afterA, afterB]) {
      expect(v.unrealizedValuationDateValue).toBeCloseTo(0, 2);
      expect(v.realizedTransactionDateValue).toBeCloseTo(realisedBefore, 2); // unchanged (0)
      expect(v.holdsTrackingAssets).toBe(false);
      expect(v.totalValuationDateValue).toBeCloseTo(0, 2);
    }

    // Neither path created a new event.
    expect(await scenario.countEvents()).toBe(eventsBefore);

    // Same artifacts written by both paths: 3 price-0 markdowns + 3 holder→issuer
    // transfers per company.
    const artA = await scenario.disposalArtifacts(A.companyId);
    const artB = await scenario.disposalArtifacts(B.companyId);
    expect(artA.marks).toHaveLength(3);
    expect(artB.marks).toHaveLength(3);
    expect(artA.transfers).toHaveLength(3);
    expect(artB.transfers).toHaveLength(3);
    expect(artA.marks.every((m) => m.price === 0)).toBe(true);
    expect(artB.marks.every((m) => m.price === 0)).toBe(true);
    expect(artB.transfers.every((t) => t.from_legal_entity_id === scenario.fundId)).toBe(true);

    // Re-running the SQL is a no-op (idempotent).
    const marksBefore = (await scenario.markdowns()).length;
    const transfersBefore = (await scenario.disposals()).length;
    await runBackfillSql('apply', scenario.teamId);
    expect((await scenario.markdowns()).length).toBe(marksBefore);
    expect((await scenario.disposals()).length).toBe(transfersBefore);

    // And the report is empty — nothing left to dispose.
    expect(await runBackfillSql('report', scenario.teamId)).toHaveLength(0);
  });
});
