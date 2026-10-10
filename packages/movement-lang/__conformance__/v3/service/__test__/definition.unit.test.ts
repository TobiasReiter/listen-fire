// getDefinition — cmd-click navigation targets. The `¦` marker is the
// cursor. Two resolution layers under one entry point:
//   - import-line tokens resolve lexically (originals, aliases, the
//     quoted file path) — no snapshot needed;
//   - use sites resolve through the analysis scope (an imported name
//     anywhere in the body targets its source).
// Locally-declared names (instances, params, in-file movements) have no
// external definition and return undefined.

import type { CatalogSnapshot } from '../snapshot';
import { getDefinition, type DefinitionTarget } from '../service';

const snapshot: CatalogSnapshot = {
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: {
        dealflow_inbox: {
          positions: {
            message: { properties: { subject: 'text', text: 'text' }, edges: {} },
          },
          collections: { messages: { target: 'message' } },
          writableRoots: {},
        },
      },
    },
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: {
        acme_main: {
          positions: { company: { properties: { name: 'text' }, edges: {} } },
          collections: { companies: { target: 'company' } },
          writableRoots: {
            company: { fields: { name: 'text' }, resultShape: { externalId: 'text' } },
          },
        },
      },
    },
  },
  credentials: {
    dealflow_inbox: { adapter: 'email' },
    acme_main: { adapter: 'attio' },
  },
  plugins: {
    scrub_sensitive: { args: [] },
  },
  files: {
    'lib/intake': {
      source: [
        'import { attio } from adapters',
        'import { acme_main } from credentials',
        '',
        'crm = attio(credentials: acme_main)',
        '',
        'node Lead {',
        '  name: <text>',
        '}',
        '',
        'movement log_lead(l: <Lead>) {',
        '  write crm-[:companies]-> { name: l.`name` }',
        '}',
      ].join('\n'),
    },
  },
};

function definitionAt(text: string, withSnapshot = true): DefinitionTarget | undefined {
  const offset = text.indexOf('¦');
  if (offset === -1) throw new Error('no caret in fixture');
  const source = text.slice(0, offset) + text.slice(offset + 1);
  return getDefinition(source, offset, withSnapshot ? snapshot : undefined);
}

const BODY = `
inbox = email(credentials: dealflow_inbox)
crm = attio(credentials: acme_main)

movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: msg.\`subject\`
  }
}

listen to inbox fire intake
`;

describe('getDefinition — import-line tokens', () => {
  it('an adapter name in the braces targets the adapters page', () => {
    expect(
      definitionAt(`import { em¦ail, attio } from adapters\n${BODY}`),
    ).toEqual({ kind: 'adapters', name: 'email' });
  });

  it('a credential name targets the credentials page', () => {
    expect(
      definitionAt(
        `import { email, attio } from adapters\nimport { acme¦_main, dealflow_inbox } from credentials\n${BODY}`,
      ),
    ).toEqual({ kind: 'credentials', name: 'acme_main' });
  });

  it('a plugin name targets the plugins page', () => {
    expect(definitionAt('import { scrub_s¦ensitive } from plugins\n')).toEqual({
      kind: 'plugins',
      name: 'scrub_sensitive',
    });
  });

  it('an aliased import: the ORIGINAL token targets the original name', () => {
    expect(definitionAt('import { att¦io as crm_type } from adapters\n')).toEqual({
      kind: 'adapters',
      name: 'attio',
    });
  });

  it('an aliased import: the ALIAS token also targets the original name', () => {
    expect(definitionAt('import { attio as crm_¦type } from adapters\n')).toEqual({
      kind: 'adapters',
      name: 'attio',
    });
  });

  it('a name imported from a file targets that file', () => {
    expect(definitionAt('import { log_¦lead } from "lib/intake"\n')).toEqual({
      kind: 'file',
      name: 'lib/intake',
    });
  });

  it('the quoted file path itself targets the file', () => {
    expect(definitionAt('import { log_lead } from "lib/in¦take"\n')).toEqual({
      kind: 'file',
      name: 'lib/intake',
    });
  });

  it('import keywords and whitespace are not targets', () => {
    expect(definitionAt('imp¦ort { email } from adapters\n')).toBeUndefined();
    expect(definitionAt('import { email } fr¦om adapters\n')).toBeUndefined();
    expect(definitionAt('import { email,¦ attio } from adapters\n')).toBeUndefined();
  });

  it('import-line resolution needs no snapshot', () => {
    expect(definitionAt('import { em¦ail } from adapters\n', false)).toEqual({
      kind: 'adapters',
      name: 'email',
    });
    expect(definitionAt('import { log_lead } from "lib/in¦take"\n', false)).toEqual({
      kind: 'file',
      name: 'lib/intake',
    });
  });
});

