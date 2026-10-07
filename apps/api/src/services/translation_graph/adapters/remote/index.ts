// RemoteAdapter — implements the in-process `Adapter` interface by forwarding
// every call over the wire protocol (`protocol/schema.ts` + `protocol/client.ts`).
// A third-party (or out-of-process) adapter server speaks the same method
// registry; this class lets the TG engine drive it as if it were local.
//
// A pure forwarder: the wire speaks the same NATURAL names (type, field and
// edge display names) the in-process interface does, so nothing is translated
// here. The remote server resolves names to its own internal ids exactly as an
// in-process adapter does on the first line of each method. The only rewriting
// is transport: FileRefs written into the remote are exposed at a fetchable
// URL, and FileRefs read back get a `retrieve()` bound to `resolveFileRef`.
//
// Construction is synchronous: the manifest is fetched once at install time
// (`fetchRemoteManifest`) and passed IN, so the engine can read
// `adapterType` / `runtimeCapabilities` / `supportedTriggers` immediately. The factory
// (`createRemoteAdapter`) prunes optional methods the server didn't advertise so
// the engine's `if (adapter.method)` capability checks see `undefined`.
//
// Position-type resolution is no longer an adapter method: the former
// `getPositionTypeId` was pure config, now resolved generically by the engine
// (`engine/position_type.ts`) from the adapter's static `webhookEventTypeId`,
// which a remote adapter carries in its manifest. `narrowReferenceType` and
// `extractActor` are now async, so they round-trip cleanly over the protocol
// and are full forwarders here (advertised → forwarded; absent → pruned).

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import type {
  Adapter,
  RuntimeCapabilities,
  DeleteInput,
  DeleteResult,
  EdgesFromResult,
  FileRef,
  GetFieldValueInput,
  GetRelatedInput,
  InvokeFieldFunctionInput,
  DiscriminableEvent,
  EventType,
  RelatedResult,
  ResolveEntityInput,
  ResolveEntityResult,
  ResolveFileRefResult,
  Resource,
  ActorCandidate,
  ActorIdentity,
  DedupRules,
  FilterTranslationResult,
  ResourceFilter,
  ReadInput,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
  ExternalRecordRef,
  ParentAssociation,
  LinkRecordsInput,
  LinkRecordsResult,
  UnlinkRecordsInput,
  UnlinkRecordsResult,
  EnsureEventSubscriptionInput,
  EventSubscriptionRegistration,
  RemoveEventSubscriptionInput,
} from '../../adapter';
import type {
  AwaitableCapability,
  AwaitParkRef,
  AwaitPoint,
  AwaitResolution,
} from '../../awaitable';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from '../../types';
import { exposeFile } from '../../engine/files/expose';
import { streamFileRef, isFileRef, reviveFileRefs } from '../../engine/files/retrieve';
import type { TriggerEvent, TriggerType } from '../../triggers/types';
import type { Expression } from '#shared/expression/types';

import { authHeader, postRpc, parseWireResult } from '../../protocol/client';
import type { AuthStrategy } from '../../protocol/client';
import { METHODS, WireManifestProtocolVersion } from '../../protocol/schema';
import type { MethodName, WireAwaitResolutionShape } from '../../protocol/schema';
import { writeParentLinks, unsupportedAssociation } from '../../adapter';
import { dropAwaitCorrelation, registerAwaitCorrelation } from '../await_correlation';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';

export interface RemoteAdapterConfig {
  /** Slug the engine routes on. */
  adapterType: string;
  baseUrl: string;
  authStrategy: AuthStrategy;
  credentialsId: string;
}

export interface RemoteManifest {
  adapterType: string;
  supportedTriggers: readonly TriggerType[];
  runtimeCapabilities: RuntimeCapabilities;
  /** Protocol method names the server implements — drives optional-method
   *  pruning in `createRemoteAdapter`. */
  methods: readonly string[];
  /** Static webhook/synthetic event type, consumed by the engine's generic
   *  `resolvePositionTypeId`. Pure config — no RPC. */
  webhookEventTypeId?: string;
}

