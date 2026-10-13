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
import { SUPPORTED_LANGUAGE_VERSIONS, type LanguageVersion } from 'movement-lang';

import { parsePinned } from '../../program_check';
import { rustRunStats } from '../../rust_stats';

const FIXTURES = path.resolve(__dirname, '../__fixtures__');

/** The fewest recordings each corpus's fixture holds, and the fewest of them
 *  the Rust engine replays whole. Measured at chunk 5A, Task 3b fix round 1
 *  (2026-10-08): v1 443 recordings, 62 on Rust; v2 542, 68 on Rust. Raised
 *  at 5B Task 6, the Rust engine on 5A's contracts (2026-10-08): 109 and 126
 *  on Rust, less a margin. Raised at chunk 6A Task 2, file-level declarations
 *  and plugin imports admitted (2026-10-09): 111 and 128 on Rust, less a
 *  margin of 2. Raised at chunk 6A Task 3b, the extraction keyword and plugin
 *  calls in Rust (2026-10-09): 195 and 234 on Rust, less a margin of 2.
 *  Raised at chunk 6A Task 4, folds, EXISTS, IS tests and a record named
 *  twice (2026-10-09): 256 and 313 on Rust, less a margin of 2. Raised at
 *  chunk 7A Task 1, admission walking only what the fired movement reaches
 *  (2026-10-09): 257 and 314 on Rust, less a margin of 2. Raised at chunk 7A
 *  Task 2, calls and the graphs a run builds (2026-10-09): 312 and 379 on
 *  Rust, less a margin of 2. Raised at chunk 7A Task 3, records held as
 *  values (2026-10-09): 346 and 429 on Rust, less a margin of 2. Raised at
 *  chunk 7A Task 4, awaits and parallel with parks (2026-10-10): 392 and
 *  475 on Rust, less a margin of 2. Raised at chunk 7A Task 7 (2026-10-11),
 *  the Rust target judging every run it ran to an ending by its verdict (a
 *  mid-run named failure included, once skipped unlabelled) and the runs
 *  that fail their check before a segment opens (once skipped as "not
 *  routed by the shim"): 430 and 519 on Rust, less a margin of 2. PLAN-08A
 *  Task 1 fix round 1 (2026-10-12) drops the margin: floors and ceilings
 *  move together with the measurement; never a margin. The floors are the
 *  measured 430 and 519, raised to the new measurement by the commit that
 *  lifts runs. Never lower one to pass. PLAN-08A Task 2 (a head off a kept
 *  walk runs, 2026-10-12): 431 and 520. */
const FLOORS = {
  v1: { recordings: 443, rust: 431 },
  v2: { recordings: 542, rust: 520 },
} as const;

/** The most recordings the Rust target may skip (one its engine refused or
 *  declined, so the TypeScript ran it), by corpus and by the skip's reason,
 *  as the teardown's every-reason ceilings are, so one reason cannot swap
 *  for another unseen (PLAN-08A Task 1, 2026-10-12): the skips measured
 *  then, v1 13 of 443 and v2 23 of 542; v1 12 and v2 22 since PLAN-08A Task
 *  2 (`block_head_value_root` retired). A reason not named here may skip
 *  nothing. Each task that closes a refusal lowers them; a ceiling never
 *  rises. At none the Rust target skips nothing (`skipped` is `{}`). */
const RUST_SKIP_CEILING: Record<keyof typeof FLOORS, Record<string, number>> = {
  v1: {
    'the Rust engine refused it: block_head_resources': 5,
    'the Rust engine refused it: function:chunks': 3,
    'the Rust engine refused it: write_root_not_held': 2,
    'the Rust engine refused it: block_multi_hop': 2,
  },
  v2: {
    'the Rust engine refused it: block_head_resources': 8,
    'the Rust engine refused it: import_from_file': 7,
    'the Rust engine refused it: function:chunks': 3,
    'the Rust engine refused it: write_root_not_held': 2,
    'the Rust engine refused it: block_multi_hop': 2,
  },
};

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

/**
 * Recordings that encoded a behaviour since fixed as a bug, so a replay of
 * them diverges by design — each named, with how many of each corpus's
 * recordings it accounts for, asserted exactly (the corpora's triage, for
 * recordings). The recordings themselves are never edited.
 */
