// Graph-rooted query traversals — the kg-by-traversal generalisation that
// retires KG_EXISTS/KG_VALUE, plus bracket ORDER BY / LIMIT semantics (the
// engine sorts and slices per origin position, over whatever the adapter
// returned). Verified through the REAL interpreter with fake adapters:
//
//   1. kg-rooted EXPRESSION reads (`graph-[c:company WHERE …]->.`name``)
//      stream the collection through the KG adapter's meta root
//   2. kg-rooted BLOCK heads run the body per matching node
//   3. EXISTS over a kg root works in conditions
//   4. ORDER BY DESC + LIMIT applies after WHERE, sorts post-stream,
//      slices to n, and sorts empty keys last
//   5. instance-rooted expression reads honour ORDER/LIMIT identically
//      (the same walk serves every graph root)
//   6. every walker hands the adapter the SAME fetch — a block head, an
//      expression and an EXISTS all push the hop's WHERE, ORDER BY and LIMIT
//      (plans/ordering-primitives-2026-09-04/1_decisions.md D1)

import type { InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type {
  Adapter,
  RuntimeCapabilities,
  GetRelatedInput,
  RelatedResult,
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

const TEAM_ID = '00000000-0000-0000-0000-000000000020' as TeamId;
const KG = 'kg';

const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: false, edgeProperties: false },
    resources: false,
  };
}

interface NodeRow {
  id: string;
  fields: Record<string, unknown>;
}

/** A read-only graph fake: a meta-root collection scan per type plus
 *  per-node field reads — the KG (and any instance) read surface the
 *  query traversals use. Records the fieldIds the scans used, and the whole
 *  `GetRelatedInput` each one arrived with (the fake honours NONE of the
 *  pushdown — it answers with the full collection, which is exactly what an
 *  adapter that can't narrow does, so the engine's own filter/sort/slice is
 *  what the answers prove). */
