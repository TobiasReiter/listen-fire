// A map field holding a LIST of records types as that list, whichever way the
// records were reached — an `extract(…)` answer, a walk read, a block's
// returned records — so the readers of a list (`MAP`, `COUNT`, a block head)
// accept it where it is read back out of the map, and the engine hands them
// exactly that list.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog, type FieldType } from '../catalog';

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text', Body: 'text' },
      edges: {},
    },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

const catalog = mockCatalog({ adapters: { email: { constructionArgs: [], schema: inboxSchema } } });

function source(body: string): string {
  return `import { email } from adapters
inbox = email()

node Company: "each company named in this message" {
  name: <text> "the company's name"
  node round: "each funding round it raised" {
    stage: <text> "the stage"
  }
}

movement under_test(e: <inbox-[:message]->>) {
${body}
}`;
}

function check(body: string): Diagnostic[] {
  return checkProgram(parseProgram(source(body)), catalog).filter((d) => (d.severity ?? 'error') === 'error');
}
const codes = (body: string): string[] => check(body).map((d) => d.code);

function bindingType(body: string, name: string): FieldType | undefined {
  const { recording } = checkProgramWithLink(parseProgram(source(body)), catalog, { recordAnalysis: true });
  const symbols = (recording?.frames ?? []).flatMap((f) => [...f.scope.symbols.values()]);
  return symbols.find((s) => s.name === name)?.fieldType;
}

/** The type a map's key holds, off a list of such maps. */
function keyOfListedMap(type: FieldType | undefined, key: string): FieldType | null | undefined {
  if (typeof type !== 'object' || type.kind !== 'list') return undefined;
  const map = type.of;
  if (typeof map !== 'object' || map.kind !== 'dict') return undefined;
  return map.shape?.[key];
}

function expectListOfRecords(type: FieldType | null | undefined): void {
  expect(type).toMatchObject({ kind: 'list', of: { kind: 'record' } });
}

describe('the production shape: each piece kept beside its extraction', () => {
  const PIECES = [
    '  pieces = [e.Subject, e.Body]',
    '  results = MAP(pieces, (p) => {',
    "    return { piece: p, entries: extract([p], Company, { tier: 'careful' }) }",
    '  })',
  ];

  it('validates, reading the field back with every reader of a list', () => {
    expect(
      codes(
        [
          ...PIECES,
          '  MAP(results, (x) => {',
          '    names = MAP(x.entries, (c) => c.name)',
          '    kept = FILTER(x.entries, (c) => c.name == "Acme")',
          '    n = COUNT(x.entries)',
          '    first = FIRST(x.entries)',
          '    x.entries-[r:round]-> {',
          '      return r.stage',
          '    }',
          '  })',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('the field types as a list of the record', () => {
    expectListOfRecords(keyOfListedMap(bindingType(PIECES.join('\n'), 'results'), 'entries'));
  });
});

describe('records reached another way, held in a map field', () => {
  const ROWS = (lines: string[]) => [
    "  companies = extract([e.Body], Company)",
    '  rows = MAP(companies, (c) => {',
    ...lines,
    '  })',
  ];
  const READ_BACK = ['  MAP(rows, (x) => {', '    stages = MAP(x.rounds, (r) => r.stage)', '  })'];

  it.each([
    ['a walk read written in the field', ['    return { name: c.name, rounds: c-[:round]-> }']],
    ['a name bound to a walk read', ['    walked = c-[:round]->', '    return { name: c.name, rounds: walked }']],
    [
      "a block's returned records",
      ['    kept = c-[r:round]-> {', '      return r', '    }', '    return { name: c.name, rounds: kept }'],
    ],
  ])('%s types as a list of the record and reads back as one', (_label, lines) => {
    expect(codes([...ROWS(lines), ...READ_BACK].join('\n'))).toEqual([]);
    expectListOfRecords(keyOfListedMap(bindingType(ROWS(lines).join('\n'), 'rows'), 'rounds'));
  });
});
