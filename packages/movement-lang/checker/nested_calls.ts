// NESTED CALLS — a call written inside an expression (language version 3).
//
// Function arguments are ordinary expressions and movements are functions, so
// `f(x) + 1`, `ONLY(extract(content, Company))` and `COUNT(MAP(xs, g))` are
// all expressions. The shared expression tree evaluates the built-ins that
// compute a value; it cannot run a function the program declares, a
// collection op, `MEMBERS` or `extract`. Those are read the way they are read
// everywhere else — as the right-hand side of a binding — and the expression
// reads the name they are bound to:
//
//     y = f(x) + 1      means      #call = f(x)
//                                  y = #call + 1
//
// which is the rewrite authors were told to make by hand while nesting was
// refused. `#` marks the engine's own names, so the bound name is one no
// author can write. The checker checks the binding and the rewritten
// expression; the engine runs them, in the order the text states them and
// only where they are reached (`IF`, `AND`, `OR` and `COALESCE` do not reach an
// arm they do not take). Plan: plans/functional-extract-2026-10-02/
// 2_one_grammar.md, steps 4 and 5.
//
// A call inside a walk's `WHERE`, `ORDER BY` or settings is not one of these:
// those run once per landing, inside the walk, and a call there is refused
// (`MOV_CALL_NESTED`). Nor is one in a `SORT` key, read once per member. Neither is a call inside a closure's body, which runs
// when the closure is called and is read as that body's own expression.

import type { Loc } from '../parser/ast';
import { isMapSpread, type At, type MExpr } from '../parser/expression/tree';
import type { CalleeResolution } from './calls';

export type CallNode = Extract<MExpr, { kind: 'call' }>;

/** The name a nested call is bound to, from where it is written in the file —
 *  so two nested calls never share one. */
export function nestedCallName(where: { start: Loc }): string {
  return `#call@${where.start.line}:${where.start.col}`;
}

/** Whether `name` is one a nested call was bound to. */
export function isNestedCallName(name: string): boolean {
  return name.startsWith('#call@');
}

/** A name node reading `name`, standing where `at` was written. */
export function nameNode(name: string, at: At): MExpr {
  return { kind: 'name', name: { text: name, quoted: true, at }, at };
}

/**
 * Whether the call is one the movement engine runs, not the shared evaluator:
 * a function the program declares (`isFunction` says, of the name it was
 * declared under), or a built-in that is not a value — a collection op,
 * `MEMBERS`, `extract`. Anything else (a value built-in, a name nothing
 * declares, a dotted family member) stays in the expression.
 */
export function runsAsCall(
  call: CallNode,
  resolve: (callee: string) => CalleeResolution,
  isFunction: (declared: string) => boolean,
): boolean {
  if (call.callee.kind !== 'name') return false;
  const resolution = resolve(call.callee.name.text);
  switch (resolution.kind) {
    case 'declared':
      return isFunction(resolution.name);
    case 'builtin':
      return resolution.builtin.form.kind !== 'value';
    case 'unknown':
      return false;
  }
}

/**
 * `SORT(xs, key)`'s key — an expression over each MEMBER, read once per member
 * before the sort, as the expression grammar lowers it (`SORT(xs, DESC)` has
 * a direction and no key). Undefined for any other call, and for a `SORT`
 * given no key. It is the one built-in argument read per member: every other
 * built-in reads its arguments once, where it is called.
 */
export function sortKeyOf(e: CallNode): MExpr | undefined {
  if (e.callee.kind !== 'name' || e.callee.name.text.toUpperCase() !== 'SORT') return undefined;
  const key = e.args[1]?.value;
  if (key === undefined) return undefined;
  const isDirection = key.kind === 'name' && /^(ASC|DESC)$/i.test(key.name.text);
  return isDirection && e.args.length === 2 ? undefined : key;
}

/**
 * The sub-expressions read ONCE, as values, where `e` is evaluated — the
 * positions a nested call may stand in. A walk's hops (their `WHERE`, `ORDER
 * BY`, settings) are read per landing, a `WHERE`'s predicate and a `SORT` key
 * per member, and a closure's body when it is called; a call's callee is a
 * name.
 */
export function valueChildren(e: MExpr): MExpr[] {
  switch (e.kind) {
    case 'literal':
    case 'name':
    case 'special':
    case 'type':
    case 'declaration':
    case 'closure':
    case 'node':
    case 'graph':
    case 'mapped':
    case 'lazy':
      return [];
    case 'string':
      return e.parts.filter((p): p is MExpr => typeof p !== 'string');
    case 'paren':
      return [e.expr];
    case 'list':
      return e.elements.map(x => (x.kind === 'spread' ? x.expr : x));
    case 'map':
      return e.entries.map(x => (isMapSpread(x) ? x.expr : x.value));
    case 'member':
      return [e.object];
    case 'index':
      return [e.object, e.index];
    case 'call': {
      const key = sortKeyOf(e);
      return e.args.map(a => a.value).filter(value => value !== key);
    }
    case 'path':
      return e.root !== undefined ? [e.root] : [];
    case 'unary':
      return [e.operand];
    case 'binary':
      return [e.left, e.right];
    case 'exists':
    case 'within':
      return [e.operand];
    case 'where':
      return [e.source];
    case 'is':
      return [e.subject];
    case 'if':
      return [e.condition, e.then, ...(e.else ? [e.else] : [])];
  }
}

/** `e` with each value child replaced by `replace`'s answer for it (the
 *  child itself where it answers undefined). Everything else is kept. */
