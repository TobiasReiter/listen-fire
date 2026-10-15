// The Dealroom type graph: the entry surface and every type descriptor.
//
// Rule 0 (adapters/CLAUDE.md): the shape follows the NATURAL graph, not the
// API. Companies, investors, people and rounds are the four real entities — each
// has a page, an id and a search, so each earns a root collection. Team
// membership and round participation carry facts about the PAIR (the titles and
// years; the lead flag), so each is a small node between the ends rather than a
// bare edge that would lose them. A fund has no page and no search of its own,
// so it lives under its investor (rule 7).
//
// Everything here is STATIC — no credential, no network — so `describe` is free
// and the walk hydrates every target rather than stubbing.

import type { SchemaEntryPoint, SchemaTypeDescriptor } from 'movement-engine/services/translation_graph/types';

import { META_RECORD_TYPE } from 'movement-engine/services/translation_graph/types';
import {
  DEALROOM_COMPANIES_COLLECTION,
  DEALROOM_COMPANY_DISPLAY_NAME,
  DEALROOM_COMPANY_INVESTORS_EDGE,
  DEALROOM_COMPANY_INVESTORS_EDGE_NAME,
  DEALROOM_COMPANY_ROUNDS_EDGE,
  DEALROOM_COMPANY_ROUNDS_EDGE_NAME,
  DEALROOM_COMPANY_SIMILAR_EDGE,
  DEALROOM_COMPANY_SIMILAR_EDGE_NAME,
  DEALROOM_COMPANY_TEAM_EDGE,
  DEALROOM_COMPANY_TEAM_EDGE_NAME,
  DEALROOM_COMPANY_TYPE_ID,
  DEALROOM_DATABASE_DISPLAY_NAME,
  DEALROOM_DATABASE_TYPE_ID,
  DEALROOM_FUNDING_ROUNDS_COLLECTION,
  DEALROOM_FUNDING_ROUND_DISPLAY_NAME,
  DEALROOM_FUNDING_ROUND_EVENT,
  DEALROOM_FUNDING_ROUND_TYPE_ID,
  DEALROOM_FUND_DISPLAY_NAME,
  DEALROOM_FUND_TYPE_ID,
  DEALROOM_INVESTORS_COLLECTION,
  DEALROOM_INVESTOR_CO_INVESTORS_EDGE,
  DEALROOM_INVESTOR_CO_INVESTORS_EDGE_NAME,
  DEALROOM_INVESTOR_DISPLAY_NAME,
  DEALROOM_INVESTOR_FUNDS_EDGE,
  DEALROOM_INVESTOR_FUNDS_EDGE_NAME,
  DEALROOM_INVESTOR_INVESTMENTS_EDGE,
  DEALROOM_INVESTOR_INVESTMENTS_EDGE_NAME,
  DEALROOM_INVESTOR_ROUNDS_EDGE,
  DEALROOM_INVESTOR_ROUNDS_EDGE_NAME,
  DEALROOM_INVESTOR_TEAM_EDGE,
  DEALROOM_INVESTOR_TEAM_EDGE_NAME,
  DEALROOM_INVESTOR_TYPE_ID,
  DEALROOM_PEOPLE_COLLECTION,
  DEALROOM_PERSON_COMPANIES_EDGE,
  DEALROOM_PERSON_COMPANIES_EDGE_NAME,
  DEALROOM_PERSON_DISPLAY_NAME,
  DEALROOM_PERSON_TYPE_ID,
  DEALROOM_ROUND_COMPANY_EDGE,
  DEALROOM_ROUND_COMPANY_EDGE_NAME,
  DEALROOM_ROUND_INVESTORS_EDGE,
  DEALROOM_ROUND_INVESTORS_EDGE_NAME,
  DEALROOM_ROUND_INVESTOR_DISPLAY_NAME,
  DEALROOM_ROUND_INVESTOR_INVESTOR_EDGE,
  DEALROOM_ROUND_INVESTOR_INVESTOR_EDGE_NAME,
  DEALROOM_ROUND_INVESTOR_TYPE_ID,
  DEALROOM_TEAM_MEMBER_DISPLAY_NAME,
  DEALROOM_TEAM_MEMBER_PERSON_EDGE,
  DEALROOM_TEAM_MEMBER_PERSON_EDGE_NAME,
  DEALROOM_TEAM_MEMBER_TYPE_ID,
} from './types';

const COMPANIES_DESCRIPTION =
  'Companies Dealroom tracks. A `Name` or `Website` filter reaches ' +
  "Dealroom's own search; so do the industry, location, stage, status, tag, " +
  'funding and year filters. Everything else is applied after the fetch. An ' +
  'unbounded walk covers the corpus and stops at the 10,000-result ceiling, so ' +
  'narrow it or give it a LIMIT.';

