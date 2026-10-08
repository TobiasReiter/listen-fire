// Writes and parks in the Rust engine (slice 2b), held to the TypeScript
// engine: each program runs under MOVEMENT_ENGINE=ts and =rust against fakes
// of its own, and the two must agree on everything a caller can see — the
// result or the error, the trace, every call each adapter received in order,
// the resolver's requests, the judge's questions, a rehearsal's captured
// writes, the park sink's rows. A park written by either engine resumes on
// the other.

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';

import { RunCostCapExceeded } from '../../../lib/run_cost';
import type { Adapter, ExternalRecordRef } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { MovementTraceEntry } from '../expression';
import type { SchemaTypeDescriptor } from '../../translation_graph/types';
import { makeStablePosition, positionData } from '../../translation_graph/types';
import { credentialIdsFor, makeFakeParkSink, makeTestHost, recordingWriteLocks, type TestHostOverrides } from '../test_host';
import {
  MovementRunFailed,
  resumeMovement,
  runFailureCause,
  runMovement,
  type MovementRunResult,
  type ParkSink,
  type ResumeMovementInput,
  type RunLimitPause,
  type RunMovementInput,
} from '../run';
import { resetRustEvalStats, resetRustRunStats, rustEvalStats, rustRunStats } from '../rust_stats';
import type { ParkedScopeState } from '../serialize';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000b2');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text', missing: 'text', when: 'date', meta: 'json' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const companyFields = {
  name: 'text',
  stage: 'text',
  domain: 'text',
  tags: { kind: 'list', of: 'text' },
  updated: 'datetime',
  blob: 'json',
} as const;

const attioSchema: InstanceSchema = {
  positions: {
    company: { properties: companyFields, edges: { notes: { target: 'note', writable: true } } },
    note: { properties: { body: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: companyFields, resultShape: { externalId: 'text', url: 'text', minted: 'number', ...companyFields }, fuzzyResolution: true },
    note: { fields: { body: 'text' }, resultShape: { externalId: 'text', body: 'text' } },
  },
  supportsInPlaceUpdate: true,
};

const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: attioSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  '',
].join('\n');

interface Store {
  /** What resolveEntity answers for a record. */
  candidates?: (record: Record<string, unknown>) => ExternalRecordRef[];
  /** Current values, by id; absent ⇒ the adapter has no readRecord. */
  current?: Record<string, Record<string, unknown>>;
  describe?: (recordType: string) => SchemaTypeDescriptor | null;
  association?: 'made' | 'already' | 'unsupported';
  failCreate?: string;
  /** The records any traversal lands on, by id. */
  landings?: Record<string, Record<string, unknown>>;
  /** The adapter links existing records. */
  links?: boolean;
}

/** An adapter recording every call it gets, as `[method, input]`. */
function fake(adapterType: string, store: Store = {}) {
  const calls: Array<[string, unknown]> = [];
  let minted = 0;
  const adapter: Adapter = {
    adapterType,
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    async describe(recordType) {
      calls.push(['describe', recordType]);
      return store.describe?.(recordType) ?? null;
    },
    async resolveEntity(input) {
      calls.push(['resolveEntity', input]);
      return { candidates: store.candidates?.(input.record) ?? [] };
    },
    ...(store.current !== undefined
      ? {
          async readRecord(input: { externalId: string }) {
            calls.push(['readRecord', input]);
            return store.current?.[input.externalId] ?? null;
          },
        }
      : {}),
    async getFieldValue(input) {
      calls.push(['getFieldValue', input.fieldId]);
      return (positionData(input.position) as Record<string, unknown> | undefined)?.[input.fieldId];
    },
    async getRelated(read) {
      calls.push(['getRelated', read.fieldId]);
      return Object.entries(store.landings ?? {}).map(([recordId, data]) => ({
        position: makeStablePosition({ adapterType, recordType: 'company', recordId, data }),
      }));
    },
    ...(store.links === true
      ? {
          async linkRecords(input: Parameters<NonNullable<Adapter['linkRecords']>>[0]) {
            calls.push(['linkRecords', input]);
            return { created: true };
          },
        }
      : {}),
    async createRecord(input) {
      calls.push(['createRecord', input]);
      if (store.failCreate !== undefined) throw new Error(store.failCreate);
      minted += 1;
      return { adapterType, externalId: `${adapterType}-${minted}`, url: `https://x/${minted}`, data: { minted } };
    },
    async updateRecord(input) {
      calls.push(['updateRecord', input]);
      const association = store.association ?? containerAssociation(input);
      return { adapterType, externalId: input.externalId, data: { updated: true }, association };
    },
    deleteRecord: async () => ({}),
  };
  return { adapter, calls };
}

function webhook(payload: Record<string, unknown>, extra: Partial<TriggerEvent> = {}): TriggerEvent {
  return { pipelineInputId: 'pi-rust-write', adapterType: 'email', triggerType: 'webhook', payload, ...extra };
}

