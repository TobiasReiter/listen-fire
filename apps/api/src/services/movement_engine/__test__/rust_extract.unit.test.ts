// The extraction keyword and plugin calls in the Rust engine (chunk 6A Task
// 3b), held to the TypeScript engine: each program runs under
// MOVEMENT_ENGINE=ts and =rust against the same fakes, and the two must agree
// on the result (or the error), the trace, and every request the model client
// and the plugin invoker received. The corpora (`extraction.unit` and its
// neighbours) and the recorded runs are the broad oracle; these pin what
// they cannot: the cost cap on an aliased priced plugin, a model's number
// past the double range crossing the boundary, and a library declaration's
// words read through the real declaration lookup.

import { mockCatalogSnapshot, type InstanceSchema, type PluginSpec } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';
import type { Adapter } from '../../translation_graph/adapter';
import type { LlmCallResult } from '../../translation_graph/engine/batched_extraction/llm_call';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { TransformInvocationResult } from '../extraction';

import { RunCostCapExceeded } from '../../../lib/run_cost';
import { containerAssociation } from '../../translation_graph/adapter';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { positionData } from '../../translation_graph/types';
import { credentialIdsFor, makeFakeParkSink, makeTestHost } from '../test_host';
import { MovementRunFailed, resumeMovement, runFailureCause, runMovement, type RunMovementInput } from '../run';
import type { ParkedScopeState } from '../serialize';
import { resetRustRunStats, rustRunStats } from '../rust_stats';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000b3');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

/** `fetch_url` as the registered catalog describes it: priced, a page of text. */
const registered = staticCatalogFromManifests({ credentials: {} }).plugin('fetch_url');
if (registered === undefined || !registered.priced) throw new Error('test: the catalog registers a priced fetch_url');
const fetchUrl: PluginSpec = registered;

/** A plugin that hands back one record per thing it found. */
const findFiles: PluginSpec = { args: ['q'], priced: false, output: { kind: 'records', fields: { url: 'text' } } };

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
  plugins: { fetch_url: fetchUrl, find_files: findFiles },
});

const PRELUDE = ['import { email } from adapters', 'import { dealflow_inbox } from credentials', 'inbox = email(credentials: dealflow_inbox)', ''].join(
  '\n',
);

function emailAdapter(): Adapter {
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
    getRelated: async () => [],
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
  replies?: unknown[];
  invoked?: TransformInvocationResult;
  spend?: Pick<RunMovementInput, 'priorSpentMicrodollars' | 'costCapMicrodollars' | 'suspendAt'>;
  files?: Record<string, { source: string }>;
}

/** One run on one engine: what it returned or threw, and what the model
 *  client and the plugin invoker were asked. */
async function runOn(engine: 'ts' | 'rust', c: Case) {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const asked: unknown[] = [];
  const invoked: unknown[] = [];
  const replies = [...(c.replies ?? [])];
  const input: RunMovementInput = {
    source: PRELUDE + c.source,
    event: EVENT,
    teamId: TEAM_ID,
    catalog: c.files !== undefined ? { ...catalog, files: c.files } : catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    ...c.spend,
    host: makeTestHost({
      adapters: { resolve: () => emailAdapter() },
      llm: {
        client: {
          call: async (request): Promise<LlmCallResult> => {
            asked.push({ label: request.label, model: request.model, effort: request.effort, userMessage: request.userMessage });
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
    }),
  };
  try {
    return { result: await runMovement(input), asked, invoked };
  } catch (error) {
    return { error, asked, invoked };
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

/** The case on both engines: they agree. `onRust` says what the Rust engine
 *  did with it: ran it whole, or refused it (for the TypeScript engine). */
async function agree(c: Case, onRust: { runsWhole: true } | { refused: string }) {
  const ts = await runOn('ts', c);
  resetRustRunStats();
  const rust = await runOn('rust', c);
  if ('runsWhole' in onRust) expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, notAdmitted: {}, declined: {}, shimFaults: 0 });
  else expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 0, notAdmitted: { [onRust.refused]: 1 }, hostCalls: {} });
  expect(rust.asked).toEqual(ts.asked);
  expect(rust.invoked).toEqual(ts.invoked);
  if ('error' in ts) {
    expect('error' in rust).toBe(true);
    const rustError = 'error' in rust ? rust.error : undefined;
    expect(rustError?.constructor).toBe((ts.error as object).constructor);
    expect(String(rustError)).toBe(String(ts.error));
    expect(runFailureCause(rustError)?.constructor).toBe((runFailureCause(ts.error) as object).constructor);
    if (ts.error instanceof MovementRunFailed && rustError instanceof MovementRunFailed) expect(rustError.partial).toEqual(ts.error.partial);
  } else {
    expect('result' in rust ? rust.result : rust.error).toEqual(ts.result);
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

  it('refuses, before it asks its host anything, the extraction and plugin forms it does not run', async () => {
    const movement = (body: string) => `import { fetch_url, find_files } from plugins\nmovement m(msg: <inbox-[:message]->>) {\n${body}\n}`;
    for (const [c, reason] of [
      [{ source: movement('  page = fetch_url(msg.`text`)') }, 'plugin_call_form'],
      [{ source: movement('  found = find_files(q: msg.`text`)') }, 'plugin_call:records'],
      [{ source: movement('  page = fetch_url(url: msg.`text`)'), spend: { suspendAt: ['s0.c0'] } }, 'suspend_at_call'],
      [
        { source: movement('  inbox-[e:message]-> {\n    d = extract from [e.`text`] {\n      name: "a"\n    }\n  }'), spend: { costCapMicrodollars: 1000 } },
        'cost_cap_inside_block',
      ],
      [{ source: movement('  d = extract "careful" from [msg.`text`] {\n    name: "a"\n  }') }, 'extract_tier'],
    ] as const) {
      resetRustRunStats();
      await runOn('rust', c);
      expect([reason, rustRunStats.notAdmitted]).toEqual([reason, { [reason]: 1 }]);
      expect(rustRunStats.hostCalls).toEqual({});
    }
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
      '  await sleep(1h)',
      '  write crm-[:companies]-> { name: found.name }',
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
    async function resumedOnTypeScript(state: string) {
      const previous = process.env.MOVEMENT_ENGINE;
      process.env.MOVEMENT_ENGINE = 'ts';
      try {
        const creates: unknown[] = [];
        const parsed: ParkedScopeState = JSON.parse(state);
        await resumeMovement({ ...baseInput(source), state: parsed, host: hostWith(makeFakeParkSink(), creates) });
        return creates;
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
    const fromTs = await resumedOnTypeScript(ts);
    expect(await resumedOnTypeScript(rust)).toEqual(fromTs);
    // The resumed writes cite what was extracted, and carry its source.
    expect(fromTs).toEqual([
      expect.objectContaining({ fields: { name: 'Acme' }, evidence: { name: { quote: 'q', type: 'extraction' } }, resources: [expect.objectContaining({ type: 'TEXT' })] }),
      expect.objectContaining({ fields: { name: 'Ada' } }),
      expect.objectContaining({ fields: { name: 'Grace' } }),
    ]);
  });
});

/** A run's input on the shared catalog, its host the caller's. */
function baseInput(source: string): Omit<RunMovementInput, 'host'> {
  return { source: PRELUDE + source, event: EVENT, teamId: TEAM_ID, catalog, credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`) };
}
