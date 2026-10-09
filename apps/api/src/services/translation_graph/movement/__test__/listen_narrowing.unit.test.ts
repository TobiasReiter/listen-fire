// Event-address narrowing, host side: a movement's SIGNATURE names the full
// address, so the position it names is walked and grafted here — the event's
// `record` edge lands on the table the signature pins, not on the meta type.
//
// THE EVENT IS JUST A NODE. The address may pin the node's own `action` axis
// (an ordinary enum field — the `events:` vocabulary, one namespace) beside
// the declared hops; an address that leaves the axis open grafts a union over
// its per-action narrowings, so `IS` (subject pins ∪ test pins) lands on a
// grafted variant. A deleted `action` pin drops `requiresLiveRecord` edges —
// keyed on the pin, not on a synthesized name.
//
// Two properties are load-bearing and both are why these tests assert
// structure rather than behaviour-by-name:
//
//   - COST. The address is a two-hop PATH (base first, then only that base's
//     tables — 1 + 1), never one hop narrowed by a compound (base, table),
//     which would have to know the valid pairs and so walk every base — the
//     1 + N this whole model exists to kill.
//   - IDENTITY IS A KEY, NOT A NAME. Two addresses are two keys are two
//     positions, with no per-listen bookkeeping. The two measured live bugs
//     (`b536a1a79`) were one defect — a fabricated name doing an identity's job
//     — so the regression tests below drive TWO addresses and assert that
//     neither is discarded and neither wins.

import { eventAddressKey, type EventAddressRef, type InstanceSchema } from 'movement-lang';

import type { ListenConfigKey } from '../../adapter';
import type { SchemaTypeDescriptor } from '../../types';

import { narrowEventPositions } from '../listen_narrowing';

const TABLE_META = 'Table';
const EVENT = 'Record Change';
const ACTIONS = ['record.created', 'record.deleted'];

/** The projection's shape for an event edge: ONE node, its change kind an
 *  ordinary `action` enum field, its record edge at the META type. */
