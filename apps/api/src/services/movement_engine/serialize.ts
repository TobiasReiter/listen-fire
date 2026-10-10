// The scope serialize / rehydrate seam (async user interaction §4.1, §4.6).
//
// A parked movement run survives a process boundary for days. Its scope — the
// `Binding`s feeding the parked `ask` — is ALMOST entirely plain data; the live
// refs are a small closed set. `serializeBinding` turns a live `Binding` into a
// plain-JSON descriptor (a tagged variant per binding kind); `rehydrateBinding`
// rebuilds the live `Binding` from a descriptor + a rehydration context that
// re-resolves the live refs. The two are inverse modulo live refs (an adapter is
// re-resolved, a FileRef's `retrieve()` rebound, an instance schema re-fetched,
// code refs taken from the re-parsed AST).
//
// The three buckets (§4.1):
//   1. Pure data — serialise as-is: `event`, `value`, `handle`,
//      `extractRoot`/`extractPosition` (the materialised emission — the extraction
//      RAN, its output is data, never re-run), the data half of `sourcePosition`
//      (`SourcePosition` + `edgeProperties`), `shapePosition`.
//   2. A live ref behind a serialisable identity — rebind on rehydrate: the
//      adapter inside `instance` and `sourcePosition.read` (re-resolved by
//      slug+creds via the registry; `edgeFieldId` re-derived; the instance schema
//      RE-FETCHED live, never serialised), and the `retrieve()` closure inside a
//      `resource`'s FileRef (rebound via the FileRef-revive pattern — `source`).
//   3. Code refs — NOT serialised, re-resolved from the re-parsed (version-pinned)
//      program: `shape` declarations, `movement` callables, `opaque` imports. By
//      name against the rehydration context's code resolver. `blockMeta` and
//      `positions` are recursive (their contained bindings serialise per these
//      rules). A `closure` carries its BODY as AST — it has no name to
//      re-resolve by — plus its capture, recursively.
//
// A node the run built is an object held by reference, so one park numbers
// each such node the first time it writes it and writes a reference after
// (`ParkWriter` / `ParkReader`): sharing and cycles survive the park.
//
// Guard: a `value` binding's payload is `unknown`. The seam asserts it is
// JSON-serialisable at the boundary, so a non-serialisable value fails LOUD at
// park (never corrupts the parked scope).
//
// This module is pure: all DB / registry / FileRef access stays behind the
// injected `RehydrationContext`, exactly as the interpreter keeps `resolveAdapter`
// / `parkSink` behind seams.

import type {
  ClosureExpression,
  CollectionOpExpression,
  NodeLiteral,
  PathHead,
  ShapeDeclaration,
} from 'movement-lang';
import type { FileRef, Resource } from '../translation_graph/adapter';
import type { SourcePosition } from '../translation_graph/types';
import type { ExtractEmission } from './extraction';
import type {
  Binding,
  DeferredWalk,
  Environment,
  HandleGraph,
  LocalLandingShape,
  NodeEdge,
  SourceRead,
  WriteRecord,
} from './expression';
import { bindValue, binding, bindingOf, isDictValue } from './expression';
import { isFileRef, reviveFileRefs } from '../translation_graph/engine/files/retrieve';
import type { Provenance } from './provenance';
import { MovementEngineError } from './errors';

// ── The descriptor (plain JSON) ──────────────────────────────────────────────

/**
 * A serialised instance identity — the construction-free facts the registry
 * re-resolves a live adapter from. The `schema` is deliberately ABSENT: an
 * instance represents a live system, so its schema is RE-FETCHED on rehydrate
 * (honest drift if the external schema changed — §4.1 decision).
 */
export interface InstanceIdentityDescriptor {
  name: string;
  adapterSlug: string;
  credentialName?: string;
  constructionConfig?: Record<string, string>;
}

/** The serialised `SourceRead` — just the instance identity behind it. The live
 *  `adapter` + the `edgeFieldId` closure are rebound from `instanceName` on
 *  rehydrate. */
export interface SourceReadDescriptor {
  instanceName: string;
}

/** A wire FileRef — the remote adapter's wire form: metadata + the
 *  owner-resolvable `source` handle, no closure. Rehydrate rebinds `retrieve()`
 *  from `source` (the FileRef-revive pattern). */
export interface FileRefDescriptor {
  name?: string;
  contentType?: string;
  size?: number;
  source?: { ownerAdapterType: string; handle: string };
  url?: string | null;
}

/** A serialised `ExtractEmission` — its `children` Map flattened to a record of
 *  arrays (JSON has no Map). The emission is pure data (the extraction ran). */
export interface ExtractEmissionDescriptor {
  nodeName: string;
  fields: Record<string, unknown>;
  /** `fields`' keys in declaration order — the parked state is jsonb, which
   *  reorders an object's keys. Absent on a park written before it was kept. */
  fieldOrder?: string[];
  provenance: ExtractEmission['provenance'];
  origin?: ExtractEmission['origin'];
  /** Layer-5 source resources — `fileRef` closures stripped to descriptors
   *  (Bucket 2), revived through the seam on rehydrate. */
  resources: ResourceDescriptor[];
  children: Record<string, ExtractEmissionDescriptor[]>;
}

