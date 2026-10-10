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
import { credentialIdsFor, makeTestHost } from '../../../../apps/api/src/services/movement_engine/test_host';
import type { Adapter } from '../../../../apps/api/src/services/translation_graph/adapter';
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
const RELATED: Record<string, unknown[]> = {
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
  'position', 'adapterSlug', 'credentialName', 'constructionConfig', 'targetType', 'graph', 'walk', 'slots', 'read', 'edgeProperties',
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
 *  a list. Own `__proto__` keys are left out: the shim refuses an event that
 *  holds one (`event_does_not_cross`), and so does a JSON host. */
function dict(rand: Rand, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const roll = rand();
  if (roll < 0.45) out.kind = pick(rand, KINDS);
  // `__proto__` as a VALUE: a string under `kind`, which `in` finds.
  else if (roll < 0.7) out.kind = pick(rand, PROTOTYPE);
  else if (roll < 0.8) out.kind = 'thing';
  // An instance's slug is text, as the host contract takes it (the engine
  // refuses, by name, to ask for one that is not).
  if (out.kind === 'instance') out.adapterSlug = pick(rand, ['email', 'nope']);
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
      return rand() < 0.7 ? [dict(rand, depth + 1)] : [[dict(rand, depth + 1)], scalar(rand)];
    case 'adapterSlug':
      return pick(rand, ['email', 'nope']);
    case 'credentialName':
      return pick(rand, ['inbox_cred', 'missing']);
    case 'constructionConfig':
      return { base: 'b1' };
    case 'targetType':
      return pick(rand, ['item', 'message']);
    case 'graph':
      return { instance: { kind: 'instance', name: 'inbox', adapterSlug: 'email', credentialName: 'inbox_cred' } };
    case 'walk':
      return rand() < 0.5 ? { captured: {}, head: { hopsRaw: '-[:items]->' } } : { captured: { x: 1 } };
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
  const template = Math.floor(rand() * 33);
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
        'ERROR("${COUNT(g)} ${COUNT(k)} ${IF y == null THEN "absent" ELSE "present" END}")',
      );
    case 29:
      return lines('x = FIRST(msg-[i:items ORDER BY `name`]->)', `key = "${pick(rand, ['kind', 'position', 'read', 'edgeProperties', 'name', 'identity'])}"`, 'y = AT(x, key)', 'ERROR("${IF y == null THEN "absent" ELSE "present" END}")');
    case 30:
      return lines('x = FIRST(w)', `y = x.${f(k1)}`, 'xs = [x]', 'z = FIRST(xs)', `q = z.${f(k2)}`, 'ERROR("${IF y == null THEN "absent" ELSE "present" END} ${IF q == null THEN "absent" ELSE "present" END}")');
    case 31:
      return lines('xs = msg-[c:items ORDER BY `name`]-> {', '    return c', '  }', 'all = MAP(xs, (r) => {', '    return r', '  })', 'f = FIRST(all)', 'ERROR("${COUNT(all)} ${f == FIRST(xs)} ${f.name}")');
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

export async function writeRecordsOracle(rand: Rand, write: (name: string, text: string) => void): Promise<void> {
  const cases: unknown[] = [];
  const counts = { tried: 0, refused: 0 };
  for (let i = 0; i < 1200; i++) {
    const { template, text } = body(rand);
    const data = payload(rand);
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
          host: makeTestHost({ adapters: { resolve: () => adapter } }),
        });
        outcome = { completed: true };
      } catch (error) {
        outcome = { error: ending(error) };
      }
      cases.push({ version, template, body: text, payload: new WireOut().valueAsData(data), check, outcome });
    }
  }
  write(
    'records.json',
    `{"catalog":${JSON.stringify(RECORDS_CATALOG)},"prelude":${JSON.stringify(RECORDS_PRELUDE)},"related":${JSON.stringify(related())},"cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`,
  );
  console.log(`records.json: ${cases.length} cases (${counts.refused} of ${counts.tried} refused by the checker and left out)`);
}
