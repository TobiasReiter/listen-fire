// AST for the data-movement language statement layer.
// Spec: plans/2026-06-10-data-movement-language/ (3_syntax_sketch.md is the surface).
//
// Value expressions are NOT parsed here: every expression position is captured as a
// raw source span (ExprSlot) and read through expression/bridge.ts, which parses it
// with the expression grammar (parser/expression) and lowers it to the shared formula
// `Expression`. The statement layer owns only the
// constructs the language adds: import, assignment, construction, shape, extract,
// movement, listen (the one invoker), write (root + linked + tuple),
// traversal-headed block, link, if, parallel, call.

import type { EdgeSequencing } from '@listen-fire/shared/expression/types';

import { neverAsAny } from '../never';
import { scanMemberPath } from './scan';

export interface Loc {
  line: number; // 1-based
  col: number; // 1-based
}

export interface Span {
  start: Loc;
  end: Loc;
}

/** A value-expression position, captured verbatim. Read it through
 *  `expressionOfSlot` / `conditionOfSlot` (expression/bridge.ts), which parse
 *  its text once and keep the tree beside the slot. */
export interface ExprSlot {
  raw: string;
  span: Span;
}

// ── Names and references ──

/**
 * `<inbox-[:message]->>`, `<crm>` (meta position / self-entry shape),
 * `<number>`. Types ALWAYS wear angle brackets at the surface — the universal
 * type marker (3_syntax_sketch.md, 2026-06-11) — but the AST stores the
 * unbracketed spelling; brackets are surface syntax only.
 */
export interface TypeRef {
  graph: string;
  /**
   * The bare position name an UNPINNED single-hop address lands on —
   * `<kg-[:company]->>` stores `position: 'company'`, derived by the parser
   * from `hopsRaw` (the same judgement `eventAddressKey` makes: no pins ⇒ the
   * bare name). A pinned address (a WHERE) narrows below any one name, so it
   * leaves `position` unset. Never set without `hopsRaw`: the dotted
   * `<graph.position>` spelling is RETIRED — `.` reads a property, an edge is
   * an address — and parse-errors with the exact address replacement.
   *
   */
  position?: string;
  /**
   * The ADDRESS form's hop chain — `<at-[:`Record Change` WHERE `table` ==
   * "tblDeals"]->>` stores `graph: 'at'` and `hopsRaw: '-[:`Record Change`
   * WHERE `table` == "tblDeals"]->'`.
   *
   * A type annotation is an ADDRESS. The dotted form flattened a walk into a
   * name, which has nowhere to put a WHERE — and an event edge and a position
   * type shared one namespace under it, so `<crm.Event>` could not say which
   * it meant.
   *
   */
  hopsRaw?: string;
  span: Span;
}

/**
 * Where a traversal head starts.
 *
 * A NAME is the common case — a binding the hops walk off. An EXPRESSION is any
 * value expression that ends at a record or a list of them (`AT(rows, 0)`,
 * `ONLY(found-[c:company]->)`, `r.a`): it is evaluated once at the head and
 * hopped off exactly as a name bound to the same value is, so
 * `first = AT(rows, 0)` … `first-[c:company]->` and `AT(rows, 0)-[c:company]->`
 * are ONE walk with one meaning.
 *
 * The expression is captured as a RAW SLOT, like every other expression
 * position in this tree — the statement layer parses no expressions.
 */
export type PathRoot =
  | { kind: 'name'; name: string }
  | { kind: 'expression'; expr: ExprSlot };

/** A traversal head: optional root (a name or an expression) + raw hop chain. */
export interface PathHead {
  root?: PathRoot;
  /** e.g. `-[c:companies]->` or `-[c:companies]->-[d:deals]->`; empty string is invalid. */
  hopsRaw: string;
  span: Span;
}

/**
 * The head's root as a NAME, where it IS one. An expression root has no name,
 * and every site that resolves the root in scope or keys an identity on it
 * reads `undefined` here rather than a name the head cannot have — the reason
 * the root is a union and not a string.
 */
export function pathRootName(head: Pick<PathHead, 'root'>): string | undefined {
  return head.root?.kind === 'name' ? head.root.name : undefined;
}

/**
 * Every root a write or match target starts from, each replaced by what `bind`
 * makes of it — the one walk over the three target forms, so a rule about a
 * target's roots is written once.
 */
export function mapTargetRoots(target: MatchTarget, bind: (root: PathRoot) => PathRoot): MatchTarget;
export function mapTargetRoots(target: WriteTarget, bind: (root: PathRoot) => PathRoot): WriteTarget;
export function mapTargetRoots(target: WriteTarget, bind: (root: PathRoot) => PathRoot): WriteTarget {
  const head = (path: PathHead): PathHead => (path.root === undefined ? path : { ...path, root: bind(path.root) });
  switch (target.kind) {
    case 'position':
      return { ...target, root: bind(target.root) };
    case 'linked':
      return { ...target, path: head(target.path) };
    case 'tuple':
      return { ...target, paths: target.paths.map(head) };
    default:
      return neverAsAny(target);
  }
}

/**
 * The name a write's MEMBER-PATH root is bound to for the write's own scope
 * (`write m.k { … }` is `x = m.k` then `write x { … }`, with `x` spelled
 * `m.k`, so a diagnostic about the record names the path the author wrote).
 * `undefined` for a root that is not one member path — the parser lets no
 * other expression start a write.
 */
export function memberPathBindingName(expr: ExprSlot): string | undefined {
  const raw = expr.raw.trim();
  const path = scanMemberPath(raw, 0);
  return path !== null && path.end === raw.length ? path.names.join('.') : undefined;
}

// ── Top-level program ──

export interface Program {
  statements: Statement[];
}

export type Statement =
  | ImportStatement
  | AssignStatement
  | ShapeDeclaration
  | TypeDeclaration
  | MovementDeclaration
  | ListenDeclaration
  | WriteStatement
  | MatchStatement
  | CallStatement
  | BlockStatement
  | LinkStatement
  | UnlinkStatement
  | DeleteStatement
  | RefreshStatement
  | IfStatement
  | AwaitStatement
  | CombinatorStatement
  | CollectionStatement
  | ReturnStatement
  | ErrorStatement;

/**
 * `return <value>` — the one way a body hands a value back.
 *
 * What it returns is an ordinary right-hand side: whatever can be BOUND to a
 * name can be returned, and nothing else exists to return. A body with no
 * `return` hands nothing back (it ran for its effects), so there is no bare
 * `return` — the absence of the statement already says that.
 *
 * The nearest enclosing body is what it returns FROM: a movement/function, a
 * traversal-headed block (once per iteration), or a closure. An `if` arm is
 * transparent, exactly as it is in TypeScript.
 */
export interface ReturnStatement {
  kind: 'return';
  value: RValue;
  span: Span;
}

// ── Imports ──

export type ImportSource =
  | { kind: 'builtin'; namespace: 'adapters' | 'credentials' | 'plugins' }
  | { kind: 'file'; path: string };

/** One entry of an import list: `name` or `name as alias`. */
export interface ImportedName {
  /** The name in the source namespace/file — what catalog resolution keys on. */
  name: string;
  /** Optional local rebinding (`import { acme_main as crm_creds }`) — when present, the in-scope name. */
  alias?: string;
}

export interface ImportStatement {
  kind: 'import';
  names: ImportedName[];
  source: ImportSource;
  span: Span;
}

// ── Assignment (the one binding form) ──

export interface AssignStatement {
  kind: 'assign';
  name: string;
  value: RValue;
  span: Span;
}

