// Evertrace HTTP transport — the one owner of the wire shape for the adapter
// (adapter.ts) and its poll (poll.ts). It reaches Evertrace through the fetch
// and the log its host hands the module, never the process's own.
//
// Evertrace detects founders before they appear in startup databases: a SIGNAL
// is a person whose profile just triggered a trackable event. The API is
// bearer-authenticated, version-pinned by a header, and pages with STRING
// `page`/`limit` (the server decodes them), so those quirks live here and
// nowhere else.

import { z } from 'zod';

import type { ModuleLog } from 'module-kit';

export const EVERTRACE_DEFAULT_BASE_URL = 'https://api.evertrace.ai';

/** The version this client speaks. Enforced by Evertrace middleware and NOT an
 *  OpenAPI parameter — a missing or unknown value is a 400, so it rides every
 *  request rather than being a per-call option. */
export const EVERTRACE_API_VERSION = '2026-03-11';

/** Stored Evertrace credential — the API key the user pastes, plus an optional
 *  base URL (the dev loop points this at fake-channels). */
export const evertraceCredsParser = z.object({
  apiKey: z.string(),
  baseUrl: z.string().url().optional(),
});
export type EvertraceCredentials = z.infer<typeof evertraceCredsParser>;

// ── Wire shapes ─────────────────────────────────────────────────────────────
// Structural interfaces rather than zod parsers: Evertrace's spec declares
// `additionalProperties: false` and every field, so a parse here would only
// ever reject a payload the adapter could still read. Shapes describe what we
// consume; unread fields are simply not named.

export interface EvertraceUser {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  workspaceId: string;
  /** ISO strings — the ONE object in this API whose timestamps are not epoch ms. */
  createdAt: string;
  updatedAt: string;
  onboardedAt?: string | null;
  role: string;
}

export interface EvertraceTagging {
  id: string;
  key: string;
  namespace: string;
  signalId: string;
  createdAt: number;
  updatedAt: number;
}

