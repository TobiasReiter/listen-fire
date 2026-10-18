// Traversal blocks in the Rust engine (the version-5 reference): each program
// runs against fresh fakes, and everything a caller can see — the result or
// the error, the trace and its hand-overs, the resolver's requests, and every
// call each adapter received, in order and key for key — is held to a
// snapshot read for correctness when it was recorded (compared as JSON text,
// so the order of an argument object's keys is held too).

import {
  fromCatalogSnapshot,
  mockCatalogSnapshot,
  parseTraversalPath,
  refinementKey,
  type InstanceSchema,
  type LanguageVersion,
} from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';

import { evaluatePredicate } from '#shared/expression/filter';
import type { Expression } from '#shared/expression/types';
import type {
  Adapter,
  GetRelatedInput,
  RelatedResult,
} from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type { ParkedScopeState } from '../serialize';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import {
  META_RECORD_TYPE,
  makeStablePosition,
  makeUnstablePosition,
  positionData,
  positionRecordId,
} from '../../translation_graph/types';
import { MovementEngineError } from '../errors';
import type { MovementTraceEntry } from '../expression';
import {
  MovementRunFailed,
  resumeMovement,
  runFailureCause,
  runMovement,
  type MovementRunResult,
} from '../run';
import {
  resetRustRunStats,
  rustRunStats,
} from '../rust_stats';
import {
  credentialIdsFor,
  makeFakeParkSink,
  makeTestHost,
  recordingWriteLocks,
} from '../test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000c4');

const emailSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { subject: 'text', text: 'text' },
      edges: { attachments: { target: 'attachment' } },
    },
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
/** The same WHERE as version 5 spells it: a field is read through the hop's alias. */
const NARROWED_V5 = 'le.`listName` == "Portfolio"';
function selectionKey(where: string, version?: 5): string {
  const steps =
    version === 5
      ? parseTraversalPath(`-[le:list_entries WHERE ${where}]->`, 5)
      : parseTraversalPath(`-[:list_entries WHERE ${where}]->`);
  const filter = steps?.[0]?.type === 'edge' ? steps[0].expressionFilter : undefined;
  if (!filter) throw new Error(`test setup: no filter parsed out of \`${where}\``);
  return refinementKey({ type: 'list_entry', filter });
}

const graphSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', stage: 'text', revenue: 'number', note: 'text' },
      edges: {
        deals: { target: 'deal' },
        list_entries: { target: 'list_entry', polymorphic: true },
      },
    },
    list_entry: { properties: { listName: 'text' }, edges: {} },
    [MASTER]: { properties: { listName: 'text' }, edges: {} },
    [HANDOVER]: { properties: { listName: 'text' }, edges: {} },
    'list_entry "Portfolio"': { properties: { listName: 'text' }, edges: {} },
    deal: { properties: { title: 'text', stage: 'text' }, edges: {} },
    lead: { properties: { name: 'text', score: 'number' }, edges: {} },
    note: { properties: { text: 'text' }, edges: {} },
  },
  collections: {
    company: { target: 'company' },
    lead: { target: 'lead' },
    note: { target: 'note' },
    deal: { target: 'deal' },
  },
  writableRoots: {
    note: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    deal: { fields: { title: 'text' }, resultShape: { externalId: 'text', title: 'text' } },
  },
  refinements: {
    [selectionKey(NARROWED)]: 'list_entry "Portfolio"',
    [selectionKey(NARROWED_V5, 5)]: 'list_entry "Portfolio"',
  },
  selectedMembers: { [selectionKey(NARROWED)]: MASTER, [selectionKey(NARROWED_V5, 5)]: MASTER },
};

const catalog = mockCatalogSnapshot({
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: emailSchema,
    },
    graph: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: graphSchema,
    },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, graph_main: { adapters: ['graph'] } },
});

/** The program as `version` spells it: one text, written in the spelling
 *  versions 1–4 read, respelled by the upgrade tool for a version-5 run. */
