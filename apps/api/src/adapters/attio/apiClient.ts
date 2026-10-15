import { z } from 'zod';
import { backOff } from 'exponential-backoff';

import { parseJsonResponse } from '../../lib/utils/fetch';
import { SECOND } from '../../constants';
import { logger } from 'movement-engine/services/logger';
import { Queue } from '../../lib/utils/queue';
import {
  AttioAttribute,
  attioAttributeTypeValidator,
  AttioConfigurer,
  KNOWN_ATTIO_ATTRIBUTE_TYPES,
} from './interface';
import { notNull } from '../../lib/utils/nullability';
import { sendSlackNotification } from '../../lib/slack';

/** Attio's own page cap for attribute listings is generous; this is well under
 *  it and keeps a wide object to a couple of round trips. */
const ATTIO_ATTRIBUTE_PAGE_SIZE = 500;
/** A backstop so a server that ignores `offset` can't spin the loop forever. */
const ATTIO_ATTRIBUTE_MAX_OFFSET = 10_000;

type CustomRetryHandler<U> = (options: {
  error: Error;
  body: U;
}) => Promise<{ shouldRetry: true; newBody: U } | { shouldRetry: false }>;

// Attio surfaces a rejected field two ways:
//   • by attribute UUID in the message —
//       `Invalid value supplied for attribute with ID "<uuid>"`
//   • by field SLUG in a structured `validation_errors[].path` —
//       `path: ["data", "values", "<slug>"]` (records) /
//       `["data", "entry_values", "<slug>"]` (list entries), with a generic
//       `message: "Body payload validation error."`
// We accept both so a single bad field is stripped + retried + surfaced
// rather than failing the whole write silently.
const attioValidationErrorParser = z.object({
  status_code: z.literal(400),
  type: z.literal('invalid_request_error'),
  code: z.literal('validation_type'),
  message: z.string(),
  validation_errors: z
    .array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])).optional(),
      }),
    )
    .optional(),
});

/**
 * Pull the rejected field's identifier out of an Attio 400 validation
 * error — an attribute UUID (from the message) or a field slug (from the
 * structured `validation_errors[].path`). Returns null when the error
 * isn't a recognisable per-field validation failure. The retry handler
 * resolves whichever it gets against the request's fields.
 */
export function parseAttributeIdFromError(error: Error): string | null {
  const match = error.message.match(/\{"status_code":400.*?\}$/);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[0]);
    const result = attioValidationErrorParser.safeParse(parsed);
    if (!result.success) {
      return null;
    }

    // Format 1: attribute UUID named in the message.
    const attributeIdMatch = result.data.message.match(
      /Invalid value supplied for attribute with ID "([^"]+)"/,
    );
    if (attributeIdMatch?.[1]) return attributeIdMatch[1];

    // Format 2: field slug in a `validation_errors[].path`. The field key
    // is the element right after `values` / `entry_values`.
    for (const ve of result.data.validation_errors ?? []) {
      const path = ve.path ?? [];
      const anchor = path.findIndex(
        (seg) => seg === 'values' || seg === 'entry_values',
      );
      const key = anchor >= 0 ? path[anchor + 1] : undefined;
      if (typeof key === 'string' && key.length > 0) return key;
    }
    return null;
  } catch {
    return null;
  }
}

type RecordBody = { data: { values: Record<string, unknown> } };
type ListEntryBody = { data: { entry_values: Record<string, unknown>; [key: string]: unknown } };

/**
 * Attio rejects an explicit `null` for an attribute value (400 `validation_type`,
 * "Invalid input") — it expects the attribute to be omitted instead. On a create
 * there is nothing to clear; on an update, omitting leaves the existing value
 * untouched, which is the safe default when a movement extracted no value. Strip
 * null/undefined before every write so an absent value never 400s. (Intentionally
 * CLEARING a value uses Attio's empty form, e.g. `[]` — a separate, explicit
 * operation, not an extracted null.)
 *
 * Multi-value fields get the same treatment ELEMENT-wise: extraction can leave
 * null holes inside an array (e.g. companies.domains), and Attio 400s on a
 * null element. Nulls are compacted out; an array that held ONLY nulls is
 * omitted like a null scalar — never converted into `[]`, which would read as
 * an intentional clear.
 */
export function omitNullish(fields: Record<string, unknown>): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const compacted = value.filter((item) => item !== null && item !== undefined);
      if (compacted.length === 0 && value.length > 0) continue;
      entries.push([key, compacted]);
      continue;
    }
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

type FieldValidationRetryHandlerOptions<T extends RecordBody | ListEntryBody> = {
  context: string;
  getFields: (body: T) => Record<string, unknown>;
  setFields: (body: T, fields: Record<string, unknown>) => T;
  lookupApiSlug: (attributeId: string) => Promise<string | null>;
};

function createFieldValidationRetryHandler<T extends RecordBody | ListEntryBody>({
  context,
  getFields,
  setFields,
  lookupApiSlug,
}: FieldValidationRetryHandlerOptions<T>): CustomRetryHandler<T> {
  return async ({ error, body }) => {
    const attributeId = parseAttributeIdFromError(error);
    if (!attributeId) {
      return { shouldRetry: false };
    }

    const currentFields = getFields(body);

    // Check if the fields are keyed by attribute ID directly
    // If so, use the attribute ID; otherwise look up the API slug
    let fieldKey: string;
    if (attributeId in currentFields) {
      fieldKey = attributeId;
    } else {
      const apiSlug = await lookupApiSlug(attributeId);
      if (!apiSlug) {
        logger.warn(`Could not find API slug for attribute ID ${attributeId}`, {
          context,
          attributeId,
          error: error.message,
        });
        return { shouldRetry: false };
      }
      if (!(apiSlug in currentFields)) {
        return { shouldRetry: false };
      }
      fieldKey = apiSlug;
    }

    const fieldValue = currentFields[fieldKey];
    const { [fieldKey]: _, ...remainingFields } = currentFields;

    await sendSlackNotification({
      type: 'DEALFLOW',
      text: `Attio field validation error in ${context}: attribute "${fieldKey}" (ID: ${attributeId}) with value ${JSON.stringify(fieldValue)} was rejected. Retrying without this field. Error: ${error.message}`,
      opsTitle: `Attio rejected field "${fieldKey}" in ${context}`,
    });

    logger.warn(`Removing invalid field ${fieldKey} from Attio request and retrying`, {
      context,
      attributeId,
      fieldKey,
      fieldValue,
      error: error.message,
    });

    return {
      shouldRetry: true,
      newBody: setFields(body, remainingFields),
    };
  };
}

const RETRY_LIMIT = 5;
const INITIAL_DELAY = 1 * SECOND;
const TIME_MULTIPLE = 5;
const RATE_LIMIT_DELAY = 30 * SECOND;

