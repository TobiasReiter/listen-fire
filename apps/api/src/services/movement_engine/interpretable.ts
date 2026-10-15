// Movement engine — the dry interpretability check.
//
// The movement engine executes every movement from its canonical text
// (6_engine.md). It raises a clean MOVENG_UNSUPPORTED at fire time for
// anything outside its slice, but a failed firing is the WRONG place to
// discover that — so every save runs this static scan first and refuses
// (status 'error') with the constructs named.
//
// This is a STATIC approximation of the interpreter's unsupported set:
// it walks the parsed AST (statements, conditions, expression slots) for
// constructs `run.ts` / `expression.ts` reject unconditionally. Runtime-
// dependent rejections (a block head over a binding of the wrong kind,
// WHERE filters on a particular hop) are not statically decidable here
// and still surface as failed runs — the list below is the honest
// construct-level gate, not a proof of interpretability. Every engine
// site that throws MOVENG_UNSUPPORTED, with what covers it (this scan, a
// checker diagnostic, or a named gap), is registered in
// __test__/interpretable_unsupported_sites.unit.test.ts.

import {
  BridgeError,
  MovementParseError,
  linkImports,
  conditionOfSlot,
  expressionOfSlot,
  parseMovementExpression,
  parseFieldTypeName,
  parseProgram,
  pathRootName,
  typeNameOf,
  CURRENT_LANGUAGE_VERSION,
  programCallScope,
  readCall,
  resolveCallee,
  hoistingMemberReads,
  nestedCalls,
  parseNestedCall,
  readingBoundNames,
  runsAsCall,
  slotOfTree,
  treeOfSlot,
} from 'movement-lang';
import type {
  CallArg,
  CallPosition,
  CallReading,
  CallScope,
  CallStatement,
  CollectionOpExpression,
  RValue,
  CombinatorExpression,
  ExprSlot,
  ExtractExpression,
  LanguageVersion,
  MExpr,
  MatchExpression,
  NodeLiteral,
  PathHead,
  MovementCondition,
  Program,
  ResolveFile,
  Statement,
  WriteExpression,
} from 'movement-lang';
import type { Expression } from '#shared/expression/types';
import { listElementExpression, objectMemberExpression } from '#shared/expression/types';
import { isMovementBuiltinFunction } from './expression';

/** Expression kinds the interpreter's evaluator executes today —
 *  everything else in a slot flags the movement as non-interpretable. */
const SUPPORTED_EXPRESSION_KINDS: ReadonlySet<Expression['type']> = new Set<
  Expression['type']
>([
  'static',
  'list',
  // Object literals — the structured-value form (`{ key: expr, … }`); the
  // engine evaluates every entry, no adapter or LLM involved.
  'object',
  'concat',
  'conditional',
  'compare',
  'logical',
  'not',
  'negate',
  'arithmetic',
  'traverse',
  'aggregate',
  'alias_ref',
  // AI() — runs through the LlmClient seam (movement_engine/expression.ts).
  'llm',
  // A bare name parses as a root-less `property` node (the bridge's
  // identity resolver is total) — the engine reads it as a value binding.
  'property',
  // EXISTS() — the frozen engine's quantifier semantics over the same
  // read seams (adapter getRelated / extract emissions / meta-node
  // edges); the bridge lifts it as a traverse terminal or a bare node.
  'exists',
  // Function calls — the frozen engine's built-in pure scalar functions
  // (COALESCE, TRIM, …) run everywhere; adapter field functions run as
  // write-field values (bound to the write target's adapter at
  // field-mapping time); non-built-ins anywhere else are flagged per
  // name in scanExpression.
  'function',
  // `@<key>` meta values — the frozen engine's time / acting-user /
  // raw-actor key families, mirrored over the run's dispatch context.
  'meta',
  // `[n]` array indexing — frozen semantics, mirrored verbatim.
  'at',
]);

