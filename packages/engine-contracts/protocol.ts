// Wire protocol schema — the single source of truth for the remote-adapter
// contract. Importable by the client (`RemoteAdapter`), the server kit and any
// third-party server, with no import from the engine or the run host.
//
// The protocol re-declares the adapter's input/result types as PLAIN zod,
// free of any database brand. They are structurally identical at runtime to
// the in-process `Adapter` interface's types (apps/api
// `translation_graph/adapter.ts`, `translation_graph/types.ts`); the point is
// that a third-party author depends on this package, never on the run host's
// generated database code. The schemas are strict on the envelope / error /
// page / cursor / method routing and lenient (`z.unknown()` / `.passthrough()`)
// on opaque or deeply-nested payload leaves (cursors, filters, native query
// bodies, Expressions, deep MutationContext internals, position `data`).
//
// Names on this wire are NATURAL names — a type's, field's or edge's display
// name — exactly what the in-process `Adapter` interface trades in. An
// adapter's own internal ids never cross it (record ids aside: those are
// identity, not names); each side resolves names to whatever it needs.

import { z } from 'zod';

// ── Envelope ───────────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = '2';

/** The same version as the manifest's `protocolVersion` field. A number there
 *  because manifests are hand-written files, where `2` is what an author types. */
export const MANIFEST_PROTOCOL_VERSION = 2;

/** A manifest's `protocolVersion`, shared by the server's `manifest` answer and
 *  the installable manifest file so both refuse an older adapter in the same
 *  words. */
export const WireManifestProtocolVersion = z.literal(MANIFEST_PROTOCOL_VERSION, {
  error: (issue) =>
    `protocolVersion: expected ${MANIFEST_PROTOCOL_VERSION}, got ${JSON.stringify(issue.input) ?? 'nothing'} — ` +
    `this adapter targets an older adapter protocol; update it to protocol version ${MANIFEST_PROTOCOL_VERSION}.`,
});

/** A credential's fields as stored, every value a string (`expires_at` an ISO
 *  time). */
export const WireCredentialFields = z.record(z.string(), z.string());

/** The resolved credential a request carries to a module that declares one
 *  (`credentials` on the manifest, each declaration an ALTERNATIVE way to
 *  connect): the credential the CONNECTION names
 *  (`connect hs_alice using alice_hubspot`), under the declared name it fills.
 *  The install's own server secret is the request's auth header, never this. */
export const WireCredential = z.object({
  name: z.string().min(1),
  fields: WireCredentialFields,
});
export type WireCredentialShape = z.infer<typeof WireCredential>;

/** Fields a module changed (a refreshed token, a rotated refresh token),
 *  merged over the stored ones and written back by the host. Only the named
 *  fields change. */
export const WireCredentialUpdate = z.object({
  name: z.string().min(1),
  fields: WireCredentialFields,
});
export type WireCredentialUpdateShape = z.infer<typeof WireCredentialUpdate>;

/** What a call spent on a paid service, in the engine's cost-line terms: the
 *  host adds it to the run's spend, so the run's cost cap (`maxRunCostUsd`)
 *  counts it. `label` names the service in the trace and usage records. */
export const WireCostLine = z.object({
  microdollars: z.number().int().nonnegative(),
  label: z.string().min(1),
});
export type WireCostLineShape = z.infer<typeof WireCostLine>;

/** A module's construction arguments (an Airtable base, a spreadsheet), by
 *  the names its manifest's `settings` declare, as the install holds them. */
export const WireModuleSettingValues = z.record(z.string(), z.string());

export const RpcRequest = z.object({
  protocolVersion: z.string(),
  method: z.string(),
  cacheScopeId: z.string(),
  params: z.unknown(),
  /** Within version 2: absent for a server that declares no credential. The
   *  one credential the connection names (`using`), under the declared
   *  alternative it fills. Never more than one: a module that needs two
   *  secrets declares them as fields of one credential. A `credentials` list
   *  from an older host is ignored. */
  credential: WireCredential.optional(),
  /** Within version 2: the install's declared settings. */
  settings: WireModuleSettingValues.optional(),
});
export type RpcRequestShape = z.infer<typeof RpcRequest>;

