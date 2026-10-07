// The check every run passes, and its answer as data for the Rust engine:
// diagnostics, the import link with declarations as AST paths, and the
// checker's stamps keyed by AST path (program_check.ts says the scheme).

import { mockCatalogSnapshot, parseProgram, type InstanceSchema, type Program } from 'movement-lang';

import { MovementEngineError } from '../errors';
import { checkAnswer, checkPinned } from '../program_check';

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const attioSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text', stage: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: { fields: { name: 'text', stage: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
  },
};

const LIBRARY = ['export node Deal {', '  name:  <text>', '  stage: <text>', '}'].join('\n');

const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: attioSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
];

const SPREADING = [
  ...PRELUDE,
  'import { Deal } from "deals"',
  'function record_deal(d: <Deal>) {',
  '  write crm-[:companies]-> { ...d }',
  '}',
  'movement m(msg: <inbox-[:message]->>) {',
  '  record_deal(d: node { name: msg.`subject`, stage: "Seed" })',
  '}',
].join('\n');

/** The node a JSON Pointer names. */
function at(program: Program, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>((node, token) => Reflect.get(Object(node), token.replaceAll('~1', '/').replaceAll('~0', '~')), program);
}

describe('the program check', () => {
  const withFiles = { ...catalog, files: { deals: { source: LIBRARY } } };

  it("answers the checker's stamps by AST path, and the link with declarations as paths", () => {
    const checked = checkPinned({ source: SPREADING, catalog: withFiles, languageVersion: 3 });
    const answer = checkAnswer(checked);
    expect(answer.stamps).toEqual([{ path: '/statements/5/body/0/write/spreads/0', spreadFields: ['name', 'stage'] }]);
    // The path names the very spread the checker stamped, and a fresh parse
    // has the node there, unstamped.
    expect(at(checked.program, answer.stamps[0].path)).toMatchObject({ source: 'd', fields: ['name', 'stage'] });
    const fresh = parseProgram(SPREADING, { languageVersion: 3 });
    expect(at(fresh, answer.stamps[0].path)).toMatchObject({ source: 'd' });
    expect(at(fresh, answer.stamps[0].path)).not.toHaveProperty('fields');
    expect(answer.link).toEqual({
      imports: [{ local: 'Deal', kind: 'shape', name: 'Deal', file: 'deals', declaration: '/statements/0' }],
      files: [{ path: 'deals', source: LIBRARY, imports: [], exports: [{ name: 'Deal', kind: 'shape', declaration: '/statements/0' }] }],
    });
    expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
  });

  it('throws MOVENG_CHECK for an error diagnostic, as every run does', () => {
    const broken = SPREADING.replace('msg.`subject`', 'msg.`nope`');
    expect(() => checkPinned({ source: broken, catalog: withFiles, languageVersion: 3 })).toThrow(MovementEngineError);
    expect(() => checkPinned({ source: broken, catalog: withFiles, languageVersion: 3 })).toThrow(/MOVENG_CHECK: the movement program failed checking/);
  });

  it('throws MOVENG_PARSE and MOVENG_LANGUAGE_VERSION before it checks', () => {
    expect(() => checkPinned({ source: 'movement {', catalog, languageVersion: 3 })).toThrow(/^MOVENG_PARSE/);
    expect(() => checkPinned({ source: SPREADING, catalog, languageVersion: 999 })).toThrow(/^MOVENG_LANGUAGE_VERSION/);
  });
});
