// Parser coverage for `node { … }` — in-memory node synthesis (layer 8 take 4).
//
// The literal sits on the POSITION plane, like `write`: it is an RValue and a
// call argument, never a value inside an expression. Its entries carry no
// marker — the entry's KIND is what says field or edge (ruling 1).

import { parseProgram } from '../parse';
import { MovementParseError } from '../parse';
import type { AssignStatement, CallStatement, NodeEntry, NodeLiteral, Statement } from '../ast';

function body(source: string): Statement[] {
  const program = parseProgram(`movement m(e: <inbox-[:message]->>) {\n${source}\n}`);
  const movement = program.statements.find((s) => s.kind === 'movement');
  if (movement?.kind !== 'movement') throw new Error('expected a movement');
  return movement.body;
}

function assign(source: string): AssignStatement {
  const [statement] = body(source);
  if (statement?.kind !== 'assign') throw new Error(`expected an assignment, got ${statement?.kind}`);
  return statement;
}

function literal(source: string): NodeLiteral {
  const value = assign(source).value;
  if (value.kind !== 'node') throw new Error(`expected a node literal, got ${value.kind}`);
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

describe('node literals — value entries', () => {
  it('binds a literal whose entries are expression slots', () => {
    const node = literal('d = node { title: e.`Subject`, body: e.`Body` }');
    expect(node.entries.map((entry) => entry.name)).toEqual(['title', 'body']);
    const title = entry(node, 'title');
    expect(title.kind).toBe('value');
    if (title.kind !== 'value') throw new Error('unreachable');
    expect(title.value.raw.trim()).toBe('e.`Subject`');
  });

  it('newline-separated entries need no commas', () => {
    const node = literal('d = node {\n  title: e.`Subject`\n  body: e.`Body`\n}');
    expect(node.entries.map((entry) => entry.name)).toEqual(['title', 'body']);
  });

  it('a backtick-quoted entry name keeps its verbatim spelling', () => {
    const node = literal('d = node { `Deal Name`: e.`Subject` }');
    expect(node.entries.map((entry) => entry.name)).toEqual(['Deal Name']);
  });

  it('an ordinary list value stays an expression — not a plural edge', () => {
    const node = literal('d = node { tags: ["a", "b"] }');
    const tags = entry(node, 'tags');
    expect(tags.kind).toBe('value');
    if (tags.kind !== 'value') throw new Error('unreachable');
    expect(tags.value.raw.trim()).toBe('["a", "b"]');
  });

  it('an object-literal value survives the brace scan', () => {
    const node = literal('d = node { payload: { type: "section" }, title: "x" }');
    expect(node.entries.map((entry) => entry.name)).toEqual(['payload', 'title']);
    const payload = entry(node, 'payload');
    if (payload.kind !== 'value') throw new Error('unreachable');
    expect(payload.value.raw.trim()).toBe('{ type: "section" }');
  });
});

describe('node literals — synthesised edges (ruling 5)', () => {
  it('a nested literal is an edge with ONE landing', () => {
    const node = literal('d = node { title: "x", company: node { name: e.`From` } }');
    const company = entry(node, 'company');
    expect(company.kind).toBe('nodes');
    if (company.kind !== 'nodes') throw new Error('unreachable');
    expect(company.nodes).toHaveLength(1);
    expect(company.nodes[0].entries.map((e) => e.name)).toEqual(['name']);
  });

  it('a list of literals is a PLURAL edge', () => {
    const node = literal(
      'd = node { files: [node { name: "a" }, node { name: "b" }], title: "x" }',
    );
    const files = entry(node, 'files');
    if (files.kind !== 'nodes') throw new Error('expected a synthesised edge');
    expect(files.nodes).toHaveLength(2);
    expect(files.nodes.map((n) => n.entries.length)).toEqual([1, 1]);
  });

  it('literals nest arbitrarily deep', () => {
    const node = literal('d = node { a: node { b: node { c: "deep" } } }');
    const a = entry(node, 'a');
    if (a.kind !== 'nodes') throw new Error('unreachable');
    const b = entry(a.nodes[0], 'b');
    if (b.kind !== 'nodes') throw new Error('unreachable');
    expect(b.nodes[0].entries[0].name).toBe('c');
  });

  it('an entry after a nested literal parses on the next line', () => {
    const node = literal('d = node {\n  company: node { name: "acme" }\n  title: "x"\n}');
    expect(node.entries.map((entry) => entry.name)).toEqual(['company', 'title']);
  });
});

describe('pass-through edges — traversal entries (wave 2)', () => {
  it('a traversal entry is an edge sourced from a walk, eager by default', () => {
    const files = entry(literal('d = node { files: e-[a:Attachments]-> }'), 'files');
    if (files.kind !== 'traversal') throw new Error('expected a traversal entry');
    expect(files.lazy).toBe(false);
    expect(files.head.root).toEqual({ kind: 'name', name: 'e' });
    expect(files.head.hopsRaw).toBe('-[a:Attachments]->');
  });

  it('`lazy` in front of it defers the same walk', () => {
    const files = entry(literal('d = node { files: lazy e-[a:Attachments]-> }'), 'files');
    if (files.kind !== 'traversal') throw new Error('expected a traversal entry');
    expect(files.lazy).toBe(true);
    expect(files.head.hopsRaw).toBe('-[a:Attachments]->');
  });

  it('WHERE / ORDER BY / LIMIT ride along inside the hop, with no grammar here', () => {
    const files = entry(
      literal('d = node { files: lazy e-[a:Attachments WHERE a.`Kind` == "pdf" ORDER BY `Name` LIMIT 2]-> }'),
      'files',
    );
    if (files.kind !== 'traversal') throw new Error('expected a traversal entry');
    expect(files.head.hopsRaw).toContain('WHERE');
    expect(files.head.hopsRaw).toContain('LIMIT 2');
  });

  it('a traversal entry sits beside value and literal entries', () => {
    const node = literal(
      'd = node {\n  title: e.`Subject`\n  files: lazy e-[a:Attachments]->\n  company: node { name: "acme" }\n}',
    );
    expect(node.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ['title', 'value'],
      ['files', 'traversal'],
      ['company', 'nodes'],
    ]);
  });

  it('multi-hop chains stay one head', () => {
    const files = entry(
      literal('d = node { files: e-[a:Attachments]->-[b:Versions]-> }'),
      'files',
    );
    if (files.kind !== 'traversal') throw new Error('expected a traversal entry');
    expect(files.head.hopsRaw).toBe('-[a:Attachments]->-[b:Versions]->');
  });
});