export const RpcError = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export type RpcErrorShape = z.infer<typeof RpcError>;

/** The `code` of a failure that says the provider refused the request's
 *  credential (an expired or revoked token): the host refreshes that
 *  credential and retries the call once. */
export const CREDENTIAL_REFUSED_CODE = 'credential_refused';

/** The provider's throttle signal, in seconds: it asked for no further call
 *  on this credential (or install) for that long. The host's limiter holds
 *  every call there until then. */
export const WireRetryAfter = z.number().nonnegative();

// `credentialUpdate` rides a failure too: a module that refreshed and was then
// refused must still hand back the rotated refresh token, or it is lost.
// `cost` rides a failure too: money spent is spent. `retryAfter` rides either:
// a provider may say "slow down" on a call it answered.
export const RpcResponse = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    result: z.unknown(),
    credentialUpdate: WireCredentialUpdate.optional(),
    cost: z.array(WireCostLine).optional(),
    retryAfter: WireRetryAfter.optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: RpcError,
    credentialUpdate: WireCredentialUpdate.optional(),
    cost: z.array(WireCostLine).optional(),
    retryAfter: WireRetryAfter.optional(),
  }),
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
  // A position from a `#resources` traversal off an extract node.
  z.object({
    kind: z.literal('resource'),
    resourceId: z.string().optional(),
    nodeId: z.string(),
  }),
]);

/** Mirror of `SourcePosition` (`Position`), including the members an
 *  `EphemeralNode` adds. `data` stays opaque. The evidence and resource
 *  mirrors are declared further down, hence `lazy`. A position's resources
 *  are the engine's own, echoed back unchanged: their file refs are host
 *  descriptors, not the wire's spelling, so `fileRef` stays opaque here (as
 *  it does on evidence's `sourceResourceRef`). */
