// Gmail HTTP transport — the one owner of the wire shape for the adapter and
// its poll.
//
// The mailbox is reached one of two ways, and the credential says which:
//
//   OAUTH — somebody signed in as the mailbox; the token is that sign-in's,
//     and the scopes Google granted ride beside it. Google confines the token
//     to that one address.
//   DELEGATED — the host's service account acts as the address, granted once
//     by a Workspace admin. The host mints a token per scope, so a grant that
//     covers reads but not sends fails only the send.
//
// The client holds only the tokens its caller hands it, per call, never a
// refresh token: whoever hands them over keeps them fresh (the module's host,
// or the platform's own token clients for the platform's other callers).
// googleapis builds every request; gaxios sends it through the caller's fetch
// (its `fetchImplementation`), not through anything else.
//
// Every reply is parsed here with zod. The googleapis client types its responses
// as "every field optional", which is a claim about the SDK's surface rather
// than about what Gmail sent — so the schemas below are what the rest of the
// module trusts, and an unparseable reply fails loudly at the boundary instead
// of reading as a message with no subject.

import { google, type gmail_v1 } from 'googleapis';
import { z } from 'zod';

/** The two scopes a mailbox is reached through: read and send, nothing else. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE] as const;

/** How a mailbox was connected. */
export const GMAIL_CONNECT_METHODS = ['oauth', 'delegated'] as const;
export type GmailConnectMethod = (typeof GMAIL_CONNECT_METHODS)[number];

/** Which of the two scopes a call needs. */
export type GmailScope = 'read' | 'send';

/** The mailbox's own address in Gmail's paths: "the authenticated user", which
 *  under delegation IS the impersonated mailbox. */
const SELF = 'me';

/** Gmail's ceiling on one `messages.list` page. */
export const GMAIL_MAX_PAGE = 500;

// ── Wire shapes ─────────────────────────────────────────────────────────────

const headerSchema = z.object({
  name: z.string().nullish(),
  value: z.string().nullish(),
});

const partBodySchema = z.object({
  attachmentId: z.string().nullish(),
  size: z.number().nullish(),
  data: z.string().nullish(),
});

/**
 * A MIME part. Gmail nests these arbitrarily deep (a `multipart/mixed` holding
 * a `multipart/alternative` holding the two body alternatives), so the schema is
 * recursive and the decode walks it.
 */
export interface GmailPart {
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  headers?: z.infer<typeof headerSchema>[] | null;
  body?: z.infer<typeof partBodySchema> | null;
  parts?: GmailPart[] | null;
}

export const gmailPartSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    partId: z.string().nullish(),
    mimeType: z.string().nullish(),
    filename: z.string().nullish(),
    headers: z.array(headerSchema).nullish(),
    body: partBodySchema.nullish(),
    parts: z.array(gmailPartSchema).nullish(),
  }),
);

export const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string().nullish(),
  labelIds: z.array(z.string()).nullish(),
  snippet: z.string().nullish(),
  historyId: z.string().nullish(),
  /** Epoch milliseconds, as a string. */
  internalDate: z.string().nullish(),
  sizeEstimate: z.number().nullish(),
  payload: gmailPartSchema.nullish(),
  /** Only on `format: 'raw'` — the whole RFC 822 message, base64url. */
  raw: z.string().nullish(),
});
export type GmailMessage = z.infer<typeof gmailMessageSchema>;

const messageRefSchema = z.object({
  id: z.string(),
  threadId: z.string().nullish(),
});
export type GmailMessageRef = z.infer<typeof messageRefSchema>;

/** A message history reports as added, with the id of the history record that
 *  added it — the point a reader that stops part way through resumes from. */
export type GmailHistoryAddition = GmailMessageRef & { historyId?: string };

const messageListSchema = z.object({
  messages: z.array(messageRefSchema).nullish(),
  nextPageToken: z.string().nullish(),
  resultSizeEstimate: z.number().nullish(),
});

export const gmailProfileSchema = z.object({
  emailAddress: z.string(),
  messagesTotal: z.number().nullish(),
  threadsTotal: z.number().nullish(),
  historyId: z.string(),
});
export type GmailProfile = z.infer<typeof gmailProfileSchema>;

const historyRecordSchema = z.object({
  id: z.string().nullish(),
  messagesAdded: z
    .array(z.object({ message: messageRefSchema.nullish() }))
    .nullish(),
});