const HEADER = `import { email, attio } from adapters
import { dealflow_inbox, acme_main } from credentials`;

describe('getDefinition — imported names at use sites', () => {
  it('an adapter type at its construction call', () => {
    expect(
      definitionAt(`${HEADER}\ninbox = em¦ail(credentials: dealflow_inbox)\n`),
    ).toEqual({ kind: 'adapters', name: 'email' });
  });

  it('a credential in a construction argument', () => {
    expect(
      definitionAt(`${HEADER}\ninbox = email(credentials: dealflow_¦inbox)\n`),
    ).toEqual({ kind: 'credentials', name: 'dealflow_inbox' });
  });

  it('an ALIASED adapter at a use site resolves to the original name', () => {
    expect(
      definitionAt(
        `import { attio as crm_type } from adapters\nimport { acme_main } from credentials\ncrm = crm_¦type(credentials: acme_main)\n`,
      ),
    ).toEqual({ kind: 'adapters', name: 'attio' });
  });

  it('a plugin inside through […]', () => {
    const source = [
      'import { email } from adapters',
      'import { dealflow_inbox } from credentials',
      'import { scrub_sensitive } from plugins',
      '',
      'inbox = email(credentials: dealflow_inbox)',
      '',
      'movement intake(msg: <inbox-[:message]->>) {',
      '  summary = extract from [msg.`text`] through [scrub_s¦ensitive] {',
      '    sentiment: "the overall sentiment"',
      '  }',
      '}',
    ].join('\n');
    expect(definitionAt(source)).toEqual({ kind: 'plugins', name: 'scrub_sensitive' });
  });

  it('a file-imported movement at its call site targets the file', () => {
    const source = [
      'import { email } from adapters',
      'import { dealflow_inbox } from credentials',
      'import { log_lead } from "lib/intake"',
      '',
      'inbox = email(credentials: dealflow_inbox)',
      '',
      'movement intake(msg: <inbox-[:message]->>) {',
      '  log_¦lead(l: msg)',
      '}',
    ].join('\n');
    expect(definitionAt(source)).toEqual({ kind: 'file', name: 'lib/intake' });
  });
});

describe('getDefinition — locally-declared names are not targets', () => {
  it('a constructed instance', () => {
    expect(definitionAt(`${HEADER}\nin¦box = email(credentials: dealflow_inbox)\n`)).toBeUndefined();
    expect(
      definitionAt(
        `${HEADER}\ninbox = email(credentials: dealflow_inbox)\nlisten to in¦box fire intake\n`,
      ),
    ).toBeUndefined();
  });

  it('a movement parameter at a read', () => {
    expect(
      definitionAt(
        `${HEADER}${BODY.replace('msg.`subject`', 'm¦sg.`subject`')}`,
      ),
    ).toBeUndefined();
  });

  it('an in-file movement name', () => {
    expect(
      definitionAt(`${HEADER}${BODY.replace('fire intake', 'fire inta¦ke')}`),
    ).toBeUndefined();
  });

  it('keywords and blank space', () => {
    expect(definitionAt(`${HEADER}${BODY.replace('write crm', 'wri¦te crm')}`)).toBeUndefined();
  });
});
