// The knowledge store's write door.
//
// One place writes graph SQL. Everything that used to write nodes, properties,
// evidence and edges by hand — the kg adapter, the graph editor's tRPC
// mutations, the agent CRUD tools — comes through here, so `writable_by`,
// evidence, change rows, value coercion and transactionality are guarantees
// rather than conventions each caller re-implemented differently.
//
// The semantics are ruled in D37:
//   (a) clearing keeps the row and records evidence; deleting the row is a
//       separate, explicitly-named operation
//   (b) the gate applies to EVERY property write, including a create's initial
//       properties, edge-anchored properties, clears and merge curation
//   (c) a refused write throws
//   (d) one coercion per value type (see ./values)
//   (e) edge identity is (type, source, target) — link is an idempotent upsert
//   (f) every path writes `change` rows
//   (g) one call is one transaction (K-25), on the handle the caller passes in

import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type KnowledgeSchema from '../../../generated/kysely/knowledge/KnowledgeSchema';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../../generated/kysely/knowledge/NodeType';
import type { EdgeId } from '../../../generated/kysely/knowledge/Edge';
import type { EdgeTypeId } from '../../../generated/kysely/knowledge/EdgeType';
import type { PropertyId } from '../../../generated/kysely/knowledge/Property';
import type { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';
import type { EvidenceId } from '../../../generated/kysely/knowledge/Evidence';

import { getKnowledgeQb } from '../../kysely';
import EvidenceType from '../../../generated/kysely/knowledge/EvidenceType';
import EvaluationStrategy from '../../../generated/kysely/knowledge/EvaluationStrategy';
import PropertyCardinality from '../../../generated/kysely/knowledge/PropertyCardinality';
import PropertyValueType from '../../../generated/kysely/knowledge/PropertyValueType';
import {
  ChangeKind,
  ChangeSource,
  propertyToChangeValue,
  recordChange,
  recordChanges,
  type RecordChangeParams,
} from '../changes';
import { logger } from '../../../services/logger';
import {
  assertWritable,
  clearedColumns,
  coerceValue,
  jsonbValue,
  type PropertyTypeFacts,
  type ValueColumns,
} from './values';
import {
  contextFromSource,
  MutationCollector,
  type MutationContextPayload,
  type MutationEvent,
} from './events';

/** The tables the door writes. `getKnowledgeQb` is asked for exactly these. */
const STORE_TABLES = [
  'node',
  'node_type',
  'property',
  'property_type',
  'evidence',
  'edge',
  'edge_type',
  'change',
  'linked_object',
  'node_resource',
  'extraction_fact',
  'mutation_outbox',
  'property_arbitration',
] as const;

/** The explicit handle every door call takes (K-2: never ambient). */
export type KnowledgeWriteDb = Kysely<Pick<KnowledgeSchema, (typeof STORE_TABLES)[number]>>;

/** The store's own handle, for callers that have no transaction of their own. */
export function openKnowledgeStore(): KnowledgeWriteDb {
  return getKnowledgeQb(STORE_TABLES);
}

/** One call is one transaction — unless the caller already opened one. */
export async function inTransaction<T>(
  db: KnowledgeWriteDb,
  fn: (trx: KnowledgeWriteDb) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) return fn(db);
  return db.transaction().execute((trx) => fn(trx as KnowledgeWriteDb));
}

/**
 * One transaction's mutation events belong together, so nested door calls share
 * the collector the outermost one opened, and it flushes into the outbox just
 * before commit. Keyed on the transaction handle rather than passed down every
 * signature: a door operation composed of three writes is still one story.
 */
const activeCollectors = new WeakMap<object, MutationCollector>();

