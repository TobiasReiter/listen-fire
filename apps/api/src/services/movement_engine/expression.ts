// Movement engine — expression evaluation against the interpreter's
// Environment (E1).
//
// A NEW evaluator over the bridge-parsed formula AST
// (`parseMovementExpression` → the shared `Expression` union). It is NOT
// the TG engine's evaluator: alias roots resolve against movement
// bindings (the event parameter, write handles, plain values) instead of
// TG `ctx.aliases`, and write-handle reads resolve env-side — there are
// no `action_result` nodes and no TG EvalContext anywhere in the path.
//
// What IS reused from the TG substrate:
//   - the source-position read primitive: property reads on the event
//     payload go through `sourceAdapter.getFieldValue({ position,
//     fieldId })` against the same seeded trigger position the TG engine
//     builds (`run.ts` mirrors `seedRootSourcePosition`'s webhook
//     branch) — so an adapter's read semantics are identical under both
//     engines;
//   - operator semantics (`compareValues`, concat null-folding, logical
//     truthiness, arithmetic) are mirrored verbatim from
//     `engine/expression.ts` so a condition or field value computes the
//     same answer under both engines. Mirrored as local copies rather
//     than imports — the TG engine module is frozen and its helpers are
//     private.
//
// E2 adds the extraction-side reads: extract-position field reads,
// traversal over extract edges, block meta-node reads (accumulated
// bindings as edges, POSITION_SENTINEL as "the positions themselves"),
// resource field reads, and the aggregate family mirrored from the TG
// engine's `applyAggregation`. E5 adds `AI()` — the frozen TG engine's
// `llm` semantics (the author's prompt, or `String(promptExpression)`,
// as ONE user message; the reply string is the value), routed through
// the E2 `LlmClient` seam instead of the frozen path's hardwired
// chat call — plus bare-name value-binding reads (`AI(company_prompt)`
// — the bridge parses a bare name as a `property` node) and in-memory
// shape positions (the composition argument currency, see run.ts).
// Everything still outside the slice raises a loud MOVENG_UNSUPPORTED
// naming the construct.
//
// E4 — provenance is the value model: the core evaluator
// (`evalMovementExpr`) returns `(value, provenance)` pairs. Values stay
// plain (equality/comparison ignore provenance by construction);
// trails ride alongside, unioned taint-style at every operator and
// kept `direct` only while a value flows un-transformed from its
// origin (see ./provenance.ts). `evaluateMovementExpression` remains
// the value-only entry point for callers that don't consume trails
// (conditions).
//
// E6 adds the source-graph read surface:
//   - `sourcePosition` bindings — records yielded by an adapter-edge
//     block head (a collection fan-out from the meta root, an event
//     schema-edge walk) read through the SAME `getFieldValue` seam as
//     the event position;
//   - position-scoped sub-evaluation (`ctx.scope`) — WHERE filters on
//     adapter hops / extract edges / meta-node edges evaluate rootless
//     `property` reads against the hop's landed position, exactly as
//     the frozen engine evaluates `expressionFilter` at `r.position`;
//   - EXISTS() — the frozen engine's quantifier semantics mirrored:
//     walk the traversal from the subject position via the same read
//     seams (adapter `getRelated`, extract emission children, block
//     meta-node edges), true iff ≥1 yielded position satisfies the
//     WHERE (any position when absent).
//
// The settled-gap round after E8 mirrors the frozen engine's remaining
// expression families: `@<key>` meta values (time / acting-user / raw-
// actor keys, fed by `MovementMetaContext` — the same sources the frozen
// `resolveMetaKey` reads), array indexing (`[n]`, frozen semantics
// verbatim), and adapter field functions (bound per write field by the
// write path, exactly as the frozen field-mapping pipeline binds
// `fieldFunctions`). Deliberately retired (not pending): the inline KG
// query functions (KG_EXISTS / KG_VALUE) — the kg is an ordinary graph
// here, so query it by traversal (`kg-[c:company WHERE …]->`,
// `EXISTS(kg-[c:company WHERE …]->)`) like any other source. The
// TG-shaped `@parent.*` / `@resource.*` reads likewise have
// movement-native replacements (read the parent handle / traverse
// #resources).

import {
  applyStdlib,
  chunkText,
  CHUNKS_FUNCTION_ID,
  estimateEntities,
  FILE_FUNCTION_ID,
  INTERPRETED_FUNCTION_IDS,
  isWalkProjection,
  POSITION_SENTINEL,
  READ_FUNCTION_ID,
  readChunkSpec,
  refinementKey,
  since,
  stdlibFunctionById,
} from 'movement-lang';
import type {
  ClosureExpression,
  LanguageVersion,
  InstanceSchema,
  LinkedFile,
  MovementDeclaration,
  NodeLiteral,
  PathHead,
  ShapeDeclaration,
  Span,
} from 'movement-lang';
import type { EdgeStep, Expression, FilterOperator } from '#shared/expression/types';
import { isObjectSpread, objectMemberExpression } from '#shared/expression/types';
import { serialize as serializeExpression } from '#shared/expression/formula';
import { settledAll } from './fans';
import { aiExpressionSettings } from './ai_tiers';
import {
  applyHopOrderLimit,
  compareOrderValues,
  hopOrderKey,
  hopOrderProperty,
  hopPushdown,
  sortByOrderKey,
  type HopCardinality,
} from '#shared/expression/order_limit';
import {
  compareToNull,
  compareValues,
  evaluatePredicate,
  flattenAndConjuncts,
  isNullLiteral,
  isPurePredicate,
  leafReadKey,
  pureLeafReads,
  replacePureLeaves,
  type LeafRead,
} from '#shared/expression/filter';
import type { ActingPrincipal, TenantId } from 'engine-contracts';
import type {
  ActorIdentity,
  Adapter,
  FileRef,
  Resource,
} from '../translation_graph/adapter';
import { fileHandle, isFileRef } from '../translation_graph/adapter';
import type { TriggerEvent } from '../translation_graph/triggers/types';
import type { EngineClock, SegmentHost } from './run_context';
import { hostInstanceOf } from './host_adapter';
import type { LlmClient } from '../translation_graph/engine/batched_extraction/llm_call';
import {
  isStablePosition,
  positionData,
  positionRecordId,
  type SourcePosition,
} from '../translation_graph/types';
import { stampedPositionName } from './kg';
import type { ExtractEmission } from './extraction';
import type { CallbackParamSpec } from 'engine-contracts';
import {
  NO_PROVENANCE,
  fromOrigin,
  transformed,
  unionProvenance,
  type Provenance,
  type ProvenanceOrigin,
  type SummarisedOrigin,
} from './provenance';
import { MovementEngineError, type MovementEngineErrorCode } from './errors';
import { applyMovementFunction } from './builtins';
import { engineChoice, evalInRust } from './rust_engine';
import { neverAsAny } from '../../lib/utils/types';
import type { LocalLandingShape, WriteRecord } from 'engine-contracts';

export type { LocalLandingShape, WriteRecord };

// ── Errors ──────────────────────────────────────────────────────────────────
// The error type lives in the dependency-free `./errors` module (so the
// name translator can throw it without this evaluator's heavy graph);
// re-exported here so existing import sites are unchanged.

export { MovementEngineError, type MovementEngineErrorCode };

/** A clean "this construct is E2/E3 scope" error, naming the construct. */
export function unsupported(construct: string, detail?: string): MovementEngineError {
  return new MovementEngineError(
    'MOVENG_UNSUPPORTED',
    `${construct} is not supported by the movement engine yet${detail ? ` (${detail})` : ''}`,
  );
}

// ── The runtime value model ─────────────────────────────────────────────────

// `WriteRecord` and `LocalLandingShape` are the contract's (`engine-contracts`):
// a write handle parks with its record, and a landing with its shape.

/**
 * Whether a run-log entry is an EFFECT on a system — everything but a
 * `match`, which only found a record. Every count of "records written" (the
 * run's write total, the loop guard's budget, the runs list) asks this, so a
 * lookup never reads as a write.
 */
export function isWriteEffect(entry: { kind?: WriteRecord['kind'] | string }): boolean {
  return entry.kind !== 'match';
}

/**
 * Which graph a write handle's record lives in. The linked-write seam
 * (`write h-[:edge]-> { … }`, E3) reads the parent handle's graph to
 * infer the written type from that graph's schema and to route the
 * child write to the same adapter.
 */
export type HandleGraph = {
  kind: 'instance';
  instance: Extract<Binding, { kind: 'instance' }>;
};

/**
 * A traversal STORED rather than run — what `lazy` binds and what a lazy node
 * entry holds.
 *
 * It is a closure, and it is spelled as one: the traversal's own text (root +
 * hop chain, so WHERE / ORDER BY / LIMIT ride along untouched) plus the
 * lexical scope it was written in. Running it is running the ORDINARY head
 * walk against that scope — there is no second walker, which is why the
 * landings are real source positions with real provenance and why a hop's
 * filters behave exactly as they do anywhere else.
 *
 * `captured` is a SNAPSHOT taken where the walk was written, not the live
 * environment: bindings are single-assignment and nothing declared later is in
 * lexical scope for the hop, so the snapshot is exact — and it cannot contain
 * the lazy binding itself, which is what makes serialising it terminate.
 *
 */
export interface DeferredWalk {
  /** The traversal as written — the root's NAME (resolved against `captured`)
   *  and the raw hop chain, re-parsed per walk. */
  head: PathHead;
  captured: Map<string, Binding>;
  /**
   * The PER-ITEM tail (`-> node { … }`), as written. Present = every landing is
   * bound to the hop's alias and synthesised through this literal, so what the
   * walk yields is renamed views rather than the source's own positions. The
   * mapping belongs to the WALK because that is where the renaming happens:
   * deferring the walk defers the synthesis with it, and a park carries the
   * mapping's AST rather than anything it produced.
   */
  mapping?: NodeLiteral;
}

/**
 * One edge of a synthesised node. LANDED holds the positions themselves
 * (nested literals, or an eager traversal already walked); DEFERRED holds the
 * walk, and every read of the edge runs it again against the live source.
 */
export type NodeEdge =
  | {
      kind: 'landed';
      landings: Binding[];
      /** The nested edges every landing the RUN BUILDS on this edge starts
       *  with — present only where the edge was declared by a node
       *  declaration, which is the only thing that says what a landing
       *  carries. A landing that came from somewhere else (a linked handle, a
       *  traversed position) brings its own edges and this says nothing about
       *  it. */
      landingShape?: LocalLandingShape;
    }
  | { kind: 'deferred'; walk: DeferredWalk };


/**
 * One Environment binding. The instance binding carries construction
 * data only (slug + credential name); adapter resolution and caching are
 * the interpreter's concern (`run.ts`) so the value model stays inert.
 */
export type Binding =
  /** The movement parameter — the trigger's event position. */
  | { kind: 'event' }
  /**
   * `import { fetch_url } from plugins` — the name of a plugin, which is a
   * function whose body isn't visible. Nothing runs at the import; the name
   * exists so a CALL on it can be told apart from a call on a movement, which
   * is the same distinction the checker's scope makes.
   */
  | { kind: 'plugin'; plugin: string }
  /** `crm = attio(credentials: acme_main)`. Carries the catalog's
   *  instance schema so borrowed type annotations
   *  (`crm.companies.funding_stage`) resolve live at extraction time
   *  without re-resolving construction. */
  | {
      kind: 'instance';
      name: string;
      adapterSlug: string;
      credentialName?: string;
      /** The non-credential construction args (the Airtable base, the Slack
       *  workspace, …) — what distinguishes two instances of the same adapter
       *  on the same credential. Feeds the binding store's instance key
       *  (`encodeInstanceKey`, translation_graph/movement/record_bindings.ts).
       *  Empty for adapters with no construction config. */
      constructionConfig?: Record<string, string>;
      schema?: InstanceSchema;
    }
  /** `co = write crm-[:company]-> { … }`. */
  | { kind: 'handle'; handle: WriteRecord; targetType: string; graph: HandleGraph }
  /** `deals = extract from […] { … }` — the materialised result graph's
   *  root (a single synthetic emission carrying the top-level fields). */
  | { kind: 'extractRoot'; emission: ExtractEmission }
  /** A traversal alias over an extract edge — one emitted entity. */
  | { kind: 'extractPosition'; emission: ExtractEmission }
  /** A source-graph record yielded by an adapter-edge block head (a
   *  collection fan-out from the meta root, an event schema-edge walk)
   *  — reads go through the source adapter at this position.
   *  `edgeProperties` are the inline properties of the edge it was
   *  reached over, when the adapter returned any (the hop-WHERE read
   *  surface — `edge_property` nodes). `read` is the graph the record
   *  was yielded from, when it is NOT the movement's event source
   *  (instance-/kg-rooted heads) — later reads route through it. */
  | {
      kind: 'sourcePosition';
      position: SourcePosition;
      edgeProperties?: Record<string, unknown>;
      read?: SourceRead;
    }
  /** A traversal alias over `#resources` — one resource of the event. */
  | { kind: 'resource'; resource: Resource }
  /** A traversal-headed block's meta-node: named bindings accumulated
   *  across the block's iterations, one edge per binding name. `plural`
   *  marks a FAN-OUT's value (layer 13 C2): its scalar bindings read as an
   *  ARRAY — always, zero to N entries — where a race receipt (same kind,
   *  no flag) reads its single winner's value bare. */
  | { kind: 'blockMeta'; edges: Map<string, Binding[]>; plural?: true }
  /**
   * A bound traversal-headed block whose iterations RETURNED positions — the
   * landings, in iteration order. Plurality lives here rather than in the
   * position type, exactly as it does for a traversal: reading a field maps
   * over the landings, and a hop continues from each.
   */
  | { kind: 'positions'; landings: Binding[] }
  /**
   * `r = await race([f, g])` — the combinator RECEIPT: one slot per arm, in the
   * arms' own order. A slot holds what its arm RETURNED, whatever that was (a
   * value, a record it wrote), or the null value where the arm handed nothing
   * back — so the receipt is positional data and nothing more.
   *
   * It is not a `positions` binding: those are many of ONE thing, read across
   * (a field maps over every landing). A tuple's slots are separate answers, so
   * the only exact read is by INDEX — `AT(r, 0)` — which is what the checker's
   * tuple type says too.
   */
  | { kind: 'tuple'; slots: Binding[] }
  /**
   * `f = (n: <number>) => { … }` — a CLOSURE: its body as written, and the
   * scope it captured. Both halves are what make it survive a park: the AST
   * rides across as itself (like a `lazy` walk's head), the capture as ordinary
   * serialised bindings.
   */
  | {
      kind: 'closure';
      closure: ClosureExpression;
      captured: Map<string, Binding>;
      /** The name it was bound to (`f = (n) => …`, language version 3), by
       *  which its own body may call it: the capture is a snapshot taken
       *  before the name was bound, so the name is handed to each call
       *  instead (`invokeClosure`). */
      self?: string;
    }
  /** `prompt = "…"` — a plain runtime value, carrying the trail of the
   *  expression that produced it so later reads keep propagating. `many`
   *  marks a walk read for a field (`pdfs = m-[a:Attachments]->.\`File\``):
   *  the value is the walk's collapse (nothing, the one value, or the values),
   *  and a spread reads it as the values (`membersOf`). */
  | { kind: 'value'; value: unknown; provenance?: Provenance; many?: true }
  /** A file-level `shape` declaration — a configuration-free graph;
   *  `write <Shape>.<node> { … }` materialises in-memory positions.
   *  Where it was DECLARED is where its descriptions read their bindings,
   *  wherever an extraction reuses it: `fileEnv` for a file's own
   *  declaration, `library` for an imported one (its environment is built
   *  only if a description actually interpolates). Neither = the running
   *  file's. */
  | {
      kind: 'shape';
      declaration: ShapeDeclaration;
      fileEnv?: Environment;
      library?: LinkedFile;
      /** Declared in a body (or in an `extract(…)` argument) rather than at
       *  file level — not in the re-parsed file scope, so a park carries the
       *  declaration itself rather than its name. */
      local?: true;
    }
  /** A movement declaration — callable (composition, §G). An IMPORTED
   *  movement carries its library's file environment (`fileEnv`): the
   *  callee executes against ITS OWN file scope, not the importer's
   *  (lexical scoping across files). Absent = declared in the running
   *  file; the interpreter falls back to the running file's env. */
  | { kind: 'movement'; declaration: MovementDeclaration; fileEnv?: Environment }
  /** An in-memory shape position (`write Files-[:file]-> { … }`): the
   *  evaluated fields plus their trails. No adapter, no externalId —
   *  the composition argument-adaptation currency. */
  | {
      kind: 'shapePosition';
      shape: string;
      node: string;
      fields: Record<string, unknown>;
      fieldProvenance: Record<string, Provenance>;
    }
  /**
   * `d = node { title: …, company: node { … } }` — a SYNTHESISED node: the
   * in-memory derived position under `node { … }` (the checker's `local` type,
   * at run time). It belongs to no graph, so there is no adapter behind it and
   * nothing to re-resolve: it carries exactly what the literal wrote — the
   * evaluated entry values on the dot plane, and the landings its nested
   * literals synthesised on the arrow plane.
   *
   * Wave 1 is EAGER: every entry was evaluated where the literal was written,
   * so `fields` holds values, not closures. A field carrying a FileRef carries
   * it untouched — nothing here inspects what a value IS.
   *
   * `fieldProvenance` is why this is a binding and not a position read through
   * a derived adapter: the trail of the expression that produced each entry
   * flows through the synthesis untouched, exactly as it does through a shape
   * position. Reading these values back through an adapter seam would replace
   * that trail with a `source_field` origin naming a system that does not
   * exist.
   *
   */
  | {
      kind: 'nodePosition';
      fields: Record<string, unknown>;
      /** The dot plane's names in DECLARATION order — the literal's entries as
       *  written, or the declared node's fields for a landing the run built on
       *  a declared edge. It names every field the record declares, present or
       *  not, and it is what a whole-record read (`recordFields`) walks: a
       *  field map's own key order is neither (a merge appends, and a park
       *  round-trips through jsonb, which reorders keys). */
      fieldOrder: string[];
      fieldProvenance: Record<string, Provenance>;
      /** The arrow plane: one entry per edge the literal declared, LANDED
       *  (synthesised literals, or a walk already run) or DEFERRED (a `lazy`
       *  hop, walked afresh on every read). */
      edges: Record<string, NodeEdge>;
    }
  /**
   * `files = lazy m-[a:Attachments]->` — a traversal bound WITHOUT being
   * walked. `await`'s dual: the walk is the same walk, at the read instead of
   * here, and it happens again for every read (layer 8 ruling 3 — lazy is pure
   * deferral, not a cache).
   */
  | { kind: 'lazyWalk'; walk: DeferredWalk }
  /**
   * `cb = callback(…)` — the minted deferred invocation. A CHECKER-LOCAL node
   * (typing.ts `local`): it belongs to no graph, so there is no adapter and no
   * position, just what the construct declared — `id` / `url` on the dot plane,
   * and the `Called` edge on the arrow plane, whose landings are read LIVE from
   * the store (the calls arrive after this scope was captured, so they can never
   * be carried on the binding).
   */
  | {
      kind: 'callback';
      callbackId: string;
      url: string;
      /** The fire-time signature, declaration order — the `Called` landing's
       *  fields beyond `At`. */
      params: CallbackParamSpec[];
    }
  /** Imports. */
  | { kind: 'opaque'; what: string };

/**
 * The BINDING a runtime value IS, where it is one. A collection op hands each
 * answer back in the currency it arrived in — a binding where the function
 * returned a position (`MAP(pieces, (p) => { return extract … })`), a plain
 * value where it returned one — so a list on the value plane can hold
 * positions, and this is what tells the two apart. Structural, like every other
 * test here: a binding is an object whose `kind` is one of the kinds.
 */
