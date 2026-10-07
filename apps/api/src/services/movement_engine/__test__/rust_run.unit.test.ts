// Whole runs in the Rust engine (slice 2a), held to the TypeScript engine:
// each program runs under MOVEMENT_ENGINE=ts and =rust against the same
// fakes, and the two must agree on everything a caller can see — the
// result (or the error, its class and the very object a host call failed
// with), the trace, and every call the adapters received, in order.
//
// The conformance corpora prove the TypeScript engine's semantics, but every
// program in them writes, and writes are the next slice; these programs are
// the slice's own: reads of the event and of values, bindings, `if`,
// interpolation, `return`, the built-ins, the cancel gate.

import { mockCatalogSnapshot, parseProgram, type CatalogSnapshot, type InstanceSchema } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { Adapter } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';

import { containerAssociation } from '../../translation_graph/adapter';
import { positionData } from '../../translation_graph/types';
import { makeTestHost, type TestHostOverrides } from '../host';
import { MovementRunFailed, runFailureCause, runMovement, type RunMovementInput } from '../run';
import { rustCanRun, runSegmentInRust } from '../rust_engine';
import { resetRustEvalStats, resetRustRunStats, rustEvalStats, rustRunStats } from '../rust_stats';

const TEAM_ID = '00000000-0000-0000-0000-0000000000a1' as TeamId;

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text', missing: 'text', meta: 'json' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const attioSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text', stage: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: {},
};

/** The snapshot a fixture's catalog makes, as a production snapshot has it:
 *  mockCatalog's adapter specs carry the fixture's own `schema` beside the
 *  snapshot's `schemas`, which no real snapshot does (and the Rust catalog
 *  refuses what a snapshot does not declare). */
function snapshotOf(spec: Parameters<typeof mockCatalogSnapshot>[0]): CatalogSnapshot {
  const snapshot = mockCatalogSnapshot(spec);
  const adapters = Object.fromEntries(
    Object.entries(snapshot.adapters).map(([name, adapter]) => {
      const { schema: _fixtureOnly, ...rest } = adapter as typeof adapter & { schema?: unknown };
      return [name, rest];
    }),
  );
  return { ...snapshot, adapters };
}

const catalog = snapshotOf({
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

class FakeAdapterError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'FakeAdapterError';
  }
}

/** A fake whose `getFieldValue` reads the position's data bag, recording
 *  every call it gets. */
