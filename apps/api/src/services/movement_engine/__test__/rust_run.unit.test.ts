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
import { makeStablePosition, positionData } from '../../translation_graph/types';
import { openRunContext } from '../run_context';
import { credentialIdsFor, makeTestHost, endedInRust, type TestHostOverrides } from '../test_host';
import { AdapterCallFailed } from '../host_adapter';
import { MovementRunFailed, runFailureCause, runMovement, type RunMovementInput } from '../run';
import { MovementEngineError, isCheckFailure } from '../errors';
import { ENDED_AT_CHECK, LOCAL_ZONE_UNVERIFIED, processLocalZone, runSegmentInRust } from '../rust_engine';
import { checkPinned } from '../program_check';
import { resetRustEvalStats, resetRustRunStats, rustEvalStats, rustRunStats, setRunEngineRecorder, type RunEngineRecord } from '../rust_stats';

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
  positions: {
    company: { properties: { name: 'text', stage: 'text' }, edges: { deals: { target: 'bag' } } },
    // Open: the checker lets a `#`-prefixed hop through, as it does over an undescribed position.
    bag: { properties: {}, edges: {}, openProperties: true },
  },
  collections: { companies: { target: 'company' }, bags: { target: 'bag' } },
  writableRoots: { company: { fields: { name: 'text', stage: 'text' }, resultShape: { externalId: 'text', name: 'text', stage: 'text' } } },
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
  /** The checker refuses it: the run ends at its check on either engine,
   *  and the Rust one is never asked. A case says so, or fails. */
  endsAtCheck?: true;
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
  // A run that fails its check ends there on either engine, before its
  // segment opens: the Rust route checks where the TypeScript route does.
  expect(isCheckFailure('error' in rust ? rust.error : undefined)).toBe(c.endsAtCheck === true);
  expect(rustRunStats).toMatchObject({ ...endedInRust('error' in rust ? rust.error : undefined), notAdmitted: {}, declined: {} });
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
    expect(await admission(program('  write crm-[c:companies WHERE EXISTS(c-[:deals]->)]-> { name: "y" }'))).toBe('admitted');
    expect(await admission(program('  co = write crm-[:companies]-> { name: "a" }\n  x = co'))).toBe('admitted');
    expect(await admission(program('  co = write crm-[:companies]-> { name: "a" }\n  x = [co]'))).toBe('admitted');
    expect(await admission(program('  x = msg'))).toBe('admitted');
    expect(await admission(program('  x = AI("why?")'))).toBe('admitted');
    // CHUNKS runs since PLAN-08A group F′; a bound write stays refused by name.
    expect(await admission(program('  x = CHUNKS("why?", { size: 4 })'))).toBe('admitted');
    expect(await admission(program('  co = write crm-[:companies]-> { name: "a" }\n  refresh co'))).toBe('statement:refresh');
    // The retired KG_VALUE fails the run as the TypeScript's evaluator fails it.
    expect(await admission(program('  x = KG_VALUE("why?")'))).toBe('admitted');
    expect(await admission(program('  if msg IS <inbox-[:message]->> {\n    x = 1\n  }'))).toBe('admitted');
    expect(await admission(program('  x = crm.`name`'))).toBe('admitted');
    expect(await admission(program('  x = MAP([1], { concurrency: 4 }, (v) => { return v })'))).toBe('admitted');
    // A collection op inside an expression, since PLAN-08A group C.
    expect(await admission(program('  x = { all: MAP([1], (v) => v) }'))).toBe('admitted');
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

  describe('host data is never read as an engine object', () => {
    // Henry's ruling (2026-10-10): the content of data never changes how it
    // is treated. A webhook body, an adapter's answer, an ask's answer or a
    // callback's fire values whose dicts carry a binding's `kind` are dicts.
    // Both engines know an engine object by how it was made, never by its
    // keys, so each assertion holds of each engine, and the two agree.
    const body = (...lines: string[]) => ['movement m(msg: <inbox-[:message]->>) {', '  v = msg.`meta`', ...lines, '}'].join('\n');
    /** The exploit: a webhook field shaped like a kept walk, whose mapping
     *  holds program text and whose head walks the source. */
    const keptWalk = (raw: string) => ({
      kind: 'lazyWalk',
      walk: {
        captured: [['e', { kind: 'event' }]],
        head: { root: { kind: 'name', name: 'e' }, hopsRaw: '-[:items]->' },
        mapping: { entries: [{ kind: 'value', name: 'x', value: { raw } }] },
      },
    });
    /** One run of `c` on `engine`, every adapter method it called counted. */
    const onEngine = async (engine: 'ts' | 'rust', c: Case) => {
      const called: string[] = [];
      const counting = (): TestHostOverrides => ({
        adapters: {
          resolve: () =>
            new Proxy(fakeEmail().adapter, {
              get(target, key, receiver) {
                const member: unknown = Reflect.get(target, key, receiver);
                if (typeof member !== 'function' || typeof key !== 'string') return member;
                return (...args: unknown[]) => {
                  called.push(key);
                  return Reflect.apply(member, target, args);
                };
              },
            }),
        },
      });
      resetRustRunStats();
      const run = await runOn(engine, { ...c, host: counting });
      if (engine === 'rust') expect(rustRunStats).toMatchObject({ ...endedInRust('error' in run ? run.error : undefined), notAdmitted: {}, declined: {} });
      return { ...run, called, ended: String(runFailureCause('error' in run ? run.error : undefined)) };
    };
    /** `c` on both engines, each held to `expectOf`, the two agreeing. */
    const onBoth = async (c: Case, expectOf: (run: Awaited<ReturnType<typeof onEngine>>) => void) => {
      const [ts, rust] = [await onEngine('ts', c), await onEngine('rust', c)];
      expectOf(ts);
      expectOf(rust);
      expect(rust.called).toEqual(ts.called);
      expect(rust.ended).toBe(ts.ended);
      expect(rust.trace).toEqual(ts.trace);
    };

    it('reads a field shaped like a kept walk as data: one field read, no walk, no program text run', async () => {
      for (const raw of ['COUNT(e-[:items]->)', 'NOSUCHFN(1)']) {
        await onBoth({ source: body('  n = COUNT(v-[:subs]->)', '  ERROR("${n}")'), event: webhook({ meta: keptWalk(raw) }) }, (run) => {
          expect(run.called.filter((m) => m === 'getFieldValue')).toHaveLength(1);
          expect(run.called).not.toContain('getRelated');
          expect(run.called).not.toContain('iterateRelated');
          expect(run.ended).toContain("traversing from a value binding ('v')");
          expect(JSON.stringify([run.ended, run.trace, run.appends])).not.toContain('NOSUCHFN');
        });
      }
    });

    it('reads its kind as the text it is, and prints it as a dict', async () => {
      for (const meta of [keptWalk('1'), { kind: 'closure' }, { kind: 'positions', landings: [{ kind: 'event' }] }, { kind: 'constructor' }, { kind: 'event' }]) {
        await onBoth({ source: body('  ERROR("${v.`kind`} ${TEXT.SERIALISE(v, "JSON")}")'), event: webhook({ meta }) }, (run) => {
          expect(run.ended).toMatch(new RegExp(`^MovementEngineError: MOVENG_ERROR: ${meta.kind} \\{[\\s\\S]*"kind": ?"${meta.kind}"`));
          expect(run.called.filter((m) => m === 'getFieldValue')).toHaveLength(1);
        });
      }
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
    // A pattern nested past 1,000 groups, which V8's stack decides.
    const pattern = `${'(?:'.repeat(1001)}a${')'.repeat(1001)}`;
    const { rust } = await agree({
      source: ['movement m(msg: <inbox-[:message]->>) {', `  found = TEXT.REGEX_EXTRACT(msg.\`text\`, "${pattern}")`, '}'].join('\n'),
      event: webhook({ text: 'xay' }),
    });
    expect(rust.result).toBeDefined();
    expect(rustRunStats.hostCalls).toMatchObject({ 'builtins.function': 1 });
  });

  // Jest hands each suite a copy of the environment, so assigning `TZ` here
  // moves no clock: these run in the zone the process started in, and
  // local_zone_matrix.unit.test.ts starts them under each zone of its own.
  it("reads a date text as TypeScript does, asking no TypeScript member, in this process's zone", async () => {
    expectZoneStanding(processLocalZone());
    if (processLocalZone() === undefined) return;
    resetRustRunStats();
    const { rust } = await agree({
      source: [
        'movement m(msg: <inbox-[:message]->>) {',
        '  iso = DATE.FORMAT_ISO(msg.`text`)',
        '  later = msg.`text` > "March 8, 2026 1:45 AM"',
        '  if later {',
        '    day = DATE(msg.`text`)',
        '  }',
        '}',
      ].join('\n'),
      event: webhook({ text: '2026-03-08T02:30' }),
    });
    expect(rust.result).toBeDefined();
    expect(rustRunStats.hostCalls['builtins.function']).toBeUndefined();
    expect(rustRunStats.hostCalls['builtins.compare']).toBeUndefined();
  });

  it("pins an offset-less firing instant as new Date(firedAt) reads it, in this process's zone", async () => {
    expectZoneStanding(processLocalZone());
    if (processLocalZone() === undefined) return;
    // Under Europe/London, 12:00 on 15 July is 11:00Z on both engines; a
    // pin read otherwise fails the run (DATE.ADD_DAYS past the end of time).
    const pinned = new Date('2026-07-15T12:00').toISOString();
    const run = (firedAt: string) =>
      agree({
        source: ['movement m(msg: <inbox-[:message]->>) {', '  pin = @current_timestamp', `  if pin != DATETIME("${pinned}") {`, '    bad = DATE.ADD_DAYS("2026-01-01", 1000000000)', '  }', '}'].join('\n'),
        event: webhook({}),
        firedAt,
      });
    const first = (await run('2026-07-15T12:00')).rust;
    expect('result' in first).toBe(true);
    expect('error' in (await run('2026-07-15T12:00:00Z')).rust).toBe(processLocalZone() !== 'UTC' && pinned !== '2026-07-15T12:00:00.000Z');
  });

  it("refuses a run by name when Intl cannot name the zone Date reads in, in this process's zone", async () => {
    expectZoneStanding(processLocalZone());
    if (processLocalZone() !== undefined) return;
    resetRustRunStats();
    const { outcome, resolved } = await segmentOf('movement m(msg: <inbox-[:message]->>) {\n  x = 1\n}');
    expect(outcome).toEqual({ declined: LOCAL_ZONE_UNVERIFIED });
    expect(resolved).toEqual([]);
    expect(rustRunStats.notAdmitted).toEqual({ [LOCAL_ZONE_UNVERIFIED]: 1 });
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
    await agree({ source: BINDINGS_AND_IF.replace('msg.`subject`', 'msg.`nope`'), event: webhook({}), endsAtCheck: true });
    // A source neither parser reads: the check's own parse error, before a
    // segment opens on either engine, never refused.
    const { rust: unparsed } = await agree({ source: 'movement m(msg: <inbox-[:message]->>) {\n  g = graph { ?...msg }\n}', event: webhook({}), endsAtCheck: true });
    expect(String('error' in unparsed ? unparsed.error : '')).toContain('MOVENG_PARSE');
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
      [movement('  inbox = 1'), 'name_shadowed'],
      [movement('  x = 1\n  x = write crm-[:companies]-> { name: "a" }'), 'name_rebound'],
      [movement('  crm-[c:companies]-> {\n    x = 1\n  }\n  c = 1'), 'name_rebound'],
      // A call whose value is not one kind on every path; a call of a name that is no function.
      [`movement pick(e: <inbox-[:message]->>) {\n  if e.\`subject\` == "a" {\n    return node { a: 1 }\n  }\n  return 1\n}\n${movement('  r = pick(e: msg)')}`, 'movement_call'],
      [movement('  x = 1\n  r = x(2)'), 'function_call'],
      [movement('  write crm-[:companies]-> bind co { name: "a" }'), 'write_bind'],
      // A collection op that runs members at once (chunk 7A Task 3 runs them one at a time).
      // The expression tail this engine does not run (chunk 6A Task 4 runs the rest).
      [movement('  x = SORT([1], UPPER("a"))'), 'aggregate:sort_key'],
      [movement('  x = LLM_AGG(["a"], "sum it")'), 'aggregate:llm'],
      [movement('  if EXISTS(msg-[:files]->-[#transform]->) {\n    x = 1\n  }'), 'exists_step'],
      [movement('  x = msg-[:files]->-[#transform]->.`name`'), 'traversal_step'],
      // A `#`-prefixed edge is the engine's own meta reference: refused, not answered differently.
      [movement('  crm-[b:bags]-> {\n    x = FIRST(b-[:#foo]->)\n  }'), 'traversal_meta_edge'],
      [movement('  crm-[b:bags]-> {\n    b-[:#foo]-> {\n      y = 1\n    }\n  }'), 'traversal_meta_edge'],
      [movement('  crm-[b:bags]-> {\n    write b-[:#foo]-> { name: "a" }\n  }'), 'traversal_meta_edge'],
      [movement('  write crm-[:companies]-> { unique by (`name` CONTAINS "a") name: "a" }'), 'unique_by_without_key'],
      [movement('  g = graph { owner: msg }'), 'node_event_entry'],
      [movement('  x = msg.`subject` WITHIN "7d"'), 'within_compare'],
      // Main's v0.10.2–v0.10.9 constructs (rust_language_changes.unit.test.ts runs each on both engines).
      // `...m.k` in a graph off a root that is no value (a value's member runs since PLAN-08A group E).
      [movement('  g = graph { ...msg.k }'), 'node_spread_path'],
      // A call of a plugin the snapshot does not describe, in each of its spellings.
      [`import { fetch_url } from plugins\n${movement('  x = fetch_url(url: msg.`text`)')}`, 'plugin_call'],
      [`import { fetch_url } from plugins\n${movement('  x = fetch_url()')}`, 'plugin_call'],
      [`import { fetch_url } from plugins\n${movement('  fetch_url(url: msg.`text`)')}`, 'plugin_call'],
      [`import { fetch_url } from plugins\n${movement('  x = { page: fetch_url(msg.`text`) }')}`, 'plugin_call'],
      // A record the TypeScript would hand its host as the binding object,
      // or whose internals a reading would hand out.
      [movement('  rows = crm-[c:companies]->\n  top = FIRST(rows)\n  x = TEXT.REGEX_EXTRACT(top, "x")'), 'builtin_arg_record'],
      [movement('  co = write crm-[:companies]-> { name: "a" }\n  write crm-[:companies]-> { name: co }'), 'write_field_record'],
      [movement('  rows = crm-[c:companies]->\n  top = FIRST(rows)\n  key = "kind"\n  a = AT(top, key)'), 'at_record_key'],
    ] as const) {
      resetRustRunStats();
      const { outcome, resolved } = await segmentOf(source);
      expect([source, outcome]).toEqual([source, { declined: reason }]);
      expect(resolved).toEqual([]);
      expect(rustRunStats.notAdmitted).toEqual({ [reason]: 1 });
      expect(rustRunStats.declined).toEqual({});
      expect(rustRunStats.hostCalls).toEqual({});
      // The run itself is the TypeScript engine's, whichever engine is asked.
      const [ts, rust] = [await runOn('ts', { source, event: webhook({ subject: 'Acme' }) }), await runOn('rust', { source, event: webhook({ subject: 'Acme' }) })];
      expect('error' in rust ? String(rust.error) : JSON.stringify(rust.result)).toBe('error' in ts ? String(ts.error) : JSON.stringify(ts.result));
      expect(rust.calls).toEqual(ts.calls);
    }
    // A refused run counts once under its first reason, and once under
    // each reason it holds: the walk goes on past the first.
    resetRustRunStats();
    const many = movement('  write crm-[:companies]-> bind msg { name: "a" }\n  y = FIRST(crm-[:#foo]->)\n  write crm-[:companies]-> bind msg { name: "b" }\n  if msg.`subject` WITHIN "7d" {\n    w = 1\n  }');
    const { outcome, resolved } = await segmentOf(many);
    expect(outcome).toEqual({ declined: 'write_bind' });
    expect(resolved).toEqual([]);
    expect(rustRunStats).toMatchObject({
      notAdmitted: { write_bind: 1 },
      allReasons: { write_bind: 1, traversal_meta_edge: 1, within_compare: 1 },
      declined: {},
      hostCalls: {},
    });
  });
});

