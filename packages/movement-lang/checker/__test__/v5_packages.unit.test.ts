// A plugin package from language version 5 (design §2.10, §4.3), through the
// TypeScript checker: ``import { `@lf/web` as web } from plugins`` binds each
// member as `web.fetchUrl`, a call of which is an ordinary plugin call. The
// Rust twin is crates/movement-checker/tests/v5_packages.rs.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { expandPackageImports, mockCatalog, packageMembers, type PluginSpec } from '../catalog';

const plugins: Record<string, PluginSpec> = {
  fetch_url: {
    args: ['url', 'email'],
    priced: false,
    requiredArgs: ['url'],
    argTypes: { url: 'text', email: 'text' },
    effects: {},
    output: { kind: 'value', type: 'text' },
    package: '@lf/web',
  },
  research: {
    args: ['name', 'context'],
    priced: false,
    requiredArgs: ['name'],
    argTypes: { name: 'text', context: 'text' },
    effects: {},
    output: { kind: 'record', fields: { summary: 'text' } },
    package: '@lf/web',
  },
  linkedin_enrichment: {
    args: ['depth'],
    priced: false,
    fedArgs: [{ name: 'text', required: true }],
    argTypes: { depth: 'number' },
    package: '@lf/web',
  },
  summarize: {
    args: ['text'],
    priced: false,
    requiredArgs: ['text'],
    argTypes: { text: 'text' },
    effects: {},
    output: { kind: 'value', type: 'text' },
  },
};
const catalog = mockCatalog({ plugins });

const HEAD = 'import { `@lf/web` as web } from plugins\n\n';
const v5 = (body: string): string => `${HEAD}function go(u: <text>, n: <text>, s: <text>) {\n${body}\n}\n`;

function check(source: string, languageVersion: number): Diagnostic[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion }).filter(
    (d) => d.severity === undefined,
  );
}
const codes = (source: string, languageVersion: number): string[] => check(source, languageVersion).map((d) => d.code);

describe('a package', () => {
  it('is the specs that declare its tag, each named in camelCase', () => {
    expect(packageMembers(catalog, '@lf/web')).toEqual([
      { name: 'fetchUrl', key: 'fetch_url' },
      { name: 'research', key: 'research' },
      { name: 'linkedinEnrichment', key: 'linkedin_enrichment' },
    ]);
    expect(packageMembers(catalog, '@lf/nope')).toEqual([]);
  });

  it('is read by an engine as the imports of its members', () => {
    const program = expandPackageImports(parseProgram(v5('  p = 1'), { languageVersion: 5 }), catalog, 5);
    expect(program.statements[0]).toMatchObject({
      kind: 'import',
      names: [
        { name: 'fetch_url', alias: 'web.fetchUrl' },
        { name: 'research', alias: 'web.research' },
        { name: 'linkedin_enrichment', alias: 'web.linkedinEnrichment' },
      ],
    });
  });
});