const historyListSchema = z.object({
  history: z.array(historyRecordSchema).nullish(),
  nextPageToken: z.string().nullish(),
  historyId: z.string().nullish(),
});

const attachmentSchema = z.object({
  size: z.number().nullish(),
  data: z.string().nullish(),
});

/** What `users.messages.send` hands back — the message as Gmail now holds it,
 *  which is where the REAL id comes from. */
const sentMessageSchema = z.object({
  id: z.string(),
  threadId: z.string().nullish(),
  labelIds: z.array(z.string()).nullish(),
});
export type GmailSentMessage = z.infer<typeof sentMessageSchema>;

// ── Errors ──────────────────────────────────────────────────────────────────

/** Why a Gmail call failed, in the terms the callers actually branch on. */
export type GmailFailure =
  /** The mailbox refused the impersonation — delegation is not granted. */
  | 'delegation'
  /** The token request for `gmail.send` was refused — reads still work, only
   *  the send scope is missing from the grant. */
  | 'missing_send_scope'
  /** Google accepted the impersonation but the address is not a mailbox. */
  | 'no_such_mailbox'
  /** `history.list` was given a marker Gmail has since dropped. */
  | 'history_expired'
  | 'other';

export class GmailApiError extends Error {
  constructor(
    readonly failure: GmailFailure,
    readonly status: number | undefined,
    readonly operation: string,
    detail: string,
  ) {
    super(`Gmail ${operation} failed (${failure}${status ? ` ${status}` : ''}): ${detail}`);
    this.name = 'GmailApiError';
  }
}

/** Read a property off a value that may be anything — the shape of a thrown
 *  error is not something the type system knows. */
function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function statusOf(err: unknown): number | undefined {
  const direct = prop(err, 'status');
  if (typeof direct === 'number') return direct;
  const response = prop(err, 'response');
  const fromResponse = prop(response, 'status');
  return typeof fromResponse === 'number' ? fromResponse : undefined;
}

function messageOf(err: unknown): string {
  const data = prop(prop(err, 'response'), 'data');
  const nested = text(prop(prop(data, 'error'), 'message'));
  if (nested !== '') return nested;
  const description = text(prop(data, 'error_description'));
  if (description !== '') return description;
  return text(prop(err, 'message'));
}

/**
 * Classify a thrown Gmail/auth error.
 *
 * The two connect-time failures are told apart by WHERE they happen: an
 * impersonation Google never agreed to is refused at the token exchange, which
 * the auth library reports as `unauthorized_client`; an address Google is happy
 * to impersonate but that owns no mailbox reaches Gmail and comes back 400/404.
 * That difference is the whole diagnostic a user needs, so it is decided once,
 * here.
 *
 * A token refusal on `users.messages.send` is reported separately
 * (`missing_send_scope`) rather than as `delegation`: each Gmail call asks for
 * exactly the one scope it needs, so a refused SEND token means the grant
 * covers reads but not sends — Google reports it the same way it reports "no
 * delegation at all", and which scope set was being requested is the only
 * signal that tells the two apart.
 */
export function classifyGmailError(err: unknown, operation: string): GmailApiError {
  if (err instanceof GmailApiError) return err;
  const status = statusOf(err);
  const detail = messageOf(err) || String(err);
  const lower = detail.toLowerCase();

  const tokenRefused =
    lower.includes('unauthorized_client') ||
    lower.includes('invalid_grant') ||
    status === 401 ||
    status === 403;
  if (tokenRefused) {
    return operation === 'users.messages.send'
      ? new GmailApiError('missing_send_scope', status, operation, detail)
      : new GmailApiError('delegation', status, operation, detail);
  }
  if (operation === 'history.list' && status === 404) {
    return new GmailApiError('history_expired', status, operation, detail);
  }
  if (status === 400 || status === 404) {
    return new GmailApiError('no_such_mailbox', status, operation, detail);
  }
  return new GmailApiError('other', status, operation, detail);
}

/** What a deployment reads when a send fails because the mailbox holds
 *  `gmail.readonly` and not `gmail.send`. Names the mailbox and the scope, and
 *  says reads are unaffected — the one thing a "send failed" message must not
 *  do here is suggest the mailbox is disconnected. The remedy differs by
 *  method: a sign-in asks for the scope only when the installation enabled
 *  sending, while a delegated grant is the admin's to widen. */
