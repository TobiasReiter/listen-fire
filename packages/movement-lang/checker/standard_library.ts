// The STANDARD LIBRARY scope — the outermost scope a call is resolved in.
//
// A call's callee is looked up as any name is: the scopes the program declares
// (locals, parameters, the file and its imports), then this one. Every
// built-in the language ships is listed here with its signature (what each
// parameter takes, what the call gives back) and its declared effect row, so
// the checker types a built-in call the way it types a movement call and an
// unknown name is an unknown name rather than a call nobody checks.
// Plan: plans/functional-extract-2026-10-02/2_one_grammar.md, step 3.
//
// The entries are DERIVED from the registries that already define the
// built-ins (the namespaced families in ../expression/stdlib.ts, the flat set
// the engine evaluates, the formula grammar's special forms), so a built-in
// added there without a signature here fails to compile rather than going
// unchecked.
//
// Function names are case-insensitive from language version 3: `UPPER`,
// `upper` and `Upper` are one function. Lookup folds case; display uses the
// spelling the language documents (upper case).

import type { CollectionOp } from '../parser/ast';
import { FORMULA_SPECIAL_FUNCTIONS } from '@listen-fire/shared/expression/formula';
import {
  INTERPRETED_FUNCTION_IDS,
  STDLIB_FAMILIES,
  param as p,
  type BuiltinParam,
  type StdlibFunctionSpec,
} from '../expression/stdlib';
import type { FieldType } from './catalog';
import type { DeclaredEffectRow } from './effects';
import { since, type LanguageVersion } from '../language_version';

/**
 * What a call gives back: a type the signature states, or `derived` — the
 * type follows from the arguments (`COALESCE`, `FIRST`, `AT`, `MAP`), and the
 * typing walk works it out where it types the call.
 */
export type BuiltinReturn = FieldType | 'derived';

/**
 * How a call of the built-in is read once it is resolved:
 *
 *   - `value`      — an expression: the call computes a value from its arguments;
 *   - `collection` — iteration over a collection with a function (`MAP` and its siblings);
 *   - `members`    — a closed type's values (`MEMBERS`);
 *   - `extract`    — an extraction call (`extract`, `extractOne`), read by its own grammar.
 *
 * Only a `value` built-in can sit inside another expression; the others take a
 * function or a type, which an expression cannot hold yet.
 */
export type BuiltinForm =
  | { kind: 'value' }
  | { kind: 'collection'; op: CollectionOp }
  | { kind: 'members' }
  | { kind: 'extract' };

export interface Builtin {
  /** The documented spelling: `UPPER`, `CURRENCY.FORMAT_FIGURE`. */
  name: string;
  params: readonly BuiltinParam[];
  returns: BuiltinReturn;
  /** What calling it may do, beyond what its arguments do. */
  effects: DeclaredEffectRow;
  form: BuiltinForm;
  /** One line for listings. */
  summary: string;
}

const PURE: DeclaredEffectRow = {};
const VALUE: BuiltinForm = { kind: 'value' };

function builtin(
  name: string,
  params: readonly BuiltinParam[],
  returns: BuiltinReturn,
  summary: string,
  extra: { effects?: DeclaredEffectRow; form?: BuiltinForm } = {},
): Builtin {
  return { name, params, returns, summary, effects: extra.effects ?? PURE, form: extra.form ?? VALUE };
}

/**
 * The flat built-ins the engine evaluates directly, keyed by the lower-case id
 * the grammar lowers them to. A `Record` over the registry's own ids, so a new
 * interpreted function without a signature is a compile error.
 */
type InterpretedId = (typeof INTERPRETED_FUNCTION_IDS)[number];
const INTERPRETED: Record<InterpretedId, Builtin> = {
  isnull: builtin('ISNULL', [p('value', 'any')], 'boolean', 'whether a value is absent'),
  coalesce: builtin('COALESCE', [p('values', 'any', { rest: true })], 'derived', 'the first argument that is present'),
  trim: builtin('TRIM', [p('text', 'text')], 'text', 'text without its leading and trailing whitespace'),
  lower: builtin('LOWER', [p('text', 'text')], 'text', 'text in lower case'),
  upper: builtin('UPPER', [p('text', 'text')], 'text', 'text in upper case'),
  length: builtin('LENGTH', [p('value', 'textOrList')], 'number', "a text's characters, or a list's members, counted"),
  abs: builtin('ABS', [p('number', 'number')], 'number', 'a number without its sign'),
  round: builtin('ROUND', [p('number', 'number'), p('places', 'number', { optional: true })], 'number', 'a number rounded to a whole one'),
  floor: builtin('FLOOR', [p('number', 'number')], 'number', 'a number rounded down'),
  ceil: builtin('CEIL', [p('number', 'number')], 'number', 'a number rounded up'),
  tostring: builtin('TOSTRING', [p('value', 'scalar')], 'text', 'a value written as text'),
  tonumber: builtin('TONUMBER', [p('value', 'scalar')], 'number', 'a value read as a number'),
  multi: builtin('MULTI', [p('values', 'any', { rest: true })], 'derived', 'the present arguments as one list, lists flattened one level'),
  split: builtin('SPLIT', [p('text', 'text'), p('separator', 'text', { optional: true })], { kind: 'list', of: 'text' }, 'text cut into its trimmed, non-empty parts'),
  date: builtin('DATE', [p('value', 'scalar')], 'date', 'any readable date or timestamp, as a date'),
  datetime: builtin('DATETIME', [p('value', 'scalar')], 'datetime', 'any readable date or timestamp, as an instant'),
  number: builtin('NUMBER', [p('value', 'scalar')], 'number', 'a value read as a number'),
};

