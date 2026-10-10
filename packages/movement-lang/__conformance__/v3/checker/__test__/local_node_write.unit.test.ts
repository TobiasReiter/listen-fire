// Checker coverage for a WRITE into a run-local node's edge — in-process
// deduplication, spelled in the write's own vocabulary.
//
// `write deduped-[:companies]-> { unique by (FUZZY `Name`), Name: … }` targets
// the run's OWN graph: the landing either joins an earlier one or becomes a new
// one. Nothing reaches a system, so the two facts worth pinning are that the
// EDGE's landing type is the whole of what the body may set — there is no
// adapter to ask — and that the run's own store resolves identity itself, which
// is why FUZZY needs no capability here.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, Diagnostic, DiagnosticCodes as C } from '../check';
import { effectRowOf, type EffectRow } from '../effects';
import { InstanceSchema, mockCatalog } from '../catalog';

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

// A target system, so a write into a node the run built can be compared with a
// write into a system — and so the address spelling of a declared edge has an
// address to name.
const chatSchema: InstanceSchema = {
  positions: {
    Channel: {
      properties: { Name: 'text' },
      edges: { Messages: { target: 'ChatMessage', readable: true, writable: true } },
    },
    ChatMessage: { properties: { Text: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'Channel' }, Messages: { target: 'ChatMessage' } },
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

// `Company` and `Person` carry fields and nothing else; `Feed` also carries an
// EDGE, which a landing the write minted carries too — empty, and appendable
// (`nested_declared_edge.unit.test.ts` is where that is pinned).
const PRELUDE = `import { email, chat } from adapters
inbox = email()
sl = chat()

node Company {
  Name: <text>
  Site: <text>
}

node Person {
  Email: <text>
}

node Feed {
  Name: <text>
  node Messages {
    Text: <text>
  }
}
`;

const SHAPED = 'deduped = node { companies: <Company> }';
const ADDRESSED = 'sent = node { messages: <sl-[:Channels]->-[:Messages]->> }';

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

describe('the edge’s landing type is the write shape', () => {
  it('a body setting exactly the declared fields is accepted', () => {
    expect(
      codes(`  ${SHAPED}\n  write deduped-[:companies]-> { Name: "Acme", Site: "acme.test" }`),
    ).toEqual([]);
  });

  it('a field the landing type never carries is refused, naming the ones it has', () => {
    const body = `  ${SHAPED}\n  write deduped-[:companies]-> { Nope: "x" }`;
    expect(codes(body)).toContain(C.WRITE_UNKNOWN_FIELD);
    expect(messages(body)).toMatch(/Name/);
  });

  it('an edge the literal never declared is refused, naming what it has', () => {
    const body = `  ${SHAPED}\n  write deduped-[:nope]-> { Name: "Acme" }`;
    expect(codes(body)).toContain(C.NODE_EDGE_UNDECLARED);
    expect(messages(body)).toMatch(/companies/);
  });

  it('a lazy entry is refused — its landings are recomputed at every read', () => {
    const body = `  sent = node { files: lazy e-[a:Attachments]-> }
  write sent-[:files]-> { Name: "x" }`;
    expect(codes(body)).toContain(C.NODE_EDGE_DEFERRED);
  });

  it('the ADDRESS spelling types the write the same way', () => {
    expect(codes(`  ${ADDRESSED}\n  write sent-[:messages]-> { Text: "hi" }`)).toEqual([]);
    expect(codes(`  ${ADDRESSED}\n  write sent-[:messages]-> { Nope: "hi" }`)).toContain(
      C.WRITE_UNKNOWN_FIELD,
    );
  });
});

describe('identity on the run’s own store', () => {
  it('FUZZY needs no capability — the engine matches the landings itself', () => {
    expect(
      codes(
        `  ${SHAPED}\n  write deduped-[:companies]-> { unique by (FUZZY \`Name\`, \`Site\`)\n    Name: "Acme"\n    Site: "acme.test"\n  }`,
      ),
    ).toEqual([]);
  });

  it('a component naming no field of the landing is refused', () => {
    const body = `  ${SHAPED}\n  write deduped-[:companies]-> { unique by (\`Nope\`)\n    Name: "Acme"\n  }`;
    expect(codes(body)).toContain(C.UNIQUE_UNKNOWN_FIELD);
  });

  it('a bound handle is not an identity here — nothing parents a local landing', () => {
    const body = `  ${SHAPED}
  ch = write sl-[:Channels]-> { Name: "general" }
  write deduped-[:companies]-> { unique by (ch)
    Name: "Acme"
  }`;
    expect(codes(body)).toContain(C.UNIQUE_UNKNOWN_FIELD);
  });
});

describe('what the write hands back', () => {
  it('reads its fields by dot', () => {
    expect(
      codes(`  ${SHAPED}\n  c = write deduped-[:companies]-> { Name: "Acme" }\n  n = c.\`Name\``),
    ).toEqual([]);
  });

  it('a field the landing type never carries is refused off it', () => {
    expect(
      codes(`  ${SHAPED}\n  c = write deduped-[:companies]-> { Name: "Acme" }\n  n = c.\`Nope\``),
    ).toContain(C.UNKNOWN_PROPERTY);
  });

  it('links onto another edge of the same structure', () => {
    const body = `  ${SHAPED}
  also = node { companies: <Company> }
  c = write deduped-[:companies]-> { Name: "Acme", Site: "acme.test" }
  link also -[:companies]-> c`;
    expect(codes(body)).toEqual([]);
  });

  it('is refused where the other structure needs something the landing never carried', () => {
    const body = `  people = node { people: <Person> }
  feeds = node { channels: <Feed> }
  p = write people-[:people]-> { Email: "jane@acme.test" }
  link feeds -[:channels]-> p`;
    expect(codes(body)).toContain(C.NODE_LINK_SHAPE);
    expect(messages(body)).toMatch(/`Name`/);
  });
});

describe('what the write does NOT do', () => {
  it('adds nothing to the effect row — the run’s own graph is not the world', () => {
    const row = rowOf(`  ${SHAPED}\n  write deduped-[:companies]-> { Name: "Acme" }`);
    expect(row.write).toEqual([]);
    expect(row.partial).toBe(false);
  });
});
