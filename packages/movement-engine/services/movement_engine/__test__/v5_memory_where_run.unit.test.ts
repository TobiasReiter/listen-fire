// A hop's alias read under language version 5 (`c.name` inside the hop's
// brackets) reads the landed record's field over an IN-MEMORY edge too: an
// extracted node's children (nested ones included), a run-built `node { … }`,
// a graph literal's entries and the landings a write leaves on a local node.
// Each program runs on the Rust engine; WHERE, ORDER BY and an alias read
// beside a variable of the same name are all covered. Versions 1–4 spelled these WHERE
// clauses with bare fields; version 5 has only the alias form.

import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type {
  ExtractCallLlmInput,
  ExtractCallLlmResult,
} from '../extraction_call';
import { containerAssociation } from '../../translation_graph/adapter';
import { positionData } from '../../translation_graph/types';
import { runMovement } from '../run';
import {
  resetRustRunStats,
  rustRunStats,
} from '../rust_stats';
import { credentialIdsFor, makeTestHost } from '../test_host';

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
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema,
    },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] } },
});

const event: TriggerEvent = {
  pipelineInputId: 'pi-memory-where',
  adapterType: 'email',
  triggerType: 'webhook',
  payload: {
    subject: 'Globex',
    text: 'Acme raised a seed and a series A; Globex and Initech did not',
  },
};

function fakeInbox(notes: unknown[]): Adapter {
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
    getFieldValue: async (input) => {
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null
        ? Reflect.get(data, input.fieldId)
        : undefined;
    },
    getRelated: async () => [],
    createRecord: async (input) => {
      notes.push(input.fields.body);
      return { adapterType: 'email', externalId: `n-${notes.length}`, data: { ...input.fields } };
    },
    updateRecord: async (input) => ({
      adapterType: 'email',
      externalId: input.externalId,
      data: {},
      association: containerAssociation(input),
    }),
    deleteRecord: async () => ({}),
  };
}

const cited = (value: unknown) => ({ value, evidence: { item: 0, quote: 'q' } });

/** What the model extracts: the one Deals record, three companies under it,
 *  Acme with two rounds. */
const EXTRACTED = {
  record: {
    company: [
      { name: cited('Initech'), rank: cited(3), round: [] },
      {
        name: cited('Acme'),
        rank: cited(1),
        round: [{ stage: cited('seed') }, { stage: cited('A') }],
      },
      { name: cited('Globex'), rank: cited(2), round: [{ stage: cited('B') }] },
    ],
  },
};