/**
 * Optional methods that round-trip cleanly over the protocol. The factory
 * deletes any of these the manifest didn't advertise so the engine's
 * `if (adapter.method)` capability gates see `undefined`. Two optional
 * surfaces are gated differently: `iterateRelated` stays while the server
 * advertises either paging method, and `awaitable` exists only when the
 * server advertises `resolveAwait`.
 */
export const OPTIONAL_REMOTE_METHODS = [
  'edgesFrom',
  'preprocessInbound',
  'listEventTypes',
  'readRecord',
  'describeOpaqueId',
  'translateFilter',
  'getDedupRules',
  'getActorCandidates',
  'extractActor',
  'resolveFileRef',
  'invokeFieldFunction',
  'linkRecords',
  'unlinkRecords',
  'ensureEventSubscription',
  'removeEventSubscription',
  'wakeKeys',
] as const satisfies readonly (keyof RemoteAdapter)[];

/**
 * Install-time manifest fetch. Calls the server's `manifest` method and
 * validates the result against the protocol schema, then re-enters the branded
 * domain at the single sanctioned boundary `as` (a validated wire value
 * crossing back into branded types).
 */
export async function fetchRemoteManifest(
  config: Pick<RemoteAdapterConfig, 'adapterType' | 'baseUrl' | 'authStrategy'>,
  secret: string,
): Promise<RemoteManifest> {
  const raw = await postRpc({
    baseUrl: config.baseUrl,
    auth: authHeader(config.authStrategy, secret),
    method: 'manifest',
    cacheScopeId: '<none>',
    params: {},
  });
  // Checked ahead of the full parse so an older server is refused for what it
  // is, not for whichever other field happens to have changed shape.
  const version = WireManifestProtocolVersion.safeParse(
    raw !== null && typeof raw === 'object' ? Reflect.get(raw, 'protocolVersion') : undefined,
  );
  if (!version.success) {
    throw new Error(
      `Remote adapter "${config.adapterType}" at ${config.baseUrl} refused: ${version.error.issues[0]?.message ?? 'protocolVersion is not 2'}`,
    );
  }
  const result = parseWireResult(METHODS.manifest.result, raw, {
    method: 'manifest',
    adapter: config.adapterType,
  });
  return {
    adapterType: result.adapterType,
    // Sole sanctioned boundary `as`: validated wire value → branded domain.
    supportedTriggers: result.supportedTriggers as readonly TriggerType[],
    // Validated structurally by the wire schema — no boundary `as` needed.
    runtimeCapabilities: result.runtimeCapabilities,
    methods: result.methods,
    webhookEventTypeId: result.webhookEventTypeId,
  };
}

export interface RemoteAdapterInput {
  config: RemoteAdapterConfig;
  secret: string;
  cacheScopeId: string;
  manifest: RemoteManifest;
}

export class RemoteAdapter implements Adapter {
  readonly adapterType: string;
  /**
   * A remote adapter's graph is whatever its author modelled, and nothing here
   * can see whether it has containers. Assume it does: refusing a full-surface
   * describe costs an extra hop, wrongly issuing one costs a call per entry
   * against somebody else's service.
   */
  readonly walksContainers = true;
  readonly supportedTriggers: readonly TriggerType[];
  private readonly _runtimeCapabilities: RuntimeCapabilities;
  readonly webhookEventTypeId?: string;

  readonly awaitable?: AwaitableCapability;

  private readonly config: RemoteAdapterConfig;
  private readonly secret: string;
  private readonly cacheScopeId: string;
  private readonly advertised: ReadonlySet<string>;

  constructor(input: RemoteAdapterInput) {
    this.config = input.config;
    this.secret = input.secret;
    this.cacheScopeId = input.cacheScopeId;
    this.adapterType = input.manifest.adapterType;
    this.supportedTriggers = input.manifest.supportedTriggers;
    this._runtimeCapabilities = input.manifest.runtimeCapabilities;
    this.webhookEventTypeId = input.manifest.webhookEventTypeId;
    this.advertised = new Set(input.manifest.methods);
    if (this.advertised.has('resolveAwait')) this.awaitable = this.remoteAwaitable();
  }

  runtimeCapabilities(): RuntimeCapabilities {
    return this._runtimeCapabilities;
  }

