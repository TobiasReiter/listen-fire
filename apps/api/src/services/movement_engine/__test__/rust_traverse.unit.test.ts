// Traversal blocks in the Rust engine (chunk 5B task 4), held to the
// TypeScript engine: each program runs under MOVEMENT_ENGINE=ts and =rust
// against fresh fakes, and the two must agree on everything a caller can see
// — the result or the error, the trace and its hand-overs, the resolver's
// requests, and every call each adapter received, in order and key for key
// (compared as JSON text, so the order of an argument object's keys is held
// too: a hop's `getRelated` is the very request the TypeScript makes).

import { mockCatalogSnapshot, parseTraversalPath, refinementKey, type InstanceSchema } from 'movement-lang';

import { evaluatePredicate } from '#shared/expression/filter';
import type { Expression } from '#shared/expression/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { Adapter, GetRelatedInput, RelatedResult } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { META_RECORD_TYPE, makeStablePosition, makeUnstablePosition, positionData, positionRecordId } from '../../translation_graph/types';
import type { MovementTraceEntry } from '../expression';
import { MovementRunFailed, runFailureCause, runMovement, type MovementRunResult } from '../run';
import { resetRustEvalStats, resetRustRunStats, rustEvalStats, rustRunStats } from '../rust_stats';
import { credentialIdsFor, makeTestHost } from '../test_host';

const TEAM_ID = '00000000-0000-0000-0000-0000000000c4' as TeamId;

const emailSchema: InstanceSchema = {
  positions: {
    message: { properties: { subject: 'text', text: 'text' }, edges: { attachments: { target: 'attachment' } } },
    attachment: { properties: { name: 'text' }, edges: {} },
  },
  collections: {},
  writableRoots: {},
};

/** A polymorphic edge narrowed by its WHERE to one member: the member is
 *  ADDRESSED as `Portfolio` and its records are stamped `List Entry —
 *  Portfolio` (hop_narrowing.unit.test.ts has the production shape). */
const MASTER = 'List Entry — Portfolio';
const HANDOVER = 'List Entry — Watchlist';
const NARROWED = '`listName` == "Portfolio"';
function selectionKey(where: string): string {
  const steps = parseTraversalPath(`-[:list_entries WHERE ${where}]->`);
  const filter = steps?.[0]?.type === 'edge' ? steps[0].expressionFilter : undefined;
  if (!filter) throw new Error(`test setup: no filter parsed out of \`${where}\``);
  return refinementKey({ type: 'list_entry', filter });
}

const graphSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', stage: 'text', revenue: 'number', note: 'text' },
      edges: { deals: { target: 'deal' }, list_entries: { target: 'list_entry', polymorphic: true } },
    },
    list_entry: { properties: { listName: 'text' }, edges: {} },
    [MASTER]: { properties: { listName: 'text' }, edges: {} },
    [HANDOVER]: { properties: { listName: 'text' }, edges: {} },
    'list_entry "Portfolio"': { properties: { listName: 'text' }, edges: {} },
    deal: { properties: { title: 'text' }, edges: {} },
    lead: { properties: { name: 'text', score: 'number' }, edges: {} },
    note: { properties: { text: 'text' }, edges: {} },
  },
  collections: { company: { target: 'company' }, lead: { target: 'lead' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
  },
  refinements: { [selectionKey(NARROWED)]: 'list_entry "Portfolio"' },
  selectedMembers: { [selectionKey(NARROWED)]: MASTER },
};

const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    graph: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: graphSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, graph_main: { adapters: ['graph'] } },
});

const PRELUDE = [
  'import { email, graph } from adapters',
  'import { dealflow_inbox, graph_main } from credentials',
  'inbox = email(credentials: dealflow_inbox)',
  'kg    = graph(credentials: graph_main)',
  '',
].join('\n');

interface Row {
  id: string;
  fields: Record<string, unknown>;
}

