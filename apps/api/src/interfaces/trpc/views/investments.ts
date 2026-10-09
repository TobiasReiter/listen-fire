import { z } from 'zod';
import { QueryCreator, sql } from 'kysely';
import { formatDate } from 'date-fns';
import startCase from 'lodash/startCase';

import type { ExpressionBuilder, RawBuilder } from 'kysely';
import type { CrossSchemaDB } from '../../../lib/kysely';

import { trpc } from '../trpc';
import { getQb, jsonbAgg, jsonbBuildObject, sqlArray } from '../../../lib/kysely';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { currentContext } from '../../../services/context';
import { getInvestmentsValuation } from '../../../lib/valuations/valuation';
import { deriveInvestmentStatus } from '../../../lib/valuations/valuation/status';
import {
  applyPortfolioLens,
  portfolioLensSchema,
  withHoldingsLens,
  type AcquirerRef,
  type LensRow,
} from './portfolioLens';
import { isReportableInvestment } from './reportableInvestments';
import { MessageCollector, ProcessMessage } from '../../../lib/valuations/messages';
import { ProfileService } from '../../../services/profiles/profile';
import { notNull } from '../../../lib/utils/nullability';
import { getEnvVar } from '../../../lib/utils/environment';
import DB from '../../../generated/kysely/Database';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import { TeamId } from '../../../generated/kysely/core/Team';
import { LegalEntityId } from '../../../generated/kysely/valuations/LegalEntity';
import EventType from '../../../generated/kysely/valuations/EventType';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import LegalEntityType from '../../../generated/kysely/valuations/LegalEntityType';

import { getCountryByCode } from '#shared/constants/countries';

// The export's company link points at the AUTHENTICATED portfolio page (D47(b)
// — the public `/c/<slug>` profile did not survive the carve). A login-walled
// link in an export the team downloads is the right shape: the reader is
// already a member.
const webBaseUrl = () =>
  getEnvVar('WEB_BASE_URL', {
    devDefault: 'http://localhost:3003',
    because: 'exports link back into the app and need its public address',
  }).replace(/\/$/, '');

const currencyOptions = Object.values(CurrencyIsoCode) as unknown as readonly [
  keyof typeof CurrencyIsoCode,
  ...Array<keyof typeof CurrencyIsoCode>,
];

const entityTypeOptions = Object.values(LegalEntityType) as unknown as readonly [
  keyof typeof LegalEntityType,
  ...Array<keyof typeof LegalEntityType>,
];

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish();

const portfolioFilterSchema = z.object({
  name: z.string().nullish(),
  portfolioIds: z.array(z.string()).nullish(),
  fromDate: dateOnly,
  toDate: dateOnly,
  raisedFrom: dateOnly,
  raisedTo: dateOnly,
  coInvestors: z.array(z.string()).nullish(),
  themes: z.array(z.string()).nullish(),
  geos: z.array(z.string()).nullish(),
  entityTypes: z.array(z.enum(entityTypeOptions)).nullish(),
});

const getPortfolioCompaniesInput = z.object({
  filter: portfolioFilterSchema,
  config: z.object({
    currency: z.enum(currencyOptions).nullish(),
    portfolioIds: z.array(z.string()).nullish(),
    valuationDate: z.string().datetime().nullish(),
  }),
  // The one thing about the lens the row source has to know: whether a company
  // is going to be searchable by what it became. A surface that never offers
  // the choice leaves this out and gets the holdings answer.
  lens: portfolioLensSchema.optional(),
});

// The slice of the aliased schema the name predicate is actually built
// against.
type NamedCompany = { company: DB['legal_entity'] };

/**
 * "Is this the company whose name was typed into the search box?" — the three
 * names a company can be found under.
 *
 * The filter the base query applies is deliberately wider than this: it also
 * matches the name of the entity that acquired the company, so that a company
 * we now hold only through its acquirer keeps the row the acquirer's line is
 * minted from. This narrower question is asked again once the lines exist, to
 * drop the rows that survived only on their acquirer's account.
 */
function matchesCompanyName<T extends { company: unknown }, U extends keyof T>(
  $: ExpressionBuilder<T, U>,
  name: string,
): RawBuilder<boolean> {
  // The caller's table set is generic, so kysely cannot resolve `company.*`
  // through it; the predicate only ever reads that one alias, so build it
  // against that slice — a type-only narrowing of the very same builder.
  const $company = $ as unknown as ExpressionBuilder<NamedCompany, 'company'>;
  const pattern = `%${name}%`;

  // Coalesced because this is asked as a value as well as in a WHERE: a
  // company with no legal name did not match, and must not come back as an
  // unknown that reads as a match.
  return sql<boolean>`coalesce(${$company.or([
    $company('company.name', 'ilike', pattern),
    $company('company.legal_name', 'ilike', pattern),
    $company('company.also_known_as', 'ilike', pattern),
  ])}, false)`;
}

/**
 * Which projected lines the search box was asking for: the companies that
 * matched by their own name, plus every line holding shares a sale handed us —
 * that line exists because a matched row put it there, and it is the holding
 * the searcher is looking at.
 *
 * Under the investment lens this asks nothing new: no line carries swap value
 * there, and the SQL filter was already the narrow question.
 */
function survivesNameFilter(
  row: { matches_name_filter?: boolean } & Pick<LensRow, 'carriesSwapValue'>,
) {
  // The column is only selected when there is something to match against.
  return (row.matches_name_filter ?? true) || row.carriesSwapValue;
}