export function bindingOf(value: unknown): Binding | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind in describeBinding ? (value as Binding) : undefined;
}

/**
 * Two records compared. `undefined` where neither side is a record, which is
 * every scalar comparison and the shared comparator's business.
 *
 * Identity, never a read: the same record reached two ways is one record, so a
 * stable external record is its address and anything else is the landing
 * itself (an extraction result and a synthesised node have no address — being
 * the same object IS being the same node). A record against a scalar is not
 * equal and not unequal-by-value; it is a different kind of thing, and `==`
 * says no rather than reading the record to find out.
 *
 * Only `==` / `!=`. Ordering records has no meaning and the checker refuses it.
 */
function compareRecords(left: unknown, op: FilterOperator, right: unknown): boolean | undefined {
  const a = bindingOf(left);
  const b = bindingOf(right);
  if (a === undefined && b === undefined) return undefined;
  if (op !== 'eq' && op !== 'neq') return undefined;
  const same = a !== undefined && b !== undefined && sameRecord(a, b);
  return op === 'eq' ? same : !same;
}

function sameRecord(a: Binding, b: Binding): boolean {
  if (a === b) return true;
  const address = recordAddress(a);
  return address !== undefined && address === recordAddress(b);
}

/** A record's ADDRESS, where it has one — the identity two reads of the same
 *  stored record share. Absent for a record the run itself built. */
function recordAddress(binding: Binding): string | undefined {
  if (binding.kind === 'sourcePosition') {
    const { position } = binding;
    return position.identity.kind === 'stable'
      ? `${position.adapterType}:${position.recordType}:${position.identity.recordId}`
      : undefined;
  }
  if (binding.kind === 'handle') {
    return `${binding.handle.adapterType}:${binding.handle.externalId}`;
  }
  return undefined;
}

export const describeBinding: Record<Binding['kind'], string> = {
  event: 'the movement parameter (the event position)',
  instance: 'a constructed adapter instance',
  handle: 'a write handle',
  extractRoot: 'an extract result',
  extractPosition: 'an extracted entity',
  sourcePosition: 'a traversed source record',
  resource: 'a resource',
  blockMeta: 'a block meta-node',
  positions: "a block's returned records",
  tuple: 'a combinator receipt',
  closure: 'a closure',
  value: 'a value binding',
  shape: 'a shape declaration',
  movement: 'a movement declaration',
  shapePosition: 'an in-memory shape position',
  nodePosition: 'a synthesised node',
  lazyWalk: 'a deferred traversal',
  callback: 'a callback',
  plugin: 'a plugin',
  opaque: 'an import',
};

/**
 * Which bindings are RECORDS rather than data — the ones a hop can walk from,
 * and so the ones a list literal may hold as its members (`both = [one, two]`).
 * A Record over every kind, like `describeBinding`, so a new binding has to be
 * classified rather than falling silently to one side.
 *
 * A graph (`instance`) is a whole system, not a record; a receipt (`tuple`) is
 * positional data; a declaration, a closure and an import are neither.
 */
const BINDING_IS_POSITION: Record<Binding['kind'], boolean> = {
  event: true,
  instance: false,
  handle: true,
  extractRoot: true,
  extractPosition: true,
  sourcePosition: true,
  resource: true,
  blockMeta: true,
  positions: true,
  tuple: false,
  closure: false,
  value: false,
  shape: false,
  movement: false,
  shapePosition: true,
  nodePosition: true,
  lazyWalk: true,
  callback: true,
  plugin: false,
  opaque: false,
};

/** The dot plane of a callback binding — the two reads the construct declares
 *  (`CALLBACK_READS` in the checker says the same thing, statically). */
export function readCallbackField(
  binding: Extract<Binding, { kind: 'callback' }>,
  field: string,
): unknown {
  if (field === 'id') return binding.callbackId;
  if (field === 'url') return binding.url;
  return null;
}

/** A binding a call can run: a movement, a plugin, an import that may be a
 *  movement, or a closure — movements and functions are one thing. */
export function isCallableBinding(binding: Binding): boolean {
  return (
    binding.kind === 'movement'
    || binding.kind === 'plugin'
    || binding.kind === 'opaque'
    || binding.kind === 'closure'
  );
}

/**
 * Lexically-scoped bindings → runtime values. `if` arms interpret in a
 * child environment so arm-local bindings don't leak; everything else is
 * straight program order in one scope.
 */
export class Environment {
  private readonly bindings = new Map<string, Binding>();

  constructor(private readonly parent?: Environment) {}

  declare(name: string, binding: Binding): void {
    this.bindings.set(name, binding);
  }

  resolve(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.parent?.resolve(name);
  }

  /**
   * The declared name of a FUNCTION in scope (a movement, a plugin, an
   * import, a name bound to a closure) written `name` in another letter case
   * — function names are case-insensitive from language version 3. The
   * checker refuses two functions whose names differ only by case, so at most
   * one answers.
   */
  resolveFunction(name: string): string | undefined {
    const folded = name.toLowerCase();
    for (const [bound, binding] of this.bindings) {
      const callable = isCallableBinding(binding);
      if (callable && bound.toLowerCase() === folded) return bound;
    }
    return this.parent?.resolveFunction(name);
  }

  /** THIS scope's binding of a name, with no parent walk — what a body asks
   *  when it wants the value IT bound, not one an enclosing scope did. */
  resolveOwn(name: string): Binding | undefined {
    return this.bindings.get(name);
  }

  child(): Environment {
    return new Environment(this);
  }

  /** The bindings declared in THIS scope only (no parent walk) — the
   *  interpreter harvests a block iteration's named bindings into the
   *  block's meta-node from here. */
  ownBindings(): IterableIterator<[string, Binding]> {
    return this.bindings.entries();
  }

  /** This env's lexical chain, ROOT-FIRST (the outermost scope first, this
   *  scope last). The durable-park scope serialiser walks it to capture the
   *  bindings feeding a parked `ask` (async user interaction §4.6). */
  chainFromRoot(): Environment[] {
    const chain: Environment[] = [];
    for (let env: Environment | undefined = this; env; env = env.parent) {
      chain.unshift(env);
    }
    return chain;
  }
}

// ── Evaluation context ──────────────────────────────────────────────────────

/**
 * One graph's read seam — the adapter a yielded position reads through,
 * plus the surface-name → fieldId translation its hops consume. The
 * movement's event source is one of these (`MovementExprContext.source`
 * extends it with the seeded position); instance-/kg-rooted traversals
 * carry their own (`graphRead`), threaded onto every position they yield
 * so later reads route to the right system.
 */
export interface SourceRead {
  adapter: Adapter;
  /** The constructed instance (or `kg`) the positions belong to — the
   *  program-level identity source-field origins carry. */
  instanceName: string;
  /**
   * Surface edge name → the fieldId the adapter's `getRelated`
   * consumes, position-sensitive: hops off the meta root are
   * collections (typeId currency), hops off a record are reference
   * fields. Wired by the interpreter from the run's refs; absent =
   * pass-through (fake adapters are surface-name-native).
   */
  edgeFieldId?: (edgeName: string, position: SourcePosition) => string;
  /** The instance's schema, as the catalog assembled it — including the
   *  narrowings the host resolved for this program (`selectedMembers`). Absent
   *  for seams with no schema behind them (an ask's landing, test fakes):
   *  nothing narrows, and every landed record faces the whole WHERE. */
  schema?: InstanceSchema;
}

export interface MovementExprContext {
  env: Environment;
  /** The host's clock, which `WITHIN` measures from. Absent outside a run:
   *  the wall clock. */
  clock?: EngineClock;
  /** The movement's pin, for the evaluation rules a version changed
   *  (`COALESCE` reaches only the arguments it needs from version 3). */
  languageVersion: LanguageVersion;
  /**
   * The event side, when interpreting inside a movement body. File-level
   * expressions evaluate without one (they cannot reach the event
   * parameter — it isn't in scope there).
   */
  source?: SourceRead & {
    /** The seeded trigger position (mirrors the TG engine's webhook
     *  seed; the adapter's meta position for snapshot/backfill runs). */
    position: SourcePosition;
  };
  /**
   * Resolve a graph-valued binding (a constructed instance, the ambient
   * `kg`, a credential-free adapter's ambient instance) to its read seam
   * + meta root, so graph-rooted traversals (`crm-[c:companies]->`,
   * `kg-[c:company WHERE …]->`) read through THAT graph's adapter.
   * Wired by the interpreter; absent in ad-hoc evaluations (graph-rooted
   * reads then stay unsupported, loud).
   */
  graphRead?: (
    name: string,
    binding: Binding,
  ) => Promise<{ read: SourceRead; start: SourcePosition } | undefined>;
  /**
   * Run a STORED traversal (`lazy …`) and return where it landed, optionally
   * continuing through `extraSteps` in the same walk. Wired by the interpreter
   * — the walk is the ordinary block-head walk against the captured scope, so
   * a deferred hop reads through the real adapter and its landings carry the
   * real source's provenance. Absent in ad-hoc evaluations (a lazy read then
   * fails loud rather than quietly yielding nothing).
   */
  walkDeferred?: (
    walk: DeferredWalk,
    extraSteps: Extract<Expression, { type: 'traverse' }>['steps'],
  ) => Promise<Binding[]>;
  /**
   * The ambient subject of a position-scoped sub-evaluation — WHERE
   * filters on adapter hops / extract edges / meta-node edges and
   * EXISTS() bodies. Rootless `property` reads resolve against it (the
   * frozen engine's `expressionFilter`-at-`r.position` semantics)
   * instead of the environment.
   */
  scope?: PositionScope;
  /**
   * The resource a `_resources` WHERE predicate is currently judging —
   * `resource` leaves read their fields off it (the TG engine's
   * `currentResource` semantics). Absent outside a resource sub-eval.
   */
  currentResource?: Resource;
  /** The enclosing expression slot's source span — literal origins
   *  locate themselves in the movement file with it (the slot is the
   *  finest span the bridge-parsed AST preserves). */
  literalSpan?: Span;
  /** `AI()` evaluation — the SAME pluggable client the extraction module
   *  takes (the E2 seam); tests inject a deterministic stub. Absent →
   *  AI() fails loud (the interpreter always wires one). */
  llm?: LlmClient;
  /**
   * Ambient meta-value resolution (`@user_email`, `@current_date`, …) —
   * the frozen engine's three key families, fed by the run's dispatch
   * context (see `MovementMetaContext`). Absent → time keys still
   * resolve; user/actor keys collapse to null (the frozen engine's
   * behavior for ad-hoc evaluations with no trigger in scope).
   */
  meta?: MovementMetaContext;
  /**
   * Adapter-provided field functions advertised on the write-field
   * destination this slot maps to (`SchemaFieldDescriptor.functions`,
   * bound to the TARGET adapter's `invokeFieldFunction`) — set only by
   * the write path, per field, exactly as the frozen engine's
   * field-mapping pipeline binds them. Keyed by the lowercased call
   * name. Absent everywhere else, so a non-built-in function is simply
   * unsupported outside the fields that expose it (P8).
   */
  fieldFunctions?: Record<string, (args: unknown[]) => Promise<unknown>>;
  /**
   * The FILE() render seam — the host's `files.render`: the host renders and
   * stores the artifact and answers its descriptor. Wired by the interpreter;
   * absent in ad-hoc evaluations, where FILE() fails loud.
   */
  renderFile?: SegmentHost['files']['render'];
  /**
   * The `READ(file)` seam — resolves a `FileRef` to its extracted text (the
   * same one the extraction's file sources go through, so a file read either
   * way is read once the same way). Wired by the interpreter; absent in ad-hoc
   * evaluations, where READ fails loud rather than quietly answering absent —
   * "nothing was configured to read it" and "the file had no text" are
   * different facts, and only one of them is the author's.
   */
  resolveFileText?: (ref: FileRef) => Promise<FileTextResolution>;
  /**
   * The run's observability trace — decision points append entries so a
   * run that writes nothing can still explain itself (AI() outcomes,
   * gate decisions, event-field reads that miss). Shared by reference
   * across the whole firing; absent in ad-hoc evaluations.
   */
  trace?: MovementTraceEntry[];
}

/**
 * Why a source FILE gave the extraction no text. `extraction_failed` carries
 * the extractor's own sentence alongside it — on a deployment with no OCR
 * provider that sentence names the configuration that is missing, which is the
 * whole difference between "the PDF said nothing" and "nothing read the PDF".
 */
export type FileUnreadableReason =
  | 'unsupported_type'
  | 'bytes_unavailable'
  | 'extraction_failed'
  | 'no_text';

/** One source file on an extraction trace entry: what it is, and either what
 *  it contributed or why it contributed nothing. `truncatedFrom` is the file's
 *  FULL length when only its first `chars` characters reached the prompt — a
 *  ceiling is never silent. */
export type ExtractionTraceFile = { name?: string; contentType?: string } & (
  | { chars: number; truncatedFrom?: number }
  | { unreadable: FileUnreadableReason; detail?: string }
);

/**
 * The extracted text of a source `FileRef`, plus the link back to the
 * stored copy. Mirrors the knowledge pipeline: bytes → OCR/text → RawText
 * → a stable id the field evidence can reference.
 */
export interface FileTextResult {
  text: string;
  /** The `RawText` row the text was deduped/stored into (provenance link). */
  rawTextId?: string;
}

/** A source file the seam could not turn into text, and why — the sentence a
 *  run needs so "extracted nothing" and "could not read the attachment" stop
 *  looking identical. `detail` carries the underlying extractor's own message
 *  (e.g. the OCR-not-configured sentence). */
export interface FileUnreadable {
  unreadable: FileUnreadableReason;
  detail?: string;
}

/** What the `resolveFileText` seam answers with: the file's text, or the
 *  reason there is none. Never a bare absence — a file that was there and
 *  could not be read has to be able to say so. Two callers share it: the
 *  extraction's `from [ … ]` file sources, and the `READ(file)` built-in. */
export type FileTextResolution = FileTextResult | FileUnreadable;

export function isFileUnreadable(
  resolution: FileTextResolution,
): resolution is FileUnreadable {
  return 'unreadable' in resolution;
}

/**
 * One recorded decision point of a firing. Persisted onto the trigger
 * run's step diagnostics and rendered in the run's Recent-activity
 * expansion — the answer to "this run made no changes… why?".
 */