describe('IS <Decl> of a record a system describes', () => {
  // Chunk 7A Task 6: compared by the record type's schema with the
  // checker's own assignability (`check.compatible`), as run.ts
  // `evaluateDeclaredNodeTest` compares it.
  const movement = (body: string) => `movement m(msg: <inbox-[:message]->>) {\n${body}\n}`;
  it('takes the arm the TypeScript engine takes, the event, a second name of it, and a landed record, whole on Rust', async () => {
    for (const [declaration, body] of [
      ['node Fits { subject: <text> }', '  if msg IS <Fits> {\n    return "fits"\n  }\n  return "does not"'],
      ['node Lacks { nowhere: <text> }', '  m2 = msg\n  m3 = m2\n  if m3 IS <Lacks> {\n    return "fits"\n  }\n  return "does not"'],
      ['node Typed { subject: <number> }', '  if msg IS <Typed> {\n    return "fits"\n  }\n  return "does not"'],
    ] as const) {
      // An undiscriminated webhook: both engines stop, naming why (the
      // corpora's `IS` cases take each arm on a typed event).
      await agree({ source: `${declaration}\n${movement(body)}`, event: webhook({ subject: 'Acme' }) });
      expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, notAdmitted: {}, declined: {} });
    }
  });
});

describe('a `_resources` head', () => {
  // PLAN-08A group D: the record's bundle through the event's source
  // (`resolvePositionResources`), each resource without an id given one, the
  // hop's WHERE read over each resource with it current.
  const movement = (body: string) => `movement m(msg: <inbox-[:message]->>) {\n${body}\n}`;
  const resources = [
    { externalId: 'att-1', type: 'FILE', name: 'pitch.pdf', fileRef: { __brand: 'FileRef', name: 'pitch.pdf', source: { adapterType: 'email', handle: 'h-1' } }, data: { filename: 'pitch.pdf', type: 'FILE' } },
    { externalId: 'txt-1', type: 'TEXT', name: 'body', data: { type: 'TEXT', content: 'hello' } },
  ];
  const withResources = (): TestHostOverrides => {
    const email = fakeEmail();
    const adapter: Adapter = {
      ...email.adapter,
      getRelated: async ({ fieldId }) =>
        fieldId === '_resources'
          ? resources.map((data, i) => ({ position: makeStablePosition({ adapterType: 'email', recordType: 'resource', recordId: `r-${i}`, data }) }))
          : [],
    };
    return { adapters: { resolve: () => adapter } };
  };
  it('walks the bundle and filters it by its WHERE as the TypeScript engine does, whole on Rust', async () => {
    for (const body of [
      '  names = msg-[f:_resources]-> {\n    return f.`filename`\n  }\n  return names',
      '  files = msg-[f:_resources WHERE type == "FILE"]-> {\n    return "${f.`filename`}: ${f.`type`}"\n  }\n  return files',
      '  msg-[f:_resources WHERE contentType == "audio/ogg"]-> {\n    return "never"\n  }\n  return "none"',
    ]) {
      await agree({ source: movement(body), event: webhook({ subject: 'Acme' }), host: withResources });
      expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, notAdmitted: {}, declined: {} });
    }
  });
});

