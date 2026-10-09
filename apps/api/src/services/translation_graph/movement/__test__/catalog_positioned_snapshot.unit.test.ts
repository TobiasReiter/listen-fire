// The source-aware snapshot: what the EDITOR checks against.
//
// The editor could only ever ask about an (adapter, credential) pair, so a
// construction that pinned an entry position — `sheets(…, spreadsheet: "LP
// Commitments")` — was introspected UNPOSITIONED. For a container-shaped
// adapter the unpositioned node deliberately publishes no leaves (which tab or
// table exists depends on WHICH spreadsheet), so the editor reported a correct
// program's own table as an unknown edge while `save` compiled it fine.
//
// These pin the two halves of the fix together: the snapshot must CARRY the
// positioned schema, and it must carry it under the key the checker looks it up
// by. Either half alone still gives the editor nothing.

import { fromCatalogSnapshot } from 'movement-lang';

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { resolveAdapter } from '../../adapters/resolve';
import { clearIntrospectionCache } from '../instance_cache';
import { movementCatalogSnapshotForTeam } from '../catalog';

jest.mock('../../../../lib/kysely', () => {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    external_service_credentials: [
      { id: 'cred-sheets-1', name: 'Sheets Probe', type: 'GOOGLE', created_at: new Date(1) },
    ],
    node_type: [],
    property_type: [],
    edge_type: [],
    remote_adapter: [],
  };
  function builder(table: string) {
    const api = {
      where: () => api,
      select: () => api,
      selectAll: () => api,
      orderBy: () => api,
      execute: async () => tables[table] ?? [],
    };
    return api;
  }
  return {
    getQb: () => ({ selectFrom: builder }),
    getCoreQb: () => ({ selectFrom: builder }),
    getKnowledgeQb: () => ({ selectFrom: builder }),
    getAutomationsQb: () => ({ selectFrom: builder }),
  };
});

jest.mock('../../adapters/registry', () => ({
  listAdapterManifests: () => [
    {
      adapterType: 'google_sheets',
      displayName: 'Google Sheets',
      requiredCredentialType: 'GOOGLE',
      methods: ['listEntryPoints', 'describe', 'createRecord'],
      introspectedSchema: true,
      // The entry-position arg. This is what the editor had no way to send.
      positionArgs: [{ name: 'spreadsheet', optionsFrom: 'Spreadsheet', label: 'Spreadsheet' }],
    },
  ],
  getAdapterManifest: () => ({ methods: [] }),
  indexManifestsByName: (manifests: Array<{ adapterType: string; aliases?: string[] }>) => {
    const index = new Map<string, unknown>();
    for (const manifest of manifests) {
      index.set(manifest.adapterType, manifest);
      for (const alias of manifest.aliases ?? []) index.set(alias, manifest);
    }
    return index;
  },
}));

jest.mock('../../adapters/knowledge_graph', () => ({ KG_ADAPTER_TYPE: 'knowledge_graph' }));
jest.mock('../../engine/transforms/register-bundled', () => ({
  registerBundledTransforms: () => {},
}));
jest.mock('../../engine/transforms/registry', () => ({
  getTransform: () => undefined,
  listTransforms: () => [],
}));
jest.mock('../../adapters/resolve', () => ({ resolveAdapter: jest.fn() }));

const resolveAdapterMock = resolveAdapter as jest.Mock;

const TEAM = 'team-1' as TeamId;

/**
 * A container-shaped adapter, the shape that makes this bug possible: the
 * UNPOSITIONED root publishes only the container collection, and the leaves
 * exist only once an instance is started at one container.
 */
function fakeSheets({ spreadsheet }: { spreadsheet?: string }) {
  const leaves =
    spreadsheet === 'LP Commitments'
      ? [{ typeId: 'LPs (table)', displayName: 'LPs (table)', writable: true, readable: true }]
      : spreadsheet === 'Board Pack'
        ? [{ typeId: 'Costs (table)', displayName: 'Costs (table)', writable: true, readable: true }]
        : [];
  return {
    listEntryPoints: async () =>
      spreadsheet !== undefined
        ? leaves
        : [{ typeId: 'Spreadsheet', displayName: 'Spreadsheet', writable: true, readable: true }],
    describe: async (typeId: string) => ({
      typeId,
      displayName: typeId,
      fields: [
        { fieldId: 'LP Name', displayName: 'LP Name', kind: 'string', writable: true, required: false },
      ],
      references: [],
    }),
  };
}

