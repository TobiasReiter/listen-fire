// The movement engine (E1) — direct execution of the checked movement
// AST, no TG lowering. An interpreter walks the movement body in program
// order with an Environment of bindings → runtime values; the TG
// data-model (action trees, sibling roots, action_result nodes) never
// appears in the path.
//
// The engine is new; the platform isn't. Reused substrate:
//   - the adapter layer wholesale, resolved through the SAME
//     `resolveAdapter` seam `evaluateTranslationGraph` / provision use
//     (so simulate / tests inject fakes identically);
//   - the dry-run wrapper (`engine/dry_run_adapter.ts`) — CapturedWrite
//     output is the same currency as M4b/M5 dry runs;
//   - the entity-resolution split: the adapter returns a candidate
//     shortlist, the shared arbitration module
//     (`engine/entity_match.ts:arbitrateEntityCandidates`, extracted
//     from `applyActionPlan` for exactly this reuse) decides
//     create-vs-update;
//   - the trigger seed: the event position mirrors the TG engine's
//     `seedRootSourcePosition` webhook branch, so source-property reads
//     hit the adapter with an identical position.
//
// E1 statement subset: assignment (construction / write / expression),
// unbound writes, instance-target writes with `unique by`, `if` with
// expression conditions. E2 adds extraction (`extract … { }` planned +
// materialised by `./extraction.ts`) and traversal-headed blocks (per-
// emission iteration over extract edges and `#resources`, meta-node
// accumulation). E3 makes the knowledge graph an ordinary write target
// (the KG adapter resolves through the same seam — see `./kg.ts`), adds
// linked writes (`write h-[:edge]-> { … }` — create the record AND the
// connecting edge in one effect, written type inferred from the parent's
// graph schema) with edge-scoped compound identity (`unique by (h,
// `field`)` folds the parent's record into the resolve as the edge-scoped
// neighbour). E4 makes
// provenance the value model: every evaluation is `(value, provenance)`
// (see ./provenance.ts), writes translate faithful trails into
// `WriteInput.evidence` (the KG adapter persists them as its native
// evidence rows — closing the E3 parity gap with the TG path), and
// every write's per-field trails land summarised on
// `MovementRunResult.writes` for trigger_run recording. E5 adds
// composition (§G): same-file movement calls with lexical callee
// environments (a fresh child of FILE scope — caller locals invisible
// by construction), argument adaptation via in-memory shape writes
// (shapes are configuration-free graphs — no adapter, no firing-record
// write; the position carries its fields' trails), AI() through the
// LlmClient seam (see ./expression.ts), and runtime IS tests against
// the runtime position's type where the engine knows it. E6 adds the
// source-graph traversal slice: meta-rooted movements (`movement
// backfill(root: crm)` under a `snapshot` event seed the adapter's meta
// position — the manual_run.ts backfill shape), traversal-headed blocks
// over ADAPTER edges (`root-[c:companies]-> { … }` streams positions
// through the source adapter's iterateRelated/getRelated — the same
// seam the TG engine's snapshot fan-out walks; event schema-edge heads
// ride it too), per-hop WHERE filters evaluated position-scoped, and
// runtime EXISTS() (see ./expression.ts). Writes inside an adapter-edge
// iteration stand on the iterated record, so KG creates bridge to it
// exactly as the TG engine's collection fan-out does. E7 lifts standalone
// edge statements (`edge a -[:e]-> b`, §B "the rare case"): both names
// must be write handles in the SAME graph, the edge resolves against the
// from-side's type, and the assert goes through the new optional
// `Adapter.linkRecords` seam (KG: edge-only insert mirroring parentLink;
// Attio: reference-field set/append) — adapters without the capability
// are rejected by name. E8 lifts file imports (movement libraries, §H):
// `RunMovementInput.resolveFile` is the one injection point — resolution
// lives in movement-lang (`checkProgramWithLink` validates and returns
// the link), imported movements execute against their library's OWN file
// environment (built once per path), imported shapes bind as
// declarations. Everything still outside the slice (kg-seeded movements)
// raises a clean MOVENG_UNSUPPORTED naming the construct.

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  BridgeError,
  slotClosureName,
  DiagnosticCodes,
  MovementParseError,
  readCollectionConfig,
  SEQUENTIAL_COLLECTION_SETTINGS,
  type CollectionRunSettings,
  checkProgramWithLink,
  before,
  CURRENT_LANGUAGE_VERSION,
  languageVersionDiagnostic,
  diagnosticSeverity,
  credentialArgOf,
  aggregatedBarePath,
  bareName,
  isWalkProjection,
  mapTargetRoots,
  memberPathBindingName,
  pathRootName,
  probePathHead,
  spellPathHead,
  spellPathRoot,
  EVENT_ACTION_FIELD,
  eventAddressKey,
  eventAddressOfHops,
  isEnumType,
  conditionOfSlot,
  expressionOfSlot,
  parseMovementExpression,
  parseProgram,
  readExtractCallConfig,
  resolveBorrowedField,
  borrowedTypeSegments,
  splitUniquenessConjuncts,
  identityKeyOf,
  durationToMs,
  unwrapCredentialArg,
  CALLBACK_CALLED_EDGE,
  CALLBACK_CALL_AT,
  constructionAsCall,
  argumentBindings,
  isPositionalCall,
  isValueTypeRef,
  parseFieldTypeName,
  spellParamType,
  typeNameOf,
  schemaSurface,
  declaredTypesIn,
  expandWriteSpreads,
  inheritDeclaration,
  inheritSchema,
  shapeToSchema,
  surfaceMisfit,
  readCall,
  resolveCallee,
  since,
  conjunctsOf,
  hoistingMemberReads,
  holdsNestedCall,
  nameNode,
  parseNestedCall,
  runsAsCall,
  shortCircuitOf,
  slotOfTree,
  treeOfSlot,
  valueChildren,
  withValueChildren,
} from 'movement-lang';
import type {
  CallNode,
  MExpr,
  ShortCircuit,
  AwaitExpression,
  AwaitSource,
  LanguageVersion,
  ClosureExpression,
  DurationLiteral,
  RValue,
  RefreshStatement,
  CombinatorExpression,
  CollectionOpExpression,
  MembersExpression,
  ArmExpression,
  CallArg,
  CallPosition,
  CallReading,
  CallScope,
  CallStatement,
  Catalog,
  ConstructionCall,
  ExprSlot,
  CallbackExpression,
  CallbackSubject,
  ExtractCallExpression,
  ExtractExpression,
  SchemaFieldType,
  InstanceSchema,
  LinkExpression,
  LinkTarget,
  LinkedExport,
  MatchExpression,
  MatchTarget,
  LinkedFile,
  EventAddress,
  MovementCondition,
  MovementDeclaration,
  MovementParam,
  NodeLiteral,
  CopyPlan,
  MapSpread,
  PathHead,
  Program,
  ProgramLink,
  ResolveFile,
  ShapeDeclaration,
  ShapeNode,
  Statement,
  TraversalBlock,
  WriteExpression,
  WriteSpread,
  WriteTarget,
  FieldWriteMode,
  SuppliedSurface,
} from 'movement-lang';
import type { Expression, TraversalStep } from '#shared/expression/types';
import {
  evaluatePredicate,
  isPurePredicate,
  leafReadKey,
  pureLeafReads,
} from '#shared/expression/filter';
import { neverAsAny } from '../../lib/utils/types';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { LinkedObject } from '../../generated/kysely/knowledge/LinkedObject';
import type {
  Adapter,
  ExternalRecordRef,
  FieldEvidence,
  FileRef,
  ParentLink,
  Resource,
  WriteInput,
  WriteResult,
} from '../translation_graph/adapter';
import { updateRecordSucceeded } from '../translation_graph/adapter';
import { resolveAdapter as resolveAdapterDefault } from '../translation_graph/adapters/resolve';
import {
  recordBinding,
  findBoundCounterpart,
  deleteBinding,
  type BindingEndpoint,
} from './record_binding';
import {
  newDryRunRehearsal,
  wrapAdapterForDryRun,
  type DryRunRehearsal,
  type DryRunWriteSink,
} from '../translation_graph/engine/dry_run_adapter';
import { arbitrateEntityCandidates } from '../translation_graph/engine/entity_match';
import { applicableRequiredFields } from '../translation_graph/required_fields';
import type { MutationContext } from '../translation_graph/mutation_context';
import type { TriggerEvent } from '../translation_graph/triggers/types';
import {
  META_RECORD_TYPE,
  makeMetaPosition,
  makeStablePosition,
  makeUnstablePosition,
  positionData,
  positionRecordId,
  type SchemaFieldDescriptor,
  type SourcePosition,
  type TransformOutputKind,
  transformOutputUnder,
} from '../translation_graph/types';
import { isBlankIdentityValue, mergeUniqueness, type UniquenessConstraints } from '../translation_graph/uniqueness';
import type { LlmClient } from '../translation_graph/engine/batched_extraction';
import {
  matchesResourceFilter,
  resolvePositionResources,
} from '../translation_graph/engine/files/resources';
import { DOCUMENT_STORE_OWNER, documentStoreFileRef } from '../translation_graph/engine/files/document_store';
import {
  Environment,
  MovementEngineError,
  applyHopOrderLimit,
  bindingOf,
  bindValue,
  recordFields,
  closedHopPushdown,
  decidePurePredicate,
  describeBinding,
  evalMovementExpr,
  extractPositionOf,
  evaluateMovementExpression,
  hopFilterKeeps,
  isCallableBinding,
  isDictValue,
  isFileUnreadable,
  hopMemberGate,
  binding,
  hopOrderKeyReader,
  nodeEdgeLandings,
  readLandingField,
  snapshotOfHandle,
  snapshotOfRecord,
  startsWithOldEdge,
  unsupported,
  type Binding,
  type DeferredWalk,
  type NodeEdge,
  type LocalLandingShape,
  type HandleGraph,
  type MovementEvalResult,
  type MovementExprContext,
  type MovementMetaContext,
  type MovementTraceEntry,
  type SourceRead,
  type WriteRecord,
} from './expression';
import {
  NO_PROVENANCE,
  ProvenanceSummariser,
  transformed,
  fieldEvidenceFromProvenance,
  unionProvenance,
  type ExtractSiteSummary,
  type Provenance,
  type SummarisedOrigin,
} from './provenance';
import { surfaceReadAdapter } from './kg';
import { localEdgeAdapter, localRecordLock } from './local_edge_adapter';
import {
  countShapeNodes,
  ExtractCallRunState,
  makeAnthropicExtractCallClient,
  runExtractCall,
  type ExtractCallLlmClient,
} from './extraction_call';
import { extractionCallSettings, type ExtractionCallSettings } from './ai_tiers';
import { parseChatModelName } from '../../lib/models/registry';
import { selectModel } from '../translation_graph/engine/batched_extraction/schema_synthesis';
import {
  buildDeclarationSpec,
  buildExtractSpec,
  makeAnthropicLlmClient,
  materializeExtract,
  recordExtractedEntities,
  registryTransformInvoker,
  invokePricedTransform,
  tracedUrl,
  type DeclaredNodeShape,
  type ExtractNodeSpec,
  type ExtractEmission,
  type FileTextResolution,
  type MovementTransformInvoker,
  type TransformInvocationResult,
} from './extraction';
import { RunCancelledSignal } from './cancel_gate';
import { getErrorMessage } from '../../lib/utils/error';
import { logger } from '../logger';
import { emitOpsEvent } from '../../lib/ops/emit';
import { OpsEventType, OpsSeverity } from '../../lib/ops/types';
import { makeFileTextResolver } from './file_text';
import {
  ROOT_ADDRESS,
  childBranch,
  childCall,
  childIter,
  childStmt,
  encodeAddress,
  parseAddress,
  type Address,
  type AddressStep,
} from './address';
import { EffectLocks, bindLock, edgeLock, identityLocks, recordLock, type LockRequest } from './effect_locks';
import {
  assertParkRead,
  carriesChain,
  newParkReader,
  newParkWriter,
  registerLiveScope,
  newParkReaderOf,
  rehydrateBinding,
  serializeBinding,
  serializeScopeChain,
  type ParkReader,
  type ParkWriter,
  type BindingDescriptor,
  type FileRefDescriptor,
  type InstanceIdentityDescriptor,
  type ParkedScopeState,
  type RehydrationContext,
  type SerializedCallEvent,
  type SerializedFrame,
  type SerializedScope,
} from './serialize';
import type { CallbackSink } from './callback_sink';
import type { CallbackCall, CallbackParamSpec } from './callback_store';
import { isCallbackParamType } from './callback_store';
import { isAdapterCallCeilingExceeded, withRunCallLedger } from './run_scope';
import { CallDepthExceeded, isCallDepthExceeded, maxCallDepth } from './call_depth';
import {
  currentRunSpend,
  formatUsd,
  isRunCostCapExceeded,
  RUN_COST_CAP_ENV_VAR,
  type RunCostCapExceeded,
} from '../../lib/run_spend';

/** The in-memory graph a `Called` landing belongs to. A callback belongs to no
 *  SYSTEM, so this names the construct, never an adapter — it is what an `IS`
 *  test would compare against, and it is derived in one place. */
const CALLBACK_LANDING_SHAPE = 'callback';
// ── Public surface ──────────────────────────────────────────────────────────

export interface RunMovementInput {
  /** The movement program text (`.mvt` source). */
  source: string;
  /**
   * The language version the movement is pinned to — the run compiles and
   * executes under it, and it is the run context's `languageVersion` for every
   * plugin and adapter the run calls (`currentLanguageVersion()`). Absent ⇒
   * the current version. A version this release does not support is refused
   * (MOVENG_LANGUAGE_VERSION), never run as the current one.
   */
  languageVersion?: LanguageVersion;
  /** Which movement to run; optional when the program declares exactly one. */
  movementName?: string;
  /** The triggering event — the movement parameter's position. */
  event: TriggerEvent;
  teamId: TeamId;
  /**
   * When this run FIRED — the instant every clock read in it answers from
   * (`@current_date`, `@current_timestamp`, `DATE.TODAY(zone)`). The host
   * passes the run row's `started_at`, which a resume reads back unchanged, so
   * a run that parks for a day still computes the window it started with.
   *
   * Absent ⇒ the interpreter pins `new Date()` once at construction: still one
   * instant for the whole run, just not one that survives a park. Every path
   * that can park supplies it.
   */
  firedAt?: Date;
  /**
   * What this run spent in its EARLIER segments, in microdollars — the host
   * reads it back off the run's record when it resumes a parked run, so the
   * cost cap (`lib/run_spend.ts`) holds across every park. Absent ⇒ a fresh
   * run, which has spent nothing.
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
  /** The checker's catalog (adapters / credentials / instance schemas). */
  catalog: Catalog;
  /**
   * Adapter resolution — the SAME seam `evaluateTranslationGraph` and
   * provision use. Defaults to the production resolver; simulate / tests
   * inject fakes per adapterType + role.
   */
  resolveAdapter?: (input: {
    adapterType: string;
    teamId: TeamId;
    credentialsId?: string;
    /** Non-credential construction args (unquoted) — the instance's entry
     *  position (Sheets' `spreadsheet:`). Position-free adapters ignore it. */
    constructionArgs?: Record<string, string>;
    role: 'source' | 'target';
  }) => Adapter | Promise<Adapter>;
  /** Imported credential name → `external_service_credentials.id` (the
   *  team catalog's `resolveCredentialId`). Absent → no credentialsId. */
  resolveCredentialId?: (credentialName: string) => string | undefined;
  /** Wrap every target adapter so writes are captured, not performed. */
  dryRun?: boolean;
  /** Receives each would-be write under `dryRun` — same `CapturedWrite`
   *  currency as the TG engine's dry runs. */
  writeSink?: DryRunWriteSink;
  /**
   * The extraction module's LLM client — the SAME pluggable interface
   * the TG batched-extraction pipeline takes. Defaults to the
   * anthropic-backed production client; tests inject a deterministic
   * stub.
   */
  llm?: LlmClient;
  /** The extraction CALL's model client (`extract(content, Shape)`), which
   *  sends its prompt as blocks with cache breakpoints. Defaults to the
   *  Anthropic-backed client; tests inject a stub. */
  extractCallLlm?: ExtractCallLlmClient;
  /** `through` plugin dispatch. Defaults to the TG transform registry;
   *  tests inject a deterministic stub. */
  transformInvoker?: MovementTransformInvoker;
  /**
   * Source `FileRef` → extracted TEXT (the knowledge-pipeline parity path,
   * §3a). Defaults to the production resolver (owner-adapter byte fetch →
   * OCR/text → RawText); tests inject a deterministic stub mocking the
   * resolve + OCR boundary. */
  resolveFileText?: (ref: FileRef) => Promise<FileTextResolution>;
  /**
   * File-import resolution (movement libraries, §H) — the ONE seam the
   * engine takes for imports. Resolution itself lives in movement-lang
   * (`linkImports`, the same structure `checkProgramWithLink` validates):
   * the engine consumes the already-resolved link — imported movements
   * execute against their library's own file environment, imported
   * shapes bind as declarations. Absent → file imports raise
   * MOVENG_UNSUPPORTED (the pre-library behavior). apps/api passes the
   * team catalog's storage-backed resolver
   * (`movementCatalogForTeam(...).resolveFile`).
   */
  resolveFile?: ResolveFile;
  /**
   * The durable-park sink. The interpreter hands this a park's details — the
   * lexical address + serialized scope — for a cost / timer / await park; the
   * sink persists the `parked_run` row and flips the run to `parked`
   * (§5.2/§5.5). Absent ⇒ a run that reaches a park raises MOVENG_UNSUPPORTED
   * (no durable substrate — e.g. a dry run / test harness with no recorder).
   */
  parkSink?: ParkSink;
  /**
   * The callback seam (callback-primitive layer 2): minting a `callback(…)`,
   * reading its call ledger, and correlating an `await cb-[:Called]->` park.
   * Absent ⇒ a movement that mints a callback raises MOVENG_UNSUPPORTED (no
   * durable substrate — a dry run / test harness with no recorder).
   */
  callbackSink?: CallbackSink;
  /**
   * The cooperative cancel gate (runs-and-cancel spec §cancel). Consulted at each
   * statement boundary (debounced DB read) and at each LLM-call boundary (sync
   * cached value): a user-requested cancel throws `RunCancelledSignal`, caught at
   * the top of `run()`/`resume()` so the run settles `failed` (never mid-write).
   * Absent ⇒ the run is never cancel-gated.
   */
  cancelGate?: CancelGate;
  /**
   * Where the ENGINE may suspend a flow of its own accord (`suspendFlow`):
   * asked before every statement and before every call a statement makes; a
   * `true` parks that flow just before the statement, to re-run it on resume
   * (the calls it had already finished are replayed, not made again). This is
   * the seam a run limit suspends through — the cost cap's check is the
   * production caller; tests drive it directly. Absent ⇒ the engine never
   * suspends a run on its own.
   */
  suspendWhen?: (point: SuspensionPoint) => boolean;
  /**
   * The array the run appends its decision trace to. Supplied by a caller that
   * wants to READ the trace while the run is still going — the run holds it by
   * reference, so a flusher watching the same array sees each entry as it
   * lands. Absent ⇒ the run keeps its own, and the trace is visible only on the
   * result.
   */
  trace?: MovementTraceEntry[];
}

/** Why a run paused: the limit it met, with what it had spent against it and
 *  the cap (in microdollars). Today the only limit is the cost cap. */
export interface RunLimitPause {
  limit: 'cost';
  capMicrodollars: number;
  spentMicrodollars: number;
}

/** A place the engine may suspend a flow (`RunMovementInput.suspendWhen`):
 *  just before a statement, or just before the k-th call a statement makes
 *  (`address` ends in that call's `c k` step). Either way the flow parks at the
 *  STATEMENT and re-runs it on resume. */
export interface SuspensionPoint {
  kind: 'statement' | 'call';
  address: string;
}

/**
 * The durable-park seam — injected so the pure interpreter never touches the
 * DB directly (mirrors `resolveAdapter`/`writeSink`). The recorder-backed
 * production sink lives in `runMovementFiring`.
 */
export interface ParkSink {
  /**
   * Record (or top up) a JOIN frame's pending-count (§5.4, 3.2b) — the number of
   * its child branches that PARKED. `interpretParallel` / `interpretBlock` call
   * this when they re-throw `RunParked` after firing all N children: the frame
   * (a parallel / fan-out) is itself pending until every parked child resolves.
   * Idempotent on (run_id, frame_address) — a re-run that re-reaches the same
   * frame OVERWRITES the count to the same value (the frontier is deterministic
   * under P11), so a crashed-then-re-run firing never double-counts.
   */
  recordJoin(input: { frameAddress: string; parkedChildren: number }): Promise<void>;
  /**
   * Record a TIMER park (`sleep` statement): UPSERTs a `parked_run` row with
   * `park_reason='timer'` and `wake_at` set to the absolute resume instant, then
   * marks the run `parked`. No `interaction_request` is created and no token is
   * minted — the wake driver resumes without a human answer. Idempotent on
   * `(run_id, address)`.
   */
  commitTimerPark(input: { address: string; state: unknown; wakeAt: Date }): Promise<void>;
  /**
   * Record an AWAIT park (`await x-[:E]->` untilNonEmpty, asks-as-adapter §A):
   * a `parked_run` row with `park_reason='await'` + the serialized scope. Unlike
   * `commitPark` there is NO `interaction_request` and NO token — the awaitable
   * adapter's own correlation map (registered via `correlate`, which the sink
   * hands the run id) drives resume, which RE-ENTERS at the await (`reenter`)
   * and re-checks live. Idempotent on `(run_id, address)`.
   */
  commitAwaitPark(input: {
    address: string;
    state: unknown;
    /** Register the awaitable adapter's correlation for this park — invoked with
     *  the sink's run id (the interpreter supplies the adapter + record). */
    correlate: (runId: string) => Promise<void>;
  }): Promise<void>;
  /** Resume-unwind join decrement (§6.1). Returns { closed } — true for the unique
   *  branch that closes the frame (runs the post-join continuation). Crash-safe closer
   *  identity via join_pending.closed_by_address. Per-leaf EXACTLY-ONCE via the
   *  `branchAddress` decrement claim (join_branch_export.decremented, §7): a branch
   *  re-scanned after a crash between its decrement and its leaf delete does NOT
   *  decrement the join a second time. */
  decrementJoin(input: {
    frameAddress: string;
    branchAddress: string;
    leafAddress: string;
  }): Promise<{ closed: boolean }>;
  /** Persist a completed branch's exports at its join frame (§12.1), before decrement. */
  persistBranchExport(input: {
    frameAddress: string;
    branchAddress: string;
    branchIndex: number;
    exports: unknown;
  }): Promise<void>;
  /** Collect all branches' persisted exports for a frame, ordered by branchIndex (§12.4). */
  collectBranchExports(input: { frameAddress: string }): Promise<
    Array<{ branchAddress: string; branchIndex: number; exports: unknown }>
  >;
  /**
   * Cancel every park under the given subtree prefixes (asks-as-adapter chunk C
   * — the race cascade, P17). For each parked leaf whose address is at-or-below
   * a prefix: deliver the one cancellation signal (drop its awaitable-adapter
   * correlation so a late resolution lands as data, F7), delete its `parked_run`
   * row, and clear any `join_pending` frame within the cancelled subtree (S19 —
   * no dangling bookkeeping). Idempotent (a re-scan finds the rows gone).
   */
  cancelSubtrees(input: { subtreeAddresses: string[]; excludeLeaf?: string }): Promise<void>;
  /**
   * Record an ENGINE-INITIATED suspension (`suspendFlow`): a `parked_run` row
   * whose state says `suspended` — resume re-enters AT the statement
   * (`reenter`) and replays the calls it had finished. No correlation and no
   * wake time: what resumes it is resuming the run (`limit_pause.ts`).
   * Optional: a sink without it (a rehearsal) cannot suspend, so a run that
   * meets its cost cap there fails on the cap instead.
   */
  commitSuspension?(input: { address: string; state: unknown }): Promise<void>;
  /**
   * The run has just met a limit and is PAUSING: mark the run paused (with
   * the limit, what it spent and the cap — what its status shows) and say so
   * (the `Run Paused` system event). Called once, by the first flow to meet
   * the limit, before any flow's `commitSuspension`.
   */
  commitLimitPause?(pause: RunLimitPause): Promise<void>;
}

/**
 * The cooperative cancel gate (runs-and-cancel spec §cancel). A user-requested
 * cancel stops the run at the next STATEMENT boundary, and — because one
 * statement can be minutes of work — at the boundaries INSIDE a statement too:
 * every LLM call and every plugin invocation of an extraction
 * (`extraction.ts`). Cancel means "stop doing things", not just "stop spending".
 *
 * Every one of those is the same debounced async read, which is the point: a
 * gate whose in-statement reading was a cached value could only ever repeat what
 * the statement boundary already knew, and a statement that is the movement's
 * last one has no next boundary to learn from. The recorder-backed production
 * gate is `makeDbCancelGate` (`cancel_gate.ts`), which debounces to one DB read
 * per few seconds across all of them. Fail-open: a read fault reads as
 * not-cancelled (a DB blip must never stop a healthy run). Absent ⇒ the run is
 * never cancel-gated (dry runs, bare `runMovement`).
 */
export interface CancelGate {
  /** Debounced async check — every boundary's gate, statement and in-statement
   *  alike. Latches once true, and one read serves them all. */
  cancelled(): Promise<boolean>;
  /** The same check with the debounce skipped, for the run's FINAL boundary —
   *  where a stale "no" is not a few seconds' latency but a cancel discarded
   *  forever, because there is no later boundary to notice it at. */
  cancelledNow(): Promise<boolean>;
  /** The stamped human-readable reason, once cancelled. */
  reason(): string | null;
}

// The cancel signal lives beside the gate that raises it (cancel_gate.ts) so
// both the interpreter and the extraction seam import it cycle-free;
// re-exported here for the engine's public surface, alongside `CancelGate`.
export { RunCancelledSignal };

/**
 * One applied (or dry-run-captured) write, in program order — the
 * firing-record entry. This IS the `WriteRecord` a write handle binds to
 * (see `expression.ts`): producing the adapter write and recording it
 * onto the firing log are one act, so the binding value and the firing
 * entry are the same object. The alias preserves the firing-log name at
 * the call sites that recorded the run's writes. The result's record has no
 * `old`: that member is the engine's own handle (its instance, adapter slug,
 * credential name and schema), which only `-[:@old]->` reads while the run lasts.
 */
export type MovementWriteRecord = Omit<WriteRecord, 'old'>;

export interface MovementRunResult {
  movementName: string;
  /** What this SEGMENT spent on priced work (model calls, paid services,
   *  priced plugins), in microdollars — absent when it spent nothing. A
   *  resumed segment counts only its own spend here; the run's figure is
   *  `runSpentMicrodollars`. */
  spentMicrodollars?: number;
  /** What the whole RUN has spent, every segment up to and including this
   *  one — what the cost cap reads. Present whenever the run has spent
   *  anything, even if this segment did not. */
  runSpentMicrodollars?: number;
  /** This segment's spend by where it went (`costSourceKey`: `model:<model>`,
   *  `service:<vendor.product>`, `plugin:<name>`, …) — absent when it spent
   *  nothing. Segments add up to the run's breakdown. */
  spentBySource?: Record<string, number>;
  /** Writes in program order — the firing record's raw material. */
  writes: MovementWriteRecord[];
  /** The extraction call sites the writes' provenance references,
   *  interned by site id (refs in `provenance`, detail here, once). */
  extractionSites: Record<string, ExtractSiteSummary>;
  /** Decision-point trace, in program order — why the run did (or did
   *  not do) what it did. See `MovementTraceEntry`. */
  trace: MovementTraceEntry[];
  /**
   * The run PARKED at an `ask` (async user interaction) rather than running
   * to completion — its parked frontier + the `interaction_request`(s) are
   * persisted, the `trigger_run` is `parked`, and the firing caller must NOT
   * finalise it as a terminal run (it resumes when the answer arrives). Absent
   * / false ⇒ an ordinary completed run.
   */
  parked?: boolean;
  /**
   * The lexical address the run (re-)parked at — present iff `parked`. The
   * await-resume driver (`await_resume.ts`) compares it to the leaf it re-entered:
   * a DEEPER/different address means the leaf's await RESOLVED and the resumed
   * body parked forward (drop the now-stale leaf); the SAME address means the
   * await RE-ARMED without resolving (a WHERE-narrowed await whose live landings
   * still don't match) — its park rows were just re-committed, so leave them be.
   * Without this the driver can't distinguish the two and destroys a re-armed
   * park, stranding the run parked forever.
   */
  parkedAddress?: string;
  /**
   * The run was CANCELLED by a user request (runs-and-cancel spec §cancel): the
   * interpreter hit the cancel gate at a statement / LLM-call boundary and threw
   * `RunCancelledSignal`. Exactly parallel to `parked` — the firing caller must
   * NOT finalise it as success/partial; it settles the run `failed` (via
   * `failRunAndCancelRequests`). Earlier writes stand (P14). Absent / false ⇒ not
   * cancelled.
   */
  cancelled?: boolean;
  /**
   * Race frames whose settlement was DEFERRED under batch resume (asks-as-adapter
   * chunk C, F18/F21): a branch completed but the race was not settled inline, so
   * the resume worker can drive every resolvable branch of the batch to
   * completion first and then settle ONCE with all winners. The worker calls
   * `settleRaceFrame` for each after the batch pass. Absent under inline
   * (timer/cost/ask) resume.
   */
  deferredRaceFrames?: string[];
}

/**
 * A run that DIED mid-way, carrying out the ledger of what it had already done.
 *
 * Writes hit external systems inline, so a throw after the third write leaves
 * three real records behind. Before this channel the ledger died with the stack
 * and the firing record claimed nothing happened — users re-ran and collided
 * with their own writes.
 *
 * Deliberately transparent: `message`, `name` and `stack` are the original
 * error's and it hangs off `cause`, so logs and failure reasons read exactly as
 * they did. Only genuine failures are wrapped — `RunParked`,
 * `RunCancelledSignal` and `ScopeEndedQuietly` are control flow and never reach
 * here.
 */
export class MovementRunFailed extends Error {
  constructor(
    cause: unknown,
    /** Everything the run had done when it died: writes in program order, the
     *  extraction sites their provenance references, and the decision trace. */
    readonly partial: MovementRunResult,
  ) {
    super(getErrorMessage(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'MovementRunFailed';
    if (cause instanceof Error && cause.stack !== undefined) this.stack = cause.stack;
  }
}

/**
 * The error a run really died of. `MovementRunFailed` is a transparent CARRIER
 * for the partial ledger, so anything that discriminates on the error itself —
 * its class, its `MovementEngineError` code — must look THROUGH it. Errors
 * raised before the interpreter starts (parse / check) are never wrapped and
 * pass straight back.
 */
export function runFailureCause(error: unknown): unknown {
  return error instanceof MovementRunFailed ? error.cause : error;
}

export async function runMovement(input: RunMovementInput): Promise<MovementRunResult> {
  // Error severity only: info diagnostics (MOV_LISTEN_MISSING — a
  // dispatchable movement with no listen) never block a run; the engine is
  // routinely handed library movements to execute directly. With a
  // resolveFile, the check RESOLVES file imports and the returned link is
  // the engine's import structure — validation and execution consume one
  // resolution.
  const { program, link } = parseAndCheck(input);
  // Every way into the interpreter opens the same door: one segment, one
  // third-party call ceiling (run_scope.ts). A fifth entry point that
  // forgets `withRunCallLedger` loses the safeguard silently, so they all
  // wrap here rather than deeper.
  return withRunCallLedger(() => new Interpreter(input, link).run(program), runScopeOf(input));
}

/** The run context every entry point opens its segment under. */
function runScopeOf(input: RunMovementInput): {
  languageVersion: LanguageVersion;
  priorSpentMicrodollars: number;
  capBaselineMicrodollars: number;
} {
  return {
    languageVersion: input.languageVersion ?? CURRENT_LANGUAGE_VERSION,
    priorSpentMicrodollars: input.priorSpentMicrodollars ?? 0,
    capBaselineMicrodollars: input.capBaselineMicrodollars ?? 0,
  };
}

/**
 * Diagnostics an author may no longer WRITE, but a saved program may still
 * RUN. A retirement refuses the construct where a program is authored; it must
 * not stop automations that were saved while the construct was legal, so the
 * run gate lets exactly these through and the engine still executes them.
 *
 * Empties out at the wave that deletes each construct's engine path — see the
 * deploy block in
 * plans/2026-06-10-data-movement-language/9_node_synthesis_build.md.
 */
const RETIRED_BUT_STILL_RUNNABLE = new Set<string>([DiagnosticCodes.WRITE_SHAPE_RETIRED]);

/** Parse + check the program, throwing the same MOVENG_PARSE / MOVENG_CHECK
 *  errors `runMovement` does. Shared by run + resume so a resume re-validates
 *  the pinned source exactly as a fresh run did. */
function parseAndCheck(input: RunMovementInput): { program: Program; link?: ProgramLink } {
  const languageVersion = input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  // The pin is answered before the source is read: a version this release
  // cannot honour must fail as exactly that, not as whatever the current
  // grammar makes of the text.
  const versionDiagnostic = languageVersionDiagnostic(languageVersion);
  if (versionDiagnostic !== undefined && diagnosticSeverity(versionDiagnostic) === 'error') {
    throw new MovementEngineError('MOVENG_LANGUAGE_VERSION', versionDiagnostic.message, [
      versionDiagnostic,
    ]);
  }
  let program: Program;
  try {
    program = parseProgram(input.source, { languageVersion });
  } catch (e) {
    if (e instanceof MovementParseError) {
      throw new MovementEngineError('MOVENG_PARSE', e.message);
    }
    throw e;
  }
  const { diagnostics: allDiagnostics, link } = checkProgramWithLink(program, input.catalog, {
    languageVersion,
    ...(input.resolveFile !== undefined ? { resolveFile: input.resolveFile } : {}),
  });

  const diagnostics = allDiagnostics.filter(
    (d) => (d.severity ?? 'error') === 'error' && !RETIRED_BUT_STILL_RUNNABLE.has(d.code),
  );
  if (diagnostics.length > 0) {
    throw new MovementEngineError(
      'MOVENG_CHECK',
      `the movement program failed checking:\n${diagnostics
        .map((d) => `  ${d.code} (line ${d.span.start.line}): ${d.message}`)
        .join('\n')}`,
      diagnostics,
    );
  }
  return { program, ...(link !== undefined ? { link } : {}) };
}

export interface ResumeMovementInput extends RunMovementInput {
  /** The parked leaf's serialised scope state (`parked_run.state`) — chunk 4's
   *  `ParkedScopeState`. Re-parsed source + this rebuild the env. */
  state: ParkedScopeState;
  /** The validated answer value (already checked against the ask's result type
   *  by `recordAnswer`). For a scalar result (`Check<boolean>` / an enum) this
   *  is the JSON scalar; it binds as the ask's result `r` at the ask's binding
   *  name (§4.4 — scalar answer → a value binding). Absent under `reenter` (a
   *  cost / error park has no answer to bind). */
  answer?: unknown;
  /**
   * Resume-at-statement mode (the GENERAL re-enter primitive, §4.4). Optional,
   * DEFAULTING to the ask behaviour (false):
   *
   *   - false / absent (ASK resume): the parked leaf's address is the ASK's own
   *     statement; the ask's effect IS the answer, so resume binds `answer` at the
   *     ask's binding name and steps FORWARD from the statement AFTER it
   *     (`stmtIndex + 1`). Every existing caller (`interaction/resume.ts`) keeps
   *     this behaviour unchanged.
   *   - true (RE-ENTER resume): the parked leaf's address is a statement whose
   *     effect must be RE-EVALUATED rather than stepped past — an `await` that
   *     re-checks live, or a recurring `until` timer. Resume binds NO answer and
   *     RE-ENTERS AT that statement (`stmtIndex`), running it and the rest of its
   *     branch forward.
   */
  reenter?: boolean;
  /** Batch mode (F18/F21): the await-resume worker sets this so a race branch's
   *  completion is DEFERRED (recorded in the result's `deferredRaceFrames`)
   *  instead of settling inline — the worker settles once, post-batch, with every
   *  winner. Inline resumers (timer/ask) omit it. */
  deferRaceSettlement?: boolean;
}

/**
 * Resume a parked movement run forward from its parked `ask` leaf (async user
 * interaction §4.7 stage 3). The `source` MUST be the version-pinned source the
 * run parked against (P11), so the re-parsed AST — and every lexical address —
 * is byte-identical. Single-ask linear body only (chunk 5).
 */
export async function resumeMovement(input: ResumeMovementInput): Promise<MovementRunResult> {
  const { program, link } = parseAndCheck(input);
  // The answer graph `r` (§4.4): for the single-ask scalar case it's a value
  // binding (the validated answer); the post-ask body reads it as a value. A
  // `Correct` answer is a curated position-SET (the edited + surviving rows) —
  // re-materialise it into a TRAVERSABLE extract-result binding so the resumed
  // body iterates it (`clean-[c:T]-> { … c.\`field\` … }`) and reads each row's
  // edited fields off the synthetic emission (chunk 6c). Under `reenter` there is
  // no answer to bind (cost / error resume re-enters AT the un-run statement).
  const answer: Binding | undefined = input.reenter ? undefined : rematerialiseAnswer(input.answer);
  return withRunCallLedger(() =>
    new Interpreter(input, link).resume({
      program,
      state: input.state,
      ...(answer !== undefined ? { answer } : {}),
      ...(input.reenter !== undefined ? { reenter: input.reenter } : {}),
      ...(input.deferRaceSettlement !== undefined
        ? { deferRaceSettlement: input.deferRaceSettlement }
        : {}),
    }),
    runScopeOf(input),
  );
}

/**
 * Settle a race frame whose branches completed under batch resume (asks-as-
 * adapter chunk C, F18/F21). Called by the await-resume worker ONCE per deferred
 * frame after the whole batch pass: it builds the receipt from EVERY completed
 * branch's exports (all winners), cancels the still-parked losing branches (the
 * one signal, P17), binds the receipt, and runs the race's continuation forward.
 * `state` is any completed branch's parked state (its scope chain covers the
 * race's parent — the settlement re-enters at the race statement, not the leaf).
 */
export async function settleRaceFrame(
  input: ResumeMovementInput & { frameAddress: string },
): Promise<MovementRunResult> {
  const { program, link } = parseAndCheck(input);
  return withRunCallLedger(() =>
    new Interpreter(input, link).settleRaceFrame({
      program,
      state: input.state,
      frameAddress: input.frameAddress,
    }),
    runScopeOf(input),
  );
}

/**
 * Run a fired callback's body against its captured continuation (callback-
 * primitive layer 2). `state` is the callback row's stored state — the same
 * `ParkedScopeState` a park writes, whose `address` is the callback expression's
 * entry point. `source` MUST be the run's version-pinned source (P11), so the
 * address resolves to the same expression it was minted from.
 */
export async function fireCallbackBody(
  input: ResumeMovementInput & { values: Record<string, unknown>; callIndex: number },
): Promise<MovementRunResult> {
  const { program, link } = parseAndCheck(input);
  return withRunCallLedger(() =>
    new Interpreter(input, link).fireCallback({
      program,
      state: input.state,
      values: input.values,
      callIndex: input.callIndex,
    }),
    runScopeOf(input),
  );
}

/** The shape `validateAnswer` produces for a `Correct` answer — the curated +
 *  edited rows, tagged so resume knows to re-materialise a position-set (vs a
 *  scalar). Interaction-scoped; never persisted beyond the answer. */
interface CorrectAnswer {
  __correct: { type: string; rows: Array<{ fields: Record<string, unknown> }> };
}

function isCorrectAnswer(value: unknown): value is CorrectAnswer {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__correct' in value &&
    typeof (value as { __correct: unknown }).__correct === 'object'
  );
}

/**
 * Turn a validated answer into the binding the resumed body reads as `r`. A
 * `Correct` answer (the curated row-set) re-materialises into a synthetic
 * `extractRoot` emission: one child emission per SURVIVING row under the
 * Correct type's edge, each carrying the row's edited `fields`. A later
 * `clean-[c:<type>]->` walks `emission.children.get('<type>')` (the same path an
 * extract result is traversed) and `c.\`field\`` reads `emission.fields[field]`
 * — so the edited values flow into the downstream write; dropped rows are simply
 * absent (unreachable → unwritten, 3i). Any other answer binds as a value.
 */
function rematerialiseAnswer(answer: unknown): Binding {
  if (isCorrectAnswer(answer)) {
    const { type, rows } = answer.__correct;
    const children = new Map<string, ExtractEmission[]>();
    children.set(
      type,
      rows.map((row) => ({
        nodeName: type,
        fields: row.fields,
        provenance: {},
        // A curated row-set is user-edited data, not file-fed extraction — no
        // source resources to carry forward.
        resources: [],
        children: new Map<string, ExtractEmission[]>(),
      })),
    );
    return binding({
      kind: 'extractRoot',
      emission: { nodeName: type, fields: {}, provenance: {}, resources: [], children },
    });
  }
  return binding({ kind: 'value', value: answer, provenance: NO_PROVENANCE });
}

/**
 * What a body did when it finished. `returned` is the fact a caller acts on —
 * a call's value IS its callee's return, and a body that fell off the end has
 * none. Kept as a discriminated pair rather than `Binding | undefined` so
 * "returned nothing" and "returned something we could not build" can never
 * read the same.
 */
type BodyOutcome = { returned: false } | { returned: true; value: Binding };

const FELL_THROUGH: BodyOutcome = { returned: false };

/**
 * The slot a `return` binds into, on the returning body's own scope.
 *
 * It exists for ONE reason: a parked iteration's return has to survive the
 * park, and what survives a park is a scope's bindings. So the return rides
 * out as one — under the `#` prefix that marks the engine's own names
 * (`#resources` is the other), which the checker refuses to authored bindings.
 * That is what makes it an identity rather than a name an author could
 * collide with: compared, never parsed.
 */
const RETURN_SLOT = '#return';

/**
 * Where a statement's right-hand side lands: an assignment's name, or a
 * `return`'s slot. The two share a grammar and an evaluation, so a resume that
 * rebuilds a parked right-hand side's value rebuilds it for either.
 */
function boundRValueOf(statement: Statement): { name: string; value: RValue } | undefined {
  if (statement.kind === 'assign') return { name: statement.name, value: statement.value };
  if (statement.kind === 'return') return { name: RETURN_SLOT, value: statement.value };
  return undefined;
}

/**
 * A `return` whose value is bound: the body returns, always — whatever the
 * value turned out to be (TS's `return undefined` still returns). The checker
 * narrows the rest of a body on that promise, so the fact is the statement's
 * kind, never the value's presence. An absent value fills the slot as absent,
 * so a park above still carries it.
 */
function returnFrom(env: Environment): BodyOutcome {
  const value = env.resolveOwn(RETURN_SLOT) ?? NULL_SLOT;
  env.declare(RETURN_SLOT, value);
  return { returned: true, value };
}

/** A statement's finished calls, as a park keeps them. */
function serializeCallRecords(records: ReadonlyMap<number, CallRecord>, park: ParkWriter): SerializedCallEvent[] {
  return [...records.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, record]) => ({
      index,
      value: record.value !== undefined ? serializeBinding(record.value, park) : null,
      next: record.next,
    }));
}

async function rehydrateCallRecords(
  events: readonly SerializedCallEvent[],
  ctx: RehydrationContext,
  park: ParkReader,
): Promise<Map<number, CallRecord>> {
  const out = new Map<number, CallRecord>();
  for (const event of events) {
    out.set(event.index, {
      value: event.value !== null ? await rehydrateBinding(event.value, ctx, park) : undefined,
      next: event.next,
    });
  }
  return out;
}

/** A live body boundary as a park keeps it. */
function serializeBoundary(boundary: LiveBoundary, park: ParkWriter): SerializedFrame {
  switch (boundary.kind) {
    case 'call':
      return {
        kind: 'call',
        index: boundary.index,
        next: boundary.next,
        callee: boundary.callee,
        journal: serializeCallRecords(boundary.site.calls.completed, park),
        scopeChain: serializeScopeChain(boundary.site.env.chainFromRoot(), park),
      };
    case 'member':
      return {
        kind: 'member',
        index: boundary.index,
        next: boundary.next,
        member: boundary.member,
        op: boundary.op,
        journal: serializeCallRecords(boundary.site.calls.completed, park),
        scopeChain: serializeScopeChain(boundary.site.env.chainFromRoot(), park),
      };
    case 'arm':
      return { kind: 'arm', arm: boundary.arm, body: boundary.body };
    default:
      return neverAsAny(boundary);
  }
}

/**
 * A flat snapshot of everything in lexical scope — what a deferred walk and a
 * closure both capture. Flat because bindings are single-assignment and nothing
 * declared later is in scope here, so a chain and its flattening say the same
 * thing; flat is also what serialises.
 */
function captureScope(env: Environment): Map<string, Binding> {
  const captured = new Map<string, Binding>();
  for (const scope of env.chainFromRoot()) {
    for (const [name, binding] of scope.ownBindings()) captured.set(name, binding);
  }
  return captured;
}

/** A call's value where one is REQUIRED — bound, or passed on. The checker
 *  refuses a callee that returns nothing at every such site, so reaching here
 *  means the saved program and the checker disagree. */
function requireCallValue(callee: string, value: Binding | undefined): Binding {
  if (value !== undefined) return value;
  throw new MovementEngineError(
    'MOVENG_RUNTIME',
    `'${callee}' returned nothing, so there is no value to bind — the checker should have caught this`,
  );
}

/** A bound block's value: what its iterations returned, in iteration order.
 *  All values ⇒ one value binding holding the list, so zero, one and many
 *  iterations read the same shape; positions ⇒ the landings, plural exactly as
 *  a traversal's are.
 *
 *  ZERO returns has no plane to pick — nothing came back to have one. The two
 *  representations agree there, and `positions` is the one that says so on both
 *  planes at once: read as a value it is the empty list (`COUNT` is 0, `JOIN`
 *  is ""), and hopped it yields no landings, which is the traversal gate. A
 *  value binding would answer the first and throw on the second, so the block a
 *  hop follows would work or fail on how many items its head happened to
 *  yield. */
function blockValue(returned: Binding[]): Binding {
  if (returned.length > 0 && returned.every((b) => b.kind === 'value')) {
    return binding({
      kind: 'value',
      value: returned.map((b) => (b.kind === 'value' ? b.value : null)),
      provenance: unionProvenance(
        returned.map((b) => (b.kind === 'value' ? (b.provenance ?? NO_PROVENANCE) : NO_PROVENANCE)),
      ),
    });
  }
  return binding({ kind: 'positions', landings: returned });
}

/** The value a slot holds when its arm handed nothing back — a filled slot and
 *  an empty one are the same shape, so a null check is the only difference. */
/** What a value that cannot be walked from IS, in the words a reader of the
 *  movement would use. */
function describeHeadValue(value: unknown): string {
  if (value === null || value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'a list';
  switch (typeof value) {
    case 'string':
      return 'text';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'true or false';
    default:
      return 'a plain value';
  }
}

const NULL_SLOT: Binding = binding({ kind: 'value', value: null, provenance: NO_PROVENANCE });

/** The fields `...e` writes: the list the checker resolved from `e`'s TYPE.
 *  Never read off the value — a record handed to a `<Deal>` parameter may carry
 *  fields `Deal` does not declare, and the write must not take them. */
function spreadFields(spread: WriteSpread): readonly string[] {
  if (spread.fields !== undefined) return spread.fields;
  throw new MovementEngineError(
    'MOVENG_RUNTIME',
    `'...${spread.source}' has no field list — the program was not checked, or the checker should have refused this spread`,
  );
}

/**
 * What a landing on a `<Entry>`-typed edge starts with — the declaration's
 * fields and nested nodes, as a tree.
 *
 * The nesting IS the edge (`shapeToSchema` composes a child's key the same
 * way), so this is that same fact in the interpreter's currency: the names an
 * appendable edge has to exist under for a `link` to have somewhere to append,
 * and the field names in the order the declaration wrote them. Nothing but a
 * node DECLARATION says it, so anything else resolves to nothing.
 */
function declaredLandingShape(node: ShapeNode): LocalLandingShape {
  return {
    fields: node.fields.map((f) => f.name),
    edges: Object.fromEntries(node.children.map((child) => [child.name, declaredLandingShape(child)])),
  };
}

type NodePositionBinding = Extract<Binding, { kind: 'nodePosition' }>;

/** A field name onto a graph node's dot plane, once, in the order first met. */
function noteGraphField(node: NodePositionBinding, name: string): void {
  if (!node.fieldOrder.includes(name)) node.fieldOrder.push(name);
}

/** A child edge of a graph node, built here. A shape child says what a landing
 *  the run writes into it later carries, as a declared edge does. */
function setGraphEdge(
  node: NodePositionBinding,
  name: string,
  landings: Binding[],
  child: ShapeNode | undefined,
): void {
  delete node.fields[name];
  node.fieldOrder = node.fieldOrder.filter((f) => f !== name);
  // A node the graph builds on its edge has landed there: it is a record of
  // the run's own graph from now on, updatable in place.
  for (const landing of landings) {
    if (landing.kind === 'nodePosition' && landing.landedOn === undefined) landing.landedOn = name;
  }
  node.edges[name] = {
    kind: 'landed',
    landings,
    ...(child !== undefined ? { landingShape: declaredLandingShape(child) } : {}),
  };
}

/** Whether a value is, or anywhere holds, a record the engine made. */
function holdsRecord(value: unknown): boolean {
  if (bindingOf(value) !== undefined) return true;
  if (Array.isArray(value)) return value.some(holdsRecord);
  if (isDictValue(value)) return Object.values(value).some(holdsRecord);
  return false;
}

/** A spread value read as child nodes: one map, or a list of nothing but maps. */
function asMapList(value: unknown): Array<Record<string, unknown>> | undefined {
  if (isDictValue(value)) return [value];
  if (Array.isArray(value) && value.length > 0 && value.every(isDictValue)) return value;
  return undefined;
}

/**
 * Does a graph built from a spread map hold what its shape requires? The
 * checker answered this for everything it could see; a map it couldn't
 * (plugin output, JSON) is only seen here. Every non-null field must be there
 * and be the primitive it says, recursively through the children the map
 * brought.
 */
function graphValueMisfit(
  node: Binding,
  shape: ShapeNode,
  { path = '', presenceOnly = false }: { path?: string; presenceOnly?: boolean } = {},
): string | undefined {
  if (node.kind !== 'nodePosition') return undefined;
  for (const field of shape.fields) {
    const value = node.fields[field.name];
    if (value === undefined || value === null) {
      if (field.nullable === true) continue;
      return `it has no ${path}\`${field.name}\``;
    }
    if (presenceOnly) continue;
    const want = PRIMITIVE_RUNTIME_TYPES[field.type];
    if (want !== undefined && typeof value !== want) {
      return `its ${path}\`${field.name}\` is a ${typeof value}, not ${field.type}`;
    }
  }
  for (const child of shape.children) {
    const edge = node.edges[child.name];
    for (const landing of edge?.kind === 'landed' ? edge.landings : []) {
      const misfit = graphValueMisfit(landing, child, { path: `${path}${child.name} → `, presenceOnly });
      if (misfit !== undefined) return misfit;
    }
  }
  return undefined;
}

/**
 * The binding a spread copies from: its name's, or — for `...m.k` — what the
 * map holds under the key, bound as `x = m.k` would bind it.
 */
function spreadSourceBinding(spread: MapSpread, env: Environment): Binding | undefined {
  if (spread.path === undefined) return env.resolve(spread.source);
  let bound = env.resolve(spread.path.root);
  for (const key of spread.path.members) {
    const held = bound?.kind === 'value' ? bound.value : undefined;
    if (!isDictValue(held)) return undefined;
    bound = bindValue(held[key] ?? null, bound?.kind === 'value' ? bound.provenance : undefined);
  }
  return bound;
}

/**
 * The one record `...r` copies — held as a value or bound on the arrow plane —
 * or undefined when it is absent. Anything else is a program the checker
 * should have refused.
 */
function spreadRecord(spread: MapSpread, bound: Binding | undefined): Binding | undefined {
  const held = bound?.kind === 'value' ? bound.value : bound;
  if (held === undefined || held === null) return undefined;
  const record = bindingOf(held);
  if (record?.kind === 'positions') {
    if (record.landings.length > 1) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'...${spread.source}' copies one record's fields, and '${spread.source}' holds ${record.landings.length}`,
      );
    }
    return record.landings[0];
  }
  if (record === undefined) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `'...${spread.source}' copies a record's fields, and '${spread.source}' holds no record — the program was not checked`,
    );
  }
  return record;
}

/** Does any body of this graph literal take keys from a map? */
function spreadsAnywhere(literal: NodeLiteral): boolean {
  if (literal.spreads !== undefined) return true;
  return literal.entries.some((entry) => {
    if (entry.kind === 'nodes') return entry.nodes.some(spreadsAnywhere);
    if (entry.kind === 'traversal' && entry.mapping !== undefined) return spreadsAnywhere(entry.mapping);
    return false;
  });
}

/** The declared primitives a JSON value carries as itself. The rest (dates,
 *  files, declared option sets) arrive in forms this check doesn't judge. */
const PRIMITIVE_RUNTIME_TYPES: Readonly<Record<string, 'string' | 'number' | 'boolean'>> = {
  text: 'string',
  number: 'number',
  boolean: 'boolean',
};

type ShapeBinding = Extract<Binding, { kind: 'shape' }>;

/** `name` as a library file sees it, when it names a node declaration there:
 *  one the file declares, or one it imported (which then belongs to ITS file). */
function libraryShape(file: LinkedFile, name: string): ShapeBinding | undefined {
  for (const statement of file.program.statements) {
    if (statement.kind === 'shape' && statement.name === name) {
      return binding({ kind: 'shape', declaration: statement, library: file });
    }
  }
  const imported = file.imports.get(name);
  return imported?.kind === 'shape'
    ? binding({ kind: 'shape', declaration: imported.declaration, library: imported.file })
    : undefined;
}

/** What a `link` may append to a run-local node's edge: the binding kinds that
 *  ARE positions. A value, an instance or a closure is not one, and landing it
 *  would make the next traversal off the edge meaningless. */
const APPENDABLE_LANDING_KINDS: ReadonlySet<Binding['kind']> = new Set([
  'event',
  'handle',
  'sourcePosition',
  'nodePosition',
  'shapePosition',
  'extractRoot',
  'extractPosition',
]);

/** One arm, ready to run: the body, and the bindings it brings with it (a
 *  closure's capture, a movement's file scope). Absent ⇒ it sees only the scope
 *  the arm frame is a child of, which is where it was written. */
interface ArmInvocation {
  body: Statement[];
  /** The function's name, when the arm names one — a call by name, counted
   *  towards the call depth. */
  name?: string;
  captured?: Map<string, Binding>;
  /** An arm built at run time: its closure, which has no place in the source
   *  for a resume to find it at, so a park inside it carries it. */
  runtime?: ClosureExpression;
}

function isClosureBinding(value: unknown): value is Extract<Binding, { kind: 'closure' }> {
  return bindingOf(value)?.kind === 'closure';
}

/** The bindings a closure brings into a scope it runs in: the scope it holds
 *  (a file-level closure's file, a body closure's own) as it stands now, as a
 *  movement arm's — or the capture of one parked before closures held theirs. */
function closureCaptured(binding: Extract<Binding, { kind: 'closure' }>): Map<string, Binding> {
  const env = binding.file?.env ?? binding.env;
  return env !== undefined ? captureScope(env) : binding.captured;
}

/**
 * Build a race RECEIPT from the completed branches' environments (asks-as-adapter
 * chunk C, F13/F18). Reused at runtime as a `blockMeta`: every branch's
 * iff-executed bindings go in `edges` — NODE bindings traversed by arrow
 * (`r-[x:name]->`), SCALAR bindings read by dot (`r.name`, via
 * `readBindingField`'s blockMeta path). The checker already routed each name to
 * its plane, so both accesses resolve off the one map; a name completed by more
 * than one branch accumulates (union). */
/** A call written at FILE scope: there is no event there to call it about, so
 *  the callee's parameter could never be supplied with anything real. The
 *  static scan refuses it at save time (`interpretable.ts`); this is the same
 *  refusal at run time, for a program saved before it. */
function fileLevelCall(): MovementEngineError {
  return unsupported(
    'file-level calls',
    'a call runs inside a movement body, where the event is in scope',
  );
}

/**
 * The combinator receipt (layer 13 C3/C4). race: the winner's bindings, raw —
 * singular, so reads are bare. all: block constituents raw; a FAN-OUT's
 * scalar buckets PRE-COLLAPSE to one array value per name (stable cardinality
 * — the checker's list type reads the same for 1 and N iterations), its node
 * buckets stay raw (a plural receipt edge). Hop aliases are loop variables,
 * not exports.
 */
function buildCombinatorReceipt(
  contributions: Array<{
    constituentIndex: number;
    fanout: boolean;
    bindings: Iterable<[string, Binding]>;
  }>,
  mode: 'race' | 'all',
): Binding {
  const edges = new Map<string, Binding[]>();
  const push = (name: string, binding: Binding): void => {
    const bucket = edges.get(name) ?? [];
    bucket.push(binding);
    edges.set(name, bucket);
  };
  const byConstituent = new Map<number, typeof contributions>();
  for (const contribution of contributions) {
    const group = byConstituent.get(contribution.constituentIndex) ?? [];
    group.push(contribution);
    byConstituent.set(contribution.constituentIndex, group);
  }
  for (const group of byConstituent.values()) {
    if (!group[0].fanout || mode === 'race') {
      for (const contribution of group) {
        for (const [name, binding] of contribution.bindings) push(name, binding);
      }
      continue;
    }
    const grouped = new Map<string, Binding[]>();
    for (const contribution of group) {
      for (const [name, binding] of contribution.bindings) {
        const bucket = grouped.get(name) ?? [];
        bucket.push(binding);
        grouped.set(name, bucket);
      }
    }
    for (const [name, bucket] of grouped) {
      if (bucket.every((b) => b.kind === 'value')) {
        push(name, binding({
          kind: 'value',
          value: bucket.map((b) => (b.kind === 'value' ? b.value : null)),
          provenance: unionProvenance(
            bucket.map((b) =>
              b.kind === 'value' ? (b.provenance ?? NO_PROVENANCE) : NO_PROVENANCE,
            ),
          ),
        }));
        continue;
      }
      for (const binding of bucket) push(name, binding);
    }
  }
  return binding({ kind: 'blockMeta', edges });
}

function buildRaceReceipt(envs: Environment[]): Binding {
  const edges = new Map<string, Binding[]>();
  for (const branchEnv of envs) {
    for (const [name, binding] of branchEnv.ownBindings()) {
      const bucket = edges.get(name) ?? [];
      bucket.push(binding);
      edges.set(name, bucket);
    }
  }
  return binding({ kind: 'blockMeta', edges });
}

/** The child bindings reached by traversing edge `edge` off a meta-node binding
 *  (a race receipt / block meta) — mirrors expression.ts `walkMetaSteps`. A
 *  block-meta edge yields its accumulated bindings; a nested extract node yields
 *  its children; anything else yields nothing (an absent edge = the gate). */
function metaEdgeBindings(binding: Binding, edge: string): Binding[] {
  if (binding.kind === 'blockMeta') return binding.edges.get(edge) ?? [];
  if (binding.kind === 'nodePosition') {
    // A DEFERRED edge needs a walk, and this seam has no way to run one — say
    // so rather than yield nothing, which would read as an empty edge.
    if (binding.edges[edge]?.kind === 'deferred') {
      throw unsupported(
        `traversing the deferred edge '${edge}' of a synthesised node reached through a block meta-node`,
        'bind the node itself and traverse from there',
      );
    }
    return nodeEdgeLandings(binding, edge);
  }
  if (binding.kind === 'extractPosition' || binding.kind === 'extractRoot') {
    return (binding.emission.children.get(edge) ?? []).map(extractPositionOf);
  }
  return [];
}

/**
 * The `race([…])` / `parallel([…])` a container carries — awaited (the living
 * form) or bare (refused by the checker, still run for recovery). Undefined for
 * every other statement.
 */
function combinatorOf(container: Statement): CombinatorExpression | undefined {
  if (container.kind === 'combinator') return container.combinator;
  const bound = boundRValueOf(container)?.value;
  if (bound?.kind === 'combinator') return bound.combinator;
  const source =
    container.kind === 'await'
      ? container.await.source
      : bound?.kind === 'await'
        ? bound.await.source
        : undefined;
  return source?.kind === 'combinator' ? source.combinator : undefined;
}

/** The traversal block a fan-out container runs — bare, bound, or returned. */
function fanOutBlockOf(container: Statement): TraversalBlock | undefined {
  if (container.kind === 'block') return container.block;
  const bound = boundRValueOf(container)?.value;
  return bound?.kind === 'block' ? bound.block : undefined;
}

/** The literal arms a combinator was written with — the resume descent's
 *  branch-navigation currency. Arms built at run time have no static list, so
 *  nothing can be navigated into and this is empty. */
function literalArmsOf(expr: CombinatorExpression | undefined): ArmExpression[] {
  return expr !== undefined && expr.arms.kind === 'literal' ? expr.arms.arms : [];
}

/** The edge name of an awaited traversal's single hop — `-[:Response]->` and
 *  `-[got:Response]->` both yield `Response`. Backtick-quoted names are
 *  unwrapped. The checker has already validated the hop; this only extracts the
 *  name the awaitable capability keys on. */
function awaitEdgeName(hopsRaw: string): string {
  // -[ <alias>? : <name> <WHERE …>? ]-> — the alias (if any) precedes the FIRST
  // colon; the edge name follows it (optionally backtick-quoted).
  const inner = hopsRaw.replace(/^-\[/, '').replace(/\]->\s*$/, '');
  const colon = inner.indexOf(':');
  const afterColon = (colon >= 0 ? inner.slice(colon + 1) : inner).trim();
  const nameMatch = /^`([^`]+)`|^([^\s\]]+)/.exec(afterColon);
  return (nameMatch?.[1] ?? nameMatch?.[2] ?? afterColon).trim();
}

/** The pure WHERE predicate of an awaited hop (`q-[r:Response WHERE r.answer]->`)
 *  as an Expression — parsed off the head by probing the traversal with a
 *  sentinel terminal (the formula parser needs one). Undefined when the hop
 *  carries no WHERE or doesn't parse to a traversal. */
function awaitHopFilter(head: PathHead): Expression | undefined {
  const traverse = parseMovementExpression(
    `${probePathHead(head)}.\`__await_where_probe__\``,
  );
  if (traverse.type !== 'traverse') return undefined;
  const last = traverse.steps[traverse.steps.length - 1];
  return last !== undefined && last.type === 'edge' ? last.expressionFilter : undefined;
}

/**
 * Does one candidate landing satisfy the awaited hop's pure WHERE (B.1)? The
 * predicate is checker-guaranteed PURE, so its leaf reads resolve THROUGH the
 * adapter's `getFieldValue` for the landing's own type — the same read path the
 * bound body uses. Reading candidates the same way they'll be read post-bind is
 * what keeps an adapter that translates field names (Slack: `User` → `user`)
 * honest under a WHERE without the engine knowing any adapter's internal keys.
 *
 * Decided as a hop WHERE is (`decidePurePredicate`): an AND stops at its first
 * false conjunct, so a field the rest of the WHERE names is never asked of a
 * candidate that has already failed — an adapter may rightly refuse to read it.
 */
export async function awaitLandingMatches(input: {
  filter: Expression;
  adapter: Adapter;
  adapterType: string;
  landing: { recordType?: string; fields: Record<string, unknown> };
}): Promise<boolean> {
  const position = makeUnstablePosition({
    adapterType: input.adapterType,
    recordType: input.landing.recordType ?? 'Response',
    data: input.landing.fields,
  });
  return Boolean(
    await decidePurePredicate(input.filter, (leaf) => {
      const key = leafReadKey(leaf);
      const dot = key.indexOf('.');
      // A leaf reads `<alias>.field` or a bare `field` — the alias IS the
      // landing, so strip it to the field name the adapter keys by.
      const field = dot >= 0 ? key.slice(dot + 1) : key;
      return input.adapter.getFieldValue({ position, fieldId: field });
    }),
  );
}

// ── The interpreter ─────────────────────────────────────────────────────────

/** Per-body interpretation context. `atAnchor` is true while statements
 *  execute at the trigger's seeded root (the movement body and its `if`
 *  arms) and false inside traversal-block iterations — the W3-Y1
 *  anchor-only rule for bridge synthesis rides on it. `position` is the
 *  source position the body's writes stand on: the seeded root at the
 *  anchor, the iterated record inside an adapter-edge block, absent in
 *  extract/resource iterations and callee bodies — the bridge-synthesis
 *  currency (mirrors the TG engine, where every action carries its
 *  resolved source position). */
interface BodyContext {
  atAnchor: boolean;
  position?: SourcePosition;
  /** The lexical address of THIS statement sequence (§4.3) — the movement
   *  body root is `ROOT_ADDRESS`; an `if` arm / parallel branch / fan-out
   *  iteration descends a `branch`/`iter` step. The interpreter appends a
   *  `stmt i` step per statement as it walks, so an `ask` knows the stable
   *  address its `interaction_request`/`parked_run` key on. */
  address: Address;
}

/** A statement as the site of the calls nested in its expressions. */
interface StatementSite {
  body: BodyContext;
  stmtAddress: Address;
  /** The scope the statement runs in — what a park inside one of its calls
   *  serialises as the caller's, and what a re-run of it runs in again. */
  env: Environment;
  calls: StatementCalls;
}

/**
 * The calls one statement has made, in order — each a `call k` step on the
 * address of whatever runs inside it. A statement that is re-run on resume
 * makes its calls in the same order, so the k-th call it makes is the k-th it
 * made before; `replay` hands those that had already finished their value
 * back instead of making them again.
 */
interface StatementCalls {
  next: number;
  completed: Map<number, CallRecord>;
  replay?: ReadonlyMap<number, CallRecord>;
}

/** What one finished call handed back, and the statement's call count after
 *  it (its arguments' own calls included). */
interface CallRecord {
  value: Binding | undefined;
  next: number;
}

/** The k-th call of the statement running now, as `beginCall` opened it. */
interface CallEvent {
  site: StatementSite | undefined;
  index: number;
  /** Set when the call had already finished before a park: its value. */
  replayed?: CallRecord;
}

/**
 * A body boundary the running flow is inside — the live form of a
 * `SerializedFrame`. Pushed as execution crosses into a called body, a
 * collection op's member, or a run-time arm, so a park anywhere below can say
 * how to get back.
 */
type LiveBoundary =
  | { kind: 'call'; site: StatementSite; index: number; next: number; callee: string }
  | {
      kind: 'member';
      site: StatementSite;
      index: number;
      next: number;
      member: number;
      op: CollectionOpExpression;
    }
  | { kind: 'arm'; arm: number; body: ClosureExpression };

/** How a statement sequence is entered: at which statement, and the calls of
 *  that first statement which had already finished. */
interface BodyEntry {
  at?: number;
  replay?: ReadonlyMap<number, CallRecord>;
}

/** One slot's nested calls, being run: the slot their offsets are in, the
 *  scope their bound names go into, and which calls are the engine's. */
interface NestedCallStaging {
  slot: ExprSlot;
  scratch: Environment;
  runs: (call: CallNode) => boolean;
  isCoalesce: (callee: string) => boolean;
  bound: number;
}

/** Truthiness as the evaluator's `AND` / `OR` / `IF` read it: a value by its
 *  own truthiness, a record by being there. */
function bindingTruthy(binding: Binding): boolean {
  return binding.kind === 'value' ? Boolean(binding.value) : true;
}

/** Presence as `COALESCE` reads it. */
function bindingPresent(binding: Binding): boolean {
  return binding.kind === 'value' ? binding.value !== null && binding.value !== undefined : true;
}

/**
 * What one concurrent flow owns while it runs — a collection-op member, or a
 * `race` / `parallel` arm: the dynamic state that would otherwise be shared by
 * flows running at once. (What flows do to the WORLD is kept apart by the
 * run's effect locks instead — `EffectLocks`.)
 */
interface FlowFrame {
  /** The functions this flow is inside: the enclosing call stack, copied, so
   *  a call one flow makes is not on another's. */
  callStack: CallFrame[];
  /** This flow's trace entries, spliced into the enclosing trace in the
   *  flows' own order (member order, arm order) — so the trace reads as it
   *  would had they run one after another, and an extraction's entries stay
   *  next to each other (`recordExtractedEntities` finds its own by
   *  position). */
  trace: MovementTraceEntry[];
}

/**
 * One function a flow is inside, called by name: a movement (its declaration,
 * whose identity is what versions 1 and 2 refuse recursion by — names may
 * repeat across library files) or a closure bound to a name. Its `name` is what
 * the call-depth message spells the chain with.
 */
interface CallFrame {
  name: string;
  declaration?: MovementDeclaration;
}

/** What this segment and the run have spent so far (`lib/run_spend.ts`) —
 *  a run that has made no priced call carries no fields. */
function spendFields(): Pick<
  MovementRunResult,
  'spentMicrodollars' | 'runSpentMicrodollars' | 'spentBySource'
> {
  const spend = currentRunSpend();
  return {
    ...(spend.segmentMicrodollars > 0
      ? { spentMicrodollars: spend.segmentMicrodollars, spentBySource: spend.bySource }
      : {}),
    ...(spend.runMicrodollars > 0 ? { runSpentMicrodollars: spend.runMicrodollars } : {}),
  };
}

/** One member's answer from a collection op's function — or that it has none,
 *  because the function failed and `onError` forgave it. */
type MemberAnswer = { kept: true; value: unknown } | { kept: false };

/** The trace warning `onError: "warn"` leaves for a member it left out. */
const COLLECTION_MEMBER_FAILED = 'MOVENG_COLLECTION_MEMBER_FAILED';
/** A file the run could not fetch the bytes of — warned once per file. */
const FILE_BYTES_UNAVAILABLE = 'MOVENG_FILE_BYTES_UNAVAILABLE';
/** A match whose judge never answered, bound absent all the same. */
const MATCH_JUDGE_UNAVAILABLE = 'MOVENG_MATCH_JUDGE_UNAVAILABLE';

function memberLeftOut(
  spelling: string,
  index: number,
  count: number | undefined,
  error: unknown,
): MovementTraceEntry {
  const of = count !== undefined ? ` of ${count}` : '';
  return {
    kind: 'warning',
    code: COLLECTION_MEMBER_FAILED,
    message: `'${spelling}' left out the member at index ${index}${of}, because its function failed: ${getErrorMessage(error)}`,
  };
}

/** One collection op being run — everything its members and its answer need,
 *  whether it started in this segment or is being finished on resume. */
interface CollectionRun {
  expr: CollectionOpExpression;
  spelling: string;
  settings: CollectionRunSettings;
  fn: Extract<Binding, { kind: 'closure' }>;
  /** The op's own address — its statement's `call k`; members are `iter i`
   *  under it, and it is the JOIN frame when members park. */
  address: Address;
  /** The op as its statement's call: the statement its members' boundaries
   *  name, and which call it is. */
  event: CallEvent;
  /** The body context its members' function bodies run under. */
  body: BodyContext;
  members: unknown[];
  sourceProvenance: Provenance;
  /** `REDUCE`'s starting value (null for the other ops). */
  init: unknown;
}

/**
 * What a parked op keeps at its frame (the `join_branch_export` row at the
 * op's own address, ordered before every member's): the members it reads and
 * `REDUCE`'s start, as they were when it began — re-reading them on resume
 * could read something else.
 */
interface CollectionOpState {
  source: BindingDescriptor;
  init: BindingDescriptor;
}

/** A join frame's own row (an op's members, a run-time combinator's arm
 *  count): its place in the frame's fold order, before branch 0. */
const FRAME_STATE_INDEX = -1;

/** What a combinator whose arms were built at run time keeps at its frame
 *  when it parks: how many arms there were, which the source cannot say. */
interface CombinatorFrameState {
  arms: number;
}

function isCombinatorFrameState(value: unknown): value is CombinatorFrameState {
  return typeof value === 'object' && value !== null && 'arms' in value && typeof value.arms === 'number';
}

/** A combinator's arm count: written in the source, or kept at its frame. */
function armCountOf(
  combinator: CombinatorExpression,
  rows: ReadonlyArray<{ branchIndex: number; exports: unknown }>,
): number {
  if (combinator.arms.kind !== 'dynamic') return literalArmsOf(combinator).length;
  const kept = rows.find((row) => row.branchIndex === FRAME_STATE_INDEX)?.exports;
  return isCombinatorFrameState(kept) ? kept.arms : 0;
}

/** A finished member as its op's frame keeps it. */
type MemberAnswerExport = { kept: true; answer: BindingDescriptor } | { kept: false };

function serializeMemberAnswer(answer: MemberAnswer, park?: ParkWriter): MemberAnswerExport {
  if (!answer.kept) return { kept: false };
  return {
    kept: true,
    answer: serializeBinding(binding({ kind: 'value', value: answer.value, provenance: NO_PROVENANCE }), park),
  };
}

function isMemberAnswerExport(value: unknown): value is MemberAnswerExport {
  return typeof value === 'object' && value !== null && 'kept' in value && typeof value.kept === 'boolean';
}

function isCollectionOpState(value: unknown): value is CollectionOpState {
  return typeof value === 'object' && value !== null && 'source' in value && 'init' in value;
}

/** `REDUCE`'s carried value going into member `index`: the last answer a member
 *  before it kept, or the start. */
function carriedBefore(answers: readonly MemberAnswer[], index: number, init: unknown): unknown {
  for (let i = index - 1; i >= 0; i--) {
    const answer = answers[i];
    if (answer?.kept === true) return answer.value;
  }
  return init;
}

/** A member's answer from what its function's body did. */
function memberValue(run: Pick<CollectionRun, 'expr' | 'spelling'>, outcome: BodyOutcome): unknown {
  if (!outcome.returned) {
    // MAP alone allows this (checker: MAP_SLOT_ABSENT) — the closure ran
    // for its statements' effects (its writes already landed, above) and
    // this member's slot is simply absent. FILTER/REDUCE/GROUPBY/KEYBY
    // still require a return, so reaching here for one of those really is
    // the checker escape the message names.
    if (run.expr.op === 'map') return null;
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `the function for '${run.spelling}' returned nothing — the checker should have caught this`,
    );
  }
  return outcome.value.kind === 'value' ? outcome.value.value : outcome.value;
}

/** The op's value, from every member's answer, in MEMBER order. */
function collectionAnswer(run: CollectionRun, answers: readonly MemberAnswer[]): Binding {
  const { expr, spelling, members } = run;
  if (expr.op === 'reduce') {
    return binding({
      kind: 'value',
      value: carriedBefore(answers, members.length, run.init),
      provenance: transformed(run.sourceProvenance),
    });
  }
  if (expr.op === 'map') {
    const out = members.flatMap((_, index) => {
      const answer = answers[index];
      return answer?.kept === true ? [answer.value] : [];
    });
    return binding({ kind: 'value', value: out, provenance: transformed(run.sourceProvenance) });
  }
  if (expr.op === 'filter') {
    // Truthiness is the language's own: the function returns a boolean, and
    // anything else is the checker's business, not a second definition here.
    // A member whose predicate failed (under a forgiving `onError`) answered
    // nothing, so it is not kept.
    const out = members.filter((_, index) => {
      const answer = answers[index];
      return answer?.kept === true && answer.value === true;
    });
    return binding({ kind: 'value', value: out, provenance: run.sourceProvenance });
  }
  // GROUPBY / KEYBY — the key function's answer names the slot. A key that
  // is not text at run time is a checker escape; say so rather than
  // stringify it, which is the silence the save-time rule exists to avoid.
  const filed: Record<string, unknown> = {};
  members.forEach((member, index) => {
    const answer = answers[index];
    if (answer?.kept !== true) return;
    const key = answer.value;
    if (typeof key !== 'string') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${spelling}' files each member under a text key, and this one answered ${key === null || key === undefined ? 'nothing' : typeof key} — the checker should have caught this`,
      );
    }
    if (expr.op === 'keyby') {
      // Two members under one key is the author's claim turning out false —
      // exactly `ONLY`'s situation, and it gets `ONLY`'s answer: fail the
      // run naming the key, rather than quietly keeping one of them.
      if (Object.hasOwn(filed, key)) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `KEYBY says each key names one member, and '${key}' names more than one. Use GROUPBY if a key can have several.`,
        );
      }
      filed[key] = member;
      return;
    }
    const group = filed[key];
    if (Array.isArray(group)) group.push(member);
    else filed[key] = [member];
  });
  return binding({ kind: 'value', value: filed, provenance: transformed(run.sourceProvenance) });
}

/**
 * Did a member's function FAIL, as opposed to the run's control flow passing
 * through it? Only a failure is the member's, and only a failure can be
 * forgiven by `onError`: a cancel, the call ceiling, the cost cap, the call
 * depth limit, a park and a quiet scope end all mean something about the run, and swallowing one would
 * leave the run believing it had done something it had not.
 */
function isMemberFailure(error: unknown): boolean {
  return !(
    error instanceof RunParked
    || error instanceof ScopeEndedQuietly
    || error instanceof RunCancelledSignal
    || isAdapterCallCeilingExceeded(error)
    || isRunCostCapExceeded(error)
    || isCallDepthExceeded(error)
  );
}

/** What a run paused at its cost cap says on its trace. */
function runPausedMessage(error: RunCostCapExceeded): string {
  return (
    `Paused: cost limit reached. The run has spent ${formatUsd(error.spentMicrodollars)} against a limit of ` +
    `${formatUsd(error.capMicrodollars)} (${RUN_COST_CAP_ENV_VAR}). Every branch stopped before its next statement; ` +
    'resume the run to carry on from there, with its usage reset.'
  );
}

/** One traversal-block iteration: the hop aliases' bindings, plus the
 *  yielded record itself when the head walked ADAPTER edges (the
 *  iteration's write-bridge currency — extract/resource iterations have
 *  no stable external record to stand on). */
interface BlockIteration {
  bindings: Map<string, Binding>;
  position?: SourcePosition;
  /** WHERE the head landed, as a binding — the iteration's last hop. A block
   *  body reaches it through the hop alias; a construct that BINDS the walk
   *  rather than entering a block (a node literal's pass-through edge, a
   *  `lazy` traversal read) takes it from here, alias or no alias. */
  landing?: Binding;
}

/**
 * One ancestor (container) level the resume descent passed through — captured so
 * the leaf-block completion can UNWIND back out, running each ancestor's
 * post-container continuation exactly as normal execution's return-from-block
 * (plans/2026-07-01-movement-sleep/4_resume_unwind_fix.md §3/§4/§12.1). A JOIN
 * frame (fan-out iteration / parallel branch) persists this branch's exports and
 * decrements the join; the closer folds all branches and runs the continuation.
 */
interface ResumeAncestorFrame {
  /** The ENCLOSING sequence — the level the container lives in. */
  parentStatements: Statement[];
  /** That level's env, already rehydrated with pre-container bindings. */
  parentEnv: Environment;
  /** That level's frame address. */
  parentFrameAddress: Address;
  parentAtAnchor: boolean;
  parentPosition?: SourcePosition;
  /** `parentStatements[containerIndex]` — the if / parallel / fan-out node. */
  container: Statement;
  containerIndex: number;
  /** `childStmt(parentFrameAddress, containerIndex)` — the JOIN frame address. */
  containerAddress: Address;
  /** How we descended into the container (`address[i+1].kind`). */
  descentKind: AddressStep['kind'];
  /** The forked env we descended INTO (its `ownBindings()` are the exports). */
  childEnv: Environment;
  /** This branch's own address (the childIter/childBranch of the frame, §12.1). */
  branchAddress: Address;
  /** The branch/iteration ordinal — the deterministic fold order (§12.1/§12.4). */
  branchIndex: number;
}

/** A container level on the resume spine — an `if` arm, a fan-out
 *  iteration, a combinator arm (with its boundary when it was built at run
 *  time). */
type ResumeContainerFrame = {
  kind: 'container';
  armBoundary?: LiveBoundary;
  /** The function a combinator arm runs, when the arm names one — a call by
   *  name that the call depth counts. */
  armName?: string;
} & ResumeAncestorFrame;

/** The statement sequence a call was made from, and the statement that made it. */
interface ResumeSequence {
  statements: Statement[];
  env: Environment;
  body: BodyContext;
  stmtIndex: number;
}

/** A call level on the resume spine: the call's boundary (its calling
 *  statement, rebuilt) and the movement it entered, when it was one. */
interface ResumeCallFrame {
  kind: 'call';
  caller: ResumeSequence;
  boundary: Extract<LiveBoundary, { kind: 'call' }>;
  declaration?: MovementDeclaration;
}

/** A collection op as resume re-derives it from its AST, before its kept
 *  members are read back. */
type ResumedCollectionOp = Omit<CollectionRun, 'members' | 'sourceProvenance' | 'init'>;

/** A collection-op member level on the resume spine. */
interface ResumeMemberFrame {
  kind: 'member';
  caller: ResumeSequence;
  boundary: Extract<LiveBoundary, { kind: 'member' }>;
  op: ResumedCollectionOp;
}

/** One level the resume descent passed through, outermost first. */
type ResumeSpineFrame = ResumeContainerFrame | ResumeCallFrame | ResumeMemberFrame;

/** What finishing a level came to: the body it is in finished (with this
 *  outcome), or the climb stops here — a join still waits on siblings. */
type SpineCompletion = { done: true; outcome: BodyOutcome } | { done: false };

const STOPPED: SpineCompletion = { done: false };

/** What a resume does at its leaf statement. */
type ResumeLeaf =
  /** Bind the answer and step past the leaf, or re-enter it (§4.4). */
  | { kind: 'continue'; answer?: Binding; reenter: boolean }
  /** Run a fired callback's body (the leaf is its mint). */
  | { kind: 'fireCallback'; values: Record<string, unknown>; callIndex: number }
  /** Settle a race whose arms completed in a batch (the leaf is the race). */
  | { kind: 'settleRace'; frameAddress: string };

/** A closure's scope, as the root its body's scopes chain from. A file-level
 *  closure's is its file's own scope, live — as a movement's is — and a body
 *  closure's the scope it was written in, live. One rehydrated from a park
 *  written before holds a flat capture, rebuilt as a scope of its own. */
function closureScope(binding: Extract<Binding, { kind: 'closure' }>): Environment {
  if (binding.file !== undefined) return binding.file.env;
  if (binding.env !== undefined) return binding.env;
  const env = new Environment();
  for (const [name, captured] of binding.captured) env.declare(name, captured);
  return env;
}

/**
 * The `WHERE` on a `match`/`write` target's final hop — which existing records
 * the find may take (`match crm-[c:companies WHERE EXISTS(c-[:deals]->)]-> …`).
 * It narrows the identity candidates before arbitration; it never decides
 * whether a write creates.
 */
interface TargetWhere {
  /** The hop's alias — names the candidate inside the filter. */
  alias?: string;
  filter: Expression;
}

/** A write's resolved destination (see `resolveWriteTarget`). */
interface ResolvedWriteTarget {
  adapter: Adapter;
  /** The written type, in the adapter's NATURAL name — what `describe`,
   *  `resolveEntity` and the write calls now receive (the adapter translates
   *  to its own id internally). Also the env/schema currency (handle
   *  bindings, edge inference against the instance/kg schema). */
  recordType: string;
  /**
   * The type the resulting HANDLE stands on, when it is more specific than the
   * type the write is addressed to. A discriminated write is addressed at a
   * collection — `write org-[:List Entries]-> { listName: "Portfolio" }`
   * — and creates a row of the one list the body named: the type that genuinely
   * carries that list's own fields and reference edges. So a chained write or
   * `link` off the handle resolves against the list's type, which is what the
   * checker typed the handle as.
   *
   * The type the ADAPTER is called with stays `recordType`: the write is
   * addressed to the collection, and the discriminant in the body is how the
   * adapter is told which list. Asking by one name and landing on another is
   * the same split the read side already makes (`kg.ts`'s `landedType`).
   *
   * Absent ⇒ the handle stands on `recordType`, the ordinary case.
   */
  handleType?: string;
  /** The graph the resulting handle lives in (threads onto the handle
   *  binding so later linked writes can chain off it). */
  graph: HandleGraph;
  /** Linked / tuple-path writes — the parent handles' contexts, in path
   *  order (ONE entry for a linked write, N for a tuple). `recordType` is the
   *  parent's NATURAL type and `edgeName` the NATURAL edge name (the adapter
   *  resolves both); `externalId` is absent when a parent write produced no
   *  record (the adapter then gets no link for it, mirroring the TG engine).
   *  Empty for instance-target writes. */
  parents: Array<{
    handleName: string;
    edgeName: string;
    recordType: string;
    externalId?: string;
    /** The parent's payload — see `ParentLink.data`. */
    data?: Record<string, unknown>;
  }>;
  /** Every path's final-hop `WHERE` (one per tuple path that carries one); a
   *  candidate must pass them all. Empty when the target has none. */
  where: TargetWhere[];
}

/**
 * A `unique by` clause's non-key conjuncts (`WITHIN`, `!=`, ranges), and the
 * key whose candidates they narrow. Each clause narrows only what its own key
 * found: `unique by` clauses are OR-ed, and one clause's test says nothing
 * about a record another clause identified.
 */
interface IdentityNarrowing {
  key: UniquenessConstraints['any'][number];
  filter: Expression;
}

/** A target's `WHERE`, ready to run against identity candidates: the filters,
 *  the graph each candidate is read in, the scope the filters close over, and
 *  the type a matched handle would stand on. */
interface CandidateWhere {
  filters: TargetWhere[];
  graph: HandleGraph;
  env: Environment;
  handleType?: string;
}

/** A target hop's `WHERE`, when it has one. */
function targetWhereOf(step: TraversalStep): TargetWhere | undefined {
  if (step.type !== 'edge' || step.expressionFilter === undefined) return undefined;
  return {
    ...(step.alias !== undefined ? { alias: step.alias } : {}),
    filter: step.expressionFilter,
  };
}

/** A node this run built has no existing records to narrow — its landings take
 *  no WHERE on the read side either. The checker says so first
 *  (`MOV_TARGET_WHERE_LOCAL`); this is the run's half of the same rule. */
function refuseLocalTargetWhere(where: TargetWhere | undefined, at: string): void {
  if (where === undefined) return;
  throw unsupported(
    `WHERE on the target of '${at}' — an edge of a node this run built`,
    "say which landing you mean in 'unique by (…)' instead",
  );
}

/**
 * What a write needs to know about its destination BEFORE there is a graph to
 * put a handle in: an adapter, a type, and the parents it hangs off. Every
 * ordinary write target is one of these and more; a write into an edge of a
 * node this run built is one of these and nothing more — there is no instance
 * behind it, so `graph` cannot be invented and is not asked for.
 */
type WriteDestination = Pick<ResolvedWriteTarget, 'adapter' | 'recordType' | 'parents'>;

/** What an update by id (`applyUpdate`) is handed. */
interface UpdateInput {
  adapter: Adapter;
  recordType: string;
  externalId: string;
  fields: Record<string, unknown>;
  /** Per-field write-precedence (absent ⇒ replace). The engine applies the
   *  merge against current values here; the adapter writes a final value. */
  fieldSemantics: Record<string, FieldWriteMode>;
  /** Per-field evidence for provenance-faithful values — filtered to
   *  the fields that survive no-op suppression, like the TG engine. */
  fieldEvidence: Record<string, FieldEvidence>;
  /** Node-level resource provenance (Layer 5) — the source content that fed
   *  the extracted node(s) this write draws from, persisted against the
   *  updated record (`WriteInput.resources`). Empty for non-extract writes. */
  resources?: Resource[];
  parentLinks: ParentLink[];
  /** What the update holds while it reads and merges. Absent ⇒ the record
   *  itself (`recordLock`); a write whose adapter stands in for another
   *  system's record names that record's locks instead. */
  locks?: LockRequest[];
  /** What the engine already held of the record before this update, when the
   *  update's handle is one the program reads — see `PriorRecord`. */
  prior?: PriorRecord;
}

/**
 * What the engine held of a record before a write updated it (an identity
 * candidate's fields, a landing's fetched data, a handle's values) and the
 * binding a handle on it stands on. Overlaid with the pre-write read the merge
 * makes anyway, it is the record as it stood — the handle's `-[:@old]->` — at
 * no extra adapter call; and the new handle reads the fields the write did not
 * send from it, so a handle on a found record reads that record rather than
 * only what this write said. Both since version 4 (`recordBefore`).
 */
interface PriorRecord {
  data: Record<string, unknown>;
  targetType: string;
  graph: HandleGraph;
}

/** What the identity-resolve write path (`executeResolvedWrite`) is handed. */
interface ResolvedWriteInput {
  target: WriteDestination;
  adapter: Adapter;
  descriptor: Awaited<ReturnType<Adapter['describe']>>;
  resolveRecord: Record<string, unknown>;
  constraints: UniquenessConstraints;
  /** Each `unique by` clause's non-key conjuncts (e.g. `WITHIN`), with the
   *  key whose candidates they narrow — see `IdentityNarrowing`. */
  identityNarrowings: IdentityNarrowing[];
  /** The target's final-hop `WHERE`. A shortlist it empties is a MISS, and
   *  a miss creates: the WHERE says which existing record may be matched,
   *  not whether to write. */
  candidateWhere?: CandidateWhere;
  fields: Record<string, unknown>;
  fieldSemantics: Record<string, FieldWriteMode>;
  fieldEvidence: Record<string, FieldEvidence>;
  /** Layer-5 node-level resource provenance — forwarded to the create/update
   *  as `WriteInput.resources`. */
  resources: Resource[];
  parentLinks: ParentLink[];
  body: BodyContext;
  /** The locks an update of the matched record holds — see `UpdateInput.locks`. */
  updateLocks?: (externalId: string) => Promise<LockRequest[]>;
  /** The binding the write's handle will stand on, when the program holds
   *  one: what a matched record's snapshot (`@old`) stands on too. */
  handle?: Pick<PriorRecord, 'targetType' | 'graph'>;
}

/** A standalone link statement's resolved shape (see `resolveLinkStatement`)
 *  — adapter + engine-currency endpoints, plus the endpoint handles for the
 *  firing record's provenance. */
interface ResolvedLinkStatement {
  adapter: Adapter;
  /** The edge in the adapter's NATURAL name — the adapter's `linkRecords`
   *  resolves it against the FROM side's type internally. */
  edgeName: string;
  from: { recordType: string; externalId: string };
  to: { recordType: string; externalId: string };
  fromHandle: WriteRecord;
  toHandle: WriteRecord;
}

/** The body a write and a match share: a target, identity clauses and
 *  fields. Everything that reads only those takes either. */
type IdentityBody = WriteExpression | MatchExpression;

/** A match's target as the author wrote it, for messages. */
function describeMatchTarget(match: MatchExpression): string {
  const spell = (path: PathHead): string => `${pathRootName(path) ?? ''}${path.hopsRaw}`;
  return match.target.kind === 'linked'
    ? spell(match.target.path)
    : `(${match.target.paths.map(spell).join(', ')})`;
}

/**
 * Control-flow sentinel — the find-on-missing semantics before version 4: a
 * `match` found no record, so the ENCLOSING SCOPE ends quietly. Caught at
 * scope boundaries (a fan-out iteration skips, a callee body returns, the
 * movement body simply stops); nothing throws outward, because
 * transactionality across systems can't be guaranteed.
 *
 * From version 4 a miss binds absent and the block carries on, and the checker
 * refuses the unnamed match and the link body form, so only programs pinned to
 * an older version reach this.
 */
class ScopeEndedQuietly extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeEndedQuietly';
  }
}

type MatchMissPolicy = 'absent' | 'endScope';

/** A match that found nothing: bind absent, or end the enclosing scope. */
function missed(input: {
  onMiss: MatchMissPolicy;
  bindingName: string | undefined;
  env: Environment;
  reason: string;
  /** The judge's outage, when it never answered — "not found" is then a
   *  guess, and a program that creates on absent would duplicate. */
  judgeUnavailable: string | undefined;
  trace: MovementTraceEntry[];
}): Binding {
  switch (input.onMiss) {
    case 'absent': {
      // The binding is absent either way; the trace is what tells an outage
      // apart from a considered "nothing matched".
      if (input.judgeUnavailable !== undefined) {
        input.trace.push({
          kind: 'warning',
          code: MATCH_JUDGE_UNAVAILABLE,
          message: `${input.reason}; the judge was unavailable, so the match was treated as finding nothing`,
        });
      }
      const absent: Binding = binding({ kind: 'value', value: null });
      if (input.bindingName !== undefined) input.env.declare(input.bindingName, absent);
      return absent;
    }
    case 'endScope':
      throw new ScopeEndedQuietly(input.reason);
    default:
      return neverAsAny(input.onMiss);
  }
}

/**
 * Control-flow signal — an `ask` was reached, so the enclosing branch is now
 * durably PARKED (its `interaction_request` + `parked_run` are persisted). It
 * mirrors `ScopeEndedQuietly` (caught at the same scope boundaries) but means
 * the opposite: the branch did not complete, it is waiting on an answer. For
 * the single-ask milestone it propagates to `run()` top → the whole run is
 * parked. (3.2 adds the per-sibling catches so a fan-out parks N leaves while
 * its other branches run on.)
 */
class RunParked extends Error {
  constructor(readonly address: string) {
    super(`run parked at ${address}`);
    this.name = 'RunParked';
  }
}

/** `await until(…)`'s default cadence when the author writes none (F12 ops
 *  ruling: default 1h). The 1m floor is a checker error, so anything reaching
 *  the engine is already ≥ 1m. */
const UNTIL_DEFAULT_EVERY_MS = 60 * 60 * 1000;

/** Does an `until` condition HOLD? The condition is a boolean in practice (a
 *  quorum test, a `.ok` flag), so this is identity against TRUE — with a
 *  stringified fallback for the sources that hand booleans back as `"true"`,
 *  and never a deep-equal against a node. */
function untilConditionMet(value: unknown): boolean {
  if (value === true) return true;
  if (value == null || typeof value === 'object') return false;
  return String(value) === 'true';
}

/** The block head as the author wrote it — `mentions-[c:company]->`. */
function blockRootLabel(block: TraversalBlock): string {
  return spellPathHead(block.head);
}

/** A handle a WRITE returned and that still names the live record — not what
 *  a match found, and not a snapshot reached through `-[:@old]->`. */
function isWrittenHandle(binding: Extract<Binding, { kind: 'handle' }>): boolean {
  return binding.handle.kind === undefined && binding.handle.snapshot !== true;
}

/** What the run already holds of the record a position write names: a
 *  handle's values, or the data a traversal fetched with the landing. */
function knownRecordData(binding: Binding | undefined): Record<string, unknown> {
  if (binding?.kind === 'handle') {
    return { ...binding.handle.foundData, ...binding.handle.resultData, ...binding.handle.writtenValues };
  }
  if (binding?.kind === 'sourcePosition') {
    const data = positionData(binding.position);
    return isDictValue(data) ? { ...data } : {};
  }
  return {};
}

/** Whether an instance was constructed with the universal `dry_run: true`
 *  argument — the per-instance rehearse-this-target switch. Read straight
 *  from the instance's own construction config so no upstream derivation
 *  can misjudge it (`6_engine.md`: per-instance capture). */
function instanceIsDryRun(instance: Extract<Binding, { kind: 'instance' }>): boolean {
  return instance.constructionConfig?.dry_run?.trim().toLowerCase() === 'true';
}

/** Unwrap a raw string-literal value (`'"Pipeline"'` → `Pipeline`); other raws
 *  pass through trimmed. */
function unquoteConstructionArg(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
}

/** The instance's non-credential construction args (unquoted), for construction
 *  — the entry position (`spreadsheet:`) plus any other config. `dry_run` is a
 *  platform arg, resolved separately, so it's dropped. */
function constructionArgsOf(
  instance: Extract<Binding, { kind: 'instance' }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(instance.constructionConfig ?? {})) {
    if (name === 'dry_run') continue;
    out[name] = unquoteConstructionArg(raw);
  }
  return out;
}

/** The top-level AND-ed conjuncts of a predicate (a bare predicate is one). */
function flattenAndConjuncts(expr: Expression): Expression[] {
  if (expr.type === 'logical' && expr.op === 'and') {
    return expr.operands.flatMap(flattenAndConjuncts);
  }
  return [expr];
}

class Interpreter {
  private readonly writes: WriteRecord[] = [];
  /** Set when the run parked at an `ask` (caught at run() top → the result
   *  carries `parked: true`, the firing caller skips finalisation). */
  private parked = false;
  /** The address the run (re-)parked at, captured from `RunParked` alongside
   *  `parked`. The await-resume driver compares it to the leaf it re-entered to
   *  tell a resolved-then-parked-DEEPER leaf (drop the stale leaf) from an await
   *  that RE-ARMED at the SAME address (a WHERE-narrowed await whose landings
   *  still don't match — leave its freshly re-committed park rows intact). */
  private parkedAddress?: string;
  /** Set when the user requested cancellation (RunCancelledSignal caught at
   *  run()/resume() top → the result carries `cancelled: true`, the firing caller
   *  settles the run `failed` rather than finalising it as success). */
  private cancelled = false;
  /** Batch mode (asks-as-adapter chunk C, F18/F21): when a race branch completes
   *  under `await`-resume, the race is NOT settled inline — its frame is DEFERRED
   *  here so the resume worker can run EVERY resolvable branch of the batch first,
   *  then settle once with ALL winners. Set from `resume({ deferRaceSettlement })`;
   *  timer/cost/ask resume leave it false (inline single-winner, unchanged). */
  private deferRaceSettlement = false;
  /** Race frame addresses a batch resume completed a branch into (dedup at the
   *  worker) — the post-batch settlement list. */
  private readonly deferredRaceFrames = new Set<string>();
  /** The run's decision-point trace (gates, blocks, AI() outcomes,
   *  field misses, extraction yields) — persisted on the firing record
   *  so a run with no writes still explains itself. Adopted from the caller
   *  when it supplied one, so the entries are readable AS THEY LAND rather
   *  than only at settle (a slow run showing an empty trace is exactly how it
   *  comes to read as a hung one). Read it through `trace`, which hands a
   *  collection op's member its own buffer instead. */
  private readonly runTrace: MovementTraceEntry[];
  /** Interns extraction sites + projects trails to refs for the
   *  firing record (E4 — refs not blobs). */
  private readonly summariser = new ProvenanceSummariser();
  /** Aliased imports: local name → name in the source namespace (catalog / workspace key). */
  private readonly importOriginals = new Map<string, string>();
  private readonly targetAdapterCache = new Map<string, Adapter>();
  /** Source-role adapters for graph-rooted traversals (see graphReadFor). */
  private readonly sourceAdapterCache = new Map<string, Adapter>();
  private readonly resolveAdapterFn: NonNullable<RunMovementInput['resolveAdapter']>;
  /** Rebuilt in run() for snapshot seeds, where the event envelope's
   *  adapterType is a placeholder and the source instance is canonical. */
  private mutationContext: MutationContext;
  /** Set once the movement's source instance is known. */
  private source?: MovementExprContext['source'];
  /** The seeded event node's canonical address, when the source's schema
   *  declares event edges — what a runtime IS on an event subject compares
   *  against (test pins ⊆ seed pins), and the same derivation that typed the
   *  seed (`eventSeedAddress`), so the two can never disagree. */
  private sourceEventAddress?: EventAddress;
  /** The constructed instance binding the entry movement's parameter is
   *  typed against — runtime IS tests on the event compare graph
   *  identity against it (binding objects are declared once, so object
   *  identity IS graph identity, alias-safe). */
  private sourceInstance?: Extract<Binding, { kind: 'instance' }>;
  /** File scope — callee environments fork from HERE, not from the
   *  caller's locals (lexical scoping, §G). */
  private fileEnv?: Environment;
  /** The functions currently executing, the run's movement first — what
   *  refuses recursion before version 3 and bounds the call depth from it.
   *  Read it through `callStack`, which hands a collection op's member its
   *  own copy instead. */
  private readonly runCallStack: CallFrame[] = [];
  /** The concurrent flow (collection-op member, combinator arm) this async
   *  flow is running, when it is one. Flows may run at once, and the
   *  interpreter's dynamic state — the call stack, the trace being appended
   *  to — is per FLOW, not per run: two flows calling the same movement are
   *  not a recursion, and one flow's trace entries are not another's. */
  private readonly flowFrames = new AsyncLocalStorage<FlowFrame>();
  /** The statement running in this flow, which a call nested in one of its
   *  expressions runs as (`settleNestedCall`). */
  private readonly statementSites = new AsyncLocalStorage<StatementSite>();
  /** The body boundaries this flow is inside, outermost first — what a park
   *  below them records as its `frames`, so resume can get back in. */
  private readonly boundaries = new AsyncLocalStorage<readonly LiveBoundary[]>();
  /** What keeps concurrent flows' effects on the world from racing — see
   *  `effect_locks.ts`. */
  private readonly effectLocks = new EffectLocks();
  /** The run is PAUSED at a limit: every flow suspends at its next statement
   *  boundary, and no collection op starts another member. Set by the first
   *  flow to meet the cost cap (`suspendAtLimit`), or from the start when an
   *  ordinary event woke a branch of an already-paused run
   *  (`RunMovementInput.limitPaused`). Never cleared within a segment: only
   *  resuming the run lifts a pause, and that is a new segment. */
  private limitPaused: boolean;
  /** This segment runs a fired callback's body, which cannot suspend. */
  private firingCallback = false;
  /** The running movement's body — the extraction module's backward
   *  type adoption scans it for writes the extracted fields flow into. */
  private movementBody: Statement[] = [];
  /** Each file's author-declared refinements (`type Thesis = <"A" | "B">`),
   *  by the file environment they were declared in. A `type` is file-level and
   *  lexically scoped exactly as a value is: a name resolves in the file that
   *  WROTE it, never in the file that reuses what it wrote. */
  private readonly fileTypes = new WeakMap<Environment, Map<string, SchemaFieldType>>();
  /** The same, per library file — an imported declaration's types need no
   *  library environment built, only its program. */
  private readonly libraryTypes = new Map<string, Map<string, SchemaFieldType>>();
  private defaultLlm?: LlmClient;
  private defaultExtractCallLlm?: ExtractCallLlmClient;
  /** What the run's extraction calls share: the content prefixes already sent
   *  (where the cache breakpoints go) and the files already read. */
  private readonly extractCalls = new ExtractCallRunState();
  private extractCallCount = 0;
  private fileTextSeam?: (ref: FileRef) => Promise<FileTextResolution>;
  /** Run-wide caches for `@user_*` / `@actor_*` resolution (mutated in
   *  place by the evaluator's meta resolvers — one chain per run). */
  private readonly actingUserCache: MovementMetaContext['actingUserCache'] = {};
  private readonly actorCache: MovementMetaContext['actorCache'] = {};
  /** The run's pinned instant — see `RunMovementInput.firedAt`. Read once,
   *  here, so nothing downstream can reach a live clock instead. */
  private readonly pinnedNow: Date;
  /** The file whose import statements are being interpreted (the root
   *  program's resolved imports, or — while a library env builds — that
   *  library's own). */
  private currentImports?: Map<string, LinkedExport>;
  /** One environment per library file, memoized — diamonds share it, and
   *  its instance constructions stay per-file. */
  private readonly libraryEnvs = new Map<string, Environment>();
  /** Each library environment's file path — what a park writes beside a code
   *  ref declared there, so a resume finds it in that file again. */
  private readonly libraryPaths = new Map<Environment, string>();

  /** The movement's pin — what the engine's `since`/`before` conditionals
   *  read (a plugin or adapter reads the same value off the run scope). */
  private get languageVersion(): LanguageVersion {
    return this.input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  }

  /** What a match statement or a bound match does when it finds nothing. */
  private get matchMissPolicy(): MatchMissPolicy {
    return since(this.languageVersion, 4) ? 'absent' : 'endScope';
  }

  /** Where a trace entry lands: the running flow's own buffer inside a
   *  collection-op member or a combinator arm (spliced into the enclosing
   *  trace in member / arm order), the run's trace everywhere else. */
  private get trace(): MovementTraceEntry[] {
    return this.flowFrames.getStore()?.trace ?? this.runTrace;
  }

  /** The movements this flow is inside — its own copy inside a collection-op
   *  member or a combinator arm, so flows calling the same movement at once
   *  are not mistaken for a recursion. */
  private get callStack(): CallFrame[] {
    return this.flowFrames.getStore()?.callStack ?? this.runCallStack;
  }

  constructor(
    private readonly input: RunMovementInput,
    private readonly link?: ProgramLink,
  ) {
    this.runTrace = input.trace ?? [];
    this.limitPaused = input.limitPaused === true;
    // A deprecated pin runs, and says so on the run's own record. (An
    // unsupported one never gets this far — parseAndCheck refused it.)
    const versionWarning = languageVersionDiagnostic(this.languageVersion);
    if (versionWarning !== undefined) {
      this.trace.push({ kind: 'warning', code: versionWarning.code, message: versionWarning.message });
    }
    this.pinnedNow = input.firedAt ?? new Date();
    this.resolveAdapterFn =
      input.resolveAdapter ??
      (({ adapterType, teamId, credentialsId, constructionArgs }) =>
        resolveAdapterDefault({
          adapterType,
          teamId,
          credentialsId,
          ...(constructionArgs !== undefined ? { constructionArgs } : {}),
        }));
    this.currentImports = link?.imports;
    // The firing that started this run rides along in the provenance of every
    // graph write it makes. `suppress_self` — the 2-way-sync flag — is answered
    // from that marker alone (`didWeAuthor`), and without it an automated write
    // is indistinguishable from a human's: the flag reads "can't tell", nothing
    // fails, and every 2-way sync echoes itself. The marker went missing when
    // translation graphs died and their ids stopped being stamped; the trigger
    // event has carried it all along.
    this.mutationContext = {
      source: {
        type: 'structured_input',
        adapterType: input.event.adapterType,
        pipelineInputId: input.event.pipelineInputId,
      },
      // The event's own time when it reported one; otherwise the firing's —
      // "when the thing happened" falling back to "when we heard about it".
      occurredAt: input.event.occurredAt ?? this.pinnedNow.toISOString(),
    };
  }

  async run(program: Program): Promise<MovementRunResult> {
    const { movement, movementEnv } = await this.prepareMovement(program);
    this.movementBody = movement.body;
    this.callStack.push({ name: movement.name, declaration: movement });
    try {
      await this.interpretBody(movement.body, movementEnv, {
        atAnchor: true,
        position: this.source!.position,
        address: ROOT_ADDRESS,
      });
    } catch (e) {
      if (e instanceof RunCancelledSignal) {
        // User-requested cancel — settle handled by the caller (the firing
        // outcome carries cancelled: true → the run is failed + its open
        // requests cancelled). Earlier writes stand (P14).
        this.cancelled = true;
      } else if (e instanceof RunParked) {
        // The run reached an `ask` and is now durably parked — the park rows
        // are persisted and the trigger_run is `parked`. Earlier writes stand;
        // the run resumes when the answer arrives (chunk 5).
        this.parked = true;
        this.parkedAddress = e.address;
      } else if (!(e instanceof ScopeEndedQuietly)) {
        // A real failure — carry the ledger of what already landed out with it.
        throw new MovementRunFailed(e, this.assembleResult(movement.name));
      }
      // The swallowed case is find-on-missing at the top scope: the movement
      // body simply stops — earlier writes stand, the run completes normally.
    }

    await this.checkCancelBeforeFinishing();
    return this.assembleResult(movement.name);
  }

  /**
   * The run's LAST cancel check. Every boundary the run crosses consults the
   * gate, but a cancel stamped while the FINAL boundary's work was in flight has
   * no later boundary to be discovered at — and without this the run finalises
   * as a plain success: the operator pressed Stop, watched the run report that
   * it finished fine, and got no record that they had ever asked. A movement
   * whose whole body is one `extract` has exactly that shape, and it is the
   * common one.
   *
   * This does not undo anything. What already landed stands (P14) — all that
   * changes is what the run is RECORDED as, which is the part that was untrue.
   * Skipped when the run already knows it is cancelled or parked: a parked run's
   * cancel is settled by the park sink's own tail check.
   */
  private async checkCancelBeforeFinishing(): Promise<void> {
    if (this.cancelled || this.parked) return;
    if (this.input.cancelGate && (await this.input.cancelGate.cancelledNow())) {
      this.cancelled = true;
    }
  }

  /**
   * Resume a parked run forward from its parked leaf (async user interaction
   * §4.4/§4.7). The pinned program is the SAME `input.source` (the caller
   * re-parses the version-pinned source — P11 — so the AST is byte-identical);
   * `prepareMovement` re-derives the live source adapter + file scope exactly
   * as `run()` does. `resumeAlongAddress` then descends the body along the leaf's
   * lexical address — rehydrating each lexical scope (the shared ancestor spine +
   * the leaf's own local scope) and entering ONLY the named branch/iteration —
   * binds the answer `r`, and runs FORWARD from the statement after the ask
   * (forward-from-leaf, no re-run of prior statements — their effects committed,
   * their results are in the rehydrated scope). Handles a single linear ask AND
   * a fan-out / parallel / if-nested ask (chunk 3.2c). A re-park deeper throws
   * `RunParked` and the run stays parked.
   */
  async resume(input: {
    program: Program;
    state: ParkedScopeState;
    /** The validated answer graph `r` to bind at the ask's binding name. Absent
     *  under `reenter` (cost / error resume binds nothing). */
    answer?: Binding;
    /** Re-enter AT the parked statement (§4.4) instead of stepping past it.
     *  Defaults to the ask behaviour (false). */
    reenter?: boolean;
    /** Batch mode (F18/F21): defer race settlement so the worker settles once
     *  post-batch with all winners. Set by the await-resume worker only. */
    deferRaceSettlement?: boolean;
  }): Promise<MovementRunResult> {
    this.deferRaceSettlement = input.deferRaceSettlement ?? false;
    const { movement, movementEnv } = await this.prepareMovement(input.program);
    this.movementBody = movement.body;
    this.callStack.push({ name: movement.name, declaration: movement });

    const address = parseAddress(input.state.address);
    try {
      await this.resumeAlongAddress({
        body: movement.body,
        address,
        state: input.state,
        movementEnv,
        leaf: {
          kind: 'continue',
          ...(input.answer !== undefined ? { answer: input.answer } : {}),
          reenter: input.reenter ?? false,
        },
      });
    } catch (e) {
      if (e instanceof RunCancelledSignal) {
        // User-requested cancel during a resume — the caller settles the run
        // failed (cancelled: true). Earlier writes stand (P14).
        this.cancelled = true;
      } else if (e instanceof RunParked) {
        // The resumed branch hit ANOTHER ask — re-park at the deeper address.
        this.parked = true;
        this.parkedAddress = e.address;
      } else if (!(e instanceof ScopeEndedQuietly)) {
        throw new MovementRunFailed(e, this.assembleResult(movement.name));
      }
    }

    await this.checkCancelBeforeFinishing();
    return this.assembleResult(movement.name);
  }

  /**
   * Run a fired callback's body as a SEGMENT of its owning run (callback-
   * primitive layer 2). The run keeps its identity, its team, its billing and
   * its step ledger — no new run identity anywhere. The main continuation stays
   * parked throughout: this entry runs the body and returns, and if the body
   * itself parks that is a leaf of its own.
   */
  async fireCallback(input: {
    program: Program;
    state: ParkedScopeState;
    values: Record<string, unknown>;
    callIndex: number;
  }): Promise<MovementRunResult> {
    const { movement, movementEnv } = await this.prepareMovement(input.program);
    this.movementBody = movement.body;
    this.callStack.push({ name: movement.name, declaration: movement });
    // A resume cannot get back inside a callback body (its frame is not a
    // step the resume descent knows), so nothing here may suspend: a body
    // that meets the cost cap fails this fire, as it always has.
    this.firingCallback = true;
    try {
      await this.resumeAlongAddress({
        body: movement.body,
        address: parseAddress(input.state.address),
        state: input.state,
        movementEnv,
        leaf: { kind: 'fireCallback', values: input.values, callIndex: input.callIndex },
      });
    } catch (e) {
      if (e instanceof RunCancelledSignal) this.cancelled = true;
      else if (e instanceof RunParked) {
        this.parked = true;
        this.parkedAddress = e.address;
      } else if (!(e instanceof ScopeEndedQuietly)) {
        throw new MovementRunFailed(e, this.assembleResult(movement.name));
      }
    }
    await this.checkCancelBeforeFinishing();
    return this.assembleResult(movement.name);
  }

  /**
   * Post-batch race settlement (asks-as-adapter chunk C, F18/F21). Builds the
   * receipt from EVERY completed branch's persisted exports (all winners),
   * cancels the still-parked losers (the one signal, P17), binds the receipt, and
   * runs the race's continuation forward. Re-enters PAST the race STATEMENT (not a
   * leaf): `input.state` is any completed branch's parked state — its frames and
   * scope chains cover every body down to the race, which is all the
   * continuation needs.
   */
  async settleRaceFrame(input: {
    program: Program;
    state: ParkedScopeState;
    frameAddress: string;
  }): Promise<MovementRunResult> {
    const { movement, movementEnv } = await this.prepareMovement(input.program);
    this.movementBody = movement.body;
    this.callStack.push({ name: movement.name, declaration: movement });
    try {
      await this.resumeAlongAddress({
        body: movement.body,
        address: parseAddress(input.frameAddress),
        state: input.state,
        movementEnv,
        leaf: { kind: 'settleRace', frameAddress: input.frameAddress },
      });
    } catch (e) {
      if (e instanceof RunCancelledSignal) this.cancelled = true;
      else if (e instanceof RunParked) {
        this.parked = true;
        this.parkedAddress = e.address;
      } else if (!(e instanceof ScopeEndedQuietly)) {
        throw new MovementRunFailed(e, this.assembleResult(movement.name));
      }
    }
    return this.assembleResult(movement.name);
  }

  /**
   * The race settlement's leaf: the race STATEMENT itself. The receipt is every
   * arm that settled in this batch, in slot order — ties included, which is what
   * makes more than one filled slot legal. The arms still parked stop being
   * listened on (an arm that settled already dropped its parked_run +
   * correlation, so this is a no-op on those), the receipt binds at the race's
   * name (a bare race binds nothing), and the sequence runs on past it.
   */
  private async settleRaceAt(input: {
    statement: Statement | undefined;
    frameAddress: string;
    env: Environment;
  }): Promise<void> {
    const combinator = input.statement !== undefined ? combinatorOf(input.statement) : undefined;
    if (input.statement === undefined || combinator === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `settleRace: no race statement at frame '${input.frameAddress}'`,
      );
    }
    const rows = await this.input.parkSink!.collectBranchExports({ frameAddress: input.frameAddress });
    const armCount = armCountOf(combinator, rows);
    const receipt = await this.receiptFromExports(rows, armCount, this.rehydrationContext());
    const frameAddr = parseAddress(input.frameAddress);
    const loserSubtrees: string[] = [];
    for (let j = 0; j < armCount; j++) {
      loserSubtrees.push(encodeAddress(childBranch(frameAddr, j)));
    }
    await this.input.parkSink!.cancelSubtrees({ subtreeAddresses: loserSubtrees });
    const bound = boundRValueOf(input.statement);
    if (bound !== undefined) input.env.declare(bound.name, receipt);
  }

  /**
   * The body of one combinator arm, by position. A closure arm carries its own
   * body; an arm that is a NAME runs what the name holds in the scope around
   * the combinator — a movement's body, or a body closure's (`f = () => {…}`,
   * `parallel([f])`) — which resume finds exactly as the run did
   * (`armInvocation`): by resolving the name in that scope, rehydrated. The
   * arm's own scope (what the closure brought into it) is the parked chain's
   * scope for the branch. An arm built at run time has no place in the
   * source; a park inside one carries its body (an `arm` frame), and the
   * descent takes it from there.
   */
  private armBodyAt(container: Statement, index: number, env: Environment): Statement[] | undefined {
    const arm = literalArmsOf(combinatorOf(container))[index];
    if (arm === undefined) return undefined;
    if (arm.kind === 'closure') return arm.closure.body;
    const named = env.resolve(arm.name);
    if (named?.kind === 'movement') return named.declaration.body;
    if (named?.kind === 'closure') return named.closure.body;
    return undefined;
  }

  /**
   * Forward-from-the-leaf resume (§4.4, chunk 3.2c). Descends the movement body
   * along the parked leaf's lexical ADDRESS — entering ONLY the branch/iteration
   * the address names (never re-running siblings), rehydrating each lexical
   * scope as it descends (the shared ancestor spine + the leaf's own local scope,
   * §4.6) — until it reaches the leaf's enclosing statement sequence. There the
   * leaf rule runs (bind the answer and step past it, or re-enter it), and the
   * levels it passed through are finished from the inside out
   * (`completeSpine`): the rest of each body runs, exactly as it would have had
   * the run never parked. A re-park deeper re-throws `RunParked`.
   *
   * The address structure does the routing: `stmt i` selects a statement (the
   * final `stmt` is the leaf's); `iter j` descends a fan-out body; `branch k`
   * descends a parallel branch / if-arm; `call k` descends into the k-th call
   * the statement made — a called body, or a collection op whose `iter j` is
   * the member. Each `iter`/`branch` step corresponds to one child scope in the
   * current body's parked chain (the interpreter forks a child env at exactly
   * those points), so the chain is consumed in lockstep with the descent. A
   * `call` step starts a new body, whose chain and boundary come off the
   * state's `frames`, in order.
   */
  private async resumeAlongAddress(input: {
    body: Statement[];
    address: Address;
    state: ParkedScopeState;
    movementEnv: Environment;
    leaf: ResumeLeaf;
  }): Promise<void> {
    const { address, state } = input;
    const malformed = (why: string): MovementEngineError =>
      new MovementEngineError('MOVENG_RUNTIME', `malformed parked address '${encodeAddress(address)}' — ${why}`);
    if (address.length === 0 || address[address.length - 1].kind !== 'stmt') {
      throw malformed('a parked leaf ends at a statement');
    }
    const frames = state.frames ?? [];
    // Each body the address passes into keeps its own chain of scopes: an outer
    // body's rides on the frame that leaves it, the innermost is the state's own.
    const chains: SerializedScope[][] = [
      ...frames.flatMap((frame) => (frame.kind === 'arm' ? [] : [frame.scopeChain])),
      state.scopeChain,
    ];
    // A library's file scope is not rebuilt (the live one is used), so a
    // declaration it parked under a library the re-parsed program does not
    // link would resolve silently: refuse it here, whatever the chain offset.
    for (const chain of chains) {
      for (const scope of chain) {
        for (const descriptor of Object.values(scope.bindings)) {
          if (
            (descriptor.kind === 'shape' || descriptor.kind === 'movement' || descriptor.kind === 'fileClosure') &&
            descriptor.file !== undefined
          ) {
            await this.resumedLibraryEnv(descriptor.file);
          }
        }
      }
    }
    // The whole state was written as one park, so it is read as one: a node
    // two of its scopes (or frames, or journals) held comes back as one node.
    const park = newParkReader(state);
    let segment = 0;
    let nextFrame = 0;
    const takeFrame = (): SerializedFrame => {
      const frame = frames[nextFrame];
      if (frame === undefined) throw malformed('it enters more bodies than its state records');
      nextFrame += 1;
      return frame;
    };

    // The parked scope chain is root-first: [fileEnv, movementEnv, <scope per
    // iter/branch step>…]. The file scope + movement param are rebuilt live by
    // prepareMovement; index 1 (the movement-body scope) carries the body locals
    // declared before the park. Re-layer those onto the live movementEnv.
    await this.rehydrateScopeInto(chains[0], 1, input.movementEnv, park);

    let statements = input.body;
    let env = input.movementEnv;
    let frameAddress: Address = ROOT_ADDRESS;
    let position: SourcePosition | undefined = this.source!.position;
    let atAnchor = true;
    let chainIndex = 2;
    // The descent spine (§3): one frame per level we pass through, so the leaf
    // completion can finish each of them on the way back out (§4).
    const spine: ResumeSpineFrame[] = [];

    let i = 0;
    for (;;) {
      const stmtStep = address[i];
      if (stmtStep.kind !== 'stmt') {
        throw malformed(`step ${i} is '${stmtStep.kind}', expected a statement`);
      }
      if (i === address.length - 1) break;
      const stmtAddress = childStmt(frameAddress, stmtStep.index);
      const descent = address[i + 1];
      const caller: ResumeSequence = {
        statements,
        env,
        body: { atAnchor, ...(position !== undefined ? { position } : {}), address: frameAddress },
        stmtIndex: stmtStep.index,
      };

      if (descent.kind === 'call') {
        const frame = takeFrame();
        if (frame.kind === 'arm' || frame.index !== descent.index) {
          throw malformed(`its call step ${descent.index} has no matching frame`);
        }
        const site: StatementSite = {
          body: caller.body,
          stmtAddress,
          env,
          calls: {
            next: frame.next,
            completed: await rehydrateCallRecords(frame.journal, this.rehydrationContext(), park),
          },
        };
        segment += 1;
        const chain = chains[segment];
        const callAddress = childCall(stmtAddress, frame.index);
        if (frame.kind === 'call') {
          const callee = env.resolve(frame.callee);
          let root: Environment;
          let declaration: MovementDeclaration | undefined;
          if (callee?.kind === 'movement') {
            declaration = callee.declaration;
            root = callee.fileEnv ?? this.fileEnv!;
            statements = declaration.body;
            atAnchor = false;
            position = undefined;
          } else if (callee?.kind === 'closure') {
            root = closureScope(callee);
            statements = callee.closure.body;
          } else {
            throw malformed(`'${frame.callee}' is no longer a function in the calling scope`);
          }
          spine.push({
            kind: 'call',
            caller,
            boundary: { kind: 'call', site, index: frame.index, next: frame.next, callee: frame.callee },
            ...(declaration !== undefined ? { declaration } : {}),
          });
          env = root.child();
          const offset = root.chainFromRoot().length;
          await this.rehydrateScopeInto(chain, offset, env, park);
          chainIndex = offset + 1;
          frameAddress = callAddress;
          i += 2;
          continue;
        }
        // A collection op: the next step names the member.
        const memberStep = address[i + 2];
        if (memberStep === undefined || memberStep.kind !== 'iter') {
          throw malformed(`its collection op at call ${frame.index} names no member`);
        }
        const spelling = frame.op.op.toUpperCase();
        const fn = this.collectionFunction(frame.op.fn, spelling, env);
        spine.push({
          kind: 'member',
          caller,
          boundary: {
            kind: 'member',
            site,
            index: frame.index,
            next: frame.next,
            member: memberStep.index,
            op: frame.op,
          },
          op: {
            expr: frame.op,
            spelling,
            settings: this.collectionSettings(frame.op, spelling),
            fn,
            address: callAddress,
            event: { site, index: frame.index },
            body: caller.body,
          },
        });
        // The member's scopes chain from the function's own, which a park
        // writes ahead of them: one scope for a flat capture, the whole
        // chain for a closure that holds its scope.
        const fnScope = closureScope(fn);
        env = fnScope.child();
        const fnOffset = fnScope.chainFromRoot().length;
        await this.rehydrateScopeInto(chain, fnOffset, env, park);
        chainIndex = fnOffset + 1;
        statements = fn.closure.body;
        frameAddress = childIter(callAddress, memberStep.index);
        i += 3;
        continue;
      }

      // A container statement: the next step descends into it.
      const container = statements[stmtStep.index];
      let armBoundary: LiveBoundary | undefined;
      let descended: ReturnType<Interpreter['descendForResume']>;
      if (descent.kind === 'branch' && combinatorOf(container)?.arms.kind === 'dynamic') {
        const frame = takeFrame();
        if (frame.kind !== 'arm' || frame.arm !== descent.index) {
          throw malformed(`its run-time arm ${descent.index} has no matching frame`);
        }
        armBoundary = { kind: 'arm', arm: frame.arm, body: frame.body };
        descended = {
          statements: frame.body.body,
          frameAddress: childBranch(stmtAddress, descent.index),
          atAnchor: false,
        };
      } else {
        descended = this.descendForResume({ container, step: descent, stmtAddress, state, env });
      }
      const namedArm = descent.kind === 'branch' ? literalArmsOf(combinatorOf(container))[descent.index] : undefined;
      const armName = namedArm?.kind === 'ref' ? namedArm.name : undefined;
      // Fork a child env carrying the rehydrated scope for this iter/branch.
      const childEnv = env.child();
      await this.rehydrateScopeInto(chains[segment], chainIndex, childEnv, park);
      chainIndex += 1;
      spine.push({
        kind: 'container',
        parentStatements: statements,
        parentEnv: env,
        parentFrameAddress: frameAddress,
        parentAtAnchor: atAnchor,
        ...(position !== undefined ? { parentPosition: position } : {}),
        container,
        containerIndex: stmtStep.index,
        containerAddress: stmtAddress,
        descentKind: descent.kind,
        childEnv,
        branchAddress: descended.frameAddress,
        branchIndex: descent.index,
        ...(armBoundary !== undefined ? { armBoundary } : {}),
        ...(armName !== undefined ? { armName } : {}),
      });
      statements = descended.statements;
      env = childEnv;
      frameAddress = descended.frameAddress;
      atAnchor = descended.atAnchor;
      if (descended.position !== undefined) position = descended.position;
      i += 2;
    }

    const leafIndex = address[address.length - 1].index;
    const leafStatements = statements;
    const leafEnv = env;
    const leafBody: BodyContext = {
      atAnchor,
      ...(position !== undefined ? { position } : {}),
      address: frameAddress,
    };
    const leaf = input.leaf;
    // Read whenever it was written, used or not: a node first written in the
    // journal is the one the scopes' references name.
    const journal = state.journal !== undefined
      ? await rehydrateCallRecords(state.journal, this.rehydrationContext(), park)
      : undefined;
    assertParkRead(park);
    const replay = leaf.kind === 'continue' && leaf.reenter ? journal : undefined;
    switch (leaf.kind) {
      case 'fireCallback':
        // CALLBACK FIRE (callback-primitive layer 2) — the leaf statement is a
        // `callback(…)` mint, already run; what this entry runs is its BODY, in
        // a child scope carrying the fire-time values. It deliberately does NOT
        // continue the enclosing sequence and does NOT finish the spine: that
        // continuation is the MAIN one, still parked, and it wakes only through
        // its own mechanism. One run, multiple entry points.
        await this.insideSpine(spine, () =>
          this.runCallbackBody({
            statement: leafStatements[leafIndex],
            stmtAddress: childStmt(frameAddress, leafIndex),
            env: leafEnv,
            atAnchor: leafBody.atAnchor,
            position: leafBody.position,
            values: leaf.values,
            callIndex: leaf.callIndex,
          }),
        );
        return;
      case 'settleRace':
        await this.completeSpine(spine, 0, state.address, async () => {
          await this.settleRaceAt({
            statement: leafStatements[leafIndex],
            frameAddress: leaf.frameAddress,
            env: leafEnv,
          });
          return this.continueAfter(leafStatements, leafIndex, leafEnv, leafBody);
        });
        return;
      case 'continue': {
        // Two modes (§4.4):
        //   - ASK resume (reenter=false): the leaf IS the ask; bind the answer at
        //     its binding name and step FORWARD from the statement AFTER it.
        //   - RE-ENTER resume (reenter=true): the leaf's statement must be
        //     RE-EVALUATED (an `await`, a recurring `until` timer, an engine
        //     suspension); bind nothing and RE-ENTER AT it — replaying the calls
        //     it had already finished — and run the rest of this branch forward.
        if (!leaf.reenter && state.presenceBind && state.bindingName !== null) {
          // A bound `await sleep(…)` woke: inject the presence marker (no answer
          // channel — the clock is the wake source) so `expired` escapes onto the
          // race receipt (chunk C, S4). Checked first because a timer resume
          // carries no answer, yet `resumeMovement` still hands one in as null;
          // it must not shadow the marker.
          leafEnv.declare(state.bindingName, binding({ kind: 'value', value: true, provenance: NO_PROVENANCE }));
        } else if (!leaf.reenter && state.bindingName !== null && leaf.answer !== undefined) {
          leafEnv.declare(state.bindingName, leaf.answer);
        }
        await this.completeSpine(spine, 0, state.address, () =>
          leaf.reenter
            ? this.interpretBody(leafStatements, leafEnv, leafBody, {
                at: leafIndex,
                ...(replay !== undefined ? { replay } : {}),
              })
            : this.continueAfter(leafStatements, leafIndex, leafEnv, leafBody),
        );
        return;
      }
      default:
        neverAsAny(leaf);
    }
  }

  /**
   * The rest of a body once its statement `index` finished on resume, its value
   * bound by the park's own rule. A `return` there has nothing after it: it
   * returns, exactly as it would have had the run never parked.
   */
  private continueAfter(
    statements: Statement[],
    index: number,
    env: Environment,
    body: BodyContext,
  ): Promise<BodyOutcome> {
    if (statements[index]?.kind === 'return') return Promise.resolve(returnFrom(env));
    return this.interpretBody(statements, env, body, { at: index + 1 });
  }

  /** Run `fn` inside every boundary on the spine — what a leaf that does not
   *  finish its spine still needs, so a park inside it records them. */
  private insideSpine<T>(spine: readonly ResumeSpineFrame[], fn: () => Promise<T>): Promise<T> {
    return spine.reduceRight<() => Promise<T>>((inner, frame) => {
      const boundary = frame.kind === 'container' ? frame.armBoundary : frame.boundary;
      return boundary === undefined ? inner : () => this.withinBoundary(boundary, inner);
    }, fn)();
  }

  /**
   * Run the leaf, then finish every level the descent passed through, from the
   * inside out — rebuilding normal execution's return out of each (§4). Each
   * level runs what is inside it within its own boundary, so a re-park deeper
   * records how to get back; a level whose JOIN is still waiting on siblings
   * stops the climb there (the run stays parked on them). A `RunParked` thrown
   * anywhere (a trailing sleep / ask / suspension) propagates naturally (§8).
   */
  private async completeSpine(
    spine: readonly ResumeSpineFrame[],
    level: number,
    leafAddress: string,
    leaf: () => Promise<BodyOutcome>,
  ): Promise<SpineCompletion> {
    if (level === spine.length) return { done: true, outcome: await leaf() };
    const frame = spine[level];
    const inner = (): Promise<SpineCompletion> => this.completeSpine(spine, level + 1, leafAddress, leaf);
    switch (frame.kind) {
      case 'container': {
        const armBoundary = frame.armBoundary;
        const arm = (): Promise<SpineCompletion> => this.withinCalledName(frame.armName, inner);
        const completed = armBoundary !== undefined
          ? await this.withinBoundary(armBoundary, arm)
          : await arm();
        if (!completed.done) return completed;
        return this.finishContainer(frame, completed.outcome, leafAddress);
      }
      case 'call':
        return this.finishResumedCall(frame, inner);
      case 'member':
        return this.finishResumedMember(frame, inner, leafAddress);
      default:
        return neverAsAny(frame);
    }
  }

  /**
   * A container level (§4). For a JOIN frame (fan-out iteration / parallel
   * branch) persist THIS branch's exports (§12.1), decrement the join, and —
   * only for the unique branch that closes it — merge every branch's exports
   * into the parent (§12.4) and run the post-container continuation. For an
   * `if` arm, a `return` inside it returns from the enclosing body; otherwise
   * the continuation runs.
   */
  private async finishContainer(
    frame: ResumeContainerFrame,
    outcome: BodyOutcome,
    leafAddress: string,
  ): Promise<SpineCompletion> {
    // The join-aware unwind coordinates durable joins through the park sink
    // (persist / decrement / collect). A resume with no sink is a degenerate
    // test-only mode with no durable join to close — complete only the leaf block,
    // exactly as before the unwind existed. Production resume always has a sink.
    if (this.input.parkSink === undefined) return STOPPED;
    const continuation = async (): Promise<SpineCompletion> => ({
      done: true,
      outcome: await this.continueAfter(frame.parentStatements, frame.containerIndex, frame.parentEnv, {
        atAnchor: frame.parentAtAnchor,
        ...(frame.parentPosition !== undefined ? { position: frame.parentPosition } : {}),
        address: frame.parentFrameAddress,
      }),
    });

    // A combinator ARM is a `branch k` frame. `race` settles on the first
    // completer (pending 1); `parallel` is an ordinary join (pending N).
    const combinator =
      frame.descentKind === 'branch' ? combinatorOf(frame.container) : undefined;
    const isRace = combinator?.kind === 'race';
    const isJoin = frame.descentKind === 'iter' || combinator?.kind === 'parallel';

    if (isRace) {
      // A race ARM completed. Persist its export, then claim the race frame
      // (pending 1 — FIRST completer wins). The winner stops listening on the
      // still-parked arms (one signal per park), builds the receipt, and runs
      // the continuation; a non-winner (already claimed) did its writes and
      // stops — the run stays parked on the winner's continuation, if any.
      await this.input.parkSink.persistBranchExport({
        frameAddress: encodeAddress(frame.containerAddress),
        branchAddress: encodeAddress(frame.branchAddress),
        branchIndex: frame.branchIndex,
        exports: this.serializeBranchExport(frame),
      });
      const { closed } = await this.input.parkSink.decrementJoin({
        frameAddress: encodeAddress(frame.containerAddress),
        branchAddress: encodeAddress(frame.branchAddress),
        leafAddress,
      });
      if (this.deferRaceSettlement) {
        // Batch mode (F18/F21): this branch WON, but other branches of the same
        // batch may still complete. Record the export (done above) and defer the
        // settlement — the worker runs every resolvable branch first, then
        // settles once via `settleRaceFrame` with ALL winners. The branch's
        // writes stand; the run stays parked until the post-batch settle.
        this.deferredRaceFrames.add(encodeAddress(frame.containerAddress));
        return STOPPED;
      }
      if (!closed) return STOPPED; // a sibling already won this race (inline mode)
      await this.settleRaceWinner(frame, leafAddress);
      return continuation();
    }

    if (isJoin) {
      // Persist THIS branch's export contribution durably, keyed by the join
      // frame + this branch, BEFORE decrementing (§12.1) — so by the time ANY
      // branch observes `closed`, every sibling's export row is committed.
      await this.input.parkSink.persistBranchExport({
        frameAddress: encodeAddress(frame.containerAddress),
        branchAddress: encodeAddress(frame.branchAddress),
        branchIndex: frame.branchIndex,
        exports: this.serializeBranchExport(frame),
      });
      const { closed } = await this.input.parkSink.decrementJoin({
        frameAddress: encodeAddress(frame.containerAddress),
        branchAddress: encodeAddress(frame.branchAddress),
        leafAddress,
      });
      // Not the last branch — this branch is done (its writes stand), the join
      // stays pending, the run stays parked. Do NOT run the continuation.
      if (!closed) return STOPPED;
      // We ARE the closer — fold ALL branches' exports into the parent (§12.4),
      // then run the deferred post-container continuation.
      await this.mergeJoinBranch(frame);
      return continuation();
    }

    // An `if` arm: its bindings are block-scoped — nothing to merge — and it is
    // transparent to `return`, which lands in the enclosing scope too.
    if (outcome.returned) {
      frame.parentEnv.declare(RETURN_SLOT, outcome.value);
      return { done: true, outcome };
    }
    return continuation();
  }

  /**
   * A call level: the callee's body finished on resume, so the call hands back
   * what it returned — and the CALLING statement runs again, its earlier calls
   * replayed and this one handing back that value, then the calling body goes
   * on past it. A quiet scope end inside the callee ends only the callee's
   * scope, as it does when nothing parked.
   */
  private async finishResumedCall(
    frame: ResumeCallFrame,
    inner: () => Promise<SpineCompletion>,
  ): Promise<SpineCompletion> {
    const { declaration } = frame;
    const callerBody = this.movementBody;
    // The frame the call had before it parked: a movement, or a closure called
    // by name — so the depth below it is counted from where it really is.
    this.callStack.push({ name: frame.boundary.callee, ...(declaration !== undefined ? { declaration } : {}) });
    if (declaration !== undefined) this.movementBody = declaration.body;
    let completed: SpineCompletion;
    try {
      completed = await this.withinBoundary(frame.boundary, inner);
    } catch (e) {
      if (!(e instanceof ScopeEndedQuietly)) throw e;
      completed = { done: true, outcome: FELL_THROUGH };
    } finally {
      if (declaration !== undefined) this.movementBody = callerBody;
      this.callStack.pop();
    }
    if (!completed.done) return completed;
    const value = completed.outcome.returned ? completed.outcome.value : undefined;
    return {
      done: true,
      outcome: await this.rerunStatement(frame.caller, frame.boundary.site, {
        index: frame.boundary.index,
        record: { value, next: frame.boundary.next },
      }),
    };
  }

  /**
   * A collection op's member finished on resume. Its answer joins the op's
   * frame like a block iteration's export (§12.1), and the join is decremented.
   * The member that closes it finishes the OP: it runs the members that never
   * started (with the op's own settings — which may park the op again), builds
   * the answer in member order, and re-runs the op's statement with it. A
   * member that fails is forgiven or not exactly as `onError` says when nothing
   * parked.
   */
  private async finishResumedMember(
    frame: ResumeMemberFrame,
    inner: () => Promise<SpineCompletion>,
    leafAddress: string,
  ): Promise<SpineCompletion> {
    const { op } = frame;
    const flow = this.openFlowFrame();
    const into = this.trace;
    let answer: MemberAnswer;
    try {
      const named = op.expr.fn.kind === 'ref' ? op.expr.fn.name : undefined;
      const completed = await this.flowFrames.run(flow, () =>
        this.withinBoundary(frame.boundary, () => this.withinCalledName(named, inner)),
      );
      if (!completed.done) return completed;
      answer = { kept: true, value: memberValue(op, completed.outcome) };
    } catch (error) {
      if (op.settings.onError === 'error' || !isMemberFailure(error)) throw error;
      answer = { kept: false };
      if (op.settings.onError === 'warn') {
        flow.trace.push(memberLeftOut(op.spelling, frame.boundary.member, undefined, error));
      }
    } finally {
      into.push(...flow.trace);
    }

    const sink = this.input.parkSink;
    if (sink === undefined) return STOPPED;
    const frameAddress = encodeAddress(op.address);
    const branchAddress = encodeAddress(childIter(op.address, frame.boundary.member));
    await sink.persistBranchExport({
      frameAddress,
      branchAddress,
      branchIndex: frame.boundary.member,
      exports: serializeMemberAnswer(answer, this.memberAnswerPark(op.event)),
    });
    const { closed } = await sink.decrementJoin({ frameAddress, branchAddress, leafAddress });
    if (!closed) return STOPPED;

    const run = await this.resumedCollectionRun(op, frameAddress);
    const pending = run.members.map((_, index) => index).filter((index) => run.answers[index] === undefined);
    const value = await this.runCollectionMembers(run, pending, run.answers);
    return {
      done: true,
      outcome: await this.rerunStatement(frame.caller, frame.boundary.site, {
        index: frame.boundary.index,
        record: { value, next: frame.boundary.next },
      }),
    };
  }

  /** A parked op as its frame kept it: the members it reads, `REDUCE`'s
   *  start, and every answer its members have given so far. */
  private async resumedCollectionRun(
    op: ResumedCollectionOp,
    frameAddress: string,
  ): Promise<CollectionRun & { answers: MemberAnswer[] }> {
    const rows = await this.input.parkSink!.collectBranchExports({ frameAddress });
    const ctx = this.rehydrationContext();
    const stateRow = rows.find((row) => row.branchIndex === FRAME_STATE_INDEX);
    if (stateRow === undefined || !isCollectionOpState(stateRow.exports)) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `resume: the collection op at '${frameAddress}' kept no record of its members`,
      );
    }
    const source = await rehydrateBinding(stateRow.exports.source, ctx);
    const init = await rehydrateBinding(stateRow.exports.init, ctx);
    if (source.kind !== 'value' || !Array.isArray(source.value)) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `resume: the collection op at '${frameAddress}' kept members that are not a list`,
      );
    }
    const answers: MemberAnswer[] = [];
    for (const row of rows) {
      if (row.branchIndex < 0 || !isMemberAnswerExport(row.exports)) continue;
      if (!row.exports.kept) {
        answers[row.branchIndex] = { kept: false };
        continue;
      }
      let reader: ReturnType<typeof newParkReaderOf> | undefined;
      if (since(this.languageVersion, 5)) {
        const live = newParkReaderOf(row.exports.answer);
        this.liveAnswerChain(op.event).forEach((scope, id) => live.scopes.set(id, scope));
        reader = live;
      }
      const bound = await rehydrateBinding(row.exports.answer, ctx, reader);
      answers[row.branchIndex] = { kept: true, value: bound.kind === 'value' ? bound.value : bound };
    }
    return {
      ...op,
      members: source.value,
      sourceProvenance: source.provenance ?? NO_PROVENANCE,
      init: init.kind === 'value' ? init.value : null,
      answers,
    };
  }

  /**
   * Run a calling statement again, with the call a park was inside handing back
   * `record`, and every call it had finished before replaying its kept value —
   * then the rest of its body.
   */
  private rerunStatement(
    caller: ResumeSequence,
    site: StatementSite,
    resumed: { index: number; record: CallRecord },
  ): Promise<BodyOutcome> {
    const replay = new Map(site.calls.completed);
    replay.set(resumed.index, resumed.record);
    return this.interpretBody(caller.statements, caller.env, caller.body, {
      at: caller.stmtIndex,
      replay,
    });
  }

  /**
   * Fold a closed JOIN frame's branch exports into the parent env exactly as
   * normal execution's join (§5/§12.4) — reconstructing the aggregate from ALL
   * branches' persisted exports (not just the closer's live env), so a
   * continuation that reads a non-closer sibling's binding, or the full fan-out
   * `blockMeta` across every iteration, sees the same data a never-parked run
   * would.
   */
  private async mergeJoinBranch(frame: ResumeAncestorFrame): Promise<void> {
    const rows = await this.input.parkSink!.collectBranchExports({
      frameAddress: encodeAddress(frame.containerAddress),
    });
    const ctx = this.rehydrationContext();

    // `await parallel([…])`: the receipt from every arm's export — the same
    // positional value the never-parked path builds, so a run that parked and a
    // run that did not read identically.
    const combinator = combinatorOf(frame.container);
    if (combinator !== undefined) {
      const bindingName = boundRValueOf(frame.container)?.name;
      if (bindingName === undefined) return;
      frame.parentEnv.declare(
        bindingName,
        await this.receiptFromExports(rows, armCountOf(combinator, rows), ctx),
      );
      return;
    }

    // Assigned fan-out: the block's value is what its iterations RETURNED, in
    // iteration order — mirrors interpretBlock. A return rides out of a parked
    // iteration as the reserved slot in its export, which is the whole reason
    // it is bound into the scope rather than only carried as an outcome. A bare
    // (unbound) fan-out declares nothing.
    const bindingName = boundRValueOf(frame.container)?.name;
    if (bindingName === undefined) return;
    const returned: Binding[] = [];
    for (const row of rows) {
      const exports = row.exports as Record<string, BindingDescriptor>;
      const descriptor = exports[RETURN_SLOT];
      if (descriptor !== undefined) returned.push(await rehydrateBinding(descriptor, ctx));
    }
    frame.parentEnv.declare(bindingName, blockValue(returned));
  }

  /**
   * The race winner's settlement (asks-as-adapter chunk C): cancel every LOSER
   * branch's subtree (the one signal to each still-parked leaf, P17), then bind
   * the RECEIPT on the parent env from the completed branches' persisted exports
   * (only the winner(s) completed; parked losers persisted nothing). A bare
   * `race` binds nothing. Mirrors `mergeJoinBranch`'s rehydrate-from-exports so a
   * resumed receipt reads exactly as a never-parked one would.
   */
  private async settleRaceWinner(frame: ResumeAncestorFrame, leafAddress: string): Promise<void> {
    const combinator = combinatorOf(frame.container);
    const kept = await this.input.parkSink!.collectBranchExports({
      frameAddress: encodeAddress(frame.containerAddress),
    });
    const armCount = combinator !== undefined ? armCountOf(combinator, kept) : 0;
    // Every arm's subtree is withdrawn — the winner's own parked row may still
    // exist mid-resume, so it is spared by ADDRESS, never by ordering.
    const loserSubtrees: string[] = [];
    for (let j = 0; j < armCount; j++) {
      loserSubtrees.push(encodeAddress(childBranch(frame.containerAddress, j)));
    }
    if (loserSubtrees.length > 0) {
      await this.input.parkSink!.cancelSubtrees({
        subtreeAddresses: loserSubtrees,
        excludeLeaf: leafAddress,
      });
    }

    const bindingName = boundRValueOf(frame.container)?.name;
    if (bindingName === undefined) return;
    frame.parentEnv.declare(
      bindingName,
      await this.receiptFromExports(kept, armCount, this.rehydrationContext()),
    );
  }

  /**
   * The receipt, rebuilt from the arms' persisted exports: slot i is what arm i
   * RETURNED, which rode out of its park in the reserved return slot of its
   * branch export. An arm that never completed left no row, so its slot is null
   * — which for a race is exactly "this one did not win".
   */
  private async receiptFromExports(
    rows: Array<{ branchIndex: number; exports: unknown }>,
    armCount: number,
    ctx: RehydrationContext,
  ): Promise<Binding> {
    const slots: Binding[] = new Array(armCount).fill(NULL_SLOT);
    for (const row of rows) {
      const exports = row.exports as Record<string, BindingDescriptor>;
      const descriptor = exports[RETURN_SLOT];
      if (descriptor === undefined) continue;
      if (row.branchIndex < 0 || row.branchIndex >= slots.length) continue;
      slots[row.branchIndex] = await rehydrateBinding(descriptor, ctx);
    }
    return binding({ kind: 'tuple', slots });
  }

  /**
   * Serialize a completed branch's exports (§12.3) — its child env's own
   * bindings, via `serializeBinding`. A fan-out iteration EXCLUDES the head's
   * hop-alias names (the loop variables are not exports — mirrors interpretBlock's
   * `iteration.bindings.has(name)` skip). The alias names are static in the block
   * head, derived I/O-free from the container shape; over-inclusion (a leaked loop
   * var) is fail-safe, a dropped export is not.
   */
  private serializeBranchExport(frame: ResumeAncestorFrame): Record<string, BindingDescriptor> {
    const out: Record<string, BindingDescriptor> = {};
    const skip = frame.descentKind === 'iter' ? this.hopAliasNamesOf(frame.container) : undefined;
    // One export is one parked state, so it is written by ONE park: a handle
    // or node two names hold (`b = a`) is written once and referenced after,
    // and comes back as one. The returned value goes first — it is the name
    // the join reads back on its own, so its descriptors hold every first
    // sighting and it never refers into a name not read.
    const entries = [...frame.childEnv.ownBindings()]
      .filter(([name]) => !skip?.has(name))
      .sort(([a], [b]) => Number(b === RETURN_SLOT) - Number(a === RETURN_SLOT));
    const park = this.newPark();
    for (const [name, binding] of entries) {
      out[name] = serializeBinding(binding, park);
    }
    return out;
  }

  /** The static hop-alias names of a fan-out container's block head (§12.3) —
   *  exactly the alias slots `resolveBlockIterations` binds per iteration. Parsed
   *  from the head text (no I/O), matching the runtime `iteration.bindings` keys. */
  private hopAliasNamesOf(container: Statement): Set<string> {
    const block = fanOutBlockOf(container);
    const names = new Set<string>();
    if (!block) return names;
    const resourceAlias = RESOURCES_HEAD_ALIAS.exec(block.head.hopsRaw)?.[1];
    if (resourceAlias !== undefined) names.add(resourceAlias);
    const probe = this.probeHead(block.head);
    if (probe?.type === 'traverse') {
      for (const step of probe.steps) {
        if ('alias' in step && step.alias !== undefined) names.add(step.alias);
      }
    }
    return names;
  }

  /**
   * Resolve one descent step (`iter j` / `branch k`) into the AST node + the
   * frame address it lands on. Mirrors `interpretIf` / `interpretParallel` /
   * `interpretBlock`'s branch/iteration structure exactly (so the address the
   * firing computed re-resolves to the same sequence).
   */
  private descendForResume(input: {
    container: Statement;
    step: AddressStep;
    stmtAddress: Address;
    state: ParkedScopeState;
    env: Environment;
  }): {
    statements: Statement[];
    frameAddress: Address;
    atAnchor: boolean;
    position?: SourcePosition;
  } {
    const { container, step, stmtAddress, state, env } = input;
    if (step.kind === 'iter') {
      const block = fanOutBlockOf(container);
      if (!block) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `resume: address descends 'iter' into a non-fan-out statement (parked '${state.address}')`,
        );
      }
      // The iteration body; its position (the yielded record) is NOT re-derived —
      // the rehydrated iteration scope already holds the iteration's bindings.
      return {
        statements: block.body,
        frameAddress: childIter(stmtAddress, step.index),
        atAnchor: false,
      };
    }
    // branch k — an if-arm or a combinator arm.
    if (container.kind === 'if') {
      const arm = container.arms[step.index];
      const armBody = arm ? arm.body : container.elseArm?.body;
      if (!armBody) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `resume: if branch ${step.index} has no body (parked '${state.address}')`,
        );
      }
      return {
        statements: armBody,
        frameAddress: childBranch(stmtAddress, step.index),
        atAnchor: true,
      };
    }
    if (combinatorOf(container) !== undefined) {
      const armBody = this.armBodyAt(container, step.index, env);
      if (armBody === undefined) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `resume: no body for arm ${step.index} of this combinator (parked '${state.address}')`,
        );
      }
      return {
        statements: armBody,
        frameAddress: childBranch(stmtAddress, step.index),
        atAnchor: false,
      };
    }
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `resume: address descends 'branch' into a '${container.kind}' statement (parked '${state.address}')`,
    );
  }

  /**
   * Rehydrate the parked chain's scope at `chainIndex` INTO `env`. Skips bindings
   * `prepareMovement` already bound live (the event param, and file-scope code
   * refs / instances that live in the parent file env). A missing chain entry is
   * a no-op (a shallow leaf has fewer scopes than a deep one).
   */
  private async rehydrateScopeInto(
    chain: readonly SerializedScope[],
    chainIndex: number,
    env: Environment,
    park: ParkReader,
  ): Promise<void> {
    const scope = chain[chainIndex];
    if (!scope) return;
    // The scope a parked closure names by number is this one, live.
    registerLiveScope(park, scope, env);
    const ctx = this.rehydrationContext();
    for (const [name, descriptor] of Object.entries(scope.bindings)) {
      // The trigger's event is bound live as the movement's parameter; one
      // passed on to a called body by another name is the same event.
      if (
        env.resolve(name) !== undefined &&
        (descriptor.kind === 'event' ||
          descriptor.kind === 'instance' ||
          descriptor.kind === 'movement' ||
          descriptor.kind === 'shape')
      ) {
        continue;
      }
      env.declare(name, await rehydrateBinding(descriptor, ctx, park));
    }
  }

  private assembleResult(movementName: string): MovementRunResult {
    return {
      movementName,
      writes: this.writes.map(({ old: _old, ...record }) => record),
      extractionSites: this.summariser.sites,
      trace: this.runTrace,
      ...(this.parked ? { parked: true } : {}),
      ...(this.parkedAddress !== undefined ? { parkedAddress: this.parkedAddress } : {}),
      ...(this.cancelled ? { cancelled: true } : {}),
      ...(this.deferredRaceFrames.size > 0
        ? { deferredRaceFrames: [...this.deferredRaceFrames] }
        : {}),
      ...spendFields(),
    };
  }

  /**
   * The rehydration seam (§4.1) backed by THIS interpreter's already-prepared
   * live context — the same registry / adapter resolution `prepareMovement`
   * wired. Adapters re-resolve via `graphReadFor` / the catalog; FileRefs revive
   * via the owner adapter; code refs come from the re-parsed file env.
   */
  private rehydrationContext(): RehydrationContext {
    return {
      resolveInstance: async (identity) => this.rehydrateInstance(identity),
      resolveSourceRead: async (instanceName) => {
        const binding = this.fileEnv?.resolve(instanceName);
        if (!binding) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `resume: cannot rebind read seam for instance '${instanceName}' — not in the re-parsed file scope`,
          );
        }
        const read = await this.graphReadFor(instanceName, binding);
        if (!read) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `resume: '${instanceName}' is not a readable graph`,
          );
        }
        return read.read;
      },
      reviveFileRef: (descriptor) => this.reviveResumedFileRef(descriptor),
      // In the file it was declared in: a library's declaration is found in
      // that library, which the root program need not import or may shadow.
      resolveCodeRef: async (name, file) => {
        const scope = file === undefined ? this.fileEnv : await this.resumedLibraryEnv(file);
        const binding = scope?.resolve(name);
        if (!binding) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `resume: cannot re-resolve code ref '${name}' from the re-parsed ${file === undefined ? 'program' : `library "${file}"`}`,
          );
        }
        return binding;
      },
      // A body closure's scope chains up to its file's, which is the
      // re-parsed program's (or library's), live.
      resolveFileScope: async (file) => {
        const scope = file === undefined ? this.fileEnv : await this.resumedLibraryEnv(file);
        if (scope === undefined) {
          throw new MovementEngineError('MOVENG_RUNTIME', 'resume: a parked closure names a file scope the re-parsed program has none of');
        }
        return scope;
      },
    };
  }

  /** A library's environment by its path, for a code ref a park said was
   *  declared there. */
  private async resumedLibraryEnv(path: string): Promise<Environment> {
    const file = this.link?.files.get(path);
    if (file === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `resume: the parked state names the library "${path}", which the re-parsed program does not link`,
      );
    }
    return this.libraryEnv(file);
  }

  /** A park writer whose code refs say which library they are declared in. */
  private newPark(): ParkWriter {
    return newParkWriter(
      (env) => this.libraryPaths.get(env),
      (env) => env === this.fileEnv || this.libraryPaths.has(env),
    );
  }

  /** Re-resolve an instance binding from its serialised identity — the catalog
   *  re-instantiates its schema live (honest drift if the external schema
   *  changed, §4.1). */
  private rehydrateInstance(
    identity: InstanceIdentityDescriptor,
  ): Extract<Binding, { kind: 'instance' }> {
    const args: Record<string, string> = { ...(identity.constructionConfig ?? {}) };
    const spec = this.input.catalog.adapter(identity.adapterSlug);
    const credentialArg = (spec && credentialArgOf(spec)?.name) ?? 'credentials';
    if (identity.credentialName !== undefined) args[credentialArg] = identity.credentialName;
    return binding({
      kind: 'instance',
      name: identity.name,
      adapterSlug: identity.adapterSlug,
      ...(identity.credentialName !== undefined ? { credentialName: identity.credentialName } : {}),
      ...(identity.constructionConfig !== undefined
        ? { constructionConfig: identity.constructionConfig }
        : {}),
      schema: this.input.catalog.instantiate(identity.adapterSlug, args),
    });
  }

  /**
   * Rebind a parked FileRef's `retrieve()` from its `source` handle — the owner
   * adapter's `resolveFileRef`, re-resolved live via `resolveAdapter` (the same
   * cross-wire revive pattern, §4.1), or the document store for a file that
   * lives in our own storage (`FILE()` artifacts, manual uploads' store).
   *
   * A FileRef with no `source` has no way back to its bytes. Every producer
   * sets one, so only a state parked by an older writer can carry such a ref;
   * its channel still exists, and says exactly why it cannot fetch — the read
   * that reaches for it then lands on the run as a warning
   * (`MOVENG_FILE_BYTES_UNAVAILABLE`), never as a silently thinner input.
   */
  private reviveResumedFileRef(descriptor: FileRefDescriptor): FileRef {
    const ref: FileRef = {
      __brand: 'FileRef',
      ...(descriptor.name !== undefined ? { name: descriptor.name } : {}),
      ...(descriptor.contentType !== undefined ? { contentType: descriptor.contentType } : {}),
      ...(descriptor.size !== undefined ? { size: descriptor.size } : {}),
      ...(descriptor.source !== undefined ? { source: descriptor.source } : {}),
      ...(descriptor.url !== undefined ? { url: descriptor.url } : {}),
    };
    const source = descriptor.source;
    if (!source) {
      ref.retrieve = async () => {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          'it was parked without a durable handle, so its bytes cannot be fetched after the run resumed',
        );
      };
    } else if (source.ownerAdapterType === DOCUMENT_STORE_OWNER) {
      ref.retrieve = documentStoreFileRef({
        objectUri: source.handle,
        ...(ref.name !== undefined ? { name: ref.name } : {}),
        ...(ref.contentType !== undefined ? { contentType: ref.contentType } : {}),
        ...(ref.size !== undefined ? { size: ref.size } : {}),
      }).retrieve;
    } else {
      ref.retrieve = async () => {
        const owner = await this.resolveAdapterFn({
          adapterType: source.ownerAdapterType,
          teamId: this.input.teamId,
          role: 'source',
        });
        if (!owner.resolveFileRef) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `resume: owner adapter '${source.ownerAdapterType}' cannot resolve a parked FileRef`,
          );
        }
        return owner.resolveFileRef({ ref });
      };
    }
    return ref;
  }

  /**
   * The live source setup shared by `run()` and `resume()`: the file scope
   * (imports / instances / movements), movement selection, and the source
   * adapter the entry movement's parameter is typed against. Returns the
   * movement + its movement-body env (the param declared); the source position
   * lands on `this.source`.
   */
  private async prepareMovement(
    program: Program,
  ): Promise<{ movement: MovementDeclaration; movementEnv: Environment }> {
    const fileEnv = new Environment();
    this.fileTypes.set(fileEnv, declaredTypesIn(program));

    // File scope, pass 1 — declarations only (constructions are inert
    // data; adapters resolve lazily at first read/write). Movements are
    // collected; deferred value expressions evaluate in pass 2 below so
    // program order holds for anything they could observe.
    const movements: MovementDeclaration[] = [];
    const deferredFileStatements: Statement[] = [];
    for (const statement of program.statements) {
      if (statement.kind === 'movement') {
        movements.push(statement);
        fileEnv.declare(statement.name, binding({ kind: 'movement', declaration: statement }));
      } else {
        deferredFileStatements.push(statement);
      }
    }

    const movement = this.selectMovement(movements);
    for (const statement of deferredFileStatements) {
      await this.interpretFileStatement(statement, fileEnv);
    }
    this.fileEnv = fileEnv;

    // The DISPATCHED movement takes exactly the triggering event —
    // dispatch supplies one position. Multi-parameter movements are
    // library movements (callees); the checker enforces the arity-1
    // rule on listen/run entries, so reaching this means a direct
    // invocation picked a callee-only movement.
    if (movement.params.length !== 1) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${movement.name}' takes ${movement.params.length} parameters — a dispatched movement takes exactly one (the triggering event); multi-parameter movements run as callees`,
      );
    }
    const param = movement.params[0];
    if (param.type === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${movement.name}' has an untyped parameter — the checker should have caught this`,
      );
    }
    const paramType = typeNameOf(param.type);
    if (paramType === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${movement.name}' takes a value ('${param.name}: <${spellParamType(param.type)}>'), and a dispatched movement takes the triggering event — the checker should have caught this`,
      );
    }
    const sourceBinding = fileEnv.resolve(paramType.graph);
    if (sourceBinding?.kind === 'instance') {
      const sourceAdapter = await this.resolveAdapterFn({
        adapterType: sourceBinding.adapterSlug,
        teamId: this.input.teamId,
        credentialsId: this.credentialsIdFor(sourceBinding),
        role: 'source',
      });
      // The program reads the source by NATURAL names; the wrapper
      // translates them to the adapter's internal ids through the
      // instance's own resolver (and stamps landed positions with natural
      // type names). The parameter's declared type names the root position.
      const wrapped = surfaceReadAdapter({
        inner: sourceAdapter,
        schema: sourceBinding.schema,
        ...(paramType.position !== undefined ? { startSurfaceType: paramType.position } : {}),
      });
      // The discriminated root carries the adapter's positionType (a machine
      // typeId, e.g. `granola:note`); resolve it to its NATURAL type name so the
      // seed names the root the way the program + field/edge resolver do. NOT
      // the parameter's declared type — discrimination may have narrowed below
      // it (a broad param + an `IS` arm), and where an inbound event carries no
      // discrimination at all the position stays TYPELESS on purpose: `IS` must
      // refuse rather than guess.
      //
      // A MUTATION event is the one kind with nothing to discriminate: it
      // names the changed record's id, and the trigger names its type. What it
      // SEEDS is still the event (D40) — the listen fires the change, and the
      // changed record is one hop along the event's subject edge — so the type
      // is read off the adapter's own event surface rather than off the
      // parameter. The declared parameter cannot serve here: an event-typed
      // parameter is written as a narrowed ADDRESS, which carries no plain
      // position, so falling back to it seeds a TYPELESS root and every hop off
      // the event (including the hop to its own record) becomes unresolvable.
      const rootSurfaceType =
        (await naturalRootTypeName(sourceAdapter, this.input.event.rootRecordType)) ??
        (this.input.event.triggerType === 'mutation'
          ? (soleEventPosition(sourceBinding.schema) ?? paramType.position)
          : undefined);
      // A typed event seeds the EVENT NODE, typed by its canonical narrowed
      // address (the node the event edge lands on, its pins read off the
      // payload's own address fields + `action`) — an unstable occurrence
      // whose record is reached by its `record` edge. Otherwise the
      // discriminated object type names the root.
      const eventAddress = eventSeedAddress({
        schema: sourceBinding.schema,
        event: this.input.event,
        rootTypeName: rootSurfaceType,
      });
      this.sourceEventAddress = eventAddress;
      this.source = {
        adapter: wrapped,
        position: seedEventPosition(this.input.event, sourceBinding.adapterSlug, {
          ...(rootSurfaceType !== undefined ? { surfaceType: rootSurfaceType } : {}),
          ...(eventAddress !== undefined ? { eventAddress } : {}),
        }),
        instanceName: sourceBinding.name,
        ...(sourceBinding.schema !== undefined ? { schema: sourceBinding.schema } : {}),
      };
      this.sourceInstance = sourceBinding;
      if (this.input.event.triggerType === 'snapshot') {
        // The snapshot envelope carries no adapter identity of its own
        // (run_now.ts builds it before the program is parsed) — the source
        // instance is canonical for the run's mutation context.
        this.mutationContext = {
          ...this.mutationContext,
          source: {
            ...this.mutationContext.source,
            type: 'structured_input',
            adapterType: sourceBinding.adapterSlug,
          },
        };
      }
    } else {
      throw unsupported(
        `a movement parameter typed against '${paramType.graph}'`,
        'type the parameter against a constructed adapter instance',
      );
    }

    const movementEnv = fileEnv.child();
    movementEnv.declare(param.name, binding({ kind: 'event' }));
    return { movement, movementEnv };
  }

  private selectMovement(movements: MovementDeclaration[]): MovementDeclaration {
    const wanted = this.input.movementName;
    // The fired movement is a function's name, so from version 3 it is the
    // same name in any letter case (the checker resolved the listen's `fire`
    // the same way).
    const movement = wanted !== undefined && wanted !== ''
      ? movements.find((m) => m.name === wanted)
        ?? (since(this.languageVersion, 3)
          ? movements.find((m) => m.name.toLowerCase() === wanted.toLowerCase())
          : undefined)
      : movements.length === 1
        ? movements[0]
        : undefined;
    if (!movement) {
      throw new MovementEngineError(
        'MOVENG_NOT_FOUND',
        this.input.movementName
          ? `no movement named '${this.input.movementName}' in this program`
          : `expected exactly one movement declaration (found ${movements.length}) — pass movementName to pick one`,
      );
    }
    return movement;
  }

  // ── File scope ──

  private async interpretFileStatement(statement: Statement, env: Environment): Promise<void> {
    switch (statement.kind) {
      case 'import':
        if (statement.source.kind === 'file') {
          if (!this.currentImports) {
            throw unsupported(
              `the file import "${statement.source.path}"`,
              'this run has no file resolver — pass resolveFile to runMovement',
            );
          }
          await this.declareFileImports(statement.names, statement.source.path, env);
          return;
        }
        for (const { name, alias } of statement.names) {
          if (alias !== undefined) this.importOriginals.set(alias, name);
          // A PLUGIN import binds the plugin's name. Nothing runs here — a
          // plugin is a function whose body isn't visible — but a call on this
          // name means something different from a call on a movement, and the
          // binding is what says so, exactly as the checker's scope does.
          if (statement.source.namespace === 'plugins') {
            env.declare(alias ?? name, binding({ kind: 'plugin', plugin: name }));
            continue;
          }
          // A bare adapter import is NOT an instance — instantiation is
          // explicit (`go = manual()`). The import name binds opaque; an
          // instance exists only from a construction (the `assign` case
          // below). The checker rejects a bare import used as a position
          // source or `listen to`, so the runtime never needs the old lazy
          // binding (spec plans/2026-06-24-required-instantiation/0_spec.md).
          env.declare(
            alias ?? name,
            binding(
              statement.source.namespace === 'credentials'
                ? { kind: 'opaque', what: 'a credential', credential: true }
                : { kind: 'opaque', what: 'import' },
            ),
          );
        }
        return;
      case 'assign': {
        // A call whose callee is a built-in (`n = UPPER("x")`) is the value it
        // computes, at file level as anywhere — resolution says so, once.
        const rhs = this.resolvedRValue(statement.value, env);
        switch (rhs.kind) {
          case 'construct':
            // The construction-shaped spelling of a CALL reaches here too, and
            // means the same thing it means anywhere: run the movement. There
            // is nothing at file scope to run it about.
            {
              const kind = env.resolve(this.calleeName(rhs.construct.callee, env))?.kind;
              if (kind === 'movement' || kind === 'plugin') throw fileLevelCall();
            }
            env.declare(
              statement.name,
              this.instanceBinding(statement.name, rhs.construct),
            );
            return;
          case 'call':
            throw fileLevelCall();
          case 'expr': {
            const aliased = this.aliasedNodeBinding(rhs.expr, env);
            if (aliased !== undefined) {
              env.declare(statement.name, aliased);
              return;
            }
            const selected = await this.selectedPositionBinding(rhs.expr, env);
            if (selected !== undefined) {
              env.declare(statement.name, selected);
              return;
            }
            const { value, provenance } = await this.evaluateSlot(rhs.expr, { env });
            env.declare(statement.name, bindValue(value, provenance, { many: this.bindsManyValues(rhs.expr, env) }));
            return;
          }
          case 'closure':
            // A closure bound at file level — the root program's or a
            // library's — is in scope in that file's functions, as the
            // checker's file scope says. It holds the file scope by
            // REFERENCE, as a JavaScript closure holds its module scope: it
            // sees the file's later closures too, and a park writes it by
            // name rather than copying the file scope into it.
            env.declare(statement.name, binding({
              kind: 'closure',
              closure: rhs.closure,
              captured: new Map(),
              file: { name: statement.name, env },
              ...(since(this.languageVersion, 3) ? { self: statement.name } : {}),
            }));
            return;
          case 'extract':
          case 'extractCall':
            throw unsupported(
              'file-level extract expressions',
              'extraction runs inside a movement body, where the event is in scope',
            );
          case 'block':
            throw unsupported('file-level traversal blocks', 'blocks run inside a movement body');
          case 'write':
            throw unsupported('file-level writes', 'writes run inside a movement body');
          case 'match':
            throw unsupported('file-level matches', 'a match runs inside a movement body');
          case 'link':
            throw unsupported('file-level links', 'a link runs inside a movement body');
        }
        return;
      }
      case 'shape':
        env.declare(statement.name, binding({ kind: 'shape', declaration: statement, fileEnv: env }));
        return;
      default:
        // Other file-level statements contribute nothing to a movement
        // run (the retired TG-lowering compiler's convention, kept).
        return;
    }
  }

  /**
   * Bind one `import { … } from "<file>"` statement's names from the
   * resolved link (the SAME structure `checkProgramWithLink` validated):
   * a shape binds as its declaration; a movement binds callable, carrying
   * its library's file environment so the call executes against the
   * library's OWN scope (its adapter imports, constructions, file-level
   * values), not the importer's.
   */
  private async declareFileImports(
    names: Array<{ name: string; alias?: string }>,
    path: string,
    env: Environment,
  ): Promise<void> {
    for (const { name, alias } of names) {
      const local = alias ?? name;
      const exported = this.currentImports?.get(local);
      if (!exported) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${local}' did not resolve from "${path}" — the checker should have caught this`,
        );
      }
      if (exported.kind === 'shape') {
        env.declare(local, binding({
          kind: 'shape',
          declaration: exported.declaration,
          library: exported.file,
        }));
      } else {
        env.declare(local, binding({
          kind: 'movement',
          declaration: exported.declaration,
          fileEnv: await this.libraryEnv(exported.file),
        }));
      }
    }
  }

  /**
   * A library file's environment, built once per path (diamonds share
   * it): the same two-pass file-scope interpretation `run()` applies to
   * the root program — movements first (hoisted, carrying THIS env as
   * their fileEnv so library-internal calls stay library-scoped), then
   * the deferred statements in source order. `currentImports` and
   * `importOriginals` are saved/restored around the build: both are
   * per-file vocabularies, and the library's constructions resolve their
   * aliases EAGERLY (instanceBinding), so nothing needs them afterwards.
   */
  private async libraryEnv(file: LinkedFile): Promise<Environment> {
    const cached = this.libraryEnvs.get(file.path);
    if (cached) return cached;
    const env = new Environment();
    this.libraryEnvs.set(file.path, env);
    this.libraryPaths.set(env, file.path);
    this.fileTypes.set(env, this.typesOfLibrary(file));

    const savedImports = this.currentImports;
    const savedOriginals = new Map(this.importOriginals);
    this.currentImports = file.imports;
    try {
      const deferred: Statement[] = [];
      for (const statement of file.program.statements) {
        if (statement.kind === 'movement') {
          env.declare(statement.name, binding({
            kind: 'movement',
            declaration: statement,
            fileEnv: env,
          }));
        } else {
          deferred.push(statement);
        }
      }
      for (const statement of deferred) {
        await this.interpretFileStatement(statement, env);
      }
    } finally {
      this.currentImports = savedImports;
      this.importOriginals.clear();
      for (const [key, value] of savedOriginals) this.importOriginals.set(key, value);
    }
    return env;
  }

  private typesOfLibrary(file: LinkedFile): Map<string, SchemaFieldType> {
    let types = this.libraryTypes.get(file.path);
    if (types === undefined) {
      types = declaredTypesIn(file.program);
      this.libraryTypes.set(file.path, types);
    }
    return types;
  }

  /** The refinements visible where `env` sits: its file's. A scope rebuilt
   *  from a park reads the running file's, as it always has. */
  private typesIn(env: Environment | undefined): Map<string, SchemaFieldType> {
    const file = env?.chainFromRoot()[0];
    return (
      (file !== undefined ? this.fileTypes.get(file) : undefined)
      ?? (this.fileEnv !== undefined ? this.fileTypes.get(this.fileEnv) : undefined)
      ?? new Map()
    );
  }

  /** A node declaration's refinements: those of the scope it was DECLARED in —
   *  the same scope its descriptions read. */
  private shapeTypes(shape: ShapeBinding): Map<string, SchemaFieldType> {
    return shape.library !== undefined ? this.typesOfLibrary(shape.library) : this.typesIn(shape.fileEnv);
  }

  /**
   * `node X extends Y` — Y, as a binding that knows where IT was declared. `Y`
   * is a name in the scope X was declared in (a sibling declaration or an
   * import there), and from then on Y's words and types read Y's own file.
   */
  private shapeBase(shape: ShapeBinding): ShapeBinding | undefined {
    const base = shape.declaration.extends;
    if (base === undefined) return undefined;
    const found =
      shape.library !== undefined
        ? libraryShape(shape.library, base.name)
        : (shape.fileEnv ?? this.fileEnv)?.resolve(base.name);
    if (found?.kind === 'shape') return found;
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `'${shape.declaration.name}' extends '${base.name}', which is not a node declaration in scope — the checker should have caught this`,
    );
  }

  /** The `extends` chain from `shape` down to the declaration that stands on
   *  its own, `shape` first. */
  private shapeChain(shape: ShapeBinding): ShapeBinding[] {
    const chain: ShapeBinding[] = [];
    for (let at: ShapeBinding | undefined = shape; at !== undefined; at = this.shapeBase(at)) {
      if (chain.some((c) => c.declaration === at!.declaration)) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${shape.declaration.name}' extends itself — the checker should have caught this`,
        );
      }
      chain.push(at);
    }
    return chain;
  }

  /**
   * A node declaration as the whole tree it stands for, with its schema —
   * every `extends` folded in, and each declaration's field types resolved in
   * the file that wrote it. The checker builds the same fold (`inheritSchema`),
   * so a `<Recap Entry>` predicate is compared at run time against the
   * structure it was checked against.
   */
  private resolvedShape(shape: ShapeBinding): { declaration: ShapeDeclaration; schema: InstanceSchema } {
    let resolved: { declaration: ShapeDeclaration; schema: InstanceSchema } | undefined;
    for (const link of this.shapeChain(shape).reverse()) {
      const types = this.shapeTypes(link);
      const own = shapeToSchema(link.declaration, (name) => types.get(name));
      resolved =
        resolved === undefined
          ? { declaration: link.declaration, schema: own }
          : {
              declaration: inheritDeclaration(link.declaration, resolved.declaration),
              schema: inheritSchema(own, link.declaration.name, {
                name: resolved.declaration.name,
                schema: resolved.schema,
              }),
            };
    }
    return resolved!;
  }

  /** What an extraction taking `shape` as its node reads: each declaration in
   *  the chain with the resolvers of the scope IT was declared in — Y's words
   *  in Y's file even when X, in another file, imported Y. */
  private declaredNodeShape(shape: ShapeBinding, env: Environment): DeclaredNodeShape {
    let declared: DeclaredNodeShape | undefined;
    for (const link of this.shapeChain(shape).reverse()) {
      const { library } = link;
      const declaredIn = link.fileEnv ?? this.fileEnv ?? env;
      const types = this.shapeTypes(link);
      declared = {
        root: link.declaration.root,
        resolveDeclaredType: (name) => types.get(name),
        resolveDescription: async (slot) =>
          this.describeIn(slot, library !== undefined ? await this.libraryEnv(library) : declaredIn),
        ...(declared !== undefined ? { base: declared } : {}),
      };
    }
    return declared!;
  }

  private instanceBinding(name: string, construct: ConstructionCall): Binding {
    const adapterSlug = this.importOriginal(construct.callee);
    const spec = this.input.catalog.adapter(adapterSlug);
    const credentialArg = (spec && credentialArgOf(spec)?.name) ?? 'credentials';
    const credential = construct.args.find((a) => a.name === credentialArg);
    const args: Record<string, string> = {};
    const constructionConfig: Record<string, string> = {};
    for (const arg of construct.args) {
      const raw = arg.value.raw.trim();
      // Unwrap backtick-quoted credential names before alias resolution so
      // catalog lookups key on the verbatim (unquoted) name in all cases.
      args[arg.name] = arg.name === credentialArg
        ? this.importOriginal(unwrapCredentialArg(raw) ?? raw)
        : raw;
      // Everything that ISN'T the credential is the instance's construction
      // config — the binding store's instance key keys on it (3b).
      if (arg.name !== credentialArg) constructionConfig[arg.name] = raw;
    }
    const rawCredValue = credential?.value.raw.trim();
    const unwrappedCred = rawCredValue !== undefined ? unwrapCredentialArg(rawCredValue) : null;
    return binding({
      kind: 'instance',
      name,
      adapterSlug,
      ...(unwrappedCred !== null ? { credentialName: this.importOriginal(unwrappedCred) } : {}),
      ...(Object.keys(constructionConfig).length > 0 ? { constructionConfig } : {}),
      schema: this.input.catalog.instantiate(adapterSlug, args),
    });
  }

  /** Resolves a (possibly aliased) imported local name to its catalog / workspace name. */
  private importOriginal(local: string): string {
    return this.importOriginals.get(local) ?? local;
  }

  /**
   * Build a source-role read seam for a constructed instance binding —
   * reads in the program's NATURAL names translate to the adapter's
   * internal ids through the instance's own resolver, the same wrapper
   * the event source rides. Cached per (slug, credential, construction
   * args) since the same instance can be read from multiple heads.
   */
  private async instanceSourceRead(
    binding: Extract<Binding, { kind: 'instance' }>,
  ): Promise<SourceRead> {
    const credentialsId = this.credentialsIdFor(binding);
    const constructionArgs = constructionArgsOf(binding);
    const argsKey = Object.keys(constructionArgs).length
      ? JSON.stringify(Object.entries(constructionArgs).sort(([a], [b]) => a.localeCompare(b)))
      : '';
    const cacheKey = `source::${binding.adapterSlug}::${credentialsId ?? ''}::${argsKey}`;
    let adapter = this.sourceAdapterCache.get(cacheKey);
    if (!adapter) {
      const inner = await this.resolveAdapterFn({
        adapterType: binding.adapterSlug,
        teamId: this.input.teamId,
        credentialsId,
        ...(Object.keys(constructionArgs).length ? { constructionArgs } : {}),
        role: 'source',
      });
      adapter = surfaceReadAdapter({ inner, schema: binding.schema });
      this.sourceAdapterCache.set(cacheKey, adapter);
    }
    return {
      adapter,
      instanceName: binding.name,
      ...(binding.schema !== undefined ? { schema: binding.schema } : {}),
    };
  }

  /**
   * Resolve a graph-valued binding to its READ seam + start position —
   * the enabler for instance-/handle-rooted traversals (block heads
   * and expression reads): `crm-[c:companies]-> { … }` streams through
   * the crm instance's own adapter from its meta position; a write handle
   * (`co-[c:contacts]-> { … }`) streams through its own graph's adapter
   * from the handle's own stable record — the write result IS a
   * position. Source-role adapters are cached per (slug, credential).
   */
  private async graphReadFor(
    _name: string,
    binding: Binding,
  ): Promise<{ read: SourceRead; start: SourcePosition } | undefined> {
    if (binding.kind === 'instance') {
      return { read: await this.instanceSourceRead(binding), start: makeMetaPosition(binding.adapterSlug) };
    }
    if (binding.kind === 'handle') {
      // No external id means the write bound no concrete record (e.g. a
      // non-record handle) — return undefined so the caller fails loudly
      // rather than reading from a record that isn't there.
      if (binding.handle.externalId === undefined) return undefined;
      const read = await this.instanceSourceRead(binding.graph.instance);
      return {
        read,
        start: makeStablePosition({
          adapterType: binding.handle.adapterType,
          recordType: binding.targetType,
          recordId: binding.handle.externalId,
          data: binding.handle.resultData,
        }),
      };
    }
    return undefined;
  }

  private credentialsIdFor(instance: Extract<Binding, { kind: 'instance' }>): string | undefined {
    if (!instance.credentialName) return undefined;
    return this.input.resolveCredentialId?.(instance.credentialName);
  }

  // ── Statement interpretation (movement body / if arms) ──

  private async interpretBody(
    statements: Statement[],
    env: Environment,
    body: BodyContext,
    /** Resume entry (async user interaction §4.4): the walk begins at `at`
     *  instead of 0, skipping the statements whose effects ran before the park
     *  (forward-from-leaf), and that first statement replays the calls it had
     *  already finished. One-shot — NOT threaded into nested bodies (an `if`
     *  arm / parallel branch always starts at 0). */
    entry: BodyEntry = {},
  ): Promise<BodyOutcome> {
    const startIndex = entry.at ?? 0;
    // A node declaration in a body names a shape for the whole body, as the
    // checker hoists it — and a resume, which re-enters past the statements
    // that already ran, finds it again here.
    for (const statement of statements) {
      if (statement.kind === 'shape' && env.resolveOwn(statement.name) === undefined) {
        env.declare(statement.name, binding({ kind: 'shape', declaration: statement, fileEnv: env, local: true }));
      }
    }
    for (let stmtIndex = startIndex; stmtIndex < statements.length; stmtIndex++) {
      const statement = statements[stmtIndex];
      // This statement's lexical address (§4.3) — the address an `ask` here
      // parks at, and the prefix its `if`/`parallel`/fan-out descendants extend.
      const stmtAddress = childStmt(body.address, stmtIndex);
      // The cancel gate (runs-and-cancel spec §cancel): a user-requested cancel
      // stops the run at the next statement boundary — never mid-write.
      // Debounced DB read; latches once true. Caught at the top of
      // run()/resume() (like RunParked), never by the fan-out/parallel park
      // machinery (they re-throw anything but RunParked/ScopeEndedQuietly).
      if (this.input.cancelGate && (await this.input.cancelGate.cancelled())) {
        throw new RunCancelledSignal();
      }
      // The statement is the SITE of any call nested in its expressions: such a
      // call runs as this statement's (movement-lang checker/nested_calls.ts).
      const replay = stmtIndex === startIndex ? entry.replay : undefined;
      const site: StatementSite = {
        body,
        stmtAddress,
        env,
        calls: { next: 0, completed: new Map(), ...(replay !== undefined ? { replay } : {}) },
      };
      const outcome = await this.statementSites.run(site, async () => {
        // A paused run (a limit met here or in another flow) stops each flow
        // between statements: the one it was running finished, the next waits.
        if (this.limitPaused && this.canSuspend()) await this.suspendFlow();
        if (this.input.suspendWhen?.({ kind: 'statement', address: encodeAddress(stmtAddress) })) {
          await this.suspendFlow();
        }
        try {
          return await this.interpretStatement(statement, env, body, stmtAddress);
        } catch (error) {
          // The cost cap is checked before every priced call, so meeting it
          // here means this statement was about to spend: suspend just before it.
          if (isRunCostCapExceeded(error) && this.canSuspend()) await this.suspendAtLimit(error);
          throw error;
        }
      });
      if (outcome !== undefined) return outcome;
    }
    return FELL_THROUGH;
  }

  /** One statement of a body. A `BodyOutcome` ends the body (a `return`, or an
   *  `if` arm that returned); undefined goes on to the next statement. */
  private async interpretStatement(
    statement: Statement,
    env: Environment,
    body: BodyContext,
    stmtAddress: Address,
  ): Promise<BodyOutcome | undefined> {
    switch (statement.kind) {
      case 'import':
        await this.interpretFileStatement(statement, env);
        break;
      case 'assign':
        await this.declareAssign(statement.name, statement.value, env, body, stmtAddress);
        break;
      // `return <value>` is a binding into a reserved slot: the same
      // right-hand side, evaluated the same way, into a name the grammar
      // cannot spell — which is what carries it across a park.
      case 'return': {
        // `(f) => f()` (language version 5): the closure hands back what the
        // call returns — and, when it returns nothing, nothing.
        const concise = statement.concise === true ? this.conciseCall(statement.value, env) : undefined;
        if (concise !== undefined) {
          const value = await this.executeCall(concise, env, { ...body, address: stmtAddress });
          if (value === undefined) return FELL_THROUGH;
          env.declare(RETURN_SLOT, value);
          return returnFrom(env);
        }
        await this.declareAssign(RETURN_SLOT, statement.value, env, body, stmtAddress);
        return returnFrom(env);
      }
      case 'write':
        await this.executeWrite(statement.write, undefined, env, body);
        break;
      case 'error':
        await this.interpretError(statement, env);
        break;
      case 'if': {
        // An arm is transparent: a `return` inside one returns from THIS
        // body, so its outcome rides straight out — and lands in this scope
        // too, so a park anywhere above still carries it.
        const outcome = await this.interpretIf(statement, env, {
          ...body,
          address: stmtAddress,
        });
        if (outcome.returned) {
          env.declare(RETURN_SLOT, outcome.value);
          return outcome;
        }
        break;
      }
      case 'call': {
        // `MAP(xs, f)` run bare is the iteration it resolved to; every other
        // call runs its callee.
        const reading = this.readCallIn(statement, env, 'statement');
        if (reading.kind === 'collection') {
          await this.interpretCollectionOp(reading.collection, undefined, env, body, stmtAddress);
          break;
        }
        await this.executeCall(statement, env, { ...body, address: stmtAddress });
        break;
      }
      case 'match':
        await this.executeMatch(statement.match, undefined, env, { onMiss: this.matchMissPolicy });
        break;
      case 'link':
        await this.executeLink(statement.link, undefined, env);
        break;
      case 'unlink':
        await this.executeUnlinkStatement(statement, env);
        break;
      case 'delete':
        await this.executeDeleteStatement(statement, env);
        break;
      case 'refresh':
        await this.interpretRefresh(statement, env);
        break;
      case 'block':
        await this.interpretBlock(statement.block, undefined, env, stmtAddress);
        break;
      case 'await':
        await this.interpretAwait(statement.await, undefined, env, stmtAddress, body);
        break;
      case 'combinator':
        await this.interpretCombinator(statement.combinator, undefined, env, stmtAddress, body);
        break;
      case 'collection':
        // Bare — the function's effects are the point; the answer (if any)
        // is unbound, exactly as an unbound 'call' statement's return is.
        await this.interpretCollectionOp(statement.collection, undefined, env, body, stmtAddress);
        break;
      case 'shape':
        // Hoisted above.
        break;
      case 'movement':
        throw unsupported(`nested ${statement.kind} declarations inside a movement body`);
    }
    return undefined;
  }

  /**
   * One right-hand side, evaluated and bound. Shared by `name = <value>` and
   * `return <value>` — they take the same grammar, so they take the same
   * evaluation; only the name differs.
   */
  private async declareAssign(
    name: string,
    value: RValue,
    env: Environment,
    body: BodyContext,
    stmtAddress: Address,
  ): Promise<void> {
    const resolved = this.resolvedRValue(value, env);
    if (resolved !== value) return this.declareAssign(name, resolved, env, body, stmtAddress);
    switch (value.kind) {
      case 'construct': {
        // `name(args)` is one surface form; what the name RESOLVES to
        // decides what it means — an adapter type constructs, a
        // movement runs and its value is bound. The grammar cannot
        // tell them apart, so it doesn't (parser/ast `constructionAsCall`).
        const construct = value.construct;
        const calleeKind = env.resolve(this.calleeName(construct.callee, env))?.kind;
        const callsClosure = calleeKind === 'closure' && since(this.languageVersion, 3);
        if (calleeKind === 'movement' || calleeKind === 'plugin' || callsClosure) {
          const call = constructionAsCall(construct);
          env.declare(
            name,
            requireCallValue(
              call.callee,
              await this.executeCall(call, env, { ...body, address: stmtAddress }),
            ),
          );
          break;
        }
        env.declare(name, this.instanceBinding(name, construct));
        break;
      }
      case 'call':
        // The other route to a bound call — the one the parser could
        // tell apart. Same execution, same value.
        env.declare(
          name,
          requireCallValue(
            value.call.callee,
            await this.executeCall(value.call, env, { ...body, address: stmtAddress }),
          ),
        );
        break;
      case 'write':
        await this.executeWrite(value.write, name, env, body);
        break;
      case 'expr':
        env.declare(name, await this.bindSlotValue(value.expr, env));
        break;
      case 'extract': {
        const emission = await this.runExtraction(
          name,
          value.extract,
          env,
        );
        env.declare(name, binding({ kind: 'extractRoot', emission }));
        break;
      }
      case 'extractCall': {
        // A call like any other: re-running its statement takes the value it
        // already extracted instead of paying for it again.
        const event = await this.beginCall();
        const extracted = event.replayed !== undefined
          ? event.replayed.value
          : this.finishCall(event, await this.runExtractCall(value.extractCall, env));
        env.declare(name, requireCallValue('extract', extracted));
        break;
      }
      case 'block':
        await this.interpretBlock(value.block, name, env, stmtAddress);
        break;
      case 'match':
        await this.executeMatch(value.match, name, env, { onMiss: this.matchMissPolicy });
        break;
      case 'link':
        await this.executeLink(value.link, name, env);
        break;
      case 'await':
        await this.interpretAwait(value.await, name, env, stmtAddress, body);
        break;
      case 'combinator':
        await this.interpretCombinator(value.combinator, name, env, stmtAddress, body);
        break;
      case 'collection':
        await this.interpretCollectionOp(value.collection, name, env, body, stmtAddress);
        break;
      case 'members':
        this.interpretMembers(value.members, name, env);
        break;
      case 'inlineBlock':
        this.inlineBlockRetired(value.inlineBlock.binding);
        break;
      case 'closure':
        // A closure is (AST, scope) and nothing else runs here: the body runs
        // when it is CALLED. It holds this scope by REFERENCE, as a JavaScript
        // closure does: it sees the bindings made after it too, and a park
        // writes the scope once and the closure as a reference to it — where
        // a snapshot per closure held every earlier closure's snapshot, and
        // doubled the parked state with each one.
        env.declare(name, binding({
          kind: 'closure',
          closure: value.closure,
          captured: new Map(),
          env,
          // From version 3 its body may call it by this name (recursion).
          ...(since(this.languageVersion, 3) ? { self: name } : {}),
        }));
        break;
      case 'callback':
        env.declare(
          name,
          await this.mintCallback(value.callback, env, stmtAddress),
        );
        break;
      case 'node':
        env.declare(
          name,
          await this.synthesiseNode(value.node, env),
        );
        break;
      case 'lazy':
        // Nothing runs here — that is the whole point. The walk is
        // stored with the scope it was written in, and every read of
        // this name runs it afresh against the live source.
        env.declare(name, binding({
          kind: 'lazyWalk',
          walk: this.deferWalk(
            value.lazy.head,
            env,
            value.lazy.mapping,
          ),
        }));
        break;
    }
  }

  /**
   * `parallel { … }` — env fork + join. Every sibling statement runs in
   * its OWN child environment, all siblings concurrently (Promise.all):
   * sibling bindings are invisible to each other while the block runs
   * (the checker already rejects cross-sibling reads — `parallelSibling`
   * scope poisoning), and the block's writes interleave in completion
   * order on the firing record. After the join, each sibling's bindings
   * hoist into the enclosing scope in program order — exactly the
   * checker's "sibling bindings come into scope after the block".
   */
  /**
   * `await race([…])` / `await parallel([…])` — the two concurrency combinators
   * (core calculus v2 R5). The arms are FUNCTION values and this is what calls
   * them: each runs concurrently in its own `branch k` frame, and the value is
   * a POSITIONAL receipt — one slot per arm, in the arms' own order.
   *
   * **Bursts and ties.** Every arm is started, and this waits until each has
   * either COMPLETED or PARKED at a suspension. A running arm is never
   * preempted, so a completion that lands before teardown counts: `race` may
   * settle with more than one filled slot, which is what "anything inside one
   * running burst is simultaneous" means. So an arm that "loses" a race in the
   * same burst has still done everything it did — its writes landed and stay
   * landed, and its slot is filled; only an arm parked at settlement is
   * withdrawn, and what it would have done after its park never happens.
   *
   * **Isolation.** Each arm runs in a frame of its own, as a collection op's
   * member does: its own copy of the call stack (two arms calling the same
   * movement are not a recursion) and its own trace, spliced in ARM order. Its
   * effects on the world wait only for effects contending for the same key
   * (`effect_locks.ts`), so two arms writing one `unique by` key make one
   * record.
   *
   * **Cancellation is withdrawal, never a tear.** At settlement `race` stops
   * listening on the arms that parked — their `parked_run` rows and resume
   * correlations go (`cancelSubtrees`), so a later firing on one of them
   * resumes nothing. Nothing in flight is interrupted, because nothing in
   * flight is still running by then.
   *
   * Two paths, exactly as any other join:
   *   - SOMETHING SETTLED IN THIS BURST: bind the receipt and continue inline.
   *     (`race` needs one arm; `parallel` needs them all.)
   *   - EVERYTHING STILL PARKED: record the frame — pending 1 for `race` (the
   *     first completer wins), pending N for `parallel` (every arm must land)
   *     — and suspend. The unwind settles it when the arms resume.
   */
  /**
   * `MAP(xs, f)` / `FILTER(xs, f)` / `REDUCE(xs, init, f)` / `GROUPBY(xs, key)`
   * / `KEYBY(xs, key)` — the function, once per member.
   *
   * The op is one of its statement's calls (`call k`), and each member runs as
   * `iter i` under it, so a member has an address of its own. Members run one
   * at a time unless `MAP` / `FILTER` were given a settings record saying
   * otherwise (`runMembers`); the answer is in MEMBER order either way.
   *
   * A member may park (an `await` in its function, or the engine suspending
   * it). The op is then a JOIN, like a traversal-headed block: the members
   * that finished keep their answers at the op's frame, the parked ones are
   * its pending count, and the op parks. Whichever parked member finishes last
   * on resume runs the members that never started, builds the answer, and
   * re-runs the op's statement with it (`finishResumedMember`).
   */
  private async interpretCollectionOp(
    expr: CollectionOpExpression,
    bindingName: string | undefined,
    env: Environment,
    body: BodyContext,
    stmtAddress: Address,
  ): Promise<void> {
    const event = await this.beginCall();
    const bound = event.replayed !== undefined
      ? event.replayed.value
      : this.finishCall(event, await this.runCollectionOp(expr, env, body, stmtAddress, event));
    if (bindingName !== undefined) {
      env.declare(bindingName, requireCallValue(expr.op.toUpperCase(), bound));
    }
  }

  private async runCollectionOp(
    expr: CollectionOpExpression,
    env: Environment,
    body: BodyContext,
    stmtAddress: Address,
    event: CallEvent,
  ): Promise<Binding> {
    const spelling = expr.op.toUpperCase();
    const source = await this.evaluateSlot(expr.source, { env });
    const members = source.value;
    if (!Array.isArray(members)) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${spelling}' reads a collection of values and got ${members === null || members === undefined ? 'nothing' : typeof members} — the checker should have caught this`,
      );
    }
    const init = expr.op === 'reduce' && expr.init !== undefined
      ? (await this.evaluateSlot(expr.init, { env })).value
      : null;
    const run: CollectionRun = {
      expr,
      spelling,
      settings: this.collectionSettings(expr, spelling),
      fn: this.collectionFunction(expr.fn, spelling, env),
      address: childCall(event.site?.stmtAddress ?? stmtAddress, event.index),
      event,
      body,
      members,
      sourceProvenance: source.provenance,
      init,
    };
    return this.runCollectionMembers(run, members.map((_, index) => index), []);
  }

  /**
   * Run the given members of an op and build its answer — or, when any of them
   * parked, keep what the finished ones answered at the op's frame and park the
   * op. `answers` holds the members already answered (on resume: every member
   * but the ones never started).
   */
  private async runCollectionMembers(
    run: CollectionRun,
    indices: readonly number[],
    answers: MemberAnswer[],
  ): Promise<Binding> {
    const params = run.fn.closure.params.map((p) => p.name);
    // A function handed over by name is called by name, once per member.
    const named = run.expr.fn.kind === 'ref' ? run.expr.fn.name : undefined;
    const member = async (index: number): Promise<unknown> => {
      const values = run.expr.op === 'reduce'
        ? [carriedBefore(answers, index, run.init), run.members[index]]
        : [run.members[index]];
      const args: Record<string, unknown> = {};
      params.forEach((name, position) => {
        args[name] = values[position] ?? null;
      });
      const outcome = await this.enterMember(run, index, () =>
        this.withinNamedCall(named, () =>
          this.invokeClosure(run.fn, args, { ...run.body, address: childIter(run.address, index) }),
        ),
      );
      return memberValue(run, outcome);
    };
    const parked = await this.runMembers({
      indices,
      count: run.members.length,
      settings: run.settings,
      spelling: run.spelling,
      answers,
      member,
    });
    if (parked.length > 0) await this.parkCollectionOp(run, answers, parked.length);
    return collectionAnswer(run, answers);
  }

  /** A member's run, inside its boundary — so a park in it records how to
   *  get back to this member of this op. */
  private enterMember<T>(run: CollectionRun, index: number, fn: () => Promise<T>): Promise<T> {
    const site = run.event.site;
    if (site === undefined) return fn();
    return this.withinBoundary(
      {
        kind: 'member',
        site,
        index: run.event.index,
        next: site.calls.next,
        member: index,
        op: run.expr,
      },
      fn,
    );
  }

  /**
   * Some members parked: the op is now a pending JOIN at its own address. Keep
   * what resume needs to finish it — the members it reads, `REDUCE`'s start, and
   * each finished member's answer — at that frame, count the parked members, and
   * park.
   */
  private async parkCollectionOp(
    run: CollectionRun,
    answers: readonly MemberAnswer[],
    parkedMembers: number,
  ): Promise<never> {
    const frameAddress = encodeAddress(run.address);
    const sink = this.input.parkSink;
    if (sink !== undefined) {
      const state: CollectionOpState = {
        source: serializeBinding(binding({
          kind: 'value',
          value: run.members,
          provenance: run.sourceProvenance,
        })),
        init: serializeBinding(binding({ kind: 'value', value: run.init, provenance: NO_PROVENANCE })),
      };
      await sink.persistBranchExport({
        frameAddress,
        branchAddress: frameAddress,
        branchIndex: FRAME_STATE_INDEX,
        exports: state,
      });
      for (const [index, answer] of answers.entries()) {
        if (answer === undefined) continue;
        await sink.persistBranchExport({
          frameAddress,
          branchAddress: encodeAddress(childIter(run.address, index)),
          branchIndex: index,
          exports: serializeMemberAnswer(answer, this.memberAnswerPark(run.event)),
        });
      }
      await sink.recordJoin({ frameAddress, parkedChildren: parkedMembers });
    }
    throw new RunParked(frameAddress);
  }

  /** The op's settings record, read the way the checker read it — or, with
   *  none written, one member at a time with the first failure failing the
   *  run. */
  private collectionSettings(expr: CollectionOpExpression, spelling: string): CollectionRunSettings {
    if (expr.config === undefined) return SEQUENTIAL_COLLECTION_SETTINGS;
    let reading: ReturnType<typeof readCollectionConfig>;
    try {
      reading = readCollectionConfig(expressionOfSlot(expr.config), spelling);
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      reading = { ok: false, problems: [e.message] };
    }
    if (!reading.ok) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${spelling}' was given settings it cannot run with — the checker should have caught this: ${reading.problems.join('; ')}`,
      );
    }
    return reading.settings;
  }

  /**
   * Run `member(i)` for each of `indices`, `settings.concurrency` at a time,
   * filling `answers` by MEMBER index — whatever order they finished in.
   *
   * Scheduling. The first `initialConcurrency` members are a batch of their
   * own: it runs to the end before any other member starts, so whatever the
   * first members make shared (a cached prompt) is in place for the rest. The
   * rest then run `concurrency` at a time, each slot taking the next member as
   * soon as its last one finishes. With neither set, that is one member at a
   * time, in order — what every op did before it could be told otherwise.
   *
   * Each member runs in a frame of its own (`FlowFrame`): its own copy of the
   * call stack, and its own trace, spliced into the enclosing trace in member
   * order as the members before it finish. What members do to the WORLD is
   * kept apart by the run's effect locks (`effect_locks.ts`): a write's
   * identity is a find-then-create, so two members writing the same key wait
   * for each other, while writes to different keys run together.
   *
   * Failure. A member's function failing is a fact about that member, and
   * `onError` says what it does: `error` fails the run (as it always has),
   * `warn` and `ignore` leave the member out of the answer — `warn` putting a
   * warning in the trace where the member's entries are. Only a member's own
   * failure is forgiven. A run being cancelled, the run's call ceiling, its
   * cost cap, and a `match` that found nothing ending the scope quietly are the
   * RUN's control flow, not a member failing, and pass through whatever
   * `onError` says. When the op does fail, no further member starts, the
   * members already running finish (their effects have happened, and the run's
   * ledger has to hold them), and the failure re-thrown is the earliest
   * MEMBER's — the one a one-at-a-time run would have stopped at.
   *
   * Parking. A member that parks holds its slot: that slot starts nothing
   * more, while the other slots go on (so with as many slots as members, every
   * member reaches its own park, as a block's iterations do). Nothing past the
   * first batch starts once a member of the first batch has parked. The parked
   * members' indices are returned; the members never started are left
   * unanswered, for the op's resume to run.
   */
  private async runMembers(input: {
    indices: readonly number[];
    /** The op's member count, for the trace's words. */
    count: number;
    settings: CollectionRunSettings;
    spelling: string;
    answers: MemberAnswer[];
    member: (index: number) => Promise<unknown>;
  }): Promise<number[]> {
    const { indices, count, settings, spelling, answers, member } = input;
    const frames: FlowFrame[] = [];
    const parked: number[] = [];
    let failure: { index: number; error: unknown } | undefined;
    let next = 0;
    // Each member's trace joins the enclosing trace as soon as every member
    // before it has finished too — so a long op's trace still reads as it
    // lands, and never out of member order.
    const into = this.trace;
    const finished: boolean[] = [];
    let spliced = 0;
    const splice = (): void => {
      while (spliced < indices.length && finished[spliced] === true) {
        into.push(...(frames[spliced]?.trace ?? []));
        spliced += 1;
      }
    };

    /** Run the member at `position` of `indices`; true when it parked. */
    const runOne = async (position: number): Promise<boolean> => {
      const index = indices[position];
      const frame = this.openFlowFrame();
      frames[position] = frame;
      try {
        answers[index] = { kept: true, value: await this.flowFrames.run(frame, () => member(index)) };
        return false;
      } catch (error) {
        if (error instanceof RunParked) {
          parked.push(index);
          return true;
        }
        if (settings.onError === 'error' || !isMemberFailure(error)) {
          if (failure === undefined || index < failure.index) failure = { index, error };
          return false;
        }
        answers[index] = { kept: false };
        if (settings.onError === 'warn') {
          frame.trace.push(memberLeftOut(spelling, index, count, error));
        }
        return false;
      } finally {
        finished[position] = true;
        splice();
      }
    };
    // `width` slots, each taking the next member until `end` is reached, a
    // member has failed the op, or its own member parked.
    const runBatch = async (end: number, width: number): Promise<void> => {
      const slot = async (): Promise<void> => {
        // A paused run starts no further member once one of this op's has
        // suspended: the rest are never started, and the op's resume runs them.
        // Until one has, a member started now suspends at its first statement,
        // so the op still parks as a join rather than answering short.
        while (failure === undefined && next < end && !(this.limitPaused && parked.length > 0)) {
          const position = next;
          next += 1;
          if (await runOne(position)) return;
        }
      };
      await Promise.all(Array.from({ length: Math.max(0, Math.min(width, end - next)) }, slot));
    };

    try {
      if (settings.initialConcurrency < settings.concurrency) {
        await runBatch(Math.min(settings.initialConcurrency, indices.length), settings.initialConcurrency);
      }
      if (parked.length === 0) await runBatch(indices.length, settings.concurrency);
    } finally {
      // A failed op stopped starting members, so the ones after a gap never
      // ran; what the rest did still belongs on the trace, in member order.
      for (let position = spliced; position < frames.length; position++) {
        into.push(...(frames[position]?.trace ?? []));
      }
    }
    if (failure !== undefined) throw failure.error;
    return parked;
  }

  /** A frame for one concurrent flow started from this one: the enclosing
   *  call stack copied, and an empty trace of its own. */
  private openFlowFrame(): FlowFrame {
    return { callStack: [...this.callStack], trace: [] };
  }

  /** The function a collection op runs: written in place, or a name bound to
   *  one (a closure, or a movement, which is a closure with a name). */
  private collectionFunction(
    fn: ArmExpression,
    spelling: string,
    env: Environment,
  ): Extract<Binding, { kind: 'closure' }> {
    if (fn.kind === 'closure') {
      // From version 5 a function written in place holds the scope it is
      // written in by REFERENCE, as every other closure does — so a closure
      // its body returns chains up to the live scope, not to a flat copy
      // that no park can tell from a file's.
      if (since(this.languageVersion, 5)) return binding({ kind: 'closure', closure: fn.closure, captured: new Map(), env });
      return binding({ kind: 'closure', closure: fn.closure, captured: captureScope(env) });
    }
    const named = env.resolve(fn.name);
    if (named?.kind === 'closure') return named;
    if (named?.kind === 'movement') {
      return binding({
        kind: 'closure',
        closure: {
          params: named.declaration.params,
          body: named.declaration.body,
          span: named.declaration.span,
        },
        captured: captureScope(named.fileEnv ?? env),
      });
    }
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `'${fn.name}' is ${named ? describeBinding[named.kind] : 'not in scope'}, and '${spelling}' runs a function — the checker should have caught this`,
    );
  }

  /**
   * `MEMBERS(<Thesis>)` — the values of a closed type, in the order they were
   * declared. A declared refinement carries them itself; a borrowed field's
   * come from the LIVE schema, re-read per firing exactly as an extract
   * annotation's do, so an option added over there is followed without a
   * re-save.
   */
  private interpretMembers(
    expr: MembersExpression,
    bindingName: string | undefined,
    env: Environment,
  ): void {
    const segments = borrowedTypeSegments(expr.type);
    const resolved = segments !== undefined && segments.length === 3
      ? (() => {
          const schema = this.graphSchemaOf(segments[0], env);
          return schema ? resolveBorrowedField(schema, segments[1], segments[2]) : undefined;
        })()
      : this.typesIn(env).get(expr.type);
    if (!isEnumType(resolved)) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'MEMBERS(<${expr.type}>)' names no closed set of values — the checker should have caught this`,
      );
    }
    if (bindingName !== undefined) {
      env.declare(bindingName, binding({
        kind: 'value',
        value: [...resolved.options],
        provenance: NO_PROVENANCE,
      }));
    }
  }

  private async interpretCombinator(
    expr: CombinatorExpression,
    bindingName: string | undefined,
    env: Environment,
    stmtAddress: Address,
    body: BodyContext,
  ): Promise<void> {
    const arms = await this.resolveArms(expr, env);
    this.trace.push({ kind: 'block', root: expr.kind, positions: arms.length });

    if (arms.length === 0) {
      if (expr.kind === 'race') {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          'a race over no arms can never settle — nothing was given to it to run',
        );
      }
      // A parallel over nothing ran nothing, and its receipt has no slots.
      if (bindingName !== undefined) env.declare(bindingName, binding({ kind: 'tuple', slots: [] }));
      return;
    }

    const forks = arms.map((arm, index) => ({
      arm,
      index,
      env: env.child(),
      address: childBranch(stmtAddress, index),
      frame: this.openFlowFrame(),
    }));
    const settled = new Map<number, Binding>();
    const parked: typeof forks = [];
    // Real concurrency, as `parallel` has always had: each arm runs its own
    // prefix, and one arm's park does not stop the others reaching theirs.
    // Each arm runs in a frame of its own, as a collection op's member does —
    // its own call stack and its own trace, spliced in ARM order once every
    // arm has stopped — and its effects wait only for an effect contending
    // for the same key (`effect_locks.ts`).
    const into = this.trace;
    const outcomes = await Promise.allSettled(
      forks.map((fork) =>
        this.flowFrames.run(fork.frame, async () => {
          try {
            const runtime = fork.arm.runtime;
            const outcome = runtime === undefined
              ? await this.runArm(fork.arm, fork.env, body, fork.address)
              : await this.withinBoundary({ kind: 'arm', arm: fork.index, body: runtime }, () =>
                  this.runArm(fork.arm, fork.env, body, fork.address),
                );
            settled.set(fork.index, outcome.returned ? outcome.value : NULL_SLOT);
          } catch (e) {
            if (e instanceof RunParked) {
              parked.push(fork);
              return;
            }
            // A quiet scope end (find-on-missing) still COMPLETED — it ran to its
            // end, it just bound less on the way.
            if (!(e instanceof ScopeEndedQuietly)) throw e;
            settled.set(fork.index, NULL_SLOT);
          }
        }),
      ),
    );
    for (const fork of forks) into.push(...fork.frame.trace);
    // An arm that failed fails the combinator — once every other arm has
    // stopped too, so what they did is on the trace and the run's ledger. The
    // failure re-thrown is the earliest ARM's.
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') throw outcome.reason;
    }

    const bindReceipt = (): void => {
      if (bindingName === undefined) return;
      env.declare(bindingName, binding({
        kind: 'tuple',
        slots: forks.map((fork) => settled.get(fork.index) ?? NULL_SLOT),
      }));
    };

    if (expr.kind === 'race') {
      if (settled.size > 0) {
        // Stop listening on every arm still parked at a suspension — one signal
        // per park, and the record behind it stays answerable (F7).
        if (parked.length > 0) {
          await this.input.parkSink?.cancelSubtrees({
            subtreeAddresses: parked.map((fork) => encodeAddress(fork.address)),
          });
        }
        bindReceipt();
        return;
      }
      const frameAddress = encodeAddress(stmtAddress);
      await this.keepArmCount(expr, frameAddress, forks.length);
      await this.input.parkSink?.recordJoin({ frameAddress, parkedChildren: 1 });
      throw new RunParked(frameAddress);
    }

    if (parked.length > 0) {
      const frameAddress = encodeAddress(stmtAddress);
      await this.keepArmCount(expr, frameAddress, forks.length);
      // The arms that already finished keep their slots at the frame, as a
      // resumed arm's export does — the closer builds the receipt from them all.
      for (const fork of forks) {
        const value = settled.get(fork.index);
        if (value === undefined) continue;
        await this.input.parkSink?.persistBranchExport({
          frameAddress,
          branchAddress: encodeAddress(fork.address),
          branchIndex: fork.index,
          exports: { [RETURN_SLOT]: serializeBinding(value, this.newPark()) },
        });
      }
      await this.input.parkSink?.recordJoin({
        frameAddress,
        parkedChildren: parked.length,
      });
      throw new RunParked(frameAddress);
    }
    bindReceipt();
  }

  /** A parked combinator whose arms were built at run time keeps how many
   *  there were — the source cannot say, and the receipt has a slot each. */
  private async keepArmCount(expr: CombinatorExpression, frameAddress: string, arms: number): Promise<void> {
    if (expr.arms.kind !== 'dynamic') return;
    const state: CombinatorFrameState = { arms };
    await this.input.parkSink?.persistBranchExport({
      frameAddress,
      branchAddress: frameAddress,
      branchIndex: FRAME_STATE_INDEX,
      exports: state,
    });
  }

  /**
   * The arms, as bodies to run. A closure written in place captures the scope
   * it is written in; a NAME is looked up — a closure bound earlier keeps its
   * own capture, a movement runs its declaration against the file scope it was
   * declared in. Arms built at run time are a collection of closures, whatever
   * built it.
   *
   * Every arm ends up the same shape, which is what lets one loop run them and
   * one address scheme resume them.
   */
  private async resolveArms(
    expr: CombinatorExpression,
    env: Environment,
  ): Promise<ArmInvocation[]> {
    if (expr.arms.kind === 'dynamic') {
      const evaluated = await this.evaluateSlot(expr.arms.expr, { env });
      const value = evaluated.value;
      const entries = Array.isArray(value) ? value : [value];
      return entries.map((entry, index) => {
        if (!isClosureBinding(entry)) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `arm ${index} of '${expr.kind}' is not a function — a combinator runs what it is given, and this is ${typeof entry}`,
          );
        }
        return { body: entry.closure.body, captured: closureCaptured(entry), runtime: entry.closure };
      });
    }
    return expr.arms.arms.map((arm) => this.armInvocation(arm, expr.kind, env));
  }

  /** One literal arm as a body plus the bindings it brings with it. */
  private armInvocation(
    arm: ArmExpression,
    kind: 'race' | 'parallel',
    env: Environment,
  ): ArmInvocation {
    if (arm.kind === 'closure') {
      // Written in place: it captures the scope around it, which the arm scope
      // is a child of — so there is nothing extra to carry.
      return { body: arm.closure.body };
    }
    const binding = env.resolve(arm.name);
    if (binding?.kind === 'closure') {
      return { body: binding.closure.body, captured: closureCaptured(binding), name: arm.name };
    }
    if (binding?.kind === 'movement') {
      if (binding.declaration.params.length > 0) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${arm.name}' takes ${binding.declaration.params.length} argument(s), and '${kind}' calls its arms with none — the checker should have caught this`,
        );
      }
      // A movement runs against the file scope it was DECLARED in, not the one
      // that named it here — lexical scoping, exactly as a call does.
      const fileEnv = binding.fileEnv ?? this.fileEnv;
      return {
        body: binding.declaration.body,
        name: arm.name,
        ...(fileEnv !== undefined ? { captured: captureScope(fileEnv) } : {}),
      };
    }
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `'${arm.name}' is ${binding ? describeBinding[binding.kind] : 'not in scope'}, and '${kind}' runs its arms — an arm has to be a function. The checker should have caught this.`,
    );
  }

  /** Run one arm in its own branch scope. A park inside it throws `RunParked`
   *  addressed under the arm, which is what makes the arm withdrawable. */
  private async runArm(
    arm: ArmInvocation,
    armEnv: Environment,
    body: BodyContext,
    address: Address,
  ): Promise<BodyOutcome> {
    if (arm.captured !== undefined) {
      for (const [name, binding] of arm.captured) armEnv.declare(name, binding);
    }
    return this.withinNamedCall(arm.name, () => this.interpretBody(arm.body, armEnv, { ...body, address }));
  }

  /**
   * From version 3, refuse a call by name that would nest deeper than the
   * deployment's limit, naming the chain (`call_depth.ts`). The run's own
   * movement is not a call, so the depth is the frames above it.
   */
  private assertCallDepth(callee: string): void {
    const limit = maxCallDepth();
    if (this.callStack.length - 1 < limit) return;
    throw new CallDepthExceeded(limit, [...this.callStack.map((frame) => frame.name), callee]);
  }

  /** Run `fn` as a call of the function named `name` (when there is one, from
   *  version 3): counted towards the call depth, on this flow's stack. */
  private async withinNamedCall<T>(name: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (name !== undefined && since(this.languageVersion, 3)) this.assertCallDepth(name);
    return this.withinCalledName(name, fn);
  }

  /** Run `fn` with the function named `name` on this flow's stack (from
   *  version 3), without measuring it against the limit — what resume uses to
   *  put back a named member's or arm's frame: the call was already made, and
   *  the depth below it must count from where it really is. */
  private async withinCalledName<T>(name: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (name === undefined || before(this.languageVersion, 3)) return fn();
    this.callStack.push({ name });
    try {
      return await fn();
    } finally {
      this.callStack.pop();
    }
  }

  /**
   * `files_to_dropbox(write Files-[:file]-> { … })` — invoke a same-file
   * movement with a position of its parameter's type — same-file or
   * imported from a library (the resolved link supplies the declaration
   * and its library's file environment). Arguments evaluate in the
   * CALLER's scope:
   *   - an inline `write` adapts the argument: a shape target
   *     materialises an in-memory position (no adapter — shapes are
   *     configuration-free graphs); an instance/kg target performs the
   *     write and passes its handle;
   *   - a bare name passes its position binding through (the event, a
   *     handle, a shape position, an extracted entity, a resource).
   * The callee body then interprets with its parameters bound in a
   * FRESH environment whose parent is FILE scope — lexical scoping:
   * caller locals are invisible by construction (the checker enforces
   * it; the environment shape makes it true). The checker also owns
   * arity/type fit — the runtime re-checks arity only as a cheap guard.
   * The callee's effects are its writes, recorded on the same firing
   * record, and provenance flows through naturally because arguments
   * carry their trails.
   *
   * Every call also has a VALUE: the node the callee's top-level
   * A call's value is what the callee RETURNED — undefined when it returned
   * binds it. Effects are unchanged — the value is additional.
   */
  // ── Nested calls (movement-lang checker/nested_calls.ts) ──
  //
  // A call written inside an expression — `f(x) + 1`, `ONLY(extract(c, S))`,
  // `COUNT(MAP(xs, g))` — that the shared evaluator cannot run means what
  // binding it to a fresh name first and reading the name means. The split:
  //
  //   - the shared evaluator runs every PURE part of the expression, as it
  //     always has (lowered to the shared `Expression`);
  //   - this engine runs each nested call, through the same path a binding of
  //     it takes (`declareAssign`), into a scratch scope under a name only the
  //     engine can spell (`#…`), and the expression reads the name.
  //
  // Order is the text's: an operator's operands are read left to right, every
  // operand up to the last one holding a nested call is settled to a value
  // before the next is touched, and a call's arguments are evaluated before
  // its body runs (`executeCall` evaluates them in order). `AND`, `OR`, `IF`
  // and `COALESCE` short-circuit: an operand they do not need is never
  // reached, so a call in it never runs. What is left is pure, and evaluates
  // over the settled names exactly as it would have over the values.
  //
  // A call that may wait is refused nested by the checker; the engine may still
  // suspend inside one (`suspendFlow`), and the call's `c k` step on its
  // statement is what brings a resume back into it.

  // ── Calls as a statement's steps (address `call k`) ──
  //
  // Every call a statement makes — a movement / function / closure / plugin
  // call, an `extract(…)`, a collection op — is numbered in the order the
  // statement makes it. What runs inside the k-th (a callee's body, an op's
  // members) is addressed under `<statement>.c<k>`, and what it handed back is
  // kept on the statement. A statement is only ever resumed by RE-RUNNING it:
  // its finished calls hand back the kept value instead of running again, and
  // the call a park was inside hands back what its resumed body returned.

  /** Open the running statement's next call — or, when the statement is a
   *  re-run, take the value the call had already handed back. */
  private async beginCall(): Promise<CallEvent> {
    const site = this.statementSites.getStore();
    if (site === undefined) return { site, index: 0 };
    const index = site.calls.next;
    const replayed = site.calls.replay?.get(index);
    if (replayed !== undefined) {
      site.calls.next = replayed.next;
      site.calls.completed.set(index, replayed);
      return { site, index, replayed };
    }
    if (
      this.input.suspendWhen?.({
        kind: 'call',
        address: encodeAddress(childCall(site.stmtAddress, index)),
      })
    ) {
      await this.suspendFlow();
    }
    site.calls.next += 1;
    return { site, index };
  }

  /** Keep what a call handed back on its statement. */
  private finishCall(event: CallEvent, value: Binding | undefined): Binding | undefined {
    event.site?.calls.completed.set(event.index, { value, next: event.site.calls.next });
    return value;
  }

  /** The address what runs inside a call is under. */
  private callAddress(event: CallEvent, body: BodyContext): Address {
    return childCall(event.site?.stmtAddress ?? body.address, event.index);
  }

  /** Run `fn` inside one more body boundary. */
  private withinBoundary<T>(boundary: LiveBoundary, fn: () => Promise<T>): Promise<T> {
    return this.boundaries.run([...(this.boundaries.getStore() ?? []), boundary], fn);
  }

  /** A park's state, with the body boundaries it is inside — absent when it
   *  is inside none, so such a park reads exactly as one always has. */
  private parkedState(write: (park: ParkWriter) => ParkedScopeState): ParkedScopeState {
    // One table for the whole state: a node held both in a frame's scopes and
    // the leaf's is written once, and resumes as one.
    const park = this.newPark();
    const live = this.boundaries.getStore() ?? [];
    // The frames' chains are written after the leaf's: a closure the leaf
    // reaches that holds one of their scopes names it, rather than writing it.
    for (const boundary of live) {
      if (boundary.kind !== 'arm') carriesChain(park, boundary.site.env.chainFromRoot());
    }
    const state = write(park);
    if (live.length === 0) return state;
    return { ...state, frames: live.map((boundary) => serializeBoundary(boundary, park)) };
  }

  /**
   * ENGINE-INITIATED SUSPENSION: park the running flow just before its current
   * statement. Resume re-runs that statement (`reenter`), replaying the calls it
   * had already finished, so nothing it did is done twice. Other flows are
   * untouched — a concurrent member or arm parks only if it suspends too.
   *
   * Callable from anywhere inside a statement's evaluation (a run limit's check
   * before a priced call is the intended caller). What it cannot undo is work the
   * statement did outside its calls before the suspension: the calls are the
   * statement's only replayable steps.
   */
  private async suspendFlow(): Promise<never> {
    const site = this.statementSites.getStore();
    if (site === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        'the run was asked to suspend outside any statement, where there is nothing to resume',
      );
    }
    const address = encodeAddress(site.stmtAddress);
    const commit = this.input.parkSink?.commitSuspension?.bind(this.input.parkSink);
    if (commit === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `the run was asked to suspend at '${address}' and has nowhere durable to park`,
      );
    }
    const state = this.parkedState((park) => ({
      version: 1,
      address,
      bindingName: null,
      suspended: true,
      // Every call the statement has handed back, including those a re-run had
      // yet to replay — a statement suspended again on re-entry keeps them all.
      journal: serializeCallRecords(new Map([...(site.calls.replay ?? []), ...site.calls.completed]), park),
      scopeChain: serializeScopeChain(site.env.chainFromRoot(), park),
    }));
    await commit({ address, state });
    this.trace.push({ kind: 'gate', outcome: false });
    throw new RunParked(address);
  }

  /** Whether this flow can suspend here: inside a statement, with somewhere
   *  durable to park, and somewhere a resume can get back to. A rehearsal has
   *  no park sink and a callback body no way back: both meet the cap as a
   *  failure. */
  private canSuspend(): boolean {
    return (
      !this.firingCallback
      && this.statementSites.getStore() !== undefined
      && this.input.parkSink?.commitSuspension !== undefined
    );
  }

  /**
   * The run met its cost cap in this flow, at the statement about to spend.
   * Pause the whole run — every other flow stops at its next statement boundary
   * (`limitPaused`) — and suspend this one before the statement. The first flow
   * to meet the cap marks the run paused and says so; resuming the run resumes
   * every suspended flow together, with its usage reset (`limit_pause.ts`).
   * `onError` never sees the cap: it suspends before any member could fail.
   */
  private async suspendAtLimit(error: RunCostCapExceeded): Promise<never> {
    if (!this.limitPaused) {
      // Set before the await, so flows meeting the cap together pause it once.
      this.limitPaused = true;
      await this.input.parkSink?.commitLimitPause?.({
        limit: 'cost',
        capMicrodollars: error.capMicrodollars,
        spentMicrodollars: error.spentMicrodollars,
      });
      this.trace.push({ kind: 'warning', code: 'RUN_PAUSED_COST_CAP', message: runPausedMessage(error) });
    }
    return this.suspendFlow();
  }

  /**
   * `box.g()` (language version 5): the member a value holds under a key, as
   * the callee — read as `box.g` reads, and called when it is a closure (the
   * checker's `memberCallee`). Undefined for any other callee.
   */
  private async memberCallee(
    statement: Extract<Statement, { kind: 'call' }>,
    env: Environment,
  ): Promise<Binding | undefined> {
    if (before(this.languageVersion, 5) || !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(statement.callee)) return undefined;
    if (env.resolve(statement.callee.split('.')[0]!)?.kind !== 'value') return undefined;
    const { value } = await this.evaluateSlot({ raw: statement.callee, span: statement.span }, { env });
    return bindingOf(value);
  }

  /** Whether a call in an expression is one this engine runs. */
  private runsAsCall(call: CallNode, env: Environment): boolean {
    const scope = this.callScope(env);
    return runsAsCall(
      call,
      (callee) => resolveCallee(callee, scope, this.languageVersion),
      (declared) => {
        const binding = env.resolve(declared);
        return binding !== undefined && isCallableBinding(binding);
      },
      // `box.g()` (language version 5): a dotted call on a value calls the
      // member it holds — run first, as any call in an expression is.
      (object) => since(this.languageVersion, 5) && env.resolve(object)?.kind === 'value',
    );
  }

  /**
   * A slot holding nested calls, with those calls run: the slot reading the
   * names they were bound to, and the scope those names are in. Undefined when
   * the slot holds none — before language version 3 nothing nests.
   */
  private async stageNestedCalls(
    slot: ExprSlot,
    env: Environment,
  ): Promise<{ slot: ExprSlot; env: Environment } | undefined> {
    if (before(this.languageVersion, 3)) return undefined;
    let tree: MExpr;
    try {
      tree = treeOfSlot(slot);
    } catch {
      return undefined; // the evaluator reports the syntax error
    }
    const runs = hoistingMemberReads(tree, (call) => this.runsAsCall(call, env));
    if (!holdsNestedCall(tree, runs)) return undefined;
    const scope = this.callScope(env);
    const staging: NestedCallStaging = {
      slot,
      scratch: env.child(),
      runs,
      isCoalesce: (callee) => {
        const resolved = resolveCallee(callee, scope, this.languageVersion);
        return resolved.kind === 'builtin' && resolved.builtin.name === 'COALESCE';
      },
      bound: 0,
    };
    const staged = await this.stageTree(tree, staging);
    return { slot: slotOfTree(slot, staged), env: staging.scratch };
  }

  /** `tree` with its nested calls run, in order — what is left is pure. */
  private async stageTree(tree: MExpr, staging: NestedCallStaging): Promise<MExpr> {
    if (!holdsNestedCall(tree, staging.runs)) return tree;
    if (tree.kind === 'call' && staging.runs(tree)) return this.settleNestedCall(tree, staging);
    const short = shortCircuitOf(tree, staging.isCoalesce);
    if (short !== undefined) return this.bindSettled(await this.settleShortCircuit(short, staging), tree, staging);
    const operands = valueChildren(tree);
    let last = -1;
    operands.forEach((operand, index) => {
      if (holdsNestedCall(operand, staging.runs)) last = index;
    });
    const settled = new Map<MExpr, MExpr>();
    for (const operand of operands.slice(0, last + 1)) {
      settled.set(operand, this.bindSettled(await this.settledBinding(operand, staging), operand, staging));
    }
    return withValueChildren(tree, (operand) => settled.get(operand));
  }

  /** One nested call, run as the right-hand side of a binding. */
  private async settleNestedCall(call: CallNode, staging: NestedCallStaging): Promise<MExpr> {
    let value: RValue;
    try {
      value = parseNestedCall(staging.slot, call.at, this.languageVersion);
    } catch (e) {
      if (e instanceof MovementParseError) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `invalid nested call (the checker should have caught this): ${e.message}`,
        );
      }
      throw e;
    }
    const site = this.statementSites.getStore() ?? {
      body: { atAnchor: false, address: ROOT_ADDRESS },
      stmtAddress: ROOT_ADDRESS,
    };
    const name = this.nestedBindingName(staging);
    await this.declareAssign(name, value, staging.scratch, site.body, site.stmtAddress);
    return nameNode(name, call.at);
  }

  /** `AND` / `OR` / `IF` / `COALESCE`, reaching only the operands it needs. */
  private async settleShortCircuit(short: ShortCircuit, staging: NestedCallStaging): Promise<Binding> {
    const constant = (value: unknown): Binding => binding({ kind: 'value', value, provenance: NO_PROVENANCE });
    switch (short.kind) {
      case 'and':
      case 'or': {
        const left = bindingTruthy(await this.settledBinding(short.left, staging));
        if (short.kind === 'and' ? !left : left) return constant(left);
        return constant(bindingTruthy(await this.settledBinding(short.right, staging)));
      }
      case 'if': {
        const taken = bindingTruthy(await this.settledBinding(short.condition, staging));
        if (taken) return this.settledBinding(short.then, staging);
        // An IF with no ELSE is the empty text there, as the lowering reads it.
        return short.else !== undefined ? this.settledBinding(short.else, staging) : constant('');
      }
      case 'coalesce': {
        for (const arg of short.args) {
          const binding = await this.settledBinding(arg, staging);
          if (bindingPresent(binding)) return binding;
        }
        return constant(null);
      }
      default:
        return neverAsAny(short);
    }
  }

  /** A sub-expression's binding, with its nested calls run first. */
  private async settledBinding(expr: MExpr, staging: NestedCallStaging): Promise<Binding> {
    const staged = await this.stageTree(expr, staging);
    return this.bindSlotValue(slotOfTree(staging.slot, staged), staging.scratch);
  }

  /** `binding` under a fresh name, read where `at` was written. */
  private bindSettled(binding: Binding, at: MExpr, staging: NestedCallStaging): MExpr {
    const name = this.nestedBindingName(staging);
    staging.scratch.declare(name, binding);
    return nameNode(name, at.at);
  }

  /** A name only the engine can spell (`#`, as `RETURN_SLOT`'s), unique in
   *  its scratch scope. */
  private nestedBindingName(staging: NestedCallStaging): string {
    staging.bound += 1;
    return `#nested ${staging.bound}`;
  }

  /** A condition holding nested calls: its top-level `AND` conjuncts in order,
   *  each with its own nested calls run only once the ones before it held. */
  private async evaluateStagedCondition(slot: ExprSlot, env: Environment): Promise<boolean | undefined> {
    if (before(this.languageVersion, 3)) return undefined;
    let tree: MExpr;
    try {
      tree = treeOfSlot(slot);
    } catch {
      return undefined;
    }
    if (!holdsNestedCall(tree, hoistingMemberReads(tree, (call) => this.runsAsCall(call, env)))) return undefined;
    for (const conjunct of conjunctsOf(tree)) {
      const part = slotOfTree(slot, conjunct);
      const staged = await this.stageNestedCalls(part, env);
      if (!(await this.evaluateCondition(staged?.slot ?? part, staged?.env ?? env))) return false;
    }
    return true;
  }

  // ── Call resolution (movement-lang checker/calls.ts) ──

  /** What a call site can see: the environment, asked exactly, and its
   *  functions in any letter case. The standard library is `resolveCallee`'s. */
  private callScope(env: Environment): CallScope {
    return {
      binds: (name) => env.resolve(name) !== undefined,
      functionSpelled: (name) => env.resolveFunction(name),
    };
  }

  /** How a call reads where it is written — the checker's reading, over this
   *  run's scope. A refusal is the checker's to have reported. */
  private readCallIn(call: CallStatement, env: Environment, position: CallPosition): CallReading {
    const scope = this.callScope(env);
    const reading = readCall(call, (callee) => resolveCallee(callee, scope, this.languageVersion), position);
    if (reading.kind === 'refused') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${reading.refusal.message} — the checker should have caught this`,
      );
    }
    return reading;
  }

  /** A bound or returned call to a built-in, as the form it resolved to;
   *  every other right-hand side unchanged. */
  private resolvedRValue(value: RValue, env: Environment): RValue {
    if (value.kind !== 'call') return value;
    const reading = this.readCallIn(value.call, env, 'value');
    switch (reading.kind) {
      case 'function':
        return value;
      case 'value':
        return { kind: 'expr', expr: reading.expr };
      case 'collection':
        return { kind: 'collection', collection: reading.collection };
      case 'members':
        return { kind: 'members', members: reading.members };
      case 'refused':
        // `readCallIn` threw.
        return value;
    }
  }

  /** The name a callee was DECLARED with — from version 3 a function's call
   *  may spell it in another letter case. */
  private calleeName(written: string, env: Environment): string {
    const resolved = resolveCallee(written, this.callScope(env), this.languageVersion);
    return resolved.kind === 'declared' ? resolved.name : written;
  }

  private async executeCall(
    statement: Extract<Statement, { kind: 'call' }>,
    env: Environment,
    body: BodyContext,
  ): Promise<Binding | undefined> {
    const event = await this.beginCall();
    if (event.replayed !== undefined) return event.replayed.value;
    return this.finishCall(event, await this.runCall(statement, env, body, event));
  }

  /** Run the body a call boundary leads into, inside that boundary — so a park
   *  below it records how to get back. A call made outside any statement has
   *  no statement to be re-run by, and runs as it always did. */
  private enterCallee<T>(
    event: CallEvent,
    callee: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (event.site === undefined) return fn();
    return this.withinBoundary(
      { kind: 'call', site: event.site, index: event.index, next: event.site.calls.next, callee },
      fn,
    );
  }

  private async runCall(
    statement: Extract<Statement, { kind: 'call' }>,
    env: Environment,
    body: BodyContext,
    event: CallEvent,
  ): Promise<Binding | undefined> {
    const calleeName = this.calleeName(statement.callee, env);
    const callee = env.resolve(calleeName) ?? (await this.memberCallee(statement, env));
    if (callee?.kind !== 'movement') {
      // One function sort: a plugin is a function whose body isn't visible, so
      // a call on one is an ordinary call and its value is what the plugin
      // declared it hands back.
      if (callee?.kind === 'plugin') {
        return this.executePluginCall(statement, callee.plugin, env, body);
      }
      // A closure bound to a name is a function too (language version 3).
      if (callee?.kind === 'closure' && since(this.languageVersion, 3)) {
        return this.executeClosureCall(statement, callee, env, body, event);
      }
      if (callee?.kind === 'opaque') {
        throw unsupported(
          `calling the import '${statement.callee}'`,
          'this run has no file resolver — pass resolveFile to runMovement (or declare the movement in this file)',
        );
      }
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${statement.callee}' is ${callee ? describeBinding[callee.kind] : 'not in scope'}, not a callable movement — the checker should have caught this`,
      );
    }
    const declaration = callee.declaration;
    // Before version 3 a call to a movement already running is refused; from
    // it, recursion is allowed and bounded by the call depth (`call_depth.ts`).
    if (before(this.languageVersion, 3)) {
      if (this.callStack.some((frame) => frame.declaration === declaration)) {
        throw unsupported(
          `recursive movement calls ('${[...this.callStack.map((d) => d.name), declaration.name].join(' → ')}')`,
        );
      }
    } else {
      this.assertCallDepth(declaration.name);
    }
    if (statement.args.length !== declaration.params.length) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${declaration.name}' takes ${declaration.params.length} argument(s), got ${statement.args.length} — the checker should have caught this`,
      );
    }
    if (!this.fileEnv) {
      throw new MovementEngineError('MOVENG_RUNTIME', 'no file scope for a movement call');
    }
    // An imported callee forks from ITS library's file scope; a same-file
    // callee forks from the running file's — lexical scoping either way.
    const calleeEnv = (callee.fileEnv ?? this.fileEnv).child();
    // Arguments bind by name or by declared order (`argumentBindings`, the
    // checker's own projection) and evaluate in the caller's source order —
    // an inline write argument is an effect, and effects run in the order the
    // text states them.
    const params = new Map(declaration.params.map((param) => [param.name, param]));
    // A parameter typed by a refinement names one declared in the CALLEE's file.
    const calleeTypes = this.typesIn(callee.fileEnv ?? this.fileEnv);
    const evaluated = new Map<string, Binding>();
    for (const { arg, param } of argumentBindings(statement.args, [...params.keys()])) {
      const declared = param !== undefined ? params.get(param) : undefined;
      if (param === undefined || declared === undefined) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${declaration.name}' has no parameter ${arg.name !== undefined ? `'${arg.name}'` : 'for this argument'} — the checker should have caught this`,
        );
      }
      evaluated.set(
        param,
        await this.evaluateCallArg(arg, env, body, { takesValue: isValueParam(declared, calleeTypes) }),
      );
    }
    for (const param of declaration.params) {
      const binding = evaluated.get(param.name);
      if (!binding) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${declaration.name}' call supplies no argument '${param.name}' — the checker should have caught this`,
        );
      }
      calleeEnv.declare(param.name, binding);
    }
    this.callStack.push({ name: declaration.name, declaration });
    const callerBody = this.movementBody;
    this.movementBody = declaration.body;
    let outcome: BodyOutcome = FELL_THROUGH;
    try {
      // A call re-roots the position (2_model.md "Composition") — the
      // callee runs OFF the trigger's anchor, so anchor-only bridge
      // synthesis stays with the dispatched movement's own body. Its body's
      // address is this call's step of the calling statement (`s… .c k`).
      outcome = await this.enterCallee(event, calleeName, () =>
        this.interpretBody(declaration.body, calleeEnv, {
          atAnchor: false,
          address: this.callAddress(event, body),
        }),
      );
    } catch (e) {
      // Find-on-missing inside a callee: the callee's scope is the one
      // that ends — the caller continues after the call. What it bound
      // BEFORE ending is still its value; a scope that stopped early made
      // fewer bindings, which is what the caller reads.
      if (!(e instanceof ScopeEndedQuietly)) throw e;
    } finally {
      this.movementBody = callerBody;
      this.callStack.pop();
    }
    return outcome.returned ? outcome.value : undefined;
  }

  /**
   * `f(3)` where `f` names a closure — called as a movement is: arguments bind
   * by name or by order and evaluate in the caller's source order, the body
   * runs in the closure's captured scope, and its value is what it returns.
   * The body's statements take addresses under this call's step of the
   * calling statement, so a park inside it resumes there.
   */
  private async executeClosureCall(
    statement: Extract<Statement, { kind: 'call' }>,
    closure: Extract<Binding, { kind: 'closure' }>,
    env: Environment,
    body: BodyContext,
    event: CallEvent,
  ): Promise<Binding | undefined> {
    const params = new Map(closure.closure.params.map((param) => [param.name, param]));
    // From version 5 a closure stands where a closure type is expected when it
    // takes FEWER parameters than the type supplies (TypeScript's rule), so a
    // call through the type may hand it more arguments than it declares: they
    // are evaluated, in order, and dropped, as JavaScript drops them.
    const extra = since(this.languageVersion, 5) && isPositionalCall(statement.args) && statement.args.length > params.size
      ? statement.args.slice(params.size)
      : [];
    if (extra.length > 0) statement = { ...statement, args: statement.args.slice(0, params.size) };
    if (statement.args.length !== params.size) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${statement.callee}' takes ${params.size} argument(s), got ${statement.args.length} — the checker should have caught this`,
      );
    }
    const types = this.typesIn(env);
    const values: Record<string, Binding> = {};
    for (const { arg, param } of argumentBindings(statement.args, [...params.keys()])) {
      const declared = param !== undefined ? params.get(param) : undefined;
      if (param === undefined || declared === undefined) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${statement.callee}' has no parameter ${arg.name !== undefined ? `'${arg.name}'` : 'for this argument'} — the checker should have caught this`,
        );
      }
      // A parameter with no written type (language version 5) is typed by
      // where the closure is handed — a closure type's parameter — and takes
      // whatever the argument evaluates to, a record included.
      const untyped = declared.type === undefined && since(this.languageVersion, 5);
      values[param] = await this.evaluateCallArg(arg, env, body, { takesValue: untyped || isValueParam(declared, types) });
    }
    for (const arg of extra) await this.evaluateCallArg(arg, env, body, { takesValue: true });
    let outcome: BodyOutcome = FELL_THROUGH;
    const calleeName = this.calleeName(statement.callee, env);
    try {
      outcome = await this.enterCallee(event, calleeName, () =>
        this.withinNamedCall(calleeName, () =>
          this.invokeClosure(closure, values, { ...body, address: this.callAddress(event, body) }),
        ),
      );
    } catch (e) {
      // Find-on-missing inside the closure ends the closure's scope, as it
      // ends a called movement's; the caller continues after the call.
      if (!(e instanceof ScopeEndedQuietly)) throw e;
    }
    return outcome.returned ? outcome.value : undefined;
  }

  /**
   * `page = fetch_url(url: c.website)` — a plugin called plainly. The arguments
   * are evaluated in the caller's source order like any other call's, handed to
   * the plugin as its config, and what comes back is bound as the DECLARED
   * output: a value on the dot plane, or a node whose reads are the fields the
   * plugin declared.
   *
   * The invocation has two channels — the text it fetched and the properties it
   * attached — and the declaration is what says which of them the bound name
   * IS. A `value` output is the text; a `record` output reads the properties,
   * with the fetched text under `text` for the plugins that declare it, since a
   * plugin that fetched a page and had no way to hand it back would be throwing
   * away most of what it did; a `records` output is one record per thing it
   * fetched.
   */
  private async executePluginCall(
    statement: Extract<Statement, { kind: 'call' }>,
    plugin: string,
    env: Environment,
    body: BodyContext,
  ): Promise<Binding | undefined> {
    const invoker = this.input.transformInvoker ?? registryTransformInvoker;
    const declared = invoker.declaredOutput?.(plugin);
    if (declared === undefined) {
      // The checker refuses a plain call to a plugin that declared no output,
      // so reaching here means the two disagree — which is worth saying, not
      // guessing past.
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${statement.callee}' declares no output, so there is nothing a call to it can hand back — the checker should have caught this`,
      );
    }
    if (isPositionalCall(statement.args)) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${statement.callee}' is a plugin, and a plugin's arguments are named — the checker should have caught this`,
      );
    }
    const config: Record<string, unknown> = {};
    const trails: Provenance[] = [];
    for (const arg of statement.args) {
      if (arg.name === undefined) continue; // refused above: never positional
      if (arg.kind === 'write' || arg.kind === 'closure' || arg.kind === 'type') {
        // A plugin's parameters are values: a write is an effect, and a
        // function or a type is no value yet. The checker refuses each.
        throw unsupported(
          `a ${arg.kind} argument to the plugin '${statement.callee}'`,
          'a plugin takes values — pass a field or an expression',
        );
      }
      const { value, provenance } = await this.pluginArgValue(arg, env, body);
      // A record reaches only an argument declared to take structured data
      // (the checker refuses it anywhere else), and what that takes is the
      // record's fields.
      const record = bindingOf(value);
      config[arg.name] = record !== undefined ? recordFields(record) : value;
      trails.push(provenance);
    }
    const started = Date.now();
    const result = await invokePricedTransform(invoker, { plugin, config, extractedContext: {} });
    // What the plugin brought back is no longer justified by the quote that
    // pointed at it, so the origins survive and the direct citation does not.
    // The shape the movement's pin gets — a plugin whose output changed keeps
    // its older shape for movements pinned before the change.
    const { binding, handedBack } = pluginCallBinding(
      transformOutputUnder(declared, this.languageVersion),
      result,
      transformed(unionProvenance(trails)),
    );
    const fields = Object.keys(result.data ?? {});
    this.trace.push({
      kind: 'plugin',
      plugin,
      ...(typeof config.url === 'string' ? { url: tracedUrl(config.url) } : {}),
      durationMs: Date.now() - started,
      ...(result.text ? { chars: result.text.length } : {}),
      ...(fields.length > 0 ? { fields } : {}),
      ...(result.outcome ? { outcome: result.outcome } : {}),
      returned: handedBack ? 'value' : 'absent',
    });
    return binding;
  }

  /** A plugin argument's value: what `v = <argument>` would bind, read back
   *  as `v` is. A call (a built-in's or a function's) or a node literal
   *  evaluates exactly as it does as a function's value argument. */
  private async pluginArgValue(
    arg: Extract<CallArg, { kind: 'expr' | 'call' | 'node' }>,
    env: Environment,
    body: BodyContext,
  ): Promise<{ value: unknown; provenance: Provenance }> {
    if (arg.kind === 'expr') return this.evaluateSlot(arg.expr, { env });
    const bound = await this.evaluateCallArg(arg, env, body, { takesValue: true });
    return bound.kind === 'value'
      ? { value: bound.value, provenance: bound.provenance ?? NO_PROVENANCE }
      : { value: bound, provenance: NO_PROVENANCE };
  }

  private async evaluateCallArg(
    arg: CallArg,
    env: Environment,
    body: BodyContext,
    options: { takesValue: boolean },
  ): Promise<Binding> {
    // A VALUE parameter (`<text>`, `<Thesis>`, `<text[]>`, `<{ … }>`) takes
    // what the argument evaluates to — any expression, as a closure's
    // parameter does. Only a POSITION parameter is held to positions below.
    if (arg.kind === 'expr' && options.takesValue) {
      const { value, provenance } = await this.evaluateSlot(arg.expr, { env });
      return bindValue(value, provenance);
    }
    if (arg.kind === 'write') {
      return this.executeWrite(arg.write, undefined, env, body);
    }
    if (arg.kind === 'node') {
      return this.synthesiseNode(arg.node, env);
    }
    if (arg.kind === 'call') {
      // A built-in called here (`log(UPPER(x))`) is the value it computes —
      // an ordinary expression argument.
      const reading = this.readCallIn(arg.call, env, 'argument');
      if (reading.kind === 'value') {
        return this.evaluateCallArg(
          { kind: 'expr', ...(arg.name !== undefined ? { name: arg.name } : {}), expr: reading.expr },
          env,
          body,
          options,
        );
      }
      // The utility idiom — the nested call runs (its effects are its own) and
      // its value is what this argument passes on.
      return requireCallValue(arg.call.callee, await this.executeCall(arg.call, env, body));
    }
    if (arg.kind === 'closure' && options.takesValue && since(this.languageVersion, 5)) {
      // A closure is a value (language version 5): written in place as an
      // argument it is (AST, scope), holding the scope it is written in by
      // reference, as a list element closure does.
      return binding({ kind: 'closure', closure: arg.closure, captured: new Map(), env });
    }
    if (arg.kind === 'closure' || arg.kind === 'type') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `a ${arg.kind === 'closure' ? 'function' : 'type'} handed to a function's parameter — the checker should have caught this`,
      );
    }
    // A POSITION parameter takes the record the argument is bound to — the
    // binding `x = <argument>` would make, whatever path produced the record
    // (a name, a pick, a map field).
    const bound = await this.bindSlotValue(arg.expr, env);
    switch (bound.kind) {
      case 'event':
      case 'handle':
      case 'shapePosition':
      case 'extractRoot':
      case 'extractPosition':
      case 'sourcePosition':
      case 'resource':
      case 'nodePosition':
      case 'lazyWalk':
        return bound;
      default:
        throw unsupported(
          `passing ${describeBinding[bound.kind]} ('${arg.expr.raw.trim()}') as a movement argument`,
          'arguments are positions — pass the event, a write handle, or adapt with an inline shape-write',
        );
    }
  }

  private async interpretIf(
    statement: Extract<Statement, { kind: 'if' }>,
    env: Environment,
    body: BodyContext,
  ): Promise<BodyOutcome> {
    for (let armIndex = 0; armIndex < statement.arms.length; armIndex++) {
      const arm = statement.arms[armIndex];
      const taken = await this.evaluateCondition(arm.condition, env);
      this.trace.push({ kind: 'gate', outcome: taken });
      if (taken) {
        // The taken arm is `branch k` of this `if` (§4.3 — each arm is a branch).
        // An arm is transparent to `return`: its outcome is the enclosing
        // body's, which is what makes the guard clause read as it does in TS.
        return this.interpretBody(arm.body, env.child(), {
          ...body,
          address: childBranch(body.address, armIndex),
        });
      }
    }
    if (statement.elseArm) {
      // The else arm follows the explicit arms (branch index = arm count).
      return this.interpretBody(statement.elseArm.body, env.child(), {
        ...body,
        address: childBranch(body.address, statement.arms.length),
      });
    }
    return FELL_THROUGH;
  }

  // ── Timer parks ──

  /**
   * `await sleep(<duration>)` — durably park this branch for a fixed interval,
   * then resume (the wake driver, §4). Mirrors `interpretAsk`'s scope
   * serialisation — `serializeScopeChain(env.chainFromRoot())` captures the
   * full lexical scope feeding this point — but the durable park is a TIMER
   * park: no `interaction_request`, no answer, just an absolute `wake_at`.
   * Throwing `RunParked` freezes the branch here (exactly like `ask`/cost), so
   * a fan-out counts this leaf into `join_pending` and every branch parks at
   * its own sleep.
   *
   * Under `dryRun` we never park — a simulated run has no wall clock to wait on —
   * so we narrate the fast-forward and continue past the statement immediately.
   */
  private async interpretSleep(
    sleep: { duration: DurationLiteral },
    stmtAddress: Address,
    env: Environment,
    /** When the sleep is `<name> = await sleep(…)` (chunk C): the name to bind a
     *  PRESENCE marker at wake, so the completed branch escapes it onto a race
     *  receipt as an edge (`r-[:expired]->`, S4). Undefined ⇒ a value-less sleep. */
    presenceBindingName?: string,
  ): Promise<void> {
    if (this.input.dryRun) {
      logger.info(`slept ${sleep.duration.raw} (fast-forwarded)`);
      return;
    }
    const parkSink = this.input.parkSink;
    const address = encodeAddress(stmtAddress);
    if (!parkSink) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `sleep reached at '${address}' with no park sink — the run cannot suspend on a timer without the durable trigger-run substrate`,
      );
    }
    const state = this.parkedState((park) => ({
      version: 1,
      address,
      // A plain sleep binds nothing — the leaf re-enters AT the un-run
      // continuation, no value injected. An `await sleep` WITH a binding carries
      // the name + `presenceBind` so resume declares a presence marker at wake.
      bindingName: presenceBindingName ?? null,
      ...(presenceBindingName !== undefined ? { presenceBind: true } : {}),
      scopeChain: serializeScopeChain(env.chainFromRoot(), park),
    }));
    const wakeAt = new Date(Date.now() + durationToMs(sleep.duration.raw));
    await parkSink.commitTimerPark({ address, state, wakeAt });
    this.trace.push({ kind: 'gate', outcome: false });
    throw new RunParked(address);
  }

  // ── callback (the deferred, addressable invocation) ──

  /**
   * `cb = callback(<subject>, { once, ttl })` — MINT. The body is not run now;
   * what happens now is a CAPTURE: the enclosing scope chain is serialized with
   * the park machinery's own serializer (a callback body IS a parked
   * continuation with a different entry point — JS closure semantics, which is
   * the park's capture rule verbatim), and stored against this callback
   * expression's canonical lexical address. A fire resumes the run there.
   *
   * The binding it yields is checker-local: `.id` (the payload every platform
   * button carries) and `.url` (the human link), plus a `Called` edge read live
   * from the ledger.
   *
   */
  private async mintCallback(
    callback: CallbackExpression,
    env: Environment,
    stmtAddress: Address,
  ): Promise<Binding> {
    const sink = this.input.callbackSink;
    if (!sink) {
      throw unsupported(
        'callback(…)',
        'this run has no callback sink — a callback needs the durable trigger-run substrate',
      );
    }
    const address = encodeAddress(stmtAddress);
    const params = this.callbackParams(callback.subject, env);
    const config = await this.callbackConfig(callback, env);
    // The CAPTURE. Same shape a park writes, so resume-at-entry is the resume
    // path with a different leaf rule and nothing bespoke to keep in step.
    const state = this.parkedState((park) => ({
      version: 1,
      address,
      // A callback binds nothing at fire time beyond its parameters, which the
      // fire binds into a child scope of this one.
      bindingName: null,
      scopeChain: serializeScopeChain(env.chainFromRoot(), park),
    }));
    const minted = await sink.mint({
      address,
      params,
      state,
      singleUse: config.singleUse,
      ...(config.expiresAt !== undefined ? { expiresAt: config.expiresAt } : {}),
    });
    return binding({
      kind: 'callback',
      callbackId: minted.id,
      url: minted.url,
      params,
    });
  }

  /**
   * A callback's FIRE-TIME signature — the values a platform supplies when it
   * fires, in DECLARATION order (which is the order the `Called` landing's
   * fields and the confirm page's controls take).
   *
   * Inline: every declared parameter. Named: the callee's parameters MINUS the
   * ones the author fixed as arguments — an unsupplied parameter is not
   * missing, it is deferred (the checker types it the same way).
   */
  private callbackParams(subject: CallbackSubject, env: Environment): CallbackParamSpec[] {
    const declared =
      subject.kind === 'inline'
        ? subject.closure.params
        : (() => {
            const binding = env.resolve(this.calleeName(subject.movement, env));
            if (binding?.kind !== 'movement') {
              throw new MovementEngineError(
                'MOVENG_RUNTIME',
                `callback(${subject.movement}): '${subject.movement}' is not a movement in scope — the checker should have caught this`,
              );
            }
            const supplied = new Set(
              argumentBindings(subject.args, binding.declaration.params.map((p) => p.name)).map((b) => b.param),
            );
            const deferred = binding.declaration.params.filter((p) => !supplied.has(p.name));
            if (deferred.length > 0) {
              // The named form's fire-time binding is not built (a movement
              // parameter is a record position today, so nothing a platform
              // sends can fill one). Refuse AT MINT rather than minting a
              // callback that could only ever fail when tapped.
              throw unsupported(
                `callback(${subject.movement}(…)) leaving '${deferred.map((p) => p.name).join("', '")}' unsupplied`,
                'a named callback binds no values at fire time yet — supply every argument, or use the inline form (`callback((x: <text>) => { … })`)',
              );
            }
            return deferred;
          })();

    return declared.map((param) => {
      // The checker refuses a record position here (no platform can hand us
      // one), so anything unrecognised is a checker escape — say so loudly
      // rather than defaulting the type and mis-coercing at fire time.
      const type = typeNameOf(param.type);
      if (type === undefined || !isCallbackParamType(type.graph) || type.hopsRaw !== undefined) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `a callback's parameter '${param.name}' must be a scalar type, got '<${param.type !== undefined ? spellParamType(param.type) : '?'}>' — the checker should have caught this`,
        );
      }
      return { name: param.name, type: type.graph };
    });
  }

  /** `{ once: <boolean>, ttl: <duration> }` — the config. `once` DEFAULTS TRUE,
   *  and the default lives here (the engine owns it) rather than in the AST. */
  private async callbackConfig(
    callback: CallbackExpression,
    env: Environment,
  ): Promise<{ singleUse: boolean; expiresAt?: Date }> {
    let singleUse = true;
    let expiresAt: Date | undefined;
    for (const entry of callback.config) {
      switch (entry.name) {
        case 'once': {
          const { value } = await this.evaluateSlot(entry.value, { env });
          singleUse = value !== false;
          break;
        }
        case 'ttl':
          // Checker-validated duration literal, so the raw spelling parses.
          expiresAt = new Date(Date.now() + durationToMs(entry.value.raw.trim()));
          break;
        default:
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `'${entry.name}' is not a callback setting — the checker should have caught this`,
          );
      }
    }
    return { singleUse, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  }

  /** The `Called` landing — `At` plus one field per fire-time parameter, which
   *  is exactly what the checker derived at the construction site. An in-memory
   *  record: a callback belongs to no graph, so there is no adapter to read
   *  through. */
  private callbackCallBinding(call: CallbackCall): Binding {
    return binding({
      kind: 'shapePosition',
      shape: CALLBACK_LANDING_SHAPE,
      node: CALLBACK_CALLED_EDGE,
      fields: { [CALLBACK_CALL_AT]: call.at, ...call.values },
      fieldProvenance: {},
    });
  }

  /**
   * `await <traversal>` / `await sleep(<duration>)` — the wake primitive
   * (asks-as-adapter §A, P18). Two sources:
   *
   *   - `sleep(<duration>)` — the clock wake source: an ordinary TIMER park (the
   *     `sleep` statement re-skinned), binding nothing.
   *   - `<head>-[:Edge]->` — the SIGNAL wake source (`untilNonEmpty`): CHECK-NOW,
   *     ELSE PARK. The engine resolves the awaitable adapter and calls its
   *     `resolveAwait` capability against the current graph state:
   *       · `landed`  → bind the landing(s) and CONTINUE INLINE (the resolved
   *                     shortcut, S2 — no park);
   *       · `empty`   → a `resolvesEmpty` settlement (an explicit cancel): bind
   *                     an EMPTY match and continue (downstream runs zero times);
   *       · `pending` → REGISTER the correlation (park ↔ watch-point) on the
   *                     adapter, record the `await` park, and suspend. Resume
   *                     RE-ENTERS here and re-checks live (the await re-evaluates
   *                     itself — no injected answer).
   *
   * dry_run: the faked ask write minted no real record, so `resolveAwait` finds
   * nothing and the await settles immediately EMPTY (F3/F23) — the run walks
   * straight through.
   */
  private async interpretAwait(
    awaitExpr: AwaitExpression,
    bindingName: string | undefined,
    env: Environment,
    stmtAddress: Address,
    body: BodyContext,
  ): Promise<void> {
    const source = awaitExpr.source;
    if (source.kind === 'until') {
      await this.interpretUntil(source, bindingName, env, stmtAddress, {
        ...body,
        address: stmtAddress,
      });
      return;
    }
    if (source.kind === 'sleep') {
      // The clock wake source: a timer park. A BOUND `expired = await sleep(…)`
      // carries its name so the completed branch escapes it onto a race receipt
      // as an edge (S4); on a real park the presence is injected at timer resume,
      // and on the dry-run fast-forward we bind it here (interpretSleep returns).
      await this.interpretSleep({ duration: source.duration }, stmtAddress, env, bindingName);
      if (bindingName !== undefined) {
        env.declare(bindingName, binding({ kind: 'value', value: true, provenance: NO_PROVENANCE }));
      }
      return;
    }
    if (source.kind === 'combinator') {
      await this.interpretCombinator(source.combinator, bindingName, env, stmtAddress, body);
      return;
    }

    const address = encodeAddress(stmtAddress);
    const edge = awaitEdgeName(source.head.hopsRaw);
    // The awaited WHERE (`-[:Response WHERE r.answer]->`) — checker-guaranteed
    // PURE (MOV_AWAIT_IMPURE_WHERE). Evaluated at RESOLUTION time against each
    // candidate landing's fields (B.1): a matching landing resolves the await,
    // an unmatched set leaves it armed. Undefined ⇒ no narrowing.
    const hopFilter = /\bWHERE\b/i.test(source.head.hopsRaw)
      ? awaitHopFilter(source.head)
      : undefined;

    // Resolve the awaited head to a record identity. The head is a bound handle
    // whose adapter carries the awaitable capability (the checker guaranteed the
    // edge is awaitable, hence the adapter advertises it).
    const headBinding = env.resolve(pathRootName(source.head) ?? '');
    if (headBinding?.kind === 'callback') {
      await this.interpretCallbackAwait({
        binding: headBinding,
        edge,
        ...(hopFilter !== undefined ? { hopFilter } : {}),
        bindingName,
        env,
        address,
      });
      return;
    }
    if (headBinding === undefined || headBinding.kind !== 'handle') {
      throw unsupported(
        `await '${pathRootName(source.head) ?? ''}-[:${edge}]->'`,
        'await needs a written record handle as its head (e.g. an ask written with `write asks-[:Check]->`)',
      );
    }
    const recordId = headBinding.handle.externalId;
    const adapterType = headBinding.handle.adapterType;
    // The FILE-SCOPE instance name the awaited head's adapter came from — the
    // SAME identity a rehydrated `sourcePosition` re-resolves its read seam
    // through after a serialize→DB→deserialize round trip (`resolveSourceRead`
    // looks it up in the re-parsed file scope). Derive it from the head's graph
    // exactly as `graphReadFor` does, NOT from the local binding name (which is
    // absent from file scope and crashes rehydration — chunk C branch-export).
    const instanceName = headBinding.graph.instance.name;
    if (recordId === undefined) {
      // dry_run / rehearsed write — no real record to await; settle empty (F3).
      this.declareAwaitResult(env, bindingName, adapterType, undefined, null, instanceName);
      return;
    }

    // Resolve the awaitable adapter with the AWAITED HEAD's own credential +
    // construction args — the same instance the write went through — so
    // `resolveAwait` can drive the live re-check (Slack's `conversations.replies`
    // needs the bot token). A bare source resolution (no credential) left the
    // Slack client null and the reply never resolved. `credentialsIdFor` is a
    // no-op for credential-free intrinsics (the ask adapter), so this is
    // uniformly correct.
    const headInstance =
      headBinding.graph.kind === 'instance' ? headBinding.graph.instance : undefined;
    const headCredentialsId =
      headInstance !== undefined ? this.credentialsIdFor(headInstance) : undefined;
    const headConstructionArgs =
      headInstance !== undefined ? constructionArgsOf(headInstance) : {};
    const adapter = await this.resolveAdapterFn({
      adapterType,
      teamId: this.input.teamId,
      ...(headCredentialsId !== undefined ? { credentialsId: headCredentialsId } : {}),
      ...(Object.keys(headConstructionArgs).length ? { constructionArgs: headConstructionArgs } : {}),
      role: 'source',
    });
    if (!adapter.awaitable) {
      throw unsupported(
        `await '-[:${edge}]->' on '${adapterType}'`,
        `the '${adapterType}' adapter does not implement the awaitable capability`,
      );
    }

    // Under dry_run the faked write minted no resolvable record; settle empty.
    if (this.input.dryRun) {
      this.declareAwaitResult(env, bindingName, adapterType, adapter, {}, instanceName);
      logger.info(`await ${edge} (dry-run: resolves empty)`);
      return;
    }

    // The head's inline data — everything a normal traversal gets (correlation,
    // not stability). An adapter whose correlation identity isn't the bare
    // `recordId` reads it here (Slack's `Replies`: channel + thread ride the
    // write handle's data, not its `ts`).
    const headData = headBinding.handle.resultData ?? undefined;
    const resolution = await adapter.awaitable.resolveAwait({
      recordId,
      edge,
      ...(headData !== undefined ? { headData } : {}),
    });
    if (resolution.status === 'landed') {
      // Apply the awaited WHERE to each candidate (B.1) THROUGH the adapter's own
      // getFieldValue — the exact read path the resumed body uses — so the
      // predicate reads a candidate identically to `o.User` post-bind, with no
      // name/keying skew between the WHERE and the binding. The first landing to
      // pass wins (v1 edges are cardinality-one).
      let matched: { recordType?: string; fields: Record<string, unknown> } | undefined;
      for (const landing of resolution.landings) {
        if (
          hopFilter === undefined ||
          (await awaitLandingMatches({ filter: hopFilter, adapter, adapterType, landing }))
        ) {
          matched = landing;
          break;
        }
      }
      if (matched !== undefined) {
        // The resolved shortcut (S2): continue inline.
        this.declareAwaitResult(
          env,
          bindingName,
          adapterType,
          adapter,
          matched.fields,
          instanceName,
          matched.recordType,
        );
        return;
      }
      // Landings exist but NONE match the WHERE — leave the await ARMED (park),
      // exactly like pending; a later matching arrival resumes it (F10/B.1).
    }
    if (resolution.status === 'empty') {
      // A resolvesEmpty settlement — bind an empty match; downstream runs zero
      // times (F6). Awaiting an already-settled-empty edge is instant.
      this.declareAwaitResult(env, bindingName, adapterType, adapter, {}, instanceName);
      return;
    }

    // Pending: register the correlation on the adapter (its map from the ask id
    // to this park), record the await park, and suspend. Resume re-enters here.
    const parkSink = this.input.parkSink;
    if (!parkSink) {
      throw unsupported(
        'await (a durable park)',
        'this run has no park sink — an await needs the durable trigger-run substrate',
      );
    }
    const awaitable = adapter.awaitable;
    const state = this.parkedState((park) => ({
      version: 1,
      address,
      // An await binds nothing at park time: resume RE-ENTERS here and the await
      // re-checks live, binding the landing itself (`reenter` semantics).
      bindingName: null,
      scopeChain: serializeScopeChain(env.chainFromRoot(), park),
    }));
    await parkSink.commitAwaitPark({
      address,
      state,
      correlate: (runId: string) =>
        awaitable.registerAwait({
          recordId,
          edge,
          ...(headData !== undefined ? { headData } : {}),
          runId,
          teamId: this.input.teamId as unknown as string,
          address,
        }),
    });
    this.trace.push({ kind: 'gate', outcome: false });
    throw new RunParked(address);
  }

  /**
   * `await cb-[:Called]->` — CHECK-NOW, ELSE PARK, exactly as an adapter await
   * does, with the CALL LEDGER standing in for `resolveAwait`: a call already
   * recorded resolves inline; nothing recorded registers the correlation and
   * parks. Resume RE-ENTERS here and re-reads the ledger live — which is why
   * the calls are never carried on the captured binding.
   *
   * This is also the author's keep-alive: a run that awaits `Called` stays
   * parked, which is how buttons stay live under ruling (b).
   */
  private async interpretCallbackAwait(input: {
    binding: Extract<Binding, { kind: 'callback' }>;
    edge: string;
    hopFilter?: Expression;
    bindingName: string | undefined;
    env: Environment;
    address: string;
  }): Promise<void> {
    const { binding, bindingName, env, address } = input;
    if (input.edge !== CALLBACK_CALLED_EDGE) {
      throw unsupported(
        `await '-[:${input.edge}]->' on a callback`,
        `a callback has one edge, '${CALLBACK_CALLED_EDGE}'`,
      );
    }
    const sink = this.input.callbackSink;
    if (!sink) {
      throw unsupported(
        `await cb-[:${CALLBACK_CALLED_EDGE}]->`,
        'this run has no callback sink — a callback needs the durable trigger-run substrate',
      );
    }

    const calls = await sink.calls(binding.callbackId);
    const matched = calls.find((call) => this.callbackCallMatches(call, input.hopFilter));
    if (matched !== undefined) {
      // The resolved shortcut (S2): a fire already landed — continue inline.
      if (bindingName !== undefined) env.declare(bindingName, this.callbackCallBinding(matched));
      return;
    }

    const parkSink = this.input.parkSink;
    if (!parkSink) {
      throw unsupported(
        `await cb-[:${CALLBACK_CALLED_EDGE}]-> (a durable park)`,
        'this run has no park sink — an await needs the durable trigger-run substrate',
      );
    }
    const state = this.parkedState((park) => ({
      version: 1,
      address,
      // Re-enter: the await re-reads the ledger and binds its own landing.
      bindingName: null,
      scopeChain: serializeScopeChain(env.chainFromRoot(), park),
    }));
    await parkSink.commitAwaitPark({
      address,
      state,
      correlate: () => sink.correlateAwait({ callbackId: binding.callbackId, address }),
    });
    this.trace.push({ kind: 'gate', outcome: false });
    throw new RunParked(address);
  }

  /**
   * Run a fired callback's BODY — the side entry. The scope chain up to the
   * callback statement is already rehydrated; the body runs in a CHILD of it
   * (closure semantics) carrying the fire-time values, at its own address frame
   * so a body that parks gets a leaf of its own and repeated fires of a
   * repeatable callback never collide.
   *
   * A body-less `callback()` has nothing to run: the fire IS the recorded call,
   * and whoever awaits `Called` is woken by the caller. Not a variant — an
   * empty body does exactly this by construction.
   */
  private async runCallbackBody(input: {
    statement: Statement | undefined;
    stmtAddress: Address;
    env: Environment;
    atAnchor: boolean;
    position: SourcePosition | undefined;
    values: Record<string, unknown>;
    callIndex: number;
  }): Promise<void> {
    const statement = input.statement;
    if (
      statement === undefined ||
      statement.kind !== 'assign' ||
      statement.value.kind !== 'callback'
    ) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `fireCallback: no callback statement at '${encodeAddress(input.stmtAddress)}' — the run's pinned version and the stored entry point disagree`,
      );
    }
    const subject = statement.value.callback.subject;
    const frameAddress = childIter(input.stmtAddress, input.callIndex);
    const body: BodyContext = {
      atAnchor: input.atAnchor,
      ...(input.position !== undefined ? { position: input.position } : {}),
      address: frameAddress,
    };

    if (subject.kind === 'named') {
      // The named form defers a whole movement with its fixed arguments — the
      // ordinary call path.
      await this.executeCall(
        { kind: 'call', callee: subject.movement, args: subject.args, span: subject.span },
        input.env,
        body,
      );
      return;
    }

    // The inline subject is an ordinary closure, invoked with what the
    // platform sent. What it returns goes nowhere: firing a callback resumes a
    // run, it does not hand a value to whoever minted it.
    const child = input.env.child();
    for (const param of subject.closure.params) {
      child.declare(param.name, binding({
        kind: 'value',
        value: input.values[param.name] ?? null,
        provenance: NO_PROVENANCE,
      }));
    }
    await this.interpretBody(subject.closure.body, child, body);
  }

  /** The awaited hop's pure WHERE against one recorded call. A call's fields are
   *  plain data (no adapter translates them), so the predicate reads them
   *  directly — the same values the bound landing will read. */
  private callbackCallMatches(call: CallbackCall, filter: Expression | undefined): boolean {
    if (filter === undefined) return true;
    const fields: Record<string, unknown> = { [CALLBACK_CALL_AT]: call.at, ...call.values };
    const reads = new Map<string, unknown>();
    for (const leaf of pureLeafReads(filter)) {
      const key = leafReadKey(leaf);
      const dot = key.indexOf('.');
      reads.set(key, fields[dot >= 0 ? key.slice(dot + 1) : key]);
    }
    return Boolean(evaluatePredicate(filter, { read: (name) => reads.get(name) }));
  }

  /**
   * `await until(<condition>, every: <duration>)` (F12) — the recurring-clock
   * wake source. CHECK-NOW, ELSE RE-PARK: evaluate the condition against the
   * current scope; if it holds, bind its value and CONTINUE INLINE; else park on
   * a TIMER (`wake_at = now + every`)
   * whose resume RE-ENTERS this statement to re-evaluate WITHOUT resuming the
   * program forward. The loopless language can't write the loop, so the engine
   * owns it; the cadence is visible so the re-evaluation cost is visible. Metering
   * is ordinary run time (no premium). Under dry_run there is no wall clock to
   * wait on, so we evaluate once and continue (the general dry-run jank, F3/F23).
   */
  private async interpretUntil(
    source: Extract<AwaitSource, { kind: 'until' }>,
    bindingName: string | undefined,
    env: Environment,
    stmtAddress: Address,
    body: BodyContext,
  ): Promise<void> {
    const evaluated = await this.evaluateUntilCondition(source, env, body);

    if (untilConditionMet(evaluated.value) || this.input.dryRun) {
      // Resolve: the await's value is the condition that now holds. Bind it and
      // continue forward.
      if (bindingName !== undefined) {
        env.declare(
          bindingName,
          evaluated.binding ?? binding({ kind: 'value', value: evaluated.value, provenance: NO_PROVENANCE }),
        );
      }
      return;
    }

    const parkSink = this.input.parkSink;
    const address = encodeAddress(stmtAddress);
    if (!parkSink) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `await until reached at '${address}' with no park sink — a recurring wait needs the durable trigger-run substrate`,
      );
    }
    const everyMs =
      source.every !== undefined ? durationToMs(source.every.raw) : UNTIL_DEFAULT_EVERY_MS;
    const state = this.parkedState((park) => ({
      version: 1,
      address,
      // An `until` binds nothing at park time: resume RE-ENTERS here and, when the
      // condition is met, binds the compared value itself. The `until` flag tells
      // the timer-resume worker to re-enter-and-re-evaluate, not step past.
      bindingName: null,
      until: true,
      scopeChain: serializeScopeChain(env.chainFromRoot(), park),
    }));
    await parkSink.commitTimerPark({
      address,
      state,
      wakeAt: new Date(Date.now() + everyMs),
    });
    this.trace.push({ kind: 'gate', outcome: false });
    throw new RunParked(address);
  }

  /**
   * Evaluate an `until` condition to a testable value: a CLOSURE is invoked
   * once per tick (its `refresh`es re-fetch live) and what it returns is the
   * answer; a plain expression is that same closure with the ceremony elided,
   * evaluated directly. Returns both the raw value (for the holds test) and the
   * binding itself, so a met `until` can escape what it settled on.
   */
  private async evaluateUntilCondition(
    source: Extract<AwaitSource, { kind: 'until' }>,
    env: Environment,
    body: BodyContext,
  ): Promise<{ value: unknown; binding?: Binding }> {
    // A closure literal, or a name bound to one earlier — the same condition,
    // called once per tick.
    if (source.condition.kind === 'closure') {
      return this.tickClosure(
        binding({ kind: 'closure', closure: source.condition.closure, captured: captureScope(env) }),
        body,
      );
    }
    const named = this.namedClosure(source.condition.expr, env);
    if (named !== undefined) return this.tickClosure(named, body);
    const { value, provenance } = await this.evaluateSlot(source.condition.expr, { env });
    return { value, binding: binding({ kind: 'value', value, provenance }) };
  }

  /** One tick of a closure condition: call it, and take what it returned. */
  private async tickClosure(
    closure: Extract<Binding, { kind: 'closure' }>,
    body: BodyContext,
  ): Promise<{ value: unknown; binding?: Binding }> {
    const outcome = await this.invokeClosure(closure, {}, body);
    if (!outcome.returned) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        "an 'until' condition returned nothing — the checker should have caught this",
      );
    }
    const bound = outcome.value;
    return { value: bound.kind === 'value' ? bound.value : bound, binding: bound };
  }

  /** A slot that is exactly a name bound to a CLOSURE — the condition written
   *  once and referred to, rather than spelled inline. */
  private namedClosure(
    slot: ExprSlot,
    env: Environment,
  ): Extract<Binding, { kind: 'closure' }> | undefined {
    const trimmed = slot.raw.trim();
    if (!BARE_IDENT.test(trimmed)) return undefined;
    const binding = env.resolve(trimmed);
    return binding?.kind === 'closure' ? binding : undefined;
  }

  /**
   * Call a closure: its captured scope, its parameters, its body. A closure's
   * body is a body like any other, so `return` leaves it the same way — and
   * the capture is a flat snapshot exactly as a deferred walk's is, which is
   * what makes both survive a park.
   */
  private async invokeClosure(
    binding: Extract<Binding, { kind: 'closure' }>,
    values: Record<string, unknown>,
    body: BodyContext,
  ): Promise<BodyOutcome> {
    const child = closureScope(binding).child();
    // Its own name first, so a parameter of the same name shadows it.
    if (binding.self !== undefined) child.declare(binding.self, binding);
    for (const param of binding.closure.params) {
      // A collection op hands each member back in the currency it arrived in,
      // so a member may BE a record — and binds as one.
      child.declare(param.name, bindValue(values[param.name] ?? null));
    }
    return this.interpretBody(binding.closure.body, child, body);
  }

  /**
   * Bind an awaited edge's resolution as the landed node — a source-position
   * over the awaitable adapter carrying the landing's fields inline (`r.answer`
   * reads through the adapter's `getFieldValue`). An EMPTY resolution binds a
   * fields-less node: `r.answer` reads null and downstream blocks run zero
   * times. `null` fields (no adapter) is the dry-run / no-record case.
   */
  private declareAwaitResult(
    env: Environment,
    bindingName: string | undefined,
    adapterType: string,
    adapter: Adapter | undefined,
    fields: Record<string, unknown> | null,
    instanceName: string,
    // The landing node's natural type (`Response` for an ask, `Message` for a
    // Slack reply). The bound position types AS this, so field reads dispatch to
    // the adapter's `getFieldValue` for the right type. Absent (empty/dry-run) ⇒
    // the ask `Response` default — a fields-less node reads null regardless.
    recordType: string = 'Response',
  ): void {
    if (bindingName === undefined) return;
    if (fields === null || adapter === undefined) {
      env.declare(bindingName, binding({ kind: 'value', value: null, provenance: NO_PROVENANCE }));
      return;
    }
    const position = makeUnstablePosition({
      adapterType,
      recordType,
      data: fields,
    });
    // `instanceName` is the awaited head's FILE-SCOPE instance (not the local
    // binding name) — the identity a rehydrated read seam re-resolves through.
    const read: SourceRead = { adapter, instanceName };
    env.declare(bindingName, binding({ kind: 'sourcePosition', position, read }));
  }

  // ── refresh (asks-as-adapter F5/F22) ──

  /**
   * `refresh <handle>` — re-fetch the record behind a stable handle by its id and
   * MOVE its field snapshot to now (F5): fields read the snapshot, hops stay live,
   * `refresh` advances the snapshot. Serializable across parks (the swap mutates
   * the in-scope binding, which the scope chain carries). A re-fetch of a
   * since-deleted record is a LOUD run error, never absent-ification (F22). Under
   * a rehearsed / dry-run write (no real record id) there is nothing to move, so
   * refresh is a no-op.
   */
  private async interpretRefresh(statement: RefreshStatement, env: Environment): Promise<void> {
    const at = `refresh ${statement.name}`;
    const binding = env.resolve(statement.name);
    if (binding === undefined) {
      throw new MovementEngineError('MOVENG_RUNTIME', `${at}: '${statement.name}' is not in scope`);
    }

    let adapter: Adapter;
    let recordType: string;
    let externalId: string;
    // The CURRENT field snapshot — the getFieldValue fallback re-reads its keys
    // and preserves any the adapter doesn't override (by seeding the probe
    // position's `data` with it), so a re-fetch never nulls out a base id.
    let snapshot: Record<string, unknown>;
    let applyFresh: (fresh: Record<string, unknown>) => void;

    if (binding.kind === 'handle') {
      if (binding.handle.externalId === undefined) return; // rehearsed / dry-run — no record to move
      externalId = binding.handle.externalId;
      recordType = binding.handle.recordType;
      adapter = await this.resolveAdapterFn({
        adapterType: binding.handle.adapterType,
        teamId: this.input.teamId,
        role: 'source',
      });
      const handle = binding.handle;
      snapshot = { ...handle.foundData, ...handle.resultData, ...handle.writtenValues };
      applyFresh = (fresh) => this.applyRefreshToHandle(handle, fresh);
    } else if (binding.kind === 'sourcePosition') {
      const identity = binding.position.identity;
      const rt = binding.position.recordType;
      if (identity.kind !== 'stable' || rt === null) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `${at}: '${statement.name}' is not a stable record with an id — nothing to re-fetch`,
        );
      }
      externalId = identity.recordId;
      recordType = rt;
      const read = binding.read ?? this.source;
      if (!read) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `${at}: '${statement.name}' has no read seam — its graph is unknown`,
        );
      }
      adapter = read.adapter;
      snapshot = (positionData(binding.position) as Record<string, unknown> | undefined) ?? {};
      applyFresh = (fresh) => this.applyRefreshToPosition(binding, fresh);
    } else {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${statement.name}' is ${describeBinding[binding.kind]}, not a re-fetchable record`,
      );
    }

    applyFresh(await this.refetchForRefresh({ adapter, recordType, externalId, snapshot, at }));
  }

  /**
   * Re-fetch a record's fields for `refresh`. Prefer `readRecord` — one call for
   * the whole record, and the only seam that can tell a DELETED record (returns
   * null → LOUD F22 error) from a live one. Adapters that expose no `readRecord`
   * (the ask adapter reads every field live from its own store via the universal,
   * required `getFieldValue`) fall back to re-reading each snapshot field through
   * that seam: the probe position carries the current snapshot as its `data`, so
   * a field the adapter doesn't override live is PRESERVED rather than nulled.
   * The fallback cannot distinguish deletion from a null field, so F22 loudness
   * rides `readRecord` only — acceptable, since the surfaces that need refresh and
   * lack readRecord (asks) don't model record deletion.
   */
  private async refetchForRefresh(input: {
    adapter: Adapter;
    recordType: string;
    externalId: string;
    snapshot: Record<string, unknown>;
    at: string;
  }): Promise<Record<string, unknown>> {
    const { adapter, recordType, externalId, snapshot, at } = input;
    if (typeof adapter.readRecord === 'function') {
      const fresh = await adapter.readRecord({ recordType, externalId });
      if (fresh === null) {
        // F22: the record is gone — refresh is LOUD, never absent-ification.
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `${at}: record '${externalId}' no longer exists in '${adapter.adapterType}' — it was deleted, so its snapshot can't be refreshed`,
        );
      }
      return fresh;
    }
    const position: SourcePosition = {
      adapterType: adapter.adapterType,
      recordType,
      identity: { kind: 'stable', recordId: externalId, data: snapshot },
    };
    const fresh: Record<string, unknown> = {};
    for (const fieldId of Object.keys(snapshot)) {
      fresh[fieldId] = await adapter.getFieldValue({ position, fieldId });
    }
    return fresh;
  }

  /** Advance a write handle's readable snapshot to the re-fetched fields.
   *  `readHandleField` reads `writtenValues` before `resultData`, so overwrite
   *  any overlapping written field too — the snapshot truly moves. */
  private applyRefreshToHandle(handle: WriteRecord, fresh: Record<string, unknown>): void {
    handle.resultData = { ...(handle.resultData ?? {}), ...fresh };
    for (const key of Object.keys(fresh)) {
      if (key in handle.writtenValues) handle.writtenValues[key] = fresh[key];
    }
  }

  /** Advance a traversed record's inline data snapshot to the re-fetched fields. */
  private applyRefreshToPosition(
    binding: Extract<Binding, { kind: 'sourcePosition' }>,
    fresh: Record<string, unknown>,
  ): void {
    const identity = binding.position.identity;
    if (identity.kind === 'stable') {
      const existing = (identity.data ?? {}) as Record<string, unknown>;
      identity.data = { ...existing, ...fresh };
    }
  }

  // ── inline block expressions (asks-as-adapter F12) ──

  /**
   * `{ …statements…; b = … }.b` — run the block body ONCE in a child scope, then
   * return the named binding (F12). Total: the checker guarantees the binding
   * exists. Used standalone (`x = { … }.b`) and by `until` conditions (re-run per
   * tick; `refresh` inside advances a snapshot live). A missing binding is a loud
   * engine error (the checker should have caught it).
   */
  /** `{ … }.name` — retired with the rest of naming-is-exporting. The checker
   *  refuses it at save time; a program saved before that gets the same refusal
   *  here rather than a silently different meaning. */
  private inlineBlockRetired(binding: string): never {
    throw unsupported(
      `reading a block's inner binding by name ('{ … }.${binding}')`,
      `a body hands its value back with 'return' — bind the value directly, or write a closure ('() => { … return ${binding} }')`,
    );
  }

  /**
   * `ERROR("message")` — fail the whole run with a reason (§3c). Evaluate the
   * message and throw a run-failing engine error; the firing path records a
   * FAILED trigger_run (the existing failure containment in `runMovementFiring`).
   */
  private async interpretError(
    statement: Extract<Statement, { kind: 'error' }>,
    env: Environment,
  ): Promise<void> {
    const { value } = await this.evaluateSlot(statement.message, { env });
    const message = typeof value === 'string' ? value : String(value ?? '');
    throw new MovementEngineError('MOVENG_ERROR', message);
  }

  private async evaluateCondition(slot: ExprSlot, env: Environment): Promise<boolean> {
    const staged = await this.evaluateStagedCondition(slot, env);
    if (staged !== undefined) return staged;
    let condition: MovementCondition;
    try {
      condition = conditionOfSlot(slot);
    } catch (e) {
      if (e instanceof BridgeError) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `invalid condition (the checker should have caught this): ${e.message}`,
        );
      }
      throw e;
    }
    return this.evaluateParsedCondition(condition, env);
  }

  private async evaluateParsedCondition(
    condition: MovementCondition,
    env: Environment,
  ): Promise<boolean> {
    switch (condition.kind) {
      case 'isTest':
        return this.evaluateIsTest(condition, env);
      case 'and': {
        for (const conjunct of condition.conjuncts) {
          if (!(await this.evaluateParsedCondition(conjunct, env))) return false;
        }
        return true;
      }
      case 'expr':
        return Boolean(await evaluateMovementExpression(condition.expr, this.exprContext(env)));
    }
  }

  /**
   * Runtime IS — the checker already narrows IS at compile time, so
   * what reaches runtime is the residual union-discrimination test: is
   * this position's RUNTIME type the named one? The engine answers
   * where it knows the type:
   *   - the event parameter: graph identity is the movement's source
   *     instance (binding objects are declared once — object identity
   *     is alias-safe graph identity); the position is the
   *     discriminated event's record type (engine currency, so the
   *     surface name translates through the run's refs first);
   *   - a write handle / shape position: graph + surface type are
   *     carried on the binding and compare directly;
   *   - a TRAVERSAL ALIAS: the landed record's own `recordType`, as the
   *     surface-read wrapper restamped it — which is what makes an `IS`
   *     narrowing of a polymorphic edge actually discriminate at run
   *     time.
   * Where the RECORD KIND is not knowable — an undiscriminated event
   * seed, a landed record the source returned unstamped, or an event
   * whose address says nothing about the axis a test pins — the run FAILS
   * LOUDLY rather than answering. `false` would have meant two different
   * facts at once ("not that kind" and "can't tell"), and the second one
   * fell through to the `else`: an undiscriminated record arriving in an
   * arm typed as "not that kind" is the silent degradation this language
   * bans, and it is what stopped `else` from narrowing at all. Refusing
   * here is what makes the checker's else-arm elimination sound — and it
   * retires the old falsy-skip, which silently did nothing on exactly the
   * events the author wrote the branch for.
   *
   * A test that IS answerable and comes out false (a different graph, a
   * different record kind) is an ordinary false — only "can't tell"
   * throws.
   */
  /** The run cannot answer an `IS` because the subject arrived with no record
   *  kind on it. Author-facing: names the binding and what went missing, in the
   *  same run-failing register as `ERROR(…)` so it lands in run history. */
  private undiscriminatedIsTest(subjectName: string, reason: string): MovementEngineError {
    return new MovementEngineError(
      'MOVENG_RUNTIME',
      `can't tell what kind of record '${subjectName}' is — ${reason}. `
        + `An 'IS' test needs a record whose kind is known, so this run stopped `
        + `rather than pick a branch that might be wrong`,
    );
  }

  private evaluateIsTest(
    condition: Extract<MovementCondition, { kind: 'isTest' }>,
    env: Environment,
  ): boolean {
    const subjectName = condition.subjectRaw.trim();
    if (!BARE_IDENT.test(subjectName)) return false;
    const subject = env.resolve(subjectName);
    const graph = env.resolve(condition.type.graph);
    if (!subject || !graph) return false;
    // A DECLARED NODE names a STRUCTURE, so the test is structural — the same
    // comparator the checker uses, against the same derived schema. It never
    // reads data: what a position OFFERS is declared, and that is the whole
    // question.
    if (graph.kind === 'shape' && condition.type.hopsRaw === undefined) {
      return this.evaluateDeclaredNodeTest(subjectName, subject, graph, env);
    }
    switch (subject.kind) {
      case 'event': {
        if (graph !== this.sourceInstance) return false;
        if (condition.type.position === undefined && condition.type.hopsRaw === undefined) {
          return true;
        }
        const seedAddress = this.sourceEventAddress;
        // An ADDRESS test (`IS <at-[:`Record Change` WHERE `action` == …]->>`)
        // against a typed event: the test is TRUE when its pins are a SUBSET
        // of the seed's own address, agreeing on every value — the same
        // intersection semantics the checker narrows by, over the same two
        // derivations (`eventAddressOfHops` / `eventSeedAddress`), so check
        // time and fire time cannot disagree.
        if (condition.type.hopsRaw !== undefined) {
          const test = eventAddressOfHops(condition.type.hopsRaw);
          if (test === undefined) return false;
          if (seedAddress !== undefined) {
            if (test.event !== seedAddress.event) return false;
            // An axis the seed never pinned is "can't tell", not "not that
            // one" — the same distinction the record plane draws, on the plane
            // where the kind is an ADDRESS rather than a type name. The seed's
            // pins come off the payload, so a trigger that delivered the event
            // without its `action` (or without a declared narrowing key) leaves
            // every pinned test unanswerable; returning false there would route
            // the run into an `else` the checker has typed as "none of the
            // tested addresses", which is the elimination reading a silence as
            // a fact. A pin the seed HAS, disagreeing, is an ordinary false.
            const unpinned = Object.keys(test.narrowing).filter(
              key => seedAddress.narrowing[key] === undefined,
            );
            if (unpinned.length > 0) {
              throw this.undiscriminatedIsTest(subjectName, unpinnedAxis(unpinned));
            }
            return Object.entries(test.narrowing).every(
              ([key, value]) => seedAddress.narrowing[key] === value,
            );
          }
          const keyed = this.source?.position?.recordType ?? undefined;
          if (keyed == null) throw this.undiscriminatedIsTest(subjectName, UNDISCRIMINATED_EVENT);
          return eventAddressKey(test) === keyed;
        }
        // Position-form (`IS <chat-[:`Message Received`]->>`): an unpinned
        // event-node name is a subset test with no pins.
        if (seedAddress !== undefined && condition.type.position === seedAddress.event) {
          return true;
        }
        const position = this.source?.position;
        // A typed webhook event is an UNSTABLE position — the live record is
        // reached by the record edge, not carried on the seed — so we read
        // `recordType` directly rather than gating on stability. A genuinely
        // undiscriminated event carries `recordType: null`: nothing to compare,
        // so the run refuses rather than guessing a branch.
        const recordType = position?.recordType ?? undefined;
        if (recordType == null) throw this.undiscriminatedIsTest(subjectName, UNDISCRIMINATED_EVENT);
        // Adapter type names are the adapter's own verbatim ids — the named
        // position type compares directly to the runtime record type.
        return condition.type.position === recordType;
      }
      case 'handle': {
        // An ADDRESS test names an event narrowing; a handle is never one.
        if (condition.type.hopsRaw !== undefined) return false;
        if (graph !== subject.graph.instance) return false;
        return (
          condition.type.position === undefined || condition.type.position === subject.targetType
        );
      }
      case 'sourcePosition': {
        // A TRAVERSAL ALIAS — a landed source record. Its type is in hand: the
        // adapter stamped `recordType` and the surface-read wrapper restamped
        // it to the natural name the program speaks, which is the same
        // vocabulary the type marker names. This case used to be absent, so
        // every `IS` on a traversal result fell to `false` and quietly skipped
        // its arm — the narrowing the checker had already typed the body under
        // simply never happened.
        //
        // An ADDRESS test names an event narrowing; a landed record is never
        // one (only the event seed carries an address).
        if (condition.type.hopsRaw !== undefined) return false;
        // The graph the alias was YIELDED from — its own read seam when it came
        // from an instance-/kg-rooted head, else the movement's source. Both
        // sides name it the same way (the binding's own name), so the
        // comparison cannot drift.
        const yieldedFrom = subject.read?.instanceName ?? this.sourceInstance?.name;
        const named = graph.kind === 'instance' ? graph.name : undefined;
        if (named === undefined || yieldedFrom === undefined || named !== yieldedFrom) return false;
        // An unstamped landing is the other "can't tell" case: the source
        // handed back a record without saying what it is, so there is no
        // honest branch to take.
        const recordType = subject.position.recordType ?? undefined;
        if (recordType == null) throw this.undiscriminatedIsTest(subjectName, UNSTAMPED_LANDING);
        return condition.type.position === undefined || condition.type.position === recordType;
      }
      // A declared node is handled structurally above; any OTHER graph is a
      // different graph, which is an ordinary false.
      case 'shapePosition':
        return false;
      default:
        return false;
    }
  }

  /**
   * `rec IS <Doc>` — STRUCTURAL conformance, not a name match.
   *
   * A declared node belongs to no graph, so "is this the same position" is not
   * the question; "does this position carry everything Doc declares" is, and it
   * is decidable from what the position DECLARES — the record type's schema, or
   * a synthesised node's own entries. No data is read, and a field being null
   * is not a misfit: the surface is what the position offers, not what this
   * record happens to hold.
   *
   * Same comparator and same derived schema as the checker (`surfaceMisfit` /
   * `shapeToSchema`), so a predicate cannot mean one thing while authoring and
   * another while running.
   *
   * THREE answers, because there are three facts. A subject with a surface is
   * compared. A subject that is not a position at all is an ordinary false —
   * no structure, so nothing to conform. A subject that IS a position whose
   * structure the run cannot see fails the run, exactly as an undiscriminated
   * event does: "can't tell" and "not that shape" must not share an answer,
   * because the second one routes into an `else` the checker types as
   * "doesn't fit".
   *
   */
  private evaluateDeclaredNodeTest(
    subjectName: string,
    subject: Binding,
    graph: ShapeBinding,
    env: Environment,
  ): boolean {
    const subjectSurface = this.subjectSurface(subject, env);
    if (subjectSurface.kind === 'notARecord') return false;
    if (subjectSurface.kind === 'unknown') {
      throw this.undiscriminatedIsTest(subjectName, subjectSurface.reason);
    }
    const declared = this.resolvedShape(graph).schema;
    return (
      surfaceMisfit(subjectSurface.surface, {
        schema: declared,
        position: graph.declaration.name,
      }) === undefined
    );
  }

  /**
   * What a bound subject OFFERS, in the comparator's currency — or which of the
   * two non-answers it is.
   *
   * The ROOT subject is what the branch turns on, so an `unknown` there stops
   * the run. A LANDING reached across an edge is the comparator's ordinary
   * unknown and fits, which is the rule the checker follows for exactly the
   * same landing (`suppliedSurface` returns nothing for a position with no
   * published surface).
   */
  private subjectSurface(subject: Binding, env: Environment): SubjectSurface {
    switch (subject.kind) {
      case 'event': {
        const recordType = this.source?.position?.recordType ?? undefined;
        if (recordType == null) return { kind: 'unknown', reason: UNDISCRIMINATED_EVENT };
        return positionSurface(this.sourceInstance?.schema, recordType);
      }
      case 'sourcePosition': {
        const recordType = subject.position.recordType ?? undefined;
        if (recordType == null) return { kind: 'unknown', reason: UNSTAMPED_LANDING };
        const from = subject.read?.instanceName ?? this.sourceInstance?.name;
        return positionSurface(
          from === undefined ? undefined : this.graphSchemaOf(from, env),
          recordType,
        );
      }
      case 'handle':
        return positionSurface(subject.graph.instance.schema, subject.targetType);
      case 'shapePosition': {
        const declaration = env.resolve(subject.shape);
        return declaration?.kind === 'shape'
          ? positionSurface(this.resolvedShape(declaration).schema, subject.node)
          : { kind: 'unknown', reason: UNKNOWN_STRUCTURE };
      }
      // The synthesised planes carry their own structure — the literal's
      // entries ARE the surface, which is why a `node { … }` fits a declaration
      // it never names.
      case 'nodePosition':
        return this.synthesisedSurface(subject.fields, subject.edges, env, name => {
          const edge = subject.edges[name];
          return edge.kind === 'landed' ? edge.landings[0] : undefined;
        });
      case 'extractRoot':
      case 'extractPosition':
        return this.synthesisedSurface(
          subject.emission.fields,
          Object.fromEntries([...subject.emission.children.keys()].map(k => [k, null])),
          env,
          name => {
            const child = subject.emission.children.get(name)?.[0];
            return child === undefined
              ? undefined
              : binding({ kind: 'extractPosition', emission: child });
          },
        );
      case 'blockMeta':
        return this.synthesisedSurface(
          {},
          Object.fromEntries([...subject.edges.keys()].map(k => [k, null])),
          env,
          name => subject.edges.get(name)?.[0],
        );
      default:
        return { kind: 'notARecord' };
    }
  }

  /** One shape for every in-memory plane pair: entry names on the dot plane
   *  (values are not types, so each is declared-but-untyped), and one lazily
   *  resolved landing per edge name. */
  private synthesisedSurface(
    fields: Record<string, unknown>,
    edgeNames: Record<string, unknown>,
    env: Environment,
    landingOf: (name: string) => Binding | undefined,
  ): SubjectSurface {
    return {
      kind: 'surface',
      surface: {
        properties: Object.fromEntries(Object.keys(fields).map(f => [f, undefined])),
        edges: Object.fromEntries(
          Object.keys(edgeNames).map(name => [
            name,
            () => {
              const landing = landingOf(name);
              if (landing === undefined) return undefined;
              const inner = this.subjectSurface(landing, env);
              return inner.kind === 'surface' ? inner.surface : undefined;
            },
          ]),
        ),
      },
    };
  }

  // ── Extraction (E2) ──

  /**
   * `deals = extract from […] { tree }` — build the static spec (explicit
   * annotations only; BORROWED dotted paths resolve against the live
   * instance schemas in scope, per firing — so enum options reach the LLM
   * exactly as the borrowed field carries them today), then hand the
   * planner the runtime seams: the pluggable LLM client, the transform
   * invoker, and slot evaluation bound to the current scope. Backward
   * adoption from write targets is demoted (the checker SUGGESTS the
   * annotation instead); only annotation-resolved types constrain.
   */
  private async runExtraction(_bindingName: string, extract: ExtractExpression, env: Environment) {
    const spec = await buildExtractSpec(extract, {
      resolveBorrowed: ([instanceName, rootName, fieldName]) => {
        const schema = this.graphSchemaOf(instanceName, env);
        if (!schema) return undefined;
        return resolveBorrowedField(schema, rootName, fieldName);
      },
      resolveDeclaredType: (name) => this.typesIn(env).get(name),
      // A description is a string expression like any other, so it is
      // evaluated in the firing environment — a constant it interpolates is
      // the same constant a write field would see.
      resolveDescription: (slot) => this.describeIn(slot, env),
      // A reused declaration's words and types read the scope it was declared in.
      resolveDeclaredNode: (type) => {
        const binding = env.resolve(type);
        return binding?.kind === 'shape' ? this.declaredNodeShape(binding, env) : undefined;
      },
    });
    // Where this extract's own trace entries start — the materialiser
    // appends one per LLM region, and the emitted entities are hung off
    // them once the whole tree exists (see `recordExtractedEntities`).
    const traceMark = this.trace.length;
    const emission = await materializeExtract({
      extract,
      spec,
      runtime: {
        llm: this.llmClient(),
        transformInvoker: this.input.transformInvoker ?? registryTransformInvoker,
        evalSlot: (slot) => this.evaluateSlot(slot, { env }),
        resolveFileText: this.fileTextResolver(),
        trace: this.trace,
      },
    });
    recordExtractedEntities(this.trace, traceMark, emission);
    return emission;
  }

  /**
   * `found = extract(content, Shape, { … })` — the extraction CALL, or
   * `extractOne(…)` for the single record (or absent). The shape
   * is a node declaration in scope, or the one written in the argument (bound
   * for this call only, as the checker scoped it); its spec is the one the
   * keyword builds for `node x: <Shape>`, and the call itself is
   * `extraction_call.ts`'s — a separate path, so nothing here reaches the
   * keyword's.
   */
  private async runExtractCall(call: ExtractCallExpression, env: Environment): Promise<Binding> {
    const shapeEnv = call.shape.kind === 'inline' ? env.child() : env;
    if (call.shape.kind === 'inline') {
      const { declaration } = call.shape;
      shapeEnv.declare(declaration.name, binding({ kind: 'shape', declaration, fileEnv: env, local: true }));
    }
    if (call.shape.kind === 'computed') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'extract' takes a node declaration as its shape, and '${call.shape.expr.raw}' is worked out (the checker should have caught this)`,
      );
    }
    const shapeName = call.shape.kind === 'named' ? call.shape.name : call.shape.declaration.name;
    const shape = shapeEnv.resolve(shapeName);
    if (shape?.kind !== 'shape') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${shapeName}' is not a node declaration in scope, so 'extract' has no shape to fill (the checker should have caught this)`,
      );
    }
    // The shape is its declaration, whatever name reached it (`S = Company`
    // binds the same one): the extractor is told the declaration's own name.
    const declaredName = shape.declaration.name;
    const spec = await buildDeclarationSpec(declaredName, this.declaredNodeShape(shape, shapeEnv), {
      resolveBorrowed: ([instanceName, rootName, fieldName]) => {
        const schema = this.graphSchemaOf(instanceName, env);
        return schema ? resolveBorrowedField(schema, rootName, fieldName) : undefined;
      },
    });
    const settings = this.extractCallSettings(call, spec);
    const { value, provenance } = await this.evaluateSlot(call.content, { env });
    return runExtractCall({
      content: value,
      contentProvenance: provenance,
      spec,
      finds: call.finds,
      settings,
      siteId: `xc:${declaredName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}#${++this.extractCallCount}`,
      runtime: {
        llm: this.extractCallClient(),
        resolveFileText: this.fileTextResolver(),
        trace: this.trace,
        state: this.extractCalls,
      },
    });
  }

  /** The call's settings: its tier's assignment on this deployment, then the
   *  author's model and effort, read by the reader the checker used. */
  private extractCallSettings(call: ExtractCallExpression, spec: ExtractNodeSpec): ExtractionCallSettings {
    let written: ReturnType<typeof readExtractCallConfig> = { ok: true, settings: {} };
    if (call.config !== undefined) {
      try {
        written = readExtractCallConfig(expressionOfSlot(call.config));
      } catch (e) {
        if (!(e instanceof BridgeError)) throw e;
        throw new MovementEngineError('MOVENG_RUNTIME', `invalid 'extract' settings (the checker should have caught this): ${e.message}`);
      }
    }
    if (!written.ok) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `invalid 'extract' settings (the checker should have caught this): ${written.problems.join('; ')}`,
      );
    }
    const { tier, model, effort } = written.settings;
    return extractionCallSettings({
      tier,
      densityModel: selectModel(countShapeNodes(spec)),
      ...(model !== undefined ? { model: parseChatModelName(model, "'extract''s model") } : {}),
      ...(effort !== undefined ? { effort } : {}),
    });
  }

  private extractCallClient(): ExtractCallLlmClient {
    if (this.input.extractCallLlm) return this.input.extractCallLlm;
    this.defaultExtractCallLlm ??= makeAnthropicExtractCallClient();
    return this.defaultExtractCallLlm;
  }

  private async describeIn(slot: ExprSlot, env: Environment): Promise<string> {
    const { value } = await this.evaluateSlot(slot, { env });
    return typeof value === 'string' ? value : String(value ?? '');
  }

  /** The live schema a borrowed type resolves against: a constructed
   *  instance's. (Shape graphs declare primitive field types inline —
   *  nothing to borrow.) */
  private graphSchemaOf(instanceName: string, env: Environment): InstanceSchema | undefined {
    const binding = env.resolve(instanceName);
    return binding?.kind === 'instance' ? binding.schema : undefined;
  }

  private llmClient(): LlmClient {
    if (this.input.llm) return this.input.llm;
    this.defaultLlm ??= makeAnthropicLlmClient();
    return this.defaultLlm;
  }

  /** The one file→text seam for the whole run — an `extract from [ … ]` file
   *  source and a `READ(file)` in an expression read a file the same way. */
  private fileTextResolver(): (ref: FileRef) => Promise<FileTextResolution> {
    this.fileTextSeam ??= this.warnWhenBytesUnavailable(
      this.input.resolveFileText ?? makeFileTextResolver(),
    );
    return this.fileTextSeam;
  }

  /**
   * A file that was THERE and whose bytes could not be fetched is a failure of
   * the run, not a fact about the file — so it goes on the run as a warning,
   * once per file, as well as on the trace entry of whatever read it. The read
   * itself carries on: an extraction's other sources still stand, and its
   * prompt says the file could not be read. A file that is legitimately
   * unreadable (an unsupported type, no text in it) stays on the read's own
   * trace entry only.
   */
  private warnWhenBytesUnavailable(
    resolve: (ref: FileRef) => Promise<FileTextResolution>,
  ): (ref: FileRef) => Promise<FileTextResolution> {
    const warned = new Set<string>();
    return async (ref) => {
      const result = await resolve(ref);
      if (!isFileUnreadable(result) || result.unreadable !== 'bytes_unavailable') return result;
      const key = ref.source?.handle ?? ref.name ?? '';
      if (!warned.has(key)) {
        warned.add(key);
        const name = ref.name !== undefined ? `'${ref.name}'` : 'a file';
        this.trace.push({
          kind: 'warning',
          code: FILE_BYTES_UNAVAILABLE,
          message:
            `The run could not fetch ${name}` +
            (result.detail !== undefined ? `: ${result.detail}` : '') +
            '. Whatever read it went on without its contents.',
        });
      }
      return result;
    };
  }

  // ── Traversal-headed blocks ──

  /**
   * The block runs once per position its head yields — per emitted
   * entity over extract edges, per resource over `#resources`. Each
   * iteration interprets the body in a fresh child environment (so an
   * iteration's bindings never leak into the next — per-position
   * isolation), and the iteration's NAMED bindings accumulate as the
   * block's meta-node edges. Binding the block (`orgs = …-> { … }`)
   * declares that meta-node; an unbound block discards it.
   */
  private async interpretBlock(
    block: TraversalBlock,
    bindingName: string | undefined,
    env: Environment,
    parentAddress: Address,
  ): Promise<void> {
    const iterations = await this.resolveBlockIterations(block, env);
    this.trace.push({
      kind: 'block',
      root: blockRootLabel(block),
      positions: iterations.length,
    });
    const returned: Binding[] = [];
    const finished: Array<{ index: number; value: Binding }> = [];
    let parkedIterations = 0;
    for (let iterIndex = 0; iterIndex < iterations.length; iterIndex++) {
      const iteration = iterations[iterIndex];
      const iterationEnv = env.child();
      for (const [alias, binding] of iteration.bindings) iterationEnv.declare(alias, binding);
      // Block iterations are per-emission positions, never the trigger's
      // anchor — mirrors the TG engine, where a traversal moves the
      // action off the seeded root (W3-Y1 anchor-only bridging). An
      // adapter-edge iteration carries its yielded record as the body's
      // position, so writes bridge to it (the snapshot fan-out shape). Each
      // iteration is `iter j` of this fan-out (§4.3) — positional, stable
      // because A serialises the item list and never re-derives it.
      let outcome: BodyOutcome;
      try {
        outcome = await this.interpretBody(block.body, iterationEnv, {
          atAnchor: false,
          ...(iteration.position !== undefined ? { position: iteration.position } : {}),
          address: childIter(parentAddress, iterIndex),
        });
      } catch (e) {
        // A parked iteration RECORDS its ask (at its `iter j` address) but does
        // NOT halt the fan-out — the next iteration runs its own synchronous
        // prefix and parks at its own ask. So a fan-out over N items fires all N
        // asks (§4.2). Its bindings don't accumulate (it didn't complete).
        if (e instanceof RunParked) {
          parkedIterations += 1;
          continue;
        }
        // Find-on-missing inside a fan-out: THAT iteration skips; the next runs.
        if (!(e instanceof ScopeEndedQuietly)) throw e;
        continue;
      }
      // The ONE way a value leaves an iteration is its `return`; nothing else
      // the body bound escapes.
      if (outcome.returned) {
        returned.push(outcome.value);
        finished.push({ index: iterIndex, value: outcome.value });
      }
    }
    if (bindingName !== undefined) {
      env.declare(bindingName, blockValue(returned));
    }
    // If ANY iteration parked, this fan-out frame is itself pending — record its
    // pending-count (§5.4: the number of parked iterations to wait on), then
    // re-throw so the enclosing sequence stops (§4.2); the join completes once
    // every parked item has resolved (the atomic decrement). The frame address
    // is the fan-out STATEMENT's address (`parentAddress`).
    if (parkedIterations > 0) {
      const frameAddress = encodeAddress(parentAddress);
      // What the iterations that finished returned waits at the frame with the
      // parked ones' exports, so the closer's value holds every iteration.
      for (const { index, value } of finished) {
        await this.input.parkSink?.persistBranchExport({
          frameAddress,
          branchAddress: encodeAddress(childIter(parentAddress, index)),
          branchIndex: index,
          exports: { [RETURN_SLOT]: serializeBinding(value, this.newPark()) },
        });
      }
      await this.input.parkSink?.recordJoin({ frameAddress, parkedChildren: parkedIterations });
      throw new RunParked(frameAddress);
    }
  }

  /**
   * Resolve a block head to its iterations: one alias→binding map per
   * yielded position (plus the yielded SourcePosition itself for
   * adapter-edge heads — the iteration's write-bridge currency). Heads
   * walk extract edges (from an extract root or a deeper extracted
   * entity), adapter edges (collections off the meta root, schema edges
   * off the event or an already-yielded record — the TG engine's
   * iterateRelated/getRelated seam), or a position's `#resources`.
   */
  private async resolveBlockIterations(
    block: TraversalBlock,
    env: Environment,
  ): Promise<BlockIteration[]> {
    return this.resolveHeadIterations(block.head, env);
  }

  /**
   * The head walk itself, independent of any block: `extraSteps` continue past
   * the head's own hops in the SAME walk (what a read through a deferred edge
   * needs — the hops past the edge are hops in the source graph).
   */
  private async resolveHeadIterations(
    head: PathHead,
    env: Environment,
    extraSteps: Extract<Expression, { type: 'traverse' }>['steps'] = [],
  ): Promise<BlockIteration[]> {
    const probed = this.probeHead(head);
    const probe =
      probed?.type === 'traverse' && extraSteps.length > 0
        ? { ...probed, steps: [...probed.steps, ...extraSteps] }
        : probed;
    if (extraSteps.length > 0 && probe?.type !== 'traverse') {
      throw unsupported('continuing a walk past a head that is not a traversal');
    }
    const root = head.root;
    if (root === undefined) {
      throw unsupported(
        'rootless block heads (relative traversal)',
        'root the head at a named binding',
      );
    }
    // Where the walk starts. A NAME is a binding already in scope; an
    // EXPRESSION is evaluated HERE, once, through the same reading a binding
    // gets — `bindSlotValue` is literally the code behind `first = AT(rows, 0)`
    // — so `AT(rows, 0)-[c:company]->` and binding it first are one walk. A
    // deferred head evaluates its root at the READ, which is the moment the
    // rest of the walk happens too; the scope it reads is the one the walk
    // captured, so the answer is the same either way.
    const rootBinding =
      root.kind === 'name' ? env.resolve(root.name) : await this.bindSlotValue(root.expr, env);
    if (!rootBinding) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${spellPathRoot(root)}' is not in scope — the checker should have caught this`,
      );
    }
    return this.headIterationsFrom({
      binding: rootBinding,
      head,
      root: spellPathRoot(root),
      probe,
      env,
    });
  }

  /**
   * The head walk from ONE root binding. Split from `resolveHeadIterations` so
   * a collection of roots — a bound block's returned records — is the same walk
   * run off each of them.
   */
  private async headIterationsFrom(opts: {
    binding: Binding;
    head: PathHead;
    /** The head's root as the author WROTE it — a name, or an expression's
     *  source text. Identity for the messages only; the value is `binding`. */
    root: string;
    probe: Expression | undefined;
    env: Environment;
  }): Promise<BlockIteration[]> {
    const { binding: rootBinding, head, root, probe, env } = opts;
    if (rootBinding.kind === 'positions') {
      // `orgs-[n:Notes]-> { … }` where `orgs` is what a block returned. The
      // returned records ARE the collection, so the hop is that hop off each
      // one, concatenated — exactly what a traversal's own landings do. Zero
      // landings yield zero iterations: the body runs zero times, which IS the
      // traversal gate, and is why a block that ran zero times is bound here
      // rather than on the value plane.
      const perLanding: BlockIteration[] = [];
      for (const landing of rootBinding.landings) {
        perLanding.push(
          ...(await this.headIterationsFrom({ binding: landing, head, root, probe, env })),
        );
      }
      return perLanding;
    }

    if (rootBinding.kind === 'callback') {
      // `cb-[c:Called]-> { … }` — the SYNCHRONOUS read of the calls so far.
      // Zero of them before anything fires is an empty traversal (the block runs
      // zero times), not a special state; a repeatable callback simply
      // accumulates, and traversals are many-valued already.
      if (probe?.type !== 'traverse' || probe.steps.length !== 1) {
        throw unsupported('this block head over a callback');
      }
      const step = probe.steps[0];
      if (step.type !== 'edge' || step.edgeTypeId !== CALLBACK_CALLED_EDGE) {
        throw unsupported(
          `'${head.hopsRaw}' on a callback`,
          `a callback has one edge, '${CALLBACK_CALLED_EDGE}'`,
        );
      }
      const sink = this.input.callbackSink;
      if (!sink) {
        throw unsupported(
          `cb-[:${CALLBACK_CALLED_EDGE}]->`,
          'this run has no callback sink — a callback needs the durable trigger-run substrate',
        );
      }
      const calls = await sink.calls(rootBinding.callbackId);
      return calls
        .filter((call) => this.callbackCallMatches(call, step.expressionFilter))
        .map((call) => {
          const landing = this.callbackCallBinding(call);
          const bindings = new Map<string, Binding>();
          if (step.alias !== undefined) bindings.set(step.alias, landing);
          return { bindings, landing };
        });
    }

    if (rootBinding.kind === 'nodePosition' || rootBinding.kind === 'lazyWalk') {
      // `d-[c:company]-> { … }` — the synthesised edge, fanned out. One landing
      // for a single nested literal, N for a list, and for a PASS-THROUGH edge
      // whatever its walk yields; an edge the literal never wrote runs the body
      // zero times, like any empty traversal.
      if (probe?.type !== 'traverse') {
        throw unsupported(`this block head over ${describeBinding[rootBinding.kind]}`);
      }
      return this.walkSynthesisedEdges(rootBinding, probe.steps, env);
    }

    if (rootBinding.kind === 'extractRoot' || rootBinding.kind === 'extractPosition') {
      // `extractedNode-[f:_resources]->` — the SOURCE CONTENT that fed this
      // node's extraction (Layer 5 provenance). Resolved IN-FLIGHT against the
      // resources the materialiser stamped onto the emission (the node is not a
      // persisted KG node yet — there is no readback). FILE resources carry the
      // source `FileRef`, so a write off this hop carries the file forward.
      if (probe?.type === 'resource_traverse') {
        const alias = RESOURCES_HEAD_ALIAS.exec(head.hopsRaw)?.[1];
        const resources = await this.filterResources(
          rootBinding.emission.resources,
          probe,
          env,
        );
        return resources.map((resource) => {
          const landing: Binding = binding({ kind: 'resource', resource });
          const bindings = new Map<string, Binding>();
          if (alias !== undefined) bindings.set(alias, landing);
          return { bindings, landing };
        });
      }
      if (probe?.type !== 'traverse') {
        throw unsupported('this block head over an extract result');
      }
      // Iterate emission PATHS so every hop alias binds its own level's
      // entity for the iteration.
      let paths: Array<{ aliases: Map<string, Binding>; emission: typeof rootBinding.emission }> = [
        { aliases: new Map(), emission: rootBinding.emission },
      ];
      for (const step of probe.steps) {
        if (step.type !== 'edge') {
          throw unsupported(`'${step.type}' hops in a block head over an extract result`);
        }
        if (step.expressionFilter) {
          throw unsupported('WHERE filters on extract-result block heads');
        }
        const next: typeof paths = [];
        for (const path of paths) {
          for (const child of path.emission.children.get(step.edgeTypeId) ?? []) {
            const aliases = new Map(path.aliases);
            if (step.alias !== undefined) {
              aliases.set(step.alias, binding({ kind: 'extractPosition', emission: child }));
            }
            next.push({ aliases, emission: child });
          }
        }
        paths = next;
      }
      return paths.map((p) => ({
        bindings: p.aliases,
        landing: binding({ kind: 'extractPosition' as const, emission: p.emission }),
      }));
    }

    // A graph-rooted head — `crm-[c:companies]-> { … }` (the backfill
    // shape, rooted at a constructed instance in-body) or a write handle
    // (`co-[c:contacts]-> { … }`, the write result IS a position) — streams
    // through THAT graph's adapter from its meta / stable position.
    if (rootBinding.kind === 'instance' || rootBinding.kind === 'handle') {
      if (probe?.type !== 'traverse') {
        throw unsupported(`this block head over ${describeBinding[rootBinding.kind]}`);
      }
      if (rootBinding.kind === 'handle' && startsWithOldEdge(probe.steps)) {
        return this.oldEdgeHeadIterations({ binding: rootBinding, head, root, probe, env });
      }
      const resolved = await this.graphReadFor(root, rootBinding);
      if (!resolved) {
        throw unsupported(`block heads rooted at '${root}' (a ${rootBinding.kind} binding)`);
      }
      return this.walkSourceHeadPaths({
        start: resolved.start,
        steps: probe.steps,
        env,
        read: resolved.read,
      });
    }

    if (rootBinding.kind === 'event' || rootBinding.kind === 'sourcePosition') {
      if (!this.source) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          'no event in scope for a source-graph block head',
        );
      }
      const start = rootBinding.kind === 'event' ? this.source.position : rootBinding.position;
      const read =
        rootBinding.kind === 'sourcePosition' && rootBinding.read !== undefined
          ? rootBinding.read
          : this.source;

      // `x-[f:_resources]->` — the position's resource bundle, resolved
      // through the same adapter path as the TG engine's resources edge.
      // The bridge parses a `_resources` hop to `resource_traverse`,
      // which carries the filter but NOT the alias or root — those are
      // lexical-only, read off the raw hop text exactly as the
      // checker's head-alias extraction does.
      //
      // Language versions 1–4 only (including their quirk: the bundle is read
      // through the EVENT's adapter whatever system the record belongs to).
      // Since version 5 `_resources` is an extraction's source content and
      // nothing else's — a system's record walks the edge its system declares
      // (`-[f:Attachments]->`, `-[f:Resources]->`), and the checker refuses
      // the hop (MOV_RESOURCES_NOT_EXTRACTED) before a run.
      if (probe?.type === 'resource_traverse' && since(this.languageVersion, 5)) {
        throw new MovementEngineError(
          'MOVENG_UNSUPPORTED',
          "'-[:_resources]->' is read only off an extraction's result since language version 5 — walk the edge the record's system declares to its files",
        );
      }
      if (probe?.type === 'resource_traverse') {
        const alias = RESOURCES_HEAD_ALIAS.exec(head.hopsRaw)?.[1];
        const resources = await this.filterResources(
          await resolvePositionResources({
            adapter: this.source.adapter,
            position: start,
            filter: probe.filter,
          }),
          probe,
          env,
        );
        return resources.map((resource) => {
          const landing: Binding = binding({ kind: 'resource', resource });
          const bindings = new Map<string, Binding>();
          if (alias !== undefined) {
            bindings.set(alias, landing);
          }
          return { bindings, landing };
        });
      }

      // Adapter-edge head: `root-[c:companies]->` off the meta position
      // (collection fan-out), `msg-[a:files]->` off a webhook record —
      // both stream through the source adapter's getRelated seam.
      if (probe?.type !== 'traverse') {
        throw unsupported(`this block head over ${describeBinding[rootBinding.kind]}`);
      }
      return this.walkSourceHeadPaths({ start, steps: probe.steps, env, read });
    }

    if (rootBinding.kind === 'blockMeta') {
      // A block head over a race receipt / block meta-node (asks-as-adapter
      // chunk C: `r-[res:result]-> { … }`, `r-[m:asks]-> { m-[x:a]-> … }`). Walk
      // the meta edges (mirrors expression.ts `walkMetaSteps`), binding each
      // hop's alias to that level's binding, one iteration per final path. An
      // edge that isn't there (an un-won branch) yields ZERO iterations — the
      // block runs zero times, which IS the gate (F6/S19). Source landings carry
      // their position for write-bridging; a handle/value binds without one.
      if (probe?.type !== 'traverse') {
        throw unsupported('this block head over a block meta-node');
      }
      let paths: Array<{ aliases: Map<string, Binding>; binding: Binding }> = [
        { aliases: new Map(), binding: rootBinding },
      ];
      for (const step of probe.steps) {
        if (step.type !== 'edge') {
          throw unsupported(`'${step.type}' hops in a block head over a block meta-node`);
        }
        if (step.expressionFilter) {
          throw unsupported('WHERE filters on block meta-node block heads');
        }
        const next: typeof paths = [];
        for (const path of paths) {
          for (const child of metaEdgeBindings(path.binding, step.edgeTypeId)) {
            const aliases = new Map(path.aliases);
            if (step.alias !== undefined) aliases.set(step.alias, child);
            next.push({ aliases, binding: child });
          }
        }
        paths = next;
      }
      return paths.map((p) => {
        const position = p.binding.kind === 'sourcePosition' ? p.binding.position : undefined;
        return {
          bindings: p.aliases,
          landing: p.binding,
          ...(position !== undefined ? { position } : {}),
        };
      });
    }
    if (rootBinding.kind === 'value') {
      // `found = MAP(pieces, (p) => { return extract … })` — a VALUE holding
      // positions. A collection op hands each answer back in the currency it
      // arrived in, so the members of that list are the extract roots
      // themselves; a hop off the list is that hop off each member,
      // concatenated in list order — exactly the reading a block's returned
      // records (`positions`) already get, and the one a list of anything gets
      // everywhere else. A single position held on the value plane (`AT(found,
      // 0)`) is that position, which is what a list of one means too.
      //
      // The head's own bracket (WHERE / ORDER BY / LIMIT) belongs to the hop,
      // so it applies off EACH root, like every other many-rooted head.
      const members = Array.isArray(rootBinding.value) ? rootBinding.value : [rootBinding.value];
      const perMember: BlockIteration[] = [];
      for (const member of members) {
        const position = bindingOf(member);
        if (position === undefined) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `${Array.isArray(rootBinding.value) ? `one of the values in '${root}' is` : `'${root}' is`} ${describeHeadValue(member)}, and a hop walks from a POSITION — there is nothing here to hop from. A block head starts at a record, an extraction's result, or a list of them ('MAP(pieces, (p) => { return extract … })').`,
          );
        }
        perMember.push(
          ...(await this.headIterationsFrom({ binding: position, head, root, probe, env })),
        );
      }
      return perMember;
    }

    throw unsupported(`block heads rooted at '${root}' (a ${rootBinding.kind} binding)`);
  }

  /**
   * `org-[w:@old]-> { … }` — the record before `org`'s write, which the handle
   * holds itself (no system has the edge): one iteration, or none when the
   * write created the record. Hops past it walk on from that record, as a
   * head rooted there would.
   */
  private async oldEdgeHeadIterations(opts: {
    binding: Extract<Binding, { kind: 'handle' }>;
    head: PathHead;
    root: string;
    probe: Extract<Expression, { type: 'traverse' }>;
    env: Environment;
  }): Promise<BlockIteration[]> {
    const [step, ...rest] = opts.probe.steps;
    const old = opts.binding.handle.old;
    if (old === undefined || step.type !== 'edge') return [];
    if (
      step.expressionFilter !== undefined
      && !(await hopFilterKeeps({ step, filter: step.expressionFilter, landed: old, ctx: this.exprContext(opts.env) }))
    ) {
      return [];
    }
    const aliases = new Map<string, Binding>(step.alias !== undefined ? [[step.alias, old]] : []);
    if (rest.length === 0) return [{ bindings: aliases, landing: old }];
    const onward = await this.headIterationsFrom({
      binding: old,
      head: opts.head,
      root: opts.root,
      probe: { ...opts.probe, steps: rest },
      env: opts.env,
    });
    return onward.map((iteration) => ({
      ...iteration,
      bindings: new Map([...aliases, ...iteration.bindings]),
    }));
  }

  /**
   * Walk the arrow plane of a synthesised node (or straight off a `lazy`
   * binding): each hop crosses one declared edge, fanning out over its
   * landings. A DEFERRED edge hands the REST of the chain to its stored walk —
   * past that edge the hops are hops in the source graph, and the source's own
   * walker owns them, filters and ordering included. Mirrors expression.ts
   * `walkMetaSteps`, which reads the same planes for expressions.
   */
  private async walkSynthesisedEdges(
    root: Extract<Binding, { kind: 'nodePosition' | 'lazyWalk' }>,
    steps: Extract<Expression, { type: 'traverse' }>['steps'],
    env: Environment,
  ): Promise<BlockIteration[]> {
    // A lazy binding IS the walk: the whole chain continues from it.
    if (root.kind === 'lazyWalk') return this.runDeferredWalk(root.walk, steps);
    return this.walkNodePlane([{ aliases: new Map(), binding: root }], steps, env);
  }

  private async walkNodePlane(
    paths: Array<{ aliases: Map<string, Binding>; binding: Binding }>,
    steps: Extract<Expression, { type: 'traverse' }>['steps'],
    env: Environment,
  ): Promise<BlockIteration[]> {
    if (steps.length === 0) {
      // A landing that IS a source record carries its position, so a write in
      // the body bridges to it exactly as it would off any traversal.
      return paths.map((p) => ({
        bindings: p.aliases,
        landing: p.binding,
        ...(p.binding.kind === 'sourcePosition' ? { position: p.binding.position } : {}),
      }));
    }
    const [step, ...rest] = steps;
    if (step.type !== 'edge') {
      throw unsupported(`'${step.type}' hops over a synthesised node`);
    }
    const reached: BlockIteration[] = [];
    for (const path of paths) {
      if (path.binding.kind === 'lazyWalk') {
        reached.push(
          ...(await this.continueDeferred(path.aliases, path.binding.walk, steps)),
        );
        continue;
      }
      if (path.binding.kind === 'sourcePosition') {
        // Past a pass-through edge we are in the SOURCE graph — the source's
        // own walker takes the rest of the chain, WHERE and ordering included.
        const read = path.binding.read ?? this.source;
        if (!read) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `no read seam for a hop off a landed position ('${step.edgeTypeId}')`,
          );
        }
        const onward = await this.walkSourceHeadPaths({
          start: path.binding.position,
          steps,
          env,
          read,
        });
        reached.push(
          ...onward.map((iteration) => ({
            ...iteration,
            bindings: new Map([...path.aliases, ...iteration.bindings]),
          })),
        );
        continue;
      }
      if (path.binding.kind !== 'nodePosition') {
        // A landing an appended `link` put here (a write handle, say) is a
        // position in ITS OWN graph, and this walker only knows the node plane.
        // Reaching it as the walk's DESTINATION is the early return above;
        // hopping PAST it needs the source walk, which starts from a head.
        throw unsupported(
          `hopping past a '${step.edgeTypeId}' landing that is ${describeBinding[path.binding.kind]}`,
          'traverse the edge into a block and walk on from the landing there',
        );
      }
      const edge = path.binding.edges[step.edgeTypeId];
      if (step.expressionFilter && edge?.kind === 'deferred') {
        throw unsupported(
          "WHERE filters on a lazy entry's hop",
          "narrow the entry's own traversal instead — the WHERE belongs on the hop the node's edge is built from",
        );
      }
      if (edge?.kind === 'deferred') {
        if (rest.length > 0 && step.alias !== undefined) {
          // The alias would name a position part-way through the merged walk,
          // and the walk binds its own hops' aliases, not this one. Loud
          // rather than quietly unbound.
          throw unsupported(
            `naming a deferred edge's landing ('${step.alias}') while hopping past it`,
            'drop the alias, or bind the deferred traversal above and traverse from there',
          );
        }
        reached.push(
          ...(await this.continueDeferred(path.aliases, edge.walk, rest, step.alias)),
        );
        continue;
      }
      // A landed edge holds its landings in hand — a local graph's own — so a
      // hop WHERE keeps the ones it holds for, by the keep decision every
      // walker makes.
      const next: Array<{ aliases: Map<string, Binding>; binding: Binding }> = [];
      for (const landing of edge?.kind === 'landed' ? edge.landings : []) {
        if (
          step.expressionFilter
          && !(await hopFilterKeeps({
            step,
            filter: step.expressionFilter,
            landed: landing,
            ctx: this.exprContext(env),
          }))
        ) {
          continue;
        }
        const aliases = new Map(path.aliases);
        if (step.alias !== undefined) aliases.set(step.alias, landing);
        next.push({ aliases, binding: landing });
      }
      reached.push(...(await this.walkNodePlane(next, rest, env)));
    }
    return reached;
  }

  /** Run a deferred walk and fold its iterations into the aliases already
   *  bound on the way in — the outer path's names stay visible inside. */
  private async continueDeferred(
    outer: Map<string, Binding>,
    walk: DeferredWalk,
    steps: Extract<Expression, { type: 'traverse' }>['steps'],
    alias?: string,
  ): Promise<BlockIteration[]> {
    const iterations = await this.runDeferredWalk(walk, steps);
    return iterations.map((iteration) => {
      const bindings = new Map(outer);
      for (const [name, binding] of iteration.bindings) bindings.set(name, binding);
      if (alias !== undefined && iteration.landing !== undefined) {
        bindings.set(alias, iteration.landing);
      }
      return { ...iteration, bindings };
    });
  }

  /**
   * Walk an adapter-edge block head: each hop streams the current
   * positions through the head's read seam (`iterateRelated` when the
   * adapter publishes it — snapshot fan-outs may be large — else
   * `getRelated`), honouring per-hop WHERE filters position-scoped,
   * then the hop's bracket ORDER BY / LIMIT per origin position, and
   * binding each hop alias to its own level's record per path. The
   * fieldId crossing the adapter boundary is position-sensitive: hops
   * off the meta root resolve as collections (typeId currency), record
   * hops as reference fields (see `SourceRead.edgeFieldId`).
   *
   * The fetch itself is `closedHopPushdown` — the same WHERE (closed over
   * the surrounding scope, so a name the author bound reaches the source as a
   * value), ORDER BY and LIMIT an expression hop or an EXISTS hop sends,
   * because the syntax promises the same records wherever the bracket is
   * written (plans/ordering-primitives-2026-09-04/1_decisions.md D1). What the
   * adapter does with it is its business: the engine filters, sorts and
   * slices what comes back regardless, so the answer never depends on it.
   */
  private async walkSourceHeadPaths(input: {
    start: SourcePosition;
    steps: Extract<Expression, { type: 'traverse' }>['steps'];
    env: Environment;
    /** The graph the head reads through — the movement's event source,
     *  or a graph-rooted head's own seam (graphReadFor). */
    read: SourceRead;
  }): Promise<BlockIteration[]> {
    const read = input.read;
    const adapter = read.adapter;
    /** The head's own seam rides each yielded binding only when it is
     *  NOT the event source (event-sourced reads keep resolving through
     *  ctx.source, as before). */
    const bindingRead = read === this.source ? undefined : read;
    let paths: Array<{
      aliases: Map<string, Binding>;
      position: SourcePosition;
      edgeProperties?: Record<string, unknown>;
    }> = [{ aliases: new Map(), position: input.start }];
    for (const step of input.steps) {
      if (step.type !== 'edge') {
        throw unsupported(`'${step.type}' hops in a block head over the source graph`);
      }
      if (step.direction === 'incoming' && !adapter.runtimeCapabilities().traversal.incoming) {
        throw unsupported(
          `incoming block-head hops ('${step.edgeTypeId}')`,
          `source adapter '${adapter.adapterType}' cannot traverse incoming edges`,
        );
      }
      const next: typeof paths = [];
      // Closed over the head's own scope, once for the hop — every origin
      // position in this level reads the same outer bindings.
      const pushdown = await closedHopPushdown({
        step,
        ctx: this.exprContext(input.env),
        edgeProperties: adapter.runtimeCapabilities().traversal.edgeProperties,
      });
      for (const path of paths) {
        // A WHERE that narrowed this hop to one member addresses THAT member;
        // records of the others are not matches and are never read from.
        const isMember = hopMemberGate({ step, origin: path.position, read });
        const fieldId = read.edgeFieldId?.(step.edgeTypeId, path.position) ?? step.edgeTypeId;
        const landed = adapter.iterateRelated
          ? adapter.iterateRelated({
              position: path.position,
              fieldId,
              direction: step.direction,
              ...pushdown,
            })
          : await adapter.getRelated({
              position: path.position,
              fieldId,
              direction: step.direction,
              ...pushdown,
            });
        const kept: typeof paths = [];
        for await (const r of landed) {
          if (!isMember(r.position)) continue;
          const edgeProperties =
            r.edgeProperties !== undefined ? { edgeProperties: r.edgeProperties } : {};
          const landing: Binding = binding({
            kind: 'sourcePosition',
            position: r.position,
            ...edgeProperties,
            ...(bindingRead !== undefined ? { read: bindingRead } : {}),
          });
          // Position-scoped, per landed record — `property` reads hit the
          // destination, `edge_property` reads the walked edge's inline
          // properties (the bracket-WHERE grammar's currency), and the hop's
          // alias names the landed record.
          if (
            step.expressionFilter &&
            !(await hopFilterKeeps({
              step,
              filter: step.expressionFilter,
              landed: landing,
              ctx: this.exprContext(input.env),
            }))
          ) {
            continue;
          }
          const aliases = new Map(path.aliases);
          if (step.alias !== undefined) aliases.set(step.alias, landing);
          kept.push({ aliases, position: r.position, ...edgeProperties });
        }
        // Bracket ORDER BY / LIMIT — per origin position, post-stream. The key
        // is read against the landed record, through the same reader an
        // expression hop uses, so the same bracket ranks the same way wherever
        // it is written.
        const readOrderKey = hopOrderKeyReader(step, this.exprContext(input.env));
        next.push(
          ...(await applyHopOrderLimit(kept, step.cardinality, {
            value: (item) =>
              readOrderKey(binding({
                kind: 'sourcePosition',
                position: item.position,
                ...(item.edgeProperties !== undefined
                  ? { edgeProperties: item.edgeProperties }
                  : {}),
                ...(bindingRead !== undefined ? { read: bindingRead } : {}),
              })),
          })),
        );
      }
      paths = next;
      if (paths.length === 0) return [];
    }
    return paths.map((p) => ({
      bindings: p.aliases,
      position: p.position,
      landing: binding({
        kind: 'sourcePosition' as const,
        position: p.position,
        ...(p.edgeProperties !== undefined ? { edgeProperties: p.edgeProperties } : {}),
        ...(bindingRead !== undefined ? { read: bindingRead } : {}),
      }),
    }));
  }

  /** Probe-parse a head's hop chain via the bridge (the checker's and
   *  probe convention: append a sentinel property read). */
  /**
   * Apply a `_resources` hop's filters: the legacy structured `filter`
   * (stored-AST compatibility) then the WHERE `expressionFilter`, evaluated
   * per resource with the resource in scope — the same per-landing semantics
   * as an adapter hop's bracket WHERE.
   */
  private async filterResources(
    resources: Resource[],
    probe: Extract<Expression, { type: 'resource_traverse' }>,
    env: Environment,
  ): Promise<Resource[]> {
    const structural = resources.filter((r) => matchesResourceFilter(r, probe.filter));
    if (!probe.expressionFilter) return structural;
    const kept: Resource[] = [];
    for (const resource of structural) {
      const keep = await evaluateMovementExpression(probe.expressionFilter, {
        ...this.exprContext(env),
        currentResource: resource,
      });
      if (keep) kept.push(resource);
    }
    return kept;
  }

  private probeHead(head: TraversalBlock['head']): Expression | undefined {
    try {
      return parseMovementExpression(
        `${probePathHead(head)}.\`__movement_engine_probe__\``,
      );
    } catch (e) {
      if (e instanceof BridgeError) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `invalid block head (the checker should have caught this): ${e.message}`,
        );
      }
      throw e;
    }
  }

  // ── Writes ──

  /**
   * A target that starts at a MEMBER PATH (`write m.k { … }`,
   * `write m.k-[:child]-> { … }`) starts at the record the path holds, bound
   * exactly as `x = m.k` binds it (`bindSlotValue`), into an environment of
   * the write's own under the path's spelling — so every step after this
   * reads a name, as the checker's `bindTargetRoots` has it. `undefined` when
   * every root is a name already.
   */
  private async bindTargetRoots(
    target: MatchTarget,
    env: Environment,
  ): Promise<{ target: MatchTarget; env: Environment } | undefined>;
  private async bindTargetRoots(
    target: WriteTarget,
    env: Environment,
  ): Promise<{ target: WriteTarget; env: Environment } | undefined>;
  private async bindTargetRoots(
    target: WriteTarget,
    env: Environment,
  ): Promise<{ target: WriteTarget; env: Environment } | undefined> {
    const paths: Array<{ name: string; expr: ExprSlot }> = [];
    const named = mapTargetRoots(target, (root) => {
      if (root.kind === 'name') return root;
      const name = memberPathBindingName(root.expr);
      if (name === undefined) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${root.expr.raw}' starts a write — only a name or a member path can, and the parser should have refused it`,
        );
      }
      paths.push({ name, expr: root.expr });
      return { kind: 'name', name };
    });
    if (paths.length === 0) return undefined;
    const own = env.child();
    for (const { name, expr } of paths) own.declare(name, await this.bindSlotValue(expr, env));
    return { target: named, env: own };
  }

  /** Returns the binding the write produced (a handle, or an in-memory
   *  shape position) — declared under `bindingName` when one is given,
   *  and the argument-adaptation currency for inline call args. */
  private async executeWrite(
    authored: WriteExpression,
    bindingName: string | undefined,
    env: Environment,
    body: BodyContext,
  ): Promise<Binding> {
    const rooted = await this.bindTargetRoots(authored.target, env);
    if (rooted !== undefined) {
      const written = await this.executeWrite({ ...authored, target: rooted.target }, bindingName, rooted.env, body);
      if (bindingName !== undefined) env.declare(bindingName, written);
      return written;
    }
    // A spread is the field lines it stands for — from here on nothing can
    // tell `...e` from the lines written out.
    const write: WriteExpression =
      authored.spreads === undefined
        ? authored
        : {
            ...authored,
            fields: expandWriteSpreads(authored, spreadFields),
          };
    if (write.target.kind === 'linked') {
      const rootBinding =
        pathRootName(write.target.path) !== undefined
          ? env.resolve(pathRootName(write.target.path)!)
          : undefined;
      if (rootBinding?.kind === 'shape') {
        return this.materializeShapeWrite(write, rootBinding, bindingName, env);
      }
      if (rootBinding?.kind === 'nodePosition') {
        return this.executeLocalWrite(write, write.target, rootBinding, bindingName, env, body);
      }
    }
    if (write.target.kind === 'position') {
      return this.executePositionWrite(write, write.target, bindingName, env);
    }
    const resolved = await this.resolveWriteTarget(write, env, 'write');
    const adapter = resolved.adapter;
    const { fields, fieldProvenance, fieldSemantics, fieldEvidence, resources, descriptor } =
      await this.evaluateWriteFields({ write, target: resolved, env });
    // The discriminant is a VALUE, so this waits for the body: what the write
    // creates is a row of the list the body named, and that is the type the
    // handle stands on from here on.
    const handleType = this.discriminatedHandleType(resolved, fields);
    const target: ResolvedWriteTarget =
      handleType !== undefined ? { ...resolved, handleType } : resolved;

    // Identity: `unique by (…)` ∪ the target's native constraints. The
    // adapter searches by the equality backbone; the engine post-filters by any
    // non-equality conjuncts (`WITHIN`, …); the shared arbitration module decides.
    const identity = this.uniqueByIdentity(write, target);
    const constraints = mergeUniqueness(descriptor?.uniquenessConstraints, identity.constraints);

    // Edge-scoped COMPOUND IDENTITY (not correspondence): when a constraint
    // names the EDGE to one of the write's already-resolved parents, fold that
    // neighbour into the resolve record under the edge's NATURAL name — the
    // adapter then matches by adjacency through the same opaque `record[field]`
    // lookup it uses for property values. ALL tuple parents fold in
    // (consolidate's AND semantics). This powers `unique by (parent AND field)`
    // and is independent of binding/correspondence — it stays.
    const resolveRecord = this.identityRecord({ fields, identity, constraints, target });

    // Parent → child links, forwarded to the adapter so it wires the
    // relationships at write time (KG: insert/resolve every connecting
    // edge inside the write's transaction; external adapters set the
    // named references on the create payload). Only parents that
    // actually produced a record contribute. A linked write is just the
    // 1-element case of the general N-parent list — the engine always
    // hands the adapter `parentLinks` (0/1/N).
    const parentLinks = target.parents.flatMap((p) =>
      p.externalId !== undefined
        ? [{
            recordType: p.recordType,
            externalId: p.externalId,
            edgeName: p.edgeName,
            ...(p.data !== undefined ? { data: p.data } : {}),
          }]
        : [],
    );

    // A bound write (`write … bind other { … }`) takes the engine-owned
    // BINDING path: correspondence is the identity, `unique by` is ignored,
    // and the engine maintains the link itself through the adapter's normal
    // create / update-by-id (3b). A plain write takes the identity-resolve
    // path (`unique by` ∪ native constraints).
    if (write.bind !== undefined && target.where.length > 0) {
      // The checker's MOV_TARGET_WHERE_BIND, held at run time too: the binding
      // is the identity, so the WHERE would narrow nothing — and saying nothing
      // is how it was ignored before.
      throw unsupported(
        `a WHERE on the target of a 'bind ${write.bind.name}' write`,
        "a bound write's identity is the binding — drop the WHERE, or the bind",
      );
    }
    const handle =
      write.bind !== undefined
        ? await this.executeBindWrite({
            write,
            bind: write.bind,
            target,
            adapter,
            descriptor,
            fields,
            fieldSemantics,
            fieldEvidence,
            resources,
            parentLinks,
            env,
          })
        : await this.executeResolvedWrite({
            target,
            adapter,
            descriptor,
            resolveRecord,
            constraints,
            identityNarrowings: identity.narrowings,
            ...this.candidateWhere(target, env),
            fields,
            fieldSemantics,
            fieldEvidence,
            resources,
            parentLinks,
            body,
            handle: { targetType: target.handleType ?? target.recordType, graph: target.graph },
          });

    return this.recordWrite({
      write: handle,
      bindingName,
      env,
      target,
      fieldProvenance,
      rehearsed: !this.committedThrough(adapter),
    });
  }

  /**
   * The record the adapter searches by: the asserted fields, the literal
   * values a `unique by` pinned, and — edge-scoped COMPOUND IDENTITY, not
   * correspondence — each already-resolved parent whose EDGE a constraint
   * names, folded in under the edge's NATURAL name so the adapter matches by
   * adjacency through the same opaque `record[field]` lookup it uses for
   * property values. ALL tuple parents fold in (consolidate's AND semantics).
   * This powers `unique by (parent AND field)`.
   */
  private identityRecord(input: {
    fields: Record<string, unknown>;
    identity: { valueOverlay: Record<string, unknown> };
    constraints: UniquenessConstraints;
    target: Pick<ResolvedWriteTarget, 'parents'>;
  }): Record<string, unknown> {
    const record: Record<string, unknown> = { ...input.fields, ...input.identity.valueOverlay };
    const constraintFields = new Set(
      input.constraints.any.flatMap((branch) => branch.all.map((entry) => entry.field)),
    );
    // An empty key is no key: a text nobody found is handed over as "", and
    // two records sharing "" are not the same record. Every adapter already
    // reads a null key component as "cannot match on this", so blank becomes
    // null here, once, instead of in each adapter's search.
    for (const field of constraintFields) {
      if (isBlankIdentityValue(record[field])) record[field] = null;
    }
    for (const parent of input.target.parents) {
      if (parent.externalId === undefined) continue;
      if (constraintFields.has(parent.edgeName)) {
        record[parent.edgeName] = { id: parent.externalId };
      }
    }
    return record;
  }

  /**
   * The identity half of every write and every match: the adapter searches by
   * the effective constraints, the engine narrows the shortlist by any
   * non-equality conjuncts, and the shared module arbitrates (an exact hit
   * wins outright, a lone fuzzy hit goes to the judge). Returns the chosen
   * candidate, or undefined when nothing matched.
   *
   * `judgeUnavailable` distinguishes "the judge looked and genuinely declined"
   * from "the judge never got an answer" — both leave `matched` undefined, but
   * only the second is a caveat the caller must carry (2026-09-15, the entity
   * judge routing incident: a judge call that always failed read identically
   * to an honest decline and created duplicates silently).
   *
   * `candidates: []` — the cross-adapter `resolveEntity` interface keeps the
   * `candidates` slot for the FROZEN TG engine (P7); identity is `constraints`.
   */
  private async resolveIdentity(input: {
    adapter: Adapter;
    recordType: string;
    resolveRecord: Record<string, unknown>;
    constraints: UniquenessConstraints;
    identityNarrowings: IdentityNarrowing[];
    /** The target's final-hop `WHERE` — see `CandidateWhere`. */
    candidateWhere?: CandidateWhere;
    /** What the body asserted — what exactness is judged against and what
     *  the judge reads. */
    asserted: Record<string, unknown>;
  }): Promise<{ matched: ExternalRecordRef | undefined; judgeUnavailable?: string }> {
    const predicateNarrowed = await this.identityShortlist(input);
    // The target's WHERE runs LAST, on the smallest list: it reads each
    // candidate as the record it is (and may walk its edges), so it pays per
    // candidate what the coarse search and the pure conjuncts paid once.
    const candidates =
      input.candidateWhere !== undefined
        ? await this.narrowCandidatesByTargetWhere({
            candidates: predicateNarrowed,
            adapter: input.adapter,
            recordType: input.recordType,
            where: input.candidateWhere,
          })
        : predicateNarrowed;
    let judgeUnavailable: string | undefined;
    const chosen = await arbitrateEntityCandidates({
      asserted: input.asserted,
      candidates,
      recordType: input.recordType,
      constraints: input.constraints,
      onJudgeUnavailable: (message) => {
        judgeUnavailable = message;
      },
    });
    // The index is into the list the arbiter saw — the narrowed one.
    return {
      matched: chosen !== null ? candidates[chosen] : undefined,
      ...(judgeUnavailable !== undefined ? { judgeUnavailable } : {}),
    };
  }

  /**
   * The candidates the identity lookup finds, each already narrowed by the
   * non-key conjuncts of the `unique by` clause that found it. With no such
   * conjuncts the keys are searched together, in one lookup. With any, each key
   * is searched on its own, so a clause's narrowing applies to exactly the
   * candidates its key found (a candidate another key found stands on that
   * key); the lists are merged in key order, first sighting kept.
   */
  private async identityShortlist(input: {
    adapter: Adapter;
    recordType: string;
    resolveRecord: Record<string, unknown>;
    constraints: UniquenessConstraints;
    identityNarrowings: IdentityNarrowing[];
  }): Promise<ExternalRecordRef[]> {
    const search = async (constraints: UniquenessConstraints) =>
      (
        await input.adapter.resolveEntity({
          record: input.resolveRecord,
          recordType: input.recordType,
          candidates: [],
          constraints,
        })
      ).candidates;
    if (input.identityNarrowings.length === 0) return search(input.constraints);
    const shortlist: ExternalRecordRef[] = [];
    const seen = new Set<string>();
    for (const key of input.constraints.any) {
      // By reference: `mergeUniqueness` carries the authored keys over as they
      // are, next to the target's own (which no clause narrows).
      const narrowing = input.identityNarrowings.find((n) => n.key === key);
      const found = await search({ any: [key] });
      const kept =
        narrowing !== undefined
          ? await this.narrowCandidatesByPredicate({
              candidates: found,
              predicate: narrowing.filter,
              adapter: input.adapter,
              recordType: input.recordType,
            })
          : found;
      for (const candidate of kept) {
        if (seen.has(candidate.externalId)) continue;
        seen.add(candidate.externalId);
        shortlist.push(candidate);
      }
    }
    return shortlist;
  }

  /**
   * The identity-resolve write path (no `bind`): the adapter searches by the
   * effective `unique by` ∪ native constraints, the shared module arbitrates,
   * and a match updates / a miss creates. Correspondence is NOT established
   * here — the old implicit KG bridge is gone; a write that wants the next
   * event to resolve to the same record declares `bind` (3b: no back-compat
   * for the implicit bridge; the engine's old auto-bridge is removed).
   *
   * `candidates: []` — the cross-adapter `resolveEntity` interface keeps the
   * `candidates` slot for the FROZEN TG engine (P7), but the live engine no
   * longer pre-loads correspondence rows here; identity is `constraints`.
   *
   */
  private async executeResolvedWrite(input: ResolvedWriteInput): Promise<WriteRecord> {
    const { target, adapter } = input;
    // Find-then-create: held from the search until the record exists, so a
    // flow writing the same key meanwhile finds this one's record.
    const locks = identityLocks({
      system: adapter,
      recordType: target.recordType,
      constraints: input.constraints,
      resolveRecord: input.resolveRecord,
      fields: input.fields,
    });
    return this.effectLocks.withLocks(locks, () => this.findThenWrite(input));
  }

  private async findThenWrite(input: ResolvedWriteInput): Promise<WriteRecord> {
    const { target, adapter } = input;
    const { matched, judgeUnavailable } = await this.resolveIdentity({
      adapter,
      recordType: target.recordType,
      resolveRecord: input.resolveRecord,
      constraints: input.constraints,
      identityNarrowings: input.identityNarrowings,
      ...(input.candidateWhere ? { candidateWhere: input.candidateWhere } : {}),
      asserted: input.fields,
    });
    const matchedExternalId = matched?.externalId;

    if (matchedExternalId !== undefined) {
      const updated = await this.applyUpdate({
        adapter,
        recordType: target.recordType,
        externalId: matchedExternalId,
        fields: input.fields,
        fieldSemantics: input.fieldSemantics,
        fieldEvidence: input.fieldEvidence,
        resources: input.resources,
        parentLinks: input.parentLinks,
        ...(input.updateLocks !== undefined ? { locks: await input.updateLocks(matchedExternalId) } : {}),
        ...(input.handle !== undefined && matched !== undefined
          ? {
              prior: {
                ...input.handle,
                data: { ...(matched.url !== undefined ? { url: matched.url } : {}), ...matched.data },
              },
            }
          : {}),
      });
      // A record resolved by identity moments ago is essentially never gone;
      // if the adapter nonetheless reports not-found, fall through to create.
      if (!('notFound' in updated)) return updated;
    }
    const created = await this.applyCreate({
      adapter,
      recordType: target.recordType,
      fields: input.fields,
      fieldEvidence: input.fieldEvidence,
      resources: input.resources,
      descriptor: input.descriptor,
      parentLinks: input.parentLinks,
      isRoot: target.parents.length === 0,
    });
    if (judgeUnavailable !== undefined) {
      created.note = `judge unavailable: ${judgeUnavailable}; created rather than merged`;
    }
    return created;
  }

  /**
   * The engine-owned BIND write path (`write … bind other { … }`): the author
   * declares "this written record IS the counterpart of `other`," and the
   * engine maintains a generic, symmetric binding across any pair of systems —
   * the adapter stays correspondence-agnostic (3b). Flow:
   *
   *   1. Resolve `other`'s position endpoint + the target's instance endpoint.
   *   2. Look up the binding for `other` constrained to the target instance.
   *      • LIVE binding → `updateRecord(by id)` on the TARGET adapter. If the
   *        adapter reports NOT-FOUND (record deleted externally), delete the
   *        stale binding and fall through to (3) — the SELF-HEAL.
   *   3. No / healed binding → `createRecord`, then record the new symmetric
   *      binding `other ↔ new record`.
   *
   * A bound write ALWAYS asserts the link and IGNORES `unique by`. R1 (the
   * correctness gate): re-fire → exactly one target record; a 404'd target
   * self-heals to one fresh record + one fresh binding.
   *
   */
  private async executeBindWrite(input: {
    write: WriteExpression;
    bind: NonNullable<WriteExpression['bind']>;
    target: ResolvedWriteTarget;
    adapter: Adapter;
    descriptor: Awaited<ReturnType<Adapter['describe']>>;
    fields: Record<string, unknown>;
    fieldSemantics: Record<string, FieldWriteMode>;
    fieldEvidence: Record<string, FieldEvidence>;
    /** Layer-5 node-level resource provenance — forwarded to the create/update
     *  as `WriteInput.resources`. */
    resources: Resource[];
    parentLinks: ParentLink[];
    env: Environment;
  }): Promise<WriteRecord> {
    const { target, adapter, descriptor } = input;
    const other = await this.bindEndpointOf(input.bind.name, input.env);
    // The target's instance endpoint, with the recordId still unknown — the
    // binding lookup resolves "what record in this instance corresponds to
    // `other`?". The stable internal type id comes from the descriptor the
    // engine already loaded (`describe` — no new adapter surface).
    const targetInstance = this.bindInstanceContext(target.graph);
    const targetTypeId = descriptor?.typeId ?? target.recordType;

    const create = async (): Promise<WriteRecord> => {
      const created = await this.applyCreate({
        adapter,
        recordType: target.recordType,
        fields: input.fields,
        fieldEvidence: input.fieldEvidence,
        resources: input.resources,
        descriptor,
        parentLinks: input.parentLinks,
        isRoot: target.parents.length === 0,
      });
      if (created.externalId !== undefined && !this.input.dryRun) {
        await recordBinding({
          teamId: this.input.teamId,
          from: other,
          to: {
            adapterType: adapter.adapterType,
            ...targetInstance,
            typeId: targetTypeId,
            recordId: created.externalId,
          },
        });
      }
      return created;
    };

    const counterpart = { adapterType: adapter.adapterType, ...targetInstance, typeId: targetTypeId };
    // Find-then-create on the correspondence: held until the binding is
    // recorded, so two flows binding the same counterpart create one record.
    return this.effectLocks.withLocks([bindLock(other, counterpart)], async () => {
      const bound = await findBoundCounterpart({
        teamId: this.input.teamId,
        endpoint: other,
        counterpart,
      });
      if (bound === null) return create();

      // LIVE binding — update the bound target by id. The binding IS the
      // identity, so no resolveEntity / unique-by.
      const updated = await this.applyUpdate({
        adapter,
        recordType: target.recordType,
        externalId: bound.recordId,
        fields: input.fields,
        fieldSemantics: input.fieldSemantics,
        fieldEvidence: input.fieldEvidence,
        resources: input.resources,
        parentLinks: input.parentLinks,
        // The binding found the record, so the write's handle has an `@old`;
        // all that is known of it is what the merge reads back.
        prior: { data: {}, targetType: target.handleType ?? target.recordType, graph: target.graph },
      });
      if (!('notFound' in updated)) return updated;

      // SELF-HEAL — the bound target was deleted externally. Drop the stale
      // binding (keyed on the counterpart's exact stored components), then
      // create a fresh record + record a fresh binding.
      if (!this.input.dryRun) {
        await deleteBinding({ teamId: this.input.teamId, from: other, to: bound });
      }
      return create();
    });
  }

  /** The non-record-id components of a target's binding endpoint — the
   *  instance identity (credential + construction config) the binding store
   *  keys on. Undefined graph ⇒ neither is known, which is the same endpoint
   *  a construction-free, credential-free instance keys. */
  private bindInstanceContext(graph: HandleGraph | undefined): {
    credentialId?: string;
    constructionConfig?: Record<string, string>;
  } {
    if (graph === undefined) return {};
    const instance = graph.instance;
    const credentialId = this.credentialsIdFor(instance);
    return {
      ...(credentialId !== undefined ? { credentialId } : {}),
      ...(instance.constructionConfig !== undefined
        ? { constructionConfig: instance.constructionConfig }
        : {}),
    };
  }

  /**
   * Resolve `bind other`'s name to its fully-qualified binding endpoint — the
   * `(adapterType, instanceKey, typeId, recordId)` the binding store keys on.
   * The checker has already constrained `other` to a stable record position
   * (a write handle or a traversed source record), so at runtime it is a
   * `handle` (a prior write result) or a `sourcePosition` (a traversed
   * record). The stable INTERNAL type id is resolved via the position's own
   * adapter `describe` (the natural type name → its stable id), so a type
   * rename never orphans the binding.
   */
  private async bindEndpointOf(name: string, env: Environment): Promise<BindingEndpoint> {
    const binding = env.resolve(name);
    if (binding === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'bind ${name}' — '${name}' is not in scope (the checker should have caught this)`,
      );
    }

    // The position's adapter type, record id, natural type, the graph its
    // instance identity comes from, and the adapter to resolve its stable type
    // id through. Each branch narrows the binding kind, so the adapter is
    // captured WITHOUT a cast.
    let adapterType: string;
    let recordId: string | undefined;
    let naturalType: string | undefined;
    // Undefined where the position came from a read seam of its own — the
    // seam names the adapter, not a construction, so there is no instance
    // identity to key on beyond the adapter itself.
    let graph: HandleGraph | undefined;
    let adapter: Adapter;

    if (binding.kind === 'handle') {
      adapterType = binding.handle.adapterType;
      recordId = binding.handle.externalId;
      naturalType = binding.handle.recordType;
      graph = binding.graph;
      adapter = await this.targetAdapterFor(graph.instance);
    } else if (binding.kind === 'sourcePosition') {
      const position = binding.position;
      adapterType = position.adapterType;
      recordId = positionRecordId(position);
      naturalType = position.recordType ?? undefined;
      // A traversed source record's instance is the read seam it was yielded
      // from, else the movement's source instance.
      const sourceInstance = binding.read === undefined ? this.sourceInstance : undefined;
      graph =
        sourceInstance !== undefined ? { kind: 'instance', instance: sourceInstance } : undefined;
      if (binding.read !== undefined) {
        adapter = binding.read.adapter;
      } else if (sourceInstance !== undefined) {
        adapter = await this.targetAdapterFor(sourceInstance);
      } else {
        throw this.unnamedGraph(`'bind ${name}'`, name);
      }
    } else {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'bind ${name}' — '${name}' is ${describeBinding[binding.kind]}, not a stable record (the checker should have caught this)`,
      );
    }

    if (recordId === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'bind ${name}' — '${name}' has no stable record id to bind to`,
      );
    }

    // Resolve the stable internal type id from the natural type via the
    // position's own adapter (no new adapter surface — `describe` is uniform).
    let typeId = naturalType ?? '';
    if (naturalType !== undefined) {
      const descriptor = await adapter.describe(naturalType);
      if (descriptor) typeId = descriptor.typeId;
    }

    const instanceContext = this.bindInstanceContext(graph);
    return {
      adapterType,
      ...instanceContext,
      typeId,
      recordId,
    };
  }

  /**
   * Evaluate a write's body fields against an already-resolved target —
   * shared by the create/upsert path (`executeWrite`) and the in-place
   * update path (`executePositionWrite`). Field keys stay the program's
   * NATURAL names (the adapter resolves them to its own ids internally),
   * each value carrying its trail (E4); `?:` fields are collected for the
   * set-if-empty gate.
   *
   * `describe` is called with the NATURAL type name (the adapter translates),
   * and its descriptor is read by NATURAL name — `displayName` for fields —
   * since the internal `fieldId` is adapter-private (Decision #6). Cardinality
   * coercion and field-function advertisement both key on the displayName.
   */
  private async evaluateWriteFields(input: {
    write: IdentityBody;
    target: WriteDestination;
    env: Environment;
  }): Promise<{
    fields: Record<string, unknown>;
    fieldProvenance: Record<string, Provenance>;
    fieldSemantics: Record<string, FieldWriteMode>;
    fieldEvidence: Record<string, FieldEvidence>;
    /** Node-level resource provenance (Layer 5) — the SOURCE CONTENT that fed
     *  the extracted node(s) this write draws from. Rides `WriteInput.resources`
     *  so `persistKgResources` records the source file/text against the written
     *  node. Empty when no field reads an extracted node. */
    resources: Resource[];
    descriptor: Awaited<ReturnType<Adapter['describe']>>;
  }> {
    const { write, target, env } = input;
    const adapter = target.adapter;
    const descriptor = await adapter.describe(target.recordType);
    // Keyed by the field's NATURAL name (`displayName`) — the currency the
    // write body, cardinality coercion and field functions all speak.
    const fieldsByName = new Map<string, SchemaFieldDescriptor>(
      (descriptor?.fields ?? []).map((f) => [f.displayName, f]),
    );

    // Field values, in author order, keyed by the field's natural name.
    // `undefined` means "leave alone" — the field is omitted from the write
    // (mirrors the TG engine).
    const fields: Record<string, unknown> = {};
    const fieldProvenance: Record<string, Provenance> = {};
    // Per-field write-precedence, by natural name (absent ⇒ replace). `?:` fill,
    // `+:` append, `+?:` append-if-missing. The engine applies the merge against
    // current values in `applyUpdate`; on a create all modes are a plain set.
    const fieldSemantics: Record<string, FieldWriteMode> = {};
    for (const field of write.fields) {
      const fieldName = field.name;
      const { value: raw, provenance } = await this.evaluateSlot(field.value, {
        env,
        // Functions this destination field advertises, bound to the
        // TARGET adapter — the frozen field-mapping pipeline's binding,
        // mirrored (engine/evaluate.ts bindFieldFunctions). The natural type
        // + field name cross the boundary; the adapter translates.
        fieldFunctions: bindMovementFieldFunctions({
          targetAdapter: adapter,
          recordType: target.recordType,
          fieldId: fieldName,
          descriptor: fieldsByName.get(fieldName),
        }),
      });
      if (raw === undefined) continue;
      fields[fieldName] = coerceValueForFieldCardinality(raw, fieldsByName.get(fieldName));
      fieldProvenance[fieldName] = provenance;
      if (field.semantics !== undefined) fieldSemantics[fieldName] = field.semantics;
    }

    // Per-field evidence for the adapter contract — the TG rule (only a
    // provenance-faithful extracted value earns a citation); adapters
    // without an evidence sink ignore it.
    const fieldEvidence: Record<string, FieldEvidence> = {};
    for (const [name, provenance] of Object.entries(fieldProvenance)) {
      const evidence = fieldEvidenceFromProvenance(provenance);
      if (evidence) fieldEvidence[name] = evidence;
    }

    // Layer 5 — node-level resource provenance. Collect the source content of
    // every extracted node this write draws from: the materialiser stamped the
    // `from [...]` resources (source files + text) onto the extract emissions,
    // and the write's record IS that node's materialisation, so its source
    // resources persist against the written record (`WriteInput.resources`).
    const resources = this.collectWriteResources(write, env);

    return { fields, fieldProvenance, fieldSemantics, fieldEvidence, resources, descriptor };
  }

  /**
   * The source resources an `extract`-fed write carries (Layer 5 provenance).
   * A write's fields read from extract bindings (`d.\`name\``); the extracted
   * node's source content (the `from [...]` files + text the materialiser
   * stamped onto the emission) is what fed it. We resolve the bare identifier
   * tokens in each field's source text against `env` and union the source
   * resources of every `extractRoot`/`extractPosition` binding referenced —
   * deduped by the stable resource `id` so the same source file contributes
   * once. Over-collection is harmless: `persistKgResources` dedups on `id`.
   */
  private collectWriteResources(write: IdentityBody, env: Environment): Resource[] {
    const seen = new Set<string>();
    const out: Resource[] = [];
    const consider = (name: string): void => {
      const binding = env.resolve(name);
      if (binding?.kind !== 'extractRoot' && binding?.kind !== 'extractPosition') return;
      for (const resource of binding.emission.resources) {
        const key = resource.id ?? resource.externalId;
        if (key !== undefined) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        out.push(resource);
      }
    };
    for (const field of write.fields) {
      for (const name of referencedIdentifiers(field.value.raw)) consider(name);
    }
    return out;
  }

  /**
   * `write a { … }` — update the record bound at alias `a` in place. The
   * unification: a write result IS a position, so a position read earlier
   * in the program (a traversal alias, or a prior write's handle) can be
   * the write's target. The record is ALREADY identified — its stable
   * `recordId` is the value `updateRecord` consumes — so there is no
   * entity resolution, no required-field create-gate, no bridge insert.
   * An unstable position (an inbound payload, an extracted node, a
   * dry-run/no-op write that produced no id) has no record to update; the
   * checker rejects most of these statically, and this re-checks at
   * runtime for the cases the checker can't see (untyped graphs).
   */
  private async executePositionWrite(
    write: WriteExpression,
    target: Extract<WriteExpression['target'], { kind: 'position' }>,
    bindingName: string | undefined,
    env: Environment,
  ): Promise<Binding> {
    // A member-path root is bound to a name before a write runs
    // (`bindTargetRoots`), so the root here is a name.
    const alias = pathRootName(target);
    if (alias === undefined) {
      throw new MovementEngineError('MOVENG_RUNTIME', `'write ${spellPathRoot(target.root)} { … }' reached the update path unbound`);
    }
    const binding = env.resolve(alias);
    if (binding?.kind === 'nodePosition') {
      return this.executeLocalPositionWrite(write, { alias, landing: binding }, bindingName, env);
    }
    const resolved = await this.resolvePositionWriteTarget(alias, binding, env);

    const { fields, fieldProvenance, fieldSemantics, fieldEvidence, resources } =
      await this.evaluateWriteFields({ write, target: resolved.target, env });

    const handle = await this.applyUpdate({
      adapter: resolved.target.adapter,
      recordType: resolved.target.recordType,
      externalId: resolved.externalId,
      fields,
      fieldSemantics,
      fieldEvidence,
      resources,
      parentLinks: [],
      prior: {
        data: knownRecordData(binding),
        targetType: resolved.target.recordType,
        graph: resolved.target.graph,
      },
    });
    // A position write updates a record the author already holds; there is no
    // identity to re-resolve and nothing to self-heal. If the adapter reports
    // it gone, that is a genuine runtime error — fail loud.
    if ('notFound' in handle) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'write ${alias} { … }' — the record (${resolved.target.adapter.adapterType} ${resolved.externalId}) no longer exists`,
      );
    }

    // Through a write's handle, the record before this write is that handle
    // as it stood — its own `@old` included, so the chain walks back through
    // every write. A found record or a landing is snapshotted from what was
    // known of it (the merge did that above). Version 4 on, as `@old` is.
    const written =
      binding?.kind === 'handle' && isWrittenHandle(binding) && since(this.languageVersion, 4)
        ? binding
        : undefined;
    if (written !== undefined) handle.old = snapshotOfHandle(written);
    return this.recordWrite({
      write: handle,
      bindingName,
      env,
      target: resolved.target,
      fieldProvenance,
      rehearsed: !this.committedThrough(resolved.target.adapter),
      // `write org { … }` is a mutation of the record `org` names, not a
      // rebinding (`org` is never bound twice): since 4 the handle moves on to
      // the new record in place, so every scope holding it — an enclosing
      // body past an `if` arm, a closure, a second name — reads the update.
      // Before 4 `org` keeps the values of its own write.
      ...(written !== undefined ? { into: written } : {}),
    });
  }

  /**
   * `write e { … }` where `e` is a landing the run holds on one of its own
   * edges — the run's graph is the record's system, and it updates by id.
   *
   * Nothing here is a second update path: the engine stands in as the adapter
   * over the one landing (`localEdgeAdapter`) and the ordinary merge runs on
   * top of it, so `?:` / `+:` read the landing's current values exactly as
   * they read a system record's. The landing object IS the record every other
   * name holds, so the merge is seen by every later read, and its place on its
   * edge never moves. Its nested edges are not fields, and nothing here
   * touches them.
   *
   * The update holds the record (`localRecordLock`), as any update does: two
   * flows of a MAP updating the same landing merge one after the other, and
   * two updating different landings never wait for each other.
   *
   * The firing log gets the row a local create gets — `local`, no
   * `externalId`, `committed: false` — because nothing left the run.
   */
  private async executeLocalPositionWrite(
    write: WriteExpression,
    target: { alias: string; landing: Extract<Binding, { kind: 'nodePosition' }> },
    bindingName: string | undefined,
    env: Environment,
  ): Promise<Binding> {
    const { alias, landing } = target;
    const edgeName = landing.landedOn;
    if (edgeName === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'write ${alias} { … }' — '${alias}' is a node this run synthesised, not a record on one of its edges, so there is no record to update. Write it onto an edge ('write node-[:edge]-> { … }') and update what that hands back`,
      );
    }
    const store = localEdgeAdapter({ edge: { kind: 'landed', landings: [landing] }, edgeName });
    const destination: WriteDestination = { adapter: store.adapter, recordType: edgeName, parents: [] };
    const { fields, fieldProvenance, fieldSemantics, fieldEvidence, resources } =
      await this.evaluateWriteFields({ write, target: destination, env });
    const record = await this.applyUpdate({
      adapter: store.adapter,
      recordType: edgeName,
      externalId: '0',
      fields,
      fieldSemantics,
      fieldEvidence,
      resources,
      parentLinks: [],
      locks: [localRecordLock(landing)],
    });
    if ('notFound' in record) {
      throw new MovementEngineError('MOVENG_RUNTIME', `'write ${alias} { … }' — the landing on '${edgeName}' is gone`);
    }
    // The trail of each value actually SENT; a field the fill gate suppressed
    // keeps the trail it had.
    for (const field of Object.keys(record.writtenValues)) {
      landing.fieldProvenance[field] = fieldProvenance[field] ?? NO_PROVENANCE;
    }
    const { externalId: _local, ...row } = record;
    this.recordLocalWrite({
      record: { ...row, committed: false, local: { edge: edgeName } },
      fieldProvenance,
      bindingName,
    });
    if (bindingName !== undefined) env.declare(bindingName, landing);
    return landing;
  }

  /**
   * Resolve a bare-alias write target to its update destination: the
   * adapter + engine-currency record type, plus the stable `recordId`
   * `updateRecord` consumes. Both binding kinds that carry a durable
   * record qualify — a `sourcePosition` (a traversal alias; its `read` is
   * the graph it was yielded from) and a write `handle` (a prior write
   * result, already a written position). Throws if the alias isn't a
   * record position or has no stable identity (the checker catches the
   * typed cases; this is the runtime backstop, and the only gate for
   * untyped graphs).
   */
  private async resolvePositionWriteTarget(
    alias: string,
    binding: Binding | undefined,
    env: Environment,
    action: 'update' | 'delete' = 'update',
  ): Promise<{ target: ResolvedWriteTarget; externalId: string }> {
    if (binding === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${alias}' is not in scope — the checker should have caught this`,
      );
    }

    if (binding.kind === 'sourcePosition') {
      const { identity, recordType } = binding.position;
      if (identity.kind !== 'stable') {
        throw this.unstablePositionWrite(alias);
      }
      if (recordType === null) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `can't ${action} '${alias}' — its record type is unknown (an un-narrowed position). Narrow it with an IS test first`,
        );
      }
      const read = binding.read ?? this.source;
      if (!read) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${alias}' has no read seam — its graph is unknown, so it can't be ${action}d`,
        );
      }
      // The write goes through the TARGET adapter seam (role: 'target',
      // dry-run-wrapped) — never the read adapter directly — so a position
      // write is captured under dry run exactly like a create. The position's
      // `recordType` is the NATURAL type name (the source-read wrapper stamps
      // it); it crosses the write boundary as-is and the adapter translates.
      const instance = env.resolve(read.instanceName);
      if (instance?.kind !== 'instance') {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `can't ${action} '${alias}' — its graph '${read.instanceName}' is not a constructed instance in scope`,
        );
      }
      return {
        target: {
          adapter: await this.targetAdapterFor(instance),
          recordType,
          graph: { kind: 'instance', instance },
          parents: [],
          where: [],
        },
        externalId: identity.recordId,
      };
    }

    if (binding.kind === 'handle') {
      if (binding.handle.externalId === undefined) {
        throw this.unstablePositionWrite(alias);
      }
      const graph = binding.graph;
      const adapter = await this.targetAdapterFor(graph.instance);
      return {
        target: {
          adapter,
          // The handle's type is the program's natural name; the adapter
          // translates.
          recordType: binding.targetType,
          graph,
          parents: [],
          where: [],
        },
        externalId: binding.handle.externalId,
      };
    }

    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `'${alias}' is ${describeBinding[binding.kind]} — '${action === 'delete' ? `delete ${alias}` : `write ${alias} { … }`}' needs a record position (a traversal alias or a prior write result)`,
    );
  }

  /**
   * The engine could not name the system a record came from, so a write rooted
   * off it has no target.
   *
   * There is no authoring affordance for an unnamed write target — the grammar
   * has no unnamed-write production — so reaching here is the engine losing a
   * position's provenance, never a program that said nothing. It used to
   * DEFAULT to the knowledge graph: writing to a store on the strength of not
   * knowing where else to write. There is no privileged graph to fall back to
   * any more, and a guarantee that degrades silently is not a weaker guarantee
   * but the absence of one — so it says so instead.
   */
  private unnamedGraph(what: string, name: string): MovementEngineError {
    return new MovementEngineError(
      'MOVENG_RUNTIME',
      `${what} — the system '${name}' came from can't be determined, so there is no target to act on. Root the path at a NAMED system: construct one (\`crm = attio(credentials: …)\`) and start the traversal from that name`,
    );
  }

  private unstablePositionWrite(alias: string): MovementEngineError {
    return new MovementEngineError(
      'MOVENG_RUNTIME',
      `can't update '${alias}' — it has no stable record to update (an inbound payload, an extracted node, or a write that produced no record). Create a new record instead`,
    );
  }

  /**
   * `write deduped-[:companies]-> { unique by (FUZZY `name`), … }` — a write
   * into an edge of a node THIS RUN BUILT: in-process deduplication, spelled in
   * the write's own vocabulary.
   *
   * Nothing here is a second write path. The destination is the run's own
   * graph, so the engine stands in as the ADAPTER (`localEdgeAdapter`, over the
   * edge's landings array) and the ordinary identity-resolve write runs
   * unchanged on top of it: the same `unique by` lowering, the same candidate
   * arbitration and the same one judge, the same `?:` / `+:` fill modes against
   * the matched landing's current values, the same create / update / noop
   * outcomes. A create appends a landing; a match merges into the one already
   * there, in place and without moving it.
   *
   * What the statement HANDS BACK is the landing itself — the position that is
   * now on the edge — not a handle: a handle names a record in a graph, and
   * this record is in none. Reading a field off it, linking it onto another
   * local edge, parking it: all of that is what a synthesised node already
   * does, because that is exactly what it is.
   *
   * The firing log still gets a row, because the author asked for a write and
   * wants to see what it did. It carries `local` instead of an `externalId`,
   * and `committed: false` — nothing left the run.
   */
  private async executeLocalWrite(
    write: WriteExpression,
    target: Extract<WriteExpression['target'], { kind: 'linked' }>,
    from: Extract<Binding, { kind: 'nodePosition' }>,
    bindingName: string | undefined,
    env: Environment,
    body: BodyContext,
  ): Promise<Binding> {
    const { edgeName, where } = this.singleWriteEdge(target.path);
    const at = `write ${pathRootName(target.path) ?? ''}-[:${edgeName}]->`;
    refuseLocalTargetWhere(where, at);
    if (write.bind !== undefined) {
      throw unsupported(
        `'bind' on a write into a node this run built (${at})`,
        'a binding is a correspondence between a record here and a record in a system; a landing on the run\'s own edge has no system to correspond with',
      );
    }
    const edge = from.edges[edgeName];
    if (edge === undefined || edge.kind !== 'landed') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${pathRootName(target.path)}' has no appendable edge '${edgeName}' — the checker should have caught this`,
      );
    }
    // A landing that is a reference is the real record: matching it compares
    // its live values, and merging into it updates it through its own system.
    const realRecords = new Map<Binding, { target: ResolvedWriteTarget; externalId: string }>();
    const realRecordOf = async (landing: Binding) => {
      const known = realRecords.get(landing);
      if (known !== undefined) return known;
      const real = await this.resolvePositionWriteTarget(`${edgeName} landing`, landing, env);
      realRecords.set(landing, real);
      return real;
    };
    const store = localEdgeAdapter({
      edge,
      edgeName,
      references: {
        read: (landing, fieldIds) => this.readReferenceFields(landing, fieldIds, env),
        update: async (landing, update) => {
          const real = await realRecordOf(landing);
          return real.target.adapter.updateRecord({
            ...update,
            recordType: real.target.recordType,
            externalId: real.externalId,
          });
        },
      },
    });
    // The edge name IS the written type here: the landing type is a
    // checker-side fact and the run holds values whatever typed them, so the
    // edge is the only name the interpreter has for what it wrote.
    const destination: WriteDestination = {
      adapter: store.adapter,
      recordType: edgeName,
      parents: [],
    };
    const { fields, fieldProvenance, fieldSemantics, fieldEvidence, resources, descriptor } =
      await this.evaluateWriteFields({ write, target: destination, env });
    const identity = this.uniqueByIdentity(write, destination);
    const resolveRecord = { ...fields, ...identity.valueOverlay };
    const record = await this.executeResolvedWrite({
      target: destination,
      adapter: store.adapter,
      descriptor,
      resolveRecord,
      constraints: identity.constraints,
      identityNarrowings: identity.narrowings,
      fields,
      fieldSemantics,
      fieldEvidence,
      resources,
      parentLinks: [],
      body,
      // Merging into a reference changes the real record, so it holds what a
      // write straight to that record would: the record, and the identity
      // keys a direct write by the same `unique by` takes in its system. The
      // edge's own locks name only this run's landings, which a flow
      // reaching the record any other way never asks for.
      updateLocks: async (externalId) => {
        const landing = store.landingOf(externalId);
        if (landing === undefined) return [recordLock(store.adapter, externalId)];
        if (landing.kind === 'nodePosition') return [localRecordLock(landing)];
        const real = await realRecordOf(landing);
        return [
          recordLock(real.target.adapter, real.externalId),
          ...identityLocks({
            system: real.target.adapter,
            recordType: real.target.recordType,
            constraints: identity.constraints,
            resolveRecord,
            fields,
          }),
        ];
      },
    });
    const landing = store.landingOf(record.externalId);
    if (landing === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: the write produced no landing on '${edgeName}'`,
      );
    }
    if (landing.kind !== 'nodePosition') {
      // It matched a REFERENCE, so the write was to the real record: logged as
      // one, against the system it reached.
      const real = await realRecordOf(landing);
      const { externalId: _local, local: _edge, ...row } = record;
      this.recordWrite({
        write: {
          ...row,
          adapterType: real.target.adapter.adapterType,
          recordType: real.target.recordType,
          externalId: real.externalId,
          committed: this.committedThrough(real.target.adapter),
        },
        bindingName: undefined,
        env,
        target: real.target,
        fieldProvenance,
      });
      if (bindingName !== undefined) env.declare(bindingName, landing);
      return landing;
    }
    // The trail of each value that was actually SENT — the fill / append / no-op
    // gates already decided which those are. A field the write suppressed keeps
    // the trail the earlier landing had.
    for (const field of Object.keys(record.writtenValues)) {
      landing.fieldProvenance[field] = fieldProvenance[field] ?? NO_PROVENANCE;
    }
    const { externalId: _local, ...row } = record;
    this.recordLocalWrite({
      record: {
        ...row,
        committed: false,
        local: { edge: edgeName, ...(store.capped() ? { candidatesCapped: true as const } : {}) },
      },
      fieldProvenance,
      bindingName,
    });
    if (bindingName !== undefined) env.declare(bindingName, landing);
    return landing;
  }

  /** A referenced record's current values for these fields, read live — the
   *  same read a field expression off it makes. An absent field is left out. */
  private async readReferenceFields(
    landing: Binding,
    fieldIds: readonly string[],
    env: Environment,
  ): Promise<Record<string, unknown>> {
    const ctx = this.exprContext(env);
    const values: Record<string, unknown> = {};
    for (const field of fieldIds) {
      const { value } = await readLandingField(landing, field, field, ctx);
      if (value !== undefined && value !== null) values[field] = value;
    }
    return values;
  }

  /** The firing-log half of `recordWrite`, for a write with no graph behind it
   *  — the row is recorded, and the binding is the landing rather than a
   *  handle wrapping the row. */
  private recordLocalWrite(input: {
    record: WriteRecord;
    fieldProvenance: Record<string, Provenance>;
    bindingName: string | undefined;
  }): void {
    const record = input.record;
    for (const fieldId of Object.keys(record.writtenValues)) {
      record.provenance[fieldId] = this.summariser.summariseTrail(
        input.fieldProvenance[fieldId] ?? NO_PROVENANCE,
      );
    }
    if (input.bindingName !== undefined) record.bindingName = input.bindingName;
    record.origin = { kind: 'write', writeIndex: this.writes.length };
    this.writes.push(record);
  }

  /**
   * `write Files-[:file]-> { … }` against a shape — shapes are
   * configuration-free graphs (§G): no adapter, no entity resolution,
   * no firing-record write. The fields evaluate in the current scope
   * and the result is an in-memory position of the shape's type with
   * every field's trail intact — argument adaptation is invisible to
   * provenance.
   *
   * RETIRED (layer 8 take 4, wave 4). The checker refuses this construct at
   * author time and points at `node { … }`, which does the same job and more.
   * This path survives ONE wave so that programs saved before the refusal keep
   * running unchanged — retiring a construct must not stop a live automation
   * mid-flight. Delete it, and the `shape`/`shapePosition` bindings that only
   * this mints, once the prod sweep in
   * plans/2026-06-10-data-movement-language/9_node_synthesis_build.md confirms
   * no saved program still writes to a shape.
   */
  private async materializeShapeWrite(
    write: WriteExpression,
    shape: ShapeBinding,
    bindingName: string | undefined,
    env: Environment,
  ): Promise<Binding> {
    if (write.target.kind !== 'linked') {
      throw new MovementEngineError('MOVENG_RUNTIME', 'a shape write names its node directly');
    }
    const { edgeName: node, where } = this.singleWriteEdge(write.target.path);
    if (where !== undefined) {
      throw unsupported(
        'WHERE on a shape write',
        'a shape position is in-memory — there are no existing records to narrow',
      );
    }
    if (write.uniqueBy.length > 0) {
      throw unsupported(
        'unique by on a shape write',
        'a shape position is in-memory — there is no store to resolve identity against',
      );
    }
    const fields: Record<string, unknown> = {};
    const fieldProvenance: Record<string, Provenance> = {};
    for (const field of write.fields) {
      const { value, provenance } = await this.evaluateSlot(field.value, { env });
      if (value === undefined) continue;
      fields[field.name] = value;
      fieldProvenance[field.name] = provenance;
    }
    const written: Binding = binding({
      kind: 'shapePosition',
      shape: shape.declaration.name,
      node,
      fields,
      fieldProvenance,
    });
    if (bindingName !== undefined) env.declare(bindingName, written);
    return written;
  }

  /**
   * `node { … }` — in-memory node synthesis (layer 8 take 4). No adapter, no
   * identity resolution, no firing record: the entries evaluate in the current
   * scope and the result is a position carrying exactly what was written, every
   * field's trail intact.
   *
   * A VALUE entry is computed here. A nested literal is synthesised here. A
   * TRAVERSAL entry is the pass-through edge, and the only entry with a choice
   * about WHEN: eager walks now and keeps the landings; `lazy` keeps the walk
   * itself and runs it at every read (ruling 3). Either way the landings are
   * the source's REAL positions — nothing is copied, so a FileRef reaches the
   * callee as the handle the source produced.
   *
   */
  private async synthesiseNode(literal: NodeLiteral, env: Environment): Promise<Binding> {
    if (literal.graph !== undefined) return this.buildGraph(literal, env);
    const fields: Record<string, unknown> = {};
    const fieldOrder: string[] = [];
    const fieldProvenance: Record<string, Provenance> = {};
    const edges: Record<string, NodeEdge> = {};
    for (const entry of literal.entries) {
      switch (entry.kind) {
        case 'value': {
          fieldOrder.push(entry.name);
          const { value, provenance } = await this.evaluateSlot(entry.value, { env });
          // An entry that evaluated to nothing is ABSENT rather than present-
          // and-empty — the same rule a shape write applies, so a callee
          // reading it gets one story about a missing value.
          if (value === undefined) continue;
          fields[entry.name] = value;
          fieldProvenance[entry.name] = provenance;
          break;
        }
        case 'nodes': {
          const landings: Binding[] = [];
          for (const nested of entry.nodes) landings.push(await this.synthesiseNode(nested, env));
          edges[entry.name] = { kind: 'landed', landings };
          break;
        }
        case 'declared': {
          // A DECLARED edge starts empty and grows by `link`. Landed with no
          // landings is exactly that: traversing it runs a body zero times,
          // like any other empty edge.
          //
          // A DECLARED NODE also says what a landing the run builds here
          // carries, and a declaration is a tree — so the nested nodes ride
          // along, and a write into this edge mints them on its landing. The
          // ADDRESS spelling carries none: those landings are one system's
          // records, whose edges are that system's to offer.
          const declared =
            entry.type.hopsRaw === undefined ? env.resolve(entry.type.graph) : undefined;
          const shape =
            declared?.kind === 'shape'
              ? declaredLandingShape(this.resolvedShape(declared).declaration.root)
              : undefined;
          edges[entry.name] = {
            kind: 'landed',
            landings: [],
            ...(shape !== undefined ? { landingShape: shape } : {}),
          };
          break;
        }
        case 'traversal': {
          // The mapping rides WITH the walk, so `lazy` defers the synthesis
          // along with the hop and eager does both here — one rule, not two.
          edges[entry.name] = entry.lazy
            ? { kind: 'deferred', walk: this.deferWalk(entry.head, env, entry.mapping) }
            : {
                kind: 'landed',
                landings: await this.walkLandings(entry.head, env, entry.mapping),
              };
          break;
        }
      }
    }
    return binding({ kind: 'nodePosition', fields, fieldOrder, fieldProvenance, edges });
  }

  /**
   * `graph<Shape> { … }` — a LOCAL GRAPH built as a value: the same
   * `nodePosition` a node literal makes, so a path, a WHERE, a write, a link or
   * a delete reads and changes it the way it does any run-local node.
   *
   * Entries follow TypeScript's object semantics. A bare walk, or a record
   * written as an entry's value, holds REFERENCES — the records themselves,
   * as a node literal's pass-through edge does — so a read through the graph
   * is live and a write, link or delete through it acts on the real record.
   * A walk with a field body builds one child per record and a record spread
   * copies one by the plan the checker resolved: those are snapshots, the
   * graph's own. A file field is copied as the handle it is: nothing
   * downloads.
   *
   * With a shape, each child edge the shape declares exists (empty when the
   * literal wrote none) and carries the shape's nested nodes, so a write into
   * it mints them as a write into a declared edge does. A graph that took keys
   * from a map nobody could type is checked against the shape here, where the
   * keys are finally known.
   */
  private async buildGraph(literal: NodeLiteral, env: Environment): Promise<Binding> {
    const shapeName = literal.graph?.shape?.name;
    const shape = shapeName !== undefined ? this.graphShape(shapeName, env) : undefined;
    const built = await this.buildGraphBody(literal, env, shape);
    if (shape === undefined) return built;
    // A spread's keys may be ones nobody could type, so the whole value is
    // checked. From version 3 every graph is checked for what its shape
    // requires, so a value that turned out absent never leaves a required
    // field silently empty (the checker refuses one that may be absent).
    const spreads = spreadsAnywhere(literal);
    if (spreads || since(this.languageVersion, 3)) {
      const misfit = graphValueMisfit(built, shape, { presenceOnly: !spreads });
      if (misfit !== undefined) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `the value built for 'graph<${shapeName}>' doesn't fit it: ${misfit}`,
        );
      }
    }
    return built;
  }

  private graphShape(name: string, env: Environment): ShapeNode {
    const declared = env.resolve(name);
    if (declared?.kind !== 'shape') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'graph<${name}>' names no node declaration in scope`,
      );
    }
    return this.resolvedShape(declared).declaration.root;
  }

  private async buildGraphBody(
    literal: NodeLiteral,
    env: Environment,
    shape: ShapeNode | undefined,
  ): Promise<Extract<Binding, { kind: 'nodePosition' }>> {
    const node: Extract<Binding, { kind: 'nodePosition' }> = binding({
      kind: 'nodePosition',
      fields: {},
      fieldOrder: [],
      fieldProvenance: {},
      edges: {},
    });
    // Members take effect in the order written, as in a map literal: a later
    // one overwrites an earlier one, a spread's keys included.
    const spreadsAt = (index: number): MapSpread[] =>
      (literal.spreads ?? []).filter((spread) => spread.after === index);
    const applySpreads = async (index: number): Promise<void> => {
      for (const spread of spreadsAt(index)) {
        if (spread.copy !== undefined) {
          await this.spreadRecordIntoGraph(node, { spread, plan: spread.copy, env, shape });
          continue;
        }
        const map = this.spreadMap(spread, env);
        if (map !== undefined) this.spreadIntoGraph(node, map, shape);
      }
    };
    for (const [index, entry] of literal.entries.entries()) {
      await applySpreads(index);
      const child = shape?.children.find((c) => c.name === entry.name);
      switch (entry.kind) {
        case 'value': {
          if (entry.reference === true) {
            setGraphEdge(node, entry.name, this.referencedRecords(entry.name, await this.bindSlotValue(entry.value, env)), child);
            break;
          }
          const { value, provenance } = await this.evaluateSlot(entry.value, { env });
          delete node.edges[entry.name];
          noteGraphField(node, entry.name);
          if (value === undefined) {
            delete node.fields[entry.name];
            delete node.fieldProvenance[entry.name];
            break;
          }
          node.fields[entry.name] = value;
          node.fieldProvenance[entry.name] = provenance;
          break;
        }
        case 'nodes': {
          const landings: Binding[] = [];
          for (const nested of entry.nodes) landings.push(await this.buildGraphBody(nested, env, child));
          setGraphEdge(node, entry.name, landings, child);
          break;
        }
        case 'traversal': {
          if (entry.mapping !== undefined) {
            const landings: Binding[] = [];
            for (const iteration of await this.resolveHeadIterations(entry.head, env)) {
              const itemEnv = env.child();
              for (const [name, binding] of iteration.bindings) itemEnv.declare(name, binding);
              landings.push(await this.buildGraphBody(entry.mapping, itemEnv, child));
            }
            setGraphEdge(node, entry.name, landings, child);
            break;
          }
          setGraphEdge(node, entry.name, await this.walkLandings(entry.head, env), child);
          break;
        }
        case 'declared':
          // The parser refuses a declared edge inside a graph literal.
          throw new MovementEngineError('MOVENG_RUNTIME', `a declared edge ('${entry.name}') inside a graph literal — the parser refuses one`);
        default:
          neverAsAny(entry);
      }
    }
    await applySpreads(literal.entries.length);
    if (shape !== undefined) {
      for (const child of shape.children) {
        if (node.edges[child.name] === undefined) setGraphEdge(node, child.name, [], child);
      }
      // Declaration order, then whatever else a spread brought along.
      const declared = shape.fields.map((f) => f.name);
      node.fieldOrder = [...declared, ...node.fieldOrder.filter((f) => !declared.includes(f))];
    }
    return node;
  }

  /**
   * The records a reference entry (`owner: r`, `owner: ONLY(m-[:Owner]->)`)
   * holds: the record itself, never a copy, so a read through the graph is
   * live and a write through it reaches the real record. The trigger's own
   * record is held as the source position it is; a selection that found
   * nothing holds nothing.
   */
  private referencedRecords(name: string, bound: Binding): Binding[] {
    switch (bound.kind) {
      case 'value': {
        // A record held as a value, or a list of them (what a MAP of writes
        // hands back) — each one held as itself.
        const held = Array.isArray(bound.value) ? bound.value : [bound.value];
        const records: Binding[] = [];
        for (const member of held) {
          if (member === null || member === undefined) continue;
          const record = bindingOf(member);
          if (record === undefined) {
            throw new MovementEngineError(
              'MOVENG_RUNTIME',
              `'${name}' holds records, and one of them is a ${typeof member} — the program was not checked`,
            );
          }
          records.push(...this.referencedRecords(name, record));
        }
        return records;
      }
      case 'positions':
        return bound.landings;
      case 'event':
        if (this.source !== undefined) return [binding({ kind: 'sourcePosition', position: this.source.position })];
        break;
      case 'sourcePosition':
      case 'handle':
      case 'nodePosition':
      case 'shapePosition':
      case 'extractPosition':
      case 'extractRoot':
      case 'resource':
        return [bound];
      case 'tuple':
      case 'lazyWalk':
      case 'closure':
      case 'callback':
      case 'blockMeta':
      case 'instance':
      case 'shape':
      case 'movement':
      case 'plugin':
      case 'opaque':
        break;
      default:
        neverAsAny(bound);
    }
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `'${name}' holds a record, and the value is ${describeBinding[bound.kind]} — the program was not checked`,
    );
  }

  /** The map a `...v` spreads, as it is at run time — undefined when it is
   *  absent, which copies nothing, as TypeScript's `...undefined` does. */
  private spreadMap(spread: MapSpread, env: Environment): Record<string, unknown> | undefined {
    const bound = spreadSourceBinding(spread, env);
    const value = bound?.kind === 'value' ? bound.value : undefined;
    if (bound?.kind === 'value' && (value === undefined || value === null)) return undefined;
    if (!isDictValue(value)) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'...${spread.source}' spreads a map into a graph, and '${spread.source}' holds ${value === undefined ? 'no value' : Array.isArray(value) ? 'a list' : `a ${typeof value}`}`,
      );
    }
    return value;
  }

  /**
   * `...r` where `r` is one record: a snapshot of it by the checker's plan, its
   * fields and planned edges laid over what the node holds so far (an absent
   * field overwrites, as a spread's null key does). A record that is absent
   * copies nothing.
   */
  private async spreadRecordIntoGraph(
    node: Extract<Binding, { kind: 'nodePosition' }>,
    { spread, plan, env, shape }: { spread: MapSpread; plan: CopyPlan; env: Environment; shape: ShapeNode | undefined },
  ): Promise<void> {
    const record = spreadRecord(spread, spreadSourceBinding(spread, env));
    if (record === undefined) return;
    const copy = await this.snapshotRecord(record, plan, env);
    for (const field of plan.fields) {
      delete node.edges[field];
      noteGraphField(node, field);
      if (Object.hasOwn(copy.fields, field)) {
        node.fields[field] = copy.fields[field];
        node.fieldProvenance[field] = copy.fieldProvenance[field] ?? NO_PROVENANCE;
      } else {
        delete node.fields[field];
        delete node.fieldProvenance[field];
      }
    }
    for (const [name, edge] of Object.entries(copy.edges)) {
      delete node.fields[name];
      node.fieldOrder = node.fieldOrder.filter((f) => f !== name);
      setGraphEdge(node, name, edge.kind === 'landed' ? edge.landings : [], shape?.children.find((c) => c.name === name));
    }
  }

  /** A map's keys into a graph node: a nested map (or a list of them) is a
   *  child where the shape says so, and everywhere without one. */
  private spreadIntoGraph(
    node: Extract<Binding, { kind: 'nodePosition' }>,
    map: Record<string, unknown>,
    shape: ShapeNode | undefined,
  ): void {
    for (const [key, value] of Object.entries(map)) {
      // A graph built from a map holds values and nested maps; a record under
      // a key is neither, and storing the engine's own object as a field would
      // hand it on to whatever serialises or writes the field.
      if (holdsRecord(value)) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${key}' holds a record, and a map spread into a graph copies values and maps — a graph field cannot hold a record (the checker should have caught this)`,
        );
      }
      const child = shape?.children.find((c) => c.name === key);
      const maps = asMapList(value);
      const asChild = shape !== undefined ? child !== undefined : maps !== undefined;
      if (!asChild) {
        delete node.edges[key];
        noteGraphField(node, key);
        if (value === undefined || value === null) {
          delete node.fields[key];
          delete node.fieldProvenance[key];
          continue;
        }
        node.fields[key] = value;
        node.fieldProvenance[key] = NO_PROVENANCE;
        continue;
      }
      if (maps === undefined) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${key}' is a child node, and the map spread into the graph holds ${Array.isArray(value) ? 'a list that is not all maps' : `a ${typeof value}`} there — it needs a map, or a list of maps`,
        );
      }
      delete node.fields[key];
      node.fieldOrder = node.fieldOrder.filter((f) => f !== key);
      const landings = maps.map((nested) => {
        const landing: Extract<Binding, { kind: 'nodePosition' }> = binding({
          kind: 'nodePosition',
          fields: {},
          fieldOrder: [],
          fieldProvenance: {},
          edges: {},
        });
        this.spreadIntoGraph(landing, nested, child);
        return landing;
      });
      setGraphEdge(node, key, landings, child);
    }
  }

  /**
   * One record, copied by a plan: the plan's fields read now (each with its
   * trail), and through each planned edge the records there, copied in turn.
   * The copy is a run-local node, so no edge out of it leads back into the
   * source.
   */
  private async snapshotRecord(
    record: Binding,
    plan: CopyPlan,
    env: Environment,
  ): Promise<Extract<Binding, { kind: 'nodePosition' }>> {
    const copy: Extract<Binding, { kind: 'nodePosition' }> = binding({
      kind: 'nodePosition',
      fields: {},
      fieldOrder: [...plan.fields],
      fieldProvenance: {},
      edges: {},
    });
    const ctx = this.exprContext(env);
    for (const field of plan.fields) {
      const { value, provenance } = await readLandingField(record, field, field, ctx);
      // An absent field is copied absent, as a node literal's empty entry is.
      if (value === undefined || value === null) continue;
      copy.fields[field] = value;
      copy.fieldProvenance[field] = provenance;
    }
    for (const [edge, nested] of Object.entries(plan.edges)) {
      const reached = await this.walkNodePlane(
        [{ aliases: new Map(), binding: record }],
        [{ type: 'edge', edgeTypeId: edge, direction: 'outgoing' }],
        env,
      );
      const landings: Binding[] = [];
      for (const iteration of reached) {
        if (iteration.landing !== undefined) {
          landings.push(await this.snapshotRecord(iteration.landing, nested, env));
        }
      }
      copy.edges[edge] = { kind: 'landed', landings };
    }
    return copy;
  }

  /**
   * Store a traversal instead of running it. The scope is SNAPSHOT here — a
   * closure captures what it can see where it is written, and single-assignment
   * bindings make the snapshot exact. It also excludes the binding this walk is
   * about to become, which is what keeps serialising one finite.
   */
  private deferWalk(head: PathHead, env: Environment, mapping?: NodeLiteral): DeferredWalk {
    return { head, captured: captureScope(env), ...(mapping ? { mapping } : {}) };
  }

  /** Walk a head now and return where it landed — the eager half of a
   *  pass-through edge, and the same walk `lazy` defers. A `mapping` renames
   *  each landing here, at the literal, exactly as the deferred form does at
   *  the read. */
  private async walkLandings(
    head: PathHead,
    env: Environment,
    mapping?: NodeLiteral,
  ): Promise<Binding[]> {
    const walked = await this.resolveHeadIterations(head, env);
    const iterations = mapping ? await this.mapIterations(walked, mapping, env) : walked;
    return iterations.flatMap((iteration) =>
      iteration.landing !== undefined ? [iteration.landing] : [],
    );
  }

  /**
   * PER-ITEM synthesis: each landing of a walk, mapped through the tail
   * literal. The literal is evaluated in the walk's own scope EXTENDED with
   * that iteration's hop aliases — the same scope a traversal block's body
   * runs in — so `a.\`File\`` reads the real source position and carries the
   * source's trail. Nothing is fabricated for the wrapper.
   *
   * The iteration's aliases do NOT survive: the alias names the landing inside
   * the tail and nowhere else, which is exactly what the checker says.
   */
  private async mapIterations(
    iterations: BlockIteration[],
    mapping: NodeLiteral,
    env: Environment,
  ): Promise<BlockIteration[]> {
    const mapped: BlockIteration[] = [];
    for (const iteration of iterations) {
      const itemEnv = env.child();
      for (const [name, binding] of iteration.bindings) itemEnv.declare(name, binding);
      mapped.push({ bindings: new Map(), landing: await this.synthesiseNode(mapping, itemEnv) });
    }
    return mapped;
  }

  /**
   * Run a STORED walk (`lazy …`) — the read seam behind every deferred edge and
   * every read of a lazy binding. It re-walks the LIVE source every time: no
   * cache, so a source that changed between two reads shows the change (ruling
   * 3). `extraSteps` continue the chain inside the same walk, so hops past a
   * lazy edge are hops in the source graph, filters and all.
   *
   * A MAPPED walk breaks that continuation in two, because it has to: past the
   * mapping the landings are synthesised nodes, so the remaining hops are hops
   * on the mapping's own arrow plane (a nested tail, a nested pass-through
   * edge), not on the source's.
   */
  private async runDeferredWalk(
    walk: DeferredWalk,
    extraSteps: Extract<Expression, { type: 'traverse' }>['steps'],
  ): Promise<BlockIteration[]> {
    const env = new Environment();
    for (const [name, binding] of walk.captured) env.declare(name, binding);
    if (walk.mapping === undefined) {
      return this.resolveHeadIterations(walk.head, env, extraSteps);
    }
    const mapped = await this.mapIterations(
      await this.resolveHeadIterations(walk.head, env),
      walk.mapping,
      env,
    );
    if (extraSteps.length === 0) return mapped;
    return this.walkNodePlane(
      mapped.flatMap((iteration) =>
        iteration.landing !== undefined
          ? [{ aliases: new Map<string, Binding>(), binding: iteration.landing }]
          : [],
      ),
      extraSteps,
      env,
    );
  }

  // ── Link statements (the edge-only write — §B, absorbed `edge`) ──

  /**
   * `link a -[:e]-> b` — assert an edge between two records already bound
   * (linked writes cover the parent-child shape, this is the residual case;
   * a record to link that you don't hold yet is found with `match`). The
   * runtime owns most of the validation:
   *   - the from name must be a write handle; the to name must be one in
   *     the SAME graph (binding object identity, the alias-safe graph
   *     identity the IS tests use);
   *   - the edge resolves against the FROM side's type in that graph's
   *     schema where one is known (untyped graphs defer to the adapter's
   *     own resolution, which fails loud on a bad name);
   *   - the receiving adapter must implement the optional `linkRecords`
   *     seam — rejected by name otherwise.
   * The assert lands on the firing record as an edge entry whose
   * provenance carries both endpoints' write origins. Nothing is emitted
   * here: graph mutation events reach listeners only via the knowledge
   * outbox drainer (M-38), external ones only via their webhooks.
   */
  private async executeLink(
    link: LinkExpression,
    bindingName: string | undefined,
    env: Environment,
  ): Promise<void> {
    const fromBinding = env.resolve(link.from);
    if (fromBinding?.kind === 'nodePosition') {
      if (link.to.kind === 'match') {
        throw unsupported(
          `link ${link.from} -[:${link.edge}]-> { … } on a node this run built`,
          'the body would find among what the edge already holds — the checker should have caught this',
        );
      }
      this.appendLocalLanding({ ...link, to: link.to }, fromBinding, env);
      return;
    }
    // Version 1's body form was its own statement: criteria find the record
    // and the link lands as ONE run-log row, with no match row before it.
    // A body with an authored `unique by` never parsed under v0.6.0, so it has
    // no version-1 meaning to keep and runs as the match it is.
    const authoredIdentity =
      link.to.kind === 'match' && !link.to.impliedIdentity && link.to.match.uniqueBy.length > 0;
    if (link.to.kind === 'match' && !authoredIdentity && before(this.languageVersion, 2)) {
      await this.executeCriteriaLink(link, link.to.match, bindingName, env);
      return;
    }
    // The body form is `match` then `link`: the match runs exactly as the
    // statement would (its own run-log row, a quiet end of the scope on a
    // miss), and the link then connects the record it found. Version 4
    // refuses this form, so a miss here always ends the scope.
    const to =
      link.to.kind === 'match'
        ? {
            name: bindingName ?? '{ … }',
            binding: await this.executeMatch(link.to.match, bindingName, env, { onMiss: 'endScope' }),
          }
        : { name: link.to.name, binding: env.resolve(link.to.name) };
    const at = `link ${link.from} -[:${link.edge}]-> ${to.name}`;
    const resolved = await this.resolveLinkStatement({ from: link.from, edge: link.edge, to }, env, at);
    if (typeof resolved.adapter.linkRecords !== 'function') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: the '${resolved.adapter.adapterType}' adapter cannot link two existing records (no linkRecords capability) — express the relationship as a linked write (write ${link.from}-[:${link.edge}]-> { … }) instead`,
      );
    }
    const linkRecords = resolved.adapter.linkRecords.bind(resolved.adapter);
    const linked = await this.effectLocks.withLocks(
      [edgeLock({ system: resolved.adapter, from: resolved.from, edgeName: resolved.edgeName, to: resolved.to })],
      () =>
        linkRecords({
          from: resolved.from,
          edgeName: resolved.edgeName,
          to: resolved.to,
          mutationContext: this.mutationContext,
        }),
    );
    this.recordLinkStatement({ kind: 'link', resolved, changed: linked.created });
  }

  /**
   * Version 1's `link c -[:portfolio]-> { name: "Fund III" }` — the target is
   * FOUND, never created and never written. The body's fields are identity
   * criteria ONLY (a body with an authored `unique by` runs as a match): the
   * criteria AND-group merged with the target's native rules, resolved and
   * arbitrated like a write's identity, the found type inferred from the edge.
   * On a miss the enclosing scope ends quietly.
   *
   * What makes it version 1's rather than `match` then `link`: the run log
   * gets the LINK alone (from-keyed, `foundTarget`), and the bound handle is
   * not a log entry of its own — its `origin` chains to the link's row.
   */
  private async executeCriteriaLink(
    link: LinkExpression,
    body: MatchExpression,
    bindingName: string | undefined,
    env: Environment,
  ): Promise<void> {
    const at = `link ${link.from} -[:${link.edge}]-> { … }`;
    const from = this.resolveEdgeEndpoint(link.from, env.resolve(link.from), at);
    const graph = from.graph;
    const recordType = this.inferLinkedSurfaceType({
      graph,
      parentSurfaceType: from.targetType,
      edgeName: link.edge,
      explicitType: body.target.kind === 'linked' ? body.target.explicitType : undefined,
      rootName: link.from,
      verb: 'link',
    });
    const fromId = from.handle.externalId;
    if (fromId === undefined) {
      throw new MovementEngineError('MOVENG_RUNTIME', `${at}: '${link.from}' carries no written record id to link`);
    }
    const adapter = await this.targetAdapterFor(graph.instance);

    const criteria: Record<string, unknown> = {};
    for (const field of body.fields) {
      const { value } = await this.evaluateSlot(field.value, { env });
      if (value === undefined) continue;
      criteria[field.name] = value;
    }
    const descriptor = await adapter.describe(recordType);
    const constraints = mergeUniqueness(descriptor?.uniquenessConstraints, {
      any:
        Object.keys(criteria).length > 0
          ? [{ all: Object.keys(criteria).map((field) => ({ field })) }]
          : [],
    });
    const { matched } = await this.resolveIdentity({
      adapter,
      recordType,
      resolveRecord: criteria,
      constraints,
      identityNarrowings: [],
      asserted: criteria,
    });
    if (matched === undefined) {
      throw new ScopeEndedQuietly(`${at}: no existing ${recordType} matched the criteria`);
    }
    if (typeof adapter.linkRecords !== 'function') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: the '${adapter.adapterType}' adapter cannot link two existing records (no linkRecords capability)`,
      );
    }
    const fromRecordType = from.targetType;
    const linkRecords = adapter.linkRecords.bind(adapter);
    const edge = {
      from: { recordType: fromRecordType, externalId: fromId },
      edgeName: link.edge,
      to: { recordType, externalId: matched.externalId },
    };
    const linked = await this.effectLocks.withLocks([edgeLock({ system: adapter, ...edge })], () =>
      linkRecords({ ...edge, mutationContext: this.mutationContext }),
    );

    let resultData: Record<string, unknown> = {
      ...(matched.url !== undefined ? { url: matched.url } : {}),
      ...matched.data,
    };
    if (typeof adapter.readRecord === 'function') {
      const current = await adapter.readRecord({ recordType, externalId: matched.externalId });
      if (current) resultData = { ...resultData, ...current };
    }
    const writeIndex = this.writes.length;
    this.writes.push({
      kind: 'link',
      adapterType: adapter.adapterType,
      recordType: fromRecordType,
      created: linked.created,
      committed: this.committedThrough(adapter),
      externalId: fromId,
      writtenValues: {},
      link: {
        edgeName: link.edge,
        toRecordType: recordType,
        toExternalId: matched.externalId,
        foundTarget: true,
      },
      provenance: {
        from: this.summariser.summariseTrail(handleTrail(from.handle)),
        // The to side was FOUND, not written — no write origin to chain.
        to: [],
      },
      ...(bindingName !== undefined ? { bindingName } : {}),
    });
    if (bindingName !== undefined) {
      env.declare(bindingName, binding({
        kind: 'handle',
        handle: {
          adapterType: adapter.adapterType,
          recordType,
          created: false,
          committed: this.committedThrough(adapter),
          externalId: matched.externalId,
          writtenValues: {},
          resultData,
          provenance: {},
          origin: { kind: 'write', writeIndex, externalId: matched.externalId },
        },
        targetType: recordType,
        graph,
      }));
    }
  }

  /**
   * `link sent -[:messages]-> one` where `sent` is a node this run built: the
   * landing is pushed onto that edge's own array. Nothing reaches a system, so
   * nothing lands on the firing record — what grew is the run's own graph.
   *
   * The landing keeps its own KIND, so traversing to it and writing off it
   * afterwards take the paths they already take, and a park carries it by the
   * same serialisation every other landing rides.
   *
   */
  private appendLocalLanding(
    link: LinkExpression & { to: Extract<LinkTarget, { kind: 'handle' }> },
    from: Extract<Binding, { kind: 'nodePosition' }>,
    env: Environment,
  ): void {
    const at = `link ${link.from} -[:${link.edge}]->`;
    const edge = from.edges[link.edge];
    if (edge === undefined || edge.kind !== 'landed') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${link.from}' has no appendable edge '${link.edge}' — the checker should have caught this`,
      );
    }
    const to = env.resolve(link.to.name);
    if (!to) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${link.to.name}' is not in scope — the checker should have caught this`,
      );
    }
    if (!APPENDABLE_LANDING_KINDS.has(to.kind)) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at} ${link.to.name}: an edge lands on a position — '${link.to.name}' is ${describeBinding[to.kind]}`,
      );
    }
    if (to.kind === 'nodePosition' && to.landedOn === undefined) to.landedOn = link.edge;
    edge.landings.push(to);
  }

  // ── Matches (the identity half of a write, on its own) ──

  /**
   * `x = match <path> { unique by (…) … }` — find an existing record by
   * identity and bind it; never create, never write. It is the first half of
   * `executeWrite`, run by the same pieces in the same order: resolve the
   * target, evaluate the asserted fields, lower `unique by` merged with the
   * target's native rules, fold edge-scoped parents in, then
   * `resolveIdentity`. Where a write would update or create, a match binds
   * what it found — its full result data via `readRecord` where the adapter
   * offers it, over the candidate's snapshot.
   *
   * On a miss, `onMiss` decides: `'absent'` (version 4) binds absent, as an
   * empty `FIRST(…)` does, and the block carries on; `'endScope'` (before
   * version 4) ends the ENCLOSING SCOPE quietly (a fan-out iteration skips;
   * nothing throws, because transactionality across systems can't be
   * guaranteed). Either way a miss adds no run-log row.
   *
   * The run log gets a `kind: 'match'` row so an inspector sees what the run
   * resolved to. It is not a write: nothing counted as written counts it.
   */
  private async executeMatch(
    match: MatchExpression,
    bindingName: string | undefined,
    env: Environment,
    options: { onMiss: MatchMissPolicy },
  ): Promise<Binding> {
    const rooted = await this.bindTargetRoots(match.target, env);
    if (rooted !== undefined) {
      const found = await this.executeMatch({ ...match, target: rooted.target }, bindingName, rooted.env, options);
      if (bindingName !== undefined) env.declare(bindingName, found);
      return found;
    }
    const at = `match ${describeMatchTarget(match)}`;
    if (match.target.kind === 'linked') {
      const root = pathRootName(match.target.path);
      const rootBinding = root !== undefined ? env.resolve(root) : undefined;
      if (rootBinding?.kind === 'nodePosition') {
        return this.executeLocalMatch({
          match,
          target: match.target,
          from: rootBinding,
          bindingName,
          env,
          at,
          onMiss: options.onMiss,
        });
      }
    }
    const resolved = await this.resolveWriteTarget(match, env, 'match');
    const { adapter } = resolved;
    const { fields, descriptor } = await this.evaluateWriteFields({ write: match, target: resolved, env });
    const handleType = this.discriminatedHandleType(resolved, fields);
    const identity = this.uniqueByIdentity(match, resolved);
    const constraints = mergeUniqueness(descriptor?.uniquenessConstraints, identity.constraints);
    const { matched, judgeUnavailable } = await this.resolveIdentity({
      adapter,
      recordType: resolved.recordType,
      resolveRecord: this.identityRecord({ fields, identity, constraints, target: resolved }),
      constraints,
      identityNarrowings: identity.narrowings,
      ...this.candidateWhere(
        handleType !== undefined ? { ...resolved, handleType } : resolved,
        env,
      ),
      asserted: fields,
    });
    if (matched === undefined) {
      return missed({
        onMiss: options.onMiss,
        bindingName,
        env,
        reason: `${at}: no existing ${resolved.recordType} matched${judgeUnavailable !== undefined ? ` (judge unavailable: ${judgeUnavailable})` : ''}`,
        judgeUnavailable,
        trace: this.trace,
      });
    }
    let resultData: Record<string, unknown> = {
      ...(matched.url !== undefined ? { url: matched.url } : {}),
      ...matched.data,
    };
    if (typeof adapter.readRecord === 'function') {
      const current = await adapter.readRecord({
        recordType: resolved.recordType,
        externalId: matched.externalId,
      });
      if (current) resultData = { ...resultData, ...current };
    }
    const found: WriteRecord = {
      kind: 'match',
      adapterType: adapter.adapterType,
      recordType: handleType ?? resolved.recordType,
      // Nothing was created and nothing was sent, so nothing was committed.
      created: false,
      committed: false,
      externalId: matched.externalId,
      writtenValues: {},
      resultData,
      provenance: {},
    };
    return this.recordWrite({
      write: found,
      bindingName,
      env,
      target: handleType !== undefined ? { ...resolved, handleType } : resolved,
      fieldProvenance: {},
    });
  }

  /**
   * `match deduped-[:companies]-> { unique by (FUZZY \`name\`), … }` — a match
   * among the landings of a node THIS RUN BUILT. The same stand-in adapter a
   * local write resolves through (`localEdgeAdapter` over the edge's landings)
   * answers the same `resolveIdentity`, so a match here means exactly what the
   * local write's identity means; it binds the landing it found, as a local
   * write binds the landing it made.
   */
  private async executeLocalMatch(input: {
    match: MatchExpression;
    target: Extract<MatchExpression['target'], { kind: 'linked' }>;
    from: Extract<Binding, { kind: 'nodePosition' }>;
    bindingName: string | undefined;
    env: Environment;
    at: string;
    onMiss: MatchMissPolicy;
  }): Promise<Binding> {
    const { match, from, env, at } = input;
    const { edgeName, where } = this.singleWriteEdge(input.target.path);
    refuseLocalTargetWhere(where, at);
    const edge = from.edges[edgeName];
    if (edge === undefined || edge.kind !== 'landed') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${pathRootName(input.target.path)}' has no appendable edge '${edgeName}' — the checker should have caught this`,
      );
    }
    const store = localEdgeAdapter({
      edge,
      edgeName,
      references: { read: (landing, fieldIds) => this.readReferenceFields(landing, fieldIds, env) },
    });
    const destination: WriteDestination = { adapter: store.adapter, recordType: edgeName, parents: [] };
    const { fields } = await this.evaluateWriteFields({ write: match, target: destination, env });
    const identity = this.uniqueByIdentity(match, destination);
    const { matched, judgeUnavailable } = await this.resolveIdentity({
      adapter: store.adapter,
      recordType: edgeName,
      resolveRecord: { ...fields, ...identity.valueOverlay },
      constraints: identity.constraints,
      identityNarrowings: identity.narrowings,
      asserted: fields,
    });
    const landing = matched !== undefined ? store.landingOf(matched.externalId) : undefined;
    if (landing === undefined) {
      return missed({
        onMiss: input.onMiss,
        bindingName: input.bindingName,
        env,
        reason: `${at}: no landing on '${edgeName}' matched${judgeUnavailable !== undefined ? ` (judge unavailable: ${judgeUnavailable})` : ''}`,
        judgeUnavailable,
        trace: this.trace,
      });
    }
    this.recordLocalWrite({
      record: {
        kind: 'match',
        adapterType: store.adapter.adapterType,
        recordType: edgeName,
        created: false,
        committed: false,
        writtenValues: {},
        provenance: {},
        local: { edge: edgeName, ...(store.capped() ? { candidatesCapped: true as const } : {}) },
      },
      fieldProvenance: {},
      bindingName: input.bindingName,
    });
    if (input.bindingName !== undefined) env.declare(input.bindingName, landing);
    return landing;
  }

  /**
   * `unlink a -[:e]-> b` — sever the edge `edge` asserted (the exact
   * inverse). Same endpoint rules and the same currency at the adapter
   * boundary; the capability is `Adapter.unlinkRecords`, rejected by
   * name where the adapter doesn't carry it. Idempotent at the adapter
   * (`removed: false` when no link existed); the firing record carries
   * the entry either way (kind 'unlink', `created` = whether a link was
   * actually severed) with both endpoints' write origins as provenance.
   */
  private async executeUnlinkStatement(
    statement: Extract<Statement, { kind: 'unlink' }>,
    env: Environment,
  ): Promise<void> {
    const at = `unlink ${statement.from} -[:${statement.edge}]-> ${statement.to}`;
    const resolved = await this.resolveLinkStatement(
      {
        from: statement.from,
        edge: statement.edge,
        to: { name: statement.to, binding: env.resolve(statement.to) },
      },
      env,
      at,
    );
    if (typeof resolved.adapter.unlinkRecords !== 'function') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: the '${resolved.adapter.adapterType}' adapter cannot sever a link between two existing records (no unlinkRecords capability)`,
      );
    }
    const unlinkRecords = resolved.adapter.unlinkRecords.bind(resolved.adapter);
    const unlinked = await this.effectLocks.withLocks(
      [edgeLock({ system: resolved.adapter, from: resolved.from, edgeName: resolved.edgeName, to: resolved.to })],
      () =>
        unlinkRecords({
          from: resolved.from,
          edgeName: resolved.edgeName,
          to: resolved.to,
          mutationContext: this.mutationContext,
        }),
    );
    this.recordLinkStatement({ kind: 'unlink', resolved, changed: unlinked.removed });
  }

  /**
   * `delete <name>` — remove the record a position stands on, through the
   * receiving adapter's `deleteRecord` (rejected by name where the adapter
   * doesn't genuinely implement it — the capability check is `typeof`, so
   * test fakes and capability-less adapters fail loud before any call).
   * The deletable positions are exactly the updatable ones — a write
   * handle OR a traversed source record — resolved through the same seam
   * as `write <alias> { … }` (`resolvePositionWriteTarget`), so "I found
   * it, now remove it" works wherever "I found it, now change it" does.
   * The firing record carries a kind 'delete' entry; for a handle its
   * provenance chains to the handle's own write, for a traversed record
   * the entry's ids are the provenance.
   */
  private async executeDeleteStatement(
    statement: Extract<Statement, { kind: 'delete' }>,
    env: Environment,
  ): Promise<void> {
    const at = `delete ${statement.name}`;
    const binding = env.resolve(statement.name);
    const resolved = await this.resolvePositionWriteTarget(
      statement.name,
      binding,
      env,
      'delete',
    );
    const adapter = resolved.target.adapter;
    if (typeof adapter.deleteRecord !== 'function') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: the '${adapter.adapterType}' adapter cannot delete records (no deleteRecord capability)`,
      );
    }
    // The position's type crosses the boundary in its NATURAL name — the
    // adapter resolves it to its own id internally.
    const recordType = resolved.target.recordType;
    const externalId = resolved.externalId;
    const deleteRecord = adapter.deleteRecord.bind(adapter);
    await this.effectLocks.withLocks([recordLock(adapter, externalId)], () =>
      deleteRecord({ recordType, externalId, mutationContext: this.mutationContext }),
    );

    this.writes.push({
      kind: 'delete',
      adapterType: adapter.adapterType,
      recordType,
      created: false,
      committed: this.committedThrough(adapter),
      externalId,
      writtenValues: {},
      provenance:
        binding?.kind === 'handle'
          ? { record: this.summariser.summariseTrail(handleTrail(binding.handle)) }
          : {},
    });
  }

  /**
   * Shared resolution for the two bare-handle link statements (`link` and
   * `unlink`): both names must be write handles in the SAME graph, the
   * edge resolves against the FROM side's type where the graph schema
   * declares it, and everything the adapter consumes — endpoint types,
   * the edge name — translates to engine currency at this boundary.
   */
  private async resolveLinkStatement(
    statement: {
      from: string;
      edge: string;
      /** The to side, already resolved: a bound name's binding, or the record
       *  a link body's match found (named for messages by its binding, if any). */
      to: { name: string; binding: Binding | undefined };
    },
    env: Environment,
    at: string,
  ): Promise<ResolvedLinkStatement> {
    const from = this.resolveEdgeEndpoint(statement.from, env.resolve(statement.from), at);
    const to = this.resolveEdgeEndpoint(statement.to.name, statement.to.binding, at);
    const graph = from.graph;
    if (to.graph.instance !== graph.instance) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: both handles must live in the same graph — '${statement.from}' is in ${describeHandleGraph(from.graph)} and '${statement.to.name}' is in ${describeHandleGraph(to.graph)}`,
      );
    }

    // The edge belongs to the from-side's type (SURFACE currency, like
    // linked-write inference): validate against the graph schema when
    // the from type is declared there.
    const schema = graph.instance.schema;
    const fromPosition = schema?.positions[from.targetType];
    const declaredEdge = fromPosition?.edges[statement.edge];
    if (fromPosition !== undefined && declaredEdge === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${statement.edge}' is not a declared edge of ${from.targetType} — the edge resolves against the from-side's type`,
      );
    }
    if (
      declaredEdge !== undefined &&
      !declaredEdge.polymorphic &&
      declaredEdge.target !== to.targetType
    ) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${statement.edge}' connects ${from.targetType} to ${declaredEdge.target}, but '${statement.to.name}' is a ${to.targetType} handle`,
      );
    }

    const fromId = from.handle.externalId;
    const toId = to.handle.externalId;
    if (fromId === undefined || toId === undefined) {
      const missing = fromId === undefined ? statement.from : statement.to.name;
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${missing}' carries no written record id to link`,
      );
    }

    const adapter = await this.targetAdapterFor(graph.instance);

    // NATURAL currency at the adapter boundary, like every write — the adapter
    // resolves the endpoint types and the edge (against the FROM side's type)
    // to its own ids internally.
    return {
      adapter,
      edgeName: statement.edge,
      from: { recordType: from.targetType, externalId: fromId },
      to: { recordType: to.targetType, externalId: toId },
      fromHandle: from.handle,
      toHandle: to.handle,
    };
  }

  /** The firing-record entry for a standalone link statement — same shape
   *  for assert and sever; `kind` discriminates, `created` carries whether
   *  the statement actually changed the target, and provenance is the two
   *  endpoints' write origins. */
  private recordLinkStatement(input: {
    kind: 'link' | 'unlink';
    resolved: ResolvedLinkStatement;
    changed: boolean;
  }): void {
    const { resolved } = input;
    this.writes.push({
      kind: input.kind,
      adapterType: resolved.adapter.adapterType,
      recordType: resolved.from.recordType,
      created: input.changed,
      committed: this.committedThrough(resolved.adapter),
      externalId: resolved.from.externalId,
      writtenValues: {},
      link: {
        edgeName: resolved.edgeName,
        toRecordType: resolved.to.recordType,
        toExternalId: resolved.to.externalId,
      },
      provenance: {
        from: this.summariser.summariseTrail(handleTrail(resolved.fromHandle)),
        to: this.summariser.summariseTrail(handleTrail(resolved.toHandle)),
      },
    });
  }

  private resolveEdgeEndpoint(
    name: string,
    binding: Binding | undefined,
    at: string,
  ): Extract<Binding, { kind: 'handle' }> {
    if (!binding) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${name}' is not in scope — the checker should have caught this`,
      );
    }
    if (binding.kind !== 'handle') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: link statements connect written handles — '${name}' is ${describeBinding[binding.kind]}`,
      );
    }
    return binding;
  }

  /**
   * Finalise a produced `WriteRecord` and land it on the firing log — the
   * recording step of the produce-and-record act. The record from
   * `applyCreate` / `applyUpdate` already carries its identity and
   * write-event facts; here it gains the firing-log layer in place
   * (summarised per-field provenance, interned write origin) and is
   * pushed onto `this.writes`. The handle binding wraps that SAME object,
   * so the binding value and the firing entry are one — there is no
   * slim-handle → fuller-entry transform.
   */
  private recordWrite(input: {
    write: WriteRecord;
    bindingName: string | undefined;
    env: Environment;
    target: ResolvedWriteTarget;
    /** Trails of the evaluated field values — summarised onto the
     *  firing record for the fields that were actually written. */
    fieldProvenance: Record<string, Provenance>;
    /** The write went through a rehearsing (dry-run) adapter: nothing
     *  changed, so a record it found stood before the write exactly as the
     *  handle shows it — its `@old` is the handle itself. */
    rehearsed?: boolean;
    /** The handle binding this write moves on to the new record, in place
     *  (`write org { … }` since version 4) — every scope and closure holding
     *  it sees the update. Absent ⇒ a new binding. */
    into?: Extract<Binding, { kind: 'handle' }>;
  }): Binding {
    const writeIndex = this.writes.length;
    const record = input.write;
    for (const fieldId of Object.keys(record.writtenValues)) {
      record.provenance[fieldId] = this.summariser.summariseTrail(
        input.fieldProvenance[fieldId] ?? NO_PROVENANCE,
      );
    }
    if (input.bindingName !== undefined) record.bindingName = input.bindingName;
    // The interned write origin — later reads of this handle chain to
    // this write by index (E4 provenance across systems).
    record.origin = {
      kind: 'write',
      writeIndex,
      ...(record.externalId !== undefined ? { externalId: record.externalId } : {}),
    };
    this.writes.push(record);
    let written: Extract<Binding, { kind: 'handle' }>;
    if (input.into !== undefined) {
      written = input.into;
      written.handle = record;
    } else {
      written = binding({
        kind: 'handle',
        handle: record,
        // NATURAL currency — linked writes infer their type from the
        // (natural-named) graph schema via this handle; `target.recordType` is
        // that natural name, narrowed by `handleType` where the write's own
        // discriminant named a more specific type than the one it was addressed
        // to (a list entry is a row of ITS list).
        targetType: input.target.handleType ?? input.target.recordType,
        graph: input.target.graph,
      });
    }
    if (input.rehearsed === true && record.old !== undefined) record.old = written;
    if (input.bindingName !== undefined) {
      input.env.declare(input.bindingName, written);
    }
    return written;
  }

  /**
   * Resolve a write's destination: the receiving adapter, the written
   * record type, the graph the handle will live in, and — for linked
   * writes — the parent context.
   *
   * `write <instance>.<type>` routes to the named instance's adapter; a
   * `kg` binding routes to the intrinsic KG adapter through the SAME
   * `resolveAdapter` seam (no special engine path — 6_engine.md).
   *
   * `write h-[:edge]-> { … }` (linked) lands in the parent handle's
   * graph: exactly one declared edge from the parent, written type
   * inferred from that graph's schema (explicit only for polymorphic
   * edges — the checker enforces this when the schema is known; the
   * runtime re-enforces it for untyped graphs).
   */
  private async resolveWriteTarget(
    write: IdentityBody,
    env: Environment,
    verb: 'write' | 'match',
  ): Promise<ResolvedWriteTarget> {
    if (write.target.kind === 'tuple') {
      return this.resolveTupleWriteTarget(write.target, env, verb);
    }

    if (write.target.kind === 'position') {
      // Position writes never reach here — `executeWrite` dispatches them to
      // `executePositionWrite` before resolving a create target.
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'write ${spellPathRoot(write.target.root)} { … }' is a position write — it should have been dispatched to the update path`,
      );
    }

    // Linked write: `write h-[:edge]-> { … }`.
    const target = write.target;
    const rootBinding =
      pathRootName(target.path) !== undefined
        ? env.resolve(pathRootName(target.path)!)
        : undefined;
    // A META-rooted linked write (`write crm-[:companies]-> { … }`) — the root
    // is a bare constructed instance, so this is a top-level create with no
    // parent; the written type is the collection the edge names.
    if (rootBinding?.kind === 'instance') {
      return this.resolveMetaWriteTarget(target, rootBinding);
    }
    const graph = this.linkedPathGraph(target.path, env);
    const parent = this.resolveLinkedParent({
      path: target.path,
      explicitType: target.explicitType,
      env,
      verb,
    });
    return {
      adapter: await this.targetAdapterFor(graph.instance),
      recordType: parent.surfaceType,
      graph,
      parents: [parent.parent],
      where: parent.where !== undefined ? [parent.where] : [],
    };
  }

  /**
   * A meta-rooted linked write — the root names a whole graph (a constructed
   * instance), so the write creates a top-level record with no parent edge.
   * The edge names the collection; its target type is the record's natural
   * type, which the adapter translates to its own id.
   */
  private async resolveMetaWriteTarget(
    target: Extract<WriteExpression['target'], { kind: 'linked' }>,
    binding: Extract<Binding, { kind: 'instance' }>,
  ): Promise<ResolvedWriteTarget> {
    const { edgeName, where } = this.singleWriteEdge(target.path);
    const schema = binding.schema;
    // The collection resolves to the record's natural type (`companies` →
    // `company`); where the schema doesn't map it (a graph's collection IS the
    // natural type, and unpublished types never appear), the edge name IS the
    // natural name — passed through so the adapter stays the authority and
    // fails loud on drift.
    const recordType = target.explicitType ?? schema?.collections[edgeName]?.target ?? edgeName;
    return {
      adapter: await this.targetAdapterFor(binding),
      recordType,
      graph: { kind: 'instance', instance: binding },
      parents: [],
      where: where !== undefined ? [where] : [],
    };
  }

  /** The single declared edge a linked write walks — shared by meta writes and
   *  in-memory shape writes (both name their target with exactly one hop) —
   *  and the `WHERE` on it, when the author narrowed it. */
  private singleWriteEdge(path: PathHead): { edgeName: string; where?: TargetWhere } {
    const probe = this.probeHead(path);
    const steps = probe?.type === 'traverse' ? probe.steps : undefined;
    if (!steps || steps.length !== 1 || steps[0].type !== 'edge') {
      throw unsupported(
        'multi-hop linked writes',
        'a linked write walks exactly one declared edge from its root',
      );
    }
    const where = targetWhereOf(steps[0]);
    return { edgeName: steps[0].edgeTypeId, ...(where !== undefined ? { where } : {}) };
  }

  /** The handle graph a linked/tuple path's root lives in — peeked before
   *  resolving the parent so the graph's resolver can be fetched once. */
  private linkedPathGraph(path: PathHead, env: Environment): HandleGraph {
    const rootName = pathRootName(path);
    const binding = rootName !== undefined ? env.resolve(rootName) : undefined;
    if (binding?.kind === 'handle') return binding.graph;
    // A traversal-bound SOURCE position parents a write too (the
    // positions-and-edges selection form: `sheets-[s:Spreadsheet WHERE …]->
    // { write s-[:cells]-> … }`) — the write lands in the graph the
    // position was read from.
    if (binding?.kind === 'sourcePosition') {
      // Mirror the bind/position-write resolution: a graph-rooted read names
      // its constructed instance; the env binding for that name IS the
      // HandleGraph instance. Event-sourced positions fall back to the
      // movement's source instance.
      if (binding.read !== undefined) {
        const inst = env.resolve(binding.read.instanceName);
        if (inst?.kind === 'instance') return { kind: 'instance', instance: inst };
      } else if (this.sourceInstance !== undefined) {
        return { kind: 'instance', instance: this.sourceInstance };
      }
      throw this.unnamedGraph("a linked write's parent", rootName ?? '');
    }
    // The EVENT parameter parents a write in its source instance's graph
    // (`write msg-[:replies]->` — the messaging write-back shape).
    if (binding?.kind === 'event') {
      if (this.sourceInstance !== undefined) {
        return { kind: 'instance', instance: this.sourceInstance };
      }
      throw this.unnamedGraph("a linked write's parent", rootName ?? '');
    }
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `a linked write's path must start at a bound write handle or a traversed record — '${rootName ?? ''}' is ${binding ? describeBinding[binding.kind] : 'not in scope'}`,
    );
  }

  /**
   * Tuple-path multi-parent write: `write (a-[:e]->, b-[:f]->) { … }` —
   * ONE create at the convergence of N edges. Every path resolves like a
   * linked write's; all paths must land in the SAME graph and infer the
   * SAME written type (the checker enforces it where the schema is
   * typed; the runtime re-enforces it for untyped graphs, naming both
   * inferences).
   */
  private async resolveTupleWriteTarget(
    target: Extract<WriteExpression['target'], { kind: 'tuple' }>,
    env: Environment,
    verb: 'write' | 'match',
  ): Promise<ResolvedWriteTarget> {
    const resolved = target.paths.map((path) =>
      this.resolveLinkedParent({
        path,
        explicitType: target.explicitType,
        env,
        verb,
      }),
    );
    const [first, ...rest] = resolved;
    for (const other of rest) {
      if (other.graph.instance !== first.graph.instance) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `a tuple write's paths must land in the same graph — '${first.rootName}' is in ${describeHandleGraph(first.graph)} and '${other.rootName}' is in ${describeHandleGraph(other.graph)}`,
        );
      }
      if (other.surfaceType !== first.surfaceType) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `the tuple's paths must converge on ONE written type — '${first.rootName}-[:${first.surfaceEdgeName}]->' infers '${first.surfaceType}' but '${other.rootName}-[:${other.surfaceEdgeName}]->' infers '${other.surfaceType}'`,
        );
      }
    }
    const graph = first.graph;
    return {
      adapter: await this.targetAdapterFor(graph.instance),
      recordType: first.surfaceType,
      graph,
      parents: resolved.map((r) => r.parent),
      // One record at the convergence of every path, so each path's WHERE is
      // a condition on that same record: a candidate passes them all.
      where: resolved.flatMap((r) => (r.where !== undefined ? [r.where] : [])),
    };
  }

  /**
   * One parent path of a linked or tuple write: the root must be a bound
   * write handle, the path walks exactly one edge, and the written type
   * is inferred from the parent's graph schema in SURFACE currency
   * (explicit only for polymorphic edges); everything the adapter
   * consumes — parent type, edge name — translates to engine currency
   * here.
   */
  private resolveLinkedParent(input: {
    path: PathHead;
    explicitType: string | undefined;
    env: Environment;
    verb: 'write' | 'match';
  }): {
    graph: HandleGraph;
    surfaceType: string;
    surfaceEdgeName: string;
    rootName: string;
    parent: ResolvedWriteTarget['parents'][number];
    where?: TargetWhere;
  } {
    const rootName = pathRootName(input.path);
    const binding = rootName !== undefined ? input.env.resolve(rootName) : undefined;
    if (binding?.kind === 'shapePosition') {
      throw unsupported(
        'linked writes off a shape position (multi-node shapes)',
        'single-node shape arguments run today',
      );
    }
    if (
      rootName === undefined ||
      (binding?.kind !== 'handle' && binding?.kind !== 'sourcePosition' && binding?.kind !== 'event')
    ) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `a linked write's path must start at a bound write handle, a traversed record, or the event — '${rootName ?? ''}' is ${binding ? describeBinding[binding.kind] : 'not in scope'}`,
      );
    }
    // A source position (traversed, or the EVENT parameter itself) can parent
    // a write only when it carries a STABLE native id — that id IS the
    // parentLink externalId. Unstable positions (webhook payload fan-outs,
    // events whose dispatcher recorded no record ref) have nothing durable to
    // link to.
    const parentPosition =
      binding.kind === 'sourcePosition'
        ? binding.position
        : binding.kind === 'event'
          ? this.source?.position
          : undefined;
    if (binding.kind === 'sourcePosition' || binding.kind === 'event') {
      const identity = parentPosition?.identity;
      if (parentPosition === undefined || identity?.kind !== 'stable' || parentPosition.recordType === null) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          binding.kind === 'event'
            ? `'${rootName}' (the event) carries no durable record id — this source's events can't parent a linked write`
            : `'${rootName}' is a traversed position without a stable record id — only positions with durable native identity (e.g. a WHERE-selected Spreadsheet or Channel) can parent a linked write`,
        );
      }
    }
    const probe = this.probeHead(input.path);
    const steps = probe?.type === 'traverse' ? probe.steps : undefined;
    if (!steps || steps.length !== 1 || steps[0].type !== 'edge') {
      throw unsupported(
        'multi-hop linked writes',
        'a linked write walks exactly one declared edge from its parent handle',
      );
    }
    const edgeName = steps[0].edgeTypeId;
    const where = targetWhereOf(steps[0]);
    const graph = this.linkedPathGraph(input.path, input.env);
    const parentSurfaceType =
      binding.kind === 'handle'
        ? binding.targetType
        : (parentPosition!.recordType as string);
    const parentExternalId =
      binding.kind === 'handle'
        ? binding.handle.externalId
        : (parentPosition!.identity as { kind: 'stable'; recordId: string }).recordId;
    // Type inference happens in SURFACE currency (the instance/kg schema
    // is surface-named; the parent's surface type is the handle's target
    // type or the traversed position's recordType).
    const surfaceType = this.inferLinkedSurfaceType({
      graph,
      parentSurfaceType,
      edgeName,
      explicitType: input.explicitType,
      rootName,
      verb: input.verb,
    });
    const parentData =
      binding.kind === 'handle'
        ? binding.handle.resultData
        : (positionData(parentPosition!) as Record<string, unknown> | undefined) ?? undefined;
    return {
      graph,
      surfaceType,
      surfaceEdgeName: edgeName,
      rootName,
      parent: {
        handleName: rootName,
        // The edge + parent type cross the boundary in the program's NATURAL
        // currency; the adapter resolves the parentLink edge (against the
        // parent's type) and the parent type to its own ids internally.
        edgeName,
        recordType: parentSurfaceType,
        externalId: parentExternalId,
        ...(parentData !== undefined && parentData !== null && typeof parentData === 'object'
          ? { data: parentData as Record<string, unknown> }
          : {}),
      },
      ...(where !== undefined ? { where } : {}),
    };
  }

  /**
   * The type a DISCRIMINATED write's handle stands on — the variant its own
   * body named. Reads the discriminant's written value and looks the variant up
   * in the SAME projected write shape the checker typed the handle against, so
   * the two cannot disagree about which type this record is.
   *
   * Undefined for every ordinary write, for a discriminant that did not resolve
   * to one of the declared literals, and for a variant whose type mints no
   * position — in each case the handle keeps the type the write was addressed
   * to, which is what it has always been.
   */
  private discriminatedHandleType(
    target: ResolvedWriteTarget,
    fields: Record<string, unknown>,
  ): string | undefined {
    const schema = target.graph.instance.schema;
    if (schema === undefined) return undefined;
    const shape =
      schema.writableRoots[target.recordType] ?? schema.createShapes?.[target.recordType];
    const discriminated = shape?.discriminated;
    if (discriminated === undefined) return undefined;
    const value = fields[discriminated.discriminant];
    if (typeof value !== 'string') return undefined;
    const position = discriminated.variants[value]?.position;
    if (position === undefined || schema.positions[position] === undefined) return undefined;
    return position;
  }

  /** The target type one declared edge points at, in surface currency —
   *  shared by linked writes, tuple paths, and matches. */
  private inferLinkedSurfaceType(input: {
    graph: HandleGraph;
    parentSurfaceType: string;
    edgeName: string;
    explicitType: string | undefined;
    rootName: string;
    verb: 'write' | 'match' | 'link';
  }): string {
    const { graph, edgeName } = input;
    const keyword = input.verb;
    const schema = graph.instance.schema;
    // A WRITABLE-ONLY type mints no position (an ask family: you can raise a
    // request, you can never enumerate open ones), so its relationship table
    // lives on the WRITE SHAPE. Same fallback the checker's linked-path
    // resolution makes — without it, `write a-[:Response]->` off a fresh
    // request can't name its own landing type at run time.
    const edge =
      schema?.positions[input.parentSurfaceType]?.edges[edgeName] ??
      (schema?.writableRoots[input.parentSurfaceType] ?? schema?.createShapes?.[input.parentSurfaceType])
        ?.edges?.[edgeName];
    if (edge?.polymorphic && input.explicitType === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${edgeName}' is polymorphic — say which type this ${input.verb === 'write' ? 'write creates' : 'match finds'}: ${keyword} …-[:${edgeName}]-><type> { … }`,
      );
    }
    if (input.explicitType !== undefined) return input.explicitType;
    if (edge !== undefined) return edge.target;
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `cannot infer the ${input.verb === 'write' ? 'written' : 'found'} type for edge '${edgeName}' from '${input.rootName}' (a ${input.parentSurfaceType} handle) — name it explicitly: ${keyword} …-[:${edgeName}]-><type> { … }`,
    );
  }

  /**
   * `unique by (…)` → OR-of-AND constraints, in the program's NATURAL
   * currency (the adapter resolves each `field` to its own property/edge id
   * inside `resolveEntity`, property-then-edge). A backticked component is a
   * target field OR edge name, passed through verbatim; a bare component must
   * name one of the write's own parent handles and lowers to `{ field:
   * <parent's natural edge name> }` — `executeWrite` folds the resolved parent
   * into the resolve record under that edge name so the adapter matches by
   * adjacency (edge-scoped compound identity).
   */
  /**
   * Lower the write's `unique by (…)` predicate(s) to the identity the adapter
   * searches by, plus an engine-side precise post-filter for the parts the
   * coarse search can't express (adapter-capability-contract chunk 8).
   *
   * The predicate is now a full expression. Its EQUALITY backbone — bare
   * `\`field\`` (identify by the value being written), `\`field\` == <literal>`,
   * and bound parent handles (edge-scoped identity) — lowers to OR-of-AND
   * `UniquenessConstraints` (the adapter's currency); literal RHS values ride a
   * `valueOverlay` folded into the resolve record so the adapter's
   * `record[field]` search finds them. NON-equality conjuncts (`WITHIN`,
   * ranges, `!=`) can't be a coarse field match, so each clause's become a
   * narrowing of the candidates ITS key finds, evaluated by the engine via the
   * shared filter unit — precise, over a bounded shortlist (principle 4).
   */
  private uniqueByIdentity(
    write: IdentityBody,
    target: Pick<ResolvedWriteTarget, 'parents'>,
  ): {
    constraints: UniquenessConstraints;
    valueOverlay: Record<string, unknown>;
    narrowings: IdentityNarrowing[];
  } {
    const any: UniquenessConstraints['any'] = [];
    const valueOverlay: Record<string, unknown> = {};
    const narrowings: IdentityNarrowing[] = [];
    for (const clause of write.uniqueBy) {
      const all: { field: string; fuzzy?: boolean }[] = [];
      const nonKey: Expression[] = [];
      // FUZZY rides on a textual conjunct, so split first (lifting the modifier)
      // then flatten each parsed part — equivalent to a single-parse flatten for
      // plain predicates, but it carries the per-component fuzzy flag through.
      for (const part of splitUniquenessConjuncts(clause.predicate.raw)) {
        const fuzzyMark = part.fuzzy ? { fuzzy: true as const } : {};
        for (const conjunct of flattenAndConjuncts(parseMovementExpression(part.raw))) {
          const key = identityKeyOf(conjunct);
          if (key === undefined) {
            nonKey.push(conjunct);
          } else if (key.comparedWith !== undefined) {
            all.push({ field: key.name, ...fuzzyMark });
            if (key.comparedWith.type === 'static') valueOverlay[key.name] = key.comparedWith.value;
          } else {
            // A bare name: a field of the written record (identify by its written
            // value), OR a bound parent handle (→ the parent's edge name,
            // edge-scoped identity).
            const parent = target.parents.find((p) => p.handleName === key.name);
            all.push({ field: parent ? parent.edgeName : key.name, ...fuzzyMark });
          }
        }
      }
      if (all.length === 0) {
        // The checker's MOV_UNIQUE_CONJUNCT_NEEDS_WHERE, held at run time: a
        // clause with nothing to search by finds nothing for its tests to narrow.
        throw unsupported(
          `a 'unique by' clause with no key ('${clause.predicate.raw}')`,
          'add the field or parent that finds the record, or move the test onto a WHERE on the target',
        );
      }
      const searchKey = { all };
      any.push(searchKey);
      if (nonKey.length > 0) {
        narrowings.push({
          key: searchKey,
          filter: nonKey.length === 1 ? nonKey[0] : { type: 'logical', op: 'and', operands: nonKey },
        });
      }
    }
    return { constraints: { any }, valueOverlay, narrowings };
  }

  /**
   * Narrow a key's candidates to those that satisfy its clause's non-key
   * conjuncts, via the shared filter unit over each candidate's own fields.
   *
   * A field the conjunct reads that the candidate lacks: the lookup's snapshot
   * may simply not carry it, so the record is read first (`readRecord`, as the
   * target's WHERE reads it); a field the record still lacks is absent, and
   * the conjunct is decided as written — an absent field fails an equality, a
   * range or `WITHIN`, and satisfies `!=`.
   */
  private async narrowCandidatesByPredicate(input: {
    candidates: ExternalRecordRef[];
    predicate: Expression;
    adapter: Adapter;
    recordType: string;
  }): Promise<ExternalRecordRef[]> {
    const { predicate, adapter } = input;
    if (!isPurePredicate(predicate)) {
      // The checker's MOV_UNIQUE_CONJUNCT_NEEDS_WHERE, held at run time.
      throw unsupported(
        "a 'unique by' test that reads beyond the candidate",
        'move it onto a WHERE on the target',
      );
    }
    const fields = pureLeafReads(predicate).map(leafReadKey);
    const kept: ExternalRecordRef[] = [];
    for (const candidate of input.candidates) {
      let data = candidate.data;
      if (fields.some((f) => !(f in data)) && typeof adapter.readRecord === 'function') {
        const current = await adapter.readRecord({
          recordType: input.recordType,
          externalId: candidate.externalId,
        });
        data = { ...data, ...(current ?? {}) };
      }
      const read = data;
      if (evaluatePredicate(predicate, { read: (name) => read[name] })) kept.push(candidate);
    }
    return kept;
  }

  /** What `resolveIdentity` needs to run a target's `WHERE`: the filters, and
   *  the graph and scope to read each candidate in. Absent when the target
   *  carries no WHERE. */
  private candidateWhere(
    target: Pick<ResolvedWriteTarget, 'where' | 'graph' | 'handleType'>,
    env: Environment,
  ): { candidateWhere?: CandidateWhere } {
    if (target.where.length === 0) return {};
    return {
      candidateWhere: {
        filters: target.where,
        graph: target.graph,
        env,
        ...(target.handleType !== undefined ? { handleType: target.handleType } : {}),
      },
    };
  }

  /**
   * Narrow the identity shortlist to the candidates the target's `WHERE`
   * admits. Each candidate is read as the record it is — the adapter's
   * `readRecord` over its snapshot, the same data a match binds — and stands
   * where a traversal's landed record stands: the hop alias names it, a bare
   * field reads it, and a hop inside the filter (`EXISTS(c-[:deals]->)`)
   * walks from it through the target graph's read seam. So the WHERE means
   * here exactly what it means on a read hop. Strict, unlike the pure
   * post-filter: the author asked for records that satisfy it, and a
   * candidate that does not is not one — the shortlist's order is kept.
   */
  private async narrowCandidatesByTargetWhere(input: {
    candidates: ExternalRecordRef[];
    adapter: Adapter;
    recordType: string;
    where: CandidateWhere;
  }): Promise<ExternalRecordRef[]> {
    if (input.candidates.length === 0) return input.candidates;
    const read = await this.instanceSourceRead(input.where.graph.instance);
    const kept: ExternalRecordRef[] = [];
    for (const candidate of input.candidates) {
      const current =
        typeof input.adapter.readRecord === 'function'
          ? await input.adapter.readRecord({
              recordType: input.recordType,
              externalId: candidate.externalId,
            })
          : null;
      // The position a matched handle reads through (`graphReadFor`): the
      // handle's type, its id, and its result data.
      const position = makeStablePosition({
        adapterType: input.adapter.adapterType,
        recordType: input.where.handleType ?? input.recordType,
        recordId: candidate.externalId,
        data: {
          ...(candidate.url !== undefined ? { url: candidate.url } : {}),
          ...candidate.data,
          ...(current ?? {}),
        },
      });
      if (await this.candidatePassesTargetWhere({ position, read, where: input.where })) {
        kept.push(candidate);
      }
    }
    return kept;
  }

  private async candidatePassesTargetWhere(input: {
    position: SourcePosition;
    read: SourceRead;
    where: CandidateWhere;
  }): Promise<boolean> {
    const { position, read } = input;
    for (const { alias, filter } of input.where.filters) {
      const env = input.where.env.child();
      if (alias !== undefined) env.declare(alias, binding({ kind: 'sourcePosition', position, read }));
      const keep = await evaluateMovementExpression(filter, {
        ...this.exprContext(env),
        scope: { kind: 'position', position, read },
      });
      if (!keep) return false;
    }
    return true;
  }

  /** The firing-log linkage projection of a write's parent set. */
  private parentSummaries(
    parentLinks: ParentLink[],
  ): { parents?: Array<{ recordType: string; externalId: string; edgeName: string }> } {
    if (parentLinks.length === 0) return {};
    return {
      parents: parentLinks.map((p) => ({
        recordType: p.recordType,
        externalId: p.externalId,
        edgeName: p.edgeName,
      })),
    };
  }

  /** An update by id. It reads the record's current values and merges into
   *  them, so it holds the record while it does (`recordLock`). */
  private async applyUpdate(input: UpdateInput): Promise<WriteRecord | { notFound: true }> {
    return this.effectLocks.withLocks(input.locks ?? [recordLock(input.adapter, input.externalId)], () =>
      this.mergeIntoRecord(input),
    );
  }

  private async mergeIntoRecord(input: UpdateInput): Promise<WriteRecord | { notFound: true }> {
    // Current values against the live record, when the adapter can read one.
    // `replace` uses them for no-op suppression; `?:`/`+:`/`+?:` for the
    // set-if-empty / append merge. When the adapter can't read current values
    // (no readRecord) every field is treated as written-from-empty — the safe
    // direction (fill/append both reduce to "set the new value").
    const currentValues = input.adapter.readRecord
      ? await input.adapter.readRecord({
          recordType: input.recordType,
          externalId: input.externalId,
          fieldIds: Object.keys(input.fields),
        })
      : null;
    const before = this.recordBefore(input, currentValues);
    const fieldsToWrite: Record<string, unknown> = {};
    for (const [fieldId, value] of Object.entries(input.fields)) {
      const mode = input.fieldSemantics[fieldId];
      const current = currentValues?.[fieldId];

      if (mode === 'fill') {
        // Write only when the current value is EMPTY — null/undefined, or an
        // empty list (an empty STRING still counts as a value, unchanged from
        // the TG engine's set-if-null). Single or multi.
        if (!isEmptyFieldValue(current)) continue;
        fieldsToWrite[fieldId] = value;
        continue;
      }

      if (mode === 'append' || mode === 'append-missing') {
        // Multi-value merge against the current list. `append` concatenates
        // (duplicates allowed); `append-missing` adds only elements not already
        // present (set union). The adapter still receives a single final list.
        const currentArr = toFieldArray(current);
        const incoming = toFieldArray(value);
        const merged =
          mode === 'append'
            ? [...currentArr, ...incoming]
            : [...currentArr, ...incoming.filter((v) => !currentArr.some((c) => deepEqual(c, v)))];
        if (currentValues && deepEqual(merged, currentArr)) continue; // no-op
        fieldsToWrite[fieldId] = merged;
        continue;
      }

      // replace (default) — overwrite with no-op suppression.
      if (currentValues && deepEqual(value, current)) continue;
      fieldsToWrite[fieldId] = value;
    }
    // Pure no-op only when there is NOTHING to send: no changed fields, no
    // resource provenance, AND no parent to attach to.
    //
    // Resources: an extract-fed write whose fields all match the live record
    // still needs its source resources recorded against the node (Layer 5).
    //
    // Parents: matching is not associating. A matched child whose own fields
    // are unchanged still carries an instruction to hang off its parent —
    // `write org-[:People]-> { … }` on an existing person means "this person
    // belongs to this org", and only the adapter can make that association.
    // Skipping the adapter here silently dropped every such edge (prod, run
    // 3285f127). When fields are empty the adapter receives the empty set and
    // the parent links, and attaches without touching the record's own fields.
    const hasResources = (input.resources?.length ?? 0) > 0;
    const hasParents = input.parentLinks.length > 0;
    if (Object.keys(fieldsToWrite).length === 0 && !hasResources && !hasParents) {
      return {
        adapterType: input.adapter.adapterType,
        recordType: input.recordType,
        created: false,
        committed: this.committedThrough(input.adapter),
        externalId: input.externalId,
        writtenValues: {},
        ...(before.reads !== undefined ? { foundData: before.reads } : {}),
        outcome: 'noop',
        provenance: {},
        ...this.parentSummaries(input.parentLinks),
        ...(before.old !== undefined ? { old: before.old } : {}),
      };
    }
    // Any `FileRef` in the fields carries its own `retrieve()` byte channel —
    // the consuming adapter pulls the bytes itself (streamFileRef). The engine
    // just hands the fields through. Node-level resources ride alongside
    // (`WriteInput.resources`) — the adapter's resource sink persists them.
    const updated = await input.adapter.updateRecord({
      recordType: input.recordType,
      externalId: input.externalId,
      fields: fieldsToWrite,
      evidence: evidenceForWrite(input.fieldEvidence, fieldsToWrite),
      ...(hasResources ? { resources: input.resources } : {}),
      mutationContext: this.mutationContext,
      // Forwarded so edge-anchored field writes on a matched node can
      // resolve the existing parent → child edge(s) (W4-KG3); external
      // adapters ignore it. Mirrors the TG engine's update branch. A
      // linked write is the 1-element case of the general N-parent list.
      parentLinks: input.parentLinks,
    });
    // NOT-FOUND contract (3b): the target record is gone. Surface it so the
    // bind flow can self-heal (drop the stale binding + re-mint). A non-bind
    // update never reaches here with a stale id (it resolved by identity
    // moments ago), but the typed signal is propagated uniformly.
    if (!updateRecordSucceeded(updated)) return { notFound: true };
    // The adapter answers for the parent the write named, and 'attach' is
    // reported on the strength of that answer alone. A system that cannot
    // attach an EXISTING record along the edge the author wrote fails the
    // write: the author asked for a relationship, and a run that reported
    // success while nothing joined anything is the bug this whole field
    // exists to close.
    if (updated.association === 'unsupported') {
      const parent = input.parentLinks[0];
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${input.adapter.adapterType}' cannot attach an existing ${input.recordType} to ` +
          `${parent.recordType} ${parent.externalId} through ${parent.edgeName}`,
      );
    }
    return {
      adapterType: input.adapter.adapterType,
      recordType: input.recordType,
      created: false,
      committed: this.committedThrough(input.adapter),
      externalId: input.externalId,
      writtenValues: fieldsToWrite,
      resultData: writeResultData(updated),
      ...(before.reads !== undefined ? { foundData: before.reads } : {}),
      // 'attach' is the parent-only send: no field of the record's own
      // changed, the adapter was called purely to make the association — and
      // the adapter has just confirmed the association holds.
      outcome:
        Object.keys(fieldsToWrite).length > 0 || hasResources ? 'update' : 'attach',
      provenance: {},
      ...this.parentSummaries(input.parentLinks),
      ...(updated.association === 'made' || updated.association === 'already'
        ? { association: updated.association }
        : {}),
      ...(before.old !== undefined ? { old: before.old } : {}),
    };
  }

  /**
   * The record an update found, as it stood: the snapshot its handle's
   * `-[:@old]->` lands on, and the values the new handle reads for the fields
   * the write did not send. Both come from what the engine already held plus
   * the read the merge has just made; nothing here asks the adapter again.
   *
   * Version 4 on. Before it a handle read only what its write sent and the
   * adapter answered (a pinned program reading another field still reads
   * null), and it has no `@old` to reach — its checker refuses the hop.
   */
  private recordBefore(
    input: UpdateInput,
    currentValues: Record<string, unknown> | null,
  ): { old?: Extract<Binding, { kind: 'handle' }>; reads?: Record<string, unknown> } {
    if (input.prior === undefined || before(this.languageVersion, 4)) return {};
    const data = { ...input.prior.data, ...(currentValues ?? {}) };
    return {
      old: snapshotOfRecord({
        adapterType: input.adapter.adapterType,
        recordType: input.recordType,
        externalId: input.externalId,
        data,
        targetType: input.prior.targetType,
        graph: input.prior.graph,
      }),
      reads: { ...data },
    };
  }

  private async applyCreate(input: {
    adapter: Adapter;
    recordType: string;
    fields: Record<string, unknown>;
    /** Per-field evidence for provenance-faithful values — the record
     *  and its evidence persist as one transactional unit (3b §3.3). */
    fieldEvidence: Record<string, FieldEvidence>;
    /** Node-level resource provenance (Layer 5) — the source content that fed
     *  the extracted node this write materialises, persisted against the new
     *  record (`WriteInput.resources`). Empty for non-extract writes. */
    resources?: Resource[];
    descriptor: Awaited<ReturnType<Adapter['describe']>>;
    parentLinks: ParentLink[];
    /** False for linked/tuple writes — required-field applicability
     *  follows the TG engine's root/child context (`hideOn` filtering). */
    isRoot: boolean;
    bridgeToExternal?: WriteInput['bridgeToExternal'];
  }): Promise<WriteRecord> {
    // Required-field hard gate — same contract as the TG engine's create
    // branch: creating a record that leaves a target-required field empty
    // fails loud, naming the fields. Everything here speaks the program's
    // NATURAL names (the write `fields` are keyed by them; the descriptor's
    // `displayName` is the field's natural name). A required REFERENCE field
    // satisfied by a parent link (the linked/tuple form sets it structurally)
    // must not double-fire — the parent's `edgeName` IS the reference's
    // natural name.
    const satisfiedByParentLink = new Set(input.parentLinks.map((p) => p.edgeName));
    const missingRequired = applicableRequiredFields({
      descriptorFields: input.descriptor?.fields ?? [],
      isRoot: input.isRoot,
    })
      .map((f) => f.displayName)
      .filter(
        (fieldName) =>
          isEmptyWriteValue(input.fields[fieldName]) && !satisfiedByParentLink.has(fieldName),
      );
    if (missingRequired.length > 0) {
      const typeLabel = input.descriptor?.displayName ?? input.recordType;
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `cannot create a ${typeLabel} record: required field(s) ${missingRequired
          .map((f) => `"${f}"`)
          .join(', ')} have no value`,
      );
    }
    // Any `FileRef` in the fields (an email attachment, a `#resources` file)
    // carries its own `retrieve()` byte channel — the consuming adapter pulls the
    // bytes itself (streamFileRef / exposeFile). The engine hands fields through.
    const created = await input.adapter.createRecord({
      recordType: input.recordType,
      fields: input.fields,
      evidence: evidenceForWrite(input.fieldEvidence, input.fields),
      // Node-level resources (Layer 5) — the source content that fed the
      // extracted node, persisted against the new record by the adapter's
      // resource sink (KG: resource row + node_resource link + facts).
      ...((input.resources?.length ?? 0) > 0 ? { resources: input.resources } : {}),
      mutationContext: this.mutationContext,
      // Parent → child wiring (KG: insert every connecting edge inside
      // the same transaction; N for a tuple-path write, 1 for a linked
      // write, 0 for a root) and the anchor write's external bridge —
      // both mirrored from the TG engine's create branch.
      parentLinks: input.parentLinks,
      bridgeToExternal: input.bridgeToExternal,
    });
    return {
      adapterType: input.adapter.adapterType,
      recordType: input.recordType,
      created: true,
      committed: this.committedThrough(input.adapter),
      externalId: created.externalId,
      writtenValues: input.fields,
      resultData: writeResultData(created),
      outcome: 'create',
      provenance: {},
      ...this.parentSummaries(input.parentLinks),
    };
  }

  /**
   * Per-instance target adapters, resolved through the shared seam with
   * `role: 'target'` and dry-run-wrapped — cached per (slug, credential)
   * exactly like the TG engine's `resolveTargetAdapter`.
   */
  private async targetAdapterFor(
    instance: Extract<Binding, { kind: 'instance' }>,
  ): Promise<Adapter> {
    // Dry-run is decided per-instance from the instance's OWN construction —
    // read here, at the moment we resolve the adapter we're about to write
    // through, so no upstream static analysis can misjudge it. A whole-run
    // rehearsal (Test run) forces every instance dry; a `dry_run: true`
    // construction rehearses just that target inside an otherwise-live run.
    const dryRun = this.input.dryRun === true || instanceIsDryRun(instance);
    return this.resolveTargetAdapter(
      instance.adapterSlug,
      this.credentialsIdFor(instance),
      dryRun,
      constructionArgsOf(instance),
    );
  }

  private async resolveTargetAdapter(
    adapterType: string,
    credentialsId: string | undefined,
    dryRun: boolean,
    constructionArgs?: Record<string, string>,
  ): Promise<Adapter> {
    const argsKey =
      constructionArgs && Object.keys(constructionArgs).length
        ? JSON.stringify(Object.entries(constructionArgs).sort(([a], [b]) => a.localeCompare(b)))
        : '';
    const cacheKey = `${dryRun ? 'dry ' : ''}${adapterType} ${credentialsId ?? ''} ${argsKey}`;
    const cached = this.targetAdapterCache.get(cacheKey);
    if (cached) return cached;
    const real = await this.resolveAdapterFn({
      adapterType,
      teamId: this.input.teamId,
      credentialsId,
      ...(constructionArgs && Object.keys(constructionArgs).length ? { constructionArgs } : {}),
      role: 'target',
    });
    const wrapped = dryRun ? wrapAdapterForDryRun(real, this.rehearsal) : real;
    if (dryRun) this.dryAdapters.add(wrapped);
    this.targetAdapterCache.set(cacheKey, wrapped);
    return wrapped;
  }

  /** The dry-run-wrapped target adapters — membership is the per-write
   *  `committed` signal: a write through one of these was captured, not
   *  committed (`resolveTargetAdapter` wraps + registers iff the target is
   *  rehearsed). */
  private readonly dryAdapters = new WeakSet<Adapter>();

  /** THIS run's rehearsal, shared by every target it wraps: one sink, and one
   *  memory of the ids it invented. A write chained off a rehearsed parent
   *  routinely crosses systems (the company in the CRM, the entry on its
   *  list), so the memory of what is real belongs to the run rather than to
   *  either adapter. */
  private rehearsalState?: DryRunRehearsal;
  private get rehearsal(): DryRunRehearsal {
    return (this.rehearsalState ??= newDryRunRehearsal(this.input.writeSink));
  }

  /** Whether a write through this resolved adapter actually committed —
   *  false when the adapter is a dry-run wrapper. */
  private committedThrough(adapter: Adapter): boolean {
    return !this.dryAdapters.has(adapter);
  }

  // ── Expressions ──

  private exprContext(env: Environment): MovementExprContext {
    return {
      env,
      languageVersion: this.languageVersion,
      source: this.source,
      graphRead: (name, binding) => this.graphReadFor(name, binding),
      walkDeferred: async (walk, extraSteps) =>
        (await this.runDeferredWalk(walk, extraSteps)).flatMap((iteration) =>
          iteration.landing !== undefined ? [iteration.landing] : [],
        ),
      llm: this.llmClient(),
      resolveFileText: this.fileTextResolver(),
      trace: this.trace,
      // `@<key>` resolution — the dispatch context the frozen engine's
      // resolveMetaKey reads, with the run-wide actor caches. The bag
      // mirrors the frozen field-mapping pipeline's per-dispatch bag.
      meta: {
        event: this.input.event,
        teamId: this.input.teamId,
        now: this.pinnedNow,
        bag: { trigger: this.input.event, mutationContext: this.mutationContext },
        actingUserCache: this.actingUserCache,
        actorCache: this.actorCache,
      },
    };
  }

  /**
   * `channel = FIRST(chat-[ch:Channels WHERE …]->)` — the assignment that binds
   * a RECORD, not a value. The checker types it as a maybe-empty position, and
   * the engine has to agree: a `value` binding holding a position object would
   * parent no write (`resolveLinkedParent` reads the binding KIND) and carry no
   * read seam, so the write would land in the wrong graph if it landed at all.
   *
   * Walked through the ordinary block-head machinery — the selection IS a
   * traversal, and taking one of its landings is what FIRST/LAST mean. No
   * landing binds a plain null: absence, in the language's own currency, which
   * `x == null` then answers.
   *
   * Undefined for every other expression, which assigns as before.
   */
  /**
   * `btn = a` — a bare name already bound on the NODE plane re-binds the SAME
   * binding under a second name (the checker's alias rule). Evaluating it as
   * an expression would collapse the position to a scalar value and every
   * later walk off the new name would find nothing.
   */
  private aliasedNodeBinding(slot: ExprSlot, env: Environment): Binding | undefined {
    const trimmed = slot.raw.trim();
    let name: string | undefined;
    if (BARE_IDENT.test(trimmed)) {
      name = trimmed;
    } else {
      // Backtick-coined names only exist parsed.
      try {
        name = bareName(expressionOfSlot(slot));
      } catch {
        return undefined; // a parse failure is the evaluator's to report
      }
    }
    if (name === undefined) return undefined;
    const binding = env.resolve(name);
    if (binding === undefined) return undefined;
    switch (binding.kind) {
      case 'event':
      case 'handle':
      case 'extractRoot':
      case 'extractPosition':
      case 'sourcePosition':
      case 'resource':
      case 'blockMeta':
      case 'shapePosition':
      case 'nodePosition':
      case 'lazyWalk':
      case 'callback':
      case 'positions':
      case 'closure':
      case 'tuple':
        return binding;
      // `S = Company`: a declaration's name, read as a value, is the shape
      // itself from version 3 — a second name for it.
      case 'shape':
        return since(this.languageVersion, 3) ? binding : undefined;
      case 'value':
      case 'instance':
      case 'movement':
      case 'plugin':
      case 'opaque':
        return undefined;
    }
  }

  private async selectedPositionBinding(
    slot: ExprSlot,
    env: Environment,
  ): Promise<Binding | undefined> {
    let path: ReturnType<typeof aggregatedBarePath>;
    try {
      path = aggregatedBarePath(expressionOfSlot(slot));
    } catch {
      return undefined; // a parse failure is the evaluator's to report
    }
    if (path === undefined || path.aliasRoot === undefined) return undefined;
    const rootBinding = env.resolve(path.aliasRoot);
    if (rootBinding === undefined) return undefined;
    // `-[:@old]->` is no system's edge: the evaluator answers it from the
    // handle, and the record it selects binds as itself.
    if (rootBinding.kind === 'handle' && startsWithOldEdge(path.steps)) return undefined;
    const resolved =
      rootBinding.kind === 'event' || rootBinding.kind === 'sourcePosition'
        ? this.source !== undefined
          ? {
              start: rootBinding.kind === 'event' ? this.source.position : rootBinding.position,
              read:
                rootBinding.kind === 'sourcePosition' && rootBinding.read !== undefined
                  ? rootBinding.read
                  : this.source,
            }
          : undefined
        : await this.graphReadFor(path.aliasRoot, rootBinding);
    if (resolved === undefined) return undefined;
    const landings = await this.walkSourceHeadPaths({
      start: resolved.start,
      steps: path.steps,
      env,
      read: resolved.read,
    });
    // ONLY is a cardinality claim: more than one landing means it was wrong,
    // and nothing at author time could have seen that (same rule the value
    // plane's fold follows).
    if (path.fn === 'only' && landings.length > 1) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `ONLY(${slot.raw.trim()}) says there is exactly one, and there are ${landings.length}. Narrow it until there is.`,
      );
    }
    const landed = path.fn === 'last' ? landings[landings.length - 1] : landings[0];
    if (landed?.position === undefined) {
      return binding({ kind: 'value', value: null, provenance: NO_PROVENANCE });
    }
    // The head's own seam rides the binding only when it is NOT the event
    // source, exactly as a block head's aliases carry it.
    const bindingRead = resolved.read === this.source ? undefined : resolved.read;
    return binding({
      kind: 'sourcePosition',
      position: landed.position,
      ...(bindingRead !== undefined ? { read: bindingRead } : {}),
    });
  }

  /**
   * The BINDING an expression slot is — the one reading of a value expression,
   * shared by `x = <expr>` and by a traversal head rooted at one, so the bound
   * and unbound forms cannot drift apart. A synthesised node's edge and a
   * selected position bind as the records they are; everything else binds as
   * the value it evaluated to, records included.
   */
  private async bindSlotValue(slot: ExprSlot, env: Environment): Promise<Binding> {
    const staged = await this.stageNestedCalls(slot, env);
    if (staged !== undefined) return this.bindSlotValue(staged.slot, staged.env);
    const aliased = this.aliasedNodeBinding(slot, env);
    if (aliased !== undefined) return aliased;
    const selected = await this.selectedPositionBinding(slot, env);
    if (selected !== undefined) return selected;
    const evaluated = await this.evaluateSlot(slot, { env });
    return bindValue(evaluated.value, evaluated.provenance, { many: this.bindsManyValues(slot, env) });
  }

  /** A walk read for a field, or a second name for one: the value bound is
   *  the walk's collapse, and the binding keeps the fact a spread reads
   *  (`isManyValued` in expression.ts; the checker's `ScopeSymbol.plural`). */
  private bindsManyValues(slot: ExprSlot, env: Environment): boolean {
    const expr = expressionOfSlot(slot);
    if (isWalkProjection(expr)) return true;
    const name = bareName(expr);
    if (name === undefined) return false;
    const binding = env.resolve(name);
    return binding?.kind === 'value' && binding.many === true;
  }

  /** A concise body's call, when its callee is a function — a movement, a
   *  plugin or a closure; undefined for a construction or a built-in, which
   *  the ordinary `return` evaluates. */
  private conciseCall(value: RValue, env: Environment): CallStatement | undefined {
    const call = value.kind === 'call' ? value.call : value.kind === 'construct' ? constructionAsCall(value.construct) : undefined;
    if (call === undefined) return undefined;
    const kind = env.resolve(this.calleeName(call.callee, env))?.kind;
    return kind === 'movement' || kind === 'plugin' || kind === 'closure' ? call : undefined;
  }

  /**
   * The live scopes a collection op's statement runs in, its file's left out
   * (a file scope is found again by its file) — what a member's answer names
   * rather than copies. A closure a member returns holds its scope by
   * reference, so a park that copied the scopes around the op would hand the
   * resumed run a closure that writes a copy of the movement's handle while
   * the movement reads its own; numbered by their place in the chain, the
   * same on the writing run and the resuming one, they come back as the live
   * scopes themselves.
   */
  private liveAnswerChain(event: CallEvent): Environment[] {
    const env = event.site?.env;
    if (env === undefined) return [];
    return env.chainFromRoot().filter((scope) => scope !== this.fileEnv && !this.libraryPaths.has(scope));
  }

  /** A park for one member's answer, naming the live chain (`liveAnswerChain`)
   *  — from version 5, where a function written in place holds its scope by
   *  reference (`collectionFunction`); before, the answer is written as it
   *  always was. */
  private memberAnswerPark(event: CallEvent): ParkWriter | undefined {
    if (before(this.languageVersion, 5)) return undefined;
    const park = this.newPark();
    this.liveAnswerChain(event).forEach((scope, id) => {
      park.scopeIds.set(scope, id);
      park.chainScopes.add(scope);
    });
    return park;
  }

  /** Scopes `evaluateSlot` bound a slot's list element closures in. */
  private readonly closureEnvs = new WeakSet<Environment>();

  private async evaluateSlot(
    slot: ExprSlot,
    options: {
      env: Environment;
      /** Write-field evaluation only — the destination field's adapter
       *  functions (see `MovementExprContext.fieldFunctions`). */
      fieldFunctions?: MovementExprContext['fieldFunctions'];
    },
  ): Promise<MovementEvalResult> {
    // A closure written as a list element (language version 5) is a value:
    // (AST, scope), holding the scope it is written in by REFERENCE, as a
    // closure bound to a name does. It is bound around the slot under the
    // name the lowering reads it by.
    if (slot.closures !== undefined && !this.closureEnvs.has(options.env)) {
      const around = options.env.child();
      for (const { at, closure } of slot.closures) {
        around.declare(slotClosureName(at), binding({ kind: 'closure', closure, captured: new Map(), env: options.env }));
      }
      this.closureEnvs.add(around);
      return this.evaluateSlot(slot, { ...options, env: around });
    }
    const staged = await this.stageNestedCalls(slot, options.env);
    if (staged !== undefined) return this.evaluateSlot(staged.slot, { ...options, env: staged.env });
    let expr: Expression;
    try {
      expr = expressionOfSlot(slot);
    } catch (e) {
      if (e instanceof BridgeError) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `invalid expression (the checker should have caught this): ${e.message}`,
        );
      }
      throw e;
    }
    // The slot's span locates any literals the expression carries —
    // the program is part of the trail.
    return evalMovementExpr(expr, {
      ...this.exprContext(options.env),
      literalSpan: slot.span,
      ...(options.fieldFunctions !== undefined ? { fieldFunctions: options.fieldFunctions } : {}),
    });
  }
}

/** A single bare identifier — a name-only call argument / IS subject. */
const BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What an `IS <Doc>` subject offers — three answers, because there are three
 * facts. `notARecord` is not a position at all (a scalar, an instance, a
 * deferred plural): no structure, so an ordinary false. `unknown` IS a position
 * whose structure the run cannot see: not the same fact, and not allowed to
 * share an answer with it.
 */
type SubjectSurface =
  | { kind: 'surface'; surface: SuppliedSurface }
  | { kind: 'unknown'; reason: string }
  | { kind: 'notARecord' };

/** A schema-published position, as a surface — `unknown` when the kind is in
 *  hand but nothing describes it. */
function positionSurface(
  schema: InstanceSchema | undefined,
  position: string,
): SubjectSurface {
  const surface = schema && schemaSurface(schema, position);
  return surface === undefined
    ? { kind: 'unknown', reason: undescribedKind(position) }
    : { kind: 'surface', surface };
}

/** The record's kind is known; its STRUCTURE is not, so there is nothing to
 *  compare a declared node against. */
const undescribedKind = (position: string): string =>
  `nothing describes the structure of a '${position}'`;
const UNKNOWN_STRUCTURE = 'nothing describes its structure';

/** Why an `IS` test had nothing to compare against. Author-facing halves of
 *  `undiscriminatedIsTest`, kept here so the two throw sites cannot drift. */
const UNDISCRIMINATED_EVENT =
  'the event arrived without a discriminated kind, so the trigger never said which one it was';
const UNSTAMPED_LANDING =
  'the connected system returned it without a record type';
/** The address case: the event HAS an address, but not on the axis the test
 *  pins. Names the axis, since that is the field the trigger has to deliver
 *  for the branch to be answerable. */
const unpinnedAxis = (axes: string[]): string =>
  `the event carries no ${axes.map(a => `'${a}'`).join(' or ')}, and this test asks about `
  + `${axes.length === 1 ? 'it' : 'them'}`;

/** The lexical alias of a `-[f:_resources …]->` head's hop (the parsed
 *  `resource_traverse` drops it). `#resources` is accepted as a deprecated
 *  alias for legacy heads. */
const RESOURCES_HEAD_ALIAS = /^\s*-\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:_resources|#resources)\b/;

/** Identifier tokens in an expression's source text, EXCLUDING the names that
 *  follow a `.` (field reads — `d.\`name\`` references the binding `d`, not a
 *  binding `name`) and backtick-quoted field names. Used to find which in-scope
 *  bindings a write field draws from, for Layer-5 resource collection — a loose
 *  superset is fine (over-collected resources dedupe on their stable id). */
function referencedIdentifiers(raw: string): string[] {
  // Strip backtick-quoted segments (field names) so `\`name\`` never registers.
  const withoutFields = raw.replace(/`[^`]*`/g, ' ');
  const names = new Set<string>();
  const re = /(\.)?\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutFields)) !== null) {
    if (m[1] === '.') continue; // a field/method name after a dot — not a binding
    names.add(m[2]);
  }
  return [...names];
}

// ── Event seeding (mirrors the TG engine's trigger root) ────────────────────

/**
 * The event's source position — what the movement parameter binds to.
 * Mirrors `seedRootSourcePosition` in `engine/evaluate.ts`:
 *   - webhook: a discriminated inbound event seeds the typed stable
 *     record; otherwise the raw payload rides an unstable position.
 *     Property reads then go through the source adapter exactly as
 *     they do under the TG engine;
 *   - snapshot: the source instance's meta position (the manual_run.ts
 *     backfill shape) — collection blocks fan out from it. The envelope
 *     carries no adapter identity of its own (run_now.ts builds it
 *     before the program is parsed), so the seed speaks the source
 *     INSTANCE's adapter slug.
 */
/**
 * Resolve a discriminated inbound root's `positionType` (a machine typeId like
 * `granola:note`) to its NATURAL type name (`Meeting Note`) via the adapter's
 * own entry points — the same `typeId → displayName` mapping the resolver is
 * built from. The seed then names the root the way the program and the
 * field/edge resolver do. Falls back to the id itself when it names no entry
 * (e.g. Airtable's static `airtable:webhook_record` positionType), where the
 * resolver's bilingual tolerance + the adapter's name-keyed reads carry it.
 */
async function naturalRootTypeName(
  adapter: Adapter,
  rootRecordType: string | undefined,
): Promise<string | undefined> {
  if (rootRecordType === undefined) return undefined;
  try {
    const entries = await adapter.listEntryPoints();
    return entries.find((e) => e.typeId === rootRecordType)?.displayName ?? rootRecordType;
  } catch {
    return rootRecordType;
  }
}

/**
 * The canonical address of the EVENT NODE a typed inbound event seeds, or
 * undefined when the source's schema declares no event edges (such a source
 * keeps its stable record seed).
 *
 * THE EVENT IS JUST A NODE, so the seed's type is that node narrowed by what
 * the event itself says: each declared address hop (`eventNarrowingKeys`)
 * read off the payload's same-named field (`base`, `table` — the adapter
 * publishes them ON the event node precisely so the same values narrow both),
 * plus the payload's `action` when the node declares that axis. The node is
 * picked by the event's own discrimination (`rootTypeName`, the natural name
 * of `rootRecordType`) — the multi-edge case (whatsapp's message / reaction /
 * location) — falling back to the sole declared edge.
 *
 * The same derivation types the seed (`eventAddressKey`) and answers runtime
 * IS tests (pin subset), so check time and fire time cannot disagree.
 *
 */
/**
 * The one event node an adapter publishes, when it publishes exactly one.
 *
 * Derived, not named: an adapter with a single event surface has no ambiguity
 * about which node an event of its is, and one with several must discriminate
 * (which is what `rootRecordType` is for). Nothing here knows which adapter it
 * is looking at.
 */
function soleEventPosition(schema: InstanceSchema | undefined): string | undefined {
  const nodes = schema?.eventPositions;
  return nodes !== undefined && nodes.length === 1 ? nodes[0].position : undefined;
}

function eventSeedAddress(input: {
  schema: InstanceSchema | undefined;
  event: TriggerEvent;
  rootTypeName: string | undefined;
}): EventAddress | undefined {
  const schema = input.schema;
  const nodes = schema?.eventPositions;
  if (schema === undefined || nodes === undefined || nodes.length === 0) return undefined;
  if (input.event.triggerType !== 'webhook' && input.event.triggerType !== 'poll') {
    return undefined;
  }
  const node =
    nodes.find((n) => n.position === input.rootTypeName)?.position
    ?? (nodes.length === 1 ? nodes[0].position : undefined);
  if (node === undefined) return undefined;
  const payload =
    typeof input.event.payload === 'object' && input.event.payload !== null
      ? (input.event.payload as Record<string, unknown>)
      : undefined;
  const narrowing: Record<string, string> = {};
  for (const key of schema.eventNarrowingKeys ?? []) {
    const value = payload?.[key];
    if (typeof value === 'string' && value.length > 0) narrowing[key] = value;
  }
  const actionType = schema.positions[node]?.properties[EVENT_ACTION_FIELD];
  if (isEnumType(actionType)) {
    const value = payload?.[EVENT_ACTION_FIELD];
    if (typeof value === 'string' && value.length > 0) narrowing[EVENT_ACTION_FIELD] = value;
  }
  return { event: node, narrowing };
}

function seedEventPosition(
  event: TriggerEvent,
  sourceAdapterSlug: string,
  options: {
    /** The NATURAL type name to stamp on the root seed's recordType: the
     *  mutation's KG node type (the param's declared surface type) or a
     *  discriminated inbound type resolved to its displayName (see
     *  `naturalRootTypeName`). The surface-read wrapper + the adapter's resolver
     *  translate field/edge names against it. Without it the seed would carry
     *  the discriminated `positionType` — a machine typeId the field resolver
     *  keys nothing on (it keys by displayName) — the
     *  `'<field>' is not a known field of '<typeId>'` drift. */
    surfaceType?: string;
    /** The delivered NODE's canonical narrowed address (`eventSeedAddress`).
     *  When set, the seed is that node, typed by `eventAddressKey(address)` —
     *  the same identity the checker grafts — with the payload riding in
     *  `data`. STABLE when the fires edge lands straight on the discriminated
     *  record (`surfaceType === address.event` and the dispatcher recorded its
     *  id); an event node distinct from its record seeds UNSTABLE (an
     *  occurrence — its record is reached by the record edge on demand).
     *  Supersedes `surfaceType` for the webhook/poll branch. */
    eventAddress?: EventAddress;
  } = {},
): SourcePosition {
  // Webhook (unsolicited) and poll (solicited PollSource pull) seed the same
  // way: a discriminated event seeds the typed stable record (the adapter's
  // `listEventTypes` matched it to a concrete type); otherwise the raw payload
  // rides an unstable position. Property/edge reads then go through the source
  // adapter identically.
  if (event.triggerType === 'webhook' || event.triggerType === 'poll') {
    if (options.eventAddress !== undefined) {
      // A typed event: the seed IS the delivered node, typed by its canonical
      // narrowed address (an unpinned address keys as the bare node name —
      // `Message`), so `ev IS <chat-[:Message]->>` and the
      // pinned forms resolve.
      //
      // Stability follows from WHAT the edge delivers. Where the fires edge
      // lands straight on the record (rule 1's collapse — the adapter's own
      // discrimination named the delivered node, and the dispatcher recorded
      // its durable id), the seed IS that record: stable, so a linked write
      // can anchor off the parameter (`write e-[:replies]->`) exactly as it
      // anchored off the retired record-edge hop. An event node DISTINCT from
      // its record (airtable/attio — the discrimination names the RECORD's
      // type, not the event node) stays an unstable occurrence whose record
      // is reached by its own edge on demand.
      const externalId = event.externalRecordRef?.externalId;
      if (externalId !== undefined && options.surfaceType === options.eventAddress.event) {
        return makeStablePosition({
          adapterType: event.adapterType,
          recordType: eventAddressKey(options.eventAddress),
          recordId: externalId,
          data: event.payload,
        });
      }
      return makeUnstablePosition({
        adapterType: event.adapterType,
        recordType: eventAddressKey(options.eventAddress),
        data: event.payload,
      });
    }
    const externalId = event.externalRecordRef?.externalId;
    if (event.rootRecordType && externalId) {
      return makeStablePosition({
        adapterType: event.adapterType,
        // The program's declared natural type names the root (mirroring the
        // mutation branch's `surfaceType`). Fall back to the discriminated
        // `rootRecordType` (a typeId) only when the param is untyped — that path
        // leans on the resolver's bilingual tolerance.
        recordType: options.surfaceType ?? event.rootRecordType,
        recordId: externalId,
        data: event.payload,
      });
    }
    // A TYPELESS POSITION IS AN ERROR (ruling 2026-07-19).
    //
    // The two branches above name the type from the program's declared
    // parameter (`surfaceType`) or the event's discriminated root; this
    // fallback used to mint `recordType: null` when neither applied, and an
    // untyped position is not a weaker guarantee, it is none. Every downstream
    // read then GUESSES: field ids resolve against nothing, and edge names used
    // to be resolved by scanning every described type for a matching name — a
    // whole-graph read with no collision policy, arrived at because the type
    // was thrown away here.
    //
    // NAME THE TYPE WHERE IT IS KNOWN. `surfaceType` still applies when the
    // event carries no external record, so take it before falling back — that
    // is strictly more type than the `null` this used to mint unconditionally.
    //
    // It does NOT throw when neither is known, and that is a measured
    // retraction rather than a concession. "A typeless position is an error"
    // (ruling 2026-07-19) is right about the goal, but enforcing it HERE breaks
    // 145 engine tests: the engine seeds positions in many flows before a type
    // is established, so typeless-at-seed is a normal intermediate state in the
    // current design, not an exceptional one. Making it an error is a real
    // design change to the seed path, not a guard — and the guard that belongs
    // at the RESOLUTION boundary (`BaseAdapter.resolveEdgeReadId`) is already
    // there, which is where a typeless position actually causes a wrong answer.
    const inferredType = options.surfaceType ?? event.rootRecordType ?? null;
    return makeUnstablePosition({
      adapterType: event.adapterType,
      recordType: inferredType,
      data: event.payload,
    });
  }
  if (event.triggerType === 'snapshot') {
    return makeMetaPosition(sourceAdapterSlug);
  }
  if (event.triggerType === 'mutation') {
    // The changed record, anchored by the trigger's recordId — seeded against
    // the SOURCE INSTANCE's adapter, exactly as the webhook doors seed theirs.
    if (!event.recordId) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        'a mutation event carries no recordId — nothing to seed the changed record from',
      );
    }
    return makeStablePosition({
      adapterType: sourceAdapterSlug,
      recordType: options.surfaceType ?? null,
      recordId: event.recordId,
    });
  }
  throw unsupported(
    `'${event.triggerType}' trigger events`,
    'the movement engine seeds webhook, poll, snapshot, and mutation events',
  );
}

// ── Write-shape helpers (mirrored from engine/evaluate.ts) ──────────────────

/**
 * Bind a write field's advertised functions (`SchemaFieldDescriptor.
 * functions`) to thunks invoking the target adapter's
 * `invokeFieldFunction` — mirrored from the frozen engine's
 * `bindFieldFunctions` (engine/evaluate.ts; private there): keyed by the
 * lowercased call name (the parser lowercases `fn`), `args[0]` coerced
 * to the `instructions` brief, `args[1..]` passed through verbatim.
 * Undefined when the field advertises none, so non-built-in names stay
 * unsupported on ordinary fields.
 */
function bindMovementFieldFunctions(input: {
  targetAdapter: Adapter;
  recordType: string;
  fieldId: string;
  descriptor: SchemaFieldDescriptor | undefined;
}): MovementExprContext['fieldFunctions'] {
  const functions = input.descriptor?.functions;
  if (!functions || functions.length === 0) return undefined;
  const { targetAdapter, recordType, fieldId } = input;
  const map: Record<string, (args: unknown[]) => Promise<unknown>> = {};
  for (const fn of functions) {
    map[fn.name.toLowerCase()] = async (args: unknown[]) => {
      if (!targetAdapter.invokeFieldFunction) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `the '${targetAdapter.adapterType}' adapter advertises ${fn.name}() on '${recordType}.${fieldId}' but does not implement invokeFieldFunction`,
        );
      }
      return targetAdapter.invokeFieldFunction({
        recordType,
        fieldId,
        functionName: fn.name,
        args: { instructions: String(args[0] ?? ''), data: args.slice(1) },
      });
    };
  }
  return map;
}

/** The evidence map a write carries: the faithful fields' evidence,
 *  restricted to the fields actually being written — `undefined` when
 *  none qualify (mirrors the TG engine's `writeEvidence`). */
function evidenceForWrite(
  fieldEvidence: Record<string, FieldEvidence>,
  fieldsToWrite: Record<string, unknown>,
): Record<string, FieldEvidence> | undefined {
  const evidence: Record<string, FieldEvidence> = {};
  for (const fieldId of Object.keys(fieldsToWrite)) {
    const fieldEv = fieldEvidence[fieldId];
    if (fieldEv) evidence[fieldId] = fieldEv;
  }
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

/** Where a handle's record lives, for the cross-graph edge error. */
function describeHandleGraph(graph: HandleGraph): string {
  return `'${graph.instance.name}'`;
}

/** A handle's interned write origin as a trail — the edge-assert entry's
 *  per-endpoint provenance (refs into the run's own `writes`). */
function handleTrail(handle: WriteRecord): Provenance {
  return handle.origin !== undefined ? { origins: [handle.origin] } : NO_PROVENANCE;
}

/** The handle's result-data bag: the adapter's flat `WriteResult.data`
 *  plus the top-level `url` when one is surfaced (explicit keys win). */
function writeResultData(written: WriteResult): Record<string, unknown> {
  return {
    ...(written.url !== undefined ? { url: written.url } : {}),
    ...written.data,
  };
}

/** A value that doesn't satisfy a required field: absent, null, empty
 *  string, or an empty array. */
function isEmptyWriteValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Emptiness for the `?:` (set-if-empty) gate: null/undefined or an empty list.
 * Distinct from `isEmptyWriteValue` — an empty STRING counts as a value here
 * (a `?:` write must not overwrite a deliberately-blanked text field), matching
 * the TG engine's set-if-null semantics.
 */
function isEmptyFieldValue(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

/** Normalise a field value to an array for the append merges — a scalar wraps
 *  as a one-element list; null/undefined is the empty list. */
function toFieldArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Cardinality coercion before the value hits the adapter — many target +
 * scalar wraps as `[value]`; one (or undeclared) target + array joins as
 * CSV. Mirrored from the TG engine so both engines emit byte-identical
 * field values.
 *
 * A `json` field is exempt from the CSV join: it holds a JSON DOCUMENT, and an
 * array IS one, so joining would stringify every element (`"[object Object],
 * [object Object]"`) — the tap-loss defect. The field's KIND is what decides,
 * not a guess about the value's shape.
 */
function coerceValueForFieldCardinality(
  value: unknown,
  field: Pick<SchemaFieldDescriptor, 'kind' | 'cardinality'> | undefined,
): unknown {
  if (value === null || value === undefined) return value;
  const targetIsMany = field?.cardinality === 'many';
  if (targetIsMany && !Array.isArray(value)) return [value];
  if (!targetIsMany && Array.isArray(value)) {
    if (field?.kind === 'json') return value;
    return value
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v))
      .join(', ');
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], (b as unknown[])[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

/**
 * The field a `record`-output plugin hands its fetched PAGE back under. The
 * invocation has two channels — the properties a plugin attached and the text
 * it fetched — and a record output reads both: the properties by their own
 * names, the text by this one. A plugin that attaches a property of the same
 * name wins, since that is the more specific claim.
 */
const PLUGIN_FETCHED_TEXT_FIELD = 'text';

/**
 * What a plain plugin call binds, and whether the plugin actually handed
 * anything back.
 *
 * The binding always EXISTS — a declared output is `T | absent`, and absence in
 * this language is a value that reads null, never a missing name. So a fetch
 * that failed binds null and `page == null` answers it; a record whose plugin
 * attached nothing binds a node whose every read is null. `handedBack` is the
 * separate question, and it is the trace's, not the program's.
 */
function pluginCallBinding(
  output: TransformOutputKind,
  result: TransformInvocationResult,
  provenance: Provenance,
): { binding: Binding; handedBack: boolean } {
  switch (output.kind) {
    case 'value': {
      const value = result.text !== undefined && result.text !== '' ? result.text : null;
      return { binding: binding({ kind: 'value', value, provenance }), handedBack: value !== null };
    }
    case 'records': {
      // One record per thing the plugin found, in its order — the landings of
      // a hop, so FIRST, MAP and a field read across them all work as they do
      // on any other list of records. None found is the empty list.
      const landings = (result.records ?? []).map((record): Binding => {
        const fieldProvenance: Record<string, Provenance> = {};
        for (const name of Object.keys(record)) fieldProvenance[name] = provenance;
        return binding({
          kind: 'nodePosition',
          fields: { ...record },
          fieldOrder: Object.keys(record),
          fieldProvenance,
          edges: {},
        });
      });
      return { binding: binding({ kind: 'positions', landings }), handedBack: landings.length > 0 };
    }
    case 'record':
      return recordCallBinding(result, provenance);
    default:
      return neverAsAny(output);
  }
}

function recordCallBinding(
  result: TransformInvocationResult,
  provenance: Provenance,
): { binding: Binding; handedBack: boolean } {
  const fields: Record<string, unknown> = {};
  const fieldProvenance: Record<string, Provenance> = {};
  if (result.text !== undefined && result.text !== '') {
    fields[PLUGIN_FETCHED_TEXT_FIELD] = result.text;
  }
  Object.assign(fields, result.data ?? {});
  for (const name of Object.keys(fields)) fieldProvenance[name] = provenance;
  return {
    binding: binding({ kind: 'nodePosition', fields, fieldOrder: Object.keys(fields), fieldProvenance, edges: {} }),
    handedBack: Object.keys(fields).length > 0,
  };
}

/**
 * Does this parameter take a VALUE — a scalar, a refinement declared in the
 * callee's file, or a list or record of them spelled out — rather than a record
 * position? The checker's reading of the same written type
 * (`paramValueType`), on the names the engine has.
 */
function isValueParam(param: MovementParam, declaredTypes: ReadonlyMap<string, SchemaFieldType>): boolean {
  const type = param.type;
  if (type === undefined) return false;
  if (isValueTypeRef(type)) return true;
  if (type.hopsRaw !== undefined) return false;
  return parseFieldTypeName(type.graph) !== undefined || declaredTypes.has(type.graph);
}