describe('the file scope, as interpretFileStatement reads it', () => {
  // Chunk 7A Task 6: a file-level extraction, block, write or call fails the
  // run with the TypeScript's own error before any body; any other
  // right-hand side binds nothing; a file-level statement runs nothing.
  const movement = (body: string) => `movement m(msg: <inbox-[:message]->>) {\n${body}\n}`;
  it('fails, binds nothing or runs nothing on both engines alike, whole on Rust', async () => {
    // Where the run ends: in the engine (`segment`), or at the check, before
    // a segment opens, on either engine (`check`: the snapshot describes no
    // `fetch_url`).
    for (const [source, ends] of [
      [`r = extract from ["a"] {\n  node n: "n" { a: "a" }\n}\n${movement('  x = 1')}`, 'segment'],
      [`import { fetch_url } from plugins\npage = fetch_url(url: "x")\n${movement('  x = 1')}`, 'check'],
      [`w = write crm-[:companies]-> { name: "a" }\n${movement('  x = 1')}`, 'segment'],
      [`write crm-[:companies]-> { name: "a" }\n${movement('  x = msg.\`subject\`')}`, 'segment'],
      [`n = node { title: "t" }\n${movement('  x = n.\`title\`')}`, 'segment'],
    ] as const) {
      await agree({ source, event: webhook({ subject: 'Acme' }), ...(ends === 'check' ? { endsAtCheck: true as const } : {}) });
      expect(rustRunStats).toMatchObject({
        ...(ends === 'segment' ? { routed: 1, admitted: 1 } : { routed: 0, endedAtCheck: 1 }),
        notAdmitted: {},
        declined: {},
      });
    }
  });
});

