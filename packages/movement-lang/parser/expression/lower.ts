// Lowering: the movement expression tree (./tree.ts) → the shared `Expression`
// (packages/shared/expression/types.ts) that the checker, the engine, the web
// app's formula input and every adapter's filter pushdown read. This is where
// a NAME first means something: `COUNT` becomes an aggregate, `AI` an llm
// node, `EXISTS` a quantifier, `CURRENCY.PARSE` a stdlib function.
//
// It reproduces what the old text-rewriting bridge produced, apart from four
// bridge defects fixed under every language version (2_one_grammar.md,
// rulings after step 1): an `if` condition binds AND tighter than OR, an
// `IF … AND … END` reads whole, a walk inside `EXISTS(…)` reads its own
// interpolations and nested `EXISTS`, and an empty hop `WHERE` is refused.
// A bare walk is the records it lands on wherever a value goes.
//
// Where a rule depends on something the tree has no word for (the letter case
// of an aggregate's name), the rule says so.

import type {
  EdgeStep,
  EnrichWithEntry,
  Expression,
  ListElement,
  MetaEdgeStep,
  ObjectMember,
  TraversalStep,
} from '@listen-fire/shared/expression/types';
import { AI_TIERS } from '@listen-fire/shared/expression/types';
import { validateBuiltinCallShape } from '../../expression/call_shape';
import { BridgeError } from '../../expression/error';
import { describeStdlibFamily, listStdlibNamespaces, stdlibFamily } from '../../expression/stdlib';
import { neverAsAny } from '../../never';
import { isMapSpread, type BinaryOp, type CallArg, type Hop, type MapEntry, type MExpr, type Name, type TypeExpr } from './tree';
import { parseExpression } from './parse_expression';

export class LoweringError extends BridgeError {
  constructor(
    message: string,
    code?: string,
    /** A closure written where it would be kept as data — a list's element
     *  or a map's value. From language version 5 a closure is a value, and
     *  the checker refuses it there because a closure is not data. */
    readonly heldAsData?: 'list' | 'map',
  ) {
    super(message, undefined, code);
    this.name = 'LoweringError';
  }
}

const CLOSURE_POSITION_MESSAGE = 'a closure cannot be written here — bind it to a name first and pass the name';

/** Terminal property id meaning "the landings themselves": a bare walk
 *  (`orgs-[:co]->`) lowers to a traverse ending in a read of this property.
 *  A read of it is not a property read; the traversal yields its positions. */
export const POSITION_SENTINEL = '__movement_position__';

export type MovementCondition =
  | { kind: 'and'; conjuncts: MovementCondition[] }
  | {
      kind: 'isTest';
      subjectRaw: string;
      /** `position`: the single unpinned hop's name (`<crm-[:company]->>`).
       *  `hopsRaw`: the raw hop text when the marker carries a WHERE — an
       *  event ADDRESS (`<at-[:`Record Change` WHERE `action` == "…"]->>`),
       *  resolved by the checker/engine via `eventAddressOfHops`. Exactly one
       *  of the two is set for a hop-form marker; neither for `<graph>`. */
      type: { graph: string; position?: string; hopsRaw?: string };
    }
  | { kind: 'expr'; expr: Expression };

/** Where a name is read. Inside a hop's WHERE a bare name is a property of
 *  the EDGE's landing (`edge_property`) — the formula grammar's edge-property
 *  mode, which everything nested in that WHERE inherits. */
interface Ctx {
  edgeProps: boolean;
}

const TOP: Ctx = { edgeProps: false };

/** Lower one expression; `source` is the text `tree` was parsed from. */
export function lowerExpression(tree: MExpr, source: string): Expression {
  return new Lowering(source).lower(tree, TOP);
}

/** Lower one `if` condition into its top-level
 *  `AND` conjuncts, each an `IS` type guard or an expression. */
export function lowerCondition(tree: MExpr, source: string): MovementCondition {
  return new Lowering(source).condition(tree);
}

/** Parse and lower one expression text. */
export function lowerMovementExpression(raw: string): Expression {
  return lowerExpression(parseExpression(raw), raw);
}

/** Parse and lower one condition text. */
export function lowerMovementCondition(raw: string): MovementCondition {
  return lowerCondition(parseExpression(raw), raw);
}

const AGG_FNS: Record<string, Extract<Expression, { type: 'aggregate' }>['fn']> = {
  FIRST: 'first', LAST: 'last', ONLY: 'only', COUNT: 'count', SUM: 'sum', AVG: 'avg',
  MIN: 'min', MAX: 'max', JOIN: 'join', COLLECT: 'collect', LLM_AGG: 'llm',
};

/**
 * The aggregates whose bare-walk argument takes a property written after the
 * call (`FIRST(orgs-[:co]->).url`). The old bridge found these by a
 * case-sensitive regex over the text, which refused `first(orgs-[:co]->).url`;
 * a function's name is the same name in any letter case (language version 3),
 * so the rule is read with the case folded. Accepting what was refused is
 * additive, so it holds under every version.
 */
