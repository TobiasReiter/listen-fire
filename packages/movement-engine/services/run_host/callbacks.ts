// The run host's callback rules, written once over the callback family
// (store.ts): how a callback is minted for the engine, how a call is
// validated and recorded, how its body runs (once, under the run's lease),
// and how an `await cb-[:Called]->` learns that a call landed. The hosted
// product's Postgres backend and `lf`'s SQLite one serve the family; a door
// (`/api/cb/<id>`, `lf call`) and the work drain call these rules.
//
// A call's life: the door records it (validated first, so a bad payload never
// consumes a single-use callback), which queues its body as work in the same
// transaction. The body then runs under the run's lease, now or from that work
// row: marked started first (the call lands), run, and only then are the
// run's awaits on the callback woken. A body runs at most once after it starts.

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { CALLBACK_AWAIT_TYPE, type CallbackCall, type CallbackParamSpec } from 'engine-contracts';
import type { CallbackSink } from '../movement_engine/host';
import { drainAwaits, type StepperFor } from './drain';
import type { HeldRunLease } from './lease';
import { failRun, queueAwaitWake, CANCELLED_BY_OPERATOR, type RunHost } from './rules';
import type { AwaitKeeper, CallbackRecord, CallbackStatus, CallbackStore, RunHostStore } from './store';

// ── The id ──────────────────────────────────────────────────────────────────

/** Every door's one recognition test. Compared, never parsed. */
export const CALLBACK_ID_PREFIX = 'cb_';

export function isCallbackId(value: string): boolean {
  return value.startsWith(CALLBACK_ID_PREFIX);
}

/** A fresh id: the prefix and 24 random bytes. The id is the authorization,
 *  so it must not be guessable. */
export function newCallbackId(): string {
  return CALLBACK_ID_PREFIX + randomBytes(24).toString('base64url');
}

