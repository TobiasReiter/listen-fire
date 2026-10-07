// The engine's one boundary with the world (cloud-native DESIGN §6). Everything
// a run reaches outside its own program — adapters, models, durable parks,
// files, the database, cross-run locks — comes through the `EngineHost` its
// caller hands it; the rest of `RunMovementInput` is data. A host decides what
// the world is: the production host wires Postgres, Anthropic and the adapter
// registry (`translation_graph/movement/engine_host.ts`); a test host wires
// fakes, and a piece a test did not provide fails loudly when the run reaches
// it, never by quietly reaching a real system.

import type { FileArtifactType, LanguageVersion } from 'movement-lang';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { Budget, CostLine } from '../../lib/run_cost';
import type {
  ActingUser,
  Adapter,
  FileRef,
  GetRelatedInput,
  RelatedPage,
  RuntimeCapabilities,
} from '../translation_graph/adapter';
import type { AwaitPoint, AwaitResolution } from '../translation_graph/awaitable';
import type { MethodName } from '../translation_graph/protocol/schema';
import type { SourcePosition } from '../translation_graph/types';
import type { TriggerEvent } from '../translation_graph/triggers/types';
import type { LlmCallInput, LlmCallResult } from '../translation_graph/engine/batched_extraction';
import type { ArbitrationAnswer, EntityArbitration } from '../translation_graph/engine/entity_match';
import type { CallbackCall, CallbackParamSpec } from './callback_types';
import type { MovementTraceEntry } from './expression';
import type { FileTextResolution, TransformInvocationResult, TransformInvokeInput } from './extraction';
import type { ExtractCallLlmInput, ExtractCallLlmResult } from './extraction_call';
import type { CancelGate, ParkSink } from './run';
import type { ParkedScopeState } from './serialize';

// ── Priced calls ────────────────────────────────────────────────────────────
//
// Every host call that may cost money takes the run's remaining budget in and
// answers what it spent. The host refuses priced work past the budget with a
// `budget` refusal carrying what it spent first; the engine keeps the run's
// account and raises the cap from it (movement_engine/run_context.ts).

/** A priced call's request: the engine's input and the run's remaining budget. */
export type Priced<Input> = Input & { budget: Budget };

/** A priced call's answer and what the call spent, by source. Absent ⇒ it
 *  spent nothing. */
export type Costed<Output> = Output & { cost?: CostLine[] };

/**
 * Why a host call did not answer, as data. The engine maps each kind onto its
 * own control flow; nothing thrown on the host side is recognised by class on
 * the engine side.
 *
 *  - `call_ceiling`: the segment made as many third-party calls as one segment
 *    may. The engine fails the run with the message, and `onError` never
 *    forgives it.
 *  - `budget`: priced work refused because the run's budget is spent. The
 *    engine charges what the call spent first and raises the run's cap. Only
 *    a priced call answers it.
 *  - `adapter_error`: the adapter failed; the engine fails the statement with
 *    the message, as it would any error, under the failure's own `name`.
 */
export interface HostCallError {
  kind: 'call_ceiling' | 'adapter_error' | 'budget';
  message: string;
  /** The failure's own name on the host (`SlackApiError`), when it is not a
   *  plain `Error`. */
  name?: string;
  /** What else the host knows of the failure. */
  detail?: HostErrorDetail;
}

/** A failure's particulars that a caller may branch on or report: the HTTP
 *  status the remote answered, and its error code. */
export interface HostErrorDetail {
  status?: number;
  code?: string;
}

/** Why an adapter call did not answer. An adapter call is not priced (it
 *  carries no budget), so it is never refused as `budget`. */
export type AdapterCallError = HostCallError & { kind: 'call_ceiling' | 'adapter_error' };

/** A priced call refused past the budget, with what it spent before the
 *  refusal. */
export type BudgetRefusal = Costed<{ error: HostCallError & { kind: 'budget' } }>;

/** A priced call's whole answer: what it was asked for, or the refusal. */
export type PricedAnswer<Output> = Costed<Output> | BudgetRefusal;

/** What the engine asks of an adapter instance. */
export interface AdapterResolution {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
  /** Non-credential construction args (unquoted) — the instance's entry
   *  position (Sheets' `spreadsheet:`). Position-free adapters ignore it. */
  constructionArgs?: Record<string, string>;
  role: 'source' | 'target';
  /** Rehearse its writes: the host wraps the instance so a create, update,
   *  delete, link or unlink is captured (the host's write sink), never made,
   *  and reads still answer from the live system. */
  dryRun?: boolean;
}