function fakeEmail(options: { failOn?: string; entryPoints?: Array<{ typeId: string; displayName?: string }> } = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const adapter: Adapter = {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    async listEntryPoints() {
      calls.push({ method: 'listEntryPoints', input: undefined });
      return (options.entryPoints ?? []).map((e) => ({
        typeId: e.typeId,
        displayName: e.displayName ?? e.typeId,
        readable: true,
        writable: false,
      }));
    },
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      calls.push({ method: 'getFieldValue', input });
      if (input.fieldId === options.failOn) throw new FakeAdapterError(`no ${input.fieldId} today`);
      const data = positionData(input.position) as Record<string, unknown> | undefined;
      return data?.[input.fieldId];
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
  return { adapter, calls };
}


function webhook(payload: Record<string, unknown>, extra: Partial<TriggerEvent> = {}): TriggerEvent {
  return { pipelineInputId: 'pi-rust-run', adapterType: 'email', triggerType: 'webhook', payload, ...extra };
}

interface Case {
  source: string;
  event: TriggerEvent;
  movementName?: string;
  firedAt?: Date;
  email?: Parameters<typeof fakeEmail>[0];
  /** Per run: each engine gets fakes of its own. */
  host?: () => TestHostOverrides;
}

/** One run on one engine: what it returned or threw, what the adapters
 *  were asked, what the resolver was asked. */
async function runOn(engine: 'ts' | 'rust', c: Case) {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const email = fakeEmail(c.email);
  const resolved: unknown[] = [];
  const trace: unknown[] = [];
  const input: RunMovementInput = {
    source: PRELUDE + c.source,
    event: c.event,
    teamId: TEAM_ID,
    catalog,
    ...(c.movementName !== undefined ? { movementName: c.movementName } : {}),
    ...(c.firedAt !== undefined ? { firedAt: c.firedAt } : {}),
    host: makeTestHost({
      adapters: {
        credentialId: (name) => `cred-${name}`,
        resolve: (request) => {
          resolved.push(request);
          if (request.adapterType !== 'email') throw new Error(`test: no fake for ${request.adapterType}`);
          return email.adapter;
        },
      },
      trace: trace as never[],
      ...c.host?.(),
    }),
  };
  try {
    const result = await runMovement(input);
    return { result, calls: email.calls, resolved, trace };
  } catch (error) {
    return { error, calls: email.calls, resolved, trace };
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

/** The case on both engines: they agree, and the Rust run was the Rust
 *  engine's alone — routed whole, the expression switch never consulted. */
async function agree(c: Case) {
  const ts = await runOn('ts', c);
  resetRustEvalStats();
  resetRustRunStats();
  const rust = await runOn('rust', c);
  expect(rustRunStats).toMatchObject({ routed: 1, declined: {} });
  expect(rustEvalStats).toEqual({ notAdmitted: 0, admitted: 0, answered: 0, fallback: {} });
  expect(rust.calls).toEqual(ts.calls);
  expect(rust.resolved).toEqual(ts.resolved);
  expect(rust.trace).toEqual(ts.trace);
  if ('error' in ts) {
    expect('error' in rust).toBe(true);
    const [tsError, rustError] = [ts.error, 'error' in rust ? rust.error : undefined];
    expect(rustError?.constructor).toBe((tsError as object).constructor);
    expect(String(rustError)).toBe(String(tsError));
    expect(runFailureCause(rustError)?.constructor).toBe((runFailureCause(tsError) as object).constructor);
    if (tsError instanceof MovementRunFailed && rustError instanceof MovementRunFailed) {
      expect(rustError.partial).toEqual(tsError.partial);
    }
  } else {
    expect('result' in rust ? rust.result : rust.error).toEqual(ts.result);
  }
  return { ts, rust, result: rust.result };
}

const BINDINGS_AND_IF = [
  'movement m(msg: <inbox-[:message]->>) {',
  '  subject = msg.`subject`',
  '  greeting = "Re: ${subject} (${UPPER(TRIM(msg.`text`))})"',
  '  if msg.`text` CONTAINS "deal" {',
  '    kind = "deal"',
  '  } else if COALESCE(msg.`missing`, "x") == "x" AND LENGTH(greeting) > 3 {',
  '    kind = "other"',
  '  } else {',
  '    kind = "none"',
  '  }',
  '  tail = CONCAT(greeting, "!", NUMBER.FORMAT(1200000, "compact"))',
  '  if tail == "never" {',
  '    return tail',
  '  }',
  '  return subject',
  '}',
].join('\n');

describe('a whole run in the Rust engine', () => {
  it('is admitted for reads, bindings, if and return, and refused for anything more', () => {
    const host = makeTestHost();
    const program = (body: string) => parseProgram(`${PRELUDE}movement m(msg: <inbox-[:message]->>) {\n${body}\n}`, { languageVersion: 3 });
    expect(rustCanRun(parseProgram(PRELUDE + BINDINGS_AND_IF, { languageVersion: 3 }), { host })).toBe(true);
    expect(rustCanRun(program('  write crm-[:companies]-> { name: msg.`subject` }'), { host })).toBe(false);
    expect(rustCanRun(program('  x = msg'), { host })).toBe(false);
    expect(rustCanRun(program('  x = AI("why?")'), { host })).toBe(false);
    expect(rustCanRun(program('  if msg IS <inbox-[:message]->> {\n    x = 1\n  }'), { host })).toBe(false);
    expect(rustCanRun(program('  x = crm.`name`'), { host })).toBe(false);
    // A caller's trace already holding entries: its field misses are the
    // TypeScript engine's to see.
    const seeded = makeTestHost({ trace: [{ kind: 'gate', outcome: true }] });
    expect(rustCanRun(parseProgram(PRELUDE + BINDINGS_AND_IF, { languageVersion: 3 }), { host: seeded })).toBe(false);
  });

  it('reads the event, binds, interpolates and branches as the TypeScript engine does', async () => {
    for (const text of ['a big deal', '  quiet  ']) {
      const { result } = await agree({ source: BINDINGS_AND_IF, event: webhook({ subject: 'Acme', text }) });
      // The deal arm is taken at once; otherwise the second arm reads a
      // field the payload lacks.
      expect(result?.trace.map((e) => e.kind)).toEqual(
        text.includes('deal') ? ['gate', 'gate'] : ['gate', 'field_miss', 'gate', 'gate'],
      );
    }
  });

  it('traces a field the payload does not carry, once per field', async () => {
    const { result } = await agree({
      source: [
        'movement m(msg: <inbox-[:message]->>) {',
        '  a = msg.`missing`',
        '  b = COALESCE(msg.`missing`, msg.`text`)',
        '  c = msg.`subject`',
        '}',
      ].join('\n'),
      event: webhook({ zeta: 1, text: 'hi', 10: 'ten', alpha: null }),
    });
    expect(result?.trace).toEqual([
      { kind: 'field_miss', binding: 'inbox', field: 'missing', available: ['10', 'zeta', 'text', 'alpha'] },
      { kind: 'field_miss', binding: 'inbox', field: 'subject', available: ['10', 'zeta', 'text', 'alpha'] },
    ]);
  });

  it('reads a field of an object held in a value binding, null for an absent one', async () => {
    await agree({
      source: [
        'movement m(msg: <inbox-[:message]->>) {',
        '  sa = msg.`meta`',
        '  label = sa.`label`',
        '  gone = sa.`missing`',
        '  if label == "Follow up" AND gone == null {',
        '    ok = TEXT.SLUG(label)',
        '  }',
        '}',
      ].join('\n'),
      event: webhook({ meta: { label: 'Follow up', n: 2 } }),
    });
  });

  it('names a discriminated root by the adapter entry points, and reads it stamped', async () => {
    const { rust } = await agree({
      source: ['movement m(msg: <inbox-[:message]->>) {', '  s = msg.`subject`', '}'].join('\n'),
      event: webhook({ subject: 'Hi' }, { rootRecordType: 'email:msg', externalRecordRef: { adapterType: 'email', externalId: 'm-1' } }),
      email: { entryPoints: [{ typeId: 'email:msg', displayName: 'message' }] },
    });
    expect(rust.calls.map((c) => c.method)).toEqual(['listEntryPoints', 'getFieldValue']);
  });

  it('reads the clock it was pinned to, in the zone it names', async () => {
    await agree({
      source: [
        'movement m(msg: <inbox-[:message]->>) {',
        '  today = DATE.TODAY("Europe/Berlin")',
        '  start = DATETIME.AT(DATE.ADD_DAYS(today, -1), "07:00", "Europe/Berlin")',
        '  end = DATETIME.AT(today, "07:00", "Europe/Berlin")',
        '  host = URL.HOST(msg.`text`)',
        '}',
      ].join('\n'),
      event: webhook({ text: 'https://BÜCHER.de/x' }),
      firedAt: new Date('2026-03-29T12:00:00Z'),
    });
  });

  it('asks the TypeScript member for a reading it does not reproduce, mid-run', async () => {
    // An offset-less date-time is local time, which only V8 knows here.
    const { rust } = await agree({
      source: [
        'movement m(msg: <inbox-[:message]->>) {',
        '  iso = DATE.FORMAT_ISO(msg.`text`)',
        '  later = msg.`text` > "2026-03-12T09:00"',
        '  if later {',
        '    day = DATE(msg.`text`)',
        '  }',
        '}',
      ].join('\n'),
      event: webhook({ text: '2026-03-12T09:30' }),
    });
    expect(rust.result).toBeDefined();
    expect(rustRunStats.hostCalls).toMatchObject({ 'builtins.function': 2, 'builtins.compare': 1 });
  });

  it('fails as the TypeScript engine fails: before the body, in it, and at the check', async () => {
    await agree({ source: BINDINGS_AND_IF, event: webhook({}), movementName: 'nope' });
    const { rust } = await agree({ source: BINDINGS_AND_IF, event: webhook({ subject: 'x', text: 'y' }), email: { failOn: 'text' } });
    expect('error' in rust && runFailureCause(rust.error)).toBeInstanceOf(FakeAdapterError);
    await agree({ source: BINDINGS_AND_IF.replace('msg.`subject`', 'msg.`nope`'), event: webhook({}) });
  });

  it('stops at the cancel gate, keeping what it traced', async () => {
    const gate = (cancelAt: number, finally_: boolean) => () => {
      let asked = 0;
      return { control: { cancel: { cancelled: async () => ++asked >= cancelAt, cancelledNow: async () => finally_, reason: () => null } } };
    };
    const { result } = await agree({ source: BINDINGS_AND_IF, event: webhook({ subject: 'Acme', text: 'deal' }), host: gate(4, false) });
    expect(result).toMatchObject({ cancelled: true, trace: [{ kind: 'gate', outcome: true }] });
    // A cancel stamped while the last statement ran is the last check's.
    const late = await agree({ source: BINDINGS_AND_IF, event: webhook({ subject: 'Acme', text: 'deal' }), host: gate(99, true) });
    expect(late.result?.cancelled).toBe(true);
  });

  it('declines, before it touches an adapter, what it does not run', async () => {
    resetRustRunStats();
    const resolved: unknown[] = [];
    const outcome = await runSegmentInRust({
      source: `${PRELUDE}type Stage = <"a" | "b">\nmovement m(msg: <inbox-[:message]->>) {\n  x = 1\n}`,
      event: webhook({}),
      teamId: TEAM_ID,
      catalog,
      host: makeTestHost({ adapters: { resolve: (r) => (resolved.push(r), fakeEmail().adapter) } }),
    });
    expect(outcome).toEqual({ declined: 'a file-level statement this engine does not run' });
    expect(resolved).toEqual([]);
    expect(rustRunStats.declined).toEqual({ 'a file-level statement this engine does not run': 1 });
    expect(rustRunStats.hostCalls).toEqual({ 'check.program': 1 });
  });
});