/** The link a callback's `url` reads, under the host's public base. */
export function callbackUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/cb/${id}`;
}

// ── The body's work row ─────────────────────────────────────────────────────

export const CALLBACK_BODY_WORK_KIND = 'fire_callback';

export const CallbackBodyPayload = z.object({
  callbackId: z.string(),
  teamId: z.string(),
  callIndex: z.number().int().nonnegative(),
});

/** A recorded call's body, as the work row that runs it. */
export interface CallbackBodyWork {
  kind: typeof CALLBACK_BODY_WORK_KIND;
  key: string;
  teamId: string;
  payload: z.infer<typeof CallbackBodyPayload>;
  dueAt: string;
}

/** One recorded call's body as a work row, keyed by the call, so a call is
 *  queued once however often this is reached. */
export function callbackBodyWork(input: { callbackId: string; teamId: string; callIndex: number; dueAt: string }): CallbackBodyWork {
  const payload: z.infer<typeof CallbackBodyPayload> = { callbackId: input.callbackId, teamId: input.teamId, callIndex: input.callIndex };
  return {
    kind: CALLBACK_BODY_WORK_KIND,
    key: `${CALLBACK_BODY_WORK_KIND}:${input.callbackId}:${input.callIndex}`,
    teamId: input.teamId,
    payload,
    dueAt: input.dueAt,
  };
}

// ── The rule a call is judged by ────────────────────────────────────────────

/**
 * Why a callback refuses, or null when it accepts, shared by the door that
 * records a new call and the queued body of a call already recorded. Revoked
 * refuses both. A new call is refused by a single-use callback that already
 * fired, and by expiry; a recorded call is not: firing it is what made the
 * callback `fired`, and it was recorded inside its window.
 */
export function callbackRefusal(
  callback: { status: CallbackStatus; expiresAt: string | null },
  opts: { for: 'a new call' | 'a recorded call'; now: string },
): 'closed' | 'expired' | null {
  if (callback.status === 'revoked') return 'closed';
  if (opts.for === 'a recorded call') return null;
  if (callback.status === 'fired') return 'closed';
  if (callback.expiresAt !== null && Date.parse(callback.expiresAt) <= Date.parse(opts.now)) return 'expired';
  return null;
}

export type CallbackValueCoercion = { ok: true; values: Record<string, unknown> } | { ok: false; message: string };

/**
 * Validate a call's supplied values against the stored signature. Every
 * declared parameter must be present and coercible to its declared type; an
 * undeclared key is a mismatch too: a silent drop is the absence of a
 * guarantee, not a weaker one.
 */
export function coerceCallbackValues(params: CallbackParamSpec[], raw: Record<string, unknown>): CallbackValueCoercion {
  const declared = new Set(params.map((p) => p.name));
  const extra = Object.keys(raw).filter((k) => !declared.has(k));
  if (extra.length > 0) {
    return {
      ok: false,
      message:
        params.length === 0
          ? `this callback takes no values, but ${extra.map((e) => `'${e}'`).join(', ')} was sent`
          : `'${extra.join("', '")}' is not a parameter of this callback — it takes: ${params.map((p) => `${p.name} (${p.type})`).join(', ')}`,
    };
  }
  const values: Record<string, unknown> = {};
  for (const param of params) {
    if (!Object.prototype.hasOwnProperty.call(raw, param.name) || raw[param.name] === undefined) {
      return { ok: false, message: `missing '${param.name}' — this callback expects ${params.map((p) => `${p.name} (${p.type})`).join(', ')}` };
    }
    const coerced = coerceOne(param, raw[param.name]);
    if ('error' in coerced) return { ok: false, message: coerced.error };
    values[param.name] = coerced.value;
  }
  return { ok: true, values };
}

function coerceOne(param: CallbackParamSpec, raw: unknown): { value: unknown } | { error: string } {
  const bad = (saw: string): { error: string } => ({ error: `'${param.name}' expects ${param.type}, but ${saw}` });
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
      return { value: param.type === 'date' ? parsed.toISOString().slice(0, 10) : parsed.toISOString() };
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
      // A handle the calling system owns: passed through, never invented here.
      return { value: raw };
  }
}

// ── The engine's half ───────────────────────────────────────────────────────

/** The calls that have landed (their body started): what `cb-[:Called]->`
 *  reads and an `await cb-[:Called]->` re-checks. */
export function landedCalls(callback: CallbackRecord | null): CallbackCall[] {
  return (callback?.calls ?? []).filter((call) => call.bodyStartedAt !== undefined).map(({ at, values }) => ({ at, values }));
}

/** The engine's callback seam for one run, over the family. `ensureRun`: the
 *  product's run record exists before a callback is minted against it. */
export function callbackSink(
  callbacks: CallbackStore,
  input: { runId: string; teamId: string; url: (id: string) => string; ensureRun?: () => Promise<void> },
): CallbackSink {
  return {
    async mint({ address, params, state, singleUse, expiresAt }) {
      await input.ensureRun?.();
      const { id } = await callbacks.mint({
        teamId: input.teamId,
        runId: input.runId,
        address,
        params,
        state,
        singleUse,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
      return { id, url: input.url(id) };
    },
    calls: async ({ callbackId }) => landedCalls(await callbacks.get({ id: callbackId })),
  };
}

/** The callback's awaits as the run host reaches them: a park on a callback
 *  is resolvable once one of its calls has landed. A withdrawn callback await
 *  closes nothing of its own: the callback is the run's, revoked when the run
 *  ends. */
export function callbackAwaitKeeper(store: RunHostStore, callbacks: CallbackStore): AwaitKeeper {
  return {
    adapterType: CALLBACK_AWAIT_TYPE,
    async loadResolvable({ runId }) {
      const parks = await store.correlations.ofRun({ runId, adapterType: CALLBACK_AWAIT_TYPE });
      if (parks.length === 0) return [];
      const landed = new Set(await callbacks.landed({ ids: [...new Set(parks.map((p) => p.correlationKey))] }));
      return parks.filter((p) => landed.has(p.correlationKey)).map(({ runId: id, teamId, address }) => ({ runId: id, teamId, address }));
    },
    abandon: async () => {},
  };
}

// ── A call ──────────────────────────────────────────────────────────────────

/** How a door answers a call. Every outcome but `recorded` is a refusal the
 *  door reports as such, never a silent no-op. */
export type CallbackCallOutcome =
  | { kind: 'recorded'; callback: CallbackRecord; callIndex: number }
  | { kind: 'not_found' }
  | { kind: 'closed'; callback: CallbackRecord }
  | { kind: 'expired'; callback: CallbackRecord }
  | { kind: 'mismatch'; callback: CallbackRecord; message: string };

/**
 * Validate and record a call. Its body is queued with it, due at
 * `bodyDueAt`; a caller that runs the body at once makes that the backstop
 * for a crash. A durable wake of the callback's awaits is queued too, due at
 * `wakeDueAt` and coalesced per callback: a wake lost to a crash still finds
 * the landed call.
 */
export async function recordCallbackCall(
  host: RunHost,
  callbacks: CallbackStore,
  input: { id: string; values: Record<string, unknown>; bodyDueAt: string; wakeDueAt: string },
): Promise<CallbackCallOutcome> {
  const existing = await callbacks.get({ id: input.id });
  if (existing === null) return { kind: 'not_found' };
  const coerced = coerceCallbackValues(existing.params, input.values);
  if (!coerced.ok) return { kind: 'mismatch', callback: existing, message: coerced.message };
  const claim = await callbacks.record({ id: input.id, values: coerced.values, bodyDueAt: input.bodyDueAt });
  if (claim.kind !== 'recorded') return claim;
  await queueAwaitWake(
    host.store,
    { adapterType: CALLBACK_AWAIT_TYPE, teamId: claim.callback.teamId, correlationKey: claim.callback.id },
    { coalesceKey: `callback_backstop:${claim.callback.id}`, dueAt: input.wakeDueAt },
  );
  return claim;
}

/** What a body segment came to. A failed body fails its segment, never the
 *  run: the call is recorded, and the run carries on. */
export type CallbackBodyOutcome =
  | { kind: 'ran' }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason?: string }
  | { kind: 'leaseLost' };

/** Why a queued body was not run, or that it was. `not_started`: the lease
 *  went before the body began, so it is left to its work row. */
export type CallbackBodyRun = { kind: 'ran'; outcome: CallbackBodyOutcome } | { kind: 'not_started' } | { kind: 'refused'; reason: string };

/**
 * Run recorded call `callIndex`'s body under the run lease the caller holds,
 * then wake the run's awaits on the callback. Everything that decides
 * whether it runs is read again here, under the lease: the callback's rule
 * for a recorded call, a body already started, and `runOpen` (the product's
 * run record, in case revocation has not caught up with the run's end).
 */
export async function runCallbackBody(
  host: RunHost,
  callbacks: CallbackStore,
  input: {
    id: string;
    callIndex: number;
    lease: HeldRunLease;
    now: string;
    runOpen: (runId: string) => Promise<boolean>;
    body: (input: { callback: CallbackRecord; values: Record<string, unknown> }) => Promise<CallbackBodyOutcome>;
    stepper: StepperFor;
  },
): Promise<CallbackBodyRun> {
  const { id, callIndex, lease } = input;
  const callback = await callbacks.get({ id });
  if (callback === null) return { kind: 'refused', reason: 'its callback is gone' };
  const call = callback.calls[callIndex];
  if (call === undefined) return { kind: 'refused', reason: `its callback has no call ${callIndex}` };
  const refused = callbackRefusal(callback, { for: 'a recorded call', now: input.now });
  if (refused !== null) return { kind: 'refused', reason: `its callback is ${refused}` };
  if (call.bodyStartedAt !== undefined) return { kind: 'refused', reason: 'its body already started' };
  if (!(await input.runOpen(callback.runId))) return { kind: 'refused', reason: 'its run has ended' };
  // Marked before the body starts: at most once after start, a crash
  // included. A lapsed holder neither marks nor runs it.
  if (lease.isLost() || !(await callbacks.markBodyStarted({ id, callIndex, fence: lease.token }))) return { kind: 'not_started' };

  const outcome = await input.body({ callback, values: call.values });
  switch (outcome.kind) {
    case 'leaseLost':
      // Started, so never run again; the run's awaiters are the new holder's.
      return { kind: 'ran', outcome };
    case 'cancelled':
      await failRun(host, { runId: callback.runId, message: outcome.reason ?? CANCELLED_BY_OPERATOR, fence: lease.token });
      return { kind: 'ran', outcome };
    case 'ran':
    case 'failed':
      break;
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled callback body outcome ${JSON.stringify(unreachable)}`);
    }
  }
  // The awaiters last: a body that wrote what the awaiting continuation reads
  // has written it.
  const parks = (
    await host.store.correlations.correlated({ adapterType: CALLBACK_AWAIT_TYPE, teamId: callback.teamId, correlationKey: callback.id })
  ).filter((p) => p.runId === callback.runId);
  if (parks.length > 0) await drainAwaits(host, { runId: callback.runId, extra: parks, lease, stepper: input.stepper });
  return { kind: 'ran', outcome };
}