export type BindingDescriptor =
  | { kind: 'event' }
  | { kind: 'instance'; instance: InstanceIdentityDescriptor }
  | {
      kind: 'handle';
      handle: Omit<WriteRecord, 'old'>;
      targetType: string;
      graph: HandleGraphDescriptor;
      /** The record before the handle's write (`-[:@old]->`), itself a
       *  handle. A rehearsed write's `old` is the handle itself, which JSON
       *  cannot nest, so it is said instead (`oldIsSelf`). */
      old?: BindingDescriptor;
      oldIsSelf?: true;
    }
  | { kind: 'extractRoot'; emission: ExtractEmissionDescriptor }
  | { kind: 'extractPosition'; emission: ExtractEmissionDescriptor }
  | {
      kind: 'sourcePosition';
      position: SourcePosition;
      edgeProperties?: Record<string, unknown>;
      read?: SourceReadDescriptor;
    }
  | { kind: 'resource'; resource: ResourceDescriptor }
  | { kind: 'blockMeta'; edges: Record<string, BindingDescriptor[]>; plural?: true }
  /** Bucket 3 (recursive) — a block's returned landings. */
  | { kind: 'positions'; landings: BindingDescriptor[] }
  | { kind: 'tuple'; slots: BindingDescriptor[] }
  /**
   * Bucket 3 (recursive) — a closure. Its BODY rides across as AST, exactly as
   * a deferred walk's head does: the version pin makes it byte-identical on the
   * other side, and re-deriving it from a name would need the closure to have
   * one. Its capture serialises by the ordinary rules.
   */
  | {
      kind: 'closure';
      closure: ClosureExpression;
      captured: Record<string, BindingDescriptor>;
      /** The name its body calls itself by (`Binding` closure's `self`). */
      self?: string;
    }
  | { kind: 'value'; value: unknown; provenance?: Provenance; many?: true }
  /**
   * Bucket 3 (recursive) — a VALUE that holds records: a `MAP` answer whose
   * function returned the member, a list literal of them, a `GROUPBY` dict.
   * A record is a value, so a value can hold one; and a record does NOT
   * survive `JSON.stringify` (an extract emission's children are a `Map`, a
   * file ref is a closure), so it travels by its own descriptor, exactly as a
   * block's returned landings do.
   *
   * Its own descriptor kind rather than a richer `value`: a parked run written
   * before this existed still reads as `value`, and one written after says so.
   */
  | { kind: 'recordValue'; value: ValueDescriptor; provenance?: Provenance; many?: true }
  /** Bucket 1 — a minted callback is pure data: its id, its link, its fire-time
   *  signature. The CALLS are deliberately NOT here (they arrive after the park
   *  and are read live from the store), and neither is the body (it is code, at
   *  the address the store row names). */
  | {
      kind: 'callback';
      callbackId: string;
      url: string;
      params: Extract<Binding, { kind: 'callback' }>['params'];
    }
  // Bucket 3 — code refs carry ONLY the re-resolution tag (the name). The live
  // declaration / fileEnv comes from the re-parsed program.
  | { kind: 'shape'; name: string }
  /** A node declaration made in a BODY: the re-parsed file scope does not hold
   *  it, so it travels as the declaration — code that is already data, as a
   *  closure's body is. */
  | { kind: 'localShape'; declaration: ShapeDeclaration }
  | { kind: 'movement'; name: string }
  | { kind: 'shapePosition'; shape: string; node: string; fields: Record<string, unknown>; fieldProvenance: Extract<Binding, { kind: 'shapePosition' }>['fieldProvenance'] }
  /** Bucket 3 (recursive) — a synthesised node. Its entry VALUES are already
   *  data; each edge is either landings (bindings, serialised like a
   *  meta-node's) or a deferred WALK. */
  | {
      kind: 'nodePosition';
      /** Its number in the park's identity table — what a later `nodeRef` to
       *  the same node names. Absent on a park written before nodes kept their
       *  identity: that node comes back on its own, as it always did. */
      id?: number;
      fields: Record<string, unknown>;
      /** Absent on a park written before the order was kept — the stored
       *  map's own keys stand in, in whatever order jsonb returned them. */
      fieldOrder?: string[];
      fieldProvenance: Extract<Binding, { kind: 'nodePosition' }>['fieldProvenance'];
      landedOn?: string;
      edges: Record<string, NodeEdgeDescriptor>;
    }
  /**
   * A run-built node this park has already written — reached again through a
   * second binding, a second graph, or a cycle back to itself. It names the
   * node's `id`, so the resumed run gets back the ONE node both places held:
   * a write through one is seen through the other, and a cycle stays a cycle
   * instead of unrolling forever.
   */
  | { kind: 'nodeRef'; id: number }
  /** Bucket 3 (recursive) — a stored, unrun traversal. */
  | { kind: 'lazyWalk'; walk: DeferredWalkDescriptor }
  | { kind: 'opaque'; what: string; name: string };

/**
 * A value, serialised with its records intact. Data is data; a record is the
 * binding it is; a list and a map are themselves, member by member. The shape
 * mirrors the value rather than tagging it, so nothing has to recognise a
 * magic key inside somebody's data.
 */
export type ValueDescriptor =
  | { kind: 'data'; value: unknown }
  | { kind: 'record'; binding: BindingDescriptor }
  | { kind: 'list'; of: ValueDescriptor[] }
  | { kind: 'map'; of: Record<string, ValueDescriptor> };

export type NodeEdgeDescriptor =
  /** `landingShape` rides across because it is what a write AFTER the resume
   *  mints its landing's edges from — dropping it would make the same write
   *  build a landing with no nested edges, which a later `link` could not
   *  append to. */
  | {
      kind: 'landed';
      landings: BindingDescriptor[];
      landing?: LocalLandingShape;
      /** The earlier spelling — nested edge names only, `{ founder: {} }` —
       *  which a park written before field order was kept still carries. */
      landingShape?: LegacyLandingShape;
    }
  | { kind: 'deferred'; walk: DeferredWalkDescriptor };

interface LegacyLandingShape {
  [edge: string]: LegacyLandingShape;
}

