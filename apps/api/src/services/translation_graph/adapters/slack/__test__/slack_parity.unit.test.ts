// Recorded parity for Slack. The fixture is the legacy adapter as it was
// before Slack became a module, driven through `parity/script.ts` against
// the fake-channels Slack Web API: every answer, and every request it made
// with what came back. Three installs are recorded:
//   - workspace: a team's connected workspace (a bot token and a base URL);
//   - harness:   the test-harness team's workspace, sent to the dev loop's
//                fake whatever its credential says;
//   - none:      no credential wired (reads that need Slack answer nothing,
//                sends refuse).
// Each implementation is replayed against the recording and must make the
// same requests (its writes) and give the same answers.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// SLACK_PARITY_RECORD=1 pnpm test:unit --testPathPattern slack_parity

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Exchange } from '../../__test__/parity/exchange';
import type { SlackParitySubject, TranscriptEntry } from './parity/script';

// ── The platform's stores, as the test seeds them ───────────────────────────

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

jest.mock('../../../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: (table: string) => {
      const filters: Record<string, unknown> = {};
      const rows = (): Record<string, unknown>[] => {
        if (table !== 'external_service_credentials') throw new Error(`no table ${table} in this test`);
        const id = filters.id;
        return typeof id === 'string' && storedCredentials.has(id) ? [{ id, credentials: Buffer.from('x') }] : [];
      };
      const builder = {
        where: (column: string, _op: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        select: () => builder,
        execute: async () => rows(),
        executeTakeFirst: async () => rows()[0],
      };
      return builder;
    },
  });
  return { getQb: qb, getAutomationsQb: qb, globalQb: qb };
});

jest.mock('../../../../credentials/secrets_postgres', () => {
  const { createMemoryVault } = jest.requireActual('movement-engine/public/secrets');
  return {
    ...jest.requireActual('../../../../credentials/secrets_postgres'),
    postgresSecrets: () => createMemoryVault(Object.fromEntries(storedCredentials)),
  };
});

// The composition field function's model: a stand-in that answers from what
// it was asked, so the composed text is the recording's.
jest.mock('../../../../../lib/anthropic', () => ({
  anthropicChat: async (input: { model: string; system: string; userMessage: string; label?: string }) =>
    `composed(${input.model}, ${input.label ?? ''}, ${input.system.length}): ${input.userMessage}`,
}));

import { runSlackParityScript } from './parity/script';
import { recordingServer, replayingServer, requestOf, type ExchangeOptions } from '../../__test__/parity/exchange';
import { bootFakeChannels } from '../../__test__/parity/fake_channels';
import { SlackAdapter } from '../index';
import { getAdapter } from '../../registry';
import { BUILTIN_MODULES, builtinModuleInboundVerifier } from '../../builtin_modules';
import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';

const FIXTURE = join(__dirname, '__fixtures__/slack_parity.json');
/** Chat providers take form-encoded bodies and file bytes: a request's
 *  content type is part of what it asked for. */
const EXCHANGE: ExchangeOptions = { headers: ['content-type'] };
const TEAM = 'team-parity' as TeamId;

type InstallName = 'workspace' | 'harness' | 'none';
const INSTALLS: readonly InstallName[] = ['workspace', 'harness', 'none'];

interface Install {
  teamId: TeamId;
  credentialsId?: string;
  credential?: (baseUrl: string) => Record<string, string>;
}

const INSTALL: Record<InstallName, Install> = {
  workspace: { teamId: TEAM, credentialsId: 'cred-ws', credential: (baseUrl) => ({ accessToken: 'xoxb-parity', teamId: 'T1', baseUrl }) },
  harness: { teamId: HARNESS_TEAM as TeamId, credentialsId: 'cred-harness', credential: () => ({ accessToken: 'xoxb-harness' }) },
  none: { teamId: TEAM },
};

function seed(name: InstallName, baseUrl: string): Install {
  const install = INSTALL[name];
  provider.baseUrl = baseUrl;
  storedCredentials.clear();
  if (install.credentialsId !== undefined && install.credential !== undefined) {
    storedCredentials.set(install.credentialsId, install.credential(baseUrl));
  }
  return install;
}

function legacySubject(name: InstallName, baseUrl: string): SlackParitySubject {
  const install = seed(name, baseUrl);
  return { adapter: new SlackAdapter(install.teamId, install.credentialsId), compose: true };
}

type Recording = Record<InstallName, { transcript: TranscriptEntry[]; exchanges: Exchange[] }>;

jest.setTimeout(240_000);

