// Discriminated READS (plan layer 1b): a hop whose WHERE names the list —
// `` -[le:`List Entries` WHERE le.`listName` == "Deal Pipeline"]-> `` — is
// checked against THAT list's type, not against the union of every list. The
// read-side dual of the discriminated write, and the same mechanism as every
// other narrowing: the HOST resolves the selection and registers a refined
// position, the checker looks it up by key and decides nothing.
//
// What is NEW here is the second half — a name in the WHERE that the type it
// landed on does not declare is now the ordinary unknown-field error. Before,
// every bare name in a bracket WHERE typed silently, because a name there is
// either a field of the hop target or a binding in scope and a pure lookup
// cannot tell a binding from a typo. Asking scope for mere presence separates
// them.
//
// TWO shapes so a hardcode cannot pass (movement-lang/CLAUDE.md's second-shape
// rule): `crm`'s list entries (discriminant `listName`, list-scoped fields) and
// `helpdesk`'s tickets (discriminant `queue`, different fields, different
// member names).

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog, refinementKey } from '../catalog';
import { parseTraversalPath, scanInstanceChains } from '../../service/selectors';

const ENTRIES = 'List Entry';
const MASTER = 'List Entry "Deal Pipeline"';
const TICKETS = 'Ticket';
const BILLING = 'Ticket "Billing"';
const LE = { alias: 'le' };
const T = { alias: 't' };

/** Key a WHERE the way the host does — parsed IN ITS HOP, since a bare field
 *  read is an `edge_property` inside a bracket WHERE and a `property` standing
 *  alone. Both sides parse the hop, so both agree. */
const keyFor = (type: string, where: string, options: { alias: string }): string => {
  const steps = parseTraversalPath(`-[${options.alias}:${type} WHERE ${where}]->`, 5);
  const filter = steps?.[0]?.type === 'edge' ? steps[0].expressionFilter : undefined;
  if (!filter) throw new Error(`test setup: no filter parsed out of \`${where}\``);
  return refinementKey({ type, filter });
};

const crmSchema: InstanceSchema = {
  positions: {
    Organization: {
      properties: { Name: 'text' },
      edges: { 'List Entries': { target: ENTRIES } },
    },
    // The collection publishes only the INTERSECTION of its members — the
    // discriminant and nothing else.
    [ENTRIES]: { properties: { listName: 'text' }, edges: {} },
    // One member's own surface: the list's fields, named the way the list
    // names them (no list prefix — that is the type's own name).
    [MASTER]: {
      properties: { listName: 'text', 'Deal Created': 'text', 'Stage Order': 'number' },
      edges: {},
    },
  },
  collections: { Organization: { target: 'Organization' } },
  writableRoots: {},
  // What the host records from the members' labels — Affinity labels each list
  // with its name, id and `listName`.
  narrowBy: { [ENTRIES]: ['Name', 'Id', 'listName'] },
  refinements: {
    [keyFor(ENTRIES, 'le.`listName` == "Deal Pipeline"', LE)]: MASTER,
    [keyFor(ENTRIES, 'le.`listName` == "Deal Pipeline" && le.`Deal Created` >= cutoff', LE)]: MASTER,
    [keyFor(ENTRIES, 'le.`listName` == "Deal Pipeline" && le.`Deal Created` >= cutof', LE)]: MASTER,
    [keyFor(ENTRIES, 'le.`listName` == "Deal Pipeline" && le.`Made Up Field` >= cutoff', LE)]: MASTER,
    [keyFor(
      ENTRIES,
      'le.`listName` == "Deal Pipeline" && le.`[Deal Pipeline] Deal Created` >= cutoff',
      LE,
    )]: MASTER,
  },
};

// A DELIBERATELY different shape: a root collection, a different discriminant
// name, different fields. The mechanism is not about lists.
const helpdeskSchema: InstanceSchema = {
  positions: {
    [TICKETS]: { properties: { queue: 'text' }, edges: {} },
    [BILLING]: { properties: { queue: 'text', refundAmount: 'number' }, edges: {} },
  },
  collections: { [TICKETS]: { target: TICKETS } },
  writableRoots: {},
  narrowBy: { [TICKETS]: ['queue'] },
  refinements: {
    [keyFor(TICKETS, 't.`queue` == "Billing"', T)]: BILLING,
    [keyFor(TICKETS, 't.`queue` == "Billing" && t.`refundAmount` > 100', T)]: BILLING,
    [keyFor(TICKETS, 't.`queue` == "Billing" && t.`refundAmuont` > 100', T)]: BILLING,
  },
};