function extractingLlm(): { call(input: ExtractCallLlmInput): Promise<ExtractCallLlmResult> } {
  return {
    call: async () => ({
      parsedJson: EXTRACTED,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
  };
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
  '  deals = extractOne([msg.`text`], node Deals: "the deals the message describes" {',
  '    node company: "each company mentioned" {',
  '      name: <text> "the company\'s name"',
  '      rank: <number> "its rank, a number"',
  '      node round: "each funding round it raised" {',
  '        stage: <text> "the round\'s stage"',
  '      }',
  '    }',
  '  })',
];

/** The notes the program writes, on the engine its pin chooses (5 and later
 *  the Rust engine, the version-5 reference; 1–4 the TypeScript engine). */
async function runOn(source: string, languageVersion: LanguageVersion = 5): Promise<unknown[]> {
  const notes: unknown[] = [];
  await runMovement({
    source,
    languageVersion,
    event,
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    host: makeTestHost({
      adapters: { resolve: () => fakeInbox(notes) },
      llm: { extractCall: extractingLlm() },
    }),
    runId: `run-memory-where-${languageVersion}`,
    firedAt: '2026-10-16T09:00:00.000Z',
  });
  return notes;
}

/** The notes a version-5 body writes, the Rust run whole. */
async function notesOnRust(...body: string[]): Promise<unknown[]> {
  resetRustRunStats();
  const notes = await runOn(V5(...body));
  expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
  return notes;
}

describe("an extracted node's children: a hop's alias read is the child's field", () => {
  it('exists() over the extracted edge, true and false', async () => {
    expect(
      await notesOnRust(
        ...EXTRACT,
        '  if (deals != null) {',
        '    if (exists(deals-[c:company WHERE c.name == "Acme"]->)) {',
        '      write inbox-[:note]-> { body: "acme" }',
        '    }',
        '    if (exists(deals-[c:company WHERE c.name == "Hooli"]->)) {',
        '      write inbox-[:note]-> { body: "hooli" }',
        '    }',
        '  }',
      ),
    ).toEqual(['acme']);
  });

  it('a block head with WHERE and ORDER BY on alias reads', async () => {
    expect(
      await notesOnRust(
        ...EXTRACT,
        '  if (deals != null) {',
        '    deals-[c:company WHERE c.name != "Initech" ORDER BY c.rank]-> {',
        '      write inbox-[:note]-> { body: c.name }',
        '    }',
        '  }',
      ),
    ).toEqual(['Acme', 'Globex']);
  });

  it('the alias read is the field even beside a variable of the same name', async () => {
    expect(
      await notesOnRust(
        ...EXTRACT,
        '  name = msg.`subject`',
        '  if (deals != null) {',
        '    write inbox-[:note]-> { body: Text.join(deals-[c:company WHERE c.name != name ORDER BY c.name DESC]->.name, ",") }',
        '  }',
      ),
    ).toEqual(['Initech,Acme']);
  });

  it('a nested extracted edge: a round under its company', async () => {
    expect(
      await notesOnRust(
        ...EXTRACT,
        '  if (deals != null) {',
        '    deals-[c:company ORDER BY c.rank]-> {',
        '      c-[r:round WHERE r.stage != "seed" ORDER BY r.stage]-> {',
        '        write inbox-[:note]-> { body: "${c.name}:${r.stage}" }',
        '      }',
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
      await notesOnRust(
        ...BUILT,
        '  d-[p:people WHERE p.name != subject ORDER BY p.rank]-> {',
        '    write inbox-[:note]-> { body: p.name }',
        '  }',
      ),
    ).toEqual(['Ann', 'Cy']);
  });

  it('exists() and an expression hop', async () => {
    expect(
      await notesOnRust(
        ...BUILT,
        '  if (exists(d-[p:people WHERE p.rank > 2]->)) {',
        '    write inbox-[:note]-> { body: coalesce(only(d-[p:people WHERE p.rank > 2]->.name), "none") }',
        '  }',
      ),
    ).toEqual(['Cy']);
  });
});

describe("a graph literal's entries: a hop's alias read is the entry's field", () => {
  const LITERAL = [
    '  g = graph { title: "t", parts: [{ label: "two", n: 2 }, { label: "one", n: 1 }, { label: "three", n: 3 }] }',
  ];

  it('a block head with WHERE and ORDER BY', async () => {
    expect(
      await notesOnRust(
        ...LITERAL,
        '  g-[p:parts WHERE p.label != "three" ORDER BY p.n]-> {',
        '    write inbox-[:note]-> { body: p.label }',
        '  }',
      ),
    ).toEqual(['one', 'two']);
  });

  it('an expression hop and exists()', async () => {
    expect(
      await notesOnRust(
        ...LITERAL,
        '  if (exists(g-[p:parts WHERE p.n == 3]->)) {',
        '    write inbox-[:note]-> { body: Text.join(g-[p:parts WHERE p.n >= 2 ORDER BY p.n DESC]->.label, ",") }',
        '  }',
      ),
    ).toEqual(['three,two']);
  });

  it('ORDER BY with a LIMIT keeps the first records by the key', async () => {
    expect(
      await notesOnRust(
        ...LITERAL,
        '  g-[p:parts ORDER BY p.n DESC LIMIT 2]-> {',
        '    write inbox-[:note]-> { body: p.label }',
        '  }',
      ),
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
    expect(await runOn(source, 4)).toEqual(['two', 'three']);
  });
});

describe("a local node's landings: a hop's alias read is the landed record's field", () => {
  it('records written onto a local node, read back through WHERE and ORDER BY', async () => {
    expect(
      await notesOnRust(
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
