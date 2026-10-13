// The loop-guard counter contract: the same sequence of calls gives the same totals on every
// backend (Redis behind a fake client, or the in-process memory store).

import { incrementAndSum, resetWindow } from '../store';

export function describeCounterContract(): void {
  describe('incrementAndSum (sliding window by buckets)', () => {
    it('accumulates within the window and returns the running total', async () => {
      const key = 'loopguard:test:a';
      const base = 1_000_000; // a fixed second-aligned clock (ms)
      const r1 = await incrementAndSum({ key, windowSeconds: 60, amount: 1, nowMs: base });
      const r2 = await incrementAndSum({ key, windowSeconds: 60, amount: 1, nowMs: base + 500 });
      const r3 = await incrementAndSum({ key, windowSeconds: 60, amount: 1, nowMs: base + 1500 });
      expect(r1.total).toBe(1);
      expect(r2.total).toBe(2); // same second bucket → still summed
      expect(r3.total).toBe(3); // next second, still within the 60s window
      expect(r3.failOpen).toBe(false);
    });

    it('drops buckets that have aged out of the window', async () => {
      const key = 'loopguard:test:b';
      const base = 2_000_000;
      await incrementAndSum({ key, windowSeconds: 5, amount: 10, nowMs: base });
      // 10 seconds later — the first bucket is well outside the 5s window.
      const later = await incrementAndSum({
        key,
        windowSeconds: 5,
        amount: 1,
        nowMs: base + 10_000,
      });
      expect(later.total).toBe(1);
    });

    it('sums weighted amounts (writes/tokens, not just firings)', async () => {
      const key = 'loopguard:test:c';
      const base = 3_000_000;
      await incrementAndSum({ key, windowSeconds: 60, amount: 100, nowMs: base });
      const r = await incrementAndSum({ key, windowSeconds: 60, amount: 250, nowMs: base + 100 });
      expect(r.total).toBe(350);
    });
  });

  describe('resetWindow', () => {
    it('clears the buckets so the next sum starts from zero', async () => {
      const key = 'loopguard:test:e';
      const base = 5_000_000;
      await incrementAndSum({ key, windowSeconds: 60, amount: 5, nowMs: base });
      await resetWindow({ key, windowSeconds: 60, nowMs: base });
      const r = await incrementAndSum({ key, windowSeconds: 60, amount: 1, nowMs: base + 1000 });
      expect(r.total).toBe(1);
    });
  });
}
