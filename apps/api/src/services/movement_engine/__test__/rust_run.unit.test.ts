// Whole runs in the Rust engine (slice 2a), held to the TypeScript engine:
// each program runs under MOVEMENT_ENGINE=ts and =rust against the same
// fakes, and the two must agree on everything a caller can see — the
// result (or the error, its class and the very object a host call failed
// with), the trace, and every call the adapters received, in order.
//
// These programs are slice 2a's: reads of the event and of values, bindings,
// `if`, interpolation, `return`, the built-ins, the cancel gate. Writes and
// parks are rust_write.unit.test.ts's.

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';
import type { Adapter } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { MovementTraceEntry } from '../expression';

import { logger } from '../../logger';
import { containerAssociation } from '../../translation_graph/adapter';
import { positionData } from '../../translation_graph/types';
import { openRunContext } from '../run_context';
import { credentialIdsFor, makeTestHost, type TestHostOverrides } from '../test_host';
import { AdapterCallFailed } from '../host_adapter';
import { MovementRunFailed, runFailureCause, runMovement, type RunMovementInput } from '../run';
import { runSegmentInRust } from '../rust_engine';
import { resetRustEvalStats, resetRustRunStats, rustEvalStats, rustRunStats } from '../rust_stats';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000a1');

const emailSchema: InstanceSchema = {
  positions: {
    message: {
      properties: {
        subject: 'text',
        text: 'text',
        missing: 'text',
        meta: 'json',
        // Fields a case reads many of at once.
        ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', ...Array.from({ length: 20 }, (_, i) => `f${i}`)].map((f) => [f, 'text'])),
      },
      edges: {},
    },
  },
  collections: {},
  writableRoots: {},
};

const attioSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text', stage: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: {},
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

/** The fields the adapter was asked for, in order. */
function fieldsRead(calls: Array<{ method: string; input: unknown }>): unknown[] {
  return calls
    .filter((c) => c.method === 'getFieldValue')
    .map((c) => (typeof c.input === 'object' && c.input !== null ? Reflect.get(c.input, 'fieldId') : undefined));
}

function webhook(payload: Record<string, unknown>, extra: Partial<TriggerEvent> = {}): TriggerEvent {
  return { pipelineInputId: 'pi-rust-run', adapterType: 'email', triggerType: 'webhook', payload, ...extra };
}

