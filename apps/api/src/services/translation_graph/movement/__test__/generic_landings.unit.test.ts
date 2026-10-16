// Construction-site landing types, host side + end to end (asks-as-adapter
// layer 5, chunk B).
//
// The generic mechanism is exercised abstractly in movement-lang's own
// `checker/__test__/generic_landing.unit.test.ts` (a synthetic polling
// adapter). THIS file is the second shape, and the real one: the REAL ask
// adapter (listEntryPoints + describe) through the REAL projection, the REAL
// program scan, the REAL host graft, and then the REAL checker over the grafted
// schema — so a break anywhere in that chain trips here, and nothing can pass by
// matching one hand-written fixture.
//
// movement-lang's own jest is broken locally, so the language layer runs through
// apps/api's ts-jest (per repo convention).

import {
  parseProgram,
  checkProgram,
  fromCatalogSnapshot,
  genericLandingKey,
  scanInstanceChains,
  type CatalogSnapshot,
  type InstanceSchema,
} from 'movement-lang';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { SchemaTypeDescriptor } from 'movement-engine/services/translation_graph/types';

import { AskAdapter } from '../../adapters/ask';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { graftGenericLandings } from '../generic_landings';

const PRELUDE = `import { questions } from adapters\nqa = connect questions\n`;

async function baseSchema(): Promise<{
  schema: InstanceSchema;
  entryPoints: { typeId: string; displayName: string; writable: boolean; readable: boolean }[];
}> {
  const adapter = new AskAdapter('team-1' as TeamId);
  const entries = await adapter.listEntryPoints();
  const descriptors = new Map<string, SchemaTypeDescriptor>();
  for (const e of entries) {
    const d = await adapter.describe(e.typeId);
    if (d) descriptors.set(e.typeId, d);
  }
  const { schema } = instanceSchemaFromDescriptors({
    adapterType: 'ask',
    entries,
    descriptors,
    supportsInPlaceUpdate: true,
  });
  return { schema, entryPoints: entries };
}

/** The whole pipeline for one program: scan its writes, graft what their
 *  literals fix, and hand the checker the grafted schema. */
async function grafted(body: string): Promise<InstanceSchema> {
  const { schema, entryPoints } = await baseSchema();
  const source = `${PRELUDE}\nfunction m() {\n${body}\n}`;
  return graftGenericLandings({
    instance: { adapterType: 'ask', schema, entryPoints },
    chains: scanInstanceChains(source),
  }).schema;
}

async function codesFor(body: string): Promise<string[]> {
  const schema = await grafted(body);
  // The snapshot carries the whole InstanceSchema, so the grafted positions and
  // their key table ride to the editor for free — exactly as refinements do.
  const snapshot: CatalogSnapshot = {
    adapters: { questions: { constructionArgs: [], schemas: { '': schema } } },
    credentials: {},
    plugins: {},
  };
  return checkProgram(
    parseProgram(`${PRELUDE}\nfunction m() {\n${body}\n}`),
    fromCatalogSnapshot(snapshot),
  )
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);
}

/** Every diagnostic with its severity — a degradation that is SUPPOSED to be
 *  heard is invisible to `codesFor`, which keeps errors only. */
async function allCodesFor(body: string): Promise<Array<{ code: string; severity: string }>> {
  const schema = await grafted(body);
  const snapshot: CatalogSnapshot = {
    adapters: { questions: { constructionArgs: [], schemas: { '': schema } } },
    credentials: {},
    plugins: {},
  };
  return checkProgram(
    parseProgram(`${PRELUDE}\nfunction m() {\n${body}\n}`),
    fromCatalogSnapshot(snapshot),
  ).map((d) => ({ code: d.code, severity: d.severity ?? 'error' }));
}

const CHOOSE = `  c = write qa-[:Choose]-> { Prompt: "Which round?", Options: ["Seed", "Series A"] }`;
const FORM = `  q = write qa-[:Form]-> { Prompt: "Deal details?", Fields: ["Budget", "Timeline"] }`;