const ENCODED_A_FIXED_BUG: Array<{
  reason: string;
  /** The recording is this one (its program and catalog say so), whether or
   *  not the target ran it: a target that skips it still accounts for it. */
  is: (recording: HostRecording) => boolean;
  /** The replay diverged exactly where the fixed bug says. */
  matches: (recording: HostRecording, divergence: string) => boolean;
  count: Record<keyof typeof FLOORS, number>;
}> = [
  {
    // PLAN-07A Task 4d: a file is only what an envelope declares one. The
    // recording's catalog gives the plugin its `through` names no output, so
    // its records' `file` key is declared nowhere: the plugin's fetched file
    // is data now, and the FILE resource the recorded write carried from
    // that key (its `data.file`) is not made. Matched on exactly that.
    reason: "a plugin's undeclared `file` key was taken for a file (PLAN-07A Task 4d)",
    is: (recording) =>
      undeclaredThroughPlugins(recording).length > 0 &&
      recording.requests.some((request) => fileResources(request.args).length > 0),
    matches: (recording, divergence) => {
      const at = /differs at args\.args\.resources\.(\d+)/.exec(divergence);
      if (at === null) return false;
      return undeclaredThroughPlugins(recording).length > 0 && recording.requests.some((request) => fileResources(request.args).includes(Number(at[1])));
    },
    count: { v1: 0, v2: 1 },
  },
  {
    // Not a bug: a fact about the release. A run pinned to a version no
    // release supports (99) is refused by name, and the refusal's fix names
    // the CURRENT version ("validate it under …"), which was Luminous Owl (4)
    // when the recording was made and is Dancing Wren (5) since the merge
    // that brought it. The refusal itself (MOVENG_LANGUAGE_VERSION, before
    // any request) is unchanged; matched on exactly that.
    reason: 'an unsupported version\'s refusal names the current version, 5 since Dancing Wren',
    is: (recording) => pinnedUnsupported(recording),
    matches: (recording, divergence) =>
      pinnedUnsupported(recording) &&
      recording.requests.length === 0 &&
      sameRefusalButForTheVersionName(divergence),
    count: { v1: 0, v2: 1 },
  },
];

const RECORDED_PREFIX = 'recorded the failure ';
const REPLAY_JOINT = '; the replay failed ';

/** Both sides are the MOVENG_LANGUAGE_VERSION refusal and are EQUAL once the
 *  current version's name and number ("Luminous Owl" (4)) is masked in each. */
function sameRefusalButForTheVersionName(divergence: string): boolean {
  if (!divergence.startsWith(RECORDED_PREFIX)) return false;
  const joint = divergence.indexOf(REPLAY_JOINT);
  if (joint < 0) return false;
  const mask = (side: string) => side.replace(/\\?"[A-Z][a-z]+ [A-Z][a-z]+\\?" \(\d+\)/g, '<current version>');
  const recorded = mask(divergence.slice(RECORDED_PREFIX.length, joint));
  const replayed = mask(divergence.slice(joint + REPLAY_JOINT.length));
  return recorded.includes('"code":"MOVENG_LANGUAGE_VERSION"') && recorded === replayed;
}

/** The recording is pinned to a version this release does not support. */
function pinnedUnsupported(recording: HostRecording): boolean {
  const version = recording.input.languageVersion;
  return version !== undefined && !SUPPORTED_LANGUAGE_VERSIONS.has(version as LanguageVersion);
}

/** The plugins the recording's program names in its `through` stages. */
function throughPlugins(recording: HostRecording): string[] {
  const program = parsePinned({
    source: recording.input.source,
    ...(recording.input.languageVersion !== undefined ? { languageVersion: recording.input.languageVersion } : {}),
  });
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isObject(node)) return;
    if (Array.isArray(node.through)) {
      for (const call of node.through) if (isObject(call) && typeof call.plugin === 'string') names.push(call.plugin);
    }
    Object.values(node).forEach(visit);
  };
  visit(program);
  return names;
}

/** The plugins the recording's `through` stages name that its catalog gives
 *  no output. */
function undeclaredThroughPlugins(recording: HostRecording): string[] {
  return throughPlugins(recording).filter((name) => recording.input.catalog?.plugins?.[name]?.output === undefined);
}

/** Where a recorded `adapters.call` carries a FILE resource made from a
 *  record's `file` key (its `data.file`): the resources' indices. */
