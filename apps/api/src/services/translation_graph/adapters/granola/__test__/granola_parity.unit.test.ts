// Recorded parity for Granola. The fixture is the legacy adapter as it was
// before Granola became a module, driven through `parity/script.ts` against
// the fake-channels Granola: every answer, and every request it made with
// what came back. Each implementation is replayed against the recording and
// must make the same requests and give the same answers.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// GRANOLA_PARITY_RECORD=1 pnpm test:unit --testPathPattern granola_parity

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { GranolaAdapter } from '../index';
import { GranolaClient } from '../client';
import { GranolaPollSource } from '../poll';
import { recordingServer, replayingServer, type Exchange } from '../../dealroom/__test__/parity/exchange';
import { bootFakeGranola } from './parity/fake_granola';
import { runParityScript, type ParitySubject, type TranscriptEntry } from './parity/script';

const FIXTURE = join(__dirname, '__fixtures__/granola_parity.json');
const API_KEY = 'dev-loop-granola-token';
const TEAM = 'team-parity' as TeamId;

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

/** The legacy line's adapter and poll, on a client pointed at `baseUrl` (its
 *  credential path, the decrypted row, is the one thing replaced). */
function legacySubject(baseUrl: string): ParitySubject {
  const client = new GranolaClient(API_KEY, baseUrl);
  return {
    adapter: new GranolaAdapter(TEAM, undefined, client),
    poll: (input) => new GranolaPollSource(TEAM, undefined, client).getEvents(input),
  };
}

jest.setTimeout(120_000);

const recording = process.env.GRANOLA_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeGranola();
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

(recording ? describe.skip : describe)('granola recorded parity', () => {
  it('the recording walks the whole surface and fails only where the script probes a field that is not there', () => {
    const { transcript, exchanges } = loadRecording();
    const failed = transcript
      .filter((entry) => entry.answer !== null && typeof entry.answer === 'object' && 'error' in entry.answer)
      .map((entry) => entry.step);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.filter((step) => !/\.(Nonexistent|granola_note_id)$/.test(step))).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(15);
    expect(transcript.find((e) => e.step === 'poll from a checkpoint')?.answer).toMatchObject({ events: expect.arrayContaining([expect.anything()]) });
  });

  it('the legacy line replays identically', async () => {
    await expectParity(legacySubject);
  });
});
