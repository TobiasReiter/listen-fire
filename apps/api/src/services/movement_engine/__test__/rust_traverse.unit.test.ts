// Traversal blocks in the Rust engine (chunk 5B task 4), held to the
// TypeScript engine: each program runs under MOVEMENT_ENGINE=ts and =rust
// against fresh fakes, and the two must agree on everything a caller can see
// — the result or the error, the trace and its hand-overs, the resolver's
// requests, and every call each adapter received, in order and key for key
// (compared as JSON text, so the order of an argument object's keys is held
// too: a hop's `getRelated` is the very request the TypeScript makes).

import { mockCatalogSnapshot, parseTraversalPath, refinementKey, type InstanceSchema } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';

import { evaluatePredicate } from '#shared/expression/filter';
import type { Expression } from '#shared/expression/types';
import type { Adapter, GetRelatedInput, RelatedResult } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { META_RECORD_TYPE, makeStablePosition, makeUnstablePosition, positionData, positionRecordId } from '../../translation_graph/types';
import { MovementEngineError } from '../errors';
import type { MovementTraceEntry } from '../expression';
import { MovementRunFailed, runFailureCause, runMovement, type MovementRunResult } from '../run';
import { resetRustEvalStats, resetRustRunStats, rustEvalStats, rustRunStats } from '../rust_stats';
import { credentialIdsFor, makeFakeParkSink, makeTestHost, recordingWriteLocks } from '../test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000c4');

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
    deal: { properties: { title: 'text', stage: 'text' }, edges: {} },
    lead: { properties: { name: 'text', score: 'number' }, edges: {} },
    note: { properties: { text: 'text' }, edges: {} },
  },
  collections: { company: { target: 'company' }, lead: { target: 'lead' }, note: { target: 'note' }, deal: { target: 'deal' } },
  writableRoots: {
    note: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    deal: { fields: { title: 'text' }, resultShape: { externalId: 'text', title: 'text' } },
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
  /** What the adapter says it can traverse (`runtimeCapabilities().traversal`). */
  traversal?: { incoming?: boolean; edgeProperties?: boolean };
  /** The records whose every field read fails, by id (`d-1`), or one field
   *  of one (`d-1/stage`). */
  failOn?: string | readonly string[];
  /** Each field read (`<id>/<field>`) waits on what this answers, before it
   *  answers or fails. */
  gate?: (read: string) => Promise<void> | undefined;
  /** The inline properties of the edge each record is landed by, by its id. */
  edgeProperties?: Record<string, Record<string, unknown>>;
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
    return kept.map((row) => {
      const edgeProperties = options.edgeProperties?.[row.id];
      return { position: position(row), ...(edgeProperties !== undefined ? { edgeProperties } : {}) };
    });
  };
  const streaming = options.pageSize !== undefined;
  const pageSize = options.pageSize ?? 0;
  const adapter: Adapter = {
    adapterType: 'graph',
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: { incoming: options.traversal?.incoming ?? false, edgeProperties: options.traversal?.edgeProperties ?? false },
      resources: false,
    }),
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
      await options.gate?.(`${id ?? ''}/${input.fieldId}`);
      const failing = typeof options.failOn === 'string' ? [options.failOn] : (options.failOn ?? []);
      if (id !== undefined && (failing.includes(id) || failing.includes(`${id}/${input.fieldId}`))) throw new Error(`graph: ${id} is unreadable`);
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
  /** A fresh hold for each run (see `holdingRead`). */
  hold?: () => HeldRead;
}

interface HeldRead {
  gate: (read: string) => Promise<void> | undefined;
  /** Runs beside the run; `done` settles (never rejects) when the run does. */
  meanwhile: (done: Promise<void>) => Promise<void>;
}

/** Holds one field read (`<id>/<field>`) at the host until a macrotask after
 *  it arrives, recording, run by run, whether the run had settled by then. */
function holdingRead(read: string) {
  const settledWhileHeld: boolean[] = [];
  const hold = (): HeldRead => {
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    return {
      gate: (key) => {
        if (key !== read) return undefined;
        arrive();
        return released;
      },
      async meanwhile(done) {
        let settled = false;
        void done.then(() => (settled = true));
        await Promise.race([arrived, done]);
        // Every microtask has run by the next macrotask: a sibling read's
        // failure has reached the engine, and a run that fails on it has.
        await new Promise((resolve) => setImmediate(resolve));
        settledWhileHeld.push(settled);
        release();
      },
    };
  };
  return { hold, settledWhileHeld };
}

