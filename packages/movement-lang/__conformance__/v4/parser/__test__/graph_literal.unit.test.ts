// Parser coverage for graph literals — `graph<Shape> { … }` / `graph { … }`.
//
// `graph` is CONTEXTUAL: only its full opening (`graph {`, `graph<Name> {`) is
// the literal, so a program that names an instance `graph` keeps meaning what
// it meant. The body is a write body's field syntax read with the node
// literal's entry rules.

import { parseProgram, MovementParseError } from '../parse';
import type { CallStatement, NodeEntry, NodeLiteral, Statement } from '../ast';

function body(source: string): Statement[] {
  const program = parseProgram(`movement m(e: <inbox-[:message]->>) {\n${source}\n}`);
  const movement = program.statements.find((s) => s.kind === 'movement');
  if (movement?.kind !== 'movement') throw new Error('expected a movement');
  return movement.body;
}

function literal(source: string): NodeLiteral {
  const [statement] = body(source);
  const value = statement?.kind === 'assign' || statement?.kind === 'return' ? statement.value : undefined;
  if (value?.kind !== 'node') throw new Error(`expected a literal, got ${value?.kind}`);
  return value.node;
}

function entry(node: NodeLiteral, name: string): NodeEntry {
  const found = node.entries.find((e) => e.name === name);
  if (!found) throw new Error(`no entry '${name}'`);
  return found;
}

function expectParseError(source: string, pattern: RegExp): void {
  let thrown: unknown;
  try {
    body(source);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(MovementParseError);
  expect((thrown as Error).message).toMatch(pattern);
}

describe('graph literals — the opening', () => {
  it('graph<Shape> { … } records the shape and marks the literal a graph', () => {
    const node = literal('g = graph<Message> { text: e.Body }');
    expect(node.graph).toEqual({ shape: { name: 'Message', span: expect.anything() } });
    expect(entry(node, 'text').kind).toBe('value');
  });

  it('graph { … } has no shape', () => {
    expect(literal('g = graph { text: e.Body }').graph).toEqual({});
  });

  it('a backticked shape name and spaces inside the brackets', () => {
    expect(literal('g = graph< `Two Words` > {}').graph?.shape?.name).toBe('Two Words');
  });

  it('is a return value and a call argument', () => {
    expect(literal('return graph<Message> { text: e.Body }').graph?.shape?.name).toBe('Message');
    const [call] = body('log(d: graph<Message> { text: e.Body })');
    expect(call.kind).toBe('call');
    const [arg] = (call as CallStatement).args;
    expect(arg.kind === 'node' && arg.node.graph?.shape?.name).toBe('Message');
  });

  it('`graph` alone is still an ordinary name', () => {
    const [assign] = body('x = graph');
    expect(assign.kind === 'assign' && assign.value.kind).toBe('expr');
    const [compare] = body('x = graph < 3');
    expect(compare.kind === 'assign' && compare.value.kind).toBe('expr');
    expect(() =>
      parseProgram('import { kg } from adapters\ngraph = kg()\nlisten to graph { type: "company", events: ["record.created"] } fire m\nmovement m(e: <graph-[:company]->>) {\n}'),
    ).not.toThrow();
  });
});

describe('graph literals — entries', () => {
  it('a brace is a child node, and every nested body is a graph body', () => {
    const node = literal('g = graph { text: e.Body, part: { label: "a" } }');
    const part = entry(node, 'part');
    expect(part.kind).toBe('nodes');
    if (part.kind !== 'nodes') throw new Error('unreachable');
    expect(part.nodes).toHaveLength(1);
    expect(part.nodes[0].graph).toEqual({});
  });

  it('a list of braces is a plural child; a list of values stays a value', () => {
    const node = literal('g = graph { parts: [{ label: "a" }, { label: "b" }], tags: ["x", "y"] }');
    const parts = entry(node, 'parts');
    expect(parts.kind === 'nodes' && parts.nodes).toHaveLength(2);
    expect(entry(node, 'tags').kind).toBe('value');
  });

  it('a walk followed by a field body builds one child per record', () => {
    const node = literal(
      'g = graph<Message> {\n  text: e.Body,\n  attachment: e-[a:Attachments]-> { name: a.Name, type: a.Type, file: a.`File` },\n}',
    );
    const attachment = entry(node, 'attachment');
    expect(attachment.kind).toBe('traversal');
    if (attachment.kind !== 'traversal') throw new Error('unreachable');
    expect(attachment.lazy).toBe(false);
    expect(attachment.mapping?.graph).toEqual({});
    expect(attachment.mapping?.entries.map((e) => e.name)).toEqual(['name', 'type', 'file']);
  });

  it('a bare walk holds references (no body)', () => {
    const attachment = entry(literal('g = graph { files: e-[:Attachments]->\n}'), 'files');
    expect(attachment.kind === 'traversal' && attachment.mapping).toBeUndefined();
  });

  it('...spreads are kept in their own order, beside the entries', () => {
    const node = literal('g = graph<Message> { ...base, text: e.Body, ...more }');
    expect(node.spreads?.map((s) => s.source)).toEqual(['base', 'more']);
    expect(node.entries.map((e) => e.name)).toEqual(['text']);
  });

  it('the typed empty graph', () => {
    const node = literal('g = graph<Detailed> {}');
    expect(node.entries).toEqual([]);
    expect(node.spreads).toBeUndefined();
  });
});

describe('graph literals — refusals', () => {
  it("refuses the write body's lookup and merge words", () => {
    expectParseError('g = graph { unique by (name), name: "x" }', /'unique by'.*graph literal finds nothing/);
    expectParseError('g = graph { name ?: "x" }', /starts empty/);
    expectParseError('g = graph { tags +: ["x"] }', /starts empty/);
    expectParseError('g = graph { ?...base }', /starts empty/);
  });

  it("refuses the node literal's spellings, with the graph literal's own", () => {
    expectParseError('g = graph { part: node { label: "a" } }', /'part: \{ … \}'/);
    expectParseError('g = graph { parts: <Part> }', /every child node it declares starts empty/);
    expectParseError('g = graph { files: lazy e-[:Attachments]-> }', /already holds references/);
  });

  it('refuses effects in an entry', () => {
    expectParseError('g = graph { r: write crm-[:x]-> { a: 1 } }', /only computes/);
  });

  it('an unclosed shape is not the opening, so it stays an expression for the checker to refuse', () => {
    const [assign] = body('g = graph<Message { text: e.Body }');
    expect(assign.kind === 'assign' && assign.value.kind).toBe('expr');
  });
});
