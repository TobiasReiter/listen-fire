// Checker coverage for graph literal REFERENCES — TypeScript's object
// semantics. A bare walk (`files: m-[:Attachments]->`) or a record written as
// an entry's value (`owner: r`) holds the records themselves, as
// `{ items: obj }` holds `obj`: the edge is typed as the records it holds, a
// shape checks them structurally, and a write through one is checked as a
// write to that record. A walk with a field body and a record spread copy.
// Plan: plans/functional-extract-2026-10-02/1_design.md, "Rulings (Henry, 2026-10-05)".

import { parseProgram } from '../../parser/parse';
import type { NodeLiteral, Statement } from '../../parser/ast';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text', Body: 'text' },
      edges: { Attachments: { target: 'attachment', readable: true } },
    },
    attachment: { properties: { Name: 'text', Type: 'text', File: 'file' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

// A second, WRITABLE system, so a write through a reference has somewhere real
// to go — and a second shape, so nothing here passes by matching one adapter.
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
  },
  collections: { Channels: { target: 'Channel' } },
  supportsInPlaceUpdate: true,
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

const PRELUDE = `import { email, chat } from adapters
inbox = email()
sl = chat()

node Filed {
  subject: <text>
  node Attachments {
    Name: <text>
    File: <file>
  }
}

node Digest {
  title: <text>
  node posted {
    Text: <text>
  }
}

node Batch {
  node posted {
    Text: <text>
  }
}

node Thread {
  title: <text>
  node attachment {
    label: <text>
    node owner {
      Text: <text>
    }
    node source {
      Subject: <text>
    }
  }
}
`;

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement under_test(e: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter((d) => (d.severity ?? 'error') === 'error');
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

function entries(body: string): NodeLiteral['entries'] {
  const program = parseProgram(`${PRELUDE}\nmovement under_test(e: <inbox-[:message]->>) {\n${body}\n}`);
  expect(checkProgram(program, catalog).filter((d) => (d.severity ?? 'error') === 'error')).toEqual([]);
  const movement = program.statements.find(
    (s): s is Extract<Statement, { kind: 'movement' }> => s.kind === 'movement' && s.name === 'under_test',
  );
  const assign = movement?.body.find((s) => s.kind === 'assign' && s.name === 'g');
  if (assign?.kind !== 'assign' || assign.value.kind !== 'node') throw new Error('expected a literal bound to g');
  return assign.value.node.entries;
}

describe('a bare walk holds references', () => {
  it('fits the shape structurally, and records no copy plan', () => {
    const [, files] = entries('  g = graph<Filed> { subject: e.Subject, Attachments: e-[:Attachments]-> }');
    expect(files.kind).toBe('traversal');
    expect(Object.hasOwn(files, 'copy')).toBe(false);
  });

  it('is typed as the records it holds — a field the shape never named reads through it', () => {
    expect(
      codes('  g = graph<Filed> { subject: e.Subject, Attachments: e-[:Attachments]-> }\n  g-[a:Attachments]-> {\n    t = a.Type\n  }'),
    ).toEqual([]);
  });

  it('a field the records lack is still an unknown read', () => {
    expect(
      codes('  g = graph<Filed> { subject: e.Subject, Attachments: e-[:Attachments]-> }\n  g-[a:Attachments]-> {\n    t = a.Nope\n  }'),
    ).toContain(C.UNKNOWN_PROPERTY);
  });

  it('records that lack what the shape needs are refused, pointing at the copy body', () => {
    const body = '  g = graph<Digest> { title: e.Subject, posted: e-[:Attachments]-> }';
    expect(codes(body)).toEqual([C.GRAPH_REFERENCE_SHAPE]);
    expect(messages(body)).toMatch(/`Text`/);
    expect(messages(body)).toMatch(/with a body/);
  });

  it('without a shape, records nothing describes are an unknown edge, not an error', () => {
    expect(codes('  g = graph { files: e-[:Attachments]-> }\n  g-[f:files]-> {\n    n = f.Name\n  }')).toEqual([]);
  });

  it('WHERE and MAP over the reference edge read the real records', () => {
    expect(
      codes(
        [
          '  g = graph { files: e-[:Attachments]-> }',
          '  pdfs = g-[f:files WHERE f.Type = "application/pdf"]->.Name',
          '  names = MAP(g-[f:files]->, (f) => f.Name)',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('a record written as an entry value holds a reference', () => {
  it('a name bound to one record', () => {
    const [owner] = entries('  first = ONLY(e-[:Attachments]->)\n  g = graph { owner: first }');
    expect(owner.kind === 'value' && owner.reference).toBe(true);
    expect(codes('  first = ONLY(e-[:Attachments]->)\n  g = graph { owner: first }\n  g-[o:owner]-> {\n    t = o.Type\n  }')).toEqual([]);
  });

  it('ONLY/FIRST/LAST over a bare walk, written in place', () => {
    expect(codes('  g = graph { owner: ONLY(e-[:Attachments]->) }\n  g-[o:owner]-> {\n    t = o.Type\n  }')).toEqual([]);
  });

  it('the trigger record itself', () => {
    expect(codes('  g = graph { source: e }\n  g-[s:source]-> {\n    t = s.Subject\n  }')).toEqual([]);
  });

  it('is a child of the shape, checked structurally', () => {
    expect(codes('  ch = write sl-[:Channels]-> { Name: "general" }\n  m = write ch-[:Messages]-> { Text: "hi" }\n  g = graph<Digest> { title: e.Subject, posted: m }')).toEqual([]);
    expect(codes('  g = graph<Digest> { title: e.Subject, posted: e }')).toEqual([C.GRAPH_REFERENCE_SHAPE]);
  });

  it('a record where the shape has a field is still the entry-kind refusal', () => {
    expect(codes('  g = graph<Digest> { title: e, posted: [] }')).not.toEqual([]);
  });

  it('a scalar stays a field', () => {
    const [title] = entries('  g = graph { title: e.Subject }');
    expect(title.kind === 'value' && title.reference).toBeFalsy();
  });
});

describe('a reference nested inside a child body of a shaped graph', () => {
  const NESTED = [
    '  ch = write sl-[:Channels]-> { Name: "general" }',
    '  m = write ch-[:Messages]-> { Text: "hi" }',
    '  g = graph<Thread> { title: e.Subject, attachment: { label: "x", owner: m } }',
  ].join('\n');

  it('is typed as the records it holds, not as the shape\'s child', () => {
    // `Replies` is the chat message's own edge: the shape's `owner` never declares it.
    expect(
      codes(`${NESTED}\n  g-[a:attachment]-> {\n    a-[o:owner]-> {\n      write o-[:Replies]-> { Text: "re" }\n    }\n  }`),
    ).toEqual([]);
  });

  it('still fits the shape\'s child structurally, and the rest of the child keeps the shape', () => {
    expect(codes('  g = graph<Thread> { title: e.Subject, attachment: { label: "x", owner: e } }')).toEqual([
      C.GRAPH_REFERENCE_SHAPE,
    ]);
    expect(
      codes(`${NESTED}\n  g-[a:attachment]-> {\n    l = a.label\n    n = a.nope\n  }`),
    ).toEqual([C.UNKNOWN_PROPERTY]);
  });

  it('makes the graph unserialisable, as a top-level reference does', () => {
    const body = `  g = graph<Thread> { title: e.Subject, attachment: { label: "x", source: e } }\n  t = TEXT.SERIALISE(g, 'JSON')`;
    expect(codes(body)).toEqual([C.STDLIB_ARG_NOT_RECORD]);
    expect(messages(body)).toMatch(/'source'/);
  });
});

describe('writes through a reference are writes to the real record', () => {
  const CHANNELS = '  g = graph { channels: sl-[:Channels]-> }';

  it('a write to a referenced record is checked against that record', () => {
    expect(codes(`${CHANNELS}\n  g-[c:channels]-> {\n    write c { Name: "renamed" }\n  }`)).toEqual([]);
    expect(codes(`${CHANNELS}\n  g-[c:channels]-> {\n    write c { Nope: "x" }\n  }`)).not.toEqual([]);
  });

  it('a write along the referenced record\'s own edge reaches its system', () => {
    expect(codes(`${CHANNELS}\n  g-[c:channels]-> {\n    write c-[:Messages]-> { Text: "hello" }\n  }`)).toEqual([]);
  });
});

describe('the collector: records the run wrote, grouped under a local record', () => {
  it('a MAP of writes held under a named edge, walked, filtered and reported', () => {
    expect(
      codes(
        [
          '  ch = write sl-[:Channels]-> { Name: "general" }',
          '  posted = MAP(e-[a:Attachments]->, (a) => {',
          '    return write ch-[:Messages]-> { Text: a.Name }',
          '  })',
          '  batch = graph<Batch> { posted: posted }',
          '  texts = batch-[p:posted WHERE p.Text != ""]->.Text',
          '  batch-[p:posted]-> {',
          '    write p-[:Replies]-> { Text: "filed" }',
          '  }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('link appends a real record to an empty graph\'s child', () => {
    expect(
      codes(
        [
          '  batch = graph<Batch> {}',
          '  ch = write sl-[:Channels]-> { Name: "general" }',
          '  m = write ch-[:Messages]-> { Text: "hi" }',
          '  link batch -[:posted]-> m',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('TEXT.SERIALISE through a reference', () => {
  it('refuses a graph holding records read live from a system', () => {
    const body = "  g = graph { files: e-[:Attachments]-> }\n  t = TEXT.SERIALISE(g, 'JSON')";
    expect(codes(body)).toEqual([C.STDLIB_ARG_NOT_RECORD]);
    expect(messages(body)).toMatch(/'files'/);
    expect(codes("  g = graph { owner: e }\n  t = TEXT.SERIALISE(g, 'JSON')")).toEqual([C.STDLIB_ARG_NOT_RECORD]);
  });

  it('accepts the copy the body spells out', () => {
    expect(
      codes("  g = graph { files: e-[a:Attachments]-> { name: a.Name } }\n  t = TEXT.SERIALISE(g, 'JSON')"),
    ).toEqual([]);
  });
});
