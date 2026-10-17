import { z } from 'zod';
import { backOff } from 'exponential-backoff';
import uniq from 'lodash/uniq';

import { Queue } from 'movement-engine/public/adapter-support';
import { logger } from 'movement-engine/public/log';
import {
  bindAdapterCallCounter,
  fillMemoisedRead,
  forgetMemoisedReads,
  forgetMemoisedReadsUnder,
  isAdapterCallCeilingExceeded,
  memoisedRead,
} from 'movement-engine/public/adapter-support';
import { reportAffinityWriteFailure } from './write_failures';

const SECOND = 1000;

async function parseJsonResponse(response: Response, serviceName: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    logger.error(`${serviceName} returned non-JSON response`, { status: response.status, body: text });
    throw new Error(`${serviceName} returned non-JSON response (${response.status}): ${text.slice(0, 200)}`);
  }
}

const RETRY_LIMIT = 5;
const INITIAL_DELAY = 1 * SECOND;
const TIME_MULTIPLE = 5;
const RATE_LIMIT_DELAY = 30 * SECOND;

/** Affinity v1 pages every collection endpoint the same way: `page_size` is
 *  both defaulted and capped at 500, and `next_page_token` comes back exactly
 *  while more remain. Sent explicitly so the page size is a stated fact rather
 *  than a default we inherit. */
const AFFINITY_PAGE_SIZE = 500;

/**
 * How long a workspace's own SHAPE is treated as settled: the field catalog,
 * the lists, and who the key belongs to.
 *
 * These change when a person edits their Affinity workspace, never when a run
 * writes — so asking again inside one run can only ever get the same answer
 * back. A single upsert asked for the field catalog seventeen times.
 *
 * Five minutes is the window where both halves stay true: an author who adds a
 * field, then comes back to the editor, sees it; a run pays for it once. The
 * describe/authoring refresh and a re-connected credential drop it outright
 * (`invalidateSchemaCache`), so the TTL is the floor on staleness, not the
 * only way out of it.
 */
const SCHEMA_TTL = 5 * 60 * 1000;

const MERGED_ENTITY_PATTERN = /(\w+_id): (\d+) no longer exists as it has been merged into (\d+)/;

class AffinityMergedEntityError extends Error {
  constructor(
    public readonly fieldName: string,
    public readonly oldId: string,
    public readonly newId: string,
  ) {
    super(`Affinity entity ${fieldName} ${oldId} has been merged into ${newId}`);
    this.name = 'AffinityMergedEntityError';
  }
}

const affinityCredsParser = z.object({
  apiKey: z.string(),
  baseUrl: z.string().url().optional(),
  /** The account-level "Webhook Signature Key" (profile's API tab). OPTIONAL
   *  extra security: when present, inbound webhook deliveries are HMAC-verified
   *  against it; absent, deliveries are trusted on URL secrecy. */
  webhookSignatureKey: z.string().optional(),
});

// Only validate fields we care about. Affinity doesn't list anything as
// optional or nullable, so let's assume most things might be.

// https://api-docs.affinity.co/#the-list-resource
const listValidator = z.object({
  id: z.number(),
  name: z.string().nullish(),
  // The list's entity kind — 0 person, 1 organization, 8 opportunity. Every
  // entry on the list is on exactly one entity of this kind, so it decides the
  // list-entry's single parent up-hop and its list-scoped custom-field type.
  type: z.number().nullish(),
});

const listEntryPayloadValidator = z.object({
  entity_id: z.number(),
});

const listEntryValidator = z.object({
  id: z.number(),
  list_id: z.number(),
  entity_id: z.number(),
  created_at: z.string(),
});

// https://api-docs.affinity.co/#the-organization-resource
const organisationValidator = z.object({
  id: z.number(),
  name: z.string().nullish(),
  domain: z.string().nullish(),
  domains: z.array(z.string()).nullish(),
  person_ids: z.array(z.number()).nullish(),
  global: z.boolean().nullish(),
  list_entries: z.array(listEntryValidator).nullish(),
});

const organisationPayloadValidator = z.object({
  name: z.string(),
  domain: z.string().nullish(),
  person_ids: z.array(z.number()).nullish(),
});

const organisationUpdatePayloadValidator = z.object({
  domain: z.string(),
});

const personValidator = z.object({
  id: z.number(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  primary_email: z.string().nullish(),
  emails: z.array(z.string()).nullish(),
  organization_ids: z.array(z.number()).nullish(),
  list_entries: z.array(listEntryValidator).nullish(),
});

const personPayloadValidator = z.object({
  first_name: z.string(),
  last_name: z.string(),
  emails: z.array(z.string()),
  organization_ids: z.array(z.number()).optional(),
});

const personUpdatePayloadValidator = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  emails: z.array(z.string()).optional(),
  organization_ids: z.array(z.number()).optional(),
});

const fieldsValidator = z.object({
  id: z.number(),
  name: z.string(),
  list_id: z.number().nullable(),
  enrichment_source: z.string().nullable(),
  value_type: z.number(),
  allows_multiple: z.boolean(),
  track_changes: z.boolean(),
  dropdown_options: z
    .object({
      id: z.number(),
      text: z.string(),
      rank: z.number(),
      color: z.number(),
    })
    .array()
    .nullable(),
});

const locationFieldValue = z.object({
  street_address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  continent: z.string().nullable(),
});

const valueType = {
  PERSON: 0,
  ORGANIZATION: 1,
  DROPDOWN: 2,
  NUMBER: 3,
  DATE: 4,
  LOCATION: 5,
  TEXT: 6,
  RANKED_DROPDOWN: 7,
} as const;

const rankedDropdownValidator = z.object({
  color: z.number().nullish(),
  id: z.number(),
  rank: z.number(),
  text: z.string(),
});