const EXPRESSION_KIND_LABEL: Partial<Record<Expression['type'], string>> = {
  // Retired by generalisation, not pending: the kg is an ordinary graph
  // here — query it with a traversal instead of an inline query function.
  kg_exists:
    'KG_EXISTS() (retired — query the graph with a traversal instead: EXISTS(graph-[c:Company WHERE …]->))',
  kg_value:
    'KG_VALUE() (retired — query the graph with a traversal instead: graph-[c:Company WHERE …]->.`field`)',
  // TG-shaped reads whose sources don't exist in a movement run — not
  // "later increments" but constructs with movement-native replacements.
  parent_result: "'@parent.*' reads (read the parent write's handle instead)",
  resource: "'@resource.*' reads (traverse -[:_resources]-> instead)",
};

/**
 * The constructs in this program the movement engine cannot interpret
 * yet, deduplicated, in encounter order. Empty = the dry check passes
 * and the save may go live. A program that doesn't parse returns [] —
 * parse/check diagnostics own that failure mode.
 *
 * File imports run since E8 (the engine resolves them from the run's catalog
 * snapshot's `files`); pass a resolver over the SAME files here so the
 * imported library files are scanned too — a library body carrying an
 * unsupported construct flags the importing file, suffixed with the
 * library path. Resolution failures stay silent: checkProgram owns those
 * diagnostics (every gate caller runs both).
 *
 * The scan reads the program as the engine will run it — under its pin, which
 * a saved movement's caller must pass. Absent ⇒ the current version: text no
 * movement is pinned to yet.
 */
export function listUnsupportedConstructs(
  source: string,
  options: { resolveFile?: ResolveFile; languageVersion?: LanguageVersion } = {},
): string[] {
  // The program is read as the version it is pinned to says — a form a later
  // version reads differently (`(v) => f(v)`, a concise call from 5) is
  // scanned as what it means under the pin.
  const languageVersion = options.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  let program: Program;
  try {
    program = parseProgram(source, { languageVersion });
  } catch (e) {
    if (e instanceof MovementParseError) return [];
    throw e;
  }
  const found = new InterpretabilityScan(languageVersion).scan(program);
  if (options.resolveFile) {
    // A library is read under the version of the program that imports it.
    const link = linkImports(program, options.resolveFile, { languageVersion });
    for (const [path, file] of link.files) {
      for (const construct of new InterpretabilityScan(languageVersion).scan(file.program)) {
        const labelled = `${construct} (in "${path}")`;
        if (!found.includes(labelled)) found.push(labelled);
      }
    }
  }
  return found;
}

class InterpretabilityScan {
  private readonly found: string[] = [];
  private readonly seen = new Set<string>();
  /** File-scope construction + shape names — a movement parameter must
   *  be typed against one (instance-rooted entries; shape-rooted
   *  callees since the composition increment). Nothing is ambient: the
   *  knowledge graph is constructed and named like every other system. */
  private readonly graphRoots = new Set<string>();
  /** Declared node names — a write to one has no adapter, so its
   *  fields are NOT a field-function context (see scanWrite). */
  private readonly shapeNames = new Set<string>();
  /** Names a file-scope `x = f(…)` would CALL rather than construct: the
   *  file's own movements and its imported plugins. */
  private readonly callableNames = new Set<string>();
  /** The refinements this file declares (`type Thesis = <"A" | "B">`) — a
   *  parameter typed by one takes a VALUE, as a scalar-typed one does. */
  private readonly declaredTypes = new Set<string>();
  /** > 0 while scanning the field slots of an adapter-target write —
   *  the only place a non-built-in function can resolve at runtime. */
  private writeFieldDepth = 0;
  /** What a call can name here: the file's functions, then the standard
   *  library — so a call reads as the checker and the engine read it. */
  private callScope: CallScope = programCallScope({ statements: [] });
  /** The names a closure has been bound to so far in the walk — each is a
   *  function a call can name (language version 3). Gathered as the scan
   *  meets them, without scopes: which binding a call reaches is the
   *  checker's to say, and this only has to know a call RUNS. */
  private readonly closureNames = new Set<string>();

  constructor(private readonly languageVersion: LanguageVersion) {}

