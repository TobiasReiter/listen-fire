// The engine's one boundary with the world (cloud-native DESIGN §6). Everything
// a run reaches outside its own program — adapters, models, durable parks,
// files, the database, cross-run locks — comes through the `EngineHost` its
// caller hands it; the rest of `RunMovementInput` is data. A host decides what
// the world is: the production host wires Postgres, Anthropic and the adapter
// registry (`translation_graph/movement/engine_host.ts`); a test host wires
// fakes, and a piece a test did not provide fails loudly when the run reaches
// it, never by quietly reaching a real system.

import type { ResolveFile } from 'movement-lang';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { Adapter, FileRef } from '../translation_graph/adapter';
import type { LlmClient } from '../translation_graph/engine/batched_extraction';
import { InMemoryWriteLocks, type WriteLocks } from '../write_locks/write_locks';
import type { CallbackSink } from './callback_sink';
import type { ActingUserTriggerRow, MovementTraceEntry } from './expression';
import type { FileTextResolution, MovementTransformInvoker } from './extraction';
import type { ExtractCallLlmClient } from './extraction_call';
import type { BindingEndpoint, EncodedEndpoint } from './record_binding';
import type { CancelGate, ParkSink, SuspensionPoint } from './run';

/** Adapter resolution — the SAME seam `evaluateTranslationGraph` and provision
 *  use: one adapter per (adapterType, credential, construction args, role). */
export type ResolveAdapter = (input: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
  /** Non-credential construction args (unquoted) — the instance's entry
   *  position (Sheets' `spreadsheet:`). Position-free adapters ignore it. */
  constructionArgs?: Record<string, string>;
  role: 'source' | 'target';
}) => Adapter | Promise<Adapter>;

/** Source `FileRef` → extracted TEXT (the knowledge-pipeline parity path). */
export type ResolveFileText = (ref: FileRef) => Promise<FileTextResolution>;

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

/** Extracted text, stored once per distinct content: the stable id a file's
 *  text is cited by. Undefined when there is nowhere to store it. */
export interface RawTextStore {
  getOrCreateId(content: string): Promise<string | undefined>;
}

/** A stored document, as much of it as a file value needs. */
export interface StoredDocument {
  objectUri: string;
  description: string;
}

export interface EngineHost {
  adapters: {
    resolve: ResolveAdapter;
    /** Imported credential name → `external_service_credentials.id`.
     *  Undefined → the instance is constructed with no credential. */
    credentialId: (credentialName: string) => string | undefined;
  };
  llm: {
    /** The extraction keyword's and `AI()`'s model client. */
    client: LlmClient;
    /** The extraction CALL's client (`extract(content, Shape)`), which sends
     *  its prompt as blocks with cache breakpoints. */
    extractCall: ExtractCallLlmClient;
    /** `through` stages and plugin calls. */
    transforms: MovementTransformInvoker;
  };
  park: {
    /**
     * Where a park's details go — the lexical address and serialized scope of
     * a timer / await / suspension — to be persisted and woken later. Absent ⇒
     * the run has no durable substrate (a dry run): a run that reaches a park
     * raises, and a resumed join closes only its own leaf.
     */
    sink?: ParkSink;
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
     *  through it and the engine runs the linked result. Absent ⇒ a file
     *  import raises MOVENG_UNSUPPORTED. */
    resolveFile?: ResolveFile;
    resolveFileText: ResolveFileText;
    rawText: RawTextStore;
    documents: { getById(id: string): Promise<StoredDocument | null> };
  };
  lookup: {
    /** The trigger row an event dispatched through, for acting-user
     *  resolution. Null when there is no such trigger. */
    triggerForActingUser(triggerId: string): Promise<ActingUserTriggerRow | null>;
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
  adapters?: Partial<EngineHost['adapters']>;
  llm?: Partial<EngineHost['llm']>;
  park?: Partial<EngineHost['park']>;
  control?: Partial<EngineHost['control']>;
  files?: Partial<EngineHost['files']>;
  lookup?: Partial<EngineHost['lookup']>;
  locks?: WriteLocks;
  trace?: MovementTraceEntry[];
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
 * A host for tests: every piece the test does not supply is in memory or
 * throws naming itself when the run reaches it. No default reaches a network
 * or a database. Parks, callbacks and file imports stay absent unless
 * supplied, which the engine refuses loudly as it does for any host without
 * them (`makeFakeParkSink` is an in-memory park sink).
 */
export function makeTestHost(overrides: TestHostOverrides = {}): EngineHost {
  const { adapters = {}, llm = {}, park = {}, control = {}, files = {}, lookup = {} } = overrides;
  return {
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
    },
    park: {
      ...(park.sink !== undefined ? { sink: park.sink } : {}),
      ...(park.callbacks !== undefined ? { callbacks: park.callbacks } : {}),
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
      rawText: files.rawText ?? inMemoryRawTextStore(),
      documents: files.documents ?? {
        getById: async () => {
          throw notProvided('files.documents');
        },
      },
    },
    lookup: {
      triggerForActingUser: lookup.triggerForActingUser ?? (async () => null),
    },
    locks: overrides.locks ?? new InMemoryWriteLocks(),
    trace: overrides.trace ?? [],
  };
}

function inMemoryRawTextStore(): RawTextStore {
  const ids = new Map<string, string>();
  return {
    async getOrCreateId(content) {
      const trimmed = content.trim();
      let id = ids.get(trimmed);
      if (id === undefined) {
        id = `raw-text-${ids.size + 1}`;
        ids.set(trimmed, id);
      }
      return id;
    },
  };
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
