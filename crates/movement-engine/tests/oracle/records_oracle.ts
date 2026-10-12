// records.json: records held as values, run on the TypeScript engine, which
// tests/records_oracle.rs holds the Rust engine to (Review Focus 3 of chunk
// 7A). Written by generate.ts; deterministic.
//
// Each case is a program whose values arrive untyped, through the event's
// `json` fields (`meta`, a dict, and `more`, a list), so the checker lets
// every reading through: field reads of `Object.prototype`'s names and of
// ordinary ones, present and absent; dicts whose `kind` names a binding kind
// or one of `Object.prototype`'s names, which `bindingOf` takes for records
// (its `in` walks the prototype chain), and plain ones; those values picked
// out of a list, held under a map key, folded, mapped, interpolated. Every
// program ends in `ERROR("${…}")`, so how the run ends says what the reading
// was: the text, or the error a read threw on the way. Each runs under every
// language version; a program the checker refuses under one is dropped there.
//
// Records the run itself holds reach the same readings: the message's
// `items` edge lands two records and each record's `subs` edge one, so a
// walk, a pick, a block's returned records and a write's handle are held as
// values and compared (`==` by identity, else by address), spread, walked
// on, sorted and tested with `EXISTS`; nodes the run built likewise.
//
// The host's registry is keyed by property lookup, as the platform's is: it
// holds `email` and `attio` (which streams its traversals), and fails any
// other slug with its own error. It has a park sink, so a sleep parks.
//
// A case carries its body, the event's payload on the eval wire, the check's
// answer as the shim hands it to the Rust engine (`check.program`), and the
// error the run ended with. The file carries the related records the adapter
// answers, on the eval wire, by edge.

import { languageVersionDiagnostic, mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from '../../../../packages/movement-lang';
import { WireOut } from '../../../../apps/api/src/services/movement_engine/rust_wire';
import { tenantIdOf } from '../../../../packages/engine-contracts';
import { MovementEngineError } from '../../../../apps/api/src/services/movement_engine/errors';
import { checkAnswer, checkPinned } from '../../../../apps/api/src/services/movement_engine/program_check';
import { runFailureCause, runMovement } from '../../../../apps/api/src/services/movement_engine/run';
import { credentialIdsFor, makeFakeParkSink, makeTestHost } from '../../../../apps/api/src/services/movement_engine/test_host';
import type { Adapter, GetRelatedInput, RelatedResult } from '../../../../apps/api/src/services/translation_graph/adapter';
import { makeStablePosition, positionData } from '../../../../apps/api/src/services/translation_graph/types';

type Rand = () => number;

const emailSchema: InstanceSchema = {
  positions: {
    message: { properties: { subject: 'text', meta: 'json', more: 'json' }, edges: { items: { target: 'item' } } },
    item: { properties: { name: 'text', rank: 'number' }, edges: { subs: { target: 'item' } } },
  },
  collections: { item: { target: 'item' } },
  writableRoots: { item: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } } },
};

/** What the adapter's `getRelated` answers, by edge, whatever it walks from. */
const RELATED: Record<string, RelatedResult[]> = {
  items: [
    { position: makeStablePosition({ adapterType: 'email', recordType: 'item', recordId: 'i1', data: { name: 'b', rank: 2 } }) },
    { position: makeStablePosition({ adapterType: 'email', recordType: 'item', recordId: 'i2', data: { name: 'a', rank: 1 } }) },
    // Two filed by GROUPBY / KEYBY under `__proto__`: the answer's prototype.
    { position: makeStablePosition({ adapterType: 'email', recordType: 'item', recordId: 'i3', data: { name: '__proto__', rank: 3 } }) },
    { position: makeStablePosition({ adapterType: 'email', recordType: 'item', recordId: 'i4', data: { name: '__proto__', rank: 4 } }) },
  ],
  subs: [{ position: makeStablePosition({ adapterType: 'email', recordType: 'item', recordId: 's1', data: { name: 'sub', rank: 0 } }) }],
};

export const RECORDS_CATALOG = mockCatalogSnapshot({
  adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema } },
  credentials: { inbox_cred: { adapters: ['email'] } },
});

/** Every case's program, its body in place of `BODY`. */
export const RECORDS_PRELUDE = [
  'import { email } from adapters',
  'import { inbox_cred } from credentials',
  'inbox = email(credentials: inbox_cred)',
  'movement m(msg: <inbox-[:message]->>) {',
  '  v = msg.`meta`',
  '  w = msg.`more`',
  'BODY',
  '}',
].join('\n');

