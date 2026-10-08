// What one run SEGMENT carries about itself, as engine state: the run it
// belongs to, the language version it is pinned to, its cancel gate, the
// cross-run locks its effects take, the host segment it opened, and the run's
// spend account.
//
// None of it is ambient. Each entry point opens one context (`openRunContext`)
// and the interpreter hands it, or the part a callee needs (`RunFacts`), to
// whatever it calls. The host-side half of a segment — what an adapter has
// already read, how many third-party calls the segment has made — lives behind
// the host's `segment` family, keyed by the `segmentId` opened here.
//
// ── The spend account ───────────────────────────────────────────────────────
//
// The engine keeps the run's account (`RunLedger`): every priced host call
// is handed the run's remaining `Budget` and reports what it spent as cost
// lines, which the ledger charges. The host enforces the budget inside the
// call (a plugin's third scrape is refused there); the engine raises the cap
// from its own figures (`RunCostCapExceeded`) and suspends the run on it.
//
// The account belongs to the RUN, not the segment: a run that parks and
// resumes is seeded with what it spent before (`priorMicrodollars`), or a run
// that parks and resumes in a loop would never meet its cap. Resuming a run
// paused at its cap resets its usage: the cap counts from
// `capBaselineMicrodollars`, what the run had spent when it was last resumed
// from a limit pause. The cap itself is run input (`costCapMicrodollars`),
// read by the run host, never by the engine.

import { CURRENT_LANGUAGE_VERSION, type FileArtifactType, type LanguageVersion } from 'movement-lang';

import { HOST_FAMILIES_VERSION, guidSequence, missingHostMethods, type ActingPrincipal, type TenantId } from 'engine-contracts';
import type { FileRef } from '../translation_graph/adapter';
import type { LlmClient } from '../translation_graph/engine/batched_extraction/llm_call';
import type { ArbitrationAnswer, EntityArbitration } from './host';
import type { CrossRunLocks } from './effect_locks';
import type { FileTextResolution, MovementTraceEntry } from './expression';
import type { ExtractCallLlmClient } from './extraction_call';
import type {
  AdapterResolution,
  AwaitWakeRequest,
  BudgetRefusal,
  CallbackSink,
  EngineHost,
  PricedAnswer,
  RecordBindings,
  ResolveActingUserInput,
  ResolvedAdapter,
} from './host';
import type { CancelGate, ParkSink } from './run';

import { pluginSpecNamed, type MovementTransformInvoker, type PluginSpecs } from './extraction';
import { getErrorMessage } from '../../lib/utils/error';
import { logger } from '../logger';
import { MovementEngineError, RunCancelledSignal } from './errors';
import {
  RunCostCapExceeded,
  type Budget,
  type CostLine,
  type RunSpend,
} from '../../lib/run_cost';

// ── The run's facts ─────────────────────────────────────────────────────────

/** What a piece of the engine running inside a statement needs of its run. */
export interface RunFacts {
  /** The movement's pinned language version. */
  readonly languageVersion: LanguageVersion;
  /** The run's cancel gate, for the boundaries inside a statement (an LLM
   *  call, a plugin invocation) that no statement-level check can reach. */
  readonly cancel: CancelGate;
  /** The run this segment belongs to, named on the engine's log lines. */
  readonly runId?: string;
  /** The host's clock, as this segment asks it. */
  readonly clock: EngineClock;
  /** The host's id minting, as this segment asks it. */
  readonly ids: IdMint;
}

/** The instant now, from the host (`clock.now`). */
export interface EngineClock {
  now(): Promise<Date>;
}

/** `count` fresh ids, from the host (`ids.mint`). */
export interface IdMint {
  mint(count: number): Promise<string[]>;
}

/** The host's clock and ids as a piece of the engine called outside a run
 *  asks them: a script hands a bare host's (`BARE_HOST`, host_kit.ts). */
export interface ClockAndIds {
  readonly clock: EngineClock;
  readonly ids: IdMint;
}

/** For a caller that hands neither a run nor a host (a test driving the
 *  extraction directly): one fixed instant, so every duration reads 0, and
 *  a fresh GUID sequence. */
export function hostless(): ClockAndIds {
  const instant = new Date('2026-01-01T00:00:00.000Z');
  const guids = guidSequence();
  return { clock: { now: async () => instant }, ids: { mint: async (count) => guids.take(count) } };
}

