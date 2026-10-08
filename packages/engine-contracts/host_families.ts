// The host's families, as data: what every request and answer carries, the
// shapes that cross on their own (a segment's opening, an adapter resolution,
// a binding endpoint, a wake), and the manifest of every family and method.
// The full `EngineHost` interface — each method over the engine's own value
// types — is the engine's (apps/api `movement_engine/host.ts`), which the
// compiler holds equal to the manifest here.

import type { LanguageVersion } from 'movement-lang';

import type { Budget, CostLine } from './cost';
import type { MethodName } from './protocol';
import type { TenantId } from './tenant';

// ── Priced calls ────────────────────────────────────────────────────────────
//
// Every host call that may cost money takes the run's remaining budget in and
// answers what it spent. The host refuses priced work past the budget with a
// `budget` refusal carrying what it spent first; the engine keeps the run's
// account and raises the cap from it.

/** A priced call's request: the engine's input and the run's remaining budget. */
export type Priced<Input> = Input & { budget: Budget };

// ── Segments ────────────────────────────────────────────────────────────────
//
// Every host call names the segment it is made for (`segment.open` answers
// the id; one segment per open). The host maps the segment to its run and its
// tenant, so no request repeats the tenant.

/** What every request carries: the segment it is made in. */
export interface InSegment {
  segmentId: string;
}

/** A request, named by its segment. */
export type Scoped<Input> = Input & InSegment;

/** A family as the host serves it: the engine's own view of it
 *  (`ParkSink`, `CancelGate`, …), each method's one request naming the
 *  segment. A method the engine calls with no argument takes the segment
 *  alone. */
export type SegmentScoped<Family> = {
  [Method in keyof Family]: NonNullable<Family[Method]> extends (...args: infer Args) => infer Answer
    ? (input: Scoped<Args extends [infer Input] ? Input : unknown>) => Answer
    : never;
};

/** A priced call's answer and what the call spent, by source. Absent ⇒ it
 *  spent nothing. */
export type Costed<Output> = Output & { cost?: CostLine[] };

/**
 * Why a host call did not answer, as data. The engine maps each kind onto its
 * own control flow; nothing thrown on the host side is recognised by class on
 * the engine side.
 *
 *  - `call_ceiling`: the segment made as many third-party calls as one segment
 *    may. The engine fails the run with the message, and `onError` never
 *    forgives it.
 *  - `budget`: priced work refused because the run's budget is spent. The
 *    engine charges what the call spent first and raises the run's cap. Only
 *    a priced call answers it.
 *  - `adapter_error`: the adapter failed; the engine fails the statement with
 *    the message, as it would any error, under the failure's own `name`.
 */
export interface HostCallError {
  kind: 'call_ceiling' | 'adapter_error' | 'budget';
  message: string;
  /** The failure's own name on the host (`SlackApiError`), when it is not a
   *  plain `Error`. */
  name?: string;
  /** What else the host knows of the failure. */
  detail?: HostErrorDetail;
}

/** A failure's particulars that a caller may branch on or report: the HTTP
 *  status the remote answered, and its error code. */
export interface HostErrorDetail {
  status?: number;
  code?: string;
}

/** Why an adapter call did not answer. An adapter call is not priced (it
 *  carries no budget), so it is never refused as `budget`. */
export type AdapterCallError = HostCallError & { kind: 'call_ceiling' | 'adapter_error' };

/** A priced call refused past the budget, with what it spent before the
 *  refusal. */
export type BudgetRefusal = Costed<{ error: HostCallError & { kind: 'budget' } }>;

/** A priced call's whole answer: what it was asked for, or the refusal. */
export type PricedAnswer<Output> = Costed<Output> | BudgetRefusal;

/** What the engine asks of an adapter instance. */
export interface AdapterResolution {
  adapterType: string;
  credentialsId?: string;
  /** Non-credential construction args (unquoted) — the instance's entry
   *  position (Sheets' `spreadsheet:`). Position-free adapters ignore it. */
  constructionArgs?: Record<string, string>;
  role: 'source' | 'target';
  /** Rehearse its writes: the host wraps the instance so a create, update,
   *  delete, link or unlink is captured (the host's write sink), never made,
   *  and reads still answer from the live system. */
  dryRun?: boolean;
}

