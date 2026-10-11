// RemoteAdapter — implements the in-process `Adapter` interface by forwarding
// every call over the wire protocol (the `engine-contracts` protocol schema + `protocol/client.ts`).
// A third-party (or out-of-process) adapter server speaks the same method
// registry; this class lets the TG engine drive it as if it were local.
//
// A pure forwarder: the wire speaks the same NATURAL names (type, field and
// edge display names) the in-process interface does, so nothing is translated
// here. The remote server resolves names to its own internal ids exactly as an
// in-process adapter does on the first line of each method. The only rewriting
// is transport: files written into the remote are exposed at a fetchable URL;
// a file read back — ONLY at a field the remote's own catalog declares a file
// (`describe`), or in a resource's `fileRef` slot — is named as a file this
// install owns, redeemed through `resolveFileRef`; anything else it answers is
// data, whatever its keys. The wire keeps its own FileRef spelling
// (`source: { ownerAdapterType, handle }`): no file this side sends — in a
// write, or in a position's resources and evidence — names a credential or
// construction args.
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

import { METHODS, WireManifestProtocolVersion } from 'engine-contracts';

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
  RelatedPage,
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
  FieldEvidence,
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
  AwaitPoint,
  AwaitResolution,
} from '../../awaitable';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from '../../types';
import type { TriggerEvent, TriggerType } from '../../triggers/types';
import type { Expression } from '#shared/expression/types';
import type { AuthStrategy } from '../../protocol/client';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MethodName } from 'engine-contracts';

import { authHeader, postRpc, parseWireResult } from '../../protocol/client';
import { DOCUMENT_STORE_OWNER } from '../../engine/files/document_store';
import { fileOwner, hasFileSource, streamFileRef } from '../../engine/files/retrieve';
import { exposeFile } from '../../engine/files/expose';
import {
  fileDescriptorOf,
  isFileValue,
  iterateRelatedPages,
  RESOURCES_REFERENCE_FIELD_ID,
  ownedFileSource,
  unsupportedAssociation,
  writeParentLinks,
  type EarlierFileSource,
  type FileSource,
} from '../../adapter';

/**
 * A remote's catalog could not be read for the field a read answered, so
 * whether its answer is a file is not known: that read fails, naming why,
 * rather than taking the answer for data.
 */