const programFor = (
  version: LanguageVersion,
  body: string,
  v5Edits: ReadonlyArray<readonly [string, string]> = [],
): string => {
  const edited =
    version >= 5 ? v5Edits.reduce((text, [from, to]) => text.replace(from, to), body) : body;
  return spelledFor(
    version,
    `${PRELUDE}movement m(msg: <inbox-[:message]->>) {\n${edited}\n}`,
    fromCatalogSnapshot(catalog),
  );
};

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
  for (const [type, rows] of Object.entries(collections))
    for (const row of rows) byId.set(row.id, { ...row, type });
  const position = (row: Row & { type: string }) =>
    options.unstable === true
      ? makeUnstablePosition({ adapterType: 'graph', recordType: row.type, data: row.fields })
      : makeStablePosition({ adapterType: 'graph', recordType: row.type, recordId: row.id });
  const related = (read: GetRelatedInput): RelatedResult[] => {
    const rows =
      read.position.recordType === META_RECORD_TYPE
        ? (collections[read.fieldId] ?? []).map((row) => byId.get(row.id)!)
        : (
            options.links?.[`${positionRecordId(read.position) ?? ''}/${read.fieldId}`] ??
            options.edges?.[read.fieldId] ??
            []
          ).map((id) => byId.get(id)!);
    let kept = rows;
    if (options.honours === true) {
      if (read.where !== undefined) {
        const where: Expression = read.where;
        kept = kept.filter((row) =>
          Boolean(evaluatePredicate(where, { read: (name) => row.fields[name] })),
        );
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
      return {
        position: position(row),
        ...(edgeProperties !== undefined ? { edgeProperties } : {}),
      };
    });
  };
  const streaming = options.pageSize !== undefined;
  const pageSize = options.pageSize ?? 0;
  const adapter: Adapter = {
    adapterType: 'graph',
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: {
        incoming: options.traversal?.incoming ?? false,
        edgeProperties: options.traversal?.edgeProperties ?? false,
      },
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
      const failing = typeof options.failOn === 'string' ? [options.failOn] : options.failOn ?? [];
      if (id !== undefined && (failing.includes(id) || failing.includes(`${id}/${input.fieldId}`)))
        throw new Error(`graph: ${id} is unreadable`);
      if (id !== undefined) return byId.get(id)?.fields[input.fieldId] ?? null;
      return (
        (positionData(input.position) as Record<string, unknown> | undefined)?.[input.fieldId] ??
        null
      );
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
            if (options.stuckCursor === true && cursor !== undefined)
              return { items: all.slice(from, next), nextCursor: cursor };
            return {
              items: all.slice(from, next),
              ...(next < all.length ? { nextCursor: next } : {}),
            };
          },
        }
      : {}),
    async createRecord(input) {
      calls.push(['createRecord', input]);
      return { adapterType: 'graph', externalId: `new-${calls.length}`, data: {} };
    },
    async updateRecord(input) {
      calls.push(['updateRecord', input]);
      return {
        adapterType: 'graph',
        externalId: input.externalId,
        data: {},
        association: containerAssociation(input),
      };
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
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      calls.push(['getFieldValue', input]);
      return (
        (positionData(input.position) as Record<string, unknown> | undefined)?.[input.fieldId] ??
        null
      );
    },
    async getRelated(read) {
      calls.push(['getRelated', read]);
      return ['a-1', 'a-2'].map((id) => ({
        position: makeStablePosition({
          adapterType: 'email',
          recordType: 'attachment',
          recordId: id,
        }),
      }));
    },
    createRecord: async () => ({ adapterType: 'email', externalId: 'x', data: {} }),
    updateRecord: async (input) => ({
      adapterType: 'email',
      externalId: input.externalId,
      data: {},
      association: containerAssociation(input),
    }),
    deleteRecord: async () => ({}),
  };
  return { adapter, calls };
}

function webhook(payload: Record<string, unknown>): TriggerEvent {
  return {
    pipelineInputId: 'pi-rust-traverse',
    adapterType: 'email',
    triggerType: 'webhook',
    payload,
  };
}

interface Case {
  body: string;
  event?: TriggerEvent;
  graph?: GraphOptions;
  costCapMicrodollars?: number;
  suspendAt?: readonly string[];
  /** A fresh hold for each run (see `holdingRead`). */
  hold?: () => HeldRead;
  /** Text the upgrade tool cannot respell, written for version 5 instead:
   *  each pair replaces the first occurrence in the body before a version-5 run. */
  v5Edits?: ReadonlyArray<readonly [string, string]>;
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

async function runOn(c: Case): Promise<Outcome> {
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
      source: programFor(5, c.body, c.v5Edits),
      event: c.event ?? webhook({ subject: 'Seed', text: 'Late' }),
      teamId: TEAM_ID,
      catalog,
      credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
      firedAt: '2026-05-01T09:00:00.000Z',
      dryRun: true,
      ...(c.costCapMicrodollars !== undefined
        ? { costCapMicrodollars: c.costCapMicrodollars }
        : {}),
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
  }
}

/** A rehearsal mints random ids: each run's, in the order they appear, read
 *  as the same placeholders. */
function sameIds<T>(value: T): T {
  const ids = new Map<string, string>();
  const text = JSON.stringify(value);
  const normal = text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    (id) => {
      if (!ids.has(id)) ids.set(id, `uuid-${ids.size + 1}`);
      return ids.get(id)!;
    },
  );
  return JSON.parse(normal) as T;
}

/** One run on the Rust engine: run whole, and what
 *  the hosts saw and what the run handed back (or how it failed) held to the
 *  recorded snapshot, read for correctness when it was recorded. */
async function onRust(c: Case) {
  resetRustRunStats();
  const rust = await runOn(c);
  expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
  const world = ({ failed: _failed, result: _result, error: _error, ...rest }: Outcome) => rest;
  expect(
    sameIds({
      world: world(rust),
      failed: rust.failed ? String(rust.error) : false,
      result: rust.result,
    }),
  ).toMatchSnapshot();
  return { rust };
}

const written = (o: Outcome) => o.captured.map((w) => w.fields?.text);
const calls = (o: Outcome, which: 'graph' | 'email' = 'graph') =>
  JSON.parse(o[which]) as Array<[string, Record<string, unknown>]>;

const BRACKET = 'company WHERE `stage` == "Seed" ORDER BY `revenue` DESC LIMIT 2';
/** The same bracket, as the run's version-5 text quotes it in its trace. */
const BRACKET_V5 = 'company WHERE c.`stage` == "Seed" ORDER BY c.`revenue` DESC LIMIT 2';
const NOTE_PER_COMPANY = (bracket: string) =>
  `  kg-[c:${bracket}]-> {\n    write kg-[:note]-> { text: c.\`name\` }\n  }`;

