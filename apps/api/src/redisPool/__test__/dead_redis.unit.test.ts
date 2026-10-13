// A Redis that cannot be reached must make pool.acquire() reject promptly (not hang), and the loop
// guard store, which fails open on that rejection, must settle quickly with `failOpen: true`.
// The tests point the pool at a port nothing listens on, so they do not depend on whether this
// machine runs Redis.

import net from 'net';

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe('with no Redis reachable', () => {
  const saved = {
    host: process.env.MESSAGE_QUEUE_REDIS_HOSTNAME,
    port: process.env.MESSAGE_QUEUE_REDIS_PORT,
  };

  beforeAll(async () => {
    process.env.MESSAGE_QUEUE_REDIS_HOSTNAME = '127.0.0.1';
    process.env.MESSAGE_QUEUE_REDIS_PORT = String(await unusedPort());
  });

  afterAll(async () => {
    const { getRedisPool } = await import('../index');
    await getRedisPool().drain().catch(() => {});
    await getRedisPool().clear().catch(() => {});
    if (saved.host === undefined) delete process.env.MESSAGE_QUEUE_REDIS_HOSTNAME;
    else process.env.MESSAGE_QUEUE_REDIS_HOSTNAME = saved.host;
    if (saved.port === undefined) delete process.env.MESSAGE_QUEUE_REDIS_PORT;
    else process.env.MESSAGE_QUEUE_REDIS_PORT = saved.port;
  });

  it('pool.acquire() rejects within a bound instead of hanging', async () => {
    const { getRedisPool } = await import('../index');
    const startedAt = Date.now();
    await expect(getRedisPool().acquire()).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(5000);
  }, 10_000);

  it('the loop guard store fails open quickly, then skips Redis while backing off', async () => {
    const { incrementAndSum, resetAcquireBackoffForTests } = await import(
      '../../services/loop_guard/store'
    );
    resetAcquireBackoffForTests();

    const input = { key: 'loopguard:test:dead-redis', windowSeconds: 10, amount: 3 };
    const startedAt = Date.now();
    await expect(incrementAndSum(input)).resolves.toEqual({ total: 3, failOpen: true });
    expect(Date.now() - startedAt).toBeLessThan(2000);

    const secondStartedAt = Date.now();
    await expect(incrementAndSum(input)).resolves.toEqual({ total: 3, failOpen: true });
    expect(Date.now() - secondStartedAt).toBeLessThan(100);
  }, 10_000);
});
