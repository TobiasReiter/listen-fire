// The walk, said in the agent's vocabulary.
//
// `edgesFrom` answers in the adapter's terms — field ids, type ids, flags whose
// absence carries meaning. This module turns ONE hop into the thing an agent
// reads: the node, its properties, and its edges, each edge carrying what it
// lands on. One shape at every depth; the root is just the node you get when
// you pass no position.
//
// Two rules shape everything here:
//
//   - **Truth, never a default the reader must know.** An edge's `writable` is
//     absent-means-no and its `readable` is absent-means-yes. That asymmetry is
//     ergonomic for adapter authors and a trap for anyone reading the result,
//     so both arrive resolved.
//   - **The caller echoes an address, never builds one.** Every edge hands back
//     the path that walks it, composed onto the path already walked. The string
//     that explores is the string an author writes in a movement.

import type { FieldType } from 'movement-lang';
import type { EdgesFromResult, EdgeTargetNode } from 'movement-engine/public/adapter';
import type { SchemaFieldDescriptor, SchemaReferenceDescriptor, SchemaTypeDescriptor } from 'movement-engine/public/catalog';
import type { UniquenessConstraints } from 'movement-engine/public/adapter-support';

import { positionLabelEntry, referenceTargetTypeIds } from 'movement-engine/public/catalog';
import { fieldTypeFromDescriptor } from 'movement-engine/public/catalog';
import { narrowByOf } from './narrowing';

export interface WalkedProperty {
  type: FieldType;
  /** Resolved, never inferred by the reader: a field's `readable` defaults
   *  true, its `writable` is stated outright. */
  readable: boolean;
  writable: boolean;
  required: boolean;
  description?: string;
}

/**
 * A node as an edge's LANDING — everything it says about itself except its own
 * onward edges. The omission is the contract: an agent holds the landing's
 * fields, so it can author a write with no further call, while deciding to walk
 * further costs exactly one hop.
 *
 * ...unless the adapter judged describing it too expensive, in which case the
 * landing is a STUB: named, and saying so. An agent reading `stub: true` knows
 * the fields exist and cost one hop; it must never read a stub as a node that
 * happens to have no fields.
 *
 * Mirrors `EdgeTargetNode` on the adapter side.
 */
export type WalkedNodeShape = WalkedDescribedNode | WalkedStubNode;

export interface WalkedDescribedNode {
  name: string;
  description?: string;
  properties: Record<string, WalkedProperty>;
  /** What identifies one of these records: each entry is a combination of
   *  names (properties, or this node's own edges) that the source treats as
   *  unique — a `unique by` candidate. Absent when the source declares none.
   *  A rule naming anything this node cannot spell is left out rather than
   *  half-stated. */
  unique?: string[][];
  stub?: false;
}

/** Named, not described. `properties` is ABSENT rather than empty — an empty
 *  map would claim the node has no fields, which is a different (and false)
 *  statement from "we did not fetch them". */
export interface WalkedStubNode {
  name: string;
  description?: string;
  stub: true;
  /** What to do about it, in the agent's own terms. */
  hint: string;
}

export interface WalkedMember {
  name: string;
  /** The narrowing that reaches this member — echo it as a position. */
  position: string;
}

export interface WalkedEdge {
  name: string;
  description?: string;
  cardinality: 'one' | 'many';
  readable: boolean;
  writable: boolean;
  /** Present only when true: this edge DELIVERS its target (what a listen
   *  subscribes to) rather than letting you fetch it. */
  fires?: true;
  firesOn?: string[];
  /** Present only when true: writing here performs an action and materialises
   *  nothing. */
  ephemeral?: true;
  /** Present only when true: this edge is AWAITED (`await x-[:E]->`), not read —
   *  its promise is a resolution that resumes a parked run, so it is honestly
   *  neither `readable` nor `writable` (asks-as-adapter §A). Surfaced on the
   *  graph-explorer / describe path so the tooling reads it as a promise; the
   *  ENGINE consumption is a later chunk (this is declaration-only for now). */
  awaitable?: true;
  /** Present only when true (and only meaningful with `awaitable`): a resolution
   *  along this edge may carry NO landing (an explicit cancel). */
  resolvesEmpty?: true;
  /** Present only when true (and only meaningful with `awaitable`): the source
   *  DELIVERS an event when this edge resolves, so `await FIRST(…)` waits
   *  without a cadence. Absent means the author states one (`until … every:`). */
  watchable?: true;
  /** The address that walks this edge. Absent when the adapter handed over no
   *  path — the edge is real, but reaching it is by name, not by walking. */
  position?: string;
  /** A polymorphic edge is ONE edge with MANY members (Airtable's bases). The
   *  members ride the edge because that is where the fact is true — which
   *  bases exist is a fact about the hop, not about the workspace. */
  members?: WalkedMember[];
  /** The fields a narrowing predicate may test, drawn from what the adapter
   *  labelled its members with. Without it the names are visible but there is
   *  no way to tell what to write a `WHERE` against. */
  narrowBy?: string[];
  /** What you land on. ABSENT means the target was not hydrated — a different
   *  fact from a landing with no properties, and the reason it is optional. */
  target?: WalkedNodeShape;
  /**
   * The types this ONE edge can land on, when the landing varies per record (an
   * Attio reference allowed on both People and Companies). There is no single
   * `target` to name, and that is the fact — not a missing hydration.
   *
   * Distinct from `members`, which are things you pick between with a `WHERE`
   * at authoring time. These are decided by the DATA: an automation traverses
   * the edge, gets a mixed set, and narrows with an `IS` test per record.
   */
  landsOn?: string[];
}

