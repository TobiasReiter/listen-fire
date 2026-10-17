// The run-path snapshot (what one firing checks and runs against) beside the
// editor's: the run carries only the program's import closure and hands the
// host its credential ids; the editor lists every saved file and never sees
// an id. DB / registry / adapter seams mocked.

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { listMovementRows } from '../store';
import {
  movementCatalogSnapshotForTeam,
  runCatalogSnapshotForTeam,
  type TeamCatalogSnapshot,
} from '../catalog';

jest.mock('../../../../lib/kysely', () => {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    external_service_credentials: [
      { id: 'cred-attio-1', name: 'Dev Loop Attio', type: 'ATTIO', created_at: new Date(1) },
    ],
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
    { adapterType: 'attio', requiredCredentialType: 'ATTIO' },
    { adapterType: 'email' },
  ],
  getAdapterManifest: () => ({ methods: [] }),
  indexManifestsByName: (manifests: Array<{ adapterType: string }>) =>
    new Map(manifests.map((m) => [m.adapterType, m])),
}));

jest.mock('../../adapters/remote/store', () => ({ listRemoteAdapters: async () => [] }));

jest.mock('../../adapters/resolve', () => ({ resolveAdapter: jest.fn() }));

jest.mock('../store', () => {
  const library = (name: string) =>
    [`export movement ${name}(f: <Files>) {`, '  return node { label: f.`name` }', '}'].join('\n');
  const rows = [
    { name: 'helpers', source: library('tidy'), languageVersion: 2 },
    { name: 'unrelated', source: library('other'), languageVersion: 2 },
  ];
  return {
    rows,
    getMovementRowByName: jest.fn(
      async ({ name }: { name: string }) => rows.find((r) => r.name === name) ?? null,
    ),
    listMovementRows: jest.fn(async () => rows),
  };
});

const { rows: savedRows } = jest.requireMock<{ rows: Array<{ name: string; source: string }> }>(
  '../store',
);
const LIBRARY = savedRows.find((r) => r.name === 'helpers')?.source;

const TEAM = 'team-1' as TeamId;

beforeEach(() => jest.clearAllMocks());

const PROGRAM = ['import { tidy } from "helpers"', 'movement intake(f: <Files>) {', '  y = f.`name`', '}'].join('\n');

describe('runCatalogSnapshotForTeam', () => {
  it('carries exactly the import closure, not every saved movement', async () => {
    const { snapshot } = await runCatalogSnapshotForTeam(TEAM, { source: PROGRAM });

    expect(snapshot.files).toEqual({ helpers: { source: LIBRARY } });
    expect(listMovementRows).not.toHaveBeenCalled();
  });

  it('hands the host the credential ids by import name', async () => {
    const { snapshot, credentialIds } = await runCatalogSnapshotForTeam(TEAM, { source: PROGRAM });

    expect(credentialIds).toEqual({ 'Dev Loop Attio': 'cred-attio-1' });
    expect(Object.keys(snapshot.credentials)).toEqual(['Dev Loop Attio']);
  });
});

describe('movementCatalogSnapshotForTeam (the editor form)', () => {
  it('lists every saved movement and carries no credential ids', async () => {
    const editor = await movementCatalogSnapshotForTeam(TEAM, { source: PROGRAM });

    expect(Object.keys(editor.snapshot.files ?? {}).sort()).toEqual(['helpers', 'unrelated']);
    expect('credentialIds' in editor).toBe(false);
  });

  it('has no credential-id field at the type level', () => {
    type NoIds = 'credentialIds' extends keyof TeamCatalogSnapshot ? false : true;
    const noIds: NoIds = true;
    expect(noIds).toBe(true);
  });
});