export interface EvertraceCompanyEntity {
  id: string;
  source?: string | null;
  name: string | null;
  websiteUrl: string | null;
  customerSegment: string | null;
  sourceUrl: string | null;
  logoUrl: string | null;
  employeeCount?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EvertraceEducationEntity {
  id: string;
  name: string | null;
  sourceUrl: string | null;
  logoUrl: string | null;
  studentCount: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EvertraceExperience {
  id: string;
  signalId: string;
  experienceEntityId?: string | null;
  title?: string | null;
  location?: string | null;
  companyName?: string | null;
  indexOrder: number;
  startDate?: string | null;
  endDate?: string | null;
  createdAt: number;
  updatedAt: number;
  entity: EvertraceCompanyEntity | null;
}

export interface EvertraceEducationEntry {
  id: string;
  signalId: string;
  educationEntityId?: string | null;
  degree?: string | null;
  schoolName?: string | null;
  indexOrder: number;
  startDate?: string | null;
  endDate?: string | null;
  createdAt: number;
  updatedAt: number;
  entity: EvertraceEducationEntity | null;
}

/** One screening or view of a signal — the same row shape serves both. */
export interface EvertraceSignalEvent {
  id: string;
  workspaceId: string;
  createdBy: string | null;
  signalId: string;
  createdAt: number;
  updatedAt: number;
  createdByUser?: EvertraceUser | null;
}

/**
 * A signal. The relation-bearing fields are OPTIONAL because Evertrace serves
 * two shapes of this object: the FULL one (every list, `signals.byId`, a list
 * entry's expanded `signal`) and a TRIMMED one that appears only inside
 * `GET /lists/{id}`, carrying the scalars and nothing else. One type with
 * optional relations rather than two: every reader already has to cope with an
 * absent relation, and a second type would only move that check to the call
 * site.
 */
export interface EvertraceSignal {
  id: string;
  score: number;
  source: string | null;
  firstName: string;
  lastName: string;
  imageUrl: string | null;
  nationality: string;
  description: string | null;
  city: string | null;
  country: string | null;
  gender: string;
  githubSlug: string | null;
  linkedinIdIm: string | null;
  linkedinIdStr: string;
  signalHash: string;
  profileAccuracy: string;
  /** A free string, NOT the `age` filter's bucket enum. */
  age: string;
  /** Epoch milliseconds. */
  discoveredAt: number;
  twitterId: string | null;
  email: string | null;
  stealthSign: string | null;
  stealthReason: string | null;
  summary: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  taggings?: EvertraceTagging[];
  experiences?: EvertraceExperience[];
  educations?: EvertraceEducationEntry[];
  views?: EvertraceSignalEvent[];
  screenings?: EvertraceSignalEvent[];
  region?: { id: string; signalId: string; name: string; createdAt: number; updatedAt: number } | null;
  unipileMessagesCount?: number;
  unipileInvitationsCount?: number;
  listPresence?: boolean;
}

export interface EvertraceListEntry {
  id: string;
  workspaceId: string;
  listId: string;
  signalId: string;
  addedBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** Present on the expanded rows (`listEntries.list` / `listEntries.byId`);
   *  absent on the bare rows `signals.entries` returns. */
  signal?: EvertraceSignal;
  addedByUser?: EvertraceUser | null;
}

export interface EvertraceList {
  id: string;
  workspaceId: string;
  createdBy: string | null;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** `lists.list` only. */
  entriesCount?: number;
  creator?: EvertraceUser | null;
  /** `lists.byId` only — each entry carries a TRIMMED signal. */
  entries?: EvertraceListEntry[];
}

export interface EvertraceSearchFilterRow {
  id?: string;
  searchId?: string;
  key: string;
  operator: string;
  value: string;
  workspaceId?: string;
  createdAt?: number;
  updatedAt?: number;
  /** `key: "worth_following"` rows only. */
  watcherIds?: string[];
}

export interface EvertraceSearch {
  id: string;
  workspaceId: string;
  emoji: string | null;
  title: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
  visitedAt: number;
  visitedBy: string | null;
  orderIndex: string;
  /** `searches.list` / `searches.byId` only. */
  filters?: EvertraceSearchFilterRow[];
  sharees?: EvertraceUser[];
}

/** The paged envelope. No total and no `hasMore`: stop on a short page. */
export interface EvertracePage<T> {
  data: T[];
  meta: { page: number; limit: number };
}

/**
 * The `POST /signals` filter body. Every value is string-typed even where it is
 * numerically meaningful — that is Evertrace's own convention, so the shape
 * keeps it rather than coercing and hiding it from the caller.
 */
export interface EvertraceSignalFilter {
  /** `[from, to]` inclusive `YYYY-MM-DD`; a single date is allowed. Mutually
   *  exclusive with `time_relative`, which this client never sends. */
  time_range?: string[];
  /** Epoch milliseconds, as a string. */
  created_after?: string;
  /** `1`–`10`; acts as a floor (`>=`). */
  score?: string;
  /** Case-insensitive partial match on the full name. */
  fullname?: string;
  profile_tags?: string[];
  type?: string[];
  /** Country names; a `!` prefix excludes, `"N/A"` means none. */
  country?: string[];
  gender?: string[];
  age?: string[];
  past_companies?: string[];
  past_education?: string[];
  education_level?: string[];
  customer_focus?: string[];
  industry?: string[];
  origin?: string[];
  region?: string[];
  city?: string[];
  source?: string[];
  location?: string[];
  screened_by?: string[];
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** An Evertrace HTTP failure. Carries `status` so callers test the field
 *  (the not-found contract) rather than pattern-matching a message. */
export class EvertraceApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Evertrace API ${status} on ${method} ${path}${body ? `: ${body}` : ''}`);
    this.name = 'EvertraceApiError';
  }
}

/** How many times a 429 is honoured before the failure surfaces. */
const RATE_LIMIT_RETRIES = 3;
/** The wait when a 429 names no `retryAfter`. */
const RATE_LIMIT_FALLBACK_MS = 2_000;
/** Anything longer than this is a wait the run should not spend. */
const RATE_LIMIT_MAX_MS = 60_000;

/** Statuses Evertrace answers with an EMPTY body — parsing one as JSON throws
 *  a syntax error that hides the real status from the caller. */
function hasNoBody(status: number): boolean {
  return status === 204 || status === 401 || status === 403 || status === 503;
}

function retryAfterMs(response: Response, body: string): number {
  const header = response.headers.get('retry-after');
  const fromHeader = header === null ? undefined : Number(header);
  let fromBody: number | undefined;
  try {
    const parsed: unknown = body === '' ? null : JSON.parse(body);
    const value = (parsed as { retryAfter?: unknown } | null)?.retryAfter;
    if (typeof value === 'number' && Number.isFinite(value)) fromBody = value;
  } catch {
    // A 429 whose body isn't the documented shape still has the header, and
    // failing to read one hint is not a reason to fail the call.
  }
  const seconds = fromBody ?? (Number.isFinite(fromHeader) ? fromHeader : undefined);
  if (seconds === undefined) return RATE_LIMIT_FALLBACK_MS;
  return Math.min(Math.max(seconds, 0) * 1000, RATE_LIMIT_MAX_MS);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `page` / `limit` cross as STRINGS everywhere except the CSV downloads (which
 *  this client does not surface) — one helper so no call site re-decides. */
function pageParams(input: { page?: number; limit?: number }): { page?: string; limit?: string } {
  return {
    ...(input.page !== undefined ? { page: String(input.page) } : {}),
    ...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
  };
}

export interface EvertraceClientOptions extends EvertraceCredentials {
  /** The host's fetch. */
  fetch: typeof fetch;
  log: ModuleLog;
}

export class EvertraceApiClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: ModuleLog;

  constructor(options: EvertraceClientOptions) {
    this.base = (options.baseUrl ?? EVERTRACE_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch;
    this.log = options.log;
  }

  private async request<T>(input: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    body?: unknown;
    query?: Record<string, string | string[] | undefined>;
  }): Promise<T> {
    const url = new URL(this.base + input.path);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, v);
      else url.searchParams.append(key, value);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'X-API-Version': EVERTRACE_API_VERSION,
      Accept: 'application/json',
    };
    if (input.body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(url, {
        method: input.method,
        headers,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      });

      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const body = await response.text().catch(() => '');
        const waitMs = retryAfterMs(response, body);
        this.log.warn(`[evertrace] rate limited on ${input.method} ${input.path}; waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (response.status >= 400) {
        const body = hasNoBody(response.status) ? '' : await response.text().catch(() => '');
        throw new EvertraceApiError(response.status, input.method, input.path, body);
      }

      // Check the status BEFORE reaching for JSON: an empty-bodied success has
      // nothing to parse, and parsing it would throw over a call that worked.
      if (hasNoBody(response.status)) return undefined as T;
      const text = await response.text();
      if (text === '') return undefined as T;
      return JSON.parse(text) as T;
    }
  }

