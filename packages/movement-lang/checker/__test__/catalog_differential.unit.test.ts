// The Rust catalog (crates/movement-parser/src/catalog) against the
// TypeScript one, over the checker conformance corpus. Every record of
// checks.json is replayed through the TypeScript checker (as checks_regression
// replays it) with its catalog wrapped to record each lookup and its answer,
// and the catalog helpers wrapped (below) to record each call; every distinct
// lookup is then asked of the Rust `catalog_query` against the same snapshot,
// and every distinct helper call made of it, and the answers must be equal —
// canonically, and in the key order of every map keyed by data, since schema
// field order is observable. The helpers the checker never calls
// (`resolveBorrowedField`, `declaredTypesIn` — apps/api's) are asked over every
// schema and every corpus program instead.
//
// This one stays while the TypeScript catalog is in use (until the checker
// port). Gated: MOVEMENT_CATALOG_DIFFERENTIAL=1.
import { canonical } from '../../parser/expression/__test__/lowering_fixture';
import { parseProgram } from '../../parser/parse';
import { callCatalog } from '../../wasm/loader';
import { resolveBorrowedField, declaredTypesIn, type Catalog, type InstanceSchema } from '../catalog';
import { checkNow, loadChecks, SNAPSHOT_TABLE } from './checks_fixture';

declare const process: { env: Record<string, string | undefined> };
declare const console: { log(...args: unknown[]): void };

/** Why a call's arguments or answer cannot cross to Rust as JSON. */
type Exclusion = 'a record carrying a position' | 'a Set' | 'a Map' | 'a function';

/** The one exclusion expected: a record type's position is the typing
 *  layer's `PositionTypeRef` (sets, instance tokens), and describing one is
 *  the typing port's. Those calls are not covered here: they are covered by
 *  the conformance corpus (checks.json) once the typing layer is in Rust.
 *  Any other reason fails the test. */
const EXPECTED_EXCLUSION: Exclusion = 'a record carrying a position';

class Untransferable extends Error {
  constructor(readonly reason: Exclusion) {
    super(reason);
  }
}

function transferable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Set) throw new Untransferable('a Set');
    if (v instanceof Map) throw new Untransferable('a Map');
    if (typeof v === 'function') throw new Untransferable('a function');
    if (typeof v === 'object' && v !== null && 'kind' in v && v.kind === 'record' && 'position' in v && v.position !== undefined) {
      throw new Untransferable(EXPECTED_EXCLUSION);
    }
    return v;
  }) ?? 'null';
}

/** An answer as the Rust query writes it: `{value}`, or `{}` for undefined.
 *  A `Map` answers as its entries. */
function envelope(answer: unknown): string {
  if (answer === undefined) return '{}';
  return `{"value":${transferable(answer instanceof Map ? [...answer] : answer)}}`;
}

interface Call {
  /** The snapshot's key, or '' for a helper. */
  snapshot: string;
  query: string;
  answer: string;
}

/** `untransferable`: excluded calls, by `helper: reason`. */
const mockRecorder: { on: boolean; record(call: Call): void; untransferable: Map<string, number> } = {
  on: false,
  record: () => undefined,
  untransferable: new Map(),
};

function mockRecordHelper(name: string, args: unknown[], result: unknown): void {
  if (!mockRecorder.on) return;
  try {
    const query = `{"op":"helper","name":${JSON.stringify(name)},"args":${transferable(args.map(a => (a instanceof Map ? [...a] : a)))}}`;
    mockRecorder.record({ snapshot: '', query, answer: envelope(result) });
  } catch (e) {
    if (!(e instanceof Untransferable)) throw e;
    const key = `${name}: ${e.reason}`;
    mockRecorder.untransferable.set(key, (mockRecorder.untransferable.get(key) ?? 0) + 1);
  }
}

jest.mock('../catalog', () => {
  const actual: Record<string, unknown> = jest.requireActual('../catalog');
  const wrapped: Record<string, unknown> = { ...actual };
  const names = [
    'parseFieldTypeName',
    'describeFieldType',
    'variantOf',
    'refinementKey',
    'borrowedTypeSegments',
    'resolveBorrowedField',
    'declaredTypesIn',
    'credentialArgOf',
    'entryPositionKeyOf',
    'unionVariants',
    'unionKey',
    'unionDisplay',
  ];
  for (const name of names) {
    const fn = actual[name];
    if (typeof fn !== 'function') throw new Error(`checker/catalog.ts exports no ${name}`);
    wrapped[name] = (...args: unknown[]): unknown => {
      const result: unknown = fn(...args);
      mockRecordHelper(name, args, result);
      return result;
    };
  }
  return wrapped;
});

