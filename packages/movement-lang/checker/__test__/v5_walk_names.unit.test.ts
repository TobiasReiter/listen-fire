// One diagnostic per misspelled bare name in a version 5 walk's WHERE: a bare
// name inside a hop's brackets is a variable from outside the walk. A field of
// the hop written bare is the old spelling (MOV_V5_SPELLING, its fix the alias
// read); a name that is neither a variable nor a field of the hop's known type
// is one unknown name (MOV_NAME_UNRESOLVED), its did-you-mean over the hop's
// fields and the names in scope. The Rust checker's twin is
// crates/movement-checker/tests/v5_walk_names.rs, same programs, same messages.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';

const crmSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text', score: 'number' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: { attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema } },
  credentials: { 'Acme CRM': { adapters: ['attio'] } },
});

function check(body: string): Array<[string, string]> {
  const source = `import { \`@lf/attio\` as attio } from adapters\nimport { \`Acme CRM\` } from credentials\ncrm = connect attio using \`Acme CRM\`\nfunction go(cutoff: <number>) {\n${body}\n}\n`;
  return checkProgram(parseProgram(source, { languageVersion: 5 }), catalog, { languageVersion: 5 })
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => [d.code, d.message]);
}

const UNKNOWN =
  "no variable in scope is called that, and crm.company has no such field (a bare name inside a walk's brackets is a variable from outside the walk; a field is read through the hop's alias)";

it('a misspelled variable is one unknown name, suggesting the variable', () => {
  for (const body of ['  crm-[c:companies WHERE c.score > cutof]-> { }', '  n = crm-[c:companies WHERE c.score > cutof]->.name']) {
    expect(check(body)).toEqual([['MOV_NAME_UNRESOLVED', `Unknown name 'cutof' — ${UNKNOWN} — did you mean 'cutoff'?`]]);
  }
});

it('a misspelled field is one unknown name, suggesting the field through the alias', () => {
  expect(check('  crm-[c:companies WHERE scor > cutoff]-> { }')).toEqual([
    ['MOV_NAME_UNRESOLVED', `Unknown name 'scor' — ${UNKNOWN} — did you mean the field 'score', read through the hop's alias?`],
  ]);
});

it('a field written bare is the old spelling alone', () => {
  expect(check('  crm-[c:companies WHERE score > cutoff]-> { }').map(([code]) => code)).toEqual(['MOV_V5_SPELLING']);
});

it('a name far from everything has no suggestion', () => {
  expect(check('  crm-[c:companies WHERE c.score > zzzzzzzz]-> { }')).toEqual([
    ['MOV_NAME_UNRESOLVED', `Unknown name 'zzzzzzzz' — ${UNKNOWN}`],
  ]);
});
