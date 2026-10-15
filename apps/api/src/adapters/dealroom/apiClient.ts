// Dealroom HTTP transport — the one owner of the wire shape for the movements
// adapter (services/translation_graph/adapters/dealroom) and its poll source.
//
// Dealroom is a market-intelligence database: companies, investors, people and
// funding rounds, with the relationships between them. The API is read-only for
// our purposes, HTTP-Basic authenticated with the key as the USERNAME and a
// blank password, and rate limited to five requests a second per key — so the
// auth encoding, the client-side pacing and the 10,000-row offset ceiling live
// here and nowhere else.

import { z } from 'zod';

import { logger } from 'movement-engine/services/logger';

export const DEALROOM_DEFAULT_BASE_URL = 'https://api.dealroom.co/api/v1';

/** The API's own ceiling on a search page. */
export const DEALROOM_MAX_LIMIT = 100;

/** Beyond this the search endpoints refuse to page (the spec's own cap). A walk
 *  that reaches it FAILS rather than silently returning a prefix. */
export const DEALROOM_MAX_OFFSET = 10_000;

/**
 * The gap this client leaves between requests. Dealroom allows five a second
 * per key; pacing at four leaves headroom for a second process on the same key
 * rather than racing it into a 429.
 */
export const DEALROOM_MIN_REQUEST_INTERVAL_MS = 250;

/** Stored Dealroom credential — the API key the user pastes, plus an optional
 *  base URL (the dev loop points this at fake-channels). */
export const dealroomCredsParser = z.object({
  apiKey: z.string(),
  baseUrl: z.string().url().optional(),
});
export type DealroomCredentials = z.infer<typeof dealroomCredsParser>;

// ── Wire shapes ─────────────────────────────────────────────────────────────
// Zod rather than bare interfaces, because Dealroom serves the SAME entity at
// several widths: a search hands back whatever `fields` asked for, a
// sub-resource hands back that endpoint's own subset, and an embedded object is
// narrower still. One permissive schema per entity — `id` required, everything
// else optional, unread keys passed through — reads all three without a second
// type per width, and without an `as` cast at the boundary.

/** A money/count field. Dealroom types these as numbers but has been seen to
 *  serve a formatted string; accepting both is cheaper than a failed parse. */
const numeric = z.union([z.number(), z.string()]).nullish();

const imagesSchema = z
  .object({
    '32x32': z.string().nullish(),
    '74x74': z.string().nullish(),
    '100x100': z.string().nullish(),
  })
  .passthrough();

/** Dealroom's `{ id, name }` taxonomy node — an industry, a background, a city. */
const namedSchema = z
  .object({
    id: z.number().nullish(),
    name: z.string().nullish(),
    slug: z.string().nullish(),
  })
  .passthrough();

/** A taxonomy list. Dealroom spells some as `{id,name}` objects (`industries`)
 *  and some as bare strings (`tags`), so both arrive here and `labelsOf` is the
 *  one place that flattens them. */
const labelListSchema = z.array(z.union([z.string(), namedSchema])).nullish();
export type DealroomLabelList = z.infer<typeof labelListSchema>;

/** Flatten a taxonomy list to the names a movement reads. */
export function labelsOf(list: DealroomLabelList): string[] {
  return (list ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : (entry.name ?? null)))
    .filter((name): name is string => typeof name === 'string' && name !== '');
}

const hqLocationSchema = z
  .object({
    id: z.number().nullish(),
    is_headquarters: z.boolean().nullish(),
    is_founding_location: z.boolean().nullish(),
    address: z.string().nullish(),
    city: namedSchema.nullish(),
    country: namedSchema.nullish(),
  })
  .passthrough();
export type DealroomHqLocation = z.infer<typeof hqLocationSchema>;

