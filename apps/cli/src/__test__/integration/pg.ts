// The Postgres database the integration tests here run against: the test
// database (`LF_TEST_POSTGRES_URL`, else the dev loop's on 9432), reached
// with `psql` for what a test sets up and clears. Each test owns one fresh
// team, and every row it leaves is that team's.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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

/** A fresh team, and how to clear every row it left. */
export function freshTeam(): { team: string; clear(): void } {
  const team = randomUUID();
  return {
    team,
    clear() {
      // The run's live state and callbacks go with its trigger_run row (ON DELETE CASCADE).
      psql(`delete from automations.trigger_run where team_id = '${team}';
            delete from automations.work where team_id = '${team}';
            delete from automations.park_library_source where team_id = '${team}';`);
    },
  };
}
