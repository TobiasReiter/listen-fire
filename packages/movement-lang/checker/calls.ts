// CALL RESOLUTION — what a call means, once its callee is looked up.
//
// The parser records every call alike (`CallStatement`) and decides nothing
// about its callee. A callee is a name, and a name is resolved by scope: the
// scopes the program declares — locals, parameters, the file and its imports —
// then the standard library (./standard_library.ts), outermost. What it
// resolves to decides how the call is read:
//
//   - a function the program declares (a movement, a plugin, an imported
//     function) runs, and its value is what it returns;
//   - a built-in that computes a value is read as the expression the call is
//     (`CallStatement.expression`);
//   - a collection op is read as the iteration it is (`MAP(xs, f)`);
//   - `MEMBERS(<T>)` is read as the type query it is.
//
// The checker and the engine both read a call through `resolveCallee` and
// `readCall`, each over its own scope, so they cannot disagree about what a
// call is; and the engine runs what resolution says rather than deciding again
// by name. Plan: plans/functional-extract-2026-10-02/2_one_grammar.md, step 3.
//
// Before language version 3 there are no positional calls, so a call is only
// ever a declared function's: the standard library is not consulted, and
// function names keep the letter case they were written with.

import type {
  ArmExpression,
  Program,
  CallArg,
  CallStatement,
  CollectionOp,
  CollectionOpExpression,
  ExprSlot,
  MembersExpression,
  Span,
} from '../parser/ast';
import type { MExpr } from '../parser/expression/tree';
import { scanName } from '../parser/scan';
import type { CallNode } from './nested_calls';
import { since, type LanguageVersion } from '../language_version';
import { builtinUnder, describeBuiltin, type Builtin } from './standard_library';

/** What a call site can see, asked by whoever has the scope (the checker's
 *  `Scope`, the engine's environment). */
export interface CallScope {
  /** Whether the program binds exactly `name` where the call is written — a
   *  local, a parameter, a file-level declaration or an import. */
  binds(name: string): boolean;
  /** The declared name of a FUNCTION in scope — a movement, a plugin or an
   *  imported function — written `name` in some other letter case. Function
   *  names are case-insensitive from language version 3. */
  functionSpelled(name: string): string | undefined;
}

export type CalleeResolution =
  /** The program declares the callee, under `name` (which differs from what
   *  was written only by letter case). Whether it is callable is the
   *  caller's to say: a local holding a value is not. */
  | { kind: 'declared'; name: string }
  | { kind: 'builtin'; builtin: Builtin }
  | { kind: 'unknown' };

/** Look a written callee up: the program's own scopes first, exactly as
 *  written, then (versions 3 and 4) a function in any letter case, then the
 *  standard library. A local therefore shadows a built-in, as TypeScript's
 *  does; a FUNCTION cannot, because declaring one under a built-in's name is
 *  refused. */
export function resolveCallee(
  written: string,
  scope: CallScope,
  languageVersion: LanguageVersion,
): CalleeResolution {
  if (scope.binds(written)) return { kind: 'declared', name: written };
  if (!since(languageVersion, 3)) return { kind: 'unknown' };
  // From version 5 letter case counts (design §4.1): only 3 and 4 fold it.
  const spelled = since(languageVersion, 5) ? undefined : scope.functionSpelled(written);
  if (spelled !== undefined) return { kind: 'declared', name: spelled };
  // A dotted member (`DATE.TODAY`) is never a bare callee: the expression
  // grammar reads it as a member of its family.
  const builtin = builtinUnder(written, languageVersion);
  return builtin !== undefined && !builtin.name.includes('.') ? { kind: 'builtin', builtin } : { kind: 'unknown' };
}

/**
 * Why a built-in call cannot be read as written. `args` — it was handed an
 * argument it does not take (or the wrong number); `unused` — it computes a
 * value, written where nothing receives one.
 */
export type CallRefusal = {
  kind: 'args' | 'unused';
  message: string;
  span: Span;
};

/** The extraction call written inside a walk's `WHERE` or a `SORT` key, where
 *  it would run once per landing or per member. */
export function extractCallNestedMessage(spelled: 'extract' | 'extractOne'): string {
  return `'${spelled}(…)' runs a model over its content, and a walk's WHERE is read once per landing (a SORT key once per member) — bind it first, then use the name: \`found = ${spelled}(content, Shape)\``;
}

export type CallReading =
  /** Run the function the program declares (or report its name unknown). */
  | { kind: 'function' }
  | { kind: 'value'; expr: ExprSlot }
  | { kind: 'collection'; collection: CollectionOpExpression }
  | { kind: 'members'; members: MembersExpression }
  | { kind: 'refused'; refusal: CallRefusal };

