// An adapter instance as the engine holds it: not the live adapter, which
// stays on the host, but a stand-in that answers each method by asking the
// host (`adapters.call`) and reads everything else — what the instance is,
// what it can do, which methods it implements — off the data `adapters.resolve`
// answered. The interpreter's own code calls it as it would any `Adapter`, so
// the protocol it speaks to its instances is unchanged; only the far side
// moved behind the boundary.
//
// A host call answers a result or a typed error. The error is mapped onto the
// engine's own control flow here, once: the call ceiling is the engine's
// `AdapterCallCeilingReached` (which `onError` never forgives), anything else
// is an ordinary failure carrying the host's message.

import type { AdapterCallError, AdapterCallMap, AdapterMethod, EngineHost, HostErrorDetail, ResolvedAdapter } from './host';

import { neverAsAny } from '../../lib/utils/types';
import { iterateRelatedPages, type Adapter } from '../translation_graph/adapter';

/** Where a stand-in's calls go: the instance's id within its segment. */
const HOST_INSTANCE = Symbol('host adapter instance');

interface HostInstance {
  segmentId: string;
  instance: string;
}

/**
 * A call refused because the segment made as many third-party calls as one
 * segment may. Its message is the host's, and it is the whole failure surface
 * an author sees: the number, the knob, and why the run stopped.
 */
export class AdapterCallCeilingReached extends Error {
  readonly kind = 'call_ceiling';
  constructor(message: string) {
    super(message);
    // The name the run's failure reason has always carried.
    this.name = 'AdapterCallCeilingExceeded';
  }
}

export function isAdapterCallCeilingReached(error: unknown): error is AdapterCallCeilingReached {
  return error instanceof AdapterCallCeilingReached;
}

/** An adapter's failure as the engine raises it: the host's message, under
 *  the failure's own name, with what the host knows of it. */
export class AdapterCallFailed extends Error {
  readonly detail?: HostErrorDetail;
  constructor(error: AdapterCallError) {
    super(error.message);
    if (error.name !== undefined) this.name = error.name;
    if (error.detail !== undefined) this.detail = error.detail;
  }
}

/** An adapter call's error, as the engine raises it. */
export function hostCallFailure(error: AdapterCallError): Error {
  switch (error.kind) {
    case 'call_ceiling':
      return new AdapterCallCeilingReached(error.message);
    case 'adapter_error':
      return new AdapterCallFailed(error);
    default:
      return neverAsAny(error.kind);
  }
}

/**
 * A host's data as either engine reads it: every `Date` in it made the ISO
 * text it stands for (`null` for an invalid one), as a park's JSON already
 * makes it. A value the engine reads from outside — an adapter's answer, the
 * event — is read through this on both engines, so a `Date` never reaches a
 * program: its text, its comparisons and its park are the ISO string's on
 * both. No adapter answers one today (every date-typed field arrives as
 * text), so no saved program's behaviour changes and no version is needed.
 *
 * Copied only along a path that holds a `Date`: anything else is handed on
 * as the very object it was, its prototype and own keys (`__proto__`
 * included) kept, so the identity of a host's object is unchanged. Only
 * arrays and plain objects are walked; anything else is left as it is.
 */
export function isoDates<T>(value: T): T {
  // Why the assertion: the walk changes only `Date`s, which no declared
  // answer type of an adapter or the event holds.
  return isoDatesIn(value, new Map()) as T;
}

function isoDatesIn(value: unknown, seen: Map<object, unknown>): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'object' || value === null) return value;
  const walked = seen.get(value);
  if (walked !== undefined) return walked;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  // Itself until a `Date` is found below it: a cycle back to it reads it.
  seen.set(value, value);
  const changed: Array<[string, unknown]> = [];
  for (const key of Object.keys(value)) {
    const inner: unknown = Reflect.get(value, key);
    const made = isoDatesIn(inner, seen);
    if (made !== inner) changed.push([key, made]);
  }
  if (changed.length === 0) return value;
  const copy: object = Array.isArray(value) ? value.slice() : Object.create(Object.getPrototypeOf(value), Object.getOwnPropertyDescriptors(value));
  for (const [key, made] of changed) Object.defineProperty(copy, key, { value: made, writable: true, enumerable: true, configurable: true });
  seen.set(value, copy);
  return copy;
}

/** The host instance a stand-in calls, or undefined for an adapter the engine
 *  implements itself (a local edge store). A wrapper that forwards unknown
 *  properties (the natural-name read wrapper) forwards this too. */
export function hostInstanceOf(adapter: Adapter): HostInstance | undefined {
  const found: unknown = Reflect.get(adapter, HOST_INSTANCE);
  return isHostInstance(found) ? found : undefined;
}

function isHostInstance(value: unknown): value is HostInstance {
  return (
    typeof value === 'object' &&
    value !== null &&
    'segmentId' in value &&
    typeof value.segmentId === 'string' &&
    'instance' in value &&
    typeof value.instance === 'string'
  );
}

