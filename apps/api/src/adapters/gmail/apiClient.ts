// Gmail HTTP transport — the one owner of the wire shape for the movements
// adapter (services/translation_graph/adapters/gmail) and its poll source.
//
// The mailbox is reached one of two ways, and the stored credential says which
// (see `connect_method.ts` for the choice and `app_id.ts` for how a row is told
// apart without decrypting it):
//
//   OAUTH — somebody signed in as the mailbox, and the credential carries that
//     sign-in's refresh token plus the scopes Google granted. Google confines
//     the token to that one address.
//   DELEGATED — the deployment's service account acts as the address, granted
//     once by a Workspace admin. The credential is then just the address:
//     everything secret lives in the deployment's own environment.
//
// Every reply is parsed here with zod. The googleapis client types its responses
// as "every field optional", which is a claim about the SDK's surface rather
// than about what Gmail sent — so the schemas below are what the rest of the
// package trusts, and an unparseable reply fails loudly at the boundary instead
// of reading as a message with no subject.

import { google, type gmail_v1 } from 'googleapis';
import { z } from 'zod';

import type { GmailConnectMethod } from './connect_method';

import {
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  delegatedGoogleAuth,
  gmailMailboxAllowlist,
  isGoogleServiceAccountConfigured,
} from 'movement-engine/lib/google_cloud';
import { neverAsAny } from 'movement-engine/lib/utils/types';
import {
  GMAIL_REFRESH_TOKEN_REFUSED_MESSAGE,
  GmailRefreshTokenError,
  gmailTokenClient,
  redeemGmailRefreshToken,
  type GmailTokens,
} from './authClient';

/** The scopes a connected mailbox is reached through — read and send, nothing
 *  else. Exported so `describe` can name them without a second spelling. */
export const GMAIL_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE] as const;

/**
 * Each Gmail call asks for exactly the ONE scope it needs, never both
 * together — so a delegation grant that covers reads but not sends (or the
 * reverse) fails only the calls that actually need the missing scope. A
 * single combined-scope token would fail every call the moment either scope
 * were absent, reads included.
 */
const GMAIL_READ_SCOPES = [GMAIL_READONLY_SCOPE] as const;
const GMAIL_SEND_SCOPES = [GMAIL_SEND_SCOPE] as const;

/** The mailbox the delegated client addresses. Gmail's own alias for "the
 *  authenticated user", which under delegation IS the impersonated mailbox. */
const SELF = 'me';

/** Gmail's ceiling on one `messages.list` page. */
export const GMAIL_MAX_PAGE = 500;

/**
 * Stored DELEGATED credential. One field the user typed — the mailbox address —
 * plus the dev loop's injected base URL. No token, because there is none: the
 * deployment's service account is the whole authority, and this row only names
 * whose mail it acts on.
 */
export const gmailDelegatedCredsParser = z.object({
  mailbox: z.string().email(),
  baseUrl: z.string().url().optional(),
});
export type GmailDelegatedCredentials = z.infer<typeof gmailDelegatedCredsParser>;

/**
 * Stored OAUTH credential — the sign-in's tokens, the address that signed in
 * (read from `users.getProfile` at connect time, never typed), and the scopes
 * Google said it granted.
 *
 * The granted scopes are stored because they are the only way to know a send
 * will be refused BEFORE asking Google to send. Google is still the authority,
 * and the classification of a refused call stays the backstop — but a message
 * that was never going to leave should fail saying so, not after a round trip.
 */
export const gmailOAuthCredsParser = z.object({
  mailbox: z.string().email(),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  grantedScopes: z.array(z.string()),
  baseUrl: z.string().url().optional(),
});
export type GmailOAuthCredentials = z.infer<typeof gmailOAuthCredsParser>;

/** Either stored shape. Ordered so a full OAuth payload is never read as a
 *  delegated one that happens to carry extra keys. */
export const gmailCredsParser = z.union([gmailOAuthCredsParser, gmailDelegatedCredsParser]);
export type GmailCredentials = z.infer<typeof gmailCredsParser>;

/** Which shape a payload is, STRUCTURALLY — a credential that carries a refresh
 *  token is one somebody signed in for, whatever any column says. */
export function isGmailOAuthCredentials(
  credentials: GmailCredentials,
): credentials is GmailOAuthCredentials {
  return 'refreshToken' in credentials;
}

