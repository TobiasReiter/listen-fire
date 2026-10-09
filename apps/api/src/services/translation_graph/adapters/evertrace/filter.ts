// Pushing a hop's WHERE down to Evertrace.
//
// The engine ALWAYS satisfies the predicate itself over whatever comes back, so
// nothing here is required for correctness — the only thing at stake is how much
// is fetched. That is why this pushes CONJUNCTS only: a predicate under an OR or
// a NOT need not hold of every matching row, so narrowing on it would drop rows
// the hop should have seen. An `and` tree is walked; anything else contributes
// nothing and the engine filters it afterwards.
//
// Matching is by BOTH the adapter's internal fieldId and the author-facing
// display name, because a hop's WHERE may carry either; a miss just widens the
// fetch.

import type { Expression } from '#shared/expression/types';
import type { EvertraceSignalFilter } from '../../../../adapters/evertrace/apiClient';

import { EVERTRACE_PROFILE_TAGS, EVERTRACE_SIGNAL_KINDS } from './types';

/** One pushable signal field: the names a WHERE may spell it, and where its
 *  value lands in the filter body. */
type ListFilterKey = 'country' | 'city' | 'gender' | 'age' | 'source' | 'region';

const LIST_FIELDS: Array<{ names: string[]; key: ListFilterKey }> = [
  { names: ['country', 'Country'], key: 'country' },
  { names: ['city', 'City'], key: 'city' },
  { names: ['gender', 'Gender'], key: 'gender' },
  { names: ['age', 'Age'], key: 'age' },
  { names: ['source', 'Source'], key: 'source' },
  { names: ['regionName', 'Region'], key: 'region' },
];

const TAG_NAMES = new Set(['tags', 'Tags']);
const SIGNAL_KINDS = new Set<string>(EVERTRACE_SIGNAL_KINDS);
const PROFILE_TAGS = new Set<string>(EVERTRACE_PROFILE_TAGS);

/**
 * Which filter key a `Tags` conjunct's values belong to, or undefined when
 * nothing about them is pushable.
 *
 * The one `Tags` field reads BOTH of Evertrace's tag vocabularies, and each has
 * its own filter key. Values within a key are OR'd over there and keys are
 * AND'd, so a `Tags in [...]` — itself an OR — only survives the trip when
 * every value lands in the SAME key: splitting it across `type` and
 * `profile_tags` would turn the author's OR into an AND and drop rows the hop
 * should have seen. A value in neither vocabulary makes the whole conjunct
 * unpushable for the same reason: that arm of the OR would go unconstrained.
 */
function tagFilterKey(values: string[]): 'type' | 'profile_tags' | undefined {
  if (values.length === 0) return undefined;
  if (values.every((value) => SIGNAL_KINDS.has(value))) return 'type';
  if (values.every((value) => PROFILE_TAGS.has(value))) return 'profile_tags';
  return undefined;
}

const SCORE_NAMES = new Set(['score', 'Score']);
const NAME_NAMES = new Set(['fullName', 'Name']);
const DISCOVERED_NAMES = new Set(['discoveredAt', 'Discovered At']);
const CREATED_NAMES = new Set(['createdAt', 'Created At']);

/**
 * The field a WHERE operand reads, or undefined when it reads no field.
 *
 * A hop's WHERE spells a BARE backticked field (`\`Score\` >= 7`) as an
 * `edge_property` — the read of the record the hop lands on — and a body-level
 * one as a `property`. Both denote the same record here, so both push; an
 * alias-qualified read is deliberately not one, since the alias may name an
 * outer position whose value would narrow the wrong collection.
 */
function propertyName(expr: Expression): string | undefined {
  return expr.type === 'property' || expr.type === 'edge_property'
    ? expr.propertyTypeId
    : undefined;
}

/** A literal scalar, or undefined for anything computed at run time. */
function scalarOf(expr: Expression): string | number | boolean | null | undefined {
  return expr.type === 'static' ? expr.value : undefined;
}

/** The literal strings behind a value operand — a single static, or a list of
 *  them. Undefined when any element is computed (a partial list would narrow
 *  wrongly). */
function stringsOf(expr: Expression): string[] | undefined {
  if (expr.type === 'static') {
    return expr.value === null ? undefined : [String(expr.value)];
  }
  if (expr.type !== 'list') return undefined;
  const out: string[] = [];
  for (const element of expr.elements) {
    // A spread's members are computed — no literal to push down.
    if (element.type === 'spread') return undefined;
    const value = scalarOf(element);
    if (value === undefined || value === null) return undefined;
    out.push(String(value));
  }
  return out;
}

