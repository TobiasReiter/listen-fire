// Position-aware narrowing, host side: `refineInstanceSchema` walks the
// program's hop chains over the projected schema in type space, resolves each
// selection by EVALUATING its WHERE over the members the meta walk published,
// walks to the member it selected, and grafts the result as a refined position
// (copy-on-write) keyed for the checker.

import { parseTraversalPath, refinementKey, scanInstanceChains } from 'movement-lang';

import type { InstanceSchema } from 'movement-lang';
import type { SchemaTypeDescriptor } from 'movement-engine/services/translation_graph/types';

import { narrowForInspection, refineInstanceSchema } from '../refinements';

const SPREADSHEET = 'Spreadsheet';

const unionSchema: InstanceSchema = {
  positions: {
    [SPREADSHEET]: {
      properties: { Title: 'text' },
      edges: {
        'Companies (table)': { target: 'Companies (table)' },
        'Deals (table)': { target: 'Deals (table)' },
      },
    },
    'Companies (table)': { properties: { Name: 'text' }, edges: {} },
    'Deals (table)': { properties: { Name: 'text' }, edges: {} },
  },
  collections: { [SPREADSHEET]: { target: SPREADSHEET } },
  writableRoots: {},
};

const entryPoints = [
  { typeId: SPREADSHEET, displayName: SPREADSHEET, writable: true, readable: true },
  { typeId: 'tbl-companies', displayName: 'Companies (table)', writable: true, readable: true },
  { typeId: 'tbl-deals', displayName: 'Deals (table)', writable: true, readable: true },
];

/** What the META WALK published: every grant, each labelled with the data its
 *  adapter minted onto the position. This is what a predicate runs against. */
const members = [
  { name: 'Pipeline Sheet', data: { Title: 'Pipeline Sheet', Owner: 'ops' } },
  { name: 'Other Sheet', data: { Title: 'Other Sheet', Owner: 'sales' } },
];

/** The TYPE a member lands, which is NOT the name the member is addressed by.
 *  Every walking adapter with per-container types works this way — Affinity's
 *  `List Entries` edge publishes a member addressed `Portfolio` whose records
 *  are stamped `List Entry — Portfolio` — and a fixture where the two strings
 *  agree cannot tell a gate that compares the right one from a gate that
 *  compares the wrong one. */
const landedTypeName = (member: string) => `Sheet — ${member}`;

/** Pipeline Sheet's own surface: Title + ONLY the Companies table edge. */
const selectedDescriptor: SchemaTypeDescriptor = {
  typeId: landedTypeName('Pipeline Sheet'),
  displayName: landedTypeName('Pipeline Sheet'),
  fields: [
    { fieldId: 'Title', displayName: 'Title', kind: 'string', writable: true, required: true },
  ],
  references: [{ fieldId: 'Companies (table)', targetTypeId: 'tbl-companies', cardinality: 'many' }],
};

const sourceWith = (where: string) => `import { google_sheets } from adapters
import { sheets_cred } from credentials
sheets = google_sheets(credentials: sheets_cred)
movement m(x: <sheets-[:Spreadsheet]->>) {
  sheets-[s:Spreadsheet WHERE ${where}]-> {
    write s-[:\`Companies (table)\`]-> { Name: "X" }
  }
}`;

const source = sourceWith('`Title` == "Pipeline Sheet"');

/**
 * The key both sides derive. It must come from the WHERE parsed IN ITS HOP —
 * a bare field read is an `edge_property` inside a bracket WHERE and a
 * `property` standing alone, so the same author text yields two different ASTs
 * and two different keys. Harmless in production (the checker and the host both
 * parse the hop), but it is exactly the drift `refinementKey` exists to prevent,
 * so the test derives its key the way they do rather than asserting a literal.
 */
const keyFor = (where: string) => {
  const steps = parseTraversalPath(`-[:${SPREADSHEET} WHERE ${where}]->`);
  const filter = steps?.[0]?.type === 'edge' ? steps[0].expressionFilter : undefined;
  if (!filter) throw new Error(`test setup: could not parse a filter out of \`${where}\``);
  return refinementKey({ type: SPREADSHEET, filter });
};