export type MovementTraceEntry =
  | {
      kind: 'field_miss';
      /** The binding read from (`msg`) and the field that was absent. */
      binding: string;
      field: string;
      /** What the event actually carries (capped) — the self-repair hint. */
      available: string[];
    }
  | {
      kind: 'extraction';
      /** The node alias this call was asked about. */
      node?: string;
      /** Characters of source text the call saw. */
      inputChars: number;
      /** What those characters were MADE of — one row per part of the
       *  prompt (each `from` segment by its classification, the current
       *  entity, each enrichment by plugin). A call that read 1.2k where
       *  its sibling read 6.2k is the first thing to look at when one of
       *  them came back empty, and without this the difference takes
       *  archaeology to establish. Capped; the overflow is counted. */
      inputs?: Array<{ classification: string; chars: number }>;
      /** How many prompt parts `inputs` left out at its cap. */
      inputsTruncated?: number;
      /** Every source FILE the `from [ … ]` slots resolved to, readable or
       *  not — the file's name plus either the characters it contributed to
       *  the prompt or why it contributed none. Without this an attachment
       *  nothing could read is indistinguishable from no attachment at all:
       *  the prompt is short (or empty) and the run says only that it read
       *  nothing. Capped. */
      files?: ExtractionTraceFile[];
      /** How many source files `files` left out at its cap. */
      filesTruncated?: number;
      /** Which model answered, and how long it took (both attempts, when
       *  the call was retried). */
      model?: string;
      durationMs?: number;
      /** Present when the answer came back only because the call was asked
       *  less deeply than its tier says: the first attempt spent its whole
       *  output ceiling thinking and wrote nothing, so it was asked again one
       *  effort lower. The answer on this entry is the cheaper one. */
      effortSteppedDown?: { from: string; to: string };
      /** Set when the answer ran past the model's output ceiling and the
       *  client fed the partial text back asking it to continue. Nothing
       *  downstream can tell: the stitched reply parses, the schema is
       *  all-optional, and the records the model never got to at the end of
       *  its input are simply absent. `continuations` counts the turns it
       *  took. A continued reading is a CHUNKING problem — the input was more
       *  than one answer's worth. */
      continued?: true;
      continuations?: number;
      /** Set when the stage was skipped without an LLM call: the extract had
       *  no source text at all (`empty_source`), or this entity's stage
       *  pipeline contributed nothing to read (`no_enrichment`) so the call
       *  would have re-read exactly what the previous stage already saw. */
      skipped?: 'empty_source' | 'no_enrichment';
      /** What each of the stage's plugins did for this entity — `skipped` (a
       *  required argument resolved empty), `empty` (it ran and gave back
       *  neither text nor data), or `dropped` (it brought something back, and
       *  the call that was to fold it in was never answered). The first two
       *  tell "skipped as pointless" apart from "never ran"; the third says
       *  what a fallback cost beyond the fields themselves. */
      plugins?: Array<{ plugin: string; outcome: 'skipped' | 'empty' | 'dropped' }>;
      /** Set when the reply never answered the question — rejected by the
       *  schema on both the first attempt and the retry. `reply` carries what
       *  the model said instead. Fatal for the root call; a per-entity one
       *  carries `fallback` instead of failing the run. */
      failed?: 'invalid_reply';
      /** Present with `failed` when the run carried on regardless: this call
       *  was refining ONE entity that already stood, so the entity keeps the
       *  values its previous stage gave it and this stage's fields join it
       *  absent. The stage's enrichments go with the refinement (`plugins`,
       *  outcome `dropped`). The root call has nothing to fall back to and
       *  never carries this. */
      fallback?: 'kept_previous_stage';
      /** The validation issues that made the engine ask again — present
       *  only when the retry fired. Capped. */
      retried?: string[];
      /** A capped digest of what the model actually replied, kept ONLY
       *  when the call misbehaved (`why` says how): the top-level keys it
       *  answered under — the "answered under `nombre`" class of failure
       *  is unreadable without them — plus the head of the body. A healthy
       *  call never carries one: full replies are expensive to store and
       *  are raw third-party content. */
      reply?: {
        why: Array<'no_entities' | 'dropped_records' | 'retried' | 'failed'>;
        keys: string[];
        sample: string;
        /** Where in the reply the rejection landed, when it named a place.
         *  The `sample` is then the ENTITY sitting there rather than the head
         *  of the body — a complaint about the forty-fifth record is not
         *  legible from the first thousand characters. */
        path?: string;
      };
      /** Entities yielded, by node alias. */
      emissions: Record<string, number>;
      /** `call` on an entry the extraction CALL (`extract(content, Shape)`)
       *  wrote; absent on the keyword's. Its `inputs` are the content items,
       *  one per block, in the author's order. */
      form?: 'call';
      /**
       * How the extraction call used the prompt cache — what measuring the
       * cache-sensitive layout reads. `breakpoints` are the content items
       * whose block ended in a cache breakpoint; `sharedItems` is how many
       * leading items an earlier call in this run had already sent. The token
       * counts are the provider's, across both attempts when the call was
       * retried; absent where the client reported none.
       */
      cache?: {
        breakpoints: number[];
        sharedItems: number;
        inputTokens?: number;
        readTokens?: number;
        writeTokens?: number;
      };
      /** Per node alias, count of emitted entities whose declared fields
       *  all came back null/absent — present only when nonzero. */
      empty?: Record<string, number>;
      /** Per node alias, how many of those empty records the engine
       *  actually DROPPED. Smaller than `empty` when a fieldless parent
       *  survived on its children's evidence — which is the whole reason
       *  the two are counted separately. Present only when nonzero. */
      dropped?: Record<string, number>;
      /** Per `<node>.<field>` key, raw values a CLOSED enum coercion
       *  discarded — a non-member nulled (single select) or dropped from a
       *  multiselect array — so the loss shows up here instead of vanishing
       *  silently. Values are truncated. Present only when nonempty; an
       *  `open` enum (known-values, not closed) never contributes here since
       *  a novel value there is legal, not a loss. */
      coerced?: Record<string, string[]>;
      /** Per `<node>.<field>` key, citations the model wrote as something
       *  other than a string — kept as JSON, as written. The field's VALUE
       *  came through untouched; what was normalised is the quote behind it,
       *  to the one string inside or to nothing. A citation the model simply
       *  omitted never records here: nothing was written, so nothing was
       *  normalised away. Values are truncated; present only when nonempty. */
      evidenceCoerced?: Record<string, string[]>;
      /** How the reply was PACKAGED when the answer came back somewhere other
       *  than under the call's answer key — a bare record, a bare list of
       *  them, or the list keyed under a label the model chose. The content
       *  was right and faced the full entity schema exactly as it would have
       *  in the right place; what was rebuilt around it is the envelope.
       *  Present only when something was rebuilt. */
      envelopeRepaired?: string;
      /** Per node alias, the entities the extract actually produced — what
       *  turns "3 companies" into something a reader can check. Recorded
       *  once the whole extract has materialised, so it covers the root's
       *  own fields and every child alias, not just the call's own region. */
      entities?: Record<string, TracedEntity[]>;
      /** Per node alias, how many entities were left out of `entities`
       *  because the per-alias cap was reached — a cap is never silent. */
      truncatedCount?: Record<string, number>;
    }
  | {
      /**
       * One `through` plugin invocation. The plugins log their own progress,
       * but a log line is not attached to a run — and a retrieval plugin is
       * the longest thing a statement does (a single fetch has a seven-minute
       * backstop), so "what burned the seven minutes" has to be answerable
       * from the run record itself.
       */
      kind: 'plugin';
      plugin: string;
      /** The node whose entity the invocation ran for. ABSENT for a PLAIN call
       *  (`page = fetch_url(url: …)`) — there is no extraction and so no node,
       *  which is the one thing that tells the two forms apart on a trace. */
      node?: string;
      /** The URL the invocation was pointed at, when it took one as an
       *  argument — a fetch that ran to its timeout is identifiable by this
       *  plus `durationMs`. Truncated. */
      url?: string;
      durationMs: number;
      /** Characters of text the plugin fed back into the next call. */
      chars?: number;
      /** Fields the plugin added to the entity's context. */
      fields?: string[];
      /** Set when nothing was invoked: the required argument that resolved
       *  to nothing, so this entity had nothing for the plugin to work on. */
      skippedParam?: string;
      /** How the plugin says the invocation went, in its own vocabulary — a
       *  plugin that stood down, refused to search, or found no confident
       *  match spends real time and attaches nothing, and the fields alone
       *  cannot tell those apart. Free text: the plugin owns its outcomes and
       *  the engine only carries them, so a new plugin is readable on the
       *  trace without the engine learning its words. */
      outcome?: string;
      /**
       * What the CALL handed back — a plain call only. The plugin's own
       * `outcome` says what it made of the work; this says what the LANGUAGE
       * got, which is the fact a reader needs when the next statement did
       * nothing: an absent value and a record of empty fields are different
       * things and look identical otherwise. A stage hands nothing to a name,
       * so it never carries one.
       */
      returned?: 'value' | 'absent';
    }
  /**
   * One `READ(file)` — the file it was pointed at, and either how much text
   * came back or why none did. The LANGUAGE says only `text | absent`, because
   * no absence in it carries a reason; this is where the reason lives, so a
   * movement that read an attachment and got nothing can say whether the file
   * was of a type nothing reads, unreachable, or simply empty.
   *
   * The shape is the extraction's per-file entry verbatim, so a file read
   * through `READ` and a file read as an `extract from [ … ]` source report
   * identically. `truncatedFrom` never appears on one of these: READ does not
   * truncate — the per-file ceiling belongs to what reaches a PROMPT.
   */
  | ({ kind: 'read' } & ExtractionTraceFile)
  /**
   * One `CHUNKS(text, { … })` — how many pieces the text came out in, and how
   * long each one is. The pieces themselves are not here: a trace is read by a
   * person looking for why a run went the way it did, and the text is already
   * in the run. The counts are what answer that — a text that cut into one
   * piece, or into four hundred, explains what happened next.
   */
  | {
      kind: 'chunks';
      pieces: number;
      sizes: number[];
      unit: 'chars';
      /** Which way the author asked for the cut: by characters, or by how
       *  many records a piece is expected to yield. The sizes below read
       *  very differently under the two, so the mode has to be on the entry
       *  rather than inferred from how even they look. */
      mode: 'size' | 'entities';
      /** Entities mode only: what each piece is expected to yield. This is
       *  the number the cut was made on, so a reader comparing it against
       *  what the reading actually produced can see the estimate being wrong
       *  — which is the only way that ever becomes visible. */
      expectedEntities?: number[];
    }
  | { kind: 'ai'; prompt: string; hasValue: boolean }
  /**
   * A warning about the run that did not stop it — a movement pinned to a
   * deprecated language version (`code` is the diagnostic's; `message` names
   * the version and what to do), or a member `MAP` / `FILTER` left out under
   * `onError: "warn"` (`MOVENG_COLLECTION_MEMBER_FAILED`; `message` names the
   * member and why its function failed).
   */
  | { kind: 'warning'; code: string; message: string }
  | { kind: 'gate'; outcome: boolean }
  | { kind: 'block'; root: string; positions: number };

/** One extracted entity as the trace carries it: the declared field names
 *  against display-ready values. A value that came back absent stays
 *  `null` — the whole point is that an unfilled field is visible as one,
 *  not rendered as a missing key. Long values are truncated at capture. */
export interface TracedEntity {
  fields: Record<string, string | null>;
}

/**
 * What `@<key>` meta references resolve against — mirrors the frozen
 * engine's `ExpressionEvalContext` slice that feeds `resolveMetaKey`:
 * the dispatching event (user/actor keys parse actor candidates from it
 * through the SOURCE adapter), the team (acting-user lookup scope), and
 * the per-dispatch bag unknown keys fall through to. The caches are
 * holders shared across the whole run, mutated in place — a movement
 * with N `@user_*` reads pays one resolution chain.
 */
export interface MovementMetaContext {
  event?: TriggerEvent;
  teamId?: TenantId;
  /**
   * The run's PINNED INSTANT — when this firing started, fixed once and read by
   * everything in the run that wants "now": `@current_date`,
   * `@current_timestamp`, `DATE.TODAY(zone)`. Two reads in one run agree, and a
   * run that parks and resumes reads the instant it originally fired at, so a
   * replay computes the same window.
   *
   * NOT the event's `occurredAt` — a provider can report that hours in the past
   * (a backfilled webhook, a batched delivery), and "when the thing happened" is
   * a different question from "when are we".
   */
  now: Date;
  /** The per-dispatch bag (the frozen `ctx.meta`) — unknown keys read
   *  from it, null when absent. */
  bag: Record<string, unknown>;
  /** The host's acting-user resolution (`EngineHost.lookup`), in the run's
   *  segment. */
  resolveActingUser: SegmentHost['lookup']['resolveActingUser'];
  /** `undefined` = not yet resolved; `null` = resolved to "none". */
  actingUserCache: { value?: ActingPrincipal | null };
  actorCache: { value?: ActorIdentity | null };
}

/** One evaluation: the plain value plus its provenance trail (E4). */
export interface MovementEvalResult {
  value: unknown;
  provenance: Provenance;
}

/** What a position-scoped read stands on (see `MovementExprContext.scope`). */
export type PositionScope =
  /** An adapter record — `property` reads go through the source
   *  adapter; `edge_property` reads come from the inline properties of
   *  the edge the record was reached over (the bracket-WHERE grammar
   *  parses its identifiers as edge properties — frozen semantics).
   *  `read` is the graph the record was yielded FROM, when it is not the
   *  movement's event source (instance-/kg-rooted traversals). */
  | {
      kind: 'position';
      position: SourcePosition;
      edgeProperties?: Record<string, unknown>;
      read?: SourceRead;
    }
  /** An extracted entity — reads come from its emitted fields. */
  | { kind: 'emission'; emission: ExtractEmission }
  /** Any other reached binding (a meta-node edge's accumulant). */
  | { kind: 'binding'; binding: Binding };

// ── The evaluator ───────────────────────────────────────────────────────────

/**
 * Value-only entry point — for callers that don't consume trails
 * (condition evaluation). Everything else goes through
 * `evalMovementExpr` so provenance propagates.
 */
export async function evaluateMovementExpression(
  expr: Expression,
  ctx: MovementExprContext,
): Promise<unknown> {
  return (await evalMovementExpr(expr, ctx)).value;
}

export async function evalMovementExpr(
  expr: Expression,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  // The Rust engine's evaluator, for what it runs (rust_engine.ts says what);
  // everything else, and anything it hands back, is evaluated below.
  const inRust = engineChoice() === 'rust' ? evalInRust(expr, ctx) : undefined;
  if (inRust !== undefined) return inRust;
  switch (expr.type) {
    case 'static':
      // The literal's value is the program text itself — the trail
      // points at the movement file (the slot's span).
      return {
        value: expr.value,
        provenance: fromOrigin({
          kind: 'literal',
          ...(ctx.literalSpan !== undefined ? { span: ctx.literalSpan } : {}),
        }),
      };

    case 'meta':
      // `@<key>` — the frozen engine's meta families, mirrored (see
      // resolveMovementMetaKey). The origin is literal-ish: the value
      // comes from the dispatch context, so the key is the trail.
      return {
        value: await resolveMovementMetaKey(expr.key, ctx),
        provenance: fromOrigin({ kind: 'meta', key: expr.key }),
      };

    case 'at': {
      // `list[n]` — the frozen engine's indexing semantics verbatim:
      // non-integer index → null; a scalar acts as a one-element list
      // (index 0 or -1 yield it); negative indexes count from the end.
      // Selection out of a union-trailed list keeps the taint but can't
      // attribute one element's origin — `direct` drops.
      const inner = await evalMovementExpr(expr.expression, ctx);
      const indexResult = await evalMovementExpr(expr.index, ctx);
      const provenance = transformed(
        unionProvenance([inner.provenance, indexResult.provenance]),
      );
      const value = inner.value;
      // A DICT is looked up by its key. It is the same `AT`, because it is the
      // same question — "the member at this address" — and a dict's address is
      // a string where a list's is a number. A key that is not there reads
      // null, exactly as an out-of-range index does.
      if (isDictValue(value)) {
        const key = indexResult.value;
        if (typeof key !== 'string') return { value: null, provenance };
        return { value: Object.hasOwn(value, key) ? value[key] : null, provenance };
      }
      const index = Number(indexResult.value);
      if (!Number.isInteger(index)) return { value: null, provenance };
      if (!Array.isArray(value)) {
        if (value === null || value === undefined) return { value: null, provenance };
        return { value: index === 0 || index === -1 ? value : null, provenance };
      }
      const resolved = index < 0 ? value.length + index : index;
      if (resolved < 0 || resolved >= value.length) return { value: null, provenance };
      return { value: value[resolved], provenance };
    }

    case 'list': {
      // `...xs` splices xs's members in place (TypeScript's array spread); any
      // other member is one value. The checker refuses a spread of what is not
      // a collection where it can see the type; one it could not see that turns
      // out not to be a list fails the run here rather than splicing nothing.
      const values: unknown[] = [];
      const provenances: Provenance[] = [];
      for (const e of expr.elements) {
        if (e.type !== 'spread') {
          const member = await evalValueMember(e, ctx);
          values.push(member.value);
          provenances.push(member.provenance);
          continue;
        }
        const evaluated = await evalMovementExpr(e.expression, ctx);
        const spread = isManyValued(e.expression, ctx)
          ? { ...evaluated, value: membersOf(evaluated.value) }
          : evaluated;
        if (!Array.isArray(spread.value)) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `'...' splices a list's members into a list, and this value is ${spread.value === null || spread.value === undefined ? 'null' : `not a list (${typeof spread.value})`}`,
          );
        }
        values.push(...spread.value);
        provenances.push(spread.provenance);
      }
      return { value: values, provenance: unionProvenance(provenances) };
    }

    case 'object': {
      // `{ key: expr, ...m, … }` — a plain JSON object, keys verbatim. No
      // laziness: every value is evaluated, exactly as a list literal
      // evaluates every element. Members take effect in the order written,
      // so a later key wins — TypeScript's object literal.
      const value: Record<string, unknown> = {};
      const results: MovementEvalResult[] = [];
      for (const member of expr.entries) {
        const result = await evalValueMember(objectMemberExpression(member), ctx);
        results.push(result);
        if (isObjectSpread(member)) Object.assign(value, spreadKeysOf(result.value));
        else value[member.key] = result.value;
      }
      return { value, provenance: unionProvenance(results.map((r) => r.provenance)) };
    }

    case 'concat': {
      const parts: MovementEvalResult[] = [];
      for (const p of expr.parts) parts.push(await evalMovementExpr(p, ctx));
      return {
        value: parts.map((p) => (p.value == null ? '' : String(p.value))).join(''),
        provenance: unionProvenance(parts.map((p) => p.provenance)),
      };
    }

    case 'conditional': {
      // Branch selection is provenance-preserving — the chosen branch's
      // value (and its trail, `direct` included) flows through.
      const cond = await evaluateMovementExpression(expr.condition, ctx);
      return evalMovementExpr(cond ? expr.then : expr.else, ctx);
    }

    case 'compare': {
      // `x == null` asks whether `x` HAS a value, not what its value is — the
      // one loose comparison (see `compareToNull`). It is answered before the
      // operands are read as values because the subject may not BE a value: a
      // FIRST-bound record, a write handle. Those are present without being
      // readable as scalars, and reading them would throw where the author
      // asked the one question they can answer.
      if (isNullLiteral(expr.right)) return presenceCompare(expr.left, expr.op, ctx);
      if (isNullLiteral(expr.left)) return presenceCompare(expr.right, expr.op, ctx);
      const left = await evalMovementExpr(expr.left, ctx);
      const right = await evalMovementExpr(expr.right, ctx);
      // A RECORD is compared by IDENTITY, not by reading it — two names for the
      // same landing are equal, and a record is never equal to a scalar.
      // Answered before `compareValues`, which is the shared SCALAR comparator
      // and would compare two object references.
      const asRecords = compareRecords(left.value, expr.op, right.value);
      // `WITHIN` measures from the host's clock, asked only for it.
      const now = expr.op === 'within' && ctx.clock !== undefined ? (await ctx.clock.now()).getTime() : undefined;
      return {
        value: asRecords ?? compareValues(left.value, expr.op, right.value, now !== undefined ? { now } : {}),
        provenance: unionProvenance([left.provenance, right.provenance]),
      };
    }

    case 'logical': {
      const seen: Provenance[] = [];
      if (expr.op === 'and') {
        for (const operand of expr.operands) {
          const result = await evalMovementExpr(operand, ctx);
          seen.push(result.provenance);
          if (!result.value) return { value: false, provenance: unionProvenance(seen) };
        }
        return { value: true, provenance: unionProvenance(seen) };
      }
      for (const operand of expr.operands) {
        const result = await evalMovementExpr(operand, ctx);
        seen.push(result.provenance);
        if (result.value) return { value: true, provenance: unionProvenance(seen) };
      }
      return { value: false, provenance: unionProvenance(seen) };
    }

    case 'not': {
      const inner = await evalMovementExpr(expr.expression, ctx);
      return { value: !inner.value, provenance: unionProvenance([inner.provenance]) };
    }

    case 'negate': {
      const inner = await evalMovementExpr(expr.expression, ctx);
      return { value: -Number(inner.value), provenance: unionProvenance([inner.provenance]) };
    }

    case 'arithmetic': {
      const left = await evalMovementExpr(expr.left, ctx);
      const right = await evalMovementExpr(expr.right, ctx);
      const provenance = unionProvenance([left.provenance, right.provenance]);
      const l = Number(left.value);
      const r = Number(right.value);
      switch (expr.op) {
        case '+':
          return { value: l + r, provenance };
        case '-':
          return { value: l - r, provenance };
        case '*':
          return { value: l * r, provenance };
        case '/':
          return { value: r === 0 ? null : l / r, provenance };
        case '%':
          return { value: r === 0 ? null : l % r, provenance };
      }
      return { value: null, provenance };
    }

    case 'traverse':
      return evaluateTraverse(expr, ctx);

    case 'aggregate': {
      const inner = await evalMovementExpr(expr.expression, ctx);
      const values =
        inner.value == null ? [] : Array.isArray(inner.value) ? inner.value : [inner.value];
      // `SORT` hands the same members back rather than folding them, so it
      // answers before the folds do.
      if (expr.fn === 'sort') return evaluateSort(expr, values, inner.provenance, ctx);
      // Aggregation transforms — the union survives, `direct` does not
      // (mirrors the TG engine, where aggregations drop evidence).
      const provenance = unionProvenance([inner.provenance]);
      // Mirrors the TG engine's `applyAggregation` so both engines
      // compute the same answer (`engine/expression.ts`).
      switch (expr.fn) {
        case 'first':
          return { value: values.length > 0 ? values[0] : null, provenance };
        case 'last':
          return { value: values.length > 0 ? values[values.length - 1] : null, provenance };
        // ONLY is a stated CARDINALITY claim, not an ordering dodge: nothing
        // matched is ordinary absence (the checker types it `T | absent`),
        // and more than one means the claim was wrong — nothing at author
        // time could see that, so it fails the run naming what it counted.
        case 'only': {
          const present = values.filter((v) => v != null);
          if (present.length > 1) {
            throw new MovementEngineError(
              'MOVENG_RUNTIME',
              `ONLY(${serializeExpression(expr.expression, (id) => id)}) says there is exactly one, and there are ${present.length}. Narrow it until there is, or fold with something that takes many.`,
            );
          }
          return { value: present.length === 1 ? present[0] : null, provenance };
        }
        case 'count':
          // Polymorphic over ANY set (asks-as-adapter chunk D, F15): edge
          // traversals AND gathered scalar multisets. An ABSENT member is
          // "simply not in the set" (P20/F13), so null/undefined entries do
          // not count — `COUNT(m-[x:a WHERE EXISTS(x-[:Response]->)]->)` counts
          // present landings, and a gathered scalar multiset counts the values
          // actually there. (Edge-position sets never carry nulls, so this is a
          // no-op for the traversal case — `EXISTS ≡ COUNT > 0` holds either way.)
          return { value: values.filter((v) => v != null).length, provenance };
        case 'sum':
          return {
            value: values.reduce<number>((acc, v) => acc + (Number(v) || 0), 0),
            provenance,
          };
        case 'avg':
          return {
            value:
              values.length > 0
                ? values.reduce<number>((acc, v) => acc + (Number(v) || 0), 0) / values.length
                : null,
            provenance,
          };
        case 'min':
          return {
            value: values.length > 0 ? Math.min(...values.map((v) => Number(v))) : null,
            provenance,
          };
        case 'max':
          return {
            value: values.length > 0 ? Math.max(...values.map((v) => Number(v))) : null,
            provenance,
          };
        case 'join':
          return {
            value: values
              .filter((v) => v !== null && v !== undefined)
              .map(String)
              .join(expr.separator ?? ', '),
            provenance,
          };
        case 'collect':
          return { value: values, provenance };
        default:
          throw unsupported(`the '${expr.fn}' aggregation`);
      }
    }

    case 'resource': {
      // A resource-field read — meaningful only with a current resource in
      // scope (a `_resources` WHERE predicate). Fields live in the
      // resource's `data`, same local lookup as the alias-bound read.
      const resource = ctx.currentResource;
      if (!resource) return { value: null, provenance: { origins: [] } };
      return {
        value: (resource.data as Record<string, unknown> | undefined)?.[expr.field] ?? null,
        provenance: fromOrigin(resourceOrigin(resource, expr.field)),
      };
    }

    case 'llm':
      return evaluateAi(expr, ctx);

    case 'function': {
      // FILE(content, "pdf" | "text") — render an artifact through the
      // seam; the FileRef carries the content's trail (a render is a
      // transformation: union survives, `direct` drops).
      if (expr.fn === FILE_FUNCTION_ID) return evaluateFileFunction(expr, ctx);
      if (expr.fn === READ_FUNCTION_ID) return evaluateReadFunction(expr, ctx);
      if (expr.fn === CHUNKS_FUNCTION_ID) return evaluateChunksFunction(expr, ctx);

      // Namespaced stdlib calls (the bridge folds `CURRENCY.FN(…)` to a
      // dotted `fn` id) — deterministic implementations from the shared
      // registry, evaluated INTERPRETED_FUNCTIONS-style. Same provenance rule
      // as the other pure transforms. A clock-reading member (`DATE.TODAY`) is
      // handed the run's pinned instant by `applyStdlib`, never a live clock.
      const stdlib = stdlibFunctionById(expr.fn);
      if (stdlib) {
        const stdlibArgs: MovementEvalResult[] = [];
        for (const [index, a] of expr.args.entries()) {
          stdlibArgs.push(
            index === stdlib.recordArg?.index
              ? await evalRecordArgument(a, ctx)
              : index === stdlib.wholeValueArg?.index
                ? await evalWholeValueArgument(a, ctx)
                : await evalMovementExpr(a, ctx),
          );
        }
        return {
          value: applyStdlib(stdlib, stdlibArgs.map((a) => a.value), pinnedNow(ctx)),
          provenance: transformed(unionProvenance(stdlibArgs.map((a) => a.provenance))),
        };
      }

      // The frozen engine's name resolution, mirrored: built-ins always
      // win (a field can't shadow TRIM — P8); a non-built-in name
      // resolves against the write-field's adapter functions when the
      // write path bound them (`ctx.fieldFunctions`); anything else is
      // unsupported, named.
      if (!INTERPRETED_FUNCTIONS.has(expr.fn) && ctx.fieldFunctions?.[expr.fn] === undefined) {
        throw unsupported(
          `the function ${expr.fn.toUpperCase()}()`,
          'built-in functions run everywhere; an integration-provided function runs only as a write-field value on a field that advertises it',
        );
      }
      if (expr.fn === 'coalesce' && since(ctx.languageVersion, 3)) {
        // From version 3 COALESCE short-circuits, as TypeScript's `??` does: an
        // argument after the first present one is never evaluated, so its
        // effects (a model call, a read) never happen and its failures are
        // never raised. Before it every argument was evaluated first.
        const seen: MovementEvalResult[] = [];
        for (const a of expr.args) {
          const result = await evalMovementExpr(a, ctx);
          if (result.value !== null && result.value !== undefined) return result;
          seen.push(result);
        }
        return { value: null, provenance: unionProvenance(seen.map((a) => a.provenance)) };
      }
      const args: MovementEvalResult[] = [];
      for (const a of expr.args) args.push(await evalMovementExpr(a, ctx));
      if (!INTERPRETED_FUNCTIONS.has(expr.fn)) {
        // Adapter field function — the body lives on the target adapter
        // (`invokeFieldFunction`); a transform like any other function.
        const fieldFn = ctx.fieldFunctions![expr.fn];
        return {
          value: await fieldFn(args.map((a) => a.value)),
          provenance: transformed(unionProvenance(args.map((a) => a.provenance))),
        };
      }
      if (expr.fn === 'coalesce') {
        // COALESCE is branch selection, not transformation: the chosen
        // value flows through un-transformed, its trail (`direct`
        // included) intact — same provenance rule as `conditional`.
        const chosen = args.find((a) => a.value !== null && a.value !== undefined);
        if (chosen) return chosen;
        return { value: null, provenance: unionProvenance(args.map((a) => a.provenance)) };
      }
      return {
        value: applyMovementFunction(expr.fn, args.map((a) => a.value)),
        provenance: transformed(unionProvenance(args.map((a) => a.provenance))),
      };
    }

    case 'exists': {
      // A rootless EXISTS() — legal only where a position scope provides
      // the ambient subject (a WHERE filter's landed position). The
      // alias-rooted form arrives as a traverse terminal (the bridge
      // wraps it — see evaluateTraverse).
      if (ctx.scope?.kind === 'position') {
        return evaluateExists(expr, [{ kind: 'sourcePosition', position: ctx.scope.position }], ctx);
      }
      if (ctx.scope?.kind === 'emission') {
        return evaluateExists(expr, [{ kind: 'extractPosition', emission: ctx.scope.emission }], ctx);
      }
      throw unsupported(
        'rootless EXISTS()',
        'root the traversal at a named binding — EXISTS(x-[:edge]->)',
      );
    }

    // A bare name in a slot parses as `alias_ref` or — because the
    // bridge's identity property resolver is total — as a root-less
    // `property` node (`AI(company_prompt)`). Both are the same read:
    // the named binding's value. Inside a position-scoped sub-evaluation
    // (a WHERE filter), a `property` read is the field of the landed
    // position instead — the checker types rootless reads at the hop's
    // destination, and the frozen engine reads them off `r.position`.
    // EXCEPT when the bare name is an in-scope local `=` binding (a scalar
    // bound earlier in the body, e.g. `c = @current_date`): it resolves to
    // the binding's value, exactly as if the bound expression were inlined
    // into the WHERE — never read as (and drift on) a field the record lacks.
    case 'alias_ref':
      return readBareName(expr.name, ctx);
    case 'property': {
      const bound = scopedBinding(expr.propertyTypeId, ctx);
      if (bound) return bound;
      if (ctx.scope) return readScopedProperty(expr.propertyTypeId, ctx.scope, ctx);
      return readBareName(expr.propertyTypeId, ctx);
    }

    // The bracket-WHERE grammar parses its identifiers as edge
    // properties. The language's WHERE filters the hop's DESTINATIONS
    // (3_syntax_sketch.md: "WHERE elsewhere filters EXISTING edges'
    // destinations"), with the walked edge's inline properties layered
    // on top — so resolution is: the edge's inline property when the
    // walked edge carries one under that name, then an in-scope local `=`
    // binding of that name, else the landed record's own field (through the
    // position's read seam).
    case 'edge_property':
      if (ctx.scope?.kind === 'position') {
        const inline = ctx.scope.edgeProperties?.[expr.propertyTypeId];
        if (inline !== undefined) {
          return { value: inline, provenance: NO_PROVENANCE };
        }
        const bound = scopedBinding(expr.propertyTypeId, ctx);
        if (bound) return bound;
        return readSourcePositionField(
          ctx.scope.position,
          expr.propertyTypeId,
          ctx,
          ctx.scope.read,
        );
      }
      throw unsupported(
        'edge-property reads outside a traversal WHERE',
        'edge properties exist only on a walked hop',
      );

    default:
      throw unsupported(`the expression kind '${expr.type}'`);
  }
}

