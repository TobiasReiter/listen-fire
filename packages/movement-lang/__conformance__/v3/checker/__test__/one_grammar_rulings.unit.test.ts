// What the checker says about the texts the one expression grammar reads
// differently from the old text-rewriting bridge (rulings after step 1 of
// plans/functional-extract-2026-10-02/2_one_grammar.md). Each applies under
// every language version. The lowering itself is pinned in
// parser/expression/__test__/lowering_regression.unit.test.ts.
//
// TWO SCHEMAS: a fixture matching one shape cannot tell derived from hardcoded.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { SUPPORTED_LANGUAGE_VERSIONS } from '../../language_version';
import { mockCatalog, type InstanceSchema } from '../catalog';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: { Members: { target: 'person', readable: true } },
    },
    person: { properties: { Name: 'text' }, edges: { Employer: { target: 'org', readable: true } } },
    org: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' } },
  writableRoots: {},
};

const docSchema: InstanceSchema = {
  positions: {
    file: {
      properties: { Title: 'text' },
      edges: { Tags: { target: 'tag', readable: true } },
    },
    tag: { properties: { Label: 'text' }, edges: { Owner: { target: 'owner', readable: true } } },
    owner: { properties: { Label: 'text' }, edges: {} },
  },
  collections: { Files: { target: 'file' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: {
    slack: { constructionArgs: [], schema: chatSchema },
    drive: { constructionArgs: [], schema: docSchema },
  },
});

/** The two shapes, as the names each test body is written against. */
const SHAPES = [
  { param: 'c: <chat-[:channel]->>', root: 'c', rootField: 'Name', edge: 'Members', field: 'Name', next: 'Employer' },
  { param: 'f: <docs-[:file]->>', root: 'f', rootField: 'Title', edge: 'Tags', field: 'Label', next: 'Owner' },
] as const;
type Shape = (typeof SHAPES)[number];

function errors(shape: Shape, body: string, languageVersion?: number): Diagnostic[] {
  const source = `import { slack, drive } from adapters
chat = slack()
docs = drive()
movement m(${shape.param}) {
${body}
}`;
  return checkProgram(parseProgram(source, languageVersion !== undefined ? { languageVersion } : {}), catalog).filter(
    d => (d.severity ?? 'error') === 'error',
  );
}
const codes = (shape: Shape, body: string, languageVersion?: number) =>
  errors(shape, body, languageVersion).map(d => d.code);

describe.each(SHAPES.map(s => [s.edge, s] as const))('over %s', (_edge, s) => {
  const walk = `${s.root}-[x:${s.edge}]->`;

  it.each([...SUPPORTED_LANGUAGE_VERSIONS].map(v => [v]))('a bare walk is its landings in any value position (version %d)', v => {
    // Each of these was a parse refusal under the bridge.
    expect(codes(s, `  n = count(${walk})`, v)).toEqual([]);
    expect(codes(s, `  xs = COALESCE(${walk}, [])`, v)).toEqual([]);
    expect(codes(s, `  xs = [${walk}]`, v)).toEqual([]);
  });

  it('a bare walk read as text is refused as the records it is, not as a parse failure', () => {
    expect(codes(s, `  t = CONCAT(${walk})`)).toEqual(['MOV_RECORD_NOT_A_VALUE']);
  });

  it('an IF … AND … END reads whole in a condition', () => {
    const cond = `IF ${s.root}.\`${s.rootField}\` == "a" AND ${s.root}.\`${s.rootField}\` == "b" THEN 1 ELSE 0 END == 1`;
    expect(codes(s, `  if ${cond} { }`)).toEqual([]);
  });

  it("an interpolation and a nested EXISTS inside EXISTS(…)'s walk are checked like any other", () => {
    expect(codes(s, `  if EXISTS(${s.root}-[x:${s.edge} WHERE \`${s.field}\` == "\${${s.root}.\`${s.rootField}\`}"]->) { }`)).toEqual([]);
    expect(codes(s, `  if EXISTS(${s.root}-[x:${s.edge} WHERE EXISTS(x-[:${s.next}]->)]->) { }`)).toEqual([]);
  });

  it('an empty hop WHERE is refused, saying what to write', () => {
    const found = errors(s, `  if EXISTS(${s.root}-[x:${s.edge} WHERE ]->) { }`);
    expect(found.map(d => d.code)).toEqual(['MOV_EXPR_PARSE']);
    expect(found[0].message).toContain("a hop's WHERE needs a condition");
  });
});
