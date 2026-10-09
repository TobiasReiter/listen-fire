/**
 * Formula language for expression editing.
 *
 * Provides serialization (AST → text), parsing (text → AST),
 * and cursor-context-aware completion hints.
 *
 * Grammar (simplified):
 *   expr       = or_expr
 *   or_expr    = and_expr ('OR' and_expr)*
 *   and_expr   = not_expr ('AND' not_expr)*
 *   not_expr   = ('NOT' | '!') not_expr | compare
 *   compare    = additive (comp_op additive)?
 *   additive   = mult (('+' | '-') mult)*
 *   mult       = unary (('*' | '/' | '%') unary)*
 *   unary      = '-' unary | primary
 *   primary    = '(' expr ')' | if_expr | fn_call | literal | identifier
 *   if_expr    = 'IF' expr 'THEN' expr ('ELSE' 'IF' expr 'THEN' expr)* 'ELSE' expr 'END'
 *   fn_call    = IDENT '(' expr (',' expr)* ')'
 *   literal    = string | number | 'true' | 'false' | 'null' | list | object
 *   list       = '[' (expr (',' expr)* ','?)? ']'
 *   object     = '{' (entry (',' entry)* ','?)? '}'
 *   entry      = (IDENT | string) ':' expr
 *   identifier = [a-zA-Z_][a-zA-Z0-9_ ]* | `backtick quoted`
 */

import type { Expression, FilterOperator, ListElement, ObjectEntry, TraversalStep, EdgeStep, MetaEdgeStep, EnrichWithEntry } from './types';
import { AI_TIERS, isObjectSpread, listElementExpression, mapListElement, objectMemberExpression } from './types';

// ── Property name resolution ──

export interface PropertyInfo {
  id: string;
  name: string;
  nodeTypeId?: string; // which node type this belongs to (for scoped completions)
  edgeTypeId?: string; // for edge properties: the edge type they hang off (scopes `edge.X` completions to the just-walked edge)
  valueType?: string; // e.g. 'text', 'number', 'boolean', 'date', 'enum'
  enumValues?: string[];
  isEdge?: boolean;
  /** Property arity. `'many'` declares the value is an array of
   *  `valueType` rather than a single instance — drives the type
   *  inferer to wrap the property's type in `{ kind: 'many', ... }`. */
  cardinality?: 'one' | 'many';
  /** Optional human description, surfaced by the editor's caret hints. */
  description?: string;
}

export interface EdgeInfo {
  id: string;
  outboundName: string;
  inboundName: string;
  sourceNodeTypeId: string;
  targetNodeTypeId: string;
}

// ── Capability gating ──
// When the source-side adapter doesn't support a feature, the formula
// completion engine should hide the corresponding token. KG-source defaults
// (everything = true) preserve the historical behavior when no capabilities
// object is supplied.
//
// `expressionKinds` and `aggregations` let the UI gate token completions by
// the adapter's full expression dialect (per the AdapterExpressionCapabilities
// `runtime` surface). When absent, every kind/aggregation is offered.
export interface FormulaCapabilities {
  incomingEdges: boolean;
  edgeProperties: boolean;
  linkedObjects: boolean;
  resources: boolean;
  llm: boolean;
  /**
   * KG-bound global identifiers (`@id`, `@user_*`, `@parent.*`,
   * `@current_date`, `@input_channel_name`). True for the TG field
   * editor where these resolve against the surrounding action node /
   * pipeline context. False for adapter-source filter authoring (trigger
   * filters) where there's no parent action node and no KG node id in
   * scope. Optional; defaults to true.
   */
  kgGlobals?: boolean;
  expressionKinds?: readonly string[];
  aggregations?: readonly string[];
}

const DEFAULT_CAPABILITIES: FormulaCapabilities = {
  incomingEdges: true,
  edgeProperties: true,
  linkedObjects: true,
  resources: true,
  llm: true,
  kgGlobals: true,
};

/** Map from completion token's `insert` prefix to the Expression kind it
 *  produces. Only kinds we care to gate appear here; properties / static
 *  values / etc. are always available. */
const COMPLETION_KIND_MAP: Record<string, { kind: string; aggFn?: string }> = {
  IF: { kind: 'conditional' },
  NOT: { kind: 'not' },
  'CONCAT(': { kind: 'concat' },
  'COALESCE(': { kind: 'function' },
  'AI(': { kind: 'llm' },
  'FIRST(': { kind: 'aggregate', aggFn: 'first' },
  'LAST(': { kind: 'aggregate', aggFn: 'last' },
  'COUNT(': { kind: 'aggregate', aggFn: 'count' },
  'SUM(': { kind: 'aggregate', aggFn: 'sum' },
  'AVG(': { kind: 'aggregate', aggFn: 'avg' },
  'MIN(': { kind: 'aggregate', aggFn: 'min' },
  'MAX(': { kind: 'aggregate', aggFn: 'max' },
  'JOIN(': { kind: 'aggregate', aggFn: 'join' },
  'ONLY(': { kind: 'aggregate', aggFn: 'only' },
  'KG_EXISTS(': { kind: 'kg_exists' },
  'KG_VALUE(': { kind: 'kg_value' },
  'WITHIN(': { kind: 'function' },
};

/** Filter a list of completions by the active capability surface — drops
 *  tokens whose Expression kind (or aggregation function) isn't supported.
 *  When the capability arrays are absent, all completions are kept. */
function filterCompletionsByCaps<C extends { insert: string }>(
  completions: readonly C[],
  capabilities: FormulaCapabilities,
): C[] {
  return completions.filter((c) => {
    const m = COMPLETION_KIND_MAP[c.insert];
    if (!m) return true;
    if (
      capabilities.expressionKinds &&
      !capabilities.expressionKinds.includes(m.kind)
    ) {
      return false;
    }
    if (
      m.aggFn &&
      capabilities.aggregations &&
      !capabilities.aggregations.includes(m.aggFn)
    ) {
      return false;
    }
    return true;
  });
}

// ── Serializer: AST → formula text ──

const OP_TEXT: Record<FilterOperator, string> = {
  eq: '=', neq: '!=', contains: 'contains', gt: '>', gte: '>=', lt: '<', lte: '<=',
  exists: 'exists', in: 'in', within: 'WITHIN',
};

const MATH_TEXT: Record<string, string> = { '+': '+', '-': '-', '*': '*', '/': '/', '%': '%' };

const AGG_NAMES: Record<string, string> = {
  first: 'FIRST', last: 'LAST', only: 'ONLY', count: 'COUNT', sum: 'SUM', avg: 'AVG',
  min: 'MIN', max: 'MAX', join: 'JOIN', collect: 'COLLECT', llm: 'LLM_AGG',
};

function isSimpleExpression(expr: Expression): boolean {
  switch (expr.type) {
    case 'property':
    case 'edge_property':
    case 'static':
    case 'meta':
    case 'parent_result':
    case 'action_result':
    case 'resource':
    case 'linked_object':
      return true;
    default:
      return false;
  }
}