/** A stopwatch on `clock`, started now: each read answers the milliseconds
 *  since. */
export async function stopwatch(clock: EngineClock): Promise<() => Promise<number>> {
  const started = (await clock.now()).getTime();
  return async () => (await clock.now()).getTime() - started;
}

/** One segment's engine state. */
export interface RunContext extends RunFacts {
  readonly teamId: TenantId;
  /** The host segment this one opened (`host.segment.open`): every host call
   *  names it. */
  readonly segmentId: string;
  /** The host as this segment calls it: every family bound to the segment, so
   *  no call site names it, or can name another. */
  readonly host: SegmentHost;
  /** The cross-run write locks this segment's effects take, each held for
   *  its effect (`effect_locks.ts`): the host's `locks`, named by this
   *  segment. The lock session is the host's, and closes with the segment. */
  readonly locks: CrossRunLocks;
  readonly ledger: RunLedger;
  /** The instant every clock read a program makes answers from: the run's
   *  `firedAt`, or — handed none — the host's clock as the segment opened. */
  readonly pinnedNow: Date;
  /** The segment's decision trace, and how much of it the host has been
   *  handed (`host.trace.append`). */
  readonly trace: { readonly entries: MovementTraceEntry[]; published: number };
}

/** The pin a callee honours: its run's, or — outside a run (a script, a test
 *  calling the extraction directly) — the current version. */
export function languageVersionOf(run: RunFacts | undefined): LanguageVersion {
  return run?.languageVersion ?? CURRENT_LANGUAGE_VERSION;
}

/**
 * The cancel check every boundary INSIDE a statement makes (runs-and-cancel
 * spec §cancel). The interpreter's own check runs between statements, which is
 * no use to an extraction: one `extract` is one statement, and all of its work
 * — an LLM call per region, a plugin invocation per entity per stage, and a
 * fetch inside that plugin that may take minutes — happens before the next
 * statement boundary is ever reached. An extraction that is the movement's last
 * (or only) statement has no next boundary at all, so without this a cancel is
 * never honoured and the run settles `success` as if nothing had been asked.
 *
 * The read is a real one, not a cached last-known value: a cached value could
 * only repeat what the statement boundary already knew, and the point is that
 * the operator pressed Stop after it ran. The gate debounces to one read every
 * few seconds across every boundary of the run, so checking this often costs
 * nothing. Outside a run there is nothing to cancel.
 *
 * Refusing preemption is fine at a boundary this coarse: a fetch already in
 * flight runs to its own timeout, and the cancel lands before the NEXT one.
 */
export async function throwIfCancelled(run: Pick<RunFacts, 'cancel'> | undefined): Promise<void> {
  if (run !== undefined && (await run.cancel.cancelled())) throw new RunCancelledSignal();
}

/**
 * The run a log line belongs to, as structured log fields — spread into the
 * engine's `logger.*` calls. A line with no run on it cannot answer "what was
 * THIS run waiting on?". Outside a run, or for a run with no id (a test run),
 * the bag is empty.
 */
export function runLogFields(run: Pick<RunFacts, 'runId'> | undefined): { runId?: string } {
  return run?.runId !== undefined ? { runId: run.runId } : {};
}

// ── The spend account ───────────────────────────────────────────────────────

export class RunLedger {
  // Every member of a MAP, every parallel branch, charges this one object.
  // JavaScript runs each charge to completion, so no two can interleave.
  private segment = 0;
  private readonly bySource = new Map<string, number>();
  private readonly prior: number;
  private readonly capBaseline: number;
  private readonly cap: number | undefined;

  constructor(options: {
    /** What the run spent in its earlier segments. */
    priorMicrodollars?: number;
    /** The run's spend when it was last resumed from a limit pause; the cap
     *  counts only what was spent after it. */
    capBaselineMicrodollars?: number;
    /** The cap, or undefined for none. */
    capMicrodollars?: number;
  }) {
    this.prior = options.priorMicrodollars ?? 0;
    this.capBaseline = options.capBaselineMicrodollars ?? 0;
    this.cap = options.capMicrodollars;
  }

  /** What the run has spent against its cap. */
  private get sinceReset(): number {
    return this.prior + this.segment - this.capBaseline;
  }

  /** What the next priced call may spend. */
  budget(): Budget {
    return { remainingMicrodollars: this.cap === undefined ? null : this.cap - this.sinceReset };
  }

