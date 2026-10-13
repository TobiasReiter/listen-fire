// EXISTS() over a traversal rooted at a RECORD HELD IN A NAME.
//
// A record held in a name is a position like any other: `top = FIRST(rows)`
// (a record on the value plane), a `match` result and a write handle all walk
// `top-[:notes]->` as a block head and as a read. `EXISTS(top-[:notes]->)` is
// that same walk asked "is there one?", so it walks through the same seam —
// production hit MOVENG_UNSUPPORTED here at RUN time ("traversing inside
// EXISTS() from the value binding 'company'"), with the save-time checks
// having said nothing.
//
// Pinned: true and false, with and without a hop WHERE, from each of the three
// ways a name comes to hold a record; plus COUNT / ONLY / IF over the same walk.

import type { InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type {
  Adapter,
  ExternalRecordRef,
  GetRelatedInput,
  RelatedResult,
  RuntimeCapabilities,
} from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { META_RECORD_TYPE, makeStablePosition, positionRecordId } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { createManualAdapter } from '../../translation_graph/adapters/manual';

const TEAM_ID = '00000000-0000-0000-0000-000000000021' as TeamId;
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: false, edgeProperties: false }, resources: false };
}

interface NodeRow {
  id: string;
  fields: Record<string, unknown>;
}

const COMPANIES: NodeRow[] = [
  { id: 'c-acme', fields: { name: 'Acme' } },
  { id: 'c-globex', fields: { name: 'Globex' } },
];
const NOTES: NodeRow[] = [
  { id: 'n-brief', fields: { text: 'Brief' } },
  { id: 'n-memo', fields: { text: 'Memo' } },
];

/** Acme carries two notes (a Brief and a Memo); Globex carries none. A write
 *  creates `new-<n>`; the first created record carries the Brief. */
const LINKS: Record<string, Array<{ recordType: string; recordId: string }>> = {
  'c-acme/notes': [
    { recordType: 'note', recordId: 'n-brief' },
    { recordType: 'note', recordId: 'n-memo' },
  ],
  'new-1/notes': [{ recordType: 'note', recordId: 'n-brief' }],
};

function makeGraph(candidates: ExternalRecordRef[] = []) {
  const byId = new Map<string, NodeRow>();
  for (const row of [...COMPANIES, ...NOTES]) byId.set(row.id, row);
  const created: Array<{ recordType: string; fields: Record<string, unknown> }> = [];
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
      return { candidates };
    },
    async getFieldValue({ position, fieldId }) {
      const id = positionRecordId(position);
      return (id !== undefined ? byId.get(id)?.fields[fieldId] : undefined) ?? null;
    },
    async getRelated(read: GetRelatedInput): Promise<RelatedResult[]> {
      if (read.position.recordType === META_RECORD_TYPE) {
        const rows = read.fieldId === 'company' ? COMPANIES : read.fieldId === 'note' ? NOTES : [];
        return rows.map((row) => ({
          position: makeStablePosition({ adapterType: KG, recordType: read.fieldId, recordId: row.id }),
        }));
      }
      const from = positionRecordId(read.position);
      return (from !== undefined ? LINKS[`${from}/${read.fieldId}`] ?? [] : []).map((t) => ({
        position: makeStablePosition({ adapterType: KG, recordType: t.recordType, recordId: t.recordId }),
      }));
    },
    async createRecord(write) {
      created.push({ recordType: write.recordType, fields: write.fields });
      return { adapterType: KG, externalId: `new-${created.length}`, data: {} };
    },
    async updateRecord(update) {
      return { adapterType: KG, externalId: update.externalId, data: {}, association: containerAssociation(update) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, created };
}

const kgSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text' },
      edges: { notes: { target: 'note', writable: true } },
    },
    note: { properties: { text: 'text' }, edges: {} },
  },
  collections: { company: { target: 'company' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-exists',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: new Date().toISOString() },
    occurredAt: new Date().toISOString(),
  };
}

/** Runs `body` and returns the `text` of every `answer` written — the
 *  movement's way of saying what it saw. */
