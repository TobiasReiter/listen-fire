// A host in the embedder's own process: the shape every in-process shell
// builds (an embedding product, the test host). The adapter instances sit in
// the same in-process table the production host keeps, so the engine reaches
// them through `adapters.call` as it reaches any. Whatever the shell does not
// supply is refused by name when a run reaches it, never answered with a
// silent default: a movement that calls a model on a host with no models fails
// saying `EngineHost.llm.client not provided`.

import type { EngineHost, RenderFile } from '../movement_engine/host';
import type { ActingUser } from '../translation_graph/adapter';
import type { DryRunWriteSink } from '../translation_graph/engine/dry_run_adapter';

import { adapterTable, type LiveAdapterResolver } from '../translation_graph/engine/adapter_table';
import { withFileOwners } from '../translation_graph/engine/files/file_owners';
import { InMemoryWriteLocks, segmentWriteLocks, type WriteLocks } from '../write_locks/write_locks';
import {
  actingPrincipalOf,
  closeSegmentWith,
  NEVER_CANCELLED,
  openSegmentWith,
  RANDOM_IDS,
  SegmentDirectory,
  WALL_CLOCK,
  type ActingUserLookup,
} from '../movement_engine/host_kit';

/** What an in-process shell supplies: any piece of any group. */
export interface InProcessHostOptions {
  segment?: Partial<EngineHost['segment']>;
  /** The live adapter for each instance a run resolves, and optionally the
   *  scope each call runs in (`around`) and how a failure reads (`classify`). */
  adapters?: Partial<Pick<Parameters<typeof adapterTable>[0], 'around' | 'classify'>> & {
    resolve?: LiveAdapterResolver;
  };
  /** The models slot: the model calls a run makes. Absent ⇒ refused by name. */
  llm?: Partial<EngineHost['llm']>;
  /** The store slot's run half: where parks, callbacks and pinned texts go.
   *  Absent ⇒ a run that parks fails (it has no durable substrate). */
  park?: Partial<EngineHost['park']>;
  control?: Partial<EngineHost['control']>;
  /** The files slot: reading a file's text, rendering `FILE(…)`. */
  files?: Partial<EngineHost['files']>;
  /** The acting-user lookup, handed the source instance's candidates as a call
   *  into its live adapter. Absent ⇒ no event acts as anyone. */
  lookup?: { resolveActingUser?: (input: ActingUserLookup) => Promise<ActingUser | null> };
  /** Cross-run write locks. Absent ⇒ in memory, which holds for one process. */
  locks?: WriteLocks;
  trace?: EngineHost['trace'];
  /** Receives each write a rehearsed (`dryRun`) instance captured. */
  writeSink?: DryRunWriteSink;
  /** Absent ⇒ the wall clock. */
  clock?: EngineHost['clock'];
  /** Absent ⇒ random UUIDs. */
  ids?: EngineHost['ids'];
  /** Mints the ids a rehearsal invents; absent, random UUIDs. */
  rehearsalIds?: () => string;
}

function notProvided(piece: string): Error {
  return new Error(`EngineHost.${piece} not provided`);
}

/** An `EngineHost` over in-process parts (see the file's head). */
export function inProcessHost(options: InProcessHostOptions = {}): EngineHost {
  const { segment = {}, adapters = {}, llm = {}, park = {}, control = {}, files = {}, lookup = {} } = options;
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
    ...(options.writeSink !== undefined ? { writeSink: options.writeSink } : {}),
    ...(options.rehearsalIds !== undefined ? { rehearsalIds: options.rehearsalIds } : {}),
  });
  const locks = segmentWriteLocks(options.locks ?? new InMemoryWriteLocks());
  const open = segment.open ?? (async () => ({ segmentId: `segment-${++opened}` }));
  const close = segment.close ?? (async () => ({}));
  const refused = (piece: string) => async (): Promise<never> => {
    throw notProvided(piece);
  };
  return {
    segment: {
      open: (input) => openSegmentWith(input, { segments, locks, open }),
      close: async (input) => closeSegmentWith(input, { segments, table, locks, close }),
    },
    clock: options.clock ?? WALL_CLOCK,
    ids: options.ids ?? RANDOM_IDS,
    adapters: { resolve: (input) => table.resolve(input), call: (input) => table.call(input) },
    llm: {
      client: llm.client ?? { call: refused('llm.client') },
      extractCall: llm.extractCall ?? { call: refused('llm.extractCall') },
      transforms: llm.transforms ?? { invoke: refused('llm.transforms') },
      arbitrateEntities: llm.arbitrateEntities ?? refused('llm.arbitrateEntities'),
    },
    park: {
      ...(park.sink !== undefined ? { sink: park.sink } : {}),
      ...(park.callbacks !== undefined ? { callbacks: park.callbacks } : {}),
      ...(park.sources !== undefined ? { sources: park.sources } : {}),
      wake: park.wake ?? refused('park.wake'),
      bindings: park.bindings ?? {
        record: refused('park.bindings'),
        findBoundCounterpart: refused('park.bindings'),
        delete: refused('park.bindings'),
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
      render: files.render ?? (refused('files.render') satisfies RenderFile),
    },
    lookup: {
      resolveActingUser: async ({ triggerId, segmentId, instance, event }) => {
        const resolve = lookup.resolveActingUser;
        if (resolve === undefined) return null;
        return actingPrincipalOf(await resolve({
          teamId: segments.facts(segmentId).teamId,
          ...(triggerId !== undefined ? { triggerId } : {}),
          getCandidates: () =>
            table.answer({ segmentId, instance, method: 'getActorCandidates', args: { event } }),
        }));
      },
    },
    locks: { acquire: (input) => locks.acquire(input), release: (input) => locks.release(input) },
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
  };
}
