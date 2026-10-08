// A host for tests: the world as fakes. Host side — it serves the test's live
// adapters from the same in-process table the production host keeps, so the
// engine reaches them through `adapters.call` as it reaches any.

import type { CatalogSnapshot, FileArtifactType } from 'movement-lang';
import type { ActingUser } from '../translation_graph/adapter';
import type { DryRunWriteSink } from '../translation_graph/engine/dry_run_adapter';
import type { MovementTraceEntry } from './expression';
import type { EngineHost, RenderFile } from './host';
import type { ParkSink } from './run';

import { adapterTable, type LiveAdapterResolver } from '../translation_graph/engine/adapter_table';
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
  /** Where the default `park.wake` records each wake the engine asks for, as
   *  a host queues it (for the segment's team). */
  wakes?: QueuedWake[];
  /** Receives each write a rehearsed (`dryRun`) instance captured. */
  writeSink?: DryRunWriteSink;
  /** The clock; by default each segment reads the instant it opened at,
   *  throughout. */
  clock?: EngineHost['clock'];
  /** The id minting; by default `id-1`, `id-2`, … in the order asked. */
  ids?: EngineHost['ids'];
}

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
  });
  const locks = segmentWriteLocks(overrides.locks ?? new InMemoryWriteLocks());
  const open = segment.open ?? (async () => ({ segmentId: `test-segment-${++opened}` }));
  const close = segment.close ?? (async () => ({}));
  const teamOf = (segmentId: string) => segments.facts(segmentId).teamId;
  // Deterministic by default: one instant per segment (the moment it opened,
  // so a test's fake timers set it), and ids numbered in the order asked.
  const openedAt = new Map<string, string>();
  let minted = 0;
  return {
    segment: {
      open: async (input) => {
        const opening = await openSegmentWith(input, { segments, locks, open });
        openedAt.set(opening.segmentId, new Date().toISOString());
        return opening;
      },
      close: async (input) => closeSegmentWith(input, { segments, table, locks, close }),
    },
    clock: overrides.clock ?? {
      now: async ({ segmentId }) => {
        const nowIso = openedAt.get(segmentId);
        if (nowIso === undefined) throw new Error(`clock.now: segment ${segmentId} was never opened on this host`);
        return { nowIso };
      },
    },
    ids: overrides.ids ?? {
      mint: async ({ count }) => Array.from({ length: count }, () => `id-${++minted}`),
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
      resolveFileText:
        files.resolveFileText ??
        (async () => {
          throw notProvided('files.resolveFileText');
        }),
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
    ...(overrides.trace !== undefined ? { trace: appendingInto(overrides.trace) } : {}),
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
