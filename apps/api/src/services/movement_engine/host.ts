// The engine's one boundary with the world (cloud-native DESIGN §6). Everything
// a run reaches outside its own program — adapters, models, durable parks,
// files, the database, cross-run locks — comes through the `EngineHost` its
// caller hands it; the rest of `RunMovementInput` is data. A host decides what
// the world is: the production host wires Postgres, Anthropic and the adapter
// registry (`translation_graph/movement/engine_host.ts`); a test host wires
// fakes, and a piece a test did not provide fails loudly when the run reaches
// it, never by quietly reaching a real system.

import type { FileArtifactType, LanguageVersion, ResolveFile } from 'movement-lang';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { Budget, CostLine } from '../../lib/run_cost';
import type { ActingUser, ActorCandidate, Adapter, FileRef } from '../translation_graph/adapter';
import type { LlmCallInput, LlmCallResult } from '../translation_graph/engine/batched_extraction';
import type { EntityArbitration } from '../translation_graph/engine/entity_match';
import { InMemoryWriteLocks, type WriteLocks } from '../write_locks/write_locks';
import type { CallbackCall, CallbackParamSpec } from './callback_types';
import type { MovementTraceEntry } from './expression';
import type { FileTextResolution, TransformInvocationResult, TransformInvokeInput } from './extraction';
import type { ExtractCallLlmInput, ExtractCallLlmResult } from './extraction_call';
import type { CancelGate, ParkSink, SuspensionPoint } from './run';
import type { ParkedScopeState } from './serialize';
import type { TransformOutputShape } from '../translation_graph/types';

// ── Priced calls ────────────────────────────────────────────────────────────
//
// Every host call that may cost money takes the run's remaining budget in and
// answers what it spent. The host refuses priced work past the budget (throwing
// `BudgetExhausted` with what it spent first); the engine keeps the run's
// account and raises the cap from it (movement_engine/run_context.ts).

/** A priced call's request: the engine's input and the run's remaining budget. */
export type Priced<Input> = Input & { budget: Budget };

/** A priced call's answer and what the call spent, by source. Absent ⇒ it
 *  spent nothing. */
export type Costed<Output> = Output & { cost?: CostLine[] };

/** What the engine asks of an adapter instance. */
export interface AdapterResolution {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
  /** Non-credential construction args (unquoted) — the instance's entry
   *  position (Sheets' `spreadsheet:`). Position-free adapters ignore it. */
  constructionArgs?: Record<string, string>;
  role: 'source' | 'target';
}

/** Adapter resolution — the SAME seam `evaluateTranslationGraph` and provision
 *  use: one adapter per (adapterType, credential, construction args, role).
 *  Every call names the segment it is made for: the instance answers inside
 *  that segment's host scope (what it already read, how many calls it made). */
export type ResolveAdapter = (input: AdapterResolution & { segmentId: string }) => Adapter | Promise<Adapter>;

/**
 * An adapter call refused because its segment made as many calls to a
 * third-party system as one segment may — the host's typed answer, raised by
 * the call that would have gone one over. Its message is the whole failure
 * surface an author sees (it lands verbatim in the run's failure reason): the
 * number, the knob, and why the run stopped. The engine fails the run with it,
 * and `onError` never forgives it.
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

/** The extraction keyword's and `AI()`'s model call. */
export interface HostLlmClient {
  call(input: Priced<LlmCallInput>): Promise<Costed<LlmCallResult>>;
}

/** The extraction CALL's model call (`extract(content, Shape)`). */
export interface HostExtractCallClient {
  call(input: Priced<ExtractCallLlmInput>): Promise<Costed<ExtractCallLlmResult>>;
}

/** `through` stages and plugin calls. */
export interface HostTransformInvoker {
  invoke(input: Priced<TransformInvokeInput>): Promise<Costed<TransformInvocationResult>>;
  /**
   * What a PLAIN call to this plugin hands back — the plugin's own declaration,
   * the same one the checker typed the call against. Absent (or undefined for
   * this plugin) ⇒ the plugin never declared one, and the engine refuses a
   * plain call rather than guessing. A `through [ … ]` stage never asks.
   */
  declaredOutput?(plugin: string): TransformOutputShape | undefined;
  /**
   * Whether invoking this plugin may cost money (a paid scrape, a paid search,
   * its own priced work). A priced plugin is not started once the run has
   * spent its cost cap. Absent ⇒ unpriced.
   */
  isPriced?(plugin: string): boolean;
}

