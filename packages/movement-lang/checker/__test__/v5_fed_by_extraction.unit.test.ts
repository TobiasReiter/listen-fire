// A plugin fed only by an extraction (`linkedin_enrichment`: no inputs of its
// own, it reads the record a `through […]` stage enriched) is a function from
// language version 5: the record it runs on is its one positional argument,
// and its call hands back what it declared. Versions 1–4 keep refusing the
// call. The Rust twin is crates/movement-checker/tests/v5_fed_by_extraction.rs.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { mockCatalog, pluginPositionalParams, pluginSpecUnder, type PluginSpec } from '../catalog';

const linkedinEnrichment: PluginSpec = {
  args: [],
  priced: false,
  argTypes: {},
  effects: { reads: ['the web'], ai: true },
  fedByExtraction: true,
  output: {
    kind: 'record',
    fields: { linkedin_url: { kind: 'maybeAbsent', of: 'text' }, linkedin_profile: { kind: 'maybeAbsent', of: 'text' } },
  },
};
const catalog = mockCatalog({ plugins: { linkedin_enrichment: linkedinEnrichment } });

function check(source: string, languageVersion: number): Diagnostic[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion }).filter((d) => d.severity === undefined);
}
const codes = (source: string, languageVersion: number): string[] => check(source, languageVersion).map((d) => d.code);

const v5 = (body: string): string =>
  `import { linkedinEnrichment } from plugins\n\nfunction go(n: <text>, c: <text>) {\n${body}\n}\n`;

describe('the record a stage fed', () => {
  it('is the one positional parameter from 5, and nothing before', () => {
    expect(pluginPositionalParams(pluginSpecUnder(linkedinEnrichment, 5), 'plain')).toEqual(['record']);
    expect(pluginSpecUnder(linkedinEnrichment, 4)).toBe(linkedinEnrichment);
  });
});

describe('version 5', () => {
  it('calls it with the record, and types what it hands back', () => {
    expect(
      check(v5('  p = { name: n, company: { name: c } }\n  found = linkedinEnrichment(p)\n  url = coalesce(found.linkedin_url, "")'), 5),
    ).toEqual([]);
  });

  it('refuses a call without the record, naming the call to write', () => {
    const missing = check(v5('  found = linkedinEnrichment()'), 5);
    expect(missing.map((d) => d.code)).toEqual(['MOV_PLUGIN_FED_BY_EXTRACTION']);
    expect(missing[0]!.message).toContain('`linkedinEnrichment(record)`');
  });

  it('takes nothing past the record but a settings record', () => {
    expect(codes(v5('  p = { name: n }\n  found = linkedinEnrichment(p, n)'), 5)).toEqual(['MOV_THROUGH_BAD_ARG']);
  });

  it('reads no field it did not declare', () => {
    expect(codes(v5('  p = { name: n }\n  found = linkedinEnrichment(p)\n  x = found.nope'), 5)).not.toEqual([]);
  });

  it("points the extraction keyword's hand rewrite at the call", () => {
    const program =
      'import { linkedinEnrichment } from plugins\n\nfunction go(u: <text>) {\n  found = extract from [u] {\n    name: "the name"\n  } through [linkedinEnrichment] {\n    detail: "more"\n  }\n}\n';
    const retired = checkProgram(parseProgram(program, { languageVersion: 5 }), catalog, { languageVersion: 5 }).filter(
      (d) => d.code === 'MOV_EXTRACT_KEYWORD_RETIRED',
    );
    expect(retired.map((d) => d.message)).toEqual([
      expect.stringContaining("map over the records calling each plugin ('linkedinEnrichment(record)'), extractOne over the content"),
    ]);
  });
});

describe('versions 1–4', () => {
  it('keep it a stage: a call is refused', () => {
    const program = 'import { linkedin_enrichment } from plugins\n\nmovement go(n: <text>) {\n  found = linkedin_enrichment()\n}\n';
    expect(codes(program, 4)).toEqual(['MOV_PLUGIN_FED_BY_EXTRACTION']);
    expect(check(program, 4)[0]!.message).toContain('runs on what an extraction gives it and takes nothing of its own');
  });
});
