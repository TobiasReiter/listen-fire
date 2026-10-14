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
//      re-resolve by — plus the scope it holds: numbered, and written once (a
//      closure parked before scopes were numbered carries a flat capture).
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
  ParkedScopeState,
  Resource,
  ResourceDescriptor,
  ScopeLink,
  SerializedCallEvent,
  SerializedScope,
  ValueDescriptor,
} from 'engine-contracts';
import type { ExtractEmission } from './extraction';
import type {
  Binding,
  DeferredWalk,
  HandleGraph,
  NodeEdge,
  SourceRead,
} from './expression';
import { Environment, bindValue, binding, bindingOf, isDictValue } from './expression';
import { settledAll } from './fans';
import { fileValueOf, isFileValue } from '../translation_graph/adapter';
import { MovementEngineError } from './errors';
import { neverAsAny } from '../../lib/utils/types';

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
  ScopeLink,
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
   * `file` is the library the declaration belongs to; absent = the root
   * program.
   */
  resolveCodeRef(name: string, file?: string): Binding | Promise<Binding>;
  /**
   * A file's top-level scope in the re-parsed program — the root program's,
   * or the library `file`'s — live: the scope a parked body closure's scopes
   * chain up to. Only a park holding such a closure needs it.
   */
  resolveFileScope?(file?: string): Promise<Environment>;
}

// ── One park's identity table ─────────────────────────────────────────────────

type NodePosition = Extract<Binding, { kind: 'nodePosition' }>;
type HandleBinding = Extract<Binding, { kind: 'handle' }>;
type HandleDescriptor = Extract<BindingDescriptor, { kind: 'handle' }>;

/**
 * The run-built nodes one park has written so far, numbered as they were
 * first reached. A run-built node is an object the run holds by reference —
 * two graphs can hold the same node, and a node can be linked to itself — so
 * a park that wrote it once per sighting would hand the resumed run copies
 * that no longer see each other's writes, and would never finish writing a
 * cycle. Everything one park writes into one stored state shares one table.
 *
 * Source records are already handles to their own system and need none.
 *
 * A write HANDLE is held by reference too (an in-place write and `refresh`
 * move it under every name that holds it), so it is written once as well. It
 * is numbered only when it is reached a second time — its first descriptor
 * gains the `id` then — so a park that holds each handle once writes exactly
 * the bytes it always did.
 */
export interface ParkWriter {
  readonly nodes: Map<NodePosition, number>;
  /** Each handle written so far: its first descriptor, numbered once a
   *  second sighting needs it to be. */
  readonly handles: Map<HandleBinding, HandleDescriptor>;
  /** How many handles have been numbered. */
  handleIds: number;
  /** The library file a file environment is, by path — how a code ref
   *  declared in a library says where it is found again. Undefined (or
   *  absent) = the root program's. */
  readonly fileOf?: (env: Environment) => string | undefined;
  /** Whether a scope is a file's top-level scope (found again in the
   *  re-parsed program, never written). Absent: any scope nested in none. */
  readonly isFileScope?: (env: Environment) => boolean;
  /** Each scope a closure held, by its number. A scope is numbered the
   *  first time a closure reaches it, so a park holding none writes exactly
   *  the bytes it always did. */
  readonly scopeIds: Map<Environment, number>;
  /** The copies of each scope the parked chains have written so far: each
   *  carries the scope's number once it has one, so whichever copy a resume
   *  reads names it. */
  readonly scopeCopies: Map<Environment, SerializedScope[]>;
  /** The scopes a parked chain carries, or will: a closure that holds one
   *  names it, and never writes it a second time. */
  readonly chainScopes: Set<Environment>;
}

export function newParkWriter(
  fileOf?: (env: Environment) => string | undefined,
  isFileScope?: (env: Environment) => boolean,
): ParkWriter {
  return {
    nodes: new Map(),
    handles: new Map(),
    handleIds: 0,
    ...(fileOf !== undefined ? { fileOf } : {}),
    ...(isFileScope !== undefined ? { isFileScope } : {}),
    scopeIds: new Map(),
    scopeCopies: new Map(),
    chainScopes: new Set(),
  };
}

