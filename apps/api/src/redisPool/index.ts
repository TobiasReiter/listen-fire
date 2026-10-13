import IORedis, { Redis } from 'ioredis';
import { createPool, Pool } from 'generic-pool';

import { getEnvVar } from '../lib/utils/environment';

let redisPool: Pool<Redis> | null = null;

/** How long a caller waits for a client before `acquire()` rejects (a dead Redis must not hang it). */
const ACQUIRE_TIMEOUT_MS = 3000;
/** How long one TCP connect may take before the attempt is abandoned. */
const CONNECT_TIMEOUT_MS = 1500;
/**
 * generic-pool re-runs a failed `create` immediately, so a refused connection would spin. Holding
 * the rejection back this long paces those re-attempts.
 */
const CREATE_RETRY_PAUSE_MS = 250;

function getRedisPool(): Pool<Redis> {
  if (!redisPool) {
    const factory = {
      create: async () => {
        const host = getEnvVar('MESSAGE_QUEUE_REDIS_HOSTNAME', { devDefault: 'localhost' });
        const port = getEnvVar('MESSAGE_QUEUE_REDIS_PORT', {
          devDefault: '6379',
        });
        let ready = false;
        const client = new IORedis(Number(port), host, {
          maxRetriesPerRequest: null,
          connectTimeout: CONNECT_TIMEOUT_MS,
          // Until the first connection works, give up (the pool then rejects the create). Once
          // connected, ioredis reconnects with backoff as usual, so a Redis restart is survived.
          retryStrategy: (times) => (ready ? Math.min(times * 200, 2000) : null),
        });
        // An unhandled 'error' event would be thrown; failures surface through ping()/commands.
        client.on('error', () => {});
        try {
          await client.ping();
        } catch (err) {
          client.disconnect();
          await new Promise((resolve) => setTimeout(resolve, CREATE_RETRY_PAUSE_MS));
          throw err;
        }
        ready = true;
        return client;
      },

      destroy: async (client: Redis) => {
        await client.quit();
      },
    };

    redisPool = createPool<Redis>(factory, {
      max: 150, // The max on our render server is 250 so this should be fine.
      min: 2,
      acquireTimeoutMillis: ACQUIRE_TIMEOUT_MS,
    });
  }

  return redisPool;
}

export { getRedisPool };
