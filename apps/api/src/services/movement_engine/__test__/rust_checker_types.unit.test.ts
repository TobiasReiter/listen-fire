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

/** `source` fails its check with `code` under every compared version, on
 *  both engines alike: the Rust engine is never asked. */
async function endsAtCheckOnBoth(source: string, code: string) {
  for (const languageVersion of COMPARED_VERSIONS) {
    const ts = await runOn('ts', source, languageVersion);
    expect(ts.error ?? '').toContain('MOVENG_CHECK');
    expect(ts.error ?? '').toContain(code);
    resetRustEvalStats();
    resetRustRunStats();
    const rust = await runOn('rust', source, languageVersion);
    expect(rustRunStats).toMatchObject({ ranWhole: 0, endedAtCheck: 1, notAdmitted: {}, declined: {}, hostCalls: {} });
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

  describe('a record handed to a position parameter is held to holding none in a field, at every call', () => {
    // The record reaches the graph's field through a closure's COALESCE. Since
    // main's B14 the checker sees what a closure's call may hold (from version
    // 3), so the entry is refused (MOV_GRAPH_ENTRY_RECORD) as the COALESCE
    // written in it is, below: both engines end at the check, and admission's
    // position_arg_record / write_field_record are no longer reached here.
    const DIRTY = ['  co = write crm-[:companies]-> { name: "a" }', '  write crm-[:notes]-> { body: "pre" }', '  f = () => COALESCE(co, "x")', '  x = graph<Co> { name: f(), stage: "lead" }'];

    it("a clean graph a helper reads field by field runs whole", async () => {
      await wholeOnBoth(
        withHelpers(['function hp(r: <Co>) {', '  write crm-[:notes]-> { body: "h", payload: { n: r.name } }', '}'], '  x = graph<Co> { name: "Acme", stage: "lead" }', '  hp(r: x)'),
        [['create', { body: 'h', payload: { n: 'Acme' } }]],
      );
    });

    it("a graph holding a record through COALESCE, handed to a helper that reads it", async () => {
      await endsAtCheckOnBoth(withHelpers(['function hp2(r: <Co>) {', '  write crm-[:notes]-> { body: r.name }', '}'], ...DIRTY, '  hp2(r: x)'), 'MOV_GRAPH_ENTRY_RECORD');
    });

    it("the same graph, passed on by the helper to a closure", async () => {
      await endsAtCheckOnBoth(
        withHelpers(['function hp(r: <Co>) {', '  named = (q: <Co>) => {', '    write crm-[:notes]-> { body: "h", payload: { n: q.name } }', '  }', '  named(q: r)', '}'], ...DIRTY, '  hp(r: x)'),
        'MOV_GRAPH_ENTRY_RECORD',
      );
    });

    it('a graph a function built holding a record, handed back and read off a closure parameter', async () => {
      await endsAtCheckOnBoth(
        withHelpers(
          ['function mk(c: <crm-[:company]->>) {', '  f = () => COALESCE(c, "x")', '  g = graph<Co> { name: f(), stage: "s" }', '  return g', '}'],
          '  co = write crm-[:companies]-> { name: "a" }',
          '  write crm-[:notes]-> { body: "pre" }',
          '  x = mk(c: co)',
          '  named = (r: <Co>) => {',
          '    write crm-[:notes]-> { body: "h", payload: { n: r.name } }',
          '  }',
          '  named(r: x)',
        ),
        'MOV_GRAPH_ENTRY_RECORD',
      );
    });
  });

  describe("where main's record walk lets the checker see the record, the run ends at the check on both engines", () => {
    // Before group G the checker was silent here and the Rust engine refused
    // each by name (call_arg_record, write_field_record).
    it('MULTI of a record handed to a json parameter', async () => {
      await endsAtCheckOnBoth(
        movement('  co = write crm-[:companies]-> { name: "a" }', '  note = (t: <json>) => {', '    write crm-[:notes]-> { body: "n", payload: t }', '  }', '  note(MULTI(co))'),
        'MOV_CALL_ARG_TYPE',
      );
    });

    it('a record through COALESCE into a field', async () => {
      await endsAtCheckOnBoth(movement('  co = write crm-[:companies]-> { name: "a" }', '  write crm-[:notes]-> { body: COALESCE(co, "x") }'), 'MOV_WRITE_FIELD_TYPE');
    });

    it("a record through COALESCE written in a graph's entry", async () => {
      // Before main's graph-entry rule the checker was silent here too, and the
      // Rust engine refused it by name (position_arg_record, write_field_record);
      // those refusals are now reached through a closure's value, above and below.
      await endsAtCheckOnBoth(
        movement('  co = write crm-[:companies]-> { name: "a" }', '  x = graph<Co> { name: COALESCE(co, "x"), stage: "lead" }', '  named = (r: <Co>) => {', '    write crm-[:notes]-> { body: r.name }', '  }', '  named(r: x)'),
        'MOV_GRAPH_ENTRY_RECORD',
      );
    });

    // Since main's B14 the checker sees what a closure's call may hold (from
    // version 3); before it, admission refused each by name (write_field_record).
    it('a record through COALESCE handed back by a closure', async () => {
      await endsAtCheckOnBoth(movement('  co = write crm-[:companies]-> { name: "a" }', '  f = () => COALESCE(co, "x")', '  write crm-[:notes]-> { body: f() }'), 'MOV_WRITE_FIELD_TYPE');
    });

    it("a graph whose field holds a record through COALESCE, read off a closure's parameter", async () => {
      await endsAtCheckOnBoth(
        movement('  co = write crm-[:companies]-> { name: "a" }', '  f = () => COALESCE(co, "x")', '  x = graph<Co> { name: f(), stage: "lead" }', '  named = (r: <Co>) => {', '    write crm-[:notes]-> { body: r.name }', '  }', '  named(r: x)'),
        'MOV_GRAPH_ENTRY_RECORD',
      );
    });
  });

  describe('where the checker is silent, admission still refuses by name', () => {
    it('a record through COALESCE handed to a parameter typed as a value', async () => {
      await refusedOnBoth(
        movement('  co = write crm-[:companies]-> { name: "a" }', '  note = (t: <text>) => {', '    write crm-[:notes]-> { body: t }', '  }', '  note(COALESCE(co, "x"))'),
        'call_arg_record',
      );
      await refusedOnBoth(movement('  co = write crm-[:companies]-> { name: "a" }', '  f = (t: <text>) => t', '  y = f(COALESCE(co, "x"))', '  write crm-[:notes]-> { body: y }'), 'call_arg_record');
    });
  });
});