/** Say that a chain the park will write carries these scopes — the frames',
 *  written after the leaf's — so a closure reaching one first names it. */
export function carriesChain(park: ParkWriter, chain: readonly Environment[]): void {
  for (const env of chain) park.chainScopes.add(env);
}

function isFileScopeIn(park: ParkWriter, env: Environment): boolean {
  return park.isFileScope !== undefined ? park.isFileScope(env) : env.outer() === undefined;
}

/** Where a numbered scope (or a closure's) is: by number, or a file's. */
function scopeRefOf(park: ParkWriter, env: Environment): ScopeLink {
  if (isFileScopeIn(park, env)) {
    const file = park.fileOf?.(env);
    return { kind: 'file', ...(file !== undefined ? { file } : {}) };
  }
  const id = park.scopeIds.get(env);
  if (id === undefined) throw new MovementEngineError('MOVENG_RUNTIME', 'park: a scope was named before it was numbered');
  return { kind: 'scopeRef', id };
}

/** A chain copy of a numbered scope says its number, and the scope it is
 *  nested in, so a resume that reads it — or builds it — finds it. */
function numberCopy(copy: SerializedScope, id: number, parent: ScopeLink | undefined): void {
  copy.id = id;
  if (parent !== undefined) copy.parent = parent;
}

/**
 * The scope a closure holds, as the park writes it: by number when the park
 * has numbered it or a chain carries it, a file's by its file, and otherwise
 * written here, once. Numbering a scope numbers the scopes it is nested in,
 * up to its file's, so a resume can rebuild the chain from any of them.
 */
function scopeLinkOf(park: ParkWriter, env: Environment): ScopeLink {
  if (isFileScopeIn(park, env) || park.scopeIds.has(env)) return scopeRefOf(park, env);
  const id = park.scopeIds.size;
  park.scopeIds.set(env, id);
  const outer = env.outer();
  const parent = outer !== undefined ? scopeLinkOf(park, outer) : undefined;
  // The copies say where it is nested by reference: the scope it is nested
  // in is numbered now, and written once wherever it was.
  const parentRef = outer !== undefined ? scopeRefOf(park, outer) : undefined;
  const copies = park.scopeCopies.get(env);
  for (const copy of copies ?? []) numberCopy(copy, id, parentRef);
  if (copies !== undefined || park.chainScopes.has(env)) return { kind: 'scopeRef', id };
  const written: Extract<ScopeLink, { kind: 'scope' }> = {
    kind: 'scope',
    id,
    ...(parent !== undefined ? { parent } : {}),
    bindings: {},
  };
  writeBindings(written.bindings, env, park);
  return written;
}

/** The library a code ref is declared in, when it is one's: an imported
 *  declaration names its file, a library's own carries the library's env. */
function declaringFile(park: ParkWriter, library: { path: string } | undefined, fileEnv: Environment | undefined): { file?: string } {
  const file = library?.path ?? (fileEnv !== undefined ? park.fileOf?.(fileEnv) : undefined);
  return file !== undefined ? { file } : {};
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
  /** Each numbered handle, as the ONE binding every reference to it reads
   *  as — registered empty and filled in place, as a node is. */
  readonly handles: Map<number, HandleBinding>;
  readonly unfilledHandles: Set<number>;
  /** Every numbered descriptor the WHOLE parked state carries, by its
   *  number, indexed before anything is read: a reference is resolved from
   *  it whichever copy of a scope (or frame, or journal) the reader walks,
   *  and in whatever order the state's keys come back. The writer numbers a
   *  handle or node at its FIRST sighting in its own walk order, which need
   *  not be a place the reader walks at all — the movement scope rides on
   *  both the leaf's chain and an outer frame's, and the reader rebuilds it
   *  from the frame's. */
  readonly handleDescriptors: Map<number, HandleDescriptor>;
  readonly nodeDescriptors: Map<number, NodeDescriptor>;
  /** Each numbered scope, as the ONE scope every closure that names it
   *  holds: the live scope a resume rebuilt from a chain copy, or one built
   *  from the scope's written copy when no chain the resume reads holds it. */
  readonly scopes: Map<number, Environment>;
  /** Every numbered scope's written copy anywhere in the state — a chain's,
   *  or a closure's `scope` — indexed before anything is read. */
  readonly scopeDescriptors: Map<number, { bindings: Record<string, BindingDescriptor>; parent?: ScopeLink }>;
}