export const WireSourcePosition = z.object({
  adapterType: z.string(),
  recordType: z.string().nullable(),
  identity: WirePositionIdentity,
  originRef: WireEphemeralOriginRef.optional(),
  evidence: z.lazy(() => z.record(z.string(), WireFieldEvidence)).optional(),
  resources: z.lazy(() => z.array(WireResource.extend({ fileRef: z.unknown().optional() }))).optional(),
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
  /** The source's own id for the occurrence, carried from the event that
   *  made this one (`WireDiscriminableEvent.idempotencyKey`). */
  idempotencyKey: z.string().optional(),
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
 * The wire's spelling of a `FileRef`. `source` names the owner TYPE and the
 * owner's handle — never a credential, which stays on Listen-Fire's side: the
 * remote adapter translates between this and the descriptor that names the
 * owning install (`RemoteAdapter`), and sends the handle back to the server
 * in `resolveFileRef`.
 */
export const WireFileRef = z.object({
  // The descriptor's spelling, read by nobody: what makes a ref a file is the
  // field it sits in (one the catalog declares a file) or a resource's
  // `fileRef` slot. Optional, so a remote that omits it is not refused.
  __brand: z.literal('FileRef').optional(),
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
    /** The type's records can be removed by `deleteRecord` (absent ⇒ no) —
     *  named because it is the one promise `delete` is checked against
     *  (language version 5); it is optional, so an older server is unchanged. */
    deletable: z.boolean().optional(),
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
  // The hop's pushed WHERE / ORDER BY / LIMIT — hints the adapter may ignore
  // (the engine re-applies them). The WHERE Expression stays opaque.
  where: z.unknown().optional(),
  orderBy: z.object({ fieldId: z.string(), direction: z.enum(['asc', 'desc']) }).optional(),
  limit: z.number().optional(),
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

/** Mirror of `LinkRecordsInput` / `UnlinkRecordsInput` — two existing records
 *  and the edge between them, named from the FROM side's type. */
const WireLinkRecordEndpoint = z.object({ recordType: z.string(), externalId: z.string() });

export const WireLinkRecordsInput = z.object({
  from: WireLinkRecordEndpoint,
  edgeName: z.string(),
  to: WireLinkRecordEndpoint,
  mutationContext: WireMutationContext,
});

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

/**
 * What a listen on this adapter may say — declared, so the checker can refuse a
 * listen config the adapter would never route, and type a config-less listen.
 * The same three declarations a built-in adapter's manifest makes:
 *   - `subscribableEvents`: the values of a listen's `events: [...]` (an event's
 *     `eventType` is matched against them when routing);
 *   - `defaultSubscribedEvents`: what a listen with no `events` receives
 *     (absent ⇒ every subscribable event);
 *   - `listenConfig`: further keys, whether a listen must carry each, and a
 *     static value format the checker validates.
 * All optional: an adapter declaring none leaves its listen config unchecked.
 */
export const WireListenDeclarations = z.object({
  subscribableEvents: z.array(z.string().min(1)).optional(),
  defaultSubscribedEvents: z.array(z.string().min(1)).optional(),
  listenConfig: z
    .array(
      z.object({
        key: z.string().min(1),
        required: z.boolean().optional(),
        format: z.enum(['cron', 'timezone', 'fields', 'strings']).optional(),
      }),
    )
    .optional(),
});

// ── Module declarations (within version 2: all optional) ─────────────────────
// What an installable module declares beyond its methods, so a host can do
// the module's housekeeping without knowing the module: which credential it
// needs and how that credential is connected and refreshed, how its
// provider's webhooks are signed, and what it wants run on a schedule. A
// server that declares none of them is the version-2 server it always was.

const DECLARED_NAME = /^[a-z][a-z0-9_]*$/;
const declaredName = (what: string) =>
  z.string().regex(DECLARED_NAME, `${what} must be ASCII lower case: a letter, then letters, digits or underscores`);

/** One field a credential holds, by the name it is stored and sent under. */
export const WireCredentialField = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  /** Absent means secret: kept out of logs, traces and error text. `false` is
   *  for a field that is safe to show, such as a workspace id. */
  secret: z.boolean().optional(),
  optional: z.boolean().optional(),
});

/** How an OAuth 2 credential is connected and refreshed. The host refreshes
 *  it with the standard refresh-token grant at `tokenUrl`; a module whose
 *  provider refreshes some other way implements `refreshCredential` instead. */
export const WireOAuth2Declaration = z.object({
  authorizeUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopes: z.array(z.string().min(1)).optional(),
  /** Where the client id and secret go on the token call: an HTTP Basic
   *  header (absent) or the form body. */
  clientAuth: z.enum(['basic', 'body']).optional(),
  pkce: z.boolean().optional(),
  /** Extra query parameters the provider's authorize page needs
   *  (`access_type: "offline"`, …). */
  authorizeParams: z.record(z.string(), z.string()).optional(),
});

/**
 * A credential the module needs. `static` is entered once and never refreshed
 * by the host (an API key, a bot token). `oauth2` is connected through the
 * provider's authorize page and holds `access_token`, `refresh_token` and
 * `expires_at` (an ISO time) besides the `fields` it lists.
 */
export const WireCredentialDeclaration = z.discriminatedUnion('kind', [
  z.object({ name: declaredName('a credential name'), kind: z.literal('static'), fields: z.array(WireCredentialField) }),
  z.object({
    name: declaredName('a credential name'),
    kind: z.literal('oauth2'),
    fields: z.array(WireCredentialField),
    oauth2: WireOAuth2Declaration,
  }),
]);
export type WireCredentialDeclarationShape = z.infer<typeof WireCredentialDeclaration>;

/** How a provider signs the webhooks it sends, one name per scheme the host
 *  verifies. `remote` is this protocol's own (`x-listen-fire-signature`). */
export const INBOUND_SIGNATURE_SCHEMES = [
  'hmac_sha256_hex',
  'airtable_mac',
  'attio',
  'affinity_hex_or_b64',
  'slack_v0',
  'telegram_secret_token',
  'remote',
] as const;
export const WireInboundSignatureScheme = z.enum(INBOUND_SIGNATURE_SCHEMES);
export type WireInboundSignatureSchemeShape = z.infer<typeof WireInboundSignatureScheme>;

/** A request the host answers itself before verifying a delivery: Slack's
 *  `url_verification`, which echoes its `challenge` unsigned. A name the host
 *  does not know is refused at parse rather than silently not answered. */
export const INBOUND_INTERCEPTS = ['slack_url_verification'] as const;
export const WireInboundIntercept = z.enum(INBOUND_INTERCEPTS);

const HEADER_NAME = /^[a-z0-9-]+$/;

/**
 * How the provider's webhooks reach the module: through the host's door at
 * `/api/public/webhook-sync/<providerKey>/<subscription>`, verified by
 * `scheme` before `preprocessInbound` sees the body.
 */
export const WireInboundDeclaration = z.object({
  /** The door's provider segment — for a built-in, today's key, so no
   *  subscription's URL changes. */
  providerKey: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'providerKey must be ASCII lower case'),
  scheme: WireInboundSignatureScheme,
  /** The headers that may carry the signature, lower case, the first present
   *  one read. `slack_v0` also reads `x-slack-request-timestamp`, which the
   *  scheme fixes. */
  signatureHeaders: z
    .array(z.string().regex(HEADER_NAME, 'a signature header is a lower-case header name'))
    .min(1),
  intercepts: z.array(WireInboundIntercept).optional(),
  /** Who sets the secret deliveries are signed with. `installer` (the
   *  default): whoever installs the module sets it (`lf connect` generates or
   *  asks for it). `provider`: the provider issues it when the webhook is
   *  registered (`ensureEventSubscription` returns it), so nobody is asked,
   *  and a registration that returns none is refused. */
  secretIssuedBy: z.enum(['installer', 'provider']).optional(),
});
export type WireInboundDeclarationShape = z.infer<typeof WireInboundDeclaration>;

/** The module is a polled source: the host calls `poll` every
 *  `intervalSeconds` per listen (a listen's own `every` overrides it). */
export const WirePollDeclaration = z.object({
  intervalSeconds: z.number().int().positive(),
});

/** Housekeeping the host runs every `intervalSeconds` per install, by
 *  `runPeriodic({ name })` (renewing a provider's expiring webhook, say). */
export const WirePeriodicDeclaration = z.object({
  name: declaredName('a periodic task name'),
  intervalSeconds: z.number().int().positive(),
});

/**
 * One plugin's checker surface (movement-lang's `PluginSpec`, minus the
 * package, which the declaration names once for all its plugins): the
 * arguments a call may write, their types, its effects, whether it may cost
 * money, and what it hands back. The checker reads it to type a call; the
 * engine reads it to bind one. Its type vocabulary is the checker's own, so
 * the inner shapes are the checker's to refuse.
 */
export const WirePluginSpec = z.object({
  args: z.array(z.string()),
  priced: z.boolean(),
  argTypes: z.record(z.string(), z.unknown()),
  requiredArgs: z.array(z.string()).optional(),
  effects: z.record(z.string(), z.unknown()).optional(),
  fedArgs: z.array(z.object({ name: z.string(), required: z.literal(true).optional() })).optional(),
  fedByExtraction: z.literal(true).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  earlierOutputs: z.array(z.object({ before: z.number().int().positive(), output: z.record(z.string(), z.unknown()) })).optional(),
});
export type WirePluginSpecShape = z.infer<typeof WirePluginSpec>;

/**
 * The plugins a module serves, imported by a program as one package
 * (``import { `@lf/web` as web } from plugins``, then `web.fetchUrl(…)`).
 * `package` is the tag, matched exactly and never parsed. Each plugin's
 * `name` is its registered name (`fetch-url`); a program calls it by the
 * camel-case of that name.
 */
export const WirePluginsDeclaration = z.object({
  package: z.string().min(1),
  plugins: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'a plugin name is ASCII lower case: a letter, then letters, digits, dashes or underscores'),
        spec: WirePluginSpec,
      }),
    )
    .min(1),
});
export type WirePluginsDeclarationShape = z.infer<typeof WirePluginsDeclaration>;