  // ── signals ───────────────────────────────────────────────────────────────

  listSignals(input: {
    filter?: EvertraceSignalFilter;
    page?: number;
    limit?: number;
  }): Promise<EvertracePage<EvertraceSignal>> {
    return this.request({
      method: 'POST',
      path: '/signals',
      body: { ...(input.filter ?? {}), ...pageParams(input) },
    });
  }

  getSignal(signalId: string): Promise<EvertraceSignal> {
    return this.request({ method: 'GET', path: `/signals/${encodeURIComponent(signalId)}` });
  }

  countSignals(filter: EvertraceSignalFilter): Promise<number> {
    return this.request({ method: 'POST', path: '/signals/count', body: filter });
  }

  /** The BARE list-entry rows a signal belongs to (no expanded signal). */
  listSignalEntries(signalId: string): Promise<EvertraceListEntry[]> {
    return this.request({
      method: 'GET',
      path: `/signals/${encodeURIComponent(signalId)}/entries`,
    });
  }

  /** Every signal sharing this one's LinkedIn profile. */
  listSignalsByLinkedinId(signalId: string): Promise<EvertraceSignal[]> {
    return this.request({ method: 'GET', path: `/signals/${encodeURIComponent(signalId)}/all` });
  }

  // ── searches ──────────────────────────────────────────────────────────────

  listSearches(): Promise<EvertraceSearch[]> {
    return this.request({ method: 'GET', path: '/searches' });
  }

  getSearch(searchId: string): Promise<EvertraceSearch> {
    return this.request({ method: 'GET', path: `/searches/${encodeURIComponent(searchId)}` });
  }

  createSearch(body: {
    title: string;
    emoji?: string | null;
    visitedAt: number;
    idempotencyKey?: string;
    filters: EvertraceSearchFilterRow[];
    sharees: string[];
  }): Promise<EvertraceSearch> {
    return this.request({ method: 'POST', path: '/searches', body });
  }

  /** `filters` / `sharees` REPLACE wholesale — the API has no partial edit. */
  updateSearch(
    searchId: string,
    body: {
      title?: string;
      emoji?: string | null;
      visitedAt?: number;
      filters?: EvertraceSearchFilterRow[];
      sharees?: string[];
    },
  ): Promise<EvertraceSearch | null> {
    return this.request({ method: 'PUT', path: `/searches/${encodeURIComponent(searchId)}`, body });
  }

  deleteSearch(searchId: string): Promise<EvertraceSearch> {
    return this.request({ method: 'DELETE', path: `/searches/${encodeURIComponent(searchId)}` });
  }