  private async call<M extends MethodName>(
    method: M,
    params: unknown,
  ): Promise<ReturnType<(typeof METHODS)[M]['result']['parse']>> {
    const result = await postRpc({
      baseUrl: this.config.baseUrl,
      auth: authHeader(this.config.authStrategy, this.secret),
      method,
      cacheScopeId: this.cacheScopeId,
      params,
    });
    return parseWireResult(METHODS[method].result, result, {
      method,
      adapter: this.config.adapterType,
    }) as ReturnType<(typeof METHODS)[M]['result']['parse']>;
  }

  // ── Required forwarders ────────────────────────────────────────────────

  listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return this.call('listEntryPoints', {}) as Promise<SchemaEntryPoint[]>;
  }

  describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    return this.call('describe', { typeId: typeRef }) as Promise<SchemaTypeDescriptor | null>;
  }

  /** Meta-graph walk. Pruned to `undefined` by `createRemoteAdapter` when the
   *  manifest doesn't advertise it. */
  async edgesFrom(position: SourcePosition, cursor?: unknown): Promise<EdgesFromResult | null> {
    return this.call('edgesFrom', {
      position,
      ...(cursor !== undefined ? { cursor } : {}),
    }) as Promise<EdgesFromResult | null>;
  }

  resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    return this.call('resolveEntity', input) as Promise<ResolveEntityResult>;
  }

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    return this.reviveFileRefs(await this.call('getFieldValue', input));
  }

  /**
   * Re-attach a `retrieve()` to FileRefs that crossed the wire. A wire FileRef
   * is plain JSON (`{ __brand, name, contentType, source }`) — closures don't
   * serialize — so a consumer's `streamFileRef` would have no byte channel.
   * Bind it back to the remote's own `resolveFileRef` (a wire call), so the
   * FileRef is self-contained again on this side. A parked run's state is the
   * same boundary and revives its files through the same walk.
   */
  private reviveFileRefs(value: unknown): unknown {
    return reviveFileRefs(value, (ref) => {
      const revived: FileRef = {
        ...ref,
        retrieve: () => {
          if (!this.resolveFileRef) {
            throw new Error(
              `RemoteAdapter(${this.adapterType}): emitted a FileRef but does not ` +
                'advertise resolveFileRef, so its bytes cannot be retrieved.',
            );
          }
          return this.resolveFileRef({ ref: revived });
        },
      };
      return revived;
    });
  }

  getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    return this.call('getRelated', input) as Promise<RelatedResult[]>;
  }

  async createRecord(input: WriteInput): Promise<WriteResult> {
    return this.call('createRecord', await this.toWireWriteInput(input)) as Promise<WriteResult>;
  }

  async updateRecord(input: UpdateInput): Promise<UpdateResult> {
    const result = (await this.call('updateRecord', await this.toWireWriteInput(input))) as
      | UpdateResult
      | (ExternalRecordRef & { association?: ParentAssociation });
    if ('notFound' in result) return result;
    // A connector that says nothing about the parent it was handed has told us
    // nothing, and nothing is not a link. Silence reads as `unsupported`, which
    // fails a write that named a parent rather than reporting an attach the
    // server never claimed.
    return { ...result, association: result.association ?? unsupportedAssociation(input) };
  }

  deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    return this.call('deleteRecord', input) as Promise<DeleteResult>;
  }

  /** A write as it rides the wire: the parent set normalised to a list, and
   *  every FileRef (in a field or a resource) exposed at a fetchable URL,
   *  since bytes can't cross the JSON envelope. */
  private async toWireWriteInput<T extends WriteInput>(input: T): Promise<T> {
    const fields: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(input.fields)) {
      fields[name] = await this.exposeWriteFileRefs(value);
    }
    const resources = input.resources
      ? ((await Promise.all(input.resources.map((r) => this.exposeWriteFileRefs(r)))) as T['resources'])
      : undefined;
    return {
      ...input,
      fields,
      parentLinks: writeParentLinks(input),
      ...(resources !== undefined ? { resources } : {}),
    };
  }

  /**
   * Deep-walk a write value, replacing every FileRef with a WIRE FileRef whose
   * bytes are exposed at a short-lived Listen-Fire URL (`exposeFile` → S3). Raw bytes
   * and the `retrieve()` closure can't cross the JSON envelope, so the remote
   * server fetches the bytes from `url` instead. Non-FileRef values pass
   * through; an already-exposed FileRef (carrying `url`, no closure) is kept.
   */
  private async exposeWriteFileRefs(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((v) => this.exposeWriteFileRefs(v)));
    }
    if (isFileRef(value)) {
      return this.fileRefToWire(value);
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = await this.exposeWriteFileRefs(v);
      }
      return out;
    }
    return value;
  }

  /** Turn one FileRef into its wire form: metadata + a fetchable `url`. */
  private async fileRefToWire(ref: FileRef): Promise<Record<string, unknown>> {
    const wire: Record<string, unknown> = { __brand: 'FileRef' };
    if (ref.name !== undefined) wire.name = ref.name;
    if (ref.contentType !== undefined) wire.contentType = ref.contentType;
    if (ref.size !== undefined) wire.size = ref.size;
    if (ref.source !== undefined) wire.source = ref.source;
    if (typeof ref.url === 'string') {
      // Already exposed (e.g. re-sent off the wire) — keep its URL.
      wire.url = ref.url;
    } else if (typeof ref.retrieve === 'function') {
      const resolved = await streamFileRef(ref);
      const exposed = await exposeFile({
        stream: resolved.stream,
        filename: ref.name,
        contentType: resolved.contentType ?? ref.contentType,
      });
      wire.url = exposed.url;
      if (wire.contentType === undefined && resolved.contentType !== undefined) {
        wire.contentType = resolved.contentType;
      }
    }
    return wire;
  }

  // ── Streaming (paged) ──────────────────────────────────────────────────

  async *iterateRelated(input: GetRelatedInput): AsyncIterable<RelatedResult> {
    const method = this.advertised.has('iterateRelatedPage') ? 'iterateRelatedPage' : 'iterateRelated';
    let cursor: unknown = undefined;
    do {
      const page = await this.call(method, { ...input, cursor });
      yield* page.items as unknown as RelatedResult[];
      cursor = page.nextCursor;
    } while (cursor != null);
  }

  // ── Optional forwarders (pruned by the factory when unadvertised) ──────

  preprocessInbound(input: {
    raw: unknown;
    checkpoint?: unknown;
  }): Promise<{ events: DiscriminableEvent[]; checkpoint?: unknown }> {
    return this.call('preprocessInbound', input) as Promise<{
      events: DiscriminableEvent[];
      checkpoint?: unknown;
    }>;
  }

  listEventTypes(): Promise<EventType[]> {
    return this.call('listEventTypes', {}) as Promise<EventType[]>;
  }

  readRecord(input: ReadInput): Promise<Record<string, unknown> | null> {
    return this.call('readRecord', input);
  }

  describeOpaqueId(input: { fieldPath: string; value: string }): Promise<string | null> {
    return this.call('describeOpaqueId', input);
  }

  translateFilter(input: {
    expression: Expression;
    entityType: string;
  }): Promise<FilterTranslationResult> {
    return this.call('translateFilter', input) as Promise<FilterTranslationResult>;
  }

  getDedupRules(input: { typeRef: string }): Promise<DedupRules | null> {
    return this.call('getDedupRules', input);
  }

  linkRecords(input: LinkRecordsInput): Promise<LinkRecordsResult> {
    return this.call('linkRecords', input);
  }

  unlinkRecords(input: UnlinkRecordsInput): Promise<UnlinkRecordsResult> {
    return this.call('unlinkRecords', input);
  }

  async ensureEventSubscription(
    input: EnsureEventSubscriptionInput,
  ): Promise<EventSubscriptionRegistration | undefined> {
    return (await this.call('ensureEventSubscription', input)) ?? undefined;
  }

  async removeEventSubscription(input: RemoveEventSubscriptionInput): Promise<void> {
    await this.call('removeEventSubscription', input);
  }

  /** The correlation keys an inbound payload resolves — the keys a pending
   *  `resolveAwait` named — so the host can wake the runs parked on them. */
  wakeKeys(input: { raw: unknown }): Promise<string[]> {
    return this.call('wakeKeys', input);
  }

  /**
   * The awaitable capability over the wire. The server answers `resolveAwait`
   * with the correlation key when pending; the current capability contract
   * still asks the adapter to register that key itself, so the key from the
   * last pending answer is remembered per watch-point and written to the
   * shared correlation table, as the in-process awaitables do.
   */
  private remoteAwaitable(): AwaitableCapability {
    const pendingKeys = new Map<string, string>();
    const pointKey = (point: AwaitPoint): string => JSON.stringify([point.recordId, point.edge]);
    const resolveOverWire = async (point: AwaitPoint): Promise<WireAwaitResolutionShape> => {
      const resolution = await this.call('resolveAwait', {
        recordId: point.recordId,
        edge: point.edge,
        ...(point.headData !== undefined ? { headData: point.headData } : {}),
      });
      if (resolution.status === 'pending') pendingKeys.set(pointKey(point), resolution.correlationKey);
      return resolution;
    };
    return {
      resolveAwait: (point: AwaitPoint): Promise<AwaitResolution> => resolveOverWire(point),
      registerAwait: async (input: AwaitPoint & AwaitParkRef): Promise<void> => {
        let correlationKey = pendingKeys.get(pointKey(input));
        if (correlationKey === undefined) {
          const resolution = await resolveOverWire(input);
          // Landed since the check that parked it: there is nothing to wait on.
          if (resolution.status !== 'pending') return;
          correlationKey = resolution.correlationKey;
        }
        await registerAwaitCorrelation({
          adapterType: this.adapterType,
          correlationKey,
          runId: input.runId as TriggerRunId,
          teamId: input.teamId as TeamId,
          address: input.address,
        });
      },
      dropCorrelation: async (input: Pick<AwaitParkRef, 'runId' | 'address'>): Promise<void> => {
        await dropAwaitCorrelation({ runId: input.runId as TriggerRunId, address: input.address });
      },
    };
  }

  getActorCandidates(input: { event: TriggerEvent }): Promise<ActorCandidate[]> {
    return this.call('getActorCandidates', input) as Promise<ActorCandidate[]>;
  }

  extractActor(input: { event: TriggerEvent }): Promise<ActorIdentity | null> {
    return this.call('extractActor', input) as Promise<ActorIdentity | null>;
  }

  invokeFieldFunction(input: InvokeFieldFunctionInput): Promise<unknown> {
    return this.call('invokeFieldFunction', input);
  }

  /**
   * The wire `resolveFileRef` returns `{ url }` (bytes can't ride the JSON
   * envelope); this forwarder converts url→stream so the engine's
   * `/api/files/{token}` pass-through sees the same `{ stream }` shape a local
   * owner returns. The fetched URL is the owner server's own presigned/proxy
   * location — Listen-Fire never holds the owner's credentials.
   */
  async resolveFileRef(input: { ref: FileRef }): Promise<ResolveFileRefResult> {
    const { url, contentType } = await this.call('resolveFileRef', input);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(
        `RemoteAdapter.resolveFileRef: fetch of resolved url failed (status ${res.status}).`,
      );
    }
    return {
      stream: Readable.fromWeb(res.body as unknown as WebReadableStream),
      contentType: contentType ?? res.headers.get('content-type') ?? undefined,
    };
  }

}

/**
 * Construct a `RemoteAdapter` and prune the optional methods the manifest
 * didn't advertise. Pruning assigns `undefined` on the instance, which shadows
 * the prototype method so `adapter.<method>` is falsy — exactly what the
 * engine's `if (adapter.<method>)` capability gates expect.
 */
export function createRemoteAdapter(input: RemoteAdapterInput): RemoteAdapter {
  const adapter = new RemoteAdapter(input);
  const advertised = new Set(input.manifest.methods);

  const prune = (method: string): void => {
    Reflect.set(adapter, method, undefined);
  };
  for (const method of OPTIONAL_REMOTE_METHODS) {
    if (!advertised.has(method)) prune(method);
  }
  if (!advertised.has('iterateRelated') && !advertised.has('iterateRelatedPage')) {
    prune('iterateRelated');
  }

  return adapter;
}
