// A hop whose WHERE narrows a POLYMORPHIC edge to one member, at RUNTIME.
//
// The checker already rebinds such a hop to the selected member's own surface
// (`InstanceSchema.refinements`). The runtime has to agree, or a landed record
// of a DIFFERENT member gets the selected member's WHERE evaluated against it
// and drifts on a field that member never had. It is not schema drift — the
// record is simply not on the addressed path — so it is dropped, silently,
// before any of its fields are read.
//
// Two behaviours are pinned here, through the REAL interpreter:
//   1. the member gate — every walker (block head, expression hop, EXISTS hop)
//      drops a landed record whose `recordType` is not the member the host
//      selected for that hop (`InstanceSchema.selectedMembers`);
//   2. AND short-circuit on the pure predicate path — a conjunct already false
//      stops the rest of the WHERE from being read, exactly as the full async
//      evaluator does.

import { parseTraversalPath, refinementKey, scanInstanceChains } from 'movement-lang';
import type { InstanceSchema } from 'movement-lang';
import { refineInstanceSchema } from '../../translation_graph/movement/refinements';
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
import { AdapterNameDriftError } from '../../translation_graph/adapters/name_resolution';
import {
  META_RECORD_TYPE,
  makeStablePosition,
  positionRecordId,
} from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';

const TEAM_ID = '00000000-0000-0000-0000-000000000021' as TeamId;
const KG = 'kg';

const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

/** A polymorphic member is ADDRESSED by one name and LANDS records of another.
 *  The meta walk files an Affinity list under its bare name (`Portfolio`) and
 *  its entries are stamped with the per-list TYPE (`List Entry —
 *  Portfolio`); only the second is a name a record can ever carry.
 *  Every fixture here keeps the two apart, because a fixture where they agree
 *  cannot tell a gate that compares the right one from one that does not. */
const MASTER_LIST = 'Portfolio';
const HANDOVER_LIST = 'Watchlist';
const MASTER = `List Entry — ${MASTER_LIST}`;
const HANDOVER = `List Entry — ${HANDOVER_LIST}`;
const LIST_ENTRY = 'list_entry';
/** The EDGE the hop walks — `list_entry` is the polymorphic type it lands on. */
const LIST_ENTRIES = 'list_entries';

/** The key the checker and the host both derive for a hop's selection. Parsed
 *  out of the hop the way both sides do it — a bare field inside a bracket
 *  WHERE is an `edge_property`, so the same text written outside one keys
 *  differently. */
function keyFor(where: string): string {
  const steps = parseTraversalPath(`-[:${LIST_ENTRIES} WHERE ${where}]->`);
  const filter = steps?.[0]?.type === 'edge' ? steps[0].expressionFilter : undefined;
  if (!filter) throw new Error(`test setup: no filter parsed out of \`${where}\``);
  return refinementKey({ type: LIST_ENTRY, filter });
}

const NARROWED = '`listName` == "Portfolio" AND `Added On` >= "2026-01-01"';
/** The same selection with the conjuncts the other way round — the checker
 *  narrows it identically, so the runtime must drop identically. */
const REVERSED = '`Added On` >= "2026-01-01" AND `listName` == "Portfolio"';
/** The host names a refined position after the member's ADDRESSING name. */
const REFINED_POSITION = `${LIST_ENTRY} "${MASTER_LIST}"`;

/** Exactly what the catalog's refinement pass grafts: the refined position,
 *  the checker's key onto it, and the member TYPE that key selected — the
 *  string the adapter stamps on one of that member's records, never the
 *  addressing name the position is titled after. */