const PROTOTYPE = [
  'constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty', '__lookupGetter__', '__lookupSetter__',
  'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'valueOf', '__proto__', 'toLocaleString',
];
/** A dict the TypeScript reads as a binding of its kind, well formed or not. */
const KINDS = [
  'event', 'instance', 'handle', 'extractRoot', 'extractPosition', 'sourcePosition', 'resource', 'blockMeta',
  'positions', 'tuple', 'closure', 'value', 'shape', 'movement', 'shapePosition', 'nodePosition', 'lazyWalk', 'callback',
  'plugin', 'opaque',
];
/** Ordinary keys, and the ones a binding kind's own reads take. */
const ORDINARY = [
  'name', 'a', 'kind', 'value', 'fields', 'fieldOrder', 'fieldProvenance', 'handle', 'emission', 'resource', 'callbackId', 'url', 'edges', 'landings',
  'position', 'adapterSlug', 'credentialName', 'constructionConfig', 'targetType', 'graph', 'walk', 'slots', 'read', 'edgeProperties', 'schema',
];

/** What a read off the value names: an ordinary key or one of
 *  `Object.prototype`'s, present on the value or not. */
const READ_KEYS = [...ORDINARY, ...PROTOTYPE];

function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function scalar(rand: Rand): unknown {
  return pick(rand, ['x', '', 'Acme', 0, 7, -1.5, true, false, null]);
}

/** A dict as an adapter answers one: a `kind` (a binding's, a prototype
 *  name, an ordinary word, or none) and some keys, each a scalar, a dict or
 *  a list. Own `__proto__` keys are left out, so the seed's stream stays
 *  the one recorded: the wire carries them as keys, and apps/api's
 *  rust_wire_round_trip.unit.test.ts holds them on both engines. */
function dict(rand: Rand, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const roll = rand();
  if (roll < 0.45) out.kind = pick(rand, KINDS);
  // `__proto__` as a VALUE: a string under `kind`, which `in` finds.
  else if (roll < 0.7) out.kind = pick(rand, PROTOTYPE);
  else if (roll < 0.8) out.kind = 'thing';
  const keys = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < keys; i++) {
    const key = pick(rand, [...ORDINARY, ...PROTOTYPE.filter((p) => p !== '__proto__')]);
    if (key === 'kind') continue;
    out[key] = member(rand, key, depth);
  }
  return out;
}

/** A key's value, shaped as a binding kind's own reads would want it about
 *  half the time. */
function member(rand: Rand, key: string, depth: number): unknown {
  if (depth > 1 || rand() < 0.35) return scalar(rand);
  switch (key) {
    case 'fields':
    case 'fieldProvenance':
    case 'edges':
      return { a: scalar(rand), name: scalar(rand), ...(rand() < 0.3 ? { toString: 't' } : {}) };
    case 'fieldOrder':
      return rand() < 0.8 ? ['a', 'name'] : 'a';
    case 'handle':
      return { writtenValues: { name: scalar(rand) }, resultData: { a: scalar(rand) }, ...(rand() < 0.5 ? { externalId: 'e1' } : {}), adapterType: 'crm' };
    case 'emission':
      return { fields: { a: scalar(rand), name: scalar(rand) }, provenance: {} };
    case 'resource':
      return { data: { a: scalar(rand) }, name: 'r.pdf' };
    case 'landings':
    case 'slots':
      return pick(rand, [() => [dict(rand, depth + 1)], () => [[dict(rand, depth + 1)], scalar(rand)], () => 'ab', () => [null], () => ({ a: 1 })])();
    case 'adapterSlug':
      return pick(rand, ['email', 'nope', 5, true, null]);
    case 'credentialName':
      return pick(rand, ['inbox_cred', 'missing', 0, 7]);
    case 'constructionConfig':
      return pick(rand, [{ base: 'b1' }, { base: '"q"' }, 5, 'ab', ['x'], { k: 5 }, null]);
    case 'schema':
      return pick(rand, [
        { positions: {}, collections: {} },
        { positions: { item: { properties: { name: 'text' }, edges: { subs: { target: 'item' } } } }, collections: {}, writableRoots: {} },
        'x',
      ]);
    case 'targetType':
      return pick(rand, ['item', 'message']);
    case 'graph':
      return { instance: { kind: 'instance', name: 'inbox', adapterSlug: 'email', credentialName: 'inbox_cred' } };
    case 'walk': {
      const head = pick(rand, [
        { root: { kind: 'name', name: 'e' }, hopsRaw: '-[a:items]->', span: { start: 0, end: 0 } },
        { root: { kind: 'name', name: 'gone' }, hopsRaw: '-[a:items]->' },
        { hopsRaw: '-[:items]->' },
      ]);
      const captured = pick(rand, [{}, { x: 1 }, [['e', { kind: 'event' }]], [['e', { kind: 'sourcePosition', position: { adapterType: 'email', recordType: 'item', identity: { kind: 'stable', recordId: 'p1', data: { name: 'x' } } } }]], [], [['e']], 'ab', [5], [['e', 'v']]]);
      return { head, captured };
    }
    case 'read':
      return { instanceName: 'inbox' };
    case 'edgeProperties':
      return { a: scalar(rand) };
    case 'position':
      return rand() < 0.7
        ? { adapterType: 'email', recordType: 'item', identity: { kind: 'stable', recordId: 'p1', data: { name: scalar(rand) } } }
        : dict(rand, depth + 1);
    default:
      return rand() < 0.5 ? dict(rand, depth + 1) : [scalar(rand), dict(rand, depth + 1)];
  }
}

