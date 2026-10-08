// A parked flow's state: everything a resume needs to rebuild the scopes a
// leaf was parked in, as plain JSON. The engine writes it and reads it back;
// a host stores it and hands it back byte for byte, never reading inside.
// Tied to the exact source and language version the run is pinned to: the
// addresses and the code it carries (closures, walks, node declarations) are
// re-read against that program.
//
// Park reasons are the host's record of why a leaf waits. The core owns three
// — a timer, an await, a limit suspension — and any other reason a unit
// writes is the unit's own, carried as an opaque string.

import type {
  ClosureExpression,
  CollectionOpExpression,
  NodeLiteral,
  PathHead,
  ShapeDeclaration,
} from 'movement-lang';

import type { CallbackParamSpec } from './callback';
import type { FileRef } from './file_ref';
import type { SourcePosition } from './position';
import type { Provenance, ProvenanceOrigin } from './provenance';
import type { Resource } from './records';
import type { LocalLandingShape, WriteRecord } from './write_record';

// ── Park reasons ────────────────────────────────────────────────────────────

/** The park reasons the core writes: a timer `sleep` / `await until`, an
 *  await on an awaitable edge, and a suspension at a limit. */
export const CORE_PARK_REASONS = ['timer', 'await', 'limit'] as const;

export type CoreParkReason = (typeof CORE_PARK_REASONS)[number];

/** Why a leaf is parked: one of the core's reasons, or a reason a unit owns
 *  (opaque to the core). The run host's database still admits only the
 *  core's three and the legacy `ask` (its `parked_run` CHECK constraint) until
 *  the deferred migration lands, so a unit reason is refused there today. */
export type ParkReason = CoreParkReason | (string & {});

export function isCorePark(reason: string): reason is CoreParkReason {
  return (CORE_PARK_REASONS as readonly string[]).includes(reason);
}

// ── The state ───────────────────────────────────────────────────────────────

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

/** A serialised `ExtractEmission` — its `children` Map flattened to a record of
 *  arrays (JSON has no Map). The emission is pure data (the extraction ran). */
export interface ExtractEmissionDescriptor {
  nodeName: string;
  fields: Record<string, unknown>;
  /** `fields`' keys in declaration order — the parked state is jsonb, which
   *  reorders an object's keys. Absent on a park written before it was kept. */
  fieldOrder?: string[];
  provenance: Record<string, ProvenanceOrigin>;
  origin?: ProvenanceOrigin;
  /** Layer-5 source resources (plain data; a FILE resource's `fileRef` is a
   *  descriptor). */
  resources: ResourceDescriptor[];
  children: Record<string, ExtractEmissionDescriptor[]>;
}

export type BindingDescriptor =
  | { kind: 'event' }
  | { kind: 'instance'; instance: InstanceIdentityDescriptor }
  | { kind: 'handle'; handle: WriteRecord; targetType: string; graph: HandleGraphDescriptor }
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
      params: CallbackParamSpec[];
    }
  // Bucket 3 — code refs carry ONLY the re-resolution tag (the name). The live
  // declaration / fileEnv comes from the re-parsed program.
  | { kind: 'shape'; name: string }
  /** A node declaration made in a BODY: the re-parsed file scope does not hold
   *  it, so it travels as the declaration — code that is already data, as a
   *  closure's body is. */
  | { kind: 'localShape'; declaration: ShapeDeclaration }
  | { kind: 'movement'; name: string }
  | { kind: 'shapePosition'; shape: string; node: string; fields: Record<string, unknown>; fieldProvenance: Record<string, Provenance> }
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
      fieldProvenance: Record<string, Provenance>;
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

export interface LegacyLandingShape {
  [edge: string]: LegacyLandingShape;
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

/** A serialised `Resource` — plain data as it stands. A park written before
 *  file refs were descriptors stored its `fileRef` without the brand. */
export type ResourceDescriptor = Omit<Resource, 'fileRef'> & {
  fileRef?: Omit<FileRef, '__brand'> & { __brand?: 'FileRef' };
};

/**
 * A serialised scope-node: the bindings declared in ONE lexical scope, keyed by
 * name. A parked leaf's state is one chain of these from the movement body's
 * root scope to the leaf's own — the bindings feeding the parked statement.
 */
export interface SerializedScope {
  bindings: Record<string, BindingDescriptor>;
}

/**
 * A parked leaf's whole state, version 1: what a host's park sink stores and
 * hands back. The `scopeChain` is root-first: index 0 is the movement body's
 * own scope, the last entry is the parked statement's immediate scope. Resume
 * rebuilds the scope chain by rehydrating each scope in order.
 */
export interface ParkedScopeState {
  /** Schema version of this state blob. */
  version: 1;
  /** The parked statement's canonical lexical address — the resume entry
   *  point. */
  address: string;
  /** The parked statement's binding name (`r = await …`), so a step-past
   *  resume binds the answer back. Null for a value-less one. */
  bindingName: string | null;
  /**
   * A PRESENCE-marker bind: `expired = await sleep(2d)`
   * binds nothing of value, but the completed branch must escape `expired` onto
   * the race receipt as an edge (`r-[:expired]->`, S4). When set, the timer
   * resume declares `bindingName` as a presence value (`true`) at wake, so the
   * binding survives the park with no injected answer. Absent for an ordinary
   * value-less sleep (which binds nothing at all). */
  presenceBind?: boolean;
  /**
   * An `await until(…)` recurring-clock park. A
   * timer park (reason `timer`) whose resume RE-ENTERS the `until`
   * statement (`reenter=true`) to RE-EVALUATE the condition rather than stepping
   * past it: unmet ⇒ it re-parks at the same address with a fresh wake time
   * (re-armed); met ⇒ it binds and continues. The timer-resume worker reads this
   * flag to choose re-enter over step-past, and to leave a re-armed leaf alone. */
  until?: boolean;
  /** Root-first chain of lexical scopes feeding the parked statement. When the
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
