// The ask record store — the persistence + state-lattice heart of the
// asks-as-adapter model (layer 3B). ONE module owns the `asks.ask` table, and
// two front doors sit on top of it: the ask ADAPTER (create along `-[:Check]->`,
// cancel via `write a { Cancelled: true }`) and the LINK SURFACE
// (`/api/asks/<token>` — lookup + answer). Keeping the record semantics here,
// dependency-light (kysely + crypto only), means the HTTP route can import it
// without dragging in the whole adapter graph.
//
// The lattice is `open → answered` and `open → expired`, both terminal. Every
// transition is an optimistic `WHERE state = 'open'` update: a zero-row result
// IS the "already settled" signal, reported as one consistent outcome to
// whichever door drove the write (F17 — the adapter owns its own races; the
// engine never adjudicates). Expiry happens ONLY via the explicit cancel write
// — never on a timer, never on a cancellation signal (that is engine chunk B).
//
// F16: every write CREATES. There is no dedupe/uniqueness surface; provenance
// (movement / run / node ids) is carried as INFO, never identity.

import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import { z } from 'zod';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { AskId } from '../../../../generated/kysely/asks/Ask';

import { getAsksQb } from '../../../../lib/kysely';
import { apiBaseUrl } from '../../../../lib/api_base_url';

/** An ask id arriving as plain text (a correlation key, a CLI argument) — the
 *  boundary check that names it as one. */
export const askIdSchema = z.custom<AskId>(
  (value) => typeof value === 'string' && z.string().uuid().safeParse(value).success,
);

// ── The family / answer-type / state vocabularies ──────────────────────────

/** The ask families — each is a writable position on the adapter root. The
 *  family FIXES the answer's type (there is no runtime disagreement possible
 *  between the surface control and the stored answer — the founding incident,
 *  structurally gone).
 *
 *  Choose/Select/Correct/Draft/Form complete the legacy catalog (3a) alongside
 *  the four chunk-A families. RULED 2026-07-30, correcting a chunk-A
 *  naming collision flagged in fast-follow review:
 *   - `Choose` is chunk A's original single-choice-from-`Options` family,
 *     RENAMED from `Select` — that was always the legacy catalog's `Choose`
 *     (a named option, button per choice), never the real `Select`.
 *   - `Select` is now the REAL multi-select subset: the answer is a LIST of
 *     chosen options (⊆ `Options`, possibly empty — the link page's checklist
 *     control has always allowed submitting none, "the engine drops empty
 *     ids", so an ask answered with nothing selected is valid here too).
 *   - `Pick` is DROPPED. Its catalog idiom (`Pick<T>` — choose exactly one
 *     live graph position) is composition, not its own family: a
 *     `Choose`/`Select` over the name field's values, then filter the graph
 *     downstream on the answer. Nothing is lost by not having a family for it.
 *
 *  `Form` remains the legacy CATALOG's placeholder composite ask (3i R5) —
 *  "an empty result node with one labelled edge per part," each part its own
 *  typed sub-ask, answered as one park/resume. That composite engine was
 *  never built upstream (8_build_order.md: "parse-rejected, deferred"). This
 *  adapter implements only the RECORD-level shape: the author names `Fields`
 *  (untyped), the answer is a plain object with a value for every named
 *  field. There is no per-field typing, no independent sub-ask parking — real
 *  composability needs engine support this chunk does not build. */
export const ASK_FAMILIES = [
  'Check', 'Provide', 'Choose', 'Select', 'Review', 'Correct', 'Draft', 'Form',
] as const;
export type AskFamily = (typeof ASK_FAMILIES)[number];

export function isAskFamily(value: string): value is AskFamily {
  return (ASK_FAMILIES as readonly string[]).includes(value);
}

/** The answer types a `Provide` ask may declare. The other families fix their
 *  own answer shape (Check → boolean, Choose → a chosen option, Select → a
 *  chosen subset, Review → an acknowledgement), so `answer_type` is meaningful
 *  only for `Provide`.
 *  Checker parameterization of `Provide<T>` is a later chunk; for now the
 *  author names the answer type as a field on the ask and the adapter enforces
 *  it. */