export type RValue =
  | { kind: 'construct'; construct: ConstructionCall }
  /**
   * `doc = email_to_doc(d: node { … })` — a bound CALL the parser could tell
   * apart from a construction, because an argument took a form only a call
   * accepts (a `node { … }`, an inline write). Where every argument is a plain
   * value the two forms are identical and the parser records the `construct`
   * above instead, leaving the decision to resolution (`constructionAsCall`).
   * Both routes reach the same check and the same execution.
   */
  | { kind: 'call'; call: CallStatement }
  | { kind: 'write'; write: WriteExpression }
  | { kind: 'match'; match: MatchExpression }
  /** `x = link p-[:e]-> { … }` — only the body form binds: the handle is the
   *  record its match found. */
  | { kind: 'link'; link: FindingLink }
  | { kind: 'extract'; extract: ExtractExpression }
  /** `companies = extract(content, Company, { tier: 'careful' })` — the
   *  extraction CALL (language version 3 on). */
  | { kind: 'extractCall'; extractCall: ExtractCallExpression }
  | { kind: 'block'; block: TraversalBlock }
  | { kind: 'await'; await: AwaitExpression }
  /** `race([f, g])` / `parallel([f, g])` written WITHOUT `await` — a
   *  combinator composes a wait; `await` is what parks, so the checker refuses
   *  this with the rewrite. Parsed so the refusal can name it. */
  | { kind: 'combinator'; combinator: CombinatorExpression }
  /** `MAP(xs, f)` and its siblings — iteration over a value collection. */
  | { kind: 'collection'; collection: CollectionOpExpression }
  /** `MEMBERS(<Thesis>)` — a closed type's values, in declaration order. */
  | { kind: 'members'; members: MembersExpression }
  | { kind: 'inlineBlock'; inlineBlock: InlineBlockExpression }
  | { kind: 'callback'; callback: CallbackExpression }
  /** `(d: <date>) => { … }` / `() => { … }` — an anonymous closure. */
  | { kind: 'closure'; closure: ClosureExpression }
  | { kind: 'node'; node: NodeLiteral }
  | { kind: 'lazy'; lazy: LazyTraversal }
  | { kind: 'expr'; expr: ExprSlot };

/**
 * `lazy m-[a:Attachments]->` — a traversal whose WALK is deferred to the read.
 *
 * `await`'s dual, in the same syntactic slot and over the same `PathHead`:
 * `await` waits for the edge to exist, `lazy` waits to look at all. It changes
 * WHEN the walk runs, never what it yields — the type is the eager traversal's,
 * and every read re-walks the live source (no caching; layer 8 ruling 3).
 *
 */
export interface LazyTraversal {
  head: PathHead;
  /** `-> node { … }` — PER-ITEM synthesis: each landing is bound (by the hop's
   *  alias) and mapped through this literal, so what the walk yields is the
   *  renamed view rather than the source's own positions. See `NodeEntry`. */
  mapping?: NodeLiteral;
  span: Span;
}

/** `attio(credentials: acme_main, list: "Dealflow")` — an adapter type called with config. */
export interface ConstructionCall {
  callee: string;
  args: NamedArg[];
  span: Span;
}

/**
 * A value-position `f(a: x)` read as the CALL it is when `f` resolves to a
 * movement rather than an adapter type.
 *
 * The two are ONE surface form — `name(named: args)` — and nothing lexical
 * separates them, so the parser records the shape and resolution decides the
 * meaning. This is the projection both deciders share, so the checker and the
 * engine cannot disagree about what such a call's arguments are.
 *
 */
export function constructionAsCall(construct: ConstructionCall): CallStatement {
  return {
    kind: 'call',
    callee: construct.callee,
    args: construct.args.map((arg) => ({ kind: 'expr', name: arg.name, expr: arg.value })),
    span: construct.span,
  };
}

export interface NamedArg {
  name: string;
  value: ExprSlot;
  /**
   * The value is a TYPE reference, not an expression — `type: <company>`
   * in a kg listen's config. Types always wear angle brackets at the
   * surface (the universal type marker); the AST stores the unbracketed
   * spelling in `value.raw`, with `value.span` covering the `<…>`.
   * Listen-config only: constructions, plugin calls and run args never
   * carry type values.
   */
  isType?: boolean;
}

// ── Writes ──

export type WriteTarget =
  /**
   * `write crm-[:company]-> { … }` — the linked write mints the record and the
   * edge that reaches it in one move. Optionally `…-><company> { … }` names the
   * written type for polymorphic edges.
   */
  | { kind: 'linked'; path: PathHead; explicitType?: string; span: Span }
  /**
   * `write (company-[:investments]->, investor-[:investments]->) { … }` —
   * a tuple-path multi-parent write: ONE create at the convergence of N
   * parent edges. Each path is a linked-write path (a typed root handle
   * plus one declared edge); the written type is inferred from the edges
   * and must agree across paths. `explicitType` names it for polymorphic
   * edges, like linked writes.
   */
  | { kind: 'tuple'; paths: PathHead[]; explicitType?: string; span: Span }
  /**
   * `write a { … }` — update IN PLACE the record at the bound position
   * `a` (a traversal alias or a prior write result), or the one a member path
   * holds (`write m.k { … }`). No creation, no identity resolution: you
   * already have the exact record. Valid only when it is a stable record and
   * its adapter supports updates.
   */
  | { kind: 'position'; root: PathRoot; span: Span };

export interface WriteExpression {
  target: WriteTarget;
  uniqueBy: UniqueClause[];
  fields: FieldEntry[];
  /** `...e` / `?...e` entries, in source order — see {@link WriteSpread}. */
  spreads?: WriteSpread[];
  /**
   * `bind <name>` between the write target and the body — "this written
   * record IS the counterpart of `<name>`." Declares an engine-owned,
   * symmetric correspondence (binding) between the written position and
   * the bound record's position, across any pair of systems. The engine
   * owns the binding's storage, lifecycle, and id-based matching; the
   * adapter stays correspondence-agnostic. A bound write IGNORES `unique
   * by` (the binding IS the identity) and takes at most ONE bind
   * (compound binding deferred). Absent on writes that declare no
   * correspondence.
   *
   * DEPRECATED pending review (2026-06-23): the engine-owned, durable
   * correspondence state conflicts with the language's stateless-function /
   * derived-identity model. Undocumented on purpose; not surfaced as a
   * recommended construct. Parse/check/engine paths remain intact (no real
   * movement uses it) until the review decides removal vs a declarative
   * replacement. See plans/2026-06-23-deprecate-bind-pending-review/0_mission.md.
   *
   */
  bind?: BindClause;
  span: Span;
}

/** `bind other` — the bound counterpart record's name, captured with its
 *  span for diagnostics. The name must resolve (in the checker) to a
 *  stable record position. */
export interface BindClause {
  name: string;
  span: Span;
}

/** A write used as a statement without binding its handle. */
export interface WriteStatement {
  kind: 'write';
  write: WriteExpression;
  span: Span;
}

/**
 * Where a `match` looks: a hop from a handle, a root collection, or the tuple
 * of parent paths — everything a `write` addresses except a bare position,
 * which is a record already in hand and so has nothing left to find.
 */
export type MatchTarget = Extract<WriteTarget, { kind: 'linked' | 'tuple' }>;

/**
 * `existing = match crm-[:companies]-> { unique by (FUZZY \`name\`), name: n }`
 * — the identity half of a write, on its own: resolve candidates by the
 * `unique by` clauses (OR across clauses) and arbitrate, then bind the record
 * found. It never creates and never writes. On a miss the ENCLOSING SCOPE ends
 * quietly, so inside the scope the handle is always a real record.
 *
 * The body's fields are ASSERTIONS — the values identity compares against and
 * the judge reads — so they take `:` only; there is nothing to fill or append.
 */
export interface MatchExpression {
  target: MatchTarget;
  uniqueBy: UniqueClause[];
  fields: FieldEntry[];
  span: Span;
}

/** A match used as a statement: a gate — the rest of the scope runs only when
 *  the record exists. */
export interface MatchStatement {
  kind: 'match';
  match: MatchExpression;
  span: Span;
}

/**
 * Per-field write-precedence — the rule the engine applies when a field already
 * has a value. Absent = `replace` (plain `name: expr`). The merge is computed in
 * the engine against the target's current value (read via `readRecord`); the
 * adapter always writes a single final value.
 *
 *   - `'fill'`           — `name ?: expr`  — write only when the current value
 *                          is empty (null/undefined/empty list). Single or multi.
 *   - `'append'`         — `name +: expr`  — multi-value only: current ++ expr
 *                          (duplicates allowed).
 *   - `'append-missing'` — `name +?: expr` — multi-value only: append only the
 *                          elements of expr not already present (set union).
 *
 * On a CREATE all modes collapse to a plain set (there is no current value).
 */
