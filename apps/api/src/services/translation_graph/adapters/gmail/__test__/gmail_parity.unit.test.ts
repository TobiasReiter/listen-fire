// Recorded parity for Gmail. The fixtures are the legacy adapter and poll
// source as they were before Gmail became a module, driven through
// `parity/script.ts` against the fake-channels Gmail seeded with
// `PARITY_SEED`: every answer, and every request with what came back. There
// are two, one per credential shape: a mailbox somebody signed into (its
// stored OAuth tokens), and a mailbox the service account acts as
// (delegated). Each implementation is replayed against the recordings and
// must make the same requests (its sends) and give the same answers.
//
// A send's request is kept as its decoded message, with the random MIME
// boundaries numbered in order and the `Date:` header blanked. Under the
// delegated shape the dev loop never mints a token, so its requests are
// compared without their authentication (the fake reads none).
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// GMAIL_PARITY_RECORD=1 pnpm test:unit --testPathPattern gmail_parity

const mockRow: { app_id: string; payload: Record<string, unknown> } = { app_id: 'gmail-oauth-mailbox', payload: {} };
jest.mock('../../../../../lib/kysely', () => {
  const actual = jest.requireActual('../../../../../lib/kysely');
  const chain: Record<string, unknown> = {};
  for (const name of ['selectFrom', 'where', 'select']) chain[name] = () => chain;
  chain.executeTakeFirst = async () => ({ id: 'cred-parity', credentials: 'ciphertext', app_id: mockRow.app_id });
  return { ...actual, getAutomationsQb: () => chain };
});
jest.mock('../../../../../lib/credentials', () => ({
  ...jest.requireActual('../../../../../lib/credentials'),
  decryptToken: async () => JSON.stringify(mockRow.payload),
}));

// The parity team is the dev loop's test-harness team, so every subject is
// redirected to the recording or replaying server exactly as the dev loop
// redirects it to fake-channels.
const mockHarness: { baseUrl?: string } = {};
jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => true,
  injectFakeBaseUrl: (creds: Record<string, unknown>, service: string) =>
    service === 'GOOGLE_GMAIL' && mockHarness.baseUrl !== undefined ? { ...creds, baseUrl: mockHarness.baseUrl } : creds,
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { google } from 'googleapis';

import { createGmailAdapter } from '../index';
import { createGmailPollSource } from '../poll';
import { recordingServer, replayingServer, requestOf, type Exchange, type ExchangeRequest } from '../../__test__/parity/exchange';
import { bootFakeChannels } from '../../__test__/parity/fake_channels';
import { PARITY_ACCESS_TOKEN, PARITY_MAILBOX, PARITY_SEED, REFUSED, runParityScript, type ParitySubject, type TranscriptEntry } from './parity/script';

// gaxios finds its fetch (node-fetch) by a dynamic import, which jest's VM
// refuses: the legacy line is handed Node's own fetch instead.
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

const TEAM = 'team-parity' as TeamId;
const CREDENTIAL = 'cred-parity';
/** Far from expiry, so no subject ever refreshes. */
const EXPIRES_AT = Date.UTC(2099, 0, 1);
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];

type Shape = 'oauth' | 'delegated';
const SHAPES: readonly Shape[] = ['oauth', 'delegated'];
const fixtureOf = (shape: Shape) => join(__dirname, `__fixtures__/gmail_parity_${shape}.json`);

/** The stored row the connect flow writes, by shape. */
function storeRow(shape: Shape): void {
  switch (shape) {
    case 'oauth':
      mockRow.app_id = 'gmail-oauth-mailbox';
      mockRow.payload = { mailbox: PARITY_MAILBOX, accessToken: PARITY_ACCESS_TOKEN, refreshToken: 'parity-refresh', expiresAt: EXPIRES_AT, grantedScopes: SCOPES };
      return;
    case 'delegated':
      mockRow.app_id = 'gmail-delegated';
      mockRow.payload = { mailbox: PARITY_MAILBOX };
      return;
  }
}

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

const BOUNDARY = /=_listen_fire_[0-9a-f]{32}/g;

