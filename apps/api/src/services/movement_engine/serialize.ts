// The scope serialize / rehydrate seam (async user interaction §4.1, §4.6).
//
// A parked movement run survives a process boundary for days. Its scope — the
// `Binding`s feeding the parked `ask` — is ALMOST entirely plain data; the live
// refs are a small closed set. `serializeBinding` turns a live `Binding` into a
// plain-JSON descriptor (a tagged variant per binding kind); `rehydrateBinding`
// rebuilds the live `Binding` from a descriptor + a rehydration context that
// re-resolves the live refs. The two are inverse modulo live refs (an adapter is
// re-resolved, an instance schema re-fetched, code refs taken from the
// re-parsed AST). A file is data: its descriptor parks as it stands.
//
// The three buckets (§4.1):
//   1. Pure data — serialise as-is: `event`, `value`, `handle`,
//      `extractRoot`/`extractPosition` (the materialised emission — the extraction
//      RAN, its output is data, never re-run), the data half of `sourcePosition`
//      (`SourcePosition` + `edgeProperties`), `shapePosition`.
//   2. A live ref behind a serialisable identity — rebind on rehydrate: the
//      adapter inside `instance` and `sourcePosition.read` (re-resolved by
//      slug+creds via the registry; `edgeFieldId` re-derived; the instance schema
//      RE-FETCHED live, never serialised).
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
// This module is pure: all DB / registry access stays behind the
// injected `RehydrationContext`, exactly as the interpreter keeps `resolveAdapter`
// / `parkSink` behind seams.

import type {
  BindingDescriptor,
  DeferredWalkDescriptor,
  ExtractEmissionDescriptor,
  HandleGraphDescriptor,
  InstanceIdentityDescriptor,
  LegacyLandingShape,
  LocalLandingShape,
  NodeEdgeDescriptor,
  Resource,
  ResourceDescriptor,
  SerializedScope,
  ValueDescriptor,
} from 'engine-contracts';
import type { ExtractEmission } from './extraction';
import type {
  Binding,
  DeferredWalk,
  Environment,
  HandleGraph,
  NodeEdge,
  SourceRead,
} from './expression';
import { bindValue, bindingOf, isDictValue } from './expression';
import { settledAll } from './fans';
import { isFileRef } from '../translation_graph/adapter';
import { MovementEngineError } from './errors';

// ── The descriptor (plain JSON) ──────────────────────────────────────────────
//
// The parked state and every descriptor in it are the contract's
// (`engine-contracts`): `ParkedScopeState`, version 1.

export type {
  BindingDescriptor,
  DeferredWalkDescriptor,
  ExtractEmissionDescriptor,
  HandleGraphDescriptor,
  InstanceIdentityDescriptor,
  NodeEdgeDescriptor,
  ParkedScopeState,
  ResourceDescriptor,
  SerializedCallEvent,
  SerializedFrame,
  SerializedScope,
  SourceReadDescriptor,
  ValueDescriptor,
} from 'engine-contracts';

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
  const node: NodePosition = { kind: 'nodePosition', fields: {}, fieldOrder: [], fieldProvenance: {}, edges: {} };
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
 * A file inside the value is a descriptor — data, and parks as it stands. A
 * closure is an error — `JSON.stringify` would drop it in silence.
 */
