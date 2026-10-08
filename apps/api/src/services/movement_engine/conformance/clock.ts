// The clock an entry into the engine reads, held still. The engine reads the
// wall clock where a run's own instant would be wrong — a sleep wakes a
// duration after it began, a callback expires a duration after it was minted
// — so the clock is an input like any other: a recording keeps the instant it
// was held at (`clock`), and a replay holds it there again. While any entry is
// in flight, `Date.now()` and `new Date()` answer that one instant; entries
// that overlap share it, and the real clock comes back when the last one ends.
// A measured duration reads as 0.

// The clock in force when the hold began (a test's fake timers' clock, when
// it has one) is the one restored.
let held: { at: number; entries: number; previous: DateConstructor } | undefined;

function frozenAt(clock: DateConstructor, at: number): DateConstructor {
  return new Proxy(clock, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [at] : args, newTarget),
    apply: () => new clock(at).toString(),
    get: (target, key, receiver) => (key === 'now' ? () => at : Reflect.get(target, key, receiver)),
  });
}

/** Run `body` with the clock held at `instant` (an ISO 8601 string), or —
 *  absent — at the real clock's reading now; `body` is handed the instant the
 *  clock reads. An entry that starts while another holds the clock reads the
 *  instant that one holds. */
export async function withHeldClock<T>(instant: string | undefined, body: (clock: string) => Promise<T>): Promise<T> {
  if (held === undefined) {
    const previous = globalThis.Date;
    const at = instant !== undefined ? previous.parse(instant) : previous.now();
    if (Number.isNaN(at)) throw new Error(`the clock cannot be held at '${instant}', which is no instant`);
    held = { at, entries: 0, previous };
    globalThis.Date = frozenAt(previous, at);
  } else if (instant !== undefined && held.previous.parse(instant) !== held.at) {
    throw new Error(`the clock is held at ${new held.previous(held.at).toISOString()}, not ${instant}`);
  }
  const holding = held;
  holding.entries += 1;
  try {
    return await body(new holding.previous(holding.at).toISOString());
  } finally {
    holding.entries -= 1;
    if (holding.entries === 0) {
      held = undefined;
      globalThis.Date = holding.previous;
    }
  }
}
