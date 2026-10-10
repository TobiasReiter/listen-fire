// The `json` SchemaFieldType — the DATA top type (TypeScript's `unknown` for the
// data plane), and the type an object literal has.
//
// Two rules, in both directions:
//   - everything DATA-shaped is assignable TO json (text, number, boolean,
//     date/datetime, a list of data, an object literal, json itself); a `file`
//     is not, being a handle rather than data;
//   - json is assignable to json ONLY, and operating on one — comparing,
//     arithmetic, folding into text, aggregating — is a LOUD error
//     (MOV_JSON_OPAQUE) that names the pass-it-through remedy.
//
// Two adapter shapes throughout (a structured payload and a properties bag),
// per the fixture rule: one adapter's shape cannot tell derived from hardcoded.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import {
  SchemaFieldType,
  InstanceSchema,
  describeFieldType,
  mockCatalog,
  parseFieldTypeName,
} from '../catalog';
import { fieldAssignable, fieldTypeCompatible, maybeAbsent } from '../typing';

const jsonList: SchemaFieldType = { kind: 'list', of: 'json' };
const textList: SchemaFieldType = { kind: 'list', of: 'text' };
const fileList: SchemaFieldType = { kind: 'list', of: 'file' };
const stageEnum: SchemaFieldType = { kind: 'enum', options: ['Seed', 'Series A'] };

// ── The vocabulary ──

describe('json in the SchemaFieldType vocabulary', () => {
  it('is a surface type name (shape declarations, extract annotations)', () => {
    expect(parseFieldTypeName('json')).toBe('json');
  });

  it('describes as its own surface spelling, so a suggestion pastes back', () => {
    expect(describeFieldType('json')).toBe('json');
    expect(describeFieldType(jsonList)).toBe('list of json');
  });
});

// ── Assignability, as pure functions ──

describe('everything data-shaped is assignable TO json', () => {
  const dataShapes: Array<[string, SchemaFieldType]> = [
    ['text', 'text'],
    ['number', 'number'],
    ['boolean', 'boolean'],
    ['date', 'date'],
    ['datetime', 'datetime'],
    ['an enum', stageEnum],
    ['a list of text', textList],
    ['json itself', 'json'],
  ];

  it.each(dataShapes)('%s writes into a json field', (_label, source) => {
    expect(fieldTypeCompatible(source, 'json')).toBe(true);
  });

  it.each(dataShapes)('%s reads where json is expected', (_label, source) => {
    expect(fieldAssignable(source, 'json')).toBe(true);
  });

  it('a file is NOT — a handle is not data', () => {
    expect(fieldTypeCompatible('file', 'json')).toBe(false);
    expect(fieldAssignable('file', 'json')).toBe(false);
    expect(fieldTypeCompatible(fileList, 'json')).toBe(false);
  });

  it('absence is transparent to the shape rule (the write site polices it)', () => {
    expect(fieldTypeCompatible(maybeAbsent('text')!, 'json')).toBe(true);
    expect(fieldTypeCompatible(maybeAbsent('json')!, 'json')).toBe(true);
  });

  it('a json list target takes json elements', () => {
    expect(fieldTypeCompatible(jsonList, jsonList)).toBe(true);
    expect(fieldTypeCompatible('json', jsonList)).toBe(true);
    expect(fieldAssignable(jsonList, jsonList)).toBe(true);
  });
});

describe('json is assignable to json only', () => {
  const others: Array<[string, SchemaFieldType]> = [
    ['text', 'text'],
    ['number', 'number'],
    ['boolean', 'boolean'],
    ['date', 'date'],
    ['datetime', 'datetime'],
    ['file', 'file'],
    ['an enum', stageEnum],
    ['a list of text', textList],
  ];

  it.each(others)('does not write into a %s field', (_label, target) => {
    expect(fieldTypeCompatible('json', target)).toBe(false);
  });

  it.each(others)('does not read where %s is expected', (_label, target) => {
    expect(fieldAssignable('json', target)).toBe(false);
  });

  it('the text catch-all does not rescue it — that conflation is the point', () => {
    // Everything else renders into text; json deliberately does not, because
    // `String({…})` is `[object Object]`.
    expect(fieldTypeCompatible('number', 'text')).toBe(true);
    expect(fieldTypeCompatible('json', 'text')).toBe(false);
    expect(fieldTypeCompatible(jsonList, 'text')).toBe(false);
  });

  it('json to json passes', () => {
    expect(fieldTypeCompatible('json', 'json')).toBe(true);
    expect(fieldAssignable('json', 'json')).toBe(true);
  });
});

