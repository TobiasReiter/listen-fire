// Values the Rust engine and the TypeScript engine must hand a host
// identically, compared by what the adapter receives with `Object.is` and
// each object's prototype kept (PLAN-08A Task 2, fix round 1): a -0 literal
// (the TypeScript's lowered tree crosses as JSON, so the literal is 0) and a
// -0 computed (-0 on both); a map whose prototype was assigned, written to an
// adapter that hands its fields back (the shim carries the prototype both
// ways); a record nested in a null-prototype map spread into a graph. The
// conformance recorder refuses non-JSON values, so these run in process.
import { isDeepStrictEqual } from 'node:util';
import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion, type PluginSpec } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';
import type { Adapter } from '../../translation_graph/adapter';
import type { LlmCallResult } from '../../translation_graph/engine/batched_extraction/llm_call';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { containerAssociation } from '../../translation_graph/adapter';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { makeStablePosition, positionData } from '../../translation_graph/types';
import { makeFakeParkSink, makeTestHost } from '../test_host';
import { resumeMovement, runFailureCause, runMovement } from '../run';
import { resetRustEvalStats, resetRustRunStats, rustRunStats } from '../rust_stats';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000c9');
const emailSchema: InstanceSchema = { positions: { message: { properties: { subject: 'text', text: 'text', meta: 'json' }, edges: {} } }, collections: {}, writableRoots: {} };
const companyFields = { name: 'text', stage: 'text' } as const;
const attioSchema: InstanceSchema = {
  positions: {
    company: { properties: companyFields, edges: { notes: { target: 'note', writable: true } } },
    note: { properties: { body: 'text', payload: 'json' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: companyFields, resultShape: { externalId: 'text', ...companyFields } },
    note: { fields: { body: 'text', payload: 'json' }, resultShape: { externalId: 'text', body: 'text', payload: 'json' } },
  },
  supportsInPlaceUpdate: true,
};
const credentialArg = [{ name: 'credentials', kind: 'credential' as const, required: true }];
const fetchUrl = staticCatalogFromManifests({ credentials: {} }).plugin('fetch_url');
const summarise: PluginSpec = { args: ['data'], priced: false, effects: { ai: true }, output: { kind: 'value', type: 'text' } };
const catalog = mockCatalogSnapshot({
  adapters: { email: { constructionArgs: credentialArg, schema: emailSchema }, attio: { constructionArgs: credentialArg, schema: attioSchema } },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
  plugins: { ...(fetchUrl !== undefined ? { fetch_url: fetchUrl } : {}), summarise },
});
const PRELUDE = ['import { email, attio } from adapters', 'import { dealflow_inbox, acme_main } from credentials', 'inbox = email(credentials: dealflow_inbox)', 'crm   = attio(credentials: acme_main)', ''].join('\n');
const LISTED = { 'c-acme': { name: 'Acme', stage: 'lead' }, 'c-beta': { name: 'Beta', stage: 'lead' } };

/** A deep description that keeps -0 and prototypes. */
function desc(v: unknown, depth = 0): unknown {
  if (typeof v === 'number') return Object.is(v, -0) ? '<-0>' : Number.isFinite(v) ? v : `<${v}>`;
  if (v === null || typeof v !== 'object' || depth > 6) return v;
  if (Array.isArray(v)) return v.map((x) => desc(x, depth + 1));
  const proto = Object.getPrototypeOf(v);
  const own = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, desc(x, depth + 1)]));
  return { own, proto: proto === Object.prototype ? 'Object' : proto === null ? 'null' : desc(proto, depth + 1) };
}

function fakeAttio(log: unknown[]) {
  let minted = 0;
  const adapter: Adapter = {
    adapterType: 'attio',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, input.fieldId) : undefined;
    },
    async getRelated(input) {
      log.push(['attio.getRelated', Reflect.get(input, 'fieldId')]);
      return Object.entries(LISTED).map(([recordId, data]) => ({ position: makeStablePosition({ adapterType: 'attio', recordType: 'company', recordId, data }) }));
    },
    async createRecord(input) {
      log.push(['create', desc(input.fields)]);
      minted += 1;
      return { adapterType: 'attio', externalId: `attio-${minted}`, data: { ...input.fields } };
    },
    async updateRecord(input) {
      log.push(['update', input.externalId, desc(input.fields)]);
      return { adapterType: 'attio', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    deleteRecord: async () => ({}),
  };
  return adapter;
}
function fakeEmail(log: unknown[]): Adapter {
  return { ...fakeAttio(log), adapterType: 'email', getRelated: async (input) => { log.push(['email.getRelated', Reflect.get(input, 'fieldId')]); return []; } };
}
const WEBHOOK_PAYLOAD = { subject: 'Acme', text: 'acme.dev' };
function webhook(): TriggerEvent {
  return { pipelineInputId: 'pi-review2', adapterType: 'email', triggerType: 'webhook', payload: WEBHOOK_PAYLOAD };
}

