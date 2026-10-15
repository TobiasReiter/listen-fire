// Under UPDATE_ENGINE_RUNS=1, records every entry a conformance corpus makes
// into the engine — each `runMovement`, `resumeMovement`, `settleRaceFrame`
// and `fireCallbackBody`, whatever host the test hands it (`makeTestHost`, or
// its own) — as a host recording (../recorder.ts), appended as JSON lines to
// this run's harvest directory; ./teardown.cjs folds them into the corpus's
// __fixtures__/engine-runs.v<n>.json. Without it, nothing is installed and
// the corpus runs exactly as it always has.
//
// The recorder hands the engine and the test's host each other's own values
// (it records JSON copies), so a recorded corpus asserts what an unrecorded
// one does.
const fs = require('fs');
const path = require('path');

const DIR = process.env.ENGINE_RUNS_HARVEST_DIR;

// The instant the wall clock reads throughout a harvest. A test builds its
// inputs off the wall clock (an event's `occurredAt`, a payload's time), so a
// harvest that let it run would record different inputs every time; held, two
// harvests write the same bytes. The engine itself reads no clock (it asks
// the host's `clock.now`); this is the tests'.
const HARVEST_NOW = Date.parse('2026-01-01T00:00:00.000Z');

function heldAt(clock, at) {
  return new Proxy(clock, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [at] : args, newTarget),
    apply: () => new clock(at).toString(),
    get: (target, key, receiver) => (key === 'now' ? () => at : Reflect.get(target, key, receiver)),
  });
}

// Corpus test files whose entries are never recorded. The recorded corpora
// grow deliberately against the fixture size budget; the binding × consumer
// matrix is a DEFERRED decision.
const UNRECORDED = ['src/services/movement_engine/__test__/binding_consumer_matrix.unit.test.ts'];
const testFile = path.relative(path.resolve(__dirname, '../../../../..'), expect.getState().testPath || '');

if (process.env.UPDATE_ENGINE_RUNS === '1' && DIR !== undefined && !UNRECORDED.includes(testFile)) {
  globalThis.Date = heldAt(globalThis.Date, HARVEST_NOW);
  // Likewise the random UUIDs a test's own host mints (the production host's
  // segment ids, a fake's record ids): numbered per test file instead.
  for (const crypto of ['crypto', 'node:crypto']) {
    jest.mock(crypto, () => {
      const actual = jest.requireActual(crypto);
      let minted = 0;
      return {
        ...actual,
        randomUUID: () => `00000000-0000-4000-9000-${(++minted).toString(16).padStart(12, '0')}`,
      };
    });
  }

  const RUN = path.resolve(__dirname, 'movement-engine/services/movement_engine/run');
  const RECORDER = path.resolve(__dirname, '../recorder.ts');
  const file = testFile;
  const lines = [];

  jest.mock(RUN, () => {
    const actual = jest.requireActual(RUN);
    const { recordEntry } = require(RECORDER);
    const keep = (recording) => lines.push(JSON.stringify({ file, recording }));
    // A request the engine makes after its entry ended cannot be in any
    // recording; the fold refuses the harvest, naming it (./teardown.cjs).
    const late = (message) => lines.push(JSON.stringify({ file, late: message }));
    // A value that cannot cross as JSON fails the entry it crossed in (see
    // ../recorder.ts), so the corpus test fails, naming it.
    const recorded = (entry, run) => (input) => recordEntry({ entry, input, run, keep, late });
    return {
      ...actual,
      runMovement: recorded('run', actual.runMovement),
      resumeMovement: recorded('resume', actual.resumeMovement),
      settleRaceFrame: recorded('settleRace', actual.settleRaceFrame),
      fireCallbackBody: recorded('callbackBody', actual.fireCallbackBody),
    };
  });

  afterAll(() => {
    if (lines.length > 0) fs.appendFileSync(path.join(DIR, `${process.pid}.jsonl`), lines.join('\n') + '\n');
  });
}