const INVESTORS_DESCRIPTION =
  'Investors Dealroom tracks — funds, angels, corporates. `Name`, `Website`, ' +
  '`Investor Type`, `Investment Stages`, `Industry Experience` and the HQ ' +
  "location reach Dealroom's search; everything else is applied after the fetch.";

const PEOPLE_DESCRIPTION =
  'Founders and operators Dealroom tracks. `Name`, `Website`, `Gender`, ' +
  '`Backgrounds`, the HQ location and the founder-strength flags reach the ' +
  'search.';

const FUNDING_ROUNDS_DESCRIPTION =
  'Funding rounds Dealroom has recorded. `Round`, `Date` bounds, `Amount` ' +
  'bounds, `Is Verified` and a `Created At` lower bound reach the search; walk ' +
  '`Company` for who raised and `Investors` for who put money in.';

/**
 * A root collection served by one of Dealroom's four search endpoints. The
 * WHERE reaches the search body (`filter.ts`), the ORDER BY reaches its `sort`,
 * and the LIMIT reaches its `limit` — all three are native, so a narrow walk
 * costs one request rather than a corpus scan.
 */
const ROOT_SEARCH = { filter: 'native', order: 'native', supportsLimit: true } as const;

/**
 * An edge BOUNDED by the record it leaves — one company's rounds, one
 * investor's funds, one person's affiliations. Dealroom's sub-resources take a
 * page and nothing else, so any WHERE (an `AI()` or `EXISTS()` judgement
 * included) and any ORDER BY are satisfied over what came back.
 */
const BOUNDED_BY_PARENT = {
  filter: 'bounded',
  order: 'bounded',
  supportsLimit: true,
} as const;

/**
 * The entry surface. Types reachable ONLY through a parent (a team membership, a
 * round's investor, a fund) publish `readable: false`: the root cannot
 * enumerate them, so a root collection would be a read that could only ever
 * return nothing. The entry stays published so the name resolver and `describe`
 * still know the type.
 */
export function dealroomEntryPoints(): SchemaEntryPoint[] {
  return [
    {
      typeId: DEALROOM_COMPANY_TYPE_ID,
      displayName: DEALROOM_COMPANY_DISPLAY_NAME,
      // Dealroom is read-only: its one mutating endpoint asks their team to
      // research a company it is missing, which is a support request, not a
      // record write.
      writable: false,
      readable: true,
      collectionName: DEALROOM_COMPANIES_COLLECTION,
      description: COMPANIES_DESCRIPTION,
    },
    {
      typeId: DEALROOM_INVESTOR_TYPE_ID,
      displayName: DEALROOM_INVESTOR_DISPLAY_NAME,
      writable: false,
      readable: true,
      collectionName: DEALROOM_INVESTORS_COLLECTION,
      description: INVESTORS_DESCRIPTION,
    },
    {
      typeId: DEALROOM_PERSON_TYPE_ID,
      displayName: DEALROOM_PERSON_DISPLAY_NAME,
      writable: false,
      readable: true,
      collectionName: DEALROOM_PEOPLE_COLLECTION,
      description: PEOPLE_DESCRIPTION,
    },
    {
      typeId: DEALROOM_FUNDING_ROUND_TYPE_ID,
      displayName: DEALROOM_FUNDING_ROUND_DISPLAY_NAME,
      writable: false,
      readable: true,
      collectionName: DEALROOM_FUNDING_ROUNDS_COLLECTION,
      description: FUNDING_ROUNDS_DESCRIPTION,
    },
    // The EVENT edge onto the same node the readable collection lands on
    // (adapters/CLAUDE.md rule 9 — two edges, two promises, one node).
    {
      typeId: DEALROOM_FUNDING_ROUND_TYPE_ID,
      displayName: DEALROOM_FUNDING_ROUND_DISPLAY_NAME,
      writable: false,
      readable: false,
      fires: true,
      firesOn: [DEALROOM_FUNDING_ROUND_EVENT],
      description:
        'Delivered when Dealroom records a funding round that did not exist at ' +
        'the last poll. Walk `Company` for who raised and `Investors` for who ' +
        'put money in.',
    },
    {
      typeId: DEALROOM_TEAM_MEMBER_TYPE_ID,
      displayName: DEALROOM_TEAM_MEMBER_DISPLAY_NAME,
      writable: false,
      readable: false,
    },
    {
      typeId: DEALROOM_ROUND_INVESTOR_TYPE_ID,
      displayName: DEALROOM_ROUND_INVESTOR_DISPLAY_NAME,
      writable: false,
      readable: false,
    },
    {
      typeId: DEALROOM_FUND_TYPE_ID,
      displayName: DEALROOM_FUND_DISPLAY_NAME,
      writable: false,
      readable: false,
    },
  ];
}

/** The database meta node — what this connection IS, and the edges leaving it.
 *  The one thing no `describe` can answer, so the adapter states it. */
