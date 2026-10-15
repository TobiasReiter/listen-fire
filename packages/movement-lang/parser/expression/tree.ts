// The movement expression tree — what one grammar, owned by the movement
// language, makes of an expression. Plan: plans/functional-extract-2026-10-02/
// 2_one_grammar.md, step 1.
//
// The tree records what was WRITTEN and decides nothing about what a name
// means: `COUNT(x)`, `AI(p)` and `upper(s)` are all one `call`, and `EXISTS`
// is a call like any other. Meaning belongs to whoever has a scope — today the
// lowering to the shared expression tree (./lower.ts), later the checker.
//
// Offsets are character offsets into the text the parser was given.

export interface At {
  start: number;
  end: number;
}

/** A name as written: bare (`companies`) or backtick-quoted (`` `Funding Round` ``).
 *  The two are the same name; `quoted` only records the spelling. */
export interface Name {
  text: string;
  quoted: boolean;
  at: At;
}

export type BinaryOp =
  | 'or'
  | 'and'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'contains'
  | 'in'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%';

export interface CallArg {
  /** `f(m: msg)` — a movement call's named argument. Built-ins are positional. */
  name?: Name;
  value: MExpr;
}

export interface MapEntry {
  key: Name | { text: string; quoted: 'string'; at: At };
  value: MExpr;
}

/** `...m` among a map literal's entries — `m`'s keys (a map's, or a record's
 *  fields) copied in place, a later key winning over an earlier one. */
export interface MapSpread {
  kind: 'spread';
  expr: MExpr;
  at: At;
}

/** One member of a map literal, in the order written. */
export type MapMember = MapEntry | MapSpread;

export function isMapSpread(member: MapMember): member is MapSpread {
  return 'kind' in member;
}

/**
 * One hop of a walk: `-[alias:label WHERE … {config} ORDER BY … DESC LIMIT n]->`.
 *
 * The label is a NAME, read the way the formula grammar always read it: a
 * backtick-quoted name, or everything up to the bracket's next clause — so
 * `-[:Funding Round]->` names the same edge as `` -[:`Funding Round`]-> ``.
 * A meta label (`#extract`, `#transform`, `#linked`, `#resources`) keeps its
 * `#`, and a resource hop's type shorthand (`_resources:TEXT`) its colon: both
 * are part of what was written.
 */
export interface Hop {
  direction: 'out' | 'in';
  /** `]->` or the bare `]-` the formula grammar also accepts on an outgoing hop. */
  arrow: '->' | '-';
  alias?: Name;
  label: Name;
  where?: MExpr;
  config?: Extract<MExpr, { kind: 'map' }>;
  orderBy?: { key: MExpr; direction?: 'asc' | 'desc' };
  limit?: number;
  at: At;
}

/** `<number>`, `<crm-[:company]->>`, `<text[]>`, `<{ mode: text }>`,
 *  `<text | null>`, `<crm-[:companies]->.\`stage\`>`, `<"A" | "B">`. */
export type TypeExpr =
  | {
      kind: 'named';
      name: Name;
      hops: Hop[];
      /** A borrowed field: `<crm-[:companies]->.\`funding_stage\`>`. */
      field?: Name;
      array: boolean;
      at: At;
    }
  | { kind: 'record'; members: Array<{ name: Name; optional: boolean; type: TypeExpr }>; array: boolean; at: At }
  | { kind: 'literal'; value: string | null; at: At }
  | { kind: 'union'; members: TypeExpr[]; at: At };

/** A declared node's member: a typed field or a nested node. */
export type DeclarationMember =
  | { kind: 'field'; name: Name; type: TypeExpr; description?: MExpr; at: At }
  | { kind: 'node'; declaration: NodeDeclaration };

export interface NodeDeclaration {
  name: Name;
  extends?: Name;
  description?: MExpr;
  members: DeclarationMember[];
  /** A nested node's `} order by arrival`. */
  sequenced?: Name;
  at: At;
}

/** One `name: value` of a node or graph literal. The value's kind decides what
 *  the entry builds; the grammar only records it. */