export function withValueChildren(e: MExpr, replace: (child: MExpr) => MExpr | undefined): MExpr {
  const r = (child: MExpr): MExpr => replace(child) ?? child;
  switch (e.kind) {
    case 'literal':
    case 'name':
    case 'special':
    case 'type':
    case 'declaration':
    case 'closure':
    case 'node':
    case 'graph':
    case 'mapped':
    case 'lazy':
      return e;
    case 'string':
      return { ...e, parts: e.parts.map(p => (typeof p === 'string' ? p : r(p))) };
    case 'paren':
      return { ...e, expr: r(e.expr) };
    case 'list':
      return { ...e, elements: e.elements.map(x => (x.kind === 'spread' ? { ...x, expr: r(x.expr) } : r(x))) };
    case 'map':
      return { ...e, entries: e.entries.map(x => (isMapSpread(x) ? { ...x, expr: r(x.expr) } : { ...x, value: r(x.value) })) };
    case 'member':
      return { ...e, object: r(e.object) };
    case 'index':
      return { ...e, object: r(e.object), index: r(e.index) };
    case 'call': {
      const key = sortKeyOf(e);
      return { ...e, args: e.args.map(a => (a.value === key ? a : { ...a, value: r(a.value) })) };
    }
    case 'path':
      return e.root !== undefined ? { ...e, root: r(e.root) } : e;
    case 'unary':
      return { ...e, operand: r(e.operand) };
    case 'binary':
      return { ...e, left: r(e.left), right: r(e.right) };
    case 'exists':
    case 'within':
      return { ...e, operand: r(e.operand) };
    case 'where':
      return { ...e, source: r(e.source) };
    case 'is':
      return { ...e, subject: r(e.subject) };
    case 'if':
      return { ...e, condition: r(e.condition), then: r(e.then), ...(e.else ? { else: r(e.else) } : {}) };
  }
}

/**
 * The calls in `tree` the engine runs, standing where a value is read —
 * outermost only (a call among another's arguments is read with that call),
 * left to right.
 */
export function nestedCalls(tree: MExpr, runs: (call: CallNode) => boolean): CallNode[] {
  const found: CallNode[] = [];
  const visit = (e: MExpr): void => {
    if (e.kind === 'call' && runs(e)) {
      found.push(e);
      return;
    }
    for (const child of valueChildren(e)) visit(child);
  };
  visit(tree);
  return found;
}

/**
 * `runs`, widened to the calls in `tree` whose value a member access reads —
 * `ONLY(xs).name`, `AT(rows, 0).name` — whatever they call (a family member,
 * `TEXT.SERIALISE(…)`, is read inside its family, never bound). The shared
 * expression tree reads a field only off a name, so such a call is bound to
 * one first, exactly as a call the engine runs is: `f(x).field` means the
 * field of what `f(x)` gave back, for every `f`.
 */
export function hoistingMemberReads(
  tree: MExpr,
  runs: (call: CallNode) => boolean,
): (call: CallNode) => boolean {
  const read = new Set<MExpr>();
  const visit = (e: MExpr): void => {
    if (e.kind === 'member' && e.object.kind === 'call' && e.object.callee.kind === 'name') read.add(e.object);
    for (const child of valueChildren(e)) visit(child);
  };
  visit(tree);
  if (read.size === 0) return runs;
  return call => read.has(call) || runs(call);
}

/** Whether `tree` holds a call the engine runs, where a value is read. */
export function holdsNestedCall(tree: MExpr, runs: (call: CallNode) => boolean): boolean {
  return nestedCalls(tree, runs).length > 0;
}

/** `tree` with every call in `calls` replaced by the name it is bound to. */
export function readingBoundNames(
  tree: MExpr,
  calls: ReadonlyArray<CallNode>,
  nameOf: (call: CallNode) => string,
): MExpr {
  const hoisted = new Set<MExpr>(calls);
  const rewrite = (e: MExpr): MExpr =>
    e.kind === 'call' && hoisted.has(e) ? nameNode(nameOf(e), e.at) : withValueChildren(e, rewrite);
  return rewrite(tree);
}

/** The operators that do not evaluate an operand they do not need. */
export type ShortCircuit =
  | { kind: 'and' | 'or'; left: MExpr; right: MExpr }
  | { kind: 'if'; condition: MExpr; then: MExpr; else?: MExpr }
  | { kind: 'coalesce'; args: MExpr[] };

/** `e` as a short-circuiting operator, if it is one. `isCoalesce` says
 *  whether a callee name resolves to the built-in `COALESCE`. */
export function shortCircuitOf(e: MExpr, isCoalesce: (callee: string) => boolean): ShortCircuit | undefined {
  if (e.kind === 'binary' && (e.op === 'and' || e.op === 'or')) return { kind: e.op, left: e.left, right: e.right };
  if (e.kind === 'if') return { kind: 'if', condition: e.condition, then: e.then, ...(e.else ? { else: e.else } : {}) };
  if (e.kind === 'call' && e.callee.kind === 'name' && isCoalesce(e.callee.name.text)) {
    return { kind: 'coalesce', args: e.args.map(a => a.value) };
  }
  return undefined;
}

/** A condition's top-level `AND` conjuncts, as the lowering splits them. */
export function conjunctsOf(tree: MExpr): MExpr[] {
  if (tree.kind === 'binary' && tree.op === 'and') return [...conjunctsOf(tree.left), ...conjunctsOf(tree.right)];
  return [tree];
}