function payload(rand: Rand): Record<string, unknown> {
  const more: unknown[] = [];
  const n = Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) more.push(rand() < 0.85 ? dict(rand, 1) : scalar(rand));
  return { subject: 'Acme', meta: dict(rand, 0), more };
}

/** A body over `v` (the dict) and `w` (the list), ending in an `ERROR` that
 *  says what it read. */
function body(rand: Rand): { template: number; text: string } {
  const template = Math.floor(rand() * 36);
  return { template, text: bodyOf(template, rand) };
}

function bodyOf(template: number, rand: Rand): string {
  const k = () => pick(rand, READ_KEYS);
  const lines = (...ls: string[]) => ls.map((l) => `  ${l}`).join('\n');
  // A field written backticked when it is no plain name.
  const f = (key: string) => (/^[A-Za-z][A-Za-z0-9]*$/.test(key) ? key : `\`${key}\``);
  const [k1, k2] = [k(), k()];
  switch (template) {
    case 0:
      return lines(`ERROR("\${v.${f(k1)}}")`);
    case 1:
      return lines(`x = v.${f(k1)}`, 'ERROR("${x}")');
    case 2:
      return lines(`key = "${k1}"`, 'y = AT(v, key)', 'ERROR("${IF y == null THEN "absent" ELSE "present" END}")');
    case 3:
      return lines('x = FIRST(w)', `ERROR("\${x.${f(k1)}}")`);
    case 4:
      return lines('x = AT(w, 1)', `ERROR("\${x.${f(k1)}}")`);
    case 5:
      return lines('n = COUNT(w)', 'x = FIRST(w)', 'ERROR("${n} ${x == null}")');
    case 6:
      return lines(`ERROR("\${v.${f(k1)}.${f(k2)}}")`);
    case 7:
      return lines(`p = IF v.${f(k1)} == null THEN "absent" ELSE "present" END`, 'ERROR(p)');
    case 8:
      return lines('x = FIRST(w)', `y = x.${f(k1)}`, `z = IF y == null THEN "absent" ELSE "present" END`, 'ERROR("${y} ${z}")');
    case 9:
      return lines('rows = MAP(msg-[i:items ORDER BY `name`]->, (e) => {', '    return e.name', '  })', 'ERROR("${COUNT(rows)} ${JOIN(rows, ",")}")');
    case 10:
      return lines('kept = FILTER(msg-[i:items ORDER BY `name`]->, (e) => {', `    return e.name != "${pick(rand, ['a', 'b', '__proto__'])}"`, '  })', 'ERROR("${COUNT(kept)}")');
    case 11:
      return lines('held = { k: v }', `ERROR("\${held.k.${f(k1)}}")`);
    case 12:
      return lines('both = [v, FIRST(w)]', 'x = AT(both, 0)', `ERROR("\${x.${f(k1)}} \${COUNT(both)}")`);
    case 13:
      return lines('x = FIRST(w)', 'y = x', `ERROR("\${y.${f(k1)}}")`);
    case 14:
      return lines('all = MAP(msg-[i:items ORDER BY `name`]->, (e) => {', '    return e', '  })', 'x = FIRST(all)', 'ERROR("${x.name} ${x.rank}")');
    case 16:
      return lines('rs = msg-[i:items ORDER BY `name`]->', 'a = FIRST(rs)', 'b = AT(rs, 0)', 'c = FIRST(msg-[j:items ORDER BY `name`]->)', 'ERROR("${a == b} ${a == c} ${a != c} ${b == AT(rs, 1)}")');
    case 17:
      return lines('d = node { a: 1 }', 'e = node { a: 1 }', 'l = [d, e]', 'f = FIRST(l)', 'ERROR("${f == d} ${d == e} ${AT(l, 1) == e} ${f.a}")');
    case 18:
      return lines('d = node { a: 1, name: "n" }', 'held = { ...d }', 'x = FIRST(w)', 'n = { ...x }', `y = n.${f(k1)}`, 'ERROR("${held.name} ${IF y == null THEN "absent" ELSE "present" END}")');
    case 19:
      return lines('rs = msg-[i:items ORDER BY `name`]->', 'x = FIRST(w)', 'ERROR("${EXISTS(rs-[:subs]->)} ${EXISTS(w-[:items]->)} ${EXISTS(v-[:items]->)} ${EXISTS(x-[:items]->)}")');
    case 20:
      return lines(`ERROR("\${EXISTS(w WHERE \`${k1}\` == \"x\")} \${EXISTS(v WHERE \`${k1}\` != null)}")`);
    case 21:
      return lines('x = FIRST(msg-[i:items ORDER BY `name`]->)', 'ERROR("${JOIN(x-[s:subs ORDER BY `name`]->.name, ",")} ${COUNT(x-[:subs]->)}")');
    case 22:
      return lines(`y = v-[:items]->.${f(k1)}`, 'ERROR("${IF y == null THEN "absent" ELSE "present" END}")');
    case 23:
      return lines('entries = msg-[c:items]-> {', '    return c', '  }', 's = SORT(entries, name)', 'top = FIRST(s)', 'ERROR("${top.name} ${COUNT(s)}")');
    case 24:
      return lines(`s = SORT(w, \`${k1}\`)`, 'top = FIRST(s)', `y = top.${f(k2)}`, 'ERROR("${IF y == null THEN "absent" ELSE "present" END}")');
    case 25:
      return lines('x = FIRST(w)', `y = x-[:${pick(rand, ['items', 'subs', 'files'])}]->.${f(k1)}`, `z = COUNT(x-[:items]->)`, 'ERROR("${IF y == null THEN "absent" ELSE "present" END} ${z}")');
    case 26:
      return lines('x = FIRST(w)', 'y = x', 'ERROR("${y == null} ${x != null} ${AT(w, 5) == null}")');
    case 27:
      return lines('co = write inbox-[:item]-> { name: "w" }', 'l = [co]', 'g = FIRST(l)', 'ERROR("${g == co} ${g.name} ${COUNT(l)}")');
    case 28:
      return lines(
        'g = GROUPBY(msg-[i:items ORDER BY `name`]->, (e) => {',
        '    return e.name',
        '  })',
        'k = KEYBY(msg-[j:items ORDER BY `rank`]->, (e) => {',
        '    return IF e.rank > 2 THEN "__proto__" ELSE e.name END',
        '  })',
        `y = AT(${pick(rand, ['g', 'k'])}, "${pick(rand, ['__proto__', 'a', 'b', 'length'])}")`,
        `z = ${pick(rand, ['g', 'k'])}.${pick(rand, ['push', 'join', 'a', 'b', 'rank', 'length', '`__proto__`', 'toString', 'name'])}`,
        'ERROR("${COUNT(g)} ${COUNT(k)} ${IF y == null THEN "absent" ELSE "present" END} ${IF z == null THEN "absent" ELSE "present" END}")',
      );
    case 29:
      return lines('x = FIRST(msg-[i:items ORDER BY `name`]->)', `key = "${pick(rand, ['kind', 'position', 'read', 'edgeProperties', 'name', 'identity'])}"`, 'y = AT(x, key)', 'ERROR("${IF y == null THEN "absent" ELSE "present" END}")');
    case 30:
      return lines('x = FIRST(w)', `y = x.${f(k1)}`, 'xs = [x]', 'z = FIRST(xs)', `q = z.${f(k2)}`, 'ERROR("${IF y == null THEN "absent" ELSE "present" END} ${IF q == null THEN "absent" ELSE "present" END}")');
    case 31:
      return lines('xs = msg-[c:items ORDER BY `name`]-> {', '    return c', '  }', 'all = MAP(xs, (r) => {', '    return r', '  })', 'f = FIRST(all)', 'ERROR("${COUNT(all)} ${f == FIRST(xs)} ${f.name}")');
    case 33:
      return lines(
        `g = GROUPBY(${pick(rand, ['[[1], [2, 3]]', '[[1], [2, 3], [4]]', '[[2, 3], [1]]'])}, (x) => {`,
        '    return IF COUNT(x) == 1 THEN "__proto__" ELSE "0" END',
        '  })',
        `y = g.${pick(rand, ['push', 'join', 'length', '`0`', 'a'])}`,
        'ERROR("${COUNT(g)} ${IF y == null THEN "absent" ELSE "present" END}")',
      );
    // A filing onto a list the prototype holds: the lists hold themselves.
    case 34:
      return lines(
        'a = [1]',
        'b = [a, a]',
        'g = GROUPBY([a, b], (x) => {',
        '    return IF COUNT(x) == 1 THEN "__proto__" ELSE "0" END',
        '  })',
        `ERROR("${pick(rand, ['${COUNT(a)}', '${a}', '${b}', '${a == b}', '${JOIN(a, ",")}', '${COUNT(g)}'])}")`,
      );
    // Hops past a kept walk, their WHERE over names declared after it.
    case 35: {
      const cap = 'cap = 1';
      const lazy = pick(rand, ['files = lazy msg-[a:items]->', 'files = lazy msg-[a:items ORDER BY `rank` LIMIT 2]->']);
      const order = pick(rand, [[cap, lazy], [lazy, cap], [lazy, cap, 'a = 7']]);
      const root = pick(rand, ['files', 'held']);
      const where = pick(rand, ['', ' WHERE s.`rank` < cap', ' WHERE a == 7', ' WHERE s.`rank` == 0']);
      return lines(...order, 'held = [files]', `n = COUNT(${root}-[s:subs${where}]->)`, 'ERROR("${n}")');
    }
    default:
      return lines(`x = v.${f(k1)}`, `ERROR("\${x.${f(k2)}}")`);
  }
}

