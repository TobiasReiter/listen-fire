// A saved search's stored filter rows, rebuilt as the `POST /signals` body.
//
// WHY the poll rebuilds rather than runs. `GET /searches/{id}/signals` runs the
// search over there but takes no "created since" bound, so a poll on it can
// only bound by ORDER — and the spec promises no order. `POST /signals` takes
// `created_after`, so the poll translates the search's own rows into that call
// and lets the server apply the cutoff.
//
// WHAT IS AND IS NOT KNOWN. A row is `{ key, operator, value }` with `key` from
// a closed set, but `operator` and `value` are typed only as non-empty strings
// — the real vocabulary is not in the spec. So this reads every spelling of
// include and exclude that has been seen, and RETURNS what it could not read
// rather than dropping it quietly; the poll logs that the first time a search
// is used, which is how the vocabulary gets discovered.

import type {
  EvertraceSearchFilterRow,
  EvertraceSignalFilter,
} from './api_client';

/** The body keys a stored row can land on, all of them lists of values. */
type ListKey =
  | 'type'
  | 'source'
  | 'location'
  | 'country'
  | 'city'
  | 'profile_tags'
  | 'gender'
  | 'age'
  | 'past_companies'
  | 'past_education'
  | 'education_level'
  | 'customer_focus'
  | 'industry'
  | 'origin'
  | 'region';

/**
 * Row key → body key. Every name below carries straight across except
 * `status`: the rows have no `type` key and the body has no `status`, so a
 * stored `status` row IS the signal-kind filter.
 */
const BODY_KEY: Record<string, ListKey> = {
  status: 'type',
  source: 'source',
  location: 'location',
  country: 'country',
  city: 'city',
  profile_tags: 'profile_tags',
  gender: 'gender',
  age: 'age',
  past_companies: 'past_companies',
  past_education: 'past_education',
  education_level: 'education_level',
  customer_focus: 'customer_focus',
  industry: 'industry',
  origin: 'origin',
  region: 'region',
};

/** The keys Evertrace itself negates, with a `!` before the value. An exclude
 *  on any other key has no shape to travel in. */
const EXCLUDABLE = new Set<ListKey>(['country', 'city', 'industry', 'origin', 'region']);

/** Rows that never reach the body: the poll supplies its own cutoff, and the
 *  read endpoints ignore the watcher form. */
const DROPPED = new Set(['time_range', 'time_relative', 'created_after', 'worth_following']);

const INCLUDE_OPERATORS = new Set([
  '', 'eq', 'equals', 'in', 'is', 'includes', '=', '==', 'contains', 'any',
]);

const EXCLUDE_OPERATORS = new Set([
  'neq', 'ne', 'not', 'not_in', 'notin', 'excludes', 'is_not', '!=', '<>',
]);

/** `score` is a FLOOR over there, so a lower bound says exactly what the body
 *  already says. */
const SCORE_INCLUDE_OPERATORS = new Set(['gte', '>=', 'min']);

type Sense = 'include' | 'exclude' | 'unreadable';

function senseOf(operator: string | undefined, key: string): Sense {
  const op = (operator ?? '').trim().toLowerCase();
  if (INCLUDE_OPERATORS.has(op)) return 'include';
  if (key === 'score' && SCORE_INCLUDE_OPERATORS.has(op)) return 'include';
  if (EXCLUDE_OPERATORS.has(op) || op.startsWith('not') || op.startsWith('!')) return 'exclude';
  return 'unreadable';
}

/**
 * The strings behind a stored value. Three forms have been seen — a JSON array,
 * a JSON string, and a bare one — and a bare string carrying a comma is a list,
 * because no value in Evertrace's own enums contains one.
 */
function valuesOf(raw: string): string[] {
  const value = raw.trim();
  if (value === '') return [];
  if (value.startsWith('[') || value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return clean(parsed.map((v) => String(v)));
      if (typeof parsed === 'string') return clean([parsed]);
    } catch {
      // Not JSON after all — read it as a bare value.
    }
  }
  return clean(value.split(','));
}

function clean(values: string[]): string[] {
  return values.map((v) => v.trim()).filter((v) => v !== '');
}

/** A scalar stored value — quoted or bare. */
function scalarOf(raw: string): string | undefined {
  const value = raw.trim();
  if (value === '') return undefined;
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed.trim() === '' ? undefined : parsed.trim();
    } catch {
      // Not JSON after all — read it as a bare value.
    }
  }
  return value;
}

/** One row that could not be expressed, and why. */
export interface SkippedFilterRow {
  key: string;
  operator: string;
  reason: string;
}

export interface TranslatedSearchFilter {
  filter: EvertraceSignalFilter;
  skipped: SkippedFilterRow[];
}

/**
 * The filter body a saved search's rows justify, plus every row that could not
 * be expressed. A skipped row is NOT an error: the caller polls with what it
 * got (and its own `created_after`) and logs the rest.
 */
export function signalFilterFromSearchRows(
  rows: readonly EvertraceSearchFilterRow[],
): TranslatedSearchFilter {
  const filter: EvertraceSignalFilter = {};
  const skipped: SkippedFilterRow[] = [];
  const skip = (row: EvertraceSearchFilterRow, reason: string): void => {
    skipped.push({ key: row.key, operator: row.operator ?? '', reason });
  };

  for (const row of rows) {
    const key = (row.key ?? '').trim();
    if (DROPPED.has(key)) continue;

    const sense = senseOf(row.operator, key);
    if (sense === 'unreadable') {
      skip(row, 'operator reads as neither include nor exclude');
      continue;
    }

    if (key === 'score') {
      if (sense === 'exclude') {
        skip(row, 'score is a floor, so an exclude has no shape');
        continue;
      }
      const value = scalarOf(row.value ?? '');
      if (value === undefined) {
        skip(row, 'no value');
        continue;
      }
      // Two score rows are contradictory rather than additive; keep the
      // stricter floor, and the later one when neither reads as a number.
      const held = filter.score;
      filter.score = held !== undefined && Number(held) > Number(value) ? held : value;
      continue;
    }

    const bodyKey = BODY_KEY[key];
    if (bodyKey === undefined) {
      skip(row, 'no filter key of this name');
      continue;
    }
    if (sense === 'exclude' && !EXCLUDABLE.has(bodyKey)) {
      skip(row, 'this key has no exclude form');
      continue;
    }
    const values = valuesOf(row.value ?? '');
    if (values.length === 0) {
      skip(row, 'no value');
      continue;
    }
    const marked =
      sense === 'exclude' ? values.map((v) => (v.startsWith('!') ? v : `!${v}`)) : values;
    filter[bodyKey] = [...(filter[bodyKey] ?? []), ...marked];
  }

  return { filter, skipped };
}

/** Whether a translation produced anything to narrow with. */
export function narrowsAnything(filter: EvertraceSignalFilter): boolean {
  return Object.keys(filter).length > 0;
}
