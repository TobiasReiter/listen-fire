// The TypeScript side of the Rust engine (crates/movement-engine). A segment
// runs inside its own WASM instance; whatever it needs from the world it asks
// for as `{id, family, method, args}` requests, and this shim serves each one
// from the run's `EngineHost`, several at once when the engine issues several,
// answering each by id as it settles. The segment is the run host's
// (`inRunContext` opened it): every request the engine makes of the host names
// it, in the shapes docs/contracts/host-families.md freezes, and the shim forwards each one
// to the run's `EngineHost` (rust_host.ts).
//
// Which engine runs a segment is the run's pinned language version
// (`engineFor`): 5 and later the Rust engine, 1–4 the TypeScript engine. There
// is no fallback between them: whatever the Rust engine refuses or declines
// fails the run (MOVENG_UNSUPPORTED). The checker is the one gate that keeps a
// saved program from reaching such a refusal, and a test holds every version-5
// program in the repository to that (rust_reachability.unit.test.ts). Each
// segment is logged once (`noteEngine`) and counted (`rustRunStats`).

import { languageVersionDiagnostic, openEngineSegment, since, type LanguageVersion } from 'movement-lang';

import { RunCostCapExceeded } from '../../lib/run_cost';
import { extractionTierAssignments, runChatModels } from './ai_tiers';
import { CallDepthExceeded, maxCallDepth } from './call_depth';
import { logger } from '../logger';
import { MovementEngineError, MovementRunFailed, isCheckFailure, type MovementEngineErrorCode } from './errors';
import { servedHostMethods } from './host';
import { maxFileChars } from './extraction';
import type { MovementRunResult, ResumeMovementInput, RunMovementInput } from './run';
import type { CallbackBodyInput, SettleRaceInput } from 'engine-contracts';
import type { RunContext } from './run_context';
import { checkedKey, serve, type RouteContext } from './rust_host';
import { recordRunEngine, rustRunStats } from './rust_stats';
import { filesInParkState, REFUSED, RustShimError, WireOut, plainJson, record, string } from './rust_wire';

export { RustShimError, plainJson } from './rust_wire';

/** One request a segment makes of its host. */
export interface HostRequest {
  id: number;
  family: string;
  method: string;
  args: unknown;
}

/** What a segment says after `start` or an answer: the requests it issued
 *  since the last step (earlier ones are still awaited), or its result. */
export type EngineStep = { pending: HostRequest[] } | { done: unknown };

/** An answer: the value (`{}` when it is `undefined`), or the error the host
 *  raised, which the engine receives as an `Err` it may handle. */
export type HostAnswer =
  | { value: unknown }
  | Record<string, never>
  | { error: { message: string; name?: string; ref?: number } };

/** The engine's side of the conversation. `openWasmEngine` is the real one;
 *  a test drives the shim with a double. */
export interface EngineProtocol {
  start(input: unknown): EngineStep;
  answer(id: number, answer: HostAnswer): EngineStep;
  /** Ends the segment, dropping everything it held. */
  finish(): void;
}

/** An engine: the one a run's segment runs on. */
export type EngineChoice = 'rust' | 'ts';

/** The first language version that runs on the Rust engine; every earlier
 *  one runs on the TypeScript engine. */
export const RUST_ENGINE_FROM_VERSION: LanguageVersion = 5;

/** Settings that once chose an engine, a fallback, an admission dry run or an
 *  emergency switch. Each named a choice that no longer exists. */
const RETIRED_ENGINE_SETTINGS = ['MOVEMENT_ENGINE', 'MOVEMENT_ENGINE_FALLBACK', 'MOVEMENT_ENGINE_DRY_RUN_EVERY', 'MOVEMENT_ENGINE_V5_ON_TS'] as const;

/** For a process's boot: a retired engine setting fails startup. Ignoring
 *  it would silently drop what an operator asked for (a version-5 run on the
 *  TypeScript engine, say). */
