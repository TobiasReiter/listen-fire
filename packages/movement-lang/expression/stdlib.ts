// The namespaced standard library — dotted pure-function families
// (`CURRENCY.GET_NUMBER_FROM_FIGURE("£1.2m")` → 1200000), per the
// 2026-06-11 ruling in `plans/2026-06-10-data-movement-language/
// 3_syntax_sketch.md` §"Composition, time, queries, failure":
// "Stdlib grows with namespaced families: flat pure built-ins plus
// dotted namespaces — a supported pattern for special-purpose pure
// tools".
//
// One registry serves every consumer:
//   - the BRIDGE folds `NS.FN(args)` (which the formula grammar already
//     parses as an alias-rooted traverse whose terminal is a function
//     call) into a plain `function` node with the dotted id, and rejects
//     unknown namespaces / unknown family members with the family's
//     inventory in the message — no @listen-fire/shared grammar change at all;
//   - the CHECKER types a folded call by the spec's declared return;
//   - the ENGINE evaluates the spec's `apply` exactly like its other
//     interpreted built-ins (deterministic, no LLM, no reads).
//
// Purity contract: same arguments → same value; no locale, no I/O.
// Null/undefined inputs yield null (the frozen built-ins' rule), and
// unparseable inputs yield null rather than throwing — a movement field
// write treats null as "no value", which is the right failure shape for
// "this string didn't contain a figure".
//
// ONE family of members steps outside the "arguments alone" half of that:
// a member marked `readsClock` (today only `DATE.TODAY(zone)`) also reads
// the run's PINNED INSTANT. That is a different shape, so it is a
// different type — such a spec has no `apply` at all, only `applyAt(args,
// now)`, so a pure member structurally cannot reach a clock and the
// engine cannot forget to hand one over. The instant is pinned once per
// run, so the determinism that matters survives: every clock read in a
// run answers from the same instant, and a replay computes the same
// window. The checker fires the effect row's `now` for these, exactly as
// it does for `@current_date`.
//
// FILE(content, "pdf" | "text") is related but NOT a member: it is a
// flat built-in with an effectful body (it renders an artifact), so only
// its NAME and argument contract live here (the bridge validates them);
// the rendering seam lives in the engine
// (apps/api/src/services/movement_engine/file_render.ts).
//
// READ(file) is the same shape pointing the other way — a file to its
// text — and is effectful for the same reason (it fetches bytes and runs
// an extractor). Its name and argument COUNT live here; the argument's
// type is the checker's (it must be a file), and the seam that reads it
// lives in the engine (apps/api/src/services/movement_engine/file_text.ts,
// reached through movement_engine/expression.ts).
//
// CHUNKS(text, { size | entities, overlap }) is a third flat built-in,
// and the first to take its arguments as a MAP. What the map may hold is
// declared here too (`BUILTIN_OPTIONS`) rather than written into the
// bridge, so the next built-in that wants options declares its keys
// instead of growing a second copy of the same validation. Its body is
// pure and lives beside it (./chunk.ts, and the density estimate its
// `entities` mode cuts by in ./density.ts) — only the trace entry belongs
// to the engine.

import { cronTimezoneError } from '@listen-fire/shared/cron';
import {
  instantAtZonedWallTime,
  readWallClockTime,
  wallClockTimeError,
  zonedDateString,
} from '@listen-fire/shared/timezone';

import { isMarkedFile } from './file_value';

// ── Parameters ───────────────────────────────────────────────────────────────

/**
 * What a built-in's parameter takes. The vocabulary is the checker's value
 * types, coarsened to what a built-in can honestly promise:
 *
 *   - `any`      — anything, a record included (held, counted, or written out whole);
 *   - `scalar`   — one plain value: text, a number, a boolean, a date or a datetime;
 *   - `text`     — text, or a refinement of it;
 *   - `number`   — a number;
 *   - `temporal` — a date, a datetime, or text read as one;
 *   - `file`     — a file;
 *   - `textOrList` — text (its characters) or a list (its members);
 *   - `list`     — a collection;
 *   - `record`   — a record or a dict, whose fields the program spells out;
 *   - `options`  — a map literal of settings, each checked against the built-in's own contract;
 *   - `function` — a function: a closure written in place, or a function's name;
 *   - `type`     — a type: `<Thesis>`.
 *
 * The checker reads it (checker/standard_library.ts); it lives here, beside
 * the registry, so a member declares what it takes where it is implemented.
 */
export type BuiltinParamType =
  | 'any'
  | 'scalar'
  | 'text'
  | 'number'
  | 'temporal'
  | 'file'
  | 'textOrList'
  | 'list'
  | 'record'
  | 'options'
  | 'function'
  | 'type'
  /** A node declaration, passed by its name — `extract`'s shape. A
   *  declaration name in value position resolves by scope to the shape. */
  | 'shape';

export interface BuiltinParam {
  name: string;
  type: BuiltinParamType;
  optional?: true;
  /** Takes every argument from here on (`COALESCE(a, b, …)`). */
  rest?: true;
}

/** One parameter, as the registries spell them. */
export function param(name: string, type: BuiltinParamType, flags: { optional?: true; rest?: true } = {}): BuiltinParam {
  return { name, type, ...flags };
}

// ── Specs ────────────────────────────────────────────────────────────────────

