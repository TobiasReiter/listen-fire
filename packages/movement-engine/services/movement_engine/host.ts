// The engine's one boundary with the world (cloud-native DESIGN §6). Everything
// a run reaches outside its own program — adapters, models, durable parks,
// files, the database, cross-run locks — comes through the `EngineHost` its
// caller hands it; the rest of `RunMovementInput` is data. A host decides what
// the world is: the production host wires Postgres, Anthropic and the adapter
// registry (`translation_graph/movement/engine_host.ts`); a test host wires
// fakes, and a piece a test did not provide fails loudly when the run reaches
// it, never by quietly reaching a real system.

// What crosses as data — the request and answer envelopes, a segment's
// opening, an adapter resolution, a binding endpoint, a wake, and the manifest
// of every family and method — is the contract's (`engine-contracts`); this
// module composes it with the engine's own value types into `EngineHost`, and
// the compiler holds the two equal (`ManifestIsTheHost`).

import type { FileArtifactType, LanguageVersion } from 'movement-lang';
import type {
  ActingPrincipal,
  AdapterCallError,
  AdapterMethod,
  AdapterResolution,
  AwaitWakeRequest,
  CostLine,
  ExternalRecordRef,
  FileRef,
  HostClock,
  HostFamilyMethodPath,
  HostIds,
  HostLocks,
  Priced,
  PricedAnswer,
  RecordBindings,
  Scoped,
  SegmentOpening,
  SegmentScoped,
  VOID_HOST_METHODS,
} from 'engine-contracts';
import type {
  Adapter,
  GetRelatedInput,
  RelatedPage,
  RuntimeCapabilities,
} from '../translation_graph/adapter';
import type { AwaitPoint, AwaitResolution } from '../translation_graph/awaitable';
import type { UniquenessConstraints } from '../translation_graph/uniqueness';
import type { SourcePosition } from '../translation_graph/types';
import type { TriggerEvent } from '../translation_graph/triggers/types';
import type { LlmCallInput, LlmCallResult } from '../translation_graph/engine/batched_extraction/llm_call';
import type { CallbackCall, CallbackParamSpec } from 'engine-contracts';
import type { MovementTraceEntry } from './expression';
import type { FileTextResolution, TransformInvocationResult, TransformInvokeInput } from './extraction';
import type { ExtractCallLlmInput, ExtractCallLlmResult } from './extraction_call';
import type { CancelGate, ParkSink } from './run';
import type { AnyParkedScopeState } from 'engine-contracts';

export {
  ADAPTER_METHODS,
  HOST_FAMILIES,
  VOID_HOST_METHODS,
  hostMethodPaths,
  missingHostMethods,
  requiredHostMethodPaths,
  servedHostMethods,
} from 'engine-contracts';
export type {
  AdapterCallError,
  AdapterMethod,
  AdapterResolution,
  AwaitWakeRequest,
  BindingEndpoint,
  BudgetRefusal,
  Costed,
  EncodedEndpoint,
  HostCallError,
  HostClock,
  HostErrorDetail,
  HostIds,
  HostLocks,
  InSegment,
  Priced,
  PricedAnswer,
  RecordBindings,
  Scoped,
  SegmentOpening,
  SegmentScoped,
} from 'engine-contracts';

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
 *  use: one instance per (adapterType, credential, construction args,
 *  rehearsal) within a segment, so resolving the same thing twice answers the
 *  same instance id. Every call names the segment it is made for: the
 *  instance answers inside that segment's host scope (what it already read,
 *  how many calls it made), for the segment's team. */
export interface HostAdapters {
  resolve(input: Scoped<AdapterResolution>): Promise<ResolvedAdapter>;
  call<M extends AdapterMethod>(input: AdapterCall<M>): Promise<AdapterCallAnswer<M>>;
}

/** The extraction keyword's and `AI()`'s model call. */
export interface HostLlmClient {
  call(input: Priced<Scoped<LlmCallInput>>): Promise<PricedAnswer<LlmCallResult>>;
}

/** The extraction CALL's model call (`extract(content, Shape)`). */
export interface HostExtractCallClient {
  call(input: Priced<Scoped<ExtractCallLlmInput>>): Promise<PricedAnswer<ExtractCallLlmResult>>;
}

/** `through` stages and plugin calls. What the engine knows of a plugin —
 *  its arguments, its declared output, whether it is priced — is the run's
 *  catalog snapshot's (`plugins`); invoking it is the host's. */
export interface HostTransformInvoker {
  invoke(input: Priced<Scoped<TransformInvokeInput>>): Promise<PricedAnswer<TransformInvocationResult>>;
}

/** One write's identity question: which of its search's candidates the
 *  asserted record IS. */
export interface EntityArbitration {
  asserted: Record<string, unknown>;
  candidates: ExternalRecordRef[];
  recordType: string;
  constraints: UniquenessConstraints;
  /** The pin of the run asking: whether a blank key is a key. */
  languageVersion: LanguageVersion;
}

/** The judge's answer: the candidate the write IS, or null to create — and,
 *  when the judge could not be asked at all (its call failed), why, so the
 *  write can say so instead of reading as a considered decline. */
export interface ArbitrationAnswer {
  index: number | null;
  /** The judge's failure, in its own words. */
  judgeUnavailable?: string;
}

