// Recorded parity for Airtable. The fixture is the legacy adapter as it was
// before Airtable became a module, driven through `parity/script.ts` against
// the fake-channels Airtable: every answer, and every request it made with
// what came back. Each implementation is replayed against the recording and
// must make the same requests and give the same answers.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// AIRTABLE_PARITY_RECORD=1 pnpm test:unit --testPathPattern airtable_parity

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => (await import('../../__test__/crm_parity/legacy_row')).decryptSeededRow(),
  encryptToken: async () => '',
}));
jest.mock('../../../../../lib/kysely', () => ({
  getAutomationsQb: () => jest.requireActual<typeof import('../../__test__/crm_parity/legacy_row')>('../../__test__/crm_parity/legacy_row').rowQueryBuilder(),
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Adapter } from 'movement-engine/public/adapter';

import { createAirtableAdapter } from '..';
import { recordingServer, replayingServer, type Exchange } from '../../dealroom/__test__/parity/exchange';
import { bootFakeCrm } from '../../__test__/crm_parity/fake_channels';
import { legacyRow } from '../../__test__/crm_parity/legacy_row';
import { freezeClock, type TranscriptEntry } from '../../__test__/crm_parity/walk';
import { runAirtableParityScript, type InjectChange } from './parity/script';

const FIXTURE = join(__dirname, '__fixtures__/airtable_parity.json');
/** The stored payload the connect flow writes, unexpired at the frozen clock. */
const STORED = {
  accessToken: 'dev-loop-airtable-token',
  refreshToken: 'dev-loop-airtable-refresh',
  accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
  refreshTokenExpiresAt: '2030-06-01T00:00:00.000Z',
};

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

interface Subject {
  adapter: Adapter;
  scoped: Adapter;
}

let subjects = 0;
/** A team and credential of its own per subject: the legacy line caches its
 *  catalog by team and its client by credential id. */
function freshInstall(): { teamId: TeamId; credentialsId: string } {
  subjects += 1;
  return { teamId: `team-parity-${subjects}` as TeamId, credentialsId: `cred-parity-${subjects}` };
}

/** The legacy line, its credential row pointed at `baseUrl`. */
function legacySubject(baseUrl: string): Subject {
  const install = freshInstall();
  legacyRow.payload = { ...STORED, baseUrl };
  legacyRow.id = install.credentialsId;
  return { adapter: createAirtableAdapter(install), scoped: createAirtableAdapter({ ...install, base: 'Pipeline Tracker' }) };
}

jest.setTimeout(120_000);
beforeAll(freezeClock);
afterAll(() => jest.useRealTimers());

const recording = process.env.AIRTABLE_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeCrm('airtable');
  const proxy = await recordingServer(fake.baseUrl);
  const inject: InjectChange = async ({ webhookId, body }) => {
    const answer = await fetch(`${fake.baseUrl}/v0/bases/appTEST001/webhooks/${webhookId}/payloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!answer.ok) throw new Error(`inject: ${answer.status} ${await answer.text()}`);
  };
  try {
    const { adapter, scoped } = legacySubject(proxy.baseUrl);
    const transcript = await runAirtableParityScript(adapter, scoped, inject);
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
async function expectAirtableParity(subjectAt: (baseUrl: string) => Promise<Subject> | Subject): Promise<void> {
  const recorded = loadRecording();
  const server = await replayingServer(recorded.exchanges);
  try {
    const { adapter, scoped } = await subjectAt(server.baseUrl);
    const transcript = await runAirtableParityScript(adapter, scoped);
    expect(transcript).toEqual(recorded.transcript);
    expect(server.requests()).toEqual(recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request));
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('airtable recorded parity', () => {
  it('the recording walks the whole surface, writes, pulls a ping, and fails nowhere', () => {
    const { transcript, exchanges } = loadRecording();
    const errors = transcript.filter((entry) => {
      const answer = entry.answer;
      return answer !== null && typeof answer === 'object' && 'error' in answer;
    });
    expect(errors).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(15);
    const ping = transcript.find((entry) => entry.step === 'preprocessInbound ping')?.answer as { events: unknown[] } | undefined;
    expect(ping?.events.length).toBeGreaterThan(0);
  });

  it('the legacy line replays identically', async () => {
    await expectAirtableParity(legacySubject);
  });
});