interface Case {
  source: string;
  event: TriggerEvent;
  attio?: Store;
  dryRun?: boolean;
  /** The judge, given the questions it is asked. */
  judge?: (asked: unknown[]) => NonNullable<TestHostOverrides['llm']>['arbitrateEntities'];
  /** Resume this state rather than run. */
  resume?: ParkedScopeState;
  /** Resume re-entering the parked statement (an operator's limit resume). */
  reenter?: boolean;
  costCapMicrodollars?: number;
  priorSpentMicrodollars?: number;
  capBaselineMicrodollars?: number;
  limitPaused?: boolean;
  suspendAt?: string[];
  /** Which of the sink's suspension methods it has: both by default. */
  suspends?: 'both' | 'suspension_only' | 'neither';
}

/** One run on one engine: what it returned or threw, and everything the
 *  world saw of it. */
/** What one run did: its result or the error it failed with, and the world. */
interface Outcome {
  failed: boolean;
  /** Every `locks.acquire`'s names, in order. */
  locks: string[][];
  result?: MovementRunResult;
  error?: unknown;
  email: Array<[string, unknown]>;
  attio: Array<[string, unknown]>;
  resolved: unknown[];
  trace: unknown[];
  /** The trace as the host was handed it, a statement at a time. */
  appends: unknown[][];
  captured: CapturedWrite[];
  asked: unknown[];
  parks: Array<{ address: string; state: unknown; wakeAt: string }>;
  suspensions: Array<{ address: string; state: unknown }>;
  limitPauses: RunLimitPause[];
}

async function runOn(engine: 'ts' | 'rust', c: Case): Promise<Outcome> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const locks: string[][] = [];
  const email = fake('email');
  const attio = fake('attio', c.attio);
  const resolved: unknown[] = [];
  const trace: unknown[] = [];
  const appends: MovementTraceEntry[][] = [];
  const captured: CapturedWrite[] = [];
  const asked: unknown[] = [];
  const park = makeFakeParkSink();
  const suspensions: Outcome['suspensions'] = [];
  const limitPauses: RunLimitPause[] = [];
  const suspends = c.suspends ?? 'both';
  const sink: ParkSink = {
    ...park.sink,
    ...(suspends !== 'neither'
      ? {
          async commitSuspension({ address, state }: { address: string; state: unknown }) {
            suspensions.push({ address, state });
          },
        }
      : {}),
    ...(suspends === 'both'
      ? {
          async commitLimitPause({ limit, capMicrodollars, spentMicrodollars }: RunLimitPause) {
            limitPauses.push({ limit, capMicrodollars, spentMicrodollars });
          },
        }
      : {}),
  };
  const input: RunMovementInput = {
    source: PRELUDE + c.source,
    event: c.event,
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    firedAt: '2026-05-01T09:00:00.000Z',
    ...(c.dryRun === true ? { dryRun: true } : {}),
    ...(c.costCapMicrodollars !== undefined ? { costCapMicrodollars: c.costCapMicrodollars } : {}),
    ...(c.priorSpentMicrodollars !== undefined ? { priorSpentMicrodollars: c.priorSpentMicrodollars } : {}),
    ...(c.capBaselineMicrodollars !== undefined ? { capBaselineMicrodollars: c.capBaselineMicrodollars } : {}),
    ...(c.limitPaused === true ? { limitPaused: true } : {}),
    ...(c.suspendAt !== undefined ? { suspendAt: c.suspendAt } : {}),
    host: makeTestHost({
        locks: recordingWriteLocks(locks),
      ...(c.dryRun === true ? { writeSink: (w: CapturedWrite) => captured.push(w) } : {}),
      adapters: {
        resolve: (request) => {
          resolved.push(request);
          if (request.adapterType === 'email') return email.adapter;
          if (request.adapterType === 'attio') return attio.adapter;
          throw new Error(`test: no fake for ${request.adapterType}`);
        },
      },
      ...(c.judge !== undefined ? { llm: { arbitrateEntities: c.judge(asked) } } : {}),
      park: { sink },
      trace: trace as never[],
      traceAppends: appends,
    }),
  };
  const world = () => ({
    locks,
    email: email.calls,
    attio: attio.calls,
    resolved,
    trace,
    appends,
    captured,
    asked,
    parks: park.timerParks,
    suspensions,
    limitPauses,
  });
  try {
    const result =
      c.resume !== undefined
        ? await resumeMovement({ ...input, state: c.resume, ...(c.reenter === true ? { reenter: true } : {}) } satisfies ResumeMovementInput)
        : await runMovement(input);
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
  const text = JSON.stringify(value, (key, v) => (key === 'wakeAt' ? undefined : v));
  const normal = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    if (!ids.has(id)) ids.set(id, `uuid-${ids.size + 1}`);
    return ids.get(id)!;
  });
  return JSON.parse(normal) as T;
}

/** The case on both engines: they agree, and the Rust run was the Rust
 *  engine's alone — routed whole, the expression switch never consulted. */
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
    const [tsError, rustError] = [ts.error, rust.error];
    expect(rustError?.constructor).toBe((tsError as object).constructor);
    expect(String(rustError)).toBe(String(tsError));
    expect(runFailureCause(rustError)?.constructor).toBe((runFailureCause(tsError) as object).constructor);
    if (tsError instanceof MovementRunFailed && rustError instanceof MovementRunFailed) {
      expect(sameIds(rustError.partial)).toEqual(sameIds(tsError.partial));
    }
  } else {
    expect(rust.failed).toBe(false);
    expect(sameIds(rust.result)).toEqual(sameIds(ts.result));
  }
  return { ts, rust };
}

