// The host's table of live adapter instances, per segment: what `adapters.resolve`
// hands the engine an opaque id for, and what `adapters.call` dispatches into.
// The engine never holds a live adapter; it names an instance and a method,
// and gets a result or a typed error back as data.
//
// The production host (`translation_graph/movement/engine_host.ts`) and the
// test host (`movement_engine/test_host.ts`) share it: they differ only in where the live
// adapters come from and in the scope each call runs inside (the production
// host enters the segment's read memo and call ceiling).
//
// A rehearsed instance (`dryRun`) is the live one wrapped so its writes are
// captured, never made. The rehearsal — the write sink, and the ids it has
// invented — belongs to the segment: a write chained off a rehearsed parent
// routinely crosses systems, so the memory of what is real cannot be one
// adapter's.

import type { TenantId } from 'engine-contracts';
import type { Adapter } from '../adapter';
import type { SegmentFacts } from '../../movement_engine/host_kit';

import {
  ADAPTER_METHODS,
  type AdapterCallError,
  type AdapterCall,
  type AdapterCallAnswer,
  type AdapterCallMap,
  type AdapterMethod,
  type AdapterResolution,
  type HostAdapters,
  type HostErrorDetail,
  type ResolvedAdapter,
} from '../../movement_engine/host';
import { newDryRunRehearsal, wrapAdapterForDryRun, type DryRunRehearsal, type DryRunWriteSink } from './dry_run_adapter';

/** Where a table's live instances come from: the resolution, for the
 *  segment's team. */
export type LiveAdapterResolver = (
  input: AdapterResolution & { segmentId: string; teamId: TenantId },
) => Adapter | Promise<Adapter>;

/** Each method, as a call into a live instance. A method the instance lacks
 *  is refused by name. */
const DISPATCH: { [M in AdapterMethod]: (adapter: Adapter, args: AdapterCallMap[M]['args']) => Promise<AdapterCallMap[M]['result']> } = {
  listEntryPoints: (adapter) => adapter.listEntryPoints(),
  describe: (adapter, { typeId }) => adapter.describe(typeId),
  edgesFrom: (adapter, { position, cursor }) => implemented(adapter, 'edgesFrom', adapter.edgesFrom)(position, cursor),
  resolveEntity: (adapter, args) => adapter.resolveEntity(args),
  getFieldValue: (adapter, args) => adapter.getFieldValue(args),
  getRelated: (adapter, args) => adapter.getRelated(args),
  iterateRelatedPage: (adapter, { cursor, ...input }) => relatedPage(adapter, input, cursor),
  preprocessInbound: (adapter, args) => implemented(adapter, 'preprocessInbound', adapter.preprocessInbound)(args),
  listEventTypes: (adapter) => implemented(adapter, 'listEventTypes', adapter.listEventTypes)(),
  createRecord: (adapter, args) => adapter.createRecord(args),
  updateRecord: (adapter, args) => adapter.updateRecord(args),
  deleteRecord: (adapter, args) => implemented(adapter, 'deleteRecord', adapter.deleteRecord)(args),
  linkRecords: (adapter, args) => implemented(adapter, 'linkRecords', adapter.linkRecords)(args),
  unlinkRecords: (adapter, args) => implemented(adapter, 'unlinkRecords', adapter.unlinkRecords)(args),
  ensureEventSubscription: (adapter, args) =>
    implemented(adapter, 'ensureEventSubscription', adapter.ensureEventSubscription)(args),
  removeEventSubscription: async (adapter, args) => {
    await implemented(adapter, 'removeEventSubscription', adapter.removeEventSubscription)(args);
    return null;
  },
  resolveAwait: (adapter, point) => {
    const awaitable = adapter.awaitable;
    if (awaitable === undefined) throw notImplemented(adapter, 'resolveAwait');
    return awaitable.resolveAwait(point);
  },
  wakeKeys: (adapter, args) => implemented(adapter, 'wakeKeys', adapter.wakeKeys)(args),
  readRecord: (adapter, args) => implemented(adapter, 'readRecord', adapter.readRecord)(args),
  translateFilter: (adapter, args) => implemented(adapter, 'translateFilter', adapter.translateFilter)(args),
  getDedupRules: (adapter, args) => implemented(adapter, 'getDedupRules', adapter.getDedupRules)(args),
  getActorCandidates: (adapter, args) => implemented(adapter, 'getActorCandidates', adapter.getActorCandidates)(args),
  extractActor: (adapter, args) => implemented(adapter, 'extractActor', adapter.extractActor)(args),
  describeOpaqueId: (adapter, args) => implemented(adapter, 'describeOpaqueId', adapter.describeOpaqueId)(args),
  invokeFieldFunction: (adapter, args) =>
    implemented(adapter, 'invokeFieldFunction', adapter.invokeFieldFunction)(args),
};