async function answers(
  body: string,
  graph = makeGraph(),
  options: { live?: boolean } = {},
): Promise<unknown[]> {
  const source = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement probe(go: <runs-[:Invocation]->>) {
${body}
}
listen to runs {} fire probe
`;
  const writes: CapturedWrite[] = [];
  await runMovement({
    source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'manual') return manualAdapter;
      if (adapterType === KG) return graph.adapter;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
    // A write handle needs the record the graph really created (its id is what
    // the hop walks from), so those cases run live against the fake.
    dryRun: options.live !== true,
    writeSink: (w) => writes.push(w),
  });
  const written = options.live === true ? graph.created : writes;
  return written.filter((w) => w.recordType === 'note').map((w) => w.fields?.text);
}

/** The two gates every case asks: one walk, bare and narrowed. */
function gates(root: string): string {
  return [
    `  if EXISTS(${root}-[:notes]->) { write graph-[:note]-> { text: "any" } }`,
    `  if EXISTS(${root}-[n:notes WHERE \`text\` == "Brief"]->) { write graph-[:note]-> { text: "brief" } }`,
    `  if EXISTS(${root}-[n:notes WHERE \`text\` == "Nope"]->) { write graph-[:note]-> { text: "nope" } }`,
    `  if NOT EXISTS(${root}-[:notes]->) { write graph-[:note]-> { text: "none" } }`,
  ].join('\n');
}

describe('EXISTS() from a record FIRST put on the value plane', () => {
  const pick = (name: string) =>
    `  rows = graph-[c:company WHERE \`name\` == "${name}" ORDER BY \`name\`]->\n  top = FIRST(rows)\n`;

  it('answers true, with and without a WHERE, where the record has notes', async () => {
    expect(await answers(pick('Acme') + gates('top'))).toEqual(['any', 'brief']);
  });

  it('answers false where the record has none', async () => {
    expect(await answers(pick('Globex') + gates('top'))).toEqual(['none']);
  });

  it('COUNT, ONLY and IF read the same walk', async () => {
    const body =
      pick('Acme') +
      '  if COUNT(top-[:notes]->) == 2 { write graph-[:note]-> { text: "two" } }\n' +
      '  write graph-[:note]-> { text: COALESCE(ONLY(top-[n:notes WHERE `text` == "Memo"]->.`text`), "none") }\n' +
      '  shown = IF EXISTS(top-[:notes]->) THEN "has" ELSE "empty" END\n' +
      '  write graph-[:note]-> { text: shown }';
    expect(await answers(body)).toEqual(['two', 'Memo', 'has']);
  });
});

describe('EXISTS() from a record FIRST binds directly', () => {
  const pick = (name: string) =>
    `  top = FIRST(graph-[c:company WHERE \`name\` == "${name}" ORDER BY \`name\`]->)\n`;

  it('true and false, with and without a WHERE', async () => {
    expect(await answers(pick('Acme') + gates('top'))).toEqual(['any', 'brief']);
    expect(await answers(pick('Globex') + gates('top'))).toEqual(['none']);
  });
});

describe('EXISTS() from a match result', () => {
  const MATCH = '  co = match graph-[:company]-> { unique by (`name`), name: "Acme" }\n';
  const hit = (id: string, name: string): ExternalRecordRef => ({
    adapterType: KG,
    externalId: id,
    data: { name },
  });

  it('true, with and without a WHERE, where the matched record has notes', async () => {
    expect(await answers(MATCH + gates('co'), makeGraph([hit('c-acme', 'Acme')]))).toEqual([
      'any',
      'brief',
    ]);
  });

  it('false where it has none', async () => {
    expect(await answers(MATCH + gates('co'), makeGraph([hit('c-globex', 'Acme')]))).toEqual([
      'none',
    ]);
  });
});

describe('EXISTS() from a write handle', () => {
  it('true, with and without a WHERE, where the written record has notes', async () => {
    const body = '  co = write graph-[:company]-> { name: "Newco" }\n' + gates('co');
    expect(await answers(body, makeGraph(), { live: true })).toEqual(['any', 'brief']);
  });

  it('false where it has none', async () => {
    const body =
      '  first = write graph-[:company]-> { name: "Newco" }\n' +
      '  co = write graph-[:company]-> { name: "Otherco" }\n' +
      gates('co');
    expect(await answers(body, makeGraph(), { live: true })).toEqual(['none']);
  });
});

// A name holding MANY records walks as each of them — the reading a block head
// rooted at it already gives. Acme has two notes, Globex none.
describe('a walk from a name holding many records', () => {
  const reads = (root: string) =>
    [
      `  if COUNT(${root}-[:notes]->) == 2 { write graph-[:note]-> { text: "two" } }`,
      `  if EXISTS(${root}-[n:notes WHERE \`text\` == "Brief"]->) { write graph-[:note]-> { text: "brief" } }`,
      `  write graph-[:note]-> { text: JOIN(${root}-[n:notes WHERE \`text\` == "Memo" ORDER BY \`text\`]->.\`text\`, ",") }`,
    ].join('\n');

  it('a walk written as a value (a list of records)', async () => {
    const body = '  rows = graph-[c:company ORDER BY `name`]->\n' + reads('rows');
    expect(await answers(body)).toEqual(['two', 'brief', 'Memo']);
  });

  it("a block's returned records", async () => {
    const body = '  rows = graph-[c:company]-> { return c }\n' + reads('rows');
    expect(await answers(body)).toEqual(['two', 'brief', 'Memo']);
  });
});

// `!` is NOT. The formula tokenizer used to drop it, so `if !EXISTS(…)` ran as
// `if EXISTS(…)` — the arm fired exactly when it should not have.
describe('!EXISTS() runs inverted relative to EXISTS()', () => {
  const pick = (name: string) =>
    `  top = FIRST(graph-[c:company WHERE \`name\` == "${name}" ORDER BY \`name\`]->)\n`;
  const both = [
    '  if EXISTS(top-[:notes]->) { write graph-[:note]-> { text: "has" } }',
    '  if !EXISTS(top-[:notes]->) { write graph-[:note]-> { text: "none" } }',
    '  if !EXISTS(top-[n:notes WHERE `text` == "Nope"]->) { write graph-[:note]-> { text: "no nope" } }',
    '  if !!EXISTS(top-[:notes]->) { write graph-[:note]-> { text: "twice" } }',
  ].join('\n');

  it('a record with notes: EXISTS fires, !EXISTS does not', async () => {
    expect(await answers(pick('Acme') + both)).toEqual(['has', 'no nope', 'twice']);
  });

  it('a record with none: !EXISTS fires, EXISTS does not', async () => {
    expect(await answers(pick('Globex') + both)).toEqual(['none', 'no nope']);
  });

  it('as a value, IF !EXISTS(…) takes the other branch', async () => {
    const body = pick('Acme') + '  shown = IF !EXISTS(top-[:notes]->) THEN "empty" ELSE "has" END\n  write graph-[:note]-> { text: shown }';
    expect(await answers(body)).toEqual(['has']);
  });
});
