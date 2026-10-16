// The boundary every value crosses between the TypeScript side of the Rust
// engine (rust_engine.ts, rust_host.ts) and the WASM instance: the eval wire
// (crates/movement-engine/src/env.rs says the format), the plain-JSON check,
// and the shim's own faults.

import {
  fileHandle,
  fileValueOf,
  isCallbackParamType,
  isFileValue,
  isPlainObject,
  type BindingDescriptor,
  type CallbackParamSpec,
  type DeferredWalkDescriptor,
  type ExtractEmissionDescriptor,
  type FileFields,
  type FileValue,
  type NodeEdgeDescriptor,
  type ParkedScopeState,
  type ScopeLink,
  type SerializedCallEvent,
  type SerializedFrame,
  type SerializedScope,
  type ValueDescriptor,
} from 'engine-contracts';
import type { SchemaFieldType } from 'movement-lang';
import { neverAsAny } from '../../lib/utils/types';
import { binding, type Binding } from './expression';
import type { Provenance, ProvenanceOrigin } from './provenance';

export class RunAborted extends Error {
  constructor(readonly abortedWith: unknown) {
    super('the run was aborted by a host call');
  }
}

/** A fault in the shim itself (a request it has no route for, a result it
 *  cannot carry), never handed to the engine as an answer: the run fails. */
export class RustShimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RustShimError';
  }
}

// ── Boundary checks ───────────────────────────────────────────────────────────

/**
 * `value` itself when it is plain JSON (objects with no prototype but
 * Object's, arrays, strings, finite numbers, booleans, null); otherwise a
 * shim error naming the method that produced it. A stream, a closure, a Date
 * or a Map would not survive the crossing, and silently changing it into
 * something that does would hand the engine a different value.
 */
export function plainJson(value: unknown, method: string, at = ''): unknown {
  const where = at === '' ? '' : ` at ${at}`;
  const kind = typeof value;
  switch (kind) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (Number.isFinite(value)) return value;
      throw new RustShimError(`${method} returned ${String(value)}${where}, which JSON cannot carry`);
    case 'object':
      return plainJsonObject(value, method, at);
    case 'undefined':
    case 'function':
    case 'bigint':
    case 'symbol':
      throw new RustShimError(`${method} returned a ${kind}${where}, which is not plain JSON`);
    default:
      return neverAsAny(kind);
  }
}

/** `plainJson` for a value whose `typeof` is `object`. */
function plainJsonObject(value: unknown, method: string, at: string): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    value.forEach((item, i) => plainJson(item, method, `${at}[${i}]`));
    return value;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const kind = value.constructor?.name ?? 'an object with a prototype';
    const where = at === '' ? '' : ` at ${at}`;
    throw new RustShimError(`${method} returned a ${kind}${where}, which is not plain JSON`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) plainJson(entry, method, at === '' ? key : `${at}.${key}`);
  }
  return value;
}

