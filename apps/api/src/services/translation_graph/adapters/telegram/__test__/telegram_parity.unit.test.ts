// Recorded parity for Telegram. The fixture is the legacy adapter as it was
// before Telegram became a module, driven through `parity/script.ts` against
// the fake-channels Bot API: every answer, and every request it made with
// what came back. Four installs are recorded, since Telegram reaches its bot
// token three ways:
//   - byo:      the team's own bot (a credential holding a bot token);
//   - empty:    the team connected the platform's shared bot (a credential
//               with no token): the shared token, the credential's base URL;
//   - harness:  no credential at all on the test-harness team: the shared
//               token, the dev loop's fake;
//   - bare:     the team's own bot on a host with no doors and no linked
//               identities (lf), so no handshake steps and no door calls.
// Each implementation is replayed against the recording and must make the
// same requests (its writes) and give the same answers.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// TELEGRAM_PARITY_RECORD=1 pnpm test:unit --testPathPattern telegram_parity

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { HttpExchange } from '../../__test__/parity_http';
import type { TelegramParitySubject, TranscriptEntry } from './parity/script';

// ── The platform's stores, as the test seeds them ───────────────────────────

/** Where the adapter under test reaches Telegram: the recording or replaying
 *  server of the install being run. */
const provider = { baseUrl: '' };

const HARNESS_TEAM = 'team-harness';
jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: (teamId: string) => teamId === HARNESS_TEAM,
  injectFakeBaseUrl: (payload: Record<string, unknown>) => ({ ...payload, baseUrl: provider.baseUrl }),
}));

/** The stored credentials, decrypted, by id. */
const storedCredentials = new Map<string, Record<string, string>>();
jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async (_cipher: unknown, id: string) => JSON.stringify(storedCredentials.get(id) ?? {}),
  encryptToken: async () => '',
}));

/** `telegram_identity`: one linked user per team, Ada (777). */
const LINKED_AT = new Date(Date.UTC(2026, 5, 1, 12));
jest.mock('../../../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: (table: string) => {
      const filters: Record<string, unknown> = {};
      const rows = (): Record<string, unknown>[] => {
        if (table === 'external_service_credentials') {
          const id = filters.id;
          return typeof id === 'string' && storedCredentials.has(id) ? [{ id, credentials: Buffer.from('x') }] : [];
        }
        if (table === 'telegram_identity') {
          const all = [{ team_id: filters.team_id, telegram_user_id: '777', email: 'Ada@Example.com ', linked_at: LINKED_AT }];
          return all.filter((row) => filters.telegram_user_id === undefined || row.telegram_user_id === filters.telegram_user_id);
        }
        throw new Error(`no table ${table} in this test`);
      };
      const builder = {
        where: (column: string, _op: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        select: () => builder,
        orderBy: () => builder,
        execute: async () => rows(),
        executeTakeFirst: async () => rows()[0],
      };
      return builder;
    },
  });
  return { getQb: qb, getAutomationsQb: qb, globalQb: qb };
});

// The platform's encrypted store as the module line reads it: a vault over
// the same stored credentials.
jest.mock('../../../../credentials/secrets_postgres', () => {
  const { createMemoryVault } = jest.requireActual('movement-engine/public/secrets');
  return { postgresSecrets: () => createMemoryVault(Object.fromEntries(storedCredentials)) };
});

import { runTelegramParityScript } from './parity/script';
import { recordingHttpServer, replayingHttpServer, requestOf } from '../../__test__/parity_http';
import { bootFakeProvider } from '../../__test__/parity_fake';
import { TelegramAdapter } from '../index';
import { getAdapter } from '../../registry';
import { BUILTIN_MODULES } from '../../builtin_modules';
import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';

const FIXTURE = join(__dirname, '__fixtures__/telegram_parity.json');
const TEAM = 'team-parity' as TeamId;
const SHARED_TOKEN = 'SHARED-BOT-TOKEN';

type InstallName = 'byo' | 'empty' | 'harness' | 'bare';
const INSTALLS: readonly InstallName[] = ['byo', 'empty', 'harness', 'bare'];

interface Install {
  teamId: TeamId;
  credentialsId?: string;
  /** The stored credential, given where the provider is. */
  credential?: (baseUrl: string) => Record<string, string>;
  hostHasDoors: boolean;
}