export type FieldWriteMode = 'fill' | 'append' | 'append-missing';

export interface FieldEntry {
  name: string;
  value: ExprSlot;
  /** Write-precedence operator; absent ⇒ `replace`. See {@link FieldWriteMode}. */
  semantics?: FieldWriteMode;
  /** The record a `...` spread wrote this line from — absent on a written line. */
  spread?: string;
  span: Span;
}

/**
 * `...e` — write every FIELD of `e` as a plain assignment; `?...e` — write each
 * one set-if-empty (the `?:` modifier applied to each). Fields only: `e`'s
 * nested nodes are edges, and an edge is its own write. An explicit line for a
 * field wins over a spread's value for it, and a later spread over an earlier.
 *
 * The parser cannot know `e`'s fields, so a spread stays a spread here and
 * {@link expandWriteSpreads} turns it into ordinary field lines where the
 * fields ARE known: the checker resolves them from `e`'s type and records them
 * on the spread (`fields`), and the engine expands from that record.
 */
/**
 * `...m.k` — a spread whose record is held under a key of a map: the bound
 * name, then the keys read off it, in order. Present only for such a path;
 * `source` then spells the path as written.
 */
export interface SpreadPath {
  root: string;
  members: string[];
}

/** A spread's source as source text: the path as written, or the name. */
export function spreadSourceText(spread: { source: string; path?: SpreadPath }): string {
  return spread.path !== undefined ? spread.source : spellName(spread.source);
}

export interface WriteSpread {
  /** The spread record's bound name — or, for a member path, the path as
   *  written (`path` then says what it reads). */
  source: string;
  path?: SpreadPath;
  /** `?...` ⇒ `'fill'`; absent ⇒ a plain assignment. */
  semantics?: 'fill';
  /**
   * The fields this spread writes, as the CHECKER resolved them from the
   * source's type — the one list both sides use. The engine cannot recover it
   * from the value: a `<Deal>` parameter may be handed a record carrying more
   * than `Deal` declares. Absent until the program is checked; the engine
   * refuses a spread nobody resolved.
   */
  fields?: readonly string[];
  span: Span;
}

/**
 * A write body with its spreads written out as the field lines they stand for:
 * `...e` becomes `f: e.f` for every field `f` of `e` that no explicit line (and
 * no later spread) already writes. `fieldsOf` answers a spread's fields, or
 * `undefined` when they are unknown — that spread then contributes nothing, and
 * saying why is the caller's job.
 */
export function expandWriteSpreads(
  write: { fields: FieldEntry[]; spreads?: WriteSpread[] },
  fieldsOf: (spread: WriteSpread) => readonly string[] | undefined,
): FieldEntry[] {
  const spreads = write.spreads ?? [];
  if (spreads.length === 0) return write.fields;
  const written = new Set(write.fields.map((f) => f.name));
  const expanded: FieldEntry[] = [];
  for (let i = spreads.length - 1; i >= 0; i--) {
    const spread = spreads[i];
    const lines: FieldEntry[] = [];
    for (const name of fieldsOf(spread) ?? []) {
      if (written.has(name)) continue;
      written.add(name);
      lines.push({
        name,
        value: { raw: `${spreadSourceText(spread)}.${spellName(name)}`, span: spread.span },
        ...(spread.semantics !== undefined ? { semantics: spread.semantics } : {}),
        spread: spread.source,
        span: spread.span,
      });
    }
    expanded.unshift(...lines);
  }
  return [...write.fields, ...expanded];
}

/**
 * One `unique by (…)` clause — a predicate that finds the existing record this
 * write should resolve onto. The predicate is a full expression, captured as a
 * raw slot and bridged like any other: `\`email\`` (bare field → "the same
 * email as the one being written"), `\`stage\` == "Open" AND \`updated\`
 * WITHIN 30d`, a bound parent handle (edge-scoped identity), or any
 * combination. Repeated clauses are OR-ed.
 */
export interface UniqueClause {
  predicate: ExprSlot;
  span: Span;
}

// ── Node literals (in-memory node synthesis) ──

/**
 * `node { title: m.`Subject`, company: node { name: … } }` — an in-memory
 * position synthesised from a literal, and the language's composition
 * currency: it belongs to no graph, so it is typed STRUCTURALLY from what
 * the literal writes.
 *
 * It sits on the POSITION plane, not the value plane — like `write`, and
 * unlike anything the expression grammar parses. So it appears exactly
 * where a position is spelled out: bound to a name (`d = node { … }`), as
 * a call argument (`process(d: node { … })`), and as an entry of another
 * literal.
 *
 */
export interface NodeLiteral {
  entries: NodeEntry[];
  /** Present when the literal was written `graph<Shape> { … }` / `graph { … }`,
   *  and on every body nested inside one. See {@link GraphForm}. */
  graph?: GraphForm;
  /** A graph body's `...v` entries, in source order — see {@link MapSpread}. */
  spreads?: MapSpread[];
  span: Span;
}

/**
 * `graph<Message> { text: m.Body, attachment: m-[a:Attachments]-> { … } }` — a
 * LOCAL GRAPH built as a value. In the modern spelling `node` only declares a
 * shape and `graph` only builds a value; the anonymous `node { … }` literal
 * stays as it was.
 *
 * It is the node literal's own structure with two differences, both carried by
 * this marker rather than by a second AST:
 *
 *   - `shape` checks the body against a declared node the way TypeScript's
 *     `satisfies` checks an object literal (a misspelt or mistyped field is
 *     refused, a required field may not be missing), and the value is then of
 *     that shape. Only the outermost body carries it; a nested body takes the
 *     child node of the same name from its parent's shape.
 *   - entries follow TypeScript's object semantics. A bare walk
 *     (`attachment: m-[:Attachments]->`) or a record (`owner: r`) holds
 *     REFERENCES to the records, as `{ items: obj }` does: reads are live, and
 *     a write, link or delete through one acts on the real record. A walk
 *     followed by a field body builds one child per record and a record spread
 *     copies one (see `CopyPlan`) — those are the snapshots, as `{ ...obj }` is.
 */
export interface GraphForm {
  shape?: { name: string; span: Span };
}

/**
 * What a record spread in a graph literal (`...r`) copies from the record:
 * these fields, and through each named edge, the records there — copied by the
 * nested plan. The CHECKER resolves it (from the shape when there is one, from
 * the record's own fields otherwise) and records it on the spread; the engine
 * copies exactly this and refuses a spread nobody resolved, because a system's
 * record has no field list in hand at run time.
 */
export interface CopyPlan {
  fields: readonly string[];
  edges: Readonly<Record<string, CopyPlan>>;
}

/**
 * One entry of a node literal. Ruling 1: the entry expression's KIND decides
 * what it declares — no marker syntax. A VALUE is a field (the dot plane); one
 * or more nested literals are an EDGE (the arrow plane), a single literal
 * declaring an edge with one synthesised landing and a list declaring a plural
 * one (ruling 5).
 */