export const dealroomCompanySchema = z
  .object({
    id: z.number(),
    name: z.string().nullish(),
    path: z.string().nullish(),
    tagline: z.string().nullish(),
    about: z.string().nullish(),
    url: z.string().nullish(),
    website_url: z.string().nullish(),
    linkedin_url: z.string().nullish(),
    twitter_url: z.string().nullish(),
    images: imagesSchema.nullish(),
    employees: z.string().nullish(),
    employees_latest: z.number().nullish(),
    growth_stage: z.string().nullish(),
    company_status: z.string().nullish(),
    total_funding: numeric,
    total_funding_currency: z.string().nullish(),
    last_funding: numeric,
    last_funding_date: z.string().nullish(),
    launch_year: z.number().nullish(),
    industries: labelListSchema,
    sub_industries: labelListSchema,
    technologies: labelListSchema,
    tags: labelListSchema,
    hq_locations: z.array(hqLocationSchema).nullish(),
    job_openings: z.number().nullish(),
    patents_count: z.number().nullish(),
    has_strong_founder: z.boolean().nullish(),
    has_super_founder: z.boolean().nullish(),
    has_promising_founder: z.boolean().nullish(),
    last_updated: z.string().nullish(),
    last_updated_utc: z.string().nullish(),
    created_utc: z.string().nullish(),
  })
  .passthrough();
export type DealroomCompany = z.infer<typeof dealroomCompanySchema>;

export const dealroomInvestorSchema = z
  .object({
    id: z.number(),
    name: z.string().nullish(),
    path: z.string().nullish(),
    investor_type: z.string().nullish(),
    tagline: z.string().nullish(),
    about: z.string().nullish(),
    url: z.string().nullish(),
    website_url: z.string().nullish(),
    linkedin_url: z.string().nullish(),
    images: imagesSchema.nullish(),
    employees: z.string().nullish(),
    deal_size: z.string().nullish(),
    launch_year: z.number().nullish(),
    total_funding: numeric,
    recent_funding: numeric,
    investments_num: z.number().nullish(),
    investment_stages: labelListSchema,
    industry_experience: labelListSchema,
    location_experience: labelListSchema,
    tags: labelListSchema,
    hq_locations: z.array(hqLocationSchema).nullish(),
    last_updated: z.string().nullish(),
    last_updated_utc: z.string().nullish(),
    created_utc: z.string().nullish(),
  })
  .passthrough();
export type DealroomInvestor = z.infer<typeof dealroomInvestorSchema>;

export const dealroomPersonSchema = z
  .object({
    id: z.number(),
    name: z.string().nullish(),
    path: z.string().nullish(),
    tagline: z.string().nullish(),
    url: z.string().nullish(),
    website_url: z.string().nullish(),
    linkedin_url: z.string().nullish(),
    twitter_url: z.string().nullish(),
    images: imagesSchema.nullish(),
    gender: z.string().nullish(),
    is_founder: z.boolean().nullish(),
    is_serial_founder: z.boolean().nullish(),
    is_strong_founder: z.boolean().nullish(),
    is_super_founder: z.boolean().nullish(),
    is_promising_founder: z.boolean().nullish(),
    founder_score: z.number().nullish(),
    founded_companies_total_funding: numeric,
    backgrounds: labelListSchema,
    hq_locations: z.array(hqLocationSchema).nullish(),
    last_updated: z.string().nullish(),
    last_updated_utc: z.string().nullish(),
    created_utc: z.string().nullish(),
    /** The person's affiliations. There is no `/founders/{id}/companies`, so
     *  this embedded list IS the edge — asked for by name in `fields`. */
    companies: z
      .object({
        items: z.array(dealroomCompanySchema).nullish(),
        total: z.number().nullish(),
      })
      .nullish(),
  })
  .passthrough();
export type DealroomPerson = z.infer<typeof dealroomPersonSchema>;

/** One investor's participation in one round — the `lead` flag is a fact about
 *  the pair, which is why it does not live on the investor. */
export const dealroomRoundInvestorSchema = z
  .object({
    id: z.number(),
    name: z.string().nullish(),
    path: z.string().nullish(),
    url: z.string().nullish(),
    images: imagesSchema.nullish(),
    lead: z.boolean().nullish(),
  })
  .passthrough();