interface StdlibFunctionCommon {
  /** The family, as written (`CURRENCY`). */
  namespace: string;
  /** The member's surface name (`GET_NUMBER_FROM_FIGURE`). */
  name: string;
  /** The dotted id carried in the parsed AST's `fn` slot —
   *  `<namespace>.<name>`, lowercased (`currency.get_number_from_figure`).
   *  The formula serializer's `fn.toUpperCase()` round-trips it. */
  id: string;
  /** Call shape for diagnostics and docs: `CURRENCY.GET_CODE_FROM_FIGURE(figure)`. */
  signature: string;
  /** One-line description (diagnostics list these per family). */
  summary: string;
  arity: { min: number; max: number };
  /** What each argument takes — the member's entry in the standard-library
   *  scope (checker/standard_library.ts), which checks a call against it. */
  params: ReadonlyArray<BuiltinParam>;
  /** Shallow value type for the checker's write-field compatibility. */
  returns: 'text' | 'number' | 'date' | 'datetime';
  /**
   * The result may be ABSENT — the function returns null on an input it can't
   * read (`DATE.PARSE("not a date")`). The checker types the call as
   * `returns | absent` so the absence propagates (P20/F13) and fires
   * MOV_ABSENT_REQUIRED where a present value is required, discharged by `?:`,
   * a gate, or an `==` guard. Absent ⇒ the return is always present (the frozen
   * contract).
   */
  maybeAbsent?: boolean;
  /**
   * Arguments this function READS rather than merely passes on — a format
   * pattern, and nothing else so far. Such an argument is PARSED, which makes
   * it exactly the kind of string that drifts unless someone checks it, so the
   * checker demands a literal and runs `check` over it at save. `what` names
   * the argument in both diagnostics.
   */
  literalArgs?: ReadonlyArray<{
    index: number;
    what: string;
    /** A message when the literal is wrong, undefined when it is fine. */
    check: (value: string) => string | undefined;
  }>;
  /**
   * The one argument that has to be KEYED — a dict, or a typed extracted
   * record — rather than an ordinary value (`TEXT.PAIRS`'s first). The
   * registry otherwise has no way to say "this argument's shape is a
   * record": arity is a count and `literalArgs` is about parsed strings,
   * neither says anything about a value's structure, so this is the
   * smallest addition that lets the checker refuse `<json>` (a system's
   * opaque data looks keyed at the write layer, but the checker cannot see
   * its keys) while accepting a dict literal or a positioned record.
   */
  recordArg?: { index: number };
  /**
   * The one argument that is taken WHOLE — any value at all, with every record
   * inside it (at any depth: the argument itself, a list's member, a dict's
   * entry) read down to its fields and its landed edges before the function
   * sees it (`TEXT.SERIALISE`'s first). `recordArg` asks for one flat record;
   * this asks for the value as a tree, so `apply` stays a pure function over
   * plain data (dicts, lists, scalars, dates, file refs) and never meets the
   * engine's own binding objects.
   */
  wholeValueArg?: { index: number };
}

/** The ordinary member: its arguments are everything it sees. */
export interface StdlibPureFunctionSpec extends StdlibFunctionCommon {
  readsClock?: false;
  /** The deterministic implementation. Pure: no clock, no I/O. */
  apply: (args: unknown[]) => unknown;
}

/** A member that also reads the run's pinned instant (`DATE.TODAY(zone)`).
 *  It carries no `apply`, so it cannot be evaluated without one. */
export interface StdlibClockFunctionSpec extends StdlibFunctionCommon {
  readsClock: true;
  /** `now` is the run's ONE pinned instant, not a live clock read — two calls
   *  in a run, and a resume of a parked run, all get the same value. */
  applyAt: (args: unknown[], now: Date) => unknown;
}

export type StdlibFunctionSpec = StdlibPureFunctionSpec | StdlibClockFunctionSpec;

/** Evaluate a member — the ONE place a clock-reading member is handed the
 *  run's pinned instant, so no caller has to know which kind it has. */
export function applyStdlib(
  spec: StdlibFunctionSpec,
  args: unknown[],
  now: Date,
): unknown {
  return spec.readsClock === true ? spec.applyAt(args, now) : spec.apply(args);
}

export interface StdlibFamily {
  namespace: string;
  functions: StdlibFunctionSpec[];
}

// ── FILE() — the flat artifact built-in's contract (validated by the bridge) ─

/** The `fn` id FILE(content, type) parses to (a generic function call). */
export const FILE_FUNCTION_ID = 'file';

/** The artifact types FILE() renders. */
export const FILE_ARTIFACT_TYPES = ['pdf', 'text'] as const;
export type FileArtifactType = (typeof FILE_ARTIFACT_TYPES)[number];

export const FILE_SIGNATURE = 'FILE(content, "pdf" | "text")';

// ── READ() — the flat file→text built-in's contract (arity at the bridge) ────

/** The `fn` id READ(file) parses to (a generic function call). */
export const READ_FUNCTION_ID = 'read';

export const READ_SIGNATURE = 'READ(file)';

// ── CHUNKS() — the flat text→pieces built-in, and the options-map contract ───

/** The `fn` id CHUNKS(text, { … }) parses to (a generic function call). */
export const CHUNKS_FUNCTION_ID = 'chunks';

export const CHUNKS_SIGNATURE = 'CHUNKS(text, { size | entities, overlap })';

// ── The built-in function vocabulary ────────────────────────────────────────

/**
 * The flat built-ins the engine evaluates directly — the frozen engine's
 * pure set, mirrored. The engine's evaluator runs exactly these, and the
 * standard-library scope (checker/standard_library.ts) gives each its
 * signature.
 */
export const INTERPRETED_FUNCTION_IDS = [
  'isnull', 'coalesce', 'trim', 'lower', 'upper', 'length',
  'abs', 'round', 'floor', 'ceil', 'tostring', 'tonumber', 'multi', 'split',
  // Bare coercers — DATE/DATETIME/NUMBER normalise any readable date/timestamp,
  // NUMBER parses a number; null-safe.
  'date', 'datetime', 'number',
] as const;

/**
 * One key a built-in's options map may carry.
 *
 * `type` is the value's, and it is checked where the type is known: a
 * `literal` option is settled at the BRIDGE, because its value is a spelling
 * written into the source and nothing computes one; `number` and `text` are
 * the CHECKER's, because an ordinary expression stands there
 * (`size: LENGTH(body) / 3`) and only the checker types one.
 */
export interface BuiltinOptionSpec {
  key: string;
  type: 'number' | 'text' | 'literal';
  required: boolean;
  /** One-line description — diagnostics list the options with these. */
  summary: string;
  /** `literal` only: every spelling the grammar takes. */
  values?: ReadonlyArray<string>;
  /** `literal` only: of those spellings, the ones nothing implements yet, and
   *  what to write instead. Reserving a word in the grammar and refusing it
   *  with a sentence is how the spelling stays ours without pretending to
   *  work. */
  unavailable?: Readonly<Record<string, string>>;
}

/** A flat built-in that takes its options as a map literal. */
export interface BuiltinOptionsSpec {
  /** The parsed `fn` id this contract belongs to. */
  fn: string;
  signature: string;
  /** Total argument count, the map included. */
  arity: number;
  /** Which argument the map is. */
  index: number;
  options: ReadonlyArray<BuiltinOptionSpec>;
  /**
   * The name of a rule spanning two options that literal values already
   * settle (`overlap` under `size`). The rule is code, and lives once, in the
   * lowering (crates/movement-parser/src/lowering/call_shape.rs, `agree`):
   * it reads the LITERAL value of each key, absent where the author wrote an
   * expression, and answers with the sentence to refuse the call with.
   */
  agree?: 'chunks';
  /**
   * Options that are two answers to ONE question (`size` and `entities` both
   * say how big a piece is): exactly one of them is written, and neither
   * `required` nor `agree` can say that — the first is per key and the second
   * reads values, where this is about which keys are THERE. `what` names the
   * question, so the sentence reads as a choice rather than a rule.
   */
  exactlyOne?: ReadonlyArray<{ keys: ReadonlyArray<string>; what: string }>;
}

