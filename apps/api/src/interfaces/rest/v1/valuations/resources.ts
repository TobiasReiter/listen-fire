import { z } from 'zod';
import { sql } from 'kysely';
import { type Router } from 'express';

import LegalEntityType from '../../../../generated/kysely/valuations/LegalEntityType';
import InvestmentStatus from '../../../../generated/kysely/valuations/InvestmentStatus';
import CompanyLegalStatus from '../../../../generated/kysely/valuations/CompanyLegalStatus';
import EquityRoundType from '../../../../generated/kysely/valuations/EquityRoundType';
import InvestmentType from '../../../../generated/kysely/valuations/InvestmentType';
import AssetType from '../../../../generated/kysely/valuations/AssetType';
import ConvertibleType from '../../../../generated/kysely/valuations/ConvertibleType';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import PriceType from '../../../../generated/kysely/valuations/PriceType';
import EventType from '../../../../generated/kysely/valuations/EventType';
import ValuationType from '../../../../generated/kysely/valuations/ValuationType';
import InvestmentRoundType from '../../../../generated/kysely/valuations/InvestmentRoundType';
import { paginationQuery } from './shared';
import { buildCrudRouter } from './crud';
import { mintUniqueSlug } from '../../../../lib/valuations/slug';

// ── Legal Entities ──

/**
 * `search` finds an entity by any name it answers to, spelled roughly: the
 * search vector's tokens (Name, Legal Name, Also Known As, Other Names), a
 * trigram match on Name or Legal Name for misspellings, or the plain contains
 * it has always done. Without an explicit `sort`, the best match comes first.
 * `%` is pg_trgm's similarity operator (default threshold 0.3); it, unlike
 * `similarity(...) > 0.3`, can use the trigram indexes.
 */
function searchLegalEntities(query: any, options: { q: string; ordered: boolean }): any {
  const { q } = options;
  const tsquery = sql`plainto_tsquery('english', ${q})`;
  const filtered = query.where(
    sql<boolean>`(
      legal_entity.search_vector @@ ${tsquery}
      OR legal_entity.name OPERATOR(public.%) ${q}
      OR legal_entity.legal_name OPERATOR(public.%) ${q}
      OR legal_entity.name ILIKE ${`%${q}%`}
    )`,
  );
  if (!options.ordered) return filtered;
  return filtered
    .orderBy(
      sql`ts_rank(legal_entity.search_vector, ${tsquery})
        + greatest(public.similarity(legal_entity.name, ${q}), public.similarity(legal_entity.legal_name, ${q}))`,
      'desc',
    )
    .orderBy('legal_entity.name', 'asc');
}