  /** Charge what a priced host call reports it spent. A malformed line fails
   *  the run rather than charging nothing — a host that misreports a price is
   *  broken, and charging it nothing would be the silent version of that. */
  charge(cost: readonly CostLine[] | undefined): void {
    for (const line of cost ?? []) {
      if (
        typeof line?.source !== 'string' ||
        typeof line.microdollars !== 'number' ||
        !Number.isFinite(line.microdollars) ||
        line.microdollars < 0
      ) {
        throw new Error(
          `a cost report must be { source, microdollars } with a non-negative, finite number of microdollars; got ${JSON.stringify(line)}`,
        );
      }
      const microdollars = Math.round(line.microdollars);
      this.segment += microdollars;
      this.bySource.set(line.source, (this.bySource.get(line.source) ?? 0) + microdollars);
    }
  }

  /** The cap met, in the run's own figures; undefined while it is not. */
  exceeded(): RunCostCapExceeded | undefined {
    const cap = this.cap;
    return cap !== undefined && this.sinceReset >= cap
      ? new RunCostCapExceeded(cap, this.sinceReset)
      : undefined;
  }

  /** Refuse priced work once the run has spent its cap. */
  check(): void {
    const exceeded = this.exceeded();
    if (exceeded !== undefined) throw exceeded;
  }

  get spend(): RunSpend {
    return {
      segmentMicrodollars: this.segment,
      runMicrodollars: this.prior + this.segment,
      bySource: Object.fromEntries(this.bySource),
    };
  }
}

/**
 * One priced host call: handed the run's budget, its reported cost charged.
 * A call the host refused past the budget is charged what it spent before the
 * refusal and raised as the run's cap, from the run's figures.
 */
async function charged<Output extends object>(
  ledger: RunLedger,
  call: (budget: Budget) => Promise<PricedAnswer<Output>>,
): Promise<Output> {
  const answer = await call(ledger.budget());
  ledger.charge(answer.cost);
  if (isBudgetRefusal(answer)) throw ledger.exceeded() ?? new Error(answer.error.message);
  return answer;
}

function isBudgetRefusal<Output extends object>(answer: PricedAnswer<Output>): answer is BudgetRefusal {
  return (
    'error' in answer &&
    typeof answer.error === 'object' &&
    answer.error !== null &&
    'kind' in answer.error &&
    answer.error.kind === 'budget'
  );
}

/** The host's priced families as the interpreter calls them: the run's budget
 *  goes in and what each call spent is charged, so no call site can forget
 *  either. */
export interface PricedCalls {
  client: LlmClient;
  extractCall: ExtractCallLlmClient;
  transforms: MovementTransformInvoker;
  arbitrateEntities: (input: EntityArbitration) => Promise<ArbitrationAnswer>;
  resolveFileText: (input: { file: FileRef }) => Promise<FileTextResolution>;
}

export function pricedCalls(
  host: EngineHost,
  run: {
    /** The segment every call is made in. */
    segmentId: string;
    ledger: RunLedger;
    /** The run's catalog snapshot's plugins: which of them are priced. */
    plugins: PluginSpecs;
  },
): PricedCalls {
  const { llm, files } = host;
  const { segmentId, ledger, plugins } = run;
  return {
    client: { call: (input) => charged(ledger, (budget) => llm.client.call({ ...input, segmentId, budget })) },
    extractCall: {
      call: (input) => charged(ledger, (budget) => llm.extractCall.call({ ...input, segmentId, budget })),
    },
    transforms: {
      // A priced plugin is refused before it starts once the run has spent
      // its cap; anything it or the models it calls spend comes back as cost.
      invoke: async (input) => {
        if (pluginSpecNamed(plugins, input.plugin)?.priced === true) ledger.check();
        return charged(ledger, (budget) => llm.transforms.invoke({ ...input, segmentId, budget }));
      },
    },
    arbitrateEntities: async (input) => {
      const { index, judgeUnavailable } = await charged(ledger, (budget) =>
        llm.arbitrateEntities({ ...input, segmentId, budget }),
      );
      return { index, ...(judgeUnavailable !== undefined ? { judgeUnavailable } : {}) };
    },
    resolveFileText: (input) => charged(ledger, (budget) => files.resolveFileText({ ...input, segmentId, budget })),
  };
}

// ── The host, bound to a segment ────────────────────────────────────────────

