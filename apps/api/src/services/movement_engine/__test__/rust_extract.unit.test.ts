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
import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { LlmCallResult } from 'movement-engine/services/translation_graph/engine/batched_extraction/llm_call';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { FileTextResolution, TransformInvocationResult } from 'movement-engine/services/movement_engine/extraction';

import { availableChatModels } from 'movement-engine/lib/models/map';
import { RunCostCapExceeded } from 'movement-engine/lib/run_cost';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { makeUnstablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import { credentialIdsFor, makeFakeParkSink, makeTestHost, endedInRust } from 'movement-engine/services/movement_engine/test_host';
import { MovementRunFailed, resumeMovement, runFailureCause, runMovement, type RunMovementInput } from 'movement-engine/services/movement_engine/run';
import { MovementEngineError, isCheckFailure } from 'movement-engine/services/movement_engine/errors';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';
import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';

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

const PRELUDE = ['import { email } from adapters', 'import { dealflow_inbox } from credentials', 'inbox = connect email using dealflow_inbox', ''].join(
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
  /** The snapshot's `models`: absent, the snapshot says none. */
  models?: string[];
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
    catalog: { ...catalog, ...(c.files !== undefined ? { files: c.files } : {}), ...(c.models !== undefined ? { models: c.models } : {}) },
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
        extractCall: {
          call: async (request) => {
            asked.push({ label: request.label, model: request.model, effort: request.effort, maxTokens: request.maxTokens });
            return { parsedJson: replies.shift() ?? {}, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } };
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
      'import { fetchUrl as fetch } from plugins',
      'function m(msg: <inbox-[:message]->>) {',
      '  found = extract from [msg.`text`] through [fetch(msg.`text`)] {',
      '    name: "the company"',
      '  }',
      '}',
    ].join('\n');
    const plain = ['import { fetchUrl as fetch } from plugins', 'function m(msg: <inbox-[:message]->>) {', '  page = fetch(msg.`text`)', '}'].join('\n');
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
      'function m(msg: <inbox-[:message]->>) {',
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

  it("reads a library declaration's words, its base's included, in the library's own file", async () => {
    const library = ['export node Base: "a company" {', '  name: <text> "its name"', '}', 'export node Deal extends Base {', '  stage: <text> "its stage"', '}'].join(
      '\n',
    );
    const source = [
      'import { Deal } from "lib/deals"',
      'function m(msg: <inbox-[:message]->>) {',
      '  found = extract from [msg.`text`] {',
      '    node deal: <Deal>',
      '  }',
      '}',
    ].join('\n');
    const ts = await agree(
      { source, files: { 'lib/deals': { source: library } }, replies: [{ 'x:extract_result#1': [{ deal: [{ name: wrap('Acme'), stage: wrap('Seed') }] }] }] },
      { runsWhole: true },
    );
    expect(ts.asked).toHaveLength(1);
  });

  // PLAN-08A group F: a library's function runs in its library's own scope
  // (its file values, `type`s and shapes), and a call nested in an expression
  // there has a place of its own in the library's file, where the check's
  // stamps on it are.
  const TRIAGE = [
    'lens = "by the library\'s lens"',
    'type Verdict = <"Keep" | "Drop">',
    'node Local: "each company, ${lens}" {',
    '  verdict: <Verdict> "keep or drop"',
    '}',
    'export node Note {',
    '  body: <text>',
    '}',
    'export function triage(n: <Note>) {',
    '  found = extract from [n.body] {',
    '    overall: <Verdict> "the batch"',
    '    node entry: <Local>',
    '  }',
    '  copy = first(map([n], (v) => {',
    '    g = graph { ...v }',
    '    return g',
    '  }))',
    '  return Text.concat(copy.body, "/", coalesce(found.overall, "none"))',
    '}',
  ].join('\n');

  it("runs a library's function in the library's own scope, a call nested in it stamped where the library writes it", async () => {
    const source = [
      'import { triage as route } from "lib/triage"',
      'lens = "the importer\'s lens"',
      'type Verdict = <"Yes" | "No">',
      'function m(msg: <inbox-[:message]->>) {',
      '  r = route(node { body: msg.`text` })',
      '  return r',
      '}',
    ].join('\n');
    const ts = await agree(
      { source, files: { 'lib/triage': { source: TRIAGE } }, replies: [{ 'x:extract_result#1': [{ overall: wrap('Keep'), entry: [{ verdict: wrap('Drop') }] }] }] },
      { runsWhole: true },
    );
    expect('error' in ts ? String(ts.error) : 'ran').toBe('ran');
    expect(ts.asked).toHaveLength(1);
  });

  it("parks inside a library's function, and a shape declared in a body, as the TypeScript does; either engine's park resumes alike", async () => {
    const library = [
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      'crm = connect attio using acme_main',
      'export node Note {',
      '  body: <text>',
      '}',
      'export function keep(n: <Note>) {',
      '  node Tag: "a tag" {',
      '    label: <text> "its label"',
      '  }',
      '  await sleep(1h)',
      '  t = graph<Tag> { label: n.body }',
      '  write crm-[:companies]-> { name: t.label }',
      '  found = extract from [n.body] {',
      '    node tag: <Tag>',
      '  }',
      '  found-[g:tag]-> {',
      '    write crm-[:companies]-> { name: g.label }',
      '  }',
      '}',
    ].join('\n');
    const source = ['import { keep } from "lib/keep"', 'function m(msg: <inbox-[:message]->>) {', '  keep(node { body: msg.`text` })', '}'].join('\n');
    const files = { 'lib/keep': { source: library } };
    const reply = { 'x:extract_result#1': [{ tag: [{ label: wrap('Infra') }] }] };
    function hostWith(park: ReturnType<typeof makeFakeParkSink>, creates: unknown[]) {
      const crm: Adapter = {
        ...emailAdapter(),
        adapterType: 'attio',
        async createRecord(input) {
          creates.push({ fields: input.fields });
          return { adapterType: 'attio', externalId: `co-${creates.length}`, data: {} };
        },
      };
      return makeTestHost({
        adapters: { resolve: (r) => (r.adapterType === 'attio' ? crm : emailAdapter()) },
        llm: { client: { call: async (request) => ({ parsedJson: request.userMessage === undefined ? {} : reply }) } },
        park: { sink: park.sink },
      });
    }
    const input = { ...baseInput(source), catalog: { ...catalog, files } };
    async function on<T>(engine: 'ts' | 'rust', run: () => Promise<T>): Promise<T> {
      const previous = process.env.MOVEMENT_ENGINE;
      process.env.MOVEMENT_ENGINE = engine;
      try {
        return await run();
      } finally {
        if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
        else process.env.MOVEMENT_ENGINE = previous;
      }
    }
    const parkOn = (engine: 'ts' | 'rust') =>
      on(engine, async () => {
        const park = makeFakeParkSink();
        await runMovement({ ...input, host: hostWith(park, []) });
        expect(park.timerParks).toHaveLength(1);
        return JSON.stringify(park.timerParks[0]?.state);
      });
    const resumedOn = (engine: 'ts' | 'rust', state: string) =>
      on(engine, async () => {
        const creates: unknown[] = [];
        resetRustRunStats();
        const result = await resumeMovement({ ...input, state: JSON.parse(state) as ParkedScopeState, host: hostWith(makeFakeParkSink(), creates) });
        if (engine === 'rust') expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, notAdmitted: {}, declined: {}, shimFaults: 0 });
        return { creates, writes: result.writes, trace: result.trace };
      });
    const ts = await parkOn('ts');
    resetRustRunStats();
    const rust = await parkOn('rust');
    expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, shimFaults: 0 });
    expect(rust).toBe(ts);
    expect(ts).toContain('"kind":"localShape"');
    const resumed = await resumedOn('ts', ts);
    expect(resumed.creates).toEqual([{ fields: { name: 'Acme raised 3 million.' } }, { fields: { name: 'Infra' } }]);
    for (const [engine, state] of [['ts', rust], ['rust', ts], ['rust', rust]] as const) {
      const other = await resumedOn(engine, state);
      expect(JSON.stringify(other.creates)).toBe(JSON.stringify(resumed.creates));
      expect(other.writes).toEqual(resumed.writes);
      expect(other.trace).toEqual(resumed.trace);
    }
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
          const source = `function m(msg: <inbox-[:message]->>) {\n  d = extract ${tier}from [msg.\`text\`] {\n    name: "a"\n  }\n  return ai("why ${tier.length}", { tier: ${tier === '' ? '"careful"' : tier.trim()} })\n}`;
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

  // One model list (PLAN-08B Task 1): the snapshot's `models`, which the
  // checker holds a written model to, is the list both engines hold it to at
  // run time (`runChatModels`); a snapshot without one gets the deployment's
  // (`availableChatModels`), and the model is then unchecked.
  describe("an extraction call's written model, held to the run's one list", () => {
    const company = 'node Company {\n  name: <text>\n}\n';
    const calling = (model: string) =>
      `${company}function m(msg: <inbox-[:message]->>) {\n  found = extract([msg.\`text\`], Company, { model: '${model}' })\n  return count(found)\n}`;

    it('runs a listed model whole, the model asked the one written, on both engines', async () => {
      for (const models of [undefined, ['claude-opus-5', 'claude-sonnet-5']]) {
        const ts = await agree({ source: calling('claude-opus-5'), replies: [{ records: [] }], ...(models !== undefined ? { models } : {}) }, { runsWhole: true });
        expect(ts.asked).toMatchObject([{ model: 'claude-opus-5' }]);
      }
    });

    it('ends a checked program naming a model outside the list at its check, on both engines alike', async () => {
      const ts = await agree({ source: calling('claude-opus-5'), models: ['claude-sonnet-5'] }, { endsAtCheck: true });
      expect('error' in ts && runFailureCause(ts.error)).toMatchObject({ code: 'MOVENG_CHECK', message: expect.stringContaining('not a model this deployment reaches') });
      expect(ts.asked).toEqual([]);
    });

    it('fails an unchecked program naming a model outside the list identically on both engines, the list printed', async () => {
      // No `models` on the snapshot: the checker leaves the model unchecked,
      // and the run holds it to the deployment's list.
      const ts = await agree({ source: calling('claude-sonnet-4-6') }, { runsWhole: true });
      const cause = 'error' in ts ? runFailureCause(ts.error) : undefined;
      expect(cause).toBeInstanceOf(MovementEngineError);
      expect(cause).toMatchObject({
        code: 'MOVENG_RUNTIME',
        message: `MOVENG_RUNTIME: 'extract''s model 'claude-sonnet-4-6' is not a model this deployment reaches — it reaches ${availableChatModels().map((m) => `'${m}'`).join(', ')}`,
      });
      expect(ts.asked).toEqual([]);
    });
  });

  it('declines, before any effect, a file-level value holding a nested call (it stages nested calls in a body only)', async () => {
    resetRustRunStats();
    await runOn('rust', { source: `import { echo } from plugins\nsaid = { page: echo({ q: "x" }) }\nfunction m(msg: <inbox-[:message]->>) {\n  x = 1\n}` });
    expect(rustRunStats).toMatchObject({ routed: 1, admitted: 1, ranWhole: 0, notAdmitted: {}, declined: { unreproduced: 1 } });
    expect(Object.keys(rustRunStats.hostCalls).filter((call) => call !== 'check.program')).toEqual([]);
  });

  it('runs a plugin argument that calls a closure whole, its value what the closure returns (PLAN-08A Task 2)', async () => {
    const source = `import { fetchUrl as fetch_url, findFiles as find_files } from plugins\nfunction m(msg: <inbox-[:message]->>) {\n  loud = (t: <text>) => Text.upper(t)\n  page = fetch_url(loud(msg.\`text\`))\n}`;
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
    const declared = 'node Entry {\n  name: <text>\n  node __proto__ {\n    a: <text>\n  }\n}\nfunction m(msg: <inbox-[:message]->>) {\n  d = extract from [msg.`text`] {\n    node entry: <Entry>\n  }\n}';
    const reply = { 'x:extract_result#1': [{ __proto__: wrap(3), name: wrap('Acme') }] };
    const sources = [`${extract('  ')}\n  return d`, fan, `  if 1 == 1 {\n    g = 1\n  }\n${fan}`].map((body) => `function m(msg: <inbox-[:message]->>) {\n${body}\n}`);
    for (const source of [...sources, declared]) {
      const ts = await agree({ source, replies: [reply, reply, reply] }, { endsAtCheck: true });
      expect('error' in ts && runFailureCause(ts.error)).toMatchObject({ code: 'MOVENG_CHECK', message: expect.stringContaining('MOV_SHAPE_FIELD_PROTO') });
      expect(ts.asked).toEqual([]);
    }
  });

  it('suspends before a plugin call a suspendAt names, as the TypeScript engine does: it never invokes the plugin', async () => {
    const source = 'import { fetchUrl as fetch_url } from plugins\nfunction m(msg: <inbox-[:message]->>) {\n  page = fetch_url(msg.`text`)\n}';
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
      'import { fetchUrl as fetch_url } from plugins',
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      'crm = connect attio using acme_main',
      'function m(msg: <inbox-[:message]->>) {',
      '  crm-[e:companies]-> {',
      '    d = extract from [e.`name`] through [fetch_url(e.`name`)] {',
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

    it("keeps the entities a head's WHERE over a held extraction holds for, on both engines", async () => {
      const source = [
        'function m(msg: <inbox-[:message]->>) {',
        ...found,
        '  held = [found]',
        '  held-[c:company WHERE c.`name` == "Acme"]-> {',
        '    x = c.`name`',
        '  }',
        '}',
      ].join('\n');
      const ts = await agree({ source, replies: [companies] }, { runsWhole: true });
      expect('error' in ts && ts.error).toBeFalsy();
    });

    it("ends the event inside an input at the check (its deck is a file), and writes any other record there as its fields", async () => {
      // Main's record walk (group G): every record in an extraction input is
      // checked at any depth, and one whose fields include a file is refused
      // (MOV_EXTRACT_CONTENT) — the event's `deck` is one — on both engines,
      // before either is asked.
      const source = ['function m(msg: <inbox-[:message]->>) {', '  held = [msg]', '  found = extract from [held, msg.`text`] {', '    name: "the company"', '  }', '}'].join('\n');
      const ts = await agree({ source, replies: [{ 'x:extract_result#1': [{ name: wrap('Acme') }] }] }, { endsAtCheck: true });
      expect('error' in ts && String(ts.error)).toContain('MOV_EXTRACT_CONTENT');
      expect(ts.asked).toEqual([]);
      const again = ['function m(msg: <inbox-[:message]->>) {', ...found, '  more = extract from [found] {', '    name: "the company"', '  }', '}'].join('\n');
      // An earlier extraction's result runs on Rust too, written into the
      // prompt as its fields, byte for byte as the TypeScript's: the root's
      // own fields are none (its companies are an edge, not a field).
      const whole = await agree({ source: again, replies: [companies, { 'x:extract_result#1': [{ name: wrap('Acme') }] }] }, { runsWhole: true });
      expect(whole.asked).toEqual([
        expect.objectContaining({ userMessage: '## TEXT\nAcme raised 3 million.' }),
        expect.objectContaining({ userMessage: '## FRAGMENT\n{}' }),
      ]);
    });

    it("ends the event, and any other record, inside a plugin's argument at the check, a through stage's included", async () => {
      const program = (body: string) => ['import { echo } from plugins', 'function m(msg: <inbox-[:message]->>) {', body, '}'].join('\n');
      const through = (arg: string, before: readonly string[] = []) =>
        program([...before, `  d = extract from [msg.\`text\`] through [echo({ q: ${arg} })] {`, '    name: "the company"', '  }'].join('\n'));
      const named = { 'x:extract_result#1': [{ name: wrap('Acme') }] };
      // A through stage's argument is held to what the plugin takes, as a
      // plain call's is (main's record walk, group G): the event inside a
      // value ends at the check on both engines, before either is asked.
      for (const arg of ['[msg]', '{ k: msg }']) {
        const ts = await agree({ source: through(arg), replies: [named] }, { endsAtCheck: true });
        expect('error' in ts && String(ts.error)).toContain('MOV_CALL_ARG_TYPE');
        expect(ts.invoked).toEqual([]);
      }
      // A call's argument is typed: the checker refuses a record inside it
      // (the event's included, MOV_CALL_ARG_TYPE) on both engines, before
      // either engine is asked.
      for (const arg of ['[msg]', '{ k: msg }']) {
        const ts = await agree({ source: program(`  x = echo({ q: ${arg} })`) }, { endsAtCheck: true });
        expect('error' in ts && String(ts.error)).toContain('MOV_CALL_ARG_TYPE');
        expect(ts.invoked).toEqual([]);
      }
      // The event alone, in a through stage: its argument is now held as a
      // plain call's is, so it ends at the check as the call below does (the
      // event's `deck` is a file).
      const staged = await agree({ source: through('msg'), replies: [named] }, { endsAtCheck: true });
      expect('error' in staged && String(staged.error)).toContain("'q.deck' is file");
      // As a call's argument it ends at the check: a record handed whole to
      // structured data carries its fields, and the event's `deck` is a file
      // (main's file rule, MOV_CALL_ARG_TYPE at 'q.deck').
      const whole = await agree({ source: program('  x = echo({ q: msg })') }, { endsAtCheck: true });
      expect('error' in whole && String(whole.error)).toContain("'q.deck' is file");
      expect(whole.invoked).toEqual([]);
      // Any other record inside a through stage's argument ends at the check
      // too: before main's record walk it reached the Rust engine, which
      // refused it by name (plugin_arg_record).
      const held = await agree({ source: through('[found]', found), replies: [companies, named] }, { endsAtCheck: true });
      expect('error' in held && String(held.error)).toContain('MOV_CALL_ARG_TYPE');
      expect(held.invoked).toEqual([]);
    });
  });

  it("hands a through stage's plugin a record named bare as its fields, as a plain call's argument is handed them", async () => {
    const named = { 'x:extract_result#1': [{ name: wrap('Acme') }] };
    const program = (before: readonly string[], arg: string) =>
      [
        'import { echo } from plugins',
        'import { attio } from adapters',
        'import { acme_main } from credentials',
        'crm = connect attio using acme_main',
        'function m(msg: <inbox-[:message]->>) {',
        ...before,
        `  d = extract from [msg.\`text\`] through [echo({ q: ${arg} })] {`,
        '    name: "the company"',
        '  }',
        '}',
      ].join('\n');
    const cases: Array<{ before: string[]; arg: string; replies: unknown[]; fields: Record<string, unknown> }> = [
      { before: ['  co = write crm-[:companies]-> { name: "Acme" }'], arg: 'co', replies: [named], fields: { name: 'Acme' } },
      { before: ['  e = extract from [msg.`text`] {', '    name: "the company"', '  }'], arg: 'e', replies: [named, named], fields: { name: 'Acme' } },
      { before: ['  n = node { title: "t" }'], arg: 'n', replies: [named], fields: { title: 't' } },
    ];
    for (const c of cases) {
      const ts = await agree({ source: program(c.before, c.arg), replies: c.replies }, { runsWhole: true });
      expect(ts.invoked).toEqual([{ plugin: 'echo', config: { q: expect.objectContaining(c.fields) } }]);
    }
  });

  describe('a model reply holding a lone surrogate (transition artefacts row 9: read on, on both engines)', () => {
    const source = ['function m(msg: <inbox-[:message]->>) {', '  found = extract from [msg.`text`] {', '    name: "the company"', '  }', '}'].join('\n');
    // `JSON.parse`, so the surrogate is the reply's own. (A reply's own
    // `__proto__` key crosses as a key: rust_wire_round_trip.unit.test.ts.)
    const lone = JSON.parse('{"x:extract_result#1":[{"name":{"evidence":"q","value":"\\ud800"}}]}');

    it('reads the reply as it is, in one call, as the TypeScript does', async () => {
      const ts = await agree({ source, replies: [lone] }, { runsWhole: true });
      expect(ts.asked.map((a) => Reflect.get(a as object, 'label'))).toEqual(['movement_extraction']);
      expect(JSON.stringify('result' in ts ? ts.result : undefined)).toContain('\\ud800');
    });
  });

  describe("a plugin's or a file reader's answer holding a lone surrogate (transition artefacts row 9: read on, on both engines)", () => {
    // `JSON.parse`, so the surrogate is the answer's own. (An answer's own
    // `__proto__` key crosses as a key: rust_wire_round_trip.unit.test.ts.)
    const lone = JSON.parse('{"text":"\\ud800"}');
    const deck = { __brand: 'FileRef', name: 'deck.pdf', contentType: 'application/pdf', size: 12, source: { ownerAdapterType: 'email', handle: 'a-1' } };
    const plugin = ['import { fetchUrl as fetch_url } from plugins', 'function m(msg: <inbox-[:message]->>) {', '  page = fetch_url(msg.`text`)', '  fail("${Json.stringify(page)}")', '}'].join('\n');
    const file = ['function m(msg: <inbox-[:message]->>) {', '  found = extract from [msg.`deck`] {', '    name: "the company"', '  }', '}'].join('\n');
    const withDeck: TriggerEvent = { ...EVENT, payload: { subject: 'Acme', text: 'Acme raised 3 million.', deck } };
    const reply = { 'x:extract_result#1': [{ name: wrap('Acme') }] };

    it.each([
      ["a plugin's answer", { source: plugin, invoked: lone }],
      ["a file reader's answer", { source: file, event: withDeck, fileText: lone, replies: [reply] }],
    ] as const)('reads on when %s holds one, as the TypeScript does', async (_whose, c) => {
      await agree(c, { runsWhole: true });
    });
  });

  describe("the file reader's answer when storing its provenance failed (main's PR #25: text, no rawTextId)", () => {
    // The host's reader swaps U+0000 for a space, and when storing the text as
    // provenance fails it answers the text alone. The run carries on, on both
    // engines alike: the READ's value, the prompt and the trace.
    const deck = { __brand: 'FileRef', name: 'deck.pdf', contentType: 'application/pdf', size: 12, source: { ownerAdapterType: 'email', handle: 'a-1' } };
    const withDeck: TriggerEvent = { ...EVENT, payload: { subject: 'Acme', text: 'Acme raised 3 million.', deck } };
    const fileText = { text: 'The deck says GPT 5.6 Luna powers the product.' };
    const read = ['function m(msg: <inbox-[:message]->>) {', '  t = File.read(msg.`deck`)', '  fail("${t}")', '}'].join('\n');
    const file = ['function m(msg: <inbox-[:message]->>) {', '  found = extract from [msg.`deck`] {', '    name: "the company"', '  }', '}'].join('\n');
    const reply = { 'x:extract_result#1': [{ name: wrap('Acme') }] };

    it.each([
      ['READ', { source: read, event: withDeck, fileText }],
      ['an extraction', { source: file, event: withDeck, fileText, replies: [reply] }],
    ] as const)('%s reads on as the TypeScript does', async (_what, c) => {
      await agree(c, { runsWhole: true });
    });
  });

  it("fails the run by name, never as the shim's fault, when the file reader calls a file unreadable for a reason outside the four", async () => {
    const deck = { __brand: 'FileRef', name: 'deck.pdf', contentType: 'application/pdf', size: 12, source: { ownerAdapterType: 'email', handle: 'a-1' } };
    const source = ['function m(msg: <inbox-[:message]->>) {', '  t = File.read(msg.`deck`)', '}'].join('\n');
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
      'crm = connect attio using acme_main',
      'function m(msg: <inbox-[:message]->>) {',
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
      '  held = count(kept)',
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