const fieldValuesValidator = z.intersection(
  z.object({
    id: z.number(),
    field_id: z.number(),
    list_entry_id: z.number().nullable(),
    entity_type: z.number(),
    entity_id: z.number(),
  }),
  z.union([
    z.object({
      value_type: z.literal(valueType.PERSON),
      value: z.union([z.number(), z.number().array(), z.null()]),
    }),
    z.object({
      value_type: z.literal(valueType.ORGANIZATION),
      value: z.union([z.number(), z.number().array(), z.null()]),
    }),
    z.object({
      value_type: z.literal(valueType.DROPDOWN),
      value: z.union([z.number(), z.number().array(), z.string(), z.string().array(), z.null()]),
    }),
    z.object({
      value_type: z.literal(valueType.NUMBER),
      value: z.union([z.number(), z.number().array(), z.null()]),
    }),
    z.object({
      value_type: z.literal(valueType.DATE),
      value: z.union([
        z.string().datetime({ offset: true }),
        z.string().datetime({ offset: true }).array(),
        z.null(),
      ]),
    }),
    z.object({
      value_type: z.literal(valueType.LOCATION),
      value: z.union([locationFieldValue, locationFieldValue.array(), z.null()]),
    }),
    z.object({
      value_type: z.literal(valueType.TEXT),
      value: z.union([z.string(), z.string().array(), z.null()]),
    }),
    z.object({
      value_type: z.literal(valueType.RANKED_DROPDOWN),
      value: z.union([rankedDropdownValidator, rankedDropdownValidator.array(), z.null()]),
    }),
  ]),
);

type FieldValue = z.infer<typeof fieldValuesValidator>;

const noteValidator = z.object({
  id: z.number(),
  content: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string().nullish(),
  creator_id: z.number().nullish(),
  type: z.number().nullish(),
  /** Reply threading: the note this note replies to (null = top-level). */
  parent_id: z.number().nullish(),
  person_ids: z.array(z.number()).nullish(),
  organization_ids: z.array(z.number()).nullish(),
  opportunity_ids: z.array(z.number()).nullish(),
});

// https://api-docs.affinity.co/#the-opportunity-resource
const opportunityValidator = z.object({
  id: z.number(),
  name: z.string().nullish(),
  person_ids: z.array(z.number()).nullish(),
  organization_ids: z.array(z.number()).nullish(),
  list_entries: z.array(listEntryValidator.passthrough()).nullish(),
});

// https://api-docs.affinity.co/#the-entity-file-resource
const entityFileValidator = z.object({
  id: z.number(),
  name: z.string().nullish(),
  size: z.number().nullish(),
  person_id: z.number().nullish(),
  organization_id: z.number().nullish(),
  opportunity_id: z.number().nullish(),
  uploader_id: z.number().nullish(),
  created_at: z.string().nullish(),
});

/** Embedded person objects on reminders / interactions (creator, owner,
 *  attendee `persons`, email `from`/`to`/`cc`). */
