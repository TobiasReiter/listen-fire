// The extraction keyword and plugin calls in the Rust engine (chunk 6A Task
// 3b), held to the TypeScript engine: each program runs under
// MOVEMENT_ENGINE=ts and =rust against the same fakes, and the two must agree
// on the result (or the error), the trace, and every request the model client
// and the plugin invoker received. The corpora (`extraction.unit` and its
// neighbours) and the recorded runs are the broad oracle; these pin what
// they cannot: the cost cap on an aliased priced plugin, a model's number
// past the double range crossing the boundary, a library declaration's
// words read through the real declaration lookup, and a model's, a plugin's
// or a file reader's answer the eval wire cannot carry.

import { mockCatalogSnapshot, type InstanceSchema, type PluginSpec } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';
import type { Adapter } from '../../translation_graph/adapter';
import type { LlmCallResult } from '../../translation_graph/engine/batched_extraction/llm_call';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { FileTextResolution, TransformInvocationResult } from '../extraction';

import { RunCostCapExceeded } from '../../../lib/run_cost';
import { containerAssociation } from '../../translation_graph/adapter';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { makeUnstablePosition, positionData } from '../../translation_graph/types';
import { credentialIdsFor, makeFakeParkSink, makeTestHost, endedInRust } from '../test_host';
import { MovementRunFailed, resumeMovement, runFailureCause, runMovement, type RunMovementInput } from '../run';
import { MovementEngineError, isCheckFailure } from '../errors';
import type { ParkedScopeState } from '../serialize';
import { resetRustRunStats, rustRunStats } from '../rust_stats';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000b3');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text', deck: 'file' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

/** `fetch_url` as the registered catalog describes it: priced, a page of text. */
const registered = staticCatalogFromManifests({ credentials: {} }).plugin('fetch_url');
if (registered === undefined || !registered.priced) throw new Error('test: the catalog registers a priced fetch_url');
const fetchUrl: PluginSpec = registered;

/** A plugin that hands back one record per thing it found. */
const findFiles: PluginSpec = { args: ['q'], priced: false, output: { kind: 'records', fields: { url: 'text' } } };

/** A plugin whose argument is untyped: the checker lets anything through. */
const echo: PluginSpec = { args: ['q'], priced: false, effects: { ai: true }, output: { kind: 'value', type: 'text' } };

const attioSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: { company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } } },
};

const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: attioSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
  plugins: { fetch_url: fetchUrl, find_files: findFiles, echo },
});

const PRELUDE = ['import { email } from adapters', 'import { dealflow_inbox } from credentials', 'inbox = email(credentials: dealflow_inbox)', ''].join(
  '\n',
);