/** Which candidate an identity search's write IS: the index into
 *  `candidates`, or null to create, with the judge's failure when it could
 *  not be asked (`judgeUnavailable`, its message). Asked only when the rules
 *  alone cannot decide (`arbitrateWithoutJudge`), so it is the judge's model
 *  call. */
export type ArbitrateEntities = (input: Priced<Scoped<EntityArbitration>>) => Promise<PricedAnswer<ArbitrationAnswer>>;

/** A file's extracted TEXT (the knowledge-pipeline parity path). The host
 *  redeems the descriptor's bytes and runs the extractor (transcription and
 *  OCR are priced); only text, or the reason there is none, comes back. */
export type ResolveFileText = (input: Priced<Scoped<{ file: FileRef }>>) => Promise<PricedAnswer<FileTextResolution>>;


/** `FILE(content, type)`: the host renders the composed string, stores the
 *  artifact, and answers the stored file's descriptor. */
export type RenderFile = (input: Scoped<{ content: string; type: FileArtifactType }>) => Promise<FileRef>;


export interface ResolveActingUserInput {
  /** The trigger the event dispatched through; absent when the event predates
   *  trigger-aware dispatch. */
  triggerId?: string;
  /** The source instance (as `adapters.resolve` answered it) whose parse of
   *  the event's actors the host asks for — only when the trigger does not
   *  already decide the user. */
  instance: string;
  event: TriggerEvent;
}

/** The library texts a park pins (park state version 2's `libraries`), kept
 *  once by their content: a park names a text by the hash `save` answers, and
 *  a resume reads it back with `load` (null: the store holds no such text). */
export interface ParkSources {
  save(input: { source: string }): Promise<{ hash: string }>;
  load(input: { hash: string }): Promise<{ source: string } | null>;
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
    state: AnyParkedScopeState;
    singleUse: boolean;
    /** When it stops answering, as an ISO 8601 instant. Absent ⇒ never. */
    expiresAt?: string;
  }): Promise<{ id: string; url: string }>;
  /** The LIVE call ledger — what `cb-[:Called]->` reads and what a re-entered
   *  `await cb-[:Called]->` re-checks. */
  calls(input: { callbackId: string }): Promise<CallbackCall[]>;
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
    sink?: SegmentScoped<ParkSink>;
    /**
     * Queue the wake for one correlation key: "resume whatever is parked on
     * it". The engine calls it after an await park is durable, when its own
     * re-check finds the await resolved (or cannot tell): a landing that
     * arrived between the first check and the park woke nothing, because a
     * wake for a key with no parked run is a no-op. Plain data in, nothing out.
     */
    wake(request: Scoped<AwaitWakeRequest>): Promise<void>;
    /** Minting `callback(…)`, reading its call ledger, correlating an
     *  `await cb-[:Called]->`. Absent ⇒ a callback raises MOVENG_UNSUPPORTED. */
    callbacks?: SegmentScoped<CallbackSink>;
    bindings: SegmentScoped<RecordBindings>;
    /** Where the library texts a park pins are kept, once each, by their
     *  hash. Absent ⇒ a park carries each text itself. */
    sources?: SegmentScoped<ParkSources>;
  };
  control: {
    /** Consulted at each statement and LLM-call boundary; a cancel stops the
     *  run there, never mid-write. */
    cancel: SegmentScoped<CancelGate>;
  };
  files: {
    resolveFileText: ResolveFileText;
    render: RenderFile;
  };
  lookup: {
    /**
     * The principal an event acts as (`@user_*`): the source adapter parses
     * the event's actor candidates, the host maps them to one of its
     * principals through the trigger the event dispatched through (its
     * creator override and creator fallback). Null when none matches. The
     * engine sees only the reference, and an email when the host has one.
     */
    resolveActingUser(input: Scoped<ResolveActingUserInput>): Promise<ActingPrincipal | null>;
  };
  /** The cross-run write locks each segment's effects take beneath their
   *  own: `acquire({ segmentId, names })` answers a token, `release({ segmentId, token })`
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
    append(input: Scoped<{ entries: MovementTraceEntry[] }>): Promise<void>;
  };
  /** The instant now. Every time the engine needs that is not the run's
   *  firing instant — a sleep's wake, a callback's expiry, a measured
   *  duration, the pin of a segment handed no `firedAt` — it asks here, so a
   *  recorded run replays to the same instants. */
  clock: HostClock;
  /** Fresh ids (an extraction's resource ids), minted by the host so a
   *  recorded run replays to the same ids. */
  ids: HostIds;
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

// The manifest names exactly the methods `EngineHost` declares: a method added
// to a family and left out here, or listed here and not on the host, fails to
// compile.
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;
export type ManifestIsTheHost = Holds<Exactly<HostFamilyMethodPath, HostMethodPath>>;

type VoidMethodPaths<T, Prefix extends string> = {
  [K in keyof T & string]-?: NonNullable<T[K]> extends (...args: never[]) => infer R
    ? [Awaited<R>] extends [void]
      ? `${Prefix}${K}`
      : never
    : VoidMethodPaths<NonNullable<T[K]>, `${Prefix}${K}.`>;
}[keyof T & string];

// The void list names exactly the methods `EngineHost` declares as answering
// nothing.
export type VoidListIsTheHost = Holds<
  Exactly<(typeof VOID_HOST_METHODS)[number], VoidMethodPaths<EngineHost, ''>>
>;