/** Methods every `Adapter` declares; an instance may still lack one (a fake,
 *  a partial remote), and the engine checks before it calls. */
const DECLARED_METHODS = [
  'listEntryPoints',
  'describe',
  'resolveEntity',
  'getFieldValue',
  'getRelated',
  'createRecord',
  'updateRecord',
  'deleteRecord',
] as const;

export function hostAdapter(input: { host: EngineHost; segmentId: string; resolved: ResolvedAdapter }): Adapter {
  const { host, segmentId, resolved } = input;
  const target: HostInstance = { segmentId, instance: resolved.instance };
  const has = new Set(resolved.methods);
  const call = async <M extends AdapterMethod>(
    method: M,
    args: AdapterCallMap[M]['args'],
  ): Promise<AdapterCallMap[M]['result']> => {
    const answer = await host.adapters.call({ ...target, method, args });
    if ('error' in answer) throw hostCallFailure(answer.error);
    return isoDates(answer.result);
  };
  const optional = <M extends AdapterMethod, F>(method: M, fn: F): F | undefined => (has.has(method) ? fn : undefined);
  const capabilities = resolved.capabilities;

  const adapter: Adapter = {
    adapterType: resolved.adapterType,
    supportedTriggers: resolved.supportedTriggers,
    runtimeCapabilities: () => capabilities,
    ...(resolved.walksContainers !== undefined ? { walksContainers: resolved.walksContainers } : {}),
    ...(resolved.webhookEventTypeId !== undefined ? { webhookEventTypeId: resolved.webhookEventTypeId } : {}),
    ...(resolved.metaRecordType !== undefined ? { metaRecordType: resolved.metaRecordType } : {}),
    ...(has.has('resolveAwait') ? { awaitable: { resolveAwait: (point) => call('resolveAwait', point) } } : {}),
    listEntryPoints: () => call('listEntryPoints', {}),
    describe: (typeId) => call('describe', { typeId }),
    resolveEntity: (args) => call('resolveEntity', args),
    getFieldValue: (args) => call('getFieldValue', args),
    getRelated: (args) => call('getRelated', args),
    createRecord: (args) => call('createRecord', args),
    updateRecord: (args) => call('updateRecord', args),
    deleteRecord: (args) => call('deleteRecord', args),
    edgesFrom: optional('edgesFrom', (position, cursor) =>
      call('edgesFrom', { position, ...(cursor !== undefined ? { cursor } : {}) }),
    ),
    // The instance streams; the engine walks the stream a page at a time, so
    // no iteration crosses the boundary.
    iterateRelated: has.has('iterateRelated')
      ? (args) => iterateRelatedPages((cursor) => call('iterateRelatedPage', { ...args, ...(cursor !== undefined ? { cursor } : {}) }))
      : undefined,
    iterateRelatedPage: optional('iterateRelatedPage', (args, cursor) =>
      call('iterateRelatedPage', { ...args, ...(cursor !== undefined ? { cursor } : {}) }),
    ),
    preprocessInbound: optional('preprocessInbound', (args) => call('preprocessInbound', args)),
    wakeKeys: optional('wakeKeys', (args) => call('wakeKeys', args)),
    listEventTypes: optional('listEventTypes', () => call('listEventTypes', {})),
    linkRecords: optional('linkRecords', (args) => call('linkRecords', args)),
    unlinkRecords: optional('unlinkRecords', (args) => call('unlinkRecords', args)),
    ensureEventSubscription: optional('ensureEventSubscription', (args) => call('ensureEventSubscription', args)),
    removeEventSubscription: optional('removeEventSubscription', async (args) => {
      await call('removeEventSubscription', args);
    }),
    invokeFieldFunction: optional('invokeFieldFunction', (args) => call('invokeFieldFunction', args)),
    readRecord: optional('readRecord', (args) => call('readRecord', args)),
    describeOpaqueId: optional('describeOpaqueId', (args) => call('describeOpaqueId', args)),
    translateFilter: optional('translateFilter', (args) => call('translateFilter', args)),
    getDedupRules: optional('getDedupRules', (args) => call('getDedupRules', args)),
    getActorCandidates: optional('getActorCandidates', (args) => call('getActorCandidates', args)),
    extractActor: optional('extractActor', (args) => call('extractActor', args)),
  };
  // An optional method the instance lacks is absent, not undefined, so a
  // presence check (`'readRecord' in adapter`, a spread) reads the instance
  // as it is; a declared one it lacks goes the same way.
  for (const [name, value] of Object.entries(adapter)) {
    if (value === undefined) Reflect.deleteProperty(adapter, name);
  }
  for (const method of DECLARED_METHODS) {
    if (!has.has(method)) Reflect.deleteProperty(adapter, method);
  }
  Object.defineProperty(adapter, HOST_INSTANCE, { value: target });
  return adapter;
}
