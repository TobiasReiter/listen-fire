// One expression grammar for the movement language — a precedence-climbing
// parser that builds the structured tree in ./tree.ts. Plan:
// plans/functional-extract-2026-10-02/2_one_grammar.md.
//
// Every expression slot is read here: ./lower.ts converts the tree to the
// shared `Expression`, and expression/bridge.ts is the entry the statement
// parser's consumers (checker, story, engine) call.
//
// Precedence and associativity are the formula grammar's
// (packages/shared/expression/formula.ts), loosest first:
//
//   where    = or ('WHERE' or)?                — a filter, inside a call's parens
//   or       = and ('OR' and)*
//   and      = not ('AND' not)*
//   not      = ('NOT' | '!') not | compare
//   compare  = add (cmp add | 'CONTAINS' add | 'IN' add | 'EXISTS'
//                   | 'WITHIN' duration | 'IS' type)?          — never chains
//   add      = mul (('+' | '-') mul)*
//   mul      = unary (('*' | '/' | '%') unary)*
//   unary    = '-' unary | postfix
//   postfix  = primary ('.' name | '(' args ')' | hop+ | '[' where ']')*
//   primary  = '(' where ')' | closure | IF | literal | string | name | '@…'
//            | hop+ | list | map | '<' type '>' | node | graph | declaration
//
// Nothing here knows what a name means. `COUNT(x)`, `EXISTS(p)` and
// `CURRENCY.PARSE(s)` are calls; which built-in (if any) a call reaches is
// decided by whoever has a scope.

import { translateStringEscape, unrecognisedCharacterMessage } from '@listen-fire/shared/expression/formula';
import { BridgeError } from '../../expression/error';
import { callStyleIfMessage } from '../scan';
import type {
  At,
  BinaryOp,
  CallArg,
  DeclarationMember,
  Hop,
  LiteralEntry,
  MapEntry,
  MapMember,
  MExpr,
  Name,
  NodeDeclaration,
  Param,
  TypeExpr,
} from './tree';

export class ExpressionSyntaxError extends BridgeError {
  constructor(
    message: string,
    public readonly offset: number,
  ) {
    super(message, offset);
    this.name = 'ExpressionSyntaxError';
  }
}

/** The formula grammar's reserved words, matched case-insensitively. */
const KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'IF', 'THEN', 'ELSE', 'END', 'TRUE', 'FALSE', 'NULL',
  'CONTAINS', 'EXISTS', 'IN',
]);

const STRAY_PUNCT = new Set(['|', '?', ';']);

/** `crm.company` / `<crm.company>` — the retired dotted type spelling. */
const IS_DOTTED_TYPE =
  /^<?\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*>?$/;
/** `crm` / `crm-[:company]->` — a type without its angle brackets. */
const IS_BARE_TYPE =
  /^(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)(?:-\[\s*:\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*\]->)?$/;

type Interpolation = { start: number; end: number };

type Token = { start: number; end: number; newlineBefore: boolean; spaceBefore: boolean } & (
  | { t: 'number'; text: string }
  | { t: 'string'; quote: '"' | "'"; segments: Array<string | Interpolation> }
  | { t: 'name'; text: string; quoted: boolean }
  | { t: 'keyword'; text: string }
  | { t: 'special'; text: string }
  | { t: 'op'; text: string }
  | { t: 'punct'; text: string }
  /** `-[` or `<-[` opening a hop — the parser reads the hop itself. */
  | { t: 'hop' }
  | { t: 'eof' }
);

/** What the previous token was, for the one lexical rule that looks back: a
 *  `-` directly before a digit is a negative number literal after an operator,
 *  an opening paren, a comma, or at the start — the formula tokenizer's rule. */
type Previous = 'start' | 'operand' | 'opener';

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

/** Parse one expression slot. Throws `ExpressionSyntaxError`. */
export function parseExpression(source: string): MExpr {
  const parser = new ExpressionParser(source, 0, source.length);
  return parser.parseWhole();
}

class ExpressionParser {
  private pos: number;
  private previous: Previous = 'start';
  /** Inside a node or graph literal's entry, a newline at the entry's own
   *  bracket level ends the value — the statement layer's rule for entries. */
  private stopAtNewline = false;
  private lastEnd: number;

  constructor(
    private readonly src: string,
    start: number,
    private readonly limit: number,
  ) {
    this.pos = start;
    this.lastEnd = start;
  }

  parseWhole(): MExpr {
    const expr = this.parseWhere();
    const tok = this.peek();
    if (tok.t !== 'eof') this.unexpected(tok, `Unexpected ${describe(tok, this.src)}`);
    return expr;
  }

  // ── Characters ──

  private ch(offset = 0): string | undefined {
    const i = this.pos + offset;
    return i < this.limit ? this.src[i] : undefined;
  }

  private fail(message: string, offset = this.pos): never {
    throw new ExpressionSyntaxError(message, offset);
  }

  /** A token that cannot stand here. `|`, `?` and `;` lex only for the type
   *  grammar (`<a | b>`, `{ k?: … }`); anywhere else they are the characters
   *  an author reached for from another language, and are refused as such. */
  private unexpected(tok: Token, message: string): never {
    if (tok.t === 'punct' && STRAY_PUNCT.has(tok.text)) this.fail(unrecognisedCharacterMessage(tok.text), tok.start);
    this.fail(message, tok.start);
  }

  private skipWs(): boolean {
    let newline = false;
    while (this.pos < this.limit && /\s/.test(this.src[this.pos])) {
      if (this.src[this.pos] === '\n') newline = true;
      this.pos++;
    }
    return newline;
  }

  // ── Lexing (on demand: the hop, type and closure forms read characters) ──

  private cache: { pos: number; previous: Previous; token: Token } | undefined;

  private peek(): Token {
    if (this.cache && this.cache.pos === this.pos && this.cache.previous === this.previous) {
      return this.cache.token;
    }
    const token = this.lex();
    this.cache = { pos: this.pos, previous: this.previous, token };
    return token;
  }

  private advance(): Token {
    const tok = this.peek();
    this.pos = tok.end;
    this.lastEnd = tok.end;
    this.previous =
      tok.t === 'op' || (tok.t === 'punct' && (tok.text === '(' || tok.text === ','))
        ? 'opener'
        : 'operand';
    return tok;
  }

