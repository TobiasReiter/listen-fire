// Read tools for the valuations connector. Both are read-only (no access
// prompt) and call the existing tRPC procedures in-process via the caller.

import { z } from 'zod';
import { sql } from 'kysely';

import type { TopLevelTool } from '../server';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { getTrpcCaller, toolHandler } from '../trpc_caller';
import { getValuationsQb } from '../../../lib/kysely';
import { isReportableInvestment } from '../../trpc/views/reportableInvestments';
import { currentContext } from '../../../services/context';
import { getInvestmentsValuation } from '../../../lib/valuations/valuation';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import LegalEntityType from '../../../generated/kysely/valuations/LegalEntityType';

const COMPANY_LIKE_TYPES = [
  LegalEntityType.COMPANY,
  LegalEntityType.PORTFOLIO_COMPANY,
  LegalEntityType.SPV,
  LegalEntityType.FUND,
];

/** Resolve a company reference (id or slug) to its row, scoped to the team. */
async function resolveCompany(reference: string) {
  const ctx = currentContext();
  return getValuationsQb(['legal_entity'])
    .selectFrom('legal_entity')
    .select(['id', 'slug', 'name'])
    .where('team_id', '=', ctx.user.teamId as TeamId)
    .where((eb) =>
      eb.or([eb(sql<string>`legal_entity.id::text`, '=', reference), eb('slug', '=', reference)]),
    )
    .executeTakeFirst();
}

/** The own investing entities ("funds") the first-investment lookup considers. */
async function resolveFundIds(fund?: string): Promise<string[]> {
  const ctx = currentContext();
  let query = getValuationsQb(['legal_entity'])
    .selectFrom('legal_entity')
    .select('id')
    .where('team_id', '=', ctx.user.teamId as TeamId)
    .where('is_own_investing_entity', '=', true);
  if (fund) {
    query = query.where((eb) =>
      eb.or([eb(sql<string>`legal_entity.id::text`, '=', fund), eb('name', 'ilike', fund)]),
    );
  }
  const rows = await query.execute();
  return rows.map((r) => r.id);
}

/** The earliest investment into a company from the given funds, with its MOIC. */
async function firstInvestmentFrom({
  companyId,
  fundIds,
  currency,
  asOfDate,
}: {
  companyId: string;
  fundIds: string[];
  currency: CurrencyIsoCode;
  asOfDate: Date;
}) {
  if (fundIds.length === 0) return null;

  const ctx = currentContext();
  const earliest = await getValuationsQb(['investment', 'legal_entity', 'event', 'transaction'])
    .selectFrom('investment')
    .innerJoin('legal_entity as fund', 'fund.id', 'investment.investor_profile_id')
    .select([
      'investment.id',
      'investment.invested_at',
      'fund.id as fund_id',
      'fund.name as fund_name',
    ])
    .where('investment.team_id', '=', ctx.user.teamId as TeamId)
    // Reading an acquirer's funding must not report the equity we were handed
    // as consideration as if it were a round we bought into.
    .where(($) => isReportableInvestment($, { event: 'event' }))
    .where('investment.investment_profile_id', '=', companyId as never)
    .where('investment.investor_profile_id', 'in', fundIds as never[])
    .where('investment.invested_at', 'is not', null)
    .orderBy('investment.invested_at', 'asc')
    .limit(1)
    .executeTakeFirst();

  if (!earliest || !earliest.invested_at) return null;

  const valuation = await getInvestmentsValuation({
    investments: [{ id: earliest.id, date: earliest.invested_at }],
    asOfDate,
    fxDate: asOfDate,
    targetCurrency: currency,
  });
  const moic = valuation.investedTransactionDateValue
    ? valuation.totalValuationDateValue / valuation.investedTransactionDateValue
    : null;

  const date = earliest.invested_at;
  return {
    fund: { id: earliest.fund_id, name: earliest.fund_name },
    date: date.toISOString(),
    year: date.getUTCFullYear(),
    quarter: Math.floor(date.getUTCMonth() / 3) + 1,
    moic,
    invested: valuation.investedTransactionDateValue,
    realised: valuation.realizedCashTransactionDateValue,
    retained: valuation.retainedValue,
    currency,
  };
}

