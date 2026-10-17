// Pushing a hop's WHERE down to Gmail's search query.
//
// The engine ALWAYS satisfies the predicate itself over whatever comes back, so
// nothing here is required for correctness — the only thing at stake is how much
// is fetched, and with Gmail that matters more than most, because every message
// the search returns costs its own request. That is why this pushes CONJUNCTS
// only: a predicate under an OR or a NOT need not hold of every matching row, so
// narrowing on it would drop rows the hop should have seen.
//
// Matching is by BOTH the adapter's internal fieldId and the author-facing
// display name, because a hop's WHERE may carry either; a miss just widens the
// fetch.

import type { Expression } from '#shared/expression/types';

/** One conjunct of the WHERE, oriented so `field` is on the left. */
interface Conjunct {
  field: string;
  op: 'eq' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';
  value: Expression;
}

/**
 * The field a WHERE operand reads, or undefined when it reads no field.
 *
 * A hop's WHERE spells a BARE backticked field as an `edge_property` — the read
 * of the record the hop lands on — and a body-level one as a `property`. Both
 * denote the same record here, so both push; an alias-qualified read is
 * deliberately not one, since the alias may name an outer position whose value
 * would narrow the wrong collection.
 */
function propertyName(expr: Expression): string | undefined {
  return expr.type === 'property' || expr.type === 'edge_property'
    ? expr.propertyTypeId
    : undefined;
}

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

/** The `compare` leaves of an AND tree, each normalised to field-on-the-left. */
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

const has = (conjunct: Conjunct, ...names: string[]): boolean => names.includes(conjunct.field);

/** A Gmail search term. A value with a space has to be quoted or Gmail reads the
 *  second word as its own term. */
function term(operator: string, value: string): string {
  const quoted = /[\s():]/.test(value) ? `"${value}"` : value;
  return `${operator}:${quoted}`;
}

/**
 * One operator over several values. Gmail's own OR grouping is braces, so
 * `\`Labels\` IN ["INBOX", "IMPORTANT"]` narrows to messages carrying either —
 * rather than, as a repeated term would, messages carrying both.
 */
function anyOf(operator: string, values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) return term(operator, values[0]);
  return `{${values.map((value) => term(operator, value)).join(' ')}}`;
}

/** Gmail's `after:` / `before:` take whole epoch SECONDS. Both are inclusive
 *  over there and the engine narrows a strict bound over what comes back. */
function epochSeconds(value: string | number | boolean | null | undefined): string | undefined {
  const ms =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(ms) && !Number.isNaN(ms) ? String(Math.floor(ms / 1000)) : undefined;
}

/**
 * The Gmail query a hop's WHERE narrows to, or undefined when none of it is
 * pushable. Terms are space-separated, which is Gmail's AND.
 *
 * `eq` and `contains` push the same term on the text fields, because Gmail
 * matches WORDS and has no exact-string search at all — so `=` reaches Gmail as
 * a superset and the engine narrows it to equality over what comes back.
 */
export function gmailQueryFromWhere(where: Expression | undefined): string | undefined {
  const terms: string[] = [];
  for (const conjunct of conjunctsOf(where)) {
    if (has(conjunct, 'subject', 'Subject')) {
      const pushed = anyOf('subject', stringsOf(conjunct.value) ?? []);
      if (pushed) terms.push(pushed);
      continue;
    }
    if (has(conjunct, 'from', 'From')) {
      const pushed = anyOf('from', stringsOf(conjunct.value) ?? []);
      if (pushed) terms.push(pushed);
      continue;
    }
    if (has(conjunct, 'to', 'To')) {
      const pushed = anyOf('to', stringsOf(conjunct.value) ?? []);
      if (pushed) terms.push(pushed);
      continue;
    }
    if (has(conjunct, 'cc', 'Cc')) {
      const pushed = anyOf('cc', stringsOf(conjunct.value) ?? []);
      if (pushed) terms.push(pushed);
      continue;
    }
    if (has(conjunct, 'labels', 'Labels')) {
      const pushed = anyOf('label', stringsOf(conjunct.value) ?? []);
      if (pushed) terms.push(pushed);
      continue;
    }
    if (has(conjunct, 'date', 'Date')) {
      const seconds = epochSeconds(scalarOf(conjunct.value));
      if (seconds === undefined) continue;
      if (conjunct.op === 'gt' || conjunct.op === 'gte') terms.push(`after:${seconds}`);
      else if (conjunct.op === 'lt' || conjunct.op === 'lte') terms.push(`before:${seconds}`);
      continue;
    }
    // A `contains` over the body is a bare word to Gmail, which searches the
    // whole message — a superset of "the body says this", which is right.
    if (has(conjunct, 'body', 'Body') && conjunct.op === 'contains') {
      const values = stringsOf(conjunct.value) ?? [];
      for (const value of values) terms.push(/[\s():]/.test(value) ? `"${value}"` : value);
    }
  }
  return terms.length > 0 ? terms.join(' ') : undefined;
}

/**
 * The query a hop actually sends: what the WHERE narrowed to, on top of the
 * author's own listen filter when there is one. Two queries side by side are
 * Gmail's AND, which is what "the listener's filter AND this walk's" means.
 */
export function combineGmailQueries(
  ...queries: (string | undefined)[]
): string | undefined {
  const parts = queries.filter((q): q is string => q !== undefined && q.trim() !== '');
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * A message carrying ANY of these labels: one label is a plain term, several
 * are Gmail's brace OR group — `{label:INBOX label:SPAM}`.
 */
export function anyGmailLabel(labels: readonly string[]): string | undefined {
  return anyOf('label', [...labels]);
}
