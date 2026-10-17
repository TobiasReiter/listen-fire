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

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import type { DocumentStore } from 'movement-engine/public/files';

import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';
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

  it('the module served as a process, over protocol 2, replays identically', async () => {
    // Jest gives the sandbox its own `Object`, and fetch's JSON is built with
    // the outer one, so a plain object off the wire is "not plain" to the code
    // that reads files. Parse in the sandbox, as every real process does.
    const outerJson = Response.prototype.json;
    Response.prototype.json = async function json(this: Response) {
      return JSON.parse(await this.text());
    };
    const served = await serveDropbox();
    const documents = await exposingDocuments();
    try {
      await expectParity(async (at) => {
        const credentials = createMemoryVault({
          'cred-parity': {
            access_token: 'parity-access-token',
            refresh_token: 'parity-refresh-token',
            expires_at: new Date(EXPIRES_AT).toISOString(),
            baseUrl: at,
          },
        });
        const config = { adapterType: 'dropbox', teamId: TEAM, baseUrl: served.url, authStrategy: { kind: 'bearer' as const }, credentialsId: 'cred-parity' };
        return {
          // A failure crosses the wire wrapped in the transport's own words.
          messageOf: (error) => (error instanceof Error ? error.message : String(error)).replace(/^Remote adapter error for method "\w+": \w+ — /, ''),
          adapter: createRemoteAdapter({
            config,
            secret: '',
            cacheScopeId: 'parity',
            manifest: await fetchRemoteManifest(config, ''),
            documents: documents.store,
            credential: { name: 'dropbox', secrets: createSecretsFamily({ backend: credentials }), ref: 'cred-parity' },
          }),
        };
      });
    } finally {
      Response.prototype.json = outerJson;
      served.stop();
      await documents.close();
    }
  });
});

/** `serve-module .` in modules/dropbox, as a child process. */
async function serveDropbox(): Promise<{ url: string; stop(): void }> {
  const repo = join(__dirname, '../../../../../../../..');
  const child = spawn(process.execPath, [join(repo, 'packages/module-kit/bin/serve-module.cjs'), '.'], {
    cwd: join(repo, 'modules/dropbox'),
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

/** A document store that only exposes: the bytes a write carries into the
 *  served module are put at a URL the module fetches, as the host does. */
async function exposingDocuments(): Promise<{ store: DocumentStore; close(): Promise<void> }> {
  const exposed = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    const bytes = exposed.get(req.url ?? '');
    res.writeHead(bytes === undefined ? 404 : 200).end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const store: DocumentStore = {
    put: async () => {
      throw new Error('not used');
    },
    owns: async () => false,
    open: async () => {
      throw new Error('not used');
    },
    expose: async ({ stream }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const path = `/exposed/${exposed.size}`;
      exposed.set(path, Buffer.concat(chunks));
      return { url: `${origin}${path}` };
    },
  };
  return { store, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
