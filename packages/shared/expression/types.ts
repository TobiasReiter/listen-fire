// Expression AST types — shared between web editor and API runtime.
// Single source of truth for the expression language and its supporting types.
//
// Config-level types (FieldMapping, PromptEmbed, OutputV3Config, etc.) stay in
// their respective apps because they have different optionality requirements.

// ── FieldRef: references a value on a node, edge, linked object, or trigger metadata ──

export type FieldRef =
  | { type: 'node_property'; propertyTypeId: string; old?: boolean }
  | { type: 'edge_property'; propertyTypeId: string; old?: boolean }
  | { type: 'linked_object'; adapter: string; actionNodeId: string; field: string }
  | { type: 'meta'; key: string }
  | { type: 'parent_result'; field: 'created' | 'external_id' };

// ── FilterOperator ──

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'exists'
  | 'in'
  // Recency: `field WITHIN 30d` — true iff the field's timestamp is at most
  // the given duration old. The right operand is a duration literal
  // (`30d`, `12h`, `1w`) carried as a `static` string. Evaluated by the
  // shared filter unit; needs the wall clock, so it is the one operator that
  // isn't a pure function of its operands.
  | 'within';

// ── The filter/order/limit capability — split across properties and edges ──
//
// What the movement language may ask of a connected source, answered live by
// the adapter from `describe()` (chunk 4 of the adapter-capability-contract
// plan). Two grains, because the facts genuinely live at two grains:
//
//   • PER-PROPERTY (`FieldCapability`) — whether the SOURCE SYSTEM can filter /
//     order by THIS field server-side, and with which operators. A fact about
//     the field, known when the adapter describes the type that owns it.
//   • PER-EDGE (`EdgeCapability`) — whether filter / order / limit can be
//     PUSHED ACROSS this relationship at all, and HOW:
//       - 'native'  ⇒ pushed to the provider's query API; the offerable fields
//                     are the target's per-property capability (`FieldCapability`);
//       - 'bounded' ⇒ the adapter knows the edge yields a small set and runs the
//                     shared filter unit over it — so ANY target field is
//                     filterable/orderable with the shared unit's operators,
//                     regardless of per-property server-side support.
//
// The consumer (checker / engine) combines the two: for a `native` edge it
// offers the target's filterable properties; for a `bounded` edge it offers all
// of them. Absent ⇒ unknown ⇒ gating degrades to silent best-effort, exactly
// like schema today. Operators are FilterOperator (incl. WITHIN).

/** How a pushable operation (filter / order) is satisfied across an edge. */
export type EdgePushMode = 'bounded' | 'native';

/** A field's own filter/order capability in the source system. */
export interface FieldCapability {
  /** Operators the source can filter this field by server-side. Absent or
   *  empty ⇒ not server-side filterable (still filterable across a `bounded`
   *  edge, via the shared unit). */
  filterOperators?: FilterOperator[];
  /** Whether the source can order by this field server-side. */
  orderable?: boolean;
}

/** Whether — and how — filter/order/limit push across one relationship. */
export interface EdgeCapability {
  /** How filter predicates are satisfied across this edge; absent ⇒ filtering
   *  can't be pushed here. */
  filter?: EdgePushMode;
  /** How ordering is satisfied across this edge; absent ⇒ ordering can't be
   *  pushed here. */
  order?: EdgePushMode;
  /** Whether a LIMIT can be applied to this edge's results. */
  supportsLimit: boolean;
  /**
   * The order the source ALREADY delivers this edge's records in, when that
   * order is one ORDER BY can name: sorted by one field of the landed record,
   * in one direction. Gmail's search answers newest first, so its `Messages`
   * edge delivers `Date` descending without being asked.
   *
   * It refines `order` rather than adding a second push mode: an ORDER BY that
   * names exactly this field and direction is satisfied AT THE SOURCE whatever
   * `order` says — no engine sort, and its LIMIT may bound the fetch — while
   * every other ORDER BY is satisfied the way `order` says. The checker's cost
   * note and the adapter's LIMIT pushdown both ask `isNaturalOrder`.
   *
   * `field` is the SURFACE name (what an ORDER BY writes and what
   * `GetRelatedInput.orderBy.fieldId` carries), because both consumers compare
   * against that. Declare it only where the provider documents the order or
   * the adapter sorts before returning — the same rule as `EdgeSequencing`,
   * which an edge declaring this should also carry.
   */
  naturalOrder?: NaturalOrder;
}

