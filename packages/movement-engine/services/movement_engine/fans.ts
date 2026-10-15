// Fans: work the engine runs side by side inside one statement (an
// extraction's plugins and sibling entities, a hop off several landings, a
// rehydrated list). However a fan fails, it settles first: every item already
// started runs to its end before the failure is thrown, so nothing the fan
// started is still talking to the host once the statement — or the segment —
// has ended, and whatever the started items recorded (their trace entries,
// their spend) is complete when the caller reads it.

/**
 * Run `job` over `items`, at most `width` at a time, answering in the order
 * the items were WRITTEN however they landed.
 *
 * The first failure stops the fan starting anything further — the serial
 * loop's behaviour, less the items already in flight — and once those have
 * finished, the failure of the earliest failing ITEM is thrown: the one a
 * one-at-a-time run would have stopped at, if it reached it.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  width: number,
  job: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const failures: Array<{ index: number; error: unknown }> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failures.length === 0) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await job(items[index], index);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  throwEarliest(failures);
  return results;
}

/** `Promise.all`, settled: every promise runs to its end, then the earliest
 *  one's failure (by position) is thrown, or every value is answered in
 *  order. */
export async function settledAll<T>(promises: ReadonlyArray<Promise<T>>): Promise<T[]> {
  const outcomes = await Promise.allSettled(promises);
  const values: T[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') throw outcome.reason;
    values.push(outcome.value);
  }
  return values;
}

function throwEarliest(failures: ReadonlyArray<{ index: number; error: unknown }>): void {
  if (failures.length === 0) return;
  const [earliest] = [...failures].sort((a, b) => a.index - b.index);
  throw earliest?.error;
}