/** The node you asked about is ALWAYS described — you walked to it, so the
 *  fetch has already happened. Only an edge's target can be a stub. */
export interface WalkedNode extends WalkedDescribedNode {
  /** The address of THIS node — empty at the root. Every edge's address is
   *  built onto it. */
  position: string;
  edges: WalkedEdge[];
}

/** The name an edge is addressed by. `name` when the adapter gave one, else the
 *  field id doubles as it — the same rule `stepTo` resolves a hop with. */
const edgeName = (reference: SchemaReferenceDescriptor): string =>
  reference.name ?? reference.fieldId;

/** A named hop, written the way an author writes it. */
const namedStep = (name: string): string => `-[:\`${name}\`]->`;

/** A narrowed hop: the polymorphic edge, plus the predicate that picks one
 *  member. `JSON.stringify` on the value so a label containing a quote cannot
 *  produce an address that no longer parses. */
const narrowedStep = (input: { edge: string; key: string; value: string }): string =>
  `-[:${input.edge} WHERE \`${input.key}\` == ${JSON.stringify(input.value)}]->`;

function propertiesOf(fields: SchemaFieldDescriptor[]): Record<string, WalkedProperty> {
  const properties: Record<string, WalkedProperty> = {};
  for (const field of fields) {
    const type = fieldTypeFromDescriptor(field);
    // A reference field has no property type — it surfaces as an edge, which
    // is the whole point of the walk.
    if (type === undefined) continue;
    properties[field.displayName] = {
      type,
      readable: field.readable ?? true,
      writable: field.writable,
      required: field.required,
      ...(field.description !== undefined ? { description: field.description } : {}),
    };
  }
  return properties;
}

/**
 * The source's own identity rules, renamed from its field ids to the names an
 * author writes. The same mapping the schema projection makes for a write
 * shape's `nativeUniqueness`, so the walk and the checker name the same keys.
 */
function uniqueOf(input: {
  constraints: UniquenessConstraints | undefined;
  fields: SchemaFieldDescriptor[];
  references?: SchemaReferenceDescriptor[];
}): string[][] {
  const surface = new Map<string, string>([
    ...input.fields.map((field) => [field.fieldId, field.displayName] as const),
    ...(input.references ?? []).map((reference) => [reference.fieldId, edgeName(reference)] as const),
  ]);
  return (input.constraints?.any ?? []).flatMap((branch) => {
    const names = branch.all.map((entry) => surface.get(entry.field));
    if (names.length === 0 || names.some((name) => name === undefined)) return [];
    return [names.filter((name): name is string => name !== undefined)];
  });
}

function uniqueEntry(unique: string[][]): { unique?: string[][] } {
  return unique.length > 0 ? { unique } : {};
}

/** A described type as an edge's landing: its fields and identity, no onward
 *  edges — the shape `describeMovementLandings` hands back for a stub resolved
 *  by name. */
export function landingOf(node: SchemaTypeDescriptor): WalkedDescribedNode {
  return {
    name: node.displayName,
    ...(node.description !== undefined ? { description: node.description } : {}),
    properties: propertiesOf(node.fields),
    ...uniqueEntry(uniqueOf({ constraints: node.uniquenessConstraints, fields: node.fields })),
  };
}

function shapeOf(input: { node: EdgeTargetNode; at: string }): WalkedNodeShape {
  const { node } = input;
  const named = {
    name: node.displayName,
    ...(node.description !== undefined ? { description: node.description } : {}),
  };
  if (node.stub === true) {
    return {
      ...named,
      stub: true,
      // Said in the second person, with the address in hand: a stub is only
      // useful if the reader knows it is one hop from being resolved.
      hint: `describe this connection at ${JSON.stringify(input.at)} to see this node's fields`,
    };
  }
  return {
    ...named,
    properties: propertiesOf(node.fields),
    ...uniqueEntry(uniqueOf({ constraints: node.uniquenessConstraints, fields: node.fields })),
  };
}

