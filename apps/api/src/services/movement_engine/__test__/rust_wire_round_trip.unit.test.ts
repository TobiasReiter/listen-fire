// The wire between the TypeScript host and the Rust engine, at every boundary
// a host's value crosses: the event, an adapter's answer, a plugin's answer, a
// model's reply, a parked state, and a host that is itself a wire (the HTTP
// host double). Each program runs on the Rust engine (version 5) against a
// host of its own, and the assertions say how the run must end and what the
// host was handed.
//
// The values are what `JSON.parse` makes of a host's text: an own
// `__proto__` key is a key like any other (transition artefacts row 7). It
// crosses as itself, a read of it reads the own value, `TEXT.SERIALISE`
// prints it, and wherever JavaScript assigns keys one by one
// (`Object.assign`, `object[key] = …`) it sets the prototype.
//
// A string is any run of UTF-16 code units, a lone surrogate included
// (`JSON.parse('"\\ud83d"')` makes one; a cut through a pair, a `split("")`
// or a match through one makes another): it crosses as its code units
// (`["s16", units]`), the host's JSON text as the escape `JSON.stringify`
// writes (transition artefacts row 9), and every reading of it — its length,
// a cut, a split, a regex, a print — is JavaScript's.

import { mockCatalogSnapshot, type InstanceSchema, type PluginSpec } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';
import { RecordedConversation, verdictOf, type HostRecording } from 'engine-contracts/conformance';
import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { LlmCallResult } from 'movement-engine/services/translation_graph/engine/batched_extraction/llm_call';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { TransformInvocationResult } from 'movement-engine/services/movement_engine/extraction';

import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { positionData } from 'movement-engine/services/translation_graph/types';
import { startHostDouble, httpHost } from '../conformance/http_host_double';
import { recordEntry, recordedError } from '../conformance/recorder';
import { MovementRunFailed, resumeMovement, runFailureCause, runMovement, type RunMovementInput } from 'movement-engine/services/movement_engine/run';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';
import { credentialIdsFor, endedInRust, makeFakeParkSink, makeTestHost } from 'movement-engine/services/movement_engine/test_host';
import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000b9');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', meta: 'json' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

/** A plugin answering one record: its declared fields, one of which only a
 *  prototype can hold. */
const probe: PluginSpec = { args: ['q'], priced: false, effects: {}, output: { kind: 'record', fields: { name: 'text', x: 'text' } } };
/** A plugin answering a record per thing it found. */
const finds: PluginSpec = { args: ['q'], priced: false, effects: {}, output: { kind: 'records', fields: { u: 'text' } } };

const catalog = mockCatalogSnapshot({
  adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema } },
  credentials: { dealflow_inbox: { adapters: ['email'] } },
  plugins: { probe, finds },
});

const PRELUDE = ['import { email } from adapters', 'import { dealflow_inbox } from credentials', 'import { probe, finds } from plugins', 'inbox = connect email using dealflow_inbox', ''].join('\n');

/** One company extracted from the subject (`extractOne`, its shape written in place). */
const ONE_COMPANY = ['  found = extractOne([msg.`subject`], node Company: "" {', '    name: <text> "the company"', '  })'];

const program = (...lines: string[]) => [PRELUDE + 'function m(msg: <inbox-[:message]->>) {', ...lines, '}'].join('\n');

/** What a host's JSON text makes: every `__proto__` key an own key. */
const META = JSON.parse(
  '{"a":1,"__proto__":{"x":"via"},"items":[{"__proto__":"a","n":1},{"__proto__":"__proto__","n":2},{"__proto__":"b","n":3}]}',
);

function emailAdapter(): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    // The position's data bag, as the event carried it: an adapter's answer.
    async getFieldValue(input) {
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, input.fieldId) : undefined;
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