type NodeDescriptor = Extract<BindingDescriptor, { kind: 'nodePosition' }>;

/** A reader of the park `state` was written as — a whole parked state. */
export function newParkReader(state?: ParkedScopeState): ParkReader {
  const park = emptyParkReader();
  if (state !== undefined) indexState(state, park);
  return park;
}

/** A reader of a descriptor stored on its own. */
function newParkReaderOf(descriptor: BindingDescriptor): ParkReader {
  const park = emptyParkReader();
  indexDescriptor(descriptor, park);
  return park;
}

function emptyParkReader(): ParkReader {
  return {
    nodes: new Map(),
    unfilled: new Set(),
    handles: new Map(),
    unfilledHandles: new Set(),
    handleDescriptors: new Map(),
    nodeDescriptors: new Map(),
    scopes: new Map(),
    scopeDescriptors: new Map(),
  };
}

/*
 * The index follows each descriptor's STRUCTURE, the shapes the reader reads —
 * never a list of key names. A scope's `bindings`, a closure's `captured` and
 * an edge map are keyed by the AUTHOR's names, so they are walked as maps of
 * descriptors whatever the names are; a code-tree member (a closure's body, a
 * walk's head, an arm's body) is skipped only on the descriptor that has it,
 * by not being a member the walk visits.
 */

/** Every numbered handle and node descriptor anywhere in a parked state: its
 *  scopes, frames and journals. */
function indexState(state: ParkedScopeState, park: ParkReader): void {
  indexScopes(state.scopeChain, park);
  indexJournal(state.journal, park);
  for (const frame of state.frames ?? []) {
    switch (frame.kind) {
      case 'call':
      case 'member':
        indexScopes(frame.scopeChain, park);
        indexJournal(frame.journal, park);
        break;
      // A run-time arm's `body` is code; its bindings ride on the chain.
      case 'arm':
        break;
      default:
        neverAsAny(frame);
    }
  }
}

function indexScopes(chain: SerializedScope[], park: ParkReader): void {
  for (const scope of chain) {
    if (typeof scope.id === 'number' && !park.scopeDescriptors.has(scope.id)) {
      park.scopeDescriptors.set(scope.id, scope);
    }
    if (scope.parent !== undefined) indexScopeLink(scope.parent, park);
    indexMap(scope.bindings, park);
  }
}

function indexScopeLink(link: ScopeLink, park: ParkReader): void {
  switch (link.kind) {
    case 'scope':
      if (!park.scopeDescriptors.has(link.id)) park.scopeDescriptors.set(link.id, link);
      if (link.parent !== undefined) indexScopeLink(link.parent, park);
      indexMap(link.bindings, park);
      return;
    case 'scopeRef':
    case 'file':
      return;
    default:
      neverAsAny(link);
  }
}

function indexJournal(journal: SerializedCallEvent[] | undefined, park: ParkReader): void {
  for (const event of journal ?? []) {
    if (event.value !== null) indexDescriptor(event.value, park);
  }
}

/** A map keyed by the author's names, every entry a descriptor. */
function indexMap(entries: Record<string, BindingDescriptor>, park: ParkReader): void {
  for (const entry of Object.values(entries)) indexDescriptor(entry, park);
}

function indexWalk(walk: DeferredWalkDescriptor, park: ParkReader): void {
  // The walk's `head` and `mapping` are code.
  indexMap(walk.captured, park);
}

function indexValue(value: ValueDescriptor, park: ParkReader): void {
  switch (value.kind) {
    // A file is data the engine held: it numbers nothing.
    case 'data':
    case 'file':
      return;
    case 'record':
      indexDescriptor(value.binding, park);
      return;
    case 'list':
      for (const entry of value.of) indexValue(entry, park);
      return;
    case 'map':
      for (const entry of Object.values(value.of)) indexValue(entry, park);
      return;
    default:
      neverAsAny(value);
  }
}