export type NodeEntry =
  /** `title: m.`Subject`` — a field. */
  | {
      kind: 'value';
      name: string;
      value: ExprSlot;
      /** In a graph literal, the value is a RECORD (`owner: r`,
       *  `owner: ONLY(m-[:Owner]->)`), so the entry is an edge holding a
       *  reference to it rather than a field. Set by the checker, which is
       *  the one place that knows what the name is bound to. */
      reference?: true;
      span: Span;
    }
  /** `company: node { … }` / `files: [node { … }, node { … }]` — an edge whose
   *  landings are synthesised here. `nodes` holds them in source order; one
   *  entry is the single-landing form. */
  | { kind: 'nodes'; name: string; nodes: NodeLiteral[]; span: Span }
  /**
   * `files: m-[a:Attachments]->` / `files: lazy m-[a:Attachments]->` — a
   * PASS-THROUGH edge: its landings are the walked source's REAL positions,
   * carrying their own field names and their own values (a FileRef included)
   * with nothing copied in between.
   *
   * With a `mapping` (`-> node { name: a.`Name`, blob: a.`File` }`) the edge is
   * PER-ITEM synthesised instead: every landing is bound to the hop's alias and
   * mapped through the nested literal, so the callee sees the names the mapping
   * chose and never couples to the source's. The values still come from the
   * real source — the wrapper is renaming, not copying.
   *
   * `lazy` is the same modifier the RValue takes (`LazyTraversal`) and means
   * the same thing here: eager walks (and synthesises) where the literal is
   * written, lazy walks and synthesises at every read.
   */
  /**
   * `messages: <slack-[:Channels]->-[:Messages]->>` — an edge DECLARED and
   * EMPTY. The value is an address type marker, the same one a movement
   * parameter accepts, and it says what the landings will BE; `link` appends
   * them as the run goes.
   *
   * `order by arrival` after the marker is the author saying the landings keep
   * an order, so order-sensitive folds over the edge are answering a real
   * question. Absent ⇒ a SET, exactly as an undeclared adapter edge is.
   */
  | { kind: 'declared'; name: string; type: TypeRef; sequenced?: EdgeSequencing; span: Span }
  | {
      kind: 'traversal';
      name: string;
      head: PathHead;
      lazy: boolean;
      mapping?: NodeLiteral;
      span: Span;
    };

/**
 * `...v` in a graph literal — a computed MAP (plugin output, JSON, a dict)
 * converted into the graph: each key a field, and a nested map (or a list of
 * them) a child node. With a shape, the shape decides which keys are children;
 * without one, every nested map is. From language version 3 it is
 * TypeScript's object spread: members take effect in the order written, a
 * later one winning, and a key written before a spread that always supplies
 * it is refused. Before version 3 a written entry won over a spread's key
 * wherever it stood, and a later spread over an earlier one.
 *
 * `v` may instead be ONE RECORD, whose fields are copied as a snapshot by
 * its `CopyPlan` — TypeScript's `{ ...obj }`. A value that is absent copies
 * nothing.
 */
export interface MapSpread {
  /** The map's (or the record's) bound name — or, for a member path, the
   *  path as written (`path` then says what it reads). */
  source: string;
  path?: SpreadPath;
  /** How many entries were written before this spread — where among them it stands. */
  after: number;
  /** A record spread: what the snapshot copies, as the checker resolved it.
   *  Absent until checked, and on every map spread. */
  copy?: CopyPlan;
  span: Span;
}

/** A name re-spelled as SOURCE TEXT: bare when it scans as an identifier,
 *  backtick-quoted otherwise. The scanner STRIPS backticks (a name root
 *  holds the unquoted name), so anything that recomposes source text from a
 *  parsed name must put them back — recomposing bare is how a backticked
 *  traversal root failed to re-parse (layer 13). */
export function spellName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name}\``;
}

/** A path ROOT re-spelled as source text: a name puts its backticks back, an
 *  expression is already source. */
export function spellPathRoot(root: PathRoot): string {
  return root.kind === 'name' ? spellName(root.name) : root.expr.raw;
}

/** A path head re-spelled as source text — the one sanctioned way to rebuild
 *  `root-[…]->` text from a parsed head. This is the DISPLAY spelling (stories,
 *  diagnostics, descriptions); to parse the hop chain back, use
 *  {@link probePathHead}, which an expression root can survive. */
export function spellPathHead(head: Pick<PathHead, 'root' | 'hopsRaw'>): string {
  return `${head.root === undefined ? '' : spellPathRoot(head.root)}${head.hopsRaw}`;
}

/**
 * The name an EXPRESSION root stands in as while the hop chain is probe-parsed.
 * The hops are the same hops whatever the root is, and the formula grammar
 * roots a traversal at a name — so the probe substitutes one, and nothing reads
 * it back: the root's TYPE comes from the expression, its VALUE from evaluating
 * it, and its IDENTITY from the source text.
 */
export const EXPRESSION_ROOT_PROBE = '__movement_expression_root__';

/** A path head re-spelled for PROBE PARSING — the hop chain rooted at a name
 *  the formula grammar accepts. */
export function probePathHead(head: Pick<PathHead, 'root' | 'hopsRaw'>): string {
  if (head.root === undefined) return head.hopsRaw;
  const root =
    head.root.kind === 'name' ? spellName(head.root.name) : EXPRESSION_ROOT_PROBE;
  return `${root}${head.hopsRaw}`;
}

// ── Traversal-headed blocks ──

/**
 * `crm-[c:Companies]-> { … }` — the body runs once per landing. BOUND
 * (`names = crm-[c:Companies]-> { return c.\`Name\` }`) its value is the list
 * of what each iteration returned; unbound it runs for its effects. Bindings
 * made inside stay inside — the only way out is `return`.
 */
export interface TraversalBlock {
  head: PathHead;
  body: Statement[];
  span: Span;
}

export interface BlockStatement {
  kind: 'block';
  block: TraversalBlock;
  span: Span;
}

// ── Link statements (the edge-only write) ──

/**
 * What a `link` connects its source to: a record already bound, or the record
 * a match body FINDS.
 *
 * The body form is sugar. `x = link p-[:E]-> { … }` means
 * `x = match p-[:E]-> { … }` then `link p -[:E]-> x`, so the parser hands the
 * body over as that match — its target the hop `p-[:E]->` — and every later
 * stage checks and runs the match it already knows, then the link.
 */
export type LinkTarget =
  | { kind: 'handle'; name: string }
  | {
      kind: 'match';
      match: MatchExpression;
      /** The author wrote no `unique by`, so the match identifies by ALL of the
       *  body's fields, exactly (see `linkBodyIdentity`). The clause is the
       *  language's, not the author's, and nothing reports on it as authored. */
      impliedIdentity: boolean;
    };

/**
 * `link a -[:e]-> b` — assert an edge between two records. The edge-only write
 * of the symmetric family (`write` node+edge, `link` edge only, `unlink` edge
 * removal, `delete` node+edges): `write` changes the record and the edge,
 * `link` only the edge, `match` neither.
 */
export interface LinkExpression {
  from: string;
  edge: string;
  to: LinkTarget;
  span: Span;
}

/** A link whose target is a match body — the only form that can be bound. */
export type FindingLink = LinkExpression & { to: Extract<LinkTarget, { kind: 'match' }> };

/** `link champion -[:led]-> part` / `link p -[:Company]-> { … }`. */
export interface LinkStatement {
  kind: 'link';
  link: LinkExpression;
  span: Span;
}

/** `unlink a -[:e]-> b` — sever an edge between two written handles
 *  (the inverse of the bare-handle `link`). */
export interface UnlinkStatement {
  kind: 'unlink';
  from: string;
  edge: string;
  to: string;
  span: Span;
}

/** `delete <handle>` — remove the record a written handle stands on. */
export interface DeleteStatement {
  kind: 'delete';
  name: string;
  span: Span;
}

/**
 * `refresh <handle>` — re-fetch the record behind a STABLE write/traversal
 * handle and move its field snapshot to now (asks-as-adapter F5/F22). Fields
 * read the snapshot, hops stay live; `refresh` moves the snapshot. Counts as a
 * READ (legal inside an `await`/`until` pure condition). The head must be a
 * re-fetchable record (a write handle or a traversed record) — refreshing the
 * event payload or an extracted node is a checker error (no record id to
 * re-fetch by); a refresh of a since-deleted record is a loud RUN error.
 */
export interface RefreshStatement {
  kind: 'refresh';
  name: string;
  nameSpan: Span;
  span: Span;
}

// ── Branching ──

export interface IfStatement {
  kind: 'if';
  /** `if` plus any `else if` arms, in order. Each arm spans its condition
   *  through its closing brace — an arm is a SCOPE (its condition's IS tests
   *  narrow into it), so it needs its own extent, not the statement's. */
  arms: Array<{ condition: ExprSlot; body: Statement[]; span: Span }>;
  /** The trailing `else` — one fact (body + its extent), so there's no
   *  "body without a span" state to keep in sync. Spans the `else` keyword
   *  through its closing brace. */
  elseArm?: { body: Statement[]; span: Span };
  span: Span;
}

// ── Durations ──

/** A bare unit-suffixed duration literal (`4h`, `2d`, `90m`, `1h30m`) captured
 *  verbatim; the unit grammar is validated in the checker. */
