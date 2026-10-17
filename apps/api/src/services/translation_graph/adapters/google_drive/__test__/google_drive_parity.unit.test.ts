// Recorded parity for Google Drive. The fixture is the legacy adapter as it
// was before Google Drive became a module, driven through `parity/script.ts`
// against the fake-channels Drive: every answer (a file's bytes as base64),
// and every request it made with what came back (an upload as its multipart
// parts). Each implementation is replayed against the recording and must make
// the same requests (its writes) and give the same answers.
//
// The requests are compared as a multiset, not in arrival order. Over
// protocol 2 a refusal reaches the caller wrapped by the protocol client; the
// served module is held to its own message inside it.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// GOOGLE_DRIVE_PARITY_RECORD=1 pnpm test:unit --testPathPattern google_drive_parity

// The platform's stores, in memory: the grants table, and the credentials
// row the legacy line reads and decrypts.
const mockGrants: Array<{ credentialsId: string; itemId: string; mimeType: string; name: string | null }> = [];
jest.mock('../../../../credentials/granted_items', () => {
  const actual = jest.requireActual('../../../../credentials/granted_items');
  const list = async (credentialsId: string) =>
    mockGrants.filter((g) => g.credentialsId === credentialsId).map((g) => ({ itemId: g.itemId, mimeType: g.mimeType, name: g.name }));
  const store = {
    list,
    grant: async () => undefined,
    revoke: async () => undefined,
    teamEmails: async () => [],
  };
  return {
    ...actual,
    listGrantedItems: list,
    grantedItemsKv: (credentialsId: string, options: { teamId: string }) => actual.grantedItemsKv(credentialsId, { ...options, store }),
  };
});

const mockStoredPayload = { accessToken: 'parity-google-access-token', refreshToken: 'parity-refresh', expiresAt: Date.UTC(2099, 0, 1) };
jest.mock('../../../../../lib/kysely', () => {
  const actual = jest.requireActual('../../../../../lib/kysely');
  const row = { id: 'cred-parity', credentials: 'ciphertext' };
  const chain: Record<string, unknown> = {};
  for (const name of ['selectFrom', 'where', 'select']) chain[name] = () => chain;
  chain.executeTakeFirst = async () => row;
  return { ...actual, getAutomationsQb: () => chain };
});
jest.mock('../../../../../lib/credentials', () => ({
  ...jest.requireActual('../../../../../lib/credentials'),
  decryptToken: async () => JSON.stringify(mockStoredPayload),
}));

// The parity team is the dev loop's test-harness team, so every subject is
// redirected to the recording or replaying server exactly as the dev loop
// redirects it to fake-channels.
const mockHarness: { baseUrl?: string } = {};
jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => true,
  injectFakeBaseUrl: (creds: Record<string, unknown>, service: string) =>
    service === 'GOOGLE_DRIVE' && mockHarness.baseUrl !== undefined ? { ...creds, baseUrl: mockHarness.baseUrl } : creds,
}));

// The host's Google app, as the platform builds it: the real auth client, so
// the legacy client's tokens come from google-auth-library exactly as in
// production (the stored token is far from expiry, so it never refreshes).
jest.mock('../../../../../adapters/registry', () => {
  const { GoogleAuthClient } = jest.requireActual('../../../../../adapters/google/authClient');
  return {
    services: {
      google: { authClient: new GoogleAuthClient({ clientId: 'parity-client', clientSecret: 'parity-secret', redirectBaseUrl: 'http://127.0.0.1' }) },
    },
  };
});

import { readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { join } from 'node:path';

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { google } from 'googleapis';

import { createGoogleDriveAdapter } from '../index';
import { recordingServer, replayingServer, requestOf, type Exchange, type ExchangeRequest } from '../../__test__/parity/exchange';
import { bootFakeChannels } from '../../__test__/parity/fake_channels';
import { PARITY_GRANTS, REFUSED, runParityScript, type ParitySubject, type TranscriptEntry } from './parity/script';

// gaxios finds its fetch (node-fetch) by a dynamic import, which jest's VM
// refuses. The legacy line is handed Node's own fetch instead, its bodies as
// Node streams the way node-fetch answers them (a streamed download is piped
// into an upload as it is in production).
google.options({
  fetchImplementation: async (...args: Parameters<typeof fetch>) => {
    const response = await fetch(...args);
    return new Proxy(response, {
      get(target, key) {
        if (key === 'body') return target.body === null ? null : Readable.fromWeb(target.body as WebReadableStream);
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  },
});

const FIXTURE = join(__dirname, '__fixtures__/google_drive_parity.json');
const TEAM = 'team-parity' as TeamId;
const CREDENTIAL = 'cred-parity';

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

function seedGrants(): void {
  mockGrants.length = 0;
  for (const grant of PARITY_GRANTS) mockGrants.push({ credentialsId: CREDENTIAL, ...grant });
}

/** The legacy line: its factory, over the old credential path (the stored
 *  row is the one thing replaced) and the grants table. */
function legacySubject(baseUrl: string): ParitySubject {
  seedGrants();
  mockHarness.baseUrl = baseUrl;
  return { adapter: () => createGoogleDriveAdapter({ teamId: TEAM, credentialsId: CREDENTIAL }) };
}

jest.setTimeout(180_000);

const recording = process.env.GOOGLE_DRIVE_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeChannels({ file: 'gdrive', factory: 'gdriveRoutes', mount: '/' });
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

const asMultiset = (requests: readonly ExchangeRequest[]): string[] => requests.map((request) => JSON.stringify(request)).sort();

/** Replay `subjectAt` against the recording: same answers, same requests. */
async function expectParity(subjectAt: (baseUrl: string) => Promise<ParitySubject> | ParitySubject): Promise<void> {
  const recorded = loadRecording();
  const server = await replayingServer(recorded.exchanges);
  try {
    const transcript = await runParityScript(await subjectAt(server.baseUrl));
    expect(transcript).toEqual(recorded.transcript);
    expect(asMultiset(server.requests())).toEqual(asMultiset(recorded.exchanges.map(requestOf)));
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('google drive recorded parity', () => {
  it('the recording walks the whole surface and fails only where it should', () => {
    const { transcript, exchanges } = loadRecording();
    const failed = (entry: TranscriptEntry) => entry.answer !== null && typeof entry.answer === 'object' && 'error' in entry.answer;
    expect(transcript.filter((entry) => failed(entry) !== entry.step.startsWith(REFUSED)).map((entry) => entry.step)).toEqual([]);
    const methods = new Set(exchanges.map((e) => `${e.method} ${e.path.replace(/\?.*$/, '').replace(/\/files\/[^/]+/, '/files/:id')}`));
    expect([...methods].sort()).toEqual([
      'GET /drive/v3/files',
      'GET /drive/v3/files/:id',
      'POST /drive/v3/files',
      'POST /upload/drive/v3/files',
    ]);
  });

  it('the legacy line replays identically', async () => {
    await expectParity(legacySubject);
  });
});