const BARE_PATH_AGGREGATES = new Set([
  'FIRST', 'LAST', 'ONLY', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'JOIN', 'COLLECT', 'SORT', 'LLM_AGG',
]);

type ResourceField = Extract<Expression, { type: 'resource' }>['field'];
type ParentResultField = Extract<Expression, { type: 'parent_result' }>['field'];
const RESOURCE_FIELDS: Record<ResourceField, true> = {
  name: true, url: true, type: true, document_url: true, content: true, contentType: true,
};
const PARENT_RESULT_FIELDS: Record<ParentResultField, true> = { created: true, external_id: true };

/**
 * An `@resource.<field>` or `@parent.<field>` read: which record it reads, the
 * field written, and the fields that record has. Undefined for any other
 * `@` value (`@current_date`).
 */
export function specialRecordField(
  text: string,
): { record: 'resource' | 'parent'; field: string; known: readonly string[] } | undefined {
  const v = text.startsWith('@') ? text.slice(1) : text;
  if (v.startsWith('parent.')) return { record: 'parent', field: v.slice(7), known: Object.keys(PARENT_RESULT_FIELDS) };
  if (v.startsWith('resource.')) return { record: 'resource', field: v.slice(9), known: Object.keys(RESOURCE_FIELDS) };
  return undefined;
}
const RESOURCE_TERMINALS: ReadonlyArray<ResourceField> = ['name', 'url', 'type', 'document_url', 'content'];
const resourceTerminal = (name: string): ResourceField | undefined => RESOURCE_TERMINALS.find(f => f === name);
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
const RESOURCE_TYPES = new Set(['URL', 'EMAIL', 'WHATSAPP', 'FILE', 'TEXT']);
const NAMESPACE_SHAPED = /^[A-Z][A-Z0-9_]+$/;

type Segment =
  | { kind: 'member'; name: Name }
  | { kind: 'call'; args: CallArg[] }
  | { kind: 'hops'; hops: Hop[] };

class Lowering {
  constructor(private readonly source: string) {}

  // ── Conditions ──

  condition(expr: MExpr): MovementCondition {
    const conjuncts: MExpr[] = [];
    const split = (e: MExpr): void => {
      if (e.kind === 'binary' && e.op === 'and') {
        split(e.left);
        split(e.right);
      } else conjuncts.push(e);
    };
    split(expr);
    const lowered = conjuncts.map(c => this.conjunct(c));
    return lowered.length === 1 ? lowered[0] : { kind: 'and', conjuncts: lowered };
  }

  private conjunct(expr: MExpr): MovementCondition {
    if (expr.kind === 'is') {
      return {
        kind: 'isTest',
        // A name is spelled from the tree: a nested call's bound name stands
        // where the call's text is (checker/nested_calls.ts).
        subjectRaw: expr.subject.kind === 'name'
          ? (expr.subject.name.quoted ? `\`${expr.subject.name.text}\`` : expr.subject.name.text)
          : this.source.slice(expr.subject.at.start, expr.subject.at.end).trim(),
        type: this.isType(expr.type),
      };
    }
    if (containsIs(expr)) {
      throw new LoweringError(
        'IS type tests under OR/NOT (or nested in parentheses) are not yet supported — use IS only as a top-level AND conjunct',
      );
    }
    return { kind: 'expr', expr: this.lower(expr, TOP) };
  }

  /** An IS marker: `<graph>`, `<graph-[:position]->>` (one plain hop),
   *  or an ADDRESS kept as its raw hop text for `eventAddressOfHops`. */
  private isType(type: TypeExpr): Extract<MovementCondition, { kind: 'isTest' }>['type'] {
    if (type.kind !== 'named' || type.array || type.field !== undefined) {
      throw new LoweringError('IS expects a position type in angle brackets like <graph> or <graph-[:position]->>');
    }
    const graph = type.name.text;
    if (type.hops.length === 0) return { graph };
    const first = type.hops[0];
    const last = type.hops[type.hops.length - 1];
    if (first.direction !== 'out' || last.arrow !== '->') {
      throw new LoweringError('IS expects a position type in angle brackets like <graph> or <graph-[:position]->>');
    }
    const plain =
      type.hops.length === 1 &&
      first.alias === undefined &&
      first.where === undefined &&
      first.config === undefined &&
      first.orderBy === undefined &&
      first.limit === undefined &&
      (first.label.quoted || /^[A-Za-z_][A-Za-z0-9_]*$/.test(first.label.text));
    if (plain) return { graph, position: first.label.text };
    return { graph, hopsRaw: this.source.slice(first.at.start, last.at.end) };
  }

  // ── Expressions ──

