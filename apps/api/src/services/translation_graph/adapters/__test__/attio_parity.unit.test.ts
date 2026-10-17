// Recorded parity for Attio. The fixture is the legacy adapter as it was
// before Attio became a module, driven through `parity/script.ts` against
// the fake-channels Attio: every answer, and every request it made with
// what came back. Each implementation is replayed against the recording and
// must make the same requests and give the same answers.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// ATTIO_PARITY_RECORD=1 pnpm test:unit --testPathPattern attio_parity

jest.mock('../../../../lib/credentials', () => ({
  decryptToken: async () => (await import('./crm_parity/legacy_row')).decryptSeededRow(),
  encryptToken: async () => '',
}));
jest.mock('../../../../lib/kysely', () => ({
  getAutomationsQb: () => jest.requireActual<typeof import('./crm_parity/legacy_row')>('./crm_parity/legacy_row').rowQueryBuilder(),
}));

// The platform's encrypted store, as a vault the test seeds: the module line
// reads its credential through the secrets family exactly as in production.
const vault: { current?: ReturnType<typeof import('movement-engine/public/secrets').createMemoryVault> } = {};
jest.mock('../../../credentials/secrets_postgres', () => ({
  ...jest.requireActual('../../../credentials/secrets_postgres'),
  postgresSecrets: () => {
    if (vault.current === undefined) throw new Error('no vault seeded');
    return vault.current;
  },
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { Adapter } from 'movement-engine/public/adapter';

import type { AddressInfo } from 'node:net';

import { serveModule } from 'module-kit';
import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';
import { attioModule, forgetAttioCatalogs } from '@listen-fire/attio';
import { createAttioAdapter } from '../attio';
import { getAdapter } from '../registry';
import { BUILTIN_MODULES, type BuiltinModuleLine } from '../builtin_modules';
import { recordingServer, replayingServer, type Exchange } from './parity/exchange';
import { bootFakeCrm } from './crm_parity/fake_channels';
import { legacyRow } from './crm_parity/legacy_row';
import { freezeClock, unwrappedRemoteErrors, type TranscriptEntry } from './crm_parity/walk';
import { statelessReplayingServer, statelessView } from './crm_parity/stateless_replay';
import { runAttioParityScript } from './attio_parity/script';


/** A stored row as the module line's shape reads it. */
function storedAsFields(adapterType: string, row: Record<string, string>): Record<string, string> {
  const line: BuiltinModuleLine | undefined = BUILTIN_MODULES[adapterType];
  const shape = line?.kind === 'adapter' && line.line === 'module' ? line.storedAs : undefined;
  return shape === undefined ? row : shape.toFields(row);
}

const FIXTURE = join(__dirname, '__fixtures__/attio_parity.json');
/** The stored payload the connect flow writes. */
const STORED = { accessToken: 'dev-loop-attio-token', apiTokenId: 'token-1' };

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}


let subjects = 0;
/** A team and credential of its own per subject: the legacy line caches its
 *  catalog by team and its client by credential id. */
function freshInstall(): { teamId: TeamId; credentialsId: string } {
  subjects += 1;
  return { teamId: `team-parity-${subjects}` as TeamId, credentialsId: `cred-parity-${subjects}` };
}

/** The legacy line, its credential row pointed at `baseUrl`. */
function legacySubject(baseUrl: string): Adapter {
  const install = freshInstall();
  legacyRow.payload = { ...STORED, baseUrl };
  legacyRow.id = install.credentialsId;
  return createAttioAdapter(install);
}

jest.setTimeout(120_000);
beforeAll(freezeClock);
afterAll(() => jest.useRealTimers());

const recording = process.env.ATTIO_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeCrm('attio');
  const proxy = await recordingServer(fake.baseUrl);
  try {
    const transcript = await runAttioParityScript(legacySubject(proxy.baseUrl));
    const fixture: Recording = { transcript, exchanges: proxy.exchanges() };
    writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  } finally {
    await proxy.close();
    fake.stop();
  }
});

function loadRecording(): Recording {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recording;
}

/** Replay `subjectAt` against the recording: same answers, same requests. */
async function expectAttioParity(
  subjectAt: (baseUrl: string) => Promise<Adapter> | Adapter,
  options: { stateless?: boolean } = {},
): Promise<void> {
  const recorded = loadRecording();
  const server = options.stateless === true ? await statelessReplayingServer(recorded.exchanges) : await replayingServer(recorded.exchanges);
  // Attio's catalogue caches are process-wide, keyed by Attio's own ids: each
  // subject starts cold, as the recording did.
  forgetAttioCatalogs();
  try {
    const transcript = await runAttioParityScript(await subjectAt(server.baseUrl));
    expect(unwrappedRemoteErrors(transcript)).toEqual(recorded.transcript);
    const recordedRequests = recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request);
    if (options.stateless === true) {
      expect(statelessView(server.requests())).toEqual(statelessView(recordedRequests));
    } else {
      expect(server.requests()).toEqual(recordedRequests);
    }
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('attio recorded parity', () => {
  it('the recording walks the whole surface, writes, and fails nowhere', () => {
    const { transcript, exchanges } = loadRecording();
    const errors = transcript.filter((entry) => {
      const answer = entry.answer;
      return answer !== null && typeof answer === 'object' && 'error' in answer;
    });
    expect(errors).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(15);
  });

  it('the legacy line replays identically', async () => {
    await expectAttioParity(legacySubject);
  });

  it('the module in process, through the platform registry, replays identically', async () => {
    expect(BUILTIN_MODULES.attio?.line).toBe('module');
    await expectAttioParity((baseUrl) => {
      const install = freshInstall();
      // The vault stands for the store after the line's shape has read the row.
      vault.current = createMemoryVault({ [install.credentialsId]: storedAsFields('attio', { ...STORED, baseUrl }) });
      return getAdapter({ adapterType: 'attio', ...install });
    });
  });

  it('the module served over protocol 2 gives the same answers and writes (built per request, it re-reads the catalogue)', async () => {
    const served = await serveModule({ definition: attioModule });
    const { port } = served.server.address() as AddressInfo;
    try {
      await expectAttioParity(async (baseUrl) => {
        const install = freshInstall();
        // A host that stores the protocol's own token fields (lf, an embedder).
        const credentials = createMemoryVault({ [install.credentialsId]: { access_token: STORED.accessToken, apiTokenId: STORED.apiTokenId, baseUrl } });
        const config = { adapterType: 'attio', ...install, baseUrl: `http://127.0.0.1:${port}/`, authStrategy: { kind: 'bearer' as const } };
        return createRemoteAdapter({
          config,
          secret: '',
          cacheScopeId: install.credentialsId,
          manifest: await fetchRemoteManifest(config, ''),
          documents: { put: async () => ({}) } as never,
          credential: { name: 'attio', secrets: createSecretsFamily({ backend: credentials }), ref: install.credentialsId },
        });
      }, { stateless: true });
    } finally {
      served.server.close();
    }
  });
});
