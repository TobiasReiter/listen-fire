// Whole runs in the Rust engine (slice 2a): each program runs on the Rust
// engine (version 5) against fakes of its own. What a caller can see — the
// result (or the error, its class and the very object a host call failed
// with), the trace, and every call the adapters received, in order — is
// recorded as a snapshot, and the assertions beside each case say what it
// is for.
//
// These programs are slice 2a's: reads of the event and of values, bindings,
// `if`, interpolation, `return`, the built-ins, the cancel gate. Writes and
// parks are rust_write.unit.test.ts's.

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';
import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { MovementTraceEntry } from 'movement-engine/services/movement_engine/expression';

import { logger } from 'movement-engine/services/logger';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { makeStablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import { openRunContext } from 'movement-engine/services/movement_engine/run_context';
import { credentialIdsFor, makeTestHost, endedInRust, type TestHostOverrides } from 'movement-engine/services/movement_engine/test_host';
import { AdapterCallFailed } from 'movement-engine/services/movement_engine/host_adapter';
import { MovementRunFailed, runFailureCause, runMovement, type RunMovementInput } from 'movement-engine/services/movement_engine/run';
import { MovementEngineError, isCheckFailure } from 'movement-engine/services/movement_engine/errors';
import { ENDED_AT_CHECK, runSegmentInRust } from 'movement-engine/services/movement_engine/rust_engine';
import { resetRustRunStats, rustRunStats, setRunEngineRecorder, type RunEngineRecord } from 'movement-engine/services/movement_engine/rust_stats';

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
  'inbox = connect email using dealflow_inbox',
  'crm   = connect attio using acme_main',
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
  /** Per run: fakes of its own. */
  host?: () => TestHostOverrides;
  /** The checker refuses it: the run ends at its check and the engine is
   *  never asked. A case says so, or fails. */
  endsAtCheck?: true;
}

/** One run: what it returned or threw, what the adapters were asked, what
 *  the resolver was asked. */
async function runOn(c: Case) {
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
  }
}

/** What a snapshot shows of a run: how it ended (a failure by its class and
 *  its cause's), then what the host was asked and handed. */
function observed(run: Awaited<ReturnType<typeof runOn>>) {
  const { error } = run;
  return JSON.parse(
    JSON.stringify({
      ...(error === undefined
        ? { result: run.result }
        : {
            error: String(error),
            errorClass: (error as object).constructor.name,
            causeClass: (runFailureCause(error) as object | undefined)?.constructor.name,
            partial: error instanceof MovementRunFailed ? error.partial : undefined,
          }),
      calls: run.calls,
      resolved: run.resolved,
      trace: run.trace,
      appends: run.appends,
    }),
  ) as unknown;
}

/** The case on the Rust engine, whole: the host is handed the trace a
 *  statement at a time, and a run that fails its check ends there, before
 *  its segment opens. */
async function run(c: Case) {
  resetRustRunStats();
  const ran = await runOn(c);
  expect(isCheckFailure('error' in ran ? ran.error : undefined)).toBe(c.endsAtCheck === true);
  expect(rustRunStats).toMatchObject({ ...endedInRust('error' in ran ? ran.error : undefined), shimFaults: 0 });
  expect(observed(ran)).toMatchSnapshot();
  return { rust: ran, result: ran.result };
}

const BINDINGS_AND_IF = [
  'function m(msg: <inbox-[:message]->>) {',
  '  subject = msg.`subject`',
  '  greeting = "Re: ${subject} (${Text.upper(Text.trim(msg.`text`))})"',
  '  if (Text.includes(msg.`text`, "deal")) {',
  '    kind = "deal"',
  '  } else if (coalesce(msg.`missing`, "x") == "x" && Text.length(greeting) > 3) {',
  '    kind = "other"',
  '  } else {',
  '    kind = "none"',
  '  }',
  '  tail = Text.concat(greeting, "!", Number.format(1200000, "compact"))',
  '  if (tail == "never") {',
  '    return tail',
  '  }',
  '  return subject',
  '}',
].join('\n');