  lower(expr: MExpr, ctx: Ctx): Expression {
    switch (expr.kind) {
      case 'literal':
        return { type: 'static', value: expr.value };
      case 'string':
        return this.string(expr);
      case 'name':
        return this.leaf(expr.name, ctx);
      case 'special': {
        const v = expr.text.slice(1);
        // The formula grammar carries these fields unchecked; mirrored as-is.
        // Language version 3 retires both reads (the checker's
        // MOV_PARENT_READ_RETIRED and MOV_RESOURCE_READ_RETIRED, read off
        // `specialRecordField`).
        if (v.startsWith('parent.')) return { type: 'parent_result', field: v.slice(7) as ParentResultField };
        if (v.startsWith('resource.')) return { type: 'resource', field: v.slice(9) as ResourceField };
        return { type: 'meta', key: v };
      }
      case 'paren':
        return this.lower(expr.expr, ctx);
      case 'list':
        return {
          type: 'list',
          elements: expr.elements.map((e): ListElement => {
            if (e.kind === 'spread') return { type: 'spread', expression: this.lower(e.expr, ctx) };
            if (e.kind === 'closure') throw new LoweringError(CLOSURE_POSITION_MESSAGE, 'MOV_EXPR_CLOSURE_POSITION', 'list');
            return this.lower(e, ctx);
          }),
        };
      case 'map':
        return {
          type: 'object',
          entries: expr.entries.map((e): ObjectMember =>
            isMapSpread(e)
              ? { type: 'spread', expression: this.lower(e.expr, ctx) }
              : e.value.kind === 'closure'
                ? (() => { throw new LoweringError(CLOSURE_POSITION_MESSAGE, 'MOV_EXPR_CLOSURE_POSITION', 'map'); })()
                : { key: e.key.text, value: this.lower(e.value, ctx) },
          ),
        };
      case 'member':
      case 'call':
      case 'path':
        return this.chain(expr, ctx);
      case 'index':
        throw new LoweringError('an index read `x[i]` is written AT(x, i)');
      case 'unary':
        return expr.op === 'not'
          ? { type: 'not', expression: this.lower(expr.operand, ctx) }
          : { type: 'negate', expression: this.lower(expr.operand, ctx) };
      case 'binary':
        return this.binary(expr, ctx);
      case 'exists':
        return { type: 'compare', op: 'exists', left: this.lower(expr.operand, ctx), right: { type: 'static', value: true } };
      case 'within': {
        const d = expr.duration;
        const value = d.quoted ? d.text : `${d.text.slice(0, -1)}${d.text.slice(-1).toLowerCase()}`;
        return { type: 'compare', op: 'within', left: this.lower(expr.operand, ctx), right: { type: 'static', value } };
      }
      case 'where':
        throw new LoweringError('WHERE filters a walk inside EXISTS(…) or a hop — it is not a value on its own');
      case 'is':
        throw new LoweringError('IS type tests are only recognised as top-level conjuncts of a condition');
      case 'if':
        return {
          type: 'conditional',
          condition: this.lower(expr.condition, ctx),
          then: this.lower(expr.then, ctx),
          else: expr.else ? this.lower(expr.else, ctx) : { type: 'static', value: '' },
        };
      case 'closure':
        throw new LoweringError(CLOSURE_POSITION_MESSAGE, 'MOV_EXPR_CLOSURE_POSITION');
      case 'type':
      case 'node':
      case 'graph':
      case 'declaration':
      case 'mapped':
      case 'lazy':
        throw new LoweringError(`a ${expr.kind} is not a value the shared expression tree can hold`);
      default:
        return neverAsAny(expr);
    }
  }

  /** A quoted string: a literal, or — with `${…}` — a concat whose holes are
   *  each a slot of their own: a hole in a hop WHERE reads a property, not an edge property. */
  private string(expr: Extract<MExpr, { kind: 'string' }>): Expression {
    if (expr.parts.every(p => typeof p === 'string')) return { type: 'static', value: expr.parts.join('') };
    return {
      type: 'concat',
      parts: expr.parts
        .filter(p => p !== '')
        .map(p => (typeof p === 'string' ? { type: 'static', value: p } : this.lower(p, TOP))),
    };
  }

  private leaf(name: Name, ctx: Ctx): Expression {
    this.refuseRetired(name);
    return { type: ctx.edgeProps ? 'edge_property' : 'property', propertyTypeId: name.text };
  }

  private refuseRetired(name: Name): void {
    if (!name.quoted && name.text === 'EXTRACT_VALUE') {
      throw new LoweringError(
        'EXTRACT_VALUE is retired (syntax amendment 4): extraction is a materialisation — declare the field in an `extract … { }` tree and read it as a plain property',
      );
    }
  }

  private binary(expr: Extract<MExpr, { kind: 'binary' }>, ctx: Ctx): Expression {
    return combine(expr.op, this.lower(expr.left, ctx), this.lower(expr.right, ctx));
  }

  // ── Chains: names, members, calls, walks ──
  //
  // The tree is left-nested, as postfix syntax is (`a.b.c` = member(member(a,
  // b), c)). The formula grammar's tree is right-nested from each root
  // (`traverse{a, expression: traverse{b, expression: c}}`), so a chain is
  // flattened to its segments and rebuilt from the left.

