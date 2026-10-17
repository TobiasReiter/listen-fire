import { z } from 'zod';
import { backOff } from 'exponential-backoff';

import { logger } from 'movement-engine/public/log';
import { Queue } from 'movement-engine/public/adapter-support';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

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

const TOKEN_REFRESHED = 'TOKEN_REFRESHED';

const airtableCredsParser = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessTokenExpiresAt: z.string().datetime(),
  refreshTokenExpiresAt: z.string().datetime(),
  baseUrl: z.string().url().optional(),
});

const listBasesResponseParser = z.object({
  bases: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
  offset: z.string().optional(),
});

const fieldParser = z.object({
  id: z.string(),
  name: z.string(),
  type: z
    .enum([
      'singleLineText',
      'email',
      'url',
      'multilineText',
      'number',
      'percent',
      'currency',
      'singleSelect',
      'multipleSelects',
      'singleCollaborator',
      'multipleCollaborators',
      'multipleRecordLinks',
      'date',
      'dateTime',
      'phoneNumber',
      'multipleAttachments',
      'checkbox',
      'formula',
      'createdTime',
      'rollup',
      'count',
      'lookup',
      'multipleLookupValues',
      'autoNumber',
      'barcode',
      'rating',
      'richText',
      'duration',
      'lastModifiedTime',
      'button',
      'createdBy',
      'lastModifiedBy',
      'externalSyncSource',
      'aiText',
    ])
    .optional(),
  description: z.string().optional(),
  options: z.unknown().optional(),
});

// TODO: parse out various option types for each field type
const listTablesResponseParser = z.object({
  tables: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      primaryFieldId: z.string(),
      fields: z.array(fieldParser),
      description: z.string().optional(),
    }),
  ),
});

const listRecordsResponseParser = z.object({
  records: z.array(
    z.object({
      id: z.string(),
      fields: z.record(z.string(), z.unknown()),
      createdTime: z.string().datetime(),
    }),
  ),
  offset: z.string().optional(),
});

const recordResponseParser = z.object({
  id: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
  createdTime: z.string().optional(),
});

const deleteRecordResponseParser = z.object({
  id: z.string(),
  deleted: z.boolean(),
});

// ── Webhook management (notify-then-pull source triggers) ───────────────────
// Airtable webhooks are per-BASE and (optionally) scoped to one table via
// `recordChangeScope`. The create call is the ONLY moment `macSecretBase64` is
// returned — it must be persisted immediately or inbound signatures can never
// be verified again.

const createWebhookResponseParser = z.object({
  id: z.string(),
  macSecretBase64: z.string(),
  expirationTime: z.string().optional(),
});

const refreshWebhookResponseParser = z
  .object({ expirationTime: z.string().optional() })
  .passthrough();

// One record change inside a payload. Airtable keys cell values by field ID
// (`fldXXX`), and an UPDATE nests them under `current`; a CREATE carries them
// flat. `passthrough` keeps the shape tolerant of Airtable's optional extras
// (`previous`, `unchanged`, …).
const webhookRecordChangeParser = z
  .object({
    current: z
      .object({ cellValuesByFieldId: z.record(z.string(), z.unknown()).optional() })
      .passthrough()
      .optional(),
    cellValuesByFieldId: z.record(z.string(), z.unknown()).optional(),
    createdTime: z.string().optional(),
  })
  .passthrough();