export function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RustShimError(`${what}: args must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

export function string(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new RustShimError(`${what} must be a string`);
  return value;
}

export function optionalString(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : string(value, what);
}

/** A list of strings, or none (`[]`). */
export function optionalStringList(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RustShimError(`${what} must be a list of strings`);
  return value.map((entry, at) => string(entry, `${what}[${at}]`));
}

export function optionalStringRecord(value: unknown, what: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(record(value, what));
  return Object.fromEntries(entries.map(([key, entry]) => [key, string(entry, `${what}.${key}`)]));
}

export const REFUSED: unique symbol = Symbol('refused');

/** A lone surrogate, which crosses the eval wire as U+FFFD. */
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A text on the wire: each lone surrogate U+FFFD (a value, a key, a
 *  file's display alike). */
function wireText(text: string): string {
  return text.replace(LONE_SURROGATES, '\uFFFD');
}

/** A text off the wire. */
function textOfWire(wire: unknown, what: string): string {
  if (typeof wire === 'string') return wire;
  throw new RustShimError(`${what} is a text`);
}

/**
 * `object[key] = value` as `JSON.parse` and a spread write it: an own,
 * enumerable entry, whatever the key. An assignment would run
 * `Object.prototype`'s `__proto__` setter instead, making a host's own
 * `__proto__` key the object's prototype. A null-prototype object would keep
 * the key too, but would read no `Object.prototype` member, which the
 * engine's dicts do.
 */
export function ownEntry(object: object, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

export function isCallbackParam(value: unknown): value is CallbackParamSpec {
  if (typeof value !== 'object' || value === null) return false;
  const type: unknown = Reflect.get(value, 'type');
  return typeof Reflect.get(value, 'name') === 'string' && typeof type === 'string' && isCallbackParamType(type);
}

/**
 * A record the engine handed the host (`["x", id, descriptor]`), built from
 * the descriptor the engine wrote: the event's binding object, or a
 * callback's. Only the wire's own tag makes one, so nothing the host or a
 * webhook sends can become one, whatever keys it carries.
 */
function bindingFromWire(descriptor: unknown): Binding {
  const kind = typeof descriptor === 'object' && descriptor !== null ? Reflect.get(descriptor, 'kind') : undefined;
  if (kind === 'event') return binding({ kind: 'event' });
  if (kind === 'callback' && typeof descriptor === 'object' && descriptor !== null) {
    const callbackId: unknown = Reflect.get(descriptor, 'callbackId');
    const url: unknown = Reflect.get(descriptor, 'url');
    const params: unknown = Reflect.get(descriptor, 'params');
    if (typeof callbackId !== 'string' || typeof url !== 'string' || !Array.isArray(params) || !params.every(isCallbackParam)) {
      throw new RustShimError('the engine handed the host a callback that is not {callbackId, url, params}');
    }
    return binding({ kind: 'callback', callbackId, url, params });
  }
  throw new RustShimError(`the engine handed the host a record of kind ${String(kind)}, which the shim does not rebuild`);
}

/**
 * The wire to the Rust engine and back (crates/movement-engine/src/env.rs
 * says the format): plain JSON values, and the origins of the trails they
 * carry, numbered. A list is `["l", items]` and an object `["o", entries]`;
 * `undefined`, `NaN`, `±Infinity` and `-0` cross as `null`, a lone surrogate
 * as U+FFFD, and nothing crosses by identity (an object reached twice is
 * written twice). A value is data or one of the engine's records, and the
 * two never share a form: every object the host writes is data, whatever
 * keys it carries; a record is only ever one the engine handed out
 * (`["x", id, descriptor]`), handed back by its id. A file crosses as an
 * opaque handle (`["F", id, { handle, name, contentType, size }]` to the
 * engine, `["F", id]` back): the segment's `files` table keeps the
 * descriptor — its source, credential, store and URL never reach the engine
 * — and the tag, never a descriptor's keys, is what makes a file.
 */
export class FileTable {
  private readonly byId: FileValue[] = [];
  private readonly ids = new Map<FileValue, number>();

  /** The id the engine holds a file by: one per file object. */
  id(file: FileValue): number {
    let id = this.ids.get(file);
    if (id === undefined) {
      id = this.byId.length;
      this.byId.push(file);
      this.ids.set(file, id);
    }
    return id;
  }

  /** The file the engine names by `id`. */
  file(id: unknown): FileValue {
    const file = typeof id === 'number' ? this.byId[id] : undefined;
    if (file === undefined) throw new RustShimError(`the engine named a file ${String(id)} this segment never handed it`);
    return file;
  }
}

export class WireOut {
  constructor(options: { files?: FileTable } = {}) {
    this.files = options.files ?? new FileTable();
  }

  /** The files this wire handed the engine, by id. */
  readonly files: FileTable;

  /** The records the engine handed out, by the id it gave each. */
  private readonly records = new Map<number, Binding>();
  private readonly recordIds = new Map<object, number>();

  /** The objects being written now: one met again inside itself is a cycle. */
  private readonly open = new Set<object>();
  readonly origins: ProvenanceOrigin[] = [];
  private readonly originIds = new Map<ProvenanceOrigin, number>();

  /** `value` on the wire, or REFUSED where it would not cross as data: a
   *  function, a Date, a class instance, a cycle (an own `__proto__` key
   *  crosses as the key it is). A record the engine handed out crosses back
   *  as itself; nothing else is a record. */
  value(value: unknown): unknown {
    const kind = typeof value;
    switch (kind) {
      case 'undefined':
        return null;
      case 'boolean':
        return value;
      case 'string':
        return typeof value === 'string' ? wireText(value) : value;
      case 'number':
        return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) ? value : null;
      case 'object':
        return this.composite(value);
      case 'function':
      case 'bigint':
      case 'symbol':
        return REFUSED;
      default:
        return neverAsAny(kind);
    }
  }

  private composite(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (isFileValue(value)) {
      // The engine's opaque handle: its id, its identity, what it may print.
      const handle = fileHandle(value);
      const shown = {
        ...(handle !== undefined ? { handle: wireText(handle) } : {}),
        ...(value.name !== undefined ? { name: wireText(value.name) } : {}),
        ...(value.contentType !== undefined ? { contentType: wireText(value.contentType) } : {}),
        ...(value.size !== undefined ? { size: value.size } : {}),
      };
      return ['F', this.files.id(value), shown];
    }
    const record = this.recordIds.get(value);
    if (record !== undefined) return ['x', record];
    if (this.open.has(value)) return REFUSED;
    const proto: unknown = Object.getPrototypeOf(value);
    const isList = Array.isArray(value) && proto === Array.prototype;
    if (!isList && proto !== Object.prototype && proto !== null) return REFUSED;
    this.open.add(value);
    try {
      if (Array.isArray(value)) {
        const items: unknown[] = [];
        for (let i = 0; i < value.length; i++) {
          // A hole is not `undefined` to every array method.
          if (!(i in value)) return REFUSED;
          const item = this.value(value[i]);
          if (item === REFUSED) return REFUSED;
          items.push(item);
        }
        return ['l', items];
      }
      // An own `__proto__` key (`JSON.parse` makes one) is a key like any
      // other: the engine holds it as an own entry, and `read` hands it back
      // as one.
      const keys = Object.keys(value);
      if (Object.getOwnPropertyNames(value).length !== keys.length) return REFUSED;
      const entries: unknown[] = [];
      for (const key of keys) {
        const item = this.value(Reflect.get(value, key));
        if (item === REFUSED) return REFUSED;
        entries.push([wireText(key), item]);
      }
      return ['o', entries];
    } finally {
      this.open.delete(value);
    }
  }

  trail(provenance: Provenance): { origins: number[]; direct?: number } {
    return {
      origins: provenance.origins.map((o) => this.originId(o)),
      ...(provenance.direct !== undefined ? { direct: this.originId(provenance.direct) } : {}),
    };
  }

  private originId(origin: ProvenanceOrigin): number {
    let id = this.originIds.get(origin);
    if (id === undefined) {
      id = this.origins.length;
      this.origins.push(origin);
      this.originIds.set(origin, id);
    }
    return id;
  }

  /** A value back from the wire. */
  read(wire: unknown): unknown {
    if (!Array.isArray(wire)) return wire;
    const [tag, a, b] = wire;
    switch (tag) {
      case 'x': {
        if (typeof a !== 'number') throw new RustShimError(`the engine handed the host a record it cannot carry (${String(a)})`);
        const held = this.records.get(a);
        if (held !== undefined) return held;
        const record = bindingFromWire(this.read(b));
        this.records.set(a, record);
        this.recordIds.set(record, a);
        return record;
      }
      case 'F':
        return this.files.file(a);
      case 'l':
        if (!Array.isArray(a)) throw new RustShimError('a wire list is ["l", items]');
        return a.map((item) => this.read(item));
      case 'o': {
        if (!Array.isArray(a)) throw new RustShimError('a wire object is ["o", entries]');
        const object: Record<string, unknown> = {};
        for (const entry of a) {
          if (!Array.isArray(entry)) throw new RustShimError('a wire entry is [key, value]');
          ownEntry(object, textOfWire(entry[0], "a wire entry's key"), this.read(entry[1]));
        }
        return object;
      }
      default:
        throw new RustShimError(`an unknown wire tag ${String(tag)}`);
    }
  }
}

// ── Files the host makes for the engine ─────────────────────────────────────

const SCALAR_FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'datetime', 'file', 'json', 'absent'] as const;

/** A field type the engine named (`filesAt`), as the catalog spells one;
 *  undefined for anything else. */
export function schemaFieldTypeOf(value: unknown): SchemaFieldType | undefined {
  if (typeof value === 'string') return SCALAR_FIELD_TYPES.find((scalar) => scalar === value);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const kind: unknown = Reflect.get(value, 'kind');
  const of: unknown = Reflect.get(value, 'of');
  switch (kind) {
    case 'list':
    case 'dict':
    case 'maybeAbsent': {
      const inner = schemaFieldTypeOf(of);
      return inner !== undefined ? { kind, of: inner } : undefined;
    }
    case 'tuple':
      return Array.isArray(of) ? { kind, of: of.map((slot) => (slot === null ? null : (schemaFieldTypeOf(slot) ?? null))) } : undefined;
    // An enum holds no file: nothing the host makes there.
    default:
      return undefined;
  }
}

/*
 * A parked state's files, made host-side so the engine is handed each one's
 * opaque handle and never its descriptor. The walk follows the park's
 * STRUCTURE (engine-contracts' park_state.ts), as the park reader's index does
 * (serialize.ts `indexState`, park.rs `over_state`) — never a list of key
 * names: a scope's `bindings`, a closure's `captured` and an edge map are
 * keyed by the AUTHOR's names, so they are walked as maps of descriptors
 * whatever the names are, and each descriptor is read by its `kind`.
 *
 * A file is made ONLY where the structure says one is: a `{ kind: 'file' }`
 * value descriptor (a record value's, or one a `fileFields` entry names) and a
 * resource's `fileRef` slot (with its `data.file`). A data payload — a
 * `value`, a `data` value, a record's `fields`, an edge's properties, a write
 * handle's record — and code (a closure's body, a walk's head, an op) are
 * never read into: whatever shape data has, it is never a file. A descriptor
 * of a kind this walk does not know is left as it is (data), never searched.
 */

/** A parked state (`ParkedScopeState`) with its files made. */
export function filesInParkState(state: unknown): unknown {
  if (!isPlainObject(state)) return state;
  const parked = state as unknown as ParkedScopeState;
  const out: Record<string, unknown> = { ...state };
  if (Array.isArray(parked.scopeChain)) out.scopeChain = scopesFiles(parked.scopeChain);
  if (Array.isArray(parked.journal)) out.journal = journalFiles(parked.journal);
  if (Array.isArray(parked.frames)) out.frames = parked.frames.map(frameFiles);
  return out;
}

/**
 * A frame's persisted branch rows (`collectBranchExports`) with their files
 * made. A row's `exports` is one of four shapes, and in each every member
 * that is an object is a binding descriptor: a branch's exports (its names →
 * descriptors), an op's start (`source`, `init`), a finished member
 * (`kept`, a boolean, and `answer`), a run-time combinator's `arms` (a
 * number). So each object member is walked as the descriptor it is.
 */
export function filesInBranchExports(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row: unknown) => {
    if (!isPlainObject(row) || !isPlainObject(row.exports)) return row;
    const exports = row.exports;
    return { ...row, exports: mapFiles(exports, (member) => (isPlainObject(member) ? descriptorFiles(member as unknown as BindingDescriptor) : member)) };
  });
}

/** A map keyed by the author's names (or a record's fields), each entry
 *  walked by `files`: the keys never matter. */
function mapFiles(entries: unknown, files: (entry: unknown) => unknown): unknown {
  if (!isPlainObject(entries)) return entries;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(entries)) ownEntry(out, key, files(entry));
  return out;
}

function listFiles<T>(list: unknown, files: (entry: T) => unknown): unknown {
  return Array.isArray(list) ? list.map((entry: T) => files(entry)) : list;
}

function bindingsFiles(bindings: unknown): unknown {
  return mapFiles(bindings, (entry) => descriptorFiles(entry as BindingDescriptor));
}

function scopesFiles(chain: SerializedScope[]): unknown {
  return chain.map((scope) =>
    isPlainObject(scope)
      ? {
          ...scope,
          bindings: bindingsFiles(scope.bindings),
          ...(scope.parent !== undefined ? { parent: scopeLinkFiles(scope.parent) } : {}),
        }
      : scope,
  );
}

/** A scope link: a written `scope`'s bindings are a map of descriptors (and
 *  its parent a link); a `scopeRef` or a `file` link holds nothing. */
function scopeLinkFiles(link: ScopeLink): unknown {
  if (!isPlainObject(link)) return link;
  switch (link.kind) {
    case 'scope':
      return {
        ...link,
        bindings: bindingsFiles(link.bindings),
        ...(link.parent !== undefined ? { parent: scopeLinkFiles(link.parent) } : {}),
      };
    case 'scopeRef':
    case 'file':
      return link;
    default:
      neverAsAny(link);
      return link;
  }
}

function journalFiles(journal: SerializedCallEvent[]): unknown {
  return journal.map((event) =>
    isPlainObject(event) && isPlainObject(event.value) ? { ...event, value: descriptorFiles(event.value) } : event,
  );
}

function frameFiles(frame: SerializedFrame): unknown {
  if (!isPlainObject(frame)) return frame;
  switch (frame.kind) {
    // A member frame's `op` is code.
    case 'call':
    case 'member':
      return {
        ...frame,
        scopeChain: Array.isArray(frame.scopeChain) ? scopesFiles(frame.scopeChain) : frame.scopeChain,
        journal: Array.isArray(frame.journal) ? journalFiles(frame.journal) : frame.journal,
      };
    // A run-time arm's `body` is code; its bindings ride on the chain.
    case 'arm':
      return frame;
    default:
      neverAsAny(frame);
      return frame;
  }
}

function walkFiles(walk: DeferredWalkDescriptor): unknown {
  // The walk's `head` and `mapping` are code.
  return isPlainObject(walk) ? { ...walk, captured: bindingsFiles(walk.captured) } : walk;
}

/** A value descriptor: a `file` made a file, a record's binding and a list's
 *  or map's members walked, `data` left as it is. */
function valueFiles(value: ValueDescriptor): unknown {
  if (!isPlainObject(value)) return value;
  switch (value.kind) {
    case 'data':
      return value;
    case 'file':
      return { ...value, file: fileValueOf(value.file) ?? value.file };
    case 'record':
      return { ...value, binding: descriptorFiles(value.binding) };
    case 'list':
      return { ...value, of: listFiles(value.of, valueFiles) };
    case 'map':
      return { ...value, of: mapFiles(value.of, (entry) => valueFiles(entry as ValueDescriptor)) };
    default:
      neverAsAny(value);
      return value;
  }
}

/** A record's `fileFields`: the fields that hold a file, each its value
 *  descriptor. The record's `fields` beside it stay data. */
function fileFieldsFiles(fileFields: FileFields | undefined): unknown {
  return mapFiles(fileFields, (entry) => valueFiles(entry as ValueDescriptor));
}

function emissionFiles(emission: ExtractEmissionDescriptor): unknown {
  if (!isPlainObject(emission)) return emission;
  // `fields`, `provenance` and `origin` are data.
  return {
    ...emission,
    ...(emission.fileFields !== undefined ? { fileFields: fileFieldsFiles(emission.fileFields) } : {}),
    ...(emission.resources !== undefined ? { resources: listFiles(emission.resources, resourceFiles) } : {}),
    ...(emission.children !== undefined ? { children: mapFiles(emission.children, (list) => listFiles(list, emissionFiles)) } : {}),
  };
}

function descriptorFiles(descriptor: BindingDescriptor): unknown {
  if (!isPlainObject(descriptor)) return descriptor;
  switch (descriptor.kind) {
    case 'handle':
      // `handle` (the record written) and `graph` are data.
      return descriptor.old !== undefined ? { ...descriptor, old: descriptorFiles(descriptor.old) } : descriptor;
    case 'extractRoot':
    case 'extractPosition':
      return { ...descriptor, emission: emissionFiles(descriptor.emission) };
    case 'resource':
      return { ...descriptor, resource: resourceFiles(descriptor.resource) };
    case 'blockMeta':
      return { ...descriptor, edges: mapFiles(descriptor.edges, (landings) => listFiles(landings, descriptorFiles)) };
    case 'positions':
      return { ...descriptor, landings: listFiles(descriptor.landings, descriptorFiles) };
    case 'tuple':
      return { ...descriptor, slots: listFiles(descriptor.slots, descriptorFiles) };
    // A closure's `closure` is code; its capture is a map of descriptors,
    // and its scope a scope link.
    case 'closure':
      return {
        ...descriptor,
        captured: bindingsFiles(descriptor.captured),
        ...(descriptor.scope !== undefined ? { scope: scopeLinkFiles(descriptor.scope) } : {}),
      };
    case 'recordValue':
      return { ...descriptor, value: valueFiles(descriptor.value) };
    case 'shapePosition':
      // `fields` and `fieldProvenance` are data.
      return descriptor.fileFields !== undefined ? { ...descriptor, fileFields: fileFieldsFiles(descriptor.fileFields) } : descriptor;
    case 'nodePosition':
      // `fields` and `fieldProvenance` are data.
      return {
        ...descriptor,
        ...(descriptor.fileFields !== undefined ? { fileFields: fileFieldsFiles(descriptor.fileFields) } : {}),
        edges: mapFiles(descriptor.edges, (edge) => edgeFiles(edge as NodeEdgeDescriptor)),
      };
    case 'lazyWalk':
      return { ...descriptor, walk: walkFiles(descriptor.walk) };
    // Data or code throughout: nothing in them is a file.
    case 'event':
    case 'instance':
    case 'handleRef':
    case 'nodeRef':
    case 'sourcePosition':
    case 'value':
    case 'callback':
    case 'shape':
    case 'localShape':
    case 'movement':
    case 'fileClosure':
    case 'opaque':
      return descriptor;
    default:
      neverAsAny(descriptor);
      return descriptor;
  }
}

function edgeFiles(edge: NodeEdgeDescriptor): unknown {
  if (!isPlainObject(edge)) return edge;
  switch (edge.kind) {
    // `landing` / `landingShape` are the shape a later write mints from.
    case 'landed':
      return { ...edge, landings: listFiles(edge.landings, descriptorFiles) };
    case 'deferred':
      return { ...edge, walk: walkFiles(edge.walk) };
    default:
      neverAsAny(edge);
      return edge;
  }
}

/** A parked resource with its `fileRef` slot (and `data.file`) a file. */
function resourceFiles(resource: unknown): unknown {
  if (!isPlainObject(resource)) return resource;
  const file = fileValueOf(resource.fileRef);
  if (file === undefined) return resource;
  const data = isPlainObject(resource.data) && Object.hasOwn(resource.data, 'file') ? { ...resource.data, file } : resource.data;
  return { ...resource, fileRef: file, ...(resource.data !== undefined ? { data } : {}) };
}