function indexDescriptor(descriptor: BindingDescriptor, park: ParkReader): void {
  switch (descriptor.kind) {
    case 'handle':
      if (typeof descriptor.id === 'number' && !park.handleDescriptors.has(descriptor.id)) {
        park.handleDescriptors.set(descriptor.id, descriptor);
      }
      if (descriptor.old !== undefined) indexDescriptor(descriptor.old, park);
      return;
    case 'nodePosition':
      if (typeof descriptor.id === 'number' && !park.nodeDescriptors.has(descriptor.id)) {
        park.nodeDescriptors.set(descriptor.id, descriptor);
      }
      for (const edge of Object.values(descriptor.edges)) {
        switch (edge.kind) {
          case 'landed':
            for (const landing of edge.landings) indexDescriptor(landing, park);
            break;
          case 'deferred':
            indexWalk(edge.walk, park);
            break;
          default:
            neverAsAny(edge);
        }
      }
      return;
    case 'blockMeta':
      for (const landings of Object.values(descriptor.edges)) {
        for (const landing of landings) indexDescriptor(landing, park);
      }
      return;
    case 'positions':
      for (const landing of descriptor.landings) indexDescriptor(landing, park);
      return;
    case 'tuple':
      for (const slot of descriptor.slots) indexDescriptor(slot, park);
      return;
    // A closure's `closure` is code; its capture is a map of descriptors,
    // and its scope a scope's.
    case 'closure':
      indexMap(descriptor.captured, park);
      if (descriptor.scope !== undefined) indexScopeLink(descriptor.scope, park);
      return;
    case 'recordValue':
      indexValue(descriptor.value, park);
      return;
    case 'lazyWalk':
      indexWalk(descriptor.walk, park);
      return;
    // Nothing a park numbers: their payload is data or code, never a descriptor.
    case 'event':
    case 'instance':
    case 'handleRef':
    case 'nodeRef':
    case 'extractRoot':
    case 'extractPosition':
    case 'shapePosition':
    case 'sourcePosition':
    case 'resource':
    case 'value':
    case 'callback':
    case 'shape':
    case 'localShape':
    case 'movement':
    case 'fileClosure':
    case 'opaque':
      return;
    default:
      neverAsAny(descriptor);
  }
}

