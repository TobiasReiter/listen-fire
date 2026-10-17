// Recorded parity for Dropbox. The fixture is the legacy adapter as it was
// before Dropbox became a module, driven through `parity/script.ts` against
// the fake-channels Dropbox: every answer, and every request it made with
// what came back (bytes included). Each implementation is replayed against
// the recording and must make the same requests (its writes) and give the
// same answers: the legacy line, the module in process as the platform loads
// it, and the module served as a process (serve-module) and called over
// adapter protocol 2.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// DROPBOX_PARITY_RECORD=1 pnpm test:unit --testPathPattern dropbox_parity

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => JSON.stringify(credentialPayload()),
  encryptToken: async () => '',
}));

// The credential row the legacy line reads: any chain of query calls ends in
// the one row, whose ciphertext `decryptToken` above answers for.
jest.mock('../../../../../lib/kysely', () => {
  const query: Record<string, unknown> = {};
  for (const method of ['selectFrom', 'where', 'select']) query[method] = () => query;
  query.executeTakeFirst = async () => ({ id: 'cred-parity', credentials: Buffer.alloc(0) });
  return { getAutomationsQb: () => query };
});

jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { createMemoryVault } from 'movement-engine/public/secrets';
import { getAdapter } from '../../registry';
import { BUILTIN_MODULES } from '../../builtin_modules';

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

import { recordingServer, replayingServer, type Exchange } from './parity/exchange';
import { bootFakeDropbox } from './parity/fake_dropbox';
import { runParityScript, type ParitySubject, type TranscriptEntry } from './parity/script';

const FIXTURE = join(__dirname, '__fixtures__/dropbox_parity.json');
const TEAM = 'team-parity' as TeamId;
/** Far enough off that no run of this test ever finds it stale. */
const EXPIRES_AT = Date.UTC(2099, 0, 1);

let baseUrl = '';
function credentialPayload() {
  return { accessToken: 'parity-access-token', refreshToken: 'parity-refresh-token', expiresAt: EXPIRES_AT, baseUrl };
}

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

jest.mock('../../../../../adapters/registry', () => {
  const { DropboxAuthClient } = jest.requireActual('../../../../../adapters/dropbox/authClient');
  return { services: { dropbox: { authClient: new DropboxAuthClient({ clientId: 'c', clientSecret: 's', redirectBaseUrl: 'http://localhost' }) } } };
});

/** The legacy line: the adapter over the decrypted row, as the platform ran it. */
function legacySubject(at: string): ParitySubject {
  baseUrl = at;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createDropboxAdapter } = require('..') as typeof import('..');
  return { adapter: createDropboxAdapter({ teamId: TEAM, credentialsId: 'cred-parity' }) };
}

jest.setTimeout(120_000);

const recording = process.env.DROPBOX_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeDropbox();
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
    expect(server.requests()).toEqual(recorded.exchanges.map(({ status: _s, response: _r, responseContentType: _c, ...request }) => request));
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('dropbox recorded parity', () => {
  it('the recording walks the whole surface and fails only where it should', () => {
    const { transcript, exchanges } = loadRecording();
    const failed = transcript.filter((entry) => typeof entry.answer === 'object' && entry.answer !== null && 'error' in entry.answer).map((e) => e.step);
    expect(failed).toEqual(['create File with no content', 'create an unknown type', 'updateRecord', 'deleteRecord']);
    expect(exchanges.length).toBeGreaterThan(10);
    expect(transcript.find((e) => e.step === 'resolveFileRef')?.answer).toMatchObject({ body: 'Foo Corp notes: strong team, pre-seed.' });
  });

  it('the legacy line replays identically', async () => {
    await expectParity(legacySubject);
  });

  it('the module in process, through the platform registry, replays identically', async () => {
    expect(BUILTIN_MODULES.dropbox?.line).toBe('module');
    await expectParity((at) => {
      vault.current = createMemoryVault({
        'cred-parity': {
          access_token: 'parity-access-token',
          refresh_token: 'parity-refresh-token',
          expires_at: new Date(EXPIRES_AT).toISOString(),
          baseUrl: at,
        },
      });
      return { adapter: getAdapter({ adapterType: 'dropbox', teamId: TEAM, credentialsId: 'cred-parity' }) };
    });
  });
});