const CHUNKS_OPTIONS: BuiltinOptionsSpec = {
  fn: CHUNKS_FUNCTION_ID,
  signature: CHUNKS_SIGNATURE,
  arity: 2,
  index: 1,
  options: [
    {
      key: 'size',
      type: 'number',
      required: false,
      summary: 'the most characters a piece may be',
    },
    {
      key: 'entities',
      type: 'number',
      required: false,
      summary: 'the most records a piece is expected to yield, cutting on whole lines',
    },
    {
      key: 'overlap',
      type: 'number',
      required: false,
      summary: 'how many characters each piece repeats from the one before it (none by default)',
    },
    {
      key: 'unit',
      type: 'literal',
      required: false,
      summary: 'what size counts — "chars"',
      values: ['chars', 'tokens'],
      unavailable: {
        tokens: 'token chunking is not available yet; use unit: "chars"',
      },
    },
  ],
  exactlyOne: [{ keys: ['size', 'entities'], what: 'how big a piece is' }],
  agree: 'chunks',
};

/** Exported for the lowering vocabulary's pin (parser/expression/__test__/lowering_vocabulary). */
export const BUILTIN_OPTIONS: ReadonlyArray<BuiltinOptionsSpec> = [CHUNKS_OPTIONS];

const BUILTIN_OPTIONS_BY_FN = new Map(BUILTIN_OPTIONS.map((spec) => [spec.fn, spec]));

/** The options contract for a parsed `function` node's `fn` id, where it has
 *  one. The bridge validates the map's KEYS with it; the checker types the
 *  values. */
export function builtinOptionsFor(fn: string): BuiltinOptionsSpec | undefined {
  return BUILTIN_OPTIONS_BY_FN.get(fn);
}

/** `size — the most characters a piece may be; overlap — …; unit — …` — the
 *  inventory a diagnostic prints when a key is wrong or missing, with the
 *  choices a call has to make named after it. */
export function describeBuiltinOptions(spec: BuiltinOptionsSpec): string {
  const options = spec.options
    .map((option) => `${option.key}${option.required ? ' (required)' : ''} — ${option.summary}`)
    .join('; ');
  const choices = (spec.exactlyOne ?? [])
    .map((choice) => ` (exactly one of ${choice.keys.map((key) => `'${key}'`).join(' or ')})`)
    .join('');
  return `${options}${choices}`;
}

// ── CURRENCY ─────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS: ReadonlyArray<[symbol: string, code: string]> = [
  ['£', 'GBP'],
  ['€', 'EUR'],
  ['¥', 'JPY'],
  ['₹', 'INR'],
  ['$', 'USD'],
];

const CURRENCY_CODES: ReadonlySet<string> = new Set([
  'USD', 'GBP', 'EUR', 'JPY', 'CNY', 'CHF', 'CAD', 'AUD', 'NZD',
  'SEK', 'NOK', 'DKK', 'INR', 'SGD', 'HKD', 'KRW', 'BRL', 'MXN',
  'ZAR', 'PLN', 'AED', 'ILS', 'TRY',
]);

const MAGNITUDE_SUFFIXES: Readonly<Record<string, number>> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mm: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, tn: 1e12, trillion: 1e12,
};

/** The first number in the text, with thousands separators and an
 *  optional magnitude word stuck to it (`1.2m`, `3,500`, `2 billion`). */
const FIGURE_NUMBER = /(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z]+)?/;

function figureNumber(args: unknown[]): unknown {
  const [figure] = args;
  if (figure == null) return null;
  if (typeof figure === 'number') return figure;
  const match = FIGURE_NUMBER.exec(String(figure));
  if (!match) return null;
  const base = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]?.toLowerCase();
  const magnitude = suffix !== undefined ? MAGNITUDE_SUFFIXES[suffix] ?? 1 : 1;
  return base * magnitude;
}

function figureCode(args: unknown[]): unknown {
  const [figure] = args;
  if (figure == null) return null;
  const text = String(figure);
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (text.includes(symbol)) return code;
  }
  for (const word of text.match(/[A-Za-z]{3}/g) ?? []) {
    const code = word.toUpperCase();
    if (CURRENCY_CODES.has(code)) return code;
  }
  return null;
}

// ── DATE ─────────────────────────────────────────────────────────────────────

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

interface DateParts { y: number; m: number; d: number }

/** Deterministic date reading — explicit patterns only (ISO,
 *  `2026/03/12`, `12 March 2026`, `March 12, 2026`), all UTC, English
 *  month names. Ambiguous numeric forms (`12/03/2026`) deliberately
 *  do not parse. */