const embeddedPersonValidator = z
  .object({
    id: z.number(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    primary_email: z.string().nullish(),
    emails: z.array(z.string()).nullish(),
  })
  .passthrough();

// https://api-docs.affinity.co/#the-reminder-resource
const reminderValidator = z
  .object({
    id: z.number(),
    type: z.number(),
    reset_type: z.number().nullish(),
    status: z.number(),
    content: z.string().nullish(),
    due_date: z.string().nullish(),
    created_at: z.string().nullish(),
    completed_at: z.string().nullish(),
    reminder_days: z.number().nullish(),
    creator: embeddedPersonValidator.nullish(),
    owner: embeddedPersonValidator.nullish(),
    completer: embeddedPersonValidator.nullish(),
    person: embeddedPersonValidator.nullish(),
    organization: z.object({ id: z.number() }).passthrough().nullish(),
    opportunity: z.object({ id: z.number() }).passthrough().nullish(),
  })
  .passthrough();

// https://api-docs.affinity.co/#the-relationship-strength-resource
const relationshipStrengthValidator = z.object({
  internal_id: z.number(),
  external_id: z.number(),
  strength: z.number(),
});

/** Affinity interaction type codes (https://api-docs.affinity.co/#interactions-types). */
const INTERACTION_TYPE = {
  MEETING: 0,
  CALL: 1,
  CHAT_MESSAGE: 2,
  EMAIL: 3,
} as const;

type InteractionType = (typeof INTERACTION_TYPE)[keyof typeof INTERACTION_TYPE];

// The interaction resource's shape varies by type (meeting/call carry
// attendees + start/end; chat carries direction; email carries
// subject/from/to/cc) — validate the common core and pass the rest through.
const interactionValidator = z
  .object({
    id: z.number(),
    date: z.string().nullish(),
    type: z.number(),
    title: z.string().nullish(),
    subject: z.string().nullish(),
    direction: z.number().nullish(),
    start_time: z.string().nullish(),
    end_time: z.string().nullish(),
    attendees: z.array(z.string()).nullish(),
    notes: z.array(z.number()).nullish(),
    persons: z.array(embeddedPersonValidator).nullish(),
    from: embeddedPersonValidator.nullish(),
    to: z.array(embeddedPersonValidator).nullish(),
    cc: z.array(embeddedPersonValidator).nullish(),
  })
  .passthrough();

type AffinityInteraction = z.infer<typeof interactionValidator>;

const webhookSubscriptionValidator = z
  .object({
    id: z.number(),
    webhook_url: z.string(),
    subscriptions: z.array(z.string()),
  })
  .passthrough();

class AffinityAPIClient {
  private apiKey: string;
  private baseUrl: string;
  private rateLimitQueue = new Queue<unknown>({ concurrency: 4 });

  /**
   * The workspace's shape, cached HERE because here is the one place that is
   * already keyed by the credential: a client is minted per (api key, base
   * url), so what it caches belongs to exactly one Affinity workspace. The
   * layer above used to key the same cache by TEAM, which handed a team's
   * second Affinity connection the first workspace's schema.
   *
   * The PROMISE is stored, not the payload, so callers that ask at the same
   * moment share one flight instead of racing into several.
   */
  private readonly schemaCache = new Map<string, { at: number; value: Promise<unknown> }>();

  /**
   * The prefix on every per-run memo key this client writes: the workspace it
   * speaks to. One run may speak to two Affinity workspaces, and `person 41` is
   * a different person in each; neither may be answered from the other's reads.
   * In memory only, and never logged.
   */
  private readonly memoScope: string;

  constructor({ apiKey, baseUrl = 'https://api.affinity.co' }: { apiKey: string; baseUrl?: string }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.memoScope = `affinity:${baseUrl}:${apiKey}:`;
  }

  // ── Per-segment read memo (services/translation_graph/segment_scope.ts) ──
  // A record read once in a run is read again by the write that follows it,
  // and again by the second write to the same record. The keys below name the
  // QUESTION; the writes further down forget the ones they just answered
  // differently.

  private recordKey(kind: 'person' | 'organization', id: number | string): string {
    return `${this.memoScope}record/${kind}/${id}`;
  }

  private listEntryKey(listId: number | string, listEntryId: number | string): string {
    return `${this.memoScope}record/list-entry/${listId}/${listEntryId}`;
  }

  private fieldValuesKey(kind: 'person' | 'organization' | 'list-entry', id: number): string {
    return `${this.memoScope}field-values/${kind}/${id}`;
  }

  private searchKey(kind: string, term: string): string {
    return `${this.memoScope}search/${kind}/${term}`;
  }

  /** A field-value row names its own id, never its owner — so a write to one
   *  cannot say which record's values it changed. Every field-value answer for
   *  this workspace goes; they are cheap to re-read and there are few of them
   *  in a run that is writing at all. */
  private forgetFieldValues(): void {
    forgetMemoisedReadsUnder(`${this.memoScope}field-values/`);
  }

  /** A record that did not exist a moment ago is exactly what a search was
   *  asked about. Every search of that kind goes: a search answers with a
   *  MATCH, and only the workspace knows which terms the new record matches. */
  private forgetSearches(kind: 'person' | 'organization'): void {
    forgetMemoisedReadsUnder(`${this.memoScope}search/${kind}`);
  }

  private cachedSchema<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.schemaCache.get(key);
    if (hit && Date.now() - hit.at < SCHEMA_TTL) return hit.value as Promise<T>;
    // A FAILED load is not an answer — remembering it would serve the error to
    // everyone for the rest of the TTL, and the retry that would have fixed it
    // never happens.
    let value: Promise<T>;
    value = load().catch((err) => {
      if (this.schemaCache.get(key)?.value === value) this.schemaCache.delete(key);
      throw err;
    });
    this.schemaCache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Forget the workspace's shape. Called where a person has just had reason to
   *  change it — the authoring refresh behind `describeConnection`, and a
   *  credential being (re)connected. */
  invalidateSchemaCache(): void {
    this.schemaCache.clear();
  }

  async fetch<T = unknown, U = unknown>({
    route,
    method,
    body,
    formData,
    query,
    responseValidator,
  }: {
    route: string;
    method: string;
    body?: U;
    formData?: FormData;
    query?: Record<string, string>;
    responseValidator?: z.ZodType<T>;
    payloadValidator?: z.ZodType<U>;
  }): Promise<T> {
    const url = new URL(this.baseUrl + route);
    if (query) {
      Object.entries(query).forEach(([key, value]) => url.searchParams.append(key, value));
    }
    const headers: Record<string, string> = {
      Authorization: 'Basic ' + Buffer.from(':' + this.apiKey).toString('base64'),
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    logger.info(url.toString());

    // Bound HERE, not inside the job: this client is a process-wide singleton,
    // so the queue below dequeues a job in whichever other job's async context
    // happened to free a slot. Capturing the run at the point the call was
    // ISSUED charges the segment that asked for it (segment_scope.ts).
    const countCall = bindAdapterCallCounter('affinity');

    return this.rateLimitQueue.enqueue(async () => {
      return backOff(
        async (): Promise<T> => {
          // Per ATTEMPT, not per request: a retry is another call Affinity
          // sees, and a run that retries its way through the quota is exactly
          // what the ceiling is for.
          countCall();
          const response = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : formData,
          });

          if (response.status >= 400) {
            let text;
            try {
              text = await response.text();
            } catch {
              // ignore
            }

            if (response.status === 422 && text) {
              const mergeMatch = text.match(MERGED_ENTITY_PATTERN);
              if (mergeMatch) {
                throw new AffinityMergedEntityError(mergeMatch[1], mergeMatch[2], mergeMatch[3]);
              }
            }

            throw new Error(`Affinity Error: ${response.status} (${response.statusText}): ${text}`);
          }

          if (responseValidator) {
            const json = await parseJsonResponse(response, 'Affinity');
            try {
              return responseValidator.parse(json);
            } catch (e) {
              logger.error(json);
              throw e;
            }
          }

          return null as T;
        },
        {
          jitter: 'none',
          numOfAttempts: RETRY_LIMIT,
          startingDelay: INITIAL_DELAY,
          timeMultiple: TIME_MULTIPLE, // 0s, 1s, 4s, 16s, 64s
          retry: async (e, attempt) => {
            if (isAdapterCallCeilingExceeded(e)) {
              // Retrying the ceiling would spend the very attempts it exists
              // to stop.
              return false;
            } else if (e instanceof AffinityMergedEntityError) {
              return false;
            } else if (e instanceof Error && e.message.includes('429')) {
              // rate limit
              // extra delay to lower the odds of hitting the rate limit again
              logger.info(
                `Hit rate limit, waiting an additional ${RATE_LIMIT_DELAY / SECOND} seconds`,
              );
              await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
            } else if (e instanceof Error && e.message.includes('401')) {
              // invalid api key
              return false;
            }

            if (attempt < RETRY_LIMIT) {
              logger.info(
                `Retrying Affinity query in ${
                  (INITIAL_DELAY / SECOND) * TIME_MULTIPLE ** (attempt - 1)
                } seconds`,
                {
                  error: e,
                },
              );
            }
            return true;
          },
        },
      );
    }) as Promise<T>;
  }

  /**
   * Walk EVERY page of a v1 collection endpoint, concatenating as it goes.
   *
   * A root read means "all of them". Taking the first page and stopping is a
   * silent truncation at 500 — the answer is wrong only on workspaces big
   * enough to have a 501st record, which is exactly where it matters and
   * exactly where nobody is watching. Filters that thin the result (Affinity's
   * global dataset, say) belong AFTER this walk, never per page: a page whose
   * every record is dropped is still a page with a token behind it.
   */
  private async fetchAllPages<P extends { next_page_token?: string | null }, T>({
    route,
    query,
    pageValidator,
    select,
  }: {
    route: string;
    query?: Record<string, string>;
    pageValidator: z.ZodType<P>;
    select: (page: P) => T[];
  }): Promise<T[]> {
    const all: T[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const page = await this.fetch({
        route,
        method: 'GET',
        query: {
          ...query,
          page_size: String(AFFINITY_PAGE_SIZE),
          ...(pageToken !== undefined ? { page_token: pageToken } : {}),
        },
        responseValidator: pageValidator,
      });
      all.push(...select(page));
      const next = page.next_page_token;
      if (!next) return all;
      pageToken = next;
    }
  }

  async findManyOrganisations({
    search,
    includeGlobal,
  }: {
    search: string;
    includeGlobal: boolean;
  }) {
    // ONE page, deliberately. This is the create path's identity search, and
    // `includeGlobal` points it at Affinity's whole global dataset — walking
    // every page of that to answer "does this record already exist?" would pay
    // an unbounded number of calls for a match that is in the first page or
    // nowhere useful. The ROOT reads (`listOrganisations`) walk every page,
    // because there the count IS the answer.
    const orgs = await memoisedRead(this.searchKey('organization/match', search), () =>
      this.fetch({
        route: '/organizations',
        query: { term: search },
        method: 'GET',
        responseValidator: z.object({
          organizations: organisationValidator.array(),
        }),
      }),
    );

    // The GLOBAL filter is ours, applied to the same answer — so both callers
    // share one search rather than each paying for the term.
    // Only include entries from the user's private CRM, not Affinity's full records
    return includeGlobal ? orgs.organizations : orgs.organizations.filter((org) => !org.global);
  }

  /**
   * Enumerate the instance's organizations — the TG root-collection read
   * (`crm-[o:Organization]-> …`). GET /organizations without a `term` returns
   * the workspace's own records; every page of them. Affinity's global dataset
   * is filtered out — a root read means "my CRM", not Affinity's entire
   * universe.
   *
   * `term` is the SAME read, narrowed: Affinity substring-matches it against
   * name and domain, so it can only ever return a superset of an equality on
   * either. That is what makes it safe to push a WHERE down to — the caller
   * still filters what comes back.
   */
  async listOrganisations({ term }: { term?: string } = {}) {
    const orgs = await memoisedRead(this.searchKey('organization/list', term ?? ''), () =>
      this.fetchAllPages({
        route: '/organizations',
        ...(term ? { query: { term } } : {}),
        pageValidator: z.object({
          organizations: organisationValidator.array(),
          next_page_token: z.string().nullish(),
        }),
        select: (page) => page.organizations,
      }),
    );
    return orgs.filter((org) => !org.global);
  }

  /** Who this key belongs to. Read for ONE thing — the `<subdomain>.affinity.co`
   *  prefix under which every record's url is built — and the answer is a
   *  property of the key, so it is asked once per credential. */
  async getWhoami() {
    return this.cachedSchema('whoami', () =>
      this.fetch({
        route: '/auth/whoami',
        method: 'GET',
        responseValidator: whoamiValidator,
      }),
    );
  }

  async getOrganisationById(id: number) {
    return memoisedRead(this.recordKey('organization', id), () =>
      this.fetch({
        route: `/organizations/${id}`,
        method: 'GET',
        responseValidator: organisationValidator,
      }),
    );
  }

  async createOrganisation({ name, domain }: { name: string; domain?: string | null }) {
    const org = await this.fetch({
      route: '/organizations',
      method: 'POST',
      body: {
        name,
        domain,
      },
      responseValidator: organisationValidator,
      payloadValidator: organisationPayloadValidator,
    });

    // A company that did not exist a moment ago is precisely what the searches
    // in this run were asked about, and one of them has already answered "no".
    this.forgetSearches('organization');
    fillMemoisedRead(this.recordKey('organization', org.id), org);

    // The confirming read, which the line above just made free.
    await this.getOrganisationById(org.id);

    return org;
  }

  // ── Deletes (2026-07-05) — Affinity v1 supports first-class deletes; each
  // returns { success: true } on the happy path. ──────────────────────────

  async deleteOrganisation(id: number) {
    const result = await this.fetch({ route: `/organizations/${id}`, method: 'DELETE' });
    forgetMemoisedReads(this.recordKey('organization', id));
    this.forgetSearches('organization');
    this.forgetFieldValues();
    return result;
  }

  async deletePerson(id: number) {
    const result = await this.fetch({ route: `/persons/${id}`, method: 'DELETE' });
    forgetMemoisedReads(this.recordKey('person', id));
    this.forgetSearches('person');
    this.forgetFieldValues();
    return result;
  }

  async deleteListEntry({ listId, listEntryId }: { listId: number; listEntryId: number }) {
    const result = await this.fetch({
      route: `/lists/${listId}/list-entries/${listEntryId}`,
      method: 'DELETE',
    });
    // The entry is gone, and so is the membership row every entity read carries
    // inline — which entity, only the entry knew.
    forgetMemoisedReads(this.listEntryKey(listId, listEntryId));
    forgetMemoisedReadsUnder(`${this.memoScope}record/`);
    this.forgetFieldValues();
    return result;
  }

  async deleteNote(id: number) {
    return this.fetch({ route: `/notes/${id}`, method: 'DELETE' });
  }

  async updateOrganisation({ id, domain }: { id: number; domain: string }) {
    const org = await this.fetch({
      route: `/organizations/${id}`,
      method: 'PUT',
      body: {
        domain,
      },
      responseValidator: organisationValidator,
      payloadValidator: organisationUpdatePayloadValidator,
    });

    // The response IS the record as it now stands; a domain change also
    // changes what a domain search answers.
    fillMemoisedRead(this.recordKey('organization', id), org);
    this.forgetSearches('organization');

    return org;
  }

  async findManyPeople({ search }: { search: string }) {
    const response = await memoisedRead(this.searchKey('person/match', search), () =>
      this.fetch({
        route: '/persons',
        query: { term: search },
        method: 'GET',
        responseValidator: z.object({
          persons: personValidator.array(),
        }),
      }),
    );

    return response.persons;
  }

  /** Enumerate the instance's persons — the TG root-collection read
   *  (`crm-[p:Person]-> …`), every page of it. `term` narrows it the same way
   *  the org list's does: a substring match over name and email, so a superset
   *  of any equality on either. */
  async listPersons({ term }: { term?: string } = {}) {
    return memoisedRead(this.searchKey('person/list', term ?? ''), () =>
      this.fetchAllPages({
        route: '/persons',
        ...(term ? { query: { term } } : {}),
        pageValidator: z.object({
          persons: personValidator.array(),
          next_page_token: z.string().nullish(),
        }),
        select: (page) => page.persons,
      }),
    );
  }

  async getPersonById(id: number) {
    return memoisedRead(this.recordKey('person', id), () =>
      this.fetch({
        route: `/persons/${id}`,
        method: 'GET',
        responseValidator: personValidator,
      }),
    );
  }

  async createPerson({
    firstName,
    lastName,
    email,
    orgId,
  }: {
    firstName: string;
    lastName: string;
    email?: string | null;
    orgId?: number;
  }) {
    const person = await this.fetch({
      route: '/persons',
      method: 'POST',
      body: {
        first_name: firstName,
        last_name: lastName,
        emails: email ? [email] : [],
        organization_ids: orgId ? [orgId] : [],
      },
      responseValidator: personValidator,
      payloadValidator: personPayloadValidator,
    });

    this.forgetSearches('person');
    fillMemoisedRead(this.recordKey('person', person.id), person);

    // The confirming read, which the line above just made free.
    await this.getPersonById(person.id);

    return person;
  }

  async updatePerson(id: number, payload: z.infer<typeof personUpdatePayloadValidator>) {
    const person = await this.fetch({
      route: `/persons/${id}`,
      method: 'PUT',
      body: payload,
      responseValidator: personValidator,
      payloadValidator: personUpdatePayloadValidator,
    });
    // The response IS the record as it now stands. An address or a name change
    // also changes what a person search answers.
    fillMemoisedRead(this.recordKey('person', id), person);
    this.forgetSearches('person');
    return person;
  }

  async addPersonToOrganisation({
    person,
    org,
  }: {
    person: { id: number; organization_ids?: number[] | null };
    org: { id: number };
  }) {
    await this.updatePerson(person.id, {
      organization_ids: uniq([...(person.organization_ids ?? []), org.id]),
    });

    return null;
  }

  async getListById(id: number | string) {
    return this.fetch({
      route: `/lists/${id}`,
      method: 'GET',
      responseValidator: listValidator,
    });
  }

  async getAllLists() {
    const lists = await this.cachedSchema('lists', () =>
      this.fetch({
        route: '/lists',
        method: 'GET',
        responseValidator: listValidator.array(),
      }),
    );
    // A copy: the cached array outlives this call, and a caller that sorted or
    // spliced it would be editing every later caller's answer.
    return [...lists];
  }

  /**
   * Enumerate one list's entries — the TG root-collection read for a
   * per-list entry type (`crm-[e:\`List Entry — Pipeline\`]-> …`).
   * GET /lists/{list_id}/list-entries. `passthrough()` keeps the fields the
   * base validator doesn't name (notably `entity_type`, which the list-entry
   * parent traversal routes on).
   */
  async getListEntries({ listId }: { listId: number }) {
    return this.fetch({
      route: `/lists/${listId}/list-entries`,
      method: 'GET',
      responseValidator: listEntryValidator.passthrough().array(),
    });
  }

  async createListEntry({ list, org }: { list: { id: number }; org: { id: number } }) {
    const listEntry = await this.fetch({
      route: `/lists/${list.id}/list-entries`,
      method: 'POST',
      body: {
        entity_id: org.id,
      },
      payloadValidator: listEntryPayloadValidator,
      responseValidator: listEntryValidator,
    });

    // A membership is carried INLINE on the entity, so the entity we read
    // before this now says something untrue. Which kind of entity it is, this
    // call does not know — both go.
    forgetMemoisedReads(
      this.recordKey('organization', org.id),
      this.recordKey('person', org.id),
    );
    fillMemoisedRead(this.listEntryKey(list.id, listEntry.id), listEntry);

    // The confirming read, which the line above just made free.
    const fetchedListEntry = await this.getListEntry({
      listId: list.id,
      listEntryId: listEntry.id,
    });

    return fetchedListEntry.id;
  }

  /**
   * One entry by id. Its `entity_id` is the organization or person the entry
   * stands for, which is what a list-scoped field value has to be posted
   * against — the entry alone is not an addressable owner of a value.
   */
  async getListEntry({ listId, listEntryId }: { listId: number; listEntryId: number }) {
    return memoisedRead(this.listEntryKey(listId, listEntryId), () =>
      this.fetch({
        route: `/lists/${listId}/list-entries/${listEntryId}`,
        method: 'GET',
        responseValidator: listEntryValidator,
      }),
    );
  }

  /**
   * Every list an entity currently sits on, as the membership rows Affinity
   * returns inline on the entity itself. This is the only route from an entity
   * (or from an entry id) to the LIST an entry belongs to — a list entry is
   * addressable only under its own list.
   */
  async getEntityListEntries({
    entityId,
    entityType,
  }: {
    entityId: number;
    entityType: 'organization' | 'person';
  }) {
    // Through the by-id getters, not a fetch of its own: this is the same
    // question ("what does this record look like now?"), and asking it by a
    // different route was one of the three GETs a single upsert made of one
    // organization.
    const entity =
      entityType === 'person'
        ? await this.getPersonById(entityId)
        : await this.getOrganisationById(entityId);
    return entity.list_entries ?? [];
  }

  async getExistingListEntryId({
    list,
    entityId,
    entityType,
    startDate,
  }: {
    list: { id: number };
    entityId: number;
    entityType: 'organization' | 'person';
    startDate?: Date;
  }) {
    const entries = await this.getEntityListEntries({ entityId, entityType });

    const entriesInThisList = entries
      .filter((entry) => entry.list_id === list.id)
      .filter((entry) => {
        if (!startDate) return true;
        return new Date(entry.created_at) >= startDate;
      });
    logger.info(`[AffinityV3] getExistingListEntryId: entityType=${entityType}, entityId=${entityId}, listId=${list.id}, startDate=${startDate?.toISOString() ?? 'none'}, allEntries=${JSON.stringify(entries.map((e) => ({ id: e.id, list_id: e.list_id, created_at: e.created_at })))}, matched=${entriesInThisList.length}`);
    if (entriesInThisList.length) {
      return entriesInThisList[0].id;
    }

    return null;
  }

  async uploadEntityFile({
    entity,
    entityType = 'organization',
    file,
  }: {
    entity: { id: number };
    /** Which parent the file attaches to — POST /entity-files takes exactly one
     *  of organization_id / person_id / opportunity_id. Defaults to
     *  organization (the legacy call shape). */
    entityType?: 'organization' | 'person' | 'opportunity';
    file: File;
  }) {
    const formData = new FormData();
    formData.append('file', file);
    const paramKey = {
      organization: 'organization_id',
      person: 'person_id',
      opportunity: 'opportunity_id',
    }[entityType];
    formData.append(paramKey, entity.id.toString());

    return this.fetch({
      route: `/entity-files`,
      method: 'POST',
      formData,
    });
  }

  /**
   * The workspace's WHOLE field catalog for one entity kind — the payload every
   * scoped view below is derived from, cached per credential.
   *
   * `entity_type` is the only narrowing Affinity itself does here; a list scope
   * has always been applied on our side, over this same array. So there is one
   * request per entity kind per workspace, and every list's view of it is a
   * filter in memory.
   */
  private allFields(type?: 'PERSON' | 'ORGANIZATION') {
    return this.cachedSchema(`fields:${type ?? 'ALL'}`, () =>
      this.fetch({
        route: '/fields',
        query: {
          with_modified_names: 'true',
          ...(type ? { entity_type: { PERSON: '0', ORGANIZATION: '1' }[type] } : {}),
        },
        method: 'GET',
        responseValidator: fieldsValidator.array(),
      }),
    );
  }

  /**
   * The fields a caller may address: every unscoped field, plus — when
   * `limitToListId` names a list — that list's own.
   *
   * The list filter is ours, not Affinity's, and it runs over the cached
   * catalog. It used to cost a second request (`getAllLists`) purely to turn a
   * list NAME into an id, on a path that already had the answer in hand.
   */
  async getFields({
    limitToListId,
    type,
  }: {
    limitToListId?: number | string;
    type?: 'PERSON' | 'ORGANIZATION';
  }) {
    const fields = await this.allFields(type);
    if (limitToListId == null) return [...fields];

    const lists = await this.getAllLists();
    const matchingList = lists.find(
      (list) => list.id === limitToListId || list.name === limitToListId,
    );

    return fields.filter((field) => {
      if (!field.list_id) return true;
      else if (matchingList) return field.list_id === matchingList.id;
      else return true;
    });
  }

  // ── Webhook subscriptions (max 3 per Affinity instance) ────────────────
  // POST /webhooks {webhook_url, subscriptions[]} / PUT /webhooks/{id} /
  // DELETE /webhooks/{id}. Deliveries arrive as {type, body, sent_at}; the
  // HMAC key is account-level (the profile API tab) and NOT returned here.

  async createWebhookSubscription({
    webhookUrl,
    subscriptions,
  }: {
    webhookUrl: string;
    subscriptions: string[];
  }) {
    return this.fetch({
      route: '/webhooks',
      method: 'POST',
      body: { webhook_url: webhookUrl, subscriptions },
      responseValidator: webhookSubscriptionValidator,
    });
  }

  async updateWebhookSubscription({
    id,
    subscriptions,
  }: {
    id: string;
    subscriptions: string[];
  }) {
    return this.fetch({
      route: `/webhooks/${id}`,
      method: 'PUT',
      body: { subscriptions },
      responseValidator: webhookSubscriptionValidator,
    });
  }

  async deleteWebhookSubscription(id: string) {
    await this.fetch({
      route: `/webhooks/${id}`,
      method: 'DELETE',
      responseValidator: z.unknown(),
    });
  }

  async getFieldValues({
    person_id,
    organization_id,
    list_entry_id,
  }: {
    person_id?: number;
    organization_id?: number;
    list_entry_id?: number;
  }) {
    const query: Record<string, string> = {};
    if (person_id) {
      query.person_id = person_id.toString();
    }
    if (organization_id) {
      query.organization_id = organization_id.toString();
    }
    if (list_entry_id) {
      query.list_entry_id = list_entry_id.toString();
    }

    const scope: ['person' | 'organization' | 'list-entry', number] | null = person_id
      ? ['person', person_id]
      : organization_id
        ? ['organization', organization_id]
        : list_entry_id
          ? ['list-entry', list_entry_id]
          : null;

    const read = () =>
      this.fetch({
        route: '/field-values',
        query,
        method: 'GET',
        responseValidator: fieldValuesValidator.array(),
      });

    // An unscoped query is every value in the workspace — not a question about
    // one record, and not something to remember.
    return scope ? memoisedRead(this.fieldValuesKey(scope[0], scope[1]), read) : read();
  }

  /** A failed write PROPAGATES. Whether a field that did not land is fatal is
   *  the caller's policy, and a caller that never hears about it has no policy
   *  at all — which is what a swallow here silently imposed on everyone. */
  async updateFieldValue({ id, value }: { id: number; value: unknown }) {
    const result = await this.fetch({
      route: `/field-values/${id}`,
      method: 'PUT',
      body: { value },
    });
    this.forgetFieldValues();
    return result;
  }

  /** Remove a field value outright. Affinity has no "clear this field" verb —
   *  a value row IS the value, so deleting the row is how a single-valued
   *  reference is emptied and how one target leaves a multi-valued one. */
  async deleteFieldValue({ id }: { id: number }) {
    const result = await this.fetch({
      route: `/field-values/${id}`,
      method: 'DELETE',
      responseValidator: z.unknown(),
    });
    this.forgetFieldValues();
    return result;
  }

  async createFieldValue({
    field_id,
    entity_id,
    value,
    list_entry_id,
  }: {
    field_id: number;
    entity_id: number;
    list_entry_id?: number;
    value: unknown;
  }) {
    const result = await this.fetch({
      route: '/field-values',
      method: 'POST',
      body: {
        field_id,
        entity_id,
        list_entry_id,
        value,
      },
      payloadValidator: z.object({
        field_id: z.number(),
        entity_id: z.number(),
        list_entry_id: z.number().optional(),
        value: z.any(),
      }),
    });
    this.forgetFieldValues();
    return result;
  }

  async createNote({
    organization_id,
    organization_ids,
    person_ids,
    opportunity_ids,
    parent_id,
    content,
    type,
  }: {
    /** Legacy single-org shape — merged into `organization_ids`. */
    organization_id?: number;
    organization_ids?: number[];
    person_ids?: number[];
    opportunity_ids?: number[];
    /** Reply threading: create this note as a reply to an existing note. Per
     *  the API, entity associations are ignored when `parent_id` is set —
     *  only the parent note carries them. */
    parent_id?: number;
    content: string;
    type?: number;
  }) {
    const orgIds = uniq([
      ...(organization_ids ?? []),
      ...(organization_id != null ? [organization_id] : []),
    ]);
    try {
      return await this.fetch({
        route: '/notes',
        method: 'POST',
        body: {
          ...(orgIds.length ? { organization_ids: orgIds } : {}),
          ...(person_ids?.length ? { person_ids } : {}),
          ...(opportunity_ids?.length ? { opportunity_ids } : {}),
          ...(parent_id != null ? { parent_id } : {}),
          content,
          ...(type != null ? { type } : {}),
        },
        responseValidator: noteValidator.passthrough(),
      });
    } catch (e) {
      logger.error(e);

      await reportAffinityWriteFailure({
        kind: 'note',
        detail: `orgs: ${orgIds.join(',') || '—'}, persons: ${person_ids?.join(',') ?? '—'}, opportunities: ${opportunity_ids?.join(',') ?? '—'}, parent: ${parent_id ?? '—'}`,
      });
      return null;
    }
  }

  async getAllNotes({ orgId }: { orgId: number }) {
    const notes = await this.fetch({
      route: `/notes`,
      query: { organization_id: orgId.toString() },
      method: 'GET',
      responseValidator: z.object({
        notes: noteValidator.array(),
        next_page_token: z.string().nullish(),
      }),
    });

    // TODO: paginate through

    return notes.notes;
  }

  /**
   * Enumerate notes — workspace-wide when no filter is given (GET /notes
   * "returns all the note resources available to you"), or scoped to one
   * person / organization / opportunity. Every page either way.
   */
  async listNotes(
    filter: { personId?: number; organizationId?: number; opportunityId?: number } = {},
  ) {
    const query: Record<string, string> = {};
    if (filter.personId != null) query.person_id = String(filter.personId);
    if (filter.organizationId != null) query.organization_id = String(filter.organizationId);
    if (filter.opportunityId != null) query.opportunity_id = String(filter.opportunityId);
    return this.fetchAllPages({
      route: '/notes',
      query,
      pageValidator: z.object({
        notes: noteValidator.passthrough().array(),
        next_page_token: z.string().nullish(),
      }),
      select: (page) => page.notes,
    });
  }

  async getNoteById(id: number) {
    return this.fetch({
      route: `/notes/${id}`,
      method: 'GET',
      responseValidator: noteValidator.passthrough(),
    });
  }

  /**
   * Enumerate entity files — workspace-wide (GET /entity-files "returns all
   * entity files within your organization") or scoped to one person /
   * organization / opportunity. Every page either way.
   */
  async listEntityFiles(
    filter: { personId?: number; organizationId?: number; opportunityId?: number } = {},
  ) {
    const query: Record<string, string> = {};
    if (filter.personId != null) query.person_id = String(filter.personId);
    if (filter.organizationId != null) query.organization_id = String(filter.organizationId);
    if (filter.opportunityId != null) query.opportunity_id = String(filter.opportunityId);
    return this.fetchAllPages({
      route: '/entity-files',
      query,
      pageValidator: z.object({
        entity_files: entityFileValidator.passthrough().array(),
        next_page_token: z.string().nullish(),
      }),
      select: (page) => page.entity_files,
    });
  }

  /**
   * Enumerate the instance's opportunities — GET /opportunities without a
   * `term` returns the workspace's own records, every page of them.
   */
  async listOpportunities({ term }: { term?: string } = {}) {
    return this.fetchAllPages({
      route: '/opportunities',
      ...(term ? { query: { term } } : {}),
      pageValidator: z.object({
        opportunities: opportunityValidator.passthrough().array(),
        next_page_token: z.string().nullish(),
      }),
      select: (page) => page.opportunities,
    });
  }

  async getOpportunityById(id: number) {
    return this.fetch({
      route: `/opportunities/${id}`,
      method: 'GET',
      responseValidator: opportunityValidator.passthrough(),
    });
  }

  /**
   * Enumerate reminders — workspace-wide (GET /reminders has no required
   * params) or scoped to one person / organization / opportunity. Every page
   * either way.
   */
  async listReminders(
    filter: { personId?: number; organizationId?: number; opportunityId?: number } = {},
  ) {
    const query: Record<string, string> = {};
    if (filter.personId != null) query.person_id = String(filter.personId);
    if (filter.organizationId != null) query.organization_id = String(filter.organizationId);
    if (filter.opportunityId != null) query.opportunity_id = String(filter.opportunityId);
    return this.fetchAllPages({
      route: '/reminders',
      query,
      pageValidator: z.object({
        reminders: reminderValidator.array(),
        next_page_token: z.string().nullish(),
      }),
      select: (page) => page.reminders,
    });
  }

  /**
   * Relationship strengths for an EXTERNAL person (GET
   * /relationships-strengths — `external_id` required, `internal_id`
   * optional). Returns every internal↔external pair when `internalId` is
   * omitted; pairs with no interaction history have no row at all.
   */
  async getRelationshipStrengths({
    externalId,
    internalId,
  }: {
    externalId: number;
    internalId?: number;
  }) {
    const query: Record<string, string> = { external_id: String(externalId) };
    if (internalId != null) query.internal_id = String(internalId);
    return this.fetch({
      route: '/relationships-strengths',
      query,
      method: 'GET',
      responseValidator: relationshipStrengthValidator.array(),
    });
  }

  /**
   * Interactions of ONE type for ONE entity over a time range (GET
   * /interactions: `type`, `start_time`, `end_time` are required; exactly one
   * of person_id / organization_id / opportunity_id must be given; the range
   * must not exceed one year). The response keys its array by the interaction
   * kind (`emails` for type 3 is the documented example; the docs never name
   * the other keys), so the parse is deliberately tolerant: take the single
   * array the envelope carries, whatever it is called.
   */
  async listInteractions({
    type,
    personId,
    organizationId,
    opportunityId,
    startTime,
    endTime,
  }: {
    type: InteractionType;
    personId?: number;
    organizationId?: number;
    opportunityId?: number;
    startTime: Date;
    endTime: Date;
  }): Promise<AffinityInteraction[]> {
    const query: Record<string, string> = {
      type: String(type),
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
    };
    if (personId != null) query.person_id = String(personId);
    if (organizationId != null) query.organization_id = String(organizationId);
    if (opportunityId != null) query.opportunity_id = String(opportunityId);
    const envelope = await this.fetch({
      route: '/interactions',
      query,
      method: 'GET',
      responseValidator: z.record(z.string(), z.unknown()),
    });
    const rows = Object.entries(envelope).find(
      ([key, value]) => key !== 'next_page_token' && Array.isArray(value),
    )?.[1];
    if (!Array.isArray(rows)) return [];
    return interactionValidator.array().parse(rows);
  }
}