const legalEntitiesRouter: Router = buildCrudRouter({
  table: 'legal_entity',
  defaultSort: 'created_at',
  sortableColumns: ['created_at', 'updated_at', 'name'],
  listSchema: paginationQuery.extend({
    type: z.nativeEnum(LegalEntityType).optional(),
    is_portfolio: z.coerce.boolean().optional(),
    is_own_investing_entity: z.coerce.boolean().optional(),
    investment_status: z.nativeEnum(InvestmentStatus).optional(),
    search: z.string().optional(),
  }),
  listFilters: (query, params) => {
    if (params.type) query = query.where('legal_entity.type', '=', params.type);
    if (params.is_portfolio !== undefined) query = query.where('legal_entity.is_portfolio', '=', params.is_portfolio);
    if (params.is_own_investing_entity !== undefined)
      query = query.where('legal_entity.is_own_investing_entity', '=', params.is_own_investing_entity);
    if (params.investment_status)
      query = query.where('legal_entity.investment_status', '=', params.investment_status);
    if (typeof params.search === 'string' && params.search !== '') {
      query = searchLegalEntities(query, { q: params.search, ordered: params.sort === undefined });
    }
    return query;
  },
  createSchema: z.object({
    type: z.nativeEnum(LegalEntityType),
    name: z.string().min(1).max(500),
    legal_name: z.string().max(500).optional(),
    also_known_as: z.string().optional(),
    email: z.string().email().optional(),
    personal_website: z.string().optional(),
    linkedin: z.string().optional(),
    image_url: z.string().optional(),
    slug: z.string().optional(),
    description: z.string().optional(),
    short_description: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    other_names: z.array(z.string()).optional(),
    themes: z.array(z.string()).optional(),
    sectors: z.array(z.string()).optional(),
    markets: z.array(z.string()).optional(),
    customers: z.array(z.string()).optional(),
    business_model: z.array(z.string()).optional(),
    locations: z.array(z.string()).optional(),
    stages: z.array(z.string()).optional(),
    is_portfolio: z.boolean().optional(),
    is_own_investing_entity: z.boolean().optional(),
    investment_status: z.nativeEnum(InvestmentStatus).optional(),
    legal_status: z.nativeEnum(CompanyLegalStatus).optional(),
    investing_entity_id: z.string().uuid().optional(),
    underlying_company_id: z.string().uuid().optional(),
    acquired_by_legal_entity_id: z.string().uuid().optional(),
  }),
  updateSchema: z.object({
    type: z.nativeEnum(LegalEntityType).optional(),
    name: z.string().min(1).max(500).optional(),
    legal_name: z.string().max(500).nullable().optional(),
    also_known_as: z.string().nullable().optional(),
    email: z.string().email().nullable().optional(),
    personal_website: z.string().nullable().optional(),
    linkedin: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    short_description: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    other_names: z.array(z.string()).nullable().optional(),
    themes: z.array(z.string()).nullable().optional(),
    sectors: z.array(z.string()).nullable().optional(),
    markets: z.array(z.string()).nullable().optional(),
    customers: z.array(z.string()).nullable().optional(),
    business_model: z.array(z.string()).nullable().optional(),
    locations: z.array(z.string()).nullable().optional(),
    stages: z.array(z.string()).nullable().optional(),
    is_portfolio: z.boolean().nullable().optional(),
    is_own_investing_entity: z.boolean().nullable().optional(),
    investment_status: z.nativeEnum(InvestmentStatus).optional(),
    legal_status: z.nativeEnum(CompanyLegalStatus).optional(),
    investing_entity_id: z.string().uuid().nullable().optional(),
    underlying_company_id: z.string().uuid().nullable().optional(),
    acquired_by_legal_entity_id: z.string().uuid().nullable().optional(),
  }),
  // A company with no slug is unreachable in the app — `/portfolio/c/[slug]`
  // is how it is addressed. `slug` above is optional, so mint one for every
  // caller that does not supply it rather than leaving dead rows behind.
  beforeCreate: async (values, qb) => {
    if (typeof values.slug === 'string' && values.slug !== '') return {};
    const slug = await mintUniqueSlug(qb, values.name as string);
    return slug === undefined ? {} : { slug };
  },
});

// ── Investments ──

const investmentsRouter: Router = buildCrudRouter({
  table: 'investment',
  defaultSort: 'created_at',
  sortableColumns: ['created_at', 'updated_at', 'invested_at'],
  listSchema: paginationQuery.extend({
    investor_profile_id: z.string().uuid().optional(),
    investment_profile_id: z.string().uuid().optional(),
    round_type: z.nativeEnum(EquityRoundType).optional(),
    type: z.nativeEnum(InvestmentType).optional(),
    verified: z.coerce.boolean().optional(),
  }),
  listFilters: (query, params) => {
    if (params.investor_profile_id)
      query = query.where('investment.investor_profile_id', '=', params.investor_profile_id);
    if (params.investment_profile_id)
      query = query.where('investment.investment_profile_id', '=', params.investment_profile_id);
    if (params.round_type) query = query.where('investment.round_type', '=', params.round_type);
    if (params.type) query = query.where('investment.type', '=', params.type);
    if (params.verified !== undefined) query = query.where('investment.verified', '=', params.verified);
    return query;
  },
  createSchema: z.object({
    investor_profile_id: z.string().uuid(),
    investment_profile_id: z.string().uuid(),
    round_type: z.nativeEnum(EquityRoundType).optional(),
    type: z.nativeEnum(InvestmentType).optional(),
    invested_at: z.string().datetime().optional(),
    event_id: z.string().uuid().optional(),
  }),
  updateSchema: z.object({
    investor_profile_id: z.string().uuid().optional(),
    investment_profile_id: z.string().uuid().optional(),
    round_type: z.nativeEnum(EquityRoundType).nullable().optional(),
    type: z.nativeEnum(InvestmentType).optional(),
    invested_at: z.string().datetime().nullable().optional(),
    verified: z.boolean().optional(),
    fully_exited_at: z.string().datetime().nullable().optional(),
    event_id: z.string().uuid().nullable().optional(),
    exit_event_id: z.string().uuid().nullable().optional(),
  }),
});