/** One field and one direction — the order an edge's records arrive in. */
export interface NaturalOrder {
  field: string;
  direction: 'asc' | 'desc';
}

// ── Inherent sequencing (a DIFFERENT fact from `EdgeCapability.order`) ──
//
// `EdgeCapability.order` answers "can an authored ORDER BY be pushed to the
// source?". `EdgeSequencing` answers "do this edge's members ALREADY arrive in
// a meaningful order, without anyone asking?". A Slack channel's messages are
// sequenced but their order is not pushable; an Attio company's people are
// order-pushable but carry no inherent sequence. The two are independent.
//
// This is what the set/list split reads: an edge with no declared sequencing
// yields a SET (order-sensitive folds refuse it), a sequenced edge yields a
// LIST. Absent ⇒ unordered, which is the safe default — an undeclared edge
// costs the author an explicit ORDER BY, a wrongly-declared one silently
// blesses a fold whose result is arbitrary.
//
// Declare it ONLY when the adapter's fetch path actually returns that order
// today (an explicit sort, an ORDER BY, or a provider call documented to
// return ordered results) — never because the domain sounds ordered.

/**
 * What an edge's members are inherently ordered BY, when they are ordered at
 * all. Named rather than boolean because the picture and the authoring surface
 * want to say WHICH order the author is getting.
 */
export type EdgeSequencing =
  /** Ordered by when the members happened — messages, calendar events, an
   *  activity feed. */
  | 'chronological'
  /** Ordered by their position in a source document — spreadsheet rows, a
   *  transcript's segments, a file's sections. */
  | 'document'
  /** Ordered by when each member LANDED here — ask responses, callback
   *  arrivals: nothing about the members is ordered, but the edge witnesses
   *  them one at a time and appends. */
  | 'arrival';

// ── TraversalStep ──

export interface EdgeStep {
  type: 'edge';
  edgeTypeId: string;
  direction: 'outgoing' | 'incoming';
  /**
   * Cypher-bracket alias binding (`-[name:Edge]->`). The walked
   * destination is bound to `alias` in the surrounding lexical scope
   * so descendants can refer to it by bare name (`name.property`) or
   * use it as a traversal root (`name-[:Other]->.field`). Optional —
   * anonymous walks remain valid.
   *
   * See `plans/2026-05-19-tg-extraction-parity/expression_syntax.md`
   * "Schema edges" and `mental_model.md` "Naming and scope".
   */
  alias?: string;
  cardinality?: {
    mode: 'all' | 'first' | 'n';
    limit?: number;
    /**
     * The ORDER BY key: an EXPRESSION over the element the hop lands on,
     * evaluated once per element before the sort. A bare property of the
     * landed record (`ORDER BY \`Added At\``) is the degenerate case and the
     * only one an adapter can be asked to sort by (`hopPushdown`); a short
     * path through the hop's own alias (`ORDER BY e-[:Signal]->.\`Discovered
     * At\``) is ordered by the engine.
     *
     */
    orderBy?: Expression;
    orderDirection?: 'asc' | 'desc';
  };
  filter?: FilterExpression;
  expressionFilter?: Expression;
}

export interface LinkBackStep {
  type: 'linkBack';
}

export interface ResourceStep {
  type: 'resource';
  filter?: ResourceFilter;
  cardinality?: {
    mode: 'all' | 'first' | 'n';
    limit?: number;
  };
}

/**
 * Meta-edge step: `-[alias:#extract { ... }]->`, `-[alias:#transform { ... }]->`,
 * or `-[alias:#resources WHERE ...]->`. Distinct from EdgeStep because
 * meta-edges don't walk a schema edge — they augment the source graph
 * (transform) or materialise ephemeral nodes (extract) at runtime.
 *
 * Configuration parameters travel in `config` (always a JSON-style object
 * inside the bracket) rather than as a WHERE filter, since meta-edges
 * have no genuine destination property surface to filter against.
 * `#resources` is the exception — it accepts a WHERE for filtering the
 * resource bundle.
 *
 * See `plans/2026-05-19-tg-extraction-parity/expression_syntax.md`
 * "Meta-edges".
 */
