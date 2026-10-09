// Pushing a hop's WHERE and ORDER BY down to Dealroom's search.
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

import {
  dealroomDateTime,
  type DealroomMustFilters,
  type DealroomSearchRequest,
} from '../../../../adapters/dealroom/apiClient';
import {
  DEALROOM_COMPANY_TYPE_ID,
  DEALROOM_FUNDING_ROUND_TYPE_ID,
  DEALROOM_INVESTOR_TYPE_ID,
  DEALROOM_PERSON_TYPE_ID,
} from './types';

/** One conjunct of the WHERE, oriented so `field` is on the left. */
interface Conjunct {
  field: string;
  op: 'eq' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';
  value: Expression;
}

/**
 * The field a WHERE operand reads, or undefined when it reads no field.
 *
 * A hop's WHERE spells a BARE backticked field (`\`Amount\` >= 1000000`) as an
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

function epochMs(value: string | number | boolean | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function numberOf(value: string | number | boolean | null | undefined): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

const has = (conjunct: Conjunct, ...names: string[]): boolean => names.includes(conjunct.field);

// ── Push primitives ─────────────────────────────────────────────────────────
// Each appends to the `form_data.must` map being built. Values within one key
// are OR'd by Dealroom and keys are AND'd, which is exactly what a conjunction
// of `in` tests means — so accumulating is safe.

function pushTerms(must: DealroomMustFilters, key: string, conjunct: Conjunct): void {
  if (conjunct.op !== 'eq' && conjunct.op !== 'in' && conjunct.op !== 'contains') return;
  const values = stringsOf(conjunct.value);
  if (values === undefined || values.length === 0) return;
  const existing = must[key];
  must[key] = [...(Array.isArray(existing) ? existing : []), ...values];
}

/** A boolean flag Dealroom filters as a terms list of `"true"` / `"false"`. */
function pushBooleanTerms(must: DealroomMustFilters, key: string, conjunct: Conjunct): void {
  if (conjunct.op !== 'eq') return;
  const value = scalarOf(conjunct.value);
  if (typeof value !== 'boolean') return;
  must[key] = [String(value)];
}

/** A numeric range, whose bounds Dealroom spells as two separate filter keys.
 *  Strict and non-strict bounds push the same key — the engine narrows `>` to
 *  `>` over the superset `>=` returned. */
function pushNumberBounds(
  must: DealroomMustFilters,
  keys: { min: string; max: string },
  conjunct: Conjunct,
): void {
  const value = numberOf(scalarOf(conjunct.value));
  if (value === undefined) return;
  if (conjunct.op === 'gt' || conjunct.op === 'gte') must[keys.min] = value;
  else if (conjunct.op === 'lt' || conjunct.op === 'lte') must[keys.max] = value;
  else if (conjunct.op === 'eq') {
    must[keys.min] = value;
    must[keys.max] = value;
  }
}

function pushDateBounds(
  must: DealroomMustFilters,
  keys: { min: string; max: string },
  conjunct: Conjunct,
): void {
  const ms = epochMs(scalarOf(conjunct.value));
  if (ms === undefined) return;
  if (conjunct.op === 'gt' || conjunct.op === 'gte') must[keys.min] = dealroomDateTime(ms);
  else if (conjunct.op === 'lt' || conjunct.op === 'lte') must[keys.max] = dealroomDateTime(ms);
}

/** A date filter with only a LOWER bound over there (`last_updated_utc` is a
 *  single value meaning "since"). An upper bound has no shape to travel in and
 *  is left to the engine. */
function pushSinceDate(must: DealroomMustFilters, key: string, conjunct: Conjunct): void {
  if (conjunct.op !== 'gt' && conjunct.op !== 'gte') return;
  const ms = epochMs(scalarOf(conjunct.value));
  if (ms === undefined) return;
  must[key] = dealroomDateTime(ms);
}

/**
 * The one keyword slot. Dealroom takes a single keyword per search, so a WHERE
 * naming both a domain and a name has to pick: the DOMAIN wins, because it
 * identifies one company where a name may not, and the engine still applies the
 * name to what comes back.
 *
 * The domain travels as `Website` — the HOST on its own, which is what
 * Dealroom's `website_domain` keyword matches. `Website URL` holds the full URL
 * and pushes nothing: sending it as a domain made an equality that could never
 * match on one side or the other, whichever spelling the author picked.
 */
interface KeywordChoice {
  keyword: string;
  keywordType: 'name' | 'website_domain';
  keywordMatchType: 'exact' | 'fuzzy';
}

function keywordFor(conjuncts: Conjunct[]): KeywordChoice | undefined {
  let name: KeywordChoice | undefined;
  for (const conjunct of conjuncts) {
    if (conjunct.op !== 'eq' && conjunct.op !== 'contains') continue;
    const value = scalarOf(conjunct.value);
    if (typeof value !== 'string' || value === '') continue;
    const match = conjunct.op === 'eq' ? 'exact' : 'fuzzy';
    if (has(conjunct, 'website', 'Website')) {
      return { keyword: value, keywordType: 'website_domain', keywordMatchType: match };
    }
    if (name === undefined && has(conjunct, 'name', 'Name')) {
      name = { keyword: value, keywordType: 'name', keywordMatchType: match };
    }
  }
  return name;
}