const event = (meta: unknown): TriggerEvent => ({ pipelineInputId: 'pi-rust-wire', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', meta } });

interface Case {
  source: string;
  meta?: unknown;
  /** What every plugin call answers. */
  invoked?: TransformInvocationResult;
  /** What the model answers, in turn. */
  replies?: readonly unknown[];
}

function inputOf(c: Case, park: ReturnType<typeof makeFakeParkSink>, seen: { invoked: unknown[]; asked: unknown[] }): RunMovementInput {
  const replies = [...(c.replies ?? [])];
  return {
    source: c.source,
    event: event(c.meta ?? META),
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    host: makeTestHost({
      adapters: { resolve: () => emailAdapter() },
      park: { sink: park.sink },
      llm: {
        client: {
          call: async (request): Promise<LlmCallResult> => {
            seen.asked.push(request.label);
            return { parsedJson: replies.shift() ?? {} };
          },
        },
        extractCall: {
          call: async (request) => {
            seen.asked.push(request.label);
            return { parsedJson: replies.shift() ?? {}, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } };
          },
        },
        transforms: {
          invoke: async (request) => {
            seen.invoked.push({ plugin: request.plugin, config: request.config });
            return c.invoked ?? { text: 'a page' };
          },
        },
      },
    }),
  };
}

/** How a run ended, as text (`JSON.stringify` prints an own `__proto__`
 *  key, and leaves a prototype out). */
async function ending(run: () => Promise<unknown>): Promise<string> {
  try {
    return `result ${JSON.stringify(await run())}`;
  } catch (error) {
    const cause = runFailureCause(error);
    return `error ${String(error)} | ${String(cause)}${error instanceof MovementRunFailed ? ` | ${JSON.stringify(error.partial)}` : ''}`;
  }
}

async function runOn(c: Case) {
  const park = makeFakeParkSink();
  const seen = { invoked: [] as unknown[], asked: [] as unknown[] };
  const ended = await ending(() => runMovement(inputOf(c, park, seen)));
  return { ended, invoked: JSON.stringify(seen.invoked), asked: seen.asked, parks: JSON.stringify(park.timerParks) };
}

/** `c` on the Rust engine: it ran the segment, refusing nothing and
 *  faulting nowhere. */
async function run(c: Case) {
  resetRustRunStats();
  const ran = await runOn(c);
  expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
  return ran;
}

/** A run through the HTTP host: its result as the wire carries it, or the
 *  failure as recorded. */
async function replayed(input: RunMovementInput) {
  try {
    return { result: JSON.parse(JSON.stringify(await runMovement(input))) };
  } catch (error) {
    return { failure: recordedError(error) };
  }
}

/** A parked state, resumed on the Rust engine: how the resumed run ended. */
async function resumedFrom(c: Case, parks: string): Promise<string> {
  const state: ParkedScopeState = JSON.parse(parks)[0].state;
  const input = { ...inputOf(c, makeFakeParkSink(), { invoked: [], asked: [] }), state: JSON.parse(JSON.stringify(state)) };
  return ending(() => resumeMovement(input));
}

describe('own `__proto__` keys on the wire', () => {
  it('reads an event field holding one as the key it is: printed, read, spread and filed as JavaScript does', async () => {
    const { ended } = await run({
      source: program(
        '  v = msg.`meta`',
        '  s = { ...v, b: 2 }',
        '  g = List.groupBy(v.`items`, (e) => {',
        '    return e.`__proto__`',
        '  })',
        '  k = List.keyBy(v.`items`, (e) => {',
        '    return e.`__proto__`',
        '  })',
        '  fail("${Json.stringify(v)} | ${Json.stringify(v.`__proto__`.`x`)} | ${Json.stringify(v.`x`)} | ${Json.stringify(s)} | ${Json.stringify(s.`x`)} | ${Json.stringify(g)} | ${Json.stringify(g.`a`)} | ${Json.stringify(k)}")',
      ),
    });
    // The own key printed and read; the spread made it the prototype, which
    // no print shows and a read goes through.
    expect(ended).toContain('"__proto__": {');
    expect(ended).toContain('| "via" | null |');
    expect(ended).toContain('"b": 2');
    expect(ended).toMatch(/\| "via" \| \{/);
  });

  it("reads a plugin's answer holding one: assigned into a record's fields, kept in a found record's, assigned again where it is written out", async () => {
    const answer = JSON.parse('{"text":"a page","data":{"name":"Acme","__proto__":{"x":"via"}},"records":[{"u":"1","__proto__":{"x":1}}]}');
    const { ended } = await run({
      source: program(
        '  page = probe({ q: msg.`subject` })',
        '  found = finds({ q: msg.`subject` })',
        '  fail("${page.name} ${page.x} ${Json.stringify(page)} ${Json.stringify(found)}")',
      ),
      invoked: answer,
    });
    // `Object.assign` made the data's key the record's prototype, which a
    // field read goes through.
    expect(ended).toContain('Acme via');
    // The trace names the data's keys as the answer held them.
    expect(ended).toContain('"fields":["name","__proto__"]');
    // A found record keeps it as a field, and writing the record out
    // (`plainRecordOf`'s `plain[field] = …`) assigns it: no print shows it.
    expect(ended).not.toContain('"__proto__": {');
  });

  it('reads a model reply holding one: an AI() answer, and an extraction read in one call', async () => {
    const ai = await run({
      source: program('  x = ai("why?")', '  fail("${Json.stringify(x)}")'),
      replies: [JSON.parse('{"value":{"__proto__":{"x":1},"a":2}}')],
    });
    expect(ai.asked).toHaveLength(1);
    const extraction = await run({
      source: program(...ONE_COMPANY, '  fail("${found.name}")'),
      replies: [JSON.parse('{"record":{"name":{"value":"Acme","evidence":{"item":0,"quote":"q"}},"__proto__":{"x":1}}}')],
    });
    expect(extraction.asked).toHaveLength(1);
  });

  it('spreads a `__proto__: null` in as no prototype at all: still a dict, read and spread again', async () => {
    const { ended } = await run({
      source: program(
        '  v = msg.`meta`',
        '  s = { ...v }',
        '  t = { ...s }',
        '  fail("${Json.stringify(s.a)} ${Json.stringify(t.a)} ${Json.stringify(t)} ${Json.stringify(s.`toString`)}")',
      ),
      meta: JSON.parse('{"a":1,"__proto__":null}'),
    });
    expect(ended).toContain('MOVENG_ERROR: 1 1 {');
  });

  it('ends at the check a program naming a binding or a parameter `__proto__`', async () => {
    for (const body of [['  __proto__ = 1', '  fail("${__proto__}")'], ['  xs = map([1, 2], (__proto__) => {', '    return __proto__', '  })', '  fail("${count(xs)}")']]) {
      resetRustRunStats();
      const ran = await runOn({ source: program(...body) });
      expect(rustRunStats).toMatchObject({ segments: 0, endedAtCheck: 1 });
      expect(ran.ended).toContain('MOV_NAME_PROTO');
    }
  });

  it('parks a value holding one as JavaScript writes it, and the park resumes to the same ending', async () => {
    const source = program('  v = msg.`meta`', '  s = { ...v }', '  await sleep(1h)', '  fail("${Json.stringify(v)} ${Json.stringify(s)} ${Json.stringify(s.`x`)}")');
    const parked = await run({ source });
    expect(parked.parks).toContain('"__proto__"');
    expect(await resumedFrom({ source }, parked.parks)).toContain('"__proto__": {');
  });

  it('crosses a host that is itself a wire (the HTTP host double) as it crosses in process', async () => {
    const source = program('  v = msg.`meta`', '  s = { ...v }', '  fail("${Json.stringify(v)} ${Json.stringify(s.`x`)}")');
    const kept: HostRecording[] = [];
    const park = makeFakeParkSink();
    const recorded = { entry: 'run', input: inputOf({ source }, park, { invoked: [], asked: [] }), run: runMovement, keep: (r: HostRecording) => kept.push(r) } as const;
    // Recorded in process, then replayed through the HTTP double: the wire
    // must hand the engine what the in-process host did.
    await recordEntry(recorded).catch(() => undefined);
    const recording = kept[0];
    if (recording === undefined) throw new Error('test: the run was recorded');
    expect(JSON.stringify(recording)).toContain('"__proto__"');
    const double = await startHostDouble();
    try {
      const conversation = new RecordedConversation(recording.requests);
      double.serve(conversation);
      resetRustRunStats();
      const input = { ...inputOf({ source }, makeFakeParkSink(), { invoked: [], asked: [] }), host: httpHost(double.url, recording.methods) };
      const outcome = await replayed(input);
      expect(rustRunStats).toMatchObject({ ...endedInRust(undefined), shimFaults: 0 });
      expect(verdictOf(recording, conversation, outcome)).toEqual({ kind: 'same' });
    } finally {
      await double.close();
    }
  });
});

/** A lone high half, a lone low half, and a pair, as `JSON.parse` makes them. */
const LONE = JSON.parse('{"hi":"a\\ud83d","lo":"\\ude00b","pair":"x😀y","\\udc00key":"\\ud800","astral":"😀𝒜"}');

describe('lone surrogates on the wire', () => {
  it('reads an event field holding them as JavaScript does: counted, cut, split, matched, printed, compared', async () => {
    const { ended } = await run({
      source: program(
        '  v = msg.`meta`',
        '  hi = v.`hi`',
        '  joined = "${hi}${v.`lo`}"',
        '  halves = Text.split(v.`pair`, "")',
        '  half = Text.regexExtract(v.`pair`, ".(.)")',
        '  fail("${Text.length(hi)} ${Text.length(joined)} ${joined == "a😀b"} ${count(halves)} ${Json.stringify(halves)} ${Json.stringify(half)} ${Text.length(half)} ${Text.upper(hi)} ${Json.stringify(v)} ${Text.includes(v.`pair`, half)} ${hi < v.`lo`}")',
      ),
      meta: LONE,
    });
    // The halves written side by side are the pair; `split("")` and `.`
    // part an astral character into its halves.
    expect(ended).toContain('MOVENG_ERROR: 2 4 true 4');
    expect(ended).toContain('"\\ud83d"');
    expect(ended).toContain('"\\udc00key": "\\ud800"');
  });

  it("reads a plugin's answer holding them: a record's data, and a records plugin's text spread into its code units", async () => {
    const answer = JSON.parse('{"text":"a page \\ud83d","data":{"name":"\\udfffAcme","x":"y"},"records":["a😀"]}');
    const { ended } = await run({
      source: program(
        '  page = probe({ q: msg.`subject` })',
        '  found = finds({ q: msg.`subject` })',
        '  fail("${page.name} ${Text.length(page.name)} ${Json.stringify(page)} ${Json.stringify(found)}")',
      ),
      invoked: answer,
    });
    expect(ended).toContain('"\\udfffAcme"');
    // `{ ..."a😀" }`: three code units, the pair's halves apart.
    expect(ended).toContain('"1": "\\ud83d"');
  });

  it('reads a model reply holding them, and traces an AI() prompt cut through a pair as JavaScript cuts it', async () => {
    const ai = await run({
      source: program('  x = ai("${msg.`subject`}")', '  fail("${Json.stringify(x)} ${Text.length(x.`a`)}")'),
      meta: LONE,
      replies: [JSON.parse('{"value":{"a":"\\ud800","\\udbffk":2}}')],
    });
    expect(ai.asked).toHaveLength(1);
    expect(ai.ended).toContain('\\\\ud800');
    // The trace keeps the prompt's first 300 code units: the high half.
    const long = { ...event(LONE), payload: { subject: `${'p'.repeat(299)}😀 tail`, meta: LONE } };
    const seen = { invoked: [] as unknown[], asked: [] as unknown[] };
    const input = { ...inputOf({ source: program('  x = ai("${msg.`subject`}")'), replies: [{ value: 1 }] }, makeFakeParkSink(), seen), event: long };
    resetRustRunStats();
    const result = await runMovement(input);
    expect(rustRunStats).toMatchObject({ segments: 1, shimFaults: 0 });
    const traced = result.trace.find((entry) => Reflect.get(entry, 'kind') === 'ai');
    expect(JSON.stringify(traced)).toEqual(expect.stringContaining(`${'p'.repeat(299)}\\ud83d…`));
    const extraction = await run({
      source: program(...ONE_COMPANY, '  fail("${found.name} ${Text.length(found.name)}")'),
      replies: [JSON.parse(`{"record":{"name":{"value":"${'n'.repeat(199)}😀\\udc00","evidence":{"item":0,"quote":"q"}}}}`)],
    });
    // Read in one call (before: the Rust engine retried).
    expect(extraction.asked).toHaveLength(1);
    expect(extraction.ended).toContain(' 202');
  });

  it('parks a value holding them as JavaScript writes it, and the park resumes to the same ending', async () => {
    const source = program('  v = msg.`meta`', '  h = Text.split(v.`pair`, "")', '  await sleep(1h)', '  fail("${Json.stringify(v)} ${Json.stringify(h)}")');
    const parked = await run({ source, meta: LONE });
    expect(parked.parks).toContain('\\ud83d');
    expect(await resumedFrom({ source, meta: LONE }, parked.parks)).toContain('"\\udc00key": "\\ud800"');
  });

  it.each([
    ['a U+FDD0', '\uFDD0'],
    ['a lone half', '\uDC00'],
  ])('parses a source holding %s with spans counted in UTF-16 units: the park resumes', async (_what, odd) => {
    // The character sits before a closure on its line, so every span after
    // it on that line must be counted as JavaScript counts it, or the resumed
    // closure's code is cut in the wrong place.
    const source = program(`  ready = () => { return msg.\`subject\` != "${odd}" }`, '  await sleep(1h)', '  fail("done ${ready()} ${Text.length("' + odd + '")}")');
    const parked = await run({ source });
    expect(await resumedFrom({ source }, parked.parks)).toContain('MOVENG_ERROR: done true 1');
  });

  it('crosses a host that is itself a wire (the HTTP host double), its JSON text holding the escapes', async () => {
    const source = program('  v = msg.`meta`', '  x = ai("${v.`hi`}")', '  fail("${Json.stringify(v)} ${Json.stringify(x)}")');
    const kept: HostRecording[] = [];
    const park = makeFakeParkSink();
    const recorded = {
      entry: 'run',
      input: inputOf({ source, meta: LONE, replies: [JSON.parse('{"value":"\\udbff!"}')] }, park, { invoked: [], asked: [] }),
      run: runMovement,
      keep: (r: HostRecording) => kept.push(r),
    } as const;
    await recordEntry(recorded).catch(() => undefined);
    const recording = kept[0];
    if (recording === undefined) throw new Error('test: the run was recorded');
    expect(JSON.stringify(recording)).toContain('\\udbff!');
    const double = await startHostDouble();
    try {
      const conversation = new RecordedConversation(recording.requests);
      double.serve(conversation);
      resetRustRunStats();
      const input = { ...inputOf({ source, meta: LONE }, makeFakeParkSink(), { invoked: [], asked: [] }), host: httpHost(double.url, recording.methods) };
      const outcome = await replayed(input);
      expect(rustRunStats).toMatchObject({ ...endedInRust(undefined), shimFaults: 0 });
      expect(verdictOf(recording, conversation, outcome)).toEqual({ kind: 'same' });
    } finally {
      await double.close();
    }
  });
});
