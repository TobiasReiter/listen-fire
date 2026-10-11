// Wire protocol schema — the single source of truth for the remote-adapter
// contract. Importable by both the client (Phase 4 `RemoteAdapter`) and any
// future server SDK, with NO imports from `engine/*` internals.
//
// The protocol re-declares the adapter's input/result types as PLAIN zod,
// decoupled from generated/kysely brands. They are structurally identical at
// runtime to the TS types in `../adapter.ts` and `../types.ts`; the point is
// that a third-party author depends on `protocol/schema.ts`, never on
// `generated/kysely/*`. The schemas are strict on the envelope / error /
// page / cursor / method routing and lenient (`z.unknown()` / `.passthrough()`)
// on opaque or deeply-nested payload leaves (cursors, filters, native query
// bodies, Expressions, deep MutationContext internals, position `data`).

import { z } from 'zod';

// ── Envelope ───────────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = '1';

export const RpcRequest = z.object({
  protocolVersion: z.string(),
  method: z.string(),
  cacheScopeId: z.string(),
  params: z.unknown(),
});
export type RpcRequestShape = z.infer<typeof RpcRequest>;

export const RpcError = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export type RpcErrorShape = z.infer<typeof RpcError>;

export const RpcResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: RpcError }),
]);
export type RpcResponseShape = z.infer<typeof RpcResponse>;

// ── Wire DTOs ────────────────────────────────────────────────────────────────
// Structural mirrors of the adapter's TS types. Opaque/huge leaves use
// `z.unknown()`; we validate STRUCTURE, not every leaf.

/** Mirror of `PositionIdentity` — stable external record OR unstable inline. */
export const WirePositionIdentity = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stable'), recordId: z.string(), data: z.unknown().optional() }),
  z.object({ kind: z.literal('unstable'), data: z.unknown() }),
]);

/** Mirror of `EphemeralOriginRef` — provenance for synthetic positions. */
export const WireEphemeralOriginRef = z.union([
  z.object({
    kind: z.literal('extract'),
    extractStepId: z.string(),
    nodeId: z.string(),
  }),
  z.object({
    kind: z.literal('transform'),
    transformName: z.string(),
    emissionIndex: z.number(),
    nodeId: z.string(),
  }),
]);

/** Mirror of `SourcePosition` (`Position`). `data` stays opaque. */
export const WireSourcePosition = z.object({
  adapterType: z.string(),
  recordType: z.string().nullable(),
  identity: WirePositionIdentity,
  originRef: WireEphemeralOriginRef.optional(),
});
export type WireSourcePositionShape = z.infer<typeof WireSourcePosition>;

/**
 * A LANDED record position — one a remote server hands back as a read/traversal
 * RESULT (`getRelated`, `iterateRelated`, `edgesFrom`'s `targetPositions`), as
 * opposed to a position the engine sends as a request param (which may echo a
 * not-yet-narrowed position and stays covered by the plain `WireSourcePosition`
 * above). Mirrors THE ONE RULE the in-process framework already enforces
 * (`adapters/base.ts` — every landed position carries a concrete `recordType`,
 * `AdapterNameDriftError` otherwise) at the one boundary that rule didn't reach:
 * a third-party server answering with a null type used to flow straight into
 * the engine's narrowing, which assumes it cannot happen. Rejected at parse
 * instead, the same failure class as the in-process drift error.
 */
export const WireLandedRecordPosition = WireSourcePosition.extend({
  recordType: z.string({
    error:
      'a landed record position must name its type — an adapter minted a position ' +
      'without one (THE ONE RULE, adapters/base.ts). A typeless position cannot resolve ' +
      'a field or an edge.',
  }),
});
export type WireLandedRecordPositionShape = z.infer<typeof WireLandedRecordPosition>;

/** Mirror of `Actor` (mutation_context). */
export const WireActor = z.object({
  type: z.enum(['user', 'api-token', 'system']),
  id: z.string().nullable(),
});