export const DEALROOM_ROOT: SchemaTypeDescriptor = {
  typeId: META_RECORD_TYPE,
  displayName: DEALROOM_DATABASE_DISPLAY_NAME,
  description:
    'The Dealroom database. Walk `Companies`, `Investors`, `People` or ' +
    '`Funding Rounds` to look something up by name, domain or filter, then walk ' +
    'on to its rounds, investors, team and funds. Listen on `Funding Round` to ' +
    'be told when Dealroom records a new one.',
  fields: [],
  references: [
    {
      fieldId: DEALROOM_COMPANIES_COLLECTION,
      targetTypeId: DEALROOM_COMPANY_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_COMPANIES_COLLECTION,
      description: COMPANIES_DESCRIPTION,
      capability: ROOT_SEARCH,
    },
    {
      fieldId: DEALROOM_INVESTORS_COLLECTION,
      targetTypeId: DEALROOM_INVESTOR_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_INVESTORS_COLLECTION,
      description: INVESTORS_DESCRIPTION,
      capability: ROOT_SEARCH,
    },
    {
      fieldId: DEALROOM_PEOPLE_COLLECTION,
      targetTypeId: DEALROOM_PERSON_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_PEOPLE_COLLECTION,
      description: PEOPLE_DESCRIPTION,
      capability: ROOT_SEARCH,
    },
    {
      fieldId: DEALROOM_FUNDING_ROUNDS_COLLECTION,
      targetTypeId: DEALROOM_FUNDING_ROUND_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_FUNDING_ROUNDS_COLLECTION,
      description: FUNDING_ROUNDS_DESCRIPTION,
      capability: ROOT_SEARCH,
    },
    {
      fieldId: `fires:${DEALROOM_FUNDING_ROUND_TYPE_ID}`,
      targetTypeId: DEALROOM_FUNDING_ROUND_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: DEALROOM_FUNDING_ROUND_DISPLAY_NAME,
      fires: true,
      firesOn: [DEALROOM_FUNDING_ROUND_EVENT],
      readable: false,
      description: 'A newly recorded funding round — what a listen delivers.',
    },
  ],
};

