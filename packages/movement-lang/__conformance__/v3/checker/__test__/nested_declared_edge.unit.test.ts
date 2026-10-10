// Checker coverage for the NESTED declared edge — the half of a declared node
// that a local write could type but never populate.
//
// `node Entry { name: <text>  node founder { … } }` says an Entry carries a
// `founder` edge. A landing written into an `<Entry>`-typed edge is an Entry,
// so it carries that edge too — empty, and appendable by `link` exactly as the
// literal's own declared edge is. Without it the shape type-checked on the way
// out (a traversal reads the nested fields) and nothing could ever put a
// landing there, which is the gap these pin shut.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const inboxSchema: InstanceSchema = {
  positions: {
    message: { properties: { Subject: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

// A real system, so the ADDRESS spelling of a declared edge has an address to
// name — and so a landing that lives in a system can be told from one that
// does not.
const chatSchema: InstanceSchema = {
  positions: {
    Channel: {
      properties: { Name: 'text' },
      edges: { Messages: { target: 'ChatMessage', readable: true, writable: true } },
    },
    ChatMessage: { properties: { Text: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'Channel' } },
  writableRoots: {
    Channel: { fields: { Name: 'text' }, resultShape: { externalId: 'text' } },
    ChatMessage: { fields: { Text: 'text' }, resultShape: { externalId: 'text' } },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [], schema: inboxSchema },
    chat: { constructionArgs: [], schema: chatSchema },
  },
});

// `Entry` is a small TREE: fields, and a nested node that is an edge of it.
// `Deep` nests twice, so recursion has something to recurse through.
const PRELUDE = `import { email, chat } from adapters
inbox = email()
sl = chat()

node Entry {
  name: <text>
  node founder {
    first: <text>
    last: <text>
  }
}

node Deep {
  name: <text>
  node founder {
    first: <text>
    node profile {
      url: <text>
    }
  }
}

node Ordered {
  name: <text>
  node founder {
    first: <text>
    last: <text>
  } order by arrival
}
`;

const SHAPED = 'deduped = node { entries: <Entry> }';
const WRITTEN = '  h = write deduped-[:entries]-> { unique by (FUZZY `name`)\n    name: "Acme"\n  }';
const FOUNDER = '  f = node { first: "Jane", last: "Doe" }';

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement m(e: <inbox-[:message]->>) {
  ${SHAPED}
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

describe('a written landing carries the shape’s nested edges', () => {
  it('a `link` onto a nested declared edge is accepted', () => {
    expect(codes(`${WRITTEN}\n${FOUNDER}\n  link h -[:founder]-> f`)).toEqual([]);
  });

  it('a landing missing something the nested node declares is refused, naming it', () => {
    const body = `${WRITTEN}
  half = node { first: "Jane" }
  link h -[:founder]-> half`;
    expect(codes(body)).toContain(C.NODE_LINK_SHAPE);
    expect(messages(body)).toMatch(/`last`/);
  });

  it('a landing from a TRAVERSAL is judged by the position’s own surface', () => {
    const body = `${WRITTEN}
  sl-[:Channels]->-[m:Messages]-> {
    link h -[:founder]-> m
  }`;
    expect(codes(body)).toContain(C.NODE_LINK_SHAPE);
    expect(messages(body)).toMatch(/`first`/);
  });

  it('nesting recurses — the nested node’s own nested node is an edge too', () => {
    const body = `  deep = node { entries: <Deep> }
  d = write deep-[:entries]-> { name: "Acme" }
  g = write d-[:founder]-> { first: "Jane" }
  p = node { url: "jane.test" }
  link g -[:profile]-> p`;
    expect(codes(body)).toEqual([]);
  });

  it('an ADDRESS-typed edge mints none — its landings are one system’s records', () => {
    const body = `  sent = node { messages: <sl-[:Channels]->> }
  c = write sent-[:messages]-> { Name: "general" }
  m = node { Text: "hi" }
  link c -[:Messages]-> m`;
    expect(codes(body)).toContain(C.NODE_EDGE_UNDECLARED);
  });
});

describe('an undeclared edge is ONE diagnostic', () => {
  it('names the edges the shape declares', () => {
    const body = `${WRITTEN}\n${FOUNDER}\n  link h -[:nope]-> f`;
    expect(codes(body)).toEqual([C.NODE_EDGE_UNDECLARED]);
    expect(messages(body)).toMatch(/founder/);
  });

  it('says the same thing whether a `link` or a `write` asked', () => {
    const linked = messages(`${WRITTEN}\n${FOUNDER}\n  link h -[:nope]-> f`);
    const written = messages(`${WRITTEN}\n  write h-[:nope]-> { first: "Jane" }`);
    expect(written).toEqual(linked);
  });

  it('a node with no edges at all is told how to declare one', () => {
    const body = `  bare = node { name: "Acme" }\n${FOUNDER}\n  link bare -[:founder]-> f`;
    expect(codes(body)).toEqual([C.NODE_EDGE_UNDECLARED]);
    expect(messages(body)).toMatch(/founder: <SomeNode>/);
  });
});

describe('what the nested edge reads back as', () => {
  it('two hops type the nested fields', () => {
    const body = `${WRITTEN}\n${FOUNDER}
  link h -[:founder]-> f
  deduped-[x:entries]-> {
    x-[g:founder]-> {
      n = g.\`first\`
    }
  }`;
    expect(codes(body)).toEqual([]);
  });

  it('a field the nested node never declares is refused through it', () => {
    const body = `  deduped-[x:entries]-> {
    x-[g:founder]-> {
      n = g.\`nope\`
    }
  }`;
    expect(codes(body)).toContain(C.UNKNOWN_PROPERTY);
  });
});

describe('a write into the nested edge', () => {
  it('is typed by the nested node — its fields, and no others', () => {
    expect(codes(`${WRITTEN}\n  write h-[:founder]-> { first: "Jane", last: "Doe" }`)).toEqual([]);
  });

  it('a field the nested node never carries is refused, naming the ones it has', () => {
    const body = `${WRITTEN}\n  write h-[:founder]-> { nope: "x" }`;
    expect(codes(body)).toContain(C.WRITE_UNKNOWN_FIELD);
    expect(messages(body)).toMatch(/first/);
  });

  it('hands back a landing that reads its fields by dot', () => {
    const body = `${WRITTEN}
  g = write h-[:founder]-> { first: "Jane", last: "Doe" }
  n = g.\`first\``;
    expect(codes(body)).toEqual([]);
  });
});

// `node founder { … } order by arrival` — the author saying THIS nested edge's
// landings keep an order. It reaches the set/list split the same road every
// other sequencing claim takes (`EdgeSchema.sequenced`), on both paths a
// declared type reaches a position from: a written local landing, and a bare
// PARAMETER typed by the declaration.
describe('a nested declared node can say its order', () => {
  const ORDERED_SHAPED = 'deduped = node { entries: <Ordered> }';
  const ORDERED_WRITTEN =
    '  h = write deduped-[:entries]-> { unique by (FUZZY `name`)\n    name: "Acme"\n  }';

  function checkOrdered(body: string): Diagnostic[] {
    const source = `${PRELUDE}
movement m(e: <inbox-[:message]->>) {
  ${ORDERED_SHAPED}
${body}
}`;
    return checkProgram(parseProgram(source), catalog).filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
  }
  const orderedCodes = (body: string): string[] => checkOrdered(body).map((d) => d.code);

  it('without the clause, FIRST over a written landing’s nested edge is refused', () => {
    const body = `${WRITTEN}
  f1 = write h-[:founder]-> { first: "Jane", last: "Doe" }
  x = FIRST(h-[g:founder]->)`;
    expect(codes(body)).toContain('MOV_FOLD_NEEDS_ORDER');
  });

  it('with it, FIRST reads the first founder written onto the landing — clean, no ORDER BY anywhere', () => {
    const body = `${ORDERED_WRITTEN}
  f1 = write h-[:founder]-> { first: "Jane", last: "Doe" }
  f2 = write h-[:founder]-> { first: "Jo", last: "Bloggs" }
  x = FIRST(h-[g:founder]->)`;
    expect(orderedCodes(body)).toEqual([]);
  });

  it('the declaration is the same fact off a bare PARAMETER typed by it, with no write in sight', () => {
    const source = `${PRELUDE}
function f(e: <Entry>) {
  x = FIRST(e-[g:founder]->)
}`;
    const unordered = checkProgram(parseProgram(source), catalog).filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    expect(unordered.map((d) => d.code)).toContain('MOV_FOLD_NEEDS_ORDER');

    const orderedSource = `${PRELUDE}
function g(e: <Ordered>) {
  x = FIRST(e-[f:founder]->)
}`;
    const ordered = checkProgram(parseProgram(orderedSource), catalog).filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    expect(ordered).toEqual([]);
  });
});