/** The host's unpriced families as one segment calls them: each request
 *  carries the segment's id, added here and nowhere else. (The priced
 *  families are `PricedCalls`; adapter calls name the segment through their
 *  stand-in, `host_adapter.ts`.) */
export interface SegmentHost {
  adapters: { resolve(input: AdapterResolution): Promise<ResolvedAdapter> };
  park: {
    sink?: ParkSink;
    wake(request: AwaitWakeRequest): Promise<void>;
    callbacks?: CallbackSink;
    bindings: RecordBindings;
  };
  control: { cancel: CancelGate };
  files: { render(input: { content: string; type: FileArtifactType }): Promise<FileRef> };
  lookup: { resolveActingUser(input: ResolveActingUserInput): Promise<ActingPrincipal | null> };
  clock: EngineClock;
  ids: IdMint;
}

function bindSegment(host: EngineHost, segmentId: string): SegmentHost {
  const { sink, callbacks, bindings } = host.park;
  const cancel = host.control.cancel;
  return {
    adapters: { resolve: (input) => host.adapters.resolve({ ...input, segmentId }) },
    park: {
      ...(sink !== undefined ? { sink: bindParkSink(sink, segmentId) } : {}),
      wake: (request) => host.park.wake({ ...request, segmentId }),
      ...(callbacks !== undefined
        ? {
            callbacks: {
              mint: (input) => callbacks.mint({ ...input, segmentId }),
              calls: (input) => callbacks.calls({ ...input, segmentId }),
            },
          }
        : {}),
      bindings: {
        record: (input) => bindings.record({ ...input, segmentId }),
        findBoundCounterpart: (input) => bindings.findBoundCounterpart({ ...input, segmentId }),
        delete: (input) => bindings.delete({ ...input, segmentId }),
      },
    },
    control: {
      cancel: {
        cancelled: () => cancel.cancelled({ segmentId }),
        cancelledNow: () => cancel.cancelledNow({ segmentId }),
      },
    },
    files: { render: (input) => host.files.render({ ...input, segmentId }) },
    lookup: { resolveActingUser: (input) => host.lookup.resolveActingUser({ ...input, segmentId }) },
    clock: { now: async () => instantFrom(await host.clock.now({ segmentId })) },
    ids: {
      mint: async (count) => (count === 0 ? [] : mintedFrom(await host.ids.mint({ segmentId, count }), count)),
    },
  };
}

/** The host clock's answer, read at the boundary: a clock that answered
 *  "Invalid Date" would make every instant the run computes wrong without
 *  saying so. */
function instantFrom(answer: unknown): Date {
  const nowIso: unknown = typeof answer === 'object' && answer !== null ? Reflect.get(answer, 'nowIso') : undefined;
  const instant = typeof nowIso === 'string' ? new Date(nowIso) : undefined;
  if (instant === undefined || Number.isNaN(instant.getTime())) {
    throw new Error(`clock.now answered ${JSON.stringify(answer)}, which is not { nowIso: <an ISO 8601 instant> }`);
  }
  return instant;
}

function mintedFrom(answer: unknown, count: number): string[] {
  if (
    !Array.isArray(answer) ||
    answer.length !== count ||
    !answer.every((id): id is string => typeof id === 'string' && id.length > 0) ||
    new Set(answer).size !== count
  ) {
    throw new Error(`ids.mint was asked for ${count} ids and answered ${JSON.stringify(answer)}, which is not ${count} distinct strings`);
  }
  return answer;
}

/** The run's pinned instant, from the ISO string it is handed. A string that
 *  names no instant is refused: a clock that read "Invalid Date" would make
 *  every date the run computes wrong without saying so. */
function firedInstant(firedAt: string): Date {
  const instant = new Date(firedAt);
  if (Number.isNaN(instant.getTime())) {
    throw new MovementEngineError('MOVENG_RUNTIME', `firedAt '${firedAt}' is not an ISO 8601 instant`);
  }
  return instant;
}

