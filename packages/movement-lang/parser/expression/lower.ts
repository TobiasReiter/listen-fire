// Lowering: the movement expression tree (./tree.ts) → the shared `Expression`
// (packages/shared/expression/types.ts) that the checker, the engine, the web
// app's formula input and every adapter's filter pushdown read. This is where
// a NAME first means something: `COUNT` becomes an aggregate, `AI` an llm
// node, `EXISTS` a quantifier, `CURRENCY.PARSE` a stdlib function.
//
// The rules are the Rust lowering's (crates/movement-parser/src/lowering),
// called through the WASM module: this file is its wrapper. The tree is JSON
// already (the Rust parser's output, or a rewriting of it), so it crosses the
// boundary as it is; the source goes with it because a few rules read the
// text the tree's offsets index.
//
// `specialRecordField`, `endingHop`, `isTransformHop` and `children` stay
// TypeScript: they are pure walks the checker runs over TypeScript tree
// objects, and calling across the boundary for each would cost more than the
// walk.

import type { Expression } from '@listen-fire/shared/expression/types';
import { BridgeError } from '../../expression/error';
import { neverAsAny } from '../../never';
import { callLowering } from '../../wasm/loader';
import { isMapSpread, type Hop, type MExpr } from './tree';
import { parseExpression } from './parse_expression';

/** A tree the lowering has no reading for. A built-in call's static shape
 *  (FILE's artifact type, an options map's keys) is refused as a plain
 *  `BridgeError` instead, as it always was. */
export class LoweringError extends BridgeError {
  constructor(message: string, code?: string) {
    super(message, undefined, code);
    this.name = 'LoweringError';
  }
}

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

/** Lower one expression; `source` is the text `tree` was parsed from.
 *  `closures`: the offsets of the list element closures the slot's statement
 *  parse collected (`ExprSlot.closures`, language version 5), each read as the
 *  name `slotClosureName(at)`. */
export function lowerExpression(tree: MExpr, source: string, closures?: ReadonlySet<number>): Expression {
  const { ok, json } = callLowering('lower_expression', JSON.stringify(tree), source, [...(closures ?? [])]);
  if (!ok) throw loweringRefusal(json);
  if (!isLoweredExpression(json)) throw malformedLowering('expression', json);
  return json;
}

/** Lower one `if` condition into its top-level
 *  `AND` conjuncts, each an `IS` type guard or an expression. */
export function lowerCondition(tree: MExpr, source: string, closures?: ReadonlySet<number>): MovementCondition {
  const { ok, json } = callLowering('lower_condition', JSON.stringify(tree), source, [...(closures ?? [])]);
  if (!ok) throw loweringRefusal(json);
  if (!isLoweredCondition(json)) throw malformedLowering('condition', json);
  return json;
}

/** Parse and lower one expression text. */
export function lowerMovementExpression(raw: string): Expression {
  return lowerExpression(parseExpression(raw), raw);
}

/** Parse and lower one condition text. */
export function lowerMovementCondition(raw: string): MovementCondition {
  return lowerCondition(parseExpression(raw), raw);
}

/** The refusal in its class: a built-in call's static shape is a
 *  `BridgeError`, everything else a `LoweringError`; a tree the lowering
 *  could not read is the caller's fault, not the author's. */
function loweringRefusal(json: unknown): Error {
  const error = isRecord(json) ? json.error : undefined;
  if (!isRecord(error) || typeof error.message !== 'string') throw malformedLowering('refusal', json);
  const code = typeof error.code === 'string' ? error.code : undefined;
  switch (error.class) {
    case undefined:
      return new LoweringError(error.message, code);
    case 'BridgeError':
      return new BridgeError(error.message, undefined, code);
    case 'MalformedTree':
      return new Error(error.message);
    default:
      throw malformedLowering('refusal', json);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Shallow on purpose, as the parser's tree guards are (parser/rust_parser.ts):
// they tell the envelopes apart; beneath the root the value is the Rust
// lowering's own output, whose shape the pinned fixture holds
// (__test__/lowering_regression).

function isLoweredExpression(value: unknown): value is Expression {
  return isRecord(value) && typeof value.type === 'string';
}

function isLoweredCondition(value: unknown): value is MovementCondition {
  return isRecord(value) && typeof value.kind === 'string';
}

function malformedLowering(what: string, json: unknown): Error {
  return new Error(`the movement lowering returned a malformed ${what}: ${JSON.stringify(json)?.slice(0, 200)}`);
}

type ResourceField = Extract<Expression, { type: 'resource' }>['field'];
type ParentResultField = Extract<Expression, { type: 'parent_result' }>['field'];
// What `@resource.…` and `@parent.…` can read; the lowering carries the
// field unchecked, and the checker reads these.
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