/** What a module is: an adapter (a system movements read and write), a
 *  plugin package (functions movements call), or a core service filling one
 *  of the host's slots. Absent: an adapter, or a plugin package when it
 *  declares `plugins`. */
export const MODULE_KINDS = ['adapter', 'plugin', 'core'] as const;
export const WireModuleKind = z.enum(MODULE_KINDS);
export type WireModuleKindShape = z.infer<typeof WireModuleKind>;

/** The host's core services a `core` module can fill. Each slot's contract
 *  is its family's contract suite (the run host's store cases for `store`,
 *  and so on); the host names one module per slot, and every slot has a
 *  default module but `loopGuard`, which stays empty unless named. */
export const CORE_SLOTS = ['models', 'judge', 'store', 'files', 'limiter', 'loopGuard'] as const;
export const WireCoreSlot = z.enum(CORE_SLOTS);
export type WireCoreSlotShape = z.infer<typeof WireCoreSlot>;

/** One construction argument the install supplies (an Airtable `base`, a
 *  Sheets `spreadsheet`): asked for when the module is set up (`lf connect`,
 *  the platform's install screen) and sent on every request (`settings`). */
export const WireModuleSetting = z.object({
  name: declaredName('a setting name'),
  label: z.string().optional(),
  /** Kept out of logs and traces; false unless said. */
  secret: z.boolean().optional(),
  optional: z.boolean().optional(),
});
export type WireModuleSettingShape = z.infer<typeof WireModuleSetting>;