/**
 * A position-scoped read of `name` that resolves to an in-scope local `=`
 * binding's VALUE when one exists — the mechanism that lets a bare identifier
 * naming a body binding be used inside a hop WHERE (`c = @current_date; WHERE
 * \`Snoozed Until\` <= c`). Only a SCALAR-valued binding (`kind: 'value'`)
 * participates: it stands in for the bound expression, exactly as if it had
 * been inlined. A handle / position / block-meta binding is NOT a scalar a
 * WHERE comparison can use — it isn't returned here, so the field read (or a
 * later unsupported error) takes over, unchanged. Returns undefined when the
 * name is not a value binding, so the caller falls through to its field read.
 */
function scopedBinding(name: string, ctx: MovementExprContext): MovementEvalResult | undefined {
  const binding = ctx.env.resolve(name);
  if (binding?.kind !== 'value') return undefined;
  return { value: binding.value, provenance: binding.provenance ?? NO_PROVENANCE };
}

/**
 * `<subject> == null` / `!= null`, evaluated as a PRESENCE question.
 *
 * A bare name bound to something that is not a scalar — a traversed record, a
 * write handle, an extracted node — is PRESENT by the fact of being bound; the
 * absent case binds nothing readable at all (an empty `FIRST(…)` stores null).
 * So the binding kind answers directly, and only at statement scope: inside a
 * hop WHERE the same identifier means the landed record's field, and that read
 * already answers the question correctly.
 *
 * Everything else evaluates normally and is tested for a value.
 */
async function presenceCompare(
  subject: Expression,
  op: FilterOperator,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  const name =
    ctx.scope === undefined
      ? subject.type === 'property'
        ? subject.propertyTypeId
        : subject.type === 'alias_ref'
          ? subject.name
          : undefined
      : undefined;
  const binding = name !== undefined ? ctx.env.resolve(name) : undefined;
  if (binding !== undefined && binding.kind !== 'value') {
    return { value: compareToNull(op, true), provenance: NO_PROVENANCE };
  }
  const result = await evalMovementExpr(subject, ctx);
  return { value: compareToNull(op, result.value), provenance: result.provenance };
}

/** A bare-name read: value bindings yield their value (assignment is
 *  provenance-preserving — the stored trail flows through, `direct`
 *  included); everything else isn't a bare value. */
function readBareName(name: string, ctx: MovementExprContext): MovementEvalResult {
  const binding = ctx.env.resolve(name);
  if (!binding) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `'${name}' is not in scope — the checker should have caught this`,
    );
  }
  if (binding.kind === 'value') {
    return { value: binding.value, provenance: binding.provenance ?? NO_PROVENANCE };
  }
  if (binding.kind === 'positions') {
    // A block's returned records ARE the collection, so the bare name is what a
    // surrounding aggregate counts over — the same "the positions themselves"
    // currency a traversal hands an aggregate.
    return {
      value: binding.landings,
      provenance: { origins: binding.landings.flatMap(bindingEntityOrigins) },
    };
  }
  if (binding.kind === 'tuple') {
    // The receipt read as a plain list — its slots' values, in order. That is
    // what `AT(r, i)` indexes and what a null check on a slot compares. A slot
    // holding a RECORD has no value view (a record is not data), so it reads
    // null here; `AT(r, i)` bound to a name hands the record itself over
    // (`aliasedNodeBinding`), which is where a record is meant to be read.
    return {
      value: binding.slots.map(slotValue),
      provenance: { origins: binding.slots.flatMap(bindingEntityOrigins) },
    };
  }
  throw unsupported(
    `reading '${name}' (${describeBinding[binding.kind]}) as a bare value`,
    binding.kind === 'handle'
      ? 'handle-as-value record snapshots are a later increment — read a field instead'
      : undefined,
  );
}

/**
 * One member of a value a LITERAL builds — a list's element, a map's entry. A
 * bare name bound to a RECORD reads as that record here: `[one, two]` is the
 * two records themselves and `{ who: t }` is a map holding one, the same
 * currency `MAP(pieces, (p) => { return extract … })` already hands back, so a
 * block walks either of them exactly as it walks a collection op's answer.
 *
 * Only here. Everywhere else a bare name is the value read it has always been:
 * `"${one}"` still refuses to interpolate a record, and inside a hop WHERE
 * (`ctx.scope`) the name is still the landed record's own field, which is the
 * precedence every other read in this file keeps.
 */
async function evalValueMember(
  expr: Expression,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  const position = ctx.scope === undefined ? memberPosition(expr, ctx) : undefined;
  if (position !== undefined) {
    return { value: position, provenance: { origins: bindingEntityOrigins(position) } };
  }
  return evalMovementExpr(expr, ctx);
}

/** The record a member NAMES, where it names one: a bare identifier bound to a
 *  position. Anything else — a literal, a call, a field read — is data and
 *  evaluates as data. */
function memberPosition(
  expr: Expression,
  ctx: MovementExprContext,
): Binding | undefined {
  const name =
    expr.type === 'alias_ref'
      ? expr.name
      : expr.type === 'property'
        ? expr.propertyTypeId
        : undefined;
  if (name === undefined) return undefined;
  const binding = ctx.env.resolve(name);
  return binding !== undefined && BINDING_IS_POSITION[binding.kind] ? binding : undefined;
}

/** One combinator slot as DATA: a value binding's value, and null for anything
 *  that is a record rather than data. */
function slotValue(binding: Binding): unknown {
  return binding.kind === 'value' ? binding.value : null;
}

// ── Meta values (the frozen engine's `@<key>` families, mirrored) ───────────

/**
 * Mirrors the frozen engine's `resolveMetaKey` (engine/expression.ts —
 * frozen module, private helper) key for key:
 *
 *   1. Universal time keys (`current_date`, `current_timestamp`) —
 *      resolved here at evaluation time, no context needed;
 *   2. Acting-user keys (`user_email`, `user_name`, `user_id`) — actor
 *      candidates parsed by the SOURCE adapter (`getActorCandidates`),
 *      arbitrated by the host's `lookup.resolveActingUser` (creator-override →
 *      originator/non-service → relay/service → creator-fallback → null);
 *   3. Raw actor keys (`actor_email`, `actor_name`, `actor_id`) — the
 *      source adapter's pure-parse `extractActor`, auth-independent;
 *   4. Anything else — the per-dispatch bag; unknown keys → null (never
 *      undefined, keeping field-write coercion clean).
 *
 * The eight user-facing `@` keys handled by cases 1-3 are the canonical set —
 * its single source of truth is `MOVEMENT_META_KEYS` in movement-lang
 * (`checker/meta.ts`), which the checker (to flag an unknown `@key`) and the
 * editor (completions / hover) also read. Keep this switch in step with it; the
 * bag (case 4) is internal-only (`trigger`, `mutationContext`), never a
 * user-authored `@` key.
 */
async function resolveMovementMetaKey(
  key: string,
  ctx: MovementExprContext,
): Promise<unknown> {
  switch (key) {
    case 'current_date':
      return pinnedNow(ctx).toISOString().slice(0, 10);
    case 'current_timestamp':
      return pinnedNow(ctx).toISOString();
    case 'user_email':
    case 'user_name':
    case 'user_id': {
      const acting = await resolveMovementActingUser(ctx);
      if (!acting) return null;
      if (key === 'user_email') return acting.email ?? null;
      if (key === 'user_name') return acting.principal.display ?? null;
      return acting.principal.id;
    }
    case 'actor_email':
    case 'actor_name':
    case 'actor_id': {
      const actor = await resolveMovementActor(ctx);
      if (!actor) return null;
      if (key === 'actor_email') {
        return actor.email ?? (actor.scheme === 'email' ? actor.identifier : null);
      }
      if (key === 'actor_name') {
        return actor.name ?? actor.label ?? null;
      }
      return actor.identifier;
    }
    default:
      return ctx.meta?.bag[key] ?? null;
  }
}

/**
 * The run's pinned instant — the ONE value every clock read in a run answers
 * from (`@current_date`, `@current_timestamp`, `DATE.TODAY(zone)`).
 *
 * An evaluation with no meta block is not a run: an ad-hoc expression check, a
 * unit test evaluating a single expression, an editor preview. Those have no
 * firing to pin to and read the live clock — this is the ONLY place in the
 * engine that calls `new Date()` for "now", so "the run's instant" and "the
 * wall clock" never quietly become the same value anywhere else.
 */
export function pinnedNow(ctx: MovementExprContext): Date {
  return ctx.meta?.now ?? new Date();
}

/** The acting user for this run, cached run-wide on the meta context
 *  (`null` is a valid cached answer — "looked, found none"). Mirrors the
 *  frozen `resolveContextActingUser`. */
async function resolveMovementActingUser(
  ctx: MovementExprContext,
): Promise<ActingPrincipal | null> {
  const meta = ctx.meta;
  if (!meta) return null;
  if (meta.actingUserCache.value !== undefined) return meta.actingUserCache.value;
  const resolved = await resolveMovementActingUserUncached(meta, ctx);
  meta.actingUserCache.value = resolved;
  return resolved;
}

async function resolveMovementActingUserUncached(
  meta: MovementMetaContext,
  ctx: MovementExprContext,
): Promise<ActingPrincipal | null> {
  const event = meta.event;
  const sourceAdapter = ctx.source?.adapter;
  if (!event || meta.teamId === undefined) return null;
  if (!sourceAdapter?.getActorCandidates) return null;
  // The host asks the source instance for the event's actors itself, so the
  // source must be one the host resolved: an adapter the engine implements
  // itself has no instance there to ask.
  const source = hostInstanceOf(sourceAdapter);
  if (source === undefined) {
    throw new MovementEngineError(
      'MOVENG_UNSUPPORTED',
      `the acting user cannot be looked up through the '${sourceAdapter.adapterType}' source: it is not an adapter instance the host resolved`,
    );
  }
  try {
    return await meta.resolveActingUser({
      ...(event.triggerEntryId ? { triggerId: event.triggerEntryId } : {}),
      instance: source.instance,
      event,
    });
  } catch {
    // Flaky adapter lookups shouldn't crash the whole run — `@user_*`
    // fields collapse to null instead (the frozen engine's rule).
    return null;
  }
}

/** The raw event actor — a pure parse through the source adapter's
 *  `extractActor`, cached run-wide. Mirrors the frozen `resolveActor`. */
async function resolveMovementActor(
  ctx: MovementExprContext,
): Promise<ActorIdentity | null> {
  const meta = ctx.meta;
  if (!meta) return null;
  if (meta.actorCache.value !== undefined) return meta.actorCache.value;
  let resolved: ActorIdentity | null = null;
  const event = meta.event;
  const sourceAdapter = ctx.source?.adapter;
  if (event && sourceAdapter?.extractActor) {
    try {
      resolved = await sourceAdapter.extractActor({ event });
    } catch {
      resolved = null;
    }
  }
  meta.actorCache.value = resolved;
  return resolved;
}

// ── AI() (the frozen TG engine's `llm` node, on the LlmClient seam) ─────────

/**
 * The frozen evaluator sends the author's prompt as one bare user
 * message. This client seam (`LlmClient`, shared with extraction)
 * JSON-parses replies, so the engine's convention wraps the SAME bare
 * prompt with a system instruction requesting a structured envelope:
 * `{"value": <string|null>, "has_value": <boolean>}`. The envelope is
 * how AI() returns a REAL null — when the model decides nothing
 * applies, it sets has_value: false and the expression resolves to
 * null, so `if EXISTS(binding)` gates exactly as the author expects.
 * No sentinel strings ("none", "N/A", "") ever leak into field values.
 */
const AI_EXPRESSION_SYSTEM = [
  'You are evaluating an AI() expression inside a data-movement program.',
  "The user message is the program author's prompt. Answer it directly and",
  'concisely — the answer becomes a field value, so no preamble and no markdown.',
  'Respond with a JSON object of the shape',
  '{"value": <your answer as a string, or null>, "has_value": <boolean>}.',
  'If the prompt has no meaningful answer — nothing applies, nothing is',
  'needed, the requested thing is absent — set "has_value": false and',
  '"value": null. Never answer with placeholder text like "none" or "N/A".',
].join('\n');

