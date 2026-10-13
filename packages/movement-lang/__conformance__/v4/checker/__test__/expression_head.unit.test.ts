// A block head that starts at an EXPRESSION, typed.
//
// A record IS a value type, so one rule decides both roots: the head starts at
// whatever record the root holds, whether a name holds it or an expression
// does. `AT(rows, 0)-[f:Founders]-> { … }` types exactly as binding the call to
// a name and hopping off the name types, because that is the same fact read the
// same way.
//
// The refusals come with it. An expression whose value type is text has no
// position to hop from, and says so where it is WRITTEN. And `await` parks on
// the record it waits at, which a parked run has to find again by name — so the
// one head position that needs a name asks for one.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import { storyOf } from '../../story/story';

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { Name: 'text' },
      edges: { Founders: { target: 'person', readable: true } },
    },
    person: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { Companies: { target: 'company' } },
  writableRoots: {},
};

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text' },
      edges: { Response: { target: 'message', readable: true, awaitable: true } },
    },
  },
  collections: { Messages: { target: 'message' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: {
    attio: { constructionArgs: [], schema: crmSchema },
    email: { constructionArgs: [], schema: inboxSchema },
  },
});

const PRELUDE = `import { attio, email } from adapters
crm = attio()
inbox = email()
`;

function source(body: string): string {
  return `${PRELUDE}
movement m(msg: <inbox-[:message]->>) {
${body}
}`;
}

function check(body: string): Diagnostic[] {
  return checkProgram(parseProgram(source(body)), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

/** `rows` is a list literal of records — ordered, so `AT` can index it. */
const ROWS =
  '  rows = [ONLY(crm-[c:Companies WHERE c.`Name` == "Acme"]->)]\n';

describe('an expression head types as the record it holds', () => {
  it('a call picking one record out of a list', () => {
    expect(codes(`${ROWS}  AT(rows, 0)-[f:Founders]-> {\n    x = f.\`Name\`\n  }`)).toEqual([]);
  });

  it('exactly as binding it first does — the two forms are one walk', () => {
    const bound = codes(`${ROWS}  first = AT(rows, 0)\n  first-[f:Founders]-> {\n    x = f.\`Name\`\n  }`);
    const inline = codes(`${ROWS}  AT(rows, 0)-[f:Founders]-> {\n    x = f.\`Name\`\n  }`);
    expect(inline).toEqual(bound);
    expect(inline).toEqual([]);
  });

  it('a singleton fold over a narrowed walk', () => {
    expect(
      codes(
        '  ONLY(crm-[c:Companies WHERE c.`Name` == "Acme"]->)-[f:Founders]-> {\n    x = f.`Name`\n  }',
      ),
    ).toEqual([]);
  });

  it('a record held in a map, read by its key', () => {
    expect(
      codes(`${ROWS}  held = { a: AT(rows, 0) }\n  AT(held, "a")-[f:Founders]-> {\n    x = f.\`Name\`\n  }`),
    ).toEqual([]);
  });

  it('the hop is typed off the expression, so an edge the record has not got is named', () => {
    expect(codes(`${ROWS}  AT(rows, 0)-[f:Investors]-> {\n    x = f.\`Name\`\n  }`)).toEqual([
      'MOV_TRAVERSE_UNKNOWN_EDGE',
    ]);
  });

  it('the landing is typed, so a property the landing has not got is named', () => {
    expect(codes(`${ROWS}  AT(rows, 0)-[f:Founders]-> {\n    x = f.\`Nope\`\n  }`)).toEqual([
      'MOV_UNKNOWN_PROPERTY',
    ]);
  });

  it('a name inside the expression is resolved — an unknown one is reported', () => {
    expect(codes('  AT(nope, 0)-[f:Founders]-> {\n    x = f.`Name`\n  }')).toContain(
      'MOV_NAME_UNRESOLVED',
    );
  });
});

describe('an expression that is not a record', () => {
  it('is refused at the head, naming the expression and what it is', () => {
    const body = '  AT(["a", "b"], 0)-[f:Founders]-> {\n    x = f.`Name`\n  }';
    expect(codes(body)).toContain('MOV_HEAD_NOT_A_POSITION');
    expect(messages(body)).toMatch(
      // A literal index into a literal reads a slot that is always there.
      /'AT\(\["a", "b"\], 0\)' is text, and a hop walks from a POSITION/,
    );
  });

  it('a name bound to the same value is refused identically', () => {
    const inline = messages('  AT(["a", "b"], 0)-[f:Founders]-> {\n    x = f.`Name`\n  }');
    const bound = messages('  s = AT(["a", "b"], 0)\n  s-[f:Founders]-> {\n    x = f.`Name`\n  }');
    expect(inline.replace(/'AT\(\["a", "b"\], 0\)'/, "'s'")).toBe(bound);
  });
});

describe("await parks on a record it can name again", () => {
  it('refuses an expression root, with the binding to make', () => {
    const body = `${ROWS}  answer = await FIRST(AT(rows, 0)-[r:Founders]->)`;
    expect(codes(body)).toContain('MOV_HEAD_NEEDS_A_NAME');
    expect(messages(body)).toMatch(
      /'await' parks on the record it waits at, and a parked run finds that record again by NAME — so this one is bound first: 'waiting = AT\(rows, 0\)', then 'await FIRST\(waiting-\[r:Founders\]->\)'/,
    );
  });

  it('a named root is untouched', () => {
    expect(codes('  answer = await FIRST(msg-[r:Response]->)')).not.toContain(
      'MOV_HEAD_NEEDS_A_NAME',
    );
  });
});

describe('the story shows the expression the author wrote', () => {
  it('carries the head as source, and the root as its own chip', () => {
    const result = storyOf({
      source: source(`${ROWS}  AT(rows, 0)-[f:Founders]-> {\n    x = f.\`Name\`\n  }`),
      catalog,
    });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const json = JSON.stringify(result.story);
    expect(json).toContain('AT(rows, 0)-[f:Founders]->');
    expect(json).toContain('"rootExpression"');
  });
});