  private chain(expr: MExpr, ctx: Ctx): Expression {
    const segments: Segment[] = [];
    let head: MExpr | undefined = expr;
    for (;;) {
      if (head === undefined) break;
      if (head.kind === 'member') {
        segments.unshift({ kind: 'member', name: head.property });
        head = head.object;
      } else if (head.kind === 'call') {
        segments.unshift({ kind: 'call', args: head.args });
        head = head.callee;
      } else if (head.kind === 'path') {
        segments.unshift({ kind: 'hops', hops: head.hops });
        head = head.root;
      } else break;
    }
    if (head === undefined) {
      const [first, ...rest] = segments;
      if (first?.kind !== 'hops') throw new LoweringError('a walk starts at a name or at a hop');
      return this.traversal(undefined, first.hops, rest, ctx);
    }
    if (head.kind !== 'name') {
      throw new LoweringError(`'.', a call or a hop can only follow a name — not a ${head.kind}`);
    }
    return this.fromName(head.name, segments, ctx, false);
  }

  /** `scoped`: this name is the member of a dot-chain (`DATETIME.AT(…)`), so a
   *  call here is named inside its root and is none of the bare built-ins. */
  private fromName(name: Name, segments: Segment[], ctx: Ctx, scoped: boolean): Expression {
    const [first, ...rest] = segments;
    if (first === undefined) return this.leaf(name, ctx);
    switch (first.kind) {
      case 'call': {
        const { expression, consumed } = this.call(name, first.args, rest, ctx, scoped);
        if (rest.length > consumed) {
          throw new LoweringError(`Unexpected '.' after the call ${name.text}(…)`);
        }
        return expression;
      }
      case 'member':
        if (name.text.toLowerCase() === 'edge') {
          if (rest.length > 0) throw new LoweringError("edge.<property> reads one property of the walked edge");
          return { type: 'edge_property', propertyTypeId: first.name.text };
        }
        return this.foldNamespace({
          type: 'traverse',
          aliasRoot: name.text,
          steps: [],
          expression: this.fromName(first.name, rest, ctx, true),
        });
      case 'hops':
        return this.traversal(name.text, first.hops, rest, ctx);
      default:
        return neverAsAny(first);
    }
  }

