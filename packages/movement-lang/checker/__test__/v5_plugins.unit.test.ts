// A plugin's arguments by position from language version 5 (design §2.7),
// through the TypeScript checker: its required inputs in the manifest's
// order, then one settings record; the named form versions 1–4 write is
// refused with the positional rewrite, which the upgrade applies. The Rust
// twin is crates/movement-checker/tests/v5_plugins.rs.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { bindPluginArgs, mockCatalog, pluginPositionalParams, type PluginSpec } from '../catalog';
import { typescriptCheck, upgradeSource } from '../upgrade';
import { notKeywordRetirement } from './keyword_retirement';

const plugins: Record<string, PluginSpec> = {
  fetch_url: {
    args: ['url', 'email'],
    priced: false,
    requiredArgs: ['url'],
    argTypes: { url: 'text', email: 'text' },
    effects: {},
    output: { kind: 'value', type: 'text' },
  },
  research: {
    args: ['name', 'context', 'questions'],
    priced: false,
    requiredArgs: ['name'],
    argTypes: { name: 'text', context: 'text', questions: 'text' },
    effects: {},
    output: { kind: 'record', fields: { summary: 'text' } },
  },
  vc_url_retrieval: {
    args: ['email'],
    priced: false,
    fedArgs: [{ name: 'text', required: true }],
    argTypes: { text: 'text', email: 'text' },
    effects: {},
    output: { kind: 'value', type: 'text' },
  },
};
plugins.linkedin_enrichment = {
  args: ['depth'],
  priced: false,
  fedArgs: [{ name: 'text', required: true }],
  requiredArgs: ['depth'],
  argTypes: { depth: 'number' },
};
const catalog = mockCatalog({ plugins });

const HEAD4 = 'import { fetch_url, research, vc_url_retrieval } from plugins\n\n';
const HEAD5 = 'import { fetchUrl, research, vcUrlRetrieval } from plugins\n\n';
const v4 = (body: string): string => `${HEAD4}movement go(u: <text>, n: <text>, s: <text>, t: <text>) {\n${body}\n}\n`;
const v5 = (body: string): string => `${HEAD5}function go(u: <text>, n: <text>, s: <text>, t: <text>) {\n${body}\n}\n`;

function check(source: string, languageVersion: number): Diagnostic[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion }).filter(notKeywordRetirement).filter(
    (d) => d.severity === undefined,
  );
}
const codes = (source: string, languageVersion: number): string[] => check(source, languageVersion).map((d) => d.code);

describe('the positional parameters', () => {
  it('are the required fed inputs, then the required ones in declared order; a stage is never fed', () => {
    expect(pluginPositionalParams(plugins.vc_url_retrieval!, 'plain')).toEqual(['text']);
    expect(pluginPositionalParams(plugins.vc_url_retrieval!, 'stage')).toEqual([]);
    expect(pluginPositionalParams(plugins.research!, 'plain')).toEqual(['name']);
  });

  it('bind a trailing record literal as named settings, each its own slot', () => {
    const slot = (raw: string, col: number) => ({ raw, span: { start: { line: 3, col }, end: { line: 3, col: col + raw.length } } });
    const bound = bindPluginArgs(plugins.research!, 'plain', [
      { kind: 'expr', expr: slot('n', 10) },
      { kind: 'expr', expr: slot('{ context: s }', 13) },
    ]);
    expect(bound.misfits).toEqual([]);
    expect(bound.args).toEqual([
      { kind: 'expr', name: 'name', expr: slot('n', 10) },
      { kind: 'expr', name: 'context', expr: { raw: 's', span: { start: { line: 3, col: 24 }, end: { line: 3, col: 25 } } } },
    ]);
  });
});

describe('versions 1–4', () => {
  it('keep named plugin arguments, and refuse positional ones', () => {
    expect(codes(v4('  p = fetch_url(url: u)\n  r = research(name: n, context: s)\n  v = vc_url_retrieval(text: t, email: u)'), 4)).toEqual([]);
    expect(codes(v4('  p = fetch_url(u)'), 4)).toEqual(['MOV_PLUGIN_ARGS_NAMED']);
  });
});