/** The catalog the checker is handed, recording every lookup. */
function recording(snapshot: string, catalog: Catalog): Catalog {
  const answer = <T>(op: string, input: object, value: T): T => {
    mockRecorder.record({ snapshot, query: JSON.stringify({ op, ...input }), answer: envelope(value) });
    return value;
  };
  const { credentialNames, constructionArgOptions, models } = catalog;
  return {
    adapter: name => answer('adapter', { name }, catalog.adapter(name)),
    credential: name => answer('credential', { name }, catalog.credential(name)),
    plugin: name => answer('plugin', { name }, catalog.plugin(name)),
    instantiate: (adapter, args) => answer('instantiate', { adapter, args }, catalog.instantiate(adapter, args)),
    ...(credentialNames ? { credentialNames: () => answer('credentialNames', {}, credentialNames()) } : {}),
    ...(constructionArgOptions
      ? { constructionArgOptions: input => answer('constructionArgOptions', input, constructionArgOptions(input)) }
      : {}),
    ...(models ? { models: () => answer('models', {}, models()) } : {}),
  };
}

/** The objects keyed by data, by the member that holds them: their key
 *  order is the data's, where every other object's is its type's. */
const DATA_MAPS = new Set([
  'schemas', 'positions', 'properties', 'edges', 'propertyCapabilities', 'collections', 'unions', 'unionDisplayNames',
  'writableRoots', 'fields', 'resultShape', 'fieldDocs', 'variants', 'createShapes', 'refinements', 'selectedMembers',
  'narrowBy', 'genericLandings', 'eventNarrowingValues', 'shape', 'triggerConfigOptions', 'triggerConfigRequiredWhy',
  'triggerConfigFormats', 'constructionArgOptions',
]);

function dataKeyOrders(value: unknown, path = '', parentIsData = false, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v, i) => dataKeyOrders(v, `${path}[${i}]`, false, out));
  else if (typeof value === 'object' && value !== null) {
    const isData = DATA_MAPS.has(path.split('.').pop() ?? '') || parentIsData;
    if (isData) out.push(`${path}: ${Object.keys(value).join(' · ')}`);
    for (const [k, v] of Object.entries(value)) {
      // An `eventNarrowingValues` entry is a map of maps.
      dataKeyOrders(v, `${path}.${k}`, isData && path.endsWith('eventNarrowingValues'), out);
    }
  }
  return out;
}

function rustAnswer(snapshotJson: string, query: string): string {
  const { ok, json } = callCatalog(snapshotJson, query);
  return ok ? JSON.stringify(json) : `REFUSED ${JSON.stringify(json)}`;
}

/** The fewest distinct calls compared, per lookup and helper (counts on
 *  2026-10-07 in comments). `unionDisplay` is never called by the checker. */
const COMPARED_AT_LEAST: Record<string, number> = {
  instantiate: 250, // 299
  adapter: 300, // 355
  credential: 200, // 237
  plugin: 60, // 75
  credentialNames: 2, // 3
  constructionArgOptions: 2, // 3
  models: 1, // 1
  'helper:declaredTypesIn': 2_000, // 2,697
  'helper:resolveBorrowedField': 1_000, // 1,227
  'helper:credentialArgOf': 150, // 207
  'helper:entryPositionKeyOf': 150, // 194
  'helper:variantOf': 150, // 193
  'helper:describeFieldType': 40, // 51
  'helper:parseFieldTypeName': 30, // 38
  'helper:borrowedTypeSegments': 15, // 23
  'helper:refinementKey': 15, // 19
  'helper:unionVariants': 10, // 12
  'helper:unionKey': 4, // 5
};

const differential = process.env.MOVEMENT_CATALOG_DIFFERENTIAL ? describe : describe.skip;

