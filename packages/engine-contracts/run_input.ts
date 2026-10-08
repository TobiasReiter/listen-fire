// What each entry into the engine is handed, as data: a first firing, a
// resume, a race settlement and a callback body. The engine is handed a host
// beside it (`EngineHost`), which is not data and so not here.

import type { CatalogSnapshot, LanguageVersion } from 'movement-lang';

import type { TriggerEvent } from './event';
import type { ParkedScopeState } from './park_state';
import type { TenantId } from './tenant';

export interface RunInput {
  /** The movement program text (`.mvt` source). */
  source: string;
  /**
   * The language version the movement is pinned to — the run compiles and
   * executes under it, it is the segment's pin (`RunContext.languageVersion`),
   * and every adapter answers under it (the host segment opened with it). Absent ⇒
   * the current version. A version this release does not support is refused
   * (MOVENG_LANGUAGE_VERSION), never run as the current one.
   */
  languageVersion?: LanguageVersion;
  /** Which movement to run; optional when the program declares exactly one. */
  movementName?: string;
  /** The triggering event — the movement parameter's position. */
  event: TriggerEvent;
  /** The tenant the run is for: every segment it opens is opened for it. */
  teamId: TenantId;
  /**
   * When this run FIRED — the instant every clock read in it answers from
   * (`@current_date`, `@current_timestamp`, `DATE.TODAY(zone)`). The host
   * passes the run row's `started_at`, which a resume reads back unchanged, so
   * a run that parks for a day still computes the window it started with.
   *
   * An ISO 8601 instant. Absent ⇒ the engine asks the host's `clock.now` once
   * as the segment opens and pins that: still one instant for the segment,
   * just not one that survives a park. Every path that can park supplies it.
   */
  firedAt?: string;
  /**
   * The most the run may spend on priced work (model calls, paid services,
   * priced plugins), in microdollars — the run host reads its deployment's cap
   * once and hands it over as data. Absent ⇒ no cap.
   */
  costCapMicrodollars?: number;
  /**
   * What this run spent in its EARLIER segments, in microdollars — the host
   * reads it back off the run's record when it resumes a parked run, so the
   * cost cap holds across every park. Absent ⇒ a fresh run, which has spent
   * nothing.
   */
  priorSpentMicrodollars?: number;
  /**
   * What the run had spent when it was last resumed from a limit pause — the
   * cost cap counts only what it spent after this (resuming a run paused at
   * its cap resets its usage). Absent ⇒ never resumed from one: the cap
   * counts everything.
   */
  capBaselineMicrodollars?: number;
  /**
   * The run is PAUSED at a limit (its cost cap) and this segment was woken by
   * an ordinary event for one of its branches — an answer, a reply, a timer.
   * The pause holds: the woken branch takes its event (binds the answer, steps
   * past the sleep) and then suspends before its next statement, like every
   * other branch of a paused run, until the run itself is resumed.
   */
  limitPaused?: boolean;
  /** The checker's catalog (adapters / credentials / instance schemas), as
   *  data built for this firing — the engine never holds a live catalog. */
  catalog: CatalogSnapshot;
  /** The run this is (the host's trigger-run id), named on the engine's log
   *  lines. Absent ⇒ the lines carry none (a test run, a script). */
  runId?: string;
  /** Rehearse every target: each is resolved `dryRun`, so the host captures
   *  its writes (into the host's write sink) rather than performing them. */
  dryRun?: boolean;
  /**
   * Where to suspend the run's flows, by address: just before a statement, or
   * just before the k-th call a statement makes (an address ending in that
   * call's `c k` step). The first flow to reach a listed address parks there,
   * once for the segment, to re-run the statement on resume. The cost cap needs none of this —
   * the engine suspends on its own ledger; it is for a host that wants a run
   * paused at a known point. Absent ⇒ nowhere.
   */
  suspendAt?: readonly string[];
  /**
   * Imported credential name → its credential id, as the run host read them
   * with the catalog snapshot. Ids never go into the snapshot itself. A name absent
   * here ⇒ the instance is constructed with no credential.
   */
  credentialIds?: Readonly<Record<string, string>>;
}

export interface ResumeInput extends RunInput {
  /** The parked leaf's state, as the host's park sink stored it. With the
   *  re-parsed pinned source it rebuilds the leaf's scopes. */
  state: ParkedScopeState;
  /** What to bind at the leaf's binding name on a step-past resume: a JSON
   *  scalar, or a curated row set `{ __correct: { type, rows } }`. Ignored
   *  under `reenter`. */
  answer?: unknown;
  /**
   * How the resume treats the parked statement:
   *
   *   - false / absent (STEP PAST): the statement is done. The resume binds
   *     `answer` (when given) and continues with the statement after it — a
   *     timer `sleep`, or a statement whose answer the host was given.
   *   - true (RE-ENTER): the statement runs again — an `await` re-checks its
   *     edge live, an `until` timer re-tests its condition, a limit suspension
   *     re-runs its statement, replaying the calls it had finished. No answer
   *     is bound.
   */
  reenter?: boolean;
  /** Batch mode: a host that resumes every resolvable leaf of a run in one
   *  pass sets this, so a race branch that completes is listed in the
   *  result's `deferredRaceFrames` instead of settling inline; the host then
   *  settles each listed frame once, with every winner. */
  deferRaceSettlement?: boolean;
}

/** A race settlement under batch resume: any completed branch's state from
 *  the pass, and the race frame to settle (one of the pass's
 *  `deferredRaceFrames`). */
export interface SettleRaceInput extends ResumeInput {
  frameAddress: string;
}

/** A fired callback's body: the callback's captured continuation as `state`,
 *  the call's values (validated against the callback's parameters) and its
 *  index on the callback's ledger. */
export interface CallbackBodyInput extends ResumeInput {
  values: Record<string, unknown>;
  callIndex: number;
}