const recording = process.env.SLACK_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeChannels({ file: 'slack', factory: 'slackRoutes', mount: '/slack' });
  const fixture: Partial<Recording> = {};
  try {
    for (const name of INSTALLS) {
      const proxy = await recordingServer(fake.baseUrl, EXCHANGE);
      try {
        const transcript = await runSlackParityScript(legacySubject(name, proxy.baseUrl));
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

/** The module's refusal for an install with no credential ends "Connect
 *  Slack." where the legacy line pointed at an internal wiring step. The one
 *  wording change; everything else is the recording's. */
function moduleRefusals(recorded: TranscriptEntry[]): TranscriptEntry[] {
  return JSON.parse(
    JSON.stringify(recorded).split('. Wire pipeline_output.credentials_id through getAdapter.').join('. Connect Slack.'),
  ) as TranscriptEntry[];
}

function loadRecording(): Recording {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recording;
}

async function expectParity(
  name: InstallName,
  subjectAt: (baseUrl: string) => Promise<SlackParitySubject> | SlackParitySubject,
  expecting: (recorded: TranscriptEntry[]) => TranscriptEntry[] = (recorded) => recorded,
): Promise<void> {
  const recorded = loadRecording()[name];
  const server = await replayingServer(recorded.exchanges, EXCHANGE);
  try {
    const transcript = await runSlackParityScript(await subjectAt(server.baseUrl));
    expect(transcript).toEqual(expecting(recorded.transcript));
    expect(server.requests()).toEqual(recorded.exchanges.map(requestOf));
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('slack recorded parity', () => {
  it('the recording walks the whole surface and every send reached the provider', () => {
    const fixture = loadRecording();
    for (const name of ['workspace', 'harness'] as const) {
      const methods = fixture[name].exchanges.map((exchange) => exchange.path.split('?')[0]);
      for (const method of ['/conversations.list', '/conversations.history', '/conversations.replies', '/users.list', '/users.info', '/chat.postMessage', '/reactions.add', '/files.info']) {
        expect(methods).toContain(method);
      }
      expect(methods.filter((m) => m === '/chat.postMessage').length).toBe(4);
    }
    expect(fixture.none.exchanges).toEqual([]);
  });

  it.each(INSTALLS)('the legacy line replays identically (%s)', async (name) => {
    await expectParity(name, (baseUrl) => legacySubject(name, baseUrl));
  });

  it.each(INSTALLS)('the module in process, through the platform registry, replays identically (%s)', async (name) => {
    expect(BUILTIN_MODULES.slack?.line).toBe('module');
    await expectParity(name, (baseUrl) => {
      const install = seed(name, baseUrl);
      const adapter = getAdapter({ adapterType: 'slack', teamId: install.teamId, ...(install.credentialsId !== undefined ? { credentialsId: install.credentialsId } : {}) });
      return { adapter, compose: true };
    }, moduleRefusals);
  });

  it('the module line declares the inbound the door has always verified', () => {
    expect(builtinModuleInboundVerifier('SLACK')).toBeDefined();
  });

  // Over the process transport there is no model for the composition
  // function (lf runs the module without one), so that one step is refused by
  // name and is left out of the comparison. A file's bytes cross by URL, held
  // by the kit (module-kit served_files.ts), so the one download is the
  // recording's too. Errors arrive wrapped by the client in their method and
  // code.
  it('the module served as a process, over protocol 2, replays identically but for composition (workspace)', async () => {
    const recorded = loadRecording().workspace;
    const served = await serveSlack();
    const server = await replayingServer(recorded.exchanges, { ...EXCHANGE, repeatReads: true });
    const nodeFetch = globalThis.fetch;
    globalThis.fetch = sameRealmFetch(nodeFetch);
    try {
      seed('workspace', server.baseUrl);
      const credentials = createMemoryVault({ 'cred-ws': { accessToken: 'xoxb-parity', teamId: 'T1', baseUrl: server.baseUrl } });
      const config = { adapterType: 'slack', teamId: TEAM, baseUrl: served.url, authStrategy: { kind: 'bearer' as const }, credentialsId: 'cred-ws' };
      const remote = createRemoteAdapter({
        config,
        secret: '',
        cacheScopeId: 'parity',
        manifest: await fetchRemoteManifest(config, ''),
        documents: { put: async () => ({}) } as never,
        credential: { name: 'slack', secrets: createSecretsFamily({ backend: credentials }), ref: 'cred-ws' },
      });
      const transcript = (await runSlackParityScript({ adapter: remote, compose: false })).map(unwrapRemoteError);
      const rest = (entries: TranscriptEntry[]) => entries.filter((entry) => entry.step !== 'invokeFieldFunction SLACK_MESSAGE');
      expect(rest(transcript)).toEqual(rest(recorded.transcript));
      // The transport repeats some reads: the client describes a type before
      // naming a file a field answered (RemoteAdapter.getFieldValue), and
      // Slack's Channel description lists the live channels; the kit pages a
      // walk by re-asking it. Every recorded request is made, and the only
      // others are repeats of those reads — never a write.
      const expected = recorded.exchanges.map(requestOf);
      const extras = [...server.requests()];
      for (const request of expected) {
        const at = extras.findIndex((made) => JSON.stringify(made) === JSON.stringify(request));
        expect(at).toBeGreaterThanOrEqual(0);
        extras.splice(at, 1);
      }
      const REPEATABLE_READS = new Set(['/conversations.list', '/conversations.history', '/conversations.replies']);
      expect(extras.filter((made) => !REPEATABLE_READS.has(made.path))).toEqual([]);
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
 * which compares prototypes (engine-contracts `isPlainObject`). Production has
 * one realm. Parse each answer here instead.
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

/** `serve-module @lf/slack` as a child process. */
async function serveSlack(): Promise<{ url: string; stop(): void }> {
  const repo = join(__dirname, '../../../../../../../..');
  const child = spawn(process.execPath, [join(repo, 'packages/module-kit/bin/serve-module.cjs'), '.'], {
    cwd: join(repo, 'modules/slack'),
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