/** A plain email adapter: a field reads the position's data. */
const adapter: Adapter = {
  adapterType: 'email',
  supportedTriggers: [],
  runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
  listEntryPoints: async () => [],
  describe: async () => null,
  resolveEntity: async () => ({ candidates: [] }),
  getFieldValue: async (input) => {
    const data = positionData(input.position);
    return typeof data === 'object' && data !== null ? Reflect.get(data, input.fieldId) : undefined;
  },
  getRelated: async (input) => RELATED[input.fieldId] ?? [],
  createRecord: async () => ({ adapterType: 'email', externalId: 'w1', data: { name: 'w' } }),
  updateRecord: async () => {
    throw new Error('the oracle writes nothing');
  },
  deleteRecord: async () => ({}),
};

/** An adapter that streams its traversals (`iterateRelated`), answering as
 *  the email adapter does. */
const streaming: Adapter = {
  ...adapter,
  adapterType: 'attio',
  // eslint-disable-next-line @typescript-eslint/require-await -- the stream's shape is the contract's
  async *iterateRelated(input: GetRelatedInput) {
    yield* RELATED[input.fieldId] ?? [];
  },
};

/** The registry, keyed as the platform's is: by property lookup, so a slug
 *  is read as its text, and one naming no adapter is the host's own error. */