  /** A walk, then the `.terminal` the formula grammar requires after it. */
  private traversal(aliasRoot: string | undefined, hops: Hop[], rest: Segment[], ctx: Ctx): Expression {
    const steps: TraversalStep[] = [];
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];
      const label = hop.label.text;
      if (label === '#extract') {
        throw new LoweringError(
          'The #extract meta-edge is retired (syntax amendment 4): extraction is not a traversal — use an `extract … { }` materialisation and traverse its result graph',
        );
      }
      if (isTransformHop(hop)) {
        const config = hop.config ? this.metaConfig(hop.config, ctx) : undefined;
        const step: MetaEdgeStep = {
          type: 'meta_edge',
          metaEdge: 'transform',
          ...(hop.alias ? { alias: hop.alias.text } : {}),
          ...(config ? { config } : {}),
        };
        steps.push(step);
        continue;
      }
      const ending = endingHop(hop);
      if (ending !== undefined) {
        if (i !== hops.length - 1) throw new LoweringError(`a hop cannot follow -[:${label}]->`);
        const inner = ending === 'linked' ? this.linked(hop, rest) : this.resources(hop, rest, ctx);
        // The formula grammar drops the root of a walk that ends in a
        // resource or linked hop — reproduced, not endorsed. Language version
        // 3 refuses a resource walk that would lose something here (the
        // checker's MOV_RESOURCE_WALK_UNREAD), and every linked hop
        // (MOV_LINKED_HOP_RETIRED).
        return steps.length > 0 ? { type: 'traverse', steps, expression: inner } : inner;
      }
      steps.push(this.edgeStep(hop, ctx));
    }
    const [terminal, ...after] = rest;
    let expression: Expression;
    if (terminal === undefined) {
      // A bare walk is the records it lands on, wherever a value goes.
      const last = hops[hops.length - 1];
      if (last.direction !== 'out' || last.arrow !== '->') {
        throw new LoweringError("a walk written as a value ends in ']->', or reads a '.property' after it");
      }
      expression = this.leaf({ text: POSITION_SENTINEL, quoted: true, at: last.at }, ctx);
    } else {
      if (terminal.kind !== 'member') throw new LoweringError("Expected '.' after the walk");
      expression = this.fromName(terminal.name, after, ctx, false);
    }
    return { type: 'traverse', ...(aliasRoot !== undefined ? { aliasRoot } : {}), steps, expression };
  }

  private edgeStep(hop: Hop, ctx: Ctx): EdgeStep {
    if (hop.direction === 'in' && hop.alias !== undefined) {
      throw new LoweringError('an incoming hop takes no alias (`<-[:edge]-`)');
    }
    const step: EdgeStep = {
      type: 'edge',
      edgeTypeId: hop.label.text,
      direction: hop.direction === 'in' ? 'incoming' : 'outgoing',
      ...(hop.alias ? { alias: hop.alias.text } : {}),
    };
    if (hop.orderBy !== undefined || hop.limit !== undefined) {
      step.cardinality = {
        mode: hop.limit !== undefined ? 'n' : 'all',
        ...(hop.limit !== undefined ? { limit: hop.limit } : {}),
        ...(hop.orderBy !== undefined
          ? { orderBy: this.lower(hop.orderBy.key, ctx), orderDirection: hop.orderBy.direction ?? 'asc' }
          : {}),
      };
    }
    if (hop.where !== undefined) step.expressionFilter = this.lower(hop.where, { edgeProps: true });
    // A config `{ … }` on a plain edge hop is dropped by the formula grammar;
    // language version 3 refuses it (the checker's MOV_HOP_CONFIG_UNREAD).
    return step;
  }

  private resources(hop: Hop, rest: Segment[], ctx: Ctx): Expression {
    const colon = hop.label.text.indexOf(':');
    const typeVal = colon === -1 ? undefined : hop.label.text.slice(colon + 1).trim().toUpperCase();
    const shorthand: Expression | undefined =
      typeVal !== undefined && RESOURCE_TYPES.has(typeVal)
        ? { type: 'compare', op: 'eq', left: { type: 'resource', field: 'type' }, right: { type: 'static', value: typeVal } }
        : undefined;
    const where = hop.where !== undefined ? this.resourcePredicate(hop.where) : undefined;
    const expressionFilter: Expression | undefined =
      shorthand && where ? { type: 'logical', op: 'and', operands: [shorthand, where] } : (shorthand ?? where);
    const [terminal, ...after] = rest;
    if (terminal?.kind !== 'member') throw new LoweringError("Expected '.' after the resource hop");
    let expression: Expression;
    const field = resourceTerminal(terminal.name.text);
    if (field !== undefined) {
      if (after.length > 0) throw new LoweringError(`Unexpected '.' after the resource field ${terminal.name.text}`);
      expression = { type: 'resource', field };
    } else {
      expression = this.fromName(terminal.name, after, ctx, false);
    }
    return { type: 'resource_traverse', ...(expressionFilter ? { expressionFilter } : {}), expression };
  }

  /** A `_resources` WHERE reads resource fields only. */
  private resourcePredicate(expr: MExpr): Expression {
    switch (expr.kind) {
      case 'name': {
        const field = RESOURCE_WHERE_FIELDS[expr.name.text.toLowerCase()];
        if (field === undefined) throw new LoweringError(`Unknown property: ${expr.name.text}`);
        return { type: 'resource', field };
      }
      case 'literal':
      case 'string':
      case 'special':
        return this.lower(expr, TOP);
      case 'paren':
        return this.resourcePredicate(expr.expr);
      case 'binary': {
        if (expr.op === '+' || expr.op === '-' || expr.op === '*' || expr.op === '/' || expr.op === '%') {
          throw new LoweringError("a _resources WHERE compares resource fields — 'arithmetic' is not supported here");
        }
        return combine(expr.op, this.resourcePredicate(expr.left), this.resourcePredicate(expr.right));
      }
      case 'unary':
        return expr.op === 'not'
          ? { type: 'not', expression: this.resourcePredicate(expr.operand) }
          : { type: 'negate', expression: this.resourcePredicate(expr.operand) };
      case 'list':
        return {
          type: 'list',
          elements: expr.elements.map((e): ListElement =>
            e.kind === 'spread' ? { type: 'spread', expression: this.resourcePredicate(e.expr) } : this.resourcePredicate(e),
          ),
        };
      case 'exists':
        return { type: 'compare', op: 'exists', left: this.resourcePredicate(expr.operand), right: { type: 'static', value: true } };
      default:
        throw new LoweringError(`a _resources WHERE compares resource fields — '${expr.kind}' is not supported here`);
    }
  }

  /** `-[#linked WHERE type = "ATTIO"]->.field` — legacy. The adapter is read
   *  off the WHERE's SOURCE TEXT by the formula grammar's regex, so this
   *  needs the text: the one rule here a tree cannot express. */
  private linked(hop: Hop, rest: Segment[]): Expression {
    const whereText = hop.where ? this.source.slice(hop.where.at.start, hop.where.at.end) : '';
    const match = whereText.match(/type\s*=\s*"([^"]*)"/i)
      ?? whereText.match(/type\s*=\s*'([^']*)'/i)
      ?? whereText.match(/type\s*=\s*(\S+)/i);
    const adapter = match?.[1]?.toUpperCase() ?? '';
    const [terminal, ...after] = rest;
    if (terminal?.kind !== 'member' || after.length > 0) throw new LoweringError('Expected field name after -[#linked...]->.');
    return { type: 'linked_object', adapter, field: terminal.name.text };
  }

  private metaConfig(config: Extract<MExpr, { kind: 'map' }>, ctx: Ctx): MetaEdgeStep['config'] | undefined {
    const cfg: NonNullable<MetaEdgeStep['config']> = {};
    for (const entry of config.entries) {
      if (isMapSpread(entry)) throw new LoweringError("A hop's settings are written out one by one — a spread ('...') is not accepted here");
      const key = entry.key.text;
      if (key === 'enrich_with') {
        if (entry.value.kind !== 'list') throw new LoweringError('enrich_with: expects a list literal');
        cfg.enrichWith = entry.value.elements.map((e): EnrichWithEntry => {
          if (e.kind !== 'map') throw new LoweringError('enrich_with: each entry must be an object literal');
          const pairs = e.entries.filter((x): x is MapEntry => !isMapSpread(x));
          const transform = pairs.find(x => x.key.text === 'transform');
          const argument = pairs.find(x => x.key.text === 'argument');
          if (!transform || !argument || e.entries.length !== 2) {
            throw new LoweringError('enrich_with entry: requires exactly "transform" and "argument"');
          }
          return { transform: this.lower(transform.value, ctx), argument: this.lower(argument.value, ctx) };
        });
        continue;
      }
      const value = this.lower(entry.value, ctx);
      if (key === 'description') cfg.description = value;
      else if (key === 'data') {
        if (value.type !== 'list') throw new LoweringError('data: expects a list literal [expr, expr, ...]');
        cfg.data = value.elements.map(e => {
          if (e.type === 'spread') throw new LoweringError("data: lists its values one by one — a spread ('...') is not accepted here");
          return e;
        });
      } else if (key === 'plugin') cfg.plugin = value;
      else {
        cfg.extra = cfg.extra ?? {};
        cfg.extra[key] = value;
      }
    }
    return Object.keys(cfg).length === 0 ? undefined : cfg;
  }

  // ── Calls: where a name becomes a built-in ──

  /** `consumed`: how many of the segments AFTER the call it absorbed (the
   *  aggregate's postfix property). */
  private call(
    name: Name,
    args: CallArg[],
    after: Segment[],
    ctx: Ctx,
    scoped: boolean,
  ): { expression: Expression; consumed: number } {
    this.refuseRetired(name);
    const named = args.find(a => a.name !== undefined);
    if (named) throw new LoweringError(`a named argument (${named.name?.text}: …) is a movement call's, not an expression's`);
    const upper = name.text.toUpperCase();

    // `EXISTS(…)`, in any letter case, is the quantifier; resolved by name
    // like any other call, unless scoped or quoted.
    if (!name.quoted && upper === 'EXISTS' && !scoped) return { expression: this.exists(args), consumed: 0 };

    // `AGG(<bare walk>).prop` reads a property of the aggregated landing: the
    // property moves inside the walk (the first url is the url of the first).
    let values = args.map(a => a.value);
    let consumed = 0;
    const next = after[0];
    if (
      !name.quoted &&
      BARE_PATH_AGGREGATES.has(upper) &&
      values.length > 0 &&
      this.isBareWalk(values[0]) &&
      next?.kind === 'member'
    ) {
      values = [this.member(values[0], next.name), ...values.slice(1)];
      consumed = 1;
    }

    if (scoped) {
      const fn: Expression = { type: 'function', fn: upper.toLowerCase(), args: values.map(v => this.lower(v, ctx)) };
      validateBuiltinCallShape(fn);
      return { expression: fn, consumed };
    }
    if (upper === 'SORT') return { expression: this.sort(values, ctx), consumed };
    const lowered = values.map(v => this.lower(v, ctx));
    return { expression: this.builtin(upper, lowered), consumed };
  }

  private builtin(upper: string, args: Expression[]): Expression {
    const agg = AGG_FNS[upper];
    if (agg !== undefined) {
      const sep = args[1];
      return {
        type: 'aggregate',
        fn: agg,
        expression: args[0] ?? { type: 'static', value: '' },
        ...(sep?.type === 'static' && typeof sep.value === 'string' ? { separator: sep.value } : {}),
      };
    }
    switch (upper) {
      case 'AI': {
        if (args.length > 2) throw new LoweringError(`AI takes at most 2 arguments (prompt, tier), got ${args.length}`);
        let tier: string | undefined;
        if (args.length === 2) {
          const t = args[1];
          if (t.type !== 'static' || typeof t.value !== 'string') {
            throw new LoweringError(
              `AI's second argument is the tier — ${AI_TIERS.map(x => `"${x}"`).join(', ')} — written down in place`,
            );
          }
          tier = t.value;
        }
        const prompt = args[0];
        if (prompt?.type === 'static' && typeof prompt.value === 'string') {
          return { type: 'llm', prompt: prompt.value, ...(tier !== undefined ? { tier } : {}) };
        }
        return { type: 'llm', prompt: '', promptExpression: prompt, ...(tier !== undefined ? { tier } : {}) };
      }
      case 'CONCAT':
        return { type: 'concat', parts: args };
      case 'KG_EXISTS':
      case 'KG_VALUE': {
        const q = args[0];
        return {
          type: upper === 'KG_EXISTS' ? 'kg_exists' : 'kg_value',
          query: q && q.type === 'static' && typeof q.value === 'string' ? q.value : '',
          params: args.slice(1),
        };
      }
      case 'AT':
        if (args.length !== 2) throw new LoweringError(`AT takes exactly 2 arguments (AT(list, index)), got ${args.length}`);
        return { type: 'at', expression: args[0], index: args[1] };
      default: {
        const fn: Extract<Expression, { type: 'function' }> = { type: 'function', fn: upper.toLowerCase(), args };
        validateBuiltinCallShape(fn);
        return fn;
      }
    }
  }

  /** SORT(collection[, key][, ASC|DESC]) — a bare ASC/DESC in the LAST slot
   *  is the direction, not a field of that name. */
  private sort(values: MExpr[], ctx: Ctx): Expression {
    if (values.length === 0) throw new LoweringError('SORT orders a collection');
    const [source, ...rest] = values;
    let direction: 'asc' | 'desc' | undefined;
    const last = rest[rest.length - 1];
    if (last?.kind === 'name' && /^(ASC|DESC)$/i.test(last.name.text)) {
      direction = last.name.text.toUpperCase() === 'DESC' ? 'desc' : 'asc';
      rest.pop();
    }
    if (rest.length > 1) throw new LoweringError('SORT takes a collection, a key and a direction');
    return {
      type: 'aggregate',
      fn: 'sort',
      expression: this.lower(source, ctx),
      ...(rest[0] !== undefined ? { orderBy: this.lower(rest[0], ctx) } : {}),
      orderDirection: direction ?? 'asc',
    };
  }

  /**
   * `EXISTS(walk [WHERE predicate])` — true when the walk lands anywhere (that
   * the predicate holds). The interior is read as a slot of its own, whatever
   * surrounds the call, so a name in its predicate is never an edge property
   * of an enclosing hop.
   */
  private exists(args: CallArg[]): Expression {
    if (args.length !== 1) throw new LoweringError('EXISTS(…) expects a traversal path');
    let walk = args[0].value;
    let predicate: MExpr | undefined;
    if (walk.kind === 'where') {
      predicate = walk.predicate;
      walk = walk.source;
    }
    const steps = this.walkSteps(walk);
    if (steps !== undefined) {
      const exists: Expression = {
        type: 'exists',
        steps: steps.steps,
        ...(predicate !== undefined ? { where: this.lower(predicate, TOP) } : {}),
      };
      return steps.root !== undefined
        ? this.foldNamespace({ type: 'traverse', aliasRoot: steps.root, steps: [], expression: exists })
        : exists;
    }
    // `EXISTS(x.Field)` asks a VALUE's presence: `x.Field != null`.
    if (predicate !== undefined) throw new LoweringError('EXISTS(… WHERE …) needs a traversal path — a value has nothing to filter');
    if (walk.kind === 'member' && walk.object.kind === 'name' && walk.object.name.text.toLowerCase() !== 'edge') {
      const read = this.lower(walk, TOP);
      return { type: 'compare', op: 'neq', left: read, right: { type: 'static', value: null } };
    }
    throw new LoweringError(
      'EXISTS(…) expects a traversal path like -[:edge]-> or alias-[:edge]->, or a property read like x.`Field`',
    );
  }

  /** A walk's steps and root, when `walk` is a name or a bare walk from one. */
  private walkSteps(walk: MExpr): { root?: string; steps: TraversalStep[] } | undefined {
    if (walk.kind === 'name') return { root: walk.name.text, steps: [] };
    if (walk.kind !== 'path' || (walk.root !== undefined && walk.root.kind !== 'name')) return undefined;
    const probe = this.lower(this.member(walk, { text: '__movement_exists_probe__', quoted: true, at: walk.at }), TOP);
    if (probe.type !== 'traverse' || probe.expression.type !== 'property') return undefined;
    return { ...(probe.aliasRoot !== undefined ? { root: probe.aliasRoot } : {}), steps: probe.steps };
  }

  // ── Bare walks ──

  /** A walk with nothing read off its end, from a plain root, ending `]->`. */
  private isBareWalk(expr: MExpr): expr is Extract<MExpr, { kind: 'path' }> {
    if (expr.kind !== 'path') return false;
    if (expr.root !== undefined && expr.root.kind !== 'name') return false;
    const last = expr.hops[expr.hops.length - 1];
    return last !== undefined && last.direction === 'out' && last.arrow === '->';
  }

  private member(object: MExpr, property: Name): MExpr {
    return { kind: 'member', object, property, at: object.at };
  }

  // ── Namespaced stdlib calls ──

  /** `CURRENCY.GET_NUMBER_FROM_FIGURE(…)` → the family's function; an unknown
   *  member or an unknown ALL-CAPS namespace in call position is refused. */
  private foldNamespace(expr: Extract<Expression, { type: 'traverse' }>): Expression {
    if (expr.aliasRoot === undefined || expr.steps.length > 0) return expr;
    const family = stdlibFamily(expr.aliasRoot);
    const callName = callTerminalName(expr.expression);
    if (family) {
      const inventory = `${family.namespace} provides: ${describeStdlibFamily(family)}`;
      if (callName === undefined) {
        throw new LoweringError(`${family.namespace} is a function family, not a position — call one of its functions. ${inventory}`);
      }
      const member = family.functions.find(fn => fn.name === callName);
      if (!member || expr.expression.type !== 'function') {
        throw new LoweringError(`${family.namespace} has no function ${callName}() — ${inventory}`);
      }
      const args = expr.expression.args;
      if (args.length < member.arity.min || args.length > member.arity.max) {
        const { min, max } = member.arity;
        const expected = min === max ? `${min}` : `${min}–${max}`;
        throw new LoweringError(
          `${member.signature} takes ${expected} argument${max === 1 ? '' : 's'}, got ${args.length}`,
        );
      }
      return { type: 'function', fn: member.id, args };
    }
    if (callName !== undefined && NAMESPACE_SHAPED.test(expr.aliasRoot)) {
      throw new LoweringError(
        `Unknown function namespace '${expr.aliasRoot}' — the namespaced families are: ${listStdlibNamespaces().join(', ')}`,
      );
    }
    return expr;
  }
}