const COMPANY_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: DEALROOM_COMPANY_TYPE_ID,
  displayName: DEALROOM_COMPANY_DISPLAY_NAME,
  description: 'A company on Dealroom — its profile, its funding and who backs it.',
  fields: [
    { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false, description: 'A WHERE reaches Dealroom as a name search — `=` exactly, `contains` fuzzily.', capability: { filterOperators: ['eq', 'contains'], orderable: true } },
    { fieldId: 'path', displayName: 'Path', kind: 'string', writable: false, required: false, description: "Dealroom's own slug for the company — usable in place of the id." },
    { fieldId: 'tagline', displayName: 'Tagline', kind: 'string', writable: false, required: false },
    { fieldId: 'about', displayName: 'About', kind: 'string', writable: false, required: false },
    { fieldId: 'website', displayName: 'Website', kind: 'string', writable: false, required: false, description: 'The host on its own ("acme.com"), scheme and `www.` stripped. A WHERE reaches Dealroom as a domain search — `=` exactly, `contains` fuzzily — which is the surest way to find one company.', capability: { filterOperators: ['eq', 'contains'] } },
    { fieldId: 'website_url', displayName: 'Website URL', kind: 'string', writable: false, required: false, description: 'The full URL as Dealroom records it ("https://acme.com"). Filter on `Website` — a WHERE here is applied after the fetch.' },
    { fieldId: 'linkedin_url', displayName: 'LinkedIn URL', kind: 'string', writable: false, required: false },
    { fieldId: 'twitter_url', displayName: 'Twitter URL', kind: 'string', writable: false, required: false },
    { fieldId: 'url', displayName: 'Dealroom URL', kind: 'string', writable: false, required: false, description: 'The company’s page on dealroom.co.' },
    { fieldId: 'logoUrl', displayName: 'Logo URL', kind: 'string', writable: false, required: false },
    { fieldId: 'employees', displayName: 'Employees', kind: 'string', writable: false, required: false, description: 'A bucket ("11-50"), not a count — `Employees Latest` is the count.' },
    { fieldId: 'employees_latest', displayName: 'Employees Latest', kind: 'number', writable: false, required: false },
    { fieldId: 'growth_stage', displayName: 'Growth Stage', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in'] } },
    { fieldId: 'company_status', displayName: 'Company Status', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in'] } },
    { fieldId: 'total_funding', displayName: 'Total Funding', kind: 'number', writable: false, required: false, description: 'Raised to date, in `Total Funding Currency`. Bounds are pushed to Dealroom.', capability: { filterOperators: ['gt', 'gte', 'lt', 'lte'], orderable: true } },
    { fieldId: 'total_funding_currency', displayName: 'Total Funding Currency', kind: 'string', writable: false, required: false },
    { fieldId: 'last_funding', displayName: 'Last Funding', kind: 'number', writable: false, required: false },
    { fieldId: 'last_funding_date', displayName: 'Last Funding Date', kind: 'string', writable: false, required: false, description: 'As Dealroom writes it. An ORDER BY on it reaches the search.', capability: { orderable: true } },
    { fieldId: 'launch_year', displayName: 'Launch Year', kind: 'number', writable: false, required: false, description: 'Bounds are pushed to Dealroom.', capability: { filterOperators: ['eq', 'gt', 'gte', 'lt', 'lte'] } },
    { fieldId: 'industries', displayName: 'Industries', kind: 'string', cardinality: 'many', writable: false, required: false, capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'sub_industries', displayName: 'Sub Industries', kind: 'string', cardinality: 'many', writable: false, required: false },
    { fieldId: 'technologies', displayName: 'Technologies', kind: 'string', cardinality: 'many', writable: false, required: false },
    { fieldId: 'tags', displayName: 'Tags', kind: 'string', cardinality: 'many', writable: false, required: false, capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'hqCity', displayName: 'HQ City', kind: 'string', writable: false, required: false, description: 'From the location Dealroom flags as the headquarters, else the first one. A WHERE reaches the search as a location filter.', capability: { filterOperators: ['eq', 'in'] } },
    { fieldId: 'hqCountry', displayName: 'HQ Country', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in'] } },
    { fieldId: 'job_openings', displayName: 'Job Openings', kind: 'number', writable: false, required: false },
    { fieldId: 'patents_count', displayName: 'Patents Count', kind: 'number', writable: false, required: false },
    { fieldId: 'has_strong_founder', displayName: 'Has Strong Founder', kind: 'boolean', writable: false, required: false },
    { fieldId: 'has_super_founder', displayName: 'Has Super Founder', kind: 'boolean', writable: false, required: false },
    { fieldId: 'has_promising_founder', displayName: 'Has Promising Founder', kind: 'boolean', writable: false, required: false },
    { fieldId: 'last_updated_utc', displayName: 'Last Updated', kind: 'date', writable: false, required: false, description: 'A lower bound is pushed to Dealroom; so is an ORDER BY.', capability: { filterOperators: ['gt', 'gte'], orderable: true } },
    { fieldId: 'created_utc', displayName: 'Created At', kind: 'date', writable: false, required: false, description: 'When the company was added to Dealroom. A lower bound is pushed to Dealroom; so is an ORDER BY.', capability: { filterOperators: ['gt', 'gte'], orderable: true } },
  ],
  references: [
    {
      fieldId: DEALROOM_COMPANY_ROUNDS_EDGE,
      targetTypeId: DEALROOM_FUNDING_ROUND_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_COMPANY_ROUNDS_EDGE_NAME,
      description:
        'Every round this company has raised. Fetched from the company’s own ' +
        'rounds endpoint, so it is the full list rather than the five that ride ' +
        'the company payload.',
      capability: BOUNDED_BY_PARENT,
    },
    {
      fieldId: DEALROOM_COMPANY_INVESTORS_EDGE,
      targetTypeId: DEALROOM_INVESTOR_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_COMPANY_INVESTORS_EDGE_NAME,
      description:
        'Everyone who has invested in this company. Which of them LED a round ' +
        'is a fact about the round, so it lives on the round’s `Investors`.',
      capability: BOUNDED_BY_PARENT,
    },
    {
      fieldId: DEALROOM_COMPANY_TEAM_EDGE,
      targetTypeId: DEALROOM_TEAM_MEMBER_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_COMPANY_TEAM_EDGE_NAME,
      description:
        'The people on this company, each as a membership carrying their titles ' +
        'and years. Walk `Person` from one for the full profile.',
      capability: BOUNDED_BY_PARENT,
    },
    {
      fieldId: DEALROOM_COMPANY_SIMILAR_EDGE,
      targetTypeId: DEALROOM_COMPANY_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_COMPANY_SIMILAR_EDGE_NAME,
      description: 'Dealroom’s own "companies like this one" list.',
      capability: BOUNDED_BY_PARENT,
    },
  ],
};

const INVESTOR_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: DEALROOM_INVESTOR_TYPE_ID,
  displayName: DEALROOM_INVESTOR_DISPLAY_NAME,
  description: 'An investor on Dealroom — a fund, an angel or a corporate.',
  fields: [
    { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false, description: 'A WHERE reaches Dealroom as a name search — `=` exactly, `contains` fuzzily.', capability: { filterOperators: ['eq', 'contains'], orderable: true } },
    { fieldId: 'path', displayName: 'Path', kind: 'string', writable: false, required: false },
    { fieldId: 'investor_type', displayName: 'Investor Type', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in'] } },
    { fieldId: 'tagline', displayName: 'Tagline', kind: 'string', writable: false, required: false },
    { fieldId: 'about', displayName: 'About', kind: 'string', writable: false, required: false },
    { fieldId: 'website', displayName: 'Website', kind: 'string', writable: false, required: false, description: 'The host on its own ("acme.com"), scheme and `www.` stripped. A WHERE reaches Dealroom as a domain search — `=` exactly, `contains` fuzzily.', capability: { filterOperators: ['eq', 'contains'] } },
    { fieldId: 'website_url', displayName: 'Website URL', kind: 'string', writable: false, required: false, description: 'The full URL as Dealroom records it ("https://acme.com"). Filter on `Website` — a WHERE here is applied after the fetch.' },
    { fieldId: 'linkedin_url', displayName: 'LinkedIn URL', kind: 'string', writable: false, required: false },
    { fieldId: 'url', displayName: 'Dealroom URL', kind: 'string', writable: false, required: false },
    { fieldId: 'logoUrl', displayName: 'Logo URL', kind: 'string', writable: false, required: false },
    { fieldId: 'employees', displayName: 'Employees', kind: 'string', writable: false, required: false },
    { fieldId: 'deal_size', displayName: 'Deal Size', kind: 'string', writable: false, required: false, description: 'The cheque range Dealroom records, as written.' },
    { fieldId: 'launch_year', displayName: 'Launch Year', kind: 'number', writable: false, required: false },
    { fieldId: 'total_funding', displayName: 'Total Funding', kind: 'number', writable: false, required: false, capability: { orderable: true } },
    { fieldId: 'recent_funding', displayName: 'Recent Funding', kind: 'number', writable: false, required: false },
    { fieldId: 'investments_num', displayName: 'Investments Count', kind: 'number', writable: false, required: false },
    { fieldId: 'investment_stages', displayName: 'Investment Stages', kind: 'string', cardinality: 'many', writable: false, required: false, capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'industry_experience', displayName: 'Industry Experience', kind: 'string', cardinality: 'many', writable: false, required: false, capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'location_experience', displayName: 'Location Experience', kind: 'string', cardinality: 'many', writable: false, required: false },
    { fieldId: 'tags', displayName: 'Tags', kind: 'string', cardinality: 'many', writable: false, required: false },
    { fieldId: 'hqCity', displayName: 'HQ City', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in'] } },
    { fieldId: 'hqCountry', displayName: 'HQ Country', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in'] } },
    { fieldId: 'last_updated_utc', displayName: 'Last Updated', kind: 'date', writable: false, required: false, capability: { filterOperators: ['gt', 'gte'], orderable: true } },
    { fieldId: 'created_utc', displayName: 'Created At', kind: 'date', writable: false, required: false, capability: { filterOperators: ['gt', 'gte'], orderable: true } },
  ],
  references: [
    {
      fieldId: DEALROOM_INVESTOR_INVESTMENTS_EDGE,
      targetTypeId: DEALROOM_COMPANY_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_INVESTOR_INVESTMENTS_EDGE_NAME,
      description:
        'The companies this investor has backed. Whether they have since exited ' +
        'is not surfaced — say so rather than inferring it.',
      capability: BOUNDED_BY_PARENT,
    },
    {
      fieldId: DEALROOM_INVESTOR_ROUNDS_EDGE,
      targetTypeId: DEALROOM_FUNDING_ROUND_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_INVESTOR_ROUNDS_EDGE_NAME,
      description: 'The rounds this investor took part in.',
      capability: BOUNDED_BY_PARENT,
    },
    {
      fieldId: DEALROOM_INVESTOR_CO_INVESTORS_EDGE,
      targetTypeId: DEALROOM_INVESTOR_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_INVESTOR_CO_INVESTORS_EDGE_NAME,
      description: 'Investors who have been in rounds alongside this one.',
      capability: BOUNDED_BY_PARENT,
    },
    {
      fieldId: DEALROOM_INVESTOR_FUNDS_EDGE,
      targetTypeId: DEALROOM_FUND_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_INVESTOR_FUNDS_EDGE_NAME,
      description: 'The funds this investor manages.',
      capability: BOUNDED_BY_PARENT,
    },
    {
      fieldId: DEALROOM_INVESTOR_TEAM_EDGE,
      targetTypeId: DEALROOM_TEAM_MEMBER_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_INVESTOR_TEAM_EDGE_NAME,
      description:
        'The people at this investor, each as a membership carrying their ' +
        'titles and years.',
      capability: BOUNDED_BY_PARENT,
    },
  ],
};

const PERSON_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: DEALROOM_PERSON_TYPE_ID,
  displayName: DEALROOM_PERSON_DISPLAY_NAME,
  description:
    'A person on Dealroom — a founder or an operator. The same entity a ' +
    'company’s or investor’s team member resolves to.',
  fields: [
    { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'contains'], orderable: true } },
    { fieldId: 'path', displayName: 'Path', kind: 'string', writable: false, required: false },
    { fieldId: 'tagline', displayName: 'Tagline', kind: 'string', writable: false, required: false },
    { fieldId: 'linkedin_url', displayName: 'LinkedIn URL', kind: 'string', writable: false, required: false },
    { fieldId: 'twitter_url', displayName: 'Twitter URL', kind: 'string', writable: false, required: false },
    { fieldId: 'website', displayName: 'Website', kind: 'string', writable: false, required: false, description: 'The host on its own ("acme.com"), scheme and `www.` stripped. A WHERE reaches Dealroom as a domain search — `=` exactly, `contains` fuzzily.', capability: { filterOperators: ['eq', 'contains'] } },
    { fieldId: 'website_url', displayName: 'Website URL', kind: 'string', writable: false, required: false, description: 'The full URL as Dealroom records it ("https://acme.com"). Filter on `Website` — a WHERE here is applied after the fetch.' },
    { fieldId: 'url', displayName: 'Dealroom URL', kind: 'string', writable: false, required: false },
    { fieldId: 'logoUrl', displayName: 'Logo URL', kind: 'string', writable: false, required: false },
    { fieldId: 'gender', displayName: 'Gender', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in'] } },
    { fieldId: 'is_founder', displayName: 'Is Founder', kind: 'boolean', writable: false, required: false },
    { fieldId: 'is_serial_founder', displayName: 'Is Serial Founder', kind: 'boolean', writable: false, required: false },
    { fieldId: 'is_strong_founder', displayName: 'Is Strong Founder', kind: 'boolean', writable: false, required: false, capability: { filterOperators: ['eq'] } },
    { fieldId: 'is_super_founder', displayName: 'Is Super Founder', kind: 'boolean', writable: false, required: false, capability: { filterOperators: ['eq'] } },
    { fieldId: 'is_promising_founder', displayName: 'Is Promising Founder', kind: 'boolean', writable: false, required: false, capability: { filterOperators: ['eq'] } },
    { fieldId: 'founder_score', displayName: 'Founder Score', kind: 'number', writable: false, required: false },
    { fieldId: 'founded_companies_total_funding', displayName: 'Founded Companies Total Funding', kind: 'number', writable: false, required: false },
    { fieldId: 'backgrounds', displayName: 'Backgrounds', kind: 'string', cardinality: 'many', writable: false, required: false, capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'hqCity', displayName: 'HQ City', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in'] } },
    { fieldId: 'hqCountry', displayName: 'HQ Country', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in'] } },
    { fieldId: 'last_updated_utc', displayName: 'Last Updated', kind: 'date', writable: false, required: false, capability: { filterOperators: ['gt', 'gte'], orderable: true } },
    { fieldId: 'created_utc', displayName: 'Created At', kind: 'date', writable: false, required: false, capability: { filterOperators: ['gt', 'gte'], orderable: true } },
  ],
  references: [
    {
      fieldId: DEALROOM_PERSON_COMPANIES_EDGE,
      targetTypeId: DEALROOM_COMPANY_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_PERSON_COMPANIES_EDGE_NAME,
      description:
        'The companies this person is or was at. Dealroom has no endpoint for ' +
        'them, so they ride the person’s own record and a walk costs no extra ' +
        'fetch — they carry the summary fields rather than the full company.',
      capability: BOUNDED_BY_PARENT,
    },
  ],
};

const FUNDING_ROUND_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: DEALROOM_FUNDING_ROUND_TYPE_ID,
  displayName: DEALROOM_FUNDING_ROUND_DISPLAY_NAME,
  description: 'One funding round — who raised, how much, and from whom.',
  fields: [
    { fieldId: 'round', displayName: 'Round', kind: 'string', writable: false, required: false, description: 'As Dealroom labels it ("SERIES A", "SEED"). A WHERE reaches the search.', capability: { filterOperators: ['eq', 'in'] } },
    { fieldId: 'standardised_round_label', displayName: 'Standardised Round Label', kind: 'string', writable: false, required: false },
    { fieldId: 'year', displayName: 'Year', kind: 'number', writable: false, required: false },
    { fieldId: 'month', displayName: 'Month', kind: 'number', writable: false, required: false },
    { fieldId: 'date', displayName: 'Date', kind: 'date', writable: false, required: false, description: 'The round’s year and month as a date (the first of the month — Dealroom records no day). Bounds and an ORDER BY are pushed to the search.', capability: { filterOperators: ['gt', 'gte', 'lt', 'lte'], orderable: true } },
    { fieldId: 'amount', displayName: 'Amount', kind: 'number', writable: false, required: false, description: 'In `Currency`. Bounds are pushed to Dealroom.', capability: { filterOperators: ['gt', 'gte', 'lt', 'lte'], orderable: true } },
    { fieldId: 'currency', displayName: 'Currency', kind: 'string', writable: false, required: false },
    { fieldId: 'amount_usd_million', displayName: 'Amount USD Million', kind: 'number', writable: false, required: false },
    { fieldId: 'amount_eur_million', displayName: 'Amount EUR Million', kind: 'number', writable: false, required: false },
    { fieldId: 'valuation', displayName: 'Valuation', kind: 'number', writable: false, required: false },
    { fieldId: 'is_verified', displayName: 'Is Verified', kind: 'boolean', writable: false, required: false, description: 'Whether Dealroom has confirmed the round rather than inferring it from news.', capability: { filterOperators: ['eq'] } },
    { fieldId: 'is_undisclosed', displayName: 'Is Undisclosed', kind: 'boolean', writable: false, required: false },
    { fieldId: 'news_source', displayName: 'News Source', kind: 'string', writable: false, required: false },
    { fieldId: 'unknown_investors', displayName: 'Unknown Investors', kind: 'string', cardinality: 'many', writable: false, required: false, description: 'Participants Dealroom has a name for but no investor record — they are NOT on `Investors`.' },
    { fieldId: 'last_updated_utc', displayName: 'Last Updated', kind: 'date', writable: false, required: false, capability: { filterOperators: ['gt', 'gte'], orderable: true } },
    { fieldId: 'created_utc', displayName: 'Created At', kind: 'date', writable: false, required: false, description: 'When Dealroom recorded the round — what a listener’s "new since last poll" is measured on.', capability: { filterOperators: ['gt', 'gte'], orderable: true } },
  ],
  references: [
    {
      fieldId: DEALROOM_ROUND_COMPANY_EDGE,
      targetTypeId: DEALROOM_COMPANY_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: DEALROOM_ROUND_COMPANY_EDGE_NAME,
      description: 'The company that raised.',
    },
    {
      fieldId: DEALROOM_ROUND_INVESTORS_EDGE,
      targetTypeId: DEALROOM_ROUND_INVESTOR_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: DEALROOM_ROUND_INVESTORS_EDGE_NAME,
      description:
        'Who put money in, each as a participation carrying whether they led. ' +
        'Walk `Investor` from one for the full record.',
      capability: BOUNDED_BY_PARENT,
    },
  ],
};

const TEAM_MEMBER_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: DEALROOM_TEAM_MEMBER_TYPE_ID,
  displayName: DEALROOM_TEAM_MEMBER_DISPLAY_NAME,
  description:
    'One person’s position at one company or investor. The titles and years ' +
    'belong to the pair rather than to either end, which is why the membership ' +
    'is its own node.',
  fields: [
    { fieldId: 'titles', displayName: 'Titles', kind: 'string', cardinality: 'many', writable: false, required: false },
    { fieldId: 'is_founder', displayName: 'Is Founder', kind: 'boolean', writable: false, required: false },
    { fieldId: 'is_executive', displayName: 'Is Executive', kind: 'boolean', writable: false, required: false },
    { fieldId: 'is_partner', displayName: 'Is Partner', kind: 'boolean', writable: false, required: false },
    { fieldId: 'past', displayName: 'Past', kind: 'boolean', writable: false, required: false, description: 'True once the person has left.' },
    { fieldId: 'year_start', displayName: 'Start Year', kind: 'number', writable: false, required: false },
    { fieldId: 'year_end', displayName: 'End Year', kind: 'number', writable: false, required: false },
    { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false },
    { fieldId: 'linkedin_url', displayName: 'LinkedIn URL', kind: 'string', writable: false, required: false },
    { fieldId: 'url', displayName: 'Dealroom URL', kind: 'string', writable: false, required: false },
  ],
  references: [
    {
      fieldId: DEALROOM_TEAM_MEMBER_PERSON_EDGE,
      targetTypeId: DEALROOM_PERSON_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: DEALROOM_TEAM_MEMBER_PERSON_EDGE_NAME,
      description: 'The person, with their full profile. Costs one fetch.',
    },
  ],
};

const ROUND_INVESTOR_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: DEALROOM_ROUND_INVESTOR_TYPE_ID,
  displayName: DEALROOM_ROUND_INVESTOR_DISPLAY_NAME,
  description:
    'One investor’s participation in one round. Leading is a fact about the ' +
    'pair, which is why the participation is its own node.',
  fields: [
    { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false },
    { fieldId: 'lead', displayName: 'Lead', kind: 'boolean', writable: false, required: false, description: 'Whether this investor led the round.' },
    { fieldId: 'url', displayName: 'Dealroom URL', kind: 'string', writable: false, required: false },
  ],
  references: [
    {
      fieldId: DEALROOM_ROUND_INVESTOR_INVESTOR_EDGE,
      targetTypeId: DEALROOM_INVESTOR_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: DEALROOM_ROUND_INVESTOR_INVESTOR_EDGE_NAME,
      description: 'The investor, with their full record. Costs one fetch.',
    },
  ],
};

const FUND_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: DEALROOM_FUND_TYPE_ID,
  displayName: DEALROOM_FUND_DISPLAY_NAME,
  description:
    'One fund under an investor’s management. Dealroom gives a fund no page ' +
    'and no search, so it is only reachable through its investor.',
  fields: [
    { fieldId: 'fund_name', displayName: 'Name', kind: 'string', writable: false, required: false },
    { fieldId: 'fund_type', displayName: 'Fund Type', kind: 'string', writable: false, required: false },
    { fieldId: 'amount', displayName: 'Amount', kind: 'number', writable: false, required: false },
    { fieldId: 'currency', displayName: 'Currency', kind: 'string', writable: false, required: false },
    { fieldId: 'is_closed', displayName: 'Is Closed', kind: 'boolean', writable: false, required: false },
    { fieldId: 'date', displayName: 'Date', kind: 'date', writable: false, required: false },
  ],
  references: [],
};