const crmSchema: InstanceSchema = {
  positions: {
    organization: {
      properties: { name: 'text' },
      edges: { list_entries: { target: LIST_ENTRY, polymorphic: true } },
    },
    // The polymorphic base — the INTERSECTION of the members: every list entry
    // knows which list it is on, and nothing else.
    [LIST_ENTRY]: { properties: { listName: 'text' }, edges: {} },
    // The members themselves, as the projection publishes them. A landed
    // record carries its own member type, and only these names let the read
    // seam keep the adapter's concrete stamp.
    [MASTER]: { properties: { listName: 'text', 'Added On': 'text' }, edges: {} },
    [HANDOVER]: { properties: { listName: 'text' }, edges: {} },
    [REFINED_POSITION]: {
      properties: { listName: 'text', 'Added On': 'text' },
      edges: {},
    },
    note: { properties: { text: 'text' }, edges: {} },
  },
  collections: { organization: { target: 'organization' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
  },
  refinements: { [keyFor(NARROWED)]: REFINED_POSITION },
  selectedMembers: { [keyFor(NARROWED)]: MASTER },
};

interface EntryRow {
  id: string;
  recordType: string;
  fields: Record<string, unknown>;
}

/** Two lists' entries hanging off one organisation — the production shape.
 *  The handover list never had a `Added On` field, so ASKING for one is
 *  the failure: the fake drifts exactly as a real adapter's name resolver
 *  does. */
const ENTRIES: EntryRow[] = [
  {
    id: 'e-1',
    recordType: MASTER,
    fields: { listName: 'Portfolio', 'Added On': '2026-05-01' },
  },
  { id: 'e-2', recordType: HANDOVER, fields: { listName: 'Watchlist' } },
  {
    id: 'e-3',
    recordType: MASTER,
    fields: { listName: 'Portfolio', 'Added On': '2025-02-01' },
  },
];

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: false, edgeProperties: false }, resources: false };
}

/** One organisation, its list entries, and a field reader that drifts on a
 *  field the landed record's own type does not declare. */
function makeCrmFake(rows: EntryRow[] = ENTRIES) {
  const fieldReads: Array<{ recordType: string | null; fieldId: string }> = [];
  const writes: Array<{ recordType: string; fields: Record<string, unknown> }> = [];
  const byId = new Map(rows.map((e) => [e.id, e]));
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
      fieldReads.push({ recordType: position.recordType, fieldId });
      const id = positionRecordId(position);
      const row = id !== undefined ? byId.get(id) : undefined;
      if (row === undefined) return null;
      if (!(fieldId in row.fields)) {
        throw new AdapterNameDriftError(
          `'${fieldId}' is not a known field of '${row.recordType}' in this connection — its schema has changed (drift).`,
        );
      }
      return row.fields[fieldId] ?? null;
    },
    async getRelated(read: GetRelatedInput): Promise<RelatedResult[]> {
      if (read.position.recordType === META_RECORD_TYPE) {
        if (read.fieldId !== 'organization') return [];
        return [
          {
            position: makeStablePosition({
              adapterType: KG,
              recordType: 'organization',
              recordId: 'org-1',
            }),
          },
        ];
      }
      if (read.fieldId !== 'list_entries') return [];
      return rows.map((entry) => ({
        position: makeStablePosition({
          adapterType: KG,
          recordType: entry.recordType,
          recordId: entry.id,
        }),
      }));
    },
    async createRecord(write) {
      writes.push({ recordType: write.recordType, fields: write.fields });
      return { adapterType: KG, externalId: `new-${writes.length}`, data: {} };
    },
    async updateRecord(update) {
      return {
        adapterType: KG,
        externalId: update.externalId,
        data: {},
        association: containerAssociation(update),
      };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, fieldReads, writes };
}

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-narrowing',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: new Date().toISOString() },
    occurredAt: new Date().toISOString(),
  };
}

function sourceFor(body: string): string {
  return `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement sweep(go: <runs-[:Invocation]->>) {
${body}
}
listen to runs {} fire sweep
`;
}

async function runWith(input: {
  schema: InstanceSchema;
  fake: { adapter: Adapter };
  body: string;
}) {
  const catalog = staticCatalogFromManifests({
    credentials: { kg_cred: { adapters: [KG] } },
    instanceSchemas: { [KG]: input.schema },
  });
  const source = sourceFor(input.body);
  const writes: CapturedWrite[] = [];
  const run = runMovement({
    source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'manual') return manualAdapter;
      if (adapterType === KG) return input.fake.adapter;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
    dryRun: true,
    writeSink: (w) => writes.push(w),
  });
  return { run, writes };
}

