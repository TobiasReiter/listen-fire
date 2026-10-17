// The Postgres database the integration tests here run against: the test
// database (`LF_TEST_POSTGRES_URL`, else the dev loop's on 9432), reached
// with `psql` for what a test sets up and clears. Each test owns one fresh
// team, and every row it leaves is that team's.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lfHostBinary } from '../lf_host';

export const POSTGRES_URL = process.env.LF_TEST_POSTGRES_URL ?? 'postgresql://listenfire:localdevpassword@localhost:9432/listenfire_test';

/** One statement's rows, tab-separated, through psql. Throws when it fails. */
export function psql(sql: string): string[][] {
  const run = spawnSync('psql', [POSTGRES_URL, '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (run.error !== undefined || run.status !== 0) throw new Error(`psql failed: ${run.error?.message ?? run.stderr}`);
  return run.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t'));
}

let schemaReady = false;

/** lf's own schema (`lf.*`), as the Postgres store's setup creates it: the
 *  contract bridge runs that setup when it opens, and exits at end of input. */
function ensureLfSchema(): void {
  if (schemaReady) return;
  const setup = spawnSync(lfHostBinary(), ['--contract-store', POSTGRES_URL], { input: '', encoding: 'utf8' });
  if (setup.error !== undefined || setup.status !== 0) throw new Error(`the lf schema's setup failed: ${setup.error?.message ?? setup.stderr}`);
  schemaReady = true;
}

/** A fresh team, and how to clear every row it left. */
export function freshTeam(): { team: string; clear(): void } {
  ensureLfSchema();
  const team = randomUUID();
  return {
    team,
    clear() {
      // The run's live state and callbacks go with its trigger_run row (ON DELETE CASCADE).
      psql(`delete from lf.trigger_run where team_id = '${team}';
            delete from lf.work where team_id = '${team}';
            delete from lf.park_library_source where team_id = '${team}';
            delete from lf.inbound_checkpoint where team_id = '${team}';`);
    },
  };
}