/** What a declared limit is counted per: the credential a call is made as
 *  (one user's grant), the module across every install of it on the host,
 *  one install of it, or one team's installs. */
export const LIMIT_SCOPES = ['credential', 'module', 'install', 'team'] as const;
export const WireLimitScope = z.enum(LIMIT_SCOPES);
export type WireLimitScopeShape = z.infer<typeof WireLimitScope>;

/** A duration, a whole number and its unit: `500ms`, `10s`, `1m`, `1h`, `1d`. */
export const WireLimitDuration = z.string().regex(/^[1-9][0-9]*(ms|s|m|h|d)$/, 'a duration: a whole number and ms, s, m, h or d');

/** One limit the provider puts on calls, declared so the host's limiter
 *  slot can keep to it: at most `calls` per `per`, and at most `concurrent`
 *  at once, counted per `scope`. The declaration describes the provider, not
 *  a limiter: the host's limiter (in process, or a shared one) reads it from
 *  each request, so no limiter needs the manifest. */
export const WireDeclaredLimit = z
  .object({
    scope: WireLimitScope,
    calls: z.number().int().positive().optional(),
    per: WireLimitDuration.optional(),
    concurrent: z.number().int().positive().optional(),
  })
  .superRefine((limit, ctx) => {
    if ((limit.calls === undefined) !== (limit.per === undefined)) {
      ctx.addIssue({ code: 'custom', message: '`calls` and `per` go together' });
    }
    if (limit.calls === undefined && limit.concurrent === undefined) {
      ctx.addIssue({ code: 'custom', message: 'a limit declares `calls` and `per`, or `concurrent`, or both' });
    }
  });
export type WireDeclaredLimitShape = z.infer<typeof WireDeclaredLimit>;

