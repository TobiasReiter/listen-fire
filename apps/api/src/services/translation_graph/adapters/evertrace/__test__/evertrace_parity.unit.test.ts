// Recorded parity for Evertrace. The fixture is the legacy adapter as it was
// before Evertrace became a module, driven through `parity/script.ts` against
// the fake-channels Evertrace: every answer, and every request it made with
// what came back. Each implementation is replayed against the recording and
// must make the same requests (its writes included) and give the same answers.
// The clock is fixed: a new saved search is stamped from it, and a first poll
// takes its mark from it.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// EVERTRACE_PARITY_RECORD=1 pnpm test:unit --testPathPattern evertrace_parity

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { EvertraceApiClient } from '../../../../../adapters/evertrace/apiClient';
import { EvertraceAdapter } from '../index';
import { EvertracePollSource } from '../poll';
import { recordingServer, replayingServer, type Exchange } from '../../dealroom/__test__/parity/exchange';
import { bootFakeEvertrace } from './parity/fake_evertrace';
import { FIXED_NOW } from './parity/fixed_clock.cjs';
import { runParityScript, type ParitySubject, type TranscriptEntry } from './parity/script';

const FIXTURE = join(__dirname, '__fixtures__/evertrace_parity.json');
/** The version header the provider refuses a request without. */
const TRACKED = { headers: ['x-api-version'] };
const API_KEY = 'dev-loop-evertrace-key';
const TEAM = 'team-parity' as TeamId;

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

/** The legacy line's adapter and poll, on a client pointed at `baseUrl` (its
 *  credential path, the decrypted row, is the one thing replaced). */
function legacySubject(baseUrl: string): ParitySubject {
  const client = new EvertraceApiClient({ apiKey: API_KEY, baseUrl });
  return {
    adapter: new EvertraceAdapter(TEAM, undefined, client),
    poll: (input) => new EvertracePollSource(TEAM, undefined, client).getEvents(input),
  };
}

jest.setTimeout(120_000);

const recording = process.env.EVERTRACE_PARITY_RECORD === '1';

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
});
afterEach(() => {
  jest.restoreAllMocks();
});

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeEvertrace();
  const proxy = await recordingServer(fake.baseUrl, TRACKED);
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
  const server = await replayingServer(recorded.exchanges, TRACKED);
  try {
    const transcript = await runParityScript(await subjectAt(server.baseUrl));
    expect(transcript).toEqual(recorded.transcript);
    expect(server.requests()).toEqual(recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request));
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('evertrace recorded parity', () => {
  it('the recording walks the whole surface', () => {
    const { transcript, exchanges } = loadRecording();
    const failed = transcript
      .filter((entry) => entry.answer !== null && typeof entry.answer === 'object' && 'error' in entry.answer)
      .map((entry) => entry.step);
    // The refusals the script probes on purpose; nothing else fails.
    expect(failed.filter((step) => !/Nonexistent|bad filter|no title|no name|one end|create Signal|create Company|List Entry$|bare id|unknown|delete Search missing|update Signal Viewed false|delete Signal/.test(step))).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(60);
    expect(transcript.find((e) => e.step === 'poll signals from the start')?.answer).toMatchObject({ events: expect.arrayContaining([expect.anything()]) });
  });

  it('the legacy line replays identically', async () => {
    await expectParity(legacySubject);
  });
});