/** The connect method a stored credential belongs to. */
export function gmailMethodOf(credentials: GmailCredentials): GmailConnectMethod {
  return isGmailOAuthCredentials(credentials) ? 'oauth' : 'delegated';
}

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
   *  the send scope is missing from the delegation grant. */
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
 * (`missing_send_scope`) rather than as `delegation`: each Gmail call now asks
 * for exactly the one scope it needs, so a refused SEND token means the grant
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
      return head + String(neverAsAny(method));
  }
}

// ── The client ──────────────────────────────────────────────────────────────

/**
 * Gmail for ONE mailbox.
 *
 * `baseUrl` is the dev loop's redirect at fake-channels (googleapis resolves
 * request paths against the rootUrl ORIGIN, so the fake serves `/gmail/v1/*`
 * from its root). It also decides the auth: a fake needs no bearer token, and
 * minting one would mean impersonating a mailbox that does not exist against a
 * Google that was never asked — so the redirected client authenticates with a
 * stub key and never leaves the machine.
 */
export class GmailApiClient {
  /** Scoped to `gmail.readonly` — every call except the send. */
  private readonly readApi: gmail_v1.Gmail;
  /** Scoped to `gmail.send` — the send call ONLY, so it never depends on the
   *  read scope having been granted, nor grants read access itself. Under the
   *  OAuth shape it is the SAME client as the read one: one sign-in produced
   *  one token carrying whatever scopes were granted, and there is no second
   *  token to narrow. */
  private readonly sendApi: gmail_v1.Gmail;

  constructor(
    readonly credentials: GmailCredentials,
    private readonly options: { credentialsId?: string } = {},
  ) {
    const fake = credentials.baseUrl;
    if (isGmailOAuthCredentials(credentials)) {
      const api = this.buildTokenApi(credentials, fake);
      this.readApi = api;
      this.sendApi = api;
    } else {
      this.readApi = GmailApiClient.buildDelegatedApi(credentials, fake, GMAIL_READ_SCOPES);
      this.sendApi = GmailApiClient.buildDelegatedApi(credentials, fake, GMAIL_SEND_SCOPES);
    }
  }

  private buildTokenApi(
    credentials: GmailOAuthCredentials,
    fake: string | undefined,
  ): gmail_v1.Gmail {
    const tokens: GmailTokens = {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
    };
    return google.gmail({
      version: 'v1',
      auth: gmailTokenClient({
        tokens,
        ...(this.options.credentialsId !== undefined
          ? { credentialsId: this.options.credentialsId }
          : {}),
        ...(fake !== undefined ? { fakeBaseUrl: fake } : {}),
      }),
      ...(fake ? { rootUrl: fake } : {}),
    });
  }

  private static buildDelegatedApi(
    credentials: GmailDelegatedCredentials,
    fake: string | undefined,
    scopes: readonly string[],
  ): gmail_v1.Gmail {
    return google.gmail({
      version: 'v1',
      auth: fake ? 'dev-loop-gmail-key' : delegatedGoogleAuth({ subject: credentials.mailbox, scopes }),
      ...(fake ? { rootUrl: fake } : {}),
    });
  }

  private async call<T>(
    operation: string,
    schema: z.ZodType<T>,
    run: () => Promise<{ data: unknown }>,
  ): Promise<T> {
    let payload: unknown;
    try {
      payload = (await run()).data;
    } catch (err) {
      throw classifyGmailError(err, operation);
    }
    return schema.parse(payload);
  }

  /** Whether this credential may send. Under the OAuth shape the granted
   *  scopes say so outright; under delegation nothing local knows, so the
   *  answer is "ask Google" — which is what the send then does. */
  canSend(): boolean {
    return isGmailOAuthCredentials(this.credentials)
      ? this.credentials.grantedScopes.includes(GMAIL_SEND_SCOPE)
      : true;
  }

