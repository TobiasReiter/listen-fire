import { Client, types } from 'pg';

import { getDatabaseUrl } from '../prisma';
import { MINUTE } from '../constants';
import { handleError } from './errors';

types.setTypeParser(20, (val) => parseInt(val, 10));

const databaseUrl = getDatabaseUrl(false);

async function acquireAdvisoryLock(scope: number, id: number) {
  const client = new Client({
    connectionString: databaseUrl.url,
  });

  await client.connect();

  const timeout = setTimeout(() => {
    handleError(new Error(`Failed to acquire advisory lock ${scope}.${id}`));
  }, 5 * MINUTE);

  await client.query('SELECT pg_advisory_lock($1, $2)', [scope, id]);

  clearTimeout(timeout);

  return {
    release: async () => {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [scope, id]);
      } finally {
        await client.end();
      }
    },
  };
}

async function tryAdvisoryLock(scope: number, id: number | string | bigint) {
  const client = new Client({
    connectionString: databaseUrl.url,
  });

  await client.connect();

  const result = await client.query<{ pg_try_advisory_lock: boolean }>(
    'SELECT pg_try_advisory_lock($1, $2)',
    [scope, id],
  );

  if (result.rows[0].pg_try_advisory_lock) {
    return {
      acquired: true,
      release: async () => {
        try {
          await client.query('SELECT pg_advisory_unlock($1, $2)', [scope, id]);
        } finally {
          await client.end();
        }
      },
    };
  } else {
    await client.end();
    return {
      acquired: false,
      release: async () => undefined,
    };
  }
}

export { acquireAdvisoryLock, tryAdvisoryLock };