export class RemoteDescribeFailed extends Error {
  constructor(adapterType: string, recordType: string, fieldId: string, cause: unknown) {
    super(
      `Remote adapter "${adapterType}": describe(${JSON.stringify(recordType)}) failed, so whether ${JSON.stringify(fieldId)} holds a file is not known — ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'RemoteDescribeFailed';
  }
}

export interface RemoteAdapterConfig {
  /** Slug the engine routes on. */
  adapterType: string;
  /** The team whose install this is — sent with every call. */
  teamId: TeamId;
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
 * surfaces are gated differently: `iterateRelated` and `iterateRelatedPage`
 * stay while the server advertises either paging method, and `awaitable` exists only when the
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
] as const satisfies readonly (keyof Adapter)[];

/**
 * Install-time manifest fetch. Calls the server's `manifest` method and
 * validates the result against the protocol schema, then re-enters the branded
 * domain at the single sanctioned boundary `as` (a validated wire value
 * crossing back into branded types).
 */
export async function fetchRemoteManifest(
  config: Pick<RemoteAdapterConfig, 'adapterType' | 'teamId' | 'baseUrl' | 'authStrategy'>,
  secret: string,
): Promise<RemoteManifest> {
  const raw = await postRpc({
    baseUrl: config.baseUrl,
    auth: authHeader(config.authStrategy, secret),
    teamId: config.teamId,
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
      teamId: this.config.teamId,
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
      position: wirePosition(position),
      ...(cursor !== undefined ? { cursor } : {}),
    }) as Promise<EdgesFromResult | null>;
  }

  resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    return this.call('resolveEntity', input) as Promise<ResolveEntityResult>;
  }

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    const value = await this.call('getFieldValue', { ...input, position: wirePosition(input.position) });
    // A scalar is no file whatever the catalog says: no need to ask it.
    if (value === null || typeof value !== 'object') return value;
    const field = await this.declaredField(input.position.recordType, input.fieldId);
    if (field?.kind !== 'file') return value;
    return Array.isArray(value) ? value.map((member) => this.ownedFile(member)) : this.ownedFile(value);
  }

  /** The remote's own catalog entries, by type, asked once each. */
  private readonly described = new Map<string, Promise<SchemaTypeDescriptor | null>>();

  /** The field a read names, as the remote's catalog declares it on the
   *  position's type — by its natural name or its id. */
  private async declaredField(
    recordType: string | null,
    fieldId: string,
  ): Promise<SchemaTypeDescriptor['fields'][number] | undefined> {
    if (recordType === null) return undefined;
    let descriptor = this.described.get(recordType);
    if (descriptor === undefined) {
      const asked = this.describe(recordType);
      descriptor = asked;
      this.described.set(recordType, asked);
      // A failure is this call's, never remembered: the next read asks again.
      asked.catch(() => {
        if (this.described.get(recordType) === asked) this.described.delete(recordType);
      });
    }
    let described: SchemaTypeDescriptor | null;
    try {
      described = await descriptor;
    } catch (error) {
      throw new RemoteDescribeFailed(this.adapterType, recordType, fieldId, error);
    }
    return described?.fields.find((field) => field.displayName === fieldId || field.fieldId === fieldId);
  }

  /**
   * A file read off the wire, at a field the remote declares a file: its
   * descriptor names the file by the remote's own handle (`{ ownerAdapterType,
   * handle }`); this side's names the owning INSTANCE — this remote install,
   * with its credential — so the host can resolve it again to redeem the handle
   * through `resolveFileRef`. The wire makes `source` optional: a file that
   * arrives with only a `url` is named by that url, and `resolveFileRef` sends
   * it back as before (the reference kit answers with the ref's url). A value
   * there that spells no descriptor stays as it came. The engine makes the
   * descriptor a file by the same declaration (its catalog snapshot).
   */
  private ownedFile(value: unknown): unknown {
    const ref = fileDescriptorOf(value);
    if (ref === undefined) return value;
    const { source, ...rest } = ref;
    const handle = wireHandle(source) ?? (typeof rest.url === 'string' ? rest.url : undefined);
    return handle === undefined
      ? rest
      : {
          ...rest,
          source: ownedFileSource({
            adapterType: this.adapterType,
            credentialsId: this.config.credentialsId,
            handle,
          }),
        };
  }

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    const related = (await this.call('getRelated', { ...input, position: wirePosition(input.position) })) as RelatedResult[];
    return input.fieldId === RESOURCES_REFERENCE_FIELD_ID ? related.map((r) => this.ownedResource(r)) : related;
  }

  /** A resource the remote answered: its `fileRef` slot (typed — whatever it
   *  holds is that resource's file) named as a file this install owns. */
  private ownedResource(related: RelatedResult): RelatedResult {
    const identity = related.position.identity;
    const data: unknown = identity.data;
    if (typeof data !== 'object' || data === null || !('fileRef' in data) || data.fileRef === undefined) return related;
    const owned = { ...data, fileRef: this.ownedFile(data.fileRef) };
    return { ...related, position: { ...related.position, identity: { ...identity, data: owned } } };
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
      ? (await Promise.all(input.resources.map((r) => this.exposeWriteFileRefs(r)))).map(wireResourceShaped)
      : undefined;
    // A parent's payload (a resource parent's is the resource) names no
    // credential either.
    const parentLinks = writeParentLinks(input).map((link) =>
      link.data !== undefined ? { ...link, data: wireResourceRecord(link.data) } : link,
    );
    return {
      ...input,
      fields,
      parentLinks,
      ...(resources !== undefined ? { resources } : {}),
    };
  }

  /**
   * Deep-walk a write value, replacing every FileRef with a WIRE FileRef whose
   * bytes are exposed at a short-lived Listen-Fire URL (`exposeFile` → S3). Raw bytes
   * can't cross the JSON envelope, so the remote server fetches the bytes from
   * `url` instead. Non-FileRef values pass through; an already-exposed FileRef
   * (carrying `url`) keeps it.
   */
  private async exposeWriteFileRefs(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((v) => this.exposeWriteFileRefs(v)));
    }
    if (isFileValue(value)) {
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
    const source = ref.source !== undefined ? wireSource(ref.source) : undefined;
    if (source !== undefined) wire.source = source;
    if (typeof ref.url === 'string') {
      // Already exposed (e.g. re-sent off the wire) — keep its URL.
      wire.url = ref.url;
    } else if (hasFileSource(ref)) {
      const resolved = await streamFileRef(ref, { teamId: this.config.teamId });
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

  iterateRelated(input: GetRelatedInput): AsyncIterable<RelatedResult> {
    return iterateRelatedPages((cursor) => this.iterateRelatedPage(input, cursor));
  }

  /** One page over the wire, so a remote fronted by another protocol server
   *  is paged through rather than drained. A v1-only server pages under the
   *  old `iterateRelated` name with the same shape. */
  async iterateRelatedPage(input: GetRelatedInput, cursor?: unknown): Promise<RelatedPage> {
    const method = this.advertised.has('iterateRelatedPage') ? 'iterateRelatedPage' : 'iterateRelated';
    const page = await this.call(method, { ...input, position: wirePosition(input.position), cursor });
    return {
      items: page.items as unknown as RelatedResult[],
      ...(page.nextCursor != null ? { nextCursor: page.nextCursor } : {}),
    };
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

  private remoteAwaitable(): AwaitableCapability {
    return {
      resolveAwait: (point: AwaitPoint): Promise<AwaitResolution> =>
        this.call('resolveAwait', {
          recordId: point.recordId,
          edge: point.edge,
          ...(point.headData !== undefined ? { headData: point.headData } : {}),
        }),
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
    const { source, ...ref } = input.ref;
    const onWire = source !== undefined ? wireSource(source) : undefined;
    const { url, contentType } = await this.call('resolveFileRef', {
      ref: { ...ref, ...(onWire !== undefined ? { source: onWire } : {}) },
    });
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

/** A descriptor's source as the wire spells it: the owner TYPE and its
 *  handle. The credential stays on this side. */
function wireSource(source: FileSource | EarlierFileSource): EarlierFileSource | undefined {
  const owner = fileOwner(source);
  if (owner === undefined) return undefined;
  return owner.kind === 'document'
    ? { ownerAdapterType: DOCUMENT_STORE_OWNER, handle: owner.objectUri }
    : { ownerAdapterType: owner.adapterType, handle: owner.handle };
}

/** The handle a wire FileRef's `source` carries, when it carries one. */
function wireHandle(source: unknown): string | undefined {
  if (source === null || typeof source !== 'object' || !('handle' in source)) return undefined;
  return typeof source.handle === 'string' ? source.handle : undefined;
}

/**
 * A position as the wire carries it: the files on its resources and on its
 * evidence in the wire's spelling — the owner type and handle, never this
 * side's credential or construction args. Everything else as it stands.
 */
function wirePosition(position: SourcePosition): Record<string, unknown> {
  // Read off the position rather than typed onto it: `resources` and
  // `evidence` ride on positions an automation produced, which the in-process
  // type does not declare, so each is validated as it is read.
  const resources: unknown = Reflect.get(position, 'resources');
  const evidence: unknown = Reflect.get(position, 'evidence');
  const data = wireResourceShaped(position.identity.data);
  return {
    ...position,
    ...(data !== position.identity.data ? { identity: { ...position.identity, data } } : {}),
    ...(Array.isArray(resources) ? { resources: resources.map(wireResourceShaped) } : {}),
    ...(isPlainRecord(evidence)
      ? {
          evidence: Object.fromEntries(
            Object.entries(evidence).map(([field, entry]) => [
              field,
              isPlainRecord(entry) && isPlainRecord(entry.sourceResourceRef)
                ? { ...entry, sourceResourceRef: wireResourceRecord(entry.sourceResourceRef) }
                : entry,
            ]),
          ),
        }
      : {}),
  };
}

/** A resource-shaped value (a position's resource, a resource position's
 *  data, a parent's payload) with its `fileRef` slot — and its `data.file`,
 *  the same file — in the wire's spelling; anything else as it stands. */
function wireResourceShaped(value: unknown): unknown {
  return isPlainRecord(value) ? wireResourceRecord(value) : value;
}

function wireResourceRecord(value: Record<string, unknown>): Record<string, unknown> {
  const slot = value.fileRef;
  const ref = isFileValue(slot) ? { ...slot } : fileDescriptorOf(slot);
  if (ref === undefined) return value;
  const file = wireFile(ref);
  const data = isPlainRecord(value.data) && Object.hasOwn(value.data, 'file') ? { ...value.data, file } : value.data;
  return { ...value, fileRef: file, ...(value.data !== undefined ? { data } : {}) };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A descriptor in the wire's spelling: its metadata, its url, its owner type
 *  and handle — no credential. */
function wireFile(ref: FileRef): FileRef {
  const { source, ...rest } = { ...ref };
  const onWire = source !== undefined ? wireSource(source) : undefined;
  return { ...rest, ...(onWire !== undefined ? { source: onWire } : {}) };
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
    prune('iterateRelatedPage');
  }

  return adapter;
}
