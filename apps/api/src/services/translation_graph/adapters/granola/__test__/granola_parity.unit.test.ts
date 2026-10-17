// Recorded parity for Granola. The fixture is the legacy adapter as it was
// before Granola became a module, driven through `parity/script.ts` against
// the fake-channels Granola: every answer, and every request it made with
// what came back. Each implementation is replayed against the recording and
// must make the same requests and give the same answers: the legacy line, the
// module in process as the platform loads it, and the module served as a
// process (serve-module) and called over adapter protocol 2.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// GRANOLA_PARITY_RECORD=1 pnpm test:unit --testPathPattern granola_parity

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
import { logger } from 'movement-engine/public/log';
import { GranolaAdapter, GranolaClient, pollGranola } from '@lf/granola';
import { getAdapter, getPollSource } from '../../registry';
import { BUILTIN_MODULES } from '../../builtin_modules';
import { recordingServer, replayingServer, type Exchange } from '../../__test__/parity/exchange';
import { bootFakeGranola } from './parity/fake_granola';
import { runParityScript, type ParitySubject, type TranscriptEntry } from './parity/script';

const FIXTURE = join(__dirname, '__fixtures__/granola_parity.json');
const API_KEY = 'dev-loop-granola-token';
const TEAM = 'team-parity' as TeamId;

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

/** The legacy line's adapter and poll, on a client pointed at `baseUrl` (its
 *  credential path, the decrypted row, is the one thing replaced). */
function legacySubject(baseUrl: string): ParitySubject {
  const client = new GranolaClient({ apiKey: API_KEY, baseUrl, fetch, log: logger });
  return {
    adapter: new GranolaAdapter(async () => client),
    poll: (input) => pollGranola(client, input),
  };
}

jest.setTimeout(120_000);

const recording = process.env.GRANOLA_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeGranola();
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

/** What the protocol client puts in front of an adapter's own error message. */
const REMOTE_ERROR_PREFIX = /^Remote adapter error for method "[^"]+": adapter_error — /;

/** A refusal over the wire is the adapter's message behind the transport's
 *  prefix; the parity held is of the message itself. */
function withoutTransportPrefix(transcript: TranscriptEntry[]): TranscriptEntry[] {
  return transcript.map((entry) => {
    const answer = entry.answer;
    if (answer !== null && typeof answer === 'object' && 'error' in answer && typeof answer.error === 'string') {
      return { ...entry, answer: { ...answer, error: answer.error.replace(REMOTE_ERROR_PREFIX, '') } };
    }
    return entry;
  });
}

/** Replay `subjectAt` against the recording: same answers, same requests. */
async function expectParity(
  subjectAt: (baseUrl: string) => Promise<ParitySubject> | ParitySubject,
  options: { overProtocol?: boolean } = {},
): Promise<void> {
  const recorded = loadRecording();
  const server = await replayingServer(recorded.exchanges);
  try {
    const transcript = await runParityScript(await subjectAt(server.baseUrl));
    expect(options.overProtocol === true ? withoutTransportPrefix(transcript) : transcript).toEqual(recorded.transcript);
    expect(server.requests()).toEqual(recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request));
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('granola recorded parity', () => {
  it('the recording walks the whole surface and fails only where the script probes a field that is not there', () => {
    const { transcript, exchanges } = loadRecording();
    const failed = transcript
      .filter((entry) => entry.answer !== null && typeof entry.answer === 'object' && 'error' in entry.answer)
      .map((entry) => entry.step);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.filter((step) => !/\.(Nonexistent|granola_note_id)$/.test(step))).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(15);
    expect(transcript.find((e) => e.step === 'poll from a checkpoint')?.answer).toMatchObject({ events: expect.arrayContaining([expect.anything()]) });
  });

  it('the legacy line replays identically', async () => {
    await expectParity(legacySubject);
  });

  it('the module in process, through the platform registry, replays identically', async () => {
    expect(BUILTIN_MODULES.granola?.line).toBe('module');
    await expectParity((baseUrl) => {
      vault.current = createMemoryVault({ 'cred-parity': { apiKey: API_KEY, baseUrl } });
      const install = { adapterType: 'granola', teamId: TEAM, credentialsId: 'cred-parity' };
      const source = getPollSource(install);
      if (source === null) throw new Error('granola has no poll source');
      return { adapter: getAdapter(install), poll: (input) => source.getEvents(input) };
    });
  });

  it('the module served as a process, over protocol 2, replays identically', async () => {
    const served = await serveGranola();
    try {
      await expectParity(async (baseUrl) => {
        const credentials = createMemoryVault({ 'cred-parity': { apiKey: API_KEY, baseUrl } });
        const config = { adapterType: 'granola', teamId: TEAM, baseUrl: served.url, authStrategy: { kind: 'bearer' as const }, credentialsId: 'cred-parity' };
        const remote = createRemoteAdapter({
          config,
          secret: '',
          cacheScopeId: 'parity',
          manifest: await fetchRemoteManifest(config, ''),
          documents: { put: async () => ({}) } as never,
          credential: { name: 'granola', secrets: createSecretsFamily({ backend: credentials }), ref: 'cred-parity' },
        });
        return { adapter: remote, poll: (input) => remote.poll(input) };
      }, { overProtocol: true });
    } finally {
      served.stop();
    }
  });
});

/** `serve-module @lf/granola` as a child process. */
async function serveGranola(): Promise<{ url: string; stop(): void }> {
  const repo = join(__dirname, '../../../../../../../..');
  const child = spawn(process.execPath, [join(repo, 'packages/module-kit/bin/serve-module.cjs'), '.'], {
    cwd: join(repo, 'modules/granola'),
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