export function needsQuote(name: string): boolean {
  return !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

export function quoteName(name: string): string {
  return needsQuote(name) ? '`' + name.replace(/[\\`]/g, '\\$&') + '`' : name;
}

function quoteString(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * An object-literal key in its two authored forms: bare when the parser reads
 * it straight back as a key, a quoted string otherwise. A reserved word takes
 * the quoted form too — the tokenizer folds it to an (upper-cased) keyword, so
 * a bare `end:` would not round-trip.
 */
function serializeObjectKey(key: string): string {
  return !needsQuote(key) && !KEYWORDS.has(key.toUpperCase()) ? key : quoteString(key);
}

function serializeResourceFilter(filter?: { resourceType?: string; hasDocument?: boolean; mimeType?: string; namePattern?: string }): string {
  if (!filter) return '';
  const clauses: string[] = [];
  if (filter.resourceType) clauses.push(`type = "${filter.resourceType}"`);
  if (filter.hasDocument != null) clauses.push(filter.hasDocument ? 'hasDocument' : 'hasDocument = false');
  if (filter.mimeType) clauses.push(`mimeType = "${filter.mimeType}"`);
  if (filter.namePattern) clauses.push(`namePattern = "${filter.namePattern}"`);
  if (clauses.length === 0) return '';
  return ` WHERE ${clauses.join(' AND ')}`;
}

export function serialize(
  expr: Expression,
  resolve: (id: string, isEdge?: boolean) => string,
  parentPrec = 0,
  resolveStaticValue?: (value: string) => string,
  resolveEdgeInfo?: (id: string) => EdgeInfo | undefined,
): string {
  switch (expr.type) {
    case 'property':
      return quoteName(resolve(expr.propertyTypeId));
    case 'edge_property':
      return 'edge.' + quoteName(resolve(expr.propertyTypeId, true));
    case 'static':
      if (typeof expr.value === 'string') {
        const display = resolveStaticValue ? resolveStaticValue(expr.value) : expr.value;
        return quoteString(display);
      }
      if (expr.value === null) return 'null';
      return String(expr.value);
    case 'llm': {
      // The tier rides along: a call spelled back without it would read as a
      // different call from the one that runs.
      const tier = expr.tier !== undefined ? `, ${quoteString(expr.tier)}` : '';
      if (expr.promptExpression) {
        return `AI(${serialize(expr.promptExpression, resolve, 0, resolveStaticValue, resolveEdgeInfo)}${tier})`;
      }
      return `AI(${quoteString(expr.prompt)}${tier})`;
    }
    case 'meta':
      return '@' + expr.key;
    case 'parent_result':
      return '@parent.' + expr.field;
    case 'action_result':
      // Serializer-led (like `exists`) — compiler-emitted, no parser entry.
      return `RESULT(${quoteName(expr.nodeId)}).${quoteName(expr.field)}`;
    case 'resource':
      return '@resource.' + expr.field;
    case 'linked_object':
      return `-[#linked WHERE type = "${expr.adapter}"]->.${expr.field}`;
    case 'extract_value':
      return `EXTRACT_VALUE(${quoteString(expr.description)})`;
    case 'alias_ref':
      return quoteName(expr.name);
    case 'list':
      return `[${expr.elements.map(e => (e.type === 'spread' ? `...${ser(e.expression)}` : ser(e))).join(', ')}]`;
    case 'object':
      return `{${expr.entries.map(e => (isObjectSpread(e) ? `...${ser(e.expression)}` : `${serializeObjectKey(e.key)}: ${ser(e.value)}`)).join(', ')}}`;
    case 'traverse': {
      const steps = expr.steps.map(s => serializeTraversalStep(s, resolve, resolveStaticValue, resolveEdgeInfo));
      const inner = ser(expr.expression);
      const needsBrackets = !isSimpleExpression(expr.expression);
      const root = expr.aliasRoot ? quoteName(expr.aliasRoot) : '';
      // Dot-chain with aliasRoot but zero steps: render `alias.expression`
      // (no leading arrow). Steps-only path keeps the existing form.
      if (expr.aliasRoot && expr.steps.length === 0) {
        return `${root}.${needsBrackets ? `(${inner})` : inner}`;
      }
      return `${root}${steps.join('')}.${needsBrackets ? `(${inner})` : inner}`;
    }
    case 'resource_traverse': {
      const where = expr.expressionFilter
        ? ` WHERE ${ser(expr.expressionFilter)}`
        : serializeResourceFilter(expr.filter);
      const inner = expr.expression.type === 'resource'
        ? expr.expression.field
        : ser(expr.expression);
      return `-[:_resources${where}]->.${inner}`;
    }
    case 'compare': {
      const prec = 3;
      // `WITHIN`'s right operand is a duration literal — render it bare
      // (`updated WITHIN 30d`), not as a quoted string.
      if (expr.op === 'within') {
        const dur = expr.right.type === 'static' ? String(expr.right.value) : ser(expr.right, prec + 1);
        const inner = `${ser(expr.left, prec)} WITHIN ${dur}`;
        return parentPrec > prec ? `(${inner})` : inner;
      }
      const inner = `${ser(expr.left, prec)} ${OP_TEXT[expr.op]} ${ser(expr.right, prec + 1)}`;
      return parentPrec > prec ? `(${inner})` : inner;
    }
    case 'arithmetic': {
      const prec = expr.op === '*' || expr.op === '/' || expr.op === '%' ? 5 : 4;
      const inner = `${ser(expr.left, prec)} ${MATH_TEXT[expr.op]} ${ser(expr.right, prec + 1)}`;
      return parentPrec > prec ? `(${inner})` : inner;
    }
    case 'logical': {
      const prec = expr.op === 'and' ? 2 : 1;
      const inner = expr.operands.map(o => ser(o, prec + 1)).join(` ${expr.op.toUpperCase()} `);
      return parentPrec > prec ? `(${inner})` : inner;
    }
    case 'not': {
      return `NOT ${ser(expr.expression, 6)}`;
    }
    case 'negate': {
      // Precedence 6: above mult (5), so `-a * b` and `a * -b` never need
      // parens; below nothing, so a nested arithmetic operand always does
      // (`-(a + b)`).
      const prec = 6;
      const inner = `-${ser(expr.expression, prec)}`;
      return parentPrec > prec ? `(${inner})` : inner;
    }
    case 'concat': {
      return `CONCAT(${expr.parts.map(p => ser(p)).join(', ')})`;
    }
    case 'conditional': {
      return serializeConditional(expr, ser);
    }
    case 'aggregate': {
      const fn = AGG_NAMES[expr.fn] ?? expr.fn.toUpperCase();
      const args = [ser(expr.expression)];
      // SORT's own two slots — the key, then the direction, each written only
      // when it was (an ascending sort by the member itself is `SORT(xs)`).
      if (expr.fn === 'sort') {
        if (expr.orderBy !== undefined) args.push(ser(expr.orderBy));
        if (expr.orderDirection === 'desc') args.push('DESC');
        return `${fn}(${args.join(', ')})`;
      }
      if (expr.separator !== undefined) args.push(quoteString(expr.separator));
      if (expr.prompt !== undefined) args.push(quoteString(expr.prompt));
      return `${fn}(${args.join(', ')})`;
    }
    case 'function': {
      return `${expr.fn.toUpperCase()}(${expr.args.map(a => ser(a)).join(', ')})`;
    }
    case 'kg_exists':
    case 'kg_value': {
      const fnName = expr.type === 'kg_exists' ? 'KG_EXISTS' : 'KG_VALUE';
      const args = [quoteString(expr.query), ...expr.params.map(p => ser(p))];
      return `${fnName}(${args.join(', ')})`;
    }
    case 'exists': {
      const pathRefs: string[] = [];
      for (const step of expr.steps) {
        if (step.type === 'edge') {
          const dir = step.direction === 'outgoing' ? '->' : '<-';
          pathRefs.push(`${dir}${quoteName(resolve(step.edgeTypeId, true))}`);
        } else if (step.type === 'resource') {
          pathRefs.push('->resource');
        } else if (step.type === 'linkBack') {
          pathRefs.push('->link_back');
        }
      }
      const path = pathRefs.join('');
      if (expr.where) return `EXISTS(${path} WHERE ${ser(expr.where)})`;
      return `EXISTS(${path})`;
    }
    case 'at': {
      return `AT(${ser(expr.expression)}, ${ser(expr.index)})`;
    }
  }

  // Shorthand for recursive calls that threads resolveStaticValue/resolveEdgeInfo through
  function ser(e: Expression, prec = 0): string {
    return serialize(e, resolve, prec, resolveStaticValue, resolveEdgeInfo);
  }
}

/** Serialize an expression in edge filter context: edge_property → just the name (no edge. prefix) */
function serializeEdgeFilter(expr: Expression, resolve: (id: string, isEdge?: boolean) => string, resolveStaticValue?: (value: string) => string): string {
  if (expr.type === 'edge_property') {
    return quoteName(resolve(expr.propertyTypeId, true));
  }
  switch (expr.type) {
    case 'compare':
      return `${serializeEdgeFilter(expr.left, resolve, resolveStaticValue)} ${OP_TEXT[expr.op]} ${serializeEdgeFilter(expr.right, resolve, resolveStaticValue)}`;
    case 'logical':
      return expr.operands.map(o => serializeEdgeFilter(o, resolve, resolveStaticValue)).join(` ${expr.op.toUpperCase()} `);
    case 'not':
      return `NOT ${serializeEdgeFilter(expr.expression, resolve, resolveStaticValue)}`;
    default:
      return serialize(expr, resolve, 0, resolveStaticValue);
  }
}

/** Render an EdgeStep's bracket ORDER BY / LIMIT suffix (`'' ` when the
 *  step carries neither). The key renders as the expression it is — a bare
 *  property by resolved name, a path as the path. */
function serializeOrderLimitSuffix(
  step: EdgeStep,
  resolve: (id: string, isEdge?: boolean) => string,
  resolveStaticValue?: (value: string) => string,
  resolveEdgeInfo?: (id: string) => EdgeInfo | undefined,
): string {
  const cardinality = step.cardinality;
  if (!cardinality) return '';
  let suffix = '';
  if (cardinality.orderBy !== undefined) {
    suffix += ` ORDER BY ${serialize(cardinality.orderBy, resolve, 0, resolveStaticValue, resolveEdgeInfo)}`;
    if (cardinality.orderDirection === 'desc') suffix += ' DESC';
  }
  if (cardinality.limit !== undefined) suffix += ` LIMIT ${cardinality.limit}`;
  return suffix;
}

function serializeTraversalStep(step: TraversalStep, resolve: (id: string, isEdge?: boolean) => string, resolveStaticValue?: (value: string) => string, resolveEdgeInfo?: (id: string) => EdgeInfo | undefined): string {
  if (step.type === 'edge') {
    const where = (step.expressionFilter
      ? ` WHERE ${serializeEdgeFilter(step.expressionFilter, resolve, resolveStaticValue)}`
      : '') + serializeOrderLimitSuffix(step, resolve, resolveStaticValue, resolveEdgeInfo);
    // alias form is `-[name:Edge]->`; anonymous form is `-[:Edge]->`.
    // Both share the same single colon separator before the edge name —
    // the alias goes BEFORE the colon, replacing the leading empty slot.
    const aliasPrefix = step.alias ? quoteName(step.alias) : '';
    // When edge info is available, always display as outgoing using the appropriate name
    if (resolveEdgeInfo) {
      const info = resolveEdgeInfo(step.edgeTypeId);
      const name = info
        ? (step.direction === 'incoming' ? info.inboundName : info.outboundName)
        : resolve(step.edgeTypeId, true);
      const quoted = needsQuote(name) ? '`' + name + '`' : name;
      return `-[${aliasPrefix}:${quoted}${where}]->`;
    }
    // Fallback without edge info: preserve original direction syntax
    const name = resolve(step.edgeTypeId, true);
    const quoted = needsQuote(name) ? '`' + name + '`' : name;
    return step.direction === 'incoming'
      ? `<-[${aliasPrefix}:${quoted}${where}]-`
      : `-[${aliasPrefix}:${quoted}${where}]->`;
  }
  if (step.type === 'linkBack') return '-[:linkBack]->';
  if (step.type === 'meta_edge') {
    const aliasPrefix = step.alias ? `${quoteName(step.alias)}:` : '';
    const tag = `#${step.metaEdge}`;
    if (step.metaEdge === 'resources') {
      const where = step.expressionFilter
        ? ` WHERE ${serializeEdgeFilter(step.expressionFilter, resolve, resolveStaticValue)}`
        : '';
      return `-[${aliasPrefix}${tag}${where}]->`;
    }
    // #extract / #transform — config object inside the bracket
    const parts: string[] = [];
    if (step.config?.description) {
      parts.push(`description: ${serialize(step.config.description, resolve, 0, resolveStaticValue, resolveEdgeInfo)}`);
    }
    if (step.config?.data) {
      // `data:` items are source-field references rendered as backticked
      // names (the `-[#extract { data: [`Body`] }]->` grammar). A plain
      // `serialize` would unquote simple identifiers and — worse — emit
      // empty backticks for a name that resolves to "". Backtick the
      // resolved name explicitly here so the field names always show.
      const dataParts = step.config.data.map(d => {
        if (d.type === 'property') {
          return '`' + resolve(d.propertyTypeId).replace(/`/g, '\\`') + '`';
        }
        return serialize(d, resolve, 0, resolveStaticValue, resolveEdgeInfo);
      });
      parts.push(`data: [${dataParts.join(', ')}]`);
    }
    if (step.config?.plugin) {
      parts.push(`plugin: ${serialize(step.config.plugin, resolve, 0, resolveStaticValue, resolveEdgeInfo)}`);
    }
    if (step.config?.enrichWith && step.config.enrichWith.length > 0) {
      const entryParts = step.config.enrichWith.map((entry) => {
        const t = serialize(entry.transform, resolve, 0, resolveStaticValue, resolveEdgeInfo);
        const a = serialize(entry.argument, resolve, 0, resolveStaticValue, resolveEdgeInfo);
        return `{ transform: ${t}, argument: ${a} }`;
      });
      parts.push(`enrich_with: [${entryParts.join(', ')}]`);
    }
    if (step.config?.extra) {
      for (const [k, v] of Object.entries(step.config.extra)) {
        parts.push(`${k}: ${serialize(v, resolve, 0, resolveStaticValue, resolveEdgeInfo)}`);
      }
    }
    const cfg = parts.length > 0 ? ` { ${parts.join(', ')} }` : '';
    return `-[${aliasPrefix}${tag}${cfg}]->`;
  }
  return '-[:resource]->';
}

function serializeConditional(expr: Expression & { type: 'conditional' }, ser: (e: Expression, prec?: number) => string): string {
  const parts: string[] = [];
  let current: Expression = expr;
  while (current.type === 'conditional') {
    if (parts.length === 0) {
      parts.push(`IF ${ser(current.condition)} THEN ${ser(current.then)}`);
    } else {
      parts.push(`ELSE IF ${ser(current.condition)} THEN ${ser(current.then)}`);
    }
    current = current.else;
  }
  parts.push(`ELSE ${ser(current)} END`);
  return parts.join(' ');
}

// ── Parser: formula text → AST ──
// Hand-rolled Pratt parser for performance and small bundle size.

interface Token {
  type: 'ident' | 'string' | 'number' | 'op' | 'paren' | 'comma' | 'keyword' | 'special' | 'traverse' | 'lbracket' | 'rbracket' | 'lbrace' | 'rbrace' | 'colon' | 'spread' | 'unknown' | 'eof';
  value: string;
  pos: number;
  end: number;
  /** for traverse tokens: raw WHERE clause text */
  filterText?: string;
  /** for traverse tokens: optional alias bound at the destination (cypher `-[name:Edge]->`) */
  alias?: string;
  /** for traverse tokens: raw config-object text from `-[#extract { ... }]->` (between the outer braces) */
  configText?: string;
  /** for traverse tokens: `ORDER BY <prop>` inside the bracket (a property of the hop target) */
  orderByText?: string;
  /** for traverse tokens: `ASC`/`DESC` after ORDER BY (default asc) */
  orderDirection?: 'asc' | 'desc';
  /** for traverse tokens: `LIMIT <n>` inside the bracket */
  limitCount?: number;
}

/** Canonical reserved-word set for the formula grammar. Exported so the
 *  web editor's display lexer (syntax highlighting) classifies keywords
 *  exactly as the parser does, without maintaining a second copy. */
export const KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'IF', 'THEN', 'ELSE', 'END', 'TRUE', 'FALSE', 'NULL',
  'CONTAINS', 'EXISTS', 'IN',
]);

const COMPARE_OPS = new Set(['=', '!=', '>', '>=', '<', '<=', 'CONTAINS', 'EXISTS', 'IN']);
const COMPARE_KEYWORDS = new Set(['CONTAINS', 'EXISTS', 'IN']);

/** Find the token immediately before a given token in the filtered token list */
function findTokenBefore(toks: Token[], target: Token): Token | undefined {
  for (let i = 1; i < toks.length; i++) {
    if (toks[i] === target) return toks[i - 1];
  }
  return undefined;
}

/** The trailing-clause boundary inside a traversal bracket: ` ORDER BY ` /
 *  ` LIMIT ` at top level end the name / WHERE scan. */
const BRACKET_TRAILING_CLAUSE = /^\s+(ORDER\s+BY|LIMIT)\s/i;

/** Skip whitespace INSIDE a traversal bracket — newlines and tabs included, so
 *  a long `-[…]->` hop (WHERE / ORDER BY / LIMIT) may wrap across lines. The
 *  bracket is delimited by `]`, not by newlines. */
function skipBracketWs(input: string, i: number): number {
  while (i < input.length && /\s/.test(input[i])) i++;
  return i;
}

/** ` ASC` / ` DESC` closing an ORDER BY key, at the key's top level. */
const ORDER_DIRECTION_CLAUSE = /^\s+(ASC|DESC)(\s|\]|$)/i;

/**
 * Parse trailing `ORDER BY <key> [ASC|DESC]` / `LIMIT <n>` clauses inside a
 * traversal bracket — `-[c:companies WHERE … ORDER BY \`created_at\` DESC
 * LIMIT 10]->`, `-[e:Entries ORDER BY e-[:Signal]->.\`Discovered At\` DESC]->`.
 *
 * The key is an EXPRESSION over the element the hop lands on, so it is read
 * here as TEXT — up to the direction, the LIMIT, or the hop's own `]` — and
 * parsed by whichever lowering owns the resolvers (exactly how the WHERE is
 * handled). Nested brackets, parens and quotes are tracked so a sub-hop or a
 * string inside the key doesn't end it early.
 *
 * Returns how much input was consumed.
 *
 */
function parseBracketOrderLimit(input: string, start: number): {
  orderByText?: string;
  orderDirection?: 'asc' | 'desc';
  limit?: number;
  length: number;
} {
  let i = start;
  const out: { orderByText?: string; orderDirection?: 'asc' | 'desc'; limit?: number; length: number } = { length: 0 };
  i = skipBracketWs(input, i);
  const orderMatch = /^ORDER\s+BY\s+/i.exec(input.slice(i));
  if (orderMatch) {
    i += orderMatch[0].length;
    const keyStart = i;
    let depth = 0;
    while (i < input.length) {
      const ch = input[i];
      if (ch === '`') {
        // A backtick-quoted name is opaque: LIMIT, DESC and `]` inside it are
        // part of the name.
        i++;
        while (i < input.length && input[i] !== '`') {
          if (input[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const q = ch;
        i++;
        while (i < input.length && input[i] !== q) {
          if (input[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === '(' || ch === '[') { depth++; i++; continue; }
      if (ch === ')') { depth--; i++; continue; }
      if (ch === ']') {
        if (depth === 0) break; // the hop's own closing bracket
        depth--;
        i++;
        continue;
      }
      if (depth === 0 && (ORDER_DIRECTION_CLAUSE.test(input.slice(i)) || BRACKET_TRAILING_CLAUSE.test(input.slice(i)))) {
        break;
      }
      i++;
    }
    const keyText = input.slice(keyStart, i).trim();
    if (keyText) {
      out.orderByText = keyText;
      i = skipBracketWs(input, i);
      const dir = /^(ASC|DESC)\b/i.exec(input.slice(i));
      if (dir) {
        out.orderDirection = dir[1].toLowerCase() as 'asc' | 'desc';
        i += dir[1].length;
      }
    }
  }
  i = skipBracketWs(input, i);
  const limitMatch = /^LIMIT\s+(\d+)/i.exec(input.slice(i));
  if (limitMatch) {
    out.limit = Number(limitMatch[1]);
    i += limitMatch[0].length;
  }
  i = skipBracketWs(input, i);
  out.length = i - start;
  return out;
}

/** Parse edge name (and optional WHERE clause, `ORDER BY`/`LIMIT` trailing
 *  clauses, or `{ ... }` config object)
 *  inside -[:Name WHERE ...]-> / -[:`Quoted Name`]-> / -[#extract { ... }]-> */
function parseBracketContent(input: string, start: number): { name: string; filterText?: string; configText?: string; orderByText?: string; orderDirection?: 'asc' | 'desc'; limit?: number; length: number } | null {
  let i = start;
  // Skip whitespace
  i = skipBracketWs(input, i);

  if (i >= input.length) return null;

  let name: string;

  // Backtick-quoted name
  if (input[i] === '`') {
    i++;
    name = '';
    while (i < input.length && input[i] !== '`') {
      if (input[i] === '\\' && i + 1 < input.length) { name += input[++i]; }
      else { name += input[i]; }
      i++;
    }
    if (i < input.length) i++; // closing backtick
  } else {
    // Unquoted name — read until ], WHERE, ORDER BY/LIMIT, or `{` (config object)
    name = '';
    while (i < input.length && input[i] !== ']' && input[i] !== '\n' && input[i] !== '{') {
      // Check for WHERE / trailing-clause keywords
      if (input.slice(i).match(/^\s+WHERE\s/i)) {
        break;
      }
      if (BRACKET_TRAILING_CLAUSE.test(input.slice(i))) {
        break;
      }
      name += input[i]; i++;
    }
    name = name.trimEnd();
    if (!name) return null;
  }

  // Check for WHERE clause or `{` config object
  let filterText: string | undefined;
  let configText: string | undefined;
  i = skipBracketWs(input, i);
  if (i + 5 < input.length && input.slice(i, i + 5).toUpperCase() === 'WHERE' && /\s/.test(input[i + 5])) {
    i += 5; // skip WHERE
    i = skipBracketWs(input, i);
    const filterStart = i;
    // Read until the hop's closing ] or a top-level trailing clause
    // (ORDER BY / LIMIT). Track nested ( ) AND [ ] so a parenthesised
    // sub-expression or an array literal (`Status IN ["a", "b"]`) inside the
    // WHERE doesn't end the bracket early.
    let depth = 0;
    while (i < input.length) {
      if (input[i] === '(' || input[i] === '[') depth++;
      else if (input[i] === ')') depth--;
      else if (input[i] === ']') {
        if (depth === 0) break; // the hop's own closing bracket
        depth--; // a nested array literal's bracket
      }
      else if (depth === 0 && BRACKET_TRAILING_CLAUSE.test(input.slice(i))) break;
      else if (input[i] === '"' || input[i] === "'") {
        // Skip string literals
        const q = input[i]; i++;
        while (i < input.length && input[i] !== q) {
          if (input[i] === '\\') i++;
          i++;
        }
      }
      i++;
    }
    filterText = input.slice(filterStart, i).trimEnd();
    if (!filterText) filterText = undefined;
  } else if (i < input.length && input[i] === '{') {
    // Config object: balanced `{ ... }`. Tracks string-literal boundaries
    // so a stray `{` / `}` inside a quoted value doesn't unbalance depth.
    const cfgStart = i + 1;
    let depth = 1;
    i++;
    while (i < input.length && depth > 0) {
      const ch = input[i];
      if (ch === '"' || ch === "'") {
        const q = ch; i++;
        while (i < input.length && input[i] !== q) {
          if (input[i] === '\\') i++;
          i++;
        }
        if (i < input.length) i++; // closing quote
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth === 0) break;
      i++;
    }
    configText = input.slice(cfgStart, i).trim();
    if (i < input.length && input[i] === '}') i++; // consume closing }
    i = skipBracketWs(input, i);
  }

  // Trailing `ORDER BY <prop> [ASC|DESC]` / `LIMIT <n>` clauses.
  const trailing = parseBracketOrderLimit(input, i);
  i += trailing.length;

  return {
    name,
    length: i - start,
    ...(filterText !== undefined ? { filterText } : {}),
    ...(configText !== undefined ? { configText } : {}),
    ...(trailing.orderByText !== undefined ? { orderByText: trailing.orderByText } : {}),
    ...(trailing.orderDirection !== undefined ? { orderDirection: trailing.orderDirection } : {}),
    ...(trailing.limit !== undefined ? { limit: trailing.limit } : {}),
  };
}

/**
 * Parse cypher-bracket interior with an optional alias prefix:
 *   `name:Edge` / `name:#extract { ... }` / `\`Quoted Name\`:Edge`
 * Returns null when no alias-colon pattern matches (caller falls
 * back to the legacy `:Name` / `#Name` paths).
 */
function parseAliasBracketContent(input: string, start: number):
  | { alias: string; rawName: string; filterText?: string; configText?: string; orderByText?: string; orderDirection?: 'asc' | 'desc'; limit?: number; length: number }
  | null {
  let i = start;
  i = skipBracketWs(input, i);
  if (i >= input.length) return null;

  let alias: string | undefined;
  let probe = i;
  if (input[probe] === '`') {
    probe++;
    let aliasName = '';
    while (probe < input.length && input[probe] !== '`') {
      if (input[probe] === '\\' && probe + 1 < input.length) { aliasName += input[++probe]; }
      else { aliasName += input[probe]; }
      probe++;
    }
    if (probe < input.length && input[probe] === '`') {
      probe++;
      probe = skipBracketWs(input, probe);
      if (input[probe] === ':') {
        alias = aliasName;
        i = probe + 1;
      }
    }
  } else if (/[a-zA-Z_]/.test(input[probe])) {
    let aliasName = '';
    while (probe < input.length && /[a-zA-Z0-9_]/.test(input[probe])) {
      aliasName += input[probe]; probe++;
    }
    let p2 = probe;
    p2 = skipBracketWs(input, p2);
    if (input[p2] === ':') {
      alias = aliasName;
      i = p2 + 1;
    }
  }

  if (alias === undefined) return null;

  i = skipBracketWs(input, i);
  const inner = parseBracketContent(input, i);
  if (!inner) return null;
  return {
    alias,
    rawName: inner.name,
    length: (i - start) + inner.length,
    ...(inner.filterText !== undefined ? { filterText: inner.filterText } : {}),
    ...(inner.configText !== undefined ? { configText: inner.configText } : {}),
    ...(inner.orderByText !== undefined ? { orderByText: inner.orderByText } : {}),
    ...(inner.orderDirection !== undefined ? { orderDirection: inner.orderDirection } : {}),
    ...(inner.limit !== undefined ? { limit: inner.limit } : {}),
  };
}

/**
 * Split config-object body text into `key: value` segments by locating
 * top-level commas (skipping nested `[]`, `{}`, `()`, and string literals).
 */
function splitConfigSegments(body: string): { key: string; valueText: string }[] {
  const segments: { key: string; valueText: string }[] = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    let key = '';
    if (body[i] === '`') {
      i++;
      while (i < body.length && body[i] !== '`') {
        if (body[i] === '\\' && i + 1 < body.length) { key += body[++i]; }
        else { key += body[i]; }
        i++;
      }
      if (i < body.length) i++;
    } else {
      while (i < body.length && /[a-zA-Z0-9_]/.test(body[i])) { key += body[i]; i++; }
    }
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== ':') {
      throw new ParseError(`Expected ":" after config key "${key}"`, i);
    }
    i++;
    while (i < body.length && /\s/.test(body[i])) i++;
    const valueStart = i;
    let depth = 0;
    while (i < body.length) {
      const ch = body[i];
      if (ch === '"' || ch === "'") {
        const q = ch; i++;
        while (i < body.length && body[i] !== q) {
          if (body[i] === '\\') i++;
          i++;
        }
        if (i < body.length) i++;
        continue;
      }
      if (ch === '[' || ch === '{' || ch === '(') depth++;
      else if (ch === ']' || ch === '}' || ch === ')') depth--;
      else if (ch === ',' && depth === 0) break;
      i++;
    }
    const valueText = body.slice(valueStart, i).trim();
    segments.push({ key, valueText });
    if (body[i] === ',') i++;
  }
  return segments;
}

/**
 * Parse a JSON-style config object from cypher-bracket interior.
 * The input is the inside of the `{ ... }` block — e.g.
 *   `description: "investment opportunity", data: [msg.content]`
 *
 * Recognised keys:
 *   - `description: <expression>`
 *   - `data: [expr, expr, ...]`
 *   - `plugin: <expression>`
 *   - `enrich_with: [ { transform: <expr>, argument: <expr> }, ... ]` (W5-D3)
 *   - any other key is captured into `extra`
 *
 * Each value expression is parsed via the supplied `parseValueExpr`
 * callback (typically `parser.parseSubExpression`) so the surrounding
 * resolvers + TG-mode flag propagate.
 */
function parseConfigObject(
  configText: string,
  basePos: number,
  parseValueExpr: (text: string) => Expression,
): MetaEdgeStep['config'] | undefined {
  const body = configText.trim();
  if (!body) return undefined;
  const segments = splitConfigSegments(body);
  const cfg: NonNullable<MetaEdgeStep['config']> = {};
  for (const { key, valueText } of segments) {
    if (!valueText) {
      throw new ParseError(`Empty value for config key "${key}"`, basePos);
    }
    if (key === 'enrich_with') {
      cfg.enrichWith = parseEnrichWithList(valueText, basePos, parseValueExpr);
      continue;
    }
    const value = parseValueExpr(valueText);
    if (key === 'description') cfg.description = value;
    else if (key === 'data') {
      if (value.type !== 'list') {
        throw new ParseError(
          `data: expects a list literal [expr, expr, ...]`,
          basePos,
        );
      }
      // `data:` names the values the extraction reads, one by one — a spread
      // would hand it a collection nobody listed, so it is refused here rather
      // than read as one opaque member.
      const spread = value.elements.find(e => e.type === 'spread');
      if (spread !== undefined) {
        throw new ParseError(`data: lists its values one by one — a spread ('...') is not accepted here`, basePos);
      }
      cfg.data = value.elements.map(listElementExpression);
    }
    else if (key === 'plugin') cfg.plugin = value;
    else {
      cfg.extra = cfg.extra ?? {};
      cfg.extra[key] = value;
    }
  }
  return Object.keys(cfg).length === 0 ? undefined : cfg;
}

/**
 * Parse the `enrich_with: [ {transform: ..., argument: ...}, ... ]` value
 * text. The grammar is intentionally narrow: an entry's braces enclose two
 * TRANSFORM REFERENCES, not a value, so this is its own production rather
 * than the generic object literal (`{ key: <expr> }`, parsed in
 * `parsePrimary`). The only structure recognised here is the
 * `{ transform, argument }` pair, where each value is parsed back through
 * the surrounding expression parser via `parseValueExpr`.
 */
function parseEnrichWithList(
  valueText: string,
  basePos: number,
  parseValueExpr: (text: string) => Expression,
): EnrichWithEntry[] {
  const trimmed = valueText.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new ParseError(
      `enrich_with: expects a list literal [{ transform: ..., argument: ... }, ...]`,
      basePos,
    );
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const entries: EnrichWithEntry[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i])) i++;
    if (i >= inner.length) break;
    if (inner[i] !== '{') {
      throw new ParseError(
        `enrich_with: each entry must be an object literal { transform: ..., argument: ... }`,
        basePos,
      );
    }
    const objStart = i + 1;
    let depth = 1;
    i = objStart;
    while (i < inner.length && depth > 0) {
      const ch = inner[i];
      if (ch === '"' || ch === "'") {
        const q = ch;
        i++;
        while (i < inner.length && inner[i] !== q) {
          if (inner[i] === '\\' && i + 1 < inner.length) i++;
          i++;
        }
        if (i < inner.length) i++;
        continue;
      }
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') depth--;
      if (depth === 0) break;
      i++;
    }
    if (depth !== 0) {
      throw new ParseError(`enrich_with: unterminated object literal`, basePos);
    }
    const objBody = inner.slice(objStart, i);
    i++; // consume '}'
    while (i < inner.length && /\s/.test(inner[i])) i++;
    if (i < inner.length && inner[i] === ',') i++;
    const entry: Partial<EnrichWithEntry> = {};
    for (const seg of splitConfigSegments(objBody)) {
      if (!seg.valueText) {
        throw new ParseError(`enrich_with entry: empty value for "${seg.key}"`, basePos);
      }
      const expr = parseValueExpr(seg.valueText);
      if (seg.key === 'transform') entry.transform = expr;
      else if (seg.key === 'argument') entry.argument = expr;
      else {
        throw new ParseError(
          `enrich_with entry: unrecognised key "${seg.key}" (expected "transform" or "argument")`,
          basePos,
        );
      }
    }
    if (!entry.transform || !entry.argument) {
      throw new ParseError(
        `enrich_with entry: requires both "transform" and "argument"`,
        basePos,
      );
    }
    entries.push(entry as EnrichWithEntry);
  }
  return entries;
}

const RESOURCE_TYPES = new Set(['URL', 'EMAIL', 'WHATSAPP', 'FILE', 'TEXT']);

/**
 * The reserved resource-hop edge name. A `-[:_resources]->` / `-[a:_resources]->`
 * hop is the type's attached resource bundle, parsing to `resource_traverse`.
 * `_resources` is canonical: a leading-underscore identifier (no `#`), so it
 * parses everywhere an edge name can appear — the movement language treats a
 * leading `#` as a comment outside traversal brackets, which swallowed the older
 * `#resources` label. The underscore also marks it reserved/meta and keeps it
 * clear of extraction-derived names. `#resources` stays accepted as a deprecated
 * bracket-position alias for legacy expressions.
 *
 * The `:TYPE` shorthand (`_resources:TEXT`) is the part before the colon.
 */
function isResourceHop(rawName: string): boolean {
  const base = rawName.split(/[:\s]/, 1)[0];
  return base === '_resources' || base === '#resources';
}

/**
 * Parse a resource filter from the bracket name and optional WHERE clause.
 *
 * Supports:
 *   -[#resources]->                          — no filter
 *   -[#resources:TEXT]->                     — shorthand for type
 *   -[#resources WHERE type = "TEXT"]->      — explicit type
 *   -[#resources WHERE hasDocument]->        — boolean flag
 *   -[#resources WHERE mimeType = "application/pdf"]->
 *   -[#resources WHERE namePattern = "invoice.*"]->
 *   -[#resources WHERE type = "FILE" AND hasDocument]->  — combined
 */
/** Fields a `_resources WHERE` predicate may read, mapped to their canonical
 *  resource-leaf names (matched case-insensitively; `mimeType` stays as the
 *  historical alias for the file's content type). */
const RESOURCE_WHERE_FIELDS: Record<string, 'name' | 'url' | 'type' | 'document_url' | 'content' | 'contentType'> = {
  type: 'type',
  resourcetype: 'type',
  name: 'name',
  url: 'url',
  content: 'content',
  document_url: 'document_url',
  contenttype: 'contentType',
  mimetype: 'contentType',
};

/** The `:TYPE` shorthand (`_resources:TEXT`), desugared to the same predicate
 *  a `WHERE type == "TEXT"` produces — one filter currency, no side grammar. */
function resourceTypeShorthand(rawName: string): Expression | undefined {
  const colonIdx = rawName.indexOf(':');
  if (colonIdx === -1) return undefined;
  const typeVal = rawName.slice(colonIdx + 1).trim().toUpperCase();
  if (!RESOURCE_TYPES.has(typeVal)) return undefined;
  return {
    type: 'compare',
    op: 'eq',
    left: { type: 'resource', field: 'type' },
    right: { type: 'static', value: typeVal },
  };
}

/**
 * Parse a `_resources` hop's WHERE with the SAME nested Parser every other
 * hop uses (so `==`/`=`, AND/OR/NOT, quoting all behave identically), then
 * rebind its bare-name leaves to resource fields. Anything a per-resource
 * predicate can't evaluate (traversals, AI(), aggregates) is a loud error.
 */
function parseResourceWhere(filterText: string): Expression {
  const resolveField = (name: string) => RESOURCE_WHERE_FIELDS[name.toLowerCase()];
  let parsed: Expression;
  try {
    parsed = new Parser(tokenize(filterText), resolveField, resolveField).parse();
  } catch (e) {
    if (e instanceof ParseError && e.message.startsWith('Unknown property')) {
      throw new ParseError(
        `${e.message} — a _resources WHERE can read: type, name, url, content, document_url, contentType (alias mimeType)`,
        e.pos,
      );
    }
    throw e;
  }
  return toResourcePredicate(parsed);
}

function toResourcePredicate(expr: Expression): Expression {
  switch (expr.type) {
    case 'property':
    case 'edge_property':
      return {
        type: 'resource',
        field: expr.propertyTypeId as 'name' | 'url' | 'type' | 'document_url' | 'content' | 'contentType',
      };
    case 'static':
    case 'resource':
      return expr;
    case 'compare':
      return { ...expr, left: toResourcePredicate(expr.left), right: toResourcePredicate(expr.right) };
    case 'logical':
      return { ...expr, operands: expr.operands.map(toResourcePredicate) };
    case 'not':
      return { ...expr, expression: toResourcePredicate(expr.expression) };
    case 'negate':
      return { ...expr, expression: toResourcePredicate(expr.expression) };
    case 'list':
      return { ...expr, elements: expr.elements.map(e => mapListElement(e, toResourcePredicate)) };
    default:
      throw new ParseError(
        `a _resources WHERE compares resource fields — '${expr.type}' is not supported here`,
        0,
      );
  }
}

/**
 * Parse linked object filter from WHERE clause.
 * Extracts adapter type from `type = "ATTIO"`.
 */
function parseLinkedFilter(filterText?: string): string {
  if (!filterText) return '';
  const match = filterText.match(/type\s*=\s*"([^"]*)"/i)
    ?? filterText.match(/type\s*=\s*'([^']*)'/i)
    ?? filterText.match(/type\s*=\s*(\S+)/i);
  return match?.[1]?.toUpperCase() ?? '';
}

/**
 * The one escape rule for string literals, shared with the movement
 * bridge's interpolated-string desugar: `\n` / `\t` / `\r` translate to
 * their control characters; any other escaped character is itself
 * (`\"` a quote, `\\` a backslash, `\$` a literal dollar before `{`).
 */
export function translateStringEscape(next: string): string {
  switch (next) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    default:
      return next;
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) { i++; continue; }

    const pos = i;

    // String literal
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      i++;
      let value = '';
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) { value += translateStringEscape(input[++i]); }
        else { value += input[i]; }
        i++;
      }
      if (i < input.length) i++; // closing quote
      tokens.push({ type: 'string', value, pos, end: i });
      continue;
    }

    // Backtick-quoted identifier
    if (input[i] === '`') {
      i++;
      let value = '';
      while (i < input.length && input[i] !== '`') {
        if (input[i] === '\\' && i + 1 < input.length) { value += input[++i]; }
        else { value += input[i]; }
        i++;
      }
      if (i < input.length) i++; // closing backtick
      tokens.push({ type: 'ident', value, pos, end: i });
      continue;
    }

    // Number
    if (/[0-9]/.test(input[i]) || (input[i] === '-' && i + 1 < input.length && /[0-9]/.test(input[i + 1]) && (tokens.length === 0 || tokens[tokens.length - 1].type === 'op' || tokens[tokens.length - 1].type === 'paren' || tokens[tokens.length - 1].type === 'comma'))) {
      let num = '';
      if (input[i] === '-') { num += input[i]; i++; }
      while (i < input.length && /[0-9.]/.test(input[i])) { num += input[i]; i++; }
      tokens.push({ type: 'number', value: num, pos, end: i });
      continue;
    }

    // @ special prefix
    if (input[i] === '@') {
      i++;
      let value = '@';
      while (i < input.length && /[a-zA-Z0-9_.]/.test(input[i])) { value += input[i]; i++; }
      tokens.push({ type: 'special', value, pos, end: i });
      continue;
    }

    // Cypher-like traversal arrows: -[:Name]-> / <-[:Name]- / -[:Name WHERE ...]->
    // Cypher-bracket alias form: -[name:Edge]-> / -[name:#extract { ... }]->
    // Special traversals: -[#resources...]-> / -[#linked...]->
    if (input[i] === '-' && input[i + 1] === '[') {
      // Try alias-bracket form first when the char after `[` isn't `:` or `#`.
      if (input[i + 2] !== ':' && input[i + 2] !== '#') {
        const aliased = parseAliasBracketContent(input, i + 2);
        if (aliased) {
          const afterContent = i + 2 + aliased.length;
          let end: number | null = null;
          if (input[afterContent] === ']' && input[afterContent + 1] === '-' && input[afterContent + 2] === '>') {
            end = afterContent + 3;
          } else if (input[afterContent] === ']' && input[afterContent + 1] === '-') {
            end = afterContent + 2;
          }
          if (end !== null) {
            const tok: Token = {
              type: 'traverse',
              value: aliased.rawName,
              pos,
              end,
              alias: aliased.alias,
              ...(aliased.filterText !== undefined ? { filterText: aliased.filterText } : {}),
              ...(aliased.configText !== undefined ? { configText: aliased.configText } : {}),
              ...(aliased.orderByText !== undefined ? { orderByText: aliased.orderByText } : {}),
              ...(aliased.orderDirection !== undefined ? { orderDirection: aliased.orderDirection } : {}),
              ...(aliased.limit !== undefined ? { limitCount: aliased.limit } : {}),
            };
            tokens.push(tok);
            i = end;
            continue;
          }
        }
      }
      if (input[i + 2] === ':' || input[i + 2] === '#') {
        // Legacy form: -[: or -[#
        const offset = input[i + 2] === ':' ? i + 3 : i + 2; // # is part of the name
        const content = parseBracketContent(input, offset);
        if (content) {
          const afterName = offset + content.length;
          let end: number | null = null;
          if (input[afterName] === ']' && input[afterName + 1] === '-' && input[afterName + 2] === '>') {
            end = afterName + 3;
          } else if (input[afterName] === ']' && input[afterName + 1] === '-') {
            end = afterName + 2;
          }
          if (end !== null) {
            const tok: Token = {
              type: 'traverse',
              value: content.name,
              pos,
              end,
              ...(content.filterText !== undefined ? { filterText: content.filterText } : {}),
              ...(content.configText !== undefined ? { configText: content.configText } : {}),
              ...(content.orderByText !== undefined ? { orderByText: content.orderByText } : {}),
              ...(content.orderDirection !== undefined ? { orderDirection: content.orderDirection } : {}),
              ...(content.limit !== undefined ? { limitCount: content.limit } : {}),
            };
            tokens.push(tok);
            i = end;
            continue;
          }
        }
      }
    }
    if (input[i] === '<' && input[i + 1] === '-' && input[i + 2] === '[' && input[i + 3] === ':') {
      // Incoming edge start: <-[:
      const content = parseBracketContent(input, i + 4);
      if (content) {
        const afterName = i + 4 + content.length;
        if (input[afterName] === ']' && input[afterName + 1] === '-') {
          tokens.push({
            type: 'traverse', value: '<' + content.name, pos, end: afterName + 2,
            filterText: content.filterText,
            ...(content.orderByText !== undefined ? { orderByText: content.orderByText } : {}),
            ...(content.orderDirection !== undefined ? { orderDirection: content.orderDirection } : {}),
            ...(content.limit !== undefined ? { limitCount: content.limit } : {}),
          });
          i = afterName + 2;
          continue;
        }
      }
    }

    // Multi-char operators
    if (input[i] === '!' && input[i + 1] === '=') {
      tokens.push({ type: 'op', value: '!=', pos, end: i + 2 }); i += 2; continue;
    }
    // A lone `!` is TypeScript's spelling of NOT — the parser folds it into
    // the same `not` node, so `!x` and `NOT x` are one expression.
    if (input[i] === '!') {
      tokens.push({ type: 'keyword', value: 'NOT', pos, end: i + 1 }); i++; continue;
    }
    if (input[i] === '>' && input[i + 1] === '=') {
      tokens.push({ type: 'op', value: '>=', pos, end: i + 2 }); i += 2; continue;
    }
    if (input[i] === '<' && input[i + 1] === '=') {
      tokens.push({ type: 'op', value: '<=', pos, end: i + 2 }); i += 2; continue;
    }
    // `==` is a common alias for `=`. Without this, `==` tokenizes as
    // two separate `=` ops which breaks in-string enum completion (the
    // LHS lookup finds an op rather than the identifier).
    if (input[i] === '=' && input[i + 1] === '=') {
      tokens.push({ type: 'op', value: '=', pos, end: i + 2 }); i += 2; continue;
    }

    // Single-char operators and parens
    if ('=><+-*/%'.includes(input[i])) {
      tokens.push({ type: 'op', value: input[i], pos, end: i + 1 }); i++; continue;
    }
    if ('(),'.includes(input[i])) {
      const t = input[i] === ',' ? 'comma' : 'paren';
      tokens.push({ type: t as Token['type'], value: input[i], pos, end: i + 1 }); i++; continue;
    }
    // List-literal and config-object delimiters (`[`, `]`, `{`, `}`, `:`)
    // — only emitted at the top level. Inside cypher brackets the
    // brace pair is consumed by parseBracketContent before tokenize sees it.
    if (input[i] === '[') { tokens.push({ type: 'lbracket', value: '[', pos, end: i + 1 }); i++; continue; }
    if (input[i] === ']') { tokens.push({ type: 'rbracket', value: ']', pos, end: i + 1 }); i++; continue; }
    if (input[i] === '{') { tokens.push({ type: 'lbrace', value: '{', pos, end: i + 1 }); i++; continue; }
    if (input[i] === '}') { tokens.push({ type: 'rbrace', value: '}', pos, end: i + 1 }); i++; continue; }
    if (input[i] === ':') { tokens.push({ type: 'colon', value: ':', pos, end: i + 1 }); i++; continue; }

    // Identifier or keyword
    if (/[a-zA-Z_]/.test(input[i])) {
      let value = '';
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) { value += input[i]; i++; }
      const upper = value.toUpperCase();
      if (KEYWORDS.has(upper)) {
        tokens.push({ type: 'keyword', value: upper, pos, end: i });
      } else {
        tokens.push({ type: 'ident', value, pos, end: i });
      }
      continue;
    }

    // `...` — a list literal's spread. One token, so the parser never has to
    // reassemble it from three dots.
    if (input[i] === '.' && input[i + 1] === '.' && input[i + 2] === '.') {
      tokens.push({ type: 'spread', value: '...', pos, end: i + 3 }); i += 3; continue;
    }

    // Dot (for edge. prefix etc)
    if (input[i] === '.') {
      tokens.push({ type: 'op', value: '.', pos, end: i + 1 }); i++; continue;
    }

    // Anything else has no meaning here. It is kept as a token rather than
    // skipped — a dropped character silently changes what the expression
    // says (a skipped `!` inverted a condition) — and the parser refuses it.
    // Completion tokenizes half-typed text too, so the refusal belongs to the
    // parser, not here.
    tokens.push({ type: 'unknown', value: input[i], pos, end: i + 1 }); i++;
  }

  tokens.push({ type: 'eof', value: '', pos: input.length, end: input.length });
  return tokens;
}

export class ParseError extends Error {
  constructor(message: string, public pos: number) {
    super(message);
  }
}

/** Characters an author plausibly reaches for from another language, with
 *  what this grammar spells them as. */
const UNRECOGNISED_HINTS: Record<string, string> = {
  '&': "write AND (not & or &&)",
  '|': "write OR (not | or ||)",
  '?': 'write IF … THEN … ELSE … END (there is no ? : conditional)',
  ';': 'an expression takes no ; separator',
  '\\': 'a backslash escapes only inside a quoted string',
  '\u2013': "write the ASCII minus '-' (this is an en dash)",
  '\u2014': "write the ASCII minus '-' (this is an em dash)",
  '\u2212': "write the ASCII minus '-' (this is a typographic minus sign)",
  '\u201C': 'write a straight double quote " (this is a curly quote)',
  '\u201D': 'write a straight double quote " (this is a curly quote)',
  '\u2018': "write a straight single quote ' (this is a curly quote)",
  '\u2019': "write a straight single quote ' (this is a curly quote)",
};

/** The position rides on the error (a movement diagnostic's span points at
 *  the character), not in the text: a caller may have rewritten the slot
 *  before parsing, so an offset in the message could name the wrong column. */
function unrecognisedCharacter(token: Token): ParseError {
  return new ParseError(unrecognisedCharacterMessage(token.value), token.pos);
}

/** The refusal of a character no expression grammar reads, with the spelling
 *  the author most likely meant. Shared with the movement language's grammar
 *  (packages/movement-lang/parser/expression), so both say the same thing. */
export function unrecognisedCharacterMessage(ch: string): string {
  const hint = UNRECOGNISED_HINTS[ch];
  return `Unrecognised character '${ch}'${hint !== undefined ? ` — ${hint}` : ''}`;
}

/** The aggregate function names, and the AST kind each reads as. */
const AGG_FNS: Record<string, string> = {
  FIRST: 'first', LAST: 'last', ONLY: 'only', COUNT: 'count', SUM: 'sum', AVG: 'avg',
  MIN: 'min', MAX: 'max', JOIN: 'join', COLLECT: 'collect', LLM_AGG: 'llm',
};

/**
 * Every function name this grammar reads as something OTHER than a generic
 * call — the aggregates and the special forms `parseFunctionCall` (and
 * `SORT`'s own reader) recognise. Upper-case, as the grammar compares them.
 * Exported so a caller that has to tell a built-in call from some other
 * invocation of the same shape compares against the grammar's own list.
 */
export const FORMULA_SPECIAL_FUNCTIONS: ReadonlySet<string> = new Set([
  ...Object.keys(AGG_FNS),
  'AI', 'CONCAT', 'KG_EXISTS', 'KG_VALUE', 'EXTRACT_VALUE', 'AT', 'SORT',
]);

class Parser {
  private tokens: Token[];
  private pos = 0;
  private resolveProperty: (name: string) => string | undefined;
  private resolveEdgeProperty: (name: string) => string | undefined;
  private resolveEdge: (name: string) => string | undefined;
  private resolveStaticValueId: ((name: string) => string | undefined) | undefined;
  private resolveEdgeWithDirection: ((name: string) => { id: string; direction: 'outgoing' | 'incoming' } | undefined) | undefined;
  private edgePropertyMode: boolean; // in WHERE context, identifiers resolve as edge_property
  private allProperties?: PropertyInfo[];
  private allEdges?: EdgeInfo[];
  private currentNodeTypeId?: string;
  /** TG-parity parsing mode. When enabled: unknown bare-name identifiers
   *  fall back to `alias_ref` rather than throwing. Alias-rooted
   *  traversal (`opp.field` / `msg-[:Edge]->.field`) is always on — its
   *  dispatch is keyed on lookahead, not on tgMode, so legacy syntax
   *  remains untouched. */
  tgMode: boolean;

  constructor(
    tokens: Token[],
    resolveProperty: (name: string) => string | undefined,
    resolveEdgeProperty: (name: string) => string | undefined,
    resolveEdge?: (name: string) => string | undefined,
    edgePropertyMode?: boolean,
    resolveStaticValueId?: (name: string) => string | undefined,
    resolveEdgeWithDirection?: (name: string) => { id: string; direction: 'outgoing' | 'incoming' } | undefined,
    allProperties?: PropertyInfo[],
    allEdges?: EdgeInfo[],
    startNodeTypeId?: string,
    tgMode?: boolean,
  ) {
    this.tokens = tokens;
    this.resolveProperty = resolveProperty;
    this.resolveEdgeProperty = resolveEdgeProperty;
    this.resolveEdge = resolveEdge ?? (() => undefined);
    this.edgePropertyMode = edgePropertyMode ?? false;
    this.resolveStaticValueId = resolveStaticValueId;
    this.resolveEdgeWithDirection = resolveEdgeWithDirection;
    this.allProperties = allProperties;
    this.allEdges = allEdges;
    this.currentNodeTypeId = startNodeTypeId;
    this.tgMode = tgMode ?? false;
    const unknown = tokens.find(t => t.type === 'unknown');
    if (unknown !== undefined) throw unrecognisedCharacter(unknown);
  }

  /**
   * Parse a standalone sub-expression in the same scope as this parser
   * (same resolvers, same node-type context, same tgMode). Used by
   * meta-edge config-object parsing — each `key: value` pair's value
   * text is parsed via a child parser.
   */
  parseSubExpression(text: string): Expression {
    const subTokens = tokenize(text);
    const sub = new Parser(
      subTokens,
      this.resolveProperty,
      this.resolveEdgeProperty,
      this.resolveEdge,
      this.edgePropertyMode,
      this.resolveStaticValueId,
      this.resolveEdgeWithDirection,
      this.allProperties,
      this.allEdges,
      this.currentNodeTypeId,
      this.tgMode,
    );
    return sub.parse();
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }

  /** Resolve an edge name using the current node type context.
   *  Returns the correct direction based on which end of the edge the current node is on. */
  private resolveEdgeFromContext(name: string): { id: string; direction: 'outgoing' | 'incoming' } | undefined {
    if (!this.allEdges || !this.currentNodeTypeId) return undefined;
    const lower = name.toLowerCase();
    for (const e of this.allEdges) {
      const nameMatch = e.outboundName.toLowerCase() === lower || e.inboundName.toLowerCase() === lower;
      if (!nameMatch) continue;
      if (e.sourceNodeTypeId === this.currentNodeTypeId) return { id: e.id, direction: 'outgoing' };
      if (e.targetNodeTypeId === this.currentNodeTypeId) return { id: e.id, direction: 'incoming' };
    }
    return undefined;
  }

  private expect(type: Token['type'], value?: string): Token {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new ParseError(
        `Expected ${value ?? type}, got ${t.value || 'end of input'}`,
        t.pos,
      );
    }
    return this.advance();
  }

  private match(type: Token['type'], value?: string): Token | null {
    const t = this.peek();
    if (t.type === type && (value === undefined || t.value === value)) {
      return this.advance();
    }
    return null;
  }

  parse(): Expression {
    const expr = this.parseExpr();
    if (this.peek().type !== 'eof') {
      throw new ParseError(`Unexpected ${this.peek().value}`, this.peek().pos);
    }
    return expr;
  }

  private parseExpr(): Expression {
    return this.parseOr();
  }

  private parseOr(): Expression {
    let left = this.parseAnd();
    while (this.match('keyword', 'OR')) {
      const right = this.parseAnd();
      if (left.type === 'logical' && left.op === 'or') {
        left = { type: 'logical', op: 'or', operands: [...left.operands, right] };
      } else {
        left = { type: 'logical', op: 'or', operands: [left, right] };
      }
    }
    return left;
  }

  private parseAnd(): Expression {
    let left = this.parseNot();
    while (this.match('keyword', 'AND')) {
      const right = this.parseNot();
      if (left.type === 'logical' && left.op === 'and') {
        left = { type: 'logical', op: 'and', operands: [...left.operands, right] };
      } else {
        left = { type: 'logical', op: 'and', operands: [left, right] };
      }
    }
    return left;
  }

  /** `NOT x` and `!x` are one operator (the tokenizer folds `!` to NOT), at
   *  NOT's precedence — so `!a = b` is `NOT (a = b)`, not TypeScript's
   *  `(!a) === b`, and `serialize`'s `NOT` spelling round-trips either. */
  private parseNot(): Expression {
    if (this.match('keyword', 'NOT')) {
      return { type: 'not', expression: this.parseNot() };
    }
    return this.parseCompare();
  }

  private parseCompare(): Expression {
    const left = this.parseAdd();
    const t = this.peek();

    // Check for comparison operators
    if (t.type === 'op' && COMPARE_OPS.has(t.value)) {
      const op = this.advance().value;
      const right = this.parseAdd();
      return { type: 'compare', op: this.toFilterOp(op), left, right };
    }
    if (t.type === 'keyword' && t.value === 'CONTAINS') {
      this.advance();
      const right = this.parseAdd();
      return { type: 'compare', op: 'contains', left, right };
    }
    if (t.type === 'keyword' && t.value === 'EXISTS') {
      this.advance();
      return { type: 'compare', op: 'exists', left, right: { type: 'static', value: true } };
    }
    if (t.type === 'keyword' && t.value === 'IN') {
      this.advance();
      const right = this.parseAdd();
      return { type: 'compare', op: 'in', left, right };
    }
    // `<field> WITHIN <duration>` — recency operator. `WITHIN` stays a bare
    // identifier (not a global keyword) so the legacy `WITHIN(field, "…")`
    // function form keeps parsing; only the infix position is intercepted.
    if (t.type === 'ident' && t.value.toUpperCase() === 'WITHIN') {
      this.advance();
      const right = this.parseDuration();
      return { type: 'compare', op: 'within', left, right };
    }

    return left;
  }

  /** A duration literal after `WITHIN` — a bare `30d` / `12h` / `1w`
   *  (number immediately followed by a single-letter unit) or a quoted
   *  `"30d"`. Carried as a `static` string the shared filter unit parses. */
  private parseDuration(): Expression {
    const t = this.peek();
    if (t.type === 'string') {
      this.advance();
      return { type: 'static', value: String(t.value) };
    }
    if (t.type === 'number') {
      const numTok = this.advance();
      const unit = this.peek();
      if (unit.type === 'ident' && unit.pos === numTok.end && /^[smhdw]$/i.test(unit.value)) {
        this.advance();
        return { type: 'static', value: `${numTok.value}${unit.value.toLowerCase()}` };
      }
      throw new ParseError('WITHIN expects a duration like 30d, 12h, or 1w', numTok.pos);
    }
    throw new ParseError('WITHIN expects a duration like 30d, 12h, or 1w', t.pos);
  }

  private toFilterOp(op: string): FilterOperator {
    const map: Record<string, FilterOperator> = {
      '=': 'eq', '!=': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
    };
    return map[op] ?? 'eq';
  }

  private parseAdd(): Expression {
    let left = this.parseMul();
    while (true) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '+' || t.value === '-')) {
        const op = this.advance().value as '+' | '-';
        const right = this.parseMul();
        left = { type: 'arithmetic', op, left, right };
      } else if (t.type === 'keyword' && t.value === 'CONCAT') {
        // CONCAT is handled as a function call in parsePrimary
        break;
      } else {
        break;
      }
    }
    return left;
  }

  private parseMul(): Expression {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        const op = this.advance().value as '*' | '/' | '%';
        const right = this.parseUnary();
        left = { type: 'arithmetic', op, left, right };
      } else {
        break;
      }
    }
    return left;
  }

  /** `-x`, `-(a + b)`, `--x` — a prefix minus, recursing on itself so a chain
   *  of signs parses (rare, but `unary = '-' unary | primary` says it should).
   *  Distinct from the traversal form: `x-[:edge]->` never reaches here — the
   *  statement layer's path-head scan consumes `-[` before an expression is
   *  handed to this parser at all. */
  private parseUnary(): Expression {
    const t = this.peek();
    if (t.type === 'op' && t.value === '-') {
      this.advance();
      return { type: 'negate', expression: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  /**
   * `options.scopedCall` — this primary is the terminal of a dot-chain
   * (`DATETIME.AT(…)`), so a call here is SCOPED BY ITS ROOT and is not one of
   * the bare built-ins. `AT(list, index)` is a built-in; `DATETIME.AT(…)` is a
   * different function that happens to share a member name, and reading the
   * second as the first is a nominal collision the dot already resolves.
   */
  private parsePrimary(options: { scopedCall?: boolean } = {}): Expression {
    const t = this.peek();

    // Parenthesized expression
    if (t.type === 'paren' && t.value === '(') {
      this.advance();
      const expr = this.parseExpr();
      this.expect('paren', ')');
      return expr;
    }

    // IF expression
    if (t.type === 'keyword' && t.value === 'IF') {
      return this.parseIf();
    }

    // Boolean/null keywords
    if (t.type === 'keyword' && t.value === 'TRUE') { this.advance(); return { type: 'static', value: true }; }
    if (t.type === 'keyword' && t.value === 'FALSE') { this.advance(); return { type: 'static', value: false }; }
    if (t.type === 'keyword' && t.value === 'NULL') { this.advance(); return { type: 'static', value: null }; }

    // String literal — resolve display name → ID if a mapping is provided
    if (t.type === 'string') {
      this.advance();
      const mapped = this.resolveStaticValueId?.(t.value);
      return { type: 'static', value: mapped ?? t.value };
    }

    // Number literal
    if (t.type === 'number') {
      this.advance();
      const n = t.value.includes('.') ? parseFloat(t.value) : parseInt(t.value, 10);
      return { type: 'static', value: n };
    }

    // Special (@meta, @parent, @resource)
    if (t.type === 'special') {
      this.advance();
      const v = t.value.slice(1); // remove @
      if (v.startsWith('parent.')) return { type: 'parent_result', field: v.slice(7) as 'created' | 'external_id' };
      if (v.startsWith('resource.')) return { type: 'resource', field: v.slice(9) as 'name' | 'url' | 'type' | 'document_url' | 'content' };
      return { type: 'meta', key: v };
    }

    // Traversal: -[:EdgeName]->.Property or <-[:EdgeName]-.Property
    // Can be chained: -[:A]->-[:B]->.Property
    if (t.type === 'traverse') {
      return this.parseTraversal();
    }

    // edge.PropertyName
    if (t.type === 'ident' && t.value.toLowerCase() === 'edge' && this.tokens[this.pos + 1]?.value === '.') {
      this.advance(); // 'edge'
      this.advance(); // '.'
      const name = this.expect('ident').value;
      const id = this.resolveEdgeProperty(name);
      if (!id) throw new ParseError(`Unknown edge property: ${name}`, t.pos);
      return { type: 'edge_property', propertyTypeId: id };
    }

    // List literal: `[ expr, expr, ... ]`. Used at the top level only;
    // inside meta-edge config objects the list is parsed via parseConfigObject.
    // A TRAILING comma is allowed — what TypeScript does, and the reason it
    // does: a multi-line literal that grows by a line, not by a line plus an
    // edit to the line above.
    //
    // A member written `...xs` SPLICES `xs`'s members in place — TypeScript's
    // array spread, and only here: there is no spread anywhere else in an
    // expression.
    if (t.type === 'lbracket') {
      this.advance();
      const elements: ListElement[] = [];
      while (this.peek().type !== 'rbracket') {
        if (this.match('spread')) {
          elements.push({ type: 'spread', expression: this.parseExpr() });
        } else {
          elements.push(this.parseExpr());
        }
        if (!this.match('comma')) break;
      }
      this.expect('rbracket');
      return { type: 'list', elements };
    }

    // Object literal: `{ key: expr, ... }`. Composes with the list literal to
    // any JSON shape. Keys are the target API's own spelling, not names to
    // resolve — see `parseObjectEntry`. Trailing comma allowed, as for a list.
    if (t.type === 'lbrace') {
      this.advance();
      const entries: ObjectEntry[] = [];
      while (this.peek().type !== 'rbrace') {
        entries.push(this.parseObjectEntry());
        if (!this.match('comma')) break;
      }
      this.expect('rbrace', '}');
      return { type: 'object', entries };
    }

    // Identifier — could be a function call, property reference, alias
    // reference, or alias-rooted traversal.
    if (t.type === 'ident') {
      this.advance();
      const name = t.value;
      const upper = name.toUpperCase();

      // Function call: NAME(args...)
      if (this.peek().type === 'paren' && this.peek().value === '(') {
        // `SORT` reads its own arguments: the direction is a bare ASC / DESC in
        // the last slot, which the generic argument parser would read as a name.
        if (upper === 'SORT' && options.scopedCall !== true) return this.parseSortCall(t.pos);
        return this.parseFunctionCall(upper, t.pos, { scoped: options.scopedCall === true });
      }

      // Alias-rooted traversal: `name.field` (dot-chain) or
      // `name-[:Edge]->.field` (alias-rooted walk). Per the F3 PM ruling
      // (2026-05-21): bare ident followed by `.` or by a traverse arrow
      // dispatches to `parseTraversal` with `aliasRoot` set; the steps
      // may be empty (dot-chain) or non-empty (walk).
      //
      // See `plans/2026-05-19-tg-extraction-parity/_execution/wave-0/F3-parser.md`.
      const next = this.peek();
      if (next.type === 'op' && next.value === '.') {
        this.advance(); // consume the `.`
        const expression = this.parsePrimary({ scopedCall: true });
        return { type: 'traverse', aliasRoot: name, steps: [], expression };
      }
      if (next.type === 'traverse') {
        return this.parseTraversal(name);
      }

      // Property reference (or edge_property in WHERE context). When the
      // resolver doesn't know the name and we're parsing in TG-mode,
      // fall back to `alias_ref` — the parser binds the bare-name
      // reference; the evaluator (R1) walks the lexical-scope stack to
      // find a matching ancestor alias. Outside TG-mode (existing
      // v3 / KG paths) unknown names still throw, preserving backward
      // compatibility with existing tests.
      const id = this.resolveProperty(name);
      if (id) {
        return { type: this.edgePropertyMode ? 'edge_property' : 'property', propertyTypeId: id };
      }
      if (this.tgMode) {
        return { type: 'alias_ref', name };
      }
      throw new ParseError(`Unknown property: ${name}`, t.pos);
    }

    // `CONTAINS(a, b)` reads like a function call but CONTAINS only exists
    // between its operands — the one keyword an author plausibly writes prefix.
    if (t.type === 'keyword' && t.value === 'CONTAINS') {
      throw new ParseError(
        "CONTAINS is written between its operands — 'a CONTAINS b', not 'CONTAINS(a, b)'",
        t.pos,
      );
    }
    if (t.type === 'spread') {
      throw new ParseError(
        "'...' splices a list's members into a list literal — it is written only inside '[ … ]' ('[a, ...xs]')",
        t.pos,
      );
    }
    throw new ParseError(
      t.type === 'eof' ? 'Unexpected end of input' : `Unexpected: ${t.value}`,
      t.pos,
    );
  }

  /**
   * One `key: <expr>` pair. The key is the verbatim key of the value being
   * assembled — a bare identifier (`text`, `action_id`) or a quoted string
   * when it isn't identifier-safe (`"content-type"`) — so it is never run
   * through the property resolvers. A reserved word must take the quoted
   * form: the tokenizer upper-cases keywords, so a bare one would silently
   * change the key.
   */
  private parseObjectEntry(): ObjectEntry {
    const t = this.peek();
    if (t.type === 'keyword') {
      throw new ParseError(
        `'${t.value}' is a reserved word — quote it to use it as an object key (e.g. "in": …)`,
        t.pos,
      );
    }
    if (t.type !== 'ident' && t.type !== 'string') {
      throw new ParseError(
        `An object key is a name or a quoted string (\`{ text: … }\`, \`{ "content-type": … }\`), got ${t.type === 'eof' ? 'end of input' : `'${t.value}'`}`,
        t.pos,
      );
    }
    this.advance();
    const colon = this.peek();
    if (colon.type !== 'colon') {
      throw new ParseError(
        `Expected ':' after the object key '${t.value}', got ${colon.type === 'eof' ? 'end of input' : `'${colon.value}'`}`,
        colon.pos,
      );
    }
    this.advance();
    return { key: t.value, value: this.parseExpr() };
  }

  /**
   * `SORT(collection)` / `SORT(collection, DESC)` / `SORT(collection, key)` /
   * `SORT(collection, key, DESC)` — the same members, in the order the key puts
   * them. Positional, like `toSorted`: the collection, then the key, then the
   * direction, each optional from the right.
   *
   * The key is an expression over the ELEMENT (a bare property name reads the
   * element's field, exactly as it does in a bracket WHERE); omitted, the
   * members are ordered by their own value, which is the only thing a list of
   * text or numbers could mean.
   *
   */
  private parseSortCall(pos: number): Expression {
    const SHAPE =
      'SORT(<collection>), SORT(<collection>, DESC), SORT(<collection>, <key>) or SORT(<collection>, <key>, DESC)';
    this.expect('paren', '(');
    if (this.peek().type === 'paren' && this.peek().value === ')') {
      throw new ParseError(`SORT orders a collection — write ${SHAPE}`, pos);
    }
    const source = this.parseExpr();
    let key: Expression | undefined;
    let direction: 'asc' | 'desc' | undefined;
    while (this.match('comma')) {
      const dir = this.peekTrailingDirection();
      if (dir !== undefined) {
        this.advance();
        direction = dir;
        break;
      }
      if (key !== undefined) {
        throw new ParseError(
          `SORT takes a collection, a key and a direction — write ${SHAPE}`,
          pos,
        );
      }
      key = this.parseExpr();
    }
    if (!(this.peek().type === 'paren' && this.peek().value === ')')) {
      throw new ParseError(
        direction !== undefined
          ? `SORT's direction is the LAST thing in the call — write ${SHAPE}`
          : `SORT takes a collection, a key and a direction — write ${SHAPE}`,
        pos,
      );
    }
    this.expect('paren', ')');
    return {
      type: 'aggregate',
      fn: 'sort',
      expression: source,
      ...(key !== undefined ? { orderBy: key } : {}),
      orderDirection: direction ?? 'asc',
    };
  }

  /** A bare `ASC` / `DESC` filling SORT's LAST slot — the direction, not a
   *  field of that name (which is written `\`ASC\`` and read as a key only
   *  when something follows it). */
  private peekTrailingDirection(): 'asc' | 'desc' | undefined {
    const tok = this.peek();
    if (tok.type !== 'ident') return undefined;
    const upper = tok.value.toUpperCase();
    if (upper !== 'ASC' && upper !== 'DESC') return undefined;
    const after = this.tokens[this.pos + 1];
    if (after === undefined || after.type !== 'paren' || after.value !== ')') return undefined;
    return upper === 'DESC' ? 'desc' : 'asc';
  }

  private parseFunctionCall(
    name: string,
    pos: number,
    options: { scoped?: boolean } = {},
  ): Expression {
    this.expect('paren', '(');
    const args: Expression[] = [];
    if (!(this.peek().type === 'paren' && this.peek().value === ')')) {
      args.push(this.parseExpr());
      while (this.match('comma')) {
        args.push(this.parseExpr());
      }
    }
    this.expect('paren', ')');

    // A call under a dot-chain root (`DATETIME.AT(…)`) is named INSIDE that
    // root, so none of the bare-name specialisations below apply to it — the
    // caller (movement-lang's stdlib bridge) resolves the member against its
    // family and reports an unknown one there.
    if (options.scoped === true) return { type: 'function', fn: name.toLowerCase(), args };

    if (name in AGG_FNS) {
      return {
        type: 'aggregate',
        fn: AGG_FNS[name] as any,
        expression: args[0] ?? { type: 'static', value: '' },
        ...(args[1]?.type === 'static' && typeof args[1].value === 'string' ? { separator: args[1].value } : {}),
      };
    }

    if (name === 'AI') {
      // Optional second argument: the tier — how much thinking the answer is
      // worth. It is READ where the program is saved, never passed on, so it
      // has to be written down; that much is this parser's. WHICH words are
      // tiers is the checker's (it has the vocabulary and the did-you-mean),
      // so an unrecognised one passes through here rather than being dropped.
      let tier: string | undefined;
      if (args.length > 2) {
        throw new ParseError(`AI takes at most 2 arguments (prompt, tier), got ${args.length}`, pos);
      }
      if (args.length === 2) {
        const tierArg = args[1];
        if (tierArg.type !== 'static' || typeof tierArg.value !== 'string') {
          throw new ParseError(
            `AI's second argument is the tier — ${AI_TIERS.map(t => `"${t}"`).join(', ')} — written down in place. A computed one can't be checked when you save.`,
            pos,
          );
        }
        tier = tierArg.value;
      }
      if (args[0]?.type === 'static' && typeof args[0].value === 'string') {
        return { type: 'llm', prompt: args[0].value, ...(tier !== undefined ? { tier } : {}) };
      }
      return {
        type: 'llm',
        prompt: '',
        promptExpression: args[0],
        ...(tier !== undefined ? { tier } : {}),
      };
    }

    if (name === 'CONCAT') {
      return { type: 'concat', parts: args };
    }

    if (name === 'KG_EXISTS' || name === 'KG_VALUE') {
      const queryArg = args[0];
      const query = queryArg && queryArg.type === 'static' && typeof queryArg.value === 'string'
        ? queryArg.value
        : '';
      return {
        type: name === 'KG_EXISTS' ? 'kg_exists' : 'kg_value',
        query,
        params: args.slice(1),
      };
    }

    if (name === 'EXTRACT_VALUE') {
      // EXTRACT_VALUE("description") — sole arg must be a static string.
      // The engine collects every call inside an ancestral `#extract` and
      // batches them into a single LLM request; type / enum options are
      // inferred from the surrounding expression field at execution time.
      // See `plans/2026-05-19-tg-extraction-parity/expression_syntax.md`
      // "EXTRACT_VALUE".
      const arg = args[0];
      if (!arg || arg.type !== 'static' || typeof arg.value !== 'string') {
        throw new ParseError(
          'EXTRACT_VALUE expects a single string literal description',
          pos,
        );
      }
      if (args.length !== 1) {
        throw new ParseError(
          `EXTRACT_VALUE takes exactly 1 argument, got ${args.length}`,
          pos,
        );
      }
      return { type: 'extract_value', description: arg.value };
    }

    // `AT(collection, index)` — the index read. The node, the evaluator and the
    // serializer were all here already; this is the entry point that was
    // missing, so `AT` round-trips through the text form it always printed.
    if (name === 'AT') {
      if (args.length !== 2) {
        throw new ParseError(`AT takes exactly 2 arguments (AT(list, index)), got ${args.length}`, pos);
      }
      return { type: 'at', expression: args[0], index: args[1] };
    }

    // Generic function
    return { type: 'function', fn: name.toLowerCase(), args };
  }

  private parseTraversal(aliasRoot?: string): Expression {
    const steps: TraversalStep[] = [];
    while (this.peek().type === 'traverse') {
      const tok = this.peek();
      const incoming = tok.value.startsWith('<');
      const rawName = incoming ? tok.value.slice(1) : tok.value;

      // Meta-edge: -[#extract { ... }]-> / -[#transform { ... }]-> / -[name:#extract ...]->
      if (rawName === '#extract' || rawName === '#transform') {
        this.advance();
        const metaEdge = rawName === '#extract' ? 'extract' : 'transform';
        const config = tok.configText
          ? parseConfigObject(tok.configText, tok.pos, (text) => this.parseSubExpression(text))
          : undefined;
        const step: MetaEdgeStep = {
          type: 'meta_edge',
          metaEdge,
          ...(tok.alias ? { alias: tok.alias } : {}),
          ...(config ? { config } : {}),
        };
        steps.push(step);
        // Meta-edge step doesn't change schema-typing context; loop on
        // to the next traverse token (chain) or fall through to the
        // terminal `.expression` parse.
        if (this.peek().type === 'traverse') continue;
        break;
      }

      // Resource traversal: -[:_resources]-> or -[:_resources WHERE type = "TEXT"]->
      // (`#resources` accepted as a deprecated alias in bracket position).
      if (isResourceHop(rawName)) {
        this.advance();
        const shorthand = resourceTypeShorthand(rawName);
        const whereExpr = tok.filterText ? parseResourceWhere(tok.filterText) : undefined;
        const expressionFilter: Expression | undefined =
          shorthand && whereExpr
            ? { type: 'logical', op: 'and', operands: [shorthand, whereExpr] }
            : (shorthand ?? whereExpr);
        // Consume . and parse the child expression
        this.expect('op', '.');
        // Accept bare field names (url, name, etc.) as resource fields
        const RESOURCE_FIELDS = new Set(['name', 'url', 'type', 'document_url', 'content']);
        const nextTok = this.peek();
        let expression: Expression;
        if (nextTok.type === 'ident' && RESOURCE_FIELDS.has(nextTok.value)) {
          this.advance();
          expression = { type: 'resource', field: nextTok.value as 'name' | 'url' | 'type' | 'document_url' | 'content' };
        } else {
          expression = this.parsePrimary();
        }
        const innerExpr: Expression = { type: 'resource_traverse', ...(expressionFilter ? { expressionFilter } : {}), expression };
        // Wrap in traverse if we accumulated edge steps before the resource step
        if (steps.length > 0) {
          return { type: 'traverse', steps, expression: innerExpr };
        }
        return innerExpr;
      }

      // Linked object traversal: -[#linked WHERE type = "ATTIO"]->.external_id
      if (rawName === '#linked') {
        this.advance();
        const adapter = parseLinkedFilter(tok.filterText);
        this.expect('op', '.');
        const fieldTok = this.peek();
        if (fieldTok.type !== 'ident' && fieldTok.type !== 'special') {
          throw new ParseError('Expected field name after -[#linked...]->.', fieldTok.pos);
        }
        this.advance();
        const field = fieldTok.type === 'special' ? fieldTok.value : fieldTok.value;
        const innerExpr: Expression = { type: 'linked_object', adapter, field };
        if (steps.length > 0) {
          return { type: 'traverse', steps, expression: innerExpr };
        }
        return innerExpr;
      }

      this.advance();
      let edgeId: string;
      let direction: 'outgoing' | 'incoming';

      // Context-aware resolution: when we know the current node type and have edge
      // metadata, determine direction based on which end of the edge we're on rather
      // than relying on global name matching (which always picks outbound first).
      const contextResolved = this.resolveEdgeFromContext(rawName);
      if (contextResolved) {
        edgeId = contextResolved.id;
        direction = contextResolved.direction;
      } else if (this.resolveEdgeWithDirection) {
        const resolved = this.resolveEdgeWithDirection(rawName);
        edgeId = resolved?.id ?? this.resolveEdge(rawName) ?? rawName;
        // If the arrow syntax says outgoing but the name matched an inbound name, it's actually incoming
        direction = resolved?.direction ?? (incoming ? 'incoming' : 'outgoing');
      } else {
        edgeId = this.resolveEdge(rawName) ?? rawName;
        direction = incoming ? 'incoming' : 'outgoing';
      }
      const step: EdgeStep = {
        type: 'edge',
        edgeTypeId: edgeId,
        direction,
        ...(tok.alias ? { alias: tok.alias } : {}),
      };
      // Bracket ORDER BY / LIMIT → the step's cardinality. The ORDER BY key is
      // an expression over the element the hop lands on, parsed in this
      // parser's own scope: a bare name is a field of the hop TARGET (movement
      // contexts are surface-name-native — identity resolution passes it
      // through), and a path is rooted at the hop's own alias.
      if (tok.orderByText !== undefined || tok.limitCount !== undefined) {
        step.cardinality = {
          mode: tok.limitCount !== undefined ? 'n' : 'all',
          ...(tok.limitCount !== undefined ? { limit: tok.limitCount } : {}),
          ...(tok.orderByText !== undefined
            ? {
                orderBy: this.parseSubExpression(tok.orderByText),
                orderDirection: tok.orderDirection ?? 'asc',
              }
            : {}),
        };
      }
      // Parse optional WHERE clause from the token's filterText
      if (tok.filterText) {
        const filterTokens = tokenize(tok.filterText);
        // In the WHERE context, property names resolve against edge properties
        const filterParser = new Parser(
          filterTokens,
          this.resolveEdgeProperty, // edge properties as the primary resolver
          this.resolveEdgeProperty,
          this.resolveEdge,
          true, // edgePropertyMode — produce edge_property AST nodes
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          this.tgMode,
        );
        step.expressionFilter = filterParser.parse();
      }
      // Advance current node type for context-aware resolution of subsequent steps
      if (this.allEdges) {
        const edge = this.allEdges.find(e => e.id === step.edgeTypeId);
        if (edge) {
          this.currentNodeTypeId = step.direction === 'outgoing' ? edge.targetNodeTypeId : edge.sourceNodeTypeId;
        } else {
          this.currentNodeTypeId = undefined;
        }
      }
      steps.push(step);
    }
    // Scope property resolution to the target node type after traversal
    const origResolver = this.resolveProperty;
    if (this.allProperties && this.currentNodeTypeId) {
      const scopedProps = propsForNodeType(this.allProperties, this.currentNodeTypeId);
      const scopedMap = new Map(scopedProps.map(p => [p.name.toLowerCase(), p.id]));
      this.resolveProperty = (name: string) => scopedMap.get(name.toLowerCase()) ?? origResolver(name);
    }
    // Expect . then the expression to evaluate at the end of the traversal
    this.expect('op', '.');
    const expression = this.parsePrimary();
    this.resolveProperty = origResolver;
    return {
      type: 'traverse',
      ...(aliasRoot ? { aliasRoot } : {}),
      steps,
      expression,
    };
  }

  private parseIf(): Expression {
    this.expect('keyword', 'IF');
    const condition = this.parseExpr();
    this.expect('keyword', 'THEN');
    const thenExpr = this.parseExpr();

    // ELSE IF chain or ELSE ... END
    if (this.match('keyword', 'ELSE')) {
      if (this.peek().type === 'keyword' && this.peek().value === 'IF') {
        // ELSE IF — recursively parse as a nested conditional. The nested IF
        // consumes its own closing END, so the chain form (`… ELSE IF … END`,
        // one END for the whole thing) parses with no END here. An author who
        // instead nests explicitly and closes each IF (`… ELSE IF … END END`)
        // is honored too: consume the matching outer END when it is present.
        const elseExpr = this.parseIf();
        this.match('keyword', 'END');
        return { type: 'conditional', condition, then: thenExpr, else: elseExpr };
      }
      const elseExpr = this.parseExpr();
      this.expect('keyword', 'END');
      return { type: 'conditional', condition, then: thenExpr, else: elseExpr };
    }

    // No ELSE — default to empty string
    this.expect('keyword', 'END');
    return { type: 'conditional', condition, then: thenExpr, else: { type: 'static', value: '' } };
  }
}

export function parse(
  input: string,
  resolveProperty: (name: string) => string | undefined,
  resolveEdgeProperty?: (name: string) => string | undefined,
  resolveEdge?: (name: string) => string | undefined,
  resolveStaticValueId?: (name: string) => string | undefined,
  resolveEdgeWithDirection?: (name: string) => { id: string; direction: 'outgoing' | 'incoming' } | undefined,
  allProperties?: PropertyInfo[],
  allEdges?: EdgeInfo[],
  startNodeTypeId?: string,
  tgMode?: boolean,
): Expression {
  const tokens = tokenize(input);
  const parser = new Parser(tokens, resolveProperty, resolveEdgeProperty ?? (() => undefined), resolveEdge, undefined, resolveStaticValueId, resolveEdgeWithDirection, allProperties, allEdges, startNodeTypeId, tgMode);
  return parser.parse();
}

// ── Validation ──

export interface ValidationResult {
  valid: boolean;
  error?: string;
  errorPos?: number;
  expression?: Expression;
}

// ── Function arity & argument type definitions ──

interface FunctionSpec {
  minArgs: number;
  maxArgs: number; // Infinity for variable arity
  argTypes?: ('any' | 'string' | 'number' | 'boolean')[]; // per-position type constraints (optional positions use last type)
}

const FUNCTION_SPECS: Record<string, FunctionSpec> = {
  isnull:   { minArgs: 1, maxArgs: 1 },
  coalesce: { minArgs: 2, maxArgs: Infinity },
  trim:     { minArgs: 1, maxArgs: 1, argTypes: ['string'] },
  lower:    { minArgs: 1, maxArgs: 1, argTypes: ['string'] },
  upper:    { minArgs: 1, maxArgs: 1, argTypes: ['string'] },
  // WITHIN(<date field>, "<interval>") — first arg must be a date field
  // (validated structurally below; deep type-checking happens at the
  // constraint-author boundary), second arg is a Postgres-style interval
  // string like "6 months".
  within:   { minArgs: 2, maxArgs: 2 },
  length:   { minArgs: 1, maxArgs: 1, argTypes: ['string'] },
  abs:      { minArgs: 1, maxArgs: 1, argTypes: ['number'] },
  round:    { minArgs: 1, maxArgs: 1, argTypes: ['number'] },
  floor:    { minArgs: 1, maxArgs: 1, argTypes: ['number'] },
  ceil:     { minArgs: 1, maxArgs: 1, argTypes: ['number'] },
  tostring: { minArgs: 1, maxArgs: 1 },
  tonumber: { minArgs: 1, maxArgs: 1 },
  // Coercers — DATE/DATETIME normalise any readable date/timestamp (a
  // calendar day / a full instant); NUMBER parses a number. One argument.
  date:     { minArgs: 1, maxArgs: 1 },
  datetime: { minArgs: 1, maxArgs: 1 },
  number:   { minArgs: 1, maxArgs: 1 },
  multi:    { minArgs: 1, maxArgs: Infinity },
  split:    { minArgs: 1, maxArgs: 2, argTypes: ['string'] },
};

const AGGREGATE_SPECS: Record<string, FunctionSpec> = {
  first:   { minArgs: 1, maxArgs: 1 },
  last:    { minArgs: 1, maxArgs: 1 },
  only:    { minArgs: 1, maxArgs: 1 },
  count:   { minArgs: 1, maxArgs: 1 },
  sum:     { minArgs: 1, maxArgs: 1, argTypes: ['number'] },
  avg:     { minArgs: 1, maxArgs: 1, argTypes: ['number'] },
  min:     { minArgs: 1, maxArgs: 1 },
  max:     { minArgs: 1, maxArgs: 1 },
  join:    { minArgs: 1, maxArgs: 2 },
  collect: { minArgs: 1, maxArgs: 1 },
  llm:     { minArgs: 1, maxArgs: 2 },
};

function validateExpressionTree(expr: Expression, ctx: PropertyContext): string | null {
  switch (expr.type) {
    case 'function': {
      const spec = FUNCTION_SPECS[expr.fn];
      if (spec) {
        if (expr.args.length < spec.minArgs) {
          return `${expr.fn.toUpperCase()} requires at least ${spec.minArgs} argument${spec.minArgs > 1 ? 's' : ''}, got ${expr.args.length}`;
        }
        if (expr.args.length > spec.maxArgs) {
          return `${expr.fn.toUpperCase()} takes at most ${spec.maxArgs} argument${spec.maxArgs > 1 ? 's' : ''}, got ${expr.args.length}`;
        }
        if (spec.argTypes) {
          for (let i = 0; i < expr.args.length; i++) {
            const expectedType = spec.argTypes[Math.min(i, spec.argTypes.length - 1)];
            if (expectedType && expectedType !== 'any') {
              const argType = inferType(expr.args[i], ctx);
              if (argType.kind !== 'unknown' && argType.kind !== 'null' && argType.kind !== expectedType
                  && !(expectedType === 'string' && argType.kind === 'literal')) {
                return `${expr.fn.toUpperCase()} argument ${i + 1} expects ${expectedType}, got ${argType.kind}`;
              }
            }
          }
        }
      }
      for (const arg of expr.args) {
        const err = validateExpressionTree(arg, ctx);
        if (err) return err;
      }
      return null;
    }
    case 'aggregate': {
      const spec = AGGREGATE_SPECS[expr.fn];
      if (spec) {
        // Aggregate args are split: expression is the first arg, separator/prompt are extra
        const argCount = 1 + (expr.separator !== undefined ? 1 : 0) + (expr.prompt !== undefined ? 1 : 0);
        if (argCount > spec.maxArgs) {
          return `${(AGG_NAMES[expr.fn] ?? expr.fn).toUpperCase()} takes at most ${spec.maxArgs} argument${spec.maxArgs > 1 ? 's' : ''}, got ${argCount}`;
        }
        if (spec.argTypes) {
          const argType = inferType(expr.expression, ctx);
          const expectedType = spec.argTypes[0];
          if (expectedType && expectedType !== 'any' && argType.kind !== 'unknown' && argType.kind !== 'null'
              && argType.kind !== expectedType && !(expectedType === 'string' && argType.kind === 'literal')) {
            return `${(AGG_NAMES[expr.fn] ?? expr.fn).toUpperCase()} expects ${expectedType} argument, got ${argType.kind}`;
          }
        }
      }
      return validateExpressionTree(expr.expression, ctx);
    }
    case 'concat': {
      if (expr.parts.length < 1) {
        return 'CONCAT requires at least 1 argument';
      }
      for (const part of expr.parts) {
        const err = validateExpressionTree(part, ctx);
        if (err) return err;
      }
      return null;
    }
    case 'conditional': {
      const condType = inferType(expr.condition, ctx);
      if (condType.kind !== 'unknown' && condType.kind !== 'boolean') {
        return `IF condition should be boolean, got ${condType.kind}`;
      }
      return validateExpressionTree(expr.condition, ctx)
        ?? validateExpressionTree(expr.then, ctx)
        ?? validateExpressionTree(expr.else, ctx);
    }
    case 'traverse':
      return validateExpressionTree(expr.expression, ctx);
    case 'resource_traverse':
      return (expr.expressionFilter ? validateExpressionTree(expr.expressionFilter, ctx) : undefined)
        ?? validateExpressionTree(expr.expression, ctx);
    case 'arithmetic':
      return validateExpressionTree(expr.left, ctx) ?? validateExpressionTree(expr.right, ctx);
    case 'compare':
      return validateExpressionTree(expr.left, ctx) ?? validateExpressionTree(expr.right, ctx);
    case 'logical':
      for (const op of expr.operands) {
        const err = validateExpressionTree(op, ctx);
        if (err) return err;
      }
      return null;
    case 'not':
      return validateExpressionTree(expr.expression, ctx);
    case 'negate':
      return validateExpressionTree(expr.expression, ctx);
    case 'llm':
      return expr.promptExpression ? validateExpressionTree(expr.promptExpression, ctx) : null;
    case 'list':
      for (const e of expr.elements) {
        const err = validateExpressionTree(listElementExpression(e), ctx);
        if (err) return err;
      }
      return null;
    case 'object':
      for (const entry of expr.entries) {
        const err = validateExpressionTree(objectMemberExpression(entry), ctx);
        if (err) return err;
      }
      return null;
    default:
      return null;
  }
}

export function validate(
  input: string,
  resolveProperty: (name: string) => string | undefined,
  resolveEdgeProperty?: (name: string) => string | undefined,
  resolveEdge?: (name: string) => string | undefined,
  resolveStaticValueId?: (name: string) => string | undefined,
  resolveEdgeWithDirection?: (name: string) => { id: string; direction: 'outgoing' | 'incoming' } | undefined,
  propertyContext?: PropertyContext,
  allProperties?: PropertyInfo[],
  allEdges?: EdgeInfo[],
  startNodeTypeId?: string,
  tgMode?: boolean,
): ValidationResult {
  if (!input.trim()) return { valid: true };
  try {
    const expression = parse(input, resolveProperty, resolveEdgeProperty, resolveEdge, resolveStaticValueId, resolveEdgeWithDirection, allProperties, allEdges, startNodeTypeId, tgMode);
    if (propertyContext) {
      const arityError = validateExpressionTree(expression, propertyContext);
      if (arityError) {
        return { valid: false, error: arityError };
      }
    }
    return { valid: true, expression };
  } catch (e) {
    if (e instanceof ParseError) {
      return { valid: false, error: e.message, errorPos: e.pos };
    }
    return { valid: false, error: String(e) };
  }
}

// ── TG-parity validation ──

export interface ValidationError {
  message: string;
  /** Optional source position (when tied to a specific node). */
  pos?: number;
}

/**
 * Validate TG-extraction-parity invariants on a parsed Expression.
 * Returns an array of structural errors (independent of the property-
 * context-driven arity / type checks in `validate`).
 *
 * Rules enforced:
 *  - `EXTRACT_VALUE(...)` is only valid inside an ancestral `#extract`
 *    meta-edge step. A bare-top-level call is an error.
 *  - Traversals reject incoming arrows (`<-[:...]-`). The cypher-parity
 *    syntax is outbound-only.
 *  - Named-ancestor references (`alias_ref { name }` and
 *    `traverse { aliasRoot: name, ... }`) require that `name` be
 *    bound by an enclosing `EdgeStep.alias` / `MetaEdgeStep.alias` /
 *    `traverse.aliasRoot` further up the path, OR by the supplied
 *    `triggerAliases` set.
 *
 * See `plans/2026-05-19-tg-extraction-parity/expression_syntax.md`.
 */
export function validateTgExpression(
  expr: Expression,
  options?: {
    /** Root-level alias bindings (typically `["msg"]` for
     *  `trigger: slack_message AS msg`). Empty by default. */
    triggerAliases?: readonly string[];
    /** When true, EXTRACT_VALUE is treated as legal at the top level
     *  because the expression is being evaluated INSIDE an ancestral
     *  `#extract` context that isn't part of this expression tree. Used
     *  by the TG validator when checking field-mapping expressions whose
     *  `#extract` lives on the action's source traversal (not on the
     *  expression itself). */
    ancestralInsideExtract?: boolean;
  },
): ValidationError[] {
  const errors: ValidationError[] = [];
  const initialAliases = new Set<string>(options?.triggerAliases ?? []);
  walkTgExpression(
    expr,
    {
      aliases: initialAliases,
      insideExtract: options?.ancestralInsideExtract ?? false,
    },
    errors,
  );
  return errors;
}

interface TgWalkCtx {
  aliases: Set<string>;
  insideExtract: boolean;
}

function withAlias(ctx: TgWalkCtx, name: string | undefined): TgWalkCtx {
  if (!name) return ctx;
  const next = new Set(ctx.aliases);
  next.add(name);
  return { ...ctx, aliases: next };
}

function walkTgExpression(
  expr: Expression,
  ctx: TgWalkCtx,
  errors: ValidationError[],
): void {
  switch (expr.type) {
    case 'extract_value':
      if (!ctx.insideExtract) {
        errors.push({
          message: `EXTRACT_VALUE("${expr.description}") used outside an ancestral #extract — only valid inside an action source whose chain includes a -[:#extract { ... }]-> step.`,
        });
      }
      return;
    case 'alias_ref':
      if (!ctx.aliases.has(expr.name)) {
        errors.push({
          message: `Reference to undefined alias "${expr.name}". Bind it with -[${expr.name}:Edge]-> or a trigger AS clause.`,
        });
      }
      return;
    case 'traverse': {
      let walkCtx = ctx;
      if (expr.aliasRoot && !ctx.aliases.has(expr.aliasRoot)) {
        errors.push({
          message: `Alias-rooted traversal references undefined alias "${expr.aliasRoot}".`,
        });
      }
      for (const step of expr.steps) {
        if (step.type === 'edge') {
          if (step.direction === 'incoming') {
            errors.push({
              message: `Incoming traversal (<-[:...]-) is not allowed in TG expressions — use the inbound name with outbound arrow.`,
            });
          }
          if (step.alias) walkCtx = withAlias(walkCtx, step.alias);
          if (step.expressionFilter) {
            walkTgExpression(step.expressionFilter, walkCtx, errors);
          }
        } else if (step.type === 'meta_edge') {
          if (step.alias) walkCtx = withAlias(walkCtx, step.alias);
          if (step.metaEdge === 'extract') {
            walkCtx = { ...walkCtx, insideExtract: true };
          }
          if (step.config?.description) {
            walkTgExpression(step.config.description, walkCtx, errors);
          }
          if (step.config?.data) {
            for (const d of step.config.data) walkTgExpression(d, walkCtx, errors);
          }
          if (step.config?.plugin) {
            walkTgExpression(step.config.plugin, walkCtx, errors);
          }
          if (step.config?.enrichWith) {
            for (const entry of step.config.enrichWith) {
              walkTgExpression(entry.transform, walkCtx, errors);
              // `argument` evaluates per-emission against the entity
              // about to be extracted — under the enclosing `#extract`'s
              // alias. Walk with `insideExtract: true` so references
              // line up with the lexical scope.
              walkTgExpression(entry.argument, walkCtx, errors);
            }
          }
          if (step.config?.extra) {
            for (const v of Object.values(step.config.extra)) {
              walkTgExpression(v, walkCtx, errors);
            }
          }
          if (step.expressionFilter) {
            walkTgExpression(step.expressionFilter, walkCtx, errors);
          }
        }
      }
      walkTgExpression(expr.expression, walkCtx, errors);
      return;
    }
    case 'resource_traverse':
      if (expr.expressionFilter) walkTgExpression(expr.expressionFilter, ctx, errors);
      walkTgExpression(expr.expression, ctx, errors);
      return;
    case 'arithmetic':
    case 'compare':
      walkTgExpression(expr.left, ctx, errors);
      walkTgExpression(expr.right, ctx, errors);
      return;
    case 'logical':
      for (const op of expr.operands) walkTgExpression(op, ctx, errors);
      return;
    case 'not':
    case 'negate':
    case 'aggregate':
      walkTgExpression(expr.expression, ctx, errors);
      return;
    case 'concat':
      for (const p of expr.parts) walkTgExpression(p, ctx, errors);
      return;
    case 'conditional':
      walkTgExpression(expr.condition, ctx, errors);
      walkTgExpression(expr.then, ctx, errors);
      walkTgExpression(expr.else, ctx, errors);
      return;
    case 'function':
      for (const a of expr.args) walkTgExpression(a, ctx, errors);
      return;
    case 'list':
      for (const e of expr.elements) walkTgExpression(listElementExpression(e), ctx, errors);
      return;
    case 'object':
      for (const entry of expr.entries) walkTgExpression(objectMemberExpression(entry), ctx, errors);
      return;
    case 'llm':
      if (expr.promptExpression) walkTgExpression(expr.promptExpression, ctx, errors);
      return;
    case 'at':
      walkTgExpression(expr.expression, ctx, errors);
      walkTgExpression(expr.index, ctx, errors);
      return;
    case 'kg_exists':
    case 'kg_value':
      for (const p of expr.params) walkTgExpression(p, ctx, errors);
      return;
    case 'exists':
      for (const step of expr.steps) {
        if (step.type === 'edge' && step.direction === 'incoming') {
          errors.push({
            message: `Incoming traversal (<-[:...]-) is not allowed in TG expressions.`,
          });
        }
      }
      if (expr.where) walkTgExpression(expr.where, ctx, errors);
      return;
    case 'property':
    case 'edge_property':
    case 'static':
    case 'meta':
    case 'parent_result':
    case 'action_result':
    case 'resource':
    case 'linked_object':
      return;
  }
}

// ── Context-aware completions ──

export type CompletionKind = 'value' | 'option' | 'operator' | 'keyword' | 'function' | 'edge' | 'special';

export interface Completion {
  label: string;
  insert: string;
  kind: CompletionKind;
}

const FUNCTION_COMPLETIONS: Completion[] = [
  { label: 'IF', insert: 'IF', kind: 'keyword' },
  { label: 'NOT', insert: 'NOT', kind: 'keyword' },
  { label: 'CONCAT()', insert: 'CONCAT(', kind: 'function' },
  { label: 'COALESCE()', insert: 'COALESCE(', kind: 'function' },
  { label: 'AI()', insert: 'AI(', kind: 'function' },
  { label: 'FIRST()', insert: 'FIRST(', kind: 'function' },
  { label: 'LAST()', insert: 'LAST(', kind: 'function' },
  { label: 'COUNT()', insert: 'COUNT(', kind: 'function' },
  { label: 'SUM()', insert: 'SUM(', kind: 'function' },
  { label: 'AVG()', insert: 'AVG(', kind: 'function' },
  { label: 'MIN()', insert: 'MIN(', kind: 'function' },
  { label: 'MAX()', insert: 'MAX(', kind: 'function' },
  { label: 'JOIN()', insert: 'JOIN(', kind: 'function' },
  { label: 'ONLY()', insert: 'ONLY(', kind: 'function' },
  { label: 'MULTI()', insert: 'MULTI(', kind: 'function' },
  { label: 'SPLIT()', insert: 'SPLIT(', kind: 'function' },
  { label: 'KG_EXISTS()', insert: 'KG_EXISTS(', kind: 'function' },
  { label: 'KG_VALUE()', insert: 'KG_VALUE(', kind: 'function' },
  // WITHIN(<date field>, "<interval>") — temporal scope predicate, used
  // in uniqueness constraints to express recency windows. Gated to
  // contexts with a date field (see `getCompletions`).
  { label: 'WITHIN()', insert: 'WITHIN(', kind: 'function' },
];

const SPECIAL_COMPLETIONS: Completion[] = [
  { label: '@id', insert: '@id', kind: 'special' },
  { label: '@user_name', insert: '@user_name', kind: 'special' },
  { label: '@user_email', insert: '@user_email', kind: 'special' },
  { label: '@current_date', insert: '@current_date', kind: 'special' },
  { label: '@input_channel_name', insert: '@input_channel_name', kind: 'special' },
  { label: '@parent.created', insert: '@parent.created', kind: 'special' },
  { label: '@parent.external_id', insert: '@parent.external_id', kind: 'special' },
];

// Operators grouped by what types they're valid for
const TEXT_OPS: Completion[] = [
  { label: '=', insert: '=', kind: 'operator' },
  { label: '!=', insert: '!=', kind: 'operator' },
  { label: 'contains', insert: 'contains', kind: 'operator' },
  { label: 'in', insert: 'in', kind: 'operator' },
];
const NUMERIC_OPS: Completion[] = [
  { label: '=', insert: '=', kind: 'operator' },
  { label: '!=', insert: '!=', kind: 'operator' },
  { label: '>', insert: '>', kind: 'operator' },
  { label: '>=', insert: '>=', kind: 'operator' },
  { label: '<', insert: '<', kind: 'operator' },
  { label: '<=', insert: '<=', kind: 'operator' },
  { label: '+', insert: '+', kind: 'operator' },
  { label: '-', insert: '-', kind: 'operator' },
  { label: '*', insert: '*', kind: 'operator' },
  { label: '/', insert: '/', kind: 'operator' },
  { label: '%', insert: '%', kind: 'operator' },
];
const BOOLEAN_OPS: Completion[] = [
  { label: '=', insert: '=', kind: 'operator' },
  { label: '!=', insert: '!=', kind: 'operator' },
];
const ALL_OPS: Completion[] = [
  { label: '=', insert: '=', kind: 'operator' },
  { label: '!=', insert: '!=', kind: 'operator' },
  { label: '>', insert: '>', kind: 'operator' },
  { label: '>=', insert: '>=', kind: 'operator' },
  { label: '<', insert: '<', kind: 'operator' },
  { label: '<=', insert: '<=', kind: 'operator' },
  { label: 'contains', insert: 'contains', kind: 'operator' },
  { label: 'exists', insert: 'exists', kind: 'operator' },
  { label: 'in', insert: 'in', kind: 'operator' },
  { label: '+', insert: '+', kind: 'operator' },
  { label: '-', insert: '-', kind: 'operator' },
  { label: '*', insert: '*', kind: 'operator' },
  { label: '/', insert: '/', kind: 'operator' },
  { label: '%', insert: '%', kind: 'operator' },
];
const LOGICAL_OPS: Completion[] = [
  { label: 'AND', insert: 'AND', kind: 'keyword' },
  { label: 'OR', insert: 'OR', kind: 'keyword' },
];

const IF_BRANCH_COMPLETIONS: Completion[] = [
  { label: 'ELSE', insert: 'ELSE', kind: 'keyword' },
  { label: 'ELSE IF', insert: 'ELSE IF', kind: 'keyword' },
  { label: 'END', insert: 'END', kind: 'keyword' },
];

function opsForValueType(valueType?: string): Completion[] {
  if (!valueType) return ALL_OPS;
  switch (valueType) {
    case 'text': case 'enum': return TEXT_OPS;
    case 'number': case 'integer': case 'float': case 'currency': return NUMERIC_OPS;
    case 'boolean': return BOOLEAN_OPS;
    case 'date': case 'datetime': return NUMERIC_OPS; // dates compare with >, <, =
    default: return ALL_OPS;
  }
}

/** Check if cursor is inside an unclosed string literal */
function isInsideString(text: string, cursorPos: number): { quote: string; start: number } | null {
  let inString = false;
  let quote = '';
  let start = 0;
  for (let i = 0; i < cursorPos && i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; } // skip escaped char
      if (ch === quote) { inString = false; }
    } else {
      if (ch === '"' || ch === "'") { inString = true; quote = ch; start = i; }
    }
  }
  return inString ? { quote, start } : null;
}