function fromLegacyLandingShape(legacy: LegacyLandingShape): LocalLandingShape {
  return {
    fields: [],
    edges: Object.fromEntries(
      Object.entries(legacy).map(([edge, nested]) => [edge, fromLegacyLandingShape(nested)]),
    ),
  };
}

function landingShapeOf(
  edge: Extract<NodeEdgeDescriptor, { kind: 'landed' }>,
): { landingShape?: LocalLandingShape } {
  if (edge.landing !== undefined) return { landingShape: edge.landing };
  return edge.landingShape !== undefined
    ? { landingShape: fromLegacyLandingShape(edge.landingShape) }
    : {};
}

/** `fields` rebuilt in `order` — the parked state is jsonb, whose objects come
 *  back with their keys reordered. */
function inOrder(fields: Record<string, unknown>, order: readonly string[] | undefined): Record<string, unknown> {
  if (order === undefined) return fields;
  const ordered: Record<string, unknown> = {};
  for (const key of order) if (key in fields) ordered[key] = fields[key];
  for (const [key, value] of Object.entries(fields)) if (!(key in ordered)) ordered[key] = value;
  return ordered;
}

/**
 * A stored walk, serialised: the traversal's own text plus the scope it
 * captured, each captured binding serialised by the ordinary rules — and its
 * per-item `mapping`, which is AST and rides across as itself.
 *
 * The LANDINGS are deliberately not here, mapped or not. A lazy walk has none
 * until something reads it, and re-walking after a resume is the CORRECT
 * answer, not a concession: a run that parked for a day and woke should see the
 * source as it is now (layer 8 ruling 3 — every read re-walks; there is no
 * cache to preserve across a park either). What parks is the RECIPE — the walk
 * and the renaming — never anything either produced.
 */
export interface DeferredWalkDescriptor {
  head: PathHead;
  captured: Record<string, BindingDescriptor>;
  mapping?: NodeLiteral;
}

/** The `HandleGraph` serialised — its `instance` is an instance identity
 *  (Bucket 2), re-resolved on rehydrate. */
export type HandleGraphDescriptor = {
  kind: 'instance';
  instance: InstanceIdentityDescriptor;
};

/** A serialised `Resource` — every field is plain data except `fileRef`, whose
 *  closure is stripped to a `FileRefDescriptor` (Bucket 2). */
export type ResourceDescriptor = Omit<Resource, 'fileRef'> & { fileRef?: FileRefDescriptor };

// ── The rehydration context (chunk 5 passes this in) ──────────────────────────

/**
 * The seams `rehydrateBinding` rebinds live refs through. Mirrors the
 * interpreter's own injected seams (`resolveAdapter`, `parkSink`): the pure
 * function never touches the DB / registry / AST directly.
 */
export interface RehydrationContext {
  /**
   * Re-resolve a live instance: the registry yields the adapter (by slug +
   * credential), and the instance schema is RE-FETCHED live (never serialised).
   * Returns the live `instance` binding chunk 5 binds back into scope.
   */
  resolveInstance(identity: InstanceIdentityDescriptor): Promise<Extract<Binding, { kind: 'instance' }>>;
  /**
   * The live read seam for a named instance — the same `SourceRead`
   * the interpreter threads onto positions: the re-resolved adapter +
   * re-derived `edgeFieldId`. Used to rebind `sourcePosition.read`.
   */
  resolveSourceRead(instanceName: string): Promise<SourceRead>;
  /**
   * Rebind a wire FileRef's `retrieve()` from its `source` handle — the owner
   * adapter's `resolveFileRef`, or the document store for `FILE()` artifacts
   * (the same pattern `reviveFileRefs` uses across the wire).
   */
  reviveFileRef(descriptor: FileRefDescriptor): FileRef;
  /**
   * Re-resolve a code ref (`shape` / `movement` / `opaque` import) by name
   * against the re-parsed program's environment — the version pin (P11) makes
   * the AST byte-identical, so the name resolves to an equivalent declaration.
   */
  resolveCodeRef(name: string): Binding;
}

// ── One park's identity table ─────────────────────────────────────────────────

type NodePosition = Extract<Binding, { kind: 'nodePosition' }>;

/**
 * The run-built nodes one park has written so far, numbered as they were
 * first reached. A run-built node is an object the run holds by reference —
 * two graphs can hold the same node, and a node can be linked to itself — so
 * a park that wrote it once per sighting would hand the resumed run copies
 * that no longer see each other's writes, and would never finish writing a
 * cycle. Everything one park writes into one stored state shares one table.
 *
 * Source records are already handles to their own system and need none.
 */
export interface ParkWriter {
  readonly nodes: Map<NodePosition, number>;
}

export function newParkWriter(): ParkWriter {
  return { nodes: new Map() };
}

/**
 * The reading side: each numbered node, as the ONE object every reference to
 * it rehydrates to. The node is registered empty and filled in place, because
 * a reference can be read before the node it names — a cycle reaches back to
 * a node still being read, and jsonb hands an object's keys back in its own
 * order, so a later sighting can come first.
 */
export interface ParkReader {
  readonly nodes: Map<number, NodePosition>;
  /** Numbers a reference named whose node has not been read (yet). */
  readonly unfilled: Set<number>;
}

export function newParkReader(): ParkReader {
  return { nodes: new Map(), unfilled: new Set() };
}

function nodeNumbered(park: ParkReader, id: number): NodePosition {
  const known = park.nodes.get(id);
  if (known !== undefined) return known;
  const node: NodePosition = binding({ kind: 'nodePosition', fields: {}, fieldOrder: [], fieldProvenance: {}, edges: {} });
  park.nodes.set(id, node);
  park.unfilled.add(id);
  return node;
}