// ── Transactions ──

const transactionsRouter: Router = buildCrudRouter({
  table: 'transaction',
  defaultSort: 'close_date',
  sortableColumns: ['created_at', 'updated_at', 'close_date'],
  listSchema: paginationQuery.extend({
    investment_id: z.string().uuid().optional(),
    event_id: z.string().uuid().optional(),
    close_date_from: z.string().date().optional(),
    close_date_to: z.string().date().optional(),
  }),
  listFilters: (query, params) => {
    if (params.investment_id) query = query.where('transaction.investment_id', '=', params.investment_id);
    if (params.event_id) query = query.where('transaction.event_id', '=', params.event_id);
    if (params.close_date_from) query = query.where('transaction.close_date', '>=', params.close_date_from);
    if (params.close_date_to) query = query.where('transaction.close_date', '<=', params.close_date_to);
    return query;
  },
  createSchema: z.object({
    close_date: z.string().date(),
    investment_id: z.string().uuid().optional(),
    event_id: z.string().uuid().optional(),
  }),
  updateSchema: z.object({
    close_date: z.string().date().optional(),
    investment_id: z.string().uuid().nullable().optional(),
    event_id: z.string().uuid().nullable().optional(),
    converted_to_id: z.string().uuid().nullable().optional(),
    due_to_rights_from_asset_id: z.string().uuid().nullable().optional(),
  }),
});

// ── Assets ──