describe('traversal blocks in the Rust engine', () => {
  it('pushes the WHERE, ORDER BY and LIMIT and filters, sorts and slices what comes back, as the TypeScript engine does', async () => {
    const { rust } = await onRust({ body: NOTE_PER_COMPANY(BRACKET) });
    expect(written(rust)).toEqual(['Globex', 'Umbrella']);
    const [method, fetch] = calls(rust).find(([m]) => m === 'getRelated')!;
    expect(method).toBe('getRelated');
    expect(Object.keys(fetch)).toEqual([
      'position',
      'fieldId',
      'direction',
      'where',
      'orderBy',
      'limit',
    ]);
    expect(fetch).toMatchObject({
      fieldId: 'company',
      direction: 'outgoing',
      orderBy: { fieldId: 'revenue', direction: 'desc' },
      limit: 2,
    });
    expect(rust.trace).toContainEqual({
      kind: 'block',
      root: `kg-[c:${BRACKET_V5}]->`,
      positions: 2,
    });
  });

  it('answers the same records in the same order whether the adapter honours the pushdown or filters nothing', async () => {
    const local = await onRust({ body: NOTE_PER_COMPANY(BRACKET) });
    const pushed = await onRust({ body: NOTE_PER_COMPANY(BRACKET), graph: { honours: true } });
    expect(written(pushed.rust)).toEqual(written(local.rust));
    const fetch = (o: Outcome) => calls(o).find(([m]) => m === 'getRelated')?.[1];
    expect(fetch(pushed.rust)).toEqual(fetch(local.rust));
    // The adapter that honoured it answered two; the engine read the WHERE
    // and the key off those two only.
    const reads = (o: Outcome) => calls(o).filter(([m]) => m === 'getFieldValue').length;
    expect(reads(pushed.rust)).toBeLessThan(reads(local.rust));
  });

  it('orders by a key that is not a bare field locally, asking the adapter for neither the sort nor the limit', async () => {
    const { rust } = await onRust({
      body: NOTE_PER_COMPANY('company ORDER BY LOWER(c.`name`) DESC LIMIT 3'),
    });
    expect(written(rust)).toEqual(['Umbrella', 'Initech', 'Hooli']);
    const fetch = calls(rust).find(([m]) => m === 'getRelated')?.[1];
    expect(fetch).not.toHaveProperty('orderBy');
    expect(fetch).not.toHaveProperty('limit');
  });

  it('closes the pushed WHERE over the values the scope holds, an event field read before the fetch', async () => {
    const { rust } = await onRust({
      body:
        '  wanted = msg.`subject`\n' +
        NOTE_PER_COMPANY(
          'company WHERE `stage` == wanted AND c.`name` != msg.`text` AND `revenue` >= 10',
        ),
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
    await onRust({ body: NOTE_PER_COMPANY('company WHERE `stage` == "Late" AND `revenue` > 1') });
    await onRust({ body: NOTE_PER_COMPANY('company WHERE `stage` == "Late" OR `revenue` > 25') });
    const impure = await onRust({ body: NOTE_PER_COMPANY('company WHERE UPPER(`name`) == "ACME"') });
    expect(written(impure.rust)).toEqual(['Acme']);
    expect(calls(impure.rust).find(([m]) => m === 'getRelated')?.[1]).not.toHaveProperty('where');
  });

  it('runs no body for an empty traversal', async () => {
    const { rust } = await onRust({ body: NOTE_PER_COMPANY('company WHERE `stage` == "Nowhere"') });
    expect(written(rust)).toEqual([]);
    expect(rust.trace).toEqual([
      { kind: 'block', root: 'kg-[c:company WHERE c.`stage` == "Nowhere"]->', positions: 0 },
    ]);
    const none = await onRust({
      body: NOTE_PER_COMPANY('lead'),
      graph: { collections: { company: COMPANIES } },
    });
    expect(written(none.rust)).toEqual([]);
  });

  it('traces the field a raw-payload landing does not carry, once, as the TypeScript engine does', async () => {
    // `note` is the schema's, and no record's payload carries it.
    const { rust } = await onRust({
      body: NOTE_PER_COMPANY('company WHERE `note` == null'),
      graph: { unstable: true },
    });
    expect(written(rust)).toHaveLength(5);
    expect(rust.trace.filter((e) => (e as { kind: string }).kind === 'field_miss')).toEqual([
      { kind: 'field_miss', binding: 'kg', field: 'note', available: ['name', 'stage', 'revenue'] },
    ]);
  });

  it('walks a streamed traversal a page at a time, filtering each page before it asks for the next', async () => {
    const { rust } = await onRust({ body: NOTE_PER_COMPANY(BRACKET), graph: { pageSize: 2 } });
    expect(written(rust)).toEqual(['Globex', 'Umbrella']);
    const pages = calls(rust).filter(([m]) => m === 'iterateRelatedPage');
    expect(pages.map(([, p]) => p.cursor ?? null)).toEqual([null, 2, 4]);
    // The first page's records are read before the second page is asked for.
    expect(
      calls(rust)
        .map(([m]) => m)
        .slice(0, 4),
    ).toEqual(['iterateRelatedPage', 'getFieldValue', 'getFieldValue', 'iterateRelatedPage']);
  });

  it('fails a paged traversal whose server hands its cursor back, with the TypeScript engine’s error', async () => {
    const { rust } = await onRust({
      body: NOTE_PER_COMPANY('company'),
      graph: { pageSize: 2, stuckCursor: true },
    });
    expect(String(runFailureCause(rust.error))).toContain(
      'paged traversal: the page for cursor 2 answered the same cursor again',
    );
  });

  it('walks off the event and off a write handle, each from its own position', async () => {
    const offEvent = await onRust({
      body: '  msg-[a:attachments]-> {\n    write kg-[:note]-> { text: a.`name` }\n  }',
    });
    expect(offEvent.rust.captured).toHaveLength(2);
    const offHandle = await onRust({
      body: '  co = write kg-[:company]-> { name: "Acme" }\n  co-[d:deals]-> {\n    write kg-[:note]-> { text: d.`title` }\n  }',
      graph: {
        collections: { company: COMPANIES, deal: [{ id: 'd-1', fields: { title: 'Seed round' } }] },
        edges: { deals: ['d-1'] },
      },
    });
    expect(written(offHandle.rust)).toEqual([undefined, 'Seed round']);
    // From the handle's own record, stamped with its type.
    const fetch = calls(offHandle.rust).find(([m]) => m === 'getRelated')?.[1];
    expect(fetch?.position).toMatchObject({
      adapterType: 'graph',
      recordType: 'company',
      identity: { kind: 'stable' },
    });
  });

  it('runs each body at its own address with its own scope, in order', async () => {
    const { rust } = await onRust({
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

  it('suspends inside a block where the TypeScript engine suspends: a capped run and a suspendAt address', async () => {
    for (const c of [
      { body: NOTE_PER_COMPANY('company'), costCapMicrodollars: 1_000 },
      { body: NOTE_PER_COMPANY('company'), suspendAt: ['s0.i1.s0'] },
    ]) {
      await onRust(c);
    }
  });

  it('drops the records of the members a narrowed hop is not about, before reading their fields', async () => {
    const { rust } = await onRust({
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
    expect(
      calls(rust).filter(
        ([m, input]) => m === 'getFieldValue' && JSON.stringify(input).includes('le-2'),
      ),
    ).toEqual([]);
  });

  it('runs two blocks that reuse a hop alias and a body name, each in its own scope', async () => {
    const block = (where: string) =>
      `  kg-[c:company WHERE ${where}]-> {\n    n = c.\`name\`\n    write kg-[:note]-> { text: n }\n  }`;
    const { rust } = await onRust({
      body: `${block('`stage` == "Late"')}\n${block('`revenue` == 10')}`,
    });
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
      const { rust } = await onRust({ body: NESTED, graph: graph() });
      expect(written(rust)).toEqual([
        'co Acme',
        'Acme: Series A!',
        'Acme: Seed round',
        'end Acme',
        'co Globex',
        'end Globex',
        'co Initech',
        'Initech: Series A!',
        'end Initech',
        'co Umbrella',
        'end Umbrella',
        'done',
      ]);
      // Each nested walk starts at its own landing's position.
      const origins = calls(rust)
        .filter(([m, input]) => m === 'getRelated' && input.fieldId === 'deals')
        .map(([, input]) => positionRecordId(input.position as never));
      expect(origins).toEqual(['n-1', 'n-2', 'n-3', 'n-5']);
      expect(rust.trace).toContainEqual({
        kind: 'block',
        root: 'c-[d:deals WHERE d.`title` != "Bridge" ORDER BY d.`title` DESC]->',
        positions: 2,
      });
    });

    it('fails mid-fan-out where the TypeScript engine does, keeping the writes before it', async () => {
      const { rust } = await onRust({ body: NESTED, graph: graph({ failOn: 'd-3' }) });
      expect(rust.failed).toBe(true);
      expect(String(runFailureCause(rust.error))).toContain('graph: d-3 is unreadable');
      expect(rust.error instanceof MovementRunFailed ? rust.error.partial.writes.length : -1).toBe(
        5,
      );
    });

    it('fails in an inner iteration’s body after the one before it wrote, as the TypeScript engine does', async () => {
      // The inner WHERE reads `title`; only the body reads `stage`, so the
      // failure is d-1's body, after d-2's iteration wrote.
      const body = NESTED.replace(
        '      t = d.`title`',
        '      t = d.`title`\n      s = d.`stage`',
      );
      const { rust } = await onRust({ body, graph: graph({ failOn: 'd-1/stage' }) });
      expect(String(runFailureCause(rust.error))).toContain('graph: d-1 is unreadable');
      expect(
        rust.error instanceof MovementRunFailed
          ? rust.error.partial.writes.map((w) => w.writtenValues.text)
          : [],
      ).toEqual(['co Acme', 'Acme: Series A!']);
    });
  });

  describe('bound blocks', () => {
    it('binds what the iterations return as one list, its trail the union of theirs', async () => {
      const { rust } = await onRust({
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
      const { rust } = await onRust({
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

  it('runs an ORDER BY over more than 64 records whose keys mix numbers and text whole, landing them where V8 lands them', async () => {
    // Numbers at even places, their texts at odd: a comparator no total
    // order agrees with, so V8's TimSort alone decides the order, here as in
    // the TypeScript engine, frozen in crates/movement-engine/tests/frozen/mixed_sort.jsonl.
    const rows: Row[] = Array.from({ length: 65 }, (_, i) => ({
      id: `m-${i}`,
      fields: { name: `co ${i}`, revenue: i % 2 === 0 ? i : `${i}` },
    }));
    const graph = { collections: { company: rows } };
    const { rust } = await onRust({ body: NOTE_PER_COMPANY('company ORDER BY `revenue`'), graph });
    expect(written(rust)).toHaveLength(65);
    await onRust({
      body: `  write kg-[:note]-> { text: "first" }\n${NOTE_PER_COMPANY('company ORDER BY `revenue`')}`,
      graph,
    });
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
      const { rust } = await onRust({ body: body('`role` == "lead"'), graph: graph(true) });
      expect(written(rust)).toEqual([undefined, 'Seed round', 'Bridge']);
    });

    it('leaves a bare name alone in the pushed WHERE when the edge can carry it, and closes over the binding when it cannot', async () => {
      const where = (o: Outcome) =>
        JSON.stringify(calls(o).find(([m]) => m === 'getRelated')?.[1].where);
      const carried = await onRust({ body: body('`role` == "lead"'), graph: graph(true) });
      expect(where(carried.rust)).not.toContain(
        '{"type":"static","value":"lead"},{"type":"static"',
      );
      expect(where(carried.rust)).toContain('role');
      const closed = await onRust({ body: body('`role` == "lead"'), graph: graph(false) });
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
  const fetches = (o: Outcome) =>
    calls(o)
      .filter(([m]) => m === 'getRelated')
      .map(([, input]) => input);

  // Review Focus 4: a hop's WHERE the adapter honours, and one it cannot be
  // handed, answer the same records, and ask with the same arguments.
  describe('COUNT and FIRST over a traversal', () => {
    const PUSHED = 'company WHERE `stage` == "Seed" ORDER BY `revenue` DESC LIMIT 2';
    const LOCAL = 'company WHERE UPPER(`stage`) == "SEED" ORDER BY c.`revenue` + 0 DESC LIMIT 2';
    const body = (bracket: string) =>
      [
        `  n = COUNT(kg-[c:${bracket}]->)`,
        `  top = FIRST(kg-[c:${bracket}]->)`,
        `  names = JOIN(kg-[c:${bracket}]->.\`name\`, ", ")`,
        '  write kg-[:note]-> { text: "${n} ${top.`name`} ${names}" }',
      ].join('\n');

    it('answers the same whether the adapter honours the pushed WHERE or not, asking it the same', async () => {
      const local = await onRust({ body: body(PUSHED) });
      const pushed = await onRust({ body: body(PUSHED), graph: { honours: true } });
      expect(written(local.rust)).toEqual(['2 Globex Globex, Umbrella']);
      expect(written(pushed.rust)).toEqual(written(local.rust));
      expect(fetches(pushed.rust)).toEqual(fetches(local.rust));
      expect(fetches(local.rust)).toHaveLength(3);
      expect(fetches(local.rust)[0]).toMatchObject({
        fieldId: 'company',
        orderBy: { fieldId: 'revenue', direction: 'desc' },
        limit: 2,
      });
    });

    it('filters, orders and bounds locally a WHERE no adapter can be handed, with the same answer', async () => {
      const local = await onRust({ body: body(LOCAL) });
      expect(written(local.rust)).toEqual(['2 Globex Globex, Umbrella']);
      for (const fetch of fetches(local.rust)) {
        expect(fetch).not.toHaveProperty('where');
        expect(fetch).not.toHaveProperty('limit');
      }
    });

    it('walks a streaming instance with one getRelated per hop, as an expression does', async () => {
      const { rust } = await onRust({ body: body(PUSHED), graph: { pageSize: 2 } });
      // The pick walks as a block head does, a page at a time; the count and
      // the projection, as an expression does, in one getRelated each.
      expect(calls(rust).filter(([m]) => m === 'iterateRelatedPage')).toHaveLength(3);
      expect(fetches(rust)).toHaveLength(2);
    });

    it('picks the last and the only record, binds null when there is none, and fails ONLY over two', async () => {
      const last = await onRust({
        body: '  top = LAST(kg-[c:company WHERE `stage` == "Seed" ORDER BY `name`]->)\n  write kg-[:note]-> { text: COALESCE(top.`name`, "none") }',
      });
      expect(written(last.rust)).toEqual(['Umbrella']);
      const none = await onRust({
        body: '  top = FIRST(kg-[c:company WHERE `stage` == "Gone" ORDER BY `name`]->)\n  if top == null { ERROR("no company matched") }',
      });
      expect(String(runFailureCause(none.rust.error))).toContain('no company matched');
      const two = await onRust({
        body: '  co = ONLY(kg-[c:company WHERE `stage` == "Late" OR `revenue` == 30]->)',
      });
      expect(String(runFailureCause(two.rust.error))).toContain(
        'says there is exactly one, and there are 2',
      );
      const one = await onRust({
        body: '  co = ONLY(kg-[c:company WHERE `name` == "Initech"]->)\n  if EXISTS(co) {\n    write kg-[:note]-> { text: COALESCE(co.`name`, "?") }\n  }',
        graph: withDeals(),
      });
      expect(one.rust.captured).toHaveLength(1);
    });

    it('counts from a landed record, a hop alias read in the WHERE and the ORDER BY key a walk of its own', async () => {
      await onRust({
        body: '  kg-[c:company]-> {\n    write kg-[:note]-> { text: "${COUNT(c-[d:deals WHERE d.`stage` != "lost"]->)}" }\n  }',
        graph: withDeals(),
      });
      await onRust({
        body: '  write kg-[:note]-> { text: JOIN(kg-[c:company ORDER BY c-[:deals]->.`title` DESC LIMIT 2]->.`name`, ",") }',
        graph: withDeals(),
      });
    });
  });

  describe('EXISTS', () => {
    it('asks one getRelated per subject and hop, and reads the WHERE until a record holds it', async () => {
      const { rust } = await onRust({
        body: [
          '  co = write kg-[:company]-> { name: "Newco" }',
          '  if EXISTS(co-[:deals]->) { write kg-[:note]-> { text: "any" } }',
          '  if EXISTS(co-[d:deals WHERE `title` == "Seed round"]->) { write kg-[:note]-> { text: "seed" } }',
          '  if NOT EXISTS(co-[d:deals WHERE `title` == "Nope"]->) { write kg-[:note]-> { text: "none" } }',
          '  if EXISTS(kg-[c:company WHERE `stage` == "Late"]-> WHERE `revenue` > 40) { write kg-[:note]-> { text: "late" } }',
          '  if EXISTS(kg-[c:company]->-[d:deals WHERE `stage` == "won"]->) { write kg-[:note]-> { text: "won" } }',
          '  if EXISTS(msg-[:attachments]->) { write kg-[:note]-> { text: "files" } }',
        ].join('\n'),
        // Version 5 writes a walk's filter inside its last hop, whole.
        v5Edits: [
          [
            'kg-[c:company WHERE `stage` == "Late"]-> WHERE `revenue` > 40',
            'kg-[c:company WHERE `stage` == "Late" AND `revenue` > 40]->',
          ],
        ],
        graph: withDeals(),
      });
      expect(written(rust)).toEqual([undefined, 'any', 'seed', 'none', 'late', 'won', 'files']);
      expect(fetches(rust)).toHaveLength(fetches(rust).length);
    });

    it('asks whether a value holds one, and tests a candidate of a target WHERE', async () => {
      await onRust({
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
    const { rust } = await onRust({
      body: [
        '  xs = [3, null, "4", 1]',
        '  rows = [{ n: "b", s: 2 }, { n: "a", s: 9 }, { n: "c" }]',
        '  write kg-[:note]-> { text: "${COUNT(xs)} ${SUM(xs)} ${AVG(xs)} ${MIN([2, 0, 5])} ${MAX(xs)} ${FIRST(xs)} ${LAST(xs)} ${JOIN(xs, "/")} ${COUNT(COLLECT(7))}" }',
        '  write kg-[:note]-> { text: JOIN(SORT(["b", "a", "c"], DESC), "") }',
        '  write kg-[:note]-> { text: JOIN(MAP_NAMES, "") }'.replace(
          'MAP_NAMES',
          'SORT([2, 10, 1])',
        ),
        '  ranked = SORT(rows, `s`, DESC)',
        '  r0 = AT(ranked, 0)',
        '  r1 = AT(ranked, 1)',
        '  r2 = AT(ranked, 2)',
        '  pair = [null, 5]',
        '  write kg-[:note]-> { text: "${r0.n}${r1.n}${r2.n} ${ONLY(pair)}" }',
      ].join('\n'),
      // Version 5 refuses SUM, AVG and MAX over a list that may hold an absent member.
      v5Edits: [
        ['${SUM(xs)} ${AVG(xs)}', '${SUM(filter(xs, (x) => x != null))} ${AVG(filter(xs, (x) => x != null))}'],
        ['${MAX(xs)}', '${MAX(filter(xs, (x) => x != null))}'],
      ],
    });
    // `count` counts the empty item too under 5 (the one in `xs`); COUNT skipped it before.
    expect(written(rust)).toEqual(['4 8 2.6666666666666665 0 4 3 1 3/4/1 1', 'cba', '1210', 'abc 5']);
    const only = await onRust({ body: '  xs = [1, 2]\n  x = ONLY(xs)' });
    expect(String(runFailureCause(only.rust.error))).toContain(
      'ONLY(xs) says there is exactly one, and there are 2.',
    );
  });

  it("measures a WITHIN from the host's clock, a value's, a condition's and a hop's WHERE's alike", async () => {
    const body = [
      '  if "2025-12-30" WITHIN "7d" {',
      '    write kg-[:note]-> { text: "recent" }',
      '  }',
      '  if "2025-12-20" WITHIN "7d" {',
      '    write kg-[:note]-> { text: "stale" }',
      '  }',
      '  x = msg.`subject` WITHIN "7d"',
      '  write kg-[:note]-> { text: "${x}" }',
      '  kg-[c:company WHERE `revenue` WITHIN "99999w"]-> {',
      '    write kg-[:note]-> { text: c.`name` }',
      '  }',
    ].join('\n');
    const { rust } = await onRust({ body });
    expect(written(rust)).toEqual(['recent', 'false', 'Acme', 'Globex', 'Initech', 'Umbrella']);
    // The hop's WHERE is pure, so it is handed to the adapter as the
    // TypeScript hands it; the engine decides it itself all the same.
    expect(
      calls(rust).filter(([m, input]) => m === 'getRelated' && input.where !== undefined),
    ).toHaveLength(1);
  });

  it("ranks by a SORT key of any form, read in each member's scope, records and maps alike", async () => {
    const { rust } = await onRust({
      body: [
        '  cs = kg-[c:company]->',
        '  byName = SORT(cs, LOWER(`name`), DESC)',
        '  byRevenue = SORT(cs, COALESCE(`revenue`, 0) * -1)',
        '  rows = [{ n: "b", s: 2 }, { n: "a", s: 9 }, { n: "c" }]',
        '  ranked = SORT(rows, COALESCE(`s`, 0) * -1)',
        '  write kg-[:note]-> { text: JOIN(MAP(byName, (c) => c.`name`), ",") }',
        '  write kg-[:note]-> { text: JOIN(MAP(byRevenue, (c) => c.`name`), ",") }',
        '  write kg-[:note]-> { text: JOIN(MAP(ranked, (r) => r.n), ",") }',
      ].join('\n'),
      // Version 5 gives SORT its key as a function.
      v5Edits: [
        [
          'SORT(cs, LOWER(`name`), DESC)',
          'sort(cs, (c) => Text.lower(c.`name`), { order: "desc" })',
        ],
        ['SORT(cs, COALESCE(`revenue`, 0) * -1)', 'sort(cs, (c) => coalesce(c.`revenue`, 0) * -1)'],
        ['SORT(rows, COALESCE(`s`, 0) * -1)', 'sort(rows, (r) => coalesce(r.s, 0) * -1)'],
      ],
    });
    expect(written(rust)).toEqual([
      'Umbrella,Initech,Hooli,Globex,Acme',
      'Initech,Globex,Umbrella,Acme,Hooli',
      'a,b,c',
    ]);
  });

  it('reads a second name for the event, a landing and a handle as the record it names', async () => {
    await onRust({
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

  it('parks a picked record, and the event named twice', async () => {
    const body = [
      '  top = FIRST(kg-[c:company WHERE `stage` == "Seed" ORDER BY `name`]->)',
      '  m2 = msg',
      '  await sleep(1h)',
      '  write kg-[:note]-> { text: COALESCE(top.`name`, m2.`subject`) }',
    ].join('\n');
    resetRustRunStats();
    const park = makeFakeParkSink();
    const graph = fakeGraph();
    await runMovement({
      source: programFor(5, body),
      languageVersion: 5,
      event: webhook({ subject: 'Seed', text: 'Late' }),
      teamId: TEAM_ID,
      catalog,
      credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
      firedAt: '2026-05-01T09:00:00.000Z',
      host: makeTestHost({
        adapters: {
          resolve: (request) =>
            request.adapterType === 'graph' ? graph.adapter : fakeEmail().adapter,
        },
        park: { sink: park.sink },
      }),
    });
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
    expect(park.timerParks).toHaveLength(1);
    const state = JSON.stringify(park.timerParks[0]?.state);
    expect(state).toContain('"top":{"kind":"sourcePosition"');
    expect(state).toContain('"read":{"instanceName":"kg"}');
    expect(graph.calls).toMatchSnapshot();
  });

  // Henry's ruling (2026-10-15): the event in a graph literal is held as the
  // record it is, by reference, as any other record there is.
  it('holds the event in a graph as its record, read, parked and resumed', async () => {
    const before = [
      '  g = graph { title: "t", owner: msg, inner: { from: msg } }',
      '  g-[o:owner]-> {',
      '    write kg-[:note]-> { text: "${g.`title`} ${o.`subject`}" }',
      '  }',
    ];
    const after = [
      '  g-[i:inner]->-[f:from]-> {',
      '    write kg-[:note]-> { text: f.`text` }',
      '  }',
    ];
    const whole = await onRust({ body: [...before, ...after].join('\n') });
    expect(written(whole.rust)).toEqual(['t Seed', 'Late']);

    const body = [...before, '  await sleep(1h)', ...after].join('\n');
    const base = {
      source: programFor(5, body),
      languageVersion: 5 as const,
      event: webhook({ subject: 'Seed', text: 'Late' }),
      teamId: TEAM_ID,
      catalog,
      credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
      firedAt: '2026-05-01T09:00:00.000Z',
    };
    const hostFor = (park: ReturnType<typeof makeFakeParkSink>) => {
      const graph = fakeGraph();
      return makeTestHost({
        adapters: {
          resolve: (request) =>
            request.adapterType === 'graph' ? graph.adapter : fakeEmail().adapter,
        },
        park: { sink: park.sink },
      });
    };
    resetRustRunStats();
    const park = makeFakeParkSink();
    await runMovement({ ...base, host: hostFor(park) });
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
    expect(park.timerParks).toHaveLength(1);
    const result = await resumeMovement({
      ...base,
      state: JSON.parse(JSON.stringify(park.timerParks[0]?.state)) as ParkedScopeState,
      host: hostFor(makeFakeParkSink()),
    });
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]?.writtenValues).toEqual({ text: 'Late' });
  });

  it('tests a record IS of a kind, from the run alone', async () => {
    const { rust } = await onRust({
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
// A walk off a name holding a value starts from the records the value
// holds, exactly as a walk off the event or a block's landing does: one
// record is itself, a list its record members. Anything else in it (nothing,
// a text) holds no record, so contributes nothing to walk from.
describe('a walk off a value starts from the records it holds', () => {
  const withDeals: GraphOptions = {
    collections: { company: COMPANIES, deal: [
      { id: 'd-1', fields: { title: 'Seed round', stage: 'open' } },
      { id: 'd-2', fields: { title: 'Series A', stage: 'won' } },
    ] },
    links: { 'n-1/deals': ['d-1', 'd-2'], 'n-2/deals': ['d-2'] },
  };

  it('walks from a picked record and from each record of a kept walk', async () => {
    const { rust } = await onRust({
      body: [
        '  top = FIRST(kg-[c:company WHERE `stage` == "Seed" ORDER BY `name`]->)',
        '  rows = kg-[c:company WHERE `stage` == "Seed"]->',
        '  if top != null {',
        '    n = COUNT(top-[:deals]->)',
        '    titles = JOIN(top-[d:deals ORDER BY `title`]->.`title`, ",")',
        '    won = EXISTS(top-[d:deals WHERE `stage` == "won"]->)',
        '    write kg-[:note]-> { text: "${n} ${titles} ${won} ${COUNT(rows-[:deals]->)}" }',
        '  }',
      ].join('\n'),
      graph: withDeals,
    });
    expect(rust.error).toBeUndefined();
    expect(written(rust)).toEqual(['2 Seed round,Series A true 3']);
  });

  it('finds nothing from a kept walk that found nothing', async () => {
    const { rust } = await onRust({
      body: [
        '  rows = kg-[c:company WHERE `stage` == "Gone"]->',
        '  write kg-[:note]-> { text: "${COUNT(rows-[:deals]->)} ${EXISTS(rows-[:deals]->)} ${EXISTS(rows-[d:deals WHERE `stage` == "won"]->)}" }',
      ].join('\n'),
      graph: withDeals,
    });
    expect(rust.error).toBeUndefined();
    expect(written(rust)).toEqual(['0 false false']);
  });

  it('walks from the records of a list that holds other values too', async () => {
    const { rust } = await onRust({
      body: [
        '  acme = ONLY(kg-[c:company WHERE `name` == "Acme"]->)',
        '  both = [acme, msg.`subject`, null]',
        '  write kg-[:note]-> { text: "${EXISTS(both-[:deals]->)} ${COUNT(both-[:deals]->)}" }',
      ].join('\n'),
      graph: withDeals,
    });
    expect(rust.error).toBeUndefined();
    expect(written(rust)).toEqual(['true 2']);
  });
});

describe("5A's engine fixes, on both engines", () => {
  it('writes the ledger in program order, iteration by iteration, each record citing its place there', async () => {
    const { rust } = await onRust({
      body: [
        '  kg-[c:company]-> {',
        '    co = write kg-[:company]-> { name: "copy of ${c.`name`}" }',
        '    write kg-[:note]-> { text: co.`name` }',
        '  }',
      ].join('\n'),
    });
    const writes = rust.result?.writes ?? [];
    expect(
      writes.map((w) => `${w.recordType} ${String(w.writtenValues.name ?? w.writtenValues.text)}`),
    ).toEqual(
      COMPANIES.flatMap(({ fields }) => [
        `company copy of ${String(fields.name)}`,
        `note copy of ${String(fields.name)}`,
      ]),
    );
    writes.forEach((write, index) => expect(write.origin?.writeIndex).toBe(index));
  });

  it('resolves the instance every iteration writes once for the segment', async () => {
    const { rust } = await onRust({ body: NOTE_PER_COMPANY('company') });
    expect(written(rust)).toHaveLength(COMPANIES.length);
    const targets = rust.resolved.filter(
      (r) => typeof r === 'object' && r !== null && Reflect.get(r, 'role') === 'target',
    );
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
    const keyReads = (o: Outcome) =>
      calls(o).filter(([m, input]) => m === 'getFieldValue' && input.fieldId === 'name');

    it('issues every key read when one fails, and fails with the TypeScript engine’s error', async () => {
      const { rust } = await onRust({ body: ORDERED, graph: { failOn: 'n-2/name' } });
      expect(String(runFailureCause(rust.error))).toContain('graph: n-2 is unreadable');
      expect(keyReads(rust)).toHaveLength(COMPANIES.length);
    });

    it('does not fail while a sibling of the failed read is still held at the host', async () => {
      const held = holdingRead('n-5/name');
      const { rust } = await onRust({
        body: ORDERED,
        graph: { failOn: 'n-2/name' },
        hold: held.hold,
      });
      expect(held.settledWhileHeld).toEqual([false]);
      expect(String(runFailureCause(rust.error))).toContain('graph: n-2 is unreadable');
    });

    it('fails with the lower index’s error when two reads fail, the higher first', async () => {
      // n-2's read is held and fails on release; n-4's fails at once.
      const held = holdingRead('n-2/name');
      const { rust } = await onRust({
        body: ORDERED,
        graph: { failOn: ['n-2/name', 'n-4/name'] },
        hold: held.hold,
      });
      expect(held.settledWhileHeld).toEqual([false]);
      expect(String(runFailureCause(rust.error))).toContain('graph: n-2 is unreadable');
    });
  });
});
