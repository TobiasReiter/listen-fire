// The callback store — one row per `callback(…)` mint, and the CAS that makes a
// fire exactly-once (callback-primitive layer 2).
//
// The `id` IS the payload every platform button, tap and BYO webhook carries,
// and IS the authorization. It carries the `cb_` namespace prefix so every door
// picks it out with ONE prefix COMPARISON and never parses it — a discriminant,
// not a structure (movement-lang/CLAUDE.md: compared-only ⇒ an identity).
//
// The claim is a single UPDATE. That is the whole race story: two concurrent
// taps of a single-use callback both run `WHERE status = 'live'`, exactly one
// row-locks and transitions, the loser sees zero rows and reads back `closed`.
// The call APPEND rides the same statement, so a repeatable callback's ledger
// can never accumulate a call that the claim didn't authorise (and no
// transaction has to straddle two tables — which is why the ledger is jsonb on
// the row rather than a child table).
//
// TTL is LAZY (the plan's ruling): expiry is a predicate on the claim, not a
// sweeper. A janitor would be hygiene only, and correctness never waits on one.

import { randomBytes } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { CallbackId } from '../../generated/kysely/automations/Callback';
import type AutomationsSchema from '../../generated/kysely/automations/AutomationsSchema';
import type { ParkedScopeState } from './serialize';

import { getAutomationsQb, getQb } from '../../lib/kysely';
import { apiBaseUrl } from '../../lib/api_base_url';

// ── The id namespace ───────────────────────────────────────────────────────

/** Every door's ONE recognition test. Compared, never parsed. */
export const CALLBACK_ID_PREFIX = 'cb_';

export function isCallbackId(value: string): boolean {
  return value.startsWith(CALLBACK_ID_PREFIX);
}

function mintCallbackId(): CallbackId {
  return (CALLBACK_ID_PREFIX + randomBytes(24).toString('base64url')) as CallbackId;
}

function callbackBaseUrl(): string {
  return apiBaseUrl();
}

/** The human link — what `callback(…).url` reads. GET renders a confirm page;
 *  only POST fires (the GET-never-writes rule). */
export function callbackUrl(id: string): string {
  return `${callbackBaseUrl()}/api/cb/${id}`;
}

// ── The record ─────────────────────────────────────────────────────────────

import type { CallbackCall, CallbackParamSpec } from 'engine-contracts';

// Re-exported only for the conformance corpora, which import these from here;
// live code imports them from `engine-contracts`.
export {
  CALLBACK_PARAM_TYPES,
  isCallbackParamType,
  type CallbackCall,
  type CallbackParamSpec,
  type CallbackParamType,
} from 'engine-contracts';

/** A call as the ledger keeps it: the call itself, and when its body started.
 *  The mark is written BEFORE the body runs, so a body runs at most once
 *  after it starts, across a crash too: a queued retry of a call whose body
 *  started never runs it again. The trade-off is deliberate — a crash mid-body
 *  leaves a callback whose body never completes rather than one whose writes
 *  land twice. The mark is also when the call LANDS: until its body has
 *  started, the call is on the ledger but no reader sees it (`readCallbackCalls`,
 *  and the awaits it resolves), so an `await cb-[:Called]->` never runs ahead
 *  of the body it fired. `bodyStartedAt` is the host's bookkeeping; the
 *  engine's `Called` landing never sees it. */
export interface LedgerCall extends CallbackCall {
  bodyStartedAt?: string;
}

/** The ledger as the row holds it, checked where it is read: jsonb the
 *  database hands back is not a type until it is validated. */
const ledgerSchema = z.array(
  z.object({
    at: z.string(),
    values: z.record(z.string(), z.unknown()),
    bodyStartedAt: z.string().optional(),
  }),
);

/** A call is seen (read as `Called`, resolving an await) once its body has
 *  started. */
function hasLanded(call: LedgerCall): boolean {
  return call.bodyStartedAt !== undefined;
}

/** `live` is the only non-terminal state. `fired` is a single-use claim; a
 *  repeatable callback stays `live` and accumulates calls until revoked. */
export type CallbackStatus = 'live' | 'fired' | 'revoked';

export interface CallbackRecord {
  id: CallbackId;
  teamId: TeamId;
  runId: TriggerRunId;
  /** The callback expression's canonical lexical address in the run's PINNED
   *  movement version — the entry point a fire resumes at. */
  address: string;
  params: CallbackParamSpec[];
  /** The captured closure, in the park machinery's own shape. */
  state: ParkedScopeState;
  calls: LedgerCall[];
  singleUse: boolean;
  expiresAt: Date | null;
  status: CallbackStatus;
  createdAt: Date;
  firedAt: Date | null;
  revokedAt: Date | null;
}