const eventSchema = (): InstanceSchema => ({
  positions: {
    [EVENT]: {
      properties: {
        action: { kind: 'enum', options: ACTIONS },
        base: 'text',
        table: 'text',
        record: 'text',
      },
      edges: { record: { target: TABLE_META, writable: false } },
    },
    Base: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { Base: { target: 'Base' } },
  writableRoots: {},
  eventPosition: EVENT,
  eventPositions: [{ position: EVENT }],
});

const listenConfig: ListenConfigKey[] = [
  { key: 'base', required: true, narrows: { collection: 'Base', matchField: 'Id' } },
  { key: 'table', required: true, narrows: { collection: TABLE_META, matchField: 'Id' } },
];

const descriptorFor = (displayName: string, field: string): SchemaTypeDescriptor => ({
  typeId: displayName,
  displayName,
  fields: [
    { fieldId: `fld${field}`, displayName: field, kind: 'string', writable: true, required: false },
  ],
  references: [],
});

const dealsDescriptor = descriptorFor('Deals', 'Name');

const address = (
  narrowing: Record<string, string>,
  overrides: Partial<EventAddressRef> = {},
): EventAddressRef => ({
  construction: { adapter: 'airtable' },
  event: EVENT,
  narrowing,
  movement: 'intake',
  ...overrides,
});

const entryPoints = [{ typeId: 'Base', displayName: 'Base', readable: true, writable: false }];

/** What the meta walk offers one hop on from a path — the address's variance
 *  surface. A base's options are at the root; a table's are one base IN, so this
 *  answers by the base the steps stepped through. Two bases with DIFFERENT table
 *  sets is what tells a real drill-down from a flat list. */
function makeMembers(tablesByBase: Record<string, string[]>) {
  const calls: Array<{ steps: unknown[]; recordType: string }> = [];
  return {
    calls,
    membersAt: async (input: { steps: readonly unknown[]; recordType: string }) => {
      calls.push({ steps: [...input.steps], recordType: input.recordType });
      const ids =
        input.recordType === 'Base'
          ? Object.keys(tablesByBase)
          : (() => {
              const first = input.steps[0] as
                | { expressionFilter?: { right?: { value?: string } } }
                | undefined;
              const baseId = first?.expressionFilter?.right?.value ?? '';
              return tablesByBase[baseId] ?? [];
            })();
      return ids.map((id) => ({ name: id, data: { Id: id } }));
    },
  };
}

const DEFAULT_TABLES: Record<string, string[]> = {
  appDevLoop: ['tblDeals', 'tblContacts'],
  appOne: ['tblDeals'],
  appTwo: ['tblDeals'],
};

/** A walk that answers per (base, table) — so a fixture can hold TWO shapes.
 *  A fixture matching one adapter's shape cannot tell "derived" from
 *  "hardcoded", nor a clobber from a discard: that is how the `Companies` wart
 *  survived and how this collision was mis-recorded in the first place. */
function makeWalk(byTableId: Record<string, SchemaTypeDescriptor | null>) {
  const walks: unknown[][] = [];
  return {
    walks,
    walkTo: async (steps: readonly unknown[]) => {
      walks.push([...steps]);
      const last = steps[steps.length - 1] as
        | { expressionFilter?: { right?: { value?: string } } }
        | undefined;
      const tableId = last?.expressionFilter?.right?.value ?? '';
      return byTableId[tableId] ?? null;
    },
  };
}

const narrow = (input: {
  schema?: InstanceSchema;
  addresses?: EventAddressRef[];
  keys?: ListenConfigKey[];
  tables?: Record<string, SchemaTypeDescriptor | null>;
  members?: Record<string, string[]>;
}) => {
  const walk = makeWalk(input.tables ?? { tblDeals: dealsDescriptor });
  const members = makeMembers(input.members ?? DEFAULT_TABLES);
  return {
    walk,
    members,
    run: narrowEventPositions({
      adapterType: 'airtable',
      schema: input.schema ?? eventSchema(),
      listenConfig: input.keys ?? listenConfig,
      addresses: input.addresses ?? [address({ base: 'appDevLoop', table: 'tblDeals' })],
      entryPoints,
      walkTo: walk.walkTo as never,
      membersAt: members.membersAt,
    }),
  };
};

const keyOf = (narrowing: Record<string, string>) => eventAddressKey({ event: EVENT, narrowing });

describe('narrowEventPositions', () => {
  it("addresses the table as a TWO-HOP path — base first, then that base's tables", async () => {
    const { walk, run } = narrow({});
    await run;

    // One walk, two hops, in declaration order. Never a single compound hop
    // (which could not know the valid pairs without walking every base) and
    // never two walks.
    expect(walk.walks).toHaveLength(1);
    expect(walk.walks[0]).toEqual([
      {
        type: 'edge',
        edgeTypeId: 'Base',
        expressionFilter: {
          type: 'compare',
          op: 'eq',
          // The address names by ID; the member's published data must carry it.
          left: { type: 'property', propertyTypeId: 'Id' },
          right: { type: 'static', value: 'appDevLoop' },
        },
      },
      {
        type: 'edge',
        edgeTypeId: TABLE_META,
        expressionFilter: {
          type: 'compare',
          op: 'eq',
          left: { type: 'property', propertyTypeId: 'Id' },
          right: { type: 'static', value: 'tblDeals' },
        },
      },
    ]);
  });

  it("grafts the address as a union over its OWN per-action copies, record edge retargeted", async () => {
    const narrowing = { base: 'appDevLoop', table: 'tblDeals' };
    const { run } = narrow({});
    const { schema } = await run;

    const created = schema.positions[keyOf({ ...narrowing, action: 'record.created' })];
    // Without `requiresLiveRecord` the deleted copy carries the same edge and
    // narrows with it — a delete event names a row too.
    const deleted = schema.positions[keyOf({ ...narrowing, action: 'record.deleted' })];
    expect(created).toBeDefined();
    expect(deleted).toBeDefined();

    const table = created.edges.record.target;
    expect(deleted.edges.record.target).toBe(table);
    expect(schema.positions[table].properties).toEqual({ Name: 'text' });
    // Display is carried SEPARATELY from identity, and is the only thing an
    // author ever sees.
    expect(schema.positions[table].displayName).toBe('Deals');
    expect(created.displayName).toBe(
      'Record Change where action=record.created, base=appDevLoop, table=tblDeals',
    );

    // The address itself is the union over its action narrowings — so a
    // signature leaving the axis open resolves, and `IS` lands on a variant.
    expect(schema.unions?.[keyOf(narrowing)]).toEqual([
      keyOf({ ...narrowing, action: 'record.created' }),
      keyOf({ ...narrowing, action: 'record.deleted' }),
    ]);
  });

  it('an action-pinned address grafts ONE position — and a deleted pin drops requiresLiveRecord edges', async () => {
    const schemaWithLiveEdge = eventSchema();
    schemaWithLiveEdge.positions[EVENT] = {
      ...schemaWithLiveEdge.positions[EVENT],
      edges: { record: { target: TABLE_META, writable: false, requiresLiveRecord: true } },
    };
    const narrowing = { base: 'appDevLoop', table: 'tblDeals' };
    const { run } = narrow({
      schema: schemaWithLiveEdge,
      addresses: [
        address({ ...narrowing, action: 'record.created' }),
        address({ ...narrowing, action: 'record.deleted' }, { movement: 'other' }),
      ],
    });
    const { schema } = await run;

    const created = schema.positions[keyOf({ ...narrowing, action: 'record.created' })];
    const deleted = schema.positions[keyOf({ ...narrowing, action: 'record.deleted' })];
    // The live pin keeps the (retargeted) edge; the deleted pin drops it —
    // the record is gone, so the constraint is stated at check time.
    expect(created.edges.record).toBeDefined();
    expect(created.edges.record.target).not.toBe(TABLE_META);
    expect(deleted.edges.record).toBeUndefined();
    // Pinned addresses are positions, not unions.
    expect(schema.unions?.[keyOf({ ...narrowing, action: 'record.created' })]).toBeUndefined();
  });

  it('a WIDE address over an action-carrying node grafts the per-action union — no walk', async () => {
    const { walk, run } = narrow({ addresses: [address({})] });
    const { schema } = await run;
    expect(walk.walks).toHaveLength(0);
    // The union hangs at the node's own name; its variants keep the record
    // edge on the META type (nothing was walked).
    expect(schema.unions?.[EVENT]).toEqual([
      keyOf({ action: 'record.created' }),
      keyOf({ action: 'record.deleted' }),
    ]);
    expect(schema.positions[keyOf({ action: 'record.created' })].edges.record.target).toBe(
      TABLE_META,
    );
    // The projected node itself is untouched.
    expect(schema.positions[EVENT].edges.record.target).toBe(TABLE_META);
  });

  it('leaves the UNNARROWED event node exactly as projected', async () => {
    // The wide type is a real type: `<at-[:`Record Change`]->>` and the
    // projected position are the same thing. Narrowing an address must not
    // reach back and mutate it — which is what the meta-type `retarget` did,
    // and why the FIRST listen used to win.
    const { run } = narrow({});
    const { schema } = await run;
    expect(schema.positions[EVENT].edges.record.target).toBe(TABLE_META);
  });

  it('leaves the input schema untouched — it is shared cache state', async () => {
    const input = eventSchema();
    const { schema } = await narrowEventPositions({
      adapterType: 'airtable',
      schema: input,
      listenConfig,
      addresses: [address({ base: 'appDevLoop', table: 'tblDeals' })],
      entryPoints,
      walkTo: makeWalk({ tblDeals: dealsDescriptor }).walkTo as never,
      membersAt: makeMembers(DEFAULT_TABLES).membersAt,
    });
    expect(input.positions[EVENT].edges.record.target).toBe(TABLE_META);
    expect(input.unions).toBeUndefined();
    expect(schema).not.toBe(input);
  });

  // ── The two measured live bugs (b536a1a79) ──

  it('gives two addresses on different tables two positions — NEITHER wins', async () => {
    // The retarget used to match edges still on the META type, so once address 1
    // pointed `record` at Deals, address 2 found nothing to retarget and
    // NO-OPPED: the first won and the second read the first's table.
    const deals = { base: 'appDevLoop', table: 'tblDeals' };
    const contacts = { base: 'appDevLoop', table: 'tblContacts' };
    const { run } = narrow({
      addresses: [address(deals), address(contacts, { movement: 'other' })],
      tables: {
        tblDeals: dealsDescriptor,
        tblContacts: descriptorFor('Contacts', 'Full Name'),
      },
    });
    const { schema } = await run;

    const dealsTable =
      schema.positions[keyOf({ ...deals, action: 'record.created' })].edges.record.target;
    const contactsTable =
      schema.positions[keyOf({ ...contacts, action: 'record.created' })].edges.record.target;
    expect(dealsTable).not.toBe(contactsTable);
    expect(schema.positions[dealsTable].properties).toEqual({ Name: 'text' });
    expect(schema.positions[contactsTable].properties).toEqual({ 'Full Name': 'text' });
  });

  it('keeps two bases\' same-named tables apart — the reuse guard used to discard one', async () => {
    // `graftPosition` short-circuited on `if (positions[name] !== undefined)
    // return` ("already grafted — reuse it"), so base 2's `Deals` descriptor was
    // silently DISCARDED and base 2's movement typed against base 1's `Deals`.
    // A SECOND SHAPE is what tells a discard from a clobber.
    const base1 = { base: 'appOne', table: 'tblDeals' };
    const base2 = { base: 'appTwo', table: 'tblDeals' };
    // Same tableId in two bases — the walk answers by the BASE it stepped through.
    const walkTo = async (steps: readonly unknown[]) => {
      const first = steps[0] as { expressionFilter?: { right?: { value?: string } } };
      return first.expressionFilter?.right?.value === 'appOne'
        ? descriptorFor('Deals', 'Name')
        : descriptorFor('Deals', 'Amount');
    };

    const { schema } = await narrowEventPositions({
      adapterType: 'airtable',
      schema: eventSchema(),
      listenConfig,
      addresses: [address(base1), address(base2, { movement: 'other' })],
      entryPoints,
      walkTo: walkTo as never,
      membersAt: makeMembers(DEFAULT_TABLES).membersAt,
    });

    const t1 =
      schema.positions[keyOf({ ...base1, action: 'record.created' })].edges.record.target;
    const t2 =
      schema.positions[keyOf({ ...base2, action: 'record.created' })].edges.record.target;
    expect(t1).not.toBe(t2);
    // Both survive — and both still READ as `Deals`, because display is allowed
    // to collide when nothing keys on it.
    expect(schema.positions[t1].properties).toEqual({ Name: 'text' });
    expect(schema.positions[t2].properties).toEqual({ Amount: 'text' });
    expect(schema.positions[t1].displayName).toBe('Deals');
    expect(schema.positions[t2].displayName).toBe('Deals');
  });

  it('walks ONCE for two signatures pinning the same table', async () => {
    const deals = { base: 'appDevLoop', table: 'tblDeals' };
    const { walk, run } = narrow({
      addresses: [address(deals), address(deals, { movement: 'other' })],
    });
    await run;
    expect(walk.walks).toHaveLength(1);
  });

  // ── Degrading to silence ──

  it('does not narrow when the address names only part of the path', async () => {
    // A partially-named path would walk to the WRONG node, which is worse than
    // not narrowing — so it must not walk at all.
    const { walk, run } = narrow({ addresses: [address({ base: 'appDevLoop' })] });
    const { schema } = await run;
    expect(walk.walks).toHaveLength(0);
    expect(schema.positions[EVENT].edges.record.target).toBe(TABLE_META);
    expect(Object.keys(schema.unions ?? {})).toEqual([]);
  });

  it('grafts nothing for a pin on a field that is not an address hop', async () => {
    const { walk, run } = narrow({ addresses: [address({ record: 'rec123' })] });
    const { schema } = await run;
    expect(walk.walks).toHaveLength(0);
    expect(Object.keys(schema.unions ?? {})).toEqual([]);
  });

  it('grafts nothing for an action pin outside the enum — `never`, whose typo died at the pin', async () => {
    const { walk, run } = narrow({ addresses: [address({ action: 'record.craeted' })] });
    const { schema } = await run;
    expect(walk.walks).toHaveLength(0);
    expect(Object.keys(schema.unions ?? {})).toEqual([]);
  });

  it('does not walk when the adapter declares no narrowing keys — but the action axis still grafts', async () => {
    const { walk, run } = narrow({
      keys: [{ key: 'base', required: true }],
      addresses: [address({ action: 'record.created' })],
    });
    const { schema } = await run;
    expect(walk.walks).toHaveLength(0);
    // The attio shape: no hops to walk, but the node's own axis narrows.
    expect(schema.positions[keyOf({ action: 'record.created' })]).toBeDefined();
    expect(schema.positions[EVENT].edges.record.target).toBe(TABLE_META);
  });

  it('degrades to the unnarrowed surface when the walk lands nowhere', async () => {
    // The pre-existing contract: no refinement, and the runtime guards stay the
    // safety mechanism. Never a wrong target.
    const { run } = narrow({ tables: {} });
    const { schema } = await run;
    expect(schema.positions[EVENT].edges.record.target).toBe(TABLE_META);
    expect(Object.keys(schema.unions ?? {})).toEqual([]);
  });

  it('does nothing to an instance with no event edges', async () => {
    const flat: InstanceSchema = {
      positions: { Deals: { properties: { Name: 'text' }, edges: {} } },
      collections: { Deals: { target: 'Deals' } },
      writableRoots: {},
    };
    const { walk, run } = narrow({ schema: flat });
    const { schema } = await run;
    expect(walk.walks).toHaveLength(0);
    expect(schema).toBe(flat);
  });
});
