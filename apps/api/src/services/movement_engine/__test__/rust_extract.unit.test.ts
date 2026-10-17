// Extraction calls (`extract`, `extractOne`) and plugin calls in the Rust
// engine, the version-5 reference. Each program runs against fakes, and what
// the model client and the plugin invoker were asked, the park writes, and the
// result (or the error) are held to a snapshot read for correctness when it
// was recorded. The corpora (`extraction.unit` and its neighbours) and the
// recorded runs are the broad oracle; these pin what they cannot: the cost
// cap on an aliased priced plugin, a model's number past the double range
// crossing the boundary, a library declaration's words read through the real
// declaration lookup, and a model's, a plugin's or a file reader's answer the
// eval wire cannot carry.

import {
  fromCatalogSnapshot,
  mockCatalogSnapshot,
  type InstanceSchema,
  type PluginSpec,
} from 'movement-lang';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';

import { tenantIdOf } from 'engine-contracts';
import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { LlmCallResult } from 'movement-engine/services/translation_graph/engine/batched_extraction/llm_call';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type {
  FileTextResolution,
  TransformInvocationResult,
} from 'movement-engine/services/movement_engine/extraction';

import { availableChatModels } from 'movement-engine/lib/models/map';
import { RunCostCapExceeded } from 'movement-engine/lib/run_cost';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import {
  makeUnstablePosition,
  positionData,
} from 'movement-engine/services/translation_graph/types';
import {
  credentialIdsFor,
  makeFakeParkSink,
  makeTestHost,
  endedInRust,
} from 'movement-engine/services/movement_engine/test_host';
import {
  resumeMovement,
  runFailureCause,
  runMovement,
  type RunMovementInput,
} from 'movement-engine/services/movement_engine/run';
import {
  MovementEngineError,
  isCheckFailure,
} from 'movement-engine/services/movement_engine/errors';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';
import {
  resetRustRunStats,
  rustRunStats,
} from 'movement-engine/services/movement_engine/rust_stats';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000b3');

const emailSchema: InstanceSchema = {
  positions: {
    message: { properties: { subject: 'text', text: 'text', deck: 'file' }, edges: {} },
  },
  collections: {},
  writableRoots: {},
};

/** `fetch_url` as the registered catalog describes it: priced, a page of text. */
const registered = staticCatalogFromManifests({ credentials: {} }).plugin('fetch_url');
if (registered === undefined || !registered.priced)
  throw new Error('test: the catalog registers a priced fetch_url');
const fetchUrl: PluginSpec = registered;

/** A plugin that hands back one record per thing it found. */
const findFiles: PluginSpec = {
  args: ['q'],
  priced: false,
  output: { kind: 'records', fields: { url: 'text' } },
};

/** A plugin whose argument is untyped: the checker lets anything through. */
const echo: PluginSpec = {
  args: ['q'],
  priced: false,
  effects: { ai: true },
  output: { kind: 'value', type: 'text' },
};

const attioSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
  },
};

const catalog = mockCatalogSnapshot({
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: emailSchema,
    },
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: attioSchema,
    },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
  plugins: { fetch_url: fetchUrl, find_files: findFiles, echo },
});

const PRELUDE = [
  'import { email } from adapters',
  'import { dealflow_inbox } from credentials',
  'inbox = email(credentials: dealflow_inbox)',
  '',
].join('\n');

function emailAdapter(messages: ReadonlyArray<Record<string, unknown>> = []): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      const data = positionData(input.position) as Record<string, unknown> | undefined;
      return data?.[input.fieldId];
    },
    getRelated: async ({ fieldId }) =>
      fieldId === 'companies'
        ? messages.map((data) => ({
            position: makeUnstablePosition({ adapterType: 'attio', recordType: 'company', data }),
          }))
        : [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
    updateRecord: async (input) => ({
      adapterType: 'email',
      externalId: input.externalId,
      data: {},
      association: containerAssociation(input),
    }),
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

const spelledFiles = (files: Record<string, { source: string }>) =>
  Object.fromEntries(
    Object.entries(files).map(([name, file]) => [name, { source: spelled(file.source) }]),
  );

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };

/** The program as version 5 spells it (the shapes and calls are written so). */
const spelled = (source: string): string =>
  spelledFor(5, source, fromCatalogSnapshot(catalog));

/** One run on the Rust engine: what it returned or threw, and what the model
 *  client and the plugin invoker were asked. */