beforeEach(() => {
  clearIntrospectionCache();
  resolveAdapterMock.mockReset();
  resolveAdapterMock.mockImplementation(async ({ constructionArgs }) =>
    fakeSheets({ spreadsheet: constructionArgs?.spreadsheet }),
  );
});

const POSITIONED_SOURCE = `
import { google_sheets } from adapters
import { \`Sheets Probe\` } from credentials

sheets = google_sheets(credentials: \`Sheets Probe\`, spreadsheet: "LP Commitments")

movement m() {
  write sheets-[:\`LPs (table)\`]-> {
    \`LP Name\`: "Acme"
  }
}
`;

describe('movementCatalogSnapshotForTeam — the skeleton (no source)', () => {
  it('introspects NOTHING and carries no schemas', async () => {
    const { snapshot } = await movementCatalogSnapshotForTeam(TEAM);
    expect(resolveAdapterMock).not.toHaveBeenCalled();
    expect(snapshot.adapters.google_sheets.schemas).toEqual({});
  });
});

describe('movementCatalogSnapshotForTeam — typed for one program', () => {
  it('carries the POSITIONED instance schema, reachable by the construction that pinned it', async () => {
    // The whole regression in one assertion: check the snapshot the way the
    // EDITOR does — rebuild a Catalog and instantiate the construction as
    // written. Asserting on the raw `schemas` keys instead would pass even if
    // the checker could never find them.
    const { snapshot } = await movementCatalogSnapshotForTeam(TEAM, { source: POSITIONED_SOURCE });
    const schema = fromCatalogSnapshot(snapshot).instantiate('google_sheets', {
      credentials: 'Sheets Probe',
      spreadsheet: '"LP Commitments"',
    });
    expect(Object.keys(schema?.collections ?? {})).toContain('LPs (table)');
  });

  it('keeps two positions of ONE credential apart', async () => {
    const source = `
import { google_sheets } from adapters
import { \`Sheets Probe\` } from credentials

lps   = google_sheets(credentials: \`Sheets Probe\`, spreadsheet: "LP Commitments")
board = google_sheets(credentials: \`Sheets Probe\`, spreadsheet: "Board Pack")

movement m() {
  write lps-[:\`LPs (table)\`]-> { \`LP Name\`: "Acme" }
  write board-[:\`Costs (table)\`]-> { \`LP Name\`: "Rent" }
}
`;
    const { snapshot } = await movementCatalogSnapshotForTeam(TEAM, { source });
    const catalog = fromCatalogSnapshot(snapshot);
    const at = (spreadsheet: string) =>
      Object.keys(
        catalog.instantiate('google_sheets', {
          credentials: 'Sheets Probe',
          spreadsheet: `"${spreadsheet}"`,
        })?.collections ?? {},
      );
    // One instance's leaves must never answer for another's — the failure mode
    // a credential-only key produces is that the second construction silently
    // reads the first's surface.
    expect(at('LP Commitments')).toContain('LPs (table)');
    expect(at('LP Commitments')).not.toContain('Costs (table)');
    expect(at('Board Pack')).toContain('Costs (table)');
    expect(at('Board Pack')).not.toContain('LPs (table)');
  });

  it('still types a BARE construction against the unpositioned surface', async () => {
    const source = `
import { google_sheets } from adapters
import { \`Sheets Probe\` } from credentials

sheets = google_sheets(credentials: \`Sheets Probe\`)

movement m() {
  write sheets-[:Spreadsheet]-> { \`LP Name\`: "Acme" }
}
`;
    const { snapshot } = await movementCatalogSnapshotForTeam(TEAM, { source });
    const schema = fromCatalogSnapshot(snapshot).instantiate('google_sheets', {
      credentials: 'Sheets Probe',
    });
    expect(Object.keys(schema?.collections ?? {})).toContain('Spreadsheet');
  });
});