describe('a narrowed polymorphic hop drops the members it did not select', () => {
  it('a BLOCK HEAD hop never reads a field off another member', async () => {
    const fake = makeCrmFake();
    const { run, writes } = await runWith({
      schema: crmSchema,
      fake,
      body: `  graph-[o:organization]-> {
    o-[le:${LIST_ENTRIES} WHERE ${NARROWED} ORDER BY \`Added On\`]-> {
      write graph-[:note]-> { text: le.\`Added On\` }
    }
  }`,
    });

    await run;
    // Only the selected member's entries survive the member gate; the date
    // test then filters within that member.
    expect(writes.map((w) => w.fields?.text)).toEqual(['2026-05-01']);
    // The dropped member's record was never asked for a field at all.
    expect(fake.fieldReads.filter((r) => r.recordType === HANDOVER)).toEqual([]);
  });

  it('an EXPRESSION hop drops the same records', async () => {
    const fake = makeCrmFake();
    const { run, writes } = await runWith({
      schema: crmSchema,
      fake,
      body: `  graph-[o:organization]-> {
    write graph-[:note]-> { text: "\${JOIN(o-[le:${LIST_ENTRIES} WHERE ${NARROWED} ORDER BY \`Added On\`]->.\`Added On\`, ", ")}" }
  }`,
    });

    await run;
    expect(writes.map((w) => w.fields?.text)).toEqual(['2026-05-01']);
    expect(fake.fieldReads.filter((r) => r.recordType === HANDOVER)).toEqual([]);
  });

  it('an EXISTS hop drops the same records', async () => {
    const fake = makeCrmFake();
    const { run, writes } = await runWith({
      schema: crmSchema,
      fake,
      body: `  graph-[o:organization]-> {
    if EXISTS(o-[le:${LIST_ENTRIES} WHERE ${NARROWED} ORDER BY \`Added On\`]->) {
      write graph-[:note]-> { text: "found" }
    }
  }`,
    });

    await run;
    expect(writes.map((w) => w.fields?.text)).toEqual(['found']);
    expect(fake.fieldReads.filter((r) => r.recordType === HANDOVER)).toEqual([]);
  });

  it('GENUINE drift — a field missing from the SELECTED member — still raises', async () => {
    const fake = makeCrmFake();
    // The selected member's own records lack `Closed On`; that IS drift and
    // must stay loud. Same hop, same narrowing, one more conjunct.
    const where = `${NARROWED} AND \`Closed On\` == "x"`;
    const schema: InstanceSchema = {
      ...crmSchema,
      positions: {
        ...crmSchema.positions,
        [REFINED_POSITION]: {
          properties: { listName: 'text', 'Added On': 'text', 'Closed On': 'text' },
          edges: {},
        },
      },
      refinements: { ...crmSchema.refinements, [keyFor(where)]: REFINED_POSITION },
      selectedMembers: { ...crmSchema.selectedMembers, [keyFor(where)]: MASTER },
    };
    const { run } = await runWith({
      schema,
      fake,
      body: `  graph-[o:organization]-> {
    o-[le:${LIST_ENTRIES} WHERE ${where}]-> {
      write graph-[:note]-> { text: le.\`Added On\` }
    }
  }`,
    });

    await expect(run).rejects.toThrow(/drift/);
  });

  // The discriminant does not have to come FIRST. The checker narrows the
  // whole hop, so the runtime must too — evaluation order is not what decides
  // which members a hop is about.
  it('drops the other member whichever way round the conjunction is written', async () => {
    const fake = makeCrmFake();
    const schema: InstanceSchema = {
      ...crmSchema,
      refinements: { ...crmSchema.refinements, [keyFor(REVERSED)]: REFINED_POSITION },
      selectedMembers: { ...crmSchema.selectedMembers, [keyFor(REVERSED)]: MASTER },
    };
    const { run, writes } = await runWith({
      schema,
      fake,
      body: `  graph-[o:organization]-> {
    o-[le:${LIST_ENTRIES} WHERE ${REVERSED} ORDER BY \`Added On\`]-> {
      write graph-[:note]-> { text: le.\`Added On\` }
    }
  }`,
    });

    await run;
    expect(writes.map((w) => w.fields?.text)).toEqual(['2026-05-01']);
    expect(fake.fieldReads.filter((r) => r.recordType === HANDOVER)).toEqual([]);
  });

  // THE DEFECT THIS GATE FIRST SHIPPED WITH, pinned from the engine side.
  //
  // Stored the member's ADDRESSING name (`Portfolio`) instead of the
  // TYPE its records carry (`List Entry — Portfolio`), the gate
  // compares two different vocabularies. That is never equal, so the hop drops
  // not the other list's entries but ALL of them — silently, with no error and
  // nothing written. A whole class of narrowed hop became a no-op and the run
  // still reported success.
  //
  // The host is what must never put that name here (`refinements.unit.test.ts`
  // pins that it stores the described member's own type); this is the evidence
  // of what it costs if it ever does again.
  it('the ADDRESSING name in selectedMembers lands NOTHING — the defect, made visible', async () => {
    const fake = makeCrmFake();
    const { run, writes } = await runWith({
      schema: { ...crmSchema, selectedMembers: { [keyFor(NARROWED)]: MASTER_LIST } },
      fake,
      body: `  graph-[o:organization]-> {
    o-[le:${LIST_ENTRIES} WHERE ${NARROWED} ORDER BY \`Added On\`]-> {
      write graph-[:note]-> { text: le.\`Added On\` }
    }
  }`,
    });

    await run;
    expect(writes).toEqual([]);
    expect(fake.fieldReads.filter((r) => r.recordType === MASTER)).toEqual([]);
  });

  // The two halves, end to end: the string the HOST resolves for this exact
  // hop is the string the fixtures above hand the engine. Hand-authoring them
  // separately is how they came to disagree in the first place.
  it('the host resolves this hop to the same member TYPE the engine is given', async () => {
    const { schema } = await refineInstanceSchema({
      instance: {
        adapterType: KG,
        schema: crmSchema,
        entryPoints: [
          { typeId: 'organization', displayName: 'organization', writable: false, readable: true },
          { typeId: LIST_ENTRY, displayName: LIST_ENTRY, writable: false, readable: false },
          { typeId: MASTER, displayName: MASTER, writable: false, readable: true },
          { typeId: HANDOVER, displayName: HANDOVER, writable: false, readable: true },
        ],
        // What the META WALK publishes: members addressed by their bare list
        // name, labelled with the data a narrowing predicate runs against.
        membersOf: async () => [
          { name: MASTER_LIST, data: { listName: MASTER_LIST } },
          { name: HANDOVER_LIST, data: { listName: HANDOVER_LIST } },
        ],
        // Walking to a member yields the per-list TYPE — a different name from
        // the one the walk was addressed by, exactly as Affinity's does.
        describeType: async (member: string) => ({
          typeId: `List Entry — ${member}`,
          displayName: `List Entry — ${member}`,
          fields: [
            {
              fieldId: 'listName',
              displayName: 'listName',
              kind: 'string' as const,
              writable: false,
              required: false,
            },
            {
              fieldId: 'Added On',
              displayName: 'Added On',
              kind: 'string' as const,
              writable: false,
              required: false,
            },
          ],
          references: [],
        }),
      },
      chains: scanInstanceChains(
        sourceFor(`  graph-[o:organization]-> {
    o-[le:${LIST_ENTRIES} WHERE ${NARROWED} ORDER BY \`Added On\`]-> {
      write graph-[:note]-> { text: le.\`Added On\` }
    }
  }`),
      ),
    });

    expect(schema.selectedMembers?.[keyFor(NARROWED)]).toBe(MASTER);
    expect(schema.refinements?.[keyFor(NARROWED)]).toBe(REFINED_POSITION);
  });

  // THE ESCAPE, and it is load-bearing for real adapters. Google Sheets and
  // Attio both land every record of a narrowed hop stamped with the edge's
  // DECLARED target (Attio's `Lists` edge lands `Companies List` whatever list
  // the membership is on), so the stamp states nothing about membership and
  // the gate must not read a claim into it. The WHERE decides alone, exactly
  // as it did before the gate existed.
  it('keeps every record from an adapter that stamps only the DECLARED target', async () => {
    const uniform: EntryRow[] = ENTRIES.map((entry) => ({
      ...entry,
      recordType: LIST_ENTRY,
      // One landing type means one surface: the field the WHERE tests exists
      // on every record, so nothing drifts and nothing needs dropping.
      fields: { 'Added On': '2024-01-01', ...entry.fields },
    }));
    const fake = makeCrmFake(uniform);
    const { run, writes } = await runWith({
      schema: crmSchema,
      fake,
      body: `  graph-[o:organization]-> {
    o-[le:${LIST_ENTRIES} WHERE ${NARROWED} ORDER BY \`Added On\`]-> {
      write graph-[:note]-> { text: le.\`Added On\` }
    }
  }`,
    });

    await run;
    // The WHERE did all the work: the handover entry fails on `listName`, the
    // 2025 master entry on the date.
    expect(writes.map((w) => w.fields?.text)).toEqual(['2026-05-01']);
    // …and it was READ, not gated away.
    expect(fake.fieldReads.some((r) => r.recordType === LIST_ENTRY)).toBe(true);
  });

  // The production shape: the whole path inside `EXISTS(…)`, rooted at the
  // instance. The host learns which hops to narrow from the chain scan, and the
  // bridge hands this path over as a zero-step traverse whose EXISTS carries the
  // hops — so until the scan read them, nothing was selected, every list's
  // entries faced the WHERE, and the other list's entry drifted on `Added On`.
  // Resolved here by the REAL scan and the REAL host pass, not hand-authored.
  it('an instance-rooted EXISTS is narrowed by the host and drops the other member', async () => {
    const body = (cutoff: string) =>
      `  if EXISTS(graph-[o:organization]->-[le:${LIST_ENTRIES} WHERE \`listName\` == "Portfolio" AND \`Added On\` >= "${cutoff}"]->) {
    write graph-[:note]-> { text: "on the list since ${cutoff}" }
  }`;
    // Nothing resolved yet: no refinement, no selection, no refined position.
    const unresolved: InstanceSchema = {
      ...crmSchema,
      positions: Object.fromEntries(
        Object.entries(crmSchema.positions).filter(([name]) => name !== REFINED_POSITION),
      ),
      refinements: {},
      selectedMembers: {},
    };
    // What the META WALK publishes, and what walking to a member describes.
    const instance = {
      adapterType: KG,
      schema: unresolved,
      entryPoints: [
        { typeId: 'organization', displayName: 'organization', writable: false, readable: true },
        { typeId: LIST_ENTRY, displayName: LIST_ENTRY, writable: false, readable: false },
      ],
      membersOf: async (recordType: string) =>
        recordType === LIST_ENTRY
          ? [
              { name: MASTER_LIST, data: { listName: MASTER_LIST } },
              { name: HANDOVER_LIST, data: { listName: HANDOVER_LIST } },
            ]
          : [],
      describeType: async (member: string) => ({
        typeId: `List Entry — ${member}`,
        displayName: `List Entry — ${member}`,
        fields: ['listName', 'Added On'].map((name) => ({
          fieldId: name,
          displayName: name,
          kind: 'string' as const,
          writable: false,
          required: false,
        })),
        references: [],
      }),
    };

    for (const [cutoff, expected] of [
      ['2026-01-01', ['on the list since 2026-01-01']],
      ['2027-01-01', []],
    ] as const) {
      const { schema } = await refineInstanceSchema({
        instance,
        chains: scanInstanceChains(sourceFor(body(cutoff))),
      });
      expect(Object.values(schema.selectedMembers ?? {})).toEqual([MASTER]);

      const fake = makeCrmFake();
      const { run, writes } = await runWith({ schema, fake, body: body(cutoff) });
      await run;
      expect(writes.map((w) => w.fields?.text)).toEqual(expected);
      expect(fake.fieldReads.filter((r) => r.recordType === HANDOVER)).toEqual([]);
    }
  });

  it('a hop the host did not narrow keeps its existing behaviour', async () => {
    const fake = makeCrmFake();
    // No `selectedMembers` entry: nothing was resolved, so nothing is dropped
    // and the WHERE runs against every landed record, as it always has — the
    // other member is asked for a field it never had, and that is drift.
    const schema: InstanceSchema = {
      ...crmSchema,
      refinements: { ...crmSchema.refinements, [keyFor(REVERSED)]: REFINED_POSITION },
      selectedMembers: {},
    };
    const { run } = await runWith({
      schema,
      fake,
      body: `  graph-[o:organization]-> {
    o-[le:${LIST_ENTRIES} WHERE ${REVERSED} ORDER BY \`Added On\`]-> {
      write graph-[:note]-> { text: le.\`Added On\` }
    }
  }`,
    });

    await expect(run).rejects.toThrow(/drift/);
  });
});