export const WireModuleDeclarations = z.object({
  kind: WireModuleKind.optional(),
  /** The slot a `core` module fills; only with `kind: core`. */
  slot: WireCoreSlot.optional(),
  settings: z.array(WireModuleSetting).optional(),
  /** The module asks the host's models (`POST …/models`, the models slot). */
  hostModels: z.boolean().optional(),
  credentials: z.array(WireCredentialDeclaration).optional(),
  inbound: WireInboundDeclaration.optional(),
  poll: WirePollDeclaration.optional(),
  periodic: z.array(WirePeriodicDeclaration).optional(),
  plugins: WirePluginsDeclaration.optional(),
  /** The provider's limits on calls (an adapter's API, a models provider's). */
  limits: z.array(WireDeclaredLimit).optional(),
});
export type WireModuleDeclarationsShape = z.infer<typeof WireModuleDeclarations>;

/** A declaration and the method that answers it go together: a host would
 *  otherwise schedule a call nobody answers, or never schedule one that is
 *  answered. */
export function refuseUnpairedDeclarations(
  manifest: WireModuleDeclarationsShape & { methods: string[] },
  ctx: z.RefinementCtx,
): void {
  const lists = new Set(manifest.methods);
  const pair = (declared: boolean, method: string, declaration: string) => {
    if (declared && !lists.has(method)) {
      ctx.addIssue({ code: 'custom', path: ['methods'], message: `declares \`${declaration}\` but does not list \`${method}\` in methods` });
    } else if (!declared && lists.has(method)) {
      ctx.addIssue({ code: 'custom', path: [declaration], message: `lists \`${method}\` in methods but declares no \`${declaration}\`` });
    }
  };
  pair(manifest.poll !== undefined, 'poll', 'poll');
  pair((manifest.periodic ?? []).length > 0, 'runPeriodic', 'periodic');
  pair(manifest.plugins !== undefined, 'invokePlugin', 'plugins');
  // Refreshing is optional for a declared credential (the host refreshes an
  // OAuth 2 one itself), but there is nothing to refresh without one.
  if (lists.has('refreshCredential') && (manifest.credentials ?? []).length === 0) {
    ctx.addIssue({ code: 'custom', path: ['credentials'], message: 'lists `refreshCredential` in methods but declares no `credentials`' });
  }
  const unique = (names: string[], path: string) => {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) ctx.addIssue({ code: 'custom', path: [path], message: `\`${name}\` is declared twice` });
      seen.add(name);
    }
  };
  if (manifest.kind === 'core' && manifest.slot === undefined) {
    ctx.addIssue({ code: 'custom', path: ['slot'], message: 'declares `kind: core` but names no `slot`' });
  } else if (manifest.kind !== 'core' && manifest.slot !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['slot'], message: 'names a `slot` but is not `kind: core`' });
  }
  unique((manifest.credentials ?? []).map((credential) => credential.name), 'credentials');
  unique((manifest.settings ?? []).map((setting) => setting.name), 'settings');
  unique((manifest.periodic ?? []).map((task) => task.name), 'periodic');
  unique((manifest.plugins?.plugins ?? []).map((plugin) => plugin.name.replace(/-/g, '_')), 'plugins');
}

export const WireManifestResult = z.object({
  ...WireListenDeclarations.shape,
  ...WireModuleDeclarations.shape,
  protocolVersion: WireManifestProtocolVersion,
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
}).superRefine(refuseUnpairedDeclarations);
export type WireManifestResultShape = z.infer<typeof WireManifestResult>;

// ── Streaming page shapes ────────────────────────────────────────────────────

export const RelatedPage = z.object({
  items: z.array(WireRelatedResult),
  nextCursor: z.unknown().optional(),
});
export type RelatedPageShape = z.infer<typeof RelatedPage>;

// ── Event seams (preprocessInbound / listEventTypes) ─────────────────────────

export const WireDiscriminableEvent = z.object({
  payload: z.unknown(),
  /** The provider's own id for this occurrence: a host that sees one key
   *  twice (a redelivery, an overlapping poll) runs it once. */
  idempotencyKey: z.string().min(1).optional(),
  externalId: z.string().optional(),
  tag: z.string().optional(),
  actor: WireActor.optional(),
  occurredAt: z.string().optional(),
  changeType: z.enum(['create', 'update', 'delete']).optional(),
  eventType: z.string().optional(),
  recordType: z.string().optional(),
  changedFields: z.array(z.string()).optional(),
});