// ── Two adapter shapes ──

/** Shape 1: a post whose write surface mirrors a target API verbatim — a
 *  scalar json body, a LIST of json (the Block Kit case), and a file. */
const docsSchema: InstanceSchema = {
  positions: {
    post: {
      properties: { Title: 'text', Payload: 'json', Views: 'number' },
      edges: {},
    },
  },
  collections: { posts: { target: 'post' } },
  writableRoots: {
    post: {
      fields: { Title: 'text', Body: 'json', Blocks: jsonList, Upload: 'file' },
      resultShape: { externalId: 'text', Title: 'text' },
    },
  },
};

/** Shape 2: a ledger entry with a free-form properties bag beside real
 *  numbers — a different adapter's reason for holding a structured value. */
const ledgerSchema: InstanceSchema = {
  positions: {
    entry: { properties: { Amount: 'number', Meta: 'json' }, edges: {} },
  },
  collections: { entries: { target: 'entry' } },
  writableRoots: {
    entry: {
      fields: { Amount: 'number', Meta: 'json', Label: 'text' },
      resultShape: { externalId: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    docs: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: docsSchema,
    },
    ledger: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: ledgerSchema,
    },
  },
  credentials: { docs_cred: { adapter: 'docs' }, ledger_cred: { adapter: 'ledger' } },
});

const PRELUDE = [
  'import { docs, ledger } from adapters',
  'import { docs_cred, ledger_cred } from credentials',
  '',
  'd = docs(credentials: docs_cred)',
  'l = ledger(credentials: ledger_cred)',
].join('\n');

/** A movement whose parameter is a post, so `p.\`Payload\`` is a json read. */
const inMovement = (body: string): string =>
  `${PRELUDE}\nmovement m(p: <d-[:post]->>) {\n${body}\n}`;

const errors = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter(d => (d.severity ?? 'error') === 'error');
const codes = (source: string): string[] => errors(source).map(d => d.code);
const messages = (source: string): string[] => errors(source).map(d => d.message);

function expectClean(source: string): void {
  expect(errors(source).map(d => `${d.code}: ${d.message}`)).toEqual([]);
}

// ── An object literal's type IS json ──

describe('an object literal types as json', () => {
  it('writes into a json field', () => {
    expectClean(inMovement('  write d-[:posts]-> { Body: { text: "hello", emoji: true } }'));
  });

  it('nests lists and objects to any JSON shape', () => {
    expectClean(
      inMovement(
        '  write d-[:posts]-> { Blocks: [\n' +
          '    { type: "section", text: { type: "mrkdwn", text: "${p.`Title`}" } },\n' +
          '    { type: "divider" },\n' +
          '  ] }',
      ),
    );
  });

  it('reaches a json field of the SECOND shape the same way', () => {
    expectClean(inMovement('  write l-[:entries]-> { Meta: { tranche: 2 } }'));
  });

  it('is NOT a text value — the old projection accepted this silently', () => {
    expect(codes(inMovement('  write d-[:posts]-> { Title: { text: "hello" } }'))).toContain(
      'MOV_WRITE_FIELD_TYPE',
    );
  });

  it('is not a file either — a handle is not data', () => {
    expect(codes(inMovement('  write d-[:posts]-> { Upload: { url: "x" } }'))).toContain(
      'MOV_WRITE_FIELD_TYPE',
    );
  });

  it('validates the traversals INSIDE it, like any other expression', () => {
    expect(codes(inMovement('  write d-[:posts]-> { Body: { title: p.`nope` } }'))).toContain(
      'MOV_UNKNOWN_PROPERTY',
    );
  });
});

// ── Reading a json field ──

