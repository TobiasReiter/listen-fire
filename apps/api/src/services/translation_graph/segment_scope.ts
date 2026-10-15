// The host's half of a run SEGMENT: what its adapter calls have already read
// (the memo below), how many third-party calls they have made (the ceiling),
// which language version they answer under, and what they spent on priced
// work of their own. The engine opens a segment through the host's `segment`
// family and names it on every adapter call; the host runs each call inside
// the segment's scope (`segmentScopedCalls`).
//
// The scope is ambient INSIDE the host, on purpose: the API clients are
// process-wide singletons shared by every run in the process, far below the
// adapter method that reached them, so the segment has to arrive the way the
// billing context does. The engine never reads it — it only holds the
// segment's id.
//
// ── The ceiling ─────────────────────────────────────────────────────────────
//
// A ceiling on how many network calls one segment may make to a third-party
// system.
//
// The failure this catches is a read that was supposed to be narrowed and
// wasn't: a filter that didn't push down turns "the three organizations this
// person works at" into a walk of the whole workspace, one page at a time,
// forever. Nothing else notices — the run is not stuck, it is working, and it
// is burning someone's API quota to do it. The ceiling stops it and says so:
// the engine is answered with a `call_ceiling` error.
//
// One segment, one count. A run that parks on an `ask` and resumes hours later
// starts fresh: a spiral happens inside a single segment, and carrying a count
// across processes would cost machinery that buys nothing.

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { CURRENT_LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { EngineHost, SegmentOpening } from 'movement-engine/services/movement_engine/host';

import { NO_BUDGET_LIMIT, type CostLine } from 'movement-engine/lib/run_cost';
import { SpendMeter, underSpendMeter } from '../../lib/run_spend';
import { logger } from 'movement-engine/services/logger';
import { adapterErrorOf, type ClassifyHostError } from 'movement-engine/services/translation_graph/engine/adapter_table';
import { teamOfTenant, tenantOfTeam } from './movement/tenant';

/** The systems that count against a ceiling. One entry per system that has its
 *  own env var below; a system not listed here is simply not capped. */
export type AdapterCallSystem = 'affinity';

const CEILING_ENV_VAR: Record<AdapterCallSystem, string> = {
  affinity: 'AFFINITY_MAX_CALLS_PER_RUN',
};

const DEFAULT_CEILING: Record<AdapterCallSystem, number> = {
  affinity: 2000,
};

const SYSTEM_LABEL: Record<AdapterCallSystem, string> = {
  affinity: 'Affinity',
};

/** Read per call so ops (and tests) can move the ceiling without a restart.
 *  A missing, zero, or unparseable value means the default — the safeguard is
 *  always on, there is no "unlimited". */
function ceilingFor(system: AdapterCallSystem): number {
  const fromEnv = Number(process.env[CEILING_ENV_VAR[system]]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_CEILING[system];
}

/**
 * An adapter call refused because its segment made as many calls to a
 * third-party system as one segment may — raised by the call that would have
 * gone one over, inside the host. The host answers the engine with it as a
 * `call_ceiling` error (`segmentScopedCalls`); an adapter that catches its own
 * failures lets this one through (`isAdapterCallCeilingExceeded`).
 */
export class AdapterCallCeilingExceeded extends Error {
  readonly kind = 'call_ceiling';
  constructor(
    /** The system that counts, e.g. `affinity`. */
    readonly system: string,
    readonly calls: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterCallCeilingExceeded';
  }
}

export function isAdapterCallCeilingExceeded(err: unknown): err is AdapterCallCeilingExceeded {
  return err instanceof AdapterCallCeilingExceeded;
}

/** The call that would have gone one over. Its message is the whole failure
 *  surface an author sees, so it says the number, the knob, and why the run
 *  stopped. */
function ceilingExceeded(system: AdapterCallSystem, calls: number): AdapterCallCeilingExceeded {
  return new AdapterCallCeilingExceeded(
    system,
    calls,
    `${SYSTEM_LABEL[system]} call ceiling reached: this run made ${calls} ${SYSTEM_LABEL[system]} API calls, ` +
      `the limit set by ${CEILING_ENV_VAR[system]}. The run was stopped in case something was looping.`,
  );
}

class SegmentCallLedger {
  private readonly counts = new Map<AdapterCallSystem, number>();

  count(system: AdapterCallSystem): void {
    const ceiling = ceilingFor(system);
    const next = (this.counts.get(system) ?? 0) + 1;
    if (next > ceiling) throw ceilingExceeded(system, ceiling);
    this.counts.set(system, next);
  }

  calls(system: AdapterCallSystem): number {
    return this.counts.get(system) ?? 0;
  }
}

// ── The read memo ───────────────────────────────────────────────────────────

/**
 * What this segment has already READ from a third party.
 *
 * Inside one run the same record is asked for over and over: the engine reads
 * it to decide whether anything changed, the adapter reads it again to write
 * it, and a second write to the same record reads it a third time. Nothing
 * happened in between except our own writes — so the answer is already in the
 * process, and asking again spends someone's API quota to be told what we
 * know.
 *
 * The lifetime is the segment, deliberately. A memo that outlived the run would
 * have to reason about who else might be editing the workspace; a memo that
 * dies with it only has to reason about what the run ITSELF wrote — which it
 * can, exactly, because it did the writing. That is what `forget` is for: every
 * write evicts the reads it invalidated, so "stale" here means "stale by
 * someone else's hand, within one run", which is the same window a single
 * uncached read already has.
 *
 * The PROMISE is stored, so callers asking at the same moment share one flight.
 */
class SegmentReadMemo {
  private readonly reads = new Map<string, Promise<unknown>>();

  read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.reads.get(key);
    if (hit) return hit as Promise<T>;
    // A rejected read is not an answer. Remembering it would serve the failure
    // to every later caller and never retry.
    const pending: Promise<T> = load().catch((err) => {
      if (this.reads.get(key) === pending) this.reads.delete(key);
      throw err;
    });
    this.reads.set(key, pending);
    return pending;
  }

  /** File a record we were HANDED rather than asked for — a create's or an
   *  update's own response is the record, and the next read of it should not
   *  be a request. */
  fill(key: string, value: unknown): void {
    this.reads.set(key, Promise.resolve(value));
  }

  forget(keys: readonly string[]): void {
    for (const key of keys) this.reads.delete(key);
  }

  forgetUnder(prefix: string): void {
    for (const key of [...this.reads.keys()]) {
      if (key.startsWith(prefix)) this.reads.delete(key);
    }
  }
}

// ── The segment ─────────────────────────────────────────────────────────────

class SegmentScope {
  readonly ledger = new SegmentCallLedger();
  readonly memo = new SegmentReadMemo();
  /** What the segment's adapter calls spent on priced work of their own — a
   *  model call an adapter makes to match a record. Unbudgeted: an adapter
   *  call carries no budget, so the run's cap meets this spend when the
   *  segment closes and charges it. */
  readonly spend = new SpendMeter(NO_BUDGET_LIMIT);

  constructor(
    readonly teamId: TeamId,
    readonly languageVersion: LanguageVersion,
    readonly runId: string | undefined,
  ) {}
}

const openSegments = new Map<string, SegmentScope>();
const asyncLocalStorage = new AsyncLocalStorage<SegmentScope>();

function segmentNamed(segmentId: string): SegmentScope {
  const scope = openSegments.get(segmentId);
  if (scope === undefined) {
    throw new Error(`no open segment '${segmentId}': an adapter call named a segment that was never opened, or one that has closed`);
  }
  return scope;
}

/** Open a segment: a fresh memo, a fresh count. The host families version is
 *  the host's to check, before it opens one (`openSegmentWith`). */
export async function openSegment(input: Omit<SegmentOpening, 'hostFamiliesVersion'>): Promise<{ segmentId: string }> {
  const segmentId = randomUUID();
  openSegments.set(segmentId, new SegmentScope(teamOfTenant(input.teamId), input.languageVersion, input.runId));
  return { segmentId };
}

/** Close a segment, answering what its adapter calls spent. Closing one that
 *  is not open answers nothing: the close in a `finally` must not mask the
 *  failure it is cleaning up after. */
export async function closeSegment(input: { segmentId: string }): Promise<{ cost: CostLine[] }> {
  const scope = openSegments.get(input.segmentId);
  openSegments.delete(input.segmentId);
  return { cost: scope?.spend.cost() ?? [] };
}

/** The host's `segment` family. */
export const hostSegments: EngineHost['segment'] = { open: openSegment, close: closeSegment };

function inScope<T>(scope: SegmentScope, fn: () => T): T {
  return asyncLocalStorage.run(scope, () => underSpendMeter(scope.spend, fn));
}

/** Run `fn` inside an open segment's scope — what every call into a
 *  segment-bound adapter does. */
export function inSegment<T>(segmentId: string, fn: () => T): T {
  return inScope(segmentNamed(segmentId), fn);
}

/** Open a segment, run `fn` inside it, close it — for code that is a segment
 *  of its own rather than a run's (scripts, tests of the scope itself). */
export async function withSegment<T>(
  input: Omit<Partial<SegmentOpening>, 'teamId'> & { teamId: TeamId },
  fn: () => Promise<T>,
): Promise<T> {
  const { segmentId } = await openSegment({
    teamId: tenantOfTeam(input.teamId),
    languageVersion: input.languageVersion ?? CURRENT_LANGUAGE_VERSION,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
  });
  try {
    return await inSegment(segmentId, fn);
  } finally {
    await closeSegment({ segmentId });
  }
}

/**
 * How the production host runs an adapter call (`adapter_table.ts`): inside
 * its segment's scope, so the call reads through the segment's memo, counts
 * against its ceiling and answers under its pin; and with what it threw turned
 * into the typed answer the engine contract names. A call into a segment that
 * has closed fails, naming it.
 *
 * The engine is answered the failure's message, name and particulars; its
 * class, stack and cause stay here, so the host logs the original as it
 * classifies it. An adapter call carries no budget (its own priced work is
 * charged as the segment closes), so it is never refused as `budget`.
 */
export const segmentScopedCalls: {
  around: <T>(segmentId: string, call: () => Promise<T>) => Promise<T>;
  classify: ClassifyHostError;
} = {
  around: (segmentId, call) => inSegment(segmentId, call),
  classify: (error, { segmentId }) => {
    if (isAdapterCallCeilingExceeded(error)) return { kind: 'call_ceiling', message: error.message };
    logger.warn('[segment_scope] adapter call failed', {
      segmentId,
      runId: openSegments.get(segmentId)?.runId,
      err: error,
    });
    return adapterErrorOf(error);
  },
};

// ── What an adapter reads off its segment ───────────────────────────────────

/**
 * The language version the current segment is pinned to — what an adapter's
 * `since`/`before` conditional reads. Outside a segment (CLI scripts, catalog
 * describe, tests) there is no pin and this is the current version.
 */
export function currentLanguageVersion(): LanguageVersion {
  return asyncLocalStorage.getStore()?.languageVersion ?? CURRENT_LANGUAGE_VERSION;
}

/**
 * Serve `key` from what this segment has already read, or read it and
 * remember.
 *
 * Outside a segment — CLI scripts, catalog describe, the MCP connection
 * describer, tests — there is no memo and this is exactly `load()`.
 *
 * The key must name the CREDENTIAL as well as the record: one run may speak to
 * two workspaces of the same system, and `person 41` is a different person in
 * each.
 */
export function memoisedRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const memo = asyncLocalStorage.getStore()?.memo;
  return memo ? memo.read(key, load) : load();
}