function readDateParts(value: unknown): DateParts | null {
  if (value == null) return null;
  const s = String(value).trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (iso) return validParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slashed = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (slashed) return validParts(Number(slashed[1]), Number(slashed[2]), Number(slashed[3]));

  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/.exec(s);
  if (dayFirst) {
    const month = MONTH_NAMES[dayFirst[2].toLowerCase()];
    if (month === undefined) return null;
    return validParts(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  const monthFirst = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (monthFirst) {
    const month = MONTH_NAMES[monthFirst[1].toLowerCase()];
    if (month === undefined) return null;
    return validParts(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  return null;
}

/** Round-trips through Date.UTC so `31 February` style inputs reject. */
function validParts(y: number, m: number, d: number): DateParts | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m, d };
}

function isoDate(parts: DateParts): string {
  const mm = String(parts.m).padStart(2, '0');
  const dd = String(parts.d).padStart(2, '0');
  return `${parts.y}-${mm}-${dd}`;
}

function dateParse(args: unknown[]): unknown {
  const parts = readDateParts(args[0]);
  return parts === null ? null : isoDate(parts);
}

function dateAddDays(args: unknown[]): unknown {
  const parts = readDateParts(args[0]);
  if (parts === null) return null;
  const days = Number(args[1]);
  if (!Number.isFinite(days)) return null;
  const epoch = Date.UTC(parts.y, parts.m - 1, parts.d) + Math.trunc(days) * 86_400_000;
  return new Date(epoch).toISOString().slice(0, 10);
}

/** Any readable date/timestamp/epoch as a full ISO 8601 UTC instant, or null. */
function dateFormatIso(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const date = new Date(s);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parts = readDateParts(s);
  if (parts === null) return null;
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).toISOString();
}

// ── DATE.FORMAT — a CLOSED pattern language ──────────────────────────────────
//
// `DATE.FORMAT(d, "MMMM D, YYYY")` → "August 31, 2026". The tokens are the
// date-fns / moment spelling, because that is the one every author (and every
// authoring model) already knows.
//
// The pattern is PARSED, so it is checked where it is written: every run of
// letters must be a token, and a run that isn't one is a save error naming the
// closest token. Nothing passes through silently — a pattern that means to
// print a word ("Day") would otherwise print "3ay" and nobody would find out
// until a person read the output. Everything that is NOT a letter (spaces,
// commas, slashes, dashes) is literal.
//
// English names only. A locale would make the same pattern print differently
// per reader, which is a different feature and not this one.

/** The whole vocabulary. A token is a RUN of one letter, which is what makes
 *  the pattern checkable: `MMMMM` is not `MMMM` plus `M`, it is a run of five
 *  M's and no token, so it is refused rather than printed as "August8". */
const DATE_FORMAT_TOKENS: ReadonlyArray<string> = [
  'YYYY', 'YY',
  'MMMM', 'MMM', 'MM', 'M',
  'DD', 'D',
  'dddd', 'ddd',
  'HH', 'H',
  'mm', 'm',
  'ss', 's',
];

const DATE_FORMAT_TOKEN_SET: ReadonlySet<string> = new Set(DATE_FORMAT_TOKENS);

const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_FULL = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/** The tokens and literal characters a pattern is made of, or the first run of
 *  letters that is not made of tokens. */
function readDateFormat(
  pattern: string,
): { pieces: Array<{ token: string } | { literal: string }> } | { unknown: string } {
  const pieces: Array<{ token: string } | { literal: string }> = [];
  for (const part of pattern.match(/[A-Za-z]+|[^A-Za-z]+/g) ?? []) {
    if (!/^[A-Za-z]/.test(part)) {
      for (const char of part) pieces.push({ literal: char });
      continue;
    }
    // Split the run where the letter changes — `YYYYMMDD` is three tokens,
    // `Day` is `D` then `a` then `y`, and only the first of those is one.
    const runs = part.match(/(.)\1*/g) ?? [];
    if (!runs.every((run) => DATE_FORMAT_TOKEN_SET.has(run))) return { unknown: part };
    for (const run of runs) pieces.push({ token: run });
  }
  return { pieces };
}

/** The save-time check: the whole token vocabulary, and a did-you-mean. */
export function checkDateFormatPattern(pattern: string): string | undefined {
  const read = readDateFormat(pattern);
  if (!('unknown' in read)) return undefined;
  const closest = closestDateFormatToken(read.unknown);
  return (
    `'${read.unknown}' isn't a date format token.`
    + (closest !== undefined ? ` Did you mean '${closest}'?` : '')
    + ` The tokens are ${DATE_FORMAT_TOKENS.join(', ')}`
    + ' (year, month, day, weekday, hour, minute, second);'
    + ' anything that is not a letter is printed as written.'
  );
}

/** The token a mistyped run is nearest to. Same CASE first — `M` and `m` are
 *  different tokens, and reading one as the other is the likeliest mistake —
 *  then the one closest in length, since `MMMMM` means `MMMM`. */
function closestDateFormatToken(run: string): string | undefined {
  const head = run[0]!;
  const sameCase = DATE_FORMAT_TOKENS.filter((t) => t[0] === head);
  const sameLetter = sameCase.length > 0
    ? sameCase
    : DATE_FORMAT_TOKENS.filter((t) => t[0]!.toLowerCase() === head.toLowerCase());
  if (sameLetter.length === 0) return undefined;
  return sameLetter.reduce((best, t) =>
    Math.abs(t.length - run.length) < Math.abs(best.length - run.length) ? t : best,
  );
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function dateFormat(args: unknown[]): unknown {
  const instant = coerceToDatetime(args[0]);
  if (instant === null) return null;
  const pattern = args[1];
  if (pattern == null) return null;
  const read = readDateFormat(String(pattern));
  if ('unknown' in read) return null;
  const date = new Date(instant);
  const y = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const weekday = date.getUTCDay();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  let out = '';
  for (const piece of read.pieces) {
    if ('literal' in piece) {
      out += piece.literal;
      continue;
    }
    switch (piece.token) {
      case 'YYYY': out += pad(y, 4); break;
      case 'YY': out += pad(y % 100, 2); break;
      case 'MMMM': out += MONTH_FULL[month]; break;
      case 'MMM': out += MONTH_FULL[month]!.slice(0, 3); break;
      case 'MM': out += pad(month + 1, 2); break;
      case 'M': out += String(month + 1); break;
      case 'DD': out += pad(day, 2); break;
      case 'D': out += String(day); break;
      case 'dddd': out += WEEKDAY_FULL[weekday]; break;
      case 'ddd': out += WEEKDAY_FULL[weekday]!.slice(0, 3); break;
      case 'HH': out += pad(hours, 2); break;
      case 'H': out += String(hours); break;
      case 'mm': out += pad(minutes, 2); break;
      case 'm': out += String(minutes); break;
      case 'ss': out += pad(seconds, 2); break;
      case 's': out += String(seconds); break;
    }
  }
  return out;
}

// ── Zones — the day it is there, and the instant a wall time names ───────────
//
// Two members, and one rule between them: ARITHMETIC HAPPENS IN CALENDAR
// SPACE, ANCHORING HAPPENS LAST.
//
//   berlin_today = DATE.TODAY("Europe/Berlin")
//   win_end      = DATETIME.AT(berlin_today, "07:00", "Europe/Berlin")
//   win_start    = DATETIME.AT(DATE.ADD_DAYS(berlin_today, -1), "07:00", "Europe/Berlin")
//
// Moving whole days on the DATE, then anchoring each endpoint on its own, is
// what makes that window come out 23 or 25 hours long across a DST change with
// nobody having written that down. Anchoring first and subtracting 24 hours
// gets 06:00 or 08:00 local twice a year, silently.
//
// `DATE.TODAY` is the language's only clock-reading FUNCTION (`@current_date`
// is the only other clock read there is), and it reads the run's pinned
// instant, not the wall clock — so a run that asks twice gets one answer, and
// 00:30 in Berlin is today in Berlin rather than yesterday in UTC.
//
// The zone and the wall time are both PARSED, so both are demanded as written
// literals and checked at save (`literalArgs`) with the same probes the run
// uses — author-time and run-time cannot disagree about what a zone is.

function checkTimeZone(zone: string): string | undefined {
  return cronTimezoneError(zone) ?? undefined;
}

function checkWallClockTime(time: string): string | undefined {
  return wallClockTimeError(time) ?? undefined;
}

function dateToday(args: unknown[], now: Date): unknown {
  const zone = args[0];
  if (zone == null) return null;
  const problem = cronTimezoneError(String(zone));
  if (problem !== null) throw new Error(`DATE.TODAY(zone) — ${problem}`);
  return zonedDateString(now, String(zone));
}

function datetimeAt(args: unknown[]): unknown {
  const [date, time, zone] = args;
  if (date == null || time == null || zone == null) return null;
  // A date-typed adapter field arrives as a real Date; everything else that
  // reads as a date arrives as text.
  const parts = readDateParts(date instanceof Date ? date.toISOString() : date);
  if (parts === null) {
    throw new Error(
      `DATETIME.AT(date, time, zone) — '${String(date)}' is not a calendar date.`
      + ' Its first argument is a day: DATE.TODAY(zone), a date field, DATE.ADD_DAYS(…) or DATE.PARSE(text).',
    );
  }
  const wall = readWallClockTime(String(time));
  if (wall === null) throw new Error(`DATETIME.AT(date, time, zone) — ${wallClockTimeError(String(time))}`);
  const zoneProblem = cronTimezoneError(String(zone));
  if (zoneProblem !== null) throw new Error(`DATETIME.AT(date, time, zone) — ${zoneProblem}`);
  return instantAtZonedWallTime({
    year: parts.y,
    month: parts.m,
    day: parts.d,
    hour: wall.hour,
    minute: wall.minute,
    timezone: String(zone),
  }).toISOString();
}

// ── Coercers (DATE / DATETIME / NUMBER) ───────────────────────────────────────
//
// One value in, a value of the named scalar type out — the author-time
// type-check uses these to bridge a cross-category comparison (`date <=
// NUMBER(x)`). Pure and null-safe like every built-in: an unparseable
// input yields null. DATE normalises any readable date/timestamp to a
// midnight-UTC calendar day (date-only ISO); DATETIME to a full instant.
//
// These are the BARE built-in coercers `DATE(x)` / `DATETIME(x)` /
// `NUMBER(x)` — the formula grammar parses them as flat function calls
// (`{ fn: 'date' | 'datetime' | 'number' }`), the checker types them, and
// the engine runs them through these single-value implementations (it
// imports them rather than re-implementing, so there is one source of
// truth). Single-value signatures (not the `args[]` registry shape) so the
// engine can call them directly.

/** Any readable date/timestamp/epoch as a full ISO 8601 UTC instant, or null. */
export function coerceToDatetime(value: unknown): string | null {
  if (value == null) return null;
  return dateFormatIso(value);
}

/** The same instant, truncated to its calendar day (midnight UTC, date-only). */
export function coerceToDate(value: unknown): string | null {
  const instant = coerceToDatetime(value);
  return instant === null ? null : instant.slice(0, 10);
}

/** A value coerced to a finite number, or null when it doesn't parse. */
export function coerceToNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) && String(value).trim() !== '' ? n : null;
}

