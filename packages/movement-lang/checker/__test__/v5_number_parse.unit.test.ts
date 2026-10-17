// From version 5 `Number.parse(text)` answers nothing for text that is no
// number (the engine's `NUMBER("")` is null), so it is `number | absent`: a
// required value must come from a `!= null` guard, a guard clause that always
// leaves, or a fallback (MOV_ABSENT_REQUIRED). Versions 1–4 type it `number`.
// The Rust checker's twin is crates/movement-checker/tests/v5_number_parse.rs,
// same programs, same messages.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const catalog = mockCatalog({
  adapters: {
    crm: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: {
        positions: { company: { properties: { name: 'text', employees: 'number' }, edges: {} } },
        collections: { companies: { target: 'company' } },
        writableRoots: {
          company: { fields: { name: 'text', employees: 'number' }, resultShape: { externalId: 'text' } },
        },
      },
    },
  },
  credentials: { crm_cred: { adapter: 'crm' } },
});

function absent(body: string, languageVersion: LanguageVersion): string[] {
  const v5 = languageVersion >= 5;
  const source = [
    'import { crm } from adapters',
    'import { crm_cred } from credentials',
    v5 ? 'c = connect crm using crm_cred' : 'c = crm(credentials: crm_cred)',
    `${v5 ? 'function' : 'movement'} go(t: <text>) {`,
    v5 ? body : body.replace(/Number\.parse\(/g, 'NUMBER(').replace('fail(', 'ERROR('),
    '}',
  ].join('\n');
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion })
    .filter((d) => d.code === 'MOV_ABSENT_REQUIRED')
    .map((d) => d.message);
}

const WRITE = (value: string) => `  write c-[:companies]-> { name: "x", employees: ${value} }`;
const refused = (shown: string) =>
  `'employees' on c.company needs a value, but '${shown}' may be absent (number (or absent)) — write 'employees: coalesce(${shown}, 0)' to fall back to a value that is always there, or 'employees ?: ${shown}' to leave it unset when absent (see handbook: front#maybe-absent)`;

describe('under version 5', () => {
  it('a required field refuses the parse, direct or through a name', () => {
    expect(absent(WRITE('Number.parse(t)'), 5)).toEqual([refused('Number.parse(t)')]);
    expect(absent(`  n = Number.parse(t)\n${WRITE('n')}`, 5)).toEqual([refused('n')]);
  });

  it('a != null guard, a guard clause that leaves, and a fallback each satisfy it', () => {
    expect(absent(`  n = Number.parse(t)\n  if (n != null) {\n  ${WRITE('n')}\n  }`, 5)).toEqual([]);
    expect(absent(`  n = Number.parse(t)\n  if (n == null) {\n    fail("no number")\n  }\n${WRITE('n')}`, 5)).toEqual([]);
    expect(absent(WRITE('coalesce(Number.parse(t), 0)'), 5)).toEqual([]);
    expect(absent(`  write c-[:companies]-> { name: "x", employees ?: Number.parse(t) }`, 5)).toEqual([]);
  });
});

describe('under versions 1–4', () => {
  it('the parse is a plain number', () => {
    expect(absent(WRITE('Number.parse(t)'), 4)).toEqual([]);
    expect(absent(`  n = Number.parse(t)\n${WRITE('n')}`, 4)).toEqual([]);
  });
});
