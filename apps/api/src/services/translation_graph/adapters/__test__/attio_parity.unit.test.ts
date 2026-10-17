// Recorded parity for Attio. The fixture is the legacy adapter as it was
// before Attio became a module, driven through `parity/script.ts` against
// the fake-channels Attio: every answer, and every request it made with
// what came back. Each implementation is replayed against the recording and
// must make the same requests and give the same answers.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// ATTIO_PARITY_RECORD=1 pnpm test:unit --testPathPattern attio_parity

jest.mock('../../../../lib/credentials', () => ({
  decryptToken: async () => (await import('./crm_parity/legacy_row')).decryptSeededRow(),
  encryptToken: async () => '',
}));
jest.mock('../../../../lib/kysely', () => ({
  getAutomationsQb: () => jest.requireActual<typeof import('./crm_parity/legacy_row')>('./crm_parity/legacy_row').rowQueryBuilder(),
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { Adapter } from 'movement-engine/public/adapter';

import { createAttioAdapter } from '../attio';
import { recordingServer, replayingServer, type Exchange } from '../dealroom/__test__/parity/exchange';
import { bootFakeCrm } from './crm_parity/fake_channels';
import { legacyRow } from './crm_parity/legacy_row';
import { freezeClock, type TranscriptEntry } from './crm_parity/walk';
import { runAttioParityScript } from './attio_parity/script';

const FIXTURE = join(__dirname, '__fixtures__/attio_parity.json');
/** The stored payload the connect flow writes. */
const STORED = { accessToken: 'dev-loop-attio-token', apiTokenId: 'token-1' };

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}


let subjects = 0;
/** A team and credential of its own per subject: the legacy line caches its
 *  catalog by team and its client by credential id. */
function freshInstall(): { teamId: TeamId; credentialsId: string } {
  subjects += 1;
  return { teamId: `team-parity-${subjects}` as TeamId, credentialsId: `cred-parity-${subjects}` };
}

/** The legacy line, its credential row pointed at `baseUrl`. */
function legacySubject(baseUrl: string): Adapter {
  const install = freshInstall();
  legacyRow.payload = { ...STORED, baseUrl };
  legacyRow.id = install.credentialsId;
  return createAttioAdapter(install);
}

jest.setTimeout(120_000);
beforeAll(freezeClock);
afterAll(() => jest.useRealTimers());

const recording = process.env.ATTIO_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeCrm('attio');
  const proxy = await recordingServer(fake.baseUrl);
  try {
    const transcript = await runAttioParityScript(legacySubject(proxy.baseUrl));
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
async function expectAttioParity(subjectAt: (baseUrl: string) => Promise<Adapter> | Adapter): Promise<void> {
  const recorded = loadRecording();
  const server = await replayingServer(recorded.exchanges);
  try {
    const transcript = await runAttioParityScript(await subjectAt(server.baseUrl));
    expect(transcript).toEqual(recorded.transcript);
    expect(server.requests()).toEqual(recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request));
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('attio recorded parity', () => {
  it('the recording walks the whole surface, writes, and fails nowhere', () => {
    const { transcript, exchanges } = loadRecording();
    const errors = transcript.filter((entry) => {
      const answer = entry.answer;
      return answer !== null && typeof answer === 'object' && 'error' in answer;
    });
    expect(errors).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(15);
  });

  it('the legacy line replays identically', async () => {
    await expectAttioParity(legacySubject);
  });
});