export const ASK_ANSWER_TYPES = ['text', 'number', 'date', 'boolean'] as const;
export type AskAnswerType = (typeof ASK_ANSWER_TYPES)[number];

export function isAskAnswerType(value: string): value is AskAnswerType {
  return (ASK_ANSWER_TYPES as readonly string[]).includes(value);
}

/** The lattice states. `open` is the only non-terminal one. */
export type AskState = 'open' | 'answered' | 'expired';

/** How long a per-ask capability token stays live. Long by design — the token
 *  is scoped to ONE ask (RULED 2026-07-28), so a long window carries no
 *  cross-ask risk; the ask's own lattice, not the token TTL, is what closes it. */
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Tokens minted by THIS store carry a stable prefix so the shared
 *  `/api/asks/<token>` route can pick the new store vs. the legacy one by the
 *  token alone — no extra query on the legacy path, which stays byte-identical. */
export const ASK_TOKEN_PREFIX = 'ask_';

// ── The record ─────────────────────────────────────────────────────────────

/** Caller-opaque passthrough, stored verbatim and echoed back — never parsed by
 *  the store, and never identity, so there is deliberately no uniqueness
 *  surface over it. The movement engine puts movement / run / node ids here;
 *  a REST caller may put anything (A-3). The fields below are what the engine
 *  writes, named for readability rather than as a contract on the column. */
export interface AskProvenance {
  movementId?: string;
  runId?: string;
  nodeId?: string;
  adapterType?: string;
}

/** One record offered to a `Correct` ask — a plain object of field name to
 *  current value, addressed by an ephemeralId stable for this ask's lifetime
 *  (minted at write, never a durable graph identity). */
export interface AskRowSpec {
  ephemeralId: string;
  fields: Record<string, unknown>;
}

/** The full ask record, as both doors read it. */
export interface AskRecord {
  id: AskId;
  teamId: TeamId;
  family: AskFamily;
  answerType: AskAnswerType | null;
  prompt: string;
  detail: string | null;
  /** Choose/Select: the offered options. Form: the named fields it
   *  collects. (Immutable once written.) */
  options: string[] | null;
  /** Correct only — the records offered for review (immutable). */
  rows: AskRowSpec[] | null;
  state: AskState;
  answer: unknown;
  token: string;
  /** The capability link the author delivers — the ONLY delivery affordance
   *  (the adapter renders nothing, sends nothing). */
  url: string;
  tokenExpiresAt: Date;
  provenance: AskProvenance;
  /** Where to POST when this ask settles, for a caller with no in-process
   *  notifier. Null for the library-embedded path, which is nudged directly. */
  callbackUrl: string | null;
  createdAt: Date;
  answeredAt: Date | null;
  expiredAt: Date | null;
}

/** The API base the capability link lands at (`<api>/api/asks/<token>`), shared
 *  with the legacy ask link. */
function asksBaseUrl(): string {
  return apiBaseUrl();
}

export function askUrl(token: string): string {
  return `${asksBaseUrl()}/api/asks/${token}`;
}

interface AskRow {
  id: AskId;
  team_id: TeamId;
  family: string;
  answer_type: string | null;
  prompt: string;
  detail: string | null;
  options: unknown;
  rows: unknown;
  state: string;
  answer: unknown;
  token: string;
  token_expires_at: Date;
  provenance: unknown;
  callback_url: string | null;
  created_at: Date;
  answered_at: Date | null;
  expired_at: Date | null;
}

function rowsFromJson(raw: unknown): AskRowSpec[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AskRowSpec[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.ephemeralId !== 'string') continue;
    const fields = rec.fields !== null && typeof rec.fields === 'object' ? (rec.fields as Record<string, unknown>) : {};
    out.push({ ephemeralId: rec.ephemeralId, fields });
  }
  return out;
}

function rowToRecord(row: AskRow): AskRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    family: row.family as AskFamily,
    answerType: (row.answer_type as AskAnswerType | null) ?? null,
    prompt: row.prompt,
    detail: row.detail,
    options: Array.isArray(row.options) ? (row.options as string[]) : null,
    rows: rowsFromJson(row.rows),
    state: row.state as AskState,
    answer: row.answer ?? null,
    token: row.token,
    url: askUrl(row.token),
    tokenExpiresAt: row.token_expires_at,
    provenance: (row.provenance as AskProvenance | null) ?? {},
    callbackUrl: row.callback_url,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    expiredAt: row.expired_at,
  };
}