const DEALFLOW = [
  'movement m(msg: <inbox-[:message]->>) {',
  '  co = write crm-[:companies]-> {',
  '    unique by (`name`)',
  '    name:   msg.`subject`',
  '    tags:   msg.`text`',
  '    domain: [msg.`text`, "b"]',
  '  }',
  '  write co-[:notes]-> {',
  '    body: "New deal ${co.`name`} at ${co.externalId} (${co.`url`}, ${co.`minted`})"',
  '  }',
  '  write crm-[:companies]-> { name: "${co.externalId}!" }',
  '}',
].join('\n');

describe('writes in the Rust engine', () => {
  it('creates, pipes the handle into a linked write and a second create, as the TypeScript engine does', async () => {
    const { rust } = await agree({ source: DEALFLOW, event: webhook({ subject: 'Acme', text: 'acme.dev' }) });
    expect(rust.result?.writes.map((w) => [w.recordType, w.outcome, w.parents?.length ?? 0])).toEqual([
      ['company', 'create', 0],
      ['note', 'create', 1],
      ['company', 'create', 0],
    ]);
  });

  it('rehearses: the host captures the writes, in program order, and nothing commits', async () => {
    const { rust } = await agree({ source: DEALFLOW, event: webhook({ subject: 'Acme', text: 'acme.dev' }), dryRun: true });
    expect(rust.captured.map((w) => w.kind)).toEqual(['create', 'create', 'create']);
    expect(rust.result?.writes.every((w) => !w.committed)).toBe(true);
  });

  it('updates the one candidate the search finds, merging ?:, +: and +?: into its current values', async () => {
    const source = [
      'movement m(msg: <inbox-[:message]->>) {',
      '  co = write crm-[:companies]-> {',
      '    unique by (`name`)',
      '    name:   msg.`subject`',
      '    stage ?: "lead"',
      '    tags  +: ["x", "y"]',
      '    tags  +?: "acme.dev"',
      '  }',
      '  write co { stage: "won" }',
      '}',
    ].join('\n');
    const found = (name: string) => [{ adapterType: 'attio', externalId: 'co-7', data: { name } }];
    // `tags +?:` is the line `tags` is written by (the later mode wins), so a
    // record already carrying it has nothing to change.
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ stage: 'late', tags: ['x', 'acme.dev'] }, 'noop'],
      [{ stage: null, tags: [] }, 'update'],
    ];
    for (const [current, outcome] of cases) {
      const { rust } = await agree({
        source,
        event: webhook({ subject: 'Acme' }),
        attio: { candidates: (r) => found(String(r.name)), current: { 'co-7': { name: 'Acme', ...current } } },
      });
      expect(rust.result?.writes.map((w) => w.outcome)).toEqual([outcome, 'update']);
    }
  });

  it('sends nothing for a record already as written (noop), and only the parent for an attach', async () => {
    const source = [
      'movement m(msg: <inbox-[:message]->>) {',
      '  co = write crm-[:companies]-> { unique by (`name`) name: msg.`subject` }',
      '  write co-[:notes]-> { unique by (`body`) body: "same" }',
      '}',
    ].join('\n');
    const { rust } = await agree({
      source,
      event: webhook({ subject: 'Acme' }),
      attio: {
        candidates: (r) => [{ adapterType: 'attio', externalId: r.name !== undefined ? 'co-1' : 'n-1', data: r }],
        current: { 'co-1': { name: 'Acme' }, 'n-1': { body: 'same' } },
      },
    });
    expect(rust.result?.writes.map((w) => w.outcome)).toEqual(['noop', 'attach']);
    // An adapter that cannot attach an existing record fails the write.
    await agree({
      source,
      event: webhook({ subject: 'Acme' }),
      attio: {
        candidates: (r) => [{ adapterType: 'attio', externalId: r.name !== undefined ? 'co-1' : 'n-1', data: r }],
        current: { 'co-1': { name: 'Acme' }, 'n-1': { body: 'same' } },
        association: 'unsupported',
      },
    });
  });

  it('asks the judge among several candidates, and records it unavailable as the TypeScript engine does', async () => {
    const source = [
      'movement m(msg: <inbox-[:message]->>) {',
      '  write crm-[:companies]-> { unique by (FUZZY `name`) name: msg.`subject` }',
      '}',
    ].join('\n');
    const two = () => [
      { adapterType: 'attio', externalId: 'co-1', data: { name: 'Acme Inc' } },
      { adapterType: 'attio', externalId: 'co-2', data: { name: 'Acme Labs' } },
    ];
    const picks = (index: number | null, unavailable?: string) => (asked: unknown[]) =>
      async (input: Parameters<NonNullable<NonNullable<TestHostOverrides['llm']>['arbitrateEntities']>>[0]) => {
        asked.push({
          asserted: input.asserted,
          candidates: input.candidates,
          recordType: input.recordType,
          constraints: input.constraints,
          languageVersion: input.languageVersion,
          budget: input.budget,
        });
        // What the judge's model call spent, charged to the run by either engine.
        return { index, ...(unavailable !== undefined ? { judgeUnavailable: unavailable } : {}), cost: [{ source: 'model:judge', microdollars: 7 }] };
      };
    const merged = await agree({ source, event: webhook({ subject: 'Acme' }), attio: { candidates: two }, judge: picks(1) });
    expect(merged.rust.result?.writes[0]).toMatchObject({ externalId: 'co-2', outcome: 'update' });
    expect(merged.rust.result).toMatchObject({ spentMicrodollars: 7, spentBySource: { 'model:judge': 7 } });
    expect(merged.rust.asked).toEqual([expect.objectContaining({ budget: { remainingMicrodollars: null } })]);
    const created = await agree({
      source,
      event: webhook({ subject: 'Acme' }),
      attio: { candidates: two },
      judge: picks(null, 'anthropic 529'),
    });
    expect(created.rust.result?.writes[0]).toMatchObject({
      outcome: 'create',
      note: 'judge unavailable: anthropic 529; created rather than merged',
    });
  });

  it('narrows a key by its clause and asks the comparator for WITHIN', async () => {
    const source = [
      'movement m(msg: <inbox-[:message]->>) {',
      '  write crm-[:companies]-> {',
      '    unique by (`name`)',
      '    unique by (`domain`, `updated` WITHIN 30d)',
      '    name: "Nova"',
      '    domain: "nova.dev"',
      '  }',
      '}',
    ].join('\n');
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    for (const updated of [ago(400), ago(3)]) {
      await agree({
        source,
        event: webhook({}),
        attio: {
          candidates: (r) => (r.domain !== undefined ? [{ adapterType: 'attio', externalId: 'co-9', data: { name: 'Old', domain: 'nova.dev' } }] : []),
          current: { 'co-9': { name: 'Old', domain: 'nova.dev', updated } },
        },
      });
    }
  });

  it('fails the create a required field leaves empty, with the ledger so far', async () => {
    const describe = (recordType: string): SchemaTypeDescriptor | null =>
      recordType === 'note'
        ? {
            typeId: 'note',
            displayName: 'Note',
            fields: [{ fieldId: 'f-body', displayName: 'body', type: 'text', cardinality: 'one', required: true, writable: true }],
          } as unknown as SchemaTypeDescriptor
        : null;
    const source = [
      'movement m(msg: <inbox-[:message]->>) {',
      '  co = write crm-[:companies]-> { name: msg.`subject` }',
      '  write co-[:notes]-> { body: msg.`missing` }',
      '}',
    ].join('\n');
    const { rust } = await agree({ source, event: webhook({ subject: 'Acme' }), attio: { describe } });
    expect(String(rust.error)).toContain('cannot create a Note record: required field(s) "body" have no value');
    // And an adapter's own failure is the run's, its ledger with it.
    await agree({ source, event: webhook({ subject: 'Acme' }), attio: { failCreate: 'attio: 422' } });
  });

  it('expands a write spread by the fields the checker stamped on it', async () => {
    await agree({
      source: [
        'movement m(msg: <inbox-[:message]->>) {',
        '  d = node { name: msg.`subject`, stage: msg.`missing` }',
        '  write crm-[:companies]-> { ...d, name: "copy of ${d.`name`}" }',
        '}',
      ].join('\n'),
      event: webhook({ subject: 'Acme' }),
    });
  });

  it('builds a graph: a reference entry is an edge holding the record, a record spread copies by its plan', async () => {
    const source = [
      'movement m(msg: <inbox-[:message]->>) {',
      '  co = write crm-[:companies]-> { name: msg.`subject`, stage: "lead" }',
      '  g = graph { owner: co, title: msg.`subject`, ...co }',
      '  d = { label: "x", inner: { n: 1 } }',
      '  write crm-[:companies]-> { name: "${g.`title`}/${g.`stage`}/${d.`label`}" }',
      '  await sleep(1h)',
      '}',
    ].join('\n');
    const { rust } = await agree({ source, event: webhook({ subject: 'Acme' }) });
    // The park holds the graph as the TypeScript engine holds it: `owner` an
    // edge landing the handle, not a field.
    const state = JSON.parse(JSON.stringify(rust.parks[0]?.state)) as ParkedScopeState;
    const g = state.scopeChain[1]?.bindings.g;
    expect(g).toMatchObject({ kind: 'nodePosition', edges: { owner: { kind: 'landed', landings: [{ kind: 'handle' }] } } });
    expect(g?.kind === 'nodePosition' && 'owner' in g.fields).toBe(false);
  });

  it('declines, after its check and before it resolves the source, what the check\'s stamps say it does not run', async () => {
    for (const [body, reason] of [
      // A date-typed event field (read by name here; by a spread's stamp in
      // the crate's own tests).
      ['  write crm-[:companies]-> { name: msg.`when` }', 'event_field_dated'],
      // A graph copy whose plan walks edges is stamped only on a graph with a
      // shape, which admission refuses: the crate's own tests decline one.
    ] as const) {
      resetRustRunStats();
      const run = await runOn('rust', { source: `movement m(msg: <inbox-[:message]->>) {\n${body}\n}`, event: webhook({ when: '2026-01-01' }) });
      expect([body, rustRunStats.declined]).toEqual([body, { [reason]: 1 }]);
      expect(rustRunStats.notAdmitted).toEqual({});
      // Nothing but the check was asked of the host...
      expect(rustRunStats.hostCalls).toEqual({ 'check.program': 1 });
      // ...and the TypeScript engine ran it instead: the source resolved once.
      expect(run.resolved.filter(isSourceResolve)).toHaveLength(1);
    }
  });
});