export interface MetaEdgeStep {
  type: 'meta_edge';
  metaEdge: 'extract' | 'transform' | 'resources';
  /** Optional alias binding (`-[name:#extract { ... }]->`). */
  alias?: string;
  /** Bracket-interior config object. Keys carried (per kind):
   *  - `extract`: `description: Expression`, `data: Expression[]`,
   *    `enrichWith: EnrichWithEntry[]` (entity-level enrichment, W5-D3)
   *  - `transform`: `plugin: Expression`, plus any other named params via `extra`
   *  - `resources`: legacy resource bundle — uses the existing
   *    ResourceFilter shape via `expressionFilter`, not config.
   */
  config?: {
    description?: Expression;
    data?: Expression[];
    plugin?: Expression;
    /**
     * W5-D3 — entity-level enrichment hooks. Each entry names a
     * registered transform and an `argument` expression resolved
     * per-emission against the just-extracted entity's properties.
     * Presence of `enrichWith` tells the framework to run the
     * extract → transform → re-extract cycle:
     *
     *   1. First-pass `#extract` produces N entities (schema includes
     *      every field referenced by `argument` expressions, even when
     *      not bound to downstream field-mappings).
     *   2. Per-emission: resolve each `argument` against the entity,
     *      invoke the named transform, capture its output.
     *   3. Second-pass `#extract` re-extracts with the original source
     *      PLUS each emission's enrichment outputs as additional
     *      context. Per-emission identity is preserved.
     *
     * See `plans/2026-05-19-tg-extraction-parity/_wave-3-stubs/W5-D3-entity-enrichment.md`.
     */
    enrichWith?: EnrichWithEntry[];
    /** Additional named parameters carried verbatim. */
    extra?: Record<string, Expression>;
  };
  /** For `#resources` only: parsed WHERE-clause expression. */
  expressionFilter?: Expression;
  /** For `#resources` only: structured filter (mirrors ResourceStep). */
  filter?: ResourceFilter;
}

/**
 * W5-D3 — one entity-level enrichment entry. The `transform` is the
 * registered transform's name (a string Expression — the common case
 * is `static`). The `argument` is an Expression resolved per-emission
 * against the just-extracted entity's properties (typically an
 * alias-rooted dot-chain like `person.linkedin_url`).
 *
 * Per-emission scope is implicit; the framework fires the transform
 * once per emission. The transform decides whether to no-op (returns
 * empty when its argument is missing).
 */
export interface EnrichWithEntry {
  /** Transform name. Almost always a `static` Expression. Accepts any
   *  Expression so authors can template names downstream if needed. */
  transform: Expression;
  /** Expression resolved against each emission's properties. The
   *  resolved value is fed to the transform as its input argument. */
  argument: Expression;
}

// W3-F5 — the dedicated `AliasFanoutStep` / `-[!alias]->` primitive was
// removed. `#extract` is a traversal by nature, and traversals yield N
// source positions per their description. An action whose traversal
// ends in `-[name:#extract { description: "each X" }]->` extracts N
// entities, yields N positions, and runs the field-mapping per
// emission. There is no second-step grammar.
//
// See plans/2026-05-19-tg-extraction-parity/_wave-3-stubs/W3-F5-extract-as-traversal.md.

export type TraversalStep =
  | EdgeStep
  | LinkBackStep
  | ResourceStep
  | MetaEdgeStep;

export interface ResourceFilter {
  resourceType?: 'URL' | 'EMAIL' | 'WHATSAPP' | 'FILE' | 'TEXT';
  hasDocument?: boolean;
  mimeType?: string;
  namePattern?: string;
}

// ── Selection ──

export interface Selection {
  mode: 'property' | 'edge_property' | 'llm' | 'static' | 'resource' | 'linked_object' | 'meta' | 'parent_result';
  propertyTypeId?: string;
  prompt?: string;
  value?: string;
  field?: string;
  adapter?: string;
  key?: string;
}

// ── Aggregation ──

export interface Aggregation {
  function: AggregationFunction;
  separator?: string;
  prompt?: string;
  orderBy?: FieldRef;
  orderDirection?: 'asc' | 'desc';
}

/**
 * Every native fold. `only` is the COMMUTATIVE singleton — "the one that
 * matched": zero yields nothing, one yields it, more than one fails the run.
 * It is what a lookup means, and unlike `first` it makes no order claim.
 *
 * `sort` is the odd one: it hands back the same members rather than reducing
 * them, in the order its key puts them. It sits here because it reads a
 * collection and carries a key, exactly as the folds do, and because the
 * ordering it produces is what the folds beside it demand.
 */
export type AggregationFunction =
  | 'first'
  | 'last'
  | 'only'
  | 'count'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'join'
  | 'collect'
  | 'sort'
  | 'llm';