export function assertJsonSerializable(value: unknown, where: string): unknown {
  let json: string;
  try {
    json = JSON.stringify(value, (key: string, entry: unknown) => {
      if (typeof entry !== 'function') return entry;
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

function serializeResource(resource: Resource): ResourceDescriptor {
  return resource;
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
    case 'handle':
      return {
        kind: 'handle',
        handle: binding.handle,
        targetType: binding.targetType,
        graph: serializeHandleGraph(binding.graph),
      };
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

function rehydrateEmission(descriptor: ExtractEmissionDescriptor): ExtractEmission {
  const children = new Map<string, ExtractEmission[]>();
  for (const [edge, kids] of Object.entries(descriptor.children)) {
    children.set(edge, kids.map(rehydrateEmission));
  }
  return {
    nodeName: descriptor.nodeName,
    fields: inOrder(descriptor.fields, descriptor.fieldOrder),
    provenance: descriptor.provenance,
    ...(descriptor.origin !== undefined ? { origin: descriptor.origin } : {}),
    resources: (descriptor.resources ?? []).map(rehydrateResource),
    children,
  };
}

async function rehydrateHandleGraph(
  graph: HandleGraphDescriptor,
  ctx: RehydrationContext,
): Promise<HandleGraph> {
  return { kind: 'instance', instance: await ctx.resolveInstance(graph.instance) };
}

function rehydrateResource(descriptor: ResourceDescriptor): Resource {
  const { fileRef, ...rest } = descriptor;
  return {
    ...rest,
    ...(fileRef !== undefined ? { fileRef: { ...fileRef, __brand: 'FileRef' } } : {}),
  };
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
 * Bucket 2 rebinds the live ref through the context (the registry),
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
      return { kind: 'event' };
    case 'handle':
      return {
        kind: 'handle',
        handle: descriptor.handle,
        targetType: descriptor.targetType,
        graph: await rehydrateHandleGraph(descriptor.graph, ctx),
      };
    case 'extractRoot':
      return { kind: 'extractRoot', emission: rehydrateEmission(descriptor.emission) };
    case 'extractPosition':
      return { kind: 'extractPosition', emission: rehydrateEmission(descriptor.emission) };
    case 'sourcePosition':
      return {
        kind: 'sourcePosition',
        position: descriptor.position,
        ...(descriptor.edgeProperties !== undefined ? { edgeProperties: descriptor.edgeProperties } : {}),
        ...(descriptor.read !== undefined
          ? { read: await ctx.resolveSourceRead(descriptor.read.instanceName) }
          : {}),
      };
    case 'shapePosition':
      return {
        kind: 'shapePosition',
        shape: descriptor.shape,
        node: descriptor.node,
        fields: descriptor.fields,
        fieldProvenance: descriptor.fieldProvenance,
      };
    case 'nodePosition': {
      // Registered (and so reachable by its references) before its edges are
      // read, which is what lets an edge lead back to it.
      const node: NodePosition =
        descriptor.id !== undefined
          ? nodeNumbered(park, descriptor.id)
          : { kind: 'nodePosition', fields: {}, fieldOrder: [], fieldProvenance: {}, edges: {} };
      if (descriptor.id !== undefined) park.unfilled.delete(descriptor.id);
      node.fields = inOrder(descriptor.fields, descriptor.fieldOrder);
      node.fieldOrder = descriptor.fieldOrder ?? Object.keys(descriptor.fields);
      node.fieldProvenance = descriptor.fieldProvenance;
      if (descriptor.landedOn !== undefined) node.landedOn = descriptor.landedOn;
      const edges: Record<string, NodeEdge> = {};
      for (const [name, edge] of Object.entries(descriptor.edges)) {
        edges[name] =
          edge.kind === 'landed'
            ? {
                kind: 'landed',
                landings: await settledAll(edge.landings.map(rehydrate)),
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
      return { kind: 'lazyWalk', walk: await rehydrateDeferredWalk(descriptor.walk, ctx, park) };
    case 'value':
      return {
        kind: 'value',
        value: descriptor.value,
        ...(descriptor.provenance !== undefined ? { provenance: descriptor.provenance } : {}),
        ...(descriptor.many === true ? { many: true } : {}),
      };
    // Through the one binding constructor, so a park taken while a name held
    // one record on the value plane resumes with the record bound as itself.
    case 'recordValue':
      return bindValue(await rehydrateValue(descriptor.value, ctx, park), descriptor.provenance, {
        many: descriptor.many === true,
      });
    case 'callback':
      return {
        kind: 'callback',
        callbackId: descriptor.callbackId,
        url: descriptor.url,
        params: descriptor.params,
      };
    // ── Bucket 2 — live ref ──
    case 'instance':
      return ctx.resolveInstance(descriptor.instance);
    case 'resource':
      return { kind: 'resource', resource: rehydrateResource(descriptor.resource) };
    // ── Bucket 3 — code refs from the re-parsed program ──
    case 'shape':
    case 'movement':
    case 'opaque':
      return ctx.resolveCodeRef(descriptor.name);
    // Its words read the running file's scope after a resume — the body
    // scope it was declared in is the one being rebuilt.
    case 'localShape':
      return { kind: 'shape', declaration: descriptor.declaration, local: true };
    case 'positions':
      return {
        kind: 'positions',
        landings: await settledAll(descriptor.landings.map(rehydrate)),
      };
    case 'tuple':
      return {
        kind: 'tuple',
        slots: await settledAll(descriptor.slots.map(rehydrate)),
      };
    case 'closure': {
      const captured = new Map<string, Binding>();
      for (const [name, entry] of Object.entries(descriptor.captured)) {
        captured.set(name, await rehydrate(entry));
      }
      return {
        kind: 'closure',
        closure: descriptor.closure,
        captured,
        ...(descriptor.self !== undefined ? { self: descriptor.self } : {}),
      };
    }
    // ── Bucket 3 (recursive) ──
    case 'blockMeta': {
      const edges = new Map<string, Binding[]>();
      for (const [name, descriptors] of Object.entries(descriptor.edges)) {
        edges.set(name, await settledAll(descriptors.map(rehydrate)));
      }
      return {
        kind: 'blockMeta',
        edges,
        ...(descriptor.plural === true ? { plural: true } : {}),
      };
    }
    default:
      return assertNever(descriptor);
  }
}

// ── Scope serialisation (§4.6) ────────────────────────────────────────────────





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
  // A file is a leaf: its descriptor is data.
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
      return descriptor.value;
    case 'record':
      return rehydrateInPark(descriptor.binding, ctx, park);
    case 'list':
      return settledAll(descriptor.of.map((entry) => rehydrateValue(entry, ctx, park)));
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