differential('the Rust catalog, against the TypeScript one, over the checker corpus', () => {
  const calls = new Map<string, Call>();
  const repeats: string[] = [];
  const snapshotJson = new Map<string, string>([...SNAPSHOT_TABLE].map(([key, s]) => [key, JSON.stringify(s)]));

  beforeAll(() => {
    mockRecorder.record = call => {
      const key = `${call.snapshot}\u0000${call.query}`;
      const seen = calls.get(key);
      if (seen === undefined) calls.set(key, call);
      else if (seen.answer !== call.answer) repeats.push(`${call.query}: answered twice, differently`);
    };
    mockRecorder.on = true;
    for (const record of loadChecks().filter(r => !r.note)) checkNow(record, catalog => recording(record.snapshot, catalog));
    mockRecorder.on = false;
    // The helpers the checker never calls, over every schema and program.
    mockRecorder.on = true;
    for (const snapshot of SNAPSHOT_TABLE.values()) {
      for (const adapter of Object.values(snapshot.adapters)) {
        for (const schema of Object.values<InstanceSchema>(adapter.schemas)) {
          const roots = new Set([...Object.keys(schema.positions), ...Object.keys(schema.writableRoots), 'nowhere']);
          for (const root of roots) {
            const fields = new Set([
              ...Object.keys(schema.positions[root]?.properties ?? {}),
              ...Object.keys(schema.writableRoots[root]?.fields ?? {}),
              'nothing',
            ]);
            for (const field of fields) resolveBorrowedField(schema, root, field);
          }
        }
      }
    }
    for (const record of loadChecks()) {
      try {
        declaredTypesIn(parseProgram(record.source, { languageVersion: record.parseVersion ?? record.version }));
      } catch {
        // A program that does not parse declares nothing to compare.
      }
    }
    mockRecorder.on = false;
  });

  it('answers every lookup and helper call exactly as the TypeScript does', () => {
    const counts = new Map<string, number>();
    const diffs: string[] = [...repeats];
    for (const call of calls.values()) {
      const parsed: unknown = JSON.parse(call.query);
      const op = typeof parsed === 'object' && parsed !== null && 'op' in parsed ? String(parsed.op) : '?';
      const name = op === 'helper' && typeof parsed === 'object' && parsed !== null && 'name' in parsed ? `helper:${String(parsed.name)}` : op;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      const rust = rustAnswer(call.snapshot === '' ? '' : (snapshotJson.get(call.snapshot) ?? ''), call.query);
      if (rust.startsWith('REFUSED')) {
        diffs.push(`${name} ${call.query.slice(0, 300)}: ts ${call.answer.slice(0, 300)} | rust ${rust.slice(0, 300)}`);
        continue;
      }
      const ts: unknown = JSON.parse(call.answer);
      const rs: unknown = JSON.parse(rust);
      if (canonical(ts) !== canonical(rs)) {
        diffs.push(`${name} ${call.query.slice(0, 300)}: ts ${canonical(ts).slice(0, 400)} | rust ${canonical(rs).slice(0, 400)}`);
        continue;
      }
      // Sorted by path: the order a type's own members are visited in is the
      // type's, and is not what is compared.
      const tsOrder = dataKeyOrders(ts).sort().join('\n');
      const rsOrder = dataKeyOrders(rs).sort().join('\n');
      if (tsOrder !== rsOrder) diffs.push(`${name} ${call.query.slice(0, 200)}: key order ts ${tsOrder.slice(0, 300)} | rust ${rsOrder.slice(0, 300)}`);
    }
    const excluded = [...mockRecorder.untransferable];
    console.log(
      `catalog differential: ${calls.size} distinct calls — ${[...counts].sort().map(([k, n]) => `${k} ${n}`).join(', ')}; ` +
        `excluded: ${excluded.map(([k, n]) => `${k} ×${n}`).join(', ') || 'none'}; ` +
        `${diffs.length} diffs`,
    );
    expect(diffs.slice(0, 20)).toEqual([]);
    expect(excluded.filter(([key]) => !key.endsWith(`: ${EXPECTED_EXCLUSION}`))).toEqual([]);
    // Coverage floors, well under the counts of 2026-10-07: a collapse in what
    // the corpus exercises fails here rather than passing on nothing.
    const shortfalls = Object.entries(COMPARED_AT_LEAST).filter(([name, floor]) => (counts.get(name) ?? 0) < floor);
    expect(shortfalls.map(([name, floor]) => `${name}: ${counts.get(name) ?? 0} < ${floor}`)).toEqual([]);
  });
});
