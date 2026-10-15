// A credential is never a value in a program, in any sense, on every language
// version. It is named in one place — the `credentials:` argument where an
// integration is set up — and the host resolves it there. Every other read of
// the name is refused: it is a security boundary, and every such read already
// failed at run time.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
  },
};

const catalog = mockCatalog({
  adapters: { attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema } },
  credentials: { acme: { adapter: 'attio' } },
  plugins: {
    summarise: {
      args: ['data'],
      requiredArgs: ['data'],
      effects: { ai: true },
      output: { kind: 'value', type: 'text' },
    },
  },
});

// A text parameter is spelled from version 3; before it, a function takes a record.
const prelude = (version: LanguageVersion): string =>
  [
    'import { attio } from adapters',
    'import { acme } from credentials',
    'import { summarise } from plugins',
    'crm = attio(credentials: acme)',
    `function echo(v: ${version >= 3 ? '<text>' : '<crm-[:company]->>'}) {`,
    '  return v',
    '}',
  ].join('\n');

const errorsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] => {
  const source = `${prelude(version)}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );
};
const codes = (version: LanguageVersion, body: string[]): string[] => errorsUnder(version, body).map(d => d.code);

const VERSIONS: LanguageVersion[] = [1, 2, 3, 4, 5];
const REFUSED = 'MOV_CREDENTIAL_NOT_A_VALUE';

const READS: Array<[string, string[]]> = [
  ['a binding', ['  x = acme']],
  ['a dotted read', ['  x = acme.token']],
  ['an interpolation', ['  x = "${acme}"']],
  ['a compare with text', ['  x = acme == "acme"']],
  ['a null test', ['  if acme == null { ERROR("none") }']],
  ['a not-null test', ['  if acme != null { ERROR("some") }']],
  ['EXISTS', ['  x = EXISTS(acme)']],
  ['a list element', ['  x = [acme]']],
  ['a dict value', ['  x = { a: acme }']],
  ['an ERROR argument', ['  ERROR(acme)']],
  ['an ERROR interpolation', ['  ERROR("${acme}")']],
  ['an AI prompt', ['  x = AI("say ${acme}")']],
  ['TEXT.PAIRS', ['  x = TEXT.PAIRS(acme)']],
  ['AT', ['  x = AT(acme, "token")']],
  ['a function argument', ['  x = echo(acme)']],
  ['a plugin argument', ['  x = summarise(data: acme)']],
  ['a returned value', ['  return acme']],
  ['a write field', ['  write crm-[:companies]-> { name: acme }']],
];

describe('a credential read as a value', () => {
  describe.each(VERSIONS)('version %s', version => {
    it.each(READS)('%s is refused', (_label, body) => {
      expect(codes(version, body)).toEqual([REFUSED]);
    });

    it('a type written against it is refused', () => {
      const source = `${prelude(version)}\nmovement m(c: <acme-[:company]->>) {\n  x = 1\n}`;
      const errors = checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version })
        .filter(d => (d.severity ?? 'error') === 'error')
        .map(d => d.code);
      expect(errors).toContain(REFUSED);
    });

    it.each([
      ['listened to', 'listen to acme fire m', 'MOV_LISTEN_NOT_INSTANCE'],
    ])('%s, it is refused by the listen rule', (_label, line, code) => {
      const source = `${prelude(version)}\nmovement m() {\n  x = 1\n}\n${line}`;
      const errors = checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version })
        .filter(d => (d.severity ?? 'error') === 'error')
        .map(d => d.code);
      expect(errors).toContain(code);
    });

    it('the construction argument is still clean', () => {
      expect(errorsUnder(version, ['  write crm-[:companies]-> { name: "Acme" }'])).toEqual([]);
    });
  });

  describe('closures (Dancing Wren, 5)', () => {
    it('a closure body that reads it is refused', () => {
      expect(codes(5, ['  f = () => acme'])).toEqual([REFUSED]);
    });

    it('a closure handed it as an argument is refused', () => {
      expect(codes(5, ['  f = (v: <text>) => v', '  x = f(acme)'])).toEqual([REFUSED]);
    });
  });

  it('says where a credential IS named', () => {
    const [refusal] = errorsUnder(5, ['  x = acme']).filter(d => d.code === REFUSED);
    expect(refusal?.message).toContain("'credentials:' argument");
  });
});