/**
 * A fold's ALGEBRA — declared here, where the folds are, and read by the
 * checker's set/list discipline.
 *
 * `order-sensitive` means the answer changes when the elements are permuted,
 * so the fold needs a collection whose order MEANS something: an authored
 * `ORDER BY`, an edge the adapter declares inherently sequenced, or a value
 * collection that is a sequence by construction. `commutative` folds answer
 * the same over any permutation and accept either.
 *
 * `collect` is commutative because it does not reduce: it hands the members
 * back as they came, so an unordered input gives an unordered list and the
 * demand lands on whatever folds THAT. `llm` is commutative for the same
 * reason a summary of a set is a real thing to ask for — the model is given
 * members, not a sequence.
 */
export type FoldAlgebra = 'commutative' | 'order-sensitive';

export const FOLD_ALGEBRA: Record<AggregationFunction, FoldAlgebra> = {
  first: 'order-sensitive',
  last: 'order-sensitive',
  join: 'order-sensitive',
  only: 'commutative',
  count: 'commutative',
  sum: 'commutative',
  avg: 'commutative',
  min: 'commutative',
  max: 'commutative',
  collect: 'commutative',
  // `sort` does not READ the order it was given — it imposes one — so any
  // permutation of the same members sorts to the same answer.
  sort: 'commutative',
  llm: 'commutative',
};

// ── Filter ──

export type FilterExpression =
  | { $and: FilterExpression[] }
  | { $or: FilterExpression[] }
  | { $not: FilterExpression }
  | Record<string, unknown>;

// ── Expression AST ──

/**
 * `...xs` inside a list literal — `[a, ...xs, b]` splices `xs`'s members in
 * place, TypeScript's array spread — and `...m` inside an object literal —
 * `{ ...a, k: v, ...b }` copies `m`'s keys in place, TypeScript's object
 * spread. It is a literal's MEMBER, not a value: there is no spread anywhere
 * else in an expression, so it lives in the literals' member types rather than
 * among the expressions, where every walker would have to answer for one that
 * cannot occur.
 */
export interface ListSpread {
  type: 'spread';
  expression: Expression;
}

/** One member of a list literal: a value, or a spread of a collection's. */
export type ListElement = Expression | ListSpread;

/** The expression a list member is written with — the value itself, or the
 *  collection a spread splices in. For walkers that visit sub-expressions and
 *  have nothing to say about the splice. */
export function listElementExpression(element: ListElement): Expression {
  return element.type === 'spread' ? element.expression : element;
}

/** A list member rebuilt with `rewrite` applied to its expression — a spread
 *  stays a spread. For rewriters that carry the literal through unchanged. */
export function mapListElement(element: ListElement, rewrite: (expr: Expression) => Expression): ListElement {
  return element.type === 'spread' ? { type: 'spread', expression: rewrite(element.expression) } : rewrite(element);
}

/** One `key: value` pair of an object literal. */
export interface ObjectEntry {
  key: string;
  value: Expression;
}

/** One member of an object literal, in the order written: a `key: value` pair,
 *  or a spread of a map's keys (or a record's fields). A later member's key
 *  wins over an earlier one's, as in TypeScript. */
export type ObjectMember = ObjectEntry | ListSpread;

export function isObjectSpread(member: ObjectMember): member is ListSpread {
  return 'type' in member;
}

/** The expression an object member is written with — the pair's value, or
 *  what a spread copies from. For walkers with nothing to say about keys. */
export function objectMemberExpression(member: ObjectMember): Expression {
  return isObjectSpread(member) ? member.expression : member.value;
}

/** An object member rebuilt with `rewrite` applied to its expression. */
export function mapObjectMember(member: ObjectMember, rewrite: (expr: Expression) => Expression): ObjectMember {
  return isObjectSpread(member)
    ? { type: 'spread', expression: rewrite(member.expression) }
    : { ...member, value: rewrite(member.value) };
}