  /** Put the cursor straight after text the parser read by character. */
  private consumedTo(end: number): void {
    this.pos = end;
    this.lastEnd = end;
    this.previous = 'operand';
  }

  private lex(): Token {
    const save = this.pos;
    const before = this.pos;
    const newlineBefore = this.skipWs();
    const spaceBefore = this.pos > before;
    const start = this.pos;
    this.pos = save;
    const base = { start, newlineBefore, spaceBefore };
    const src = this.src;
    if (start >= this.limit) return { ...base, end: start, t: 'eof' };
    const c = src[start];
    const at = (i: number) => (i < this.limit ? src[i] : undefined);

    if (c === '"' || c === "'") return this.lexString(start, base);
    if (c === '`') {
      const { name, end } = this.scanBacktick(start);
      return { ...base, end, t: 'name', text: name, quoted: true };
    }
    if (
      /[0-9]/.test(c) ||
      (c === '-' && /[0-9]/.test(at(start + 1) ?? '') && this.previous !== 'operand')
    ) {
      let i = start + 1;
      while (i < this.limit && /[0-9.]/.test(src[i])) i++;
      return { ...base, end: i, t: 'number', text: src.slice(start, i) };
    }
    if (c === '@') {
      let i = start + 1;
      while (i < this.limit && /[a-zA-Z0-9_.]/.test(src[i])) i++;
      return { ...base, end: i, t: 'special', text: src.slice(start, i) };
    }
    if ((c === '-' && at(start + 1) === '[' && this.isHopInterior(start + 2)) ||
        (c === '<' && at(start + 1) === '-' && at(start + 2) === '[' && this.isHopInterior(start + 3))) {
      return { ...base, end: start, t: 'hop' };
    }
    if (IDENT_START.test(c)) {
      let i = start + 1;
      while (i < this.limit && IDENT_CHAR.test(src[i])) i++;
      const text = src.slice(start, i);
      const upper = text.toUpperCase();
      if (KEYWORDS.has(upper)) return { ...base, end: i, t: 'keyword', text: upper };
      return { ...base, end: i, t: 'name', text, quoted: false };
    }
    const two = src.slice(start, Math.min(start + 2, this.limit));
    if (two === '!=' || two === '>=' || two === '<=' || two === '==' || two === '=>') {
      return { ...base, end: start + 2, t: 'op', text: two };
    }
    // A lone `!` is TypeScript's spelling of NOT, exactly as in the formula grammar.
    if (c === '!') return { ...base, end: start + 1, t: 'keyword', text: 'NOT' };
    if ('=<>+-*/%'.includes(c)) return { ...base, end: start + 1, t: 'op', text: c };
    if (src.startsWith('...', start) && start + 3 <= this.limit) {
      return { ...base, end: start + 3, t: 'punct', text: '...' };
    }
    if (c === '.') return { ...base, end: start + 1, t: 'op', text: '.' };
    if ('()[]{},:|?;'.includes(c)) return { ...base, end: start + 1, t: 'punct', text: c };
    this.fail(unrecognisedCharacterMessage(characterAt(src, start)), start);
  }

  /** `start` is just inside `-[` / `<-[`: a hop opens with `:`, `#`, or an
   *  alias (`name:`). Anything else is a minus and a list. */
  private isHopInterior(start: number): boolean {
    let i = start;
    while (i < this.limit && /\s/.test(this.src[i])) i++;
    const c = this.src[i];
    if (c === ':' || c === '#') return true;
    let end: number | undefined;
    if (c === '`') {
      let j = i + 1;
      while (j < this.limit && this.src[j] !== '`') j += this.src[j] === '\\' ? 2 : 1;
      if (j >= this.limit) return false;
      end = j + 1;
    } else if (c !== undefined && IDENT_START.test(c)) {
      let j = i + 1;
      while (j < this.limit && IDENT_CHAR.test(this.src[j])) j++;
      end = j;
    }
    if (end === undefined) return false;
    while (end < this.limit && /\s/.test(this.src[end])) end++;
    return this.src[end] === ':';
  }

  private scanBacktick(start: number): { name: string; end: number } {
    let i = start + 1;
    let name = '';
    while (i < this.limit && this.src[i] !== '`') {
      if (this.src[i] === '\\' && i + 1 < this.limit) {
        name += this.src[i + 1];
        i += 2;
        continue;
      }
      name += this.src[i];
      i++;
    }
    if (i >= this.limit) this.fail('Unterminated backtick-quoted name', start);
    return { name, end: i + 1 };
  }

  private lexString(
    start: number,
    base: { start: number; newlineBefore: boolean; spaceBefore: boolean },
  ): Token {
    const quote = this.src[start] as '"' | "'";
    const segments: Array<string | Interpolation> = [];
    let text = '';
    let i = start + 1;
    while (i < this.limit) {
      const c = this.src[i];
      if (c === '\\' && i + 1 < this.limit) {
        text += translateStringEscape(this.src[i + 1]);
        i += 2;
        continue;
      }
      if (quote === '"' && c === '$' && this.src[i + 1] === '{') {
        if (text) segments.push(text);
        text = '';
        const close = this.findInterpolationClose(i + 2);
        segments.push({ start: i + 2, end: close });
        i = close + 1;
        continue;
      }
      if (c === quote) {
        if (text || segments.length === 0) segments.push(text);
        return { ...base, end: i + 1, t: 'string', quote, segments };
      }
      text += c;
      i++;
    }
    this.fail('Unterminated string literal', start);
  }

