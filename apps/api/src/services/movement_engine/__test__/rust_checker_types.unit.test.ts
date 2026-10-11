// Admission reads the types the checker holds a program to (chunk 7A Task
// 6b): a closure's parameter typed by a position is one record whose field
// reads are values; a call of a closure, a movement or an extraction hands
// back what its own returns hand back; a map spread of a record copies its
// fields; COALESCE, IF, AND and OR hand back one of their operands. Each
// form runs whole in Rust and agrees with the TypeScript engine. Where the
// checker is silent (a record through COALESCE or MULTI) admission still
// refuses by name, before any effect: the TypeScript engine hands such a
// record to its host as the binding object, which a real host refuses
// mid-run, after the run's earlier writes, so no Rust run could end as it.

import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { ExtractCallLlmInput, ExtractCallLlmResult } from '../extraction_call';

import { containerAssociation } from '../../translation_graph/adapter';
import { makeStablePosition, positionData } from '../../translation_graph/types';
import { makeTestHost } from '../test_host';
import { runFailureCause, runMovement, type MovementRunResult } from '../run';
import { resetRustEvalStats, resetRustRunStats, rustRunStats } from '../rust_stats';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000c6');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const companyFields = { name: 'text', stage: 'text' } as const;
const noteFields = { body: 'text', payload: 'json' } as const;
const attioSchema: InstanceSchema = {
  positions: {
    company: { properties: companyFields, edges: {} },
    note: { properties: noteFields, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: companyFields, resultShape: { externalId: 'text', ...companyFields } },
    note: { fields: noteFields, resultShape: { externalId: 'text', ...noteFields } },
  },
};

const credentialArg = [{ name: 'credentials', kind: 'credential' as const, required: true }];
const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: credentialArg, schema: emailSchema },
    attio: { constructionArgs: credentialArg, schema: attioSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'node Co: "each company named" {',
  '  name: <text> "its name"',
  '  stage: <text> "its stage"',
  '}',
  'type Tier = <"gold" | "silver">',
  '',
].join('\n');

/** The companies the system lists. */
const LISTED = { 'c-acme': { name: 'Acme', stage: 'lead' }, 'c-beta': { name: 'Beta', stage: 'won' } };

/** The system, recording what it is asked to write. */
function fakeAttio() {
  const writes: Array<[string, unknown]> = [];
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
    async getRelated() {
      return Object.entries(LISTED).map(([recordId, data]) => ({
        position: makeStablePosition({ adapterType: 'attio', recordType: 'company', recordId, data }),
      }));
    },
    async createRecord(input) {
      writes.push(['create', input.fields]);
      minted += 1;
      return { adapterType: 'attio', externalId: `attio-${minted}`, data: { ...input.fields } };
    },
    async updateRecord(input) {
      writes.push(['update', { id: input.externalId, ...input.fields }]);
      return { adapterType: 'attio', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    deleteRecord: async () => ({}),
  };
  return { adapter, writes };
}

function fakeEmail(): Adapter {
  return { ...fakeAttio().adapter, adapterType: 'email', getRelated: async () => [] };
}

/** The model names two companies, each quoted from the message. */
const extractLlm = {
  async call(_input: ExtractCallLlmInput): Promise<ExtractCallLlmResult> {
    const cite = (value: unknown) => ({ value, evidence: { item: 0, quote: 'q' } });
    return {
      parsedJson: { records: [{ name: cite('Acme'), stage: cite('lead') }, { name: cite('Beta'), stage: cite('won') }] },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    };
  },
};

function webhook(): TriggerEvent {
  return { pipelineInputId: 'pi-rust-checker-types', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'Acme and Beta' } };
}

interface Outcome {
  writes: Array<[string, unknown]>;
  result?: MovementRunResult;
  error?: string;
}

/** Closures and calls in an expression are the language from version 3. */
const COMPARED_VERSIONS: readonly LanguageVersion[] = [3, 4];