/** A location WHERE. Dealroom filters on one location vocabulary, so a city and
 *  a country both land in the same terms list. */
function pushLocation(must: DealroomMustFilters, key: string, conjunct: Conjunct): void {
  if (!has(conjunct, 'hqCity', 'HQ City', 'hqCountry', 'HQ Country')) return;
  pushTerms(must, key, conjunct);
}

// ── Per-entity translation ──────────────────────────────────────────────────

export function companySearchFromWhere(where: Expression | undefined): DealroomSearchRequest {
  const conjuncts = conjunctsOf(where);
  const must: DealroomMustFilters = {};
  for (const conjunct of conjuncts) {
    if (has(conjunct, 'industries', 'Industries')) pushTerms(must, 'industries', conjunct);
    else if (has(conjunct, 'tags', 'Tags')) pushTerms(must, 'tags', conjunct);
    else if (has(conjunct, 'growth_stage', 'Growth Stage')) pushTerms(must, 'growth_stages', conjunct);
    else if (has(conjunct, 'company_status', 'Company Status')) pushTerms(must, 'company_status', conjunct);
    else if (has(conjunct, 'total_funding', 'Total Funding')) pushNumberBounds(must, { min: 'total_funding_min', max: 'total_funding_max' }, conjunct);
    else if (has(conjunct, 'launch_year', 'Launch Year')) pushNumberBounds(must, { min: 'launch_year_min', max: 'launch_year_max' }, conjunct);
    else if (has(conjunct, 'last_updated_utc', 'Last Updated')) pushSinceDate(must, 'last_updated_utc', conjunct);
    else if (has(conjunct, 'created_utc', 'Created At')) pushSinceDate(must, 'created_utc_min', conjunct);
    else pushLocation(must, 'hq_locations', conjunct);
  }
  return { ...keywordFor(conjuncts), must };
}

export function investorSearchFromWhere(where: Expression | undefined): DealroomSearchRequest {
  const conjuncts = conjunctsOf(where);
  const must: DealroomMustFilters = {};
  for (const conjunct of conjuncts) {
    if (has(conjunct, 'investor_type', 'Investor Type')) pushTerms(must, 'investor_type', conjunct);
    else if (has(conjunct, 'investment_stages', 'Investment Stages')) pushTerms(must, 'investment_stages', conjunct);
    else if (has(conjunct, 'industry_experience', 'Industry Experience')) pushTerms(must, 'industry_experience', conjunct);
    else if (has(conjunct, 'last_updated_utc', 'Last Updated')) pushSinceDate(must, 'last_updated_utc', conjunct);
    else if (has(conjunct, 'created_utc', 'Created At')) pushSinceDate(must, 'created_utc_min', conjunct);
    else pushLocation(must, 'hq_locations', conjunct);
  }
  return { ...keywordFor(conjuncts), must };
}

export function personSearchFromWhere(where: Expression | undefined): DealroomSearchRequest {
  const conjuncts = conjunctsOf(where);
  const must: DealroomMustFilters = {};
  for (const conjunct of conjuncts) {
    if (has(conjunct, 'gender', 'Gender')) pushTerms(must, 'gender', conjunct);
    else if (has(conjunct, 'backgrounds', 'Backgrounds')) pushTerms(must, 'backgrounds', conjunct);
    else if (has(conjunct, 'is_strong_founder', 'Is Strong Founder')) pushBooleanTerms(must, 'is_strong_founder', conjunct);
    else if (has(conjunct, 'is_super_founder', 'Is Super Founder')) pushBooleanTerms(must, 'is_super_founder', conjunct);
    else if (has(conjunct, 'is_promising_founder', 'Is Promising Founder')) pushBooleanTerms(must, 'is_promising_founder', conjunct);
    else if (has(conjunct, 'last_updated_utc', 'Last Updated')) pushSinceDate(must, 'last_updated_utc', conjunct);
    else if (has(conjunct, 'created_utc', 'Created At')) pushSinceDate(must, 'created_utc_min', conjunct);
    else pushLocation(must, 'locations', conjunct);
  }
  return { ...keywordFor(conjuncts), must };
}

