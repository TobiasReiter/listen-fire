// `MAP(xs, { … }, f)` / `FILTER(xs, { … }, f)` — the settings record a
// collection op may be given between its collection and its function. The
// language's convention for a function that takes options: the data first,
// then the settings, then the function (`fn(data…, settings, lambda)`).
//
// The checker and the engine both read the record through `readCollectionConfig`,
// so what was refused at save and what the run does cannot disagree.
//
// Every value is WRITTEN DOWN, never worked out. The record decides how the run
// is scheduled and what a failure does, and both are facts the checker has to
// see to refuse a nonsense one (`concurrency: 0`, `onError: "retry"`) — a
// computed value would move that refusal to the middle of a run. It is the same
// line TypeScript draws: an options object written in place is checked key by
// key (excess-property checking), which is exactly what this does.

import { isObjectSpread, type Expression } from '@listen-fire/shared/expression/types';

import { didYouMean } from './meta';

/**
 * What happens when the function fails for one member:
 * - `error`: the run fails, as it always has. The default.
 * - `warn`: that member is left out of the answer, and the run's trace carries
 *   a warning naming it and why.
 * - `ignore`: that member is left out of the answer, and nothing is said.
 */
export const COLLECTION_ON_ERROR = ['ignore', 'warn', 'error'] as const;
export type CollectionOnError = (typeof COLLECTION_ON_ERROR)[number];

/** How a collection op runs its function over the members. */
export interface CollectionRunSettings {
  onError: CollectionOnError;
  /** How many members' functions may be running at once. */
  concurrency: number;
  /** How many members the FIRST batch holds. The first batch runs to the end
   *  before anything else starts, so a shared prompt is cached once, by
   *  the first batch, rather than by every member at the same moment. Equal
   *  to `concurrency` when the author did not set it, which is no separate
   *  first batch at all. */
  initialConcurrency: number;
}

/** Today's behaviour, and every op's without a settings record: one member at
 *  a time, in order, and the first failure fails the run. */
export const SEQUENTIAL_COLLECTION_SETTINGS: CollectionRunSettings = {
  onError: 'error',
  concurrency: 1,
  initialConcurrency: 1,
};

const SETTINGS: ReadonlyArray<{ key: keyof CollectionRunSettings; summary: string }> = [
  { key: 'onError', summary: '"error" (the default), "warn" or "ignore" — what a member whose function fails does' },
  { key: 'concurrency', summary: 'how many members run at once (1 by default)' },
  { key: 'initialConcurrency', summary: 'how many members the first batch runs, before the rest start' },
];

const SETTING_KEYS = SETTINGS.map((setting) => setting.key);

/** `all(f, g, { … })`'s settings (language version 5): how many arms run at
 *  once, and what an arm that fails does. There is no first batch — an arm
 *  that parks is waiting, not running, so it holds no place. */
export const ALL_SETTING_KEYS: ReadonlyArray<keyof CollectionRunSettings> = ['onError', 'concurrency'];

export interface CollectionConfigOptions {
  /** The settings this form takes; every op's by default. */
  keys?: ReadonlyArray<keyof CollectionRunSettings>;
  /** How many run at once when the record does not say — one, for an op. */
  concurrency?: number;
}

export type CollectionConfigReading =
  | { ok: true; settings: CollectionRunSettings }
  | { ok: false; problems: string[] };

/** `MAP`'s settings, read off the record as it was parsed. `spelling` is the op
 *  as written, so every sentence can be pasted back into the program. */
export function readCollectionConfig(
  record: Expression,
  spelling: string,
  options: CollectionConfigOptions = {},
): CollectionConfigReading {
  const keys = options.keys ?? SETTING_KEYS;
  const inventory = SETTINGS.filter((setting) => keys.includes(setting.key))
    .map((setting) => `${setting.key} — ${setting.summary}`)
    .join('; ');
  if (record.type !== 'object') {
    return {
      ok: false,
      problems: [
        `'${spelling}' takes its settings as a record written in place — \`${spelling}(xs, { onError: "warn", concurrency: 4 }, f)\`. The settings are: ${inventory}`,
      ],
    };
  }
  const problems: string[] = [];
  const written = new Map<string, Expression>();
  for (const entry of record.entries) {
    if (isObjectSpread(entry)) {
      problems.push(`'${spelling}' takes its settings written out one by one — a spread ('...') is not accepted here. The settings are: ${inventory}`);
      continue;
    }
    if (!isSettingKey(entry.key) || !keys.includes(entry.key)) {
      problems.push(
        `'${spelling}' has no setting '${entry.key}'${didYouMean(entry.key, keys)}. The settings are: ${inventory}`,
      );
      continue;
    }
    if (written.has(entry.key)) {
      problems.push(`'${spelling}' is given '${entry.key}' twice — write it once`);
      continue;
    }
    written.set(entry.key, entry.value);
  }

  const onErrorValue = written.get('onError');
  const onError = onErrorValue !== undefined ? readOnError(onErrorValue, spelling, problems) : 'error';
  const concurrencyValue = written.get('concurrency');
  const concurrency = concurrencyValue !== undefined
    ? readWidth(concurrencyValue, 'concurrency', spelling, problems)
    : options.concurrency ?? SEQUENTIAL_COLLECTION_SETTINGS.concurrency;
  const initialValue = written.get('initialConcurrency');
  const initialConcurrency = initialValue !== undefined
    ? readWidth(initialValue, 'initialConcurrency', spelling, problems)
    : concurrency;

  // A first batch wider than the rest is not a warm-up — it is the same run
  // with the numbers swapped, and almost always the two written the wrong way
  // round.
  if (
    concurrency !== undefined
    && initialConcurrency !== undefined
    && initialConcurrency > concurrency
  ) {
    problems.push(
      `'${spelling}' runs its first batch ${initialConcurrency} at a time and the rest ${concurrency} at a time — the first batch is the warm-up, so it is never the wider one. Lower initialConcurrency, or raise concurrency.`,
    );
  }

  if (problems.length > 0 || onError === undefined || concurrency === undefined || initialConcurrency === undefined) {
    return { ok: false, problems };
  }
  return { ok: true, settings: { onError, concurrency, initialConcurrency } };
}