describe('a whole run in the Rust engine', () => {
  it('reads the event, binds, interpolates and branches', async () => {
    for (const text of ['a big deal', '  quiet  ']) {
      const { result } = await run({ source: BINDINGS_AND_IF, event: webhook({ subject: 'Acme', text }) });
      // The deal arm is taken at once; otherwise the second arm reads a
      // field the payload lacks.
      expect(result?.trace.map((e) => e.kind)).toEqual(
        text.includes('deal') ? ['gate', 'gate'] : ['gate', 'field_miss', 'gate', 'gate'],
      );
    }
  });

  it('traces a field the payload does not carry, once per field', async () => {
    const { result } = await run({
      source: [
        'function m(msg: <inbox-[:message]->>) {',
        '  a = msg.`missing`',
        '  b = coalesce(msg.`missing`, msg.`text`)',
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
    await run({
      source: [
        'function m(msg: <inbox-[:message]->>) {',
        '  sa = msg.`meta`',
        '  label = sa.`label`',
        '  gone = sa.`missing`',
        '  if (label == "Follow up" && gone == null) {',
        '    ok = Text.slug(label)',
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
    // The engine knows an engine object by how it was made, never by its keys.
    const body = (...lines: string[]) => ['function m(msg: <inbox-[:message]->>) {', '  v = msg.`meta`', ...lines, '}'].join('\n');
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
    /** One run of `c`, every adapter method it called listed. */
    const onRust = async (c: Case) => {
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
      const ran = await runOn({ ...c, host: counting });
      expect(rustRunStats).toMatchObject({ ...endedInRust('error' in ran ? ran.error : undefined), shimFaults: 0 });
      return { ...ran, called, ended: String(runFailureCause('error' in ran ? ran.error : undefined)) };
    };
    /** `c` on the Rust engine, held to `expectOf`. */
    const held = async (c: Case, expectOf: (ran: Awaited<ReturnType<typeof onRust>>) => void) => {
      expectOf(await onRust(c));
    };

    it('reads a field shaped like a kept walk as data: one field read, no walk, no program text run', async () => {
      for (const raw of ['COUNT(e-[:items]->)', 'NOSUCHFN(1)']) {
        await held({ source: body('  n = count(v-[:subs]->)', '  fail("${n}")'), event: webhook({ meta: keptWalk(raw) }) }, (ran) => {
          expect(ran.called.filter((m) => m === 'getFieldValue')).toHaveLength(1);
          expect(ran.called).not.toContain('getRelated');
          expect(ran.called).not.toContain('iterateRelated');
          expect(ran.ended).toContain("traversing from a value binding ('v')");
          expect(JSON.stringify([ran.ended, ran.trace, ran.appends])).not.toContain('NOSUCHFN');
        });
      }
    });

    it('reads its kind as the text it is, and prints it as a dict', async () => {
      for (const meta of [keptWalk('1'), { kind: 'closure' }, { kind: 'positions', landings: [{ kind: 'event' }] }, { kind: 'constructor' }, { kind: 'event' }]) {
        await held({ source: body('  fail("${v.`kind`} ${Json.stringify(v)}")'), event: webhook({ meta }) }, (ran) => {
          expect(ran.ended).toMatch(new RegExp(`^MovementEngineError: MOVENG_ERROR: ${meta.kind} \\{[\\s\\S]*"kind": ?"${meta.kind}"`));
          expect(ran.called.filter((m) => m === 'getFieldValue')).toHaveLength(1);
        });
      }
    });
  });

  it('names a discriminated root by the adapter entry points, and reads it stamped', async () => {
    const { rust } = await run({
      source: ['function m(msg: <inbox-[:message]->>) {', '  s = msg.`subject`', '}'].join('\n'),
      event: webhook({ subject: 'Hi' }, { rootRecordType: 'email:msg', externalRecordRef: { adapterType: 'email', externalId: 'm-1' } }),
      email: { entryPoints: [{ typeId: 'email:msg', displayName: 'message' }] },
    });
    expect(rust.calls.map((c) => c.method)).toEqual(['listEntryPoints', 'getFieldValue']);
  });

  it('reads the clock it was pinned to, in the zone it names', async () => {
    const { rust } = await run({
      source: [
        'function m(msg: <inbox-[:message]->>) {',
        '  today = Date.today("Europe/Berlin")',
        '  start = DateTime.at(Date.addDays(today, -1), "07:00", "Europe/Berlin")',
        '  finish = DateTime.at(today, "07:00", "Europe/Berlin")',
        '  host = Url.host(msg.`text`)',
        '  fail("${today} | ${start} | ${finish} | ${host}")',
        '}',
      ].join('\n'),
      event: webhook({ text: 'https://BÜCHER.de/x' }),
      firedAt: '2026-03-29T12:00:00.000Z',
    });
    // 12:00Z on the day Berlin changes to summer time is 14:00 there: the
    // 28th's 07:00 is CET (06:00Z), the 29th's CEST (05:00Z).
    expect(String(rust.error)).toContain('2026-03-29 | 2026-03-28T06:00:00.000Z | 2026-03-29T05:00:00.000Z | xn--bcher-kva.de');
  });

  // Jest hands each suite a copy of the environment, so assigning `TZ` here
  // moves no clock: these run in the zone the process started in, and
  // local_zone_matrix.unit.test.ts starts them under each zone of its own.
  it('reads a date text with no offset as UTC, asking no host, in any process zone', async () => {
    const { rust } = await run({
      source: [
        'function m(msg: <inbox-[:message]->>) {',
        '  iso = DateTime.toIso(msg.`text`)',
        '  later = msg.`text` > "2026-03-08T01:45"',
        '  day = Date.from(msg.`text`)',
        '  fail("${iso} | ${later} | ${day}")',
        '}',
      ].join('\n'),
      event: webhook({ text: '2026-03-08T02:30' }),
    });
    expect(String(rust.error)).toContain('2026-03-08T02:30:00.000Z | true | 2026-03-08');
    expect(Object.keys(rustRunStats.hostCalls)).not.toContainEqual(expect.stringMatching(/^builtins\./));
  });

  it('pins an offset-less firing instant as UTC, in any process zone', async () => {
    // 12:00 on 15 July with no offset is 12:00Z, the very instant the same
    // text with a `Z` is; a pin read otherwise fails the run (DATE.ADD_DAYS
    // past the end of time).
    const pinned = (firedAt: string) =>
      run({
        source: ['function m(msg: <inbox-[:message]->>) {', '  pin = @current_timestamp', '  if (pin != DateTime.from("2026-07-15T12:00:00.000Z")) {', '    bad = Date.addDays("2026-01-01", 1000000000)', '  }', '}'].join('\n'),
        event: webhook({}),
        firedAt,
      });
    expect('result' in (await pinned('2026-07-15T12:00')).rust).toBe(true);
    expect('result' in (await pinned('2026-07-15T12:00:00Z')).rust).toBe(true);
  });

  it('reads twenty event fields in one expression, in order, one walk', async () => {
    // Each read is awaited where it is made: twenty reads, in order, and the
    // missing one traced as it is read.
    const fields = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const payload = Object.fromEntries(fields.filter((f) => f !== 'f7').map((f) => [f, f.toUpperCase()]));
    const { rust } = await run({
      source: [
        'function m(msg: <inbox-[:message]->>) {',
        `  joined = Text.concat("<", ${fields.map((f) => `msg.\`${f}\``).join(', ')}, ">")`,
        '  return joined',
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
      'function m(msg: <inbox-[:message]->>) {',
      '  pick = msg.`a` == "A" ? (msg.`b` == "B" ? msg.`c` : msg.`d`) : msg.`e`',
      '  if (msg.`a` == "A" && msg.`b` == "B") {',
      '    left = msg.`c`',
      '  } else if (msg.`e` == "E") {',
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
      const { rust } = await run({ source, event: webhook({ c: 'C', d: 'D', e: 'E', ...taken }) });
      expect(fieldsRead(rust.calls).join(' ')).toBe(reads);
    }
  });

  it('awaits a read inside a function argument before the function', async () => {
    await run({
      source: [
        'function m(msg: <inbox-[:message]->>) {',
        '  slug = Text.lower(Text.concat(Text.trim(msg.`subject`), "-", coalesce(msg.`missing`, Text.upper(msg.`text`))))',
        '  n = Text.length(Text.slug(msg.`subject`)) + Text.length(msg.`text`)',
        '}',
      ].join('\n'),
      event: webhook({ subject: '  Big Deal ', text: 'hi' }),
    });
  });

  it('fails before the body, in it, and at the check', async () => {
    await run({ source: BINDINGS_AND_IF, event: webhook({}), movementName: 'nope' });
    const { rust } = await run({ source: BINDINGS_AND_IF, event: webhook({ subject: 'x', text: 'y' }), email: { failOn: 'text' } });
    // The adapter's failure crosses the host boundary as data and is raised
    // under its own name.
    const cause = 'error' in rust ? runFailureCause(rust.error) : undefined;
    expect(cause).toBeInstanceOf(AdapterCallFailed);
    expect(cause).toMatchObject({ name: 'FakeAdapterError', message: 'no text today' });
    await run({ source: BINDINGS_AND_IF.replace('msg.`subject`', 'msg.`nope`'), event: webhook({}), endsAtCheck: true });
    // A source the parser does not read: the check's own parse error, before
    // a segment opens, never refused.
    const { rust: unparsed } = await run({ source: 'function m(msg: <inbox-[:message]->>) {\n  g = graph { ?...msg }\n}', event: webhook({}), endsAtCheck: true });
    expect(String('error' in unparsed ? unparsed.error : '')).toContain('MOVENG_PARSE');
  });

  it('logs, and never fails on, a trace hand-over lost as the segment ends', async () => {
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => logger);
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
        source: PRELUDE + 'function m(msg: <inbox-[:message]->>) {\n  if (msg.`subject` == "Acme") {\n    t = msg.`text`\n  }\n}',
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
      logged.mockRestore();
    }
  });

  it('stops at the cancel gate, keeping what it traced', async () => {
    const gate = (cancelAt: number, finally_: boolean) => () => {
      let asked = 0;
      return { control: { cancel: { cancelled: async () => ++asked >= cancelAt, cancelledNow: async () => finally_ } } };
    };
    const { result } = await run({ source: BINDINGS_AND_IF, event: webhook({ subject: 'Acme', text: 'deal' }), host: gate(4, false) });
    expect(result).toMatchObject({ cancelled: true, trace: [{ kind: 'gate', outcome: true }] });
    // A cancel stamped while the last statement ran is the last check's.
    const late = await run({ source: BINDINGS_AND_IF, event: webhook({ subject: 'Acme', text: 'deal' }), host: gate(99, true) });
    expect(late.result?.cancelled).toBe(true);
  });
});

describe('IS <Decl> of a record a system describes', () => {
  // Chunk 7A Task 6: compared by the record type's schema with the
  // checker's own assignability (`check.compatible`), as run.ts
  // `evaluateDeclaredNodeTest` compares it.
  const movement = (body: string) => `function m(msg: <inbox-[:message]->>) {\n${body}\n}`;
  it('takes the arm the declaration’s fit decides: the event, a second name of it', async () => {
    for (const [declaration, body] of [
      ['node Fits { subject: <text> }', '  if (msg is <Fits>) {\n    return "fits"\n  }\n  return "does not"'],
      ['node Lacks { nowhere: <text> }', '  m2 = msg\n  m3 = m2\n  if (m3 is <Lacks>) {\n    return "fits"\n  }\n  return "does not"'],
      ['node Typed { subject: <number> }', '  if (msg is <Typed>) {\n    return "fits"\n  }\n  return "does not"'],
    ] as const) {
      // An undiscriminated webhook: the engine stops, naming why (the
      // corpora's `IS` cases take each arm on a typed event).
      await run({ source: `${declaration}\n${movement(body)}`, event: webhook({ subject: 'Acme' }) });
    }
  });
});

describe('the file scope, as interpretFileStatement reads it', () => {
  // From version 5 a file-level value holds a value only: a file-level
  // extraction, write or call ends the run at the check (MOV_FILE_VALUE_RUNS),
  // before a segment opens; a value binds; a file-level statement runs
  // nothing.
  const movement = (body: string) => `function m(msg: <inbox-[:message]->>) {\n${body}\n}`;
  it('ends at the check, or runs nothing', async () => {
    // Where the run ends: in the engine (`segment`), or at the check, before
    // a segment opens (`check`).
    for (const [source, ends] of [
      [`node N: "n" {\n  a: <text> "a"\n}\nr = extract(["a"], N)\n${movement('  x = 1')}`, 'check'],
      [`import { fetchUrl } from plugins\npage = fetchUrl("x")\n${movement('  x = 1')}`, 'check'],
      [`w = write crm-[:companies]-> { name: "a" }\n${movement('  x = 1')}`, 'check'],
      [`write crm-[:companies]-> { name: "a" }\n${movement('  x = msg.\`subject\`')}`, 'segment'],
      [`n = node { title: "t" }\n${movement('  x = n.\`title\`')}`, 'check'],
    ] as const) {
      await run({ source, event: webhook({ subject: 'Acme' }), ...(ends === 'check' ? { endsAtCheck: true as const } : {}) });
      expect(rustRunStats).toMatchObject(ends === 'segment' ? { segments: 1 } : { segments: 0, endedAtCheck: 1 });
    }
  });
});

describe('a program that fails its check', () => {
  // Fails its check: the snapshot describes no `fetch_url`.
  const failing = `import { fetch_url } from plugins\npage = fetch_url(url: "x")\nfunction m(msg: <inbox-[:message]->>) {\n  x = 1\n}`;
  /** A host that notes every segment it opens and every adapter resolved. */
  const noting = (seen: string[]) =>
    makeTestHost({
      segment: { open: async () => (seen.push('segment.open'), { segmentId: `s${seen.length}` }) },
      adapters: { resolve: () => (seen.push('adapters.resolve'), fakeEmail().adapter) },
    });

  afterEach(() => {
    setRunEngineRecorder(undefined);
  });

  it('makes no host request, segment.open included, and logs why', async () => {
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
    expect(rustRunStats).toMatchObject({ segments: 0, endedAtCheck: 1, unsupported: {} });
    expect(recorded).toEqual([{ runId: 'run-check', engine: 'rust' }]);
    expect(logged).toHaveBeenCalledWith(`movement engine: engine=rust run=run-check outcome=${ENDED_AT_CHECK}`);
    logged.mockRestore();
  });

  it('driven into the shim with no check first, ends at the engine’s own check, counted and logged as that ending, never a segment', async () => {
    resetRustRunStats();
    const seen: string[] = [];
    const recorded: RunEngineRecord[] = [];
    setRunEngineRecorder((record) => recorded.push(record));
    const host = noting(seen);
    // The caller opened the segment itself: the order run.ts no longer takes.
    const context = await openRunContext({ host, teamId: TEAM_ID, languageVersion: 5, spend: {} });
    const input = { source: PRELUDE + failing, event: webhook({}), teamId: TEAM_ID, runId: 'run-direct', catalog, host };
    const error: unknown = await runSegmentInRust({ input, context }).catch((e: unknown) => e);
    expect(isCheckFailure(error)).toBe(true);
    expect(seen).toEqual(['segment.open']);
    expect(rustRunStats).toMatchObject({ segments: 0, endedAtCheck: 1 });
    expect(recorded).toEqual([{ runId: 'run-direct', engine: 'rust' }]);
  });
});

describe('the run counts', () => {
  it('count a segment only for a run the Rust engine ran, and a run that failed its check apart', async () => {
    resetRustRunStats();
    const runs = [
      'function m(msg: <inbox-[:message]->>) {\n  co = write crm-[:companies]-> { name: "a" }\n  f = () => coalesce(co, "x")\n  write crm-[:companies]-> { name: f() }\n}',
      'function m(msg: <inbox-[:message]->>) {\n  s = msg.`subject`\n}',
      'function m(msg: <inbox-[:message]->>) {\n  y = msg.`subject` WITHIN "7d"\n  co = write crm-[:companies]-> { name: "b" }\n  f = () => coalesce(co, "x")\n  write crm-[:companies]-> { name: f() }\n}',
      // Fails its check (`crm` has no `#foo`), so never reaches the engine.
      'function m(msg: <inbox-[:message]->>) {\n  y = first(crm-[:#foo]->)\n}',
      'function m(msg: <inbox-[:message]->>) {\n  return Text.upper(msg.`subject`)\n}',
    ];
    for (const source of runs) await runOn({ source, event: webhook({ subject: 'Acme' }) });
    // The two closure programs (`f = () => COALESCE(co, "x")` into a write
    // field): B14's checker (MOV_WRITE_FIELD_TYPE: the call may hold a
    // record) ends them at the check, so no run here reaches the engine
    // refused, and the ended-at-check count is 3.
    expect(rustRunStats).toMatchObject({ segments: 2, endedAtCheck: 3, unsupported: {} });
  });
});

describe('a helper the entry calls', () => {
  it('runs a reached helper the entry calls', async () => {
    const { result } = await run({
      source: `function m(msg: <inbox-[:message]->>) {\n  s = shout(msg)\n  return s\n}\nfunction shout(e: <inbox-[:message]->>) {\n  return Text.upper(e.\`subject\`)\n}\n`,
      event: webhook({ subject: 'Acme' }),
      movementName: 'm',
    });
    expect(result?.movementName).toBe('m');
  });
});