  scan(program: Program): string[] {
    const file = programCallScope(program);
    const closures = this.closureNames;
    const closureSpelled = (name: string): string | undefined =>
      [...closures].find((bound) => bound.toLowerCase() === name.toLowerCase());
    this.callScope = {
      binds: (name) => file.binds(name) || closures.has(name),
      functionSpelled: (name) => file.functionSpelled(name) ?? closureSpelled(name),
    };
    for (const statement of program.statements) {
      if (statement.kind === 'assign' && statement.value.kind === 'construct') {
        this.graphRoots.add(statement.name);
      }
      if (statement.kind === 'shape') {
        this.graphRoots.add(statement.name);
        this.shapeNames.add(statement.name);
      }
      if (statement.kind === 'type') this.declaredTypes.add(statement.name);
      if (statement.kind === 'movement') this.callableNames.add(statement.name);
      if (
        statement.kind === 'import'
        && statement.source.kind === 'builtin'
        && statement.source.namespace === 'plugins'
      ) {
        for (const { name, alias } of statement.names) this.callableNames.add(alias ?? name);
      }
      if (statement.kind === 'import' && statement.source.kind === 'file') {
        // An imported name may be a shape (a valid movement root) —
        // benefit of the doubt; the checker owns kind validation.
        for (const { name, alias } of statement.names) {
          this.graphRoots.add(alias ?? name);
        }
      }
      // A bare adapter import is NOT a graph root — instantiation is
      // explicit (`go = manual()`). A movement param typed against a bare
      // import (`<manual-[:Invocation]->>`) is therefore flagged as unsupported,
      // agreeing with the checker's ADAPTER_NOT_CONSTRUCTED error.
    }
    for (const statement of program.statements) this.scanFileStatement(statement);
    return this.found;
  }

  private flag(construct: string): void {
    if (this.seen.has(construct)) return;
    this.seen.add(construct);
    this.found.push(construct);
  }

  // ── File scope ──

  private scanFileStatement(statement: Statement): void {
    switch (statement.kind) {
      case 'import':
        // File imports run since E8 (resolved via EngineHost.files.
        // resolveFile); the imported library's own constructs are
        // scanned by listUnsupportedConstructs' link walk.
        return;
      case 'assign': {
        const value = this.resolvedValue(statement.value);
        switch (value.kind) {
          case 'extract':
          case 'extractCall':
            this.flag('file-level extract expressions');
            return;
          case 'block':
            this.flag('file-level traversal blocks');
            return;
          case 'write':
            this.flag('file-level writes');
            return;
          case 'match':
            this.flag('file-level matches');
            return;
          case 'link':
            this.flag('file-level links');
            return;
          case 'expr':
            this.scanSlot(value.expr);
            return;
          case 'callback':
            // The engine mints it, the router fires it — an interpretable
            // construct since chunk 2. Nothing to scan at file scope (a
            // callback lives inside a movement body).
            return;
          case 'construct':
            // The construction spelling of a CALL (`page = fetch_url(url: …)`)
            // is a call, and the engine refuses it at file scope like one.
            if (this.callableNames.has(value.construct.callee)) {
              this.flag('file-level calls');
            }
            return;
          case 'call':
            this.flag('file-level calls');
            return;
        }
        return;
      }
      case 'movement': {
        // Arity is the CHECKER's territory now: listen/run entries take
        // exactly one parameter (dispatch supplies one event); library
        // movements take any arity (call-fit covers them). Every POSITION
        // param must still be typed against a file-scope graph root (a
        // construction or a shape); a VALUE param (a scalar, a refinement, a
        // list or record of them) is bound to what its argument evaluates to.
        for (const param of statement.params) {
          // An unannotated parameter is refused at save; nothing here to place.
          const type = typeNameOf(param.type);
          if (type === undefined) continue;
          const takesValue =
            type.hopsRaw === undefined
            && (parseFieldTypeName(type.graph) !== undefined || this.declaredTypes.has(type.graph));
          if (!takesValue && !this.graphRoots.has(type.graph)) {
            this.flag(`a movement seeded from '${type.graph}' (not a constructed instance or shape)`);
          }
        }
        this.scanBody(statement.body);
        return;
      }
      default:
        // listen / run / shape / edge contribute nothing to a firing.
        return;
    }
  }

