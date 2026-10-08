// Knowledge-graph adapter — the graph as a system the engine reaches, on the
// same `Adapter` contract as every external one.
//
// It used to reach the graph by writing SQL against `knowledge.*` in this
// process. It does not any more: after D25 the graph is another optional
// system, so its READS go over HTTP to `/v1/knowledge/graph/*` with a stored
// credential, exactly as `native_valuations` does. What is left in here is what
// an adapter is FOR — translating the program's natural names into the wire's
// ids and back — rather than a privileged shortcut into somebody else's tables.
//
// Two consequences worth knowing before reading:
//
//   - **Every schema question is one cached ontology response.** Entry points,
//     `describe`, the name↔id maps and the dedup rules are all projections of
//     it, so a walk costs one round trip rather than one per type.
//   - **Ids are the wire currency, names are the program's** (K-5). The
//     translation happens on the first line of each method, and an ontology
//     UUID never rides a position.

import { z } from 'zod';
import { hydrateTargets, typeAddressedPositions, uniformWalk } from './hop';
import { KNOWLEDGE_GRAPH_HANDBOOK_SECTION } from './knowledge_graph_handbook_section';
import type { EdgesFromResult } from '../adapter';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { ResourceId } from '../../../generated/kysely/knowledge/Resource';
import type { NodeTypeId } from '../../../generated/kysely/knowledge/NodeType';
import PropertyValueType from '../../../generated/kysely/knowledge/PropertyValueType';
import PropertyCardinality from '../../../generated/kysely/knowledge/PropertyCardinality';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { getKnowledgeQb } from '../../../lib/kysely';
import { mutationDelivery } from '../../knowledge/mutation_outbox/delivery_mode';
import {
  KgOntologyCache,
  kgFetch,
  kgFetchOrNull,
  loadKgCredentials,
  type KgCredentials,
  type WireEdgeType,
  type WireOntology,
  type WirePropertyType,
} from './kg_client';
import {
  deregisterKnowledgeWebhook,
  registerKnowledgeWebhook,
} from './knowledge_graph_webhook';
import type {
  Adapter,
  RuntimeCapabilities,
  AdapterManifest,
  DedupConstraint,
  DedupRules,
  DiscriminableEvent,
  EnsureEventSubscriptionInput,
  EventSubscriptionRegistration,
  RemoveEventSubscriptionInput,
  ExternalRecordRef,
  DeleteInput,
  DeleteResult,
  FieldEvidence,
  GetFieldValueInput,
  GetRelatedInput,
  LinkRecordsInput,
  LinkRecordsResult,
  ParentLink,
  UnlinkRecordsInput,
  UnlinkRecordsResult,
  RelatedResult,
  ResolveEntityInput,
  ResolveEntityResult,
  Resource,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from '../adapter';
import { RESOURCES_REFERENCE_FIELD_ID, writeParentLinks } from '../adapter';
import { recordMutationEventSchema } from '../triggers/record_mutation_event';
import {
  ADAPTER_META_TYPE_ID,
  META_RECORD_TYPE,
  isStablePosition,
  makeStablePosition,
  makeUnstablePosition,
  positionRecordId,
  type SchemaEntryPoint,
  type SchemaFieldKind,
  type SchemaTypeDescriptor,
  type SourcePosition,
} from '../types';
import {
  createKgRecord,
  deleteKgRecord,
  linkKgRecords,
  unlinkKgRecords,
  updateKgRecord,
  type WriteConnection,
} from './knowledge_graph_writes';
import {
  memoizedResolver,
  naturalName,
  type AdapterNameResolver,
  type ScopedResolver,
} from './name_resolution';

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`, and
 *  IS the import name a movement constructs the graph through
 *  (`import { kg } from adapters` ⇒ `graph = kg()`). */
export const KG_ADAPTER_TYPE = 'kg';

// ── The event surface (D40) ─────────────────────────────────────────────────
// The graph publishes an EVENT ENTRY exactly like every other adapter — the
// same shape Airtable's `Record Change` has, for the same reasons. Nothing
// here is graph-specific machinery: a listen names the watched node type, the
// change kind is the event node's own `action` field, and the changed record
// is REACHED over the event's `Record` edge rather than being the event.

/** The event node's own type name. JUST A NODE: its change kind is its
 *  `action` field, narrowed in the address —
 *  `<graph-[:`Record Change` WHERE `action` == "record.created"]->>`. */
export const KG_EVENT_TYPE_NAME = 'Record Change';
/** The dispatch id for the event node (its `describe` / `getRelated` currency);
 *  the display name above is what an author writes. */
export const KG_EVENT_TYPE_ID = 'kg:record_change';
/** The event node's edge to the changed record. */
export const KG_EVENT_RECORD_EDGE = 'record';
/** Its NATURAL name — Title Case, the one convention across adapter surfaces. */
export const KG_EVENT_RECORD_EDGE_NAME = 'Record';

/**
 * The meta collection whose members are this team's node types.
 *
 * `Base`/`Table` for the graph: the node the `type:` listen hop selects a
 * member of, and the type the event's `Record` edge lands on before anything
 * says WHICH node type. Its members ride the root hop's `targetPositions`, each
 * publishing `Id` — the name a listen writes, which for the graph IS the node
 * type's identity (the ontology UUID stays adapter-private, in the structured-id
 * cache and the SQL).
 */
export const KG_NODE_TYPE_META_TYPE = 'Node Type';

/** The change kinds a `listen to <graph> { events: [...] }` subscribes to, in
 *  Listen-Fire's uniform `record.*` currency (the same names attio and airtable use,
 *  so authoring and dispatch stay adapter-neutral). */
export const KG_SUBSCRIBABLE_EVENTS = [
  'record.created',
  'record.updated',
  'record.deleted',
] as const;

/**
 * The EVENT edge off the meta node: `meta -[:`Record Change`]-> <the event>`.
 *
 * `readable: false` and that is the honest statement: nothing can enumerate the
 * changes that have happened — an event is pushed, never pulled. The edge's
 * promise is `fires`.
 */
function recordChangeEntryPoint(): SchemaEntryPoint {
  return {
    typeId: KG_EVENT_TYPE_ID,
    displayName: KG_EVENT_TYPE_NAME,
    writable: false,
    readable: false,
    fires: true,
  };
}

/**
 * The `Node Type` node, UNNARROWED — where the event's `Record` edge lands
 * before anything says WHICH node type. Honestly minimal: a record's fields
 * depend on WHICH type, so the unnarrowed node has none; the listen's `type:`
 * pin narrows it to a real type's surface.
 */
function describeNodeTypeMeta(): SchemaTypeDescriptor {
  return {
    typeId: KG_NODE_TYPE_META_TYPE,
    displayName: KG_NODE_TYPE_META_TYPE,
    description:
      'One of the types in this workspace’s data model. Which fields a record ' +
      'has depends on WHICH type — a listen’s `type:` pin narrows it to one.',
    fields: [],
    references: [],
  };
}

/**
 * The event node: the changed record's identity, and an edge to the record
 * itself. The event and the record are DIFFERENT NODES — the record is
 * reached, never conflated.
 */
function describeRecordChange(): SchemaTypeDescriptor {
  const idField = (name: string, description: string) => ({
    fieldId: name,
    displayName: name,
    kind: 'string' as const,
    writable: false,
    required: false,
    description,
  });
  return {
    typeId: KG_EVENT_TYPE_ID,
    displayName: KG_EVENT_TYPE_NAME,
    description:
      'A change to a record in this workspace’s own graph — created, updated ' +
      'or deleted. The record itself is one hop away, over `Record`.',
    fields: [
      {
        fieldId: 'action',
        displayName: 'action',
        kind: 'enum' as const,
        enumValues: [...KG_SUBSCRIBABLE_EVENTS],
        writable: false,
        required: false,
        description:
          'Which kind of change this event is — the same values a listen’s `events:` names.',
      },
      idField('type', 'The type of record that changed — the name a `listen` names.'),
      idField('record', 'The changed record’s id.'),
    ],
    references: [
      {
        fieldId: KG_EVENT_RECORD_EDGE,
        name: KG_EVENT_RECORD_EDGE_NAME,
        targetTypeId: KG_NODE_TYPE_META_TYPE,
        cardinality: 'one' as const,
        description: 'The record that changed.',
        // THE hop from the event to what it is about (D40(b)) — declared, so a
        // listen's `fields:` names properties of the record rather than of the
        // event node, without anything having to recognise the name `Record`.
        subject: true,
        // Reached, never written along: a movement writes to a TYPE, not
        // through an event.
        writable: false,
        // A deleted record can no longer be hydrated, so a listen narrowed to
        // `record.deleted` drops this edge rather than offering a dead walk.
        requiresLiveRecord: true,
      },
    ],
  };
}

/** The envelope the drainer delivers, whichever path it takes. Parsed rather
 *  than trusted: an inbound body is somebody else's claim until it typechecks. */
const mutationEnvelopeSchema = z.object({
  event: z.enum([...KG_SUBSCRIBABLE_EVENTS]),
  timestamp: z.string(),
  data: z.object({
    recordId: z.string(),
    nodeTypeId: z.string(),
    changeKind: z.enum(['create', 'update', 'delete']),
    changedFields: z.array(z.string()),
    context: z.record(z.string(), z.unknown()),
  }),
});

const CHANGE_TYPE_BY_EVENT: Record<
  (typeof KG_SUBSCRIBABLE_EVENTS)[number],
  'create' | 'update' | 'delete'
> = {
  'record.created': 'create',
  'record.updated': 'update',
  'record.deleted': 'delete',
};

/** One property type as a schema field. Node-anchored and edge-anchored
 *  property types describe identically — an anchor is a write-routing fact,
 *  not a difference in what the field IS — so both go through here and the
 *  edge-anchored caller adds its marker on top. */
function propertyField(pt: WirePropertyType): SchemaTypeDescriptor['fields'][number] {
  return {
    fieldId: pt.id,
    displayName: pt.name,
    kind: mapPropertyValueTypeToFieldKind(pt.valueType),
    enumValues: pt.enumValues ?? undefined,
    writable: true,
    required: false,
    cardinality: pt.cardinality === PropertyCardinality.multi ? ('many' as const) : ('one' as const),
  };
}

/** Synthetic target type for the `#resources` reference — a `node_resource`
 *  attachment surfaced as a resource position. The id IS the natural display
 *  name: it rides schema edge targets and landed positions, both agent-visible
 *  surfaces (the leakage audit's rule — an id that can surface must read as a
 *  name, never as adapter plumbing). */
export const KG_RESOURCE_TYPE_ID = 'Attached Resource';

/**
 * Fold a candidate's adjacency context into its `data` bag as ordinary
 * entries (3b §3.1) — `<edge name>: <neighbour>` — so the flat
 * `ExternalRecordRef` currency carries the connections the LLM judge uses
 * to disambiguate, without a separate `relationships` field. Multiple
 * neighbours on the same edge join with `, `; edge-attached properties
 * render inline.
 */
function foldRelationshipsIntoData(
  properties: Record<string, unknown>,
  relationships:
    | { edgeName: string; targetName: string; edgeProperties?: Record<string, unknown> }[]
    | undefined,
): Record<string, unknown> {
  if (!relationships || relationships.length === 0) return properties;
  const data: Record<string, unknown> = { ...properties };
  for (const rel of relationships) {
    const props =
      rel.edgeProperties && Object.keys(rel.edgeProperties).length > 0
        ? ` (${Object.entries(rel.edgeProperties)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')})`
        : '';
    const rendered = `${rel.targetName}${props}`;
    const existing = data[rel.edgeName];
    data[rel.edgeName] =
      existing === undefined ? rendered : `${existing}, ${rendered}`;
  }
  return data;
}

/**
 * The KG's whole-adapter capability — the richest of any adapter: it traverses
 * BOTH directions, carries edge properties, and exposes resources. Per-edge /
 * per-field capability rides `describe()`; the broad expression-kind / operator
 * / aggregation surface is no longer adapter-declared.
 */
const KG_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  traversal: { incoming: true, edgeProperties: true },
  resources: true,
};

