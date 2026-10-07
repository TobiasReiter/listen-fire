// The engine's one boundary with the world (cloud-native DESIGN §6). Everything
// a run reaches outside its own program — adapters, models, durable parks,
// files, the database, cross-run locks — comes through the `EngineHost` its
// caller hands it; the rest of `RunMovementInput` is data. A host decides what
// the world is: the production host wires Postgres, Anthropic and the adapter
// registry (`translation_graph/movement/engine_host.ts`); a test host wires
// fakes, and a piece a test did not provide fails loudly when the run reaches
// it, never by quietly reaching a real system.

import type { CatalogSnapshot, FileArtifactType, LanguageVersion } from 'movement-lang';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { Budget, CostLine } from '../../lib/run_cost';
import type {
  ActingUser,
  ActorCandidate,
  Adapter,
  FileRef,
  GetRelatedInput,
  RelatedPage,
  RuntimeCapabilities,
} from '../translation_graph/adapter';
import type { AwaitPoint, AwaitResolution } from '../translation_graph/awaitable';
import type { DryRunWriteSink } from '../translation_graph/engine/dry_run_adapter';
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

import {
  InMemoryWriteLocks,
  segmentWriteLocks,
  type SegmentWriteLocks,
  type WriteLocks,
} from '../write_locks/write_locks';
import { adapterTable, type LiveAdapterResolver } from '../translation_graph/engine/adapter_table';

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
 *    engine charges what the call spent first and raises the run's cap.
 *  - `adapter_error`: the adapter failed; the engine fails the statement with
 *    the message, as it would any error.
 */
export interface HostCallError {
  kind: 'call_ceiling' | 'adapter_error' | 'budget';
  message: string;
}

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
 * (the protocol's own `METHODS`, translation_graph/protocol/schema.ts). Two
 * are not here: `manifest`, which `adapters.resolve` answers as data, and
 * `iterateRelated`, whose async iterable never crosses — the engine walks a
 * traversal page by page with `iterateRelatedPage`.
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
  'resolveFileRef',
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
  resolveFileRef: OneInput<'resolveFileRef'>;
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
  | { error: HostCallError };

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

/** An acting-user lookup with the source's candidates as a call: what the
 *  host's resolver works from, and what a test's lookup is handed. */
export interface ActingUserLookup {
  teamId: TeamId;
  triggerId?: string;
  getCandidates: () => Promise<ActorCandidate[]>;
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

/** What a test supplies: any piece of any group, the rest defaulted. */
export interface TestHostOverrides {
  segment?: Partial<EngineHost['segment']>;
  /** The live adapters the test serves. They sit in the same in-process table
   *  the production host keeps (`adapter_table.ts`), so the engine reaches
   *  them by `adapters.call` as it reaches any. `around` and `classify` are
   *  the table's: a test of the segment scope passes the production host's. */
  adapters?: Partial<Pick<Parameters<typeof adapterTable>[0], 'around' | 'classify'>> & {
    resolve?: LiveAdapterResolver;
  };
  llm?: Partial<EngineHost['llm']>;
  park?: Partial<EngineHost['park']>;
  control?: Partial<EngineHost['control']>;
  files?: Partial<EngineHost['files']>;
  /** The acting-user lookup, handed the source instance's candidates as a
   *  call into the test's live adapter. */
  lookup?: { resolveActingUser?: (input: ActingUserLookup) => Promise<ActingUser | null> };
  locks?: WriteLocks;
  /** Where the run's trace is appended as it goes. */
  trace?: MovementTraceEntry[];
  /** Where the default `park.wake` records each wake the engine asks for. */
  wakes?: AwaitWakeRequest[];
  /** Receives each write a rehearsed (`dryRun`) instance captured. */
  writeSink?: DryRunWriteSink;
}

/** The gate of a run nothing can cancel. */
export const NEVER_CANCELLED: CancelGate = {
  cancelled: async () => false,
  cancelledNow: async () => false,
  reason: () => null,
};

function notProvided(piece: string): Error {
  return new Error(`EngineHost.${piece} not provided`);
}

/**
 * A host for tests: every piece the test does not supply is in memory, finds
 * nothing, or throws naming itself when the run reaches it. A segment opens
 * and closes with nothing behind it (no read memo, no call ceiling, nothing
 * spent); a test of the host's segment scope supplies the real one. `park.wake`
 * records into `overrides.wakes` (a fresh array when absent). No default
 * reaches a network or a database. Parks, callbacks and file imports stay
 * absent unless supplied, which the engine refuses loudly as it does for any
 * host without them (`makeFakeParkSink` is an in-memory park sink).
 */
export function makeTestHost(overrides: TestHostOverrides = {}): EngineHost {
  const { segment = {}, adapters = {}, llm = {}, park = {}, control = {}, files = {}, lookup = {}, wakes = [] } =
    overrides;
  let segments = 0;
  const table = adapterTable({
    resolveLive:
      adapters.resolve ??
      (() => {
        throw notProvided('adapters.resolve');
      }),
    ...(adapters.around !== undefined ? { around: adapters.around } : {}),
    ...(adapters.classify !== undefined ? { classify: adapters.classify } : {}),
    ...(overrides.writeSink !== undefined ? { writeSink: overrides.writeSink } : {}),
  });
  const locks = segmentWriteLocks(overrides.locks ?? new InMemoryWriteLocks());
  const open = segment.open ?? (async () => ({ segmentId: `test-segment-${++segments}` }));
  const close = segment.close ?? (async () => ({}));
  return {
    segment: {
      open: async (input) => {
        const opened = await open(input);
        locks.opened(opened.segmentId, input.teamId);
        return opened;
      },
      close: async (input) => closeSegmentWith(input, { table, locks, close }),
    },
    adapters: { resolve: (input) => table.resolve(input), call: (input) => table.call(input) },
    llm: {
      client: llm.client ?? {
        call: async () => {
          throw notProvided('llm.client');
        },
      },
      extractCall: llm.extractCall ?? {
        call: async () => {
          throw notProvided('llm.extractCall');
        },
      },
      transforms: llm.transforms ?? {
        invoke: async () => {
          throw notProvided('llm.transforms');
        },
      },
      arbitrateEntities:
        llm.arbitrateEntities ??
        (async () => {
          throw notProvided('llm.arbitrateEntities');
        }),
    },
    park: {
      ...(park.sink !== undefined ? { sink: park.sink } : {}),
      ...(park.callbacks !== undefined ? { callbacks: park.callbacks } : {}),
      wake:
        park.wake ??
        (async (request) => {
          wakes.push(request);
        }),
      bindings: park.bindings ?? {
        record: async () => {
          throw notProvided('park.bindings');
        },
        findBoundCounterpart: async () => {
          throw notProvided('park.bindings');
        },
        delete: async () => {
          throw notProvided('park.bindings');
        },
      },
    },
    control: {
      cancel: control.cancel ?? NEVER_CANCELLED,
    },
    files: {
      resolveFileText:
        files.resolveFileText ??
        (async () => {
          throw notProvided('files.resolveFileText');
        }),
      render: files.render ?? renderIntoNowhere(),
    },
    lookup: {
      resolveActingUser: async ({ teamId, triggerId, segmentId, instance, event }) => {
        const resolve = lookup.resolveActingUser;
        if (resolve === undefined) return null;
        return resolve({
          teamId,
          ...(triggerId !== undefined ? { triggerId } : {}),
          getCandidates: () =>
            table.answer({ segmentId, instance, method: 'getActorCandidates', args: { event } }),
        });
      },
    },
    locks: { acquire: (input) => locks.acquire(input), release: (input) => locks.release(input) },
    ...(overrides.trace !== undefined ? { trace: appendingInto(overrides.trace) } : {}),
  };
}

/** A host's `trace` family over an array a caller reads as the run goes. */
export function appendingInto(trace: MovementTraceEntry[]): NonNullable<EngineHost['trace']> {
  return {
    append: async ({ entries }) => {
      trace.push(...entries);
    },
  };
}

/** Close a segment's host half: forget its adapter instances, close its lock
 *  session, then the segment itself. The segment closes even when its lock
 *  session would not; that failure is raised after. */
export async function closeSegmentWith(
  input: { segmentId: string },
  parts: {
    table: { closeSegment(segmentId: string): void };
    locks: SegmentWriteLocks;
    close: EngineHost['segment']['close'];
  },
): Promise<{ cost?: CostLine[] }> {
  parts.table.closeSegment(input.segmentId);
  let lockFailure: unknown;
  try {
    await parts.locks.closed(input.segmentId);
  } catch (error) {
    lockFailure = error;
  }
  const answer = await parts.close(input);
  if (lockFailure !== undefined) throw lockFailure;
  return answer;
}

/** A test's run input `credentialIds`: each credential the catalog imports,
 *  mapped through `idOf` (a name it answers nothing for has no id). */
export function credentialIdsFor(
  catalog: CatalogSnapshot,
  idOf: (credentialName: string) => string | undefined,
): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const name of Object.keys(catalog.credentials)) {
    const id = idOf(name);
    if (id !== undefined) ids[name] = id;
  }
  return ids;
}