  // ── Movement bodies (recursive through if / parallel / blocks) ──

  /** A combinator's arms are ordinary bodies, scanned like any other. An arm
   *  that is a NAME is a movement (or a closure bound earlier) — scanned where
   *  it was declared, not again here. */
  private scanArms(expr: CombinatorExpression): void {
    if (expr.arms.kind === 'dynamic') {
      this.scanSlot(expr.arms.expr);
      return;
    }
    for (const arm of expr.arms.arms) {
      if (arm.kind === 'closure') this.scanBody(arm.closure.body);
    }
  }

  /** A right-hand side — a binding's, a `return`'s, or a call nested in an
   *  expression (which means the same as binding it first). */
  private scanValue(written: RValue): void {
    const value = this.resolvedValue(written);
    switch (value.kind) {
      case 'construct':
        break;
      case 'call':
        for (const arg of value.call.args) this.scanCallArg(arg);
        break;
      case 'write':
        this.scanWrite(value.write);
        break;
      case 'match':
        this.scanWrite(value.match);
        break;
      case 'link':
        this.scanWrite(value.link.to.match);
        break;
      case 'expr':
        this.scanSlot(value.expr);
        break;
      case 'extract':
        this.scanExtract(value.extract);
        break;
      case 'extractCall':
        // The content is an ordinary expression; the shape and the
        // settings are the extraction module's, which runs them.
        this.scanSlot(value.extractCall.content);
        break;
      case 'block':
        this.scanHead(value.block.head);
        this.scanBody(value.block.body);
        break;
      case 'node':
        this.scanNode(value.node);
        break;
      case 'lazy':
        // A deferred traversal is a traversal — the same head every
        // block runs, held rather than walked. Its per-item tail is a
        // node literal, and gets scanned as one.
        this.scanHead(value.lazy.head);
        if (value.lazy.mapping) this.scanNode(value.lazy.mapping);
        break;
      case 'callback': {
        // Interpretable since chunk 2 — but what it DEFERS is scanned
        // like any other body: an unsupported construct inside a callback
        // body is one this movement cannot run, whenever it runs.
        const subject = value.callback.subject;
        if (subject.kind === 'inline') this.scanBody(subject.closure.body);
        else {
          for (const arg of subject.args) this.scanCallArg(arg);
        }
        break;
      }
      case 'closure':
        // A closure's body runs when it is CALLED, and an unsupported
        // construct inside one is unsupported whenever that happens.
        this.scanBody(value.closure.body);
        break;
      case 'inlineBlock':
        this.flag("reading a block's inner binding by name ('{ … }.name')");
        break;
      case 'combinator':
        this.scanArms(value.combinator);
        break;
      case 'collection': {
        // The op runs its function once per member, so the function's
        // body is body this movement runs.
        const op = value.collection;
        this.scanSlot(op.source);
        if (op.init !== undefined) this.scanSlot(op.init);
        if (op.fn.kind === 'closure') this.scanBody(op.fn.closure.body);
        break;
      }
      case 'members':
        // A list of a type's own values — nothing runs.
        break;
      case 'await':
        if (value.await.source.kind === 'combinator') {
          this.scanArms(value.await.source.combinator);
        } else if (
          value.await.source.kind === 'until'
          && value.await.source.condition.kind === 'closure'
        ) {
          this.scanBody(value.await.source.condition.closure.body);
        }
        break;
    }
  }