const REGISTRY: Record<string, Adapter> = { email: adapter, attio: streaming };
function resolveAdapter({ adapterType }: { adapterType: string }): Adapter {
  const found = REGISTRY[adapterType];
  if (found === undefined) throw new Error(`Unknown adapter type: ${adapterType}`);
  return found;
}

/** `RELATED` on the eval wire, by edge (the harness answers each edge's
 *  walk with it). */
function related(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(RELATED).map(([edge, results]) => [edge, new WireOut().value(results)]));
}

/** How the run ended, as the Rust engine's error reports it. */
function ending(error: unknown): unknown {
  const cause = runFailureCause(error) ?? error;
  if (cause instanceof MovementEngineError) {
    const prefix = `${cause.code}: `;
    return { class: 'MovementEngineError', code: cause.code, message: cause.message.startsWith(prefix) ? cause.message.slice(prefix.length) : cause.message };
  }
  if (cause instanceof Error) return { class: cause.name, message: cause.message };
  return { class: 'thrown', message: String(cause) };
}

/** Cases written out, each with its reason: where the TypeScript forgives a
 *  member's failure under `onError` and where it walks on past a held walk,
 *  the engines must fail (or not) alike. */
const PINNED: Array<{ text: string; data: Record<string, unknown> }> = [
  // A kept walk held in a list, walked on past: the TypeScript walks on.
  { text: '  files = lazy msg-[a:items]->\n  held = [files]\n  n = COUNT(held-[:subs]->)\n  ERROR("${n}")', data: { subject: 'Acme', meta: {}, more: [] } },
  {
    text: '  files = lazy msg-[a:items]->\n  held = [files]\n  ys = MAP([1], { onError: "ignore" }, (i) => {\n    return COUNT(held-[:subs]->)\n  })\n  ERROR("${COUNT(ys)}")',
    data: { subject: 'Acme', meta: {}, more: [] },
  },
  // A text where records belong: the TypeScript fails each member, and
  // forgives it.
  {
    text: '  ys = MAP([1, 2], { onError: "ignore" }, (i) => {\n    return COUNT(v-[:items]->)\n  })\n  ERROR("${COUNT(ys)}")',
    data: { subject: 'Acme', meta: { kind: 'positions', landings: 'ab' }, more: [] },
  },
  {
    text: '  ys = MAP([1, 2], { onError: "ignore" }, (i) => {\n    return COUNT(v-[:items]->)\n  })\n  ERROR("${COUNT(ys)}")',
    data: { subject: 'Acme', meta: { kind: 'lazyWalk', walk: { captured: {} } }, more: [] },
  },
  // A list that holds itself, parked and serialised: the recursive writers
  // run out of stack.
  ...[
    '  await sleep(1h)\n  ERROR("${COUNT(a)}")',
    '  held = { k: a }\n  await sleep(1h)\n  ERROR("${COUNT(a)}")',
    '  await sleep(1h)\n  ERROR("parked")',
    '  ERROR("${TEXT.SERIALISE(a, "JSON")}")',
    '  ERROR("${TEXT.SERIALISE(b, "JSON")}")',
    '  ys = MAP([1, 2], { onError: "ignore" }, (i) => {\n    return TEXT.SERIALISE(a, "JSON")\n  })\n  ERROR("${COUNT(ys)}")',
  ].map((tail) => ({
    text: `  a = [1]\n  b = [a, a]\n  g = GROUPBY([a, b], (x) => {\n    return IF COUNT(x) == 1 THEN "__proto__" ELSE "0" END\n  })\n${tail}`,
    data: { subject: 'Acme', meta: {}, more: [] },
  })),  // An own `__proto__` key the host's JSON holds, spread in: a spread
  // assigns it, so `null` leaves an object with no prototype, which is
  // still a dict (`isDictValue`); an object becomes the prototype.
  ...[
    '  s = { ...v }\n  t = { ...s }\n  ERROR("${TEXT.SERIALISE(AT(s, "a"), "JSON")} ${TEXT.SERIALISE(AT(t, "a"), "JSON")} ${TEXT.SERIALISE(t, "JSON")}")',
    '  s = { ...v }\n  ERROR("${TEXT.SERIALISE(v, "JSON")} ${TEXT.SERIALISE(s.`x`, "JSON")} ${TEXT.SERIALISE(s.`toString`, "JSON")}")',
  ].flatMap((text) =>
    ['{"a":1,"__proto__":null}', '{"a":1,"__proto__":{"x":2}}', '{"a":1,"__proto__":5}'].map((meta) => ({
      text,
      data: { subject: 'Acme', meta: JSON.parse(meta), more: [] },
    })),
  ),
];

