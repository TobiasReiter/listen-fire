// Regression for a production 500: an author wrote `CONTAINS(a, b)` as a
// prefix call. `CONTAINS` is an INFIX keyword in the formula grammar, so the
// slot is a legitimate expression PARSE error — the checker must surface it as
// a MOV_EXPR_PARSE diagnostic, never throw.
//
// (The 500 came from @listen-fire/shared's formula ParseError escaping `instanceof
// BridgeError` when @listen-fire/shared was compiled to ES5 — a build issue outside
// this package. This test pins the checker-level contract: the malformed slot
// is a diagnostic, not an exception.)

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const affinitySchema: InstanceSchema = {
  positions: {
    listEntry: {
      properties: {},
      edges: { Organization: { target: 'organization', readable: true } },
    },
    organization: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { 'List Entry — Deal Pipeline': { target: 'listEntry' } },
  writableRoots: {
    Organization: { fields: { Name: 'text' }, resultShape: { Name: 'text' }, edges: {} },
  },
  supportsInPlaceUpdate: true,
};

const catalog = mockCatalog({
  adapters: { affinity: { constructionArgs: [], schema: affinitySchema } },
});

const HEADER = `import { affinity } from adapters
crm = affinity()

export node Deal {
  name: <text>
  website: <text>
}
`;

function diagnostics(source: string): Diagnostic[] {
  return checkProgram(parseProgram(source), catalog);
}
function errorCodes(source: string): string[] {
  return diagnostics(source)
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);
}

// A bare binding whose slot is a prefix `CONTAINS(...)` call.
const PLAIN = `${HEADER}
export function \`Check Deal\`(d: <Deal>) {
  hit = CONTAINS(d.website, d.name)
  return hit
}`;

// The same prefix `CONTAINS(...)` inside a FILTER lambda body, over a list of
// dicts returned by a traversal block — the exact shape from the bug report.
const IN_FILTER = `${HEADER}
export function \`Upsert Deal\`(d: <Deal>) {
  recent = crm-[x:\`List Entry — Deal Pipeline\`]-> {
    org = ONLY(x-[:\`Organization\`]->)
    nm  = IF org == null THEN "" ELSE COALESCE(org.\`Name\`, "") END
    return { nm: nm }
  }
  hits = FILTER(recent, (r) => {
    nm = COALESCE(AT(r, "nm"), "")
    return CONTAINS(d.website, nm)
  })
  return "done"
}`;

describe('a prefix CONTAINS(a, b) call is a parse diagnostic, not a crash', () => {
  it('does not throw, and reports MOV_EXPR_PARSE (plain binding)', () => {
    expect(() => diagnostics(PLAIN)).not.toThrow();
    expect(errorCodes(PLAIN)).toContain(C.EXPR_PARSE);
    // The message must lead the author to the infix form, not just name the token.
    const parse = diagnostics(PLAIN).find((d) => d.code === C.EXPR_PARSE);
    expect(parse?.message).toContain('a CONTAINS b');
  });

  it('does not throw, and reports MOV_EXPR_PARSE (inside a FILTER lambda)', () => {
    expect(() => diagnostics(IN_FILTER)).not.toThrow();
    expect(errorCodes(IN_FILTER)).toContain(C.EXPR_PARSE);
  });
});