  private scanBody(statements: Statement[]): void {
    for (const statement of statements) {
      switch (statement.kind) {
        case 'import':
          this.scanFileStatement(statement);
          break;
        // A binding and a `return` take the same right-hand side, so what a
        // scan makes of one it makes of the other.
        case 'assign':
          if (statement.value.kind === 'closure') this.closureNames.add(statement.name);
          this.scanValue(statement.value);
          break;
        case 'return':
          this.scanValue(statement.value);
          break;
        case 'write':
          this.scanWrite(statement.write);
          break;
        case 'error':
          // ERROR() runs (it fails the run with a reason) — scan its message.
          this.scanSlot(statement.message);
          break;
        case 'if':
          for (const arm of statement.arms) {
            this.scanCondition(arm.condition);
            this.scanBody(arm.body);
          }
          if (statement.elseArm) this.scanBody(statement.elseArm.body);
          break;
        case 'combinator':
          this.scanArms(statement.combinator);
          break;
        case 'await':
          if (statement.await.source.kind === 'combinator') {
            this.scanArms(statement.await.source.combinator);
          } else if (
            statement.await.source.kind === 'until'
            && statement.await.source.condition.kind === 'closure'
          ) {
            this.scanBody(statement.await.source.condition.closure.body);
          }
          break;
        case 'call': {
          // `MAP(xs, f)` run bare is the collection statement it resolves to.
          const reading = this.reading(statement, 'statement');
          if (reading.kind === 'collection') {
            this.scanCollection(reading.collection);
            break;
          }
          // Calls run (composition) — same-file and imported callees
          // alike (E8). Arguments still carry expression slots / inline
          // shape-writes — scan them.
          for (const arg of statement.args) this.scanCallArg(arg);
          break;
        }
        case 'match':
          // A match runs the write path's identity half (resolve +
          // arbitrate, never create); its body is a write body.
          this.scanWrite(statement.match);
          break;
        case 'link':
          // Link statements run (E7 — the Adapter.linkRecords seam).
          // Runtime-dependent rejections (cross-graph endpoints, an
          // adapter without the capability) are not statically decidable
          // here — like other binding-kind checks they surface as failed
          // runs. A body is the match it desugars to.
          if (statement.link.to.kind === 'match') this.scanWrite(statement.link.to.match);
          break;
        case 'unlink':
          // The inverse of the bare-handle link (the Adapter.unlinkRecords
          // seam) runs; runtime-dependent rejections surface as failed
          // runs, as above.
          break;
        case 'delete':
          // Record removal runs (`delete <handle>` — the adapter's
          // deleteRecord). Capability-less adapters reject at runtime,
          // by name, like the link statements above.
          break;
        case 'block':
          this.scanHead(statement.block.head);
          this.scanBody(statement.block.body);
          break;
        case 'shape':
          // A node declaration in a body runs since the extraction call: it
          // names a shape for that body (`extract(content, Local)`).
          break;
        case 'movement':
          this.flag('nested movement declarations inside a movement body');
          break;
        case 'collection': {
          // A bare collection-op statement (unbound — MAP in particular, run
          // for its function's effects) — same scan as the bound form.
          const op = statement.collection;
          this.scanSlot(op.source);
          if (op.init !== undefined) this.scanSlot(op.init);
          if (op.fn.kind === 'closure') this.scanBody(op.fn.closure.body);
          break;
        }
        default:
          break;
      }
    }
  }

  /** One call argument, whatever form it takes — a nested CALL's own arguments
   *  are more of the same, one level down. */
  private scanCallArg(arg: CallArg): void {
    if (arg.kind === 'write') this.scanWrite(arg.write);
    else if (arg.kind === 'node') this.scanNode(arg.node);
    else if (arg.kind === 'call') {
      // A built-in's call is the expression it computes, scanned as one.
      const reading = this.reading(arg.call, 'argument');
      if (reading.kind === 'value') this.scanSlot(reading.expr);
      else for (const nested of arg.call.args) this.scanCallArg(nested);
    }
    // A function handed to a built-in runs once per member, so its body is
    // body this movement runs; a type runs nothing.
    else if (arg.kind === 'closure') this.scanBody(arg.closure.body);
    else if (arg.kind === 'type') return;
    else this.scanSlot(arg.expr);
  }

  /** How a call reads once its callee is resolved, as the checker and the
   *  engine read it. */
  private reading(call: CallStatement, position: CallPosition): CallReading {
    return readCall(call, (callee) => resolveCallee(callee, this.callScope, this.languageVersion), position);
  }

  /** A bound or returned call to a built-in, as the form it resolves to;
   *  every other right-hand side unchanged. */
  private resolvedValue(value: RValue): RValue {
    if (value.kind !== 'call') return value;
    const reading = this.reading(value.call, 'value');
    switch (reading.kind) {
      case 'value':
        return { kind: 'expr', expr: reading.expr };
      case 'collection':
        return { kind: 'collection', collection: reading.collection };
      case 'members':
        return { kind: 'members', members: reading.members };
      case 'function':
      case 'refused':
        // A refusal is the checker's to report; its arguments still scan.
        return value;
    }
  }