const whoamiValidator = z.object({
  tenant: z.object({
    id: z.number(),
    name: z.string(),
    subdomain: z.string(),
  }),
  user: z.object({
    id: z.number(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
  }),
  grant: z.object({
    type: z.string(),
    scope: z.string(),
    createdAt: z.string(),
  }),
});

const webClientsByAccessToken: Record<string, AffinityAPIClient> = {};

const getAffinityClient = (apiKey: string, baseUrl?: string): AffinityAPIClient => {
  const cacheKey = baseUrl ? `${apiKey}:${baseUrl}` : apiKey;
  if (!webClientsByAccessToken[cacheKey]) {
    webClientsByAccessToken[cacheKey] = new AffinityAPIClient({ apiKey, baseUrl });
  }

  return webClientsByAccessToken[cacheKey];
};

/**
 * Forget what we know about the workspace behind these credentials.
 *
 * A key being (re)connected is a person telling us their Affinity changed —
 * and a reconnect with the SAME key lands on the very client that is holding
 * the old answer. A key we have never used has no client and nothing to
 * forget.
 */
const forgetAffinityWorkspace = (apiKey: string, baseUrl?: string): void => {
  const cacheKey = baseUrl ? `${apiKey}:${baseUrl}` : apiKey;
  webClientsByAccessToken[cacheKey]?.invalidateSchemaCache();
};

export {
  AffinityAPIClient,
  AffinityMergedEntityError,
  forgetAffinityWorkspace,
  getAffinityClient,
  affinityCredsParser,
  organisationValidator,
  personValidator,
  locationFieldValue,
  fieldsValidator,
  valueType,
  FieldValue,
  INTERACTION_TYPE,
  InteractionType,
  AffinityInteraction,
};