/**
 * Detect if the cursor is inside an unclosed traversal bracket.
 * Returns the WHERE clause text before cursor and the edge name if found.
 * e.g. for `-[:Invested In WHERE Wei|` → { edgeName: 'Invested In', whereText: 'Wei', incoming: false }
 * Also handles special brackets: `-[#linked WHERE |` and `-[#resources WHERE |`
 */
function insideTraversalWhere(text: string): { edgeName: string; whereText: string; incoming: boolean; needsWhere?: boolean } | null {
  // Find the last unclosed -[: or -[# or <-[: pattern
  let lastBracketOpen = -1;
  let incoming = false;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ']') return null; // bracket was closed before cursor
    if (text[i] === '[' && i > 0 && text[i - 1] === '-') {
      if (i >= 2 && text[i - 2] === '<') {
        lastBracketOpen = i;
        incoming = true;
      } else {
        lastBracketOpen = i;
        incoming = false;
      }
      break;
    }
  }
  if (lastBracketOpen === -1) return null;

  const inside = text.slice(lastBracketOpen + 1); // content after [
  let afterPrefix: string;
  if (inside.startsWith(':')) {
    afterPrefix = inside.slice(1);
  } else if (inside.startsWith('#')) {
    afterPrefix = inside;
  } else {
    return null;
  }

  // Check for WHERE
  const whereMatch = afterPrefix.match(/^(.+?)\s+WHERE\s+(.*)/i);
  if (whereMatch) {
    let edgeName = whereMatch[1].trim();
    if (edgeName.startsWith('`') && edgeName.endsWith('`')) {
      edgeName = edgeName.slice(1, -1);
    }
    return { edgeName, whereText: whereMatch[2], incoming };
  }

  // Inside a special bracket after the name but before WHERE (e.g. `-[#linked |`)
  if (inside.startsWith('#')) {
    const nameMatch = afterPrefix.match(/^(#\w+)\s+(.*)/);
    if (nameMatch) {
      // Check if the text after the name starts with partial/full WHERE or is empty
      const rest = nameMatch[2];
      const hasWhere = /^WHERE\s/i.test(rest);
      if (hasWhere) {
        // Already typed WHERE, skip to the clause
        const whereContent = rest.replace(/^WHERE\s+/i, '');
        return { edgeName: nameMatch[1], whereText: whereContent, incoming };
      }
      return { edgeName: nameMatch[1], whereText: rest, incoming, needsWhere: true };
    }
  }

  return null;
}

/**
 * Walk traverse tokens to determine the node type at the cursor — and
 * the last edge type stepped through within the current scope, used to
 * scope `edge.X` completions to the just-walked edge's properties.
 *
 * Tracks paren nesting so that commas and operators reset context to the
 * enclosing scope — a traversal only shifts context within its sub-expression,
 * not across sibling arguments or subsequent binary operations. `lastEdgeId`
 * follows the same scoping discipline: leaving a traversal sub-expression
 * (via comma, op, paren, AND/OR/…) clears it.
 */
function resolveTraversalContext(
  toks: Token[],
  startNodeTypeId: string | undefined,
  allEdges: EdgeInfo[],
): { nodeTypeId: string | undefined; lastEdgeId: string | undefined } {
  type Frame = { node: string | undefined; edge: string | undefined };
  let nodeTypeId = startNodeTypeId;
  let lastEdgeId: string | undefined;
  const parenStack: Frame[] = [];

  function scopeContext(): Frame {
    return parenStack.length > 0
      ? parenStack[parenStack.length - 1]
      : { node: startNodeTypeId, edge: undefined };
  }

  for (const t of toks) {
    if (t.type === 'paren' && t.value === '(') {
      parenStack.push({ node: nodeTypeId, edge: lastEdgeId });
    } else if (t.type === 'paren' && t.value === ')') {
      const pop = parenStack.length > 0
        ? parenStack.pop()!
        : { node: startNodeTypeId, edge: undefined };
      nodeTypeId = pop.node;
      lastEdgeId = pop.edge;
    } else if (t.type === 'comma') {
      const s = scopeContext();
      nodeTypeId = s.node;
      lastEdgeId = s.edge;
    } else if (t.type === 'op' && t.value !== '.') {
      const s = scopeContext();
      nodeTypeId = s.node;
      lastEdgeId = s.edge;
    } else if (t.type === 'keyword' && (t.value === 'AND' || t.value === 'OR' || t.value === 'THEN' || t.value === 'ELSE')) {
      const s = scopeContext();
      nodeTypeId = s.node;
      lastEdgeId = s.edge;
    } else if (t.type === 'traverse') {
      if (!nodeTypeId) continue;
      const incoming = t.value.startsWith('<');
      const edgeName = incoming ? t.value.slice(1) : t.value;
      const lower = edgeName.toLowerCase();
      const outMatch = allEdges.find(e => e.outboundName.toLowerCase() === lower);
      if (outMatch) {
        nodeTypeId = outMatch.targetNodeTypeId;
        lastEdgeId = outMatch.id;
        continue;
      }
      const inMatch = allEdges.find(e => e.inboundName.toLowerCase() === lower);
      if (inMatch) {
        nodeTypeId = inMatch.sourceNodeTypeId;
        lastEdgeId = inMatch.id;
        continue;
      }
      nodeTypeId = undefined;
      lastEdgeId = undefined;
    }
  }
  return { nodeTypeId, lastEdgeId };
}

function propsForNodeType(allProperties: PropertyInfo[], nodeTypeId: string | undefined): PropertyInfo[] {
  if (!nodeTypeId) return allProperties;
  return allProperties.filter(p => !p.nodeTypeId || p.nodeTypeId === nodeTypeId);
}

function edgesForNodeType(allEdges: EdgeInfo[], nodeTypeId: string | undefined): EdgeInfo[] {
  if (!nodeTypeId) return allEdges;
  return allEdges.filter(e =>
    e.sourceNodeTypeId === nodeTypeId || e.targetNodeTypeId === nodeTypeId,
  );
}

const RESOURCE_FIELD_COMPLETIONS: Completion[] = [
  { label: 'content', insert: '.content', kind: 'value' },
  { label: 'name', insert: '.name', kind: 'value' },
  { label: 'url', insert: '.url', kind: 'value' },
  { label: 'type', insert: '.type', kind: 'value' },
  { label: 'document_url', insert: '.document_url', kind: 'value' },
];

const SPECIAL_TRAVERSE_COMPLETIONS: Completion[] = [
  { label: '-[:_resources]->', insert: '-[:_resources]->', kind: 'edge' },
  { label: '-[#linked]->', insert: '-[#linked]->', kind: 'edge' },
];

const LINKED_FIELD_COMPLETIONS: Completion[] = [
  { label: 'external_id', insert: '.external_id', kind: 'value' },
  { label: 'url', insert: '.url', kind: 'value' },
  { label: 'name', insert: '.name', kind: 'value' },
  { label: 'external_object_type', insert: '.external_object_type', kind: 'value' },
];

// Properties available inside WHERE for special traversal brackets
const LINKED_WHERE_PROPERTIES: PropertyInfo[] = [
  { id: 'type', name: 'type', valueType: 'text' },
];
const RESOURCE_WHERE_PROPERTIES: PropertyInfo[] = [
  { id: 'type', name: 'type', valueType: 'text' },
  { id: 'hasDocument', name: 'hasDocument', valueType: 'boolean' },
  { id: 'mimeType', name: 'mimeType', valueType: 'text' },
  { id: 'namePattern', name: 'namePattern', valueType: 'text' },
];

function edgeCompletionsFor(
  edges: EdgeInfo[],
  nodeTypeId: string | undefined,
  capabilities: FormulaCapabilities = DEFAULT_CAPABILITIES,
): Completion[] {
  const results = edges.flatMap(e => {
    const items: Completion[] = [];
    // Outgoing from this node type: show outbound name
    if (!nodeTypeId || e.sourceNodeTypeId === nodeTypeId) {
      const outName = needsQuote(e.outboundName) ? '`' + e.outboundName + '`' : e.outboundName;
      items.push({ label: `-[:${e.outboundName}]->`, insert: `-[:${outName}]->`, kind: 'edge' });
    }
    // Incoming to this node type: display as outgoing with inbound name.
    // Gated on incomingEdges capability — external adapters typically can't
    // walk a reference in reverse (their references are unidirectional).
    if (capabilities.incomingEdges && (!nodeTypeId || e.targetNodeTypeId === nodeTypeId)) {
      const inName = needsQuote(e.inboundName) ? '`' + e.inboundName + '`' : e.inboundName;
      items.push({ label: `-[:${e.inboundName}]->`, insert: `-[:${inName}]->`, kind: 'edge' });
    }
    return items;
  });
  const special: Completion[] = [];
  if (capabilities.resources) special.push(SPECIAL_TRAVERSE_COMPLETIONS[0]); // -[#resources]->
  if (capabilities.linkedObjects) special.push(SPECIAL_TRAVERSE_COMPLETIONS[1]); // -[#linked]->
  return [...results, ...special];
}

/**
 * TG-mode completion options. When `tgMode` is on, the completion engine
 * surfaces additional tokens that only make sense in a translation-graph
 * authoring context:
 *
 *  - `triggerAliases` are the bare-name handles bound further up the
 *    action subtree (and at the trigger root, e.g. `msg` for
 *    `trigger: slack_message AS msg`). They appear as value-position
 *    completions; descendants reference them by bare name.
 *  - `insideExtract`: when the current authoring position is descended
 *    from an ancestral `#extract` meta-edge, `EXTRACT_VALUE()` is offered
 *    as a function completion. Outside an `#extract`, the call would
 *    fail TG validation, so we hide it from the dropdown.
 *  - Cypher-syntax hint completions are always-on under tgMode, since
 *    those are TG-only grammar.
 *
 * See `plans/2026-05-19-tg-extraction-parity/expression_syntax.md`.
 */
/**
 * An adapter-provided field function offered on the field currently being
 * mapped (e.g. Slack's `SLACK_MESSAGE`). Surfaced in the completion dropdown
 * and the argument-hint tooltip ONLY for that field — discoverability is
 * field-scoped (P4). Mirrors the api-side `FieldFunctionDescriptor` but kept
 * structural here so the shared package doesn't depend on api types.
 *
 */
export interface FieldFunctionInfo {
  name: string;
  summary?: string;
  params?: readonly { name: string; doc?: string; variadic?: boolean }[];
}

export interface TgCompletionOptions {
  /** Aliases visible at the current authoring position (ancestor + trigger). */
  triggerAliases?: readonly string[];
  /** Whether the current authoring position is inside an `#extract`
   *  ancestor — gates the EXTRACT_VALUE() completion. */
  insideExtract?: boolean;
  /** Functions the target field being mapped advertises — added to the
   *  function completions for this field only. */
  fieldFunctions?: readonly FieldFunctionInfo[];
}

const EXTRACT_VALUE_COMPLETION: Completion = {
  label: 'EXTRACT_VALUE()',
  insert: 'EXTRACT_VALUE(',
  kind: 'function',
};

// Cypher-syntax templates surfaced after a `-` trailing in TG mode, so
// authors discover the bracket-binding and meta-edge config-object
// grammar without having to remember the punctuation.
const CYPHER_SYNTAX_COMPLETIONS: Completion[] = [
  { label: '-[name:Edge]->', insert: '-[', kind: 'edge' },
  { label: '-[#extract { description: "…", data: [...] }]->', insert: '-[#extract { description: "', kind: 'edge' },
  { label: '-[#transform { plugin: "…" }]->', insert: '-[#transform { plugin: "', kind: 'edge' },
];

// Inside a meta-edge bracket (after `-[#extract` / `-[#transform`), the
// allowed config keys are deterministic — surface them so authors don't
// have to recall the schema. Keyed by metaEdge kind.
const META_EDGE_CONFIG_KEYS: Record<string, Completion[]> = {
  '#extract': [
    { label: 'description:', insert: 'description: "', kind: 'keyword' },
    { label: 'data:', insert: 'data: [', kind: 'keyword' },
  ],
  '#transform': [
    { label: 'plugin:', insert: 'plugin: "', kind: 'keyword' },
    { label: 'config:', insert: 'config: { ', kind: 'keyword' },
  ],
};

/** Detect if the cursor sits inside an open `-[#extract` / `-[#transform`
 *  bracket but BEFORE the closing `]`. Used in TG-mode autocomplete to
 *  surface config-object key hints. Returns the meta-edge kind, the raw
 *  inside text, and whether a `{` has already been opened. */
function insideMetaEdgeBracket(
  text: string,
): { metaEdge: '#extract' | '#transform' | '#resources'; inside: string; inConfig: boolean } | null {
  let lastOpen = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ']') return null;
    if (text[i] === '[' && i > 0 && text[i - 1] === '-') {
      lastOpen = i;
      break;
    }
  }
  if (lastOpen === -1) return null;
  const inside = text.slice(lastOpen + 1);
  // Must start with `#` (meta-edge) — schema edges (`:Foo`) and bare aliases (`name:Edge`) don't apply.
  const metaMatch = inside.match(/^(#\w+)/);
  if (!metaMatch) {
    // Alias-bracket `name:#extract` form
    const aliasMeta = inside.match(/^[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*(#\w+)/);
    if (!aliasMeta) return null;
    const kind = aliasMeta[1] as '#extract' | '#transform' | '#resources';
    if (kind !== '#extract' && kind !== '#transform' && kind !== '#resources') return null;
    const inConfig = inside.includes('{');
    return { metaEdge: kind, inside, inConfig };
  }
  const kind = metaMatch[1] as '#extract' | '#transform' | '#resources';
  if (kind !== '#extract' && kind !== '#transform' && kind !== '#resources') return null;
  const inConfig = inside.includes('{');
  return { metaEdge: kind, inside, inConfig };
}

/**
 * Given the current text and cursor position, determine what completions to offer.
 * Uses a lightweight heuristic: look at the tokens before the cursor.
 *
 * @param contextNodeTypeId - The starting node type for this expression context.
 *   After traversals, the effective node type shifts to the far end of the edge,
 *   changing which properties and edges are offered.
 * @param tgOptions - Optional TG-mode completion config (alias bindings + `#extract`
 *   scope). When omitted, behavior is identical to legacy non-TG mode.
 */
export function getCompletions(
  input: string,
  cursorPos: number,
  properties: PropertyInfo[],
  edges?: EdgeInfo[],
  contextNodeTypeId?: string,
  edgeProperties?: PropertyInfo[],
  outputConstraints?: string[],
  capabilities: FormulaCapabilities = DEFAULT_CAPABILITIES,
  tgOptions?: TgCompletionOptions,
): Completion[] {
  // Inside a string literal: offer enum/output-constraint completions with bare insert text
  const stringCtx = isInsideString(input, cursorPos);
  if (stringCtx) {
    const partial = input.slice(stringCtx.start + 1, cursorPos);
    const inStringCompletions: Completion[] = [];

    // Determine which properties/edges to check for enum values by analyzing
    // the text before the string (i.e., the LHS property and operator)
    const textBeforeString = input.slice(0, stringCtx.start);
    const preToks = tokenize(textBeforeString).filter(t => t.type !== 'eof');

    // Check for enum values from the LHS property of a comparison
    const lastPreTok = preToks[preToks.length - 1];
    if (lastPreTok && (lastPreTok.type === 'op' || (lastPreTok.type === 'keyword' && COMPARE_KEYWORDS.has(lastPreTok.value)))) {
      const lhsTok = findTokenBefore(preToks, lastPreTok);
      if (lhsTok?.type === 'ident') {
        // Try main properties first, then edge properties (for WHERE clauses)
        const allProps = [...properties, ...(edgeProperties ?? [])];
        const lhsProp = allProps.find(p => p.name.toLowerCase() === lhsTok.value.toLowerCase());
        if (lhsProp?.enumValues) {
          for (const v of lhsProp.enumValues) {
            const escaped = stringCtx.quote === "'" ? v.replace(/'/g, "\\'") : v.replace(/"/g, '\\"');
            // Render as 'option' to match the styling used for output
            // constraints — they're conceptually the same: a closed set
            // of valid values for the current expression position.
            inStringCompletions.push({ label: v, insert: escaped + stringCtx.quote, kind: 'option' });
          }
        }
      }
    }

    // Output constraint completions (Airtable select options etc.)
    if (outputConstraints && outputConstraints.length > 0) {
      for (const v of outputConstraints) {
        const escaped = stringCtx.quote === "'" ? v.replace(/'/g, "\\'") : v.replace(/"/g, '\\"');
        inStringCompletions.push({ label: v, insert: escaped + stringCtx.quote, kind: 'option' });
      }
    }

    return filterCompletions(inStringCompletions, partial);
  }

  const textBefore = input.slice(0, cursorPos);

  // Check if cursor is inside a WHERE clause within traversal brackets
  const whereCtx = insideTraversalWhere(textBefore);
  if (whereCtx) {
    // Before WHERE keyword — suggest WHERE
    if (whereCtx.needsWhere) {
      const partial = getLastWord(whereCtx.whereText);
      return filterCompletions([{ label: 'WHERE', insert: 'WHERE ', kind: 'keyword' }], partial);
    }

    // For special brackets, use dedicated property lists
    const epList = whereCtx.edgeName === '#linked' ? LINKED_WHERE_PROPERTIES
      : isResourceHop(whereCtx.edgeName) ? RESOURCE_WHERE_PROPERTIES
      : (edgeProperties ?? []);
    // Inside WHERE: offer edge properties + operators + logical keywords
    const whereTokens = tokenize(whereCtx.whereText);
    const whereToks = whereTokens.filter(t => t.type !== 'eof');
    const whereLastWord = getLastWord(whereCtx.whereText);
    const whereLastTok = whereToks[whereToks.length - 1];

    const isWhereValueExpecting = (t: Token | undefined) =>
      !t || t.type === 'op' || t.type === 'comma' ||
      (t.type === 'keyword' && ['AND', 'OR', 'NOT'].includes(t.value));

    const wherePrevTok = whereToks.length >= 2 ? whereToks[whereToks.length - 2] : undefined;
    const whereMidTyping = whereLastWord !== '' && whereLastTok?.type === 'ident' &&
      (whereToks.length === 1 || isWhereValueExpecting(wherePrevTok));

    if (isWhereValueExpecting(whereLastTok) || whereMidTyping) {
      const epCompletions: Completion[] = epList.map(p => ({
        label: p.name,
        insert: needsQuote(p.name) ? '`' + p.name + '`' : p.name,
        kind: 'value' as const,
      }));
      // Comparison RHS enum hints for WHERE clause
      const whereEnumCompletions: Completion[] = [];
      const whereOpTok = whereMidTyping ? wherePrevTok : whereLastTok;
      if (whereOpTok && (whereOpTok.type === 'op' || (whereOpTok.type === 'keyword' && COMPARE_KEYWORDS.has(whereOpTok.value)))) {
        const whereLhsTok = findTokenBefore(whereToks, whereOpTok);
        if (whereLhsTok?.type === 'ident') {
          const lhsProp = epList.find(p => p.name.toLowerCase() === whereLhsTok.value.toLowerCase());
          if (lhsProp?.enumValues) {
            for (const v of lhsProp.enumValues) {
              whereEnumCompletions.push({ label: v, insert: `'${v.replace(/'/g, "\\'")}'`, kind: 'value' });
            }
          }
        }
      }
      return filterCompletions([...epCompletions, ...whereEnumCompletions], whereLastWord);
    }

    const afterWhereValue =
      whereLastTok?.type === 'ident' || whereLastTok?.type === 'string' ||
      whereLastTok?.type === 'number' ||
      (whereLastTok?.type === 'keyword' && ['TRUE', 'FALSE', 'NULL'].includes(whereLastTok.value));

    if (afterWhereValue) {
      let valueType: string | undefined;
      if (whereLastTok?.type === 'ident') {
        const ep = epList.find(p => p.name.toLowerCase() === whereLastTok.value.toLowerCase());
        valueType = ep?.valueType;
      }
      return filterCompletions([...opsForValueType(valueType), ...LOGICAL_OPS], whereLastWord);
    }

    return [];
  }

  // TG-mode early check: cursor inside an open meta-edge bracket — surface
  // config-object key hints (`description:`, `data:`, `plugin:`) so authors
  // don't have to memorise the bracket schema. The cypher-bracket parser
  // accepts these keys in any order; this is purely a discoverability
  // affordance.
  if (tgOptions) {
    const metaBracket = insideMetaEdgeBracket(textBefore);
    if (metaBracket && metaBracket.inConfig && metaBracket.metaEdge !== '#resources') {
      // Only suggest at the start of a new key — `{` open, `,` separator,
      // or empty trailing whitespace inside the config object.
      const tail = metaBracket.inside.match(/[{,]\s*([a-zA-Z_]\w*)?$/);
      if (tail) {
        const partial = tail[1] ?? '';
        const keys = META_EDGE_CONFIG_KEYS[metaBracket.metaEdge] ?? [];
        return filterCompletions(keys, partial);
      }
    }
  }

  // Early check: incomplete traversal syntax at the end of input (-[, -[:, -[:partial)
  // Must come before tokenization since the tokenizer can't produce useful tokens from this.
  const incompleteTraversal = textBefore.match(/(<)?-\[(?::([^\]]*))?$/);
  if (incompleteTraversal) {
    // Tokenize everything before the incomplete traversal for context
    const cleanText = textBefore.slice(0, textBefore.length - incompleteTraversal[0].length);
    const preToks = tokenize(cleanText).filter(t => t.type !== 'eof');
    const allEdges = edges ?? [];
    const { nodeTypeId: effectiveNodeType } = resolveTraversalContext(preToks, contextNodeTypeId, allEdges);
    const contextEdges = edgesForNodeType(allEdges, effectiveNodeType);
    const partial = (incompleteTraversal[2] ?? '').replace(/^`/, '');
    return filterCompletions(edgeCompletionsFor(contextEdges, effectiveNodeType, capabilities), partial);
  }

  // Early check: typing @ prefix for special completions. Gated on the
  // `kgGlobals` capability — adapter-source authoring contexts (e.g.
  // trigger filters) have no parent action node or KG identifiers in
  // scope, so offering @parent / @id / @user_* would mislead.
  const specialPrefix = textBefore.match(/@([a-zA-Z0-9_.]*)?$/);
  if (specialPrefix) {
    if (capabilities.kgGlobals === false) return [];
    const partial = specialPrefix[0]; // includes the @
    return filterCompletions(SPECIAL_COMPLETIONS, partial);
  }

  const tokens = tokenize(textBefore);
  const toks = tokens.filter(t => t.type !== 'eof');
  const allEdges = edges ?? [];

  const lastWord = getLastWord(textBefore);
  // Raw trailing text for filtering when lastWord is empty. Only useful
  // when the user has typed traversal-start chars (`-`, `<`) without
  // any word chars yet, so completions like `-[:Foo]->` filter by `-`.
  // After fully-tokenized operators (`.`, `,`, `(`, `)`, etc.) the
  // cursor is at a fresh value position with no partial — falling back
  // to `getTrailingNonWhitespace` here would capture garbage like
  // `Of]->.` from a preceding traversal token and over-filter.
  const trailingChar = textBefore.slice(-1);
  const trailingRaw = lastWord || (trailingChar === '-' || trailingChar === '<'
    ? getTrailingNonWhitespace(textBefore)
    : '');
  const lastTok = toks[toks.length - 1];

  // Walk traversals to determine effective node type at cursor, and the
  // last edge stepped through (whose properties become accessible via
  // `edge.<prop>` per Cypher-style binding).
  const { nodeTypeId: effectiveNodeType, lastEdgeId } =
    resolveTraversalContext(toks, contextNodeTypeId, allEdges);
  const contextProps = propsForNodeType(properties, effectiveNodeType);
  const contextEdges = edgesForNodeType(allEdges, effectiveNodeType);
  const scopedEdgeProps = (edgeProperties ?? []).filter(
    p => lastEdgeId !== undefined && p.edgeTypeId === lastEdgeId,
  );

  // Count open IF/END to know if we're inside a conditional
  let ifDepth = 0;
  for (const t of toks) {
    if (t.type === 'keyword' && t.value === 'IF') ifDepth++;
    if (t.type === 'keyword' && t.value === 'END') ifDepth--;
  }

  // Check if a token indicates what follows should be a value
  const isValueExpecting = (t: Token | undefined) =>
    !t ||
    t.type === 'op' ||
    t.type === 'comma' ||
    (t.type === 'paren' && t.value === '(') ||
    (t.type === 'keyword' && ['AND', 'OR', 'NOT', 'THEN', 'ELSE', 'IF'].includes(t.value));

  // If currently typing an ident, check the token before it for context
  const prevTok = toks.length >= 2 ? toks[toks.length - 2] : undefined;
  const midTypingValue = lastWord !== '' && lastTok?.type === 'ident' && (toks.length === 1 || isValueExpecting(prevTok));

  const expectsValue = isValueExpecting(lastTok) || midTypingValue;

  // Inside `edge.<partial>` after a traversal — short-circuit to bare
  // edge-property names. The parser binds the just-walked edge as an
  // implicit `edge` variable (formula.ts:914-922 → edge_property AST);
  // the engine consumes it via ctx.lastEdges (expression.ts:236).
  // Only meaningful when the current scope has actually walked an edge,
  // and the adapter advertises the edgeProperties capability.
  const edgeAccessor = (() => {
    if (toks.length >= 2 &&
        lastTok?.type === 'op' && lastTok.value === '.' &&
        toks[toks.length - 2]!.type === 'ident' &&
        toks[toks.length - 2]!.value.toLowerCase() === 'edge') {
      return { partial: '' };
    }
    if (toks.length >= 3 &&
        lastTok?.type === 'ident' &&
        toks[toks.length - 2]!.type === 'op' &&
        toks[toks.length - 2]!.value === '.' &&
        toks[toks.length - 3]!.type === 'ident' &&
        toks[toks.length - 3]!.value.toLowerCase() === 'edge') {
      return { partial: lastTok.value };
    }
    return null;
  })();
  if (edgeAccessor) {
    if (!capabilities.edgeProperties || !lastEdgeId || scopedEdgeProps.length === 0) {
      return [];
    }
    return filterCompletions(
      scopedEdgeProps.map(p => ({
        label: p.name,
        insert: needsQuote(p.name) ? '`' + p.name + '`' : p.name,
        kind: 'value' as const,
      })),
      edgeAccessor.partial,
    );
  }

  // Build `edge.<prop>` completions for the just-walked edge — surfaced
  // in value-expecting and post-traversal branches below so users
  // discover the binding without having to type `edge.` first. Gated on
  // the adapter's `edgeProperties` capability + an in-scope traversal.
  const edgeBindCompletions: Completion[] = (capabilities.edgeProperties && lastEdgeId)
    ? scopedEdgeProps.map(p => {
        const q = needsQuote(p.name) ? '`' + p.name + '`' : p.name;
        return { label: `edge.${p.name}`, insert: `edge.${q}`, kind: 'value' as const };
      })
    : [];

  if (expectsValue) {
    const propCompletions: Completion[] = contextProps.map(p => ({
      label: p.name,
      insert: needsQuote(p.name) ? '`' + p.name + '`' : p.name,
      kind: 'value' as const,
    }));

    // TG-mode value-expecting additions: bare alias bindings (named
    // ancestors and trigger-root aliases) + EXTRACT_VALUE() — the
    // latter only when an ancestral `#extract` is in scope.
    const tgValueCompletions: Completion[] = [];
    if (tgOptions) {
      for (const alias of tgOptions.triggerAliases ?? []) {
        tgValueCompletions.push({
          label: alias,
          insert: needsQuote(alias) ? '`' + alias + '`' : alias,
          kind: 'special',
        });
      }
      if (tgOptions.insideExtract) {
        tgValueCompletions.push(EXTRACT_VALUE_COMPLETION);
      }
    }

    // Comparison RHS: if the token before the operator is a property with enum values, suggest them
    const comparisonEnumCompletions: Completion[] = [];
    const opTok = midTypingValue ? prevTok : lastTok;
    if (opTok && (opTok.type === 'op' || (opTok.type === 'keyword' && COMPARE_KEYWORDS.has(opTok.value)))) {
      const lhsTok = findTokenBefore(toks, opTok);
      if (lhsTok?.type === 'ident') {
        const lhsProp = contextProps.find(p => p.name.toLowerCase() === lhsTok.value.toLowerCase());
        if (lhsProp?.enumValues) {
          for (const v of lhsProp.enumValues) {
            comparisonEnumCompletions.push({ label: v, insert: `'${v.replace(/'/g, "\\'")}'`, kind: 'option' });
          }
        }
      }
    }

    // Output context: suggest target field option values as quoted string literals
    const outputCompletions: Completion[] = [];
    if (outputConstraints && outputConstraints.length > 0) {
      for (const v of outputConstraints) {
        const escaped = v.replace(/"/g, '\\"');
        outputCompletions.push({ label: `"${v}"`, insert: `"${escaped}"`, kind: 'option' });
      }
    }

    // Hoist option-kind completions (output constraints + comparison enum
    // values) above properties/edges/functions. When the author has
    // already pinned a comparison operator with an enum LHS, the closed
    // value set is far more likely the intended next token than another
    // property reference — keeping it at the top of the dropdown matches
    // the user's mental ordering.
    // WITHIN is only meaningful when at least one date field is in
    // scope — otherwise there's nothing the recency clause can compare
    // against. Hide the completion in that case so the agent / human
    // never sees a function they can't use.
    const hasDateField = contextProps.some((p) => p.valueType === 'date');
    // Field functions advertised on the target field being mapped (e.g.
    // SLACK_MESSAGE on a Slack message text field). Field-scoped — only
    // present in `tgOptions.fieldFunctions` when mapping that field (C6).
    const fieldFunctionCompletions: Completion[] = (tgOptions?.fieldFunctions ?? []).map((fn) => ({
      label: `${fn.name}()`,
      insert: `${fn.name}(`,
      kind: 'function' as const,
    }));
    const functionCompletions = filterCompletionsByCaps(
      [...FUNCTION_COMPLETIONS, ...fieldFunctionCompletions],
      capabilities,
    ).filter((c) => c.insert !== 'WITHIN(' || hasDateField);
    // Cypher-syntax hint completions (TG-only). Filtered by trailing
    // partial below — when the user has typed `-`, the bracket templates
    // surface; otherwise they sit at the bottom of the list.
    const cypherCompletions: Completion[] = tgOptions ? CYPHER_SYNTAX_COMPLETIONS : [];

    return filterCompletions([
      ...outputCompletions,
      ...comparisonEnumCompletions,
      ...tgValueCompletions,
      ...propCompletions,
      ...edgeBindCompletions,
      ...edgeCompletionsFor(contextEdges, effectiveNodeType, capabilities),
      ...(capabilities.kgGlobals === false ? [] : SPECIAL_COMPLETIONS),
      ...functionCompletions,
      ...cypherCompletions,
    ], trailingRaw);
  }

  // After a traversal step — expect .Property or another traversal (context already shifted)
  if (lastTok?.type === 'traverse') {
    // After a resource traversal, offer resource field completions
    if (isResourceHop(lastTok.value)) {
      return RESOURCE_FIELD_COMPLETIONS;
    }
    // After a linked object traversal, offer linked object field completions
    if (lastTok.value === '#linked' || lastTok.value.startsWith('#linked ')) {
      return LINKED_FIELD_COMPLETIONS;
    }
    const propCompletions: Completion[] = contextProps.map(p => ({
      label: p.name,
      insert: '.' + (needsQuote(p.name) ? '`' + p.name + '`' : p.name),
      kind: 'value' as const,
    }));
    // After the traversal token a leading dot is required before any
    // accessor — so dress up the bare `edge.X` entries with a `.`.
    const edgeBindAfterTraverse: Completion[] = edgeBindCompletions.map(c => ({
      ...c,
      label: `.${c.label}`,
      insert: `.${c.insert}`,
    }));
    return [
      ...propCompletions,
      { label: '@id', insert: '.@id', kind: 'special' },
      ...edgeBindAfterTraverse,
      ...edgeCompletionsFor(contextEdges, effectiveNodeType, capabilities),
    ];
  }

  // After a value or closing paren — offer operators filtered by type + traversal
  const afterValue =
    (lastTok?.type === 'ident') ||
    (lastTok?.type === 'string') ||
    (lastTok?.type === 'number') ||
    (lastTok?.type === 'special') ||
    (lastTok?.type === 'paren' && lastTok.value === ')') ||
    (lastTok?.type === 'keyword' && ['TRUE', 'FALSE', 'NULL', 'EXISTS'].includes(lastTok.value));

  if (afterValue) {
    let valueType: string | undefined;
    if (lastTok?.type === 'ident') {
      const prop = contextProps.find(p => p.name.toLowerCase() === lastTok.value.toLowerCase());
      valueType = prop?.valueType;
    }
    const ops = opsForValueType(valueType);
    const completions = [...ops, ...LOGICAL_OPS];
    if (ifDepth > 0) completions.push(...IF_BRANCH_COMPLETIONS);
    return filterCompletions(completions, lastWord);
  }

  return [];
}

function getLastWord(text: string): string {
  const match = text.match(/[a-zA-Z_][a-zA-Z0-9_]*$/);
  return match?.[0] ?? '';
}

function getTrailingNonWhitespace(text: string): string {
  const match = text.match(/\S+$/);
  return match?.[0] ?? '';
}

function filterCompletions(completions: Completion[], prefix: string): Completion[] {
  if (!prefix) return completions;
  const lower = prefix.toLowerCase();
  return completions.filter(c => {
    const label = c.label.toLowerCase();
    const insert = c.insert.toLowerCase();
    // Also match against inner content of quoted labels (e.g., "general" matches gen)
    const unquoted = label.startsWith('"') || label.startsWith("'") ? label.slice(1) : label;
    return label.startsWith(lower) || insert.startsWith(lower) || unquoted.startsWith(lower);
  });
}

// ── Expression Type System ──
// inferred types for validation + autocomplete

export type ExprType =
  | { kind: 'literal'; values: Set<string> }
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'null' }
  | { kind: 'unknown' }
  /**
   * A node / external-record reference rather than a primitive value.
   * Produced by reference-typed property fields (KG: `node_type_id`-style;
   * adapter: `kind: 'reference'`) and by traversals whose innermost
   * expression resolves to one. Records can be the source of further
   * traversal but can't (sensibly) flow into string/number/boolean
   * targets — the editor warns when they're used as scalar values.
   */
  | { kind: 'record' }
  /**
   * File — a typed binary handle. Mirrors `ExpressionType { kind: 'file' }`
   * on the API side (see
   * `apps/api/src/services/translation_graph/types.ts`). Produced by
   * reading a property whose `valueType === 'file'` — i.e., an
   * adapter-declared file field like the Email attachment's `data` slot
   * or the Slack file's `data` slot.
   *
   * Compatibility: File values can flow only into File-typed targets
   * (e.g., Attio attachment fields, KG resource slots, `#extract`'s
   * `data:` config). A File flowing into a string/number/boolean target
   * is a hard error — the adapter can't coerce a binary handle to a
   * scalar (and vice-versa). See `resources_currency.md` and E5 (wave-2).
   */
  | { kind: 'file' }
  /**
   * A multi-cardinality value — an array of `elementType` rather than a
   * single instance. Produced by:
   *   - properties with `cardinality === 'many'` (e.g. `themes: string[]`)
   *   - traversal steps that fan out (mode='all', the default for edges)
   * Unwrapped back to single by `aggregate.first/last/min/max`, `at`,
   * and friends.
   *
   * Compatibility: a multi value flowing into a single-cardinality target
   * is a warning (the engine auto-CSV-joins at the write boundary but
   * authors usually want an explicit aggregator). A single flowing into
   * a multi target auto-wraps `[value]`; no warning.
   */
  | { kind: 'many'; elementType: ExprType };

export interface PropertyContext {
  getProperty(id: string): {
    valueType: string;
    enumValues?: string[];
    cardinality?: 'one' | 'many';
  } | undefined;
  getEdgeProperty(id: string): {
    valueType: string;
    enumValues?: string[];
    cardinality?: 'one' | 'many';
  } | undefined;
}

function mergeTwo(a: ExprType, b: ExprType): ExprType {
  if (a.kind === 'unknown' || b.kind === 'unknown') return { kind: 'unknown' };
  if (a.kind === 'null') return b;
  if (b.kind === 'null') return a;
  if (a.kind === 'many' && b.kind === 'many') {
    return { kind: 'many', elementType: mergeTwo(a.elementType, b.elementType) };
  }
  // Mixing a many with a single is "unknown" — the caller has a
  // cardinality mismatch we can't reconcile without an aggregator or
  // wrapper. The expressionEditor's type-mismatch warning catches this
  // upstream when it matters; merge just refuses to claim a kind.
  if (a.kind === 'many' || b.kind === 'many') return { kind: 'unknown' };
  if (a.kind === 'literal' && b.kind === 'literal') {
    return { kind: 'literal', values: new Set([...Array.from(a.values), ...Array.from(b.values)]) };
  }
  if (a.kind === 'literal' && b.kind === 'string') return { kind: 'string' };
  if (a.kind === 'string' && b.kind === 'literal') return { kind: 'string' };
  if (a.kind === b.kind) return a;
  return { kind: 'unknown' };
}

/**
 * Unwrap one level of `many` from an ExprType. No-op for single types.
 * Used by aggregate.first / aggregate.last / `at` / similar reducers
 * that go from a multi value to one element.
 */
function unwrapMany(t: ExprType): ExprType {
  return t.kind === 'many' ? t.elementType : t;
}

export function mergeTypes(...types: ExprType[]): ExprType {
  if (types.length === 0) return { kind: 'unknown' };
  return types.reduce(mergeTwo);
}

function valueTypeToExprType(valueType: string, enumValues?: string[]): ExprType {
  if (enumValues && enumValues.length > 0) return { kind: 'literal', values: new Set(enumValues) };
  switch (valueType) {
    case 'number': return { kind: 'number' };
    case 'boolean': return { kind: 'boolean' };
    case 'reference': return { kind: 'record' };
    // File-typed property (an adapter-declared file field such as Email
    // `attachment.data` or Slack `file.data`). E5 (wave-2): kept distinct
    // so File values are routed only into File-typed target fields and
    // mismatches surface as hard errors in the editor.
    case 'file': return { kind: 'file' };
    case 'text': case 'date': case 'email': case 'url': case 'phone':
      return { kind: 'string' };
    default: return { kind: 'string' };
  }
}

export function inferType(expr: Expression, ctx: PropertyContext): ExprType {
  switch (expr.type) {
    case 'static': {
      if (typeof expr.value === 'string') return { kind: 'literal', values: new Set([expr.value]) };
      if (typeof expr.value === 'number') return { kind: 'number' };
      if (typeof expr.value === 'boolean') return { kind: 'boolean' };
      return { kind: 'null' };
    }
    case 'property': {
      const prop = ctx.getProperty(expr.propertyTypeId);
      if (!prop) return { kind: 'unknown' };
      const base = valueTypeToExprType(prop.valueType, prop.enumValues);
      return prop.cardinality === 'many' ? { kind: 'many', elementType: base } : base;
    }
    case 'edge_property': {
      const prop = ctx.getEdgeProperty(expr.propertyTypeId);
      if (!prop) return { kind: 'unknown' };
      const base = valueTypeToExprType(prop.valueType, prop.enumValues);
      return prop.cardinality === 'many' ? { kind: 'many', elementType: base } : base;
    }
    case 'llm': return { kind: 'string' };
    case 'meta': return { kind: 'string' };
    case 'parent_result': return expr.field === 'created' ? { kind: 'boolean' } : { kind: 'string' };
    // `action_result` reads a handle field whose type depends on what the
    // producing action wrote / the adapter returned — only the specials
    // have static types.
    case 'action_result':
      return expr.field === 'created' ? { kind: 'boolean' }
        : expr.field === 'external_id' ? { kind: 'string' }
        : { kind: 'unknown' };
    case 'resource': return { kind: 'string' };
    case 'linked_object': return { kind: 'string' };
    case 'traverse': {
      const inner = inferType(expr.expression, ctx);
      // A traversal step's default fan-out is `all` — multiple matched
      // positions yield multiple values. The step's `cardinality.mode`
      // can narrow this to `first` (one) or `n` (still many). If every
      // step is explicitly `first`, the traversal is single-valued;
      // otherwise treat the result as many.
      const anyFanOut = expr.steps.some((s) => {
        if (s.type !== 'edge') return false;
        const mode = s.cardinality?.mode;
        return mode !== 'first';
      });
      return anyFanOut ? { kind: 'many', elementType: inner } : inner;
    }
    case 'resource_traverse': {
      // Resource traversals always fan out across attached resources.
      const inner = inferType(expr.expression, ctx);
      return { kind: 'many', elementType: inner };
    }
    case 'arithmetic': return { kind: 'number' };
    case 'compare': return { kind: 'boolean' };
    case 'logical': return { kind: 'boolean' };
    case 'not': return { kind: 'boolean' };
    case 'negate': return { kind: 'number' };
    case 'concat': return { kind: 'string' };
    case 'conditional': return mergeTypes(inferType(expr.then, ctx), inferType(expr.else, ctx));
    case 'aggregate': {
      const inner = inferType(expr.expression, ctx);
      switch (expr.fn) {
        // Reducers — collapse a multi-valued input down to one element.
        case 'first': case 'last': case 'only': case 'min': case 'max': return unwrapMany(inner);
        case 'count': case 'sum': case 'avg': return { kind: 'number' };
        case 'join': case 'llm': return { kind: 'string' };
        case 'collect': {
          // `collect(x)` is "wrap each element in an array" — always
          // produces a many of inner's element type.
          return { kind: 'many', elementType: unwrapMany(inner) };
        }
        // `SORT` hands the same members back, so it is its argument's type —
        // as a many, since a sorted collection is still a collection.
        case 'sort': return { kind: 'many', elementType: unwrapMany(inner) };
        default: return { kind: 'unknown' };
      }
    }
    case 'function': {
      switch (expr.fn) {
        case 'coalesce': return mergeTypes(...expr.args.map(a => inferType(a, ctx)));
        case 'isnull': return { kind: 'boolean' };
        case 'trim': case 'lower': case 'upper': case 'tostring': return { kind: 'string' };
        // DATE/DATETIME coerce to a date/timestamp value — this legacy
        // union has no distinct temporal kind (date-typed properties type
        // as `string`, see valueTypeToExprType), so they follow `tostring`.
        case 'date': case 'datetime': return { kind: 'string' };
        case 'length': case 'abs': case 'round': case 'floor': case 'ceil': case 'tonumber':
        case 'number':
          return { kind: 'number' };
        case 'multi': {
          // MULTI(a, b, c) → array. Element type is the merged type of
          // every arg (after unwrapping any already-many args), so the
          // cardinality warning lines up with the target's element kind.
          const elementType = mergeTypes(
            ...expr.args.map((a) => unwrapMany(inferType(a, ctx))),
          );
          return { kind: 'many', elementType };
        }
        case 'split':
          // SPLIT(str, sep) → array of strings.
          return { kind: 'many', elementType: { kind: 'string' } };
        default: return { kind: 'unknown' };
      }
    }
    case 'kg_exists': return { kind: 'boolean' };
    case 'kg_value': return { kind: 'unknown' };
    case 'exists': return { kind: 'boolean' };
    case 'at': return unwrapMany(inferType(expr.expression, ctx));
    // `EXTRACT_VALUE` is type-inferred from its surrounding expression
    // field context. At AST inspection time we don't carry that context
    // down here, so report `unknown` — the engine fills in the inferred
    // type at execution time.
    case 'extract_value': return { kind: 'unknown' };
    // `alias_ref` resolves against ancestor lexical scope. The parser
    // binds the name; the evaluator looks up the value (and its type)
    // at runtime. `unknown` until the resolver is wired in R1.
    case 'alias_ref': return { kind: 'unknown' };
    // An object literal is a structured DATA value, and this legacy v3 union
    // has no vocabulary for one (`record` means a traversable node/record
    // reference, which an object literal is not). `unknown` is the honest
    // answer here; the movement checker's `json` type is where a structured
    // value gets a real one (plans/slack-blocks-json-fields-2026-07-30).
    case 'object': return { kind: 'unknown' };
    case 'list': {
      // Set literal — type is `many` of the merged element type. Empty
      // list collapses to `many { unknown }`.
      if (expr.elements.length === 0) return { kind: 'many', elementType: { kind: 'unknown' } };
      const elementType = mergeTypes(
        // A spread's members are its collection's elements — `unwrapMany`
        // reads them off the same way it reads a single member's own type.
        ...expr.elements.map((e) => unwrapMany(inferType(listElementExpression(e), ctx))),
      );
      return { kind: 'many', elementType };
    }
  }
}

export type OptionsValidationResult =
  | { valid: true }
  | { valid: false; invalidValues: string[] }
  | { valid: 'skip' };

export function validateAgainstOptions(type: ExprType, options: string[]): OptionsValidationResult {
  if (type.kind === 'literal') {
    const optionSet = new Set(options.map(o => o.toLowerCase()));
    const invalid = Array.from(type.values).filter(v => !optionSet.has(v.toLowerCase()));
    return invalid.length === 0 ? { valid: true } : { valid: false, invalidValues: invalid };
  }
  if (type.kind === 'string' || type.kind === 'unknown') return { valid: 'skip' };
  return { valid: false, invalidValues: [`<${type.kind}>`] };
}

// ── Source traversal: bare `-[:Edge]->-[:Edge]->` chains ───────────────────
//
// Action nodes on translation graphs carry a source-side traversal that
// walks the invoker's source position forward to the read point for
// field mappings. The text form is the same `-[:EdgeName]->` syntax used
// inside field-mapping expressions — `parseSourceTraversal` shares the
// tokenizer with `parse()` so the web editor and the translation agent
// see identical syntax — but it terminates at the last edge token
// rather than requiring a `. <terminal-expression>`.
//
// Storage shape stays `TraversalStep[]` on the action node so the
// engine and projections consume it unchanged.

export interface SourceTraversalResolvers {
  /** Look up an edge by name reachable from `fromTypeId`. Returns the
   *  edge type id, direction (which side the current type is on), and
   *  the target type id (where the step lands). Returns null when no
   *  edge matches. KG bidirectional edges resolve to `'outgoing'` for
   *  the outbound name and `'incoming'` for the inbound name. */
  resolveEdge: (args: { fromTypeId: string | null; name: string }) =>
    | { edgeTypeId: string; direction: 'outgoing' | 'incoming'; targetTypeId: string }
    | null;
  /** Look up a property name on a node type. Used in two positions:
   *
   *   - WHERE-clause filters, scoped to the post-step destination type
   *     (`onTypeId` is always a concrete type — the engine evaluates
   *     `step.expressionFilter` against that node).
   *   - `#extract` meta-edge `data:` field references. These aren't
   *     scoped to a single type — the serializer already resolves them
   *     against every source type's field pool — and `onTypeId` is
   *     `null` whenever the current position has no single type (a
   *     dynamic/polymorphic root, or the position after a prior
   *     meta-edge / `#resources` step). Implementers MUST handle a
   *     `null` `onTypeId` by searching all source types; scoping to one
   *     type there reproduces the "Unknown property" round-trip bug.
   *
   *  When omitted, the WHERE clause body falls back to id-less name
   *  strings. */
  resolveProperty?: (args: { onTypeId: string | null; name: string }) => string | undefined;
}

export type ParseSourceTraversalResult =
  | { ok: true; steps: TraversalStep[]; resolved: string | null }
  | { ok: false; error: string; errorPos?: number };

/**
 * Parse a bare traversal text — a chain of `-[:Edge]->` (and special
 * `-[#resources]->`) tokens with no terminal expression. Empty input is
 * valid: zero steps, resolved = startTypeId.
 *
 * Rejects `-[#linked]->` and `<-[:Edge]-`: source traversals identify
 * edge direction via the resolver callback (which knows the
 * descriptor's edge names per direction), so the arrow shape adds
 * nothing.
 */
export function parseSourceTraversal(
  input: string,
  resolvers: SourceTraversalResolvers,
  startTypeId: string | null,
): ParseSourceTraversalResult {
  const tokens = tokenize(input);
  const steps: TraversalStep[] = [];
  let current: string | null = startTypeId;
  for (const tok of tokens) {
    if (tok.type === 'eof') break;
    if (tok.type !== 'traverse') {
      return {
        ok: false,
        error: `Unexpected token "${tok.value || tok.type}" — source traversal expects -[:EdgeName]-> tokens`,
        errorPos: tok.pos,
      };
    }
    if (tok.value.startsWith('<')) {
      return {
        ok: false,
        error: 'Incoming arrow syntax (<-[:...]-) is not supported in source traversals — use the inbound edge name; direction comes from the descriptor',
        errorPos: tok.pos,
      };
    }
    const rawName = tok.value;

    if (isResourceHop(rawName)) {
      steps.push({ type: 'resource' });
      current = null;
      continue;
    }
    if (rawName === '#linked') {
      return {
        ok: false,
        error: '-[#linked]-> is not supported in source traversals',
        errorPos: tok.pos,
      };
    }

    // Meta-edges (TG-parity): `-[alias:#extract { ... }]->` /
    // `-[alias:#transform { ... }]->`. The descriptor doesn't know
    // about ephemeral / transform-augmented nodes, so we don't run
    // resolveEdge here — the engine binds meta-edge step output to
    // the named alias at execution time.
    if (rawName === '#extract' || rawName === '#transform') {
      const metaEdge = rawName === '#extract' ? 'extract' : 'transform';
      let config: MetaEdgeStep['config'] | undefined;
      if (tok.configText) {
        try {
          config = parseConfigObject(tok.configText, tok.pos, (text) => {
            const result = validate(text, resolvers.resolveProperty
              ? (name) => resolvers.resolveProperty!({ onTypeId: current, name })
              : () => undefined);
            if (!result.valid || !result.expression) {
              throw new ParseError(
                `meta-edge config: ${result.error ?? 'could not parse value expression'}`,
                tok.pos,
              );
            }
            return result.expression;
          });
        } catch (e) {
          if (e instanceof ParseError) {
            return { ok: false, error: e.message, errorPos: e.pos };
          }
          throw e;
        }
      }
      const metaStep: MetaEdgeStep = {
        type: 'meta_edge',
        metaEdge,
        ...(tok.alias ? { alias: tok.alias } : {}),
        ...(config ? { config } : {}),
      };
      steps.push(metaStep);
      current = null;
      continue;
    }

    if (current === null) {
      return {
        ok: false,
        error: 'Cannot continue traversal after a step that left node-type space',
        errorPos: tok.pos,
      };
    }

    const resolved = resolvers.resolveEdge({ fromTypeId: current, name: rawName });
    if (!resolved) {
      return {
        ok: false,
        error: `No edge "${rawName}" from current type`,
        errorPos: tok.pos,
      };
    }
    const step: EdgeStep = {
      type: 'edge',
      edgeTypeId: resolved.edgeTypeId,
      direction: resolved.direction,
      ...(tok.alias ? { alias: tok.alias } : {}),
    };
    if (tok.orderByText !== undefined || tok.limitCount !== undefined) {
      let orderBy: Expression | undefined;
      if (tok.orderByText !== undefined) {
        // The key is an expression over the element, so it parses exactly as
        // the WHERE does — against the type the hop lands on.
        const keyResult = validate(
          tok.orderByText,
          (name) =>
            resolvers.resolveProperty?.({
              onTypeId: resolved.targetTypeId,
              name,
            }),
        );
        if (!keyResult.valid || !keyResult.expression) {
          return {
            ok: false,
            error: `ORDER BY: ${keyResult.error ?? 'could not parse the ordering key'}`,
            errorPos: tok.pos,
          };
        }
        orderBy = keyResult.expression;
      }
      step.cardinality = {
        mode: tok.limitCount !== undefined ? 'n' : 'all',
        ...(tok.limitCount !== undefined ? { limit: tok.limitCount } : {}),
        ...(orderBy !== undefined
          ? { orderBy, orderDirection: tok.orderDirection ?? 'asc' }
          : {}),
      };
    }
    if (tok.filterText) {
      const result = validate(
        tok.filterText,
        (name) =>
          resolvers.resolveProperty?.({
            onTypeId: resolved.targetTypeId,
            name,
          }),
      );
      if (!result.valid || !result.expression) {
        return {
          ok: false,
          error: `WHERE: ${result.error ?? 'could not parse filter expression'}`,
          errorPos: tok.pos,
        };
      }
      step.expressionFilter = result.expression;
    }
    steps.push(step);
    current = resolved.targetTypeId;
  }

  return { ok: true, steps, resolved: current };
}

export interface SerializeSourceTraversalResolvers {
  /** Render an edge step from a given source type. Returns the display
   *  name + next target type (so the serializer can advance the
   *  current-type for subsequent steps' edge lookups). Returns null
   *  when the descriptor doesn't know the edge (lazy-load race) —
   *  serializer renders the raw edge id as a placeholder so the step
   *  survives editing visually. */
  describeEdge: (args: {
    fromTypeId: string | null;
    edgeTypeId: string;
    direction: 'outgoing' | 'incoming';
  }) => { name: string; targetTypeId: string } | null;
  /** Render a WHERE-clause expression as text against `destinationTypeId`'s
   *  property pool. When omitted, WHERE clauses are dropped from the
   *  output (matches the bare-name fallback in the parser). */
  serializeWhereClause?: (args: {
    expression: Expression;
    destinationTypeId: string;
  }) => string;
  /** Render a property-typeId as its display name. Used to render the
   *  `data: [...]` property-refs on a `#extract` meta-edge step (and any
   *  other property reference embedded in a meta-edge config) by name
   *  rather than empty backticks. When omitted, the raw id is rendered —
   *  never an empty string, so the names never silently vanish. */
  resolvePropertyName?: (propertyTypeId: string) => string;
}

/**
 * Serialize a TraversalStep[] back to source-traversal text. Inverse
 * of `parseSourceTraversal` — round-trips when descriptor lookups
 * resolve. Unknown edges render as `-[:<edge-id>]->` so the step
 * survives editing even while descriptor data is still loading.
 */
export function serializeSourceTraversal(
  steps: TraversalStep[],
  resolvers: SerializeSourceTraversalResolvers,
  startTypeId: string | null,
): string {
  if (steps.length === 0) return '';
  const out: string[] = [];
  let current: string | null = startTypeId;
  for (const step of steps) {
    if (step.type === 'resource') {
      out.push('-[:_resources]->');
      current = null;
      continue;
    }
    if (step.type === 'linkBack') {
      out.push('-[:linkBack]->');
      continue;
    }
    if (step.type === 'edge') {
      const described = resolvers.describeEdge({
        fromTypeId: current,
        edgeTypeId: step.edgeTypeId,
        direction: step.direction,
      });
      const aliasPrefix = step.alias ? quoteName(step.alias) : '';
      if (!described) {
        out.push(`-[${aliasPrefix}:${step.edgeTypeId}]->`);
        continue;
      }
      const where =
        (step.expressionFilter && resolvers.serializeWhereClause
          ? ` WHERE ${resolvers.serializeWhereClause({
              expression: step.expressionFilter,
              destinationTypeId: described.targetTypeId,
            })}`
          : '') +
        serializeOrderLimitSuffix(step, resolvers.resolvePropertyName ?? ((id) => id));
      out.push(`-[${aliasPrefix}:${quoteName(described.name)}${where}]->`);
      current = described.targetTypeId;
    }
    if (step.type === 'meta_edge') {
      // TG-parity meta-edge source-traversal serialization. Delegates to
      // the shared step serializer so a round-trip parse + serialize
      // preserves the step; the engine renders the full descriptor-aware
      // form when consuming. The resolver renders property-refs inside the
      // `#extract` config's `data: [...]` by name — falling back to the
      // raw id (never an empty string, which produced empty backticks).
      const resolveName = resolvers.resolvePropertyName
        ? (id: string) => resolvers.resolvePropertyName!(id)
        : (id: string) => id;
      out.push(serializeTraversalStep(step, resolveName, undefined, undefined));
      current = null;
    }
  }
  return out.join('');
}
