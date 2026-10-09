import { z } from 'zod';

import LegalEntityType from '../../generated/kysely/valuations/LegalEntityType';
import InvestmentStatus from '../../generated/kysely/valuations/InvestmentStatus';
import CompanyLegalStatus from '../../generated/kysely/valuations/CompanyLegalStatus';
import EquityRoundType from '../../generated/kysely/valuations/EquityRoundType';
import InvestmentType from '../../generated/kysely/valuations/InvestmentType';
import AssetType from '../../generated/kysely/valuations/AssetType';
import ConvertibleType from '../../generated/kysely/valuations/ConvertibleType';
import CurrencyIsoCode from '../../generated/kysely/valuations/CurrencyIsoCode';
import PriceType from '../../generated/kysely/valuations/PriceType';
import EventType from '../../generated/kysely/valuations/EventType';
import ValuationType from '../../generated/kysely/valuations/ValuationType';
import InvestmentRoundType from '../../generated/kysely/valuations/InvestmentRoundType';
import { registerCrudRoutes, registerRoute } from './registry';
import {
  registerAutomationToolRoutes,
  registerKnowledgeAgentToolRoutes,
} from '../rest/v1/knowledge_agent_tools';

const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

function registerAllRoutes() {
  // ── Valuations CRUD ──

  registerCrudRoutes({
    basePath: '/v1/valuations/legal-entities',
    description: 'legal entities (funds, companies, SPVs)',
    domain: 'valuations',
    listSchema: paginationQuery.extend({
      type: z.nativeEnum(LegalEntityType).optional(),
      is_portfolio: z.coerce.boolean().optional(),
      is_own_investing_entity: z.coerce.boolean().optional(),
      investment_status: z.nativeEnum(InvestmentStatus).optional(),
      search: z.string().optional(),
    }),
    createSchema: z.object({
      type: z.nativeEnum(LegalEntityType),
      name: z.string().min(1).max(500),
      legal_name: z.string().max(500).optional(),
      also_known_as: z.string().optional(),
      email: z.string().email().optional(),
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
      is_portfolio: z.boolean().nullable().optional(),
      is_own_investing_entity: z.boolean().nullable().optional(),
      investment_status: z.nativeEnum(InvestmentStatus).optional(),
      legal_status: z.nativeEnum(CompanyLegalStatus).optional(),
      investing_entity_id: z.string().uuid().nullable().optional(),
      underlying_company_id: z.string().uuid().nullable().optional(),
      acquired_by_legal_entity_id: z.string().uuid().nullable().optional(),
    }),
  });

  registerCrudRoutes({
    basePath: '/v1/valuations/investments',
    description: 'investments',
    domain: 'valuations',
    listSchema: paginationQuery.extend({
      investor_profile_id: z.string().uuid().optional(),
      investment_profile_id: z.string().uuid().optional(),
      round_type: z.nativeEnum(EquityRoundType).optional(),
      type: z.nativeEnum(InvestmentType).optional(),
      verified: z.coerce.boolean().optional(),
    }),
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

  registerCrudRoutes({
    basePath: '/v1/valuations/transactions',
    description: 'transactions',
    domain: 'valuations',
    listSchema: paginationQuery.extend({
      investment_id: z.string().uuid().optional(),
      event_id: z.string().uuid().optional(),
      close_date_from: z.string().date().optional(),
      close_date_to: z.string().date().optional(),
    }),
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

  registerCrudRoutes({
    basePath: '/v1/valuations/assets',
    description: 'assets',
    domain: 'valuations',
    listSchema: paginationQuery.extend({
      type: z.nativeEnum(AssetType).optional(),
      issued_by_legal_entity_id: z.string().uuid().optional(),
      convertible_type: z.nativeEnum(ConvertibleType).optional(),
    }),
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
      properties: z.record(z.string(), z.unknown()).optional(),
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

  registerCrudRoutes({
    basePath: '/v1/valuations/asset-transfers',
    description: 'asset transfers',
    domain: 'valuations',
    listSchema: paginationQuery.extend({
      asset_id: z.string().uuid().optional(),
      transaction_id: z.string().uuid().optional(),
      from_legal_entity_id: z.string().uuid().optional(),
      to_legal_entity_id: z.string().uuid().optional(),
      date_from: z.string().date().optional(),
      date_to: z.string().date().optional(),
    }),
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

  registerCrudRoutes({
    basePath: '/v1/valuations/prices',
    description: 'prices',
    domain: 'valuations',
    listSchema: paginationQuery.extend({
      asset_id: z.string().uuid().optional(),
      legal_entity_id: z.string().uuid().optional(),
      currency: z.nativeEnum(CurrencyIsoCode).optional(),
      type: z.nativeEnum(PriceType).optional(),
      date_from: z.string().date().optional(),
      date_to: z.string().date().optional(),
    }),
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

  registerCrudRoutes({
    basePath: '/v1/valuations/events',
    // Deliberately omits acquirer_id (present on the REST resource this proxies
    // to): recording an acquisition through a bare event write skips stamping
    // the acquired company's legal entity (acquiredByLegalEntityId/acquiredAt/
    // acquiredEventId). The addAcquisition top-level tool is the only MCP path
    // that does both — steer agents there instead of advertising the field here.
    description:
      'events (funding rounds, acquisitions, IPOs). To record an acquisition, use the addAcquisition tool instead — it stamps the acquired company\'s legal entity in addition to creating the event',
    domain: 'valuations',
    listSchema: paginationQuery.extend({
      legal_entity_id: z.string().uuid().optional(),
      type: z.nativeEnum(EventType).optional(),
      round_type: z.nativeEnum(EquityRoundType).optional(),
      date_from: z.string().date().optional(),
      date_to: z.string().date().optional(),
    }),
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
    }),
  });

  registerCrudRoutes({
    basePath: '/v1/valuations/exchange-rates',
    description: 'exchange rates (read-only)',
    domain: 'valuations',
    listSchema: paginationQuery.extend({
      from_currency: z.nativeEnum(CurrencyIsoCode).optional(),
      to_currency: z.nativeEnum(CurrencyIsoCode).optional(),
      date_from: z.string().date().optional(),
      date_to: z.string().date().optional(),
    }),
  });

  // Compute endpoint
  registerRoute({
    method: 'POST',
    path: '/v1/valuations/compute',
    description: 'Compute valuations (MOIC, gain, IRR) for a set of investments as of a given date',
    domain: 'valuations',
    inputSchema: z.object({
      investment_ids: z.array(z.string().uuid()).max(500).optional(),
      investor_profile_id: z.string().uuid().optional(),
      investment_profile_id: z.string().uuid().optional(),
      as_of_date: z.string().date(),
      target_currency: z.nativeEnum(CurrencyIsoCode),
      strategy: z.enum(['FIFO', 'LIFO']).default('FIFO'),
      fx_date: z.string().date().optional(),
      include_irr: z.boolean().default(false),
    }),
    inputLocation: 'body',
  });

  // Query endpoint. `/compute` answers "what is this investment worth"; this
  // answers "sum these lots, sliced this way" — every portfolio metric is a
  // preset over its atoms. Lists arrive comma-separated.
  registerRoute({
    method: 'GET',
    path: '/v1/valuations/query',
    description:
      'Query the valuation lots: filter by investment, causal degree, leaf type (cash/held), cash sign and date window, grouped by any of company, investment, investing_entity, round, degree, asset, tracked_entity',
    domain: 'valuations',
    inputSchema: z.object({
      investment_ids: z.string().optional(),
      invested_from: z.string().date().optional(),
      invested_to: z.string().date().optional(),
      round_id: z.string().uuid().optional(),
      investing_entity_ids: z.string().optional(),
      investee_entity_ids: z.string().optional(),
      degree: z.coerce.number().int().min(0).optional(),
      degree_min: z.coerce.number().int().min(0).optional(),
      degree_max: z.coerce.number().int().min(0).optional(),
      leaf_type: z.enum(['cash', 'held']).optional(),
      cash_sign: z.enum(['paid', 'received']).optional(),
      fact_from: z.string().date().optional(),
      fact_to: z.string().date().optional(),
      as_of_date: z.string().date().optional(),
      group_by: z.string().optional(),
      currency: z.nativeEnum(CurrencyIsoCode),
      strategy: z.enum(['FIFO', 'LIFO']).optional(),
    }),
    inputLocation: 'query',
  });

  // ── Knowledge ──

  // These two are also available as top-level MCP tools (query, schema).
  // Listed here so existing clients using call_api with these paths still see them.

  registerRoute({
    method: 'POST',
    path: '/v1/knowledge/query',
    description: 'Natural-language data lookup (also available as top-level "query" tool).',
    domain: 'knowledge',
    inputSchema: z.object({
      question: z.string().min(1).max(5000).describe('Natural-language question about the data'),
      context: z.string().max(5000).optional().describe('Context from previous results to narrow the query'),
    }),
    inputLocation: 'body',
    latency: 'medium',
    readOnly: true,
  });

  registerRoute({
    method: 'GET',
    path: '/v1/knowledge/schema',
    description: 'Get the knowledge graph schema (also available as top-level "schema" tool).',
    domain: 'knowledge',
    inputLocation: 'query',
    latency: 'fast',
    readOnly: true,
  });

  registerRoute({
    method: 'POST',
    path: '/v1/knowledge/cypher',
    description: 'Execute a raw Cypher query against the knowledge graph. Use this when you need precise control over the query structure.',
    domain: 'knowledge',
    inputSchema: z.object({
      query: z.string().min(1).max(10000).describe('Cypher query string'),
      limit: z.number().int().positive().max(1000).optional(),
      includeGeneratedSql: z.boolean().optional(),
    }),
    inputLocation: 'body',
    latency: 'medium',
    readOnly: true,
  });

  registerRoute({
    method: 'GET',
    path: '/v1/knowledge/nodes',
    description: 'Search and list nodes with their properties. Supports filtering by type name and full-text search.',
    domain: 'knowledge',
    inputSchema: z.object({
      type: z.string().optional().describe('Filter by node type name'),
      search: z.string().optional().describe('Full-text search on node summaries'),
      limit: z.coerce.number().int().positive().max(100).default(20),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    inputLocation: 'query',
    latency: 'fast',
    readOnly: true,
  });

  registerRoute({
    method: 'GET',
    path: '/v1/knowledge/nodes/:id',
    description: 'Get a single node with all its properties and connected edges.',
    domain: 'knowledge',
    inputLocation: 'query',
    latency: 'fast',
    readOnly: true,
  });

  registerRoute({
    method: 'GET',
    path: '/v1/knowledge/nodes/:id/edges',
    description: 'List edges for a node, optionally filtered by edge type.',
    domain: 'knowledge',
    inputSchema: z.object({
      type: z.string().optional().describe('Filter by edge type name'),
    }),
    inputLocation: 'query',
    latency: 'fast',
    readOnly: true,
  });

  // The knowledge-router conversation endpoints have been removed — the MCP
  // surface is direct-tool only and never proxied through the agent. The in-app
  // agent path lives on system.ts / the tRPC queryAgent view. External callers
  // author directly via readBook + the movement/KG tools.

  // ── Asks (open interaction requests from movement runs) ──
  // On the Automation connector — surfaced as the top-level list_asks /
  // answer_ask MCP tools.

  registerRoute({
    method: 'GET',
    path: '/v1/automation/reviews',
    description: 'List the open reviews (interaction requests) awaiting an answer from a paused automation run. Each has a requestId, an interactionType, a result type, and a title. Answer one with submitReview. Also the top-level "listReviews" tool.',
    domain: 'automation',
    inputLocation: 'query',
    latency: 'fast',
    readOnly: true,
  });

  registerRoute({
    method: 'POST',
    path: '/v1/automation/reviews/:id/answer',
    description: 'Answer an open review (interaction request) from a paused automation run. The answer is validated against the review\'s result type; the run then resumes. Also the top-level "submitReview" tool.',
    domain: 'automation',
    inputSchema: z.object({
      answer: z
        .union([
          z.boolean(),
          z.number(),
          z.string(),
          z.array(z.unknown()),
          z.record(z.string(), z.unknown()),
        ])
        .describe(
          'The answer, shaped to the ask\'s interactionType — a boolean for a Check, an enum member for a Choose, an option id (or array of ids) for a Pick/Select, the typed value for a Provide, an acknowledgement string for a Review/Notify, or { rows: [{ ephemeralId, fields }], dropped: [...] } for a Correct. Passed through and validated server-side — do not stringify.',
        ),
    }),
    inputLocation: 'body',
    latency: 'fast',
    readOnly: false,
  });

  // ── Agent's deterministic tools, exposed directly — colocated in
  //    knowledge_agent_tools.ts. Automation: movements, catalog, handbook,
  //    connect, teams. Knowledge: KG read + validated edits, ontology, recipes.
  registerAutomationToolRoutes();
  registerKnowledgeAgentToolRoutes();
}

export { registerAllRoutes };
