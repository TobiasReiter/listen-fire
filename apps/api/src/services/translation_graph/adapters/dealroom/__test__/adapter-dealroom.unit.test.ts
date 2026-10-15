// Dealroom adapter + PollSource — the entry surface, every describe, the edge
// walks, the WHERE/ORDER BY pushdown and the poll's checkpoint behaviour.
// No network: the API client is faked.

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));
jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Expression } from '#shared/expression/types';

import {
  ADAPTER_META_TYPE_ID,
  makeMetaPosition,
  makeStablePosition,
  positionRecordId,
} from 'movement-engine/services/translation_graph/types';
import {
  DEALROOM_MAX_OFFSET,
  DealroomOffsetCapError,
  parseDealroomInstant,
  type DealroomApiClient,
  type DealroomCompany,
  type DealroomFund,
  type DealroomFundingRound,
  type DealroomInvestor,
  type DealroomPage,
  type DealroomPerson,
  type DealroomSearchRequest,
  type DealroomTeamMember,
} from '../../../../../adapters/dealroom/apiClient';
import { DealroomAdapter, DEALROOM_MANIFEST, createDealroomAdapter } from '../index';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { normaliseSchemaForAgent } from '../../../movement/agent_schema';
import { DealroomPollSource, listenFilters } from '../poll';
import {
  companySearchFromWhere,
  fundingRoundSearchFromWhere,
  investorSearchFromWhere,
  personSearchFromWhere,
  sortFromOrderBy,
  teamRequestFromWhere,
} from '../filter';
import {
  DEALROOM_COMPANY_TYPE_ID,
  DEALROOM_DATABASE_TYPE_ID,
  DEALROOM_FUNDING_ROUND_TYPE_ID,
  DEALROOM_FUND_TYPE_ID,
  DEALROOM_INVESTOR_TYPE_ID,
  DEALROOM_PERSON_TYPE_ID,
  DEALROOM_ROUND_INVESTOR_TYPE_ID,
  DEALROOM_TEAM_MEMBER_TYPE_ID,
  decodePairId,
  encodePairId,
} from '../types';

const TEAM = 'team-1' as TeamId;

const CREATED_UTC = '2026-09-10 08:00:00';
const CREATED_MS = Date.UTC(2026, 8, 10, 8, 0, 0);

// ── fixtures ────────────────────────────────────────────────────────────────

function company(over: Partial<DealroomCompany> = {}): DealroomCompany {
  return {
    id: 101,
    name: 'Acme',
    path: 'acme',
    tagline: 'We make things',
    about: 'A longer write-up.',
    url: 'https://dealroom.co/companies/acme',
    website_url: 'acme.com',
    linkedin_url: 'https://linkedin.com/company/acme',
    twitter_url: null,
    images: { '32x32': null, '74x74': null, '100x100': 'https://img.example/acme.png' },
    employees: '11-50',
    employees_latest: 42,
    growth_stage: 'early growth',
    company_status: 'operational',
    total_funding: 12_000_000,
    total_funding_currency: 'EUR',
    last_funding: 5_000_000,
    last_funding_date: '2026-05-01',
    launch_year: 2019,
    industries: [{ id: 1, name: 'fintech' }],
    sub_industries: ['payments'],
    technologies: ['ai'],
    tags: ['saas'],
    hq_locations: [
      { id: 9, is_headquarters: false, city: { name: 'Lyon' }, country: { name: 'France' } },
      { id: 7, is_headquarters: true, city: { name: 'Berlin' }, country: { name: 'Germany' } },
    ],
    job_openings: 3,
    patents_count: 1,
    has_strong_founder: true,
    has_super_founder: false,
    has_promising_founder: false,
    last_updated: null,
    last_updated_utc: '2026-09-12 10:30:00',
    created_utc: CREATED_UTC,
    ...over,
  };
}

function investor(over: Partial<DealroomInvestor> = {}): DealroomInvestor {
  return {
    id: 201,
    name: 'Index Ventures',
    path: 'index_ventures',
    investor_type: 'vc',
    tagline: null,
    about: null,
    url: 'https://dealroom.co/investors/index_ventures',
    website_url: 'indexventures.com',
    linkedin_url: null,
    images: { '100x100': 'https://img.example/index.png' },
    employees: '51-200',
    deal_size: '1m-10m',
    launch_year: 1996,
    total_funding: 0,
    recent_funding: 0,
    investments_num: 900,
    investment_stages: ['seed', 'series a'],
    industry_experience: [{ id: 1, name: 'fintech' }],
    location_experience: [{ id: 2, name: 'Europe' }],
    tags: [],
    hq_locations: [{ id: 3, is_headquarters: true, city: { name: 'London' }, country: { name: 'United Kingdom' } }],
    last_updated: null,
    last_updated_utc: '2026-09-11 09:00:00',
    created_utc: CREATED_UTC,
    ...over,
  };
}