export interface DurationLiteral {
  raw: string;
  span: Span;
}

/**
 * `await a-[:Response]->` / `r = await a-[:Response]->` / `await sleep(2d)` —
 * durably wait on a named WAKE SOURCE, then resume the branch forward
 * (asks-as-adapter, plans/2026-07-23-asks-as-adapter/, P18). Two sources in
 * chunk B:
 *   - a `traversal` over an AWAITABLE edge (`untilNonEmpty`): the engine
 *     evaluates the (possibly WHERE-narrowed, PURE-predicate) traversal live;
 *     nonempty → continue inline, else park until a landing resolves it. A
 *     bound `await` binds the landed node(s); an empty resolution binds an
 *     empty match (downstream blocks run zero times).
 *   - `sleep(<duration>)`: the existing timer park re-skinned as a promise —
 *     the clock is the wake source. Binds nothing.
 * (`race`/`until` are later chunks; this AST models only the two chunk-B forms.)
 */
export interface AwaitExpression {
  source: AwaitSource;
  span: Span;
}

export type AwaitSource =
  /** `await <head>-[:Edge WHERE …]->` — wait until the traversal is nonempty.
   *  RETIRED SPELLING (layer 13 C1): still parses so the checker can refuse it
   *  with the rewrite; the living form is `first` below. */
  | { kind: 'traversal'; head: PathHead; span: Span }
  /**
   * `await FIRST(<head>)` — the parked FIRST: the same read `FIRST(<head>)`
   * performs, parked until it has a landing, so the binding carries the
   * landing WITHOUT the "not yet" arm (`T`, not `T | null`). Legal only where
   * waiting can end — the final edge must be awaitable, exactly as the bare
   * form required.
   *
   */
  | { kind: 'first'; head: PathHead; span: Span }
  /**
   * `await race([…])` / `await parallel([…])` — the combinator wake sources
   * (core calculus v2 R5). Both take one ordinary argument: the ARMS, a
   * collection of function values the combinator invokes concurrently.
   *
   */
  | { kind: 'combinator'; combinator: CombinatorExpression; span: Span }
  /** `await sleep(<duration>)` — wait a fixed interval (the clock wake source). */
  | { kind: 'sleep'; duration: DurationLiteral; span: Span }
  /**
   * `await until(<condition>, every: <duration>)` — the CLOCK, RECURRING wake
   * source (P18/F12). The engine evaluates the BOOLEAN `condition` each tick (a
   * recurring timer park) and resolves when it holds. `every` is the cadence,
   * named (default 1h, floor 1m). The condition is READ-ONLY (refresh allowed;
   * writes/asks/awaits/race are checker errors); liveness is explicit — a
   * re-fetch is written `refresh` inside the closure body.
   *
   * A comparand is not a second argument: it is an equality in the condition
   * (`until(x == "done", every: 5m)`).
   */
  | {
      kind: 'until';
      condition: UntilCondition;
      every?: DurationLiteral;
      span: Span;
    };

/**
 * The `until` condition — a CLOSURE returning boolean (`() => { refresh a;
 * return a.\`State\` == "done" }`), run once per tick, or a plain boolean
 * expression (`COUNT(m-[:a]->) >= 3`), which is the same closure with the
 * ceremony elided.
 */
export type UntilCondition =
  | { kind: 'closure'; closure: ClosureExpression }
  | { kind: 'expr'; expr: ExprSlot };

/** `await …` used as a statement without binding its result (the unbound form —
 *  `await a-[:Response]->`, `await sleep(2d)`). The bound form parses as an
 *  `AssignStatement` whose RValue is `{ kind: 'await' }`. */
export interface AwaitStatement {
  kind: 'await';
  await: AwaitExpression;
  span: Span;
}

/**
 * `race([f, () => sleep(3d)])` / `parallel([f, g])` — the two concurrency
 * combinators (core calculus v2 R5). Both take ONE ordinary argument: the arms,
 * a collection of FUNCTION values, invoked concurrently. There is no special
 * evaluation zone — the bracket is an ordinary eager list of closures and
 * function names, and "evaluate as soon as reached" holds inside it as
 * everywhere else.
 *
 * `race` settles at the first arm to settle and stops listening on arms parked
 * at a suspension; `parallel` joins every arm. Both hand back a POSITIONAL
 * receipt — an ordinary value, one slot per arm, in the arms' own order — so
 * "the timer won" and "the value is absent" are one null check on a slot.
 *
 */
export interface CombinatorExpression {
  kind: 'race' | 'parallel';
  arms: CombinatorArms;
  span: Span;
}

/**
 * The arms a combinator runs. A LITERAL bracket is a fixed, author-written set,
 * so each slot is typed exactly (a tuple); anything else is a collection built
 * at run time, so the arms are same-typed and the receipt is a list.
 */
export type CombinatorArms =
  | { kind: 'literal'; arms: ArmExpression[]; span: Span }
  | { kind: 'dynamic'; expr: ExprSlot; span: Span };

/** One literal arm: a closure written in place, or a name already bound to a
 *  function (a movement, or a closure bound earlier). */
export type ArmExpression =
  | { kind: 'closure'; closure: ClosureExpression; span: Span }
  | { kind: 'ref'; name: string; span: Span };

/**
 * `MAP(xs, f)` / `FILTER(xs, f)` / `REDUCE(xs, init, f)` / `GROUPBY(xs, key)` /
 * `KEYBY(xs, key)` — iteration over a VALUE collection, with a function.
 * `MAP(xs, { … }, f)` / `FILTER(xs, { … }, f)` take a settings record between
 * the two.
 *
 * They live where `race` and `parallel` live rather than among the expression
 * functions, and for the same reason: the argument is a FUNCTION, and a
 * function's body is a body — statements, `return`, everything a body may do.
 * Positions keep the traversal-headed block; this is the values' form.
 */
export interface CollectionOpExpression {
  op: CollectionOp;
  /** The collection being read. */
  source: ExprSlot;
  /** `REDUCE`'s starting value — the fold's zero, and the only op with one. */
  init?: ExprSlot;
  /** `MAP(xs, { … }, f)` / `FILTER(xs, { … }, f)` — the settings record, as
   *  written: what a failing member does, and how many run at once
   *  (`readCollectionConfig`). Only `MAP` and `FILTER` take one; without it
   *  the op runs one member at a time and the first failure fails the run. */
  config?: ExprSlot;
  /** The function, written in place or named — an arm, in every sense the
   *  combinators mean it. */
  fn: ArmExpression;
  span: Span;
}

export type CollectionOp = 'map' | 'filter' | 'reduce' | 'groupby' | 'keyby';

/**
 * `MEMBERS(<Thesis>)` — a closed type's values, as a list in the order they
 * were DECLARED. That order is a property of the type, which is the point: a
 * report's sections come from the declaration rather than from a hand-written
 * list that drifts from it.
 *
 * `type` is the annotation as written — a declared refinement's name, or a
 * borrowed path into a live field's option set — read with the same marker
 * grammar an extract field's annotation uses.
 */
export interface MembersExpression {
  type: string;
  span: Span;
  /** The annotation's own span, for a diagnostic that points at the type. */
  typeSpan: Span;
}

/** `race([…])` / `parallel([…])` written as a statement, without `await`. A
 *  combinator composes a wait and `await` is what parks, so this is refused
 *  with the rewrite — it parses so the refusal can name it. */
export interface CombinatorStatement {
  kind: 'combinator';
  combinator: CombinatorExpression;
  span: Span;
}

/** `MAP(xs, f)` (and its siblings) run bare, without a binding — legal for
 *  `MAP` in particular, whose function may write for its own sake and answer
 *  nothing anyone reads (`f`'s slot is then absent per member, discarded
 *  here). `FILTER` / `REDUCE` / `GROUPBY` / `KEYBY` still need their function
 *  to return (the checker's rule, not the parser's — this parses any of them
 *  bare so the refusal, where there is one, can name it). */
export interface CollectionStatement {
  kind: 'collection';
  collection: CollectionOpExpression;
  span: Span;
}