const instanceWith = (
  overrides: Partial<Parameters<typeof refineInstanceSchema>[0]['instance']> = {},
) => ({
  adapterType: 'google_sheets',
  schema: unionSchema,
  entryPoints,
  describeType: async (typeName: string) => ({
    ...selectedDescriptor,
    typeId: landedTypeName(typeName),
    displayName: landedTypeName(typeName),
  }),
  membersOf: async () => members,
  ...overrides,
});

/** Nothing narrowed: no refined position, no member selected. How the type
 *  narrows may still be recorded (`narrowBy`) — a fact about the type, not a
 *  selection. */
const expectUnnarrowed = (schema: InstanceSchema) => {
  expect(schema.refinements ?? {}).toEqual({});
  expect(schema.selectedMembers ?? {}).toEqual({});
  expect(schema.positions).toBe(unionSchema.positions);
};

describe('refineInstanceSchema', () => {
  // The checker's refusal of a field the unnarrowed type does not carry says
  // how to narrow it — which needs the same `narrowBy` a describe shows, drawn
  // from the members' labels. Recorded whether or not the WHERE selected
  // anything, because the refusal is exactly the case where it did not.
  it('records how a type narrows, from its members\' labels, even when nothing narrowed', async () => {
    const { schema } = await refineInstanceSchema({
      instance: instanceWith(),
      chains: scanInstanceChains(sourceWith('`Rows` >= 5')),
    });
    expectUnnarrowed(schema);
    expect(schema.narrowBy).toEqual({ [SPREADSHEET]: ['Title', 'Owner'] });
  });

  it('records nothing for a type with no members', async () => {
    const { schema } = await refineInstanceSchema({
      instance: instanceWith({ membersOf: async () => [] }),
      chains: scanInstanceChains(sourceWith('`Rows` >= 5')),
    });
    expect(schema.narrowBy).toBeUndefined();
  });

  it('grafts a refined position for a resolved selection and keys it for the checker', async () => {
    const calls: string[] = [];
    const { schema, notes } = await refineInstanceSchema({
      instance: instanceWith({
        describeType: async (typeName: string) => {
          calls.push(typeName);
          return selectedDescriptor;
        },
      }),
      chains: scanInstanceChains(source),
    });

    expect(notes).toEqual([]);
    // Narrowing a polymorphic edge IS taking the named one: the member the
    // predicate SELECTED names the type walked to, so this is the same call
    // (and the same minimal fanout) as `-[s:`Pipeline Sheet`]->` would make.
    // Never a fanout across the members it didn't select.
    // plans/2026-07-10-adapter-entry-positions/4_polymorphic_edges.md
    // One resolution despite two chains selecting the same position.
    expect(calls).toEqual(['Pipeline Sheet']);

    const refinedName = schema.refinements?.[keyFor('`Title` == "Pipeline Sheet"')];
    expect(refinedName).toBe('Spreadsheet "Pipeline Sheet"');
    // The refined position carries ONLY the selected spreadsheet's edges,
    // with edge targets resolved to natural names via the entry points.
    expect(Object.keys(schema.positions[refinedName!].edges)).toEqual(['Companies (table)']);
    // Copy-on-write: the shared cached schema is untouched.
    expect(unionSchema.refinements).toBeUndefined();
    expect(Object.keys(unionSchema.positions)).not.toContain(refinedName);
  });

  // The runtime half of the same narrowing. `refinements` tells the checker
  // which POSITION to type the hop as; `selectedMembers` tells the engine which
  // MEMBER's records are on that path, so a landed record of any other member
  // is dropped instead of having the selected member's WHERE read off it. Two
  // facts, one key, one pass — they cannot disagree about which member won.
  it('records the member TYPE it selected under the same key, for the runtime', async () => {
    const where = '`Title` == "Pipeline Sheet" AND `Owner` == "ops"';
    const { schema } = await refineInstanceSchema({
      instance: instanceWith(),
      chains: scanInstanceChains(sourceWith(where)),
    });

    // The TYPE the selected member lands — the string an adapter stamps on one
    // of its records — taken from the descriptor the walk just fetched. NOT
    // the name the member is addressed by (`Pipeline Sheet`), which no record
    // ever carries, and not the refined position's display name.
    expect(schema.selectedMembers?.[keyFor(where)]).toBe('Sheet — Pipeline Sheet');
    expect(schema.selectedMembers?.[keyFor(where)]).not.toBe('Pipeline Sheet');
    expect(schema.refinements?.[keyFor(where)]).toBe('Spreadsheet "Pipeline Sheet"');
    expect(unionSchema.selectedMembers).toBeUndefined();
  });

  // Two spellings of one selection are two keys naming ONE member, and the
  // second answers from the pass's own memory rather than a second describe —
  // so it must still carry the member TYPE, not fall back to the addressing
  // name that costs nothing to reach for.
  it('a second spelling records the same member TYPE, with no second walk', async () => {
    const flipped = '"Pipeline Sheet" == `Title`';
    const both = `${sourceWith('`Title` == "Pipeline Sheet"')}\n${sourceWith(flipped)
      .split('\n')
      .slice(3)
      .join('\n')}`;
    const { schema } = await refineInstanceSchema({
      instance: instanceWith(),
      chains: scanInstanceChains(both),
    });

    expect(schema.selectedMembers?.[keyFor('`Title` == "Pipeline Sheet"')]).toBe(
      'Sheet — Pipeline Sheet',
    );
    expect(schema.selectedMembers?.[keyFor(flipped)]).toBe('Sheet — Pipeline Sheet');
  });

  // The point of narrowing-by-evaluation: a conjunction needs nothing widened.
  // It is why (base, table) is expressible at all.
  // plans/2026-07-10-adapter-entry-positions/6_event_positions.md
  it('resolves a CONJUNCTION — the shape the old single-field selector could not', async () => {
    const where = '`Title` == "Pipeline Sheet" AND `Owner` == "ops"';
    const { schema, notes } = await refineInstanceSchema({
      instance: instanceWith(),
      chains: scanInstanceChains(sourceWith(where)),
    });

    expect(notes).toEqual([]);
    expect(schema.refinements?.[keyFor(where)]).toBe('Spreadsheet "Pipeline Sheet"');
  });

  it('narrows on a NON-name field — the member is picked by its data, not by the value naming a type', async () => {
    const where = '`Owner` == "sales"';
    const { schema } = await refineInstanceSchema({
      instance: instanceWith(),
      chains: scanInstanceChains(sourceWith(where)),
    });

    // "sales" names no type; only the member data says it is Other Sheet's.
    expect(schema.refinements?.[keyFor(where)]).toBe('Spreadsheet "Other Sheet"');
  });

  // A key is the WHERE as written, so two spellings of one selection are two
  // keys naming ONE member. The second must reuse the first's position rather
  // than trip the name-taken guard and silently not narrow.
  it('two spellings of one selection both narrow, to the same position', async () => {
    const calls: string[] = [];
    const flipped = '"Pipeline Sheet" == `Title`';
    const both = `${sourceWith('`Title` == "Pipeline Sheet"')}\n${sourceWith(flipped)
      .split('\n')
      .slice(3)
      .join('\n')}`;

    const { schema } = await refineInstanceSchema({
      instance: instanceWith({
        describeType: async (typeName: string) => {
          calls.push(typeName);
          return selectedDescriptor;
        },
      }),
      chains: scanInstanceChains(both),
    });

    expect(schema.refinements?.[keyFor('`Title` == "Pipeline Sheet"')]).toBe(
      'Spreadsheet "Pipeline Sheet"',
    );
    expect(schema.refinements?.[keyFor(flipped)]).toBe('Spreadsheet "Pipeline Sheet"');
    // One member, one position, one walk — the second spelling costs nothing.
    expect(Object.keys(schema.positions).filter((p) => p.startsWith('Spreadsheet "'))).toEqual([
      'Spreadsheet "Pipeline Sheet"',
    ]);
    expect(calls).toEqual(['Pipeline Sheet']);
  });

  it('a conjunction no member satisfies does not narrow', async () => {
    const { schema } = await refineInstanceSchema({
      instance: instanceWith(),
      chains: scanInstanceChains(sourceWith('`Title` == "Pipeline Sheet" AND `Owner` == "sales"')),
    });
    expectUnnarrowed(schema);
  });

  // Tighter than `isPurePredicate`: `@current_date` is pure but is a RUNTIME
  // value, unknowable while typing, so it must not narrow.
  it('does not narrow on a leaf no member publishes', async () => {
    const { schema } = await refineInstanceSchema({
      instance: instanceWith(),
      chains: scanInstanceChains(sourceWith('`Missing` == "x"')),
    });
    expectUnnarrowed(schema);
  });

  it('does not narrow on an impure predicate', async () => {
    const { schema } = await refineInstanceSchema({
      instance: instanceWith(),
      chains: scanInstanceChains(sourceWith('`Title` == AI("which sheet?")')),
    });
    expectUnnarrowed(schema);
  });

  // A WHERE is answered in two places — the member picks the node, the rest
  // runs over its rows — and an AND is the one shape where splitting it that
  // way still answers the question asked. So a condition the members cannot
  // decide rides alongside the one that names the member, and the hop still
  // narrows: a runtime cutoff could never have chosen a different sheet.
  it('narrows on the decidable half of a conjunction, whatever rides alongside', async () => {
    for (const rest of ['`Missing` == "x"', '`Title` == AI("which sheet?")', '`Rows` >= 5']) {
      const { schema } = await refineInstanceSchema({
        instance: instanceWith(),
        chains: scanInstanceChains(sourceWith(`\`Title\` == "Pipeline Sheet" AND ${rest}`)),
      });
      expect(Object.values(schema.refinements ?? {})).toEqual(['Spreadsheet "Pipeline Sheet"']);
      expect(Object.keys(schema.positions)).toContain('Spreadsheet "Pipeline Sheet"');
    }
  });

  // Only AND splits. An OR's arm constrains nothing on its own, so a member
  // that satisfies one arm is not the member the whole predicate selects.
  it('does not split a disjunction', async () => {
    const { schema } = await refineInstanceSchema({
      instance: instanceWith(),
      chains: scanInstanceChains(sourceWith('`Title` == "Pipeline Sheet" OR `Missing` == "x"')),
    });
    expectUnnarrowed(schema);
  });

  it('leaves the schema unchanged when the walk to the selected member does not resolve', async () => {
    const { schema } = await refineInstanceSchema({
      instance: instanceWith({ describeType: async () => null }),
      chains: scanInstanceChains(source),
    });
    expectUnnarrowed(schema);
  });

  it('an adapter with no meta-graph members does not narrow', async () => {
    const { schema } = await refineInstanceSchema({
      instance: instanceWith({ membersOf: async () => [] }),
      chains: scanInstanceChains(source),
    });
    expectUnnarrowed(schema);
  });

  it('a throwing walk degrades to a note, never a failure', async () => {
    const { schema, notes } = await refineInstanceSchema({
      instance: instanceWith({
        describeType: async () => {
          throw new Error('upstream 500');
        },
      }),
      chains: scanInstanceChains(source),
    });
    expectUnnarrowed(schema);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('upstream 500');
  });

  it('a throwing member walk degrades to a note, never a failure', async () => {
    const { schema, notes } = await refineInstanceSchema({
      instance: instanceWith({
        membersOf: async () => {
          throw new Error('meta walk 500');
        },
      }),
      chains: scanInstanceChains(source),
    });
    expectUnnarrowed(schema);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('meta walk 500');
  });
});