// ── NUMBER / CURRENCY formatting — NUMBER.FORMAT and CURRENCY.FORMAT_FIGURE ──
//
// One magnitude renderer serves both: NUMBER.FORMAT("compact") writes a bare
// number out (1200000 -> "1.2M"); CURRENCY.FORMAT_FIGURE is its money-aware
// sibling and the inverse of CURRENCY.GET_NUMBER_FROM_FIGURE — the same
// magnitude rendering with a currency mark stuck on the front: the symbol
// where the GET_CODE_FROM_FIGURE table has one, the ISO code after a space
// where it doesn't, nothing where the code is empty or unrecognised. Both
// null-propagate like every other member: no number in, no text out — hence
// `maybeAbsent`, exactly like DATE.PARSE and URL.HOST.

const COMPACT_TIERS: ReadonlyArray<[threshold: number, suffix: string]> = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

/** `abs` is the magnitude alone — the sign belongs to the caller, so it can
 *  land wherever it reads right (before a symbol, not inside the digits).
 *  One decimal at most, no trailing ".0". */
function compactMagnitude(abs: number): string {
  const tier = COMPACT_TIERS.find(([threshold]) => abs >= threshold);
  if (!tier) return String(abs);
  const [threshold, suffix] = tier;
  const scaled = Math.round((abs / threshold) * 10) / 10;
  const digits = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1);
  return `${digits}${suffix}`;
}

/** Thousands-grouped, decimal part kept as given (rounded to at most two
 *  places — a number literal never carries more precision than that anyway). */
function groupedMagnitude(abs: number): string {
  const rounded = Math.round(abs * 100) / 100;
  const [intPart, fracPart] = String(rounded).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fracPart !== undefined ? `${grouped}.${fracPart}` : grouped;
}

const NUMBER_FORMAT_STYLES = ['compact', 'grouped'] as const;

/** The save-time check on NUMBER.FORMAT's style — a literal, same shape as
 *  DATE.FORMAT's pattern: written down, not computed, checked against the
 *  whole (small) vocabulary. */
function checkNumberFormatStyle(style: string): string | undefined {
  if ((NUMBER_FORMAT_STYLES as readonly string[]).includes(style)) return undefined;
  return `'${style}' isn't a number format style — write "compact" or "grouped".`;
}

function numberFormat(args: unknown[]): unknown {
  const [value, style] = args;
  const n = coerceToNumber(value);
  if (n === null) return null;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  switch (style) {
    case 'compact':
      return `${sign}${compactMagnitude(abs)}`;
    case 'grouped':
      return `${sign}${groupedMagnitude(abs)}`;
    default:
      return null;
  }
}

/** Code -> symbol, the reverse of the table CURRENCY.GET_CODE_FROM_FIGURE
 *  reads (symbol -> code) — the same table, so the two functions can never
 *  disagree about which codes have a symbol. */
const SYMBOL_BY_CODE = new Map(CURRENCY_SYMBOLS.map(([symbol, code]) => [code, symbol]));

function formatFigure(args: unknown[]): unknown {
  const [value, code] = args;
  const n = coerceToNumber(value);
  if (n === null) return null;
  const sign = n < 0 ? '-' : '';
  const amount = compactMagnitude(Math.abs(n));
  const normalizedCode = code == null ? '' : String(code).trim().toUpperCase();
  if (normalizedCode === '') return `${sign}${amount}`;
  const symbol = SYMBOL_BY_CODE.get(normalizedCode);
  if (symbol !== undefined) return `${sign}${symbol}${amount}`;
  if (CURRENCY_CODES.has(normalizedCode)) return `${sign}${amount} ${normalizedCode}`;
  return `${sign}${amount}`;
}

/** A documented bare coercer — the editor's single source of truth for both
 *  the autocomplete item and its hover. One value in, a value of `returns`
 *  out; `summary` is user-facing (clear, jargon-free, with an example). */
export interface BareCoercerSpec {
  name: 'DATE' | 'DATETIME' | 'NUMBER';
  signature: string;
  summary: string;
  returns: 'date' | 'datetime' | 'number';
}