function makeGraphFake(input: {
  adapterType: string;
  collections: Record<string, NodeRow[]>;
  /** Record-to-record references, keyed `<fromId>/<fieldId>` — what a hop off
   *  a RECORD (rather than the meta root) walks. */
  links?: Record<string, Array<{ recordType: string; recordId: string }>>;
  writable?: boolean;
}) {
  const scans: string[] = [];
  const reads: GetRelatedInput[] = [];
  const writes: Array<{ recordType: string; fields: Record<string, unknown> }> = [];
  const byId = new Map<string, NodeRow>();
  for (const rows of Object.values(input.collections)) {
    for (const row of rows) byId.set(row.id, row);
  }
  const adapter: Adapter = {
    adapterType: input.adapterType,
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
      reads.push(read);
      if (read.position.recordType !== META_RECORD_TYPE) {
        const from = positionRecordId(read.position);
        const linked = from !== undefined ? input.links?.[`${from}/${read.fieldId}`] ?? [] : [];
        return linked.map((target) => ({
          position: makeStablePosition({
            adapterType: input.adapterType,
            recordType: target.recordType,
            recordId: target.recordId,
          }),
        }));
      }
      scans.push(read.fieldId);
      return (input.collections[read.fieldId] ?? []).map((row) => ({
        position: makeStablePosition({
          adapterType: input.adapterType,
          recordType: read.fieldId,
          recordId: row.id,
        }),
      }));
    },
    async createRecord(write) {
      writes.push({ recordType: write.recordType, fields: write.fields });
      return { adapterType: input.adapterType, externalId: `new-${writes.length}`, data: {} };
    },
    async updateRecord(update) {
      return { adapterType: input.adapterType, externalId: update.externalId, data: {}, association: containerAssociation(update) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, scans, reads, writes };
}

const kgSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', stage: 'text', revenue: 'number' },
      // A writable child, so a write can be parented at a SELECTED company.
      // `owner` is the reference an ordering key walks (D3).
      edges: { notes: { target: 'note', writable: true }, owner: { target: 'person' } },
    },
    note: { properties: { text: 'text' }, edges: {} },
    person: { properties: { name: 'text', joined: 'date' }, edges: {} },
  },
  // kg collections ARE its node types (the meta-root scan surface).
  collections: { company: { target: 'company' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
    company: {
      fields: { name: 'text' },
      resultShape: { externalId: 'text', name: 'text' },
    },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { acme_main: { adapters: ['attio'] }, kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

const COMPANIES: NodeRow[] = [
  { id: 'n-1', fields: { name: 'Acme', stage: 'Seed', revenue: 10 } },
  { id: 'n-2', fields: { name: 'Globex', stage: 'Seed', revenue: 30 } },
  { id: 'n-3', fields: { name: 'Initech', stage: 'Late', revenue: 50 } },
  { id: 'n-4', fields: { name: 'Hooli', stage: 'Seed', revenue: null } },
  { id: 'n-5', fields: { name: 'Umbrella', stage: 'Seed', revenue: 20 } },
];

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-q',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: new Date().toISOString() },
    occurredAt: new Date().toISOString(),
  };
}

function makeResolver(byType: Record<string, Adapter>) {
  return ({ adapterType }: { adapterType: string }) => {
    const adapter = byType[adapterType];
    if (!adapter) throw new Error(`test: no fake adapter for '${adapterType}'`);
    return adapter;
  };
}

async function run(source: string, kg: ReturnType<typeof makeGraphFake>) {
  const writes: CapturedWrite[] = [];
  const result = await runMovement({
    source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: makeResolver({ manual: manualAdapter, [KG]: kg.adapter }),
    dryRun: true,
    writeSink: (w) => writes.push(w),
  });
  return { result, writes };
}

describe('kg-rooted query traversals (KG_EXISTS/KG_VALUE retired by generalisation)', () => {
  it('a kg expression read filters, orders DESC, limits, and reads the field', async () => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    const source = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement report(go: <runs-[:Invocation]->>) {
  write graph-[:note]-> {
    text: "Top: \${JOIN(graph-[c:company WHERE \`stage\` == "Seed" ORDER BY \`revenue\` DESC LIMIT 2]->.\`name\`, ", ")}"
  }
}
listen to runs {} fire report
`;
    const { writes } = await run(source, kg);
    // Seed companies by revenue desc: Globex(30), Umbrella(20), Acme(10),
    // Hooli(null — empty keys last); LIMIT 2 keeps the top two.
    expect(writes).toEqual([
      expect.objectContaining({
        recordType: 'note',
        fields: { text: 'Top: Globex, Umbrella' },
      }),
    ]);
    expect(kg.scans).toEqual(['company']);
  });

  it('a kg-rooted block head runs the body once per matching node', async () => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    const source = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement sweep(go: <runs-[:Invocation]->>) {
  graph-[c:company WHERE \`stage\` == "Seed" ORDER BY \`name\`]-> {
    write graph-[:note]-> { text: c.\`name\` }
  }
}
listen to runs {} fire sweep
`;
    const { writes } = await run(source, kg);
    expect(writes.map((w) => w.fields?.text)).toEqual(['Acme', 'Globex', 'Hooli', 'Umbrella']);
  });

  it('EXISTS over a kg root works in a condition', async () => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    const source = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement gate(go: <runs-[:Invocation]->>) {
  if EXISTS(graph-[c:company WHERE \`name\` == "Initech"]->) {
    write graph-[:note]-> { text: "found" }
  }
  if EXISTS(graph-[c:company WHERE \`name\` == "Wonka"]->) {
    write graph-[:note]-> { text: "ghost" }
  }
}
listen to runs {} fire gate
`;
    const { writes } = await run(source, kg);
    expect(writes.map((w) => w.fields?.text)).toEqual(['found']);
  });

  it('LIMIT bounds which positions a kg block iterates, ordered by the bracket', async () => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    const source = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement first_two(go: <runs-[:Invocation]->>) {
  graph-[c:company ORDER BY \`name\` LIMIT 2]-> {
    write graph-[:note]-> { text: c.\`name\` }
  }
}
listen to runs {} fire first_two
`;
    const { writes } = await run(source, kg);
    expect(writes.map((w) => w.fields?.text)).toEqual(['Acme', 'Globex']);
  });
});

// One hop fetch: the syntax promises the same records at the head of a block,
// inside an expression and inside EXISTS, so the engine asks the adapter for
// them identically. (plans/ordering-primitives-2026-09-04/1_decisions.md D1 —
// the block head used to push only the WHERE, and EXISTS pushed nothing.)
describe('a hop hands the adapter the same fetch wherever the bracket is written', () => {
  const BRACKET = 'company WHERE `stage` == "Seed" ORDER BY `revenue` DESC LIMIT 2';

  /** What the adapter was asked for, for the one `company` scan the movement makes. */
  async function pushdown(body: string) {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    const source = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement probe(go: <runs-[:Invocation]->>) {
${body}
}
listen to runs {} fire probe
`;
    await run(source, kg);
    const reads = kg.reads.filter((r) => r.fieldId === 'company');
    expect(reads).toHaveLength(1);
    const { where, orderBy, limit } = reads[0];
    return { hasWhere: where !== undefined, orderBy, limit };
  }

  it('a block head pushes the WHERE, the ORDER BY and the LIMIT', async () => {
    expect(
      await pushdown(`  graph-[c:${BRACKET}]-> {\n    write graph-[:note]-> { text: c.\`name\` }\n  }`),
    ).toEqual({ hasWhere: true, orderBy: { fieldId: 'revenue', direction: 'desc' }, limit: 2 });
  });

  it('an expression hop pushes exactly the same thing', async () => {
    expect(
      await pushdown(
        `  write graph-[:note]-> { text: "\${JOIN(graph-[c:${BRACKET}]->.\`name\`, ", ")}" }`,
      ),
    ).toEqual({ hasWhere: true, orderBy: { fieldId: 'revenue', direction: 'desc' }, limit: 2 });
  });

  it('an EXISTS hop pushes its WHERE too', async () => {
    expect(
      await pushdown(
        `  if EXISTS(graph-[c:${BRACKET}]->) {\n    write graph-[:note]-> { text: "yes" }\n  }`,
      ),
    ).toEqual({ hasWhere: true, orderBy: { fieldId: 'revenue', direction: 'desc' }, limit: 2 });
  });

  it('the answers are unchanged — the fake honours none of the pushdown', async () => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    const source = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement probe(go: <runs-[:Invocation]->>) {
  graph-[c:${BRACKET}]-> {
    write graph-[:note]-> { text: c.\`name\` }
  }
}
listen to runs {} fire probe
`;
    const { writes } = await run(source, kg);
    // Seed companies by revenue desc: Globex(30), Umbrella(20) — the engine's
    // own sort and slice over the full collection the fake returned.
    expect(writes.map((w) => w.fields?.text)).toEqual(['Globex', 'Umbrella']);
  });
});

// An ordering key is an expression over the record it ranks, so it may walk on
// from it. Such a key is the ENGINE's to evaluate — the source has no such
// column — and with it goes the LIMIT, or a truncated fetch would be sorted
// into the wrong answer.
describe('an ORDER BY key may be a path off the record it ranks', () => {
  const PEOPLE: NodeRow[] = [
    { id: 'p-1', fields: { name: 'Ada', joined: '2020-01-01' } },
    { id: 'p-2', fields: { name: 'Bo', joined: '2024-01-01' } },
    { id: 'p-3', fields: { name: 'Cy', joined: '2022-01-01' } },
  ];
  const LINKS = {
    'n-1/owner': [{ recordType: 'person', recordId: 'p-1' }],
    'n-2/owner': [{ recordType: 'person', recordId: 'p-2' }],
    'n-3/owner': [{ recordType: 'person', recordId: 'p-3' }],
  };

  async function walk(bracket: string) {
    const kg = makeGraphFake({
      adapterType: KG,
      collections: { company: COMPANIES, person: PEOPLE },
      links: LINKS,
    });
    const source = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement probe(go: <runs-[:Invocation]->>) {
  graph-[c:${bracket}]-> {
    write graph-[:note]-> { text: c.\`name\` }
  }
}
listen to runs {} fire probe
`;
    const { writes } = await run(source, kg);
    const scan = kg.reads.filter((r) => r.fieldId === 'company');
    expect(scan).toHaveLength(1);
    return { names: writes.map((w) => w.fields?.text), fetch: scan[0] };
  }

  it('ranks by the related record’s field, and asks the adapter for neither the sort nor the limit', async () => {
    const { names, fetch } = await walk('company ORDER BY c-[:owner]->.`joined` DESC LIMIT 2');
    // Owners joined: Bo 2024 (Globex), Cy 2022 (Initech), Ada 2020 (Acme);
    // Hooli and Umbrella have no owner, so their key is empty and sorts last.
    expect(names).toEqual(['Globex', 'Initech']);
    expect(fetch.orderBy).toBeUndefined();
    expect(fetch.limit).toBeUndefined();
  });

  it('…where a bare field key is still handed over, sort and limit both', async () => {
    const { names, fetch } = await walk('company ORDER BY `revenue` DESC LIMIT 2');
    expect(names).toEqual(['Initech', 'Globex']);
    expect(fetch.orderBy).toEqual({ fieldId: 'revenue', direction: 'desc' });
    expect(fetch.limit).toBe(2);
  });

  it('an expression hop ranks by the same path key', async () => {
    const kg = makeGraphFake({
      adapterType: KG,
      collections: { company: COMPANIES, person: PEOPLE },
      links: LINKS,
    });
    const source = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement probe(go: <runs-[:Invocation]->>) {
  write graph-[:note]-> {
    text: "\${JOIN(graph-[c:company ORDER BY c-[:owner]->.\`joined\` DESC LIMIT 2]->.\`name\`, ", ")}"
  }
}
listen to runs {} fire probe
`;
    const { writes } = await run(source, kg);
    expect(writes[0].fields?.text).toBe('Globex, Initech');
  });
});

describe('ONLY is a cardinality claim the run enforces', () => {
  function onlyMovement(where: string): string {
    return `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement pick(go: <runs-[:Invocation]->>) {
  co = ONLY(graph-[c:company WHERE ${where}]->)
  if co == null { ERROR("nothing matched") }
  write graph-[:note]-> { text: co.\`name\` }
}
listen to runs {} fire pick
`;
  }

  it('one match is the value', async () => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    const { writes } = await run(onlyMovement('`name` == "Initech"'), kg);
    expect(writes.map((w) => w.fields?.text)).toEqual(['Initech']);
  });

  it('nothing matched is ordinary absence — the guard is what stops the run', async () => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    await expect(run(onlyMovement('`name` == "Wonka"'), kg)).rejects.toThrow(
      /MOVENG_ERROR[\s\S]*nothing matched/,
    );
  });

  it('more than one fails the run, naming the count', async () => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    await expect(run(onlyMovement('`stage` == "Seed"'), kg)).rejects.toThrow(
      /MOVENG_RUNTIME[\s\S]*exactly one[\s\S]*there are 4/,
    );
  });
});

describe('an early return stops the body, so the narrowed path never sees absence (v3)', () => {
  // The checker narrows after `if co == null { return … }` (and after an
  // `else { return … }`) because the run never reaches the rest of the body
  // from the returning arm. These prove that half: with nothing matched the
  // write below is never attempted, and with a match it runs on the value.
  function guarded(guard: string): string {
    return `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement pick(go: <runs-[:Invocation]->>) {
  co = ONLY(graph-[c:company WHERE \`name\` == "Wonka"]->)
  ${guard}
  write graph-[:note]-> { text: co.\`name\` }
  return "written"
}
listen to runs {} fire pick
`;
  }
  const guards = [
    'if co == null { return "none" }',
    'if co != null { } else { return "none" }',
    'if co == null { if 1 == 1 { return "none" } else { ERROR("unreachable") } }',
  ];

  it.each(guards)('nothing matched: `%s` returns before the write', async (guard) => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES }, writable: true });
    // A run that failed would reject; this one finishes having written nothing.
    const { writes } = await run(guarded(guard), kg);
    expect(writes).toEqual([]);
  });

  it.each(guards)('a match: `%s` falls through to the write, on the value', async (guard) => {
    const kg = makeGraphFake({
      adapterType: KG,
      collections: { company: [...COMPANIES, { id: 'c-wonka', fields: { name: 'Wonka', stage: 'Seed' } }] },
      writable: true,
    });
    const { writes } = await run(guarded(guard), kg);
    expect(writes.map((w) => w.fields?.text)).toEqual(['Wonka']);
  });
});

describe('instance-rooted query traversals share the same walk', () => {
  it('an attio-rooted expression read honours WHERE + ORDER BY ASC + LIMIT', async () => {
    // Fields the catalog's thin attio schema declares (name / summary).
    const crm = makeGraphFake({
      adapterType: 'attio',
      collections: {
        companies: [
          { id: 'a-1', fields: { name: 'Globex', summary: 'keep' } },
          { id: 'a-2', fields: { name: 'Acme', summary: 'keep' } },
          { id: 'a-3', fields: { name: 'Zenith', summary: 'drop' } },
        ],
      },
    });
    const kg = makeGraphFake({ adapterType: KG, collections: {} });
    const source = `import { manual, attio, kg } from adapters
import { acme_main, kg_cred } from credentials
crm = attio(credentials: acme_main)
runs = manual()
graph = kg(credentials: kg_cred)
movement cheapest(go: <runs-[:Invocation]->>) {
  write graph-[:note]-> {
    text ?: FIRST(crm-[c:companies WHERE \`summary\` == "keep" ORDER BY \`name\` LIMIT 1]->.\`name\`)
  }
}
listen to runs {} fire cheapest
`;
    const writes: CapturedWrite[] = [];
    await runMovement({
      source,
      event: manualEvent(),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: () => 'cred-1',
      resolveAdapter: makeResolver({
        manual: manualAdapter,
        attio: crm.adapter,
        [KG]: kg.adapter,
      }),
      dryRun: true,
      writeSink: (w) => writes.push(w),
    });
    // 'keep' rows by name asc: Acme first; LIMIT 1 → exactly one value.
    expect(writes).toEqual([
      expect.objectContaining({ recordType: 'note', fields: { text: 'Acme' } }),
    ]);
    expect(crm.scans).toEqual(['companies']);
  });
});

// Regression: an event-position field read used inside a hop WHERE filter
// (`graph-[c:… WHERE `field` <= go.`Fired at`]->`). The bracket-WHERE grammar
// parses EVERY `alias.`field`` inside the bracket as an `edge_property`
// terminal — so the event read `go.`Fired at`` arrives with an edge_property
// terminal, not a plain `property`. The engine used to reject that with
// `MOVENG_UNSUPPORTED: this read shape on the event position`; an event field
// read is a perfectly valid filter operand (the `UnsnoozeActions` cron pattern).
describe('event-position field read inside a hop WHERE filter', () => {
  it('reads the event field as a filter operand (edge_property terminal)', async () => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    // The run-now invocation carries `Text: "Seed"` — the WHERE filters kg
    // companies by comparing their `stage` to that event field.
    const event: TriggerEvent = {
      ...manualEvent(),
      payload: { firedAt: new Date(0).toISOString(), text: 'Seed' },
    };
    const source = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement unsnooze(go: <runs-[:Invocation]->>) {
  graph-[c:company WHERE \`stage\` == go.\`Text\` ORDER BY \`name\`]-> {
    write graph-[:note]-> { text: c.\`name\` }
  }
}
listen to runs {} fire unsnooze
`;
    const writes: CapturedWrite[] = [];
    // Before the fix this THREW `MOVENG_UNSUPPORTED: this read shape on the
    // event position`; completing at all proves the edge_property terminal is
    // now accepted. The event field is genuinely consumed: only the Seed
    // companies pass `stage == go.`Text``.
    await runMovement({
      source,
      event,
      teamId: TEAM_ID,
      catalog,
      resolveAdapter: makeResolver({ manual: manualAdapter, [KG]: kg.adapter }),
      dryRun: true,
      writeSink: (w) => writes.push(w),
    });
    expect(writes.map((w) => w.fields?.text)).toEqual(['Acme', 'Globex', 'Hooli', 'Umbrella']);
  });
});

// `channel = FIRST(<bare traversal>)` binds a RECORD, not a value — the
// checker types it as a maybe-empty position, and a write parented at it has to
// reach the system the record was read from. The engine used to box the picked
// SourcePosition in a `value` binding, which `resolveLinkedParent` rejects
// outright ("a linked write's path must start at a bound write handle…").
// (plans/movement-absence-null-2026-07-31, piece 3.)
describe('FIRST over a bare traversal binds the landed record', () => {
  const SELECT_AND_WRITE = (where: string): string => `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement note_top(go: <runs-[:Invocation]->>) {
  top = FIRST(graph-[c:company WHERE ${where} ORDER BY \`name\`]->)
  if top == null { ERROR("no company matched") }
  write top-[:notes]-> { text: top.\`name\` }
}
listen to runs {} fire note_top
`;

  it('a write off the picked record lands on it', async () => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    const { writes } = await run(SELECT_AND_WRITE('`stage` == "Seed"'), kg);
    // `note` is resolved from the PICKED company's `notes` edge (so the write
    // parented at a real record), and the field is read back off the same
    // binding: the FIRST 'Seed' company by name is Acme, not the first row.
    expect(writes).toEqual([
      expect.objectContaining({ recordType: 'note', fields: { text: 'Acme' } }),
    ]);
  });

  it('LAST picks the other end of the same walk', async () => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    const source = SELECT_AND_WRITE('`stage` == "Seed"').replace('FIRST(', 'LAST(');
    const { writes } = await run(source, kg);
    expect(writes[0].fields).toEqual({ text: 'Umbrella' });
  });

  it('the miss path fails the run with the ERROR reason', async () => {
    const kg = makeGraphFake({ adapterType: KG, collections: { company: COMPANIES } });
    await expect(run(SELECT_AND_WRITE('`stage` == "Nowhere"'), kg)).rejects.toThrow(
      'no company matched',
    );
  });
});

// A hop's WHERE crosses the seam CLOSED over the scope it was written in: an
// adapter can only narrow by a value it holds, so a reference the engine has
// already resolved to a scalar (a body binding, a field of a record bound
// outside the hop) arrives as that literal. Production bug this fixes: a hop
// `crm-[o:Organization WHERE `Name` == d.`name`]->` reached the Affinity
// adapter with `d.name` unresolved, so nothing pushed and the walk paged the
// whole workspace.
describe("a hop's WHERE reaches the adapter with the author's bound values filled in", () => {
  const NOTES: NodeRow[] = [{ id: 'note-1', fields: { text: 'Globex' } }];

  /** The fetch the one filtered `company` scan arrived with, plus what the
   *  movement wrote — the engine's answer must not move. */
  async function filteredFetch(body: string) {
    const kg = makeGraphFake({
      adapterType: KG,
      collections: { company: COMPANIES, note: NOTES },
    });
    const source = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement probe(go: <runs-[:Invocation]->>) {
${body}
}
listen to runs {} fire probe
`;
    const { writes } = await run(source, kg);
    const filtered = kg.reads.filter((r) => r.fieldId === 'company' && r.where !== undefined);
    expect(filtered).toHaveLength(1);
    return { where: filtered[0].where, texts: writes.map((w) => w.fields?.text) };
  }

  it('a body binding is the literal it already is', async () => {
    const { where, texts } = await filteredFetch(
      '  wanted = "Globex"\n' +
        '  write graph-[:note]-> { text: "${JOIN(graph-[c:company WHERE `name` == wanted ORDER BY `name`]->.`name`, ", ")}" }',
    );
    expect(where).toEqual({
      type: 'compare',
      op: 'eq',
      left: { type: 'edge_property', propertyTypeId: 'name' },
      right: { type: 'static', value: 'Globex' },
    });
    expect(texts).toEqual(['Globex']);
  });

  it('a field of a record bound OUTSIDE the hop is read once, before the fetch', async () => {
    const { where, texts } = await filteredFetch(
      '  graph-[d:note]-> {\n' +
        '    write graph-[:note]-> { text: "${JOIN(graph-[c:company WHERE `name` == d.`text` ORDER BY `name`]->.`name`, ", ")}" }\n' +
        '  }',
    );
    expect(where).toEqual({
      type: 'compare',
      op: 'eq',
      left: { type: 'edge_property', propertyTypeId: 'name' },
      right: { type: 'static', value: 'Globex' },
    });
    expect(texts).toEqual(['Globex']);
  });

  it("the element's own fields stay references — they are what the adapter matches", async () => {
    const { where, texts } = await filteredFetch(
      '  write graph-[:note]-> { text: "${JOIN(graph-[c:company WHERE `stage` == "Seed" ORDER BY `name`]->.`name`, ", ")}" }',
    );
    expect(where).toEqual({
      type: 'compare',
      op: 'eq',
      left: { type: 'edge_property', propertyTypeId: 'stage' },
      right: { type: 'static', value: 'Seed' },
    });
    expect(texts).toEqual(['Acme, Globex, Hooli, Umbrella']);
  });

  it('a reference the engine has NOT resolved to a scalar stays a reference', async () => {
    const { where, texts } = await filteredFetch(
      '  wanted = graph-[s:company]->.`name`\n' +
        '  write graph-[:note]-> { text: "${JOIN(graph-[c:company WHERE `name` IN wanted ORDER BY `name`]->.`name`, ", ")}" }',
    );
    expect(where).toEqual({
      type: 'compare',
      op: 'in',
      left: { type: 'edge_property', propertyTypeId: 'name' },
      right: { type: 'edge_property', propertyTypeId: 'wanted' },
    });
    // The answer is the engine's, unchanged: every company's name is in the
    // list, so every company survives the filter.
    expect(texts).toEqual(['Acme, Globex, Hooli, Initech, Umbrella']);
  });
});