describe("a package's members (version 5)", () => {
  it('are called as its plugins are: bound, bare, nested, as an argument, in closures', () => {
    const program = v5(
      [
        '  p = web.fetchUrl(u)',
        '  web.fetchUrl(u)',
        '  x = Text.length(web.fetchUrl(u, { email: s })) + 1',
        '  r = web.research(web.fetchUrl(u), { context: s })',
        '  y = r.summary',
      ].join('\n'),
    );
    expect(check(program, 5)).toEqual([]);
    const closures = v5(
      [
        '  g = (x: <text>) => {',
        '    q = web.fetchUrl(x)',
        '    return q',
        '  }',
        '  h = (x: <text>) => web.fetchUrl(x)',
        '  a = g(u)',
        '  b = h(u)',
      ].join('\n'),
    );
    expect(check(closures, 5)).toEqual([]);
  });

  it("bind and are checked as the plugin's own call is", () => {
    expect(codes(v5('  p = web.fetchUrl(u, { url: s })'), 5)).toEqual(['MOV_THROUGH_BAD_ARG']);
    expect(codes(v5('  r = web.research()'), 5)).toEqual(['MOV_THROUGH_ARG_MISSING']);
    expect(codes(v5('  x = Text.upper(web.fetchUrl(u, s))'), 5)).toEqual(['MOV_THROUGH_BAD_ARG']);
    expect(codes(v5('  r = web.research(n)\n  p = web.fetchUrl(r)'), 5)).toEqual(['MOV_CALL_ARG_TYPE']);
    const named = check(v5('  r = web.research(name: n, context: s)'), 5).filter((d) => d.code === 'MOV_V5_SPELLING');
    expect(named.map((d) => d.fix?.edits[0]?.text)).toEqual(['n, { context: s }']);
  });

  it("an unknown member names the package's members", () => {
    for (const body of ['  p = web.fetchUr(u)', '  web.fetchUr(u)', '  x = Text.length(web.fetchUr(u))']) {
      const found = check(v5(body), 5);
      expect(found.map((d) => d.code)).toEqual(['MOV_V5_UNKNOWN_MEMBER']);
      expect(found[0]!.message).toBe(
        '`web` has no member `fetchUr` (its members: `fetchUrl`, `research`, `linkedinEnrichment`) — did you mean `fetchUrl`?',
      );
    }
    expect(codes(v5('  p = web.summarize(u)'), 5)).toEqual(['MOV_V5_UNKNOWN_MEMBER']);
  });

  it('an unknown tag is an unknown plugin', () => {
    const found = check('import { `@lf/nope` as nope } from plugins\n\nfunction go(u: <text>) {\n  p = 1\n}\n', 5);
    expect(found.map((d) => [d.code, d.message])).toEqual([['MOV_IMPORT_UNKNOWN', "Unknown plugin '@lf/nope' in 'plugins'"]]);
  });

  it('a package imported without a name is refused with one', () => {
    const found = check('import { `@lf/web` } from plugins\n\nfunction go(u: <text>) {\n  p = 1\n}\n', 5);
    expect(found.map((d) => [d.code, d.message])).toEqual([
      [
        'MOV_V5_IMPORT_NEEDS_ALIAS',
        "`@lf/web` is imported without a name to call it by — a package's members are called through the name after 'as' (web.<member>(…)), and `@lf/web` is not a name a program can write: write `@lf/web` as web",
      ],
    ]);
    expect(found[0].fix?.edits.map((e) => e.text)).toEqual([' as web']);
    expect(found[0].fix?.safe).toBeUndefined();
    expect(codes('import { summarize } from plugins\n\nfunction go(u: <text>) {\n  p = summarize(u)\n}\n', 5)).toEqual([]);
  });

  it('versions 1–4 read a tag as an unknown plugin', () => {
    expect(codes('import { `@lf/web` as web } from plugins\n\nmovement go(u: <text>) {\n  p = 1\n}\n', 4)).toEqual([
      'MOV_IMPORT_UNKNOWN',
    ]);
  });

  it('a local binding is never a package', () => {
    expect(codes(v5('  box = { n: 1 }\n  v = box.fetchUrl()'), 5)).toEqual(['MOV_FUNCTION_UNKNOWN']);
  });
});

describe('a through stage (version 5)', () => {
  const stage = (through: string): string =>
    `${HEAD}function go(u: <text>) {\n  found = extract from [u] {\n    name: "the name"\n  } through [${through}] {\n    detail: "more"\n  }\n}\n`;

  it("names a package's member", () => {
    expect(check(stage('web.linkedinEnrichment'), 5)).toEqual([]);
    expect(check(stage('web.linkedinEnrichment({ depth: 2 })'), 5)).toEqual([]);
    expect(codes(stage('web.linkedin'), 5)).toEqual(['MOV_V5_UNKNOWN_MEMBER']);
  });
});