describe('per-item synthesis — the `-> node { … }` tail (wave 3)', () => {
  it('the tail is the entry’s MAPPING, and the head keeps its own hops', () => {
    const files = entry(
      literal('d = node { files: lazy e-[a:Attachments]-> node { name: a.`Name`, blob: a.`File` } }'),
      'files',
    );
    if (files.kind !== 'traversal') throw new Error('expected a traversal entry');
    expect(files.lazy).toBe(true);
    expect(files.head.hopsRaw).toBe('-[a:Attachments]->');
    expect(files.mapping?.entries.map((e) => [e.name, e.kind])).toEqual([
      ['name', 'value'],
      ['blob', 'value'],
    ]);
  });

  it('the eager form takes the same tail', () => {
    const files = entry(
      literal('d = node { files: e-[a:Attachments]-> node { blob: a.`File` } }'),
      'files',
    );
    if (files.kind !== 'traversal') throw new Error('expected a traversal entry');
    expect(files.lazy).toBe(false);
    expect(files.mapping?.entries.map((e) => e.name)).toEqual(['blob']);
  });

  it('a tail is a literal like any other — its entries may be edges too', () => {
    const files = entry(
      literal(
        'd = node { files: e-[a:Attachments]-> node { blob: a.`File`, versions: a-[v:Versions]-> node { label: v.`Label` } } }',
      ),
      'files',
    );
    if (files.kind !== 'traversal') throw new Error('expected a traversal entry');
    const versions = files.mapping?.entries.find((e) => e.name === 'versions');
    if (versions?.kind !== 'traversal') throw new Error('expected a nested traversal entry');
    expect(versions.head.root).toEqual({ kind: 'name', name: 'a' });
    expect(versions.mapping?.entries.map((e) => e.name)).toEqual(['label']);
  });

  it('a mapped entry sits beside an unmapped one — the tail is optional', () => {
    const node = literal(
      'd = node {\n  raw: e-[a:Attachments]->\n  mapped: e-[b:Attachments]-> node { blob: b.`File` }\n}',
    );
    const [raw, mapped] = node.entries;
    if (raw.kind !== 'traversal' || mapped.kind !== 'traversal') {
      throw new Error('expected two traversal entries');
    }
    expect(raw.mapping).toBeUndefined();
    expect(mapped.mapping).toBeDefined();
  });

  it('a `node` on the NEXT line is the next entry, not a tail', () => {
    // A newline ends the entry, here as everywhere — so this reads as an entry
    // named `node` with no ':' after it, and says so.
    expectParseError(
      'd = node {\n  files: e-[a:Attachments]->\n  node { blob: a.`File` }\n}',
      /after the entry name 'node'/,
    );
  });
});