const COMPANIES: Row[] = [
  { id: 'n-1', fields: { name: 'Acme', stage: 'Seed', revenue: 10 } },
  { id: 'n-2', fields: { name: 'Globex', stage: 'Seed', revenue: 30 } },
  { id: 'n-3', fields: { name: 'Initech', stage: 'Late', revenue: 50 } },
  { id: 'n-4', fields: { name: 'Hooli', stage: 'Seed', revenue: null } },
  { id: 'n-5', fields: { name: 'Umbrella', stage: 'Seed', revenue: 20 } },
];

interface GraphOptions {
  collections?: Record<string, Row[]>;
  /** Record-to-record links, `<fromId>/<edge>`. */
  links?: Record<string, string[]>;
  /** What an edge lands from any record (the origin a rehearsed write minted). */
  edges?: Record<string, string[]>;
  /** Honour the pushed WHERE, ORDER BY and LIMIT, as a source that can
   *  narrow does; otherwise answer the whole collection. */
  honours?: boolean;
  /** Stream the traversal, `pageSize` records a page. */
  pageSize?: number;
  /** A page that answers the cursor it was handed. */
  stuckCursor?: boolean;
  /** Land the collection's records as raw payloads (unstable positions). */
  unstable?: boolean;
}

/** A graph whose records are rows, recording every call it gets. */
function fakeGraph(options: GraphOptions = {}) {
  const calls: Array<[string, unknown]> = [];
  const collections = options.collections ?? { company: COMPANIES };
  const byId = new Map<string, Row & { type: string }>();
  for (const [type, rows] of Object.entries(collections)) for (const row of rows) byId.set(row.id, { ...row, type });
  const position = (row: Row & { type: string }) =>
    options.unstable === true
      ? makeUnstablePosition({ adapterType: 'graph', recordType: row.type, data: row.fields })
      : makeStablePosition({ adapterType: 'graph', recordType: row.type, recordId: row.id });
  const related = (read: GetRelatedInput): RelatedResult[] => {
    const rows =
      read.position.recordType === META_RECORD_TYPE
        ? (collections[read.fieldId] ?? []).map((row) => byId.get(row.id)!)
        : (options.links?.[`${positionRecordId(read.position) ?? ''}/${read.fieldId}`] ?? options.edges?.[read.fieldId] ?? []).map(
            (id) => byId.get(id)!,
          );
    let kept = rows;
    if (options.honours === true) {
      if (read.where !== undefined) {
        const where: Expression = read.where;
        kept = kept.filter((row) => Boolean(evaluatePredicate(where, { read: (name) => row.fields[name] })));
      }
      if (read.orderBy !== undefined) {
        const { fieldId, direction } = read.orderBy;
        const sign = direction === 'desc' ? -1 : 1;
        kept = [...kept].sort((a, b) => {
          const [x, y] = [a.fields[fieldId], b.fields[fieldId]];
          if (x == null) return y == null ? 0 : 1;
          if (y == null) return -1;
          return (x < y ? -1 : x > y ? 1 : 0) * sign;
        });
      }
      if (read.limit !== undefined) kept = kept.slice(0, read.limit);
    }
    return kept.map((row) => ({ position: position(row) }));
  };
  const streaming = options.pageSize !== undefined;
  const pageSize = options.pageSize ?? 0;
  const adapter: Adapter = {
    adapterType: 'graph',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    async describe(recordType) {
      calls.push(['describe', recordType]);
      return null;
    },
    async resolveEntity(input) {
      calls.push(['resolveEntity', input]);
      return { candidates: [] };
    },
    async getFieldValue(input) {
      calls.push(['getFieldValue', input]);
      const id = positionRecordId(input.position);
      if (id !== undefined) return byId.get(id)?.fields[input.fieldId] ?? null;
      return (positionData(input.position) as Record<string, unknown> | undefined)?.[input.fieldId] ?? null;
    },
    async getRelated(read) {
      calls.push(['getRelated', read]);
      return related(read);
    },
    ...(streaming
      ? {
          // eslint-disable-next-line @typescript-eslint/require-await -- the stream's shape is the contract's
          async *iterateRelated(read: GetRelatedInput) {
            yield* related(read);
          },
          async iterateRelatedPage(read: GetRelatedInput, cursor?: unknown) {
            calls.push(['iterateRelatedPage', { read, cursor }]);
            const all = related(read);
            const from = typeof cursor === 'number' ? cursor : 0;
            const next = from + pageSize;
            if (options.stuckCursor === true && cursor !== undefined) return { items: all.slice(from, next), nextCursor: cursor };
            return { items: all.slice(from, next), ...(next < all.length ? { nextCursor: next } : {}) };
          },
        }
      : {}),
    async createRecord(input) {
      calls.push(['createRecord', input]);
      return { adapterType: 'graph', externalId: `new-${calls.length}`, data: {} };
    },
    async updateRecord(input) {
      calls.push(['updateRecord', input]);
      return { adapterType: 'graph', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    deleteRecord: async () => ({}),
  };
  return { adapter, calls };
}

function fakeEmail() {
  const calls: Array<[string, unknown]> = [];
  const adapter: Adapter = {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      calls.push(['getFieldValue', input]);
      return (positionData(input.position) as Record<string, unknown> | undefined)?.[input.fieldId] ?? null;
    },
    async getRelated(read) {
      calls.push(['getRelated', read]);
      return ['a-1', 'a-2'].map((id) => ({ position: makeStablePosition({ adapterType: 'email', recordType: 'attachment', recordId: id }) }));
    },
    createRecord: async () => ({ adapterType: 'email', externalId: 'x', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
  return { adapter, calls };
}

function webhook(payload: Record<string, unknown>): TriggerEvent {
  return { pipelineInputId: 'pi-rust-traverse', adapterType: 'email', triggerType: 'webhook', payload };
}

interface Case {
  body: string;
  event?: TriggerEvent;
  graph?: GraphOptions;
  costCapMicrodollars?: number;
  suspendAt?: readonly string[];
}

interface Outcome {
  failed: boolean;
  result?: MovementRunResult;
  error?: unknown;
  graph: string;
  email: string;
  resolved: unknown[];
  trace: unknown[];
  appends: unknown[][];
  captured: CapturedWrite[];
}

async function runOn(engine: 'ts' | 'rust', c: Case): Promise<Outcome> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const graph = fakeGraph(c.graph);
  const email = fakeEmail();
  const resolved: unknown[] = [];
  const trace: unknown[] = [];
  const appends: MovementTraceEntry[][] = [];
  const captured: CapturedWrite[] = [];
  const world = () => ({
    // As JSON text: the key order of every argument object is compared too.
    graph: JSON.stringify(graph.calls),
    email: JSON.stringify(email.calls),
    resolved,
    trace,
    appends,
    captured,
  });
  try {
    const result = await runMovement({
      source: `${PRELUDE}movement m(msg: <inbox-[:message]->>) {\n${c.body}\n}`,
      event: c.event ?? webhook({ subject: 'Seed', text: 'Late' }),
      teamId: TEAM_ID,
      catalog,
      credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
      firedAt: '2026-05-01T09:00:00.000Z',
      dryRun: true,
      ...(c.costCapMicrodollars !== undefined ? { costCapMicrodollars: c.costCapMicrodollars } : {}),
      ...(c.suspendAt !== undefined ? { suspendAt: [...c.suspendAt] } : {}),
      host: makeTestHost({
        writeSink: (w: CapturedWrite) => captured.push(w),
        adapters: {
          resolve: (request) => {
            resolved.push(request);
            if (request.adapterType === 'email') return email.adapter;
            if (request.adapterType === 'graph') return graph.adapter;
            throw new Error(`test: no fake for ${request.adapterType}`);
          },
        },
        trace: trace as never[],
        traceAppends: appends,
      }),
    });
    return { failed: false, result, ...world() };
  } catch (error) {
    return { failed: true, error, ...world() };
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

/** A rehearsal mints random ids: each run's, in the order they appear, read
 *  as the same placeholders. */
function sameIds<T>(value: T): T {
  const ids = new Map<string, string>();
  const text = JSON.stringify(value);
  const normal = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    if (!ids.has(id)) ids.set(id, `uuid-${ids.size + 1}`);
    return ids.get(id)!;
  });
  return JSON.parse(normal) as T;
}

/** The case on both engines: they agree, and the Rust run was the Rust
 *  engine's alone. */
async function agree(c: Case) {
  const ts = await runOn('ts', c);
  resetRustEvalStats();
  resetRustRunStats();
  const rust = await runOn('rust', c);
  expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, notAdmitted: {}, declined: {} });
  expect(rustEvalStats).toEqual({ notAdmitted: 0, admitted: 0, answered: 0, fallback: {} });
  const world = ({ failed: _failed, result: _result, error: _error, ...rest }: Outcome) => rest;
  expect(sameIds(world(rust))).toEqual(sameIds(world(ts)));
  if (ts.failed) {
    expect(rust.failed).toBe(true);
    expect(String(rust.error)).toBe(String(ts.error));
    expect(runFailureCause(rust.error)?.constructor).toBe((runFailureCause(ts.error) as object).constructor);
    if (ts.error instanceof MovementRunFailed && rust.error instanceof MovementRunFailed) {
      expect(sameIds(rust.error.partial)).toEqual(sameIds(ts.error.partial));
    }
  } else {
    expect(rust.failed).toBe(false);
    expect(sameIds(rust.result)).toEqual(sameIds(ts.result));
  }
  return { ts, rust };
}

const written = (o: Outcome) => o.captured.map((w) => w.fields?.text);
const calls = (o: Outcome, which: 'graph' | 'email' = 'graph') => JSON.parse(o[which]) as Array<[string, Record<string, unknown>]>;

const BRACKET = 'company WHERE `stage` == "Seed" ORDER BY `revenue` DESC LIMIT 2';
const NOTE_PER_COMPANY = (bracket: string) => `  kg-[c:${bracket}]-> {\n    write kg-[:note]-> { text: c.\`name\` }\n  }`;

describe('traversal blocks in the Rust engine', () => {
  it('pushes the WHERE, ORDER BY and LIMIT and filters, sorts and slices what comes back, as the TypeScript engine does', async () => {
    const { rust } = await agree({ body: NOTE_PER_COMPANY(BRACKET) });
    expect(written(rust)).toEqual(['Globex', 'Umbrella']);
    const [method, fetch] = calls(rust).find(([m]) => m === 'getRelated')!;
    expect(method).toBe('getRelated');
    expect(Object.keys(fetch)).toEqual(['position', 'fieldId', 'direction', 'where', 'orderBy', 'limit']);
    expect(fetch).toMatchObject({ fieldId: 'company', direction: 'outgoing', orderBy: { fieldId: 'revenue', direction: 'desc' }, limit: 2 });
    expect(rust.trace).toContainEqual({ kind: 'block', root: `kg-[c:${BRACKET}]->`, positions: 2 });
  });

  it('answers the same records in the same order whether the adapter honours the pushdown or filters nothing', async () => {
    const local = await agree({ body: NOTE_PER_COMPANY(BRACKET) });
    const pushed = await agree({ body: NOTE_PER_COMPANY(BRACKET), graph: { honours: true } });
    expect(written(pushed.rust)).toEqual(written(local.rust));
    const fetch = (o: Outcome) => calls(o).find(([m]) => m === 'getRelated')?.[1];
    expect(fetch(pushed.rust)).toEqual(fetch(local.rust));
    // The adapter that honoured it answered two; the engine read the WHERE
    // and the key off those two only.
    const reads = (o: Outcome) => calls(o).filter(([m]) => m === 'getFieldValue').length;
    expect(reads(pushed.rust)).toBeLessThan(reads(local.rust));
  });

  it('orders by a key that is not a bare field locally, asking the adapter for neither the sort nor the limit', async () => {
    const { rust } = await agree({ body: NOTE_PER_COMPANY('company ORDER BY c.`name` DESC LIMIT 3') });
    expect(written(rust)).toEqual(['Umbrella', 'Initech', 'Hooli']);
    const fetch = calls(rust).find(([m]) => m === 'getRelated')?.[1];
    expect(fetch).not.toHaveProperty('orderBy');
    expect(fetch).not.toHaveProperty('limit');
  });

  it('closes the pushed WHERE over the values the scope holds, an event field read before the fetch', async () => {
    const { rust } = await agree({
      body: '  wanted = msg.`subject`\n' + NOTE_PER_COMPANY('company WHERE `stage` == wanted AND c.`name` != msg.`text` AND `revenue` >= 10'),
    });
    expect(written(rust)).toEqual(['Acme', 'Globex', 'Umbrella']);
    const fetch = calls(rust).find(([m]) => m === 'getRelated')?.[1];
    expect(JSON.stringify(fetch?.where)).toContain('{"type":"static","value":"Seed"}');
    expect(JSON.stringify(fetch?.where)).toContain('{"type":"static","value":"Late"}');
    // The event's text was read (for the pushdown) before the fetch.
    const order = calls(rust, 'email').map(([m, input]) => `${m}:${String(input.fieldId)}`);
    expect(order.slice(0, 2)).toEqual(['getFieldValue:subject', 'getFieldValue:text']);
    expect(calls(rust).findIndex(([m]) => m === 'getRelated')).toBe(0);
  });

  it('decides a pure WHERE a conjunct at a time, and evaluates any other whole', async () => {
    await agree({ body: NOTE_PER_COMPANY('company WHERE `stage` == "Late" AND `revenue` > 1') });
    await agree({ body: NOTE_PER_COMPANY('company WHERE `stage` == "Late" OR `revenue` > 25') });
    const impure = await agree({ body: NOTE_PER_COMPANY('company WHERE UPPER(`name`) == "ACME"') });
    expect(written(impure.rust)).toEqual(['Acme']);
    expect(calls(impure.rust).find(([m]) => m === 'getRelated')?.[1]).not.toHaveProperty('where');
  });

  it('runs no body for an empty traversal', async () => {
    const { rust } = await agree({ body: NOTE_PER_COMPANY('company WHERE `stage` == "Nowhere"') });
    expect(written(rust)).toEqual([]);
    expect(rust.trace).toEqual([{ kind: 'block', root: 'kg-[c:company WHERE `stage` == "Nowhere"]->', positions: 0 }]);
    const none = await agree({ body: NOTE_PER_COMPANY('lead'), graph: { collections: { company: COMPANIES } } });
    expect(written(none.rust)).toEqual([]);
  });

  it('traces the field a raw-payload landing does not carry, once, as the TypeScript engine does', async () => {
    // `note` is the schema's, and no record's payload carries it.
    const { rust } = await agree({ body: NOTE_PER_COMPANY('company WHERE `note` == null'), graph: { unstable: true } });
    expect(written(rust)).toHaveLength(5);
    expect(rust.trace.filter((e) => (e as { kind: string }).kind === 'field_miss')).toEqual([
      { kind: 'field_miss', binding: 'kg', field: 'note', available: ['name', 'stage', 'revenue'] },
    ]);
  });

  it('walks a streamed traversal a page at a time, filtering each page before it asks for the next', async () => {
    const { rust } = await agree({ body: NOTE_PER_COMPANY(BRACKET), graph: { pageSize: 2 } });
    expect(written(rust)).toEqual(['Globex', 'Umbrella']);
    const pages = calls(rust).filter(([m]) => m === 'iterateRelatedPage');
    expect(pages.map(([, p]) => p.cursor ?? null)).toEqual([null, 2, 4]);
    // The first page's records are read before the second page is asked for.
    expect(calls(rust).map(([m]) => m).slice(0, 4)).toEqual(['iterateRelatedPage', 'getFieldValue', 'getFieldValue', 'iterateRelatedPage']);
  });

  it('fails a paged traversal whose server hands its cursor back, with the TypeScript engine’s error', async () => {
    const { rust } = await agree({ body: NOTE_PER_COMPANY('company'), graph: { pageSize: 2, stuckCursor: true } });
    expect(String(runFailureCause(rust.error))).toContain('paged traversal: the page for cursor 2 answered the same cursor again');
  });

  it('walks off the event and off a write handle, each from its own position', async () => {
    const offEvent = await agree({ body: '  msg-[a:attachments]-> {\n    write kg-[:note]-> { text: a.`name` }\n  }' });
    expect(offEvent.rust.captured).toHaveLength(2);
    const offHandle = await agree({
      body: '  co = write kg-[:company]-> { name: "Acme" }\n  co-[d:deals]-> {\n    write kg-[:note]-> { text: d.`title` }\n  }',
      graph: { collections: { company: COMPANIES, deal: [{ id: 'd-1', fields: { title: 'Seed round' } }] }, edges: { deals: ['d-1'] } },
    });
    expect(written(offHandle.rust)).toEqual([undefined, 'Seed round']);
    // From the handle's own record, stamped with its type.
    const fetch = calls(offHandle.rust).find(([m]) => m === 'getRelated')?.[1];
    expect(fetch?.position).toMatchObject({ adapterType: 'graph', recordType: 'company', identity: { kind: 'stable' } });
  });

  it('runs each body at its own address with its own scope, in order', async () => {
    const { rust } = await agree({
      body: [
        '  label = "co"',
        '  kg-[c:company WHERE `revenue` > 15 ORDER BY `name`]-> {',
        '    n = c.`name`',
        '    if n != "Initech" {',
        '      write kg-[:note]-> { text: "${label}: ${n}" }',
        '    } else {',
        '      write kg-[:note]-> { text: "late: ${n}" }',
        '    }',
        '    return n',
        '  }',
        '  write kg-[:note]-> { text: "done" }',
      ].join('\n'),
    });
    expect(written(rust)).toEqual(['co: Globex', 'late: Initech', 'co: Umbrella', 'done']);
  });

  it('leaves to the TypeScript engine, before it asks its host anything, a run that could suspend inside a block', async () => {
    for (const [c, reason] of [
      [{ body: NOTE_PER_COMPANY('company'), costCapMicrodollars: 1_000 }, 'cost_cap_inside_block'],
      [{ body: NOTE_PER_COMPANY('company'), suspendAt: ['s0.i1.s0'] }, 'suspend_at_inside_block'],
    ] as const) {
      resetRustRunStats();
      await runOn('rust', c);
      expect(rustRunStats.notAdmitted).toEqual({ [reason]: 1 });
      expect(rustRunStats.hostCalls).toEqual({});
    }
  });

  it('drops the records of the members a narrowed hop is not about, before reading their fields', async () => {
    const { rust } = await agree({
      body: [
        '  co = write kg-[:company]-> { name: "Acme" }',
        `  co-[le:list_entries WHERE ${NARROWED}]-> {`,
        '    write kg-[:note]-> { text: le.`listName` }',
        '  }',
      ].join('\n'),
      graph: {
        collections: {
          company: COMPANIES,
          [MASTER]: [{ id: 'le-1', fields: { listName: 'Portfolio' } }],
          [HANDOVER]: [{ id: 'le-2', fields: { listName: 'Portfolio' } }],
        },
        edges: { list_entries: ['le-1', 'le-2'] },
      },
    });
    expect(written(rust)).toEqual([undefined, 'Portfolio']);
    // The other member's record was never read.
    expect(calls(rust).filter(([m, input]) => m === 'getFieldValue' && JSON.stringify(input).includes('le-2'))).toEqual([]);
  });
});
