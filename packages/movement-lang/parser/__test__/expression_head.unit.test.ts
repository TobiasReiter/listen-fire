// A block head that starts at an EXPRESSION.
//
// `AT(rows, 0)-[c:company]-> { … }` is the same walk as binding `AT(rows, 0)`
// to a name and hopping off the name; the head just says it in one line. The
// parser's job is to tell where the expression ends and the hops begin, which
// is the FIRST `-[` that is not inside a bracket or a literal — so a hop
// written INSIDE the expression (`ONLY(found-[c:company]->)`) stays part of it.
//
// What is pinned here: the three shapes parse, with the expression captured as
// its own slot; a hop inside the expression belongs to the expression; a name
// root is still a name root; the forms that are NOT expressions (a keyword-led
// statement, a node entry's neighbour across a comma) keep the meaning they
// had; and a write's parent is refused with the repair rather than parsed.

import { MovementParseError, parseProgram } from '../parse';
import { pathRootName, spellPathHead, probePathHead, EXPRESSION_ROOT_PROBE } from '../ast';
import type { PathHead, Statement } from '../ast';

function movementBody(body: string): Statement[] {
  const program = parseProgram(`movement m(msg: <in-[:message]->>) {\n${body}\n}`);
  const declaration = program.statements[0];
  if (declaration.kind !== 'movement') throw new Error('expected a movement');
  return declaration.body;
}

/** The head of the Nth block statement in the body. */
function headOf(body: string, index = 0): PathHead {
  const blocks = movementBody(body).filter((s) => s.kind === 'block');
  const block = blocks[index];
  if (block === undefined || block.kind !== 'block') throw new Error('expected a block statement');
  return block.block.head;
}

function parseError(body: string): string {
  try {
    movementBody(body);
  } catch (e) {
    if (e instanceof MovementParseError) return e.message;
    throw e;
  }
  throw new Error('expected a parse error');
}

describe('an expression at the head of a block', () => {
  it('a call root ends at the first hop, and rides as its own slot', () => {
    const head = headOf('  AT(rows, 0)-[c:company]-> {\n    x = c.`Name`\n  }');
    expect(head.root).toEqual({
      kind: 'expression',
      expr: expect.objectContaining({ raw: 'AT(rows, 0)' }),
    });
    expect(head.hopsRaw).toBe('-[c:company]->');
    expect(pathRootName(head)).toBeUndefined();
  });

  it('a property root — a record held in a field of another record', () => {
    const head = headOf('  r.a-[x:edge]-> {\n    y = x.`Name`\n  }');
    expect(head.root).toEqual({
      kind: 'expression',
      expr: expect.objectContaining({ raw: 'r.a' }),
    });
    expect(head.hopsRaw).toBe('-[x:edge]->');
  });

  it('a hop INSIDE the expression belongs to the expression, not to the head', () => {
    const head = headOf(
      '  ONLY(found-[c:company WHERE c.`Name` == "Acme"]->)-[f:founder]-> {\n    z = f.`Name`\n  }',
    );
    expect(head.root).toEqual({
      kind: 'expression',
      expr: expect.objectContaining({
        raw: 'ONLY(found-[c:company WHERE c.`Name` == "Acme"]->)',
      }),
    });
    expect(head.hopsRaw).toBe('-[f:founder]->');
  });

  it('two hops after the expression are both the head’s', () => {
    const head = headOf('  AT(rows, 0)-[c:company]->-[f:founder]-> {\n    z = f.`Name`\n  }');
    expect(head.hopsRaw).toBe('-[c:company]->-[f:founder]->');
  });

  it('spells back as source, and probes as a hop chain the formula grammar takes', () => {
    const head = headOf('  AT(rows, 0)-[c:company]-> {\n    x = c.`Name`\n  }');
    expect(spellPathHead(head)).toBe('AT(rows, 0)-[c:company]->');
    expect(probePathHead(head)).toBe(`${EXPRESSION_ROOT_PROBE}-[c:company]->`);
  });

  it('a lazy binding takes one too — laziness is when, not what', () => {
    const [statement] = movementBody('  files = lazy AT(rows, 0)-[a:Attachments]->');
    if (statement.kind !== 'assign' || statement.value.kind !== 'lazy') {
      throw new Error('expected a lazy traversal');
    }
    expect(statement.value.lazy.head.root).toEqual({
      kind: 'expression',
      expr: expect.objectContaining({ raw: 'AT(rows, 0)' }),
    });
  });

  it('a node literal’s pass-through entry takes one too', () => {
    const [statement] = movementBody('  d = node { files: AT(rows, 0)-[a:Attachments]-> }');
    if (statement.kind !== 'assign' || statement.value.kind !== 'node') {
      throw new Error('expected a node literal');
    }
    const entry = statement.value.node.entries.find((e) => e.name === 'files');
    if (entry?.kind !== 'traversal') throw new Error('expected a traversal entry');
    expect(entry.head.root).toEqual({
      kind: 'expression',
      expr: expect.objectContaining({ raw: 'AT(rows, 0)' }),
    });
  });
});