/**
 * The adapter protocol's methods the engine may call on an instance, by name
 * (the protocol's own `METHODS`, translation_graph/protocol/schema.ts). Three
 * are not here: `manifest`, which `adapters.resolve` answers as data;
 * `iterateRelated`, whose async iterable never crosses — the engine walks a
 * traversal page by page with `iterateRelatedPage`; and `resolveFileRef`,
 * whose answer is a byte stream — bytes stay on the host, which redeems a
 * file's descriptor itself (`files.resolveFileText`, a target's upload).
 */
export const ADAPTER_METHODS = [
  'listEntryPoints',
  'describe',
  'edgesFrom',
  'resolveEntity',
  'getFieldValue',
  'getRelated',
  'iterateRelatedPage',
  'preprocessInbound',
  'listEventTypes',
  'createRecord',
  'updateRecord',
  'deleteRecord',
  'linkRecords',
  'unlinkRecords',
  'ensureEventSubscription',
  'removeEventSubscription',
  'resolveAwait',
  'wakeKeys',
  'readRecord',
  'translateFilter',
  'getDedupRules',
  'getActorCandidates',
  'extractActor',
  'describeOpaqueId',
  'invokeFieldFunction',
] as const satisfies readonly MethodName[];

export type AdapterMethod = (typeof ADAPTER_METHODS)[number];

type LiveMethod<K extends keyof Adapter> = NonNullable<Adapter[K]> extends (...args: never[]) => unknown
  ? NonNullable<Adapter[K]>
  : never;
/** A method that takes one input object: that object is its args. */
type OneInput<K extends keyof Adapter> = {
  args: Parameters<LiveMethod<K>>[0];
  result: Awaited<ReturnType<LiveMethod<K>>>;
};
type NoInput<K extends keyof Adapter> = {
  args: Record<string, never>;
  result: Awaited<ReturnType<LiveMethod<K>>>;
};

/** Each method's arguments, as one JSON object (the protocol's `params`),
 *  and its answer. */
export interface AdapterCallMap {
  listEntryPoints: NoInput<'listEntryPoints'>;
  describe: { args: { typeId: string }; result: Awaited<ReturnType<Adapter['describe']>> };
  edgesFrom: { args: { position: SourcePosition; cursor?: unknown }; result: Awaited<ReturnType<LiveMethod<'edgesFrom'>>> };
  resolveEntity: OneInput<'resolveEntity'>;
  getFieldValue: OneInput<'getFieldValue'>;
  getRelated: OneInput<'getRelated'>;
  /** One page of a traversal; `cursor` is absent on the first page, then the
   *  last page's `nextCursor`. */
  iterateRelatedPage: { args: GetRelatedInput & { cursor?: unknown }; result: RelatedPage };
  preprocessInbound: OneInput<'preprocessInbound'>;
  listEventTypes: NoInput<'listEventTypes'>;
  createRecord: OneInput<'createRecord'>;
  updateRecord: OneInput<'updateRecord'>;
  deleteRecord: OneInput<'deleteRecord'>;
  linkRecords: OneInput<'linkRecords'>;
  unlinkRecords: OneInput<'unlinkRecords'>;
  ensureEventSubscription: OneInput<'ensureEventSubscription'>;
  removeEventSubscription: { args: Parameters<LiveMethod<'removeEventSubscription'>>[0]; result: null };
  /** The awaitable capability's live check. */
  resolveAwait: { args: AwaitPoint; result: AwaitResolution };
  wakeKeys: OneInput<'wakeKeys'>;
  readRecord: OneInput<'readRecord'>;
  translateFilter: OneInput<'translateFilter'>;
  getDedupRules: OneInput<'getDedupRules'>;
  getActorCandidates: OneInput<'getActorCandidates'>;
  extractActor: OneInput<'extractActor'>;
  describeOpaqueId: OneInput<'describeOpaqueId'>;
  invokeFieldFunction: OneInput<'invokeFieldFunction'>;
}

/** One call into an instance: the segment it is made for, the instance's
 *  opaque id (from `adapters.resolve`), the method and its arguments. */
export interface AdapterCall<M extends AdapterMethod = AdapterMethod> {
  segmentId: string;
  instance: string;
  method: M;
  args: AdapterCallMap[M]['args'];
}

/** What an adapter call answers: its result, or why there is none. */
export type AdapterCallAnswer<M extends AdapterMethod = AdapterMethod> =
  | { result: AdapterCallMap[M]['result'] }
  | { error: AdapterCallError };

