// Deterministic ids in UUID form: a counter written as a version-4,
// RFC 4122-variant GUID, so anything that stores an id as a UUID (a stored
// resource) accepts it, and a recorded run mints the same ids every time.
// For a test host, and for an extraction run outside any host; never for
// production, whose ids must not repeat across processes.

/** A fresh sequence: `00000000-0000-4000-8000-000000000001`, then `…002`,
 *  and so on, one at a time (`next`) or `count` at a time (`take`). `seed`
 *  (0 to 0xffffffff) leads every id, so two sequences seeded apart never
 *  collide. */
export function guidSequence(seed = 0): { next(): string; take(count: number): string[] } {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error(`a GUID sequence's seed is a 32-bit unsigned integer, not ${seed}`);
  }
  const head = seed.toString(16).padStart(8, '0');
  let minted = 0;
  const next = (): string => `${head}-0000-4000-8000-${(++minted).toString(16).padStart(12, '0')}`;
  return { next, take: (count) => Array.from({ length: count }, next) };
}