// A third surface a bare name in a bracket WHERE can address: a fact of the
// RELATIONSHIP, attached per traversed record and enumerated by no describe.
// An instance that declares it keeps the surface open for WHERE names.
const graphSchema: InstanceSchema = {
  positions: { Person: { properties: { Name: 'text' }, edges: {} } },
  collections: { Person: { target: 'Person' } },
  writableRoots: {},
  edgesCarryProperties: true,
};

const manualSchema: InstanceSchema = {
  positions: { invocation: { properties: { Text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: {
    crm: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
    helpdesk: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: helpdeskSchema,
    },
    graph: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: graphSchema,
    },
    manual: { constructionArgs: [], schema: manualSchema },
  },
  credentials: {
    crm_cred: { adapter: 'crm' },
    helpdesk_cred: { adapter: 'helpdesk' },
    graph_cred: { adapter: 'graph' },
  },
});

const prelude = `import { manual, crm, helpdesk, graph } from adapters
import { crm_cred, helpdesk_cred, graph_cred } from credentials
runner = connect manual
sales = connect crm using crm_cred
desk = connect helpdesk using helpdesk_cred
kg = connect graph using graph_cred`;

const diagnose = (body: string): Diagnostic[] =>
  checkProgram(
    parseProgram(`${prelude}\nfunction m(x: <runner-[:invocation]->>) {\n${body}\n}`),
    catalog,
  ).filter((d) => (d.severity ?? 'error') === 'error');

const codes = (body: string): string[] => diagnose(body).map((d) => d.code);

/** The acceptance shape: an org, then its entries on one named list. */
const onMasterDeals = (where: string, inner = '') => `  cutoff = "2026-01-01"
  sales-[org:Organization WHERE org.org.org.org.org.\`Name\` == "Acme"]-> {
    org-[le:\`List Entries\` WHERE ${where}]-> {
${inner}
    }
  }`;

describe('a hop narrowed by its discriminant is checked against the variant', () => {
  it('a bare field of the named list is fine', () => {
    expect(codes(onMasterDeals('le.`listName` == "Deal Pipeline" && le.`Deal Created` >= cutoff'))).toEqual(
      [],
    );
  });

  it('a made-up field in the same WHERE is an unknown field naming the list', () => {
    const [diagnostic, ...rest] = diagnose(
      onMasterDeals('le.`listName` == "Deal Pipeline" && le.`Made Up Field` >= cutoff'),
    );
    expect(rest).toEqual([]);
    expect(diagnostic.code).toBe('MOV_UNKNOWN_PROPERTY');
    // The message names the VARIANT and lists ITS fields, not the collection's
    // lone discriminant.
    expect(diagnostic.message).toContain(MASTER);
    expect(diagnostic.message).toContain('Deal Created');
    expect(diagnostic.message).toContain('Stage Order');
  });

  // Affinity asks its API for modified names, so a list-scoped field arrives
  // prefixed with the list. On the type that IS that list the prefix says
  // nothing, so it comes off — and the old spelling is a name the type does
  // not have, pointed back at the one it does.
  it('the list-prefixed spelling is the same error, with the bare name suggested', () => {
    const [diagnostic] = diagnose(
      onMasterDeals(
        'le.`listName` == "Deal Pipeline" && le.`[Deal Pipeline] Deal Created` >= cutoff',
      ),
    );
    expect(diagnostic.code).toBe('MOV_UNKNOWN_PROPERTY');
    expect(diagnostic.message).toContain("did you mean 'Deal Created'?");
  });

  it('the alias binds to the variant — its own field reads, a made-up one does not', () => {
    expect(
      codes(onMasterDeals('le.`listName` == "Deal Pipeline"', '      n = le.`Stage Order`')),
    ).toEqual([]);
    const [diagnostic] = diagnose(
      onMasterDeals('le.`listName` == "Deal Pipeline"', '      n = le.`Made Up Field`'),
    );
    expect(diagnostic.code).toBe('MOV_UNKNOWN_PROPERTY');
    expect(diagnostic.message).toContain(MASTER);
  });

  // Without a literal the host registers no refinement, so the hop lands on the
  // collection and the collection's own surface is what gets checked — a
  // list-scoped name is unknown there because it belongs to no particular list.
  it('no literal discriminant ⇒ the collection stands, as before', () => {
    expect(codes(onMasterDeals('le.`listName` == cutoff'))).toEqual([]);
    const [diagnostic] = diagnose(onMasterDeals('le.`listName` == cutoff && le.`Deal Created` >= cutoff'));
    expect(diagnostic.code).toBe('MOV_UNKNOWN_PROPERTY');
    expect(diagnostic.message).toContain(ENTRIES);
    expect(diagnostic.message).not.toContain('Deal Pipeline');
  });

  // A bare name in a WHERE has two surfaces, and that is exactly why this
  // never reported before: `cutoff` is a binding, spelled the same way a field
  // is. Presence in scope is what tells them apart.
  it('a MISSPELLED binding is the same error — the two surfaces are checked together', () => {
    // `cutoff` above is a binding spelled exactly the way a field is, and it
    // stays silent. Drop a letter and it is neither, which is the whole of what
    // scope presence buys.
    expect(
      codes(onMasterDeals('le.`listName` == "Deal Pipeline" && le.`Deal Created` >= cutof')),
    ).toEqual(['MOV_UNKNOWN_PROPERTY']);
  });
});