/**
 * `(d: <date>) => { … }` — an anonymous CLOSURE: the parameter grammar every
 * callable shares, an arrow, and a body. It is a VALUE — bind it, pass it,
 * park with it — and it is (AST, captured bindings): the body rides across a
 * park as itself, the capture as ordinary serialised bindings.
 *
 * Its body returns like any other body (`return <value>`), which is what makes
 * `until(() => { … return <bool> })` an ordinary closure rather than a special
 * condition form.
 */
export interface ClosureExpression {
  params: MovementParam[];
  /** `(n: <number>): <number> => …` — what it declares it returns (language
   *  version 3). Required when the closure calls itself by its own name. */
  returnType?: ParamTypeRef;
  body: Statement[];
  span: Span;
}

/**
 * `{ …statements…; binding = … }.binding` — RETIRED (core calculus v2): reading
 * a block's inner binding by name is naming-is-exporting, which explicit
 * `return` replaces. Still PARSED so the checker can refuse it with the
 * replacement — a closure returning the value.
 */
export interface InlineBlockExpression {
  body: Statement[];
  /** The `.name` accessor that names which of the block's bindings this reads. */
  binding: string;
  bindingSpan: Span;
  span: Span;
}

// ── Callbacks (the deferred, addressable invocation) ──

/**
 * `cb = callback(<subject>)` / `callback(<subject>, { once: …, ttl: … })` —
 * mints a DEFERRED INVOCATION addressable by an opaque id. The binding reads
 * `.id` (the payload every platform button/tap carries) and `.url` (the human
 * link). A callback is strictly scoped to its run — JS closure semantics: it
 * captures the enclosing scope, firing it RESUMES the parked run at the
 * subject's entry point, and the run ending revokes what never fired.
 *
 */
export interface CallbackExpression {
  subject: CallbackSubject;
  /**
   * `{ once: <boolean>, ttl: <duration> }` — the OPTIONAL config object,
   * always the second argument. Kept as raw named args (no key-driven parsing):
   * the checker owns the closed vocabulary (`once` defaults TRUE; `ttl` is a
   * duration literal) and reports an unknown key with a did-you-mean.
   */
  config: NamedArg[];
  /** The config object's span, for diagnostics; absent when no config was given. */
  configSpan?: Span;
  span: Span;
}

/** What a callback defers: an anonymous inline movement, or a named one. */
export type CallbackSubject =
  /**
   * `callback({ … })` — an anonymous inline movement with no parameters; or
   * `callback((d: <date>) => { … })` — one with parameters, the values the
   * PLATFORM supplies at fire time (a picked date, entered text). The parameter
   * list is the movement-declaration parameter grammar verbatim; the arrow
   * separates it from the body, and the bare-brace form is the elision of an
   * empty parameter list.
   *
   * `callback()` / `callback((d: <date>))` — the BODY-LESS forms — are the
   * same node with an EMPTY body, not a variant: firing one records the call
   * and wakes whoever awaits `Called`, which is what an empty body does. It is
   * the minimal confirm pattern (`cb = callback(); await cb-[:Called]->`).
   */
  | { kind: 'inline'; closure: ClosureExpression; span: Span }
  /**
   * `callback(send_reminder)` / `callback(send_reminder(who: "sam"))` — the
   * ONLY position in the language where a movement is a value. The optional
   * argument list supplies the FIXED arguments (named, like any call); the
   * parameters it leaves unsupplied are the callback's fire-time signature,
   * bound by the router from what the platform sends.
   */
  | { kind: 'named'; movement: string; args: CallArg[]; nameSpan: Span; span: Span };

/** `ERROR("message")` — fail the whole run with a reason (3f). Used as a
 *  statement and as a `fallback … to` terminal. */
export interface ErrorStatement {
  kind: 'error';
  message: ExprSlot;
  span: Span;
}

// ── Calls ──

/**
 * A call's arguments are POSITIONAL — bound to the callee's parameters in
 * declared order, as TypeScript binds `f(a, b)` — or NAMED after them
 * (`f(x: a)`), and one call is all of one or all of the other (a mixed list is
 * a parse error). `name` is the parameter a named argument names; ABSENT on a
 * positional one, whose parameter is the declaration's business, not the
 * call's. `argumentBindings` is the one place either is resolved to a
 * parameter, so the checker and the engine cannot bind differently.
 */
export type CallArg =
  /** `log_lead(l: m)` / `log_lead(m)` — an expression argument. */
  | { kind: 'expr'; name?: string; expr: ExprSlot }
  /** RETIRED (wave 4): inline shape-write adaptation,
   *  `files_to_dropbox(file: write Files-[:file]-> { … })`. Still PARSED — the
   *  checker refuses it by name and points at the `node` form below, which it
   *  can only do if the grammar still reaches it — and still RUN, for programs
   *  saved before the refusal. */
  | { kind: 'write'; name?: string; write: WriteExpression }
  /** inline node synthesis: `process_deal(d: node { title: m.`Subject` })` */
  | { kind: 'node'; name?: string; node: NodeLiteral }
  /**
   * A CALL, passed on: `log_doc(d: email_to_doc(m: msg))`. The utility idiom —
   * one movement's value is another's argument — so it is a position argument
   * like the two above, not an expression: the value is a node, and nothing in
   * the expression plane can hold one.
   *
   * Recognised by the NAMED-argument form (`f(x: …)`), or by a POSITIONAL
   * invocation (`f(x)`). From language version 3 a positional one may name a
   * built-in (`f(UPPER(x))`): resolution reads it as the value it computes,
   * an ordinary expression argument (`checker/calls.ts`).
   */
  | { kind: 'call'; name?: string; call: CallStatement }
  /**
   * A function written in place — `MAP(xs, (x) => { … })` (language version 3).
   * Only a built-in that takes a function (`MAP`, `FILTER`, `REDUCE`,
   * `GROUPBY`, `KEYBY`) accepts one; anywhere else it is refused by name,
   * because a function is not yet a value an argument can carry.
   */
  | { kind: 'closure'; name?: string; closure: ClosureExpression; span: Span }
  /**
   * A type — `MEMBERS(<Thesis>)` (language version 3). The annotation as
   * written, unbracketed, as `MembersExpression.type` holds it. Only a
   * built-in that takes a type accepts one.
   */
  | { kind: 'type'; name?: string; type: string; span: Span };

/** One argument and the parameter it binds — `param` is undefined for a
 *  positional argument past the callee's last parameter. */
export interface ArgumentBinding {
  arg: CallArg;
  param: string | undefined;
}

/**
 * Which parameter each argument binds: a named argument the parameter it
 * names, a positional one the parameter DECLARED at its index — TypeScript's
 * call. `params` is the callee's parameter names in declaration order.
 */
export function argumentBindings(args: readonly CallArg[], params: readonly string[]): ArgumentBinding[] {
  return args.map((arg, index) => ({ arg, param: arg.name ?? params[index] }));
}

/** Whether a call's arguments are positional. A call is all one or all the
 *  other (the parser refuses a mix), so the first argument answers for all. */
export function isPositionalCall(args: readonly CallArg[]): boolean {
  return args.length > 0 && args[0].name === undefined;
}

/**
 * `log_doc(d: msg)` — a function invoked. A call is a STATEMENT and an
 * ARGUMENT (`CallArg`'s `call` kind) with one AST node, because it is one
 * thing: a call's value is what the callee RETURNS, and using it is optional
 * (a callee that returns nothing is a statement and nothing else).
 *
 * The parser records the call and decides nothing about what the callee IS.
 * From language version 3 that includes a built-in: `n = UPPER(m.Subject)`,
 * `xs = MAP(items, f)` and `doc = email_to_doc(m)` are all this node, and
 * resolution (`checker/calls.ts`) reads each one once its callee is looked up
 * — a movement or plugin runs, a built-in is read as the value, collection op
 * or type query it is.
 */
export interface CallStatement {
  kind: 'call';
  callee: string;
  args: CallArg[];
  /**
   * The same call read as ONE expression — the reading it takes when its
   * callee resolves to a built-in that computes a value (`UPPER(x)`,
   * `COUNT(c-[p:Members]->)`, `SORT(xs, name, DESC)`), whose arguments are the
   * expression grammar's rather than a call's. Set on every positional call;
   * a named call (`f(x: …)`) is never a built-in's.
   */
  expression?: ExprSlot;
  span: Span;
}