describe('a program that fails its check', () => {
  // Fails its check: the snapshot describes no `fetch_url`.
  const failing = `import { fetch_url } from plugins\npage = fetch_url(url: "x")\nmovement m(msg: <inbox-[:message]->>) {\n  x = 1\n}`;
  /** A host that notes every segment it opens and every adapter resolved. */
  const noting = (seen: string[]) =>
    makeTestHost({
      segment: { open: async () => (seen.push('segment.open'), { segmentId: `s${seen.length}` }) },
      adapters: { resolve: () => (seen.push('adapters.resolve'), fakeEmail().adapter) },
    });

  afterEach(() => {
    setRunEngineRecorder(undefined);
    delete process.env.MOVEMENT_ENGINE;
  });

  it.each(['ts', 'rust'] as const)('makes no host request on the %s engine, segment.open included, and logs why on Rust', async (engine) => {
    process.env.MOVEMENT_ENGINE = engine;
    resetRustRunStats();
    const seen: string[] = [];
    const recorded: RunEngineRecord[] = [];
    setRunEngineRecorder((record) => recorded.push(record));
    const logged = jest.spyOn(logger, 'info');
    const error: unknown = await runMovement({
      source: PRELUDE + failing,
      event: webhook({}),
      teamId: TEAM_ID,
      runId: 'run-check',
      catalog,
      credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
      host: noting(seen),
    }).catch((e: unknown) => e);
    expect(isCheckFailure(error)).toBe(true);
    expect(seen).toEqual([]);
    if (engine === 'rust') {
      expect(rustRunStats).toMatchObject({ routed: 0, admitted: 0, ranWhole: 0, endedAtCheck: 1, notAdmitted: {}, declined: {} });
      expect(recorded).toEqual([{ runId: 'run-check', engine: 'rust', reason: ENDED_AT_CHECK }]);
      expect(logged).toHaveBeenCalledWith(`movement engine: engine=rust run=run-check reason=${ENDED_AT_CHECK}`);
    }
    logged.mockRestore();
  });

  it('driven into the shim with no check first, ends at the engine’s own check, counted and logged as that ending, never routed', async () => {
    resetRustRunStats();
    const seen: string[] = [];
    const recorded: RunEngineRecord[] = [];
    setRunEngineRecorder((record) => recorded.push(record));
    const host = noting(seen);
    // The caller opened the segment itself: the order run.ts no longer takes.
    const context = await openRunContext({ host, teamId: TEAM_ID, languageVersion: 3, spend: {} });
    const input = { source: PRELUDE + failing, event: webhook({}), teamId: TEAM_ID, runId: 'run-direct', catalog, host };
    const error: unknown = await runSegmentInRust({ input, context }).catch((e: unknown) => e);
    expect(isCheckFailure(error)).toBe(true);
    expect(seen).toEqual(['segment.open']);
    expect(rustRunStats).toMatchObject({ routed: 0, admitted: 0, ranWhole: 0, endedAtCheck: 1 });
    expect(recorded).toEqual([{ runId: 'run-direct', engine: 'rust', reason: ENDED_AT_CHECK }]);
  });
});