/**
 * Refuse a state that named a node it never wrote. Only a corrupted state
 * can — but resuming it would hand the run an empty node where a real one
 * stood, which is worse than not resuming.
 */
export function assertParkRead(park: ParkReader): void {
  if (park.unfilled.size === 0) return;
  throw new MovementEngineError(
    'MOVENG_RUNTIME',
    `the parked state refers to run-built node(s) ${[...park.unfilled].map((id) => `#${id}`).join(', ')} that it never wrote`,
  );
}

// ── JSON-serialisability guard (the `value` boundary, §4.1) ───────────────────

/**
 * Assert a `value` binding's payload survives a JSON round-trip. A
 * non-serialisable value (a closure, a `Date` that wouldn't revive, a `Map`)
 * would silently corrupt the parked scope — so we fail LOUD at park instead.
 * Returns the round-tripped value (so the descriptor holds exactly what will
 * come back, not a richer in-memory form that drifts on rehydrate).
 *
 * A file inside the value travels in its wire form, exactly as it crosses to
 * a remote adapter: its byte channel is a closure and stays behind, its
 * durable handle (`source`) goes, and rehydrate rebinds the channel from it.
 * Any OTHER closure is an error — `JSON.stringify` would drop it in silence.
 */
export function assertJsonSerializable(value: unknown, where: string): unknown {
  let json: string;
  try {
    json = JSON.stringify(value, function keepNoClosure(this: unknown, key: string, entry: unknown) {
      if (typeof entry !== 'function') return entry;
      if (key === 'retrieve' && isFileRef(this)) return undefined;
      throw new Error(`'${key}' is a function`);
    });
  } catch (e) {
    throw new MovementEngineError(
      'MOVENG_PARK_NONSERIALIZABLE',
      `${where}: value is not JSON-serialisable (${(e as Error).message}) — a parked scope must be durable.`,
    );
  }
  if (json === undefined) {
    // JSON.stringify(undefined) / a bare function returns undefined.
    if (value === undefined) return undefined;
    throw new MovementEngineError(
      'MOVENG_PARK_NONSERIALIZABLE',
      `${where}: value is not JSON-serialisable (it stringifies to undefined) — a parked scope must be durable.`,
    );
  }
  return JSON.parse(json);
}

// ── Serialize ─────────────────────────────────────────────────────────────────

function serializeInstanceIdentity(
  instance: Extract<Binding, { kind: 'instance' }>,
): InstanceIdentityDescriptor {
  return {
    name: instance.name,
    adapterSlug: instance.adapterSlug,
    ...(instance.credentialName !== undefined ? { credentialName: instance.credentialName } : {}),
    ...(instance.constructionConfig !== undefined
      ? { constructionConfig: instance.constructionConfig }
      : {}),
  };
}

function serializeHandleGraph(graph: HandleGraph): HandleGraphDescriptor {
  return { kind: 'instance', instance: serializeInstanceIdentity(graph.instance) };
}

function serializeEmission(emission: ExtractEmission): ExtractEmissionDescriptor {
  const children: Record<string, ExtractEmissionDescriptor[]> = {};
  for (const [edge, kids] of emission.children) {
    children[edge] = kids.map(serializeEmission);
  }
  return {
    nodeName: emission.nodeName,
    fields: emission.fields,
    fieldOrder: Object.keys(emission.fields),
    provenance: emission.provenance,
    ...(emission.origin !== undefined ? { origin: emission.origin } : {}),
    resources: emission.resources.map(serializeResource),
    children,
  };
}

function serializeFileRef(ref: FileRef): FileRefDescriptor {
  return {
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    ...(ref.contentType !== undefined ? { contentType: ref.contentType } : {}),
    ...(ref.size !== undefined ? { size: ref.size } : {}),
    ...(ref.source !== undefined ? { source: ref.source } : {}),
    ...(ref.url !== undefined ? { url: ref.url } : {}),
  };
}

function serializeResource(resource: Resource): ResourceDescriptor {
  const { fileRef, ...rest } = resource;
  return {
    ...rest,
    ...(fileRef !== undefined ? { fileRef: serializeFileRef(fileRef) } : {}),
  };
}

/**
 * Serialise one `Binding` to a plain-JSON descriptor. Bucket 1 copies data,
 * Bucket 2 strips the live ref to its serialisable identity, Bucket 3 keeps
 * only the code ref's name. Exhaustive over every binding kind (a new one is a
 * compile error at the `default`).
 */
