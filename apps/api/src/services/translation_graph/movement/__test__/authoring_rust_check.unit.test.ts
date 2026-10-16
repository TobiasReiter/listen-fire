// Validation of a movement pinned to a version that runs on the Rust engine
// (5 on) is the Rust checker's, against the snapshot its run checks against:
// the diagnostics an author sees are the ones the run enforces. Versions 1–4
// keep the TypeScript checker. The two report the same diagnostics (the
// parity corpus, crates/movement-checker/PARITY.md); here a few programs,
// clean and refused, are compared through the authoring surface itself.

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('movement-engine/services/knowledge_pipeline/output_v3/schemas');

const checkers = { rust: 0, typescript: 0 };

jest.mock('movement-lang', () => {
  const actual = jest.requireActual('movement-lang');
  return {
    ...actual,
    checkSourceInRust: (...args: unknown[]) => {
      checkers.rust += 1;
      return actual.checkSourceInRust(...args);
    },
    checkProgram: (...args: unknown[]) => {
      checkers.typescript += 1;
      return actual.checkProgram(...args);
    },
  };
});

jest.mock('../catalog', () => ({ movementCatalogForTeam: jest.fn() }));

import { fromCatalogSnapshot, mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';

import { diagnoseMovementSource, validateMovementForTeam } from '../authoring';
import { movementCatalogForTeam } from '../catalog';

const crmSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text', stage: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: { company: { fields: { name: 'text', stage: 'text' }, resultShape: { externalId: 'text', name: 'text', stage: 'text' } } },
};
const emailSchema: InstanceSchema = { positions: { message: { properties: { subject: 'text' }, edges: {} } }, collections: {}, writableRoots: {} };

const snapshot = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema },
  },
  credentials: { inbox_cred: { adapters: ['email'] }, crm_cred: { adapters: ['attio'] } },
});
const catalog = fromCatalogSnapshot(snapshot);

const PRELUDE = `import { email, attio } from adapters
import { inbox_cred, crm_cred } from credentials
inbox = email(credentials: inbox_cred)
crm   = attio(credentials: crm_cred)
`;

// Written in the spelling versions 1–4 read; a version-5 check reads each as
// the upgrade tool rewrites it.
const programs: Record<string, string> = {
  clean: `${PRELUDE}movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> { name: msg.\`subject\`, stage: "Lead" }
}
listen to inbox fire m
`,
  'an unknown field': `${PRELUDE}movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> { nam: msg.\`subject\` }
}
`,
  'an unresolved name': `${PRELUDE}movement m(msg: <inbox-[:message]->>) {
  return nowhere
}
`,
  'an unknown credential': `import { email } from adapters
import { nobody } from credentials
inbox = email(credentials: nobody)
movement m(msg: <inbox-[:message]->>) {
  return 1
}
`,
};

function diagnose(source: string, languageVersion: LanguageVersion, withSnapshot: boolean) {
  checkers.rust = 0;
  checkers.typescript = 0;
  const validation = diagnoseMovementSource(source, { catalog, languageVersion, ...(withSnapshot ? { snapshot } : {}) });
  return { validation, checkers: { ...checkers } };
}

describe('validation by the checker the run is held to', () => {
  for (const [name, source] of Object.entries(programs)) {
    it(`reports the TypeScript checker's diagnostics from the Rust checker on version 5: ${name}`, () => {
      const rust = diagnose(spelledFor(5, source, catalog), 5, true);
      const ts = diagnose(spelledFor(5, source, catalog), 5, false);
      expect(rust.checkers).toEqual({ rust: 1, typescript: 0 });
      expect(ts.checkers).toEqual({ rust: 0, typescript: 1 });
      expect(rust.validation).toEqual(ts.validation);
      expect(rust.validation.ok).toBe(name === 'clean');
    });
  }

  it('keeps the TypeScript checker for version 4, the snapshot in hand', () => {
    const { validation, checkers: used } = diagnose(programs['an unknown field'] ?? '', 4, true);
    expect(used).toEqual({ rust: 0, typescript: 1 });
    expect(validation.ok).toBe(false);
  });

  it('validates a team movement against the run snapshot of the same assembly', async () => {
    (movementCatalogForTeam as jest.Mock).mockResolvedValueOnce({
      catalog,
      resolveCredentialId: () => undefined,
      credentialsByName: {},
      resolveFile: () => undefined,
      notes: [],
      positionArgOptions: {},
      instanceSchemas: [],
      gaps: [],
      runSnapshot: () => snapshot,
    });
    checkers.rust = 0;
    checkers.typescript = 0;
    const validation = await validateMovementForTeam({ teamId: 'team-1', source: programs['an unresolved name'] ?? '' });
    expect(checkers).toEqual({ rust: 1, typescript: 0 });
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics.map((d) => d.code)).toContain('MOV_NAME_UNRESOLVED');
  });
});