/** Each walk or instance a dict holds whose reading the TypeScript does not
 *  refuse: a kept walk's mapping (with entries, nested nodes, graphs),
 *  captured pairs keyed by no text or bound twice, hops that are no text,
 *  roots named by no text, an expression root, a captured scope that roots
 *  the head at a node, a kept walk, a meta-node or a callback, instances
 *  whose own schema is no instance schema (walked through a streaming
 *  instance too), and slugs the registry reads as their text or knows no
 *  adapter by. */
const EVENT = { kind: 'event' };
const ITEMS = { root: { kind: 'name', name: 'e' }, hopsRaw: '-[:items]->' };
const DIRECTED_DICTS: Array<Record<string, unknown>> = [
  { kind: 'lazyWalk', walk: { captured: [['e', EVENT]], mapping: {}, head: ITEMS } },
  { kind: 'lazyWalk', walk: { captured: [['e', EVENT]], mapping: null, head: ITEMS } },
  { kind: 'lazyWalk', walk: { captured: [[5, EVENT], ['e', EVENT]], head: ITEMS } },
  { kind: 'lazyWalk', walk: { captured: [['e', EVENT], ['e', 0]], head: ITEMS } },
  { kind: 'lazyWalk', walk: { captured: [['e', EVENT]], head: { root: { kind: 'name', name: 'e' }, hopsRaw: 5 } } },
  { kind: 'lazyWalk', walk: { captured: [['e', EVENT]], head: { root: { kind: 'name', name: 'e' }, hopsRaw: '-[a:items]->-[b:subs]->' } } },
  { kind: 'lazyWalk', walk: { captured: [['e', EVENT]], head: { root: { kind: 'expr', expr: { type: 'alias_ref', name: 'e' } }, hopsRaw: '-[:items]->' } } },
  { kind: 'lazyWalk', walk: { captured: [[5, EVENT]], head: { hopsRaw: '-[:items]->' } } },
  { kind: 'lazyWalk', walk: { captured: [['e', { kind: 'nodePosition', edges: {} }]], head: ITEMS } },
  { kind: 'lazyWalk', walk: { captured: [['e', { kind: 'nodePosition', edges: { items: { kind: 'landed', landings: [EVENT] } } }]], head: ITEMS } },
  { kind: 'lazyWalk', walk: { captured: [['e', { kind: 'lazyWalk', walk: { captured: [['f', EVENT]], head: { root: { kind: 'name', name: 'f' }, hopsRaw: '-[:items]->' } } }]], head: ITEMS } },
  { kind: 'lazyWalk', walk: { captured: [['e', { kind: 'lazyWalk', walk: { captured: {} } }]], head: ITEMS } },
  { kind: 'lazyWalk', walk: { captured: [['e', { kind: 'blockMeta', edges: {} }]], head: ITEMS } },
  { kind: 'lazyWalk', walk: { captured: [['e', { kind: 'callback', callbackId: 'c1' }]], head: ITEMS } },
  { kind: 'instance', name: 'inbox', adapterSlug: 'email', credentialName: 'inbox_cred', schema: 'x' },
  { kind: 'instance', name: 'inbox', adapterSlug: 'email', credentialName: 'inbox_cred', schema: { positions: {} } },
  { kind: 'instance', name: 'inbox', adapterSlug: 5, credentialName: 'inbox_cred' },
  // Slugs the registry keys by their text, or names no adapter by.
  { kind: 'instance', name: 'inbox', adapterSlug: ['email'], credentialName: 'inbox_cred' },
  { kind: 'instance', name: 'inbox', credentialName: 'inbox_cred' },
  { kind: 'instance', name: 'inbox', adapterSlug: 'nope', credentialName: 'inbox_cred' },
  // Kept walks through a streaming instance, whose own schema is no instance
  // schema: no read wrapper touches the stream.
  ...[{ positions: {} }, 'x', { positions: {}, selectedMembers: {} }, undefined].flatMap((schema) =>
    ['-[:items]->', '-[:items WHERE `rank` > 1]->'].map((hopsRaw) => ({
      kind: 'lazyWalk',
      walk: {
        captured: [['e', { kind: 'instance', name: 'crm', adapterSlug: 'attio', credentialName: 'inbox_cred', ...(schema !== undefined ? { schema } : {}) }]],
        head: { root: { kind: 'name', name: 'e' }, hopsRaw },
      },
    })),
  ),
  // Heads rooted at a name that is no text: spelled as its text, bound by
  // the very value.
  ...[5, null, true, {}, ['e'], { toString: 'x' }].map((name) => ({ kind: 'lazyWalk', walk: { captured: [['e', EVENT]], head: { root: { kind: 'name', name }, hopsRaw: '-[:items]->' } } })),
  { kind: 'lazyWalk', walk: { captured: [[5, EVENT]], head: { root: { kind: 'name', name: 5 }, hopsRaw: '-[:items]->' } } },
  { kind: 'lazyWalk', walk: { captured: [['5', EVENT]], head: { root: { kind: 'name', name: 5 }, hopsRaw: '-[:items]->' } } },
  // Mappings with entries, and graphs.
  ...[
    { entries: [] },
    { entries: 'ab' },
    { entries: [{ kind: 'thing' }, 5, null] },
    { entries: [{ kind: 'declared', name: 'subs', type: { hopsRaw: 'x' } }] },
    { entries: [{ kind: 'declared', name: 'subs', type: { graph: 'e' } }] },
    { entries: [{ kind: 'declared', name: 'subs' }] },
    { entries: [{ kind: 'nodes', name: 'subs', nodes: [{ entries: [] }, { entries: [{ kind: 'nodes', name: 'items', nodes: [{ entries: [] }] }] }] }] },
    { entries: [{ kind: 'nodes', name: 'subs', nodes: 'ab' }] },
    { entries: [{ kind: 'nodes', name: 'subs', nodes: [null] }] },
    { entries: [{ kind: 'nodes', name: 'subs', nodes: 5 }] },
    { entries: [{ kind: 'nodes', name: 'subs', nodes: [[]] }] },
    [],
    { entries: [], graph: {} },
    { entries: 'ab', graph: {} },
    { graph: {} },
    { entries: [], graph: null },
    { entries: [], graph: { shape: { name: 'S' } } },
    { entries: [], graph: { shape: { name: 'e' } } },
    { entries: [], graph: { shape: 5 } },
    { entries: [null], graph: {} },
    { entries: [{ kind: 'thing', name: 'q' }], graph: {} },
    { entries: [{ kind: 'nodes', name: 'subs', nodes: [{ entries: [] }] }], graph: {} },
    { entries: [{ kind: 'nodes', name: 'subs', nodes: [[]] }], graph: {} },
    { entries: [{ kind: 'nodes', name: 'subs', nodes: ['a'] }], graph: {} },
    { entries: [{ kind: 'declared', name: 'subs' }], graph: {} },
    { entries: [], graph: {}, spreads: [] },
    { entries: [], graph: {}, spreads: 'ab' },
    { entries: [{ kind: 'thing' }], graph: {}, spreads: [{ after: 5 }] },
    { entries: [{ kind: 'thing' }], graph: {}, spreads: [null] },
  ].map((mapping) => ({ kind: 'lazyWalk', walk: { captured: [['e', EVENT]], head: ITEMS, mapping } })),
  { kind: 'lazyWalk', walk: { captured: [['e', EVENT]], head: { root: { kind: 'name', name: 'e' }, hopsRaw: '-[a:items]->' }, mapping: { entries: [], graph: { shape: { name: 'a' } } } } },
  // A mapping naming a declaration in scope that a dict stands for.
  ...[{ entries: [], graph: { shape: { name: 'S' } } }, { entries: [{ kind: 'declared', name: 'subs', type: { graph: 'S' } }] }].map((mapping) => ({
    kind: 'lazyWalk',
    walk: { captured: [['e', EVENT], ['S', { kind: 'shape' }]], head: ITEMS, mapping },
  })),
  // Edges a mapping names by any value.
  ...[5, '0', '__proto__', null, ['subs'], 'subs'].flatMap((name) =>
    [{ entries: [{ kind: 'nodes', name, nodes: [{ entries: [] }] }] }, { entries: [{ kind: 'nodes', name, nodes: [{ entries: [] }] }], graph: {} }].map((mapping) => ({
      kind: 'lazyWalk',
      walk: { captured: [['e', EVENT]], head: ITEMS, mapping },
    })),
  ),
  // Instance dicts whose own schema has positions and no collections, paged
  // or not: a WHERE's member check, and hops off what landed.
  ...['email', 'attio'].flatMap((adapterSlug) =>
    [
      { positions: { meta: { edges: { items: { target: 'item' } } } }, selectedMembers: {} },
      { positions: { item: { edges: { subs: { target: 'item' } } } } },
      { positions: { item: { edges: { subs: { target: 'item' } } } }, unions: { item: {} } },
      { positions: { item: { edges: { subs: { target: 'thing' } } } }, selectedMembers: {} },
    ].flatMap((schema) =>
      ['-[:items]->', '-[:items WHERE `rank` > 1]->'].map((hopsRaw) => ({
        kind: 'lazyWalk',
        walk: { captured: [['e', { kind: 'instance', name: 'crm', adapterSlug, credentialName: 'inbox_cred', schema }]], head: { root: { kind: 'name', name: 'e' }, hopsRaw } },
      })),
    ),
  ),
];
/** The reads each directed dict meets: walked on, walked, forgiven, and as a
 *  block's head. */
