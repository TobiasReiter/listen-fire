// A host for tests: the world as fakes. Host side — it serves the test's live
// adapters from the same in-process table the production host keeps, so the
// engine reaches them through `adapters.call` as it reaches any.

import type { CatalogSnapshot, FileArtifactType } from 'movement-lang';
import { guidSequence } from 'engine-contracts';
import type { ActingUser } from '../translation_graph/adapter';
import type { DryRunWriteSink } from '../translation_graph/engine/dry_run_adapter';
import type { MovementTraceEntry } from './expression';
import type { EngineHost, ParkSources, RenderFile } from './host';
import { parkSources } from '../run_host/rules';
import type { ParkSink } from './run';
import { isCheckFailure } from './errors';

import { adapterTable, type LiveAdapterResolver } from '../translation_graph/engine/adapter_table';
import { withFileOwners } from '../translation_graph/engine/files/file_owners';
import { InMemoryWriteLocks, segmentWriteLocks, type WriteLocks } from '../write_locks/write_locks';
import {
  actingPrincipalOf,
  appendingInto,
  closeSegmentWith,
  NEVER_CANCELLED,
  openSegmentWith,
  SegmentDirectory,
  type ActingUserLookup,
  type QueuedWake,
} from './host_kit';

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
  /** Each hand-over of the trace (one `trace.append`), its entries: when the
   *  host saw what. */
  traceAppends?: MovementTraceEntry[][];
  /** Where the default `park.wake` records each wake the engine asks for, as
   *  a host queues it (for the segment's team). */
  wakes?: QueuedWake[];
  /** Receives each write a rehearsed (`dryRun`) instance captured. */
  writeSink?: DryRunWriteSink;
  /** The one instant the default clock answers, throughout every entry
   *  (ISO 8601); absent, `TEST_HOST_NOW`. A test that reads the run's time
   *  sets it, and compares against it, never against the wall clock. */
  now?: string;
  /** The clock in full, in place of the fixed one. */
  clock?: EngineHost['clock'];
  /** The id minting; by default a fresh GUID sequence per host
   *  (`00000000-0000-4000-8000-000000000001`, …) in the order asked. */
  ids?: EngineHost['ids'];
}

/** The instant a test host's clock answers unless the test sets another. */
export const TEST_HOST_NOW = '2026-01-01T00:00:00.000Z';

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
  let opened = 0;
  const segments = new SegmentDirectory();
  const table = adapterTable({
    segments,
    resolveLive:
      adapters.resolve ??
      (() => {
        throw notProvided('adapters.resolve');
      }),
    ...(adapters.around !== undefined ? { around: adapters.around } : {}),
    ...(adapters.classify !== undefined ? { classify: adapters.classify } : {}),
    ...(overrides.writeSink !== undefined ? { writeSink: overrides.writeSink } : {}),
    // A rehearsal's invented ids, deterministic too: their own sequence, so
    // they never meet the ids `ids.mint` answers.
    rehearsalIds: guidSequence(1).next,
  });
  const locks = segmentWriteLocks(overrides.locks ?? new InMemoryWriteLocks());
  const open = segment.open ?? (async () => ({ segmentId: `test-segment-${++opened}` }));
  const close = segment.close ?? (async () => ({}));
  const teamOf = (segmentId: string) => segments.facts(segmentId).teamId;
  // Deterministic by default, so a recorded run is the same run every time:
  // one fixed instant, and ids from a GUID sequence in the order asked.
  const nowIso = overrides.now ?? TEST_HOST_NOW;
  const guids = guidSequence();
  return {
    segment: {
      open: (input) => openSegmentWith(input, { segments, locks, open }),
      close: async (input) => closeSegmentWith(input, { segments, table, locks, close }),
    },
    clock: overrides.clock ?? { now: async () => ({ nowIso }) },
    ids: overrides.ids ?? { mint: async ({ count }) => guids.take(count) },
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
      ...(park.sources !== undefined ? { sources: park.sources } : {}),
      wake:
        park.wake ??
        (async ({ segmentId, adapterType, correlationKey }) => {
          wakes.push({ adapterType, teamId: teamOf(segmentId), correlationKey });
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
      // As production reads a file: through an instance the segment holds.
      resolveFileText: async (input) => {
        const read = files.resolveFileText;
        if (read === undefined) throw notProvided('files.resolveFileText');
        return withFileOwners(table.fileOwners(input.segmentId), () => read(input));
      },
      render: files.render ?? renderIntoNowhere(),
    },
    lookup: {
      resolveActingUser: async ({ triggerId, segmentId, instance, event }) => {
        const resolve = lookup.resolveActingUser;
        if (resolve === undefined) return null;
        return actingPrincipalOf(await resolve({
          teamId: teamOf(segmentId),
          ...(triggerId !== undefined ? { triggerId } : {}),
          getCandidates: () =>
            table.answer({ segmentId, instance, method: 'getActorCandidates', args: { event } }),
        }));
      },
    },
    locks: { acquire: (input) => locks.acquire(input), release: (input) => locks.release(input) },
    ...(overrides.trace !== undefined || overrides.traceAppends !== undefined
      ? { trace: recordingTrace(overrides.trace, overrides.traceAppends) }
      : {}),
  };
}

function recordingTrace(
  trace: MovementTraceEntry[] | undefined,
  appends: MovementTraceEntry[][] | undefined,
): NonNullable<EngineHost['trace']> {
  const into = appendingInto(trace ?? []);
  return {
    append: async (input) => {
      appends?.push([...input.entries]);
      await into.append(input);
    },
  };
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

/** In-memory write locks that record the names of every acquire, in order:
 *  what a test compares between two runs of one program. */
export function recordingWriteLocks(acquired: string[][]): WriteLocks {
  const inner = new InMemoryWriteLocks();
  return {
    holder(scope) {
      const holder = inner.holder(scope);
      return {
        acquire: (names) => {
          acquired.push([...names]);
          return holder.acquire(names);
        },
        release: (names) => holder.release(names),
      };
    },
  };
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

/** An in-memory `park.sources`: the library texts parks pinned, by hash, for
 *  the test to read (`texts`). Over the core's own `parkSources`, so a hash
 *  here is the one a backend's store keys. */
export function makeMemoryParkSources(): { sources: ParkSources; texts: Map<string, string> } {
  const texts = new Map<string, string>();
  const sources = parkSources(
    {
      put: async ({ hash, source }) => {
        texts.set(hash, source);
      },
      get: async ({ hash }) => texts.get(hash) ?? null,
    },
    'test-team',
  );
  return { sources, texts };
}

// ── How a Rust run ended ──────────────────────────────────────────────────────

/**
 * What the Rust run's counts (`rustRunStats`) say of how one version-5 run
 * that threw `error` (none for a run that returned) ended: at its check
 * (`isCheckFailure`) with no segment opened; or in one segment, run to its
 * end (its own failure included), with no engine refusal and no shim fault.
 * A refusal (`MOVENG_UNSUPPORTED`) is never expected: a checked-clean program
 * that reaches one is a checker or engine bug.
 */
export function endedInRust(error: unknown): { segments: number; endedAtCheck: number; unsupported: Record<string, number>; shimFaults: 0 } {
  if (isCheckFailure(error)) return { segments: 0, endedAtCheck: 1, unsupported: {}, shimFaults: 0 };
  return { segments: 1, endedAtCheck: 0, unsupported: {}, shimFaults: 0 };
}