const getCompanyFunding: TopLevelTool = {
  title: 'Get company funding',
  description:
    "A company's full funding picture in one call: headline metrics (invested, retained, " +
    'realised, MOIC, latest round), its rounds and investors, the event-history timeline, and ' +
    'the changelog. Also returns firstInvestment — the quarter/year and MOIC of the earliest ' +
    'investment from your fund(s). Pass a fund (id or name) to scope firstInvestment to one fund; ' +
    'omit it to use the earliest across any of your funds.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    company: z.string().describe('Company id or slug'),
    currency: z.nativeEnum(CurrencyIsoCode).optional().describe('Target currency (default USD)'),
    asOfDate: z.string().optional().describe('Valuation/as-of date, ISO (default now)'),
    fund: z
      .string()
      .optional()
      .describe('Scope firstInvestment to this fund (id or name); omit for all funds'),
  },
  handler: (args) =>
    toolHandler(async () => {
      const { company, currency, asOfDate, fund } = args as {
        company: string;
        currency?: CurrencyIsoCode;
        asOfDate?: string;
        fund?: string;
      };
      const resolved = await resolveCompany(company);
      if (!resolved) throw new Error(`Company not found: ${company}`);

      const targetCurrency = currency ?? CurrencyIsoCode.USD;
      const asOf = asOfDate ? new Date(asOfDate) : new Date();
      const config = { currency: targetCurrency, valuationDate: asOf.toISOString() };
      const caller = getTrpcCaller();
      const company_ = caller.views.portfolio.company;

      const [overview, investors, eventHistory, changelog, firstInvestment] = await Promise.all([
        company_.getOverview({ slug: resolved.slug ?? resolved.id, config }),
        company_.getInvestorsSummary({ legalEntityId: resolved.id }),
        company_.getEventHistory({ companyId: resolved.id, config }),
        company_.getFundingChangelog({ legalEntityId: resolved.id }),
        firstInvestmentFrom({
          companyId: resolved.id,
          fundIds: await resolveFundIds(fund),
          currency: targetCurrency,
          asOfDate: asOf,
        }),
      ]);

      return {
        company: { id: resolved.id, slug: resolved.slug, name: resolved.name },
        firstInvestment,
        overview,
        investors,
        eventHistory,
        changelog,
      };
    }),
};

const findCompanies: TopLevelTool = {
  title: 'Find companies',
  description:
    'Search your companies by name across name, legal name, also-known-as, and other names. ' +
    'Pass several queries to resolve many companies at once; each returns ranked candidate ' +
    'matches so you can pick the right one before reading its funding.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    queries: z.array(z.string()).min(1).describe('Company names to look up'),
    limit: z.number().optional().describe('Max matches per query (default 10)'),
  },
  handler: (args) =>
    toolHandler(async () => {
      const { queries, limit } = args as { queries: string[]; limit?: number };
      const ctx = currentContext();
      const cap = limit ?? 10;

      const results: Record<string, unknown[]> = {};
      for (const query of queries) {
        const like = `%${query}%`;
        const rows = await getValuationsQb(['legal_entity'])
          .selectFrom('legal_entity as le')
          .select([
            'le.id',
            'le.name',
            'le.legal_name',
            'le.also_known_as',
            'le.other_names',
            'le.type',
          ])
          .where('le.team_id', '=', ctx.user.teamId as TeamId)
          .where('le.type', 'in', COMPANY_LIKE_TYPES)
          .where('le.is_portfolio', 'is distinct from', true)
          .where((eb) =>
            eb.or([
              eb('le.name', 'ilike', like),
              eb('le.legal_name', 'ilike', like),
              eb('le.also_known_as', 'ilike', like),
              eb(
                sql<boolean>`EXISTS (SELECT 1 FROM unnest(le.other_names) AS n WHERE n ILIKE ${like})`,
                '=',
                true,
              ),
            ]),
          )
          .limit(cap * 3)
          .execute();

        const q = query.toLowerCase();
        const matchedField = (r: (typeof rows)[number]): string => {
          if (r.name?.toLowerCase().includes(q)) return 'name';
          if (r.legal_name?.toLowerCase().includes(q)) return 'legal_name';
          if (r.also_known_as?.toLowerCase().includes(q)) return 'also_known_as';
          return 'other_names';
        };
        const rank = (r: (typeof rows)[number]): number => {
          const name = r.name?.toLowerCase() ?? '';
          const legal = r.legal_name?.toLowerCase() ?? '';
          if (name === q || legal === q) return 0;
          if (name.startsWith(q) || legal.startsWith(q)) return 1;
          return 2;
        };

        results[query] = rows
          .sort((a, b) => rank(a) - rank(b) || (a.name ?? '').localeCompare(b.name ?? ''))
          .slice(0, cap)
          .map((r) => ({
            id: r.id,
            name: r.name,
            legalName: r.legal_name,
            type: r.type,
            matchedField: matchedField(r),
          }));
      }
      return results;
    }),
};

export { getCompanyFunding, findCompanies };