export function assertEngineConfigured(env: Record<string, string | undefined> = process.env): void {
  const set = RETIRED_ENGINE_SETTINGS.filter((name) => env[name] !== undefined && env[name] !== '');
  if (set.length === 0) return;
  throw new Error(
    `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} retired: a run's engine follows its pinned language version (5 and later the Rust engine, 1–4 the TypeScript engine), with no fallback between them. Remove ${set.length === 1 ? 'it' : 'them'} from the environment.`,
  );
}

/**
 * The engine a segment of a run pinned to `languageVersion` runs on.
 * `parkedOn` is, for a resume, the engine the run's row says parked it. A run
 * pinned to 5 or later that the TypeScript engine parked (under the retired
 * MOVEMENT_ENGINE_V5_ON_TS switch) has no engine to resume on and fails
 * loudly. A run pinned below 5 that the Rust engine parked resumes on the
 * TypeScript engine, which reads the one park shape.
 */
export function engineFor(run: { languageVersion: LanguageVersion; parkedOn?: EngineChoice }): EngineChoice {
  if (!since(run.languageVersion, RUST_ENGINE_FROM_VERSION)) return 'ts';
  if (run.parkedOn === 'ts') {
    throw new MovementEngineError(
      'MOVENG_UNSUPPORTED',
      `this run is pinned to language version ${run.languageVersion}, which runs only on the Rust engine, but the TypeScript engine parked it: it cannot resume`,
      { reason: PARKED_ON_TYPESCRIPT },
    );
  }
  return 'rust';
}

/** Why a version-5 run the TypeScript engine parked fails its resume. */
export const PARKED_ON_TYPESCRIPT = 'parked_on_typescript';

/** What a segment in the Rust engine runs: the run's input, the segment
 *  the run host opened, and whether the run host checked the program before
 *  opening it (run.ts, by the Rust checker). The engine checks the program
 *  itself as the segment starts (`nativeCheck`): the run's stamps and import
 *  link are that check's. */
export interface RustSegment<Input extends RunMovementInput = RunMovementInput> {
  input: Input;
  context: RunContext;
  checkedBefore?: boolean;
}

/** A segment of `input`'s run in the Rust engine: its result. Whatever the
 *  engine refuses or declines fails the run (`unsupportedInRust`). */
export async function runSegmentInRust(segment: RustSegment, engine?: EngineProtocol): Promise<MovementRunResult> {
  return segmentInRust(segment, undefined, engine);
}

/** A parked run resumed in the Rust engine. An answer to bind at the leaf
 *  crosses on the eval wire. */
export async function resumeSegmentInRust(segment: RustSegment<ResumeMovementInput>, engine?: EngineProtocol): Promise<MovementRunResult> {
  return segmentInRust(segment, resumptionOf(segment.input), engine);
}

/** What a parked run's resume hands the engine. */
function resumptionOf(input: ResumeMovementInput): Resumption {
  return {
    state: input.state,
    ...(input.reenter === true ? { reenter: true } : {}),
    ...(input.answer !== undefined && input.reenter !== true ? { answer: input.answer } : {}),
    ...(input.deferRaceSettlement === true ? { deferRaceSettlement: true } : {}),
  };
}

/** A race a batch resume deferred, settled in the Rust engine
 *  (`settleRaceFrame`): `state` any completed branch's. */
export async function settleSegmentInRust(
  segment: RustSegment<SettleRaceInput & { host: RunMovementInput['host'] }>,
  engine?: EngineProtocol,
): Promise<MovementRunResult> {
  return segmentInRust(segment, settlementOf(segment.input), engine);
}

/** What a race settlement hands the engine. */
function settlementOf(input: SettleRaceInput): Resumption {
  return { state: input.state, settle: { frameAddress: input.frameAddress } };
}

/** A fired callback's body run in the Rust engine (`fireCallbackBody`):
 *  `state` the callback's captured continuation. */
export async function fireSegmentInRust(
  segment: RustSegment<CallbackBodyInput & { host: RunMovementInput['host'] }>,
  engine?: EngineProtocol,
): Promise<MovementRunResult> {
  return segmentInRust(segment, firingOf(segment.input), engine);
}

/** What a callback's firing hands the engine. */
function firingOf(input: CallbackBodyInput): Resumption {
  return { state: input.state, fire: { values: input.values, callIndex: input.callIndex } };
}