function person(over: Partial<DealroomPerson> = {}): DealroomPerson {
  return {
    id: 301,
    name: 'Ada Byron',
    path: 'ada_byron',
    tagline: 'Founder at Acme',
    url: 'https://dealroom.co/founders/ada_byron',
    website_url: null,
    linkedin_url: 'https://linkedin.com/in/ada',
    twitter_url: null,
    images: { '100x100': 'https://img.example/ada.png' },
    gender: 'female',
    is_founder: true,
    is_serial_founder: true,
    is_strong_founder: true,
    is_super_founder: false,
    is_promising_founder: false,
    founder_score: 8,
    founded_companies_total_funding: 12_000_000,
    backgrounds: [{ id: 4, name: 'Big Tech' }],
    hq_locations: [{ id: 7, is_headquarters: true, city: { name: 'Berlin' }, country: { name: 'Germany' } }],
    last_updated: null,
    last_updated_utc: '2026-09-09 09:00:00',
    created_utc: CREATED_UTC,
    companies: { total: 1, items: [company({ id: 102, name: 'Difference Engine' })] },
    ...over,
  };
}

function round(over: Partial<DealroomFundingRound> = {}): DealroomFundingRound {
  return {
    id: 401,
    round: 'SERIES A',
    standardised_round_label: 'series a',
    year: 2026,
    month: 5,
    amount: 8_000_000,
    currency: 'EUR',
    amount_usd_million: 8.6,
    amount_eur_million: 8,
    valuation: 40_000_000,
    is_verified: true,
    is_undisclosed: false,
    news_source: 'https://news.example/acme',
    unknown_investors: ['A family office'],
    last_updated: null,
    last_updated_utc: '2026-09-10 08:00:00',
    created_utc: CREATED_UTC,
    company: company(),
    investors: [{ id: 201, name: 'Index Ventures', path: 'index_ventures', url: 'https://dealroom.co/investors/index_ventures', lead: true }],
    ...over,
  };
}

function teamMember(over: Partial<DealroomTeamMember> = {}): DealroomTeamMember {
  return {
    id: 301,
    name: 'Ada Byron',
    path: 'ada_byron',
    url: 'https://dealroom.co/founders/ada_byron',
    linkedin_url: 'https://linkedin.com/in/ada',
    titles: [{ id: 1, name: 'CEO' }, { id: 2, name: 'Co-founder' }],
    past: false,
    is_founder: true,
    is_executive: true,
    is_partner: false,
    year_start: 2019,
    year_end: null,
    ...over,
  };
}

function fund(over: Partial<DealroomFund> = {}): DealroomFund {
  return {
    id: 501,
    fund_name: 'Index Growth VI',
    fund_type: 'growth',
    amount: 900_000_000,
    currency: 'USD',
    is_closed: true,
    date: '2026-01-01',
    date_utc: '2026-01-01 00:00:00',
    ...over,
  };
}

const page = <T,>(items: T[]): DealroomPage<T> => ({ total: items.length, items });

/** A page-one-only fake: every listing answers with the rows it was given, so a
 *  short page ends the walk on the first request. */
function fakeClient(
  over: Partial<Record<keyof DealroomApiClient, unknown>> = {},
): DealroomApiClient {
  return {
    searchCompanies: async () => page([company()]),
    searchInvestors: async () => page([investor()]),
    searchPeople: async () => page([person()]),
    searchFundingRounds: async () => page([round()]),
    getCompany: async () => company(),
    getInvestor: async () => investor(),
    getPerson: async () => person(),
    listCompanyFundingRounds: async () => page([round()]),
    listCompanyInvestors: async () => page([investor()]),
    listCompanyTeam: async () => page([teamMember()]),
    listSimilarCompanies: async () => page([company({ id: 103, name: 'Beta' })]),
    listInvestorInvestments: async () => page([company()]),
    listInvestorFundingRounds: async () => page([round()]),
    listInvestorCoInvestors: async () => page([investor({ id: 202, name: 'Accel' })]),
    listInvestorFunds: async () => page([fund()]),
    listInvestorTeam: async () => page([teamMember()]),
    ...over,
  } as unknown as DealroomApiClient;
}

const adapterWith = (client: DealroomApiClient) => new DealroomAdapter(TEAM, 'cred-1', client);

// The engine's source-read wrapper restamps a position's recordType to the
// NATURAL type name before a field/edge read. Mirror that here.
const at = (recordType: string, recordId: string, data: unknown) =>
  makeStablePosition({ adapterType: 'dealroom', recordType, recordId, data });

// WHERE-expression builders, in the shape the engine pushes.
const prop = (name: string): Expression => ({ type: 'property', propertyTypeId: name }) as Expression;
const value = (v: string | number | boolean | null): Expression =>
  ({ type: 'static', value: v }) as Expression;
const list = (...vs: Array<string | number>): Expression =>
  ({ type: 'list', elements: vs.map(value) }) as Expression;
const cmp = (
  left: Expression,
  op: 'eq' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte',
  right: Expression,
): Expression => ({ type: 'compare', op, left, right }) as Expression;
const and = (...operands: Expression[]): Expression =>
  ({ type: 'logical', op: 'and', operands }) as Expression;

// ── entry surface ───────────────────────────────────────────────────────────