export const BARE_COERCERS: ReadonlyArray<BareCoercerSpec> = [
  {
    name: 'DATE',
    signature: 'DATE(value)',
    summary:
      'coerce a value to a calendar day (midnight UTC) — DATE("2026-03-12T09:30Z") is "2026-03-12"',
    returns: 'date',
  },
  {
    name: 'DATETIME',
    signature: 'DATETIME(value)',
    summary:
      'coerce a value to a full timestamp (UTC instant) — DATETIME("2026-03-12") is "2026-03-12T00:00:00.000Z"',
    returns: 'datetime',
  },
  {
    name: 'NUMBER',
    signature: 'NUMBER(value)',
    summary: 'coerce a value to a number — NUMBER("42") is 42; an unparseable value is empty',
    returns: 'number',
  },
];

const BARE_COERCER_BY_NAME = new Map(BARE_COERCERS.map((c) => [c.name, c]));

/** The coercer for a written name (case-insensitive, like the rest of the
 *  expression grammar) — `DATE` / `DATETIME` / `NUMBER`. */
export function bareCoercer(name: string): BareCoercerSpec | undefined {
  return BARE_COERCER_BY_NAME.get(name.toUpperCase() as BareCoercerSpec['name']);
}

// ── TEXT ─────────────────────────────────────────────────────────────────────

function textRegexExtract(args: unknown[]): unknown {
  const [text, pattern, group] = args;
  if (text == null || pattern == null) return null;
  let re: RegExp;
  try {
    re = new RegExp(String(pattern));
  } catch {
    return null;
  }
  const match = re.exec(String(text));
  if (!match) return null;
  const index =
    args.length > 2 ? Number(group) : match.length > 1 ? 1 : 0;
  if (!Number.isInteger(index) || index < 0 || index >= match.length) return null;
  return match[index] ?? null;
}

function textSlug(args: unknown[]): unknown {
  const [text] = args;
  if (text == null) return null;
  return String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A single field's value, rendered exactly as `${\u2026}` interpolation renders
 *  one \u2014 absent is empty, everything else is `String(value)` (a boolean
 *  prints `true`/`false`, a number is what `TOSTRING` gives it). */
function textPairsScalar(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** `record` is a plain keyed object at this layer whatever it came from \u2014 a
 *  dict literal's own `Object.fromEntries`, or a materialised extracted
 *  record \u2014 so own-key order IS the written order the checker promises
 *  (`shape`'s key order for a dict literal, the declaration's field order
 *  for a record). A value that is itself an object or an array is a nested
 *  node/edge, not a scalar field, and is skipped rather than stringified \u2014
 *  `[object Object]` helps nobody. */
function textPairs(args: unknown[]): unknown {
  const [record, separator] = args;
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return null;
  const sep = typeof separator === 'string' ? separator : ' | ';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') continue; // nested node/edge \u2014 skip
    parts.push(`${key}=${textPairsScalar(value)}`);
  }
  return parts.join(sep);
}

// ── TEXT.SERIALISE ───────────────────────────────────────────────────────────

// A value written out as text for a prompt. The point is that the SAME value
// always yields the SAME bytes: a prompt that begins with a serialised record
// is only cached when the prefix is identical, so nothing here may depend on
// insertion order, locale, or the host's float printing.
//
//   - objects: keys sorted (UTF-16 code-unit order), recursively. A record's
//     declaration order is not stable across a park (jsonb reorders keys), so
//     it is deliberately not what is printed.
//   - two-space indent, one member per line. Compact JSON would be a few
//     tokens cheaper, but a model reads a field per line far better, and the
//     bytes are just as stable.
//   - numbers: JSON.stringify's shortest round-trip form; -0 is 0; NaN and
//     ±Infinity (not JSON) are null.
//   - dates and datetimes: a Date is its UTC ISO-8601 instant; a date or
//     datetime already held as text is printed as that text.
//   - absent: null, always. A record's absent field keeps its key (the
//     record's shape does not change with its data); an absent list member is
//     null; an absent value as a whole is the text `null`.
//   - a file: a descriptor `{ contentType, kind: "file", name, size }` (a
//     missing part is null) — never its bytes, which are not in hand and are
//     not what a prompt wants from a record.

export const SERIALISE_FORMATS = ['JSON'] as const;
type SerialiseFormat = (typeof SERIALISE_FORMATS)[number];

function checkSerialiseFormat(format: string): string | undefined {
  if ((SERIALISE_FORMATS as readonly string[]).includes(format)) return undefined;
  const near = SERIALISE_FORMATS.find((f) => f.toLowerCase() === format.toLowerCase());
  return `'${format}' isn't a format TEXT.SERIALISE writes — ${
    near !== undefined ? `did you mean "${near}"? ` : ''
  }the formats are ${SERIALISE_FORMATS.map((f) => `"${f}"`).join(', ')}.`;
}

/** The value as plain, ordered-by-key JSON data — everything JSON cannot say
 *  (a Date, a file, a non-finite number) already turned into what it should
 *  print as. */
function toStableJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return null;
  }
  const obj = value as object;
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  if (Array.isArray(obj)) return obj.map(toStableJson);
  // A file the engine made, by its mark: data carrying a file's keys prints
  // as the keys it carries.
  if (isMarkedFile(obj)) {
    const file = obj as { name?: unknown; contentType?: unknown; size?: unknown };
    return {
      contentType: toStableJson(file.contentType),
      kind: 'file',
      name: toStableJson(file.name),
      size: toStableJson(file.size),
    };
  }
  const entries = Object.entries(obj as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return Object.fromEntries(entries.map(([k, v]) => [k, toStableJson(v)]));
}

function textSerialise(args: unknown[]): unknown {
  const [value, format] = args;
  switch (format as SerialiseFormat) {
    case 'JSON':
      return JSON.stringify(toStableJson(value), null, 2);
    default:
      // Unreachable from a saved movement: a format is a literal the checker
      // has compared.
      throw new Error(`TEXT.SERIALISE: unknown format ${JSON.stringify(format)}`);
  }
}

// ── URL ──────────────────────────────────────────────────────────────────────

// This package declares no DOM/Node lib (`tsconfig.json`'s `lib: ["es2022"]`
// only — pure, environment-agnostic functions, per the file header's purity
// contract), so the global `URL` constructor — present at runtime in Node,
// every browser, and every other JS host that runs this package — needs its
// own narrow ambient type here rather than pulling in a whole environment's
// globals for one function's sake.
declare const URL: { new (input: string): { hostname: string; username: string } };

// A `scheme:` prefix not followed by `//` — `mailto:`, `tel:` — marks an
// OPAQUE uri with no authority to read a host out of. Deliberately dot-free
// (no real IANA scheme has one): `acme.com:8080` is not this — it is a bare
// host:port whose "scheme" would be `acme.com` — so it falls through to the
// scheme-less path below instead of being mistaken for an opaque uri.
const OPAQUE_SCHEME_URI = /^[a-zA-Z][a-zA-Z0-9+-]*:(?!\/\/)/;