interface CallbackRow {
  id: CallbackId;
  team_id: TeamId;
  run_id: TriggerRunId;
  address: string;
  params: unknown;
  state: unknown;
  calls: unknown;
  single_use: boolean;
  expires_at: Date | null;
  status: string;
  created_at: Date;
  fired_at: Date | null;
  revoked_at: Date | null;
}

const COLUMNS = [
  'id', 'team_id', 'run_id', 'address', 'params', 'state', 'calls',
  'single_use', 'expires_at', 'status', 'created_at', 'fired_at', 'revoked_at',
] as const;

function toRecord(row: CallbackRow): CallbackRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    runId: row.run_id,
    address: row.address,
    params: (row.params as CallbackParamSpec[] | null) ?? [],
    state: row.state as ParkedScopeState,
    calls: ledgerOf(row),
    singleUse: row.single_use,
    expiresAt: row.expires_at,
    status: row.status as CallbackStatus,
    createdAt: row.created_at,
    firedAt: row.fired_at,
    revokedAt: row.revoked_at,
  };
}

function ledgerOf(row: CallbackRow): LedgerCall[] {
  if (row.calls === null) return [];
  const parsed = ledgerSchema.safeParse(row.calls);
  if (!parsed.success) {
    throw new Error(`callback ${row.id} has a malformed call ledger: ${parsed.error.message}`);
  }
  return parsed.data.map(({ at, values, bodyStartedAt }) => ({
    at,
    values,
    ...(bodyStartedAt !== undefined ? { bodyStartedAt } : {}),
  }));
}

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}

/** The database's clock as an ISO 8601 instant, spelled as JavaScript spells
 *  one, for the instants the ledger records. */
