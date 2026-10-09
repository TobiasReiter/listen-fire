// The skeleton every binding × consumer matrix cell's program is built on
// (see binding_consumer_matrix.unit.test.ts): the systems' schemas, the
// catalog, the shared declarations and helper movements, and a cell's whole
// program. String building and data only, so a test that reads the matrix's
// programs without running the matrix can build them too.

import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';

import type { Cell } from './binding_consumer_matrix.cells';

import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';

// ── The skeleton ─────────────────────────────────────────────────────────────

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};
const systemSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', tag: 'text' }, edges: { child: { target: 'person', writable: true } } },
    person: { properties: { first: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' } },
  supportsInPlaceUpdate: true,
  writableRoots: { company: { fields: { name: 'text', tag: 'text' }, resultShape: { externalId: 'text', name: 'text', tag: 'text' } } },
  createShapes: { person: { fields: { first: 'text' }, resultShape: { externalId: 'text', first: 'text' } } },
};
const sinkSchema: InstanceSchema = {
  positions: { row: { properties: { v: 'text', name: 'text', tag: 'text' }, edges: {} } },
  collections: { rows: { target: 'row' } },
  writableRoots: { row: { fields: { v: 'text', name: 'text', tag: 'text' }, resultShape: { externalId: 'text' } } },
};

const credentialArg = [{ name: 'credentials', kind: 'credential' as const, required: true }];
const fetchUrl = staticCatalogFromManifests({ credentials: {} }).plugin('fetch_url');
/** A plugin whose argument takes structured data (`json`): it is handed the
 *  record's fields all at once, and hands back the name it was given. No
 *  registered plugin takes one today; the type is the plugin contract's. */
export const SUMMARISE = 'summarise';
/** A plugin whose argument declares no type: it hands back the text it was
 *  given, or the name among the fields it was given. */
export const RELAY = 'relay';
export const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: credentialArg, schema: emailSchema },
    attio: { constructionArgs: credentialArg, schema: systemSchema },
    sheets: { constructionArgs: credentialArg, schema: sinkSchema },
  },
  credentials: { inbox_cred: { adapters: ['email'] }, crm_cred: { adapters: ['attio'] }, sheet_cred: { adapters: ['sheets'] } },
  plugins: {
    ...(fetchUrl !== undefined ? { fetch_url: fetchUrl } : {}),
    [SUMMARISE]: { args: ['data'], priced: false, argTypes: { data: 'json' }, requiredArgs: ['data'], effects: { ai: true }, output: { kind: 'value', type: 'text' } },
    [RELAY]: { args: ['data'], priced: false, requiredArgs: ['data'], effects: { ai: true }, output: { kind: 'value', type: 'text' } },
  },
});

/** The shape every record path binds. Descriptions are an extraction's
 *  prompt; version 1 had no described declarations. */
export function prelude(version: LanguageVersion): string {
  const described = version >= 2;
  const d = (text: string) => (described ? ` "${text}"` : '');
  const shape = (name: string, header: string) => [
    `node ${name}${described ? `: "${header}"` : ''} {`,
    `  name: <text>${d("the company's name")}`,
    `  tag: <text>${d('its tag')}`,
    `  node child${described ? ': "each founder"' : ''} {`,
    `    first: <text>${d('first name')}`,
    '  }',
    '}',
  ];
  return [
    'import { email, attio, sheets } from adapters',
    'import { inbox_cred, crm_cred, sheet_cred } from credentials',
    `import { ${[...(fetchUrl !== undefined ? ['fetch_url'] : []), SUMMARISE, RELAY].join(', ')} } from plugins`,
    '',
    'inbox = email(credentials: inbox_cred)',
    'src = attio(credentials: crm_cred)',
    'sink = sheets(credentials: sheet_cred)',
    ...shape('Entry', 'each company named in this message'),
    // Holds Entry-shaped records — structurally, as a declaration cannot name
    // another declared shape for a nested node.
    'node Holder {',
    '  name: <text>',
    '  node entries {',
    '    name: <text>',
    '    tag: <text>',
    '    node child {',
    '      first: <text>',
    '    }',
    '  }',
    '}',
    'movement use_entry(e: <Entry>) {',
    '  write sink-[:rows]-> { v: e.name }',
    '}',
    ...(version >= 2 ? ['movement pairs_entry(e: <Entry>) {', '  write sink-[:rows]-> { v: TEXT.PAIRS(e) }', '}'] : []),
    ...(version >= 3 ? ['movement serialise_entry(e: <Entry>) {', '  write sink-[:rows]-> { v: TEXT.SERIALISE(e, "JSON") }', '}'] : []),
    'movement child_entry(e: <Entry>) {',
    '  e-[k:child]-> {',
    '    write sink-[:rows]-> { v: k.first }',
    '  }',
    '}',
    ...(version >= 3
      ? ['movement serialise_child(e: <Entry>) {', '  e-[k:child]-> {', '    write sink-[:rows]-> { v: TEXT.SERIALISE(k, "JSON") }', '  }', '}']
      : []),
    'movement summarise_entry(e: <Entry>) {',
    `  s = ${SUMMARISE}(data: e)`,
    '  write sink-[:rows]-> { v: s }',
    '}',
  ].join('\n');
}

const SEED = [
  '  deduped = node { entries: <Entry> order by arrival }',
  '  copies = node { entries: <Entry> order by arrival }',
  '  a = write deduped-[:entries]-> { name: "Acme", tag: "a" }',
  '  write a-[:child]-> { first: "Ann" }',
  '  b = write deduped-[:entries]-> { name: "Beta", tag: "b" }',
  '  write b-[:child]-> { first: "Bob" }',
];

export function programFor(cell: Pick<Cell, 'body'>, version: LanguageVersion): string {
  return [prelude(version), 'movement run_cell(msg: <inbox-[:message]->>) {', ...SEED, ...cell.body, '}'].join('\n');
}