export function serializeBinding(binding: Binding, park: ParkWriter = newParkWriter()): BindingDescriptor {
  const serialize = (entry: Binding): BindingDescriptor => serializeBinding(entry, park);
  switch (binding.kind) {
    // ── Bucket 1 — pure data ──
    case 'event':
      return { kind: 'event' };
    case 'handle': {
      const { old, ...handle } = binding.handle;
      return {
        kind: 'handle',
        handle,
        targetType: binding.targetType,
        graph: serializeHandleGraph(binding.graph),
        ...(old === binding ? { oldIsSelf: true as const } : old !== undefined ? { old: serialize(old) } : {}),
      };
    }
    case 'extractRoot':
      return { kind: 'extractRoot', emission: serializeEmission(binding.emission) };
    case 'extractPosition':
      return { kind: 'extractPosition', emission: serializeEmission(binding.emission) };
    case 'sourcePosition':
      return {
        kind: 'sourcePosition',
        position: binding.position,
        ...(binding.edgeProperties !== undefined ? { edgeProperties: binding.edgeProperties } : {}),
        // Bucket 2: keep only the read's instance identity; the live adapter +
        // edgeFieldId are rebound on rehydrate.
        ...(binding.read !== undefined ? { read: { instanceName: binding.read.instanceName } } : {}),
      };
    case 'shapePosition':
      return {
        kind: 'shapePosition',
        shape: binding.shape,
        node: binding.node,
        fields: binding.fields,
        fieldProvenance: binding.fieldProvenance,
      };
    case 'nodePosition': {
      const seen = park.nodes.get(binding);
      if (seen !== undefined) return { kind: 'nodeRef', id: seen };
      // Numbered BEFORE its edges are walked: an edge that leads back here is
      // a reference, not another lap.
      const id = park.nodes.size;
      park.nodes.set(binding, id);
      const edges: Record<string, NodeEdgeDescriptor> = {};
      for (const [name, edge] of Object.entries(binding.edges)) {
        edges[name] =
          edge.kind === 'landed'
            ? {
                kind: 'landed',
                landings: edge.landings.map(serialize),
                ...(edge.landingShape !== undefined ? { landing: edge.landingShape } : {}),
              }
            : { kind: 'deferred', walk: serializeDeferredWalk(edge.walk, park) };
      }
      return {
        kind: 'nodePosition',
        id,
        fields: binding.fields,
        fieldOrder: binding.fieldOrder,
        fieldProvenance: binding.fieldProvenance,
        ...(binding.landedOn !== undefined ? { landedOn: binding.landedOn } : {}),
        edges,
      };
    }
    case 'lazyWalk':
      return { kind: 'lazyWalk', walk: serializeDeferredWalk(binding.walk, park) };
    case 'callback':
      return {
        kind: 'callback',
        callbackId: binding.callbackId,
        url: binding.url,
        params: binding.params,
      };
    // ── Bucket 2 — live ref behind a serialisable identity ──
    case 'instance':
      return { kind: 'instance', instance: serializeInstanceIdentity(binding) };
    case 'resource':
      return { kind: 'resource', resource: serializeResource(binding.resource) };
    // ── Bucket 1 (value) — with the JSON guard, unless it holds records ──
    case 'value':
      if (holdsRecords(binding.value)) {
        return {
          kind: 'recordValue',
          value: serializeValue(binding.value, park),
          ...(binding.provenance !== undefined ? { provenance: binding.provenance } : {}),
          ...(binding.many === true ? { many: true } : {}),
        };
      }
      return {
        kind: 'value',
        value: assertJsonSerializable(binding.value, 'value binding'),
        ...(binding.provenance !== undefined ? { provenance: binding.provenance } : {}),
        ...(binding.many === true ? { many: true } : {}),
      };
    // ── Bucket 3 — code refs (name only; re-resolved from the re-parsed AST) ──
    case 'shape':
      return binding.local === true
        ? { kind: 'localShape', declaration: binding.declaration }
        : { kind: 'shape', name: binding.declaration.name };
    case 'movement':
      return { kind: 'movement', name: binding.declaration.name };
    case 'plugin':
      // A plugin name is an import like any other, and travels the same way: a
      // code ref re-resolved from the re-parsed AST, keyed by the slot name the
      // scope walk fills in below. Carrying the registry name instead would
      // break an aliased import, whose slot is not the plugin's name.
      return { kind: 'opaque', what: 'a plugin', name: '' };
    case 'opaque':
      // An import. `what` is the descriptive label; the binding has no stored
      // name, so re-resolution is by the descriptor's tag — opaque imports are
      // re-derived from the AST like other code refs (keyed by the slot name,
      // supplied by the scope serialiser). We keep `what` for fidelity and a
      // placeholder name; the scope walk overrides `name` with the slot key.
      return { kind: 'opaque', what: binding.what, name: '' };
    case 'positions':
      return { kind: 'positions', landings: binding.landings.map(serialize) };
    case 'tuple':
      return { kind: 'tuple', slots: binding.slots.map(serialize) };
    case 'closure': {
      const captured: Record<string, BindingDescriptor> = {};
      for (const [name, entry] of binding.captured) {
        const descriptor = serialize(entry);
        captured[name] = descriptor.kind === 'opaque' ? { ...descriptor, name } : descriptor;
      }
      return {
        kind: 'closure',
        closure: binding.closure,
        captured,
        ...(binding.self !== undefined ? { self: binding.self } : {}),
      };
    }
    // ── Bucket 3 (recursive) — block meta-node ──
    case 'blockMeta': {
      const edges: Record<string, BindingDescriptor[]> = {};
      for (const [name, bindings] of binding.edges) {
        edges[name] = bindings.map(serialize);
      }
      return { kind: 'blockMeta', edges, ...(binding.plural === true ? { plural: true } : {}) };
    }
    default:
      return assertNever(binding);
  }
}

// ── Rehydrate ─────────────────────────────────────────────────────────────────

function rehydrateEmission(
  descriptor: ExtractEmissionDescriptor,
  ctx: RehydrationContext,
): ExtractEmission {
  const children = new Map<string, ExtractEmission[]>();
  for (const [edge, kids] of Object.entries(descriptor.children)) {
    children.set(edge, kids.map((k) => rehydrateEmission(k, ctx)));
  }
  return {
    nodeName: descriptor.nodeName,
    fields: withFiles(inOrder(descriptor.fields, descriptor.fieldOrder), ctx),
    provenance: descriptor.provenance,
    ...(descriptor.origin !== undefined ? { origin: descriptor.origin } : {}),
    resources: (descriptor.resources ?? []).map((r) => rehydrateResource(r, ctx)),
    children,
  };
}

async function rehydrateHandleGraph(
  graph: HandleGraphDescriptor,
  ctx: RehydrationContext,
): Promise<HandleGraph> {
  return { kind: 'instance', instance: await ctx.resolveInstance(graph.instance) };
}