describe('parks in the Rust engine', () => {
  const PARKS = [
    'movement m(msg: <inbox-[:message]->>) {',
    '  co = write crm-[:companies]-> { unique by (`name`) name: msg.`subject` }',
    '  label = "${co.`name`} (${co.externalId})"',
    '  if label != "" {',
    '    waited = await sleep(30s)',
    '    write co-[:notes]-> { body: "${label} after ${waited}" }',
    '  }',
    '  write crm-[:companies]-> { name: "${label}!" }',
    '}',
  ].join('\n');

  it('parks at a sleep with the state the TypeScript engine writes', async () => {
    const { ts, rust } = await agree({ source: PARKS, event: webhook({ subject: 'Acme' }) });
    expect(rust.result).toMatchObject({ parked: true, parkedAddress: 's2.b0.s0' });
    expect(rust.parks[0]?.address).toBe('s2.b0.s0');
    // Key for key, in order: the string, not `toEqual`, which ignores order.
    expect(JSON.stringify(rust.parks[0]?.state)).toBe(JSON.stringify(ts.parks[0]?.state));
  });

  it('a rehearsal fast-forwards past a sleep', async () => {
    const { rust } = await agree({ source: PARKS, event: webhook({ subject: 'Acme' }), dryRun: true });
    expect(rust.parks).toEqual([]);
  });

  it('resumes on either engine what either engine parked', async () => {
    const event = webhook({ subject: 'Acme' });
    const parkedBy = async (engine: 'ts' | 'rust') => {
      const run = await runOn(engine, { source: PARKS, event });
      return JSON.parse(JSON.stringify(run.parks[0]?.state)) as ParkedScopeState;
    };
    const [fromTs, fromRust] = [await parkedBy('ts'), await parkedBy('rust')];
    expect(fromRust).toEqual(fromTs);
    // A state parked by the TypeScript engine, resumed by the Rust one, and
    // the reverse: each resume agrees with the TypeScript engine's own.
    for (const state of [fromTs, fromRust]) {
      const { rust } = await agree({ source: PARKS, event, resume: state });
      expect(rust.result?.parked).toBeUndefined();
      expect(rust.result?.writes.map((w) => w.recordType)).toEqual(['note', 'company']);
    }
    // The TypeScript engine resumes the Rust engine's park as its own.
    const onTs = await runOn('ts', { source: PARKS, event, resume: fromRust });
    const ownTs = await runOn('ts', { source: PARKS, event, resume: fromTs });
    expect(onTs.result).toEqual(ownTs.result);
    expect(onTs.attio).toEqual(ownTs.attio);
  });

  it('parks and resumes a bound block that returned nothing (no returned records), on either engine', async () => {
    const source = [
      'movement m(msg: <inbox-[:message]->>) {',
      '  rows = crm-[c:companies]-> {',
      '    return c.`name`',
      '  }',
      '  await sleep(30s)',
      '  write crm-[:companies]-> { name: "after", blob: rows }',
      '}',
    ].join('\n');
    const event = webhook({ subject: 'Acme' });
    const { ts, rust } = await agree({ source, event });
    expect(JSON.stringify(rust.parks[0]?.state)).toBe(JSON.stringify(ts.parks[0]?.state));
    expect(JSON.stringify(rust.parks[0]?.state)).toContain('"rows":{"kind":"positions","landings":[]}');
    for (const parked of [ts, rust]) {
      const state = JSON.parse(JSON.stringify(parked.parks[0]?.state)) as ParkedScopeState;
      const resumed = await agree({ source, event, resume: state });
      // An empty list, written to a field the adapter does not describe as
      // many: the joined text of nothing.
      expect(resumed.rust.result?.writes[0]?.writtenValues).toEqual({ name: 'after', blob: '' });
    }
  });

  describe('the park state of every binding a record verb or a bound block makes', () => {
    const FOUND: ExternalRecordRef[] = [
      { adapterType: 'attio', externalId: 'co-1', url: 'https://x/co-1', data: { name: 'Acme', stage: 'Seed' } },
    ];
    const cases: Array<[string, string[], Store]> = [
      [
        'a match',
        ['  co = match crm-[:companies]-> { unique by (`name`), name: msg.`subject` }', '  await sleep(30s)', '  write co-[:notes]-> { body: co.`stage` }'],
        { candidates: () => FOUND, current: { 'co-1': { domain: 'acme.dev' } } },
      ],
      [
        'a link whose body matches',
        [
          '  co = write crm-[:companies]-> { name: msg.`subject` }',
          '  found = link co -[:notes]-> { unique by (`body`), body: "hello" }',
          '  await sleep(30s)',
          '  write crm-[:companies]-> { name: "${found.externalId} ${found.`body`}" }',
        ],
        { candidates: (record) => (record.body === 'hello' ? [{ adapterType: 'attio', externalId: 'n-9', data: { body: 'hello' } }] : []), links: true },
      ],
      [
        'a write with a target WHERE, bound',
        [
          '  co = write crm-[c:companies WHERE c.`stage` == "Seed"]-> { unique by (`name`), name: msg.`subject` }',
          '  await sleep(30s)',
          '  write co-[:notes]-> { body: co.`name` }',
        ],
        { candidates: () => FOUND, current: { 'co-1': { stage: 'Seed' } } },
      ],
      [
        'a bound block returning values over three landings',
        [
          '  names = crm-[c:companies ORDER BY `name` DESC]-> {',
          '    return "${c.`name`}/${msg.`subject`}"',
          '  }',
          '  await sleep(30s)',
          '  write crm-[:companies]-> { name: "${AT(names, 0)}", tags: names }',
        ],
        { landings: { 'co-1': { name: 'Acme' }, 'co-2': { name: 'Globex' }, 'co-3': { name: 'Initech' } } },
      ],
    ];
    for (const [what, lines, attio] of cases) {
      it(`${what}: parked as one string on both engines, resumed by either from either`, async () => {
        const source = ['movement m(msg: <inbox-[:message]->>) {', ...lines, '}'].join('\n');
        const event = webhook({ subject: 'Acme' });
        const { ts, rust } = await agree({ source, event, attio });
        expect(rust.result).toMatchObject({ parked: true });
        const text = (o: Outcome) => JSON.stringify(o.parks[0]?.state);
        expect(text(rust)).toBe(text(ts));
        const fromTs = JSON.parse(text(ts)) as ParkedScopeState;
        const fromRust = JSON.parse(text(rust)) as ParkedScopeState;
        for (const state of [fromTs, fromRust]) {
          const resumed = await agree({ source, event, attio, resume: state });
          expect(resumed.rust.result?.parked).toBeUndefined();
          expect(JSON.stringify(resumed.rust.result)).toBe(JSON.stringify(resumed.ts.result));
        }
      });
    }
  });

  it('resumes a parked object in the order it was stored, not sorted', async () => {
    const source = [
      'movement m(msg: <inbox-[:message]->>) {',
      '  d = msg.`meta`',
      '  co = write crm-[:companies]-> { name: "first", blob: d }',
      '  await sleep(30s)',
      '  write crm-[:companies]-> { name: "after", blob: d }',
      '  write crm-[:companies]-> { name: "again", blob: co.`blob` }',
      '}',
    ].join('\n');
    const event = webhook({ meta: { name: 'Acme', amount: 1, zeta: true, alpha: { b: 1, a: 2 } } });
    const parked = await runOn('ts', { source, event });
    // As stored: a JSON round trip keeps insertion order, as jsonb keeps its own.
    const state = JSON.parse(JSON.stringify(parked.parks[0]?.state)) as ParkedScopeState;
    const { ts, rust } = await agree({ source, event, resume: state });
    // `toEqual` ignores key order: the strings are the point.
    expect(JSON.stringify(rust.attio)).toBe(JSON.stringify(ts.attio));
    expect(JSON.stringify(rust.result)).toBe(JSON.stringify(ts.result));
    expect(JSON.stringify(rust.result?.writes[0]?.writtenValues)).toBe('{"name":"after","blob":{"name":"Acme","amount":1,"zeta":true,"alpha":{"b":1,"a":2}}}');
  });

  it('leaves to the TypeScript engine a state it does not resume, refused before it asks its host anything', async () => {
    const event = webhook({ subject: 'Acme' });
    const state: ParkedScopeState = {
      version: 1,
      address: 's2.b0.s0',
      bindingName: null,
      scopeChain: [],
      journal: [{ index: 0, value: null, next: 1 }],
    };
    for (const [resume, reason] of [
      [state, 'resume_state_journal'],
      [{ ...state, journal: undefined, address: 's1.i0.s0' }, 'resume_state_address'],
    ] as const) {
      resetRustRunStats();
      await runOn('rust', { source: PARKS, event, resume });
      expect(rustRunStats.notAdmitted).toEqual({ [reason]: 1 });
      expect(rustRunStats.hostCalls).toEqual({});
    }
  });
});