// ── Narrowing on INSPECT ────────────────────────────────────────────────────
//
// Same machinery as the chain pre-pass above, opposite failure policy. A
// polymorphic type's direct surface is the INTERSECTION of its members and the
// intersection is frequently EMPTY, so an agent that inspects one meets a
// thin-or-empty surface and narrowing is its only way forward. That makes a
// silent fallback to the unnarrowed surface the failure mode, not the graceful
// degradation it is on a chain.
describe('narrowForInspection', () => {
  const parse = (where: string) => {
    const steps = parseTraversalPath(`-[:${SPREADSHEET} WHERE ${where}]->`);
    const filter = steps?.[0]?.type === 'edge' ? steps[0].expressionFilter : undefined;
    if (!filter) throw new Error(`test setup: could not parse a filter out of \`${where}\``);
    return filter;
  };

  it('describes the selected member, under the name the checker would mint', async () => {
    const calls: string[] = [];
    const result = await narrowForInspection({
      instance: instanceWith({
        describeType: async (typeName: string) => {
          calls.push(typeName);
          return selectedDescriptor;
        },
      }),
      typeName: SPREADSHEET,
      filter: parse('`Title` == "Pipeline Sheet"'),
    });

    if (!result.ok) throw new Error(`expected a narrowing, got ${JSON.stringify(result.failure)}`);
    expect(result.member).toBe('Pipeline Sheet');
    // The SAME name `refineInstanceSchema` grafts — what you see when you
    // inspect is what you get when you author.
    expect(result.refinedName).toBe('Spreadsheet "Pipeline Sheet"');
    // The member's OWN surface, not the union's.
    expect(Object.keys(result.schema.positions[result.refinedName].edges)).toEqual([
      'Companies (table)',
    ]);
    // No fanout: the memoized root walk plus ONE describe of the member the
    // predicate picked — never a describe per member.
    expect(calls).toEqual(['Pipeline Sheet']);
  });

  it('narrows the SAME type two ways — proof it is selection, not a fixed describe', async () => {
    const describeFor: Record<string, SchemaTypeDescriptor> = {
      'Pipeline Sheet': selectedDescriptor,
      'Other Sheet': {
        ...selectedDescriptor,
        typeId: landedTypeName('Other Sheet'),
        displayName: landedTypeName('Other Sheet'),
        references: [{ fieldId: 'Deals (table)', targetTypeId: 'tbl-deals', cardinality: 'many' }],
      },
    };
    const instance = instanceWith({
      describeType: async (typeName: string) => describeFor[typeName] ?? null,
    });

    const pipeline = await narrowForInspection({
      instance,
      typeName: SPREADSHEET,
      filter: parse('`Owner` == "ops"'),
    });
    const other = await narrowForInspection({
      instance,
      typeName: SPREADSHEET,
      filter: parse('`Owner` == "sales"'),
    });

    if (!pipeline.ok || !other.ok) throw new Error('expected both narrowings to resolve');
    expect(Object.keys(pipeline.schema.positions[pipeline.refinedName].edges)).toEqual([
      'Companies (table)',
    ]);
    expect(Object.keys(other.schema.positions[other.refinedName].edges)).toEqual(['Deals (table)']);
  });

  it('a predicate matching nothing FAILS and names the members that exist', async () => {
    const result = await narrowForInspection({
      instance: instanceWith(),
      typeName: SPREADSHEET,
      filter: parse('`Title` == "Nonexistent"'),
    });

    if (result.ok) throw new Error('expected a miss, not a narrowing');
    expect(result.failure).toEqual({
      kind: 'no-match',
      members: ['Pipeline Sheet', 'Other Sheet'],
    });
  });

  it('never hands back the unnarrowed surface as though it answered', async () => {
    const result = await narrowForInspection({
      instance: instanceWith(),
      typeName: SPREADSHEET,
      filter: parse('`Title` == "Nonexistent"'),
    });
    // The bug class this exists to prevent: a miss must not read as a thin
    // success. There is no schema on a failure at all.
    expect(result).not.toHaveProperty('schema');
  });

  it('a type with no members reports NOT POLYMORPHIC, not an empty match', async () => {
    const result = await narrowForInspection({
      instance: instanceWith({ membersOf: async () => [] }),
      typeName: SPREADSHEET,
      filter: parse('`Title` == "Pipeline Sheet"'),
    });

    if (result.ok) throw new Error('expected a failure');
    expect(result.failure.kind).toBe('not-polymorphic');
  });

  it('an undecidable predicate is distinguished from a miss', async () => {
    const result = await narrowForInspection({
      instance: instanceWith(),
      typeName: SPREADSHEET,
      filter: parse('`Title` == AI("which sheet?")'),
    });

    if (result.ok) throw new Error('expected a failure');
    // Different problem, different fix — an agent told "no match" would go
    // hunting for the wrong member name.
    expect(result.failure.kind).toBe('undecidable');
  });

  it('a throwing walk is reported, not swallowed', async () => {
    const result = await narrowForInspection({
      instance: instanceWith({
        describeType: async () => {
          throw new Error('upstream 500');
        },
      }),
      typeName: SPREADSHEET,
      filter: parse('`Title` == "Pipeline Sheet"'),
    });

    if (result.ok) throw new Error('expected a failure');
    expect(result.failure).toEqual({ kind: 'error', message: 'upstream 500' });
  });

  it('leaves the shared cached schema untouched', async () => {
    await narrowForInspection({
      instance: instanceWith(),
      typeName: SPREADSHEET,
      filter: parse('`Title` == "Pipeline Sheet"'),
    });
    expect(Object.keys(unionSchema.positions)).not.toContain('Spreadsheet "Pipeline Sheet"');
  });
});
