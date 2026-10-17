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

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { HttpExchange } from '../../__test__/parity_http';
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
  return { postgresSecrets: () => createMemoryVault(Object.fromEntries(storedCredentials)) };
});

// The composition field function's model: a stand-in that answers from what
// it was asked, so the composed text is the recording's.
jest.mock('../../../../../lib/anthropic', () => ({
  anthropicChat: async (input: { model: string; system: string; userMessage: string; label?: string }) =>
    `composed(${input.model}, ${input.label ?? ''}, ${input.system.length}): ${input.userMessage}`,
}));

import { runSlackParityScript } from './parity/script';
import { recordingHttpServer, replayingHttpServer, requestOf } from '../../__test__/parity_http';
import { bootFakeProvider } from '../../__test__/parity_fake';
import { SlackAdapter } from '../index';

const FIXTURE = join(__dirname, '__fixtures__/slack_parity.json');
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

type Recording = Record<InstallName, { transcript: TranscriptEntry[]; exchanges: HttpExchange[] }>;

jest.setTimeout(240_000);

const recording = process.env.SLACK_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeProvider('slack');
  const fixture: Partial<Recording> = {};
  try {
    for (const name of INSTALLS) {
      const proxy = await recordingHttpServer(fake.baseUrl);
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

function loadRecording(): Recording {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recording;
}

async function expectParity(name: InstallName, subjectAt: (baseUrl: string) => Promise<SlackParitySubject> | SlackParitySubject): Promise<void> {
  const recorded = loadRecording()[name];
  const server = await replayingHttpServer(recorded.exchanges);
  try {
    const transcript = await runSlackParityScript(await subjectAt(server.baseUrl));
    expect(transcript).toEqual(recorded.transcript);
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
});
