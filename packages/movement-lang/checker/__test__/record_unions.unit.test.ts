// One rule for a value that may be one of several records — TypeScript's
// union. `COALESCE(lead, co)` of People and Companies is `People | Companies`:
// it reads, walks and writes only what both offer, and a field one lacks is
// refused, naming it. The same rule types an IF, a COALESCE, a function's
// returns and a list's members, and none of them prefers an arm: only what
// every arm proved (a field present, a field a write set) counts.
//
// Versions. A read off such a value, a walk, a call's value and a list's
// member RAN under 3 and 4 — untyped, or typed by one arm — so what the rule
// refuses is refused from Dancing Wren (5) and an upgrade warning before. A
// write in place to one was an internal error until a058fda7, so it never
// ran, and its checks hold on every version.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: {
    People: { properties: { Name: 'text', Email: 'text', Age: 'number', Score: 'number' }, edges: { Employer: { target: 'Companies' } } },
    Companies: { properties: { Name: 'text', Domains: { kind: 'list', of: 'text' }, Age: 'text', Score: 'number' }, edges: { Employer: { target: 'Companies' } } },
  },
  collections: { people: { target: 'People' }, companies: { target: 'Companies' } },
  writableRoots: {
    People: { fields: { Name: 'text', Email: 'text', Score: 'number' }, resultShape: { externalId: 'text' } },
    Companies: { fields: { Name: 'text', Domains: { kind: 'list', of: 'text' }, Score: 'number' }, resultShape: { externalId: 'text' } },
  },
  supportsInPlaceUpdate: true,
};

const catalog = mockCatalog({
  adapters: { attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema } },
  credentials: { crm_cred: { adapter: 'attio' } },
  plugins: {},
});

const PRELUDE = ['import { attio } from adapters', 'import { crm_cred } from credentials', 'crm = attio(credentials: crm_cred)'].join('\n');