/** The formula grammar's special forms — each lowered to its own expression
 *  kind rather than a generic function call. Keyed by the grammar's own list,
 *  so a form it learns without a signature here is a compile error. */
const AI_ROW: DeclaredEffectRow = { ai: true };
const SPECIAL_FORMS: Record<string, Builtin> = {
  FIRST: builtin('FIRST', [p('collection', 'any')], 'derived', 'the first member, absent when there is none'),
  LAST: builtin('LAST', [p('collection', 'any')], 'derived', 'the last member, absent when there is none'),
  ONLY: builtin('ONLY', [p('collection', 'any')], 'derived', 'the one member, absent when there is none; more than one fails the run'),
  COUNT: builtin('COUNT', [p('collection', 'any')], 'number', 'how many members'),
  SUM: builtin('SUM', [p('collection', 'any')], 'number', 'the members added up'),
  AVG: builtin('AVG', [p('collection', 'any')], 'number', 'the members averaged'),
  MIN: builtin('MIN', [p('collection', 'any')], 'derived', 'the smallest member'),
  MAX: builtin('MAX', [p('collection', 'any')], 'derived', 'the largest member'),
  JOIN: builtin('JOIN', [p('collection', 'any'), p('separator', 'text', { optional: true })], 'text', 'the members joined into text'),
  COLLECT: builtin('COLLECT', [p('collection', 'any')], 'derived', 'the members as a list'),
  LLM_AGG: builtin('LLM_AGG', [p('collection', 'any'), p('instruction', 'text', { optional: true })], 'derived', 'the members summarised by a model', { effects: AI_ROW }),
  AI: builtin('AI', [p('prompt', 'text'), p('tier', 'text', { optional: true })], 'derived', "a model's answer to a prompt", { effects: AI_ROW }),
  CONCAT: builtin('CONCAT', [p('parts', 'scalar', { rest: true })], 'text', 'the arguments joined into one text'),
  KG_EXISTS: builtin('KG_EXISTS', [p('query', 'text'), p('params', 'any', { rest: true })], 'boolean', 'RETIRED — whether a knowledge-graph query finds anything', { effects: { reads: ['the knowledge graph'] } }),
  KG_VALUE: builtin('KG_VALUE', [p('query', 'text'), p('params', 'any', { rest: true })], 'derived', 'RETIRED — a value a knowledge-graph query reads', { effects: { reads: ['the knowledge graph'] } }),
  EXTRACT_VALUE: builtin('EXTRACT_VALUE', [p('values', 'any', { rest: true })], 'derived', 'RETIRED — a scalar extracted by a model', { effects: AI_ROW }),
  AT: builtin('AT', [p('collection', 'any'), p('index', 'any')], 'derived', "a list's member by position, or a dict's by key"),
  SORT: builtin('SORT', [p('collection', 'any'), p('key', 'any', { optional: true }), p('direction', 'any', { optional: true })], 'derived', 'the members in order'),
};

/** The flat built-ins with a contract of their own, validated where they
 *  lower (FILE's artifact type, CHUNKS's options) and typed by the walk. */
const FLAT_WITH_CONTRACTS: Builtin[] = [
  builtin('FILE', [p('content', 'any'), p('type', 'text')], 'file', 'content rendered as a file — FILE(content, "pdf" | "text")'),
  builtin('READ', [p('file', 'file')], 'text', "a file's text", { effects: { reads: ['files'] } }),
  builtin('CHUNKS', [p('text', 'text'), p('options', 'options')], 'derived', 'text cut into pieces — CHUNKS(text, { size | entities, overlap })'),
  // A word of the expression grammar as well as a call: `EXISTS(walk)` and
  // `x EXISTS` are read by the grammar itself, never resolved as a call.
  builtin('EXISTS', [p('walk', 'any')], 'boolean', 'whether a walk lands anywhere'),
];