const SELECT_COLUMNS = [
  'id', 'team_id', 'family', 'answer_type', 'prompt', 'detail', 'options', 'rows',
  'state', 'answer', 'token', 'token_expires_at', 'provenance', 'callback_url',
  'created_at', 'answered_at', 'expired_at',
] as const;

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}

// ── Create (F16 — always a create) ─────────────────────────────────────────

export interface CreateAskInput {
  teamId: TeamId;
  family: AskFamily;
  prompt: string;
  detail?: string | null;
  /** Provide only. */
  answerType?: AskAnswerType | null;
  /** Choose/Select: the offered options. Form: the named fields. */
  options?: string[] | null;
  /** Correct only. */
  rows?: AskRowSpec[] | null;
  provenance?: AskProvenance;
  /** Where to POST when this ask settles. Only the standalone REST caller sets
   *  one; the embedded adapter is notified in-process instead (A-4). */
  callbackUrl?: string | null;
}

export async function createAsk(input: CreateAskInput): Promise<AskRecord> {
  const token = ASK_TOKEN_PREFIX + randomBytes(24).toString('base64url');
  const row = await getAsksQb(['ask'])
    .insertInto('ask')
    .values({
      team_id: input.teamId,
      family: input.family,
      answer_type: input.answerType ?? null,
      prompt: input.prompt,
      detail: input.detail ?? null,
      options: input.options != null ? (jsonb(input.options) as never) : null,
      rows: input.rows != null ? (jsonb(input.rows) as never) : null,
      token,
      token_expires_at: new Date(Date.now() + TOKEN_TTL_MS),
      provenance: jsonb(input.provenance ?? {}) as never,
      callback_url: input.callbackUrl ?? null,
    })
    .returning([...SELECT_COLUMNS])
    .executeTakeFirstOrThrow();
  return rowToRecord(row as AskRow);
}

// ── Reads ──────────────────────────────────────────────────────────────────

export async function getAsk(id: AskId): Promise<AskRecord | null> {
  const row = await getAsksQb(['ask'])
    .selectFrom('ask')
    .where('id', '=', id)
    .select([...SELECT_COLUMNS])
    .executeTakeFirst();
  return row ? rowToRecord(row as AskRow) : null;
}

/** Look an ask up by its capability token — the link surface's entry point.
 *  Returns null for a token this store did not mint (so the route falls back to
 *  the legacy store). */
export async function lookupAskByToken(token: string): Promise<AskRecord | null> {
  if (!token.startsWith(ASK_TOKEN_PREFIX)) return null;
  const row = await getAsksQb(['ask'])
    .selectFrom('ask')
    .where('token', '=', token)
    .select([...SELECT_COLUMNS])
    .executeTakeFirst();
  return row ? rowToRecord(row as AskRow) : null;
}

/** Every ask for a team, newest first — the dev-loop inspection surface (and
 *  the future "your asks" home). Not exposed inside movements (AGREED: no root
 *  readability in v1 — asks are pure one-shots). */
export async function listAsksForTeam(teamId: TeamId, limit = 100): Promise<AskRecord[]> {
  const rows = await getAsksQb(['ask'])
    .selectFrom('ask')
    .where('team_id', '=', teamId)
    .select([...SELECT_COLUMNS])
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => rowToRecord(r as AskRow));
}

// ── Answer typing (enforced at the adapter layer for now) ──────────────────

export type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Coerce + validate a raw answer against the ask's family (and, for Provide,
 *  its declared answer type). The family IS the type declaration — this is
 *  where "the surface control and the stored answer can never disagree" is
 *  enforced until the checker parameterizes `Provide<T>` (a later chunk). */
