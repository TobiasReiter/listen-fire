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

import { parsePinned } from 'movement-engine/services/movement_engine/program_check';
import { rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';

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
  // Lowered by Henry's ruling of 2026-10-16, the extraction keyword retired
  // from the Rust engine on every version (`legacy_extraction`): 431 to 345
  // and 520 to 403, every recording it no longer runs refused by that name
  // (95 and 135 of them, the skip ceilings below).
  v1: { recordings: 443, rust: 345 },
  v2: { recordings: 542, rust: 403 },
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
  // Since 2026-10-16 the one reason is the extraction keyword, which the Rust
  // engine refuses by name on every version (Henry's ruling): measured 95 and
  // 135. The reasons listed before were closed by the tasks since and skip
  // nothing.
  v1: {
    'the Rust engine refused it: legacy_extraction': 95,
  },
  v2: {
    'the Rust engine refused it: legacy_extraction': 135,
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
  matches: (recording: HostRecording, divergence: string, verdict: Extract<ReplayVerdict, { kind: 'diverged' }>) => boolean;
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
  {
    // B7 (shared-handle numbering): a write handle bound under two names is
    // one handle, so a park's state now numbers it (`id` on the descriptor)
    // and the repeated descriptor is a `handleRef` to that number. The
    // recordings predate it. Matched on exactly that: the replayed park
    // request is a recorded one once both sides' handle numbering is masked
    // (ids dropped, each handleRef resolved to the descriptor it names).
    reason: 'a park numbers a write handle bound under two names, and the repeats refer to it (B7)',
    is: (recording) => recording.requests.some((request) => request.family === 'park.callbacks' && JSON.stringify(request.args).includes('"landings"') && JSON.stringify(request.args).includes('"kind":"handle"')),
    matches: (recording, _divergence, verdict) => {
      if (verdict.unmatched === undefined) return false;
      const { path, args } = verdict.unmatched;
      if (!path.startsWith('park.')) return false;
      const replayed = canonicalJson(args);
      const masked = canonicalJson(maskHandleNumbering(args));
      return recording.requests.some((request) => {
        if (`${request.family}.${request.method}` !== path) return false;
        const recorded = canonicalJson(request.args);
        return recorded !== replayed && canonicalJson(maskHandleNumbering(request.args)) === masked;
      });
    },
    count: { v1: 1, v2: 1 },
  },
  {
    // The park format change: body closures hold their scope by reference.
    // A closure parks with an empty `captured` and a `scope` link (here a
    // `scopeRef` to its movement body's scope, which the chain now numbers:
    // `id`, `parent`), where the recordings parked a flat `captured`
    // snapshot. Matched on exactly that: every request before the park was
    // served (the replay's and the recording's numbers agree), only
    // `segment.close` follows it, and the replayed park request is the
    // recorded one once each closure's capture is normalised — the recorded
    // snapshot's every name resolves through the replayed link to the same
    // descriptor, a name only the link holds is a closure bound later in that
    // same scope, and every other byte is equal.
    reason: 'a park writes a body closure\'s scope by reference, not as a captured snapshot',
    // A run's own park only: a resume of a snapshot-form state re-parks it
    // as it was handed (engine-runs v1 #11, v2 #11 replay identically).
    is: (recording) => recording.entry === 'run' && recording.requests.some((request) => request.family.startsWith('park.') && closuresIn(request.args).some((closure) => isObject(closure.captured) && Object.keys(closure.captured).length > 0 && closure.scope === undefined)),
    matches: (recording, divergence, verdict) => {
      if (recording.entry !== 'run' || verdict.unmatched === undefined) return false;
      const { path, args } = verdict.unmatched;
      if (!path.startsWith('park.')) return false;
      const numbers = /^request #(\d+) (\S+) .* the first unserved (\S+) recorded was #(\d+) /.exec(divergence);
      if (numbers === null || numbers[1] !== numbers[4] || numbers[2] !== path || numbers[3] !== path) return false;
      const index = Number(numbers[4]) - 1;
      const recorded = recording.requests[index];
      if (recorded === undefined || `${recorded.family}.${recorded.method}` !== path) return false;
      const after = recording.requests.slice(index + 1).map((request) => `${request.family}.${request.method}`);
      if (after.some((request) => request !== 'segment.close')) return false;
      return capturesAgreeByReference(recorded.args, args);
    },
    count: { v1: 2, v2: 2 },
  },
];

/** The closure descriptors in a park request, outside any closure's capture,
 *  in key order: the ones the two sides hold at the same places. */
function closuresIn(root: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isObject(node)) return;
    if (node.kind === 'closure') found.push(node);
    for (const key of Object.keys(node).sort()) {
      if (node.kind === 'closure' && (key === 'captured' || key === 'scope')) continue;
      visit(node[key]);
    }
  };
  visit(root);
  return found;
}

