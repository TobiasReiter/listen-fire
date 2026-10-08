// The replay of one corpus's recorded runs against the three targets, shared
// by engine_runs.v1 and engine_runs.v2 (see either for what it proves).
//
// Under UPDATE_ENGINE_RUNS=1 the replay checks the harvest instead of judging
// it: every recording must replay on the TypeScript engine both in process
// and over the HTTP double, save the ones a known reason accounts for
// (`UNPORTABLE`, each with its count per corpus), which are dropped from the
// fixture. Anything else fails the harvest, naming each recording and its
// first divergence. Run it straight after the harvest (`pnpm
// harvest:engine-runs` does both).

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalJson, hostRecordingSchema, type HostRecording, type ReplayTarget, type ReplayVerdict } from 'engine-contracts/conformance';

import { httpTarget, rustTarget, typescriptTarget } from '../replay';

const FIXTURES = path.resolve(__dirname, '../__fixtures__');

/** The fewest recordings each corpus's fixture holds, and the fewest of them
 *  the Rust engine replays whole. Measured at chunk 5A, Task 3b fix round 1
 *  (2026-10-08): v1 443 recordings, 62 on Rust; v2 542, 68 on Rust. Raise
 *  them deliberately; never lower one to pass. */
const FLOORS = {
  v1: { recordings: 443, rust: 62 },
  v2: { recordings: 542, rust: 68 },
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

/**
 * The recordings that cannot replay anywhere but where they were recorded,
 * by why — each a reason a recording cannot carry — and how many of each
 * corpus's recordings it accounts for. Asserted exactly: a new one, or one
 * fewer, fails the harvest until this says why.
 */
const UNPORTABLE: Array<{
  reason: string;
  matches: (recording: HostRecording, verdict: Extract<ReplayVerdict, { kind: 'diverged' | 'skipped' }>) => boolean;
  count: Record<keyof typeof FLOORS, number>;
}> = [
  {
    // The test mocks the language release (v1 unsupported; v1 deprecated) for
    // itself alone, and a recording cannot carry a module mock.
    reason: "the test mocks the release's supported and deprecated language versions",
    matches: (recording) =>
      recording.failure?.code === 'MOVENG_LANGUAGE_VERSION' ||
      JSON.stringify(recording.result ?? null).includes('"code":"MOV_LANGUAGE_VERSION_DEPRECATED"'),
    count: { v1: 0, v2: 2 },
  },
  {
    // An engine non-determinism not yet fixed: an extraction mints its call
    // sites' ids (`x:<node>#<n>`, part of the prompt) in the order its
    // concurrent sibling entities reach them, so a host that answers at
    // another speed sees another numbering. Matched only where the replayed
    // request is a recorded one but for its site ids.
    reason: 'an extraction numbers its call sites in the order concurrent sibling entities reach them',
    matches: (recording, verdict) => differsOnlyInSiteIds(recording, verdict),
    count: { v1: 2, v2: 2 },
  },
];

/** An extraction call site's id, as a prompt and its reply carry it. */
const SITE_ID = /x:[a-z0-9_]+#\d+/;
const maskSites = (text: string): string => text.replace(new RegExp(SITE_ID.source, 'g'), 'x:<site>');

/** True when the replay made a request with no recorded counterpart that a
 *  recorded request matches once both sides' call-site ids are masked. */
function differsOnlyInSiteIds(
  recording: HostRecording,
  verdict: Extract<ReplayVerdict, { kind: 'diverged' | 'skipped' }>,
): boolean {
  if (verdict.kind !== 'diverged' || verdict.unmatched === undefined) return false;
  const { path, args } = verdict.unmatched;
  const replayed = canonicalJson(args);
  if (!SITE_ID.test(replayed)) return false;
  return recording.requests.some(
    (request) => `${request.family}.${request.method}` === path && maskSites(canonicalJson(request.args)) === maskSites(replayed),
  );
}

/** Check the harvested fixture: every recording replays on the TypeScript
 *  engine in process and over the HTTP double, or a known reason accounts
 *  for it. Rewrites the fixture without the accounted ones. */
async function checkHarvest(corpus: keyof typeof FLOORS): Promise<void> {
  const kept: string[] = [];
  const unexplained: string[] = [];
  const accounted = new Map<string, number>();
  const http = await httpTarget();
  try {
    for (const [i, line] of linesOf(corpus).entries()) {
      const recording = recordingOf(corpus, line, i);
      const verdicts = [await typescriptTarget.replay(recording), await http.replay(recording)];
      const failed = verdicts.find((verdict) => verdict.kind !== 'same');
      if (failed === undefined) {
        kept.push(line);
        continue;
      }
      const divergence = failed.kind === 'diverged' ? failed.divergence : failed.reason;
      const known = UNPORTABLE.find((entry) => entry.matches(recording, failed));
      if (known === undefined) unexplained.push(`${label(recording, i)}: ${divergence}`);
      else accounted.set(known.reason, (accounted.get(known.reason) ?? 0) + 1);
    }
  } finally {
    await http.close();
  }
  expect(unexplained).toEqual([]);
  expect(Object.fromEntries(accounted)).toEqual(
    Object.fromEntries(UNPORTABLE.filter((entry) => entry.count[corpus] > 0).map((entry) => [entry.reason, entry.count[corpus]])),
  );
  const text = kept.join('\n') + '\n';
  writeFileSync(fixtureOf(corpus), text);
  console.log(`engine-runs.${corpus}.json: kept ${kept.length}, dropped ${[...accounted.values()].reduce((a, b) => a + b, 0)}, ${Buffer.byteLength(text)} bytes`);
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
    it('every harvested recording replays on the TypeScript engine, or a known reason says why not', async () => {
      await checkHarvest(corpus);
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