export type Expression =
  // Leaves
  /** `fieldOnly`: a hop's alias read from language version 5 (`m.email`),
   *  always the field of the record the hop lands on. Without it a name in a
   *  hop's WHERE is a variable when one is in scope, else the field (the
   *  reading versions 1–4 keep). A source given the filter reads both as the
   *  field, as it always has. */
  | { type: 'property'; propertyTypeId: string; fieldOnly?: true }
  | { type: 'edge_property'; propertyTypeId: string; fieldOnly?: true }
  | { type: 'static'; value: string | number | boolean | null }
  /**
   * `AI(prompt[, tier])` — how much thinking the answer is worth, in the
   * author's terms. See {@link AI_TIERS}. Carried VERBATIM as it was
   * written, unresolved: the closed set and the did-you-mean belong to the
   * checker, so a word nobody recognises has to REACH it. Dropping one here
   * would be exactly the silence this language refuses.
   */
  | { type: 'llm'; prompt: string; promptExpression?: Expression; tier?: string }
  | { type: 'meta'; key: string }
  | { type: 'parent_result'; field: 'created' | 'external_id' }
  /**
   * Read a previously-applied action's result — the write-handle currency
   * (`company = write crm-[:company]-> { … }`, then `company.`url``). `nodeId`
   * names the producing ActionNode; `field` is `'created'` /
   * `'external_id'` or a written-field / result-data name (the adapter's
   * `WriteResult.data` bag). Compiler-emitted (the movement compiler
   * lowers handle reads to it); serializer-led like `exists` — no parser
   * entry.
   */
  | { type: 'action_result'; nodeId: string; field: string }
  | { type: 'resource'; field: 'name' | 'url' | 'type' | 'document_url' | 'content' | 'contentType' }
  | { type: 'linked_object'; adapter: string; field: string }
  // TG-parity leaves
  /**
   * LLM-scalar extraction sub-prompt: `EXTRACT_VALUE("description")`.
   * Type / enum options are inferred from the surrounding expression
   * field context at execution time. Only valid inside an ancestral
   * `#extract` meta-edge — `validateTgExpression` enforces this.
   *
   * See `plans/2026-05-19-tg-extraction-parity/expression_syntax.md`
   * "EXTRACT_VALUE".
   */
  | { type: 'extract_value'; description: string }
  /**
   * Bare-name reference to an alias bound by an ancestor cypher bracket
   * (`-[name:Edge]->` / `-[name:#extract { ... }]->`) or by a trigger
   * binding (`trigger: slack_message AS msg`). Leaf only — dot-chains
   * (`opp.company`) and alias-rooted walks (`msg-[:Author]->.email`)
   * use `traverse { aliasRoot, ... }` instead.
   *
   * See `expression_syntax.md` "Name scope".
   */
  | { type: 'alias_ref'; name: string }
  /**
   * Set literal — `data: [a, b, c]`. Used inside meta-edge config
   * objects (notably `#extract`'s `data:` parameter). Order is not
   * significant per the syntax spec, but preserved here so the
   * serializer can round-trip stably.
   */
  | { type: 'list'; elements: ListElement[] }
  /**
   * Object literal — `{ key: <expr>, … }`. Keys are the verbatim keys of
   * the structured value being assembled (an API's own spelling: Slack
   * Block Kit's `snake_case`, a REST body's `camelCase`), so they are
   * carried as authored — never resolved as property names. Written bare
   * when identifier-safe, quoted otherwise (`{ "content-type": … }`).
   * Entry order is the author's and is preserved so the serializer
   * round-trips stably.
   */
  | { type: 'object'; entries: ObjectMember[] }
  // Traversal
  /**
   * `traverse.aliasRoot`: when present, traversal starts from the
   * named alias's bound position rather than the surrounding context
   * (today's behaviour when absent). Parser dispatch:
   *   - bare ident followed by `.` or `-[` → `traverse` with
   *     `aliasRoot` set; the steps may be empty (dot-chain like
   *     `opp.company`) or non-empty (alias-rooted walk like
   *     `msg-[:Author]->.email`).
   *   - bare ident with no continuation → `alias_ref { name }`.
   *
   * Resolution is deferred to the evaluator (R1) — the parser binds
   * the name; the evaluator walks the lexical-scope stack to find the
   * matching alias binding.
   */
  | { type: 'traverse'; aliasRoot?: string; steps: TraversalStep[]; expression: Expression }
  // `filter` is the LEGACY structured form — stored output_v3 ASTs carry it
  // and the KG SQL loader pushes it down. The parser now emits
  // `expressionFilter`: the hop's WHERE as a real Expression over resource
  // fields, evaluated per resource — the same currency as every other hop.
  | { type: 'resource_traverse'; filter?: ResourceFilter; expressionFilter?: Expression; expression: Expression }
  // Quantifier — true iff the traversal yields at least one position
  // satisfying `where` (or any position when `where` is absent). Adapter-
  // uniform: lets predicates like "is in list X" fall out as
  // `EXISTS(-[list_membership where list.name = 'X']->)` without needing
  // adapter-specific canned predicates.
  | { type: 'exists'; steps: TraversalStep[]; where?: Expression }
  // Operations
  | { type: 'arithmetic'; op: '+' | '-' | '*' | '/' | '%'; left: Expression; right: Expression }
  | { type: 'compare'; op: FilterOperator; left: Expression; right: Expression }
  | { type: 'logical'; op: 'and' | 'or'; operands: Expression[] }
  | { type: 'not'; expression: Expression }
  // Unary minus (`-x`) — a distinct node from binary `-` (arity, not a
  // sentinel-zero subtraction): mirrors `not` as the other unary operator.
  | { type: 'negate'; expression: Expression }
  | { type: 'concat'; parts: Expression[] }
  | { type: 'conditional'; condition: Expression; then: Expression; else: Expression }
  // Array indexing — extracts a single element from a multi-cardinality value.
  // `index` is evaluated to a number; negative indices count from the end
  // (Cypher-compatible). Out-of-bounds returns null. If the source value is
  // not an array, returns it as-is when index === 0, else null.
  | { type: 'at'; expression: Expression; index: Expression }
  // Aggregation
  // `orderBy` is `SORT`'s key — an expression over the ELEMENT, evaluated once
  // per member before the sort (absent = order the members by their own
  // value).
  | { type: 'aggregate'; fn: Aggregation['function']; expression: Expression; separator?: string; prompt?: string; orderBy?: Expression; orderDirection?: 'asc' | 'desc' }
  // Functions
  | { type: 'function'; fn: string; args: Expression[] }
  // Knowledge graph queries — params are positional ($0, $1, ...) and resolved
  // against the surrounding source context. Both forms are read-only; mutations
  // are rejected at save time.
  | { type: 'kg_exists'; query: string; params: Expression[] }
  | { type: 'kg_value'; query: string; params: Expression[] };