// ── Node declarations ──

/**
 * `node doc { title: <text>  node file { … } }` — a NAMED node declaration: the
 * structure a parameter is checked against, written as the tree it describes.
 *
 * The declaration IS its root node. Nesting declares the edge and the nested
 * node's name IS the edge name, so `<doc>` types the root directly and
 * `d-[f:file]->` traverses to the child — one nesting idiom shared with the
 * extract tree and the node literal.
 *
 * The AST discriminant stays `'shape'` (and the types keep their names) because
 * a parked run's scope descriptors persist it: rehydrating a run saved before
 * the syntax change must still find its code refs.
 *
 */
export interface ShapeDeclaration {
  kind: 'shape';
  name: string;
  /** The declaration's own node — `name` is the declaration's name. */
  root: ShapeNode;
  /**
   * `node Recap Entry extends Entry { … }` — TypeScript's `interface X extends
   * Y`: the declaration is the base's fields and nested nodes (with the base's
   * types, words and order), then its own. As PARSED, `root` holds only the
   * declaration's own members. The checker and the engine each resolve the
   * base in the scope the declaration was written in, and what they hand on
   * (a checker symbol's `declaration`, the engine's resolved shape) is the
   * whole tree `inheritDeclaration` builds — the inline spelling of it.
   */
  extends?: { name: string; span: Span };
  /** Declared with the `export` prefix — offered to other files. A file
   *  with at least one export is a LIBRARY. */
  exported?: boolean;
  span: Span;
}

/** One node of a declaration tree. A child's `name` is the edge that reaches it. */
export interface ShapeNode {
  name: string;
  /**
   * `node Entry: "each distinct item" { … }` — the node's own words, on the
   * same terms as an extraction node's: an ordinary string expression, which
   * may interpolate file-scope bindings declared above the declaration. What an
   * extraction taking this declaration as its shape tells the extractor;
   * absent ⇒ undescribed.
   */
  description?: ExprSlot;
  /** A field's `description` is its extraction words, on the same terms. */
  fields: Array<{
    name: string;
    type: string;
    /** `<text | null>`, on the terms an extraction field's is (`ExtractField`). */
    nullable?: true;
    description?: ExprSlot;
    span: Span;
  }>;
  children: ShapeNode[];
  /**
   * `order by arrival` after this node's closing `}` — the author saying the
   * edge that reaches it (this node's `name`, from its parent) keeps an
   * order. The same clause and the same three words `tryParseEntryOrdering`
   * already parses for an entry's type marker; a nested node has no marker of
   * its own, so the clause sits after its brace instead. Absent ⇒ a SET,
   * exactly as an undeclared adapter edge is.
   */
  sequenced?: EdgeSequencing;
  span: Span;
}

/**
 * `type Thesis = <"A" | "B">` — an author-declared REFINEMENT: a closed set of
 * text values, the WRITTEN twin of an option set borrowed from a live field
 * (`<crm-[:companies]->.\`funding_stage\`>`). Both resolve to the same closed
 * enum, so a declared type does everything a borrowed one does — constrains the
 * extraction, hints the prompt, and checks a literal with a did-you-mean.
 *
 * The values are plain text at run time; nothing new exists at run time at all.
 * What the declaration adds is the set the checker checks against.
 */
export interface TypeDeclaration {
  kind: 'type';
  name: string;
  /** The values, in the order written. */
  options: string[];
  span: Span;
}

// ── Movements ──

/** One typed parameter of a callable — a movement declaration's, and (the same
 *  grammar, the same node) an anonymous inline movement's inside `callback`. */
export interface MovementParam {
  name: string;
  /**
   * The written type: a NAME (`<inbox-[:message]->>`, `<doc>`, `<text>`,
   * `<Thesis>`) or a value type spelled out in full (`<text[]>`,
   * `<{ mode: text, owner?: text }>`). ABSENT where the caller supplies it — a collection op
   * hands its function one element, and the element's type is the
   * collection's, so `MAP(xs, (x) => …)` needs no annotation to know what `x`
   * is (TypeScript types a callback's parameter the same way, from the
   * signature it is passed to). Everywhere else a parameter's type is what the
   * declaration promises its callers, so leaving it out is refused.
   */
  type?: ParamTypeRef;
  span: Span;
}

/**
 * `<text[]>` / `<{ mode: text, owner?: text }>` — a VALUE type written out in
 * full: TypeScript's array type and object type literal. A parameter typed
 * this way takes a value (the dot plane), never a record position. A key
 * marked `?` may be left out, and reads as possibly absent inside the callee.
 */
export type ValueTypeRef =
  | { kind: 'list'; of: ValueTypeMember; span: Span }
  | { kind: 'record'; keys: ValueTypeKey[]; span: Span };

/** What a written value type is built from: a type NAME (a scalar, or a
 *  declared refinement) or another written value type. */
export type ValueTypeMember = { kind: 'name'; name: string; span: Span } | ValueTypeRef;

export interface ValueTypeKey {
  name: string;
  type: ValueTypeMember;
  /** `owner?: text` — the key may be left out. */
  optional?: true;
  span: Span;
}

/** A parameter's written type: a name, or a value type spelled in full. */
export type ParamTypeRef = TypeRef | ValueTypeRef;

/** Is this parameter type a value type spelled in full (rather than a name)? */
export function isValueTypeRef(type: ParamTypeRef): type is ValueTypeRef {
  return 'kind' in type;
}

/** The parameter type as a NAME (a position, a node declaration, a scalar, a
 *  refinement) — undefined when none was written or it is a value type spelled
 *  in full, which names no graph. */
export function typeNameOf(type: ParamTypeRef | undefined): TypeRef | undefined {
  return type === undefined || isValueTypeRef(type) ? undefined : type;
}

/** A parameter's written type in its surface spelling, without the brackets. */
export function spellParamType(type: ParamTypeRef): string {
  return isValueTypeRef(type) ? spellValueType(type) : `${type.graph}${type.hopsRaw ?? ''}`;
}

/** A written value type in its surface spelling, for diagnostics. */
export function spellValueType(type: ValueTypeMember): string {
  switch (type.kind) {
    case 'name':
      return type.name;
    case 'list':
      return `${spellValueType(type.of)}[]`;
    case 'record':
      return `{ ${type.keys.map(key => `${key.name}${key.optional ? '?' : ''}: ${spellValueType(key.type)}`).join(', ')} }`;
  }
}

/**
 * `movement <name>(<params>) { … }` — and, since the callback work, `function
 * <name>(…) { … }`: the two spellings are ONE declaration. `function` is a pure
 * parser alias (authoring LLMs' priors are strong for it, and movements now
 * behave like functions — parameters, invocation by name), so the AST keeps a
 * single node kind and nothing downstream can tell them apart.
 *
 */
export interface MovementDeclaration {
  kind: 'movement';
  name: string;
  params: MovementParam[];
  /**
   * `movement f(n: <number>): <number> { … }` — the type the body declares it
   * returns, as TypeScript writes it (language version 3). Optional, except on
   * a function in a call cycle (one that calls itself, directly or through
   * others): there what the body returns cannot be inferred from a body that
   * needs its own answer, so it is written. Where it is written, every
   * `return` is checked against it and a call is typed by it.
   */
  returnType?: ParamTypeRef;
  body: Statement[];
  /** Declared with the `export` prefix — offered to other files. A file
   *  with at least one export is a LIBRARY. */
  exported?: boolean;
  span: Span;
}

// ── Listeners ──