describe('the run counts', () => {
  it('count a refusal only for a run the Rust engine did not run, and a whole run under no reason', async () => {
    resetRustRunStats();
    const runs = [
      'movement m(msg: <inbox-[:message]->>) {\n  co = write crm-[:companies]-> { name: "a" }\n  refresh co\n}',
      'movement m(msg: <inbox-[:message]->>) {\n  s = msg.`subject`\n}',
      'movement m(msg: <inbox-[:message]->>) {\n  y = msg.`subject` WITHIN "7d"\n  co = write crm-[:companies]-> { name: "b" }\n  refresh co\n}',
      // Fails its check (`crm` has no `#foo`), so never reaches the engine.
      'movement m(msg: <inbox-[:message]->>) {\n  y = FIRST(crm-[:#foo]->)\n}',
      'movement m(msg: <inbox-[:message]->>) {\n  return UPPER(msg.`subject`)\n}',
    ];
    for (const source of runs) await runOn('rust', { source, event: webhook({ subject: 'Acme' }) });
    // `routed` counts every segment the engine started, its admission's
    // refusals among them; the refused ones are exactly `routed - admitted`,
    // and each is under one first reason.
    expect(rustRunStats).toMatchObject({ routed: 4, admitted: 2, ranWhole: 2, endedAtCheck: 1, declined: {} });
    const refused = Object.values(rustRunStats.notAdmitted).reduce((a, b) => a + b, 0);
    expect(refused).toBe(rustRunStats.routed - rustRunStats.admitted);
    expect(rustRunStats.notAdmitted).toEqual({ 'statement:refresh': 1, within_compare: 1 });
    expect(rustRunStats.allReasons).toEqual({ 'statement:refresh': 2, within_compare: 1 });
  });
});

