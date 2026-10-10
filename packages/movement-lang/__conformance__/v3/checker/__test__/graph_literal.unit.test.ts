// Checker coverage for graph literals — `graph<Shape> { … }` / `graph { … }`.
//
// With a shape the literal is checked the way TypeScript's `satisfies` checks
// an object literal: a misspelt or mistyped entry is refused, a required field
// may not be missing, and only a `<T | null>` field may be left out. The value
// is then OF the shape. Without a shape its own structure is its type.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text', Body: 'text', Count: 'number', Payload: 'json' },
      edges: { Attachments: { target: 'attachment', readable: true } },
    },
    attachment: {
      properties: {
        Name: { kind: 'maybeAbsent', of: 'text' },
        Type: 'text',
        File: 'file',
        Pages: 'number',
      },
      edges: { Versions: { target: 'version', readable: true } },
    },
    version: { properties: { Label: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: { email: { constructionArgs: [], schema: inboxSchema } },
});

const PRELUDE = `import { email } from adapters
inbox = email()

node Message: "a message in a common format" {
  text: <text>
  node attachment: "each file attached" {
    name: <text | null>
    type: <text>
    file: <file>
  }
}

node Archived {
  subject: <text>
  node Attachments {
    Name: <text | null>
    File: <file>
    node Versions {
      Label: <text>
    }
  }
}

node Detailed {
  note: <text | null>
  node part {
    label: <text>
  }
}

node Note {
  text: <text>
  node tag {
    label: <text>
  }
}

movement takes_message(msg: <Message>) {
}

movement from_email(m: <inbox-[:message]->>) {
  return graph<Message> {
    text: m.Body,
    attachment: m-[a:Attachments]-> { name: a.Name, type: a.Type, file: a.\`File\` },
  }
}
`;

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement under_test(e: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

describe('graph<Shape> — the worked example', () => {
  it('builds a Message from an email, and the result reads by path, WHERE and dot', () => {
    expect(
      codes(
        [
          '  msg = from_email(m: e)',
          '  text = msg.text',
          '  pdfs = msg-[a:attachment WHERE a.type = "application/pdf"]->.file',
          '  msg-[a:attachment WHERE a.type = "application/pdf"]-> {',
          '    f = a.file',
          '  }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('an omitted nullable field reads as maybe-absent, not as an unknown name', () => {
    expect(
      codes(
        [
          '  g = graph<Message> { text: e.Body }',
          '  g-[a:attachment]-> {',
          '    n = a.name',
          '  }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('the value fits a parameter of the shape', () => {
    expect(codes('  takes_message(msg: graph<Message> { text: e.Body })')).toEqual([]);
  });

  it('the value is of the shape, so a name the shape lacks is an unknown read', () => {
    expect(codes('  g = graph<Message> { text: e.Body }\n  x = g.subject')).not.toEqual([]);
  });
});

describe('graph<Shape> — refusals', () => {
  it('refuses a misspelt field, with a did-you-mean', () => {
    expect(codes('  g = graph<Message> { txet: e.Body, text: e.Body }')).toEqual([
      C.GRAPH_FIELD_UNKNOWN,
    ]);
    expect(messages('  g = graph<Message> { txet: e.Body, text: e.Body }')).toMatch(/text/);
  });

  it('refuses a mistyped field', () => {
    expect(codes('  g = graph<Message> { text: e.Count }')).toEqual([C.GRAPH_FIELD_TYPE]);
  });

  it('refuses a missing required field', () => {
    expect(codes('  g = graph<Message> { attachment: { type: "a", file: e.Body } }')).toEqual(
      expect.arrayContaining([C.GRAPH_FIELD_MISSING]),
    );
    expect(messages('  g = graph<Message> {}')).toMatch(/`text`/);
  });

  it('refuses a value where the shape has a child node, and a body where it has a field', () => {
    expect(codes('  g = graph<Message> { text: e.Body, attachment: e.Body }')).toEqual([
      C.GRAPH_ENTRY_KIND,
    ]);
    expect(codes('  g = graph<Message> { text: { a: e.Body } }')).toEqual(
      expect.arrayContaining([C.GRAPH_ENTRY_KIND]),
    );
  });

  it('checks a walk with a field body against the child node, field by field', () => {
    const walk = (fields: string) =>
      codes(`  g = graph<Message> { text: e.Body, attachment: e-[a:Attachments]-> { ${fields} } }`);
    expect(walk('name: a.Name, type: a.Type, file: a.`File`')).toEqual([]);
    expect(walk('name: a.Name, type: a.Pages, file: a.`File`')).toEqual([C.GRAPH_FIELD_TYPE]);
    expect(walk('nmae: a.Name, type: a.Type, file: a.`File`')).toEqual([C.GRAPH_FIELD_UNKNOWN]);
    expect(walk('type: a.Type')).toEqual([C.GRAPH_FIELD_MISSING]);
  });

  it('the field body is the landing scope: the alias is in scope inside it, and only there', () => {
    expect(
      codes('  g = graph<Message> { text: a.Type, attachment: e-[a:Attachments]-> { type: a.Type, file: a.`File` } }'),
    ).toEqual(expect.arrayContaining([C.NAME_UNRESOLVED]));
  });

  it('refuses a shape that is not a node declaration', () => {
    expect(codes('  g = graph<inbox> { text: e.Body }')).toEqual([C.GRAPH_SHAPE]);
    expect(codes('  g = graph<Nope> { text: e.Body }')).toEqual([C.NAME_UNRESOLVED]);
  });
});

describe('graph<Shape> {} — the typed empty graph', () => {
  it('is valid when every field may be absent: child nodes start empty', () => {
    expect(codes('  g = graph<Detailed> {}\n  g-[p:part]-> {\n    l = p.label\n  }')).toEqual([]);
  });

  it('is refused when the shape requires a field', () => {
    expect(codes('  g = graph<Note> {}')).toEqual([C.GRAPH_FIELD_MISSING]);
  });
});

// A bare walk holds REFERENCES (graph_literal_references.unit.test.ts covers
// them in full); these pin how it sits beside the shape and the field body.
describe('a bare walk holds references', () => {
  it('with a shape, the records fit the child node structurally', () => {
    expect(codes('  g = graph<Archived> { subject: e.Subject, Attachments: e-[:Attachments]-> }')).toEqual([]);
  });

  it('without a shape, the edge reads by the source\'s names', () => {
    expect(codes('  g = graph { files: e-[:Attachments]-> }\n  g-[f:files]-> {\n    n = f.Type\n  }')).toEqual([]);
  });

  it('refuses a reference whose records lack a field the shape requires', () => {
    expect(codes('  g = graph<Message> { text: e.Body, attachment: e-[:Attachments]-> }')).toEqual([
      C.GRAPH_REFERENCE_SHAPE,
    ]);
  });
});

describe('graph { … } — the shape is inferred', () => {
  it('types its fields and children from the literal', () => {
    expect(
      codes(
        [
          '  g = graph { title: e.Subject, parts: [{ label: "a" }, { label: "b" }] }',
          '  t = g.title',
          '  g-[p:parts]-> {',
          '    l = p.label',
          '  }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a name it never wrote is an unknown read', () => {
    expect(codes('  g = graph { title: e.Subject }\n  x = g.nope')).not.toEqual([]);
  });
});

describe('...spread converts a computed map', () => {
  it('a map literal fits the shape: a nested list of maps becomes the child node', () => {
    expect(
      codes('  v = { text: "hello", tag: [{ label: "a" }] }\n  g = graph<Note> { ...v }\n  g-[t:tag]-> {\n    l = t.label\n  }'),
    ).toEqual([]);
  });

  it('checks the map\'s keys against the shape', () => {
    expect(codes('  v = { text: 3 }\n  g = graph<Note> { ...v }')).toEqual([C.GRAPH_FIELD_TYPE]);
    expect(codes('  v = { other: "x" }\n  g = graph<Note> { ...v }')).toEqual([C.GRAPH_FIELD_MISSING]);
    expect(codes('  v = { text: "x", tag: [{ lable: "a" }] }\n  g = graph<Note> { ...v }')).toEqual([
      C.GRAPH_FIELD_MISSING,
    ]);
  });

  it('a written entry supplies what the spread doesn\'t', () => {
    expect(codes('  v = { tag: [{ label: "a" }] }\n  g = graph<Note> { ...v, text: e.Body }')).toEqual([]);
  });

  it('an untyped map is checked when the graph is built, so the shape is required', () => {
    expect(codes('  v = e.Payload\n  g = graph<Note> { ...v }')).toEqual([]);
    expect(codes('  v = e.Payload\n  g = graph { ...v }')).toEqual([C.GRAPH_SPREAD_UNTYPED]);
  });

  it('without a shape, a known map\'s nested maps are children', () => {
    expect(
      codes('  v = { title: "x", tag: { label: "a" } }\n  g = graph { ...v }\n  g-[t:tag]-> {\n    l = t.label\n  }'),
    ).toEqual([]);
  });

  it('refuses a spread of something that is not a map', () => {
    expect(codes('  v = e.Body\n  g = graph<Note> { ...v, text: "x" }')).toEqual([C.GRAPH_SPREAD_NOT_MAP]);
  });
});
