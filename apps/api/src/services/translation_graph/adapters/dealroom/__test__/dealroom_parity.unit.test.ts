// Recorded parity for Dealroom. The fixture is the legacy adapter as it was
// before Dealroom became a module (commit ced5f2a4), driven through
// `parity/script.ts` against the fake-channels Dealroom: every answer, and
// every request it made with what came back. Each implementation is replayed
// against the recording and must make the same requests (its writes) and give
// the same answers: the legacy line, the module in process as the platform
// loads it, and the module served as a process (serve-module) and called over
// adapter protocol 2.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// DEALROOM_PARITY_RECORD=1 pnpm test:unit --testPathPattern dealroom_parity

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

// The platform's encrypted store, as a vault the test seeds: the module line
// reads its credential through the secrets family exactly as in production.
const vault: { current?: ReturnType<typeof import('movement-engine/public/secrets').createMemoryVault> } = {};
jest.mock('../../../../credentials/secrets_postgres', () => ({
  ...jest.requireActual('../../../../credentials/secrets_postgres'),
  postgresSecrets: () => {
    if (vault.current === undefined) throw new Error('no vault seeded');
    return vault.current;
  },
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';
import { getAdapter, getPollSource } from '../../registry';
import { BUILTIN_MODULES } from '../../builtin_modules';
import { DealroomApiClient, DealroomAdapter, pollDealroom } from '@listen-fire/dealroom';
import { logger } from 'movement-engine/public/log';
import { recordingServer, replayingServer, type Exchange } from '../../__test__/parity/exchange';
import { bootFakeDealroom } from './parity/fake_dealroom';
import { runParityScript, type ParitySubject, type TranscriptEntry } from './parity/script';

const FIXTURE = join(__dirname, '__fixtures__/dealroom_parity.json');
const API_KEY = 'dev-loop-dealroom-key';
const TEAM = 'team-parity' as TeamId;

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

/** The legacy line's adapter and poll, on a client pointed at `baseUrl` (its
 *  credential path, the decrypted row, is the one thing replaced). */
function legacySubject(baseUrl: string): ParitySubject {
  const client = new DealroomApiClient({ apiKey: API_KEY, baseUrl, fetch, log: logger });
  return {
    adapter: new DealroomAdapter(async () => client),
    poll: (input) => pollDealroom(client, input),
  };
}

jest.setTimeout(120_000);

const recording = process.env.DEALROOM_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeDealroom();
  const proxy = await recordingServer(fake.baseUrl);
  try {
    const transcript = await runParityScript(legacySubject(proxy.baseUrl));
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
async function expectParity(subjectAt: (baseUrl: string) => Promise<ParitySubject> | ParitySubject): Promise<void> {
  const recorded = loadRecording();
  const server = await replayingServer(recorded.exchanges);
  try {
    const transcript = await runParityScript(await subjectAt(server.baseUrl));
    expect(transcript).toEqual(recorded.transcript);
    expect(server.requests()).toEqual(recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request));
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('dealroom recorded parity', () => {
  it('the recording walks the whole surface and fails nowhere it should not', () => {
    const { transcript, exchanges } = loadRecording();
    const errors = transcript.filter((entry) => {
      const answer = entry.answer;
      return answer !== null && typeof answer === 'object' && 'error' in answer;
    });
    expect(errors).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(20);
    expect(transcript.find((e) => e.step === 'poll from a checkpoint')?.answer).toMatchObject({ events: expect.arrayContaining([expect.anything()]) });
  });

  it('the legacy line replays identically', async () => {
    await expectParity(legacySubject);
  });

  it('the module in process, through the platform registry, replays identically', async () => {
    expect(BUILTIN_MODULES.dealroom?.line).toBe('module');
    await expectParity((baseUrl) => {
      vault.current = createMemoryVault({ 'cred-parity': { apiKey: API_KEY, baseUrl } });
      const install = { adapterType: 'dealroom', teamId: TEAM, credentialsId: 'cred-parity' };
      const source = getPollSource(install);
      if (source === null) throw new Error('dealroom has no poll source');
      return { adapter: getAdapter(install), poll: (input) => source.getEvents(input) };
    });
  });

  it('the module served as a process, over protocol 2, replays identically', async () => {
    const served = await serveDealroom();
    try {
      await expectParity(async (baseUrl) => {
        const credentials = createMemoryVault({ 'cred-parity': { apiKey: API_KEY, baseUrl } });
        const config = { adapterType: 'dealroom', teamId: TEAM, baseUrl: served.url, authStrategy: { kind: 'bearer' as const }, credentialsId: 'cred-parity' };
        const remote = createRemoteAdapter({
          config,
          secret: '',
          cacheScopeId: 'parity',
          manifest: await fetchRemoteManifest(config, ''),
          documents: { put: async () => ({}) } as never,
          credential: { name: 'dealroom', secrets: createSecretsFamily({ backend: credentials }), ref: 'cred-parity' },
        });
        return { adapter: remote, poll: (input) => remote.poll(input) };
      });
    } finally {
      served.stop();
    }
  });
});

/** `serve-module @lf/dealroom` as a child process. */
async function serveDealroom(): Promise<{ url: string; stop(): void }> {
  const repo = join(__dirname, '../../../../../../../..');
  const child = spawn(process.execPath, [join(repo, 'packages/module-kit/bin/serve-module.cjs'), '.'], {
    cwd: join(repo, 'modules/dealroom'),
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serve-module printed no port within 30s')), 30_000);
    child.once('exit', (code) => reject(new Error(`serve-module exited (${code})`)));
    if (child.stdout === null) return;
    createInterface({ input: child.stdout }).on('line', (line) => {
      const match = /^listening (\d+)$/.exec(line);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  return { url: `http://127.0.0.1:${port}/`, stop: () => child.kill() };
}