/** The method, bound to its instance — or a refusal naming it. */
function implemented<Args extends unknown[], Result>(
  adapter: Adapter,
  method: AdapterMethod,
  fn: ((...args: Args) => Promise<Result>) | undefined,
): (...args: Args) => Promise<Result> {
  if (typeof fn !== 'function') throw notImplemented(adapter, method);
  return (...args) => fn.apply(adapter, args);
}

function notImplemented(adapter: Adapter, method: AdapterMethod): Error {
  return new Error(`the '${adapter.adapterType}' adapter does not implement ${method}`);
}

/** One page of a traversal. An instance that pages natively answers its own
 *  page; one that only streams is drained into a single page, as the protocol
 *  server serves it — so no iteration is held open between calls. */
async function relatedPage(
  adapter: Adapter,
  input: AdapterCallMap['getRelated']['args'],
  cursor: unknown,
): Promise<AdapterCallMap['iterateRelatedPage']['result']> {
  if (typeof adapter.iterateRelatedPage === 'function') return adapter.iterateRelatedPage(input, cursor);
  if (typeof adapter.iterateRelated === 'function') {
    const items: AdapterCallMap['getRelated']['result'] = [];
    for await (const item of adapter.iterateRelated(input)) items.push(item);
    return { items };
  }
  return { items: await adapter.getRelated(input) };
}

/** What an instance is, as data. */
function describeInstance(instance: string, adapter: Adapter): ResolvedAdapter {
  const methods: ResolvedAdapter['methods'] = ADAPTER_METHODS.filter((method) =>
    method === 'resolveAwait' ? adapter.awaitable !== undefined : typeof adapter[method] === 'function',
  );
  if (typeof adapter.iterateRelated === 'function') methods.push('iterateRelated');
  return {
    instance,
    adapterType: adapter.adapterType,
    supportedTriggers: adapter.supportedTriggers,
    capabilities: adapter.runtimeCapabilities(),
    methods,
    ...(adapter.walksContainers !== undefined ? { walksContainers: adapter.walksContainers } : {}),
    ...(adapter.webhookEventTypeId !== undefined ? { webhookEventTypeId: adapter.webhookEventTypeId } : {}),
    ...(adapter.metaRecordType !== undefined ? { metaRecordType: adapter.metaRecordType } : {}),
  };
}

/** What makes two resolutions the same instance: the system, the credential,
 *  the construction args (in any order) and whether it is rehearsed. The role
 *  is not part of it: a source and a target of the same instance are one
 *  instance. */