/**
 * The members of ONE polymorphic edge: the paths this hop handed over that
 * belong to it, named by the label the adapter minted onto each.
 *
 * A member is matched by `recordType` — the same gate `stepTo` applies when
 * following the hop, so nothing can be listed here that could not then be
 * walked to — AND by having no reference row of its own. That second half is
 * what makes it a member rather than a named edge: a path filed under a
 * reference's `fieldId` IS that edge's own address, not something reached by
 * narrowing it.
 *
 * Without it, any adapter whose named paths carry `recordType` equal to the
 * edge name files a phantom member under the edge's own name — Affinity's
 * `-[:Organization]->` offered `WHERE \`Name\` == "Organization"`, a narrowing
 * to itself. The adapter's own comment warned about exactly this shape; the
 * rule simply lived in the old explorer's builder and not here.
 */
function membersOf(input: {
  hop: EdgesFromResult;
  edge: string;
  at: string;
  /** Every `fieldId` this hop published a reference for — the keys that are
   *  edge addresses rather than members. */
  namedFieldIds: ReadonlySet<string>;
}): {
  members: WalkedMember[];
  /** Every key the members were labelled with — what a `WHERE` may test. Read
   *  off the members themselves, so it cannot name a field no member carries. */
  narrowBy: string[];
} {
  const members: WalkedMember[] = [];
  const labelled: Array<{ data: unknown }> = [];

  for (const [fieldId, position] of Object.entries(input.hop.targetPositions ?? {})) {
    if (input.namedFieldIds.has(fieldId)) continue;
    if (position.recordType !== input.edge) continue;
    labelled.push({ data: position.identity.data });
    const label = positionLabelEntry(position);
    if (!label) continue;
    members.push({
      name: label.value,
      position: input.at + narrowedStep({ edge: input.edge, key: label.key, value: label.value }),
    });
  }

  return { members, narrowBy: members.length > 0 ? narrowByOf(labelled) : [] };
}

/**
 * One hop, projected. `at` is the address already walked — empty at the root —
 * so every address this returns is absolute and can be echoed straight back.
 */
export function walkedNodeFrom(input: { hop: EdgesFromResult; at: string }): WalkedNode {
  const { hop, at } = input;
  const descriptor: SchemaTypeDescriptor = hop.descriptor;

  const namedFieldIds = new Set(descriptor.references.map((reference) => reference.fieldId));

  const edges = descriptor.references.map((reference): WalkedEdge => {
    const name = edgeName(reference);
    const { members, narrowBy } = membersOf({ hop, edge: name, at, namedFieldIds });
    const target = hop.targetNodes?.[reference.fieldId];
    // A named edge's path sits under its own field id. A polymorphic edge has
    // none of its own — its members carry the paths — so it offers no single
    // address, and narrowing to a member is how you walk it.
    const path = hop.targetPositions?.[reference.fieldId];

    return {
      name,
      ...(reference.description !== undefined ? { description: reference.description } : {}),
      cardinality: reference.cardinality,
      readable: reference.readable ?? true,
      writable: reference.writable ?? false,
      ...(reference.fires === true ? { fires: true as const } : {}),
      ...(reference.firesOn !== undefined ? { firesOn: reference.firesOn } : {}),
      ...(reference.ephemeral === true ? { ephemeral: true as const } : {}),
      ...(reference.awaitable === true ? { awaitable: true as const } : {}),
      ...(reference.resolvesEmpty === true ? { resolvesEmpty: true as const } : {}),
      ...(reference.watchable === true ? { watchable: true as const } : {}),
      ...(path !== undefined ? { position: at + namedStep(name) } : {}),
      ...(reference.targetTypeIds !== undefined
        ? { landsOn: referenceTargetTypeIds(reference) }
        : {}),
      ...(members.length > 0 ? { members } : {}),
      ...(narrowBy.length > 0 ? { narrowBy } : {}),
      ...(target !== undefined
        ? { target: shapeOf({ node: target, at: path !== undefined ? at + namedStep(name) : at }) }
        : {}),
    };
  });

  return {
    position: at,
    name: descriptor.displayName,
    ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
    properties: propertiesOf(descriptor.fields),
    ...uniqueEntry(
      uniqueOf({
        constraints: descriptor.uniquenessConstraints,
        fields: descriptor.fields,
        references: descriptor.references,
      }),
    ),
    edges,
  };
}