describe('DealroomAdapter entry surface', () => {
  const adapter = createDealroomAdapter({ teamId: TEAM });

  it('publishes one entry per type, with a root collection only where the root can enumerate', async () => {
    const entries = await adapter.listEntryPoints();
    expect(
      entries.map((e) => ({
        typeId: e.typeId,
        readable: e.readable,
        writable: e.writable,
        fires: e.fires ?? false,
        collection: e.collectionName ?? null,
      })),
    ).toEqual([
      { typeId: DEALROOM_COMPANY_TYPE_ID, readable: true, writable: false, fires: false, collection: 'Companies' },
      { typeId: DEALROOM_INVESTOR_TYPE_ID, readable: true, writable: false, fires: false, collection: 'Investors' },
      { typeId: DEALROOM_PERSON_TYPE_ID, readable: true, writable: false, fires: false, collection: 'People' },
      { typeId: DEALROOM_FUNDING_ROUND_TYPE_ID, readable: true, writable: false, fires: false, collection: 'Funding Rounds' },
      { typeId: DEALROOM_FUNDING_ROUND_TYPE_ID, readable: false, writable: false, fires: true, collection: null },
      { typeId: DEALROOM_TEAM_MEMBER_TYPE_ID, readable: false, writable: false, fires: false, collection: null },
      { typeId: DEALROOM_ROUND_INVESTOR_TYPE_ID, readable: false, writable: false, fires: false, collection: null },
      { typeId: DEALROOM_FUND_TYPE_ID, readable: false, writable: false, fires: false, collection: null },
    ]);
  });

  it('declares the poll trigger, the Dealroom credential, the one event kind and the listen options', () => {
    expect(DEALROOM_MANIFEST.supportedTriggers).toEqual(['poll']);
    expect(DEALROOM_MANIFEST.requiredCredentialType).toBe('DEALROOM');
    expect(DEALROOM_MANIFEST.triggerKinds).toEqual(['DEALROOM']);
    expect(DEALROOM_MANIFEST.subscribableEvents).toEqual(['funding_round']);
    expect(DEALROOM_MANIFEST.defaultSubscribedEvents).toEqual(['funding_round']);
    expect(DEALROOM_MANIFEST.listenConfig?.map((k) => k.key)).toEqual([
      'rounds',
      'industries',
      'hq_locations',
      'pollIntervalSeconds',
    ]);
    // Dealroom has no record-writing endpoint at all.
    expect(DEALROOM_MANIFEST.methods).not.toEqual(expect.arrayContaining(['createRecord']));
  });
});

// ── describe ────────────────────────────────────────────────────────────────