export async function withCollector<T>(
  db: KnowledgeWriteDb,
  context: WriteContext,
  fn: (trx: KnowledgeWriteDb, collector: MutationCollector) => Promise<T>,
): Promise<T> {
  return inTransaction(db, async (trx) => {
    const nested = activeCollectors.get(trx);
    if (nested) return fn(trx, nested);

    const collector = new MutationCollector(context.teamId as string, mutationContextFor(context));
    activeCollectors.set(trx, collector);
    try {
      const result = await fn(trx, collector);
      await collector.flush(trx);
      return result;
    } finally {
      activeCollectors.delete(trx);
    }
  });
}

/**
 * The writer's own context if it declared one — verbatim, opaque bag and all,
 * because the consumer's echo suppression reads nothing else — and otherwise
 * the honest minimum the change source already tells us.
 */
function mutationContextFor(context: WriteContext): MutationContextPayload {
  const occurredAt = new Date().toISOString();
  const declared = context.mutationContext;
  if (
    declared !== null &&
    typeof declared === 'object' &&
    typeof (declared as { source?: { type?: unknown } }).source?.type === 'string'
  ) {
    const bag = declared as MutationContextPayload;
    return typeof bag.occurredAt === 'string' ? bag : { ...bag, occurredAt };
  }
  return contextFromSource({
    changeSource: context.changeSource,
    actorId: context.createdBy ?? null,
    occurredAt,
  });
}

/**
 * Who is writing, and under what provenance. `evidenceType` is the gate's
 * currency AND the evidence row's type; `changeSource` is the change feed's.
 */
export interface WriteContext {
  teamId: TeamId;
  evidenceType: EvidenceType;
  changeSource: ChangeSource;
  /** Default evidence description; a per-field description overrides it. */
  description: string;
  /** The movement engine's provenance bag, when the write came from a run. */
  mutationContext?: unknown;
  /** Groups the change rows of one logical operation. */
  requestId?: string;
  createdBy?: string | null;
  /**
   * This write IS an arbitration's ruling, not a source asserting a value
   * (D42). It raises no new arbitration — otherwise a verdict would queue the
   * question it just answered.
   */
  arbitrationRuling?: boolean;
}

/** A property write in the door's currency: a raw value, coerced here. */
export interface PropertyWrite {
  propertyTypeId: PropertyTypeId | string;
  /** `null` clears the property (D37a) — the row and its evidence survive. */
  value: unknown;
  /** Overrides `context.description` on this field's evidence row. */
  description?: string;
}

export type PropertyAnchor =
  | { kind: 'node'; nodeId: NodeId; nodeTypeId?: NodeTypeId }
  | { kind: 'edge'; edgeId: EdgeId };

export interface WrittenProperty {
  propertyTypeId: PropertyTypeId;
  propertyId: PropertyId;
  /** The evidence row this write appended — provenance is never optional. */
  evidence: { id: EvidenceId; type: EvidenceType; description: string; created_at: Date };
  /** The property row did not exist before this write. */
  created: boolean;
  /** The write was a clear (D37a), not a value. */
  cleared: boolean;
  propertyType: PropertyTypeFacts;
}

/**
 * A write whose property type declares `evaluation_strategy: llm` leaves a
 * question behind: the value that just landed is one source's claim, and the
 * declaration says the value is whatever reading ALL the sources concludes.
 *
 * The door does not answer it. It records that it was asked — inside the write
 * transaction, so the question exists exactly when the write that raised it
 * committed, the same reason the outbox lives here (D42). What `llm` MEANS, and
 * what answering costs, belong to the arbitration worker; the store stays free
 * of models entirely.
 *
 * Multi-valued text is exempt because its write is a set union, so there is
 * nothing to choose between — the same carve-out the in-transaction path had.
 * A ruling is exempt because arbitrating the arbiter's own verdict is a loop.
 */
