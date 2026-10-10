// The SUBJECT edge — the declared hop from an event to the record it is about
// (D40(b)) — and the two checks that hang off it.
//
//   1. `fields:` names properties of the RECORD, one hop along that edge, not
//      of the event node the listen lands on. An adapter whose listen fires
//      the record itself declares no such edge and keeps the plain reading.
//   2. A signature typed against the RECORD when the listen fires the EVENT
//      gets the exact rewrite — the event-position signature plus the body
//      traversal that reaches the record (D40(a)).
//
// THREE differently-shaped mock adapters throughout, because a fixture that
// matches one adapter's shape cannot tell derived from hardcoded: `graph` and
// `flow` are both event-node-shaped but agree on NOTHING nameable (event type,
// subject edge, narrowing key, record type all differ), and `feed` fires the
// record directly.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { mockCatalog, type SchemaFieldType, type InstanceSchema, type PositionSchema } from '../catalog';
import { eventAddressDisplay, eventAddressKey, narrowingPrefixKey } from '../event_address';

const ACTIONS = ['record.created', 'record.updated', 'record.deleted'];

/** An event-node-shaped instance, built from names the caller chooses — the
 *  host's graft (`listen_narrowing.ts`) in miniature: one grafted position per
 *  action, the subject edge retargeted at the record the pins walk to, and the
 *  deleted pin dropping it. */
function eventShaped(spec: {
  event: string;
  subjectEdge: string;
  narrowKey: string;
  meta: string;
  record: string;
  recordProps: Record<string, SchemaFieldType>;
}): InstanceSchema {
  const eventProps: Record<string, SchemaFieldType> = {
    action: { kind: 'enum', options: ACTIONS },
    [spec.narrowKey]: 'text',
  };
  const positions: Record<string, PositionSchema> = {
    [spec.record]: { properties: spec.recordProps, edges: {} },
    [spec.meta]: { properties: {}, edges: {}, undescribed: true },
    [spec.event]: {
      properties: eventProps,
      edges: {
        [spec.subjectEdge]: { target: spec.meta, subject: true, requiresLiveRecord: true },
      },
    },
  };
  const variants: string[] = [];
  for (const action of ACTIONS) {
    const narrowing = { action, [spec.narrowKey]: spec.record };
    const key = eventAddressKey({ event: spec.event, narrowing });
    variants.push(key);
    positions[key] = {
      properties: eventProps,
      edges:
        action === 'record.deleted'
          ? {}
          : { [spec.subjectEdge]: { target: spec.record, subject: true } },
      displayName: eventAddressDisplay({ event: spec.event, narrowing }),
    };
  }
  const wide = eventAddressKey({ event: spec.event, narrowing: { [spec.narrowKey]: spec.record } });
  return {
    positions,
    collections: {},
    unions: { [wide]: variants },
    writableRoots: {},
    eventPosition: spec.event,
    eventPositions: [{ position: spec.event }],
    eventNarrowingKeys: [spec.narrowKey],
    eventNarrowingValues: {
      [narrowingPrefixKey({})]: { [spec.narrowKey]: [spec.record, 'Something Else'] },
    },
  };
}

const GRAPH = eventShaped({
  event: 'Record Change',
  subjectEdge: 'Record',
  narrowKey: 'type',
  meta: 'Node Type',
  record: 'Support Ticket',
  recordProps: { Status: 'text', Priority: 'number' },
});

const FLOW = eventShaped({
  event: 'Change Notice',
  subjectEdge: 'Subject',
  narrowKey: 'collection',
  meta: 'Collection',
  record: 'Task',
  recordProps: { Owner: 'text', Due: 'date' },
});

/** The OTHER shape: a listen that fires the record itself. No subject edge, so
 *  `fields:` names the landed position's own properties and a record-typed
 *  signature is simply correct. */
const FEED: InstanceSchema = {
  positions: {
    'Meeting Note': { properties: { Title: 'text', Attendees: 'text' }, edges: {} },
  },
  collections: {},
  writableRoots: {},
  eventPosition: 'Meeting Note',
  eventPositions: [{ position: 'Meeting Note' }],
};

const listenSpec = (schema: InstanceSchema, narrowKey?: string) => ({
  constructionArgs: [],
  triggerConfig: [...(narrowKey === undefined ? [] : [narrowKey]), 'events', 'fields'],
  triggerConfigOptions: { events: ACTIONS },
  triggerConfigFormats: { fields: 'fields' as const },
  schema,
});

const catalog = mockCatalog({
  adapters: {
    kg: listenSpec(GRAPH, 'type'),
    tracker: listenSpec(FLOW, 'collection'),
    notes: listenSpec(FEED),
  },
});