// ── AND short-circuit on the pure predicate path ───────────────────────────
//
// `evalScopedFilter` routes a PURE hop WHERE through the shared filter unit,
// and claims the decision is identical to the full async evaluator's. The full
// evaluator stops at the first false conjunct; the pure path used to resolve
// every leaf read first, so a WHERE whose later conjunct names a field the
// record cannot answer threw even where the decision was already made.

const CONTACT = 'contact';

const contactSchema: InstanceSchema = {
  positions: {
    [CONTACT]: { properties: { stage: 'text', score: 'number' }, edges: {} },
    note: { properties: { text: 'text' }, edges: {} },
  },
  collections: { [CONTACT]: { target: CONTACT }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
  },
};

/** One contact carries a score, the other cannot answer for one at all. */
function makeContactFake() {
  const rows: Record<string, Record<string, unknown>> = {
    'c-1': { stage: 'Seed', score: 5 },
    'c-2': { stage: 'Late' },
  };
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
      const id = positionRecordId(position) ?? '';
      const row = rows[id];
      if (row === undefined) return null;
      if (!(fieldId in row)) {
        throw new AdapterNameDriftError(
          `'${fieldId}' is not a known field of '${position.recordType}' in this connection — its schema has changed (drift).`,
        );
      }
      return row[fieldId] ?? null;
    },
    async getRelated(read: GetRelatedInput): Promise<RelatedResult[]> {
      if (read.position.recordType !== META_RECORD_TYPE || read.fieldId !== CONTACT) return [];
      return Object.keys(rows).map((id) => ({
        position: makeStablePosition({ adapterType: KG, recordType: CONTACT, recordId: id }),
      }));
    },
    async createRecord(write) {
      return { adapterType: KG, externalId: 'new', data: {}, ...write };
    },
    async updateRecord(update) {
      return {
        adapterType: KG,
        externalId: update.externalId,
        data: {},
        association: containerAssociation(update),
      };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter };
}

describe('the pure predicate path short-circuits an AND', () => {
  it('a false first conjunct stops the rest of the WHERE being read', async () => {
    const { run, writes } = await runWith({
      schema: contactSchema,
      fake: makeContactFake(),
      body: `  write graph-[:note]-> { text: "\${JOIN(graph-[c:${CONTACT} WHERE \`stage\` == "Seed" AND \`score\` >= 1 ORDER BY \`stage\`]->.\`stage\`, ", ")}" }`,
    });

    await run;
    expect(writes.map((w) => w.fields?.text)).toEqual(['Seed']);
  });

  it('a conjunct the record REACHES still raises its missing-field error', async () => {
    const { run } = await runWith({
      schema: contactSchema,
      fake: makeContactFake(),
      body: `  write graph-[:note]-> { text: "\${JOIN(graph-[c:${CONTACT} WHERE \`stage\` == "Late" AND \`score\` >= 1 ORDER BY \`stage\`]->.\`stage\`, ", ")}" }`,
    });

    await expect(run).rejects.toThrow(/drift/);
  });
});