export function gmailMissingSendScopeMessage(
  mailbox: string,
  method: GmailConnectMethod = 'delegated',
): string {
  const head =
    `${mailbox} does not hold ${GMAIL_SEND_SCOPE}, so this mailbox cannot send ` +
    'mail. Reads still work — ';
  switch (method) {
    case 'oauth':
      return (
        head +
        'the sign-in never asked for it. Set GMAIL_SEND_ENABLED=true on this ' +
        'installation and reconnect the mailbox.'
      );
    case 'delegated':
      return (
        head +
        "ask a Workspace admin to add the send scope alongside the read one on " +
        "this deployment's domain wide delegation."
      );
    default:
      return head + String(unreachable(method));
  }
}

function unreachable(value: never): unknown {
  return value;
}

// ── The client ──────────────────────────────────────────────────────────────

/** Whose mailbox a client reaches, and how it was connected. */
export interface GmailMailboxIdentity {
  mailbox: string;
  method: GmailConnectMethod;
  /** OAUTH only: the scopes the sign-in was granted. */
  grantedScopes?: readonly string[];
}

export interface GmailApiClientOptions {
  /** The current access token for one scope, asked for per call. A token the
   *  caller cannot have (a delegated grant without the send scope) is a
   *  rejection: a `GmailApiError` when the caller knows why. */
  accessToken: (scope: GmailScope) => Promise<string>;
  fetch: typeof fetch;
  /** The test-harness redirect (the dev loop's fake): Google's root URL.
   *  googleapis resolves request paths against its ORIGIN, so the fake serves
   *  `/gmail/v1/*` from its root. */
  baseUrl?: string;
}

/** Gmail for ONE mailbox. */
export class GmailApiClient {
  /** One googleapis client per scope, each holding its own scope's token, so
   *  a send never borrows the read token nor a read the send one. */
  private readonly apis: Record<GmailScope, { api: gmail_v1.Gmail; auth: InstanceType<typeof google.auth.OAuth2> }>;

  constructor(
    readonly credentials: GmailMailboxIdentity,
    private readonly options: GmailApiClientOptions,
  ) {
    const build = () => {
      const auth = new google.auth.OAuth2();
      const api = google.gmail({
        version: 'v1',
        auth,
        fetchImplementation: options.fetch,
        ...(options.baseUrl ? { rootUrl: options.baseUrl } : {}),
      });
      return { api, auth };
    };
    this.apis = { read: build(), send: build() };
  }

  /** The api for one scope, holding that scope's current token. */
  private async api(scope: GmailScope): Promise<gmail_v1.Gmail> {
    const { api, auth } = this.apis[scope];
    auth.setCredentials({ access_token: await this.options.accessToken(scope) });
    return api;
  }

  private async call<T>(
    operation: string,
    scope: GmailScope,
    schema: z.ZodType<T>,
    run: (api: gmail_v1.Gmail) => Promise<{ data: unknown }>,
  ): Promise<T> {
    let payload: unknown;
    try {
      payload = (await run(await this.api(scope))).data;
    } catch (err) {
      throw classifyGmailError(err, operation);
    }
    return schema.parse(payload);
  }

  /** Whether this mailbox may send. Under a sign-in the granted scopes say so
   *  outright; under delegation nothing local knows, so the answer is "ask
   *  Google" — which is what the send then does. */
  canSend(): boolean {
    return this.credentials.method === 'oauth'
      ? (this.credentials.grantedScopes ?? []).includes(GMAIL_SEND_SCOPE)
      : true;
  }

  /** The mailbox's own profile — the connect-time proof that the connection
   *  works AND the source of the first poll's change marker. */
  async getProfile(): Promise<GmailProfile> {
    return this.call('users.getProfile', 'read', gmailProfileSchema, (api) => api.users.getProfile({ userId: SELF }));
  }