  /** `start` is just after `${`; the index of the matching `}`. */
  private findInterpolationClose(start: number): number {
    let depth = 1;
    let i = start;
    while (i < this.limit) {
      const c = this.src[i];
      if (c === '"' || c === "'") {
        i = this.skipQuoted(i);
        continue;
      }
      if (c === '`') {
        i = this.scanBacktick(i).end;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return i;
      i++;
    }
    this.fail('Unterminated ${…} interpolation', start - 2);
  }

  /** Index just past a quoted string starting at `start` (interpolations skipped whole). */
  private skipQuoted(start: number): number {
    const quote = this.src[start];
    let i = start + 1;
    while (i < this.limit) {
      const c = this.src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (quote === '"' && c === '$' && this.src[i + 1] === '{') {
        i = this.findInterpolationClose(i + 2) + 1;
        continue;
      }
      if (c === quote) return i + 1;
      i++;
    }
    this.fail('Unterminated string literal', start);
  }

  // ── Token helpers ──

  private canContinue(tok: Token): boolean {
    return !(this.stopAtNewline && tok.newlineBefore);
  }

  private isPunct(tok: Token, text: string): boolean {
    return tok.t === 'punct' && tok.text === text;
  }

  private isOp(tok: Token, text: string): boolean {
    return tok.t === 'op' && tok.text === text;
  }

  private isKeyword(tok: Token, text: string): boolean {
    return tok.t === 'keyword' && tok.text === text;
  }

  /** A contextual word (`WHERE`, `IS`, `WITHIN`, `ASC`): an unquoted name,
   *  matched case-insensitively. Not reserved — a field may still be called it. */
  private isWord(tok: Token, word: string): boolean {
    return tok.t === 'name' && !tok.quoted && tok.text.toUpperCase() === word;
  }

  private expectPunct(text: string, context: string): Token {
    const tok = this.peek();
    if (!this.isPunct(tok, text)) this.unexpected(tok, `Expected '${text}' ${context}, got ${describe(tok, this.src)}`);
    return this.advance();
  }

  private expectOp(text: string, context: string): Token {
    const tok = this.peek();
    if (!this.isOp(tok, text)) this.unexpected(tok, `Expected '${text}' ${context}, got ${describe(tok, this.src)}`);
    return this.advance();
  }

  private expectKeyword(text: string, context: string): Token {
    const tok = this.peek();
    if (!this.isKeyword(tok, text)) this.unexpected(tok, `Expected ${text} ${context}, got ${describe(tok, this.src)}`);
    return this.advance();
  }

  private readName(context: string): Name {
    const tok = this.peek();
    if (tok.t !== 'name') this.unexpected(tok, `Expected a name ${context}, got ${describe(tok, this.src)}`);
    this.advance();
    return { text: tok.text, quoted: tok.quoted, at: { start: tok.start, end: tok.end } };
  }

  private span(start: number): At {
    return { start, end: this.lastEnd };
  }

  /** Run `body` with entry-level newline termination switched on or off. */
  private withNewlines<T>(stop: boolean, body: () => T): T {
    const saved = this.stopAtNewline;
    this.stopAtNewline = stop;
    try {
      return body();
    } finally {
      this.stopAtNewline = saved;
    }
  }

  // ── Precedence levels ──

  private parseWhere(): MExpr {
    const start = this.peek().start;
    const source = this.parseOr();
    const tok = this.peek();
    if (this.isWord(tok, 'WHERE') && this.canContinue(tok)) {
      this.advance();
      const predicate = this.parseOr();
      return { kind: 'where', source, predicate, at: this.span(start) };
    }
    return source;
  }

  private parseBinaryLevel(
    next: () => MExpr,
    ops: (tok: Token) => BinaryOp | undefined,
  ): MExpr {
    const start = this.peek().start;
    let left = next();
    for (;;) {
      const tok = this.peek();
      if (!this.canContinue(tok)) return left;
      const op = ops(tok);
      if (op === undefined) return left;
      this.advance();
      const right = next();
      left = { kind: 'binary', op, left, right, at: this.span(start) };
    }
  }

  private parseOr(): MExpr {
    return this.parseBinaryLevel(
      () => this.parseAnd(),
      tok => (this.isKeyword(tok, 'OR') ? 'or' : undefined),
    );
  }

  private parseAnd(): MExpr {
    return this.parseBinaryLevel(
      () => this.parseNot(),
      tok => (this.isKeyword(tok, 'AND') ? 'and' : undefined),
    );
  }

  private parseNot(): MExpr {
    const tok = this.peek();
    if (this.isKeyword(tok, 'NOT')) {
      this.advance();
      const operand = this.parseNot();
      return { kind: 'unary', op: 'not', operand, at: this.span(tok.start) };
    }
    return this.parseCompare();
  }

  private parseCompare(): MExpr {
    const start = this.peek().start;
    const left = this.parseAdd();
    const tok = this.peek();
    if (!this.canContinue(tok)) return left;
    const symbolic: Record<string, BinaryOp> = {
      '=': '==', '==': '==', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=',
    };
    if (tok.t === 'op' && tok.text in symbolic) {
      this.advance();
      const right = this.parseAdd();
      return { kind: 'binary', op: symbolic[tok.text], left, right, at: this.span(start) };
    }
    if (this.isKeyword(tok, 'CONTAINS') || this.isKeyword(tok, 'IN')) {
      this.advance();
      const right = this.parseAdd();
      const op: BinaryOp = tok.t === 'keyword' && tok.text === 'IN' ? 'in' : 'contains';
      return { kind: 'binary', op, left, right, at: this.span(start) };
    }
    if (this.isKeyword(tok, 'EXISTS')) {
      this.advance();
      return { kind: 'exists', operand: left, at: this.span(start) };
    }
    // `WITHIN` is read whether or not it is backtick-quoted, as the formula
    // grammar reads it; IS only bare.
    if (tok.t === 'name' && tok.text.toUpperCase() === 'WITHIN') {
      this.advance();
      return { kind: 'within', operand: left, duration: this.parseDuration(), at: this.span(start) };
    }
    if (this.isWord(tok, 'IS')) {
      this.advance();
      const typeStart = this.lastEnd;
      let type: TypeExpr;
      try {
        type = this.parseTypeMarker('after IS');
      } catch (e) {
        if (e instanceof ExpressionSyntaxError) this.refuseIsType(typeStart);
        throw e;
      }
      return { kind: 'is', subject: left, type, at: this.span(start) };
    }
    return left;
  }

  /** The fix-it for a type after IS written without its angle brackets, or in
   *  the retired dotted spelling. A bracketed type with a fault inside keeps
   *  the parser's own, more precise, error. */
  private refuseIsType(from: number): void {
    const rest = this.src.slice(from, this.limit);
    const lead = rest.length - rest.trimStart().length;
    const rhs = rest.trim().split(/\s+(?:AND|OR)\s/i)[0].trim();
    const at = from + lead;
    const dotted = IS_DOTTED_TYPE.exec(rhs);
    if (dotted) {
      this.fail(
        `'.' reads a property — a type names an EDGE, and an edge is an address. Write '<${dotted[1]}-[:${dotted[2]}]->>' instead of '<${dotted[1]}.${dotted[2]}>'.`,
        at,
      );
    }
    if (IS_BARE_TYPE.test(rhs)) {
      this.fail(`Types are written in angle brackets — wrap the type in angle brackets: <${rhs}>`, at);
    }
    if (!rhs.startsWith('<')) {
      this.fail(`IS expects a position type in angle brackets like <graph> or <graph-[:position]->>, got "${rhs}"`, at);
    }
  }

  private parseDuration(): { text: string; quoted: boolean; at: At } {
    const tok = this.peek();
    if (tok.t === 'string' && tok.segments.every(s => typeof s === 'string')) {
      this.advance();
      return { text: tok.segments.join(''), quoted: true, at: { start: tok.start, end: tok.end } };
    }
    if (tok.t === 'number') {
      this.advance();
      const unit = this.peek();
      if (unit.t === 'name' && unit.start === tok.end && /^[smhdw]$/i.test(unit.text)) {
        this.advance();
        return { text: `${tok.text}${unit.text}`, quoted: false, at: { start: tok.start, end: unit.end } };
      }
    }
    this.fail('WITHIN expects a duration like 30d, 12h, or 1w', tok.start);
  }

  private parseAdd(): MExpr {
    return this.parseBinaryLevel(
      () => this.parseMul(),
      tok => (tok.t === 'op' && (tok.text === '+' || tok.text === '-') ? tok.text : undefined),
    );
  }

  private parseMul(): MExpr {
    return this.parseBinaryLevel(
      () => this.parseUnary(),
      tok => (tok.t === 'op' && (tok.text === '*' || tok.text === '/' || tok.text === '%') ? tok.text : undefined),
    );
  }

  private parseUnary(): MExpr {
    const tok = this.peek();
    if (this.isOp(tok, '-')) {
      this.advance();
      const operand = this.parseUnary();
      return { kind: 'unary', op: '-', operand, at: this.span(tok.start) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): MExpr {
    const start = this.peek().start;
    let expr = this.parsePrimary();
    for (;;) {
      const tok = this.peek();
      if (!this.canContinue(tok)) return expr;
      if (this.isOp(tok, '.')) {
        this.advance();
        const property = this.readName("after '.'");
        expr = { kind: 'member', object: expr, property, at: this.span(start) };
        continue;
      }
      if (this.isPunct(tok, '(') && (expr.kind === 'name' || expr.kind === 'member')) {
        const args = this.parseCallArgs();
        expr = { kind: 'call', callee: expr, args, at: this.span(start) };
        continue;
      }
      if (tok.t === 'hop') {
        const hops = this.parseHops();
        expr = { kind: 'path', root: expr, hops, at: this.span(start) };
        continue;
      }
      if (this.isPunct(tok, '[') && !tok.spaceBefore) {
        this.advance();
        const index = this.withNewlines(false, () => this.parseWhere());
        this.expectPunct(']', 'to close the index');
        expr = { kind: 'index', object: expr, index, at: this.span(start) };
        continue;
      }
      return expr;
    }
  }

  private parseCallArgs(): CallArg[] {
    this.expectPunct('(', 'to open the arguments');
    return this.withNewlines(false, () => {
      const args: CallArg[] = [];
      if (this.isPunct(this.peek(), ')')) {
        this.advance();
        return args;
      }
      for (;;) {
        let name: Name | undefined;
        const first = this.peek();
        if (first.t === 'name') {
          const save = this.pos;
          const savedPrevious = this.previous;
          this.advance();
          if (this.isPunct(this.peek(), ':')) {
            this.advance();
            name = { text: first.text, quoted: first.quoted, at: { start: first.start, end: first.end } };
          } else {
            this.pos = save;
            this.previous = savedPrevious;
          }
        }
        args.push({ ...(name ? { name } : {}), value: this.parseWhere() });
        const sep = this.peek();
        if (this.isPunct(sep, ',')) {
          this.advance();
          continue;
        }
        this.expectPunct(')', 'to close the arguments');
        return args;
      }
    });
  }

  // ── Primaries ──

  private parsePrimary(): MExpr {
    const tok = this.peek();
    const at = { start: tok.start, end: tok.end };
    switch (tok.t) {
      case 'number': {
        this.advance();
        return { kind: 'literal', value: tok.text.includes('.') ? parseFloat(tok.text) : parseInt(tok.text, 10), at };
      }
      case 'string':
        this.advance();
        return { kind: 'string', quote: tok.quote, parts: tok.segments.map(s => this.interpolation(s)), at };
      case 'special':
        this.advance();
        return { kind: 'special', text: tok.text, at };
      case 'hop': {
        const hops = this.parseHops();
        return { kind: 'path', hops, at: this.span(tok.start) };
      }
      case 'keyword':
        return this.parseKeywordPrimary(tok);
      case 'name':
        return this.parseNamePrimary(tok);
      case 'op':
        if (tok.text === '<') {
          const type = this.parseTypeMarker('as a value');
          return { kind: 'type', type, at: type.at };
        }
        break;
      case 'punct':
        if (tok.text === '(') return this.tryParseClosure() ?? this.parseParen();
        if (tok.text === '[') return this.parseList();
        if (tok.text === '{') return this.parseMap();
        if (tok.text === '...') {
          this.fail("'...' splices a list's members into a list literal — it is written only inside '[ … ]'", tok.start);
        }
        break;
      case 'eof':
        this.fail('Unexpected end of input', tok.start);
    }
    this.unexpected(tok, `Unexpected ${describe(tok, this.src)}`);
  }

  private interpolation(segment: string | Interpolation): string | MExpr {
    if (typeof segment === 'string') return segment;
    if (!this.src.slice(segment.start, segment.end).trim()) this.fail('Empty ${…} interpolation', segment.start - 2);
    return new ExpressionParser(this.src, segment.start, segment.end).parseWhole();
  }

  private parseKeywordPrimary(tok: Extract<Token, { t: 'keyword' }>): MExpr {
    const at = { start: tok.start, end: tok.end };
    switch (tok.text) {
      case 'TRUE':
      case 'FALSE':
      case 'NULL':
        this.advance();
        return { kind: 'literal', value: tok.text === 'NULL' ? null : tok.text === 'TRUE', at };
      case 'IF':
        return this.parseIf();
      case 'EXISTS': {
        // Prefix EXISTS(…) is a call like any other; the keyword stays the
        // postfix operator (`x EXISTS`).
        this.advance();
        if (!this.isPunct(this.peek(), '(')) this.fail('Unexpected EXISTS', tok.start);
        const written = this.src.slice(tok.start, tok.end);
        return { kind: 'name', name: { text: written, quoted: false, at }, at };
      }
      case 'CONTAINS':
        this.fail("CONTAINS is written between its operands — 'a CONTAINS b', not 'CONTAINS(a, b)'", tok.start);
    }
    this.fail(`Unexpected ${tok.text}`, tok.start);
  }

  private parseNamePrimary(tok: Extract<Token, { t: 'name' }>): MExpr {
    if (!tok.quoted && tok.text === 'node') {
      const after = this.lookPast(tok.end);
      if (this.src[after] === '{') return this.parseNodeLiteral();
      if (this.atDeclaration(after)) return this.parseInlineDeclaration();
    }
    if (!tok.quoted && tok.text === 'graph' && this.atGraphLiteral(tok.end)) return this.parseGraphLiteral();
    this.advance();
    const name = { text: tok.text, quoted: tok.quoted, at: { start: tok.start, end: tok.end } };
    return { kind: 'name', name, at: name.at };
  }

  /** The index of the next non-space character at or after `i`. */
  private lookPast(i: number): number {
    while (i < this.limit && /[ \t]/.test(this.src[i])) i++;
    return i;
  }

  private parseParen(): MExpr {
    const open = this.advance();
    const expr = this.withNewlines(false, () => this.parseWhere());
    this.expectPunct(')', "to close '('");
    return { kind: 'paren', expr, at: this.span(open.start) };
  }

  private parseIf(): MExpr {
    const start = this.expectKeyword('IF', '').start;
    const callStyle = callStyleIfMessage(this.src.slice(0, this.limit), this.lookPast(this.pos));
    if (callStyle !== undefined) this.fail(callStyle, start);
    return this.withNewlines(false, () => {
      const condition = this.parseOr();
      this.expectKeyword('THEN', 'after the IF condition');
      const then = this.parseOr();
      if (this.isKeyword(this.peek(), 'ELSE')) {
        this.advance();
        if (this.isKeyword(this.peek(), 'IF')) {
          // The chain form: one END closes the whole chain, and an explicit
          // END per IF is accepted too — the formula grammar's rule.
          const elseIf = this.parseIf();
          if (this.isKeyword(this.peek(), 'END')) this.advance();
          return { kind: 'if', condition, then, else: elseIf, at: this.span(start) };
        }
        const otherwise = this.parseOr();
        this.expectKeyword('END', 'to close the IF');
        return { kind: 'if', condition, then, else: otherwise, at: this.span(start) };
      }
      this.expectKeyword('END', 'to close the IF');
      return { kind: 'if', condition, then, at: this.span(start) };
    });
  }

  private parseList(): MExpr {
    const open = this.advance();
    return this.withNewlines(false, () => {
      const elements: Array<MExpr | { kind: 'spread'; expr: MExpr; at: At }> = [];
      while (!this.isPunct(this.peek(), ']')) {
        const tok = this.peek();
        if (this.isPunct(tok, '...')) {
          this.advance();
          const expr = this.parseWhere();
          elements.push({ kind: 'spread', expr, at: this.span(tok.start) });
        } else {
          elements.push(this.parseWhere());
        }
        if (!this.isPunct(this.peek(), ',')) break;
        this.advance();
      }
      this.expectPunct(']', 'to close the list');
      return { kind: 'list', elements, at: this.span(open.start) };
    });
  }

  private parseMap(): Extract<MExpr, { kind: 'map' }> {
    const open = this.advance();
    return this.withNewlines(false, () => {
      const entries: MapMember[] = [];
      while (!this.isPunct(this.peek(), '}')) {
        const tok = this.peek();
        if (this.isPunct(tok, '...')) {
          this.advance();
          const expr = this.parseWhere();
          entries.push({ kind: 'spread', expr, at: this.span(tok.start) });
          if (!this.isPunct(this.peek(), ',')) break;
          this.advance();
          continue;
        }
        let key: MapEntry['key'];
        if (tok.t === 'name') {
          key = this.readName('as a map key');
        } else if (tok.t === 'string' && tok.segments.every(s => typeof s === 'string')) {
          this.advance();
          key = { text: tok.segments.join(''), quoted: 'string', at: { start: tok.start, end: tok.end } };
        } else if (tok.t === 'keyword') {
          this.fail(`'${tok.text}' is a reserved word — quote it to use it as a map key`, tok.start);
        } else {
          this.fail(`A map key is a name or a quoted string (or '...m' to copy a map's keys), got ${describe(tok, this.src)}`, tok.start);
        }
        this.expectPunct(':', `after the map key '${key.text}'`);
        entries.push({ key, value: this.parseWhere() });
        if (!this.isPunct(this.peek(), ',')) break;
        this.advance();
      }
      this.expectPunct('}', 'to close the map');
      return { kind: 'map', entries, at: this.span(open.start) };
    });
  }

  // ── Hops ──

  private parseHops(): Hop[] {
    const hops: Hop[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok.t !== 'hop' || (hops.length > 0 && !this.canContinue(tok))) return hops;
      hops.push(this.parseHop(tok.start));
    }
  }

  /** One `-[…]->` / `<-[…]-`, read by character from `start`. */
  private parseHop(start: number): Hop {
    this.pos = start;
    const direction: Hop['direction'] = this.ch() === '<' ? 'in' : 'out';
    this.pos += direction === 'in' ? 3 : 2;
    this.skipWs();
    let alias: Name | undefined;
    if (this.ch() === ':') {
      this.pos++;
    } else if (this.ch() !== '#') {
      const aliasStart = this.pos;
      const scanned = this.scanBareOrQuoted();
      alias = { text: scanned.text, quoted: scanned.quoted, at: { start: aliasStart, end: this.pos } };
      this.skipWs();
      if (this.ch() !== ':') this.fail("Expected ':' after the hop's alias", this.pos);
      this.pos++;
    }
    this.skipWs();
    const label = this.readLabel();
    this.skipWs();

    let where: MExpr | undefined;
    let config: Extract<MExpr, { kind: 'map' }> | undefined;
    if (/^WHERE\s/i.test(this.src.slice(this.pos, this.limit))) {
      this.consumedTo(this.pos + 5);
      if (/^\s*\]/.test(this.src.slice(this.pos, this.limit))) {
        this.fail("a hop's WHERE needs a condition — write one after WHERE, or drop the WHERE to keep every landing", this.pos);
      }
      this.previous = 'start';
      where = this.withNewlines(false, () => this.parseOr());
    } else if (this.ch() === '{') {
      this.previous = 'start';
      config = this.withNewlines(false, () => this.parseMap());
    }
    this.skipWs();

    let orderBy: Hop['orderBy'];
    const order = /^ORDER\s+BY\s+/i.exec(this.src.slice(this.pos, this.limit));
    if (order) {
      this.consumedTo(this.pos + order[0].length);
      this.previous = 'start';
      const key = this.withNewlines(false, () => this.parseOr());
      const dir = this.peek();
      let direction: 'asc' | 'desc' | undefined;
      if (this.isWord(dir, 'ASC') || this.isWord(dir, 'DESC')) {
        this.advance();
        direction = dir.t === 'name' && dir.text.toUpperCase() === 'DESC' ? 'desc' : 'asc';
      }
      orderBy = { key, ...(direction ? { direction } : {}) };
      this.skipWs();
    }
    let limit: number | undefined;
    const limitMatch = /^LIMIT\s+(\d+)/i.exec(this.src.slice(this.pos, this.limit));
    if (limitMatch) {
      limit = Number(limitMatch[1]);
      this.pos += limitMatch[0].length;
      this.skipWs();
    }
    if (this.ch() !== ']') this.fail(`Expected ']' to close the hop, got '${this.ch() ?? 'end of input'}'`, this.pos);
    this.pos++;
    let arrow: Hop['arrow'];
    if (direction === 'out' && this.ch() === '-' && this.ch(1) === '>') {
      arrow = '->';
      this.pos += 2;
    } else if (this.ch() === '-') {
      arrow = '-';
      this.pos += 1;
    } else {
      this.fail(direction === 'in' ? "Expected ']-' to close an incoming hop" : "Expected ']->' to close the hop", this.pos);
    }
    this.consumedTo(this.pos);
    return {
      direction,
      arrow,
      ...(alias ? { alias } : {}),
      label,
      ...(where ? { where } : {}),
      ...(config ? { config } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(limit !== undefined ? { limit } : {}),
      at: { start, end: this.pos },
    };
  }

  private scanBareOrQuoted(): { text: string; quoted: boolean } {
    if (this.ch() === '`') {
      const { name, end } = this.scanBacktick(this.pos);
      this.pos = end;
      return { text: name, quoted: true };
    }
    const start = this.pos;
    if (!IDENT_START.test(this.ch() ?? '')) this.fail('Expected a name', this.pos);
    while (IDENT_CHAR.test(this.ch() ?? '')) this.pos++;
    return { text: this.src.slice(start, this.pos), quoted: false };
  }

  /**
   * A hop's label: backtick-quoted, or everything up to the bracket's next
   * clause — `]`, a newline, a config `{`, ` WHERE `, ` ORDER BY ` or
   * ` LIMIT ` — so an unquoted label may hold spaces (`-[:Funding Round]->`),
   * a `#` (`#transform`) and a type shorthand (`_resources:TEXT`).
   */
  private readLabel(): Name {
    const start = this.pos;
    if (this.ch() === '`') {
      const scanned = this.scanBareOrQuoted();
      return { text: scanned.text, quoted: true, at: { start, end: this.pos } };
    }
    while (this.pos < this.limit) {
      const c = this.src[this.pos];
      if (c === ']' || c === '\n' || c === '{') break;
      const rest = this.src.slice(this.pos, this.limit);
      if (/^\s+WHERE\s/i.test(rest) || /^\s+(ORDER\s+BY|LIMIT)\s/i.test(rest)) break;
      this.pos++;
    }
    const text = this.src.slice(start, this.pos).trimEnd();
    if (!text) this.fail('Expected an edge name in the hop', start);
    return { text, quoted: false, at: { start, end: start + text.length } };
  }

  // ── Types ──

  /** `<…>` — with the cursor on `<`. */
  private parseTypeMarker(context: string): TypeExpr {
    const open = this.peek();
    if (!this.isOp(open, '<')) this.fail(`Expected a type in angle brackets ${context}, got ${describe(open, this.src)}`, open.start);
    this.advance();
    const type = this.withNewlines(false, () => this.parseTypeUnion());
    const close = this.peek();
    // `->>` closes a hop then the marker: the hop reader took `]->`.
    if (!this.isOp(close, '>') && !this.isOp(close, '>=')) {
      this.fail(`Expected '>' to close the type, got ${describe(close, this.src)}`, close.start);
    }
    this.expectOp('>', 'to close the type');
    return type;
  }

  private parseTypeUnion(): TypeExpr {
    const start = this.peek().start;
    const members = [this.parseTypeAtom()];
    while (this.isPunct(this.peek(), '|')) {
      this.advance();
      members.push(this.parseTypeAtom());
    }
    return members.length === 1 ? members[0] : { kind: 'union', members, at: this.span(start) };
  }

  private parseTypeAtom(): TypeExpr {
    const tok = this.peek();
    const at = { start: tok.start, end: tok.end };
    if (tok.t === 'string' && tok.segments.every(s => typeof s === 'string')) {
      this.advance();
      return { kind: 'literal', value: tok.segments.join(''), at };
    }
    if (this.isKeyword(tok, 'NULL')) {
      this.advance();
      return { kind: 'literal', value: null, at };
    }
    if (this.isPunct(tok, '{')) {
      this.advance();
      const members: Array<{ name: Name; optional: boolean; type: TypeExpr }> = [];
      while (!this.isPunct(this.peek(), '}')) {
        const name = this.readName('as a record member');
        const optional = this.isPunct(this.peek(), '?');
        if (optional) this.advance();
        this.expectPunct(':', `after the record member '${name.text}'`);
        members.push({ name, optional, type: this.parseTypeUnion() });
        if (!this.isPunct(this.peek(), ',')) break;
        this.advance();
      }
      this.expectPunct('}', 'to close the record type');
      return { kind: 'record', members, array: this.tryArraySuffix(), at: this.span(tok.start) };
    }
    const name = this.readName('in the type');
    const hops = this.peek().t === 'hop' ? this.parseHops() : [];
    let field: Name | undefined;
    if (hops.length > 0 && this.isOp(this.peek(), '.')) {
      this.advance();
      field = this.readName("after '.' in the borrowed type");
    }
    return {
      kind: 'named',
      name,
      hops,
      ...(field ? { field } : {}),
      array: this.tryArraySuffix(),
      at: this.span(tok.start),
    };
  }

  private tryArraySuffix(): boolean {
    const open = this.peek();
    if (!this.isPunct(open, '[') || open.spaceBefore) return false;
    this.advance();
    this.expectPunct(']', "to close '[]'");
    return true;
  }

  // ── Closures ──

  /** `(params) => body` — told from a parenthesised expression by the `=>`
   *  after the balanced parameter list, so it costs a scan and nothing else. */
  private tryParseClosure(): MExpr | undefined {
    const open = this.peek();
    const close = this.matchingClose(open.start);
    if (close === undefined) return undefined;
    let i = close + 1;
    while (i < this.limit && /\s/.test(this.src[i])) i++;
    if (!this.src.startsWith('=>', i)) return undefined;

    this.advance(); // '('
    const params: Param[] = [];
    this.withNewlines(false, () => {
      while (!this.isPunct(this.peek(), ')')) {
        const name = this.readName('as a closure parameter');
        let type: TypeExpr | undefined;
        if (this.isPunct(this.peek(), ':')) {
          this.advance();
          type = this.parseTypeMarker(`for the parameter '${name.text}'`);
        }
        params.push({ name, ...(type ? { type } : {}) });
        if (!this.isPunct(this.peek(), ',')) break;
        this.advance();
      }
      this.expectPunct(')', 'to close the parameter list');
    });
    this.expectOp('=>', "between a closure's parameters and its body");
    const bodyTok = this.peek();
    if (this.isPunct(bodyTok, '{')) {
      const end = this.matchingClose(bodyTok.start);
      if (end === undefined) this.fail("Expected '}' to close the closure body", bodyTok.start);
      this.consumedTo(end + 1);
      return {
        kind: 'closure',
        params,
        body: { kind: 'block', at: { start: bodyTok.start, end: end + 1 } },
        at: this.span(open.start),
      };
    }
    const expr = this.parseWhere();
    return { kind: 'closure', params, body: { kind: 'expr', expr }, at: this.span(open.start) };
  }

  /** The index of the bracket closing the one at `open`, skipping literals. */
  private matchingClose(open: number): number | undefined {
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const stack: string[] = [];
    let i = open;
    while (i < this.limit) {
      const c = this.src[i];
      if (c === '"' || c === "'") {
        try {
          i = this.skipQuoted(i);
        } catch {
          return undefined;
        }
        continue;
      }
      if (c === '`') {
        const close = this.src.indexOf('`', i + 1);
        if (close === -1 || close >= this.limit) return undefined;
        i = close + 1;
        continue;
      }
      if (c in pairs) stack.push(pairs[c]);
      else if (c === ')' || c === ']' || c === '}') {
        if (stack.pop() !== c) return undefined;
        if (stack.length === 0) return i;
      }
      i++;
    }
    return undefined;
  }

  // ── Node and graph literals, inline declarations ──

  private parseNodeLiteral(): MExpr {
    const word = this.advance(); // 'node'
    const entries = this.parseEntryBody('the node literal', () => this.parseNodeEntryValue());
    return { kind: 'node', entries: entries.entries, at: this.span(word.start) };
  }

  private parseNodeEntryValue(): LiteralEntry['value'] {
    const tok = this.peek();
    if (this.isOp(tok, '<')) {
      const type = this.parseTypeMarker('for the declared edge');
      const sequenced = this.tryOrderBy();
      return { kind: 'declaredEdge', type, ...(sequenced ? { sequenced } : {}), at: this.span(tok.start) };
    }
    // `lazy` is contextual, as in the statement grammar: a modifier only when
    // something that can begin a walk follows it.
    const lazy = tok.t === 'name' && !tok.quoted && tok.text === 'lazy' && /[-`A-Za-z_]/.test(this.src[this.lookPast(tok.end)] ?? '');
    if (lazy) this.advance();
    const value = this.parseWhere();
    const walk = this.tryMappedTail(value, () => {
      const next = this.peek();
      return next.t === 'name' && !next.quoted && next.text === 'node' && this.src[this.lookPast(next.end)] === '{'
        ? this.parseNodeLiteral()
        : undefined;
    });
    return lazy ? { kind: 'lazy', walk, at: this.span(tok.start) } : walk;
  }

  /** `order by arrival` — same line only, like every entry continuation. */
  private tryOrderBy(): Name | undefined {
    const order = this.peek();
    if (order.newlineBefore || !(order.t === 'name' && !order.quoted && order.text === 'order')) return undefined;
    this.advance();
    const by = this.peek();
    if (!(by.t === 'name' && !by.quoted && by.text === 'by')) this.fail("An order is written 'order by'", by.start);
    this.advance();
    return this.readName("after 'order by'");
  }

  /** `walk node { … }` / `walk { … }` — a per-item mapping written after a walk. */
  private tryMappedTail(value: MExpr, body: () => MExpr | undefined): MExpr {
    if (value.kind !== 'path') return value;
    const next = this.peek();
    if (next.newlineBefore) return value;
    const mapping = body();
    if (mapping === undefined) return value;
    return { kind: 'mapped', source: value, body: mapping, at: { start: value.at.start, end: mapping.at.end } };
  }

  /** `{ name: value, … }` with entries ended by a comma, a newline or the
   *  close — and, for a graph body, `...spread` members. */
  private parseEntryBody(
    what: string,
    value: () => LiteralEntry['value'],
    spreads?: MExpr[],
  ): { entries: LiteralEntry[] } {
    this.expectPunct('{', `to open ${what}`);
    const entries: LiteralEntry[] = [];
    this.withNewlines(true, () => {
      for (;;) {
        const tok = this.peek();
        if (this.isPunct(tok, '}')) break;
        if (this.isPunct(tok, ',')) {
          this.advance();
          continue;
        }
        if (spreads !== undefined && this.isPunct(tok, '...')) {
          this.advance();
          spreads.push(this.parsePostfix());
        } else {
          const name = this.readName(`as an entry name in ${what}`);
          this.expectPunct(':', `after the entry name '${name.text}'`);
          entries.push({ name, value: value(), at: this.span(name.at.start) });
        }
        const sep = this.peek();
        if (this.isPunct(sep, ',')) this.advance();
        else if (!this.isPunct(sep, '}') && !sep.newlineBefore) {
          this.fail(`Expected ',' or a newline after an entry in ${what}, got ${describe(sep, this.src)}`, sep.start);
        }
      }
    });
    this.expectPunct('}', `to close ${what}`);
    return { entries };
  }

  private atGraphLiteral(afterWord: number): boolean {
    let i = this.lookPast(afterWord);
    if (this.src[i] === '{') return true;
    if (this.src[i] !== '<') return false;
    i = this.lookPast(i + 1);
    const close = this.src.indexOf('>', i);
    return close !== -1 && this.src[this.lookPast(close + 1)] === '{';
  }

  private parseGraphLiteral(): MExpr {
    const word = this.advance(); // 'graph'
    let shape: Name | undefined;
    if (this.isOp(this.peek(), '<')) {
      this.advance();
      shape = this.readName("inside 'graph<…>'");
      this.expectOp('>', "to close 'graph<…>'");
    }
    return this.parseGraphBody(word.start, shape);
  }

  /** A graph body. Here `{` opens a CHILD NODE, never a map: the brace's
   *  meaning is decided by where it is written, as it is for a write body. */
  private parseGraphBody(start: number, shape?: Name): MExpr {
    const spreads: MExpr[] = [];
    const { entries } = this.parseEntryBody('the graph literal', () => this.parseGraphEntryValue(), spreads);
    return { kind: 'graph', ...(shape ? { shape } : {}), entries, spreads, at: this.span(start) };
  }

  private parseGraphEntryValue(): MExpr {
    const tok = this.peek();
    if (this.isPunct(tok, '{')) return this.parseGraphBody(tok.start);
    if (this.isPunct(tok, '[') && this.src[this.lookPastAll(tok.end)] === '{') {
      this.advance();
      const bodies: MExpr[] = [];
      this.withNewlines(false, () => {
        while (!this.isPunct(this.peek(), ']')) {
          bodies.push(this.parseGraphBody(this.peek().start));
          if (!this.isPunct(this.peek(), ',')) break;
          this.advance();
        }
      });
      this.expectPunct(']', 'to close the list of child nodes');
      return { kind: 'list', elements: bodies, at: this.span(tok.start) };
    }
    const value = this.parseWhere();
    return this.tryMappedTail(value, () => (this.isPunct(this.peek(), '{') ? this.parseGraphBody(this.peek().start) : undefined));
  }

  private lookPastAll(i: number): number {
    while (i < this.limit && /\s/.test(this.src[i])) i++;
    return i;
  }

  /** `node Name extends Base: "…" {` / `node Name: "…" {` / `node Name {` — after `node`. */
  private atDeclaration(after: number): boolean {
    const save = this.pos;
    try {
      this.pos = after;
      if (!/[A-Za-z_`]/.test(this.ch() ?? '')) return false;
      this.scanBareOrQuoted();
      this.pos = this.lookPast(this.pos);
      if (this.src.startsWith('extends', this.pos)) return true;
      if (this.ch() === ':') {
        this.pos = this.lookPast(this.pos + 1);
        return this.ch() === '"';
      }
      return this.ch() === '{';
    } catch {
      return false;
    } finally {
      this.pos = save;
    }
  }

  private parseInlineDeclaration(): MExpr {
    const declaration = this.parseDeclaration();
    return { kind: 'declaration', declaration, at: declaration.at };
  }

  private parseDeclaration(): NodeDeclaration {
    const word = this.advance(); // 'node'
    const name = this.readName("after 'node'");
    let base: Name | undefined;
    if (this.isWord(this.peek(), 'EXTENDS')) {
      this.advance();
      base = this.readName("after 'extends'");
    }
    let description: MExpr | undefined;
    if (this.isPunct(this.peek(), ':')) {
      this.advance();
      description = this.parsePrimary();
      if (description.kind !== 'string') this.fail('A node declaration is described by a double-quoted string', description.at.start);
    }
    this.expectPunct('{', `to open the node '${name.text}'`);
    const members: DeclarationMember[] = [];
    this.withNewlines(true, () => {
      for (;;) {
        const tok = this.peek();
        if (this.isPunct(tok, '}')) return;
        if (this.isPunct(tok, ',') || this.isPunct(tok, ';')) {
          this.advance();
          continue;
        }
        if (tok.t === 'name' && !tok.quoted && tok.text === 'node') {
          const declaration = this.parseDeclaration();
          const sequenced = this.tryOrderBy();
          members.push({ kind: 'node', declaration: sequenced ? { ...declaration, sequenced } : declaration });
          continue;
        }
        const field = this.readName('as a field name');
        this.expectPunct(':', `after the field name '${field.text}'`);
        const type = this.parseTypeMarker(`for the field '${field.text}'`);
        const next = this.peek();
        const fieldDescription =
          next.t === 'string' && !next.newlineBefore ? this.parsePrimary() : undefined;
        members.push({
          kind: 'field',
          name: field,
          type,
          ...(fieldDescription ? { description: fieldDescription } : {}),
          at: this.span(field.at.start),
        });
      }
    });
    this.expectPunct('}', `to close the node '${name.text}'`);
    return {
      name,
      ...(base ? { extends: base } : {}),
      ...(description ? { description } : {}),
      members,
      at: this.span(word.start),
    };
  }
}

function describe(tok: Token, src: string): string {
  if (tok.t === 'eof') return 'end of input';
  if (tok.t === 'hop') return "a hop '-['";
  return `'${src.slice(tok.start, tok.end)}'`;
}

/** The character at `i` as a message quotes it: the whole code point, since
 *  `src[i]` would be half of an astral character. */
function characterAt(src: string, i: number): string {
  const code = src.codePointAt(i);
  return code === undefined ? '' : String.fromCodePoint(code);
}
