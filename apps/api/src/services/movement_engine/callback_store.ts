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

import { sql } from 'kysely';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { CallbackId } from '../../generated/kysely/automations/Callback';
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

import type { CallbackCall, CallbackParamSpec } from './callback_types';

// Re-exported only for the conformance corpora, which import these from here;
// live code imports them from `callback_types.ts`.
export {
  CALLBACK_PARAM_TYPES,
  isCallbackParamType,
  type CallbackCall,
  type CallbackParamSpec,
  type CallbackParamType,
} from './callback_types';

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
  calls: CallbackCall[];
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
    calls: (row.calls as CallbackCall[] | null) ?? [],
    singleUse: row.single_use,
    expiresAt: row.expires_at,
    status: row.status as CallbackStatus,
    createdAt: row.created_at,
    firedAt: row.fired_at,
    revokedAt: row.revoked_at,
  };
}

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}

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

export async function getCallback(id: string): Promise<CallbackRecord | null> {
  // The prefix guard keeps a foreign payload from ever reaching a query — the
  // doors hand us whatever the platform sent.
  if (!isCallbackId(id)) return null;
  const row = await getAutomationsQb(['callback'])
    .selectFrom('callback')
    .where('id', '=', id as CallbackId)
    .select([...COLUMNS])
    .executeTakeFirst();
  return row ? toRecord(row as unknown as CallbackRow) : null;
}

/** The LIVE ledger read — what `cb-[:Called]->` returns and what a re-entered
 *  `await cb-[:Called]->` re-checks. Never served from the parked scope blob:
 *  the calls arrive AFTER the scope was captured. */
export async function readCallbackCalls(id: string): Promise<CallbackCall[]> {
  const record = await getCallback(id);
  return record?.calls ?? [];
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
export async function claimCallbackFire(input: {
  id: string;
  values: Record<string, unknown>;
  now?: Date;
}): Promise<CallbackClaim> {
  if (!isCallbackId(input.id)) return { kind: 'not_found' };
  const at = input.now ?? new Date();
  const call: CallbackCall = { at: at.toISOString(), values: input.values };
  const claimed = await getAutomationsQb(['callback'])
    .updateTable('callback')
    .set({
      status: sql`CASE WHEN single_use THEN 'fired' ELSE status END` as never,
      fired_at: sql`CASE WHEN single_use THEN ${at} ELSE fired_at END` as never,
      calls: sql`calls || ${JSON.stringify([call])}::jsonb` as never,
      updated_at: at,
    })
    .where('id', '=', input.id as CallbackId)
    .where('status', '=', 'live')
    .where((eb) =>
      eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at)]),
    )
    .returning([...COLUMNS])
    .executeTakeFirst();
  if (claimed !== undefined) {
    return { kind: 'recorded', callback: toRecord(claimed as unknown as CallbackRow), call };
  }

  const existing = await getCallback(input.id);
  if (existing === null) return { kind: 'not_found' };
  if (existing.status === 'live') return { kind: 'expired', callback: existing };
  return { kind: 'closed', callback: existing };
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