export function fundingRoundSearchFromWhere(
  where: Expression | undefined,
): DealroomSearchRequest {
  const must: DealroomMustFilters = {};
  for (const conjunct of conjunctsOf(where)) {
    if (has(conjunct, 'round', 'Round')) pushTerms(must, 'rounds', conjunct);
    else if (has(conjunct, 'amount', 'Amount')) pushNumberBounds(must, { min: 'amount_min', max: 'amount_max' }, conjunct);
    else if (has(conjunct, 'date', 'Date')) pushDateBounds(must, { min: 'date_min', max: 'date_max' }, conjunct);
    else if (has(conjunct, 'is_verified', 'Is Verified')) pushBooleanTerms(must, 'is_verified', conjunct);
    else if (has(conjunct, 'last_updated_utc', 'Last Updated')) pushSinceDate(must, 'last_updated_utc', conjunct);
    else if (has(conjunct, 'created_utc', 'Created At')) pushSinceDate(must, 'created_utc_min', conjunct);
  }
  // A round has no keyword search worth offering: its name is the company's,
  // and the company is one hop away.
  return { must };
}

/**
 * The three role flags a team sub-resource narrows by itself. Everything else
 * in a team WHERE (a title, a start year) is the engine's, over the member list
 * the parent bounds.
 */
export function teamRequestFromWhere(where: Expression | undefined): {
  isFounder?: boolean;
  isExecutive?: boolean;
  isPartner?: boolean;
} {
  const request: { isFounder?: boolean; isExecutive?: boolean; isPartner?: boolean } = {};
  for (const conjunct of conjunctsOf(where)) {
    if (conjunct.op !== 'eq') continue;
    const value = scalarOf(conjunct.value);
    if (typeof value !== 'boolean') continue;
    if (has(conjunct, 'is_founder', 'Is Founder')) request.isFounder = value;
    else if (has(conjunct, 'is_executive', 'Is Executive')) request.isExecutive = value;
    else if (has(conjunct, 'is_partner', 'Is Partner')) request.isPartner = value;
  }
  return request;
}

/** The WHERE translator for a root collection's target type. */
export function searchFromWhere(
  typeId: string,
  where: Expression | undefined,
): DealroomSearchRequest {
  switch (typeId) {
    case DEALROOM_COMPANY_TYPE_ID:
      return companySearchFromWhere(where);
    case DEALROOM_INVESTOR_TYPE_ID:
      return investorSearchFromWhere(where);
    case DEALROOM_PERSON_TYPE_ID:
      return personSearchFromWhere(where);
    case DEALROOM_FUNDING_ROUND_TYPE_ID:
      return fundingRoundSearchFromWhere(where);
    default:
      return { must: {} };
  }
}

// ── ORDER BY ────────────────────────────────────────────────────────────────

/** Sort keys per entity, spelled both ways a hop may carry the field. */
const SORT_KEYS: Record<string, Record<string, string>> = {
  [DEALROOM_COMPANY_TYPE_ID]: {
    name: 'name', Name: 'name',
    total_funding: 'total_funding', 'Total Funding': 'total_funding',
    last_funding_date: 'last_funding_date', 'Last Funding Date': 'last_funding_date',
    last_updated_utc: 'last_updated_utc', 'Last Updated': 'last_updated_utc',
    created_utc: 'created_utc', 'Created At': 'created_utc',
  },
  [DEALROOM_INVESTOR_TYPE_ID]: {
    name: 'name', Name: 'name',
    total_funding: 'total_funding', 'Total Funding': 'total_funding',
    last_updated_utc: 'last_updated_utc', 'Last Updated': 'last_updated_utc',
    created_utc: 'created_utc', 'Created At': 'created_utc',
  },
  [DEALROOM_PERSON_TYPE_ID]: {
    name: 'name', Name: 'name',
    last_updated_utc: 'last_updated_utc', 'Last Updated': 'last_updated_utc',
    created_utc: 'created_utc', 'Created At': 'created_utc',
  },
  [DEALROOM_FUNDING_ROUND_TYPE_ID]: {
    date: 'date', Date: 'date',
    amount: 'amount', Amount: 'amount',
    last_updated_utc: 'last_updated_utc', 'Last Updated': 'last_updated_utc',
    created_utc: 'created_utc', 'Created At': 'created_utc',
  },
};

/**
 * The `sort` value a hop's ORDER BY justifies — `-` prefixed for descending,
 * Dealroom's own spelling. Undefined when the field is not one Dealroom sorts
 * by, which is the signal to leave both the sort AND the limit to the engine.
 */
export function sortFromOrderBy(
  typeId: string,
  orderBy: { fieldId: string; direction: 'asc' | 'desc' } | undefined,
): string | undefined {
  if (orderBy === undefined) return undefined;
  const key = SORT_KEYS[typeId]?.[orderBy.fieldId];
  if (key === undefined) return undefined;
  return orderBy.direction === 'desc' ? `-${key}` : key;
}

/** Whether the hop's ORDER BY reached Dealroom — so the LIMIT may travel with
 *  it. An absent ORDER BY is trivially satisfied. */
export function orderIsPushable(
  typeId: string,
  orderBy: { fieldId: string; direction: 'asc' | 'desc' } | undefined,
): boolean {
  return orderBy === undefined || sortFromOrderBy(typeId, orderBy) !== undefined;
}