function urlHost(args: unknown[]): unknown {
  const [text] = args;
  if (text == null) return null;
  const raw = String(text).trim();
  if (raw === '') return null;

  // A scheme-less address (`acme.com`, `acme.com:8080`, `www.Acme.com/x`)
  // parses under an assumed `http://`. Not a relative path (`/deals/1` —
  // itself parseable as an authority once prefixed, which would be wrong)
  // and not an opaque uri (`mailto:a@b.com` has no host either way, so the
  // prefix would only invent one from its own address).
  const attempt =
    raw.includes('://') ? raw
    : raw.startsWith('/') || OPAQUE_SCHEME_URI.test(raw) ? null
    : `http://${raw}`;
  if (attempt === null) return null;

  let url: { hostname: string; username: string };
  try {
    url = new URL(attempt);
  } catch {
    return null;
  }
  // No host at all (`file:///x`) — nothing to answer. Userinfo (`user@host`)
  // means this named credentials, not a bare host — `joe@acme.com` is an
  // email, not a host.
  if (!url.hostname || url.username) return null;
  // `URL` already normalizes the hostname to lowercase, keeps `www.`, and
  // carries no port (that's `url.port`) or path — verbatim otherwise.
  return url.hostname;
}

// ── The registry ─────────────────────────────────────────────────────────────

function spec(
  namespace: string,
  name: string,
  options: {
    args: string;
    params: StdlibFunctionCommon['params'];
    summary: string;
    arity: StdlibFunctionSpec['arity'];
    returns: StdlibFunctionSpec['returns'];
    maybeAbsent?: boolean;
    literalArgs?: StdlibFunctionCommon['literalArgs'];
    recordArg?: StdlibFunctionCommon['recordArg'];
    wholeValueArg?: StdlibFunctionCommon['wholeValueArg'];
    apply: StdlibPureFunctionSpec['apply'];
  },
): StdlibPureFunctionSpec {
  return { ...common(namespace, name, options), apply: options.apply };
}

/** A member that reads the run's pinned instant — same shape, `applyAt`
 *  instead of `apply`, so the two can never be confused for each other. */
function clockSpec(
  namespace: string,
  name: string,
  options: {
    args: string;
    params: StdlibFunctionCommon['params'];
    summary: string;
    arity: StdlibFunctionSpec['arity'];
    returns: StdlibFunctionSpec['returns'];
    maybeAbsent?: boolean;
    literalArgs?: StdlibFunctionCommon['literalArgs'];
    applyAt: StdlibClockFunctionSpec['applyAt'];
  },
): StdlibClockFunctionSpec {
  return { ...common(namespace, name, options), readsClock: true, applyAt: options.applyAt };
}

function common(
  namespace: string,
  name: string,
  options: {
    args: string;
    params: StdlibFunctionCommon['params'];
    summary: string;
    arity: StdlibFunctionSpec['arity'];
    returns: StdlibFunctionSpec['returns'];
    maybeAbsent?: boolean;
    literalArgs?: StdlibFunctionCommon['literalArgs'];
    recordArg?: StdlibFunctionCommon['recordArg'];
    wholeValueArg?: StdlibFunctionCommon['wholeValueArg'];
  },
): StdlibFunctionCommon {
  return {
    namespace,
    name,
    id: `${namespace.toLowerCase()}.${name.toLowerCase()}`,
    signature: `${namespace}.${name}(${options.args})`,
    summary: options.summary,
    params: options.params,
    arity: options.arity,
    returns: options.returns,
    ...(options.maybeAbsent !== undefined ? { maybeAbsent: options.maybeAbsent } : {}),
    ...(options.literalArgs !== undefined ? { literalArgs: options.literalArgs } : {}),
    ...(options.recordArg !== undefined ? { recordArg: options.recordArg } : {}),
    ...(options.wholeValueArg !== undefined ? { wholeValueArg: options.wholeValueArg } : {}),
  };
}