const attioCredsParser = z.object({
  accessToken: z.string(),
  baseUrl: z.string().url().optional(),
  // Cached id of the API token Attio assigns to this access token, captured
  // at credential-creation time. Webhooks fired in response to writes we
  // perform via this access token carry `actor.id === apiTokenId` (and
  // `actor.type === 'api-token'`), which the framework's Layer 14.4
  // echo-recognition uses to drop loops at entry. Optional for backwards
  // compatibility with credentials minted before this capture existed —
  // those fall through to Layer 14.2 (circuit breaker) for loop protection.
  apiTokenId: z.string().optional(),
});

// https://docs.attio.com/rest-api/endpoint-reference/lists/list-all-lists
const listValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    list_id: z.string(),
  }),
  name: z.string(),
  // Slugs of the Attio object types this list scopes to. Returned by
  // Attio as `["companies"]` (array of slugs — not UUIDs, not a single
  // string) because a list can in principle be multi-typed. Used by
  // the TG schema descriptor to surface a list as an outgoing
  // reference on the right record types only.
  parent_object: z.array(z.string()).nullable().optional(),
  // Stable URL slug for the list. Used to build a canonical synthetic
  // typeId — falls back to list_id.
  api_slug: z.string().nullable().optional(),
});

const optionValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    object_id: z.string(),
    attribute_id: z.string(),
    option_id: z.string(),
  }),
  title: z.string(),
  is_archived: z.boolean(),
});

const attributeValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    object_id: z.string(),
    attribute_id: z.string(),
  }),
  api_slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: attioAttributeTypeValidator,
  is_multiselect: z.boolean(),
  is_unique: z.boolean(),
  is_required: z.boolean(),
  is_writable: z.boolean(),
  is_system_attribute: z.boolean(),
  relationship: z
    .object({
      id: z.object({
        workspace_id: z.string(),
        object_id: z.string(),
        attribute_id: z.string(),
      }),
    })
    .nullable(),
  config: z.object({
    currency: z
      .object({
        currency_code: z
          .enum([
            'ARS',
            'AUD',
            'BRL',
            'BGN',
            'CAD',
            'CLP',
            'CNY',
            'COP',
            'CZK',
            'DKK',
            'EUR',
            'HKD',
            'ISK',
            'INR',
            'ILS',
            'JPY',
            'KRW',
            'MYR',
            'MXN',
            'NTD',
            'NZD',
            'NGN',
            'NOK',
            'XPF',
            'PEN',
            'PHP',
            'PLN',
            'GBP',
            'RWF',
            'SAR',
            'SGD',
            'ZAR',
            'SEK',
            'CHF',
            'AED',
            'UYU',
            'USD',
          ])
          .nullish(),
      })
      .optional(),
    record_reference: z
      .object({
        allowed_object_ids: z.array(z.string()).nullable(),
      })
      .optional(),
  }),
});

const objectValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    object_id: z.string(),
  }),
  singular_noun: z.string().nullable(),
  plural_noun: z.string().nullable(),
  api_slug: z.string().nullable(),
});

const searchValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    object_id: z.string(),
    record_id: z.string(),
  }),
  record_text: z.string(),
});

const recordValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    object_id: z.string(),
    record_id: z.string(),
  }),
  web_url: z.string().optional(),
  values: z.record(z.string(), z.any()),
});

type AttioRecord = z.infer<typeof recordValidator>;

const listEntryValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    list_id: z.string(),
    entry_id: z.string(),
  }),
  entry_values: z.record(z.string(), z.any()),
  parent_record_id: z.string().nullable().optional(),
  // The object slug of the record this entry sits on (`companies`, `people`,
  // …). Attio returns it on every list entry; it's the discriminator that lets
  // the entry hop back up to its typed parent record.
  parent_object: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});

type AttioListEntry = z.infer<typeof listEntryValidator>;

const statusValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    object_id: z.string(),
    attribute_id: z.string(),
    status_id: z.string(),
  }),
  title: z.string(),
  is_archived: z.boolean(),
});

const noteValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    note_id: z.string(),
  }),
});

// Full-shape validators for the GET endpoints. Loose where Attio's
// responses vary or evolve (extra fields ignored by zod's default
// passthrough on objects, but we explicitly accept .nullable() on the
// timestamps that ride through "may be null") — the adapter only reads
// the fields it surfaces in its synthetic schema types.
//
// Sources: docs.attio.com/rest-api — task, note, comment GET endpoints.
const fullNoteValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    note_id: z.string(),
  }),
  parent_object: z.string().nullable().optional(),
  parent_record_id: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  meeting_id: z.string().nullable().optional(),
  content_plaintext: z.string().nullable().optional(),
  content_markdown: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});

const fullTaskValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    task_id: z.string(),
  }),
  content_plaintext: z.string().nullable().optional(),
  deadline_at: z.string().nullable().optional(),
  is_completed: z.boolean().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});

const fullCommentValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    comment_id: z.string(),
  }),
  thread_id: z.string().nullable().optional(),
  content_plaintext: z.string().nullable().optional(),
  resolved_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  // Who wrote the comment — an Attio actor `{ type, id }`, never an email on
  // the wire (the adapter resolves workspace-member ids to emails itself).
  author: z
    .object({
      type: z.string().nullable().optional(),
      id: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

/** A thread of comments (GET /v2/threads). The comments ride INLINE on the
 *  thread — Attio has no list-comments endpoint; threads are the only way to
 *  enumerate a record's or list entry's comments. */
const threadValidator = z.object({
  id: z.object({
    workspace_id: z.string(),
    thread_id: z.string(),
  }),
  comments: z.array(fullCommentValidator),
  created_at: z.string().nullable().optional(),
});

/** One row of GET /v2/files. The endpoint's `data` mixes files, folders and
 *  connected drive items (discriminated by `file_type`); only `file` rows are
 *  Attio-native binaries the download endpoint can stream, so the caller
 *  filters on the discriminator before this validator applies. */
const fileListRowValidator = z.object({
  file_type: z.literal('file'),
  id: z.object({
    workspace_id: z.string(),
    file_id: z.string(),
  }),
  name: z.string().nullable().optional(),
  content_type: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});

const attioUniquenessConflictParser = z.object({
  status_code: z.literal(409),
  type: z.literal('invalid_request_error'),
  code: z.literal('uniqueness_conflict'),
  message: z.string(),
});

/**
 * True when an Attio error is specifically the file-upload name collision
 * (409 `uniqueness_conflict`) — the one case `uploadFile` retries under a
 * suffixed name. Any other error, including a different 409, is a real
 * failure and must propagate as-is.
 */
function isUploadUniquenessConflict(error: Error): boolean {
  const match = error.message.match(/\{"status_code":409.*\}$/);
  if (!match) {
    return false;
  }

  try {
    return attioUniquenessConflictParser.safeParse(JSON.parse(match[0])).success;
  } catch {
    return false;
  }
}

/** A file-upload retry attempt never stacks on a prior suffix — each attempt
 *  suffixes the ORIGINAL name, matching the OS/browser-download convention
 *  (`report.pdf` → `report (1).pdf`, not `report (1) (2).pdf`). A name with
 *  no extension (or only a leading dot, e.g. `.env`) gets the suffix appended
 *  rather than split around a false "extension". */
export function suffixFileName(originalName: string, n: number): string {
  const lastDot = originalName.lastIndexOf('.');
  if (lastDot <= 0) {
    return `${originalName} (${n})`;
  }

  return `${originalName.slice(0, lastDot)} (${n})${originalName.slice(lastDot)}`;
}

// A conflict is resolved by LISTING the record's files rather than probing
// names one re-upload at a time, so this cap only needs to cover the initial
// attempt plus a couple of race backstops (a concurrent upload landing the
// computed name first) — not a long blind search.
const MAX_UPLOAD_ATTEMPTS = 5;

class AttioAPIClient implements AttioConfigurer {
  private accessToken: string;
  private baseUrl: string;

  private rateLimitQueue = new Queue<unknown>({ concurrency: 4 });

  private attributeCache: Map<string, AttioAttribute[]> = new Map();

  private workspaceSlugCache: string | null = null;

  constructor(creds: z.infer<typeof attioCredsParser>) {
    this.accessToken = creds.accessToken;
    this.baseUrl = creds.baseUrl ?? 'https://api.attio.com';
  }

  private async lookupApiSlugForAttribute({
    objectId,
    listId,
    attributeId,
  }: {
    objectId?: string;
    listId?: string;
    attributeId: string;
  }): Promise<string | null> {
    const cacheKey = objectId ? `object:${objectId}` : `list:${listId}`;
    let attributes = this.attributeCache.get(cacheKey);

    if (!attributes) {
      attributes = await this.listAttributes({ objectId, listId });
      this.attributeCache.set(cacheKey, attributes);
    }

    const attribute = attributes.find((attr) => attr.id === attributeId);
    return attribute?.apiSlug ?? null;
  }

  async fetch<T = unknown, U = unknown>({
    route,
    method,
    body,
    formData,
    query,
    responseValidator,
    customRetryHandler,
  }: {
    route: string;
    method: string;
    body?: U;
    formData?: FormData;
    query?: Record<string, string>;
    responseValidator?: z.ZodType<T>;
    payloadValidator?: z.ZodType<U>;
    customRetryHandler?: CustomRetryHandler<U>;
  }): Promise<T> {
    const url = new URL(this.baseUrl + route);
    if (query) {
      Object.entries(query).forEach(([key, value]) => url.searchParams.append(key, value));
    }
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + this.accessToken,
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    logger.info(url.toString());

    let currentBody = body;

    return this.rateLimitQueue.enqueue(async () => {
      return backOff(
        async (): Promise<T> => {
          const response = await fetch(url, {
            method,
            headers,
            body: currentBody ? JSON.stringify(currentBody) : formData,
          });

          if (response.status >= 400) {
            let text;
            try {
              text = await response.text();
            } catch {
              // ignore
            }
            // Surface every Attio 4xx/5xx in the server log — including the
            // request that produced it — so write failures aren't invisible
            // (a retried field-validation error still logs here each attempt;
            // a fatal one is otherwise swallowed by the caller's run record).
            logger.warn(`Attio request failed: ${method} ${route} → ${response.status}`, {
              status: response.status,
              statusText: response.statusText,
              responseBody: text,
              requestBody: currentBody,
            });
            throw new Error(`Attio Error: ${response.status} (${response.statusText}): ${text}`);
          }

          if (responseValidator) {
            const json = await parseJsonResponse(response, 'Attio');
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
            if (e instanceof Error && e.message.includes('429')) {
              // rate limit
              // extra delay to lower the odds of hitting the rate limit again
              logger.info(
                `Hit rate limit, waiting an additional ${RATE_LIMIT_DELAY / SECOND} seconds`,
              );
              await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
            } else if (e instanceof Error && e.message.includes('401')) {
              // invalid api key
              return false;
            } else if (e instanceof Error && e.message.includes('404')) {
              // invalid api key
              return false;
            }

            if (customRetryHandler && currentBody && e instanceof Error) {
              const result = await customRetryHandler({ error: e, body: currentBody });
              if (result.shouldRetry) {
                currentBody = result.newBody;
                return true;
              } else {
                return false;
              }
            }

            // A 4xx (other than 429, handled above) is a DETERMINISTIC client
            // error — the identical request will fail identically, so retrying
            // it just burns the backoff budget (a webhook validation 400 was
            // costing ~85s of pointless retries before surfacing). Only
            // transient failures (5xx / network) are worth a retry. Any
            // retryable 4xx (e.g. field-validation) was already handled by the
            // customRetryHandler above.
            const statusMatch = e instanceof Error ? e.message.match(/Attio Error: (\d{3})/) : null;
            if (statusMatch) {
              const status = Number(statusMatch[1]);
              if (status >= 400 && status < 500 && status !== 429) return false;
            }

            if (attempt < RETRY_LIMIT) {
              logger.info(
                `Retrying Attio query in ${
                  (INITIAL_DELAY / SECOND) * TIME_MULTIPLE ** (attempt - 1)
                } seconds: ${url.toString()}`,
                {
                  error: e instanceof Error ? e.message : e,
                },
              );
            }
            return true;
          },
        },
      );
    }) as Promise<T>;
  }

  async listLists(): Promise<
    {
      id: string;
      name: string;
      /** Slugs of Attio objects this list scopes to. Empty when the
       *  list is unscoped or the field was absent. */
      parentObjectSlugs: string[];
      apiSlug: string | null;
    }[]
  > {
    const lists = await this.fetch({
      route: '/v2/lists',
      method: 'GET',
      responseValidator: z.object({
        data: z.array(listValidator),
      }),
    });

    return lists.data.map((list) => ({
      id: list.id.list_id,
      name: list.name,
      parentObjectSlugs: list.parent_object ?? [],
      apiSlug: list.api_slug ?? null,
    }));
  }

  async getWorkspaceSlug(): Promise<string> {
    if (this.workspaceSlugCache) return this.workspaceSlugCache;

    const response = await this.fetch({
      route: '/v2/self',
      method: 'GET',
      responseValidator: z.object({
        workspace_slug: z.string(),
      }),
    });

    this.workspaceSlugCache = response.workspace_slug;
    return response.workspace_slug;
  }

  /**
   * Return the id of the API token Attio assigns to this access token. The
   * caller registers it with `PlatformTokenRegistry.registerToken` so webhook
   * actors of `type: 'api-token'` carrying this id are recognised as our
   * own echoes (Layer 14.4 loop prevention).
   *
   * Attio's `/v2/self` is OAuth-introspection-shaped. The token id is the
   * documented `token` field per https://developer.attio.com/reference/identify;
   * accept a couple of likely shapes to stay resilient to drift. Returns
   * `null` when none of the recognised fields are present — the framework
   * falls through to Layer 14.2 (circuit breaker) in that case.
   */
  async identifyApiTokenId(): Promise<string | null> {
    const response = await this.fetch({
      route: '/v2/self',
      method: 'GET',
      responseValidator: z
        .object({
          token: z.union([z.string(), z.object({ id: z.string() })]).optional(),
          id: z.string().optional(),
        })
        .passthrough(),
    });

    if (typeof response.token === 'string') return response.token;
    if (typeof response.token === 'object' && response.token !== null) {
      return response.token.id;
    }
    if (typeof response.id === 'string') return response.id;
    return null;
  }

  async listObjects(): Promise<{ id: string; name: string; slug: string | null }[]> {
    const objects = await this.fetch({
      route: '/v2/objects',
      method: 'GET',
      responseValidator: z.object({
        data: z.array(objectValidator),
      }),
    });

    return objects.data
      .map((object) => {
        const name = object.plural_noun ?? object.singular_noun;
        if (!name) {
          return null;
        }

        return {
          id: object.id.object_id,
          name,
          slug: object.api_slug,
        };
      })
      .filter(notNull);
  }

  async listAttributeOptions({
    objectId,
    listId,
    attributeId,
  }: {
    objectId?: string;
    listId?: string;
    attributeId: string;
  }): Promise<{ id: string; name: string }[]> {
    const options = await this.fetch({
      route: `/v2/${objectId ? 'objects' : 'lists'}/${objectId || listId}/attributes/${attributeId}/options`,
      method: 'GET',
      responseValidator: z.object({
        data: z.array(optionValidator),
      }),
    });

    return options.data
      .filter((option) => !option.is_archived)
      .map((option) => ({ id: option.id.option_id, name: option.title }));
  }

  /**
   * Every attribute on an object or list, paged to the end.
   *
   * Attio's `limit` default is unspecified, so this pages explicitly rather
   * than trusting the server's: an unpaginated call returned only the first
   * page, and an attribute past that boundary was invisible to the schema
   * with no error to explain it.
   */
  async listAttributes({
    objectId,
    listId,
  }: {
    objectId?: string;
    listId?: string;
  }): Promise<AttioAttribute[]> {
    const route = `/v2/${objectId ? 'objects' : 'lists'}/${objectId || listId}/attributes`;
    const raw: z.infer<typeof attributeValidator>[] = [];
    for (let offset = 0; ; offset += ATTIO_ATTRIBUTE_PAGE_SIZE) {
      const page = await this.fetch({
        route,
        method: 'GET',
        query: { limit: String(ATTIO_ATTRIBUTE_PAGE_SIZE), offset: String(offset) },
        responseValidator: z.object({
          data: z.array(attributeValidator),
        }),
      });
      raw.push(...page.data);
      if (page.data.length < ATTIO_ATTRIBUTE_PAGE_SIZE) break;
      if (offset >= ATTIO_ATTRIBUTE_MAX_OFFSET) {
        logger.warn(`Attio attribute pagination hit its cap at ${route}`, {
          route,
          fetched: raw.length,
        });
        break;
      }
    }

    // An attribute type we don't map still becomes a (string) field — but say
    // so, or a new Attio type degrades silently and we never learn it exists.
    const unknownTypes = [
      ...new Set(
        raw
          .map((attribute) => attribute.type)
          .filter((type) => !(KNOWN_ATTIO_ATTRIBUTE_TYPES as readonly string[]).includes(type)),
      ),
    ];
    if (unknownTypes.length > 0) {
      logger.warn(`Attio returned unrecognised attribute type(s): ${unknownTypes.join(', ')}`, {
        route,
        unknownTypes,
      });
    }

    return raw.map((attribute) => ({
      id: attribute.id.attribute_id,
      name: attribute.title,
      description: attribute.description,
      type: attribute.type,
      isMulti: attribute.is_multiselect,
      relationshipAttributeId: attribute.relationship?.id?.attribute_id,
      relationshipObjectId: attribute.relationship?.id?.object_id,
      allowedObjectIds: attribute.config.record_reference?.allowed_object_ids ?? undefined,
      isRequired: attribute.is_required,
      isUnique: attribute.is_unique,
      isWritable: attribute.is_writable,
      apiSlug: attribute.api_slug,
    }));
  }

  async listRecordEntries({ objectId, recordId }: { objectId: string; recordId: string }) {
    const results = await this.fetch({
      route: `/v2/objects/${objectId}/records/${recordId}/entries`,
      method: 'GET',
      responseValidator: z.object({
        data: z.array(
          z.object({
            list_id: z.string(),
            entry_id: z.string(),
            created_at: z.string(),
          }),
        ),
      }),
    });

    return results.data.map((record) => ({
      listId: record.list_id,
      entryId: record.entry_id,
      createdAt: record.created_at,
    }));
  }

  buildFilter(filters: Record<string, unknown>) {
    const baseFilter: Record<string, unknown> = {};
    const orFilters: Record<string, unknown>[] = [];
    const additionalFilters: Record<string, unknown>[] = [];
    for (const [key, value] of Object.entries(filters)) {
      if (key.startsWith('$')) {
        additionalFilters.push({ [key]: value });
      } else if (Array.isArray(value)) {
        orFilters.push({ $or: value.map((v) => ({ [key]: v })) });
      } else {
        baseFilter[key] = value;
      }
    }

    const andEntries = [
      Object.keys(baseFilter).length ? baseFilter : null,
      ...orFilters,
      ...additionalFilters,
    ].filter(notNull);

    const filter =
      andEntries.length === 1
        ? andEntries[0]
        : andEntries.length
          ? {
              $and: andEntries,
            }
          : {};

    return filter;
  }

  async filterRecords({
    objectId,
    filters,
  }: {
    objectId: string;
    filters: Record<string, unknown>;
  }) {
    const filter = this.buildFilter(filters);

    const results = await this.fetch({
      route: `/v2/objects/${objectId}/records/query`,
      method: 'POST',
      body: {
        filter,
        limit: 5,
      },
      responseValidator: z.object({
        data: z.array(recordValidator),
      }),
    });

    return results.data.map((record) => ({
      id: record.id.record_id,
    }));
  }

  async filterListEntries({
    listId,
    filters,
  }: {
    listId: string;
    filters: Record<string, unknown>;
  }) {
    const filter = this.buildFilter(filters);

    const results = await this.fetch({
      route: `/v2/lists/${listId}/entries/query`,
      method: 'POST',
      body: {
        filter,
        limit: 5,
      },
      responseValidator: z.object({
        data: z.array(listEntryValidator),
      }),
    });

    return results.data.map((record) => ({
      entryId: record.id.entry_id,
      listId: record.id.list_id,
    }));
  }

  async searchRecords({
    objectId,
    query,
  }: {
    objectId: string;
    query: string;
  }): Promise<{ id: string; text: string }[]> {
    try {
      const results = await this.fetch({
        route: `/v2/objects/records/search`,
        method: 'POST',
        body: {
          query,
          objects: [objectId],
          limit: 5,
          request_as: { type: 'workspace' },
        },
        responseValidator: z.object({
          data: z.array(searchValidator),
        }),
      });

      return results.data.map((result) => ({
        id: result.id.record_id,
        text: result.record_text,
      }));
    } catch (e) {
      // Attio seems to return 404 when there are no hits
      logger.error(e);
      return [];
    }
  }

  async getRecord({ objectId, recordId }: { objectId: string; recordId: string }) {
    const record = await this.fetch({
      route: `/v2/objects/${objectId}/records/${recordId}`,
      method: 'GET',
      responseValidator: z.object({
        data: recordValidator,
      }),
    });

    return record.data;
  }

  async getListEntry({ listId, entryId }: { listId: string; entryId: string }) {
    const record = await this.fetch({
      route: `/v2/lists/${listId}/entries/${entryId}`,
      method: 'GET',
      responseValidator: z.object({
        data: listEntryValidator,
      }),
    });

    return {
      ...record.data,
      values: record.data.entry_values,
    };
  }

  /**
   * Page through the workspace's tasks. `GET /v2/tasks` takes no required
   * filters (verified against Attio's OpenAPI spec), so tasks ARE
   * root-enumerable — this backs the `Task` root collection read. The
   * OPTIONAL `linked_object` + `linked_record_id` filters scope the same
   * endpoint to one record's tasks — that backs `record-[:Tasks]->`.
   */
  async listTasksPage({
    limit,
    offset,
    linkedObject,
    linkedRecordId,
  }: {
    limit: number;
    offset: number;
    linkedObject?: string;
    linkedRecordId?: string;
  }) {
    const response = await this.fetch({
      route: '/v2/tasks',
      method: 'GET',
      query: {
        limit: String(limit),
        offset: String(offset),
        ...(linkedObject !== undefined ? { linked_object: linkedObject } : {}),
        ...(linkedRecordId !== undefined ? { linked_record_id: linkedRecordId } : {}),
      },
      responseValidator: z.object({
        data: z.array(fullTaskValidator),
      }),
    });
    return response.data;
  }

  /**
   * Page through the workspace's notes. `GET /v2/notes` without
   * `parent_object` / `parent_record_id` enumerates every note (both params
   * are optional per Attio's OpenAPI spec; page cap is 50) — this backs the
   * `Note` root collection read. With both filters it enumerates ONE
   * record's notes — that backs `record-[:Notes]->`.
   */
  async listNotesPage({
    limit,
    offset,
    parentObject,
    parentRecordId,
  }: {
    limit: number;
    offset: number;
    parentObject?: string;
    parentRecordId?: string;
  }) {
    const response = await this.fetch({
      route: '/v2/notes',
      method: 'GET',
      query: {
        limit: String(limit),
        offset: String(offset),
        ...(parentObject !== undefined ? { parent_object: parentObject } : {}),
        ...(parentRecordId !== undefined ? { parent_record_id: parentRecordId } : {}),
      },
      responseValidator: z.object({
        data: z.array(fullNoteValidator),
      }),
    });
    return response.data;
  }

  /**
   * Page through the comment threads on a record or list entry —
   * `GET /v2/threads`, scoped by `record_id`+`object` OR `entry_id`+`list`
   * (the only scopes the endpoint documents; there is no workspace-wide
   * thread enumeration in practice for our surface). Each thread carries its
   * comments INLINE (`thread.comments`, sorted by `created_at`) — Attio has
   * no list-comments endpoint, so this is THE read behind
   * `record-[:Comments]->`. Page cap is 50 per the OpenAPI spec.
   */
  async listThreadsPage(input: {
    limit: number;
    offset: number;
    recordId?: string;
    object?: string;
    entryId?: string;
    list?: string;
  }) {
    const response = await this.fetch({
      route: '/v2/threads',
      method: 'GET',
      query: {
        limit: String(input.limit),
        offset: String(input.offset),
        ...(input.recordId !== undefined ? { record_id: input.recordId } : {}),
        ...(input.object !== undefined ? { object: input.object } : {}),
        ...(input.entryId !== undefined ? { entry_id: input.entryId } : {}),
        ...(input.list !== undefined ? { list: input.list } : {}),
      },
      responseValidator: z.object({
        data: z.array(threadValidator),
      }),
    });
    return response.data;
  }

  /**
   * One page of a record's files — `GET /v2/files`, whose `object` +
   * `record_id` params are REQUIRED (verified against the OpenAPI spec: a
   * file exists only on its record, which is why the `Attio File` root is
   * write-only). Cursor-paged. The response mixes files with folders and
   * connected drive items; only `file_type === "file"` rows are Attio-native
   * binaries the download endpoint can stream, so the rest are dropped here.
   */
  async listFilesPage({
    object,
    recordId,
    cursor,
  }: {
    object: string;
    recordId: string;
    cursor?: string;
  }) {
    const response = await this.fetch({
      route: '/v2/files',
      method: 'GET',
      query: {
        object,
        record_id: recordId,
        ...(cursor !== undefined ? { cursor } : {}),
      },
      responseValidator: z.object({
        data: z.array(z.unknown()),
        pagination: z.object({ next_cursor: z.string().nullable() }),
      }),
    });
    const files = response.data.flatMap((row) => {
      const parsed = fileListRowValidator.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
    return { files, nextCursor: response.pagination.next_cursor };
  }

  async getTask({ taskId }: { taskId: string }) {
    const response = await this.fetch({
      route: `/v2/tasks/${taskId}`,
      method: 'GET',
      responseValidator: z.object({
        data: fullTaskValidator,
      }),
    });
    return response.data;
  }

  async getNote({ noteId }: { noteId: string }) {
    const response = await this.fetch({
      route: `/v2/notes/${noteId}`,
      method: 'GET',
      responseValidator: z.object({
        data: fullNoteValidator,
      }),
    });
    return response.data;
  }

  async getComment({ commentId }: { commentId: string }) {
    const response = await this.fetch({
      route: `/v2/comments/${commentId}`,
      method: 'GET',
      responseValidator: z.object({
        data: fullCommentValidator,
      }),
    });
    return response.data;
  }

  async updateRecord({
    objectId,
    recordId,
    fields,
  }: {
    objectId: string;
    recordId: string;
    fields: Record<string, unknown>;
  }) {
    const response = await this.fetch({
      route: `/v2/objects/${objectId}/records/${recordId}`,
      method: 'PATCH',
      body: {
        data: {
          values: omitNullish(fields),
        },
      },
      responseValidator: z.object({
        data: recordValidator,
      }),
      customRetryHandler: createFieldValidationRetryHandler<RecordBody>({
        context: `updateRecord(objectId=${objectId}, recordId=${recordId})`,
        getFields: (body) => body.data.values,
        setFields: (body, fields) => ({ data: { values: fields } }),
        lookupApiSlug: (attributeId) => this.lookupApiSlugForAttribute({ objectId, attributeId }),
      }),
    });
    return response.data;
  }

  async deleteRecord({ objectId, recordId }: { objectId: string; recordId: string }) {
    await this.fetch({
      route: `/v2/objects/${objectId}/records/${recordId}`,
      method: 'DELETE',
    });
  }

  async createRecord({ objectId, fields }: { objectId: string; fields: Record<string, unknown> }) {
    const response = await this.fetch({
      route: `/v2/objects/${objectId}/records`,
      method: 'POST',
      body: {
        data: {
          values: omitNullish(fields),
        },
      },
      responseValidator: z.object({
        data: recordValidator,
      }),
      customRetryHandler: createFieldValidationRetryHandler<RecordBody>({
        context: `createRecord(objectId=${objectId})`,
        getFields: (body) => body.data.values,
        setFields: (body, fields) => ({ data: { values: fields } }),
        lookupApiSlug: (attributeId) => this.lookupApiSlugForAttribute({ objectId, attributeId }),
      }),
    });

    return response.data;
  }

  /**
   * Page through all records of an object type. Used by the translation-graph
   * snapshot driver to enumerate records for backfill.
   *
   * Attio's `POST /v2/objects/{objectId}/records/query` accepts `limit` and
   * `offset`; we ask for the max page size and let the caller iterate until
   * a short page is returned.
   */
  async queryRecordsPage({
    objectId,
    limit,
    offset,
  }: {
    objectId: string;
    limit: number;
    offset: number;
  }): Promise<AttioRecord[]> {
    const results = await this.fetch({
      route: `/v2/objects/${objectId}/records/query`,
      method: 'POST',
      body: { limit, offset },
      responseValidator: z.object({
        data: z.array(recordValidator),
      }),
    });
    return results.data;
  }

  /**
   * Filter-driven record query. `filter` is the raw Attio query-API filter
   * body (`{attr: {$eq: value}, ...}` for AND, `{$or: [...]}` for OR).
   * Used by the translation-graph adapter's `resolveEntity` to find an
   * existing record matching a uniqueness constraint set. Bounded `limit`
   * because callers consume one record (single-match resolution) or
   * detect ambiguity (>1 result → don't merge).
   */
  async queryRecordsWithFilter({
    objectId,
    filter,
    limit,
    offset,
  }: {
    objectId: string;
    filter: unknown;
    limit: number;
    /** Page offset — set when paginating a filtered snapshot (chunk 7). */
    offset?: number;
  }): Promise<AttioRecord[]> {
    const results = await this.fetch({
      route: `/v2/objects/${objectId}/records/query`,
      method: 'POST',
      body: { filter, limit, ...(offset !== undefined ? { offset } : {}) },
      responseValidator: z.object({
        data: z.array(recordValidator),
      }),
    });
    return results.data;
  }

  /**
   * Page through all entries of a list. Each entry carries the parent record
   * reference (`parent_record_id` + `parent_object`) so callers can fetch the
   * full record to feed downstream work.
   */
  async queryListEntriesPage({
    listId,
    limit,
    offset,
  }: {
    listId: string;
    limit: number;
    offset: number;
  }): Promise<{
    entryId: string;
    parentRecordId: string | null;
    parentObjectId: string | null;
    entryValues: Record<string, unknown>;
    createdAt: string | null;
  }[]> {
    const results = await this.fetch({
      route: `/v2/lists/${listId}/entries/query`,
      method: 'POST',
      body: { limit, offset },
      responseValidator: z.object({
        data: z.array(listEntryValidator),
      }),
    });
    return results.data.map((entry) => ({
      entryId: entry.id.entry_id,
      parentRecordId: entry.parent_record_id ?? null,
      parentObjectId: entry.parent_object ?? null,
      entryValues: entry.entry_values,
      createdAt: entry.created_at ?? null,
    }));
  }

  /**
   * Fetch the entries that belong to a record in a list. Each entry
   * carries its full `entry_values` so downstream traversal can read
   * the list-specific attributes (Stage, Owner, etc.). One page only
   * — the per-record entry count is small in practice and we prefer
   * a small bounded fetch over silent pagination.
   */
  async queryListEntriesForRecord({
    listId,
    recordId,
    limit = 50,
  }: {
    listId: string;
    recordId: string;
    limit?: number;
  }): Promise<{ entryId: string; parentRecordId: string; parentObject: string | null; entryValues: Record<string, unknown> }[]> {
    const response = await this.fetch({
      route: `/v2/lists/${listId}/entries/query`,
      method: 'POST',
      body: {
        filter: { parent_record_id: { '$eq': recordId } },
        limit,
      },
      responseValidator: z.object({
        data: z.array(listEntryValidator),
      }),
    });
    return response.data.map((entry) => ({
      entryId: entry.id.entry_id,
      parentRecordId: entry.parent_record_id ?? recordId,
      parentObject: entry.parent_object ?? null,
      entryValues: entry.entry_values,
    }));
  }

  /**
   * Create a new list entry attaching a record to a list. Used by the
   * TG adapter when an action of a per-list synthetic type fires as a
   * child of a record action — `parentRecordId` comes from the parent
   * action's externalId; `entryValues` from the action's mapped fields.
   */
  async createListEntry({
    listId,
    parentObjectId,
    parentRecordId,
    entryValues,
  }: {
    listId: string;
    parentObjectId: string;
    parentRecordId: string;
    entryValues: Record<string, unknown>;
  }): Promise<{ entryId: string }> {
    const response = await this.fetch({
      route: `/v2/lists/${listId}/entries`,
      method: 'POST',
      body: {
        data: {
          parent_object: parentObjectId,
          parent_record_id: parentRecordId,
          entry_values: omitNullish(entryValues),
        },
      },
      responseValidator: z.object({
        data: listEntryValidator,
      }),
    });
    return { entryId: response.data.id.entry_id };
  }

  /**
   * Probe whether a record is a member of a list. One small query against
   * the list's entries endpoint, filtered by parent_record_id; returns
   * true on first match. Used by the translation-graph adapter to resolve
   * the synthetic `__list_membership` edge when traversing record → lists.
   */
  async isRecordInList({
    listId,
    recordId,
  }: {
    listId: string;
    recordId: string;
  }): Promise<boolean> {
    try {
      const response = await this.fetch({
        route: `/v2/lists/${listId}/entries/query`,
        method: 'POST',
        body: {
          filter: { parent_record_id: { '$eq': recordId } },
          limit: 1,
        },
        responseValidator: z.object({
          data: z.array(z.unknown()),
        }),
      });
      return response.data.length > 0;
    } catch {
      return false;
    }
  }

  async listStatuses({
    objectId,
    listId,
    attributeId,
  }: {
    objectId?: string;
    listId?: string;
    attributeId: string;
  }) {
    const response = await this.fetch({
      route: `/v2/${objectId ? 'objects' : 'lists'}/${objectId || listId}/attributes/${attributeId}/statuses`,
      method: 'GET',
      responseValidator: z.object({
        data: z.array(statusValidator),
      }),
    });

    return response.data
      .filter((status) => !status.is_archived)
      .map((status) => ({ id: status.id.status_id, name: status.title }));
  }

  async addRecordToList({
    recordId,
    listId,
    objectId,
    fields,
  }: {
    recordId: string;
    listId: string;
    objectId: string;
    fields: Record<string, unknown>;
  }) {
    const response = await this.fetch({
      route: `/v2/lists/${listId}/entries`,
      method: 'POST',
      body: {
        data: {
          parent_record_id: recordId,
          parent_object: objectId,
          entry_values: omitNullish(fields),
        },
      },
      responseValidator: z.object({
        data: z.object({
          id: z.object({
            workspace_id: z.string(),
            list_id: z.string(),
            entry_id: z.string(),
          }),
        }),
      }),
      customRetryHandler: createFieldValidationRetryHandler<ListEntryBody>({
        context: `addRecordToList(listId=${listId}, recordId=${recordId})`,
        getFields: (body) => body.data.entry_values,
        setFields: (body, fields) => ({
          data: {
            ...body.data,
            entry_values: fields,
          },
        }),
        lookupApiSlug: (attributeId) => this.lookupApiSlugForAttribute({ listId, attributeId }),
      }),
    });

    return response.data.id.entry_id;
  }

  async updateListEntry({
    entryId,
    listId,
    fields,
  }: {
    entryId: string;
    listId: string;
    fields: Record<string, unknown>;
  }) {
    const response = await this.fetch({
      route: `/v2/lists/${listId}/entries/${entryId}`,
      method: 'PATCH',
      body: {
        data: {
          entry_values: omitNullish(fields),
        },
      },
      responseValidator: z.object({
        data: listEntryValidator,
      }),
      customRetryHandler: createFieldValidationRetryHandler<ListEntryBody>({
        context: `updateListEntry(listId=${listId}, entryId=${entryId})`,
        getFields: (body) => body.data.entry_values,
        setFields: (body, fields) => ({ data: { entry_values: fields } }),
        lookupApiSlug: (attributeId) => this.lookupApiSlugForAttribute({ listId, attributeId }),
      }),
    });

    return response.data;
  }

  async listWorkspaceMembers() {
    const response = await this.fetch({
      route: '/v2/workspace_members',
      method: 'GET',
      responseValidator: z.object({
        data: z.array(
          z.object({
            id: z.object({
              workspace_id: z.string(),
              workspace_member_id: z.string(),
            }),
            first_name: z.string(),
            last_name: z.string(),
            email_address: z.string(),
          }),
        ),
      }),
    });

    return response.data.map((member) => ({
      id: member.id.workspace_member_id,
      firstName: member.first_name,
      lastName: member.last_name,
      email: member.email_address,
    }));
  }

  async createNote({
    parentObject,
    parentRecordId,
    title,
    content,
    format,
  }: {
    parentObject: string;
    parentRecordId: string;
    title: string;
    content: string;
    format: 'markdown' | 'plaintext';
  }) {
    const response = await this.fetch({
      route: '/v2/notes',
      method: 'POST',
      body: {
        data: {
          parent_object: parentObject,
          parent_record_id: parentRecordId,
          title,
          content,
          format,
        },
      },
      responseValidator: z.object({
        data: noteValidator,
      }),
    });

    return response.data;
  }

  async createTask({
    content,
    assignees,
    linkedRecords,
    deadlineAt,
  }: {
    content: string;
    assignees: { workspaceMemberId: string }[];
    linkedRecords: { targetObject: string; targetRecordId: string }[];
    deadlineAt?: string | null;
  }) {
    const response = await this.fetch({
      route: '/v2/tasks',
      method: 'POST',
      body: {
        data: {
          content,
          format: 'plaintext',
          deadline_at: deadlineAt ?? null,
          is_completed: false,
          assignees: assignees.map((a) => ({
            referenced_actor_type: 'workspace-member',
            referenced_actor_id: a.workspaceMemberId,
          })),
          linked_records: linkedRecords.map((r) => ({
            target_object: r.targetObject,
            target_record_id: r.targetRecordId,
          })),
        },
      },
      responseValidator: z.object({
        data: z.object({
          id: z.object({
            workspace_id: z.string(),
            task_id: z.string(),
          }),
        }),
      }),
    });

    return response.data;
  }

  /**
   * POST /v2/comments. Attio requires an author (a workspace member) on every
   * comment. Target is EITHER an existing thread (`threadId` — a reply) or a
   * record (`record` — starts a new thread on it); exactly one must be given.
   */
  async createComment({
    content,
    authorWorkspaceMemberId,
    record,
    threadId,
  }: {
    content: string;
    authorWorkspaceMemberId: string;
    record?: { object: string; recordId: string };
    threadId?: string;
  }) {
    const response = await this.fetch({
      route: '/v2/comments',
      method: 'POST',
      body: {
        data: {
          format: 'plaintext',
          content,
          author: { type: 'workspace-member', id: authorWorkspaceMemberId },
          ...(threadId
            ? { thread_id: threadId }
            : record
              ? { record: { object: record.object, record_id: record.recordId } }
              : {}),
        },
      },
      responseValidator: z.object({
        data: fullCommentValidator,
      }),
    });

    return response.data;
  }

  // -- File management --

  /**
   * Every file name currently on a record, across all pages of `listFilesPage`.
   * Backs `uploadFile`'s conflict resolution — listing once tells us the exact
   * free `(N)` to use instead of re-uploading the file's bytes over and over
   * just to probe names.
   */
  private async listAllFileNames({
    objectSlug,
    recordId,
  }: {
    objectSlug: string;
    recordId: string;
  }): Promise<Set<string>> {
    const names = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const { files, nextCursor } = await this.listFilesPage({ object: objectSlug, recordId, cursor });
      for (const f of files) {
        if (f.name) names.add(f.name);
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return names;
  }

  async uploadFile({
    file,
    fileName,
    objectSlug,
    recordId,
  }: {
    file: ReadableStream | NodeJS.ReadableStream | Blob;
    fileName: string;
    objectSlug: string;
    recordId: string;
  }) {
    let blob: Blob;
    if (file instanceof Blob) {
      blob = file;
    } else {
      // Convert Node.js readable stream to a Blob once, up front — a stream
      // can only be read once, so the name-conflict retry below must reuse
      // this rather than re-consuming the source.
      const chunks: Uint8Array[] = [];
      for await (const chunk of file as AsyncIterable<Uint8Array>) {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
      }
      blob = new Blob(chunks);
    }

    const upload = (name: string) => {
      const formData = new FormData();
      formData.append('file', blob, name);
      formData.append('object', objectSlug);
      formData.append('record_id', recordId);
      return this.fetch({
        route: '/v2/files/upload',
        method: 'POST',
        formData,
        responseValidator: z.object({
          data: z.object({
            id: z.object({
              workspace_id: z.string(),
              file_id: z.string(),
            }),
            name: z.string(),
            content_type: z.string().nullable(),
            content_size: z.number().nullable(),
          }),
        }),
      });
    };

    // Attio scopes file names uniquely per record, so a re-run of an
    // already-uploaded movement (or two runs racing) collides on the exact
    // same name. Rather than probing suffixes blind, the FIRST conflict lists
    // the record's existing files and jumps straight to the lowest free `(N)`;
    // a conflict on that computed name (a concurrent upload winning the race)
    // just bumps past it and retries.
    let candidateName = fileName;
    let existingNames: Set<string> | null = null;
    let nextN = 1;

    for (let attempt = 1; ; attempt++) {
      try {
        const response = await upload(candidateName);
        return {
          fileId: response.data.id.file_id,
          name: response.data.name,
          contentType: response.data.content_type,
          contentSize: response.data.content_size,
        };
      } catch (e) {
        if (!(e instanceof Error) || !isUploadUniquenessConflict(e) || attempt >= MAX_UPLOAD_ATTEMPTS) {
          throw e;
        }

        if (existingNames) {
          nextN++;
        } else {
          existingNames = await this.listAllFileNames({ objectSlug, recordId });
          while (existingNames.has(suffixFileName(fileName, nextN))) nextN++;
        }
        candidateName = suffixFileName(fileName, nextN);
      }
    }
  }

  /**
   * Download a file's bytes by id. `GET /v2/files/{file_id}/download` returns
   * a 302 redirect to a short-lived signed URL; `fetch` follows it
   * automatically (default redirect mode), so the response body carries the
   * raw bytes. We bypass `this.fetch` here because that path expects a JSON
   * body — this one is binary. Auth is the same Bearer token the upload path
   * uses, so the read side (`AttioAdapter.resolveFileRef`, redeeming a file
   * descriptor) fetches with the write side's credential.
   *
   * Returns a Web `ReadableStream` of the bytes plus the resolved content type
   * (the signed-URL host sets it). Throws on a non-2xx so a file the author
   * mapped that can't be downloaded surfaces as a loud failure, not a silent
   * empty.
   */
  async downloadFile({
    fileId,
  }: {
    fileId: string;
  }): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string | null }> {
    const response = await fetch(new URL(`${this.baseUrl}/v2/files/${fileId}/download`), {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + this.accessToken },
    });
    if (response.status >= 400 || !response.body) {
      let text: string | undefined;
      try {
        text = await response.text();
      } catch {
        // ignore
      }
      throw new Error(
        `Attio file download failed: GET /v2/files/${fileId}/download → ${response.status} (${response.statusText})${text ? `: ${text}` : ''}`,
      );
    }
    return {
      stream: response.body,
      contentType: response.headers.get('content-type'),
    };
  }

  // -- Webhook management --

  async createWebhook(options: {
    targetUrl: string;
    subscriptions: { event_type: string; filter?: Record<string, unknown> | null }[];
  }) {
    const response = await this.fetch({
      route: '/v2/webhooks',
      method: 'POST',
      body: {
        data: {
          target_url: options.targetUrl,
          subscriptions: options.subscriptions,
        },
      },
      responseValidator: z.object({
        data: z.object({
          id: z.object({
            workspace_id: z.string(),
            webhook_id: z.string(),
          }),
          status: z.string(),
          secret: z.string(),
        }),
      }),
    });

    return {
      webhookId: response.data.id.webhook_id,
      workspaceId: response.data.id.workspace_id,
      secret: response.data.secret,
      status: response.data.status,
    };
  }

  /** PATCH /v2/webhooks/{webhook_id} — update an existing webhook's event
   *  subscriptions (and/or target URL) in place. The response carries the
   *  webhook object WITHOUT its secret (Attio only issues that at
   *  creation), so callers keep the stored one. */
  async updateWebhook(options: {
    webhookId: string;
    targetUrl?: string;
    subscriptions?: { event_type: string; filter?: Record<string, unknown> | null }[];
  }) {
    const response = await this.fetch({
      route: `/v2/webhooks/${options.webhookId}`,
      method: 'PATCH',
      body: {
        data: {
          ...(options.targetUrl !== undefined ? { target_url: options.targetUrl } : {}),
          ...(options.subscriptions !== undefined
            ? { subscriptions: options.subscriptions }
            : {}),
        },
      },
      responseValidator: z.object({
        data: z
          .object({
            id: z.object({ workspace_id: z.string(), webhook_id: z.string() }),
            status: z.string(),
          })
          .passthrough(),
      }),
    });
    return {
      webhookId: response.data.id.webhook_id,
      status: response.data.status,
    };
  }

  async deleteWebhook(webhookId: string) {
    await this.fetch({
      route: `/v2/webhooks/${webhookId}`,
      method: 'DELETE',
      body: undefined,
      responseValidator: z.object({}).passthrough(),
    });
  }
}

const clientsByAccessToken: Record<string, AttioAPIClient> = {};

const getAttioClient = (accessToken: string, baseUrl?: string): AttioAPIClient => {
  const cacheKey = baseUrl ? `${accessToken}:${baseUrl}` : accessToken;
  if (!clientsByAccessToken[cacheKey]) {
    clientsByAccessToken[cacheKey] = new AttioAPIClient({ accessToken, baseUrl });
  }

  return clientsByAccessToken[cacheKey];
};
export {
  AttioAPIClient,
  attioCredsParser,
  getAttioClient,
  attioAttributeTypeValidator,
  AttioRecord,
  AttioListEntry,
};
