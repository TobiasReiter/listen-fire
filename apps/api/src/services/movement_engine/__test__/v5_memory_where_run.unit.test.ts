// A hop's alias read under language version 5 (`c.name` inside the hop's
// brackets) reads the landed record's field over an IN-MEMORY edge too: an
// extracted node's children (nested ones included), a run-built `node { … }`,
// a graph literal's entries and the landings a write leaves on a local node.
// Each program runs on both engines (the TypeScript reference, forced, and
// Rust) and writes the same notes; WHERE, ORDER BY and an alias read beside a
// variable of the same name are all covered. Versions 1–4 spelled these WHERE
// clauses with bare fields; version 5 has only the alias form.

import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { LlmCallInput, LlmCallResult } from 'movement-engine/services/translation_graph/engine/batched_extraction/llm_call';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { positionData } from 'movement-engine/services/translation_graph/types';
import { runMovement } from 'movement-engine/services/movement_engine/run';
import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';
import { credentialIdsFor, makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000f6');

const schema: InstanceSchema = {
  positions: {
    message: { properties: { subject: 'text', text: 'text' }, edges: {} },
    note: { properties: { body: 'text' }, edges: {} },
  },
  collections: { note: { target: 'note' } },
  writableRoots: { note: { fields: { body: 'text' }, resultShape: { body: 'text' }, edges: {} } },
};

const catalog = mockCatalogSnapshot({
  adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema } },
  credentials: { dealflow_inbox: { adapters: ['email'] } },
});

const event: TriggerEvent = {
  pipelineInputId: 'pi-memory-where',
  adapterType: 'email',
  triggerType: 'webhook',
  payload: { subject: 'Globex', text: 'Acme raised a seed and a series A; Globex and Initech did not' },
};

function fakeInbox(notes: unknown[]): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async (input) => {
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, input.fieldId) : undefined;
    },
    getRelated: async () => [],
    createRecord: async (input) => {
      notes.push(input.fields.body);
      return { adapterType: 'email', externalId: `n-${notes.length}`, data: { ...input.fields } };
    },
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

const cited = (value: unknown) => ({ evidence: 'q', value });

/** What the model extracts: three companies, Acme with two rounds. */
const EXTRACTED = {
  'x:extract_result#1': [
    {
      company: [
        { name: cited('Initech'), rank: cited(3), round: [] },
        { name: cited('Acme'), rank: cited(1), round: [{ stage: cited('seed') }, { stage: cited('A') }] },
        { name: cited('Globex'), rank: cited(2), round: [{ stage: cited('B') }] },
      ],
    },
  ],
};

function extractingLlm(): { call(input: LlmCallInput): Promise<LlmCallResult> } {
  return { call: async () => ({ parsedJson: EXTRACTED }) };
}

const V5 = (...body: string[]) =>
  [
    'import { `@lf/email` as mail } from adapters',
    'import { dealflow_inbox } from credentials',
    'inbox = connect mail using dealflow_inbox',
    'node Batch {',
    '  node companies {',
    '    name: <text>',
    '    rank: <number>',
    '  }',
    '}',
    'function m(msg: <inbox-[:message]->>) {',
    '  subject = msg.`subject`',
    ...body,
    '}',
  ].join('\n');

const EXTRACT = [
  '  deals = extract from [msg.`text`] {',
  '    node company: "each company mentioned" {',
  '      name: "the company\'s name"',
  '      rank: "its rank, a number"',
  '      node round: "each funding round it raised" {',
  '        stage: "the round\'s stage"',
  '      }',
  '    }',
  '  }',
];

async function runOn(engine: 'ts' | 'rust', source: string, languageVersion: LanguageVersion = 5): Promise<unknown[]> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const notes: unknown[] = [];
  try {
    await runMovement({
      source,
      languageVersion,
      event,
      teamId: TEAM_ID,
      catalog,
      credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
      host: makeTestHost({ adapters: { resolve: () => fakeInbox(notes) }, llm: { client: extractingLlm() } }),
      runId: `run-memory-where-${engine}`,
      firedAt: '2026-10-16T09:00:00.000Z',
    });
    return notes;
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

/** The notes the program writes, the same on both engines, the Rust run whole. */
async function notesOnBoth(...body: string[]): Promise<unknown[]> {
  const source = V5(...body);
  const ts = await runOn('ts', source);
  resetRustRunStats();
  const rust = await runOn('rust', source);
  expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, notAdmitted: {}, declined: {} });
  expect(rust).toEqual(ts);
  return ts;
}