/**
 * The meta hops a walk can only END in: `-[:_resources]->` (`#resources` is
 * its legacy spelling, `_resources:TEXT` its type shorthand) and the legacy
 * `-[#linked …]->`. Each lowers to a node of its own that keeps neither the
 * walk's root nor, as a block head's probe, the hops before it.
 */
export function endingHop(hop: Hop): 'resources' | 'linked' | undefined {
  const label = hop.label.text;
  const base = label.split(/[:\s]/, 1)[0];
  if (base === '#linked' || label === '#linked') return 'linked';
  if (base === '_resources' || base === '#resources') return 'resources';
  return undefined;
}

/** `-[t:#transform { plugin: … }]->` — the one meta hop whose `{ … }`
 *  settings are read. On any other hop the lowering has nowhere to put them.
 *  Language version 3 retires the hop (the checker's
 *  MOV_TRANSFORM_HOP_RETIRED), and with it every hop's settings. */
export function isTransformHop(hop: Hop): boolean {
  return hop.label.text === '#transform';
}

function combine(op: BinaryOp, left: Expression, right: Expression): Expression {
  switch (op) {
    case 'or':
    case 'and':
      // The formula grammar folds a left operand that is already the same
      // connective — parenthesised or not — into one flat list.
      return left.type === 'logical' && left.op === op
        ? { type: 'logical', op, operands: [...left.operands, right] }
        : { type: 'logical', op, operands: [left, right] };
    case '==':
      return { type: 'compare', op: 'eq', left, right };
    case '!=':
      return { type: 'compare', op: 'neq', left, right };
    case '<':
      return { type: 'compare', op: 'lt', left, right };
    case '<=':
      return { type: 'compare', op: 'lte', left, right };
    case '>':
      return { type: 'compare', op: 'gt', left, right };
    case '>=':
      return { type: 'compare', op: 'gte', left, right };
    case 'contains':
      return { type: 'compare', op: 'contains', left, right };
    case 'in':
      return { type: 'compare', op: 'in', left, right };
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
      return { type: 'arithmetic', op, left, right };
    default:
      return neverAsAny(op);
  }
}