describe('the cost cap in the Rust engine', () => {
  // Two judged writes (two candidates each, so the rules cannot decide), the
  // second inside an `if` arm, and a write after it that asks no judge (a
  // note, for which the search finds no candidate).
  const PRICED = [
    'movement m(msg: <inbox-[:message]->>) {',
    '  first = write crm-[:companies]-> { unique by (FUZZY `name`) name: msg.`subject` }',
    '  label = "${first.`name`}"',
    '  if label != "" {',
    '    write crm-[:companies]-> { unique by (FUZZY `name`) name: "${label} two" }',
    '    write crm-[:notes]-> { body: "${label} three" }',
    '  }',
    '}',
  ].join('\n');
  const event = webhook({ subject: 'Acme' });
  const two = () => [
    { adapterType: 'attio', externalId: 'co-1', data: { name: 'Acme Inc' } },
    { adapterType: 'attio', externalId: 'co-2', data: { name: 'Acme Labs' } },
  ];
  /** A judge that spends `microdollars` a call, refused as the host's meter
   *  refuses (lib/run_spend.ts): once the budget is spent, before it starts. */
  const judge = (microdollars: number) => (asked: unknown[]) =>
    async (input: Parameters<NonNullable<NonNullable<TestHostOverrides['llm']>['arbitrateEntities']>>[0]) => {
      asked.push({ budget: input.budget });
      const remaining = input.budget.remainingMicrodollars;
      if (remaining !== null && remaining <= 0) {
        return { error: { kind: 'budget' as const, message: "this run's cost budget is spent" }, cost: [] };
      }
      return { index: 0, cost: [{ source: 'model:judge', microdollars }] };
    };
  const capped = (c: Partial<Case> = {}): Case => ({
    source: PRICED,
    event,
    // A note finds none: only the companies are judged.
    attio: { candidates: (record) => ('body' in record ? [] : two()) },
    judge: judge(1_500),
    costCapMicrodollars: 1_000,
    ...c,
  });

  it('pauses where the TypeScript engine pauses: the same pause, suspension, trace and partial effects', async () => {
    const { ts, rust } = await agree(capped());
    // The first judge took the run past its cap and its write stands; the
    // second was refused, and the run suspended just before its statement.
    expect(rust.result).toMatchObject({ parked: true, parkedAddress: 's2.b0.s0', spentMicrodollars: 1_500 });
    expect(rust.result?.writes.map((w) => w.externalId)).toEqual(['co-1']);
    expect(rust.limitPauses).toEqual([{ limit: 'cost', capMicrodollars: 1_000, spentMicrodollars: 1_500 }]);
    expect(rust.suspensions.map((s) => s.address)).toEqual(['s2.b0.s0']);
    // Key for key, in order.
    expect(JSON.stringify(rust.suspensions[0]?.state)).toBe(JSON.stringify(ts.suspensions[0]?.state));
    expect(rust.suspensions[0]?.state).toMatchObject({ version: 1, address: 's2.b0.s0', bindingName: null, suspended: true, journal: [] });
    expect(rust.trace).toEqual([
      { kind: 'gate', outcome: true },
      {
        kind: 'warning',
        code: 'RUN_PAUSED_COST_CAP',
        message:
          'Paused: cost limit reached. The run has spent $0.0015 against a limit of $0.001 (MOVEMENT_MAX_RUN_COST_USD). ' +
          'Every branch stopped before its next statement; resume the run to carry on from there, with its usage reset.',
      },
      { kind: 'gate', outcome: false },
    ]);
    expect(rustRunStats.hostCalls).toMatchObject({ 'park.sink.commitLimitPause': 1, 'park.sink.commitSuspension': 1 });
  });

  it('meets a cap the run has spent exactly, and not one it has not', async () => {
    const exactly = await agree(capped({ judge: judge(1_000) }));
    expect(exactly.rust.result).toMatchObject({ parked: true, parkedAddress: 's2.b0.s0' });
    expect(exactly.rust.limitPauses).toEqual([{ limit: 'cost', capMicrodollars: 1_000, spentMicrodollars: 1_000 }]);
    // One microdollar left: the second judge may spend, and nothing after it is priced.
    const under = await agree(capped({ judge: judge(999) }));
    expect(under.rust.result?.parked).toBeUndefined();
    expect(under.rust.result).toMatchObject({ spentMicrodollars: 1_998 });
    expect(under.rust.limitPauses).toEqual([]);
    // Spent before this segment, past the cap: the first judge is refused.
    const before = await agree(capped({ priorSpentMicrodollars: 1_200 }));
    expect(before.rust.result).toMatchObject({ parked: true, parkedAddress: 's0', writes: [] });
    expect(before.rust.limitPauses).toEqual([{ limit: 'cost', capMicrodollars: 1_000, spentMicrodollars: 1_200 }]);
  });

  it('resumes from its operator on either engine what either engine suspended', async () => {
    const suspendedBy = async (engine: 'ts' | 'rust') => {
      const run = await runOn(engine, capped());
      return JSON.parse(JSON.stringify(run.suspensions[0]?.state)) as ParkedScopeState;
    };
    const [fromTs, fromRust] = [await suspendedBy('ts'), await suspendedBy('rust')];
    expect(fromRust).toEqual(fromTs);
    // limit_pause.ts: the statement re-entered, the run's spend carried, the
    // cap counted afresh from it.
    const resume = (state: ParkedScopeState): Case =>
      capped({ resume: state, reenter: true, priorSpentMicrodollars: 1_500, capBaselineMicrodollars: 1_500 });
    for (const state of [fromTs, fromRust]) {
      const { rust } = await agree(resume(state));
      expect(rust.result?.parked).toBeUndefined();
      // The pause was the operator's to clear: the resumed run marks none.
      expect(rust.limitPauses).toEqual([]);
      expect(rust.result?.writes.map((w) => w.writtenValues.name ?? w.writtenValues.body)).toEqual(['Acme two', 'Acme three']);
      expect(rust.asked).toEqual([{ budget: { remainingMicrodollars: 1_000 } }]);
    }
    const onTs = await runOn('ts', resume(fromRust));
    const ownTs = await runOn('ts', resume(fromTs));
    expect(onTs.result).toEqual(ownTs.result);
    expect(onTs.attio).toEqual(ownTs.attio);
    // Resumed still over the cap (no reset), it suspends again at the same
    // statement, and marks the run paused again.
    const again = await agree(capped({ resume: fromRust, reenter: true, priorSpentMicrodollars: 1_500 }));
    expect(again.rust.result).toMatchObject({ parked: true, parkedAddress: 's2.b0.s0' });
    expect(again.rust.suspensions.map((s) => s.address)).toEqual(['s2.b0.s0']);
    expect(again.rust.limitPauses).toEqual([{ limit: 'cost', capMicrodollars: 1_000, spentMicrodollars: 1_500 }]);
  });

  it('pauses at a capped PLAIN write whose search finds several candidates, as the TypeScript engine does', async () => {
    // No `unique by`: the descriptor's fuzzy resolution searches by name, two
    // candidates come back, and the judge decides — a priced call all the same.
    const { rust } = await agree(capped({ source: PRICED.replaceAll('unique by (FUZZY `name`) ', '') }));
    expect(rust.result).toMatchObject({ parked: true, parkedAddress: 's2.b0.s0', spentMicrodollars: 1_500 });
    expect(rust.asked).toHaveLength(2);
    expect(rust.limitPauses).toEqual([{ limit: 'cost', capMicrodollars: 1_000, spentMicrodollars: 1_500 }]);
    expect(rust.suspensions.map((s) => s.address)).toEqual(['s2.b0.s0']);
  });

  it('fails on the cap where the sink cannot suspend, and suspends unmarked where it keeps no pause', async () => {
    const { rust } = await agree(capped({ suspends: 'neither' }));
    const cause = runFailureCause(rust.error);
    expect(cause).toBeInstanceOf(RunCostCapExceeded);
    expect(cause).toMatchObject({ capMicrodollars: 1_000, spentMicrodollars: 1_500 });
    expect(rust.limitPauses).toEqual([]);
    const unmarked = await agree(capped({ suspends: 'suspension_only' }));
    expect(unmarked.rust.result).toMatchObject({ parked: true, parkedAddress: 's2.b0.s0' });
    expect(unmarked.rust.trace).toContainEqual(expect.objectContaining({ code: 'RUN_PAUSED_COST_CAP' }));
  });

  it('joins a pause that holds: a woken flow steps past its sleep and suspends before its next statement', async () => {
    const SLEEPS = [
      'movement m(msg: <inbox-[:message]->>) {',
      '  co = write crm-[:companies]-> { name: msg.`subject` }',
      '  await sleep(30s)',
      '  write crm-[:companies]-> { name: "${co.`name`} later" }',
      '}',
    ].join('\n');
    const parked = await runOn('ts', { source: SLEEPS, event });
    const state = JSON.parse(JSON.stringify(parked.parks[0]?.state)) as ParkedScopeState;
    const { rust } = await agree({ source: SLEEPS, event, resume: state, limitPaused: true });
    expect(rust.result).toMatchObject({ parked: true, parkedAddress: 's2', writes: [] });
    expect(rust.suspensions.map((s) => s.address)).toEqual(['s2']);
    // The pause is already marked: no flow marks it again.
    expect(rust.limitPauses).toEqual([]);
    // A paused run whose sink cannot suspend runs on.
    const runsOn = await agree({ source: SLEEPS, event, resume: state, limitPaused: true, suspends: 'neither' });
    expect(runsOn.rust.result?.writes).toHaveLength(1);
  });

  it('suspends at a suspendAt address, once, and fails where it has nowhere to park', async () => {
    const source = PRICED.replaceAll('unique by (FUZZY `name`) ', '');
    const { rust } = await agree({ source, event, suspendAt: ['s2.b0.s1', 's1'] });
    expect(rust.result).toMatchObject({ parked: true, parkedAddress: 's1' });
    expect(rust.result?.writes).toHaveLength(1);
    const nowhere = await agree({ source, event, suspendAt: ['s1'], suspends: 'neither' });
    expect(String(runFailureCause(nowhere.rust.error))).toContain("the run was asked to suspend at 's1' and has nowhere durable to park");
  });
});

/** An `adapters.resolve` request for the event's source. */
function isSourceResolve(request: unknown): request is { role: 'source' } {
  return typeof request === 'object' && request !== null && Reflect.get(request, 'role') === 'source';
}