async function runOn(c: Case) {
  const asked: unknown[] = [];
  const invoked: unknown[] = [];
  const parked: unknown[] = [];
  const replies = [...(c.replies ?? [])];
  const fileText = c.fileText;
  const input: RunMovementInput = {
    source: spelled(PRELUDE + c.source),
    event: c.event ?? EVENT,
    teamId: TEAM_ID,
    catalog: {
      ...catalog,
      ...(c.files !== undefined ? { files: spelledFiles(c.files) } : {}),
      ...(c.models !== undefined ? { models: c.models } : {}),
    },
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    ...c.spend,
    host: makeTestHost({
      adapters: { resolve: () => emailAdapter(c.messages) },
      ...(c.parks === true ? { park: { sink: suspendingSink(parked) } } : {}),
      llm: {
        client: {
          call: async (request): Promise<LlmCallResult> => {
            asked.push({
              label: request.label,
              model: request.model,
              effort: request.effort,
              maxTokens: request.maxTokens,
              userMessage: request.userMessage,
            });
            return { parsedJson: replies.shift() ?? {} };
          },
        },
        extractCall: {
          call: async (request) => {
            asked.push({
              label: request.label,
              model: request.model,
              effort: request.effort,
              maxTokens: request.maxTokens,
              blocks: request.blocks.map((b) => b.text),
            });
            return { parsedJson: replies.shift() ?? {}, usage: USAGE };
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
  }
}

/** The case on the Rust engine, the version-5 reference: run whole, or ended
 *  at its check, and what the model was asked, the plugins invoked, the parks
 *  and the run's result (or failure) held to the recorded snapshot, read for
 *  correctness when it was recorded. */
async function onRust(c: Case, expected: { runsWhole: true } | { endsAtCheck: true }) {
  resetRustRunStats();
  const rust = await runOn(c);
  const rustError = 'error' in rust ? rust.error : undefined;
  expect(isCheckFailure(rustError) ? String(rustError) : 'reached the engine').toEqual(
    'endsAtCheck' in expected ? expect.stringContaining('MOVENG_CHECK') : 'reached the engine',
  );
  expect(rustRunStats).toMatchObject(endedInRust(rustError));
  // As JSON text: a lone surrogate a case sends through survives the snapshot
  // file only escaped.
  expect(
    JSON.stringify(
      {
        asked: rust.asked,
        invoked: rust.invoked,
        parked: rust.parked,
        outcome: 'error' in rust ? String(rust.error) : rust.result,
      },
      null,
      2,
    ),
  ).toMatchSnapshot();
  return rust;
}

const cite = (value: unknown) => ({ value, evidence: { item: 0, quote: 'q' } });

/** The one record `extractOne` answers (its fields, each cited). */
const one = (record: Record<string, unknown>) => ({ record });

const NAMED = 'node Named: "the company described" {\n  name: <text> "the company"\n}\n';
const named = one({ name: cite('Acme') });

/** The program calling `extractOne` over `content` for the shape `Named`. */
const askNamed = (content: string) =>
  `${NAMED}movement m(msg: <inbox-[:message]->>) {\n  found = extractOne(${content}, Named)\n}`;

describe('extraction calls and plugin calls in the Rust engine', () => {
  it('refuses an ALIASED priced plugin once the run has spent its cap, without asking the host', async () => {
    const source = [
      'import { fetch_url as fetch } from plugins',
      'movement m(msg: <inbox-[:message]->>) {',
      '  page = fetch(url: msg.`text`)',
      '}',
    ].join('\n');
    const spent = { priorSpentMicrodollars: 1000, costCapMicrodollars: 1000 };
    const refused = await onRust({ source, spend: spent }, { runsWhole: true });
    // The registered name is what is priced: the cap stops it before the
    // host is asked, however the import named it.
    expect('error' in refused && runFailureCause(refused.error)).toBeInstanceOf(RunCostCapExceeded);
    expect(refused.invoked).toEqual([]);
    // Under the cap the plugin is invoked by the name it is registered under.
    const under = await onRust({ source }, { runsWhole: true });
    expect(under.invoked).toEqual([
      { plugin: 'fetch_url', config: { url: 'Acme raised 3 million.' } },
    ]);
  });

  // `JSON.parse('1e999')` is Infinity, which crosses the wire as null: the
  // record's one field is empty, so the record is dropped, and nothing is
  // asked again.
  it('reads a model number past the double range as null: the record is dropped, and nothing is asked again', async () => {
    const source = [
      'node Raise: "the raise described" {',
      '  amount: <number> "the amount raised"',
      '}',
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extractOne([msg.`text`], Raise)',
      '}',
    ].join('\n');
    const rust = await onRust(
      {
        source,
        replies: [one({ amount: cite(Infinity) }), one({ amount: cite(3000000) })],
      },
      { runsWhole: true },
    );
    expect(rust.asked).toHaveLength(1);
    const trace = 'result' in rust && rust.result !== undefined ? rust.result.trace : [];
    expect(trace[0]).toMatchObject({ kind: 'extraction', dropped: { Raise: 1 } });
    expect(trace[0]).not.toHaveProperty('retried');
  });

  it("reads a library declaration's words, its base's included, in the library's own file", async () => {
    const library = [
      'export node Base: "a company" {',
      '  name: <text> "its name"',
      '}',
      'export node Deal extends Base {',
      '  stage: <text> "its stage"',
      '}',
    ].join('\n');
    const source = [
      'import { Deal } from "lib/deals"',
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extractOne([msg.`text`], Deal)',
      '}',
    ].join('\n');
    const rust = await onRust(
      {
        source,
        files: { 'lib/deals': { source: library } },
        replies: [one({ name: cite('Acme'), stage: cite('Seed') })],
      },
      { runsWhole: true },
    );
    expect(rust.asked).toHaveLength(1);
    const shape = String(Reflect.get(rust.asked[0] as object, 'blocks')).toLowerCase();
    expect(shape).toContain('its name');
    expect(shape).toContain('its stage');
  });

  // PLAN-08A group F: a library's function runs in its library's own scope
  // (its file values, `type`s and shapes), and a call nested in an expression
  // there has a place of its own in the library's file, where the check's
  // stamps on it are.
  const TRIAGE = [
    'lens = "by the library\'s lens"',
    'type Verdict = <"Keep" | "Drop">',
    'node Batch: "the batch" {',
    '  overall: <Verdict> "the batch"',
    '  node entry: "each company, ${lens}" {',
    '    verdict: <Verdict> "keep or drop"',
    '  }',
    '}',
    'export node Note {',
    '  body: <text>',
    '}',
    'export function triage(n: <Note>) {',
    '  found = extractOne([n.body], Batch)',
    '  copy = FIRST(MAP([n], (v) => {',
    '    g = graph { ...v }',
    '    return g',
    '  }))',
    '  return CONCAT(copy.body, "/", IF found == null THEN "none" ELSE found.overall END)',
    '}',
  ].join('\n');

  it("runs a library's function in the library's own scope, a call nested in it stamped where the library writes it", async () => {
    const source = [
      'import { triage as route } from "lib/triage"',
      'lens = "the importer\'s lens"',
      'type Verdict = <"Yes" | "No">',
      'movement m(msg: <inbox-[:message]->>) {',
      '  r = route(node { body: msg.`text` })',
      '  return r',
      '}',
    ].join('\n');
    const rust = await onRust(
      {
        source,
        files: { 'lib/triage': { source: TRIAGE } },
        replies: [one({ overall: cite('Keep'), entry: [{ verdict: cite('Drop') }] })],
      },
      { runsWhole: true },
    );
    expect('error' in rust ? String(rust.error) : 'ran').toBe('ran');
    expect(rust.asked).toHaveLength(1);
    // The shape's words are the library's, not the importer's.
    const blocks = String(Reflect.get(rust.asked[0] as object, 'blocks'));
    expect(blocks).toContain("by the library's lens");
    expect(blocks).not.toContain("the importer's lens");
  });

  it("parks inside a library's function, and a shape declared in a body; the park resumes to the same writes", async () => {
    const library = [
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      'crm = attio(credentials: acme_main)',
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
      '  found = extractOne([n.body], Tag)',
      '  if found != null {',
      '    write crm-[:companies]-> { name: found.label }',
      '  }',
      '}',
    ].join('\n');
    const source = [
      'import { keep } from "lib/keep"',
      'movement m(msg: <inbox-[:message]->>) {',
      '  keep(node { body: msg.`text` })',
      '}',
    ].join('\n');
    const files = { 'lib/keep': { source: library } };
    const reply = one({ label: cite('Infra') });
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
        llm: { extractCall: { call: async () => ({ parsedJson: reply, usage: USAGE }) } },
        park: { sink: park.sink },
      });
    }
    const input = { ...baseInput(source), catalog: { ...catalog, files: spelledFiles(files) } };
    const park = makeFakeParkSink();
    resetRustRunStats();
    await runMovement({ ...input, host: hostWith(park, []) });
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
    expect(park.timerParks).toHaveLength(1);
    const state = JSON.stringify(park.timerParks[0]?.state);
    expect(state).toContain('"kind":"localShape"');
    const creates: unknown[] = [];
    resetRustRunStats();
    const resumed = await resumeMovement({
      ...input,
      state: JSON.parse(state) as ParkedScopeState,
      host: hostWith(makeFakeParkSink(), creates),
    });
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
    expect(creates).toEqual([
      { fields: { name: 'Acme raised 3 million.' } },
      { fields: { name: 'Infra' } },
    ]);
    expect(resumed.writes).toHaveLength(2);
  });

  // The tier is a run input on Rust (`extractionTiers`), the deployment's
  // EXTRACTION_TIERS, and AI()'s tiers a fixed table.
  it("asks each tier's model and depth, the deployment's assignment over the built-in row", async () => {
    const previous = process.env.EXTRACTION_TIERS;
    try {
      for (const tiers of [
        undefined,
        '{"careful": {"model": "claude-opus-5", "effort": "medium"}, "thorough": {"effort": "low"}}',
      ]) {
        if (tiers === undefined) delete process.env.EXTRACTION_TIERS;
        else process.env.EXTRACTION_TIERS = tiers;
        for (const tier of ['"quick"', '"careful"', '"thorough"', '"smart"', '']) {
          const config = tier === '' ? '' : `, { tier: ${tier} }`;
          const source = `${NAMED}movement m(msg: <inbox-[:message]->>) {\n  d = extractOne([msg.\`text\`], Named${config})\n  return AI("why ${tier.length}", ${tier === '' ? '"careful"' : tier})\n}`;
          const rust = await onRust(
            { source, replies: [named, { value: 'because', has_value: true }] },
            { runsWhole: true },
          );
          expect(rust.asked).toHaveLength(2);
          if (tiers !== undefined && tier === '"careful"') {
            expect(rust.asked).toMatchObject([
              { model: 'claude-opus-5', effort: 'medium', maxTokens: undefined },
              { model: 'sonnet', effort: undefined },
            ]);
          }
          if (tiers === undefined && tier === '"thorough"') {
            expect(rust.asked).toMatchObject([
              { model: 'sonnet', effort: 'xhigh', maxTokens: 64000 },
              { model: 'opus5', maxTokens: 64000 },
            ]);
          }
        }
      }
    } finally {
      if (previous === undefined) delete process.env.EXTRACTION_TIERS;
      else process.env.EXTRACTION_TIERS = previous;
    }
  });

  // One model list (PLAN-08B Task 1): the snapshot's `models`, which the
  // checker holds a written model to, is the list the engine holds it to at
  // run time (`runChatModels`); a snapshot without one gets the deployment's
  // (`availableChatModels`), and the model is then unchecked.
  describe("an extraction call's written model, held to the run's one list", () => {
    const company = 'node Company {\n  name: <text>\n}\n';
    const calling = (model: string) =>
      `${company}movement m(msg: <inbox-[:message]->>) {\n  found = extract([msg.\`text\`], Company, { model: '${model}' })\n  return COUNT(found)\n}`;

    it('runs a listed model whole, the model asked the one written', async () => {
      for (const models of [undefined, ['claude-opus-5', 'claude-sonnet-5']]) {
        const rust = await onRust(
          {
            source: calling('claude-opus-5'),
            replies: [{ records: [] }],
            ...(models !== undefined ? { models } : {}),
          },
          { runsWhole: true },
        );
        expect(rust.asked).toMatchObject([{ model: 'claude-opus-5' }]);
      }
    });

    it('ends a checked program naming a model outside the list at its check', async () => {
      const rust = await onRust(
        { source: calling('claude-opus-5'), models: ['claude-sonnet-5'] },
        { endsAtCheck: true },
      );
      expect('error' in rust && runFailureCause(rust.error)).toMatchObject({
        code: 'MOVENG_CHECK',
        message: expect.stringContaining('not a model this deployment reaches'),
      });
      expect(rust.asked).toEqual([]);
    });

    it('fails an unchecked program naming a model outside the list, the list printed', async () => {
      // No `models` on the snapshot: the checker leaves the model unchecked,
      // and the run holds it to the deployment's list.
      const rust = await onRust({ source: calling('claude-sonnet-4-6') }, { runsWhole: true });
      const cause = 'error' in rust ? runFailureCause(rust.error) : undefined;
      expect(cause).toBeInstanceOf(MovementEngineError);
      expect(cause).toMatchObject({
        code: 'MOVENG_RUNTIME',
        message: `MOVENG_RUNTIME: 'extract''s model 'claude-sonnet-4-6' is not a model this deployment reaches — it reaches ${availableChatModels()
          .map((m) => `'${m}'`)
          .join(', ')}`,
      });
      expect(rust.asked).toEqual([]);
    });
  });

  // From version 5 a file-level value holds a value only: a call nested in
  // one is refused at the check, before the run starts.
  it('ends a run whose file-level value holds a nested call at the check (MOV_FILE_VALUE_RUNS)', async () => {
    const r = await onRust(
      {
        source: `import { echo } from plugins\nsaid = { page: echo(q: "x") }\nmovement m(msg: <inbox-[:message]->>) {\n  x = 1\n}`,
      },
      { endsAtCheck: true },
    );
    expect('error' in r && runFailureCause(r.error)).toMatchObject({
      code: 'MOVENG_CHECK',
      message: expect.stringContaining('MOV_FILE_VALUE_RUNS'),
    });
    expect(r.invoked).toEqual([]);
  });

  it('runs a plugin argument that calls a closure whole, its value what the closure returns (PLAN-08A Task 2)', async () => {
    const source = `import { fetch_url, find_files } from plugins\nmovement m(msg: <inbox-[:message]->>) {\n  loud = (t: <text>) => UPPER(t)\n  page = fetch_url(url: loud(msg.\`text\`))\n}`;
    resetRustRunStats();
    await runOn({ source });
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
  });

  // From version 5 `__proto__` is an ordinary name (MOV_SHAPE_FIELD_PROTO
  // applies before 5 only): the shape is asked for, and the reply's own key
  // read as the field it is.
  it('runs an extraction whose shape declares a field or node named __proto__', async () => {
    const flat = 'node Entry {\n  __proto__: <text> "p"\n  name: <text> "n"\n}\n';
    const call = (indent: string) => `${indent}d = extractOne([msg.\`text\`], Entry)`;
    const fan = [
      '  ys = MAP([1, 2], { onError: "ignore" }, (x) => {',
      call('    '),
      '    return d',
      '  })',
      '  return ys',
    ].join('\n');
    const declared =
      'node Entry {\n  name: <text>\n  node __proto__ {\n    a: <text>\n  }\n}\nmovement m(msg: <inbox-[:message]->>) {\n  d = extractOne([msg.`text`], Entry)\n}';
    // A computed key, so the reply holds `__proto__` as its own key.
    const reply = one({ ['__proto__']: cite('p'), name: cite('Acme') });
    const sources = [
      `${call('  ')}\n  return d`,
      fan,
      `  if 1 == 1 {\n    g = 1\n  }\n${fan}`,
    ].map((body) => `${flat}movement m(msg: <inbox-[:message]->>) {\n${body}\n}`);
    for (const source of sources) {
      const rust = await onRust({ source, replies: [reply, reply, reply] }, { runsWhole: true });
      expect(rust.asked.length).toBeGreaterThan(0);
    }
    const nested = one({ name: cite('Acme'), ['__proto__']: [{ a: cite('x') }] });
    const rust = await onRust({ source: declared, replies: [nested] }, { runsWhole: true });
    expect('error' in rust ? String(rust.error) : 'ran').toBe('ran');
  });

  it('suspends before a plugin call a suspendAt names: it never invokes the plugin', async () => {
    const source =
      'import { fetch_url } from plugins\nmovement m(msg: <inbox-[:message]->>) {\n  page = fetch_url(url: msg.`text`)\n}';
    // With a sink that can suspend: the run parks before the call.
    const parked = await onRust(
      { source, spend: { suspendAt: ['s0.c0'] }, parks: true },
      { runsWhole: true },
    );
    expect(parked.invoked).toEqual([]);
    expect(parked.parked).toEqual([
      ['commitSuspension', 's0', expect.stringContaining('"suspended":true')],
    ]);
    // Without one, there is nowhere to park.
    const failed = await onRust({ source, spend: { suspendAt: ['s0.c0'] } }, { runsWhole: true });
    expect(failed.invoked).toEqual([]);
    expect('error' in failed && String(runFailureCause(failed.error))).toContain(
      'nowhere durable to park',
    );
  });

  it('suspends inside a block where the cap is met at a priced plugin call', async () => {
    const source = [
      'import { fetch_url } from plugins',
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      'crm = attio(credentials: acme_main)',
      'movement m(msg: <inbox-[:message]->>) {',
      '  crm-[e:companies]-> {',
      '    page = fetch_url(url: e.`name`)',
      '  }',
      '}',
    ].join('\n');
    const c: Case = {
      source,
      spend: { priorSpentMicrodollars: 1000, costCapMicrodollars: 1000 },
      messages: [{ name: 'one' }, { name: 'two' }],
    };
    const parked = await onRust({ ...c, parks: true }, { runsWhole: true });
    expect(parked.invoked).toEqual([]);
    // The pause first, then each member's suspension, in that order.
    expect(parked.parked.map((p) => (p as unknown[])[0])).toEqual([
      'commitLimitPause',
      'commitSuspension',
      'commitSuspension',
    ]);
    expect((parked.parked[0] as unknown[])[1]).toMatch(
      /^\{"limit":"cost","capMicrodollars":\d+,"spentMicrodollars":\d+,"segmentId":"[^"]+"\}$/,
    );
    const failed = await onRust(c, { runsWhole: true });
    expect('error' in failed && runFailureCause(failed.error)).toBeInstanceOf(RunCostCapExceeded);
  });

  describe('records held as values reaching a request', () => {
    const DEALS =
      'node Deals: "the deals described" {\n  node company: "each company named" {\n    name: <text> "the company\'s name"\n  }\n}\n';
    const companies = one({ company: [{ name: cite('Acme') }, { name: cite('Globex') }] });
    const found = ['  found = extractOne([msg.`text`], Deals)'];

    it("keeps the entities a head's WHERE over a held extraction holds for", async () => {
      const source = [
        `${DEALS}movement m(msg: <inbox-[:message]->>) {`,
        ...found,
        '  if found != null {',
        '    held = [found]',
        '    held-[c:company WHERE c.`name` == "Acme"]-> {',
        '      x = c.`name`',
        '    }',
        '  }',
        '}',
      ].join('\n');
      const rust = await onRust({ source, replies: [companies] }, { runsWhole: true });
      expect('error' in rust && rust.error).toBeFalsy();
    });

    it('ends the event inside an input at the check (its deck is a file), and writes any other record there as its fields', async () => {
      // Main's record walk (group G): every record in an extraction input is
      // checked at any depth, and one whose fields include a file is refused
      // (MOV_EXTRACT_CONTENT) — the event's `deck` is one — before the engine
      // is asked.
      const source = askNamed('[...held, msg.`text`]').replace(
        '  found =',
        '  held = [msg]\n  found =',
      );
      const rust = await onRust({ source, replies: [named] }, { endsAtCheck: true });
      expect('error' in rust && String(rust.error)).toContain('MOV_EXTRACT_CONTENT');
      expect(rust.asked).toEqual([]);
      const again = [
        `${DEALS}${NAMED}movement m(msg: <inbox-[:message]->>) {`,
        ...found,
        '  if found != null {',
        '    more = extractOne([TEXT.SERIALISE(found, "JSON")], Named)',
        '  }',
        '}',
      ].join('\n');
      // An earlier extraction's result goes into the prompt as the text it is
      // rendered to.
      const whole = await onRust({ source: again, replies: [companies, named] }, { runsWhole: true });
      expect(whole.asked).toHaveLength(2);
      expect(String(Reflect.get(whole.asked[1] as object, 'blocks'))).toContain('Globex');
    });

    it("ends the event, and any other record, inside a plugin's argument at the check", async () => {
      const program = (body: string) =>
        ['import { echo } from plugins', 'movement m(msg: <inbox-[:message]->>) {', body, '}'].join(
          '\n',
        );
      // A call's argument is typed: the checker refuses a record inside it
      // (the event's included, MOV_CALL_ARG_TYPE), before the engine is asked.
      for (const arg of ['[msg]', '{ k: msg }']) {
        const rust = await onRust(
          { source: program(`  x = echo(q: ${arg})`) },
          { endsAtCheck: true },
        );
        expect('error' in rust && String(rust.error)).toContain('MOV_CALL_ARG_TYPE');
        expect(rust.invoked).toEqual([]);
      }
      // The event alone ends at the check: a record handed whole to
      // structured data carries its fields, and the event's `deck` is a file
      // (main's file rule, MOV_CALL_ARG_TYPE at 'q.deck').
      const whole = await onRust({ source: program('  x = echo(q: msg)') }, { endsAtCheck: true });
      expect('error' in whole && String(whole.error)).toContain("'q.deck' is file");
      expect(whole.invoked).toEqual([]);
      // Any other record inside a call's argument ends at the check too.
      const held = await onRust(
        {
          source: [
            `${DEALS}import { echo } from plugins`,
            'movement m(msg: <inbox-[:message]->>) {',
            ...found,
            '  x = echo(q: [found])',
            '}',
          ].join('\n'),
          replies: [companies],
        },
        { endsAtCheck: true },
      );
      expect('error' in held && String(held.error)).toContain('MOV_CALL_ARG_TYPE');
      expect(held.invoked).toEqual([]);
    });
  });

  it("hands a plugin a record named bare as its fields", async () => {
    const program = (before: readonly string[], arg: string) =>
      [
        NAMED,
        'import { echo } from plugins',
        'import { attio } from adapters',
        'import { acme_main } from credentials',
        'crm = attio(credentials: acme_main)',
        'movement m(msg: <inbox-[:message]->>) {',
        ...before,
        `  d = echo(q: ${arg})`,
        '}',
      ].join('\n');
    const cases: Array<{
      before: string[];
      arg: string;
      replies: unknown[];
      fields: Record<string, unknown>;
    }> = [
      {
        before: ['  co = write crm-[:companies]-> { name: "Acme" }'],
        arg: 'co',
        replies: [],
        fields: { name: 'Acme' },
      },
      {
        before: ['  e = extractOne([msg.`text`], Named)', '  if e != null {'],
        arg: 'e',
        replies: [named],
        fields: { name: 'Acme' },
      },
      { before: ['  n = node { title: "t" }'], arg: 'n', replies: [], fields: { title: 't' } },
    ];
    for (const c of cases) {
      const closing = c.before.includes('  if e != null {') ? '  }' : undefined;
      const source = program(c.before, c.arg).replace(
        /\n}$/,
        closing === undefined ? '\n}' : `\n${closing}\n}`,
      );
      const rust = await onRust({ source, replies: c.replies }, { runsWhole: true });
      expect(rust.invoked).toEqual([
        { plugin: 'echo', config: { q: expect.objectContaining(c.fields) } },
      ]);
    }
  });

  describe('a model reply holding a lone surrogate (transition artefacts row 9: read on)', () => {
    // `JSON.parse`, so the surrogate is the reply's own. (A reply's own
    // `__proto__` key crosses as a key: rust_wire_round_trip.unit.test.ts.)
    const lone = JSON.parse('{"record":{"name":{"evidence":{"item":0,"quote":"q"},"value":"\\ud800"}}}');

    it('reads the reply in one call, the surrogate as U+FFFD', async () => {
      const rust = await onRust(
        { source: askNamed('[msg.`text`]'), replies: [lone] },
        { runsWhole: true },
      );
      expect(rust.asked).toHaveLength(1);
      // The plain wire: a lone surrogate crosses as U+FFFD.
      expect(JSON.stringify('result' in rust ? rust.result : undefined)).toContain('\ufffd');
      expect(JSON.stringify('result' in rust ? rust.result : undefined)).not.toContain('\\ud800');
    });
  });

  describe("a plugin's or a file reader's answer holding a lone surrogate (transition artefacts row 9: read on)", () => {
    // `JSON.parse`, so the surrogate is the answer's own. (An answer's own
    // `__proto__` key crosses as a key: rust_wire_round_trip.unit.test.ts.)
    const lone = JSON.parse('{"text":"\\ud800"}');
    const deck = {
      __brand: 'FileRef',
      name: 'deck.pdf',
      contentType: 'application/pdf',
      size: 12,
      source: { ownerAdapterType: 'email', handle: 'a-1' },
    };
    const plugin = [
      'import { fetch_url } from plugins',
      'movement m(msg: <inbox-[:message]->>) {',
      '  page = fetch_url(url: msg.`text`)',
      '  ERROR("${TEXT.SERIALISE(page, "JSON")}")',
      '}',
    ].join('\n');
    const file = askNamed('[msg.`deck`]');
    const withDeck: TriggerEvent = {
      ...EVENT,
      payload: { subject: 'Acme', text: 'Acme raised 3 million.', deck },
    };

    it.each([
      ["a plugin's answer", { source: plugin, invoked: lone }],
      [
        "a file reader's answer",
        { source: file, event: withDeck, fileText: lone, replies: [named] },
      ],
    ] as const)('reads on when %s holds one', async (_whose, c) => {
      await onRust(c, { runsWhole: true });
    });
  });

  describe("the file reader's answer when storing its provenance failed (main's PR #25: text, no rawTextId)", () => {
    // The host's reader swaps U+0000 for a space, and when storing the text as
    // provenance fails it answers the text alone. The run carries on: the
    // READ's value, the prompt and the trace.
    const deck = {
      __brand: 'FileRef',
      name: 'deck.pdf',
      contentType: 'application/pdf',
      size: 12,
      source: { ownerAdapterType: 'email', handle: 'a-1' },
    };
    const withDeck: TriggerEvent = {
      ...EVENT,
      payload: { subject: 'Acme', text: 'Acme raised 3 million.', deck },
    };
    const fileText = { text: 'The deck says GPT 5.6 Luna powers the product.' };
    const read = [
      'movement m(msg: <inbox-[:message]->>) {',
      '  t = READ(msg.`deck`)',
      '  ERROR("${t}")',
      '}',
    ].join('\n');
    const file = askNamed('[msg.`deck`]');

    it.each([
      ['READ', { source: read, event: withDeck, fileText }],
      ['an extraction', { source: file, event: withDeck, fileText, replies: [named] }],
    ] as const)('%s reads on', async (_what, c) => {
      await onRust(c, { runsWhole: true });
    });
  });

  it("fails the run by name, never as the shim's fault, when the file reader calls a file unreadable for a reason outside the four", async () => {
    const deck = {
      __brand: 'FileRef',
      name: 'deck.pdf',
      contentType: 'application/pdf',
      size: 12,
      source: { ownerAdapterType: 'email', handle: 'a-1' },
    };
    const source = ['movement m(msg: <inbox-[:message]->>) {', '  t = READ(msg.`deck`)', '}'].join(
      '\n',
    );
    resetRustRunStats();
    const rust = await runOn({
      source,
      event: { ...EVENT, payload: { subject: 'Acme', deck } },
      fileText: { unreadable: 'garbled' } as never,
    });
    // A host-contract fault (the host broke its typed contract), which the
    // engine refuses by name; the engine's own refusal fails the run, so the
    // door's refusal counter stays empty.
    expect(rustRunStats.segments).toBe(1);
    expect(rustRunStats.shimFaults).toBe(0);
    expect(rustRunStats.unsupported).toEqual({});
    const cause = String('error' in rust ? runFailureCause(rust.error) : undefined);
    expect(cause).toContain('MOVENG_UNSUPPORTED');
    expect(cause).toContain('a file the host calls unreadable for "garbled"');
  });

  it("parks what an extraction yielded, and the park resumes to the same writes", async () => {
    const source = [
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      'crm = attio(credentials: acme_main)',
      'node Firm: "the company described" {',
      '  name: <text> "the company"',
      '  node founder: "each founder" {',
      '    first: <text> "first name"',
      '  }',
      '}',
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extractOne([msg.`text`], Firm)',
      '  if found != null {',
      // The founders held as the block's returned records.
      '    kept = found-[k:founder]-> {',
      '      return k',
      '    }',
      '    await sleep(1h)',
      '    write crm-[:companies]-> { name: found.name }',
      '    held = COUNT(kept)',
      '    write crm-[:companies]-> { name: "${held} kept" }',
      '    found-[f:founder]-> {',
      '      write crm-[:companies]-> { name: f.first }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const reply = one({
      name: cite('Acme'),
      founder: [{ first: cite('Ada') }, { first: cite('Grace') }],
    });
    /** A host whose CRM records what each create was handed. */
    function hostWith(park: ReturnType<typeof makeFakeParkSink>, creates: unknown[]) {
      const crm: Adapter = {
        ...emailAdapter(),
        adapterType: 'attio',
        async createRecord(input) {
          creates.push({
            fields: input.fields,
            evidence: input.evidence,
            resources: input.resources,
          });
          return { adapterType: 'attio', externalId: `co-${creates.length}`, data: {} };
        },
      };
      return makeTestHost({
        adapters: { resolve: (r) => (r.adapterType === 'attio' ? crm : emailAdapter()) },
        llm: { extractCall: { call: async () => ({ parsedJson: reply, usage: USAGE }) } },
        park: { sink: park.sink },
      });
    }
    resetRustRunStats();
    const park = makeFakeParkSink();
    await runMovement({ ...baseInput(source), host: hostWith(park, []) });
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
    expect(park.timerParks).toHaveLength(1);
    const state = JSON.stringify(park.timerParks[0]?.state);
    expect(state).toMatchSnapshot();
    const creates: unknown[] = [];
    resetRustRunStats();
    const result = await resumeMovement({
      ...baseInput(source),
      state: JSON.parse(state) as ParkedScopeState,
      host: hostWith(makeFakeParkSink(), creates),
    });
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
    expect(JSON.stringify({ writes: result.writes, trace: result.trace })).toMatchSnapshot();
    // The resumed writes cite what was extracted (the call form attaches no
    // source resources to a write, as the keyword did).
    expect(creates).toEqual([
      expect.objectContaining({
        fields: { name: 'Acme' },
        evidence: { name: { quote: 'q', type: 'extraction' } },
      }),
      expect.objectContaining({ fields: { name: '2 kept' } }),
      expect.objectContaining({ fields: { name: 'Ada' } }),
      expect.objectContaining({ fields: { name: 'Grace' } }),
    ]);
  });
});

/** A run's input on the shared catalog, its host the caller's. */
function baseInput(source: string): Omit<RunMovementInput, 'host'> {
  return {
    source: spelled(PRELUDE + source),
    event: EVENT,
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
  };
}