/**
 * An instance as `adapters.resolve` describes it: an opaque id the engine
 * names on every call into it, and everything about it that is data — what it
 * is, what it can do, which methods it implements.
 */
export interface ResolvedAdapter {
  /** Opaque, and meaningful only within the segment it was resolved for. */
  instance: string;
  adapterType: string;
  supportedTriggers: Adapter['supportedTriggers'];
  capabilities: RuntimeCapabilities;
  /** The methods the instance implements. `iterateRelated` means it streams
   *  a traversal, which the engine walks with `iterateRelatedPage`; an
   *  instance may stream, page, both or neither. */
  methods: Array<AdapterMethod | 'iterateRelated'>;
  walksContainers?: boolean;
  webhookEventTypeId?: string;
  metaRecordType?: string;
}

/** Adapter resolution — the SAME seam `evaluateTranslationGraph` and provision
 *  use: one instance per (adapterType, credential, construction args, role,
 *  rehearsal). Every call names the segment it is made for: the instance
 *  answers inside that segment's host scope (what it already read, how many
 *  calls it made). */
export interface HostAdapters {
  resolve(input: AdapterResolution & { segmentId: string }): Promise<ResolvedAdapter>;
  call<M extends AdapterMethod>(input: AdapterCall<M>): Promise<AdapterCallAnswer<M>>;
}

/** The extraction keyword's and `AI()`'s model call. */
export interface HostLlmClient {
  call(input: Priced<LlmCallInput>): Promise<PricedAnswer<LlmCallResult>>;
}

/** The extraction CALL's model call (`extract(content, Shape)`). */
export interface HostExtractCallClient {
  call(input: Priced<ExtractCallLlmInput>): Promise<PricedAnswer<ExtractCallLlmResult>>;
}

/** `through` stages and plugin calls. What the engine knows of a plugin —
 *  its arguments, its declared output, whether it is priced — is the run's
 *  catalog snapshot's (`plugins`); invoking it is the host's. */
export interface HostTransformInvoker {
  invoke(input: Priced<TransformInvokeInput>): Promise<PricedAnswer<TransformInvocationResult>>;
}

/** Which candidate an identity search's write IS: the index into
 *  `candidates`, or null to create, with the judge's failure when it could
 *  not be asked (`judgeUnavailable`, its message). Asked only when the rules
 *  alone cannot decide (`arbitrateWithoutJudge`), so it is the judge's model
 *  call. */
export type ArbitrateEntities = (input: Priced<EntityArbitration>) => Promise<PricedAnswer<ArbitrationAnswer>>;

/** A file's extracted TEXT (the knowledge-pipeline parity path). The host
 *  redeems the descriptor's bytes and runs the extractor (transcription and
 *  OCR are priced); only text, or the reason there is none, comes back. */
export type ResolveFileText = (input: Priced<{ file: FileRef }>) => Promise<PricedAnswer<FileTextResolution>>;

/** What a segment is opened for. */
export interface SegmentOpening {
  /** The run, when it has one (a test or dry run may not). */
  runId?: string;
  teamId: TeamId;
  /** The movement's pin, which an adapter's version conditionals read. */
  languageVersion: LanguageVersion;
}

/** `FILE(content, type)`: the host renders the composed string, stores the
 *  artifact, and answers the stored file's descriptor. */
export type RenderFile = (input: { content: string; type: FileArtifactType }) => Promise<FileRef>;

/**
 * One fully-qualified record position — a binding endpoint. NOT (system,
 * recordId): the same record id in a different Airtable base is a different
 * record, so the endpoint carries the instance's identity too. Construction
 * config is the raw, un-normalized args the engine already holds; the store
 * canonicalizes it.
 */
export interface BindingEndpoint {
  /** Adapter slug (any casing — the store normalizes it). */
  adapterType: string;
  /** The credential's stable identity, when the instance has one. Absent for
   *  construction-free intrinsics (manual, cron) and the KG. */
  credentialId?: string;
  /** The instance's construction config (the Airtable base, the Slack
   *  workspace, …) — the args the movement's construction call carried; the
   *  credential arg is carried separately via `credentialId`. Omit / `{}` when
   *  none. */
  constructionConfig?: Record<string, unknown>;
  /** The STABLE INTERNAL type id (already resolved natural→internal), so a
   *  type rename never orphans a binding. */
  typeId: string;
  /** The stable external record id (KG node id when this endpoint is the KG). */
  recordId: string;
}