function callTerminalName(expr: Expression): string | undefined {
  switch (expr.type) {
    case 'function':
      return expr.fn.toUpperCase();
    case 'aggregate':
      return expr.fn === 'llm' ? 'LLM_AGG' : expr.fn.toUpperCase();
    case 'llm':
      return 'AI';
    case 'concat':
      return 'CONCAT';
    case 'kg_exists':
      return 'KG_EXISTS';
    case 'kg_value':
      return 'KG_VALUE';
    default:
      return undefined;
  }
}

function containsIs(expr: MExpr): boolean {
  let found = false;
  const visit = (e: MExpr | undefined): void => {
    if (e === undefined || found) return;
    if (e.kind === 'is') {
      found = true;
      return;
    }
    for (const child of children(e)) visit(child);
  };
  visit(expr);
  return found;
}

/** The sub-expressions of a node, for walkers with nothing to say about the node itself. */
export function children(e: MExpr): MExpr[] {
  switch (e.kind) {
    case 'literal':
    case 'name':
    case 'special':
    case 'type':
    case 'declaration':
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
    case 'call':
      return [e.callee, ...e.args.map(a => a.value)];
    case 'path':
      return [
        ...(e.root ? [e.root] : []),
        ...e.hops.flatMap(h => [
          ...(h.where ? [h.where] : []),
          ...(h.config ? [h.config] : []),
          ...(h.orderBy ? [h.orderBy.key] : []),
        ]),
      ];
    case 'unary':
      return [e.operand];
    case 'binary':
      return [e.left, e.right];
    case 'exists':
    case 'within':
      return [e.operand];
    case 'where':
      return [e.source, e.predicate];
    case 'is':
      return [e.subject];
    case 'if':
      return [e.condition, e.then, ...(e.else ? [e.else] : [])];
    case 'closure':
      return e.body.kind === 'expr' ? [e.body.expr] : [];
    case 'node':
      return e.entries.flatMap(x => (x.value.kind === 'declaredEdge' ? [] : [x.value]));
    case 'graph':
      return [...e.entries.flatMap(x => (x.value.kind === 'declaredEdge' ? [] : [x.value])), ...e.spreads];
    case 'mapped':
      return [e.source, e.body];
    case 'lazy':
      return [e.walk];
    default:
      return neverAsAny(e);
  }
}