const diagnosticsUnder = (version: LanguageVersion, body: string[], extra: string[] = []): Diagnostic[] => {
  const source = `${PRELUDE}\n${extra.join('\n')}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version });
};

/** Each refusal under 5, or upgrade warning before it: its code, its severity, its message. */
const refusals = (version: LanguageVersion, body: string[], extra?: string[]): Array<[string, string, string]> =>
  diagnosticsUnder(version, body, extra)
    .filter(d => d.severity === undefined || d.upgrade === true)
    .map(d => [d.code, d.severity ?? 'error', d.message]);

const codes = (version: LanguageVersion, body: string[], extra?: string[]): Array<[string, string]> =>
  refusals(version, body, extra).map(([code, severity]) => [code, severity]);

/** A refusal the union rule adds: an error from 5, an upgrade warning before. */
const from5 = (version: LanguageVersion): string => (version >= 5 ? 'error' : 'warning');

const LEAD = '  lead = write crm-[:people]-> { Name: "Ann" }';
const CO = '  co = write crm-[:companies]-> { Name: "Acme" }';

describe.each<LanguageVersion>([3, 4, 5])('a value that may be People or Companies (version %i)', version => {
  it('the example, verbatim: reads and writes only what every member offers', () => {
    const body = [
      LEAD,
      CO,
      '  who = COALESCE(lead, co)          # People | Companies',
      '  n = who.Name                      # both have Name → typed (union of the field types)',
      '  d = who.Domains                   # only Companies → refused, naming the member that lacks it',
      '  write who { Name: "Acme" }        # allowed, value checked against Name in every member',
      '  write who { Domains: ["a.com"] }  # refused: People has no Domains',
    ];
    const found = refusals(version, body).sort(([a], [b]) => a.localeCompare(b));
    expect(found.map(([code, severity]) => [code, severity])).toEqual([
      ['MOV_UNKNOWN_PROPERTY', from5(version)],
      ['MOV_WRITE_UNKNOWN_FIELD', 'error'],
    ]);
    expect(found[0]![2]).toMatch(/^'Domains' can't be read here: this may be a crm\.People handle or a crm\.Companies handle, .*a crm\.People handle refuses it/);
    expect(found[1]![2]).toMatch(/a crm\.People handle has no field 'Domains'.*\(this may be a crm\.People handle or a crm\.Companies handle, and a write to it is held to every one of them\)$/);
  });

  it('a field every member has is the union of their types', () => {
    const body = [LEAD, CO, '  who = COALESCE(lead, co)', '  x = who.Age + 1'];
    expect(codes(version, body)).toEqual([['MOV_ARITH_NON_NUMERIC', from5(version)]]);
    expect(refusals(version, body)[0]![2]).toMatch(/the left side of '\+' is number \| text/);
    expect(codes(version, [LEAD, CO, '  who = COALESCE(lead, co)', '  x = who.Score + 1'])).toEqual([]);
  });

  it('a write value is checked against the field in every member', () => {
    const found = refusals(version, [LEAD, CO, '  who = COALESCE(lead, co)', '  write who { Score: "x" }']);
    expect(found.map(([code, , message]) => [code, message.replace(/ \(this may be .*$/, '')])).toEqual([
      ['MOV_WRITE_FIELD_TYPE', "'Score' on a crm.People handle is number, but this expression produces text"],
      ['MOV_WRITE_FIELD_TYPE', "'Score' on a crm.Companies handle is number, but this expression produces text"],
    ]);
  });

  it('an IF of them is the same union', () => {
    const body = [LEAD, CO, '  c = 1 > 0', '  who = IF c THEN lead ELSE co END', '  d = who.Domains'];
    expect(codes(version, body)).toEqual([['MOV_UNKNOWN_PROPERTY', from5(version)]]);
    expect(codes(version, [LEAD, CO, '  c = 1 > 0', '  who = IF c THEN lead ELSE co END', '  x = who.Score + 1'])).toEqual([]);
  });

  it('a walk off one walks only an edge every member has, landing on what they land on', () => {
    expect(codes(version, [LEAD, CO, '  who = COALESCE(lead, co)', '  crm-[p:people]-> {', '    who-[e:Employer]-> { x = e.Domains + 1 }', '  }'])).toEqual([
      ['MOV_ARITH_NON_NUMERIC', from5(version)],
    ]);
  });
});

describe.each<LanguageVersion>([3, 4, 5])("a function's returns join by the same rule (version %i)", version => {
  const pickOne = ['function pickOne(c: <boolean>) {', '  lead = write crm-[:people]-> { Name: "Ann" }', '  co = write crm-[:companies]-> { Name: "Acme" }', '  if c {', '    return lead', '  }', '  return co', '}'];

  it('a read every return offers is typed; one a return lacks is refused, not read off the first', () => {
    expect(codes(version, ['  who = pickOne(c: 1 > 0)', '  x = who.Score + 1'], pickOne)).toEqual([]);
    expect(codes(version, ['  who = pickOne(c: 1 > 0)', '  x = who.Email'], pickOne)).toEqual([
      ['MOV_UNKNOWN_PROPERTY', from5(version)],
    ]);
  });

  it('a write in place to the value is held to every return', () => {
    // Before 5 the value was the first return's, People, which already
    // refused this; the union refuses it of People too, said once more.
    const refused = codes(version, ['  who = pickOne(c: 1 > 0)', '  write who { Domains: ["a.com"] }'], pickOne);
    expect(refused).toEqual(version >= 5 ? [['MOV_WRITE_UNKNOWN_FIELD', 'error']] : [['MOV_WRITE_UNKNOWN_FIELD', 'error'], ['MOV_WRITE_UNKNOWN_FIELD', 'warning']]);
    expect(codes(version, ['  who = pickOne(c: 1 > 0)', '  write who { Name: "B" }'], pickOne)).toEqual([]);
  });
});

describe.each<LanguageVersion>([3, 4, 5])("a list literal's members join by the same rule (version %i)", version => {
  it('a member of [lead, co] reads only what both offer', () => {
    expect(codes(version, [LEAD, CO, '  both = [lead, co]', '  x = FIRST(both).Score + 1'])).toEqual([]);
    expect(codes(version, [LEAD, CO, '  both = [lead, co]', '  x = FIRST(both).Email'])).toEqual([
      ['MOV_UNKNOWN_PROPERTY', from5(version)],
    ]);
  });

  it('MULTI of them is the same', () => {
    expect(codes(version, [LEAD, CO, '  x = FIRST(MULTI(lead, co)).Email'])).toEqual([
      ['MOV_UNKNOWN_PROPERTY', from5(version)],
    ]);
  });
});