describe('the host grafts the Response type an ask\'s own literals fix', () => {
  it('Choose over literal Options lands a CLOSED enum of exactly those options', async () => {
    const schema = await grafted(CHOOSE);
    const key = genericLandingKey({
      target: 'Choose Response',
      values: ['Seed', 'Series A'],
    });
    const name = schema.genericLandings?.[key];
    expect(name).toBe('Choose Response<Seed | Series A>');
    expect(schema.positions[name!]).toEqual({
      properties: { Answer: { kind: 'enum', options: ['Seed', 'Series A'] } },
      edges: {},
    });
    // The BASE type is untouched — an ask whose options we can't see still gets it.
    expect(schema.positions['Choose Response']).toEqual({
      properties: { Answer: 'text' },
      edges: {},
    });
  });

  it('Select keeps its cardinality, so the same override reads list<enum>', async () => {
    const schema = await grafted(
      `  s = write qa-[:Select]-> { Prompt: "Which?", Options: ["a", "b"] }`,
    );
    const name = schema.genericLandings?.[
      genericLandingKey({ target: 'Select Response', values: ['a', 'b'] })
    ];
    expect(schema.positions[name!]).toEqual({
      properties: { Answer: { kind: 'list', of: { kind: 'enum', options: ['a', 'b'] } } },
      edges: {},
    });
  });

  it('Provide maps its Answer Type literal onto the scalar it names', async () => {
    const cases: Array<[string, unknown]> = [
      ['text', 'text'],
      ['number', 'number'],
      ['date', 'date'],
      ['boolean', 'boolean'],
    ];
    for (const [declared, expected] of cases) {
      const schema = await grafted(
        `  p = write qa-[:Provide]-> { Prompt: "How much?", \`Answer Type\`: "${declared}" }`,
      );
      const name = schema.genericLandings?.[
        genericLandingKey({ target: 'Provide Response', values: [declared] })
      ];
      expect(name).toBe(`Provide Response<${declared}>`);
      expect(schema.positions[name!]).toEqual({ properties: { Answer: expected }, edges: {} });
    }
  });

  it('TWO asks with the same family and the same options share ONE position (the type IS its derivation)', async () => {
    const schema = await grafted(
      `${CHOOSE}\n  d = write qa-[:Choose]-> { Prompt: "And again?", Options: ["Seed", "Series A"] }`,
    );
    const names = Object.keys(schema.positions).filter((n) => n.startsWith('Choose Response<'));
    expect(names).toEqual(['Choose Response<Seed | Series A>']);
    expect(Object.keys(schema.genericLandings ?? {})).toHaveLength(1);
  });

  it('the option ORDER is part of the type — a reordered list is a different position', async () => {
    const schema = await grafted(
      `${CHOOSE}\n  d = write qa-[:Choose]-> { Prompt: "And again?", Options: ["Series A", "Seed"] }`,
    );
    expect(Object.keys(schema.positions).filter((n) => n.startsWith('Choose Response<')).sort()).toEqual([
      'Choose Response<Seed | Series A>',
      'Choose Response<Series A | Seed>',
    ]);
  });

  it('NON-literal Options graft nothing — dynamic options are legitimate, not an error', async () => {
    const schema = await grafted(
      `  o = "Seed"\n  c = write qa-[:Choose]-> { Prompt: "Which?", Options: [o] }`,
    );
    expect(schema.genericLandings).toBeUndefined();
    expect(Object.keys(schema.positions).filter((n) => n.includes('<'))).toEqual([]);
  });

  it('a typo\'d Answer Type grafts nothing — the enum field owns that diagnostic', async () => {
    const schema = await grafted(
      `  p = write qa-[:Provide]-> { Prompt: "How much?", \`Answer Type\`: "numbr" }`,
    );
    expect(schema.genericLandings).toBeUndefined();
  });

  it('Form over literal Fields lands one TEXT property per declared field, alongside the json Answer', async () => {
    const schema = await grafted(FORM);
    const name = schema.genericLandings?.[
      genericLandingKey({ target: 'Form Response', values: ['Budget', 'Timeline'] })
    ];
    expect(name).toBe('Form Response<Budget | Timeline>');
    expect(schema.positions[name!]).toEqual({
      properties: { Answer: 'json', Budget: 'text', Timeline: 'text' },
      edges: {},
    });
    // The BASE type is untouched — a form whose fields we can't see still gets it.
    expect(schema.positions['Form Response']).toEqual({ properties: { Answer: 'json' }, edges: {} });
  });

  it('NON-literal Fields graft nothing — the answer stays the opaque json object', async () => {
    const schema = await grafted(
      `  f = "Budget"\n  q = write qa-[:Form]-> { Prompt: "Details?", Fields: [f] }`,
    );
    expect(schema.genericLandings).toBeUndefined();
  });

  it('a family with nothing to be generic over is left alone', async () => {
    const schema = await grafted(`  k = write qa-[:Check]-> { Prompt: "Ship it?" }`);
    expect(schema.genericLandings).toBeUndefined();
  });
});