/** The most items one push to either host door may carry; a larger set is
 *  split by its sender. */
export const ADAPTER_DOOR_MAX_BATCH = 1000;

/** The bodies the host's two push doors accept — shared with the conformance
 *  CLI's host double so a vendor is checked against the door's own shapes. */
export const AdapterEmitBody = z.object({
  events: z.array(WireDiscriminableEvent).min(1).max(ADAPTER_DOOR_MAX_BATCH),
});
export const AdapterWakeBody = z.object({
  keys: z.array(z.string().min(1)).min(1).max(ADAPTER_DOOR_MAX_BATCH),
});

/** The models door a module declaring `hostModels` calls
 *  (`POST {host}/api/public/adapter/{adapterType}/models`, authenticated as
 *  the push doors are): one model call, made by the host's models slot.
 *  `schema` (a JSON schema) asks for the reply as data, by one forced tool
 *  call named `toolName`. */
export const HostModelRequest = z.object({
  label: z.string().min(1),
  system: z.string(),
  userMessage: z.string(),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  toolName: z.string().optional(),
  toolDescription: z.string().optional(),
});
export type HostModelRequestShape = z.infer<typeof HostModelRequest>;

/** The models door's answer: the text (or `data`, for a `schema` request)
 *  and what it cost. The door bills nothing to a run itself: the module adds
 *  `cost` to the `cost` of the response whose work asked it, so the run that
 *  made that call is charged. */
export const HostModelAnswer = z.object({
  text: z.string(),
  data: z.unknown().optional(),
  cost: z.array(WireCostLine),
});
export type HostModelAnswerShape = z.infer<typeof HostModelAnswer>;

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

// ── Event subscriptions (mirror `EnsureEventSubscriptionInput` & co.) ───────

export const WireEnsureEventSubscriptionInput = z.object({
  events: z.array(z.string()),
  callbackUrl: z.string(),
  current: z
    .object({ externalId: z.string().optional(), events: z.array(z.string()) })
    .optional(),
  scope: z.record(z.string(), z.string()).optional(),
});

export const WireEventSubscriptionRegistration = z.object({
  externalId: z.string().optional(),
  secret: z.string().optional(),
});

export const WireRemoveEventSubscriptionInput = z.object({
  callbackUrl: z.string(),
  externalId: z.string().optional(),
  scope: z.record(z.string(), z.string()).optional(),
});

// ── Await (the awaitable capability over the wire) ───────────────────────────

export const WireAwaitPoint = z.object({
  recordId: z.string(),
  edge: z.string(),
  headData: z.record(z.string(), z.unknown()).optional(),
});

export const WireAwaitLanding = z.object({
  recordId: z.string().optional(),
  recordType: z.string().optional(),
  fields: z.record(z.string(), z.unknown()),
});

/**
 * What an awaited edge resolves to now. A pending answer names the
 * correlation key the adapter will later `wake` with — the engine keeps the
 * key → parked-run map, so the adapter never writes the engine's tables. A
 * landed answer names it too, for when no landing passes the await's WHERE
 * and the engine has to keep waiting.
 */
export const WireAwaitResolution = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), correlationKey: z.string() }),
  z.object({
    status: z.literal('landed'),
    landings: z.array(WireAwaitLanding),
    correlationKey: z.string(),
  }),
  z.object({ status: z.literal('empty') }),
]);
export type WireAwaitResolutionShape = z.infer<typeof WireAwaitResolution>;

// ── Plugins (invokePlugin) ───────────────────────────────────────────────────

export const WirePluginResult = z.object({
  text: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  records: z.array(z.record(z.string(), z.unknown())).optional(),
  outcome: z.string().optional(),
  costMicrodollars: z.number().int().nonnegative().optional(),
});
export type WirePluginResultShape = z.infer<typeof WirePluginResult>;