describe('a json field flows through, and nowhere else', () => {
  it('passes through into another json field', () => {
    expectClean(inMovement('  write d-[:posts]-> { Body: p.`Payload` }'));
    expectClean(inMovement('  write l-[:entries]-> { Meta: p.`Payload` }'));
  });

  it('takes a text value (everything data-shaped is assignable to json)', () => {
    expectClean(inMovement('  write d-[:posts]-> { Body: p.`Title` }'));
    expectClean(inMovement('  write l-[:entries]-> { Meta: p.`Views` }'));
  });

  it('cannot be written into a typed field', () => {
    expect(codes(inMovement('  write d-[:posts]-> { Title: p.`Payload` }'))).toContain(
      'MOV_WRITE_FIELD_TYPE',
    );
    expect(codes(inMovement('  write l-[:entries]-> { Amount: p.`Payload` }'))).toContain(
      'MOV_WRITE_FIELD_TYPE',
    );
  });
});

// ── Operating on a json value is LOUD ──

describe('operating on a json value is a loud error, not a silent degrade', () => {
  const inWhere = (where: string): string =>
    inMovement(
      `  d-[x:posts WHERE ${where}]-> {\n` +
        '    write d-[:posts]-> { Title: x.`Title` }\n' +
        '  }',
    );

  it('comparison — against a literal', () => {
    expect(codes(inWhere('`Payload` == "x"'))).toContain('MOV_JSON_OPAQUE');
  });

  it('comparison — even against another json value (opaque to itself)', () => {
    expect(codes(inWhere('`Payload` == `Payload`'))).toContain('MOV_JSON_OPAQUE');
  });

  it('comparison — ordering', () => {
    expect(codes(inWhere('`Payload` > 3'))).toContain('MOV_JSON_OPAQUE');
  });

  it('does NOT report a coercer hint instead — the message says what to do', () => {
    const said = messages(inWhere('`Payload` == "x"')).join('\n');
    expect(said).toMatch(/structured value/);
    expect(said).toMatch(/pass it through unchanged/);
    // No narrowing syntax is suggested, because none exists to teach.
    expect(said).not.toMatch(/narrow/i);
  });

  it('text interpolation — folding a structured value into text', () => {
    expect(
      codes(inMovement('  write d-[:posts]-> { Title: "payload: ${p.`Payload`}" }')),
    ).toContain('MOV_JSON_OPAQUE');
  });

  it('a typed field of the same position still compares clean', () => {
    expectClean(inWhere('`Title` == "x"'));
    expectClean(inWhere('`Views` > 3'));
  });
});

describe('the folds that READ elements refuse a structured one', () => {
  it('arithmetic', () => {
    expect(codes(inMovement('  write l-[:entries]-> { Amount: p.`Payload` * 2 }'))).toContain(
      'MOV_JSON_OPAQUE',
    );
  });

  it('SUM over a list of json', () => {
    expect(codes(inMovement('  write l-[:entries]-> { Amount: SUM(p.`Payload`) }'))).toContain(
      'MOV_JSON_OPAQUE',
    );
  });

  it('JOIN into text', () => {
    expect(codes(inMovement('  write d-[:posts]-> { Title: JOIN(p.`Payload`) }'))).toContain(
      'MOV_JSON_OPAQUE',
    );
  });

  it('COUNT is fine — it reads the list, not the elements', () => {
    expectClean(inMovement('  write l-[:entries]-> { Amount: COUNT(p.`Payload`) }'));
  });

  it('the same folds over a typed field stay clean', () => {
    expectClean(inMovement('  write l-[:entries]-> { Amount: p.`Views` * 2 }'));
    expectClean(inMovement('  write l-[:entries]-> { Amount: SUM(p.`Views`) }'));
  });
});

describe('gating on a structured value', () => {
  it('is a loud error — its truthiness carries no information', () => {
    expect(
      codes(
        inMovement(
          '  if p.`Payload` {\n' +
            '    write d-[:posts]-> { Title: p.`Title` }\n' +
            '  }',
        ),
      ),
    ).toContain('MOV_JSON_OPAQUE');
  });

  it('a typed condition is untouched', () => {
    expectClean(
      inMovement(
        '  if p.`Views` > 3 {\n' +
          '    write d-[:posts]-> { Title: p.`Title` }\n' +
          '  }',
      ),
    );
  });
});