async function evaluateAi(
  expr: Extract<Expression, { type: 'llm' }>,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  if (!ctx.llm) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      'AI() needs an LLM client and none is wired into this evaluation context',
    );
  }
  // Prompt selection mirrors the frozen engine verbatim: a prompt
  // expression evaluates and stringifies (null → ''); otherwise the
  // static prompt text.
  const promptResult =
    expr.promptExpression !== undefined
      ? await evalMovementExpr(expr.promptExpression, ctx)
      : undefined;
  const prompt =
    promptResult !== undefined ? String(promptResult.value ?? '') : expr.prompt;
  // The author's tier says how much thinking the answer is worth; what that
  // buys — model, reasoning depth, room for the answer — is the platform's,
  // and lives in one place so it can be retuned without touching the language.
  const reply = await ctx.llm.call({
    system: AI_EXPRESSION_SYSTEM,
    userMessage: prompt,
    label: 'movement-ai-expression',
    ...aiExpressionSettings(expr.tier),
  });
  // E4's `ai` origin, produced here: the prompt plus the trails of the
  // values that flowed into it. Generated text is no quotation —
  // `fieldEvidenceFromProvenance` never cites an ai origin — but the
  // origin is the trail's honest node.
  const value = aiAnswer(reply.parsedJson);
  ctx.trace?.push({
    kind: 'ai',
    prompt: prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt,
    hasValue: value !== null,
  });
  return {
    value,
    provenance: fromOrigin({
      kind: 'ai',
      prompt,
      inputs: promptResult?.provenance.origins ?? [],
    }),
  };
}

/**
 * The reply's value out of the structured envelope: null when the model
 * declared has_value: false (or sent a null value), the value string
 * otherwise. Non-conforming replies (older `{"answer": …}` shape, raw
 * text) fall back to the previous projection so a model that ignores
 * the envelope still yields its text rather than an error.
 */
function aiAnswer(parsedJson: unknown): string | null {
  if (parsedJson !== null && typeof parsedJson === 'object' && 'has_value' in parsedJson) {
    const envelope = parsedJson as { has_value: unknown; value: unknown };
    if (envelope.has_value === false) return null;
    if (envelope.value === null || envelope.value === undefined) return null;
    return blankIsAbsent(
      typeof envelope.value === 'object' ? JSON.stringify(envelope.value) : String(envelope.value),
    );
  }
  const answer =
    parsedJson !== null && typeof parsedJson === 'object' && 'answer' in parsedJson
      ? (parsedJson as { answer: unknown }).answer
      : parsedJson;
  if (answer === null || answer === undefined) return null;
  return blankIsAbsent(typeof answer === 'object' ? JSON.stringify(answer) : String(answer));
}

/** A blank answer is the model saying nothing applies — the same fact as
 *  `has_value: false`, and it has to reach the null plane as one, or the
 *  documented `x = AI(…)` then `if EXISTS(x)` gate silently passes. */
function blankIsAbsent(answer: string): string | null {
  return answer.trim() === '' ? null : answer;
}

// ── FILE() (the artifact built-in, on the host's files.render) ─────────────

/**
 * `FILE(content, "pdf" | "text")` — evaluates the content and hands it to
 * the host's render (`files.render`), which stores the artifact and answers
 * its descriptor: exactly the File-value currency file-typed adapter fields
 * consume. The bytes stay on the host. The bridge validated the call's static
 * shape; the type literal is re-read here, not re-judged.
 */
async function evaluateFileFunction(
  expr: Extract<Expression, { type: 'function' }>,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  const [contentArg, typeArg] = expr.args;
  if (!contentArg || !typeArg) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      'FILE() expects (content, "pdf" | "text") — the checker should have caught this',
    );
  }
  const content = await evalMovementExpr(contentArg, ctx);
  const typeResult = await evalMovementExpr(typeArg, ctx);
  const type = typeResult.value;
  if (type !== 'pdf' && type !== 'text') {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `FILE()'s artifact type must be "pdf" or "text", got ${JSON.stringify(type)}`,
    );
  }
  if (!ctx.renderFile) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      'FILE() has nothing in scope that can render a file — this expression is being evaluated outside a run',
    );
  }
  const ref = await ctx.renderFile({
    content: content.value == null ? '' : String(content.value),
    type,
  });
  // The FileRef carries the content's trail: rendering transforms, so
  // the union survives and `direct` drops (no verbatim-quote claim).
  return {
    value: ref,
    provenance: transformed(unionProvenance([content.provenance, typeResult.provenance])),
  };
}

// ── READ() (the file→text built-in, on the file_text seam) ──────────────────

/**
 * `READ(<file>)` — a file's text, or absent. The seam is the extraction's
 * (the host's `files.resolveFileText`; in production
 * `translation_graph/movement/file_text.ts`): resolve the FileRef's own bytes,
 * run the text extractor (a PDF's text layer, OCR, a deck, a sheet, a
 * transcript), and dedup-store the result so the text has a stable id.
 *
 * Absence in this language carries no reason, so neither does this one: an
 * unreadable file yields `absent` and the reason goes on the run's trace. The
 * value that DOES come back carries a `file` origin — the same origin the
 * extraction stamps for a file source — so `extract from [READ(f)]` still
 * traces its evidence to the attachment, `rawTextId` and all.
 */
async function evaluateReadFunction(
  expr: Extract<Expression, { type: 'function' }>,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  const [fileArg] = expr.args;
  if (!fileArg) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      'READ(file) expects one argument — the checker should have caught this',
    );
  }
  const file = await evalMovementExpr(fileArg, ctx);
  // The argument may itself be absent (`file | absent` types fine). Reading
  // nothing is nothing — the seam is never asked.
  if (file.value == null) return { value: null, provenance: transformed(file.provenance) };
  if (!isFileRef(file.value)) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `READ() reads a file, and this is ${typeof file.value} — the checker should have caught this`,
    );
  }
  if (!ctx.resolveFileText) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      "READ() has nothing in scope that can read a file's bytes — this expression is being evaluated outside a run",
    );
  }
  const ref: FileRef = file.value;
  const handle = fileHandle(ref);
  const named = {
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    ...(ref.contentType !== undefined ? { contentType: ref.contentType } : {}),
  };
  const result = await ctx.resolveFileText(ref);
  if (isFileUnreadable(result)) {
    ctx.trace?.push({
      kind: 'read',
      ...named,
      unreadable: result.unreadable,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    });
    return { value: null, provenance: transformed(file.provenance) };
  }
  ctx.trace?.push({ kind: 'read', ...named, chars: result.text.length });
  const origin: ProvenanceOrigin = {
    kind: 'file',
    ...(result.rawTextId !== undefined ? { rawTextId: result.rawTextId } : {}),
    ...(handle !== undefined ? { handle } : {}),
    ...named,
  };
  return {
    value: result.text,
    // The text IS the file, un-transformed — a quote out of it cites the
    // attachment faithfully — so the file origin is `direct`; the handle's own
    // trail rides along as taint.
    provenance: { ...unionProvenance([file.provenance, fromOrigin(origin)]), direct: origin },
  };
}

// ── CHUNKS() (the text→pieces built-in; the cut itself is in movement-lang) ──

/**
 * `CHUNKS(<text>, { size, overlap })` — the pieces of a text, in order.
 *
 * Pure: the cut is `movement-lang`'s (`expression/chunk.ts`), so the same text
 * and the same options give the same pieces here, in a replay, and in the unit
 * tests that pin the rule. Nothing about it is a seam.
 *
 * A text that isn't there has NO pieces rather than one empty one — `absent`
 * has no place in the result type, so "nothing to cut" has to be spelled as
 * the empty list. The trace says it happened either way: a run that cut a text
 * into nothing, and a run that never had one, look identical in a field write
 * and must not look identical here.
 */
async function evaluateChunksFunction(
  expr: Extract<Expression, { type: 'function' }>,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  const [textArg, optionsArg] = expr.args;
  if (!textArg || !optionsArg) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      'CHUNKS(text, { size | entities, overlap }) expects a text and an options map — the checker should have caught this',
    );
  }
  const text = await evalMovementExpr(textArg, ctx);
  const options = await evalMovementExpr(optionsArg, ctx);
  const provenance = transformed(unionProvenance([text.provenance, options.provenance]));

  const bag = options.value;
  if (bag === null || typeof bag !== 'object' || Array.isArray(bag)) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      'CHUNKS() takes its options as a map — the checker should have caught this',
    );
  }
  const asked = bag as Record<string, unknown>;
  const read = readChunkSpec({
    size: asked.size,
    entities: asked.entities,
    overlap: asked.overlap,
  });
  if ('error' in read) throw new MovementEngineError('MOVENG_RUNTIME', read.error);
  const mode = read.spec.mode;

  if (text.value == null) {
    ctx.trace?.push({ kind: 'chunks', pieces: 0, sizes: [], unit: 'chars', mode });
    return { value: [], provenance };
  }
  if (typeof text.value !== 'string') {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `CHUNKS() cuts a text, and this is ${typeof text.value} — the checker should have caught this`,
    );
  }
  const pieces = chunkText(text.value, read.spec);
  ctx.trace?.push({
    kind: 'chunks',
    pieces: pieces.length,
    sizes: pieces.map((piece) => piece.length),
    unit: 'chars',
    mode,
    // What the cut was MADE of, in the entities mode: the estimate is the
    // whole reason each piece ends where it does, so a piece that came out
    // far bigger than the rest is readable as the one long line it holds.
    ...(mode === 'entities'
      ? { expectedEntities: pieces.map((piece) => estimateEntities(piece)) }
      : {}),
  });
  return { value: pieces, provenance };
}

async function evaluateTraverse(
  expr: Extract<Expression, { type: 'traverse' }>,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  if (expr.aliasRoot === undefined) {
    throw unsupported(
      'relative traversal (no alias root)',
      'E1 expressions read from named bindings only',
    );
  }
  const name = expr.aliasRoot;
  const binding = ctx.env.resolve(name);
  if (!binding) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `'${name}' is not in scope — the checker should have caught this`,
    );
  }
  return traverseFrom(expr, name, binding, ctx);
}

/**
 * A traversal read from the binding its root NAMES. Split from
 * `evaluateTraverse` so a name that HOLDS a record (`top = FIRST(rows)`, a
 * value on the value plane) reads as that record — the same walk, the same
 * terminal — rather than as a second, narrower reading of the name.
 */
async function traverseFrom(
  expr: Extract<Expression, { type: 'traverse' }>,
  name: string,
  binding: Binding,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  switch (binding.kind) {
    case 'event': {
      if (!ctx.source) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${name}' (the event position) is not readable here — no event in scope`,
        );
      }
      return readAdapterTraverse(expr, name, 'the event position', {
        start: ctx.source.position,
        read: ctx.source,
        ctx,
      });
    }

    case 'sourcePosition': {
      return readAdapterTraverse(expr, name, 'a traversed source record', {
        start: binding.position,
        read: binding.read ?? ctx.source ?? missingRead(name),
        ctx,
      });
    }

    case 'instance': {
      // A graph-rooted traversal — `crm-[c:companies]->`, `graph-[c:Company
      // WHERE …]->` — reads through THAT graph's adapter from its meta
      // root (the interpreter wires the resolution; see
      // `MovementExprContext.graphRead`).
      const resolved = await ctx.graphRead?.(name, binding);
      if (!resolved) {
        throw unsupported(
          `reading '${name}' (${describeBinding[binding.kind]}) in an expression`,
          'graph-rooted reads need the interpreter-wired graphRead seam',
        );
      }
      // A bare graph name is its meta root: EXISTS(graph-[c:Company]->)
      // walks from it (the bridge lifts the path into the exists
      // terminal); a field read needs a collection hop first.
      if (expr.steps.length === 0 && existsTerminalOf(expr, name) === undefined) {
        throw unsupported(
          `reading fields of '${name}' (${describeBinding[binding.kind]})`,
          `traverse a collection — ${name}-[x:…]->`,
        );
      }
      return readAdapterTraverse(expr, name, `the '${name}' graph`, {
        start: resolved.start,
        read: resolved.read,
        ctx,
      });
    }

    case 'handle': {
      // `EXISTS(co-[:notes]->)` arrives as an exists TERMINAL with no steps of
      // its own (the bridge lifts the path into it), so it walks too.
      if (expr.steps.length > 0 || expr.expression.type === 'exists') {
        // A hopped read off the handle — resolve the handle to a { start, read }
        // pair (graphRead is wired to graphReadFor, handle-aware since Task 1)
        // and traverse through the same walker instance/kg reads use.
        const resolved = await handleRecord(binding, name, ctx);
        return readAdapterTraverse(expr, name, 'a write handle', {
          start: resolved.start,
          read: resolved.read,
          ctx,
        });
      }
      const field = directFieldRead(expr, name, 'a write handle');
      return {
        value: readHandleField(binding.handle, field),
        provenance: handleFieldProvenance(binding.handle, field),
      };
    }

    case 'extractRoot':
    case 'extractPosition': {
      const emissions = walkExtractSteps(binding.emission, expr.steps, name);
      const existsTerminal = existsTerminalOf(expr, name, { allowSteps: true });
      if (existsTerminal) {
        return evaluateExists(
          existsTerminal,
          emissions.map((emission): Binding => ({ kind: 'extractPosition', emission })),
          ctx,
        );
      }
      return readTerminal(expr, {
        name,
        what: 'an extracted entity',
        readField: (field) => collapse(emissions.map((e) => readEmissionField(e, field))),
        positions: () => ({
          value: emissions.map((e) => e.fields),
          provenance: { origins: emissions.flatMap((e) => (e.origin ? [e.origin] : [])) },
        }),
      });
    }

    case 'blockMeta': {
      const reached = await walkMetaSteps([binding], expr.steps, name, ctx);
      const existsTerminal = existsTerminalOf(expr, name, { allowSteps: true });
      if (existsTerminal) return evaluateExists(existsTerminal, reached, ctx);
      return readTerminal(expr, {
        name,
        what: 'a block meta-node',
        readField: (field) => collapse(reached.map((b) => readBindingField(b, field, name))),
        positions: () => ({
          // "The positions themselves": accumulated VALUE bindings yield
          // their values (the digest idiom — per-iteration strings,
          // JOINed over the meta-node edge); other binding kinds stay
          // opaque for counting-style aggregates.
          value: reached.map((b) => (b.kind === 'value' ? b.value : b)),
          provenance: { origins: reached.flatMap(bindingEntityOrigins) },
        }),
      });
    }

    case 'resource': {
      const field = directFieldRead(expr, name, 'a resource');
      // Resources carry their fields in `data` — same local lookup the
      // TG engine's `resource` expression performs.
      return {
        value:
          (binding.resource.data as Record<string, unknown> | undefined)?.[field] ?? null,
        provenance: fromOrigin(resourceOrigin(binding.resource, field)),
      };
    }

    case 'shapePosition': {
      // The in-memory record read: each field carries the trail of the
      // expression that wrote it — provenance flows through a shape
      // position untouched (a call's argument adaptation is invisible
      // to the trail).
      const field = directFieldRead(expr, name, 'a shape position');
      return readShapePositionField(binding, field);
    }

    case 'nodePosition': {
      // A synthesised node reads on BOTH planes: its entries by dot, its
      // synthesised landings by arrow. The arrow walk is the meta-node walker —
      // a landing is just another binding, so nested literals and blocks
      // flatten through the same hops.
      if (expr.steps.length > 0) {
        const reached = await walkMetaSteps([binding], expr.steps, name, ctx);
        const existsTerminal = existsTerminalOf(expr, name, { allowSteps: true });
        if (existsTerminal) return evaluateExists(existsTerminal, reached, ctx);
        // A landing may be synthesised OR a real source record (a pass-through
        // edge lands the walked source itself), so the read goes through the
        // landing-aware seam rather than the in-memory one.
        return readLandings(expr, reached, { name, what: 'a synthesised node', ctx });
      }
      const field = directFieldRead(expr, name, 'a synthesised node');
      return readNodePositionField(binding, field);
    }

    case 'lazyWalk': {
      // The read IS the walk (ruling 3: every read re-walks the live source —
      // nothing here caches). Further hops ride along into the same walk, so a
      // chain off a lazy binding is one traversal, not a walk plus a hop.
      const reached = await resolveDeferred(binding.walk, expr.steps, ctx, name);
      const existsTerminal = existsTerminalOf(expr, name, { allowSteps: true });
      if (existsTerminal) return evaluateExists(existsTerminal, reached, ctx);
      return readLandings(expr, reached, { name, what: 'a deferred traversal', ctx });
    }

    case 'positions': {
      // The block's returned landings, read exactly as any other set of
      // landings: a field maps over them, a hop continues from each.
      const reached = await walkMetaSteps(binding.landings, expr.steps, name, ctx);
      const existsTerminal = existsTerminalOf(expr, name, { allowSteps: true });
      if (existsTerminal) return evaluateExists(existsTerminal, reached, ctx);
      return readLandings(expr, reached, { name, what: "a block's returned records", ctx });
    }

    case 'callback': {
      // `cb.id` (the payload a button carries) / `cb.url` (the human link).
      // The ARROW plane (`cb-[:Called]->`) is not read here: its landings live
      // in the store, so the interpreter resolves them as block iterations /
      // an await, where a live read is available.
      const field = directFieldRead(expr, name, 'a callback');
      return { value: readCallbackField(binding, field), provenance: NO_PROVENANCE };
    }

    case 'value': {
      // A RECORD held on the value plane (`top = FIRST(rows)`, a list a
      // collection op handed back) is a position like any other: a walk off it
      // is that walk off the record — the reading a block head rooted here
      // already gives it (run.ts `headIterationsFrom`).
      const held = heldRecords(binding.value, expr);
      if (held !== undefined) return traverseFrom(expr, name, held, ctx);
      // EXISTS(x) on a value binding asks "does it hold a value?" —
      // null/undefined (an AI() that declared has_value: false, an
      // absent field projection) and empty lists answer false. This is
      // the gate idiom: `x = AI(…)` then `if EXISTS(x) { … }`.
      const existsTerminal = existsTerminalOf(expr, name);
      if (existsTerminal) {
        if (existsTerminal.steps.length > 0 || existsTerminal.where) {
          throw unsupported(
            `traversing inside EXISTS() from '${name}', which holds ${describeHeldValue(binding.value)} rather than a record`,
          );
        }
        const present = Array.isArray(binding.value)
          ? binding.value.length > 0
          : binding.value !== null && binding.value !== undefined;
        return {
          value: present,
          provenance: transformed(binding.provenance ?? NO_PROVENANCE),
        };
      }
      // Same projection semantics the meta-node path already applies to
      // accumulated value bindings (readBindingField): object values
      // yield the named field, everything else reads as null.
      const field = directFieldRead(expr, name, 'a value binding');
      return readBindingField(binding, field, name);
    }

    default:
      throw unsupported(`reading '${name}' (${describeBinding[binding.kind]}) in an expression`);
  }
}

/**
 * The record(s) a value-plane binding holds, as the binding a walk starts
 * from — or undefined where the read is the value plane's own. One record reads
 * as itself on both planes. A LIST of records reads as landings only when the
 * read walks (a hop, or an EXISTS that hops or filters): a bare field read or a
 * bare EXISTS over a list keeps its value-plane meaning (a projection, "is the
 * list non-empty"), which is what the checker typed it as.
 */
function heldRecords(
  value: unknown,
  expr: Extract<Expression, { type: 'traverse' }>,
): Binding | undefined {
  const held = heldBinding(value);
  if (held === undefined || !Array.isArray(value)) return held;
  const walks =
    expr.steps.length > 0 ||
    (expr.expression.type === 'exists' &&
      (expr.expression.steps.length > 0 || expr.expression.where !== undefined));
  return walks ? held : undefined;
}