// ── Method registry ──────────────────────────────────────────────────────────
// One entry per protocol method, each describing its params + result schema.
// The client and server share this; adding a method is one entry. The server
// validates every request's params against its entry before dispatch (a
// mismatch answers `bad_request` naming the method and the offending path);
// the client validates every result.

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
  // `describe` deliberately — a server that accepted a position and ignored it
  // would be indistinguishable from one honouring it, and the caller would get
  // a plausible type-wide descriptor either way. Presence in `methods[]` is a
  // checkable signal; a silently-ignored param is not.
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
  // One bounded page of a traversal: the server returns `nextCursor` while
  // more remain and the client echoes it back. Preferred over `iterateRelated`
  // when advertised. A server whose adapter can only stream answers one page
  // with no `nextCursor` (the reference kit caps it at 1,000 items).
  iterateRelatedPage: {
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
  linkRecords: {
    params: WireLinkRecordsInput,
    result: z.object({ created: z.boolean() }),
  },
  unlinkRecords: {
    params: WireLinkRecordsInput,
    result: z.object({ removed: z.boolean() }),
  },
  ensureEventSubscription: {
    params: WireEnsureEventSubscriptionInput,
    // `null` is the documented no-op: nothing was registered.
    result: WireEventSubscriptionRegistration.nullable(),
  },
  removeEventSubscription: {
    params: WireRemoveEventSubscriptionInput,
    result: z.null(),
  },
  resolveAwait: {
    params: WireAwaitPoint,
    result: WireAwaitResolution,
  },
  // The correlation keys an inbound payload resolves — the same keys a
  // pending `resolveAwait` returned — so the host can wake the parked runs.
  wakeKeys: {
    params: z.object({ raw: z.unknown() }),
    result: z.array(z.string()),
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
    // Remote adapters serve bytes by URL; the client fetches. The answer is a
    // URL the client turns into a stream — bytes never cross the envelope. A
    // file with no URL to give answers `method_not_implemented`.
    result: z.object({ url: z.string(), contentType: z.string().optional() }),
  },
  invokeFieldFunction: {
    params: WireInvokeFieldFunctionInput,
    result: z.unknown(),
  },
  // Module methods (within version 2; each paired with its manifest
  // declaration, see `refuseUnpairedDeclarations`).
  // One solicited pull of a polled source: `config` is the listen's options,
  // `checkpoint` whatever the previous poll returned (absent the first time).
  poll: {
    params: z.object({ config: z.unknown(), checkpoint: z.unknown().optional() }),
    result: z.object({
      events: z.array(WireDiscriminableEvent),
      checkpoint: z.unknown().optional(),
    }),
  },
  // Refresh the request's `credential` when the host's own OAuth 2 refresh
  // does not fit the provider. The host serialises it per credential. The
  // answer is the changed fields, which the host writes back.
  refreshCredential: {
    params: z.object({}),
    result: z.object({ fields: WireCredentialFields }),
  },
  // One run of a declared periodic task, for one install.
  runPeriodic: {
    params: z.object({ name: z.string().min(1) }),
    result: z.null(),
  },
  // One call of a declared plugin. `config` is the author's arguments, by
  // name; `extractedContext` the fields extracted so far when the plugin runs
  // inside a `through [ … ]` stage (empty otherwise). The answer is what the
  // plugin added: fetched `text` to extract from, `data` fields, `records`
  // (one per thing it fetched, for a records output), an `outcome` in its own
  // words for the trace, and `costMicrodollars`, what its own work cost that
  // nothing else priced.
  invokePlugin: {
    params: z.object({
      name: z.string().min(1),
      config: z.record(z.string(), z.unknown()),
      extractedContext: z.record(z.string(), z.unknown()),
    }),
    result: WirePluginResult,
  },
} as const;

export type MethodName = keyof typeof METHODS;