/** Evertrace's `YYYY-MM-DD` from an ISO string or an epoch-millisecond number. */
function isoDate(value: string | number | boolean | null | undefined): string | undefined {
  const ms = epochMs(value);
  if (ms === undefined) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

function epochMs(value: string | number | boolean | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** One conjunct of the WHERE, oriented so `field` is on the left. */
interface Conjunct {
  field: string;
  op: 'eq' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';
  value: Expression;
}

/** The `compare` leaves of an AND tree, each normalised to field-on-the-left.
 *  A comparison written the other way round (`"2026-01-01" <= x.\`Created At\``)
 *  has its operator mirrored so callers only ever handle one orientation. */
function conjunctsOf(where: Expression | undefined): Conjunct[] {
  const out: Conjunct[] = [];
  const MIRROR = { gt: 'lt', gte: 'lte', lt: 'gt', lte: 'gte', eq: 'eq' } as const;
  const visit = (expr: Expression): void => {
    if (expr.type === 'logical' && expr.op === 'and') {
      expr.operands.forEach(visit);
      return;
    }
    if (expr.type !== 'compare') return;
    const { op } = expr;
    if (op === 'in' || op === 'contains') {
      const field = propertyName(expr.left);
      if (field !== undefined) out.push({ field, op, value: expr.right });
      return;
    }
    if (op !== 'eq' && op !== 'gt' && op !== 'gte' && op !== 'lt' && op !== 'lte') return;
    const left = propertyName(expr.left);
    if (left !== undefined) {
      out.push({ field: left, op, value: expr.right });
      return;
    }
    const right = propertyName(expr.right);
    if (right !== undefined) out.push({ field: right, op: MIRROR[op], value: expr.left });
  };
  if (where !== undefined) visit(where);
  return out;
}

/**
 * The Evertrace filter body a hop's WHERE justifies. Empty when nothing is
 * pushable — which is a perfectly good answer: the collection is then fetched
 * unfiltered and the engine narrows it.
 *
 * `time_range` is only sent when a LOWER bound exists: the API's range is
 * `[from]` or `[from, to]`, so an upper bound alone has no shape to travel in
 * and is left to the engine.
 */
export function signalFilterFromWhere(where: Expression | undefined): EvertraceSignalFilter {
  const filter: EvertraceSignalFilter = {};
  let scoreFloor: number | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let createdAfter: number | undefined;

  for (const conjunct of conjunctsOf(where)) {
    const listField = LIST_FIELDS.find((f) => f.names.includes(conjunct.field));
    if (listField !== undefined) {
      if (conjunct.op !== 'eq' && conjunct.op !== 'in' && conjunct.op !== 'contains') continue;
      const values = stringsOf(conjunct.value);
      if (values === undefined) continue;
      filter[listField.key] = [...(filter[listField.key] ?? []), ...values];
      continue;
    }

    if (TAG_NAMES.has(conjunct.field)) {
      if (conjunct.op !== 'eq' && conjunct.op !== 'in' && conjunct.op !== 'contains') continue;
      const values = stringsOf(conjunct.value);
      if (values === undefined) continue;
      const key = tagFilterKey(values);
      if (key === undefined) continue;
      filter[key] = [...(filter[key] ?? []), ...values];
      continue;
    }

    if (NAME_NAMES.has(conjunct.field)) {
      // `fullname` is a partial match, so it serves both spellings: `contains`
      // exactly, and `eq` as a superset the engine then narrows to equality.
      if (conjunct.op !== 'eq' && conjunct.op !== 'contains') continue;
      const value = scalarOf(conjunct.value);
      if (typeof value === 'string' && value !== '') filter.fullname = value;
      continue;
    }

    if (SCORE_NAMES.has(conjunct.field)) {
      // The API's `score` is a FLOOR, so only a lower bound is pushable; `eq`
      // pushes the same floor (a superset) and the engine narrows it.
      if (conjunct.op !== 'gt' && conjunct.op !== 'gte' && conjunct.op !== 'eq') continue;
      const value = scalarOf(conjunct.value);
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) continue;
      // `> 7` is `>= 8` on an integer scale; a non-integer bound rounds up.
      const floor = conjunct.op === 'gt' ? Math.floor(numeric) + 1 : Math.ceil(numeric);
      if (scoreFloor === undefined || floor > scoreFloor) scoreFloor = floor;
      continue;
    }

    if (DISCOVERED_NAMES.has(conjunct.field)) {
      const day = isoDate(scalarOf(conjunct.value));
      if (day === undefined) continue;
      if (conjunct.op === 'gt' || conjunct.op === 'gte') {
        if (from === undefined || day > from) from = day;
      } else if (conjunct.op === 'lt' || conjunct.op === 'lte') {
        if (to === undefined || day < to) to = day;
      }
      continue;
    }

    if (CREATED_NAMES.has(conjunct.field)) {
      if (conjunct.op !== 'gt' && conjunct.op !== 'gte') continue;
      const ms = epochMs(scalarOf(conjunct.value));
      if (ms === undefined) continue;
      if (createdAfter === undefined || ms > createdAfter) createdAfter = ms;
    }
  }

  if (scoreFloor !== undefined) filter.score = String(Math.min(Math.max(scoreFloor, 1), 10));
  if (from !== undefined) filter.time_range = to !== undefined ? [from, to] : [from];
  if (createdAfter !== undefined) filter.created_after = String(createdAfter);
  return filter;
}

/**
 * The `search` term the companies / schools lookup takes, from a `Name`
 * equality or contains. Undefined when the WHERE names none — the lookup then
 * returns the biggest entities and the engine filters.
 */
export function lookupSearchTerm(where: Expression | undefined): string | undefined {
  for (const conjunct of conjunctsOf(where)) {
    if (conjunct.field !== 'name' && conjunct.field !== 'Name') continue;
    if (conjunct.op !== 'eq' && conjunct.op !== 'contains') continue;
    const value = scalarOf(conjunct.value);
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}
