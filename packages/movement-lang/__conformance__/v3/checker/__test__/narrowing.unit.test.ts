// Position-aware narrowing (2026-07-05; rebuilt on evaluation 2026-07-16): a
// hop whose WHERE the host resolved rebinds to the REFINED position it
// registered (`InstanceSchema.refinements`), so everything scoped under the
// alias sees that POSITION's surface — one spreadsheet's actual table edges —
// instead of the type's whole-collection union. A WHERE with no registered
// refinement keeps the union surface: narrowing only ever REMOVES false
// acceptance.
//
// The checker DECIDES nothing here — narrowing consumes a predicate that
// evaluates to a Boolean, and only the host can evaluate one (it holds the
// members' data). So these tests register refinements the way the host does and
// assert the checker agrees on the key.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog, refinementKey } from '../catalog';
import { parseTraversalPath, scanInstanceChains } from '../../service/selectors';

const REFINED = 'Spreadsheet "Pipeline Sheet"';

/** Key a WHERE the way the host does — parsed IN ITS HOP, since a bare field
 *  read is an `edge_property` inside a bracket WHERE and a `property` standing
 *  alone. Both sides parse the hop, so both agree; a test that hand-wrote the
 *  key would be asserting its own arithmetic instead. */
const keyFor = (where: string): string => {
  const steps = parseTraversalPath(`-[:Spreadsheet WHERE ${where}]->`);
  const filter = steps?.[0]?.type === 'edge' ? steps[0].expressionFilter : undefined;
  if (!filter) throw new Error(`test setup: no filter parsed out of \`${where}\``);
  return refinementKey({ type: 'Spreadsheet', filter });
};

const sheetsSchema: InstanceSchema = {
  positions: {
    Spreadsheet: {
      properties: { Title: 'text' },
      edges: {
        'Companies (table)': { target: 'Companies (table)', writable: true },
        'Deals (table)': { target: 'Deals (table)', writable: true },
      },
    },
    // The refined position: only Pipeline Sheet's own table.
    [REFINED]: {
      properties: { Title: 'text' },
      edges: { 'Companies (table)': { target: 'Companies (table)', writable: true } },
    },
    'Companies (table)': { properties: { Name: 'text', Stage: 'text' }, edges: {} },
    'Deals (table)': { properties: { Name: 'text' }, edges: {} },
  },
  collections: { Spreadsheet: { target: 'Spreadsheet' } },
  writableRoots: {
    'Companies (table)': {
      fields: { Name: 'text', Stage: 'text' },
      resultShape: { externalId: 'text', url: 'text', Name: 'text', Stage: 'text' },
    },
    'Deals (table)': {
      fields: { Name: 'text' },
      resultShape: { externalId: 'text', url: 'text', Name: 'text' },
    },
  },
  refinements: {
    [keyFor('`Title` == "Pipeline Sheet"')]: REFINED,
    // A key is the WHERE AS WRITTEN, so the flipped spelling is its own key.
    // The host grafts one position per member and points both keys at it.
    [keyFor('"Pipeline Sheet" == `Title`')]: REFINED,
  },
};