describe('admission walks what the entry reaches', () => {
  const helper = (body: string) => `movement helper(e: <inbox-[:message]->>) {\n${body}\n}\n`;
  const entry = (body: string) => `movement m(msg: <inbox-[:message]->>) {\n${body}\n}\n`;

  it('runs a program whose unreached helper holds what this engine does not run, as the TypeScript engine does', async () => {
    for (const unsupported of ['  x = e.`subject` WITHIN "7d"', '  crm-[b:bags]-> {\n    x = FIRST(b-[:#foo]->)\n  }', '  r = await parallel([() => {\n    y = 1\n  }])']) {
      const { result } = await agree({
        source: `${helper(unsupported)}${entry('  s = msg.`subject`\n  return UPPER(s)')}`,
        event: webhook({ subject: 'Acme' }),
        movementName: 'm',
      });
      expect(rustRunStats).toMatchObject({ routed: 1, admitted: 1, ranWhole: 1, notAdmitted: {}, allReasons: {} });
      expect(result?.movementName).toBe('m');
    }
  });

  it('refuses what a reached helper holds, under every reason on the way to it', async () => {
    resetRustRunStats();
    // The call itself is admitted (chunk 7A Task 2): the callee's own
    // reason refuses, and the walk goes on past it.
    const { outcome } = await segmentOfMovement(`${entry('  helper(e: msg)\n  y = FIRST(crm-[:#foo]->)')}${helper('  write crm-[:companies]-> bind e { name: "a" }')}`, 'm');
    expect(outcome).toEqual({ declined: 'traversal_meta_edge' });
    expect(rustRunStats).toMatchObject({ notAdmitted: { traversal_meta_edge: 1 }, allReasons: { traversal_meta_edge: 1, write_bind: 1 }, hostCalls: {} });
  });

  it('runs a reached helper the entry calls, as the TypeScript engine does', async () => {
    const { result } = await agree({
      source: `${entry('  s = shout(e: msg)\n  return s')}movement shout(e: <inbox-[:message]->>) {\n  return UPPER(e.\`subject\`)\n}\n`,
      event: webhook({ subject: 'Acme' }),
      movementName: 'm',
    });
    expect(rustRunStats).toMatchObject({ routed: 1, admitted: 1, ranWhole: 1, notAdmitted: {}, allReasons: {} });
    expect(result?.movementName).toBe('m');
  });
});

