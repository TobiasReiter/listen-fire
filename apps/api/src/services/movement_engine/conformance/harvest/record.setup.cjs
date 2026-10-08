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

if (process.env.UPDATE_ENGINE_RUNS === '1' && DIR !== undefined) {
  const RUN = path.resolve(__dirname, '../../run.ts');
  const RECORDER = path.resolve(__dirname, '../recorder.ts');
  const file = path.relative(path.resolve(__dirname, '../../../../..'), expect.getState().testPath || '');
  const lines = [];

  jest.mock(RUN, () => {
    const actual = jest.requireActual(RUN);
    const { recordEntry } = require(RECORDER);
    const keep = (recording) => lines.push(JSON.stringify({ file, recording }));
    // A value that cannot cross as JSON fails the entry it crossed in (see
    // ../recorder.ts), so the corpus test fails, naming it.
    const recorded = (entry, run) => (input) => recordEntry({ entry, input, run, keep });
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
