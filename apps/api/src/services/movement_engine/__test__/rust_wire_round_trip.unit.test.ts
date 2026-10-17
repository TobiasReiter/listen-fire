// The wire between the TypeScript host and the Rust engine, at every boundary
// a host's value crosses: the event, an adapter's answer, a plugin's answer, a
// model's reply, a parked state, and a host that is itself a wire (the HTTP
// host double). Each program runs on the Rust engine (version 5) against a
// host of its own, and the assertions say how the run must end and what the
// host was handed.
//
// The wire is plain JSON (version 5, Dancing Wren). The values are what
// `JSON.parse` makes of a host's text: an own `__proto__` key is a key like
// any other. It crosses as itself, and a map is a map: a read of it reads the
// own value, a spread copies it, `Json.stringify` prints it, and nothing ever
// makes it a prototype, so no read goes through one.
//
// A lone surrogate in a host's value (`JSON.parse('"\\ud83d"')` makes one)
// crosses as U+FFFD. Inside the run a text is read by character (code
// point): its length, a cut, a split and a regex keep an emoji whole, so the
// engine never makes a lone surrogate of its own.

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
  it('reads an event field holding one as the key it is: printed, read, spread and filed', async () => {
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
    // The own key printed and read, and no read goes through it.
    expect(ended).toContain('"__proto__": {');
    expect(ended).toContain('| "via" | null |');
    // The spread copied it as a key, which its print shows; still no read
    // goes through it.
    expect(ended).toMatch(/"b": 2,\s+"items"[\s\S]*\| null \| \{/);
    expect(ended).not.toMatch(/\| "via" \| \{/);
    // Filed under it as under any other key.
    expect(ended).toMatch(/"__proto__": \[\s+\{\s+"__proto__": "__proto__"/);
  });

  it("reads a plugin's answer holding one as a field: a record's, and a found record's", async () => {
    const answer = JSON.parse('{"text":"a page","data":{"name":"Acme","__proto__":{"x":"via"}},"records":[{"u":"1","__proto__":{"x":1}}]}');
    const { ended } = await run({
      source: program(
        '  page = probe({ q: msg.`subject` })',
        '  found = finds({ q: msg.`subject` })',
        '  fail("${page.name} ${page.x} ${Json.stringify(page)} ${Json.stringify(found)}")',
      ),
      invoked: answer,
    });
    // The data's key is a field of the record, and no read goes through it.
    expect(ended).toContain('MOVENG_ERROR: Acme  {');
    expect(ended).not.toContain('Acme via');
    // The trace names the data's keys as the answer held them.
    expect(ended).toContain('"fields":["name","__proto__"]');
    // Both records print it as the field they hold.
    expect(ended).toMatch(/"__proto__": \{\s+"x": "via"\s+\},\s+"name": "Acme"/);
    expect(ended).toMatch(/"__proto__": \{\s+"x": 1\s+\},\s+"u": "1"/);
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

  // MOV_NAME_PROTO applies before version 5 only.
  it('runs a program naming a binding or a parameter `__proto__`', async () => {
    const cases = [
      { body: ['  __proto__ = 1', '  fail("${__proto__}")'], ends: 'MOVENG_ERROR: 1 |' },
      { body: ['  xs = map([1, 2], (__proto__) => {', '    return __proto__', '  })', '  fail("${count(xs)}")'], ends: 'MOVENG_ERROR: 2 |' },
    ];
    for (const { body, ends } of cases) {
      const ran = await run({ source: program(...body) });
      expect(ran.ended).toContain(ends);
    }
  });

  it('parks a value holding one as the key it is, and the park resumes to the same ending', async () => {
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
  it('reads an event field holding them as U+FFFD: counted, split, matched, printed, compared by character', async () => {
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
    // Each half arrived as U+FFFD, so side by side they are no pair;
    // `split("")` and `.` keep an emoji whole.
    expect(ended).toMatch(/MOVENG_ERROR: 2 4 false 3 \[\s+"x",\s+"😀",\s+"y"\s+\] "😀" 1 /);
    expect(ended).not.toContain('\\ud83d');
    expect(ended).toContain('"\ufffdkey": "\ufffd"');
    expect(ended).not.toContain('\\udc00');
  });

  it("reads a plugin's answer holding them as U+FFFD: a record's data, and a records plugin's text spread into its characters", async () => {
    const answer = JSON.parse('{"text":"a page \\ud83d","data":{"name":"\\udfffAcme","x":"y"},"records":["a😀"]}');
    const { ended } = await run({
      source: program(
        '  page = probe({ q: msg.`subject` })',
        '  found = finds({ q: msg.`subject` })',
        '  fail("${page.name} ${Text.length(page.name)} ${Json.stringify(page)} ${Json.stringify(found)}")',
      ),
      invoked: answer,
    });
    expect(ended).toContain('MOVENG_ERROR: \ufffdAcme 5 {');
    expect(ended).toContain('"text": "a page \ufffd"');
    // `{ ..."a😀" }`: two characters, the emoji whole.
    expect(ended).toContain('"1": "😀"');
  });

  it('reads a model reply holding them as U+FFFD, and traces an AI() prompt cut by character', async () => {
    const ai = await run({
      source: program('  x = ai("${msg.`subject`}")', '  fail("${Json.stringify(x)} ${Text.length(x.`a`)}")'),
      meta: LONE,
      replies: [JSON.parse('{"value":{"a":"\\ud800","\\udbffk":2}}')],
    });
    expect(ai.asked).toHaveLength(1);
    expect(ai.ended).toContain('\\"a\\":\\"\ufffd\\"');
    expect(ai.ended).not.toContain('ud800');
    // The trace keeps the prompt's first 300 characters: the emoji whole.
    const long = { ...event(LONE), payload: { subject: `${'p'.repeat(299)}😀 tail`, meta: LONE } };
    const seen = { invoked: [] as unknown[], asked: [] as unknown[] };
    const input = { ...inputOf({ source: program('  x = ai("${msg.`subject`}")'), replies: [{ value: 1 }] }, makeFakeParkSink(), seen), event: long };
    resetRustRunStats();
    const result = await runMovement(input);
    expect(rustRunStats).toMatchObject({ segments: 1, shimFaults: 0 });
    const traced = result.trace.find((entry) => Reflect.get(entry, 'kind') === 'ai');
    expect(JSON.stringify(traced)).toEqual(expect.stringContaining(`${'p'.repeat(299)}😀…`));
    const extraction = await run({
      source: program(...ONE_COMPANY, '  fail("${found.name} ${Text.length(found.name)}")'),
      replies: [JSON.parse(`{"record":{"name":{"value":"${'n'.repeat(199)}😀\\udc00","evidence":{"item":0,"quote":"q"}}}}`)],
    });
    // Read in one call, the lone half as U+FFFD: 201 characters.
    expect(extraction.asked).toHaveLength(1);
    expect(extraction.ended).toContain('😀\ufffd 201');
  });

  it('parks a value holding them with U+FFFD for each lone half, and the park resumes to that ending', async () => {
    const source = program('  v = msg.`meta`', '  h = Text.split(v.`pair`, "")', '  await sleep(1h)', '  fail("${Json.stringify(v)} ${Json.stringify(h)}")');
    const parked = await run({ source, meta: LONE });
    // `split("")` keeps the emoji whole, so the park holds it as itself.
    expect(parked.parks).toContain('"h":{"kind":"value","value":["x","😀","y"]');
    expect(parked.parks).not.toContain('\\ud83d');
    const resumed = await resumedFrom({ source, meta: LONE }, parked.parks);
    expect(resumed).toContain('"\ufffdkey": "\ufffd"');
    expect(resumed).toMatch(/"x",\s+"😀",\s+"y"/);
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
