// `checkListen` derives the type(s) a listen fires from its config and
// enforces event-satisfies-param via the existing union machinery. THE EVENT
// IS JUST A NODE: an Attio webhook event is a `Webhook Event` node whose
// change kind is its own `action` enum field — `Record Created` was only ever
// a nominal name for `` Webhook Event WHERE `action` == "record.created" ``.
// So a `<crm-[:Companies]->>` listen parameter is rejected, a
// `<crm-[:`Webhook Event`]->>` parameter is accepted, and traversing a
// record edge on a delete-inclusive event errors "narrow first" (the deleted
// pin drops `requiresLiveRecord` edges — keyed on the pin, not on a name).

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { mockCatalog, type SchemaFieldType, type InstanceSchema, type PositionSchema } from '../catalog';
import { eventAddressDisplay, eventAddressKey } from '../event_address';

const EVENT = 'Webhook Event';
const ACTIONS = ['record.created', 'record.updated', 'record.deleted'];

const EVENT_PROPS: Record<string, SchemaFieldType> = {
  action: { kind: 'enum', options: ACTIONS },
};

const A = (action: string) => eventAddressKey({ event: EVENT, narrowing: { action } });

/** The WIDE graft the host mints for a program referencing the bare event
 *  node: per-action copies (the deleted pin drops the `requiresLiveRecord`
 *  record edge) + a union over them at the node's own name — built exactly as
 *  `listen_narrowing.ts` builds it, so these tests assert the checker AGREES
 *  on the keys rather than asserting their own arithmetic. */
function attioGraft(recordEdges: Record<string, { target: string }>) {
  const positions: Record<string, PositionSchema> = {};
  const variantKeys: string[] = [];
  for (const action of ACTIONS) {
    const key = A(action);
    variantKeys.push(key);
    positions[key] = {
      properties: EVENT_PROPS,
      edges: action === 'record.deleted' ? {} : { ...recordEdges },
      displayName: eventAddressDisplay({ event: EVENT, narrowing: { action } }),
    };
  }
  return { positions, unions: { [EVENT]: variantKeys } };
}

const graft = attioGraft({ Companies: { target: 'Companies' } });

// The Attio instance schema as the projection + host graft produce it: the
// event node with its `action` enum and `requiresLiveRecord` record edges,
// plus the demand-grafted per-action narrowings.
const ATTIO_SCHEMA: InstanceSchema = {
  positions: {
    Companies: {
      properties: { Name: 'text' },
      edges: {},
    },
    [EVENT]: {
      properties: EVENT_PROPS,
      edges: { Companies: { target: 'Companies', requiresLiveRecord: true } },
    },
    ...graft.positions,
  },
  collections: {},
  unions: graft.unions,
  writableRoots: {},
  eventPosition: EVENT,
  eventPositions: [{ position: EVENT }],
};

const catalog = mockCatalog({
  adapters: {
    slack: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }]},
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['events'],
      triggerConfigOptions: { events: ACTIONS },
      schema: ATTIO_SCHEMA,
    },
  },
  credentials: {
    acme_slack: { adapter: 'slack' },
    acme_main: { adapter: 'attio' },
  },
});

const checkAll = (source: string): Diagnostic[] => checkProgram(parseProgram(source), catalog);

/** The same check against a DIFFERENT event surface — the diagnostic's example
 *  is derived from the instance, so proving that needs a second shape. */
const checkWithSchema = (schema: InstanceSchema, source: string): Diagnostic[] =>
  checkProgram(
    parseProgram(source),
    mockCatalog({
      adapters: {
        crm: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          triggerConfig: ['events'],
          triggerConfigOptions: { events: ACTIONS },
          schema,
        },
      },
      credentials: { creds: { adapter: 'crm' } },
    }),
  ).filter(d => (d.severity ?? 'error') === 'error');
const check = (source: string): Diagnostic[] =>
  checkAll(source).filter(d => (d.severity ?? 'error') === 'error');

const PRELUDE = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'chat = slack(credentials: acme_slack)',
].join('\n');

