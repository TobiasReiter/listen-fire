// Recorded parity for Google Sheets. The fixture is the legacy adapter as it
// was before Google Sheets became a module, driven through `parity/script.ts`
// against the fake-channels Sheets: every answer, and every request it made
// with what came back. Each implementation is replayed against the recording
// and must make the same requests (its writes) and give the same answers.
//
// The requests are compared as a multiset, not in arrival order: the adapter
// fans some reads out concurrently (a table's columns beside its rows, one
// value read per named cell), and those arrive in whatever order the sockets
// deliver them.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// GOOGLE_SHEETS_PARITY_RECORD=1 pnpm test:unit --testPathPattern google_sheets_parity

// The platform's stores, in memory: the grants table and the team's emails.
const mockGrants: Array<{ credentialsId: string; itemId: string; mimeType: string; name: string | null }> = [];
jest.mock('../../../../credentials/granted_items', () => ({
  DRIVE_FOLDER_MIME: 'application/vnd.google-apps.folder',
  SPREADSHEET_MIME: 'application/vnd.google-apps.spreadsheet',
  listGrantedItems: async (credentialsId: string, opts?: { mimeTypes?: string[] }) =>
    mockGrants
      .filter((g) => g.credentialsId === credentialsId && (opts?.mimeTypes === undefined || opts.mimeTypes.includes(g.mimeType)))
      .map((g) => ({ itemId: g.itemId, mimeType: g.mimeType, name: g.name })),
  grantItem: async (input: { credentialsId: string; itemId: string; mimeType: string; name?: string | null }) => {
    const existing = mockGrants.find((g) => g.credentialsId === input.credentialsId && g.itemId === input.itemId);
    if (existing !== undefined) Object.assign(existing, { mimeType: input.mimeType, name: input.name ?? null });
    else mockGrants.push({ credentialsId: input.credentialsId, itemId: input.itemId, mimeType: input.mimeType, name: input.name ?? null });
  },
  revokeItem: async () => undefined,
}));

jest.mock('../../../../../lib/kysely', () => {
  const rows = [{ email: 'ana@parity.test' }, { email: 'ben@parity.test' }];
  const chain: Record<string, unknown> = {};
  for (const name of ['selectFrom', 'innerJoin', 'where', 'select', 'onRef', 'on']) chain[name] = () => chain;
  chain.execute = async () => rows;
  return {
    ...jest.requireActual('../../../../../lib/kysely'),
    getCoreQb: () => chain,
  };
});

jest.mock('../../../../credentials/secrets_postgres', () => ({
  ...jest.requireActual('../../../../credentials/secrets_postgres'),
  postgresSecrets: () => {
    throw new Error('no credentials table in the parity test');
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

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { GoogleSheetsApiClient } from '../../../../../adapters/googleSheets/apiClient';
import { GoogleSheetsAdapter } from '../index';
import { recordingServer, replayingServer, type Exchange, type ExchangeRequest } from '../../dealroom/__test__/parity/exchange';
import { bootFakeChannels } from '../../__test__/parity/fake_channels';
import { PARITY_ACCESS_TOKEN, PARITY_GRANTS, REFUSED, runParityScript, type ParitySubject, type TranscriptEntry } from './parity/script';

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

/** The legacy adapter on a client pointed at `baseUrl` (its credential path,
 *  the decrypted row, is the one thing replaced). */
function legacySubject(baseUrl: string): ParitySubject {
  seedGrants();
  return {
    adapter: (at) => {
      const adapter = new GoogleSheetsAdapter({ teamId: TEAM, credentialsId: CREDENTIAL, ...(at?.spreadsheet !== undefined ? { spreadsheet: at.spreadsheet } : {}) });
      const client = new GoogleSheetsApiClient(CREDENTIAL, { accessToken: PARITY_ACCESS_TOKEN, refreshToken: 'parity-refresh', expiresAt: EXPIRES_AT, baseUrl });
      Reflect.set(adapter, 'getApiClient', async () => client);
      return adapter;
    },
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

/** Replay `subjectAt` against the recording: same answers, same requests. */
async function expectParity(subjectAt: (baseUrl: string) => Promise<ParitySubject> | ParitySubject): Promise<void> {
  const recorded = loadRecording();
  const server = await replayingServer(recorded.exchanges);
  try {
    const transcript = await runParityScript(await subjectAt(server.baseUrl));
    expect(transcript).toEqual(recorded.transcript);
    expect(asMultiset(server.requests())).toEqual(asMultiset(recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request)));
  } finally {
    await server.close();
  }
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
});