function isSettingKey(key: string): key is keyof CollectionRunSettings {
  return (SETTING_KEYS as ReadonlyArray<string>).includes(key);
}

function isOnError(value: string): value is CollectionOnError {
  return (COLLECTION_ON_ERROR as ReadonlyArray<string>).includes(value);
}

function readOnError(
  value: Expression,
  spelling: string,
  problems: string[],
): CollectionOnError | undefined {
  const choices = COLLECTION_ON_ERROR.map((choice) => `"${choice}"`).join(', ');
  if (value.type !== 'static' || typeof value.value !== 'string') {
    problems.push(`'${spelling}': 'onError' is written down, not worked out — write onError: one of ${choices}`);
    return undefined;
  }
  if (!isOnError(value.value)) {
    problems.push(
      `'${spelling}': 'onError' has no value "${value.value}"${didYouMean(value.value, COLLECTION_ON_ERROR)} — write one of ${choices}`,
    );
    return undefined;
  }
  return value.value;
}

function readWidth(
  value: Expression,
  key: 'concurrency' | 'initialConcurrency',
  spelling: string,
  problems: string[],
): number | undefined {
  if (value.type !== 'static' || typeof value.value !== 'number') {
    problems.push(`'${spelling}': '${key}' is a whole number written down, not worked out — write ${key}: 4`);
    return undefined;
  }
  if (!Number.isInteger(value.value) || value.value < 1) {
    problems.push(
      `'${spelling}': '${key}' is how many members run at once, so it is a whole number of at least 1 — and this is ${value.value}`,
    );
    return undefined;
  }
  return value.value;
}

/** What `sort`'s `order` setting may be. */
export const SORT_ORDERS = ['asc', 'desc'] as const;

export type SortSettingsReading = { ok: true; descending: boolean } | { ok: false; problems: string[] };

/**
 * `sort`'s settings record (`sort(xs, f, { order: "desc" })`, language version
 * 5) — its one setting, written down. The checker and both engines read it
 * through this (the Rust twins: `read_sort_settings`, `sort_descending`).
 */
export function readSortSettings(record: Expression): SortSettingsReading {
  const one = 'Its one setting is order — "asc" (the default) or "desc"';
  if (record.type !== 'object') {
    return { ok: false, problems: [`'sort' takes its settings as a record written in place — \`sort(xs, (x) => x.key, { order: "desc" })\`. ${one}`] };
  }
  const problems: string[] = [];
  let order: Expression | undefined;
  for (const entry of record.entries) {
    if (isObjectSpread(entry)) {
      problems.push(`'sort' takes its settings written out one by one — a spread ('...') is not accepted here. ${one}`);
      continue;
    }
    if (entry.key !== 'order') {
      problems.push(`'sort' has no setting '${entry.key}'${didYouMean(entry.key, ['order'])}. ${one}`);
      continue;
    }
    if (order !== undefined) {
      problems.push(`'sort' is given 'order' twice — write it once`);
      continue;
    }
    order = entry.value;
  }
  let descending = false;
  if (order !== undefined) {
    if (order.type !== 'static' || typeof order.value !== 'string') {
      problems.push(`'sort': 'order' is written down, not worked out — write order: "asc" or "desc"`);
    } else if (order.value !== 'asc' && order.value !== 'desc') {
      problems.push(`'sort': 'order' has no value "${order.value}"${didYouMean(order.value, SORT_ORDERS)} — write "asc" or "desc"`);
    } else {
      descending = order.value === 'desc';
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, descending };
}
