// A write starts from a record a name holds or one a MEMBER PATH reaches:
// `write m.k { … }` and `write m.k-[:child]-> { … }` mean `x = m.k` then
// `write x …` — the same record, the same rules, the same refusals.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import type { WriteExpression } from '../../parser/ast';

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { Name: 'text', Tag: 'text' },
      edges: { Founders: { target: 'person', readable: true, writable: true } },
    },
    person: { properties: { First: 'text' }, edges: {} },
  },
  collections: { Companies: { target: 'company' } },
  supportsInPlaceUpdate: true,
  writableRoots: { company: { fields: { Name: 'text', Tag: 'text' }, resultShape: { Name: 'text' } } },
  createShapes: { person: { fields: { First: 'text' }, resultShape: { First: 'text' } } },
};

/** The same records, on a system with no update-by-id. */
const logSchema: InstanceSchema = { ...crmSchema, supportsInPlaceUpdate: false };

const catalog = mockCatalog({
  adapters: {
    attio: { constructionArgs: [], schema: crmSchema },
    log: { constructionArgs: [], schema: logSchema },
  },
});

const PRELUDE = ['import { attio, log } from adapters', 'crm = attio()', 'book = log()'];

function source(body: string[]): string {
  return [...PRELUDE, 'movement run() {', ...body.map((l) => `  ${l}`), '}'].join('\n');
}

function codes(body: string[]): string[] {
  return checkProgram(parseProgram(source(body)), catalog)
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);
}

function firstWrite(body: string[]): WriteExpression {
  const program = parseProgram(source(body));
  const movement = program.statements.find((s) => s.kind === 'movement');
  if (movement?.kind !== 'movement') throw new Error('no movement');
  const statement = movement.body.find((s) => s.kind === 'write');
  if (statement?.kind !== 'write') throw new Error('no write');
  return statement.write;
}

describe('a write starts from a member path', () => {
  it('parses `write m.k { … }` as an in-place update of what the path holds', () => {
    const target = firstWrite(['write m.k { Tag: "x" }']).target;
    expect(target).toMatchObject({ kind: 'position', root: { kind: 'expression', expr: { raw: 'm.k' } } });
  });

  it('parses a linked write and a tuple path off a member path, nested keys and backticks included', () => {
    expect(firstWrite(['write m.k.inner-[:Founders]-> { First: "Ann" }']).target).toMatchObject({
      kind: 'linked',
      path: { root: { kind: 'expression', expr: { raw: 'm.k.inner' } }, hopsRaw: '-[:Founders]->' },
    });
    expect(firstWrite(['write m.`a key` { Tag: "x" }']).target).toMatchObject({
      root: { kind: 'expression', expr: { raw: 'm.`a key`' } },
    });
    const tuple = firstWrite(['write (m.k-[:Founders]->, p-[:Founders]->) { First: "Ann" }']).target;
    expect(tuple.kind === 'tuple' ? tuple.paths.map((p) => p.root) : []).toEqual([
      { kind: 'expression', expr: expect.objectContaining({ raw: 'm.k' }) },
      { kind: 'name', name: 'p' },
    ]);
  });

  it('refuses a call as the start, with the binding to make — linked or in place', () => {
    expect(() => parseProgram(source(['write FIRST(cs)-[:Founders]-> { First: "Ann" }']))).toThrow(
      /A write starts from a record a name or a member path holds \('parent', 'm\.k'\) — bind this one first: 'parent = FIRST\(cs\)'/,
    );
    expect(() => parseProgram(source(['write FIRST(cs) { Tag: "x" }']))).toThrow(/bind this one first: 'parent = FIRST\(cs\)'/);
    expect(() => parseProgram(source(['write (FIRST(cs)-[:Founders]->, p-[:Founders]->) { First: "Ann" }']))).toThrow(
      /Every tuple path starts at a record a name or a member path holds/,
    );
  });

  it('checks clean where binding the path first does, for a system record', () => {
    const walk = 'crm-[c:Companies]-> {';
    expect(codes([walk, '  m = { k: c }', '  write m.k { Tag: "x" }', '  write m.k-[:Founders]-> { First: "Ann" }', '}'])).toEqual([]);
    expect(codes([walk, '  m = { k: { inner: c } }', '  write m.k.inner { Tag: "x" }', '}'])).toEqual([]);
    expect(codes([walk, '  m = { k: c }', '  x = m.k', '  write x { Tag: "x" }', '}'])).toEqual([]);
  });

  it('checks the body against the record’s shape', () => {
    expect(codes(['crm-[c:Companies]-> {', '  m = { k: c }', '  write m.k { Nope: "x" }', '}'])).toEqual(
      codes(['crm-[c:Companies]-> {', '  m = { k: c }', '  x = m.k', '  write x { Nope: "x" }', '}']),
    );
    expect(codes(['crm-[c:Companies]-> {', '  m = { k: c }', '  write m.k { Nope: "x" }', '}'])).toEqual(['MOV_WRITE_UNKNOWN_FIELD']);
  });

  it('refuses what binding the path first refuses', () => {
    expect(codes(['m = { k: "text" }', 'write m.k { Tag: "x" }'])).toEqual(['MOV_WRITE_POSITION_NOT_RECORD']);
    expect(codes(['book-[c:Companies]-> {', '  m = { k: c }', '  write m.k { Tag: "x" }', '}'])).toEqual([
      'MOV_WRITE_POSITION_NO_UPDATE',
    ]);
  });
});