const INSTALL: Record<InstallName, Install> = {
  byo: { teamId: TEAM, credentialsId: 'cred-byo', credential: (baseUrl) => ({ botToken: 'BYO-TOKEN', baseUrl }), hostHasDoors: true },
  empty: { teamId: TEAM, credentialsId: 'cred-empty', credential: (baseUrl) => ({ botToken: '', baseUrl }), hostHasDoors: true },
  harness: { teamId: HARNESS_TEAM as TeamId, hostHasDoors: true },
  bare: { teamId: TEAM, credentialsId: 'cred-bare', credential: (baseUrl) => ({ botToken: 'BYO-TOKEN', baseUrl }), hostHasDoors: false },
};

/** Seed the stores for `install` with the provider at `baseUrl`. */
function seed(name: InstallName, baseUrl: string): Install {
  const install = INSTALL[name];
  provider.baseUrl = baseUrl;
  storedCredentials.clear();
  if (install.credentialsId !== undefined && install.credential !== undefined) {
    storedCredentials.set(install.credentialsId, install.credential(baseUrl));
  }
  return install;
}

/** The legacy line, as the registry and the doors construct it. */
function legacySubject(name: InstallName, baseUrl: string): TelegramParitySubject {
  const install = seed(name, baseUrl);
  const adapter = new TelegramAdapter(install.teamId, install.credentialsId);
  return {
    adapter,
    identities: install.hostHasDoors,
    ...(install.hostHasDoors ? { doors: adapter } : {}),
  };
}

type Recording = Record<InstallName, { transcript: TranscriptEntry[]; exchanges: HttpExchange[] }>;

jest.setTimeout(120_000);

const recording = process.env.TELEGRAM_PARITY_RECORD === '1';
let savedToken: string | undefined;
beforeAll(() => {
  savedToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = SHARED_TOKEN;
});
afterAll(() => {
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
});

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeProvider('telegram');
  const fixture: Partial<Recording> = {};
  try {
    for (const name of INSTALLS) {
      const proxy = await recordingHttpServer(fake.baseUrl);
      try {
        const transcript = await runTelegramParityScript(legacySubject(name, proxy.baseUrl));
        fixture[name] = { transcript, exchanges: proxy.exchanges() };
      } finally {
        await proxy.close();
      }
    }
  } finally {
    fake.stop();
  }
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
});

function loadRecording(): Recording {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recording;
}

