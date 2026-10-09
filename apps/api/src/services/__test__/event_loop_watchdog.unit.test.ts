// The stall detector, and one run of the real thing.
//
// The decision is a pure function of the clock and the last heartbeat, so
// every schedule case (when a stall starts, how often it is reported, when it
// ends) is tested without a thread. The one threaded test exists to prove the
// wiring: a real worker, a really blocked loop, and the line that comes back.

import type { StallState, WatchdogEvent } from '../event_loop_watchdog';

import { decideStall, startEventLoopWatchdog } from '../event_loop_watchdog';

const STALL_AFTER_MS = 5_000;
const REPORT_AT_MS = [5_000, 30_000];

const RUNNING: StallState = { blockedFrom: null, reportsWritten: 0 };

function decide(now: number, lastHeartbeat: number, state: StallState) {
  return decideStall({ now, lastHeartbeat, state, stallAfterMs: STALL_AFTER_MS, reportAtMs: REPORT_AT_MS });
}

describe('the stall decision', () => {
  it('says nothing while the heartbeat is fresh', () => {
    const { action, state } = decide(4_000, 1_000, RUNNING);
    expect(action).toEqual({ kind: 'none' });
    expect(state).toEqual(RUNNING);
  });

  it('reports a stall the moment the heartbeat is stale enough', () => {
    const { action, state } = decide(6_000, 1_000, RUNNING);
    expect(action).toEqual({ kind: 'blocked', blockedMs: 5_000, reportIndex: 0 });
    // The stall is anchored to the last stamp, so every later reading measures
    // from the same moment rather than from when we noticed.
    expect(state).toEqual({ blockedFrom: 1_000, reportsWritten: 1 });
  });

  it('stays quiet between the two report points', () => {
    let state: StallState = { blockedFrom: 1_000, reportsWritten: 1 };
    for (const now of [7_000, 12_000, 20_000, 30_000]) {
      const outcome = decide(now, 1_000, state);
      expect(outcome.action).toEqual({ kind: 'none' });
      state = outcome.state;
    }
  });

  it('reports a second time thirty seconds in, and never again', () => {
    const second = decide(31_000, 1_000, { blockedFrom: 1_000, reportsWritten: 1 });
    expect(second.action).toEqual({ kind: 'blocked', blockedMs: 30_000, reportIndex: 1 });

    // A stall that runs for minutes costs those two lines and no more.
    for (const now of [60_000, 120_000, 600_000]) {
      expect(decide(now, 1_000, second.state).action).toEqual({ kind: 'none' });
    }
  });

  it('measures recovery from the last stamp before the stall to the first after it', () => {
    const { action, state } = decide(91_200, 91_000, { blockedFrom: 1_000, reportsWritten: 2 });
    expect(action).toEqual({ kind: 'recovered', blockedMs: 90_000 });
    expect(state).toEqual(RUNNING);
  });

  it('gives a second stall its own two reports', () => {
    const recovered = decide(91_200, 91_000, { blockedFrom: 1_000, reportsWritten: 2 }).state;
    const next = decide(97_000, 92_000, recovered);
    expect(next.action).toEqual({ kind: 'blocked', blockedMs: 5_000, reportIndex: 0 });
  });

  it('reports once and then falls silent when only one report point is configured', () => {
    const once = decideStall({
      now: 6_000,
      lastHeartbeat: 1_000,
      state: RUNNING,
      stallAfterMs: STALL_AFTER_MS,
      reportAtMs: [5_000],
    });
    expect(once.action).toEqual({ kind: 'blocked', blockedMs: 5_000, reportIndex: 0 });
    expect(
      decideStall({
        now: 600_000,
        lastHeartbeat: 1_000,
        state: once.state,
        stallAfterMs: STALL_AFTER_MS,
        reportAtMs: [5_000],
      }).action,
    ).toEqual({ kind: 'none' });
  });
});

/** The frame the watchdog is meant to name. Declared at module scope so the
 *  stack line has something recognisable to point at. */
function theBlockingFunctionUnderTest(forMs: number) {
  const end = Date.now() + forMs;
  let sink = 0;
  while (Date.now() < end) sink += Math.sqrt(sink + 1);
  return sink;
}

describe('the watchdog itself', () => {
  /** The worker writes each line straight to file descriptor 2 and posts the
   *  identical text back; the posted copy is what a test can read, because a
   *  worker's own stderr stream is proxied through the thread this test is
   *  about to block.
   *
   *  Jest's own module loading blocks the loop for a few hundred milliseconds
   *  of its own, and the watchdog dutifully reports that too — so this reads
   *  the stall it caused rather than the first one it finds. */
  it('names the blocked loop, the frame blocking it, and then its recovery', async () => {
    const events: WatchdogEvent[] = [];
    const handle = startEventLoopWatchdog({
      heartbeatMs: 50,
      checkIntervalMs: 100,
      stallAfterMs: 500,
      reportAtMs: [500, 60_000],
      onEvent: (event) => events.push(event),
    });

    try {
      // Let the worker start, open its session and enable the debugger — all
      // of which need a loop that answers.
      await new Promise((resolve) => setTimeout(resolve, 700));

      const before = events.length;
      expect(theBlockingFunctionUnderTest(1_500)).toBeGreaterThan(0);

      // The posted lines only reach this thread now that it is free again.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const ofThisStall = events.slice(before);
      const last = (kind: WatchdogEvent['kind']) =>
        [...ofThisStall].reverse().find((event) => event.kind === kind);
      const fieldsOf = (event?: WatchdogEvent) =>
        JSON.parse(event?.line.replace(/^[^{]+/, '') ?? '{}');

      const blocked = last('blocked');
      expect(blocked?.line).toMatch(/^error: \[watchdog] event loop blocked /);
      expect(fieldsOf(blocked).blockedMs).toBeGreaterThanOrEqual(500);
      expect(fieldsOf(blocked).rss).toBeGreaterThan(0);

      // The point of the whole exercise: the frame that was running while the
      // loop was gone, read from the thread while it was still gone.
      const stack = last('stack');
      expect(stack?.line).toMatch(/^error: \[watchdog] main thread stack while blocked /);
      expect(fieldsOf(stack).stack).toContain('theBlockingFunctionUnderTest');
      expect(fieldsOf(stack).stack).toContain('event_loop_watchdog.unit.test.ts');
      expect(fieldsOf(stack).blockedMs).toBeGreaterThanOrEqual(500);
      expect(ofThisStall.filter((event) => event.kind === 'pause-missed')).toHaveLength(0);

      // The thread was handed straight back: it finished its 1.5s of work.
      const recovered = last('recovered');
      expect(recovered?.line).toMatch(/^warn: \[watchdog] event loop recovered /);
      expect(fieldsOf(recovered).blockedMs).toBeGreaterThanOrEqual(1_400);

      // The rate limit holds: one stall, one report, however many checks ran.
      expect(ofThisStall.filter((event) => event.kind === 'blocked')).toHaveLength(1);
      expect(ofThisStall.filter((event) => event.kind === 'stack')).toHaveLength(1);
    } finally {
      await handle.stop();
    }
  }, 20_000);
});
