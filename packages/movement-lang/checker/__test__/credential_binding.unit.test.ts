// A connection's credential must belong to the module it connects, and fill
// one of the credentials that module declares — refused at check, never sent
// to the wrong module. The Rust checker's twin is
// crates/movement-checker/tests/credential_binding.rs; here both checkers are
// also held to each other's exact diagnostics.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { checkSourceInRust } from '../rust_checker';
import { fromCatalogSnapshot, type CatalogSnapshot } from '../../service/snapshot';

const credentialArg = [{ name: 'credentials', kind: 'credential' as const, required: true }];

const SNAPSHOT: CatalogSnapshot = {
  adapters: {
    hubspot: { canFire: true, declaredCredentials: ['oauth'], constructionArgs: credentialArg, schemas: {} },
    attio: { canFire: true, constructionArgs: credentialArg, schemas: {} },
  },
  credentials: {
    alice_hubspot: { adapters: ['hubspot'], credential: 'oauth' },
    bob_hubspot: { adapters: ['hubspot'], credential: 'oauth' },
    old_hubspot_key: { adapters: ['hubspot'], credential: 'api_key' },
    acme_attio: { adapters: ['attio'] },
  },
  plugins: {},
};

const sourceOf = (using: string, adapter: string): string =>
  `import { \`@lf/${adapter}\` as ${adapter} } from adapters\nimport { ${using} } from credentials\nhs = connect ${adapter} using ${using}\n`;

function both(source: string): Diagnostic[] {
  const ts = checkProgram(parseProgram(source, { languageVersion: 5 }), fromCatalogSnapshot(SNAPSHOT), { languageVersion: 5 });
  const rust = checkSourceInRust(source, SNAPSHOT, { languageVersion: 5 });
  expect({ source, diagnostics: rust }).toEqual({ source, diagnostics: ts });
  return ts.filter((d) => d.code === 'MOV_CRED_WRONG_ADAPTER');
}

describe('a connection names a credential of its own module', () => {
  it('is clean for a credential of the module filling a declared credential', () => {
    expect(both(sourceOf('alice_hubspot', 'hubspot'))).toEqual([]);
    expect(both(sourceOf('bob_hubspot', 'hubspot'))).toEqual([]);
    expect(both(sourceOf('acme_attio', 'attio'))).toEqual([]);
  });

  it("refuses another module's credential", () => {
    expect(both(sourceOf('alice_hubspot', 'attio')).map((d) => d.message)).toEqual([
      "'alice_hubspot' is a hubspot credential — 'attio' needs a attio credential",
    ]);
  });

  it('refuses a credential for a declaration the module does not have', () => {
    expect(both(sourceOf('old_hubspot_key', 'hubspot')).map((d) => d.message)).toEqual([
      "'old_hubspot_key' is hubspot's 'api_key' credential, which 'hubspot' does not declare — connect it using a 'oauth' credential of hubspot",
    ]);
  });
});