interface Outcome {
  failed: boolean;
  /** Every `locks.acquire`'s names, in order. */
  locks: string[][];
  result?: MovementRunResult;
  error?: unknown;
  graph: string;
  email: string;
  resolved: unknown[];
  trace: unknown[];
  appends: unknown[][];
  captured: CapturedWrite[];
}

const noop = () => {};

async function runOn(engine: 'ts' | 'rust', c: Case): Promise<Outcome> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const locks: string[][] = [];
  const hold = c.hold?.();
  const graph = fakeGraph({ ...c.graph, ...(hold !== undefined ? { gate: hold.gate } : {}) });
  const email = fakeEmail();
  const resolved: unknown[] = [];
  const trace: unknown[] = [];
  const appends: MovementTraceEntry[][] = [];
  const captured: CapturedWrite[] = [];
  const world = () => ({
    locks,
    // As JSON text: the key order of every argument object is compared too.
    graph: JSON.stringify(graph.calls),
    email: JSON.stringify(email.calls),
    resolved,
    trace,
    appends,
    captured,
  });
  try {
    const run = runMovement({
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
        locks: recordingWriteLocks(locks),
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
    await hold?.meanwhile(run.then(noop, noop));
    const result = await run;
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
    expect(codeOf(runFailureCause(rust.error))).toBe(codeOf(runFailureCause(ts.error)));
    if (ts.error instanceof MovementRunFailed && rust.error instanceof MovementRunFailed) {
      expect(sameIds(rust.error.partial)).toEqual(sameIds(ts.error.partial));
    }
  } else {
    expect(rust.failed).toBe(false);
    expect(sameIds(rust.result)).toEqual(sameIds(ts.result));
  }
  return { ts, rust };
}

/** A failure's MOVENG code, when it carries one. */
const codeOf = (error: unknown) => (error instanceof MovementEngineError ? error.code : undefined);

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

  it('runs two blocks that reuse a hop alias and a body name, each in its own scope', async () => {
    const block = (where: string) => `  kg-[c:company WHERE ${where}]-> {\n    n = c.\`name\`\n    write kg-[:note]-> { text: n }\n  }`;
    const { rust } = await agree({ body: `${block('`stage` == "Late"')}\n${block('`revenue` == 10')}` });
    expect(written(rust)).toEqual(['Initech', 'Acme']);
  });

  describe('nested blocks', () => {
    const DEALS: Row[] = [
      { id: 'd-1', fields: { title: 'Seed round' } },
      { id: 'd-2', fields: { title: 'Series A' } },
      { id: 'd-3', fields: { title: 'Bridge' } },
    ];
    const graph = (extra: GraphOptions = {}): GraphOptions => ({
      collections: { company: COMPANIES, deal: DEALS },
      links: { 'n-1/deals': ['d-1', 'd-2'], 'n-2/deals': ['d-3'], 'n-3/deals': ['d-2'] },
      ...extra,
    });
    const NESTED = [
      '  kg-[c:company WHERE `revenue` >= 10 ORDER BY `name`]-> {',
      '    write kg-[:note]-> { text: "co ${c.`name`}" }',
      '    c-[d:deals WHERE `title` != "Bridge" ORDER BY `title` DESC]-> {',
      '      t = d.`title`',
      '      if t == "Series A" {',
      '        write kg-[:note]-> { text: "${c.`name`}: ${t}!" }',
      '      } else {',
      '        write kg-[:note]-> { text: "${c.`name`}: ${t}" }',
      '      }',
      '    }',
      '    write kg-[:note]-> { text: "end ${c.`name`}" }',
      '  }',
      '  write kg-[:note]-> { text: "done" }',
    ].join('\n');

    it('walks a hop off each landing, its body writing at both levels, in order', async () => {
      const { rust } = await agree({ body: NESTED, graph: graph() });
      expect(written(rust)).toEqual([
        'co Acme', 'Acme: Series A!', 'Acme: Seed round', 'end Acme',
        'co Globex', 'end Globex',
        'co Initech', 'Initech: Series A!', 'end Initech',
        'co Umbrella', 'end Umbrella',
        'done',
      ]);
      // Each nested walk starts at its own landing's position.
      const origins = calls(rust).filter(([m, input]) => m === 'getRelated' && input.fieldId === 'deals').map(([, input]) => positionRecordId(input.position as never));
      expect(origins).toEqual(['n-1', 'n-2', 'n-3', 'n-5']);
      expect(rust.trace).toContainEqual({ kind: 'block', root: 'c-[d:deals WHERE `title` != "Bridge" ORDER BY `title` DESC]->', positions: 2 });
    });

    it('fails mid-fan-out where the TypeScript engine does, keeping the writes before it', async () => {
      const { rust } = await agree({ body: NESTED, graph: graph({ failOn: 'd-3' }) });
      expect(rust.failed).toBe(true);
      expect(String(runFailureCause(rust.error))).toContain('graph: d-3 is unreadable');
      expect(rust.error instanceof MovementRunFailed ? rust.error.partial.writes.length : -1).toBe(5);
    });

    it('fails in an inner iteration’s body after the one before it wrote, as the TypeScript engine does', async () => {
      // The inner WHERE reads `title`; only the body reads `stage`, so the
      // failure is d-1's body, after d-2's iteration wrote.
      const body = NESTED.replace('      t = d.`title`', '      t = d.`title`\n      s = d.`stage`');
      const { rust } = await agree({ body, graph: graph({ failOn: 'd-1/stage' }) });
      expect(String(runFailureCause(rust.error))).toContain('graph: d-1 is unreadable');
      expect(rust.error instanceof MovementRunFailed ? rust.error.partial.writes.map((w) => w.writtenValues.text) : []).toEqual(['co Acme', 'Acme: Series A!']);
    });
  });

  describe('bound blocks', () => {
    it('binds what the iterations return as one list, its trail the union of theirs', async () => {
      const { rust } = await agree({
        body: [
          '  names = kg-[c:company WHERE `revenue` >= 20 ORDER BY `name`]-> {',
          '    if c.`stage` == "Late" {',
          '      return "late ${c.`name`}"',
          '    }',
          '    return c.`name`',
          '  }',
          '  write kg-[:note]-> { text: "${LENGTH(names)}: ${AT(names, 0)}, ${AT(names, 1)}" }',
        ].join('\n'),
      });
      expect(written(rust)).toEqual(['3: Globex, late Initech']);
    });

    it('binds no returned records when nothing returns, read as an empty list and a null field', async () => {
      const { rust } = await agree({
        body: [
          '  none = kg-[c:company WHERE `stage` == "Nowhere"]-> {',
          '    return c.`name`',
          '  }',
          '  quiet = kg-[c:company]-> {',
          '    if c.`stage` == "Nowhere" {',
          '      return c.`name`',
          '    }',
          '  }',
          '  write kg-[:note]-> { text: "${LENGTH(none)} ${LENGTH(quiet)} ${none.`name` == null}" }',
        ].join('\n'),
      });
      expect(written(rust)).toEqual(['0 0 true']);
    });
  });

  it('fails loudly on an ORDER BY over more than 64 records whose keys mix numbers and text, where the TypeScript engine orders them', async () => {
    const rows: Row[] = Array.from({ length: 65 }, (_, i) => ({ id: `m-${i}`, fields: { name: `co ${i}`, revenue: i % 2 === 0 ? i : `${i}` } }));
    const c: Case = { body: NOTE_PER_COMPANY('company ORDER BY `revenue`'), graph: { collections: { company: rows } } };
    expect((await runOn('ts', c)).failed).toBe(false);
    resetRustRunStats();
    const rust = await runOn('rust', c);
    expect(rustRunStats).toMatchObject({ ranWhole: 1, notAdmitted: {}, declined: {} });
    expect(String(runFailureCause(rust.error))).toContain('ORDER BY over 65 records whose keys mix numbers with text or other kinds is not supported');
    expect(rust.captured).toEqual([]);
  });

  describe('edge properties', () => {
    const DEALS: Row[] = [
      { id: 'd-1', fields: { title: 'Seed round' } },
      { id: 'd-2', fields: { title: 'Series A' } },
      { id: 'd-3', fields: { title: 'Bridge' } },
    ];
    const graph = (edgeProperties: boolean): GraphOptions => ({
      collections: { company: COMPANIES, deal: DEALS },
      edges: { deals: ['d-1', 'd-2', 'd-3'] },
      traversal: { edgeProperties },
      edgeProperties: { 'd-1': { role: 'lead' }, 'd-2': { role: 'follow' } },
    });
    const body = (where: string) =>
      [
        '  role = "lead"',
        '  co = write kg-[:company]-> { name: "Acme" }',
        `  co-[d:deals WHERE ${where}]-> {`,
        '    write kg-[:note]-> { text: d.`title` }',
        '  }',
      ].join('\n');

    it('reads a bare name off the walked edge first, then a binding of that name, then the record', async () => {
      // `d-3` carries no edge properties: the binding `role` answers for it.
      const { rust } = await agree({ body: body('`role` == "lead"'), graph: graph(true) });
      expect(written(rust)).toEqual([undefined, 'Seed round', 'Bridge']);
    });

    it('leaves a bare name alone in the pushed WHERE when the edge can carry it, and closes over the binding when it cannot', async () => {
      const where = (o: Outcome) => JSON.stringify(calls(o).find(([m]) => m === 'getRelated')?.[1].where);
      const carried = await agree({ body: body('`role` == "lead"'), graph: graph(true) });
      expect(where(carried.rust)).not.toContain('{"type":"static","value":"lead"},{"type":"static"');
      expect(where(carried.rust)).toContain('role');
      const closed = await agree({ body: body('`role` == "lead"'), graph: graph(false) });
      expect(where(closed.rust)).not.toContain('role');
      // Closed over for the fetch; per landing, the edge's own property
      // still answers first.
      expect(written(closed.rust)).toEqual([undefined, 'Seed round', 'Bridge']);
    });
  });
});