/**
 * The subscription half of the contract, declared only where it is real.
 *
 * D39(c): a deployment has EXACTLY ONE delivery path. Composed delivers
 * in-process, so there is nothing to register and advertising the methods would
 * make `syncListenSubscriptions` provision a webhook the drainer will never
 * post to — a subscription that looks live and never fires, which is precisely
 * the silently-dead state `canFire` exists to prevent. Standalone is the
 * opposite: automations is a different process, so the webhook IS the delivery.
 *
 * The manifest is where that shows, because the manifest is what the
 * reconciler reads. No new gate was added for it.
 */
const SUBSCRIPTION_METHODS =
  mutationDelivery() === 'webhook'
    ? (['ensureEventSubscription', 'removeEventSubscription'] as const)
    : ([] as const);

/**
 * Static manifest — the construction-free declaration the registry exposes via
 * `getAdapterManifest`. `createRecord`/`updateRecord`/`deleteRecord` are
 * genuine writes; `linkRecords`/`unlinkRecords` assert and sever edges between
 * existing nodes.
 *
 */
export const KG_MANIFEST: AdapterManifest = {
  adapterType: KG_ADAPTER_TYPE,
  displayName: 'Knowledge Graph',
  description:
    "Listen-Fire's own store — the structured records your data model defines. " +
    'Movements can read it, write to it, and run whenever something in it changes.',
  supportedTriggers: ['mutation'],
  methods: [
    'listEntryPoints', 'describe', 'resolveEntity', 'getDedupRules',
    'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'deleteRecord',
    'linkRecords', 'unlinkRecords',
    // Echo-authorship capability — gates the opt-in `suppress_self` listen
    // flag (the KG answers from its own mutation-context provenance).
    'didWeAuthor',
    'preprocessInbound',
    ...SUBSCRIPTION_METHODS,
  ],
  // The graph is reached over HTTP with a stored credential, like every other
  // system (D25) — which is also what makes it OPTIONAL: a team with no
  // connection simply has no `kg` in its catalog, because the registry's
  // presence gate reads this. `intrinsic` because there is no third party to
  // sign in to: the server provisions the key against the configured instance.
  // `connect: 'intrinsic'` is not stated here — it is DERIVED from the type
  // having an intrinsic provisioner (`connectKindForType`), so the two cannot
  // disagree about whether one-click provisioning exists.
  requiredCredentialType: ExternalServiceType.NATIVE_KNOWLEDGE,
  triggerKinds: ['KG_MUTATION'],
  // The change kinds a listen subscribes to, in the platform's uniform
  // `record.*` currency (D40) — ONE namespace with attio and airtable, and the
  // same values the event node's `action` field enumerates.
  subscribableEvents: [...KG_SUBSCRIBABLE_EVENTS],
  // The graph's model is per-team and user-editable, so describing an instance
  // is a live read of THIS team's ontology rather than a static constant.
  introspectedSchema: true,
  // `type` is the ADDRESS of the record the event's `Record` edge lands on: a
  // listen is shorthand for a WHERE, so naming the watched type here is what
  // narrows the edge, and the author never restates it in the movement. It
  // matches on `Id`, which for the graph IS the node type's name — the
  // framework identity the entry points publish (the ontology UUID never rides
  // a position). `fields` is the changed-attribute filter: bare property names
  // of the watched type. `events` needs no entry — `subscribableEvents`
  // projects it — and `suppress_self` is universal, validated centrally for
  // every adapter, so neither is declared here.
  listenConfig: [
    {
      key: 'type',
      required: true,
      narrows: { collection: KG_NODE_TYPE_META_TYPE, matchField: 'Id' },
    },
    { key: 'fields', format: 'fields' },
  ],
  triggerExpectation:
    "Fires when a record in the team's Listen-Fire knowledge graph is created, " +
    'updated or deleted — whether a user edited it, an agent wrote it, or ' +
    'ANOTHER MOVEMENT wrote it. That last case can loop a movement that ' +
    'both listens to and writes the same types: narrow the listen to ' +
    'specific types/changes, and use suppress_self where the movement ' +
    'should ignore its own writes.',
  handbookSection: KNOWLEDGE_GRAPH_HANDBOOK_SECTION,
  vocabulary: {
    // No brand mark — the KG is intrinsic, not a third-party system.
    eventPhrase: {
      // No per-event phrasing today (create/update/delete all shared one
      // generic sentence in the former switch) — `default` mirrors that.
      default: [{ template: 'When data changes in your knowledge graph' }],
    },
  },
};

export class KnowledgeGraphAdapter implements Adapter {
  readonly adapterType = KG_ADAPTER_TYPE;
  readonly supportedTriggers = KG_MANIFEST.supportedTriggers;

  runtimeCapabilities(): RuntimeCapabilities {
    return KG_RUNTIME_CAPABILITIES;
  }

  private readonly teamId: TeamId;
  private readonly credentialsId: string | undefined;

  constructor(input: { teamId: TeamId; credentialsId?: string }) {
    this.teamId = input.teamId;
    this.credentialsId = input.credentialsId;
    this.ontology = new KgOntologyCache(() => this.creds(), input.teamId);
  }

  /**
   * Natural-name → internal-id resolver for THIS team's ontology, memoized
   * from the KG's OWN `listEntryPoints()` / `describe()` — the same uniform
   * mechanism every adapter uses (Decision #3). The interface methods below
   * receive the program's NATURAL names (ontology node / property / edge
   * display names) and resolve them to the id currency the wire consumes, on
   * their first line, through this; the engine/host carries no KG translation.
   * The KG is NOT special — it composes the same `memoizedResolver` BaseAdapter
   * wires in (it doesn't extend BaseAdapter because its positions are kg-node,
   * not external-record).
   */
  private readonly resolver: ScopedResolver = memoizedResolver(this);