/** What a segment resumes from, and how. */
interface Resumption {
  state: unknown;
  reenter?: true;
  answer?: unknown;
  deferRaceSettlement?: true;
  settle?: { frameAddress: string };
  fire?: { values: Record<string, unknown>; callIndex: number };
}

async function segmentInRust(
  { input, context, checkedBefore = false }: RustSegment,
  resume: Resumption | undefined,
  engine?: EngineProtocol,
): Promise<MovementRunResult> {
  // Read before the instance opens. An event or state that cannot cross the
  // eval wire as itself (a class instance in a payload; a `Date` is its ISO
  // text by now, `withIsoEvent`) fails here, before the engine has asked the
  // host for anything.
  // The segment's one wire: what it sends the engine (the event, then every
  // answer) keeps the ids the engine names it back by.
  const wire = new WireOut();
  const start = segmentInput(input, context, { resume }, wire);
  if (start === undefined) throw unsupportedInRust(input, EVENT_DOES_NOT_CROSS);
  const hostErrors: unknown[] = [];
  let outcome: RunOutcome;
  try {
    const done = await driveEngine(engine ?? openWasmEngine(), start, {
      host: input.host,
      context,
      catalog: input.catalog,
      hostErrors,
      wire,
    });
    outcome = readRunResult(done, { context, hostErrors, wire });
  } catch (error) {
    // A driver that did not check before the segment opened (run.ts does):
    // the engine's own check ended it, counted as the run host's check
    // ending is.
    if (isCheckFailure(error)) {
      if (!checkedBefore) endedAtItsCheck(input);
      else failedCheckMidRun(input);
      throw error;
    }
    rustRunStats.segments += 1;
    if (error instanceof RustShimError) {
      rustRunStats.shimFaults += 1;
      noteEngine(input, 'rust', SHIM_FAULT);
    } else {
      noteEngine(input, 'rust', RAN);
    }
    throw error;
  }
  rustRunStats.segments += 1;
  if ('refused' in outcome) throw unsupportedInRust(input, outcome.refused);
  if ('declined' in outcome) throw unsupportedInRust(input, outcome.declined);
  noteEngine(input, 'rust', RAN);
  return outcome.ran;
}

/** A segment the Rust engine (or this shim, on its behalf) would not run:
 *  counted by reason, and the run fails. No other engine runs a version-5
 *  program, so this is never a slow path: a checked program that reaches it
 *  is a checker or engine bug. */
function unsupportedInRust(input: Pick<RunMovementInput, 'runId' | 'dryRun'>, reason: string): MovementEngineError {
  rustRunStats.unsupported[reason] = (rustRunStats.unsupported[reason] ?? 0) + 1;
  noteEngine(input, 'rust', reason);
  return new MovementEngineError('MOVENG_UNSUPPORTED', `the Rust engine does not run this movement (${reason})`, { reason });
}

/** A `done`'s cost lines, summed by source. */
function costBySource(cost: unknown): Record<string, number> {
  if (!Array.isArray(cost)) throw new RustShimError('the Rust engine cost is a list of cost lines');
  const bySource: Record<string, number> = {};
  for (const line of cost) {
    const { source, microdollars } = record(line, 'a Rust engine cost line');
    if (typeof source !== 'string' || typeof microdollars !== 'number') {
      throw new RustShimError('a Rust engine cost line is {source, microdollars}');
    }
    bySource[source] = (bySource[source] ?? 0) + microdollars;
  }
  return bySource;
}