async function enqueueArbitration(
  trx: KnowledgeWriteDb,
  input: { teamId: TeamId; propertyId: PropertyId; propertyType: PropertyTypeFacts; ruling: boolean },
): Promise<void> {
  const pt = input.propertyType;
  if (input.ruling) return;
  if (pt.evaluation_strategy !== EvaluationStrategy.llm) return;
  if (pt.cardinality === PropertyCardinality.multi && pt.value_type === PropertyValueType.text) return;

  await trx
    .insertInto('property_arbitration')
    .values({ team_id: input.teamId, property_id: input.propertyId })
    .onConflict((oc) =>
      // Coalesce: arbitration re-derives from the whole evidence history, so a
      // second write arriving before the worker does re-dates the question
      // rather than asking it twice. `attempts` resets — a fresh write is a
      // fresh question, not a retry of the one that was failing.
      oc
        .column('property_id')
        .where('resolved_at', 'is', null)
        .doUpdateSet({ enqueued_at: new Date(), attempts: 0, next_attempt_at: null, last_error: null }),
    )
    .execute();
}

// ── Property types ─────────────────────────────────────────────────────────

const PROPERTY_TYPE_COLUMNS = [
  'id',
  'name',
  'description',
  'value_type',
  'cardinality',
  'evaluation_strategy',
  'writable_by',
  'edge_type_id',
] as const;

export async function loadPropertyTypes(
  db: KnowledgeWriteDb,
  input: { teamId: TeamId; propertyTypeIds: readonly (PropertyTypeId | string)[] },
): Promise<Map<string, PropertyTypeFacts>> {
  const ids = [...new Set(input.propertyTypeIds)] as PropertyTypeId[];
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('property_type')
    .where('team_id', '=', input.teamId)
    .where('id', 'in', ids)
    .select(PROPERTY_TYPE_COLUMNS)
    .execute();
  return new Map(
    rows.map((r) => [
      r.id as string,
      {
        id: r.id,
        name: r.name,
        description: r.description,
        value_type: r.value_type,
        cardinality: r.cardinality,
        evaluation_strategy: r.evaluation_strategy,
        writable_by: r.writable_by,
        edge_type_id: r.edge_type_id ?? null,
      } satisfies PropertyTypeFacts,
    ]),
  );
}

// ── Properties ─────────────────────────────────────────────────────────────

interface SetPropertiesInput {
  context: WriteContext;
  anchor: PropertyAnchor;
  properties: readonly PropertyWrite[];
  /** Pre-loaded facts; the door loads what is missing. */
  propertyTypes?: Map<string, PropertyTypeFacts>;
}

/**
 * Set (or clear) properties on a node or an edge. Upserts the property row,
 * appends an evidence row, and records a `change` — on every path, for the
 * first time (D37f).
 */
export async function setProperties(
  db: KnowledgeWriteDb,
  input: SetPropertiesInput,
): Promise<WrittenProperty[]> {
  return withCollector(db, input.context, (trx, collector) =>
    setPropertiesIn(trx, input, collector),
  );
}