describe('the checker reads the graft back off the awaited Response', () => {
  it("a Choose ask's answer is its own options — a member is clean, a typo is the enum error", async () => {
    const AWAIT = `${CHOOSE}\n  r = await first(c-[:Response]->)`;
    expect(await codesFor(`${AWAIT}\n  if (r.Answer) { }`)).toEqual([]);
    expect(await codesFor(`${AWAIT}\n  if (r.Answer == "Seed") { }`)).not.toContain(
      'MOV_ENUM_UNKNOWN_VALUE',
    );
    expect(await codesFor(`${AWAIT}\n  if (r.Answer == "Sead") { }`)).toContain(
      'MOV_ENUM_UNKNOWN_VALUE',
    );
  });

  it('a Provide<number> answer really is a number (comparing it to text is the category error)', async () => {
    const AWAIT =
      '  p = write qa-[:Provide]-> { Prompt: "How much?", `Answer Type`: "number" }\n  r = await first(p-[:Response]->)';
    expect(await codesFor(`${AWAIT}\n  if (r.Answer) { }`)).toEqual([]);
    expect(await codesFor(`${AWAIT}\n  if (r.Answer == "a lot") { }`)).toContain(
      'MOV_COMPARE_TYPE_MISMATCH',
    );
  });

  it('a NON-LITERAL Answer Type is loud (the adapter refuses it at run time too)', async () => {
    const codes = await codesFor(
      '  t = "number"\n  p = write qa-[:Provide]-> { Prompt: "How much?", `Answer Type`: t }',
    );
    expect(codes).toContain('MOV_WRITE_GENERIC_NOT_LITERAL');
  });

  it("a Form's declared fields are read like any record's fields — backticked when spaced", async () => {
    const AWAIT = `${FORM}\n  r = await first(q-[:Response]->)`;
    expect(await codesFor(`${AWAIT}\n  if (r.Budget) { }`)).toEqual([]);
    expect(await codesFor(`${AWAIT}\n  if (r.Budget == "50k") { }`)).toEqual([]);
    // The opaque object stays readable for compat — one landing, both surfaces.
    // (Still json, so it is still opaque to a scalar test; what matters here is
    // that the name did not disappear when the typed fields arrived.)
    expect(await codesFor(`${AWAIT}\n  if (r.Answer) { }`)).not.toContain('MOV_UNKNOWN_PROPERTY');
    expect(await codesFor(`${AWAIT}\n  if (r.Deadline) { }`)).toContain('MOV_UNKNOWN_PROPERTY');
    const SPACED =
      '  q = write qa-[:Form]-> { Prompt: "Details?", Fields: ["Deal Size"] }\n  r = await first(q-[:Response]->)';
    expect(await codesFor(`${SPACED}\n  if (r.\`Deal Size\`) { }`)).toEqual([]);
  });

  it('NON-literal Fields leave the answer opaque json — the field names are still unknown here', async () => {
    const codes = await codesFor(
      `  f = "Budget"\n  q = write qa-[:Form]-> { Prompt: "Details?", Fields: [f] }\n  r = await first(q-[:Response]->)\n  if (r.Budget) { }`,
    );
    expect(codes).toContain('MOV_UNKNOWN_PROPERTY');
  });

  it('NON-literal Fields say so OUT LOUD — the write runs, but the typed answer was traded away', async () => {
    // Not an error (computed field names are a real thing to write) and not
    // silence either: `Options` degrading is a promise kept, `Fields` degrading
    // is a promise lost, and the two must not look the same.
    const all = await allCodesFor(
      `  f = "Budget"\n  q = write qa-[:Form]-> { Prompt: "Details?", Fields: [f] }`,
    );
    expect(all).toContainEqual({ code: 'MOV_WRITE_GENERIC_UNTYPED', severity: 'warning' });
    // …and the literal form says nothing, because nothing was lost.
    expect(await allCodesFor(FORM)).not.toContainEqual(
      expect.objectContaining({ code: 'MOV_WRITE_GENERIC_UNTYPED' }),
    );
    // Computed OPTIONS stay silent — the base text answer was the whole promise.
    expect(
      await allCodesFor(`  o = "Seed"\n  c = write qa-[:Choose]-> { Prompt: "Which?", Options: [o] }`),
    ).not.toContainEqual(expect.objectContaining({ code: 'MOV_WRITE_GENERIC_UNTYPED' }));
  });

  it('NON-LITERAL Options stay the base text answer, and say nothing about it', async () => {
    const codes = await codesFor(
      `  o = "Seed"\n  c = write qa-[:Choose]-> { Prompt: "Which?", Options: [o] }\n  r = await first(c-[:Response]->)\n  if (r.Answer == "anything") { }`,
    );
    expect(codes).not.toContain('MOV_ENUM_UNKNOWN_VALUE');
    expect(codes).not.toContain('MOV_WRITE_GENERIC_NOT_LITERAL');
  });
});