// B15: a value that may be a record and may be data, handed to a parameter
// that takes a record position. Before version 5 the checker passes it, and
// the TypeScript engine binds the record, or fails passing the data
// (`evaluateCallArg`); the Rust engine runs it whole and ends alike, for each
// member the value turns out to be. From version 5 the checker refuses it
// (MOV_CALL_ARG_MAYBE_RECORD) on both engines.
describe('a maybe-record handed to a position parameter (B15)', () => {
  const HP = ['movement hp(r: <crm-[:company]->>) {', '  write crm-[:notes]-> { body: r.name }', '}'];
  /** The value: the record where the subject is `Acme`, else `other`. */
  const either = (subject: string, other: string) => `IF msg.\`subject\` = "${subject}" THEN org ELSE ${other} END`;
  const shapes = (subject: string, other: string): Array<[string, string]> => [
    ['written in place', withHelpers(HP, '  org = write crm-[:companies]-> { name: "Org" }', `  hp(r: ${either(subject, other)})`)],
    ['bound to a name', withHelpers(HP, '  org = write crm-[:companies]-> { name: "Org" }', `  v = ${either(subject, other)}`, '  hp(r: v)')],
    ['through COALESCE', withHelpers(HP, '  org = write crm-[:companies]-> { name: "Org" }', `  hp(r: COALESCE(${either(subject, 'NULL')}, ${other}))`)],
    ['a closure handing it back, called in place', withHelpers(HP, '  org = write crm-[:companies]-> { name: "Org" }', `  c = () => ${either(subject, other)}`, '  hp(r: c())')],
    ['a closure handing it back, bound', withHelpers(HP, '  org = write crm-[:companies]-> { name: "Org" }', `  c = () => ${either(subject, other)}`, '  w = c()', '  hp(r: w)')],
  ];

  /** Runs whole on Rust under version 4, ending as the TypeScript does. */
  async function sameOnBoth(source: string, version: LanguageVersion = 4) {
    const ts = await runOn('ts', source, version);
    expect(ts.error ?? '').not.toContain('MOVENG_CHECK');
    resetRustEvalStats();
    resetRustRunStats();
    const rust = await runOn('rust', source, version);
    expect(rustRunStats).toMatchObject({ routed: 1, admitted: 1, notAdmitted: {}, declined: {} });
    expect(seen(rust)).toEqual(seen(ts));
    return ts;
  }

  for (const [member, subject, other] of [
    ['the record', 'Acme', '"x"'],
    ['text', 'nope', '"x"'],
    ['a number', 'nope', '3'],
    ['null', 'nope', 'NULL'],
  ] as const) {
    for (const version of [1, 2, 3, 4] as LanguageVersion[]) {
      // A closure is not a value before version 3.
      it.each(shapes(subject, other).filter(([shape]) => version >= 3 || !shape.startsWith('a closure')))(`version ${version}, the value is ${member}: %s`, async (_shape, source) => {
        const ts = await sameOnBoth(source, version);
        if (member === 'the record') expect(ts.writes).toContainEqual(['create', { body: 'Org' }]);
      });
    }
  }

  it('version 4, a declared function handing it back', async () => {
    for (const subject of ['Acme', 'nope']) {
      const fn = [
        'function f(s: <text>) {',
        '  a = write crm-[:companies]-> { name: "Fn" }',
        `  return IF s = "${subject}" THEN a ELSE "x" END`,
        '}',
      ];
      await sameOnBoth(withHelpers([...HP, ...fn], '  hp(r: f(s: msg.`subject`))'));
      await sameOnBoth(withHelpers([...HP, ...fn], '  w = f(s: msg.`subject`)', '  hp(r: w)'));
    }
  });

  it('version 5: the checker refuses it, on both engines', async () => {
    const source = shapes('Acme', '"x"')[1]![1];
    for (const engine of ['ts', 'rust'] as const) {
      resetRustRunStats();
      const outcome = await runOn(engine, source, 5);
      expect(outcome.error ?? '').toContain('MOV_CALL_ARG_MAYBE_RECORD');
      expect(outcome.writes).toEqual([]);
    }
  });
});