/** An endpoint as the store keeps it: the instance canonicalized into one
 *  key. A counterpart comes back in this form, and the engine can hand it
 *  back (to delete a stale binding) without reversing the key. */
export interface EncodedEndpoint {
  adapterType: string;
  instanceKey: string;
  typeId: string;
  recordId: string;
}

/** The symmetric correspondence store a `write … bind other { … }` keeps:
 *  "this record IS the counterpart of that one". */
export interface RecordBindings {
  record(input: { teamId: TeamId; from: BindingEndpoint; to: BindingEndpoint }): Promise<void>;
  /** The record bound to `endpoint`, restricted to `counterpart`'s instance and
   *  type when given; the most recently bound when there are several. */
  findBoundCounterpart(input: {
    teamId: TeamId;
    endpoint: BindingEndpoint;
    counterpart?: Omit<BindingEndpoint, 'recordId'>;
  }): Promise<EncodedEndpoint | null>;
  delete(input: {
    teamId: TeamId;
    from: BindingEndpoint | EncodedEndpoint;
    to: BindingEndpoint | EncodedEndpoint;
  }): Promise<void>;
}

export interface ResolveActingUserInput {
  teamId: TeamId;
  /** The trigger the event dispatched through; absent when the event predates
   *  trigger-aware dispatch. */
  triggerId?: string;
  /** The source instance (as `adapters.resolve` answered it) whose parse of
   *  the event's actors the host asks for — only when the trigger does not
   *  already decide the user. */
  segmentId: string;
  instance: string;
  event: TriggerEvent;
}

/** The callback seam: minting `callback(…)` and reading its call ledger (an
 *  `await cb-[:Called]->` parks through `ParkSink` like any await). Separate from `ParkSink` on purpose:
 *  a park is a leaf the run is waiting on, a callback is not one. */
export interface CallbackSink {
  /** Mint a callback: persist the captured continuation + signature, yield the
   *  binding's `{ id, url }`. */
  mint(input: {
    address: string;
    params: CallbackParamSpec[];
    state: ParkedScopeState;
    singleUse: boolean;
    /** When it stops answering, as an ISO 8601 instant. Absent ⇒ never. */
    expiresAt?: string;
  }): Promise<{ id: string; url: string }>;
  /** The LIVE call ledger — what `cb-[:Called]->` reads and what a re-entered
   *  `await cb-[:Called]->` re-checks. */
  calls(callbackId: string): Promise<CallbackCall[]>;
}

/** The key an await parked under, as `park.wake` takes it. */
export interface AwaitWakeRequest {
  /** The awaitable adapter's type, or the reserved callback identity. */
  adapterType: string;
  teamId: TeamId;
  correlationKey: string;
}

/** Cross-run write locks, by segment. A token stands for one acquire. */
export interface HostLocks {
  acquire(input: { segmentId: string; names: readonly string[] }): Promise<{ token: string }>;
  release(input: { token: string }): Promise<void>;
}