  /** One page of message ids matching a Gmail search query. */
  async listMessages(input: {
    query?: string;
    labelIds?: readonly string[];
    maxResults?: number;
    pageToken?: string;
    /** Gmail's search leaves Spam and Trash out unless this is set. */
    includeSpamTrash?: boolean;
  }): Promise<{ messages: GmailMessageRef[]; nextPageToken?: string }> {
    const page = await this.call('users.messages.list', 'read', messageListSchema, (api) =>
      api.users.messages.list({
        userId: SELF,
        ...(input.query !== undefined ? { q: input.query } : {}),
        ...(input.labelIds !== undefined ? { labelIds: [...input.labelIds] } : {}),
        ...(input.maxResults !== undefined
          ? { maxResults: Math.min(input.maxResults, GMAIL_MAX_PAGE) }
          : {}),
        ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
        ...(input.includeSpamTrash === true ? { includeSpamTrash: true } : {}),
      }),
    );
    return {
      messages: page.messages ?? [],
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
    };
  }

  /** One message, with its MIME tree. */
  async getMessage(id: string): Promise<GmailMessage> {
    return this.call('users.messages.get', 'read', gmailMessageSchema, (api) =>
      api.users.messages.get({ userId: SELF, id, format: 'full' }),
    );
  }

  /** One message as the raw RFC 822 bytes, base64url — what a forward or an
   *  archive wants, and what the fake serves under `format=raw`. */
  async getRawMessage(id: string): Promise<GmailMessage> {
    return this.call('users.messages.get(raw)', 'read', gmailMessageSchema, (api) =>
      api.users.messages.get({ userId: SELF, id, format: 'raw' }),
    );
  }

  /**
   * The messages added to a label since a change marker.
   *
   * Throws `history_expired` when Gmail has dropped the marker — about a week
   * of inactivity is enough — which the poll answers by resyncing from the last
   * seen time rather than failing forever.
   */
  async listHistory(input: {
    startHistoryId: string;
    labelId?: string;
    pageToken?: string;
  }): Promise<{ added: GmailHistoryAddition[]; nextPageToken?: string; historyId?: string }> {
    const page = await this.call('history.list', 'read', historyListSchema, (api) =>
      api.users.history.list({
        userId: SELF,
        startHistoryId: input.startHistoryId,
        historyTypes: ['messageAdded'],
        ...(input.labelId !== undefined ? { labelId: input.labelId } : {}),
        ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
      }),
    );
    const added: GmailHistoryAddition[] = [];
    for (const record of page.history ?? []) {
      for (const entry of record.messagesAdded ?? []) {
        if (!entry.message) continue;
        added.push({ ...entry.message, ...(record.id ? { historyId: record.id } : {}) });
      }
    }
    return {
      added,
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      ...(page.historyId ? { historyId: page.historyId } : {}),
    };
  }

  /**
   * Send a message as the connected mailbox.
   *
   * The whole message travels as one base64url RFC 2822 blob (`compose.ts`
   * builds it) — Gmail has no field-by-field send. `threadId` is the ONE thing
   * beside the bytes that Gmail decides on: given one, it files the message in
   * that conversation, which is what makes a reply a reply on Gmail's side
   * rather than only in the headers.
   */
  async sendMessage(input: { raw: string; threadId?: string }): Promise<GmailSentMessage> {
    // A sign-in that was never granted the send scope is a fact we already
    // hold, so it is answered here rather than by sending Google a message it
    // will refuse. Google's own refusal stays the backstop — this only moves
    // the failure to where the reason is known.
    if (this.credentials.method === 'oauth' && !this.canSend()) {
      throw new GmailApiError(
        'missing_send_scope',
        undefined,
        'users.messages.send',
        `the sign-in for ${this.credentials.mailbox} granted ` +
          `${(this.credentials.grantedScopes ?? []).join(', ') || 'no scopes'}`,
      );
    }
    return this.call('users.messages.send', 'send', sentMessageSchema, (api) =>
      api.users.messages.send({
        userId: SELF,
        requestBody: {
          raw: input.raw,
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        },
      }),
    );
  }

  /** One attachment's bytes, base64url. Fetched on demand: Gmail serves them
   *  separately from the message, so a movement that never reads a file never
   *  pays for one. */
  async getAttachment(input: { messageId: string; attachmentId: string }): Promise<Buffer> {
    const part = await this.call('users.messages.attachments.get', 'read', attachmentSchema, (api) =>
      api.users.messages.attachments.get({
        userId: SELF,
        messageId: input.messageId,
        id: input.attachmentId,
      }),
    );
    return Buffer.from(part.data ?? '', 'base64url');
  }
}