/** A park request with every closure's capture masked (`captured`, `scope`)
 *  and every scope's numbering (`id`, `parent` beside `bindings`). */
function maskClosureCaptures(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(maskClosureCaptures);
  if (!isObject(node)) return node;
  const scopeEntry = node.kind === undefined && isObject(node.bindings);
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !(node.kind === 'closure' && (key === 'captured' || key === 'scope')) && !(scopeEntry && (key === 'id' || key === 'parent')))
      .map(([key, value]) => [key, maskClosureCaptures(value)]),
  );
}

/** The bindings a scope link names, outermost first and innermost winning,
 *  resolved within the park request it is in; undefined when it names a
 *  scope the request does not hold (a library's file scope included). */
function resolveScopeLink(root: unknown, link: unknown): Record<string, unknown> | undefined {
  const numbered = new Map<number, Record<string, unknown>>();
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!isObject(node)) return;
    if (typeof node.id === 'number' && isObject(node.bindings) && (node.kind === undefined || node.kind === 'scope')) numbered.set(node.id, node);
    Object.values(node).forEach(collect);
  };
  collect(root);
  const chain = isObject(root) && isObject(root.state) && Array.isArray(root.state.scopeChain) ? root.state.scopeChain : [];
  const fileScope = isObject(chain[0]) && isObject(chain[0].bindings) ? chain[0].bindings : undefined;
  const resolve = (at: unknown, depth: number): Record<string, unknown> | undefined => {
    if (depth > 64 || !isObject(at)) return undefined;
    if (at.kind === 'file') return at.file === undefined ? fileScope : undefined;
    const scope = at.kind === 'scopeRef' && typeof at.id === 'number' ? numbered.get(at.id) : at.kind === 'scope' ? at : undefined;
    if (scope === undefined || !isObject(scope.bindings)) return undefined;
    const outer = scope.parent === undefined ? {} : resolve(scope.parent, depth + 1);
    return outer === undefined ? undefined : { ...outer, ...scope.bindings };
  };
  return resolve(link, 0);
}

/** The recorded park request (closures as `captured` snapshots) and the
 *  replayed one (closures by `scope` link) are the same park: equal once
 *  captures are masked, and each recorded snapshot's every name resolves
 *  through the replayed closure's link to the same descriptor, a name only
 *  the link holds being a closure bound later in that same scope. */
function capturesAgreeByReference(recordedArgs: unknown, replayedArgs: unknown): boolean {
  if (canonicalJson(recordedArgs) === canonicalJson(replayedArgs)) return false;
  if (canonicalJson(maskClosureCaptures(recordedArgs)) !== canonicalJson(maskClosureCaptures(replayedArgs))) return false;
  const recorded = closuresIn(recordedArgs);
  const replayed = closuresIn(replayedArgs);
  if (recorded.length !== replayed.length) return false;
  let changed = false;
  for (const [i, before] of recorded.entries()) {
    const after = replayed[i];
    if (after === undefined || !isObject(before.captured) || !isObject(after.captured)) return false;
    if (after.scope === undefined) {
      if (canonicalJson(before) !== canonicalJson(after)) return false;
      continue;
    }
    if (before.scope !== undefined || Object.keys(after.captured).length > 0) return false;
    const resolved = resolveScopeLink(replayedArgs, after.scope);
    if (resolved === undefined) return false;
    for (const [name, descriptor] of Object.entries(before.captured)) {
      if (!(name in resolved) || canonicalJson(maskClosureCaptures(descriptor)) !== canonicalJson(maskClosureCaptures(resolved[name]))) return false;
    }
    for (const [name, descriptor] of Object.entries(resolved)) {
      if (name in before.captured) continue;
      if (!isObject(descriptor) || descriptor.kind !== 'closure' || canonicalJson(descriptor.scope) !== canonicalJson(after.scope)) return false;
    }
    changed = true;
  }
  return changed;
}

/** A park state with its handle numbering masked: every descriptor loses its
 *  `id`, and every `handleRef` becomes the numbered descriptor it names. */
function maskHandleNumbering(root: unknown): unknown {
  const numbered = new Map<number, unknown>();
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!isObject(node)) return;
    if (node.kind === 'handle' && typeof node.id === 'number') numbered.set(node.id, node);
    Object.values(node).forEach(collect);
  };
  collect(root);
  const mask = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(mask);
    if (!isObject(node)) return node;
    if (node.kind === 'handleRef' && typeof node.id === 'number' && numbered.has(node.id)) return mask(numbered.get(node.id));
    return Object.fromEntries(Object.entries(node).filter(([key]) => !(key === 'id' && node.kind === 'handle')).map(([key, value]) => [key, mask(value)]));
  };
  return mask(root);
}

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
        const known = ENCODED_A_FIXED_BUG.find((entry) => entry.matches(recording, verdict.divergence, verdict));
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
