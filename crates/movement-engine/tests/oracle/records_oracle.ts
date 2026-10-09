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
// A case carries its body, the event's payload on the eval wire, the check's
// answer as the shim hands it to the Rust engine (`check.program`), and the
// error the run ended with.

import { languageVersionDiagnostic, mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from '../../../../packages/movement-lang';
import { tenantIdOf } from '../../../../packages/engine-contracts';
import { MovementEngineError } from '../../../../apps/api/src/services/movement_engine/errors';
import { checkAnswer, checkPinned } from '../../../../apps/api/src/services/movement_engine/program_check';
import { runFailureCause, runMovement } from '../../../../apps/api/src/services/movement_engine/run';
import { credentialIdsFor, makeTestHost } from '../../../../apps/api/src/services/movement_engine/test_host';
import type { Adapter } from '../../../../apps/api/src/services/translation_graph/adapter';
import { positionData } from '../../../../apps/api/src/services/translation_graph/types';

type Rand = () => number;

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', meta: 'json', more: 'json' }, edges: {} } },
  collections: {},
  writableRoots: {},
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
const KINDS = [
  'event', 'instance', 'handle', 'extractRoot', 'extractPosition', 'sourcePosition', 'resource', 'blockMeta',
  'positions', 'tuple', 'closure', 'value', 'shape', 'movement', 'shapePosition', 'nodePosition', 'lazyWalk', 'callback',
  'plugin', 'opaque',
];
/** Ordinary keys, and the ones a binding kind's own reads take. */
const ORDINARY = ['name', 'a', 'kind', 'value', 'fields', 'fieldOrder', 'fieldProvenance', 'handle', 'emission', 'resource', 'callbackId', 'url', 'edges', 'landings', 'position'];

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
  else if (roll < 0.7) out.kind = pick(rand, PROTOTYPE.filter((p) => p !== '__proto__'));
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
      return [dict(rand, depth + 1)];
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
function body(rand: Rand): string {
  const k = () => pick(rand, READ_KEYS);
  const lines = (...ls: string[]) => ls.map((l) => `  ${l}`).join('\n');
  // A field written backticked when it is no plain name.
  const f = (key: string) => (/^[A-Za-z][A-Za-z0-9]*$/.test(key) ? key : `\`${key}\``);
  const [k1, k2] = [k(), k()];
  switch (Math.floor(rand() * 16)) {
    case 0:
      return lines(`ERROR("\${v.${f(k1)}}")`);
    case 1:
      return lines(`x = v.${f(k1)}`, 'ERROR("${x}")');
    case 2:
      return lines(`key = "${k1}"`, 'ERROR("${AT(v, key)}")');
    case 3:
      return lines('x = FIRST(w)', `ERROR("\${x.${f(k1)}}")`);
    case 4:
      return lines('x = AT(w, 1)', `ERROR("\${x.${f(k1)}}")`);
    case 5:
      return lines('n = COUNT(w)', 'j = JOIN(w, "|")', 'ERROR("${n} ${j} ${v} ${w}")');
    case 6:
      return lines(`ERROR("\${v.${f(k1)}.${f(k2)}}")`);
    case 7:
      return lines(`p = IF v.${f(k1)} == null THEN "absent" ELSE "present" END`, 'ERROR(p)');
    case 8:
      return lines('x = FIRST(w)', `y = x.${f(k1)}`, `z = IF y == null THEN "absent" ELSE "present" END`, 'ERROR("${y} ${z}")');
    case 9:
      return lines('rows = MAP(w, (e) => {', `    return e.${f(k1)}`, '  })', 'ERROR("${rows}")');
    case 10:
      return lines('kept = FILTER(w, (e) => {', `    return e.${f(k1)} != null`, '  })', 'ERROR("${COUNT(kept)}")');
    case 11:
      return lines('held = { k: v }', `ERROR("\${held.k.${f(k1)}}")`);
    case 12:
      return lines('both = [v, FIRST(w)]', 'x = AT(both, 0)', `ERROR("\${x.${f(k1)}} \${COUNT(both)}")`);
    case 13:
      return lines('x = FIRST(w)', 'y = x', `ERROR("\${y.${f(k1)}}")`);
    case 14:
      return lines('all = MAP(w, (e) => {', '    return e', '  })', 'x = FIRST(all)', `ERROR("\${x.${f(k1)}}")`);
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
  getRelated: async () => [],
  createRecord: async () => {
    throw new Error('the oracle writes nothing');
  },
  updateRecord: async () => {
    throw new Error('the oracle writes nothing');
  },
  deleteRecord: async () => ({}),
};

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

export async function writeRecordsOracle(
  rand: Rand,
  wire: (value: unknown) => unknown,
  write: (name: string, text: string) => void,
): Promise<void> {
  const cases: unknown[] = [];
  const counts = { tried: 0, refused: 0 };
  for (let i = 0; i < 700; i++) {
    const text = body(rand);
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
      cases.push({ version, body: text, payload: wire(data), check, outcome });
    }
  }
  write(
    'records.json',
    `{"catalog":${JSON.stringify(RECORDS_CATALOG)},"prelude":${JSON.stringify(RECORDS_PRELUDE)},"cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`,
  );
  console.log(`records.json: ${cases.length} cases (${counts.refused} of ${counts.tried} refused by the checker and left out)`);
}