const errors = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter((d) => (d.severity ?? 'error') === 'error');

const message = (source: string, code: string): string | undefined =>
  errors(source).find((d) => d.code === code)?.message;

const program = (lines: string[]): string => lines.join('\n');

describe("`fields:` names the record the event is about", () => {
  it.each([
    ['kg', 'type', 'Support Ticket', 'Status', 'Record Change'],
    ['tracker', 'collection', 'Task', 'Owner', 'Change Notice'],
  ])('accepts a record property on %s', (adapter, key, record, field, event) => {
    expect(
      errors(
        program([
          `import { ${adapter} } from adapters`,
          `inst = ${adapter}()`,
          `movement m(e: <inst-[:\`${event}\` WHERE \`${key}\` == "${record}" AND \`action\` == "record.created"]->>) { }`,
          `listen to inst { ${key}: "${record}", events: ["record.created"], fields: [${field}] } fire m`,
        ]),
      ),
    ).toEqual([]);
  });

  it.each([
    ['kg', 'type', 'Support Ticket', 'Record Change', 'Status, Priority'],
    ['tracker', 'collection', 'Task', 'Change Notice', 'Owner, Due'],
  ])('rejects an unknown name on %s, naming the record surface', (adapter, key, record, event, known) => {
    const msg = message(
      program([
        `import { ${adapter} } from adapters`,
        `inst = ${adapter}()`,
        `movement m(e: <inst-[:\`${event}\` WHERE \`${key}\` == "${record}" AND \`action\` == "record.created"]->>) { }`,
        `listen to inst { ${key}: "${record}", events: ["record.created"], fields: [Nope] } fire m`,
      ]),
      C.LISTEN_BAD_CONFIG,
    );
    expect(msg).toContain("'Nope' is not a property of what this listener watches");
    for (const name of known.split(', ')) expect(msg).toContain(name);
  });

  it.each([
    ['kg', 'type', 'Support Ticket', 'Record Change'],
    ['tracker', 'collection', 'Task', 'Change Notice'],
  ])("rejects the EVENT node's own property on %s — the address is not a filter", (adapter, key, record, event) => {
    // `action` is a real property of the event node and NOT of the record. It
    // was accepted before the subject edge was declared, which is the bug the
    // marker closes: the names belong one hop along.
    const msg = message(
      program([
        `import { ${adapter} } from adapters`,
        `inst = ${adapter}()`,
        `movement m(e: <inst-[:\`${event}\` WHERE \`${key}\` == "${record}" AND \`action\` == "record.created"]->>) { }`,
        `listen to inst { ${key}: "${record}", events: ["record.created"], fields: [action] } fire m`,
      ]),
      C.LISTEN_BAD_CONFIG,
    );
    expect(msg).toContain("'action' is not a property of what this listener watches");
  });

  it('checks against the landed position itself when no subject edge is declared', () => {
    expect(
      errors(
        program([
          'import { notes } from adapters',
          'inst = notes()',
          'movement m(n: <inst-[:`Meeting Note`]->>) { }',
          'listen to inst { fields: [Title] } fire m',
        ]),
      ),
    ).toEqual([]);
    expect(
      message(
        program([
          'import { notes } from adapters',
          'inst = notes()',
          'movement m(n: <inst-[:`Meeting Note`]->>) { }',
          'listen to inst { fields: [Status] } fire m',
        ]),
        C.LISTEN_BAD_CONFIG,
      ),
    ).toContain('one of: Attendees, Title');
  });
});

