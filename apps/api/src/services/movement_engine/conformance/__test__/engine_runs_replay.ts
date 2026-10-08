// The replay of one corpus's recorded runs against the three targets, shared
// by engine_runs.v1 and engine_runs.v2 (see either for what it proves). Each
// runs in its own file because each corpus was recorded with its own current
// language version (the corpus setups mock it), and some of the engine still
// reads the current version rather than the run's pin — so a recording
// replays in the environment it was recorded in.
//
// Under UPDATE_ENGINE_RUNS=1 the replay prunes the fixture instead of judging
// it, keeping only the recordings that are portable: the ones that replay on
// the TypeScript engine both in process and over the HTTP double. One that
// does not depended on something a recording cannot carry — its test's own
// module mocks, an id the engine minted at random, or the host's timing (a
// cancel racing calls still in flight, which a slower host answers later).
// Each one dropped is printed with its first divergence. Run it straight after
// the harvest (`pnpm harvest:engine-runs` does both).

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { hostRecordingSchema, type HostRecording, type ReplayTarget } from 'engine-contracts/conformance';

import { httpTarget, rustTarget, typescriptTarget } from '../replay';

const FIXTURES = path.resolve(__dirname, '../__fixtures__');

/** The fewest recordings each corpus's fixture holds, and the fewest of them
 *  the Rust engine replays whole. Measured at chunk 5A (2026-10-08): v1 320
 *  recordings, 48 on Rust; v2 388, 51 on Rust. Raise them deliberately; never
 *  lower one to pass. */
const FLOORS = {
  v1: { recordings: 315, rust: 45 },
  v2: { recordings: 380, rust: 48 },
} as const;

const fixtureOf = (corpus: keyof typeof FLOORS): string => path.join(FIXTURES, `engine-runs.${corpus}.json`);

function linesOf(corpus: keyof typeof FLOORS): string[] {
  return readFileSync(fixtureOf(corpus), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function recordingOf(corpus: keyof typeof FLOORS, line: string, i: number): HostRecording {
  const parsed = hostRecordingSchema.safeParse(JSON.parse(line));
  if (!parsed.success) throw new Error(`engine-runs.${corpus}.json line ${i + 1}: ${parsed.error.message}`);
  return parsed.data;
}

function recordingsOf(corpus: keyof typeof FLOORS): HostRecording[] {
  return linesOf(corpus).map((line, i) => recordingOf(corpus, line, i));
}

/** Rewrite the fixture with only the recordings that replay on the
 *  TypeScript engine in process and over the HTTP double. */
async function prune(corpus: keyof typeof FLOORS): Promise<void> {
  const kept: string[] = [];
  const dropped: string[] = [];
  const http = await httpTarget();
  try {
    for (const [i, line] of linesOf(corpus).entries()) {
      const recording = recordingOf(corpus, line, i);
      const verdicts = [await typescriptTarget.replay(recording), await http.replay(recording)];
      const failed = verdicts.find((verdict) => verdict.kind !== 'same');
      if (failed === undefined) kept.push(line);
      else dropped.push(`${label(recording, i)}: ${failed.kind === 'diverged' ? failed.divergence : failed.kind === 'skipped' ? failed.reason : ''}`);
    }
  } finally {
    await http.close();
  }
  const text = kept.join('\n') + '\n';
  writeFileSync(fixtureOf(corpus), text);
  console.log(
    `engine-runs.${corpus}.json: kept ${kept.length}, dropped ${dropped.length}, ${Buffer.byteLength(text)} bytes\n${dropped.join('\n')}`,
  );
}

const label = (recording: HostRecording, i: number): string =>
  `#${i + 1} ${recording.entry} ${JSON.stringify(recording.input.source.slice(0, 80))}`;

async function replayAll(target: ReplayTarget, recordings: readonly HostRecording[]) {
  const diverged: string[] = [];
  const skipped = new Map<string, number>();
  let same = 0;
  for (const [i, recording] of recordings.entries()) {
    const verdict = await target.replay(recording);
    switch (verdict.kind) {
      case 'same':
        same += 1;
        break;
      case 'skipped':
        skipped.set(verdict.reason, (skipped.get(verdict.reason) ?? 0) + 1);
        break;
      case 'diverged':
        diverged.push(`${label(recording, i)}: ${verdict.divergence}`);
        break;
    }
  }
  return { same, skipped: Object.fromEntries(skipped), diverged };
}

export function replayCorpus(corpus: keyof typeof FLOORS): void {
  // Hundreds of whole runs per target.
  jest.setTimeout(600_000);
  if (process.env.UPDATE_ENGINE_RUNS === '1') {
    it('keeps only the recordings that replay on the TypeScript engine', async () => {
      await prune(corpus);
    });
    return;
  }
  const recordings = recordingsOf(corpus);
  let http: Awaited<ReturnType<typeof httpTarget>>;

  beforeAll(async () => {
    http = await httpTarget();
  });
  afterAll(async () => {
    await http.close();
  });

  it('are at least the floor', () => {
    expect(recordings.length).toBeGreaterThanOrEqual(FLOORS[corpus].recordings);
  });

  it('replay identically against the TypeScript engine in process', async () => {
    const { diverged } = await replayAll(typescriptTarget, recordings);
    expect(diverged).toEqual([]);
  });

  it('replay identically against the HTTP host double', async () => {
    const { diverged } = await replayAll(http, recordings);
    expect(diverged).toEqual([]);
  });

  it('replay identically against the Rust engine, every recording it runs whole', async () => {
    const { same, skipped, diverged } = await replayAll(rustTarget, recordings);
    console.log(`${corpus}: ${same} of ${recordings.length} recordings replayed on the Rust engine; skipped ${JSON.stringify(skipped)}`);
    expect(diverged).toEqual([]);
    expect(same).toBeGreaterThanOrEqual(FLOORS[corpus].rust);
  });
}