/**
 * Expression kinds that are valid on EVERY source, regardless of what
 * the adapter advertises in its `expressionKinds` capability list.
 *
 * `llm` (`AI(...)`) is a framework-level primitive — a Haiku call that
 * maps text → text with its argument as the prompt. It transforms or
 * judges a structured value the author already holds; it does not
 * depend on any adapter capability. So the per-adapter capability gate
 * must NOT reject it. (Contrast `extract_value`, which IS contextual —
 * granted only under an ancestral `#extract` meta-edge.)
 *
 * Both the authoring-time capability gate (translation_agent's
 * `validateExpressionTree`) and the runtime evaluator
 * (`engine/expression.ts`) consult this set so the two never disagree.
 *
 */
export const UNIVERSAL_EXPRESSION_KINDS: ReadonlySet<Expression['type']> = new Set<Expression['type']>(['llm']);

// ── Tiers — how much thinking a call is worth ───────────────────────────────
//
// `AI(prompt, "thorough")` and `extract "quick" from […]` share ONE
// vocabulary, written in the AUTHOR's terms: what the job is worth, not who
// answers it. Which model that reaches, how hard it is asked to think, and how
// long its answer may run are the PLATFORM's to decide — so they can be
// retuned, or moved to another provider entirely, without the language
// changing a word. A tier is the whole of what an author may say about it;
// there is no escape hatch onto a model name, and that is the point.

/** The tiers, in ascending cost. Closed set: the checker owns the miss. */
export const AI_TIERS = ['quick', 'careful', 'thorough'] as const;
export type AiTier = (typeof AI_TIERS)[number];

/**
 * How hard a model is asked to think, in ascending depth — an extraction
 * call's `effort` override (`extract(content, Shape, { effort: 'high' })`).
 * One list: the checker refuses a word outside it and the platform's tier
 * table (`ai_tiers.ts`) is typed by it.
 */
export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

/** Spellings that predate the tiers — still accepted, taught nowhere, and
 *  nudged toward the tier that means the same thing. `"smart"` asked for the
 *  mid model, which is what `careful` asks for. */
export const AI_TIER_ALIASES: ReadonlyMap<string, AiTier> = new Map<string, AiTier>([
  ['smart', 'careful'],
]);

/**
 * The tier a written word means, following the legacy spellings. `undefined`
 * for a word that means none of them — the checker's to report with a
 * did-you-mean, and the evaluator's to ignore in favour of the platform
 * default (a saved program has already passed the checker).
 */
export function aiTier(written: string | undefined): AiTier | undefined {
  if (written === undefined) return undefined;
  const named = AI_TIERS.find(tier => tier === written);
  return named ?? AI_TIER_ALIASES.get(written);
}