export function coerceAnswer(ask: AskRecord, raw: unknown): CoerceResult {
  switch (ask.family) {
    case 'Check':
      return coerceBoolean(raw);
    case 'Review':
      // Awareness — any submission is an acknowledgement.
      return { ok: true, value: 'ack' };
    case 'Choose':
      return coerceChoice(ask.options ?? [], raw);
    case 'Select':
      return coerceSelectMany(ask.options ?? [], raw);
    case 'Provide':
      return coerceProvide(ask.answerType ?? 'text', raw);
    case 'Correct':
      return coerceCorrect(ask.rows ?? [], raw);
    case 'Draft':
      return coerceDraft(raw);
    case 'Form':
      return coerceForm(ask.options ?? [], raw);
  }
}

function coerceBoolean(raw: unknown): CoerceResult {
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  return { ok: false, error: 'expected a yes/no answer' };
}

/** `Choose` — exactly one of the offered options. */
function coerceChoice(options: string[], raw: unknown): CoerceResult {
  const value = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (typeof value !== 'string' || !options.includes(value)) {
    return { ok: false, error: 'answer must be one of the offered options' };
  }
  return { ok: true, value };
}

/** `Select` — a SUBSET of the offered options, possibly empty. Mirrors the
 *  link page's checklist control (`selectControl`, interfaces/rest/asks.ts):
 *  a hidden empty field makes an empty selection submittable ("the engine
 *  drops empty ids"), so blank/empty entries are filtered rather than
 *  rejected, and "none of these" is a valid answer — no minimum-1 rule. */
function coerceSelectMany(options: string[], raw: unknown): CoerceResult {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const chosen: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') continue; // the hidden empty field
    if (!options.includes(item)) {
      return { ok: false, error: `'${item}' is not one of the offered options` };
    }
    if (!chosen.includes(item)) chosen.push(item);
  }
  return { ok: true, value: chosen };
}

function coerceProvide(answerType: AskAnswerType, raw: unknown): CoerceResult {
  switch (answerType) {
    case 'boolean':
      return coerceBoolean(raw);
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: 'expected a number' };
      return { ok: true, value: n };
    }
    case 'date': {
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (s === '' || Number.isNaN(new Date(s).getTime())) {
        return { ok: false, error: 'expected a date' };
      }
      return { ok: true, value: s };
    }
    case 'text': {
      const s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
      if (s.trim() === '') return { ok: false, error: 'an answer is required' };
      return { ok: true, value: s };
    }
  }
}

/** `Correct` — the answer is `{ rows, dropped }` (the web/link editable-table
 *  control's own payload, `interfaces/rest/asks.ts`'s `correctScript`): the
 *  rows with edited fields, and the ephemeralIds of rows the person dropped.
 *  Every referenced ephemeralId must be one this ask actually offered — an
 *  unknown id is rejected observably rather than silently accepted or
 *  dropped, the same "surface and store can never disagree" enforcement as
 *  every other family. */
function coerceCorrect(offered: AskRowSpec[], raw: unknown): CoerceResult {
  const known = new Set(offered.map((r) => r.ephemeralId));
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: 'expected { rows, dropped }' };
  }
  const rec = raw as Record<string, unknown>;
  const rowsIn = Array.isArray(rec.rows) ? rec.rows : [];
  const droppedIn = Array.isArray(rec.dropped) ? rec.dropped : [];

  const rows: AskRowSpec[] = [];
  for (const item of rowsIn) {
    if (item === null || typeof item !== 'object') return { ok: false, error: 'malformed row edit' };
    const r = item as Record<string, unknown>;
    if (typeof r.ephemeralId !== 'string' || !known.has(r.ephemeralId)) {
      return { ok: false, error: `unknown row '${String(r.ephemeralId)}'` };
    }
    const fields = r.fields !== null && typeof r.fields === 'object' ? (r.fields as Record<string, unknown>) : {};
    rows.push({ ephemeralId: r.ephemeralId, fields });
  }

  const dropped: string[] = [];
  for (const id of droppedIn) {
    if (typeof id !== 'string' || !known.has(id)) {
      return { ok: false, error: `unknown row '${String(id)}'` };
    }
    dropped.push(id);
  }

  return { ok: true, value: { rows, dropped } };
}

/** `Draft` — the answer is the drafted shape itself: a structured object the
 *  person composed. No per-field typing (the legacy `Shape` parameter is a
 *  movement-lang type the ask record has no way to check against) — only
 *  that it IS a structured record, not a scalar or array. */