const RENDERED: Record<FileArtifactType, { name: string; contentType: string }> = {
  pdf: { name: 'movement-artifact.pdf', contentType: 'application/pdf' },
  text: { name: 'movement-artifact.txt', contentType: 'text/plain' },
};

/** A test's default `FILE()`: the descriptor of a document-store file that
 *  holds nothing, so a run that renders can still be inspected. A test that
 *  reads the bytes supplies a render that stores them. */
function renderIntoNowhere(): RenderFile {
  let rendered = 0;
  return async ({ type }) => ({
    __brand: 'FileRef',
    ...RENDERED[type],
    source: { store: 'document', objectUri: `test-render://${++rendered}` },
  });
}

/** An in-memory park sink: timer and await parks and join counts are recorded
 *  for the test to read; nothing is woken. A park's `state` is what the engine
 *  serialized, a `ParkedScopeState`. */
export function makeFakeParkSink(): {
  sink: ParkSink;
  timerParks: Array<{ address: string; state: unknown; wakeAt: string }>;
  awaitParks: Array<{ address: string; state: unknown }>;
  joins: Array<{ frameAddress: string; parkedChildren: number }>;
} {
  const timerParks: Array<{ address: string; state: unknown; wakeAt: string }> = [];
  const awaitParks: Array<{ address: string; state: unknown }> = [];
  const joins: Array<{ frameAddress: string; parkedChildren: number }> = [];
  const sink: ParkSink = {
    async recordJoin(input) {
      joins.push({ frameAddress: input.frameAddress, parkedChildren: input.parkedChildren });
    },
    async commitTimerPark(input) {
      timerParks.push({ address: input.address, state: input.state, wakeAt: input.wakeAt });
    },
    async commitAwaitPark(input) {
      awaitParks.push({ address: input.address, state: input.state });
    },
    async decrementJoin() {
      return { closed: true };
    },
    async persistBranchExport() {},
    async collectBranchExports() {
      return [];
    },
    async cancelSubtrees() {},
  };
  return { sink, timerParks, awaitParks, joins };
}
