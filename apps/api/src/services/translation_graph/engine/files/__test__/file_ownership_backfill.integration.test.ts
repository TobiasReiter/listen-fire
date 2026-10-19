// The file ownership backfill, against rows shaped as an earlier release left
// them: uploads under `<uuid>/<name>` with no document row, named by a trigger
// event's payload and a parked run's state. After the migration the store's
// own ownership check (unchanged) answers for each one.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Client } from 'pg';

import { services } from '../../../../../adapters/registry';
import { S3Adapter } from '../../../../../adapters/document/s3';
import { hostedDocumentStore } from '../retrieve';

const MIGRATIONS = path.resolve(__dirname, '../../../../../db/migrations');
const BUCKET = 'listen-fire';

function migrationSql(): string {
  const file = readdirSync(MIGRATIONS).find((name) => name.endsWith('_backfill_file_ownership.sql'));
  if (file === undefined) throw new Error('the backfill migration is missing');
  return readFileSync(path.join(MIGRATIONS, file), 'utf-8');
}

function oldUri(name: string): string {
  return `s3://${BUCKET}/${randomUUID()}/${name}`;
}

/** A Run-now upload's descriptor as an earlier release stored it. */
function manualFileRef(objectUri: string, name: string) {
  return { __brand: 'FileRef', name, source: { ownerAdapterType: 'manual', handle: objectUri } };
}

describe('the file ownership backfill', () => {
  const teamA = randomUUID();
  const teamB = randomUUID();
  const teams = [teamA, teamB];
  const eventFile = oldUri('deck.pdf');
  const parkedFile = oldUri('rehearsal-upload.txt');
  const sharedFile = oldUri('shared.csv');
  const orphanFile = oldUri('orphan.txt');
  const runId = randomUUID();
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL_TEST });
    await db.connect();
    // Only the store's reading of its own keys is used: nothing is fetched
    // (no store is registered in this suite's module registry otherwise).
    services.document = new S3Adapter({ bucket: BUCKET, region: 'auto', accessKeyId: 'unused', secretAccessKey: 'unused' });

    await db.query(
      `INSERT INTO automations.trigger_event (team_id, trigger_id, adapter_type, trigger_type, payload)
       VALUES ($1, 'run-now', 'manual', 'manual', $2), ($3, 'run-now', 'manual', 'manual', $4), ($5, 'run-now', 'manual', 'manual', $6)`,
      [
        teamA, { files: [manualFileRef(eventFile, 'deck.pdf')], objectUri: eventFile },
        teamA, { files: [manualFileRef(sharedFile, 'shared.csv')] },
        teamB, { files: [manualFileRef(sharedFile, 'shared.csv')] },
      ],
    );
    await db.query(
      `INSERT INTO automations.trigger_run (id, team_id, trigger_id, trigger_type, status, trigger_payload)
       VALUES ($1, $2, 'run-now', 'manual', 'parked', $3)`,
      [runId, teamA, { note: 'parked before the upgrade' }],
    );
    await db.query(
      `INSERT INTO automations.parked_run (run_id, address, state, park_reason, wake_at)
       VALUES ($1, 'root/0', $2, 'timer', now() + interval '40 minutes')`,
      [runId, { scope: { upload: { kind: 'file', ref: manualFileRef(parkedFile, 'rehearsal-upload.txt') } } }],
    );
  });

  afterAll(async () => {
    await db.query('DELETE FROM automations.trigger_run WHERE id = $1', [runId]);
    await db.query('DELETE FROM automations.trigger_event WHERE team_id = ANY($1::uuid[])', [teams]);
    await db.query('DELETE FROM knowledge.document WHERE team_id = ANY($1::uuid[])', [teams]);
    await db.end();
  });

  const owns = (objectUri: string, tenantId: string) => hostedDocumentStore.owns({ objectUri, tenantId });

  it('gives each file to the one team that references it, and no other', async () => {
    expect(await owns(eventFile, teamA)).toBe(false);
    expect(await owns(parkedFile, teamA)).toBe(false);

    await db.query(migrationSql());

    expect(await owns(eventFile, teamA)).toBe(true);
    expect(await owns(parkedFile, teamA)).toBe(true);
    expect(await owns(eventFile, teamB)).toBe(false);
    expect(await owns(parkedFile, teamB)).toBe(false);
  });

  it('leaves a file two teams reference, and one nothing references, unreadable to everyone', async () => {
    for (const team of teams) {
      expect(await owns(sharedFile, team)).toBe(false);
      expect(await owns(orphanFile, team)).toBe(false);
    }
  });

  it('writes nothing more when run again', async () => {
    await db.query(migrationSql());
    const { rows } = await db.query<{ object_uri: string; description: string }>(
      'SELECT object_uri, description FROM knowledge.document WHERE team_id = ANY($1::uuid[]) ORDER BY description',
      [teams],
    );
    expect(rows).toEqual([
      { object_uri: eventFile, description: 'deck.pdf' },
      { object_uri: parkedFile, description: 'rehearsal-upload.txt' },
    ]);
  });
});