function handleNumbered(park: ParkReader, id: number): HandleBinding {
  const known = park.handles.get(id);
  if (known !== undefined) return known;
  // Every member is set when its descriptor is read; `assertParkRead`
  // refuses a state whose reference never was.
  const handle = binding({
    kind: 'handle',
    handle: {} as HandleBinding['handle'],
    targetType: '',
    graph: {} as HandleBinding['graph'],
  });
  park.handles.set(id, handle);
  park.unfilledHandles.add(id);
  return handle;
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
 * The scope a parked closure holds: a file's, found in the re-parsed
 * program, or a numbered one — the live scope the resume rebuilt from a
 * chain, or one built here from its written copy, nested as it was. A built
 * scope is registered before its bindings are read, so a closure in it that
 * holds it gets it back.
 */
async function scopeOf(link: ScopeLink, ctx: RehydrationContext, park: ParkReader): Promise<Environment> {
  const pending: Array<{ env: Environment; bindings: Record<string, BindingDescriptor> }> = [];
  const env = await scopeShell(link, ctx, park, pending);
  // Every shell on the chain is registered; only now are bindings read, so a
  // closure that holds a scope still being built gets the registered shell.
  // Nothing awaits a scope that is being built. Outermost first.
  for (const { env: shell, bindings } of pending.reverse()) {
    for (const [name, entry] of Object.entries(bindings)) {
      shell.declare(name, await rehydrateInPark(entry, ctx, park));
    }
  }
  return env;
}

/** A scope's shell — its parent link and an empty table — registered under
 *  its number; its bindings are queued in `pending` for the caller to fill. */
async function scopeShell(
  link: ScopeLink,
  ctx: RehydrationContext,
  park: ParkReader,
  pending: Array<{ env: Environment; bindings: Record<string, BindingDescriptor> }>,
): Promise<Environment> {
  if (link.kind === 'file') {
    if (ctx.resolveFileScope === undefined) {
      throw new MovementEngineError('MOVENG_RUNTIME', 'resume: a parked closure holds a file scope, and this resume has no program to find it in');
    }
    return ctx.resolveFileScope(link.file);
  }
  const known = park.scopes.get(link.id);
  if (known !== undefined) return known;
  const written = link.kind === 'scope' ? link : park.scopeDescriptors.get(link.id);
  if (written === undefined) {
    throw new MovementEngineError('MOVENG_RUNTIME', `the parked state refers to scope #${link.id} that it never wrote`);
  }
  const outer = written.parent !== undefined ? await scopeShell(written.parent, ctx, park, pending) : undefined;
  // The registration follows the last await, so a concurrent reader cannot
  // build the same number twice.
  const again = park.scopes.get(link.id);
  if (again !== undefined) return again;
  const env = outer !== undefined ? outer.child() : new Environment();
  park.scopes.set(link.id, env);
  pending.push({ env, bindings: written.bindings });
  return env;
}

/** A chain copy the resume read into `env`, live: when it is numbered, the
 *  scope every closure naming that number holds. */
export function registerLiveScope(park: ParkReader, scope: SerializedScope, env: Environment): void {
  if (typeof scope.id === 'number' && !park.scopes.has(scope.id)) park.scopes.set(scope.id, env);
}

/**
 * Refuse a state that named a node it never wrote. Only a corrupted state
 * can — but resuming it would hand the run an empty node where a real one
 * stood, which is worse than not resuming.
 */
export function assertParkRead(park: ParkReader): void {
  if (park.unfilled.size > 0) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `the parked state refers to run-built node(s) ${[...park.unfilled].map((id) => `#${id}`).join(', ')} that it never wrote`,
    );
  }
  if (park.unfilledHandles.size > 0) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `the parked state refers to write handle(s) ${[...park.unfilledHandles].map((id) => `#${id}`).join(', ')} that it never wrote`,
    );
  }
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
  const fileFields = fileFieldsOf(emission.fields);
  return {
    nodeName: emission.nodeName,
    fields: emission.fields,
    fieldOrder: Object.keys(emission.fields),
    ...(fileFields !== undefined ? { fileFields } : {}),
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
    case 'handle': {
      const first = park.handles.get(binding);
      if (first !== undefined) {
        // Numbered now, on its second sighting: the first descriptor is still
        // the live object this park is building, so it gains the id in place.
        if (first.id === undefined) first.id = park.handleIds++;
        return { kind: 'handleRef', id: first.id };
      }
      const { old, ...handle } = binding.handle;
      const descriptor: HandleDescriptor = {
        kind: 'handle',
        handle,
        targetType: binding.targetType,
        graph: serializeHandleGraph(binding.graph),
      };
      // Registered before its `old` is walked, as a node is before its edges.
      park.handles.set(binding, descriptor);
      if (old === binding) descriptor.oldIsSelf = true;
      else if (old !== undefined) descriptor.old = serialize(old);
      return descriptor;
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
    case 'shapePosition': {
      const fileFields = fileFieldsOf(binding.fields);
      return {
        kind: 'shapePosition',
        shape: binding.shape,
        node: binding.node,
        fields: binding.fields,
        ...(fileFields !== undefined ? { fileFields } : {}),
        fieldProvenance: binding.fieldProvenance,
      };
    }
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
      const fileFields = fileFieldsOf(binding.fields);
      return {
        kind: 'nodePosition',
        id,
        fields: binding.fields,
        fieldOrder: binding.fieldOrder,
        ...(fileFields !== undefined ? { fileFields } : {}),
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
      if (holdsEngineValues(binding.value)) {
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
        : { kind: 'shape', name: binding.declaration.name, ...declaringFile(park, binding.library, binding.fileEnv) };
    case 'movement':
      return { kind: 'movement', name: binding.declaration.name, ...declaringFile(park, undefined, binding.fileEnv) };
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
      if (binding.file !== undefined) {
        return { kind: 'fileClosure', name: binding.file.name, ...declaringFile(park, undefined, binding.file.env) };
      }
      if (binding.env !== undefined) {
        return {
          kind: 'closure',
          closure: binding.closure,
          captured: {},
          ...(binding.self !== undefined ? { self: binding.self } : {}),
          scope: scopeLinkOf(park, binding.env),
        };
      }
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
    fields: withFileFields(inOrder(descriptor.fields, descriptor.fieldOrder), descriptor.fileFields),
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

/**
 * A parked resource: data as it stands, its `fileRef` slot a file again — the
 * slot is typed, so whatever it holds is that resource's file (a park written
 * before descriptors carried the brand holds it without). Its `data.file`, the
 * same file as the resource's fields expose it, is that file too.
 */
function rehydrateResource(descriptor: ResourceDescriptor): Resource {
  const { fileRef, ...rest } = descriptor;
  const file = fileRef !== undefined ? fileValueOf(fileRef) : undefined;
  if (file === undefined) return rest;
  const data = rest.data !== undefined && Object.hasOwn(rest.data, 'file') ? { ...rest.data, file } : rest.data;
  return { ...rest, fileRef: file, ...(data !== undefined ? { data } : {}) };
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
  const own = newParkReaderOf(descriptor);
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
      let written: HandleBinding;
      if (descriptor.id === undefined) {
        const graph = await rehydrateHandleGraph(descriptor.graph, ctx);
        written = binding({ kind: 'handle', handle: { ...descriptor.handle }, targetType: descriptor.targetType, graph });
      } else {
        // Read already — through a reference that named it first.
        const read = park.handles.get(descriptor.id);
        if (read !== undefined && !park.unfilledHandles.has(descriptor.id)) return read;
        // The one binding every `handleRef` to it reads as, filled in place —
        // registered before anything awaits, so a reference read alongside it
        // finds it rather than reading the descriptor a second time.
        written = handleNumbered(park, descriptor.id);
        park.unfilledHandles.delete(descriptor.id);
        const graph = await rehydrateHandleGraph(descriptor.graph, ctx);
        written.handle = { ...descriptor.handle };
        written.targetType = descriptor.targetType;
        written.graph = graph;
      }
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
      return binding({ kind: 'extractRoot', emission: rehydrateEmission(descriptor.emission) });
    case 'extractPosition':
      return binding({ kind: 'extractPosition', emission: rehydrateEmission(descriptor.emission) });
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
        fields: withFileFields(descriptor.fields, descriptor.fileFields),
        fieldProvenance: descriptor.fieldProvenance,
      });
    case 'nodePosition': {
      // Read already — through a reference that named it first.
      if (descriptor.id !== undefined && park.nodes.has(descriptor.id) && !park.unfilled.has(descriptor.id)) {
        return park.nodes.get(descriptor.id)!;
      }
      // Registered (and so reachable by its references) before its edges are
      // read, which is what lets an edge lead back to it.
      const node: NodePosition =
        descriptor.id !== undefined
          ? nodeNumbered(park, descriptor.id)
          : binding({ kind: 'nodePosition', fields: {}, fieldOrder: [], fieldProvenance: {}, edges: {} });
      if (descriptor.id !== undefined) park.unfilled.delete(descriptor.id);
      node.fields = withFileFields(inOrder(descriptor.fields, descriptor.fieldOrder), descriptor.fileFields);
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
    // Named before its own descriptor was read: read it now, from wherever in
    // the state it was written. A number no descriptor carries stays an
    // empty stand-in, which `assertParkRead` refuses.
    case 'nodeRef': {
      const written = park.nodes.has(descriptor.id) ? undefined : park.nodeDescriptors.get(descriptor.id);
      return written !== undefined ? rehydrate(written) : nodeNumbered(park, descriptor.id);
    }
    case 'handleRef': {
      const written = park.handles.has(descriptor.id) ? undefined : park.handleDescriptors.get(descriptor.id);
      return written !== undefined ? rehydrate(written) : handleNumbered(park, descriptor.id);
    }
    case 'lazyWalk':
      return binding({ kind: 'lazyWalk', walk: await rehydrateDeferredWalk(descriptor.walk, ctx, park) });
    case 'value':
      return binding({
        kind: 'value',
        value: descriptor.value,
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
      return binding({ kind: 'resource', resource: rehydrateResource(descriptor.resource) });
    // ── Bucket 3 — code refs from the re-parsed program ──
    case 'shape':
    case 'movement':
      return ctx.resolveCodeRef(descriptor.name, descriptor.file);
    case 'fileClosure': {
      const found = await ctx.resolveCodeRef(descriptor.name, descriptor.file);
      if (found.kind !== 'closure') {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `resume: '${descriptor.name}' parked as a file-level function, and the re-parsed ${descriptor.file === undefined ? 'program' : `library "${descriptor.file}"`} binds it to something else`,
        );
      }
      return found;
    }
    case 'opaque':
      return ctx.resolveCodeRef(descriptor.name);
    // Its words read the running file's scope after a resume — the body
    // scope it was declared in is the one being rebuilt.
    case 'localShape':
      return binding({ kind: 'shape', declaration: descriptor.declaration, local: true });
    case 'positions':
      return binding({
        kind: 'positions',
        landings: await settledAll(descriptor.landings.map(rehydrate)),
      });
    case 'tuple':
      return binding({
        kind: 'tuple',
        slots: await settledAll(descriptor.slots.map(rehydrate)),
      });
    case 'closure': {
      if (descriptor.scope !== undefined) {
        return binding({
          kind: 'closure',
          closure: descriptor.closure,
          captured: new Map(),
          env: await scopeOf(descriptor.scope, ctx, park),
          ...(descriptor.self !== undefined ? { self: descriptor.self } : {}),
        });
      }
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
        edges.set(name, await settledAll(descriptors.map(rehydrate)));
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
 * Serialise one `Environment`'s OWN bindings (no parent walk) to a scope-node.
 * The interpreter declares the imported / constructed / read bindings into the
 * env as it descends; this captures exactly what THIS scope added.
 */
export function serializeScope(env: Environment, park: ParkWriter = newParkWriter()): SerializedScope {
  const scope: SerializedScope = { bindings: {} };
  // Registered (and numbered, when a closure already holds it) before its
  // bindings are written: a closure in it holds it, and names it.
  if (!isFileScopeIn(park, env)) {
    const id = park.scopeIds.get(env);
    const outer = env.outer();
    if (id !== undefined) numberCopy(scope, id, outer !== undefined ? scopeRefOf(park, outer) : undefined);
    const copies = park.scopeCopies.get(env);
    if (copies !== undefined) copies.push(scope);
    else park.scopeCopies.set(env, [scope]);
  }
  writeBindings(scope.bindings, env, park);
  return scope;
}

/** One scope's OWN bindings, written into `bindings`. */
function writeBindings(bindings: Record<string, BindingDescriptor>, env: Environment, park: ParkWriter): void {
  for (const [name, binding] of env.ownBindings()) {
    const descriptor = serializeBinding(binding, park);
    // An opaque import's re-resolution tag is its slot NAME (it has no stored
    // declaration name); patch it in here where the name is known.
    bindings[name] = descriptor.kind === 'opaque' ? { ...descriptor, name } : descriptor;
  }
}

/**
 * Serialise the scope CHAIN from the movement body's root env down to (and
 * including) the ask's immediate env. `chain` is root-first; the interpreter
 * hands it the live env stack at the park point. Shared ancestor scopes are
 * serialised once because they appear once in the chain (§4.6) — the multi-leaf
 * frontier keys them by prefix instead, a superset of this single-branch shape.
 */
export function serializeScopeChain(chain: Environment[], park: ParkWriter = newParkWriter()): SerializedScope[] {
  carriesChain(park, chain);
  return chain.map((env) => serializeScope(env, park));
}

// ── Values that hold records or files ─────────────────────────────────────────

/**
 * Does this value hold a RECORD or a FILE anywhere inside it? Only then does
 * the value need the recursive descriptor: everything else is data and travels
 * as data, which is what every parked run before this one carries. A file is
 * said to be one (`{ kind: 'file' }`); its descriptor written as data would
 * come back as data.
 */
function holdsEngineValues(value: unknown): boolean {
  if (bindingOf(value) !== undefined || isFileValue(value)) return true;
  if (Array.isArray(value)) return value.some(holdsEngineValues);
  if (isDictValue(value)) return Object.values(value).some(holdsEngineValues);
  return false;
}

function serializeValue(value: unknown, park: ParkWriter): ValueDescriptor {
  const record = bindingOf(value);
  if (record !== undefined) return { kind: 'record', binding: serializeBinding(record, park) };
  if (isFileValue(value)) return { kind: 'file', file: { ...value } };
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
    case 'file':
      return revivedFile(descriptor.file);
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

/** A parked `file`: a file again, by the descriptor that said so. */
function revivedFile(descriptor: unknown): unknown {
  const file = fileValueOf(descriptor);
  if (file === undefined) {
    throw new MovementEngineError('MOVENG_PARK_NONSERIALIZABLE', `a parked file is not a file's descriptor: ${JSON.stringify(descriptor)}`);
  }
  return file;
}

/**
 * A record's fields that hold a file, each as its value descriptor — beside the
 * fields themselves, which a park still writes whole as data. Absent when no
 * field holds one (and on every park written before files were said to be).
 * A field never holds a record (the engine refuses one nested in a field), so
 * only files are walked.
 */
function fileFieldsOf(fields: Record<string, unknown>): Record<string, ValueDescriptor> | undefined {
  let out: Record<string, ValueDescriptor> | undefined;
  for (const [key, value] of Object.entries(fields)) {
    if (holdsFile(value)) (out ??= {})[key] = fileFieldValue(value);
  }
  return out;
}

function holdsFile(value: unknown): boolean {
  if (isFileValue(value)) return true;
  if (Array.isArray(value)) return value.some(holdsFile);
  if (isDictValue(value)) return Object.values(value).some(holdsFile);
  return false;
}

/** A field's value with its files said to be; the rest is the data the
 *  fields themselves already carry. */
function fileFieldValue(value: unknown): ValueDescriptor {
  if (isFileValue(value)) return { kind: 'file', file: { ...value } };
  if (Array.isArray(value)) return { kind: 'list', of: value.map(fileFieldValue) };
  if (isDictValue(value)) {
    const of: Record<string, ValueDescriptor> = {};
    for (const [key, entry] of Object.entries(value)) of[key] = fileFieldValue(entry);
    return { kind: 'map', of };
  }
  return { kind: 'data', value };
}

/** `fields` with each field a park said holds a file made whole again, in
 *  the fields' own order. */
function withFileFields(
  fields: Record<string, unknown>,
  fileFields: Record<string, ValueDescriptor> | undefined,
): Record<string, unknown> {
  if (fileFields === undefined) return fields;
  const out = { ...fields };
  for (const [key, descriptor] of Object.entries(fileFields)) out[key] = revivedFieldValue(descriptor);
  return out;
}

function revivedFieldValue(descriptor: ValueDescriptor): unknown {
  switch (descriptor.kind) {
    case 'data':
      return descriptor.value;
    case 'file':
      return revivedFile(descriptor.file);
    case 'list':
      return descriptor.of.map(revivedFieldValue);
    case 'map':
      return Object.fromEntries(Object.entries(descriptor.of).map(([key, entry]) => [key, revivedFieldValue(entry)]));
    case 'record':
      throw new MovementEngineError('MOVENG_PARK_NONSERIALIZABLE', 'a parked field holds a record, which no field can');
  }
}

// ── Exhaustiveness ────────────────────────────────────────────────────────────

function assertNever(value: never): never {
  throw new MovementEngineError(
    'MOVENG_PARK_NONSERIALIZABLE',
    `unhandled binding kind in scope serialisation: ${JSON.stringify(value)}`,
  );
}
