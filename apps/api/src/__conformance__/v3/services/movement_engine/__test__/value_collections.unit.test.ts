// Value collections through the REAL interpreter: dicts, the collection ops
// and MEMBERS, each proved by what reaches the adapter.
//
// The whole point is that these are ordinary values — a dict IS a JSON object,
// a MAP's answer IS an array — so nothing along the way may stringify or
// reshape them, and every proof here is a written field read back off the
// fake's `createRecord`.

import type { InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import type {
  Adapter,
  RuntimeCapabilities,
  GetRelatedInput,
  RelatedResult,
  WriteInput,
} from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import {
  META_RECORD_TYPE,
  makeStablePosition,
  positionRecordId,
} from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';

const TEAM_ID = '00000000-0000-0000-0000-000000000041' as TeamId;
const KG = 'kg';

const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: false, edgeProperties: false }, resources: false };
}

interface NodeRow {
  id: string;
  fields: Record<string, unknown>;
}

/** A KG fake holding a `finding` collection the movements read, and recording
 *  every note it is asked to create — the written value, verbatim. */
function makeKgFake(rows: NodeRow[]) {
  const creates: WriteInput[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const adapter: Adapter = {
    adapterType: KG,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const id = positionRecordId(position);
      return (id !== undefined ? byId.get(id)?.fields[fieldId] : undefined) ?? null;
    },
    async getRelated(read: GetRelatedInput): Promise<RelatedResult[]> {
      // Every finding's `similar` edge lands on the finding itself — enough for
      // a block to have somewhere to walk, and the landing is a record whose
      // identity a test can read back.
      if (read.position.recordType === 'finding' && read.fieldId === 'similar') {
        const id = positionRecordId(read.position);
        return id === undefined
          ? []
          : [{ position: makeStablePosition({ adapterType: KG, recordType: 'finding', recordId: id }) }];
      }
      if (read.position.recordType !== META_RECORD_TYPE || read.fieldId !== 'finding') return [];
      return rows.map((row) => ({
        position: makeStablePosition({ adapterType: KG, recordType: 'finding', recordId: row.id }),
      }));
    },
    async createRecord(write) {
      creates.push(write);
      return { adapterType: KG, externalId: `new-${write.recordType}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: KG, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const kgSchema: InstanceSchema = {
  positions: {
    finding: {
      properties: { headline: 'text', thesis: 'text', score: 'number' },
      edges: { similar: { target: 'finding', readable: true } },
    },
    note: { properties: { body: 'text', payload: 'json' }, edges: {} },
  },
  collections: { finding: { target: 'finding' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { body: 'text', payload: 'json' }, resultShape: { externalId: 'text' } },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-vc',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: new Date().toISOString() },
    occurredAt: new Date().toISOString(),
  };
}

const PRELUDE = `import { manual, kg } from adapters
import { kg_cred } from credentials
type Thesis = <"Consumer" | "Infra" | "Health">
runs = manual()
graph = kg(credentials: kg_cred)
`;

async function runBody(body: string, rows: NodeRow[]) {
  const kg = makeKgFake(rows);
  const source = `${PRELUDE}movement recap(go: <runs-[:Invocation]->>) {
${body}
}
listen to runs {} fire recap
`;
  await runMovement({
    source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'manual') return manualAdapter;
      if (adapterType === KG) return kg.adapter;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
    dryRun: false,
  });
  return kg.creates;
}

const ROWS: NodeRow[] = [
  { id: 'f-1', fields: { headline: 'Acme raised', thesis: 'Infra', score: 3 } },
  { id: 'f-2', fields: { headline: 'Globex hiring', thesis: 'Consumer', score: 5 } },
  { id: 'f-3', fields: { headline: 'Initech pivot', thesis: 'Infra', score: 2 } },
];

describe('a dict is a JSON object, and AT looks up a key', () => {
  it('the literal reaches a json field as itself — no stringifying on the way', async () => {
    const creates = await runBody(
      '  d = { one: "a", two: "b" }\n  write graph-[:note]-> { payload: d }',
      ROWS,
    );
    expect(creates.map((c) => c.fields.payload)).toEqual([{ one: 'a', two: 'b' }]);
  });

  it('AT reads the key, and a computed key that is not there reads nothing', async () => {
    const creates = await runBody(
      [
        '  d = { one: "hit" }',
        '  k = LOWER("NOPE")',
        '  write graph-[:note]-> { body ?: AT(d, "one"), payload: { missing: COALESCE(AT(d, k), "none") } }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.body).toBe('hit');
    expect(creates[0].fields.payload).toEqual({ missing: 'none' });
  });
});

describe('MAP / FILTER / REDUCE run the function once per member, in order', () => {
  it('MAP hands back what the function returned, member by member', async () => {
    const creates = await runBody(
      [
        '  lines = graph-[f:finding]-> { return f.`headline` }',
        '  loud = MAP(lines, (t) => { return "• ${t}" })',
        '  write graph-[:note]-> { payload: { items: loud } }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.payload).toEqual({
      items: ['• Acme raised', '• Globex hiring', '• Initech pivot'],
    });
  });

  it('MAP reads the pieces CHUNKS cut — they are a text collection like any other', async () => {
    // Proof the built-in's answer needs nothing in between: no COLLECT, no
    // guard, no reshaping. `size: 12` with no break inside the last character
    // of each piece means every cut falls at the ceiling.
    const creates = await runBody(
      [
        '  body = "aaaa bbbb cccc dddd eeee ffff gggg hhhh"',
        '  pieces = CHUNKS(body, { size: 12 })',
        '  lengths = MAP(pieces, (p) => { return LENGTH(p) })',
        '  write graph-[:note]-> { payload: { pieces: pieces, lengths: lengths } }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.payload).toEqual({
      pieces: ['aaaa bbbb cc', 'cc dddd eeee', ' ffff gggg h', 'hhh'],
      lengths: [12, 12, 12, 3],
    });
  });

  it('FILTER keeps the members the function answered TRUE for', async () => {
    const creates = await runBody(
      [
        '  scores = graph-[f:finding]-> { return f.`score` }',
        '  big = FILTER(scores, (n) => { return n > 2 })',
        '  write graph-[:note]-> { payload: { items: big } }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.payload).toEqual({ items: [3, 5] });
  });

  it('REDUCE carries the value forward, one member at a time', async () => {
    const creates = await runBody(
      [
        '  scores = graph-[f:finding ORDER BY `headline`]-> { return f.`score` }',
        '  total = REDUCE(scores, 0, (carried, n) => { return carried + n })',
        '  write graph-[:note]-> { body: "${total}" }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.body).toBe('10');
  });
});

// Small syntax (2026-09-28): a MAP closure with no `return` is legal, and a
// bare `MAP(...)` statement (no binding) is legal — the function runs for
// its own effects. Project A's recap relies on writes inside a MAP closure
// landing; this pins that they do even with no `return` at all.
describe('a bare MAP(...) statement, with no return, still runs its writes', () => {
  it('one write per member lands, in order — the answer (absent per slot) is never read', async () => {
    const creates = await runBody(
      '  MAP(graph-[f:finding]->, (t) => { write graph-[:note]-> { body: t.`headline` } })',
      ROWS,
    );
    expect(creates.map((c) => c.fields.body)).toEqual([
      'Acme raised',
      'Globex hiring',
      'Initech pivot',
    ]);
  });

  it('a bound MAP with no return also runs every write — the binding is absent per slot', async () => {
    const creates = await runBody(
      [
        '  results = MAP(graph-[f:finding]->, (t) => { write graph-[:note]-> { body: t.`headline` } })',
        '  write graph-[:note]-> { body: "count", payload: { n: LENGTH(results) } }',
      ].join('\n'),
      ROWS,
    );
    // Three notes from inside MAP, plus the summary note — proof each slot
    // still occupies its place in the list (LENGTH sees 3), even absent.
    expect(creates).toHaveLength(4);
    expect(creates[3].fields.payload).toEqual({ n: 3 });
  });
});

describe('GROUPBY and KEYBY file the members under a key', () => {
  it('GROUPBY collects each key’s members into a list, in the order they came', async () => {
    const creates = await runBody(
      [
        '  rows = graph-[f:finding]-> { return { thesis: f.`thesis`, headline: f.`headline` } }',
        '  by = GROUPBY(rows, (r) => { return COALESCE(AT(r, "thesis"), "?") })',
        '  write graph-[:note]-> { payload: by }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.payload).toEqual({
      Infra: [
        { thesis: 'Infra', headline: 'Acme raised' },
        { thesis: 'Infra', headline: 'Initech pivot' },
      ],
      Consumer: [{ thesis: 'Consumer', headline: 'Globex hiring' }],
    });
  });

  it('KEYBY fails the run on a repeated key, naming it — never a silent last-wins', async () => {
    await expect(
      runBody(
        [
          '  theses = graph-[f:finding]-> { return f.`thesis` }',
          '  by = KEYBY(theses, (t) => { return t })',
          '  write graph-[:note]-> { payload: by }',
        ].join('\n'),
        ROWS,
      ),
    ).rejects.toThrow(/'Infra' names more than one/);
  });

  it('KEYBY with distinct keys files each member under its own', async () => {
    const creates = await runBody(
      [
        '  heads = graph-[f:finding]-> { return f.`headline` }',
        '  by = KEYBY(heads, (t) => { return t })',
        '  write graph-[:note]-> { payload: by }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.payload).toEqual({
      'Acme raised': 'Acme raised',
      'Globex hiring': 'Globex hiring',
      'Initech pivot': 'Initech pivot',
    });
  });
});

describe('MEMBERS lists a declared type in declaration order', () => {
  it('the order is the declaration’s, not the data’s', async () => {
    const creates = await runBody(
      '  all = MEMBERS(<Thesis>)\n  write graph-[:note]-> { payload: { items: all } }',
      ROWS,
    );
    expect(creates[0].fields.payload).toEqual({ items: ['Consumer', 'Infra', 'Health'] });
  });

  it('the recap shape composes: group the findings, then walk the type', async () => {
    // The few lines that replace a hand-enumerated section per thesis: rows
    // shaped as dicts → GROUPBY by the refinement → MEMBERS in declared order
    // → AT the dict per member. A thesis with no findings is an ordinary
    // absent lookup, discharged with COALESCE.
    const creates = await runBody(
      [
        '  rows = graph-[f:finding]-> { return { thesis: f.`thesis`, headline: f.`headline` } }',
        '  by = GROUPBY(rows, (r) => { return COALESCE(AT(r, "thesis"), "?") })',
        '  theses = MEMBERS(<Thesis>)',
        '  sections = MAP(theses, (th) => { return "${th}: ${COUNT(COALESCE(AT(by, th), []))}" })',
        '  write graph-[:note]-> { payload: { items: sections } }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.payload).toEqual({ items: ['Consumer: 1', 'Infra: 2', 'Health: 0'] });
  });
});

// `SORT` is the ordering primitive for a collection already in hand: the same
// members, in the order its key puts them, and an order-sensitive fold over the
// answer needs no further ceremony.
describe('SORT orders a collection already in hand', () => {
  it('plain values sort by themselves, ascending by default and descending on request', async () => {
    const creates = await runBody(
      [
        '  scores = graph-[f:finding]-> { return f.`score` }',
        '  up = SORT(scores)',
        '  down = SORT(scores, DESC)',
        '  write graph-[:note]-> { payload: { up: up, down: down } }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.payload).toEqual({ up: [2, 3, 5], down: [5, 3, 2] });
  });

  it('JOIN reads the sorted sequence — the same collection unsorted has no first', async () => {
    const creates = await runBody(
      [
        '  names = graph-[f:finding]-> { return f.`headline` }',
        '  write graph-[:note]-> { body: JOIN(SORT(names), ", ") }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.body).toBe('Acme raised, Globex hiring, Initech pivot');
  });

  it('FIRST, LAST and AT read positions in the order SORT put them', async () => {
    const creates = await runBody(
      [
        '  scores = graph-[f:finding]-> { return f.`score` }',
        '  ranked = SORT(scores, DESC)',
        '  write graph-[:note]-> { body: "${FIRST(ranked)}/${LAST(ranked)}/${AT(ranked, 1)}" }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.body).toBe('5/2/3');
  });

  it('a key reads each member — rows built in the body sort by one of their fields', async () => {
    const creates = await runBody(
      [
        '  rows = graph-[f:finding]-> { return { headline: f.`headline`, score: f.`score` } }',
        '  ranked = SORT(rows, `score`, DESC)',
        '  write graph-[:note]-> { payload: { items: ranked } }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.payload).toEqual({
      items: [
        { headline: 'Globex hiring', score: 5 },
        { headline: 'Acme raised', score: 3 },
        { headline: 'Initech pivot', score: 2 },
      ],
    });
  });
});

describe('a record is a value, so a collection can hold one', () => {
  // One type universe, proved by what reaches the adapter. A hop written as a
  // value is its landings; a collection op hands each answer back in the
  // currency it arrived in; and the records that come out the other end are
  // the records that went in — walkable, readable, comparable by identity.

  it('MAP returning the member hands back the records themselves', async () => {
    const creates = await runBody(
      [
        '  rows = MAP(graph-[f:finding]->, (t) => { return t })',
        '  rows-[s:similar]-> {',
        '    write graph-[:note]-> { body: s.`headline` }',
        '  }',
      ].join('\n'),
      ROWS,
    );
    expect(creates.map((c) => c.fields.body)).toEqual([
      'Acme raised',
      'Globex hiring',
      'Initech pivot',
    ]);
  });

  it('MAP returning a map literal hands back maps, and the key keeps its value', async () => {
    const creates = await runBody(
      [
        '  rows = MAP(graph-[f:finding]->, (t) => { return { headline: t.`headline` } })',
        '  write graph-[:note]-> { payload: { rows: rows } }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.payload).toEqual({
      rows: [
        { headline: 'Acme raised' },
        { headline: 'Globex hiring' },
        { headline: 'Initech pivot' },
      ],
    });
  });

  it('MAP returning a map whose key holds a record keeps the record walkable', async () => {
    const creates = await runBody(
      [
        '  rows = MAP(graph-[f:finding ORDER BY `headline`]->, (t) => { return { it: t } })',
        '  first = AT(rows, 0)',
        '  one = AT(first, "it")',
        '  one-[s:similar]-> {',
        '    write graph-[:note]-> { body: s.`headline` }',
        '  }',
      ].join('\n'),
      ROWS,
    );
    expect(creates.map((c) => c.fields.body)).toEqual(['Acme raised']);
  });

  it('FILTER keeps the records that answered, and a block walks them', async () => {
    const creates = await runBody(
      [
        '  loud = FILTER(graph-[f:finding]->, (t) => { return t.`score` > 2 })',
        '  loud-[s:similar]-> {',
        '    write graph-[:note]-> { body: s.`headline` }',
        '  }',
      ].join('\n'),
      ROWS,
    );
    expect(creates.map((c) => c.fields.body)).toEqual(['Acme raised', 'Globex hiring']);
  });

  it('GROUPBY files records under each key, and a block walks one group', async () => {
    const creates = await runBody(
      [
        '  byThesis = GROUPBY(graph-[f:finding]->, (t) => { return t.`thesis` })',
        '  infra = AT(byThesis, "Infra")',
        '  infra-[s:similar]-> {',
        '    write graph-[:note]-> { body: s.`headline` }',
        '  }',
      ].join('\n'),
      ROWS,
    );
    expect(creates.map((c) => c.fields.body)).toEqual(['Acme raised', 'Initech pivot']);
  });

  it('KEYBY files one record under each key', async () => {
    const creates = await runBody(
      [
        '  byHeadline = KEYBY(graph-[f:finding]->, (t) => { return t.`headline` })',
        '  one = AT(byHeadline, "Globex hiring")',
        '  one-[s:similar]-> {',
        '    write graph-[:note]-> { body: s.`headline` }',
        '  }',
      ].join('\n'),
      ROWS,
    );
    expect(creates.map((c) => c.fields.body)).toEqual(['Globex hiring']);
  });

  it('the same record reached two ways is one record; a different one is not', async () => {
    const creates = await runBody(
      [
        '  rows = MAP(graph-[f:finding ORDER BY `headline`]->, (t) => { return t })',
        '  again = FILTER(rows, (t) => { return t.`score` > 0 })',
        '  a = AT(rows, 0)',
        '  b = AT(again, 0)',
        '  other = AT(rows, 1)',
        '  write graph-[:note]-> { payload: { same: a == b, different: a == other } }',
      ].join('\n'),
      ROWS,
    );
    expect(creates[0].fields.payload).toEqual({ same: true, different: false });
  });
});

// …and a block over records whose `return` the checker cannot type is still a
// collection of VALUES. A saved automation is re-checked on every run, so
// typing that unknown as the record the block walks refused the whole run
// (MOVENG_CHECK: MOV_RECORD_NOT_A_VALUE) on a program that had not changed.
describe("a block's untyped return is a value, not the record it walked", () => {
  it('an untyped call per iteration collects values the run can join', async () => {
    const creates = await runBody(
      [
        '  lines = graph-[f:finding ORDER BY `headline`]-> {',
        '    return COALESCE(f.`headline`, "")',
        '  }',
        '  write graph-[:note]-> { body: JOIN(lines, " | ") }',
      ].join('\n'),
      ROWS,
    );
    expect(creates.map((c) => c.fields.body)).toEqual([
      'Acme raised | Globex hiring | Initech pivot',
    ]);
  });
});