describe('`lazy` on an ordinary binding (wave 2)', () => {
  it('binds the deferred traversal, in the `await` slot', () => {
    const value = assign('files = lazy e-[a:Attachments]->').value;
    if (value.kind !== 'lazy') throw new Error(`expected a lazy traversal, got ${value.kind}`);
    expect(value.lazy.head.root).toEqual({ kind: 'name', name: 'e' });
    expect(value.lazy.head.hopsRaw).toBe('-[a:Attachments]->');
  });

  it('`lazy` stays an ordinary name when it modifies nothing', () => {
    expect(assign('x = lazy').value.kind).toBe('expr');
    expect(assign('lazy = e.`Subject`').name).toBe('lazy');
  });

  it('it takes the per-item tail too — the mapping belongs to the WALK', () => {
    const value = assign('files = lazy e-[a:Attachments]-> node { blob: a.`File` }').value;
    if (value.kind !== 'lazy') throw new Error(`expected a lazy traversal, got ${value.kind}`);
    expect(value.lazy.head.hopsRaw).toBe('-[a:Attachments]->');
    expect(value.lazy.mapping?.entries.map((e) => e.name)).toEqual(['blob']);
  });

  it('a non-traversal after `lazy` is refused by name', () => {
    expectParseError('x = lazy e', /Expected a traversal to defer/);
  });

  it('an argument cannot be a deferred traversal — bind it above', () => {
    expectParseError('process(files: lazy e-[a:Attachments]->)', /bind the deferred traversal above/);
  });
});

describe('node literals as call arguments', () => {
  it('an inline literal is a named argument', () => {
    const [statement] = body('process(d: node { title: e.`Subject` })');
    if (statement?.kind !== 'call') throw new Error('expected a call');
    const call: CallStatement = statement;
    expect(call.args).toHaveLength(1);
    const [arg] = call.args;
    expect(arg.kind).toBe('node');
    if (arg.kind !== 'node') throw new Error('unreachable');
    expect(arg.name).toBe('d');
    expect(arg.node.entries.map((e) => e.name)).toEqual(['title']);
  });

  it('a node argument sits beside ordinary ones', () => {
    const [statement] = body('process(a: e, d: node { title: "x" })');
    if (statement?.kind !== 'call') throw new Error('expected a call');
    expect(statement.args.map((arg) => arg.kind)).toEqual(['expr', 'node']);
  });
});

describe('`node` stays an ordinary name where it is not a literal', () => {
  it('a binding called `node` still binds', () => {
    const statement = assign('node = e.`Subject`');
    expect(statement.name).toBe('node');
    expect(statement.value.kind).toBe('expr');
  });

  it('a bare `node` reference is an expression, not a literal', () => {
    const statement = assign('x = node');
    expect(statement.value.kind).toBe('expr');
  });

  it('an entry named `node` is a field', () => {
    const node = literal('d = node { node: e.`Subject` }');
    expect(entry(node, 'node').kind).toBe('value');
  });
});