/** Where a call is written, which decides what a built-in's reading may be. */
export type CallPosition =
  /** A whole statement — `MAP(xs, f)`, run for its function's effects. */
  | 'statement'
  /** A value bound or returned — `n = UPPER(x)`. */
  | 'value'
  /** An argument of another call — `log(UPPER(x))`, `log(MAP(xs, f))`. Any
   *  built-in written there is the expression it is (`CallStatement.
   *  expression`), and the expression reads a collection op, `MEMBERS` or
   *  `extract` among it as a nested call (./nested_calls.ts). */
  | 'argument';

/**
 * How the call reads at `position`. `resolve` looks a callee up where the call
 * is written (`resolveCallee` over the reader's scope). A built-in's reading
 * also reads every call among its arguments, as an argument, so a refusal
 * there is the whole call's. A function's call reads its arguments where it
 * checks or runs them.
 */
export function readCall(
  call: CallStatement,
  resolve: (callee: string) => CalleeResolution,
  position: CallPosition,
): CallReading {
  const reading = readOneCall(call, resolve(call.callee), position);
  if (reading.kind === 'function' || reading.kind === 'refused') return reading;
  for (const arg of call.args) {
    if (arg.kind !== 'call') continue;
    const nested = readCall(arg.call, resolve, 'argument');
    if (nested.kind === 'refused') return nested;
  }
  return reading;
}

function readOneCall(
  call: CallStatement,
  resolution: CalleeResolution,
  position: CallPosition,
): CallReading {
  if (resolution.kind !== 'builtin') return { kind: 'function' };
  const { builtin } = resolution;
  const refused = (kind: CallRefusal['kind'], message: string): CallReading => ({
    kind: 'refused',
    refusal: { kind, message, span: call.span },
  });
  if (call.args.some((arg) => arg.name !== undefined)) {
    return refused('args', `'${call.callee}' is a built-in, and a built-in takes its arguments in order — ${describeBuiltin(builtin)}`);
  }
  // In an argument, every built-in is the value it computes: the call read as
  // one expression, which reads a collection op, `MEMBERS` or `extract` as a
  // nested call — `log(MAP(xs, f))` is `log(#call)` with `#call = MAP(xs, f)`.
  if (position === 'argument' && builtin.form.kind !== 'value' && call.expression !== undefined) {
    return { kind: 'value', expr: call.expression };
  }
  switch (builtin.form.kind) {
    case 'value': {
      if (position === 'statement') {
        return refused(
          'unused',
          `'${call.callee}(…)' computes a value and does nothing else, so as a statement it is lost — bind it (\`x = ${call.callee}(…)\`) or pass it on`,
        );
      }
      const misfit = call.args.find((arg) => arg.kind !== 'expr' && arg.kind !== 'call');
      if (misfit !== undefined) {
        return refused('args', `'${call.callee}' takes values, not ${describeArgForm(misfit)} — ${describeBuiltin(builtin)}`);
      }
      if (call.expression === undefined) {
        return refused('args', `'${call.callee}' takes ${describeBuiltin(builtin)}`);
      }
      return { kind: 'value', expr: call.expression };
    }
    case 'collection':
      return collectionReading(call, builtin.form.op);
    case 'members': {
      if (position === 'statement') {
        return refused('unused', `'${call.callee}(…)' reads a type's values and does nothing else — bind it: \`values = ${call.callee}(<…>)\``);
      }
      const [only, ...more] = call.args;
      if (only?.kind !== 'type' || more.length > 0) {
        return refused('args', `'${call.callee}' takes one type — a type you declare (${call.callee}(<Thesis>)) or another field's option set (${call.callee}(<crm-[:companies]->.\`funding_stage\`>))`);
      }
      return { kind: 'members', members: { type: only.type, span: call.span, typeSpan: only.span } };
    }
    case 'extract':
      // The grammar reads the extraction call in any letter case, so one never
      // arrives here as a plain call; if one does, it is still not a call
      // this reading can run.
      return refused('args', `'${call.callee}(…)' is the extraction call — bind what it finds: \`found = ${call.callee}(content, Shape)\``);
  }
}

/** The message for a call the engine runs — a function's, a collection op,
 *  `MEMBERS` — written inside a walk's `WHERE`, `ORDER BY` or settings, which
 *  are read once per landing. */
