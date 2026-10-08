import { randomUUID } from 'node:crypto';

import type { WorkContext } from '../kinds';

import { drainWork, resetWorkHandlersForTests } from '../drain';
import { registerWorkKinds } from '../units';
import { enqueueWork, removeWork } from '../store';

// exposed_file_sweep is a real unit kind no other suite registers a handler
// for; registering it the way its unit does makes this process claim it.
const KIND = 'exposed_file_sweep';

// Due times live in 2001 so only rows this file backdates are due (see store.integration.test.ts).
const T0 = new Date('2001-01-01T00:00:00.000Z');
const now = () => new Date(T0.getTime() + 1_000);

const keys: string[] = [];
async function enqueueMine(): Promise<string> {
  const key = `${KIND}:${randomUUID()}`;
  keys.push(key);
  await enqueueWork({ kind: KIND, key, payload: { key }, dueAt: T0 });
  return key;
}

function keyOf(payload: unknown): string {
  if (typeof payload === 'object' && payload && 'key' in payload && typeof payload.key === 'string')
    return payload.key;
  throw new Error('payload has no key');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  resetWorkHandlersForTests();
});

afterEach(async () => {
  for (const key of keys.splice(0)) await removeWork({ key });
});

describe('drainWork against the real store', () => {
  it('two concurrent drainers execute each row exactly once between them', async () => {
    const executed: { key: string; owner: string }[] = [];
    const handler = {
      run: async (payload: unknown, ctx: WorkContext) => {
        executed.push({ key: keyOf(payload), owner: ctx.owner });
        await sleep(50);
      },
    };
    registerWorkKinds([{ kind: KIND, handler }]);
    const mine: string[] = [];
    for (let i = 0; i < 20; i++) mine.push(await enqueueMine());

    // limit 10 each, not 20: one claim is one statement, so a limit covering every
    // row lets whichever drainer claims first take them all.
    const results = await Promise.all([
      drainWork({ owner: 'drainer-a', limit: 10, now }),
      drainWork({ owner: 'drainer-b', limit: 10, now }),
    ]);
    expect(results.map((r) => r.claimed)).toEqual([10, 10]);

    const ranMine = executed.filter((e) => mine.includes(e.key));
    expect(ranMine.map((e) => e.key).sort()).toEqual([...mine].sort());
    expect(new Set(ranMine.map((e) => e.owner))).toEqual(new Set(['drainer-a', 'drainer-b']));
  });

  it('a hung holder loses its lapsed lease and the next drainer recovers with attempts 2', async () => {
    const recovered: number[] = [];
    const handler = {
      run: () => new Promise<void>(() => {}),
      recover: async (_payload: unknown, ctx: WorkContext) => {
        recovered.push(ctx.attempts);
      },
    };
    registerWorkKinds([{ kind: KIND, handler }]);
    await enqueueMine();

    void drainWork({ owner: 'hung', leaseMs: 200, heartbeatMs: false, now });
    await sleep(300);
    const result = await drainWork({ owner: 'rescuer', leaseMs: 200, now });

    expect(recovered).toEqual([2]);
    expect(result).toMatchObject({ claimed: 1, recovered: 1, failed: 0 });
  });
});