export interface EngineHost {
  /**
   * The host's half of a run segment: what its adapter calls have already read
   * and how many third-party calls they have made. The engine opens one per
   * entry point and closes it however the segment ends; `close` answers what
   * the segment's adapter calls spent (an adapter may make a model call of its
   * own), which the engine charges to the run.
   */
  segment: {
    open(input: SegmentOpening): Promise<{ segmentId: string }>;
    close(input: { segmentId: string }): Promise<{ cost?: CostLine[] }>;
  };
  /** Adapter instances: resolved per segment, called by method. The engine
   *  never holds a live adapter. */
  adapters: HostAdapters;
  llm: {
    /** The extraction keyword's and `AI()`'s model client. */
    client: HostLlmClient;
    /** The extraction CALL's client (`extract(content, Shape)`), which sends
     *  its prompt as blocks with cache breakpoints. */
    extractCall: HostExtractCallClient;
    /** `through` stages and plugin calls. */
    transforms: HostTransformInvoker;
    /** Identity arbitration among a write's search candidates. */
    arbitrateEntities: ArbitrateEntities;
  };
  park: {
    /**
     * Where a park's details go — the lexical address and serialized scope of
     * a timer / await / suspension — to be persisted and woken later. Absent ⇒
     * the run has no durable substrate (a dry run): a run that reaches a park
     * raises, and a resumed join closes only its own leaf.
     */
    sink?: ParkSink;
    /**
     * Queue the wake for one correlation key: "resume whatever is parked on
     * it". The engine calls it after an await park is durable, when its own
     * re-check finds the await resolved (or cannot tell): a landing that
     * arrived between the first check and the park woke nothing, because a
     * wake for a key with no parked run is a no-op. Plain data in, nothing out.
     */
    wake(request: AwaitWakeRequest): Promise<void>;
    /** Minting `callback(…)`, reading its call ledger, correlating an
     *  `await cb-[:Called]->`. Absent ⇒ a callback raises MOVENG_UNSUPPORTED. */
    callbacks?: CallbackSink;
    bindings: RecordBindings;
  };
  control: {
    /** Consulted at each statement and LLM-call boundary; a cancel stops the
     *  run there, never mid-write. */
    cancel: CancelGate;
  };
  files: {
    resolveFileText: ResolveFileText;
    render: RenderFile;
  };
  lookup: {
    /**
     * The team user an event acts as (`@user_*`): the source adapter parses
     * the event's actor candidates, the host maps them to a team user through
     * the trigger the event dispatched through (its creator override and
     * creator fallback). Null when no user matches.
     */
    resolveActingUser(input: ResolveActingUserInput): Promise<ActingUser | null>;
  };
  /** The cross-run write locks each segment's effects take beneath their
   *  own: `acquire({ segmentId, names })` answers a token, `release({ token })`
   *  gives back what that acquire took. The segment's lock session closes with
   *  the segment. */
  locks: HostLocks;
  /**
   * Where the run's decision trace goes while the run is still going, so a
   * caller can publish it before the run settles: the engine appends each
   * statement's new entries once the statement is done, and what is left as
   * the segment ends. The whole trace is on the run's result either way.
   * Absent ⇒ the result only.
   */
  trace?: {
    append(input: { segmentId: string; entries: MovementTraceEntry[] }): Promise<void>;
  };
}

// ── The manifest ────────────────────────────────────────────────────────────

/** Every method of every family, by its path on `EngineHost`
 *  (`park.sink.recordJoin`), each callable on its own. */
type MethodPaths<T, Prefix extends string> = {
  [K in keyof T & string]-?: NonNullable<T[K]> extends (...args: never[]) => unknown
    ? `${Prefix}${K}`
    : MethodPaths<NonNullable<T[K]>, `${Prefix}${K}.`>;
}[keyof T & string];

export type HostMethodPath = MethodPaths<EngineHost, ''>;

/**
 * The host's families and their methods: the contract docs/engine-host.md
 * documents family by family, and the set the seam guard proves crosses as
 * JSON. `optional` marks a family an embedder may leave out (the engine takes
 * its no-substrate path) or, within `park.sink`, a method it may.
 */
export const HOST_FAMILIES = {
  segment: { methods: ['open', 'close'] },
  adapters: { methods: ['resolve', 'call'] },
  'llm.client': { methods: ['call'] },
  'llm.extractCall': { methods: ['call'] },
  'llm.transforms': { methods: ['invoke'] },
  llm: { methods: ['arbitrateEntities'] },
  'park.sink': {
    optional: true,
    methods: [
      'recordJoin',
      'commitTimerPark',
      'commitAwaitPark',
      'decrementJoin',
      'persistBranchExport',
      'collectBranchExports',
      'cancelSubtrees',
      'commitSuspension',
      'commitLimitPause',
    ],
  },
  park: { methods: ['wake'] },
  'park.callbacks': { optional: true, methods: ['mint', 'calls'] },
  'park.bindings': { methods: ['record', 'findBoundCounterpart', 'delete'] },
  'control.cancel': { methods: ['cancelled', 'cancelledNow'] },
  files: { methods: ['resolveFileText', 'render'] },
  lookup: { methods: ['resolveActingUser'] },
  locks: { methods: ['acquire', 'release'] },
  trace: { optional: true, methods: ['append'] },
} as const satisfies Record<string, { optional?: true; methods: readonly string[] }>;

type Manifest = typeof HOST_FAMILIES;
type ManifestPath = {
  [F in keyof Manifest & string]: `${F}.${Manifest[F]['methods'][number]}`;
}[keyof Manifest & string];

// The manifest names exactly the methods `EngineHost` declares: a method added
// to a family and left out here, or listed here and not on the host, fails to
// compile.
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;
export type ManifestIsTheHost = Holds<Exactly<ManifestPath, HostMethodPath>>;

/** Each method's path (`park.sink.recordJoin`), from the manifest. */
export function hostMethodPaths(): string[] {
  return Object.entries(HOST_FAMILIES).flatMap(([family, { methods }]) => methods.map((method) => `${family}.${method}`));
}