const DESCRIPTORS: Record<string, SchemaTypeDescriptor> = {
  [DEALROOM_COMPANY_TYPE_ID]: COMPANY_DESCRIPTOR,
  [DEALROOM_INVESTOR_TYPE_ID]: INVESTOR_DESCRIPTOR,
  [DEALROOM_PERSON_TYPE_ID]: PERSON_DESCRIPTOR,
  [DEALROOM_FUNDING_ROUND_TYPE_ID]: FUNDING_ROUND_DESCRIPTOR,
  [DEALROOM_TEAM_MEMBER_TYPE_ID]: TEAM_MEMBER_DESCRIPTOR,
  [DEALROOM_ROUND_INVESTOR_TYPE_ID]: ROUND_INVESTOR_DESCRIPTOR,
  [DEALROOM_FUND_TYPE_ID]: FUND_DESCRIPTOR,
};

/** The database meta descriptor — the same node `edgesFrom` roots at, but
 *  addressed by type id (author-time introspection reaches it that way). */
export const DEALROOM_DATABASE_DESCRIPTOR: SchemaTypeDescriptor = {
  ...DEALROOM_ROOT,
  typeId: DEALROOM_DATABASE_TYPE_ID,
};

/** `describe` over an already-resolved INTERNAL type id. Null for an id this
 *  adapter does not own. */