const assetsRouter: Router = buildCrudRouter({
  table: 'asset',
  defaultSort: 'created_at',
  sortableColumns: ['created_at', 'updated_at', 'name', 'type'],
  listSchema: paginationQuery.extend({
    type: z.nativeEnum(AssetType).optional(),
    issued_by_legal_entity_id: z.string().uuid().optional(),
    convertible_type: z.nativeEnum(ConvertibleType).optional(),
  }),
  listFilters: (query, params) => {
    if (params.type) query = query.where('asset.type', '=', params.type);
    if (params.issued_by_legal_entity_id)
      query = query.where('asset.issued_by_legal_entity_id', '=', params.issued_by_legal_entity_id);
    if (params.convertible_type) query = query.where('asset.convertible_type', '=', params.convertible_type);
    return query;
  },
  createSchema: z.object({
    type: z.nativeEnum(AssetType),
    name: z.string(),
    issued_by_legal_entity_id: z.string().uuid().optional(),
    convertible_type: z.nativeEnum(ConvertibleType).optional(),
    convertible_amount: z.number().optional(),
    convertible_currency: z.nativeEnum(CurrencyIsoCode).optional(),
    convertible_investor_id: z.string().uuid().optional(),
    valuation_cap: z.number().optional(),
    discount_rate: z.number().optional(),
    interest: z.number().optional(),
    annualised_interest_rate: z.number().optional(),
    maturity_date: z.string().date().optional(),
    conversion_date: z.string().date().optional(),
    conversion_price: z.number().optional(),
    // The column is NOT NULL with no DB default — an omitted `properties`
    // must default here or every bare asset create 500s.
    properties: z.record(z.string(), z.unknown()).default({}),
  }),
  updateSchema: z.object({
    type: z.nativeEnum(AssetType).optional(),
    name: z.string().optional(),
    issued_by_legal_entity_id: z.string().uuid().nullable().optional(),
    convertible_type: z.nativeEnum(ConvertibleType).nullable().optional(),
    convertible_amount: z.number().nullable().optional(),
    convertible_currency: z.nativeEnum(CurrencyIsoCode).nullable().optional(),
    convertible_investor_id: z.string().uuid().nullable().optional(),
    valuation_cap: z.number().nullable().optional(),
    discount_rate: z.number().nullable().optional(),
    interest: z.number().nullable().optional(),
    annualised_interest_rate: z.number().nullable().optional(),
    maturity_date: z.string().date().nullable().optional(),
    conversion_date: z.string().date().nullable().optional(),
    conversion_price: z.number().nullable().optional(),
    properties: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
});

// ── Asset Transfers ──

const assetTransfersRouter: Router = buildCrudRouter({
  table: 'asset_transfer',
  defaultSort: 'date',
  sortableColumns: ['created_at', 'updated_at', 'date'],
  listSchema: paginationQuery.extend({
    asset_id: z.string().uuid().optional(),
    transaction_id: z.string().uuid().optional(),
    from_legal_entity_id: z.string().uuid().optional(),
    to_legal_entity_id: z.string().uuid().optional(),
    date_from: z.string().date().optional(),
    date_to: z.string().date().optional(),
  }),
  listFilters: (query, params) => {
    if (params.asset_id) query = query.where('asset_transfer.asset_id', '=', params.asset_id);
    if (params.transaction_id) query = query.where('asset_transfer.transaction_id', '=', params.transaction_id);
    if (params.from_legal_entity_id)
      query = query.where('asset_transfer.from_legal_entity_id', '=', params.from_legal_entity_id);
    if (params.to_legal_entity_id)
      query = query.where('asset_transfer.to_legal_entity_id', '=', params.to_legal_entity_id);
    if (params.date_from) query = query.where('asset_transfer.date', '>=', params.date_from);
    if (params.date_to) query = query.where('asset_transfer.date', '<=', params.date_to);
    return query;
  },
  createSchema: z.object({
    asset_id: z.string().uuid(),
    transaction_id: z.string().uuid(),
    date: z.string().date(),
    from_legal_entity_id: z.string().uuid(),
    to_legal_entity_id: z.string().uuid(),
    num_assets: z.number().optional(),
  }),
  updateSchema: z.object({
    asset_id: z.string().uuid().optional(),
    transaction_id: z.string().uuid().optional(),
    date: z.string().date().optional(),
    from_legal_entity_id: z.string().uuid().optional(),
    to_legal_entity_id: z.string().uuid().optional(),
    num_assets: z.number().nullable().optional(),
  }),
});

// ── Prices ──

const pricesRouter: Router = buildCrudRouter({
  table: 'price',
  defaultSort: 'date',
  sortableColumns: ['created_at', 'updated_at', 'date', 'price'],
  listSchema: paginationQuery.extend({
    asset_id: z.string().uuid().optional(),
    legal_entity_id: z.string().uuid().optional(),
    currency: z.nativeEnum(CurrencyIsoCode).optional(),
    type: z.nativeEnum(PriceType).optional(),
    date_from: z.string().date().optional(),
    date_to: z.string().date().optional(),
  }),
  listFilters: (query, params) => {
    if (params.asset_id) query = query.where('price.asset_id', '=', params.asset_id);
    if (params.legal_entity_id) query = query.where('price.legal_entity_id', '=', params.legal_entity_id);
    if (params.currency) query = query.where('price.currency', '=', params.currency);
    if (params.type) query = query.where('price.type', '=', params.type);
    if (params.date_from) query = query.where('price.date', '>=', params.date_from);
    if (params.date_to) query = query.where('price.date', '<=', params.date_to);
    return query;
  },
  createSchema: z.object({
    asset_id: z.string().uuid(),
    date: z.string().date(),
    price: z.number(),
    currency: z.nativeEnum(CurrencyIsoCode),
    type: z.nativeEnum(PriceType).optional(),
    legal_entity_id: z.string().uuid().optional(),
    event_id: z.string().uuid().optional(),
  }),
  updateSchema: z.object({
    asset_id: z.string().uuid().optional(),
    date: z.string().date().optional(),
    price: z.number().optional(),
    currency: z.nativeEnum(CurrencyIsoCode).optional(),
    type: z.nativeEnum(PriceType).optional(),
    legal_entity_id: z.string().uuid().nullable().optional(),
    event_id: z.string().uuid().nullable().optional(),
  }),
});

// ── Events ──

const eventsRouter: Router = buildCrudRouter({
  table: 'event',
  defaultSort: 'date',
  sortableColumns: ['created_at', 'updated_at', 'date', 'type'],
  listSchema: paginationQuery.extend({
    legal_entity_id: z.string().uuid().optional(),
    type: z.nativeEnum(EventType).optional(),
    round_type: z.nativeEnum(EquityRoundType).optional(),
    date_from: z.string().date().optional(),
    date_to: z.string().date().optional(),
  }),
  listFilters: (query, params) => {
    if (params.legal_entity_id) query = query.where('event.legal_entity_id', '=', params.legal_entity_id);
    if (params.type) query = query.where('event.type', '=', params.type);
    if (params.round_type) query = query.where('event.round_type', '=', params.round_type);
    if (params.date_from) query = query.where('event.date', '>=', params.date_from);
    if (params.date_to) query = query.where('event.date', '<=', params.date_to);
    return query;
  },
  createSchema: z.object({
    date: z.string().date(),
    legal_entity_id: z.string().uuid(),
    type: z.nativeEnum(EventType),
    name: z.string().optional(),
    raised_amount: z.number().optional(),
    raised_currency: z.nativeEnum(CurrencyIsoCode).optional(),
    valuation: z.number().optional(),
    valuation_currency: z.nativeEnum(CurrencyIsoCode).optional(),
    valuation_type: z.nativeEnum(ValuationType).optional(),
    round_type: z.nativeEnum(EquityRoundType).optional(),
    investment_round_type: z.nativeEnum(InvestmentRoundType).optional(),
    acquirer_id: z.string().uuid().optional(),
  }),
  updateSchema: z.object({
    date: z.string().date().optional(),
    legal_entity_id: z.string().uuid().optional(),
    type: z.nativeEnum(EventType).optional(),
    name: z.string().optional(),
    raised_amount: z.number().nullable().optional(),
    raised_currency: z.nativeEnum(CurrencyIsoCode).nullable().optional(),
    valuation: z.number().nullable().optional(),
    valuation_currency: z.nativeEnum(CurrencyIsoCode).nullable().optional(),
    valuation_type: z.nativeEnum(ValuationType).nullable().optional(),
    round_type: z.nativeEnum(EquityRoundType).nullable().optional(),
    investment_round_type: z.nativeEnum(InvestmentRoundType).nullable().optional(),
    acquirer_id: z.string().uuid().nullable().optional(),
  }),
});

// ── Exchange Rates (Read-Only) ──

const exchangeRatesRouter: Router = buildCrudRouter({
  table: 'exchange_rate',
  teamIdColumn: null,
  defaultSort: 'date',
  sortableColumns: ['date', 'from_currency', 'to_currency'],
  listSchema: paginationQuery.extend({
    from_currency: z.nativeEnum(CurrencyIsoCode).optional(),
    to_currency: z.nativeEnum(CurrencyIsoCode).optional(),
    date_from: z.string().date().optional(),
    date_to: z.string().date().optional(),
  }),
  listFilters: (query, params) => {
    if (params.from_currency) query = query.where('exchange_rate.from_currency', '=', params.from_currency);
    if (params.to_currency) query = query.where('exchange_rate.to_currency', '=', params.to_currency);
    if (params.date_from) query = query.where('exchange_rate.date', '>=', params.date_from);
    if (params.date_to) query = query.where('exchange_rate.date', '<=', params.date_to);
    return query;
  },
  // No createSchema or updateSchema → read-only
});

export {
  legalEntitiesRouter,
  investmentsRouter,
  transactionsRouter,
  assetsRouter,
  assetTransfersRouter,
  pricesRouter,
  eventsRouter,
  exchangeRatesRouter,
};