describe('the same rule on a second shape', () => {
  it('narrows a root collection by its own discriminant', () => {
    expect(codes('  desk-[t:Ticket WHERE t.`queue` == "Billing" && t.`refundAmount` > 100]-> { }')).toEqual(
      [],
    );
  });

  it('a typo against the variant is caught and corrected', () => {
    const [diagnostic] = diagnose(
      '  desk-[t:Ticket WHERE t.`queue` == "Billing" && t.`refundAmuont` > 100]-> { }',
    );
    expect(diagnostic.code).toBe('MOV_UNKNOWN_PROPERTY');
    expect(diagnostic.message).toContain(BILLING);
    expect(diagnostic.message).toContain("did you mean 'refundAmount'?");
  });

  it('the unnarrowed collection does not carry the variant’s field', () => {
    expect(codes('  desk-[t:Ticket WHERE t.`refundAmount` > 100]-> { }')).toEqual([
      'MOV_UNKNOWN_PROPERTY',
    ]);
  });
});

// The honesty valve. Two of the three surfaces a bare WHERE name addresses are
// visible to the checker; the third — the walked edge's own inline property —
// is enumerated by nothing, so an instance that declares it can carry any
// keeps such a name silent, exactly as `openProperties` does for a read.
describe('an edge that can carry inline properties keeps its WHERE names open', () => {
  it('an unrecognised name may be the relationship’s own fact', () => {
    expect(codes('  kg-[p:Person WHERE p.`since` > "2020"]-> { }')).toEqual([]);
  });

  it('the same name on a closed instance is still a mistake', () => {
    expect(codes('  desk-[t:Ticket WHERE t.`since` > "2020"]-> { }')).toEqual([
      'MOV_UNKNOWN_PROPERTY',
    ]);
  });
});

// A refusal on a type that NARROWS says how to narrow it. The type carries only
// what its members share, so a field of one member is refused until the hop is
// narrowed — and the WHERE narrows as a whole, so the test may go anywhere in it.
describe('a refused field on a narrowable type names the narrowing that admits it', () => {
  it('list entries: names the list-labelling fields', () => {
    const [diagnostic, ...rest] = diagnose(
      onMasterDeals('le.`listName` == cutoff && le.`Deal Created` >= cutoff'),
    );
    expect(rest).toEqual([]);
    expect(diagnostic.code).toBe('MOV_UNKNOWN_PROPERTY');
    expect(diagnostic.message).toBe(
      "sales.List Entry has no field 'Deal Created' — it has: listName. If it is a field of one List Entry only, narrow the hop that lands here to it: test `Name` == \"…\" (or `Id`, `listName`) in its WHERE",
    );
  });

  it('tickets: names the queue', () => {
    const [diagnostic] = diagnose('  desk-[t:Ticket WHERE t.`refundAmount` > 100]-> { }');
    expect(diagnostic.message).toContain(
      'narrow the hop that lands here to it: test `queue` == "…" in its WHERE',
    );
  });

  it('an alias read off the unnarrowed hop gets the same fix', () => {
    const [diagnostic] = diagnose(
      '  desk-[t:Ticket WHERE t.`queue` == "Support"]-> {\n    n = t.`refundAmount`\n  }',
    );
    expect(diagnostic.code).toBe('MOV_UNKNOWN_PROPERTY');
    expect(diagnostic.message).toContain('test `queue` == "…" in its WHERE');
  });

  it('a narrowed hop, or a type with nothing to narrow by, says nothing of the kind', () => {
    const [narrowed] = diagnose(
      onMasterDeals('le.`listName` == "Deal Pipeline" && le.`Made Up Field` >= cutoff'),
    );
    expect(narrowed.message).not.toContain('narrow the hop');
    const [closed] = diagnose('  sales-[o:Organization WHERE o.`Made Up` == "x"]-> { }');
    expect(closed.message).not.toContain('narrow the hop');
  });
});

