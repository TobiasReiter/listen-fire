// Equality and conditions over an extracted value that may be absent.
//
// TypeScript's reading of `T | undefined`: `x === "a"` is simply false when `x`
// is undefined, and `if (x)` treats undefined as false — neither needs a guard.
// So `==` / `!=` take a maybe-absent side against a present one, and `if`,
// `IF … THEN`, `AND`, `OR`, `NOT` take `boolean | absent`. Ordering does not:
// TS errors on `x < 3`, and so does this. The engine half is pinned by
// `movement_engine/__test__/absent_equality_and_conditions`.
//
// Every case runs under both language versions: this was never a refusal, so
// neither version may start refusing it.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import { SUPPORTED_LANGUAGE_VERSIONS, type LanguageVersion } from '../../language_version';

const chatSchema: InstanceSchema = {
  positions: {
    channel: { properties: { Name: 'text' }, edges: {} },
    note: { properties: { Body: 'text', Flag: 'boolean' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text', Flag: 'boolean' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });

const EXTRACT = [
  '  o = extract from [c.`Name`] {',
  '    title: <text | null> "the title"',
  '    size: <number> "how many"',
  '    viable: <boolean> "is it viable"',
  '    thesis: <Thesis> "the thesis"',
  '    node item: "each item" {',
  '      ok: <boolean> "is it ok"',
  '      kind: <Thesis> "its thesis"',
  '    }',
  '  }',
  '',
].join('\n');

const errorsUnder = (body: string, languageVersion: LanguageVersion): Diagnostic[] =>
  checkProgram(
    parseProgram(`import { slack } from adapters
type Thesis = <"Consumer" | "Infra">
chat = slack()
movement m(c: <chat-[:channel]->>) {
${EXTRACT}${body}
}`),
    catalog,
    { languageVersion },
  ).filter((d) => (d.severity ?? 'error') === 'error');

const VERSIONS = [...SUPPORTED_LANGUAGE_VERSIONS];

describe.each(VERSIONS)('under language version %s', (version) => {
  const codes = (body: string): string[] => errorsUnder(body, version).map((d) => d.code);

  describe('== and != take a maybe-absent side', () => {
    it.each([
      'if o.title == "Seed" { }',
      'if o.title != "Seed" { }',
      'if "Seed" == o.title { }',
      'if o.thesis == "Infra" { }',
      'if o.thesis != "Infra" { }',
      'if "Infra" != o.thesis { }',
      'if o.size == 3 { }',
      'if o.viable == true { }',
      'same = o.thesis == "Consumer"',
      'o-[i:item]-> { if i.kind == "Infra" { } }',
    ])('%s', (body) => {
      expect(codes(body)).toEqual([]);
    });

    it('still names a typo against the enum, and nothing else', () => {
      expect(codes('if o.thesis == "Infar" { }')).toEqual(['MOV_ENUM_UNKNOWN_VALUE']);
    });
  });

  describe('conditions take boolean | absent', () => {
    it.each([
      'if o.viable { }',
      'if o.viable { } else { }',
      'if NOT o.viable { }',
      'if !o.viable { }',
      'if o.viable AND o.size == 3 { }',
      'if o.title == "Seed" AND o.viable { }',
      'if o.viable OR o.title == "Seed" { }',
      'both = o.viable AND o.viable',
      'neither = NOT o.viable',
      'label = IF o.viable THEN "go" ELSE "stop" END',
      'o-[i:item]-> { if i.ok { } }',
    ])('%s', (body) => {
      expect(codes(body)).toEqual([]);
    });
  });

  describe('ordered comparisons still refuse absent', () => {
    it.each(['>', '>=', '<', '<='])('o.size %s 3', (op) => {
      expect(codes(`if o.size ${op} 3 { }`)).toEqual(['MOV_ABSENT_REQUIRED']);
    });

    it('…in a condition built with AND as well', () => {
      expect(codes('if o.viable AND o.size > 3 { }')).toEqual(['MOV_ABSENT_REQUIRED']);
    });
  });

  describe('narrowing is unaffected', () => {
    const write = 'write chat-[:note]-> { Body: o.title }';

    it('== against a present value narrows its true arm', () => {
      expect(codes(`if o.title == "Seed" { ${write} }`)).toEqual([]);
    });

    it('!= narrows nothing — a != match may be absent', () => {
      expect(codes(`if o.title != "Seed" { ${write} }`)).toEqual(['MOV_ABSENT_REQUIRED']);
    });

    it('== null as a guard clause narrows everything after it', () => {
      expect(codes(`if o.title == null { ERROR("no title") }\n  ${write}`)).toEqual([]);
    });

    it('a bare boolean condition proves nothing about another field', () => {
      expect(codes(`if o.viable { ${write} }`)).toEqual(['MOV_ABSENT_REQUIRED']);
    });

    it('an ordered comparison inside an == arm is discharged', () => {
      expect(codes('if o.size == 3 { if o.size > 1 { } }')).toEqual([]);
    });
  });
});