describe("an extracted node's children: a hop's alias read is the child's field", () => {
  it('exists() over the extracted edge, true and false', async () => {
    expect(
      await notesOnBoth(
        ...EXTRACT,
        '  if (exists(deals-[c:company WHERE c.name == "Acme"]->)) {',
        '    write inbox-[:note]-> { body: "acme" }',
        '  }',
        '  if (exists(deals-[c:company WHERE c.name == "Hooli"]->)) {',
        '    write inbox-[:note]-> { body: "hooli" }',
        '  }',
      ),
    ).toEqual(['acme']);
  });

  it('a block head with WHERE and ORDER BY on alias reads', async () => {
    expect(
      await notesOnBoth(
        ...EXTRACT,
        '  deals-[c:company WHERE c.name != "Initech" ORDER BY c.rank]-> {',
        '    write inbox-[:note]-> { body: c.name }',
        '  }',
      ),
    ).toEqual(['Acme', 'Globex']);
  });

  it('the alias read is the field even beside a variable of the same name', async () => {
    expect(
      await notesOnBoth(
        ...EXTRACT,
        '  name = msg.`subject`',
        '  write inbox-[:note]-> { body: Text.join(deals-[c:company WHERE c.name != name ORDER BY c.name DESC]->.name, ",") }',
      ),
    ).toEqual(['Initech,Acme']);
  });

  it('a nested extracted edge: a round under its company', async () => {
    expect(
      await notesOnBoth(
        ...EXTRACT,
        '  deals-[c:company ORDER BY c.rank]-> {',
        '    c-[r:round WHERE r.stage != "seed" ORDER BY r.stage]-> {',
        '      write inbox-[:note]-> { body: "${c.name}:${r.stage}" }',
        '    }',
        '  }',
      ),
    ).toEqual(['Acme:A', 'Globex:B']);
  });
});

describe("a run-built node's children: a hop's alias read is the child's field", () => {
  const BUILT = [
    '  d = node {',
    '    title: "batch",',
    '    people: [node { name: "Cy", rank: 3 }, node { name: "Ann", rank: 1 }, node { name: "Globex", rank: 2 }]',
    '  }',
  ];

  it('a block head with WHERE and ORDER BY', async () => {
    expect(
      await notesOnBoth(...BUILT, '  d-[p:people WHERE p.name != subject ORDER BY p.rank]-> {', '    write inbox-[:note]-> { body: p.name }', '  }'),
    ).toEqual(['Ann', 'Cy']);
  });

  it('exists() and an expression hop', async () => {
    expect(
      await notesOnBoth(
        ...BUILT,
        '  if (exists(d-[p:people WHERE p.rank > 2]->)) {',
        '    write inbox-[:note]-> { body: coalesce(only(d-[p:people WHERE p.rank > 2]->.name), "none") }',
        '  }',
      ),
    ).toEqual(['Cy']);
  });
});

describe("a graph literal's entries: a hop's alias read is the entry's field", () => {
  const LITERAL = ['  g = graph { title: "t", parts: [{ label: "two", n: 2 }, { label: "one", n: 1 }, { label: "three", n: 3 }] }'];

  it('a block head with WHERE and ORDER BY', async () => {
    expect(
      await notesOnBoth(...LITERAL, '  g-[p:parts WHERE p.label != "three" ORDER BY p.n]-> {', '    write inbox-[:note]-> { body: p.label }', '  }'),
    ).toEqual(['one', 'two']);
  });

  it('an expression hop and exists()', async () => {
    expect(
      await notesOnBoth(
        ...LITERAL,
        '  if (exists(g-[p:parts WHERE p.n == 3]->)) {',
        '    write inbox-[:note]-> { body: Text.join(g-[p:parts WHERE p.n >= 2 ORDER BY p.n DESC]->.label, ",") }',
        '  }',
      ),
    ).toEqual(['three,two']);
  });

  it('ORDER BY with a LIMIT keeps the first records by the key', async () => {
    expect(
      await notesOnBoth(...LITERAL, '  g-[p:parts ORDER BY p.n DESC LIMIT 2]-> {', '    write inbox-[:note]-> { body: p.label }', '  }'),
    ).toEqual(['three', 'two']);
  });

  // Versions 1–4 never read an in-memory hop's ORDER BY or LIMIT; a program
  // pinned there keeps the literal's own order.
  it('under 4 the same hop keeps the literal order, as it always has', async () => {
    const source = [
      'import { email } from adapters',
      'import { dealflow_inbox } from credentials',
      'inbox = email(credentials: dealflow_inbox)',
      'movement m(msg: <inbox-[:message]->>) {',
      '  g = graph { title: "t", parts: [{ label: "two", n: 2 }, { label: "one", n: 1 }, { label: "three", n: 3 }] }',
      '  g-[p:parts WHERE p.label != "one" ORDER BY p.n DESC LIMIT 1]-> {',
      '    write inbox-[:note]-> { body: p.label }',
      '  }',
      '}',
    ].join('\n');
    expect(await runOn('ts', source, 4)).toEqual(['two', 'three']);
  });
});

describe("a local node's landings: a hop's alias read is the landed record's field", () => {
  it('records written onto a local node, read back through WHERE and ORDER BY', async () => {
    expect(
      await notesOnBoth(
        '  deduped = graph<Batch> {}',
        '  write deduped-[:companies]-> { name: "Initech", rank: 3 }',
        '  write deduped-[:companies]-> { name: "Globex", rank: 2 }',
        '  write deduped-[:companies]-> { name: "Acme", rank: 1 }',
        '  deduped-[c:companies WHERE c.name != subject ORDER BY c.rank]-> {',
        '    write inbox-[:note]-> { body: c.name }',
        '  }',
        '  if (exists(deduped-[c:companies WHERE c.rank == 2]->)) {',
        '    write inbox-[:note]-> { body: "two" }',
        '  }',
      ),
    ).toEqual(['Acme', 'Initech', 'two']);
  });
});