const ISO_NOW = sql<string>`to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ── Mint ───────────────────────────────────────────────────────────────────

export interface MintCallbackInput {
  teamId: TeamId;
  runId: TriggerRunId;
  address: string;
  params: CallbackParamSpec[];
  state: ParkedScopeState;
  /** `once` — defaults TRUE. The DEFAULT is the engine's, deliberately not the
   *  AST's (chunk 1), so it lives here and nowhere else. */
  singleUse?: boolean;
  /** `ttl` resolved to an absolute instant at mint. */
  expiresAt?: Date;
}

export async function mintCallback(input: MintCallbackInput): Promise<CallbackRecord> {
  const id = mintCallbackId();
  const row = await getAutomationsQb(['callback'])
    .insertInto('callback')
    .values({
      id,
      team_id: input.teamId,
      run_id: input.runId,
      address: input.address,
      params: jsonb(input.params) as never,
      state: jsonb(input.state) as never,
      calls: jsonb([]) as never,
      single_use: input.singleUse ?? true,
      expires_at: input.expiresAt ?? null,
      status: 'live',
    })
    .returning([...COLUMNS])
    .executeTakeFirstOrThrow();
  return toRecord(row as unknown as CallbackRow);
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** What a callback query runs on: the pool, or a caller's transaction. */
export type CallbackDb = Kysely<Pick<AutomationsSchema, 'callback'>>;

export async function getCallback(id: string, opts: { db?: CallbackDb } = {}): Promise<CallbackRecord | null> {
  // The prefix guard keeps a foreign payload from ever reaching a query — the
  // doors hand us whatever the platform sent.
  if (!isCallbackId(id)) return null;
  const row = await (opts.db ?? getAutomationsQb(['callback']))
    .selectFrom('callback')
    .where('id', '=', id as CallbackId)
    .select([...COLUMNS])
    .executeTakeFirst();
  return row ? toRecord(row as unknown as CallbackRow) : null;
}

/** The LIVE ledger read — what `cb-[:Called]->` returns and what a re-entered
 *  `await cb-[:Called]->` re-checks. Never served from the parked scope blob:
 *  the calls arrive AFTER the scope was captured. Only calls whose body has
 *  started are seen (`LedgerCall`). */
export async function readCallbackCalls(id: string): Promise<CallbackCall[]> {
  const record = await getCallback(id);
  return (record?.calls ?? []).filter(hasLanded).map(({ at, values }) => ({ at, values }));
}

/** Record on the ledger that call `callIndex`'s body is starting. Given the
 *  run lease the body runs under, only while the run is still leased to it:
 *  false when it is not, and nothing was marked, so a holder whose lease
 *  lapsed never marks a body it will not run. */
export async function markCallbackBodyStarted(input: {
  id: string;
  callIndex: number;
  lease?: { token: string };
}): Promise<boolean> {
  let mark = getAutomationsQb(['callback', 'trigger_run'])
    .updateTable('callback')
    .set({
      calls: sql`jsonb_set(calls, ${`{${input.callIndex}}`}::text[], (calls -> ${input.callIndex}::int) || jsonb_build_object('bodyStartedAt', ${ISO_NOW}))`,
      updated_at: new Date(),
    })
    .where('id', '=', input.id as CallbackId);
  if (input.lease !== undefined) {
    const { token } = input.lease;
    mark = mark.where((eb) =>
      eb.exists(
        eb
          .selectFrom('trigger_run')
          .select('trigger_run.id')
          .whereRef('trigger_run.id', '=', 'callback.run_id')
          .where('trigger_run.lease_token', '=', token),
      ),
    );
  }
  const marked = await mark.executeTakeFirst();
  return Number(marked.numUpdatedRows) > 0;
}

export async function listRunCallbacks(runId: TriggerRunId): Promise<CallbackRecord[]> {
  const rows = await getAutomationsQb(['callback'])
    .selectFrom('callback')
    .where('run_id', '=', runId)
    .orderBy('created_at', 'asc')
    .select([...COLUMNS])
    .execute();
  return rows.map((r) => toRecord(r as unknown as CallbackRow));
}

export async function listTeamCallbacks(
  teamId: TeamId,
  limit = 50,
): Promise<CallbackRecord[]> {
  const rows = await getAutomationsQb(['callback'])
    .selectFrom('callback')
    .where('team_id', '=', teamId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select([...COLUMNS])
    .execute();
  return rows.map((r) => toRecord(r as unknown as CallbackRow));
}

// ── The claim (the whole race story) ───────────────────────────────────────

export type CallbackClaim =
  | { kind: 'recorded'; callback: CallbackRecord; call: CallbackCall }
  | { kind: 'not_found' }
  /** Revoked (its run settled / was cancelled / its movement was deleted) or
   *  already fired (single-use). The closed-request-wins ack. */
  | { kind: 'closed'; callback: CallbackRecord }
  | { kind: 'expired'; callback: CallbackRecord };

/**
 * Claim a fire and record its call in ONE statement. Single-use flips
 * `live → fired`; a repeatable callback stays `live` and appends. The zero-row
 * result IS the "someone else got there first / it is closed / it expired"
 * signal — read back to say WHICH, never to decide (the decision already
 * happened, atomically).
 *
 * `values` must already be validated against the signature: a parameter
 * mismatch is a LOUD refusal BEFORE the claim, so a bad payload never consumes
 * a single-use callback.
 */
export async function claimCallbackFire(
  input: { id: string; values: Record<string, unknown> },
  /** Run the claim inside a caller's transaction: what the caller writes with
   *  it commits or rolls back together with the call. */
  opts: { db?: CallbackDb } = {},
): Promise<CallbackClaim> {
  if (!isCallbackId(input.id)) return { kind: 'not_found' };
  const db = opts.db ?? getAutomationsQb(['callback']);
  const id = input.id as CallbackId;
  // One clock decides: expiry, `fired_at` and the call's `At` all read the
  // database's, and so does the read-back that says which refusal it was.
  const claimed = await db
    .updateTable('callback')
    .set({
      status: sql<string>`CASE WHEN single_use THEN 'fired' ELSE status END`,
      fired_at: sql<Date | null>`CASE WHEN single_use THEN now() ELSE fired_at END`,
      calls: sql`calls || jsonb_build_array(jsonb_build_object('at', ${ISO_NOW}, 'values', ${JSON.stringify(input.values)}::jsonb))`,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', id)
    .where('status', '=', 'live')
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
    .returning([...COLUMNS])
    .executeTakeFirst();
  if (claimed !== undefined) {
    const callback = toRecord(claimed as unknown as CallbackRow);
    const recorded = callback.calls[callback.calls.length - 1];
    if (recorded === undefined) throw new Error(`callback ${id} recorded a call its ledger does not hold`);
    return { kind: 'recorded', callback, call: { at: recorded.at, values: recorded.values } };
  }

  const existing = await db
    .selectFrom('callback')
    .where('id', '=', id)
    .select([...COLUMNS, sql<Date>`now()`.as('database_now')])
    .executeTakeFirst();
  if (existing === undefined) return { kind: 'not_found' };
  const callback = toRecord(existing as unknown as CallbackRow);
  return {
    kind: callbackRefusal(callback, { for: 'a new call', now: existing.database_now }) ?? 'closed',
    callback,
  };
}

/**
 * Why a callback refuses, or null when it accepts — the ONE rule, shared by
 * the door that records a new call and the queued body of a call already
 * recorded. Revoked (its run ended, was cancelled, its movement deleted)
 * refuses both. A new call is refused by a single-use callback that already
 * fired, and by expiry; a recorded call is not: firing it is what made the
 * callback `fired`, and it was recorded inside its window.
 */
export function callbackRefusal(
  callback: CallbackRecord,
  opts: { for: 'a new call' | 'a recorded call'; now: Date },
): 'closed' | 'expired' | null {
  if (callback.status === 'revoked') return 'closed';
  if (opts.for === 'a recorded call') return null;
  if (callback.status === 'fired') return 'closed';
  if (callback.expiresAt !== null && callback.expiresAt <= opts.now) return 'expired';
  return null;
}

// ── Revocation (the run's lifecycle drives it; there is no sweeper) ────────

/**
 * Ruling (b): a run that reaches ANY terminal state — success, partial, failed,
 * cancelled — revokes its outstanding callbacks. Callbacks are ephemeral by
 * definition: strictly things the current run can still react to. An author who
 * wants buttons to stay live keeps the run alive by awaiting `Called`.
 *
 * Idempotent, and only ever touches `live` rows — a fired single-use keeps its
 * `fired` state (and its `fired_at`) so the inspector can still tell the two
 * endings apart.
 */
export async function revokeRunCallbacks(runId: TriggerRunId): Promise<number> {
  return revokeCallbacksForRuns([runId]);
}

export async function revokeCallbacksForRuns(runIds: TriggerRunId[]): Promise<number> {
  if (runIds.length === 0) return 0;
  const result = await getAutomationsQb(['callback'])
    .updateTable('callback')
    .set({ status: 'revoked', revoked_at: new Date(), updated_at: new Date() })
    .where('run_id', 'in', runIds)
    .where('status', '=', 'live')
    .executeTakeFirst();
  return Number(result?.numUpdatedRows ?? 0);
}

// ── Fire-time parameter validation (loud, never a silent default) ─────────

export type CallbackValueCoercion =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Validate a fire's supplied values against the stored signature. Every declared
 * parameter must be present and coercible to its declared type; an UNDECLARED
 * key is a mismatch too — "the platform sent something where the callback
 * expects nothing" is exactly as wrong as the reverse, and a silent drop is the
 * bug class this language refuses (silent degradation is the absence of a
 * guarantee, not a weaker one).
 */
export function coerceCallbackValues(
  params: CallbackParamSpec[],
  raw: Record<string, unknown>,
): CallbackValueCoercion {
  const declared = new Set(params.map((p) => p.name));
  const extra = Object.keys(raw).filter((k) => !declared.has(k));
  if (extra.length > 0) {
    return {
      ok: false,
      message:
        params.length === 0
          ? `this callback takes no values, but ${extra.map((e) => `'${e}'`).join(', ')} was sent`
          : `'${extra.join("', '")}' is not a parameter of this callback — it takes: ${params
              .map((p) => `${p.name} (${p.type})`)
              .join(', ')}`,
    };
  }

  const values: Record<string, unknown> = {};
  for (const param of params) {
    if (!Object.prototype.hasOwnProperty.call(raw, param.name) || raw[param.name] === undefined) {
      return {
        ok: false,
        message: `missing '${param.name}' — this callback expects ${params
          .map((p) => `${p.name} (${p.type})`)
          .join(', ')}`,
      };
    }
    const coerced = coerceOne(param, raw[param.name]);
    if ('error' in coerced) return { ok: false, message: coerced.error };
    values[param.name] = coerced.value;
  }
  return { ok: true, values };
}

function coerceOne(
  param: CallbackParamSpec,
  raw: unknown,
): { value: unknown } | { error: string } {
  const bad = (saw: string): { error: string } => ({
    error: `'${param.name}' expects ${param.type}, but ${saw}`,
  });
  switch (param.type) {
    case 'text':
      return typeof raw === 'string' ? { value: raw } : { value: String(raw) };
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? { value: n } : bad(`'${String(raw)}' is not a number`);
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw };
      const s = String(raw).trim().toLowerCase();
      if (['true', 'yes', '1'].includes(s)) return { value: true };
      if (['false', 'no', '0'].includes(s)) return { value: false };
      return bad(`'${String(raw)}' is not true or false`);
    }
    case 'date':
    case 'datetime': {
      const parsed = raw instanceof Date ? raw : new Date(String(raw));
      if (Number.isNaN(parsed.getTime())) return bad(`'${String(raw)}' is not a date`);
      return {
        value: param.type === 'date'
          ? parsed.toISOString().slice(0, 10)
          : parsed.toISOString(),
      };
    }
    case 'json': {
      if (typeof raw !== 'string') return { value: raw };
      try {
        return { value: JSON.parse(raw) };
      } catch {
        return bad(`'${raw}' is not valid JSON`);
      }
    }
    case 'file':
      // A file parameter is a handle the CALLING SYSTEM owns — passed through
      // opaquely, never invented here. The confirm page says so rather than
      // pretending a browser can supply one.
      return { value: raw };
  }
}