  /** Run a saved search's filters — newest page first. */
  listSearchSignals(
    searchId: string,
    input: { page?: number; limit?: number } = {},
  ): Promise<EvertracePage<EvertraceSignal>> {
    return this.request({
      method: 'GET',
      path: `/searches/${encodeURIComponent(searchId)}/signals`,
      query: pageParams(input),
    });
  }

  // ── lists ─────────────────────────────────────────────────────────────────

  listLists(): Promise<EvertraceList[]> {
    return this.request({ method: 'GET', path: '/lists' });
  }

  getList(listId: string): Promise<EvertraceList> {
    return this.request({ method: 'GET', path: `/lists/${encodeURIComponent(listId)}` });
  }

  /** `accesses` are the user ids the list is shared with; the creator is added
   *  by Evertrace itself. Both fields are required by the API. */
  createList(body: { name: string; accesses: string[] }): Promise<EvertraceList> {
    return this.request({ method: 'POST', path: '/lists', body });
  }

  updateList(listId: string, body: { name?: string }): Promise<EvertraceList> {
    return this.request({ method: 'PUT', path: `/lists/${encodeURIComponent(listId)}`, body });
  }

  deleteList(listId: string): Promise<EvertraceList> {
    return this.request({ method: 'DELETE', path: `/lists/${encodeURIComponent(listId)}` });
  }

  // ── list entries ──────────────────────────────────────────────────────────

  listListEntries(
    listId: string,
    input: {
      page?: number;
      limit?: number;
      sortBy?: 'entry_created_at' | 'signal_discovered_at';
      sortOrder?: 'asc' | 'desc';
    } = {},
  ): Promise<EvertracePage<EvertraceListEntry>> {
    return this.request({
      method: 'GET',
      path: `/lists/${encodeURIComponent(listId)}/entries`,
      query: {
        ...pageParams(input),
        ...(input.sortBy !== undefined ? { sort_by: input.sortBy } : {}),
        ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      },
    });
  }

  /** Idempotent on (list, signal): 201 for a new row, 200 for one already there. */
  createListEntry(listId: string, body: { signalId: string }): Promise<EvertraceListEntry> {
    return this.request({
      method: 'POST',
      path: `/lists/${encodeURIComponent(listId)}/entries`,
      body,
    });
  }

  getListEntry(listId: string, entryId: string): Promise<EvertraceListEntry> {
    return this.request({
      method: 'GET',
      path: `/lists/${encodeURIComponent(listId)}/entries/${encodeURIComponent(entryId)}`,
    });
  }

  deleteListEntry(listId: string, entryId: string): Promise<EvertraceListEntry> {
    return this.request({
      method: 'DELETE',
      path: `/lists/${encodeURIComponent(listId)}/entries/${encodeURIComponent(entryId)}`,
    });
  }

  // ── lookup entities ───────────────────────────────────────────────────────

  /** Companies, by employee count descending. `search` and `ids` are exclusive. */
  listCompanies(
    input: { page?: number; limit?: number; search?: string; ids?: string[] } = {},
  ): Promise<EvertracePage<EvertraceCompanyEntity>> {
    return this.request({
      method: 'GET',
      path: '/companies',
      query: {
        ...pageParams(input),
        ...(input.search !== undefined ? { search: input.search } : {}),
        ...(input.ids !== undefined ? { ids: input.ids } : {}),
      },
    });
  }

  /** Schools, by student count descending. `search` and `ids` are exclusive. */
  listEducations(
    input: { page?: number; limit?: number; search?: string; ids?: string[] } = {},
  ): Promise<EvertracePage<EvertraceEducationEntity>> {
    return this.request({
      method: 'GET',
      path: '/educations',
      query: {
        ...pageParams(input),
        ...(input.search !== undefined ? { search: input.search } : {}),
        ...(input.ids !== undefined ? { ids: input.ids } : {}),
      },
    });
  }

  // ── screenings / views ────────────────────────────────────────────────────

  /** Idempotent — screening an already-screened signal returns the same row. */
  screenSignal(signalId: string): Promise<EvertraceSignalEvent> {
    return this.request({
      method: 'POST',
      path: `/signals/${encodeURIComponent(signalId)}/screenings`,
    });
  }

  /** 404 `ScreeningNotFoundError` when the signal was never screened. */
  unscreenSignal(signalId: string): Promise<EvertraceSignalEvent> {
    return this.request({
      method: 'DELETE',
      path: `/signals/${encodeURIComponent(signalId)}/screenings`,
    });
  }

  /** Idempotent. Evertrace has NO un-view. */
  markSignalAsViewed(signalId: string): Promise<EvertraceSignalEvent> {
    return this.request({ method: 'POST', path: `/views/${encodeURIComponent(signalId)}` });
  }
}
