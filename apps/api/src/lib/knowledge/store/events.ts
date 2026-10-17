// What a graph mutation looks like on its way out of the unit, and the only
// seam it leaves by.
//
// The write door knows what changed — it read the old value on its way to
// writing the new one — so the events are derived HERE rather than by each
// caller diffing snapshots around its own write (K-15 deletes the last of
// those). Every door call collects its touches and, at the end of its
// transaction, turns them into outbox rows: an event exists exactly when the
// write it describes committed.
//
// Delivery is somebody else's job (the drainer). The store stays ignorant of
// who is listening, which is the whole point of an outbox.
//
// One field of the payload is load-bearing in a way that is easy to lose: the
// full mutation context, including whatever opaque origin the writer put in it.
// The consumer's echo suppression (`suppress_self` — the 2-way-sync semantic)
// is computed from the payload alone, and a context-less payload degrades it to
// "can't answer", which is logged and ignored. Every 2-way sync would start
// echoing itself and nothing would fail. So the context rides verbatim.

import { sql } from 'kysely';

import type { KnowledgeWriteDb } from './write';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../../generated/kysely/knowledge/NodeType';
import type { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';
import type { EdgeTypeId } from '../../../generated/kysely/knowledge/EdgeType';

import ChangeSource from '../../../generated/kysely/knowledge/ChangeSource';
import { neverAsAny } from 'movement-engine/public/types';

export type MutationChangeKind = 'create' | 'update' | 'delete';

export const MUTATION_EVENT_TYPES = ['record.created', 'record.updated', 'record.deleted'] as const;
export type MutationEventType = (typeof MUTATION_EVENT_TYPES)[number];

const EVENT_TYPE_BY_KIND: Record<MutationChangeKind, MutationEventType> = {
  create: 'record.created',
  update: 'record.updated',
  delete: 'record.deleted',
};

/**
 * The provenance the writer declared. Structurally typed on purpose: the store
 * persists and forwards this bag without interpreting it, so a writer can carry
 * fields the store has never heard of (and does).
 */
export interface MutationContextPayload {
  source: { type: string; [key: string]: unknown };
  occurredAt: string;
  actorId?: string;
  [key: string]: unknown;
}

/** One mutation, as the outside world reads it. */
export interface MutationEvent {
  recordId: string;
  nodeTypeId: string;
  changeKind: MutationChangeKind;
  /** Property type ids whose value actually changed; edge type ids for links. */
  changedFields: string[];
  context: MutationContextPayload;
}

/** The delivered body. One event per delivery, mirroring the valuations shape. */
export interface MutationEventEnvelope {
  event: MutationEventType;
  timestamp: string;
  data: MutationEvent;
}

export function envelopeFor(event: MutationEvent, occurredAt: string): MutationEventEnvelope {
  return { event: EVENT_TYPE_BY_KIND[event.changeKind], timestamp: occurredAt, data: event };
}

/**
 * A writer that declared no context still has one: the change source says what
 * kind of hand made the write. Nothing here names an adapter — the store does
 * not know what systems exist, and the consumer's suppression reads the source
 * type and the writer's own origin markers, both of which survive this.
 */
export function contextFromSource(input: {
  changeSource: ChangeSource;
  actorId?: string | null;
  occurredAt: string;
}): MutationContextPayload {
  return {
    source: { type: sourceTypeFor(input.changeSource) },
    occurredAt: input.occurredAt,
    ...(input.actorId ? { actorId: input.actorId } : {}),
  };
}

function sourceTypeFor(source: ChangeSource): string {
  switch (source) {
    case ChangeSource.user_edit:
      return 'user_edit';
    case ChangeSource.agent:
    case ChangeSource.mcp:
      return 'agent';
    case ChangeSource.api:
      return 'api';
    case ChangeSource.pipeline:
      return 'extraction';
    default:
      return neverAsAny(source);
  }
}

/** The six value columns, as the door reads them back to see what moved. */
export interface ValueSnapshot {
  value_text: string | null;
  value_text_array: string[] | null;
  value_number: string | null;
  value_date: Date | string | null;
  value_boolean: boolean | null;
  value_json: unknown;
}

/** The door's own handle — the collector only ever runs inside its transaction. */
type EventsDb = KnowledgeWriteDb;

interface TouchedNode {
  nodeTypeId: NodeTypeId | null;
  changeKind: MutationChangeKind;
  /** Property types written, with the value they had before. */
  properties: Map<PropertyTypeId, ValueSnapshot | null>;
  /** Edge types asserted or severed on this node — always a change. */
  edgeFields: Set<EdgeTypeId>;
}

/**
 * Collects one transaction's worth of graph touches and turns them into outbox
 * rows at commit. Created and flushed by the door; nothing outside it holds one.
 */
export class MutationCollector {
  private readonly nodes = new Map<NodeId, TouchedNode>();

  constructor(
    private readonly teamId: string,
    private readonly context: MutationContextPayload,
  ) {}

  nodeCreated(nodeId: NodeId, nodeTypeId: NodeTypeId): void {
    this.entry(nodeId).changeKind = 'create';
    this.entry(nodeId).nodeTypeId = nodeTypeId;
  }

  nodeDeleted(nodeId: NodeId, nodeTypeId: NodeTypeId | null): void {
    const entry = this.entry(nodeId);
    entry.changeKind = 'delete';
    entry.nodeTypeId = nodeTypeId;
  }

  /** A node-anchored property write, with the row as it stood beforehand. */
  propertyTouched(input: {
    nodeId: NodeId;
    nodeTypeId?: NodeTypeId | null;
    propertyTypeId: PropertyTypeId;
    before: ValueSnapshot | null;
  }): void {
    const entry = this.entry(input.nodeId);
    if (input.nodeTypeId && !entry.nodeTypeId) entry.nodeTypeId = input.nodeTypeId;
    if (!entry.properties.has(input.propertyTypeId)) {
      entry.properties.set(input.propertyTypeId, input.before);
    }
  }

  /**
   * An edge asserted or severed. Both endpoints changed — adjacency is a fact
   * about each of them — and the edge type is the field that moved.
   */
  edgeChanged(input: { sourceNodeId: NodeId; targetNodeId: NodeId; edgeTypeId: EdgeTypeId }): void {
    for (const nodeId of [input.sourceNodeId, input.targetNodeId]) {
      this.entry(nodeId).edgeFields.add(input.edgeTypeId);
    }
  }

  private entry(nodeId: NodeId): TouchedNode {
    let entry = this.nodes.get(nodeId);
    if (!entry) {
      entry = { nodeTypeId: null, changeKind: 'update', properties: new Map(), edgeFields: new Set() };
      this.nodes.set(nodeId, entry);
    }
    return entry;
  }

  /**
   * Derive the events and enqueue them, inside the caller's transaction.
   *
   * Values are re-read here rather than taken from what was written, because a
   * property may be arbitrated after its write (the door's observer seam) — the
   * event has to describe what the graph now says, not what the caller asked
   * for. An update that moved nothing emits nothing.
   */
  async flush(trx: EventsDb): Promise<MutationEvent[]> {
    if (this.nodes.size === 0) return [];

    const after = await this.readAfterValues(trx);
    await this.fillMissingNodeTypes(trx);

    const events: MutationEvent[] = [];
    for (const [nodeId, entry] of this.nodes) {
      if (!entry.nodeTypeId) continue; // a node we cannot name is not describable

      const changedFields: string[] = [...entry.edgeFields];
      for (const [propertyTypeId, before] of entry.properties) {
        const now = after.get(`${nodeId}:${propertyTypeId}`) ?? null;
        if (entry.changeKind === 'create' || !sameValue(before, now)) {
          changedFields.push(propertyTypeId as string);
        }
      }

      if (entry.changeKind === 'update' && changedFields.length === 0) continue;

      events.push({
        recordId: nodeId as string,
        nodeTypeId: entry.nodeTypeId as string,
        changeKind: entry.changeKind,
        changedFields: entry.changeKind === 'delete' ? [] : changedFields,
        context: this.context,
      });
    }

    if (events.length > 0) await this.enqueue(trx, events);
    return events;
  }

  private async enqueue(trx: EventsDb, events: MutationEvent[]): Promise<void> {
    const occurredAt = this.context.occurredAt;
    await trx
      .insertInto('mutation_outbox')
      .values(
        events.map((event) => ({
          team_id: this.teamId,
          event_type: EVENT_TYPE_BY_KIND[event.changeKind],
          node_id: event.recordId,
          payload: sql`${JSON.stringify(envelopeFor(event, occurredAt))}::jsonb`,
        })),
      )
      .execute();
  }

  private async readAfterValues(trx: EventsDb): Promise<Map<string, ValueSnapshot | null>> {
    const pairs: { nodeId: NodeId; propertyTypeId: PropertyTypeId }[] = [];
    for (const [nodeId, entry] of this.nodes) {
      if (entry.changeKind === 'delete') continue;
      for (const propertyTypeId of entry.properties.keys()) pairs.push({ nodeId, propertyTypeId });
    }
    if (pairs.length === 0) return new Map();

    const rows = await trx
      .selectFrom('property')
      .where('property.team_id', '=', this.teamId)
      .where(
        'property.node_id',
        'in',
        pairs.map((p) => p.nodeId),
      )
      .where(
        'property.property_type_id',
        'in',
        pairs.map((p) => p.propertyTypeId),
      )
      .select([
        'property.node_id',
        'property.property_type_id',
        'property.value_text',
        'property.value_text_array',
        'property.value_number',
        'property.value_date',
        'property.value_boolean',
        'property.value_json',
      ])
      .execute();

    const byPair = new Map<string, ValueSnapshot | null>();
    for (const row of rows) {
      byPair.set(`${row.node_id}:${row.property_type_id}`, {
        value_text: row.value_text,
        value_text_array: row.value_text_array,
        value_number: row.value_number,
        value_date: row.value_date,
        value_boolean: row.value_boolean,
        value_json: row.value_json,
      });
    }
    return byPair;
  }

  /** An edge write names two nodes and no types; the graph knows theirs. */
  private async fillMissingNodeTypes(trx: EventsDb): Promise<void> {
    const unknown = [...this.nodes.entries()]
      .filter(([, entry]) => !entry.nodeTypeId)
      .map(([nodeId]) => nodeId);
    if (unknown.length === 0) return;

    const rows = await trx
      .selectFrom('node')
      .where('node.team_id', '=', this.teamId)
      .where('node.id', 'in', unknown)
      .select(['node.id', 'node.node_type_id'])
      .execute();
    for (const row of rows) {
      const entry = this.nodes.get(row.id);
      if (entry) entry.nodeTypeId = row.node_type_id;
    }
  }
}

/** Two readings of the same property column set, compared as pg would print them. */
function sameValue(a: ValueSnapshot | null, b: ValueSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.value_text === b.value_text &&
    sameArray(a.value_text_array, b.value_text_array) &&
    sameNumber(a.value_number, b.value_number) &&
    sameDate(a.value_date, b.value_date) &&
    a.value_boolean === b.value_boolean &&
    JSON.stringify(a.value_json ?? null) === JSON.stringify(b.value_json ?? null)
  );
}

function sameArray(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameNumber(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Number(a) === Number(b);
}

function sameDate(a: Date | string | null, b: Date | string | null): boolean {
  if (a === null || b === null) return a === b;
  const at = a instanceof Date ? a.getTime() : new Date(a).getTime();
  const bt = b instanceof Date ? b.getTime() : new Date(b).getTime();
  return at === bt;
}