export function nestedMessage(callee: string): string {
  return `'${callee}(…)' runs once where it is written, and a walk's WHERE, ORDER BY and settings are read once per landing — bind it first, then use the name: \`answer = ${callee}(…)\``;
}

/**
 * The built-in arguments read only when written in place, as text: the
 * expression grammar keeps a literal there and drops anything computed —
 * silently, before language version 3. A knowledge-graph query is text the
 * engine parses as a query, so it is written out and given its values as
 * parameters, never assembled; a separator is spelled where it is used.
 */
const LITERAL_TEXT_ARGS: Readonly<Record<string, { index: number; message: string }>> = {
  KG_EXISTS: {
    index: 0,
    message: 'reads its query only as text written in place ("MATCH …") — a computed query is not read. Write the query out, and pass the values it needs as its parameters ($0, $1, …)',
  },
  KG_VALUE: {
    index: 0,
    message: 'reads its query only as text written in place ("MATCH …") — a computed query is not read. Write the query out, and pass the values it needs as its parameters ($0, $1, …)',
  },
  JOIN: {
    index: 1,
    message: 'reads its separator only as text written in place (`JOIN(xs, ", ")`) — a computed one is not read',
  },
};

/** The argument of `call` a built-in would drop because it is computed, not
 *  written in place, with why. */
export function computedArgNotRead(builtin: Builtin, call: CallNode): { arg: MExpr; message: string } | undefined {
  const literal = LITERAL_TEXT_ARGS[builtin.name];
  if (literal === undefined) return undefined;
  const arg = call.args[literal.index]?.value;
  if (arg === undefined || isTextWrittenInPlace(arg)) return undefined;
  return { arg, message: literal.message };
}

function isTextWrittenInPlace(e: MExpr): boolean {
  if (e.kind === 'paren') return isTextWrittenInPlace(e.expr);
  return e.kind === 'string' && e.parts.every(part => typeof part === 'string');
}

/**
 * The built-ins the catalog lists that the movement engine has no way to run.
 * A call to one passed the save check and then failed the run. `LLM_AGG`'s
 * instruction never reached a model either: it was lowered into the place
 * JOIN's separator goes.
 */
const NOT_RUN: Readonly<Record<string, string>> = {
  LLM_AGG:
    "is not run by the movement engine — the run would fail where it is reached, and its instruction never reaches a model. Join the members and ask the model directly: `notes = JOIN(xs, \"\\n\")`, then `AI(\"Summarise these: ${notes}\")`",
};

/** Why the movement engine cannot run `builtin`, when it cannot. */
export function builtinNotRun(builtin: Builtin): string | undefined {
  return NOT_RUN[builtin.name];
}

/** The message for a call the engine runs written inside a `SORT` key, which
 *  is read once per member — the call would run once, and every member would
 *  sort by its one answer. */
export function sortKeyNestedMessage(callee: string): string {
  return `'${callee}(…)' runs once where it is written, and SORT reads its key once per member — every member would sort by that one answer. Work the key out per member first, then sort by it: \`keyed = MAP(xs, (x) => { return { item: x, key: ${callee}(…) } })\`, then \`SORT(keyed, key)\``;
}

function describeArgForm(arg: CallArg): string {
  switch (arg.kind) {
    case 'expr':
    case 'call':
      return 'a value';
    case 'closure':
      return 'a function';
    case 'type':
      return 'a type';
    case 'node':
      return 'a node literal';
    case 'write':
      return 'a write';
  }
}

/**
 * `MAP(xs, f)` / `MAP(xs, { … }, f)` / `REDUCE(xs, init, f)` / `GROUPBY(xs, key)`
 * — the call's arguments in the places the op reads them. The rules are the
 * ones the op's own grammar enforced before language version 3
 * (`Parser.parseCollectionOp`), said in the same words.
 */