describe('version 5', () => {
  it('takes the required inputs by position and the rest in a settings record', () => {
    expect(
      check(v5('  p = fetchUrl(u)\n  r = research(n, { context: s, questions: s })\n  v = vcUrlRetrieval(t, { email: u })\n  w = fetchUrl(u, { email: s })'), 5),
    ).toEqual([]);
    expect(check(v5('  fetchUrl(u)\n  r = research(fetchUrl(u), { context: s })\n  x = Text.length(fetchUrl(u)) + 1'), 5)).toEqual([]);
    expect(codes(v5('  x = Text.length(fetchUrl(u, s))'), 5)).toEqual(['MOV_THROUGH_BAD_ARG']);
  });

  it('checks the bound call as the named one is checked', () => {
    expect(codes(v5('  p = fetchUrl(u, { url: s })'), 5)).toEqual(['MOV_THROUGH_BAD_ARG']);
    expect(codes(v5('  r = research(n, { nope: s })'), 5)).toEqual(['MOV_THROUGH_BAD_ARG']);
    expect(codes(v5('  p = fetchUrl(u, s)'), 5)).toEqual(['MOV_THROUGH_BAD_ARG']);
    expect(codes(v5('  p = fetchUrl(u, { email: s }, s)'), 5)).toEqual(['MOV_THROUGH_BAD_ARG']);
    expect(codes(v5('  r = research()'), 5)).toEqual(['MOV_THROUGH_ARG_MISSING']);
    const missingFed = check(v5('  v = vcUrlRetrieval()'), 5);
    expect(missingFed.map((d) => d.code)).toEqual(['MOV_PLUGIN_FED_BY_EXTRACTION']);
    expect(missingFed[0]!.message).toContain('`vcUrlRetrieval(text)`');
    expect(codes(v5('  r = research(n)\n  p = fetchUrl(r)'), 5)).toEqual(['MOV_CALL_ARG_TYPE']);
    expect(codes(v5('  r = research(n)\n  p = fetchUrl(u, { email: r })'), 5)).toEqual(['MOV_CALL_ARG_TYPE']);
    const extra = check(v5('  p = fetchUrl(u, s)'), 5);
    expect(extra[0]!.message).toBe(
      "'fetchUrl' takes one argument by position (url), then its settings as one record `{ name: value }` — this argument is past them",
    );
    expect(extra[0]!.span.start).toEqual({ line: 4, col: 19 });
    expect(check(v5('  p = fetchUrl(u, { email: s }, s)'), 5)[0]!.span).toEqual({ start: { line: 4, col: 33 }, end: { line: 4, col: 34 } });
  });

  it('reports a settings entry where it is written', () => {
    const found = check(v5('  r = research(n, { context: s, name: s })'), 5);
    expect(found.map((d) => [d.message, d.span])).toEqual([
      [
        "'name' is an argument 'research' takes by position — write it in its place, not in the settings record",
        { start: { line: 4, col: 33 }, end: { line: 4, col: 37 } },
      ],
    ]);
    const typed = check(v5('  r = research(n)\n  q = research(n, { context: r })'), 5);
    expect(typed.map((d) => [d.code, d.span.start])).toEqual([['MOV_CALL_ARG_TYPE', { line: 5, col: 30 }]]);
  });

  it('rewrites the named form by position from the manifest', () => {
    const fixesOf = (source: string): Array<[string | undefined, boolean]> =>
      check(source, 5)
        .filter((d) => d.code === 'MOV_V5_SPELLING')
        .map((d) => [d.fix?.edits[0]?.text, d.fix?.safe === true]);
    expect(fixesOf(v5('  p = fetchUrl(url: u)'))).toEqual([['u', true]]);
    expect(fixesOf(v5('  r = research(name: n, context: s)'))).toEqual([['n, { context: s }', true]]);
    expect(fixesOf(v5('  v = vcUrlRetrieval(text: t, email: u)'))).toEqual([['t, { email: u }', true]]);
    // Moved, the arguments would run in another order: a fix, not a safe one.
    expect(fixesOf(v5('  r = research(context: s, name: n)'))).toEqual([['n, { context: s }', false]]);
    // A name the manifest does not know, or an input never written: no rewrite.
    expect(fixesOf(v5('  r = research(name: n, nope: s)'))).toEqual([[undefined, false]]);
    expect(fixesOf(v5('  r = research(context: s)'))).toEqual([[undefined, false]]);
  });

  it('upgrades a version 4 program to one that checks clean', () => {
    const program = v4('  p = fetch_url(url: u)\n  r = research(name: n, context: s, questions: t)\n  v = vc_url_retrieval(text: t, email: u)');
    const upgraded = upgradeSource(program, typescriptCheck({ catalog, languageVersion: 5, upgradingFrom: 4 }), { all: true });
    // The import keeps each local name, so the calls keep theirs.
    expect(upgraded.source).toContain('fetch_url(u)');
    expect(upgraded.source).toContain('research(n, { context: s, questions: t })');
    expect(upgraded.source).toContain('vc_url_retrieval(t, { email: u })');
    expect(upgraded.held).toEqual([]);
    expect(check(upgraded.source, 5)).toEqual([]);
  });
});