// Chunk 6A Task 4: the expression tail — folds, EXISTS, IS tests and a
// record read as a whole value — held to the TypeScript engine call for call.
describe('the expression tail, on both engines', () => {
  const DEALS: Row[] = [
    { id: 'd-1', fields: { title: 'Seed round', stage: 'open' } },
    { id: 'd-2', fields: { title: 'Series A', stage: 'won' } },
  ];
  const withDeals = (over: GraphOptions = {}): GraphOptions => ({
    collections: { company: COMPANIES, deal: DEALS },
    links: { 'n-1/deals': ['d-1', 'd-2'], 'n-2/deals': ['d-2'] },
    edges: { deals: ['d-1'] },
    ...over,
  });
  const fetches = (o: Outcome) => calls(o).filter(([m]) => m === 'getRelated').map(([, input]) => input);

  // Review Focus 4: a hop's WHERE the adapter honours, and one it cannot be
  // handed, answer the same records, and ask with the same arguments.
  describe('COUNT and FIRST over a traversal', () => {
    const PUSHED = 'company WHERE `stage` == "Seed" ORDER BY `revenue` DESC LIMIT 2';
    const LOCAL = 'company WHERE UPPER(`stage`) == "SEED" ORDER BY c.`revenue` DESC LIMIT 2';
    const body = (bracket: string) =>
      [
        `  n = COUNT(kg-[c:${bracket}]->)`,
        `  top = FIRST(kg-[c:${bracket}]->)`,
        `  names = JOIN(kg-[c:${bracket}]->.\`name\`, ", ")`,
        '  write kg-[:note]-> { text: "${n} ${top.`name`} ${names}" }',
      ].join('\n');

    it('answers the same whether the adapter honours the pushed WHERE or not, asking it the same', async () => {
      const local = await agree({ body: body(PUSHED) });
      const pushed = await agree({ body: body(PUSHED), graph: { honours: true } });
      expect(written(local.rust)).toEqual(['2 Globex Globex, Umbrella']);
      expect(written(pushed.rust)).toEqual(written(local.rust));
      expect(fetches(pushed.rust)).toEqual(fetches(local.rust));
      expect(fetches(local.rust)).toHaveLength(3);
      expect(fetches(local.rust)[0]).toMatchObject({ fieldId: 'company', orderBy: { fieldId: 'revenue', direction: 'desc' }, limit: 2 });
    });

    it('filters, orders and bounds locally a WHERE no adapter can be handed, with the same answer', async () => {
      const local = await agree({ body: body(LOCAL) });
      expect(written(local.rust)).toEqual(['2 Globex Globex, Umbrella']);
      for (const fetch of fetches(local.rust)) {
        expect(fetch).not.toHaveProperty('where');
        expect(fetch).not.toHaveProperty('limit');
      }
    });

    it('walks a streaming instance with one getRelated per hop, as an expression does', async () => {
      const { rust } = await agree({ body: body(PUSHED), graph: { pageSize: 2 } });
      // The pick walks as a block head does, a page at a time; the count and
      // the projection, as an expression does, in one getRelated each.
      expect(calls(rust).filter(([m]) => m === 'iterateRelatedPage')).toHaveLength(3);
      expect(fetches(rust)).toHaveLength(2);
    });

    it('picks the last and the only record, binds null when there is none, and fails ONLY over two', async () => {
      const last = await agree({ body: '  top = LAST(kg-[c:company WHERE `stage` == "Seed" ORDER BY `name`]->)\n  write kg-[:note]-> { text: COALESCE(top.`name`, "none") }' });
      expect(written(last.rust)).toEqual(['Umbrella']);
      const none = await agree({ body: '  top = FIRST(kg-[c:company WHERE `stage` == "Gone" ORDER BY `name`]->)\n  if top == null { ERROR("no company matched") }' });
      expect(String(runFailureCause(none.rust.error))).toContain('no company matched');
      const two = await agree({ body: '  co = ONLY(kg-[c:company WHERE `stage` == "Late" OR `revenue` == 30]->)' });
      expect(String(runFailureCause(two.rust.error))).toContain('says there is exactly one, and there are 2');
      const one = await agree({ body: '  co = ONLY(kg-[c:company WHERE `name` == "Initech"]->)\n  if EXISTS(co) {\n    write kg-[:note]-> { text: COALESCE(co.`name`, "?") }\n  }', graph: withDeals() });
      expect(one.rust.captured).toHaveLength(1);
    });

    it('counts from a landed record, a hop alias read in the WHERE and the ORDER BY key a walk of its own', async () => {
      await agree({
        body: '  kg-[c:company]-> {\n    write kg-[:note]-> { text: "${COUNT(c-[d:deals WHERE d.`stage` != "lost"]->)}" }\n  }',
        graph: withDeals(),
      });
      await agree({ body: '  write kg-[:note]-> { text: JOIN(kg-[c:company ORDER BY c-[:deals]->.`title` DESC LIMIT 2]->.`name`, ",") }', graph: withDeals() });
    });
  });

  describe('EXISTS', () => {
    it('asks one getRelated per subject and hop, and reads the WHERE until a record holds it', async () => {
      const { ts, rust } = await agree({
        body: [
          '  co = write kg-[:company]-> { name: "Newco" }',
          '  if EXISTS(co-[:deals]->) { write kg-[:note]-> { text: "any" } }',
          '  if EXISTS(co-[d:deals WHERE `title` == "Seed round"]->) { write kg-[:note]-> { text: "seed" } }',
          '  if NOT EXISTS(co-[d:deals WHERE `title` == "Nope"]->) { write kg-[:note]-> { text: "none" } }',
          '  if EXISTS(kg-[c:company WHERE `stage` == "Late"]-> WHERE `revenue` > 40) { write kg-[:note]-> { text: "late" } }',
          '  if EXISTS(kg-[c:company]->-[d:deals WHERE `stage` == "won"]->) { write kg-[:note]-> { text: "won" } }',
          '  if EXISTS(msg-[:attachments]->) { write kg-[:note]-> { text: "files" } }',
        ].join('\n'),
        graph: withDeals(),
      });
      expect(written(rust)).toEqual([undefined, 'any', 'seed', 'none', 'late', 'won', 'files']);
      expect(fetches(rust)).toHaveLength(fetches(ts).length);
    });

    it('asks whether a value holds one, and tests a candidate of a target WHERE', async () => {
      await agree({
        body: [
          '  v = msg.`subject`',
          '  blank = null',
          '  empty = []',
          '  write kg-[:note]-> { text: "${EXISTS(v)} ${EXISTS(blank)} ${EXISTS(empty)}" }',
          '  kg-[c:company WHERE EXISTS(c-[:deals]->)]-> {',
          '    write kg-[:note]-> { text: c.`name` }',
          '  }',
        ].join('\n'),
        graph: withDeals(),
      });
    });
  });

  it('folds values as the TypeScript engine does', async () => {
    const { rust } = await agree({
      body: [
        '  xs = [3, null, "4", 1]',
        '  rows = [{ n: "b", s: 2 }, { n: "a", s: 9 }, { n: "c" }]',
        '  write kg-[:note]-> { text: "${COUNT(xs)} ${SUM(xs)} ${AVG(xs)} ${MIN([2, 0, 5])} ${MAX(xs)} ${FIRST(xs)} ${LAST(xs)} ${JOIN(xs, "/")} ${COUNT(COLLECT(7))}" }',
        '  write kg-[:note]-> { text: JOIN(SORT(["b", "a", "c"], DESC), "") }',
        '  write kg-[:note]-> { text: JOIN(MAP_NAMES, "") }'.replace('MAP_NAMES', 'SORT([2, 10, 1])'),
        '  ranked = SORT(rows, `s`, DESC)',
        '  r0 = AT(ranked, 0)',
        '  r1 = AT(ranked, 1)',
        '  r2 = AT(ranked, 2)',
        '  pair = [null, 5]',
        '  write kg-[:note]-> { text: "${r0.n}${r1.n}${r2.n} ${ONLY(pair)}" }',
      ].join('\n'),
    });
    expect(written(rust)).toEqual(['3 8 2 0 4 3 1 3/4/1 1', 'cba', '1210', 'abc 5']);
    const only = await agree({ body: '  xs = [1, 2]\n  x = ONLY(xs)' });
    expect(String(runFailureCause(only.rust.error))).toContain('ONLY(xs) says there is exactly one, and there are 2.');
  });

  it('reads a second name for the event, a landing and a handle as the record it names', async () => {
    await agree({
      body: [
        '  m2 = msg',
        '  m3 = m2',
        '  co = write kg-[:company]-> { name: m3.`subject` }',
        '  same = co',
        '  kg-[c:company WHERE `stage` == "Late"]-> {',
        '    doc = c',
        '    write kg-[:note]-> { text: "${doc.`name`} ${same.name}" }',
        '  }',
        '  same-[d:deals]-> {',
        '    write kg-[:note]-> { text: d.`title` }',
        '  }',
      ].join('\n'),
      graph: withDeals(),
    });
  });

  it('parks a picked record, and the event named twice, as the TypeScript engine writes them', async () => {
    const body = [
      '  top = FIRST(kg-[c:company WHERE `stage` == "Seed" ORDER BY `name`]->)',
      '  m2 = msg',
      '  await sleep(1h)',
      '  write kg-[:note]-> { text: COALESCE(top.`name`, m2.`subject`) }',
    ].join('\n');
    async function parkOn(engine: 'ts' | 'rust') {
      const previous = process.env.MOVEMENT_ENGINE;
      process.env.MOVEMENT_ENGINE = engine;
      try {
        const park = makeFakeParkSink();
        const graph = fakeGraph();
        await runMovement({
          source: `${PRELUDE}movement m(msg: <inbox-[:message]->>) {\n${body}\n}`,
          event: webhook({ subject: 'Seed', text: 'Late' }),
          teamId: TEAM_ID,
          catalog,
          credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
          firedAt: '2026-05-01T09:00:00.000Z',
          host: makeTestHost({
            adapters: { resolve: (request) => (request.adapterType === 'graph' ? graph.adapter : fakeEmail().adapter) },
            park: { sink: park.sink },
          }),
        });
        expect(park.timerParks).toHaveLength(1);
        return { state: JSON.stringify(park.timerParks[0]?.state), calls: graph.calls };
      } finally {
        if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
        else process.env.MOVEMENT_ENGINE = previous;
      }
    }
    const ts = await parkOn('ts');
    resetRustRunStats();
    const rust = await parkOn('rust');
    expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, shimFaults: 0 });
    expect(rust.state).toBe(ts.state);
    expect(JSON.stringify(rust.calls)).toBe(JSON.stringify(ts.calls));
    expect(ts.state).toContain('"top":{"kind":"sourcePosition"');
    expect(ts.state).toContain('"read":{"instanceName":"kg"}');
  });

  it('tests a record IS of a kind, from the run alone', async () => {
    const { rust } = await agree({
      event: { ...webhook({ subject: 'Seed', text: 'Late' }), rootRecordType: 'message' },
      body: [
        '  if msg IS <inbox-[:message]->> { write kg-[:note]-> { text: "message" } }',
        '  if msg IS <inbox> { write kg-[:note]-> { text: "inbox" } }',
        '  if msg IS <kg-[:company]->> { write kg-[:note]-> { text: "never" } }',
        '  co = write kg-[:company]-> { name: "Acme" }',
        '  if co IS <kg-[:company]->> { write kg-[:note]-> { text: "company" } }',
        '  if co IS <inbox-[:message]->> { write kg-[:note]-> { text: "never" } }',
        '  kg-[c:company WHERE `name` == "Acme"]-> {',
        '    if c IS <kg-[:company]->> { write kg-[:note]-> { text: "landed" } }',
        '    if c IS <kg-[:deal]->> { write kg-[:note]-> { text: "never" } }',
        '  }',
      ].join('\n'),
    });
    expect(written(rust)).toEqual(['message', 'inbox', undefined, 'company', 'landed']);
  });
});