  /** This team's whole model, fetched once. Everything schema-shaped below is a
   *  projection of it. */
  private readonly ontology: KgOntologyCache;

  /**
   * The connection this instance reads through.
   *
   * A missing credential is a hard error rather than a graceful empty: the
   * graph is optional, and a team without a connection simply has no `kg` in
   * its catalog — so reaching here without one means something constructed an
   * instance it had no right to, and answering "the graph is empty" would be a
   * lie that looks like data.
   */
  private async creds(): Promise<KgCredentials> {
    if (this.credentialsId === undefined) {
      throw new Error(
        'The knowledge graph adapter has no connection. Connect Listen-Fire Knowledge for this team, then re-save the movement.',
      );
    }
    return loadKgCredentials(this.credentialsId);
  }

  // ── Name → structured-identifier cache ──────────────────────────────────
  // The framework names an ontology node type only by its pretty `name` (the
  // node type's displayName) — that IS the `recordType` every position carries
  // and the `typeId` `listEntryPoints` / `describe` publish. The wire, by
  // contrast, routes on the ontology node-type UUID, which is ALSO the FK key —
  // which is exactly WHY a rename never orphans a node. The map between the two
  // is a projection of the same ontology response that lists entry points;
  // every method that needs the id recovers it from the recordType NAME here,
  // on its first line. The id never rides a position.

  /** Resolve a node type's pretty NAME to its ontology id, or undefined when
   *  the name isn't a known node type (the caller decides graceful-empty vs
   *  hard error). */
  private async structuredIdFor(name: string): Promise<NodeTypeId | undefined> {
    const model = await this.ontology.get();
    return model.nodeTypes.find((nt) => nt.name === name)?.id as NodeTypeId | undefined;
  }

  /** The read/write variant: a name that doesn't resolve is drift — the
   *  movement targets a node type this ontology no longer exposes. */
  private async requireStructuredId(name: string, method: string): Promise<NodeTypeId> {
    const id = await this.structuredIdFor(name);
    if (!id) {
      throw new Error(`KnowledgeGraphAdapter.${method}: unrecognised node type "${name}".`);
    }
    return id;
  }