describe('a through stage under 5', () => {
  const stage = (through: string): string =>
    `import { research, linkedinEnrichment } from plugins\n\nfunction go(u: <text>, n: <text>, s: <text>) {\n  found = extract from [u] {\n    name: "the name"\n  } through [${through}] {\n    detail: "more"\n  }\n}\n`;

  it('takes its arguments by position too, and is never fed by its author', () => {
    expect(check(stage('linkedinEnrichment(2)'), 5)).toEqual([]);
    expect(check(stage('research(n, { context: s })'), 5)).toEqual([]);
    expect(codes(stage('linkedinEnrichment'), 5)).toEqual(['MOV_THROUGH_ARG_MISSING']);
    expect(codes(stage('linkedinEnrichment(u, 2)'), 5)).toEqual(['MOV_THROUGH_BAD_ARG']);
    expect(codes(stage('research(n, { name: s })'), 5)).toEqual(['MOV_THROUGH_BAD_ARG']);
  });

  it('rewrites its named arguments by position, and the rewrite checks clean', () => {
    const program = stage('research(name: n, context: s)');
    const fixes = check(program, 5).filter((d) => d.code === 'MOV_V5_SPELLING').map((d) => d.fix?.edits[0]?.text);
    expect(fixes).toEqual(['n, { context: s }']);
    const upgraded = upgradeSource(program, typescriptCheck({ catalog, languageVersion: 5 }));
    expect(upgraded.source).toContain('research(n, { context: s })');
    expect(check(upgraded.source, 5)).toEqual([]);
  });
});

describe("a record value handed to a plugin's text input", () => {
  const all = (source: string, languageVersion: number) =>
    checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion }).filter(notKeywordRetirement).map((d) => [d.code, d.severity ?? 'error', d.message]);

  it('is refused from 5', () => {
    expect(all(v5('  r = research({ context: s })'), 5)).toEqual([
      [
        'MOV_CALL_ARG_MAYBE_RECORD',
        'error',
        "'research' takes text for 'name', and this is { context: text } — a record, not text, as in TypeScript. Pass the text it should read: one of its fields ('name: r.name'), or the text built from them",
      ],
    ]);
    expect(codes(v5('  r = research(n, { context: s == "" ? { a: 1 } : s })'), 5)).toEqual(['MOV_CALL_ARG_MAYBE_RECORD']);
    expect(codes(v5('  r = research(n, { context: s })'), 5)).toEqual([]);
  });

  it('is warned under 4, where it ran', () => {
    const warned = all(v4('  r = research(name: { context: s })'), 4);
    expect(warned.map(([code, severity]) => [code, severity])).toEqual([['MOV_CALL_ARG_MAYBE_RECORD', 'warning']]);
    expect(String(warned[0]![2])).toMatch(/; from it, this is refused$/);
  });
});