export function describeDealroomType(typeId: string): SchemaTypeDescriptor | null {
  return DESCRIPTORS[typeId] ?? null;
}

/** The `fields` list a search asks for, per entity. Dealroom's search defaults
 *  are narrow (a company comes back as id/name/path/images/tagline/…), so every
 *  search names exactly what the descriptors above read — otherwise half the
 *  fields would be null for no reason the author could see. */
export const DEALROOM_SEARCH_FIELDS: Record<string, string> = {
  [DEALROOM_COMPANY_TYPE_ID]: [
    'id', 'name', 'path', 'tagline', 'about', 'url', 'website_url', 'linkedin_url',
    'twitter_url', 'images', 'employees', 'employees_latest', 'growth_stage',
    'company_status', 'total_funding', 'total_funding_currency', 'last_funding',
    'last_funding_date', 'launch_year', 'industries', 'sub_industries', 'technologies',
    'tags', 'hq_locations', 'job_openings', 'patents_count', 'has_strong_founder',
    'has_super_founder', 'has_promising_founder', 'last_updated_utc', 'created_utc',
  ].join(','),
  [DEALROOM_INVESTOR_TYPE_ID]: [
    'id', 'name', 'path', 'investor_type', 'tagline', 'about', 'url', 'website_url',
    'linkedin_url', 'images', 'employees', 'deal_size', 'launch_year', 'total_funding',
    'recent_funding', 'investments_num', 'investment_stages', 'industry_experience',
    'location_experience', 'tags', 'hq_locations', 'last_updated_utc', 'created_utc',
  ].join(','),
  [DEALROOM_PERSON_TYPE_ID]: [
    'id', 'name', 'path', 'tagline', 'url', 'website_url', 'linkedin_url', 'twitter_url',
    'images', 'gender', 'is_founder', 'is_serial_founder', 'is_strong_founder',
    'is_super_founder', 'is_promising_founder', 'founder_score',
    'founded_companies_total_funding', 'backgrounds', 'hq_locations', 'last_updated_utc',
    'created_utc',
    // The one edge with no endpoint behind it: the affiliations ride the person.
    'companies(id,name,path,url,images,website_url,tagline,hq_locations)',
  ].join(','),
  [DEALROOM_FUNDING_ROUND_TYPE_ID]: [
    'id', 'round', 'standardised_round_label', 'year', 'month', 'amount', 'currency',
    'amount_usd_million', 'amount_eur_million', 'valuation', 'is_verified',
    'is_undisclosed', 'news_source', 'unknown_investors', 'last_updated_utc',
    'created_utc',
    'company(id,name,path,url,images,website_url,tagline,growth_stage,industries,hq_locations,total_funding,total_funding_currency)',
    'investors(id,name,path,url,images,lead)',
  ].join(','),
};