  // ── 1. Schema descriptor ────────────────────────────────────────────────
  // Generated dynamically from the ontology — node types, property types,
  // edge types. The ontology can change at runtime as agents edit the
  // customer's schema, so callers should not cache aggressively.

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    // The EVENT edge leads, and it is behind nothing: a listen HANDS you the
    // event position, so naming it must not require having walked anywhere.
    return [recordChangeEntryPoint(), ...(await this.nodeTypeEntryPoints())];
  }

  /** One entry per ontology node type — the author-facing collections. */
  private async nodeTypeEntryPoints(): Promise<SchemaEntryPoint[]> {
    const { nodeTypes } = await this.ontology.get();
    return nodeTypes.map((nt) => ({
      // The framework identity IS the pretty node-type name — the ontology UUID
      // lives only in the private structured-id cache + the SQL. `externalId`
      // keeps the raw UUID for generic consumers that key on the node type.
      typeId: nt.name,
      displayName: nt.name,
      externalId: nt.id,
      writable: true,
      readable: true,
    }));
  }

  /**
   * The knowledge graph's walk.
   *
   * Its root edges are exactly "one per ontology node type", which is the
   * entry list — so the root descriptor is derived rather than described.
   * `describe(meta)` returns null by design (the KG has no snapshot to
   * enumerate), which is why the root is built here instead.
   *
   * Targets are HYDRATED: a node type's describe reads the team's own ontology
   * out of Postgres, not somebody else's API, so the lookahead is cheap and an
   * author gets every type's fields without a hop.
   *
   */
  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    // A `Node Type` MEMBER — the node the `type:` listen hop selects. It is
    // pinned to one node type, so what is there is that type's own descriptor;
    // `uniformWalk` would describe the unnarrowed meta node instead.
    if (
      position.recordType === KG_NODE_TYPE_META_TYPE &&
      position.identity.kind === 'stable'
    ) {
      const descriptor = await this.describe(position.identity.recordId);
      if (!descriptor) return null;
      return {
        descriptor,
        ...(await this.walkTargets(descriptor)),
      };
    }
    const hop = await uniformWalk({
      adapterType: KG_ADAPTER_TYPE,
      at: position,
      root: await this.walkRoot(),
      describe: (typeId) => this.describe(typeId),
    });
    // Only the META node carries the `Node Type` members (uniformWalk's own
    // rule for "which node is this": no recordType means the root).
    const atMeta = position.recordType == null || position.recordType === META_RECORD_TYPE;
    if (!hop || !atMeta) return hop;
    return { ...hop, targetPositions: await this.rootTargetPositions(hop) };
  }

  /** What a described node's edges land on — the KG's describes are local
   *  reads, so nothing is stubbed. */
  private async walkTargets(
    descriptor: SchemaTypeDescriptor,
  ): Promise<Pick<EdgesFromResult, 'targetPositions' | 'targetNodes'>> {
    const targetPositions = typeAddressedPositions({
      adapterType: KG_ADAPTER_TYPE,
      descriptor,
    });
    const targetNodes = await hydrateTargets({
      descriptor,
      describe: (typeId) => this.describe(typeId),
    });
    return {
      ...(Object.keys(targetPositions).length > 0 ? { targetPositions } : {}),
      ...(targetNodes !== undefined ? { targetNodes } : {}),
    };
  }

  /**
   * The root's paths, with the `Node Type` MEMBERS folded in.
   *
   * The members carry no reference row of their own — they are the polymorphic
   * collection a listen's `type:` hop narrows, not an edge an author walks (the
   * node types are already root edges in their own right). `Id` addresses a
   * member the way a LISTEN does; `Name` the way the walk displays it. Both are
   * the node type's name, because for this graph that IS its identity.
   *
   * Members are filed FIRST so the type-addressed edges below them win the
   * walk's by-name memory (`filePaths` keys on the label, which a member and
   * its collection edge necessarily share): naming `Company` must reach the
   * COLLECTION of companies, not the meta node describing the type.
   */
  private async rootTargetPositions(
    hop: EdgesFromResult,
  ): Promise<Record<string, SourcePosition>> {
    const members: Record<string, SourcePosition> = {};
    for (const entry of await this.nodeTypeEntryPoints()) {
      members[`${KG_NODE_TYPE_META_TYPE}::${entry.typeId}`] = makeStablePosition({
        adapterType: KG_ADAPTER_TYPE,
        recordType: KG_NODE_TYPE_META_TYPE,
        recordId: entry.typeId,
        data: { Id: entry.typeId, Name: entry.displayName },
      });
    }
    return { ...members, ...(hop.targetPositions ?? {}) };
  }

  /** The root: what this knowledge graph IS, and an edge per node type. */
  private async walkRoot(): Promise<SchemaTypeDescriptor> {
    const entries = await this.listEntryPoints();
    return {
      typeId: META_RECORD_TYPE,
      displayName: 'Knowledge Graph',
      description:
        "Listen-Fire's own store of the things this team cares about. Every edge " +
        'here is a type in their ontology — walk one to see its fields and ' +
        'how it connects to the rest.',
      fields: [],
      references: entries.map((entry) => ({
        fieldId: entry.typeId,
        targetTypeId: entry.typeId,
        name: entry.displayName,
        cardinality: 'many' as const,
        // The entry list and the walk are the same node's edges: copy the
        // promises rather than restating them, so they cannot drift.
        ...(entry.readable !== undefined ? { readable: entry.readable } : {}),
        ...(entry.writable !== undefined ? { writable: entry.writable } : {}),
        // `fires` IS the event edge's promise, and it has to be stated on the
        // walk too — read/write both false would otherwise read as a dead edge.
        ...(entry.fires !== undefined ? { fires: entry.fires } : {}),
        // The scan pages the WHOLE collection newest-first by `(created_at,
        // id)` and reverses once (`scanNodeIds`), so the type's nodes arrive
        // oldest-first — the order they were ADDED to the graph, which is not
        // the same as any timestamp the node itself carries. WHERE / ORDER BY
        // / LIMIT are applied engine-side over that complete stream, so there
        // is no partial window to make the order a half-truth.
        sequenced: 'arrival' as const,
      })),
    };
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // KG isn't snapshot-capable today, so the meta-position has no edges
    // to enumerate. Return null and short-circuit before the UUID-typed
    // node_type query rejects the sentinel string.
    if (typeRef === ADAPTER_META_TYPE_ID) return null;
    // The event node and the meta collection its `Record` edge lands on, by
    // either spelling. Both cost nothing: an event's shape is a fact about the
    // adapter, not about the workspace.
    if (typeRef === KG_EVENT_TYPE_ID || typeRef === KG_EVENT_TYPE_NAME) {
      return describeRecordChange();
    }
    if (typeRef === KG_NODE_TYPE_META_TYPE) return describeNodeTypeMeta();
    // `Attached Resource` is the synthetic target of every node type's
    // `#resources` edge — a `node_resource` attachment surfaced as a resource
    // position, NOT an ontology node type, so `structuredIdFor` can't recover a
    // UUID for it and it would otherwise render undescribed. Its honest shape is
    // the `Resource` fields `readNodeResources` materialises onto the position
    // (`name` / `url` / `type`); a `#resources` hop is untyped in the checker
    // (`resource_traverse` degrades to silence), so this descriptor is
    // informational — the fields it lists are the real, populated ones. (The
    // lazy `document_url` / `content` are deliberately omitted: they always read
    // null today, so advertising them would be an unchecked promise.)
    if (typeRef === KG_RESOURCE_TYPE_ID) {
      return {
        typeId: KG_RESOURCE_TYPE_ID,
        displayName: KG_RESOURCE_TYPE_ID,
        description:
          'A source attached to this record — the material a fact was drawn ' +
          'from (a document, email, message, or link). Read its `Name`, `URL`, ' +
          'and `Type`.',
        fields: [
          { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false, description: 'The source\'s display name (a filename, subject line, or the URL when unnamed).' },
          { fieldId: 'url', displayName: 'URL', kind: 'string', writable: false, required: false, description: 'A link to the source, when it has one.' },
          { fieldId: 'type', displayName: 'Type', kind: 'string', writable: false, required: false, description: 'What kind of source it is — one of URL, EMAIL, WHATSAPP, FILE, TEXT.' },
        ],
        references: [],
      };
    }
    // `describe` is fed the NATURAL node-type name (the movement engine /
    // checker currency, and the entry-point `typeId` the resolver build feeds
    // back). Recover its ontology id from the model; an unknown name (drift) →
    // null. No bilingual id-passthrough — a position never carries the id, so
    // an id never lands here.
    const model = await this.ontology.get();
    const nodeType = model.nodeTypes.find((nt) => nt.name === typeRef);
    if (!nodeType) return null;
    const typeId = nodeType.id;

    const propertyTypes = model.propertyTypes.filter((pt) => pt.nodeTypeId === typeId);
    const outgoingEdges = model.edgeTypes.filter((et) => et.sourceNodeTypeId === typeId);
    const incomingEdges = model.edgeTypes.filter((et) => et.targetNodeTypeId === typeId);

    // Edge references publish their COUNTERPART type by NAME — the same
    // currency `listEntryPoints` keys on. Publishing the raw ontology id
    // (the old behaviour) never matched an entry, so every KG edge target
    // projected as an opaque UUID: agent-visible noise AND silently open
    // hop typing (the checker couldn't follow any KG edge).
    const nameByNodeTypeId = new Map(model.nodeTypes.map((nt) => [nt.id, nt.name]));
    const counterpartName = (id: string): string => nameByNodeTypeId.get(id) ?? id;

    // Edge properties (KG-only — adapters don't model edge attributes
    // natively). Surfaced two ways from the same source rows:
    //
    //   1. On each reference's `edgeFields` — drives `edge.X`
    //      autocomplete + the `edge_property` evaluator on the read
    //      side (W3).
    //   2. As writable fields on the action's `fields` array with an
    //      `anchor: { kind: 'edge', edgeTypeId, side }` marker (W4-KG3).
    //      The write path inspects the marker and routes the value to
    //      `property.edge_id` instead of `property.node_id`. Authors
    //      pick the field the same way as a node property — the
    //      anchor marker is an internal write-routing concern.
    const allEdgeIds = new Set([
      ...outgoingEdges.map((e) => e.id),
      ...incomingEdges.map((e) => e.id),
    ]);
    const edgePropertyTypes = model.propertyTypes.filter(
      (pt) => pt.edgeTypeId !== null && allEdgeIds.has(pt.edgeTypeId),
    );
    const edgeFieldsByEdgeTypeId = new Map<string, SchemaTypeDescriptor['fields']>();
    for (const pt of edgePropertyTypes) {
      const edgeId = pt.edgeTypeId;
      if (!edgeId) continue;
      const arr = edgeFieldsByEdgeTypeId.get(edgeId) ?? [];
      arr.push(propertyField(pt));
      edgeFieldsByEdgeTypeId.set(edgeId, arr);
    }

    // W4-KG3 — promote edge-property fields into the action's
    // writable-fields list with an anchor marker. `side` records which
    // end of the edge type this node type sits on (target for outgoing
    // references, source for incoming ones) so the write path can
    // disambiguate edges that connect two instances of the same node
    // type via different edge types.
    const edgeAnchoredFields: SchemaTypeDescriptor['fields'] = [];
    for (const et of outgoingEdges) {
      for (const pt of edgePropertyTypes.filter((p) => p.edgeTypeId === et.id)) {
        edgeAnchoredFields.push({
          ...propertyField(pt),
          anchor: { kind: 'edge', edgeTypeId: et.id, side: 'source' },
        });
      }
    }
    for (const et of incomingEdges) {
      for (const pt of edgePropertyTypes.filter((p) => p.edgeTypeId === et.id)) {
        edgeAnchoredFields.push({
          ...propertyField(pt),
          anchor: { kind: 'edge', edgeTypeId: et.id, side: 'target' },
        });
      }
    }

    // Native uniqueness — the wire already publishes the PROJECTED form (the
    // stored expression grammar is knowledge's own and never leaves it), so all
    // that happens here is the rename to the adapter's NATURAL names (property
    // displayName / edge `outboundName` — the same names `describe`'s
    // fields/references publish). The descriptor keeps ids adapter-private
    // (Decision #6): the engine merges these natural-named constraints with the
    // author's `unique by` (also natural) and hands the uniform set back to
    // `resolveEntity`, which translates the whole set through this instance's
    // own resolver.
    const propertyNameById = new Map<string, string>(
      propertyTypes.map((pt) => [pt.id, pt.name]),
    );
    const edgeNameById = new Map<string, string>([
      ...outgoingEdges.map((et) => [et.id, et.outboundName] as const),
      ...incomingEdges.map((et) => [et.id, et.inboundName] as const),
    ]);
    const uniquenessConstraints = {
      any: nodeType.uniquenessConstraints.any.map((branch) => ({
        all: branch.all.map((entry) => ({
          ...entry,
          field: propertyNameById.get(entry.field) ?? edgeNameById.get(entry.field) ?? entry.field,
        })),
      })),
    };

    return {
      // The descriptor's framework identity is the node-type NAME, matching the
      // entry point — the ontology UUID stays adapter-private (cache + SQL).
      typeId: nodeType.name,
      displayName: nodeType.name,
      uniquenessConstraints,
      // The graph resolves fuzzy uniqueness components by trigram similarity
      // (the store's `identity` search), so authors may mark a `unique by`
      // component FUZZY against any node type.
      supportsFuzzyResolution: true,
      // No KG field is ever required — the KG is forgiving by design: a
      // partial record is still knowledge. De-duplication is the
      // uniqueness constraints' job; `property_type.identity` is legacy
      // and deliberately ignored here.
      fields: [...propertyTypes.map(propertyField), ...edgeAnchoredFields],
      // KG edges are bidirectional: each edge_type publishes an outgoing
      // reference on its source type (named by `outboundName`) and an
      // incoming reference on its target type (named by `inboundName`).
      // The editor lists both so authors can say `-[:employs]-> Person`
      // or `-[:works_for]-> Company` from People's side; the runtime
      // resolves the edge by id + direction. Edge properties hang off
      // each reference via `edgeFields` regardless of direction.
      //
      // EVERY ontology edge is writable, in BOTH directions: the write path
      // resolves an edge by name against `outboundName` (outgoing) OR
      // `inboundName` (incoming) — `resolveParentLinkEdgeType` tries both —
      // and that one resolver backs all three write shapes: the linked create
      // (`createKgRecord` inserts the connecting edge in the node's own
      // transaction), the standalone assert (`linkKgRecords`) and its inverse
      // (`unlinkKgRecords`). Nothing about an edge type gates any of them, so
      // there is no read-only ontology edge to carve out. (The `#resources`
      // edge below is the exception, and declares nothing — see there.)
      references: [
        ...outgoingEdges.map((et) => ({
          fieldId: et.id,
          targetTypeId: counterpartName(et.targetNodeTypeId),
          cardinality: 'many' as const,
          direction: 'outgoing' as const,
          name: et.outboundName,
          writable: true,
          edgeFields: edgeFieldsByEdgeTypeId.get(et.id),
        })),
        ...incomingEdges.map((et) => ({
          fieldId: et.id,
          targetTypeId: counterpartName(et.sourceNodeTypeId),
          cardinality: 'many' as const,
          direction: 'incoming' as const,
          name: et.inboundName,
          writable: true,
          // A scoping edge (`edge_type.scopes`) is part of the scoped
          // type's identity — the scoped (target) type cannot exist
          // without it, so ITS reference declares the requirement.
          ...(et.scopes === true ? { required: true } : {}),
          edgeFields: edgeFieldsByEdgeTypeId.get(et.id),
        })),
        {
          // Resources (`#resources`) — `node_resource` attachments as
          // resource positions. The engine's `#resources` meta-edge /
          // `resource_traverse` walk this; resolved in `getRelated` (P12,
          // replacing the retired `getResources`).
          //
          // READ-ONLY (no `writable`) — and alone among KG edges in that. It is
          // not an ontology edge type, so the write path's edge resolution
          // cannot see it: a linked write along `#resources` would reach
          // `resolveParentLinkEdgeType` and throw on the sentinel. Resources
          // are attached as PROVENANCE of a record write — the `Resources`
          // slot on the create/update input, persisted by `persistKgResources`
          // against the node — never by walking a relationship to a target
          // that is then created or linked.
          fieldId: RESOURCES_REFERENCE_FIELD_ID,
          targetTypeId: KG_RESOURCE_TYPE_ID,
          cardinality: 'many' as const,
          direction: 'outgoing' as const,
          name: 'Resources',
        },
      ],
    };
  }


  // ── 2. Entity resolution ────────────────────────────────────────────────
  // Two stages, lowest-cost first:
  //   1. Match KG nodes by linked_object bridge. Candidates come pre-filtered
  //      by (team, source-adapter, source-recordId); narrow by node_type to
  //      disambiguate when one external record bridges to multiple node types
  //      (e.g. an Attio Company linked to both a KG Organisation and a KG
  //      Deal).
  //   2. If no bridge match, search by the target node type's
  //      `uniqueness_constraints` — the same OR-of-AND rules used by
  //      consolidate.ts to dedup extracted nodes. This catches "Attio
  //      webhook for an Acme that already exists in the KG, no bridge
  //      yet" without any TG-side identity flag: identity is whatever the
  //      ontology says it is. On match, the engine's apply step writes a
  //      linked_object so future events hit (1).
  //
  // For KG-as-target the engine's "externalId" is the KG node id (not the
  // linked_object.external_id, which holds the *source's* id) — set it
  // explicitly so the engine uses the right value when calling updateRecord.

  async resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    // Translate the program's NATURAL currency (node-type / property / edge
    // display names) to the ontology UUIDs the search SQL consumes — on the
    // first line, through this instance's own resolver (Decision #3). The
    // node-type name, the constraint fields (property OR edge names) and the
    // record keys all rename here; the engine/host did none of it.
    const resolver = await this.resolver({ types: [input.recordType] });
    const nodeTypeId = await this.requireStructuredId(input.recordType, 'resolveEntity');
    const internal = this.toInternalResolveCurrency({
      typeName: input.recordType,
      record: input.record,
      constraints: input.constraints,
      resolver,
    });

    const bridgeMatch = await this.resolveByBridge(input, nodeTypeId);
    if (bridgeMatch) return bridgeMatch;
    return this.resolveByConstraints({
      nodeTypeId,
      record: internal.record,
      constraints: internal.constraints,
    });
  }

  /**
   * Rename a resolve's NATURAL constraint fields + record keys to the KG's
   * internal UUID currency. A constraint field is a property name first, else
   * an edge name (the property-then-edge order the engine's `unique by`
   * lowering and `describe`'s native-constraint projection both follow); the
   * record carries scalar property values (keyed by property name) and folded
   * edge neighbours (`{ id }`, keyed by edge name) the engine added for
   * edge-scoped compound identity. Unknown names fall through to drift via the
   * search (an internal id that doesn't match any property/edge row matches
   * nothing) — the resolver's `try*` variants keep the rename non-throwing so a
   * field that's genuinely a folded edge isn't mis-flagged as a missing
   * property.
   */
  private toInternalResolveCurrency(input: {
    typeName: string;
    record: Record<string, unknown>;
    constraints: ResolveEntityInput['constraints'];
    resolver: AdapterNameResolver;
  }): { record: Record<string, unknown>; constraints: ResolveEntityInput['constraints'] } {
    const { resolver } = input;
    const type = naturalName(input.typeName);
    // Property first, else edge — the property-then-edge order the engine's
    // `unique by` lowering and the native-constraint projection both follow.
    // An edge constraint scopes identity by adjacency to a folded neighbour;
    // it resolves to the edge's write name (the same currency the engine's
    // edge-scoped fold + the parentLink use), which `searchKgCandidatesByUniqueness`
    // matches against. An edge declared on the parent (not this child type)
    // has no reverse map here and stays its natural name — preserved verbatim,
    // exactly as the prior engine threaded it.
    const internalFieldName = (name: string): string =>
      resolver.tryFieldId(type, naturalName(name)) ??
      resolver.tryEdgeWriteName(type, naturalName(name)) ??
      name;
    const record: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(input.record)) {
      record[internalFieldName(name)] = value;
    }
    const constraints = {
      any: input.constraints.any.map((branch) => ({
        all: branch.all.map((entry) => ({
          ...entry,
          field: internalFieldName(entry.field),
        })),
      })),
    };
    return { record, constraints };
  }

  private async resolveByBridge(
    input: ResolveEntityInput,
    nodeTypeId: NodeTypeId,
  ): Promise<ResolveEntityResult | null> {
    if (input.candidates.length === 0) return null;
    const batch = await kgFetch<{ data: { id: string; nodeTypeId: string }[] }>(
      await this.creds(),
      {
        method: 'POST',
        path: '/nodes/batch',
        body: { ids: input.candidates.map((c) => c.node_id), team: this.teamId },
      },
    );
    // Narrow by node type: one external record can bridge to several node types
    // (an Attio Company linked to both an Organisation and a Deal), and the
    // bridge alone does not say which of them this write is about.
    const matching = batch.data.filter((n) => n.nodeTypeId === nodeTypeId);
    if (matching.length === 0) return null;
    // For KG-as-target the node id IS the external id (the bridge keys off
    // it). A single bridge hit is the unambiguous match.
    const id = matching[0].id;
    return {
      candidates: [{ adapterType: KG_ADAPTER_TYPE, externalId: id, data: {} }],
    };
  }

  private async resolveByConstraints(input: {
    nodeTypeId: NodeTypeId;
    record: Record<string, unknown>;
    constraints: ResolveEntityInput['constraints'];
  }): Promise<ResolveEntityResult> {
    const nodeTypeId = input.nodeTypeId;
    if (input.constraints.any.length === 0) return { candidates: [] };

    // The opaque constraints' `field`s and the `record` keys are now the wire's
    // id currency (renamed above). The graph compiles the OR-of-AND to its own
    // search and answers with the candidates AND their adjacency — the
    // adjacency rides along because the engine's `judgeEntityMatch`
    // disambiguates by connections, not just properties, and fetching it
    // separately would be a second walk of a graph we just queried.
    const { candidates } = await kgFetch<{
      candidates: {
        nodeId: string;
        data: Record<string, unknown>;
        relationships: { edgeName: string; targetName: string; edgeProperties?: Record<string, unknown> }[];
      }[];
    }>(await this.creds(), {
      method: 'POST',
      path: '/nodes/match',
      body: { nodeTypeId, record: input.record, team: this.teamId },
    });

    // Candidate `data` comes back keyed by property_type_id — rename it to the
    // adapter's NATURAL property names so the engine arbitrates exactness in
    // the same natural currency it holds the asserted record + constraints in
    // (the relationship fold already uses natural edge names). Decision #6: the
    // KG's internal ids never leave the adapter.
    const propertyNameById = await this.propertyNameMap(nodeTypeId);
    const toNaturalData = (data: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [id, value] of Object.entries(data)) {
        out[propertyNameById.get(id) ?? id] = value;
      }
      return out;
    };

    // Flat `ExternalRecordRef`s — the node id IS the external id for a KG
    // target; `data` is keyed by the natural property / edge names.
    return {
      candidates: candidates.map((c) => ({
        adapterType: KG_ADAPTER_TYPE,
        externalId: c.nodeId,
        data: foldRelationshipsIntoData(toNaturalData(c.data), c.relationships),
      })),
    };
  }

  /** property_type_id → display name for one node type — renames a candidate
   *  data bag back to the adapter's natural property names before it leaves
   *  the adapter (Decision #6). */
  private async propertyNameMap(nodeTypeId: NodeTypeId): Promise<Map<string, string>> {
    const { propertyTypes } = await this.ontology.get();
    return new Map(
      propertyTypes.filter((pt) => pt.nodeTypeId === nodeTypeId).map((pt) => [pt.id, pt.name]),
    );
  }

  // ── 2b. In-batch dedup rules (W6-D1) ────────────────────────────────────
  //
  // Project this node type's uniqueness into the ephemeral-vs-ephemeral form
  // the framework's `runInBatchDedup` consumes. Property entries pass through
  // as `{ propertyTypeId, fuzzy }` — the framework maps `propertyTypeId` to a
  // field name on the ephemeral data record via the bundle's synthetic schema
  // (W3-F4 stamped each `FieldShape.propertyTypeId` at pre-collection time).
  //
  // EDGE entries are intentionally omitted: adjacency needs a materialised
  // graph, which does not exist mid-batch, so they cannot be evaluated against
  // ephemeral pairs. The framework's pair walker finds the constraint has no
  // usable entries and moves on. (The expression-level entries the graph itself
  // drops — `edge_to:` ancestors, multi-step traversals — never arrive here at
  // all: the wire publishes the PROJECTED form, so the stored grammar is not
  // this adapter's to parse.)
  //
  // Returns null when the type has no uniqueness constraints or doesn't
  // exist (the framework skips the type entirely).
  async getDedupRules(input: { typeRef: string }): Promise<DedupRules | null> {
    // `typeRef` is the NATURAL node-type name — recover its ontology id from
    // the model (the engine never hands the adapter an id). An unknown name →
    // no rules (the framework skips the type).
    const model = await this.ontology.get();
    const nodeType = model.nodeTypes.find((nt) => nt.name === input.typeRef);
    if (!nodeType) return null;
    if (nodeType.uniquenessConstraints.any.length === 0) return null;

    // A field id is a property's or an edge's; the model is what says which.
    // Nothing is inferred from the id's SHAPE — both are UUIDs, and guessing
    // from a string is how a rename becomes a silent mismatch.
    const propertyTypeIds = new Set(
      model.propertyTypes.filter((pt) => pt.nodeTypeId === nodeType.id).map((pt) => pt.id),
    );

    const constraints: DedupConstraint[] = [];
    for (const branch of nodeType.uniquenessConstraints.any) {
      const entries: DedupConstraint['entries'] = [];
      for (const entry of branch.all) {
        if (!propertyTypeIds.has(entry.field)) continue;
        entries.push({ propertyTypeId: entry.field, fuzzy: entry.fuzzy ?? false });
      }
      // Constraints with no evaluable entries never fire — drop them
      // so the framework's pair walker doesn't waste cycles on empty
      // AND-lists.
      if (entries.length > 0) constraints.push({ entries });
    }

    if (constraints.length === 0) return null;
    return { constraints };
  }

  // ── 3. Field-level access ───────────────────────────────────────────────

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    const nodeId = expectKgNodeId(input.position, 'getFieldValue');
    // `fieldId` is the NATURAL property name and the position's `recordType`
    // is the NATURAL node-type name (the source-read wrapper stamps it);
    // resolve to the PropertyTypeId the property query consumes (Decision #3).
    const propertyTypeId = await this.resolvePropertyId(
      input.position.recordType,
      input.fieldId,
    );
    const node = await kgFetchOrNull<{ properties: Record<string, unknown> }>(
      await this.creds(),
      { method: 'GET', path: `/nodes/${nodeId}`, query: { team: this.teamId } },
    );
    // A field of a record that is gone reads null, not an error: the walk that
    // got here already landed on the position, and a record deleted between the
    // landing and the read is an ordinary race, not a broken program.
    return node?.properties[propertyTypeId] ?? null;
  }

  /** Resolve a NATURAL property name to its PropertyTypeId against a NATURAL
   *  node-type name, through this instance's own resolver. When the position
   *  carries no type (a typeless inbound node) there's nothing to resolve
   *  against — the name is used as-is. */
  private async resolvePropertyId(
    typeName: string | null,
    fieldNaturalName: string,
  ): Promise<string> {
    if (typeName === null) return fieldNaturalName;
    const resolver = await this.resolver({ types: [typeName] });
    return resolver.fieldId(naturalName(typeName), naturalName(fieldNaturalName));
  }

  /** Resolve a NATURAL edge name to its EdgeTypeId (the read currency
   *  `getRelated` scans by) against a NATURAL node-type name. Used as-is when
   *  the position carries no type. */
  private async resolveEdgeReadId(
    typeName: string | null,
    edgeNaturalName: string,
  ): Promise<string> {
    if (typeName === null) return edgeNaturalName;
    const resolver = await this.resolver({ types: [typeName] });
    return resolver.edgeReadId(naturalName(typeName), naturalName(edgeNaturalName));
  }

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    // A meta-root hop is a COLLECTION scan — every node of the named type.
    // `fieldId` is the NATURAL node-type name; resolve it to the NodeTypeId
    // the scan consumes (Decision #3). The movement engine's kg-rooted
    // traversals (`kg-[c:\`Funding Round\` WHERE …]->`) ride this; WHERE /
    // ORDER BY / LIMIT are applied engine-side, post-stream (no pushdown — the
    // scan streams the type's nodes and the engine filters/sorts/slices the
    // survivors). The landed records are stamped with the natural collection
    // type by the read wrapper.
    if (input.position.recordType === META_RECORD_TYPE) {
      // `fieldId` is the NATURAL collection (node-type) name — recover its
      // ontology id for the scan. Each landed record is stamped with the same
      // NATURAL name, never the id.
      const nodeTypeId = await this.requireStructuredId(input.fieldId, 'getRelated');
      const ids = await this.scanNodeIds(nodeTypeId);
      return ids.map<RelatedResult>((id) => ({
        position: makeStablePosition({
          adapterType: KG_ADAPTER_TYPE,
          recordType: input.fieldId,
          recordId: id,
        }),
      }));
    }

    const nodeId = expectKgNodeId(input.position, 'getRelated');

    // THE hop from an event to what it is about (D40). It is not an ontology
    // edge — no edge row connects a change to its record — so it is walked
    // rather than queried: the event position is identified BY the record it
    // describes, and this hop is the same id, retyped from the event to the
    // record's own node type. That retyping is the whole point: the event's
    // surface is `action`/`type`, the record's is its properties, and a listen's
    // body reads the second.
    //
    // A deleted record cannot be retyped — there is nothing left to name — so
    // the hop yields nothing rather than a position pointing at a hole. The
    // descriptor says as much with `requiresLiveRecord`.
    if (
      input.position.recordType === KG_EVENT_TYPE_NAME ||
      input.position.recordType === KG_EVENT_TYPE_ID
    ) {
      if (input.fieldId !== KG_EVENT_RECORD_EDGE && input.fieldId !== KG_EVENT_RECORD_EDGE_NAME) {
        return [];
      }
      const record = await kgFetchOrNull<{ id: string; nodeTypeId: string }>(await this.creds(), {
        method: 'GET',
        path: `/nodes/${nodeId}`,
        query: { team: this.teamId },
      });
      if (!record) return [];
      const model = await this.ontology.get();
      const typeName = model.nodeTypes.find((nt) => nt.id === record.nodeTypeId)?.name;
      if (typeName === undefined) return [];
      return [
        {
          position: makeStablePosition({
            adapterType: KG_ADAPTER_TYPE,
            recordType: typeName,
            recordId: record.id,
          }),
        },
      ];
    }

    // Resources (`#resources`): a node's `node_resource` attachments become
    // resource positions whose `data` carries the `Resource`. The engine's
    // `#resources` meta-edge / `resource_traverse` walk this (P12, replacing
    // the retired `getResources`); the engine applies any `ResourceFilter`.
    // The `#`-prefixed sentinel is the engine's own, never an ontology edge —
    // it crosses verbatim.
    if (input.fieldId === RESOURCES_REFERENCE_FIELD_ID) {
      const attached = await kgFetch<{ data: { resourceId: string }[] }>(await this.creds(), {
        method: 'GET',
        path: `/nodes/${nodeId}/resources`,
        query: { team: this.teamId },
      });
      // Only the ATTACHMENT is the graph's; the resource itself is this side's
      // table, so it is read here rather than asked for across the boundary.
      const resources = await readResources(attached.data.map((r) => r.resourceId as ResourceId));
      return resources.map<RelatedResult>((resource) => ({
        position: makeUnstablePosition({
          adapterType: KG_ADAPTER_TYPE,
          recordType: KG_RESOURCE_TYPE_ID,
          data: resource,
        }),
      }));
    }

    // `fieldId` is the NATURAL edge name, belonging to the position's NATURAL
    // node type (the read wrapper stamps it); resolve to the EdgeTypeId the
    // edge query consumes (Decision #3).
    const edgeTypeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    // One call answers the whole hop: the edges at this end, the type of what
    // sits at the other end, and each edge's own properties. The other end's
    // TYPE is not optional — a position must name its type, and when this
    // returned bare ids the question was pushed onto every consumer and, having
    // no answer, onto a whole-graph edge-name scan. Edge properties ride along
    // for the same reason candidate adjacency does (3b §2): an `edge_property`
    // expression reads them off the result rather than re-asking per field.
    const { data: rows } = await kgFetch<{
      data: {
        edgeId: string;
        otherNodeId: string;
        otherNodeTypeId: string;
        properties: Record<string, unknown>;
      }[];
    }>(await this.creds(), {
      method: 'GET',
      path: `/nodes/${nodeId}/edges`,
      query: {
        team: this.teamId,
        edgeTypeId,
        direction: input.direction === 'outgoing' ? 'out' : 'in',
      },
    });

    // The wire names the other end by node-type ID; a position carries the
    // NATURAL name (Decision #6). Both maps are the one cached model.
    const model = await this.ontology.get();
    const nodeTypeNameById = new Map(model.nodeTypes.map((nt) => [nt.id, nt.name]));
    const edgePropNameById = new Map(
      model.propertyTypes.filter((pt) => pt.edgeTypeId === edgeTypeId).map((pt) => [pt.id, pt.name]),
    );
    const toNaturalEdgeProps = (props: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [id, value] of Object.entries(props)) out[edgePropNameById.get(id) ?? id] = value;
      return out;
    };
    return rows.map<RelatedResult>((row) => ({
      position: makeStablePosition({
        adapterType: KG_ADAPTER_TYPE,
        recordType: nodeTypeNameById.get(row.otherNodeTypeId) ?? row.otherNodeTypeId,
        recordId: row.otherNodeId,
      }),
      edgeId: row.edgeId,
      edgeProperties: toNaturalEdgeProps(row.properties),
    }));
  }

  /**
   * Every node of one type, oldest first.
   *
   * The engine applies WHERE / ORDER BY / LIMIT post-stream, so the whole
   * collection has to arrive — which over HTTP means paging. The wire's order is
   * newest-first and total (created_at, then id), so pages compose: collect them
   * all and reverse once, rather than trusting a partial order that could show a
   * row on two pages and skip a third.
   */
  private async scanNodeIds(nodeTypeId: NodeTypeId): Promise<string[]> {
    const creds = await this.creds();
    const pageSize = 100;
    const ids: string[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await kgFetch<{ data: { id: string }[] }>(creds, {
        method: 'GET',
        path: '/nodes',
        query: { team: this.teamId, nodeTypeId, limit: pageSize, offset },
      });
      ids.push(...page.data.map((n) => n.id));
      if (page.data.length < pageSize) break;
    }
    return ids.reverse();
  }

  // ── 4. Trigger implementations ──────────────────────────────────────────
  //
  // The graph supports only the 'mutation' trigger. Events are derived and
  // enqueued by the store's write door and delivered by the outbox drainer
  // (M-38) — never polled — so there is no snapshot or poll source here. What
  // there IS depends on which way this deployment delivers (D39(c)): composed
  // hands the drainer's envelope straight to the local subscriber and these
  // subscription methods are not even advertised; standalone receives the same
  // envelope over a signed webhook, which is what the three below are for.

  /**
   * The drainer's envelope, in the engine's currency.
   *
   * It is deliberately the SAME envelope either way — `{ event, timestamp,
   * data }` — so the local and webhook paths cannot drift into describing the
   * same mutation differently. `changedFields` rides along because a listen can
   * filter on it; the whole payload crosses verbatim because `didWeAuthor`
   * computes the entire `suppress_self` semantic from the mutation context, and
   * a stripped bag degrades it to "can't answer", which is logged and ignored
   * while every 2-way sync quietly starts echoing (K-29).
   */
  async preprocessInbound(input: { raw: unknown }): Promise<{ events: DiscriminableEvent[] }> {
    const parsed = mutationEnvelopeSchema.safeParse(input.raw);
    if (!parsed.success) return { events: [] };
    const { event, timestamp, data } = parsed.data;
    return {
      events: [
        {
          payload: data,
          eventType: event,
          recordType: data.nodeTypeId,
          externalId: data.recordId,
          changedFields: data.changedFields,
          occurredAt: timestamp,
          changeType: CHANGE_TYPE_BY_EVENT[event],
        },
      ],
    };
  }

  /**
   * Register (or re-register) this deployment's callback with the graph.
   *
   * Idempotent by URL on the graph's side, which is what makes re-registering
   * on every listen change the right move rather than a diff nobody can trust:
   * the event selection is whatever the reconciler last said it was.
   */
  async ensureEventSubscription(
    input: EnsureEventSubscriptionInput,
  ): Promise<EventSubscriptionRegistration | undefined> {
    if (this.credentialsId === undefined) return undefined;
    return registerKnowledgeWebhook({
      credentialsId: this.credentialsId,
      teamId: this.teamId,
      targetUrl: input.callbackUrl,
      eventTypes: input.events,
    });
  }

  async removeEventSubscription(input: RemoveEventSubscriptionInput): Promise<void> {
    if (this.credentialsId === undefined) return;
    await deregisterKnowledgeWebhook({
      credentialsId: this.credentialsId,
      teamId: this.teamId,
      externalId: input.externalId ?? input.callbackUrl,
    });
  }

  // ── 5. Writes ───────────────────────────────────────────────────────────
  // Implementation lives in ./knowledge_graph_writes.ts.

  /** Everything a write needs to reach the graph: the credential and the model
   *  it resolves edge and property types against. Both are already cached — the
   *  ontology behind the introspection cache, the credential behind its own —
   *  so a write costs the same round trips as the writes it replaced, minus the
   *  queries the resolution used to be. */
  private async writeConnection(): Promise<WriteConnection> {
    const [creds, ontology] = await Promise.all([this.creds(), this.ontology.get()]);
    return { creds, ontology };
  }

  async createRecord(input: WriteInput): Promise<WriteResult> {
    // Translate the program's NATURAL currency to ontology UUIDs on the first
    // line (Decision #3): the node-type name → NodeTypeId, the field keys
    // (and their per-field evidence) → PropertyTypeId, each parent's type →
    // NodeTypeId. A parent's `edgeName` stays the natural edge name — the
    // write SQL matches it directly against `edge_type.outbound_name` /
    // `inbound_name` (which ARE the adapter's natural edge names).
    const w = await this.toInternalWriteCurrency(input);
    const { externalId } = await createKgRecord({
      connection: await this.writeConnection(),
      teamId: this.teamId,
      recordType: w.recordType,
      fields: w.fields,
      evidence: w.evidence,
      resources: input.resources,
      mutationContext: input.mutationContext,
      // One entry for a linked write, N for a tuple-path multi-parent
      // create — every connecting edge inserts in the node's own
      // transaction (`writeParentLinks` normalizes both input slots).
      parentLinks: w.parentLinks,
      bridgeToExternal: input.bridgeToExternal,
    });
    // `data: {}` — the KG is only ever the target on an External → KG flow,
    // whose bridge snapshots the *source* position's data, not this write
    // return. The canonical post-commit values live in the graph itself.
    return { adapterType: KG_ADAPTER_TYPE, externalId, data: {} };
  }

  async updateRecord(input: UpdateInput): Promise<UpdateResult> {
    const w = await this.toInternalWriteCurrency(input);
    const result = await updateKgRecord({
      connection: await this.writeConnection(),
      teamId: this.teamId,
      externalId: input.externalId,
      recordType: w.recordType,
      fields: w.fields,
      evidence: w.evidence,
      resources: input.resources,
      mutationContext: input.mutationContext,
      // W4-KG3 — edge-anchored field writes on a matched (update) node
      // resolve the existing edge(s) between the parent(s) and this node
      // via the same name-matching the create path uses. Empty for root
      // updates (no edge to resolve, so any edge-anchored field would
      // be a no-op — logged at the write site).
      parentLinks: w.parentLinks,
    });
    // NOT-FOUND contract (3b): the node was gone — surface the typed signal.
    if ('notFound' in result) return { notFound: true };
    return {
      adapterType: KG_ADAPTER_TYPE,
      externalId: input.externalId,
      data: {},
      association: result.association,
    };
  }

  /**
   * Rename a write's NATURAL currency (node-type / property / parent-type
   * names) to the ontology UUIDs `knowledge_graph_writes` consumes. Field keys
   * (and per-field evidence keys) become PropertyTypeIds; the record type and
   * each parent's type become NodeTypeIds. The parent `edgeName` is left as the
   * natural edge name — the write SQL matches it against `outbound_name` /
   * `inbound_name` directly.
   */
  private async toInternalWriteCurrency(input: WriteInput): Promise<{
    recordType: string;
    fields: Record<string, unknown>;
    evidence?: Record<string, FieldEvidence>;
    parentLinks: ParentLink[];
  }> {
    const resolver = await this.resolver({ types: [input.recordType] });
    const typeName = naturalName(input.recordType);
    // The node-type name → its ontology UUID via the private cache; field keys
    // (property display names) → PropertyTypeIds via the resolver (those ids
    // never ride a position, so they keep flowing through the resolver).
    const recordType = await this.requireStructuredId(input.recordType, 'write');
    const fields: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(input.fields)) {
      fields[resolver.fieldId(typeName, naturalName(name))] = value;
    }
    let evidence: Record<string, FieldEvidence> | undefined;
    if (input.evidence) {
      evidence = {};
      for (const [name, ev] of Object.entries(input.evidence)) {
        evidence[resolver.fieldId(typeName, naturalName(name))] = ev;
      }
    }
    const parentLinks = await Promise.all(
      writeParentLinks(input).map(async (p) => ({
        ...p,
        recordType: await this.requireStructuredId(p.recordType, 'write'),
        // edgeName stays natural — `resolveParentLinkEdgeType` matches it
        // against `outbound_name` / `inbound_name`.
      })),
    );
    return { recordType, fields, ...(evidence ? { evidence } : {}), parentLinks };
  }

  // ── 5b. Link two existing nodes — the standalone `edge a -[:e]-> b`
  //       assert. Implementation lives in ./knowledge_graph_writes.ts
  //       (`linkKgRecords`), mirroring the parentLink edge machinery.
  async linkRecords(input: LinkRecordsInput): Promise<LinkRecordsResult> {
    const ends = await this.toInternalLinkCurrency(input);
    return linkKgRecords({ connection: await this.writeConnection(), ...input, ...ends });
  }

  /** Sever an edge — the inverse of linkRecords (the movement language's
   *  `unlink a -[:e]-> b`). Implementation in ./knowledge_graph_writes.ts. */
  async unlinkRecords(input: UnlinkRecordsInput): Promise<UnlinkRecordsResult> {
    const ends = await this.toInternalLinkCurrency(input);
    return unlinkKgRecords({ connection: await this.writeConnection(), ...input, ...ends });
  }

  /** Rename a link/unlink's endpoint NATURAL node-type names to NodeTypeIds.
   *  `edgeName` stays natural (the link SQL matches it against the from-side's
   *  `outbound_name` / `inbound_name`). */
  private async toInternalLinkCurrency(
    input: LinkRecordsInput,
  ): Promise<{ from: LinkRecordsInput['from']; to: LinkRecordsInput['to'] }> {
    const [from, to] = await Promise.all([
      this.requireStructuredId(input.from.recordType, 'linkRecords'),
      this.requireStructuredId(input.to.recordType, 'linkRecords'),
    ]);
    return {
      from: { ...input.from, recordType: from },
      to: { ...input.to, recordType: to },
    };
  }

  /** Hard-delete a node, reusing the knowledge layer's existing removal
   *  shape (FK cascades + `node_removed` change record). Implementation in
   *  ./knowledge_graph_writes.ts. */
  async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    await deleteKgRecord({
      connection: await this.writeConnection(),
      recordType: await this.requireStructuredId(input.recordType, 'deleteRecord'),
      externalId: input.externalId,
      mutationContext: input.mutationContext,
    });
    return {};
  }

  // ── 6. readRecord (no-op detection support) ─────────────────────────────
  // Reading current canonical values for no-op detection on KG targets is
  // handled by the transaction-commit hook (per 3h §Layer 2), not via this
  // method. Leaving readRecord undefined is the right signal: the engine's
  // commit hook reads canonical values directly through readProperty rather
  // than via the adapter.


  // (Correspondence — `getPriorMatch` / `recordLink` — retired with the TG
  // engine. The KG is no longer a correspondence store for the engine;
  // linking is the engine-owned `bind` store. The `linked_object` table
  // survives for `resolveByBridge` candidate lookup, not for prior-match.)

  // ── Echo authorship (the `suppress_self` capability, Decision §3.2) ──────
  //
  // "Did WE author this KG change?" The KG is the CLEANEST actor story: every
  // write carries a MutationContext whose `source` records HOW it was produced
  // — and a mutation event hands that context straight back to us as the
  // event's payload. So we answer purely from the change's own provenance, no
  // external round-trip and no recent-write cache needed here.
  //
  // SCOPED TO THIS CHANGE'S AUTHORSHIP, never the record's identity:
  //   - `structured_input` / `extraction` produced by a movement or trigger
  //     (a `translationGraphId` or `trigger:`-marked `pipelineInputId` present)
  //     IS our own automated write → suppress (`true`). This is exactly the
  //     A↔B self-echo the author opted out of.
  //   - `user_edit` / `agent` / `api` — a HUMAN (or an interactive agent /
  //     direct API call) editing a record, even one automation once wrote —
  //     is NOT this-change authorship by the sync → `false`, fires normally.
  //   - no recognisable provenance → `null` (can't tell; don't suppress).
  async didWeAuthor(input: {
    event: import('../triggers/types').TriggerEvent;
  }): Promise<boolean | null> {
    const parsed = recordMutationEventSchema
      .pick({ context: true })
      .safeParse(input.event.payload);
    if (!parsed.success) return null; // not a recognisable KG mutation event
    const source = parsed.data.context.source;

    // Only automation-produced writes count as "we authored this change."
    if (source.type !== 'structured_input' && source.type !== 'extraction') {
      return false;
    }
    // A self-echo of OUR sync carries a translation-graph / trigger marker.
    const fromAutomation =
      source.translationGraphId !== undefined ||
      (typeof source.pipelineInputId === 'string' &&
        source.pipelineInputId.startsWith('trigger:'));
    return fromAutomation ? true : false;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Narrow a `SourcePosition` to the stable KG-owned position the read paths
 * expect and return its `recordId` (the KG node id). A KG position is the
 * stable position whose `adapterType` is the KG's — its `recordId` IS the
 * node id (a kg-node carries no inline data; KG reads by id).
 */
function expectKgNodeId(position: SourcePosition, method: string): string {
  if (!isStablePosition(position) || position.adapterType !== KG_ADAPTER_TYPE) {
    throw new Error(
      `KnowledgeGraphAdapter.${method} expects a stable knowledge-graph position; ` +
        `got adapterType=${position.adapterType}, identity.kind=${position.identity.kind}`,
    );
  }
  const nodeId = positionRecordId(position);
  if (nodeId === undefined) {
    throw new Error(
      `KnowledgeGraphAdapter.${method} expected a stable position with a recordId`,
    );
  }
  return nodeId;
}

/** The wire spells a value type with the store's own enum values, so the map is
 *  the same one it always was — it just arrives as a string rather than as a
 *  column. An unknown kind means the store grew a value type this build has
 *  never heard of; `json` is the honest landing place for "structured, and we
 *  cannot say more". */
function mapPropertyValueTypeToFieldKind(value: string): SchemaFieldKind {
  switch (value) {
    case PropertyValueType.text:
      return 'string';
    case PropertyValueType.number:
      return 'number';
    case PropertyValueType.date:
      return 'date';
    case PropertyValueType.boolean:
      return 'boolean';
    case PropertyValueType.json:
    default:
      return 'json';
  }
}

/**
 * The `Resource` rows behind a node's attachments.
 *
 * Only the ATTACHMENT is the graph's; `resource` is this side's own table, so
 * the join is split across the boundary rather than asked for across it. The
 * standard fields are materialised onto `data` so a `resource` expression's
 * field reads are a local lookup; the engine applies any author
 * `ResourceFilter` post-hoc.
 */
async function readResources(resourceIds: ResourceId[]): Promise<Resource[]> {
  if (resourceIds.length === 0) return [];
  const resources = await getKnowledgeQb(['resource'])
    .selectFrom('resource')
    .where('resource.id', 'in', resourceIds)
    .select([
      'resource.id',
      'resource.type',
      'resource.url',
      'resource.name',
      'resource.external_id',
      'resource.metadata',
    ])
    .execute();

  return resources.map((r) => ({
    id: r.id,
    externalId: r.external_id ?? undefined,
    // Provenance was stored in metadata at write time (4d_resources.md) —
    // round-trip it back onto the resource.
    provenance: (r.metadata as { provenance?: Resource['provenance'] } | null)?.provenance,
    type: r.type as Resource['type'],
    name: r.name ?? undefined,
    url: r.url ?? undefined,
    data: {
      name: r.name,
      url: r.url,
      type: r.type,
      // document_url and content are lazy fields — fetched on demand when
      // a resource expression specifically asks for them. Initial pass
      // returns null; future enhancement loads them.
      document_url: null,
      content: null,
    },
  }));
}

/**
 * Re-export a function to create the adapter — used by the registry.
 */
export function createKnowledgeGraphAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
}): KnowledgeGraphAdapter {
  return new KnowledgeGraphAdapter(input);
}