// ── The WRITE side (callback-primitive layer 3) ─────────────────────────────
//
// The Response edge is writable now, so the same landing the read walks is the
// landing the write body is checked against — one type, both directions. The
// enum did-you-mean an author used to meet at the read now meets them at the
// WRITE, which is where the mistake actually is.

describe('the checker holds a Response WRITE to the same landing', () => {
  it('the base per-family type checks a write body: a Check answers boolean, and text is the type error', async () => {
    const CHECK = '  k = write qa-[:Check]-> { Prompt: "Ship it?" }';
    expect(await codesFor(`${CHECK}\n  write k-[:Response]-> { Answer: true }`)).toEqual([]);
    expect(await codesFor(`${CHECK}\n  write k-[:Response]-> { Answer: "yes" }`)).toContain(
      'MOV_WRITE_FIELD_TYPE',
    );
  });

  it('a Choose over literal Options checks the WRITE against those exact options — the did-you-mean moves to the mistake', async () => {
    expect(await codesFor(`${CHOOSE}\n  write c-[:Response]-> { Answer: "Seed" }`)).toEqual([]);
    expect(await codesFor(`${CHOOSE}\n  write c-[:Response]-> { Answer: "Sead" }`)).toContain(
      'MOV_ENUM_UNKNOWN_VALUE',
    );
  });

  it('a Provide<number> write really must be a number', async () => {
    const PROVIDE =
      '  p = write qa-[:Provide]-> { Prompt: "How much?", `Answer Type`: "number" }';
    expect(await codesFor(`${PROVIDE}\n  write p-[:Response]-> { Answer: 42 }`)).toEqual([]);
    expect(await codesFor(`${PROVIDE}\n  write p-[:Response]-> { Answer: "a lot" }`)).toContain(
      'MOV_WRITE_FIELD_TYPE',
    );
  });

  it('a Draft answer is json — opaque, so any structured body goes through', async () => {
    const DRAFT = '  d = write qa-[:Draft]-> { Prompt: "Draft the memo" }';
    expect(await codesFor(`${DRAFT}\n  write d-[:Response]-> { Answer: { note: "x" } }`)).toEqual([]);
  });

  it('the answer is REQUIRED (except on a Review, whose answer is the acknowledgement)', async () => {
    expect(
      await codesFor('  k = write qa-[:Check]-> { Prompt: "Ship it?" }\n  write k-[:Response]-> { }'),
    ).toContain('MOV_WRITE_MISSING_REQUIRED_FIELD');
    expect(
      await codesFor('  v = write qa-[:Review]-> { Prompt: "Seen?" }\n  write v-[:Response]-> { }'),
    ).toEqual([]);
  });

  it('a field the Response does not have is the ordinary unknown-field error', async () => {
    expect(
      await codesFor(
        '  k = write qa-[:Check]-> { Prompt: "Ship it?" }\n  write k-[:Response]-> { Answer: TRUE, Nope: 1 }',
      ),
    ).toContain('MOV_WRITE_UNKNOWN_FIELD');
  });

  it("a Form is still answered through `Answer` — the per-field properties are READ-ONLY views on it", async () => {
    // The runtime stores ONE object (`coerceForm`), so `Answer` is the write
    // door and keeping it is what makes a literal-Fields form answerable at all.
    expect(await codesFor(`${FORM}\n  write q-[:Response]-> { Answer: { Budget: "50k", Timeline: "Q3" } }`)).toEqual([]);
    expect(await codesFor(`${FORM}\n  write q-[:Response]-> { Budget: "50k" }`)).toContain(
      'MOV_WRITE_UNKNOWN_FIELD',
    );
  });

  it('the specialized landing is registered as a WRITE shape, not a root — an answer is reached along its edge only', async () => {
    const schema = await grafted(`${CHOOSE}\n  write c-[:Response]-> { Answer: "Seed" }`);
    const name = 'Choose Response<Seed | Series A>';
    expect(schema.createShapes?.[name]).toMatchObject({
      fields: { Answer: { kind: 'enum', options: ['Seed', 'Series A'] } },
    });
    expect(schema.writableRoots[name]).toBeUndefined();
  });
});