interface RunOptions {
  /** The event's payload, over the webhook's own. */
  payload?: Record<string, unknown>;
  /** A parked state to resume instead of a fresh run. */
  state?: unknown;
  /** Where the run's timer parks are kept. */
  parks?: unknown[];
}

async function runOn(engine: 'ts' | 'rust', source: string, languageVersion: LanguageVersion, replies: unknown[], options: RunOptions = {}) {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const log: unknown[] = [];
  const queue = [...replies];
  const park = makeFakeParkSink();
  try {
    const input = {
      source, event: { ...webhook(), payload: { ...WEBHOOK_PAYLOAD, ...options.payload } }, teamId: TEAM_ID, catalog, languageVersion,
      host: makeTestHost({
        adapters: { resolve: ({ adapterType }) => (adapterType === 'attio' ? fakeAttio(log) : fakeEmail(log)) },
        park: { sink: park.sink },
        llm: {
          client: { call: async (): Promise<LlmCallResult> => ({ parsedJson: queue.shift() ?? {} }) },
          transforms: { async invoke({ plugin, config }) { log.push(['plugin', plugin, desc(config)]); return { text: `page of ${String(Reflect.get(config, 'url') ?? Reflect.get(config, 'data'))}` }; } },
        },
      }),
    };
    const result = options.state !== undefined ? await resumeMovement({ ...input, state: options.state } as never) : await runMovement(input);
    options.parks?.push(...park.timerParks.map((parked) => parked.state));
    return { log, ok: { writes: result.writes.map((w) => [w.recordType, w.outcome, desc(w.writtenValues)]), trace: desc(result.trace) } };
  } catch (error) {
    const cause = runFailureCause(error);
    return { log, err: cause instanceof Error ? `${(cause as { code?: string }).code ?? cause.constructor.name}: ${cause.message}` : String(cause) };
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

const m = (...body: string[]) => [PRELUDE, 'movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n');
const pm = (imports: string, ...body: string[]) => [imports, PRELUDE, 'movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n');
const wrap = (value: unknown) => ({ evidence: 'Acme Corp', value });

/** Both engines on `source`: what each adapter was handed and how the run
 *  ended agree exactly, and the Rust engine ran it, with no shim fault. */
async function agreeExactly(source: string, languageVersion: LanguageVersion, options: RunOptions = {}): Promise<{ ts: unknown; rust: unknown }> {
  const ts = await runOn('ts', source, languageVersion, [], options);
  resetRustRunStats();
  const rust = await runOn('rust', source, languageVersion, [], options);
  expect(rust).toEqual(ts);
  expect(isDeepStrictEqual(rust, ts)).toBe(true);
  expect(rustRunStats).toMatchObject({ ranWhole: 1, shimFaults: 0, unreproduced: 0, notAdmitted: {}, declined: {} });
  return { ts, rust };
}

const created = (outcome: { log: unknown[] }) => outcome.log.filter((entry) => Array.isArray(entry) && entry[0] === 'create');

describe.each([3, 4] as LanguageVersion[])('values handed to a host, both engines alike (version %i)', (version) => {
  it('a -0 literal reaches the adapter as 0, as the TypeScript engine holds it', async () => {
    const { rust } = await agreeExactly(m('  x = -0', '  write crm-[:notes]-> { body: "a", payload: { n: x } }'), version);
    expect(created(rust as { log: unknown[] })).toEqual([['create', { own: { body: 'a', payload: { own: { n: 0 }, proto: 'Object' } }, proto: 'Object' }]]);
    // The sign a literal never had.
    const positive = await agreeExactly(m('  x = -0', '  if 1 / x < 0 {', '    write crm-[:notes]-> { body: "negative" }', '  } else {', '    write crm-[:notes]-> { body: "positive" }', '  }'), version);
    expect(JSON.stringify(created(positive.rust as { log: unknown[] }))).toContain('positive');
  });

  it('a -0 computed reaches the adapter as -0 on both', async () => {
    const { rust } = await agreeExactly(m('  x = 0 * -1', '  write crm-[:notes]-> { body: "a", payload: { n: x } }'), version);
    expect(created(rust as { log: unknown[] })).toEqual([['create', { own: { body: 'a', payload: { own: { n: '<-0>' }, proto: 'Object' } }, proto: 'Object' }]]);
  });

  it('a map whose prototype was assigned is written, and handed back, as itself', async () => {
    for (const literal of ['{ __proto__: { a: 1 }, b: 2 }', '{ __proto__: null, b: 2 }', '{ __proto__: 5, b: 2 }']) {
      const { rust } = await agreeExactly(m(`  x = ${literal}`, '  write crm-[:notes]-> { body: "p", payload: x }'), version);
      expect(created(rust as { log: unknown[] })).toHaveLength(1);
    }
  });

  it('a record in a null-prototype map spread into a graph fails at its key, as the TypeScript engine fails it', async () => {
    for (const held of ['{ k: { __proto__: null, inner: co } }', '{ k: [{ __proto__: null, inner: co }] }']) {
      const { rust } = await agreeExactly(m('  co = write crm-[:companies]-> { name: "a" }', `  held = ${held}`, '  g = graph { ...held }'), version);
      expect(rust).toMatchObject({ err: expect.stringContaining("'k' holds a record") });
    }
  });

  it('AT and a map spread read a null-prototype map as the map it is, from a literal, an event and a parked state', async () => {
    const reads = ['  k = "b"', '  write crm-[:notes]-> { body: "z", payload: { a: AT(x, k), b: AT(x, "b"), c: x.b, y: { ...x, c: 1 } } }'];
    const written = { own: { body: 'z', payload: { own: { a: 2, b: 2, c: 2, y: { own: { b: 2, c: 1 }, proto: 'Object' } }, proto: 'Object' } }, proto: 'Object' };
    const literal = await agreeExactly(m('  x = { __proto__: null, b: 2 }', ...reads), version);
    expect(created(literal.rust as { log: unknown[] })).toEqual([['create', written]]);
    const fromEvent = await agreeExactly(m('  x = msg.meta', ...reads), version, { payload: { meta: Object.assign(Object.create(null), { b: 2 }) } });
    expect(created(fromEvent.rust as { log: unknown[] })).toEqual([['create', written]]);
    // Parked by the TypeScript engine, the binding made a null-prototype map
    // in memory (a park read from storage is JSON, which keeps none), then
    // resumed on each engine.
    const parks: unknown[] = [];
    const source = m('  x = { b: 2 }', '  await sleep(1h)', ...reads);
    await runOn('ts', source, version, [], { parks });
    const nulled = (state: unknown): unknown => {
      if (Array.isArray(state)) return state.map(nulled);
      if (state === null || typeof state !== 'object') return state;
      const entries = Object.entries(state).map(([key, value]) => [key, nulled(value)] as const);
      const isMap = entries.length === 1 && entries[0]![0] === 'b' && entries[0]![1] === 2;
      return isMap ? Object.assign(Object.create(null), { b: 2 }) : Object.fromEntries(entries);
    };
    expect(parks).toHaveLength(1);
    const resumed = await agreeExactly(source, version, { state: nulled(parks[0]) });
    expect(created(resumed.rust as { log: unknown[] })).toEqual([['create', written]]);
  });

  it('a call in another letter case resolves in its own scope chain, never a sibling scope', async () => {
    // `Get` in an `if` arm beside `get`: TypeScript's resolveFunction walks
    // the call's chain and finds `get`, whose value hides a record, which
    // this engine refuses at admission, so both engines run it alike.
    const source = pm(
      'import { summarise } from plugins',
      '  co = write crm-[:companies]-> { name: "a" }',
      '  if msg.`subject` == "zzz" {',
      '    Get = () => {',
      '      return "v"',
      '    }',
      '  }',
      '  get = () => {',
      '    return { k: COALESCE(co, "x") }',
      '  }',
      '  r = summarise(data: GET())',
      '  write crm-[:notes]-> { body: r }',
    );
    const ts = await runOn('ts', source, version, []);
    resetRustRunStats();
    const rust = await runOn('rust', source, version, []);
    expect(isDeepStrictEqual(rust, ts)).toBe(true);
    expect(rustRunStats).toMatchObject({ ranWhole: 0, unreproduced: 0, shimFaults: 0 });
    expect(Object.keys(rustRunStats.notAdmitted)).toHaveLength(1);
  });
});