/**
 * The adapter protocol's methods the engine may call on an instance, by name
 * (the protocol's own `METHODS`, `./protocol.ts`). Three
 * are not here: `manifest`, which `adapters.resolve` answers as data;
 * `iterateRelated`, whose async iterable never crosses — the engine walks a
 * traversal page by page with `iterateRelatedPage`; and `resolveFileRef`,
 * whose answer is a byte stream — bytes stay on the host, which redeems a
 * file's descriptor itself (`files.resolveFileText`, a target's upload).
 */
export const ADAPTER_METHODS = [
  'listEntryPoints',
  'describe',
  'edgesFrom',
  'resolveEntity',
  'getFieldValue',
  'getRelated',
  'iterateRelatedPage',
  'preprocessInbound',
  'listEventTypes',
  'createRecord',
  'updateRecord',
  'deleteRecord',
  'linkRecords',
  'unlinkRecords',
  'ensureEventSubscription',
  'removeEventSubscription',
  'resolveAwait',
  'wakeKeys',
  'readRecord',
  'translateFilter',
  'getDedupRules',
  'getActorCandidates',
  'extractActor',
  'describeOpaqueId',
  'invokeFieldFunction',
] as const satisfies readonly MethodName[];

export type AdapterMethod = (typeof ADAPTER_METHODS)[number];

/** What a segment is opened for. */
export interface SegmentOpening {
  /** The run, when it has one (a test or dry run may not). */
  runId?: string;
  /** The tenant the segment is opened for: opaque to the engine. */
  teamId: TenantId;
  /** The movement's pin, which an adapter's version conditionals read. */
  languageVersion: LanguageVersion;
  /** The host families version the engine speaks (`HOST_FAMILIES_VERSION`);
   *  a host refuses one it does not serve. */
  hostFamiliesVersion: number;
}

/**
 * One fully-qualified record position — a binding endpoint. NOT (system,
 * recordId): the same record id in a different Airtable base is a different
 * record, so the endpoint carries the instance's identity too. Construction
 * config is the raw, un-normalized args the engine already holds; the store
 * canonicalizes it.
 */
export interface BindingEndpoint {
  /** Adapter slug (any casing — the store normalizes it). */
  adapterType: string;
  /** The credential's stable identity, when the instance has one. Absent for
   *  construction-free intrinsics (manual, cron) and the KG. */
  credentialId?: string;
  /** The instance's construction config (the Airtable base, the Slack
   *  workspace, …) — the args the movement's construction call carried; the
   *  credential arg is carried separately via `credentialId`. Omit / `{}` when
   *  none. */
  constructionConfig?: Record<string, unknown>;
  /** The STABLE INTERNAL type id (already resolved natural→internal), so a
   *  type rename never orphans a binding. */
  typeId: string;
  /** The stable external record id (KG node id when this endpoint is the KG). */
  recordId: string;
}

/** An endpoint as the store keeps it: the instance canonicalized into one
 *  key. A counterpart comes back in this form, and the engine can hand it
 *  back (to delete a stale binding) without reversing the key. */
export interface EncodedEndpoint {
  adapterType: string;
  instanceKey: string;
  typeId: string;
  recordId: string;
}

/** The symmetric correspondence store a `write … bind other { … }` keeps:
 *  "this record IS the counterpart of that one", in the segment's tenant. */
export interface RecordBindings {
  record(input: { from: BindingEndpoint; to: BindingEndpoint }): Promise<void>;
  /** The record bound to `endpoint`, restricted to `counterpart`'s instance and
   *  type when given; the most recently bound when there are several. */
  findBoundCounterpart(input: {
    endpoint: BindingEndpoint;
    counterpart?: Omit<BindingEndpoint, 'recordId'>;
  }): Promise<EncodedEndpoint | null>;
  delete(input: {
    from: BindingEndpoint | EncodedEndpoint;
    to: BindingEndpoint | EncodedEndpoint;
  }): Promise<void>;
}

/** The key an await parked under, as `park.wake` takes it (the tenant is the
 *  segment's). */
export interface AwaitWakeRequest {
  /** The awaitable adapter's type, or the reserved callback identity. */
  adapterType: string;
  correlationKey: string;
}

/** Cross-run write locks, by segment. A token stands for one acquire. */
export interface HostLocks {
  acquire(input: Scoped<{ names: readonly string[] }>): Promise<{ token: string }>;
  release(input: Scoped<{ token: string }>): Promise<void>;
}

/** The host's clock: the instant now, which the engine reads for a sleep's
 *  wake, a callback's expiry, a segment with no firing instant, and a
 *  measured duration. The engine reads no clock of its own. */
