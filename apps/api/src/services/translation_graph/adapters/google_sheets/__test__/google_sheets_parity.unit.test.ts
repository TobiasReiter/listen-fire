// Recorded parity for Google Sheets. The fixture is the legacy adapter as it
// was before Google Sheets became a module (commit 223a0802), driven through
// `parity/script.ts` against the fake-channels Sheets: every answer, and every
// request it made with what came back. Each implementation is replayed
// against the recording and must make the same requests (its writes) and give
// the same answers: the legacy line, the module in process as the platform
// loads it (the registry, the secrets family over the stored camel payload,
// the grants kv, the dev-loop redirect), and the module served as a process
// (serve-module, its grants in a state directory) called over protocol 2.
//
// The requests are compared as a multiset, not in arrival order: the adapter
// fans some reads out concurrently (a table's columns beside its rows, one
// value read per named cell), and those arrive in whatever order the sockets
// deliver them. Over protocol 2 a refusal reaches the caller wrapped by the
// protocol client; the served module is held to its own message inside it.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// GOOGLE_SHEETS_PARITY_RECORD=1 pnpm test:unit --testPathPattern google_sheets_parity
// (recording drives the legacy line, which since the move is the module's
// adapter over the old credential path: re-recording no longer captures the
// pre-module code).

// The platform's stores, in memory: the grants table (and the team's
// emails), and the credentials table holding each payload as the connect flow
// stored it.
const mockGrants: Array<{ credentialsId: string; itemId: string; mimeType: string; name: string | null }> = [];
jest.mock('../../../../credentials/granted_items', () => {
  const actual = jest.requireActual('../../../../credentials/granted_items');
  const store = {
    list: async (credentialsId: string) =>
      mockGrants.filter((g) => g.credentialsId === credentialsId).map((g) => ({ itemId: g.itemId, mimeType: g.mimeType, name: g.name })),
    grant: async (input: { credentialsId: string; itemId: string; mimeType: string; name: string | null }) => {
      const existing = mockGrants.find((g) => g.credentialsId === input.credentialsId && g.itemId === input.itemId);
      if (existing !== undefined) Object.assign(existing, { mimeType: input.mimeType, name: input.name });
      else mockGrants.push({ ...input });
    },
    revoke: async () => undefined,
    teamEmails: async () => ['ana@parity.test', 'ben@parity.test'],
  };
  return { ...actual, grantedItemsKv: (credentialsId: string, options: { teamId: string }) => actual.grantedItemsKv(credentialsId, { ...options, store }) };
});

const mockPayloads: Map<string, Record<string, unknown>> = new Map();
jest.mock('../../../../credentials/secrets_postgres', () => {
  const actual = jest.requireActual('../../../../credentials/secrets_postgres');
  const { payloadSecrets } = jest.requireActual('../../../../credentials/__test__/payload_secrets');
  return { ...actual, postgresSecrets: (options: { shape?: unknown }) => payloadSecrets(mockPayloads, options.shape ?? actual.flatPayloadShape) };
});

// The parity team is the dev loop's test-harness team, so the module line is
// redirected to the replaying server exactly as the dev loop redirects it to
// fake-channels.
const mockHarness: { baseUrl?: string } = {};
jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => true,
  injectFakeBaseUrl: (creds: Record<string, unknown>, service: string) =>
    service === 'GOOGLE_SHEETS' && mockHarness.baseUrl !== undefined ? { ...creds, baseUrl: mockHarness.baseUrl } : creds,
}));

// The legacy line's credential path past the decrypted row: the platform's
// client over the stored tokens, at the redirected base URL.
jest.mock('../client', () => ({
  resolveGoogleSheetsClient: async () => {
    const { GoogleSheetsApiClient } = jest.requireActual('../../../../../adapters/googleSheets/apiClient');
    return new GoogleSheetsApiClient('cred-parity', {
      accessToken: 'parity-google-access-token',
      refreshToken: 'parity-refresh',
      expiresAt: Date.UTC(2099, 0, 1),
      baseUrl: mockHarness.baseUrl,
    });
  },
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Adapter } from 'movement-engine/public/adapter';

import { writeFileKv } from 'module-kit';
import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';
import { createGoogleSheetsAdapter } from '../index';
import { recordingServer, replayingServer, type Exchange, type ExchangeRequest } from '../../dealroom/__test__/parity/exchange';
import { bootFakeChannels } from '../../__test__/parity/fake_channels';
import {
  PARITY_ACCESS_TOKEN,
  PARITY_GRANTS,
  PARITY_TEAM_EMAILS,
  REFUSED,
  runParityScript,
  type ParitySubject,
  type TranscriptEntry,
} from './parity/script';

const FIXTURE = join(__dirname, '__fixtures__/google_sheets_parity.json');
const TEAM = 'team-parity' as TeamId;
const CREDENTIAL = 'cred-parity';
const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
/** Far from expiry, so no subject ever refreshes. */
const EXPIRES_AT = Date.UTC(2099, 0, 1);

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

function seedGrants(): void {
  mockGrants.length = 0;
  for (const grant of PARITY_GRANTS) {
    mockGrants.push({ credentialsId: CREDENTIAL, itemId: grant.spreadsheetId, mimeType: SPREADSHEET_MIME, name: grant.name });
  }
}

/** The legacy line: its factory, over the old credential path (the decrypted
 *  row is the one thing replaced) and the grants table. */
function legacySubject(baseUrl: string): ParitySubject {
  seedGrants();
  mockHarness.baseUrl = baseUrl;
  return {
    adapter: (at) => createGoogleSheetsAdapter({ teamId: TEAM, credentialsId: CREDENTIAL, ...(at?.spreadsheet !== undefined ? { spreadsheet: at.spreadsheet } : {}) }),
  };
}

jest.setTimeout(180_000);

const recording = process.env.GOOGLE_SHEETS_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeChannels({ file: 'sheets', factory: 'sheetsRoutes', mount: '/sheets' });
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
    expect(asMultiset(server.requests())).toEqual(asMultiset(recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request)));
  } finally {
    await server.close();
  }
}