export interface LiteralEntry {
  name: Name;
  /** `<…>` — the DECLARED edge, empty until linked to; `order by arrival`
   *  says its landings keep an order. */
  value: MExpr | { kind: 'declaredEdge'; type: TypeExpr; sequenced?: Name; at: At };
  at: At;
}

export interface Param {
  name: Name;
  type?: TypeExpr;
}

export type MExpr =
  | { kind: 'literal'; value: number | boolean | null; at: At }
  /** A quoted string. `parts` alternates text and `${…}` interpolations; a
   *  string without one is a single text part. Escapes are already applied. */
  | { kind: 'string'; quote: '"' | "'"; parts: Array<string | MExpr>; at: At }
  | { kind: 'name'; name: Name; at: At }
  /** `@meta`, `@parent.created`, `@resource.url` */
  | { kind: 'special'; text: string; at: At }
  | { kind: 'paren'; expr: MExpr; at: At }
  | { kind: 'list'; elements: Array<MExpr | { kind: 'spread'; expr: MExpr; at: At }>; at: At }
  | { kind: 'map'; entries: MapMember[]; at: At }
  | { kind: 'member'; object: MExpr; property: Name; at: At }
  | { kind: 'index'; object: MExpr; index: MExpr; at: At }
  | { kind: 'call'; callee: MExpr; args: CallArg[]; at: At }
  /** A walk. `root` absent = rootless (`-[:notes]->`), walking from wherever
   *  the expression is evaluated. A path is a value in its own right — the
   *  positions it lands on — and `.name` after it reads a property of each. */
  | { kind: 'path'; root?: MExpr; hops: Hop[]; at: At }
  | { kind: 'unary'; op: 'not' | '-'; operand: MExpr; at: At }
  | { kind: 'binary'; op: BinaryOp; left: MExpr; right: MExpr; at: At }
  /** `x EXISTS` — the postfix presence test. */
  | { kind: 'exists'; operand: MExpr; at: At }
  /** `field WITHIN 30d` — `duration` is the literal as written (`30d`, `"30d"`). */
  | { kind: 'within'; operand: MExpr; duration: { text: string; quoted: boolean; at: At }; at: At }
  /** `collection WHERE predicate` — a filter, written inside a call's
   *  parentheses (`EXISTS(rec-[:company]-> WHERE name == "Acme")`). Loosest
   *  binding of all, as it always was: the predicate runs to the close. */
  | { kind: 'where'; source: MExpr; predicate: MExpr; at: At }
  /** `subject IS <Type>` — a type guard. */
  | { kind: 'is'; subject: MExpr; type: TypeExpr; at: At }
  | { kind: 'if'; condition: MExpr; then: MExpr; else?: MExpr; at: At }
  /** `<Type>` where a value is written — a shape passed as a value. */
  | { kind: 'type'; type: TypeExpr; at: At }
  /** `(x) => { … }` / `(x) => (expr)`. A block body is STATEMENTS — the
   *  statement layer's grammar, not this one — so it is kept as its source
   *  extent (`body.at`), braces included. */
  | {
      kind: 'closure';
      params: Param[];
      body: { kind: 'block'; at: At } | { kind: 'expr'; expr: MExpr };
      at: At;
    }
  /** `node { … }` — an anonymous record. */
  | { kind: 'node'; entries: LiteralEntry[]; at: At }
  /** `graph { … }` / `graph<Shape> { … }`. */
  | { kind: 'graph'; shape?: Name; entries: LiteralEntry[]; spreads: MExpr[]; at: At }
  /** `node X: "…" { … }` — an inline declaration. */
  | { kind: 'declaration'; declaration: NodeDeclaration; at: At }
  /** `m-[a:Attachments]-> node { … }` / `m-[a:Attachments]-> { … }` in a graph
   *  body — each landing of the walk, built into the body. */
  | { kind: 'mapped'; source: MExpr; body: MExpr; at: At }
  /** `lazy m-[a:Attachments]->` in a node literal's entry — the walk deferred
   *  to every read. */
  | { kind: 'lazy'; walk: MExpr; at: At };