async function setPropertiesIn(
  trx: KnowledgeWriteDb,
  input: SetPropertiesInput,
  collector: MutationCollector,
): Promise<WrittenProperty[]> {
  const { context, anchor } = input;
  const writes = input.properties.filter((p) => p.value !== undefined);
  if (writes.length === 0) return [];

  const propertyTypes =
    input.propertyTypes ??
    (await loadPropertyTypes(trx, {
      teamId: context.teamId,
      propertyTypeIds: writes.map((w) => w.propertyTypeId),
    }));

  const requestId = context.requestId ?? randomUUID();
  const written: WrittenProperty[] = [];
  const changes: RecordChangeParams[] = [];

  for (const write of writes) {
    const pt = propertyTypes.get(write.propertyTypeId as string);
    if (!pt) {
      throw new Error(
        `Knowledge write: property_type ${write.propertyTypeId} not found for team ${context.teamId}.`,
      );
    }

    // The uniform gate (D37b) — including clears and a create's own properties.
    assertWritable(pt, context.evidenceType);

    const isClear = write.value === null;

    const existing = await selectExistingProperty(trx, { anchor, teamId: context.teamId, propertyTypeId: pt.id });

    // Clearing something that was never set is a no-op: no row to keep, so
    // nothing to evidence.
    if (!existing && isClear) continue;

    // Node-anchored only: an edge-anchored property is a fact about a
    // relationship, and the event vocabulary describes records.
    if (anchor.kind === 'node') {
      collector.propertyTouched({
        nodeId: anchor.nodeId,
        nodeTypeId: anchor.nodeTypeId ?? null,
        propertyTypeId: pt.id,
        before: existing ?? null,
      });
    }

    const columns: ValueColumns = isClear
      ? clearedColumns()
      : coerceValue(pt, write.value, existing?.value_text_array);

    const oldValue = existing ? propertyToChangeValue(existing) : null;

    let propertyId: PropertyId;
    if (existing) {
      await trx
        .updateTable('property')
        .set({ ...columns, updated_at: new Date() })
        .where('id', '=', existing.id)
        .execute();
      propertyId = existing.id;
    } else {
      const inserted = await trx
        .insertInto('property')
        .values({
          team_id: context.teamId,
          node_id: anchor.kind === 'node' ? anchor.nodeId : null,
          edge_id: anchor.kind === 'edge' ? anchor.edgeId : null,
          property_type_id: pt.id,
          ...columns,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      propertyId = inserted.id;
    }

    const evidence = await trx
      .insertInto('evidence')
      .values({
        team_id: context.teamId,
        property_id: propertyId,
        type: context.evidenceType,
        description: write.description ?? context.description,
        mutation_context:
          context.mutationContext === undefined ? null : jsonbValue(context.mutationContext),
      })
      .returning(['id', 'type', 'description', 'created_at'])
      .executeTakeFirstOrThrow();

    changes.push({
      teamId: context.teamId as unknown as string,
      requestId,
      source: context.changeSource,
      kind: isClear ? ChangeKind.property_cleared : ChangeKind.property_set,
      nodeId: anchor.kind === 'node' ? (anchor.nodeId as string) : null,
      edgeId: anchor.kind === 'edge' ? (anchor.edgeId as string) : null,
      propertyId: propertyId as string,
      evidenceId: evidence.id as string,
      oldValue,
      newValue: isClear ? null : propertyToChangeValue(columns),
      createdBy: context.createdBy ?? null,
    });

    const record: WrittenProperty = {
      propertyTypeId: pt.id,
      propertyId,
      evidence,
      created: !existing,
      cleared: isClear,
      propertyType: pt,
    };
    written.push(record);
    await enqueueArbitration(trx, {
      teamId: context.teamId,
      propertyId,
      propertyType: pt,
      ruling: context.arbitrationRuling === true,
    });
  }

  if (anchor.kind === 'node' && written.length > 0) {
    await trx
      .updateTable('node')
      .set({ updated_at: new Date() })
      .where('id', '=', anchor.nodeId)
      .execute();
  }

  if (changes.length > 0) await recordChanges(changes, trx);
  return written;
}

async function selectExistingProperty(
  trx: KnowledgeWriteDb,
  input: { anchor: PropertyAnchor; teamId: TeamId; propertyTypeId: PropertyTypeId },
) {
  let q = trx
    .selectFrom('property')
    .where('property.team_id', '=', input.teamId)
    .where('property.property_type_id', '=', input.propertyTypeId);
  q =
    input.anchor.kind === 'node'
      ? q.where('property.node_id', '=', input.anchor.nodeId)
      : q.where('property.edge_id', '=', input.anchor.edgeId);
  return q
    .select([
      'property.id',
      'property.value_text',
      'property.value_text_array',
      'property.value_number',
      'property.value_date',
      'property.value_boolean',
      'property.value_json',
    ])
    .executeTakeFirst();
}

/**
 * Delete property ROWS — the explicit operation D37(a) keeps distinct from a
 * clear. The evidence history goes with the row (FK cascade), which is exactly
 * why this is not what a `null` write does.
 */
export async function deleteProperties(
  db: KnowledgeWriteDb,
  input: {
    context: WriteContext;
    anchor: PropertyAnchor;
    propertyTypeIds: readonly (PropertyTypeId | string)[];
  },
): Promise<number> {
  const ids = [...new Set(input.propertyTypeIds)] as PropertyTypeId[];
  if (ids.length === 0) return 0;
  return withCollector(db, input.context, async (trx, collector) => {
    const { context, anchor } = input;
    let selectQ = trx
      .selectFrom('property')
      .where('property.team_id', '=', context.teamId)
      .where('property.property_type_id', 'in', ids);
    selectQ =
      anchor.kind === 'node'
        ? selectQ.where('property.node_id', '=', anchor.nodeId)
        : selectQ.where('property.edge_id', '=', anchor.edgeId);
    const rows = await selectQ
      .select([
        'property.id',
        'property.property_type_id',
        'property.value_text',
        'property.value_text_array',
        'property.value_number',
        'property.value_date',
        'property.value_boolean',
        'property.value_json',
      ])
      .execute();
    if (rows.length === 0) return 0;

    // A row that vanishes is a value that changed, so the event says so — the
    // row's own history is what a delete costs, not its visibility.
    if (anchor.kind === 'node') {
      for (const row of rows) {
        collector.propertyTouched({
          nodeId: anchor.nodeId,
          nodeTypeId: anchor.nodeTypeId ?? null,
          propertyTypeId: row.property_type_id,
          before: row,
        });
      }
    }

    await trx
      .deleteFrom('property')
      .where(
        'id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();

    // The change rows carry no property_id: the FK cascade would delete them
    // along with the row they describe.
    const requestId = context.requestId ?? randomUUID();
    await recordChanges(
      rows.map((r) => ({
        teamId: context.teamId as unknown as string,
        requestId,
        source: context.changeSource,
        kind: ChangeKind.property_cleared,
        nodeId: anchor.kind === 'node' ? (anchor.nodeId as string) : null,
        edgeId: anchor.kind === 'edge' ? (anchor.edgeId as string) : null,
        oldValue: propertyToChangeValue(r),
        newValue: null,
        createdBy: context.createdBy ?? null,
      })),
      trx,
    );
    return rows.length;
  });
}

// ── Nodes ──────────────────────────────────────────────────────────────────

export interface EdgeAssertion {
  edgeTypeId: EdgeTypeId;
  otherNodeId: NodeId;
  /** `out`: the new node is the edge's source. `in`: it is the target. */
  direction: 'out' | 'in';
}

export interface CreateNodeInput {
  context: WriteContext;
  nodeTypeId: NodeTypeId | string;
  properties?: readonly PropertyWrite[];
  /** Edges asserted in the same transaction as the node (K-25). */
  edges?: readonly EdgeAssertion[];
  /** Bridge the new node to the external record that produced it. */
  bridge?: { adapterType: string; externalId: string; externalObjectType?: string | null };
}

export interface CreateNodeResult {
  nodeId: NodeId;
  written: WrittenProperty[];
  /** The edges asserted alongside the node, keyed by edge type. */
  edgeIdByType: Map<EdgeTypeId, EdgeId>;
}

export async function createNode(
  db: KnowledgeWriteDb,
  input: CreateNodeInput,
): Promise<CreateNodeResult> {
  return withCollector(db, input.context, async (trx, collector) => {
    const { context } = input;
    const requestId = context.requestId ?? randomUUID();
    const nodeTypeId = input.nodeTypeId as NodeTypeId;

    const node = await trx
      .insertInto('node')
      .values({ team_id: context.teamId, node_type_id: nodeTypeId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const nodeId = node.id;
    collector.nodeCreated(nodeId, nodeTypeId);

    await recordChange(
      {
        teamId: context.teamId as unknown as string,
        requestId,
        source: context.changeSource,
        kind: ChangeKind.node_created,
        nodeId: nodeId as string,
        createdBy: context.createdBy ?? null,
      },
      trx,
    );

    const all = input.properties ?? [];
    const propertyTypes = await loadPropertyTypes(trx, {
      teamId: context.teamId,
      propertyTypeIds: all.map((p) => p.propertyTypeId),
    });

    const nodeAnchored = all.filter(
      (p) => !propertyTypes.get(p.propertyTypeId as string)?.edge_type_id,
    );
    const edgeAnchored = all.filter(
      (p) => propertyTypes.get(p.propertyTypeId as string)?.edge_type_id,
    );

    const written = await setPropertiesIn(trx, {
      context: { ...context, requestId },
      anchor: { kind: 'node', nodeId, nodeTypeId },
      properties: nodeAnchored,
      propertyTypes,
    }, collector);

    const edgeIdByType = new Map<EdgeTypeId, EdgeId>();
    for (const edge of input.edges ?? []) {
      const { edgeId } = await linkIn(trx, {
        context: { ...context, requestId },
        edgeTypeId: edge.edgeTypeId,
        sourceNodeId: edge.direction === 'out' ? nodeId : edge.otherNodeId,
        targetNodeId: edge.direction === 'out' ? edge.otherNodeId : nodeId,
      }, collector);
      edgeIdByType.set(edge.edgeTypeId, edgeId);
    }

    for (const write of edgeAnchored) {
      const pt = propertyTypes.get(write.propertyTypeId as string)!;
      const edgeId = pt.edge_type_id ? edgeIdByType.get(pt.edge_type_id) : undefined;
      if (!edgeId) {
        logger.debug('[knowledge store] edge-anchored property with no edge of its type — skipping', {
          propertyTypeId: pt.id,
          edgeTypeId: pt.edge_type_id,
          asserted: [...edgeIdByType.keys()],
        });
        continue;
      }
      written.push(
        ...(await setPropertiesIn(trx, {
          context: { ...context, requestId },
          anchor: { kind: 'edge', edgeId },
          properties: [write],
          propertyTypes,
        }, collector)),
      );
    }

    if (input.bridge) {
      await trx
        .insertInto('linked_object')
        .values({
          team_id: context.teamId,
          node_id: nodeId,
          adapter_type: input.bridge.adapterType,
          external_id: input.bridge.externalId,
          external_object_type: input.bridge.externalObjectType ?? null,
          // The refresh path fills `data` from a fresh GET; the contract here
          // is "the bridge exists; data may follow".
          data: sql`'{}'::jsonb`,
        })
        .execute();
    }

    return { nodeId, written, edgeIdByType };
  });
}

/** Delete a node. FK cascades take its properties, edges, evidence and bridges. */
export async function deleteNode(
  db: KnowledgeWriteDb,
  input: { context: WriteContext; nodeId: NodeId | string },
): Promise<{ removed: boolean; nodeTypeId: NodeTypeId | null }> {
  const result = await deleteNodes(db, { context: input.context, nodeIds: [input.nodeId] });
  return { removed: result.deleted > 0, nodeTypeId: result.nodeTypeIds[0] ?? null };
}

export async function deleteNodes(
  db: KnowledgeWriteDb,
  input: { context: WriteContext; nodeIds: readonly (NodeId | string)[] },
): Promise<{ deleted: number; nodeTypeIds: NodeTypeId[] }> {
  const ids = [...new Set(input.nodeIds)] as NodeId[];
  if (ids.length === 0) return { deleted: 0, nodeTypeIds: [] };
  return withCollector(db, input.context, async (trx, collector) => {
    const { context } = input;
    const deleted = await trx
      .deleteFrom('node')
      .where('id', 'in', ids)
      .where('team_id', '=', context.teamId)
      .returning(['id', 'node_type_id'])
      .execute();
    if (deleted.length === 0) return { deleted: 0, nodeTypeIds: [] };

    for (const row of deleted) collector.nodeDeleted(row.id, row.node_type_id);

    // No node_id on the change row: the cascade would delete the record of the
    // deletion along with the node.
    const requestId = context.requestId ?? randomUUID();
    await recordChanges(
      deleted.map(() => ({
        teamId: context.teamId as unknown as string,
        requestId,
        source: context.changeSource,
        kind: ChangeKind.node_removed,
        createdBy: context.createdBy ?? null,
      })),
      trx,
    );
    return { deleted: deleted.length, nodeTypeIds: deleted.map((d) => d.node_type_id) };
  });
}

// ── Edges ──────────────────────────────────────────────────────────────────

export interface LinkInput {
  context: WriteContext;
  edgeTypeId: EdgeTypeId | string;
  sourceNodeId: NodeId | string;
  targetNodeId: NodeId | string;
}

/**
 * Assert an edge. Edge identity is (type, source, target), so this is an
 * idempotent upsert (D37e): asserting an edge that exists returns it and
 * changes nothing.
 */
export async function link(
  db: KnowledgeWriteDb,
  input: LinkInput,
): Promise<{ edgeId: EdgeId; created: boolean }> {
  return withCollector(db, input.context, (trx, collector) => linkIn(trx, input, collector));
}

async function linkIn(
  trx: KnowledgeWriteDb,
  input: LinkInput,
  collector: MutationCollector,
): Promise<{ edgeId: EdgeId; created: boolean }> {
  const { context } = input;
  const edgeTypeId = input.edgeTypeId as EdgeTypeId;
  const sourceNodeId = input.sourceNodeId as NodeId;
  const targetNodeId = input.targetNodeId as NodeId;

  const existing = await trx
    .selectFrom('edge')
    .where('edge.team_id', '=', context.teamId)
    .where('edge.edge_type_id', '=', edgeTypeId)
    .where('edge.source_node_id', '=', sourceNodeId)
    .where('edge.target_node_id', '=', targetNodeId)
    .select('edge.id')
    .executeTakeFirst();
  if (existing) return { edgeId: existing.id, created: false };

  const edge = await trx
    .insertInto('edge')
    .values({
      team_id: context.teamId,
      edge_type_id: edgeTypeId,
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  collector.edgeChanged({ sourceNodeId, targetNodeId, edgeTypeId });

  await trx
    .insertInto('evidence')
    .values({
      team_id: context.teamId,
      edge_id: edge.id,
      type: context.evidenceType,
      description: context.description,
      mutation_context:
        context.mutationContext === undefined ? null : jsonbValue(context.mutationContext),
    })
    .execute();

  await recordChange(
    {
      teamId: context.teamId as unknown as string,
      requestId: context.requestId ?? randomUUID(),
      source: context.changeSource,
      kind: ChangeKind.edge_created,
      edgeId: edge.id as string,
      createdBy: context.createdBy ?? null,
    },
    trx,
  );

  return { edgeId: edge.id, created: true };
}

/** Sever an edge named by its endpoints — the inverse of `link`, idempotent. */
export async function unlink(
  db: KnowledgeWriteDb,
  input: LinkInput,
): Promise<{ removed: boolean; edgeId: EdgeId | null }> {
  return withCollector(db, input.context, async (trx, collector) => {
    const { context } = input;
    const deleted = await trx
      .deleteFrom('edge')
      .where('edge.team_id', '=', context.teamId)
      .where('edge.edge_type_id', '=', input.edgeTypeId as EdgeTypeId)
      .where('edge.source_node_id', '=', input.sourceNodeId as NodeId)
      .where('edge.target_node_id', '=', input.targetNodeId as NodeId)
      .returning('edge.id')
      .executeTakeFirst();
    if (!deleted) return { removed: false, edgeId: null };
    collector.edgeChanged({
      sourceNodeId: input.sourceNodeId as NodeId,
      targetNodeId: input.targetNodeId as NodeId,
      edgeTypeId: input.edgeTypeId as EdgeTypeId,
    });
    await recordEdgeRemoved(trx, context);
    return { removed: true, edgeId: deleted.id };
  });
}

/** Sever an edge named by its id. */
export async function deleteEdge(
  db: KnowledgeWriteDb,
  input: { context: WriteContext; edgeId: EdgeId | string },
): Promise<{ removed: boolean }> {
  return withCollector(db, input.context, async (trx, collector) => {
    const { context } = input;
    const deleted = await trx
      .deleteFrom('edge')
      .where('edge.id', '=', input.edgeId as EdgeId)
      .where('edge.team_id', '=', context.teamId)
      .returning(['edge.id', 'edge.edge_type_id', 'edge.source_node_id', 'edge.target_node_id'])
      .executeTakeFirst();
    if (!deleted) return { removed: false };
    collector.edgeChanged({
      sourceNodeId: deleted.source_node_id,
      targetNodeId: deleted.target_node_id,
      edgeTypeId: deleted.edge_type_id,
    });
    await recordEdgeRemoved(trx, context);
    return { removed: true };
  });
}

async function recordEdgeRemoved(trx: KnowledgeWriteDb, context: WriteContext): Promise<void> {
  // No edge_id: the cascade would delete the change row with the edge.
  await recordChange(
    {
      teamId: context.teamId as unknown as string,
      requestId: context.requestId ?? randomUUID(),
      source: context.changeSource,
      kind: ChangeKind.edge_removed,
      createdBy: context.createdBy ?? null,
    },
    trx,
  );
}

/**
 * Move one end of an existing edge. The edge keeps its id, its properties and
 * its evidence, so this is its own change kind (D38a) rather than a remove plus
 * a create — that spelling would misdescribe what happened and orphan the
 * history that stayed put.
 *
 * Three nodes' adjacency moves: the end that stayed, the one that let go, and
 * the one that took its place.
 */
export async function retargetEdge(
  db: KnowledgeWriteDb,
  input: {
    context: WriteContext;
    edgeId: EdgeId | string;
    direction: 'source' | 'target';
    newNodeId: NodeId | string;
  },
): Promise<{ moved: boolean }> {
  return withCollector(db, input.context, async (trx, collector) => {
    const { context } = input;
    const column = input.direction === 'source' ? 'source_node_id' : 'target_node_id';
    const newNodeId = input.newNodeId as NodeId;

    const before = await trx
      .selectFrom('edge')
      .where('edge.id', '=', input.edgeId as EdgeId)
      .where('edge.team_id', '=', context.teamId)
      .select(['edge.edge_type_id', 'edge.source_node_id', 'edge.target_node_id'])
      .executeTakeFirst();
    if (!before) return { moved: false };

    const updated = await trx
      .updateTable('edge')
      .set({ [column]: newNodeId })
      .where('id', '=', input.edgeId as EdgeId)
      .where('team_id', '=', context.teamId)
      .returning('id')
      .executeTakeFirst();
    if (!updated) return { moved: false };

    collector.edgeChanged({
      sourceNodeId: before.source_node_id,
      targetNodeId: before.target_node_id,
      edgeTypeId: before.edge_type_id,
    });
    collector.edgeChanged({
      sourceNodeId: input.direction === 'source' ? newNodeId : before.source_node_id,
      targetNodeId: input.direction === 'target' ? newNodeId : before.target_node_id,
      edgeTypeId: before.edge_type_id,
    });

    await recordChange(
      {
        teamId: context.teamId as unknown as string,
        requestId: context.requestId ?? randomUUID(),
        source: context.changeSource,
        kind: ChangeKind.edge_retargeted,
        edgeId: updated.id as string,
        oldValue: { text: before[column] as string },
        newValue: { text: newNodeId as string },
        createdBy: context.createdBy ?? null,
      },
      trx,
    );

    return { moved: true };
  });
}

export { ChangeKind, ChangeSource, EvidenceType };
export { KnowledgeWriteRefused } from './values';
export type { PropertyTypeFacts } from './values';