export type DealroomRoundInvestor = z.infer<typeof dealroomRoundInvestorSchema>;

export const dealroomFundingRoundSchema = z
  .object({
    id: z.number(),
    round: z.string().nullish(),
    standardised_round_label: z.string().nullish(),
    year: z.number().nullish(),
    month: z.number().nullish(),
    amount: numeric,
    currency: z.string().nullish(),
    amount_usd_million: numeric,
    amount_eur_million: numeric,
    valuation: numeric,
    is_verified: z.boolean().nullish(),
    is_undisclosed: z.boolean().nullish(),
    news_source: z.string().nullish(),
    unknown_investors: z.array(z.string()).nullish(),
    last_updated: z.string().nullish(),
    last_updated_utc: z.string().nullish(),
    created_utc: z.string().nullish(),
    company: dealroomCompanySchema.nullish(),
    investors: z.array(dealroomRoundInvestorSchema).nullish(),
  })
  .passthrough();
export type DealroomFundingRound = z.infer<typeof dealroomFundingRoundSchema>;

/** One person's position at one company or investor. */
export const dealroomTeamMemberSchema = z
  .object({
    id: z.number(),
    name: z.string().nullish(),
    path: z.string().nullish(),
    url: z.string().nullish(),
    images: imagesSchema.nullish(),
    linkedin_url: z.string().nullish(),
    titles: labelListSchema,
    past: z.boolean().nullish(),
    is_founder: z.boolean().nullish(),
    is_executive: z.boolean().nullish(),
    is_partner: z.boolean().nullish(),
    year_start: z.number().nullish(),
    year_end: z.number().nullish(),
  })
  .passthrough();
export type DealroomTeamMember = z.infer<typeof dealroomTeamMemberSchema>;

export const dealroomFundSchema = z
  .object({
    id: z.number(),
    fund_name: z.string().nullish(),
    fund_type: z.string().nullish(),
    amount: numeric,
    currency: z.string().nullish(),
    is_closed: z.boolean().nullish(),
    date: z.string().nullish(),
    date_utc: z.string().nullish(),
  })
  .passthrough();
export type DealroomFund = z.infer<typeof dealroomFundSchema>;

// ── Timestamps ──────────────────────────────────────────────────────────────
// Dealroom spells every timestamp `YYYY-MM-DD HH:mm:ss` in UTC, with no zone
// marker — so a bare `Date.parse` reads it as LOCAL time and drifts by the
// host's offset. Both directions live here, next to the shape they belong to.

/** An instant as Dealroom's filter values want it. */
export function dealroomDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Epoch milliseconds from a Dealroom timestamp. Undefined for anything that
 *  is not one — a field Dealroom left null, or a shape we have not met. */
export function parseDealroomInstant(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const normalised = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(normalised);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Every list endpoint answers in this envelope — a `total` and the page. */
export interface DealroomPage<T> {
  total: number;
  items: T[];
}

function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      total: z.number().nullish(),
      items: z.array(item).nullish(),
    })
    .passthrough();
}

// ── Search request ──────────────────────────────────────────────────────────

/** A `form_data.must` entry: a terms filter (an array) or a range bound. */
export type DealroomFilterValue = string[] | string | number;

/** The `form_data.must` map a WHERE translates into (`filter.ts` builds it). */
export type DealroomMustFilters = Record<string, DealroomFilterValue>;

export type DealroomKeywordType = 'default' | 'default_next' | 'name' | 'website_domain';
export type DealroomKeywordMatchType = 'fuzzy' | 'exact';

/** The body every `POST /{entity}` search takes. One shape for all four. */
export interface DealroomSearchRequest {
  keyword?: string;
  keywordType?: DealroomKeywordType;
  keywordMatchType?: DealroomKeywordMatchType;
  must?: DealroomMustFilters;
  /** Comma-separated field list. Search defaults are narrow, so the adapter
   *  always names what it reads. */
  fields?: string;
  /** A `SortKeys_V1_*` value, `-` prefixed for descending. */
  sort?: string;
  limit?: number;
  offset?: number;
}

