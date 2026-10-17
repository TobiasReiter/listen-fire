// Recorded parity for Dealroom. The fixture is today's legacy adapter driven
// through `parity/script.ts` against the fake-channels Dealroom: every answer,
// and every request it made with what came back. Each implementation is then
// replayed against the recording and must make the same requests (its
// writes) and give the same answers.
//
// Re-record (only when the legacy adapter changes on purpose, reading the
// diff): DEALROOM_PARITY_RECORD=1 pnpm test:unit --testPathPattern dealroom_parity

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { getDealroomClient } from '../../../../../adapters/dealroom/apiClient';
import { DealroomAdapter } from '../index';
import { DealroomPollSource } from '../poll';
import { recordingServer, replayingServer, type Exchange } from './parity/exchange';
import { bootFakeDealroom } from './parity/fake_dealroom';
import { runParityScript, type ParitySubject, type TranscriptEntry } from './parity/script';

const FIXTURE = join(__dirname, '__fixtures__/dealroom_parity.json');
const API_KEY = 'dev-loop-dealroom-key';
const TEAM = 'team-parity' as TeamId;

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

/** The legacy adapter and poll source, on a client pointed at `baseUrl`. */
function legacySubject(baseUrl: string): ParitySubject {
  // The client memo is per (key, base URL), so each server gets its own
  // client and pacing gate.
  const client = getDealroomClient(API_KEY, baseUrl);
  return {
    adapter: new DealroomAdapter(TEAM, 'cred-parity', client),
    poll: (input) => new DealroomPollSource(TEAM, 'cred-parity', client).getEvents(input),
  };
}

jest.setTimeout(120_000);

const recording = process.env.DEALROOM_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeDealroom();
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
    expect(server.requests()).toEqual(recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request));
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('dealroom recorded parity', () => {
  it('the recording walks the whole surface and fails nowhere it should not', () => {
    const { transcript, exchanges } = loadRecording();
    const errors = transcript.filter((entry) => {
      const answer = entry.answer;
      return answer !== null && typeof answer === 'object' && 'error' in answer;
    });
    expect(errors).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(20);
    expect(transcript.find((e) => e.step === 'poll from a checkpoint')?.answer).toMatchObject({ events: expect.arrayContaining([expect.anything()]) });
  });

  it('legacy replays identically (the recording is deterministic)', async () => {
    await expectParity(legacySubject);
  });
});
