// What one run SEGMENT carries about itself, as engine state: the run it
// belongs to, the language version it is pinned to, its cancel gate, the
// cross-run lock holder its effects take locks through, the host segment it
// opened, and the run's spend account.
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

import { CURRENT_LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { FileRef } from '../translation_graph/adapter';
import type { LlmClient } from '../translation_graph/engine/batched_extraction';
import type { EntityArbitration } from '../translation_graph/engine/entity_match';
import type { WriteLockHolder } from '../write_locks/write_locks';
import type { FileTextResolution } from './expression';
import type { MovementTransformInvoker } from './extraction';
import type { ExtractCallLlmClient } from './extraction_call';
import type { Costed, EngineHost } from './host';
import type { CancelGate } from './run';

import { getErrorMessage } from '../../lib/utils/error';
import { logger } from '../logger';
import { RunCancelledSignal } from './errors';
import {
  isBudgetExhausted,
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
}

/** One segment's engine state. */
export interface RunContext extends RunFacts {
  readonly teamId: TeamId;
  /** The host segment this one opened (`host.segment.open`): every adapter
   *  host call names it. */
  readonly segmentId: string;
  /** The holder of the cross-run write locks this segment's effects take,
   *  each held for its effect (`effect_locks.ts`); the holder's session lives
   *  for the segment. */
  readonly writeLockHolder: WriteLockHolder;
  readonly ledger: RunLedger;
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
export async function throwIfCancelled(run: RunFacts | undefined): Promise<void> {
  if (run !== undefined && (await run.cancel.cancelled())) throw new RunCancelledSignal();
}

/**
 * The run a log line belongs to, as structured log fields — spread into the
 * engine's `logger.*` calls. A line with no run on it cannot answer "what was
 * THIS run waiting on?". Outside a run, or for a run with no id (a test run),
 * the bag is empty.
 */
export function runLogFields(run: RunFacts | undefined): { runId?: string } {
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
 * A call the host refused partway (`BudgetExhausted`) is charged what it spent
 * before the refusal and raised as the run's cap, from the run's figures.
 */
async function charged<Output extends object>(
  ledger: RunLedger,
  call: (budget: Budget) => Promise<Costed<Output>>,
): Promise<Output> {
  let answer: Costed<Output>;
  try {
    answer = await call(ledger.budget());
  } catch (err) {
    if (!isBudgetExhausted(err)) throw err;
    ledger.charge(err.cost);
    throw ledger.exceeded() ?? err;
  }
  ledger.charge(answer.cost);
  return answer;
}

/** The host's priced families as the interpreter calls them: the run's budget
 *  goes in and what each call spent is charged, so no call site can forget
 *  either. */
export interface PricedCalls {
  client: LlmClient;
  extractCall: ExtractCallLlmClient;
  transforms: MovementTransformInvoker;
  arbitrateEntities: (input: EntityArbitration) => Promise<number | null>;
  resolveFileText: (input: { file: FileRef }) => Promise<FileTextResolution>;
}

export function pricedCalls(host: EngineHost, ledger: RunLedger): PricedCalls {
  const { llm, files } = host;
  return {
    client: { call: (input) => charged(ledger, (budget) => llm.client.call({ ...input, budget })) },
    extractCall: {
      call: (input) => charged(ledger, (budget) => llm.extractCall.call({ ...input, budget })),
    },
    transforms: {
      // A priced plugin is refused before it starts once the run has spent
      // its cap; anything it or the models it calls spend comes back as cost.
      invoke: async (input) => {
        if (llm.transforms.isPriced?.(input.plugin) === true) ledger.check();
        return charged(ledger, (budget) => llm.transforms.invoke({ ...input, budget }));
      },
      ...(llm.transforms.declaredOutput !== undefined
        ? { declaredOutput: (plugin: string) => llm.transforms.declaredOutput?.(plugin) }
        : {}),
      ...(llm.transforms.isPriced !== undefined
        ? { isPriced: (plugin: string) => llm.transforms.isPriced?.(plugin) === true }
        : {}),
    },
    arbitrateEntities: async (input) =>
      (await charged(ledger, (budget) => llm.arbitrateEntities({ ...input, budget }))).index,
    resolveFileText: (input) => charged(ledger, (budget) => files.resolveFileText({ ...input, budget })),
  };
}

// ── Opening and closing a segment ───────────────────────────────────────────

/** Open one segment: its cross-run lock holder, its host segment, and the
 *  run's account seeded with what the run spent before it. The holder comes
 *  first so a segment that fails to open leaves nothing open behind it. */
export async function openRunContext(input: {
  host: EngineHost;
  teamId: TeamId;
  runId?: string;
  languageVersion: LanguageVersion;
  spend: ConstructorParameters<typeof RunLedger>[0];
}): Promise<RunContext> {
  const { host, teamId, runId, languageVersion } = input;
  const writeLockHolder = host.locks.holder(teamId);
  let segmentId: string;
  try {
    ({ segmentId } = await host.segment.open({
      teamId,
      languageVersion,
      ...(runId !== undefined ? { runId } : {}),
    }));
  } catch (error) {
    await writeLockHolder.release();
    throw error;
  }
  return {
    teamId,
    languageVersion,
    cancel: host.control.cancel,
    ...(runId !== undefined ? { runId } : {}),
    segmentId,
    writeLockHolder,
    ledger: new RunLedger(input.spend),
  };
}

/**
 * End a segment however it ended: release its locks, close its host segment,
 * and charge what the host says the segment's adapter calls spent (a model
 * call an adapter makes to match a record). Every step is attempted, and none
 * throws: this runs in the segment's `finally`, where a failure here would
 * replace the run's own result or error. A step that fails is logged with the
 * run it belongs to.
 */
export async function closeRunContext(context: RunContext, host: EngineHost): Promise<void> {
  await settled('release its cross-run write locks', context, () => context.writeLockHolder.release());
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