  /** A collection op runs its function once per member, so the function's
   *  body is body this movement runs. */
  private scanCollection(op: CollectionOpExpression): void {
    this.scanSlot(op.source);
    if (op.init !== undefined) this.scanSlot(op.init);
    if (op.fn.kind === 'closure') this.scanBody(op.fn.closure.body);
  }

  /** A node literal computes and nothing else — its value entries are ordinary
   *  expression slots, and its nested literals are more of the same. Not a
   *  field-function context: there is no adapter behind a synthesised node to
   *  advertise functions. */
  private scanNode(node: NodeLiteral): void {
    for (const entry of node.entries) {
      if (entry.kind === 'value') this.scanSlot(entry.value);
      // A traversal entry is a hop chain — the hops themselves carry no
      // interpretability question. Its ROOT can be an expression, though, and
      // its per-item tail is a literal.
      else if (entry.kind === 'traversal') {
        this.scanHead(entry.head);
        if (entry.mapping) this.scanNode(entry.mapping);
      }
      // A declared edge is a TYPE and nothing else — no slot, no literal.
      else if (entry.kind === 'nodes') for (const nested of entry.nodes) this.scanNode(nested);
    }
  }

  private scanWrite(write: WriteExpression | MatchExpression): void {
    // The fields of an ADAPTER-target write are a field-function
    // context: the write path binds the destination field's advertised
    // functions at runtime, so whether a non-built-in name resolves
    // depends on the live descriptor — not statically decidable here
    // (an unadvertised name still fails the run loud, per name). Shape
    // writes have no adapter; their fields stay flagged.
    const linkedRoot =
      write.target.kind === 'linked' ? pathRootName(write.target.path) : undefined;
    const functionBearing = !(linkedRoot !== undefined && this.shapeNames.has(linkedRoot));
    if (functionBearing) this.writeFieldDepth++;
    for (const field of write.fields) this.scanSlot(field.value);
    if (functionBearing) this.writeFieldDepth--;
  }

  private scanExtract(extract: ExtractExpression): void {
    for (const slot of extract.from) this.scanSlot(slot);
    // Stage/node internals (descriptions, through plugins) are the
    // extraction module's territory — it runs them since E2.
  }

  // ── Conditions and expression slots ──

  private scanCondition(written: ExprSlot): void {
    const slot = this.scanNestedCalls(written);
    let condition: MovementCondition;
    try {
      condition = conditionOfSlot(slot);
    } catch (e) {
      if (e instanceof BridgeError) return; // checker territory
      throw e;
    }
    this.scanParsedCondition(condition);
  }

  private scanParsedCondition(condition: MovementCondition): void {
    switch (condition.kind) {
      case 'isTest':
        // Runtime IS runs (a type test against the runtime position's
        // type where known; falsy-skip otherwise — run.ts). The subject
        // may itself be an expression — scan it.
        this.scanParsed(() => parseMovementExpression(condition.subjectRaw));
        return;
      case 'and':
        for (const conjunct of condition.conjuncts) this.scanParsedCondition(conjunct);
        return;
      case 'expr':
        this.scanExpression(condition.expr);
        return;
    }
  }

  /** A traversal head. The hops are a hop chain, not an expression slot — but
   *  the ROOT can be an expression, and an expression written there asks the
   *  same interpretability question it asks anywhere else. */
  private scanHead(head: PathHead): void {
    if (head.root?.kind === 'expression') this.scanSlot(head.root.expr);
  }

  private scanSlot(written: ExprSlot): void {
    const slot = this.scanNestedCalls(written);
    this.scanParsed(() => expressionOfSlot(slot));
  }