/** One segment of `source` (after the prelude) in the Rust engine, on a
 *  webhook with an empty payload: its outcome, or the error it ended in,
 *  and what the resolver was asked. */
async function segmentOf(source: string) {
  // The context is pinned to version 3, as the next helper's is: what is
  // asked of it here is refused (or admitted) by construct, alike under 4.
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

/** `segmentOf`, firing the movement named. */
async function segmentOfMovement(source: string, movementName: string) {
  const host = makeTestHost({ adapters: { resolve: () => fakeEmail().adapter } });
  const context = await openRunContext({ host, teamId: TEAM_ID, languageVersion: 3, spend: {} });
  const input = { source: PRELUDE + source, event: webhook({}), teamId: TEAM_ID, catalog, host, movementName };
  try {
    return { outcome: await runSegmentInRust({ input, context }) };
  } catch (error) {
    return { outcome: { error } };
  }
}

/** Whether the Rust engine admits `source`: `admitted`, or its refusal's
 *  reason, or `ENDED_AT_CHECK` for a program the checker refuses, checked
 *  first as run.ts checks it, so the engine is never asked. */
async function admission(source: string): Promise<string> {
  resetRustRunStats();
  try {
    checkPinned({ source: PRELUDE + source, catalog, languageVersion: 3 });
  } catch (error) {
    if (!isCheckFailure(error)) throw error;
    return ENDED_AT_CHECK;
  }
  const { outcome } = await segmentOf(source);
  const [reason] = Object.keys(rustRunStats.notAdmitted);
  if (reason !== undefined) return reason;
  // Admitted: it ran in Rust, to its end or its own failure.
  expect(rustRunStats).toMatchObject({ notAdmitted: {}, admitted: 1, ...endedInRust('error' in outcome ? outcome.error : undefined) });
  return 'admitted';
}

/** Under local_zone_matrix, which starts this suite with a `TZ` it knows the
 *  standing of: whether the shim names the zone. */
function expectZoneStanding(named: string | undefined): void {
  const expected = process.env.EXPECT_LOCAL_ZONE;
  if (expected !== undefined) expect([process.env.TZ, named === undefined ? 'unverified' : 'named']).toEqual([process.env.TZ, expected]);
}

