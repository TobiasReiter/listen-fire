// Recorded parity for Affinity. The fixture is the legacy adapter as it was
// before Affinity became a module, driven through `parity/script.ts` against
// the fake-channels Affinity: every answer, every request it made with what
// came back, and every model call (the model is the host's, so its calls are
// requests too). Each implementation is replayed against the recording and
// must make the same requests and model calls and give the same answers.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// AFFINITY_PARITY_RECORD=1 pnpm test:unit --testPathPattern affinity_parity

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => (await import('../../__test__/crm_parity/legacy_row')).decryptSeededRow(),
  encryptToken: async () => '',
}));
jest.mock('../../../../../lib/kysely', () => ({
  getAutomationsQb: () => jest.requireActual<typeof import('../../__test__/crm_parity/legacy_row')>('../../__test__/crm_parity/legacy_row').rowQueryBuilder(),
}));
jest.mock('../../../../../lib/anthropic', () => {
  const canned = jest.requireActual<typeof import('../../__test__/crm_parity/legacy_row')>('../../__test__/crm_parity/legacy_row');
  return { anthropicChat: async (input: never) => canned.cannedChat(input), anthropicChatStructured: async (input: never) => canned.cannedStructured(input) };
});
jest.mock('../../../../../lib/slack', () => ({ sendSlackNotification: async () => undefined }));

// The platform's encrypted store, as a vault the test seeds: the module line
// reads its credential through the secrets family exactly as in production.
const vault: { current?: ReturnType<typeof import('movement-engine/public/secrets').createMemoryVault> } = {};
jest.mock('../../../../credentials/secrets_postgres', () => ({
  postgresSecrets: () => {
    if (vault.current === undefined) throw new Error('no vault seeded');
    return vault.current;
  },
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AddressInfo } from 'node:net';
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { ModuleModels } from 'module-kit';

import { serveModule } from 'module-kit';
import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';
import { affinityModule } from '@lf/affinity';
import { createAffinityAdapter } from '..';
import { getAdapter } from '../../registry';
import { BUILTIN_MODULES } from '../../builtin_modules';
import { recordingServer, replayingServer, type Exchange } from '../../dealroom/__test__/parity/exchange';
import { bootFakeCrm } from '../../__test__/crm_parity/fake_channels';
import { cannedChat, cannedStructured, legacyRow, modelCalls, type ModelCall } from '../../__test__/crm_parity/legacy_row';
import { freezeClock, unwrappedRemoteErrors, type TranscriptEntry } from '../../__test__/crm_parity/walk';
import type { Adapter } from 'movement-engine/public/adapter';
import { runAffinityParityScript } from './parity/script';

const FIXTURE = join(__dirname, '__fixtures__/affinity_parity.json');
const API_KEY = 'dev-loop-affinity-key';

let subjects = 0;
/** A team and credential of its own per subject. */
function freshInstall(): { teamId: TeamId; credentialsId: string } {
  subjects += 1;
  return { teamId: `team-parity-${subjects}` as TeamId, credentialsId: `cred-parity-${subjects}` };
}

/** The models a host serving the module lends it: the same canned answers. */
const cannedModels: ModuleModels = {
  chat: async (input) => cannedChat(input),
  chatStructured: async (input) => input.schema.parse(cannedStructured(input)),
};

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
  modelCalls: ModelCall[];
}

/** The legacy line, its credential row pointed at `baseUrl`. */
function legacySubject(baseUrl: string): Adapter {
  const install = freshInstall();
  legacyRow.payload = { apiKey: API_KEY, baseUrl };
  legacyRow.id = install.credentialsId;
  return createAffinityAdapter(install);
}

jest.setTimeout(120_000);
beforeAll(freezeClock);
afterAll(() => jest.useRealTimers());

const recording = process.env.AFFINITY_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeCrm('affinity');
  const proxy = await recordingServer(fake.baseUrl);
  try {
    modelCalls.length = 0;
    const transcript = await runAffinityParityScript(legacySubject(proxy.baseUrl));
    const fixture: Recording = { transcript, exchanges: proxy.exchanges(), modelCalls: [...modelCalls] };
    writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  } finally {
    await proxy.close();
    fake.stop();
  }
});

function loadRecording(): Recording {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recording;
}

/** Replay `subjectAt` against the recording: same answers, requests, model calls. */
async function expectAffinityParity(subjectAt: (baseUrl: string) => Promise<Adapter> | Adapter): Promise<void> {
  const recorded = loadRecording();
  const server = await replayingServer(recorded.exchanges);
  try {
    modelCalls.length = 0;
    const transcript = await runAffinityParityScript(await subjectAt(server.baseUrl));
    expect(unwrappedRemoteErrors(transcript)).toEqual(recorded.transcript);
    expect(server.requests()).toEqual(recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request));
    expect(modelCalls).toEqual(recorded.modelCalls);
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('affinity recorded parity', () => {
  it('the recording walks the whole surface, writes, and fails nowhere it should not', () => {
    const { transcript, exchanges, modelCalls: calls } = loadRecording();
    const errors = transcript.filter((entry) => {
      const answer = entry.answer;
      return answer !== null && typeof answer === 'object' && 'error' in answer;
    });
    // The one refusal is the legacy adapter's own, reached twice: a list's
    // person-reference field is published as an edge but is not walkable (it
    // is written by link).
    expect(new Set(errors.map((entry) => (entry.answer as { error: string }).error))).toEqual(
      new Set(['AffinityAdapter.getRelated: field "Owners" is not a reference on List Entry — Pipeline.']),
    );
    expect(exchanges.length).toBeGreaterThan(30);
    expect(exchanges.some((e) => e.method === 'POST')).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('the legacy line replays identically', async () => {
    await expectAffinityParity(legacySubject);
  });

  it('the module in process, through the platform registry, replays identically', async () => {
    expect(BUILTIN_MODULES.affinity?.line).toBe('module');
    await expectAffinityParity((baseUrl) => {
      const install = freshInstall();
      vault.current = createMemoryVault({ [install.credentialsId]: { apiKey: API_KEY, baseUrl } });
      return getAdapter({ adapterType: 'affinity', ...install });
    });
  });

  it('the module served over protocol 2, lent the same models, replays identically', async () => {
    const served = await serveModule({ definition: affinityModule, models: cannedModels });
    const { port } = served.server.address() as AddressInfo;
    try {
      await expectAffinityParity(async (baseUrl) => {
        const install = freshInstall();
        const credentials = createMemoryVault({ [install.credentialsId]: { apiKey: API_KEY, baseUrl } });
        const config = { adapterType: 'affinity', ...install, baseUrl: `http://127.0.0.1:${port}/`, authStrategy: { kind: 'bearer' as const } };
        return createRemoteAdapter({
          config,
          secret: '',
          cacheScopeId: install.credentialsId,
          manifest: await fetchRemoteManifest(config, ''),
          documents: { put: async () => ({}) } as never,
          credential: { name: 'affinity', secrets: createSecretsFamily({ backend: credentials }), ref: install.credentialsId },
        });
      });
    } finally {
      served.server.close();
    }
  });
});