function canonicalJson(bySource: Record<string, number>): string {
  return JSON.stringify(Object.entries(bySource).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Why a run whose event, answer or parked state cannot cross the eval wire
 *  fails. */
export const EVENT_DOES_NOT_CROSS = 'event_does_not_cross';

/** The outcome a segment the Rust engine ran is logged with (to its end or
 *  its own failure). */
const RAN = 'ran';

/** The outcome a segment the shim faulted in is logged with. */
const SHIM_FAULT = 'shim_fault';

/** The outcome a Rust run that failed its check is logged with: nothing ran. */
export const ENDED_AT_CHECK = 'ended_at_check';

/** The outcome a run that failed `check.compatible` after its segment ran is
 *  logged with. */
export const FAILED_CHECK_MID_RUN = 'failed_check_mid_run';

/**
 * The Rust route's check (`check`: run.ts's own, `checkPinnedInRust`), made
 * before the segment opens, so a program that fails it makes no host
 * request. A check failure (`isCheckFailure`) is counted and logged as that
 * ending; anything else the check throws is a fault of the shim's check,
 * counted as one.
 */
export function checkBeforeRustSegment<T>(input: Pick<RunMovementInput, 'runId' | 'dryRun'>, check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (isCheckFailure(error)) endedAtItsCheck(input);
    else {
      rustRunStats.shimFaults += 1;
      noteEngine(input, 'rust', SHIM_FAULT);
    }
    throw error;
  }
}

/** A Rust run that ended at its check: counted apart, never a segment. */
function endedAtItsCheck(input: Pick<RunMovementInput, 'runId' | 'dryRun'>): void {
  rustRunStats.endedAtCheck += 1;
  noteEngine(input, 'rust', ENDED_AT_CHECK);
}

/** A run the check had already passed that then failed a check mid-run
 *  (`check.compatible`, an `IS <Decl>` test of a system's record), after its
 *  segment opened and made host requests: not "ended at the check", which
 *  means nothing ran. */
function failedCheckMidRun(input: Pick<RunMovementInput, 'runId' | 'dryRun'>): void {
  rustRunStats.segments += 1;
  rustRunStats.failedCheckMidRun += 1;
  noteEngine(input, 'rust', FAILED_CHECK_MID_RUN);
}

/**
 * The one log line per segment that says which engine ran it and how it
 * ended on the Rust engine (`ran`, or why it did not), and the engine
 * recorded on the run's row. A TypeScript segment logs at debug.
 */
export function noteEngine(input: Pick<RunMovementInput, 'runId' | 'dryRun'>, engine: EngineChoice, outcome?: string): void {
  const line = `movement engine: engine=${engine} run=${input.runId ?? '-'}${outcome !== undefined ? ` outcome=${outcome}` : ''}`;
  if (engine === 'ts') logger.debug(line);
  else logger.info(line);
  // A rehearsal has no run row.
  if (input.runId !== undefined && input.dryRun !== true) recordRunEngine({ runId: input.runId, engine });
}

/**
 * Runs one segment to its result: starts it, serves every request it issues
 * from `input.host` concurrently, answers each as it settles, and finishes
 * the segment however the run ends.
 */
export async function driveEngine(
  engine: EngineProtocol,
  start: unknown,
  input: Omit<RouteContext, 'hostErrors' | 'positions' | 'wire' | 'checked'> & {
    /** The errors host calls failed with, by the `ref` their answers carry. */
    hostErrors?: unknown[];
    /** The segment's wire, when its input went out on it. */
    wire?: WireOut;
  },
): Promise<unknown> {
  const context: RouteContext = {
    ...input,
    hostErrors: input.hostErrors ?? [],
    positions: new Map(),
    wire: input.wire ?? new WireOut(),
    // The run's own check, made before the segment opened, is the program
    // `check.compatible` asks about too.
    checked: new Map(
      input.prechecked !== undefined
        ? [[checkedKey(input.prechecked.source, input.prechecked.languageVersion), input.prechecked.checked.program]]
        : [],
    ),
  };
  // A settle queue: each request in flight, as it settles, joins the queue
  // and wakes the one waiter. An answer costs O(1) however many requests are
  // in flight (a race over every one of them per answer was O(n) each).
  const settled = new SettleQueue();
  let inFlight = 0;
  try {
    let step = engine.start(start);
    for (;;) {
      if ('done' in step) return step.done;
      for (const request of step.pending) {
        inFlight += 1;
        serve(request, context).then(
          (answer) => settled.push({ id: request.id, answer }),
          (failure: unknown) => settled.push({ id: request.id, failure }),
        );
      }
      if (inFlight === 0) throw new RustShimError('the Rust engine is waiting with no request in flight');
      // Every answer already settled is handed over before any request it
      // leads to is served: the TypeScript engine runs each continuation an
      // answer wakes before the host is asked anything further, so flows
      // woken together ask together (crates/movement-engine/README.md,
      // "Concurrent flows").
      const pending: HostRequest[] = [];
      let next: Settled | undefined = await settled.next();
      while (next !== undefined) {
        inFlight -= 1;
        if ('failure' in next) throw next.failure;
        step = engine.answer(next.id, next.answer);
        if ('done' in step) break;
        pending.push(...step.pending);
        next = settled.ready();
      }
      if ('done' in step) return step.done;
      step = { pending };
    }
  } catch (error) {
    // The segment is ending (a shim fault, or the engine's own throw): every
    // request still in flight settles first, so no host call outlives the
    // segment it named.
    for (; inFlight > 0; inFlight -= 1) await settled.next();
    throw error;
  } finally {
    engine.finish();
  }
}

type Settled = { id: number; answer: HostAnswer } | { id: number; failure: unknown };

/** Settled requests in the order they settled, and one waiter for the next. */
class SettleQueue {
  private readonly items: Settled[] = [];
  private head = 0;
  private waiter: (() => void) | undefined;

  push(item: Settled): void {
    this.items.push(item);
    const wake = this.waiter;
    this.waiter = undefined;
    wake?.();
  }

  /** The next settled item when one is already waiting, without waiting. */
  ready(): Settled | undefined {
    if (this.head === this.items.length) return undefined;
    const item = this.items[this.head];
    this.head += 1;
    if (this.head === this.items.length) {
      this.items.length = 0;
      this.head = 0;
    }
    return item;
  }

  async next(): Promise<Settled> {
    while (this.head === this.items.length) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    const item = this.items[this.head];
    if (item === undefined) throw new RustShimError('the settle queue woke with nothing settled');
    this.head += 1;
    // Drained: start over, so a long segment's queue holds only what waits.
    if (this.head === this.items.length) {
      this.items.length = 0;
      this.head = 0;
    }
    return item;
  }
}


// ── The segment's data ────────────────────────────────────────────────────────

/** Everything of `input` but its host, as the `segment` entry reads it
 *  (crates/movement-engine/src/run.rs `SegmentInput`): the event, and a
 *  resumed state, on the eval wire, so their objects keep their key order
 *  (a stored state's is the order it was stored in). Undefined for an input
 *  that cannot cross as itself. */
function segmentInput(
  input: RunMovementInput,
  context: RunContext,
  { resume }: { resume: Resumption | undefined },
  wire: WireOut,
): unknown {
  // The event is data, whatever keys it carries: a dict shaped like a
  // binding crosses, and is read, as the dict it is.
  const event = wire.value(input.event);
  if (event === REFUSED) return undefined;
  // A parked state's files are made host-side, in the segment's file table:
  // the engine is handed their handles, never their descriptors.
  const state = resume !== undefined ? new WireOut({ files: wire.files }).value(filesInParkState(resume.state)) : undefined;
  if (state === REFUSED) return undefined;
  // The answer a step-past resume binds and a fired callback's values are
  // data, as the event is.
  const answer = resume?.answer !== undefined ? wire.value(resume.answer) : undefined;
  if (answer === REFUSED) return undefined;
  const values = resume?.fire !== undefined ? wire.value(resume.fire.values) : undefined;
  if (values === REFUSED) return undefined;
  const resumed =
    resume === undefined
      ? undefined
      : {
          state,
          ...(resume.reenter === true ? { reenter: true } : {}),
          ...(answer !== undefined ? { answer } : {}),
          ...(resume.deferRaceSettlement === true ? { deferRaceSettlement: true } : {}),
        };
  return plainJson(
    {
      entry: 'segment',
      ...(input.dryRun === true ? { dryRun: true } : {}),
      ...(resumed !== undefined ? { resume: resumed } : {}),
      ...(resume?.settle !== undefined ? { settle: resume.settle } : {}),
      ...(resume?.fire !== undefined ? { fire: { values, callIndex: resume.fire.callIndex } } : {}),
      source: input.source,
      // The engine checks the program itself (the Rust checker): a run on
      // this engine is held to it, and the host is never asked.
      // It checks against the snapshot's own `models`, as the host's checker
      // does, not the run's list sent on the catalog below. A deprecated
      // pin's warning is the release's, which is this host's, as the host's
      // check answer's is (rust_host.ts `check.program`).
      nativeCheck: true,
      snapshotModels: input.catalog.models ?? null,
      ...versionWarningOf(context.languageVersion),
      // The pin the run is under, written out: the engine cannot know this
      // release's current version.
      languageVersion: context.languageVersion,
      ...(input.movementName !== undefined ? { movementName: input.movementName } : {}),
      event,
      // The segment the run host opened: every host request names it.
      segmentId: context.segmentId,
      ...(input.credentialIds !== undefined ? { credentialIds: input.credentialIds } : {}),
      // The run's account as this segment starts (crates/movement-engine/src/ledger.rs).
      spend: {
        priorMicrodollars: input.priorSpentMicrodollars ?? 0,
        capBaselineMicrodollars: input.capBaselineMicrodollars ?? 0,
        ...(input.costCapMicrodollars !== undefined ? { capMicrodollars: input.costCapMicrodollars } : {}),
      },
      // Where the run's flows suspend (crates/movement-engine/src/park.rs).
      ...(input.limitPaused === true ? { limitPaused: true } : {}),
      ...(input.suspendAt !== undefined && input.suspendAt.length > 0 ? { suspendAt: [...input.suspendAt] } : {}),
      // The run's pinned instant, as the TypeScript interpreter pins it.
      now: input.firedAt ?? context.pinnedNow.toISOString(),
      // The snapshot, its `models` the run's one list (`runChatModels`): an
      // extraction call's `model` is held to it, as the TypeScript engine
      // holds it, and it is the list the checker held it to.
      catalog: { ...input.catalog, models: runChatModels(input.catalog) },
      // What the host serves: the engine asks an optional family's method
      // only of a host that serves it, as the TypeScript engine reads its
      // host object (a park sink's, `canSuspend`).
      serves: servedHostMethods(input.host),
      // How much of a source file an extraction prompt takes: the
      // deployment's, read here so the engine reads no environment; the
      // number as written, a fraction included, which the marker prints.
      extractionFileChars: maxFileChars(),
      // How many named calls deep the run may nest (version 3): the
      // deployment's, read here for the same reason.
      maxCallDepth: maxCallDepth(),
      // What this deployment buys for each extraction tier: read here so the
      // engine reads no environment; the built-in table where it names none.
      extractionTiers: extractionTierAssignments(),
    },
    'the segment input',
  );
}

/** The pin's standing warning as this release words it (`languageVersionDiagnostic`). */
function versionWarningOf(languageVersion: LanguageVersion): { versionWarning?: { code: string; message: string } } {
  const warning = languageVersionDiagnostic(languageVersion);
  return warning !== undefined ? { versionWarning: { code: warning.code, message: warning.message } } : {};
}

/** What a segment ended in: its result, a refusal at its entry (nothing ran
 *  but its parse), or a decline after its check (nothing the host can see
 *  happened). */
type RunOutcome = { ran: MovementRunResult } | { refused: string } | { declined: string };

/**
 * The segment's `done` (crates/movement-engine/src/run.rs says its shapes):
 * the run's result, the error it failed with (a body's failure wrapped in
 * `MovementRunFailed`, carrying what the run did, as the interpreter wraps
 * it), or that it refused or declined.
 */
export function readRunResult(
  done: unknown,
  run: { context: Pick<RunContext, 'trace' | 'ledger'>; hostErrors: unknown[]; wire?: WireOut },
): RunOutcome {
  const outcome = record(done, 'the Rust engine result');
  if ('refused' in outcome) return { refused: string(outcome.refused, 'the Rust engine refused') };
  if ('declined' in outcome) return { declined: string(outcome.declined, 'the Rust engine declined') };
  // What the segment's priced calls spent was charged to the run's account
  // as each answer passed through the shim (rust_host.ts), so a fault cannot
  // lose it. The engine reports the same lines from its own ledger: they
  // must agree.
  const reported = costBySource(outcome.cost ?? []);
  if (canonicalJson(reported) !== canonicalJson(run.context.ledger.spend.bySource)) {
    throw new RustShimError(
      `the Rust engine reports spending ${JSON.stringify(reported)}, but its host charged ${JSON.stringify(run.context.ledger.spend.bySource)}`,
    );
  }
  const trace = run.context.trace.entries;
  if ('thrown' in outcome) throw failureOf(outcome.thrown, run.hostErrors);
  if ('failed' in outcome) {
    const failed = record(outcome.failed, 'the Rust engine failure');
    throw new MovementRunFailed(failureOf(failed.error, run.hostErrors), resultOf(failed.result, trace, run.wire ?? new WireOut()));
  }
  if ('result' in outcome) return { ran: resultOf(outcome.result, trace, run.wire ?? new WireOut()) };
  throw new RustShimError(`the Rust engine finished with ${Object.keys(outcome).join(', ') || 'nothing'}, which this shim does not decode`);
}

const RESULT_KEYS: ReadonlySet<string> = new Set(['movementName', 'writes', 'extractionSites', 'parked', 'parkedAddress', 'cancelled', 'deferredRaceFrames']);

function resultOf(value: unknown, trace: MovementRunResult['trace'], wire: WireOut): MovementRunResult {
  const result = record(value, 'the Rust engine result');
  const unread = Object.keys(result).filter((key) => !RESULT_KEYS.has(key));
  if (unread.length > 0) {
    throw new RustShimError(`the Rust engine result has ${unread.join(', ')}, which this shim does not decode yet`);
  }
  if (result.cancelled !== undefined && result.cancelled !== true) throw new RustShimError('a cancelled result says true');
  if (result.parked !== undefined && result.parked !== true) throw new RustShimError('a parked result says true');
  // A value an adapter answered is in the writes as that very object.
  const writes = wire.read(result.writes ?? ['l', 0, []]);
  if (!Array.isArray(writes) || !writes.every(isWriteRecord)) throw new RustShimError('the Rust engine result writes are write records');
  const extractionSites = result.extractionSites === undefined ? {} : wire.read(result.extractionSites);
  if (!isSiteTable(extractionSites)) throw new RustShimError('the Rust engine result extractionSites are site summaries');
  // The spend fields are the run host's to add, read off the run's account
  // once the segment closes (run.ts `inRunContext`).
  return {
    movementName: string(result.movementName, 'the Rust engine result movementName'),
    writes,
    extractionSites,
    trace,
    ...(result.parked === true ? { parked: true, parkedAddress: string(result.parkedAddress, 'the parked address') } : {}),
    ...(result.cancelled === true ? { cancelled: true } : {}),
    ...(result.deferredRaceFrames !== undefined ? { deferredRaceFrames: deferredFrames(result.deferredRaceFrames) } : {}),
  };
}

/** The race frames a batch resume deferred, as addresses. */
function deferredFrames(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((frame) => typeof frame === 'string')) {
    throw new RustShimError('the Rust engine result deferredRaceFrames are addresses');
  }
  return value;
}