export interface HostClock {
  now(input: InSegment): Promise<{ nowIso: string }>;
}

/** The host's id minting: `count` fresh ids, each unique within the run's
 *  team (an extraction's resource ids). The engine mints no id of its own. */
export interface HostIds {
  mint(input: Scoped<{ count: number }>): Promise<string[]>;
}

/** Who an event acts as: an opaque reference the host mints, never a row the
 *  engine reads, and how a person would see it named. */
export interface PrincipalReference {
  id: string;
  display?: string;
}

/** What `lookup.resolveActingUser` answers (`@user_id`, `@user_name`,
 *  `@user_email`). `email` is supplied only by a host whose principals have
 *  one; without it `@user_email` reads as absent. */
export interface ActingPrincipal {
  principal: PrincipalReference;
  email?: string;
}

// ── The manifest ────────────────────────────────────────────────────────────

/**
 * The host's families and their methods: the contract docs/contracts/host-families.md
 * documents family by family, and the set the seam guard proves crosses as
 * JSON. `optional` marks a family an embedder may leave out (the engine takes
 * its no-substrate path) or, within `park.sink`, a method it may.
 */
export const HOST_FAMILIES = {
  segment: { methods: ['open', 'close'] },
  adapters: { methods: ['resolve', 'call'] },
  'llm.client': { methods: ['call'] },
  'llm.extractCall': { methods: ['call'] },
  'llm.transforms': { methods: ['invoke'] },
  llm: { methods: ['arbitrateEntities'] },
  'park.sink': {
    optional: true,
    methods: [
      'recordJoin',
      'commitTimerPark',
      'commitAwaitPark',
      'decrementJoin',
      'persistBranchExport',
      'collectBranchExports',
      'cancelSubtrees',
      'commitSuspension',
      'commitLimitPause',
    ],
  },
  park: { methods: ['wake'] },
  'park.callbacks': { optional: true, methods: ['mint', 'calls'] },
  'park.bindings': { methods: ['record', 'findBoundCounterpart', 'delete'] },
  'control.cancel': { methods: ['cancelled', 'cancelledNow'] },
  files: { methods: ['resolveFileText', 'render'] },
  lookup: { methods: ['resolveActingUser'] },
  locks: { methods: ['acquire', 'release'] },
  trace: { optional: true, methods: ['append'] },
  clock: { methods: ['now'] },
  ids: { methods: ['mint'] },
} as const satisfies Record<string, { optional?: true; methods: readonly string[] }>;

type Manifest = typeof HOST_FAMILIES;

/** Every method of every family, by its path (`park.sink.recordJoin`). */
export type HostFamilyMethodPath = {
  [F in keyof Manifest & string]: `${F}.${Manifest[F]['methods'][number]}`;
}[keyof Manifest & string];

/** The methods whose answer is nothing: over a wire their reply carries no
 *  value, and every other method's reply must. */
export const VOID_HOST_METHODS = [
  'park.sink.recordJoin',
  'park.sink.commitTimerPark',
  'park.sink.commitAwaitPark',
  'park.sink.persistBranchExport',
  'park.sink.cancelSubtrees',
  'park.sink.commitSuspension',
  'park.sink.commitLimitPause',
  'park.wake',
  'park.bindings.record',
  'park.bindings.delete',
  'locks.release',
  'trace.append',
] as const;

/** Each method's path (`park.sink.recordJoin`), from the manifest. */
export function hostMethodPaths(): string[] {
  return Object.entries(HOST_FAMILIES).flatMap(([family, { methods }]) => methods.map((method) => `${family}.${method}`));
}

/** Every method a host must serve: each method of every family the manifest
 *  does not mark optional. */
export function requiredHostMethodPaths(): string[] {
  return Object.entries(HOST_FAMILIES).flatMap(([family, spec]) =>
    'optional' in spec ? [] : spec.methods.map((method) => `${family}.${method}`),
  );
}

/** The required methods `host` does not serve, by path: an engine refuses a
 *  host missing any (a host written against an earlier manifest) before it
 *  opens a segment. */
export function missingHostMethods(host: unknown): string[] {
  return requiredHostMethodPaths().filter((path) => {
    let at: unknown = host;
    for (const key of path.split('.')) {
      if (typeof at !== 'object' || at === null) return true;
      at = Reflect.get(at, key);
    }
    return typeof at !== 'function';
  });
}