function emailAdapter(messages: ReadonlyArray<Record<string, unknown>> = []): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      const data = positionData(input.position) as Record<string, unknown> | undefined;
      return data?.[input.fieldId];
    },
    getRelated: async ({ fieldId }) =>
      fieldId === 'companies' ? messages.map((data) => ({ position: makeUnstablePosition({ adapterType: 'attio', recordType: 'company', data }) })) : [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

const EVENT: TriggerEvent = {
  pipelineInputId: 'pi-rust-extract',
  adapterType: 'email',
  triggerType: 'webhook',
  payload: { subject: 'Acme', text: 'Acme raised 3 million.' },
};

interface Case {
  source: string;
  replies?: readonly unknown[];
  invoked?: TransformInvocationResult;
  spend?: Pick<RunMovementInput, 'priorSpentMicrodollars' | 'costCapMicrodollars' | 'suspendAt'>;
  files?: Record<string, { source: string }>;
  /** What the host's file reader answers, for every file. */
  fileText?: FileTextResolution;
  event?: TriggerEvent;
  /** The companies a block over `crm` walks. */
  messages?: ReadonlyArray<Record<string, unknown>>;
  /** A park sink that can suspend: what it is handed is compared. */
  parks?: true;
}

/** A park sink that suspends, recording each call (its state key for key). */
function suspendingSink(parked: unknown[]) {
  const base = makeFakeParkSink().sink;
  return {
    ...base,
    commitSuspension: async (input: { address: string; state: unknown }) => {
      parked.push(['commitSuspension', input.address, JSON.stringify(input.state)]);
    },
    // As text: the request's key order is the TypeScript's, the segment last.
    commitLimitPause: async (pause: unknown) => {
      parked.push(['commitLimitPause', JSON.stringify(pause)]);
    },
  };
}

/** One run on one engine: what it returned or threw, and what the model
 *  client and the plugin invoker were asked. */
async function runOn(engine: 'ts' | 'rust', c: Case) {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const asked: unknown[] = [];
  const invoked: unknown[] = [];
  const parked: unknown[] = [];
  const replies = [...(c.replies ?? [])];
  const fileText = c.fileText;
  const input: RunMovementInput = {
    source: PRELUDE + c.source,
    event: c.event ?? EVENT,
    teamId: TEAM_ID,
    catalog: c.files !== undefined ? { ...catalog, files: c.files } : catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    ...c.spend,
    host: makeTestHost({
      adapters: { resolve: () => emailAdapter(c.messages) },
      ...(c.parks === true ? { park: { sink: suspendingSink(parked) } } : {}),
      llm: {
        client: {
          call: async (request): Promise<LlmCallResult> => {
            asked.push({ label: request.label, model: request.model, effort: request.effort, maxTokens: request.maxTokens, userMessage: request.userMessage });
            return { parsedJson: replies.shift() ?? {} };
          },
        },
        transforms: {
          invoke: async (request) => {
            invoked.push({ plugin: request.plugin, config: request.config });
            return c.invoked ?? { text: 'a page' };
          },
        },
      },
      files: fileText !== undefined ? { resolveFileText: async () => fileText } : {},
    }),
  };
  try {
    return { result: await runMovement(input), asked, invoked, parked };
  } catch (error) {
    return { error, asked, invoked, parked };
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

/** The case on both engines: they agree. `onRust` says what the Rust engine
 *  did with it: ran it whole, refused it (for the TypeScript engine), or
 *  was never asked, the checker having ended the run on either engine. */
async function agree(c: Case, onRust: { runsWhole: true } | { refused: string } | { endsAtCheck: true }) {
  const ts = await runOn('ts', c);
  resetRustRunStats();
  const rust = await runOn('rust', c);
  const rustError = 'error' in rust ? rust.error : undefined;
  if ('refused' in onRust) {
    expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 0, notAdmitted: { [onRust.refused]: 1 }, hostCalls: {} });
  } else {
    expect(isCheckFailure(rustError) ? String(rustError) : 'reached the engine').toEqual('endsAtCheck' in onRust ? expect.stringContaining('MOVENG_CHECK') : 'reached the engine');
    expect(rustRunStats).toMatchObject({ ...endedInRust(rustError), notAdmitted: {}, declined: {}, shimFaults: 0 });
  }
  expect(rust.asked).toEqual(ts.asked);
  expect(rust.invoked).toEqual(ts.invoked);
  expect(rust.parked).toEqual(ts.parked);
  if ('error' in ts) {
    expect('error' in rust).toBe(true);
    const rustError = 'error' in rust ? rust.error : undefined;
    expect(rustError?.constructor).toBe((ts.error as object).constructor);
    expect(String(rustError)).toBe(String(ts.error));
    expect(runFailureCause(rustError)?.constructor).toBe((runFailureCause(ts.error) as object).constructor);
    if (ts.error instanceof MovementRunFailed && rustError instanceof MovementRunFailed) expect(rustError.partial).toEqual(ts.error.partial);
  } else {
    expect('result' in rust ? rust.result : rust.error).toEqual(ts.result);
    // toEqual ignores key order; a trace entry's order is what a reader of the trace sees.
    expect(JSON.stringify('result' in rust ? rust.result?.trace : undefined)).toBe(JSON.stringify(ts.result?.trace));
  }
  return ts;
}

const wrap = (value: unknown) => ({ evidence: 'q', value });

describe('the extraction keyword and plugin calls on both engines', () => {
  it('refuses an ALIASED priced plugin once the run has spent its cap, without asking the host', async () => {
    const spent = { priorSpentMicrodollars: 1000, costCapMicrodollars: 1000 };
    const through = [
      'import { fetch_url as fetch } from plugins',
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extract from [msg.`text`] through [fetch(url: msg.`text`)] {',
      '    name: "the company"',
      '  }',
      '}',
    ].join('\n');
    const plain = ['import { fetch_url as fetch } from plugins', 'movement m(msg: <inbox-[:message]->>) {', '  page = fetch(url: msg.`text`)', '}'].join('\n');
    for (const source of [through, plain]) {
      const ts = await agree({ source, spend: spent }, { runsWhole: true });
      // The registered name is what is priced: the cap stops it before the
      // host is asked, however the import named it.
      expect('error' in ts && runFailureCause(ts.error)).toBeInstanceOf(RunCostCapExceeded);
      expect(ts.invoked).toEqual([]);
    }
    // Under the cap the plugin is invoked by the name it is registered under.
    const ts = await agree(
      { source: through, replies: [{ 'x:extract_result#1': [{ name: wrap('Acme') }] }] },
      { runsWhole: true },
    );
    expect(ts.invoked).toEqual([{ plugin: 'fetch_url', config: { url: 'Acme raised 3 million.' } }]);
  });

  it('reads a model number past the double range as JSON.parse left it: refused, and asked again', async () => {
    const source = [
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extract from [msg.`text`] {',
      '    amount: <number> "the amount raised"',
      '  }',
      '}',
    ].join('\n');
    const ts = await agree(
      {
        source,
        // `JSON.parse('1e999')` is Infinity, which zod's number check refuses.
        replies: [{ 'x:extract_result#1': [{ amount: wrap(Infinity) }] }, { 'x:extract_result#1': [{ amount: wrap(3000000) }] }],
      },
      { runsWhole: true },
    );
    expect(ts.asked).toHaveLength(2);
    const trace = 'result' in ts && ts.result !== undefined ? ts.result.trace : [];
    expect(trace[0]).toMatchObject({ kind: 'extraction', retried: ['  - x:extract_result#1.0.amount.value: Invalid input: expected number, received number'] });
  });

  it("reads a library declaration's words, its base's included, through the declaration lookup (the TypeScript engine's, while file imports are refused)", async () => {
    const library = ['export node Base: "a company" {', '  name: <text> "its name"', '}', 'export node Deal extends Base {', '  stage: <text> "its stage"', '}'].join(
      '\n',
    );
    const source = [
      'import { Deal } from "lib/deals"',
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extract from [msg.`text`] {',
      '    node deal: <Deal>',
      '  }',
      '}',
    ].join('\n');
    const ts = await agree(
      { source, files: { 'lib/deals': { source: library } }, replies: [{ 'x:extract_result#1': [{ deal: [{ name: wrap('Acme'), stage: wrap('Seed') }] }] }] },
      { refused: 'import_from_file' },
    );
    expect(ts.asked).toHaveLength(1);
  });

  // The tier is a run input on Rust (`extractionTiers`), the deployment's
  // EXTRACTION_TIERS as the TypeScript engine reads it, and AI()'s tiers a
  // fixed table: both engines ask the same models at the same depths.
  it("asks each tier's model and depth, the deployment's assignment over the built-in row, as the TypeScript engine does", async () => {
    const previous = process.env.EXTRACTION_TIERS;
    try {
      for (const tiers of [undefined, '{"careful": {"model": "claude-opus-5", "effort": "medium"}, "thorough": {"effort": "low"}}']) {
        if (tiers === undefined) delete process.env.EXTRACTION_TIERS;
        else process.env.EXTRACTION_TIERS = tiers;
        for (const tier of ['"quick" ', '"careful" ', '"thorough" ', '"smart" ', '']) {
          const source = `movement m(msg: <inbox-[:message]->>) {\n  d = extract ${tier}from [msg.\`text\`] {\n    name: "a"\n  }\n  return AI("why ${tier.length}", ${tier === '' ? '"careful"' : tier.trim()})\n}`;
          const ts = await agree({ source, replies: [{ 'x:extract_result#1': [{ name: wrap('Acme') }] }, { value: 'because', has_value: true }] }, { runsWhole: true });
          expect(ts.asked).toHaveLength(2);
          if (tiers !== undefined && tier === '"careful" ') {
            expect(ts.asked).toMatchObject([{ model: 'claude-opus-5', effort: 'medium', maxTokens: undefined }, { model: 'sonnet', effort: undefined }]);
          }
          if (tiers === undefined && tier === '"thorough" ') {
            expect(ts.asked).toMatchObject([{ model: 'sonnet', effort: 'xhigh', maxTokens: 64000 }, { model: 'opus5', maxTokens: 64000 }]);
          }
        }
      }
    } finally {
      if (previous === undefined) delete process.env.EXTRACTION_TIERS;
      else process.env.EXTRACTION_TIERS = previous;
    }
  });

  it('declines, before any effect, a file-level value holding a nested call (it stages nested calls in a body only)', async () => {
    resetRustRunStats();
    await runOn('rust', { source: `import { echo } from plugins\nsaid = { page: echo(q: "x") }\nmovement m(msg: <inbox-[:message]->>) {\n  x = 1\n}` });
    expect(rustRunStats).toMatchObject({ routed: 1, admitted: 1, ranWhole: 0, notAdmitted: {}, declined: { unreproduced: 1 } });
    expect(Object.keys(rustRunStats.hostCalls).filter((call) => call !== 'check.program')).toEqual([]);
  });

  it('runs a plugin argument that calls a closure whole, its value what the closure returns (PLAN-08A Task 2)', async () => {
    const source = `import { fetch_url, find_files } from plugins\nmovement m(msg: <inbox-[:message]->>) {\n  loud = (t: <text>) => UPPER(t)\n  page = fetch_url(url: loud(msg.\`text\`))\n}`;
    resetRustRunStats();
    await runOn('rust', { source });
    expect(rustRunStats).toMatchObject({ ranWhole: 1, notAdmitted: {}, declined: {} });
  });

  // The checker's MOV_SHAPE_FIELD_PROTO: the run ends at the check on both
  // engines, the Rust one having admitted it and asked for the check.
  it('ends a run whose extraction declares a field or node named __proto__ at the check, on both engines alike', async () => {
    const extract = (indent: string) =>
      [`${indent}d = extract from [msg.\`text\`] {`, `${indent}  __proto__: "p"`, `${indent}  name: "n"`, `${indent}}`].join('\n');
    const fan = ['  ys = MAP([1, 2], { onError: "ignore" }, (x) => {', extract('    '), '    return d', '  })', '  return ys'].join('\n');
    const declared = 'node Entry {\n  name: <text>\n  node __proto__ {\n    a: <text>\n  }\n}\nmovement m(msg: <inbox-[:message]->>) {\n  d = extract from [msg.`text`] {\n    node entry: <Entry>\n  }\n}';
    const reply = { 'x:extract_result#1': [{ __proto__: wrap(3), name: wrap('Acme') }] };
    const sources = [`${extract('  ')}\n  return d`, fan, `  if 1 == 1 {\n    g = 1\n  }\n${fan}`].map((body) => `movement m(msg: <inbox-[:message]->>) {\n${body}\n}`);
    for (const source of [...sources, declared]) {
      const ts = await agree({ source, replies: [reply, reply, reply] }, { endsAtCheck: true });
      expect('error' in ts && runFailureCause(ts.error)).toMatchObject({ code: 'MOVENG_CHECK', message: expect.stringContaining('MOV_SHAPE_FIELD_PROTO') });
      expect(ts.asked).toEqual([]);
    }
  });

  it('suspends before a plugin call a suspendAt names, as the TypeScript engine does: it never invokes the plugin', async () => {
    const source = 'import { fetch_url } from plugins\nmovement m(msg: <inbox-[:message]->>) {\n  page = fetch_url(url: msg.`text`)\n}';
    // With a sink that can suspend: the run parks before the call.
    const parked = await agree({ source, spend: { suspendAt: ['s0.c0'] }, parks: true }, { runsWhole: true });
    expect(parked.invoked).toEqual([]);
    expect(parked.parked).toEqual([['commitSuspension', 's0', expect.stringContaining('"suspended":true')]]);
    // Without one, there is nowhere to park.
    const failed = await agree({ source, spend: { suspendAt: ['s0.c0'] } }, { runsWhole: true });
    expect(failed.invoked).toEqual([]);
    expect('error' in failed && String(runFailureCause(failed.error))).toContain('nowhere durable to park');
  });

  it('suspends inside a block where the cap is met at an extraction’s priced stage, as the TypeScript engine does', async () => {
    const source = [
      'import { fetch_url } from plugins',
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      'crm = attio(credentials: acme_main)',
      'movement m(msg: <inbox-[:message]->>) {',
      '  crm-[e:companies]-> {',
      '    d = extract from [e.`name`] through [fetch_url(url: e.`name`)] {',
      '      name: "a"',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const c: Case = { source, spend: { priorSpentMicrodollars: 1000, costCapMicrodollars: 1000 }, messages: [{ name: 'one' }, { name: 'two' }] };
    const parked = await agree({ ...c, parks: true }, { runsWhole: true });
    expect(parked.invoked).toEqual([]);
    // The pause first, then each member's suspension, in that order (and
    // the same text on both engines: `agree` compared them).
    expect(parked.parked.map((p) => (p as unknown[])[0])).toEqual(['commitLimitPause', 'commitSuspension', 'commitSuspension']);
    expect((parked.parked[0] as unknown[])[1]).toMatch(/^\{"limit":"cost","capMicrodollars":\d+,"spentMicrodollars":\d+,"segmentId":"[^"]+"\}$/);
    const failed = await agree(c, { runsWhole: true });
    expect('error' in failed && runFailureCause(failed.error)).toBeInstanceOf(RunCostCapExceeded);
  });

  describe('records held as values reaching a request', () => {
    const companies = { 'x:extract_result#1': [{ company: [{ name: wrap('Acme') }, { name: wrap('Globex') }] }] };
    const found = ['  found = extract from [msg.`text`] {', '    node company: "each company named" {', '      name: "the company\'s name"', '    }', '  }'];

    it("fails a head's WHERE over a held extraction as the TypeScript does, before the body", async () => {
      const source = [
        'movement m(msg: <inbox-[:message]->>) {',
        ...found,
        '  held = [found]',
        '  held-[c:company WHERE `name` == "Acme"]-> {',
        '    x = c.`name`',
        '  }',
        '}',
      ].join('\n');
      const ts = await agree({ source, replies: [companies] }, { runsWhole: true });
      expect('error' in ts && String(runFailureCause(ts.error))).toContain('WHERE filters on extract-result block heads is not supported');
    });

    it("writes the event into the prompt as the JSON of its binding object, and refuses any other record there by name", async () => {
      const source = ['movement m(msg: <inbox-[:message]->>) {', '  held = [msg]', '  found = extract from [held, msg.`text`] {', '    name: "the company"', '  }', '}'].join('\n');
      const ts = await agree({ source, replies: [{ 'x:extract_result#1': [{ name: wrap('Acme') }] }] }, { runsWhole: true });
      expect(JSON.stringify(ts.asked)).toContain('## FRAGMENT\\n{\\"kind\\":\\"event\\"}');
      const again = ['movement m(msg: <inbox-[:message]->>) {', ...found, '  more = extract from [found] {', '    name: "the company"', '  }', '}'].join('\n');
      await agree({ source: again, replies: [companies, { 'x:extract_result#1': [{ name: wrap('Acme') }] }] }, { refused: 'extract_from_record' });
    });

    it("hands a plugin the event's binding object as the data it is, and refuses any other record inside a list by name", async () => {
      const program = (body: string) => ['import { echo } from plugins', 'movement m(msg: <inbox-[:message]->>) {', body, '}'].join('\n');
      const through = (arg: string, before: readonly string[] = []) =>
        program([...before, `  d = extract from [msg.\`text\`] through [echo(q: ${arg})] {`, '    name: "the company"', '  }'].join('\n'));
      const named = { 'x:extract_result#1': [{ name: wrap('Acme') }] };
      // A through stage's plugin arguments are untyped (main's nested-record
      // rule leaves them so): there the event inside a value still reaches
      // the plugin, as the data its binding object is.
      for (const [arg, q] of [
        ['[msg]', [{ kind: 'event' }]],
        ['{ k: msg }', { k: { kind: 'event' } }],
      ] as const) {
        const ts = await agree({ source: through(arg), replies: [named] }, { runsWhole: true });
        expect(ts.invoked).toEqual([expect.objectContaining({ plugin: 'echo', config: { q } })]);
      }
      // A call's argument is typed: the checker refuses a record inside it
      // (the event's included, MOV_CALL_ARG_TYPE) on both engines, before
      // either engine is asked.
      for (const arg of ['[msg]', '{ k: msg }']) {
        const ts = await agree({ source: program(`  x = echo(q: ${arg})`) }, { endsAtCheck: true });
        expect('error' in ts && String(ts.error)).toContain('MOV_CALL_ARG_TYPE');
        expect(ts.invoked).toEqual([]);
      }
      // The event alone is no value. In a through stage, whose arguments
      // are untyped, it passes the check and the Rust engine refuses it by
      // name; the TypeScript fails reading it.
      await agree({ source: through('msg'), replies: [named] }, { refused: 'name_not_value' });
      // As a call's argument it ends at the check: a record handed whole to
      // structured data carries its fields, and the event's `deck` is a file
      // (main's file rule, MOV_CALL_ARG_TYPE at 'q.deck').
      const whole = await agree({ source: program('  x = echo(q: msg)') }, { endsAtCheck: true });
      expect('error' in whole && String(whole.error)).toContain("'q.deck' is file");
      expect(whole.invoked).toEqual([]);
      // Any other record inside a through stage's argument is refused by name.
      const refused = await agree({ source: through('[found]', found), replies: [companies, named] }, { refused: 'plugin_arg_record' });
      // The TypeScript hands the plugin the extraction's binding object itself.
      expect(refused.invoked).toHaveLength(1);
    });
  });

  describe('a model reply this engine cannot read (a named divergence: the TypeScript reads on)', () => {
    const source = ['movement m(msg: <inbox-[:message]->>) {', '  found = extract from [msg.`text`] {', '    name: "the company"', '  }', '}'].join('\n');
    // `JSON.parse`, so the surrogate and the key are the reply's own.
    const lone = JSON.parse('{"x:extract_result#1":[{"name":{"evidence":"q","value":"\\ud800"}}]}');
    const proto = JSON.parse('{"x:extract_result#1":[{"name":{"evidence":"q","value":"Acme"},"__proto__":{"x":1}}]}');
    const valid = { 'x:extract_result#1': [{ name: wrap('Acme') }] };

    async function onEach(replies: unknown[]) {
      const ts = await runOn('ts', { source, replies });
      resetRustRunStats();
      const rust = await runOn('rust', { source, replies });
      // Never the shim's fault: the reply is the engine's to judge.
      expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, shimFaults: 0, declined: {} });
      return { ts, rust };
    }

    it.each([
      ['a lone surrogate', lone],
      ['a `__proto__` key', proto],
    ])('asks again when the reply holds %s, as for any reply the guide does not describe', async (_what, unreadable) => {
      const { ts, rust } = await onEach([unreadable, valid]);
      // TypeScript reads the reply as it is, in one call.
      expect('result' in ts).toBe(true);
      expect(ts.asked.map((a) => Reflect.get(a as object, 'label'))).toEqual(['movement_extraction']);
      expect(rust.asked.map((a) => Reflect.get(a as object, 'label'))).toEqual(['movement_extraction', 'movement_extraction_retry']);
      const trace = 'result' in rust && rust.result !== undefined ? rust.result.trace : [];
      expect(trace[0]).toMatchObject({
        kind: 'extraction',
        retried: ['  - : the reply held a key or a text this engine cannot read (a `__proto__` key, or a lone surrogate)'],
      });
    });

    it('fails the root call, twice unreadable, with the twice-unanswered text the TypeScript writes', async () => {
      const { ts, rust } = await onEach([lone, lone]);
      expect('result' in ts).toBe(true);
      expect('error' in rust && rust.error).toBeInstanceOf(MovementRunFailed);
      const cause = 'error' in rust ? runFailureCause(rust.error) : undefined;
      // The text the TypeScript fails a root answered twice with nothing it reads.
      const twice = await runOn('ts', { source, replies: [{}, {}] });
      const expected = 'error' in twice ? runFailureCause(twice.error) : undefined;
      expect(String(cause)).toContain('was answered with something the guide does not describe, twice.');
      expect(String(cause)).toBe(String(expected));
    });
  });

  describe("a plugin's or a file reader's answer this engine cannot read (a named divergence: the TypeScript reads on)", () => {
    // `JSON.parse`, so the surrogate and the key are the answer's own.
    const lone = JSON.parse('{"text":"\\ud800"}');
    // Inside a member: a stray top-level `__proto__` is no member either
    // engine reads, so the shim's object drops it and both read on. A file
    // reader's members are texts, so only a surrogate can reach one.
    const proto = JSON.parse('{"text":"a page","data":{"__proto__":{"x":1}}}');
    const deck = { __brand: 'FileRef', name: 'deck.pdf', contentType: 'application/pdf', size: 12, source: { ownerAdapterType: 'email', handle: 'a-1' } };
    const plugin = ['import { fetch_url } from plugins', 'movement m(msg: <inbox-[:message]->>) {', '  page = fetch_url(url: msg.`text`)', '}'].join('\n');
    const file = ['movement m(msg: <inbox-[:message]->>) {', '  found = extract from [msg.`deck`] {', '    name: "the company"', '  }', '}'].join('\n');
    const withDeck: TriggerEvent = { ...EVENT, payload: { subject: 'Acme', text: 'Acme raised 3 million.', deck } };
    const reply = { 'x:extract_result#1': [{ name: wrap('Acme') }] };

    it.each([
      ["a plugin's answer", 'a lone surrogate', { source: plugin, invoked: lone }, "'fetch_url''s answer", 'text'],
      ["a plugin's answer", 'a `__proto__` key', { source: plugin, invoked: proto }, "'fetch_url''s answer", 'data'],
      ["a file reader's answer", 'a lone surrogate', { source: file, event: withDeck, fileText: lone, replies: [reply] }, "a file's text", 'text'],
    ] as const)('fails the statement when %s holds %s, naming the member', async (_whose, _what, c, named, member) => {
      const ts = await runOn('ts', c);
      resetRustRunStats();
      const rust = await runOn('rust', c);
      // Never the shim's fault, never a refusal: the host was asked. The
      // engine's own refusal after an effect, where the TypeScript reads on:
      // counted unreproduced, a divergence (PLAN-08A Task 1), never mirrored.
      expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 0, mirroredFailure: 0, unreproduced: 1, endedAtCheck: 0, notAdmitted: {}, shimFaults: 0, declined: {} });
      // TypeScript reads the answer as it is.
      expect('result' in ts).toBe(true);
      expect('error' in rust && rust.error).toBeInstanceOf(MovementRunFailed);
      const cause = String('error' in rust ? runFailureCause(rust.error) : undefined);
      expect(cause).toContain('MOVENG_UNSUPPORTED');
      expect(cause).toContain(`${named} holding a \`__proto__\` key or a lone surrogate (in ${member})`);
    });
  });

  it("fails the run by name, never as the shim's fault, when the file reader calls a file unreadable for a reason outside the four", async () => {
    const deck = { __brand: 'FileRef', name: 'deck.pdf', contentType: 'application/pdf', size: 12, source: { ownerAdapterType: 'email', handle: 'a-1' } };
    const source = ['movement m(msg: <inbox-[:message]->>) {', '  t = READ(msg.`deck`)', '}'].join('\n');
    resetRustRunStats();
    const rust = await runOn('rust', { source, event: { ...EVENT, payload: { subject: 'Acme', deck } }, fileText: { unreadable: 'garbled' } as never });
    // A host-contract fault (the host broke its typed contract), which this
    // engine refuses where the TypeScript traces the reason as given: this
    // engine's own refusal after an effect, so counted unreproduced (a
    // divergence, README "Known divergences"), never mirrored.
    expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 0, mirroredFailure: 0, unreproduced: 1, shimFaults: 0 });
    const cause = String('error' in rust ? runFailureCause(rust.error) : undefined);
    expect(cause).toContain('MOVENG_UNSUPPORTED');
    expect(cause).toContain('a file the host calls unreadable for "garbled"');
  });

  it("parks what an extraction yielded as the TypeScript does, and either engine's park resumes to the same writes", async () => {
    const source = [
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      'crm = attio(credentials: acme_main)',
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extract from [msg.`text`] {',
      '    name: "the company"',
      '    node founder: "each founder" {',
      '      first: "first name"',
      '    }',
      '  }',
      // The founders held as the block's returned records.
      '  kept = found-[k:founder]-> {',
      '    return k',
      '  }',
      '  await sleep(1h)',
      '  write crm-[:companies]-> { name: found.name }',
      '  held = COUNT(kept)',
      '  write crm-[:companies]-> { name: "${held} kept" }',
      '  found-[f:founder]-> {',
      '    write crm-[:companies]-> { name: f.first }',
      '  }',
      '}',
    ].join('\n');
    const reply = { 'x:extract_result#1': [{ name: wrap('Acme'), founder: [{ first: wrap('Ada') }, { first: wrap('Grace') }] }] };
    /** A host whose CRM records what each create was handed. */
    function hostWith(park: ReturnType<typeof makeFakeParkSink>, creates: unknown[]) {
      const crm: Adapter = {
        ...emailAdapter(),
        adapterType: 'attio',
        async createRecord(input) {
          creates.push({ fields: input.fields, evidence: input.evidence, resources: input.resources });
          return { adapterType: 'attio', externalId: `co-${creates.length}`, data: {} };
        },
      };
      return makeTestHost({
        adapters: { resolve: (r) => (r.adapterType === 'attio' ? crm : emailAdapter()) },
        llm: { client: { call: async () => ({ parsedJson: reply }) } },
        park: { sink: park.sink },
      });
    }
    async function parkOn(engine: 'ts' | 'rust'): Promise<string> {
      const previous = process.env.MOVEMENT_ENGINE;
      process.env.MOVEMENT_ENGINE = engine;
      try {
        const park = makeFakeParkSink();
        await runMovement({ ...baseInput(source), host: hostWith(park, []) });
        expect(park.timerParks).toHaveLength(1);
        return JSON.stringify(park.timerParks[0]?.state);
      } finally {
        if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
        else process.env.MOVEMENT_ENGINE = previous;
      }
    }
    async function resumedOn(engine: 'ts' | 'rust', state: string) {
      const previous = process.env.MOVEMENT_ENGINE;
      process.env.MOVEMENT_ENGINE = engine;
      try {
        const creates: unknown[] = [];
        const parsed: ParkedScopeState = JSON.parse(state);
        resetRustRunStats();
        const result = await resumeMovement({ ...baseInput(source), state: parsed, host: hostWith(makeFakeParkSink(), creates) });
        if (engine === 'rust') expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, notAdmitted: {}, declined: {}, shimFaults: 0 });
        return { creates, writes: result.writes, trace: result.trace };
      } finally {
        if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
        else process.env.MOVEMENT_ENGINE = previous;
      }
    }
    const ts = await parkOn('ts');
    resetRustRunStats();
    const rust = await parkOn('rust');
    expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, shimFaults: 0 });
    expect(rust).toBe(ts);
    // What the extraction yielded, its records and the citations to it.
    for (const kind of ['"kind":"extractRoot"', '"kind":"extractPosition"', '"kind":"extraction"']) expect(ts).toContain(kind);
    // Each engine's state resumed on each: the same writes, trace and creates.
    const resumed = await resumedOn('ts', ts);
    for (const [engine, state] of [['ts', rust], ['rust', ts], ['rust', rust]] as const) {
      const other = await resumedOn(engine, state);
      expect(JSON.stringify(other.creates)).toBe(JSON.stringify(resumed.creates));
      expect(other.writes).toEqual(resumed.writes);
      expect(other.trace).toEqual(resumed.trace);
    }
    const fromTs = resumed.creates;
    // The resumed writes cite what was extracted, and carry its source.
    expect(fromTs).toEqual([
      expect.objectContaining({ fields: { name: 'Acme' }, evidence: { name: { quote: 'q', type: 'extraction' } }, resources: [expect.objectContaining({ type: 'TEXT' })] }),
      expect.objectContaining({ fields: { name: '2 kept' } }),
      expect.objectContaining({ fields: { name: 'Ada' } }),
      expect.objectContaining({ fields: { name: 'Grace' } }),
    ]);
  });
});

/** A run's input on the shared catalog, its host the caller's. */
function baseInput(source: string): Omit<RunMovementInput, 'host'> {
  return { source: PRELUDE + source, event: EVENT, teamId: TEAM_ID, catalog, credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`) };
}

