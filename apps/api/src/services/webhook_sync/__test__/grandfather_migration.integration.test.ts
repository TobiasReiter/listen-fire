// The grandfathering migration marks the webhook subscriptions that exist when
// it runs, and only those. Run against a throwaway database on the test
// server: a minimal table as it stood before the migration, one row, the
// migration file itself, then a second row inserted the ordinary way.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Client } from 'pg';

const MIGRATIONS = path.resolve(__dirname, '../../../db/migrations');

function urlFor(database: string): string {
  const url = new URL(process.env.DATABASE_URL_TEST ?? '');
  url.pathname = `/${database}`;
  return url.toString();
}

describe('the grandfathered_unsigned migration', () => {
  const database = `grandfather_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let db: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    db = new Client({ connectionString: urlFor(database) });
    await db.connect();
  });

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin?.end();
  });

  it('marks the rows that exist and no row inserted afterwards', async () => {
    await db.query(`
      CREATE SCHEMA automations;
      CREATE TABLE automations.webhook_subscription (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        provider text NOT NULL,
        webhook_secret text NOT NULL
      );
      INSERT INTO automations.webhook_subscription (provider, webhook_secret) VALUES ('AFFINITY', ''), ('ATTIO', 'a-real-key');
    `);

    const file = readdirSync(MIGRATIONS).find((name) => name.endsWith('_subscription_grandfathered_unsigned.sql'));
    expect(file).toBeDefined();
    await db.query(readFileSync(path.join(MIGRATIONS, file ?? ''), 'utf-8'));

    await db.query(`INSERT INTO automations.webhook_subscription (provider, webhook_secret) VALUES ('AIRTABLE', '')`);

    const { rows } = await db.query<{ provider: string; grandfathered_unsigned: boolean }>(
      'SELECT provider, grandfathered_unsigned FROM automations.webhook_subscription ORDER BY provider',
    );
    expect(rows).toEqual([
      { provider: 'AFFINITY', grandfathered_unsigned: true },
      { provider: 'AIRTABLE', grandfathered_unsigned: false },
      { provider: 'ATTIO', grandfathered_unsigned: true },
    ]);
  });
});