/** The binding a value-plane value IS, when it is records: one record as
 *  itself, a non-empty list of nothing but records as their landings. */
function heldBinding(value: unknown): Binding | undefined {
  if (!Array.isArray(value)) return bindingOf(value);
  if (value.length === 0) return undefined;
  const members = value.map(bindingOf);
  return members.every((m): m is Binding => m !== undefined)
    ? { kind: 'positions', landings: members }
    : undefined;
}

/** What a value that holds no record IS, for a message. */
function describeHeldValue(value: unknown): string {
  if (value === null || value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'a list that is not all records';
  return `a ${typeof value}`;
}

/**
 * Read one field off wherever a walk landed. A landing that is a REAL source
 * position reads through its adapter (the ordinary `getFieldValue` seam, with
 * the ordinary `source_field` trail — a pass-through edge fabricates nothing);
 * an in-memory landing reads locally.
 */
export async function readLandingField(
  binding: Binding,
  field: string,
  name: string,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  if (binding.kind === 'sourcePosition') {
    return readSourcePositionField(binding.position, field, ctx, binding.read);
  }
  return readBindingField(binding, field, name);
}

/** The terminal of a read over a set of landings — a named field mapped over
 *  them, or the positions themselves for a surrounding aggregate. */
async function readLandings(
  expr: Extract<Expression, { type: 'traverse' }>,
  landed: Binding[],
  options: { name: string; what: string; ctx: MovementExprContext },
): Promise<MovementEvalResult> {
  const field = fieldTerminalId(expr.expression);
  if (field === undefined) {
    throw unsupported(`this read shape on ${options.what} ('${options.name}')`);
  }
  if (field === POSITION_SENTINEL) {
    // The landed RECORDS, in the currency the adapter walk hands back — a
    // source record stays the binding it is, read seam and all, so `MAP` over
    // a local edge holding references reads them as it reads any walk's.
    return {
      value: landed.map((b) => (b.kind === 'value' ? b.value : b)),
      provenance: { origins: landed.flatMap(bindingEntityOrigins) },
    };
  }
  const results: MovementEvalResult[] = [];
  for (const binding of landed) {
    results.push(await readLandingField(binding, field, options.name, options.ctx));
  }
  return collapse(results);
}

/**
 * A DICT at run time: a plain keyed object. `{ k: v }` literals, `GROUPBY` and
 * `KEYBY` all produce exactly this, which is the point — a dict is JSON's
 * object and nothing else, so it snapshots, crosses the wire and reaches a
 * `json` write field as itself. Arrays and dates are objects too and are not
 * dicts; neither is anything the engine wraps (a position, a file ref), which
 * is why the check is on the prototype rather than on `typeof`.
 */
export function isDictValue(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A sourcePosition binding with no read seam outside a movement body. */
function missingRead(name: string): never {
  throw new MovementEngineError(
    'MOVENG_RUNTIME',
    `'${name}' has no read seam in scope — no event in scope`,
  );
}

/**
 * The field a traverse terminal names, when it reads a single field:
 * a plain `property`, OR an `edge_property`. The bracket-WHERE grammar
 * parses EVERY `alias.`field`` inside a hop WHERE as an `edge_property`
 * (that bracket's currency), so an event/source field read used in a hop
 * filter — `… WHERE `x` <= t.`Fired at``- arrives with an `edge_property`
 * terminal even though it is just that position's field. Both terminals
 * mean "read this field off the (alias-rooted) position"; any other
 * terminal shape is not a single-field read. Returns undefined otherwise.
 */
function fieldTerminalId(terminal: Expression): string | undefined {
  if (terminal.type === 'property' || terminal.type === 'edge_property') {
    return terminal.propertyTypeId;
  }
  return undefined;
}

/**
 * The shared adapter-rooted traversal read: walk the hops (WHERE +
 * ORDER BY/LIMIT applied per hop, post-stream), then resolve the
 * terminal — an EXISTS quantifier over the landed positions, the
 * positions themselves (POSITION_SENTINEL, for aggregates like
 * `COUNT(kg-[c:company]->)`), or a property read per landed position.
 */
async function readAdapterTraverse(
  expr: Extract<Expression, { type: 'traverse' }>,
  name: string,
  what: string,
  input: { start: SourcePosition; read: SourceRead; ctx: MovementExprContext },
): Promise<MovementEvalResult> {
  const { ctx } = input;
  const existsTerminal = existsTerminalOf(expr, name, { allowSteps: true });
  const landed = await walkAdapterPositions({
    start: input.start,
    read: input.read,
    steps: expr.steps,
    name,
    ctx,
  });
  if (existsTerminal) return evaluateExists(existsTerminal, landed, ctx);
  const field = fieldTerminalId(expr.expression);
  if (field === undefined) {
    throw unsupported(`this read shape on ${what} ('${name}')`);
  }
  if (field === POSITION_SENTINEL) {
    // "The positions themselves" — the landed RECORDS, in the currency every
    // other many-valued read hands back (a block's landings, a collection op's
    // answer). A hop is many-valued, so a bare walk written as a value is a
    // list of records: `COUNT` counts them, `MAP` reads them, and a block head
    // walks them. A fan-out has no single origin to cite.
    return { value: landed, provenance: NO_PROVENANCE };
  }
  const results: MovementEvalResult[] = [];
  for (const b of landed) {
    results.push(await readSourcePositionField(b.position, field, ctx, b.read));
  }
  return collapse(results);
}

// ── Source-position reads (the adapter's getFieldValue seam) ───────────────

/**
 * The TG engine's source-position read primitive, shared by the event
 * position and every traversed source record: the adapter interprets
 * the field against the position. Source property reads carry
 * { instance, record, field } — the record identity when the position
 * is stable, instance + field alone for raw-payload events.
 */
async function readSourcePositionField(
  position: SourcePosition,
  field: string,
  ctx: MovementExprContext,
  /** The graph the position was yielded from, when it is not the
   *  movement's event source (instance-/kg-rooted traversals). */
  read?: SourceRead,
): Promise<MovementEvalResult> {
  const seam = read ?? ctx.source;
  if (!seam) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      'no source adapter in scope for this position read',
    );
  }
  const value = await seam.adapter.getFieldValue({ position, fieldId: field });
  // A null read of a field a RAW-PAYLOAD position doesn't even CARRY is the
  // classic schema-vs-payload mismatch (reading a record field off a thin event
  // payload) — record it (once per field) with what is actually there, so the
  // run can explain itself. ONLY for UNSTABLE positions: a stable adapter record
  // translates the natural field to its own internal currency inside
  // getFieldValue — an UNKNOWN field throws a drift error there, and a null is a
  // legitimately EMPTY known field — and its `data` is keyed in that internal
  // currency (e.g. Attio attribute slugs), so checking the natural field name
  // against it is meaningless and would both false-positive and leak internal keys.
  if ((value === null || value === undefined) && ctx.trace && !isStablePosition(position)) {
    const data = positionData(position);
    if (
      data !== null &&
      typeof data === 'object' &&
      !(field in (data as Record<string, unknown>)) &&
      !ctx.trace.some(
        (e) => e.kind === 'field_miss' && e.field === field && e.binding === seam.instanceName,
      )
    ) {
      ctx.trace.push({
        kind: 'field_miss',
        binding: seam.instanceName,
        field,
        available: Object.keys(data as Record<string, unknown>).slice(0, 30),
      });
    }
  }
  const recordType = isStablePosition(position) ? position.recordType ?? undefined : undefined;
  const externalId = positionRecordId(position);
  return {
    value,
    provenance: fromOrigin({
      kind: 'source_field',
      instance: seam.instanceName,
      adapterType: seam.adapter.adapterType,
      ...(recordType !== undefined ? { recordType } : {}),
      ...(externalId !== undefined ? { externalId } : {}),
      field,
    }),
  };
}

/** A rootless `property` read under a position scope — the field of the
 *  landed subject (see `MovementExprContext.scope`). */
async function readScopedProperty(
  field: string,
  scope: PositionScope,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  switch (scope.kind) {
    case 'position':
      return readSourcePositionField(scope.position, field, ctx, scope.read);
    case 'emission':
      return readEmissionField(scope.emission, field);
    case 'binding':
      return readBindingField(scope.binding, field, 'the scoped position');
  }
}

// ── EXISTS() (the frozen engine's quantifier, on the same read seams) ──────

/** The traverse's terminal when it is a bridge-lifted EXISTS — the
 *  bridge wraps `EXISTS(x-[:edge]->)` as a traverse with empty steps
 *  whose terminal carries the path, so subjects are the root binding
 *  itself (extract/meta roots walk their own steps first). */
function existsTerminalOf(
  expr: Extract<Expression, { type: 'traverse' }>,
  name: string,
  options: { allowSteps?: boolean } = {},
): Extract<Expression, { type: 'exists' }> | undefined {
  if (expr.expression.type !== 'exists') return undefined;
  if (!options.allowSteps && expr.steps.length > 0) {
    throw unsupported(`EXISTS() after hops from '${name}'`);
  }
  return expr.expression;
}

/**
 * Mirrors the frozen engine's `exists` evaluation: walk the traversal
 * from the subject(s), then true iff at least one yielded position
 * satisfies `where` (any position when absent). Each seam is the one
 * its cursor kind already reads through — adapter records via
 * `getRelated`, extracted entities via emission children, block
 * meta-nodes via their accumulated edges. Hop WHEREs and the final
 * WHERE evaluate position-scoped at the landed cursor.
 */
async function evaluateExists(
  exists: Extract<Expression, { type: 'exists' }>,
  subjects: Binding[],
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  let cursors = subjects;
  for (const step of exists.steps) {
    if (step.type !== 'edge') {
      throw unsupported(`'${step.type}' hops inside EXISTS()`);
    }
    const next: Binding[] = [];
    for (const cursor of cursors) {
      const isMember =
        cursor.kind === 'sourcePosition'
          ? hopMemberGate({ step, origin: cursor.position, read: cursor.read ?? ctx.source })
          : undefined;
      const kept: Binding[] = [];
      for (const landed of await stepExistsCursor(cursor, step, ctx)) {
        if (isMember && landed.kind === 'sourcePosition' && !isMember(landed.position)) continue;
        if (
          step.expressionFilter &&
          !(await hopFilterKeeps({ step, filter: step.expressionFilter, landed, ctx }))
        ) {
          continue;
        }
        kept.push(landed);
      }
      // Hop ORDER BY / LIMIT applies inside EXISTS too (post-stream, per
      // origin) — a LIMITed hop bounds which positions deeper hops (and
      // the final WHERE) see.
      next.push(
        ...(await applyHopOrderLimit(kept, step.cardinality, {
          value: hopOrderKeyReader(step, ctx),
        })),
      );
    }
    cursors = next;
    if (cursors.length === 0) break;
  }
  let value = cursors.length > 0;
  if (value && exists.where) {
    value = false;
    for (const cursor of cursors) {
      const ok = await evalScopedFilter(exists.where, scopeOf(cursor), ctx);
      if (ok) {
        value = true;
        break;
      }
    }
  }
  // A quantifier is a computed boolean — no origin to cite (the frozen
  // engine likewise surfaces exists results evidence-free).
  return { value, provenance: NO_PROVENANCE };
}

/** One EXISTS hop from a cursor, through the cursor's own read seam. An
 *  adapter seam gets the same fetch pushdown every other walker sends
 *  (`closedHopPushdown`); the in-memory seams (emission children, block meta
 *  edges) have nothing to push to and are filtered and bounded by the caller. */
async function stepExistsCursor(
  cursor: Binding,
  step: EdgeStep,
  ctx: MovementExprContext,
): Promise<Binding[]> {
  switch (cursor.kind) {
    case 'sourcePosition': {
      const read = cursor.read ?? ctx.source;
      if (!read) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          'no source adapter in scope for an EXISTS() traversal',
        );
      }
      if (
        step.direction === 'incoming' &&
        !read.adapter.runtimeCapabilities().traversal.incoming
      ) {
        throw unsupported(
          `incoming EXISTS() hops ('${step.edgeTypeId}')`,
          `source adapter '${read.adapter.adapterType}' cannot traverse incoming edges`,
        );
      }
      const fieldId =
        read.edgeFieldId?.(step.edgeTypeId, cursor.position) ?? step.edgeTypeId;
      const related = await read.adapter.getRelated({
        position: cursor.position,
        fieldId,
        direction: step.direction,
        ...(await closedHopPushdown({
          step,
          ctx,
          edgeProperties: read.adapter.runtimeCapabilities().traversal.edgeProperties,
        })),
      });
      return related.map(
        (r): Binding => ({
          kind: 'sourcePosition',
          position: r.position,
          ...(r.edgeProperties !== undefined ? { edgeProperties: r.edgeProperties } : {}),
          ...(cursor.read !== undefined ? { read: cursor.read } : {}),
        }),
      );
    }
    case 'extractRoot':
    case 'extractPosition':
      return (cursor.emission.children.get(step.edgeTypeId) ?? []).map(
        (emission): Binding => ({ kind: 'extractPosition', emission }),
      );
    case 'blockMeta':
      return cursor.edges.get(step.edgeTypeId) ?? [];
    case 'positions':
      return (
        await settledAll(cursor.landings.map((landing) => stepExistsCursor(landing, step, ctx)))
      ).flat();
    case 'handle': {
      // A written or matched record IS a record in its graph: the hop is that
      // graph's hop from it, the same seam a hopped read off the handle takes.
      const record = await handleRecord(cursor, describeBinding.handle, ctx);
      return stepExistsCursor(
        { kind: 'sourcePosition', position: record.start, read: record.read },
        step,
        ctx,
      );
    }
    case 'value': {
      // A record held on the value plane walks as the record it is.
      const held = heldBinding(cursor.value);
      if (held !== undefined) return stepExistsCursor(held, step, ctx);
      break;
    }
    default:
      break;
  }
  throw unsupported(
    `traversing '${step.edgeTypeId}' from ${describeBinding[cursor.kind]} inside EXISTS()`,
  );
}

/** The position scope a reached cursor provides to WHERE evaluation. */
function scopeOf(binding: Binding): PositionScope {
  if (binding.kind === 'sourcePosition') {
    return {
      kind: 'position',
      position: binding.position,
      ...(binding.edgeProperties !== undefined
        ? { edgeProperties: binding.edgeProperties }
        : {}),
      ...(binding.read !== undefined ? { read: binding.read } : {}),
    };
  }
  if (binding.kind === 'extractRoot' || binding.kind === 'extractPosition') {
    return { kind: 'emission', emission: binding.emission };
  }
  return { kind: 'binding', binding };
}

/**
 * `SORT(xs)` / `SORT(xs, DESC)` / `SORT(xs, key)` / `SORT(xs, key, DESC)` — the
 * same members, in the order the key puts them.
 *
 * With no key the members are ranked by themselves, which is the only thing a
 * list of text or numbers could mean. With one, the key is an expression over
 * each MEMBER, read in that member's own scope — the same key a hop's ORDER BY
 * takes, over a collection already in hand.
 *
 */
async function evaluateSort(
  expr: Extract<Expression, { type: 'aggregate' }>,
  members: unknown[],
  provenance: Provenance,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  const key = expr.orderBy;
  const sorted = await sortByOrderKey(members, expr.orderDirection, {
    value: async (member) => {
      const scope = memberScope(member);
      if (key === undefined) {
        // A record has no order of its own, and comparing two of them would
        // compare their text — an arbitrary order dressed as an answer.
        if (scope !== undefined) {
          throw unsupported(
            'sorting records with no key',
            'say what to rank them by — `SORT(xs, `Added At`, DESC)`',
          );
        }
        return member;
      }
      if (scope === undefined) {
        throw unsupported(
          "reading SORT's key off this member",
          'the key is read off a RECORD — bind the walk first (`entries = … { return e }`) and sort that, or sort plain values by themselves (`SORT(xs)`)',
        );
      }
      return evaluateMovementExpression(key, { ...ctx, scope });
    },
  });
  // Ordering transforms nothing about the members, so the trail is the one the
  // collection arrived with.
  return { value: sorted, provenance };
}

/**
 * The scope a SORT key reads from — the member itself, in whichever currency it
 * arrived: a RECORD the run is holding (a bound block's landings) reads through
 * its own graph, a DICT reads its keys. A plain value has no scope, because
 * there is nothing to read a key off — such a list sorts by its members.
 */
function memberScope(member: unknown): PositionScope | undefined {
  const binding = bindingOf(member);
  if (binding !== undefined) return scopeOf(binding);
  if (member !== null && typeof member === 'object' && isDictValue(member)) {
    return { kind: 'binding', binding: { kind: 'value', value: member } };
  }
  return undefined;
}

/**
 * How ONE landed record's ordering key is read. The key is an expression over
 * the element, so the element is both the SCOPE its bare names read from (a
 * field of the record, exactly as a bracket WHERE reads one) and the binding
 * its own alias names — which is what lets `ORDER BY e-[:Signal]->.\`Discovered
 * At\`` walk on from the very record being ranked.
 *
 * One evaluation per candidate, un-batched: a path key is a fetch per
 * candidate. The sort is the engine's, and so is its cost.
 *
 */
export function hopOrderKeyReader(
  step: Pick<EdgeStep, 'cardinality' | 'alias'>,
  ctx: MovementExprContext,
): (element: Binding) => Promise<unknown> {
  const key = hopOrderKey(step.cardinality);
  const alias = step.alias;
  return async (element) => {
    if (key === undefined) return null;
    let env = ctx.env;
    if (alias !== undefined) {
      env = ctx.env.child();
      env.declare(alias, element);
    }
    return evaluateMovementExpression(key, { ...ctx, env, scope: scopeOf(element) });
  };
}

/**
 * The TYPE the member a hop's WHERE narrowed its POLYMORPHIC edge to lands, and
 * the hop's declared target — the two names a landed record's own stamp is
 * judged against.
 *
 * The host resolves the selection once, during catalog assembly, by evaluating
 * the WHERE over the members the meta walk published, and records both halves
 * of the answer under one `refinementKey`: `refinements` names the POSITION the
 * checker types the hop as, `selectedMembers` names the TYPE whose records are
 * on that path (`List Entry — Portfolio`, never the addressing name
 * `Portfolio` — a record is stamped with the former and never the latter). The
 * runtime re-derives nothing — it looks the key up, so the two sides cannot
 * disagree about which member a WHERE chose.
 */
function hopSelection(input: {
  step: Pick<EdgeStep, 'edgeTypeId' | 'expressionFilter'>;
  origin: SourcePosition;
  read: SourceRead | undefined;
}): { memberType: string; declaredTarget: string; schema: InstanceSchema } | undefined {
  const filter = input.step.expressionFilter;
  const schema = input.read?.schema;
  if (filter === undefined || schema?.selectedMembers === undefined) return undefined;
  const from = input.origin.recordType;
  const declaredTarget =
    (from !== null ? schema.positions[from]?.edges[input.step.edgeTypeId]?.target : undefined) ??
    schema.collections[input.step.edgeTypeId]?.target;
  if (declaredTarget === undefined) return undefined;
  const memberType = schema.selectedMembers[refinementKey({ type: declaredTarget, filter })];
  return memberType === undefined ? undefined : { memberType, declaredTarget, schema };
}