/** Paging for a sub-resource (`GET /companies/{id}/…`): no filter, no sort. */
export interface DealroomSubResourceRequest {
  limit?: number;
  offset?: number;
  fields?: string;
}

/** `GET /{companies,investors}/{id}/team` additionally narrows by role. */
export interface DealroomTeamRequest extends DealroomSubResourceRequest {
  isFounder?: boolean;
  isExecutive?: boolean;
  isPartner?: boolean;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** A Dealroom HTTP failure. Carries `status` so callers test the field (the
 *  not-found contract) rather than pattern-matching a message. */
export class DealroomApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Dealroom API ${status} on ${method} ${path}${body ? `: ${body}` : ''}`);
    this.name = 'DealroomApiError';
  }
}

/**
 * The walk asked for a row past Dealroom's 10,000-row offset ceiling. A
 * DISTINCT failure rather than a short answer: a truncated collection would
 * make a movement quietly wrong about "every company matching this".
 */
export class DealroomOffsetCapError extends Error {
  constructor(readonly path: string) {
    super(
      `Dealroom paging past ${DEALROOM_MAX_OFFSET} results on ${path}, which the API refuses. ` +
        `Narrow the WHERE (a Created At or Last Updated bound, an industry or a location) ` +
        `or put a LIMIT on the walk.`,
    );
    this.name = 'DealroomOffsetCapError';
  }
}

/** How many times a 429 is honoured before the failure surfaces. */
const RATE_LIMIT_RETRIES = 3;
/** The wait when a 429 names no `Retry-After`. */
const RATE_LIMIT_FALLBACK_MS = 1_000;
/** Anything longer than this is a wait the run should not spend. */
const RATE_LIMIT_MAX_MS = 30_000;

function retryAfterMs(response: Response): number {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds)) return RATE_LIMIT_FALLBACK_MS;
  return Math.min(Math.max(seconds, 0) * 1000, RATE_LIMIT_MAX_MS);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class DealroomApiClient {
  private readonly base: string;
  private readonly apiKey: string;
  /** The earliest moment the next request may leave — the pacing gate. */
  private nextSlotAt = 0;

  constructor(creds: DealroomCredentials) {
    this.base = (creds.baseUrl ?? DEALROOM_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = creds.apiKey;
  }

  /** Dealroom's only scheme: the key as the Basic username, blank password. */
  private authorization(): string {
    return `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`;
  }

  /**
   * Hold the caller until this request's slot comes round. Reserved BEFORE the
   * await so concurrent callers queue behind each other rather than all reading
   * the same free slot — the gate is what keeps a fan-out under the 5/s ceiling
   * instead of relying on the 429 retry to mop up.
   */
  private async pace(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + DEALROOM_MIN_REQUEST_INTERVAL_MS;
    if (slot > now) await sleep(slot - now);
  }

  private async request<T>(input: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    query?: Record<string, string | undefined>;
    schema: z.ZodType<T>;
  }): Promise<T> {
    const url = new URL(this.base + input.path);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.append(key, value);
    }

    const headers: Record<string, string> = {
      Authorization: this.authorization(),
      Accept: 'application/json',
    };
    if (input.body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      await this.pace();
      const response = await fetch(url, {
        method: input.method,
        headers,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      });

      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const waitMs = retryAfterMs(response);
        logger.warn(
          `[dealroom] rate limited on ${input.method} ${input.path}; waiting ${waitMs}ms`,
        );
        await sleep(waitMs);
        continue;
      }

      // 503 is Dealroom's own "requests limit exceeded" — a quota, not an
      // outage, and not something a retry inside this run fixes. Say which it
      // is rather than letting it read as a generic server error.
      if (response.status === 503) {
        throw new DealroomApiError(
          503,
          input.method,
          input.path,
          'Dealroom request limit exceeded — this API key has spent its allowance.',
        );
      }

      if (response.status >= 400) {
        const body = await response.text().catch(() => '');
        throw new DealroomApiError(response.status, input.method, input.path, body);
      }

      const text = await response.text();
      const payload: unknown = text === '' ? null : JSON.parse(text);
      return input.schema.parse(payload);
    }
  }

  private searchBody(input: DealroomSearchRequest): Record<string, unknown> {
    const must = input.must ?? {};
    return {
      ...(input.keyword !== undefined
        ? {
            keyword: input.keyword,
            keyword_type: input.keywordType ?? 'default',
            keyword_match_type: input.keywordMatchType ?? 'fuzzy',
          }
        : {}),
      ...(Object.keys(must).length > 0 ? { form_data: { must } } : {}),
      ...(input.fields !== undefined ? { fields: input.fields } : {}),
      ...(input.sort !== undefined ? { sort: input.sort } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
    };
  }

  private async search<T>(
    path: string,
    input: DealroomSearchRequest,
    item: z.ZodType<T>,
  ): Promise<DealroomPage<T>> {
    if ((input.offset ?? 0) > DEALROOM_MAX_OFFSET) throw new DealroomOffsetCapError(path);
    const page = await this.request({
      method: 'POST',
      path,
      body: this.searchBody(input),
      schema: pageSchema(item),
    });
    return { total: page.total ?? 0, items: (page.items ?? []) as T[] };
  }

  private async subResource<T>(
    path: string,
    input: DealroomTeamRequest,
    item: z.ZodType<T>,
  ): Promise<DealroomPage<T>> {
    const page = await this.request({
      method: 'GET',
      path,
      query: {
        ...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
        ...(input.offset !== undefined ? { offset: String(input.offset) } : {}),
        ...(input.fields !== undefined ? { fields: input.fields } : {}),
        ...(input.isFounder !== undefined ? { is_founder: String(input.isFounder) } : {}),
        ...(input.isExecutive !== undefined ? { is_executive: String(input.isExecutive) } : {}),
        ...(input.isPartner !== undefined ? { is_partner: String(input.isPartner) } : {}),
      },
      schema: pageSchema(item),
    });
    return { total: page.total ?? 0, items: (page.items ?? []) as T[] };
  }

  // ── searches ──────────────────────────────────────────────────────────────

  searchCompanies(input: DealroomSearchRequest): Promise<DealroomPage<DealroomCompany>> {
    return this.search('/companies', input, dealroomCompanySchema);
  }

  searchInvestors(input: DealroomSearchRequest): Promise<DealroomPage<DealroomInvestor>> {
    return this.search('/investors', input, dealroomInvestorSchema);
  }

  /** Dealroom calls the endpoint `/founders`; the entity is a person. */
  searchPeople(input: DealroomSearchRequest): Promise<DealroomPage<DealroomPerson>> {
    return this.search('/founders', input, dealroomPersonSchema);
  }

  /** Dealroom calls the endpoint `/transactions`; the entity is a funding round. */
  searchFundingRounds(
    input: DealroomSearchRequest,
  ): Promise<DealroomPage<DealroomFundingRound>> {
    return this.search('/transactions', input, dealroomFundingRoundSchema);
  }

  // ── get by id ─────────────────────────────────────────────────────────────
  // `id` may be the numeric Dealroom id or the entity's path slug. Omitting
  // `fields` returns every field the entity has, which is what a re-read wants.

  getCompany(id: string): Promise<DealroomCompany> {
    return this.request({
      method: 'GET',
      path: `/companies/${encodeURIComponent(id)}`,
      schema: dealroomCompanySchema,
    });
  }

  getInvestor(id: string): Promise<DealroomInvestor> {
    return this.request({
      method: 'GET',
      path: `/investors/${encodeURIComponent(id)}`,
      schema: dealroomInvestorSchema,
    });
  }

  getPerson(id: string): Promise<DealroomPerson> {
    return this.request({
      method: 'GET',
      path: `/founders/${encodeURIComponent(id)}`,
      schema: dealroomPersonSchema,
    });
  }

  // ── sub-resources ─────────────────────────────────────────────────────────
  // The full lists. The same relations ride the parent payload capped at five
  // items, so an edge walk ALWAYS comes here instead of reading the embedded
  // copy — five silently-truncated members is the bug this avoids.

  listCompanyFundingRounds(
    companyId: string,
    input: DealroomSubResourceRequest = {},
  ): Promise<DealroomPage<DealroomFundingRound>> {
    return this.subResource(
      `/companies/${encodeURIComponent(companyId)}/fundings`,
      input,
      dealroomFundingRoundSchema,
    );
  }

  listCompanyInvestors(
    companyId: string,
    input: DealroomSubResourceRequest = {},
  ): Promise<DealroomPage<DealroomInvestor>> {
    return this.subResource(
      `/companies/${encodeURIComponent(companyId)}/investors`,
      input,
      dealroomInvestorSchema,
    );
  }

  listCompanyTeam(
    companyId: string,
    input: DealroomTeamRequest = {},
  ): Promise<DealroomPage<DealroomTeamMember>> {
    return this.subResource(
      `/companies/${encodeURIComponent(companyId)}/team`,
      input,
      dealroomTeamMemberSchema,
    );
  }

  listSimilarCompanies(
    companyId: string,
    input: DealroomSubResourceRequest = {},
  ): Promise<DealroomPage<DealroomCompany>> {
    return this.subResource(
      `/companies/${encodeURIComponent(companyId)}/similar`,
      input,
      dealroomCompanySchema,
    );
  }

  listInvestorInvestments(
    investorId: string,
    input: DealroomSubResourceRequest = {},
  ): Promise<DealroomPage<DealroomCompany>> {
    return this.subResource(
      `/investors/${encodeURIComponent(investorId)}/investments`,
      input,
      dealroomCompanySchema,
    );
  }

  listInvestorFundingRounds(
    investorId: string,
    input: DealroomSubResourceRequest = {},
  ): Promise<DealroomPage<DealroomFundingRound>> {
    return this.subResource(
      `/investors/${encodeURIComponent(investorId)}/fundings`,
      input,
      dealroomFundingRoundSchema,
    );
  }

  listInvestorCoInvestors(
    investorId: string,
    input: DealroomSubResourceRequest = {},
  ): Promise<DealroomPage<DealroomInvestor>> {
    return this.subResource(
      `/investors/${encodeURIComponent(investorId)}/co_investors`,
      input,
      dealroomInvestorSchema,
    );
  }

  listInvestorFunds(
    investorId: string,
    input: DealroomSubResourceRequest = {},
  ): Promise<DealroomPage<DealroomFund>> {
    return this.subResource(
      `/investors/${encodeURIComponent(investorId)}/funds`,
      input,
      dealroomFundSchema,
    );
  }

  listInvestorTeam(
    investorId: string,
    input: DealroomTeamRequest = {},
  ): Promise<DealroomPage<DealroomTeamMember>> {
    return this.subResource(
      `/investors/${encodeURIComponent(investorId)}/team`,
      input,
      dealroomTeamMemberSchema,
    );
  }
}

const clientsByKey: Record<string, DealroomApiClient> = {};

/** A memoized client per (key, base URL) — the same sharing the other API-key
 *  adapters do, so repeated construction inside one run costs nothing, and the
 *  pacing gate is shared by everything on that key. */
export function getDealroomClient(apiKey: string, baseUrl?: string): DealroomApiClient {
  const cacheKey = baseUrl ? `${apiKey}:${baseUrl}` : apiKey;
  if (!clientsByKey[cacheKey]) {
    clientsByKey[cacheKey] = new DealroomApiClient({
      apiKey,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    });
  }
  return clientsByKey[cacheKey];
}
