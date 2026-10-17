// Recorded parity for Airtable. The fixture is the legacy adapter as it was
// before Airtable became a module, driven through `parity/script.ts` against
// the fake-channels Airtable: every answer, and every request it made with
// what came back. Each implementation is replayed against the recording and
// must make the same requests and give the same answers.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// AIRTABLE_PARITY_RECORD=1 pnpm test:unit --testPathPattern airtable_parity

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => (await import('../../__test__/crm_parity/legacy_row')).decryptSeededRow(),
  encryptToken: async () => '',
}));
jest.mock('../../../../../lib/kysely', () => ({
  getAutomationsQb: () => jest.requireActual<typeof import('../../__test__/crm_parity/legacy_row')>('../../__test__/crm_parity/legacy_row').rowQueryBuilder(),
}));

// The platform's encrypted store, as a vault the test seeds: the module line
// reads its credential through the secrets family exactly as in production.
const vault: { current?: ReturnType<typeof import('movement-engine/public/secrets').createMemoryVault> } = {};
jest.mock('../../../../credentials/secrets_postgres', () => ({
  postgresSecrets: () => {
    if (vault.current === undefined) throw new Error('no vault seeded');
    return vault.current;
  },
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Adapter } from 'movement-engine/public/adapter';

import type { AddressInfo } from 'node:net';

import { serveModule } from 'module-kit';
import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';
import { airtableModule } from '@lf/airtable';
import { createAirtableAdapter } from '..';
import { getAdapter } from '../../registry';
import { BUILTIN_MODULES } from '../../builtin_modules';
import { recordingServer, replayingServer, type Exchange } from '../../dealroom/__test__/parity/exchange';
import { bootFakeCrm } from '../../__test__/crm_parity/fake_channels';
import { legacyRow } from '../../__test__/crm_parity/legacy_row';
import { freezeClock, unwrappedRemoteErrors, type TranscriptEntry } from '../../__test__/crm_parity/walk';
import { runAirtableParityScript, type InjectChange } from './parity/script';

const FIXTURE = join(__dirname, '__fixtures__/airtable_parity.json');
/** The stored payload the connect flow writes, unexpired at the frozen clock. */
const STORED = {
  accessToken: 'dev-loop-airtable-token',
  refreshToken: 'dev-loop-airtable-refresh',
  accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
  refreshTokenExpiresAt: '2030-06-01T00:00:00.000Z',
};

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

interface Subject {
  adapter: Adapter;
  /** Absent for a subject that cannot be scoped to a base. */
  scoped?: Adapter;
}

let subjects = 0;
/** A team and credential of its own per subject: the legacy line caches its
 *  catalog by team and its client by credential id. */
function freshInstall(): { teamId: TeamId; credentialsId: string } {
  subjects += 1;
  return { teamId: `team-parity-${subjects}` as TeamId, credentialsId: `cred-parity-${subjects}` };
}

/** The legacy line, its credential row pointed at `baseUrl`. */
function legacySubject(baseUrl: string): Subject {
  const install = freshInstall();
  legacyRow.payload = { ...STORED, baseUrl };
  legacyRow.id = install.credentialsId;
  return { adapter: createAirtableAdapter(install), scoped: createAirtableAdapter({ ...install, base: 'Pipeline Tracker' }) };
}

jest.setTimeout(120_000);
beforeAll(freezeClock);
afterAll(() => jest.useRealTimers());

const recording = process.env.AIRTABLE_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeCrm('airtable');
  const proxy = await recordingServer(fake.baseUrl);
  const inject: InjectChange = async ({ webhookId, body }) => {
    const answer = await fetch(`${fake.baseUrl}/v0/bases/appTEST001/webhooks/${webhookId}/payloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!answer.ok) throw new Error(`inject: ${answer.status} ${await answer.text()}`);
  };
  try {
    const { adapter, scoped } = legacySubject(proxy.baseUrl);
    const transcript = await runAirtableParityScript(adapter, scoped, inject);
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

const requestKey = (request: object): string => JSON.stringify(request);

/** Replay `subjectAt` against the recording: same answers, same requests. A
 *  subject with no scoped instance skips the scoped steps, so it is held to
 *  the rest: the same answers step for step, and only recorded requests. */
async function expectAirtableParity(subjectAt: (baseUrl: string) => Promise<Subject> | Subject): Promise<void> {
  const recorded = loadRecording();
  const server = await replayingServer(recorded.exchanges);
  try {
    const { adapter, scoped } = await subjectAt(server.baseUrl);
    const transcript = unwrappedRemoteErrors(await runAirtableParityScript(adapter, scoped));
    const recordedRequests = recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request);
    if (scoped !== undefined) {
      expect(transcript).toEqual(recorded.transcript);
      expect(server.requests()).toEqual(recordedRequests);
      return;
    }
    const unscopedSteps = recorded.transcript.filter(
      (entry) => !entry.step.startsWith('scoped ') && !entry.step.startsWith('Companies[0].') && !entry.step.startsWith('Contacts[0]'),
    );
    expect(transcript).toEqual(unscopedSteps);
    const remaining = recordedRequests.map(requestKey);
    for (const request of server.requests()) {
      const at = remaining.indexOf(requestKey(request));
      expect(at).toBeGreaterThanOrEqual(0);
      remaining.splice(at, 1);
    }
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('airtable recorded parity', () => {
  it('the recording walks the whole surface, writes, pulls a ping, and fails nowhere', () => {
    const { transcript, exchanges } = loadRecording();
    const errors = transcript.filter((entry) => {
      const answer = entry.answer;
      return answer !== null && typeof answer === 'object' && 'error' in answer;
    });
    expect(errors).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(15);
    const ping = transcript.find((entry) => entry.step === 'preprocessInbound ping')?.answer as { events: unknown[] } | undefined;
    expect(ping?.events.length).toBeGreaterThan(0);
  });

  it('the legacy line replays identically', async () => {
    await expectAirtableParity(legacySubject);
  });

  it('the module in process, through the platform registry, replays identically', async () => {
    expect(BUILTIN_MODULES.airtable?.line).toBe('module');
    await expectAirtableParity((baseUrl) => {
      const install = freshInstall();
      vault.current = createMemoryVault({ [install.credentialsId]: { ...STORED, baseUrl } });
      return {
        adapter: getAdapter({ adapterType: 'airtable', ...install }),
        scoped: getAdapter({ adapterType: 'airtable', ...install, constructionArgs: { base: 'Pipeline Tracker' } }),
      };
    });
  });

  it('the module served over protocol 2 replays identically (unscoped: protocol 2 carries no construction arguments)', async () => {
    const served = await serveModule({ definition: airtableModule });
    const { port } = served.server.address() as AddressInfo;
    try {
      await expectAirtableParity(async (baseUrl) => {
        const install = freshInstall();
        // A host that stores the protocol's own token fields (lf, an embedder).
        const credentials = createMemoryVault({ [install.credentialsId]: { access_token: STORED.accessToken, refresh_token: STORED.refreshToken, baseUrl } });
        const remoteAt = async () => {
          const config = { adapterType: 'airtable', ...install, baseUrl: `http://127.0.0.1:${port}/`, authStrategy: { kind: 'bearer' as const } };
          return createRemoteAdapter({
            config,
            secret: '',
            cacheScopeId: install.credentialsId,
            manifest: await fetchRemoteManifest(config, ''),
            documents: { put: async () => ({}) } as never,
            credential: { name: 'airtable', secrets: createSecretsFamily({ backend: credentials }), ref: install.credentialsId },
          });
        };
        // Protocol 2 carries no construction arguments, so a remote Airtable
        // cannot be scoped to a base: the scoped steps are skipped.
        return { adapter: await remoteAt() };
      });
    } finally {
      served.server.close();
    }
  });
});