/**
 * Whether a landed record is one the hop is ABOUT.
 *
 * A narrowed polymorphic edge is procedurally a NAMED one: the hop addresses
 * the selected member, so a record of a different member is not a match — it is
 * dropped before any of its fields are read, with no error and no drift note,
 * because the field the WHERE goes on to test is one that member never had.
 * (Drift is the source's schema having CHANGED; this record's type simply isn't
 * on the path.) Doing it here rather than leaning on the WHERE to fail first is
 * the point: the checker narrows the hop as a whole, so which member a hop is
 * about cannot depend on which conjunct the author wrote first.
 *
 * Judged on the record's OWN stamp, read through `stampedPositionName` — the
 * SAME rule the read wrapper uses to decide whether that stamp survives. Two
 * readings of one fact would be two chances to disagree, and that is precisely
 * the defect this gate first shipped with: it compared a record's type against
 * the member's ADDRESSING name (`Portfolio`) while the adapter stamps the
 * member TYPE (`List Entry — Portfolio`), so a gate meant to drop the other
 * list's entries dropped every entry there was.
 *
 * A stamp the schema does not recognise, or one saying nothing more specific
 * than the edge's declared target, tells us nothing about membership: the WHERE
 * runs against that record exactly as it always has (Sheets lands a tab typed
 * as the declared target and is unaffected). Likewise a hop the host did not
 * narrow gates nothing.
 */
export function hopMemberGate(input: {
  step: Pick<EdgeStep, 'edgeTypeId' | 'expressionFilter'>;
  origin: SourcePosition;
  read: SourceRead | undefined;
}): (landed: SourcePosition) => boolean {
  const selection = hopSelection(input);
  if (selection === undefined) return () => true;
  return (landed) => {
    const stamped = stampedPositionName({ schema: selection.schema, position: landed });
    if (stamped === undefined || stamped === selection.declaredTarget) return true;
    return stamped === selection.memberType;
  };
}

/**
 * Evaluate a hop / EXISTS WHERE predicate to its keep decision, position-
 * scoped at the landed subject. A PURE predicate (`isPurePredicate`) routes
 * through the shared filter unit: its leaf reads are resolved once each through
 * the engine's OWN read seams (so the values — and therefore the decision —
 * are identical to the full evaluator), then evaluated synchronously with no
 * provenance machinery. Anything impure (an `AI()` gate, a nested `EXISTS()`,
 * a `TRIM()` call) stays on the full async evaluator. A `@<key>` meta is PURE —
 * its leaf value is pre-resolved through `evalMovementExpr`'s meta resolver
 * (`case 'meta'`) under `leafReadKey` (`@<key>`), exactly like any other leaf.
 *
 * A top-level AND is taken one conjunct at a time, in the order written, and a
 * false one ends the evaluation — the full evaluator short-circuits, so
 * resolving leaves it would never have read is not an optimisation but the
 * difference between agreeing with it and raising an error it never would.
 * (Inside an OR or a NOT, every leaf of the surviving conjunct is still
 * resolved before it is evaluated.)
 */
/**
 * Whether a record a hop landed on passes the hop's WHERE. The hop's own alias
 * names that record inside the filter, as it does in the bracket's ORDER BY —
 * `-[e:X WHERE e.\`F\` == 1]->` reads `F` off the landed record exactly as the
 * bare `WHERE \`F\` == 1` does. Every walker that evaluates a hop WHERE goes
 * through here, so the alias means the same thing wherever the hop is written.
 */
export async function hopFilterKeeps(input: {
  step: Pick<EdgeStep, 'alias'>;
  filter: Expression;
  landed: Binding;
  ctx: MovementExprContext;
}): Promise<boolean> {
  const { step, filter, landed, ctx } = input;
  let env = ctx.env;
  if (step.alias !== undefined) {
    env = ctx.env.child();
    env.declare(step.alias, landed);
  }
  return Boolean(await evalScopedFilter(filter, scopeOf(landed), { ...ctx, env }));
}

const NEEDS_THE_CLOCK = Symbol('a WITHIN needs the clock');

/**
 * A pure predicate decided with `read`, its `WITHIN` measured from the host's
 * clock: asked only when a `WITHIN` is reached, as the Rust engine asks it
 * at the comparison. Deciding a pure predicate twice is safe (it reads
 * nothing but `read`), so the first try runs without the clock and the
 * second, only if the first reached a `WITHIN`, with it. Outside a run (no
 * clock), the wall clock.
 */
export async function decideWithClock(
  filter: Expression,
  read: (name: string) => unknown,
  clock: EngineClock | undefined,
): Promise<unknown> {
  if (clock === undefined) return evaluatePredicate(filter, { read });
  try {
    return evaluatePredicate(filter, {
      read,
      now: () => {
        throw NEEDS_THE_CLOCK;
      },
    });
  } catch (error) {
    if (error !== NEEDS_THE_CLOCK) throw error;
    const now = (await clock.now()).getTime();
    return evaluatePredicate(filter, { read, now: () => now });
  }
}

async function evalScopedFilter(
  filter: Expression,
  scope: PositionScope,
  ctx: MovementExprContext,
): Promise<unknown> {
  const scopedCtx: MovementExprContext = { ...ctx, scope };
  if (!isPurePredicate(filter)) {
    return evaluateMovementExpression(filter, scopedCtx);
  }
  // `evalMovementExpr` resolves every leaf form — including a zero-step
  // traverse (`t.firedAt`) via its alias-rooted read seam — so the value (and
  // therefore the decision) is identical to the full async evaluator.
  return decidePurePredicate(filter, async (leaf) => (await evalMovementExpr(leaf, scopedCtx)).value, ctx.clock);
}

/**
 * Decide a PURE predicate, reading each leaf only when the conjunct that needs
 * it is reached: a top-level AND is taken one conjunct at a time, in the order
 * written, and a false one ends it. That is the full evaluator's short-circuit,
 * and every place that decides a WHERE by pre-reading leaves goes through here
 * so none of them reads a field a false conjunct already ruled out — a field
 * the record may not have at all. Each leaf is read at most once.
 */
export async function decidePurePredicate(
  filter: Expression,
  readLeaf: (leaf: LeafRead) => Promise<unknown>,
  clock?: EngineClock,
): Promise<unknown> {
  const reads = new Map<string, unknown>();
  let last: unknown = true;
  for (const conjunct of flattenAndConjuncts(filter)) {
    for (const leaf of pureLeafReads(conjunct)) {
      const name = leafReadKey(leaf);
      if (!reads.has(name)) reads.set(name, await readLeaf(leaf));
    }
    last = await decideWithClock(conjunct, (name) => reads.get(name), clock);
    if (!last) return last;
  }
  return last;
}

// ── Bracket ORDER BY / LIMIT (post-stream, per origin position) ─────────────
//
// A hop's `ORDER BY \`field\` [ASC|DESC] LIMIT n` applies AFTER the
// adapter streams the hop's records and the WHERE filter ran — honestly
// NO pushdown: adapters keep streaming everything the hop yields, and the
// engine sorts + slices the survivors per origin position. (Native
// order/limit pushdown is a future optimisation, not a semantic.)

/** Order-key comparison: nulls last, numbers numerically, everything
 *  else as strings (ISO timestamps compare correctly as strings). */
// ORDER BY / LIMIT evaluation now lives in the shared, low-dependency filter
// unit (`#shared/expression/order_limit`); re-exported here for the engine's
// existing consumers.
export { applyHopOrderLimit, compareOrderValues, hopOrderProperty, hopPushdown, type HopCardinality };

/**
 * A hop's fetch pushdown, CLOSED over the scope the hop was written in: every
 * operand of the WHERE that names something the engine has ALREADY resolved to
 * a scalar — a body binding, a field of a record bound outside the hop —
 * arrives at the adapter as that literal.
 *
 * Why: a source can only narrow by a value it holds (`Field == "literal"`), so
 * an unresolved reference used to make the whole predicate unnarrowable —
 * `crm-[o:Organization WHERE \`Name\` == d.\`name\`]->` reached the adapter with
 * `d.name` still a reference and paged an entire CRM to find one company. The
 * values substituted are the engine's own: the same resolution
 * `evalScopedFilter` performs per landed record, done once, before the fetch.
 * The engine still filters what comes back, so the ANSWER cannot move — only
 * the fetch narrows.
 *
 * What stays a reference, because substituting it could make the source return
 * FEWER records than the hop yields (`GetRelatedInput.where` forbids that):
 * anything reading the ELEMENT being filtered — the hop's own alias, and every
 * bare field name, which is exactly what the adapter is being asked to match;
 * anything the scope has not bound to a scalar (a record, a collection, an
 * absent value — absence is the engine filter's question to answer); and a
 * bare name on an edge that can carry inline properties, where the landed
 * record's own edge property would win over the binding.
 */
export async function closedHopPushdown(input: {
  step: EdgeStep;
  ctx: MovementExprContext;
  /** Whether the walked edge can carry inline edge properties — the adapter's
   *  `runtimeCapabilities().traversal.edgeProperties`. */
  edgeProperties: boolean;
}): Promise<ReturnType<typeof hopPushdown>> {
  const pushdown = hopPushdown(input.step);
  if (pushdown.where === undefined) return pushdown;
  const substitutions = new Map<Expression, Expression>();
  for (const leaf of pureLeafReads(pushdown.where)) {
    const value = await outerScalar(leaf, input);
    if (value !== undefined) substitutions.set(leaf, { type: 'static', value });
  }
  if (substitutions.size === 0) return pushdown;
  return { ...pushdown, where: replacePureLeaves(pushdown.where, substitutions) };
}

/** The scalar an outer-scope leaf read already resolves to, or undefined when
 *  the leaf reads the hop's own element, isn't bound to a scalar, or can't be
 *  read without a landed record. */
async function outerScalar(
  leaf: LeafRead,
  input: { step: EdgeStep; ctx: MovementExprContext; edgeProperties: boolean },
): Promise<string | number | boolean | undefined> {
  switch (leaf.type) {
    // An ambient (`@current_date`) is nobody's binding — the engine resolves it,
    // and it moves. Leaving it makes the fetch wider than it could be, never
    // narrower, which is the side of the contract to be on.
    case 'meta':
      return undefined;
    // A bare name in a bracket WHERE means the walked edge's own inline
    // property FIRST (`evalMovementExpr`), and only a landed record can answer
    // that — so where an edge carries any, a binding of the same name must not
    // stand in for it.
    case 'edge_property':
      return input.edgeProperties ? undefined : boundScalar(leaf.propertyTypeId, input);
    case 'property':
      return boundScalar(leaf.propertyTypeId, input);
    case 'alias_ref':
      return boundScalar(leaf.name, input);
    // `d.\`name\`` — a field of a record bound OUTSIDE this hop; the hop's own
    // alias reads the element and stays a reference.
    case 'traverse':
      if (leaf.aliasRoot === undefined || leaf.aliasRoot === input.step.alias) return undefined;
      try {
        return asPushableScalar((await evalMovementExpr(leaf, input.ctx)).value);
      } catch {
        // Unreadable HERE is not an error here: the engine reads it again per
        // landed record and reports it there, exactly as it does today.
        return undefined;
      }
  }
}

/** The scalar a bare NAME is bound to in the surrounding scope — `scopedBinding`'s
 *  rule, which is what such a name resolves to before the landed record's own
 *  field is read. */
function boundScalar(
  name: string,
  input: { step: EdgeStep; ctx: MovementExprContext },
): string | number | boolean | undefined {
  if (name === input.step.alias) return undefined;
  const binding = input.ctx.env.resolve(name);
  if (binding?.kind !== 'value') return undefined;
  return asPushableScalar(binding.value);
}

/** The `static` operand a value can stand in as. Null and absent are
 *  deliberately NOT: `x == NULL` is a presence question the engine answers, and
 *  a source asked to match a literal null would answer a different one. */
function asPushableScalar(value: unknown): string | number | boolean | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined;
}

/**
 * Walk plain edge hops through an adapter from `start` — the shared
 * traversal for graph-rooted EXPRESSION reads (`crm-[c:companies]->.
 * \`name\``, `kg-[c:company WHERE …]->`) and the event-rooted ones. Each
 * hop streams through the read seam, applies its WHERE position-scoped,
 * then its ORDER BY / LIMIT per origin (post-stream — see above), and
 * the yielded bindings carry the seam so later reads route correctly.
 */
async function walkAdapterPositions(input: {
  start: SourcePosition;
  read: SourceRead;
  steps: Extract<Expression, { type: 'traverse' }>['steps'];
  name: string;
  ctx: MovementExprContext;
}): Promise<Array<Extract<Binding, { kind: 'sourcePosition' }>>> {
  const { read, ctx } = input;
  let cursors: SourcePosition[] = [input.start];
  let landed: Array<Extract<Binding, { kind: 'sourcePosition' }>> = [
    { kind: 'sourcePosition', position: input.start, read },
  ];
  for (const step of input.steps) {
    if (step.type !== 'edge') {
      throw unsupported(`'${step.type}' hops in a traversal from '${input.name}'`);
    }
    if (step.direction === 'incoming' && !read.adapter.runtimeCapabilities().traversal.incoming) {
      throw unsupported(
        `incoming hops ('${step.edgeTypeId}')`,
        `source adapter '${read.adapter.adapterType}' cannot traverse incoming edges`,
      );
    }
    const next: Array<Extract<Binding, { kind: 'sourcePosition' }>> = [];
    // The hop's WHERE / ORDER BY / LIMIT go to the adapter so it can narrow the
    // FETCH — an unbounded collection hits the provider's filtered query API
    // instead of paging everything. The WHERE goes CLOSED over this scope (the
    // names it reads from around the hop are already values here), once per
    // hop rather than per cursor. Same call every walker makes; the engine
    // still filters, sorts and slices below, so the answer is the same whether
    // or not the adapter narrowed.
    const pushdown = await closedHopPushdown({
      step,
      ctx,
      edgeProperties: read.adapter.runtimeCapabilities().traversal.edgeProperties,
    });
    for (const cursor of cursors) {
      // A WHERE that narrowed this hop to one member addresses THAT member;
      // records of the others are not matches and are never read from.
      const isMember = hopMemberGate({ step, origin: cursor, read });
      const fieldId = read.edgeFieldId?.(step.edgeTypeId, cursor) ?? step.edgeTypeId;
      const related = await read.adapter.getRelated({
        position: cursor,
        fieldId,
        direction: step.direction,
        ...pushdown,
      });
      const kept: Array<Extract<Binding, { kind: 'sourcePosition' }>> = [];
      for (const r of related) {
        if (!isMember(r.position)) continue;
        const candidate: Extract<Binding, { kind: 'sourcePosition' }> = {
          kind: 'sourcePosition',
          position: r.position,
          ...(r.edgeProperties !== undefined ? { edgeProperties: r.edgeProperties } : {}),
          read,
        };
        if (
          step.expressionFilter &&
          !(await hopFilterKeeps({ step, filter: step.expressionFilter, landed: candidate, ctx }))
        ) {
          continue;
        }
        kept.push(candidate);
      }
      next.push(
        ...(await applyHopOrderLimit(kept, step.cardinality, {
          value: hopOrderKeyReader(step, ctx),
        })),
      );
    }
    landed = next;
    cursors = next.map((b) => b.position);
    if (landed.length === 0) break;
  }
  return landed;
}

// ── Provenance origins for the traversal reads ──────────────────────────────

function handleFieldProvenance(handle: WriteRecord, field: string): Provenance {
  if (!handle.origin) return NO_PROVENANCE;
  return fromOrigin({ ...handle.origin, field });
}

function resourceOrigin(
  resource: Resource,
  field?: string,
): Extract<ProvenanceOrigin, { kind: 'resource' }> {
  return {
    kind: 'resource',
    ...(resource.externalId !== undefined ? { externalId: resource.externalId } : {}),
    ...(resource.name !== undefined ? { name: resource.name } : {}),
    ...(field !== undefined ? { field } : {}),
  };
}

/** The entity-level origins of a meta-node position (the bindings the
 *  block accumulated) — best-effort, for POSITION_SENTINEL aggregates. */
function bindingEntityOrigins(binding: Binding): ProvenanceOrigin[] {
  switch (binding.kind) {
    case 'handle':
      return binding.handle.origin ? [binding.handle.origin] : [];
    case 'extractPosition':
    case 'extractRoot':
      return binding.emission.origin ? [binding.emission.origin] : [];
    case 'value':
      return [...(binding.provenance?.origins ?? [])];
    case 'resource':
      return [resourceOrigin(binding.resource)];
    case 'shapePosition':
    case 'nodePosition':
      return unionProvenance(Object.values(binding.fieldProvenance)).origins;
    case 'positions':
      return binding.landings.flatMap(bindingEntityOrigins);
    case 'tuple':
      return binding.slots.flatMap(bindingEntityOrigins);
    default:
      return [];
  }
}

function readShapePositionField(
  binding: Extract<Binding, { kind: 'shapePosition' }>,
  field: string,
): MovementEvalResult {
  return {
    value: binding.fields[field] ?? null,
    provenance: binding.fieldProvenance[field] ?? NO_PROVENANCE,
  };
}

/** The dot plane of a synthesised node — the adapter's `getFieldValue` seam,
 *  for a position no adapter owns. The entry was evaluated at the literal, so
 *  the read is a lookup; its trail is the one the entry's expression carried. */
export function readNodePositionField(
  binding: Extract<Binding, { kind: 'nodePosition' }>,
  field: string,
): MovementEvalResult {
  return {
    value: binding.fields[field] ?? null,
    provenance: binding.fieldProvenance[field] ?? NO_PROVENANCE,
  };
}

/** The LANDED half of the arrow plane — the `getRelated` seam for edges whose
 *  positions are already in hand. An edge the literal never wrote has no
 *  landings, which is an empty traversal, not an error (the checker already
 *  refused the name); a DEFERRED edge has none until its walk runs, so callers
 *  that can walk must check for one first. */
export function nodeEdgeLandings(
  binding: Extract<Binding, { kind: 'nodePosition' }>,
  edge: string,
): Binding[] {
  const found = binding.edges[edge];
  return found?.kind === 'landed' ? found.landings : [];
}

// ── Extract-graph and meta-node traversal ───────────────────────────────────

/** Walks plain edge hops over the extract result graph — each hop fans
 *  out to the child emissions, exactly like the language's blocks do. */
function walkExtractSteps(
  root: ExtractEmission,
  steps: Extract<Expression, { type: 'traverse' }>['steps'],
  name: string,
): ExtractEmission[] {
  let current: ExtractEmission[] = [root];
  for (const step of steps) {
    if (step.type !== 'edge') {
      throw unsupported(`'${step.type}' hops over the extract result ('${name}')`);
    }
    if (step.expressionFilter) {
      throw unsupported(`WHERE filters on extract-result hops ('${name}')`);
    }
    current = current.flatMap((e) => e.children.get(step.edgeTypeId) ?? []);
  }
  return current;
}

/**
 * Walks hops over a block meta-node: each edge yields the bindings the block
 * accumulated under that name; further hops keep flattening (nested blocks'
 * meta-nodes, extracted entities' children, a synthesised node's landings).
 *
 * ASYNC because a hop can leave the in-memory planes entirely: a DEFERRED edge
 * (or a `lazy` binding reached along the way) resolves by walking the live
 * source through the interpreter's seam, and the rest of the chain continues
 * from there — inside the source graph, where the source's own walker owns it.
 */