  /** The mailbox's own profile — the connect-time proof that the connection
   *  works AND the source of the first poll's change marker. */
  async getProfile(): Promise<GmailProfile> {
    return this.call('users.getProfile', gmailProfileSchema, () =>
      this.readApi.users.getProfile({ userId: SELF }),
    );
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
    const page = await this.call('users.messages.list', messageListSchema, () =>
      this.readApi.users.messages.list({
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
    return this.call('users.messages.get', gmailMessageSchema, () =>
      this.readApi.users.messages.get({ userId: SELF, id, format: 'full' }),
    );
  }

  /** One message as the raw RFC 822 bytes, base64url — what a forward or an
   *  archive wants, and what the fake serves under `format=raw`. */
  async getRawMessage(id: string): Promise<GmailMessage> {
    return this.call('users.messages.get(raw)', gmailMessageSchema, () =>
      this.readApi.users.messages.get({ userId: SELF, id, format: 'raw' }),
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
    const page = await this.call('history.list', historyListSchema, () =>
      this.readApi.users.history.list({
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
    if (isGmailOAuthCredentials(this.credentials) && !this.canSend()) {
      throw new GmailApiError(
        'missing_send_scope',
        undefined,
        'users.messages.send',
        `the sign-in for ${this.credentials.mailbox} granted ` +
          `${this.credentials.grantedScopes.join(', ') || 'no scopes'}`,
      );
    }
    return this.call('users.messages.send', sentMessageSchema, () =>
      this.sendApi.users.messages.send({
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
    const part = await this.call('users.messages.attachments.get', attachmentSchema, () =>
      this.readApi.users.messages.attachments.get({
        userId: SELF,
        messageId: input.messageId,
        id: input.attachmentId,
      }),
    );
    return Buffer.from(part.data ?? '', 'base64url');
  }
}

// ── Connect-time validation ─────────────────────────────────────────────────

/** What the connect page tells the user when a sign-in produced a mailbox this
 *  installation will not act as. */
export const GMAIL_OAUTH_NOT_ALLOWED_PREFIX = 'That Google account cannot be connected here. ';

/** What the connect form tells the user when the mailbox will not answer. */
export const GMAIL_DELEGATION_MESSAGE =
  'Google refused to act as this mailbox. A Workspace admin has to grant this ' +
  'deployment domain wide delegation for the Gmail read and send scopes before ' +
  'any mailbox can be connected.';

export const GMAIL_NO_MAILBOX_MESSAGE =
  'That address is not a mailbox in your Google Workspace. Use a real user or ' +
  'shared mailbox — a group address has no inbox to read.';

export const GMAIL_UNCONFIGURED_MESSAGE =
  'This server has no Google service account configured, so it cannot act as a ' +
  'mailbox at all.';

/** The env var naming which mailboxes the Gmail connector may touch. */
const ALLOWLIST_VAR = 'GMAIL_MAILBOX_ALLOWLIST';

/**
 * The ONE check every enforcement site shares: connect-time validation, the
 * in-app modal's save path, the OAuth callback, and the client built at use
 * time (`resolveGmailClient`). All of them read the same verdict rather than
 * each re-deriving it.
 *
 * Set, the list is policy and both methods obey it — a mailbox this
 * installation has not named is refused however it was connected.
 *
 * UNSET, the answer differs by method, because the question is who else is
 * enforcing anything:
 *   oauth — Google is. A refresh token from signing in as one address works for
 *     that address and no other, so an unset list restricts nothing that was
 *     not already restricted, and demanding one would only stop a deployment
 *     from connecting a mailbox it had every right to.
 *   delegated — nobody is. Once a Workspace admin grants the service account
 *     delegation it can act as EVERY mailbox in the Workspace, so an unset list
 *     defaulting to "all of them" would be a guarantee that silently is not
 *     one. Unset therefore refuses.
 */
export function checkGmailMailboxAllowed(
  mailbox: string,
  options: { method: GmailConnectMethod; env?: NodeJS.ProcessEnv },
): { ok: true } | { ok: false; message: string } {
  const allowlist = gmailMailboxAllowlist(options.env ?? process.env);
  if (allowlist.has(mailbox.trim().toLowerCase())) return { ok: true };
  if (allowlist.size === 0) {
    switch (options.method) {
      case 'oauth':
        return { ok: true };
      case 'delegated':
        return {
          ok: false,
          message:
            `${ALLOWLIST_VAR} is not set, so this installation cannot connect or use ` +
            'any Gmail mailbox. Set it to a comma separated list of the addresses ' +
            'automations may act as, for example ops@example.com,deals@example.com.',
        };
      default:
        return { ok: false, message: String(neverAsAny(options.method)) };
    }
  }
  return {
    ok: false,
    message: `${mailbox} is not on this installation's ${ALLOWLIST_VAR}. Add it there before connecting or using this mailbox.`,
  };
}

/**
 * What the paste-a-refresh-token form accepts. One field, and it is a secret:
 * a refresh token IS the mailbox, so it is never echoed back onto the form and
 * never reaches a log line.
 */
export const gmailRefreshTokenCredsParser = z.object({
  refreshToken: z.string().min(1),
  baseUrl: z.string().url().optional(),
});
export type GmailRefreshTokenEntry = z.infer<typeof gmailRefreshTokenCredsParser>;

/**
 * Connect a mailbox from a refresh token somebody obtained themselves — a
 * Workspace admin who would rather authorise the mailbox than hand a sign-in to
 * whoever is at the keyboard.
 *
 * It is an ordinary connect, not a way around one: the token is redeemed with
 * the same OAuth client a sign-in would have used, the mailbox is read off
 * `users.getProfile` rather than typed, the granted scopes come from what the
 * exchange reported, and the allowlist applies exactly as it does everywhere
 * else. What it stores is the SAME shape the callback stores, so nothing
 * downstream can tell the two apart — which is the point.
 */
export async function connectGmailByRefreshToken(input: {
  refreshToken: string;
  /** The dev loop's fake Google, when one is in play. Never stored: the
   *  resolve path re-injects it per team. */
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: true; credentials: GmailOAuthCredentials } | { ok: false; message: string }> {
  let redeemed;
  try {
    redeemed = await redeemGmailRefreshToken({
      refreshToken: input.refreshToken,
      ...(input.baseUrl !== undefined ? { fakeBaseUrl: input.baseUrl } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      message: err instanceof GmailRefreshTokenError ? err.message : String(err),
    };
  }

  const probe = new GmailApiClient({
    // A placeholder only until the profile answers — every stored copy below
    // carries the address Google named.
    mailbox: 'pending@invalid.example',
    accessToken: redeemed.accessToken,
    refreshToken: redeemed.refreshToken,
    expiresAt: redeemed.expiresAt,
    grantedScopes: redeemed.grantedScopes,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
  });

  let mailbox: string;
  try {
    mailbox = (await probe.getProfile()).emailAddress;
  } catch (err) {
    const failure = classifyGmailError(err, 'users.getProfile');
    return {
      ok: false,
      message:
        failure.failure === 'delegation'
          ? GMAIL_REFRESH_TOKEN_REFUSED_MESSAGE
          : `Google could not be reached: ${failure.message}`,
    };
  }

  const allowed = checkGmailMailboxAllowed(mailbox, {
    method: 'oauth',
    ...(input.env !== undefined ? { env: input.env } : {}),
  });
  if (!allowed.ok) return allowed;

  return {
    ok: true,
    credentials: {
      mailbox,
      accessToken: redeemed.accessToken,
      refreshToken: redeemed.refreshToken,
      expiresAt: redeemed.expiresAt,
      grantedScopes: redeemed.grantedScopes,
    },
  };
}

/**
 * Prove a mailbox before storing it. First the allowlist — a mailbox this
 * installation has not named is refused before anything asks Google — then
 * one call as the mailbox: either Google refuses to act as it, or it does not
 * and Gmail says whether the address owns an inbox. Anything else is reported
 * as itself rather than guessed at.
 */
export async function validateGmailMailbox(
  credentials: GmailCredentials,
): Promise<{ ok: true; profile: GmailProfile } | { ok: false; message: string }> {
  const method = gmailMethodOf(credentials);
  const allowed = checkGmailMailboxAllowed(credentials.mailbox, { method });
  if (!allowed.ok) return allowed;
  // Only delegation needs the deployment's own service account; a sign-in
  // carries its own authority.
  if (
    method === 'delegated' &&
    credentials.baseUrl === undefined &&
    !isGoogleServiceAccountConfigured()
  ) {
    return { ok: false, message: GMAIL_UNCONFIGURED_MESSAGE };
  }
  try {
    const profile = await new GmailApiClient(credentials).getProfile();
    return { ok: true, profile };
  } catch (err) {
    const failure = classifyGmailError(err, 'users.getProfile');
    switch (failure.failure) {
      case 'delegation':
        return { ok: false, message: GMAIL_DELEGATION_MESSAGE };
      case 'no_such_mailbox':
        return { ok: false, message: GMAIL_NO_MAILBOX_MESSAGE };
      // `users.getProfile` only ever asks for the readonly scope, so a
      // send-scope failure can never actually classify this way — kept
      // explicit rather than folded into `other` so the switch stays
      // exhaustive against `GmailFailure` without an `as`.
      case 'missing_send_scope':
      case 'history_expired':
      case 'other':
        return { ok: false, message: `Google could not be reached: ${failure.message}` };
      default:
        return { ok: false, message: String(neverAsAny(failure.failure)) };
    }
  }
}