describe('a record-shaped signature gets the exact rewrite', () => {
  const legacy = (adapter: string, key: string, record: string): string =>
    program([
      `import { ${adapter} } from adapters`,
      `graph = ${adapter}()`,
      `movement m(t: <graph-[:\`${record}\`]->>) { }`,
      `listen to graph { ${key}: "${record}", events: ["record.created"] } fire m`,
    ]);

  it.each([
    ['kg', 'type', 'Support Ticket', 'Record Change', 'Record'],
    ['tracker', 'collection', 'Task', 'Change Notice', 'Subject'],
  ])('shows the new signature and the body hop for %s', (adapter, key, record, event, edge) => {
    const msg = message(legacy(adapter, key, record), C.LISTEN_PARAM_MISMATCH);
    expect(msg).toContain('the EVENT, not the record it is about');
    // The signature, pasteable, with THIS instance's event name and pins.
    expect(msg).toContain(
      `'m(event: <graph-[:\`${event}\` WHERE \`action\` == "record.created" AND \`${key}\` == "${record}"]->>)'`,
    );
    // The body hop, over THIS adapter's subject edge, rebinding the author's
    // own parameter name — the block form, which is the one the language has.
    expect(msg).toContain(`'event-[t:${edge}]-> { … }'`);
  });

  it('names no other adapter — every identifier comes from the instance', () => {
    const kg = message(legacy('kg', 'type', 'Support Ticket'), C.LISTEN_PARAM_MISMATCH) ?? '';
    const tracker = message(legacy('tracker', 'collection', 'Task'), C.LISTEN_PARAM_MISMATCH) ?? '';
    for (const foreign of ['Change Notice', 'Subject', 'collection', 'Task']) {
      expect(kg).not.toContain(foreign);
    }
    for (const foreign of ['Record Change', 'Support Ticket']) {
      expect(tracker).not.toContain(foreign);
    }
  });

  it('leaves the wide event address unpinned when the listen selects every kind', () => {
    const msg = message(
      program([
        'import { kg } from adapters',
        'graph = kg()',
        'movement m(t: <graph-[:`Support Ticket`]->>) { }',
        'listen to graph { type: "Support Ticket", events: ["record.created", "record.updated", "record.deleted"] } fire m',
      ]),
      C.LISTEN_PARAM_MISMATCH,
    );
    // The whole action axis is selected, so the address pins the type alone —
    // exactly the signature that satisfies all three kinds.
    expect(msg).toContain(
      "'m(event: <graph-[:`Record Change` WHERE `type` == \"Support Ticket\"]->>)'",
    );
  });

  it('falls back to the general advice when the signature names something else', () => {
    // Not the record this event is about — nothing certain to rewrite to.
    const msg = message(
      program([
        'import { kg } from adapters',
        'graph = kg()',
        'movement m(t: <graph-[:`Node Type`]->>) { }',
        'listen to graph { type: "Support Ticket", events: ["record.created"] } fire m',
      ]),
      C.LISTEN_PARAM_MISMATCH,
    );
    expect(msg).toContain('Every listen firing a movement must satisfy its signature');
    expect(msg).not.toContain('the EVENT, not the record it is about');
  });
});

describe('constructing an adapter shows the construction it really takes', () => {
  const withCreds = mockCatalog({
    adapters: {
      kg: { constructionArgs: [], schema: GRAPH },
      crm: {
        constructionArgs: [
          { name: 'credentials', kind: 'credential', required: true },
          { name: 'workspace', kind: 'position', required: false },
        ],
      },
    },
    credentials: { acme: { adapter: 'crm' } },
  });
  const unresolved = (name: string): string | undefined =>
    checkProgram(parseProgram(`movement m() { write ${name}-[:X]-> { a: "b" } }`), withCreds)
      .find((d) => d.code === C.NAME_UNRESOLVED)?.message;

  it('shows no credential for an adapter that takes none', () => {
    expect(unresolved('kg')).toContain("'<name> = kg()'");
  });

  it('shows the required argument for an adapter that needs one', () => {
    const msg = unresolved('crm');
    expect(msg).toContain("'<name> = crm(credentials: …)'");
    // Optional args are not demanded.
    expect(msg).not.toContain('workspace');
  });

  it('a bare adapter as a WRITE root is loud, not silent', () => {
    // The legacy ambient-graph shape. It used to pass with no diagnostics at
    // all — the root had no position type, so the write body was never typed.
    const diags = errors(
      program([
        'import { kg } from adapters',
        'movement m() {',
        '  write kg-[:`Support Ticket`]-> { Status: "Open" }',
        '}',
      ]),
    );
    const msg = diags.find((d) => d.code === C.ADAPTER_NOT_CONSTRUCTED)?.message;
    expect(msg).toContain("'kg' is an adapter, not an instance");
    expect(msg).toContain("'go = kg()'");
  });

  it('a bare adapter as a TRAVERSAL root is loud too', () => {
    const diags = errors(
      program([
        'import { kg } from adapters',
        'movement m() {',
        '  kg-[t:`Support Ticket`]-> { x = t.Status }',
        '}',
      ]),
    );
    expect(diags.map((d) => d.code)).toContain(C.ADAPTER_NOT_CONSTRUCTED);
  });

  it('a constructed instance as a root stays silent', () => {
    expect(
      errors(
        program([
          'import { kg } from adapters',
          'graph = kg()',
          'movement m() {',
          '  graph-[t:`Support Ticket`]-> { x = t.Status }',
          '}',
        ]),
      ).map((d) => d.code),
    ).not.toContain(C.ADAPTER_NOT_CONSTRUCTED);
  });
});
