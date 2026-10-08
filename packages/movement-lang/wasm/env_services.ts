// The environment services the Rust engine asks its JavaScript host for
// (crates/movement-engine/src/env_services.rs, `EnvServices`): the zone
// database, WHATWG URL parsing, locale number formatting and Unicode
// normalisation, answered by the very runtime the TypeScript engine runs on,
// so the two engines read zones, URLs and text alike by construction.
//
// The loader hands every instance `answerEnvRequest` as its `movement_env`
// import; crates/movement-engine/tests/env/generate.ts writes the native
// implementation's fixture through it too. Each answer is `{value}`.

// Declared here rather than taken from a lib, as the loader declares its
// globals: this package compiles without the DOM and Node libs.
declare const URL: new (text: string) => {
  href: string;
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
};

/** The wall-clock reading of an instant in a zone. */
export interface ZonedFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  offsetMinutes: number;
  weekday: number;
}

export type EnvRequest =
  | { op: 'tz_convert'; instantIso: string; zone: string }
  | { op: 'url_parse'; text: string }
  | { op: 'number_format'; value: number; locale: string; options: NumberOptions }
  | { op: 'normalize'; text: string; form: NormalForm }
  /** The wall clock (or the instant `withEnvNow` holds), which only a park's
   *  wake time reads. */
  | { op: 'now' };

export interface NumberOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  useGrouping?: boolean;
}

export type NormalForm = 'NFC' | 'NFD' | 'NFKC' | 'NFKD';

const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

/** As packages/shared/timezone's `formatterFor`, and null for a zone `Intl`
 *  refuses (cron's `isValidTimeZone`). */
function formatterFor(zone: string): Intl.DateTimeFormat | null {
  let formatter = FORMATTERS.get(zone);
  if (formatter === undefined) {
    try {
      formatter =
        zone.length === 0
          ? null
          : new Intl.DateTimeFormat('en-US', {
              timeZone: zone,
              hourCycle: 'h23',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            });
    } catch {
      formatter = null;
    }
    FORMATTERS.set(zone, formatter);
  }
  return formatter;
}

/** packages/shared/timezone's `localFields`, with the instant's milliseconds
 *  and its offset beside. */
export function tzConvert(instantIso: string, zone: string): ZonedFields | null {
  const formatter = formatterFor(zone);
  if (formatter === null) return null;
  const instant = new Date(instantIso).getTime();
  const parts = formatter.formatToParts(new Date(instant));
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  const [year, month, day, hour, minute, second] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map(get);
  const millisecond = ((instant % 1000) + 1000) % 1000;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
    offsetMinutes: (wall + millisecond - instant) / 60_000,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

export function urlParse(text: string): Record<string, string> | null {
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const { href, protocol, username, password, host, hostname, port, pathname, search, hash } = url;
  return { href, protocol, username, password, host, hostname, port, pathname, search, hash };
}

export function numberFormat(value: number, locale: string, options: NumberOptions): string | null {
  if (!Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat(locale, { ...options }).format(value);
  } catch {
    return null;
  }
}

// Bridge — delete with the Rust engine merge (5B), when the Rust engine asks
// the host's `clock.now` itself.
/** The instant `now` answers while a caller holds it (`withEnvNow`); the
 *  wall clock otherwise. */
let heldNowMs: number | undefined;

/**
 * Run `body` — one synchronous step of an engine segment — with the `now`
 * service answering `nowMs`. A run host that takes its time from its own host
 * (`clock.now`) holds the engine's environment clock at the segment's pinned
 * instant, and re-bases what the engine computed from it on the host's answer.
 * Synchronous, so no other segment's step can run inside it. Internal: the
 * movement engine's Rust shim imports it from this module, not the package.
 * Bridge — delete with the Rust engine merge (5B).
 */
export function withEnvNow<T>(nowMs: number, body: () => T): T {
  const previous = heldNowMs;
  heldNowMs = nowMs;
  try {
    return body();
  } finally {
    heldNowMs = previous;
  }
}

/** One request's answer, `{value}`. Throws for a request it cannot read. */
export function answerEnvRequest(request: unknown): { value: unknown } {
  const r = readRequest(request);
  switch (r.op) {
    case 'tz_convert':
      return { value: tzConvert(r.instantIso, r.zone) };
    case 'url_parse':
      return { value: urlParse(r.text) };
    case 'number_format':
      return { value: numberFormat(r.value, r.locale, r.options) };
    case 'normalize':
      return { value: r.text.normalize(r.form) };
    case 'now':
      return { value: heldNowMs ?? Date.now() };
    default: {
      const unread: never = r;
      throw new Error(`no environment service ${JSON.stringify(unread)}`);
    }
  }
}

function readRequest(request: unknown): EnvRequest {
  if (typeof request !== 'object' || request === null) throw new Error('an environment request is an object');
  const field = (name: string): unknown => Reflect.get(request, name);
  const text = (name: string): string => {
    const value = field(name);
    if (typeof value !== 'string') throw new Error(`an environment request's ${name} is a string`);
    return value;
  };
  const op = text('op');
  switch (op) {
    case 'tz_convert':
      return { op, instantIso: text('instantIso'), zone: text('zone') };
    case 'url_parse':
      return { op, text: text('text') };
    case 'number_format': {
      const value = field('value');
      const options = field('options');
      if (typeof value !== 'number') throw new Error('a number_format value is a number');
      return { op, value, locale: text('locale'), options: readNumberOptions(options) };
    }
    case 'normalize': {
      const form = text('form');
      if (form !== 'NFC' && form !== 'NFD' && form !== 'NFKC' && form !== 'NFKD') {
        throw new Error(`no normalisation form ${form}`);
      }
      return { op, text: text('text'), form };
    }
    case 'now':
      return { op };
    default:
      throw new Error(`no environment service ${op}`);
  }
}

function readNumberOptions(options: unknown): NumberOptions {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null) throw new Error('number_format options are an object');
  const read: NumberOptions = {};
  const digits = (name: 'minimumFractionDigits' | 'maximumFractionDigits') => {
    const value: unknown = Reflect.get(options, name);
    if (value === undefined) return;
    if (typeof value !== 'number') throw new Error(`number_format ${name} is a number`);
    read[name] = value;
  };
  digits('minimumFractionDigits');
  digits('maximumFractionDigits');
  const grouping: unknown = Reflect.get(options, 'useGrouping');
  if (grouping !== undefined) {
    if (typeof grouping !== 'boolean') throw new Error('number_format useGrouping is a boolean');
    read.useGrouping = grouping;
  }
  return read;
}
