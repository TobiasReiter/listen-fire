// Language version 5 ("Dancing Wren"): `-[f:_resources]->` is read only off an
// extraction's result — the source content the extraction read. Off any other
// record it is MOV_RESOURCES_NOT_EXTRACTED, and the message names the edge the
// record's system declares to its files, DERIVED from the schema:
//   - the edge the system declares as its resources (`resources: true` — the
//     knowledge graph's `Resources`), else
//   - every edge whose landing has a file-typed field (email's `Attachments`,
//     Slack's `Files`), else
//   - it says the system exposes no files.
// Under version 4 every one of these is accepted, as it always was.

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import type { LanguageVersion } from '../../language_version';
import { spelledFor } from './surface_spelling';

const mailSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text' },
      edges: { Attachments: { target: 'attachment' }, From: { target: 'sender' } },
    },
    attachment: { properties: { Name: 'text', File: 'file' }, edges: {} },
    sender: { properties: { Email: 'text' }, edges: {} },
  },
  collections: { message: { target: 'message' } },
  writableRoots: { message: { fields: { Subject: 'text' }, resultShape: { externalId: 'text', Subject: 'text' } } },
};

// A second shape, so a name the diagnostic hardcoded could not pass: the file
// rides a list, on an edge with another name.
const chatSchema: InstanceSchema = {
  positions: {
    post: { properties: { Text: 'text' }, edges: { Files: { target: 'upload' }, Thread: { target: 'post' } } },
    upload: { properties: { Title: 'text', Data: { kind: 'list', of: 'file' } }, edges: {} },
  },
  collections: { post: { target: 'post' } },
  writableRoots: {},
};

const graphSchema: InstanceSchema = {
  positions: {
    Company: {
      properties: { Name: 'text' },
      edges: { Resources: { target: 'Attached Resource', resources: true }, Founders: { target: 'Person' } },
    },
    Person: { properties: { Name: 'text' }, edges: {} },
    'Attached Resource': { properties: { Name: 'text', URL: 'text', Type: 'text' }, edges: {} },
  },
  collections: { Company: { target: 'Company' } },
  writableRoots: {},
};

const crmSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text' }, edges: { people: { target: 'person' } } }, person: { properties: { name: 'text' }, edges: {} } },
  collections: { company: { target: 'company' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: {
    mail: { constructionArgs: [], schema: mailSchema },
    chat: { constructionArgs: [], schema: chatSchema },
    graph: { constructionArgs: [], schema: graphSchema },
    crm: { constructionArgs: [], schema: crmSchema },
    loose: { constructionArgs: [] },
  },
});

// Written in the spelling versions 1–4 read; the version 5 run reads what the
// upgrade tool makes of it.
const source = (param: string, body: string, languageVersion: LanguageVersion) =>
  spelledFor(
    languageVersion,
    `import { mail, chat, graph, crm, loose } from adapters
inbox = mail()
slack = chat()
kg = graph()
db = crm()
free = loose()

movement scan(x: ${param}) {
${body}
}`,
  );