function fileResources(args: unknown): number[] {
  const call = isObject(args) && isObject(args.args) ? args.args : undefined;
  const resources: unknown[] = call !== undefined && Array.isArray(call.resources) ? call.resources : [];
  return resources.flatMap((resource, index) =>
    isObject(resource) && resource.type === 'FILE' && isObject(resource.data) && isObject(resource.data.file) ? [index] : [],
  );
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const label = (recording: HostRecording, i: number): string =>
  `#${i + 1} ${recording.entry} ${JSON.stringify(recording.input.source.slice(0, 80))}`;

async function replayAll(target: ReplayTarget, recordings: readonly HostRecording[], corpus: keyof typeof FLOORS) {
  const diverged: string[] = [];
  const skipped = new Map<string, number>();
  const fixed = new Map<string, number>();
  const skippedFixed = new Map<string, number>();
  let same = 0;
  for (const [i, recording] of recordings.entries()) {
    const verdict = await target.replay(recording);
    switch (verdict.kind) {
      case 'same':
        same += 1;
        break;
      case 'skipped': {
        skipped.set(verdict.reason, (skipped.get(verdict.reason) ?? 0) + 1);
        // A recording that encoded a fixed bug, skipped: accounted for as
        // itself, never by another recording's skip.
        const known = ENCODED_A_FIXED_BUG.find((entry) => entry.is(recording));
        if (known !== undefined) skippedFixed.set(known.reason, (skippedFixed.get(known.reason) ?? 0) + 1);
        break;
      }
      case 'diverged': {
        const known = ENCODED_A_FIXED_BUG.find((entry) => entry.matches(recording, verdict.divergence));
        if (known !== undefined) fixed.set(known.reason, (fixed.get(known.reason) ?? 0) + 1);
        else diverged.push(`${label(recording, i)}: ${verdict.divergence}`);
        break;
      }
    }
  }
  const expected = Object.fromEntries(
    ENCODED_A_FIXED_BUG.filter((entry) => entry.count[corpus] > 0).map((entry) => [entry.reason, entry.count[corpus]]),
  );
  // Exactly the named ones, on every target: each recording that encoded a
  // fixed bug either diverged where the bug says or was skipped as itself
  // (the Rust engine refuses v2's Task 4d one, 2026-10-12). Run, it must
  // diverge so: one that reproduces the old bug, or a new divergence, fails
  // until this says why.
  const accounted = Object.fromEntries(
    [...new Set([...fixed.keys(), ...skippedFixed.keys()])].map((reason) => [reason, (fixed.get(reason) ?? 0) + (skippedFixed.get(reason) ?? 0)]),
  );
  if (JSON.stringify(sortedKeys(accounted)) !== JSON.stringify(sortedKeys(expected))) {
    diverged.push(`the recordings that encoded a fixed bug were ${JSON.stringify(Object.fromEntries(fixed))} (skipped: ${JSON.stringify(Object.fromEntries(skippedFixed))}), not ${JSON.stringify(expected)}`);
  }
  return { same, skipped: Object.fromEntries(skipped), diverged };
}

const sortedKeys = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const HARVEST_CHECK_TIMEOUT_MS = 1_800_000;

export function replayCorpus(corpus: keyof typeof FLOORS): void {
  // Hundreds of whole runs per target.
  jest.setTimeout(600_000);
  if (process.env.UPDATE_ENGINE_RUNS === '1') {
    // The check replays the harvest twice over (in process and over the HTTP
    // double), which outgrows the replay suites' own limit.
    it(
      'every harvested recording replays on the TypeScript engine, or a known reason says why not',
      async () => {
        await checkHarvest(corpus);
      },
      HARVEST_CHECK_TIMEOUT_MS,
    );
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
    const { diverged } = await replayAll(typescriptTarget, recordings, corpus);
    expect(diverged).toEqual([]);
  });

  it('replay identically against the HTTP host double', async () => {
    const { diverged } = await replayAll(http, recordings, corpus);
    expect(diverged).toEqual([]);
  });

  it('replay identically against the Rust engine, every recording it runs whole', async () => {
    const before = { ...rustRunStats.allReasons };
    const { same, skipped, diverged } = await replayAll(rustTarget, recordings, corpus);
    const everyReason = Object.entries(rustRunStats.allReasons)
      .map(([reason, count]): [string, number] => [reason, count - (before[reason] ?? 0)])
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a);
    console.log(`${corpus}: ${same} of ${recordings.length} recordings replayed on the Rust engine; skipped ${JSON.stringify(skipped)}`);
    console.log(`${corpus}: recordings the Rust engine refused, by every reason each holds: ${JSON.stringify(Object.fromEntries(everyReason))}`);
    expect(diverged).toEqual([]);
    expect(same).toBeGreaterThanOrEqual(FLOORS[corpus].rust);
    const ceiling = RUST_SKIP_CEILING[corpus];
    expect(Object.entries(skipped).filter(([reason, count]) => count > (ceiling[reason] ?? 0))).toEqual([]);
  });
}