function rehydrateResource(descriptor: ResourceDescriptor, ctx: RehydrationContext): Resource {
  const { fileRef, ...rest } = descriptor;
  return {
    ...rest,
    ...(fileRef !== undefined ? { fileRef: ctx.reviveFileRef(fileRef) } : {}),
  };
}

/** Stored fields with every file in them given its byte channel back — a
 *  record's field can hold a file, and it parked in its wire form. */
function withFiles(fields: Record<string, unknown>, ctx: RehydrationContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = reviveFileRefs(value, (ref) => ctx.reviveFileRef(ref));
  }
  return out;
}

function serializeDeferredWalk(walk: DeferredWalk, park: ParkWriter): DeferredWalkDescriptor {
  const captured: Record<string, BindingDescriptor> = {};
  for (const [name, binding] of walk.captured) {
    const descriptor = serializeBinding(binding, park);
    captured[name] = descriptor.kind === 'opaque' ? { ...descriptor, name } : descriptor;
  }
  return { head: walk.head, captured, ...(walk.mapping ? { mapping: walk.mapping } : {}) };
}

async function rehydrateDeferredWalk(
  descriptor: DeferredWalkDescriptor,
  ctx: RehydrationContext,
  park: ParkReader,
): Promise<DeferredWalk> {
  const captured = new Map<string, Binding>();
  for (const [name, entry] of Object.entries(descriptor.captured)) {
    captured.set(name, await rehydrateInPark(entry, ctx, park));
  }
  return {
    head: descriptor.head,
    captured,
    ...(descriptor.mapping ? { mapping: descriptor.mapping } : {}),
  };
}

/**
 * Rebuild a live `Binding` from a descriptor. Bucket 1 returns the data as-is,
 * Bucket 2 rebinds the live ref through the context (registry / FileRef-revive),
 * Bucket 3 takes the code ref from the re-parsed program. Async because Bucket-2
 * adapter re-resolution + live schema re-fetch hit the registry.
 */
export async function rehydrateBinding(
  descriptor: BindingDescriptor,
  ctx: RehydrationContext,
  park?: ParkReader,
): Promise<Binding> {
  if (park !== undefined) return rehydrateInPark(descriptor, ctx, park);
  // A descriptor stored on its own is its own park.
  const own = newParkReader();
  const binding = await rehydrateInPark(descriptor, ctx, own);
  assertParkRead(own);
  return binding;
}

async function rehydrateInPark(
  descriptor: BindingDescriptor,
  ctx: RehydrationContext,
  park: ParkReader,
): Promise<Binding> {
  const rehydrate = (entry: BindingDescriptor): Promise<Binding> => rehydrateInPark(entry, ctx, park);
  switch (descriptor.kind) {
    // ── Bucket 1 — pure data ──
    case 'event':
      return binding({ kind: 'event' });
    case 'handle': {
      const written: Extract<Binding, { kind: 'handle' }> = binding({
        kind: 'handle',
        handle: { ...descriptor.handle },
        targetType: descriptor.targetType,
        graph: await rehydrateHandleGraph(descriptor.graph, ctx),
      });
      if (descriptor.oldIsSelf === true) {
        written.handle.old = written;
      } else if (descriptor.old !== undefined) {
        const old = await rehydrate(descriptor.old);
        if (old.kind !== 'handle') {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `the parked state's record before a write is ${old.kind}, not a handle`,
          );
        }
        written.handle.old = old;
      }
      return written;
    }
    case 'extractRoot':
      return binding({ kind: 'extractRoot', emission: rehydrateEmission(descriptor.emission, ctx) });
    case 'extractPosition':
      return binding({ kind: 'extractPosition', emission: rehydrateEmission(descriptor.emission, ctx) });
    case 'sourcePosition':
      return binding({
        kind: 'sourcePosition',
        position: descriptor.position,
        ...(descriptor.edgeProperties !== undefined ? { edgeProperties: descriptor.edgeProperties } : {}),
        ...(descriptor.read !== undefined
          ? { read: await ctx.resolveSourceRead(descriptor.read.instanceName) }
          : {}),
      });
    case 'shapePosition':
      return binding({
        kind: 'shapePosition',
        shape: descriptor.shape,
        node: descriptor.node,
        fields: withFiles(descriptor.fields, ctx),
        fieldProvenance: descriptor.fieldProvenance,
      });
    case 'nodePosition': {
      // Registered (and so reachable by its references) before its edges are
      // read, which is what lets an edge lead back to it.
      const node: NodePosition =
        descriptor.id !== undefined
          ? nodeNumbered(park, descriptor.id)
          : binding({ kind: 'nodePosition', fields: {}, fieldOrder: [], fieldProvenance: {}, edges: {} });
      if (descriptor.id !== undefined) park.unfilled.delete(descriptor.id);
      node.fields = withFiles(inOrder(descriptor.fields, descriptor.fieldOrder), ctx);
      node.fieldOrder = descriptor.fieldOrder ?? Object.keys(descriptor.fields);
      node.fieldProvenance = descriptor.fieldProvenance;
      if (descriptor.landedOn !== undefined) node.landedOn = descriptor.landedOn;
      const edges: Record<string, NodeEdge> = {};
      for (const [name, edge] of Object.entries(descriptor.edges)) {
        edges[name] =
          edge.kind === 'landed'
            ? {
                kind: 'landed',
                landings: await Promise.all(edge.landings.map(rehydrate)),
                ...landingShapeOf(edge),
              }
            : { kind: 'deferred', walk: await rehydrateDeferredWalk(edge.walk, ctx, park) };
      }
      node.edges = edges;
      return node;
    }
    case 'nodeRef':
      return nodeNumbered(park, descriptor.id);
    case 'lazyWalk':
      return binding({ kind: 'lazyWalk', walk: await rehydrateDeferredWalk(descriptor.walk, ctx, park) });
    case 'value':
      return binding({
        kind: 'value',
        value: reviveFileRefs(descriptor.value, (ref) => ctx.reviveFileRef(ref)),
        ...(descriptor.provenance !== undefined ? { provenance: descriptor.provenance } : {}),
        ...(descriptor.many === true ? { many: true } : {}),
      });
    // Through the one binding constructor, so a park taken while a name held
    // one record on the value plane resumes with the record bound as itself.
    case 'recordValue':
      return bindValue(await rehydrateValue(descriptor.value, ctx, park), descriptor.provenance, {
        many: descriptor.many === true,
      });
    case 'callback':
      return binding({
        kind: 'callback',
        callbackId: descriptor.callbackId,
        url: descriptor.url,
        params: descriptor.params,
      });
    // ── Bucket 2 — live ref ──
    case 'instance':
      return ctx.resolveInstance(descriptor.instance);
    case 'resource':
      return binding({ kind: 'resource', resource: rehydrateResource(descriptor.resource, ctx) });
    // ── Bucket 3 — code refs from the re-parsed program ──
    case 'shape':
    case 'movement':
    case 'opaque':
      return ctx.resolveCodeRef(descriptor.name);
    // Its words read the running file's scope after a resume — the body
    // scope it was declared in is the one being rebuilt.
    case 'localShape':
      return binding({ kind: 'shape', declaration: descriptor.declaration, local: true });
    case 'positions':
      return binding({
        kind: 'positions',
        landings: await Promise.all(descriptor.landings.map(rehydrate)),
      });
    case 'tuple':
      return binding({
        kind: 'tuple',
        slots: await Promise.all(descriptor.slots.map(rehydrate)),
      });
    case 'closure': {
      const captured = new Map<string, Binding>();
      for (const [name, entry] of Object.entries(descriptor.captured)) {
        captured.set(name, await rehydrate(entry));
      }
      return binding({
        kind: 'closure',
        closure: descriptor.closure,
        captured,
        ...(descriptor.self !== undefined ? { self: descriptor.self } : {}),
      });
    }
    // ── Bucket 3 (recursive) ──
    case 'blockMeta': {
      const edges = new Map<string, Binding[]>();
      for (const [name, descriptors] of Object.entries(descriptor.edges)) {
        edges.set(name, await Promise.all(descriptors.map(rehydrate)));
      }
      return binding({
        kind: 'blockMeta',
        edges,
        ...(descriptor.plural === true ? { plural: true } : {}),
      });
    }
    default:
      return assertNever(descriptor);
  }
}

