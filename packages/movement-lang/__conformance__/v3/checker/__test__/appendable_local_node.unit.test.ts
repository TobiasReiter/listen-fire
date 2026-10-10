// Checker coverage for the appendable run-local node — a node literal entry
// that DECLARES an edge and starts it empty, and `link` appending landings to
// it as the run goes.
//
// The two facts worth pinning: the declared edge's type is the address WALKED
// (so traversing it afterwards is the ordinary traversal), and a `link` onto it
// is checked STRUCTURALLY — a local node belongs to no graph, so there is
// nothing nominal to compare by and nothing for the effect row to carry.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, Diagnostic, DiagnosticCodes as C } from '../check';
import { effectRowOf, type EffectRow } from '../effects';
import { InstanceSchema, mockCatalog } from '../catalog';

// The event source — the movement's parameter, plus one lazy-able edge.
const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text', Count: 'number' },
      edges: { Attachments: { target: 'attachment', readable: true } },
    },
    attachment: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

// The written graph: channels carry messages, messages carry replies, and
// people are the WRONG type to land on a messages edge.
const chatSchema: InstanceSchema = {
  positions: {
    Channel: {
      properties: { Name: 'text' },
      edges: { Messages: { target: 'ChatMessage', readable: true, writable: true } },
    },
    ChatMessage: {
      properties: { Text: 'text' },
      edges: { Replies: { target: 'ChatMessage', readable: true, writable: true } },
    },
    Person: { properties: { Email: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'Channel' }, People: { target: 'Person' } },
  writableRoots: {
    Channel: { fields: { Name: 'text' }, resultShape: { externalId: 'text' } },
    ChatMessage: { fields: { Text: 'text' }, resultShape: { externalId: 'text' } },
    Person: { fields: { Email: 'text' }, resultShape: { externalId: 'text' } },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [], schema: inboxSchema },
    chat: { constructionArgs: [], schema: chatSchema },
  },
});

// A DECLARED NODE — the structure a `<Feed>` entry says its landings have. A
// Channel carries all of it (Name, and a Messages edge whose landing carries
// Text); a Person carries none of it.
const PRELUDE = `import { email, chat } from adapters
inbox = email()
sl = chat()

node Feed {
  Name: <text>
  node Messages {
    Text: <text>
  }
}
`;