// chunk 5A's three engine fixes (the write ledger in program order; fans that
// settle before failing; resolutions memoised), on a program both engines run.
describe("5A's engine fixes, on both engines", () => {
  it('writes the ledger in program order, iteration by iteration, each record citing its place there', async () => {
    const { rust } = await agree({
      body: [
        '  kg-[c:company]-> {',
        '    co = write kg-[:company]-> { name: "copy of ${c.`name`}" }',
        '    write kg-[:note]-> { text: co.`name` }',
        '  }',
      ].join('\n'),
    });
    const writes = rust.result?.writes ?? [];
    expect(writes.map((w) => `${w.recordType} ${String(w.writtenValues.name ?? w.writtenValues.text)}`)).toEqual(
      COMPANIES.flatMap(({ fields }) => [`company copy of ${String(fields.name)}`, `note copy of ${String(fields.name)}`]),
    );
    writes.forEach((write, index) => expect(write.origin?.writeIndex).toBe(index));
  });

  it('resolves the instance every iteration writes once for the segment', async () => {
    const { rust } = await agree({ body: NOTE_PER_COMPANY('company') });
    expect(written(rust)).toHaveLength(COMPANIES.length);
    const targets = rust.resolved.filter((r) => typeof r === 'object' && r !== null && Reflect.get(r, 'role') === 'target');
    expect(targets).toHaveLength(1);
  });

  // The TypeScript engine settles every key read of an ORDER BY before it
  // fails, and fails with the earliest by index (`sortByOrderKey`); the Rust
  // engine's join does the same. Eviction on rejection is not here: the one
  // memo a key read could fill keeps successes only, and no Rust-routed
  // program can go on past a failed read to ask again (no `onError` inside a
  // block), so neither engine can show it.
  describe('ORDER BY key reads settle before the run fails', () => {
    const ORDERED = NOTE_PER_COMPANY('company ORDER BY c.`name`');
    const keyReads = (o: Outcome) => calls(o).filter(([m, input]) => m === 'getFieldValue' && input.fieldId === 'name');

    it('issues every key read when one fails, and fails with the TypeScript engine’s error', async () => {
      const { ts, rust } = await agree({ body: ORDERED, graph: { failOn: 'n-2/name' } });
      expect(String(runFailureCause(rust.error))).toContain('graph: n-2 is unreadable');
      expect(keyReads(rust)).toHaveLength(COMPANIES.length);
      expect(keyReads(ts)).toHaveLength(COMPANIES.length);
    });

    it('does not fail while a sibling of the failed read is still held at the host', async () => {
      const held = holdingRead('n-5/name');
      const { rust } = await agree({ body: ORDERED, graph: { failOn: 'n-2/name' }, hold: held.hold });
      expect(held.settledWhileHeld).toEqual([false, false]);
      expect(String(runFailureCause(rust.error))).toContain('graph: n-2 is unreadable');
    });

    it('fails with the lower index’s error when two reads fail, the higher first', async () => {
      // n-2's read is held and fails on release; n-4's fails at once.
      const held = holdingRead('n-2/name');
      const { ts, rust } = await agree({ body: ORDERED, graph: { failOn: ['n-2/name', 'n-4/name'] }, hold: held.hold });
      expect(held.settledWhileHeld).toEqual([false, false]);
      for (const o of [ts, rust]) expect(String(runFailureCause(o.error))).toContain('graph: n-2 is unreadable');
    });
  });
});