const DIRECTED_BODIES = [
  '  n = COUNT(v-[:subs]->)\n  ERROR("${n}")',
  '  n = COUNT(v-[:items]->)\n  ERROR("${n}")',
  '  ys = MAP([1, 2], { onError: "ignore" }, (i) => {\n    return COUNT(v-[:subs]->)\n  })\n  ERROR("${COUNT(ys)}")',
  '  xs = v-[s:subs]-> {\n    return s\n  }\n  ERROR("${COUNT(xs)}")',
];

export async function writeRecordsOracle(rand: Rand, write: (name: string, text: string) => void): Promise<void> {
  const cases: unknown[] = [];
  const counts = { tried: 0, refused: 0 };
  const generated = Array.from({ length: 1200 }, () => ({ ...body(rand), data: payload(rand) }));
  const directed = DIRECTED_DICTS.flatMap((meta) => DIRECTED_BODIES.map((text) => ({ template: -2, text, data: { subject: 'Acme', meta, more: [] } })));
  const all = [...generated, ...PINNED.map((p) => ({ template: -1, text: p.text, data: p.data })), ...directed];
  for (const { template, text, data } of all) {
    const source = RECORDS_PRELUDE.replace('BODY', text);
    for (const version of [1, 2, 3] as LanguageVersion[]) {
      counts.tried += 1;
      let check: unknown;
      try {
        const versionWarning = languageVersionDiagnostic(version);
        check = {
          ...checkAnswer(checkPinned({ source, catalog: RECORDS_CATALOG, languageVersion: version })),
          ...(versionWarning !== undefined ? { versionWarning: { code: versionWarning.code, message: versionWarning.message } } : {}),
        };
      } catch {
        counts.refused += 1;
        continue;
      }
      let outcome: unknown;
      try {
        await runMovement({
          source,
          languageVersion: version,
          event: { pipelineInputId: 'p', adapterType: 'email', triggerType: 'webhook', payload: data },
          catalog: RECORDS_CATALOG,
          teamId: tenantIdOf('00000000-0000-0000-0000-0000000000a7'),
          credentialIds: credentialIdsFor(RECORDS_CATALOG, (name) => `cred-${name}`),
          host: makeTestHost({ adapters: { resolve: resolveAdapter }, park: { sink: makeFakeParkSink().sink } }),
        });
        outcome = { completed: true };
      } catch (error) {
        outcome = { error: ending(error) };
      }
      cases.push({ version, template, body: text, payload: new WireOut().value(data), check, outcome });
    }
  }
  write(
    'records.json',
    `{"catalog":${JSON.stringify(RECORDS_CATALOG)},"prelude":${JSON.stringify(RECORDS_PRELUDE)},"related":${JSON.stringify(related())},"cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`,
  );
  console.log(`records.json: ${cases.length} cases (${counts.refused} of ${counts.tried} refused by the checker and left out)`);
}