// ── Scope serialisation (§4.6) ────────────────────────────────────────────────

/**
 * A serialised scope-node: the bindings declared in ONE lexical scope, keyed by
 * name. For the single-ask linear body (the only case that parks today) the
 * parked state is one chain of these from the movement body's root scope to the
 * ask's scope — §4.6's "the bindings feeding the parked ask". The multi-leaf
 * shared-ancestor frontier (fan-out, chunk 3.2) keys these by address-prefix; a
 * single chain is the degenerate one-branch case, so the shape generalises.
 */
export interface SerializedScope {
  bindings: Record<string, BindingDescriptor>;
}

/**
 * The full parked-run state (§4.6) — what `parked_run.state` holds. Versioned so
 * chunk 5's resume + chunk 3.2's multi-leaf can evolve the shape compatibly. The
 * `scopeChain` is root-first: index 0 is the movement body's own scope, the last
 * entry is the ask's immediate scope. Resume rebuilds the `Environment` chain by
 * rehydrating each scope in order, chaining child envs (4.1 / §4.6).
 */
export interface ParkedScopeState {
  /** Schema version of this state blob. */
  version: 1;
  /** The parked ask's canonical lexical address (§4.3) — the resume entry point. */
  address: string;
  /** The ask's binding name (`a = ask …`), so resume binds the answer back. Null
   *  for a value-less ask. */
  bindingName: string | null;
  /**
   * A PRESENCE-marker bind (asks-as-adapter chunk C): `expired = await sleep(2d)`
   * binds nothing of value, but the completed branch must escape `expired` onto
   * the race receipt as an edge (`r-[:expired]->`, S4). When set, the timer
   * resume declares `bindingName` as a presence value (`true`) at wake, so the
   * binding survives the park with no injected answer. Absent for an ordinary
   * value-less sleep (which binds nothing at all). */
  presenceBind?: boolean;
  /**
   * An `await until(…)` recurring-clock park (asks-as-adapter chunk D, F12). A
   * timer park (`park_reason='timer'`) whose resume RE-ENTERS the `until`
   * statement (`reenter=true`) to RE-EVALUATE the condition rather than stepping
   * past it: unmet ⇒ it re-parks at the same address with a fresh `wake_at`
   * (re-armed); met ⇒ it binds and continues. The timer-resume worker reads this
   * flag to choose re-enter over step-past, and to leave a re-armed leaf alone. */
  until?: boolean;
  /** Root-first chain of lexical scopes feeding the ask (§4.6). When the
   *  address crosses into a called body or a collection op's member
   *  (`frames`), this is the INNERMOST body's chain — the one the leaf runs in;
   *  each outer body's chain rides on the frame that leaves it. */
  scopeChain: SerializedScope[];
  /**
   * The bodies the address passes into that are not lexically inside the one
   * before — a called movement / function / closure, a collection op's member,
   * an arm built at run time — outermost first, one per `call` step (and per
   * `branch` step into a run-time arm). Absent on a park whose address never
   * left the dispatched movement's own body, which is every park written
   * before these steps existed.
   */
  frames?: SerializedFrame[];
  /**
   * An engine-initiated suspension (`suspendFlow`): the leaf statement has not
   * finished, and resume RE-RUNS it (`reenter`). Its calls that had already
   * completed are journalled here, so the re-run takes their values instead of
   * making them again.
   */
  suspended?: true;
  journal?: SerializedCallEvent[];
}