const webhookPayloadParser = z
  .object({
    timestamp: z.string().optional(),
    actionMetadata: z
      .object({ source: z.string().optional() })
      .passthrough()
      .optional(),
    changedTablesById: z
      .record(
        z.string(),
        z
          .object({
            createdRecordsById: z.record(z.string(), webhookRecordChangeParser).optional(),
            changedRecordsById: z.record(z.string(), webhookRecordChangeParser).optional(),
            destroyedRecordIds: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const listPayloadsResponseParser = z.object({
  payloads: z.array(webhookPayloadParser),
  // The cursor to pass on the NEXT pull to resume past this page.
  cursor: z.number(),
  mightHaveMore: z.boolean(),
});

export type AirtableWebhookPayload = z.infer<typeof webhookPayloadParser>;
export type AirtableListPayloadsResult = z.infer<typeof listPayloadsResponseParser>;

/** Where a client's access token comes from, and who refreshes it: the host
 *  of a module (its credential), or the platform's own pipelines (the row). */
export interface AirtableTokens {
  /** The access token to send now. */
  accessToken(): Promise<string>;
  /** Airtable refused the token: refresh it, so the next call sends a new one. */
  refresh(): Promise<void>;
}

class AirtableAPIClient {
  private readonly tokens: AirtableTokens;
  private baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  private rateLimitQueue = new Queue<unknown>({ concurrency: 4 });

  private refreshPromise: Promise<void> | null = null;
  private refreshedAt: Date | null = null;

  constructor(input: { tokens: AirtableTokens; baseUrl?: string; fetch?: typeof fetch }) {
    this.tokens = input.tokens;
    this.baseUrl = input.baseUrl ?? 'https://api.airtable.com';
    this.fetchImpl = input.fetch ?? fetch;
  }

  private async handleTokenRefresh() {
    if (!this.refreshPromise) {
      logger.info('[AIRTABLE] REFRESHSING CREDS');
      this.refreshedAt = new Date();
      // Otherwise, start a new one
      this.refreshPromise = (async () => {
        try {
          await this.tokens.refresh();
        } catch (e) {
          logger.error(e);
        } finally {
          this.refreshPromise = null; // release the lock
        }
      })();
    }

    await this.refreshPromise;
    logger.info('[AIRTABLE] REFRESH COMPLETED', this.refreshedAt);
  }

  private async fetch<T = unknown, U = unknown>({
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

    logger.info(url.toString());

    return this.rateLimitQueue.enqueue(async () => {
      return backOff(
        async (): Promise<T> => {
          const headers: Record<string, string> = {
            Authorization: 'Bearer ' + (await this.tokens.accessToken()),
          };
          if (body) {
            headers['Content-Type'] = 'application/json';
          }

          const serializedBody = body ? JSON.stringify(body) : formData;
          if (body && (method === 'POST' || method === 'PATCH')) {
            logger.info(`[Airtable] ${method} ${url.pathname} body: ${serializedBody}`);
          }
          const response = await this.fetchImpl(url, {
            method,
            headers,
            body: serializedBody,
          });

          if (response.status === 401) {
            if (
              !this.refreshedAt ||
              Date.now() > this.refreshedAt.getTime() + 5 * MINUTE // Don't spam refresh
            ) {
              await this.handleTokenRefresh();
              throw new Error(TOKEN_REFRESHED);
            }
            if (this.refreshPromise) {
              await this.refreshPromise;
            }
          }

          if (response.status >= 400) {
            logger.info({ status: response.status, refreshedAt: this.refreshedAt });
            let text;
            try {
              text = await response.text();
            } catch {
              // ignore
            }
            throw new Error(`Airtable Error: ${response.status} (${response.statusText}): ${text}`);
          }

          if (responseValidator) {
            const json = await parseJsonResponse(response, 'Airtable');
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
            if (e instanceof Error && e.message === TOKEN_REFRESHED && attempt < RETRY_LIMIT) {
              return true;
            }

            if (e instanceof Error && e.message.includes('429')) {
              // rate limit
              // extra delay to lower the odds of hitting the rate limit again
              logger.info(
                `Hit rate limit, waiting an additional ${RATE_LIMIT_DELAY / SECOND} seconds`,
              );
              await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
            }

            if (attempt < RETRY_LIMIT) {
              logger.info(
                `Retrying Airtable query in ${
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

  async listBases(): Promise<{ id: string; name: string }[]> {
    const { bases } = await this.fetch({
      route: '/v0/meta/bases',
      method: 'GET',
      responseValidator: listBasesResponseParser,
    });

    return bases;
  }

  async listTables({ baseId }: { baseId: string }) {
    const { tables } = await this.fetch({
      route: `/v0/meta/bases/${baseId}/tables`,
      method: 'GET',
      responseValidator: listTablesResponseParser,
    });

    return tables;
  }

  async createRecord({
    baseId,
    tableId,
    fields,
  }: {
    baseId: string;
    tableId: string;
    fields: Record<string, unknown>;
  }) {
    return this.fetch({
      route: `/v0/${baseId}/${tableId}`,
      method: 'POST',
      body: { fields },
      responseValidator: recordResponseParser,
    });
  }

  async updateRecord({
    baseId,
    tableId,
    recordId,
    fields,
  }: {
    baseId: string;
    tableId: string;
    recordId: string;
    fields: Record<string, unknown>;
  }) {
    return this.fetch({
      route: `/v0/${baseId}/${tableId}/${recordId}`,
      method: 'PATCH',
      body: { fields },
      responseValidator: recordResponseParser,
    });
  }

  async getRecord({
    baseId,
    tableId,
    recordId,
  }: {
    baseId: string;
    tableId: string;
    recordId: string;
  }) {
    return this.fetch({
      route: `/v0/${baseId}/${tableId}/${recordId}`,
      method: 'GET',
      responseValidator: recordResponseParser,
    });
  }

  async deleteRecord({
    baseId,
    tableId,
    recordId,
  }: {
    baseId: string;
    tableId: string;
    recordId: string;
  }): Promise<{ id: string; deleted: boolean }> {
    return this.fetch({
      route: `/v0/${baseId}/${tableId}/${recordId}`,
      method: 'DELETE',
      responseValidator: deleteRecordResponseParser,
    });
  }

  async listRecords({
    baseId,
    tableId,
    fieldId,
    filterByFormula,
  }: {
    baseId: string;
    tableId: string;
    fieldId?: string;
    filterByFormula?: string;
  }) {
    let offset: string | undefined = undefined;
    const records = [];
    do {
      const params: Record<string, string> = {};
      if (offset) {
        params.offset = offset;
      }
      if (fieldId) {
        params['fields[]'] = fieldId;
      }
      if (filterByFormula) {
        params.filterByFormula = filterByFormula;
      }

      const result: z.infer<typeof listRecordsResponseParser> = await this.fetch({
        route: `/v0/${baseId}/${tableId}`,
        method: 'GET',
        query: params,
        responseValidator: listRecordsResponseParser,
      });

      records.push(...result.records);
      offset = result.offset;
    } while (offset);

    return records;
  }

  // -- Webhook management --

  /** Register a per-base webhook. `tableId` scopes it to one table via
   *  `recordChangeScope`; `changeTypes` is the Airtable-native selection
   *  (`add` / `update` / `remove`). Always restricts to `tableData` — Listen-Fire
   *  never wants schema/metadata pings (those still cost a pull + a run). The
   *  returned `macSecretBase64` is issued ONCE here; persist it immediately. */
  async createWebhook({
    baseId,
    notificationUrl,
    tableId,
    changeTypes,
  }: {
    baseId: string;
    notificationUrl: string;
    tableId?: string;
    changeTypes: string[];
  }): Promise<{ webhookId: string; macSecretBase64: string; expirationTime?: string }> {
    const filters: Record<string, unknown> = {
      dataTypes: ['tableData'],
      changeTypes,
      ...(tableId ? { recordChangeScope: tableId } : {}),
    };
    const result = await this.fetch({
      route: `/v0/bases/${baseId}/webhooks`,
      method: 'POST',
      body: { notificationUrl, specification: { options: { filters } } },
      responseValidator: createWebhookResponseParser,
    });
    return {
      webhookId: result.id,
      macSecretBase64: result.macSecretBase64,
      ...(result.expirationTime ? { expirationTime: result.expirationTime } : {}),
    };
  }

  async deleteWebhook({ baseId, webhookId }: { baseId: string; webhookId: string }): Promise<void> {
    await this.fetch({
      route: `/v0/bases/${baseId}/webhooks/${webhookId}`,
      method: 'DELETE',
    });
  }

  /** Extend a webhook's life by 7 days (Airtable expires inactive webhooks).
   *  Driven by the refresh worker; returns the new expiration when surfaced. */
  async refreshWebhook({
    baseId,
    webhookId,
  }: {
    baseId: string;
    webhookId: string;
  }): Promise<{ expirationTime?: string }> {
    const result = await this.fetch({
      route: `/v0/bases/${baseId}/webhooks/${webhookId}/refresh`,
      method: 'POST',
      responseValidator: refreshWebhookResponseParser,
    });
    return result.expirationTime ? { expirationTime: result.expirationTime } : {};
  }

  /** Drain a webhook's payload feed from `cursor` (defaults to 1 = from the
   *  beginning). One page per call; the caller loops on `mightHaveMore`,
   *  persisting the returned `cursor` as the resume checkpoint. */
  async listPayloads({
    baseId,
    webhookId,
    cursor,
  }: {
    baseId: string;
    webhookId: string;
    cursor?: number;
  }): Promise<AirtableListPayloadsResult> {
    return this.fetch({
      route: `/v0/bases/${baseId}/webhooks/${webhookId}/payloads`,
      method: 'GET',
      ...(cursor !== undefined ? { query: { cursor: String(cursor) } } : {}),
      responseValidator: listPayloadsResponseParser,
    });
  }
}

export { AirtableAPIClient, airtableCredsParser, fieldParser };