interface Case {
  source: string;
  event: TriggerEvent;
  movementName?: string;
  firedAt?: string;
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
  const appends: MovementTraceEntry[][] = [];
  const input: RunMovementInput = {
    source: PRELUDE + c.source,
    event: c.event,
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    ...(c.movementName !== undefined ? { movementName: c.movementName } : {}),
    ...(c.firedAt !== undefined ? { firedAt: c.firedAt } : {}),
    host: makeTestHost({
      adapters: {
        resolve: (request) => {
          resolved.push(request);
          if (request.adapterType !== 'email') throw new Error(`test: no fake for ${request.adapterType}`);
          return email.adapter;
        },
      },
      trace: trace as never[],
      traceAppends: appends,
      ...c.host?.(),
    }),
  };
  try {
    const result = await runMovement(input);
    return { result, calls: email.calls, resolved, trace, appends };
  } catch (error) {
    return { error, calls: email.calls, resolved, trace, appends };
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
  expect(rustRunStats).toMatchObject({ routed: 1, notAdmitted: {}, declined: {} });
  expect(rustEvalStats).toEqual({ notAdmitted: 0, admitted: 0, answered: 0, fallback: {} });
  expect(rust.calls).toEqual(ts.calls);
  expect(rust.resolved).toEqual(ts.resolved);
  expect(rust.trace).toEqual(ts.trace);
  // The host is handed the trace a statement at a time, by both engines.
  expect(rust.appends).toEqual(ts.appends);
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
  it('is admitted for reads, bindings, if and return, and refused for anything more', async () => {
    const program = (body: string) => `movement m(msg: <inbox-[:message]->>) {\n${body}\n}`;
    expect(await admission(BINDINGS_AND_IF)).toBe('admitted');
    expect(await admission(program('  write crm-[:companies]-> { name: msg.`subject` }'))).toBe('admitted');
    expect(await admission(program('  write crm-[c:companies WHERE `name` == "x"]-> { name: "y" }'))).toBe('admitted');
    expect(await admission(program('  write crm-[c:companies WHERE EXISTS(c-[:deals]->)]-> { name: "y" }'))).toBe('expression:exists');
    expect(await admission(program('  co = write crm-[:companies]-> { name: "a" }\n  x = co'))).toBe('name_not_value');
    expect(await admission(program('  x = msg'))).toBe('name_not_value');
    expect(await admission(program('  x = AI("why?")'))).toBe('expression:llm');
    expect(await admission(program('  if msg IS <inbox-[:message]->> {\n    x = 1\n  }'))).toBe('is_test');
    expect(await admission(program('  x = crm.`name`'))).toBe('traversal_root');
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
      firedAt: '2026-03-29T12:00:00.000Z',
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

  it('reads twenty event fields in one expression, in order, one walk', async () => {
    // Each read is awaited where it is made: twenty reads, in the order the
    // TypeScript makes them, and the missing one traced as it is read.
    const fields = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const payload = Object.fromEntries(fields.filter((f) => f !== 'f7').map((f) => [f, f.toUpperCase()]));
    const { rust } = await agree({
      source: [
        'movement m(msg: <inbox-[:message]->>) {',
        `  all = CONCAT("<", ${fields.map((f) => `msg.\`${f}\``).join(', ')}, ">")`,
        '  return all',
        '}',
      ].join('\n'),
      event: webhook(payload),
    });
    expect('result' in rust).toBe(true);
    expect(fieldsRead(rust.calls)).toEqual(fields);
    expect(rustRunStats.hostCalls).toMatchObject({ 'adapters.call': 20, 'trace.append': 1 });
    expect(rust.trace).toEqual([expect.objectContaining({ kind: 'field_miss', field: 'f7' })]);
  });

  it('reads only the arm a conditional takes, at any depth', async () => {
    const source = [
      'movement m(msg: <inbox-[:message]->>) {',
      '  pick = IF msg.`a` == "A" THEN IF msg.`b` == "B" THEN msg.`c` ELSE msg.`d` END ELSE msg.`e` END',
      '  if msg.`a` == "A" AND msg.`b` == "B" {',
      '    left = msg.`c`',
      '  } else if msg.`e` == "E" {',
      '    right = msg.`d`',
      '  }',
      '  return pick',
      '}',
    ].join('\n');
    for (const [taken, reads] of [
      [{ a: 'A', b: 'B' }, 'a b c a b c'],
      [{ a: 'A', b: 'x' }, 'a b d a b e d'],
      [{ a: 'z', b: 'B' }, 'a e a e d'],
    ] as const) {
      const { rust } = await agree({ source, event: webhook({ c: 'C', d: 'D', e: 'E', ...taken }) });
      expect(fieldsRead(rust.calls).join(' ')).toBe(reads);
    }
  });

  it('awaits a read inside a function argument before the function', async () => {
    await agree({
      source: [
        'movement m(msg: <inbox-[:message]->>) {',
        '  slug = LOWER(CONCAT(TRIM(msg.`subject`), "-", COALESCE(msg.`missing`, UPPER(msg.`text`))))',
        '  n = LENGTH(TEXT.SLUG(msg.`subject`)) + LENGTH(msg.`text`)',
        '}',
      ].join('\n'),
      event: webhook({ subject: '  Big Deal ', text: 'hi' }),
    });
  });

  it('fails as the TypeScript engine fails: before the body, in it, and at the check', async () => {
    await agree({ source: BINDINGS_AND_IF, event: webhook({}), movementName: 'nope' });
    const { rust } = await agree({ source: BINDINGS_AND_IF, event: webhook({ subject: 'x', text: 'y' }), email: { failOn: 'text' } });
    // The adapter's failure crosses the host boundary as data and is raised
    // under its own name, as the TypeScript engine raises it.
    const cause = 'error' in rust ? runFailureCause(rust.error) : undefined;
    expect(cause).toBeInstanceOf(AdapterCallFailed);
    expect(cause).toMatchObject({ name: 'FakeAdapterError', message: 'no text today' });
    await agree({ source: BINDINGS_AND_IF.replace('msg.`subject`', 'msg.`nope`'), event: webhook({}) });
  });

  it('logs, and never fails on, a trace hand-over lost as the segment ends', async () => {
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const previous = process.env.MOVEMENT_ENGINE;
    process.env.MOVEMENT_ENGINE = 'rust';
    try {
      const email = fakeEmail({ failOn: 'text' });
      const host = makeTestHost({ adapters: { resolve: () => email.adapter } });
      host.trace = {
        append: async () => {
          throw new Error('the trace store is down');
        },
      };
      // The gate is traced, then the arm fails: the gate is handed over only
      // as the segment ends, and that hand-over fails.
      const error = await runMovement({
        source: PRELUDE + 'movement m(msg: <inbox-[:message]->>) {\n  if msg.`subject` == "Acme" {\n    t = msg.`text`\n  }\n}',
        event: webhook({ subject: 'Acme', text: 'x' }),
        teamId: TEAM_ID,
        catalog,
        credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
        host,
      }).catch((e: unknown) => e);
      expect(runFailureCause(error)).toBeInstanceOf(AdapterCallFailed);
      expect(logged).toHaveBeenCalledWith(
        '[movement] a segment that ended could not hand the host the rest of its trace',
        expect.objectContaining({ error: 'the trace store is down' }),
      );
    } finally {
      if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
      else process.env.MOVEMENT_ENGINE = previous;
      logged.mockRestore();
    }
  });

  it('stops at the cancel gate, keeping what it traced', async () => {
    const gate = (cancelAt: number, finally_: boolean) => () => {
      let asked = 0;
      return { control: { cancel: { cancelled: async () => ++asked >= cancelAt, cancelledNow: async () => finally_ } } };
    };
    const { result } = await agree({ source: BINDINGS_AND_IF, event: webhook({ subject: 'Acme', text: 'deal' }), host: gate(4, false) });
    expect(result).toMatchObject({ cancelled: true, trace: [{ kind: 'gate', outcome: true }] });
    // A cancel stamped while the last statement ran is the last check's.
    const late = await agree({ source: BINDINGS_AND_IF, event: webhook({ subject: 'Acme', text: 'deal' }), host: gate(99, true) });
    expect(late.result?.cancelled).toBe(true);
  });

  it('refuses, on its own parse and before it asks its host anything, what it does not run', async () => {
    const movement = (body: string) => `movement m(msg: <inbox-[:message]->>) {\n${body}\n}`;
    // One program per construct admission refuses: each costs a parse and
    // the walk, never a check, an adapter or a trace entry.
    for (const [source, reason] of [
      [`r = extract from ["a"] {\n  node n: "n" { a: "a" }\n}\n${movement('  x = 1')}`, 'file_assignment'],
      [`y = crm.\`name\`\n${movement('  x = 1')}`, 'traversal_root'],
      [`movement v(n: <number[]>) {\n  x = 1\n}\n${movement('  x = 1')}`, 'movement_value_param'],
      [movement('  inbox = 1'), 'name_shadowed'],
      [movement('  x = 1\n  x = write crm-[:companies]-> { name: "a" }'), 'name_rebound'],
      [movement('  crm-[c:companies]-> {\n    x = 1\n  }\n  c = 1'), 'name_rebound'],
      [movement('  crm-[c:companies]-> {\n    await sleep(1h)\n  }'), 'block_park'],
      [movement('  rows = crm-[c:companies]-> {\n    return c\n  }'), 'name_not_value'],
      [movement('  x = await inbox-[:message]->'), 'await_not_sleep'],
      [movement('  r = m(msg: msg)'), 'movement_call'],
      [movement('  r = M(msg)'), 'function_call'],
      [movement('  write crm-[:companies]-> bind co { name: "a" }'), 'write_bind'],
      [movement('  write crm-[c:companies WHERE EXISTS(c-[:deals]->)]-> { name: "y" }'), 'expression:exists'],
      [movement('  n = node { a: 1 }\n  link n -[:kids]-> n'), 'link_node'],
      [movement('  write crm-[:companies]-> { unique by (`name` CONTAINS "a") name: "a" }'), 'unique_by_without_key'],
      [movement('  write crm-[:companies]-> { ...crm }'), 'write_spread_source'],
      [movement('  g = graph { owner: msg }'), 'node_event_entry'],
      [movement('  x = msg-[:replies]->.`subject`'), 'traversal_steps'],
      [movement('  x = { __proto__: 1 }'), 'proto_key'],
      [movement('  x = msg.`subject` WITHIN "7d"'), 'within_compare'],
      [movement('  x = FIRST(msg.`subject`)'), 'expression:aggregate'],
      [movement('  if msg IS <inbox-[:message]->> {\n    x = 1\n  }'), 'is_test'],
      // Main's v0.10.2–v0.10.9 constructs (rust_language_changes.unit.test.ts runs each on both engines).
      [movement('  held = { k: 1 }\n  write held.k { a: 1 }'), 'write_position_member_path'],
      [movement('  held = { k: { name: "a" } }\n  write crm-[:companies]-> { ...held.k }'), 'write_spread_path'],
      [movement('  held = { k: { name: "a" } }\n  g = graph { ...held.k }'), 'node_spread_path'],
      [movement('  n = node { name: "a" }\n  write n { name: "b" }'), 'write_position_not_record'],
      [movement('  x = { all: MAP([msg.`subject`], (s) => UPPER(s)) }'), 'expression_closure'],
      [movement('  held = { k: { inner: 1 } }\n  x = held.k.inner'), 'traversal_terminal'],
      // A call of a plugin the snapshot does not describe, in each of its spellings.
      [`import { fetch_url } from plugins\n${movement('  x = fetch_url(url: msg.`text`)')}`, 'plugin_call'],
      [`import { fetch_url } from plugins\n${movement('  x = fetch_url()')}`, 'plugin_call'],
      [`import { fetch_url } from plugins\n${movement('  fetch_url(url: msg.`text`)')}`, 'plugin_call'],
      [`import { fetch_url } from plugins\n${movement('  x = { page: fetch_url(msg.`text`) }')}`, 'plugin_call'],
      [`import { fetch_url } from plugins\npage = fetch_url()\n${movement('  x = 1')}`, 'file_call'],
      [`import { fetch_url } from plugins\npage = fetch_url(url: "x")\n${movement('  x = 1')}`, 'file_call'],
      // An extraction this engine does not run (chunk 6A Task 3b runs the rest).
      [movement('  found = extract "careful" from [msg.`text`] {\n    name: "a"\n  }'), 'extract_tier'],
      [movement('  found = extract from [msg.`text`] {\n    node co: "c" { name: "a" }\n  }\n  found-[c:co WHERE `name` == "x"]-> {\n    x = c.`name`\n  }'), 'block_head_extract_hop'],
      [movement('  found = extract from [msg.`text`] {\n    node co: "c" { name: "a" }\n  }\n  found-[f:_resources]-> {\n    x = 1\n  }'), 'block_head_resources'],
      [movement('  found = extract from [msg.`text`] {\n    name: "a"\n  }\n  write crm-[:companies]-> { ...found }'), 'write_spread_source'],
      [movement('  found = extract from [msg.`text`] {\n    name: "a"\n  }\n  x = found'), 'name_not_value'],
      [movement('  return extract from [msg.`text`] {\n    name: "a"\n  }'), 'rvalue:extract'],
      [`node Deal { name: <text> }\n${movement('  g = graph<Deal> { name: "a" }')}`, 'graph_shape'],
    ] as const) {
      resetRustRunStats();
      const { outcome, resolved } = await segmentOf(source);
      expect([source, outcome]).toEqual([source, { declined: reason }]);
      expect(resolved).toEqual([]);
      expect(rustRunStats.notAdmitted).toEqual({ [reason]: 1 });
      expect(rustRunStats.declined).toEqual({});
      expect(rustRunStats.hostCalls).toEqual({});
    }
  });
});

/** One segment of `source` (after the prelude) in the Rust engine, on a
 *  webhook with an empty payload: its outcome, or the error it ended in,
 *  and what the resolver was asked. */
async function segmentOf(source: string) {
  const resolved: unknown[] = [];
  const host = makeTestHost({ adapters: { resolve: (r) => (resolved.push(r), fakeEmail().adapter) } });
  const context = await openRunContext({ host, teamId: TEAM_ID, languageVersion: 3, spend: {} });
  const input = { source: PRELUDE + source, event: webhook({}), teamId: TEAM_ID, catalog, host };
  try {
    return { outcome: await runSegmentInRust({ input, context }), resolved };
  } catch (error) {
    return { outcome: { error }, resolved };
  }
}

/** Whether the Rust engine admits `source`: `admitted`, or its refusal's
 *  reason. */
async function admission(source: string): Promise<string> {
  resetRustRunStats();
  await segmentOf(source);
  const [reason] = Object.keys(rustRunStats.notAdmitted);
  if (reason !== undefined) return reason;
  // Admitted: it ran in Rust, to its end or its own failure.
  expect(rustRunStats).toMatchObject({ notAdmitted: {}, admitted: 1, ranWhole: 1 });
  return 'admitted';
}