function coerceDraft(raw: unknown): CoerceResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'expected a structured draft' };
  }
  return { ok: true, value: raw };
}

/** `Form` — the record-level shape of the legacy composite ask (3i R5):
 *  every declared field answered together as one object, no more and no
 *  less. There is no per-field typing or independent sub-ask parking (the
 *  real composite engine — one park across N typed parts — was never built
 *  upstream either; 8_build_order.md: "parse-rejected, deferred"). */
function coerceForm(fields: string[], raw: unknown): CoerceResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `expected an answer for each of: ${fields.join(', ')}` };
  }
  const rec = raw as Record<string, unknown>;
  const missing = fields.filter((f) => !(f in rec));
  if (missing.length > 0) return { ok: false, error: `missing answers for: ${missing.join(', ')}` };
  const extra = Object.keys(rec).filter((k) => !fields.includes(k));
  if (extra.length > 0) return { ok: false, error: `unexpected fields: ${extra.join(', ')}` };

  const value: Record<string, unknown> = {};
  for (const f of fields) value[f] = rec[f];
  return { ok: true, value };
}

// ── Lattice transitions (both terminal, both optimistic) ───────────────────

export type AnswerOutcome =
  | { ok: true; ask: AskRecord }
  | { ok: false; reason: 'not_found' | 'settled' | 'expired' | 'invalid'; message?: string; ask?: AskRecord };

/**
 * Answer an ask by id: coerce the raw value against the family, then transition
 * `open → answered` under an optimistic `WHERE state = 'open'` guard. A
 * zero-row update means the ask settled first (answered elsewhere or cancelled)
 * — reported as `settled`, one consistent outcome regardless of which door
 * raced. The token-expiry window gates only the login-less link, not the ask's
 * life, so an EXPIRED TOKEN on an otherwise-open ask still refuses (`expired`).
 */
export async function answerAsk(input: { id: AskId; raw: unknown }): Promise<AnswerOutcome> {
  const current = await getAsk(input.id);
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.state !== 'open') {
    return { ok: false, reason: 'settled', ask: current };
  }
  if (current.tokenExpiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired', ask: current };
  }
  const coerced = coerceAnswer(current, input.raw);
  if (!coerced.ok) return { ok: false, reason: 'invalid', message: coerced.error, ask: current };

  const row = await getAsksQb(['ask'])
    .updateTable('ask')
    .set({
      state: 'answered',
      answer: jsonb(coerced.value) as never,
      answered_at: new Date(),
      updated_at: new Date(),
    })
    .where('id', '=', input.id)
    .where('state', '=', 'open')
    .returning([...SELECT_COLUMNS])
    .executeTakeFirst();
  if (!row) {
    const settled = await getAsk(input.id);
    return { ok: false, reason: 'settled', ...(settled ? { ask: settled } : {}) };
  }
  return { ok: true, ask: rowToRecord(row as AskRow) };
}

export type CancelOutcome =
  | { ok: true; ask: AskRecord }
  | { ok: false; reason: 'not_found' | 'settled'; ask?: AskRecord };

/**
 * The explicit cancellation write (`write a { Cancelled: true }`): transition
 * `open → expired` under the same optimistic guard. Rejects OBSERVABLY on a
 * settled record (already answered or already expired) — the adapter surfaces
 * that as a run error rather than silently no-op'ing.
 */
export async function cancelAsk(input: { id: AskId }): Promise<CancelOutcome> {
  const current = await getAsk(input.id);
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.state !== 'open') return { ok: false, reason: 'settled', ask: current };

  const row = await getAsksQb(['ask'])
    .updateTable('ask')
    .set({ state: 'expired', expired_at: new Date(), updated_at: new Date() })
    .where('id', '=', input.id)
    .where('state', '=', 'open')
    .returning([...SELECT_COLUMNS])
    .executeTakeFirst();
  if (!row) {
    const settled = await getAsk(input.id);
    return { ok: false, reason: 'settled', ...(settled ? { ask: settled } : {}) };
  }
  return { ok: true, ask: rowToRecord(row as AskRow) };
}