/** Replay one install against the recording: same answers, same requests. */
async function expectParity(name: InstallName, subjectAt: (baseUrl: string) => Promise<TelegramParitySubject> | TelegramParitySubject): Promise<void> {
  const recorded = loadRecording()[name];
  const server = await replayingHttpServer(recorded.exchanges);
  try {
    const transcript = await runTelegramParityScript(await subjectAt(server.baseUrl));
    expect(transcript).toEqual(recorded.transcript);
    expect(server.requests()).toEqual(recorded.exchanges.map(requestOf));
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('telegram recorded parity', () => {
  it('the recording walks the whole surface and every send reached the provider', () => {
    const fixture = loadRecording();
    for (const name of INSTALLS) {
      const sends = fixture[name].exchanges.filter((exchange) => exchange.path.endsWith('/sendMessage'));
      expect(sends.length).toBe(3);
      const paths = fixture[name].exchanges.map((exchange) => exchange.path);
      expect(paths.some((path) => path.includes('/file/bot'))).toBe(true);
    }
    // The shared bot's token reaches the provider for the empty and harness
    // installs, the team's own for the others.
    expect(fixture.empty.exchanges.every((exchange) => exchange.path.includes(SHARED_TOKEN))).toBe(true);
    expect(fixture.harness.exchanges.every((exchange) => exchange.path.includes(SHARED_TOKEN))).toBe(true);
    expect(fixture.byo.exchanges.every((exchange) => exchange.path.includes('BYO-TOKEN'))).toBe(true);
  });

  it.each(INSTALLS)('the legacy line replays identically (%s)', async (name) => {
    await expectParity(name, (baseUrl) => legacySubject(name, baseUrl));
  });

  it.each(INSTALLS)('the module in process, through the platform registry, replays identically (%s)', async (name) => {
    expect(BUILTIN_MODULES.telegram?.line).toBe('module');
    await expectParity(name, (baseUrl) => {
      const install = seed(name, baseUrl);
      const adapter = getAdapter({ adapterType: 'telegram', teamId: install.teamId, ...(install.credentialsId !== undefined ? { credentialsId: install.credentialsId } : {}) });
      // The doors' two calls, on the module's own adapter.
      const doors = adapter as unknown as TelegramParitySubject['doors'];
      return { adapter, identities: install.hostHasDoors, ...(install.hostHasDoors ? { doors } : {}) };
    });
  });

  // Over the process transport, a file's bytes cross only by URL and the kit
  // hosts none (module-kit server.ts), so both download steps are refused
  // there before the module sees them, and the download's two Bot API
  // requests are not made. Everything else is the
  // recording's.
  it('the module served as a process, over protocol 2, replays identically but for file bytes (bare)', async () => {
    const recorded = loadRecording().bare;
    const DOWNLOADS = new Set(['resolveFileRef document', 'resolveFileRef without a handle']);
    const served = await serveTelegram();
    const server = await replayingHttpServer(recorded.exchanges);
    const nodeFetch = globalThis.fetch;
    globalThis.fetch = sameRealmFetch(nodeFetch);
    try {
      seed('bare', server.baseUrl);
      const credentials = createMemoryVault({ 'cred-bare': { botToken: 'BYO-TOKEN', baseUrl: server.baseUrl } });
      const config = { adapterType: 'telegram', teamId: TEAM, baseUrl: served.url, authStrategy: { kind: 'bearer' as const }, credentialsId: 'cred-bare' };
      const remote = createRemoteAdapter({
        config,
        secret: '',
        cacheScopeId: 'parity',
        manifest: await fetchRemoteManifest(config, ''),
        documents: { put: async () => ({}) } as never,
        credential: { name: 'telegram', secrets: createSecretsFamily({ backend: credentials }), ref: 'cred-bare' },
      });
      const transcript = (await runTelegramParityScript({ adapter: remote, identities: false })).map(unwrapRemoteError);
      for (const download of transcript.filter((entry) => DOWNLOADS.has(entry.step))) {
        expect(JSON.stringify(download.answer)).toContain('serve bytes only by URL');
      }
      const rest = (entries: TranscriptEntry[]) => entries.filter((entry) => !DOWNLOADS.has(entry.step));
      expect(rest(transcript)).toEqual(rest(recorded.transcript));
      const fileLegs = (path: string) => path.endsWith('/getFile') || path.includes('/file/bot');
      expect(server.requests()).toEqual(recorded.exchanges.map(requestOf).filter((request) => !fileLegs(request.path)));
    } finally {
      globalThis.fetch = nodeFetch;
      await server.close();
      served.stop();
    }
  });
});

/** A refusal as the module raised it: the client wraps every error the wire
 *  carries in its method and code, which says nothing about the module. */
function unwrapRemoteError(entry: TranscriptEntry): TranscriptEntry {
  const answer = entry.answer;
  if (answer === null || typeof answer !== 'object' || !('error' in answer) || typeof answer.error !== 'string') return entry;
  const match = /^Remote adapter error for method "[^"]+": adapter_error — (.*)$/s.exec(answer.error);
  return match?.[1] === undefined ? entry : { ...entry, answer: { error: match[1] } };
}

/**
 * Jest runs this file in a realm of its own, and `fetch` answers in Node's:
 * the objects of a parsed answer then fail the engine's plain-object check,
 * which compares prototypes (engine-contracts `isPlainObject`), so a file the
 * remote answered would never be named as this install's. Production has one
 * realm. Parse each answer here instead.
 */
function sameRealmFetch(nodeFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await nodeFetch(input, init);
    const body = await res.text();
    return Object.assign(new Response(body, { status: res.status, headers: res.headers }), {
      json: async (): Promise<unknown> => JSON.parse(body),
    });
  };
}

/** `serve-module @lf/telegram` as a child process. */
async function serveTelegram(): Promise<{ url: string; stop(): void }> {
  const repo = join(__dirname, '../../../../../../../..');
  const child = spawn(process.execPath, [join(repo, 'packages/module-kit/bin/serve-module.cjs'), '.'], {
    cwd: join(repo, 'modules/telegram'),
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