export const STDLIB_FAMILIES: ReadonlyArray<StdlibFamily> = [
  {
    namespace: 'CURRENCY',
    functions: [
      spec('CURRENCY', 'GET_NUMBER_FROM_FIGURE', {
        args: 'figure',
        params: [param('figure', 'text')],
        summary: 'the numeric amount in a money figure — CURRENCY.GET_NUMBER_FROM_FIGURE("£1.2m") is 1200000',
        arity: { min: 1, max: 1 },
        returns: 'number',
        apply: figureNumber,
      }),
      spec('CURRENCY', 'GET_CODE_FROM_FIGURE', {
        args: 'figure',
        params: [param('figure', 'text')],
        summary: 'the ISO currency code in a money figure — CURRENCY.GET_CODE_FROM_FIGURE("£1.2m") is "GBP"',
        arity: { min: 1, max: 1 },
        returns: 'text',
        apply: figureCode,
      }),
      spec('CURRENCY', 'FORMAT_FIGURE', {
        args: 'number, code',
        params: [param('number', 'number'), param('code', 'text')],
        summary:
          'a number as a money figure — the inverse of GET_NUMBER_FROM_FIGURE — CURRENCY.FORMAT_FIGURE(1200000, "EUR") is "€1.2M"; a code with no symbol prints after the amount ("1.2M CHF"); an empty or unknown code prints the bare number',
        arity: { min: 2, max: 2 },
        returns: 'text',
        maybeAbsent: true,
        apply: formatFigure,
      }),
    ],
  },
  {
    namespace: 'DATE',
    functions: [
      spec('DATE', 'PARSE', {
        args: 'text',
        params: [param('text', 'text')],
        summary: 'a written date as an ISO date — DATE.PARSE("12 March 2026") is "2026-03-12"; unreadable text is absent',
        arity: { min: 1, max: 1 },
        returns: 'date',
        // Unreadable text yields absence — the checker types this `date | absent`
        // so an unguarded parse into a required field is caught at save (F13/P20).
        maybeAbsent: true,
        apply: dateParse,
      }),
      spec('DATE', 'ADD_DAYS', {
        args: 'date, days',
        params: [param('date', 'temporal'), param('days', 'number')],
        summary: 'a date shifted by whole days — DATE.ADD_DAYS("2026-03-12", 7) is "2026-03-19"',
        arity: { min: 2, max: 2 },
        returns: 'date',
        apply: dateAddDays,
      }),
      spec('DATE', 'FORMAT', {
        args: 'value, pattern',
        params: [param('value', 'temporal'), param('pattern', 'text')],
        summary:
          'a date written out — DATE.FORMAT("2026-08-31", "MMMM D, YYYY") is "August 31, 2026". Tokens: YYYY YY MMMM MMM MM M DD D dddd ddd HH H mm m ss s; anything else is printed as written',
        arity: { min: 2, max: 2 },
        returns: 'text',
        // Same promise as FORMAT_ISO: a value it cannot read yields nothing,
        // and the write field treats that as "no value".
        literalArgs: [{ index: 1, what: 'the format pattern', check: checkDateFormatPattern }],
        apply: dateFormat,
      }),
      spec('DATE', 'FORMAT_ISO', {
        args: 'value',
        params: [param('value', 'temporal')],
        summary: 'any readable date or timestamp normalised to a full ISO 8601 UTC timestamp',
        arity: { min: 1, max: 1 },
        returns: 'date',
        apply: (args) => dateFormatIso(args[0]),
      }),
      clockSpec('DATE', 'TODAY', {
        args: 'zone',
        params: [param('zone', 'text')],
        summary:
          'the calendar date it is right now in a place — DATE.TODAY("Europe/Berlin") is "2026-03-12" from 00:00 to 23:59 there. The zone is written down (an IANA name like "Europe/Berlin", "America/New_York", "UTC")',
        arity: { min: 1, max: 1 },
        returns: 'date',
        literalArgs: [{ index: 0, what: 'the time zone', check: checkTimeZone }],
        applyAt: dateToday,
      }),
    ],
  },
  {
    namespace: 'DATETIME',
    functions: [
      spec('DATETIME', 'AT', {
        args: 'date, time, zone',
        params: [param('date', 'temporal'), param('time', 'text'), param('zone', 'text')],
        summary:
          'the instant a wall-clock time on a date names in a place — DATETIME.AT("2026-06-15", "07:00", "Europe/Berlin") is 05:00 UTC. Move days with DATE.ADD_DAYS on the date and anchor each end separately, and a daylight-saving change takes care of itself',
        arity: { min: 3, max: 3 },
        returns: 'datetime',
        literalArgs: [
          { index: 1, what: 'the time of day', check: checkWallClockTime },
          { index: 2, what: 'the time zone', check: checkTimeZone },
        ],
        apply: datetimeAt,
      }),
    ],
  },
  {
    namespace: 'TEXT',
    functions: [
      spec('TEXT', 'REGEX_EXTRACT', {
        args: 'text, pattern, group?',
        params: [param('text', 'text'), param('pattern', 'text'), param('group', 'number', { optional: true })],
        summary: 'the first regex match (the first capture group when the pattern has one) — null when nothing matches',
        arity: { min: 2, max: 3 },
        returns: 'text',
        apply: textRegexExtract,
      }),
      spec('TEXT', 'SLUG', {
        args: 'text',
        params: [param('text', 'text')],
        summary: 'a lowercase-hyphen slug — TEXT.SLUG("Acme Corp Ltd.") is "acme-corp-ltd"',
        arity: { min: 1, max: 1 },
        returns: 'text',
        apply: textSlug,
      }),
      spec('TEXT', 'PAIRS', {
        args: 'record, separator?',
        params: [param('record', 'record'), param('separator', 'text', { optional: true })],
        summary:
          'a record or dict rendered as key=value pairs, keys in written order, joined by `separator` (default " | ") — TEXT.PAIRS({ name: "Acme", url: "acme.com" }) is "name=Acme | url=acme.com"; a nested node/edge field is skipped, not stringified',
        arity: { min: 1, max: 2 },
        returns: 'text',
        recordArg: { index: 0 },
        apply: textPairs,
      }),
      spec('TEXT', 'SERIALISE', {
        args: 'value, format',
        params: [param('value', 'any'), param('format', 'text')],
        summary:
          'any value written out as text for a prompt, the same bytes every time it is the same value — TEXT.SERIALISE(deal, "JSON") is the record\'s fields as indented JSON with keys sorted, its nested nodes under their edge names as lists; an absent value is null, a file is its name/type/size and never its contents. The format is written down; "JSON" is the only one so far',
        arity: { min: 2, max: 2 },
        returns: 'text',
        literalArgs: [{ index: 1, what: 'the format', check: checkSerialiseFormat }],
        wholeValueArg: { index: 0 },
        apply: textSerialise,
      }),
    ],
  },
  {
    namespace: 'URL',
    functions: [
      spec('URL', 'HOST', {
        args: 'text',
        params: [param('text', 'text')],
        summary:
          'the host of a URL or a scheme-less address, lowercased and otherwise verbatim (`www.` kept, no port, no path) — URL.HOST("https://WWW.Acme.com:8080/x") is "www.acme.com", URL.HOST("acme.com:8080") is "acme.com"; an email (`joe@acme.com`) is not a host, and text that names no address at all is absent',
        arity: { min: 1, max: 1 },
        returns: 'text',
        maybeAbsent: true,
        apply: urlHost,
      }),
    ],
  },
  {
    namespace: 'NUMBER',
    functions: [
      spec('NUMBER', 'FORMAT', {
        args: 'number, style',
        params: [param('number', 'number'), param('style', 'text')],
        summary:
          'a number written out — "compact" abbreviates with K/M/B/T (NUMBER.FORMAT(1200000, "compact") is "1.2M"); "grouped" adds thousands separators (NUMBER.FORMAT(1200000, "grouped") is "1,200,000")',
        arity: { min: 2, max: 2 },
        returns: 'text',
        maybeAbsent: true,
        literalArgs: [{ index: 1, what: 'the format style', check: checkNumberFormatStyle }],
        apply: numberFormat,
      }),
    ],
  },
];

const FAMILY_BY_NAMESPACE = new Map(
  STDLIB_FAMILIES.map((family) => [family.namespace, family]),
);

const SPEC_BY_ID = new Map(
  STDLIB_FAMILIES.flatMap((family) => family.functions.map((fn) => [fn.id, fn] as const)),
);

/** The family for a written namespace (case-insensitive — function names
 *  are case-insensitive throughout the expression grammar). */
export function stdlibFamily(namespace: string): StdlibFamily | undefined {
  return FAMILY_BY_NAMESPACE.get(namespace.toUpperCase());
}

/** The spec behind a parsed `function` node's dotted `fn` id. */
export function stdlibFunctionById(fn: string): StdlibFunctionSpec | undefined {
  return SPEC_BY_ID.get(fn);
}

export function listStdlibNamespaces(): string[] {
  return STDLIB_FAMILIES.map((family) => family.namespace);
}

/** `GET_NUMBER_FROM_FIGURE(figure), GET_CODE_FROM_FIGURE(figure)` — the
 *  inventory line diagnostics print for a family. */
export function describeStdlibFamily(family: StdlibFamily): string {
  return family.functions
    .map((fn) => `${fn.name}(${fn.signature.slice(fn.signature.indexOf('(') + 1)}`)
    .join(', ');
}