/**
 * One call a statement made and finished — the k-th, what it handed back, and
 * how far the statement's call count had got when it did. A statement re-run on
 * resume replays these instead of making the calls again (their effects, and
 * their spend, already happened).
 */
export interface SerializedCallEvent {
  index: number;
  /** Null when the call handed back nothing. */
  value: BindingDescriptor | null;
  /** The statement's call count after this call — a replayed call skips the
   *  calls made inside it (its arguments' calls). */
  next: number;
}

/**
 * One body boundary on a parked leaf's address (`ParkedScopeState.frames`).
 *
 *   - `call`: the statement's `index`-th call entered a movement / function /
 *     closure body. `callee` is the name it was called by, resolved again in
 *     the caller's rehydrated scope. `next` is the statement's call count once
 *     the arguments were evaluated — where a replay of the statement goes on
 *     from once the call hands back.
 *   - `member`: the statement's `index`-th call was a collection op, and the
 *     leaf is inside member `member`. The op travels as its AST (the version pin
 *     keeps it byte-identical), so its settings and function are re-derived.
 *   - `arm`: a `race` / `parallel` arm built at run time — its body has no place
 *     in the source to be found at, so it travels as AST. Its bindings are in
 *     the arm's scope, which is on the chain like any branch's.
 *
 * `call` and `member` start a new lexical body: `scopeChain` and `journal`
 * are the CALLER's — the chain of the body the call was made in, and the calls
 * its statement had finished.
 */
export type SerializedFrame =
  | {
      kind: 'call';
      index: number;
      next: number;
      callee: string;
      journal: SerializedCallEvent[];
      scopeChain: SerializedScope[];
    }
  | {
      kind: 'member';
      index: number;
      next: number;
      member: number;
      op: CollectionOpExpression;
      journal: SerializedCallEvent[];
      scopeChain: SerializedScope[];
    }
  | { kind: 'arm'; arm: number; body: ClosureExpression };

/**
 * Serialise one `Environment`'s OWN bindings (no parent walk) to a scope-node.
 * The interpreter declares the imported / constructed / read bindings into the
 * env as it descends; this captures exactly what THIS scope added.
 */
export function serializeScope(env: Environment, park: ParkWriter = newParkWriter()): SerializedScope {
  const bindings: Record<string, BindingDescriptor> = {};
  for (const [name, binding] of env.ownBindings()) {
    const descriptor = serializeBinding(binding, park);
    // An opaque import's re-resolution tag is its slot NAME (it has no stored
    // declaration name); patch it in here where the name is known.
    bindings[name] = descriptor.kind === 'opaque' ? { ...descriptor, name } : descriptor;
  }
  return { bindings };
}

/**
 * Serialise the scope CHAIN from the movement body's root env down to (and
 * including) the ask's immediate env. `chain` is root-first; the interpreter
 * hands it the live env stack at the park point. Shared ancestor scopes are
 * serialised once because they appear once in the chain (§4.6) — the multi-leaf
 * frontier keys them by prefix instead, a superset of this single-branch shape.
 */
export function serializeScopeChain(chain: Environment[], park: ParkWriter = newParkWriter()): SerializedScope[] {
  return chain.map((env) => serializeScope(env, park));
}

// ── Values that hold records ──────────────────────────────────────────────────

/**
 * Does this value hold a RECORD anywhere inside it? Only then does the value
 * need the recursive descriptor: everything else is data and travels as data,
 * which is what every parked run before this one carries.
 */
function holdsRecords(value: unknown): boolean {
  if (bindingOf(value) !== undefined) return true;
  if (Array.isArray(value)) return value.some(holdsRecords);
  if (isDictValue(value)) return Object.values(value).some(holdsRecords);
  return false;
}

function serializeValue(value: unknown, park: ParkWriter): ValueDescriptor {
  const record = bindingOf(value);
  if (record !== undefined) return { kind: 'record', binding: serializeBinding(record, park) };
  // A file is a leaf: its wire form is data, and rehydrate revives it.
  if (isFileRef(value)) return { kind: 'data', value: assertJsonSerializable(value, 'value binding') };
  if (Array.isArray(value)) return { kind: 'list', of: value.map((entry) => serializeValue(entry, park)) };
  if (isDictValue(value)) {
    const of: Record<string, ValueDescriptor> = {};
    for (const [key, entry] of Object.entries(value)) of[key] = serializeValue(entry, park);
    return { kind: 'map', of };
  }
  return { kind: 'data', value: assertJsonSerializable(value, 'value binding') };
}

async function rehydrateValue(
  descriptor: ValueDescriptor,
  ctx: RehydrationContext,
  park: ParkReader,
): Promise<unknown> {
  switch (descriptor.kind) {
    case 'data':
      return reviveFileRefs(descriptor.value, (ref) => ctx.reviveFileRef(ref));
    case 'record':
      return rehydrateInPark(descriptor.binding, ctx, park);
    case 'list':
      return Promise.all(descriptor.of.map((entry) => rehydrateValue(entry, ctx, park)));
    case 'map': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(descriptor.of)) {
        out[key] = await rehydrateValue(entry, ctx, park);
      }
      return out;
    }
  }
}

// ── Exhaustiveness ────────────────────────────────────────────────────────────

function assertNever(value: never): never {
  throw new MovementEngineError(
    'MOVENG_PARK_NONSERIALIZABLE',
    `unhandled binding kind in scope serialisation: ${JSON.stringify(value)}`,
  );
}