const program = (movement: string, listen: string): string =>
  [PRELUDE, movement, listen].join('\n');

const CREATED = '<crm-[:`Webhook Event` WHERE `action` == "record.created"]->>';

describe('typed listen events — event-satisfies-param', () => {
  it('rejects a record-position param for a record-event listen', () => {
    const diags = check(
      program(
        [
          'movement m(co: <crm-[:Companies]->>) {',
          '  write chat-[:message]-> { channel: "#x", text: co.Name }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created"] } fire m',
      ),
    );
    expect(diags.map(d => d.code)).toContain(C.LISTEN_PARAM_MISMATCH);
    expect(
      diags.find(d => d.code === C.LISTEN_PARAM_MISMATCH)?.message,
    ).toMatch(/fires .*Webhook Event where action=record\.created/);
  });

  it('accepts the event-node param', () => {
    const diags = check(
      program(
        [
          'movement m(ev: <crm-[:`Webhook Event`]->>) {',
          '  write chat-[:message]-> { channel: "#x", text: "got an event" }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire m',
      ),
    );
    expect(diags.filter(d => d.code === C.LISTEN_PARAM_MISMATCH)).toEqual([]);
  });

  it('rejects traversing a record edge on a delete-inclusive event (narrow first)', () => {
    const diags = check(
      program(
        [
          'movement m(ev: <crm-[:`Webhook Event`]->>) {',
          '  write chat-[:message]-> { channel: "#x", text: ev-[:Companies]->.Name }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire m',
      ),
    );
    const narrowing = diags.find(d => d.code === C.NARROWING);
    expect(narrowing).toBeDefined();
    // The carrying variants render by DISPLAY (keys are opaque), and the
    // suggested IS is a derived, paste-able ADDRESS.
    expect(narrowing?.message).toMatch(
      /'Companies' is an edge of .*action=record\.created.* \/ .*action=record\.updated.* only/,
    );
    expect(narrowing?.message).toContain(
      'x IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->>',
    );
  });

  it('allows the traversal after IS-narrowing to a live action', () => {
    const diags = check(
      program(
        [
          'movement m(ev: <crm-[:`Webhook Event`]->>) {',
          '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->> {',
          '    write chat-[:message]-> { channel: "#x", text: ev-[:Companies]->.Name }',
          '  }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire m',
      ),
    );
    expect(diags.filter(d => d.code === C.NARROWING)).toEqual([]);
  });

  // The two planes agree. A record union's `else` eliminates the members the
  // arms above tested; an EVENT union's members are ADDRESSES, and the variant
  // a passing test would have narrowed to — the subject's pins ∪ the test's,
  // keyed — is the one a failed test subtracts. (This test used to pin the
  // opposite. It could only flip once the engine stopped answering `false` to
  // an address test it cannot decide: an event delivered without its `action`
  // now fails the run instead of falling into the else.)
  it('an else after an ADDRESS test eliminates that address', () => {
    const diags = check(
      program(
        [
          'movement m(ev: <crm-[:`Webhook Event`]->>) {',
          '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.deleted"]->> {',
          '  } else {',
          '    write chat-[:message]-> { channel: "#x", text: ev-[:Companies]->.Name }',
          '  }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire m',
      ),
    );
    // The deleted variant is subtracted, so the record edge — an edge of the
    // two live variants — is reachable without a further narrowing.
    expect(diags.map(d => d.code)).toEqual([]);
  });

  it('an else-if chain keeps eliminating, and the exhausted else has nothing left', () => {
    const diags = check(
      program(
        [
          'movement m(ev: <crm-[:`Webhook Event`]->>) {',
          '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->> {',
          '  } else if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.updated"]->> {',
          '  } else if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.deleted"]->> {',
          '  } else {',
          '    write chat-[:message]-> { channel: "#x", text: ev.`action` }',
          '  }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire m',
      ),
    );
    expect(diags.map(d => d.code)).toEqual([C.UNREACHABLE_BRANCH]);
  });

  it('a middle arm sees only what the arms above left', () => {
    // Reaching arm 2 proves the event is not a create; the delete variant has
    // no record edge, so the traversal is still ambiguous there.
    const diags = check(
      program(
        [
          'movement m(ev: <crm-[:`Webhook Event`]->>) {',
          '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->> {',
          '  } else if 1 == 1 {',
          '    write chat-[:message]-> { channel: "#x", text: ev-[:Companies]->.Name }',
          '  }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire m',
      ),
    );
    expect(diags.map(d => d.code)).toContain(C.NARROWING);
  });

  it('a test that pins a DIFFERENT axis value than the subject eliminates nothing', () => {
    // The subject is already pinned to created by its signature, so a test for
    // deleted could never have passed — `never`, and a failed `never` proves
    // nothing. The else still sees the created event.
    const diags = check(
      program(
        [
          `movement m(ev: ${CREATED}) {`,
          '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.deleted"]->> {',
          '  } else {',
          '    write chat-[:message]-> { channel: "#x", text: ev-[:Companies]->.Name }',
          '  }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created"] } fire m',
      ),
    );
    expect(diags.map(d => d.code)).toEqual([]);
  });

  it('elimination is scoped to the else — the union is whole again after the if', () => {
    const diags = check(
      program(
        [
          'movement m(ev: <crm-[:`Webhook Event`]->>) {',
          '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.deleted"]->> {',
          '  } else {',
          '  }',
          '  write chat-[:message]-> { channel: "#x", text: ev-[:Companies]->.Name }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire m',
      ),
    );
    expect(diags.map(d => d.code)).toContain(C.NARROWING);
  });

  it("a test against a DIFFERENT graph's event eliminates nothing", () => {
    const diags = check(
      program(
        [
          'movement m(ev: <crm-[:`Webhook Event`]->>) {',
          '  if ev IS <chat-[:`Webhook Event` WHERE `action` == "record.deleted"]->> {',
          '  } else {',
          '    write chat-[:message]-> { channel: "#x", text: ev-[:Companies]->.Name }',
          '  }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire m',
      ),
    );
    expect(diags.map(d => d.code)).toContain(C.NARROWING);
  });

  it('a CONJUNCTION that failed eliminates nothing on this plane either', () => {
    const diags = check(
      program(
        [
          'movement m(ev: <crm-[:`Webhook Event`]->>) {',
          '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.deleted"]->> AND 1 == 1 {',
          '  } else {',
          '    write chat-[:message]-> { channel: "#x", text: ev-[:Companies]->.Name }',
          '  }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire m',
      ),
    );
    expect(diags.map(d => d.code)).toContain(C.NARROWING);
  });

  it('allows the traversal with no narrowing when the config excludes delete', () => {
    const diags = check(
      program(
        [
          `movement m(ev: ${CREATED}) {`,
          '  write chat-[:message]-> { channel: "#x", text: ev-[:Companies]->.Name }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created"] } fire m',
      ),
    );
    expect(diags).toEqual([]);
  });

  it('rejects a param narrower than the config can deliver', () => {
    const diags = check(
      program(
        [
          `movement m(co: ${CREATED}) {`,
          '  write chat-[:message]-> { channel: "#x", text: co.action }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created", "record.deleted"] } fire m',
      ),
    );
    expect(diags.map(d => d.code)).toContain(C.LISTEN_PARAM_MISMATCH);
    expect(
      diags.find(d => d.code === C.LISTEN_PARAM_MISMATCH)?.message,
    ).toMatch(/fires .*action=record\.created.* \| .*action=record\.deleted/);
  });

  it('accepts a single-action param matching a single-event listen', () => {
    const diags = check(
      program(
        [
          `movement m(co: ${CREATED}) {`,
          '  write chat-[:message]-> { channel: "#x", text: co-[:Companies]->.Name }',
          '}',
        ].join('\n'),
        'listen to crm { events: ["record.created"] } fire m',
      ),
    );
    expect(diags).toEqual([]);
  });
});

// Event subscriptions are authored as a list of quoted strings — even for a
// single event — so the syntax is uniform and every downstream reader sees an
// array. A bare-string `events` is rejected with a wrap-in-brackets fix-it.
describe('typed listen events — events is always a list', () => {
  const MOVEMENT = [
    `movement m(co: ${CREATED}) {`,
    '  write chat-[:message]-> { channel: "#x", text: co-[:Companies]->.Name }',
    '}',
  ].join('\n');

  it('rejects a bare-string events value with a list fix-it', () => {
    const diags = check(
      program(MOVEMENT, 'listen to crm { events: "record.created" } fire m'),
    );
    const bad = diags.find(d => d.code === C.LISTEN_BAD_CONFIG);
    expect(bad).toBeDefined();
    expect(bad?.message).toMatch(/list of events/);
    expect(bad?.message).toMatch(/events: \["record\.created"\]/);
  });

  it('accepts the same single event as a one-element list', () => {
    const diags = check(
      program(MOVEMENT, 'listen to crm { events: ["record.created"] } fire m'),
    );
    expect(diags.filter(d => d.code === C.LISTEN_BAD_CONFIG)).toEqual([]);
  });

  // The example must be DERIVED from the instance's own event surface, never
  // hardcoded. It used to name Attio's `Companies` edge unconditionally, which
  // is a real edge there and a fiction anywhere else — an Airtable author would
  // read it and go looking for a `Companies` edge on an event whose only edge is
  // `record`. A suggestion that can't execute where it's aimed is worse than no
  // suggestion. plans/2026-07-10-adapter-entry-positions/8_event_edges.md
  it('names an edge the instance ACTUALLY has, not a hardcoded one', () => {
    const airtableish: InstanceSchema = {
      positions: {
        Deals: { properties: { Stage: 'text' }, edges: {} },
        'Record Change': {
          properties: { action: { kind: 'enum', options: ACTIONS } },
          edges: { record: { target: 'Deals' } },
        },
      },
      collections: {},
      writableRoots: {},
      eventPosition: 'Record Change',
      eventPositions: [{ position: 'Record Change' }],
    };
    const diags = checkWithSchema(
      airtableish,
      [
        'import { crm } from adapters',
        'import { creds } from credentials',
        'c = crm(credentials: creds)',
        'movement m(d: <c-[:Deals]->>) {',
        '  y = 1',
        '}',
        'listen to c { events: ["record.created"] } fire m',
      ].join('\n'),
    );
    const message = diags.find(d => d.code === C.LISTEN_PARAM_MISMATCH)?.message ?? '';
    expect(message).toContain('d-[r:record]->');
    expect(message).toContain('r.`Stage`');
    // The fiction is gone.
    expect(message).not.toContain('Companies');
  });

  // No example beats a wrong one: an event node with no edge can't be shown a
  // traversal, so the diagnostic stops rather than invent one.
  it('omits the example entirely when there is no edge to name', () => {
    const edgeless: InstanceSchema = {
      positions: {
        Companies: { properties: { Name: 'text' }, edges: {} },
        'Record Change': {
          properties: { action: { kind: 'enum', options: ACTIONS } },
          edges: {},
        },
      },
      collections: {},
      writableRoots: {},
      eventPosition: 'Record Change',
      eventPositions: [{ position: 'Record Change' }],
    };
    const diags = checkWithSchema(
      edgeless,
      [
        'import { crm } from adapters',
        'import { creds } from credentials',
        'c = crm(credentials: creds)',
        'movement m(co: <c-[:Companies]->>) {',
        '  y = 1',
        '}',
        'listen to c { events: ["record.created"] } fire m',
      ].join('\n'),
    );
    const message = diags.find(d => d.code === C.LISTEN_PARAM_MISMATCH)?.message ?? '';
    // The message still lands, and still ENDS cleanly — no example, because
    // there is no edge to name and a suggestion that doesn't execute in the
    // instance it's aimed at is worse than no suggestion.
    expect(message).toContain('widen the signature.');
    expect(message).not.toContain('e.g.');
  });
});