describe('what a node literal refuses', () => {
  it('an effect as an entry value is refused by name', () => {
    expectParseError(
      'd = node { rec: write crm-[:company]-> { name: "x" } }',
      /only computes.*'write' acts/,
    );
  });

  it('every acting form is named, not just `write`', () => {
    expectParseError('d = node { r: await FIRST(x-[:Response]->) }', /'await' acts/);
    expectParseError('d = node { r: extract from [e] { } }', /'extract' acts/);
  });

  it('a `node { … }` after an entry that is NOT a traversal is refused', () => {
    // The tail belongs to a WALK — there is nothing to map per item after a
    // nested literal, so this is the ordinary "one entry, one value" error.
    expectParseError(
      'd = node { company: node { name: "x" } node { name: "y" } }',
      /Expected ',' or a newline after the entry 'company'/,
    );
  });

  it('`lazy` in front of something that is not a traversal says so', () => {
    expectParseError('d = node { files: lazy e }', /has none to defer/);
  });

  it('`lazy` stays an ordinary name where it modifies nothing', () => {
    // Contextual, exactly like `node`: the bare word is still a value.
    const files = entry(literal('d = node { files: lazy }'), 'files');
    expect(files.kind).toBe('value');
    if (files.kind !== 'value') throw new Error('unreachable');
    expect(files.value.raw.trim()).toBe('lazy');
  });

  it('`lazy await` is refused as the nonsense it is', () => {
    expectParseError('d = node { r: lazy await FIRST(x-[:Response]->) }', /can't be both/);
    expectParseError('r = lazy await FIRST(x-[:Response]->)', /can't be both/);
  });

  it('an unclosed literal names the brace it needs', () => {
    // At file scope there is no enclosing `}` to be mistaken for the literal's,
    // so the run of braces ends where the literal opened.
    expect(() => parseProgram('d = node { title: "x"\n')).toThrow(
      /Expected '\}' to close the node literal/,
    );
  });
});

// The DECLARED edge — an address type marker standing where a value would,
// saying what the edge's landings are and starting with none.
describe('node literals — declared edge entries', () => {
  it('an address marker declares an edge and keeps the hop chain as written', () => {
    const node = literal('d = node { messages: <slack-[:Channels]->-[:Messages]->> }');
    const messages = entry(node, 'messages');
    expect(messages.kind).toBe('declared');
    if (messages.kind !== 'declared') throw new Error('unreachable');
    expect(messages.type.graph).toBe('slack');
    expect(messages.type.hopsRaw).toBe('-[:Channels]->-[:Messages]->');
  });

  it('a single unpinned hop also names the position it lands on', () => {
    const node = literal('d = node { people: <kg-[:person]->> }');
    const people = entry(node, 'people');
    if (people.kind !== 'declared') throw new Error('unreachable');
    expect(people.type.position).toBe('person');
  });

  it('it sits beside the other entry kinds, one per line', () => {
    const node = literal(
      'd = node {\n  title: e.`Subject`\n  sent: <slack-[:Messages]->>\n  co: node { name: "x" }\n}',
    );
    expect(node.entries.map((e) => e.kind)).toEqual(['value', 'declared', 'nodes']);
  });

  it('a marker with NO hops is a DECLARED NODE reference — the checker resolves the name', () => {
    const node = literal('d = node { companies: <Company> }');
    const companies = entry(node, 'companies');
    expect(companies.kind).toBe('declared');
    if (companies.kind !== 'declared') throw new Error('unreachable');
    expect(companies.type.graph).toBe('Company');
    expect(companies.type.hopsRaw).toBeUndefined();
  });

  it('the retired dotted spelling still names its address replacement', () => {
    expectParseError('d = node { messages: <slack.Messages> }', /Write '<slack-\[:Messages\]->>'/);
  });
});

// `order by <sequencing>` — the author saying the entry's landings KEEP an
// order. Trailing and lowercase, like `unique by`, and it takes one of the
// three words the language already has.
describe('node literals — a declared entry says its order', () => {
  it('an ADDRESS marker takes the clause', () => {
    const node = literal('d = node { messages: <slack-[:Channels]->-[:Messages]->> order by arrival }');
    const messages = entry(node, 'messages');
    if (messages.kind !== 'declared') throw new Error('unreachable');
    expect(messages.type.hopsRaw).toBe('-[:Channels]->-[:Messages]->');
    expect(messages.sequenced).toBe('arrival');
  });

  it('a hop-less DECLARED NODE marker takes the same clause', () => {
    const node = literal('d = node { companies: <Company> order by arrival }');
    const companies = entry(node, 'companies');
    if (companies.kind !== 'declared') throw new Error('unreachable');
    expect(companies.type.hopsRaw).toBeUndefined();
    expect(companies.sequenced).toBe('arrival');
  });

  it('the other two words parse too — an author collecting pieces that were already in that order', () => {
    for (const word of ['document', 'chronological'] as const) {
      const node = literal(`d = node { pieces: <Company> order by ${word} }`);
      const pieces = entry(node, 'pieces');
      if (pieces.kind !== 'declared') throw new Error('unreachable');
      expect(pieces.sequenced).toBe(word);
    }
  });

  it('without the clause the entry claims nothing — a SET, as before', () => {
    const node = literal('d = node { companies: <Company> }');
    const companies = entry(node, 'companies');
    if (companies.kind !== 'declared') throw new Error('unreachable');
    expect(companies.sequenced).toBeUndefined();
  });

  it('it sits on one line with the entries around it', () => {
    const node = literal(
      'd = node {\n  title: e.`Subject`\n  sent: <slack-[:Messages]->> order by arrival\n  co: node { name: "x" }\n}',
    );
    expect(node.entries.map((e) => e.kind)).toEqual(['value', 'declared', 'nodes']);
    const sent = entry(node, 'sent');
    if (sent.kind !== 'declared') throw new Error('unreachable');
    expect(sent.sequenced).toBe('arrival');
  });

  it('a word that is not one of the three is refused, and the three are named', () => {
    expectParseError(
      'd = node { companies: <Company> order by newest }',
      /'order by' takes one of 'arrival'.*'document'.*'chronological'/s,
    );
  });

  it("'order' with no 'by' is refused by name", () => {
    expectParseError('d = node { companies: <Company> order arrival }', /written 'order by'/);
  });
});