describe('DealroomAdapter.describe', () => {
  const adapter = createDealroomAdapter({ teamId: TEAM });

  it('describes the database meta node with the four root collections plus the event edge', async () => {
    for (const ref of [ADAPTER_META_TYPE_ID, DEALROOM_DATABASE_TYPE_ID]) {
      const d = await adapter.describe(ref);
      expect(d?.typeId).toBe(DEALROOM_DATABASE_TYPE_ID);
      expect(d?.references.map((r) => r.name)).toEqual([
        'Companies', 'Investors', 'People', 'Funding Rounds', 'Funding Round',
      ]);
      expect(d?.references.filter((r) => r.fires).map((r) => r.name)).toEqual(['Funding Round']);
      // Nothing on Dealroom is writable.
      expect(d?.references.filter((r) => r.writable)).toEqual([]);
      // Every root collection pushes filter, order AND limit.
      for (const collection of ['Companies', 'Investors', 'People', 'Funding Rounds']) {
        expect(d?.references.find((r) => r.name === collection)?.capability).toEqual({
          filter: 'native',
          order: 'native',
          supportsLimit: true,
        });
      }
    }
  });

  it('describes a company, its pushable fields and its four edges', async () => {
    const d = await adapter.describe('Company');
    expect(d?.typeId).toBe(DEALROOM_COMPANY_TYPE_ID);
    expect(d?.fields.every((f) => f.writable === false)).toBe(true);
    expect(d?.fields.map((f) => f.displayName)).toEqual([
      'Name', 'Path', 'Tagline', 'About', 'Website', 'Website URL', 'LinkedIn URL',
      'Twitter URL',
      'Dealroom URL', 'Logo URL', 'Employees', 'Employees Latest', 'Growth Stage',
      'Company Status', 'Total Funding', 'Total Funding Currency', 'Last Funding',
      'Last Funding Date', 'Launch Year', 'Industries', 'Sub Industries', 'Technologies',
      'Tags', 'HQ City', 'HQ Country', 'Job Openings', 'Patents Count',
      'Has Strong Founder', 'Has Super Founder', 'Has Promising Founder',
      'Last Updated', 'Created At',
    ]);
    expect(d?.fields.find((f) => f.displayName === 'Name')?.capability).toEqual({
      filterOperators: ['eq', 'contains'],
      orderable: true,
    });
    // The domain pushes; the full URL is the engine's to satisfy, so an author
    // who filters on it is never told a search happened that did not.
    expect(d?.fields.find((f) => f.displayName === 'Website')?.capability).toEqual({
      filterOperators: ['eq', 'contains'],
    });
    expect(d?.fields.find((f) => f.displayName === 'Website URL')?.capability).toBeUndefined();
    expect(d?.references.map((r) => r.name)).toEqual([
      'Funding Rounds', 'Investors', 'Team', 'Similar Companies',
    ]);
  });

  it('describes an investor, a person and a funding round', async () => {
    const investorType = await adapter.describe('Investor');
    expect(investorType?.references.map((r) => r.name)).toEqual([
      'Investments', 'Funding Rounds', 'Co-Investors', 'Funds', 'Team',
    ]);

    const personType = await adapter.describe('Person');
    expect(personType?.references.map((r) => r.name)).toEqual(['Companies']);
    expect(personType?.fields.map((f) => f.displayName)).toEqual(
      expect.arrayContaining(['Founder Score', 'Backgrounds', 'HQ City', 'HQ Country']),
    );

    const roundType = await adapter.describe('Funding Round');
    expect(roundType?.references.map((r) => ({ name: r.name, cardinality: r.cardinality }))).toEqual([
      { name: 'Company', cardinality: 'one' },
      { name: 'Investors', cardinality: 'many' },
    ]);
  });

  it('describes the pair nodes and the fund', async () => {
    const member = await adapter.describe('Team Member');
    expect(member?.fields.map((f) => f.displayName)).toEqual([
      'Titles', 'Is Founder', 'Is Executive', 'Is Partner', 'Past', 'Start Year',
      'End Year', 'Name', 'LinkedIn URL', 'Dealroom URL',
    ]);
    expect(member?.references.map((r) => r.name)).toEqual(['Person']);

    const participation = await adapter.describe('Round Investor');
    expect(participation?.fields.map((f) => f.displayName)).toEqual(['Name', 'Lead', 'Dealroom URL']);
    expect(participation?.references.map((r) => r.name)).toEqual(['Investor']);

    const fundType = await adapter.describe('Fund');
    expect(fundType?.fields.map((f) => f.displayName)).toEqual([
      'Name', 'Fund Type', 'Amount', 'Currency', 'Is Closed', 'Date',
    ]);
    expect(fundType?.references).toEqual([]);
  });

  // Dealroom is READ-ONLY, and the surface an authoring agent reads has to say
  // so. Every reference here omits `writable` — which is the read-only fact,
  // not an absent opinion — so describe must report `writable: false` on all of
  // them. It used to fill the absent flag with `true`, and an agent would
  // author `write round-[:Company]-> { … }` that the checker then refused.
  it('describes NOTHING as writable, through the projection the agent reads', async () => {
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (
        await Promise.all(
          entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
        )
      ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    const metaDescriptor = await adapter.describe(ADAPTER_META_TYPE_ID);
    const { schema } = instanceSchemaFromDescriptors({
      adapterType: 'dealroom',
      entries,
      descriptors,
      ...(metaDescriptor !== null ? { metaDescriptor } : {}),
      supportsInPlaceUpdate: false,
    });
    const agentSchema = normaliseSchemaForAgent(schema);

    const writable = Object.entries(agentSchema.positions).flatMap(([position, p]) =>
      Object.entries(p.edges)
        .filter(([, edge]) => edge.writable !== false)
        .map(([edge]) => `${position}-[:${edge}]->`),
    );
    expect(writable).toEqual([]);
    // The three the defect was reported on, named so a regression says which.
    expect(agentSchema.positions['Funding Round']?.edges.Company?.writable).toBe(false);
    expect(agentSchema.positions['Team Member']?.edges.Person?.writable).toBe(false);
    expect(agentSchema.positions['Round Investor']?.edges.Investor?.writable).toBe(false);
    // And no write root either — nothing on Dealroom accepts a write at all.
    expect(Object.keys(agentSchema.writableRoots)).toEqual([]);
  });

  it('answers null for a type it does not own', async () => {
    expect(await adapter.describe('Nonexistent')).toBeNull();
  });

  it('walks from the root to a company and on to its team', async () => {
    const root = await adapter.edgesFrom(makeMetaPosition('dealroom'));
    expect(root?.targetNodes?.['Companies']?.displayName).toBe('Company');
    const hop = await adapter.edgesFrom(at('Company', '101', company()));
    expect(hop?.descriptor.typeId).toBe(DEALROOM_COMPANY_TYPE_ID);
    expect(hop?.targetNodes?.['company_team']?.displayName).toBe('Team Member');
  });
});

// ── field reads ─────────────────────────────────────────────────────────────

describe('DealroomAdapter.getFieldValue', () => {
  const adapter = createDealroomAdapter({ teamId: TEAM });

  it('reads a literal scalar by its natural name', async () => {
    const position = at('Company', '101', company());
    expect(await adapter.getFieldValue({ position, fieldId: 'Tagline' })).toBe('We make things');
    expect(await adapter.getFieldValue({ position, fieldId: 'Employees Latest' })).toBe(42);
  });

  it('takes the HQ city and country from the location flagged as the headquarters', async () => {
    const position = at('Company', '101', company());
    expect(await adapter.getFieldValue({ position, fieldId: 'HQ City' })).toBe('Berlin');
    expect(await adapter.getFieldValue({ position, fieldId: 'HQ Country' })).toBe('Germany');
  });

  it('falls back to the first location when nothing is flagged', async () => {
    const position = at('Company', '101', company({
      hq_locations: [{ id: 9, city: { name: 'Lyon' }, country: { name: 'France' } }],
    }));
    expect(await adapter.getFieldValue({ position, fieldId: 'HQ City' })).toBe('Lyon');
  });

  it('flattens a taxonomy list whether Dealroom spells it as objects or strings', async () => {
    const position = at('Company', '101', company());
    expect(await adapter.getFieldValue({ position, fieldId: 'Industries' })).toEqual(['fintech']);
    expect(await adapter.getFieldValue({ position, fieldId: 'Tags' })).toEqual(['saas']);
  });

  it('reads Website as the host alone, whatever spelling the URL carries', async () => {
    const bare = at('Company', '101', company({ website_url: 'acme.com' }));
    expect(await adapter.getFieldValue({ position: bare, fieldId: 'Website' })).toBe('acme.com');
    const full = at('Company', '102', company({ website_url: 'https://www.acme.com/about' }));
    expect(await adapter.getFieldValue({ position: full, fieldId: 'Website' })).toBe('acme.com');
    expect(await adapter.getFieldValue({ position: full, fieldId: 'Website URL' })).toBe(
      'https://www.acme.com/about',
    );
    const none = at('Company', '103', company({ website_url: null }));
    expect(await adapter.getFieldValue({ position: none, fieldId: 'Website' })).toBeNull();
  });

  it('reads the logo off the size map and the page off `url`', async () => {
    const position = at('Company', '101', company());
    expect(await adapter.getFieldValue({ position, fieldId: 'Logo URL' })).toBe(
      'https://img.example/acme.png',
    );
    expect(await adapter.getFieldValue({ position, fieldId: 'Dealroom URL' })).toBe(
      'https://dealroom.co/companies/acme',
    );
  });

  it('reads a Dealroom timestamp back as an ISO instant, in UTC', async () => {
    const position = at('Company', '101', company());
    expect(await adapter.getFieldValue({ position, fieldId: 'Created At' })).toBe(
      new Date(CREATED_MS).toISOString(),
    );
  });

  it('composes a round’s date from the year and month Dealroom splits it across', async () => {
    const position = at('Funding Round', '401', round());
    expect(await adapter.getFieldValue({ position, fieldId: 'Date' })).toBe(
      new Date(Date.UTC(2026, 4, 1)).toISOString(),
    );
    const undated = at('Funding Round', '402', round({ year: null, month: null }));
    expect(await adapter.getFieldValue({ position: undated, fieldId: 'Date' })).toBeNull();
  });

  it('tolerates a trimmed record, whose absent fields simply read null', async () => {
    const position = at('Company', '104', { id: 104, name: 'Bare' });
    expect(await adapter.getFieldValue({ position, fieldId: 'HQ City' })).toBeNull();
    expect(await adapter.getFieldValue({ position, fieldId: 'Logo URL' })).toBeNull();
    expect(await adapter.getFieldValue({ position, fieldId: 'Industries' })).toEqual([]);
  });

  it('refuses a position minted by another adapter', async () => {
    await expect(
      adapter.getFieldValue({
        position: makeStablePosition({ adapterType: 'evertrace', recordType: 'Company', recordId: 'x', data: {} }),
        fieldId: 'Name',
      }),
    ).rejects.toThrow(/different adapter/);
  });
});

// ── WHERE → search body ─────────────────────────────────────────────────────

describe('the WHERE pushdown', () => {
  it('sends a Name equality as an exact name search and a contains as a fuzzy one', () => {
    expect(companySearchFromWhere(cmp(prop('Name'), 'eq', value('Acme')))).toEqual({
      keyword: 'Acme',
      keywordType: 'name',
      keywordMatchType: 'exact',
      must: {},
    });
    expect(companySearchFromWhere(cmp(prop('Name'), 'contains', value('Acm')))).toEqual({
      keyword: 'Acm',
      keywordType: 'name',
      keywordMatchType: 'fuzzy',
      must: {},
    });
  });

  it('sends a Website as an exact domain search, and prefers it over a Name in the same WHERE', () => {
    const request = companySearchFromWhere(
      and(cmp(prop('Name'), 'eq', value('Acme')), cmp(prop('Website'), 'eq', value('acme.com'))),
    );
    expect(request.keyword).toBe('acme.com');
    expect(request.keywordType).toBe('website_domain');
    expect(request.keywordMatchType).toBe('exact');
  });

  it('sends a Website contains as a fuzzy domain search', () => {
    const request = companySearchFromWhere(cmp(prop('Website'), 'contains', value('acme')));
    expect(request.keyword).toBe('acme');
    expect(request.keywordType).toBe('website_domain');
    expect(request.keywordMatchType).toBe('fuzzy');
  });

  // The full URL and Dealroom's domain keyword can never agree on a spelling —
  // one side carries the scheme, the other does not — so `Website URL` pushes
  // nothing and the engine satisfies it over what comes back.
  it('leaves a Website URL WHERE to the engine', () => {
    expect(
      companySearchFromWhere(cmp(prop('Website URL'), 'eq', value('https://acme.com'))),
    ).toEqual({ must: {} });
  });

  it('sends terms filters, range bounds and the location, all under form_data.must', () => {
    const request = companySearchFromWhere(
      and(
        cmp(prop('Industries'), 'in', list('fintech', 'saas')),
        cmp(prop('Growth Stage'), 'eq', value('early growth')),
        cmp(prop('HQ Country'), 'eq', value('Germany')),
        cmp(prop('Total Funding'), 'gte', value(1_000_000)),
        cmp(prop('Launch Year'), 'lt', value(2020)),
        cmp(prop('Created At'), 'gte', value('2026-09-01T00:00:00.000Z')),
      ),
    );
    expect(request.must).toEqual({
      industries: ['fintech', 'saas'],
      growth_stages: ['early growth'],
      hq_locations: ['Germany'],
      total_funding_min: 1_000_000,
      launch_year_max: 2020,
      created_utc_min: '2026-09-01 00:00:00',
    });
  });

  it('pushes nothing from an OR — a disjunct need not hold of every matching row', () => {
    const or: Expression = {
      type: 'logical',
      op: 'or',
      operands: [
        cmp(prop('Industries'), 'eq', value('fintech')),
        cmp(prop('Industries'), 'eq', value('health')),
      ],
    } as Expression;
    expect(companySearchFromWhere(or)).toEqual({ must: {} });
  });

  it('translates the investor, person and round WHEREs against their own filter names', () => {
    expect(
      investorSearchFromWhere(
        and(
          cmp(prop('Investor Type'), 'eq', value('vc')),
          cmp(prop('Investment Stages'), 'in', list('seed')),
          cmp(prop('HQ City'), 'eq', value('London')),
        ),
      ).must,
    ).toEqual({ investor_type: ['vc'], investment_stages: ['seed'], hq_locations: ['London'] });

    expect(
      personSearchFromWhere(
        and(
          cmp(prop('Gender'), 'eq', value('female')),
          cmp(prop('Backgrounds'), 'in', list('Big Tech')),
          cmp(prop('Is Strong Founder'), 'eq', value(true)),
          cmp(prop('HQ Country'), 'eq', value('Germany')),
        ),
      ).must,
    ).toEqual({
      gender: ['female'],
      backgrounds: ['Big Tech'],
      is_strong_founder: ['true'],
      locations: ['Germany'],
    });

    expect(
      fundingRoundSearchFromWhere(
        and(
          cmp(prop('Round'), 'in', list('SERIES A', 'SERIES B')),
          cmp(prop('Amount'), 'gte', value(1_000_000)),
          cmp(prop('Date'), 'gte', value('2026-01-01T00:00:00.000Z')),
          cmp(prop('Is Verified'), 'eq', value(true)),
        ),
      ).must,
    ).toEqual({
      rounds: ['SERIES A', 'SERIES B'],
      amount_min: 1_000_000,
      date_min: '2026-01-01 00:00:00',
      is_verified: ['true'],
    });
  });

  it('reads the three role flags a team sub-resource narrows by itself', () => {
    expect(
      teamRequestFromWhere(
        and(cmp(prop('Is Founder'), 'eq', value(true)), cmp(prop('Is Partner'), 'eq', value(false))),
      ),
    ).toEqual({ isFounder: true, isPartner: false });
  });
});

// ── ORDER BY → sort ─────────────────────────────────────────────────────────

describe('the ORDER BY pushdown', () => {
  it('maps a sortable field to Dealroom’s key, `-` prefixed when descending', () => {
    expect(sortFromOrderBy(DEALROOM_COMPANY_TYPE_ID, { fieldId: 'Total Funding', direction: 'desc' }))
      .toBe('-total_funding');
    expect(sortFromOrderBy(DEALROOM_COMPANY_TYPE_ID, { fieldId: 'Created At', direction: 'asc' }))
      .toBe('created_utc');
    expect(sortFromOrderBy(DEALROOM_FUNDING_ROUND_TYPE_ID, { fieldId: 'Date', direction: 'desc' }))
      .toBe('-date');
  });

  it('answers undefined for a field Dealroom cannot sort by, so the engine sorts', () => {
    expect(sortFromOrderBy(DEALROOM_COMPANY_TYPE_ID, { fieldId: 'Tagline', direction: 'asc' }))
      .toBeUndefined();
  });
});

// ── traversal ───────────────────────────────────────────────────────────────

describe('DealroomAdapter.getRelated — root collections', () => {
  const meta = makeMetaPosition('dealroom');

  it('lands each collection on its own type', async () => {
    const adapter = adapterWith(fakeClient());
    const cases: Array<[string, string]> = [
      ['Companies', 'Company'],
      ['Investors', 'Investor'],
      ['People', 'Person'],
      ['Funding Rounds', 'Funding Round'],
    ];
    for (const [collection, recordType] of cases) {
      const related = await adapter.getRelated({
        position: meta,
        fieldId: collection,
        direction: 'outgoing',
      });
      expect(related).toHaveLength(1);
      expect(related[0].position.recordType).toBe(recordType);
    }
  });

  it('sends the translated WHERE, the sort and the limit in one search', async () => {
    const searchCompanies = jest.fn(async (_r: DealroomSearchRequest) => page([company()]));
    const adapter = adapterWith(fakeClient({ searchCompanies }));
    await adapter.getRelated({
      position: meta,
      fieldId: 'Companies',
      direction: 'outgoing',
      where: cmp(prop('Industries'), 'eq', value('fintech')),
      orderBy: { fieldId: 'Total Funding', direction: 'desc' },
      limit: 5,
    });
    expect(searchCompanies).toHaveBeenCalledTimes(1);
    const request = searchCompanies.mock.calls[0][0];
    expect(request.must).toEqual({ industries: ['fintech'] });
    expect(request.sort).toBe('-total_funding');
    expect(request.limit).toBe(5);
    expect(request.offset).toBe(0);
    expect(request.fields).toContain('hq_locations');
  });

  it('drops the limit when the ORDER BY could not travel — the engine sorts and slices', async () => {
    const searchCompanies = jest.fn(async (_r: DealroomSearchRequest) => page([company()]));
    const adapter = adapterWith(fakeClient({ searchCompanies }));
    await adapter.getRelated({
      position: meta,
      fieldId: 'Companies',
      direction: 'outgoing',
      orderBy: { fieldId: 'Tagline', direction: 'asc' },
      limit: 2,
    });
    expect(searchCompanies.mock.calls[0][0].limit).toBe(100);
    expect(searchCompanies.mock.calls[0][0].sort).toBeUndefined();
  });

  it('fails loudly rather than truncating when a walk pages past the offset ceiling', async () => {
    // A client that always answers a full page drives the walk past the cap;
    // the real client refuses the request, so mirror that here.
    const searchCompanies = jest.fn(async (request: DealroomSearchRequest) => {
      if ((request.offset ?? 0) > DEALROOM_MAX_OFFSET) throw new DealroomOffsetCapError('/companies');
      return {
        total: 25_000,
        items: Array.from({ length: 100 }, (_, i) => company({ id: 1000 + i })),
      };
    });
    const adapter = adapterWith(fakeClient({ searchCompanies }));
    await expect(
      adapter.getRelated({ position: meta, fieldId: 'Companies', direction: 'outgoing' }),
    ).rejects.toThrow(/10000 results/);
  });
});

describe('DealroomAdapter.getRelated — edges below the root', () => {
  it('fetches a company’s rounds, investors, team and similar companies from their own endpoints', async () => {
    const listCompanyTeam = jest.fn(async () => page([teamMember()]));
    const adapter = adapterWith(fakeClient({ listCompanyTeam }));
    const position = at('Company', '101', company());

    const rounds = await adapter.getRelated({ position, fieldId: 'Funding Rounds', direction: 'outgoing' });
    expect(rounds.map((r) => r.position.recordType)).toEqual(['Funding Round']);

    const investors = await adapter.getRelated({ position, fieldId: 'Investors', direction: 'outgoing' });
    expect(investors.map((r) => positionRecordId(r.position))).toEqual(['201']);

    const similar = await adapter.getRelated({ position, fieldId: 'Similar Companies', direction: 'outgoing' });
    expect(similar.map((r) => positionRecordId(r.position))).toEqual(['103']);

    const team = await adapter.getRelated({
      position,
      fieldId: 'Team',
      direction: 'outgoing',
      where: cmp(prop('Is Founder'), 'eq', value(true)),
      limit: 10,
    });
    // The membership node is keyed on the PAIR, so one founder at two companies
    // is two nodes rather than one.
    expect(positionRecordId(team[0].position)).toBe('101:301');
    expect(team[0].position.recordType).toBe('Team Member');
    expect(listCompanyTeam).toHaveBeenCalledWith('101', {
      limit: 10,
      offset: 0,
      isFounder: true,
    });
  });

  it('fetches an investor’s investments, rounds, co-investors, funds and team', async () => {
    const adapter = adapterWith(fakeClient());
    const position = at('Investor', '201', investor());
    expect(
      (await adapter.getRelated({ position, fieldId: 'Investments', direction: 'outgoing' }))
        .map((r) => r.position.recordType),
    ).toEqual(['Company']);
    expect(
      (await adapter.getRelated({ position, fieldId: 'Co-Investors', direction: 'outgoing' }))
        .map((r) => positionRecordId(r.position)),
    ).toEqual(['202']);
    const funds = await adapter.getRelated({ position, fieldId: 'Funds', direction: 'outgoing' });
    expect(funds[0].position.recordType).toBe('Fund');
    expect(positionRecordId(funds[0].position)).toBe('201:501');
  });

  it('reads a person’s companies off the person, with no extra fetch', async () => {
    const adapter = adapterWith(fakeClient());
    const related = await adapter.getRelated({
      position: at('Person', '301', person()),
      fieldId: 'Companies',
      direction: 'outgoing',
    });
    expect(related.map((r) => positionRecordId(r.position))).toEqual(['102']);
  });

  it('reads a round’s company and participations inline, and resolves each one hop further', async () => {
    const getPerson = jest.fn(async () => person());
    const getInvestor = jest.fn(async () => investor());
    const adapter = adapterWith(fakeClient({ getPerson, getInvestor }));

    const roundPosition = at('Funding Round', '401', round());
    const company = await adapter.getRelated({ position: roundPosition, fieldId: 'Company', direction: 'outgoing' });
    expect(company.map((r) => positionRecordId(r.position))).toEqual(['101']);

    const participations = await adapter.getRelated({ position: roundPosition, fieldId: 'Investors', direction: 'outgoing' });
    expect(participations[0].position.recordType).toBe('Round Investor');
    expect(positionRecordId(participations[0].position)).toBe('401:201');

    const resolved = await adapter.getRelated({
      position: at('Round Investor', '401:201', { id: 201, name: 'Index Ventures', lead: true }),
      fieldId: 'Investor',
      direction: 'outgoing',
    });
    expect(getInvestor).toHaveBeenCalledWith('201');
    expect(resolved[0].position.recordType).toBe('Investor');

    const member = await adapter.getRelated({
      position: at('Team Member', '101:301', teamMember()),
      fieldId: 'Person',
      direction: 'outgoing',
    });
    expect(getPerson).toHaveBeenCalledWith('301');
    expect(member[0].position.recordType).toBe('Person');
  });

  it('keeps the pair id round-trippable', () => {
    expect(decodePairId(encodePairId({ parentId: '101', childId: '301' }))).toEqual({
      parentId: '101',
      childId: '301',
    });
    expect(decodePairId('101')).toBeUndefined();
  });
});

// ── read-back ───────────────────────────────────────────────────────────────

describe('DealroomAdapter.readRecord', () => {
  it('re-reads the three entities Dealroom serves by id, and nothing else', async () => {
    const adapter = adapterWith(fakeClient());
    expect(await adapter.readRecord({ recordType: 'Company', externalId: '101' })).toMatchObject({ id: 101 });
    expect(await adapter.readRecord({ recordType: 'Investor', externalId: '201' })).toMatchObject({ id: 201 });
    expect(await adapter.readRecord({ recordType: 'Person', externalId: '301' })).toMatchObject({ id: 301 });
    // Rounds, memberships, participations and funds have no endpoint behind them.
    expect(await adapter.readRecord({ recordType: 'Funding Round', externalId: '401' })).toBeNull();
    expect(await adapter.readRecord({ recordType: 'Fund', externalId: '201:501' })).toBeNull();
  });
});

// ── the poll ────────────────────────────────────────────────────────────────

describe('DealroomPollSource.getEvents', () => {
  const source = (client: DealroomApiClient) => new DealroomPollSource(TEAM, 'cred-1', client);

  it('first poll sets the mark and emits nothing (no backfill)', async () => {
    const searchFundingRounds = jest.fn(async () => page([round()]));
    const { events, checkpoint } = await source(fakeClient({ searchFundingRounds })).getEvents({
      config: {},
    });
    expect(events).toEqual([]);
    expect((checkpoint as { createdAfter: number }).createdAfter).toBeGreaterThan(0);
    expect(searchFundingRounds).not.toHaveBeenCalled();
  });

  it('a subsequent poll emits one tagged event per round, oldest first, and advances the mark', async () => {
    const older = round({ id: 401, created_utc: '2026-09-10 08:00:00' });
    const newer = round({ id: 402, created_utc: '2026-09-10 09:00:00' });
    const searchFundingRounds = jest.fn(async () => page([newer, older]));
    const { events, checkpoint } = await source(fakeClient({ searchFundingRounds })).getEvents({
      config: { rounds: ['SERIES A'], hq_locations: ['Europe'] },
      checkpoint: { createdAfter: CREATED_MS - 1 },
    });
    expect(events.map((e) => e.externalId)).toEqual(['401', '402']);
    expect(events.every((e) => e.tag === 'dealroom:funding_round')).toBe(true);
    expect(events[0].occurredAt).toBe(new Date(CREATED_MS).toISOString());
    expect((checkpoint as { createdAfter: number }).createdAfter).toBe(
      parseDealroomInstant('2026-09-10 09:00:00'),
    );
  });

  it('asks Dealroom for rounds recorded since the mark, with the listen filters applied', async () => {
    const searchFundingRounds = jest.fn(async (_r: DealroomSearchRequest) =>
      page([round({ created_utc: '2026-09-10 09:00:00' })]),
    );
    await source(fakeClient({ searchFundingRounds })).getEvents({
      config: { rounds: ['SERIES A'], industries: ['fintech'] },
      checkpoint: { createdAfter: CREATED_MS },
    });
    expect(searchFundingRounds).toHaveBeenCalledTimes(1);
    const request = searchFundingRounds.mock.calls[0][0];
    expect(request.must).toEqual({
      rounds: ['SERIES A'],
      industries: ['fintech'],
      created_utc_min: CREATED_UTC,
    });
    expect(request.sort).toBe('created_utc');
  });

  it('drops the round that SET the mark — Dealroom’s bound is inclusive', async () => {
    const searchFundingRounds = jest.fn(async () => page([round({ created_utc: CREATED_UTC })]));
    const { events } = await source(fakeClient({ searchFundingRounds })).getEvents({
      config: {},
      checkpoint: { createdAfter: CREATED_MS },
    });
    expect(events).toEqual([]);
  });

  it('reads each listen filter as a terms list, and leaves the ones nobody set out', () => {
    expect(listenFilters({ rounds: 'SERIES A', pollIntervalSeconds: 60 })).toEqual({
      rounds: ['SERIES A'],
    });
    expect(listenFilters(undefined)).toEqual({});
  });
});