/** File a record the system just handed back (a create's or an update's own
 *  response), so the next read of it is free. No-op outside a segment. */
export function fillMemoisedRead(key: string, value: unknown): void {
  asyncLocalStorage.getStore()?.memo.fill(key, value);
}

/** Drop what this segment's own write just made wrong. No-op outside one. */
export function forgetMemoisedReads(...keys: string[]): void {
  asyncLocalStorage.getStore()?.memo.forget(keys);
}

/** Drop a whole family of reads — used where a write invalidates an unknown
 *  number of them (a field-value row names its own id, not its owner). */
export function forgetMemoisedReadsUnder(prefix: string): void {
  asyncLocalStorage.getStore()?.memo.forgetUnder(prefix);
}

/**
 * Record one outbound HTTP attempt, throwing once the segment is over its
 * ceiling.
 *
 * Outside a segment — CLI scripts, catalog describe, the MCP connection
 * describer, tests — there is no ledger and this does nothing.
 */
export function countAdapterCall(system: AdapterCallSystem): void {
  asyncLocalStorage.getStore()?.ledger.count(system);
}

/**
 * Bind the CURRENT segment's counter for a call that will execute later, in
 * someone else's async context.
 *
 * The API clients queue their requests behind a shared concurrency limiter, so
 * a queued job is dequeued by whichever other job happened to finish — in that
 * job's async context, not its own. Reading the ledger at that point would
 * charge the wrong segment (or none). Capturing it where the call was ISSUED
 * keeps the count with the segment that asked for it.
 */
export function bindAdapterCallCounter(system: AdapterCallSystem): () => void {
  const ledger = asyncLocalStorage.getStore()?.ledger;
  if (ledger === undefined) return () => {};
  return () => ledger.count(system);
}

/** The calls charged to the current segment so far — diagnostics and tests. */
export function currentSegmentCallCount(system: AdapterCallSystem): number {
  return asyncLocalStorage.getStore()?.ledger.calls(system) ?? 0;
}