  /**
   * The calls nested in a slot's expression that the engine runs (a
   * function's, a collection op, `extract` — movement-lang
   * checker/nested_calls.ts), scanned as the bindings they mean; the slot comes
   * back reading the names they are bound to, so what is left is the pure
   * expression the shared evaluator runs.
   */
  private scanNestedCalls(slot: ExprSlot): ExprSlot {
    let tree: MExpr;
    try {
      tree = treeOfSlot(slot);
    } catch (e) {
      if (e instanceof BridgeError) return slot; // checker territory
      throw e;
    }
    const calls = nestedCalls(
      tree,
      hoistingMemberReads(tree, (call) =>
        runsAsCall(
          call,
          (callee) => resolveCallee(callee, this.callScope, this.languageVersion),
          // The file call scope binds only functions.
          () => true,
        ),
      ),
    );
    if (calls.length === 0) return slot;
    for (const call of calls) {
      try {
        this.scanValue(parseNestedCall(slot, call.at, this.languageVersion));
      } catch (e) {
        if (!(e instanceof MovementParseError)) throw e; // checker territory
      }
    }
    return slotOfTree(slot, readingBoundNames(tree, calls, (call) => `#nested ${call.at.start}`));
  }

  private scanParsed(read: () => Expression): void {
    let expr: Expression;
    try {
      expr = read();
    } catch (e) {
      if (e instanceof BridgeError) return; // checker territory
      throw e;
    }
    this.scanExpression(expr);
  }

  private scanExpression(expr: Expression): void {
    if (!SUPPORTED_EXPRESSION_KINDS.has(expr.type)) {
      this.flag(EXPRESSION_KIND_LABEL[expr.type] ?? `'${expr.type}' expressions`);
    }
    switch (expr.type) {
      case 'list':
        for (const e of expr.elements) this.scanExpression(listElementExpression(e));
        return;
      case 'object':
        for (const entry of expr.entries) this.scanExpression(objectMemberExpression(entry));
        return;
      case 'concat':
        for (const p of expr.parts) this.scanExpression(p);
        return;
      case 'conditional':
        this.scanExpression(expr.condition);
        this.scanExpression(expr.then);
        this.scanExpression(expr.else);
        return;
      case 'arithmetic':
      case 'compare':
        this.scanExpression(expr.left);
        this.scanExpression(expr.right);
        return;
      case 'logical':
        for (const o of expr.operands) this.scanExpression(o);
        return;
      case 'not':
      case 'negate':
        this.scanExpression(expr.expression);
        return;
      case 'resource_traverse':
        if (expr.expressionFilter) this.scanExpression(expr.expressionFilter);
        this.scanExpression(expr.expression);
        return;
      case 'traverse':
        // A terminal property/POSITION read belongs to the traverse —
        // the engine evaluates it as one read; don't descend into it.
        // An `edge_property` terminal is the SAME single field read: the
        // bracket-WHERE grammar parses `alias.`field`` inside a hop filter
        // as edge_property, and the engine reads it as that position's field
        // (see `fieldTerminalId`). Any OTHER terminal (`EXISTS(m-[:files]->)`
        // parses as a traverse whose terminal is the exists — itself
        // supported, scanned for its WHERE) is its own construct.
        if (expr.expression.type !== 'property' && expr.expression.type !== 'edge_property') {
          this.scanExpression(expr.expression);
        }
        return;
      case 'aggregate':
        this.scanExpression(expr.expression);
        return;
      case 'at':
        this.scanExpression(expr.expression);
        this.scanExpression(expr.index);
        return;
      case 'function':
        // Built-ins (the mirrored pure set, FILE(), the namespaced
        // stdlib) run everywhere; a non-built-in name resolves only as
        // a write-field value (the write target's adapter functions,
        // bound at field-mapping time) — outside one it is certainly
        // unsupported, named.
        if (!isMovementBuiltinFunction(expr.fn) && this.writeFieldDepth === 0) {
          this.flag(`non-built-in function calls (${expr.fn.toUpperCase()}())`);
        }
        for (const a of expr.args) this.scanExpression(a);
        return;
      case 'exists':
        if (expr.where) this.scanExpression(expr.where);
        return;
      case 'kg_exists':
      case 'kg_value':
        for (const p of expr.params) this.scanExpression(p);
        return;
      default:
        return;
    }
  }
}