const DECLARED = 'sent = node { messages: <sl-[:Channels]->-[:Messages]->> }';

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement m(e: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

function rowOf(body: string): EffectRow {
  const source = `${PRELUDE}
movement m(e: <inbox-[:message]->>) {
${body}
}`;
  const { recording } = checkProgramWithLink(parseProgram(source), catalog, {
    recordAnalysis: true,
  });
  const file = recording?.frames.find((frame) => frame.kind === 'file');
  const symbol = file?.scope.symbols.get('m');
  if (symbol === undefined) throw new Error("'m' is not declared");
  const row = effectRowOf(symbol);
  if (row === undefined) throw new Error("'m' has no inferred row");
  return row;
}

describe('a declared edge is the address, walked', () => {
  it('types its landings, so a traversal reads their fields', () => {
    expect(codes(`  ${DECLARED}\n  sent-[x:messages]-> {\n    t = x.Text\n  }`)).toEqual([]);
  });

  it('a field the landing type does not carry is refused through it', () => {
    expect(codes(`  ${DECLARED}\n  sent-[x:messages]-> {\n    t = x.Nope\n  }`)).toContain(
      C.UNKNOWN_PROPERTY,
    );
  });

  it('an edge the address graph does not have is told at the declaration', () => {
    expect(codes('  sent = node { messages: <sl-[:Channels]->-[:Nope]->> }')).toContain(
      'MOV_TRAVERSE_UNKNOWN_EDGE',
    );
  });

  it('reading it by DOT is refused — it is an edge, not a field', () => {
    expect(codes(`  ${DECLARED}\n  x = sent.messages`)).toContain(C.UNKNOWN_PROPERTY);
  });
});

// `order by <sequencing>` — the author saying the entry's landings keep an
// order. It is the SAME claim an adapter makes with `EdgeSchema.sequenced`, so
// the set/list split reads it by the one road, and nothing else changes.
describe('a declared entry can say its order', () => {
  const ORDERED = 'sent = node { messages: <sl-[:Channels]->-[:Messages]->> order by arrival }';

  it('without the clause the edge is a SET — an order-sensitive fold is refused', () => {
    expect(codes(`  ${DECLARED}\n  t = JOIN(sent-[x:messages]->.Text, ", ")`)).toContain(
      'MOV_FOLD_NEEDS_ORDER',
    );
    expect(codes(`  ${DECLARED}\n  f = FIRST(sent-[x:messages]->)`)).toContain(
      'MOV_FOLD_NEEDS_ORDER',
    );
  });

  it('with it, JOIN and FIRST are clean — no ORDER BY anywhere', () => {
    expect(codes(`  ${ORDERED}\n  t = JOIN(sent-[x:messages]->.Text, ", ")`)).toEqual([]);
    expect(codes(`  ${ORDERED}\n  f = FIRST(sent-[x:messages]->)`)).toEqual([]);
    expect(codes(`  ${ORDERED}\n  l = LAST(sent-[x:messages]->.Text)`)).toEqual([]);
  });

  it('LIMIT with no ORDER BY is the same rule, discharged the same way', () => {
    expect(codes(`  ${DECLARED}\n  n = COUNT(sent-[x:messages LIMIT 3]->)`)).toContain(
      'MOV_LIMIT_NEEDS_ORDER',
    );
    expect(codes(`  ${ORDERED}\n  n = COUNT(sent-[x:messages LIMIT 3]->)`)).toEqual([]);
  });

  it('a bare traversal over it is the ordinary traversal, still', () => {
    expect(codes(`  ${ORDERED}\n  sent-[x:messages]-> {\n    t = x.Text\n  }`)).toEqual([]);
  });

  it('the DECLARED NODE spelling takes the clause too', () => {
    const body = `  feeds = node { channels: <Feed> order by arrival }
  t = JOIN(feeds-[c:channels]->.Name, ", ")`;
    expect(codes(body)).toEqual([]);
  });

  it('the clause changes nothing about what may LAND there', () => {
    const body = `  ${ORDERED}
  p = write sl-[:People]-> { Email: "a@b.com" }
  link sent -[:messages]-> p`;
    expect(codes(body)).toContain(C.NODE_LINK_SHAPE);
  });
});

describe('link appends a landing', () => {
  const written = `  ch = write sl-[:Channels]-> { Name: "general" }
  one = write ch-[:Messages]-> { Text: "hi" }`;

  it('a conforming write handle is accepted', () => {
    expect(codes(`  ${DECLARED}\n${written}\n  link sent -[:messages]-> one`)).toEqual([]);
  });

  it('a handle of the wrong type is refused, with both types named', () => {
    const body = `  ${DECLARED}
  p = write sl-[:People]-> { Email: "a@b.com" }
  link sent -[:messages]-> p`;
    expect(codes(body)).toContain(C.NODE_LINK_SHAPE);
    expect(messages(body)).toMatch(/ChatMessage/);
    expect(messages(body)).toMatch(/Person/);
  });

  it('a traversed position of the landing type is accepted — any position lands', () => {
    const body = `  ${DECLARED}
  sl-[:Channels]->-[msg:Messages]-> {
    link sent -[:messages]-> msg
  }`;
    expect(codes(body)).toEqual([]);
  });

  it('an edge the literal never declared is refused, naming what it has', () => {
    const body = `  ${DECLARED}\n${written}\n  link sent -[:nope]-> one`;
    expect(codes(body)).toContain(C.NODE_EDGE_UNDECLARED);
    expect(messages(body)).toMatch(/messages/);
  });

  it('a lazy entry is refused — its landings are recomputed at every read', () => {
    const body = `  sent = node { files: lazy e-[a:Attachments]-> }
${written}
  link sent -[:files]-> one`;
    expect(codes(body)).toContain(C.NODE_EDGE_DEFERRED);
  });

  it('a match looks among the landings a node this run built carries — no system, no effect', () => {
    const body = `  ${DECLARED}\n  hit = match sent-[:messages]-> { unique by (FUZZY \`Text\`), Text: "hi" }\n  t = hit.Text`;
    expect(codes(body)).toEqual([]);
    const row = rowOf(body);
    expect(row.read).toEqual([]);
    expect(row.write).toEqual([]);
  });
});

describe('what the link does NOT change', () => {
  it('a link inside an if arm survives the arm — the graph it grew is the one `sent` names', () => {
    const body = `  ${DECLARED}
  ch = write sl-[:Channels]-> { Name: "general" }
  if (e.\`Count\` > 1) {
    one = write ch-[:Messages]-> { Text: "a" }
    link sent -[:messages]-> one
  } else {
    two = write ch-[:Messages]-> { Text: "b" }
    link sent -[:messages]-> two
  }
  sent-[x:messages]-> {
    write x-[:Replies]-> { Text: "done" }
  }`;
    expect(codes(body)).toEqual([]);
  });

  it('rebinding the node is still refused — names never change', () => {
    expect(codes(`  ${DECLARED}\n  ${DECLARED}`)).toContain(C.REBOUND_NAME);
  });

  it('adds nothing to the effect row — run-local mutation is not an effect', () => {
    const row = rowOf(`  ${DECLARED}
  sl-[:Channels]->-[msg:Messages]-> {
    link sent -[:messages]-> msg
  }`);
    expect(row.write).toEqual([]);
    expect(row.partial).toBe(false);
  });
});

// A declared edge typed by a DECLARED NODE rather than by an address. The entry
// still starts empty and still grows by `link`; what changes is where the
// landing type comes from — a structure this file declares, belonging to no
// system — and therefore how a landing is judged: structurally, exactly as an
// argument reaching a `<Feed>` parameter is, because there is no instance to
// compare.
describe('a declared node types a declared edge', () => {
  const SHAPED = 'feeds = node { channels: <Feed> }';

  it('the entry is accepted — a structure says what lands there', () => {
    expect(codes(`  ${SHAPED}`)).toEqual([]);
  });

  it('reading it back sees the fields the DECLARATION carries', () => {
    expect(codes(`  ${SHAPED}\n  feeds-[c:channels]-> {\n    n = c.\`Name\`\n  }`)).toEqual([]);
  });

  it('a field the declaration never carries is refused through it', () => {
    expect(codes(`  ${SHAPED}\n  feeds-[c:channels]-> {\n    n = c.\`Nope\`\n  }`)).toContain(
      C.UNKNOWN_PROPERTY,
    );
  });

  it('a nested declared node is an edge off the landing', () => {
    const body = `  ${SHAPED}
  feeds-[c:channels]-> {
    c-[mm:Messages]-> {
      t = mm.\`Text\`
    }
  }`;
    expect(codes(body)).toEqual([]);
  });

  it('a record carrying the declared structure is appended', () => {
    const body = `  ${SHAPED}
  sl-[ch:Channels]-> {
    link feeds -[:channels]-> ch
  }`;
    expect(codes(body)).toEqual([]);
  });

  it('a record missing part of it is refused, naming what is missing', () => {
    const body = `  ${SHAPED}
  sl-[p:People]-> {
    link feeds -[:channels]-> p
  }`;
    expect(codes(body)).toContain(C.NODE_LINK_SHAPE);
    expect(messages(body)).toMatch(/`Name`/);
  });

  it('a synthesised node is judged by the same structure, nested edges included', () => {
    const fits = `  ${SHAPED}
  made = node { Name: "general", Messages: node { Text: "hi" } }
  link feeds -[:channels]-> made`;
    expect(codes(fits)).toEqual([]);

    const missingField = `  ${SHAPED}
  bare = node { Text: "hi" }
  link feeds -[:channels]-> bare`;
    expect(codes(missingField)).toContain(C.NODE_LINK_SHAPE);

    const badLanding = `  ${SHAPED}
  wrong = node { Name: "general", Messages: node { Nope: "hi" } }
  link feeds -[:channels]-> wrong`;
    expect(codes(badLanding)).toContain(C.NODE_LINK_SHAPE);
  });

  it('an entry naming neither a declared node nor an address offers both spellings', () => {
    const body = '  bad = node { messages: <text> }';
    expect(codes(body)).toContain(C.NODE_ENTRY_TYPE);
    expect(messages(body)).toMatch(/node text \{ … \}/);
    expect(messages(body)).toMatch(/<text-\[:Edge\]->>/);
  });

  it('an instance is neither — it is a whole graph, not a structure', () => {
    expect(codes('  bad = node { messages: <sl> }')).toContain(C.NODE_ENTRY_TYPE);
  });
});