/** The extraction sites a result's provenance cites, by site id. */
function isSiteTable(value: unknown): value is MovementRunResult['extractionSites'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (site) =>
      typeof site === 'object' &&
      site !== null &&
      typeof Reflect.get(site, 'node') === 'string' &&
      typeof Reflect.get(site, 'description') === 'string' &&
      typeof Reflect.get(site, 'stage') === 'number' &&
      Array.isArray(Reflect.get(site, 'dataSources')),
  );
}

/** A write record off the wire: the fields every one carries. */
function isWriteRecord(value: unknown): value is MovementRunResult['writes'][number] {
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof Reflect.get(value, 'adapterType') === 'string'
    && typeof Reflect.get(value, 'recordType') === 'string'
    && typeof Reflect.get(value, 'created') === 'boolean'
    && typeof Reflect.get(value, 'committed') === 'boolean'
    && typeof Reflect.get(value, 'writtenValues') === 'object'
    && typeof Reflect.get(value, 'provenance') === 'object'
  );
}

/** The error the TypeScript engine would have thrown: rebuilt from its class,
 *  or the very one a host call failed with. */
function failureOf(value: unknown, hostErrors: unknown[]): unknown {
  const error = record(value, 'the Rust engine error');
  if ('hostError' in error) {
    const ref = error.hostError;
    if (typeof ref !== 'number' || ref < 0 || ref >= hostErrors.length) {
      throw new RustShimError(`the Rust engine failed with a host error this shim never answered (${String(ref)})`);
    }
    return hostErrors[ref];
  }
  return thrownBy(error);
}