async function runOn(engine: 'ts' | 'rust', source: string, languageVersion: LanguageVersion): Promise<Outcome> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const attio = fakeAttio();
  try {
    const result = await runMovement({
      source,
      movementName: 'm',
      event: webhook(),
      teamId: TEAM_ID,
      catalog,
      languageVersion,
      host: makeTestHost({
        adapters: { resolve: ({ adapterType }) => (adapterType === 'attio' ? attio.adapter : fakeEmail()) },
        llm: { extractCall: extractLlm },
      }),
    });
    return { writes: attio.writes, result };
  } catch (error) {
    const cause = runFailureCause(error);
    return { writes: attio.writes, error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

/** A run's result as a caller reads it. */
function seen(outcome: Outcome) {
  return {
    writes: outcome.writes,
    error: outcome.error,
    result: outcome.result?.writes.map((w) => [w.recordType, w.outcome, w.writtenValues]),
    trace: outcome.result?.trace,
  };
}

/** `source` runs whole in Rust under every compared version, leaving the
 *  TypeScript engine's `writes`. */
async function wholeOnBoth(source: string, writes: Array<[string, unknown]>) {
  for (const languageVersion of COMPARED_VERSIONS) {
    const ts = await runOn('ts', source, languageVersion);
    expect(ts.error).toBeUndefined();
    expect(ts.writes).toEqual(writes);
    resetRustEvalStats();
    resetRustRunStats();
    const rust = await runOn('rust', source, languageVersion);
    expect(rustRunStats).toMatchObject({ routed: 1, admitted: 1, ranWhole: 1, notAdmitted: {}, declined: {} });
    expect(seen(rust)).toEqual(seen(ts));
  }
}

/** `source` passes the checker, and the Rust engine refuses it on its own
 *  parse by `reason`, asking the host nothing: the run is the TypeScript
 *  engine's, as that engine runs it. */
async function refusedOnBoth(source: string, reason: string) {
  for (const languageVersion of COMPARED_VERSIONS) {
    const ts = await runOn('ts', source, languageVersion);
    expect(ts.error ?? '').not.toContain('MOVENG_CHECK');
    resetRustEvalStats();
    resetRustRunStats();
    const rust = await runOn('rust', source, languageVersion);
    expect(rustRunStats).toMatchObject({ routed: 1, admitted: 0, ranWhole: 0, notAdmitted: { [reason]: 1 }, declined: {}, hostCalls: {} });
    expect(seen(rust)).toEqual(seen(ts));
  }
}

const movement = (...body: string[]) => [PRELUDE, 'movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n');
const withHelpers = (helpers: string[], ...body: string[]) => [PRELUDE, ...helpers, 'movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n');

describe("admission reads the checker's types, on both engines", () => {
  describe('a closure parameter typed by a position is one record, its field reads values', () => {
    it('over a graph the run built', async () => {
      await wholeOnBoth(
        movement('  x = graph<Co> { name: "Acme", stage: "lead" }', '  named = (r: <Co>) => {', '    write crm-[:notes]-> { body: r.name }', '  }', '  named(r: x)'),
        [['create', { body: 'Acme' }]],
      );
    });

    it('over a member a walk of a graph picked, and over a record the system wrote', async () => {
      await wholeOnBoth(
        movement(
          '  g = graph { name: "h", kept: [{ name: "Acme", stage: "lead" }, { name: "Beta", stage: "won" }] }',
          '  x = FIRST(g-[:kept ORDER BY name]->)',
          '  co = write crm-[:companies]-> { name: "Gamma" }',
          '  named = (r: <Co>) => {',
          '    write crm-[:notes]-> { body: "${r.name} (${r.stage})" }',
          '  }',
          '  named(r: x)',
          '  noted = (c: <crm-[:company]->>) => {',
          '    write crm-[:notes]-> { body: c.name }',
          '  }',
          '  noted(c: co)',
        ),
        [
          ['create', { name: 'Gamma' }],
          ['create', { body: 'Acme (lead)' }],
          ['create', { body: 'Gamma' }],
        ],
      );
    });
  });

  describe("a call's value is what the callee's returns hand back", () => {
    it('a closure called bound, nested in an expression, and inside a COALESCE', async () => {
      await wholeOnBoth(
        movement(
          '  base = 10',
          '  add = (v: <number>) => v + base',
          '  tag = (t: <text>) => UPPER(t)',
          '  y = add(1)',
          '  write crm-[:notes]-> { body: "${y}", payload: { y: y, z: add(2) } }',
          '  write crm-[:notes]-> { body: COALESCE(tag(msg.`subject`), "none") }',
        ),
        [
          ['create', { body: '11', payload: { y: 11, z: 12 } }],
          ['create', { body: 'ACME' }],
        ],
      );
    });

    it('a function with a declared return type, recursing', async () => {
      await wholeOnBoth(
        withHelpers(
          ['function trail(n: <number>): <text> {', '  if n <= 0 {', '    return "end"', '  }', '  rest = trail(n - 1)', '  return CONCAT("${n}", ",", rest)', '}'],
          '  x = trail(3)',
          '  write crm-[:notes]-> { body: x }',
        ),
        [['create', { body: '3,2,1,end' }]],
      );
    });

    it("a MAP whose function returns values, with its settings; a GROUPBY of a block's maps; a type's members", async () => {
      await wholeOnBoth(
        movement(
          '  out = MAP(["a", "b"], { concurrency: 2 }, (t) => {',
          '    return UPPER(t)',
          '  })',
          '  rows = crm-[c:companies]-> { return { stage: c.`stage`, name: c.`name` } }',
          '  by = GROUPBY(rows, (r) => { return COALESCE(AT(r, "stage"), "?") })',
          '  tiers = MEMBERS(<Tier>)',
          '  write crm-[:notes]-> { body: "x", payload: { out: out, by: by, tiers: tiers } }',
        ),
        [['create', { body: 'x', payload: { out: ['A', 'B'], by: { lead: [{ stage: 'lead', name: 'Acme' }], won: [{ stage: 'won', name: 'Beta' }] }, tiers: ['gold', 'silver'] } }]],
      );
    });

    it("an extraction call's records: a field read off one picked, nested in the write", async () => {
      await wholeOnBoth(movement('  write crm-[:companies]-> { name: COALESCE(FIRST(extract([msg.`text`], Co)).name, "none") }'), [['create', { name: 'Acme' }]]);
    });
  });

  it("a map spread of a record copies its fields; a MAP over maps holding records hands each map back", async () => {
    await wholeOnBoth(
      movement(
        '  found = extract([msg.`text`], Co)',
        '  merged = MAP(found, (c) => {',
        '    return { ...c, tag: UPPER(c.name) }',
        '  })',
        '  MAP(merged, (d) => {',
        '    write crm-[:companies]-> { name: d.tag, stage: d.stage }',
        '  })',
        '  rows = MAP(["p"], (p) => {',
        '    return { piece: p, entries: extract([msg.`text`], Co) }',
        '  })',
        '  MAP(rows, (row) => {',
        '    x = FIRST(row.entries)',
        '    write crm-[:notes]-> { body: COALESCE(x.name, "none") }',
        '  })',
      ),
      [
        ['create', { name: 'ACME', stage: 'lead' }],
        ['create', { name: 'BETA', stage: 'won' }],
        ['create', { body: 'Acme' }],
      ],
    );
  });

  describe('where the checker is silent, admission still refuses by name', () => {
    it('a record through COALESCE into a field', async () => {
      await refusedOnBoth(movement('  co = write crm-[:companies]-> { name: "a" }', '  write crm-[:notes]-> { body: COALESCE(co, "x") }'), 'write_field_record');
    });

    it('a record through COALESCE handed back by a closure', async () => {
      await refusedOnBoth(movement('  co = write crm-[:companies]-> { name: "a" }', '  f = () => COALESCE(co, "x")', '  write crm-[:notes]-> { body: f() }'), 'write_field_record');
    });

    it('a record through COALESCE handed to a parameter typed as a value', async () => {
      await refusedOnBoth(
        movement('  co = write crm-[:companies]-> { name: "a" }', '  note = (t: <text>) => {', '    write crm-[:notes]-> { body: t }', '  }', '  note(COALESCE(co, "x"))'),
        'call_arg_record',
      );
      await refusedOnBoth(movement('  co = write crm-[:companies]-> { name: "a" }', '  f = (t: <text>) => t', '  y = f(COALESCE(co, "x"))', '  write crm-[:notes]-> { body: y }'), 'call_arg_record');
    });

    it("a graph whose field holds a record through COALESCE, read off a closure's parameter", async () => {
      await refusedOnBoth(
        movement('  co = write crm-[:companies]-> { name: "a" }', '  x = graph<Co> { name: COALESCE(co, "x"), stage: "lead" }', '  named = (r: <Co>) => {', '    write crm-[:notes]-> { body: r.name }', '  }', '  named(r: x)'),
        'write_field_record',
      );
    });
  });
});
