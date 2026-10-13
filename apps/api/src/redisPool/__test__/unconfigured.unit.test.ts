// With MESSAGE_QUEUE_REDIS_HOSTNAME unset, Redis is not in use: no pool is created, and the
// pool getter refuses rather than reaching for a default host.

const saved = process.env.MESSAGE_QUEUE_REDIS_HOSTNAME;

afterAll(() => {
  if (saved === undefined) delete process.env.MESSAGE_QUEUE_REDIS_HOSTNAME;
  else process.env.MESSAGE_QUEUE_REDIS_HOSTNAME = saved;
});

describe('with no Redis hostname', () => {
  it('reports Redis as not configured and refuses to build a pool', async () => {
    delete process.env.MESSAGE_QUEUE_REDIS_HOSTNAME;
    const { redisConfigured, getRedisPool } = await import('../index');
    expect(redisConfigured()).toBe(false);
    expect(() => getRedisPool()).toThrow(/MESSAGE_QUEUE_REDIS_HOSTNAME/);
  });

  it('reports Redis as configured when the hostname is set', async () => {
    jest.resetModules();
    process.env.MESSAGE_QUEUE_REDIS_HOSTNAME = 'redis.internal';
    const { redisConfigured } = await import('../index');
    expect(redisConfigured()).toBe(true);
  });
});