const manualSchema: InstanceSchema = {
  positions: { invocation: { properties: { Text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: {
    google_sheets: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: sheetsSchema,
    },
    manual: { constructionArgs: [], schema: manualSchema },
  },
  credentials: { sheets_cred: { adapter: 'google_sheets' } },
});

const prelude = `import { manual, google_sheets } from adapters
import { sheets_cred } from credentials
runner = manual()
sheets = google_sheets(credentials: sheets_cred)`;

const check = (body: string): Diagnostic[] =>
  checkProgram(
    parseProgram(`${prelude}\nmovement m(x: <runner-[:invocation]->>) {\n${body}\n}`),
    catalog,
  ).filter(d => (d.severity ?? 'error') === 'error');

describe('position-aware narrowing', () => {
  it('a resolved WHERE narrows the alias to the refined position (its own edge passes)', () => {
    expect(
      check(`sheets-[s:Spreadsheet WHERE \`Title\` == "Pipeline Sheet"]-> {
        write s-[:\`Companies (table)\`]-> { Name: "X" }
      }`),
    ).toEqual([]);
  });

  it("another spreadsheet's table through the narrowed alias fails at check time", () => {
    const diagnostics = check(`sheets-[s:Spreadsheet WHERE \`Title\` == "Pipeline Sheet"]-> {
      write s-[:\`Deals (table)\`]-> { Name: "X" }
    }`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('MOV_LINKED_UNKNOWN_EDGE');
    // The message names the POSITION and lists ITS edges, not the union set.
    expect(diagnostics[0].message).toContain(REFINED);
    expect(diagnostics[0].message).toContain('Companies (table)');
  });

  it('the flipped equality ("literal" == field) narrows the same way', () => {
    const diagnostics = check(`sheets-[s:Spreadsheet WHERE "Pipeline Sheet" == \`Title\`]-> {
      write s-[:\`Deals (table)\`]-> { Name: "X" }
    }`);
    expect(diagnostics.map(d => d.code)).toEqual(['MOV_LINKED_UNKNOWN_EDGE']);
  });

  it('an unrefined selection keeps the whole-collection surface', () => {
    expect(
      check(`sheets-[s:Spreadsheet WHERE \`Title\` == "Some Other Sheet"]-> {
        write s-[:\`Deals (table)\`]-> { Name: "X" }
      }`),
    ).toEqual([]);
  });

  it('a WHERE the host registered no refinement for keeps the whole-collection surface', () => {
    expect(
      check(`sheets-[s:Spreadsheet WHERE \`Title\` != "Pipeline Sheet"]-> {
        write s-[:\`Deals (table)\`]-> { Name: "X" }
      }`),
    ).toEqual([]);
  });

  it('an inline expression traversal narrows the same way (walkSteps is the one choke point)', () => {
    const diagnostics = check(
      'y = sheets-[:Spreadsheet WHERE `Title` == "Pipeline Sheet"]->-[:`Deals (table)`]->.`Name`',
    );
    expect(diagnostics.map(d => d.code)).toEqual(['MOV_TRAVERSE_UNKNOWN_EDGE']);
    expect(diagnostics[0].message).toContain(REFINED);
  });

  it('reads through the narrowed alias see the refined edge set too', () => {
    const diagnostics = check(`sheets-[s:Spreadsheet WHERE \`Title\` == "Pipeline Sheet"]-> {
      s-[t:\`Deals (table)\`]-> { }
    }`);
    expect(diagnostics.map(d => d.code)).toEqual(['MOV_TRAVERSE_UNKNOWN_EDGE']);
    expect(diagnostics[0].message).toContain(REFINED);
  });
});

describe('scanInstanceChains', () => {
  it('grounds block heads, nested alias-rooted writes, and resolves aliases', () => {
    const chains = scanInstanceChains(`import { google_sheets as gs } from adapters
import { sheets_cred as cred } from credentials
sheets = gs(credentials: cred)
movement m(x: <sheets-[:Spreadsheet]->>) {
  sheets-[s:Spreadsheet WHERE \`Title\` == "Pipeline Sheet"]-> {
    write s-[:\`Companies (table)\`]-> { Name: "X" }
  }
}`);
    expect(chains).toHaveLength(2);
    // Import aliases resolve back to original names.
    expect(chains[0].adapter).toBe('google_sheets');
    expect(chains[0].credential).toBe('sheets_cred');
    expect(chains[0].steps.map(s => (s.type === 'edge' ? s.edgeTypeId : s.type))).toEqual([
      'Spreadsheet',
    ]);
    // The nested write path expands through the enclosing block's alias:
    // the full chain from the instance, WHERE filter intact on hop 1.
    expect(chains[1].steps.map(s => (s.type === 'edge' ? s.edgeTypeId : s.type))).toEqual([
      'Spreadsheet',
      'Companies (table)',
    ]);
    const first = chains[1].steps[0];
    expect(first.type === 'edge' && first.expressionFilter !== undefined).toBe(true);
  });

  it('finds selectors inside expression slots — write fields, if conditions, assignments', () => {
    const chains = scanInstanceChains(`${prelude}
movement m(x: <runner-[:invocation]->>) {
  if (sheets-[:Spreadsheet WHERE \`Title\` == "Pipeline Sheet"]->.\`Title\` == "x") {
    y = sheets-[:Spreadsheet WHERE \`Title\` == "Board Pack"]->.\`Title\`
  }
}`);
    const selected = chains.map(c => {
      const step = c.steps[0];
      return step.type === 'edge' && step.expressionFilter !== undefined;
    });
    expect(chains).toHaveLength(2);
    expect(selected).toEqual([true, true]);
  });

  it('yields nothing for unparseable programs or ungrounded roots', () => {
    expect(scanInstanceChains('movement m(')).toEqual([]);
    expect(scanInstanceChains('movement m(x: <a-[:b]->>) {\n  ghost-[c:Things]-> { }\n}')).toEqual([]);
  });

  it('never throws on a malformed expression slot (prod 500: formula ParseError escaped)', () => {
    // `Series A` is two bare names — the formula parser throws its own
    // ParseError ("Unexpected Name"), a different class than BridgeError.
    // The scan must swallow it (the checker owns the diagnostic) — this
    // exact shape 500'd a prod saveMovement.
    const source = `${prelude}
movement m(x: <runner-[:invocation]->>) {
  write sheets-[:Spreadsheet]-> {
    Title: Series A
  }
}`;
    expect(() => scanInstanceChains(source)).not.toThrow();
    // The write target `sheets-[:Spreadsheet]->` is itself a groundable chain;
    // the malformed field `Series A` throws its own ParseError, which the scan
    // must swallow (contributing no chain of its own).
    expect(scanInstanceChains(source)).toEqual([
      {
        adapter: 'google_sheets',
        credential: 'sheets_cred',
        steps: [{ direction: 'outgoing', edgeTypeId: 'Spreadsheet', type: 'edge' }],
        // The body rides the write's target chain VERBATIM (raw source, never
        // parsed here) — so a slot the formula parser rejects is carried, not
        // swallowed, and whoever reads it decides whether it's a literal.
        writeBody: { Title: 'Series A' },
      },
    ]);
  });
});

// An `await` is a hop chain that resolves LATER — the wait says nothing about
// where the traversal lands. The scan missed that entirely, so an awaited
// landing entered no chain closure, was never demanded, and every read of an
// answer came back `MOV_UNDESCRIBED_POSITION`. It hid for as long as the ask
// adapter's landing type was spelled the same word as its edge (`Response`),
// which the demand set's substring seed matched by coincidence.
describe('scanInstanceChains over await / race', () => {
  const asks = `import { manual, ask } from adapters
runner = manual()
qa = ask()`;
  const edges = (source: string): string[][] =>
    scanInstanceChains(source).map(c =>
      c.steps.map(s => (s.type === 'edge' ? s.edgeTypeId : s.type)),
    );

  it('an awaited traversal yields the chain its bare traversal would', () => {
    expect(
      edges(`${asks}
movement m(x: <runner-[:invocation]->>) {
  a = write qa-[:Check]-> { Prompt: "Ship it?" }
  cr = await FIRST(a-[:Response]->)
  if cr.Answer { }
}`),
    ).toEqual([['Check'], ['Check', 'Response']]);
  });

  it('the UNBOUND form yields it too — nothing about the landing depends on the binding', () => {
    expect(
      edges(`${asks}
movement m(x: <runner-[:invocation]->>) {
  a = write qa-[:Check]-> { Prompt: "Ship it?" }
  await FIRST(a-[:Response]->)
}`),
    ).toEqual([['Check'], ['Check', 'Response']]);
  });

  it('the bound name grounds later chains, exactly as a write handle does', () => {
    expect(
      edges(`${asks}
movement m(x: <runner-[:invocation]->>) {
  a = write qa-[:Correct]-> { Prompt: "Fix these" }
  cr = await FIRST(a-[:Response]->)
  cr-[row:Rows]-> { }
}`),
    ).toEqual([['Correct'], ['Correct', 'Response'], ['Correct', 'Response', 'Rows']]);
  });

  it('a race walks its arms — a chain inside one is a chain the program walks', () => {
    expect(
      edges(`${asks}
movement m(x: <runner-[:invocation]->>) {
  r = await race([
    () => {
      a = write qa-[:Check]-> { Prompt: "Ship it?" }
      return await FIRST(a-[:Response]->)
    },
    () => { await sleep(2d) },
  ])
}`),
    ).toEqual([['Check'], ['Check', 'Response']]);
  });

  it('a clock wait lands nowhere, so it yields nothing (and never throws)', () => {
    const source = `${asks}
movement m(x: <runner-[:invocation]->>) {
  await sleep(2d)
}`;
    expect(() => scanInstanceChains(source)).not.toThrow();
    expect(scanInstanceChains(source)).toEqual([]);
  });
});