describe('what an expression head does NOT claim', () => {
  it('a bare name is still a NAME root', () => {
    const head = headOf('  rows-[c:company]-> {\n    x = c.`Name`\n  }');
    expect(head.root).toEqual({ kind: 'name', name: 'rows' });
  });

  it('a backticked name is still a NAME root, even with a dot in it', () => {
    const head = headOf('  `a.b`-[c:company]-> {\n    x = c.`Name`\n  }');
    expect(head.root).toEqual({ kind: 'name', name: 'a.b' });
  });

  it('a rootless head is still rootless', () => {
    const head = headOf('  -[c:company]-> {\n    x = c.`Name`\n  }');
    expect(head.root).toBeUndefined();
  });

  it('a keyword-led statement is that statement — the space says so', () => {
    // `write crm-[:companies]-> { … }` is a write, not a head rooted at
    // `write crm`: the formula grammar has no juxtaposition, so two tokens
    // separated by a space are never one expression.
    const [statement] = movementBody('  write crm-[:companies]-> {\n    `Name`: "Acme"\n  }');
    expect(statement.kind).toBe('write');
  });

  it('a node entry does not reach across the comma into its neighbour', () => {
    const [statement] = movementBody(
      '  d = node { blob: a.`File`, versions: a-[v:Versions]-> }',
    );
    if (statement.kind !== 'assign' || statement.value.kind !== 'node') {
      throw new Error('expected a node literal');
    }
    expect(statement.value.node.entries.map((e) => [e.name, e.kind])).toEqual([
      ['blob', 'value'],
      ['versions', 'traversal'],
    ]);
  });

  it('a call statement is still a call', () => {
    const [statement] = movementBody('  notify(to: "a@b.c")');
    expect(statement.kind).toBe('call');
  });
});

describe('a write’s parent is a record a name or a member path holds', () => {
  it('an expression parent is refused where it is written, with the binding to make', () => {
    expect(parseError('  write ONLY(rows)-[:founder]-> {\n    `Name`: "Jane Doe"\n  }')).toMatch(
      /A write starts from a record a name or a member path holds \('parent', 'm\.k'\) — bind this one first: 'parent = ONLY\(rows\)'/,
    );
  });

  it('a named parent is untouched', () => {
    const [statement] = movementBody('  write crm-[:companies]-> {\n    `Name`: "Acme"\n  }');
    if (statement.kind !== 'write' || statement.write.target.kind !== 'linked') {
      throw new Error('expected a linked write');
    }
    expect(pathRootName(statement.write.target.path)).toBe('crm');
  });

  it('a tuple path names its parent too', () => {
    expect(
      parseError('  write (ONLY(rows)-[:e]->, b-[:f]->) {\n    `Name`: "Acme"\n  }'),
    ).toMatch(/Every tuple path starts at a record a name or a member path holds/);
  });
});