const COLLECTION_OPS: Builtin[] = [
  builtin('MAP', [p('collection', 'list'), p('settings', 'options', { optional: true }), p('function', 'function')], 'derived', 'each member through a function', { form: { kind: 'collection', op: 'map' } }),
  builtin('FILTER', [p('collection', 'list'), p('settings', 'options', { optional: true }), p('function', 'function')], 'derived', 'the members a function keeps', { form: { kind: 'collection', op: 'filter' } }),
  builtin('REDUCE', [p('collection', 'list'), p('start', 'any'), p('function', 'function')], 'derived', 'the members folded into one value', { form: { kind: 'collection', op: 'reduce' } }),
  builtin('GROUPBY', [p('collection', 'list'), p('key', 'function')], 'derived', 'the members grouped by a key', { form: { kind: 'collection', op: 'groupby' } }),
  builtin('KEYBY', [p('collection', 'list'), p('key', 'function')], 'derived', 'the members by a unique key', { form: { kind: 'collection', op: 'keyby' } }),
];

const STATEMENT_FORMS: Builtin[] = [
  builtin('MEMBERS', [p('type', 'type')], 'derived', "a closed type's values, in declaration order", { form: { kind: 'members' } }),
  builtin('EXTRACT', [p('content', 'any'), p('shape', 'shape'), p('settings', 'options', { optional: true })], 'derived', 'the records a model finds in content, of a declared shape', { effects: AI_ROW, form: { kind: 'extract' } }),
  builtin('EXTRACTONE', [p('content', 'any'), p('shape', 'shape'), p('settings', 'options', { optional: true })], 'derived', 'the single record content describes, of a declared shape, or absent', { effects: AI_ROW, form: { kind: 'extract' } }),
];

/** A namespaced member's entry — its signature is declared beside its
 *  implementation, in the family registry. */
function familyMember(spec: StdlibFunctionSpec): Builtin {
  return builtin(
    `${spec.namespace}.${spec.name}`,
    spec.params,
    spec.maybeAbsent === true ? { kind: 'maybeAbsent', of: spec.returns } : spec.returns,
    spec.summary,
    { effects: spec.readsClock === true ? { now: true } : PURE },
  );
}

const ALL: readonly Builtin[] = [
  ...Object.values(INTERPRETED),
  ...[...FORMULA_SPECIAL_FUNCTIONS].map((name) => {
    const entry = SPECIAL_FORMS[name];
    if (entry === undefined) throw new Error(`the formula grammar's '${name}' has no standard-library signature`);
    return entry;
  }),
  ...FLAT_WITH_CONTRACTS,
  ...COLLECTION_OPS,
  ...STATEMENT_FORMS,
  ...STDLIB_FAMILIES.flatMap((family) => family.functions.map(familyMember)),
];

const BY_FOLDED_NAME: ReadonlyMap<string, Builtin> = new Map(ALL.map((entry) => [entry.name.toLowerCase(), entry]));

/** The built-in a name calls, whatever its letter case — `upper`, `UPPER`,
 *  `currency.format_figure`. Undefined when the standard library has none. */
export function lookupBuiltin(name: string): Builtin | undefined {
  return BY_FOLDED_NAME.get(name.toLowerCase());
}

/** `fail("…")` inside an expression, from language version 5: its canonical
 *  call is `ERROR(…)`, the statement's word, which versions 1–4 never read as
 *  a value — so it is no member of the library they read (`builtinUnder`). */
export const FAIL: Builtin = builtin('ERROR', [p('message', 'scalar')], 'never', 'fails the run with the message; never returns');

/** The built-in `name` calls under `languageVersion`: the library's, and from
 *  5 the `fail` of an expression. */
export function builtinUnder(name: string, languageVersion: LanguageVersion): Builtin | undefined {
  if (since(languageVersion, 5) && name === FAIL.name) return FAIL;
  return lookupBuiltin(name);
}

/** Every built-in, in the order above — for listings and did-you-mean. */
export function standardLibrary(): readonly Builtin[] {
  return ALL;
}

/** The FLAT built-in names (no namespace), for a bare name's did-you-mean. */
export function flatBuiltinNames(): string[] {
  return ALL.filter((entry) => !entry.name.includes('.')).map((entry) => entry.name);
}

/** `UPPER(text) → text` — the signature as a person reads it. */
export function describeBuiltin(entry: Builtin): string {
  const params = entry.params
    .map((param) => `${param.rest ? '…' : ''}${param.name}${param.optional ? '?' : ''}`)
    .join(', ');
  return `${entry.name}(${params})`;
}

/** How many arguments a call of `entry` may pass. */
export function builtinArity(entry: Builtin): { min: number; max: number } {
  const min = entry.params.filter((param) => param.optional !== true && param.rest !== true).length;
  const max = entry.params.some((param) => param.rest === true) ? Infinity : entry.params.length;
  return { min, max };
}

/** The parameter argument `index` binds — the rest parameter for every
 *  argument at or past it. */
export function builtinParamAt(entry: Builtin, index: number): BuiltinParam | undefined {
  const direct = entry.params[index];
  if (direct !== undefined) return direct;
  const last = entry.params[entry.params.length - 1];
  return last?.rest === true ? last : undefined;
}