/**
 * `listen to inbox { key: "dealflow" } fire dealflow_intake` — a file-level
 * statement declaring that events on a constructed adapter instance fire a
 * movement. Trigger rows are fully DERIVED from these (one per listen); a
 * file with no listens is a library. The config block is the trigger's
 * adapter-specific routing config (e.g. the email plus-address `key`) and
 * may be omitted.
 *
 * A system whose RECORDS change is listened to the same way — the knowledge
 * graph included, which is constructed and named like any other:
 *
 *   graph = kg()
 *   listen to graph { type: "Company", events: ["record.created", "record.updated"],
 *                     fields: [Domains] } fire on_company_change
 *
 * Every value here is a plain quoted one: `type` pins which record type is
 * watched, `events` names the uniform `record.*` change kinds, and `fields`
 * narrows updates to ones touching the named properties. What the listen
 * FIRES is the change, not the record — the fired movement's parameter is the
 * event position (`change: <graph-[:`Record Change` WHERE `type` ==
 * "Company"]->>`) and the record is one hop along its `Record` edge.
 *
 * `listen` is the ONLY invoker (the former `run` entry retired when time
 * and manual runs collapsed into adapters). Every channel is constructed
 * EXPLICITLY and named first, then listened to by name: scheduled work
 * constructs a cron instance (`timer = cron()`; `listen to timer { schedule:
 * "0 9 * * 1" } fire digest`), on-demand work a manual one (`go = manual()`;
 * `listen to go {} fire backfill` — "Run now" injects an event on that
 * channel). The fired movement's parameter is typed against the SAME named
 * instance (`go: <go-[:invocation]->>`).
 *
 * An inline construction — `listen to manual() {}` — still parses (the call
 * lands in `construct`) but the checker rejects it: an instance exists only
 * from an explicit `name = adapter()` construction (spec
 * `plans/2026-06-24-required-instantiation/0_spec.md`). `construct` is kept
 * on the node only so the checker can recognise that mistake and guide the
 * fix.
 */
export interface ListenDeclaration {
  kind: 'listen';
  /** The listened name — a constructed instance, always. (When `construct` is
   *  present the author wrote the now-rejected inline form — `instance` then
   *  carries the adapter name from the call.) */
  instance: string;
  /** Lane name from a leading `listen as "<alias>"`. Derives the trigger name
   *  at provisioning time; absent → today's derived name. */
  alias?: string;
  /** `listen to manual() …` — the inline construction call. Present only for
   *  the rejected inline form; the checker reports it and points at the
   *  named-construction fix. */
  construct?: ConstructionCall;
  config: NamedArg[];
  movement: string;
  span: Span;
}

// ── Extraction ──

/**
 * `extract "thorough" from [data…] through [plugins…] { stage } through [plugins…] { stage } …`
 * Stages alternate with `through` pipelines; a stage's `through` is the pipeline that
 * runs before it (absent on the first stage unless declared on `from`). A stage
 * INHERITS the fields of the stage before it and declares only what it transforms,
 * so a node's shape is every field it declares anywhere.
 */
export interface ExtractExpression {
  from: ExprSlot[];
  stages: ExtractStage[];
  /**
   * How much thinking this extraction is worth — `AI()`'s tier vocabulary,
   * one concept across both surfaces. Carried VERBATIM as it was written (the
   * checker owns the closed set and the did-you-mean), and STATEMENT-level:
   * it applies to every call the extraction makes, at every stage. Per-stage
   * tiers are deliberately absent — an extraction is one declared tree, and a
   * reader should not have to assemble its cost from its stages.
   */
  tier?: string;
  span: Span;
}

export interface ExtractStage {
  /** The pipeline this stage's context passed through before extraction; absent for an unpiped first stage. */
  through?: PluginCall[];
  fields: ExtractField[];
  children: ExtractNode[];
  span: Span;
}

/**
 * `name: "description"`, `amount: <number> "description"`, or a BORROWED
 * type — an edge into another graph's schema, then the field as a property
 * tail, resolved live: `stage: <crm-[:companies]->.\`funding_stage\`>
 * "description"`. (The AST stores the resolver's `<instance>.<root>.<field>`
 * segments; the surface spelling is the address-then-property form.)
 */
export interface ExtractField {
  name: string;
  /** Optional explicit type annotation (surface-bracketed, stored bare):
   *  a primitive type name or a borrowed instance.root.field path. Only
   *  explicit annotations constrain extraction; an unannotated field
   *  flowing into a typed write target gets a checker SUGGESTION to
   *  annotate, never a silent adopted type. */
  type?: string;
  /** `<text | null>` — the author's word that a field the model did not find
   *  arrives null. Only text changes by it (an unfound text is otherwise `""`);
   *  every other type is already maybe-absent. The prompt never sees it. */
  nullable?: true;
  /**
   * The words the extractor is given for this field — an ORDINARY string
   * expression, so it interpolates wherever it is written, exactly as a write
   * field's value or an `AI()` prompt does. The slot's `raw` is the whole
   * literal INCLUDING its quotes, which is what `expressionOfSlot` reads:
   * a plain literal lowers to a `static`, an interpolating one to a
   * `concat`. Nothing downstream may paste `raw` — it is source, not text.
   */
  description: ExprSlot;
  span: Span;
}

/** `node company: "description" { stage } through […] { stage } …` — or a node
 *  that takes a declaration as its shape (`DeclaredExtractNode`). */
export type ExtractNode = InlineExtractNode | DeclaredExtractNode;

/** `node company: "description" { stage } through […] { stage } …` */
export interface InlineExtractNode {
  name: string;
  /** The node's own words, on the same terms as a field's (see `ExtractField`). */
  description: ExprSlot;
  stages: ExtractStage[];
  declared?: undefined;
  span: Span;
}

/**
 * `node entry: <Entry> "…" through […] { … }` — a node whose shape AND words
 * come from a node declaration. It extracts exactly what the inline block that
 * spells the declaration out would, so `found-[e:entry]->` walks records of the
 * declared structure. A description written here replaces the declaration's
 * record-level one for this extraction.
 *
 * `stages` holds only the `through […] { … }` stages that FOLLOW — the
 * declaration itself is the node's first stage.
 */
export interface DeclaredExtractNode {
  name: string;
  declared: { type: string; span: Span };
  description?: ExprSlot;
  stages: ExtractStage[];
  span: Span;
}

/**
 * `extract(content, Shape, { tier, model, effort })` — extraction as a
 * FUNCTION: content in, a list of `Shape` records out (a local graph, one
 * record per thing found). Data first, then the shape, then the settings.
 *
 * It is a second form beside the `extract … from …` keyword, not a spelling
 * of it: the keyword keeps its own tree, stages and engine path. What this
 * form adds is that the shape is an ordinary node declaration and the prompt
 * is laid out for the prompt cache (shared content first, shape last).
 *
 * Like `MAP` and `MEMBERS` it is read where a right-hand side is, because one
 * of its arguments — the shape — is a TYPE, which an expression cannot hold.
 *
 * `extractOne(content, Shape, …)` is the same call asking for the single
 * record the content describes — `find` beside `filter` — so it gives back a
 * `Shape | absent` rather than a list.
 */
export interface ExtractCallExpression {
  finds: ExtractCallFinds;
  /** The content list, as written — text, files, and records rendered as
   *  text (`TEXT.SERIALISE(r, 'JSON')`). Usually a list literal. */
  content: ExprSlot;
  shape: ExtractCallShape;
  /** `{ tier: 'careful', model: '…', effort: '…' }`, as written; read by
   *  `readExtractCallConfig`, the one reader the checker and the engine share. */
  config?: ExprSlot;
  span: Span;
}

/** What an extraction call asks for: `each` record the content names
 *  (`extract`), or the `one` it describes (`extractOne`). */
export type ExtractCallFinds = 'each' | 'one';

/**
 * The shape argument. A NAME is a node declaration in scope (file level, a
 * library's, or one declared in the body around the call); an INLINE one is
 * the declaration itself written in the argument (`node Company: "…" { … }`),
 * read by the declaration grammar and checked by the declaration's own path.
 * Anything else is COMPUTED — kept as written so the checker can refuse it,
 * because the result's type is the shape's and a computed one has none.
 */
export type ExtractCallShape =
  | { kind: 'named'; name: string; span: Span }
  | { kind: 'inline'; declaration: ShapeDeclaration; span: Span }
  | { kind: 'computed'; expr: ExprSlot; span: Span };

/** `vc_url_retrieval(urls: urls)` or bare `scrub_sensitive` inside a `through [...]`. */
export interface PluginCall {
  plugin: string;
  args: NamedArg[];
  span: Span;
}