/** Mirror of the trigger-side `InboundRecordRef` (triggers/types). */
export const WireInboundRecordRef = z.object({
  adapterType: z.string(),
  externalId: z.string(),
  recordType: z.string().optional(),
});

/** Mirror of the target-role `ExternalRecordRef` currency (adapter.ts §3.1):
 *  the flat shape `resolveEntity` candidates and write results share. */
export const WireExternalRecordRef = z.object({
  adapterType: z.string(),
  externalId: z.string(),
  recordType: z.string().optional(),
  url: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

/** Mirror of `TriggerEvent` (triggers/types). `payload` is opaque. */
export const WireTriggerEvent = z.object({
  pipelineInputId: z.string(),
  adapterType: z.string(),
  objectType: z.string().optional(),
  triggerEntryId: z.string().optional(),
  triggerType: z.enum(['snapshot', 'poll', 'changes-feed', 'webhook', 'mutation', 'extraction']),
  payload: z.unknown(),
  changeType: z.enum(['create', 'update', 'delete']).optional(),
  actor: WireActor.optional(),
  snapshotRunId: z.string().optional(),
  snapshotComplete: z.boolean().optional(),
  recordId: z.string().optional(),
  externalRecordRef: WireInboundRecordRef.optional(),
  changedFields: z.array(z.string()).optional(),
  occurredAt: z.string().optional(),
});
export type WireTriggerEventShape = z.infer<typeof WireTriggerEvent>;

/**
 * Mirror of `LinkedObject` — only the fields `resolveEntity` reads off a
 * candidate. `data` is opaque JSONB; brands collapse to plain strings.
 */
export const WireLinkedObject = z
  .object({
    id: z.string(),
    team_id: z.string(),
    node_id: z.string(),
    external_id: z.string(),
    adapter_type: z.string(),
    external_object_type: z.string().nullable().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();
export type WireLinkedObjectShape = z.infer<typeof WireLinkedObject>;

/**
 * Mirror of `FileRef`. The `__brand` literal and the `retrieve()` closure are
 * not carried over the wire — `__brand` is a TS-side phantom and a closure can't
 * serialise. The remote adapter re-binds `retrieve()` on this side
 * (`reviveFileRefs`) using `source` as the handle it sends back to the server.
 */
export const WireFileRef = z.object({
  name: z.string().optional(),
  contentType: z.string().optional(),
  size: z.number().optional(),
  source: z
    .object({ ownerAdapterType: z.string(), handle: z.string() })
    .optional(),
  /** A short-lived, fetchable Listen-Fire URL for the bytes. Set by the sending side
   *  when a FileRef is written INTO a remote adapter: the boundary buffers the
   *  bytes to S3 (`exposeFile`) and passes the URL here, since raw bytes can't
   *  ride the JSON envelope. The remote server GETs the bytes from it. */
  url: z.string().optional(),
});
export type WireFileRefShape = z.infer<typeof WireFileRef>;

/** Mirror of `Fact`. */
export const WireFact = z.object({
  s: z.string(),
  p: z.string(),
  o: z.string(),
  t: z.string().optional(),
});

/** Mirror of `ResourceProvenance` (`4d_resources.md`) — the flat
 *  `ExternalRecordRef` currency plus the source `field`. */
export const WireResourceProvenance = WireExternalRecordRef.extend({
  field: z.string().optional(),
});

/**
 * Mirror of `Resource`. `id` is a plain optional string (NOT a branded
 * ResourceId). Deep bags (`data`, `metadata`) stay opaque.
 */
export const WireResource = z.object({
  id: z.string().optional(),
  externalId: z.string().optional(),
  type: z.enum(['URL', 'EMAIL', 'WHATSAPP', 'FILE', 'TEXT']).optional(),
  name: z.string().optional(),
  url: z.string().nullable().optional(),
  // Bytes for FILE resources ride on `fileRef` (P3/P5); `url` is display-only.
  fileRef: WireFileRef.optional(),
  contentType: z.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  content: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Node-level resource provenance (`4d_resources.md`): facts extracted from
  // the resource + where it came from. Carried on `WriteInput.resources`.
  facts: z.array(WireFact).optional(),
  provenance: WireResourceProvenance.optional(),
});
export type WireResourceShape = z.infer<typeof WireResource>;

/** Mirror of `FieldEvidence` (per-field write provenance, 3b §3.3). */
export const WireFieldEvidence = z.object({
  quote: z.string().optional(),
  startOffset: z.number().optional(),
  endOffset: z.number().optional(),
  type: z.enum(['extraction', 'user_edit', 'retrieval']).optional(),
  sourceResourceRef: z
    .object({ externalId: z.string().optional(), fileRef: z.unknown().optional() })
    .optional(),
});

/**
 * Mirror of `MutationContext`. The deep internals (full source provenance)
 * stay opaque via passthrough — we validate the structural envelope only.
 */
export const WireMutationContext = z
  .object({
    source: z.record(z.string(), z.unknown()),
    occurredAt: z.string(),
    actorId: z.string().optional(),
  })
  .passthrough();
export type WireMutationContextShape = z.infer<typeof WireMutationContext>;

/** Mirror of the opaque target-role `UniquenessConstraints` (3b §3.2) —
 *  OR-of-AND of `{ field, fuzzy? }` over the adapter's own field names. */
export const WireUniquenessConstraints = z.object({
  any: z.array(
    z.object({
      all: z.array(z.object({ field: z.string(), fuzzy: z.boolean().optional() })),
    }),
  ),
});
export type WireUniquenessConstraintsShape = z.infer<typeof WireUniquenessConstraints>;

/** Mirror of `RelatedResult`. `position` is a landed record — a traversal
 *  result the adapter is handing back as something the engine can resolve
 *  fields/edges off — so it must name its type (`WireLandedRecordPosition`). */
export const WireRelatedResult = z.object({
  position: WireLandedRecordPosition,
  edgeId: z.string().optional(),
});
export type WireRelatedResultShape = z.infer<typeof WireRelatedResult>;

/** Mirror of `ActorIdentity`. */
export const WireActorIdentity = z.object({
  identifier: z.string(),
  scheme: z.enum(['email', 'phone', 'opaque']),
  adapterType: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
});

/** Mirror of `ActorCandidate`. */
export const WireActorCandidate = z.object({
  identity: WireActorIdentity,
  source: z.enum(['originator', 'relay']),
});
export type WireActorCandidateShape = z.infer<typeof WireActorCandidate>;

// ── Schema-introspection DTOs ────────────────────────────────────────────────
// Mirror `SchemaEntryPoint` / `SchemaTypeDescriptor` structurally. Field /
// reference descriptors stay loose (passthrough) — the editor consumes the
// rich shape, but the wire contract only needs the structural envelope.
// Passthrough is what carries the per-edge declarations a remote adapter makes
// (`capability`, `readable`, `fires`, `sequenced`) back across the wire intact;
// naming a field here would START stripping the ones we forgot to name.

export const WireSchemaFieldDescriptor = z.object({ fieldId: z.string() }).passthrough();
export const WireSchemaReferenceDescriptor = z.object({ fieldId: z.string() }).passthrough();

export const WireSchemaEntryPoint = z
  .object({
    typeId: z.string(),
    displayName: z.string(),
    writable: z.boolean(),
    readable: z.boolean(),
  })
  .passthrough();
export type WireSchemaEntryPointShape = z.infer<typeof WireSchemaEntryPoint>;

export const WireSchemaTypeDescriptor = z
  .object({
    typeId: z.string(),
    displayName: z.string(),
    fields: z.array(WireSchemaFieldDescriptor),
    references: z.array(WireSchemaReferenceDescriptor),
  })
  .passthrough();
export type WireSchemaTypeDescriptorShape = z.infer<typeof WireSchemaTypeDescriptor>;

/**
 * Mirror of `EdgesFromResult` — one hop of the meta-graph walk. The node is
 * the same descriptor `describe` returns; `targetPositions` carries the path
 * on from each edge, keyed by its `fieldId`. `nextCursor` is opaque, like
 * every other cursor on this wire.
 */
export const WireEdgesFromResult = z
  .object({
    descriptor: WireSchemaTypeDescriptor,
    // Each entry is what the caller echoes back as `edgesFrom`'s next
    // position to follow that edge — a landed record, not a request echo.
    targetPositions: z.record(z.string(), WireLandedRecordPosition).optional(),
    nextCursor: z.unknown().optional(),
  })
  .passthrough();
export type WireEdgesFromResultShape = z.infer<typeof WireEdgesFromResult>;

// ── Entity-resolution DTOs ───────────────────────────────────────────────────

export const WireResolveEntityInput = z.object({
  record: z.record(z.string(), z.unknown()),
  recordType: z.string(),
  candidates: z.array(WireLinkedObject),
  constraints: WireUniquenessConstraints,
});

/**
 * `resolveEntity` result. Canonically `{ candidates: [...] }`, but a bare
 * array of candidates is coerced to that shape first: a list of matches is a
 * naturally array-shaped return, and earlier handbook wording told authors a
 * minimal implementation "may always return []". Tolerating the bare array
 * keeps such adapters working instead of failing the write path with a cryptic
 * "expected object, received array".
 */
export const WireResolveEntityResult = z.preprocess(
  (value) => (Array.isArray(value) ? { candidates: value } : value),
  z.object({
    candidates: z.array(WireExternalRecordRef),
  }),
);

// ── Field / traversal DTOs ───────────────────────────────────────────────────

export const WireGetFieldValueInput = z.object({
  position: WireSourcePosition,
  fieldId: z.string(),
});

/**
 * Mirror of `GetRelatedInput`. NOTE: NO `fetchCache` — it was removed in
 * phase 1; cache is now instance-internal to the adapter. `nativeFilter`
 * stays opaque.
 */
export const WireGetRelatedInput = z.object({
  position: WireSourcePosition,
  fieldId: z.string(),
  direction: z.enum(['outgoing', 'incoming']),
  nativeFilter: z.unknown().optional(),
});

// ── Write DTOs ───────────────────────────────────────────────────────────────

export const WireWriteInput = z
  .object({
    recordType: z.string(),
    fields: z.record(z.string(), z.unknown()),
    evidence: z.record(z.string(), WireFieldEvidence).optional(),
    // Node-level resource provenance (`4d_resources.md`) — persisted by the
    // adapter as part of the same write, deduped on the stable `Resource.id`.
    resources: z.array(WireResource).optional(),
    mutationContext: WireMutationContext,
    // The write's parent set — a list of 0/1/N parents. A linked write is
    // just the 1-element case of the general N-parent (tuple-path) create.
    // See `WriteInput.parentLinks`.
    parentLinks: z
      .array(
        z.object({
          recordType: z.string(),
          externalId: z.string(),
          edgeName: z.string(),
          // The parent's payload in its own adapter's shape (`ParentLink.data`).
          data: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
    bridgeToExternal: z
      .object({
        adapterType: z.string(),
        recordId: z.string(),
        recordType: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

export const WireUpdateInput = WireWriteInput.extend({ externalId: z.string() });

export const WireDeleteInput = z.object({
  recordType: z.string(),
  externalId: z.string(),
  mutationContext: WireMutationContext,
});

/** Write results are the flat `ExternalRecordRef` currency plus opaque
 *  mutation events. `UpdateResult` shares the shape. */
export const WireWriteResult = WireExternalRecordRef.extend({
  // RecordMutationEvents stay opaque (deep KG internals).
  events: z.array(z.unknown()).optional(),
}).passthrough();

/** NOT-FOUND contract (3b): an `updateRecord` is a write BY id; when the target
 *  is gone the adapter returns the typed `{ notFound: true }` signal instead of
 *  the written record. The wire result is therefore the union of the success
 *  arm and that signal, so a remote adapter's not-found faithfully round-trips
 *  back to the engine's bind self-heal rather than being rejected at parse. */
export const WireUpdateNotFound = z.object({ notFound: z.literal(true) });

/** What became of the parent association an update named. OPTIONAL on the wire:
 *  a connector written before this fact existed reports nothing, and the
 *  boundary reads that silence as "this server has no way to attach a matched
 *  record" rather than inventing a link it cannot vouch for. */
export const WireParentAssociation = z.enum(['made', 'already', 'unsupported', 'none']);

export const WireUpdateWriteResult = WireWriteResult.extend({
  association: WireParentAssociation.optional(),
});

export const WireUpdateResult = z.union([WireUpdateWriteResult, WireUpdateNotFound]);

export const WireDeleteResult = z
  .object({
    events: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const WireReadInput = z.object({
  recordType: z.string(),
  externalId: z.string(),
  fieldIds: z.array(z.string()).optional(),
});

// ── Filter pushdown DTOs ─────────────────────────────────────────────────────

export const WireTranslateFilterInput = z.object({
  // Expression is opaque on the wire.
  expression: z.unknown(),
  entityType: z.string(),
});

export const WireFilterTranslationResult = z.object({
  native: z.unknown(),
  // Residual Expression stays opaque.
  residual: z.unknown().nullable(),
});

// ── Resource / dedup / misc DTOs ─────────────────────────────────────────────

export const WireDedupRules = z.object({
  constraints: z.array(
    z.object({
      entries: z.array(
        z.object({
          propertyTypeId: z.string(),
          fuzzy: z.boolean(),
        }),
      ),
    }),
  ),
});

export const WireGetDedupRulesInput = z.object({ typeRef: z.string() });

export const WireDescribeOpaqueIdInput = z.object({
  fieldPath: z.string(),
  value: z.string(),
});

export const WireGetActorCandidatesInput = z.object({ event: WireTriggerEvent });

export const WireExtractActorInput = z.object({ event: WireTriggerEvent });

// Field functions (e.g. Slack's SLACK_MESSAGE) — see
// plans/2026-06-06-target-composer-functions. Fully serialisable: the engine
// passes the evaluated brief + bare data values; the (remote) adapter returns
// the composed value.
export const WireInvokeFieldFunctionInput = z.object({
  recordType: z.string(),
  fieldId: z.string(),
  functionName: z.string(),
  args: z.object({
    instructions: z.string(),
    data: z.array(z.unknown()),
  }),
});

export const WireManifestResult = z.object({
  adapterType: z.string(),
  supportedTriggers: z.array(z.string()),
  // Whole-adapter capability (mirrors `Adapter.runtimeCapabilities()`):
  // can the source traverse incoming edges, carry edge properties, expose
  // resources? Per-edge / per-field capability rides `describe()`, not here.
  runtimeCapabilities: z.object({
    traversal: z.object({
      incoming: z.boolean(),
      edgeProperties: z.boolean(),
    }),
    resources: z.boolean(),
  }),
  // Protocol method names the server actually implements — lets the client
  // gate the optional methods (prune absent ones so the engine's
  // `if (adapter.method)` capability checks see `undefined`).
  methods: z.array(z.string()),
  // Static config for the engine's generic `resolvePositionTypeId`: the
  // adapter's webhook/synthetic event type. Pure config, declared in the
  // manifest rather than answered by an RPC.
  webhookEventTypeId: z.string().optional(),
});

// ── Streaming page shapes ────────────────────────────────────────────────────

export const RelatedPage = z.object({
  items: z.array(WireRelatedResult),
  nextCursor: z.unknown().optional(),
});
export type RelatedPageShape = z.infer<typeof RelatedPage>;

// ── Event seams (preprocessInbound / listEventTypes) ─────────────────────────

export const WireDiscriminableEvent = z.object({
  payload: z.unknown(),
  externalId: z.string().optional(),
  tag: z.string().optional(),
  actor: WireActor.optional(),
  occurredAt: z.string().optional(),
  changeType: z.enum(['create', 'update', 'delete']).optional(),
  eventType: z.string().optional(),
  recordType: z.string().optional(),
  changedFields: z.array(z.string()).optional(),
});

export const WireEventType = z.object({
  tag: z.string(),
  positionType: z.string(),
  match: z
    .object({
      path: z.string(),
      equals: z.union([z.string(), z.array(z.string())]),
    })
    .optional(),
});

// ── Method registry ──────────────────────────────────────────────────────────
// One entry per protocol method, each describing its params + result schema.
// The client and server share this; adding a method is one entry.

export const METHODS = {
  manifest: {
    params: z.object({}),
    result: WireManifestResult,
  },
  listEntryPoints: {
    params: z.object({}),
    result: z.array(WireSchemaEntryPoint),
  },
  describe: {
    params: z.object({ typeId: z.string() }),
    result: WireSchemaTypeDescriptor.nullable(),
  },
  // The meta-graph walk. OPTIONAL (see `OPTIONAL_REMOTE_METHODS`): a server
  // that doesn't advertise it is pruned client-side and callers fall back to
  // `describe`. It arrives as a NEW NAME rather than a `position` param on
  // `describe` deliberately — params are never validated on this wire, so an
  // old server accepting a position and ignoring it would be indistinguishable
  // from one honouring it, and the caller would get a plausible type-wide
  // descriptor either way. Presence in `methods[]` is a checkable signal;
  // a silently-ignored param is not.
  edgesFrom: {
    params: z.object({ position: WireSourcePosition, cursor: z.unknown().optional() }),
    result: WireEdgesFromResult.nullable(),
  },
  resolveEntity: {
    params: WireResolveEntityInput,
    result: WireResolveEntityResult,
  },
  getFieldValue: {
    params: WireGetFieldValueInput,
    result: z.unknown(),
  },
  getRelated: {
    params: WireGetRelatedInput,
    result: z.array(WireRelatedResult),
  },
  iterateRelated: {
    params: WireGetRelatedInput.extend({ cursor: z.unknown().optional() }),
    result: RelatedPage,
  },
  preprocessInbound: {
    params: z.object({ raw: z.unknown(), checkpoint: z.unknown().optional() }),
    result: z.object({
      events: z.array(WireDiscriminableEvent),
      checkpoint: z.unknown().optional(),
    }),
  },
  listEventTypes: {
    params: z.object({}),
    result: z.array(WireEventType),
  },
  createRecord: {
    params: WireWriteInput,
    result: WireWriteResult,
  },
  updateRecord: {
    params: WireUpdateInput,
    result: WireUpdateResult,
  },
  deleteRecord: {
    params: WireDeleteInput,
    result: WireDeleteResult,
  },
  readRecord: {
    params: WireReadInput,
    result: z.record(z.string(), z.unknown()).nullable(),
  },
  translateFilter: {
    params: WireTranslateFilterInput,
    result: WireFilterTranslationResult,
  },
  getDedupRules: {
    params: WireGetDedupRulesInput,
    result: WireDedupRules.nullable(),
  },
  getActorCandidates: {
    params: WireGetActorCandidatesInput,
    result: z.array(WireActorCandidate),
  },
  extractActor: {
    params: WireExtractActorInput,
    result: WireActorIdentity.nullable(),
  },
  describeOpaqueId: {
    params: WireDescribeOpaqueIdInput,
    result: z.string().nullable(),
  },
  resolveFileRef: {
    params: z.object({ ref: WireFileRef }),
    // Owner-side resolution returns a URL the engine fetches into a stream;
    // bytes never cross the RPC envelope directly.
    result: z.object({ url: z.string(), contentType: z.string().optional() }),
  },
  invokeFieldFunction: {
    params: WireInvokeFieldFunctionInput,
    result: z.unknown(),
  },
} as const;

export type MethodName = keyof typeof METHODS;