async function walkMetaSteps(
  start: Binding[],
  steps: Extract<Expression, { type: 'traverse' }>['steps'],
  name: string,
  ctx: MovementExprContext,
): Promise<Binding[]> {
  if (steps.length === 0) return start;
  const [step, ...rest] = steps;
  if (step.type !== 'edge') {
    throw unsupported(`'${step.type}' hops over a block meta-node ('${name}')`);
  }
  const reached: Binding[] = [];
  for (const binding of start) {
    // A lazy binding IS the walk, so the whole remaining chain — this hop
    // included — continues from it, through the source's own walker.
    if (binding.kind === 'lazyWalk') {
      reached.push(...(await resolveDeferred(binding.walk, steps, ctx, name)));
      continue;
    }
    // A landing that is a RECORD in a graph (a block's returned records, a
    // record held on the value plane) walks the rest of the chain in that
    // graph, through the one adapter walker — its WHERE / ORDER BY / LIMIT
    // included, exactly as a read rooted at the record would.
    const record = await graphRecordOf(binding, name, ctx);
    if (record !== undefined) {
      reached.push(
        ...(await walkAdapterPositions({ start: record.start, read: record.read, steps, name, ctx })),
      );
      continue;
    }
    const held = binding.kind === 'value' ? heldBinding(binding.value) : undefined;
    if (held !== undefined) {
      const landings = held.kind === 'positions' ? held.landings : [held];
      reached.push(...(await walkMetaSteps(landings, steps, name, ctx)));
      continue;
    }
    if (binding.kind === 'nodePosition') {
      const edge = binding.edges[step.edgeTypeId];
      if (edge?.kind === 'deferred') {
        // Crossing a deferred edge IS running its walk; the hops PAST it carry
        // on inside the source graph, where the same walker owns them.
        if (step.expressionFilter) throw synthesisedEdgeFilter(name);
        reached.push(...(await resolveDeferred(edge.walk, rest, ctx, name)));
        continue;
      }
      // A landed edge holds its landings in hand — a local graph's own — so a
      // hop WHERE keeps the ones it holds for, through the same keep decision
      // every other walker makes.
      const kept: Binding[] = [];
      for (const landed of edge?.landings ?? []) {
        if (
          step.expressionFilter === undefined
          || (await hopFilterKeeps({ step, filter: step.expressionFilter, landed, ctx }))
        ) {
          kept.push(landed);
        }
      }
      reached.push(...(await walkMetaSteps(kept, rest, name, ctx)));
      continue;
    }
    if (step.expressionFilter) {
      throw unsupported(`WHERE filters on block meta-node hops ('${name}')`);
    }
    if (binding.kind === 'blockMeta') {
      reached.push(
        ...(await walkMetaSteps(binding.edges.get(step.edgeTypeId) ?? [], rest, name, ctx)),
      );
      continue;
    }
    if (binding.kind === 'positions') {
      reached.push(...(await walkMetaSteps(binding.landings, steps, name, ctx)));
      continue;
    }
    if (binding.kind === 'extractPosition' || binding.kind === 'extractRoot') {
      const children = (binding.emission.children.get(step.edgeTypeId) ?? []).map(
        (emission): Binding => ({ kind: 'extractPosition', emission }),
      );
      reached.push(...(await walkMetaSteps(children, rest, name, ctx)));
      continue;
    }
    throw unsupported(
      `traversing '${step.edgeTypeId}' from ${describeBinding[binding.kind]} inside a meta-node read`,
    );
  }
  return reached;
}

/** Where a walk off this landing starts in its graph, when the landing is a
 *  record there: a traversed source record or a write / match handle.
 *  Undefined for the in-memory planes. */
async function graphRecordOf(
  binding: Binding,
  name: string,
  ctx: MovementExprContext,
): Promise<{ start: SourcePosition; read: SourceRead } | undefined> {
  if (binding.kind === 'sourcePosition') {
    return { start: binding.position, read: binding.read ?? ctx.source ?? missingRead(name) };
  }
  if (binding.kind === 'handle') return handleRecord(binding, name, ctx);
  return undefined;
}

/** The record a write / match handle bound, as a walk's start in its graph. */
async function handleRecord(
  binding: Extract<Binding, { kind: 'handle' }>,
  name: string,
  ctx: MovementExprContext,
): Promise<{ start: SourcePosition; read: SourceRead }> {
  const resolved = await ctx.graphRead?.(name, binding);
  if (!resolved) {
    throw unsupported(
      `traversing from a write handle ('${name}')`,
      'the handle bound no readable record to traverse from',
    );
  }
  return resolved;
}

/** A synthesised edge's landings are what the literal declared or what its
 *  stored walk yields — there is no adapter to push a filter to, and filtering
 *  them here would be a second, differently-behaved WHERE. */
function synthesisedEdgeFilter(name: string): MovementEngineError {
  return unsupported(
    `WHERE filters on a synthesised node's edges ('${name}')`,
    "narrow the entry's own traversal instead — the WHERE belongs on the hop the node's edge is built from",
  );
}

async function resolveDeferred(
  walk: DeferredWalk,
  hops: Extract<Expression, { type: 'traverse' }>['steps'],
  ctx: MovementExprContext,
  name: string,
): Promise<Binding[]> {
  if (!ctx.walkDeferred) {
    throw unsupported(
      `reading the deferred traversal bound to '${name}'`,
      'a lazy walk runs through the interpreter-wired walkDeferred seam',
    );
  }
  return ctx.walkDeferred(walk, hops);
}

/**
 * Resolves a traversal's terminal read: a named property maps over the
 * reached positions; the POSITION_SENTINEL (the bridge's "the positions
 * themselves", spliced in for `COUNT(orgs-[:co]->)`) yields the
 * positions for the surrounding aggregate.
 */
function readTerminal(
  expr: Extract<Expression, { type: 'traverse' }>,
  options: {
    name: string;
    what: string;
    readField: (field: string) => MovementEvalResult;
    positions: () => MovementEvalResult;
  },
): MovementEvalResult {
  const field = fieldTerminalId(expr.expression);
  if (field === undefined) {
    throw unsupported(`this read shape on ${options.what} ('${options.name}')`);
  }
  if (field === POSITION_SENTINEL) return options.positions();
  return options.readField(field);
}

/**
 * Is this spread operand a walk read for a field — inline, or a name bound to
 * one — whose value is a `collapse`? The checker's own test (`isWalkProjection`,
 * `ScopeSymbol.plural`), on the same shape. A bare name under a position scope
 * still resolves a value binding first, as `property` does.
 */
function isManyValued(expr: Expression, ctx: MovementExprContext): boolean {
  if (isWalkProjection(expr)) return true;
  const name =
    expr.type === 'property' ? expr.propertyTypeId : expr.type === 'alias_ref' ? expr.name : undefined;
  if (name === undefined) return false;
  const binding = ctx.env.resolve(name);
  return binding?.kind === 'value' && binding.many === true;
}

/**
 * A `collapse` read back as the values it collapsed — the reading every fold
 * already gives a walk's field (`aggregate`): nothing landed is none, one
 * landing is its one value, several are theirs. A field that itself holds a
 * list is spliced as that list's members, which is the reading the checker
 * gives it (it only reads a walk as one value per landing where each landing's
 * value stands alone).
 */
export function membersOf(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** 0 → null, 1 → the result (provenance intact — a single un-transformed
 *  value stays faithful), n → the values with the unioned trail (a
 *  fan-out can't attribute one origin; mirrors the TG collapse rule). */
function collapse(results: MovementEvalResult[]): MovementEvalResult {
  if (results.length === 0) return { value: null, provenance: NO_PROVENANCE };
  if (results.length === 1) return results[0];
  return {
    value: results.map((r) => r.value),
    provenance: unionProvenance(results.map((r) => r.provenance)),
  };
}

function readEmissionField(emission: ExtractEmission, field: string): MovementEvalResult {
  const origin = emission.provenance[field];
  return {
    value: emission.fields[field] ?? null,
    provenance: origin ? fromOrigin(origin) : NO_PROVENANCE,
  };
}

/**
 * A stdlib argument declared `recordArg` (`TEXT.PAIRS`'s first), evaluated as
 * the RECORD it names rather than as a value. A dict literal is already its
 * fields; a record reached by a walk or held in a name (a landing, an extracted
 * node, a `FIRST(…)` answer, a write handle) is a binding, and a pure function
 * over keys would otherwise enumerate the engine's own internals.
 */
async function evalRecordArgument(
  expr: Expression,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  const result = await evalValueMember(expr, ctx);
  const record = bindingOf(result.value);
  if (record === undefined) return result;
  return { value: recordFields(record), provenance: result.provenance };
}

/**
 * A stdlib argument declared `wholeValueArg` (`TEXT.SERIALISE`'s first),
 * evaluated as the VALUE it is with every record inside it read down to plain
 * data — see `plainValueOf`.
 */
async function evalWholeValueArgument(
  expr: Expression,
  ctx: MovementExprContext,
): Promise<MovementEvalResult> {
  const result = await evalValueMember(expr, ctx);
  return { value: plainValueOf(result.value, new Set()), provenance: result.provenance };
}

/**
 * A value as plain data: a record (at any depth — the value itself, a list's
 * member, a dict's entry) becomes a keyed object of its dot plane, plus one
 * key per edge it carries holding the records landed on that edge as a LIST
 * (an edge's cardinality is not a fact the run holds, and a shape that
 * changed between one landing and two would change the bytes of an otherwise
 * identical prompt). Lists and dicts are walked; everything else is already
 * plain.
 *
 * Edges that are only DEFERRED (a `lazy` walk) are refused rather than
 * walked: running one here would be a live read hidden inside a pure
 * function. A record that contains itself through its edges is refused for
 * the same reason a cycle always is — there is no finite text for it.
 */
function plainValueOf(value: unknown, path: Set<Binding>): unknown {
  const binding = bindingOf(value);
  if (binding !== undefined) return plainRecordOf(binding, path);
  if (Array.isArray(value)) return value.map((member) => plainValueOf(member, path));
  if (isDictValue(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, plainValueOf(member, path)]),
    );
  }
  return value;
}

function plainRecordOf(binding: Binding, path: Set<Binding>): unknown {
  if (path.has(binding)) {
    throw unsupported('writing out a record that contains itself through its edges');
  }
  path.add(binding);
  try {
    switch (binding.kind) {
      case 'positions':
        return binding.landings.map((landing) => plainRecordOf(landing, path));
      case 'tuple':
        return binding.slots.map((slot) => plainRecordOf(slot, path));
      case 'value':
        return plainValueOf(binding.value, path);
      default:
        break;
    }
    const plain: Record<string, unknown> = {};
    for (const [field, member] of Object.entries(recordFields(binding))) {
      plain[field] = plainValueOf(member, path);
    }
    const edges: Array<[string, unknown]> = [];
    if (binding.kind === 'nodePosition') {
      for (const [name, edge] of Object.entries(binding.edges)) {
        if (edge.kind === 'deferred') {
          throw unsupported(
            `writing out the '${name}' edge of a record, which is a lazy walk that has not been run`,
            'await it first',
          );
        }
        edges.push([name, edge.landings.map((landing) => plainRecordOf(landing, path))]);
      }
    } else if (binding.kind === 'extractPosition' || binding.kind === 'extractRoot') {
      for (const [name, children] of binding.emission.children) {
        edges.push([
          name,
          children.map((emission) => plainRecordOf({ kind: 'extractPosition', emission }, path)),
        ]);
      }
    }
    for (const [name, landed] of edges) {
      if (name in plain) {
        throw unsupported(`writing out a record whose field and edge are both called '${name}'`);
      }
      plain[name] = landed;
    }
    return plain;
  } finally {
    path.delete(binding);
  }
}

/**
 * A record's whole dot plane as a plain field map, keys in DECLARATION order —
 * the one dereference any function taking a whole record reads through. Every
 * declared field is a key (absent reads null, as a field read does); nested
 * nodes and edges live on the arrow plane and are not here at all.
 *
 * Declaration order is what each kind holds: an extracted node's exported
 * fields; a synthesised node's `fieldOrder`; a shape position's written body;
 * a write handle's written fields, then what the system handed back. A kind
 * with no field list in hand refuses, named, rather than rendering nothing.
 */
/**
 * What `...m` copies into a map literal: a map's keys, or a record's fields as
 * the record holds them (its dot plane — an edge is a walk, not a key). An
 * absent value copies nothing, as TypeScript's `...undefined` does.
 */
function spreadKeysOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  const record = bindingOf(value);
  if (record !== undefined) return recordFields(record);
  if (isDictValue(value)) return value;
  throw unsupported(
    `copying the keys of ${describeHeldValue(value)} into a map`,
    'a spread copies a map\'s keys or a record\'s fields — write the value under a key instead (the checker should have caught this)',
  );
}

export function recordFields(binding: Binding): Record<string, unknown> {
  switch (binding.kind) {
    case 'nodePosition':
      return Object.fromEntries(binding.fieldOrder.map((f) => [f, binding.fields[f] ?? null]));
    case 'shapePosition':
      return { ...binding.fields };
    case 'extractPosition':
    case 'extractRoot':
      return { ...binding.emission.fields };
    case 'handle':
      return {
        ...binding.handle.writtenValues,
        ...omitKeys(binding.handle.resultData, binding.handle.writtenValues),
      };
    case 'resource':
      return { ...((binding.resource.data as Record<string, unknown> | undefined) ?? {}) };
    case 'callback':
      return { id: readCallbackField(binding, 'id'), url: readCallbackField(binding, 'url') };
    case 'value': {
      const held = bindingOf(binding.value);
      if (held !== undefined) return recordFields(held);
      if (isDictValue(binding.value)) return { ...binding.value };
      throw unsupported(`reading every field of ${describeHeldValue(binding.value)}`);
    }
    case 'sourcePosition':
    case 'event':
      // A system's record: its fields are read one by one through the adapter,
      // and nothing here says which ones it has.
      throw unsupported(
        `reading every field of ${describeBinding[binding.kind]}`,
        'a system record has no field list in hand — build a dict of the fields you want, `{ name: r.name, … }`',
      );
    case 'positions':
    case 'blockMeta':
    case 'lazyWalk':
    case 'tuple':
    case 'instance':
    case 'closure':
    case 'shape':
    case 'movement':
    case 'plugin':
    case 'opaque':
      throw unsupported(`reading every field of ${describeBinding[binding.kind]}`);
    default:
      return neverAsAny(binding);
  }
}

function omitKeys(
  from: Record<string, unknown> | undefined,
  keys: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(from ?? {}).filter(([k]) => !(k in keys)));
}

/** A field read against one accumulated meta-node binding. */
function readBindingField(
  binding: Binding,
  field: string,
  name: string,
): MovementEvalResult {
  switch (binding.kind) {
    case 'handle':
      return {
        value: readHandleField(binding.handle, field),
        provenance: handleFieldProvenance(binding.handle, field),
      };
    case 'extractPosition':
    case 'extractRoot':
      return readEmissionField(binding.emission, field);
    case 'value': {
      const value = binding.value;
      // A RECORD held on the value plane (`deck = FIRST(pages)`) reads as the
      // record it is — the dot-plane twin of a block head walking from one.
      const held = bindingOf(value);
      if (held !== undefined) return readBindingField(held, field, name);
      const projected =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? ((value as Record<string, unknown>)[field] ?? null)
          : null;
      // A field projected out of a plain value keeps the taint union
      // but isn't justified by the whole value's quote — drop `direct`.
      return {
        value: projected,
        provenance: transformed(binding.provenance ?? NO_PROVENANCE),
      };
    }
    case 'resource':
      return {
        value:
          (binding.resource.data as Record<string, unknown> | undefined)?.[field] ?? null,
        provenance: fromOrigin(resourceOrigin(binding.resource, field)),
      };
    case 'shapePosition':
      return readShapePositionField(binding, field);
    case 'nodePosition':
      return readNodePositionField(binding, field);
    case 'callback':
      return { value: readCallbackField(binding, field), provenance: NO_PROVENANCE };
    case 'positions':
      // One field across every returned landing — the ordinary many-position
      // collapse, so zero, one and many read the way a traversal reads.
      return collapse(binding.landings.map((b) => readBindingField(b, field, name)));
    case 'blockMeta': {
      // `r.done` reads a SCALAR binding by name (dot plane, asks-as-adapter
      // F13). The checker guarantees `field` is a value binding here (a node
      // binding is reached by arrow).
      const bucket = binding.edges.get(field) ?? [];
      const values = bucket.map((b) => (b.kind === 'value'
        ? { value: b.value, provenance: b.provenance ?? NO_PROVENANCE }
        : { value: null, provenance: NO_PROVENANCE }));
      // A FAN-OUT's value (layer 13 C2): the scalar accumulates one entry per
      // iteration and reads as an ARRAY — always, so zero and one iteration
      // read the same shape as many.
      if (binding.plural === true) {
        return {
          value: values.map((r) => r.value),
          provenance: unionProvenance(values.map((r) => r.provenance)),
        };
      }
      // A race receipt: an absent name (a branch that did not run) reads null
      // — `T | absent` at runtime. Union across branches collapses like any
      // multi-position read.
      if (values.length === 0) return { value: null, provenance: NO_PROVENANCE };
      return collapse(values);
    }
    default:
      throw unsupported(
        `reading '${field}' off ${describeBinding[binding.kind]} reached through '${name}'`,
      );
  }
}

/**
 * E1 reads on event/handle roots are direct field reads (`msg.`text``,
 * `co.externalId`) — no hop steps, no aggregation-as-position. Returns
 * the field name or raises the precise E2 pointer.
 */
function directFieldRead(
  expr: Extract<Expression, { type: 'traverse' }>,
  name: string,
  what: string,
): string {
  if (expr.steps.length > 0) {
    throw unsupported(`traversing from ${what} ('${name}')`, 'source/handle traversal is E2 scope');
  }
  const field = fieldTerminalId(expr.expression);
  if (field === undefined) {
    throw unsupported(`this read shape on ${what} ('${name}')`, 'only direct field reads run in E1');
  }
  if (field === POSITION_SENTINEL) {
    throw unsupported(`aggregating ${what} ('${name}') as a position`);
  }
  return field;
}

/**
 * Env-side write-handle resolution — the same order the TG engine's
 * `action_result` evaluator uses (specials → written values → the
 * adapter's result-data bag → null), but on the surface field names
 * (`externalId`, not the engine's snake_case special).
 */
function readHandleField(handle: WriteRecord, field: string): unknown {
  if (field === 'externalId') return handle.externalId ?? null;
  if (field === 'created') return handle.created;
  if (field === 'committed') return handle.committed;
  if (field in handle.writtenValues) return handle.writtenValues[field] ?? null;
  return handle.resultData?.[field] ?? null;
}

// ── Operator semantics (mirrored from engine/expression.ts) ────────────────

/**
 * The built-in scalar functions the movement engine evaluates — the frozen
 * engine's `BUILTIN_FUNCTION_NAMES`, mirrored (its module is frozen and the
 * set is private). All pure: same args, same value, no reads. Exported for
 * the static interpretability scan (interpretable.ts), which must agree
 * with this evaluator construct-for-construct.
 */
export const INTERPRETED_FUNCTIONS: ReadonlySet<string> = new Set(INTERPRETED_FUNCTION_IDS);

/**
 * Every function name this evaluator runs REGARDLESS of context: the
 * mirrored frozen built-ins, FILE() (the artifact built-in on the
 * render seam), and the namespaced stdlib (bridge-folded dotted ids).
 * The static interpretability scan (interpretable.ts) gates on this so
 * it agrees with the evaluator construct-for-construct; anything
 * outside it resolves only as a write-field adapter function.
 */
export function isMovementBuiltinFunction(fn: string): boolean {
  return (
    INTERPRETED_FUNCTIONS.has(fn) ||
    fn === FILE_FUNCTION_ID ||
    fn === READ_FUNCTION_ID ||
    fn === CHUNKS_FUNCTION_ID ||
    stdlibFunctionById(fn) !== undefined
  );
}

// Scalar comparison semantics (`compareValues`) and set equality now live in
// the shared, low-dependency filter unit (`#shared/expression/filter`) — one
// source of truth shared by the engine, the pure predicate evaluator, and
// adapters. Imported at the top of this module.