/** A send as its message: boundaries numbered in order, the time blanked. */
function normalizeSend(request: ExchangeRequest): ExchangeRequest {
  const body = request.body;
  const raw: unknown = body !== null && typeof body === 'object' ? Reflect.get(body, 'raw') : undefined;
  if (typeof raw !== 'string') return request;
  const numbered = new Map<string, string>();
  const message = Buffer.from(raw, 'base64url')
    .toString('utf8')
    .replace(BOUNDARY, (boundary) => {
      if (!numbered.has(boundary)) numbered.set(boundary, `=_boundary_${numbered.size + 1}`);
      return numbered.get(boundary) ?? boundary;
    })
    .replace(/^Date: .*$/m, 'Date: <date>');
  return { ...request, body: { ...(body as Record<string, unknown>), raw: message } };
}

/** Delegated, under the dev loop: no token was ever minted, so the request's
 *  authentication is not part of what is compared. */
function withoutAuth(request: ExchangeRequest): ExchangeRequest {
  const path = request.path.replace(/([?&])key=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return { ...request, path, authorization: null };
}

const normalizerOf = (shape: Shape) => (shape === 'delegated' ? (r: ExchangeRequest) => withoutAuth(normalizeSend(r)) : normalizeSend);

/** The legacy line: its factories, over the old credential path (the stored
 *  row is the one thing replaced). */
function legacySubject(shape: Shape, baseUrl: string): ParitySubject {
  storeRow(shape);
  mockHarness.baseUrl = baseUrl;
  const source = createGmailPollSource({ teamId: TEAM, credentialsId: CREDENTIAL });
  return {
    adapter: () => createGmailAdapter({ teamId: TEAM, credentialsId: CREDENTIAL }),
    poll: (input) => source.getEvents(input),
  };
}

jest.setTimeout(180_000);

const recording = process.env.GMAIL_PARITY_RECORD === '1';
const previousAllowlist = process.env.GMAIL_MAILBOX_ALLOWLIST;
beforeAll(() => {
  // Delegation refuses every mailbox while the list is unset.
  process.env.GMAIL_MAILBOX_ALLOWLIST = PARITY_MAILBOX;
});
afterAll(() => {
  if (previousAllowlist === undefined) delete process.env.GMAIL_MAILBOX_ALLOWLIST;
  else process.env.GMAIL_MAILBOX_ALLOWLIST = previousAllowlist;
});

describe.each(SHAPES)('gmail recorded parity (%s)', (shape) => {
  (recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
    const fake = await bootFakeChannels({ file: 'gmail', factory: 'gmailRoutes', mount: '/' });
    try {
      for (const message of PARITY_SEED) {
        const seeded = await fetch(`${fake.baseUrl}/fake-gmail/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
        });
        if (!seeded.ok) throw new Error(`seeding ${String(message.id)} failed: ${seeded.status}`);
      }
      const proxy = await recordingServer(fake.baseUrl, { normalize: normalizerOf(shape) });
      try {
        const transcript = await runParityScript(legacySubject(shape, proxy.baseUrl));
        const fixture: Recording = { transcript, exchanges: proxy.exchanges() };
        writeFileSync(fixtureOf(shape), `${JSON.stringify(fixture, null, 2)}\n`);
      } finally {
        await proxy.close();
      }
    } finally {
      fake.stop();
    }
  });

  const loadRecording = (): Recording => JSON.parse(readFileSync(fixtureOf(shape), 'utf8')) as Recording;
  const asMultiset = (requests: readonly ExchangeRequest[]): string[] => requests.map((request) => JSON.stringify(request)).sort();

  async function expectParity(subjectAt: (baseUrl: string) => Promise<ParitySubject> | ParitySubject): Promise<void> {
    const recorded = loadRecording();
    const server = await replayingServer(recorded.exchanges, { normalize: normalizerOf(shape) });
    try {
      const transcript = await runParityScript(await subjectAt(server.baseUrl));
      expect(transcript).toEqual(recorded.transcript);
      expect(asMultiset(server.requests())).toEqual(asMultiset(recorded.exchanges.map(requestOf)));
    } finally {
      await server.close();
    }
  }

  (recording ? describe.skip : describe)('replay', () => {
    it('the recording walks the whole surface and fails only where it should', () => {
      const { transcript } = loadRecording();
      const failed = (entry: TranscriptEntry) => entry.answer !== null && typeof entry.answer === 'object' && 'error' in entry.answer;
      expect(transcript.filter((entry) => failed(entry) !== entry.step.startsWith(REFUSED)).map((entry) => entry.step)).toEqual([]);
    });

    it('the legacy line replays identically', async () => {
      await expectParity((baseUrl) => legacySubject(shape, baseUrl));
    });
  });
});