function collectionReading(call: CallStatement, op: CollectionOp): CallReading {
  // `sort` by a function key is spelled `sort` wherever it is named: the
  // tree's `SORTBY` is no spelling (`SORT_BY`).
  const spelling = op === 'sort' ? 'sort' : call.callee;
  const configurable = op === 'map' || op === 'filter' || op === 'sort';
  const shape = op === 'reduce'
    ? `${spelling}(<collection>, <starting value>, <function>)`
    : op === 'sort'
      ? 'sort(<collection>, <function>) or sort(<collection>, <function>, { order: "desc" })'
      : configurable
      ? `${spelling}(<collection>, <function>) or ${spelling}(<collection>, { <settings> }, <function>)`
      : `${spelling}(<collection>, <function>)`;
  const refused = (message: string): CallReading => ({
    kind: 'refused',
    refusal: { kind: 'args', message, span: call.span },
  });
  const args = call.args;
  const counts = op === 'reduce' ? [3] : configurable ? [2, 3] : [2];
  if (!counts.includes(args.length)) {
    return refused(
      args.length < 2
        ? `'${spelling}' takes ${shape} — the function is missing`
        : `'${spelling}' takes ${shape}`,
    );
  }
  const source = valueSlot(args[0]);
  if (typeof source === 'string') return refused(`${source} for the collection '${spelling}' reads`);
  let init: ExprSlot | undefined;
  let config: ExprSlot | undefined;
  if (op === 'reduce') {
    const slot = valueSlot(args[1]);
    if (typeof slot === 'string') return refused(`${slot} for the value '${spelling}' starts from`);
    init = slot;
  } else if (args.length === 3) {
    const slot = valueSlot(args[1]);
    if ((typeof slot === 'string' || !slot.raw.trimStart().startsWith('{')) && op === 'sort') {
      return refused(`'sort' takes its settings as a record written in place, after the function — \`sort(xs, (x) => x.key, { order: "desc" })\``);
    }
    if (typeof slot === 'string' || !slot.raw.trimStart().startsWith('{')) {
      return refused(
        `'${spelling}' takes its settings as a record written in place, between the collection and the function — \`${spelling}(xs, { onError: "warn", concurrency: 4 }, f)\``,
      );
    }
    config = slot;
  }
  const fn = armOf(args[args.length - 1], spelling);
  if (typeof fn === 'string') return refused(fn);
  return {
    kind: 'collection',
    collection: {
      op,
      source,
      ...(init !== undefined ? { init } : {}),
      ...(config !== undefined ? { config } : {}),
      fn,
      span: call.span,
    },
  };
}

/** A value argument's expression, or why it is not one. A nested positional
 *  call is its own reading as an expression, so `MAP(SPLIT(t, ","), f)` reads
 *  `SPLIT(t, ",")` as the value it computes. */
function valueSlot(arg: CallArg): ExprSlot | string {
  switch (arg.kind) {
    case 'expr':
      return arg.expr;
    case 'call':
      return arg.call.expression ?? `a named call is not a value — bind '${arg.call.callee}(…)' first`;
    case 'closure':
    case 'type':
    case 'node':
    case 'write':
      return `${describeArgForm(arg)} is not a value`;
  }
}

/** The function argument — a closure written in place, or a function's name. */
function armOf(arg: CallArg, spelling: string): ArmExpression | string {
  switch (arg.kind) {
    case 'closure':
      return { kind: 'closure', closure: arg.closure, span: arg.span };
    case 'expr': {
      const raw = arg.expr.raw.trim();
      const scanned = scanName(raw, 0);
      if (scanned !== null && scanned.end === raw.length) {
        return { kind: 'ref', name: scanned.name, span: arg.expr.span };
      }
      return `The function for '${spelling}' is a function's name, or a closure (\`(x) => { … }\`) — not the expression '${raw}'`;
    }
    case 'call':
      return `'${arg.call.callee}(…)' CALLS the function here; '${spelling}' is given the function itself, so it can call it. Write '${arg.call.callee}', or wrap the call: \`() => { ${arg.call.callee}(…) }\``;
    case 'type':
    case 'node':
    case 'write':
      return `The function for '${spelling}' is a function's name, or a closure (\`(x) => { … }\`) — not ${describeArgForm(arg)}`;
  }
}

/**
 * A call scope for a reader with no checker scope to ask — the story, the
 * editor's selectors, the engine's static scans. In a program that checks, a
 * call can only name a function, and every function is declared at file level
 * (a movement, a plugin import, a file import); `names` is that set.
 */
export function fileCallScope(names: Iterable<string>): CallScope {
  const exact = new Set(names);
  const folded = new Map<string, string>();
  for (const name of exact) folded.set(name.toLowerCase(), name);
  return {
    binds: (name) => exact.has(name),
    functionSpelled: (name) => folded.get(name.toLowerCase()),
  };
}

/** `fileCallScope` over the functions a program declares at file level. */
export function programCallScope(program: Program): CallScope {
  const names: string[] = [];
  for (const statement of program.statements) {
    if (statement.kind === 'movement') names.push(statement.name);
    else if (
      statement.kind === 'import'
      && (statement.source.kind === 'file' || statement.source.namespace === 'plugins')
    ) {
      for (const { name, alias } of statement.names) names.push(alias ?? name);
    }
  }
  return fileCallScope(names);
}