// ── The WASM engine ───────────────────────────────────────────────────────────

/** A segment in a fresh instance of the movement artifact. */
export function openWasmEngine(): EngineProtocol {
  const segment = openEngineSegment();
  return {
    start: (input) => readStep(segment.start(JSON.stringify(input)), 'start'),
    answer: (id, answer) => readStep(segment.answer(id, JSON.stringify(answer)), `answer ${id}`),
    finish: () => segment.finish(),
  };
}

function readStep(reply: { ok: boolean; json: unknown }, call: string): EngineStep {
  const json = record(reply.json, `the Rust engine's ${call}`);
  if (!reply.ok) {
    const error = record(json.error, `the Rust engine's ${call} error`);
    throw new RustShimError(`the Rust engine refused ${call}: ${String(error.message)}`);
  }
  if ('done' in json) return { done: json.done };
  if (!Array.isArray(json.pending)) throw new RustShimError(`the Rust engine's ${call} returned no step`);
  return { pending: json.pending.map((request) => readRequest(request, call)) };
}

function readRequest(value: unknown, call: string): HostRequest {
  const request = record(value, `a request from the Rust engine's ${call}`);
  if (typeof request.id !== 'number') throw new RustShimError(`a request from the Rust engine's ${call} has no id`);
  return {
    id: request.id,
    family: string(request.family, 'a request family'),
    method: string(request.method, 'a request method'),
    args: request.args,
  };
}

