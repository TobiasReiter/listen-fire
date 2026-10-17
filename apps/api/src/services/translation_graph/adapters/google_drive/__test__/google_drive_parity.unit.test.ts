// Recorded parity for Google Drive. The fixture is the legacy adapter as it
// was before Google Drive became a module (commit d904fad2), driven through
// `parity/script.ts` against the fake-channels Drive: every answer (a file's
// bytes as base64), and every request it made with what came back (an upload
// as its multipart parts). Each implementation is replayed against the
// recording and must make the same requests (its writes) and give the same
// answers: the legacy line, the module in process as the platform loads it
// (the registry, the secrets family over the stored camel payload, the grants
// kv, the platform's files, the dev-loop redirect), and the module served as
// a process (serve-module, its grants in a state directory) called over
// protocol 2, where a file's bytes cross at URLs.
//
// The requests are compared as a multiset, not in arrival order. Over
// protocol 2 a refusal reaches the caller wrapped by the protocol client; the
// served module is held to its own message inside it.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// GOOGLE_DRIVE_PARITY_RECORD=1 pnpm test:unit --testPathPattern google_drive_parity
// (recording drives the legacy line, which since the move is the module's
// adapter over the old credential path: re-recording no longer captures the
// pre-module code).

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

const mockPayloads: Map<string, Record<string, unknown>> = new Map();
jest.mock('../../../../credentials/secrets_postgres', () => {
  const actual = jest.requireActual('../../../../credentials/secrets_postgres');
  const { payloadSecrets } = jest.requireActual('../../../../credentials/__test__/payload_secrets');
  return { ...actual, postgresSecrets: (options: { shape?: unknown }) => payloadSecrets(mockPayloads, options.shape ?? actual.flatPayloadShape) };
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

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Adapter } from 'movement-engine/public/adapter';
import type { DocumentStore } from 'movement-engine/public/files';

import { google } from 'googleapis';

import { servedFiles, writeFileKv } from 'module-kit';
import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';
import { getAdapter } from '../../registry';
import { BUILTIN_MODULES } from '../../builtin_modules';
import { createGoogleDriveAdapter } from '../index';
import { recordingServer, replayingServer, requestOf, type Exchange, type ExchangeRequest } from '../../__test__/parity/exchange';
import { bootFakeChannels } from '../../__test__/parity/fake_channels';
import { PARITY_ACCESS_TOKEN, PARITY_GRANTS, REFUSED, runParityScript, type ParitySubject, type TranscriptEntry } from './parity/script';

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
/** Far from expiry, so no subject ever refreshes. */
const EXPIRES_AT = Date.UTC(2099, 0, 1);

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

/** A refusal as the protocol client reports it: the module's own message,
 *  behind the client's `Remote adapter error for method "…": <code> — `. */
const REMOTE_ERROR = /^Remote adapter error for method "[^"]+": [a-z_]+ — /;

function unwrapRemoteErrors(transcript: TranscriptEntry[]): TranscriptEntry[] {
  return transcript.map((entry) => {
    const error: unknown = entry.answer !== null && typeof entry.answer === 'object' ? Reflect.get(entry.answer, 'error') : undefined;
    return typeof error === 'string' ? { ...entry, answer: { error: error.replace(REMOTE_ERROR, '') } } : entry;
  });
}

/** Replay `subjectAt` against the recording: same answers, same requests. */
async function expectParity(
  subjectAt: (baseUrl: string) => Promise<ParitySubject> | ParitySubject,
  options: { remote?: boolean } = {},
): Promise<void> {
  const recorded = loadRecording();
  const server = await replayingServer(recorded.exchanges);
  try {
    const answered = await runParityScript(await subjectAt(server.baseUrl));
    const transcript = options.remote === true ? unwrapRemoteErrors(answered) : answered;
    expect(transcript).toEqual(recorded.transcript);
    expect(asMultiset(server.requests())).toEqual(asMultiset(recorded.exchanges.map(requestOf)));
  } finally {
    await server.close();
  }
}

/** `serve-module @lf/google-drive` as a child process. */
async function serveDrive(env: Record<string, string>): Promise<{ url: string; stop(): void }> {
  const repo = join(__dirname, '../../../../../../../..');
  const child = spawn(process.execPath, [join(repo, 'packages/module-kit/bin/serve-module.cjs'), '.'], {
    cwd: join(repo, 'modules/google-drive'),
    env: { ...process.env, PORT: '0', ...env },
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

/** The host's document store, as far as a write to a served module needs it:
 *  the bytes of a file the write hands over, held at a URL for one fetch. */
async function exposingDocuments(): Promise<{ documents: DocumentStore; close(): Promise<void> }> {
  const files = servedFiles();
  const server = createServer((req, res) => {
    if (!files.serve(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  const refuse = async (): Promise<never> => {
    throw new Error('the parity documents store keeps nothing');
  };
  return {
    documents: {
      put: refuse,
      owns: async () => false,
      open: refuse,
      expose: async ({ stream, contentType }) => ({ url: files.expose({ stream, ...(contentType !== undefined ? { contentType } : {}) }, origin) }),
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
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

  it('the module in process, through the platform registry, replays identically', async () => {
    expect(BUILTIN_MODULES.google_drive?.line).toBe('module');
    await expectParity((baseUrl) => {
      seedGrants();
      mockHarness.baseUrl = baseUrl;
      mockPayloads.clear();
      // The payload exactly as the connect flow stores it.
      mockPayloads.set(CREDENTIAL, { accessToken: PARITY_ACCESS_TOKEN, refreshToken: 'parity-refresh', expiresAt: EXPIRES_AT });
      return { adapter: () => getAdapter({ adapterType: 'google_drive', teamId: TEAM, credentialsId: CREDENTIAL }) };
    });
  });

  it('the module served as a process, over protocol 2, replays identically', async () => {
    const served: Array<{ stop(): void }> = [];
    const exposing = await exposingDocuments();
    try {
      await expectParity(async (baseUrl) => {
        const stateDir = mkdtempSync(join(tmpdir(), 'google-drive-parity-'));
        await writeFileKv(
          stateDir,
          TEAM,
          PARITY_GRANTS.map((grant) => ({ key: `granted/${grant.itemId}`, value: { mimeType: grant.mimeType, name: grant.name } })),
        );
        const drive = await serveDrive({ MODULE_STATE_DIR: stateDir, MODULE_BASE_URL_OVERRIDE: baseUrl });
        served.push(drive);
        const vault = createMemoryVault({
          [CREDENTIAL]: { access_token: PARITY_ACCESS_TOKEN, refresh_token: 'parity-refresh', expires_at: new Date(EXPIRES_AT).toISOString() },
        });
        const secrets = createSecretsFamily({ backend: vault });
        const config = { adapterType: 'google_drive', teamId: TEAM, baseUrl: drive.url, authStrategy: { kind: 'bearer' as const }, credentialsId: CREDENTIAL };
        const manifest = await fetchRemoteManifest(config, '');
        return {
          adapter: (): Adapter =>
            createRemoteAdapter({
              config,
              secret: '',
              cacheScopeId: 'parity',
              manifest,
              documents: exposing.documents,
              credential: { name: 'google', secrets, ref: CREDENTIAL },
            }),
        };
      }, { remote: true });
    } finally {
      for (const process of served) process.stop();
      await exposing.close();
    }
  });
});