function resolutionKey(resolution: AdapterResolution, dryRun: boolean): string {
  const args = Object.entries(resolution.constructionArgs ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([resolution.adapterType, resolution.credentialsId ?? null, args, dryRun]);
}

class SegmentInstances {
  private readonly byId = new Map<string, Adapter>();
  /** One id per resolution: the engine compares what it resolved, so
   *  resolving the same thing twice must answer the same id. The promise is
   *  kept, so two resolutions at once construct one instance. */
  private readonly ids = new Map<string, Promise<string>>();
  private next = 0;
  private rehearsalState?: DryRunRehearsal;

  constructor(
    private readonly segmentId: string,
    private readonly writeSink: DryRunWriteSink | undefined,
    private readonly rehearsalIds: (() => string) | undefined,
  ) {}

  private get rehearsal(): DryRunRehearsal {
    return (this.rehearsalState ??= newDryRunRehearsal(this.writeSink, this.rehearsalIds));
  }

  async resolve(
    input: { resolution: AdapterResolution; dryRun: boolean },
    live: () => Adapter | Promise<Adapter>,
  ): Promise<ResolvedAdapter> {
    const key = resolutionKey(input.resolution, input.dryRun);
    let pending = this.ids.get(key);
    if (pending === undefined) {
      pending = this.register(input.dryRun, live);
      this.ids.set(key, pending);
      // A failed resolution is not an instance: the next one tries again.
      pending.catch(() => {
        if (this.ids.get(key) === pending) this.ids.delete(key);
      });
    }
    const id = await pending;
    return describeInstance(id, this.instance(id));
  }

  private async register(dryRun: boolean, live: () => Adapter | Promise<Adapter>): Promise<string> {
    const adapter = await live();
    const id = `${this.segmentId}:${++this.next}`;
    this.byId.set(id, dryRun ? wrapAdapterForDryRun(adapter, this.rehearsal) : adapter);
    return id;
  }

  instance(id: string): Adapter {
    const adapter = this.byId.get(id);
    if (adapter === undefined) {
      throw new Error(`no adapter instance '${id}' in segment '${this.segmentId}': it was never resolved there`);
    }
    return adapter;
  }
}

/** The answer a host call gives instead of throwing, for the call that threw. */
export type ClassifyHostError = (error: unknown, call: { segmentId: string }) => AdapterCallError;

/** What an adapter threw, as an `adapter_error`: its message, its own name,
 *  and the HTTP status and error code it carries, so a remote failure's
 *  particulars survive the boundary. */
export function adapterErrorOf(error: unknown): AdapterCallError {
  if (!(error instanceof Error)) return { kind: 'adapter_error', message: String(error) };
  const detail = errorDetail(error);
  return {
    kind: 'adapter_error',
    message: error.message,
    ...(error.name !== 'Error' ? { name: error.name } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

function errorDetail(error: Error): HostErrorDetail | undefined {
  const status = numberField(error, 'status') ?? numberField(error, 'statusCode') ?? responseStatus(error);
  const code: unknown = Reflect.get(error, 'code');
  const detail: HostErrorDetail = {
    ...(status !== undefined ? { status } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  };
  return Object.keys(detail).length > 0 ? detail : undefined;
}

function numberField(value: object, field: string): number | undefined {
  const found: unknown = Reflect.get(value, field);
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
}

function responseStatus(error: Error): number | undefined {
  const response: unknown = Reflect.get(error, 'response');
  return typeof response === 'object' && response !== null ? numberField(response, 'status') : undefined;
}

export interface AdapterTable extends HostAdapters {
  /** A call the host makes itself (the acting-user lookup asks the source
   *  instance for the event's actors): its result, or its failure thrown. */
  answer<M extends AdapterMethod>(input: AdapterCall<M>): Promise<AdapterCallMap[M]['result']>;
  /** Forget a segment's instances once the segment has closed. */
  closeSegment(segmentId: string): void;
}

export function adapterTable(options: {
  resolveLive: LiveAdapterResolver;
  /** The host's open segments: what each is for, and a refusal for one that
   *  is not open. */
  segments: { facts(segmentId: string): SegmentFacts };
  /** Run one call into an instance inside its segment's host scope. Absent ⇒
   *  the call runs as it is. */
  around?: <T>(segmentId: string, call: () => Promise<T>) => Promise<T>;
  /** Turn what a call threw into the error the engine is answered with.
   *  Absent ⇒ every failure is an `adapter_error`. */
  classify?: ClassifyHostError;
  /** Receives each write a rehearsed instance captured. */
  writeSink?: DryRunWriteSink;
  /** Mints the ids a rehearsal invents; absent, random UUIDs. */
  rehearsalIds?: () => string;
}): AdapterTable {
  const instances = new Map<string, SegmentInstances>();
  const around = options.around ?? (<T>(_segmentId: string, call: () => Promise<T>) => call());
  const classify = options.classify ?? adapterErrorOf;

  const segmentNamed = (segmentId: string): SegmentInstances => {
    let segment = instances.get(segmentId);
    if (segment === undefined) {
      segment = new SegmentInstances(segmentId, options.writeSink, options.rehearsalIds);
      instances.set(segmentId, segment);
    }
    return segment;
  };

  const call = async <M extends AdapterMethod>(input: AdapterCall<M>): Promise<AdapterCallAnswer<M>> => {
    try {
      const segment = instances.get(input.segmentId);
      if (segment === undefined) {
        throw new Error(`no open segment '${input.segmentId}': nothing was resolved for it, or it has closed`);
      }
      const adapter = segment.instance(input.instance);
      const dispatch = DISPATCH[input.method];
      const result = await around(input.segmentId, () => dispatch(adapter, input.args));
      return { result };
    } catch (error) {
      return { error: classify(error, { segmentId: input.segmentId }) };
    }
  };

  return {
    async resolve(input) {
      const { segmentId, dryRun, ...resolution } = input;
      // A segment that is not open resolves nothing: refused, naming it.
      const { teamId } = options.segments.facts(segmentId);
      return segmentNamed(segmentId).resolve({ resolution, dryRun: dryRun === true }, () =>
        options.resolveLive({ ...resolution, segmentId, teamId }),
      );
    },
    call,
    async answer(input) {
      const answered = await call(input);
      if ('error' in answered) throw new Error(answered.error.message);
      return answered.result;
    },
    closeSegment(segmentId) {
      instances.delete(segmentId);
    },
  };
}