export function getBaseQuery({
  input,
  qb = getQb([
    'core.user',
    'valuations.event',
    'valuations.investment',
    'valuations.investment_attribution',
    'valuations.legal_entity',
    'valuations.asset',
    'valuations.asset_transfer',
    'valuations.transaction',
  ]),
}: {
  input: z.infer<typeof getPortfolioCompaniesInput>;
  qb?: QueryCreator<
    Pick<
      CrossSchemaDB,
      | 'core.user'
      | 'valuations.event'
      | 'valuations.investment'
      | 'valuations.investment_attribution'
      | 'valuations.legal_entity'
      | 'valuations.asset'
      | 'valuations.asset_transfer'
      | 'valuations.transaction'
    >
  >;
}) {
  const ctx = currentContext();

  const query = qb
    // Start from investment table as our base
    .selectFrom('valuations.investment as investment')
    // Join company (investee) details
    .innerJoin(
      'valuations.legal_entity as company',
      'company.id',
      'investment.investment_profile_id',
    )
    .leftJoin(
      'valuations.legal_entity as acquirer',
      'acquirer.id',
      'company.acquired_by_legal_entity_id',
    )
    .leftJoin(
      'valuations.legal_entity as acquired_by',
      'acquired_by.acquired_by_legal_entity_id',
      'company.id',
    )
    // Join investor details
    .innerJoin('valuations.legal_entity as investor', (join) =>
      join.on(($) =>
        $.and([
          $('investor.id', '=', $.ref('investment.investor_profile_id')),
          $.or([
            $('investor.is_own_investing_entity', '=', true),
            $('investor.is_portfolio', '=', true),
          ]),
        ]),
      ),
    )
    // Join to get the first investment date, which the list orders and filters on
    .innerJoinLateral(
      ($) =>
        $.selectFrom('valuations.investment as first_investment')
          .innerJoin('valuations.legal_entity as investor', (join) =>
            join.on(($) =>
              $.and([
                $('investor.id', '=', $.ref('first_investment.investor_profile_id')),
                $.or([
                  $('investor.is_own_investing_entity', '=', true),
                  $('investor.is_portfolio', '=', true),
                ]),
              ]),
            ),
          )
          .select([
            'first_investment.investment_profile_id',
            'first_investment.invested_at as first_invested_at',
          ])
          .where('first_investment.investment_profile_id', '=', $.ref('company.id'))
          .orderBy('first_investment.invested_at', 'asc')
          .limit(1)
          .as('first_investment'),
      (join) => join.onTrue(),
    )
    .leftJoin('core.user as u', 'u.id', 'company.point_of_contact_user_id')
    .leftJoin(
      'valuations.legal_entity as point_of_contact',
      'point_of_contact.id',
      'u.public_profile_id',
    )
    // Optional: Join attribution data to track deal leads
    .leftJoin(
      'valuations.investment_attribution as investment_attribution',
      'investment_attribution.investment_id',
      'investment.id',
    )
    // Optional: Join attributed entity details
    .leftJoin(
      'valuations.legal_entity as attributed',
      'attributed.id',
      'investment_attribution.legal_entity_id',
    )
    .where('company.team_id', '=', ctx.user.teamId as TeamId) // Team-level access control
    .where('investment.team_id', '=', ctx.user.teamId as TeamId) // Team-level access control
    // Value only the rows we report on: the equity taken as acquisition
    // consideration is already counted in the acquired company's realised
    // value, so surfacing the acquirer as its own portfolio row double-counts.
    .where(($) => isReportableInvestment($, { event: 'valuations.event' }))
    // Only show companies where we have invested through our entities
    .where(($) =>
      $.exists(
        $.selectFrom('valuations.investment as filter_inv')
          .innerJoin(
            'valuations.legal_entity as filter_investor',
            'filter_investor.id',
            'filter_inv.investor_profile_id',
          )
          .where('filter_inv.investment_profile_id', '=', $.ref('company.id'))
          .where(($) =>
            $.or([
              $('filter_investor.is_own_investing_entity', '=', true),
              $('filter_investor.is_portfolio', '=', true),
            ]),
          )
          // Same question as the row filter above, asked of the company: an
          // acquirer earns a line by having been invested into, and equity
          // handed to us as consideration is not that.
          .where(($) =>
            isReportableInvestment($, { event: 'valuations.event', investment: 'filter_inv' }),
          )
          // Filter by specific portfolio if requested
          .$if(!!input.filter.portfolioIds?.length, (qb) =>
            qb.where('filter_investor.id', 'in', input.filter.portfolioIds as LegalEntityId[]),
          )
          // Date range filters
          .$if(!!input.filter.fromDate, (qb) =>
            qb.where('filter_inv.invested_at', '>=', new Date(input.filter.fromDate!)),
          )
          .$if(!!input.filter.toDate, (qb) =>
            qb.where('filter_inv.invested_at', '<=', new Date(input.filter.toDate!)),
          )
          .$if(!!input.config.valuationDate, (qb) =>
            qb.where('filter_inv.invested_at', '<=', new Date(input.config.valuationDate!)),
          )
          // Filter by themes
          .$if(!!input.filter.themes?.length, (qb) =>
            qb.where('company.themes', '&&', sqlArray(input.filter.themes!)),
          )
          // Filter by geos
          .$if(!!input.filter.geos?.length, (qb) =>
            qb.where('company.country', 'in', input.filter.geos!),
          ),
      ),
    )
    // Filter by co-investors - shows deals where specified investors also participated
    .$if(!!input.filter.coInvestors?.length, (qb) =>
      qb.where(($) =>
        $.exists(
          $.selectFrom('valuations.investment as i')
            .where('i.investor_profile_id', 'in', input.filter.coInvestors as LegalEntityId[])
            .where('i.investment_profile_id', '=', $.ref('company.id')),
        ),
      ),
    )
    // Filter by "raised between" - companies with a funding round in the range
    .$if(!!input.filter.raisedFrom || !!input.filter.raisedTo, (qb) =>
      qb.where(($) =>
        $.exists(
          $.selectFrom('valuations.event as round')
            .where('round.type', '=', EventType.INVESTMENT_ROUND)
            .where('round.legal_entity_id', '=', $.ref('company.id'))
            .$if(!!input.filter.raisedFrom, (q) =>
              q.where('round.date', '>=', new Date(input.filter.raisedFrom!)),
            )
            .$if(!!input.filter.raisedTo, (q) =>
              q.where('round.date', '<=', new Date(input.filter.raisedTo!)),
            ),
        ),
      ),
    )
    .$if(!!input.filter.entityTypes?.length, (qb) =>
      qb.where('company.type', 'in', input.filter.entityTypes as LegalEntityType[]),
    )
    // Matching the acquirer's name too is what makes a company searchable by
    // what it became: its own row is the only place the value lives until the
    // holdings projection moves it onto the acquirer's line. Under the
    // investment lens no line is ever minted for an acquirer, so widening the
    // search to reach one would only return companies nobody asked for.
    .$if(!!input.filter.name, (qb) =>
      qb.where(($) =>
        input.lens === 'investment'
          ? matchesCompanyName($, input.filter.name!)
          : $.or([
              matchesCompanyName($, input.filter.name!),
              $('acquirer.name', 'ilike', `%${input.filter.name}%`),
            ]),
      ),
    )
    .$if(!!input.config.portfolioIds?.length, (qb) =>
      qb.where('investor.id', 'in', input.config.portfolioIds as LegalEntityId[]),
    );

  return query;
}

const investmentsRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    getPortfolioInvestments: userProcedure
      .input(
        z.object({
          filter: portfolioFilterSchema,
          config: z.object({
            portfolioIds: z.array(z.string()).nullish(),
            currency: z.enum(currencyOptions).nullish(),
            valuationDate: z.string().date().nullish(),
            showDetails: z.boolean().nullish(),
            aggregation: z.enum(['company', 'investment']).default('company'),
          }),
          grouping: z.enum(['investment_date', 'moic', 'fair_value', 'total_value']).nullish(),
          lens: portfolioLensSchema,
        }),
      )
      .query(async ({ input }) => {
        // The holdings projection is over the whole portfolio, not over a page
        // of it: one acquirer line carries the value moved off every company
        // that acquirer bought, and those companies can sit on any page.
        // Projecting a page at a time mints one acquirer line per page, each
        // holding a slice of the value — the duplicate rows reported from
        // prod. So the list comes back whole.

        // Initialize query builder with required tables
        const query = getBaseQuery({ input })
          // Filter by specific portfolio if requested
          .$if(!!input.filter.portfolioIds?.length, (qb) =>
            qb.where('investor.id', 'in', input.filter.portfolioIds as LegalEntityId[]),
          )
          // Date range filters
          .$if(!!input.filter.fromDate && input.config.aggregation === 'investment', (qb) =>
            qb.where('investment.invested_at', '>=', new Date(input.filter.fromDate!)),
          )
          .$if(!!input.filter.toDate && input.config.aggregation === 'investment', (qb) =>
            qb.where('investment.invested_at', '<=', new Date(input.filter.toDate!)),
          )
          .$if(!!input.filter.fromDate && input.config.aggregation === 'company', (qb) =>
            qb.where('first_investment.first_invested_at', '>=', new Date(input.filter.fromDate!)),
          )
          .$if(!!input.filter.toDate && input.config.aggregation === 'company', (qb) =>
            qb.where('first_investment.first_invested_at', '<=', new Date(input.filter.toDate!)),
          )
          .$if(!!input.config.valuationDate, (qb) =>
            qb.where('investment.invested_at', '<=', new Date(input.config.valuationDate!)),
          )
          .select(($) => [
            // Basic company information
            'company.name',
            'company.image_url',
            'company.id as legal_entity_id',
            'company.slug',
            'company.personal_website',
            'company.country',
            'company.short_description',
            'company.acquired_by_legal_entity_id',
            $.fn.agg<string[]>('ARRAY_AGG', ['investment.id']).as('investment_ids'),
            // Aggregate investments
            $.fn
              .agg<{ id: string; date: Date; type: string }[]>('JSONB_AGG', [
                jsonbBuildObject($, {
                  id: 'investment.id',
                  date: 'investment.invested_at',
                  type: 'investment.type',
                }),
              ])
              .distinct()
              .as('investments'),
            $.fn
              .agg('BOOL_AND', [
                $(
                  'investment.fully_exited_at',
                  '<',
                  input.config.valuationDate ? new Date(input.config.valuationDate) : new Date(),
                ),
              ])
              .as('is_exited'),
            $.fn.min('first_investment.first_invested_at').as('first_invested_at'),
            // Point of contact
            jsonbBuildObject($, {
              id: 'u.id',
              name: $.fn.coalesce('point_of_contact.name', 'u.username'),
              image_url: 'point_of_contact.image_url',
            }).as('point_of_contact'),
            jsonbBuildObject($, {
              id: 'acquirer.id',
              name: 'acquirer.name',
              image_url: 'acquirer.image_url',
              slug: 'acquirer.slug',
            }).as('acquirer'),
            $.fn
              .agg<{ id: string; name: string; image_url: string | null; slug: string | null }[]>(
                'JSONB_AGG',
                [
                  jsonbBuildObject($, {
                    id: 'acquired_by.id',
                    name: 'acquired_by.name',
                    image_url: 'acquired_by.image_url',
                    slug: 'acquired_by.slug',
                  }),
                ],
              )
              .distinct()
              .filterWhere('acquired_by.id', 'is not', null)
              .as('acquired_by'),
            // Aggregate deal leads (attributions) for this investment
            $.fn
              .agg<{ name: string; image_url: string | null }[]>('JSONB_AGG', [
                jsonbBuildObject($, {
                  name: 'attributed.name',
                  image_url: 'attributed.image_url',
                }),
              ])
              .distinct()
              .as('attributions'),
            // Aggregate all of our investing entities we've used to invest in this company
            $.fn
              .agg<{ name: string; image_url: string | null }[]>('JSONB_AGG', [
                jsonbBuildObject($, {
                  name: 'investor.name',
                  image_url: 'investor.image_url',
                }),
              ])
              .distinct()
              .as('investors'),
            // Subquery to get all co-investors in this company
            $.selectFrom('valuations.legal_entity as co_investor')
              .innerJoin('valuations.investment as i', 'i.investor_profile_id', 'co_investor.id')
              .where('i.investment_profile_id', '=', $.ref('company.id'))
              .select(($) => [
                $.fn
                  .agg<{ id: string; name: string }[]>('JSONB_AGG', [
                    jsonbBuildObject($, {
                      id: 'co_investor.id',
                      name: 'co_investor.name',
                    }),
                  ])
                  .distinct()
                  .as('co_investors'),
              ])
              .as('co_investors'),
          ])
          .$if(!!input.config.showDetails, (qb) =>
            qb
              .select('company.themes')
              .select(($) =>
                $.selectFrom('valuations.event as e')
                  .select(($) =>
                    jsonbBuildObject($, {
                      date: 'e.date',
                      name: $.fn.coalesce('e.name', $.cast('e.round_type', 'text')),
                      raisedAmount: $.ref('e.raised_amount'),
                      raisedCurrency: $.ref('e.raised_currency'),
                      valuationAmount: $.ref('e.valuation'),
                      valuationCurrency: $.ref('e.valuation_currency'),
                      valuationType: $.ref('e.valuation_type'),
                    }).as('data'),
                  )
                  .where('e.type', '=', EventType.INVESTMENT_ROUND)
                  .where('e.legal_entity_id', '=', $.ref('company.id'))
                  .orderBy('e.date', 'desc')
                  .limit(1)
                  .as('latest_round'),
              )
              .select(($) =>
                $.selectFrom('valuations.legal_entity as coinvestors')
                  .innerJoin(
                    'valuations.investment as ii',
                    'ii.investor_profile_id',
                    'coinvestors.id',
                  )
                  .where('ii.investment_profile_id', '=', $.ref('company.id'))
                  .where(($) =>
                    $.and([
                      $('coinvestors.is_portfolio', 'is distinct from', true),
                      $('coinvestors.is_own_investing_entity', 'is distinct from', true),
                    ]),
                  )
                  .select(($) =>
                    $.fn.agg<string[]>('ARRAY_AGG', ['coinvestors.name']).as('co_investors'),
                  )
                  .as('co_investors'),
              )
              .select('company.description'),
          )
          // Group all data by company
          .groupBy(['company.id', 'u.id', 'acquirer.id', 'point_of_contact.id'])
          .$if(input.config.aggregation === 'investment', (qb) => qb.groupBy('investment.id'))
          .$if(
            input.grouping === 'investment_date' && input.config.aggregation === 'company',
            (qb) => qb.orderBy(($) => $.fn.min('first_investment.first_invested_at'), 'desc'),
          )
          .$if(
            input.grouping === 'investment_date' && input.config.aggregation === 'investment',
            (qb) => qb.orderBy('investment.invested_at', 'desc'),
          )
          .$if(!!input.filter.name, (qb) =>
            qb.select(($) => matchesCompanyName($, input.filter.name!).as('matches_name_filter')),
          );

        const baseInvestments = await query.execute();

        const investments = baseInvestments.map((investment) => {
          return {
            ...investment,
            totalInvested: 0 as number | null,
            currentValueCurrency: input.config.currency ?? 'USD',
            moic: null as number | null,
            unrealizedValue: 0,
            realizedValue: 0,
            realizedCash: 0,
            totalValue: 0,
            // The retained pair the projection moves value between: everything
            // still held that traces back here, and the part of it still
            // tracking this company. `unrealizedValue` stays the field the list
            // reads, set from `retainedAll` once the projection has had its say.
            retainedAll: 0,
            retainedInCompany: 0,
            holdsRetainedAssets: false,
            holdsTrackingAssets: false,
            carriesSwapValue: false,
          };
        });

        await Promise.all(
          investments.map(async (investment) => {
            const {
              totalValuationDateValue,
              retainedValue,
              unrealizedValuationDateValue,
              realizedCashTransactionDateValue,
              investedTransactionDateValue,
              holdsRetainedAssets,
              holdsTrackingAssets,
            } = await getInvestmentsValuation({
              investments: investment.investments,
              targetCurrency: (input.config.currency as CurrencyIsoCode) ?? CurrencyIsoCode.USD,
              asOfDate: input.config.valuationDate
                ? new Date(input.config.valuationDate)
                : new Date(),
              fxDate: input.config.valuationDate
                ? new Date(input.config.valuationDate)
                : new Date(),
            });
            investment.moic = investedTransactionDateValue
              ? totalValuationDateValue / investedTransactionDateValue
              : null;
            investment.totalInvested = investedTransactionDateValue;
            // The list headlines the full pair: everything still held (in the
            // company or in what it became) against every pound taken out.
            investment.unrealizedValue = retainedValue;
            investment.retainedAll = retainedValue;
            investment.retainedInCompany = unrealizedValuationDateValue;
            investment.holdsRetainedAssets = holdsRetainedAssets;
            investment.holdsTrackingAssets = holdsTrackingAssets;
            investment.realizedValue = realizedCashTransactionDateValue;
            investment.realizedCash = realizedCashTransactionDateValue;
            investment.totalValue = totalValuationDateValue;
          }),
        );

        // The totals row adds up the very atoms this list just valued, so it
        // comes back with the list rather than as a second pass over the same
        // portfolio. Summed BEFORE the projection, deliberately: moving
        // retained value from a company to its acquirer moves it between lines
        // and never changes what they add up to — the same invariance
        // `getPortfolioTotals` relies on, and the same rows it reads.
        const totals = investments.reduce(
          (running, investment) => ({
            totalInvested: running.totalInvested + (investment.totalInvested ?? 0),
            unrealizedValue: running.unrealizedValue + investment.retainedAll,
            realizedValue: running.realizedValue + investment.realizedCash,
            totalValue: running.totalValue + investment.totalValue,
          }),
          { totalInvested: 0, unrealizedValue: 0, realizedValue: 0, totalValue: 0 },
        );

        type ListRow = (typeof investments)[number];

        // A line for value we hold in an acquirer we never invested into: the
        // holding, and nothing about an investment decision we never made.
        const deriveAcquirerRow = (source: ListRow, acquirer: AcquirerRef): ListRow => ({
          ...source,
          name: acquirer.name,
          legal_entity_id: acquirer.id as LegalEntityId,
          slug: acquirer.slug,
          image_url: acquirer.image_url,
          personal_website: null,
          country: null,
          short_description: null,
          acquired_by_legal_entity_id: null,
          acquirer: { ...source.acquirer, name: '', image_url: null, slug: null },
          point_of_contact: { ...source.point_of_contact, name: '', image_url: null },
          acquired_by: [],
          attributions: [],
          co_investors: null,
          themes: null,
          description: null,
          latest_round: null,
          investments: [],
          investment_ids: [],
          is_exited: false,
          totalInvested: null,
          moic: null,
          unrealizedValue: 0,
          realizedValue: 0,
          realizedCash: 0,
          totalValue: 0,
          retainedAll: 0,
          retainedInCompany: 0,
          holdsRetainedAssets: false,
          holdsTrackingAssets: false,
          carriesSwapValue: false,
        });

        const items = applyPortfolioLens({
          lens: input.lens,
          rows: investments,
          mergeByCompany: input.config.aggregation !== 'investment',
          deriveAcquirerRow,
        }).filter(survivesNameFilter);
        for (const row of items) {
          row.unrealizedValue = row.retainedAll;
        }

        const portfolioTotals = {
          ...totals,
          moic: totals.totalInvested ? totals.totalValue / totals.totalInvested : null,
          currency: input.config.currency ?? 'USD',
        };

        if (input.grouping === 'moic') {
          items.sort((a, b) => (b.moic ?? 0) - (a.moic ?? 0));
        } else if (input.grouping === 'fair_value') {
          items.sort((a, b) => (b.unrealizedValue ?? 0) - (a.unrealizedValue ?? 0));
        } else if (input.grouping === 'total_value') {
          items.sort((a, b) => (b.totalValue ?? 0) - (a.totalValue ?? 0));
        }

        return { items, totals: portfolioTotals };
      }),
    /**
     * How one line of the portfolio list got its numbers — the same walk the
     * list runs, narrated. The narration is four times the size of every number
     * on the page put together, and a reader opens it for one company at a
     * time, so it is asked for when the "How this was calculated" panel opens
     * rather than carried on every row of every load.
     */
    getInvestmentCalculation: userProcedure
      .input(
        z.object({
          investments: z.array(
            z.object({
              id: z.string(),
              date: z.coerce.date().nullable(),
            }),
          ),
          config: z.object({
            currency: z.enum(currencyOptions).nullish(),
            valuationDate: z.string().date().nullish(),
          }),
        }),
      )
      .query(async ({ input }) => {
        if (!input.investments.length) return { message: [] as ProcessMessage[] };

        const messageCollector = new MessageCollector();
        const currency = input.config.currency ?? 'USD';
        const at = input.config.valuationDate ? new Date(input.config.valuationDate) : new Date();

        const {
          totalValuationDateValue,
          totalTransactionDateValue,
          investedTransactionDateValue,
        } = await getInvestmentsValuation({
          investments: input.investments,
          targetCurrency: (input.config.currency as CurrencyIsoCode) ?? CurrencyIsoCode.USD,
          messageCollector,
          asOfDate: at,
          fxDate: at,
        });

        const moic = investedTransactionDateValue
          ? totalValuationDateValue / investedTransactionDateValue
          : null;
        messageCollector.header('MOIC');
        messageCollector.text(
          `Calculated as total value / total invested (${totalValuationDateValue.toFixed(2)} / ${investedTransactionDateValue?.toFixed(2)})`,
        );
        messageCollector.text(`MOIC: ${moic}`);
        messageCollector.header('Movement');
        const totalMovement =
          investedTransactionDateValue === null
            ? null
            : totalValuationDateValue - investedTransactionDateValue;
        const fxMovement = totalValuationDateValue - totalTransactionDateValue;
        const fairValueMovement = totalMovement === null ? null : totalMovement - fxMovement;
        messageCollector.text(`Total Movement: ${totalMovement?.toFixed(2)} ${currency}`);
        messageCollector.text(`FX Movement: ${fxMovement.toFixed(2)} ${currency}`);
        messageCollector.text(`Fair Value Movement: ${fairValueMovement?.toFixed(2)} ${currency}`);
        messageCollector.text(`Total Movement: ${totalMovement?.toFixed(2)} ${currency}`);

        return { message: messageCollector.getMessages() };
      }),
    getPortfolioTotals: userProcedure
      .input(
        z.object({
          filter: portfolioFilterSchema,
          config: z.object({
            portfolioIds: z.array(z.string()).nullish(),
            currency: z.enum(currencyOptions).nullish(),
            valuationDate: z.string().date().nullish(),
            aggregation: z.enum(['company', 'investment']).default('company'),
          }),
        }),
      )
      // No projection here, deliberately: moving retained value from a company
      // to its acquirer moves it between lines, and these totals sum the same
      // atoms whichever line carries them. That invariance is the point.
      .query(async ({ input }) => {
        const query = getBaseQuery({ input })
          .$if(!!input.filter.portfolioIds?.length, (qb) =>
            qb.where('investor.id', 'in', input.filter.portfolioIds as LegalEntityId[]),
          )
          .$if(!!input.filter.fromDate && input.config.aggregation === 'investment', (qb) =>
            qb.where('investment.invested_at', '>=', new Date(input.filter.fromDate!)),
          )
          .$if(!!input.filter.toDate && input.config.aggregation === 'investment', (qb) =>
            qb.where('investment.invested_at', '<=', new Date(input.filter.toDate!)),
          )
          .$if(!!input.filter.fromDate && input.config.aggregation === 'company', (qb) =>
            qb.where('first_investment.first_invested_at', '>=', new Date(input.filter.fromDate!)),
          )
          .$if(!!input.filter.toDate && input.config.aggregation === 'company', (qb) =>
            qb.where('first_investment.first_invested_at', '<=', new Date(input.filter.toDate!)),
          )
          .$if(!!input.config.valuationDate, (qb) =>
            qb.where('investment.invested_at', '<=', new Date(input.config.valuationDate!)),
          )
          .select(($) => [
            'company.id as legal_entity_id',
            $.fn
              .agg<{ id: string; date: Date; type: string }[]>('JSONB_AGG', [
                jsonbBuildObject($, {
                  id: 'investment.id',
                  date: 'investment.invested_at',
                  type: 'investment.type',
                }),
              ])
              .distinct()
              .as('investments'),
          ])
          .groupBy(['company.id'])
          .$if(input.config.aggregation === 'investment', (qb) => qb.groupBy('investment.id'));

        const rows = await query.execute();

        let totalInvested = 0;
        let totalUnrealized = 0;
        let totalRealized = 0;
        let totalValue = 0;

        await Promise.all(
          rows.map(async (row) => {
            const {
              totalValuationDateValue,
              retainedValue,
              realizedCashTransactionDateValue,
              investedTransactionDateValue,
            } = await getInvestmentsValuation({
              investments: row.investments,
              targetCurrency: (input.config.currency as CurrencyIsoCode) ?? CurrencyIsoCode.USD,
              messageCollector: new MessageCollector(),
              asOfDate: input.config.valuationDate
                ? new Date(input.config.valuationDate)
                : new Date(),
              fxDate: input.config.valuationDate
                ? new Date(input.config.valuationDate)
                : new Date(),
            });
            totalInvested += investedTransactionDateValue ?? 0;
            totalUnrealized += retainedValue;
            totalRealized += realizedCashTransactionDateValue;
            totalValue += totalValuationDateValue;
          }),
        );

        const moic = totalInvested ? totalValue / totalInvested : null;

        return {
          totalInvested,
          unrealizedValue: totalUnrealized,
          realizedValue: totalRealized,
          totalValue,
          moic,
          currency: input.config.currency ?? 'USD',
        };
      }),
    updatePointOfContact: userProcedure
      .input(
        z.object({
          legalEntityId: z.string(),
          pointOfContactUserId: z.string().nullish(),
        }),
      )
      .mutation(async ({ input }) => {
        const { legalEntityId, pointOfContactUserId } = input;

        await ProfileService.update(legalEntityId, {
          pointOfContactUserId,
        });
      }),
    getCountryOptions: userProcedure
      .input(
        z.object({
          filter: portfolioFilterSchema,
          config: z.object({
            portfolioIds: z.array(z.string()).nullish(),
            currency: z.enum(currencyOptions).nullish(),
            valuationDate: z.string().date().nullish(),
            showDetails: z.boolean().nullish(),
          }),
        }),
      )
      .query(async ({ input }) => {
        const countries = await getBaseQuery({ input })
          .select(($) => [
            $.fn.agg<string[] | null>('ARRAY_AGG', ['company.country']).distinct().as('countries'),
          ])
          .executeTakeFirstOrThrow();

        return countries.countries?.filter(notNull);
      }),
    getYearOptions: userProcedure
      .input(
        z.object({
          filter: portfolioFilterSchema,
          config: z.object({
            portfolioIds: z.array(z.string()).nullish(),
            currency: z.enum(currencyOptions).nullish(),
            valuationDate: z.string().date().nullish(),
            showDetails: z.boolean().nullish(),
          }),
          scope: z.enum(['company', 'investment']).default('company'),
        }),
      )
      .query(async ({ input }) => {
        const years = await getBaseQuery({
          input: {
            filter: {
              ...input.filter,
              fromDate: undefined,
              toDate: undefined,
            },
            config: input.config,
          },
        })
          .select(($) => [
            $.fn
              .agg<string[] | null>('ARRAY_AGG', [
                $.fn('TO_CHAR', [
                  input.scope === 'company'
                    ? 'first_investment.first_invested_at'
                    : 'investment.invested_at',
                  sql.lit('YYYY'),
                ]),
              ])
              .distinct()
              .as('years'),
          ])
          .executeTakeFirstOrThrow();

        return years.years?.filter(notNull);
      }),

    getCSVExport: userProcedure
      .input(
        z.object({
          filter: portfolioFilterSchema,
          config: z.object({
            portfolioIds: z.array(z.string()).nullish(),
            currency: z.enum(currencyOptions).nullish(),
            valuationDate: z.string().date().nullish(),
            showDetails: z.boolean().nullish(),
            aggregation: z.enum(['company', 'investment']).nullish(),
          }),
          grouping: z.enum(['investment_date', 'moic', 'fair_value', 'total_value']),
        }),
      )
      .mutation(async ({ input }) => {
        // Initialize query builder with required tables
        const query = getBaseQuery({ input })
          // Filter by specific portfolio if requested
          .$if(!!input.filter.portfolioIds?.length, (qb) =>
            qb.where('investor.id', 'in', input.filter.portfolioIds as LegalEntityId[]),
          )
          // Date range filters
          .$if(!!input.filter.fromDate && input.config.aggregation === 'investment', (qb) =>
            qb.where('investment.invested_at', '>=', new Date(input.filter.fromDate!)),
          )
          .$if(!!input.filter.toDate && input.config.aggregation === 'investment', (qb) =>
            qb.where('investment.invested_at', '<=', new Date(input.filter.toDate!)),
          )
          .$if(!!input.filter.fromDate && input.config.aggregation === 'company', (qb) =>
            qb.where('first_investment.first_invested_at', '>=', new Date(input.filter.fromDate!)),
          )
          .$if(!!input.filter.toDate && input.config.aggregation === 'company', (qb) =>
            qb.where('first_investment.first_invested_at', '<=', new Date(input.filter.toDate!)),
          )
          .$if(!!input.config.valuationDate, (qb) =>
            qb.where('investment.invested_at', '<=', new Date(input.config.valuationDate!)),
          )
          .select(($) => [
            // Basic company information
            'company.name',
            'company.legal_name',
            'company.image_url',
            'company.id as legal_entity_id',
            'company.slug',
            'company.personal_website',
            'company.country',
            'company.short_description',
            'company.acquired_by_legal_entity_id',
            $.fn.agg<string[]>('ARRAY_AGG', ['investment.id']).as('investment_ids'),
            // Aggregate investments
            $.fn
              .agg<{ id: string; date: Date; type: string }[]>('JSONB_AGG', [
                jsonbBuildObject($, {
                  id: 'investment.id',
                  date: 'investment.invested_at',
                  type: 'investment.type',
                }),
              ])
              .distinct()
              .as('investments'),
            $.fn
              .agg('BOOL_AND', [
                $(
                  'investment.fully_exited_at',
                  '<',
                  input.config.valuationDate ? new Date(input.config.valuationDate) : new Date(),
                ),
              ])
              .as('is_exited'),
            $.fn.min('first_investment.first_invested_at').as('first_invested_at'),
            // Point of contact
            jsonbBuildObject($, {
              id: 'u.id',
              name: $.fn.coalesce('point_of_contact.name', 'u.username'),
              image_url: 'point_of_contact.image_url',
            }).as('point_of_contact'),
            jsonbBuildObject($, {
              id: 'acquirer.id',
              name: 'acquirer.name',
              image_url: 'acquirer.image_url',
              slug: 'acquirer.slug',
            }).as('acquirer'),
            $.fn
              .agg<{ id: string; name: string; image_url: string | null; slug: string | null }[]>(
                'JSONB_AGG',
                [
                  jsonbBuildObject($, {
                    id: 'acquired_by.id',
                    name: 'acquired_by.name',
                    image_url: 'acquired_by.image_url',
                    slug: 'acquired_by.slug',
                  }),
                ],
              )
              .distinct()
              .filterWhere('acquired_by.id', 'is not', null)
              .as('acquired_by'),
            // Aggregate deal leads (attributions) for this investment
            $.fn
              .agg<{ name: string; image_url: string | null }[]>('JSONB_AGG', [
                jsonbBuildObject($, {
                  name: 'attributed.name',
                  image_url: 'attributed.image_url',
                }),
              ])
              .distinct()
              .as('attributions'),
            // Aggregate all of our investing entities we've used to invest in this company
            $.fn
              .agg<{ name: string; image_url: string | null }[]>('JSONB_AGG', [
                jsonbBuildObject($, {
                  name: 'investor.name',
                  image_url: 'investor.image_url',
                }),
              ])
              .distinct()
              .as('investors'),
            // Subquery to get all co-investors in this company
            $.selectFrom('valuations.legal_entity as co_investor')
              .innerJoin('valuations.investment as i', 'i.investor_profile_id', 'co_investor.id')
              .where('i.investment_profile_id', '=', $.ref('company.id'))
              .select(($) => [
                $.fn
                  .agg<{ id: string; name: string }[]>('JSONB_AGG', [
                    jsonbBuildObject($, {
                      id: 'co_investor.id',
                      name: 'co_investor.name',
                    }),
                  ])
                  .distinct()
                  .as('co_investors'),
              ])
              .as('co_investors'),
            $.selectFrom('valuations.event as e')
              .select(($) =>
                jsonbAgg($, {
                  date: 'e.date',
                  name: $.fn.coalesce('e.name', $.cast('e.round_type', 'text')),
                  raisedAmount: $.ref('e.raised_amount'),
                  raisedCurrency: $.ref('e.raised_currency'),
                  valuationAmount: $.ref('e.valuation'),
                  valuationCurrency: $.ref('e.valuation_currency'),
                  valuationType: $.ref('e.valuation_type'),
                }).as('data'),
              )
              .where('e.type', '=', EventType.INVESTMENT_ROUND)
              .where(
                'e.id',
                '=',
                $.fn('ANY', [$.fn.agg('ARRAY_AGG', ['investment.event_id'])]) as any,
              )
              .as('investment_rounds'),
            $.selectFrom('valuations.transaction as t')
              .innerJoin('valuations.asset_transfer as at', 'at.transaction_id', 't.id')
              .innerJoin('valuations.asset as a', 'a.id', 'at.asset_id')
              .where(
                't.investment_id',
                '=',
                $.fn('ANY', [$.fn.agg('ARRAY_AGG', ['investment.id'])]) as any,
              )
              .select(($) => [
                $.fn
                  .agg<string>('STRING_AGG', [
                    $.case('a.type')
                      .when(AssetType.CONVERTIBLE)
                      .then('Convertible')
                      .when(AssetType.EQUITY)
                      .then('Equity')
                      .when(AssetType.LP_INTEREST_POINT)
                      .then('Fund')
                      .when(AssetType.SPV_INTEREST_POINT)
                      .then('SPV')
                      .else(null)
                      .end(),
                    sql.lit(', '),
                  ])
                  .distinct()
                  .filterWhere('a.type', 'in', [
                    AssetType.CONVERTIBLE,
                    AssetType.EQUITY,
                    AssetType.LP_INTEREST_POINT,
                    AssetType.SPV_INTEREST_POINT,
                  ])
                  .as('asset_types'),
              ])
              .as('assets'),
          ])
          .$if(input.config.aggregation === 'investment', (qb) =>
            qb.select(($) => [
              'investment.id as single_investment_id',
              $.selectFrom('valuations.transaction as ft')
                .select('ft.id')
                .where('ft.investment_id', '=', $.ref('investment.id'))
                .orderBy('ft.close_date', 'asc')
                .limit(1)
                .as('first_transaction_id'),
              $.exists(
                $.selectFrom('valuations.transaction as ct')
                  .innerJoin('valuations.asset_transfer as cat', 'cat.transaction_id', 'ct.id')
                  .innerJoin('valuations.asset as ca', 'ca.id', 'cat.asset_id')
                  .where('ct.investment_id', '=', $.ref('investment.id'))
                  .where('ca.type', '=', AssetType.CONVERTIBLE)
                  .where('ca.conversion_date', 'is not', null)
                  .where(
                    'ca.conversion_date',
                    '<=',
                    input.config.valuationDate ? new Date(input.config.valuationDate) : new Date(),
                  ),
              ).as('has_converted'),
            ]),
          )
          .$if(!!input.config.showDetails, (qb) =>
            qb
              .select('company.themes')
              .select(($) =>
                $.selectFrom('valuations.event as e')
                  .select(($) =>
                    jsonbBuildObject($, {
                      date: 'e.date',
                      name: $.fn.coalesce('e.name', $.cast('e.round_type', 'text')),
                      raisedAmount: $.ref('e.raised_amount'),
                      raisedCurrency: $.ref('e.raised_currency'),
                      valuationAmount: $.ref('e.valuation'),
                      valuationCurrency: $.ref('e.valuation_currency'),
                      valuationType: $.ref('e.valuation_type'),
                    }).as('data'),
                  )
                  .where('e.type', '=', EventType.INVESTMENT_ROUND)
                  .where('e.legal_entity_id', '=', $.ref('company.id'))
                  .orderBy('e.date', 'desc')
                  .limit(1)
                  .as('latest_round'),
              )
              .select(($) =>
                $.selectFrom('valuations.legal_entity as coinvestors')
                  .innerJoin(
                    'valuations.investment as ii',
                    'ii.investor_profile_id',
                    'coinvestors.id',
                  )
                  .where('ii.investment_profile_id', '=', $.ref('company.id'))
                  .where(($) =>
                    $.or([
                      $(
                        'ii.event_id',
                        '=',
                        $.fn('ANY', [$.fn.agg('ARRAY_AGG', ['investment.event_id'])]) as any,
                      ),
                      $(
                        'ii.invested_at',
                        '=',
                        $.fn('ANY', [$.fn.agg('ARRAY_AGG', ['investment.invested_at'])]) as any,
                      ),
                    ]),
                  )
                  .where(($) =>
                    $.and([
                      $('coinvestors.is_portfolio', 'is distinct from', true),
                      $('coinvestors.is_own_investing_entity', 'is distinct from', true),
                    ]),
                  )
                  .select(($) =>
                    $.fn
                      .agg<string[]>('ARRAY_AGG', ['coinvestors.name'])
                      .distinct()
                      .as('co_investors'),
                  )
                  .as('co_investors_same_round'),
              )
              .select('company.description'),
          )
          // Group all data by company
          .groupBy(['company.id', 'u.id', 'acquirer.id', 'point_of_contact.id'])
          .$if(input.config.aggregation === 'investment', (qb) => qb.groupBy('investment.id'))
          .$if(
            input.grouping === 'investment_date' && input.config.aggregation === 'company',
            (qb) => qb.orderBy(($) => $.fn.min('first_investment.first_invested_at'), 'desc'),
          )
          .$if(
            input.grouping === 'investment_date' && input.config.aggregation === 'investment',
            (qb) => qb.orderBy('investment.invested_at', 'desc'),
          )
          .$if(!!input.filter.name, (qb) =>
            qb.select(($) => matchesCompanyName($, input.filter.name!).as('matches_name_filter')),
          );

        const baseInvestments = await query.execute();

        const baseRows = baseInvestments.map((investment) => {
          return {
            ...investment,
            totalInvested: 0 as number | null,
            currentValueCurrency: input.config.currency ?? 'USD',
            moic: null as number | null,
            // `unrealizedValue` is the column; the retained pair beside it is
            // what the holdings projection moves value between.
            unrealizedValue: 0,
            retainedAll: 0,
            retainedInCompany: 0,
            realizedValue: 0,
            totalValue: 0,
            holdsRetainedAssets: false,
            holdsTrackingAssets: false,
            carriesSwapValue: false,
            message: undefined as ProcessMessage[] | undefined,
          };
        });

        await Promise.all(
          baseRows.map(async (investment) => {
            const messageCollector = new MessageCollector();

            const {
              totalValuationDateValue,
              totalTransactionDateValue,
              retainedValue,
              unrealizedValuationDateValue,
              realizedCashTransactionDateValue,
              investedTransactionDateValue,
              holdsRetainedAssets,
              holdsTrackingAssets,
            } = await getInvestmentsValuation({
              investments: investment.investments,
              targetCurrency: (input.config.currency as CurrencyIsoCode) ?? CurrencyIsoCode.USD,
              messageCollector,
              asOfDate: input.config.valuationDate
                ? new Date(input.config.valuationDate)
                : new Date(),
              fxDate: input.config.valuationDate
                ? new Date(input.config.valuationDate)
                : new Date(),
            });
            investment.moic = investedTransactionDateValue
              ? totalValuationDateValue / investedTransactionDateValue
              : null;
            messageCollector.header('MOIC');
            messageCollector.text(
              `Calculated as total value / total invested (${totalValuationDateValue.toFixed(2)} / ${investedTransactionDateValue?.toFixed(2)})`,
            );
            messageCollector.text(`MOIC: ${investment.moic}`);
            messageCollector.header('Movement');
            const totalMovement =
              investedTransactionDateValue === null
                ? null
                : totalValuationDateValue - investedTransactionDateValue;
            const fxMovement = totalValuationDateValue - totalTransactionDateValue;
            const fairValueMovement = totalMovement === null ? null : totalMovement - fxMovement;
            messageCollector.text(
              `Total Movement: ${totalMovement?.toFixed(2)} ${input.config.currency ?? 'USD'}`,
            );
            messageCollector.text(
              `FX Movement: ${fxMovement.toFixed(2)} ${input.config.currency ?? 'USD'}`,
            );
            messageCollector.text(
              `Fair Value Movement: ${fairValueMovement?.toFixed(2)} ${input.config.currency ?? 'USD'}`,
            );
            messageCollector.text(
              `Total Movement: ${totalMovement?.toFixed(2)} ${input.config.currency ?? 'USD'}`,
            );
            investment.totalInvested = investedTransactionDateValue;
            investment.realizedValue = realizedCashTransactionDateValue;
            investment.unrealizedValue = retainedValue;
            investment.retainedAll = retainedValue;
            investment.retainedInCompany = unrealizedValuationDateValue;
            investment.totalValue = totalValuationDateValue;
            investment.holdsRetainedAssets = holdsRetainedAssets;
            investment.holdsTrackingAssets = holdsTrackingAssets;
            investment.message = messageCollector.getMessages();
          }),
        );

        type ExportRow = (typeof baseRows)[number];

        // The acquirer's line: what we hold in it, and blanks everywhere the
        // question is about money we put in. We never bought this company —
        // the shares arrived as the price of one we did.
        const deriveAcquirerRow = (source: ExportRow, acquirer: AcquirerRef): ExportRow => ({
          ...source,
          name: acquirer.name,
          legal_name: null,
          legal_entity_id: acquirer.id as LegalEntityId,
          slug: acquirer.slug,
          image_url: acquirer.image_url,
          personal_website: null,
          country: null,
          short_description: null,
          acquired_by_legal_entity_id: null,
          acquirer: { ...source.acquirer, name: '', image_url: null, slug: null },
          point_of_contact: { ...source.point_of_contact, name: '', image_url: null },
          acquired_by: [],
          attributions: [],
          co_investors: null,
          themes: null,
          description: null,
          latest_round: null,
          investors: [],
          investments: [],
          investment_ids: [],
          is_exited: false,
          investment_rounds: null,
          assets: null,
          co_investors_same_round: null,
          totalInvested: null,
          moic: null,
          unrealizedValue: 0,
          retainedAll: 0,
          retainedInCompany: 0,
          realizedValue: 0,
          totalValue: 0,
          holdsRetainedAssets: false,
          holdsTrackingAssets: false,
          carriesSwapValue: false,
          message: undefined,
        });

        const investments = withHoldingsLens({
          rows: baseRows,
          mergeByCompany: input.config.aggregation !== 'investment',
          deriveAcquirerRow,
        }).filter(survivesNameFilter);
        for (const row of investments) {
          row.unrealizedValue = row.retainedAll;
        }

        if (input.grouping === 'moic') {
          investments.sort((a, b) => (b.moic ?? 0) - (a.moic ?? 0));
        }

        if (input.grouping === 'fair_value') {
          investments.sort((a, b) => (b.unrealizedValue ?? 0) - (a.unrealizedValue ?? 0));
        }

        if (input.grouping === 'total_value') {
          investments.sort((a, b) => (b.totalValue ?? 0) - (a.totalValue ?? 0));
        }

        // Blank rather than 0 for nothing, matching every other numeric column
        // here; a figure this path cannot answer is blank for the same reason.
        const money = (value: number | null) => (value ? parseFloat(value.toFixed(6)) : null);

        return investments.map((investment): Record<string, number | string | null | undefined> => {
          const investmentDate =
            input.config.aggregation === 'company'
              ? investment.first_invested_at
              : investment.investments[0]?.date;

          return {
            Name: investment.name,
            'Legal Name': investment.legal_name ?? null,
            ID: investment.legal_entity_id,
            'Link': investment.slug ? `${webBaseUrl()}/portfolio/c/${investment.slug}` : null,
            Website: investment.personal_website ?? null,
            'Country Code': investment.country ?? null,
            Country: investment.country
              ? getCountryByCode(investment.country)?.title ?? null
              : null,
            'Investment Date': investmentDate
              ? formatDate(new Date(investmentDate), 'yyyy-MM-dd')
              : null,
            'Point of Contact': investment.point_of_contact.name,
            Acquirer: investment.acquirer.name,
            investors: investment.investors.map((investor) => investor.name).join(', '),
            'Co-Investors': investment.co_investors_same_round?.join(', ') ?? null,
            Stage: investment.investment_rounds?.map((round) => round.name).join(', ') ?? null,
            'Valuation Amount': investment.investment_rounds
              ? investment.investment_rounds
                  .map((round) => round.valuationAmount)
                  .filter(notNull)
                  .join(', ')
              : null,
            'Valuation Currency': investment.investment_rounds
              ? investment.investment_rounds
                  .map((round) => round.valuationCurrency)
                  .filter(notNull)
                  .join(', ')
              : null,
            'Valuation Type': investment.investment_rounds
              ? investment.investment_rounds
                  .map((round) =>
                    round.valuationType === 'PRE_MONEY' ? 'Pre-Money' : 'Post-Money',
                  )
                  .join(', ')
              : null,
            'Round Size Amount': investment.investment_rounds
              ? investment.investment_rounds
                  .map((round) => round.raisedAmount)
                  .filter(notNull)
                  .join(', ')
              : null,
            'Round Size Currency': investment.investment_rounds
              ? investment.investment_rounds
                  .map((round) => round.raisedCurrency)
                  .filter(notNull)
                  .join(', ')
              : null,
            AssetTypes: investment.assets ?? '',
            Themes: investment.themes?.join(', ') ?? null,
            'Latest Round Name': investment.latest_round?.name ?? null,
            'Latest Round Date': investment.latest_round?.date
              ? formatDate(new Date(investment.latest_round.date), 'yyyy-MM-dd')
              : null,
            'Reporting Currency': investment.currentValueCurrency,
            'Total Invested': money(investment.totalInvested),
            'Total Value': money(investment.totalValue),
            'Unrealized Value': money(investment.unrealizedValue),
            'Realized Value': money(investment.realizedValue),
            // Blank and zero say different things here: a line that states no
            // return (the shares arrived as someone else's proceeds) against
            // one that returned nothing.
            MOIC: investment.moic === null ? null : parseFloat(investment.moic.toFixed(2)),
            Status: deriveInvestmentStatus(investment.holdsRetainedAssets),
            ...(input.config.aggregation === 'investment'
              ? {
                  'Investment ID': investment.single_investment_id ?? null,
                  'First Transaction ID': investment.first_transaction_id ?? null,
                  'Has Converted': investment.has_converted ? 'TRUE' : 'FALSE',
                }
              : {}),
          };
        });
      }),
    getPerCompanyMovementExport: userProcedure
      .input(
        z.object({
          filter: portfolioFilterSchema,
          config: z.object({
            portfolioIds: z.array(z.string()).nullish(),
            currency: z.enum(currencyOptions).nullish(),
            valuationDate: z.string().date().nullish(), // unused, here for compatability
            showDetails: z.boolean().nullish(),
          }),
          range: z.object({
            from: z.string().date(),
            to: z.string().date(),
          }),
        }),
      )
      .mutation(async ({ input }) => {
        const { range } = input;

        // overwrite the valuation date to the end of the range
        input.config.valuationDate = range.to;

        const query = getBaseQuery({ input })
          .select(($) => [
            'company.name',
            'company.id',
            $.fn
              .agg<{ id: string; date: Date; type: string }[]>('JSONB_AGG', [
                jsonbBuildObject($, {
                  id: 'investment.id',
                  date: 'investment.invested_at',
                  type: 'investment.type',
                }),
              ])
              .distinct()
              .as('investments'),
          ])
          .groupBy(['company.id']);

        const baseInvestments = await query.execute();

        const investments = baseInvestments.map((investment) => {
          return {
            ...investment,
            totalMovement: 0,
            fxMovement: 0,
            fairValueMovement: 0,
          };
        });

        await Promise.all(
          investments.map(async (investment) => {
            const valFrom = await getInvestmentsValuation({
              investments: investment.investments,
              targetCurrency: (input.config.currency as CurrencyIsoCode) ?? CurrencyIsoCode.USD,
              asOfDate: new Date(range.from),
              fxDate: new Date(range.from),
            });

            const valTo = await getInvestmentsValuation({
              investments: investment.investments,
              targetCurrency: (input.config.currency as CurrencyIsoCode) ?? CurrencyIsoCode.USD,
              asOfDate: new Date(range.to),
              fxDate: new Date(range.to),
            });

            const valToFxPinned = await getInvestmentsValuation({
              investments: investment.investments,
              targetCurrency: (input.config.currency as CurrencyIsoCode) ?? CurrencyIsoCode.USD,
              asOfDate: new Date(range.to),
              fxDate: new Date(range.from),
            });

            const totalValueFrom = valFrom.totalValuationDateValue;
            const totalValueTo = valTo.totalValuationDateValue;
            const totalValueToFxPinned = valToFxPinned.totalValuationDateValue;

            investment.totalMovement = totalValueTo - totalValueFrom;
            investment.fxMovement = totalValueTo - totalValueToFxPinned;
            investment.fairValueMovement = totalValueToFxPinned - totalValueFrom;
          }),
        );

        return investments.map(
          (investment): Record<string, string | number | null | undefined> => ({
            Name: investment.name,
            ID: investment.id,
            'Total Movement': investment.totalMovement.toFixed(6),
            'FX Movement': investment.fxMovement.toFixed(6),
            'Fair Value Movement': investment.fairValueMovement.toFixed(6),
          }),
        );
      }),
  });
};

export { investmentsRouter };