function check(param: string, body: string, languageVersion: LanguageVersion) {
  return checkProgram(parseProgram(source(param, body, languageVersion), { languageVersion }), catalog, { languageVersion }).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (param: string, body: string, v: LanguageVersion) => check(param, body, v).map((d) => d.code);
const said = (param: string, body: string, v: LanguageVersion) => check(param, body, v).map((d) => d.message).join('\n');

const walk = (root: string, edge = '_resources') => `  ${root}-[f:${edge}]-> {\n    y = f.url\n  }`;

describe('`_resources` under Dancing Wren (5)', () => {
  it("off an extraction's result (its root or an extracted node): clean", () => {
    const extraction = [
      '  d = extract from [x.Subject] {',
      '    node co: "a company" {',
      '      nm: <text> "the name"',
      '    }',
      '  }',
    ].join('\n');
    expect(codes('<inbox-[:message]->>', `${extraction}\n${walk('d')}`, 5)).toEqual([]);
    expect(codes('<inbox-[:message]->>', `${extraction}\n  d-[k:co]-> {\n  ${walk('k')}\n  }`, 5)).toEqual([]);
  });

  it("off an email: refused, naming its 'Attachments' edge", () => {
    expect(codes('<inbox-[:message]->>', walk('x'), 5)).toEqual([C.RESOURCES_NOT_EXTRACTED]);
    const message = said('<inbox-[:message]->>', walk('x'), 5);
    expect(message).toContain("'Attachments'");
    expect(message).not.toContain("'From'");
    expect(message).toContain("x-[f:Attachments]->");
  });

  it("off a second shape (a list of files, another name): refused, naming its 'Files' edge", () => {
    const message = said('<slack-[:post]->>', walk('x'), 5);
    expect(message).toContain("'Files'");
    expect(message).not.toContain("'Thread'");
  });

  it("off a knowledge-graph node: refused, naming the declared resources edge 'Resources'", () => {
    expect(codes('<kg-[:Company]->>', walk('x'), 5)).toEqual([C.RESOURCES_NOT_EXTRACTED]);
    expect(said('<kg-[:Company]->>', walk('x'), 5)).toContain("x-[f:Resources]->");
  });

  it('the declared edge is an ordinary edge: walking it by its name is clean', () => {
    expect(codes('<kg-[:Company]->>', '  x-[f:Resources]-> {\n    y = f.URL\n  }', 5)).toEqual([]);
  });

  it('a system with no edge to a file: says it exposes no files', () => {
    expect(codes('<db-[:company]->>', walk('x'), 5)).toEqual([C.RESOURCES_NOT_EXTRACTED]);
    expect(said('<db-[:company]->>', walk('x'), 5)).toContain('exposes no files');
  });

  it('a walked-to record and a write handle are records too', () => {
    expect(codes('<db-[:company]->>', `  x-[p:people]-> {\n  ${walk('p')}\n  }`, 5)).toEqual([C.RESOURCES_NOT_EXTRACTED]);
    expect(codes('<db-[:company]->>', `  m = write inbox-[:message]-> { Subject: "hi" }\n${walk('m')}`, 5))
      .toContain(C.RESOURCES_NOT_EXTRACTED);
  });

  it('a record that holds its file itself: pointed at its own file field, not told there are none', () => {
    const body = `  x-[a:Attachments]-> {\n  ${walk('a')}\n  }`;
    expect(codes('<inbox-[:message]->>', body, 5)).toEqual([C.RESOURCES_NOT_EXTRACTED]);
    const message = said('<inbox-[:message]->>', body, 5);
    expect(message).toContain("'File'");
    expect(message).toContain('a.File');
    expect(message).not.toContain('exposes no files');
  });

  it('a root not provably an extraction\'s result is refused without a schema', () => {
    // A record of a system that describes nothing.
    expect(codes('<free-[:things]->>', walk('x'), 5)).toEqual([C.RESOURCES_NOT_EXTRACTED]);
    // A name bound to an IF of two records.
    const either = '  w = ONLY(inbox-[:message]->)\n  v = IF x.Subject == "a" THEN x ELSE w END\n';
    expect(codes('<inbox-[:message]->>', `${either}${walk('v')}`, 5)).toEqual([C.RESOURCES_NOT_EXTRACTED]);
    expect(codes('<free-[:things]->>', walk('x'), 4)).toEqual([]);
    expect(codes('<inbox-[:message]->>', `${either}${walk('v')}`, 4)).toEqual([]);
  });

  it("an IF whose every arm is an extraction's result is one: clean", () => {
    const extraction = (name: string) => [
      `  ${name} = extract from [x.Subject] {`,
      '    node co: "a company" {',
      '      nm: <text> "the name"',
      '    }',
      '  }',
    ].join('\n');
    const body = `${extraction('d')}\n${extraction('e')}\n  v = x.Subject == "a" ? d : e\n${walk('v')}`;
    expect(codes('<inbox-[:message]->>', body, 5)).toEqual([]);
  });

  it("a write-only edge is never suggested", () => {
    const writeOnly: InstanceSchema = {
      positions: {
        post: { properties: { Text: 'text' }, edges: { Uploads: { target: 'upload', readable: false } } },
        upload: { properties: { Data: 'file' }, edges: {} },
      },
      collections: { post: { target: 'post' } },
      writableRoots: {},
    };
    const only = mockCatalog({ adapters: { send: { constructionArgs: [], schema: writeOnly } } });
    const src = `import { send } from adapters\nout = connect send\n\nfunction scan(x: <out-[:post]->>) {\n${walk('x')}\n}`;
    const found = checkProgram(parseProgram(src, { languageVersion: 5 }), only, { languageVersion: 5 })
      .filter((d) => (d.severity ?? 'error') === 'error');
    expect(found.map((d) => d.code)).toEqual([C.RESOURCES_NOT_EXTRACTED]);
    expect(found[0].message).not.toContain('Uploads');
    expect(found[0].message).toContain('exposes no files');
  });

  it("a rootless value walk reads the event's record: refused", () => {
    expect(codes('<inbox-[:message]->>', '  y = -[:_resources]->.url', 5)).toContain(C.RESOURCES_NOT_EXTRACTED);
  });

  it('under Luminous Owl (4) every one is accepted, as before', () => {
    for (const param of ['<inbox-[:message]->>', '<slack-[:post]->>', '<kg-[:Company]->>', '<db-[:company]->>']) {
      expect(codes(param, walk('x'), 4)).not.toContain(C.RESOURCES_NOT_EXTRACTED);
      expect(codes(param, walk('x'), 4)).toEqual([]);
    }
    expect(codes('<inbox-[:message]->>', '  y = -[:_resources]->.url', 4)).toEqual([]);
  });
});