function bindParkSink(sink: NonNullable<EngineHost['park']['sink']>, segmentId: string): ParkSink {
  const { commitSuspension, commitLimitPause } = sink;
  return {
    recordJoin: (input) => sink.recordJoin({ ...input, segmentId }),
    commitTimerPark: (input) => sink.commitTimerPark({ ...input, segmentId }),
    commitAwaitPark: (input) => sink.commitAwaitPark({ ...input, segmentId }),
    decrementJoin: (input) => sink.decrementJoin({ ...input, segmentId }),
    persistBranchExport: (input) => sink.persistBranchExport({ ...input, segmentId }),
    collectBranchExports: (input) => sink.collectBranchExports({ ...input, segmentId }),
    cancelSubtrees: (input) => sink.cancelSubtrees({ ...input, segmentId }),
    // Optional within the family: a sink without them cannot suspend.
    ...(commitSuspension !== undefined
      ? { commitSuspension: (input) => commitSuspension.call(sink, { ...input, segmentId }) }
      : {}),
    ...(commitLimitPause !== undefined
      ? { commitLimitPause: (pause) => commitLimitPause.call(sink, { ...pause, segmentId }) }
      : {}),
  };
}

// ── Opening and closing a segment ───────────────────────────────────────────

/** Open one segment: its host segment, the cross-run locks its effects take
 *  through it, and the run's account seeded with what the run spent before
 *  it. */
export async function openRunContext(input: {
  host: EngineHost;
  teamId: TenantId;
  runId?: string;
  languageVersion: LanguageVersion;
  /** When the run first fired (ISO 8601); absent, the segment pins the host's
   *  clock as it opens. */
  firedAt?: string;
  spend: ConstructorParameters<typeof RunLedger>[0];
}): Promise<RunContext> {
  const { host, teamId, runId, languageVersion } = input;
  // A host written against an earlier manifest lacks a family the engine now
  // asks of every run: refused here, before anything is opened on it.
  const missing = missingHostMethods(host);
  if (missing.length > 0) {
    const families = [...new Set(missing.map((path) => familyOf(path)))];
    throw new MovementEngineError(
      'MOVENG_UNSUPPORTED',
      `the host does not serve ${missing.join(', ')}, which host families version ${HOST_FAMILIES_VERSION} requires ` +
        `(the ${families.join(', ')} ${families.length === 1 ? 'family' : 'families'}); no segment was opened`,
    );
  }
  const { segmentId } = await host.segment.open({
    teamId,
    languageVersion,
    hostFamiliesVersion: HOST_FAMILIES_VERSION,
    ...(runId !== undefined ? { runId } : {}),
  });
  const bound = bindSegment(host, segmentId);
  const context = (pinnedNow: Date): RunContext => ({
    teamId,
    languageVersion,
    cancel: bound.control.cancel,
    clock: bound.clock,
    ids: bound.ids,
    ...(runId !== undefined ? { runId } : {}),
    segmentId,
    host: bound,
    locks: {
      acquire: async (names) => (await host.locks.acquire({ segmentId, names })).token,
      release: (token) => host.locks.release({ segmentId, token }),
    },
    ledger: new RunLedger(input.spend),
    pinnedNow,
    trace: { entries: [], published: 0 },
  });
  try {
    return context(input.firedAt !== undefined ? firedInstant(input.firedAt) : await bound.clock.now());
  } catch (error) {
    // The segment is open: it closes however its opening ends.
    await closeRunContext(context(new Date(0)), host);
    throw error;
  }
}

/** A method path's family: everything before its last dot. */
function familyOf(path: string): string {
  return path.slice(0, path.lastIndexOf('.'));
}

/** Hand the host the trace entries it has not seen yet. */
export async function publishTrace(context: RunContext, host: EngineHost): Promise<void> {
  const { trace } = context;
  if (host.trace === undefined || trace.published >= trace.entries.length) return;
  const entries = trace.entries.slice(trace.published);
  trace.published = trace.entries.length;
  await host.trace.append({ segmentId: context.segmentId, entries });
}

/**
 * End a segment however it ended: close its host segment (which lets go of
 * its cross-run locks) and charge what the host says the segment's adapter
 * calls spent (a model call an adapter makes to match a record). Nothing here
 * throws: this runs in the segment's `finally`, where a failure would replace
 * the run's own result or error. A failure is logged with the run it belongs
 * to.
 */
export async function closeRunContext(context: RunContext, host: EngineHost): Promise<void> {
  await settled('hand the host the rest of its trace', context, () => publishTrace(context, host));
  await settled('close its host segment', context, async () => {
    const { cost } = await host.segment.close({ segmentId: context.segmentId });
    context.ledger.charge(cost);
  });
}

async function settled(step: string, context: RunContext, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.error(`[movement] a segment that ended could not ${step}`, {
      segmentId: context.segmentId,
      error: getErrorMessage(error),
      ...runLogFields(context),
    });
  }
}