/** Which candidate an identity search's write IS: the index into
 *  `candidates`, or null to create. Asked only when the rules alone cannot
 *  decide (`arbitrateWithoutJudge`), so it is the judge's model call. */
export type ArbitrateEntities = (input: Priced<EntityArbitration>) => Promise<Costed<{ index: number | null }>>;

/** A file's extracted TEXT (the knowledge-pipeline parity path). The host
 *  redeems the descriptor's bytes and runs the extractor (transcription and
 *  OCR are priced); only text, or the reason there is none, comes back. */
export type ResolveFileText = (input: Priced<{ file: FileRef }>) => Promise<Costed<FileTextResolution>>;

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
  /** The source adapter's parse of the event's actors — called only when the
   *  trigger does not already decide the user. */
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
    expiresAt?: Date;
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
  adapters: {
    resolve: ResolveAdapter;
    /** Imported credential name → `external_service_credentials.id`.
     *  Undefined → the instance is constructed with no credential. */
    credentialId: (credentialName: string) => string | undefined;
  };
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
    /**
     * Where the engine may suspend a flow of its own accord: asked before
     * every statement and before every call a statement makes; `true` parks
     * the flow just before the statement, to re-run it on resume. The cost
     * cap is the production caller. Absent ⇒ never.
     */
    suspendWhen?: (point: SuspensionPoint) => boolean;
  };
  files: {
    /** File-import resolution (movement libraries): the checker links imports
     *  through it and the engine runs the linked result. Consulted only when
     *  the run's catalog snapshot carries no `files` — the snapshot's files
     *  were captured with its schemas, so they win. Neither ⇒ a file import
     *  raises MOVENG_UNSUPPORTED. */
    resolveFile?: ResolveFile;
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
  /** The cross-run write locks each segment takes beneath its effect locks. */
  locks: WriteLocks;
  /**
   * The array the run appends its decision trace to, held by reference so a
   * caller can read it while the run is still going. Absent ⇒ the run keeps
   * its own, visible only on the result.
   */
  trace?: MovementTraceEntry[];
}

/** What a test supplies: any piece of any group, the rest defaulted. */
export interface TestHostOverrides {
  segment?: Partial<EngineHost['segment']>;
  adapters?: Partial<EngineHost['adapters']>;
  llm?: Partial<EngineHost['llm']>;
  park?: Partial<EngineHost['park']>;
  control?: Partial<EngineHost['control']>;
  files?: Partial<EngineHost['files']>;
  lookup?: Partial<EngineHost['lookup']>;
  locks?: WriteLocks;
  trace?: MovementTraceEntry[];
  /** Where the default `park.wake` records each wake the engine asks for. */
  wakes?: AwaitWakeRequest[];
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
  return {
    segment: {
      open: segment.open ?? (async () => ({ segmentId: `test-segment-${++segments}` })),
      close: segment.close ?? (async () => ({})),
    },
    adapters: {
      resolve:
        adapters.resolve ??
        (() => {
          throw notProvided('adapters.resolve');
        }),
      credentialId: adapters.credentialId ?? (() => undefined),
    },
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
      ...(control.suspendWhen !== undefined ? { suspendWhen: control.suspendWhen } : {}),
    },
    files: {
      ...(files.resolveFile !== undefined ? { resolveFile: files.resolveFile } : {}),
      resolveFileText:
        files.resolveFileText ??
        (async () => {
          throw notProvided('files.resolveFileText');
        }),
      render: files.render ?? renderIntoNowhere(),
    },
    lookup: {
      resolveActingUser: lookup.resolveActingUser ?? (async () => null),
    },
    locks: overrides.locks ?? new InMemoryWriteLocks(),
    trace: overrides.trace ?? [],
  };
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
  timerParks: Array<{ address: string; state: unknown; wakeAt: Date }>;
  awaitParks: Array<{ address: string; state: unknown }>;
  joins: Array<{ frameAddress: string; parkedChildren: number }>;
} {
  const timerParks: Array<{ address: string; state: unknown; wakeAt: Date }> = [];
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