/** `serve-module @lf/google-sheets` as a child process. */
async function serveSheets(env: Record<string, string>): Promise<{ url: string; stop(): void }> {
  const repo = join(__dirname, '../../../../../../../..');
  const child = spawn(process.execPath, [join(repo, 'packages/module-kit/bin/serve-module.cjs'), '.'], {
    cwd: join(repo, 'modules/google-sheets'),
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

(recording ? describe.skip : describe)('google sheets recorded parity', () => {
  it('the recording walks the whole surface and fails only where it should', () => {
    const { transcript, exchanges } = loadRecording();
    const failed = (entry: TranscriptEntry) => entry.answer !== null && typeof entry.answer === 'object' && 'error' in entry.answer;
    expect(transcript.filter((entry) => failed(entry) !== entry.step.startsWith(REFUSED)).map((entry) => entry.step)).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(50);
    const methods = new Set(exchanges.map((e) => `${e.method} ${e.path.replace(/\?.*$/, '').replace(/\/spreadsheets\/[^/:]+/, '/spreadsheets/:id').replace(/\/files\/[^/]+/, '/files/:id').replace(/\/values\/[^:]+/, '/values/:range')}`));
    expect([...methods].sort()).toEqual([
      'GET /v4/spreadsheets/:id',
      'GET /v4/spreadsheets/:id/values/:range',
      'POST /drive/v3/files/:id/permissions',
      'POST /v4/spreadsheets',
      'POST /v4/spreadsheets/:id/values/:range:append',
      'POST /v4/spreadsheets/:id:batchUpdate',
    ]);
  });

  it('the legacy line replays identically', async () => {
    await expectParity(legacySubject);
  });

  it('the module served as a process, over protocol 2, replays identically', async () => {
    const served: Array<{ stop(): void }> = [];
    try {
      await expectParity(async (baseUrl) => {
        const stateDir = mkdtempSync(join(tmpdir(), 'google-sheets-parity-'));
        await writeFileKv(stateDir, TEAM, [
          ...PARITY_GRANTS.map((grant) => ({ key: `granted/${grant.spreadsheetId}`, value: { mimeType: SPREADSHEET_MIME, name: grant.name } })),
          { key: 'team/emails', value: [...PARITY_TEAM_EMAILS] },
        ]);
        const env = { MODULE_STATE_DIR: stateDir, MODULE_BASE_URL_OVERRIDE: baseUrl };
        // Protocol 2 carries no construction arguments, so the positioned
        // instance is its own served install.
        const plain = await serveSheets(env);
        const positioned = await serveSheets({ ...env, MODULE_CONSTRUCTION_ARGS: JSON.stringify({ spreadsheet: 'Pipeline Sheet' }) });
        served.push(plain, positioned);
        const vault = createMemoryVault({
          [CREDENTIAL]: { access_token: PARITY_ACCESS_TOKEN, refresh_token: 'parity-refresh', expires_at: new Date(EXPIRES_AT).toISOString() },
        });
        const secrets = createSecretsFamily({ backend: vault });
        const remoteAt = async (url: string): Promise<Adapter> => {
          const config = { adapterType: 'google_sheets', teamId: TEAM, baseUrl: url, authStrategy: { kind: 'bearer' as const }, credentialsId: CREDENTIAL };
          return createRemoteAdapter({
            config,
            secret: '',
            cacheScopeId: 'parity',
            manifest: await fetchRemoteManifest(config, ''),
            documents: { put: async () => ({}) } as never,
            credential: { name: 'google', secrets, ref: CREDENTIAL },
          });
        };
        return { adapter: (at) => remoteAt(at?.spreadsheet !== undefined ? positioned.url : plain.url) };
      }, { remote: true });
    } finally {
      for (const process of served) process.stop();
    }
  });
});
