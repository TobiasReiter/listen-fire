// Writes and parks in the Rust engine (slice 2b), held to the TypeScript
// engine: each program runs under MOVEMENT_ENGINE=ts and =rust against fakes
// of its own, and the two must agree on everything a caller can see — the
// result or the error, the trace, every call each adapter received in order,
// the resolver's requests, the judge's questions, a rehearsal's captured
// writes, the park sink's rows. A park written by either engine resumes on
// the other.

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { Adapter, ExternalRecordRef } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { SchemaTypeDescriptor } from '../../translation_graph/types';
import { positionData } from '../../translation_graph/types';
import { makeFakeParkSink, makeTestHost, type TestHostOverrides } from '../host';
import {
  MovementRunFailed,
  resumeMovement,
  runFailureCause,
  runMovement,
  type MovementRunResult,
  type ResumeMovementInput,
  type RunMovementInput,
} from '../run';
import { rustCanResume, rustCanRun } from '../rust_engine';
import { resetRustEvalStats, resetRustRunStats, rustEvalStats, rustRunStats } from '../rust_stats';
import type { ParkedScopeState } from '../serialize';
import { parsePinned } from '../program_check';

const TEAM_ID = '00000000-0000-0000-0000-0000000000b2' as TeamId;

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
    getRelated: async () => [],
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
}

/** One run on one engine: what it returned or threw, and everything the
 *  world saw of it. */
/** What one run did: its result or the error it failed with, and the world. */
interface Outcome {
  failed: boolean;
  result?: MovementRunResult;
  error?: unknown;
  email: Array<[string, unknown]>;
  attio: Array<[string, unknown]>;
  resolved: unknown[];
  trace: unknown[];
  captured: CapturedWrite[];
  asked: unknown[];
  parks: Array<{ address: string; state: unknown; wakeAt: Date }>;
}

async function runOn(engine: 'ts' | 'rust', c: Case): Promise<Outcome> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const email = fake('email');
  const attio = fake('attio', c.attio);
  const resolved: unknown[] = [];
  const trace: unknown[] = [];
  const captured: CapturedWrite[] = [];
  const asked: unknown[] = [];
  const park = makeFakeParkSink();
  const input: RunMovementInput = {
    source: PRELUDE + c.source,
    event: c.event,
    teamId: TEAM_ID,
    catalog,
    firedAt: new Date('2026-05-01T09:00:00Z'),
    ...(c.dryRun === true ? { dryRun: true, writeSink: (w: CapturedWrite) => captured.push(w) } : {}),
    host: makeTestHost({
      adapters: {
        credentialId: (name) => `cred-${name}`,
        resolve: (request) => {
          resolved.push(request);
          if (request.adapterType === 'email') return email.adapter;
          if (request.adapterType === 'attio') return attio.adapter;
          throw new Error(`test: no fake for ${request.adapterType}`);
        },
      },
      ...(c.judge !== undefined ? { llm: { arbitrateEntities: c.judge(asked) } } : {}),
      park: { sink: park.sink },
      trace: trace as never[],
    }),
  };
  const world = () => ({ email: email.calls, attio: attio.calls, resolved, trace, captured, asked, parks: park.timerParks });
  try {
    const result = c.resume !== undefined ? await resumeMovement({ ...input, state: c.resume } satisfies ResumeMovementInput) : await runMovement(input);
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
  expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, declined: {} });
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
        asked.push({ asserted: input.asserted, candidates: input.candidates, recordType: input.recordType, constraints: input.constraints });
        if (unavailable !== undefined) input.onJudgeUnavailable?.(unavailable);
        return index;
      };
    const merged = await agree({ source, event: webhook({ subject: 'Acme' }), attio: { candidates: two }, judge: picks(1) });
    expect(merged.rust.result?.writes[0]).toMatchObject({ externalId: 'co-2', outcome: 'update' });
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

  it('declines nothing it admitted: a date-typed event field is declined before the source is resolved', async () => {
    resetRustRunStats();
    const before = await runOn('rust', {
      source: ['movement m(msg: <inbox-[:message]->>) {', '  write crm-[:companies]-> { name: msg.`when` }', '}'].join('\n'),
      event: webhook({ when: '2026-01-01' }),
    });
    expect(rustRunStats.declined).toEqual({ "the event's `when` is a date, which an adapter may answer as a Date": 1 });
    // It ran on the TypeScript engine instead, and the source was resolved once.
    expect(before.resolved).toHaveLength(2);
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
    const parsed = parsePinned({ source: PRELUDE + PARKS });
    expect(rustCanResume(parsed, { host: makeTestHost(), state: fromTs })).toBe(true);
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

  it('leaves to the TypeScript engine a state it does not resume', () => {
    const parsed = parsePinned({ source: PRELUDE + PARKS });
    const state: ParkedScopeState = { version: 1, address: 's2.b0.s0', bindingName: null, scopeChain: [], journal: [] };
    expect(rustCanResume(parsed, { host: makeTestHost(), state })).toBe(false);
    expect(rustCanResume(parsed, { host: makeTestHost(), state: { ...state, journal: undefined, address: 's1.i0.s0' } })).toBe(false);
    expect(rustCanRun(parsed, { host: makeTestHost() })).toBe(true);
  });
});