// A path wrapped in a function narrows exactly as a block hop does. The host
// narrows the hops the program walks, and learns which ones those are from the
// chain scan — which read the path out of `COUNT(…)` / `FIRST(…)` / `ONLY(…)`
// (a traverse carrying its own hops) but lost the one in `EXISTS(…)`: the
// bridge lifts that into a zero-step traverse whose terminal carries the hops,
// so the scan saw a path of length zero. Nothing narrowed, the landing was never
// described, and a member's field in the WHERE was refused.
describe('a path wrapped in a function narrows like a block hop', () => {
  const program = (body: string) =>
    `${prelude}\nfunction m(x: <runner-[:invocation]->>) {\n  cutoff = "2026-01-01"\n${body}\n}`;
  /** Each chain the scan yields: its hops, and whether the last one carries its WHERE. */
  const chainsOf = (body: string) =>
    scanInstanceChains(program(body)).map((chain) => ({
      adapter: chain.adapter,
      edges: chain.steps.map((s) => (s.type === 'edge' ? s.edgeTypeId : s.type)),
      lastFiltered: (() => {
        const last = chain.steps[chain.steps.length - 1];
        return last?.type === 'edge' && last.expressionFilter !== undefined;
      })(),
    }));

  const TICKET_PATH = 'desk-[t:Ticket WHERE t.`queue` == "Billing" && t.`refundAmount` > 100]->';
  const ENTRY_PATH =
    'sales-[o:Organization WHERE o.`Name` == "Acme"]->-[le:`List Entries` WHERE le.`listName` == "Deal Pipeline" && le.`Deal Created` >= cutoff]->';
  const ticketChain = [{ adapter: 'helpdesk', edges: [TICKETS], lastFiltered: true }];
  const entryChain = [
    { adapter: 'crm', edges: ['Organization', 'List Entries'], lastFiltered: true },
  ];

  it.each([
    ['EXISTS', `  hit = exists(${TICKET_PATH})`],
    ['EXISTS in an IF condition', `  n = exists(${TICKET_PATH}) ? 1 : 0`],
    ['EXISTS as an if statement condition', `  if (exists(${TICKET_PATH})) { }`],
    ['COUNT', `  n = count(${TICKET_PATH})`],
    ['FIRST', `  n = first(${TICKET_PATH})`],
    ['ONLY', `  n = only(${TICKET_PATH})`],
  ])('the scan yields the path inside %s (a root collection)', (_form, body) => {
    expect(chainsOf(body)).toEqual(ticketChain);
  });

  it.each([
    ['EXISTS', `  hit = exists(${ENTRY_PATH})`],
    ['COUNT', `  n = count(${ENTRY_PATH})`],
  ])('the scan yields the whole chained path inside %s (a record edge)', (_form, body) => {
    expect(chainsOf(body)).toEqual(entryChain);
  });

  it('an EXISTS rooted at a block alias grounds through the block', () => {
    expect(
      chainsOf(
        '  sales-[o:Organization WHERE o.`Name` == "Acme"]-> {\n    hit = exists(o-[le:`List Entries` WHERE le.`listName` == "Deal Pipeline"]->)\n  }',
      ),
    ).toEqual([
      { adapter: 'crm', edges: ['Organization'], lastFiltered: true },
      { adapter: 'crm', edges: ['Organization', 'List Entries'], lastFiltered: true },
    ]);
  });

  it('a relative EXISTS inside a WHERE has no root to ground, and yields nothing new', () => {
    expect(
      chainsOf('  desk-[t:Ticket WHERE exists(-[:Comments]->)]-> { }'),
    ).toEqual([{ adapter: 'helpdesk', edges: [TICKETS], lastFiltered: true }]);
  });

  it('the checker narrows the path inside EXISTS, on both shapes', () => {
    expect(codes(`  hit = exists(${TICKET_PATH})`)).toEqual([]);
    expect(codes(`  cutoff = "2026-01-01"\n  hit = exists(${ENTRY_PATH})`)).toEqual([]);
  });

  it('without the discriminant, the member field inside EXISTS is refused with the narrowing test', () => {
    const [diagnostic, ...rest] = diagnose(
      '  cutoff = "2026-01-01"\n  hit = exists(sales-[o:Organization WHERE o.`Name` == "Acme"]->-[le:`List Entries` WHERE le.`Deal Created` >= cutoff]->)',
    );
    expect(rest).toEqual([]);
    expect(diagnostic.code).toBe('MOV_UNKNOWN_PROPERTY');
    expect(diagnostic.message).toContain('test `Name` == "…" (or `Id`, `listName`) in its WHERE');
  });
});