// ── The evaluator ─────────────────────────────────────────────────────────────

/** The error the TypeScript engine would have thrown. */
function thrownBy(error: Record<string, unknown>): Error {
  // A run that met its cost cap where it could not suspend: the error is
  // rebuilt from its figures, message and all, as the TypeScript ledger
  // builds it.
  if (error.class === 'RunCostCapExceeded') {
    const { capMicrodollars, spentMicrodollars } = error;
    if (typeof capMicrodollars !== 'number' || typeof spentMicrodollars !== 'number') {
      throw new RustShimError('a RunCostCapExceeded carries its cap and spend as numbers');
    }
    return new RunCostCapExceeded(capMicrodollars, spentMicrodollars);
  }
  // A call past the depth limit: rebuilt from its limit and chain, message
  // and all, as call_depth.ts builds it.
  if (error.class === 'CallDepthExceeded') {
    const { limit, chain } = error;
    if (typeof limit !== 'number' || !Array.isArray(chain) || !chain.every((name): name is string => typeof name === 'string')) {
      throw new RustShimError('a CallDepthExceeded carries its limit and its chain of names');
    }
    return new CallDepthExceeded(limit, chain);
  }
  const message = string(error.message, 'the Rust evaluator error message');
  switch (error.class) {
    case 'MovementEngineError':
      return new MovementEngineError(engineErrorCode(error.code), message);
    case 'Error':
      return new Error(message);
    case 'RangeError':
      return new RangeError(message);
    case 'TypeError':
      return new TypeError(message);
    default:
      throw new RustShimError(`the Rust evaluator threw an unknown class ${String(error.class)}`);
  }
}

/** The codes the Rust engine throws with. */
function engineErrorCode(code: unknown): MovementEngineErrorCode {
  switch (code) {
    case 'MOVENG_RUNTIME':
    case 'MOVENG_UNSUPPORTED':
    case 'MOVENG_NOT_FOUND':
    case 'MOVENG_ERROR':
    case 'MOVENG_PARK_NONSERIALIZABLE':
    // The engine's own check (`nativeCheck`): its pin, its parse, the checker.
    case 'MOVENG_LANGUAGE_VERSION':
    case 'MOVENG_PARSE':
    case 'MOVENG_CHECK':
      return code;
    default:
      throw new RustShimError(`the Rust evaluator threw an unknown code ${String(code)}`);
  }
}

